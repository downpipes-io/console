#!/usr/bin/env node
// STEP-UP CALL-SITE DRIFT GATE: every console POST to a step-up-gated engine route must go through the
// ceremony, and the list of gated routes is read from the engine rather than kept here.
//
// WHY THIS EXISTS, AND WHY NOTHING ELSE CAN CATCH IT.
//
// The engine gates a set of sensitive routes (STEPUP_SUBS, src/admin/router-core.ts): a cookie-borne
// session hitting one of them gets 401 { stepUpRequired: true } and must re-authenticate. On the console
// side only Transport.gatedFetch runs that ceremony. A call made with plain engineFetch receives the 401
// as a final answer, so the action does not prompt, it FAILS.
//
// THIS CHECK HAS TO BE STRUCTURAL AND HAS TO RUN IN CI, because no amount of end-to-end testing on the
// estates available can find a call site that skips the ceremony. requireStepUp opens with
// `if (method === "token" || method === "access") return null`. Every dev, uat and internal estate is
// Cloudflare Access fenced, and the harness drives with a bearer token, so every environment the product is
// exercised in is EXEMPT BY CONSTRUCTION: no drive, no journey and no green cell in any estate can reach the
// branch where a missing ceremony fails. A customer on a passkey or IdP session in production is the first
// party who can, and what they meet is a hard failure on role grant, key rotation and break-glass, not a
// prompt.
//
// A HAND-MAINTAINED LIST DRIFTS. test/validate-stepup-dest-idp.ts drives a set of client methods through a
// scripted 401 and asserts the retry, which is real behavioural coverage and is kept. What it cannot do is
// notice a route it was never told about: a list written by hand falls behind the engine's own set the
// moment a route joins it. So this gate derives the engine's set and reads every console call site against
// it, and a route joining STEPUP_SUBS makes it fail here on the next push rather than waiting to be noticed
// by a customer.
//
// WHAT IT READS, precisely. Every POST call site in src/lib/api whose literal path resolves to a member of
// the engine's STEPUP_SUBS, and whether that site calls gatedFetch or engineFetch. It does not follow
// variables: a path assembled at runtime is not matched and is reported as unresolved rather than counted
// as either compliant or not, because a check that guesses is worse than one that admits its edge.
//
// ROUTES GATED WITHOUT BEING IN THE SET are checked too. STEPUP_SUBS is keyed on exact string equality, so
// the two dual-control APPROVE routes cannot be members: their `sub` carries a per-request ULID. router.ts
// gates their parsed action directly instead, and a call site on plain engineFetch for one of these routes
// is invisible to a set-membership check. So this gate reads BOTH halves: that the engine still pairs
// `action === "approve"` with requireStepUp, and that every console POST to a dynamic `/approve` path runs
// the ceremony. The `/reject` siblings are deliberately exempt in the engine ("only gate the dangerous
// direction"), so they are named as exempt here rather than silently ignored.
//
// POST /restore is the third of this shape, gating on a body field rather than a path segment. It is
// already covered by the behavioural validator and by the engine's own structural check.
//
// Run with: node scripts/stepup-call-site-gate.mjs   (REQUIRE_ENGINE=1 to refuse rather than skip)
//
// WHICH ENGINE TREE THE GATED-ROUTE SET CAME FROM, and why this gate refuses an old one.
//
// An engine checkout that has fallen behind its own origin/main can print a plausible gated-route count and
// exit clean while reading an out-of-date route set, with no word anywhere in the output about how stale the
// tree is: the counts printed are true of a frozen tree and get read as facts about the engine.
//
// This repo supplies the SUBJECT (console POST call sites) and the sibling supplies the SPECIFICATION
// (STEPUP_SUBS, the set of routes the engine step-up gates). That asymmetry is why an old tree is refused
// here rather than reported. A route the engine has STARTED gating since the checkout is absent from
// `subs`, so a console POST to it is not scored at all: not a finding, not an exemption, not a line in the
// output. The gate then prints "every POST to a gated route runs the ceremony" over a privileged POST that
// skips the ceremony, which is the precise defect it exists to catch. The opposite direction, a route the
// engine has STOPPED gating, is a false red whose remedy is a redundant ceremony, so the two directions are
// not equally costly and the dangerous one is the silent one.
//
// Nothing in the output above carries an engine sha, a digest or a direction, so a reader has nothing in a
// red to audit and nothing in a green to doubt. scripts/field-catalogue-gate.mjs makes the same argument for
// its own refusal.
//
// The refusal bites LOCALLY. In CI the engine is checked out at its own default branch, so the lag is 0 and
// this never fires. STEPUP_ALLOW_STALE_ENGINE=1 is the named hatch, and the tree line below prints even
// under it, so the hatch is not a silencer.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { refuseIfStale, staleness, treeLine } from "./sibling-staleness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "../src/lib/api");

// The engine, resolved the same way and in the same order as the sibling drift gates, so one variable aims
// all of them. An explicit override is EXCLUSIVE: an override that does not exist fails here rather than
// falling through to a sibling the caller did not name, which is the "ignored override lands back on the
// default" failure test/engine-path.ts records.
const OVERRIDE = process.env.DOWNPIPES_ENGINE || process.env.ENGINE_WORKTREE;
const CANDIDATES = OVERRIDE ? [OVERRIDE] : [resolve(HERE, "../../engine"), resolve(HERE, "../../../engine")];
const ENGINE_ROUTER = "src/admin/router-core.ts";
const engineRoot = CANDIDATES.find((c) => existsSync(resolve(c, ENGINE_ROUTER)));

if (engineRoot === undefined) {
  // A console-only checkout has no engine and must still run its own tests, so this SKIPS there and says
  // so. REQUIRE_ENGINE=1, which is what npm run validate:workspace sets and what CI's Cross-repo job runs,
  // turns the same absence into a refusal: in the one place the engine is always present, a skip would read
  // as a pass over the check that matters.
  const why = `no engine found under ${CANDIDATES.join(", ")}`;
  if (process.env.REQUIRE_ENGINE === "1") {
    console.error(`STEP-UP CALL-SITE GATE: FAIL, ${why}, so the gated-route set could not be read.`);
    console.error("  REQUIRE_ENGINE=1 means this must not skip. Set DOWNPIPES_ENGINE, or check the engine out beside this repo.");
    // Exit 2, not 1: 1 is reserved for a real divergence found below.
    process.exit(2);
  }
  console.log(`STEP-UP CALL-SITE GATE: skipped, ${why} (set REQUIRE_ENGINE=1 to refuse instead).`);
  process.exit(0);
}

// The tree line comes BEFORE any number is read, so it is present on a refusal, on a pass, on a parse
// failure and under the hatch. An unreadable origin/main is reported as unknown and never as zero: zero is
// what a current checkout looks like, and a missing ref must not be able to impersonate one.
const TAG = "STEP-UP CALL-SITE GATE:";
const engineTree = staleness(engineRoot);
console.log(treeLine(TAG, "engine", engineRoot, engineTree));
refuseIfStale({
  repoDir: engineRoot,
  label: "engine",
  tag: TAG,
  allowEnv: "STEPUP_ALLOW_STALE_ENGINE",
  measured: engineTree,
  why: [
    "The gated-route set below is READ FROM THAT TREE, so an engine that has started gating a route since",
    "this checkout leaves the console POST to it unscored: not a finding, not an exemption, not a line.",
    "This gate would then report that every POST to a gated route runs the ceremony while one does not.",
  ],
});

// STEPUP_SUBS, with comments stripped first. Reading the raw source would let a member that has been
// COMMENTED OUT still count, which would make this gate assert a route is gated when the engine has
// stopped gating it, in the direction that produces a false clean.
const routerSrc = readFileSync(resolve(engineRoot, ENGINE_ROUTER), "utf8");
const noComments = routerSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const setMatch = /export const STEPUP_SUBS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(noComments);
if (setMatch === null) {
  console.error(`STEP-UP CALL-SITE GATE: FAIL, STEPUP_SUBS could not be parsed out of ${ENGINE_ROUTER}.`);
  console.error("  The engine has moved or renamed it. This refuses rather than scoring every call site as ungated,");
  console.error("  and rather than scoring an empty set as a clean sheet.");
  process.exit(2);
}
const subs = new Set([...setMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));

// CONTROLS ON THE PARSE ITSELF. An empty or tiny set would make every assertion below vacuous and the gate
// would print a confident pass having checked nothing, which is a common way a gate reads as passing while
// checking nothing. Two positives that must be in any real set, one negative that must not: /notify/test is
// deliberately exempt (one fixed, redaction-safe line to an already-configured channel), so its presence
// would mean the parse has picked up some other list. The negative control was /sessions/terminate-others
// until the engine gated that too (a stale ambient session must not sign the operator's other tabs out
// unchallenged), which is the shape of change this control exists to notice.
const POSITIVE_CONTROLS = ["/keys/rotate", "/roles/delete"];
const NEGATIVE_CONTROL = "/notify/test";
const missingControl = POSITIVE_CONTROLS.find((c) => !subs.has(c));
if (subs.size < 20 || missingControl !== undefined || subs.has(NEGATIVE_CONTROL)) {
  console.error(`STEP-UP CALL-SITE GATE: FAIL, the parsed set does not look like STEPUP_SUBS (${subs.size} members).`);
  if (missingControl !== undefined) console.error(`  Expected ${missingControl} to be in it.`);
  if (subs.has(NEGATIVE_CONTROL)) console.error(`  ${NEGATIVE_CONTROL} is exempt in the engine and must not be in it.`);
  process.exit(2);
}

// THE DYNAMIC HALF. router.ts gates the two dual-control approve routes by their PARSED action, because a
// ULID path segment cannot be a Set member. Derived from the engine rather than assumed: each occurrence is
// an `action === "approve"` test whose body calls requireStepUp. Fewer than two means the engine has moved
// this gate or removed it, and either way the console-side assertion below would be checking a rule that no
// longer holds, so it refuses rather than passing.
const ENGINE_SPOKE = "src/admin/router.ts";
const spokePath = resolve(engineRoot, ENGINE_SPOKE);
if (!existsSync(spokePath)) {
  console.error(`STEP-UP CALL-SITE GATE: FAIL, ${ENGINE_SPOKE} is not where it was, so the dynamic approve gates cannot be read.`);
  process.exit(2);
}
const spokeNoComments = readFileSync(spokePath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const APPROVE_GATE = /\.action === "approve"\)\s*\{[\s\S]{0,200}?requireStepUp\(/g;
const approveGates = [...spokeNoComments.matchAll(APPROVE_GATE)].length;
if (approveGates < 2) {
  console.error(`STEP-UP CALL-SITE GATE: FAIL, the engine's router gates only ${approveGates} approve action(s) with requireStepUp.`);
  console.error("  Two are expected (the config-change and owner-action dual-control approvals). The engine has");
  console.error("  changed shape, so this gate cannot assert the console side against it and refuses rather than passing.");
  process.exit(2);
}

// Every fetch call site in the api layer, with the init object's opening brace, so a POST can be told from
// a read. The 400-character window is the init object and its options argument; a call site longer than
// that is reported as unresolved rather than assumed.
const CALL = /(?<how>t\.gatedFetch|this\.t\.gatedFetch|engineFetch)\(\s*(?<path>`[^`]*`|"[^"]*")(?<rest>[\s\S]{0,400})/g;
const gated = [];
const ungated = [];
const unresolved = [];
const exemptRejects = []; // the dual-control reject legs, exempt in the engine and named rather than ignored
for (const name of readdirSync(API_DIR).sort()) {
  if (!name.endsWith(".ts")) continue;
  const text = readFileSync(join(API_DIR, name), "utf8");
  for (const m of text.matchAll(CALL)) {
    // All three named groups are MANDATORY in CALL: `how` and `path` are alternations that must match for
    // the pattern to match at all, and `rest` is a quantifier with a lower bound of zero, which yields the
    // empty string rather than undefined. So a match always carries all three, and this narrows to that
    // fact rather than asserting past a real possibility. TypeScript types `groups` as possibly undefined
    // for the general case (an OPTIONAL named group is genuinely absent), which is right of the general
    // case and not of this pattern.
    const g = /** @type {Record<"how" | "path" | "rest", string>} */ (m.groups);
    if (!/method:\s*"POST"/.test(g.rest.slice(0, 300))) continue;
    // The origin prefix, stripped as TEXT rather than interpolated: these are the literal characters a
    // template call site carries, so they are built here rather than written as a template that biome would
    // read as an unintended interpolation.
    const BASE = ["$", "{t.base}"].join("");
    const THIS_BASE = ["$", "{this.t.base}"].join("");
    const raw = g.path.slice(1, -1).replaceAll(BASE, "").replaceAll(THIS_BASE, "");
    const line = text.slice(0, m.index).split("\n").length;
    const where = `${name}:${line}`;
    const ceremony = g.how.includes("gatedFetch");
    if (raw.includes("${")) {
      // A path with a runtime segment cannot be matched against STEPUP_SUBS, but the engine's own dynamic
      // gate is keyed on the ACTION, and the action is the last literal segment. `/approve` is gated on both
      // dual-control routes; `/reject` is exempt on both, by the engine's stated "only gate the dangerous
      // direction" convention. Anything else dynamic is reported unscored rather than guessed at.
      const shape = raw.replace(/\$\{[^}]*\}/g, "<id>");
      if (shape.endsWith("/approve")) (ceremony ? gated : ungated).push({ where, sub: shape });
      else if (shape.endsWith("/reject")) exemptRejects.push({ where, sub: shape });
      else unresolved.push({ where, raw });
      continue;
    }
    const sub = raw.startsWith("/admin") ? raw.slice("/admin".length) : raw;
    if (!subs.has(sub)) continue;
    (ceremony ? gated : ungated).push({ where, sub });
  }
}

console.log(`STEP-UP CALL-SITE GATE: engine at ${engineRoot}, ${subs.size} gated routes`);
console.log(`  POST call sites hitting a gated route: ${gated.length + ungated.length}`);
console.log(`  through the ceremony (gatedFetch):     ${gated.length}`);
console.log(`  through plain engineFetch:             ${ungated.length}`);
console.log(`  of those, dynamic dual-control approvals:  ${gated.filter((g) => g.sub.endsWith("/approve")).length + ungated.filter((g) => g.sub.endsWith("/approve")).length}`);
if (exemptRejects.length) {
  console.log(`  dual-control reject legs (exempt in the engine, not a finding): ${exemptRejects.length}`);
  for (const e of exemptRejects) console.log(`    ${e.where}  POST ${e.sub}`);
}
if (unresolved.length) {
  console.log(`  paths assembled at runtime, not scored: ${unresolved.length}`);
  for (const u of unresolved) console.log(`    ${u.where}  ${u.raw}`);
}

// A ZERO numerator is a broken parse, not a clean console. If nothing at all resolves to a gated route the
// regex has stopped matching the call sites and every assertion above is empty.
if (gated.length + ungated.length === 0) {
  console.error("STEP-UP CALL-SITE GATE: FAIL, no POST call site resolved to a gated route at all.");
  console.error("  That is a broken parse rather than a compliant console: the api layer or its call shape has moved.");
  process.exit(2);
}

if (ungated.length) {
  console.error(`\nSTEP-UP CALL-SITE GATE: FAIL, ${ungated.length} POST call site(s) hit a step-up-gated route without the ceremony:`);
  for (const u of ungated) console.error(`  ${u.where}  POST ${u.sub}`);
  console.error("\n  On a cookie-borne session (passkey, OIDC, SAML) the engine answers these 401 { stepUpRequired } and");
  console.error("  a plain engineFetch treats that as final, so the action fails instead of prompting. Route them through");
  console.error("  Transport.gatedFetch, as client-retention-prune.ts:49 does.");
  console.error("  No Access-fenced estate can reproduce this: requireStepUp exempts token and access callers, so every");
  console.error("  environment we drive is exempt by construction and will report the call working.");
  process.exit(1);
}
console.log("STEP-UP CALL-SITE GATE: OK, every POST to a gated route runs the ceremony.");
