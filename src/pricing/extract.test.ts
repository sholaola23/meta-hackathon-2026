// extractPrices with a scripted model: checks the tool loop, not the model.
import { expect, test } from "bun:test";
import { extractPrices, SYSTEM, TOOLS, type Respond } from "./extract";
import { SALE_UNITS } from "./types";

const items = [{ id: "i1", name: "Milo sachet" }, { id: "i2", name: "Sugar cubes pack" }];

test("runs tool rounds until the model stops calling tools, and returns a draft", async () => {
  const seen: unknown[][] = [];
  const respond: Respond = async ({ round, input }) => {
    seen.push(input);
    if (round === 1)
      return {
        id: "r1",
        text: "",
        calls: [
          { call_id: "c1", name: "set_price", arguments: JSON.stringify({ item_id: "i1", price_naira: 100, unit: "sachet", quote: "hundred hundred" }) },
          { call_id: "c2", name: "flag_missing_price", arguments: JSON.stringify({ item_id: "i2" }) },
          { call_id: "c3", name: "set_price", arguments: JSON.stringify({ item_id: "i9", price_naira: 5, unit: "piece", quote: "" }) },
        ],
      };
    return { id: "r2", text: "Milo priced, sugar flagged.", calls: [] };
  };
  const r = await extractPrices(items, "Milo sachet na hundred hundred", respond);
  expect(r.rounds).toBe(2);
  expect(r.summary).toBe("Milo priced, sugar flagged.");
  expect(r.draft.lines.map((l) => [l.price, l.unit])).toEqual([[100, "sachet"], [null, null]]);
  expect(r.draft.rejected.length).toBe(1);
  // The second round gets one output per call, and the unknown item is reported back to the model.
  expect(seen[1]).toEqual([
    { type: "function_call_output", call_id: "c1", output: "ok" },
    { type: "function_call_output", call_id: "c2", output: "ok" },
    { type: "function_call_output", call_id: "c3", output: "unknown item_id i9" },
  ]);
});

test("stops after maxRounds even if the model keeps calling tools", async () => {
  const respond: Respond = async ({ round }) => ({
    id: `r${round}`, text: "",
    calls: [{ call_id: `c${round}`, name: "set_price", arguments: JSON.stringify({ item_id: "i1", price_naira: 100 + round, unit: "sachet", quote: "" }) }],
  });
  const r = await extractPrices(items, "x", respond, undefined, 3);
  expect(r.rounds).toBe(3);
  expect(r.draft.lines[0]!.price).toBe(103);
});

test("set_price requires a unit from the sale-unit list, and the prompt says sachets are per sachet", () => {
  const set = TOOLS.find((t) => t.name === "set_price")!;
  expect(set.parameters.required).toContain("unit");
  expect(set.parameters.properties.unit.enum).toEqual([...SALE_UNITS]);
  expect(SYSTEM).toContain("per sachet");
  expect(SYSTEM).toContain("Never invent a price");
});
