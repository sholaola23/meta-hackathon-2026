// Messy-input suite for photo intake and catalogue pictures. Promise under attack: every catalogue picture shows
// the trader's real product, unchanged, and nothing else that could pass for stock. No API calls.
import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeCatalogueImage, cutoutLayer, defaultBackdrop, FidelityError, isPlainBackdrop, pickBackdrop, SIZE } from "../catalogue-image";
import { MAX_SIDE, PhotoError, preparePhoto } from "../photo";
import { ellipse, rect } from "./helpers";

const REAL = join(import.meta.dir, "../../test-material/real-photos/real-02-buguma-pepper-okra.jpg");
const STALL = join(import.meta.dir, "../../test-material/real-photos/real-06-provision-store.jpg");
const tmp = () => mkdtempSync(join(tmpdir(), "stallsnap-"));

async function pixel(png: Buffer, x: number, y: number) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const o = (y * info.width + x) * info.channels;
  return [data[o]!, data[o + 1]!, data[o + 2]!];
}

describe("preparePhoto", () => {
  test("phone photo with EXIF rotation is turned upright, so SAM's coordinates match what the trader sees", async () => {
    const dir = tmp();
    const src = join(dir, "rotated.jpg");
    // Stored 800x400, tagged "rotate 90": displayed 400x800.
    await sharp({ create: { width: 800, height: 400, channels: 3, background: "#884422" } }).jpeg().withMetadata({ orientation: 6 }).toFile(src);
    const p = await preparePhoto(src, dir);
    expect(p.unchanged).toBe(false);
    expect([p.width, p.height]).toEqual([400, 800]);
    const meta = await sharp(p.path).metadata();
    expect([meta.width, meta.height, meta.orientation ?? 1]).toEqual([400, 800, 1]);
  });

  test("huge photo is capped at the longest-side limit", async () => {
    const dir = tmp();
    const src = join(dir, "huge.jpg");
    await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#336699" } }).jpeg().toFile(src);
    const p = await preparePhoto(src, dir);
    expect(Math.max(p.width, p.height)).toBe(MAX_SIDE);
  });

  test("PNG with transparency becomes a flat JPEG", async () => {
    const dir = tmp();
    const src = join(dir, "screenshot.png");
    await sharp({ create: { width: 600, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(src);
    const p = await preparePhoto(src, dir);
    expect((await sharp(p.path).metadata()).format).toBe("jpeg");
  });

  test("a file that is not a photo is refused with a message the trader can act on", async () => {
    const dir = tmp();
    const src = join(dir, "note.jpg");
    writeFileSync(src, "this is a voice note, not a picture");
    expect(preparePhoto(src, dir)).rejects.toBeInstanceOf(PhotoError);
  });

  test("a thumbnail-sized photo is refused", async () => {
    const dir = tmp();
    const src = join(dir, "tiny.jpg");
    await sharp({ create: { width: 150, height: 120, channels: 3, background: "#fff" } }).jpeg().toFile(src);
    expect(preparePhoto(src, dir)).rejects.toBeInstanceOf(PhotoError);
  });

  test("an upright JPEG under the limit is used as-is, so cached model responses stay valid", async () => {
    const p = await preparePhoto(REAL, tmp());
    expect(p.unchanged).toBe(true);
    expect(p.path).toBe(REAL);
  });
});

describe("composeCatalogueImage", () => {
  const photo = readFileSync(REAL);

  test("every solid product pixel is the trader's own pixel, unchanged", async () => {
    const mask = ellipse(300, 250, 400, 300);
    const img = await composeCatalogueImage(photo, mask, await defaultBackdrop());
    expect(img.fidelity.maxChannelDiff).toBeLessThanOrEqual(2);
    expect(img.fidelity.opaquePixels).toBeGreaterThan(50_000);
    const meta = await sharp(img.png).metadata();
    expect([meta.width, meta.height]).toEqual([SIZE, SIZE]);
  });

  test("at 1:1 scale the centre pixel matches the source photo exactly", async () => {
    // A crop exactly 80% of the canvas side is placed without resampling.
    const side = Math.round(SIZE * 0.8);
    const meta = await sharp(photo).metadata();
    const left = Math.floor((meta.width! - side) / 2), top = Math.floor((meta.height! - side) / 2);
    const img = await composeCatalogueImage(photo, rect(left, top, side, side), await defaultBackdrop());
    expect([img.placement.width, img.placement.height]).toEqual([side, side]);
    const cx = img.placement.left + 100, cy = img.placement.top + 100;
    expect(await pixel(img.png, cx, cy)).toEqual(await pixel(await sharp(photo).png().toBuffer(), left + 100, top + 100));
  });

  test("pixels outside the mask never leak into the picture (the stall around the product is gone)", async () => {
    const mask = ellipse(300, 250, 400, 300);
    const img = await composeCatalogueImage(photo, mask, await defaultBackdrop());
    // Bounding-box corner: outside the ellipse, so it must be backdrop (or soft shadow), never the photo.
    const corner = await pixel(img.png, img.placement.left + 2, img.placement.top + 2);
    const backdrop = await pixel(await sharp(await defaultBackdrop()).resize(SIZE, SIZE).png().toBuffer(), img.placement.left + 2, img.placement.top + 2);
    for (let c = 0; c < 3; c++) expect(Math.abs(corner[c]! - backdrop[c]!)).toBeLessThanOrEqual(12);
  });

  test("a tiny crop is not blown up more than 2x", async () => {
    const img = await composeCatalogueImage(photo, rect(100, 100, 40, 30), await defaultBackdrop());
    expect(img.placement.scale).toBe(2);
  });

  test("an empty mask is refused rather than producing a blank catalogue picture", async () => {
    const empty = { ...rect(100, 100, 50, 50), raster: new Uint8Array(2500) };
    expect(composeCatalogueImage(photo, empty, await defaultBackdrop())).rejects.toBeInstanceOf(FidelityError);
  });

  test("a mask hanging off the photo edge is clipped, not crashed", async () => {
    const meta = await sharp(photo).metadata();
    const layer = await cutoutLayer(photo, rect(meta.width! - 50, meta.height! - 40, 120, 90));
    expect([layer.width, layer.height]).toEqual([50, 40]);
  });
});

describe("backdrop gate (Muse Image may only supply an empty backdrop)", () => {
  test("the local studio gradient is plain", async () => {
    expect((await isPlainBackdrop(await defaultBackdrop())).plain).toBe(true);
  });

  test("a backdrop with an invented product on it is rejected", async () => {
    const bottle = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
<rect width="100%" height="100%" fill="#efe9df"/><rect x="430" y="300" width="160" height="420" rx="40" fill="#2a6b2a"/>
<rect x="470" y="220" width="80" height="90" fill="#cc2222"/></svg>`);
    expect((await isPlainBackdrop(await sharp(bottle).png().toBuffer())).plain).toBe(false);
  });

  test("a backdrop with writing on it is rejected", async () => {
    const text = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
<rect width="100%" height="100%" fill="#f4f0e8"/><text x="120" y="520" font-size="120" font-family="sans-serif" fill="#333">BEST PRICE</text></svg>`);
    expect((await isPlainBackdrop(await sharp(text).png().toBuffer())).plain).toBe(false);
  });

  test("a busy stall photo is rejected as a backdrop", async () => {
    expect((await isPlainBackdrop(readFileSync(STALL))).plain).toBe(false);
  });

  test("no real stall photo in the repo passes as a backdrop", async () => {
    for (const dir of ["real-photos", "held-out"]) {
      const base = join(import.meta.dir, "../../test-material", dir);
      for (const f of readdirSync(base).filter((n) => n.endsWith(".jpg")))
        expect({ f, plain: (await isPlainBackdrop(readFileSync(join(base, f)))).plain }).toEqual({ f, plain: false });
    }
  });

  test("pickBackdrop falls back to the local one when Muse Image returns clutter, garbage or nothing", async () => {
    const clutter = readFileSync(STALL);
    expect((await pickBackdrop(clutter)).source).toBe("default");
    expect((await pickBackdrop(Buffer.from("not an image"))).source).toBe("default");
    expect((await pickBackdrop(null)).source).toBe("default");
    expect((await pickBackdrop(await defaultBackdrop())).source).toBe("muse-image");
  });
});
