// Photo -> catalogue items. The loop follows Meta's SAM 3 Agent:
// 1. Muse Spark lists the products, each with a specific phrase, the plainest noun and a more general word;
// 2. SAM 3.1 segments every phrasing (the general word only when the first two find nothing), a few broad
//    fallbacks ("bottle", "packet", "bag") and "person" once; filterCandidates drops people, loose matches and overlaps;
// 3. Muse Spark reviews a numbered sheet of the crops: accepts or rejects each one, names it from what it sees,
//    groups crops of one lot (a heap, a basin, a strip) and gives boxes for stock it can see but no crop covers;
// 4. SAM 3.1 segments those boxes (box prompts, at most 16 per request).
// The model calls are injected so the messy-input suite runs the real logic with no API calls.
import { area, confident, filterCandidates, LIMITS, overlapOfSmaller, subtract, type Box, type Candidate, type DropReason, type Mask } from "./mask";

export interface Product {
  /** What the trader would call it. Never shown as fact until the trader confirms it. */
  name: string;
  /** Descriptive phrase, e.g. "red pepper heap". */
  specific: string;
  /** Plainest everyday noun, e.g. "pepper". */
  plain: string;
  /** A broader word or synonym, tried only when the first two find nothing, e.g. "vegetable". */
  general: string;
}

export interface ReviewVerdict {
  number: number;
  accept: boolean;
  /** What Spark sees in this crop. */
  name: string;
  /** Crops of one lot share a lot label. */
  lot: string;
}

export interface Review {
  crops: ReviewVerdict[];
  /** Stock Spark can see that no crop covers, as [x1, y1, x2, y2] on a 0 to 1000 grid over the photo. */
  missing: { name: string; box: number[] }[];
}

export interface ModelCalls {
  proposeProducts(photoPath: string): Promise<Product[]>;
  segment(photoPath: string, phrase: string): Promise<Mask[]>;
  /** One request with up to MAX_BOXES box prompts; one mask (or null) per box, in order. */
  segmentBoxes(photoPath: string, boxes: Box[]): Promise<(Mask | null)[]>;
  review(photoPath: string, crops: Crop[]): Promise<Review>;
}

export interface Crop extends Candidate {
  productName: string;
  /** 1-based number in reading order, as shown on the review sheet. */
  number: number;
}

/** One line of the catalogue: one lot, shown by its biggest crop, with every crop of that lot kept. */
export interface CatalogueItem {
  /** 1-based, in reading order of the cover crop: what the trader points at ("number 3 na 500"). */
  number: number;
  name: string;
  cover: Crop;
  crops: Crop[];
  /** "review": Spark accepted it; "box": Spark pointed at it and SAM cut it out; "unreviewed": the review call failed. */
  source: "review" | "box" | "unreviewed";
}

export interface CutoutResult {
  status: "ok" | "no-products";
  products: Product[];
  phrases: { phrase: string; productIndex: number; instances: number }[];
  people: number;
  items: CatalogueItem[];
  rejected: { number: number; name: string }[];
  dropped: { phrase: string; reason: DropReason | "not-reviewed"; box: Box }[];
  boxPrompts: number;
  reviewError?: string;
}

export const PERSON_PHRASE = "person";
/** Broad words SAM matches well whatever the stall sells; Spark's review names and filters what they find. */
export const BROAD_PHRASES = ["bottle", "packet", "bag"];
export const MAX_BOXES = 16;
/** Spark reviews at most this many crops (the biggest); smaller leftovers are dropped. */
export const MAX_REVIEW = 48;
/** Spark is asked for at most 12 product types; more would blow the per-job call limit after paying for the first 60. */
export const MAX_PRODUCTS = 12;
const BROAD = -1;
const FROM_BOX = -2;

// Phrasings whose head noun (last word) is a person or body part. SAM would hand back the trader, so never send these.
// "ladies finger", "baby wipes" and "men's shoes" are stock and stay.
const PERSON_WORDS = /^(person|people|man|men|woman|women|lady|ladies|trader|traders|seller|sellers|vendor|vendors|hawker|hawkers|customer|customers|buyer|buyers|child|children|kid|kids|boy|boys|girl|girls|baby|babies|human|face|hand|hands|arm|arms)$/;

export function normalisePhrase(p: string): string {
  return p.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

// SAM takes one concept per request: no lists, alternatives, negation or position words ("the tin on the left").
const NOT_ONE_CONCEPT = /[,/&;]|\b(and|or|not|no|without|except|left|right|top|bottom|front|back|behind|beside|next|near|above|below|under|middle|centre|center|bigger|biggest|smaller|smallest)\b/;

/** A phrase SAM can use, or "" when it names a person or more than one plain concept. */
export function usable(raw: string | undefined): string {
  if (!raw || NOT_ONE_CONCEPT.test(raw.toLowerCase())) return "";
  const p = normalisePhrase(raw);
  return p && !PERSON_WORDS.test(p.split(" ").at(-1)!) ? p : "";
}

/** Turns Spark's 0-1000 box into image pixels, clamped to the photo. Null for a box with no area. */
export function gridToPixels(box: number[], width: number, height: number): Box | null {
  if (box.length !== 4 || box.some((v) => !Number.isFinite(v))) return null;
  const clamp = (v: number) => Math.min(1000, Math.max(0, v));
  const [x1, y1, x2, y2] = box.map(clamp) as [number, number, number, number];
  const left = Math.round((Math.min(x1, x2) * width) / 1000), right = Math.round((Math.max(x1, x2) * width) / 1000);
  const top = Math.round((Math.min(y1, y2) * height) / 1000), bottom = Math.round((Math.max(y1, y2) * height) / 1000);
  return right - left >= 4 && bottom - top >= 4 ? { left, top, right, bottom } : null;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Spark's product list, checked at the boundary: string fields only, empty names dropped, at most MAX_PRODUCTS. */
export function parseProducts(raw: unknown): Product[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({ name: text(p.name), specific: text(p.specific), plain: text(p.plain), general: text(p.general) }))
    .filter((p) => p.name || p.specific || p.plain)
    .slice(0, MAX_PRODUCTS);
}

/** Spark's review, checked at the boundary: accept only when it is literally true; boxes must be four numbers. */
export function parseReview(raw: unknown): Review {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const crops = (Array.isArray(r.crops) ? r.crops : [])
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && Number.isInteger(v.number))
    .map((v) => ({ number: v.number as number, accept: v.accept === true, name: text(v.name), lot: text(v.lot) }));
  const missing = (Array.isArray(r.missing) ? r.missing : [])
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .filter((m) => Array.isArray(m.box) && m.box.length === 4 && m.box.every((n) => typeof n === "number" && Number.isFinite(n)))
    .map((m) => ({ name: text(m.name), box: m.box as number[] }));
  return { crops, missing };
}

export async function cutOut(photoPath: string, width: number, height: number, calls: ModelCalls): Promise<CutoutResult> {
  const imageArea = width * height;
  const products = parseProducts(await calls.proposeProducts(photoPath));
  const empty: CutoutResult = { status: "no-products", products, phrases: [], people: 0, items: [], rejected: [], dropped: [], boxPrompts: 0 };
  if (!products.length) return empty;

  // Each distinct phrase is segmented once, whichever product asked first.
  const asked = new Map<string, Mask[]>();
  const candidates: Candidate[] = [];
  const counts: CutoutResult["phrases"] = [];
  const run = async (phrase: string, productIndex: number) => {
    if (!phrase || asked.has(phrase)) return asked.get(phrase)?.length ?? 0;
    const masks = await calls.segment(photoPath, phrase);
    asked.set(phrase, masks);
    counts.push({ phrase, productIndex, instances: masks.length });
    for (const m of masks) candidates.push({ ...m, phrase, productIndex });
    return masks.length;
  };
  for (const [i, p] of products.entries()) {
    const found = (await run(usable(p.specific), i)) + (await run(usable(p.plain), i));
    if (!found) await run(usable(p.general), i);
  }
  for (const phrase of BROAD_PHRASES) await run(phrase, BROAD);

  const people = await calls.segment(photoPath, PERSON_PHRASE);
  const { kept, dropped } = filterCandidates(candidates, people, imageArea);
  const out: CutoutResult["dropped"] = dropped.map((d) => ({ phrase: d.candidate.phrase, reason: d.reason, box: d.candidate.box }));

  // Spark reviews the biggest crops; the rest are specks next to them.
  const byArea = [...kept].sort((a, b) => area(b) - area(a));
  for (const c of byArea.slice(MAX_REVIEW)) out.push({ phrase: c.phrase, reason: "not-reviewed", box: c.box });
  const name = (i: number) => products[i]?.name ?? "item";
  const crops: Crop[] = byArea
    .slice(0, MAX_REVIEW)
    .sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left)
    .map((c, i) => ({ ...c, productName: name(c.productIndex), number: i + 1 }));

  // A failed review (API error, spend cap) degrades to unreviewed crops rather than losing the photo.
  let review: Review = { crops: [], missing: [] };
  let reviewError: string | undefined;
  if (crops.length)
    try {
      review = parseReview(await calls.review(photoPath, crops));
    } catch (e) {
      reviewError = (e as Error).message;
    }
  const verdicts = new Map<number, ReviewVerdict>();
  for (const v of review.crops) if (Number.isInteger(v.number) && !verdicts.has(v.number)) verdicts.set(v.number, v);

  const lots = new Map<string, { name: string; crops: Crop[]; source: CatalogueItem["source"] }>();
  const rejected: CutoutResult["rejected"] = [];
  for (const c of crops) {
    const v = verdicts.get(c.number);
    if (reviewError) {
      // No review: keep only crops of the trader's own products, never the broad "bag", "bottle", "packet" matches.
      if (c.productIndex < 0) {
        out.push({ phrase: c.phrase, reason: "not-reviewed", box: c.box });
        continue;
      }
    } else if (!v?.accept) {
      // A rejection, or no verdict at all: the review rules say "if you cannot tell, reject".
      rejected.push({ number: c.number, name: v?.name || c.productName });
      continue;
    }
    const label = v?.name || c.productName;
    const key = v ? `lot:${normalisePhrase(v.lot) || `crop-${c.number}`}` : `crop-${c.number}`;
    const lot = lots.get(key) ?? { name: label, crops: [], source: v ? "review" : "unreviewed" };
    lot.crops.push({ ...c, productName: label });
    lots.set(key, lot);
  }

  // Box prompts for stock Spark can see but no accepted crop covers.
  const accepted = [...lots.values()].flatMap((l) => l.crops);
  const wanted = review.missing
    .map((m) => ({ name: m.name || "item", box: gridToPixels(m.box, width, height) }))
    .filter((m): m is { name: string; box: Box } => m.box !== null)
    .slice(0, MAX_BOXES);
  let boxPrompts = 0;
  if (wanted.length) {
    const masks = await calls.segmentBoxes(photoPath, wanted.map((m) => m.box));
    boxPrompts = wanted.length;
    masks.forEach((m, i) => {
      if (!m || !confident(m)) return;
      const clean = people.length ? subtract(m, people) : m;
      const frac = area(clean) / imageArea;
      if (frac < LIMITS.minAreaFraction || frac > LIMITS.maxAreaFraction) return;
      if (accepted.some((a) => overlapOfSmaller(a, clean) > LIMITS.duplicateOverlap)) return;
      if (people.length && area(clean) < area(m) * (1 - LIMITS.personDropFraction)) return;
      const crop: Crop = { ...clean, phrase: "box", productIndex: FROM_BOX, productName: wanted[i]!.name, number: 0 };
      accepted.push(crop);
      lots.set(`box-${i}`, { name: wanted[i]!.name, crops: [crop], source: "box" });
    });
  }

  const items = [...lots.values()]
    .map((l) => {
      const sorted = [...l.crops].sort((a, b) => area(b) - area(a));
      return { name: l.name, cover: sorted[0]!, crops: sorted, source: l.source };
    })
    .sort((a, b) => a.cover.box.top - b.cover.box.top || a.cover.box.left - b.cover.box.left)
    .map((it, i) => ({ number: i + 1, ...it }));

  return { status: items.length ? "ok" : "no-products", products, phrases: counts, people: people.length, items, rejected, dropped: out, boxPrompts, reviewError };
}
