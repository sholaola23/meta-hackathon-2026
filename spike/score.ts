// Prints the day-one scores from the committed result files. Makes no API calls.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib";

const DIR = join(ROOT, "test-results/day1");

const sam = JSON.parse(readFileSync(join(DIR, "sam-scores.json"), "utf8"));
const hit = (v: unknown) => v !== null && v !== "not checked";
const totals: Record<string, { v1: number; union: number; n: number }> = {};
console.log("SAM 3.1: sellable items with a separate usable crop");
for (const p of sam.photos) {
  const lots = Object.values(p.lots) as { v1: unknown; v2: unknown }[];
  const v1 = lots.filter((l) => hit(l.v1)).length;
  const union = lots.filter((l) => hit(l.v1) || hit(l.v2)).length;
  console.log(`  ${p.photo.padEnd(34)} v1 ${v1}/${lots.length}   v1+v2 ${union}/${lots.length}`);
  const t = (totals[p.kind] ??= { v1: 0, union: 0, n: 0 });
  t.v1 += v1; t.union += union; t.n += lots.length;
}
for (const [kind, t] of Object.entries(totals))
  console.log(`  ${kind}: v1 ${t.v1}/${t.n} = ${Math.round((100 * t.v1) / t.n)}%, v1+v2 ${t.union}/${t.n} = ${Math.round((100 * t.union) / t.n)}%  (threshold 70%)`);

const voice = JSON.parse(readFileSync(join(DIR, "voice-results.json"), "utf8"));
console.log("\nVoice: prices landing on the right item");
const byVariant: Record<string, { ok: number; n: number }> = {};
for (const r of voice) {
  const ok = r.score.rows.filter((x: any) => x.ok).length;
  const flagged = r.score.unpriced.filter((u: any) => u.flagged && !u.wronglyPriced).length;
  console.log(`  ${r.stall.padEnd(28)} ${r.variant.padEnd(9)} ${ok}/${r.score.rows.length}  unpriced flagged ${flagged}/${r.score.unpriced.length}  stray prices ${r.score.extra.length}`);
  const t = (byVariant[r.variant] ??= { ok: 0, n: 0 });
  t.ok += ok; t.n += r.score.rows.length;
}
for (const [v, t] of Object.entries(byVariant)) console.log(`  ${v}: ${t.ok}/${t.n} = ${Math.round((100 * t.ok) / t.n)}%  (threshold 80%)`);
