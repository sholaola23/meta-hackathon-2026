// Dry run of the live pipeline without WhatsApp: one stall photo and one voice note through the real image step,
// Voice Transcribe and Muse Spark, then YES (twice if something is unpriced), publish, and the page written to disk.
// Responses are cached, so a rerun is free. Needs MODEL_API_KEY, ffmpeg, and bun install in image/ and spike/.
// Usage: bun src/whatsapp/try.ts <photo.jpg> <note.ogg> [--restyle] [--out <dir>]
// Test material only: never use its output in the demo video.
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SpendGuard } from "../spend-guard";
import { StallPipeline } from "./adapter";
import { serveCatalogue } from "./catalogue-page";
import { JobLog } from "./joblog";
import { liveModels } from "./live-models";
import type { LocalMedia } from "./pipeline";

const args = process.argv.slice(2);
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
const [photoArg, noteArg] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
if (!photoArg || !noteArg) throw new Error("usage: bun src/whatsapp/try.ts <photo.jpg> <note.ogg> [--restyle] [--out <dir>]");
// Not a STALLSNAP_* variable: the spend guard refuses settings it doesn't know.
const root = out ? resolve(out) : mkdtempSync(join(tmpdir(), "stallsnap-try-"));
const guard = new SpendGuard();
const file = (path: string, messageId: string, mimeType: string): LocalMedia => ({
  messageId,
  path: resolve(path),
  mimeType,
  bytes: statSync(path).size,
  sentAt: Math.floor(Date.now() / 1000),
});

const pipeline = new StallPipeline({
  models: liveModels(guard, { restyle: process.argv.includes("--restyle") }),
  jobLog: new JobLog(join(root, "joblog")),
  dataDir: root,
  publicDir: join(root, "public"),
  publicBaseUrl: "http://localhost:3000",
});
const jobId = "try-run";
const ids = { traderId: "try", jobId };
let t = await pipeline.start({ ...ids, photos: [file(photoArg, "wamid.TRYPHOTO", "image/jpeg")], voiceNotes: [file(noteArg, "wamid.TRYNOTE", "audio/ogg")], texts: [] });
console.log(`--- list v${t.version} ---\n${t.message}\n`);
for (let i = 0; i < 2 && !t.confirmed; i++) {
  t = await pipeline.reply({ ...ids, reply: { text: "YES" } });
  console.log(`--- after YES ---\n${t.message}\n`);
}
const { url } = await pipeline.publish(ids);
const page = serveCatalogue(new URL(url).pathname, join(root, "public"));
console.log(`published ${url} -> ${page?.status} (files in ${join(root, "public")})`);
const today = guard.today();
console.log(`Spend today (${today.date} UTC, this machine): $${today.spentUsd.toFixed(4)} in ${today.calls} paid calls.`);
