#!/usr/bin/env node
// Capability-table drift gate: the engine decides authorisation, the console mirrors it, and the test
// suite transcribes it. All three must be the same table.
//
// WHY THIS EXISTS. The engine's ROLE_CAPABILITIES (src/admin/identity-rbac.ts) is the enforcement
// authority: can(role, cap) reads it and nothing else decides a per-route allow. The console keeps a
// mirror (src/lib/identity-model.ts) so an affordance is offered only when the server would permit it.
// A divergence between those two is not cosmetic. It ships as either a button that 403s, or, worse, a
// power the customer holds and the console hides. Both have happened: restore-operator lost
// restore.apply in the console mirror while the engine granted it.
//
// What is supposed to catch that is the parity block in test/validate-identity.ts. It imports the
// engine and compares cell by cell, and it is a good check. It also SKIPS, silently and with exit 0,
// whenever the engine is not reachable. A REQUIRE_ENGINE=1 escape from that skip exists, is documented
// in test/engine-path.ts, and is wired into validate:workspace as
//
//     REQUIRE_ENGINE=1 node scripts/client-diag-parity-gate.mjs && ... && node test/validate-identity.ts
//
// A shell env prefix binds to a SINGLE command, though. The flag reaches client-diag-parity-gate.mjs,
// which does not read it, and reaches none of the five files that do. With the engine absent and no
// flag, validate-identity.ts prints "skipping the engine-parity cross-check" and exits 0. So the
// fail-closed contract is inert as written, and the only reason the parity runs in CI at all is that the
// default relative hop happens to land on the checked-out engine.
//
// This gate is the version of that check that cannot be turned off by an env var failing to arrive. It
// has NO engine-missing branch. If it cannot locate the engine it FAILS, on the rule this repo already
// states in client-diag-parity-gate.mjs: a gate that quietly opts out when it cannot check reads as a
// pass, which is the failure it exists to prevent.
//
// It compares THREE readings of the one table, each from source:
//   1. the ENGINE's ROLE_CAPABILITIES, imported from the engine checkout (the authority),
//   2. the CONSOLE's ROLE_CAPABILITIES, imported from src/lib (the mirror the SPA actually gates on),
//   3. the SUITE's transcription in test/capability-table.ts (the hermetic oracle the validators pin).
// Reading 3 is what stops the transcription being merely a hand-typed copy checked only against the
// console mirror and never against the engine's own authority table.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

// The engine repo. An explicit override is EXCLUSIVE: if DOWNPIPES_ENGINE (or ENGINE_WORKTREE) is set,
// it is the only candidate, and a wrong one fails loudly here instead of falling through.
//
// That is deliberate, and it is not the shape the sibling gates in this directory use. They put the
// override at the head of a candidate LIST, so an override pointing somewhere that does not exist is
// skipped and the search lands on the sibling working tree. The caller then reads a PASS naming an engine
// they did not choose. test/engine-path.ts names this exact failure ("an ignored override lands back on
// the default"): a parity block can run green for a long stretch against whatever engine happens to be
// parked at the relative hop, rather than the one the caller pointed it at.
//
// Pointing DOWNPIPES_ENGINE at a path that does not exist must be the "cannot compare" case; letting it
// fall through to the candidate list instead would return a clean pass against the sibling.
//
// With no override, the candidates in order: the unified worktrees (which ARE the engine that will ship
// while a build is in flight), the sibling checkout, then one level out for a repo nested a directory
// deeper. Same names and same order as the other cross-repo gates, so one variable aims all of them.
const OVERRIDE = process.env.DOWNPIPES_ENGINE || process.env.ENGINE_WORKTREE;
const CANDIDATES = OVERRIDE
  ? [OVERRIDE]
  : [
      resolve(HERE, "../../support-unified-engine"),
      resolve(HERE, "../../support-pack-engine"),
      resolve(HERE, "../../engine"),
      resolve(HERE, "../../../engine"),
    ];

// The engine's capability layer. ROLE_CAPABILITIES, can, ALL_CAPABILITIES and isRole all live here
// (identity.ts re-exports them). Importing the leaf rather than the barrel keeps the gate off the
// engine's request-scoped machinery.
const ENGINE_RBAC = "src/admin/identity-rbac.ts";

const engineRoot = CANDIDATES.find((c) => existsSync(resolve(c, ENGINE_RBAC)));
if (engineRoot === undefined) {
  console.error("CAPABILITY DRIFT GATE: FAIL, cannot locate the engine, so the authority table cannot be compared.");
  console.error(`  Looked for ${ENGINE_RBAC} under:`);
  for (const c of CANDIDATES) console.error(`    ${c}`);
  if (OVERRIDE) {
    console.error(`  DOWNPIPES_ENGINE/ENGINE_WORKTREE is set to ${OVERRIDE}, so that is the ONLY place checked.`);
    console.error("  An override is honoured exactly, never quietly widened to a sibling you did not name.");
  }
  console.error("  Set DOWNPIPES_ENGINE=/path/to/engine, or check the engine out beside this repo.");
  console.error("  This FAILS rather than skips on purpose. The check it replaces skipped here and exited 0,");
  console.error("  which is why an engine grant could drift away from the console mirror unnoticed.");
  // Exit 2, not 1: 1 is reserved for a real divergence found below. "Could not check" must
  // be distinguishable, by exit code alone, from "checked, and something is wrong".
  process.exit(2);
}

// A resolved engine that is merely BEHIND its own origin/main compares every cell against code that has
// since moved and reports it healthy -- the same failure shape verify-citations.mjs can hit against a
// stale engine checkout. No fetch, so unknown freshness (no origin/main ref) is not judged either way.
// CAPABILITY_ALLOW_STALE=1 overrides.
if (process.env.CAPABILITY_ALLOW_STALE !== "1") {
  let behind = null;
  try {
    behind = Number(execFileSync("git", ["-C", engineRoot, "rev-list", "--count", "HEAD..origin/main"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch { /* unknown freshness, nothing to conclude */ }
  if (Number.isFinite(behind) && /** @type {number} */ (behind) > 0) {
    console.error(`CAPABILITY DRIFT GATE: FAIL, the engine at ${engineRoot} is ${behind} commit(s) behind its own origin/main.`);
    console.error("  Every cell below would be graded against code that has since moved, and reported healthy.");
    console.error("  Update the checkout, or set CAPABILITY_ALLOW_STALE=1 if an old tree is deliberate.");
    process.exit(2);
  }
}

console.log(`CAPABILITY DRIFT GATE: comparing against engine at ${engineRoot}`);

const eng = await import(resolve(engineRoot, ENGINE_RBAC));
const con = await import(resolve(HERE, "../src/lib/identity-model.ts"));
const suite = await import(resolve(HERE, "../test/capability-table.ts"));

let failed = 0;
let comparisons = 0;
const fail = (msg, ...detail) => {
  failed += 1;
  console.error(`  FAIL ${msg}`);
  for (const d of detail) console.error(`       ${d}`);
};

// ---------------------------------------------------------------------------
// 0. Vacuity. Every check below iterates a role list and a capability list. If either arrived empty the
// loops would assert nothing and this gate would print a clean pass, which is the exact shape of gate
// this repo keeps finding. The floors are the closed model as it stands: six built-in roles, twenty-one
// capabilities. An ADDITION on either axis raises the count and still passes. A removal fails here and
// has to be a deliberate edit to this line, which is the point.
// ---------------------------------------------------------------------------
const MIN_ROLES = 6;
const MIN_CAPS = 21;

const engTable = eng.ROLE_CAPABILITIES;
const conTable = con.ROLE_CAPABILITIES;
const suiteTable = suite.CAPABILITY_TABLE;

for (const [label, table] of [["engine", engTable], ["console", conTable], ["suite", suiteTable]]) {
  if (table === undefined || table === null || typeof table !== "object") {
    fail(`${label} ROLE_CAPABILITIES did not load as a table.`, "There is nothing to compare, so this is a failure and not a pass.");
  }
}
if (failed > 0) {
  console.error("\nCAPABILITY DRIFT GATE: FAIL, one side of the comparison did not load.");
  process.exit(1);
}

const engRoles = Object.keys(engTable).sort();
const conRoles = Object.keys(conTable).sort();
const suiteRoles = Object.keys(suiteTable).sort();

if (engRoles.length < MIN_ROLES) {
  fail(`the engine table carries only ${engRoles.length} role(s), below the closed model's ${MIN_ROLES}.`,
    "A shrunken table would let every per-role comparison below pass by having nothing in it.");
}
if (!Array.isArray(eng.ALL_CAPABILITIES) || eng.ALL_CAPABILITIES.length < MIN_CAPS) {
  fail(`the engine ALL_CAPABILITIES list carries ${Array.isArray(eng.ALL_CAPABILITIES) ? eng.ALL_CAPABILITIES.length : "no"} member(s), below ${MIN_CAPS}.`);
}
if (typeof eng.can !== "function" || typeof con.can !== "function") {
  fail("can() is missing from one side, so the verdict comparison cannot run.");
}
if (failed > 0) {
  console.error("\nCAPABILITY DRIFT GATE: FAIL, the tables are too small to be checking anything.");
  process.exit(1);
}
console.log(`  ok   both sides loaded: ${engRoles.length} roles, ${eng.ALL_CAPABILITIES.length} capabilities`);

// ---------------------------------------------------------------------------
// 1. The role universes are identical. A role in one side and not the other is drift before any
// capability is compared, and it would make every per-role loop below quietly skip that role.
// ---------------------------------------------------------------------------
const sameRoles = (a, b) => a.length === b.length && a.every((r, i) => r === b[i]);
if (!sameRoles(engRoles, conRoles)) {
  fail("the console and the engine expose DIFFERENT role sets.", `engine:  ${engRoles.join(", ")}`, `console: ${conRoles.join(", ")}`);
} else if (!sameRoles(engRoles, suiteRoles)) {
  fail("the test transcription covers a different role set from the engine.", `engine: ${engRoles.join(", ")}`, `suite:  ${suiteRoles.join(", ")}`);
} else {
  console.log(`  ok   role universe agrees across engine, console and suite (${engRoles.length} roles)`);
}

// ---------------------------------------------------------------------------
// 2. The capability universes are identical. The engine's ALL_CAPABILITIES is the closed list its own
// custom-role validator admits a proposal against, so a capability the console knows and the engine does
// not is a capability no custom role can ever be granted.
// ---------------------------------------------------------------------------
const engCaps = [...eng.ALL_CAPABILITIES].sort();
const conCaps = [...(con.ALL_CAPABILITIES ?? [])].sort();
const suiteCaps = [...(suite.CAPABILITIES ?? [])].sort();
if (!sameRoles(engCaps, conCaps)) {
  const onlyEng = engCaps.filter((c) => !conCaps.includes(c));
  const onlyCon = conCaps.filter((c) => !engCaps.includes(c));
  fail("the console and the engine know DIFFERENT capabilities.",
    onlyEng.length > 0 ? `engine only:  ${onlyEng.join(", ")}` : "",
    onlyCon.length > 0 ? `console only: ${onlyCon.join(", ")}` : "");
} else if (!sameRoles(engCaps, suiteCaps)) {
  const onlyEng = engCaps.filter((c) => !suiteCaps.includes(c));
  const onlySuite = suiteCaps.filter((c) => !engCaps.includes(c));
  fail("the test transcription covers a different capability universe from the engine.",
    onlyEng.length > 0 ? `engine only: ${onlyEng.join(", ")}` : "",
    onlySuite.length > 0 ? `suite only:  ${onlySuite.join(", ")}` : "");
} else {
  console.log(`  ok   capability universe agrees across engine, console and suite (${engCaps.length} capabilities)`);
}

// ---------------------------------------------------------------------------
// 3. Every cell. Per role, the three capability sets must be equal, and can() must return the same
// verdict on both sides for every capability including the ones the role does NOT hold. Comparing only
// the granted cells would miss a capability the console grants and the engine withholds.
// ---------------------------------------------------------------------------
const asSet = (v) => (v instanceof Set ? v : new Set(v ?? []));
for (const role of engRoles) {
  const e = asSet(engTable[role]);
  const c = asSet(conTable[role]);
  const s = asSet(suiteTable[role]);

  if (e.size === 0) {
    fail(`${role}: the engine grants NOTHING, which is not a table this gate can check against.`);
    continue;
  }

  const missing = [...e].filter((cap) => !c.has(cap));
  const extra = [...c].filter((cap) => !e.has(cap));
  if (missing.length > 0 || extra.length > 0) {
    fail(`${role}: the console mirror does not equal the engine's grant.`,
      missing.length > 0 ? `the ENGINE grants and the console HIDES: ${missing.join(", ")}` : "",
      extra.length > 0 ? `the CONSOLE offers and the engine REFUSES: ${extra.join(", ")}` : "",
      "The engine is the enforcement point, so the console is the side to correct.");
  }

  const sMissing = [...e].filter((cap) => !s.has(cap));
  const sExtra = [...s].filter((cap) => !e.has(cap));
  if (sMissing.length > 0 || sExtra.length > 0) {
    fail(`${role}: test/capability-table.ts does not equal the engine's grant.`,
      sMissing.length > 0 ? `in the engine, absent from the transcription: ${sMissing.join(", ")}` : "",
      sExtra.length > 0 ? `in the transcription, absent from the engine: ${sExtra.join(", ")}` : "",
      "The transcription is the suite's oracle, so a wrong one pins the wrong answer.");
  }

  // can() itself, not just the underlying set, in case one side's lookup ever stops being the set read.
  for (const cap of engCaps) {
    comparisons += 1;
    if (eng.can(role, cap) !== con.can(role, cap)) {
      fail(`${role}/${cap}: can() disagrees. engine=${eng.can(role, cap)} console=${con.can(role, cap)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. The comparison actually happened. Reaching here with no cells compared means the loops above found
// nothing to iterate, and reporting that as a pass is the failure mode this gate is built against.
// ---------------------------------------------------------------------------
const EXPECTED_COMPARISONS = MIN_ROLES * MIN_CAPS;
if (comparisons < EXPECTED_COMPARISONS) {
  fail(`only ${comparisons} (role, capability) verdicts were compared, fewer than the ${EXPECTED_COMPARISONS} the closed model requires.`,
    "A gate that compared almost nothing and printed a pass is the defect, not the report.");
}

if (failed > 0) {
  console.error(`\nCAPABILITY DRIFT GATE: FAIL, ${failed} divergence(s) between the engine's authority table and its mirrors.`);
  process.exit(1);
}
console.log(`  ok   ${comparisons} (role, capability) verdicts agree between the engine and the console`);
console.log("CAPABILITY DRIFT GATE: PASS");
