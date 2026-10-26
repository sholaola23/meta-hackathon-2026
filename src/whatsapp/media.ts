// Two-step media download (media id -> short-lived URL -> bytes), with type, size and hash checks before
// anything reaches the pipeline. Supported types: .../business-phone-numbers/media#supported-media-types (read 26 Oct 2026).
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MediaRef } from "./events";
import { GraphError, type Graph } from "./graph";
import type { LocalMedia } from "./pipeline";

/** WhatsApp allows 5 MB images. Voice notes are Opus at roughly 2 KB a second, so 2 MB is well over 10 minutes. */
export const MAX_BYTES = { image: 5 * 1024 * 1024, audio: 2 * 1024 * 1024 };

const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png" };
const AUDIO_TYPES: Record<string, string> = {
  "audio/ogg": "ogg", // WhatsApp voice notes: "audio/ogg; codecs=opus"
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
};

export type MediaProblem = "unsupported" | "too-big" | "download-failed";

export class MediaRejected extends Error {
  constructor(readonly problem: MediaProblem, message: string) {
    super(message);
    this.name = "MediaRejected";
  }
}

const baseType = (mime: string) => mime.split(";")[0]!.trim().toLowerCase();

/** The file extension for a type we accept, or undefined. Plain audio/ogg must say opus (WhatsApp only supports Opus in OGG). */
export function acceptedExtension(kind: "image" | "audio", mime: string): string | undefined {
  const base = baseType(mime);
  if (kind === "image") return IMAGE_TYPES[base];
  if (base === "audio/ogg" && !/codecs\s*=\s*"?opus/i.test(mime)) return undefined;
  return AUDIO_TYPES[base];
}

export async function fetchMedia(
  graph: Graph,
  kind: "image" | "audio",
  ref: MediaRef,
  meta: { messageId: string; sentAt: number; dir: string; isVoiceNote?: boolean },
): Promise<LocalMedia> {
  const ext = acceptedExtension(kind, ref.mimeType);
  if (!ext) throw new MediaRejected("unsupported", `${kind} type ${ref.mimeType} not accepted`);
  const max = MAX_BYTES[kind];

  let bytes: Uint8Array | undefined;
  for (let attempt = 0; attempt < 2 && !bytes; attempt++) {
    try {
      const info = await graph.mediaInfo(ref.mediaId);
      if (info.bytes > max) throw new MediaRejected("too-big", `${kind} is ${info.bytes} bytes, max ${max}`);
      bytes = await graph.download(info.url, max);
    } catch (err) {
      if (err instanceof MediaRejected) throw err;
      if (err instanceof GraphError && err.status === 413) throw new MediaRejected("too-big", err.message);
      // A 404 means the 5-minute URL expired: ask for a fresh one once, as the docs advise.
      if (attempt === 1 || !(err instanceof GraphError && err.status === 404)) {
        throw new MediaRejected("download-failed", (err as Error).message);
      }
    }
  }
  if (!bytes) throw new MediaRejected("download-failed", "no bytes");

  if (ref.sha256) {
    // The webhook docs show base64; accept hex too in case the API returns that.
    const digest = createHash("sha256").update(bytes);
    const hex = digest.digest("hex");
    const b64 = Buffer.from(hex, "hex").toString("base64");
    if (ref.sha256 !== b64 && ref.sha256.toLowerCase() !== hex) throw new MediaRejected("download-failed", "sha256 does not match the webhook");
  }

  mkdirSync(meta.dir, { recursive: true });
  const path = join(meta.dir, `${createHash("sha256").update(meta.messageId).digest("hex").slice(0, 16)}.${ext}`);
  writeFileSync(path, bytes);
  return {
    messageId: meta.messageId,
    path,
    mimeType: ref.mimeType,
    bytes: bytes.byteLength,
    sentAt: meta.sentAt,
    ...(kind === "audio" ? { isVoiceNote: meta.isVoiceNote ?? false } : {}),
  };
}
