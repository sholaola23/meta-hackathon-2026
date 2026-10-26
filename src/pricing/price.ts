// Turns a price as a trader types or says it into whole naira, or says why it can't.
// Anything unclear is refused rather than guessed: a refused price goes back to the trader as a question.

export const MIN_PRICE = 10;
export const MAX_PRICE = 5_000_000;

export type PriceResult =
  | { ok: true; naira: number }
  | { ok: false; reason: "empty" | "no_price" | "range" | "kobo" | "negative" | "too_low" | "too_high" | "unreadable" };

const NO_PRICE = /^(n\/?a|nil|none|null|unknown|not given|no price|\?+|-+|tbc|tba)$/i;

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, tree: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

function checkRange(n: number): PriceResult {
  if (n < 0) return { ok: false, reason: "negative" };
  if (n < MIN_PRICE) return { ok: false, reason: "too_low" };
  if (n > MAX_PRICE) return { ok: false, reason: "too_high" };
  return { ok: true, naira: n };
}

/** "35OO" and "3,5o0" are typing slips for 3500: an O inside a run of digits is a zero. */
function fixLetterO(s: string): string {
  return s.replace(/[\dOo,.]+/g, (run) => (/\d/.test(run) ? run.replace(/[Oo]/g, "0") : run));
}

function parseDigits(s: string): PriceResult | null {
  const m = s.match(/^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(k)?$/i);
  if (!m) return null;
  const whole = Number(m[1]!.replace(/,/g, ""));
  const frac = m[2];
  if (m[3]) return checkRange(Math.round(Number(`${whole}.${frac ?? 0}`) * 1000));
  if (frac === undefined) return checkRange(whole);
  // "250.00" is exact naira. "1.8" or "2.5" is market shorthand for thousands. "250.50" has kobo.
  if (/^0+$/.test(frac)) return checkRange(whole);
  if (whole < 100 && frac.length === 1) return checkRange(Math.round(Number(`${whole}.${frac}`) * 1000));
  return { ok: false, reason: "kobo" };
}

/** Number words, including Pidgin ("tree tousand") and market shorthand ("one-fifty", "four-two", "one five"). */
function parseWords(s: string): PriceResult | null {
  const words = s.toLowerCase().replace(/-/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length || !words.every((w) => w in SMALL || w in TENS || /^(hundred|thousand|tousand|k|and)$/.test(w))) return null;
  const w = words.filter((x) => x !== "and");
  // "hundred hundred" is reduplication: 100 each.
  if (w.length === 2 && w[0] === "hundred" && w[1] === "hundred") return checkRange(100);
  // Shorthand pairs with no scale word: "one fifty" = 150, "four two" = 4,200.
  const first = SMALL[w[0]!];
  if (w.length === 2 && first !== undefined && first >= 1 && first <= 9) {
    const tens = TENS[w[1]!];
    const digit = SMALL[w[1]!];
    if (tens !== undefined) return checkRange(first * 100 + tens);
    if (digit !== undefined && digit <= 9) return checkRange(first * 1000 + digit * 100);
  }
  let total = 0;
  let group = 0;
  let afterThousand = false;
  for (const x of w) {
    if (x in SMALL) group += SMALL[x]!;
    else if (x in TENS) group += TENS[x]!;
    else if (x === "hundred") group = (group || 1) * 100;
    else {
      total += (group || 1) * 1000;
      group = 0;
      afterThousand = true;
    }
  }
  // "tree tousand five" means 3,500: a lone digit after thousand counts hundreds.
  if (afterThousand && group >= 1 && group <= 9) group *= 100;
  return checkRange(total + group);
}

export function parsePrice(input: string | number | null | undefined): PriceResult {
  if (input === null || input === undefined) return { ok: false, reason: "empty" };
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return { ok: false, reason: "unreadable" };
    if (!Number.isInteger(input)) return { ok: false, reason: "kobo" };
    return checkRange(input);
  }
  let s = input.trim();
  if (!s) return { ok: false, reason: "empty" };
  if (NO_PRICE.test(s)) return { ok: false, reason: "no_price" };
  if (/\bkobo\b/i.test(s)) return { ok: false, reason: "kobo" };
  s = s
    .replace(/^(na|it's|its|is|=|:)\s+/i, "")
    .replace(/\s+(naira|each|per one|one one|only|o)$/i, "")
    .replace(/^(₦|ngn|#|n(?=\s*\d))\s*/i, "")
    .replace(/\s*(naira|ngn)$/i, "")
    .trim();
  s = fixLetterO(s);
  if (/^-\s*\d/.test(s)) return { ok: false, reason: "negative" };
  if (/\d\s*(-|–|to|\/|or)\s*[₦#n]?\d/i.test(s) || /^between\b/i.test(s) || /\b\w+\s+(to|or)\s+\w+/i.test(s)) {
    return { ok: false, reason: "range" };
  }
  // "one-fifty one-fifty": reduplication of the same price.
  const halves = s.split(/\s+/);
  if (halves.length % 2 === 0) {
    const a = halves.slice(0, halves.length / 2).join(" ");
    if (a === halves.slice(halves.length / 2).join(" ") && a !== "hundred") s = a;
  }
  return parseDigits(s) ?? parseWords(s) ?? { ok: false, reason: "unreadable" };
}
