// FIXTURE: a rejection swallowed by an empty catch, so the tally is never reached and nothing is loud.
// The guard is imported for its SIDE EFFECT only: verdictReached is never called in this shape.
import "../verdict-guard.ts";
let failures = 0;
const ok = (l: string, c: boolean): void => { console.log(`  ${c ? "ok  " : "FAIL"} ${l}`); if (!c) failures++; };
async function main(): Promise<void> {
  ok("an assertion that fails", false);
  throw new Error(`something the run needed, with ${failures} failure(s) already counted`);
}
main().catch(() => {});
