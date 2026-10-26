// Muse Spark reads the transcript of the trader's voice note and prices the stall's items with tool calls.
// The model call is passed in, so tests replay recorded tool calls and only eval.ts spends money.
import { applyToolCalls } from "./draft";
import { SALE_UNITS, type Draft, type Item, type ToolCall } from "./types";

export const TOOLS = [
  {
    type: "function",
    name: "set_price",
    description:
      "Record the price the trader said for one item. Call it again for the same item if the trader corrects themselves; the last call wins.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["item_id", "price_naira", "unit", "quote"],
      properties: {
        item_id: { type: "string", description: "The id of the item from the stall list" },
        price_naira: {
          type: "integer",
          description: "Price in whole naira for one unit (for example 1.8 or one-eight means 1800, 3k means 3000)",
        },
        unit: {
          type: "string",
          enum: [...SALE_UNITS],
          description:
            "What one price buys: the unit the trader sells it in, not how it is displayed. Sachets hanging on a strip are priced per sachet unless the trader prices the whole strip.",
        },
        quote: { type: "string", description: "The words in the transcript that give this price" },
      },
    },
  },
  {
    type: "function",
    name: "flag_missing_price",
    description: "Mark an item on the stall that the trader did not give a clear single price for.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["item_id"],
      properties: { item_id: { type: "string" } },
    },
  },
  {
    type: "function",
    name: "ask_trader",
    description:
      "Send the trader one short question in simple Nigerian Pidgin, for example to ask the price of an unpriced item.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["question", "item_ids"],
      properties: { question: { type: "string" }, item_ids: { type: "array", items: { type: "string" } } },
    },
  },
] as const;

export const SYSTEM = `You turn a Nigerian market trader's voice note into a priced catalogue.
You get the list of items on the stall (with ids), maybe a photo of the stall, and the transcript of the trader's voice note in Nigerian Pidgin.
Use the tools: call set_price for every item the trader prices, flag_missing_price for every item with no clear single price, and ask_trader to ask about each of those.
Rules:
- Prices are whole naira. Shorthand: "1.8" or "one-eight" means 1800, "3k" means 3000, "six-five" means 6500, "tree" means three, "tousand" means thousand.
- If the trader corrects a price, the final value wins. "No be 3k" means "not 3,000": never use a value the trader denies.
- A price said for a group ("all the Ankara", "all of them") applies to every matching item.
- Sizes and capacities (75cl, one litre, 20000mAh, six yards) are not prices. Figures of speech are not prices.
- Reduplication ("one-fifty one-fifty", "hundred hundred") means that price each.
- unit is what one price buys. "One one" or "each" after a sachet price means per sachet. "For one paint" means per paint bucket.
- If the trader gives a range or two prices for one item ("two or two-five"), or says they don't know, do not call set_price for it: flag it and ask.
- Never invent a price. Never price an item the trader did not mention.
When every item is either priced or flagged, reply with a one-line summary.`;

/** One model turn: given the input so far, return the tool calls (and text) it made. */
export type Respond = (req: {
  round: number;
  input: unknown[];
  previousResponseId?: string;
}) => Promise<{ id: string; calls: (ToolCall & { call_id: string })[]; text: string }>;

export function userPrompt(items: Item[], transcript: string): string {
  return `Items on the stall:\n${items.map((i) => `${i.id}: ${i.name}`).join("\n")}\n\nTranscript of the voice note:\n"${transcript}"`;
}

export async function extractPrices(
  items: Item[],
  transcript: string,
  respond: Respond,
  photoDataUrl?: string,
  maxRounds = 4,
): Promise<{ draft: Draft; calls: ToolCall[]; rounds: number; summary: string }> {
  const content: unknown[] = [{ type: "input_text", text: userPrompt(items, transcript) }];
  if (photoDataUrl) content.push({ type: "input_image", image_url: photoDataUrl });
  let input: unknown[] = [
    { type: "message", role: "system", content: SYSTEM },
    { type: "message", role: "user", content },
  ];
  const all: ToolCall[] = [];
  let previous: string | undefined;
  let summary = "";
  let rounds = 0;
  for (let round = 1; round <= maxRounds; round++) {
    rounds = round;
    const r = await respond({ round, input, previousResponseId: previous });
    if (!r.calls.length) {
      summary = r.text;
      break;
    }
    all.push(...r.calls.map(({ name, arguments: a }) => ({ name, arguments: a })));
    const known = new Set(items.map((i) => i.id));
    input = r.calls.map((c) => {
      let id: unknown;
      try { id = JSON.parse(c.arguments).item_id; } catch {}
      const out = c.name === "ask_trader" ? "Question queued for the trader; no reply yet." : known.has(id as string) ? "ok" : `unknown item_id ${String(id)}`;
      return { type: "function_call_output", call_id: c.call_id, output: out };
    });
    previous = r.id;
  }
  return { draft: applyToolCalls(items, all), calls: all, rounds, summary };
}
