// Applies Muse Spark's tool calls to the stall's item list and gives a draft price list.
// Nothing here is published: every line still goes through the trader's confirmation (confirm.ts).
import { parsePrice } from "./price";
import { isSaleUnit, type Draft, type DraftLine, type Item, type ToolCall } from "./types";

export function askPriceQuestion(name: string): string {
  return `Abeg, ${name} na how much?`;
}

const REASON_TEXT: Record<string, string> = {
  range: "you give two prices",
  kobo: "the price get kobo",
  negative: "the price no clear",
  too_low: "the price too small",
  too_high: "the price too big",
  unreadable: "I no understand the price",
};

export function applyToolCalls(items: Item[], calls: ToolCall[]): Draft {
  const lines = new Map<string, DraftLine>(
    items.map((item) => [item.id, { item, status: "unpriced", price: null, unit: null, quote: "", replaced: [] }]),
  );
  const flagged = new Set<string>();
  const questions = new Map<string, string>();
  const rejected: Draft["rejected"] = [];

  for (const call of calls) {
    let a: any;
    try {
      a = JSON.parse(call.arguments);
    } catch {
      rejected.push({ call, reason: "arguments are not JSON" });
      continue;
    }
    if (call.name === "ask_trader") {
      const ids: unknown[] = Array.isArray(a?.item_ids) ? a.item_ids : [];
      for (const id of ids) if (typeof id === "string" && lines.has(id) && typeof a.question === "string") questions.set(id, a.question);
      continue;
    }
    const line = lines.get(a?.item_id);
    if (!line) {
      rejected.push({ call, reason: `unknown item_id ${JSON.stringify(a?.item_id)}` });
      continue;
    }
    if (call.name === "flag_missing_price") {
      flagged.add(line.item.id);
      continue;
    }
    if (call.name !== "set_price") {
      rejected.push({ call, reason: `unknown tool ${call.name}` });
      continue;
    }
    const p = parsePrice(a.price_naira);
    if (!p.ok) {
      // A price we can't read is never kept, and it also cancels any earlier price for the item,
      // because the trader's last word on it is unclear. The line goes back to the trader as a question.
      rejected.push({ call, reason: `price ${JSON.stringify(a.price_naira)}: ${p.reason}` });
      if (line.price !== null) line.replaced.push(line.price);
      Object.assign(line, { status: "unpriced", price: null, unit: null, reason: p.reason });
      continue;
    }
    if (line.price !== null && line.price !== p.naira) line.replaced.push(line.price);
    line.status = "priced";
    line.price = p.naira;
    line.unit = isSaleUnit(a.unit) ? a.unit : null;
    line.quote = typeof a.quote === "string" ? a.quote : "";
    delete line.reason;
  }

  for (const line of lines.values()) {
    if (line.status === "priced") continue;
    line.reason ??= flagged.has(line.item.id) ? "no_price" : "not_mentioned";
    const why = REASON_TEXT[line.reason];
    line.question = why
      ? `${line.item.name}: ${why}. Abeg, na how much?`
      : (questions.get(line.item.id) ?? askPriceQuestion(line.item.name));
  }
  return { lines: [...lines.values()], rejected };
}
