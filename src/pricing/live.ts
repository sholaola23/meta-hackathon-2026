// Live Meta Model API calls for pricing: Muse Voice Transcribe and the Muse Spark tool loop.
// Shared by the eval script and the WhatsApp server. Every response is cached on disk, so a rerun costs
// nothing, and every uncached call goes through SpendGuard. Needs MODEL_API_KEY and ffmpeg.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sparkUsd, voiceUsd, type SpendGuard } from "../spend-guard";
import { TOOLS, type Respond } from "./extract";
import { ROOT } from "./fixtures";

const BASE_URL = "https://api.meta.ai/v1";
export const MODEL = "muse-spark-1.3";
export const CACHE = join(ROOT, "test-results/cache/pricing");
const TOOLS_JSON = JSON.parse(JSON.stringify(TOOLS));

const hash = (x: unknown) => createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex").slice(0, 24);

async function cached<T>(kind: string, k: unknown, fn: () => Promise<T>): Promise<T> {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, `${kind}-${hash(k)}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  if (!process.env.MODEL_API_KEY) throw new Error("MODEL_API_KEY is not set and there is no cached response; nothing was called");
  const v = await fn();
  writeFileSync(file, JSON.stringify(v));
  return v;
}

/**
 * Words to bias transcription toward: the distinct words of the item names (keywords must be 30 characters
 * or fewer) and price words. Pidgin is not one of the 25 supported languages, so English is the closest bias,
 * and Muse Spark reads the result knowing it may be rough.
 */
export function keywordsFor(items: { name: string }[]): string[] {
  const STOP = new Set(["and", "the", "pack", "single", "big", "small", "medium", "measure", "bucket", "paint", "yards", "bottle", "litre"]);
  const words = items.flatMap((i) => i.name.replace(/\(.*?\)/g, "").split(/[\s,]+/)).filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()));
  return [...new Set([...words, "naira", "kobo", "tousand"])].filter((w) => w.length <= 30);
}

export async function transcribe(guard: SpendGuard, jobId: string, audio: string, items: { name: string }[]): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  // Named by content, so two notes that share a file name never share a conversion.
  const wav = join(CACHE, `${hash(readFileSync(audio).toString("base64"))}.wav`);
  if (!existsSync(wav)) execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", audio, "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-map_metadata", "-1", wav]);
  // dev.meta.ai/docs/speech-to-text: languageBias takes language names ("English"), not codes.
  const request = { model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "PUSH_TO_TALK", languageBias: ["English"], keywords: keywordsFor(items) };
  const r = await cached("asr", { audio: hash(readFileSync(wav).toString("base64")), request }, async () => {
    const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav]).toString());
    return guard.paid(jobId, request.model, voiceUsd(seconds), async () => {
      const form = new FormData();
      form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
      form.append("audio", new Blob([readFileSync(wav)], { type: "audio/wav" }), "note.wav");
      const res = await fetch(`${BASE_URL}/asr/transcribe`, { method: "POST", headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY}`, Accept: "application/json" }, body: form });
      if (!res.ok) throw new Error(`transcribe ${res.status}: ${await res.text()}`);
      return { transcript: ((await res.json()) as any).transcript as string };
    });
  });
  return r.transcript;
}

export function responder(guard: SpendGuard, jobId: string): Respond {
  return async ({ input }) => {
    // Stateless replay (dev.meta.ai/docs/reasoning#multi-turn): nothing stored server-side, reasoning replayed
    // from encrypted content. Reasoning counts against max_output_tokens, so it is set generously.
    // temperature and top_p are left unset.
    const body = { model: MODEL, input, tools: TOOLS_JSON, store: false, include: ["reasoning.encrypted_content"], max_output_tokens: 16000 };
    const r: any = await cached("spark", body, () =>
      guard.paid(jobId, MODEL, sparkUsd({ input: 6000, output: 1500 }), async () => {
        const res = await fetch(`${BASE_URL}/responses`, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`responses ${res.status}: ${await res.text()}`);
        const j: any = await res.json();
        return { output: j.output, usage: j.usage };
      }, (j) => sparkUsd({ input: j.usage?.input_tokens ?? 0, output: j.usage?.output_tokens ?? 0, cachedInput: j.usage?.input_tokens_details?.cached_tokens ?? 0 })),
    );
    const out: any[] = r.output ?? [];
    return {
      output: out,
      outputTokens: r.usage?.output_tokens ?? 0,
      calls: out.filter((o) => o.type === "function_call").map((o) => ({ name: o.name, arguments: o.arguments, call_id: o.call_id })),
      text: out.filter((o) => o.type === "message").flatMap((o) => o.content ?? []).map((c: any) => c.text ?? "").join(""),
    };
  };
}
