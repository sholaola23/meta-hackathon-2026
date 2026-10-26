// Live model calls for the image step: Muse Spark (phrasings and crop review), SAM 3.1 (phrases and box prompts)
// and Muse Image (studio restyle). Every response is cached on disk with the spike's cache, so repeat runs are free,
// and every uncached call goes through the spend guard (off switch, per-job call limit, daily cap).
import { buildObjectPrompt } from "@meta-sam/parser";
import { readFileSync } from "node:fs";
import { client, cached, cacheKey, fileHash, imageDataUrl, logCall } from "../spike/lib";
import { parseSamText } from "../spike/sam";
import { SpendGuard, imageUsd, samUsd, sparkUsd } from "../src/spend-guard";
import type { Crop, ModelCalls, Product, Review } from "./cutout";
import type { Box, Mask } from "./mask";
import { numberedPhoto, reviewSheet } from "./review-sheet";

const SPARK = "muse-spark-1.3";
const jpegUrl = (b: Buffer) => `data:image/jpeg;base64,${b.toString("base64")}`;

// Phrasing rules from Meta's SAM 3 Agent: short plain nouns, no brands, and a broader word to retry with.
export const PROPOSE_RULES = `You are an object grounding expert helping a market trader turn a photo of their stall into a catalogue. List every distinct type of product the trader is selling that is visible in the photo, including loose goods in heaps, basins, bags or baskets, and goods hanging in strips.
For each type give:
- "name": what a buyer would call it, 1 to 5 words.
- "specific": a short noun phrase of 1 to 4 words that an object segmentation model can use to find every unit of it, for example "milk tin", "folded fabric", "pepper heap", "sandal". Name the physical object. One concept only: no lists, no "or", no negation, no position words such as left or top. No brand names.
- "plain": the plainest everyday English noun for one unit of it, 1 or 2 words, the way a child would name the object. No colours, no brand names. Examples: "tin", "jar", "sachet", "bottle", "egg", "bread", "okra", "pepper", "watermelon", "fabric", "basin", "bag".
- "general": one broader word or synonym to try if the first two find nothing, for example "vegetable" for okra, "grain" for millet, "container" for a tin.
Do not include people, clothes that people are wearing, shelves, tables, signs, umbrellas, or containers that are not for sale.
Return at most 12 types.`;

const PRODUCT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["products"],
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "specific", "plain", "general"],
        properties: { name: { type: "string" }, specific: { type: "string" }, plain: { type: "string" }, general: { type: "string" } },
      },
    },
  },
};

export const REVIEW_RULES = `You check cut-outs for a market trader's catalogue. You get two pictures: the stall photo with numbered yellow boxes, and a sheet of numbered tiles. Each tile zooms in on one cut-out; the cut-out is shown in full colour and everything around it is faded.
For every tile number, decide:
- "accept": true only if the full-colour part is goods the trader sells, shown well enough to recognise. Reject people and their clothes, body parts, bags people are carrying, tables, shelves, signs, umbrellas, empty containers, empty crate cells, scales, and slivers too small or cut off to recognise.
- "name": what the full-colour part actually is, 1 to 5 words, from what you see in the tile, not from the box number. Do not guess brand names you cannot read.
- "lot": a short label shared by tiles that a trader would price as one line: units from the same heap, basin, basket or strip, or identical packs side by side. Different goods, or the same goods in different basins, get different lots.
Then list under "missing" goods for sale that you can see in the stall photo but that no yellow box covers, at most 16, each with a name and a box [x1, y1, x2, y2] on a 0 to 1000 grid over the whole stall photo (0,0 top left, 1000,1000 bottom right). Leave "missing" empty if every product is covered.`;

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["crops", "missing"],
  properties: {
    crops: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["number", "accept", "name", "lot"],
        properties: { number: { type: "integer" }, accept: { type: "boolean" }, name: { type: "string" }, lot: { type: "string" } },
      },
    },
    missing: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "box"],
        properties: { name: { type: "string" }, box: { type: "array", items: { type: "number" } } },
      },
    },
  },
};

const sparkActual = (r: any) =>
  sparkUsd({ input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0, cachedInput: r.usage?.input_tokens_details?.cached_tokens ?? 0 });

/** One structured Muse Spark call: rules in the developer role, images in the user turn, strict schema, cached. */
async function sparkJson(guard: SpendGuard, jobId: string, task: string, rules: string, images: Buffer[], text: string, schema: object, key: unknown) {
  const res = await cached(task, key, async () => {
    const r: any = await guard.paid(
      jobId,
      SPARK,
      sparkUsd({ input: 4000 * images.length, output: 4000 }),
      () =>
        client.responses.create({
          model: SPARK,
          store: false,
          max_output_tokens: 16000, // reasoning tokens count against this
          input: [
            { type: "message", role: "developer", content: [{ type: "input_text", text: rules }] },
            { type: "message", role: "user", content: [...images.map((b) => ({ type: "input_image", image_url: jpegUrl(b) })), { type: "input_text", text }] },
          ],
          text: { format: { type: "json_schema", name: task.replace(/-/g, "_"), schema, strict: true } },
        } as any),
      sparkActual,
    );
    logCall({ model: SPARK, task, usage: r.usage });
    return { text: r.output_text as string, usage: r.usage };
  });
  return JSON.parse(res.text);
}

const toMask = (i: { box: Box; raster: Uint8Array; rasterW: number; rasterH: number; confidence?: number }): Mask => ({
  box: i.box,
  raster: i.raster,
  rasterW: i.rasterW,
  rasterH: i.rasterH,
  confidence: i.confidence,
});

async function samText(guard: SpendGuard, jobId: string, photoPath: string, text: string, key: unknown) {
  return cached("sam", key, async () => {
    const res: any = await guard.paid(jobId, "sam-3.1", samUsd(), () =>
      client.responses.create({
        model: "sam-3.1",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text },
              { type: "input_image", image_url: imageDataUrl(photoPath), detail: "auto" },
            ],
          },
        ],
        metadata: { include_confidence: "true", mask_encoding: "one_bit" },
      } as any),
    );
    logCall({ model: "sam-3.1", image: photoPath, prompt: text.slice(0, 120), usage: res.usage });
    return { text: (res.output_text ?? "") as string, usage: res.usage };
  });
}

export function liveCalls(guard: SpendGuard, jobId: string, size: { width: number; height: number }): ModelCalls {
  return {
    async proposeProducts(photoPath) {
      const photo = readFileSync(photoPath);
      const key = { model: SPARK, image: fileHash(photoPath), rules: PROPOSE_RULES, schema: PRODUCT_SCHEMA };
      const out = await sparkJson(guard, jobId, "propose-v3", PROPOSE_RULES, [photo], "List the products in this stall photo.", PRODUCT_SCHEMA, key);
      return out.products as Product[];
    },

    async segment(photoPath, phrase) {
      // Same key and request as spike/sam.ts, so the spike's cached SAM responses are reused.
      const key = { model: "sam-3.1", image: fileHash(photoPath), phrase, conf: true, enc: "one_bit" };
      const raw = await samText(guard, jobId, photoPath, phrase, key);
      return (await parseSamText(raw.text, phrase)).map(toMask);
    },

    async segmentBoxes(photoPath, boxes) {
      const text = buildObjectPrompt({ size, objects: boxes.map((box, i) => ({ id: i + 1, prompts: [{ frame: 0, box }] })) });
      const key = { model: "sam-3.1", image: fileHash(photoPath), boxes: text, conf: true };
      const raw = await samText(guard, jobId, photoPath, text, key);
      const found = await parseSamText(raw.text, "boxes");
      return boxes.map((_, i) => {
        const hit = found.find((f) => String(f.objectId) === String(i + 1));
        return hit ? toMask(hit) : null;
      });
    },

    async review(photoPath, crops: Crop[]): Promise<Review> {
      const photo = readFileSync(photoPath);
      const [overview, sheet] = await Promise.all([numberedPhoto(photo, crops), reviewSheet(photo, crops)]);
      const boxes = crops.map((c) => [c.number, c.box.left, c.box.top, c.box.right, c.box.bottom, cacheKey(Array.from(c.raster))]);
      const key = { model: SPARK, image: fileHash(photoPath), rules: REVIEW_RULES, crops: cacheKey(boxes) };
      const text = `Tiles to check: ${crops.map((c) => `#${c.number}`).join(", ")}. Give one verdict per tile number.`;
      return (await sparkJson(guard, jobId, "review", REVIEW_RULES, [overview, sheet], text, REVIEW_SCHEMA, key)) as Review;
    },
  };
}

// From Meta's Muse Image docs: no setting keeps an input exactly, so the prompt names what must stay, every grounding
// tool is off so it cannot pull in other products' pictures, and the caller pastes the real product pixels back and
// checks that nothing new appeared around them (restyle.ts).
export const RESTYLE_PROMPT =
  "Product photo clean-up. Keep the product in the centre exactly as it is: same shape, size, position, colours, labels, packaging, texture and any wear, dents, stains or creases. Do not add, remove or redraw any object. Only make the backdrop a seamless plain warm light-grey studio surface with soft even daylight and a soft natural contact shadow under the product. Keep everything else otherwise unchanged.";

/** One Muse Image restyle of a composed catalogue picture. Returns null on any failure; the caller keeps its own picture. */
export async function museImageRestyle(guard: SpendGuard, jobId: string, composed: Buffer): Promise<Buffer | null> {
  try {
    const key = { model: "muse-image-1.0", prompt: RESTYLE_PROMPT, image: cacheKey(composed.toString("base64")) };
    const res = await cached("restyle", key, async () => {
      const r: any = await guard.paid(jobId, "muse-image-1.0", imageUsd(), async () => {
        // Raw JSON body: the images array form is Meta-specific, the OpenAI SDK only sends multipart.
        const resp = await fetch("https://api.meta.ai/v1/images/edits", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "muse-image-1.0",
            prompt: RESTYLE_PROMPT,
            images: [{ image_url: `data:image/png;base64,${composed.toString("base64")}` }],
            n: 1,
            output_format: "png",
            reasoning_strength: "low",
            tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
            user: cacheKey(jobId).slice(0, 16), // safety identifier: a hash, never the trader's number
          }),
        });
        if (!resp.ok) throw new Error(`Muse Image ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        return resp.json();
      });
      logCall({ model: "muse-image-1.0", task: "restyle", usage: r.usage });
      return { b64: r.data[0].b64_json as string };
    });
    return Buffer.from(res.b64, "base64");
  } catch (e) {
    console.warn("Muse Image restyle unavailable, keeping the composed picture:", (e as Error).message);
    return null;
  }
}
