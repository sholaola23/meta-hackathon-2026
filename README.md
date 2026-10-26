# StallSnap

**Snap your stall, say your prices, get a shop.** A market trader photographs their stall and sends a voice note in Pidgin with the prices. StallSnap sends back a priced catalogue they can share on WhatsApp.

Personal entry for the Meta Global AI Developer Hackathon 2026, Indie Developer track, theme "Build for Your World". All code and documents in this repo were written during the hackathon, which runs from 26 Oct to 4 Nov 2026; the dated [build log](docs/build-log.md) shows what was built when. The one exception is the openly licensed stall photos in `test-material/real-photos/`, which belong to their photographers (see `ATTRIBUTION.md`) and are used only for testing.

> Status: the day-one go/no-go test ran on 26 Oct and passed with conditions. The schedule to submission is in [docs/plan.md](docs/plan.md).

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
| `docs/plan.md` | Dated schedule to submission, with the feature freeze |
| `docs/build-log.md` | Dated record of what was built during the hackathon |
| `src/spend-guard.ts` | Hard spend cap for paid Meta API calls |
| `docs/judging-and-goals.md` | What the hackathon wants, how winners are chosen, and how we aim at it |
| `docs/idea-decision.md` | Why StallSnap, the guardrails, the day-one test and the fallback |
| `test-material/stalls.json` | Answer key: 5 stalls, their items and naira prices |
| `test-material/images/` | Generated stall photos (Muse Image) for the test, with prompts |
| `test-material/real-photos/` | Real openly licensed stall photos (Wikimedia Commons), with attribution |
| `test-material/voice/` | Pidgin price scripts, placeholder voice notes and the price answer key |
| `src/whatsapp/` | The WhatsApp loop on Meta's WhatsApp Cloud API, the adapter that joins it to the image and pricing steps, and the public catalogue page; setup and design in [docs/whatsapp.md](docs/whatsapp.md) |

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

### Spend cap

Every paid Meta API call goes through `SpendGuard.paid()` in `src/spend-guard.ts`. Cached responses never reach it, so reruns stay free. It refuses a call, before the call is made, when:

| Setting in `.env` | Default | What it stops |
|---|---|---|
| `STALLSNAP_PAID_CALLS=off` | `on` | Every paid call (the off switch) |
| `STALLSNAP_MAX_CALLS_PER_JOB` | 60 | Calls past this number in one job (one trader's photo and voice note) |
| `STALLSNAP_DAILY_CAP_USD` | 2 | Any call that would take today's spend (UTC day, on this machine) over the cap |

A value it can't read, a value above the ceiling ($25 a day, 500 calls a job) or a misspelt `STALLSNAP_` setting stops start-up instead of lifting a cap. The daily total is locked and shared by every process on the machine; the per-job count is kept in the process that runs the job. Check today's spend with `bun src/spend-guard.ts`, and run the tests with `bun test src`.

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

Judging (weighted, from the official rules): impact 30% · use of Meta AI tooling 25% · demo 25% · technical depth and execution 20%. Details in `docs/judging-and-goals.md`.

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
