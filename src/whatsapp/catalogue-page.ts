// The public catalogue page a trader shares with customers: /c/<slug> and its pictures /c/<slug>/<n>.png.
// Rendered on the server from catalogue.json, with no script, so it opens fast on a cheap phone.
// Only the confirmed lines are on it: never the trader's number or the confirm conversation.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PublishedCatalogue } from "./adapter";

const ROUTE = /^\/c\/([a-z0-9]{12})(?:\/(\d{1,3}\.png))?\/?$/;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function priceText(price: number | null, unit: string | null): string {
  if (price === null) return "Ask for price";
  return `₦${price.toLocaleString("en-GB")}${unit ? ` per ${unit}` : ""}`;
}

export function renderPage(c: PublishedCatalogue): string {
  const date = new Date(c.publishedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lagos" });
  const items = c.lines
    .map(
      (l) => `<li>${l.image ? `<img src="/c/${c.slug}/${l.image}" alt="${esc(l.name)}" width="160" height="160" loading="lazy">` : `<div class="noimg" aria-hidden="true"></div>`}
<div><h2>${esc(l.name)}</h2><p class="price">${esc(priceText(l.price, l.unit))}</p></div></li>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Price list</title>
<meta name="robots" content="noindex">
<style>
:root { color-scheme: light dark; --bg: #fbf8f3; --fg: #1d1b18; --muted: #5c564d; --card: #ffffff; --line: #e3dccf; --accent: #0b6b3a; }
@media (prefers-color-scheme: dark) { :root { --bg: #171512; --fg: #f3efe8; --muted: #c2b9ab; --card: #221f1b; --line: #3a352e; --accent: #6fd39b; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.5rem; margin: 8px 0 4px; }
.sub { color: var(--muted); margin: 0 0 16px; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
li { display: flex; gap: 12px; align-items: center; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px; }
img, .noimg { width: 96px; height: 96px; flex: none; border-radius: 8px; object-fit: cover; background: var(--line); }
h2 { font-size: 1.05rem; margin: 0 0 4px; overflow-wrap: anywhere; }
.price { margin: 0; font-weight: 700; font-size: 1.1rem; color: var(--accent); }
footer { color: var(--muted); font-size: 0.875rem; margin: 20px 0 8px; }
</style>
</head>
<body>
<main>
<h1>Price list</h1>
<p class="sub">Prices checked by the trader on ${esc(date)}. Message the trader on WhatsApp to buy.</p>
<ul>
${items}
</ul>
<footer>Made with StallSnap catalogue builder.</footer>
</main>
</body>
</html>`;
}

/** Answers /c/... requests from publicDir; anything else, or anything malformed, is null or 404. */
export function serveCatalogue(pathname: string, publicDir: string): Response | null {
  if (!pathname.startsWith("/c/")) return null;
  const m = pathname.match(ROUTE);
  const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (!m) return notFound();
  const dir = join(publicDir, m[1]!);
  const file = join(dir, "catalogue.json");
  if (!existsSync(file)) return notFound();
  if (m[2]) {
    const img = join(dir, m[2]);
    if (!existsSync(img)) return notFound();
    return new Response(readFileSync(img), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
  }
  const c = JSON.parse(readFileSync(file, "utf8")) as PublishedCatalogue;
  return new Response(renderPage(c), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" },
  });
}
