// The pictures Muse Spark reviews: they must stay small enough to send and show every crop number. No API calls.
import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Crop } from "../cutout";
import { numberedPhoto, reviewSheet, SHEET_COLS } from "../review-sheet";
import { ellipse, rect } from "./helpers";

const photo = readFileSync(join(import.meta.dir, "../../test-material/real-photos/real-02-buguma-pepper-okra.jpg"));
const crop = (n: number, m = rect(20 + (n % 10) * 40, 20 + Math.floor(n / 10) * 40, 30, 30)): Crop => ({ ...m, productIndex: 0, phrase: "x", productName: "x", number: n });

describe("review pictures", () => {
  test("a full sheet of 48 crops stays within 1500px and keeps one tile per crop", async () => {
    const crops = Array.from({ length: 48 }, (_, i) => crop(i + 1));
    const sheet = await reviewSheet(photo, crops);
    const meta = await sharp(sheet).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1500);
    // 8 columns by 6 rows of square tiles.
    expect(meta.width! / meta.height!).toBeCloseTo(SHEET_COLS / 6, 2);
  });

  test("a crop at the photo edge and an odd-shaped mask render without error", async () => {
    const meta = await sharp(photo).metadata();
    const crops = [crop(1, rect(meta.width! - 30, meta.height! - 30, 30, 30)), crop(2, ellipse(100, 100, 200, 120))];
    expect((await sharp(await reviewSheet(photo, crops)).metadata()).format).toBe("jpeg");
  });

  test("the numbered photo stays within 1500px", async () => {
    const meta = await sharp(await numberedPhoto(photo, [crop(1), crop(2)])).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1500);
  });
});
