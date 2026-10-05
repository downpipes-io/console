// FIXTURE: the no-assertion-line refusal reached through the same explicit-zero tail.
//
// The other half of the R-50 hole. verdictReached has two refusal branches and both set process.exitCode
// and return, so both were overwritten by an explicit exit 0. This drives the second one.
import { verdictReached } from "../verdict-guard.ts";
const failures = 0;
console.log("\nSILENT EXPLICIT-EXIT FIXTURE: a banner long enough to be bytes, and no assertion-shaped line");
verdictReached(failures);
process.exit(failures === 0 ? 0 : 1);
