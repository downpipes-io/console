// FIXTURE: an honest pass through the explicit-zero tail. This is the NOT-ALWAYS-RED half, and it is the
// load-bearing one: 54 enrolled entry points end this way and every one of them passes every day. A fix to
// the refusal path that turned this red would be a far worse defect than the one it repaired.
import { verdictReached } from "../verdict-guard.ts";
let failures = 0;
let checks = 0;
const ok = (l: string, c: boolean): void => { checks++; console.log(`  ${c ? "ok  " : "FAIL"} ${l}`); if (!c) failures++; };
async function main(): Promise<void> {
  ok("an assertion that holds", true);
  ok("another that holds", true);
  console.log(failures === 0 ? "\nEXPLICIT-EXIT FIXTURE PASS" : `\n${failures} FAILURE(S)`);
  verdictReached(failures, checks);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
