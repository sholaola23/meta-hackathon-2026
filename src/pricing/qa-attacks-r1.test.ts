// QA round 1 attacks on PR #3. Each one failed on 88f3355. Fold them into messy-inputs.json (or keep this file) so CI runs them.
import { describe, expect, test } from "bun:test";
import { handleReply, publish, startConfirmation } from "./confirm";
import { parsePrice } from "./price";
import type { Draft } from "./types";

function d(rows: [string, string, number | null, any][]): Draft {
  return {
    rejected: [],
    lines: rows.map(([id, name, price, unit]) => ({
      item: { id, name }, status: price === null ? "unpriced" : "priced", price, unit, quote: "", replaced: [],
      ...(price === null ? { question: `Abeg, ${name} na how much?` } : {}),
    })),
  };
}
const base = d([
  ["i1", "Milo tin", 3500, "tin"], ["i2", "Milo sachet", 100, "sachet"], ["i3", "Peak milk tin (big)", 1800, "tin"],
  ["i4", "Indomie noodles (single pack)", 250, "pack"], ["i5", "Bread loaf (big)", 1600, "loaf"],
]);
const play = (replies: string[], draft = base) => {
  let { session } = startConfirmation(draft);
  let last: ReturnType<typeof handleReply> | undefined;
  for (const r of replies) { last = handleReply(session, r); session = last.session; }
  return { session, last: last! };
};

describe("B1: a change by name must not land on a different size or pack of the product", () => {
  for (const [reply, id, was] of [
    ["Peak milk small tin na 900", "i3", 1800],
    ["small Peak milk na 900", "i3", 1800],
    ["small bread na 800", "i5", 1600],
    ["Indomie carton na 7000", "i4", 250],
    ["Indomie super pack na 400", "i4", 250],
    ["Milo sachet strip na 1200", "i2", 100],
  ] as const) {
    test(reply, () => {
      const { session, last } = play([reply]);
      expect(session.lines.find((l) => l.item.id === id)!.price).toBe(was);
      expect(last.notUnderstood.length).toBeGreaterThan(0);
    });
  }
});

describe("B2/B3/B4: the price parser must refuse, not guess", () => {
  for (const s of ["1800o", "100o", "3500o", "2000O"]) test(`Pidgin "o" glued to a number is not a zero: ${s}`, () => expect(parsePrice(s).ok).toBe(false));
  for (const s of ["k", "K"]) test(`a lone scale letter is not a price: ${s}`, () => expect(parsePrice(s).ok).toBe(false));
  for (const s of ["twelve fifty", "fifteen fifty", "twenty fifty"]) test(`words are not summed into nonsense: ${s}`, () => {
    const r = parsePrice(s);
    expect(r.ok && r.naira < 1000).toBe(false);
  });
});

describe("B5: a dangling 'no' is a part we don't understand", () => {
  test("2 na 1800 no", () => {
    const { session, last } = play(["2 na 1800 no"]);
    expect(session.lines[1]!.price).toBe(100);
    expect(last.notUnderstood.length).toBeGreaterThan(0);
  });
});

describe("B6: 'no' right after YES tells the trader how to fix it", () => {
  test("yes then no", () => {
    const { last } = play(["yes", "no"]);
    expect(last.message).not.toBe("Your catalogue don already confirm.");
    expect(last.message).toMatch(/number|change/i);
  });
});

describe("B7: every published price has a sale unit", () => {
  test("an unpriced item priced in the reply without a unit", () => {
    const up = d([["i1", "Milo tin", 3500, "tin"], ["i2", "Sugar cubes pack", null, null]]);
    const { session } = play(["yes", "2 na 1200", "yes", "yes"], up);
    if (session.status === "confirmed") for (const l of publish(session).lines) if (l.price !== null) expect(l.unit).not.toBeNull();
  });
});

describe("B9: a session saved before the audit log existed still gets an answer", () => {
  test("no log field", () => {
    const old: any = { version: 1, status: "awaiting", lines: [{ item: { id: "i1", name: "Milo tin" }, price: 3500, unit: "tin", removed: false }] };
    expect(() => handleReply(old, "yes")).not.toThrow();
  });
});
