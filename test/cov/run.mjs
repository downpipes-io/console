// Runs every coverage test under test/cov/. Each file here is a bespoke validator in the same
// ok(label, condition) style as the test/validate-*.ts suite. Dropping a file in this directory
// registers it as a coverage test (and instruments it via c8) without any change to
// package.json's validate chain. A non-zero exit from any file fails the run.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verdictReached } from "../lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

const here = dirname(fileURLToPath(import.meta.url));
const entries = readdirSync(here, { withFileTypes: true });
const files = entries
  .filter((e) => e.isFile() && e.name.endsWith(".ts"))
  .map((e) => e.name)
  .sort();

// Dropping a file in this directory is how a coverage test gets registered, which is the whole reason
// this runner globs instead of naming files. That promise holds for this directory only: the read is
// not recursive, so a test one level down would sit there looking registered and never run, and the
// validator-reachability gate does not cover this directory because the glob is what makes it moot.
// Refuse rather than skip.
//
// THE GLOB MAKES REACHABILITY AND ENROLMENT TWO SEPARATE QUESTIONS. Being registered here is not the
// same as being able to report a failure: a file could sit in this directory without importing the
// completion guard, and scripts/verdict-guard-gate.mjs would not catch it on its own, because that gate
// derives entry points from DIRECT invocation and nothing here is invoked directly. The gate reads this
// same glob to derive the children it must require, so the two questions are answered by the one line.
const nested = entries.filter((e) => e.isDirectory() && readdirSync(join(here, e.name)).some((n) => n.endsWith(".ts")));
if (nested.length > 0) {
  console.error(`FAIL test/cov: these subdirectories hold .ts files this runner does not reach: ${nested.map((e) => e.name).join(", ")}`);
  console.error("  Move them up into test/cov/, or teach this runner to recurse. Left as they are, they never run.");
  // The verdict is DECLARED before the exit: without it the completion guard prints on top of this
  // deliberate finding, and the canonical VERDICT line a log reader greps for never appears at all.
  // The exit code is unchanged.
  verdictReached(1, 1);
  process.exit(1);
}

// Finding nothing is a failure, not a quiet pass. This directory always holds coverage tests, so an
// empty read means the layout moved or the path is wrong, and reporting success for running no tests
// is precisely the failure mode coverage testing exists to avoid.
if (files.length === 0) {
  console.error(`FAIL test/cov: no coverage tests found in ${here}. This directory is not meant to be empty.`);
  // The verdict is DECLARED before the exit: without it the completion guard prints on top of this
  // deliberate finding, and the canonical VERDICT line a log reader greps for never appears at all.
  // The exit code is unchanged.
  verdictReached(1, 1);
  process.exit(1);
}
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [join(here, f)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
// The count is passed EXPLICITLY here, unlike the validators, because these children run with
// stdio:"inherit" and write straight to the inherited descriptor: none of their output passes through this
// process's stdout, so the guard's "wrote nothing, therefore checked nothing" floor would read a full
// 25-validator run as vacuous. files.length is what this runner actually accounted for.
//
// AND WHAT files.length COUNTS IS FILES SPAWNED, NOT CHECKS RUN, which is worth saying plainly beside the
// call rather than leaving a reader to infer it. Arming this runner does not make its children safe: the
// loop above reads only `r.status`, so a child can drain its event loop and exit 0 after printing FAIL to
// its own stdout, which this runner never inspects, and still get counted as a pass. A runner that reads
// only the child's exit code inherits the child's blind spot, so the guard has to live in the child as
// well, and every file in this directory imports it. scripts/verdict-guard-gate.mjs derives that
// requirement from this file's own glob, so a file dropped in here either imports the guard or the gate
// flags it.
verdictReached(failed, files.length); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
process.exit(failed === 0 ? 0 : 1);
