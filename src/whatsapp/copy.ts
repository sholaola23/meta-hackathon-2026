// Every message StallSnap itself writes to a trader is here, so all of them can be read and tested in one place.
// The priced list and its questions come from the pricing module; this file wraps them.
// Plain, short English: traders read these on a phone at the stall.
import type { Button, Outgoing } from "./graph";

const text = (body: string): Outgoing => ({ type: "text", body });

export const LIMITS = { photos: 3, voiceNotes: 3, repliesPerList: 8, buttonBody: 1024, textBody: 4096, buttonTitle: 20 };

export const copy = {
  // StallSnap is a catalogue builder, not a general chat service (WhatsApp Business policy): this is also the reply to off-topic chat.
  welcome: text(
    "Welcome to StallSnap! I make a price catalogue for your stall, and that is all I can help with. Send me a photo of your stall, then a voice note saying the price of each thing. I will send back a price list for you to check.",
  ),
  gotPhotoNeedVoice: text("Photo received. Now send a voice note with your prices, for example: \"Indomie na 250, Peak milk na 600\"."),
  gotVoiceNeedPhoto: text("Voice note received. Now send a photo of your stall so I can see the things you are selling."),
  working: text("Thank you! I am making your price list now. It takes about a minute."),
  changePrompt: text(
    "Tell me what to change. Type it or send a voice note, for example: \"Peak milk na 650\" or \"remove the Milo\".",
  ),
  tooManyPhotos: text(`I can use up to ${LIMITS.photos} photos for one price list. I will use the first ${LIMITS.photos}.`),
  tooManyVoiceNotes: text(`I can use up to ${LIMITS.voiceNotes} voice notes for one price list. I will use the first ${LIMITS.voiceNotes}.`),
  stillWorking: text("I am still working on your price list. Please wait for it, then reply."),
  photoWhileChecking: text(
    "You have a price list waiting for you to check. Tap \"Yes, publish\" or reply with a change. To start a new list with this photo, tap \"Start again\" first.",
  ),
  staleButton: text("That button is on an older list. Please use the buttons on the newest list."),
  tooManyReplies: text("That is a lot of changes for one list. Tap \"Yes, publish\" if it is right, or \"Start again\" to begin a new one."),
  startedAgain: text("OK, starting again. Send me a photo of your stall and a voice note with your prices."),
  fileTooBig: text("That file is too big for me. Please send a photo of your stall and a short voice note."),
  imageTooBig: text("That photo is too big for me. Please send it again as a normal WhatsApp photo, not as a document."),
  audioTooBig: text("That voice note is too long for me. Please send a shorter one."),
  unsupportedAudio: text("I could not play that audio file. Please record a voice note in WhatsApp (hold the microphone button) and send it."),
  unsupportedImage: text("I can only read JPEG or PNG photos. Please take a photo with your WhatsApp camera and send it."),
  unsupported: text("Sorry, I can only use photos, voice notes and text. Send a photo of your stall and a voice note with your prices."),
  downloadFailed: text("Sorry, I could not open that file. Please send it again."),
  failed: text("Sorry, something went wrong while making your price list. Please send your photo and voice note again."),
  paused: text("Sorry, StallSnap is paused for now. Please try again later."),
  doneHelp: text("Your catalogue is ready. To make a new one, send a new photo of your stall and a voice note."),

  /** The pricing module's list, with the three buttons. Long lists go as text, then a short message with the buttons. */
  priceList(listText: string, version: number, headerImageUrl?: string): Outgoing[] {
    const buttons: Button[] = [
      { id: `yes:${version}`, title: "Yes, publish" },
      { id: `change:${version}`, title: "Change price" },
      { id: `restart:${version}`, title: "Start again" },
    ];
    const ask = "Is this right?";
    const full = `${listText.trim()}\n\n${ask}`;
    const header = headerImageUrl ? { headerImageUrl } : {};
    if (full.length <= LIMITS.buttonBody) return [{ type: "buttons", body: full, buttons, ...header }];
    return [...splitText(listText.trim()), { type: "buttons", body: ask, buttons, ...header }];
  },

  /** The link is in the body too, so the trader can copy or forward it to customers. */
  catalogueReady(url: string): Outgoing {
    return {
      type: "link",
      body: `Your catalogue is ready! Share this link with your customers on WhatsApp:\n${url}`,
      label: "Open catalogue",
      url,
    };
  },
};

/** Split long text on line breaks so no message goes over WhatsApp's 4096 characters. */
export function splitText(body: string): Outgoing[] {
  const out: string[] = [];
  let current = "";
  for (const line of body.split("\n")) {
    for (let piece = line; ; ) {
      const room = LIMITS.textBody - (current ? current.length + 1 : 0);
      if (piece.length <= room) {
        current = current ? `${current}\n${piece}` : piece;
        break;
      }
      if (current) {
        out.push(current);
        current = "";
        continue;
      }
      out.push(piece.slice(0, LIMITS.textBody));
      piece = piece.slice(LIMITS.textBody);
    }
  }
  if (current) out.push(current);
  return out.map(text);
}

/** Button ids look like "yes:3". */
export function parseButtonId(id: string): { action: "yes" | "change" | "restart"; version: number } | undefined {
  const [action, v] = id.split(":");
  const version = Number(v);
  if ((action === "yes" || action === "change" || action === "restart") && Number.isInteger(version)) return { action, version };
  return undefined;
}
