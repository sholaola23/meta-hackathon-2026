// Independent QA attacks on PR #4, round 2 (head 2d11b14). No API calls.
import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeCatalogueImage, defaultBackdrop, restyleCatalogueImage, SIZE } from "../catalogue-image";
import { usable } from "../cutout";
import { ellipse } from "./helpers";

const photo = readFileSync(join(import.meta.dir, "../../test-material/real-photos/real-02-buguma-pepper-okra.jpg"));
const svg = (b: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">${b}</svg>`);
const studio = () => sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: "#d9d4cc" } });
const composed = async () => composeCatalogueImage(photo, ellipse(300, 250, 400, 300), await defaultBackdrop());

describe("QA r2: a neutral grey object near the product is not a shadow", () => {
  test("a hard-edged grey tin just below the product is rejected", async () => {
    const c = await composed();
    const p = c.placement;
    const tin = svg(`<rect x="${p.left + 20}" y="${p.top + p.height + 5}" width="60" height="80" fill="#988f86"/>`);
    expect((await restyleCatalogueImage(c, await studio().composite([{ input: tin }]).png().toBuffer())).source).toBe("local");
  });

  test("a hard-edged grey tin beside the product's lower half is rejected", async () => {
    const c = await composed();
    const p = c.placement;
    const tin = svg(`<rect x="${p.left - 70}" y="${p.top + p.height * 0.7}" width="60" height="100" fill="#988f86"/>`);
    expect((await restyleCatalogueImage(c, await studio().composite([{ input: tin }]).png().toBuffer())).source).toBe("local");
  });
});

describe("QA r2: the wider person-word filter must not drop goods named after people", () => {
  test("products for or named after people still reach SAM", () => {
    for (const p of ["ladies finger", "baby wipes", "men's shoes", "children's sandals", "kids slippers", "baby corn"]) expect(usable(p)).not.toBe("");
  });

  test("phrases that are people are still blocked", () => {
    for (const p of ["lady", "a man", "trader's hand", "kid", "baby", "hawker", "market women"]) expect(usable(p)).toBe("");
  });
});
