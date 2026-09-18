// Both directions on the two sibling-lag statements added to scripts/stepup-call-site-gate.mjs and
// scripts/harness-pin-gate.mjs, with the graded content held constant.
//
// WHY IT EXISTS. Measured from a worktree beside the shared workspace checkouts:
// stepup-call-site-gate printed "engine at <workspace>/engine, 41 gated routes"
// and exited 0 against an engine 12 commits behind its own origin/main, and harness-pin-gate exited 0
// having checked "452 distinct data-dp pin(s) ... in 1114 harness file(s)" against a harness checkout 35
// commits behind. Neither named the tree. Run against those siblings' own origin/main in the same minute,
// stepup read the identical 41 routes and harness-pin read 1116 files: the second number moved and nothing
// in the output could tell a reader that it had.
//
// THE ISOLATION IS THE POINT. In every pair below the fixture's working tree is byte-identical between the
// two runs. The only thing that moves is where refs/remotes/origin/main points. So a number or an exit code
// that moves can only be the statement under test. A guard that cannot distinguish the two is decoration.
//
// THE FIXTURES ARE GENERATED, and that is not a convenience. A first draft of the field-catalogue guard's
// proof copied its input out of a real sibling and SKIPPED when there was none, which meant it skipped in
// the Validators job, the one job that checks console out ALONE. Generating the input removes the skip and
// removes the sibling resolution that scripts/sibling-resolution-gate.mjs would refuse as a guess.
//
// WHAT EACH HALF PROVES, because the two gates were given DIFFERENT postures on purpose.
//
//   stepup-call-site-gate REFUSES a stale engine, exit 2, because the sibling supplies the SPECIFICATION
//   (STEPUP_SUBS) rather than the subject, and a route the engine has started gating since the checkout
//   leaves the console POST to it unscored and unmentioned. So both an exit code and a line are asserted.
//
//   harness-pin-gate REPORTS, because every finding it prints is a named pin at a named file:line in the
//   sibling that a reader can open. So the LINE is what is asserted, in three states, including that it
//   prints ahead of a refusal the gate makes for an unrelated reason. A statement that only appears on the
//   happy path is not a statement a reader can rely on.
//
// FS-WRITES: none outside this repo

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts
import { makeChecks } from "./validate-checks.ts";

const CONSOLE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STEPUP_GATE = join(CONSOLE_ROOT, "scripts", "stepup-call-site-gate.mjs");
const PIN_GATE = join(CONSOLE_ROOT, "scripts", "harness-pin-gate.mjs");
const c = makeChecks();

/** git in a fixture repo, quiet, throwing on any non-zero exit. */
const git = (repo: string, ...args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/**
 * Commit the fixture, add a LATER commit that touches nothing the gate reads, then check the earlier tree
 * back out. `older` is what both runs grade; `newer` is what origin/main is pointed at to make the checkout
 * look stale without changing one byte the gate reads.
 */
function twoCommits(repo: string): { older: string; newer: string } {
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "selftest@example.invalid");
  git(repo, "config", "user.name", "self test");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "the tree both runs grade");
  const older = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "LATER.md"), "a later commit that touches nothing either gate reads\n");
  git(repo, "add", "LATER.md");
  git(repo, "commit", "-q", "-m", "a later commit");
  const newer = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", older);
  return { older, newer };
}

const run = (gate: string, env: Record<string, string>): { code: number; out: string } => {
  const r = spawnSync(process.execPath, [gate], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

const ws = mkdtempSync(join(tmpdir(), "sibling-lag-statements-"));

// ---- The engine fixture -------------------------------------------------------------------------------
//
// Faithful to the two shapes the gate parses and to its own three parse controls: STEPUP_SUBS must hold at
// least 20 members, must contain /keys/rotate and /roles/delete, and must NOT contain
// /notify/test. The two real console call sites for those routes (client-keys.ts and
// client-rbac.ts) are what carry the current direction past the zero-numerator floor, and they are read out
// of THIS repo, so nothing here resolves a sibling.
const engineRepo = join(ws, "engine");
const engineAdmin = join(engineRepo, "src", "admin");
mkdirSync(engineAdmin, { recursive: true });
const fillerSubs = Array.from({ length: 22 }, (_, i) => `  "/fixture/sub-${String(i).padStart(2, "0")}",`).join("\n");
writeFileSync(
  join(engineAdmin, "router-core.ts"),
  `export const STEPUP_SUBS: Set<string> = new Set([\n  "/keys/rotate",\n  "/roles/delete",\n${fillerSubs}\n]);\n`,
  "utf8",
);
writeFileSync(
  join(engineAdmin, "router.ts"),
  [
    'if (parsed.action === "approve") {',
    "  await requireStepUp(req);",
    "}",
    'if (other.action === "approve") {',
    "  await requireStepUp(req);",
    "}",
    "",
  ].join("\n"),
  "utf8",
);
const engine = twoCommits(engineRepo);

console.log("\n-- stepup-call-site-gate, both directions against one engine tree --\n");

// 1. STALE: origin/main one commit ahead of the tree on disk.
git(engineRepo, "update-ref", "refs/remotes/origin/main", engine.newer);
const stepupStale = run(STEPUP_GATE, { DOWNPIPES_ENGINE: engineRepo });
c.eq("an engine behind its own origin/main is REFUSED, exit 2", stepupStale.code, 2);
c.has("and the refusal names the lag as a number", stepupStale.out, "1 commit(s) behind its own origin/main");
c.has("and the tree line names the checkout it read", stepupStale.out, "STEP-UP CALL-SITE GATE: tree graded: engine at");
// git's own abbreviation length, which is what scripts/sibling-staleness.mjs asks for. Seven characters
// rather than eight, so a wider slice here would fail on a line that is correct.
c.has("and the tree line carries that checkout's HEAD", stepupStale.out, engine.older.slice(0, 7));
c.lacks("and no gated-route count is printed against the old tree", stepupStale.out, "gated routes");

// 2. The named hatch, and only that name.
const stepupAllowed = run(STEPUP_GATE, { DOWNPIPES_ENGINE: engineRepo, STEPUP_ALLOW_STALE_ENGINE: "1" });
c.eq("STEPUP_ALLOW_STALE_ENGINE=1 grades the old tree anyway", stepupAllowed.code, 0);
c.has("and still says how old it is, so the hatch is not a silencer", stepupAllowed.out, "1 commit(s) behind its own origin/main");
const stepupWrongHatch = run(STEPUP_GATE, { DOWNPIPES_ENGINE: engineRepo, FIELD_CATALOGUE_ALLOW_STALE: "1" });
c.eq("another gate's hatch does NOT open this one", stepupWrongHatch.code, 2);

// 3. CURRENT: the same bytes, the same commit, origin/main pointing at it.
git(engineRepo, "update-ref", "refs/remotes/origin/main", engine.older);
const stepupCurrent = run(STEPUP_GATE, { DOWNPIPES_ENGINE: engineRepo });
c.eq("the SAME content at a current engine grades, exit 0", stepupCurrent.code, 0);
c.has("and says 0 behind rather than saying nothing", stepupCurrent.out, "0 commit(s) behind its own origin/main");
c.has("and reaches the call-site scoring it exists for", stepupCurrent.out, "24 gated routes");
// Not a count: the number of real console POSTs to /keys/rotate and /roles/delete is this repo's business
// and moves with ordinary work, so pinning it here would make an unrelated console change red this proof.
// What must hold is that the scoring ran at all and found nothing on the ungated path.
c.has("and scores the real console POSTs to those routes", stepupCurrent.out, "POST call sites hitting a gated route:");
c.has("with none of them on plain engineFetch", stepupCurrent.out, "through plain engineFetch:             0");

// 4. UNRESOLVABLE is its own state and is never rendered as zero, because zero is what a current checkout
//    looks like. This is the state a pinned or archive-extracted checkout leaves.
git(engineRepo, "update-ref", "-d", "refs/remotes/origin/main");
const stepupUnknown = run(STEPUP_GATE, { DOWNPIPES_ENGINE: engineRepo });
c.has("a checkout with no origin/main says lag UNKNOWN", stepupUnknown.out, "lag UNKNOWN");
c.lacks("and does not claim 0 commits behind", stepupUnknown.out, "0 commit(s) behind");
c.eq("and is graded rather than refused, because unanswerable is not a finding", stepupUnknown.code, 0);

// ---- The harness fixture ------------------------------------------------------------------------------
//
// harness-pin-gate REPORTS, so what is under test is the LINE rather than an exit code, in three states.
// The fixture deliberately does not reproduce the gate's real corpus: its floors want 300 distinct pins
// across 700 sites, and manufacturing those would mean re-implementing the gate's own hook extraction in
// the test, which is the parallel-implementation shape R-30 records. It stops at the corpus floor instead,
// with exit 2, and that is the sharper property to assert: the tree line prints AHEAD of a refusal the gate
// makes for an unrelated reason, so it is present whatever the verdict.
const harnessRepo = join(ws, "harness");
mkdirSync(join(harnessRepo, "spec"), { recursive: true });
mkdirSync(join(harnessRepo, "lib"), { recursive: true });
writeFileSync(join(harnessRepo, "spec", "fixture.spec.ts"), 'export const pin = \'[data-dp="fixture.pin"]\';\n', "utf8");
writeFileSync(join(harnessRepo, "lib", "fixture.ts"), "export const n = 1;\n", "utf8");
const harness = twoCommits(harnessRepo);

console.log("\n-- harness-pin-gate, the lag line in three states against one harness tree --\n");

git(harnessRepo, "update-ref", "refs/remotes/origin/main", harness.newer);
const pinStale = run(PIN_GATE, { DOWNPIPES_HARNESS: harnessRepo });
c.has("a harness behind its own origin/main is named with its lag", pinStale.out, "1 commit(s) behind its own origin/main");
c.has("and the line names the checkout and its HEAD", pinStale.out, `[harness-pin-gate] tree graded: harness at ${harnessRepo}`);
c.has("and the line prints AHEAD of the corpus-floor refusal", pinStale.out, "too few to judge against");
c.eq("which is exit 2, could not check, not a finding", pinStale.code, 2);

git(harnessRepo, "update-ref", "refs/remotes/origin/main", harness.older);
const pinCurrent = run(PIN_GATE, { DOWNPIPES_HARNESS: harnessRepo });
c.has("the SAME content at a current harness reads 0 behind", pinCurrent.out, "0 commit(s) behind its own origin/main");
c.lacks("and does not claim a lag it does not have", pinCurrent.out, "1 commit(s) behind");

git(harnessRepo, "update-ref", "-d", "refs/remotes/origin/main");
const pinUnknown = run(PIN_GATE, { DOWNPIPES_HARNESS: harnessRepo });
c.has("and a checkout with no origin/main says UNKNOWN rather than 0", pinUnknown.out, "lag UNKNOWN");
c.lacks("so a missing ref cannot impersonate a current one", pinUnknown.out, "0 commit(s) behind");

rmSync(ws, { recursive: true, force: true });

console.log(c.failures === 0 ? "\nSIBLING-LAG STATEMENTS PASS\n" : `\nSIBLING-LAG STATEMENTS: ${c.failures} FAILED\n`);
verdictReached(c.failures);
process.exit(c.failures === 0 ? 0 : 1);
