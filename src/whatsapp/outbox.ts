// Sends to one trader at most once every 6 seconds (WhatsApp's pair rate limit, error 131056).
// Rate limits (131056, 130429, 80007), Meta server errors (5xx) and network failures are retried after
// 1, 4 and 16 seconds (4^x, as about-the-platform#rate-limits advises, read 26 Oct 2026). Others are not.
import { GraphError, type Outgoing } from "./graph";

export const PAIR_GAP_MS = 6000;
const RATE_LIMITED = new Set([131056, 130429, 80007]);
const MAX_TRIES = 4;

function retryable(err: unknown): boolean {
  if (!(err instanceof GraphError)) return true; // fetch threw: network or tunnel blip
  return err.status >= 500 || (err.code !== undefined && RATE_LIMITED.has(err.code));
}

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
    // A typing indicator is not a message: no 6 s wait, no retry, and a failure only costs the "typing..." hint.
    if (message.type === "typing") {
      return this.send(to, message).catch((err) => {
        this.log(`outbox: typing indicator for ${mask(to)} failed: ${(err as Error).message}`);
        return "";
      });
    }
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      const wait = (this.lastSent.get(to) ?? -Infinity) + PAIR_GAP_MS - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait);
      try {
        const id = await this.send(to, message);
        this.lastSent.set(to, this.clock.now());
        return id;
      } catch (err) {
        this.lastSent.set(to, this.clock.now());
        if (retryable(err) && attempt < MAX_TRIES - 1) {
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
