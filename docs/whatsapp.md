# WhatsApp loop

StallSnap talks to traders through Meta's WhatsApp Cloud API, using the free test number that Meta creates with a new app. Kapso is kept only as a fallback; nothing in the code uses it. Decision approved by Shola on 26 Oct 2026.

The code is in `src/whatsapp/`. It has no dependencies beyond Bun.

## What the trader sees

| Trader sends | StallSnap replies |
|---|---|
| A stall photo and a voice note with prices, in either order | "Thank you! I am making your price list now..." then the priced list with three buttons: **Yes, publish**, **Change price**, **Start again** |
| A typed or spoken correction, such as "Peak milk na 650" | A new list with fresh buttons. Buttons on older lists stop working |
| **Yes, publish** | One message with the catalogue link. If an item still has no price, the pricing step first asks once more (see below) |
| A photo only | "Photo received. Now send a voice note with your prices..." (once) |
| A voice note only | "Voice note received. Now send a photo of your stall..." (once) |
| A photo and typed prices, no voice note | Treated like a voice note: the typed prices are used |
| A greeting or other text before a photo | The welcome message |

Every message StallSnap writes is in `src/whatsapp/copy.ts`. The priced list text, and the "reply YES again" check for unpriced items, come from the pricing module.

WhatsApp allows one message every 6 seconds to the same person (error 131056). The outbox spaces messages 6 seconds apart and retries after 1, 4 and 16 seconds on 131056. So the catalogue goes back as one link, never as a burst of images.

## How it works

1. **Webhook** (`webhook.ts`). `GET /webhook` answers Meta's verify handshake. Every `POST /webhook` must carry a valid `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret), or it is refused with 401. The server answers 200 at once and does the work afterwards, so Meta does not retry.
2. **Parse** (`events.ts`). Only `messages` changes for our phone number id are read. Status receipts are dropped. Messages in one webhook are sorted by their timestamp.
3. **Filter** (`conversation.ts`). Numbers not in `WHATSAPP_ALLOWED_NUMBERS` are ignored: no reply, no download, no model call. Message ids already handled are skipped, so a webhook delivered twice is handled once. The ids are kept on disk, so this holds across a restart.
4. **Download** (`media.ts`). Two steps, as Meta documents: the media id gives a URL that lasts 5 minutes, then the URL is fetched with the token. The type and size are checked before downloading, and the bytes are checked against WhatsApp's SHA-256. An expired URL (404) is fetched again once.
5. **Collect, then start.** Photos and voice notes arrive as separate webhooks. The loop waits 5 seconds after the last one, then calls the pipeline once with every photo and voice note.
6. **Confirm or correct.** Each reply to the list goes to the pricing step. A reply that arrives while a list is still being made is applied before any list is shown, so the trader never confirms a list they have already corrected.
7. **Publish.** When the pricing step says the trader has confirmed the latest list, the catalogue page is built and its link is sent.

## Limits the loop sets itself

These stop the loop from running up model costs on its own. The spend cap in `src/spend-guard.ts` sits underneath them.

| Limit | Value | What happens past it |
|---|---|---|
| Photos per catalogue | 3 | The rest are not downloaded; the trader is told once |
| Voice notes per catalogue | 3 | Same |
| Corrections per catalogue | 8 | No more model calls; **Yes, publish** and **Start again** still work |
| Photo size | 5 MB (WhatsApp's own limit) | "That photo is too big" |
| Voice note size | 2 MB (well over 10 minutes of WhatsApp voice) | "That voice note is too long" |
| Photo types | JPEG, PNG | WebP, HEIC and others are refused |
| Audio types | OGG with Opus (WhatsApp voice notes), MP3, M4A, AAC, AMR | Plain OGG without Opus, WAV and others are refused |

When the spend cap stops a call (a `SpendCapError`), the trader gets "StallSnap is paused for now" and the catalogue is dropped. When the image step refuses a photo (a `PhotoError`), its message, which is written for the trader, is sent as it is. Any other failure gets "Sorry, something went wrong... Please send your photo and voice note again."

## Interface with the rest of StallSnap

The loop calls an implementation of `Pipeline` in `src/whatsapp/pipeline.ts`:

- `start({traderId, jobId, photos, voiceNotes, texts})` returns `{version, message, confirmed}`.
- `reply({traderId, jobId, reply})`, where `reply` is `{text}` or `{voiceNote}`, returns the same shape. **Yes, publish** is sent as the text `YES`.
- `publish({traderId, jobId})` returns `{url}`.

`jobId` is one per catalogue. Pass it to `SpendGuard.paid()` so the per-job call cap applies.

PENDING: the adapter that joins this to the image pipeline, the pricing module and the catalogue page. Until it exists, `server.ts` uses a stand-in that fails every job, and the trader is told "something went wrong". It never invents a list.

## Setup (Shola only, about 20 minutes)

Claude cannot do these steps: they need your Meta account. Never use the E'Manuel Bakery number or its accounts. Keep every token out of chat.

1. Register as a Meta developer at developers.facebook.com, then create an app with the **Connect with customers through WhatsApp** use case.
2. When asked for a business portfolio, create a **new** one called StallSnap.
3. Open **WhatsApp > API Setup**. Note the test number's **Phone number ID**. Add your own phone as a **To** number, send the test message, and reply to it from your phone.
4. Create a permanent token: **Business Settings > System users > Add**, assign the app and the WhatsApp account with full control, then **Generate token** with `whatsapp_business_messaging` and `whatsapp_business_management`.
5. Copy the **App secret** from **App settings > Basic**.
6. Put these in `.env` on your Mac (never commit it):

   ```bash
   WHATSAPP_TOKEN=            # the system user token from step 4
   WHATSAPP_PHONE_NUMBER_ID=  # from step 3
   WHATSAPP_APP_SECRET=       # from step 5
   WHATSAPP_VERIFY_TOKEN=     # any long random string you make up
   WHATSAPP_ALLOWED_NUMBERS=  # your number and test traders', comma separated, for example 447700900123
   # Optional: WHATSAPP_GRAPH_VERSION (default v26.0), WHATSAPP_RECORD=on, WHATSAPP_DATA_DIR, PORT (default 3000)
   ```

7. Start the server and a public HTTPS tunnel to it:

   ```bash
   set -a; . ./.env; set +a
   bun run src/whatsapp/server.ts
   # in a second terminal (brew install cloudflared first); prints an https://....trycloudflare.com address
   cloudflared tunnel --url http://localhost:3000
   ```

8. In **WhatsApp > Configuration**, set the **Callback URL** to the tunnel address plus `/webhook`, and the **Verify token** to your `WHATSAPP_VERIFY_TOKEN`. Click **Verify and save**, then subscribe to the **messages** field.
9. Send the test number a photo and a voice note from your phone.

A quick tunnel gets a new address every time it starts, so repeat step 8 after a restart.

## Testing

```bash
bun test src/whatsapp
```

The tests use no network and no model calls. The messy-input suite (`loop.test.ts`) covers: no caption, image only, voice only, two and five photos, huge files, unsupported audio and image types, photos sent as documents, video and stickers, duplicate webhooks, replies and taps out of order, stale buttons, restarts mid-job, the spend cap and pipeline failures. `edges.test.ts` covers the verify step, the signature check, Meta's documented payloads, the Graph requests, the 6-second pacing and every message text.

With `WHATSAPP_RECORD=on`, each real webhook is saved to `src/whatsapp/.data/recorded/` with numbers, names and media URLs replaced, ready to copy into `src/whatsapp/fixtures/` as a new test.

Sources (read 26 Oct 2026): Meta's [Cloud API get started](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started), [webhook messages reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages), [media](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media), [reply buttons](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages) and [rate limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform).
