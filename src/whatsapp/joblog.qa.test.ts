// Independent QA attacks on the job step log (PR #7, round 1). Each attack stays as a permanent test.
// Tests marked BLOCKER describe the behaviour QA expects after the fix; they fail on 6e752b7.
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobLog } from "./joblog";

const fresh = () => mkdtempSync(join(tmpdir(), "stallsnap-joblog-qa-"));
const quiet = () => {
  const lines: string[] = [];
  return { lines, log: (l: string) => void lines.push(l) };
};

function gate<T>(value: T) {
  let open!: () => void;
  const ready = new Promise<void>((r) => (open = r));
  const calls = { n: 0 };
  const run = async () => {
    calls.n++;
    await ready;
    return value;
  };
  return { run, calls, open };
}

describe("QA: clear() while a step is still running", () => {
  test("BLOCKER: a step that finishes after clear() does not bring the old job back", async () => {
    const dir = fresh();
    const log = new JobLog(dir);
    const old = gate({ products: ["photo A tins"] });
    const flight = log.step("job1", "cutout:wamid.A", old.run);
    log.clear("job1"); // trader says "start again" while photo A is still being cut out
    await log.step("job1", "cutout:wamid.B", async () => ({ products: ["photo B fabric"] }));
    old.open();
    await flight; // the caller still gets its paid result
    expect(log.keys("job1")).toEqual(["cutout:wamid.B"]);
    expect(new JobLog(dir).keys("job1")).toEqual(["cutout:wamid.B"]);
  });

  test("BLOCKER: clear() leaves no file behind once the late step lands", async () => {
    const dir = fresh();
    const log = new JobLog(dir);
    const old = gate("x");
    const flight = log.step("job1", "transcript:wamid.A", old.run);
    log.clear("job1");
    old.open();
    await flight;
    expect(existsSync(join(dir, "job1.jsonl"))).toBe(false);
    expect(new JobLog(dir).has("job1", "transcript:wamid.A")).toBe(false);
  });
});

describe("QA: disk full or unwritable log", () => {
  // The log folder path is an existing file, so mkdirSync throws, the same place ENOSPC or EACCES would.
  test("BLOCKER: a step that paid but could not be written is not paid again in the same process", async () => {
    const parent = fresh();
    const dir = join(parent, "not-a-dir");
    writeFileSync(dir, "");
    const q = quiet();
    const log = new JobLog(dir, q.log);
    const calls = { n: 0 };
    const run = async () => {
      calls.n++;
      return { text: "Indomie na 250" };
    };
    await log.step("job1", "transcript:wamid.A", run).catch(() => undefined);
    await log.step("job1", "transcript:wamid.A", run).catch(() => undefined);
    expect(calls.n).toBe(1);
    expect(q.lines.some((l) => l.includes("job1"))).toBe(true); // the failure is logged, not silent
  });

  test("BLOCKER: an unreadable job file does not make every retry pay again", async () => {
    const dir = fresh();
    mkdirSync(join(dir, "job1.jsonl")); // EISDIR on read and on append
    const q = quiet();
    const log = new JobLog(dir, q.log);
    const calls = { n: 0 };
    const run = async () => {
      calls.n++;
      return 1;
    };
    await log.step("job1", "cutout:wamid.A", run).catch(() => undefined);
    await log.step("job1", "cutout:wamid.A", run).catch(() => undefined);
    expect(calls.n).toBe(1);
  });
});

describe("QA: concurrent duplicate webhooks (one process)", () => {
  test("ten overlapping deliveries of the same message pay once and all see the same result", async () => {
    const log = new JobLog(fresh());
    const g = gate({ masks: 4 });
    const all = Array.from({ length: 10 }, () => log.step("job1", "cutout:wamid.A", g.run));
    g.open();
    const got = await Promise.all(all);
    expect(g.calls.n).toBe(1);
    for (const r of got) expect(r).toEqual({ masks: 4 });
  });

  test("a delivery that arrives while a failing attempt is in flight shares its failure, then the next one retries", async () => {
    const log = new JobLog(fresh());
    const calls = { n: 0 };
    let fail = true;
    const run = async () => {
      calls.n++;
      await Promise.resolve();
      if (fail) throw new Error("Meta 500");
      return "ok";
    };
    const a = log.step("job1", "pricing:wamid.A", run);
    const b = log.step("job1", "pricing:wamid.A", run);
    await expect(a).rejects.toThrow("Meta 500");
    await expect(b).rejects.toThrow("Meta 500");
    expect(calls.n).toBe(1);
    fail = false;
    expect(await log.step("job1", "pricing:wamid.A", run)).toBe("ok");
    expect(calls.n).toBe(2);
    expect(await log.step("job1", "pricing:wamid.A", run)).toBe("ok");
    expect(calls.n).toBe(2);
  });

  test("a run that throws synchronously is a failed step, not a crash", async () => {
    const log = new JobLog(fresh());
    const bad = (() => {
      throw new Error("sync");
    }) as unknown as () => Promise<number>;
    await expect(log.step("job1", "cutout:wamid.A", bad)).rejects.toThrow("sync");
    expect(log.has("job1", "cutout:wamid.A")).toBe(false);
  });
});

describe("QA: crash mid-write and corrupt files", () => {
  test("every possible cut point of the last line loads cleanly and the step re-runs", async () => {
    const dir = fresh();
    await new JobLog(dir).step("job1", "cutout:wamid.A", async () => ({ masks: 2 }));
    const full = readFileSync(join(dir, "job1.jsonl"), "utf8");
    const second = JSON.stringify({ key: "transcript:wamid.B", at: 1, result: { text: "Ọ̀kà na ₦500" } }) + "\n";
    for (let cut = 1; cut < second.length - 1; cut++) {
      writeFileSync(join(dir, "job1.jsonl"), full + second.slice(0, cut));
      const q = quiet();
      const log = new JobLog(dir, q.log);
      expect(log.keys("job1")).toEqual(["cutout:wamid.A"]);
    }
  });

  test("a cut-short line, an empty file, CRLF and junk lines never stop the load", async () => {
    const dir = fresh();
    const good = JSON.stringify({ key: "cutout:wamid.A", at: 1, result: 7 });
    writeFileSync(
      join(dir, "job1.jsonl"),
      `${good}\r\n\n[]\nnull\n"str"\n{"key":""}\n{"key":"x"}\n{"key":5,"result":1}\n${good.replace("7", "8")}\n{"key":"pricing:wamid.C","res`,
    );
    const q = quiet();
    const log = new JobLog(dir, q.log);
    // The first good record wins over the later duplicate.
    expect(log.has("job1", "cutout:wamid.A")).toBe(true);
    expect(await log.step("job1", "cutout:wamid.A", async () => 99)).toBe(7);
    writeFileSync(join(dir, "job2.jsonl"), "");
    expect(new JobLog(dir).keys("job2")).toEqual([]);
  });

  test("appending after a cut-short tail keeps the new record readable", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "job1.jsonl"), '{"key":"cutout:wamid.A","at":1,"res');
    const log = new JobLog(dir, quiet().log);
    await log.step("job1", "cutout:wamid.A", async () => 3);
    expect(new JobLog(dir, quiet().log).keys("job1")).toEqual(["cutout:wamid.A"]);
  });
});

describe("QA: two processes on the same folder", () => {
  // Documents the single-writer limit: each JobLog caches the file once and never re-reads it.
  test("a second instance does not see a step the first recorded after it loaded", async () => {
    const dir = fresh();
    const a = new JobLog(dir);
    const b = new JobLog(dir);
    expect(b.keys("job1")).toEqual([]); // b loads now
    await a.step("job1", "cutout:wamid.A", async () => 1);
    const calls = { n: 0 };
    await b.step("job1", "cutout:wamid.A", async () => {
      calls.n++;
      return 2;
    });
    expect(calls.n).toBe(1); // paid twice: JobLog assumes one process per folder
    expect(new JobLog(dir).keys("job1")).toEqual(["cutout:wamid.A"]); // first write still wins on reload
  });
});

describe("QA: odd ids and keys", () => {
  test("real WhatsApp message ids, base64 padding, slashes and Unicode work as keys", async () => {
    const dir = fresh();
    const log = new JobLog(dir);
    const keys = [
      "cutout:wamid.HBgNMjM0ODAzMTIzNDU2NxUCABIYFjNFQjBDNzM5RkE0RjQ1QzE2NjlGAA==",
      "transcript:wamid.a+b/c=",
      "pricing:wamid.\u0000nul",
      "pricing:wamid.line\nbreak",
      "pricing:ọjà-₦",
      "__proto__",
      "x".repeat(200),
    ];
    for (const k of keys) await log.step("job1", k, async () => k);
    const again = new JobLog(dir);
    expect(again.keys("job1")).toEqual(keys);
    for (const k of keys) expect(await again.step("job1", k, async () => "paid again")).toBe(k);
  });

  test("bad job ids and keys are refused before any file is touched", async () => {
    const dir = join(fresh(), "logs");
    const log = new JobLog(dir);
    for (const id of ["../x", "", "a/b", "a\\b", ".", "..", "a.b", "a b", "x".repeat(81), "job\u0000", "ǰob"]) {
      await expect(log.step(id, "k", async () => 1)).rejects.toThrow();
      expect(() => log.clear(id)).toThrow();
    }
    await expect(log.step("job1", "", async () => 1)).rejects.toThrow();
    await expect(log.step("job1", "x".repeat(201), async () => 1)).rejects.toThrow();
    expect(existsSync(dir)).toBe(false);
  });
});

describe("QA: privacy", () => {
  test("a damaged line is logged without the trader's words", () => {
    const dir = fresh();
    appendFileSync(join(dir, "job1.jsonl"), '{"key":"transcript:wamid.A","result":{"text":"my name is Ada, call 0803 123 4567"');
    const q = quiet();
    new JobLog(dir, q.log).keys("job1");
    expect(q.lines.join("\n")).not.toContain("0803");
    expect(q.lines.join("\n")).not.toContain("Ada");
  });
});
