// QA attacks on PR #11 (round 1, head 6b82b7a): the stall name on the catalogue page. Copy to src/whatsapp/.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderPage } from "./catalogue-page";

const page = (stallName?: string) => renderPage({ slug: "qa0000000001", stallName, publishedAt: "2026-10-28T09:30:00Z", lines: [] });

test("a long name with no spaces wraps instead of pushing the page sideways", () => {
  // Checked in a browser: a 60-character single word made the page 840px wide at 320 to 390px.
  expect(page("MamaBisiProvisionsAndGeneralMerchandiseOyingboMarketLagos1234")).toMatch(/h1\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

test("trimming the setting to 60 characters never cuts an emoji in half", () => {
  const server = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
  const m = server.match(/stallName:\s*(.+),\n/)![1]!;
  const CATALOGUE_STALL_NAME = "x".repeat(59) + "🍅 Stall";
  const name = new Function("process", `return ${m}`)({ env: { CATALOGUE_STALL_NAME } }) as string;
  expect(/[\uD800-\uDBFF]$/.test(name)).toBe(false);
});

test("HTML in the name is escaped in the title and heading", () => {
  const html = page('<script>alert(1)</script> "Iya Lola"');
  expect(html).not.toContain("<script>");
  expect(html).toContain("<title>&lt;script&gt;alert(1)&lt;/script&gt; &quot;Iya Lola&quot;: price list</title>");
});

test("no name: 'Price list', no phone number or contact link", () => {
  const html = page(undefined);
  expect(html).toContain("<h1>Price list</h1>");
  expect(html).not.toMatch(/tel:|wa\.me|\+?234\d{6,}/);
});
