// Regression: SAM left a hole in a Milo tin where the footballer on the label is, and the backdrop showed through
// the product in its catalogue picture. Enclosed holes are filled; open gaps and people stay out. No API calls.
import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeCatalogueImage, defaultBackdrop } from "../catalogue-image";
import { cutOut, type ModelCalls } from "../cutout";
import { area, fillHoles, filterCandidates, type Mask } from "../mask";
import { cand, rect } from "./helpers";

const AREA = 1000 * 800;
const at = (m: Mask, x: number, y: number) => m.raster[(y - m.box.top) * m.rasterW + (x - m.box.left)];

/** A tin with a label-picture-shaped hole punched out of its middle. */
function tinWithHole(): Mask {
  const tin = rect(100, 100, 120, 160);
  for (let y = 60; y < 110; y++) for (let x = 40; x < 80; x++) tin.raster[y * tin.rasterW + x] = 0;
  return tin;
}

describe("holes in product masks", () => {
  test("an enclosed hole (a picture on the label) is filled", () => {
    const filled = fillHoles(tinWithHole());
    expect(area(filled)).toBe(120 * 160);
    expect(at(filled, 160, 180)).toBe(1);
  });

  test("a hole another mask covers stays open; one only a distant mask exists beside is still filled", () => {
    const inside = rect(145, 165, 30, 40); // a different product sitting in the hole
    expect(area(fillHoles(tinWithHole(), [inside]))).toBe(120 * 160 - 40 * 50);
    expect(area(fillHoles(tinWithHole(), [rect(600, 600, 50, 50)]))).toBe(120 * 160);
  });

  test("a gap open to the edge of the mask (space between a tin's shoulders) is not filled", () => {
    const m = rect(0, 0, 100, 100);
    for (let y = 0; y < 50; y++) for (let x = 40; x < 60; x++) m.raster[y * 100 + x] = 0;
    expect(area(fillHoles(m))).toBe(100 * 100 - 50 * 20);
  });

  test("filterCandidates fills the hole, but a hand over the middle of the product is still cut out", () => {
    const { kept } = filterCandidates([cand(tinWithHole(), 0, "milk tin")], [], AREA);
    expect(at(kept[0]!, 160, 180)).toBe(1);
    const hand = rect(140, 220, 40, 20); // inside the tin, below the label hole
    const held = filterCandidates([cand(tinWithHole(), 0, "milk tin")], [hand], AREA).kept[0]!;
    expect(at(held, 160, 230)).toBe(0);
    expect(at(held, 160, 180)).toBe(1);
  });

  test("the catalogue picture shows the label where SAM left a hole, not the backdrop", async () => {
    const photo = readFileSync(join(import.meta.dir, "../../test-material/real-photos/real-02-buguma-pepper-okra.jpg"));
    const calls: ModelCalls = {
      proposeProducts: async () => [{ name: "Milo", specific: "milo tin", plain: "tin", general: "" }],
      segment: async (_p, phrase) => (phrase === "milo tin" ? [tinWithHole()] : []),
      segmentBoxes: async (_p, b) => b.map(() => null),
      review: async (_p, crops) => ({ crops: crops.map((c) => ({ number: c.number, accept: true, name: "Milo", lot: "milo" })), missing: [] }),
    };
    const r = await cutOut("x.jpg", 1000, 800, calls);
    const img = await composeCatalogueImage(photo, r.items[0]!.cover, await defaultBackdrop());
    // The hole's centre, mapped onto the canvas, must be the photo's own pixel.
    const p = img.placement, s = p.scale;
    const cx = Math.round(p.left + 60 * s), cy = Math.round(p.top + 85 * s);
    const { data, info } = await sharp(img.png).raw().toBuffer({ resolveWithObject: true });
    const got = [0, 1, 2].map((c) => data[(cy * info.width + cx) * info.channels + c]!);
    const src = await sharp(photo).extract({ left: 160, top: 185, width: 1, height: 1 }).raw().toBuffer();
    for (let c = 0; c < 3; c++) expect(Math.abs(got[c]! - src[c]!)).toBeLessThanOrEqual(8);
  });
});
