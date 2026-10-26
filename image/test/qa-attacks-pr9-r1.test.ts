// QA attacks on PR #9 (fillHoles). Each test states the correct user-facing outcome; failures are findings.
import { describe, expect, test } from "bun:test";
import { area, fillHoles, filterCandidates, type Mask } from "../mask";
import { cand, rect } from "./helpers";

const AREA = 1000 * 800;
/** A w x h ring of the given thickness: a frame with an enclosed hole. */
function ring(left: number, top: number, w: number, h: number, t: number, confidence = 0.9): Mask {
  const m = rect(left, top, w, h, confidence);
  for (let y = t; y < h - t; y++) for (let x = t; x < w - t; x++) m.raster[y * w + x] = 0;
  return m;
}

describe("QA r1: fillHoles must not swallow other things", () => {
  test("A1 a ring-shaped mask (basin rim, crate frame) round a different product: both products stay in the catalogue", () => {
    const basin = { ...cand(ring(100, 100, 200, 200, 20, 0.9), 0, "basin") };
    const tin = cand(rect(150, 150, 100, 100, 0.8), 1, "tomato tin");
    const { kept, dropped } = filterCandidates([basin, tin], [], AREA);
    expect(dropped.map((d) => d.reason)).not.toContain("duplicate");
    expect(kept.map((k) => k.phrase).sort()).toEqual(["basin", "tomato tin"]);
  });

  test("A1b the ring's own picture must not contain the other product's pixels", () => {
    const basin = cand(ring(100, 100, 200, 200, 20, 0.7), 0, "basin");
    const tin = cand(rect(150, 150, 100, 100, 0.95), 1, "tomato tin");
    const { kept } = filterCandidates([basin, tin], [], AREA);
    const b = kept.find((k) => k.phrase === "basin");
    expect(b).toBeDefined();
    // Centre of the tin, inside the basin's raster: must stay out of the basin's picture.
    expect(b!.raster[100 * b!.rasterW + 100]).toBe(0);
  });

  test("A2 fabric hanging all round the trader (person-shaped enclosed hole) is kept, not dropped as 'person'", () => {
    const fabric = cand(ring(100, 100, 200, 200, 25, 0.9), 0, "ankara fabric");
    const trader = rect(125, 125, 150, 150);
    const { kept, dropped } = filterCandidates([fabric], [trader], AREA);
    expect(dropped.map((d) => d.reason)).toEqual([]);
    expect(kept.length).toBe(1);
    expect(area(kept[0]!)).toBe(200 * 200 - 150 * 150);
  });
});

describe("QA r1: geometry and scale", () => {
  test("A3 a hole touching the mask's box edge on one side only stays open", () => {
    const m = rect(0, 0, 50, 50);
    for (let y = 10; y < 40; y++) for (let x = 0; x < 20; x++) m.raster[y * 50 + x] = 0;
    expect(area(fillHoles(m))).toBe(2500 - 30 * 20);
  });

  test("A4 nested: a hole inside an island inside a hole is filled once, idempotently", () => {
    const m = ring(0, 0, 100, 100, 10);
    for (let y = 30; y < 70; y++) for (let x = 30; x < 70; x++) m.raster[y * 100 + x] = 1;
    for (let y = 45; y < 55; y++) for (let x = 45; x < 55; x++) m.raster[y * 100 + x] = 0;
    const once = fillHoles(m);
    expect(area(once)).toBe(10000);
    expect(area(fillHoles(once))).toBe(10000);
    expect(area(m)).toBeLessThan(10000); // input not mutated
  });

  test("A5 degenerate rasters (1x1, 1xN, empty) do not throw", () => {
    expect(area(fillHoles(rect(0, 0, 1, 1)))).toBe(1);
    const line = rect(0, 0, 1, 50);
    line.raster[25] = 0;
    expect(area(fillHoles(line))).toBe(49);
    const empty = { box: { left: 0, top: 0, right: 0, bottom: 0 }, raster: new Uint8Array(0), rasterW: 0, rasterH: 0, confidence: 0.9 };
    expect(area(fillHoles(empty))).toBe(0);
  });

  test("A6 a 12-megapixel mask with a large hole fills in under 1.5s", () => {
    const m = ring(0, 0, 4000, 3000, 50);
    const t0 = performance.now();
    const f = fillHoles(m);
    const ms = performance.now() - t0;
    expect(area(f)).toBe(12_000_000);
    expect(ms).toBeLessThan(1500);
  });

  test("A6b a 12-megapixel mask that is mostly background (open) also stays fast", () => {
    const m = rect(0, 0, 4000, 3000);
    m.raster.fill(0);
    m.raster[1500 * 4000 + 2000] = 1;
    const t0 = performance.now();
    expect(area(fillHoles(m))).toBe(1);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
