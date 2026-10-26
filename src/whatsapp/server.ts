// Start the WhatsApp webhook server: bun run src/whatsapp/server.ts
// Needs the WHATSAPP_* values in .env (see docs/whatsapp.md) and a public HTTPS URL pointing at /webhook.
import { join } from "node:path";
import { Conversation } from "./conversation";
import { Graph } from "./graph";
import { Outbox } from "./outbox";
import type { Pipeline } from "./pipeline";
import { Store } from "./store";
import { makeHandler } from "./webhook";

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set; see docs/whatsapp.md`);
  return v;
}

/** Replaced by the adapter over the image pipeline and pricing modules once those branches merge. */
const notWiredYet: Pipeline = {
  start: async () => {
    throw new Error("pipeline not wired yet");
  },
  reply: async () => {
    throw new Error("pipeline not wired yet");
  },
  publish: async () => {
    throw new Error("pipeline not wired yet");
  },
};

if (import.meta.main) {
  const dataDir = process.env.WHATSAPP_DATA_DIR?.trim() || join(import.meta.dir, ".data");
  const phoneNumberId = need("WHATSAPP_PHONE_NUMBER_ID");
  const graph = new Graph({
    token: need("WHATSAPP_TOKEN"),
    phoneNumberId,
    version: process.env.WHATSAPP_GRAPH_VERSION?.trim() || "v26.0",
    baseUrl: process.env.WHATSAPP_GRAPH_BASE?.trim() || undefined,
  });
  const allowed = new Set(need("WHATSAPP_ALLOWED_NUMBERS").split(",").map((n) => n.replace(/\D/g, "")).filter(Boolean));
  const loop = new Conversation({
    graph,
    outbox: new Outbox((to, m) => graph.send(to, m)),
    pipeline: notWiredYet,
    store: new Store(join(dataDir, "state.json")),
    mediaDir: join(dataDir, "media"),
    allowed,
  });
  const handler = makeHandler(
    {
      verifyToken: need("WHATSAPP_VERIFY_TOKEN"),
      appSecret: need("WHATSAPP_APP_SECRET"),
      phoneNumberId,
      recordDir: process.env.WHATSAPP_RECORD === "on" ? join(dataDir, "recorded") : undefined,
    },
    (events) => void loop.handle(events),
  );
  const port = Number(process.env.PORT ?? 3000);
  loop.resume();
  // Meta batches up to 3 MB per POST; refuse anything much bigger before reading it.
  Bun.serve({ port, fetch: handler, maxRequestBodySize: 4 * 1024 * 1024 });
  console.log(`StallSnap WhatsApp webhook on http://localhost:${port}/webhook for ${allowed.size} allowed number(s)`);
}
