// Test (b): Pidgin voice note -> Muse Voice Transcribe -> Muse Spark agent with tool calls -> priced item list.
// Scored against test-material/voice/answer-key.json.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_URL, client, cached, fileHash, imageDataUrl, logCall, ROOT } from "./lib";

const OUT = join(ROOT, "test-results/day1");
const WAV_DIR = join(ROOT, "test-results/cache/wav");
mkdirSync(WAV_DIR, { recursive: true });
mkdirSync(OUT, { recursive: true });

const key = JSON.parse(readFileSync(join(ROOT, "test-material/voice/answer-key.json"), "utf8"));
const stalls = JSON.parse(readFileSync(join(ROOT, "test-material/stalls.json"), "utf8"));

// The photo the trader would have sent with the note (stall 4 uses v2; see test-material/README.md).
const PHOTO: Record<string, string> = {
  "stall-1-provisions": "images/stall-1-provisions-v1.jpg",
  "stall-2-fabrics": "images/stall-2-fabrics-v1.jpg",
  "stall-3-phone-accessories": "images/stall-3-phone-accessories-v1.jpg",
  "stall-4-foodstuff": "images/stall-4-foodstuff-v2.jpg",
  "stall-5-mixed-cluttered": "images/stall-5-mixed-cluttered-v1.jpg",
};

/** WhatsApp .ogg (Opus) -> mono 16-bit PCM WAV at 24 kHz, as dev.meta.ai/docs/speech-to-text requires. */
function toWav(src: string): string {
  const out = join(WAV_DIR, src.split("/").pop()!.replace(/\.[^.]+$/, ".wav"));
  if (!existsSync(out))
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", src, "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-map_metadata", "-1", out]);
  return out;
}

function durationSec(wav: string) {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav]).toString());
}

export async function transcribe(audio: string, keywords: string[]): Promise<{ transcript: string; seconds: number }> {
  const wav = toWav(audio);
  const request = { model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "PUSH_TO_TALK", ...(keywords.length ? { keywords } : {}) };
  return cached("asr", { audio: fileHash(wav), request }, async () => {
    const form = new FormData();
    form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
    form.append("audio", new Blob([readFileSync(wav)], { type: "audio/wav" }), "note.wav");
    const res = await fetch(`${BASE_URL}/asr/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY}`, Accept: "application/json" },
      body: form,
    });
    if (!res.ok) throw new Error(`transcribe ${res.status}: ${await res.text()}`);
    const body: any = await res.json();
    const seconds = durationSec(wav);
    logCall({ model: "muse-voice-transcribe-1.0", audio, keywords: keywords.length, seconds });
    return { transcript: body.transcript as string, seconds };
  });
}

const TOOLS = [
  {
    type: "function",
    name: "set_price",
    description: "Record the price the trader said for one item. Call it again for the same item if the trader corrects themselves; the last call wins.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["item_id", "price_naira", "quote"],
      properties: {
        item_id: { type: "string", description: "The id of the item from the stall list" },
        price_naira: { type: "integer", description: "Price per unit in naira, as a whole number (for example 1.8 or one-eight means 1800)" },
        quote: { type: "string", description: "The words in the transcript that give this price" },
      },
    },
  },
  {
    type: "function",
    name: "flag_missing_price",
    description: "Mark an item on the stall that the trader did not give a price for.",
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
    description: "Send the trader one short question in simple Pidgin English, for example to ask the price of an unpriced item or to confirm which item a price belongs to.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["question", "item_ids"],
      properties: { question: { type: "string" }, item_ids: { type: "array", items: { type: "string" } } },
    },
  },
];

const SYSTEM = `You turn a Nigerian market trader's voice note into a priced catalogue.
You get the list of items on the stall (with ids), a photo of the stall, and the transcript of the trader's voice note in Nigerian Pidgin.
Use the tools: call set_price for every item the trader prices, flag_missing_price for every item with no price, and ask_trader to ask about anything unpriced or unclear.
Rules: prices are in naira. Shorthand: "1.8" or "one-eight" after a thousands context means 1800, "3k" means 3000, "six-five" means 6500, "tree" means three, "tousand" means thousand. If the trader corrects a price, the final value wins. A price said for a group ("all the Ankara", "all of them") applies to every matching item. Sizes and capacities (75cl, one litre, 20000mAh) are not prices. Figures of speech are not prices. Reduplication ("one-fifty one-fifty") means that price each. Never invent a price.
When every item is either priced or flagged, reply with a one-line summary.`;

interface Outcome {
  prices: Record<string, number>;
  quotes: Record<string, string>;
  flagged: string[];
  questions: { question: string; item_ids: string[] }[];
  rounds: number;
  summary: string;
}

export async function matchPrices(stallId: string, transcript: string, variant: string): Promise<Outcome> {
  const items = stalls.stalls.find((s: any) => s.id === stallId).items.map((it: any, i: number) => ({ id: `i${i + 1}`, name: it.name }));
  const photo = join(ROOT, "test-material", PHOTO[stallId]!);
  const user = `Items on the stall:\n${items.map((i: any) => `${i.id}: ${i.name}`).join("\n")}\n\nTranscript of the voice note:\n"${transcript}"`;
  const out: Outcome = { prices: {}, quotes: {}, flagged: [], questions: [], rounds: 0, summary: "" };
  let input: any[] = [
    { type: "message", role: "system", content: SYSTEM },
    { type: "message", role: "user", content: [{ type: "input_text", text: user }, { type: "input_image", image_url: imageDataUrl(photo) }] },
  ];
  let previous: string | undefined;
  for (let round = 1; round <= 4; round++) {
    const ck = { model: "muse-spark-1.3", stallId, variant, transcript, system: SYSTEM, round, input: round === 1 ? "first" : input, photo: fileHash(photo) };
    const r: any = await cached("match", ck, async () => {
      const res: any = await client.responses.create({ model: "muse-spark-1.3", input, tools: TOOLS, previous_response_id: previous } as any);
      logCall({ model: "muse-spark-1.3", task: "match", stallId, variant, round, usage: res.usage });
      return { id: res.id, output: res.output, output_text: res.output_text, usage: res.usage };
    });
    out.rounds = round;
    const calls = (r.output ?? []).filter((o: any) => o.type === "function_call");
    if (!calls.length) {
      out.summary = r.output_text ?? "";
      break;
    }
    const results: any[] = [];
    for (const c of calls) {
      const a = JSON.parse(c.arguments);
      const name = items.find((i: any) => i.id === a.item_id)?.name;
      if (c.name === "set_price") {
        if (name) { out.prices[name] = a.price_naira; out.quotes[name] = a.quote; }
        out.flagged = out.flagged.filter((f) => f !== name);
      } else if (c.name === "flag_missing_price") {
        if (name && !(name in out.prices)) out.flagged.push(name);
      } else if (c.name === "ask_trader") out.questions.push(a);
      const reply = c.name === "ask_trader" ? "Question queued for the trader; no reply yet." : name ? "ok" : `unknown item_id ${a.item_id}`;
      results.push({ type: "function_call_output", call_id: c.call_id, output: reply });
    }
    previous = r.id;
    input = results;
  }
  return out;
}

export function score(stallId: string, o: Outcome) {
  const k = key.stalls.find((s: any) => s.id === stallId);
  const rows = Object.entries(k.expected_prices as Record<string, number>).map(([item, want]) => ({
    item, want, got: o.prices[item] ?? null, ok: o.prices[item] === want, quote: o.quotes[item] ?? "",
  }));
  const unpriced = (k.unpriced_items as string[]).map((item) => ({
    item, flagged: o.flagged.includes(item), asked: o.questions.some((q) => q.question.toLowerCase().includes(item.split(" ")[0]!.toLowerCase()) || q.item_ids.length > 0), wronglyPriced: item in o.prices,
  }));
  const extra = Object.keys(o.prices).filter((i) => !(i in k.expected_prices));
  return { rows, unpriced, extra, tricky: k.tricky_phrases };
}

if (import.meta.main) {
  const results: any[] = [];
  for (const s of key.stalls) {
    const audio = join(ROOT, "test-material/voice", s.tts_audio);
    // Keywords must be at most 30 characters each, so bias on the distinct product words rather than full names.
    const STOP = new Set(["and", "the", "pack", "single", "big", "small", "medium", "measure", "bucket", "paint", "yards", "bottle", "litre"]);
    const names = [...new Set(stalls.stalls.find((x: any) => x.id === s.id).items
      .flatMap((i: any) => i.name.replace(/\(.*?\)/g, "").split(/[\s,]+/))
      .map((w: string) => w.trim())
      .filter((w: string) => w.length > 2 && !STOP.has(w.toLowerCase())))] as string[];
    const reals = ["ogg", "opus", "m4a"].map((e) => join(ROOT, "test-material/voice", `${s.id}-real.${e}`)).filter(existsSync);
    for (const src of [audio, ...reals]) {
      for (const variant of ["plain", "keywords"]) {
        const t = await transcribe(src, variant === "keywords" ? names : []);
        const o = await matchPrices(s.id, t.transcript, `${src.split("/").pop()}:${variant}`);
        const sc = score(s.id, o);
        results.push({ stall: s.id, audio: src.split("/").pop(), variant, transcript: t.transcript, seconds: t.seconds, outcome: o, score: sc });
        const ok = sc.rows.filter((r) => r.ok).length;
        console.log(`${s.id} ${variant}: ${ok}/${sc.rows.length} prices, unpriced flagged ${sc.unpriced.filter((u) => u.flagged && !u.wronglyPriced).length}/${sc.unpriced.length}, extra ${sc.extra.length}, rounds ${o.rounds}`);
      }
    }
  }
  writeFileSync(join(OUT, "voice-results.json"), JSON.stringify(results, null, 1));
}
