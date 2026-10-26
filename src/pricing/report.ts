// Scores every recorded model run and prints one table. `bun src/pricing/report.ts` makes no API calls.
import { applyToolCalls } from "./draft";
import { loadAnswerKey, loadMessyTranscripts, loadRecordings, loadStalls, type Recording } from "./fixtures";
import { scoreDraft, simulateTrader, type KeyStall, type Score, type TraderRun } from "./score";

export interface RecordingResult {
  file: string;
  rec: Recording;
  score: Score;
  trader: TraderRun;
}

export function keyFor(rec: Recording): KeyStall {
  const k = loadAnswerKey().find((s) => s.id === rec.case) ?? loadMessyTranscripts().find((c) => c.id === rec.case);
  if (!k) throw new Error(`no answer key for case ${rec.case}`);
  return k;
}

export function scoreRecordings(): RecordingResult[] {
  const stalls = loadStalls();
  return loadRecordings().map(({ file, rec }) => {
    const stall = stalls.find((s) => s.id === rec.stall);
    if (!stall) throw new Error(`${file}: unknown stall ${rec.stall}`);
    const draft = applyToolCalls(stall.items, rec.tool_calls);
    return { file, rec, score: scoreDraft(draft, keyFor(rec), rec.units_recorded), trader: simulateTrader(draft, stall.truth) };
  });
}

export function formatReport(results: RecordingResult[]): string {
  const rows = results.map(({ file, score: s, trader }) => [
    file.replace(/\.json$/, ""),
    `${Math.round(s.matchRate * s.priced)}/${s.priced}`,
    s.unitsRecorded ? `${s.correct}/${s.priced}` : "n/a",
    String(s.wrongPrice.length),
    s.unitsRecorded ? String(s.wrongUnit.length) : "n/a",
    String(s.missing.length),
    `${s.unpricedFlagged.length}/${s.unpriced}`,
    String(s.invented.length),
    String(s.rejectedCalls),
    String(trader.replies.length),
    String(trader.publishedWrong.length),
  ]);
  const head = ["run", "right price", "right price+unit", "wrong price", "wrong unit", "missing", "unpriced flagged", "invented", "rejected calls", "trader replies", "published wrong"];
  const sum = (f: (r: RecordingResult) => number) => results.reduce((a, r) => a + f(r), 0);
  const priced = sum((r) => r.score.priced);
  const right = sum((r) => Math.round(r.score.matchRate * r.score.priced));
  const lines = [head, ...rows].map((r) => `| ${r.join(" | ")} |`);
  lines.splice(1, 0, `|${head.map(() => "---").join("|")}|`);
  lines.push(
    "",
    `Total: ${right}/${priced} right prices (${((100 * right) / priced).toFixed(0)}%), ` +
      `${sum((r) => r.score.wrongPrice.length)} wrong prices before confirmation, ` +
      `${sum((r) => r.score.wrongUnit.length)} wrong units (runs with units only), ` +
      `${sum((r) => r.score.missing.length)} missing, ${sum((r) => r.score.invented.length)} invented, ` +
      `${sum((r) => r.trader.publishedWrong.length)} wrong lines published after the trader's confirmation.`,
  );
  for (const r of results) {
    for (const w of r.score.wrongPrice) lines.push(`- ${r.file}: wrong price ${w.item}: ${w.got}, should be ${w.want}`);
    for (const w of r.score.wrongUnit) lines.push(`- ${r.file}: wrong unit ${w.item}: ${w.got}, should be ${w.want}`);
    for (const m of r.score.missing) lines.push(`- ${r.file}: missing ${m}`);
    for (const i of r.score.invented) lines.push(`- ${r.file}: INVENTED ${i.item}: ${i.got}`);
  }
  return lines.join("\n");
}

if (import.meta.main) console.log(formatReport(scoreRecordings()));
