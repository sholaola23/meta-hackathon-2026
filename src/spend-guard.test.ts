import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, SpendCapError, SpendGuard, loadConfig, samUsd, sparkUsd, voiceUsd, type SpendConfig } from "./spend-guard";

const DAY1 = new Date("2026-10-27T12:00:00Z");

function guard(over: Partial<SpendConfig> = {}, dir = mkdtempSync(join(tmpdir(), "spend-"))) {
  return new SpendGuard({ paidCalls: true, maxCallsPerJob: 3, dailyCapUsd: 0.1, dir, now: () => DAY1, ...over });
}

/** A fake paid call that records whether it actually ran. */
function fakeCall() {
  const calls = { n: 0 };
  return { calls, run: async () => ++calls.n };
}

async function capReason(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof SpendCapError) return e.reason;
    throw e;
  }
  return "not stopped";
}

describe("off switch", () => {
  test("STALLSNAP_PAID_CALLS=off stops every call before it runs", async () => {
    const g = guard({ paidCalls: false });
    const f = fakeCall();
    expect(await capReason(g.paid("job", "sam-3.1", 0, f.run))).toBe("off");
    expect(f.calls.n).toBe(0);
    expect(g.today().calls).toBe(0);
  });

  test("off, OFF and padded values all switch off; unset means on", () => {
    expect(loadConfig({ STALLSNAP_PAID_CALLS: "off" }).paidCalls).toBe(false);
    expect(loadConfig({ STALLSNAP_PAID_CALLS: " OFF " }).paidCalls).toBe(false);
    expect(loadConfig({ STALLSNAP_PAID_CALLS: "on" }).paidCalls).toBe(true);
    expect(loadConfig({}).paidCalls).toBe(true);
  });

  test("a typo in the flag stops start-up instead of leaving calls on", () => {
    for (const v of ["of", "0", "false", "no", "0ff"]) {
      expect(() => loadConfig({ STALLSNAP_PAID_CALLS: v })).toThrow("STALLSNAP_PAID_CALLS");
    }
  });
});

describe("per-job call limit", () => {
  test("call N+1 in a job is refused and never runs; other jobs are unaffected", async () => {
    const g = guard({ maxCallsPerJob: 3 });
    const f = fakeCall();
    for (let i = 0; i < 3; i++) await g.paid("job-a", "muse-spark-1.3", 0.001, f.run);
    expect(await capReason(g.paid("job-a", "muse-spark-1.3", 0.001, f.run))).toBe("job-calls");
    expect(f.calls.n).toBe(3);
    await g.paid("job-b", "muse-spark-1.3", 0.001, f.run);
    expect(f.calls.n).toBe(4);
  });

  test("a failed call still uses up its slot and its estimate", async () => {
    const g = guard({ maxCallsPerJob: 1 });
    const boom = async () => {
      throw new Error("500 from API");
    };
    await expect(g.paid("job", "sam-3.1", 0.0025, boom)).rejects.toThrow("500 from API");
    expect(g.today()).toMatchObject({ calls: 1, spentUsd: 0.0025 });
    expect(await capReason(g.paid("job", "sam-3.1", 0.0025, fakeCall().run))).toBe("job-calls");
  });
});

describe("daily dollar cap", () => {
  test("a call that would go over the cap is refused and never runs", async () => {
    const g = guard({ dailyCapUsd: 0.01, maxCallsPerJob: 100 });
    const f = fakeCall();
    for (let i = 0; i < 4; i++) await g.paid("job", "sam-3.1", samUsd(), f.run); // 4 x $0.0025 = $0.01
    expect(await capReason(g.paid("job2", "sam-3.1", samUsd(), f.run))).toBe("daily-usd");
    expect(f.calls.n).toBe(4);
  });

  test("the cap is shared across processes through the ledger on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-"));
    await guard({ dailyCapUsd: 0.05 }, dir).paid("job", "muse-image-1.0", 0.04, fakeCall().run);
    const f = fakeCall();
    expect(await capReason(guard({ dailyCapUsd: 0.05 }, dir).paid("job", "muse-image-1.0", 0.02, f.run))).toBe(
      "daily-usd",
    );
    expect(f.calls.n).toBe(0);
  });

  test("a new UTC day starts from zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-"));
    await guard({ dailyCapUsd: 0.05 }, dir).paid("job", "muse-image-1.0", 0.05, fakeCall().run);
    const next = guard({ dailyCapUsd: 0.05, now: () => new Date("2026-10-28T00:00:01Z") }, dir);
    const f = fakeCall();
    await next.paid("job", "muse-image-1.0", 0.05, f.run);
    expect(f.calls.n).toBe(1);
  });

  test("the booking is corrected to the real cost from the response", async () => {
    const g = guard({ dailyCapUsd: 1 });
    await g.paid("job", "muse-spark-1.3", 0.05, async () => ({ input: 10_000, output: 1_000 }), sparkUsd);
    expect(g.today().spentUsd).toBeCloseTo(0.01675, 9) // 10k in x $1.25/M + 1k out x $4.25/M;
  });

  test("a missing or negative estimate is refused, so nothing slips past the cap", async () => {
    const g = guard();
    for (const bad of [NaN, -1, undefined as unknown as number]) {
      await expect(g.paid("job", "sam-3.1", bad, fakeCall().run)).rejects.toThrow("estimateUsd");
    }
    expect(g.today().calls).toBe(0);
  });
});

describe("config from the environment", () => {
  test("defaults apply when nothing is set", () => {
    const c = loadConfig({});
    expect(c.maxCallsPerJob).toBe(DEFAULTS.maxCallsPerJob);
    expect(c.dailyCapUsd).toBe(DEFAULTS.dailyCapUsd);
  });

  test("messy values stop start-up rather than lifting a cap", () => {
    for (const v of ["abc", "-1", "0", "Infinity", "1e999", "N/A", "1O"]) {
      expect(() => loadConfig({ STALLSNAP_DAILY_CAP_USD: v })).toThrow("STALLSNAP_DAILY_CAP_USD");
    }
    for (const v of ["2.5", "-3", "ten", "0"]) {
      expect(() => loadConfig({ STALLSNAP_MAX_CALLS_PER_JOB: v })).toThrow("STALLSNAP_MAX_CALLS_PER_JOB");
    }
  });

  test("valid values are read", () => {
    const c = loadConfig({ STALLSNAP_DAILY_CAP_USD: " 0.5 ", STALLSNAP_MAX_CALLS_PER_JOB: "10" });
    expect(c.dailyCapUsd).toBe(0.5);
    expect(c.maxCallsPerJob).toBe(10);
  });
});

describe("price helpers", () => {
  test("match Meta's published prices", () => {
    expect(samUsd(1000)).toBeCloseTo(2.5, 9);
    expect(voiceUsd(3600.9)).toBeCloseTo(0.18, 9);
    expect(sparkUsd({ input: 1_000_000, output: 0, cachedInput: 1_000_000 })).toBeCloseTo(0.15, 9);
  });
});
