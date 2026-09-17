// Validates the shared completion guard ITSELF (test/lib/verdict-guard.ts) against the class it exists to
// close: a validator reaching exit 0 without ever reaching its own tally.
//
// A guard nobody tests is a guard that can quietly stop guarding, and this one is load-bearing for 141
// console entry points, so each shape is driven as a REAL child process and the child's EXIT CODE is read,
// not inferred. The fixtures live in test/lib/verdict-guard-fixtures/ and are the shapes this repo actually
// has:
//   drain                 an await that never settles behind a floating main().catch(...) tail, which is the
//                         tail 45 of this repo's validators carry and which catches none of it
//   drain-mjs             the same, from the one derived entry point that is not TypeScript (test/cov/run.mjs)
//   exit-zero-early       process.exit(0) before the tally
//   early-return          a return before the tally
//   swallowed-rejection   a rejection eaten by an empty .catch()
//   export-only           a file that only exports its work, so run as a chain step it checks nothing
//   vacuous               a verdict declared over zero checks
//   pass / fail           the two honest outcomes, so the guard is proven NOT to be always-red
//   skipped               a declared skip, which must stay exit 0 and must not trip the guard
//   skipped-required-exit-zero   a MANDATORY precondition absent (verdictSkipped(reason, {require:true})),
//                         then the trailing explicit process.exit(0) the four require-capable skip sites in
//                         this repo actually carry. Proves the refusal-survives-a-trailing-exit mechanism
//                         (R-50) also covers the verdictSkipped path, which nothing exercised.
//
// Run: node test/validate-verdict-guard.ts

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verdictReached } from "./lib/verdict-guard.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "lib", "verdict-guard-fixtures");

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

interface Run {
  code: number | null;
  out: string;
  err: string;
}
function run(fixture: string): Run {
  const r = spawnSync(process.execPath, [join(FIX, fixture)], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

console.log("verdict-guard self-test: every way a validator can skip its own tally");

// ---- the shapes that must become exit 1 --------------------------------------------------------------
for (const [fixture, what] of [
  ["drain.ts", "an await that never settles"],
  ["drain-mjs.mjs", "an await that never settles, from a .mjs entry point"],
  ["exit-zero-early.ts", "a process.exit(0) before the tally"],
  ["early-return.ts", "an early return before the tally"],
  ["swallowed-rejection.ts", "a rejection swallowed by an empty catch"],
  ["export-only.ts", "a file that only exports its work"],
] as const) {
  const r = run(fixture);
  ok(`${what}: exits 1, not 0`, r.code === 1);
  ok(`${what}: says why on stderr`, r.err.includes("VERDICT GUARD"));
  ok(`${what}: names the entry point it fired for`, r.err.includes(fixture));
}

// The drain fixture must ALSO be shown to print a real FAIL and still have exited 0 without the guard,
// otherwise the test above proves only that the guard is loud, not that it caught anything real.
{
  const r = run("drain.ts");
  ok("drain: the run really did print FAIL assertions", /^\s*FAIL /m.test(r.out));
  ok("drain: its own verdict line is genuinely absent", !r.out.includes("DRAIN FIXTURE PASS"));
  ok("drain: the guard reports how far it got", /printed \d+ assertion-shaped line\(s\) and \d+ bytes/.test(r.err));
  // The floating tail is the thing the drain shape defeats, so assert the fixture really carries one and
  // that the tail printed nothing. A fixture without the tail would prove the wrong thing.
  const fixtureSrc = readFileSync(join(FIX, "drain.ts"), "utf8");
  ok("drain: the fixture carries the floating main().catch(...) tail this repo uses", /main\(\)\.catch\(/.test(fixtureSrc));
  ok("drain: the tail caught nothing, because a promise that never settles never rejects", !r.err.includes("Error:"));
}

// WHAT THE GUARD MAY CLAIM about a run it fired on, which is a property of the guard's own honesty rather
// than of any fixture. The undeclared block used to print "every assertion in this run was incapable of
// failing" unconditionally, three lines above "It printed N assertion-shaped line(s) ... before stopping",
// so any run that stopped after an assertion carried both. The second half of that sentence is true only
// when nothing ran, and it is now printed only then. Both directions are asserted here, on the same run,
// because a check that only proves the sentence is gone would pass equally if it had been deleted outright.
{
  // Assertions DID run: the strong claim must be absent and the honest one present.
  const withWork = run("drain.ts");
  ok("a run that stopped after assertions is not told they were incapable of failing", !withWork.err.includes("incapable of failing"));
  ok("and it is told instead that what it checked was never totalled", withWork.err.includes("never totalled"));
  ok("while it still reports how far it got", /printed \d+ assertion-shaped line\(s\) and \d+ bytes/.test(withWork.err));
  ok("and the exit code is untouched by the wording", withWork.code === 1);

  // Nothing ran: the strong claim is TRUE here and must survive, or the narrowing has simply deleted it.
  const withNone = run("export-only.ts");
  ok("a run that printed no assertion at all IS told every assertion was incapable of failing", withNone.err.includes("incapable of failing"));
  ok("and is told it ran no checks", withNone.err.includes("no assertion-shaped line at all"));
  ok("the two branches really are different text", withNone.err.includes("incapable of failing") !== withWork.err.includes("incapable of failing"));
}

// The .mjs route matters on its own: Node resolves the .ts guard specifier from a plain ESM importer under
// its own type stripping, and CI pins Node 22 while this box defaults to 25, so the version gap is where a
// bug of exactly this kind would hide.
{
  const r = run("drain-mjs.mjs");
  ok("drain-mjs: a .mjs entry point really did load the .ts guard", r.err.includes("VERDICT GUARD"));
  ok("drain-mjs: it printed its failing assertion before draining", /^\s*FAIL /m.test(r.out));
}

// ---- nothing to check is not a pass ------------------------------------------------------------------
{
  const r = run("vacuous.ts");
  ok("a verdict declared over zero checks exits 1", r.code === 1);
  ok("a verdict declared over zero checks says so", r.err.includes("Nothing was checked"));
}

// The non-vacuity floor is a count of ASSERTION-SHAPED LINES, not of bytes. Bytes were too weak: two
// validators here print nothing but a banner on a pass and write their FAIL lines only on failure, so on
// bytes a run that asserted a thousand things and one that asserted none were indistinguishable.
{
  const r = run("silent-pass.ts");
  ok("a verdict declared with no assertion-shaped line anywhere exits 1", r.code === 1);
  ok("and the guard says the bytes were not evidence", r.err.includes("no assertion-shaped line on either stream"));
  ok("the fixture really did write a non-trivial number of bytes", r.out.length > 40);
}
{
  const r = run("silent-pass-counted.ts");
  ok("the same silence with a declared check count stays exit 0", r.code === 0);
  ok("and draws no guard message", !r.err.includes("VERDICT GUARD:"));
  ok("and the declared count reaches the canonical line", r.out.includes("VERDICT: PASS failures=0 checks=7"));
}

// The floor reads BOTH streams, because several validators here print FAIL to stderr and only a banner to
// stdout. Counting one stream would have missed them.
{
  const r = run("swallowed-rejection.ts");
  ok("an assertion printed to stdout is counted", /^\s*FAIL /m.test(r.out));
}

// ---- the guard must NOT be always-red ---------------------------------------------------------------
{
  const r = run("pass.ts");
  ok("an honest pass still exits 0", r.code === 0);
  ok("an honest pass draws no guard message at all", !r.err.includes("VERDICT GUARD"));
  ok("an honest pass prints its own verdict", r.out.includes("PASS FIXTURE PASS"));
  // The log-reading half of a verification needs a fixed anchor too: reading only the exit code misses a
  // failing run whose log was grepped with a pattern the local grep does not support, and in this repo the
  // string "not ok" appears inside PASSING assertion labels.
  ok("an honest pass prints the guard's canonical verdict line", r.out.includes("VERDICT: PASS"));
  ok("the canonical line carries the counts", /VERDICT: PASS failures=0 checks=2/.test(r.out));
}
{
  const r = run("fail.ts");
  ok("an honest failure exits 1 by its own route", r.code === 1);
  ok("an honest failure draws no guard message", !r.err.includes("VERDICT GUARD"));
  ok("an honest failure prints its own tally", r.out.includes("1 FAILURE(S)"));
  ok("a failing run is greppable as a FIXED string, not a regex", r.out.includes("VERDICT: FAIL"));
}

// ---- a declared skip stays a skip -------------------------------------------------------------------
{
  const r = run("skipped.ts");
  ok("a declared skip stays exit 0", r.code === 0);
  ok("a declared skip is greppable on one line", r.out.includes("VERDICT SKIPPED:"));
  ok("a declared skip does not trip the guard", !r.err.includes("VERDICT GUARD"));
}

// ---- a refusal must survive the caller's own exit code (R-50) ----------------------------
// Everything above this block reaches the guard through a tail of `if (failures > 0) process.exit(1)`,
// which leaves an exitCode the guard set alone. 54 of the 157 enrolled entry points on origin/main
// 4b74ce8 instead end `process.exit(failures === 0 ? 0 : 1)`, and on a clean run that is an EXPLICIT 0
// that overwrites process.exitCode. So every refusal above was proven on the shape that never had the
// problem. These fixtures are the same refusals reached through the shape that did.
{
  const r = run("vacuous-explicit-exit.ts");
  ok("a zero-check verdict followed by an explicit exit 0 still exits 1", r.code === 1);
  ok("and the original refusal is still printed", r.err.includes("Nothing was checked"));
  ok("and the overwrite is named rather than silently corrected", r.err.includes("exited 0 after this guard had refused the run"));
}
{
  const r = run("silent-pass-explicit-exit.ts");
  ok("the no-assertion refusal survives an explicit exit 0 too", r.code === 1);
  ok("and says which refusal it was", r.err.includes("no assertion-shaped line on either stream"));
}
{
  const r = run("fail-exit-zero.ts");
  ok("a real failure followed by a literal process.exit(0) exits 1", r.code === 1);
  ok("and the tally that was overwritten is in the log", r.out.includes("2 FAILURE(S)"));
  ok("and the canonical line agrees with the exit code", r.out.includes("VERDICT: FAIL"));
}
{
  // The half that would be worse to get wrong. Every one of those 54 entry points passes daily.
  const r = run("pass-explicit-exit.ts");
  ok("an honest pass through the explicit-zero tail still exits 0", r.code === 0);
  ok("and draws no guard message at all", !r.err.includes("VERDICT GUARD"));
  ok("and still prints its canonical line", r.out.includes("VERDICT: PASS failures=0 checks=2"));
}
{
  // verdictSkipped's require:true path sets `refused` the same way the three shapes above do, but nothing
  // drove it through a trailing explicit exit before this fixture: the four require-capable skip sites in
  // this repo (validate-engine-field-coverage, validate-source-type-parity, validate-cf-surface-split-parity,
  // validate-visible-surface-counts) all currently run with the precondition present, so the refusal branch
  // has not fired at all yet, and only the shape above it (mandatory absent, no trailing exit) was proven.
  const r = run("skipped-required-exit-zero.ts");
  ok("a mandatory-skip refusal survives a trailing explicit exit 0 too", r.code === 1);
  ok("and the skip is still declared before the refusal fires", r.out.includes("VERDICT SKIPPED:"));
  ok("and the overwrite is named rather than silently corrected", r.err.includes("exited 0 after this guard had refused the run"));
}

// ---- the guard's own teeth, read from its source ----------------------------------------------------
// If someone removes the exit listener or the forced exit code, every check above would still pass for the
// wrong reason on some future refactor, so assert the mechanism is present as well as effective.
{
  const src = readFileSync(join(HERE, "lib", "verdict-guard.ts"), "utf8");
  ok("the guard installs an exit listener", /process\.on\(\s*"exit"/.test(src));
  ok("the guard forces a non-zero exit code", /process\.exitCode\s*=\s*1/.test(src));
  ok("the guard writes its message to stderr, not the stream it counts", /process\.stderr\.write/.test(src));
  ok("the guard exports verdictSkipped, so a skip can be declared rather than silent", /export function verdictSkipped/.test(src));
  // Read the mechanism as well as its effect: the refusal must be re-applied from inside the exit
  // listener, because that is the only point downstream of every route out of the process.
  ok("the guard records a refusal separately from a declared verdict", /let refused = false/.test(src));
  ok("and re-applies it from inside the exit listener", /if \(refused\)/.test(src));
}

console.log(failures === 0 ? `\nVERDICT GUARD SELF-TEST PASS (${checks} checks)` : `\n${failures} FAILURE(S)`);
verdictReached(failures, checks);
if (failures > 0) process.exit(1);
