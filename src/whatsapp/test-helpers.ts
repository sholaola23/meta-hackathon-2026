// Fakes for the WhatsApp loop tests: payload builders, a fake Graph, a recording outbox, a pricing-like
// pipeline and a manual scheduler. No network, no model calls, no money.
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation, type Scheduler } from "./conversation";
import { GraphError, type MediaInfo, type Outgoing } from "./graph";
import type { Pipeline, PricingTurn, StartInput, TraderReply } from "./pipeline";
import { Store } from "./store";

export const PHONE_ID = "106540352242922";
export const TRADER = "2348000000001";

let seq = 0;
export const nextId = () => `wamid.TEST${++seq}`;

/** One webhook POST body carrying the given messages. */
export function payload(messages: object[], phoneNumberId = PHONE_ID) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "102290129340398",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550783881", phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "Test Trader" }, wa_id: TRADER }],
              messages,
            },
          },
        ],
      },
    ],
  };
}

const b64 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("base64");

export interface FakeFile {
  bytes: Uint8Array;
  mime: string;
  /** Override the size Graph reports, to test the size check without big buffers. */
  reportedBytes?: number;
}

export function msg(type: string, body: object, at: number, from = TRADER, extra: object = {}) {
  return { from, id: nextId(), timestamp: String(at), type, [type]: body, ...extra };
}

export class FakeGraph {
  files = new Map<string, FakeFile>();
  infoCalls: string[] = [];
  downloads: string[] = [];
  /** Media ids whose first download returns 404 (expired URL). */
  expireOnce = new Set<string>();

  add(mediaId: string, file: FakeFile) {
    this.files.set(mediaId, file);
  }

  image(at: number, opts: { caption?: string; mime?: string; bytes?: number; badHash?: boolean; asDocument?: boolean } = {}) {
    const mediaId = `img-${nextId()}`;
    const bytes = new TextEncoder().encode(`photo ${mediaId}`);
    const mime = opts.mime ?? "image/jpeg";
    this.add(mediaId, { bytes, mime, reportedBytes: opts.bytes });
    const body = { id: mediaId, mime_type: mime, sha256: opts.badHash ? b64(new Uint8Array([1])) : b64(bytes), ...(opts.caption ? { caption: opts.caption } : {}) };
    return msg(opts.asDocument ? "document" : "image", body, at);
  }

  voice(at: number, opts: { mime?: string; bytes?: number; voice?: boolean; asDocument?: boolean } = {}) {
    const mediaId = `aud-${nextId()}`;
    const bytes = new TextEncoder().encode(`voice ${mediaId}`);
    const mime = opts.mime ?? "audio/ogg; codecs=opus";
    this.add(mediaId, { bytes, mime, reportedBytes: opts.bytes });
    return msg(opts.asDocument ? "document" : "audio", { id: mediaId, mime_type: mime, sha256: b64(bytes), voice: opts.voice ?? true }, at);
  }

  async mediaInfo(mediaId: string): Promise<MediaInfo> {
    this.infoCalls.push(mediaId);
    const f = this.files.get(mediaId);
    if (!f) throw new GraphError(404, 100, "no such media");
    return { url: `https://lookaside.test/${mediaId}?n=${this.infoCalls.length}`, mimeType: f.mime, bytes: f.reportedBytes ?? f.bytes.byteLength };
  }

  async download(url: string, maxBytes: number): Promise<Uint8Array> {
    const mediaId = new URL(url).pathname.slice(1);
    this.downloads.push(mediaId);
    if (this.expireOnce.delete(mediaId)) throw new GraphError(404, undefined, "url expired");
    const f = this.files.get(mediaId)!;
    if (f.bytes.byteLength > maxBytes) throw new GraphError(413, undefined, "too big");
    return f.bytes;
  }
}

export class RecordingOutbox {
  sent: { to: string; message: Outgoing }[] = [];
  async enqueue(to: string, message: Outgoing) {
    this.sent.push({ to, message });
    return `wamid.OUT${this.sent.length}`;
  }
  /** Bodies sent to the trader, in order. */
  bodies(to = TRADER) {
    return this.sent.filter((s) => s.to === to).map((s) => s.message.body);
  }
}

/**
 * Behaves like the pricing module: "YES" confirms, but the first YES while something is unpriced only warns.
 * Any other reply is a change and raises the version.
 */
export class FakePipeline implements Pipeline {
  starts: StartInput[] = [];
  replies: TraderReply[] = [];
  publishes = 0;
  version = 0;
  unpriced = false;
  warned = false;
  fail?: Error;
  /** When set, start() waits for this before answering, so tests can send messages mid-job. */
  gate?: Promise<void>;

  private turn(confirmed = false, message?: string): PricingTurn {
    return { version: this.version, confirmed, message: message ?? `1. Peak milk: N600 per tin\n2. Indomie: N250 per pack (list v${this.version})` };
  }

  async start(input: StartInput) {
    this.starts.push(input);
    if (this.gate) await this.gate;
    if (this.fail) throw this.fail;
    this.version = 1;
    return this.turn();
  }

  async reply(input: { reply: TraderReply }) {
    this.replies.push(input.reply);
    if (this.fail) throw this.fail;
    if ("text" in input.reply && input.reply.text === "YES") {
      if (this.unpriced && !this.warned) {
        this.warned = true;
        return this.turn(false, "Milo has no price yet. Reply YES again to show it as Ask for price.");
      }
      return this.turn(true);
    }
    this.version++;
    return this.turn();
  }

  async publish() {
    this.publishes++;
    if (this.fail) throw this.fail;
    return { url: "https://stallsnap.example/c/test-stall" };
  }
}

export class ManualScheduler implements Scheduler {
  private jobs: { fn: () => void; cancelled: boolean }[] = [];
  after(_ms: number, fn: () => void) {
    const job = { fn, cancelled: false };
    this.jobs.push(job);
    return () => {
      job.cancelled = true;
    };
  }
  /** Fire every timer that is due (we treat all as due). */
  flush() {
    const jobs = this.jobs;
    this.jobs = [];
    for (const j of jobs) if (!j.cancelled) j.fn();
  }
}

export function setup(opts: { allowed?: string[]; store?: Store } = {}) {
  const graph = new FakeGraph();
  const outbox = new RecordingOutbox();
  const pipeline = new FakePipeline();
  const scheduler = new ManualScheduler();
  const store = opts.store ?? new Store();
  const logs: string[] = [];
  const loop = new Conversation({
    graph,
    outbox,
    pipeline,
    store,
    mediaDir: mkdtempSync(join(tmpdir(), "stallsnap-wa-")),
    allowed: new Set(opts.allowed ?? [TRADER]),
    scheduler,
    log: (l) => logs.push(l),
  });
  /** Deliver webhook bodies, let the settle timer fire, and wait for everything to finish. */
  const deliver = async (...bodies: object[]) => {
    const { parseWebhook } = await import("./events");
    for (const b of bodies) await loop.handle(parseWebhook(b, PHONE_ID));
    await loop.idle();
    scheduler.flush();
    await loop.idle();
  };
  /** Deliver and fire timers, without waiting for pipeline calls (for tests that hold the pipeline open). */
  const deliverNoWait = async (...bodies: object[]) => {
    const { parseWebhook } = await import("./events");
    for (const b of bodies) await loop.handle(parseWebhook(b, PHONE_ID));
    scheduler.flush();
    await new Promise((r) => setTimeout(r, 5));
  };
  return { graph, outbox, pipeline, scheduler, store, loop, logs, deliver, deliverNoWait };
}

export const button = (id: string, at: number, replyTo = "wamid.OUT2") =>
  msg("interactive", { type: "button_reply", button_reply: { id, title: "x" } }, at, TRADER, { context: { from: "15550783881", id: replyTo } });
export const text = (body: string, at: number) => msg("text", { body }, at);
