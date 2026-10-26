# StallSnap

**Snap your stall, say your prices, get a shop.** A market trader photographs their stall and sends a voice note in Pidgin with the prices. StallSnap sends back a priced catalogue they can share on WhatsApp.

Personal entry for the Meta Global AI Developer Hackathon 2026, Indie Developer track, theme "Build for Your World". Everything in this repo was built during the hackathon (26 Oct to 4 Nov 2026).

> Status: the day-one go/no-go test runs on 27 Oct. If it fails, the fallback idea is in [docs/idea-decision.md](docs/idea-decision.md).

## How it works

| Step | Meta model | What it does |
|------|-----------|--------------|
| 1 | SAM 3.1 | Cuts out each product on the stall photo |
| 2 | Muse Voice Transcribe | Turns the Pidgin price note into text |
| 3 | Muse Spark | Matches spoken prices to the cutouts with tool calls, and asks the trader about anything it couldn't price |
| 4 | Muse Image | Cleans the background and lighting of the real cutouts only (it never invents products) |

The catalogue goes back as a web link over WhatsApp.

## Repo layout

| Path | What is in it |
|------|---------------|
| `docs/judging-and-goals.md` | What the hackathon wants, how winners are chosen, and how we aim at it |
| `docs/idea-decision.md` | Why StallSnap, the guardrails, the day-one test and the fallback |
| `test-material/stalls.json` | Answer key: 5 stalls, their items and naira prices |
| `test-material/images/` | Generated stall photos (Muse Image) for the test, with prompts |
| `test-material/real-photos/` | Real openly licensed stall photos (Wikimedia Commons), with attribution |
| `test-material/voice/` | Pidgin price scripts, placeholder voice notes and the price answer key |

Test material is for the spike test only. The demo will use real stalls and real voice notes.

## Setup

```bash
cp .env.example .env   # then paste your Meta Model API key
set -a; . ./.env; set +a
curl -s https://api.meta.ai/v1/responses \
  -H "Authorization: Bearer $MODEL_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"muse-spark-1.3","input":"Reply with: ready"}'
```

Never commit `.env`. It is listed in `.gitignore`.

## Meta Model API

- Base URL: `https://api.meta.ai/v1` (OpenAI-compatible; Anthropic Messages at `https://api.meta.ai`)
- Default model: `muse-spark-1.3`
- Key in env var `MODEL_API_KEY`
- Usage alert: email at £25 a month (set 26 Oct; Meta offers alerts, not a hard cap)
- Muse Code CLI: `curl -fsSL https://dev.meta.ai/install.sh | sh`, then `muse`

## Key dates (UK time)

| What | When |
|------|------|
| Kickoff livestream | Mon 26 Oct, 4pm or 5pm (organisers say both "12pm EST" and "9am PT"; check Discord) |
| Agents 101 / 102 sessions | Tue 27 Oct and Wed 28 Oct, 12pm ET (4pm UK) |
| Fireworks open-models session | Fri 30 Oct, 12pm ET (4pm UK) |
| Discord office hours (weekdays) | 10 to 11am ET (2 to 3pm UK until 30 Oct, 3 to 4pm from 2 Nov) |
| Submissions due | Thu 5 Nov, 2am (Wed 4 Nov 9pm ET) |
| Closing ceremony | Mon 9 Nov, 5pm |

## Rules that shape the build

- Repo must be public at submission.
- Only work done during the event counts; the demo must show only that work.
- Must use Meta models via Meta Model API or the open-weight models.
- Three-minute demo video required.
- Anti-projects include "AI Job Application Screener" and "Simple Image Analyzers".

Judging (equal weight, 0 to 10): impact · use of Meta AI tooling · technical depth and execution · demo.

## From the hackathon Discord (read 26 Oct)

- `#rules`: anything built from 26 Oct to 4 Nov counts. The demo must show only work done during the event, or the project is disqualified. Submit with a public repo, a working demo video link and every team member added.
- `#faqs`: the kickoff is at 12pm ET on 26 Oct. Office hours are in `#office-hours` on weekdays, 10 to 11am ET. Unsure whether an idea is allowed? Ask @CV.
- Credits: the $150 Meta claim form wasn't out yet on 26 Oct (lots of people were asking). Credit questions go only in `#credit-requests`, one post per question, tagged with the partner. Never share keys or card details there.
- `#faqs` warns that a spend-limit notification does **not** stop billing; spending beyond the credits is charged to the card.
- Use Baseten model ID `meta-models/muse-spark-open-1026`.

## Links

- Participant guide: https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details
- Discord: https://cerebralvalley.ai/e/meta-ai-developer-hackathon/discord
- Submit: https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit
- Docs: https://dev.meta.ai/docs/overview · Quickstart: https://dev.meta.ai/docs/quickstart · Models: https://dev.meta.ai/docs/models
- Cookbook: https://github.com/meta-models/meta-model-cookbook
- Baseten credits form: https://docs.google.com/forms/d/e/1FAIpQLSfM7gcK8yMZEmAGq6DbTyiuv2c71IH7CKCy0fXGIfUED1qxVQ/viewform (use model `meta-models/muse-spark-open-1026`)
- Modal credits form: https://docs.google.com/forms/d/e/1FAIpQLSe_GDPtLZsdA57xPhFcOCi_yLjPf8HRxMIQJ5V7ystoKSqWCQ/viewform

## Licence

MIT. Third-party photos in `test-material/real-photos/` keep their own licences, listed in `ATTRIBUTION.md`.
