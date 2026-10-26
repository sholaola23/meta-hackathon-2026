# Build log

A dated record of what was built during the hackathon (26 Oct to 4 Nov 2026), so judges can see that everything is new work. Seeded from the git history on 26 Oct; add an entry with each piece of work. Times are UTC, which is UK time for the whole hackathon.

The hackathon rules count work done from 26 Oct to 4 Nov. Nothing in this repo was written before 26 Oct, and no code was copied from other projects.

## Mon 26 Oct 2026

| Time (UTC) | What | Where |
|---|---|---|
| 08:11 | Repo created: README with the rules, dates and Meta Model API notes | `8dcd85d`, `601eecc` |
| 08:18 | Idea chosen (StallSnap) after a three-agent debate, with guardrails and the day-one go/no-go test | `76f81b9`, `docs/idea-decision.md` |
| 08:29 | README, project rules (`CLAUDE.md`), MIT licence and the spike-test material: 5 stalls generated with Muse Image, 8 openly licensed real stall photos (credited in `ATTRIBUTION.md`), Pidgin price scripts with placeholder TTS voice notes, and the answer keys | `07ab307`, `test-material/` |
| 10:16 | Notes from the hackathon Discord rules and FAQs | `5887f9c` |
| 10:19 | Claude Project briefs for running the build | `d2b7ae0`, `docs/project-briefs.md` |
| 10:30 | Judging criteria and goals | `c9e2a29`, `docs/judging-and-goals.md` |
| 10:51 | Day-one go/no-go spike, written from scratch in `spike/` (bun, TypeScript): Meta Model API client with a response cache and call ledger, SAM 3.1 segmentation, Muse Spark product phrases, Muse Voice Transcribe, and a Muse Spark agent with `set_price`, `flag_missing_price` and `ask_trader` tools. Voice price matching 97%; SAM cut-outs 76% on real photos with two phrasings per product. Spend about $1.16 | PR #1 (`spike/`, results in `test-results/day1.md` on that PR) |
| 10:58 | Hard spend cap for every paid Meta API call: an off switch, a per-job call limit and a daily dollar cap, with tests run in CI. This build log, the README provenance wording and the plan to submission, then the WhatsApp Cloud API route and the same-pipeline fallback recorded in the docs (to 11:00) | PR #2, `src/spend-guard.ts`, `docs/plan.md` |
| 11:04 | Spend cap hardened after independent QA: a lock and atomic writes so the daily cap holds across processes, bad cost figures can't reset the day's spend, misspelt settings stop start-up | PR #2 |
| 11:10 | WhatsApp loop on Meta's WhatsApp Cloud API (replaces Kapso, approved by Shola), written from scratch in `src/whatsapp/`: webhook verify and signature check, two-step media download with type, size and hash checks, 6-second paced replies, and the photo, voice note, confirm or correct, catalogue link conversation. Messy-input test suite run in CI, plus the independent QA attack suite after round 1 fixes (busy-state replies, restarts, send retries, token redaction). No model calls, spend $0 | PR #5, `src/whatsapp/`, `docs/whatsapp.md` |
| 11:25 | Judging weights corrected to the official rules (impact 30%, Meta AI tooling 25%, demo 25%, technical depth 20%) in the goals doc, README and project briefs | `docs/judging-and-goals.md` |
