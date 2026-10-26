// QA round 3 attack on PR #9: hole filling must not make a busy real photo much slower.
// real-01 (sandals wall) gave 172 SAM instances on day one; main filters this synthetic stand-in in about 4s.
import { expect, test } from "bun:test";
import { filterCandidates } from "../mask";
import { cand, ellipse } from "./helpers";

test("C1 172 candidates on a 2000x1500 photo filter in under 10s", () => {
  let s = 7;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const cs = Array.from({ length: 172 }, (_, i) => {
    const w = 60 + Math.floor(r() * 340), h = 60 + Math.floor(r() * 340);
    return cand(ellipse(Math.floor(r() * (2000 - w)), Math.floor(r() * (1500 - h)), w, h, 0.5 + r() * 0.5), i % 10, "p" + (i % 6));
  });
  const t = performance.now();
  const out = filterCandidates(cs, [ellipse(800, 200, 500, 1300)], 2000 * 1500);
  expect(out.kept.length).toBeGreaterThan(0);
  expect(performance.now() - t).toBeLessThan(10_000);
}, 120_000);
