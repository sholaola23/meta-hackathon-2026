# WhatsApp loop

StallSnap talks to traders through Meta's WhatsApp Cloud API, using the free test number that Meta creates with a new app. Kapso is kept only as a fallback; nothing in the code uses it. Decision approved by Shola on 26 Oct 2026.

The code is in `src/whatsapp/`. It has no dependencies beyond Bun.

## What the trader sees

| Trader sends | StallSnap replies |
|---|---|
| A stall photo and a voice note with prices, in either order | "Thank you! I am making your price list now..." then the priced list with three buttons: **Yes, publish**, **Change price**, **Start again** |
| A typed or spoken correction, such as "Peak milk na 650" | A new list with fresh buttons. Buttons on older lists stop working |
| **Yes, publish** | One message with the catalogue link, as an **Open catalogue** button and as text the trader can forward. If an item still has no price, the pricing step first asks once more (see below) |
| A photo only | "Photo received. Now send a voice note with your prices..." (once) |
| A voice note only | "Voice note received. Now send a photo of your stall..." (once) |
| A photo and typed prices, no voice note | Treated like a voice note: the typed prices are used |
| A greeting or other text before a photo, including off-topic chat | The welcome message, which says StallSnap only makes price catalogues |

While the models work, the trader sees "typing..." (WhatsApp shows it for up to 25 seconds, or until the next message).

StallSnap is presented as a catalogue builder, never as an AI assistant or chatbot: WhatsApp's Business policy bars businesses whose main product is a general chatbot. It does not answer off-topic questions.

Every message StallSnap writes is in `src/whatsapp/copy.ts`. The priced list text, and the "reply YES again" check for unpriced items, come from the pricing module.

WhatsApp allows one message every 6 seconds to the same person (error 131056). The outbox spaces messages 6 seconds apart. It retries after 1, 4 and 16 seconds on rate limits (131056, 130429, 80007), Meta server errors (HTTP 5xx) and network failures; other errors are logged without the token. If Meta refuses a richer message outright, a plainer one goes in its place: the catalogue link as plain text instead of a button, and the price list without its header image. So the catalogue goes back as one link, never as a burst of images.

## How it works

1. **Webhook** (`webhook.ts`). `GET /webhook` answers Meta's verify handshake. Every `POST /webhook` must carry a valid `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret), or it is refused with 401. The server answers 200 at once and does the work afterwards, so Meta does not retry.
2. **Parse** (`events.ts`). Only `messages` changes for our phone number id are read. Status receipts are dropped. Messages in one webhook are sorted by their timestamp.
3. **Filter** (`conversation.ts`). Numbers not in `WHATSAPP_ALLOWED_NUMBERS` are ignored: no reply, no download, no model call. Message ids already handled are skipped, so a webhook delivered twice is handled once. The ids are kept on disk, so this holds across a restart.
4. **Download** (`media.ts`). Two steps, as Meta documents: the media id gives a URL that lasts 5 minutes, then the URL is fetched with the token. The type and size are checked before downloading, and the bytes are checked against WhatsApp's SHA-256. An expired URL (404) is fetched again once.
5. **Collect, then start.** Photos and voice notes arrive as separate webhooks. The loop waits 5 seconds after the last one, then calls the pipeline once with every photo and voice note.
6. **Confirm or correct.** Each reply to the list goes to the pricing step. A reply that arrives while a list is still being made, or after **Yes, publish** but before the answer, is applied before any list is shown or published, so a list the trader has corrected is never published. Photos and voice notes sent while the catalogue is being published are not used; the trader is asked to wait.
7. **Publish.** When the pricing step says the trader has confirmed the latest list, the catalogue page is built and its link is sent. A list with every line removed is never published. Pictures go on the page as 320px WebP copies, named by item and list version.
8. **Correct after publishing.** A message with a number or a change word ("comot", "remove", "rename") after the link went out reopens the list. The page stays at the same link but shows "The trader is updating these prices" with no prices until the trader says yes again, then it is rebuilt with the new list. Any other message gets a short help reply.
9. **Restart.** State is kept in `src/whatsapp/.data/state.json`. On start-up, a trader who had sent their photo and voice note gets their list as normal, a trader who had said yes gets their catalogue published, and a trader who was replying to a list gets that list again, with the reply they were waiting on applied if pricing never got it (a lost YES is not replayed; they press yes again). A page left showing "updating" is put right at their next yes. A trader whose first list was still being made is told "something went wrong" and asked to send again. A damaged state file is logged and replaced with an empty one.

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

The adapter wraps each paid step in `JobLog.step(jobId, key, run)` from `src/whatsapp/joblog.ts`, with a key like `cutout:<wamid>` or `transcript:<wamid>`. A retried webhook or a restart then reuses the finished step instead of paying again. Run one server process per log folder. The job id allows only letters, digits, `_` and `-`, so the WhatsApp message id goes in the key, never in the job id. Keep the log folder out of git, because it holds transcripts.

### The adapter

`StallPipeline` in `src/whatsapp/adapter.ts` is that implementation. `live-models.ts` gives it the real model calls, and tests give it fakes.

1. **Photos.** Each photo goes through the image step (`image/`): it is prepared, cut out with SAM 3.1, and its crops are reviewed by Muse Spark. Every product gets a catalogue picture made from its own pixels. Products from all the photos form one numbered list. A photo with no products, or one the image step can't read, gets a message the trader can act on.
2. **Voice notes.** Each note goes through Muse Voice Transcribe, using the stall's item names as keywords. Typed prices and captions are added to the text.
3. **Prices.** Muse Spark prices the items with the pricing tool loop (`src/pricing/extract.ts`). `startConfirmation` turns the result into the trader's list.
4. **Replies.** Every reply, typed or spoken, goes to `handleReply`, and its message goes back to the trader as it is.
5. **Publish.** `publish()` refuses anything the trader hasn't confirmed. The confirmed lines and their pictures are written to `<WHATSAPP_DATA_DIR>/public/<slug>/`. Each picture can first get a Muse Image studio backdrop, which is used only if the real product pixels survive (`image/catalogue-image.ts`); set `CATALOGUE_RESTYLE=off` to skip that step. The same server serves the page at `/c/<slug>`. The slug is random, so the link doesn't reveal the trader's number. The audit log (`auditLog`) is saved privately next to the job, never on the page.

Each paid step runs once per job through the job log: the cut-out of a photo, the transcript of a note, the pricing run and the restyle of a picture. Every paid call goes through `SpendGuard`.

The server uses the adapter only when `MODEL_API_KEY` and `PUBLIC_BASE_URL` are set. Without them it falls back to a stand-in that fails every job, so the trader is told "something went wrong". It never invents a list.

To try the live pipeline without WhatsApp, on test material only: `bun src/whatsapp/try.ts <photo.jpg> <note.ogg> [--restyle] [--out <dir>]`. On 26 Oct it found all 6 stall-1 products and priced each one as the answer key does, in 107 seconds for $0.12.

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
   MODEL_API_KEY=             # already there for the Meta Model API
   PUBLIC_BASE_URL=           # the tunnel or Railway address, for catalogue links, for example https://....trycloudflare.com
   # Optional: WHATSAPP_GRAPH_VERSION (default v26.0), WHATSAPP_RECORD=on, WHATSAPP_DATA_DIR, PORT (default 3000),
   # CATALOGUE_RESTYLE=off (skip Muse Image backdrops)
   ```

7. Install the image step's packages once (`cd image && bun install`, then the same in `spike/`; ffmpeg must be installed too). Then start the server and a public HTTPS tunnel to it:

   ```bash
   set -a; . ./.env; set +a
   bun run src/whatsapp/server.ts
   # in a second terminal (brew install cloudflared first); prints an https://....trycloudflare.com address
   cloudflared tunnel --url http://localhost:3000
   ```

8. In **WhatsApp > Configuration**, set the **Callback URL** to the tunnel address plus `/webhook`, and the **Verify token** to your `WHATSAPP_VERIFY_TOKEN`. Click **Verify and save**, then subscribe to the **messages** field.
9. Send the test number a photo and a voice note from your phone.

A quick tunnel gets a new address every time it starts, so repeat step 8 after a restart, and update `PUBLIC_BASE_URL` too. Links already sent keep the old address and stop working.

The test number can message only the phones added as recipients in step 3. Research on 26 Oct put the limit at 5; Meta's get-started page doesn't state it.

### Hosting for the demo and the live final

Shola's Mac with a tunnel is for development. For the demo and the live final on 9 Nov, run the same server on **Railway** (recommended) so it doesn't depend on the Mac staying awake:

- The server is one long-running Bun process (`bun run src/whatsapp/server.ts`) with timers and a state file, so it needs a host that keeps a process running. Railway does; Vercel's serverless functions stop after each request, so the loop would need rework to run there.
- Add a Railway volume and point `WHATSAPP_DATA_DIR` at it, so state and media survive redeploys.
- Set the `WHATSAPP_*` values as Railway variables, never in the repo.
- Don't use AWS.

Creating the Railway account and project is Shola's step.

## Design choices

- **One list, one confirm.** The trader checks the whole priced list in one message and taps **Yes, publish**, rather than confirming each item with its own Yes / Change / Skip buttons and cut-out picture. A stall has 10 to 30 items, and WhatsApp allows one message every 6 seconds per person, so item-by-item confirmation would take 1 to 3 minutes of messages. One list also matches the pricing module's design. The pipeline can still put one image above the list (`headerImageUrl`, for example the cleaned stall cut-outs).
- **"voice" message type.** Meta's webhook reference sends voice notes as type `audio` with `voice: true`. The loop accepts a separate `voice` type too, in case a client sends one.

## Testing

```bash
bun test src/whatsapp
```

The tests use no network and no model calls. The messy-input suite (`loop.test.ts`) covers: no caption, image only, voice only, two and five photos, huge files, unsupported audio and image types, photos sent as documents, video and stickers, duplicate webhooks, replies and taps out of order, stale buttons, restarts mid-job, the spend cap and pipeline failures. `edges.test.ts` covers the verify step, the signature check, Meta's documented payloads, the Graph requests, the 6-second pacing and every message text.

With `WHATSAPP_RECORD=on`, each real webhook is saved to `src/whatsapp/.data/recorded/` with numbers, names and media URLs replaced, ready to copy into `src/whatsapp/fixtures/` as a new test.

Sources (read 26 Oct 2026): Meta's [Cloud API get started](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started), [webhook messages reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages), [media](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media), [reply buttons](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages) and [rate limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform).
