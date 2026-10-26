// Messy-input suite for photo intake and catalogue pictures. Promise under attack: every catalogue picture shows
// the trader's real product, unchanged, and nothing else that could pass for stock. No API calls.
import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeCatalogueImage, cutoutLayer, defaultBackdrop, FidelityError, restyleCatalogueImage, SIZE } from "../catalogue-image";
import { MAX_SIDE, PhotoError, preparePhoto } from "../photo";
import { ellipse, rect } from "./helpers";

const REAL = join(import.meta.dir, "../../test-material/real-photos/real-02-buguma-pepper-okra.jpg");
const STALL = join(import.meta.dir, "../../test-material/real-photos/real-06-provision-store.jpg");
const photo = readFileSync(REAL);
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

describe("Muse Image restyle (the real product is pasted back; nothing new may appear around it)", () => {
  const studio = () => sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: "#d9d4cc" } });
  const composed = async () => composeCatalogueImage(photo, ellipse(300, 250, 400, 300), await defaultBackdrop());

  test("no restyle keeps the composed picture", async () => {
    const c = await composed();
    const out = await restyleCatalogueImage(c, null);
    expect(out.source).toBe("local");
    expect(out.png.equals(c.png)).toBe(true);
  });

  test("a plain studio restyle is used, with the real product pasted back pixel for pixel", async () => {
    const c = await composed();
    const out = await restyleCatalogueImage(c, await studio().png().toBuffer());
    expect(out.source).toBe("muse-image");
    expect(out.fidelity.maxChannelDiff).toBe(0);
    // Off the product, the picture is the restyled backdrop.
    expect(await pixel(out.png, 10, 10)).toEqual([0xd9, 0xd4, 0xcc]);
  });

  test("a restyle that redrew or recoloured the product is corrected: the trader's own pixels go back on top", async () => {
    const c = await composed();
    const p = c.placement;
    // Muse Image recolours the product itself (every product pixel green), backdrop untouched.
    const green = Buffer.from(c.product);
    for (let i = 0; i < p.width * p.height; i++) if (green[i * 4 + 3]) [green[i * 4], green[i * 4 + 1], green[i * 4 + 2]] = [0, 255, 0];
    const altered = await sharp(c.png).composite([{ input: green, raw: { width: p.width, height: p.height, channels: 4 }, left: p.left, top: p.top }]).png().toBuffer();
    const out = await restyleCatalogueImage(c, altered);
    expect(out.source).toBe("muse-image");
    expect(out.fidelity.maxChannelDiff).toBe(0);
    const cx = p.left + Math.round(p.width / 2), cy = p.top + Math.round(p.height / 2);
    expect(await pixel(out.png, cx, cy)).toEqual(await pixel(c.png, cx, cy));
  });

  test("a restyle that relights the backdrop and deepens the existing contact shadow is used", async () => {
    const c = await composed();
    // Relit backdrop, and the composed shadow made 30% darker (an even darkening inside the shadow only).
    const lit = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
<defs><radialGradient id="g" cx="50%" cy="50%" r="70%"><stop offset="0%" stop-color="#f2efe9"/><stop offset="100%" stop-color="#bdb6aa"/></radialGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/></svg>`)).removeAlpha().raw().toBuffer();
    for (let i = 0; i < SIZE * SIZE; i++) if (c.shade[i]! > 4) for (let k = 0; k < 3; k++) lit[i * 3 + k] = Math.round(lit[i * 3 + k]! * 0.7);
    const out = await restyleCatalogueImage(c, await sharp(lit, { raw: { width: SIZE, height: SIZE, channels: 3 } }).png().toBuffer());
    expect(out.source).toBe("muse-image");
  });

  test("a restyle that draws its own shadow outside the composed one fails closed to the composed picture", async () => {
    const c = await composed();
    const p = c.placement;
    const shadow = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><ellipse cx="${p.left + p.width / 2}" cy="${p.top + p.height + 40}" rx="${p.width / 2}" ry="40" fill="#000" fill-opacity="0.25"/></svg>`);
    expect((await restyleCatalogueImage(c, await studio().composite([{ input: shadow }]).png().toBuffer())).source).toBe("local");
  });

  test("a dark or coloured object drawn under the product is not mistaken for its shadow", async () => {
    const c = await composed();
    const p = c.placement;
    for (const fill of ["#222222", "#c0392b"]) {
      const tin = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><rect x="${p.left + p.width / 2 - 30}" y="${p.top + p.height + 4}" width="60" height="40" fill="${fill}"/></svg>`);
      expect((await restyleCatalogueImage(c, await studio().composite([{ input: tin }]).png().toBuffer())).source).toBe("local");
    }
  });

  test("a restyle that adds an invented bottle beside the product is rejected", async () => {
    const c = await composed();
    const bottle = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
<rect x="20" y="300" width="70" height="300" rx="20" fill="#2a6b2a"/><rect x="38" y="250" width="34" height="50" fill="#cc2222"/></svg>`);
    const out = await restyleCatalogueImage(c, await studio().composite([{ input: bottle }]).png().toBuffer());
    expect(out.source).toBe("local");
    expect(out.rejected).toContain("something new");
  });

  test("a restyle with writing on the backdrop is rejected", async () => {
    const c = await composed();
    const text = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
<text x="40" y="1000" font-size="70" font-family="sans-serif" fill="#333">BEST PRICE</text></svg>`);
    const out = await restyleCatalogueImage(c, await studio().composite([{ input: text }]).png().toBuffer());
    expect(out.source).toBe("local");
  });

  test("a restyle that moved the product leaves a ghost, so it is rejected", async () => {
    const c = await composed();
    const moved = await sharp(c.png).extract({ left: 0, top: 0, width: SIZE - 200, height: SIZE }).extend({ left: 200, background: "#e8e1d5" }).png().toBuffer();
    expect((await restyleCatalogueImage(c, moved)).source).toBe("local");
  });

  test("a busy stall photo, a wrong shape or garbage falls back to the composed picture", async () => {
    const c = await composed();
    expect((await restyleCatalogueImage(c, await sharp(readFileSync(STALL)).resize(SIZE, SIZE).png().toBuffer())).source).toBe("local");
    expect((await restyleCatalogueImage(c, await sharp({ create: { width: 1024, height: 768, channels: 3, background: "#ddd" } }).png().toBuffer())).rejected).toContain("not square");
    expect((await restyleCatalogueImage(c, Buffer.from("not an image"))).source).toBe("local");
  });
});
