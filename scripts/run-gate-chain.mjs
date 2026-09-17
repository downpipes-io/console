#!/usr/bin/env node
// GATE CHAIN RUNNER: run every member of a gate chain, then report every failure.
//
// FS-WRITES: none outside this repo
//
// WHY THIS EXISTS HERE, measured on this repo rather than inherited from the two siblings that already
// carry it. `npm run validate` is a single `&&` chain of 175 members, `npm run lint` of 36, and
// `npm run validate:workspace:chain` of 27. `&&` stops at the first non-zero exit, which is right for a
// build and wrong for a gate suite: everything behind the stop is not "passing", it is UNKNOWN, and the
// chain reports the two the same way.
//
// THE COST, driven on this tree rather than argued. `npm run validate` exits 1 at member 77,
// test/validate-bundle.ts, and members 78 through 175 never run: 98 of 175 members, 56 per cent of the
// suite, in a chain that took 141 seconds to reach its stop. `npm run lint` exits 2 at member 7,
// validate:doc-links, and members 8 through 36 never run: 29 of 36, 81 per cent, after 20 seconds. Neither
// number is a wrong verdict. Both are a verdict over a population nobody established, printed as though it
// were a verdict over the whole.
//
// WHAT THIS ADDS THAT THE EXISTING GATES CANNOT SEE. scripts/validator-reachability-gate.mjs already fails
// on a validator no gating chain names, and that is a MEMBERSHIP claim. Membership is not execution: all 98
// of the members above are members in good standing, named by the chain, counted by that gate, and none of
// them ran. Ordering is invisible to a wiring gate by construction. This runner closes that, and it is the
// only thing here that can.
//
// NO DECLARED-RED TABLE, DELIBERATELY, and the search that settled it. The sibling implementation in
// ../harness carries one: a named member may be excused from gating if it has a written reason and an
// owner. Console has no chain-level equivalent to port it onto. Every exemption mechanism in this repo
// sits INSIDE a single gate and speaks only for that gate's own population: the per-file allowlists in
// innerhtml-sink-gate.mjs and capability-copy-gate.mjs, the burndown in field-bounds-gate.mjs, the EXEMPT
// map in validator-reachability-gate.mjs, and the eight *_ALLOW_STALE environment overrides. Not one of
// them is consulted between a member finishing and its exit code being read, which is the only position
// from which the harness defect below can occur.
//
// THAT DEFECT, and why an empty design forecloses it rather than merely avoiding it. The harness copy
// asked whether a member was declared BEFORE it asked what the member's code meant, so a declared member
// that exited 2 was filed as "declared red, not gating" and the whole chain went green over an instrument
// that had answered nothing. A declaration accepts a KNOWN red. A refusal means nobody has looked at
// anything, so there is nothing to have accepted. Classification therefore has to run first. Here there is
// no table to run it before, and adding an excusing mechanism with nothing to excuse is how the first
// entry gets written for convenience. If console ever needs one, the order in the loop below is the part
// to copy and the harness header is the record of what it costs to get wrong.
//
// ANTI-VACUITY. Exit 2 rather than 0 when this runner cannot actually check anything: no chain named, no
// package.json, no such script, a script that is present but blank, or a chain that splits to fewer than
// the floor. A runner that cannot fail on an empty input is not a gate, and the whole reason this file
// exists is that a chain reported a result over work it had not done.
//
// WHAT THIS RUNNER'S OWN EXIT CODE MEANS, and why a refusal outranks a finding. The convention in this
// repo is 0 clean, 1 a finding, 2 could-not-check, with 2 reserved for the instrument being unable to
// answer rather than for a question it declines to treat as its own. scripts/verdict-guard-gate.mjs works
// that distinction out at length for one gate; this file applies it to a chain of them.
//
// PRECEDENCE. Any refusal makes the chain refuse. Failing that, any finding makes the chain report a
// finding. Failing both, the chain is clean. The argument is about what a reader is entitled to conclude
// from the code alone. Exit 1 licenses the reading "every member graded its subject, and what follows is
// the complete set of violations". That reading is false as soon as one member could not grade its
// subject, because the set is then drawn from a population nobody established. Exit 2 licenses no reading
// at all, which is the honest answer when part of the sweep did not happen. The opposite precedence would
// turn an unknown into a known, which is the defect this file exists to catch one level up.
//
// Nothing is lost by choosing that way round. A finding under a refusing chain is still printed with its
// exit code beside the member that produced it, and both codes are non-zero, so neither reads as a green.
//
// THE CHAIN STILL RUNS EVERY MEMBER after one has refused, and that is deliberate rather than an
// oversight. Stopping at a refusal is what `&&` already did, and the 98 unrun members above are the
// measured cost of it. A refusal changes the verdict, not the sweep.
//
// NO MEMBER OF THE THREE CHAINS HERE IS UNSAFE TO RUN BEHIND A FAILING NEIGHBOUR, and that was checked
// rather than assumed, because it is the one thing that would make this change worse than the disease.
// The check is the repo's own: every file under scripts/ and test/ that calls a filesystem write carries a
// `// FS-WRITES:` declaration, enforced by scripts/outside-write-gate.mjs. Read across all three chains,
// exactly one member resolves to a file declaring a write that leaves this checkout,
// `npm run field:gate` -> scripts/field-census.mjs, and that member drives it with
// `--out node_modules/.cache/field-census.jsonl`; the census refuses to touch internal-docs without
// `--write-internal-docs`, which no chain passes. Nothing else in the three chains deploys, pushes,
// mutates a sibling repository or depends on an artefact an earlier member produced.
//
// A CODE THE MEMBER DID NOT CHOOSE IS ALSO A REFUSAL. A member killed by a signal, or reported by the
// shell as 127 not found or 126 not executable, never reached a verdict of its own. Reading those as
// findings is the same mistake in a worse place, because a renamed or deleted gate script would then come
// back as "violations found". One case this cannot reach: `npm run <missing-script>` is reported by npm as
// exit 1, so a member whose npm script has gone still reads as a finding. The floor is what covers that
// shape.
//
// MEASURED, because the whole fix depends on it: 47 of the 238 members across the three chains are an
// `npm run` (2 of validate's 175, all 36 of lint, 9 of the workspace chain's 27), and npm propagates its
// child's exit code unchanged, so a gate that exits 2 arrives here as 2 rather than as npm's own 1. Both
// directions are driven in the self-test below against this repo's npm.
//
// THE FLOOR IS A REQUIRED ARGUMENT, per chain, with no default. That is engine's shape rather than
// harness's constant, and the reason is this repo: three chains of 175, 36 and 27 members have no single
// figure between them, and a default would silently apply the wrong number to whichever chain was wrapped
// next. It is not a target, it is a tripwire for the chain being gutted by a bad merge, a truncated edit
// or a script rename, and this runner then reporting a confident PASS over the remnant. A floor equal to
// the count costs one number per intentional removal and nothing at all for an addition, which is the
// common direction.
//
// Usage: node scripts/run-gate-chain.mjs <script-name> <min-members>
//        node scripts/run-gate-chain.mjs --self-test
//
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isEntryModule } from "./entry-module.mjs";

const TAG = "[gate-chain]";
const CANNOT_RUN = 2;
const FOUND_SOMETHING = 1;
const CLEAN = 0;
const ROOT = process.cwd();

// MEMBER_CAP_MS is the hard wall-clock cap on ONE member, after which it is killed and reported as a
// refusal. Without it this runner waits forever on a member that does not exit, and the whole chain waits
// with it.
//
// A member can print a passing verdict and then hang: it can print `VERDICT: PASS failures=0` and then
// hold the event loop open on an uncancelled timer in code it drives, well past when its own checks
// finished. scripts/deploy.sh runs `npm run typecheck && npm run validate && npm run lint` as a blocking
// preflight under `set -e`, so a hang here stops the published `npm run deploy` a customer follows with no
// output, no progress and no timeout. It does not fail. That is the worse outcome, because a customer
// cannot tell a hang from a slow step, and the only thing on screen was a member that had already said
// PASS.
//
// A HANG IS A REFUSAL, NOT A FINDING, and it is the same argument the header makes for exit 127 and for a
// signal: a member that never exited has not told this runner that it graded its subject. It may have
// printed a verdict, and that verdict may even be true about its checks, but it is not a statement about
// the member ending, and the chain's own exit code is downstream of every member ending. Exit 2 licenses
// no reading, which is the honest answer.
//
// FIFTEEN MINUTES, sized against the slowest member that genuinely exits, measured rather than guessed.
// A cap that fires on a healthy member is a FALSE HANG, and a false hang in a deploy preflight is worse
// than the defect it was added for: it would kill a passing gate and report a customer's own tree as
// broken. The slowest real member across either chain is engine's `npm run test:runtime`, a whole nested
// suite behind one chain member, which exits 0 in around 305 seconds.
//
// Fifteen minutes is about three times that, so nothing healthy can approach it, and it still turns an
// unbounded wait into a bounded one.
//
// THE ONE OVERRIDE CAN ONLY TIGHTEN IT, and that is what makes it safe to have at all. GATE_CHAIN_CAP_MS
// is clamped to at most the ceiling below, so setting it can only cause MORE members to be reported as not
// exiting, never fewer. The abuse this forecloses is the one every knob here would otherwise invite: a
// member starts hanging, and the cap is raised to make the red go away, at exactly the moment the cap is
// doing its job. It exists because the self-test below has to drive a member that genuinely never exits,
// and waiting five minutes to prove a cap works is its own way of never running the proof.
const MEMBER_CAP_CEILING_MS = 900_000;
const MEMBER_CAP_MS = (() => {
  const raw = process.env.GATE_CHAIN_CAP_MS;
  if (raw === undefined || raw === "") return MEMBER_CAP_CEILING_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return MEMBER_CAP_CEILING_MS;
  return Math.min(n, MEMBER_CAP_CEILING_MS);
})();

// Classify one finished member against the 0/1/2 convention. EXIT 1 IS THE ONLY FINDING. Everything
// non-zero that is not exactly 1 is a refusal, including codes outside the convention altogether. That is
// the precedence argument in the header applied one level smaller: a member that answered 3, or was never
// started, or was killed, has not told this runner that it graded its subject, and inventing the claim
// that it did is exactly the move being closed. Both classes are non-zero, so the cost of being wrong in
// this direction is a red reported under the wrong red, and the cost of being wrong in the other direction
// is an ungraded subject reported as a graded one.
/** @param {{error?: Error & {code?: string}, signal?: string|null, status?: number|null}} r */
function classify(r) {
  // A MEMBER THAT NEVER EXITED IS TESTED FIRST, and it is named rather than swept into the generic spawn
  // failure below, because the two are opposite states: a member that could not be spawned did nothing at
  // all, and a member that did not exit may well have printed a full green verdict before it stopped. The
  // reader needs to know the verdict on screen is real AND that the process behind it never ended, and
  // "could not be spawned" would say the opposite of both.
  if (r.error && /** @type {any} */ (r.error).code === "ETIMEDOUT") {
    return { kind: "refused", code: CANNOT_RUN, why: `did not exit within ${MEMBER_CAP_MS / 1000}s and was killed, so it never reached a verdict this runner could read (any verdict it printed is about its checks, not about it ending)` };
  }
  if (r.error) return { kind: "refused", code: CANNOT_RUN, why: `could not be spawned (${r.error.message})` };
  if (r.signal) return { kind: "refused", code: 128, why: `was killed by ${r.signal} before reaching a verdict` };
  if (typeof r.status !== "number") return { kind: "refused", code: CANNOT_RUN, why: "ended without an exit status this runner can read" };
  if (r.status === 0) return { kind: "pass", code: 0, why: "passed" };
  if (r.status === FOUND_SOMETHING) return { kind: "found", code: 1, why: "exited 1, which is a finding" };
  if (r.status === CANNOT_RUN) return { kind: "refused", code: 2, why: "exited 2, which is could-not-check" };
  if (r.status === 127) return { kind: "refused", code: 127, why: "was not found by the shell, so it graded nothing" };
  if (r.status === 126) return { kind: "refused", code: 126, why: "was not executable, so it graded nothing" };
  return { kind: "refused", code: r.status, why: `exited ${r.status}, which is outside the 0/1/2 convention, so whether it graded anything is unknown` };
}

/** @param {string[]} argv */
function main(argv) {
  const chain = argv[0];
  const minMembers = Number(argv[1]);
  if (!chain || !Number.isInteger(minMembers) || minMembers < 1) {
    console.error(`::error::${TAG} usage: node scripts/run-gate-chain.mjs <script-name> <min-members>. The floor is required so a gutted chain cannot pass. Exit ${CANNOT_RUN}.`);
    return CANNOT_RUN;
  }
  const pkgPath = join(ROOT, "package.json");
  if (!existsSync(pkgPath)) {
    console.error(`::error::${TAG} no package.json at ${pkgPath}, so there is no chain to run. Exit ${CANNOT_RUN}.`);
    return CANNOT_RUN;
  }
  const scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {};
  if (!scripts[chain]) {
    console.error(`::error::${TAG} package.json has no "${chain}" script, so the chain this runner is meant to drive has vanished rather than passed. Exit ${CANNOT_RUN}.`);
    return CANNOT_RUN;
  }
  const members = String(scripts[chain])
    .split("&&")
    .map((s) => s.trim())
    .filter(Boolean);
  if (members.length < minMembers) {
    console.error(`::error::${TAG} "${chain}" splits to only ${members.length} member(s), under the floor of ${minMembers}. A sweep this small has not proven what a full chain proves. Exit ${CANNOT_RUN}.`);
    return CANNOT_RUN;
  }

  /** @type {{m: string, code: number, i: number, why: string}[]} */
  const refused = [];
  /** @type {{m: string, code: number, i: number, why: string}[]} */
  const found = [];
  let ran = 0;
  const started = Date.now();
  // The cap is ANNOUNCED before the first member runs, so a person watching a long chain (or a customer
  // watching `npm run deploy`, which blocks on this) can tell a slow member from one that will be killed,
  // and so the cap in force is a fact on the transcript rather than a constant a reader has to go and look
  // up in this file.
  console.log(`${TAG} running ${members.length} member(s) of "${chain}", each capped at ${MEMBER_CAP_MS / 1000}s.`);

  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const t0 = Date.now();
    // SIGKILL rather than the default SIGTERM: the member being killed is one that is not making progress,
    // and a handler that swallows SIGTERM would leave this runner waiting on the very process it just gave
    // up on. stdio stays "inherit", so a capped member's own output is already on screen when the cap fires.
    //
    // detached: true, and the group-kill straight after, close a hang that killing the shell process alone
    // does not. `shell: true` spawns `/bin/sh -c m`, and on a runner where /bin/sh is dash, dash does NOT
    // exec-replace itself with a trailing simple command the way this repo's workstation shell does:
    // `dash -c "node -e ..."` forks node as a real child and waits on it. spawnSync's own timeout
    // kill signals only the shell's own pid, so when the member is a process that forks something which
    // never exits (this file's own hanging-member self-test arm, deliberately, and any real member that
    // backgrounds a process), killing the shell leaves that grandchild alive as an orphan. It keeps this
    // process's inherited stdout fd open, and anything reading this runner's output as a pipe -- the
    // self-test's own capture below, or a CI step capturing the job's stdout -- then blocks on a read that
    // never reaches EOF, which is indistinguishable from the runner itself hanging. `detached: true` makes
    // the shell the leader of its own process group, so the whole group can be swept with one negative-pid
    // kill regardless of how spawnSync's own timeout resolved. It runs unconditionally because it is cheap
    // and safe: ESRCH, when the member exited cleanly and left nothing behind, is the common case and is
    // silently ignored.
    // @types/node's SpawnSyncOptions omits `detached`, which is typed only on the async SpawnOptions,
    // even though the underlying libuv call spawnSync shares with spawn honours it identically (confirmed
    // empirically above: this is the option that makes the whole fix work). The intersection cast says so
    // rather than silently widening to `any`.
    /** @type {import("node:child_process").SpawnSyncOptions & { detached?: boolean }} */
    const spawnOpts = { shell: true, stdio: "inherit", cwd: ROOT, timeout: MEMBER_CAP_MS, killSignal: "SIGKILL", detached: true };
    const r = spawnSync(m, spawnOpts);
    if (r.pid) {
      try {
        process.kill(-r.pid, "SIGKILL");
      } catch {
        // the process group is already gone, which is what a member that exited cleanly leaves behind.
      }
    }
    const v = classify(r);
    ran++;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const entry = { m, code: v.code, i: i + 1, why: v.why };
    if (v.kind === "pass") {
      console.log(`${TAG} ${i + 1}/${members.length} PASS ${secs}s  ${m}`);
    } else if (v.kind === "refused") {
      refused.push(entry);
      console.log(`${TAG} ${i + 1}/${members.length} REFUSED exit=${v.code} ${secs}s  ${m}`);
    } else {
      found.push(entry);
      console.log(`${TAG} ${i + 1}/${members.length} FAIL exit=${v.code} ${secs}s  ${m}`);
    }
  }

  const wall = ((Date.now() - started) / 1000).toFixed(0);

  // THE FLOOR IS GRADED AGAINST WHAT RAN, not only against what was counted. The count above already
  // decides whether the chain is long enough; this compares that count with the number of members that
  // actually reached a verdict, so a loop that ever gained an early exit could not go on satisfying a
  // floor it no longer earns. The two are equal by construction today and this is what keeps them so.
  if (ran !== members.length) {
    console.error(`::error::${TAG} "${chain}" counted ${members.length} member(s) but only ${ran} reached a verdict. A floor met by a count the sweep did not honour proves nothing. Exit ${CANNOT_RUN}.`);
    return CANNOT_RUN;
  }
  console.log(`\n${TAG} ${members.length} member(s) of "${chain}" all RUN in ${wall}s. Not one was skipped behind a failing neighbour.`);

  // The per-member annotations come out before the verdict and name the member either way, so the operator
  // learns which member produced which code no matter which of the two codes the chain settles on.
  for (const { m, code, i, why } of refused) {
    console.error(`::error::${TAG} member ${i} REFUSED exit=${code}: ${m} (${why})`);
  }
  for (const { m, code, i, why } of found) {
    console.error(`::error::${TAG} member ${i} FAILED exit=${code}: ${m} (${why})`);
  }

  if (refused.length > 0) {
    console.error(`${TAG} ${refused.length} member(s) of "${chain}" COULD NOT CHECK and ${found.length} found something, across ${members.length} member(s).`);
    const partial =
      found.length > 0
        ? `The ${found.length} finding(s) above are real, but they were gathered over a part of the population rather than all of it.`
        : "No member reported a finding, and that is not a clean result either, because part of the population was never graded.";
    console.error(`::error::${TAG} this chain is NOT a grade. At least one member could not establish its own subject. ${partial} Exit ${CANNOT_RUN}, not ${FOUND_SOMETHING}.`);
    return CANNOT_RUN;
  }
  if (found.length > 0) {
    console.error(`${TAG} ${found.length} failure(s) across ${members.length} member(s) of "${chain}". Every member graded its subject. Exit ${FOUND_SOMETHING}.`);
    return FOUND_SOMETHING;
  }
  console.log(`${TAG} PASS: every member of "${chain}" ran, graded its subject, and none failed.`);
  return CLEAN;
}

// ---- the negative control -------------------------------------------------------------------------
//
// EVERY ARM RUNS THIS FILE AS A CHILD PROCESS against a package.json built for the arm, so the whole of
// main() is on the path the self-test drives: the argument read, the floor read, the package.json read,
// the member split, the floor comparison, the spawn loop, the accumulation of both classes and the exit.
// A mutation anywhere in main() is reachable by construction.
//
// THE EXIT CODE IS READ OFF THE CHILD PROCESS, from spawnSync's own status field, never from a pipe and
// never from a shell that ran something else afterwards. That is the trap this whole file is about, one
// level down.
//
// The members are `node -e ...` rather than shell builtins so the arms behave the same on any runner.

/**
 * A chain of `count` members, of which the named 1-based positions exit 1.
 * @param {string} label @param {number} count @param {number[]} failAt
 */
function chainOf(label, count, failAt = []) {
  const members = [];
  for (let i = 1; i <= count; i++) {
    members.push(failAt.includes(i) ? `node -e "console.log('${label}-${i} red');process.exit(1)"` : `node -e "console.log('${label}-${i} green')"`);
  }
  return members.join(" && ");
}

/**
 * A chain of `count` passing members with named positions replaced by an arbitrary command, so an arm can
 * drive a code the 0/1/2 convention does not cover and shapes the shell chooses rather than the member.
 * @param {string} label @param {number} count @param {Record<number, string>} overrides
 */
function chainWith(label, count, overrides = {}) {
  const members = [];
  for (let i = 1; i <= count; i++) members.push(overrides[i] ?? `node -e "console.log('${label}-${i} green')"`);
  return members.join(" && ");
}

/** A member that exits with exactly `code`, announcing itself so an arm can prove it executed. */
function memberExiting(label, i, code) {
  return `node -e "console.log('${label}-${i} exit${code}');process.exit(${code})"`;
}

/**
 * A copy of this file with one text rewritten, so an arm can grade a rule whose trigger this loop does
 * not have. It is written INTO scripts/ rather than the scratch bed because this file imports
 * ./entry-module.mjs by relative path and a copy anywhere else would not resolve it. The name is unique
 * per run and the caller removes it in a finally.
 *
 * @param {string} find @param {string} replace
 */
function variantOf(find, replace) {
  const self = fileURLToPath(import.meta.url);
  const src = readFileSync(self, "utf8");
  if (!src.includes(find)) throw new Error(`the self-test cannot build its variant: the anchor is no longer in this file (${find.slice(0, 60)})`);
  const path = join(dirname(self), `.self-test-variant-${process.pid}-${Math.random().toString(36).slice(2, 8)}.mjs`);
  writeFileSync(path, src.replace(find, replace), "utf8");
  return path;
}

function selfTest() {
  let checks = 0;
  let failures = 0;
  /** @param {string} what @param {boolean} ok */
  const holds = (what, ok) => {
    checks++;
    if (ok) console.log(`  ok   ${what}`);
    else {
      failures++;
      console.log(`  FAIL ${what}`);
    }
  };
  const bed = mkdtempSync(join(tmpdir(), "console-gate-chain-selftest-"));
  const self = fileURLToPath(import.meta.url);
  /** @type {string[]} */
  const variants = [];
  /** @param {string} dir @param {string} name @param {unknown} scripts */
  const pkg = (dir, name, scripts) => {
    mkdirSync(join(bed, dir), { recursive: true });
    writeFileSync(join(bed, dir, "package.json"), `${JSON.stringify({ name, scripts }, null, 2)}\n`);
    return join(bed, dir);
  };
  /**
   * Run this file as a child and read its status OFF THE PROCESS.
   * @param {string[]} args @param {string} cwd @param {string} [script] @param {Record<string,string>} [extraEnv]
   */
  const run = (args, cwd, script = self, extraEnv = {}) => {
    const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...extraEnv } });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  // THE EXPECTED EXIT CODES ARE WRITTEN OUT rather than read from CANNOT_RUN and FOUND_SOMETHING. Grading
  // against the constant the gate itself uses makes the assertion compare the constant with itself: in the
  // sibling repos a mutant setting CANNOT_RUN to 0 moved the gate AND its expectation together and the
  // suite did not notice. Measured there, not supposed. Do not refactor these two back into the constants.
  const CANNOT = 2;
  const FOUND = 1;
  const OK = 0;

  try {
    // ---- the unmutated control, first, so a suite that is broken outright says so before it judges -----
    const green = pkg("green", "f", { validate: chainOf("g", 6) });
    const greenRun = run(["validate", "6"], green);
    holds("CONTROL: a six-member chain whose members all pass exits 0", greenRun.status === OK);
    holds("CONTROL: and it says every member ran", /6 member\(s\) of "validate" all RUN/.test(greenRun.out));
    holds("CONTROL: and every one of the six announced itself", [1, 2, 3, 4, 5, 6].every((i) => greenRun.out.includes(`g-${i} green`)));

    // ---- the deliberate non-zero control, proving this driver can report a failure at all -------------
    const red = pkg("driver-control", "f", { validate: chainOf("dc", 6, [3]) });
    const redRun = run(["validate", "6"], red);
    holds("CONTROL: a chain with one red member does NOT exit 0", redRun.status !== OK);
    holds("CONTROL: and the driver reads that non-zero status off the process", redRun.status === FOUND);

    // ---- finding only ---------------------------------------------------------------------------------
    const one = pkg("one-red", "f", { validate: chainOf("o", 6, [4]) });
    const oneRun = run(["validate", "6"], one);
    holds("one failing member makes the chain report a finding", oneRun.status === FOUND);
    holds("and the failing member is named", /member 4 FAILED exit=1/.test(oneRun.out));

    // The claim the runner exists to make: EVERY failure is reported, not the first. A runner that fell
    // back to `&&` semantics would stop at member 2 and never reach member 5.
    const two = pkg("two-red", "f", { validate: chainOf("t", 6, [2, 5]) });
    const twoRun = run(["validate", "6"], two);
    holds("two failing members both report a finding", twoRun.status === FOUND);
    holds("the first failure is named", /member 2 FAILED/.test(twoRun.out));
    holds("the member behind the first failure is named too", /member 5 FAILED/.test(twoRun.out));
    holds("the member behind the first failure actually executed", twoRun.out.includes("t-5 red"));
    holds("a member after a red one still executes", twoRun.out.includes("t-6 green"));

    // ---- refusal only, and the precedence over a finding ----------------------------------------------
    const ref = pkg("refusal", "f", { validate: chainWith("r", 6, { 4: memberExiting("r", 4, 2) }) });
    const refRun = run(["validate", "6"], ref);
    holds("a member that exits 2 makes the chain REFUSE rather than report a finding", refRun.status === CANNOT);
    holds("the refusing member is named as could-not-check", /member 4 REFUSED exit=2/.test(refRun.out));
    holds("and the chain says plainly that it is not a grade", /this chain is NOT a grade/.test(refRun.out));

    // Both orders, because a precedence that depended on which came first would pass one and fail the other.
    const fr = pkg("finding-then-refusal", "f", { validate: chainWith("fr", 6, { 2: memberExiting("fr", 2, 1), 5: memberExiting("fr", 5, 2) }) });
    const frRun = run(["validate", "6"], fr);
    holds("a finding at member 2 and a refusal at member 5 refuses", frRun.status === CANNOT);
    holds("the finding under a refusing chain is still named", /member 2 FAILED exit=1/.test(frRun.out));

    const rf = pkg("refusal-then-finding", "f", { validate: chainWith("rf", 6, { 2: memberExiting("rf", 2, 2), 5: memberExiting("rf", 5, 1) }) });
    const rfRun = run(["validate", "6"], rf);
    holds("a refusal at member 2 and a finding at member 5 refuses", rfRun.status === CANNOT);
    holds("the finding is still named under it", /member 5 FAILED exit=1/.test(rfRun.out));
    holds("the member behind the refusal still ran, so a refusal changes the verdict and not the sweep", rfRun.out.includes("rf-6 green"));

    // ---- a code the member did not choose --------------------------------------------------------------
    const nf = pkg("not-found", "f", { validate: chainWith("nf", 6, { 4: "definitely-not-a-real-command-xyzzy" }) });
    const nfRun = run(["validate", "6"], nf);
    holds("a member the shell cannot find (127) refuses", nfRun.status === CANNOT);
    holds("and 127 is reported as the member's own code", /REFUSED exit=127/.test(nfRun.out));

    const nx = pkg("not-executable", "f", { validate: chainWith("nx", 6, { 4: "./not-executable.sh" }) });
    writeFileSync(join(nx, "not-executable.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(nx, "not-executable.sh"), 0o644);
    const nxRun = run(["validate", "6"], nx);
    holds("a member that is not executable (126) refuses", nxRun.status === CANNOT);
    holds("and 126 is reported as the member's own code", /REFUSED exit=126/.test(nxRun.out));

    // `kill -9 $$` kills the member's own shell, so spawnSync reports a signal rather than a status.
    const sig = pkg("signal", "f", { validate: chainWith("k", 6, { 4: "kill -9 $$" }) });
    const sigRun = run(["validate", "6"], sig);
    holds("a member killed by a signal refuses", sigRun.status === CANNOT);
    holds("and the signal is named rather than translated into a finding", /was killed by SIGKILL/.test(sigRun.out));

    // ---- a member that never exits ----------------------------------------------------------------------
    // THE DEFECT THIS CAP EXISTS FOR, driven rather than argued. The planted member prints a green verdict
    // and THEN holds its event loop open on a timer far longer than any cap, which is the same shape a
    // hung member can take in this repo: output that says PASS from a process that never ends. Without the
    // cap, this arm would not fail; it would hang the self-test.
    const hangingMember = 'node -e "console.log(\'hang-4 green\');console.log(\'VERDICT: PASS failures=0\');setTimeout(()=>{},3600000)"';
    const hang = pkg("hanging-member", "f", { validate: chainWith("hang", 6, { 4: hangingMember }) });
    const hangRun = run(["validate", "6"], hang, self, { GATE_CHAIN_CAP_MS: "2000" });
    holds("a member that never exits refuses rather than being waited on", hangRun.status === CANNOT);
    holds("and it is reported as not having exited, not as a spawn failure", /did not exit within 2s and was killed/.test(hangRun.out));
    holds("and the runner says the printed verdict is not a statement about the member ending", /any verdict it printed is about its checks, not about it ending/.test(hangRun.out));
    holds("the hanging member's own green verdict was on screen, so a reader could have believed it", /VERDICT: PASS failures=0/.test(hangRun.out));
    holds("the members BEHIND the hang still ran, so the cap changes the verdict and not the sweep", hangRun.out.includes("hang-5 green") && hangRun.out.includes("hang-6 green"));

    // MATCHED CONTROL for the arm above: the same shape of member, sleeping for a real but BOUNDED time
    // that fits inside the same cap, must pass. Without this the arm above would also be satisfied by a cap
    // that killed everything, which is a gate that reports a hang for every member and proves nothing.
    const slow = pkg("slow-but-finite", "f", { validate: chainWith("slow", 6, { 4: 'node -e "console.log(\'slow-4 green\');setTimeout(()=>{},600)"' }) });
    const slowRun = run(["validate", "6"], slow, self, { GATE_CHAIN_CAP_MS: "5000" });
    holds("CONTROL: a member that is slow but does exit still passes under the same cap", slowRun.status === OK);
    holds("CONTROL: and it is not reported as having failed to exit", !/did not exit within/.test(slowRun.out));

    // THE OVERRIDE CAN ONLY TIGHTEN THE CAP. A value above the ceiling is clamped down to it, so the knob
    // cannot be used to wait out a hang. Proved against the cap the runner ANNOUNCES rather than by making
    // something hang for five minutes to observe it, which would be a self-test that takes five minutes to
    // say the cap works.
    const green6 = pkg("cap-announced", "f", { validate: chainOf("cap", 6) });
    const clampRun = run(["validate", "6"], green6, self, { GATE_CHAIN_CAP_MS: String(60 * 60 * 1000) });
    holds("an override above the ceiling is clamped to the ceiling rather than honoured", /each capped at 900s/.test(clampRun.out));
    holds("a legal override below the ceiling is honoured", /each capped at 7s/.test(run(["validate", "6"], green6, self, { GATE_CHAIN_CAP_MS: "7000" }).out));
    holds("a nonsense override falls back to the ceiling rather than to no cap", /each capped at 900s/.test(run(["validate", "6"], green6, self, { GATE_CHAIN_CAP_MS: "not-a-number" }).out));
    holds("and the default, with no override at all, is the ceiling", /each capped at 900s/.test(run(["validate", "6"], green6).out));

    const odd = pkg("outside-convention", "f", { validate: chainWith("x", 6, { 4: memberExiting("x", 4, 3) }) });
    const oddRun = run(["validate", "6"], odd);
    holds("a member exiting outside the 0/1/2 convention refuses", oddRun.status === CANNOT);
    holds("and the runner says it cannot tell whether that member graded anything", /outside the 0\/1\/2 convention/.test(oddRun.out));

    // ---- the package manager must propagate both codes --------------------------------------------------
    // Asserted rather than assumed, because 47 of the 238 real members across this repo's three chains are
    // an `npm run`. If npm flattened its child's 2 to its own 1, the precedence above would be unreachable
    // in production while every arm here stayed green.
    const npm2 = pkg("npm-two", "f", { validate: chainWith("n2", 6, { 4: "npm run --silent inner" }), inner: 'node -e "process.exit(2)"' });
    const npm2Run = run(["validate", "6"], npm2);
    holds("npm propagating a member's 2 refuses", npm2Run.status === CANNOT);
    holds("and it arrives as 2 rather than as npm's own 1", /member 4 REFUSED exit=2/.test(npm2Run.out));

    const npm1 = pkg("npm-one", "f", { validate: chainWith("n1", 6, { 4: "npm run --silent inner" }), inner: 'node -e "process.exit(1)"' });
    const npm1Run = run(["validate", "6"], npm1);
    holds("npm propagating a member's 1 is still a finding", npm1Run.status === FOUND);
    holds("and it is named as a failure rather than a refusal", /member 4 FAILED exit=1/.test(npm1Run.out));

    // ---- the floor ---------------------------------------------------------------------------------------
    const short = pkg("short", "f", { validate: chainOf("s", 4) });
    const shortRun = run(["validate", "6"], short);
    holds("a chain under its floor refuses", shortRun.status === CANNOT);
    holds("and says how far under", /splits to only 4 member\(s\), under the floor of 6/.test(shortRun.out));

    const noFloor = run(["validate"], green);
    holds("a missing floor refuses rather than defaulting", noFloor.status === CANNOT);
    holds("and says why the floor is required", /The floor is required so a gutted chain cannot pass/.test(noFloor.out));
    const badFloor = run(["validate", "not-a-number"], green);
    holds("a floor that is not an integer refuses", badFloor.status === CANNOT);
    const zeroFloor = run(["validate", "0"], green);
    holds("a floor of zero refuses, because a floor of zero is no floor", zeroFloor.status === CANNOT);

    // THE FLOOR MAY NOT BE SATISFIED BY A CHAIN THAT RAN FEWER MEMBERS THAN IT COUNTED. The count the floor
    // grades is the same list the loop iterates and the loop has no early exit, so this arm holds the two
    // together: six counted, six reported, with a refusal in the middle that does not stop the sweep.
    const counted = pkg("counted", "f", { validate: chainWith("c", 6, { 2: memberExiting("c", 2, 2) }) });
    const countedRun = run(["validate", "6"], counted);
    holds("a refusing member does not shorten the sweep", /6 member\(s\) of "validate" all RUN/.test(countedRun.out));
    holds("every one of the six members reported a result", (countedRun.out.match(/\[gate-chain\] \d+\/6 (PASS|FAIL|REFUSED)/g) ?? []).length === 6);
    holds("and the run is still a refusal", countedRun.status === CANNOT);

    // ---- vacuity -----------------------------------------------------------------------------------------
    // A chain resolving to zero members must refuse rather than pass, because a sweep of nothing is the one
    // input on which a runner can report success having done no work at all. Both holes are driven: an
    // empty string is caught as a missing chain, and whitespace survives that check and splits to nothing.
    const vacEmpty = pkg("vacuous-empty", "f", { validate: "" });
    const vacEmptyRun = run(["validate", "1"], vacEmpty);
    holds("a chain whose script is empty refuses rather than passing vacuously", vacEmptyRun.status === CANNOT);
    holds("and it is reported as the chain having vanished", /has no "validate" script/.test(vacEmptyRun.out));

    const vacBlank = pkg("vacuous-blank", "f", { validate: "   " });
    const vacBlankRun = run(["validate", "1"], vacBlank);
    holds("a chain that splits to zero members refuses rather than passing vacuously", vacBlankRun.status === CANNOT);
    holds("and it is reported as zero members against the floor", /splits to only 0 member\(s\)/.test(vacBlankRun.out));

    const vacSeps = pkg("vacuous-separators", "f", { validate: " && && " });
    const vacSepsRun = run(["validate", "1"], vacSeps);
    holds("a chain that is nothing but separators refuses", vacSepsRun.status === CANNOT);

    // ---- the chain itself has gone ------------------------------------------------------------------------
    const missingRun = run(["nosuch", "6"], green);
    holds("a chain name package.json does not carry refuses", missingRun.status === CANNOT);
    holds("and says the chain vanished rather than passed", /has no "nosuch" script/.test(missingRun.out));

    const noArgs = run([], green);
    holds("no chain name refuses", noArgs.status === CANNOT);

    mkdirSync(join(bed, "bare"), { recursive: true });
    writeFileSync(join(bed, "bare", "keep.txt"), "no package.json here\n");
    const bareRun = run(["validate", "6"], join(bed, "bare"));
    holds("no package.json refuses", bareRun.status === CANNOT);
    holds("and names the file it could not read", /no package\.json at/.test(bareRun.out));

    // ---- two classifier branches the child-process route cannot reach ---------------------------------
    // spawnSync only produces `error` or a non-numeric `status` when the spawn itself fails, which no
    // member command can be made to do from a package.json. Graded directly instead, because the
    // alternative is two arms of the classifier that no mutation can disturb, and code no mutation can
    // disturb is indistinguishable from code that has been deleted.
    holds("a member that could not be spawned at all is a refusal", classify({ error: new Error("spawn failed") }).kind === "refused");
    holds("and that refusal carries the could-not-check code", classify({ error: new Error("spawn failed") }).code === CANNOT);
    holds("a member with no exit status this runner can read is a refusal", classify({ status: null }).kind === "refused");
    holds("and that refusal carries the could-not-check code too", classify({ status: null }).code === CANNOT);

    // ---- the count-against-sweep guard, graded against a copy with the defect injected ----------------
    // The guard asserts that the number of members the floor counted is the number that reached a verdict.
    // That is a tautology of this loop, which has no early exit, so the guard cannot fire on this file and
    // a mutant that removes it survives. It is a tripwire for a future edit, and the only way to grade a
    // tripwire is to trip it: this arm runs a COPY of this file with an early exit put back in.
    // The anchor is the counter rather than a log line, because a log line here carries template
    // placeholders and biome's noTemplateCurlyInString reads them inside a plain string as a mistake.
    const early = variantOf("    ran++;", "    ran++;\n    if (i === 2) break;");
    variants.push(early);
    const earlyRun = run(["validate", "6"], green, early);
    holds("a loop that has gained an early exit is caught rather than reported as a clean sweep", earlyRun.status === CANNOT);
    holds("and the refusal names the count and the number that actually reached a verdict", /counted 6 member\(s\) but only 3 reached a verdict/.test(earlyRun.out));
    holds("and a shortened sweep never prints the all-RUN line", !/all RUN/.test(earlyRun.out));
  } finally {
    for (const v of variants) rmSync(v, { force: true });
    rmSync(bed, { recursive: true, force: true });
  }

  // The floor is the count this suite actually carries, not a round number under it, for the same reason
  // MIN_MEMBERS is on the chains themselves.
  const FLOOR = 58;
  if (checks < FLOOR) {
    console.error(`\n${TAG} self-test ran only ${checks} check(s), under its own floor of ${FLOOR}. A suite that has quietly emptied cannot report a pass.`);
    return CANNOT_RUN;
  }
  console.log(failures === 0 ? `\n${TAG} self-test PASS (${checks} checks)` : `\n${TAG} self-test ${failures} FAILURE(S) of ${checks} checks`);
  return failures === 0 ? CLEAN : FOUND_SOMETHING;
}

// Gated on being the entry module: a bare top-level dispatch runs the whole thing inside any importer and
// exits before the importer's first line. The rule, with the realpath that makes it survive a symlinked
// invocation, lives once in scripts/entry-module.mjs.
if (isEntryModule(import.meta.url)) {
  if (process.argv.includes("--self-test")) process.exit(selfTest());
  else process.exit(main(process.argv.slice(2)));
}
