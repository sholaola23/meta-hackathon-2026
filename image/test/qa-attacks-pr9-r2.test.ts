// QA round 2 attacks on PR #9: blockers must be other things, not the same product found by another phrasing.
import { describe, expect, test } from "bun:test";
import { fillHoles, filterCandidates, type Mask } from "../mask";
import { cand, rect } from "./helpers";

const AREA = 1000 * 800;
const at = (m: Mask, x: number, y: number) => m.raster[(y - m.box.top) * m.rasterW + (x - m.box.left)];
function tinWithHole(confidence = 0.9): Mask {
  const tin = rect(100, 100, 120, 160, confidence);
  for (let y = 60; y < 110; y++) for (let x = 40; x < 80; x++) tin.raster[y * tin.rasterW + x] = 0;
  return tin;
}

describe("QA r2: the same product found twice must not block its own hole", () => {
  test("B1 'milo tin' (holed, more confident) and 'tin' (solid) of the same tin: the kept crop has no hole", () => {
    const { kept } = filterCandidates([cand(tinWithHole(0.9), 0, "milo tin"), cand(rect(100, 100, 120, 160, 0.8), 0, "tin")], [], AREA);
    expect(kept.length).toBe(1);
    expect(at(kept[0]!, 160, 185)).toBe(1);
  });

  test("B2 both phrasings return the same holed tin: the kept crop has no hole", () => {
    const { kept } = filterCandidates([cand(tinWithHole(0.9), 0, "milo tin"), cand(tinWithHole(0.85), 0, "tin")], [], AREA);
    expect(kept.length).toBe(1);
    expect(at(kept[0]!, 160, 185)).toBe(1);
  });

  test("B3 a mask that is m itself (copied, not the same object) does not block", () => {
    const m = tinWithHole();
    const f = fillHoles(m, [{ ...m, raster: Uint8Array.from(m.raster) }]);
    expect(at(f, 160, 185)).toBe(1);
  });
});
