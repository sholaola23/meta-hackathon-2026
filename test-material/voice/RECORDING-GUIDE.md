# Recording the Pidgin voice notes

These five scripts test whether speech-to-text plus an LLM can match spoken prices to the right items on each stall. Please record each one in your own voice.

## Important: the TTS files are placeholders

The `*-tts.ogg` files in this folder were made with the macOS "Daniel" voice, which is British English. They only test the price parsing (shorthand, corrections, group prices). They do not test a Nigerian accent or real Pidgin pronunciation. Your recordings are the real test.

## How to record

1. Open a script, for example `stall-1-provisions.txt`, and read it through once.
2. Record it as a WhatsApp voice note (send it to yourself, or to a "Notes" group with just you in it) or with Voice Memos on iPhone.
3. Talk the way a Lagos trader talks to a customer: relaxed, normal speed, a bit of background noise is fine. You do not have to read word for word. Keep every price and every correction, and keep the pointing words ("dis one", "the red one for top").
4. Read shorthand the natural way: "1.8" as "one-eight" or "one point eight", "12k" as "twelve k", "2.5" as "two-five" or "two point five".
5. Keep each note between 20 and 45 seconds.
6. Do not price an item that the script leaves out. Stall 3 never prices the screen protector and stall 5 never prices the sugar cubes. That is on purpose.

## Getting the files off your phone

- WhatsApp: open the chat, long-press the voice note, tap Forward or Share, and save it to Files or AirDrop it to the Mac. It will be an `.ogg` or `.opus` file.
- Voice Memos: tap the memo, then Share, then AirDrop or Save to Files. It will be an `.m4a` file. That is fine.

## File names and where to put them

Name each file after its stall, with `-real` on the end, and keep whatever extension the phone gives you:

- `stall-1-provisions-real.ogg`
- `stall-2-fabrics-real.ogg`
- `stall-3-phone-accessories-real.ogg`
- `stall-4-foodstuff-real.ogg`
- `stall-5-mixed-cluttered-real.ogg`

Put them in `test-material/voice/`, next to the scripts. If you record a second take, add `-2` (for example `stall-4-foodstuff-real-2.ogg`).

The expected answers for every stall are in `answer-key.json`.
