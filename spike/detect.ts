// Test (a): photo -> Muse Spark proposes product noun phrases -> SAM 3.1 segments each phrase.
// Writes per-photo instance summaries, a mask overlay and a crop contact sheet for scoring.
import sharp, { type OverlayOptions } from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { client, cached, imageDataUrl, fileHash, logCall, ROOT } from "./lib";
import { samInstances, type Instance } from "./sam";

const OUT = join(ROOT, "test-results/day1");
mkdirSync(OUT, { recursive: true });

export const PHOTOS = [
  "images/stall-1-provisions-v1.jpg",
  "images/stall-1-provisions-v2.jpg",
  "images/stall-2-fabrics-v1.jpg",
  "images/stall-2-fabrics-v2.jpg",
  "images/stall-3-phone-accessories-v1.jpg",
  "images/stall-3-phone-accessories-v2.jpg",
  "images/stall-4-foodstuff-v2.jpg", // v1 skipped: garri and rice look the same (test-material/README.md)
  "images/stall-5-mixed-cluttered-v1.jpg",
  "images/stall-5-mixed-cluttered-v2.jpg",
  "real-photos/real-01-onitsha-sandals-wall.jpg",
  "real-photos/real-02-buguma-pepper-okra.jpg",
  "real-photos/real-03-dry-foodstuff-basins.jpg",
  "real-photos/real-04-ikot-nakanda-foodstuff.jpg",
  "real-photos/real-05-oyingbo-fruit.jpg",
  "real-photos/real-06-provision-store.jpg",
  "real-photos/real-07-provisions-seller.jpg",
  "real-photos/real-08-balogun-ankara-alley.jpg",
];

const PROPOSE_PROMPT = `You are looking at a photo of a market stall. List every distinct type of product the trader is selling that is visible in the photo.
For each type, give a short noun phrase of 1 to 4 words that an object segmentation model can use to find every unit of it (for example "milk tin", "blue fabric bolt", "red pepper heap", "sandal"). Name the physical object, not a brand slogan, and do not include people, shelves, tables, signs or containers that are not for sale.
Return at most 12 types.`;

// v2 (written after scoring v1): v1 phrases carried colours and brand words ("blue milk tin", "green Milo sachet")
// that SAM matched to nothing. v2 asks for the plainest everyday noun, and a heap or basin word for loose goods.
const PROPOSE_PROMPT_V2 = `You are looking at a photo of a market stall. List every distinct type of product the trader is selling that is visible in the photo, including loose goods in heaps, basins, bags or baskets, and goods hanging in strips.
For each type, give "phrase": the plainest everyday English noun for one unit of it, 1 or 2 words, the way a child would name the object. No colours, no brand names, no adjectives unless two products would otherwise share a phrase. Examples: "tin", "jar", "sachet", "bottle", "egg", "bread", "okra", "pepper", "watermelon", "fabric", "basin of grain", "bag".
Do not include people, shelves, tables, signs, umbrellas, or containers that are not for sale.
Return at most 12 types.`;
const PROMPT = process.env.PROMPT_VERSION === "v2" ? PROPOSE_PROMPT_V2 : PROPOSE_PROMPT;
const SUFFIX = process.env.PROMPT_VERSION === "v2" ? "-v2prompt" : "";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["products"],
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "phrase"],
        properties: { name: { type: "string" }, phrase: { type: "string" } },
      },
    },
  },
};

export async function proposePhrases(imagePath: string): Promise<{ name: string; phrase: string }[]> {
  const key = { model: "muse-spark-1.3", image: fileHash(imagePath), prompt: PROMPT, schema: SCHEMA };
  const res = await cached("propose", key, async () => {
    const r: any = await client.responses.create({
      model: "muse-spark-1.3",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: PROMPT },
            { type: "input_image", image_url: imageDataUrl(imagePath) } as any,
          ],
        },
      ],
      text: { format: { type: "json_schema", name: "stall_products", schema: SCHEMA, strict: true } },
    } as any);
    logCall({ model: "muse-spark-1.3", task: "propose", image: imagePath, usage: r.usage });
    return { text: r.output_text as string, usage: r.usage };
  });
  return JSON.parse(res.text).products;
}

export interface Found extends Instance {
  phrase: string;
  label: string;
}

function iou(a: Instance["box"], b: Instance["box"]) {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const inter = w * h;
  const area = (r: Instance["box"]) => (r.right - r.left) * (r.bottom - r.top);
  return inter / (area(a) + area(b) - inter || 1);
}

/** Drop near-duplicate instances found by two phrases (box IoU > 0.8), keeping the more confident one. */
function dedupe(all: Found[]): Found[] {
  const sorted = [...all].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const kept: Found[] = [];
  for (const f of sorted) if (!kept.some((k) => iou(k.box, f.box) > 0.8)) kept.push(f);
  return kept;
}

const COLOURS = [
  [230, 25, 75], [60, 180, 75], [255, 225, 25], [0, 130, 200], [245, 130, 48], [145, 30, 180],
  [70, 240, 240], [240, 50, 230], [210, 245, 60], [250, 190, 212], [0, 128, 128], [170, 110, 40],
];

async function overlay(imagePath: string, found: Found[], phraseIndex: Map<string, number>, out: string) {
  const meta = await sharp(imagePath).metadata();
  const W = meta.width!, H = meta.height!;
  const rgba = Buffer.alloc(W * H * 4);
  for (const f of found) {
    const [r, g, b] = COLOURS[phraseIndex.get(f.phrase)! % COLOURS.length]!;
    for (let y = 0; y < f.rasterH; y++)
      for (let x = 0; x < f.rasterW; x++) {
        if (!f.raster[y * f.rasterW + x]) continue;
        const px = f.box.left + x, py = f.box.top + y;
        if (px >= W || py >= H) continue;
        const o = (py * W + px) * 4;
        rgba[o] = r!; rgba[o + 1] = g!; rgba[o + 2] = b!; rgba[o + 3] = 110;
      }
  }
  const rects = found
    .map((f) => {
      const [r, g, b] = COLOURS[phraseIndex.get(f.phrase)! % COLOURS.length]!;
      return `<rect x="${f.box.left}" y="${f.box.top}" width="${f.box.right - f.box.left}" height="${f.box.bottom - f.box.top}" fill="none" stroke="rgb(${r},${g},${b})" stroke-width="3"/>
<text x="${f.box.left + 4}" y="${f.box.top + 22}" font-size="20" font-family="Helvetica" fill="white" stroke="black" stroke-width="0.8">${f.label}</text>`;
    })
    .join("\n");
  const svg = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`);
  await sharp(imagePath)
    .composite([{ input: rgba, raw: { width: W, height: H, channels: 4 } }, { input: svg }])
    .resize({ width: 1500, height: 1500, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toFile(out);
}

/** Every crop on a white background (mask applied), labelled, in a grid at most 1500px wide. */
async function contactSheet(imagePath: string, found: Found[], out: string) {
  const TILE = 180, COLS = 8, LABEL = 22;
  const tiles: OverlayOptions[] = [];
  const rows = Math.max(1, Math.ceil(found.length / COLS));
  for (const [i, f] of found.entries()) {
    const w = f.rasterW, h = f.rasterH;
    const crop = await sharp(imagePath).extract({ left: f.box.left, top: f.box.top, width: Math.min(w, (await sharp(imagePath).metadata()).width! - f.box.left), height: Math.min(h, (await sharp(imagePath).metadata()).height! - f.box.top) }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { data, info } = crop;
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) if (!f.raster[y * w + x]) data[(y * info.width + x) * 4 + 3] = 0;
    const tile = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .resize(TILE, TILE - LABEL, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .flatten({ background: "#ffffff" })
      .png()
      .toBuffer();
    const col = i % COLS, row = Math.floor(i / COLS);
    tiles.push({ input: tile, left: col * TILE, top: row * TILE + LABEL });
    tiles.push({
      input: Buffer.from(`<svg width="${TILE}" height="${LABEL}" xmlns="http://www.w3.org/2000/svg"><text x="3" y="16" font-size="14" font-family="Helvetica">${f.label}</text></svg>`),
      left: col * TILE,
      top: row * TILE,
    });
  }
  // Composite first, then fit the sheet inside 1500px so it stays readable without breaking the image-size rule.
  const sheet = await sharp({ create: { width: COLS * TILE, height: rows * TILE, channels: 3, background: "#eeeeee" } })
    .composite(tiles)
    .png()
    .toBuffer();
  await sharp(sheet).resize({ width: 1500, height: 1500, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 75 }).toFile(out);
}

export async function runPhoto(rel: string) {
  const imagePath = join(ROOT, "test-material", rel);
  const meta = await sharp(imagePath).metadata();
  const imageArea = meta.width! * meta.height!;
  const products = await proposePhrases(imagePath);
  const phraseIndex = new Map(products.map((p, i) => [p.phrase, i]));
  const all: Found[] = [];
  const perPhrase: Record<string, number> = {};
  for (const [pi, p] of products.entries()) {
    const inst = await samInstances(imagePath, p.phrase);
    perPhrase[p.phrase] = inst.length;
    inst.forEach((x, k) => all.push({ ...x, phrase: p.phrase, label: `P${pi + 1}.${k + 1}` }));
  }
  // A mask covering more than 40% of the photo is a scene region, not a product crop.
  const tooBig = all.filter((f) => f.area / imageArea > 0.4);
  const found = dedupe(all.filter((f) => f.area / imageArea <= 0.4)).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const stem = basename(rel, ".jpg") + SUFFIX;
  await overlay(imagePath, found, phraseIndex, join(OUT, `${stem}-overlay.jpg`));
  if (found.length) await contactSheet(imagePath, found, join(OUT, `${stem}-crops.jpg`));
  const summary = {
    photo: rel,
    products: products.map((p, i) => ({ id: `P${i + 1}`, ...p, instances: perPhrase[p.phrase] })),
    rawInstances: all.length,
    droppedTooBig: tooBig.length,
    keptInstances: found.length,
    instances: found.map((f) => ({ label: f.label, phrase: f.phrase, box: f.box, confidence: f.confidence, areaPct: +((100 * f.area) / imageArea).toFixed(2) })),
  };
  writeFileSync(join(OUT, `${stem}-sam.json`), JSON.stringify(summary, null, 1));
  return summary;
}

if (import.meta.main) {
  const only = process.argv[2];
  for (const rel of PHOTOS.filter((p) => !only || p.includes(only))) {
    const s = await runPhoto(rel);
    console.log(`${s.photo}: ${s.products.length} phrases, ${s.rawInstances} raw, ${s.droppedTooBig} too big, ${s.keptInstances} kept`);
    for (const p of s.products) console.log(`   ${p.id} ${p.phrase} (${p.name}): ${p.instances}`);
  }
}
