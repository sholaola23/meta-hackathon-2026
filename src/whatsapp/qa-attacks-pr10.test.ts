// QA attacks on PR #10 (round 1, head cf54592): restarts during a reply, with the real adapter and fake models.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyToolCalls } from "../pricing/draft";
import type { Item } from "../pricing/types";
import { StallPipeline, type FoundItem, type Models } from "./adapter";
import { serveCatalogue } from "./catalogue-page";
import { JobLog } from "./joblog";
import type { LocalMedia } from "./pipeline";
import { Store } from "./store";
import { button, payload, setup as loopSetup, text } from "./test-helpers";

const TRADER = "2348000000001";
const T = 1_790_000_000;

class Fake implements Models {
  calls = { cutout: 0, transcribe: 0, price: 0 };
  async cutout(_j: string, _p: LocalMedia, i: number, dir: string): Promise<FoundItem[]> {
    this.calls.cutout++;
    return ["Peak milk", "Milo tin"].map((name, n) => {
      writeFileSync(join(dir, `p${i}-${n + 1}.png`), name);
      return { name, image: `p${i}-${n + 1}.png` };
    });
  }
  async transcribe() {
    this.calls.transcribe++;
    return "Peak milk na 650 tin, Milo tin na 3500 tin";
  }
  async price(_j: string, items: Item[], transcript: string) {
    this.calls.price++;
    const calls = transcript.split(",").flatMap((c) => {
      const m = c.trim().match(/^(.+?) na (\d+) (\w+)$/);
      const it = m && items.find((i) => i.name === m[1]);
      return it ? [{ name: "set_price", arguments: JSON.stringify({ item_id: it.id, price_naira: Number(m![2]), unit: m![3], quote: c }) }] : [];
    });
    return applyToolCalls(items, calls);
  }
}

function world() {
  const root = mkdtempSync(join(tmpdir(), "qa10-"));
  const m = new Fake();
  const store = new Store();
  const mk = () =>
    new StallPipeline({ models: m, jobLog: new JobLog(join(root, "joblog")), dataDir: join(root, "data"), publicDir: join(root, "public"), publicBaseUrl: "https://s.example", slug: () => "qa0000000001" });
  const h = loopSetup({ pipeline: mk(), store });
  const restart = async () => {
    const h2 = loopSetup({ pipeline: mk(), store });
    h2.loop.resume();
    await h2.loop.idle();
    return h2;
  };
  const html = async () => (await serveCatalogue("/c/qa0000000001", join(root, "public"))?.text()) ?? "";
  return { m, store, h, restart, html };
}

/** The crash: the loop accepted the trader's message (and marked its wamid seen) but pricing never got it. */
async function crashBeforePricing(w: ReturnType<typeof world>, body: string, at: number) {
  const realReply = w.h.pipeline.reply.bind(w.h.pipeline);
  (w.h.pipeline as any).reply = () => new Promise(() => {}); // never answers: the process dies here
  await w.h.deliverNoWait(payload([text(body, at)]));
  (w.h.pipeline as any).reply = realReply;
  expect(w.store.get(TRADER)!.phase).toBe("working");
}

describe("QA PR10: restarts during a reply", () => {
  test("BLOCKS: a correction after publishing that was lost in a crash is not answered with 'your catalogue is ready'", async () => {
    const w = world();
    await w.h.deliver(payload([w.h.graph.image(T), w.h.graph.voice(T + 1)]));
    await w.h.deliver(payload([text("YES", T + 10)]));
    await crashBeforePricing(w, "2 na 3000", T + 60);
    const h2 = await w.restart();
    const said = h2.outbox.bodies().join("\n");
    // Either the correction is applied after the restart, or the trader is told it was lost and asked to resend.
    const applied = said.includes("₦3,000");
    const toldLost = /again/i.test(said) && !/catalogue is ready/i.test(said);
    expect(applied || toldLost).toBe(true);
  });

  test("BLOCKS: a correction before YES that was lost in a crash is not silently dropped", async () => {
    const w = world();
    await w.h.deliver(payload([w.h.graph.image(T), w.h.graph.voice(T + 1)]));
    await crashBeforePricing(w, "2 na 3000", T + 30);
    const h2 = await w.restart();
    const said = h2.outbox.bodies().join("\n");
    expect(said.includes("₦3,000") || /send .*again|lost|didn't get|no get/i.test(said)).toBe(true);
  });

  test("repeated restarts during a correction after publishing: one list each time, no paid calls, page never shows a disowned price", async () => {
    const w = world();
    await w.h.deliver(payload([w.h.graph.image(T), w.h.graph.voice(T + 1)]));
    await w.h.deliver(payload([text("YES", T + 10)]));
    const s = w.store.get(TRADER)!;
    await w.h.pipeline.reply({ traderId: TRADER, jobId: s.jobId, reply: { text: "2 na 3000" } });
    w.store.set(TRADER, { ...s, phase: "working" });
    for (let i = 0; i < 3; i++) {
      w.store.set(TRADER, { ...w.store.get(TRADER)!, phase: "working" });
      const h2 = await w.restart();
      expect(h2.outbox.sent.filter((x) => x.message.type === "buttons").length).toBe(1);
      expect(await w.html()).not.toContain("₦3,500");
    }
    expect(w.m.calls).toEqual({ cutout: 1, transcribe: 1, price: 1 });
  });

  test("a stale button from the list before the restart is refused; the re-sent list's yes publishes", async () => {
    const w = world();
    await w.h.deliver(payload([w.h.graph.image(T), w.h.graph.voice(T + 1)]));
    await w.h.deliver(payload([text("YES", T + 10)]));
    const s = w.store.get(TRADER)!;
    await w.h.pipeline.reply({ traderId: TRADER, jobId: s.jobId, reply: { text: "2 na 3000" } });
    w.store.set(TRADER, { ...s, phase: "working" });
    const h2 = await w.restart();
    await h2.deliver(payload([button(`yes:${s.version}`, T + 100)]));
    expect(h2.outbox.bodies().at(-1)).not.toContain("/c/qa0000000001");
    const list = h2.outbox.sent.find((x) => x.message.type === "buttons")!;
    await h2.deliver(payload([button((list.message as any).buttons[0].id, T + 110)]));
    expect(h2.outbox.bodies().at(-1)).toContain("/c/qa0000000001");
    expect(await w.html()).toContain("₦3,000 per tin");
  });

  test("a message that arrives while the restarted loop is fetching the list is applied, not lost", async () => {
    const w = world();
    await w.h.deliver(payload([w.h.graph.image(T), w.h.graph.voice(T + 1)]));
    const s = w.store.get(TRADER)!;
    w.store.set(TRADER, { ...s, phase: "working" });
    const h2 = loopSetup({ pipeline: (w.h.pipeline as any), store: w.store });
    h2.loop.resume();
    await h2.deliver(payload([text("1 na 700", T + 50)]));
    expect(h2.outbox.bodies().join("\n")).toContain("₦700");
  });
});

// Round 2 (head e005a14), from QA unchanged.
describe("QA PR10 round 2", () => {
  test("a replayed correction is applied once even if the server restarts again mid-replay", async () => {
    const w = world();
    await w.h.deliver(payload([w.h.graph.image(T), w.h.graph.voice(T + 1)]));
    await w.h.deliver(payload([text("YES", T + 10)]));
    await crashBeforePricing(w, "2 na 3000", T + 60);
    const v = w.store.get(TRADER)!.version!;
    // Second crash: the replay reached pricing (applied) but the loop never saw the answer.
    const s = w.store.get(TRADER)!;
    await w.h.pipeline.reply({ traderId: TRADER, jobId: s.jobId, reply: s.inFlight! });
    const h2 = await w.restart();
    const lists = h2.outbox.sent.filter((x) => x.message.type === "buttons");
    expect(lists.length).toBe(1);
    expect((lists[0]!.message as any).body).toContain("₦3,000");
    expect(w.store.get(TRADER)!.version).toBe(v + 1);
    expect(w.store.get(TRADER)!.inFlight).toBeUndefined();
  });
});
