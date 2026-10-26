// The data shape for prices, from the model's tool calls to the published catalogue.
// The rules behind it are in docs/pricing.md.

/** What one price buys. Every catalogue line has exactly one. See docs/pricing.md for when to use each. */
export const SALE_UNITS = [
  "piece", "pack", "tin", "jar", "bottle", "sachet", "strip", "bar", "loaf", "tuber", "set",
  "crate", "paint bucket", "cup", "bag", "heap", "bunch", "yard", "pair", "dozen", "kg", "litre",
] as const;
export type SaleUnit = (typeof SALE_UNITS)[number];

export function isSaleUnit(u: unknown): u is SaleUnit {
  return typeof u === "string" && (SALE_UNITS as readonly string[]).includes(u);
}

/** One product on the stall: one thing a customer can point at and buy at one price. */
export interface Item {
  id: string;
  name: string;
}

export interface ToolCall {
  name: string;
  /** JSON string, exactly as the model sent it. */
  arguments: string;
}

export interface DraftLine {
  item: Item;
  /** priced: the note gave a price we could read. unpriced: no price yet, so the trader is asked. */
  status: "priced" | "unpriced";
  price: number | null;
  unit: SaleUnit | null;
  /** The words in the note that gave the price. */
  quote: string;
  /** Earlier prices replaced in the same note ("3k... no no, 3,500"). */
  replaced: number[];
  /** Why the line is unpriced, when it is. */
  reason?: string;
  /** The Pidgin question to send for an unpriced line. */
  question?: string;
}

export interface Draft {
  lines: DraftLine[];
  /** Tool calls refused as invalid, kept so scoring and QA can see them. */
  rejected: { call: ToolCall; reason: string }[];
}

/** A line the trader has seen and confirmed. A null price is published as "Ask for price", never as a number. */
export interface CatalogueLine {
  itemId: string;
  name: string;
  price: number | null;
  unit: SaleUnit | null;
}

export interface Catalogue {
  lines: CatalogueLine[];
  /** Which version of the list the trader said yes to. */
  confirmedVersion: number;
  confirmedReply: string;
}
