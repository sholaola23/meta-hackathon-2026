// The trader's confirm step. The trader sees the priced list, corrects anything wrong in a reply,
// and says yes. Only a yes to the latest list, with nothing else in the reply, confirms it.
// publish() refuses anything that isn't confirmed, so no price reaches a catalogue unseen.
// Channel-agnostic: the caller sends message text and passes back the trader's reply text.
import { parsePrice } from "./price";
import { isSaleUnit, type Catalogue, type Draft, type Item, type SaleUnit } from "./types";

export interface SessionLine {
  item: Item;
  price: number | null;
  unit: SaleUnit | null;
  removed: boolean;
  question?: string;
}

/** One message in the confirm conversation, kept so every published price can be traced to the trader's yes. */
export interface AuditEntry {
  at: string;
  from: "stallsnap" | "trader";
  /** The list version the message was about. */
  version: number;
  text: string;
}

export interface Session {
  version: number;
  status: "awaiting" | "confirmed";
  lines: SessionLine[];
  confirmedReply?: string;
  /** The list version on which the trader was told that unpriced items will show as "Ask for price". */
  warnedUnpriced?: number;
  /** Every list sent and every reply received, oldest first. */
  log: AuditEntry[];
}

export interface ReplyResult {
  session: Session;
  /** The message to send the trader next. */
  message: string;
  /** Parts of the reply we could not act on. */
  notUnderstood: string[];
  /**
   * True when a confirmed list was changed and is waiting for a new YES. Anything already published
   * from the old version is out of date: the caller should take it down or mark it until the new YES.
   */
  reopened?: boolean;
}

const UNIT_WORDS: Record<string, SaleUnit> = {
  paint: "paint bucket", bucket: "paint bucket", sachets: "sachet", strips: "strip", packs: "pack",
  tins: "tin", bottles: "bottle", jars: "jar", bars: "bar", loaves: "loaf", tubers: "tuber", sets: "set",
  crates: "crate", cups: "cup", bags: "bag", heaps: "heap", bunches: "bunch", yards: "yard", pairs: "pair",
  pieces: "piece",
};

function unitWord(w: string): SaleUnit | null {
  const x = w.toLowerCase();
  return isSaleUnit(x) ? x : (UNIT_WORDS[x] ?? null);
}

export function naira(n: number): string {
  return `₦${n.toLocaleString("en-GB")}`;
}

function lineText(l: SessionLine, n: number): string {
  if (l.price === null) return `${n}. ${l.item.name}: NO PRICE. ${l.question ?? "Na how much?"}`;
  return `${n}. ${l.item.name}: ${naira(l.price)}${l.unit ? ` per ${l.unit}` : ""}`;
}

export function renderList(s: Session): string {
  const shown = s.lines.map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => !l.removed);
  return [
    `Check your prices (list ${s.version}):`,
    ...shown.map(({ l, n }) => lineText(l, n)),
    "",
    "Reply YES if everything correct.",
    "To change a price, send the number and the price, like: 2 na 1800",
    "To remove an item, send: comot 3",
    "To fix a name, send: name 3 Horlicks sachet",
    ...(shown.some(({ l }) => l.price === null) ? ['Anything still with NO PRICE will show as "Ask for price".'] : []),
  ].join("\n");
}

export function startConfirmation(draft: Draft, now: () => Date = () => new Date()): { session: Session; message: string } {
  const session: Session = {
    version: 1,
    status: "awaiting",
    lines: draft.lines.map((l) => ({ item: l.item, price: l.price, unit: l.unit, removed: false, question: l.question })),
    log: [],
  };
  const message = renderList(session);
  session.log.push({ at: now().toISOString(), from: "stallsnap", version: 1, text: message });
  return { session, message };
}

const YES = /^(yes|yess+|yes please|yes publish|publish|yeah|yep|ok|okay|oya|correct|e correct|all correct|everything correct|na so|confirm|confirmed|confam|send|send am|go ahead|good|fine|perfect|sure|👍|✅)$/i;
const NO = /^(no|nope|not correct|e no correct|wrong|e wrong)$/i;
const REMOVE_FIRST = /^(?:remove|comot|delete|cancel|no sell|i no sell|don finish|finish|out of stock)\s+(?:item\s+|number\s+|no\.?\s*)?(\d{1,3})$/i;
const REMOVE_LAST = /^(?:item\s+|number\s+)?(\d{1,3})\s+(?:comot|remove|delete|don finish|finish|no dey|no more|out of stock)$/i;
// Names come from a photo guess (SAM matches loosely), so the trader can fix them: "name 2 Horlicks sachet".
const RENAME = /^(?:name|rename|call)\s+(?:item\s+|number\s+)?(\d{1,3})\s*(?:[:=-]|\s+(?:as|na|to))?\s+(.{2,60})$/i;
const BY_NUMBER = /^(?:item\s+|number\s+|no\.?\s*)?(\d{1,3})\s*(?:[.):=-]\s*|\s+(?:na|is|be|for|price|now)\s+|\s+)(.+)$/i;
const BY_NAME = /^(.+?)\s+(?:na|is|be|price|now|=|:)\s+(.+)$/i;
const CORRECTION = /\b(?:no no|no wait|no|sorry|i mean|make am|change am to)\b/i;
const STOP = new Set(["the", "and", "one", "dis", "dat", "this", "that", "big", "small", "for", "with"]);

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter((w) => w.length > 2 && !STOP.has(w));
}

type Change = { index: number; price?: number; unit?: SaleUnit; remove?: true; name?: string };

/** Reads the price part of a clause: "1800", "100 per sachet", "6k for one paint", "1800 no 1900". */
function readPrice(text: string): { price: number; unit?: SaleUnit } | null {
  // A correction inside the reply: the last value wins, and if the last value is unclear, so is the clause.
  // "na 3500, no be 3000" is Pidgin for "3500, not 3000": the denied value is dropped before corrections are read.
  const kept = text.replace(/[,\s]*\b(?:no be|not|e no be)\s+[^,]+$/i, "");
  const parts = kept.split(CORRECTION).map((p) => p.trim()).filter(Boolean);
  let last = parts[parts.length - 1];
  if (!last) return null;
  let unit: SaleUnit | undefined;
  const m = last.match(/^(.*?)\s*\b(?:per|each|for one|for each|for|a|one)\s+([a-z ]+?)$/i);
  if (m) {
    const u = unitWord(m[2]!.trim());
    if (u) {
      unit = u;
      last = m[1]!;
    }
  }
  const p = parsePrice(last);
  return p.ok ? { price: p.naira, unit } : null;
}

function findByName(s: Session, name: string): number | "ambiguous" | null {
  const want = tokens(name);
  if (!want.length) return null;
  let best = 0;
  let hits: number[] = [];
  s.lines.forEach((l, i) => {
    if (l.removed) return;
    const have = new Set(tokens(l.item.name));
    const score = want.filter((w) => have.has(w) || have.has(w.replace(/s$/, ""))).length;
    if (score > best) {
      best = score;
      hits = [i];
    } else if (score === best && score > 0) hits.push(i);
  });
  if (!best) return null;
  return hits.length === 1 ? hits[0]! : "ambiguous";
}

function parseClause(s: Session, clause: string): Change | "yes" | "no" | { error: string } {
  // A trailing "o" is Pidgin emphasis ("yes o", "correct o").
  const c = clause.trim().replace(/[!?.]+$/, "").replace(/\s+o$/i, "").trim();
  if (YES.test(c)) return "yes";
  if (NO.test(c)) return "no";
  const valid = (n: number) => n >= 1 && n <= s.lines.length && !s.lines[n - 1]!.removed;
  const rm = c.match(REMOVE_FIRST) ?? c.match(REMOVE_LAST);
  if (rm) {
    const n = Number(rm[1]);
    return valid(n) ? { index: n - 1, remove: true } : { error: `no item ${n} for the list` };
  }
  const rn = c.match(RENAME);
  if (rn) {
    const n = Number(rn[1]);
    return valid(n) ? { index: n - 1, name: rn[2]!.trim() } : { error: `no item ${n} for the list` };
  }
  const bn = c.match(BY_NUMBER);
  if (bn) {
    const n = Number(bn[1]);
    if (!valid(n)) return { error: `no item ${n} for the list` };
    const p = readPrice(bn[2]!);
    if (!p) return { error: `I no understand the price for item ${n}` };
    return { index: n - 1, ...p };
  }
  const bm = c.match(BY_NAME);
  if (bm) {
    const i = findByName(s, bm[1]!);
    if (i === "ambiguous") return { error: `"${bm[1]}" fit be more than one item, abeg use the number` };
    if (i === null) return { error: `I no find "${bm[1]}" for the list` };
    const p = readPrice(bm[2]!);
    if (!p) return { error: `I no understand the price for ${s.lines[i]!.item.name}` };
    return { index: i, ...p };
  }
  return { error: `I no understand "${c}"` };
}

function splitClauses(reply: string): string[] {
  return reply
    // A comma before "no", "not" or "no be" is part of a correction, not a new clause.
    .split(/\n|;|,\s+(?!(?:no|not|no be|e no be|sorry|i mean)\b)|(?<=\D)\.\s+|\s+and\s+|\s+&\s+/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Applies the trader's reply and adds the reply and the answer to the audit log. */
export function handleReply(session: Session, reply: string, now: () => Date = () => new Date()): ReplyResult {
  const r = decide(session, reply);
  const at = now().toISOString();
  r.session = {
    ...r.session,
    log: [
      ...session.log,
      { at, from: "trader", version: session.version, text: reply },
      { at, from: "stallsnap", version: r.session.version, text: r.message },
    ],
  };
  return r;
}

function decide(session: Session, reply: string): ReplyResult {
  let yes = false;
  let no = false;
  const changes: Change[] = [];
  const notUnderstood: string[] = [];
  for (const clause of splitClauses(reply)) {
    const r = parseClause(session, clause);
    if (r === "yes") yes = true;
    else if (r === "no") no = true;
    else if ("error" in r) notUnderstood.push(r.error);
    else changes.push(r);
  }

  const wasConfirmed = session.status === "confirmed";
  if (wasConfirmed && !changes.length && !notUnderstood.length) {
    return { session, message: "Your catalogue don already confirm.", notUnderstood };
  }

  if (notUnderstood.length) {
    // Nothing in a part-understood reply is applied: the trader may have meant the parts together.
    return {
      session,
      notUnderstood,
      message: [`Sorry, ${notUnderstood.join("; ")}.`, "Nothing don change. Abeg send am again.", "", renderList(session)].join("\n"),
    };
  }

  if (changes.length) {
    const lines = session.lines.map((l) => ({ ...l }));
    for (const ch of changes) {
      const l = lines[ch.index]!;
      if (ch.remove) l.removed = true;
      else if (ch.name) l.item = { ...l.item, name: ch.name };
      else {
        l.price = ch.price!;
        if (ch.unit) l.unit = ch.unit;
      }
    }
    // Any change makes a new list, and only a yes to that new list confirms it.
    // A change after a YES (the trader taps Yes, then corrects) reopens the list the same way.
    const next: Session = { version: session.version + 1, status: "awaiting", lines, log: session.log };
    return {
      session: next,
      notUnderstood,
      ...(wasConfirmed ? { reopened: true } : {}),
      message: ["I don change am. Check again:", "", renderList(next)].join("\n"),
    };
  }

  if (yes && !no) {
    const open = session.lines.filter((l) => !l.removed && l.price === null);
    if (open.length && session.warnedUnpriced !== session.version) {
      // One extra check before items go out with no price, so a quick YES doesn't skip the questions.
      const next: Session = { ...session, warnedUnpriced: session.version };
      return {
        session: next,
        notUnderstood,
        message: [
          `${open.map((l) => l.item.name).join(", ")} still get no price.`,
          ...open.map((l) => l.question ?? `Abeg, ${l.item.name} na how much?`),
          'Send the price, like: 2 na 1800. Or reply YES again to show them as "Ask for price".',
        ].join("\n"),
      };
    }
    const next: Session = { ...session, status: "confirmed", confirmedReply: reply };
    return { session: next, notUnderstood, message: "Thank you! Your catalogue dey ready." };
  }

  return {
    session,
    notUnderstood,
    message: [
      no ? "Which one no correct? Send the number and the right price, like: 2 na 1800" : "Abeg reply YES if everything correct, or send the changes.",
      "",
      renderList(session),
    ].join("\n"),
  };
}

/** The only way to get a catalogue. Throws unless the trader confirmed the latest list. */
export function publish(session: Session): Catalogue {
  if (session.status !== "confirmed" || !session.confirmedReply) {
    throw new Error("Not confirmed by the trader: nothing is published until they reply YES to the latest list.");
  }
  return {
    confirmedVersion: session.version,
    confirmedReply: session.confirmedReply,
    log: session.log,
    lines: session.lines
      .filter((l) => !l.removed)
      .map((l) => ({ itemId: l.item.id, name: l.item.name, price: l.price, unit: l.unit })),
  };
}
