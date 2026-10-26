// Catalogue picture for one crop: the real cut-out pasted onto a clean backdrop.
// Fidelity rule (README, CLAUDE.md): Muse Image never edits product pixels. At most it supplies an empty backdrop,
// which must pass isPlainBackdrop; the product layer always comes from the trader's own photo, and
// composeCatalogueImage proves after compositing that every fully opaque product pixel is unchanged.
import sharp from "sharp";
import type { Mask } from "./mask";

export const SIZE = 1024;
/** The product fills at most this share of the canvas side. */
const FILL = 0.8;
/** Never blow a small crop up more than this; a soft, blocky product looks fake. */
const MAX_UPSCALE = 2;
/** sharp premultiplies alpha while compositing, which can move an opaque channel by 1. */
export const FIDELITY_TOLERANCE = 2;

export class FidelityError extends Error {}

export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

/** The crop's bounding box from the photo, with the mask as its alpha channel. */
export async function cutoutLayer(photo: Buffer, mask: Mask): Promise<RawImage> {
  const meta = await sharp(photo).metadata();
  const left = Math.max(0, mask.box.left), top = Math.max(0, mask.box.top);
  const width = Math.min(mask.rasterW - (left - mask.box.left), meta.width! - left);
  const height = Math.min(mask.rasterH - (top - mask.box.top), meta.height! - top);
  if (width <= 0 || height <= 0) throw new FidelityError("mask lies outside the photo");
  const { data } = await sharp(photo).extract({ left, top, width, height }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const on = mask.raster[(y + top - mask.box.top) * mask.rasterW + (x + left - mask.box.left)];
      data[(y * width + x) * 4 + 3] = on ? 255 : 0;
    }
  return { data, width, height };
}

/** The default backdrop: a soft warm studio gradient, made locally. */
export async function defaultBackdrop(size = SIZE): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
<defs><radialGradient id="g" cx="50%" cy="40%" r="75%"><stop offset="0%" stop-color="#fbf8f3"/><stop offset="100%" stop-color="#e8e1d5"/></radialGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * True when an image is an empty surface: no objects, text or products that a buyer could mistake for stock.
 * Measured as the share of strong edges on a small greyscale copy; a plain or gently lit backdrop has almost none.
 */
export async function isPlainBackdrop(image: Buffer): Promise<{ plain: boolean; edgeShare: number }> {
  const N = 128;
  const { data } = await sharp(image).resize(N, N, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let strong = 0;
  for (let y = 1; y < N - 1; y++)
    for (let x = 1; x < N - 1; x++) {
      const gx = data[y * N + x + 1]! - data[y * N + x - 1]!;
      const gy = data[(y + 1) * N + x]! - data[(y - 1) * N + x]!;
      if (Math.hypot(gx, gy) > 24) strong++;
    }
  const edgeShare = strong / ((N - 2) * (N - 2));
  return { plain: edgeShare < 0.01, edgeShare };
}

/** Use a Muse Image backdrop only when it is provably empty; otherwise the local one. Never fails. */
export async function pickBackdrop(generated: Buffer | null): Promise<{ backdrop: Buffer; source: "muse-image" | "default"; edgeShare?: number }> {
  if (generated) {
    try {
      const check = await isPlainBackdrop(generated);
      if (check.plain) return { backdrop: generated, source: "muse-image", edgeShare: check.edgeShare };
      return { backdrop: await defaultBackdrop(), source: "default", edgeShare: check.edgeShare };
    } catch {
      // unreadable image: fall through to the default
    }
  }
  return { backdrop: await defaultBackdrop(), source: "default" };
}

export interface CatalogueImage {
  png: Buffer;
  /** Where the product layer sits on the canvas, and what the fidelity check found. */
  placement: { left: number; top: number; width: number; height: number; scale: number };
  fidelity: { opaquePixels: number; maxChannelDiff: number };
}

export async function composeCatalogueImage(photo: Buffer, mask: Mask, backdrop: Buffer): Promise<CatalogueImage> {
  const layer = await cutoutLayer(photo, mask);
  const scale = Math.min((SIZE * FILL) / layer.width, (SIZE * FILL) / layer.height, MAX_UPSCALE);
  const width = Math.max(1, Math.round(layer.width * scale)), height = Math.max(1, Math.round(layer.height * scale));
  const product = await sharp(layer.data, { raw: { width: layer.width, height: layer.height, channels: 4 } })
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer();
  const left = Math.round((SIZE - width) / 2), top = Math.round((SIZE - height) / 2);

  // A soft contact shadow made from the mask only, so it adds no detail of its own.
  const shadowAlpha = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) shadowAlpha[i * 4 + 3] = Math.round(product[i * 4 + 3]! * 0.28);
  const shadow = await sharp(shadowAlpha, { raw: { width, height, channels: 4 } })
    .blur(Math.max(2, Math.min(width, height) / 30))
    .png()
    .toBuffer();

  const base = await sharp(backdrop).resize(SIZE, SIZE, { fit: "cover" }).removeAlpha().png().toBuffer();
  const out = await sharp(base)
    .composite([
      { input: shadow, left, top: Math.min(SIZE - height, top + Math.round(height * 0.03)) },
      { input: product, raw: { width, height, channels: 4 }, left, top },
    ])
    .removeAlpha()
    .raw()
    .toBuffer();

  // Prove the product pixels came through unchanged.
  let opaque = 0, maxDiff = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (product[p + 3] !== 255) continue;
      opaque++;
      const o = ((top + y) * SIZE + left + x) * 3;
      for (let c = 0; c < 3; c++) maxDiff = Math.max(maxDiff, Math.abs(out[o + c]! - product[p + c]!));
    }
  if (!opaque) throw new FidelityError("the crop has no solid product pixels");
  if (maxDiff > FIDELITY_TOLERANCE) throw new FidelityError(`product pixels changed by up to ${maxDiff}`);

  const png = await sharp(out, { raw: { width: SIZE, height: SIZE, channels: 3 } }).png().toBuffer();
  return { png, placement: { left, top, width, height, scale }, fidelity: { opaquePixels: opaque, maxChannelDiff: maxDiff } };
}
