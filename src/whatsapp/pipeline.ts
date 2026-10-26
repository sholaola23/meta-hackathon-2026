// The contract between the WhatsApp loop and the rest of StallSnap.
// The image pipeline, the pricing (trader-confirm) logic and the catalogue page live in other modules.
// This loop only moves media and replies between WhatsApp and an implementation of Pipeline;
// an adapter maps the pricing module's session (pricing/, handleReply) onto it.

/** A media file the trader sent, already downloaded and checked. */
export interface LocalMedia {
  /** WhatsApp message id it came in on. */
  messageId: string;
  /** Absolute path on disk. */
  path: string;
  mimeType: string;
  bytes: number;
  /** Unix seconds, from the webhook. */
  sentAt: number;
  /** True for a WhatsApp voice recording, false for a forwarded audio file. Only set for audio. */
  isVoiceNote?: boolean;
}

/** What the pricing step says back after each turn. */
export interface PricingTurn {
  /** Rises with every change to the list, so a button on an older list can be told apart. */
  version: number;
  /** The text the trader sees: the priced list, or a question about it. Written by the pricing module. */
  message: string;
  /** True only once the trader has confirmed the latest list; the loop then publishes. */
  confirmed: boolean;
  /** Optional public HTTPS image shown above the list, such as the cleaned stall cut-outs. */
  headerImageUrl?: string;
}

export interface StartInput {
  traderId: string;
  /** One per catalogue; pass it to SpendGuard.paid() so the per-job call cap applies. */
  jobId: string;
  photos: LocalMedia[];
  voiceNotes: LocalMedia[];
  /** Captions and typed messages sent with the photos, in the order sent. Traders sometimes type prices. */
  texts: string[];
}

/** "Yes, publish" arrives here as the text "YES". A voice note is transcribed by the pipeline, then handled as text. */
export type TraderReply = { text: string } | { voiceNote: LocalMedia };

export interface Pipeline {
  /** Photo(s) and price note(s) in, first priced list out. */
  start(input: StartInput): Promise<PricingTurn>;
  /** One reply from the trader to the latest list. */
  reply(input: { traderId: string; jobId: string; reply: TraderReply }): Promise<PricingTurn>;
  /** The trader confirmed: build the catalogue page and return its public link. */
  publish(input: { traderId: string; jobId: string }): Promise<{ url: string }>;
}

/**
 * Pipeline calls pay for model calls through SpendGuard.paid() in src/spend-guard.ts (one jobId per catalogue).
 * When a cap is hit it throws an error named "SpendCapError"; the loop turns that into one "paused" reply.
 */
export function isSpendCapError(err: unknown): boolean {
  return err instanceof Error && err.name === "SpendCapError";
}

/** The image step throws a PhotoError (image/photo.ts) whose message is written for the trader, such as an unreadable photo. */
export function photoErrorMessage(err: unknown): string | undefined {
  return err instanceof Error && err.name === "PhotoError" && err.message.trim() ? err.message.trim().slice(0, 1000) : undefined;
}
