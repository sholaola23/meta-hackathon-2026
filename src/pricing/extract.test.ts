// extractPrices with a scripted model: checks the tool loop, not the model.
import { expect, test } from "bun:test";
import { extractPrices, MAX_IDENTICAL_CALLS, SYSTEM, TOOLS, type Respond } from "./extract";
import { SALE_UNITS } from "./types";

const items = [{ id: "i1", name: "Milo sachet" }, { id: "i2", name: "Sugar cubes pack" }];
const fc = (call_id: string, name: string, args: unknown) => ({ call_id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) });

test("stateless loop: replays the output items, then one output per call in call order", async () => {
  const seen: unknown[][] = [];
  const reasoning = { type: "reasoning", encrypted_content: "opaque" };
  const respond: Respond = async ({ round, input }) => {
    seen.push(structuredClone(input));
    if (round === 1) {
      const calls = [
        fc("c1", "set_price", { item_id: "i1", price_naira: 100, unit: "sachet", quote: "hundred hundred" }),
        fc("c2", "flag_missing_price", { item_id: "i2" }),
        fc("c3", "set_price", { item_id: "i9", price_naira: 500, unit: "piece", quote: "" }),
        fc("c4", "set_price", { item_id: "i2", price_naira: "2000-2500", unit: "pack", quote: "two or two-five" }),
      ];
      return { calls, text: "", output: [reasoning, ...calls.map((c) => ({ type: "function_call", ...c }))] };
    }
    return { calls: [], text: "Milo priced, sugar flagged.", output: [{ type: "message", content: [] }] };
  };
  const r = await extractPrices(items, "Milo sachet na hundred hundred", respond);
  expect(r.rounds).toBe(2);
  expect(r.stopped).toBeUndefined();
  expect(r.summary).toBe("Milo priced, sugar flagged.");
  expect(r.draft.lines.map((l) => [l.price, l.unit])).toEqual([[100, "sachet"], [null, null]]);
  expect(r.draft.rejected.length).toBe(2);
  const first = seen[0]!;
  expect((first[0] as any).role).toBe("developer");
  expect((first[0] as any).content).toBe(SYSTEM);
  const second = seen[1]!;
  expect(second.slice(0, 2)).toEqual(first);
  expect(second[2]).toEqual(reasoning);
  expect(second.slice(7)).toEqual([
    { type: "function_call_output", call_id: "c1", output: "ok" },
    { type: "function_call_output", call_id: "c2", output: "ok" },
    { type: "function_call_output", call_id: "c3", output: "refused: unknown item_id i9" },
    { type: "function_call_output", call_id: "c4", output: "refused: price range; flag the item and ask the trader instead" },
  ]);
});

test("a plain-text first answer ends the loop with an all-unpriced draft", async () => {
  const r = await extractPrices(items, "x", async () => ({ calls: [], text: "I no hear any price.", output: [] }));
  expect(r.rounds).toBe(1);
  expect(r.draft.lines.every((l) => l.price === null && l.question)).toBe(true);
});

test(`stops after ${MAX_IDENTICAL_CALLS} identical calls`, async () => {
  const same = fc("c", "flag_missing_price", { item_id: "i2" });
  const r = await extractPrices(items, "x", async () => ({ calls: [same], text: "", output: [] }), undefined, 10);
  expect(r.rounds).toBe(MAX_IDENTICAL_CALLS);
  expect(r.stopped).toContain("repeated");
});

test("stops at the turn cap even if the model keeps calling tools", async () => {
  const respond: Respond = async ({ round }) => {
    const c = fc(`c${round}`, "set_price", { item_id: "i1", price_naira: 100 + round, unit: "sachet", quote: "" });
    return { calls: [c], text: "", output: [] };
  };
  const r = await extractPrices(items, "x", respond, undefined, 3);
  expect(r.rounds).toBe(3);
  expect(r.stopped).toContain("3-turn cap");
  expect(r.draft.lines[0]!.price).toBe(103);
});

test("tools are strict: every property required, no extra properties, unit from the sale-unit list", () => {
  for (const t of TOOLS) {
    expect(t.strict).toBe(true);
    expect(t.parameters.additionalProperties).toBe(false);
    expect([...t.parameters.required].map(String).sort()).toEqual(Object.keys(t.parameters.properties).sort());
  }
  const set = TOOLS.find((t) => t.name === "set_price")!;
  expect(set.parameters.properties.unit.enum).toEqual([...SALE_UNITS]);
  expect(SYSTEM).toContain("per sachet");
  expect(SYSTEM).toContain("Never invent a price");
});
