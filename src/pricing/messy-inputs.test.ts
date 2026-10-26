// Runs every case in messy-inputs.json. Add new attacks to the JSON, not here.
import { describe, expect, test } from "bun:test";
import { handleReply, publish, startConfirmation, type Session } from "./confirm";
import { applyToolCalls } from "./draft";
import suite from "./messy-inputs.json";
import { parsePrice } from "./price";
import type { Draft, Item } from "./types";

describe("parsePrice", () => {
  for (const c of suite.prices) {
    test(`${c.attack}: ${JSON.stringify(c.input)}`, () => {
      const r = parsePrice(c.input as any);
      if (typeof c.expect === "number") expect(r).toEqual({ ok: true, naira: c.expect });
      else expect(r).toEqual({ ok: false, reason: c.expect as any });
    });
  }
});

const ITEMS: Item[] = [
  { id: "i1", name: "Milo tin" },
  { id: "i2", name: "Sugar cubes pack" },
];

describe("applyToolCalls", () => {
  for (const c of suite.toolCalls) {
    test(c.name, () => {
      const calls = c.calls.map(([name, args]) => ({ name: name as string, arguments: typeof args === "string" ? args : JSON.stringify(args) }));
      const d = applyToolCalls(ITEMS, calls);
      for (const [id, want] of Object.entries(c.expect)) {
        const l = d.lines.find((x) => x.item.id === id)!;
        if (want === null) {
          expect(l.price).toBeNull();
          expect(l.status).toBe("unpriced");
          expect(l.question).toBeString();
        } else expect([l.price, l.unit]).toEqual(want as any);
      }
      expect(d.rejected.length).toBe(c.rejected);
      for (const [id, text] of Object.entries((c as any).question ?? {})) {
        expect(d.lines.find((x) => x.item.id === id)!.question).toContain(text as string);
      }
    });
  }
});

function baseDraft(unpriced: string[] = []): Draft {
  const rows: [string, string, number, "tin" | "sachet"][] = [
    ["i1", "Milo tin", 3500, "tin"],
    ["i2", "Milo sachet", 100, "sachet"],
    ["i3", "Peak milk tin (big)", 1800, "tin"],
  ];
  return {
    rejected: [],
    lines: rows.map(([id, name, price, unit]) => {
      const off = unpriced.includes(id);
      return {
        item: { id, name }, status: off ? "unpriced" : "priced", price: off ? null : price, unit,
        quote: "", replaced: [], ...(off ? { question: `Abeg, ${name} na how much?` } : {}),
      };
    }),
  };
}

describe("confirm replies", () => {
  for (const c of suite.replies as any[]) {
    test(c.name, () => {
      let { session } = startConfirmation(baseDraft(c.unpriced));
      let anyNotUnderstood = false;
      for (const reply of c.replies) {
        const r = handleReply(session, reply);
        session = r.session;
        expect(r.message).toBeString();
        if (r.notUnderstood.length) anyNotUnderstood = true;
      }
      expect(session.status).toBe(c.status);
      expect(anyNotUnderstood).toBe(!!c.notUnderstood);
      if (c.version) expect(session.version).toBe(c.version);
      const line = (id: string) => session.lines.find((l) => l.item.id === id)!;
      for (const [id, p] of Object.entries(c.prices ?? {})) expect(line(id).price).toBe(p as any);
      for (const [id, u] of Object.entries(c.units ?? {})) expect(line(id).unit).toBe(u as any);
      for (const id of c.removed ?? []) expect(line(id).removed).toBe(true);
      for (const [id, n] of Object.entries(c.names ?? {})) expect(line(id).item.name).toBe(n as any);
      if (c.status === "confirmed") {
        const cat = publish(session);
        for (const id of c.removed ?? []) expect(cat.lines.some((l) => l.itemId === id)).toBe(false);
        for (const [id, n] of Object.entries(c.names ?? {})) expect(cat.lines.find((l) => l.itemId === id)!.name).toBe(n as any);
      } else expect(() => publish(session)).toThrow(/Not confirmed/);
    });
  }
});

describe("publish gate", () => {
  test("a fresh draft cannot be published", () => {
    expect(() => publish(startConfirmation(baseDraft()).session)).toThrow(/Not confirmed/);
  });
  test("a hand-built confirmed session without the trader's reply cannot be published", () => {
    const s: Session = { ...startConfirmation(baseDraft()).session, status: "confirmed" };
    expect(() => publish(s)).toThrow(/Not confirmed/);
  });
  test("a plain yes after confirmation changes nothing", () => {
    let { session } = startConfirmation(baseDraft());
    session = handleReply(session, "yes").session;
    const r = handleReply(session, "yes");
    expect([r.session.status, r.session.version]).toEqual(["confirmed", 1]);
    expect(r.session.lines).toEqual(session.lines);
    expect(r.reopened).toBeUndefined();
  });
  test("the audit log records every list and reply, and travels with the catalogue", () => {
    const clock = () => new Date("2026-10-26T12:00:00Z");
    let { session } = startConfirmation(baseDraft(), clock);
    session = handleReply(session, "1 na 3600", clock).session;
    session = handleReply(session, "yes", clock).session;
    const cat = publish(session);
    expect(cat.log.map((e) => [e.from, e.version])).toEqual([
      ["stallsnap", 1], ["trader", 1], ["stallsnap", 2], ["trader", 2], ["stallsnap", 2],
    ]);
    expect(cat.log[1]!.text).toBe("1 na 3600");
    expect(cat.log[2]!.text).toContain("₦3,600 per tin");
    expect(cat.log.every((e) => e.at === "2026-10-26T12:00:00.000Z")).toBe(true);
  });
  test("a change after confirmation reopens the list with a new version, and a new YES confirms it", () => {
    let { session } = startConfirmation(baseDraft());
    session = handleReply(session, "yes").session;
    const r = handleReply(session, "1 na 3600");
    expect(r.reopened).toBe(true);
    expect(r.session.status).toBe("awaiting");
    expect(r.session.version).toBe(2);
    expect(() => publish(r.session)).toThrow(/Not confirmed/);
    const done = handleReply(r.session, "yes").session;
    expect(publish(done)).toMatchObject({ confirmedVersion: 2 });
    expect(publish(done).lines.find((l) => l.itemId === "i1")!.price).toBe(3600);
  });
  test("an unclear reply after confirmation keeps the confirmed list", () => {
    let { session } = startConfirmation(baseDraft());
    session = handleReply(session, "yes").session;
    const r = handleReply(session, "1 na 3000-3600");
    expect(r.session.status).toBe("confirmed");
    expect(r.notUnderstood.length).toBe(1);
  });
  test("the list shows every price with its unit and every question", () => {
    const { message } = startConfirmation(baseDraft(["i3"]));
    expect(message).toContain("1. Milo tin: ₦3,500 per tin");
    expect(message).toContain("2. Milo sachet: ₦100 per sachet");
    expect(message).toContain("3. Peak milk tin (big): NO PRICE. Abeg, Peak milk tin (big) na how much?");
    expect(message).toContain('"Ask for price"');
  });
  test("an unpriced line is published as null, never as a number", () => {
    let { session } = startConfirmation(baseDraft(["i3"]));
    session = handleReply(session, "yes").session;
    session = handleReply(session, "yes").session;
    expect(publish(session).lines.find((l) => l.itemId === "i3")!.price).toBeNull();
  });
});
