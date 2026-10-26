// Conversation state per trader, plus the ids of messages already handled (Meta retries webhooks for up to 7 days).
// Kept in one JSON file so a restart of the server on Shola's Mac loses nothing. Fine for a handful of traders.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LocalMedia, TraderReply } from "./pipeline";

export type Phase = "idle" | "collecting" | "working" | "checking" | "publishing" | "done";

export interface Session {
  jobId: string;
  phase: Phase;
  photos: LocalMedia[];
  voiceNotes: LocalMedia[];
  texts: string[];
  /** Version of the list the trader is looking at (phase "checking"). */
  version?: number;
  /** Replies sent to the pricing step for this catalogue. */
  replies: number;
  /** Replies that arrived while the pipeline was busy, applied in order once it is free. */
  pending: TraderReply[];
  /** Each nudge or warning goes out at most once per catalogue. */
  told: string[];
  url?: string;
}

const SEEN_LIMIT = 5000;

export class Store {
  private sessions = new Map<string, Session>();
  private seen: string[] = [];
  private seenSet = new Set<string>();

  constructor(
    private readonly file?: string,
    log: (line: string) => void = console.error,
  ) {
    if (!file || !existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as { sessions: Record<string, Session>; seen: string[] };
      this.sessions = new Map(Object.entries(data.sessions ?? {}));
      this.seen = Array.isArray(data.seen) ? data.seen : [];
      this.seenSet = new Set(this.seen);
    } catch (err) {
      // A damaged file should not keep the server down; traders just start again.
      log(`store: could not read ${file}, starting empty: ${(err as Error).message}`);
    }
  }

  traders(): string[] {
    return [...this.sessions.keys()];
  }

  /** True the first time a message id is offered, false for every repeat. */
  firstTime(messageId: string): boolean {
    if (this.seenSet.has(messageId)) return false;
    this.seenSet.add(messageId);
    this.seen.push(messageId);
    if (this.seen.length > SEEN_LIMIT) this.seenSet.delete(this.seen.shift()!);
    this.save();
    return true;
  }

  get(traderId: string): Session | undefined {
    return this.sessions.get(traderId);
  }

  set(traderId: string, session: Session) {
    this.sessions.set(traderId, session);
    this.save();
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions: Object.fromEntries(this.sessions), seen: this.seen }));
    renameSync(tmp, this.file);
  }
}
