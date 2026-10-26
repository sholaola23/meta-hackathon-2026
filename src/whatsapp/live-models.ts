// The real model calls behind the adapter: the image step (image/) and pricing (src/pricing/live.ts).
// Only server.ts imports this; tests use fakes. Every paid call goes through the one SpendGuard passed in.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeCatalogueImage, defaultBackdrop, restyleCatalogueImage, type CatalogueImage } from "../../image/catalogue-image";
import { cutOut } from "../../image/cutout";
import { liveCalls, museImageRestyle } from "../../image/live";
import { PhotoError, preparePhoto } from "../../image/photo";
import { extractPrices } from "../pricing/extract";
import { responder, transcribe } from "../pricing/live";
import type { SpendGuard } from "../spend-guard";
import { PhotoProblem, type FoundItem, type Models } from "./adapter";

export function liveModels(guard: SpendGuard, opts: { restyle: boolean }): Models {
  return {
    async cutout(jobId, photo, photoIndex, imageDir) {
      let prepared;
      try {
        prepared = await preparePhoto(photo.path, join(imageDir, "prepared"));
      } catch (e) {
        // image/photo.ts writes its messages for the trader; give them the name the loop looks for.
        if (e instanceof PhotoError) throw new PhotoProblem(e.message);
        throw e;
      }
      const result = await cutOut(prepared.path, prepared.width, prepared.height, liveCalls(guard, jobId, prepared));
      const photoBytes = readFileSync(prepared.path);
      const backdrop = await defaultBackdrop();
      const found: FoundItem[] = [];
      for (const item of result.items) {
        const base = `p${photoIndex}-${item.number}`;
        try {
          const composed = await composeCatalogueImage(photoBytes, item.cover, backdrop);
          writeFileSync(join(imageDir, `${base}.png`), composed.png);
          // Kept so a studio restyle at publish can paste the real product pixels back over it.
          writeFileSync(join(imageDir, `${base}.product.raw`), composed.product);
          writeFileSync(join(imageDir, `${base}.shade.raw`), composed.shade);
          writeFileSync(join(imageDir, `${base}.json`), JSON.stringify({ placement: composed.placement, fidelity: composed.fidelity }));
          found.push({ name: item.name, image: `${base}.png` });
        } catch (e) {
          // A crop whose real pixels can't be shown faithfully goes on the list without a picture.
          console.warn(`cut-out ${base}: no picture (${(e as Error).message})`);
          found.push({ name: item.name, image: "" });
        }
      }
      return found;
    },

    transcribe: (jobId, voice, itemNames) => transcribe(guard, jobId, voice.path, itemNames.map((name) => ({ name }))),

    async price(jobId, items, transcript, photo) {
      const photoUrl = photo ? `data:image/jpeg;base64,${readFileSync(photo.path).toString("base64")}` : undefined;
      const { draft, stopped } = await extractPrices(items, transcript, responder(guard, jobId), photoUrl);
      if (stopped) console.warn(`pricing ${jobId}: loop stopped early (${stopped})`);
      return draft;
    },

    ...(opts.restyle
      ? {
          async polish(jobId, imageDir, image) {
            const base = image.replace(/\.png$/, "");
            const meta = JSON.parse(readFileSync(join(imageDir, `${base}.json`), "utf8"));
            const composed: CatalogueImage = {
              png: readFileSync(join(imageDir, image)),
              product: readFileSync(join(imageDir, `${base}.product.raw`)),
              shade: new Uint8Array(readFileSync(join(imageDir, `${base}.shade.raw`))),
              placement: meta.placement,
              fidelity: meta.fidelity,
            };
            const final = await restyleCatalogueImage(composed, await museImageRestyle(guard, jobId, composed.png));
            if (final.source !== "muse-image") return image;
            mkdirSync(imageDir, { recursive: true });
            writeFileSync(join(imageDir, `${base}.studio.png`), final.png);
            return `${base}.studio.png`;
          },
        }
      : {}),
  };
}
