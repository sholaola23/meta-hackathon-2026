// Normalise an incoming stall photo before any model sees it: apply the phone's EXIF rotation (SAM reports masks
// in displayed pixels), cap the longest side, and reject anything that is not a usable photo.
import sharp, { type Metadata } from "sharp";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Longest side sent to the models. Also keeps us under the 2000px rule for images we open. */
export const MAX_SIDE = 1600;
/** Smaller than this and there is nothing a catalogue could use. */
export const MIN_SIDE = 200;

export class PhotoError extends Error {}

export interface PreparedPhoto {
  path: string;
  width: number;
  height: number;
  /** True when the file on disk is the original, untouched (keeps cached model responses valid). */
  unchanged: boolean;
}

export async function preparePhoto(inputPath: string, outDir: string): Promise<PreparedPhoto> {
  const bytes = readFileSync(inputPath);
  let meta: Metadata;
  try {
    meta = await sharp(bytes).metadata();
  } catch {
    throw new PhotoError("That file is not a photo we can read. Please send the stall picture again.");
  }
  if (!meta.width || !meta.height) throw new PhotoError("That photo has no size. Please send it again.");
  const rotated = (meta.orientation ?? 1) >= 5; // orientations 5 to 8 swap width and height
  const w = rotated ? meta.height : meta.width;
  const h = rotated ? meta.width : meta.height;
  if (Math.min(w, h) < MIN_SIDE) throw new PhotoError("That photo is too small. Please send a bigger picture of the stall.");

  const needsWork = meta.format !== "jpeg" || (meta.orientation ?? 1) !== 1 || Math.max(w, h) > MAX_SIDE;
  if (!needsWork) return { path: inputPath, width: w, height: h, unchanged: true };

  const out = await sharp(bytes)
    .rotate() // bakes in EXIF orientation and drops the tag
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 90 })
    .toBuffer({ resolveWithObject: true });
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, createHash("sha256").update(out.data).digest("hex").slice(0, 16) + ".jpg");
  writeFileSync(path, out.data);
  return { path, width: out.info.width, height: out.info.height, unchanged: false };
}
