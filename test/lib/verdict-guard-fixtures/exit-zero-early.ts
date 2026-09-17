// FIXTURE: a process.exit(0) before the tally. Node honours process.exitCode assigned inside an "exit"
// listener even after an explicit exit(0), which is what lets one hook cover this shape too.
//
// The guard is imported for its SIDE EFFECT only: importing arms the exit listener, and verdictReached is
// genuinely never called in this shape, which is the whole point of the fixture.
import "../verdict-guard.ts";
let failures = 0;
const ok = (l: string, c: boolean): void => { console.log(`  ${c ? "ok  " : "FAIL"} ${l}`); if (!c) failures++; };
async function main(): Promise<void> {
  ok("an assertion that fails", false);
  console.log(`  (${failures} failure(s) counted, and the tally below is never reached)`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
