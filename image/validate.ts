// Live validation of the image step: runs cut-out and catalogue pictures on a set of photos and writes, per photo,
// a summary JSON, a mask overlay and a sheet of the actual catalogue pictures for scoring by eye. Outputs stay out of
// git (test-results/image/ is ignored). Muse Image restyles only the cover picture of each item, one per photo (its biggest item), at most RESTYLES per run.
// Usage (needs MODEL_API_KEY unless every response is cached):
//   bun image/validate.ts held-out        the held-out photos (scored against test-material/held-out/lots.json)
//   bun image/validate.ts real            the 8 real photos from the day-one test
//   bun image/validate.ts <file.jpg>...   any photos
import sharp, { type OverlayOptions } from "sharp";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SpendGuard } from "../src/spend-guard";
import { composeCatalogueImage, defaultBackdrop, restyleCatalogueImage } from "./catalogue-image";
import { cutOut, type Crop } from "./cutout";
import { liveCalls, museImageRestyle } from "./live";
import { area } from "./mask";
import { preparePhoto } from "./photo";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "test-results/image");
const SETS: Record<string, string> = { "held-out": "test-material/held-out", real: "test-material/real-photos" };

function photosFor(args: string[]): string[] {
  return args.flatMap((a) => {
    const dir = SETS[a];
    if (!dir) return [a];
    return readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".jpg")).sort().map((f) => join(ROOT, dir, f));
  });
}

async function overlay(photo: string, crops: Crop[], out: string) {
  const meta = await sharp(photo).metadata();
  const W = meta.width!, H = meta.height!;
  const rgba = Buffer.alloc(W * H * 4);
  for (const c of crops)
    for (let y = 0; y < c.rasterH; y++)
      for (let x = 0; x < c.rasterW; x++) {
        const px = c.box.left + x, py = c.box.top + y;
        if (!c.raster[y * c.rasterW + x] || px >= W || py >= H) continue;
        const o = (py * W + px) * 4;
        rgba[o] = (c.number * 97) % 255; rgba[o + 1] = (c.number * 57 + 80) % 255; rgba[o + 2] = (c.number * 31 + 160) % 255; rgba[o + 3] = 120;
      }
  const labels = crops
    .map((c) => `<text x="${c.box.left + 4}" y="${c.box.top + 24}" font-size="24" font-family="Helvetica" font-weight="bold" fill="white" stroke="black" stroke-width="1">${c.number}</text>`)
    .join("");
  await sharp(photo)
    .composite([{ input: rgba, raw: { width: W, height: H, channels: 4 } }, { input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${labels}</svg>`) }])
    .resize({ width: 1500, height: 1500, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toFile(out);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function sheet(tiles: { png: Buffer; label: string }[], out: string) {
  const TILE = 180, COLS = 8, LABEL = 22;
  const rows = Math.max(1, Math.ceil(tiles.length / COLS));
  const parts: OverlayOptions[] = [];
  for (const [i, t] of tiles.entries()) {
    const col = i % COLS, row = Math.floor(i / COLS);
    parts.push({ input: await sharp(t.png).resize(TILE, TILE - LABEL).png().toBuffer(), left: col * TILE, top: row * TILE + LABEL });
    parts.push({
      input: Buffer.from(`<svg width="${TILE}" height="${LABEL}" xmlns="http://www.w3.org/2000/svg"><text x="3" y="16" font-size="13" font-family="Helvetica">${esc(t.label)}</text></svg>`),
      left: col * TILE,
      top: row * TILE,
    });
  }
  const img = await sharp({ create: { width: COLS * TILE, height: rows * TILE, channels: 3, background: "#ffffff" } }).composite(parts).png().toBuffer();
  await sharp(img).resize({ width: 1500, height: 1500, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(out);
}

const RESTYLES = 13;

if (import.meta.main) {
  const photos = photosFor(process.argv.slice(2));
  if (!photos.length) throw new Error("Name a set (held-out, real) or some photos");
  mkdirSync(join(OUT, "restyle"), { recursive: true });
  const guard = new SpendGuard();
  const before = guard.today();
  const backdrop = await defaultBackdrop();
  let restyles = 0;

  for (const input of photos) {
    const stem = basename(input, ".jpg");
    const job = `validate-${stem}`;
    const photo = await preparePhoto(input, join(OUT, "prepared"));
    const r = await cutOut(photo.path, photo.width, photo.height, liveCalls(guard, job, { width: photo.width, height: photo.height }));
    const bytes = readFileSync(photo.path);
    const tiles: { png: Buffer; label: string }[] = [];
    const pictures: { number: number; name: string; source: string; rejected?: string; edgeShare?: number; maxChannelDiff: number }[] = [];
    // One restyle per photo, on its biggest item, so the cap spreads across photos.
    const biggest = [...r.items].sort((a, b) => area(b.cover) - area(a.cover))[0];
    for (const it of r.items) {
      const composed = await composeCatalogueImage(bytes, it.cover, backdrop);
      const raw = it === biggest && restyles < RESTYLES ? (restyles++, await museImageRestyle(guard, job, composed.png)) : null;
      if (raw) writeFileSync(join(OUT, "restyle", `${stem}-${it.number}-raw.png`), raw);
      const final = await restyleCatalogueImage(composed, raw);
      tiles.push({ png: final.png, label: `${it.number} ${it.name}${final.source === "muse-image" ? " *" : ""}`.slice(0, 24) });
      pictures.push({ number: it.number, name: it.name, source: final.source, rejected: final.rejected, edgeShare: final.edgeShare, maxChannelDiff: final.fidelity.maxChannelDiff });
    }
    const crops = r.items.flatMap((it) => it.crops.map((c) => ({ ...c, number: it.number })));
    await overlay(photo.path, crops, join(OUT, `${stem}-overlay.jpg`));
    if (tiles.length) await sheet(tiles, join(OUT, `${stem}-catalogue.jpg`));
    const summary = {
      photo: input.replace(ROOT + "/", ""),
      status: r.status,
      products: r.products,
      phrases: r.phrases,
      people: r.people,
      items: r.items.map((it) => ({ number: it.number, name: it.name, source: it.source, crops: it.crops.length, cover: { box: it.cover.box, phrase: it.cover.phrase, confidence: it.cover.confidence } })),
      rejected: r.rejected,
      boxPrompts: r.boxPrompts,
      reviewError: r.reviewError,
      dropped: r.dropped,
      pictures,
    };
    writeFileSync(join(OUT, `${stem}.json`), JSON.stringify(summary, null, 1));
    const byReason = r.dropped.reduce<Record<string, number>>((a, d) => ((a[d.reason] = (a[d.reason] ?? 0) + 1), a), {});
    const used = pictures.filter((p) => p.source === "muse-image").length;
    console.log(
      `${stem}: ${r.products.length} products, ${r.phrases.length} phrases, ${r.people} people, ${r.items.length} items, ${r.rejected.length} rejected, ${r.boxPrompts} box prompts${r.reviewError ? `, REVIEW FAILED: ${r.reviewError}` : ""}, dropped ${JSON.stringify(byReason)}, restyles used ${used}/${pictures.filter((p) => p.source === "muse-image" || p.rejected).length}, worst pixel diff ${Math.max(0, ...pictures.map((p) => p.maxChannelDiff))}`,
    );
  }
  const after = guard.today();
  console.log(`spend this run: $${(after.spentUsd - before.spentUsd).toFixed(4)} in ${after.calls - before.calls} paid calls (today $${after.spentUsd.toFixed(4)})`);
}
