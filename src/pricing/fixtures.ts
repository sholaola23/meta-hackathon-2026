// Loads the test stalls, the answer key and recorded model runs from test-material/.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyStall, TruthItem } from "./score";
import type { Item, ToolCall } from "./types";

export const ROOT = join(import.meta.dir, "..", "..");
export const VOICE_DIR = join(ROOT, "test-material/voice");
export const RECORDED_DIR = join(VOICE_DIR, "recorded");

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

export interface Stall {
  id: string;
  items: Item[];
  truth: TruthItem[];
}

export function loadStalls(): Stall[] {
  return read(join(ROOT, "test-material/stalls.json")).stalls.map((s: any) => ({
    id: s.id,
    items: s.items.map((it: any, i: number) => ({ id: `i${i + 1}`, name: it.name })),
    truth: s.items.map((it: any) => ({ name: it.name, price: it.price, unit: it.unit })),
  }));
}

export function loadAnswerKey(): (KeyStall & { tts_audio: string })[] {
  return read(join(VOICE_DIR, "answer-key.json")).stalls;
}

/** Hand-written transcripts with messy prices, run against a stall's item list. */
export interface MessyCase extends KeyStall {
  stall: string;
  attacks: string[];
  transcript: string;
}

export function loadMessyTranscripts(): MessyCase[] {
  return read(join(VOICE_DIR, "messy-transcripts.json")).cases;
}

/** One recorded model run: the tool calls Muse Spark made for one transcript. */
export interface Recording {
  /** Answer-key stall id, or messy-transcripts case id. */
  case: string;
  stall: string;
  source: string;
  audio: string | null;
  model: string;
  recorded_at: string;
  /** False for day-one runs, which predate the unit field. */
  units_recorded: boolean;
  transcript: string;
  tool_calls: ToolCall[];
}

export function loadRecordings(): { file: string; rec: Recording }[] {
  if (!existsSync(RECORDED_DIR)) return [];
  return readdirSync(RECORDED_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ file, rec: read(join(RECORDED_DIR, file)) as Recording }));
}
