// Acceptance tests for the job step log, written before the implementation (see docs/muse-code/joblog-task.md).
// Muse Code writes joblog.ts against these; they are not to be edited by the run.
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobLog } from "./joblog";

const fresh = () => mkdtempSync(join(tmpdir(), "stallsnap-joblog-"));

/** A paid step that counts how often it really ran. */
function paid<T>(value: T) {
  const calls = { n: 0 };
  const run = async () => {
    calls.n++;
    return value;
  };
  return { run, calls };
}

describe("job log: never pay twice", () => {
  test("a finished step is not run again", async () => {
    const log = new JobLog(fresh());
    const s = paid({ text: "Indomie na 250" });
    expect(await log.step("job1", "transcript:wamid.A", s.run)).toEqual({ text: "Indomie na 250" });
    expect(await log.step("job1", "transcript:wamid.A", s.run)).toEqual({ text: "Indomie na 250" });
    expect(s.calls.n).toBe(1);
  });

  test("after a crash a new log on the same folder resumes from the last finished step", async () => {
    const dir = fresh();
    const cut = paid({ masks: 3 });
    await new JobLog(dir).step("job1", "cutout:wamid.A", cut.run);
    const again = new JobLog(dir);
    expect(again.has("job1", "cutout:wamid.A")).toBe(true);
    expect(again.has("job1", "transcript:wamid.B")).toBe(false);
    expect(await again.step("job1", "cutout:wamid.A", cut.run)).toEqual({ masks: 3 });
    expect(cut.calls.n).toBe(1);
  });

  test("a failed step is not recorded, so the next try runs it", async () => {
    const log = new JobLog(fresh());
    await expect(
      log.step("job1", "pricing:1", async () => {
        throw new Error("spend cap");
      }),
    ).rejects.toThrow("spend cap");
    expect(log.has("job1", "pricing:1")).toBe(false);
    const s = paid("ok");
    expect(await log.step("job1", "pricing:1", s.run)).toBe("ok");
    expect(s.calls.n).toBe(1);
  });

  test("a webhook retry that overlaps the first delivery runs the step once", async () => {
    const log = new JobLog(fresh());
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = async () => {
      calls++;
      await gate;
      return { text: "Peak milk na 650" };
    };
    const a = log.step("job1", "transcript:wamid.A", run);
    const b = log.step("job1", "transcript:wamid.A", run);
    release();
    expect(await a).toEqual({ text: "Peak milk na 650" });
    expect(await b).toEqual({ text: "Peak milk na 650" });
    expect(calls).toBe(1);
  });

  test("jobs and keys are kept apart, and keys come back in the order they finished", async () => {
    const log = new JobLog(fresh());
    await log.step("job1", "cutout:wamid.A", async () => 1);
    await log.step("job1", "transcript:wamid.B", async () => 2);
    await log.step("job2", "cutout:wamid.A", async () => 3);
    expect(log.keys("job1")).toEqual(["cutout:wamid.A", "transcript:wamid.B"]);
    expect(log.keys("job2")).toEqual(["cutout:wamid.A"]);
    expect(log.keys("job3")).toEqual([]);
  });

  test("clear forgets the job, so Start again pays again", async () => {
    const dir = fresh();
    const log = new JobLog(dir);
    await log.step("job1", "cutout:wamid.A", async () => 1);
    log.clear("job1");
    expect(log.has("job1", "cutout:wamid.A")).toBe(false);
    expect(new JobLog(dir).keys("job1")).toEqual([]);
    log.clear("never-written"); // no throw
  });
});

describe("job log: messy files and inputs", () => {
  test("a last line cut short by a crash is skipped and logged, earlier steps survive", async () => {
    const dir = fresh();
    await new JobLog(dir).step("job1", "cutout:wamid.A", async () => ({ masks: 2 }));
    appendFileSync(join(dir, "job1.jsonl"), '{"key":"transcript:wamid.B","at":17900');
    const lines: string[] = [];
    const log = new JobLog(dir, (l) => lines.push(l));
    expect(log.keys("job1")).toEqual(["cutout:wamid.A"]);
    expect(lines.length).toBeGreaterThan(0);
    const s = paid({ text: "x" });
    await log.step("job1", "transcript:wamid.B", s.run);
    expect(s.calls.n).toBe(1);
    expect(new JobLog(dir, () => {}).keys("job1")).toEqual(["cutout:wamid.A", "transcript:wamid.B"]);
  });

  test("the file is append only: earlier lines are never rewritten", async () => {
    const dir = fresh();
    const log = new JobLog(dir);
    await log.step("job1", "a", async () => 1);
    const before = readFileSync(join(dir, "job1.jsonl"), "utf8");
    await log.step("job1", "b", async () => 2);
    const after = readFileSync(join(dir, "job1.jsonl"), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.trim().split("\n")).toHaveLength(2);
  });

  test("a job id that could escape the folder is refused before anything is written", async () => {
    const dir = fresh();
    const log = new JobLog(dir);
    for (const bad of ["../x", "", "a/b", "a\\b", "job 1", "x".repeat(81), "job1.jsonl"]) {
      await expect(log.step(bad, "k", async () => 1)).rejects.toThrow();
      expect(() => log.has(bad, "k")).toThrow();
    }
    expect(existsSync(join(dir, "..", "x.jsonl"))).toBe(false);
  });

  test("an empty or very long key is refused", async () => {
    const log = new JobLog(fresh());
    await expect(log.step("job1", "", async () => 1)).rejects.toThrow();
    await expect(log.step("job1", "k".repeat(201), async () => 1)).rejects.toThrow();
  });

  test("undefined is stored as null, and Pidgin text with naira signs round-trips", async () => {
    const dir = fresh();
    const log = new JobLog(dir);
    expect(await log.step("job1", "a", async () => undefined)).toBeNull();
    const text = "Garri na ₦1,500 per paint\nIndomie \"belle full\" na 250";
    await log.step("job1", "b", async () => ({ text }));
    const again = new JobLog(dir);
    expect(await again.step("job1", "a", async () => "ran again")).toBeNull();
    expect(await again.step("job1", "b", async () => ({ text: "ran again" }))).toEqual({ text });
  });

  test("if a key appears twice in a file, the first result wins", async () => {
    const dir = fresh();
    appendFileSync(join(dir, "job1.jsonl"), `${JSON.stringify({ key: "a", at: 1, result: "first" })}\n`);
    appendFileSync(join(dir, "job1.jsonl"), `${JSON.stringify({ key: "a", at: 2, result: "second" })}\n`);
    const log = new JobLog(dir, () => {});
    expect(await log.step("job1", "a", async () => "ran")).toBe("first");
    expect(log.keys("job1")).toEqual(["a"]);
  });
});
