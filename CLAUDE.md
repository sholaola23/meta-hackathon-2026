# StallSnap (Meta Global AI Developer Hackathon 2026)

Personal project for Olushola, not WorkCrew. Solo, Indie Developer track. Submissions due Wed 4 Nov 9pm ET (2am Thu 5 Nov UK).

Read `docs/judging-and-goals.md` before planning any feature: every feature must move one of the four judging criteria.

## Hard rules
- Only code written after kickoff (Mon 26 Oct) counts. Do not copy code from ResumeRadar or other repos.
- The repo is PUBLIC. Never commit `.env` or any key. The key lives in `.env` as `MODEL_API_KEY`.
- Every model call costs real money (usage alert at £25/month). Cache responses during development and avoid loops of calls.
- Muse Image may only restyle real product cutouts. Never generate products a trader does not stock.
- Test material is synthetic or third-party; never use it in the demo video.
- Use bun, never npm. UK spelling, no em dashes in anything people read.

## Meta Model API
Base `https://api.meta.ai/v1` (OpenAI-compatible, Responses API), default model `muse-spark-1.3`. Check https://dev.meta.ai/docs before using any endpoint.

## How to verify
- API smoke test: the curl in README "Setup" returns HTTP 200.
- Spike test (27 Oct): results are scored against `test-material/stalls.json` and `test-material/voice/answer-key.json`. Thresholds are in `docs/idea-decision.md`.
- Images: never open an image over 2000px on its longest side; check with `sips -g pixelWidth -g pixelHeight` first.
