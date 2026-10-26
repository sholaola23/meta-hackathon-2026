# What the hackathon wants, and how we aim at it

Sources: the participant guide (cerebralvalley.ai/e/meta-ai-developer-hackathon/details) and the Discord `#rules` and `#faqs`, read 26 Oct 2026. The criteria weights were rechecked against the official rules on the event page (section "How Applications are Reviewed") at 11:21 UTC on 26 Oct. If they change, update this file.

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
2. **Stage 2, scored on four weighted criteria.** The weights below are quoted from the official rules:

| Criterion | Weight | What the rules say | How StallSnap scores |
|---|---|---|---|
| Impact | 30% | "the real-world potential of the Project, who benefits, how much it matters, whether it could become something people use, and whether it fits one of the problem statements" | Real traders and a real WhatsApp flow. Show one named trader getting a catalogue they can use. Theme: "Build for Your World" |
| Use of Meta AI tooling | 25% | "how creatively the team used Meta's AI tooling, whether they went beyond a basic integration, and whether they surfaced unexpected capabilities" | Four models in a chain, each doing a job only it can do: SAM cut-outs, Pidgin transcription, a Spark agent whose tool calls match prices and ask the trader back, and Image clean-up that keeps the real product |
| Demo | 25% | "whether the Project has a working, impressive demo, whether the product holds up live, and the quality of the demo video" | A messy stall photo and a voice note go in, and a priced catalogue comes back on a real phone, in the opening seconds |
| Technical depth and execution | 20% | "whether the engineering is sound and thoughtfully refined and the Project demonstrates real craft" | Price-to-item matching, corrections, group prices and follow-up on unpriced items, with accuracy measured against answer keys |

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
- **Weigh work by the weights.** Impact (30%) and the demo (25%) together are over half the score, and Meta AI tooling is another 25%. When two tasks compete, pick the one that makes the trader's result more real or more visible on screen. Technical depth (20%) still counts, and it shows best as a measured accuracy number.
- **Go beyond a basic integration.** The tooling criterion asks for "unexpected capabilities", so show what the chain does that one model call can't: Spark choosing tools, checking SAM's cut-outs and asking the trader back.
- **Working beats wide:** one flow that works reliably end to end (photo + voice note in, catalogue out on WhatsApp) beats many half-built features.
- **Show each model visibly doing its job** in the video. Judges score the tooling from what they can see.
- **Measure and show accuracy** (items cut out correctly, prices matched correctly) for the technical-depth score.
- **Plan:** build 27 to 31 Oct; leave 1 to 4 Nov for polish, real stall footage, the demo video, the X post and the submission text.
- **The demo uses real stalls and real voice notes** from Olushola's contacts, never test material.
