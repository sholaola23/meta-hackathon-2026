// The two pictures Muse Spark reviews: the photo with every crop's box numbered, and a sheet of numbered tiles,
// each a zoomed view of one crop with everything outside its mask faded. Both stay within 1500px.
import sharp, { type OverlayOptions } from "sharp";
import type { Crop } from "./cutout";

export const SHEET_COLS = 8;
const TILE = 180, LABEL = 24, MAX_SIDE = 1500;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** One tile: the crop's box plus 15% context, with pixels outside the mask faded towards white. */
async function tile(photo: Buffer, W: number, H: number, c: Crop): Promise<Buffer> {
  const bw = c.box.right - c.box.left, bh = c.box.bottom - c.box.top;
  const padX = Math.round(bw * 0.15), padY = Math.round(bh * 0.15);
  const left = Math.max(0, c.box.left - padX), top = Math.max(0, c.box.top - padY);
  const width = Math.max(1, Math.min(W, c.box.right + padX) - left), height = Math.max(1, Math.min(H, c.box.bottom + padY) - top);
  const { data } = await sharp(photo).extract({ left, top, width, height }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const mx = x + left - c.box.left, my = y + top - c.box.top;
      const on = mx >= 0 && my >= 0 && mx < c.rasterW && my < c.rasterH && c.raster[my * c.rasterW + mx];
      if (on) continue;
      const o = (y * width + x) * 3;
      for (let k = 0; k < 3; k++) data[o + k] = Math.round(data[o + k]! * 0.3 + 255 * 0.7);
    }
  return sharp(data, { raw: { width, height, channels: 3 } })
    .resize(TILE, TILE - LABEL, { fit: "contain", background: "#ffffff" })
    .png()
    .toBuffer();
}

export async function reviewSheet(photo: Buffer, crops: Crop[]): Promise<Buffer> {
  const meta = await sharp(photo).metadata();
  const rows = Math.max(1, Math.ceil(crops.length / SHEET_COLS));
  const parts: OverlayOptions[] = [];
  for (const [i, c] of crops.entries()) {
    const col = i % SHEET_COLS, row = Math.floor(i / SHEET_COLS);
    parts.push({ input: await tile(photo, meta.width!, meta.height!, c), left: col * TILE, top: row * TILE + LABEL });
    parts.push({
      input: Buffer.from(`<svg width="${TILE}" height="${LABEL}" xmlns="http://www.w3.org/2000/svg"><text x="4" y="19" font-size="20" font-weight="bold" font-family="Helvetica">#${c.number}</text></svg>`),
      left: col * TILE,
      top: row * TILE,
    });
  }
  const sheet = await sharp({ create: { width: SHEET_COLS * TILE, height: rows * TILE, channels: 3, background: "#ffffff" } }).composite(parts).png().toBuffer();
  return sharp(sheet).resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
}

/** The photo with each crop's box outlined and numbered, so Spark sees where every crop came from. */
export async function numberedPhoto(photo: Buffer, crops: Crop[]): Promise<Buffer> {
  const meta = await sharp(photo).metadata();
  const W = meta.width!, H = meta.height!;
  const s = Math.max(1, Math.round(Math.max(W, H) / 1000));
  const marks = crops
    .map(
      (c) =>
        `<rect x="${c.box.left}" y="${c.box.top}" width="${c.box.right - c.box.left}" height="${c.box.bottom - c.box.top}" fill="none" stroke="#ffeb3b" stroke-width="${2 * s}"/>` +
        `<text x="${c.box.left + 3 * s}" y="${c.box.top + 18 * s}" font-size="${18 * s}" font-weight="bold" font-family="Helvetica" fill="#ffeb3b" stroke="#000" stroke-width="${s}">${esc(String(c.number))}</text>`,
    )
    .join("");
  return sharp(photo)
    .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${marks}</svg>`) }])
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}
