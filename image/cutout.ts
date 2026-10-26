// Photo -> product crops. Muse Spark names each product twice (a specific phrase and the plainest everyday noun),
// SAM 3.1 segments every phrasing plus "person" once, and filterCandidates turns the union into clean crops.
// The model calls are injected so the messy-input suite runs the real logic with no API calls.
import { filterCandidates, type Candidate, type DropReason, type Mask } from "./mask";

export interface Product {
  /** What the trader would call it, for the trader confirmation step. Never shown as fact until confirmed. */
  name: string;
  /** Descriptive phrase, e.g. "red pepper heap". */
  specific: string;
  /** Plainest everyday noun, e.g. "pepper". */
  plain: string;
}

export interface ModelCalls {
  proposeProducts(photoPath: string): Promise<Product[]>;
  segment(photoPath: string, phrase: string): Promise<Mask[]>;
}

export interface Crop extends Candidate {
  productName: string;
  /** 1-based number in reading order, used when the trader says "number 3 na 500". */
  number: number;
}

export interface CutoutResult {
  status: "ok" | "no-products";
  products: Product[];
  phrases: { phrase: string; productIndex: number; instances: number }[];
  people: number;
  crops: Crop[];
  dropped: { productName: string; phrase: string; reason: DropReason; box: Mask["box"] }[];
}

export const PERSON_PHRASE = "person";

// Phrasings that name people rather than stock. SAM would hand back the trader, so never send these as products.
const PERSON_WORDS = /^(person|people|man|men|woman|women|trader|seller|vendor|customer|buyer|child|boy|girl|human|face|hand|hands)$/;

export function normalisePhrase(p: string): string {
  return p.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Every distinct phrasing to send to SAM, with the first product that asked for it. Empty and person phrasings are skipped. */
export function phrasesFor(products: Product[]): { phrase: string; productIndex: number }[] {
  const seen = new Map<string, number>();
  products.forEach((p, i) => {
    for (const raw of [p.specific, p.plain]) {
      const phrase = normalisePhrase(raw ?? "");
      if (!phrase || PERSON_WORDS.test(phrase) || seen.has(phrase)) continue;
      seen.set(phrase, i);
    }
  });
  return [...seen].map(([phrase, productIndex]) => ({ phrase, productIndex }));
}

export async function cutOut(photoPath: string, imageArea: number, calls: ModelCalls): Promise<CutoutResult> {
  const products = await calls.proposeProducts(photoPath);
  const phrases = phrasesFor(products);
  if (!phrases.length) return { status: "no-products", products, phrases: [], people: 0, crops: [], dropped: [] };

  const candidates: Candidate[] = [];
  const counts: CutoutResult["phrases"] = [];
  for (const { phrase, productIndex } of phrases) {
    const masks = await calls.segment(photoPath, phrase);
    counts.push({ phrase, productIndex, instances: masks.length });
    for (const m of masks) candidates.push({ ...m, phrase, productIndex });
  }
  const people = await calls.segment(photoPath, PERSON_PHRASE);
  const { kept, dropped } = filterCandidates(candidates, people, imageArea);
  const name = (i: number) => products[i]?.name ?? "unknown";
  return {
    status: kept.length ? "ok" : "no-products",
    products,
    phrases: counts,
    people: people.length,
    crops: kept.map((c, i) => ({ ...c, productName: name(c.productIndex), number: i + 1 })),
    dropped: dropped.map((d) => ({ productName: name(d.candidate.productIndex), phrase: d.candidate.phrase, reason: d.reason, box: d.candidate.box })),
  };
}
