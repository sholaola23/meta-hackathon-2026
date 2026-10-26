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
  /** The contact shadow's alpha over the whole canvas, where a restyle may legitimately darken. */
  shade: Uint8Array;
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

  const shadowTop = Math.min(SIZE - height, top + Math.round(height * 0.03));
  const shade = new Uint8Array(SIZE * SIZE);
  const { data: sa } = await sharp(shadow).raw().toBuffer({ resolveWithObject: true });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) shade[(shadowTop + y) * SIZE + left + x] = sa[(y * width + x) * 4 + 3]!;

  const base = await sharp(backdrop).resize(SIZE, SIZE, { fit: "cover" }).removeAlpha().png().toBuffer();
  const out = await sharp(base)
    .composite([
      { input: shadow, left, top: shadowTop },
      { input: product, raw: { width, height, channels: 4 }, left, top },
    ])
    .removeAlpha()
    .raw()
    .toBuffer();

  const fidelity = checkFidelity(out, product, { left, top, width, height });
  const png = await sharp(out, { raw: { width: SIZE, height: SIZE, channels: 3 } }).png().toBuffer();
  return { png, placement: { left, top, width, height, scale }, fidelity, product, shade };
}

/** How far a restyled pixel may stray from a smooth relight of the composed picture, off the product. */
const STRAY = 24;
/** Inside the composed shadow a restyle may deepen it: an even darkening of the backdrop, by at most this share. */
const MAX_SHADOW_DARKENING = 0.4;
/** More stray pixels than this is something new: an invented bottle, text, a ghost of a moved product. */
export const MAX_NEW_PIXELS = 300;

/** Solves the 6x6 normal equations for one quadratic surface; returns null when they are singular. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length, m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    if (Math.abs(m[piv]![c]!) < 1e-9) return null;
    [m[c], m[piv]] = [m[piv]!, m[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/**
 * Counts pixels where a restyle adds something to the composed picture. A legitimate restyle only relights the plain
 * backdrop, which a smooth (quadratic) change per channel explains. Whatever that surface cannot explain is new
 * structure: a hard-edged bottle, a softly shaded blob, or a tin drawn against the product's edge. Only the product
 * itself (with a 2 px rim) is ignored; inside the composed contact shadow, an even darkening is allowed. A restyle
 * that draws a shadow anywhere else fails closed: the composed picture is kept.
 */
export function newPixels(composed: Buffer, restyled: Buffer, product: Buffer, p: { left: number; top: number; width: number; height: number }, shade: Uint8Array): number {
  const skip = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) {
      if (!product[(y * p.width + x) * 4 + 3]) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const X = p.left + x + dx, Y = p.top + y + dy;
          if (X >= 0 && Y >= 0 && X < SIZE && Y < SIZE) skip[Y * SIZE + X] = 1;
        }
    }
  const terms = (x: number, y: number) => {
    const u = (2 * x) / SIZE - 1, v = (2 * y) / SIZE - 1;
    return [1, u, v, u * u, u * v, v * v];
  };
  const fits: number[][] = [];
  for (let c = 0; c < 3; c++) {
    const A = Array.from({ length: 6 }, () => new Array(6).fill(0)), B = new Array(6).fill(0);
    for (let y = 0; y < SIZE; y += 4)
      for (let x = 0; x < SIZE; x += 4) {
        const i = y * SIZE + x;
        if (skip[i]) continue;
        const t = terms(x, y), d = restyled[i * 3 + c]! - composed[i * 3 + c]!;
        for (let r = 0; r < 6; r++) {
          B[r] += t[r]! * d;
          for (let k = 0; k < 6; k++) A[r]![k] += t[r]! * t[k]!;
        }
      }
    fits.push(solve(A, B) ?? [0, 0, 0, 0, 0, 0]);
  }
  let stray = 0;
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      if (skip[i]) continue;
      const t = terms(x, y);
      let worst = 0;
      const ratio: number[] = [];
      for (let c = 0; c < 3; c++) {
        const expected = composed[i * 3 + c]! + fits[c]!.reduce((s, w, k) => s + w * t[k]!, 0);
        worst = Math.max(worst, Math.abs(restyled[i * 3 + c]! - expected));
        ratio.push(restyled[i * 3 + c]! / Math.max(1, expected));
      }
      if (worst <= STRAY) continue;
      // A shadow under the product darkens the backdrop evenly; a tin or a coloured object does not.
      const evenDarkening = Math.max(...ratio) - Math.min(...ratio) <= 0.06 && Math.min(...ratio) >= 1 - MAX_SHADOW_DARKENING;
      if (evenDarkening && shade[i]! > 4) continue;
      stray++;
    }
  return stray;
}

export interface FinalImage {
  png: Buffer;
  source: "muse-image" | "local";
  /** Why a restyle was not used, when one was offered. */
  rejected?: string;
  /** Pixels the restyle changed beyond a smooth relight, off the product. */
  newPixels?: number;
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
    const before = await sharp(composed.png).removeAlpha().raw().toBuffer();
    const added = newPixels(before, out, composed.product, p, composed.shade);
    if (added > MAX_NEW_PIXELS) return { ...local, rejected: `something new appeared around the product (${added} pixels)`, newPixels: added };
    const png = await sharp(out, { raw: { width: SIZE, height: SIZE, channels: 3 } }).png().toBuffer();
    return { png, source: "muse-image", newPixels: added, fidelity: checkFidelity(out, composed.product, p) };
  } catch (e) {
    return { ...local, rejected: (e as Error).message };
  }
}
