// FIXTURE: nothing to check, in the tail 54 of the 157 enrolled entry points actually use.
//
// It is vacuous.ts with one difference: it ends `process.exit(failures === 0 ? 0 : 1)` rather than
// `if (failures > 0) process.exit(1)`. On a clean run that passes an EXPLICIT 0, which overwrites the
// process.exitCode the guard sets when it refuses. Before R-50's fix this printed the whole
// "Nothing was checked ... Forcing exit 1" refusal and exited 0.
import { verdictReached } from "../verdict-guard.ts";
const failures = 0;
console.log("vacuous fixture: ran no checks, and exits explicitly");
verdictReached(failures, 0);
process.exit(failures === 0 ? 0 : 1);
