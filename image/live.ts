// Live model calls for the image step: Muse Spark (two phrasings per product), SAM 3.1 and Muse Image (empty backdrop).
// Every response is cached on disk with the spike's cache keys, so photos the spike already ran cost nothing again,
// and every uncached call goes through the spend guard (off switch, per-job call limit, daily cap).
import { client, cached, fileHash, imageDataUrl, logCall } from "../spike/lib";
import { parseSamText } from "../spike/sam";
import { SpendGuard, imageUsd, samUsd, sparkUsd } from "../src/spend-guard";
import type { ModelCalls, Product } from "./cutout";
import type { Mask } from "./mask";

const SPARK = "muse-spark-1.3";

// Built on the spike's two prompts: v1's descriptive phrase and v2's plainest noun are now asked for together,
// so one Spark call yields both phrasings (day-one test: 59% -> 76% of real-photo items with the union).
export const PROPOSE_PROMPT = `You are looking at a photo of a market stall. List every distinct type of product the trader is selling that is visible in the photo, including loose goods in heaps, basins, bags or baskets, and goods hanging in strips.
For each type give:
- "name": what a buyer would call it, 1 to 5 words.
- "specific": a short noun phrase of 1 to 4 words that an object segmentation model can use to find every unit of it, for example "milk tin", "folded fabric", "red pepper heap", "sandal". Name the physical object, not a brand slogan.
- "plain": the plainest everyday English noun for one unit of it, 1 or 2 words, the way a child would name the object. No colours, no brand names. Examples: "tin", "jar", "sachet", "bottle", "egg", "bread", "okra", "pepper", "watermelon", "fabric", "basin", "bag".
Do not include people, clothes that people are wearing, shelves, tables, signs, umbrellas, or containers that are not for sale.
Return at most 12 types.`;

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
        required: ["name", "specific", "plain"],
        properties: { name: { type: "string" }, specific: { type: "string" }, plain: { type: "string" } },
      },
    },
  },
};

const sparkActual = (r: any) =>
  sparkUsd({ input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0, cachedInput: r.usage?.input_tokens_details?.cached_tokens ?? 0 });

export function liveCalls(guard: SpendGuard, jobId: string): ModelCalls {
  return {
    async proposeProducts(photoPath: string): Promise<Product[]> {
      const key = { model: SPARK, image: fileHash(photoPath), prompt: PROPOSE_PROMPT, schema: SCHEMA };
      const res = await cached("propose", key, async () => {
        const r: any = await guard.paid(
          jobId,
          SPARK,
          sparkUsd({ input: 3000, output: 1500 }),
          () =>
            client.responses.create({
              model: SPARK,
              input: [
                {
                  type: "message",
                  role: "user",
                  content: [
                    { type: "input_text", text: PROPOSE_PROMPT },
                    { type: "input_image", image_url: imageDataUrl(photoPath) },
                  ],
                },
              ],
              text: { format: { type: "json_schema", name: "stall_products", schema: SCHEMA, strict: true } },
            } as any),
          sparkActual,
        );
        logCall({ model: SPARK, task: "propose-two-phrasings", image: photoPath, usage: r.usage });
        return { text: r.output_text as string, usage: r.usage };
      });
      return JSON.parse(res.text).products;
    },

    async segment(photoPath: string, phrase: string): Promise<Mask[]> {
      // Same key and request as spike/sam.ts, so the spike's cached SAM responses are reused.
      const key = { model: "sam-3.1", image: fileHash(photoPath), phrase, conf: true, enc: "one_bit" };
      const raw = await cached("sam", key, async () => {
        const res: any = await guard.paid(jobId, "sam-3.1", samUsd(), () =>
          client.responses.create({
            model: "sam-3.1",
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  { type: "input_text", text: phrase },
                  { type: "input_image", image_url: imageDataUrl(photoPath), detail: "auto" },
                ],
              },
            ],
            metadata: { include_confidence: "true", mask_encoding: "one_bit" },
          } as any),
        );
        logCall({ model: "sam-3.1", image: photoPath, phrase, usage: res.usage });
        return { text: (res.output_text ?? "") as string, usage: res.usage };
      });
      return (await parseSamText(raw.text, phrase)).map((i) => ({
        box: i.box,
        raster: i.raster,
        rasterW: i.rasterW,
        rasterH: i.rasterH,
        confidence: i.confidence,
      }));
    },
  };
}

export const BACKDROP_PROMPT =
  "Empty product-photography backdrop: a seamless, plain, warm light-grey studio surface curving up into the wall, soft even daylight, gentle falloff. Completely empty: no objects, no products, no props, no plants, no text, no logos, no people.";

/** One Muse Image backdrop, cached forever. Returns null on any failure; pickBackdrop then uses the local one. */
export async function museImageBackdrop(guard: SpendGuard, jobId: string): Promise<Buffer | null> {
  try {
    const key = { model: "muse-image-1.0", prompt: BACKDROP_PROMPT, size: "1024x1024" };
    const res = await cached("backdrop", key, async () => {
      const r: any = await guard.paid(jobId, "muse-image-1.0", imageUsd(), () =>
        client.images.generate({
          model: "muse-image-1.0",
          prompt: BACKDROP_PROMPT,
          size: "1024x1024",
          output_format: "png",
          reasoning_strength: "low",
          tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
        } as any),
      );
      logCall({ model: "muse-image-1.0", task: "backdrop", usage: r.usage });
      return { b64: r.data[0].b64_json as string };
    });
    return Buffer.from(res.b64, "base64");
  } catch (e) {
    console.warn("Muse Image backdrop unavailable, using the local one:", (e as Error).message);
    return null;
  }
}
