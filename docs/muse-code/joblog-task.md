# Muse Code task: job step log

This file is the brief given to Muse Code (Meta's coding agent) with `muse exec`. Claude wrote this brief and the acceptance tests in `src/whatsapp/joblog.acceptance.test.ts`. Muse Code writes the implementation. The run is recorded in `docs/build-log.md`.

## Goal

Write `src/whatsapp/joblog.ts`. It records each finished paid step of a StallSnap job, so that a retried WhatsApp webhook or a server crash resumes from the last finished step and never pays for the same step twice. The steps are the SAM cut-out of a photo, the Voice Transcribe of a voice note, and the Muse Spark pricing turn. Keys look like `cutout:wamid.ABC` or `transcript:wamid.DEF`, so one key belongs to one WhatsApp message.

## Interface (must match exactly)

```ts
export class JobLog {
  /** dir holds one append-only file per job. It is created on first write. */
  constructor(dir: string, log?: (line: string) => void);

  /**
   * Returns the recorded result for (jobId, key) if one exists, without calling run.
   * Otherwise calls run once, appends {key, at, result} to the job's file, and returns the result.
   * If run throws, nothing is recorded and the error is rethrown, so the next call tries again.
   * Two overlapping calls with the same jobId and key call run only once and get the same result.
   */
  step<T>(jobId: string, key: string, run: () => Promise<T>): Promise<T>;

  /** True if (jobId, key) has a recorded result. */
  has(jobId: string, key: string): boolean;

  /** Keys recorded for the job, in the order they finished. */
  keys(jobId: string): string[];

  /** Deletes the job's file. Used when the trader starts again. */
  clear(jobId: string): void;
}
```

## Rules

1. One file per job: `<dir>/<jobId>.jsonl`, one JSON object per line. Append only; never rewrite earlier lines.
2. A new `JobLog` on the same `dir` sees everything an earlier one recorded (this is the crash case).
3. A last line cut short by a crash, or any line that isn't valid JSON, is skipped and logged with `log`. It must never stop the log from loading.
4. `jobId` must match `/^[A-Za-z0-9_-]{1,80}$/`. Anything else (for example `../x`, an empty string, a slash) throws an `Error` before any file is touched.
5. `key` is any non-empty string up to 200 characters. It may contain `:` and `.`. An empty key throws.
6. `result` must survive `JSON.stringify` and `JSON.parse` unchanged. If `run` returns `undefined`, store and return `null`.
7. If the same key appears twice in a file (it shouldn't), the first one wins.
8. Use only `node:fs` and `node:path`. No new dependencies. Synchronous file calls are fine.
9. Match the style of `src/whatsapp/store.ts`: a short comment at the top saying why the file exists, plain TypeScript, no classes beyond `JobLog`.

## How it is checked

- `bun test src/whatsapp/joblog.acceptance.test.ts` passes. Do not edit that file.
- `bun test src` passes (all existing tests).
- Add your own tests in `src/whatsapp/joblog.test.ts` for anything the acceptance tests miss.
- Do not touch any other file.

## Run record (26 Oct 2026)

- Muse Code 1.4.13, `muse exec --approval-mode never --sandbox-network restricted --disable-web-tools --disable-request-user-input --json --max-model-steps 40`, run on Shola's Mac in a fresh git worktree. Muse Code's own macOS sandbox stayed on.
- 17 model calls on Muse Spark 1.3, 194 seconds, exit 0. About 810k input tokens (722k cached) and 23k output. Cost about $0.015.
- What it did: read this brief, `store.ts` and the acceptance tests; ran the tests to see them fail; wrote `joblog.ts`; made 4 edits to pass two acceptance cases (overlapping calls, and appending after a cut-short line); wrote 9 tests of its own in `joblog.test.ts`; ran `bun test src` until it passed.
- Only the two allowed files changed. The acceptance tests and this brief were untouched.
- After the run, Claude fixed two type errors in `joblog.test.ts` that `bun test` doesn't check (`tsc --strict` does). No change to `joblog.ts`.
- Later runs add `--contributor-mode off --no-foreign-personal-context`, so nothing sent can be used for training and only this repo's context goes with the brief.
