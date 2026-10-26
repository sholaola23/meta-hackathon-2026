// QA attacks on PR #5 (independent QA, 26 Oct 2026). Each test states the outcome the trader should get.
// A failing test here is a finding; once fixed, it stays in CI so the fault cannot come back.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copy } from "./copy";
import { parseWebhook } from "./events";
import { Graph, GraphError } from "./graph";
import { Outbox, type Clock } from "./outbox";
import { Store } from "./store";
import { button, msg, payload, PHONE_ID, setup, text, TRADER } from "./test-helpers";

const T = 1_790_000_000;
const LINK = copy.catalogueReady("https://stallsnap.example/c/test-stall").body;

function fakeClock() {
  let t = 0;
  const clock: Clock = { now: () => t, sleep: async (ms) => void (t += ms) };
  return clock;
}

/** Hold the next pipeline.reply() open until the returned function is called. */
function gateReply(ctx: ReturnType<typeof setup>) {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const real = ctx.pipeline.reply.bind(ctx.pipeline);
  let once = true;
  ctx.pipeline.reply = async (input) => {
    if (once) {
      once = false;
      ctx.pipeline.replies.push(input.reply);
      await gate;
      ctx.pipeline.replies.pop();
    }
    return real(input);
  };
  return open;
}

describe("QA: replies that arrive while the loop is busy", () => {
  test("A1 voice note while publishing: no second job, no price list after the link", async () => {
    const ctx = setup();
    await ctx.deliver(payload([ctx.graph.image(T), ctx.graph.voice(T + 1)]));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const realPublish = ctx.pipeline.publish.bind(ctx.pipeline);
    ctx.pipeline.publish = async () => (await gate, realPublish());
    await ctx.deliverNoWait(payload([button("yes:1", T + 30)]));
    await ctx.deliverNoWait(payload([ctx.graph.voice(T + 35)]));
    open();
    await ctx.loop.idle();
    ctx.scheduler.flush();
    await ctx.loop.idle();
    expect(ctx.pipeline.starts).toHaveLength(1);
    expect(ctx.outbox.bodies().at(-1)).toBe(LINK);
    expect(ctx.outbox.sent.filter((s) => s.message.type === "buttons")).toHaveLength(1);
  });

  test("A2 Yes, then a typed correction before the answer: the correction is not silently dropped", async () => {
    const ctx = setup();
    await ctx.deliver(payload([ctx.graph.image(T), ctx.graph.voice(T + 1)]));
    const open = gateReply(ctx);
    await ctx.deliverNoWait(payload([button("yes:1", T + 30)]));
    await ctx.deliverNoWait(payload([text("Peak milk na 650", T + 32)]));
    open();
    await ctx.loop.idle();
    const correctionSeen = ctx.pipeline.replies.some((r) => "text" in r && r.text === "Peak milk na 650");
    // Either the correction reaches pricing before anything publishes, or the trader is clearly told it was not used.
    if (ctx.pipeline.publishes > 0) expect(correctionSeen).toBe(true);
    else expect(ctx.outbox.bodies().at(-1)).not.toBe(LINK);
  });

  test("A3 a message the loop drops is never answered with 'I will use this message'", async () => {
    const ctx = setup();
    let open!: () => void;
    ctx.pipeline.gate = new Promise((r) => (open = r));
    await ctx.deliverNoWait(payload([ctx.graph.image(T), ctx.graph.voice(T + 1)]));
    await ctx.deliverNoWait(payload([ctx.graph.image(T + 10)])); // a second photo while working
    await ctx.deliverNoWait(payload([button("yes:0", T + 11)])); // a stale tap while working
    open();
    await ctx.loop.idle();
    expect(ctx.pipeline.starts[0]!.photos).toHaveLength(1);
    // The photo and the tap were dropped, so no reply may promise to use them.
    for (const body of ctx.outbox.bodies()) expect(body).not.toContain("I will use this message");
  });
});

describe("QA: server restarts", () => {
  test("A4 restart while collecting (photo and voice in, settle timer lost): the job still starts", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "stallsnap-qa-")), "state.json");
    const first = setup({ store: new Store(file) });
    const { parseWebhook: parse } = await import("./events");
    await first.loop.handle(parse(payload([first.graph.image(T), first.graph.voice(T + 1)]), PHONE_ID));
    await first.loop.idle(); // timer never fires: the server stops here
    expect(new Store(file).get(TRADER)!.phase).toBe("collecting");

    const second = setup({ store: new Store(file) });
    second.graph.files = first.graph.files;
    // The builder needs a resume step on start-up; this test calls whatever the server calls.
    const resume = (second.loop as unknown as { resume?: () => void }).resume;
    expect(typeof resume).toBe("function");
    resume!.call(second.loop);
    second.scheduler.flush();
    await second.loop.idle();
    expect(second.pipeline.starts).toHaveLength(1);
  });

  test("A5 restart while working: the trader is told the job was lost, not left waiting", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "stallsnap-qa-")), "state.json");
    const first = setup({ store: new Store(file) });
    first.pipeline.gate = new Promise(() => {});
    await first.deliverNoWait(payload([first.graph.image(T), first.graph.voice(T + 1)]));
    expect(new Store(file).get(TRADER)!.phase).toBe("working");

    const second = setup({ store: new Store(file) });
    const resume = (second.loop as unknown as { resume?: () => void }).resume;
    expect(typeof resume).toBe("function");
    resume!.call(second.loop);
    await second.loop.idle();
    expect(second.outbox.bodies()).toEqual([copy.failed.body]);
  });

  test("A6 a corrupt state file does not stop the server starting", () => {
    const file = join(mkdtempSync(join(tmpdir(), "stallsnap-qa-")), "state.json");
    writeFileSync(file, '{"sessions": {"x": '); // half-written, e.g. disk full
    expect(() => new Store(file)).not.toThrow();
  });
});

describe("QA: sending", () => {
  test("A7 a transient Graph error (HTTP 500) on the catalogue link is retried", async () => {
    let tries = 0;
    const box = new Outbox(async () => {
      if (++tries === 1) throw new GraphError(500, 2, "Service temporarily unavailable");
      return "ok";
    }, fakeClock(), () => {});
    expect(await box.enqueue(TRADER, { type: "text", body: LINK })).toBe("ok");
  });

  test("A8 a network failure (fetch throws) is retried", async () => {
    let tries = 0;
    const box = new Outbox(async () => {
      if (++tries === 1) throw new TypeError("fetch failed");
      return "ok";
    }, fakeClock(), () => {});
    expect(await box.enqueue(TRADER, { type: "text", body: LINK })).toBe("ok");
  });

  test("A9 docs promise retries after 1, 4 and 16 s on 131056: three rate-limit errors then success is delivered", async () => {
    let tries = 0;
    const clock = fakeClock();
    const box = new Outbox(async () => {
      if (++tries <= 3) throw new GraphError(400, 131056, "pair rate limit");
      return "ok";
    }, clock, () => {});
    expect(await box.enqueue(TRADER, { type: "text", body: "x" })).toBe("ok");
    expect(tries).toBe(4);
  });

  test("A10 the token never appears in a Graph error message", async () => {
    const token = "EAAG-SECRET-TOKEN-123";
    const fetch = async (url: string) =>
      Response.json({ error: { code: 190, message: `Invalid OAuth access token - Cannot parse access token ${token}` } }, { status: 401 });
    const g = new Graph({ token, phoneNumberId: PHONE_ID, version: "v26.0" }, fetch);
    const err = await g.send(TRADER, { type: "text", body: "x" }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(token);
  });
});

describe("QA: malformed payloads never throw", () => {
  const bad: [string, unknown][] = [
    ["null", null],
    ["string", "hello"],
    ["entry not array", { object: "whatsapp_business_account", entry: { changes: [] } }],
    ["messages null", payload(null as unknown as object[])],
    ["message is a number", payload([42 as unknown as object])],
    ["timestamp text", payload([{ from: TRADER, id: "wamid.x", timestamp: "soon", type: "text", text: { body: "hi" } }])],
    ["image without id", payload([msg("image", { mime_type: "image/jpeg" }, T)])],
    ["text body is a number", payload([msg("text", { body: 5 }, T)])],
    ["button_reply missing", payload([msg("interactive", { type: "list_reply", list_reply: { id: "x" } }, T)])],
  ];
  test.each(bad)("%s", (_n, body) => {
    expect(() => parseWebhook(body, PHONE_ID)).not.toThrow();
  });

  test("odd messages each get at most one reply and never reach the pipeline", async () => {
    const ctx = setup();
    await ctx.deliver(...bad.map(([, b]) => b as object));
    expect(ctx.pipeline.starts).toHaveLength(0);
    expect(ctx.outbox.sent.length).toBeLessThanOrEqual(bad.length);
  });
});
