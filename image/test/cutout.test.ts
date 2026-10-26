// Messy-input suite for the cut-out step. Every case is an attack on a promise: one crop per real item,
// nothing that is a person, no duplicates, no wasted paid calls. Runs in CI with no API calls.
import { describe, expect, test } from "bun:test";
import { area, coveredFraction, filterCandidates, type Mask } from "../mask";
import { BROAD_PHRASES, cutOut, gridToPixels, MAX_BOXES, PERSON_PHRASE, usable, type Crop, type ModelCalls, type Product, type Review } from "../cutout";
import { cand, ellipse, rect } from "./helpers";

const W = 1000, H = 800, AREA = W * H;

const P = (name: string, specific: string, plain: string, general = ""): Product => ({ name, specific, plain, general });

/**
 * Fake model calls: Spark returns the given products and review, SAM returns masks by phrase and by box.
 * Records every SAM phrase, every box request and what the review was shown.
 */
function fake(products: Product[], masks: Record<string, Mask[]>, opts: { review?: (crops: Crop[]) => Review; boxes?: (b: Mask["box"][]) => (Mask | null)[] } = {}) {
  const asked: string[] = [];
  const boxRequests: Mask["box"][][] = [];
  const reviewed: Crop[][] = [];
  const calls: ModelCalls = {
    proposeProducts: async () => products,
    segment: async (_p, phrase) => {
      asked.push(phrase);
      return masks[phrase] ?? [];
    },
    segmentBoxes: async (_p, boxes) => {
      boxRequests.push(boxes);
      return opts.boxes ? opts.boxes(boxes) : boxes.map(() => null);
    },
    review: async (_p, crops) => {
      reviewed.push(crops);
      return opts.review ? opts.review(crops) : { crops: [], missing: [] };
    },
  };
  return { calls, asked, boxRequests, reviewed };
}

const acceptAll = (lot: (c: Crop) => string, name: (c: Crop) => string = (c) => c.productName) => (crops: Crop[]): Review => ({
  crops: crops.map((c) => ({ number: c.number, accept: true, name: name(c), lot: lot(c) })),
  missing: [],
});

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

  test("person in frame: 'fabric' matching the trader's patterned shirt is dropped", () => {
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

  test("a heap: single oranges inside the basket SAM also found fold into the basket", () => {
    const basket = cand(ellipse(100, 100, 400, 300, 0.95), 0, "orange basket");
    const singles = [cand(ellipse(250, 200, 40, 40, 0.8), 0, "orange"), cand(ellipse(300, 260, 40, 40, 0.8), 0, "orange")];
    const { kept, dropped } = filterCandidates([...singles, basket], [], AREA);
    expect(kept.map((k) => k.phrase)).toEqual(["orange basket"]);
    expect(dropped.map((d) => d.reason)).toEqual(["duplicate", "duplicate"]);
  });

  test("two lots that only touch at the edge stay separate (overlap under 30% of the smaller)", () => {
    const a = cand(rect(100, 100, 200, 100), 0, "basin");
    const b = cand(rect(280, 100, 100, 100), 1, "basin"); // 20 of 100 columns shared
    expect(filterCandidates([a, b], [], AREA).kept).toHaveLength(2);
  });

  test("loose matches below SAM confidence 0.5 are dropped; masks with no confidence are kept", () => {
    const loose = cand(rect(100, 100, 80, 80, 0.3), 0, "sachet");
    const sure = cand(rect(300, 100, 80, 80, 0.5), 0, "sachet");
    const unknown = { ...cand(rect(500, 100, 80, 80), 0, "sachet"), confidence: undefined };
    const { kept, dropped } = filterCandidates([loose, sure, unknown], [], AREA);
    expect(kept).toHaveLength(2);
    expect(dropped.map((d) => d.reason)).toEqual(["low-confidence"]);
  });

  test("crops are numbered in reading order whatever order SAM returned them", () => {
    const low = cand(rect(100, 500, 50, 50), 0, "tin");
    const highRight = cand(rect(600, 100, 50, 50), 0, "tin");
    const highLeft = cand(rect(100, 100, 50, 50), 0, "tin");
    const { kept } = filterCandidates([low, highRight, highLeft], [], AREA);
    expect(kept.map((k) => [k.box.left, k.box.top])).toEqual([[100, 100], [600, 100], [100, 500]]);
  });
});

describe("phrasing", () => {
  test("SAM gets one plain concept per request: lists, alternatives, negation and positions are refused", () => {
    expect(usable("Milk Tin")).toBe("milk tin");
    expect(usable("red pepper heap")).toBe("red pepper heap");
    for (const bad of ["tin and jar", "tin, jar", "tin or jar", "tin/jar", "not a tin", "tin without lid", "tin on the left", "the bigger tin", "bag behind table", "trader", "", undefined])
      expect({ bad, out: usable(bad) }).toEqual({ bad, out: "" });
    // Words that merely contain a position word stay usable.
    expect(usable("bottled water")).toBe("bottled water");
    expect(usable("notebook")).toBe("notebook");
  });

  test("two phrasings per product, each distinct phrase sent once, plus the broad fallbacks and 'person' once", async () => {
    const { calls, asked } = fake([P("Peak milk", "Milk tin", "tin"), P("Milo", "milo tin!", "Tin")], { tin: [rect(10, 10, 50, 50)] });
    await cutOut("photo.jpg", W, H, calls);
    expect(asked).toEqual(["milk tin", "tin", "milo tin", ...BROAD_PHRASES, PERSON_PHRASE]);
  });

  test("the general word is tried only when both phrasings find nothing (SAM missed 'okra' twice on day one)", async () => {
    const { calls, asked } = fake([P("Okra", "okra heap", "okra", "vegetable"), P("Tins", "milk tin", "tin", "can")], { tin: [rect(10, 10, 50, 50)] });
    await cutOut("photo.jpg", W, H, calls);
    expect(asked).toContain("vegetable");
    expect(asked).not.toContain("can");
  });

  test("people words and empty phrasings are never sent to SAM as products", async () => {
    const { calls, asked } = fake([P("trader", "Woman", "person", "human"), P("pepper", "", "  pepper ")], {});
    await cutOut("photo.jpg", W, H, calls);
    expect(asked.filter((a) => a !== PERSON_PHRASE && !BROAD_PHRASES.includes(a))).toEqual(["pepper"]);
    expect(asked.filter((a) => a === PERSON_PHRASE)).toHaveLength(1);
  });
});

describe("cutOut with Spark's review", () => {
  test("blurry or empty photo: no products means no SAM calls and a clear status", async () => {
    const { calls, asked } = fake([], {});
    const r = await cutOut("photo.jpg", W, H, calls);
    expect(r.status).toBe("no-products");
    expect(asked).toEqual([]);
  });

  test("products named but nothing found and nothing pointed at gives no-products, not an empty catalogue", async () => {
    const { calls, reviewed } = fake([P("x", "screen protector", "packet", "plastic")], {});
    const r = await cutOut("photo.jpg", W, H, calls);
    expect(r.status).toBe("no-products");
    expect(reviewed).toHaveLength(0); // nothing to review, no paid call
  });

  test("only the trader matched: dropped as a person, never reaches review or the catalogue", async () => {
    const { calls, reviewed } = fake([P("Ankara", "folded fabric", "fabric")], { fabric: [rect(50, 200, 250, 300)], [PERSON_PHRASE]: [rect(0, 0, 400, 800)] });
    const r = await cutOut("photo.jpg", W, H, calls);
    expect(r.status).toBe("no-products");
    expect(r.dropped.map((d) => d.reason)).toEqual(["person"]);
    expect(reviewed).toHaveLength(0);
  });

  test("Spark's rejects (an empty crate, a sign) never reach the catalogue", async () => {
    const { calls } = fake([P("Eggs", "egg crate", "egg")], { egg: [rect(100, 100, 60, 60), rect(300, 100, 60, 60)] }, {
      review: (cs) => ({ crops: cs.map((c) => ({ number: c.number, accept: c.number === 1, name: c.number === 1 ? "Eggs" : "empty crate", lot: `l${c.number}` })), missing: [] }),
    });
    const r = await cutOut("photo.jpg", W, H, calls);
    expect(r.items.map((i) => i.name)).toEqual(["Eggs"]);
    expect(r.rejected).toEqual([{ number: 2, name: "empty crate" }]);
  });

  test("names come from what Spark sees in each crop, not from the phrase that found it", async () => {
    const { calls } = fake([P("Milo", "milo sachet", "sachet")], { sachet: [rect(100, 100, 40, 80), rect(200, 100, 40, 80)] }, {
      review: acceptAll((c) => `l${c.number}`, (c) => (c.number === 1 ? "Milo sachet" : "Horlicks sachet")),
    });
    const r = await cutOut("photo.jpg", W, H, calls);
    expect(r.items.map((i) => i.name)).toEqual(["Milo sachet", "Horlicks sachet"]);
  });

  test("a heap: 40 loose peppers in one lot become one catalogue item with the biggest crop as its picture", async () => {
    const singles = Array.from({ length: 40 }, (_, i) => rect(20 + (i % 10) * 30, 20 + Math.floor(i / 10) * 30, 25, 25));
    const { calls } = fake([P("Pepper", "red pepper", "pepper"), P("Oil", "oil bottle", "bottle")], { pepper: [...singles, rect(500, 400, 60, 50)], bottle: [rect(700, 10, 60, 180)] }, {
      review: acceptAll((c) => (c.phrase === "pepper" ? "pepper heap" : "oil")),
    });
    const r = await cutOut("photo.jpg", W, H, calls);
    // Items come in reading order of their cover pictures: the bottle sits above the pepper cluster.
    expect(r.items.map((i) => [i.name, i.crops.length])).toEqual([["Oil", 1], ["Pepper", 41]]);
    expect(r.items[1]!.cover.box.left).toBe(500);
  });

  test("look-alike basins of different grain stay separate items when Spark puts them in different lots", async () => {
    const basins = [rect(50, 300, 150, 100), rect(250, 300, 150, 100), rect(450, 300, 150, 100)];
    const { calls } = fake([P("Grain", "grain basin", "grain")], { grain: basins }, { review: acceptAll((c) => `basin ${c.number}`, (c) => ["Rice", "Beans", "Millet"][c.number - 1]!) });
    const r = await cutOut("photo.jpg", W, H, calls);
    expect(r.items.map((i) => i.name)).toEqual(["Rice", "Beans", "Millet"]);
  });

  test("crops Spark skips are kept as unreviewed rather than lost", async () => {
    const { calls } = fake([P("Tin", "milk tin", "tin")], { tin: [rect(100, 100, 50, 50), rect(300, 100, 50, 50)] }, {
      review: () => ({ crops: [{ number: 1, accept: true, name: "Peak milk", lot: "a" }, { number: 99, accept: false, name: "ghost", lot: "z" }], missing: [] }),
    });
    const r = await cutOut("photo.jpg", W, H, calls);
    expect(r.items.map((i) => [i.name, i.source])).toEqual([["Peak milk", "review"], ["Tin", "unreviewed"]]);
    expect(r.rejected).toEqual([]); // number 99 does not exist and is ignored
  });

  test("a failed review call (API error or spend cap) degrades to unreviewed items, not a crash", async () => {
    const { calls } = fake([P("Tin", "milk tin", "tin")], { tin: [rect(100, 100, 50, 50)] }, { review: () => { throw new Error("Daily cap reached"); } });
    const r = await cutOut("photo.jpg", W, H, calls);
    expect(r.items.map((i) => i.source)).toEqual(["unreviewed"]);
    expect(r.reviewError).toContain("Daily cap");
  });

  test("only the biggest crops go to review, so 117 single fruits cannot flood the paid call", async () => {
    const fruit = Array.from({ length: 117 }, (_, i) => rect(10 + (i % 20) * 45, 10 + Math.floor(i / 20) * 45, 30 + (i % 3), 30));
    const { calls, reviewed } = fake([P("Lime", "green lime", "lime")], { lime: fruit });
    const r = await cutOut("photo.jpg", W, H, calls);
    expect(reviewed[0]!.length).toBe(48);
    expect(r.dropped.filter((d) => d.reason === "not-reviewed")).toHaveLength(117 - 48);
  });
});

describe("box prompts for stock no crop covers", () => {
  test("Spark's boxes on the 0-1000 grid become pixel boxes, clamped to the photo", () => {
    expect(gridToPixels([100, 200, 300, 400], 1000, 800)).toEqual({ left: 100, top: 160, right: 300, bottom: 320 });
    expect(gridToPixels([-50, 900, 1200, 1100], 1000, 800)).toEqual({ left: 0, top: 720, right: 1000, bottom: 800 });
    expect(gridToPixels([300, 400, 100, 200], 1000, 800)).toEqual({ left: 100, top: 160, right: 300, bottom: 320 }); // swapped corners
    expect(gridToPixels([100, 100, 101, 101], 1000, 800)).toBeNull(); // no area
    expect(gridToPixels([1, 2, 3], 1000, 800)).toBeNull();
    expect(gridToPixels([NaN, 0, 10, 10], 1000, 800)).toBeNull();
  });

  test("a missed heap Spark points at is cut out by box prompt and added as its own item", async () => {
    const heap = rect(600, 500, 200, 150);
    const { calls, boxRequests } = fake([P("Seeds", "melon seed heap", "seed", "grain")], { bag: [rect(50, 50, 100, 100)] }, {
      review: (cs) => ({ crops: cs.map((c) => ({ number: c.number, accept: true, name: "Bag of rice", lot: "a" })), missing: [{ name: "Melon seeds", box: [600, 625, 800, 812] }] }),
      boxes: () => [heap],
    });
    const r = await cutOut("photo.jpg", W, H, calls);
    expect(boxRequests).toHaveLength(1);
    expect(r.items.map((i) => [i.name, i.source])).toEqual([["Bag of rice", "review"], ["Melon seeds", "box"]]);
  });

  test("at most 16 boxes go in one request, and a box mask that repeats an accepted crop or sits on a person is dropped", async () => {
    const trader = rect(0, 0, 200, 800);
    const tin = rect(400, 100, 80, 80);
    const missing = Array.from({ length: 20 }, (_, i) => ({ name: `thing ${i}`, box: [500, 500, 600, 600] }));
    const { calls, boxRequests } = fake([P("Tin", "milk tin", "tin")], { tin: [tin], [PERSON_PHRASE]: [trader] }, {
      review: (cs) => ({ crops: cs.map((c) => ({ number: c.number, accept: true, name: "Tin", lot: "a" })), missing }),
      boxes: (b) => b.map((_, i) => (i === 0 ? rect(402, 102, 78, 78) : i === 1 ? rect(10, 100, 150, 300) : null)),
    });
    const r = await cutOut("photo.jpg", W, H, calls);
    expect(boxRequests[0]!.length).toBe(MAX_BOXES);
    expect(r.items.map((i) => i.name)).toEqual(["Tin"]);
  });
});
