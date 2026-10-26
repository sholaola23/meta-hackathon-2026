// SAM 3.1 concept-prompt segmentation, per dev.meta.ai/docs/sam/segmenting (sam-3.1 on /v1/responses).
import { parseImageStream, recordsOfKind, decodeMaskToRaster } from "@meta-sam/parser";
import { client, cached, imageDataUrl, fileHash, logCall } from "./lib";

export interface SamRaw {
  text: string;
  usage: unknown;
}

export interface Instance {
  objectId: string;
  box: { left: number; top: number; right: number; bottom: number };
  confidence?: number;
  /** Mask pixel count, and the raster that covers `box`. */
  area: number;
  raster: Uint8Array;
  rasterW: number;
  rasterH: number;
}

export async function samRaw(imagePath: string, phrase: string): Promise<SamRaw> {
  const key = { model: "sam-3.1", image: fileHash(imagePath), phrase, conf: true, enc: "one_bit" };
  return cached("sam", key, async () => {
    const res: any = await client.responses.create({
      model: "sam-3.1",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: phrase },
            { type: "input_image", image_url: imageDataUrl(imagePath), detail: "auto" } as any,
          ],
        },
      ],
      metadata: { include_confidence: "true", mask_encoding: "one_bit" },
    } as any);
    const text: string = res.output_text ?? "";
    logCall({ model: "sam-3.1", image: imagePath, phrase, usage: res.usage });
    return { text, usage: res.usage };
  });
}

async function* asEvents(text: string) {
  yield { type: "response.output_text.delta", delta: text, item_id: "i", output_index: 0, content_index: 0 };
  yield { type: "response.output_text.done", text, item_id: "i", output_index: 0, content_index: 0 };
  yield { type: "response.completed", response: {} };
}

export async function samInstances(imagePath: string, phrase: string): Promise<Instance[]> {
  return parseSamText((await samRaw(imagePath, phrase)).text, phrase);
}

/** Decode SAM's special-token text into instances. Shared with image/live.ts. */
export async function parseSamText(text: string, phrase: string): Promise<Instance[]> {
  if (!text.trim()) return [];
  const result: any = await parseImageStream(asEvents(text) as any).finalResult;
  if (result.diagnostics?.length) console.warn(phrase, result.diagnostics.slice(0, 2));
  const boxes = new Map(recordsOfKind(result.records, "box").map((b: any) => [b.objectId, b]));
  return recordsOfKind(result.records, "mask").map((m: any) => {
    const raster = decodeMaskToRaster(m.mask);
    let area = 0;
    for (const v of raster) area += v;
    const b: any = boxes.get(m.objectId);
    return {
      objectId: m.objectId,
      box: { left: m.bounds.left, top: m.bounds.top, right: m.bounds.right, bottom: m.bounds.bottom },
      confidence: m.confidence ?? b?.confidence,
      area,
      raster,
      rasterW: m.mask.width,
      rasterH: m.mask.height,
    };
  });
}

if (import.meta.main) {
  const [img, phrase] = process.argv.slice(2);
  const raw = await samRaw(img!, phrase!);
  console.log("usage", JSON.stringify(raw.usage));
  console.log("text head", raw.text.slice(0, 300));
  const inst = await samInstances(img!, phrase!);
  for (const i of inst) console.log(i.objectId, i.box, i.confidence, i.area, i.rasterW, i.rasterH);
}
