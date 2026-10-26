# What the hackathon wants, and how we aim at it

Sources: the participant guide (cerebralvalley.ai/e/meta-ai-developer-hackathon/details) and the Discord `#rules` and `#faqs`, read 26 Oct 2026. If they change, update this file.

## The end goal

A **working product, shown in a 3-minute demo video**, with a public repo. Judges look at the video, the code and the live product, so it must genuinely work, not be a slideshow.

## What we submit (by Wed 4 Nov, 9pm ET = 2am Thu 5 Nov UK)

- [ ] A public repo with the code
- [ ] A 3-minute demo video (a main scoring input; it must be good to watch, not just a screen recording)
- [ ] The names of everyone who worked on it (solo: just Olushola)
- [ ] Optional: a link to a post on X, for the Most Viral prize

Submit at https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit. Late entries aren't considered.

## Rules that can disqualify us

- **Only new work counts:** everything is built between 26 Oct and 4 Nov. Keep `docs/build-log.md` dated.
- **The video shows only what was built during the event.** If judges can't tell what's new, the project is disqualified.
- **Meta's models must be used in a meaningful way.**
- **Theme fit:** StallSnap = "Build for Your World".
- **No banned types:** medical advice, basic RAG apps, simple image analysers, education chatbots, job screeners, nutrition coaches, personality analysers, sports coaches, politics or war.
- **No code, data or assets we don't have the rights to.** Generated test photos and the CC BY-SA test photos stay out of the demo.
- **One track:** Indie Developer.

## How winners are chosen

1. **Stage 1, pass or fail:** fits the theme and really uses Meta's models. No partial credit.
2. **Stage 2, scored 0 to 10 on four equally weighted criteria:**

| Criterion | What judges ask | How StallSnap scores |
|---|---|---|
| Impact | Who benefits, how much, would people use it? | Real traders, real WhatsApp flow; show a trader actually getting a usable catalogue |
| Use of Meta AI tooling | Creative, beyond basic integration; "surprised even us" | Four models in a chain, each doing something only it can: SAM cutouts, Pidgin transcription, Spark agent with tool calls that asks the trader back, Image clean-up |
| Technical depth | Sound, carefully built engineering | Price-to-item matching, corrections, group prices, unpriced-item follow-up; measured accuracy against the answer keys |
| Demo | Works, holds up live, good to watch | Messy stall photo + voice note in, priced catalogue out on a real phone, inside the first minute |

3. **Finals:** the top 5 per track go to a live round on Mon 9 Nov; judges watch the videos and rank them with the same criteria.

## Prizes

- **Indie track:** $150K / $100K / $75K / $50K / $25K.
- **Bonus prizes** (can be won alongside a track prize):

| Prize | How it's won | Are we aiming at it? |
|---|---|---|
| Most Viral on X, $20K | Engagement on the demo post up to 8 Nov | Yes: a before/after stall clip |
| Community Vote, $10K | Public vote from 9 Nov | Yes |
| Best Agentic Use-Case, $5K | Autonomy, effectiveness, usefulness | Yes: the Spark agent that asks the trader back |
| Best Creative Build, $5K | Good use of Muse Image or Wonder | Maybe: Image clean-up only |
| Best Open Weight build, $10K | Built on Muse Glimmer or Spark Open | Not currently |

## How this shapes the work

- Every feature has to move at least one of the four criteria. If it doesn't, cut it.
- **Working beats wide:** one flow that works reliably end to end (photo + voice note in, catalogue out on WhatsApp) beats many half-built features.
- **Show each model visibly doing its job** in the video. Judges score the tooling from what they can see.
- **Measure and show accuracy** (items cut out correctly, prices matched correctly) for the technical-depth score.
- **Plan:** build 27 to 31 Oct; leave 1 to 4 Nov for polish, real stall footage, the demo video, the X post and the submission text.
- **The demo uses real stalls and real voice notes** from Olushola's contacts, never test material.
