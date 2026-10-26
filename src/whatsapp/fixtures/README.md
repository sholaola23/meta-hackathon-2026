# WhatsApp webhook fixtures

`meta-doc-*.json` are the example payloads from Meta's webhook reference pages, copied on 26 Oct 2026
(developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages). They contain Meta's
own sample numbers, not real people.

Messy-input variants are built from these in `../test-helpers.ts`.

Once the test number is live, run the server with `WHATSAPP_RECORD=on`. Each payload is saved to `src/whatsapp/.data/recorded/`
with phone numbers, names and media URLs replaced, so it can be copied here as `recorded-*.json` and used as a fixture.
