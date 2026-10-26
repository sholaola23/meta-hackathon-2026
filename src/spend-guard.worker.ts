// Test helper for spend-guard.test.ts: one process that waits for a shared start time, then tries one paid call.
// Prints 1 if the call ran, 0 if a cap stopped it.
import { SpendGuard, loadConfig } from "./spend-guard";

const [dir, startAt, cap] = process.argv.slice(2);
const guard = new SpendGuard(loadConfig({ STALLSNAP_DAILY_CAP_USD: cap, STALLSNAP_SPEND_DIR: dir }));
while (Date.now() < Number(startAt)) {}
let ran = 0;
try {
  await guard.paid("job", "muse-image-1.0", 0.01, async () => {
    ran = 1;
  });
} catch (e) {
  if (!(e as { reason?: string }).reason) throw e;
}
console.log(ran);
