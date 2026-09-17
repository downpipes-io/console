// FIXTURE: a real failure followed by a literal process.exit(0).
//
// This shape is not on origin/main today, and that is exactly why it is here: verdictReached's
// `failures > 0` branch sets process.exitCode and nothing else, so the day somebody writes this tail the
// validator would print "2 FAILURE(S)" and "VERDICT: FAIL" into a green build. Covered by the same one
// flag as the two refusal branches rather than left to be discovered.
import { verdictReached } from "../verdict-guard.ts";
let failures = 0;
let checks = 0;
const ok = (l: string, c: boolean): void => { checks++; console.log(`  ${c ? "ok  " : "FAIL"} ${l}`); if (!c) failures++; };
ok("an assertion that holds", true);
ok("an assertion that fails", false);
ok("a second assertion that fails", false);
console.log(failures === 0 ? "\nEXIT-ZERO FIXTURE PASS" : `\n${failures} FAILURE(S)`);
verdictReached(failures, checks);
process.exit(0);
