# Pricing rules

How StallSnap turns a trader's voice note into prices, and why no price reaches a catalogue until the trader has confirmed it. The code is in `pricing/`.

## What "each product" means

A **catalogue line** is one thing a customer can point at and buy at one price. Every line has a **sale unit**: what one price buys.

| Rule | Example |
|---|---|
| The unit is what the trader sells for the price they say, not how the goods are displayed. | Milo sachets hang in strips, but "hundred hundred naira, one one" is 100 per **sachet**. The line is "Milo sachet", unit `sachet`. |
| If the trader prices the whole strip, bag or crate, that is the unit. | "The strip na 1,000" is unit `strip`; "egg, one crate, na five-eight" is unit `crate`. |
| Measured goods use the measure. | "Rice na 6k for one paint" is unit `paint bucket`; "crayfish, small cup" is unit `cup`. |
| Fabric is priced per piece of the length the trader names, unless they say per yard. | "Ankara, six yards, 12k each" is unit `piece`. "Lace na 7k per yard" is unit `yard`. |
| A group price applies to every item in the group, each at that price. | "All the Ankara na 12k each" prices both Ankara lines at 12,000 per piece. |
| The same product at two prices (big and small tin) is two lines. | "Peak milk, the big tin, na 1.8" prices only the big tin. |
| The same product said twice is one line; the last price said wins. | "Milo na 3k... no no, 3,500" is 3,500. |

The allowed units are listed in `pricing/src/types.ts` (`SALE_UNITS`). Prices are whole naira. A price with kobo, a range ("two to two-five"), a placeholder ("N/A") or anything outside 10 to 5,000,000 naira is never kept: the line becomes unpriced and the trader is asked.

## The confirm step

No price is published until the trader has seen it and said yes.

1. Muse Spark reads the transcript and calls `set_price` (with a unit and the quote), `flag_missing_price` and `ask_trader`. `applyToolCalls` turns these into a draft and refuses anything invalid.
2. `startConfirmation` gives the trader a numbered list: each price with its unit, and "NO PRICE" plus a Pidgin question for anything unpriced.
3. The trader replies. `handleReply` understands:
   - `YES` (also "ok", "correct", "na so", "confam" and similar)
   - a change by number: `2 na 1800`, `2 = 1,800`, `2: 1.8k`, `6 na 100 per sachet`
   - a change by name: `Milo na 3600` (only if the name matches one item)
   - a correction inside the reply: `2 na 1800 no 1900` (the last value wins)
   - removing a line: `comot 3`, `remove 3`, `3 don finish`
4. Any change makes a new version of the list, which is sent again. Only a reply that is just a yes, to the latest list, confirms it.
5. If any part of a reply can't be understood, nothing in it is applied and the trader is asked again.
6. If anything is still unpriced, the first yes gets one more message naming those items and repeating the questions. A second yes publishes them as "Ask for price", never with a number.
7. `publish` throws unless the session is confirmed. It is the only way to get a catalogue.

The confirm step is channel-agnostic: it takes reply text and returns message text. WhatsApp wiring lives in its own thread.

## How prices are scored

A wrong price is worse than a missing one: a missing price makes the system ask, a wrong price can be sold at. So the scorer (`pricing/src/score.ts`) reports these separately for every run:

| Count | Meaning |
|---|---|
| correct | right price and right unit |
| wrong price | a price that differs from the answer key (the worst outcome) |
| wrong unit | right number, wrong unit (for example per strip instead of per sachet) |
| missing | the trader gave a price but none was recorded (the system asks again) |
| unpriced flagged | an item the trader didn't price was flagged and asked about |
| invented | a price recorded for an item the trader never priced (must be 0) |
| rejected calls | tool calls refused as invalid (unknown item, unreadable price) |

The headline match rate is correct prices over priced items, as in the day-one test. Then a simulated trader replies to the confirm message with corrections from the answer key and a yes, and the published catalogue must match `test-material/stalls.json` exactly: zero wrong prices published.

## Tests

- `pricing/tests/messy-inputs.json`: the messy-input suite (O for 0, "N/A", kobo, ranges, duplicates, mid-note corrections, unknown items, unclear replies). Add every new QA attack here; CI runs it on every PR.
- `test-material/voice/recorded/`: recorded Muse Spark tool calls. CI replays them through the draft, the scorer and the confirm step, with no API calls.
- `bun run eval` (in `pricing/`, needs `MODEL_API_KEY`): runs Muse Voice Transcribe and Muse Spark on every voice note in `test-material/voice/` and on `test-material/voice/messy-transcripts.json`, caches each response, and writes new recordings. Real recordings named `<stall>-real.<ext>` (see `test-material/voice/RECORDING-GUIDE.md`) are picked up automatically, so they join the CI suite once recorded.
