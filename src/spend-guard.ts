// Hard spend cap for every paid Meta Model API call: an off switch, a per-job call limit and a daily dollar cap.
// Wrap only live calls with guard.paid(); cached responses never reach it, so they stay free and uncounted.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export const sparkUsd = (t: { input: number; output: number; cachedInput?: number }) =>
  ((t.input - (t.cachedInput ?? 0)) * PRICES.sparkInputPerM +
    (t.cachedInput ?? 0) * PRICES.sparkCachedInputPerM +
    t.output * PRICES.sparkOutputPerM) /
  1_000_000;
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

function positive(env: Record<string, string | undefined>, name: string, fallback: number, integer: boolean) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new Error(`${name} must be a ${integer ? "whole" : ""} number above 0, got "${raw}"`);
  }
  return n;
}

/** Read the caps from the environment. A value that can't be read stops start-up rather than lifting a cap. */
export function loadConfig(env: Record<string, string | undefined> = process.env): SpendConfig {
  const flag = env.STALLSNAP_PAID_CALLS?.trim().toLowerCase() ?? "";
  if (!["", "on", "off"].includes(flag)) {
    throw new Error(`STALLSNAP_PAID_CALLS must be "on" or "off", got "${env.STALLSNAP_PAID_CALLS}"`);
  }
  return {
    paidCalls: flag !== "off",
    maxCallsPerJob: positive(env, "STALLSNAP_MAX_CALLS_PER_JOB", DEFAULTS.maxCallsPerJob, true),
    dailyCapUsd: positive(env, "STALLSNAP_DAILY_CAP_USD", DEFAULTS.dailyCapUsd, false),
    dir: env.STALLSNAP_SPEND_DIR?.trim() || join(import.meta.dir, "..", ".spend"),
    now: () => new Date(),
  };
}

interface Day {
  spentUsd: number;
  calls: number;
}

export class SpendGuard {
  private jobCalls = new Map<string, number>();

  constructor(readonly config: SpendConfig = loadConfig()) {}

  /** Today's totals (UTC day), read from disk so every process on this machine shares one daily cap. */
  today(): Day & { date: string } {
    const date = this.config.now().toISOString().slice(0, 10);
    const file = this.file(date);
    const day: Day = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { spentUsd: 0, calls: 0 };
    return { date, ...day };
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
    if (!(estimateUsd >= 0)) throw new Error(`estimateUsd must be 0 or more, got ${estimateUsd}`);
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
    const day = this.today();
    if (day.spentUsd + estimateUsd > this.config.dailyCapUsd) {
      throw new SpendCapError(
        "daily-usd",
        `Daily cap $${this.config.dailyCapUsd.toFixed(2)} reached ($${day.spentUsd.toFixed(4)} spent today, ` +
          `this call ~$${estimateUsd.toFixed(4)}); ${model} not called`,
      );
    }

    this.jobCalls.set(jobId, used + 1);
    this.book(day.date, estimateUsd, 1);
    const result = await call();
    if (actualUsd) this.book(day.date, actualUsd(result) - estimateUsd, 0);
    return result;
  }

  private file(date: string) {
    return join(this.config.dir, `${date}.json`);
  }

  private book(date: string, usd: number, calls: number) {
    const file = this.file(date);
    const day: Day = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { spentUsd: 0, calls: 0 };
    day.spentUsd = Math.max(0, day.spentUsd + usd);
    day.calls += calls;
    mkdirSync(this.config.dir, { recursive: true });
    writeFileSync(file, JSON.stringify(day));
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
