// HTTP side of the webhook: the GET verify handshake, the X-Hub-Signature-256 check on every POST,
// and an optional recorder that saves anonymised payloads to build test fixtures from real traffic.
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseWebhook, type InboundEvent } from "./events";

export interface WebhookConfig {
  verifyToken: string;
  appSecret: string;
  phoneNumberId: string;
  /** When set, every signed POST body is saved here with phone numbers, names and media URLs replaced. */
  recordDir?: string;
}

/** Meta signs the raw body with the app secret. Re-serialised JSON would not match, so this takes the raw text. */
export function validSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  const [algo, sig] = (header ?? "").split("=");
  if (algo !== "sha256" || !sig || !/^[0-9a-f]{64}$/i.test(sig)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  return timingSafeEqual(Buffer.from(sig, "hex"), expected);
}

/** Replace anything that identifies a person, so a recorded payload can be committed as a fixture. */
export function anonymise(body: unknown): unknown {
  const phones = new Map<string, string>();
  const fake = (p: string) => {
    if (!phones.has(p)) phones.set(p, `2340000000${String(phones.size + 1).padStart(3, "0")}`);
    return phones.get(p)!;
  };
  const walk = (v: unknown, key = ""): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    if (typeof v !== "string") return v;
    if (["from", "wa_id", "recipient_id", "display_phone_number"].includes(key)) return fake(v);
    if (key === "name") return "Trader";
    if (key === "url") return "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=REDACTED";
    if (key === "body" || key === "caption") return v; // message text is kept: it is what the tests need
    return v;
  };
  return walk(body);
}

export function makeHandler(config: WebhookConfig, onEvents: (events: InboundEvent[]) => void) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") return new Response("Not found", { status: 404 });

    if (req.method === "GET") {
      const q = url.searchParams;
      if (q.get("hub.mode") === "subscribe" && q.get("hub.verify_token") === config.verifyToken) {
        return new Response(q.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return new Response("Forbidden", { status: 403 });
    }

    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const raw = await req.text();
    if (!validSignature(raw, req.headers.get("x-hub-signature-256"), config.appSecret)) {
      return new Response("Bad signature", { status: 401 });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }
    if (config.recordDir) {
      mkdirSync(config.recordDir, { recursive: true });
      writeFileSync(join(config.recordDir, `${Date.now()}.json`), JSON.stringify(anonymise(body), null, 2));
    }
    // Answer at once: Meta retries if we are slow, and the pipeline takes a minute.
    onEvents(parseWebhook(body, config.phoneNumberId));
    return new Response("OK", { status: 200 });
  };
}
