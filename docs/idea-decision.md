# Idea decision (26 Oct 2026, before kickoff)

Three agents debated over two rounds: one advocate for ResumeRadar Vision, one sceptical judge and one idea generator.

## Verdict: StallSnap, if it passes a day-one test

A Nigerian market trader photographs their stall and sends a Pidgin voice note with prices on WhatsApp. They get back a priced, shareable catalogue.

| Model | Job |
|---|---|
| SAM 3.1 | Cuts out each product on the stall |
| Muse Voice Transcribe | Turns the Pidgin price note into text |
| Muse Spark | Matches the spoken prices to the cutouts; uses tool calls; asks the trader about any item it couldn't price |
| Muse Image | Background and lighting clean-up of the real cutouts only (never invents products) |

Why: all three agents ended up here. It has lower Stage-1 risk, every model does real work, and it can also win the agentic, viral and creative bonus prizes.

## Guardrails
- Photos first; video only if there's time.
- Catalogue sent as a web link over WhatsApp, not the WhatsApp Catalog API (business verification takes too long).
- Tap-to-confirm when a price could match more than one item ("dis one", "the big one").

## Day-one go/no-go test (27 Oct, about 4 hours)
1. SAM 3.1 on 5 real stall photos: at least 70% of the sellable items come out as separate crops.
2. 3 real Pidgin voice notes: at least 80% of the prices land on the right item (tap-to-confirm allowed).
3. Kapso WhatsApp round trip (receive an image, reply with an image) works.

If 1 or 2 fails, or there are no real stall photos by 28 Oct, switch to the fallback.

## Fallback: ResumeRadar Vision, reframed
A "parser's-eye view" for applicants, not recruiters. No match score, and the job description is optional. Fresh code only. The centrepiece is a parser round trip (for example 11/23 facts kept before, 23/23 after), backed by a Muse Spark Open no-invented-facts verifier. Remaining anti-project risk is roughly 15 to 20%.

## Dropped
LedgerLens (POS-agent reconciliation): same "does it actually work" risk as StallSnap, without the demo upside.
