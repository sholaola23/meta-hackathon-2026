# Test material for the day-one spike test

Fixtures for the 27 Oct go/no-go test (thresholds in `../docs/idea-decision.md`). None of this goes in the demo video.

| Folder | What | Source |
|---|---|---|
| `stalls.json` | Answer key: 5 stalls, items, naira prices | Written by hand |
| `images/` | 2 generated photos per stall (10), prompts in `PROMPTS.md` | Muse Image (`muse-image-1.0`), 26 Oct |
| `real-photos/` | 8 real Nigerian stall photos for an honest SAM check | Wikimedia Commons, CC BY-SA (see `ATTRIBUTION.md`) |
| `voice/` | 5 Pidgin price scripts, placeholder voice notes (.ogg, WhatsApp format), price answer key | Scripts written by hand; audio is macOS text-to-speech |

## Known caveats
- `images/stall-4-foodstuff-v1.jpg`: the garri can't be told apart from the rice. Use v2 for counting.
- Some generated images contain extra copies of items (a second Bournvita jar in stall 1 v2, a second water bottle in stall 5 v1). Score by item type, not exact counts.
- Generated packaging shows real brand names. That's fine for internal testing, but keep it out of the demo and marketing.
- Voice notes are British-accented text-to-speech, so they test price parsing only. Real recordings: see `voice/RECORDING-GUIDE.md`.
- Deliberately unpriced items: Screen protector (stall 3) and Sugar cubes pack (stall 5). The system should ask about these.
- Sachet items in `stalls.json` say "(strip)", but the price is per sachet (100 and 150).
- Real photos are CC BY-SA, so any published crops or mask overlays made from them must carry the same licence and credit.
- There is no real phone-accessories photo; no suitable openly licensed one was found.
