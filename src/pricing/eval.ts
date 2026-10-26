// Live pricing eval: Muse Voice Transcribe and Muse Spark on every voice note and messy transcript,
// then writes the tool calls to test-material/voice/recorded/ so CI can replay them for free.
// Needs MODEL_API_KEY and ffmpeg. Every live call goes through SpendGuard and is cached, so a rerun costs nothing.
// Usage: bun src/pricing/eval.ts [--only <case id substring>] [--no-photo]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SpendGuard } from "../spend-guard";
import { extractPrices } from "./extract";
import { MODEL, responder as liveResponder, transcribe as liveTranscribe } from "./live";
import { loadAnswerKey, loadMessyTranscripts, loadStalls, RECORDED_DIR, ROOT, VOICE_DIR, type Recording } from "./fixtures";
import { formatReport, scoreRecordings } from "./report";

mkdirSync(RECORDED_DIR, { recursive: true });
process.env.STALLSNAP_SPEND_DIR ??= join(ROOT, "test-results/cache/spend");

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const withPhoto = !args.includes("--no-photo");
const guard = new SpendGuard();
const transcribe = (jobId: string, audio: string, items: { name: string }[]) => liveTranscribe(guard, jobId, audio, items);
const responder = (jobId: string) => liveResponder(guard, jobId);

// The photo the trader would send with the note (stall 4 uses v2; see test-material/README.md).
const PHOTO: Record<string, string> = {
  "stall-1-provisions": "images/stall-1-provisions-v1.jpg",
  "stall-2-fabrics": "images/stall-2-fabrics-v1.jpg",
  "stall-3-phone-accessories": "images/stall-3-phone-accessories-v1.jpg",
  "stall-4-foodstuff": "images/stall-4-foodstuff-v2.jpg",
  "stall-5-mixed-cluttered": "images/stall-5-mixed-cluttered-v1.jpg",
};

const photoUrl = (stallId: string) =>
  withPhoto && PHOTO[stallId] ? `data:image/jpeg;base64,${readFileSync(join(ROOT, "test-material", PHOTO[stallId]!)).toString("base64")}` : undefined;

function save(name: string, rec: Recording) {
  writeFileSync(join(RECORDED_DIR, `${name}.json`), JSON.stringify(rec, null, 1) + "\n");
  console.log(`recorded ${name}`);
}

const stalls = loadStalls();
const today = new Date().toISOString().slice(0, 10);

// 1. Every voice note: the TTS placeholder and any real recording (<stall>-real*.ogg|opus|m4a|wav).
for (const k of loadAnswerKey()) {
  const stall = stalls.find((s) => s.id === k.id)!;
  const audios = readdirSync(VOICE_DIR).filter((f) => f === k.tts_audio || (f.startsWith(`${k.id}-real`) && /\.(ogg|opus|m4a|wav)$/.test(f)));
  for (const audio of audios) {
    const name = audio.replace(/\.[^.]+$/, "");
    if (only && !name.includes(only)) continue;
    const transcript = await transcribe(name, join(VOICE_DIR, audio), stall.items);
    const { calls, stopped } = await extractPrices(stall.items, transcript, responder(name), photoUrl(k.id));
    if (stopped) console.warn(`${name}: loop stopped early (${stopped})`);
    save(name, { case: k.id, stall: k.id, source: "bun src/pricing/eval.ts", audio, model: MODEL, recorded_at: today, units_recorded: true, transcript, tool_calls: calls });
  }
}

// 2. Messy transcripts: no audio, straight to Muse Spark.
for (const c of loadMessyTranscripts()) {
  if (only && !c.id.includes(only)) continue;
  const stall = stalls.find((s) => s.id === c.stall)!;
  const { calls, stopped } = await extractPrices(stall.items, c.transcript, responder(c.id), photoUrl(c.stall));
  if (stopped) console.warn(`${c.id}: loop stopped early (${stopped})`);
  save(c.id, { case: c.id, stall: c.stall, source: "bun src/pricing/eval.ts (messy-transcripts.json)", audio: null, model: MODEL, recorded_at: today, units_recorded: true, transcript: c.transcript, tool_calls: calls });
}

console.log("\n" + formatReport(scoreRecordings()));
const t = guard.today();
console.log(`\nSpend today (${t.date} UTC, this machine): $${t.spentUsd.toFixed(4)} in ${t.calls} paid calls.`);
