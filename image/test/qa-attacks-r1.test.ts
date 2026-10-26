// Independent QA attacks on PR #4, round 1. Each test states the outcome the promise requires.
// A failing test here is a finding. No API calls.
import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeCatalogueImage, defaultBackdrop, restyleCatalogueImage, SIZE } from "../catalogue-image";
import { cutOut, usable, type Crop, type ModelCalls, type Product, type Review } from "../cutout";
import { filterCandidates, type Mask } from "../mask";
import { cand, ellipse, rect } from "./helpers";

const W = 1000, H = 800;
const P = (name: string, specific: string, plain: string, general = ""): Product => ({ name, specific, plain, general });
const photo = readFileSync(join(import.meta.dir, "../../test-material/real-photos/real-02-buguma-pepper-okra.jpg"));

function fake(products: Product[], masks: Record<string, Mask[]>, review: (c: Crop[]) => Review | Promise<Review>, boxes: (b: Mask["box"][]) => (Mask | null)[] = (b) => b.map(() => null)) {
  const asked: string[] = [];
  const calls: ModelCalls = {
    proposeProducts: async () => products,
    segment: async (_p, phrase) => (asked.push(phrase), masks[phrase] ?? []),
    segmentBoxes: async (_p, b) => boxes(b),
    review: async (_p, crops) => review(crops),
  };
  return { calls, asked };
}

describe("QA: Muse Image must not add anything that could pass for stock", () => {
  const studio = () => sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: "#d9d4cc" } });
  const composed = async () => composeCatalogueImage(photo, ellipse(300, 250, 400, 300), await defaultBackdrop());
  const svg = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">${body}</svg>`);

  test("a small invented bottle (60 x 160 px) in a corner is rejected", async () => {
    const c = await composed();
    const out = await restyleCatalogueImage(c, await studio().composite([{ input: svg(`<rect x="40" y="820" width="60" height="160" rx="14" fill="#2a6b2a"/>`) }]).png().toBuffer());
    expect(out.source).toBe("local");
  });

  test("a second, softly shaded invented product (no hard edges) is rejected", async () => {
    const c = await composed();
    const soft = svg(`<defs><radialGradient id="g"><stop offset="0%" stop-color="#b8b0a4"/><stop offset="100%" stop-color="#d9d4cc"/></radialGradient></defs><ellipse cx="160" cy="160" rx="120" ry="120" fill="url(#g)"/>`);
    const out = await restyleCatalogueImage(c, await studio().composite([{ input: soft }]).png().toBuffer());
    expect(out.source).toBe("local");
  });

  test("an invented object drawn right next to the product (inside the 16 px margin) is rejected", async () => {
    const c = await composed();
    const p = c.placement;
    // A dark tin touching the right edge of the product's box, where the edge gate does not look.
    const tin = svg(`<rect x="${p.left + p.width - 6}" y="${p.top + p.height / 2 - 40}" width="22" height="80" fill="#222"/>`);
    const out = await restyleCatalogueImage(c, await studio().composite([{ input: tin }]).png().toBuffer());
    expect(out.source).toBe("local");
  });
});

describe("QA: only reviewed goods reach the catalogue", () => {
  const tin = rect(100, 100, 80, 120);
  const bag = rect(500, 400, 120, 160); // a "bag" broad-phrase match: could be a customer's carrier bag

  test("a crop Spark gave no verdict on, in a review that otherwise worked, is not published", async () => {
    const f = fake([P("Peak milk", "milk tin", "tin")], { "milk tin": [tin], bag: [bag] }, (crops) => ({
      crops: crops.filter((c) => c.phrase !== "bag").map((c) => ({ number: c.number, accept: true, name: "Peak milk", lot: "a" })),
      missing: [],
    }));
    const r = await cutOut("x.jpg", W, H, f.calls);
    expect(r.items.map((i) => i.name)).toEqual(["Peak milk"]);
  });

  test("when the review call fails, broad-phrase matches (bag, bottle, packet) are not published unchecked", async () => {
    const f = fake([P("Peak milk", "milk tin", "tin")], { "milk tin": [tin], bag: [bag] }, () => {
      throw new Error("Daily cap reached");
    });
    const r = await cutOut("x.jpg", W, H, f.calls);
    expect(r.items.some((i) => i.cover.phrase === "bag")).toBe(false);
  });

  test("a box-prompt mask below SAM's confidence floor is dropped like any other loose match", async () => {
    const f = fake(
      [P("Peak milk", "milk tin", "tin")],
      { "milk tin": [tin] },
      (crops) => ({ crops: crops.map((c) => ({ number: c.number, accept: true, name: "Peak milk", lot: "a" })), missing: [{ name: "garri", box: [500, 500, 700, 700] }] }),
      () => [rect(500, 400, 200, 160, 0.08)],
    );
    const r = await cutOut("x.jpg", W, H, f.calls);
    expect(r.items.map((i) => i.name)).toEqual(["Peak milk"]);
  });
});

describe("QA: malformed or partial Spark replies never crash or slip through", () => {
  const tin = rect(100, 100, 80, 120);
  const go = (review: any) => cutOut("x.jpg", W, H, fake([P("Peak milk", "milk tin", "tin")], { "milk tin": [tin] }, () => review).calls);

  test("a box that is a string, null or a missing entry is skipped, not a crash", async () => {
    await expect(go({ crops: [], missing: [{ name: "a", box: "1234" }] })).resolves.toBeDefined();
    await expect(go({ crops: [], missing: [null] })).resolves.toBeDefined();
    await expect(go({ crops: [], missing: [{ name: "a", box: [1, 2, "x", 4] }] })).resolves.toBeDefined();
  });

  test('accept: "false" as a string is a rejection, not an acceptance', async () => {
    const r = await go({ crops: [{ number: 1, accept: "false", name: "bag", lot: "a" }], missing: [] });
    expect(r.items).toHaveLength(0);
  });

  test("a review reply that is not an object (refusal text parsed to a string) degrades, not crashes", async () => {
    await expect(go("I can't help with that")).resolves.toBeDefined();
    await expect(go(null)).resolves.toBeDefined();
  });

  test("Spark proposing 30 product types does not send 90+ SAM calls (rules say at most 12)", async () => {
    const many = Array.from({ length: 30 }, (_, i) => P(`p${i}`, `thing${i}`, `item${i}`, `stuff${i}`));
    const f = fake(many, {}, () => ({ crops: [], missing: [] }));
    await cutOut("x.jpg", W, H, f.calls);
    expect(f.asked.length).toBeLessThanOrEqual(12 * 3 + 4);
  });
});

describe("QA: confidence floor and person filter", () => {
  test("a mask with NaN confidence is treated as a loose match, not kept", () => {
    const { kept } = filterCandidates([cand(rect(100, 100, 80, 80, NaN), 0, "tin")], [], W * H);
    expect(kept).toHaveLength(0);
  });

  test("a product held in a hand keeps the product and loses the hand pixels", () => {
    const product = cand(rect(100, 100, 100, 100), 0, "tin");
    const hand = rect(170, 120, 80, 40); // overlaps the right 30 px of the tin
    const { kept } = filterCandidates([product], [hand], W * H);
    expect(kept).toHaveLength(1);
    const k = kept[0]!;
    const at = (x: number, y: number) => k.raster[(y - k.box.top) * k.rasterW + (x - k.box.left)];
    expect(at(185, 130)).toBe(0);
    expect(at(120, 130)).toBe(1);
  });

  test("person-like phrasings Spark may still produce are never sent to SAM", () => {
    for (const p of ["lady", "a man", "trader's hand", "kid", "baby", "hawker"]) expect(usable(p)).toBe("");
  });
});
