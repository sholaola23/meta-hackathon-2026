# Build log

Dated record of what was built during the hackathon (26 Oct to 4 Nov 2026). Everything here is new work.

## Mon 26 Oct 2026

- Day-one go/no-go spike, written from scratch in `spike/` (bun, TypeScript): `lib.ts` (Meta Model API client, response cache, call ledger), `sam.ts` (SAM 3.1 concept segmentation and mask parsing with `@meta-sam/parser`), `detect.ts` (Muse Spark proposes product phrases, SAM cuts them out, overlays and crop sheets), `voice.ts` (Muse Voice Transcribe, then a Muse Spark agent with `set_price`, `flag_missing_price` and `ask_trader` tools), `score.ts` (reprints the scores from the result files).
- Results in `test-results/day1.md`: voice price matching 97%, SAM cut-outs 76% on real photos with two phrasings per product, Kapso round trip blocked on Shola. Spend about $1.16.
- Image step, written from scratch in `image/` (bun, TypeScript): `cutout.ts` (Muse Spark names each product with two phrasings, SAM 3.1 segments both plus "person" once), `mask.ts` (drops masks that are mostly a person and cuts person pixels out of the rest, drops scene-sized and speck-sized masks, merges duplicates by mask overlap), `photo.ts` (EXIF rotation, size cap, unreadable or tiny photos refused), `catalogue-image.ts` (the real cut-out on a clean backdrop with a pixel check that the product is unchanged; a Muse Image backdrop is used only if it is provably empty), `live.ts` and `validate.ts` (live calls through the spend guard and the spike's cache). Messy-input suite in `image/test/`, run by CI (`.github/workflows/image.yml`).
- Five held-out real stall photos and their answer key in `test-material/held-out/`, written before any model saw them.
