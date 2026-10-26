// Sends to one trader at most once every 6 seconds (WhatsApp's pair rate limit, error 131056).
// On 131056 it retries after 4^x seconds, as the docs advise (about-the-platform#rate-limits, read 26 Oct 2026).
import { GraphError, type Outgoing } from "./graph";

export const PAIR_GAP_MS = 6000;
const PAIR_RATE_LIMITED = 131056;
const MAX_TRIES = 3;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export type SendFn = (to: string, message: Outgoing) => Promise<string>;

export class Outbox {
  private lastSent = new Map<string, number>();
  private queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly send: SendFn,
    private readonly clock: Clock = realClock,
    private readonly log: (line: string) => void = console.error,
  ) {}

  /** Queue a message; resolves with its WhatsApp id, or "" if it could not be sent. Order per trader is kept. */
  enqueue(to: string, message: Outgoing): Promise<string> {
    const prev = this.queues.get(to) ?? Promise.resolve();
    const next = prev.then(() => this.deliver(to, message));
    this.queues.set(to, next.catch(() => undefined));
    return next;
  }

  private async deliver(to: string, message: Outgoing): Promise<string> {
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      const wait = (this.lastSent.get(to) ?? -Infinity) + PAIR_GAP_MS - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait);
      try {
        const id = await this.send(to, message);
        this.lastSent.set(to, this.clock.now());
        return id;
      } catch (err) {
        this.lastSent.set(to, this.clock.now());
        if (err instanceof GraphError && err.code === PAIR_RATE_LIMITED && attempt < MAX_TRIES - 1) {
          await this.clock.sleep(4 ** attempt * 1000);
          continue;
        }
        this.log(`outbox: could not send to ${mask(to)}: ${(err as Error).message}`);
        return "";
      }
    }
    return "";
  }
}

/** Phone numbers never go into logs in full. */
export function mask(phone: string): string {
  return phone.length > 4 ? `***${phone.slice(-4)}` : "***";
}
