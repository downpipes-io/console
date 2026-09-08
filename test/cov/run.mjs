// Runs every coverage test under test/cov/. Each file here is a bespoke validator in the same
// ok(label, condition) style as the test/validate-*.ts suite, so per-module coverage tests are
// registered (and instrumented by c8) without editing package.json's validate chain directly.
// A non-zero exit from any file fails the run.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
// THE GLOB MADE REACHABILITY MOOT AND ENROLMENT INVISIBLE, and those are different questions. Being
// registered here is not the same as being able to report a failure: for as long as this directory has
// existed, none of its files imported the completion guard, and none was derived by
// scripts/verdict-guard-gate.mjs either, because that gate derives entry points from DIRECT invocation
// and nothing here is invoked directly. The convenience that made registration free made enrolment
// unobservable. The gate now reads this same glob to derive the children it must require, so the two
// questions are answered by the one line.
const nested = entries.filter((e) => e.isDirectory() && readdirSync(join(here, e.name)).some((n) => n.endsWith(".ts")));
if (nested.length > 0) {
  console.error(`FAIL test/cov: these subdirectories hold .ts files this runner does not reach: ${nested.map((e) => e.name).join(", ")}`);
  console.error("  Move them up into test/cov/, or teach this runner to recurse. Left as they are, they never run.");
  // The verdict is DECLARED before the exit: without it the completion guard prints on top of this
  // deliberate finding, and the canonical VERDICT line a log reader greps for never appears at all.
  // The exit code is unchanged.
  process.exitCode = 1;
  process.exit(1);
}

// Finding nothing is a failure, not a quiet pass. This directory has always had coverage tests in it,
// so an empty read means the layout moved or the path is wrong, and reporting success for
// running no tests is precisely the shape of the bug the whole coverage campaign exists to avoid.
if (files.length === 0) {
  console.error(`FAIL test/cov: no coverage tests found in ${here}. This directory is not meant to be empty.`);
  // The verdict is DECLARED before the exit: without it the completion guard prints on top of this
  // deliberate finding, and the canonical VERDICT line a log reader greps for never appears at all.
  // The exit code is unchanged.
  process.exitCode = 1;
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
// call rather than leaving a reader to infer it. Arming this runner never made its children safe: the loop
// above reads only `r.status`, so a child that drained its event loop and left with code 0 was counted as
// a PASS and this line then declared `checks=25` over it. A child that prints FAIL but exits 0 (for example one with a never-settling
// await after the assertion) would otherwise be counted as a pass by this runner. A runner that reads only the child's exit code
// inherits the child's blind spot, so the guard has to live in the child as well, and every file in this
// directory now imports it. scripts/verdict-guard-gate.mjs DERIVES that requirement from this file's own
// glob, so a file dropped in here is enrolled or is a gate finding.
if (failed > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
process.exit(failed === 0 ? 0 : 1);
