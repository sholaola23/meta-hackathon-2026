// Scores a draft against the answer key, keeping wrong prices and wrong units apart from the headline,
// then plays the trader through the confirm step and checks what would be published.
import { handleReply, publish, startConfirmation } from "./confirm";
import type { Catalogue, Draft, SaleUnit } from "./types";

export interface KeyStall {
  id: string;
  expected_prices: Record<string, number>;
  expected_units: Record<string, SaleUnit>;
  unpriced_items: string[];
}

/** The full truth for a stall, including the prices of items the trader didn't say (from stalls.json). */
export interface TruthItem {
  name: string;
  price: number;
  unit: SaleUnit;
}

export interface Score {
  priced: number;
  correct: number;
  wrongPrice: { item: string; want: number; got: number }[];
  wrongUnit: { item: string; want: SaleUnit; got: SaleUnit | null }[];
  missing: string[];
  /** Items the trader didn't price. */
  unpriced: number;
  unpricedFlagged: string[];
  invented: { item: string; got: number }[];
  rejectedCalls: number;
  /** False when the recording predates the unit field, so units can't be judged. */
  unitsRecorded: boolean;
  /** Right price, whatever the unit: the day-one headline. */
  matchRate: number;
}

export function scoreDraft(draft: Draft, key: KeyStall, unitsRecorded = true): Score {
  const byName = new Map(draft.lines.map((l) => [l.item.name, l]));
  const s: Score = {
    priced: Object.keys(key.expected_prices).length, correct: 0, wrongPrice: [], wrongUnit: [], missing: [],
    unpriced: key.unpriced_items.length, unpricedFlagged: [], invented: [], rejectedCalls: draft.rejected.length, unitsRecorded, matchRate: 0,
  };
  let rightPrice = 0;
  for (const [item, want] of Object.entries(key.expected_prices)) {
    const l = byName.get(item);
    if (!l || l.price === null) { s.missing.push(item); continue; }
    if (l.price !== want) { s.wrongPrice.push({ item, want, got: l.price }); continue; }
    rightPrice++;
    const wantUnit = key.expected_units[item]!;
    if (unitsRecorded && l.unit !== wantUnit) s.wrongUnit.push({ item, want: wantUnit, got: l.unit });
    else s.correct++;
  }
  for (const item of key.unpriced_items) {
    const l = byName.get(item);
    if (l?.price != null) s.invented.push({ item, got: l.price });
    else if (l?.question) s.unpricedFlagged.push(item);
  }
  s.matchRate = s.priced ? rightPrice / s.priced : 1;
  return s;
}

export interface TraderRun {
  replies: string[];
  messages: string[];
  catalogue: Catalogue;
  /** Lines of the published catalogue that differ from the truth. Must be empty. */
  publishedWrong: string[];
}

/**
 * A trader who reads the list, sends one numbered correction per wrong line (and the price of anything
 * unpriced), then says yes. Every reply goes through the real reply parser.
 */
export function simulateTrader(draft: Draft, truth: TruthItem[], maxRounds = 6): TraderRun {
  const want = new Map(truth.map((t) => [t.name, t]));
  let { session, message } = startConfirmation(draft);
  const replies: string[] = [];
  const messages = [message];
  for (let round = 0; round < maxRounds && session.status !== "confirmed"; round++) {
    const fixes = session.lines.flatMap((l, i) => {
      if (l.removed) return [];
      const t = want.get(l.item.name);
      if (!t) return [`comot ${i + 1}`];
      if (l.price === t.price && l.unit === t.unit) return [];
      return [`${i + 1} na ${t.price} per ${t.unit}`];
    });
    const reply = fixes.length ? fixes.join("\n") : "YES";
    replies.push(reply);
    const r = handleReply(session, reply);
    session = r.session;
    messages.push(r.message);
    if (r.notUnderstood.length) throw new Error(`simulated reply not understood: ${r.notUnderstood.join("; ")}`);
  }
  const catalogue = publish(session);
  const publishedWrong = catalogue.lines.flatMap((l) => {
    const t = want.get(l.name);
    return !t || l.price !== t.price || l.unit !== t.unit ? [`${l.name}: ${l.price} per ${l.unit}`] : [];
  });
  for (const t of truth) if (!catalogue.lines.some((l) => l.name === t.name)) publishedWrong.push(`${t.name}: missing`);
  return { replies, messages, catalogue, publishedWrong };
}
