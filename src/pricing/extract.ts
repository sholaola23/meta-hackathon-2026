// Muse Spark reads the transcript of the trader's voice note and prices the stall's items with tool calls.
// The model call is passed in, so tests replay recorded tool calls and only eval.ts spends money.
import { applyToolCalls } from "./draft";
import { parsePrice } from "./price";
import { isSaleUnit, SALE_UNITS, type Draft, type Item, type ToolCall } from "./types";

export const TOOLS = [
  {
    type: "function",
    strict: true,
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
    strict: true,
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
    strict: true,
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

/**
 * One model turn. The loop is stateless (store:false): every turn gets the whole input so far, and the
 * caller returns the response's output items so they can be replayed, reasoning included.
 */
export type Respond = (req: { round: number; input: unknown[] }) => Promise<{
  calls: (ToolCall & { call_id: string })[];
  text: string;
  /** The response's output items, replayed as input on the next turn. */
  output: unknown[];
  /** Output tokens this turn used (reasoning included), for the token budget. */
  outputTokens?: number;
}>;

export function userPrompt(items: Item[], transcript: string): string {
  return `Items on the stall:\n${items.map((i) => `${i.id}: ${i.name}`).join("\n")}\n\nTranscript of the voice note:\n"${transcript}"`;
}

/** What the loop tells the model about one of its calls. Arguments are checked here, not trusted. */
function toolOutput(c: ToolCall, known: Set<string>): string {
  if (c.name === "ask_trader") return "Question queued for the trader; no reply yet.";
  let a: any;
  try { a = JSON.parse(c.arguments); } catch { return "refused: arguments are not valid JSON"; }
  if (!known.has(a?.item_id)) return `refused: unknown item_id ${String(a?.item_id)}`;
  if (c.name === "set_price") {
    const p = parsePrice(a.price_naira);
    if (!p.ok) return `refused: price ${p.reason}; flag the item and ask the trader instead`;
    if (!isSaleUnit(a.unit)) return "price kept, but unit is not in the list";
  } else if (c.name !== "flag_missing_price") return `refused: unknown tool ${c.name}`;
  return "ok";
}

/** The same (tool, arguments) this many times means the model is looping. */
export const MAX_IDENTICAL_CALLS = 3;
/** Output tokens across the whole loop; past this the loop stops, whatever the turn count. */
export const OUTPUT_TOKEN_BUDGET = 40_000;

export async function extractPrices(
  items: Item[],
  transcript: string,
  respond: Respond,
  photoDataUrl?: string,
  maxRounds = 4,
  tokenBudget = OUTPUT_TOKEN_BUDGET,
): Promise<{ draft: Draft; calls: ToolCall[]; rounds: number; summary: string; stopped?: string; done: boolean }> {
  const content: unknown[] = [{ type: "input_text", text: userPrompt(items, transcript) }];
  if (photoDataUrl) content.push({ type: "input_image", image_url: photoDataUrl });
  // Rules go in the developer role; the photo goes only in the user message.
  const input: unknown[] = [
    { type: "message", role: "developer", content: SYSTEM },
    { type: "message", role: "user", content },
  ];
  const known = new Set(items.map((i) => i.id));
  const all: ToolCall[] = [];
  const seen = new Map<string, number>();
  let summary = "";
  let rounds = 0;
  let stopped: string | undefined;
  let tokens = 0;
  // The objective end: every item either has a price or a flag. The loop stops there rather than paying for
  // a summary turn; any flagged item without a model question gets the default Pidgin question.
  const settled = () => {
    const d = applyToolCalls(items, all);
    const flagged = new Set(all.filter((c) => c.name === "flag_missing_price").map((c) => { try { return JSON.parse(c.arguments).item_id; } catch { return null; } }));
    return d.lines.every((l) => l.status === "priced" || flagged.has(l.item.id));
  };
  for (let round = 1; round <= maxRounds; round++) {
    rounds = round;
    const r = await respond({ round, input });
    // tool_choice can only be "auto", so a plain-text answer with no calls is a normal end.
    if (!r.calls.length) {
      summary = r.text;
      break;
    }
    all.push(...r.calls.map(({ name, arguments: a }) => ({ name, arguments: a })));
    input.push(...r.output, ...r.calls.map((c) => ({ type: "function_call_output", call_id: c.call_id, output: toolOutput(c, known) })));
    for (const c of r.calls) {
      const k = `${c.name} ${c.arguments}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
      if (seen.get(k)! >= MAX_IDENTICAL_CALLS) stopped = `repeated ${c.name} ${MAX_IDENTICAL_CALLS} times`;
    }
    tokens += r.outputTokens ?? 0;
    if (!stopped && tokens > tokenBudget) stopped = `used ${tokens} output tokens, over the ${tokenBudget} budget`;
    if (stopped || settled()) break;
    if (round === maxRounds) stopped = `hit the ${maxRounds}-turn cap`;
  }
  const draft = applyToolCalls(items, all);
  return { draft, calls: all, rounds, summary, done: !stopped, ...(stopped ? { stopped } : {}) };
}
