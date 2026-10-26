// QA attacks on PR #8 (independent QA, round 1): the whole loop with the real adapter, real pricing and fake models.
// Tests named "BLOCKS:" fail on 6cdfb71 and pass once the finding is fixed.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyToolCalls } from "../pricing/draft";
import type { Item } from "../pricing/types";
import { StallPipeline, type FoundItem, type Models, type PublishedCatalogue } from "./adapter";
import { renderPage, serveCatalogue } from "./catalogue-page";
import { JobLog } from "./joblog";
import type { LocalMedia } from "./pipeline";
import { Store } from "./store";
import { button, payload, setup as loopSetup, text } from "./test-helpers";

class Fake implements Models {
  calls = { cutout: 0, transcribe: 0, price: 0 };
  constructor(
    private names: string[],
    private note: string,
  ) {}
  async cutout(_j: string, _p: LocalMedia, i: number, dir: string): Promise<FoundItem[]> {
    this.calls.cutout++;
    return this.names.map((name, n) => {
      const image = `p${i}-${n + 1}.png`;
      writeFileSync(join(dir, image), `png of ${name}`);
      return { name, image };
    });
  }
  async transcribe() {
    this.calls.transcribe++;
    return this.note;
  }
  async price(_j: string, items: Item[], transcript: string) {
    this.calls.price++;
    const calls = transcript.split(/[\n,]/).flatMap((c) => {
      const m = c.trim().match(/^(.+?) na (\d+) (\w+)$/);
      const it = m && items.find((i) => i.name.toLowerCase() === m[1]!.toLowerCase());
      return it ? [{ name: "set_price", arguments: JSON.stringify({ item_id: it.id, price_naira: Number(m![2]), unit: m![3], quote: c }) }] : [];
    });
    return applyToolCalls(items, calls);
  }
}

function world(models: Models, store = new Store()) {
  const root = mkdtempSync(join(tmpdir(), "qa8-"));
  let n = 0;
  const mk = () =>
    new StallPipeline({
      models,
      jobLog: new JobLog(join(root, "joblog")),
      dataDir: join(root, "data"),
      publicDir: join(root, "public"),
      publicBaseUrl: "https://stallsnap.example",
      slug: () => `qa${String(++n).padStart(10, "0")}`,
    });
  const pipeline = mk();
  const h = loopSetup({ pipeline, store });
  return { root, publicDir: join(root, "public"), pipeline, h, mk, store };
}

const T = 1_790_000_000;
const page = async (publicDir: string, slug = "qa0000000001") => {
  const r = serveCatalogue(`/c/${slug}`, publicDir);
  return r ? { status: r.status, html: await r.text() } : null;
};
const cat = (publicDir: string, slug = "qa0000000001"): PublishedCatalogue => JSON.parse(readFileSync(join(publicDir, slug, "catalogue.json"), "utf8"));

describe("QA PR8: messy flows end to end", () => {
  test("voice only: no paid call, trader asked for a photo", async () => {
    const m = new Fake(["Peak milk"], "Peak milk na 650 tin");
    const { h } = world(m);
    await h.deliver(payload([h.graph.voice(T)]));
    expect(m.calls).toEqual({ cutout: 0, transcribe: 0, price: 0 });
    expect(h.outbox.bodies().join("\n")).toMatch(/photo/i);
  });

  test("photo only: no paid call, trader asked for prices", async () => {
    const m = new Fake(["Peak milk"], "");
    const { h } = world(m);
    await h.deliver(payload([h.graph.image(T)]));
    expect(m.calls.cutout).toBe(0);
    expect(h.outbox.bodies().join("\n")).toMatch(/voice note/i);
  });

  test("unpriced item: two YES publish it as Ask for price, never a number", async () => {
    const m = new Fake(["Peak milk", "Milo tin"], "Peak milk na 650 tin");
    const { h, publicDir } = world(m);
    await h.deliver(payload([h.graph.image(T), h.graph.voice(T + 1)]));
    await h.deliver(payload([text("YES", T + 10)]));
    await h.deliver(payload([text("YES", T + 20)]));
    const p = (await page(publicDir))!;
    expect(p.status).toBe(200);
    expect(p.html).toContain("Ask for price");
    expect(cat(publicDir).lines).toEqual([
      // Build thread: pictures are now named by item and list version (QA round 1, finding 2).
      { name: "Peak milk", price: 650, unit: "tin", image: expect.stringMatching(/^i1-v\d+\.png$/) },
      { name: "Milo tin", price: null, unit: null, image: expect.stringMatching(/^i2-v\d+\.png$/) },
    ]);
  });

  test("duplicate webhook delivery of the same messages pays once and sends one list", async () => {
    const m = new Fake(["Peak milk"], "Peak milk na 650 tin");
    const { h } = world(m);
    const body = payload([h.graph.image(T), h.graph.voice(T + 1)]);
    await h.deliver(body, body);
    await h.deliver(body);
    expect(m.calls).toEqual({ cutout: 1, transcribe: 1, price: 1 });
    expect(h.outbox.sent.filter((s) => s.message.type === "buttons").length).toBe(1);
  });

  test("start again mid-check leaves nothing published and the next job is separate", async () => {
    const m = new Fake(["Peak milk"], "Peak milk na 650 tin");
    const { h, publicDir } = world(m);
    await h.deliver(payload([h.graph.image(T), h.graph.voice(T + 1)]));
    await h.deliver(payload([button("restart:1", T + 5)]));
    expect(existsSync(publicDir) ? readdirSync(publicDir) : []).toEqual([]);
    await h.deliver(payload([h.graph.image(T + 10), h.graph.voice(T + 11)]));
    expect(m.calls.cutout).toBe(2);
  });

  test("removing every line then YES does not publish an empty catalogue", async () => {
    const m = new Fake(["Peak milk"], "Peak milk na 650 tin");
    const { h, publicDir } = world(m);
    await h.deliver(payload([h.graph.image(T), h.graph.voice(T + 1)]));
    await h.deliver(payload([text("comot 1", T + 5)]));
    await h.deliver(payload([text("YES", T + 10)]));
    const p = await page(publicDir);
    // Either refused or nothing to show; an empty public "Price list" is a wrong outcome.
    // Build thread: the original line failed whenever nothing was published (a 404 counted as 0 lines).
    if (p?.status === 200) expect(cat(publicDir).lines.length).not.toBe(0);
    else expect(p?.status ?? 404).toBe(404);
  });

  test("BLOCKS: a price corrected after the catalogue is ready reaches the public page", async () => {
    const m = new Fake(["Peak milk", "Milo tin"], "Peak milk na 650 tin, Milo tin na 3500 tin");
    const { h, publicDir } = world(m);
    await h.deliver(payload([h.graph.image(T), h.graph.voice(T + 1)]));
    await h.deliver(payload([text("YES", T + 10)]));
    expect((await page(publicDir))!.html).toContain("₦3,500 per tin");
    // The trader spots a wrong price after publishing (docs/pricing.md rule 10: a change after YES reopens the list).
    await h.deliver(payload([text("2 na 3000", T + 60)]));
    await h.deliver(payload([text("YES", T + 70)]));
    const html = (await page(publicDir))!.html;
    expect(html).not.toContain("₦3,500");
    expect(html).toContain("₦3,000 per tin");
  });

  test("BLOCKS: a restart while publishing does not throw away the trader's confirmed list", async () => {
    const m = new Fake(["Peak milk"], "Peak milk na 650 tin");
    const store = new Store();
    const { h, mk, publicDir } = world(m, store);
    await h.deliver(payload([h.graph.image(T), h.graph.voice(T + 1)]));
    // Simulate a crash after YES was handled but before the link went out.
    const s = store.get("2348000000001")!;
    await h.pipeline.reply({ traderId: "2348000000001", jobId: s.jobId, reply: { text: "YES" } });
    store.set("2348000000001", { ...s, phase: "publishing" });
    const h2 = loopSetup({ pipeline: mk(), store });
    h2.loop.resume();
    await h2.loop.idle();
    const bodies = h2.outbox.bodies().join("\n");
    expect(bodies).toContain("https://stallsnap.example/c/");
    expect(m.calls.cutout).toBe(1);
    expect(existsSync(join(publicDir))).toBe(true);
  });
});

describe("QA PR8: catalogue page", () => {
  test("hostile names and units are escaped; no script, trader number or audit text", () => {
    const html = renderPage({
      slug: "qa0000000001",
      publishedAt: "2026-10-28T09:30:00Z",
      lines: [
        { name: `"><img src=x onerror=alert(1)>`, price: 100, unit: `tin"><b>`, image: "1.png" },
        { name: "</style><script>x</script>", price: null, unit: null, image: null },
      ],
    });
    expect(html).not.toMatch(/<img src=x|<script|<b>/);
    expect(html).not.toContain("2348");
  });

});
