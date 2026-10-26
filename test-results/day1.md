# Day-one go/no-go test: summary

Run on Mon 26 Oct 2026 (UK). Thresholds come from `docs/idea-decision.md`. The scripts are in `spike/`. `bun spike/score.ts` reprints the scores from the result files with no API calls.

## Verdict: GO

| Test | Threshold | Result |
|---|---|---|
| SAM 3.1 cut-outs, real stall photos | 70% of sellable items cut out on their own | **76%** (37 of 49), with two phrasings per product |
| SAM 3.1 cut-outs, generated stall photos | 70% | **87%** (54 of 62) |
| Pidgin price note to the right item | 80% | **97%** (32 of 33) |
| Unpriced items flagged and asked about | | 2 of 2, each with a Pidgin question to the trader |

How it works: Muse Spark lists the products in the photo, SAM 3.1 cuts each one out, Muse Voice Transcribe turns the voice note into text, and a Muse Spark agent prices the items with `set_price`, `flag_missing_price` and `ask_trader` tool calls.

The voice test used text-to-speech placeholders. Real Pidgin recordings are the next test.

## Spend

The day-one test made 280 paid calls for about $1.16 (about £0.90). Every live call is logged, and every response is cached.

## Licences

Overlays and crop sheets made from `test-material/real-photos/` adapt CC BY-SA photos and carry the same licence. The credits are in `test-material/real-photos/ATTRIBUTION.md`. None of this test material may appear in the demo video.
