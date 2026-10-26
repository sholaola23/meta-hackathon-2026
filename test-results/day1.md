# Day-one go/no-go test results

Run on Mon 26 Oct 2026 (UK), a day ahead of the planned 27 Oct slot. Thresholds come from `docs/idea-decision.md`. Scripts are in `spike/`; every API response is cached in `test-results/cache/` (gitignored), so `bun spike/score.ts` reprints every number below with no API calls.

## Verdict: GO, with three conditions

| Test | Threshold | Result | Status |
|---|---|---|---|
| 1. SAM 3.1 cut-outs, real photos | 70% of sellable items as separate crops | 59% with one phrase per product; **76%** with two phrasings per product | Pass only with two phrasings |
| 1. SAM 3.1 cut-outs, generated photos | 70% | 79% with one phrase; **87%** with two | Pass |
| 2. Prices on the right item | 80% | **97%** (32 of 33) on both transcription settings | Pass |
| 2. Unpriced items flagged and asked about | (part of test 2) | 2 of 2 flagged, a Pidgin question drafted for each, no stray prices | Pass |
| 3. Kapso WhatsApp image round trip | works | Not run: needs Shola (see below) | Blocked |

Conditions for GO:

1. The pipeline asks Muse Spark for two phrasings of each product (a specific one and the plainest everyday noun) and unions the SAM masks. One phrasing alone misses too much on real photos.
2. A guard drops masks of people. On the Balogun fabric photo, the phrase "fabric" returned the trader's shirt and nothing else.
3. Shola does the three Kapso steps below, or we accept that test 3 runs during the build.

## Test 1: SAM 3.1 cut-outs

How it ran: for each photo, Muse Spark (`muse-spark-1.3`, vision, JSON schema output) lists the product types as short noun phrases, then SAM 3.1 (`sam-3.1` on `/v1/responses`, one concept per request, as the docs require) segments each phrase. Masks over 40% of the photo are dropped and near-duplicate boxes (IoU over 0.8) are merged. 17 photos: the 9 generated ones (stall 4 v1 skipped, as the README says) and all 8 real Wikimedia photos.

How it was scored: by eye, from the crop sheets in `test-results/day1/`. A sellable item counts when at least one crop shows that product on its own, cleanly enough for a catalogue picture. Generated photos use the items in `test-material/stalls.json`. Real photos have no answer key, so I wrote down each photo's lots (each heap, basin, strip or product line a trader would list) before scoring the second run. The scoring, with the crop label that hit for every item, is in `test-results/day1/sam-scores.json`.

Two runs:

- **v1**: Muse Spark's first prompt gave descriptive phrases ("blue milk tin", "green Milo sachet", "red pepper heap").
- **v2**: a second prompt, written after scoring v1, asks for the plainest everyday noun ("tin", "egg", "watermelon"). Note: this prompt was tuned on the same photos it is scored on, so treat v1+v2 as optimistic.

| Photo | Items | v1 | v1+v2 | What was missed |
|---|---|---|---|---|
| stall-1 provisions v1 | 6 | 5 | 6 | |
| stall-1 provisions v2 | 6 | 4 | 5 | Gala |
| stall-2 fabrics v1 | 5 | 5 | 5 | |
| stall-2 fabrics v2 | 5 | 5 | 5 | |
| stall-3 phone accessories v1 | 7 | 6 | 6 | screen protector |
| stall-3 phone accessories v2 | 7 | 4 | 6 | screen protector |
| stall-4 foodstuff v2 | 8 | 8 | 8 | |
| stall-5 mixed cluttered v1 | 9 | 5 | 6 | Milo sachets, detergent sachets, Cabin biscuits |
| stall-5 mixed cluttered v2 | 9 | 7 | 7 | sugar cubes, bar soap |
| **Generated total** | **62** | **49 (79%)** | **54 (87%)** | |
| real-01 sandals wall | 1 | 1 | 1 | none: about 90 pairs each cut out on their own |
| real-02 pepper and okra | 2 | 1 | 1 | okra heap |
| real-03 dry foodstuff basins | 9 | 7 | 7 | dried fish in plastic, sunflower seeds |
| real-04 foodstuff trader | 11 | 5 | 6 | okra, smoked fish, skewered meat, white bags, blue packets |
| real-05 fruit market | 7 | 5 | 6 | pawpaw |
| real-06 provision store | 8 | 3 | 7 | bags of dried pepper |
| real-07 provisions seller | 9 | 7 | 9 | |
| real-08 Balogun Ankara alley | 2 | 0 | 0 | everything; the one mask was the trader's shirt |
| **Real total** | **49** | **29 (59%)** | **37 (76%)** | |

By photo, 5 of the 8 real photos reach 70% with two phrasings (01, 03, 05, 06, 07); 02, 04 and 08 do not.

What I learned:

- **The phrase decides everything.** SAM returned zero matches for some plain, clearly visible things: "sachet" (on three photos full of sachets), "okra" (twice), "tin", "orange". A slightly different wording of the same thing often worked ("red pepper heap" found the heap that "pepper" missed). Two phrasings per product is cheap ($0.0025 per extra SAM call) and recovered 8 real-photo items.
- **Labels must not come from the phrase.** SAM finds objects that loosely match: "white rice heap" cut out the garri, "Milo sachet" cut out Horker sachets, "instant noodle packet" cut out Ovaltine refills. The crops are good, but the item names must come from Muse Spark looking at each crop, not from the phrase that found it.
- **Hardest cases**: dense stacks of similar fabric (real-08), loose produce in one big heap (okra), heaped smoked fish, and small flat items in packets (screen protector). Single items standing apart (tins, bottles, boxes, eggs, sandals on pegs, peppers laid out) work very well.
- **Person false positive**: on real-08 the phrase "fabric" matched the trader's patterned shirt. The pipeline needs a "person" mask check (segment "person" once and drop overlapping masks) before anything reaches a catalogue.
- Generic phrases also find things that are not stock, such as the egg crate's empty cells; the trader confirmation step has to let them delete a crop.

Overlays and crop sheets (`*-overlay.jpg`, `*-crops.jpg`, and `*-v2prompt-*` for v2, all at most 1500px) are kept on Shola's Mac in `test-results/day1/` and are not committed: the brief says to commit only code and results, and the real-photo ones are CC BY-SA adaptations.

## Test 2: Pidgin voice notes to prices

How it ran: each `*-tts.ogg` was converted to 24 kHz mono WAV (the transcribe endpoint only takes WAV) and sent to Muse Voice Transcribe (`/v1/asr/transcribe`, `muse-voice-transcribe-1.0`, `PUSH_TO_TALK`) twice: once plain, and once with `keywords` set to the product words from the stall list (keywords must be 30 characters or fewer, so whole item names fail with a 400). Muse Spark then got the stall's item list, the stall photo and the transcript, with three tools: `set_price`, `flag_missing_price` and `ask_trader`. Every run finished in two rounds (one batch of tool calls, then a summary).

No `*-real.*` recordings were in `test-material/voice/`, so only the TTS placeholders were tested.

| Stall | Plain | With keywords | Unpriced item |
|---|---|---|---|
| 1 provisions | 6/6 | 6/6 | none |
| 2 fabrics | 5/5 | 5/5 | none |
| 3 phone accessories | 6/6 | 6/6 | Screen protector: flagged, asked "Abeg, screen protector na how much?" |
| 4 foodstuff | 7/8 | 8/8 | none |
| 5 mixed cluttered | 8/8 | 7/8 | Sugar cubes: flagged, asked "Sugar cubes pack na how much?" |
| **Total** | **32/33 (97%)** | **32/33 (97%)** | 2/2 flagged, 0 wrongly priced |

Every tricky phrase in the answer key:

| Type | Example | Result |
|---|---|---|
| Mid-sentence corrections | "Milo na 3k... no no, 3,500"; groundnut oil "tree tousand... no wait, tree tousand two hundred" | Final value used in all 4 runs (3,500 and 3,200) |
| Group prices | "All the Ankara na 12k each"; phone cases "all of them na tree tousand each" | Applied to both Ankara items and the cases in all runs |
| Shorthand | 1.8, four-two, six-five, two-five, one five, one-six, five-eight | All correct |
| Distractor numbers | 20,000 mAh, 75cl, one litre | Never used as prices |
| Figure of speech | "no be ten ten naira market" | Ignored: no stray prices in any run |
| Reduplication | "one-fifty one-fifty" | Correct (150) |
| Pointing words needing the photo | "the small speaker, the red one for top" | Correct |

The two misses were both transcription errors, and Muse Spark faithfully used what it was given:

- Stall 4, plain: garri "na 3k paint" was heard as "three three k", priced 3,300 (should be 3,000).
- Stall 5, keywords: "hundred hundred naira" was heard as "nine hundred hundred", priced 900 for a Milo sachet (should be 100).

Both would be caught by a plausibility check (a Milo sachet at 900 when the stall's other sachets are 150) feeding the existing tap-to-confirm step.

Caveats: the voice is British-accented TTS reading Pidgin, so this tests price parsing, not Nigerian accents. The transcripts also turn "na" into "now" or "not" throughout; Muse Spark coped, but real recordings are still the real test. The item list came from the answer key, not from the photo pipeline, so this measures price matching on its own.

## Test 3: Kapso WhatsApp round trip

Not run. I only read Shola's Kapso setup (CLI `kapso` 0.16.0, read-only commands), and nothing was created or sent.

What exists: the Kapso project has two WhatsApp numbers. One is the **E'Manuel Bakery production number, a client's number, which StallSnap must never use.** The other is the shared **Kapso Sandbox** number; its last 100 messages (April 2026) are all text or interactive, with no images, and it has no webhooks set up.

What the round trip needs, all from Shola:

1. In the Kapso dashboard, WhatsApp, then Sandbox: add his phone as a test number and send the 6-character code from WhatsApp within 15 minutes.
2. A yes to adding a webhook on the Sandbox configuration that points at a public HTTPS URL we run (a small bun server or a Kapso function). This is persistent config on his account, so I have not done it.
3. Project credits for sandbox service messages (Kapso charges these at the recipient's service rate).

One open question: Kapso's sandbox limits table lists text, interactive and template messages, and doesn't mention media. Receiving the photo and voice note should work (inbound media is standard), but an image reply from the sandbox is unconfirmed. This doesn't block the product: the plan already sends the catalogue back as a web link in a text message.

## Calls and spend

From `test-results/cache/ledger.jsonl` (every live call is logged; cached reruns cost nothing). Prices are Meta's Standard-mode prices from dev.meta.ai/docs/pricing-rate-limits, read on 26 Oct.

| Model | Calls | Usage | Cost (USD) |
|---|---|---|---|
| SAM 3.1 | 213 | 213 images | 0.53 |
| Muse Spark 1.3 | 56 | 150,614 input tokens (16,612 cached), 103,374 output | 0.61 |
| Muse Voice Transcribe | 11 | 331 seconds of audio | 0.02 |
| **Total** | **280** | | **about $1.16 (about £0.90)** |

Not in the ledger: one smoke-test call to Muse Spark (a few tokens) and one transcribe request that was rejected with a 400 before any audio was processed.

## Licences

Overlays and crop sheets made from `test-material/real-photos/` are adaptations of CC BY-SA photos and carry the same licence; credits are in `test-material/real-photos/ATTRIBUTION.md`. None of this material may appear in the demo video.
