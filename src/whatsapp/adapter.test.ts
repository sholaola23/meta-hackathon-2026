// The adapter between the WhatsApp loop and the image, pricing and catalogue modules, with fake models.
// Real pricing code (draft, confirm, publish) and the real job log; no network, no model calls, no money.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyToolCalls } from "../pricing/draft";
import type { Item } from "../pricing/types";
import { NO_PRODUCTS, StallPipeline, type FoundItem, type Models, type PublishedCatalogue } from "./adapter";
import { renderPage, serveCatalogue } from "./catalogue-page";
import { JobLog } from "./joblog";
import type { LocalMedia } from "./pipeline";
import { photoErrorMessage } from "./pipeline";
import { Store } from "./store";
import { button, payload, setup as loopSetup, text } from "./test-helpers";

const TRADER = "2348000000001";
const JOB = "3f0c2a1e-7b7d-4c55-9d3e-6a1c2b3d4e5f";

const media = (messageId: string, path = `/tmp/${messageId}`): LocalMedia => ({ messageId, path, mimeType: "image/jpeg", bytes: 10, sentAt: 1 });

/** Fake models: photo i gives the named items; the "transcript" is the price text; pricing reads "name na price unit". */
class FakeModels implements Models {
  calls = { cutout: 0, transcribe: 0, price: 0, polish: 0 };
  transcripts: string[] = [];
  priced: { items: Item[]; transcript: string }[] = [];
  polish?: Models["polish"];
  constructor(
    private photos: string[][],
    private notes: Record<string, string> = {},
  ) {}

  async cutout(_job: string, _photo: LocalMedia, photoIndex: number, imageDir: string): Promise<FoundItem[]> {
    this.calls.cutout++;
    return (this.photos[photoIndex - 1] ?? []).map((name, i) => {
      const image = `p${photoIndex}-${i + 1}.png`;
      writeFileSync(join(imageDir, image), `png of ${name}`);
      return { name, image };
    });
  }

  async transcribe(_job: string, voice: LocalMedia, names: string[]) {
    this.calls.transcribe++;
    this.transcripts.push(names.join(","));
    return this.notes[voice.messageId] ?? this.notes["*"] ?? "";
  }

  async price(_job: string, items: Item[], transcript: string) {
    this.calls.price++;
    this.priced.push({ items, transcript });
    // "Peak milk na 650 tin" -> set_price for the item whose name starts the clause.
    const calls = transcript.split(/[\n,]/).flatMap((clause) => {
      const m = clause.trim().match(/^(.+?) na (\d+) (\w+)$/);
      const item = m && items.find((i) => i.name.toLowerCase() === m[1]!.toLowerCase());
      return item ? [{ name: "set_price", arguments: JSON.stringify({ item_id: item.id, price_naira: Number(m![2]), unit: m![3], quote: clause }) }] : [];
    });
    return applyToolCalls(items, calls);
  }
}

function setup(models: Models) {
  const root = mkdtempSync(join(tmpdir(), "stallsnap-adapter-"));
  let n = 0;
  const pipeline = new StallPipeline({
    models,
    jobLog: new JobLog(join(root, "joblog")),
    dataDir: join(root, "data"),
    publicDir: join(root, "public"),
    publicBaseUrl: "https://stallsnap.example/",
    now: () => new Date("2026-10-28T09:30:00Z"),
    slug: () => `abc${String(++n).padStart(9, "0")}`,
  });
  return { root, pipeline, publicDir: join(root, "public"), dataDir: join(root, "data") };
}

const start = (p: StallPipeline, photos: LocalMedia[], voiceNotes: LocalMedia[] = [], texts: string[] = []) =>
  p.start({ traderId: TRADER, jobId: JOB, photos, voiceNotes, texts });
const reply = (p: StallPipeline, text: string) => p.reply({ traderId: TRADER, jobId: JOB, reply: { text } });

describe("adapter: photo and voice note to the trader's list", () => {
  test("items from every photo are numbered in one list, and the note is priced against them", async () => {
    const m = new FakeModels([["Peak milk", "Milo tin"], ["Indomie"]], { "wamid.V1": "Peak milk na 650 tin, Indomie na 250 pack" });
    const { pipeline } = setup(m);
    const t = await start(pipeline, [media("wamid.P1"), media("wamid.P2")], [media("wamid.V1")]);
    expect(t.version).toBe(1);
    expect(t.confirmed).toBe(false);
    expect(t.message).toContain("1. Peak milk: ₦650 per tin");
    expect(t.message).toContain("2. Milo tin: NO PRICE");
    expect(t.message).toContain("3. Indomie: ₦250 per pack");
    expect(m.transcripts).toEqual(["Peak milk,Milo tin,Indomie"]);
    expect(m.priced[0]!.items.map((i) => i.id)).toEqual(["i1", "i2", "i3"]);
  });

  test("typed prices count as part of the note", async () => {
    const m = new FakeModels([["Garri"]]);
    const { pipeline } = setup(m);
    const t = await start(pipeline, [media("wamid.P1")], [], ["Garri na 1500 cup"]);
    expect(t.message).toContain("Garri: ₦1,500 per cup");
  });

  test("a start run twice for the same job pays for each step once", async () => {
    const m = new FakeModels([["Peak milk"]], { "wamid.V1": "Peak milk na 650 tin" });
    const { pipeline } = setup(m);
    await start(pipeline, [media("wamid.P1")], [media("wamid.V1")]);
    const again = await start(pipeline, [media("wamid.P1")], [media("wamid.V1")]);
    expect(m.calls).toEqual({ cutout: 1, transcribe: 1, price: 1, polish: 0 });
    expect(again.message).toContain("Peak milk: ₦650 per tin");
  });

  test("a photo with no products gives the trader a message they can act on", async () => {
    const { pipeline } = setup(new FakeModels([[]]));
    const err = await start(pipeline, [media("wamid.P1")]).catch((e) => e);
    expect(photoErrorMessage(err)).toBe(NO_PRODUCTS);
  });

  test("a spend cap stops the job with its own error, so the loop says paused", async () => {
    const m = new FakeModels([["Peak milk"]]);
    m.price = async () => {
      const e = new Error("daily cap");
      e.name = "SpendCapError";
      throw e;
    };
    const { pipeline } = setup(m);
    const err = await start(pipeline, [media("wamid.P1")], [], ["Peak milk na 650 tin"]).catch((e) => e);
    expect(err.name).toBe("SpendCapError");
  });

  test("a picture name from the models can't point outside the job's folder", async () => {
    const m = new FakeModels([["Peak milk"]], { "wamid.V1": "Peak milk na 650 tin" });
    m.cutout = async () => [{ name: "Peak milk", image: "../../../etc/passwd" }];
    const { pipeline, publicDir } = setup(m);
    await start(pipeline, [media("wamid.P1")], [media("wamid.V1")]);
    await reply(pipeline, "YES");
    const { url } = await pipeline.publish({ traderId: TRADER, jobId: JOB });
    const c: PublishedCatalogue = JSON.parse(readFileSync(join(publicDir, url.split("/c/")[1]!, "catalogue.json"), "utf8"));
    expect(c.lines[0]!.image).toBeNull();
  });
});

describe("adapter: replies and publishing", () => {
  test("a voice reply is transcribed once and read like a typed one", async () => {
    const m = new FakeModels([["Peak milk"]], { "wamid.V1": "Peak milk na 650 tin", "wamid.V2": "1 na 700" });
    const { pipeline } = setup(m);
    await start(pipeline, [media("wamid.P1")], [media("wamid.V1")]);
    const t = await pipeline.reply({ traderId: TRADER, jobId: JOB, reply: { voiceNote: media("wamid.V2") } });
    expect(t.version).toBe(2);
    expect(t.message).toContain("Peak milk: ₦700 per tin");
    expect(m.calls.transcribe).toBe(2);
  });

  test("nothing publishes until the trader says yes to the latest list", async () => {
    const m = new FakeModels([["Peak milk"]], { "wamid.V1": "Peak milk na 650 tin" });
    const { pipeline } = setup(m);
    await start(pipeline, [media("wamid.P1")], [media("wamid.V1")]);
    await expect(pipeline.publish({ traderId: TRADER, jobId: JOB })).rejects.toThrow(/Not confirmed/);
    expect((await reply(pipeline, "1 na 700")).confirmed).toBe(false);
    expect((await reply(pipeline, "YES")).confirmed).toBe(true);
  });

  test("the published page has the confirmed lines and pictures, and none of the confirm conversation", async () => {
    const m = new FakeModels([["Peak milk", "Milo tin", "Indomie"]], { "wamid.V1": "Peak milk na 650 tin, Indomie na 250 pack" });
    const { pipeline, publicDir, dataDir } = setup(m);
    await start(pipeline, [media("wamid.P1")], [media("wamid.V1")]);
    await reply(pipeline, "comot 3");
    await reply(pipeline, "YES"); // Milo tin has no price: one more check
    const t = await reply(pipeline, "YES");
    expect(t.confirmed).toBe(true);
    const { url } = await pipeline.publish({ traderId: TRADER, jobId: JOB });
    expect(url).toBe("https://stallsnap.example/c/abc000000001");

    const dir = join(publicDir, "abc000000001");
    const c: PublishedCatalogue = JSON.parse(readFileSync(join(dir, "catalogue.json"), "utf8"));
    expect(c.lines).toEqual([
      { name: "Peak milk", price: 650, unit: "tin", image: expect.stringMatching(/^i1-v\d+\.png$/) },
      { name: "Milo tin", price: null, unit: null, image: expect.stringMatching(/^i2-v\d+\.png$/) },
    ]);
    expect(readFileSync(join(dir, c.lines[0]!.image!), "utf8")).toBe("png of Peak milk");
    const publicText = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    expect(publicText).not.toContain(TRADER);
    expect(publicText).not.toContain("comot");
    expect(publicText).not.toContain("YES");
    const audit = JSON.parse(readFileSync(join(dataDir, "jobs", JOB, "audit.json"), "utf8"));
    expect(audit.some((e: { text: string }) => e.text === "comot 3")).toBe(true);
  });

  test("publishing twice keeps one link", async () => {
    const m = new FakeModels([["Peak milk"]], { "wamid.V1": "Peak milk na 650 tin" });
    const { pipeline } = setup(m);
    await start(pipeline, [media("wamid.P1")], [media("wamid.V1")]);
    await reply(pipeline, "YES");
    const a = await pipeline.publish({ traderId: TRADER, jobId: JOB });
    const b = await pipeline.publish({ traderId: TRADER, jobId: JOB });
    expect(b.url).toBe(a.url);
  });

  test("a studio picture is used when polish gives one, and polish runs once per picture", async () => {
    const m = new FakeModels([["Peak milk"]], { "wamid.V1": "Peak milk na 650 tin" });
    m.polish = async (_j, dir, image) => {
      m.calls.polish++;
      writeFileSync(join(dir, "p1-1.studio.png"), "studio");
      return image.replace(".png", ".studio.png");
    };
    const { pipeline, publicDir } = setup(m);
    await start(pipeline, [media("wamid.P1")], [media("wamid.V1")]);
    await reply(pipeline, "YES");
    await pipeline.publish({ traderId: TRADER, jobId: JOB });
    await pipeline.publish({ traderId: TRADER, jobId: JOB });
    const c: PublishedCatalogue = JSON.parse(readFileSync(join(publicDir, "abc000000001", "catalogue.json"), "utf8"));
    expect(readFileSync(join(publicDir, "abc000000001", c.lines[0]!.image!), "utf8")).toBe("studio");
    expect(m.calls.polish).toBe(1);
  });

  test("a job id that could escape the data folder is refused", async () => {
    const { pipeline, root } = setup(new FakeModels([["Peak milk"]]));
    const bad = await pipeline.reply({ traderId: TRADER, jobId: "../../x", reply: { text: "YES" } }).catch((e) => e);
    expect(bad).toBeInstanceOf(Error);
    expect(existsSync(join(root, "x"))).toBe(false);
  });
});

describe("catalogue page", () => {
  const sample: PublishedCatalogue = {
    slug: "abc000000001",
    publishedAt: "2026-10-28T09:30:00Z",
    lines: [
      { name: "Peak milk <script>alert(1)</script>", price: 1800, unit: "tin", image: "1.png" },
      { name: "Ankara", price: null, unit: null, image: null },
    ],
  };

  test("shows each price with its unit, Ask for price, and escapes names", () => {
    const html = renderPage(sample);
    expect(html).toContain("₦1,800 per tin");
    expect(html).toContain("Ask for price");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("28 October 2026");
    expect(html).toContain('lang="en-GB"');
  });

  test("serves the page and its pictures, and refuses anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "stallsnap-page-"));
    const c = join(dir, sample.slug);
    require("node:fs").mkdirSync(c);
    writeFileSync(join(c, "catalogue.json"), JSON.stringify(sample));
    writeFileSync(join(c, "1.png"), "png");
    expect(serveCatalogue("/webhook", dir)).toBeNull();
    expect(serveCatalogue(`/c/${sample.slug}`, dir)!.status).toBe(200);
    expect(serveCatalogue(`/c/${sample.slug}/1.png`, dir)!.headers.get("Content-Type")).toBe("image/png");
    for (const bad of [`/c/${sample.slug}/2.png`, `/c/${sample.slug}/catalogue.json`, "/c/../../etc/passwd", "/c/abc000000002", `/c/${sample.slug}/..%2f1.png`, "/c/ABC000000001"]) {
      expect(serveCatalogue(bad, dir)!.status).toBe(404);
    }
  });
});

describe("adapter inside the real WhatsApp loop", () => {
  test("photo and voice note, the list with buttons, Yes, then one catalogue link that opens", async () => {
    const m = new FakeModels([["Peak milk", "Indomie"]], { "*": "Peak milk na 650 tin, Indomie na 250 pack" });
    const { pipeline, publicDir } = setup(m);
    const h = loopSetup({ pipeline });
    const T = 1_790_000_000;
    await h.deliver(payload([h.graph.image(T), h.graph.voice(T + 1)]));
    const list = h.outbox.sent.find((s) => s.message.type === "buttons");
    expect(list).toBeDefined();
    expect(list!.message.body).toContain("1. Peak milk: ₦650 per tin");
    await h.deliver(payload([button("yes:1", T + 30)]));
    const bodies = h.outbox.bodies();
    const last = bodies.at(-1)!;
    expect(last).toContain("https://stallsnap.example/c/abc000000001");
    const res = serveCatalogue("/c/abc000000001", publicDir)!;
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("₦250 per pack");
  });
});

describe("adapter: after the catalogue is out (QA PR #8 round 1)", () => {
  const catalogue = (publicDir: string): PublishedCatalogue => JSON.parse(readFileSync(join(publicDir, "abc000000001", "catalogue.json"), "utf8"));

  test("a change after publishing takes the prices down, and the next yes republishes the same link", async () => {
    const m = new FakeModels([["Peak milk", "Milo tin"]], { "wamid.V1": "Peak milk na 650 tin, Milo tin na 3500 tin" });
    const { pipeline, publicDir } = setup(m);
    await start(pipeline, [media("wamid.P1")], [media("wamid.V1")]);
    await reply(pipeline, "YES");
    const first = await pipeline.publish({ traderId: TRADER, jobId: JOB });
    const oldImage = catalogue(publicDir).lines[1]!.image!;

    const t = await reply(pipeline, "2 na 3000");
    expect(t.confirmed).toBe(false);
    const updating = await serveCatalogue("/c/abc000000001", publicDir)!.text();
    expect(updating).toContain("The trader is updating these prices");
    expect(updating).not.toContain("₦");
    // A wrong price must not stay visible, even as a picture link.
    expect(serveCatalogue(`/c/abc000000001/${oldImage}`, publicDir)!.status).toBe(404);

    await reply(pipeline, "YES");
    const second = await pipeline.publish({ traderId: TRADER, jobId: JOB });
    expect(second.url).toBe(first.url);
    const html = await serveCatalogue("/c/abc000000001", publicDir)!.text();
    expect(html).toContain("₦3,000 per tin");
    expect(html).not.toContain("₦3,500");
    const lines = catalogue(publicDir).lines;
    expect(lines[1]!.image).not.toBe(oldImage);
    expect(serveCatalogue(`/c/abc000000001/${lines[1]!.image}`, publicDir)!.status).toBe(200);
    expect(readdirSync(join(publicDir, "abc000000001"))).not.toContain(oldImage);
  });

  test("a list with every line removed is never published", async () => {
    const m = new FakeModels([["Peak milk"]], { "wamid.V1": "Peak milk na 650 tin" });
    const { pipeline, publicDir } = setup(m);
    await start(pipeline, [media("wamid.P1")], [media("wamid.V1")]);
    await reply(pipeline, "comot 1");
    const t = await reply(pipeline, "YES");
    expect(t.confirmed).toBe(false);
    const err = await pipeline.publish({ traderId: TRADER, jobId: JOB }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(existsSync(publicDir) ? readdirSync(publicDir) : []).toEqual([]);
  });

  test("pictures go out as the small web copy when the model gives one", async () => {
    const m = new FakeModels([["Peak milk"]], { "wamid.V1": "Peak milk na 650 tin" });
    const made: string[] = [];
    const models: Models = Object.assign(m, {
      thumbnail: async (src: string, dest: string) => {
        made.push(src);
        writeFileSync(dest, `small ${readFileSync(src, "utf8")}`);
      },
    });
    const { pipeline, publicDir } = setup(models);
    await start(pipeline, [media("wamid.P1")], [media("wamid.V1")]);
    await reply(pipeline, "YES");
    await pipeline.publish({ traderId: TRADER, jobId: JOB });
    const image = catalogue(publicDir).lines[0]!.image!;
    expect(image).toMatch(/^i1-v\d+\.webp$/);
    expect(made).toHaveLength(1);
    const res = serveCatalogue(`/c/abc000000001/${image}`, publicDir)!;
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(await res.text()).toBe("small png of Peak milk");
    expect(renderPage(catalogue(publicDir))).toContain('width="96" height="96"');
  });
});

describe("loop: after the catalogue is out", () => {
  test("a correction after the link went out is applied, and a plain message gets help instead", async () => {
    const m = new FakeModels([["Peak milk", "Milo tin"]], { "*": "Peak milk na 650 tin, Milo tin na 3500 tin" });
    const { pipeline, publicDir } = setup(m);
    const h = loopSetup({ pipeline });
    const T = 1_790_000_000;
    await h.deliver(payload([h.graph.image(T), h.graph.voice(T + 1)]));
    await h.deliver(payload([button("yes:1", T + 10)]));
    expect(h.outbox.bodies().at(-1)).toContain("/c/abc000000001");

    const before = h.outbox.sent.length;
    await h.deliver(payload([text("thank you", T + 20)]));
    expect(h.outbox.sent.length).toBe(before + 1);
    expect(await serveCatalogue("/c/abc000000001", publicDir)!.text()).toContain("₦3,500");

    await h.deliver(payload([text("2 na 3000", T + 30)]));
    expect(await serveCatalogue("/c/abc000000001", publicDir)!.text()).toContain("updating");
    const list = h.outbox.sent.filter((s) => s.message.type === "buttons").at(-1)!;
    expect(list.message.body).toContain("₦3,000");
    const version = list.message.type === "buttons" ? list.message.buttons[0]!.id : "";
    await h.deliver(payload([button(version, T + 40)]));
    expect(h.outbox.bodies().at(-1)).toContain("/c/abc000000001");
    const html = await serveCatalogue("/c/abc000000001", publicDir)!.text();
    expect(html).toContain("₦3,000 per tin");
    expect(html).not.toContain("₦3,500");
  });
});

describe("loop: a restart in the middle of a correction after publishing", () => {
  const T = 1_790_000_000;
  async function published() {
    const m = new FakeModels([["Peak milk"]], { "*": "Peak milk na 650 tin" });
    const store = new Store();
    const { pipeline, publicDir, root } = setup(m);
    const h = loopSetup({ pipeline, store });
    await h.deliver(payload([h.graph.image(T), h.graph.voice(T + 1)]));
    await h.deliver(payload([button("yes:1", T + 10)]));
    expect(await serveCatalogue("/c/abc000000001", publicDir)!.text()).toContain("₦650 per tin");
    // A fresh adapter on the same folders, as after a restart.
    const restart = () =>
      loopSetup({
        store,
        pipeline: new StallPipeline({
          models: m,
          jobLog: new JobLog(join(root, "joblog")),
          dataDir: join(root, "data"),
          publicDir,
          publicBaseUrl: "https://stallsnap.example/",
          now: () => new Date("2026-10-28T09:30:00Z"),
          slug: () => "abc999999999",
        }),
      });
    return { pipeline, store, publicDir, restart, m };
  }

  test("the correction was saved: the trader gets the corrected list back, and yes puts the page right", async () => {
    const { pipeline, store, publicDir, restart } = await published();
    const s = store.get(TRADER)!;
    await pipeline.reply({ traderId: TRADER, jobId: s.jobId, reply: { text: "1 na 700" } });
    store.set(TRADER, { ...s, phase: "working" }); // the crash: the loop never saw the answer
    expect(await serveCatalogue("/c/abc000000001", publicDir)!.text()).toContain("updating");

    const h2 = restart();
    h2.loop.resume();
    await h2.loop.idle();
    const list = h2.outbox.sent.find((x) => x.message.type === "buttons")!;
    expect(list.message.body).toContain("₦700");
    expect(h2.outbox.bodies().join("\n")).not.toContain("something went wrong");

    const yes = list.message.type === "buttons" ? list.message.buttons[0]!.id : "";
    await h2.deliver(payload([button(yes, T + 100)]));
    expect(h2.outbox.bodies().at(-1)).toContain("https://stallsnap.example/c/abc000000001");
    const html = await serveCatalogue("/c/abc000000001", publicDir)!.text();
    expect(html).toContain("₦700 per tin");
    expect(html).not.toContain("updating");
  });

  test("the correction never reached the pricing step: the page keeps its prices and the trader is not sent the link again", async () => {
    const { store, publicDir, restart, m } = await published();
    store.set(TRADER, { ...store.get(TRADER)!, phase: "working" });
    const h2 = restart();
    h2.loop.resume();
    await h2.loop.idle();
    expect(h2.outbox.bodies().join("\n")).not.toContain("/c/abc000000001");
    expect(h2.outbox.bodies().length).toBe(1);
    expect(await serveCatalogue("/c/abc000000001", publicDir)!.text()).toContain("₦650 per tin");
    expect(m.calls).toMatchObject({ cutout: 1, price: 1 });
  });

  test("a restart before any list exists still asks the trader to send again", async () => {
    const m = new FakeModels([["Peak milk"]], { "*": "Peak milk na 650 tin" });
    const store = new Store();
    const { pipeline } = setup(m);
    store.set(TRADER, { jobId: JOB, phase: "working", photos: [], voiceNotes: [], texts: [], replies: 0, pending: [], told: [] });
    const h = loopSetup({ pipeline, store });
    h.loop.resume();
    await h.loop.idle();
    expect(h.outbox.bodies().join("\n")).toContain("something went wrong");
  });
});
