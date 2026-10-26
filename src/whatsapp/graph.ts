// Thin client for the WhatsApp Cloud API (Graph API). fetch is injected so tests never touch the network.
// Endpoints: developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media
// and .../messages/text-messages, .../messages/interactive-reply-buttons-messages (read 26 Oct 2026).

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface GraphConfig {
  token: string;
  phoneNumberId: string;
  /** Graph API version, for example "v26.0". */
  version: string;
  /** Only for local smoke tests against a mock; defaults to https://graph.facebook.com. */
  baseUrl?: string;
}

export interface MediaInfo {
  url: string;
  mimeType: string;
  sha256?: string;
  bytes: number;
}

export interface Button {
  id: string;
  /** Max 20 characters. */
  title: string;
}

export type Outgoing =
  | { type: "text"; body: string }
  /** Reply buttons; headerImageUrl must be a public HTTPS image (for example a product cut-out). */
  | { type: "buttons"; body: string; buttons: Button[]; headerImageUrl?: string }
  /** A call-to-action URL button (label max 20 characters). */
  | { type: "link"; body: string; label: string; url: string }
  /** Marks the trader's message as read and shows "typing..." for up to 25 s. Not a message: body is empty. */
  | { type: "typing"; body: ""; messageId: string };

export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

/** Meta's error text can quote the access token (code 190), and these messages are logged. */
export function redact(message: string, token: string): string {
  const cut = token ? message.split(token).join("[token]") : message;
  return cut.replace(/EAA[A-Za-z0-9_-]{6,}/g, "[token]");
}

async function fail(res: Response, what: string, token: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: number; message?: string } };
  const detail = redact(String(body.error?.message ?? ""), token);
  throw new GraphError(res.status, body.error?.code, `${what}: HTTP ${res.status} ${detail}`.trim());
}

export class Graph {
  constructor(
    private readonly config: GraphConfig,
    private readonly fetch: Fetch = globalThis.fetch,
  ) {}

  private get base() {
    return `${this.config.baseUrl ?? "https://graph.facebook.com"}/${this.config.version}`;
  }

  private auth(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.config.token}`, ...extra };
  }

  /** Step 1 of a media download: the media id gives a URL that is valid for 5 minutes. */
  async mediaInfo(mediaId: string): Promise<MediaInfo> {
    const url = `${this.base}/${encodeURIComponent(mediaId)}?phone_number_id=${encodeURIComponent(this.config.phoneNumberId)}`;
    const res = await this.fetch(url, { headers: this.auth() });
    if (!res.ok) await fail(res, "media info", this.config.token);
    const body = (await res.json()) as { url?: string; mime_type?: string; sha256?: string; file_size?: string | number };
    if (!body.url || !body.mime_type) throw new GraphError(res.status, undefined, "media info: no url in response");
    return { url: body.url, mimeType: body.mime_type, sha256: body.sha256, bytes: Number(body.file_size ?? 0) };
  }

  /** Step 2: download the bytes. The token is required on this request too. Refuses anything over maxBytes. */
  async download(url: string, maxBytes: number): Promise<Uint8Array> {
    const res = await this.fetch(url, { headers: this.auth() });
    if (!res.ok) await fail(res, "media download", this.config.token);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new GraphError(413, undefined, `media download: ${declared} bytes is over ${maxBytes}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new GraphError(413, undefined, `media download: ${bytes.byteLength} bytes is over ${maxBytes}`);
    return bytes;
  }

  /** Send one message. Returns the WhatsApp message id, which button replies point back to. */
  async send(to: string, message: Outgoing): Promise<string> {
    const body = JSON.stringify(
      message.type === "typing"
        ? // .../typing-indicators (read 26 Oct 2026)
          { messaging_product: "whatsapp", status: "read", message_id: message.messageId, typing_indicator: { type: "text" } }
        : { messaging_product: "whatsapp", recipient_type: "individual", to, ...payloadFor(message) },
    );
    const res = await this.fetch(`${this.base}/${this.config.phoneNumberId}/messages`, {
      method: "POST",
      headers: this.auth({ "Content-Type": "application/json" }),
      body,
    });
    if (!res.ok) await fail(res, "send", this.config.token);
    const reply = (await res.json()) as { messages?: { id?: string }[] };
    return reply.messages?.[0]?.id ?? "";
  }
}

function payloadFor(message: Exclude<Outgoing, { type: "typing" }>) {
  switch (message.type) {
    case "text":
      return { type: "text", text: { preview_url: true, body: message.body } };
    case "buttons":
      return {
        type: "interactive",
        interactive: {
          type: "button",
          ...(message.headerImageUrl ? { header: { type: "image", image: { link: message.headerImageUrl } } } : {}),
          body: { text: message.body },
          action: { buttons: message.buttons.map((b) => ({ type: "reply", reply: b })) },
        },
      };
    case "link":
      // .../messages/interactive-cta-url-messages (read 26 Oct 2026)
      return {
        type: "interactive",
        interactive: {
          type: "cta_url",
          body: { text: message.body },
          action: { name: "cta_url", parameters: { display_text: message.label, url: message.url } },
        },
      };
  }
}
