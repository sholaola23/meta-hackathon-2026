// Messy-input suite for the WhatsApp loop. Each test is one way a real trader (or WhatsApp itself) can
// misbehave, and checks every message the trader receives, not just the happy result.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copy } from "./copy";
import { Store } from "./store";
import { button, msg, payload, setup, text, TRADER } from "./test-helpers";

const T = 1_790_000_000;
const LIST_V1 = copy.priceList("1. Peak milk: N600 per tin\n2. Indomie: N250 per pack (list v1)", 1)[0]!.body;

describe("happy path", () => {
  test("photo, then voice note, then Yes: one ack, one list, one link, nothing else", async () => {
    const { graph, outbox, pipeline, deliver } = setup();
    await deliver(payload([graph.image(T)]), payload([graph.voice(T + 4)]));
    expect(pipeline.starts).toHaveLength(1);
    expect(pipeline.starts[0]!.photos).toHaveLength(1);
    expect(pipeline.starts[0]!.voiceNotes).toHaveLength(1);
    expect(pipeline.starts[0]!.voiceNotes[0]!.isVoiceNote).toBe(true);
    expect(outbox.bodies()).toEqual([copy.working.body, LIST_V1]);
    const list = outbox.sent[1]!.message;
    expect(list.type === "buttons" && list.buttons.map((b) => b.id)).toEqual(["yes:1", "change:1", "restart:1"]);

    await deliver(payload([button("yes:1", T + 60)]));
    expect(pipeline.publishes).toBe(1);
    expect(outbox.bodies()).toEqual([copy.working.body, LIST_V1, copy.catalogueReady("https://stallsnap.example/c/test-stall").body]);
    // Never an image burst: everything the trader got is text or buttons.
    expect(outbox.sent.every((s) => s.message.type === "text" || s.message.type === "buttons")).toBe(true);
  });

  test("voice note before photo (out of order) still makes one list", async () => {
    const { graph, outbox, pipeline, deliver } = setup();
    await deliver(payload([graph.voice(T)]), payload([graph.image(T + 3)]));
    expect(pipeline.starts).toHaveLength(1);
    expect(outbox.bodies()).toEqual([copy.working.body, LIST_V1]);
  });

  test("photo and voice note in one webhook with timestamps reversed are sorted", async () => {
    const { graph, pipeline, deliver } = setup();
    const v1 = graph.voice(T + 5);
    const v2 = graph.voice(T + 2);
    await deliver(payload([v1, graph.image(T), v2]));
    expect(pipeline.starts[0]!.voiceNotes.map((v) => v.sentAt)).toEqual([T + 2, T + 5]);
  });
});

describe("missing pieces", () => {
  test("image only: asks for the voice note once, then starts when it arrives", async () => {
    const { graph, outbox, pipeline, deliver } = setup();
    await deliver(payload([graph.image(T)]));
    await deliver(payload([graph.image(T + 30)])); // second photo, still no voice
    expect(pipeline.starts).toHaveLength(0);
    expect(outbox.bodies()).toEqual([copy.gotPhotoNeedVoice.body]);
    await deliver(payload([graph.voice(T + 60)]));
    expect(pipeline.starts).toHaveLength(1);
    expect(pipeline.starts[0]!.photos).toHaveLength(2);
  });

  test("voice only: asks for the photo", async () => {
    const { graph, outbox, pipeline, deliver } = setup();
    await deliver(payload([graph.voice(T)]));
    expect(pipeline.starts).toHaveLength(0);
    expect(outbox.bodies()).toEqual([copy.gotVoiceNeedPhoto.body]);
  });

  test("photo with no caption plus typed prices starts without a voice note", async () => {
    const { graph, pipeline, deliver } = setup();
    await deliver(payload([graph.image(T)]), payload([text("Peak milk 600, Indomie 250", T + 5)]));
    expect(pipeline.starts).toHaveLength(1);
    expect(pipeline.starts[0]!.texts).toEqual(["Peak milk 600, Indomie 250"]);
  });

  test("caption with prices is passed through", async () => {
    const { graph, pipeline, deliver } = setup();
    await deliver(payload([graph.image(T, { caption: "  Peak 600  " })]));
    expect(pipeline.starts[0]!.texts).toEqual(["Peak 600"]);
  });

  test("a greeting on its own gets the welcome message and nothing is called", async () => {
    const { outbox, pipeline, deliver } = setup();
    await deliver(payload([text("Hello", T)]));
    expect(outbox.bodies()).toEqual([copy.welcome.body]);
    expect(pipeline.starts).toHaveLength(0);
  });

  test("photo plus a text with no prices waits for a voice note", async () => {
    const { graph, outbox, pipeline, deliver } = setup();
    await deliver(payload([graph.image(T)]), payload([text("my shop", T + 2)]));
    expect(pipeline.starts).toHaveLength(0);
    expect(outbox.bodies()).toEqual([copy.gotPhotoNeedVoice.body]);
  });
});

describe("too much", () => {
  test("two photos are both used", async () => {
    const { graph, pipeline, deliver } = setup();
    await deliver(payload([graph.image(T), graph.image(T + 1), graph.voice(T + 2)]));
    expect(pipeline.starts[0]!.photos).toHaveLength(2);
  });

  test("five photos: first three used, one warning", async () => {
    const { graph, outbox, pipeline, deliver } = setup();
    await deliver(payload([0, 1, 2, 3, 4].map((i) => graph.image(T + i)).concat([graph.voice(T + 9)])));
    expect(pipeline.starts[0]!.photos.map((p) => p.sentAt)).toEqual([T, T + 1, T + 2]);
    expect(outbox.bodies().filter((b) => b === copy.tooManyPhotos.body)).toHaveLength(1);
    expect(graph.downloads).toHaveLength(4); // 3 photos + 1 voice; extra photos are never downloaded
  });

  test("huge image is refused before download", async () => {
    const { graph, outbox, deliver } = setup();
    await deliver(payload([graph.image(T, { bytes: 6 * 1024 * 1024 })]));
    expect(graph.downloads).toHaveLength(0);
    expect(outbox.bodies()).toEqual([copy.imageTooBig.body]);
  });

  test("huge audio is refused before download", async () => {
    const { graph, outbox, deliver } = setup();
    await deliver(payload([graph.voice(T, { bytes: 15 * 1024 * 1024 })]));
    expect(graph.downloads).toHaveLength(0);
    expect(outbox.bodies()).toEqual([copy.audioTooBig.body]);
  });

  test("WhatsApp's own 'file over 100 MB' error gets the file-too-big message", async () => {
    const { outbox, deliver } = setup();
    await deliver(payload([msg("unsupported", {}, T, TRADER, { errors: [{ code: 131052, title: "Media file size too big" }] })]));
    expect(outbox.bodies()).toEqual([copy.fileTooBig.body]);
  });
});

describe("wrong kinds of input", () => {
  test("OGG that is not Opus is refused", async () => {
    const { graph, outbox, deliver } = setup();
    await deliver(payload([graph.voice(T, { mime: "audio/ogg" })]));
    expect(outbox.bodies()).toEqual([copy.unsupportedAudio.body]);
    expect(graph.infoCalls).toHaveLength(0);
  });

  test("WAV sent as a document is refused", async () => {
    const { graph, outbox, deliver } = setup();
    await deliver(payload([graph.voice(T, { mime: "audio/wav", asDocument: true })]));
    expect(outbox.bodies()).toEqual([copy.unsupportedAudio.body]);
  });

  test("forwarded MP3 audio file is accepted and marked as not a voice note", async () => {
    const { graph, pipeline, deliver } = setup();
    await deliver(payload([graph.image(T), graph.voice(T + 1, { mime: "audio/mpeg", voice: false })]));
    expect(pipeline.starts[0]!.voiceNotes[0]!.isVoiceNote).toBe(false);
  });

  test("photo sent as a document is accepted", async () => {
    const { graph, pipeline, deliver } = setup();
    await deliver(payload([graph.image(T, { asDocument: true }), graph.voice(T + 1)]));
    expect(pipeline.starts[0]!.photos).toHaveLength(1);
  });

  test("WebP or HEIC photo is refused", async () => {
    const { graph, outbox, deliver } = setup();
    await deliver(payload([graph.image(T, { mime: "image/webp" })]));
    expect(outbox.bodies()).toEqual([copy.unsupportedImage.body]);
  });

  test.each(["video", "sticker", "location", "contacts"])("%s gets the 'photos, voice notes and text only' reply", async (type) => {
    const { outbox, deliver } = setup();
    await deliver(payload([msg(type, { id: "x", mime_type: "video/mp4" }, T)]));
    expect(outbox.bodies()).toEqual([copy.unsupported.body]);
  });

  test("a reaction gets no reply", async () => {
    const { outbox, deliver } = setup();
    await deliver(payload([msg("reaction", { message_id: "wamid.OUT1", emoji: "👍" }, T)]));
    expect(outbox.sent).toHaveLength(0);
  });

  test("file whose bytes don't match WhatsApp's hash is refused", async () => {
    const { graph, outbox, deliver } = setup();
    await deliver(payload([graph.image(T, { badHash: true })]));
    expect(outbox.bodies()).toEqual([copy.downloadFailed.body]);
  });

  test("expired media URL (404) is fetched again once", async () => {
    const { graph, pipeline, deliver } = setup();
    const m = graph.image(T);
    graph.expireOnce.add((m as unknown as { image: { id: string } }).image.id);
    await deliver(payload([m, graph.voice(T + 1)]));
    expect(pipeline.starts[0]!.photos).toHaveLength(1);
    expect(graph.infoCalls.length).toBe(3); // image twice, voice once
  });

  test("media that WhatsApp no longer has gets the 'send it again' reply", async () => {
    const { outbox, deliver } = setup();
    await deliver(payload([msg("image", { id: "gone", mime_type: "image/jpeg" }, T)]));
    expect(outbox.bodies()).toEqual([copy.downloadFailed.body]);
  });
});

describe("WhatsApp delivery quirks", () => {
  test("the same webhook delivered twice is handled once", async () => {
    const { graph, outbox, pipeline, deliver } = setup();
    const body = payload([graph.image(T), graph.voice(T + 1)]);
    await deliver(body, body);
    await deliver(body);
    expect(pipeline.starts).toHaveLength(1);
    expect(outbox.bodies()).toEqual([copy.working.body, LIST_V1]);
  });

  test("a duplicate Yes tap publishes once", async () => {
    const { graph, pipeline, deliver } = setup();
    await deliver(payload([graph.image(T), graph.voice(T + 1)]));
    const yes = button("yes:1", T + 30);
    await deliver(payload([yes]), payload([yes]));
    expect(pipeline.publishes).toBe(1);
  });

  test("message from a number that is not allowed: no reply, no download, no model call", async () => {
    const { graph, outbox, pipeline, deliver } = setup({ allowed: ["2348099999999"] });
    await deliver(payload([graph.image(T), graph.voice(T + 1)]));
    expect(outbox.sent).toHaveLength(0);
    expect(graph.infoCalls).toHaveLength(0);
    expect(pipeline.starts).toHaveLength(0);
  });

  test("webhook for another phone number id is ignored", async () => {
    const { graph, outbox, deliver } = setup();
    await deliver(payload([graph.image(T)], "999"));
    expect(outbox.sent).toHaveLength(0);
  });

  test("status receipts only: nothing happens", async () => {
    const { outbox, deliver } = setup();
    const body = payload([]);
    (body.entry[0]!.changes[0]!.value as Record<string, unknown>).statuses = [{ id: "wamid.OUT1", status: "read", recipient_id: TRADER }];
    await deliver(body);
    expect(outbox.sent).toHaveLength(0);
  });
});

describe("confirm and correct", () => {
  async function atList() {
    const ctx = setup();
    await ctx.deliver(payload([ctx.graph.image(T), ctx.graph.voice(T + 1)]));
    return ctx;
  }

  test("typed correction makes a new list; the old list's Yes is refused", async () => {
    const { outbox, pipeline, deliver } = await atList();
    await deliver(payload([text("Peak milk na 650", T + 30)]));
    expect(pipeline.replies).toEqual([{ text: "Peak milk na 650" }]);
    const last = outbox.sent.at(-1)!.message;
    expect(last.type === "buttons" && last.buttons[0]!.id).toBe("yes:2");

    await deliver(payload([button("yes:1", T + 40)]));
    expect(outbox.bodies().at(-1)).toBe(copy.staleButton.body);
    expect(pipeline.publishes).toBe(0);

    await deliver(payload([button("yes:2", T + 50)]));
    expect(pipeline.publishes).toBe(1);
  });

  test("voice-note correction is passed to the pipeline as audio", async () => {
    const { graph, pipeline, deliver } = await atList();
    await deliver(payload([graph.voice(T + 30)]));
    expect(pipeline.replies).toHaveLength(1);
    expect("voiceNote" in pipeline.replies[0]!).toBe(true);
    expect(pipeline.starts).toHaveLength(1);
  });

  test("Change price button only prompts; no model call", async () => {
    const { outbox, pipeline, deliver } = await atList();
    await deliver(payload([button("change:1", T + 30)]));
    expect(outbox.bodies().at(-1)).toBe(copy.changePrompt.body);
    expect(pipeline.replies).toHaveLength(0);
  });

  test("unpriced items: first Yes shows the pricing module's warning, second Yes publishes", async () => {
    const ctx = setup();
    ctx.pipeline.unpriced = true;
    await ctx.deliver(payload([ctx.graph.image(T), ctx.graph.voice(T + 1)]));
    await ctx.deliver(payload([button("yes:1", T + 30)]));
    expect(ctx.pipeline.publishes).toBe(0);
    expect(ctx.outbox.bodies().at(-1)).toContain("Reply YES again");
    await ctx.deliver(payload([button("yes:1", T + 40)]));
    expect(ctx.pipeline.publishes).toBe(1);
  });

  test("Start again clears the list; its old buttons stop working", async () => {
    const { graph, outbox, pipeline, deliver } = await atList();
    await deliver(payload([button("restart:1", T + 30)]));
    expect(outbox.bodies().at(-1)).toBe(copy.startedAgain.body);
    await deliver(payload([button("yes:1", T + 40)]));
    expect(outbox.bodies().at(-1)).toBe(copy.staleButton.body);
    await deliver(payload([graph.image(T + 50), graph.voice(T + 51)]));
    expect(pipeline.starts).toHaveLength(2);
    expect(pipeline.starts[0]!.jobId).not.toBe(pipeline.starts[1]!.jobId);
  });

  test("new photo while a list is waiting: told once, not started", async () => {
    const { graph, outbox, pipeline, deliver } = await atList();
    await deliver(payload([graph.image(T + 30)]), payload([graph.image(T + 31)]));
    expect(outbox.bodies().filter((b) => b === copy.photoWhileChecking.body)).toHaveLength(1);
    expect(pipeline.starts).toHaveLength(1);
  });

  test("correction sent while the list is still being made is applied before any list is shown", async () => {
    const ctx = setup();
    let open!: () => void;
    ctx.pipeline.gate = new Promise((r) => (open = r));
    await ctx.deliverNoWait(payload([ctx.graph.image(T), ctx.graph.voice(T + 1)]));
    await ctx.deliverNoWait(payload([text("Indomie na 300", T + 10)]));
    open();
    await ctx.loop.idle();
    expect(ctx.pipeline.replies).toEqual([{ text: "Indomie na 300" }]);
    const lists = ctx.outbox.sent.filter((s) => s.message.type === "buttons");
    expect(lists).toHaveLength(1);
    expect(lists[0]!.message.type === "buttons" && lists[0]!.message.buttons[0]!.id).toBe("yes:2");
  });

  test("button tap while the list is being made: told to wait", async () => {
    const ctx = setup();
    let open!: () => void;
    ctx.pipeline.gate = new Promise((r) => (open = r));
    await ctx.deliverNoWait(payload([ctx.graph.image(T), ctx.graph.voice(T + 1)]));
    await ctx.deliverNoWait(payload([button("yes:1", T + 5)]));
    open();
    await ctx.loop.idle();
    expect(ctx.outbox.bodies()).toContain(copy.stillWorking.body);
    expect(ctx.pipeline.publishes).toBe(0);
  });

  test("too many corrections: stops calling the model, Yes still works", async () => {
    const { outbox, pipeline, deliver } = await atList();
    for (let i = 0; i < 10; i++) await deliver(payload([text(`change ${i}`, T + 30 + i)]));
    expect(pipeline.replies).toHaveLength(8);
    expect(outbox.bodies().filter((b) => b === copy.tooManyReplies.body)).toHaveLength(1);
    await deliver(payload([button(`yes:${pipeline.version}`, T + 100)]));
    expect(pipeline.publishes).toBe(1);
  });

  test("random button id is refused", async () => {
    const { outbox, deliver } = await atList();
    await deliver(payload([button("hack:999", T + 30)]));
    expect(outbox.bodies().at(-1)).toBe(copy.staleButton.body);
  });
});

describe("after publishing", () => {
  test("text gets help; a new photo and voice note start a new catalogue", async () => {
    const { graph, outbox, pipeline, deliver } = setup();
    await deliver(payload([graph.image(T), graph.voice(T + 1)]));
    await deliver(payload([button("yes:1", T + 30)]));
    await deliver(payload([text("thanks", T + 40)]));
    expect(outbox.bodies().at(-1)).toBe(copy.doneHelp.body);
    await deliver(payload([graph.image(T + 50), graph.voice(T + 51)]));
    expect(pipeline.starts).toHaveLength(2);
  });
});

describe("failures", () => {
  test("spend cap hit: trader is told StallSnap is paused, state resets", async () => {
    const ctx = setup();
    const err = new Error("Paid calls are off");
    err.name = "SpendCapError";
    ctx.pipeline.fail = err;
    await ctx.deliver(payload([ctx.graph.image(T), ctx.graph.voice(T + 1)]));
    expect(ctx.outbox.bodies()).toEqual([copy.working.body, copy.paused.body]);
    expect(ctx.store.get(TRADER)!.phase).toBe("idle");
  });

  test("photo the image step can't use: its trader-facing message is sent as it is", async () => {
    const ctx = setup();
    const err = new Error("This photo is too small for me to see your goods. Please take a closer photo.");
    err.name = "PhotoError";
    ctx.pipeline.fail = err;
    await ctx.deliver(payload([ctx.graph.image(T), ctx.graph.voice(T + 1)]));
    expect(ctx.outbox.bodies()).toEqual([copy.working.body, err.message]);
    expect(ctx.store.get(TRADER)!.phase).toBe("idle");
  });

  test("pipeline error: trader asked to send again", async () => {
    const ctx = setup();
    ctx.pipeline.fail = new Error("SAM timed out");
    await ctx.deliver(payload([ctx.graph.image(T), ctx.graph.voice(T + 1)]));
    expect(ctx.outbox.bodies()).toEqual([copy.working.body, copy.failed.body]);
  });

  test("publish error after Yes: trader told, nothing published", async () => {
    const ctx = setup();
    await ctx.deliver(payload([ctx.graph.image(T), ctx.graph.voice(T + 1)]));
    ctx.pipeline.fail = new Error("disk full");
    await ctx.deliver(payload([button("yes:1", T + 30)]));
    expect(ctx.outbox.bodies().at(-1)).toBe(copy.failed.body);
  });

  test("server restart mid-job: next message is handled as a fresh start, duplicates still skipped", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "stallsnap-store-")), "state.json");
    const first = setup({ store: new Store(file) });
    let open!: () => void;
    first.pipeline.gate = new Promise((r) => (open = r));
    const photo = first.graph.image(T);
    await first.deliverNoWait(payload([photo, first.graph.voice(T + 1)]));
    expect(new Store(file).get(TRADER)!.phase).toBe("working");

    const second = setup({ store: new Store(file) });
    await second.deliver(payload([photo]));
    expect(second.outbox.sent).toHaveLength(0); // already seen before the restart
    await second.deliver(payload([text("hi", T + 100)]));
    expect(second.outbox.bodies()).toEqual([copy.welcome.body]);
    open();
  });
});
