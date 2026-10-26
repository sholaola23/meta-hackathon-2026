// A small web copy of a catalogue picture for the public page, which shows pictures at 96px.
// A 320px WebP is a few kilobytes instead of a 1 MB PNG; the product pixels are only scaled, never changed.
import sharp from "sharp";

export async function webThumbnail(src: string, dest: string, size = 320): Promise<void> {
  await sharp(src).resize(size, size, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toFile(dest);
}
