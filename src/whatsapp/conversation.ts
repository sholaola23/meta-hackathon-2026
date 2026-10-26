// The WhatsApp loop for one trader at a time:
//   photo(s) + voice note(s) -> "working" -> priced list with buttons -> corrections -> "Yes, publish" -> one catalogue link.
// Events for one trader run strictly one after another; slow pipeline calls run outside that queue and
// come back into it when done, so replies sent meanwhile are queued, not lost.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { copy, LIMITS, parseButtonId } from "./copy";
import type { InboundEvent } from "./events";
import type { Graph, Outgoing } from "./graph";
import { fetchMedia, MediaRejected } from "./media";
import { mask, type Outbox } from "./outbox";
import { isSpendCapError, photoErrorMessage, type Pipeline, type PricingTurn, type TraderReply } from "./pipeline";
import type { Session, Store } from "./store";

/** Photo and voice note arrive as separate webhooks, often seconds apart. Wait this long after the last one. */
export const SETTLE_MS = 5000;

export interface Scheduler {
  /** Run fn after ms; returns a cancel function. */
  after(ms: number, fn: () => void): () => void;
}

export const realScheduler: Scheduler = {
  after(ms, fn) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

export interface LoopDeps {
  graph: Pick<Graph, "mediaInfo" | "download">;
  outbox: Pick<Outbox, "enqueue">;
  pipeline: Pipeline;
  store: Store;
  mediaDir: string;
  /** Numbers (digits only, as WhatsApp sends them) allowed to use the service. Empty means nobody. */
  allowed: Set<string>;
  scheduler?: Scheduler;
  log?: (line: string) => void;
}

const freshSession = (): Session => ({
  jobId: randomUUID(),
  phase: "idle",
  photos: [],
  voiceNotes: [],
  texts: [],
  replies: 0,
  pending: [],
  told: [],
});

const hasDigit = (s: string) => /\d/.test(s);

export class Conversation {
  private queues = new Map<string, Promise<void>>();
  private timers = new Map<string, () => void>();
  /** Pipeline calls running per trader. */
  private inFlight = new Map<string, number>();
  /** Latest message id from each trader, for the typing indicator. */
  private lastInbound = new Map<string, string>();
  private readonly scheduler: Scheduler;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: LoopDeps) {
    this.scheduler = deps.scheduler ?? realScheduler;
    this.log = deps.log ?? console.error;
  }

  /** Accept events from one webhook. Returns once they are handled (tests await this; the server does not). */
  handle(events: InboundEvent[]): Promise<void> {
    const work = events
      .filter((e) => this.deps.allowed.has(e.from))
      .filter((e) => this.deps.store.firstTime(e.messageId))
      .map((e) => this.run(e.from, () => this.onEvent(e)));
    return Promise.all(work).then(() => undefined);
  }

  /**
   * Call once at start-up. Timers and running jobs do not survive a restart: collecting sessions wait
   * again and then start, and traders whose job was running are told it was lost.
   */
  resume() {
    for (const trader of this.deps.store.traders()) {
      const s = this.deps.store.get(trader)!;
      if (s.phase === "collecting") this.settle(trader);
      else if (s.phase === "working" || s.phase === "publishing") {
        void this.run(trader, async () => {
          this.save(trader, freshSession());
          this.send(trader, copy.failed);
        });
      }
    }
  }

  /** Resolves when every queued step for every trader has finished. For tests. */
  async idle(): Promise<void> {
    for (;;) {
      const all = [...this.queues.values()];
      await Promise.all(all);
      if ([...this.queues.values()].every((q, i) => q === all[i]) && [...this.inFlight.values()].every((n) => n === 0)) return;
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  private run(trader: string, step: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(trader) ?? Promise.resolve()).then(step).catch((err) => {
      this.log(`loop: step failed for ${mask(trader)}: ${(err as Error).stack ?? err}`);
    });
    this.queues.set(trader, next);
    return next;
  }

  private track(trader: string, delta: number) {
    this.inFlight.set(trader, (this.inFlight.get(trader) ?? 0) + delta);
  }

  private session(trader: string): Session {
    let s = this.deps.store.get(trader);
    // After a restart, a job that was running is gone: start clean rather than wait for it forever.
    if (s && (s.phase === "working" || s.phase === "publishing") && !this.inFlight.get(trader)) s = undefined;
    return s ?? freshSession();
  }

  private save(trader: string, s: Session) {
    this.deps.store.set(trader, s);
  }

  private send(trader: string, ...messages: Outgoing[]) {
    for (const m of messages) void this.deps.outbox.enqueue(trader, m);
  }

  /** Send a nudge only once per catalogue. */
  private tellOnce(trader: string, s: Session, key: string, message: Outgoing) {
    if (s.told.includes(key)) return;
    s.told.push(key);
    this.send(trader, message);
  }

  private async onEvent(e: InboundEvent) {
    const trader = e.from;
    this.lastInbound.set(trader, e.messageId);
    let s = this.session(trader);
    if (s.phase === "done" && (e.kind === "image" || e.kind === "audio")) s = freshSession();

    switch (e.kind) {
      case "ignored":
        return;
      case "other":
        // 131052: WhatsApp refused the media for being over 100 MB.
        this.send(trader, e.errorCode === 131052 ? copy.fileTooBig : copy.unsupported);
        return;
      case "button":
        return this.onButton(trader, s, e.buttonId);
      case "text":
        return this.onText(trader, s, e.text);
      case "image":
      case "audio":
        return this.onMedia(trader, s, e);
    }
  }

  private async onMedia(trader: string, s: Session, e: Extract<InboundEvent, { kind: "image" | "audio" }>) {
    // While publishing nothing more can change the list, and a photo never joins a list already made.
    if (s.phase === "publishing" || (e.kind === "image" && (s.phase === "working" || s.phase === "checking"))) {
      if (s.phase === "checking") this.tellOnce(trader, s, "photo-while-checking", copy.photoWhileChecking);
      else this.tellOnce(trader, s, "still-working", copy.stillWorking);
      this.save(trader, s);
      return;
    }
    const list = e.kind === "image" ? s.photos : s.voiceNotes;
    const limit = e.kind === "image" ? LIMITS.photos : LIMITS.voiceNotes;
    if ((s.phase === "idle" || s.phase === "collecting") && list.length >= limit) {
      this.tellOnce(trader, s, `too-many-${e.kind}`, e.kind === "image" ? copy.tooManyPhotos : copy.tooManyVoiceNotes);
      this.save(trader, s);
      return;
    }

    let file;
    try {
      file = await fetchMedia(this.deps.graph as Graph, e.kind, e.media, {
        messageId: e.messageId,
        sentAt: e.sentAt,
        dir: join(this.deps.mediaDir, s.jobId),
        isVoiceNote: e.kind === "audio" ? e.isVoiceNote : undefined,
      });
    } catch (err) {
      if (!(err instanceof MediaRejected)) throw err;
      this.log(`loop: ${e.kind} from ${mask(trader)} rejected: ${err.message}`);
      const message =
        err.problem === "too-big"
          ? e.kind === "image" ? copy.imageTooBig : copy.audioTooBig
          : err.problem === "unsupported"
            ? e.kind === "image" ? copy.unsupportedImage : copy.unsupportedAudio
            : copy.downloadFailed;
      this.send(trader, message);
      return;
    }

    if (e.kind === "audio" && (s.phase === "checking" || s.phase === "working")) {
      return this.onReply(trader, s, { voiceNote: file });
    }
    list.push(file as never);
    list.sort((a, b) => a.sentAt - b.sentAt);
    if (e.kind === "image" && e.caption) s.texts.push(e.caption);
    s.phase = "collecting";
    this.save(trader, s);
    this.settle(trader);
  }

  private async onText(trader: string, s: Session, text: string) {
    switch (s.phase) {
      case "checking":
      case "working":
        return this.onReply(trader, s, { text });
      case "publishing":
        this.tellOnce(trader, s, "still-working", copy.stillWorking);
        this.save(trader, s);
        return;
      case "done":
        this.send(trader, copy.doneHelp);
        return;
      case "collecting":
        s.texts.push(text);
        this.save(trader, s);
        this.settle(trader);
        return;
      case "idle":
        this.send(trader, copy.welcome);
        return;
    }
  }

  private async onButton(trader: string, s: Session, buttonId: string) {
    const b = parseButtonId(buttonId);
    if (s.phase === "working" || s.phase === "publishing") {
      this.tellOnce(trader, s, "still-working", copy.stillWorking);
      this.save(trader, s);
      return;
    }
    if (!b || s.phase !== "checking" || b.version !== s.version) {
      this.send(trader, copy.staleButton);
      return;
    }
    if (b.action === "change") return this.send(trader, copy.changePrompt);
    if (b.action === "restart") {
      this.save(trader, freshSession());
      return this.send(trader, copy.startedAgain);
    }
    return this.onReply(trader, s, { text: "YES" });
  }

  /** Wait SETTLE_MS after the latest photo, voice note or text before deciding what to do. */
  private settle(trader: string) {
    this.timers.get(trader)?.();
    this.timers.set(
      trader,
      this.scheduler.after(SETTLE_MS, () => {
        this.timers.delete(trader);
        void this.run(trader, () => this.afterSettle(trader));
      }),
    );
  }

  private async afterSettle(trader: string) {
    const s = this.session(trader);
    if (s.phase !== "collecting") return;
    const hasPrices = s.voiceNotes.length > 0 || s.texts.some(hasDigit);
    if (s.photos.length > 0 && hasPrices) return this.start(trader, s);
    if (s.photos.length > 0) this.tellOnce(trader, s, "need-voice", copy.gotPhotoNeedVoice);
    else if (s.voiceNotes.length > 0) this.tellOnce(trader, s, "need-photo", copy.gotVoiceNeedPhoto);
    else this.tellOnce(trader, s, "welcome", copy.welcome);
    this.save(trader, s);
  }

  private start(trader: string, s: Session) {
    s.phase = "working";
    this.save(trader, s);
    this.send(trader, copy.working);
    this.typing(trader);
    this.background(trader, s, () =>
      this.deps.pipeline.start({ traderId: trader, jobId: s.jobId, photos: s.photos, voiceNotes: s.voiceNotes, texts: s.texts }),
    );
  }

  private onReply(trader: string, s: Session, reply: TraderReply) {
    if (s.phase === "working") {
      s.pending.push(reply);
      this.save(trader, s);
      return;
    }
    const isYes = "text" in reply && reply.text === "YES";
    if (!isYes && s.replies >= LIMITS.repliesPerList) {
      this.tellOnce(trader, s, "too-many-replies", copy.tooManyReplies);
      this.save(trader, s);
      return;
    }
    s.replies++;
    s.phase = "working";
    this.save(trader, s);
    this.typing(trader);
    this.background(trader, s, () => this.deps.pipeline.reply({ traderId: trader, jobId: s.jobId, reply }));
  }

  /** Show "typing..." while the models work. Queued behind any message so the message does not dismiss it. */
  private typing(trader: string) {
    const messageId = this.lastInbound.get(trader);
    if (messageId) this.send(trader, { type: "typing", body: "", messageId });
  }

  /** Run a slow pipeline call outside the trader's queue, then handle its result inside it. */
  private background(trader: string, s: Session, call: () => Promise<PricingTurn>) {
    const jobId = s.jobId;
    this.track(trader, +1);
    call().then(
      (turn) => this.run(trader, () => this.afterTurn(trader, jobId, turn)).finally(() => this.track(trader, -1)),
      (err) => this.run(trader, async () => this.fail(trader, jobId, err)).finally(() => this.track(trader, -1)),
    );
  }

  private async afterTurn(trader: string, jobId: string, turn: PricingTurn) {
    const s = this.deps.store.get(trader);
    if (!s || s.jobId !== jobId) return; // the trader started again meanwhile
    s.version = turn.version;
    s.phase = "checking";
    const next = s.pending.shift();
    // A reply sent after Yes but before the answer wins over the Yes: never publish a list the trader has corrected.
    if (turn.confirmed && !next) return this.publish(trader, s);
    this.save(trader, s);
    // A reply that arrived while we were working is about the old list: apply it before showing a list.
    if (next) return this.onReply(trader, s, next);
    this.send(trader, ...copy.priceList(turn.message, turn.version, turn.headerImageUrl));
  }

  private async publish(trader: string, s: Session) {
    s.phase = "publishing";
    this.save(trader, s);
    this.track(trader, +1);
    const jobId = s.jobId;
    this.deps.pipeline.publish({ traderId: trader, jobId }).then(
      ({ url }) =>
        this.run(trader, async () => {
          const cur = this.deps.store.get(trader);
          if (!cur || cur.jobId !== jobId) return;
          cur.phase = "done";
          cur.url = url;
          this.save(trader, cur);
          this.send(trader, copy.catalogueReady(url));
        }).finally(() => this.track(trader, -1)),
      (err) => this.run(trader, async () => this.fail(trader, jobId, err)).finally(() => this.track(trader, -1)),
    );
  }

  private fail(trader: string, jobId: string, err: unknown) {
    const s = this.deps.store.get(trader);
    if (!s || s.jobId !== jobId) return;
    this.log(`loop: pipeline failed for ${mask(trader)}: ${(err as Error).message}`);
    this.save(trader, freshSession());
    const photoProblem = photoErrorMessage(err);
    this.send(trader, photoProblem ? { type: "text", body: photoProblem } : isSpendCapError(err) ? copy.paused : copy.failed);
  }
}
