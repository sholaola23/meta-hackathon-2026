// QA round 3 attacks on PR #5 (CTA link, header image, typing indicator). Real Outbox and Graph over a fake fetch,
// so whatever layer the fallback lives in, the test sees what Meta would actually be asked to send.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copy, LIMITS } from "./copy";
import { Conversation } from "./conversation";
import { parseWebhook } from "./events";
import { Graph } from "./graph";
import { Outbox, type Clock } from "./outbox";
import { Store } from "./store";
import { button, FakeGraph, FakePipeline, ManualScheduler, payload, PHONE_ID, TRADER } from "./test-helpers";

const T = 1_790_000_000;
const URL_OK = "https://stallsnap.example/c/test-stall";

type Sent = { interactiveType?: string; type: string; text: string; header?: unknown };

/** A Meta that refuses some message shapes with a non-retryable 400, and records what it accepted. */
function harness(refuse: (p: Record<string, any>) => boolean) {
  const accepted: Sent[] = [];
  const fetch = async (_url: string, init?: RequestInit) => {
    const p = JSON.parse(String(init?.body ?? "{}"));
    if (p.status === "read") return Response.json({ success: true });
    if (refuse(p)) return Response.json({ error: { code: 131009, message: "(#131009) Parameter value is not valid" } }, { status: 400 });
    accepted.push({
      type: p.type,
      interactiveType: p.interactive?.type,
      text: p.text?.body ?? p.interactive?.body?.text ?? "",
      header: p.interactive?.header,
    });
    return Response.json({ messages: [{ id: `wamid.OUT${accepted.length}` }] });
  };
  let t = 0;
  const clock: Clock = { now: () => t, sleep: async (ms) => void (t += ms) };
  const graph = new Graph({ token: "EAAGtest123456", phoneNumberId: PHONE_ID, version: "v26.0" }, fetch);
  const outbox = new Outbox((to, m) => graph.send(to, m), clock, () => {});
  const media = new FakeGraph();
  const pipeline = new FakePipeline();
  const scheduler = new ManualScheduler();
  const loop = new Conversation({
    graph: media,
    outbox,
    pipeline,
    store: new Store(),
    mediaDir: mkdtempSync(join(tmpdir(), "stallsnap-qa3-")),
    allowed: new Set([TRADER]),
    scheduler,
    log: () => {},
  });
  const deliver = async (...bodies: object[]) => {
    for (const b of bodies) await loop.handle(parseWebhook(b, PHONE_ID));
    await loop.idle();
    scheduler.flush();
    await loop.idle();
    await new Promise((r) => setTimeout(r, 20)); // let the outbox drain (fake clock, no real waits)
  };
  return { accepted, media, pipeline, deliver };
}

describe("QA r3: the one message that matters must arrive", () => {
  test("A11 Meta refuses the CTA button: the trader still gets the catalogue link as text", async () => {
    const h = harness((p) => p.interactive?.type === "cta_url");
    await h.deliver(payload([h.media.image(T), h.media.voice(T + 1)]));
    await h.deliver(payload([button("yes:1", T + 30, "wamid.OUT2")]));
    expect(h.pipeline.publishes).toBe(1);
    expect(h.accepted.some((m) => m.text.includes(URL_OK))).toBe(true);
  });

  test("A12 Meta cannot fetch the header image: the trader still gets the price list with buttons", async () => {
    const h = harness((p) => p.interactive?.header !== undefined);
    const real = h.pipeline.start.bind(h.pipeline);
    h.pipeline.start = async (i) => ({ ...(await real(i)), headerImageUrl: "http://localhost:3000/cutouts/a.jpg" });
    await h.deliver(payload([h.media.image(T), h.media.voice(T + 1)]));
    const list = h.accepted.find((m) => m.interactiveType === "button");
    expect(list).toBeDefined();
    expect(list!.text).toContain("Peak milk");
  });

  test("A13 a very long catalogue URL never pushes the link message over Meta's limits", () => {
    const longUrl = `https://stallsnap.example/c/${"x".repeat(1100)}`;
    const m = copy.catalogueReady(longUrl);
    const limit = m.type === "link" ? LIMITS.buttonBody : LIMITS.textBody;
    expect(m.body.length).toBeLessThanOrEqual(limit);
    expect(m.body).toContain(longUrl);
  });
});
