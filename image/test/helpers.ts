import type { Candidate, Mask } from "../mask";

/** A filled rectangle mask in image coordinates. */
export function rect(left: number, top: number, w: number, h: number, confidence = 0.9): Mask {
  return { box: { left, top, right: left + w, bottom: top + h }, raster: new Uint8Array(w * h).fill(1), rasterW: w, rasterH: h, confidence };
}

/** A filled ellipse inside the given box, so masks are not just rectangles. */
export function ellipse(left: number, top: number, w: number, h: number, confidence = 0.9): Mask {
  const raster = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - w / 2) / (w / 2), dy = (y + 0.5 - h / 2) / (h / 2);
      if (dx * dx + dy * dy <= 1) raster[y * w + x] = 1;
    }
  return { box: { left, top, right: left + w, bottom: top + h }, raster, rasterW: w, rasterH: h, confidence };
}

export function cand(m: Mask, productIndex: number, phrase: string): Candidate {
  return { ...m, productIndex, phrase };
}
