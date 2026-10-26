// Finished paid steps per job, so a retried webhook or a restart resumes without paying twice.
// One append-only JSONL file per job; a new instance replays what is on disk on first use.
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const JOB_ID = /^[A-Za-z0-9_-]{1,80}$/;
const KEY_LIMIT = 200;

function checkJobId(jobId: string): void {
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) throw new Error(`joblog: bad jobId ${JSON.stringify(jobId)}`);
}

function checkKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || key.length > KEY_LIMIT) {
    throw new Error("joblog: key must be a non-empty string of up to 200 characters");
  }
}

/** The value that survives the trip through the file: undefined becomes null. */
function freeze(value: unknown): unknown {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  if (json === undefined) return null;
  return JSON.parse(json) as unknown;
}

export class JobLog {
  private results = new Map<string, Map<string, unknown>>();
  private order = new Map<string, string[]>();
  private loaded = new Set<string>();
  private inflight = new Map<string, Map<string, Promise<unknown>>>();

  /** dir holds one append-only file per job. It is created on first write. */
  constructor(
    private readonly dir: string,
    private readonly log: (line: string) => void = console.error,
  ) {}

  /**
   * Returns the recorded result for (jobId, key) if one exists, without calling run.
   * Otherwise calls run once, appends {key, at, result} to the job's file, and returns the result.
   * If run throws, nothing is recorded and the error is rethrown, so the next call tries again.
   * Two overlapping calls with the same jobId and key call run only once and get the same result.
   */
  step<T>(jobId: string, key: string, run: () => Promise<T>): Promise<T> {
    try {
      checkJobId(jobId);
      checkKey(key);
      this.load(jobId);
    } catch (err) {
      return Promise.reject(err);
    }
    const cached = this.results.get(jobId)!;
    if (cached.has(key)) return Promise.resolve(cached.get(key) as T);
    const flying = this.inflight.get(jobId)?.get(key);
    if (flying) return flying as Promise<T>;
    const flight = this.runOnce(jobId, key, run);
    let byJob = this.inflight.get(jobId);
    if (!byJob) {
      byJob = new Map();
      this.inflight.set(jobId, byJob);
    }
    byJob.set(key, flight);
    return flight as Promise<T>;
  }

  /** True if (jobId, key) has a recorded result. */
  has(jobId: string, key: string): boolean {
    checkJobId(jobId);
    checkKey(key);
    this.load(jobId);
    return this.results.get(jobId)!.has(key);
  }

  /** Keys recorded for the job, in the order they finished. */
  keys(jobId: string): string[] {
    checkJobId(jobId);
    this.load(jobId);
    return [...this.order.get(jobId)!];
  }

  /** Deletes the job's file. Used when the trader starts again. */
  clear(jobId: string): void {
    checkJobId(jobId);
    this.results.delete(jobId);
    this.order.delete(jobId);
    this.loaded.delete(jobId);
    try {
      unlinkSync(this.file(jobId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private async runOnce<T>(jobId: string, key: string, run: () => Promise<T>): Promise<unknown> {
    try {
      const stored = freeze(await run());
      this.append(jobId, key, stored);
      let keys = this.results.get(jobId);
      if (!keys) {
        // clear() ran while run was in flight; the step paid, so keep its record.
        keys = new Map();
        this.results.set(jobId, keys);
        this.order.set(jobId, []);
        this.loaded.add(jobId);
      }
      if (!keys.has(key)) {
        keys.set(key, stored);
        this.order.get(jobId)!.push(key);
      }
      return stored;
    } finally {
      const byJob = this.inflight.get(jobId);
      byJob?.delete(key);
      if (byJob && byJob.size === 0) this.inflight.delete(jobId);
    }
  }

  private append(jobId: string, key: string, result: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const file = this.file(jobId);
    if (existsSync(file)) {
      // A crash can leave the tail without its newline; end it so the new
      // entry starts on its own line. Earlier bytes are never touched.
      const prev = readFileSync(file, "utf8");
      if (prev.length > 0 && !prev.endsWith("\n")) appendFileSync(file, "\n");
    }
    appendFileSync(file, `${JSON.stringify({ key, at: Date.now(), result })}\n`);
  }

  private file(jobId: string): string {
    return join(this.dir, `${jobId}.jsonl`);
  }

  /** Replay the job's file once; a damaged line is skipped and logged, never fatal. */
  private load(jobId: string): void {
    if (this.loaded.has(jobId)) return;
    this.loaded.add(jobId);
    const found = new Map<string, unknown>();
    const finished: string[] = [];
    this.results.set(jobId, found);
    this.order.set(jobId, finished);
    const file = this.file(jobId);
    if (!existsSync(file)) return;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      this.log(`joblog: could not read ${file}, starting empty: ${(err as Error).message}`);
      return;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        this.log(`joblog: skipping bad line in ${file}: ${line.slice(0, 120)}`);
        continue;
      }
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        this.log(`joblog: skipping bad line in ${file}: ${line.slice(0, 120)}`);
        continue;
      }
      const { key, result } = row as { key?: unknown; result?: unknown };
      if (typeof key !== "string" || key.length === 0 || key.length > KEY_LIMIT || !("result" in row)) {
        this.log(`joblog: skipping bad line in ${file}: ${line.slice(0, 120)}`);
        continue;
      }
      if (found.has(key)) continue; // First write wins; later duplicates are ignored.
      found.set(key, result === undefined ? null : result);
      finished.push(key);
    }
  }
}
