// Extra cover for the job step log: validation, file hygiene, and overlap edges
// that the acceptance tests in joblog.acceptance.test.ts do not pin down.
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobLog } from "./joblog";

const fresh = () => mkdtempSync(join(tmpdir(), "stallsnap-joblog-"));

describe("job log: files and validation", () => {
  test("the folder is created on first write, not before", async () => {
    const dir = join(fresh(), "sub");
    const log = new JobLog(dir);
    expect(existsSync(dir)).toBe(false);
    expect(log.has("job1", "a")).toBe(false);
    expect(log.keys("job1")).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    await expect(log.step("job1", "a", async () => { throw new Error("nope"); })).rejects.toThrow("nope");
    expect(existsSync(dir)).toBe(false);
    await log.step("job1", "a", async () => 1);
    expect(existsSync(join(dir, "job1.jsonl"))).toBe(true);
  });

  test("a bad job id is refused before anything is written, by every method", async () => {
    const dir = join(fresh(), "sub");
    const log = new JobLog(dir);
    for (const bad of ["../x", "", "a/b", "job 1"]) {
      await expect(log.step(bad, "k", async () => 1)).rejects.toThrow();
      expect(() => log.has(bad, "k")).toThrow();
      expect(() => log.keys(bad)).toThrow();
      expect(() => log.clear(bad)).toThrow();
    }
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(dir, "..", "x.jsonl"))).toBe(false);
    // Boundary ids are fine, including - and _.
    await log.step("a".repeat(80), "k", async () => 1);
    await log.step("job-1_X", "k", async () => 1);
    expect(log.has("a".repeat(80), "k")).toBe(true);
  });

  test("keys may hold : and ., up to 200 characters", async () => {
    const log = new JobLog(fresh());
    await log.step("job1", "cutout:wamid.ABC-1_x", async () => 1);
    await log.step("job1", "k".repeat(200), async () => 2);
    expect(log.keys("job1")).toEqual(["cutout:wamid.ABC-1_x", "k".repeat(200)]);
    expect(() => log.has("job1", "")).toThrow();
  });

  test("a corrupt line in the middle is skipped and logged, the file is left alone", async () => {
    const dir = fresh();
    const file = join(dir, "job1.jsonl");
    appendFileSync(file, `${JSON.stringify({ key: "a", at: 1, result: 1 })}\n`);
    appendFileSync(file, `{"key": "b", broken\n`);
    appendFileSync(file, `${JSON.stringify({ key: "c", at: 3, result: 3 })}\n`);
    const before = readFileSync(file, "utf8");
    const lines: string[] = [];
    const log = new JobLog(dir, (l) => lines.push(l));
    expect(log.keys("job1")).toEqual(["a", "c"]);
    expect(await log.step("job1", "a", async (): Promise<unknown> => "ran")).toBe(1);
    expect(lines.length).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("a clean file loads without logging, and keys returns a copy", async () => {
    const dir = fresh();
    await new JobLog(dir).step("job1", "a", async () => 1);
    const lines: string[] = [];
    const log = new JobLog(dir, (l) => lines.push(l));
    expect(log.keys("job1")).toEqual(["a"]);
    expect(lines).toEqual([]);
    log.keys("job1").push("zzz");
    expect(log.keys("job1")).toEqual(["a"]);
  });

  test("clear removes the file and the next step pays again", async () => {
    const dir = fresh();
    const log = new JobLog(dir);
    await log.step("job1", "a", async () => 1);
    expect(existsSync(join(dir, "job1.jsonl"))).toBe(true);
    log.clear("job1");
    expect(existsSync(join(dir, "job1.jsonl"))).toBe(false);
    expect(log.keys("job1")).toEqual([]);
    let calls = 0;
    await log.step("job1", "a", async () => { calls++; return 2; });
    expect(calls).toBe(1);
    expect(await log.step("job1", "a", async () => 3)).toBe(2);
  });
});

describe("job log: overlap and round-trips", () => {
  test("overlapping calls for different keys each run once", async () => {
    const log = new JobLog(fresh());
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = async (v: number) => { calls++; await gate; return v; };
    const a = log.step("job1", "a", () => run(1));
    const b = log.step("job1", "b", () => run(2));
    release();
    expect(await a).toBe(1);
    expect(await b).toBe(2);
    expect(calls).toBe(2);
  });

  test("overlapping calls that fail all reject and the next try runs again", async () => {
    const log = new JobLog(fresh());
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = async () => { calls++; await gate; throw new Error("cap"); };
    const a = log.step("job1", "a", run);
    const b = log.step("job1", "a", run);
    expect(b).toBe(a); // One shared promise, so a late waiter misses nothing.
    release();
    await expect(a).rejects.toThrow("cap");
    await expect(b).rejects.toThrow("cap");
    expect(calls).toBe(1);
    expect(log.has("job1", "a")).toBe(false);
    expect(await log.step("job1", "a", async () => "ok")).toBe("ok");
    expect(calls).toBe(1);
  });

  test("undefined is stored as null in the file; primitives round-trip", async () => {
    const dir = fresh();
    const log = new JobLog(dir);
    expect(await log.step("job1", "u", async () => undefined)).toBeNull();
    expect(readFileSync(join(dir, "job1.jsonl"), "utf8")).toContain('"result":null');
    for (const [key, value] of [["n", 0], ["s", ""], ["t", true], ["z", null], ["arr", [1, "x"]]] as const) {
      expect(await log.step("job1", key, async () => value)).toEqual(value);
    }
    const again = new JobLog(dir);
    expect(await again.step("job1", "u", async () => "ran")).toBeNull();
    expect(await again.step("job1", "arr", async (): Promise<unknown> => [])).toEqual([1, "x"]);
  });
});
