// Every setting the docs or code tell you to use must start the spend guard (QA PR #8: a renamed STALLSNAP_* setting
// the guard didn't know stopped the server at start-up). Unset values fall back to defaults, so "" is a fair probe.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./spend-guard";

const root = join(import.meta.dir, "..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f.startsWith(".")) return [];
    if (statSync(p).isDirectory()) return files(p);
    // Tests spell names wrong on purpose to prove the guard refuses them.
    return /\.(ts|md)$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : [];
  });
}

test("every STALLSNAP_ setting named in the docs and code is one the spend guard accepts", () => {
  const names = new Set<string>();
  for (const f of [join(root, "README.md"), ...["src", "image", "spike", "docs"].flatMap((d) => files(join(root, d)))]) {
    for (const m of readFileSync(f, "utf8").matchAll(/STALLSNAP_[A-Z_]+/g)) names.add(m[0]);
  }
  expect(names.size).toBeGreaterThan(0);
  for (const name of names) expect(() => loadConfig({ [name]: "" }), name).not.toThrow();
});
