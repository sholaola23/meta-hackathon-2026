// Turn a WhatsApp Cloud API "messages" webhook body into a flat list of inbound events.
// Payload shapes: developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages (read 26 Oct 2026).
// This is the boundary: everything past here can trust the InboundEvent type.

export type MediaRef = { mediaId: string; mimeType: string; sha256?: string };

export type InboundEvent = { messageId: string; from: string; sentAt: number; replyTo?: string } & (
  | { kind: "image"; media: MediaRef; caption?: string }
  | { kind: "audio"; media: MediaRef; isVoiceNote: boolean }
  | { kind: "text"; text: string }
  | { kind: "button"; buttonId: string }
  /** Anything we can't use: video, documents, stickers, location, edits, oversize media. */
  | { kind: "other"; type: string; errorCode?: number }
  /** Reactions and similar: never answered. */
  | { kind: "ignored"; type: string }
);

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function media(m: Record<string, unknown>): MediaRef | undefined {
  const mediaId = str(m.id);
  const mimeType = str(m.mime_type);
  return mediaId && mimeType ? { mediaId, mimeType, sha256: str(m.sha256) } : undefined;
}

function parseMessage(raw: unknown): InboundEvent | undefined {
  const m = obj(raw);
  const messageId = str(m.id);
  const from = str(m.from);
  const sentAt = Number(m.timestamp);
  if (!messageId || !from || !Number.isFinite(sentAt)) return undefined;
  const base = { messageId, from, sentAt, replyTo: str(obj(m.context).id) };
  const type = str(m.type) ?? "unknown";
  const errorCode = Number(obj(arr(m.errors)[0]).code) || undefined;

  if (type === "image") {
    const ref = media(obj(m.image));
    if (ref) return { ...base, kind: "image", media: ref, caption: str(obj(m.image).caption)?.trim() || undefined };
  }
  if (type === "audio") {
    const ref = media(obj(m.audio));
    if (ref) return { ...base, kind: "audio", media: ref, isVoiceNote: obj(m.audio).voice === true };
  }
  // Meta's reference sends voice notes as type "audio" with voice: true. Accept a separate "voice" type too.
  if (type === "voice") {
    const ref = media(obj(m.voice));
    if (ref) return { ...base, kind: "audio", media: ref, isVoiceNote: true };
  }
  if (type === "document") {
    // Traders sometimes send a photo "as a document" to keep the quality, or forward an audio file.
    const doc = obj(m.document);
    const ref = media(doc);
    if (ref?.mimeType.startsWith("image/")) return { ...base, kind: "image", media: ref, caption: str(doc.caption)?.trim() || undefined };
    if (ref?.mimeType.startsWith("audio/")) return { ...base, kind: "audio", media: ref, isVoiceNote: false };
  }
  if (type === "text") {
    const text = str(obj(m.text).body)?.trim();
    return text ? { ...base, kind: "text", text } : { ...base, kind: "ignored", type: "empty-text" };
  }
  if (type === "interactive") {
    const reply = obj(obj(m.interactive).button_reply);
    const buttonId = str(reply.id);
    if (buttonId) return { ...base, kind: "button", buttonId };
  }
  if (type === "reaction" || type === "system" || type === "request_welcome") return { ...base, kind: "ignored", type };
  return { ...base, kind: "other", type, errorCode };
}

/** Inbound messages for our phone number only, oldest first. Status receipts and other numbers are dropped. */
export function parseWebhook(body: unknown, phoneNumberId: string): InboundEvent[] {
  const root = obj(body);
  if (root.object !== "whatsapp_business_account") return [];
  const events: InboundEvent[] = [];
  for (const entry of arr(root.entry)) {
    for (const change of arr(obj(entry).changes)) {
      const c = obj(change);
      if (c.field !== "messages") continue;
      const value = obj(c.value);
      if (str(obj(value.metadata).phone_number_id) !== phoneNumberId) continue;
      for (const m of arr(value.messages)) {
        const e = parseMessage(m);
        if (e) events.push(e);
      }
    }
  }
  return events.sort((a, b) => a.sentAt - b.sentAt);
}
