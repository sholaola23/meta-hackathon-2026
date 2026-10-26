// Hard spend cap for every paid Meta Model API call: an off switch, a per-job call limit and a daily dollar cap.
// Wrap only live calls with guard.paid(); cached responses never reach it, so they stay free and uncounted.
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Standard-mode prices from https://dev.meta.ai/docs/pricing-rate-limits.md (read 26 Oct 2026).
export const PRICES = {
  sparkInputPerM: 1.25,
  sparkCachedInputPerM: 0.15,
  sparkOutputPerM: 4.25,
  samPerImage: 2.5 / 1000,
  imagePerImage: 0.01,
  voicePerHour: 0.18,
};

export function sparkUsd(t: { input: number; output: number; cachedInput?: number }) {
  const cachedInput = t.cachedInput ?? 0;
  for (const n of [t.input, t.output, cachedInput]) {
    if (!Number.isFinite(n) || n < 0) throw new Error(`sparkUsd needs token counts, got ${JSON.stringify(t)}`);
  }
  return (
    ((t.input - cachedInput) * PRICES.sparkInputPerM +
      cachedInput * PRICES.sparkCachedInputPerM +
      t.output * PRICES.sparkOutputPerM) /
    1_000_000
  );
}
export const samUsd = (images = 1) => images * PRICES.samPerImage;
export const imageUsd = (images = 1) => images * PRICES.imagePerImage;
export const voiceUsd = (seconds: number) => (Math.floor(seconds) / 3600) * PRICES.voicePerHour;

export type CapReason = "off" | "job-calls" | "daily-usd";

export class SpendCapError extends Error {
  constructor(
    readonly reason: CapReason,
    message: string,
  ) {
    super(message);
    this.name = "SpendCapError";
  }
}

export interface SpendConfig {
  paidCalls: boolean;
  maxCallsPerJob: number;
  dailyCapUsd: number;
  dir: string;
  now: () => Date;
}

export const DEFAULTS = { maxCallsPerJob: 60, dailyCapUsd: 2 };
/** Highest values the settings accept, so a slip such as 1e9 can't lift a cap. $25 is the billing alert level. */
export const CEILINGS = { maxCallsPerJob: 500, dailyCapUsd: 25 };
const KNOWN = ["STALLSNAP_PAID_CALLS", "STALLSNAP_MAX_CALLS_PER_JOB", "STALLSNAP_DAILY_CAP_USD", "STALLSNAP_SPEND_DIR"];

function positive(env: Record<string, string | undefined>, name: string, fallback: number, ceiling: number, integer: boolean) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!(integer ? /^\d+$/ : /^\d+(\.\d+)?$/).test(raw) || n <= 0 || n > ceiling) {
    throw new Error(`${name} must be a ${integer ? "whole number" : "number"} from above 0 to ${ceiling}, got "${raw}"`);
  }
  return n;
}

/** Read the caps from the environment. A value that can't be read stops start-up rather than lifting a cap. */
export function loadConfig(env: Record<string, string | undefined> = process.env): SpendConfig {
  const unknown = Object.keys(env).filter((k) => /^stallsnap_/i.test(k) && !KNOWN.includes(k));
  if (unknown.length) throw new Error(`Unknown setting ${unknown.join(", ")}; expected one of ${KNOWN.join(", ")}`);
  const flag = env.STALLSNAP_PAID_CALLS?.trim().toLowerCase() ?? "";
  if (!["", "on", "off"].includes(flag)) {
    throw new Error(`STALLSNAP_PAID_CALLS must be "on" or "off", got "${env.STALLSNAP_PAID_CALLS}"`);
  }
  return {
    paidCalls: flag !== "off",
    maxCallsPerJob: positive(env, "STALLSNAP_MAX_CALLS_PER_JOB", DEFAULTS.maxCallsPerJob, CEILINGS.maxCallsPerJob, true),
    dailyCapUsd: positive(env, "STALLSNAP_DAILY_CAP_USD", DEFAULTS.dailyCapUsd, CEILINGS.dailyCapUsd, false),
    dir: env.STALLSNAP_SPEND_DIR?.trim() || join(import.meta.dir, "..", ".spend"),
    now: () => new Date(),
  };
}

interface Day {
  spentUsd: number;
  calls: number;
}

const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

/**
 * Checks and books every paid call against the caps. The daily ledger is a file per UTC day, read and written
 * under a lock file, so every process on this machine shares one daily cap. The per-job call count is kept in
 * memory: one job (one trader's photo and voice note) runs in one process.
 */
export class SpendGuard {
  private jobCalls = new Map<string, number>();

  constructor(readonly config: SpendConfig = loadConfig()) {}

  /** Today's totals (UTC day). */
  today(): Day & { date: string } {
    const date = this.date();
    return { date, ...this.read(date) };
  }

  /**
   * Run one paid call if every cap allows it. The estimate is booked before the call, so a crash or a
   * failed call still counts; actualUsd, when given, corrects the booking from the response's usage.
   */
  async paid<T>(
    jobId: string,
    model: string,
    estimateUsd: number,
    call: () => Promise<T>,
    actualUsd?: (result: T) => number,
  ): Promise<T> {
    if (!(Number.isFinite(estimateUsd) && estimateUsd >= 0)) {
      throw new Error(`estimateUsd must be 0 or more, got ${estimateUsd}`);
    }
    if (!this.config.paidCalls) {
      throw new SpendCapError("off", `Paid calls are off (STALLSNAP_PAID_CALLS=off); ${model} not called`);
    }
    const used = this.jobCalls.get(jobId) ?? 0;
    if (used >= this.config.maxCallsPerJob) {
      throw new SpendCapError(
        "job-calls",
        `Job ${jobId} has used its ${this.config.maxCallsPerJob} paid calls; ${model} not called`,
      );
    }
    const date = this.date();
    this.locked(() => {
      const day = this.read(date);
      if (day.spentUsd + estimateUsd > this.config.dailyCapUsd) {
        throw new SpendCapError(
          "daily-usd",
          `Daily cap $${this.config.dailyCapUsd.toFixed(2)} reached ($${day.spentUsd.toFixed(4)} spent today, ` +
            `this call ~$${estimateUsd.toFixed(4)}); ${model} not called`,
        );
      }
      this.write(date, { spentUsd: day.spentUsd + estimateUsd, calls: day.calls + 1 });
    });
    this.jobCalls.set(jobId, used + 1);

    const result = await call();
    if (actualUsd) {
      let actual = NaN;
      try {
        actual = actualUsd(result);
      } catch {
        // Keep the estimate; the call itself worked, so its result is still returned.
      }
      if (Number.isFinite(actual) && actual >= 0) {
        this.locked(() => {
          const day = this.read(date);
          this.write(date, { spentUsd: Math.max(0, day.spentUsd + actual - estimateUsd), calls: day.calls });
        });
      }
    }
    return result;
  }

  private date() {
    return this.config.now().toISOString().slice(0, 10);
  }

  private file(date: string) {
    return join(this.config.dir, `${date}.json`);
  }

  private read(date: string): Day {
    const file = this.file(date);
    if (!existsSync(file)) return { spentUsd: 0, calls: 0 };
    const day = JSON.parse(readFileSync(file, "utf8")) as Day;
    if (!Number.isFinite(day.spentUsd) || !Number.isFinite(day.calls)) {
      throw new Error(`Spend ledger ${file} is unreadable; fix or delete it before making paid calls`);
    }
    return day;
  }

  /** Write to a temp file and rename it over the ledger, so a reader never sees half a file. */
  private write(date: string, day: Day) {
    const file = this.file(date);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(day));
    renameSync(tmp, file);
  }

  /** Run fn while holding the ledger lock. A lock older than LOCK_STALE_MS is from a crashed process. */
  private locked<T>(fn: () => T): T {
    mkdirSync(this.config.dir, { recursive: true });
    const lock = join(this.config.dir, "ledger.lock");
    const giveUp = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        closeSync(openSync(lock, "wx"));
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
        } catch {
          // The holder released it in the meantime.
        }
        if (Date.now() > giveUp) throw new Error(`Spend ledger lock ${lock} is held; no paid call made`);
        Bun.sleepSync(2);
      }
    }
    try {
      return fn();
    } finally {
      unlinkSync(lock);
    }
  }
}

if (import.meta.main) {
  const guard = new SpendGuard();
  const { date, spentUsd, calls } = guard.today();
  const c = guard.config;
  console.log(
    `${date} (UTC): $${spentUsd.toFixed(4)} of $${c.dailyCapUsd.toFixed(2)} spent in ${calls} paid calls. ` +
      `Paid calls ${c.paidCalls ? "on" : "OFF"}; ${c.maxCallsPerJob} calls per job.`,
  );
}
