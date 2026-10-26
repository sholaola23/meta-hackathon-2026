// Messy-input suite for the cut-out step. Every case is an attack on a promise: one crop per real item,
// nothing that is a person, no duplicates, no wasted paid calls. Runs in CI with no API calls.
import { describe, expect, test } from "bun:test";
import { area, coveredFraction, filterCandidates, type Mask } from "../mask";
import { cutOut, phrasesFor, PERSON_PHRASE, type ModelCalls, type Product } from "../cutout";
import { cand, ellipse, rect } from "./helpers";

const W = 1000, H = 800, AREA = W * H;

/** Fake model calls: Spark returns the given products, SAM returns masks by phrase. Records every SAM phrase. */
function fake(products: Product[], masks: Record<string, Mask[]>) {
  const asked: string[] = [];
  const calls: ModelCalls = {
    proposeProducts: async () => products,
    segment: async (_p, phrase) => {
      asked.push(phrase);
      return masks[phrase] ?? [];
    },
  };
  return { calls, asked };
}

describe("filterCandidates", () => {
  test("duplicates: the same tin found by both phrasings becomes one crop", () => {
    const a = cand(rect(100, 100, 80, 120, 0.95), 0, "milk tin");
    const b = cand(rect(102, 101, 80, 120, 0.7), 0, "tin");
    const { kept, dropped } = filterCandidates([a, b], [], AREA);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.phrase).toBe("milk tin"); // the more confident one wins
    expect(dropped.map((d) => d.reason)).toEqual(["duplicate"]);
  });

  test("look-alikes: two identical tins touching side by side stay two crops", () => {
    const left = cand(rect(100, 100, 80, 120), 0, "tin");
    const right = cand(rect(180, 100, 80, 120), 0, "tin");
    expect(filterCandidates([left, right], [], AREA).kept).toHaveLength(2);
  });

  test("a row of 12 identical sachets keeps all 12", () => {
    const row = Array.from({ length: 12 }, (_, i) => cand(rect(50 + i * 40, 300, 38, 60), 0, "sachet"));
    expect(filterCandidates(row, [], AREA).kept).toHaveLength(12);
  });

  test("person in frame: 'fabric' matching the trader's shirt is dropped (Balogun regression)", () => {
    const trader = ellipse(0, 0, 400, 800);
    const shirt = cand(rect(80, 250, 240, 300), 0, "fabric");
    const bolt = cand(rect(600, 200, 150, 300), 0, "fabric");
    const { kept, dropped } = filterCandidates([shirt, bolt], [trader], AREA);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.box.left).toBe(600);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.reason).toBe("person");
  });

  test("person in front of stock: a basin partly behind the trader's arm is kept with the arm cut out", () => {
    const arm = rect(300, 300, 60, 200);
    const basin = cand(rect(250, 350, 200, 120), 0, "basin");
    const { kept } = filterCandidates([basin], [arm], AREA);
    expect(kept).toHaveLength(1);
    expect(coveredFraction(kept[0]!, [arm])).toBe(0); // no body part reaches the catalogue
    expect(area(kept[0]!)).toBe(200 * 120 - 60 * 120);
  });

  test("several people: a mask spread across two people is still a person", () => {
    const p1 = rect(0, 0, 300, 800), p2 = rect(700, 0, 300, 800);
    const both = cand(rect(100, 100, 800, 200), 0, "cloth"); // 400 of 800 columns sit on people
    expect(filterCandidates([both], [p1, p2], AREA).dropped[0]!.reason).toBe("person");
  });

  test("scene-sized and speck-sized masks are dropped", () => {
    const wall = cand(rect(0, 0, 1000, 500), 0, "shelf"); // 62.5% of the photo
    const speck = cand(rect(10, 10, 5, 5), 0, "sachet");
    const real = cand(rect(400, 600, 100, 100), 0, "tin");
    const { kept, dropped } = filterCandidates([wall, speck, real], [], AREA);
    expect(kept).toHaveLength(1);
    expect(dropped.map((d) => d.reason).sort()).toEqual(["too-big", "too-small"]);
  });

  test("nested goods: a tin cup sitting in a basin of grain keeps both", () => {
    const basin = cand(ellipse(100, 100, 400, 300), 0, "basin of grain");
    const cup = cand(ellipse(250, 200, 60, 50), 1, "tin cup");
    expect(filterCandidates([basin, cup], [], AREA).kept).toHaveLength(2);
  });

  test("crops are numbered in reading order whatever order SAM returned them", () => {
    const low = cand(rect(100, 500, 50, 50), 0, "tin");
    const highRight = cand(rect(600, 100, 50, 50), 0, "tin");
    const highLeft = cand(rect(100, 100, 50, 50), 0, "tin");
    const { kept } = filterCandidates([low, highRight, highLeft], [], AREA);
    expect(kept.map((k) => [k.box.left, k.box.top])).toEqual([[100, 100], [600, 100], [100, 500]]);
  });
});

describe("phrasesFor", () => {
  test("two phrasings per product, deduplicated across products, case and punctuation", () => {
    const phrases = phrasesFor([
      { name: "Peak milk", specific: "Milk tin", plain: "tin" },
      { name: "Milo", specific: "milo tin!", plain: "Tin" },
    ]);
    expect(phrases.map((p) => p.phrase)).toEqual(["milk tin", "tin", "milo tin"]);
  });

  test("people words and empty phrasings are never sent to SAM as products", () => {
    const phrases = phrasesFor([
      { name: "trader", specific: "Woman", plain: "person" },
      { name: "pepper", specific: "", plain: "  pepper " },
    ]);
    expect(phrases.map((p) => p.phrase)).toEqual(["pepper"]);
  });
});

describe("cutOut", () => {
  test("unions both phrasings: an item only the plain noun finds is still cut out", async () => {
    const { calls } = fake([{ name: "Okra", specific: "green okra heap", plain: "okra" }], {
      okra: [rect(100, 100, 200, 150)],
    });
    const r = await cutOut("photo.jpg", AREA, calls);
    expect(r.status).toBe("ok");
    expect(r.crops).toHaveLength(1);
    expect(r.crops[0]!.productName).toBe("Okra");
    expect(r.crops[0]!.number).toBe(1);
  });

  test("segments 'person' exactly once and each distinct phrase exactly once (no wasted paid calls)", async () => {
    const { calls, asked } = fake(
      [
        { name: "a", specific: "tin", plain: "tin" },
        { name: "b", specific: "bottle", plain: "tin" },
      ],
      {},
    );
    await cutOut("photo.jpg", AREA, calls);
    expect(asked.sort()).toEqual(["bottle", PERSON_PHRASE, "tin"].sort());
  });

  test("blurry or empty photo: no products proposed means no SAM calls and a clear status", async () => {
    const { calls, asked } = fake([], {});
    const r = await cutOut("photo.jpg", AREA, calls);
    expect(r.status).toBe("no-products");
    expect(asked).toEqual([]);
  });

  test("products named but nothing segmented gives no-products, not an empty catalogue", async () => {
    const { calls } = fake([{ name: "x", specific: "screen protector", plain: "packet" }], {});
    const r = await cutOut("photo.jpg", AREA, calls);
    expect(r.status).toBe("no-products");
    expect(r.crops).toEqual([]);
  });

  test("only the trader matched: everything dropped, reported as person", async () => {
    const trader = rect(0, 0, 400, 800);
    const { calls } = fake([{ name: "Ankara", specific: "folded fabric", plain: "fabric" }], {
      fabric: [rect(50, 200, 250, 300)],
      [PERSON_PHRASE]: [trader],
    });
    const r = await cutOut("photo.jpg", AREA, calls);
    expect(r.status).toBe("no-products");
    expect(r.dropped.map((d) => d.reason)).toEqual(["person"]);
  });
});
