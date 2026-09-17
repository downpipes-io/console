#!/usr/bin/env node
// verdict-guard-gate: every validator entry point must be enrolled in the shared completion guard.
//
// WHY THIS GATE EXISTS. test/lib/verdict-guard.ts closes the class where a validator reaches exit 0
// without ever reaching its own tally, so the run is incapable of reporting a failure however many
// assertions it got through. The assertions and the run are not the same thing, and see that file's
// header for why the difference is worth the extra clause. A guard that
// only some validators opt into is the same defect wearing a helmet, so the requirement is not a list kept
// by hand here: it is DERIVED from what the repo actually runs.
//
// THE DERIVATION, in order:
//   1. Entry points: every script path invoked as a process by a package.json script (transitively through
//      `npm run X` and through any `sh scripts/*.sh` it calls, which is how the deploy chain reaches the
//      whole of `npm run lint`) or by a step in .github/workflows/*.yml. YAML comments are stripped first,
//      because a path mentioned in CI PROSE is not an invocation and counting it invents entry points.
//   2. Direct invocations only: `node <path>` or `[npx] tsx <path>`. A file handed to vitest, c8 or stryker
//      is run by a framework that reports its own verdict, so the guard does not apply to it.
//   3. Required: an entry point under test/ that is a validator, decided by SHAPE, not by name alone: its
//      basename starts with `validate-`, OR it prints assertion-shaped lines, OR it has a tally that
//      decides the exit code. test/cov/run.mjs qualifies on the third test and is required, which is
//      right: it spawns the coverage validators and counts `r.status !== 0` as a failure, so a silent
//      exit 0 of its own would be a false green over all of them.
//   4. Also required: every child a required entry point SPAWNS over a directory glob, and every
//      directly-invoked entry point OUTSIDE test/ that floats an async call at its top level. Both are
//      derived, not listed. See the two functions below for why each exists.
// Then: every required entry point must import the guard and call verdictReached(), and must have some
// failure path at all.
//
// LEG 3 ALONE, SCOPED TO IMPORTERS OF THE GUARD, CANNOT SEE LEG 4's CLASSES. Counting floating catch tails
// only in files that already import the guard misses every floating tail in a file that imports no guard at
// all, including the child files a glob spawner runs and a scripts/ gate whose async main was never
// awaited. "Zero remaining" measured over importers is not the same claim as "zero remaining" over the
// repository, so leg 4 derives its two classes by scanning the whole tree rather than by counting within
// the importer set.
//
// WHAT IS DELIBERATELY NOT REQUIRED, AND ON WHAT CONDITION. The gate scripts under scripts/ are derived
// as directly-invoked but are not under test/, so this gate does not require them, matching the rule the
// sibling engine repo enforces. The exemption rests on their being straight-line synchronous scanners
// that reach their own bottom line; the exposure they carry instead is that nothing type-checks them,
// closed separately by tsconfig.scripts.json and typecheck-coverage-gate.mjs. That condition cannot be
// enforced by a comment telling a reader to move any scripts/ gate that grows an await into the
// requirement, because nothing reads a comment: a gate can grow an async main(), float it, and stay exempt
// under a rule stated only in prose. Leg 4 derives the condition instead of stating it.
//
// FAILS WHEN IT CANNOT RUN, and FAILS WHEN THERE IS NOTHING TO CHECK: exit 2 if package.json or the guard
// module is unreadable, if the guard module has lost its exit hook, if a spawner's child set cannot be
// enumerated from its own source, if the three classes do not reconcile against the graded total, if
// nothing was graded at all, or if the leg that derives any CLASS found no subject to read. A gate that
// silently checks nothing is the same bug it is here to catch.
//
// EXIT 2 IS FOR COULD-NOT-CHECK, NOT FOR COULD-CHECK-BUT-THIS-IS-NOT-THE-QUESTION, and the difference is
// worked through at POPULATION_BASELINE below. A class that merely disagrees with its pin, in either
// direction, is exit 1.
//
// THE BREAKDOWN IS CHECKED RATHER THAN MERELY PRINTED, because a single floor on the total population
// cannot see one class empty while another absorbs its share: a floor set well under the total can pass
// clean while an entire class of required files has silently stopped being derived. A per-class pin that
// has to move whenever the population moves closes that: the detector does not answer a question about
// behaviour by matching one spelling of it.
//
// Run: node scripts/verdict-guard-gate.mjs --self-test   attacks on the guard-teeth legs, fixtures over the
//                                                        legs that decide WHICH files are required, then
//                                                        per-class fixtures generated off the pin over the
//                                                        population and over the routing from a moved
//                                                        population to an exit code, and fixtures over the
//                                                        breakdown reconciliation, all in memory. The
//                                                        generated counts are printed by the run rather than
//                                                        written here, because a number in a comment is the
//                                                        shape this gate is about.
//      node scripts/verdict-guard-gate.mjs               the gate itself

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD_REL = "test/lib/verdict-guard.ts";
// THE POPULATION IS PINNED PER CLASS AND TO THE EXACT NUMBER, rather than to a single floor on the total,
// because a floor cannot see one class disappear while another absorbs its share. A floor set well under
// the total lets the whole spawned class fall to zero in silence: the surviving classes alone can clear the
// floor, the breakdown can read "0 spawned by a glob spawner", and the gate exits 0 with nothing on stderr.
// A floor that never moves when the population moves gets further from being able to see a class vanish
// with every file added.
//
// So the rule is equality, per class, not a floor on the total. Every move off the pin is loud and named
// and none of them reaches exit 0. What separates a FINDING from a CANNOT-CHECK is not the direction of
// the move.
//
// A FALL IS NOT ALWAYS A CANNOT-CHECK. Treating every fall as "the leg no longer reaches its subject" is
// right for a leg that has genuinely gone blind and wrong for two other cases. Moving one spawned child
// into a direct invocation in package.json takes spawned down by one and direct up by one: nothing left the
// graded set, the total is unchanged, and the class that fell is not the one that stopped being derived.
// Worse, AWAITING a floated main(), which is the correct repair of the very defect the floated class exists
// to catch, moves that class towards empty, and a rule that reads any fall as a cannot-check answers "I
// cannot look" to somebody repairing its subject.
//
// SO THE QUESTION IS WHETHER THE LEG THAT DERIVES A CLASS STILL HAS A SUBJECT, not whether the count went
// down. Each class is read out of a source, and that source is measured beside the count: the direct and
// floated classes are read out of the derived entry points, and the spawned class out of the entry points
// that resolve to an enumerable glob spawn. A class whose leg found NO subject is exit 2, because the
// number it reported is not a measurement, and that is asked before the counts and without reference to
// whether the class moved. Everything else is exit 1, in both directions, because the leg ran over its
// subject and returned an answer the pin disagrees with, which is a one-line fix either way. A leg that
// goes properly blind, such as the readdir target in test/cov/run.mjs falling outside the form the glob leg
// reads, still lands on exit 2.
//
// THE LIMIT, said rather than hidden. A detector cannot detect its own blindness, so a leg broken to
// return nothing while its subject stays intact reads here as a changed tree rather than as a
// cannot-check. That is exit 1 rather than exit 2, and it is still loud and still names the class. The
// fall message must not assert that the files were checked, because in that one reading they were not, so
// it names both readings and asks which, rather than claiming the leg "did have a subject": the message
// reports the size of the candidate set and stops there. The classes are also reconciled against the graded
// total before any of this is reached, so a file graded under no class, or under two, cannot hide inside a
// breakdown that appears to add up.
//
// ONE CASE OF THAT LIMIT IS NOT A LIMIT. Where a leg works in two stages, resolving a region and then
// matching inside it, the second stage matching nothing IS visible: the region resolved and the pattern
// found nothing in it. The spawned leg is that shape. Its subject is the CHILDREN a resolvable glob spawner
// matched, not the number of spawners, because counting spawners lets a real blindness answer as a finding:
// if the extension filter in test/cov/run.mjs read only one of the extensions its source names, every child
// of the unread extension would leave the graded set while the spawner itself still counted as a subject of
// one. The direct and floated legs have no such second stage and keep the general limit.
//
// WHICH CLASSES CAN ACTUALLY REACH THE BLIND ARM, because claiming it is general would be untrue of this
// tree. The arm itself is written over the classes generically and --self-test drives it over all three,
// which is right and is not the claim. In the gate proper: the DIRECT class cannot reach it, because
// `direct.size === 0` is refused as a cannot-check earlier, at the derivation, with a better message, so
// the arm is dead code for that class and nothing is lost by it. The FLOATED class reaches it only if
// every derived entry point outside test/ disappears at once, which is the whole outside-test/ derivation
// collapsing rather than a class shrinking. The SPAWNED class reaches it two ways: no glob spawner resolves
// at all, and a spawner that resolves and matches no child. So the arm serves the spawned class in
// practice. It is left general in form rather than narrowed to one class, because narrowing it would have
// to be undone the moment a fourth class is pinned, and the earlier direct refusal is the better message
// rather than a gap.
//
// The cost is deliberate: adding a validator turns this gate red until the number beside its class is
// raised, in the same way the sibling repos pin a test baseline. That is the price of a number that is
// checked rather than printed. Raising a class's pin is a one-line edit; the --self-test fixtures below are
// generated from the pin, so nothing else here needs to change with it.
const POPULATION_BASELINE = { direct: 219, spawned: 25, floated: 1 };

/**
 * populationProblems compares a measured per-class population against the pin, naming every class that
 * moved and in which direction. It is a pure function of its argument so --self-test can drive it over a
 * population that is deliberately wrong, which is the only way to show that an EMPTY class is refused: the
 * real tree is never empty, so a gate run over the real tree can never demonstrate it.
 *
 * @param {Record<string, number>} measured
 * @returns {{ cls: string, expected: number, got: number, fell: boolean }[]}
 */
function populationProblems(measured) {
  const problems = [];
  for (const [cls, expected] of Object.entries(POPULATION_BASELINE)) {
    const got = measured[cls] ?? 0;
    if (got !== expected) problems.push({ cls, expected, got, fell: got < expected });
  }
  return problems;
}

/**
 * populationVerdict routes a set of per-class problems to an exit code. The whole of this gate's
 * could-not-check reasoning about its own population lives here, in a pure function, so --self-test can
 * drive every arm of it over a population and a source set that are deliberately wrong. Written inline as
 * "fell, therefore 2" instead, the only way to exercise this reasoning would be to break the real tree.
 *
 * `sources` is how much subject each class's leg found, not how many files it graded. A leg that found no
 * subject cannot have measured anything, so this is asked BEFORE the counts and WITHOUT reference to
 * whether the class fell. Requiring a fall as well looks like the natural rule and is wrong: it would tell
 * an operator repairing the last floated script to re-pin the class at 0, and a class pinned at 0 over a
 * leg that had gone blind would then sit at 0 == 0 for ever with no fall to notice. A class pinned at 0 is
 * fine while its leg still has something to read, because the RISE arm still bites and a newly floated
 * script is exactly the rise that matters. A leg with nothing to read is not fine.
 *
 * @param {{ cls: string, expected: number, got: number, fell: boolean }[]} problems
 * @param {Record<string, number>} sources
 * @returns {{ code: 0 | 1 | 2, blind: string[] }}
 */
function populationVerdict(problems, sources) {
  const blind = Object.entries(sources).filter(([, n]) => n === 0).map(([cls]) => cls);
  if (blind.length > 0) return { code: 2, blind };
  return { code: problems.length > 0 ? 1 : 0, blind: [] };
}

/**
 * classSumProblem reconciles the breakdown against the graded total BEFORE any per-class verdict is
 * reached. Computing one class as the total MINUS the other two would make the three always sum to the
 * total whatever the classifier did, which would make the reconciliation unfalsifiable. Each class is
 * instead counted independently and the sum is checked, so a file graded under no class, or under two, is a
 * breakdown this gate refuses to report from rather than one that appears to add up.
 *
 * An EMPTY graded set is refused here too. A gate that resolved its inputs and found nothing to grade has
 * checked nothing, and reporting that as a clean tree is the defect this whole file is about.
 *
 * @param {Record<string, number>} counts
 * @param {number} total
 * @returns {string | null}
 */
function classSumProblem(counts, total) {
  if (total === 0) return "the derivation graded NO entry points at all, so there is nothing to report a verdict over";
  const summed = Object.values(counts).reduce((a, b) => a + b, 0);
  if (summed !== total) {
    const parts = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ");
    return `the breakdown (${parts}) sums to ${summed} over a graded set of ${total}, so at least one entry point is counted under no class or under two, and the breakdown does not describe what was graded`;
  }
  return null;
}

/**
 * die leaves the process and never returns to its caller, and saying so in the type is load-bearing
 * rather than decorative: without it a caller that dies on one arm of a union is not narrowed on the
 * other, and typecheck:scripts caught exactly that on the glob-spawner result.
 *
 * @param {number} code
 * @param {string} msg
 * @returns {never}
 */
function die(code, msg) {
  console.error(`verdict-guard-gate: ${msg}`);
  process.exit(code);
}

// ---- one tokeniser, two readings of it ---------------------------------------------------------------
/**
 * tagBytes labels every byte of a source as "code", "comment" or "string", walking it once. The opening
 * and closing delimiters of a comment are tagged with the comment; the delimiters of a string are tagged
 * with the string, and so is an interpolated expression inside a template literal.
 */
function tagBytes(src) {
  const t = new Array(src.length).fill("code");
  let i = 0,
    mode = "code",
    quote = "";
  while (i < src.length) {
    const c = src[i],
      d = src[i + 1];
    if (mode === "code") {
      if (c === "/" && d === "/") { t[i] = "comment"; t[i + 1] = "comment"; mode = "line"; i += 2; continue; }
      if (c === "/" && d === "*") { t[i] = "comment"; t[i + 1] = "comment"; mode = "block"; i += 2; continue; }
      if (c === '"' || c === "'" || c === "`") { t[i] = "string"; mode = "str"; quote = c; i++; continue; }
      i++;
      continue;
    }
    if (mode === "line") { if (c === "\n") mode = "code"; else t[i] = "comment"; i++; continue; }
    if (mode === "block") { if (c === "*" && d === "/") { t[i] = "comment"; t[i + 1] = "comment"; mode = "code"; i += 2; continue; } if (c !== "\n") t[i] = "comment"; i++; continue; }
    if (mode === "str") {
      t[i] = "string";
      if (c === "\\") { t[i + 1] = "string"; i += 2; continue; }
      if (c === quote) mode = "code";
      i++;
    }
  }
  return t;
}

/**
 * blankComments keeps offsets but removes comment bytes, so a pattern inside a comment cannot count. It
 * deliberately leaves STRING CONTENTS alone, because the validator-shape tests it feeds depend on them:
 * ASSERTION_PRINT looks for the literal text a validator PRINTS, so a stripper that blanked strings would
 * match nothing and every validator would read as not-a-validator.
 */
function blankComments(src) {
  const t = tagBytes(src);
  const out = Array.from(src);
  for (let i = 0; i < src.length; i++) if (t[i] === "comment" && src[i] !== "\n") out[i] = " ";
  return out.join("");
}

/**
 * startsInCode answers whether a pattern occurs in the source AS CODE, which is where the match BEGINS
 * rather than where it ends.
 *
 * WHY THE TEST IS ON THE START AND NOT ON THE WHOLE MATCH, and this cost one wrong fix before it was
 * right. Blanking string contents outright looks like the obvious answer and it breaks a real leg: the
 * exit listener is written `process.on("exit", ...)`, so its own pattern reaches INTO a string literal for
 * the argument, and with string bytes blanked the one honest listener in the guard read as missing. What
 * distinguishes a real occurrence from a quoted one is not whether a string is anywhere in it but whether
 * the occurrence STARTS inside one. `process.on(` starts in code; the guard's refusal message, which
 * writes the sentence "The refusal above set process.exitCode = 1" to stderr, starts inside a template
 * literal and does not count, which is the whole finding.
 */
function startsInCode(src, re) {
  const t = tagBytes(src);
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const m of src.matchAll(g)) if (t[m.index] === "code") return true;
  return false;
}

// ---- the guard module itself must exist and still have its teeth -------------------------------------
//
// EVERY LEG HERE IS ASKED OF CODE, NOT OF RAW SOURCE. If all six real `process.exitCode = 1` assignments in
// the guard were neutered to `= 0`, a scan of raw source could still find the pattern surviving in the
// guard's own prose: in a comment, and inside the refusal message it writes to stderr. These legs are the
// one place where a file DOCUMENTING what it does is indistinguishable from its doing it, so each one has
// to START in code. `--self-test` drives every leg.
const GUARD_TEETH = /** @type {[string, RegExp][]} */ ([
  ["an exit listener", /process\.on\(\s*["']exit["']/],
  ["a forced non-zero exit code", /process\.exitCode\s*=\s*1/],
  ["an exported verdictReached", /export function verdictReached/],
  // verdictReached() can REFUSE a declared verdict (zero checks, no assertion-shaped line, a positive
  // failure count) by assigning process.exitCode, and that assignment is ordinary code, so a caller ending
  // `process.exit(<cond> ? 0 : 1)` overwrites it with an explicit 0. The fix is not per-call-site: a
  // `refused` latch is set wherever verdictReached() refuses, and the exit listener re-applies it after the
  // caller's own exit code has already been chosen, which is the only point downstream of every route out of
  // the process. That closes the class for every enrolled entry point without touching any of them, so this
  // gate checks the latch survives rather than scanning every call site for the shape it guards against.
  ["a refusal latch set independently of a declared verdict", /let refused = false/],
  ["the refusal latch re-applied from inside the exit listener", /if\s*\(\s*refused\s*\)/],
]);

/** missingTeeth names the legs the guard source does not satisfy IN CODE, its own prose discounted. */
function missingTeeth(src) {
  return GUARD_TEETH.filter(([, re]) => !startsInCode(src, re)).map(([what]) => what);
}

const guardAbs = join(REPO, GUARD_REL);
if (!existsSync(guardAbs)) die(2, `cannot check: ${GUARD_REL} is missing`);
const guardSrc = readFileSync(guardAbs, "utf8");

// ---- the self-test -----------------------------------------------------------------------------------
//
// Five attacks and two controls, over sources patched in memory, run as a separate invocation before the
// gate itself. A gate that cannot be shown to fail has not been shown to check anything, which is why each
// of these legs is proven by an attack rather than trusted on its own logic.
//
// Each attack takes ONE leg out of the guard's CODE and leaves the same text behind as prose, in a comment
// AND in a string literal, because a comment alone would be caught by the intermediate rule too and the
// point is the difference between them. The exitCode attack injects nothing extra: it neuters the six real
// assignments to `= 0`, and the three prose occurrences the file already carries are what would otherwise
// keep the leg green. A patched source is only ever scanned, never parsed, so it need not stay valid
// TypeScript.
const proseOnly = (text, n) => `// prose: this module used to contain ${text}\nconst legRemoved${n} = '${text}';\n`;

const ATTACKS = /** @type {{ leg: string, from: string, count: number, to?: string }[]} */ ([
  { leg: "a forced non-zero exit code", from: "process.exitCode = 1;", count: 6, to: "process.exitCode = 0;" },
  { leg: "an exit listener", from: 'process.on("exit"', count: 1 },
  { leg: "an exported verdictReached", from: "export function verdictReached", count: 1 },
  { leg: "a refusal latch set independently of a declared verdict", from: "let refused = false", count: 1 },
  { leg: "the refusal latch re-applied from inside the exit listener", from: "if (refused)", count: 1 },
]);

// CONTROL TWO's fixture, kept self-contained so it cannot go stale when the guard's prose is reworded.
// It is the shape of test/lib/verdict-guard.ts:39, :128 and :190 in miniature: the pattern surviving in a
// comment and in a template literal over code that no longer does it. The intermediate rule, blanking
// comments alone, is kept here as a known-positive control, because a fix whose effect cannot be told
// apart from the rule it replaces has not been shown to be a fix. Comment-blanking alone still passes
// this fixture on the strength of its one string, which is why it is not the fix.
const INTERMEDIATE_RULE_FIXTURE = [
  "// the refusal used to set process.exitCode = 1 here",
  "const msg = `the refusal above set process.exitCode = 1 and an explicit exit overwrote it`;",
  "process.exitCode = 0;",
].join("\n");

function selfTest() {
  const problems = [];
  const exitCodeLeg = GUARD_TEETH.find(([what]) => what === "a forced non-zero exit code");
  if (exitCodeLeg === undefined) return ["control two: the leg it is written about is no longer in GUARD_TEETH under that name."];
  const EXIT_CODE_LEG = exitCodeLeg[1];

  for (const [n, a] of ATTACKS.entries()) {
    const seen = guardSrc.split(a.from).length - 1;
    if (seen !== a.count) {
      problems.push(`attack ${n + 1} could not patch ${GUARD_REL}: expected ${a.count} occurrence(s) of ${a.from}, found ${seen}. The anchor has moved, so this leg is UNPROVEN rather than passing.`);
      continue;
    }
    const patched = guardSrc.split(a.from).join(a.to ?? proseOnly(a.from, n));
    const missing = missingTeeth(patched);
    if (!missing.includes(a.leg)) {
      problems.push(`attack ${n + 1}: ${GUARD_REL} with "${a.leg}" removed from its code, its text left only in prose, was NOT reported missing. That leg cannot fail.`);
    }
    const other = missing.filter((m) => m !== a.leg);
    if (other.length > 0) {
      problems.push(`attack ${n + 1}: removing "${a.leg}" also reported ${other.join(", ")} missing, so the legs are not independent and a red would not name its cause.`);
    }
  }

  // CONTROL ONE: the real guard, unpatched, satisfies every leg. Without it every attack above could be
  // passing because the legs report everything missing all the time, which is not hypothetical: blanking
  // string CONTENTS as well as comments would break the exit-listener leg, whose pattern reaches into a
  // string for the `"exit"` argument. This control is what would catch that.
  const baseline = missingTeeth(guardSrc);
  if (baseline.length > 0) problems.push(`control one: the unpatched ${GUARD_REL} reported ${baseline.join(", ")} missing, so the attacks above prove nothing.`);

  // CONTROL TWO: the intermediate rule, blanking comments alone, does NOT reject the fixture, and the
  // shipped rule does. This is the only assertion that says the string-literal half is what does the work.
  if (!EXIT_CODE_LEG.test(blankComments(INTERMEDIATE_RULE_FIXTURE))) {
    problems.push("control two: blanking comments alone already rejected the fixture, so it is not the shape that defeated this gate and proves nothing about the fix.");
  }
  if (startsInCode(INTERMEDIATE_RULE_FIXTURE, EXIT_CODE_LEG)) {
    problems.push("control two: the shipped rule did not reject the fixture, so a pattern occurring only inside a string literal still counts as code.");
  }

  return problems;
}

// ---- the DERIVATION legs, attacked over fixtures ------------------------------------------------------
//
// The guard-teeth legs above are attacked; the legs that decide WHICH FILES ARE REQUIRED were not, and
// that is where both of tonight's leaks were. Each fixture below is a source string, so these run in CI
// against a subject that is deliberately wrong, rather than against a tree that happens to be clean.
//
// THE FALSE-REFUSAL FIXTURE IS NOT DECORATION. A glob-spawner leg that asks only whether a file spawns node
// ANYWHERE and reads a directory ANYWHERE would refuse a validator that spawns a named fixture script and
// separately lists a directory for another purpose, exiting 2 over a clean tree. That shape is pinned here
// so a loose rule of that kind cannot pass unnoticed.
const DERIVATION_FIXTURES = /** @type {{ what: string, code: string, expect: unknown, of: string }[]} */ ([
  { of: "floated", what: "a floated main() with a catch tail is required", code: 'async function main() {}\nmain().catch((e) => { process.exit(1); });\n', expect: ["main"] },
  { of: "floated", what: "a void-prefixed floated call is required", code: 'async function main() {}\nvoid main();\n', expect: ["main"] },
  { of: "floated", what: "an AWAITED tail is not floated", code: 'async function main() {}\nawait main().catch((e) => { process.exit(1); });\n', expect: [] },
  { of: "floated", what: "an indented call is not top level", code: 'async function main() {}\nif (x) {\n  main();\n}\n', expect: [] },
  { of: "floated", what: "a SYNCHRONOUS main reaches its own bottom line", code: 'function main() {}\nmain();\n', expect: [] },
  { of: "floated", what: "a call to something this file does not declare is not derivable", code: 'main();\n', expect: [] },
  { of: "glob", what: "the run.mjs shape is a glob spawner over its own directory, .ts", code: 'const here = dirname(fileURLToPath(import.meta.url));\nconst entries = readdirSync(here, { withFileTypes: true });\nconst files = entries.filter((e) => e.name.endsWith(".ts"));\nfor (const f of files) spawnSync(process.execPath, [join(here, f)], { stdio: "inherit" });\n', expect: { kind: "own", exts: [".ts"] } },
  // THE HOISTED FORM matters because a leg that only matches `join(dirVar` written inline inside the spawn
  // argument array misses it entirely. `const childPath = join(here, f)` above a spawn of `[childPath]`
  // starts exactly the same processes as the line it replaces, so a leg that does not follow the path
  // through a local reads this shape as no glob spawner at all, dropping every spawned child from the
  // graded set while still printing a pass.
  { of: "glob", what: "the child path hoisted to a local is the same glob spawner", code: 'const here = dirname(fileURLToPath(import.meta.url));\nconst files = readdirSync(here).filter((f) => f.endsWith(".ts"));\nfor (const f of files) {\n  const childPath = join(here, f);\n  spawnSync(process.execPath, [childPath], { stdio: "inherit" });\n}\n', expect: { kind: "own", exts: [".ts"] } },
  { of: "glob", what: "a path hoisted through TWO locals is followed as well as one", code: 'const here = dirname(fileURLToPath(import.meta.url));\nconst files = readdirSync(here).filter((f) => f.endsWith(".ts"));\nfor (const f of files) {\n  const childPath = join(here, f);\n  const argv = childPath;\n  spawnSync(process.execPath, [argv], {});\n}\n', expect: { kind: "own", exts: [".ts"] } },
  // A leg that reads only the FIRST .endsWith in the source reads a runner filtering two extensions as
  // filtering one, so a validator-shaped child under the unread extension is spawned by the runner and
  // named in no list this gate prints.
  { of: "glob", what: "a filter on TWO extensions yields both, not the first one read", code: 'const here = dirname(fileURLToPath(import.meta.url));\nconst files = readdirSync(here).filter((f) => f.endsWith(".ts") || f.endsWith(".mts"));\nfor (const f of files) spawnSync(process.execPath, [join(here, f)], {});\n', expect: { kind: "own", exts: [".mts", ".ts"] } },
  { of: "glob", what: "spawning a NAMED script while separately reading a directory is not a glob spawner", code: 'const names = readdirSync(dir).filter((f) => f.endsWith(".js"));\nexecFileSync(process.execPath, [STAMP_BUILD, "--outdir=x"], {});\n', expect: null },
  { of: "glob", what: "reading and joining its own directory without spawning node is not a glob spawner", code: 'const here = dirname(fileURLToPath(import.meta.url));\nconst files = readdirSync(here).filter((f) => f.endsWith(".ts"));\nfor (const f of files) readFileSync(join(here, f));\n', expect: null },
  { of: "glob", what: "a glob spawner with no derivable extension is CANNOT-CHECK, not a pass", code: 'const here = dirname(fileURLToPath(import.meta.url));\nconst files = readdirSync(here, { withFileTypes: true });\nfor (const f of files) spawnSync(process.execPath, [join(here, f.name)], {});\n', expect: { kind: "underivable", why: "it globs its own directory but filters by no extension this gate can read, so the set of files it runs cannot be enumerated from its source" } },
  // Deleting the own-directory test outright would still leave every other fixture passing, so this fixture
  // is what makes that leg falsifiable. Spawning children out of SOMEONE ELSE'S directory is a real child
  // set that no static reader can enumerate, so it is CANNOT-CHECK. Treating it as "not a glob spawner"
  // would exempt those children in silence.
  { of: "glob", what: "globbing a directory that is NOT this module's own is CANNOT-CHECK, not an exemption", code: 'const target = process.argv[2];\nconst files = readdirSync(target).filter((f) => f.endsWith(".ts"));\nfor (const f of files) spawnSync(process.execPath, [join(target, f)], {});\n', expect: { kind: "underivable", why: "it spawns children out of `target`, which is not this module's own directory, so the set of files it runs cannot be enumerated from its source" } },
  { of: "enrol", what: "a source with no guard import at all is unenrolled", code: 'let failures = 0;\nif (failures > 0) process.exit(1);\n', expect: { imports: false, declares: false } },
  { of: "enrol", what: "importing the guard but never declaring is unenrolled", code: 'import { verdictReached } from "../lib/verdict-guard.ts";\nif (failures > 0) process.exit(1);\n', expect: { imports: true, declares: false } },
  { of: "enrol", what: "import plus a declaration is enrolled", code: 'import { verdictReached } from "../lib/verdict-guard.ts";\nverdictReached(failures);\n', expect: { imports: true, declares: true } },
]);

// ---- the population pin, attacked over a population that is deliberately wrong ------------------------
//
// THE EMPTY-SET CONTROL FOR THIS GATE'S OWN DETECTOR. The question this answers is the one the detector
// above cannot answer about itself: can a class of the required set go to nothing while this gate still
// exits 0? On the real tree it cannot be asked, because the real tree is never empty, so it is asked here
// over a fabricated population instead. The fixtures are built FROM the pin rather than repeating its
// numbers, so re-pinning cannot leave them asserting a population that no longer exists.
//
// The first fixture is the known negative and it is what stops the rest proving nothing: a rule that
// reported every population as wrong would satisfy every perturbation below while being useless.
//
// THE PERTURBATIONS ARE BUILT PER CLASS AND OFF THE PIN, because building them as literal numbers would
// make the remedy this gate PRINTS one an operator could not apply. Awaiting the one floated main is the
// correct repair of the defect the floated class exists to catch; the gate reports it as a finding and
// prints `floated: 0` as the replacement pin. A fixture written here as a literal 0, or as an omitted
// class, would go on asserting a discrepancy that a pin of 0 no longer produces, so applying that pin would
// redden the self-test, and since `lint:verdict-guard` runs the self-test first, the operator's only route
// to green would be hand-editing the fixtures the change rests on.
//
// The answer is NOT to stop deriving the fixtures from the pin. That derivation is what stops a re-pinned
// class being asserted against numbers nobody moved. It is to build each perturbation so that it is a real
// discrepancy AT WHATEVER THE PIN SAYS: a fall is only constructible where the pin is above zero, a rise is
// constructible everywhere, and a class pinned at 0 keeps the two arms that still bite on it, the rise and
// the empty-subject refusal below. What is NOT allowed to pass quietly is every class pinned at 0 at once,
// which is a population pinned at nothing, and populationSelfTest refuses that outright.
/**
 * pinPerturbations builds the measurements populationProblems must refuse for ONE class, each derived from
 * that class's own pin rather than from a number written here.
 *
 * @param {string} cls
 * @returns {{ cls: string, what: string, measured: Record<string, number>, expect: unknown }[]}
 */
function pinPerturbations(cls) {
  const pin = POPULATION_BASELINE[cls];
  const out = [
    {
      cls,
      what: `a RISE in ${cls} off its pin of ${pin} is reported, and as a rise, so the pin cannot drift behind the population`,
      measured: { ...POPULATION_BASELINE, [cls]: pin + 1 },
      expect: [{ cls, expected: pin, got: pin + 1, fell: false }],
    },
  ];
  // A pin of 0 has nothing below it. A measurement of -1 is not a population, and a fixture asserting one
  // asserts nothing about any tree, so the fall shapes are built only where a fall exists.
  if (pin === 0) return out;
  const absent = { ...POPULATION_BASELINE };
  delete absent[cls];
  out.push(
    {
      cls,
      what: `an EMPTY ${cls} class is refused, which is the leg that derives it going silent`,
      measured: { ...POPULATION_BASELINE, [cls]: 0 },
      expect: [{ cls, expected: pin, got: 0, fell: true }],
    },
    {
      cls,
      what: `a ${cls} class absent from the measurement altogether is refused, not read as satisfied`,
      measured: absent,
      expect: [{ cls, expected: pin, got: 0, fell: true }],
    },
  );
  if (pin > 1) {
    out.push({
      cls,
      what: `one file lost from ${cls} is refused, so the rule does not need a class to empty before it bites`,
      measured: { ...POPULATION_BASELINE, [cls]: pin - 1 },
      expect: [{ cls, expected: pin, got: pin - 1, fell: true }],
    });
  }
  return out;
}

const POPULATION_FIXTURES = /** @type {{ cls?: string, what: string, measured: Record<string, number>, expect: unknown }[]} */ ([
  { what: "the pinned population is accepted", measured: { ...POPULATION_BASELINE }, expect: [] },
  ...Object.keys(POPULATION_BASELINE).flatMap((cls) => pinPerturbations(cls)),
]);

// ---- the ROUTING from a moved population to an exit code, attacked over both wrong answers -------------
//
// Every shape here was DRIVEN against this gate rather than imagined. Two of them are the false
// cannot-checks: a reclassification that moves a file between classes without taking it out of the graded
// set, and the correct repair of a class's own subject. The disaster the pin was written for must stay on
// exit 2. Then the vacuity control, where every count agrees with the pin and the gate must refuse anyway.
// The property that matters most is asserted separately below over every move at once rather than trusted
// to this list: NO MOVE OFF THE PIN REACHES EXIT 0.
// These are the sizes measured on this tree, and only their being NON-ZERO is load-bearing: the routing
// asks whether a leg had a subject, never how big it was, so these do not need re-pinning when the tree
// grows. `spawned` is 25 because the spawned leg's subject is the CHILDREN a resolvable glob spawner
// matched, not the number of spawners, which is what globCandidates below is built to get right. `floated`
// is 51 rather than the count of every path the derivation derives, because two of those paths, both under
// FIELD-CATALOGUE, resolve to the sibling internal-docs repo or to nothing; the loop counts what it can
// open. Checked rather than assumed: neither declares an async function, so neither can enter the floated
// class from either bed.
const FULL_SOURCES = { direct: 241, spawned: 25, floated: 51 };

/**
 * routingPerturbations builds, for ONE class, the routing shapes that must not change their answer whatever
 * the pin says, each derived from that class's own pin for the same reason pinPerturbations is.
 *
 * The two findings-not-cannot-checks below were DRIVEN against this gate rather than imagined, on the
 * floated and spawned classes respectively, and they are built per class here so that repairing a class to
 * empty and then re-pinning it at 0 cannot leave the shape asserted against a class that no longer has it.
 *
 * @param {string} cls
 * @returns {{ cls: string, what: string, measured: Record<string, number>, sources: Record<string, number>, expect: { code: number, blind: string[] } }[]}
 */
function routingPerturbations(cls) {
  const pin = POPULATION_BASELINE[cls];
  const out = [
    {
      cls,
      what: `a RISE in ${cls} over an intact derivation is a finding, which is what it always was`,
      measured: { ...POPULATION_BASELINE, [cls]: pin + 1 },
      sources: FULL_SOURCES,
      expect: { code: 1, blind: [] },
    },
    {
      cls,
      what: `the leg that derives ${cls} losing its subject is a cannot-check, so the arm is not spelled for one class`,
      measured: { ...POPULATION_BASELINE, [cls]: 0 },
      sources: { ...FULL_SOURCES, [cls]: 0 },
      expect: { code: 2, blind: [cls] },
    },
    // THE VACUITY CONTROL, per class, and it is the one shape here with no discrepancy in it at all. Every
    // count agrees with the pin and the gate must still refuse, because a leg that resolved its inputs and
    // found nothing to look at has not checked the class it reports on. It differs from the first fixture
    // in the list below in the SOURCE alone, which is what makes the pair say that the source is doing the
    // work. A rule that fires only on a fall would pass this fixture without noticing, which is exactly the
    // gap this control closes.
    {
      cls,
      what: `a leg with NO subject for ${cls} is a cannot-check even where every class matches its pin, so the two numbers agreeing is not enough`,
      measured: { ...POPULATION_BASELINE },
      sources: { ...FULL_SOURCES, [cls]: 0 },
      expect: { code: 2, blind: [cls] },
    },
  ];
  if (pin === 0) return out;
  out.push({
    cls,
    what: `EMPTYING ${cls} over an intact subject is a finding, not a cannot-check: repairing the last file in a class is somebody repairing this gate's subject, not this gate going blind`,
    measured: { ...POPULATION_BASELINE, [cls]: 0 },
    sources: FULL_SOURCES,
    expect: { code: 1, blind: [] },
  });
  const to = Object.keys(POPULATION_BASELINE).find((c) => c !== cls);
  if (to !== undefined) {
    out.push({
      cls,
      what: `RECLASSIFICATION out of ${cls} is a finding, not a cannot-check: one file moved to ${to} leaves the graded set the same size`,
      measured: { ...POPULATION_BASELINE, [cls]: pin - 1, [to]: POPULATION_BASELINE[to] + 1 },
      sources: FULL_SOURCES,
      expect: { code: 1, blind: [] },
    });
  }
  return out;
}

const VERDICT_FIXTURES = /** @type {{ cls?: string, what: string, measured: Record<string, number>, sources: Record<string, number>, expect: { code: number, blind: string[] } }[]} */ ([
  { what: "the pinned population over an intact derivation is a pass", measured: { ...POPULATION_BASELINE }, sources: FULL_SOURCES, expect: { code: 0, blind: [] } },
  {
    what: "a class absent from the measurement altogether over an empty subject is a cannot-check, not read as satisfied",
    measured: { direct: POPULATION_BASELINE.direct, spawned: POPULATION_BASELINE.spawned },
    sources: { ...FULL_SOURCES, floated: 0 },
    expect: { code: 2, blind: ["floated"] },
  },
  {
    what: "a blind class and a stale class together take the cannot-check, because the gate cannot report over the part it did not reach",
    measured: { ...POPULATION_BASELINE, spawned: 0, direct: POPULATION_BASELINE.direct + 1 },
    sources: { ...FULL_SOURCES, spawned: 0 },
    expect: { code: 2, blind: ["spawned"] },
  },
  ...Object.keys(POPULATION_BASELINE).flatMap((cls) => routingPerturbations(cls)),
]);

// The breakdown reconciliation, including the empty-set control that is the reason it exists.
const SUM_FIXTURES = /** @type {{ what: string, counts: Record<string, number>, total: number, expect: boolean }[]} */ ([
  { what: "a breakdown that accounts for every graded file reconciles", counts: { direct: 188, spawned: 25, floated: 1 }, total: 214, expect: false },
  { what: "a file graded under NO class is refused", counts: { direct: 187, spawned: 25, floated: 1 }, total: 214, expect: true },
  { what: "a file counted under TWO classes is refused", counts: { direct: 188, spawned: 25, floated: 2 }, total: 214, expect: true },
  { what: "a graded set of nothing is refused however neatly the breakdown adds up", counts: { direct: 0, spawned: 0, floated: 0 }, total: 0, expect: true },
]);

// THE SPAWNED CLASS'S SUBJECT, driven over a directory listing rather than over the real tree. A filter
// that matches nothing in a directory that resolved is a pattern that matched nothing, and the count it
// yields has to be 0 so the empty-subject arm above can see it. Counting SPAWNERS instead would yield 1
// there, which would route a leg that looked at nothing to a finding rather than a cannot-check, printing a
// pin an operator could wrongly apply.
const CHILD_FIXTURES = /** @type {{ what: string, names: string[], exts: string[], spawner: string, expect: string[] }[]} */ ([
  { what: "the children are the listing filtered by the extensions read out of the spawner", names: ["a.ts", "b.ts", "notes.md", "run.mjs"], exts: [".ts"], spawner: "run.mjs", expect: ["a.ts", "b.ts"] },
  { what: "a filter that matches NOTHING in a directory that resolved yields no children, not the spawner count", names: ["a.ts", "b.ts", "run.mjs"], exts: [".json"], spawner: "run.mjs", expect: [] },
  { what: "the spawner is not a child of itself, so a directory holding only the spawner yields nothing", names: ["run.mjs"], exts: [".mjs"], spawner: "run.mjs", expect: [] },
  { what: "two extensions yield both, matching the extension leg that reads them", names: ["a.ts", "b.mts", "c.js"], exts: [".mts", ".ts"], spawner: "run.mjs", expect: ["a.ts", "b.mts"] },
]);

function populationSelfTest() {
  const problems = [];
  for (const f of CHILD_FIXTURES) {
    const got = globChildNames(f.names, f.exts, f.spawner);
    if (JSON.stringify(got) !== JSON.stringify(f.expect)) {
      problems.push(`spawned subject: ${f.what}. Expected ${JSON.stringify(f.expect)}, got ${JSON.stringify(got)}.`);
    }
  }
  for (const f of VERDICT_FIXTURES) {
    const got = populationVerdict(populationProblems(f.measured), f.sources);
    if (JSON.stringify(got) !== JSON.stringify(f.expect)) {
      problems.push(`population routing: ${f.what}. Expected ${JSON.stringify(f.expect)}, got ${JSON.stringify(got)}.`);
    }
  }
  // THE PROPERTY THAT MATTERS, asserted rather than inspected. Whatever else this routing does, a class
  // that has MOVED must never reach exit 0, and that has to hold over an intact subject as well as an
  // empty one: most falls route to exit 1 rather than exit 2, and this is what confirms none of them route
  // to exit 0 instead. Every single-class move is enumerated here rather than sampled. A class pinned at 0
  // has no fall below it, so it contributes its rise alone, and that is the arm the header leans on when it
  // says a class pinned at 0 is still watched.
  for (const cls of Object.keys(POPULATION_BASELINE)) {
    const pin = POPULATION_BASELINE[cls];
    const moves = pin > 0 ? [pin - 1, pin + 1] : [pin + 1];
    for (const got of moves) {
      for (const src of [FULL_SOURCES, { ...FULL_SOURCES, [cls]: 0 }]) {
        const measured = { ...POPULATION_BASELINE, [cls]: got };
        const routed = populationVerdict(populationProblems(measured), src);
        if (routed.code === 0) {
          problems.push(`population routing: ${cls} moved from ${pin} to ${got} with a subject of ${src[cls]} and the routing returned exit 0. A move off the pin must never be a pass.`);
        }
      }
    }
  }
  // EVERY CLASS MUST CONTRIBUTE A FIXTURE TO BOTH LISTS, or a class could be added to the pin and be
  // driven by nothing. This is the vacuity control for the GENERATORS: a generator that returned an empty
  // array for some class would leave both lists shorter and every remaining fixture still passing.
  for (const cls of Object.keys(POPULATION_BASELINE)) {
    if (!POPULATION_FIXTURES.some((f) => f.cls === cls)) {
      problems.push(`population pin: no fixture is generated for the class ${cls}, so the pin for it is asserted by nothing.`);
    }
    if (!VERDICT_FIXTURES.some((f) => f.cls === cls)) {
      problems.push(`population routing: no routing fixture is generated for the class ${cls}, so the routing over it is asserted by nothing.`);
    }
  }
  // A POPULATION PINNED AT NOTHING IS REFUSED HERE, and this is the guard that lets the fall shapes stand
  // down for a class pinned at 0 without a dead population sitting unnoticed. One class at 0 is a repaired
  // class, watched by its rise and by the empty-subject arm. EVERY class at 0 is a gate grading nothing,
  // which classSumProblem refuses on the real tree, and which no fall fixture would be left to catch here.
  if (Object.values(POPULATION_BASELINE).every((n) => n === 0)) {
    problems.push("population pin: every class is pinned at 0, so no fall exists to construct and these fixtures assert rises alone. A population pinned at nothing describes a gate that grades nothing, which is the defect this file is about rather than a baseline.");
  }
  for (const f of SUM_FIXTURES) {
    const got = classSumProblem(f.counts, f.total) !== null;
    if (got !== f.expect) {
      problems.push(`breakdown reconciliation: ${f.what}. Expected ${f.expect ? "a refusal" : "no problem"}, got ${got ? "a refusal" : "no problem"}.`);
    }
  }
  // Every pinned class must have a subject measured for it, or a class could be added to the pin with no
  // source and the empty-subject arm above would silently never apply to it.
  const pinnedClasses = Object.keys(POPULATION_BASELINE).sort().join(",");
  const sourcedClasses = Object.keys(FULL_SOURCES).sort().join(",");
  if (pinnedClasses !== sourcedClasses) {
    problems.push(`population routing: the pinned classes are ${pinnedClasses} but a subject is measured for ${sourcedClasses}. A class with no source measured for it is a class the empty-subject arm cannot see.`);
  }
  for (const f of POPULATION_FIXTURES) {
    const got = populationProblems(f.measured);
    if (JSON.stringify(got) !== JSON.stringify(f.expect)) {
      problems.push(`population pin: ${f.what}. Expected ${JSON.stringify(f.expect)}, got ${JSON.stringify(got)}.`);
    }
  }
  // The pin has to name every class the breakdown prints, or a class could be added to the report and
  // never to the pin, which is the printed-but-checked-by-nothing shape all over again.
  const pinned = Object.keys(POPULATION_BASELINE).sort().join(",");
  if (pinned !== "direct,floated,spawned") {
    problems.push(`population pin: the pinned classes are ${pinned}, but the breakdown this gate prints has direct, spawned and floated. A class that is printed and not pinned is checked by nothing.`);
  }
  return problems;
}

function derivationSelfTest() {
  const problems = [];
  for (const f of DERIVATION_FIXTURES) {
    const got = f.of === "floated" ? floatedAsyncBottomLine(f.code) : f.of === "glob" ? globSpawnedChildren(f.code) : enrolmentOf(f.code);
    if (JSON.stringify(got) !== JSON.stringify(f.expect)) {
      problems.push(`derivation leg (${f.of}): ${f.what}. Expected ${JSON.stringify(f.expect)}, got ${JSON.stringify(got)}.`);
    }
  }
  return problems;
}

if (process.argv.includes("--self-test")) {
  const problems = [...selfTest(), ...derivationSelfTest(), ...populationSelfTest()];
  if (problems.length > 0) {
    console.error("VERDICT GUARD GATE SELF-TEST FAILED");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`verdict-guard-gate self-test: ${ATTACKS.length} attacks over ${GUARD_TEETH.length} guard-teeth legs, all caught, plus 2 controls`);
  console.log(`  and ${DERIVATION_FIXTURES.length} fixtures over the three legs that decide WHICH files are required, including six known negatives`);
  console.log(`  and ${POPULATION_FIXTURES.length} fixtures over the per-class population pin, generated off the pin for each of the`);
  console.log(`  ${Object.keys(POPULATION_BASELINE).length} classes so that re-pinning a class moves them with it, including the empty-class control`);
  console.log(`  and ${VERDICT_FIXTURES.length} over the routing from a moved population to an exit code, including the two false`);
  console.log(`  cannot-checks per class and a per-class vacuity control where every count matches the pin and`);
  console.log(`  it fails anyway, plus every single-class move driven against exit 0, ${CHILD_FIXTURES.length} over the spawned class's`);
  console.log(`  subject including a filter that matches nothing in a directory that resolved, and ${SUM_FIXTURES.length} over the`);
  console.log(`  breakdown reconciliation`);
  process.exit(0);
}

const missingLegs = missingTeeth(guardSrc);
if (missingLegs.length > 0) {
  die(2, `cannot check: ${GUARD_REL} no longer contains ${missingLegs.join(", nor ")}, so the guard can no longer force a red the caller's own exit code cannot overwrite (R-56). Prose mentioning any of these does not count; the check reads code.`);
}

// ---- derive the entry points -------------------------------------------------------------------------
const pkgPath = join(REPO, "package.json");
if (!existsSync(pkgPath)) die(2, "cannot check: package.json is missing");
const scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {};
if (Object.keys(scripts).length === 0) die(2, "cannot check: package.json declares no scripts");

// The negative lookahead stops ".json" matching as ".js", which otherwise invents entry points: the field
// gate's `--census node_modules/.cache/field-census.jsonl` would derive as a `.js` file that does not exist.
//
// The INTERPRETER is matched as the literal word OR as a shell variable holding it. Matching only the
// literal missed a real invocation in the engine: `"$NODE" test/foo.ts` inside a .sh the chain calls was
// invisible to the derivation, so a validator reached CI unenrolled and the gate reported a pass. The
// variable form has to be accepted for the same reason the .sh files are followed at all, and it is written
// here BEFORE console has one, because the cheap moment to accept it is before the blind spot exists.
const INTERP = '(?:node|tsx|"?\\$\\{?(?:[A-Za-z_][A-Za-z0-9_]*)\\}?"?)';
const SCRIPT_PATH = '((?:\\.\\/)?(?:[A-Za-z0-9_.-]+\\/)+[A-Za-z0-9_.-]+\\.(?:ts|mts|cts|mjs|cjs|js))(?![A-Za-z0-9])';
const DIRECT_RE = new RegExp(`(?:^|[\\s;&|(])(?:npx\\s+)?${INTERP}\\s+(?:--[^\\s]+\\s+)*${SCRIPT_PATH}`, "g");

const direct = new Map(); // repo-relative path -> Set(where)

function scanCommand(cmd, where, seen = new Set()) {
  for (const m of String(cmd).matchAll(DIRECT_RE)) {
    const p = String(m[1]).replace(/^\.\//, "");
    if (!direct.has(p)) direct.set(p, new Set());
    direct.get(p).add(where);
  }
  for (const m of String(cmd).matchAll(/npm\s+run\s+(?:--silent\s+|-s\s+)?([A-Za-z0-9:_-]+)/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    if (scripts[m[1]] !== undefined) scanCommand(scripts[m[1]], `${where} -> npm run ${m[1]}`, seen);
  }
  for (const m of String(cmd).matchAll(/(?:sh|bash)\s+((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.sh)/g)) {
    const abs = join(REPO, m[1]);
    if (existsSync(abs)) scanCommand(readFileSync(abs, "utf8"), `${where} -> sh ${m[1]}`, seen);
  }
}

for (const [name, cmd] of Object.entries(scripts)) scanCommand(cmd, `npm:${name}`);

const wfDir = join(REPO, ".github", "workflows");
const workflows = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)) : [];
if (workflows.length === 0) die(2, "cannot check: no .github/workflows/*.yml found, so CI reachability cannot be derived");
for (const wf of workflows) {
  const src = readFileSync(join(wfDir, wf), "utf8")
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");
  scanCommand(src, `ci:${wf}`);
}

if (direct.size === 0) die(2, "cannot check: the derivation found no directly-invoked scripts at all");

// ---- decide which of them are validators, by shape ---------------------------------------------------
const ASSERTION_PRINT = /console\.log\([^)]*\b(?:"|'|`)\s*(?:ok|FAIL)/i;
// A TALLY is a count COMPARED AGAINST ZERO that decides the exit, not any non-zero exit anywhere in the
// file. Treating every `process.exit(1)` as a tally would demand a verdict from a fixture PRODUCER whose
// only exit(1) is a usage error, which is not a validator and has no verdict to declare. The forms below are
// the ones this repo writes: `if (n > 0) process.exit(1)`, `process.exit(n === 0 ? 0 : 1)`, and their
// process.exitCode equivalents, including the globalThis process shim a number of validators here route
// through.
const COUNT = '[A-Za-z0-9_.$\\[\\]]+';
const EXITER = '(?:process|\\(globalThis as unknown as \\{[^{}]*\\{[^{}]*\\}[^{}]*\\}\\)\\.process)';
const TALLY = new RegExp(
  `if\\s*\\(\\s*${COUNT}\\s*(?:>\\s*0|!==?\\s*0)[^)]*\\)\\s*(?:\\{|${EXITER}\\.exit(?:Code)?\\s*[=(])` +
    `|${EXITER}\\.exit(?:Code)?\\s*[=(]\\s*${COUNT}\\s*(?:===?\\s*0|>\\s*0)\\s*\\?`,
);
const ANY_FAILURE_PATH = /process\.exit\(\s*[^0\s]|process\.exitCode\s*=|(^|\s)throw\s/m;

// ---- two ways an entry point escaped this requirement, both now derived ------------------------------
//
// WHY THESE TWO LEGS EXIST. The requirement above is "under test/, and a validator by shape", derived from
// DIRECT invocation, and both halves of it can leak. Counting floating catch tails only in files that
// already import the guard cannot see a floating tail in a file that imports no guard at all, including the
// child files a glob spawner runs and a scripts/ gate whose async main is never awaited. "Zero remaining"
// measured over importers is not the same claim as "zero remaining" over the whole tree.

/**
 * floatedAsyncBottomLine names the locally-declared async functions a module CALLS AND DOES NOT AWAIT at
 * its top level, so the module body reaches its own end while the work is still in flight.
 *
 * That shape is what makes the scripts/ exemption conditional. The gate scripts are exempt because they are
 * straight-line synchronous scanners that reach their own bottom line. A gate that grows an async main() and
 * floats it no longer fits that description, and a header instruction telling a reader to move such a file
 * into the requirement cannot be enforced, because nothing reads a comment. This derives the condition
 * instead. A never-settling await inside a floated main can leave `npm run lint:prose` at EXIT 0 having
 * written zero bytes: it scans nothing, prints nothing, and passes.
 *
 * THE LIMIT OF A TEXT SCANNER, said rather than hidden: "top level" here is column zero. An await, any
 * indentation, and a call to something not declared `async function` in the same file all fall outside,
 * which makes it under-inclusive rather than over-inclusive. It is checked against both, and against an
 * awaited tail specifically, in --self-test.
 */
function floatedAsyncBottomLine(code) {
  const names = new Set();
  for (const m of code.matchAll(/^(?:void\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) {
    const name = m[1];
    // NO KEYWORD EXCLUSION, and its absence is deliberate rather than an omission. A list of keywords to
    // skip (`if (`, `for (`, `await main()`) is unnecessary: the declaration test below already subsumes it
    // entirely. Every keyword that can appear at column zero followed by `(` is a RESERVED WORD, and
    // `async function <reserved>` is a SyntaxError in an ES module, which is the only thing this gate scans.
    // Checked rather than assumed: node --check on a .mjs holding `async function await() {}` exits 1. A
    // line that cannot fail is the defect this gate is about, so it is not kept as belt and braces.
    if (new RegExp(`async\\s+function\\s+${name}\\b`).test(code)) names.add(name);
  }
  return [...names];
}

/**
 * globSpawnedChildren answers whether an entry point spawns a whole DIRECTORY of scripts as child
 * processes, which passes this requirement down to every one of them.
 *
 * test/cov/run.mjs does exactly that: it reads its own directory, spawns each `.ts` in it under
 * process.execPath, and counts `r.status !== 0` as a failure. A parent that reads only the child's exit
 * code inherits the child's blind spot, which the guard's own header says in as many words, so the guard
 * has to live in the child, not merely in the parent that spawns it. A child that imports no guard and is
 * never invoked directly by package.json or a workflow is derived by no other leg: an injected false
 * assertion plus a never-settling await in such a child can leave the child at exit 0 and the runner
 * printing VERDICT: PASS failures=0, so a check that genuinely fails reaches a green build.
 *
 * FAILS RATHER THAN GUESSES. A spawner whose child directory or extension cannot be read out of its own
 * source is exit 2, not a silent pass over an empty child set.
 *
 * @returns {{ kind: "own", exts: string[] } | { kind: "underivable", why: string } | null}
 */
function globSpawnedChildren(code) {
  // THE LINK BETWEEN THE READ AND THE SPAWN IS THE WHOLE TEST, and requiring the two merely to be PRESENT
  // is not enough: a validator that spawns node at a named fixture script and separately reads a directory
  // for something else would be refused as underivable by a presence-only test. What makes a glob spawner is
  // one identifier, read for its entries and then used to build the child path.
  for (const m of code.matchAll(/readdirSync\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
    const dirVar = m[1];
    if (!spawnsChildrenFrom(code, dirVar)) continue;
    // WHOSE DIRECTORY IT IS DECIDES WHETHER THE CHILD SET CAN BE DERIVED AT ALL. Reading its own is the
    // one case a static reader can resolve, because the spawner's path gives the directory. A spawner
    // globbing some OTHER directory has a real child set this gate cannot enumerate, and returning
    // "not a glob spawner" there would exempt every one of those children in silence, which is the
    // shape that produced this whole finding. It is CANNOT-CHECK instead.
    const isOwnDirectory = new RegExp(`${dirVar}\\s*=\\s*(?:dirname\\s*\\(\\s*fileURLToPath\\s*\\(\\s*import\\.meta\\.url\\s*\\)\\s*\\)|import\\.meta\\.dirname)`).test(code);
    if (!isOwnDirectory) return { kind: "underivable", why: `it spawns children out of \`${dirVar}\`, which is not this module's own directory, so the set of files it runs cannot be enumerated from its source` };
    // EVERY EXTENSION THE SOURCE FILTERS ON, not the first one it mentions. Reading only the first match
    // meant a runner filtering `.ts` OR `.mts` was read as filtering `.ts`, and a draining `.mts` child
    // was spawned by the runner while sitting in no list this gate prints. Over-collecting is the safe
    // direction here and is chosen deliberately: an extension mentioned for some other purpose pulls
    // extra files in the same directory into the requirement, which is a LOUD false finding naming a real
    // file, where under-collecting is a silent exemption of a file that genuinely runs.
    const exts = [...new Set([...code.matchAll(/\.endsWith\(\s*["'`](\.[A-Za-z0-9]+)["'`]/g)].map((e) => e[1]))].sort();
    if (exts.length === 0) return { kind: "underivable", why: "it globs its own directory but filters by no extension this gate can read, so the set of files it runs cannot be enumerated from its source" };
    return { kind: "own", exts };
  }
  return null;
}

/**
 * globChildNames names the children a resolvable glob spawner MATCHES in the directory it globs, given that
 * directory's listing. It is a separate pure function so --self-test can drive the one case that decides a
 * finding from a cannot-check for the spawned class: a listing that resolves and a filter that matches
 * nothing in it. Inlined in the loop below, that case could only be shown by editing the real tree.
 *
 * The spawner is excluded from its own child set: run.mjs does not spawn itself.
 *
 * @param {string[]} names the directory listing, as readdirSync returns it
 * @param {string[]} exts the extensions read out of the spawner's own source
 * @param {string} spawnerName the spawner's own basename
 * @returns {string[]}
 */
function globChildNames(names, exts, spawnerName) {
  return names.filter((n) => n !== spawnerName && exts.some((e) => n.endsWith(e)));
}

/**
 * spawnsChildrenFrom answers whether the module spawns node at a path BUILT FROM `dirVar`, following the
 * path through named locals rather than demanding it be constructed inside the spawn argument array.
 *
 * WHY IT IS NOT ONE REGEX OVER THE SPAWN CALL. A rule that requires the literal `join(dirVar` inside the
 * argument array misses an ordinary tidy-up: hoisting that expression to a local, `const childPath =
 * join(here, f)` followed by `spawnSync(process.execPath, [childPath])`, changes nothing about which
 * processes the runner starts, but a literal-match rule would return null for it, dropping the whole
 * spawned class from the required set and letting the gate print a pass with nothing on stderr. A leg that
 * answers a question about BEHAVIOUR by matching one spelling of it is a leg an editor can empty without
 * knowing it exists.
 *
 * So a path CARRIER is followed instead. `dirVar` is a carrier; so is any local whose initialiser applies
 * a path-building operation (join, resolve, a template hole, concatenation with a string) to a carrier,
 * transitively. A spawn of process.execPath whose argument array names any carrier is a glob spawn.
 *
 * THE LIMIT, said rather than hidden. This follows initialisers, so a path carried through a function
 * parameter, an array element or a reassignment is outside it, and so is a directory read by anything
 * other than a bare identifier argument to readdirSync. Under-inclusiveness here is exactly the failure
 * mode above, so it is not left resting on this function's reach: the per-class population pin refuses a
 * spawned class that has fallen, whatever emptied it, and --self-test drives that refusal over a
 * deliberately empty population.
 */
function spawnsChildrenFrom(code, dirVar) {
  const carriers = new Set([dirVar]);
  const buildsFrom = (name) => new RegExp(`(?:join|resolve)\\s*\\([^;]*\\b${name}\\b|\`[^\`]*\\$\\{\\s*${name}\\s*[}.\\[]|\\b${name}\\s*\\+\\s*["'\`]`);
  // A fixpoint rather than one pass, so a path hoisted through two locals is followed as well as one. The
  // bound is the number of declarations, which is the most links a chain can have.
  for (let pass = 0; pass < 8; pass++) {
    let grew = false;
    for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g)) {
      const [, name, rhs] = m;
      if (carriers.has(name)) continue;
      // A bare alias, `const argv = childPath`, carries the path as surely as the join that built it.
      const alias = rhs.trim().replace(/[;,]$/, "");
      if ([...carriers].some((c) => c === alias || buildsFrom(c).test(rhs))) {
        carriers.add(name);
        grew = true;
      }
    }
    if (!grew) break;
  }
  for (const m of code.matchAll(/(?:spawnSync|spawn|execFileSync|execFile)\s*\(\s*process\.execPath\s*,\s*\[([^\]]*)\]/g)) {
    const args = m[1];
    if ([...carriers].some((c) => new RegExp(`\\b${c}\\b`).test(args))) return true;
  }
  return false;
}

const required = [];
const skippedNotValidator = [];
const spawnedIn = new Map(); // repo-relative child path -> the spawner that runs it
// HOW MUCH SUBJECT EACH CLASS'S LEG FOUND, which is a different measurement from how many files that leg
// graded, and the difference is what separates exit 1 from exit 2 further down. The float leg reads the
// derived entry points OUTSIDE test/, and the spawned class is read out of the CHILDREN that the entry
// points resolving to an enumerable glob spawn matched. A leg whose subject is zero found nothing to look
// at, so whatever it reported is not a measurement.
//
// THE SPAWNED SUBJECT IS THE CHILDREN, NOT THE SPAWNERS, because counting spawners lets a genuine
// cannot-check answer as a finding. If the extension filter in test/cov/run.mjs were hoisted to a constant,
// leaving the source with one unrelated `.endsWith(".json")` in code, the extension list this gate reads out
// of that file would become [".json"], no child would match, and every child would leave the graded set
// while the spawner itself is still detected. Counting spawners, the subject would still be 1, so the gate
// would exit 1 asserting that the leg "did have a subject", and applying the pin it printed would reach exit
// 0 with only the self-test standing in the way. THE LEG WOULD HAVE A REGION AND BE BLIND ANYWAY: it
// resolves test/cov/, opens it, and its pattern matches nothing in it. A region that resolves and matches
// nothing is a pattern that matched nothing, and that is a cannot-check.
//
// WHY THIS IS THE SPAWNED CLASS AND NOT A RULE FOR ALL THREE. A glob spawner exists to run the files it
// matches, and test/cov/run.mjs:45 refuses its own run when it matches none, so a spawner matching nothing
// is never a repaired tree. The float leg is the opposite: matching none of the files it reads is exactly
// what the correct repair of the last floated script looks like, so treating that as blindness would
// re-create a false cannot-check. The direct leg cannot reach zero here at all, and the header says why.
let outsideTestDerived = 0;
let globSpawners = 0;
let globCandidates = 0;
for (const [p, where] of [...direct.entries()].sort()) {
  const abs = join(REPO, p);
  if (!existsSync(abs)) continue;
  if (/\/(vitest|runtime)\//.test(p)) continue; // run by a framework that reports its own verdict
  // The guard's own fixtures are DELIBERATELY unenrolled shapes; they are driven as child processes by
  // test/validate-verdict-guard.ts and are never chain steps, so they are never derived. Excluded here
  // only so that a future chain entry cannot accidentally pull one in and read as a finding.
  if (p.includes("verdict-guard-fixtures/")) continue;
  const src = readFileSync(abs, "utf8");
  const code = blankComments(src);
  let floatsItsBottomLine = false;
  if (!p.startsWith("test/")) {
    // Counted BEFORE the exemption, because this is the set the float leg READS rather than the set it
    // keeps. If this reaches zero the leg has no subject, and an empty floated class is then a
    // cannot-check rather than a repaired tree.
    outsideTestDerived += 1;
    // A gate under scripts/ is exempt only while it reaches its own bottom line. One that floats an
    // async call does not, so it comes into the requirement here rather than in a header sentence.
    const floats = floatedAsyncBottomLine(code);
    if (floats.length === 0) continue;
    floatsItsBottomLine = true;
    direct.get(p).add(`floats ${floats.join(", ")}() without awaiting it`);
  }
  // The validator-shape test is DELIBERATELY not applied to a floated entry point. Shape decides
  // whether a file under test/ is a validator at all; floating decides whether a file's exit code can
  // be reached without its bottom line, and that is true of a scanner whose verdict is a printed count
  // rather than an ok/FAIL tally. writing-rules-source.mjs is exactly that: it fails the shape test on
  // all three legs, and it is the file whose drain left lint:prose green over zero bytes written.
  const isValidator = /^validate-/.test(basename(p)) || ASSERTION_PRINT.test(code) || TALLY.test(code);
  if (!isValidator && !floatsItsBottomLine) {
    skippedNotValidator.push(p);
    continue;
  }
  required.push({ path: p, src, code, where: [...where] });
  // A glob spawner passes the requirement down to every file it spawns.
  const glob = globSpawnedChildren(code);
  if (glob !== null) {
    if (glob.kind === "underivable") {
      die(2, `cannot check: ${p} spawns child scripts as processes, and ${glob.why}. A spawner whose children cannot be enumerated cannot be checked, and reporting a pass over an empty child set is the defect this gate exists for.`);
    }
    globSpawners += 1;
    const dir = dirname(p);
    const children = globChildNames(readdirSync(join(REPO, dir)).sort(), glob.exts, basename(p));
    // Counted BEFORE the de-duplication below, because this is what the leg MATCHED rather than what it
    // added to the graded set. A child that is also invoked directly keeps its own derivation and is not
    // added here, and that is not the leg finding nothing.
    globCandidates += children.length;
    for (const name of children) {
      const childPath = `${dir}/${name}`;
      if (!spawnedIn.has(childPath)) spawnedIn.set(childPath, `spawned by ${p}`);
    }
  }
}

// The children, added after the direct pass so a child that is ALSO invoked directly keeps its own
// derivation rather than being listed twice.
//
// THE VALIDATOR-SHAPE TEST IS NOT APPLIED HERE. Shape answers "is this file a validator", which is the
// right question for a file the chain invokes on its own account. It is the wrong question for a spawned
// child, because the parent's verdict already counts that child: the runner reads r.status and declares
// checks=N over every file it started, so a child it started is a check the run claims to have made,
// whatever shape the child is. Applying the shape test here would skip a child whose only failure path is
// a throw, with no assertion output and no tally, as not-a-validator; a drain above that throw would then
// leave it at exit 0 having written nothing, while the runner declares a pass over it and the gate exits 0.
// Its name would reach the "not treated as validators" line, which nothing compares against anything: the
// same defect as a number printed rather than checked. So the child set is the requirement, and a child
// with no failure path is reported by the cannotFail leg further down rather than exempted here.
const alreadyRequired = new Set(required.map((r) => r.path));
for (const [childPath, where] of [...spawnedIn.entries()].sort()) {
  if (alreadyRequired.has(childPath)) continue;
  const abs = join(REPO, childPath);
  if (!existsSync(abs)) continue;
  const src = readFileSync(abs, "utf8");
  required.push({ path: childPath, src, code: blankComments(src), where: [where] });
}

// ---- the population, checked per class before anything is reported about it --------------------------
//
// This sits ABOVE the findings deliberately. A class that has emptied is not a clean tree, and printing a
// pass over it is the exact shape this gate exists to refuse in the files it grades.
const isSpawned = (r) => r.where.some((w) => w.startsWith("spawned by "));
const isFloated = (r) => r.where.some((w) => w.startsWith("floats "));
const spawnedCount = required.filter(isSpawned).length;
const floatedCount = required.filter(isFloated).length;
// COUNTED INDEPENDENTLY rather than as the remainder, so that the reconciliation below is able to fail.
// Written as `required.length - spawnedCount - floatedCount` the three always summed to the total whatever
// the classifier did, and a sum that cannot disagree checks nothing.
const directCount = required.filter((r) => !isSpawned(r) && !isFloated(r)).length;
const classCounts = { direct: directCount, spawned: spawnedCount, floated: floatedCount };
const sumProblem = classSumProblem(classCounts, required.length);
if (sumProblem !== null) die(2, `cannot check: ${sumProblem}.`);

// The subject each class's leg found, which is what decides a finding from a cannot-check.
const classSources = { direct: direct.size, spawned: globCandidates, floated: outsideTestDerived };
// WHAT AN EMPTY SUBJECT MEANS FOR EACH CLASS, in words, because "no subject at all" has two shapes for the
// spawned leg and the operator has to be told which one happened: no region was opened, or a region was
// opened and the pattern matched nothing in it. Naming the wrong one sends somebody looking for a spawner
// that is sitting there working.
const BLIND_DETAIL = {
  direct: () => `the derivation matched ${direct.size} directly-invoked script path(s)`,
  spawned: () =>
    globSpawners === 0
      ? "no entry point resolved to an enumerable glob spawn at all, so no directory was opened and no child could be matched"
      : `${globSpawners} glob spawner(s) resolved and their directories were opened, and the extension filter this gate read out of their source matched NO file in them. The region resolved and the pattern matched nothing, which is not a smaller class: it is a leg that looked at nothing`,
  floated: () => `the float leg read ${outsideTestDerived} derived entry point(s) outside test/`,
};
const popMoved = populationProblems(classCounts);
const verdict = populationVerdict(popMoved, classSources);
if (verdict.code === 2) {
  // Built from the BLIND classes rather than from the moved ones, because a leg with no subject is a
  // cannot-check whether or not its count moved. A class pinned at 0 whose leg has gone blind reports
  // 0 against 0 and moves nothing at all, and a fall-shaped message would have no words for that.
  const detail = verdict.blind
    .map((cls) => `${cls} reported ${classCounts[cls] ?? 0} against ${POPULATION_BASELINE[cls] ?? 0} pinned, over a leg that found no subject at all (${BLIND_DETAIL[cls] === undefined ? "no subject measurement is described for this class" : BLIND_DETAIL[cls]()})`)
    .join("; ");
  die(
    2,
    `cannot check: ${verdict.blind.length} class(es) of the derived population rest on nothing: ${detail}. This is not a tree that changed: it is a leg of this gate that stopped reaching its subject, so the number it reported is not a measurement and the rest is not a pass. Find what stopped being derived before touching POPULATION_BASELINE.`,
  );
}

/**
 * enrolmentOf is the enrolment decision, in one place so --self-test can attack it directly rather than
 * only through a twenty-second gate run over the real tree. A gate whose subject is clean cannot show
 * that its rule works; a fixture that is dirty can.
 */
function enrolmentOf(code) {
  return { imports: code.includes("verdict-guard.ts"), declares: /verdict(?:Reached|Skipped)\s*\(/.test(code) };
}

// ---- the two findings --------------------------------------------------------------------------------
const unenrolled = [];
const cannotFail = [];
for (const r of required) {
  const { imports, declares } = enrolmentOf(r.code);
  if (!imports || !declares) unenrolled.push({ ...r, imports, declares });
  if (!ANY_FAILURE_PATH.test(r.code)) cannotFail.push(r);
}

// The breakdown is printed rather than a single total, because the total moved from 188 to 214 when the
// two leaked classes came in and a bare number would not say which leg carried the change. Each of these
// three numbers is now compared against POPULATION_BASELINE above rather than only printed.
console.log(`verdict-guard-gate: ${direct.size} directly-invoked scripts derived, ${required.length} entry points required to declare a verdict`);
console.log(`  of those: ${directCount} directly-invoked validators under test/, ${spawnedCount} spawned by a glob spawner, ${floatedCount} outside test/ floating an async bottom line`);
console.log(`  guard module: ${GUARD_REL} present with its exit hook intact`);
console.log(`  not treated as validators (no validate- name, no assertion output, no tally): ${skippedNotValidator.length}${skippedNotValidator.length ? ` (${skippedNotValidator.join(", ")})` : ""}`);

let bad = 0;
if (popMoved.length > 0) {
  bad += popMoved.length;
  console.log(`\n  ${popMoved.length} class(es) of the derived population no longer match the pin in this file:`);
  // NOT "so it did have a subject", which was a positive claim the gate is not entitled to make. What the
  // routing knows is the size of the candidate set the leg enumerated, and that being non-zero is why this
  // is a finding rather than a cannot-check. Whether those candidates are the RIGHT ones is the very
  // question the paragraph below asks the operator to settle, so the number is reported and no more.
  for (const x of popMoved) console.log(`    ${x.cls}: ${x.got} derived, ${x.expected} pinned (${x.fell ? "fell" : "rose"}; the leg that derives it enumerated ${classSources[x.cls]} candidate(s) rather than none, which is why this is exit 1 and not exit 2)`);
  const fellHere = popMoved.filter((x) => x.fell);
  if (fellHere.length > 0) {
    // NOT "these files were checked", because in one reading of a fall they were not. A class can fall
    // because the tree changed under a leg that still works, which is a stale pin, or because the leg
    // stopped recognising the shape, which no leg can detect about itself. Both are findings and neither
    // is a pass, and the operator is asked which rather than told.
    console.log(`\n  ${fellHere.length} of those FELL while the leg that derives them still had a subject to read,`);
    console.log(`  so this is a finding rather than a cannot-check. Two things produce it and they are not`);
    console.log(`  the same: the tree changed under a leg that still works, which is a stale pin, or the leg`);
    console.log(`  stopped recognising the shape it looks for, which is a defect in this file. Settle which`);
    console.log(`  before re-pinning. A file moving BETWEEN classes shows up here as one fall and one rise`);
    console.log(`  leaving the graded total unchanged, and that total is ${required.length}.`);
  }
  console.log(`\n  Once that is settled, POPULATION_BASELINE no longer says what the tree holds, and a pin`);
  console.log(`  left behind stops being able to see a class fall. Replace it with:`);
  console.log(`    const POPULATION_BASELINE = { direct: ${directCount}, spawned: ${spawnedCount}, floated: ${floatedCount} };`);
  // The remedy below is one an operator can actually apply: the --self-test fixtures are generated from this
  // pin, so a class pinned at 0 keeps the arms that still apply to it and drops the fall it no longer has,
  // and applying this replacement line does not by itself redden the self-test.
  console.log(`  That line is the whole edit. The --self-test fixtures are generated from this pin, so they`);
  console.log(`  move with it and no fixture in this file needs touching; run npm run lint:verdict-guard,`);
  console.log(`  which runs --self-test first, to see both halves green. If a fixture does need editing to`);
  console.log(`  get green, that is a finding about this gate and not a step in re-pinning it.`);
}
if (cannotFail.length) {
  bad += cannotFail.length;
  console.log(`\n  ${cannotFail.length} validator entry point(s) have NO failure path at all, so they cannot fail for any reason:`);
  for (const r of cannotFail) console.log(`    ${r.path}  (invoked by ${r.where.join(", ")})`);
}
if (unenrolled.length) {
  bad += unenrolled.length;
  console.log(`\n  ${unenrolled.length} validator entry point(s) are NOT enrolled in the completion guard:`);
  for (const r of unenrolled) {
    const why = !r.imports ? `does not import ${GUARD_REL}` : "imports the guard but never declares a verdict";
    console.log(`    ${r.path}  ${why}  (invoked by ${r.where.join(", ")})`);
  }
  console.log(`\n  Enrol each one with two lines: import { verdictReached } from "<rel>/lib/verdict-guard.ts";`);
  console.log(`  and verdictReached(<failureCount>); immediately before the tally that decides the exit code.`);
  console.log(`  A validator that cannot run its checks declares verdictSkipped(<reason>) instead, which is`);
  console.log(`  also enrolment: a skip is a verdict, and an undeclared skip is the same silent exit 0.`);
}

if (bad > 0) {
  console.log(`\nVERDICT GUARD GATE: ${bad} finding(s)`);
  process.exit(1);
}
console.log(`\nVERDICT GUARD GATE PASS (${required.length} validator entry points, all enrolled, all able to fail)`);
