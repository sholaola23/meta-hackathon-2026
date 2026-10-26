// Catalogue picture for one crop: the real cut-out pasted onto a clean backdrop.
// Fidelity rule (README, CLAUDE.md): the product pixels always come from the trader's own photo. Muse Image may
// restyle the backdrop of a composed picture, but restyleCatalogueImage pastes the real product back over its output,
// rejects any output that grew something new around the product, and proves every opaque product pixel is unchanged.
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

export interface CatalogueImage {
  png: Buffer;
  /** Where the product layer sits on the canvas, and what the fidelity check found. */
  placement: { left: number; top: number; width: number; height: number; scale: number };
  fidelity: { opaquePixels: number; maxChannelDiff: number };
  /** The scaled product layer (RGBA, placement-sized), kept so a restyle can be pasted back over. */
  product: Buffer;
}

/** Every fully opaque product pixel must come through unchanged; throws FidelityError otherwise. */
function checkFidelity(out: Buffer, product: Buffer, p: { left: number; top: number; width: number; height: number }) {
  let opaque = 0, maxDiff = 0;
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) {
      const i = (y * p.width + x) * 4;
      if (product[i + 3] !== 255) continue;
      opaque++;
      const o = ((p.top + y) * SIZE + p.left + x) * 3;
      for (let c = 0; c < 3; c++) maxDiff = Math.max(maxDiff, Math.abs(out[o + c]! - product[i + c]!));
    }
  if (!opaque) throw new FidelityError("the crop has no solid product pixels");
  if (maxDiff > FIDELITY_TOLERANCE) throw new FidelityError(`product pixels changed by up to ${maxDiff}`);
  return { opaquePixels: opaque, maxChannelDiff: maxDiff };
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

  const fidelity = checkFidelity(out, product, { left, top, width, height });
  const png = await sharp(out, { raw: { width: SIZE, height: SIZE, channels: 3 } }).png().toBuffer();
  return { png, placement: { left, top, width, height, scale }, fidelity, product };
}

/** Grid for the no-new-objects check, and how far (in grid cells) around the product edges are ignored. */
const GRID = 256, MARGIN_CELLS = 4;

/**
 * Share of strong edges outside the product (and a margin round it). The composed picture has a plain backdrop and a
 * blurred shadow, so anything Muse Image drew there (a second bottle, text, a ghost of a moved product) shows up here.
 */
export async function edgeShareOutside(image: Buffer, product: Buffer, p: { left: number; top: number; width: number; height: number }) {
  const cell = SIZE / GRID;
  const near = new Uint8Array(GRID * GRID);
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) {
      if (!product[(y * p.width + x) * 4 + 3]) continue;
      const gx = Math.floor((p.left + x) / cell), gy = Math.floor((p.top + y) / cell);
      for (let dy = -MARGIN_CELLS; dy <= MARGIN_CELLS; dy++)
        for (let dx = -MARGIN_CELLS; dx <= MARGIN_CELLS; dx++) {
          const nx = gx + dx, ny = gy + dy;
          if (nx >= 0 && ny >= 0 && nx < GRID && ny < GRID) near[ny * GRID + nx] = 1;
        }
    }
  const { data } = await sharp(image).resize(GRID, GRID, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let strong = 0, outside = 0;
  for (let y = 1; y < GRID - 1; y++)
    for (let x = 1; x < GRID - 1; x++) {
      if (near[y * GRID + x]) continue;
      outside++;
      const gx = data[y * GRID + x + 1]! - data[y * GRID + x - 1]!;
      const gy = data[(y + 1) * GRID + x]! - data[(y - 1) * GRID + x]!;
      if (Math.hypot(gx, gy) > 24) strong++;
    }
  return outside ? strong / outside : 0;
}

export interface FinalImage {
  png: Buffer;
  source: "muse-image" | "local";
  /** Why a restyle was not used, when one was offered. */
  rejected?: string;
  edgeShare?: number;
  fidelity: { opaquePixels: number; maxChannelDiff: number };
}

/**
 * Takes Muse Image's restyle of a composed picture only if it is square, adds nothing around the product, and
 * survives having the real product pasted back pixel for pixel. Otherwise keeps the composed picture. Never fails.
 */
export async function restyleCatalogueImage(composed: CatalogueImage, restyled: Buffer | null): Promise<FinalImage> {
  const local: FinalImage = { png: composed.png, source: "local", fidelity: composed.fidelity };
  if (!restyled) return local;
  try {
    const meta = await sharp(restyled).metadata();
    if (!meta.width || !meta.height || Math.abs(meta.width / meta.height - 1) > 0.02)
      return { ...local, rejected: `not square (${meta.width}x${meta.height})` };
    const p = composed.placement;
    const out = await sharp(restyled)
      .resize(SIZE, SIZE, { fit: "fill" })
      .removeAlpha()
      .composite([{ input: composed.product, raw: { width: p.width, height: p.height, channels: 4 }, left: p.left, top: p.top }])
      .removeAlpha()
      .raw()
      .toBuffer();
    const png = await sharp(out, { raw: { width: SIZE, height: SIZE, channels: 3 } }).png().toBuffer();
    const edgeShare = await edgeShareOutside(png, composed.product, p);
    if (edgeShare >= 0.01) return { ...local, rejected: "something new appeared around the product", edgeShare };
    return { png, source: "muse-image", edgeShare, fidelity: checkFidelity(out, composed.product, p) };
  } catch (e) {
    return { ...local, rejected: (e as Error).message };
  }
}
