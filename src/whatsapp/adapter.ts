// The Pipeline the WhatsApp loop calls, joining the image step, the pricing confirm step and the catalogue page.
// photos -> catalogue items (cut-outs), voice notes -> transcript, transcript -> priced draft -> the trader's list,
// replies -> handleReply, YES -> publish() -> a public page. The model calls are injected (live-models.ts in the
// server, fakes in tests), and each paid step runs once per job through JobLog, so a retry never pays twice.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditLog, handleReply, publish, renderList, startConfirmation, type Session as PricingSession } from "../pricing/confirm";
import type { Draft, Item } from "../pricing/types";
import type { JobLog } from "./joblog";
import type { LocalMedia, Pipeline, PricingTurn, StartInput, TraderReply } from "./pipeline";

/** One product found in one photo, with its catalogue picture already made (a file in the job's image folder). */
export interface FoundItem {
  name: string;
  /** File name inside the job's image folder, such as "p1-3.png". */
  image: string;
}

export interface Models {
  /** Photo -> products on it. Writes each product's picture into imageDir. Throws a PhotoError the trader can read. */
  cutout(jobId: string, photo: LocalMedia, photoIndex: number, imageDir: string): Promise<FoundItem[]>;
  /** Voice note -> text. itemNames bias the transcriber toward the stall's words. */
  transcribe(jobId: string, voice: LocalMedia, itemNames: string[]): Promise<string>;
  /** Transcript (plus any typed prices) -> a priced draft. */
  price(jobId: string, items: Item[], transcript: string, photo?: LocalMedia): Promise<Draft>;
  /** Optional studio clean-up of one picture at publish. Returns the file name to show; never invents products. */
  polish?(jobId: string, imageDir: string, image: string): Promise<string>;
  /** Optional small web copy of a picture for the page (dest ends in .webp). Without it the PNG is copied as it is. */
  thumbnail?(src: string, dest: string): Promise<void>;
}

export interface AdapterConfig {
  models: Models;
  jobLog: JobLog;
  /** Private: one folder per job with its pricing session, pictures and audit log. */
  dataDir: string;
  /** Public: one folder per published catalogue, served at /c/<slug>. */
  publicDir: string;
  /** Public HTTPS address of the server, such as https://stallsnap.example. */
  publicBaseUrl: string;
  /** Shown at the top of the page. A real trader's name goes here once they give it; never their phone number. */
  stallName?: string;
  now?: () => Date;
  slug?: () => string;
}

/** The demo is Shola playing the trader, labelled honestly; no real stall or number is shown. */
export const DEMO_STALL_NAME = "StallSnap Demo Stall";

/** What the catalogue page reads. Nothing about the trader's phone or the confirm conversation goes in here. */
export interface PublishedCatalogue {
  slug: string;
  stallName?: string;
  publishedAt: string;
  /** True while the trader is correcting a list that was already published: the page shows no prices. */
  updating?: boolean;
  lines: { name: string; price: number | null; unit: string | null; image: string | null }[];
}

interface Job {
  traderId: string;
  items: (Item & { image: string })[];
  session: PricingSession;
  slug?: string;
}

/** Same name and shape as image/photo.ts, so the loop sends its message to the trader. */
export class PhotoProblem extends Error {
  override name = "PhotoError";
}

export const NOTHING_LEFT = "Nothing is left on your list. Send a new photo of your stall and a voice note to start again.";
export const NO_PRODUCTS = "I could not find products in that photo. Please send a clear photo of the stall in daylight, with the goods in view.";
const SLUG = /^[a-z0-9]{12}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,80}$/;
const FILE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,80}$/;

export class StallPipeline implements Pipeline {
  private readonly now: () => Date;
  private readonly slug: () => string;

  private readonly stallName: string;

  constructor(private readonly cfg: AdapterConfig) {
    // Cut by character, not UTF-16 unit, so an emoji at the limit is never split into a broken symbol.
    this.stallName = Array.from(cfg.stallName?.trim() ?? "").slice(0, 60).join("").trim() || DEMO_STALL_NAME;
    // The page must never carry a phone number, even one typed into the name setting.
    if (/\d(?:[\s().+-]*\d){6}/.test(this.stallName)) throw new Error("CATALOGUE_STALL_NAME looks like it holds a phone number; use a name only");
    this.now = cfg.now ?? (() => new Date());
    this.slug = cfg.slug ?? (() => randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x").slice(0, 12));
  }

  async start(input: StartInput): Promise<PricingTurn> {
    const { jobId } = input;
    const { models, jobLog } = this.cfg;
    const imageDir = this.imageDir(jobId);
    mkdirSync(imageDir, { recursive: true });

    const found: FoundItem[] = [];
    for (const [i, photo] of input.photos.entries()) {
      const items = await jobLog.step(jobId, `cutout:${photo.messageId}`, () => models.cutout(jobId, photo, i + 1, imageDir));
      found.push(...items);
    }
    if (!found.length) throw new PhotoProblem(NO_PRODUCTS);
    // A picture name comes back from the models; it must stay a plain file name inside the job's folder.
    const items = found.map((f, i) => ({ id: `i${i + 1}`, name: f.name, image: FILE.test(f.image) && !f.image.includes("..") ? f.image : "" }));
    const names = items.map((i) => i.name);

    const notes: string[] = [];
    for (const v of input.voiceNotes) {
      notes.push(await jobLog.step(jobId, `transcript:${v.messageId}`, () => models.transcribe(jobId, v, names)));
    }
    // Typed prices and captions count as part of the note; the trader sometimes types instead of talking.
    const transcript = [...notes, ...input.texts].map((t) => t.trim()).filter(Boolean).join("\n");
    const pricingKey = `pricing:${[...input.photos, ...input.voiceNotes].map((m) => m.messageId).join("+")}:${input.texts.length}`;
    const draft = await jobLog.step(jobId, pricingKey.slice(0, 200), () =>
      models.price(jobId, items.map(({ id, name }) => ({ id, name })), transcript, input.photos[0]),
    );

    const { session, message } = startConfirmation(draft, this.now);
    this.save(jobId, { traderId: input.traderId, items, session });
    return turn(session, message);
  }

  async reply(input: { traderId: string; jobId: string; reply: TraderReply }): Promise<PricingTurn> {
    const job = this.load(input.jobId);
    const text = await this.replyText(input.jobId, job, input.reply);
    const r = handleReply(job.session, text, this.now);
    // A change after the catalogue went out: take its prices down until the trader says yes to the new list.
    if (r.reopened && job.slug) this.markUpdating(job.slug);
    this.save(input.jobId, { ...job, session: r.session });
    return turn(r.session, r.message);
  }

  async current(input: { traderId: string; jobId: string }): Promise<PricingTurn> {
    const job = this.load(input.jobId);
    return turn(job.session, renderList(job.session));
  }

  async publish(input: { traderId: string; jobId: string }): Promise<{ url: string }> {
    const { jobId } = input;
    const job = this.load(jobId);
    const catalogue = publish(job.session); // throws unless the trader confirmed the latest list
    const slug = job.slug ?? this.slug();
    if (!SLUG.test(slug)) throw new Error("bad catalogue slug");
    if (!catalogue.lines.length) throw new PhotoProblem(NOTHING_LEFT);
    // Built in a fresh folder and swapped in whole, so a republish leaves no picture from an older list behind.
    const dir = join(this.cfg.publicDir, slug);
    const next = `${dir}.next`;
    rmSync(next, { recursive: true, force: true });
    mkdirSync(next, { recursive: true });

    const byId = new Map(job.items.map((i) => [i.id, i]));
    const lines: PublishedCatalogue["lines"] = [];
    for (const line of catalogue.lines) {
      const item = byId.get(line.itemId);
      let image: string | null = null;
      if (item?.image) {
        const polished = this.cfg.models.polish
          ? await this.cfg.jobLog.step(jobId, `polish:${item.image}`, () => this.cfg.models.polish!(jobId, this.imageDir(jobId), item.image))
          : item.image;
        const src = join(this.imageDir(jobId), FILE.test(polished) && !polished.includes("..") ? polished : item.image);
        if (existsSync(src)) {
          // Named by item and list version: a customer's cached picture can never sit next to another product's name.
          const name = `${item.id}-v${catalogue.confirmedVersion}`;
          if (this.cfg.models.thumbnail) {
            image = `${name}.webp`;
            await this.cfg.models.thumbnail(src, join(next, image));
          } else {
            image = `${name}.png`;
            writeFileSync(join(next, image), readFileSync(src));
          }
        }
      }
      lines.push({ name: line.name, price: line.price, unit: line.unit, image });
    }
    const page: PublishedCatalogue = { slug, stallName: this.stallName, publishedAt: this.now().toISOString(), lines };
    writeFileSync(join(next, "catalogue.json"), JSON.stringify(page, null, 1));
    swapIn(next, dir);
    // The confirm conversation stays private, next to the job, so every price can be traced to the trader's yes.
    atomicWrite(join(this.jobDir(jobId), "audit.json"), JSON.stringify(auditLog(job.session), null, 1));
    this.save(jobId, { ...job, slug });
    return { url: `${this.cfg.publicBaseUrl.replace(/\/+$/, "")}/c/${slug}` };
  }

  /** The page stays up but shows no prices while the trader fixes a published list. */
  private markUpdating(slug: string) {
    const file = join(this.cfg.publicDir, slug, "catalogue.json");
    if (!SLUG.test(slug) || !existsSync(file)) return;
    const page = JSON.parse(readFileSync(file, "utf8")) as PublishedCatalogue;
    atomicWrite(file, JSON.stringify({ ...page, updating: true, lines: [] }, null, 1));
  }

  private async replyText(jobId: string, job: Job, reply: TraderReply): Promise<string> {
    if ("text" in reply) return reply.text;
    const names = job.items.map((i) => i.name);
    return this.cfg.jobLog.step(jobId, `transcript:${reply.voiceNote.messageId}`, () => this.cfg.models.transcribe(jobId, reply.voiceNote, names));
  }

  private jobDir(jobId: string) {
    if (!JOB_ID.test(jobId)) throw new Error("bad job id");
    return join(this.cfg.dataDir, "jobs", jobId);
  }

  private imageDir(jobId: string) {
    return join(this.jobDir(jobId), "images");
  }

  private load(jobId: string): Job {
    const file = join(this.jobDir(jobId), "job.json");
    if (!existsSync(file)) throw new Error(`no job ${jobId}`);
    return JSON.parse(readFileSync(file, "utf8")) as Job;
  }

  private save(jobId: string, job: Job) {
    mkdirSync(this.jobDir(jobId), { recursive: true });
    atomicWrite(join(this.jobDir(jobId), "job.json"), JSON.stringify(job));
  }
}

function turn(session: PricingSession, message: string): PricingTurn {
  return { version: session.version, message, confirmed: session.status === "confirmed" };
}

function swapIn(next: string, dir: string) {
  const old = `${dir}.old`;
  rmSync(old, { recursive: true, force: true });
  if (existsSync(dir)) renameSync(dir, old);
  renameSync(next, dir);
  rmSync(old, { recursive: true, force: true });
}

function atomicWrite(file: string, data: string) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}
