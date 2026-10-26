// Replays every recorded Muse Spark run in test-material/voice/recorded/ against the answer keys, with no API calls.
// New recordings (real Pidgin notes, messy transcripts) join this suite as soon as `bun run eval` writes them.
import { describe, expect, test } from "bun:test";
import { applyToolCalls } from "./draft";
import { loadAnswerKey, loadMessyTranscripts, loadRecordings, loadStalls } from "./fixtures";
import { formatReport, scoreRecordings } from "./report";
import { scoreDraft, simulateTrader } from "./score";
import { handleReply, publish, startConfirmation } from "./confirm";

const results = scoreRecordings();

describe("recorded runs", () => {
  test("there are recordings to replay", () => expect(results.length).toBeGreaterThan(0));
  for (const { file, score, trader } of results) {
    describe(file, () => {
      test("no price invented for an item the trader didn't price", () => expect(score.invented).toEqual([]));
      test("every unpriced item is flagged with a question", () => expect(score.unpricedFlagged.length).toBe(score.unpriced));
      test("after the trader's corrections, the published catalogue matches stalls.json exactly", () =>
        expect(trader.publishedWrong).toEqual([]));
      test("the trader needs at most one round of corrections", () => expect(trader.replies.length).toBeLessThanOrEqual(3));
      test("at least 80% of prices are right before confirmation (day-one bar)", () =>
        expect(score.matchRate).toBeGreaterThanOrEqual(0.8));
    });
  }
  test("report", () => {
    console.log(formatReport(results));
  });
});

describe("answer keys", () => {
  const stalls = loadStalls();
  const keys = [...loadAnswerKey().map((k) => ({ ...k, stall: k.id })), ...loadMessyTranscripts()];
  for (const k of keys) {
    test(`${"id" in k ? k.id : ""}: every item is priced or unpriced exactly once, with a unit`, () => {
      const stall = stalls.find((s) => s.id === k.stall)!;
      const names = stall.items.map((i) => i.name).sort();
      expect([...Object.keys(k.expected_prices), ...k.unpriced_items].sort()).toEqual(names);
      expect(Object.keys(k.expected_units).sort()).toEqual(names);
      for (const t of stall.truth) expect(k.expected_units[t.name]).toBe(t.unit);
    });
  }
  test("stall-1..5 expected prices agree with stalls.json", () => {
    for (const k of loadAnswerKey()) {
      const truth = stalls.find((s) => s.id === k.id)!.truth;
      for (const [name, p] of Object.entries(k.expected_prices)) expect(truth.find((t) => t.name === name)!.price).toBe(p);
    }
  });
  test("the hanging sachets are priced per sachet, not per strip", () => {
    const k = loadAnswerKey().find((s) => s.id === "stall-5-mixed-cluttered")!;
    expect(k.expected_units["Milo sachet"]).toBe("sachet");
    expect(k.expected_units["Detergent sachet"]).toBe("sachet");
    expect(Object.keys(k.expected_prices).some((n) => /strip/i.test(n))).toBe(false);
  });
});

describe("scorer", () => {
  const stall = loadStalls().find((s) => s.id === "stall-5-mixed-cluttered")!;
  const key = loadAnswerKey().find((s) => s.id === stall.id)!;
  const call = (id: string, price: number, unit: string) => ({ name: "set_price", arguments: JSON.stringify({ item_id: id, price_naira: price, unit, quote: "" }) });
  const right = stall.truth.flatMap((t, i) => (t.name in key.expected_prices ? [call(`i${i + 1}`, t.price, t.unit)] : []));

  test("all right: every count is clean", () => {
    const s = scoreDraft(applyToolCalls(stall.items, right), key);
    expect([s.correct, s.wrongPrice.length, s.wrongUnit.length, s.missing.length, s.invented.length]).toEqual([8, 0, 0, 0, 0]);
    expect(s.unpricedFlagged).toEqual(["Sugar cubes pack"]);
  });
  test("per strip instead of per sachet is a wrong unit, not a right answer", () => {
    const s = scoreDraft(applyToolCalls(stall.items, [...right, call("i3", 100, "strip")]), key);
    expect(s.wrongUnit).toEqual([{ item: "Milo sachet", want: "sachet", got: "strip" }]);
    expect(s.matchRate).toBe(1);
    expect(s.correct).toBe(7);
  });
  test("a wrong price is counted apart from a missing one", () => {
    const calls = right.filter((c) => !c.arguments.includes('"i1"')).concat(call("i3", 900, "sachet"));
    const s = scoreDraft(applyToolCalls(stall.items, calls), key);
    expect(s.wrongPrice).toEqual([{ item: "Milo sachet", want: 100, got: 900 }]);
    expect(s.missing).toEqual(["Bottled water (75cl)"]);
  });
  test("a price on an unpriced item is invented", () => {
    const s = scoreDraft(applyToolCalls(stall.items, [...right, call("i7", 1200, "pack")]), key);
    expect(s.invented).toEqual([{ item: "Sugar cubes pack", got: 1200 }]);
    expect(s.unpricedFlagged).toEqual([]);
  });
  test("rejected calls are counted", () => {
    const s = scoreDraft(applyToolCalls(stall.items, [...right, call("i42", 100, "piece")]), key);
    expect(s.rejectedCalls).toBe(1);
  });
  test("the simulated trader fixes a wrong price and a wrong unit before publishing", () => {
    const d = applyToolCalls(stall.items, [...right, call("i3", 900, "strip")]);
    const run = simulateTrader(d, stall.truth);
    expect(run.replies[0]).toContain("3 na 100 per sachet");
    expect(run.publishedWrong).toEqual([]);
  });
  test("a trader who prices an unpriced item without a unit is asked per what, and nothing publishes without one", () => {
    const d = applyToolCalls(stall.items, right);
    let { session } = startConfirmation(d);
    session = handleReply(session, "7 na 1200").session;
    const asked = handleReply(session, "yes");
    expect(asked.session.status).toBe("awaiting");
    expect(asked.message).toContain("7. Sugar cubes pack: ₦1,200 per what?");
    session = handleReply(asked.session, "7 na 1200 per pack").session;
    session = handleReply(session, "yes").session;
    expect(publish(session).lines.find((l) => l.name === "Sugar cubes pack")).toMatchObject({ price: 1200, unit: "pack" });
  });
});
