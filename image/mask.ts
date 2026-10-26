// Pure mask geometry for the cut-out step. No API calls, no image I/O, so the messy-input suite can test it directly.

export interface Box {
  left: number;
  top: number;
  /** Exclusive. */
  right: number;
  /** Exclusive. */
  bottom: number;
}

/** One SAM instance: a 0/1 raster of rasterW x rasterH pixels whose top-left corner sits at (box.left, box.top). */
export interface Mask {
  box: Box;
  raster: Uint8Array;
  rasterW: number;
  rasterH: number;
  confidence?: number;
}

/** A product candidate: the mask plus which product and phrasing found it. */
export interface Candidate extends Mask {
  productIndex: number;
  phrase: string;
}

export function area(m: Mask): number {
  let n = 0;
  for (const v of m.raster) n += v;
  return n;
}

function at(m: Mask, x: number, y: number): number {
  const lx = x - m.box.left, ly = y - m.box.top;
  if (lx < 0 || ly < 0 || lx >= m.rasterW || ly >= m.rasterH) return 0;
  return m.raster[ly * m.rasterW + lx]!;
}

/** Pixels set in both masks, counted in image coordinates. */
export function intersection(a: Mask, b: Mask): number {
  const left = Math.max(a.box.left, b.box.left), right = Math.min(a.box.left + a.rasterW, b.box.left + b.rasterW);
  const top = Math.max(a.box.top, b.box.top), bottom = Math.min(a.box.top + a.rasterH, b.box.top + b.rasterH);
  let n = 0;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) n += at(a, x, y) & at(b, x, y);
  return n;
}

/** Shared pixels as a share of the smaller mask: 1 when one mask sits wholly inside the other. */
export function overlapOfSmaller(a: Mask, b: Mask): number {
  const smaller = Math.min(area(a), area(b));
  return smaller ? intersection(a, b) / smaller : 0;
}

/** Fraction of m's pixels that fall inside any of the other masks. */
export function coveredFraction(m: Mask, others: Mask[]): number {
  const total = area(m);
  if (!total || !others.length) return 0;
  let n = 0;
  for (let ly = 0; ly < m.rasterH; ly++)
    for (let lx = 0; lx < m.rasterW; lx++) {
      if (!m.raster[ly * m.rasterW + lx]) continue;
      const x = m.box.left + lx, y = m.box.top + ly;
      if (others.some((o) => at(o, x, y))) n++;
    }
  return n / total;
}

/** A copy of m with every pixel that lies inside one of the other masks cleared. */
export function subtract<T extends Mask>(m: T, others: Mask[]): T {
  const raster = Uint8Array.from(m.raster);
  for (let ly = 0; ly < m.rasterH; ly++)
    for (let lx = 0; lx < m.rasterW; lx++)
      if (raster[ly * m.rasterW + lx] && others.some((o) => at(o, m.box.left + lx, m.box.top + ly))) raster[ly * m.rasterW + lx] = 0;
  return { ...m, raster };
}

export const LIMITS = {
  /** A mask over 40% of the photo is a scene region (a wall, the table), not a product. From the day-one spike. */
  maxAreaFraction: 0.4,
  /** Below this the crop is too small to show in a catalogue (noise, a sliver behind another item). */
  minAreaFraction: 0.0002,
  /**
   * Masks sharing more than this share of the smaller one are the same lot, across all phrasings; the more
   * confident one stays. This also folds single fruits into the basket SAM found them in. Same rule as Meta's SAM 3 Agent.
   */
  duplicateOverlap: 0.3,
  /** SAM's own confidence below this is a loose match (the SAM 3 Agent drops these too). */
  minConfidence: 0.5,
  /** A product mask at least this much inside a person is the person's clothing, not stock. */
  personDropFraction: 0.5,
};

export type DropReason = "low-confidence" | "too-big" | "too-small" | "person" | "duplicate";

export interface Filtered {
  kept: Candidate[];
  dropped: { candidate: Candidate; reason: DropReason }[];
}

/**
 * Turns raw SAM candidates into catalogue crops:
 * 0. drop loose matches below SAM's confidence floor;
 * 1. drop masks that are mostly a person, and clear person pixels from the rest, so no body part reaches a catalogue;
 * 2. drop scene-sized and speck-sized masks;
 * 3. merge overlapping masks found by any phrasing, keeping the most confident.
 */
export function filterCandidates(candidates: Candidate[], people: Mask[], imageArea: number): Filtered {
  const dropped: Filtered["dropped"] = [];
  const survivors: Candidate[] = [];
  for (const c of candidates) {
    if (c.confidence !== undefined && c.confidence < LIMITS.minConfidence) {
      dropped.push({ candidate: c, reason: "low-confidence" });
      continue;
    }
    if (coveredFraction(c, people) >= LIMITS.personDropFraction) {
      dropped.push({ candidate: c, reason: "person" });
      continue;
    }
    const clean = people.length ? subtract(c, people) : c;
    const frac = area(clean) / imageArea;
    if (frac > LIMITS.maxAreaFraction) dropped.push({ candidate: c, reason: "too-big" });
    else if (frac < LIMITS.minAreaFraction) dropped.push({ candidate: c, reason: "too-small" });
    else survivors.push(clean);
  }
  const kept: Candidate[] = [];
  for (const c of [...survivors].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))) {
    if (kept.some((k) => overlapOfSmaller(k, c) > LIMITS.duplicateOverlap)) dropped.push({ candidate: c, reason: "duplicate" });
    else kept.push(c);
  }
  // Reading order (top to bottom, then left to right) so crop numbers are stable and easy to point at.
  kept.sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
  return { kept, dropped };
}
