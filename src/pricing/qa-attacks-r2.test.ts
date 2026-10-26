// QA round 2 attacks on PR #3. Failed on 3d1dfe4.
import { describe, expect, test } from "bun:test";
import { handleReply, startConfirmation } from "./confirm";
import { parsePrice } from "./price";

describe("R2-B1: Pidgin 'oo' glued to a number is not two zeros", () => {
  for (const s of ["1800oo", "500oo", "1000OO", "1800ooo", "50oo"]) test(s, () => expect(parsePrice(s).ok).toBe(false));
  test("3 na 1800oo changes nothing", () => {
    const draft: any = { rejected: [], lines: [
      { item: { id: "i1", name: "Milo tin" }, status: "priced", price: 3500, unit: "tin", quote: "", replaced: [] },
      { item: { id: "i3", name: "Peak milk tin (big)" }, status: "priced", price: 1800, unit: "tin", quote: "", replaced: [] },
    ] };
    const { session } = startConfirmation(draft);
    const r = handleReply(session, "2 na 1800oo");
    expect(r.session.lines[1]!.price).toBe(1800);
    expect(r.notUnderstood.length).toBe(1);
  });
});
