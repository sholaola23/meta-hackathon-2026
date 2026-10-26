# Plan to submission

Written Mon 26 Oct 2026. Dates and times are UK time. The deadline is Wed 4 Nov, 9pm ET, which is 2am Thu 5 Nov in the UK. We aim to submit by 9pm UK on Wed 4 Nov to leave a buffer.

The day-one test passed on 26 Oct with conditions (voice price matching 97% against an 80% bar; SAM cut-outs 76% on real photos with two phrasings per product, against a 70% bar). The plan below turns those conditions into dated work.

## Decisions so far

| Decision | Status |
|---|---|
| Build StallSnap | Go, with the conditions below (26 Oct) |
| WhatsApp route | Meta WhatsApp Cloud API with a free test number, approved 26 Oct. Kapso is no longer planned |
| Fallback | Pending: see "Fallback" below |

## Schedule

| Day | Build | Needs Shola |
|---|---|---|
| Mon 26 Oct | Spike results; spend cap and off switch; build log; this plan. Kickoff livestream 4 to 5pm | Set up the Meta developer app and WhatsApp Cloud API test number (his account) |
| Tue 27 Oct | Pipeline script: photo and voice note in, priced item list (JSON) out. Two phrasings per product, person masks dropped. Fix the answer keys: define "each product" and settle strip vs sachet. Score wrong prices and wrong units separately | |
| Wed 28 Oct | **Real Pidgin voice notes and real stall photos due.** Rerun the accuracy scores on them. Web catalogue page from the JSON. Fallback check 1 (see below) | Real recordings and photos from his contacts, with their consent |
| Thu 29 Oct | Full WhatsApp loop: photo and voice note in, Muse Spark asks back about unpriced items, the trader confirms every price before the catalogue is published, link sent back. Independent QA | |
| Fri 30 Oct | Muse Image clean-up that keeps the real cut-out: the cut-out is pasted back over the restyled background and checked for fidelity. Fallback check 2. Independent QA | |
| Sat 31 Oct | **Feature freeze at the end of the day.** Messy-input test suite; independent whole-system review of main that runs the code against the README | Weekend: review and merge PRs |
| Sun 1 Nov | Fix blocking findings only. Film real stalls and the trader's phone for the demo | Demo filming with a real trader |
| Mon 2 Nov | Demo script and first cut of the 3-minute video. README and build log brought up to date | |
| Tue 3 Nov | Final video. Draft the X post and the submission text | Approve the video, the X post and the submission text (separate yes/no for each public step) |
| Wed 4 Nov | Buffer. Make the repo state final and submit by 9pm UK | Submit (his yes) |

After the freeze, only fixes for blocking findings, the demo and the docs change. New features wait.

## Conditions from the day-one test

| Condition | When | Where it lands |
|---|---|---|
| Two phrasings per product; drop person masks | 27 Oct | Pipeline |
| Real Pidgin voice notes and stall photos | 28 Oct | Shola |
| Trader confirms every price before the catalogue is published | 29 Oct | WhatsApp loop |
| Score wrong prices and wrong units separately | 27 Oct | Scoring |
| Define "each product"; fix strip vs sachet in the answer key | 27 Oct | `test-material/` |
| Muse Image keeps the real product (paste the real cut-out back) | 30 Oct | Image clean-up |
| Full WhatsApp voice and question loop | 29 Oct | WhatsApp loop |
| Feature freeze | 31 Oct | Everyone |
| Hard spend cap and off switch | 26 Oct | `src/spend-guard.ts` |
| Provenance check and dated build log | 26 Oct, then ongoing | `docs/build-log.md` |
| Fallback that reuses the same pipeline | Decision due 27 Oct | Below |

## Fallback

Pending Shola's decision. The proposal is to replace the separate fallback project with fallbacks that reuse the StallSnap pipeline, each with a check date:

- **Check 1 (Wed 28 Oct): SAM on the real stall photos.** If fewer than 70% of products come out as separate cut-outs, switch to one photo per product: the trader sends a few close-up photos, SAM cuts out the main item in each, and the voice note prices them as before.
- **Check 2 (Fri 30 Oct): the WhatsApp loop.** If it isn't working end to end, the trader uses a simple web page instead (take a photo, record a voice note) and gets the same catalogue link.

## Spend

Every paid call goes through the spend cap in `src/spend-guard.ts` (default $2 a day, 60 calls per job, off switch in `.env`). The spike cost about $1.16. Each handoff reports spend so far.
