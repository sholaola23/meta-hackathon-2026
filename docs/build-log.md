# Build log

Dated record of what was built during the hackathon (26 Oct to 4 Nov 2026). Everything here is new work.

## Mon 26 Oct 2026

- Day-one go/no-go spike, written from scratch in `spike/` (bun, TypeScript): `lib.ts` (Meta Model API client, response cache, call ledger), `sam.ts` (SAM 3.1 concept segmentation and mask parsing with `@meta-sam/parser`), `detect.ts` (Muse Spark proposes product phrases, SAM cuts them out, overlays and crop sheets), `voice.ts` (Muse Voice Transcribe, then a Muse Spark agent with `set_price`, `flag_missing_price` and `ask_trader` tools), `score.ts` (reprints the scores from the result files).
- Results in `test-results/day1.md`: voice price matching 97%, SAM cut-outs 76% on real photos with two phrasings per product, Kapso round trip blocked on Shola. Spend about $1.16.
