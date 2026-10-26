// Independent QA attacks on the job step log (PR #7, round 2): the clear() generation and write-failure fixes.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobLog } from "./joblog";

const fresh = () => mkdtempSync(join(tmpdir(), "stallsnap-joblog-qa2-"));

function gate<T>(value: T) {
  let open!: () => void;
  const ready = new Promise<void>((r) => (open = r));
  const run = async () => {
    await ready;
    return value;
  };
  return { run, open };
}

describe("QA r2: clear() generations", () => {
  test("the same key started after clear() is recorded with the new result, even if the old run lands last", async () => {
    const dir = fresh();
    const log = new JobLog(dir);
    const old = gate("old");
    const neu = gate("new");
    const a = log.step("job1", "pricing:wamid.A", old.run);
    log.clear("job1");
    const b = log.step("job1", "pricing:wamid.A", neu.run);
    neu.open();
    expect(await b).toBe("new");
    old.open();
    expect(await a).toBe("old");
    expect(await log.step("job1", "pricing:wamid.A", async () => "paid again")).toBe("new");
    expect(await new JobLog(dir).step("job1", "pricing:wamid.A", async () => "paid again")).toBe("new");
  });

  test("two clears in a row, and a clear on another job, leave running steps where they belong", async () => {
    const dir = fresh();
    const log = new JobLog(dir);
    const j1 = gate(1);
    const j2 = gate(2);
    const a = log.step("job1", "cutout:wamid.A", j1.run);
    const b = log.step("job2", "cutout:wamid.A", j2.run);
    log.clear("job1");
    log.clear("job1");
    j1.open();
    j2.open();
    await Promise.all([a, b]);
    expect(log.keys("job1")).toEqual([]);
    expect(new JobLog(dir).keys("job2")).toEqual(["cutout:wamid.A"]);
  });

  test("a result kept only in memory after a failed write is still returned as a copy", async () => {
    const parent = fresh();
    const dir = join(parent, "not-a-dir");
    writeFileSync(dir, "");
    const log = new JobLog(dir, () => undefined);
    const first = await log.step("job1", "cutout:wamid.A", async () => ({ items: ["tin"] }));
    (first as { items: string[] }).items.push("ghost");
    expect(await log.step("job1", "cutout:wamid.A", async () => ({ items: [] as string[] }))).toEqual({ items: ["tin"] });
    expect(log.keys("job1")).toEqual(["cutout:wamid.A"]);
  });
});
