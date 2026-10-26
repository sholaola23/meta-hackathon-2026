// The edges of the loop: webhook verify and signature, payload parsing against Meta's own examples,
// the Graph client's two-step download and sends, the 6-second pacing, and every message text.
import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copy, LIMITS, parseButtonId, splitText } from "./copy";
import { parseWebhook } from "./events";
import { Graph, GraphError, type Outgoing } from "./graph";
import { acceptedExtension, fetchMedia, MediaRejected } from "./media";
import { mask, Outbox, PAIR_GAP_MS, type Clock } from "./outbox";
import { anonymise, makeHandler, validSignature } from "./webhook";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8"));
const DOC_PHONE_ID = "106540352242922";

describe("webhook HTTP", () => {
  const config = { verifyToken: "verify-me", appSecret: "app-secret", phoneNumberId: DOC_PHONE_ID };
  const sign = (body: string, secret = config.appSecret) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const got: unknown[][] = [];
  const handler = makeHandler(config, (events) => got.push(events));

  test("GET verify returns the raw challenge for the right token", async () => {
    const res = await handler(new Request("http://x/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1158201444");
  });

  test("GET verify with the wrong token or mode is refused", async () => {
    expect((await handler(new Request("http://x/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1"))).status).toBe(403);
    expect((await handler(new Request("http://x/webhook?hub.mode=other&hub.verify_token=verify-me&hub.challenge=1"))).status).toBe(403);
  });

  test("POST with a good signature is accepted and parsed", async () => {
    const body = JSON.stringify(fixture("meta-doc-image.json"));
    const res = await handler(new Request("http://x/webhook", { method: "POST", body, headers: { "x-hub-signature-256": sign(body) } }));
    expect(res.status).toBe(200);
    expect(got.at(-1)).toHaveLength(1);
  });

  test("POST with no, wrong or malformed signature is refused and not parsed", async () => {
    const body = JSON.stringify(fixture("meta-doc-image.json"));
    const before = got.length;
    for (const header of [undefined, sign(body, "other-secret"), "sha256=zz", "sha1=abc", sign(body + " ")]) {
      const headers: Record<string, string> = header ? { "x-hub-signature-256": header } : {};
      const res = await handler(new Request("http://x/webhook", { method: "POST", body, headers }));
      expect(res.status).toBe(401);
    }
    expect(got.length).toBe(before);
  });

  test("signature is checked on the raw body, including escaped non-ASCII", () => {
    const raw = '{"text":"Ọjà \\u00e9"}';
    expect(validSignature(raw, sign(raw), config.appSecret)).toBe(true);
    expect(validSignature(JSON.stringify(JSON.parse(raw)), sign(raw), config.appSecret)).toBe(false);
  });

  test("signed but broken JSON is a 400; other paths are 404", async () => {
    const body = "{not json";
    expect((await handler(new Request("http://x/webhook", { method: "POST", body, headers: { "x-hub-signature-256": sign(body) } }))).status).toBe(400);
    expect((await handler(new Request("http://x/other"))).status).toBe(404);
  });
});

describe("parsing Meta's documented payloads", () => {
  test("image", () => {
    const [e] = parseWebhook(fixture("meta-doc-image.json"), DOC_PHONE_ID);
    expect(e).toMatchObject({ kind: "image", from: "16505551234", media: { mediaId: "1003383421387256", mimeType: "image/jpeg" } });
  });
  test("voice note", () => {
    const [e] = parseWebhook(fixture("meta-doc-audio.json"), DOC_PHONE_ID);
    expect(e).toMatchObject({ kind: "audio", isVoiceNote: true, media: { mimeType: "audio/ogg; codecs=opus" } });
  });
  test("button reply keeps the id and the message it replies to", () => {
    const [e] = parseWebhook(fixture("meta-doc-button-reply.json"), DOC_PHONE_ID);
    expect(e).toMatchObject({ kind: "button", buttonId: "change-button" });
    expect(e!.replyTo).toStartWith("wamid.");
  });
  test("unsupported message type", () => {
    const [e] = parseWebhook(fixture("meta-doc-unsupported.json"), DOC_PHONE_ID);
    expect(e).toMatchObject({ kind: "other", type: "unsupported", errorCode: 131051 });
  });
  test("junk bodies give no events and never throw", () => {
    for (const junk of [null, 42, "x", {}, { object: "page" }, { object: "whatsapp_business_account", entry: "x" },
      { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: DOC_PHONE_ID }, messages: [{ id: "a" }, null, 5] } }] }] }]) {
      expect(parseWebhook(junk, DOC_PHONE_ID)).toEqual([]);
    }
  });
  test("whitespace-only text is ignored, not answered", () => {
    const body = fixture("meta-doc-image.json");
    body.entry[0].changes[0].value.messages = [{ from: "1", id: "a", timestamp: "1", type: "text", text: { body: "   " } }];
    expect(parseWebhook(body, DOC_PHONE_ID)).toMatchObject([{ kind: "ignored" }]);
  });
});

describe("Graph client", () => {
  function fakeFetch(routes: Record<string, () => Response>) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const key = Object.keys(routes).find((k) => url.startsWith(k));
      return key ? routes[key]!() : new Response("{}", { status: 404 });
    };
    return { calls, fetch };
  }
  const config = { token: "TOKEN", phoneNumberId: "PNID", version: "v26.0" };

  test("two-step download sends the bearer token on both requests and checks the hash", async () => {
    const bytes = new TextEncoder().encode("ogg bytes");
    const sha = createHash("sha256").update(bytes).digest("base64");
    const { calls, fetch } = fakeFetch({
      "https://graph.facebook.com/v26.0/MEDIA1": () => Response.json({ url: "https://lookaside.fbsbx.com/m1", mime_type: "audio/ogg; codecs=opus", file_size: String(bytes.length) }),
      "https://lookaside.fbsbx.com/m1": () => new Response(bytes),
    });
    const file = await fetchMedia(new Graph(config, fetch), "audio", { mediaId: "MEDIA1", mimeType: "audio/ogg; codecs=opus", sha256: sha }, {
      messageId: "wamid.1", sentAt: 1, dir: mkdtempSync(join(tmpdir(), "wa-media-")), isVoiceNote: true,
    });
    expect(calls).toHaveLength(2);
    for (const c of calls) expect((c.init!.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
    expect(calls[0]!.url).toContain("phone_number_id=PNID");
    expect(file.path).toEndWith(".ogg");
    expect(readFileSync(file.path)).toEqual(Buffer.from(bytes));
  });

  test("download that turns out bigger than the limit is stopped", async () => {
    const { fetch } = fakeFetch({ "https://cdn/x": () => new Response(new Uint8Array(100), { headers: { "content-length": "100" } }) });
    expect(new Graph(config, fetch).download("https://cdn/x", 50)).rejects.toMatchObject({ status: 413 });
  });

  test("text send uses the documented body", async () => {
    const { calls, fetch } = fakeFetch({ "https://graph.facebook.com/v26.0/PNID/messages": () => Response.json({ messages: [{ id: "wamid.SENT" }] }) });
    const id = await new Graph(config, fetch).send("2348000000001", { type: "text", body: "hi" });
    expect(id).toBe("wamid.SENT");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      messaging_product: "whatsapp", recipient_type: "individual", to: "2348000000001", type: "text", text: { preview_url: true, body: "hi" },
    });
  });

  test("button send uses the documented interactive body", async () => {
    const { calls, fetch } = fakeFetch({ "https://graph.facebook.com/v26.0/PNID/messages": () => Response.json({ messages: [{ id: "w" }] }) });
    await new Graph(config, fetch).send("1", { type: "buttons", body: "Is this right?", buttons: [{ id: "yes:1", title: "Yes, publish" }] });
    expect(JSON.parse(calls[0]!.init!.body as string).interactive).toEqual({
      type: "button", body: { text: "Is this right?" }, action: { buttons: [{ type: "reply", reply: { id: "yes:1", title: "Yes, publish" } }] },
    });
  });

  test("API error carries Meta's error code", async () => {
    const { fetch } = fakeFetch({ "https://graph.facebook.com": () => Response.json({ error: { code: 131056, message: "pair rate limit" } }, { status: 400 }) });
    expect(new Graph(config, fetch).send("1", { type: "text", body: "x" })).rejects.toMatchObject({ code: 131056 });
  });

  test("accepted types", () => {
    expect(acceptedExtension("audio", "audio/ogg; codecs=opus")).toBe("ogg");
    expect(acceptedExtension("audio", "audio/ogg")).toBeUndefined();
    expect(acceptedExtension("audio", "audio/wav")).toBeUndefined();
    expect(acceptedExtension("image", "image/png")).toBe("png");
    expect(acceptedExtension("image", "image/heic")).toBeUndefined();
    expect(new MediaRejected("too-big", "x").problem).toBe("too-big");
  });
});

describe("outbox pacing (1 message per 6 s per trader)", () => {
  function fakeClock() {
    let t = 0;
    const clock: Clock = { now: () => t, sleep: async (ms) => void (t += ms) };
    return clock;
  }

  test("messages to one trader are at least 6 s apart and keep their order", async () => {
    const clock = fakeClock();
    const at: { to: string; t: number; body: string }[] = [];
    const box = new Outbox(async (to, m) => (at.push({ to, t: clock.now(), body: m.body }), "id"), clock);
    await Promise.all(["a", "b", "c"].map((b) => box.enqueue("1", { type: "text", body: b })));
    expect(at.map((x) => x.body)).toEqual(["a", "b", "c"]);
    expect(at[1]!.t - at[0]!.t).toBeGreaterThanOrEqual(PAIR_GAP_MS);
    expect(at[2]!.t - at[1]!.t).toBeGreaterThanOrEqual(PAIR_GAP_MS);
  });

  test("131056 is retried with back-off; other errors are logged, not retried", async () => {
    const clock = fakeClock();
    let tries = 0;
    const logs: string[] = [];
    const box = new Outbox(async () => {
      tries++;
      if (tries < 3) throw new GraphError(400, 131056, "pair rate limit");
      return "ok";
    }, clock, (l) => logs.push(l));
    expect(await box.enqueue("2348000000001", { type: "text", body: "x" })).toBe("ok");
    expect(tries).toBe(3);

    const failing = new Outbox(async () => {
      throw new GraphError(400, 131047, "re-engagement");
    }, clock, (l) => logs.push(l));
    expect(await failing.enqueue("2348000000001", { type: "text", body: "x" })).toBe("");
    expect(logs.at(-1)).toContain("***0001");
    expect(logs.join(" ")).not.toContain("2348000000001");
  });

  test("mask never shows a full number", () => {
    expect(mask("2348000000001")).toBe("***0001");
    expect(mask("12")).toBe("***");
  });
});

describe("every message the trader can receive", () => {
  const fixed = Object.entries(copy).filter(([, v]) => typeof v === "object") as [string, Outgoing][];
  const all: [string, Outgoing][] = [
    ...fixed,
    ...copy.priceList("1. Peak milk: N600 per tin", 3).map((m, i) => [`priceList ${i}`, m] as [string, Outgoing]),
    ["catalogueReady", copy.catalogueReady("https://stallsnap.example/c/abc")],
  ];

  test.each(all)("%s: within WhatsApp limits, no em or en dashes, no US spellings", (_name, m) => {
    expect(m.body.length).toBeGreaterThan(0);
    expect(m.body.length).toBeLessThanOrEqual(m.type === "buttons" ? LIMITS.buttonBody : LIMITS.textBody);
    expect(m.body).not.toMatch(/[\u2013\u2014]/);
    expect(m.body).not.toMatch(/\b(color|catalog|center|favorite|organize)\b/i);
    if (m.type === "buttons") {
      expect(m.buttons.length).toBeLessThanOrEqual(3);
      expect(new Set(m.buttons.map((b) => b.title)).size).toBe(m.buttons.length);
      for (const b of m.buttons) expect(b.title.length).toBeLessThanOrEqual(LIMITS.buttonTitle);
      for (const b of m.buttons) expect(parseButtonId(b.id)).toBeDefined();
    }
  });

  test("the catalogue message has exactly one link", () => {
    expect(copy.catalogueReady("https://stallsnap.example/c/abc").body.match(/https?:\/\//g)).toHaveLength(1);
  });

  test("a very long list is split under 4096 characters and still ends with the buttons", () => {
    const list = Array.from({ length: 300 }, (_, i) => `${i + 1}. Item number ${i + 1}: N${(i + 1) * 100} per piece`).join("\n");
    const msgs = copy.priceList(list, 7);
    expect(msgs.length).toBeGreaterThan(2);
    for (const m of msgs) expect(m.body.length).toBeLessThanOrEqual(LIMITS.textBody);
    expect(msgs.at(-1)!.type).toBe("buttons");
    expect(msgs.slice(0, -1).map((m) => m.body).join("\n")).toBe(list);
  });

  test("a single line longer than 4096 characters is cut into pieces, nothing lost", () => {
    const line = "x".repeat(9000);
    const parts = splitText(line);
    expect(parts.map((p) => p.body).join("")).toBe(line);
    for (const p of parts) expect(p.body.length).toBeLessThanOrEqual(LIMITS.textBody);
  });
});

describe("recorded payloads are safe to commit", () => {
  test("anonymise replaces numbers, names and media URLs but keeps message text", () => {
    const out = JSON.stringify(anonymise(fixture("meta-doc-image.json")));
    expect(out).not.toContain("16505551234");
    expect(out).not.toContain("Sheena");
    expect(out).not.toContain("mid=133");
    expect(out).toContain("Taj Mahal");
    const again = parseWebhook(anonymise(fixture("meta-doc-image.json")), DOC_PHONE_ID);
    expect(again).toHaveLength(1);
  });
});
