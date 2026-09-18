#!/usr/bin/env node
// Mirror drift gate: the console re-declares a closed subset of the engine's own literal-string unions
// (Role/Capability, notify events, audit-adjacent statuses, restore/attest states, ...) as its OWN types,
// because the two repos do not share a package. Nothing stops those two declarations drifting apart, and
// nothing else in this codebase catches it: a drift is otherwise found by a human re-deriving a pair by
// hand while working on something adjacent -- exactly the failure mode this gate exists to remove. A
// missed member is not academic: an owner approving a real config change can see a raw wire string (e.g.
// "notify-channel-set") as the card title instead of a label, on the maker/checker screen that gates a
// destructive config mutation.
//
// THIS IS NOT THE ONLY GATE OF THIS SHAPE. scripts/audit-mirror-drift-gate.mjs already does the identical
// job for AuditAction, AuditTarget and the audit engine-state fields; it is not duplicated here (see PAIRS
// below, and "WHAT THIS DOES NOT COVER").
//
// HOW MUCH OF THE CORPUS THIS COVERS (answer this honestly, every time this file changes): the corpus
// enumerates ~30 closed string-literal mirror pairs across console/src/lib/api/types/*.ts and
// console/src/lib/identity-model.ts. This gate declares 27 of them in PAIRS below (COUNT asserted at the
// bottom of this file, so a change to the list must update the number in one place too). Three are KNOWN
// NOT covered, named explicitly rather than silently omitted:
//   - AuditAction / AuditTarget / the audit engine-state fields: covered by the SIBLING gate
//     (scripts/audit-mirror-drift-gate.mjs), which does the same job for that family with its own
//     hand-tuned extraction (a naive extractor risks under-counting a family this size, which is why that
//     gate's own extraction is hand-tuned). Not duplicated here to avoid two gates disagreeing about the
//     same pair.
//   - IdpKind ("oidc" | "oauth2" | "saml"): the engine never names this as a standalone exported type: it is
//     an inline field literal in idpconn.ts with no comment-stable anchor distinct from the value itself
//     (the anchor and the answer would be the same string, so a real drift could shift the anchor out from
//     under the extractor and this gate would silently stop comparing rather than fail loud -- worse than not
//     declaring the pair at all).
//   - ConfigDiffArea: the engine's config-diff.ts inlines `area: "downpipe" | ... | "coverage"` on an
//     anonymous object-literal field with no unique preceding anchor (`area:` recurs dozens of times in the
//     same file on ordinary diff-line pushes), so the same silent-drift risk applies.
// A pair with no reliable ANCHOR is left out, not forced in with a fragile one: a gate that goes quiet on a
// moved anchor instead of failing is exactly the failure this file exists to close.
//
// EXACT MATCH BY DEFAULT, DECLARED SUBSET WHEN LEGITIMATE. A console mirror that deliberately carries fewer
// members than the engine is legitimate (the console is not obliged to model every wire value); the sweep
// found 26 of 30 pairs matching EXACTLY and zero deliberate subsets among them, so every pair here defaults
// to exact-match (subsetOk: false, or omitted). Setting `subsetOk: true` on a pair declares, in one place,
// reviewable in the same diff as the code change that motivates it, that the console is KNOWN to hold fewer
// members than the engine on purpose; it does not weaken the other direction, which always fails: a member
// the CONSOLE holds and the engine cannot write is dead vocabulary regardless of subsetOk, and a member the
// ENGINE writes that is absent from a subsetOk console mirror is only accepted when it is EXPLICITLY listed
// in that pair's `knownGap` array (so a NEW engine member the console does not yet know about still fails --
// subsetOk covers the gap that was reviewed, not every future gap the engine might grow).
//
// THE FOUR QUESTIONS.
//  1. Does it run in CI? Yes, TODAY, not as future wiring: it is `npm run mirror-drift`, added to
//     `validate:workspace:chain` (package.json) right beside its sibling `audit-mirror-drift-gate.mjs`, which
//     `npm run validate:workspace` runs, which the "Cross-repo gates" job (.github/workflows/ci.yml, job id
//     `workspace`) runs on every push via `working-directory: console`. That job ALREADY checks out
//     `downpipes/engine` as a sibling at path `engine` beside `console` (that is precisely how
//     audit-mirror-drift-gate.mjs reaches the engine today), which is exactly what this file's own CANDIDATES
//     resolution below expects (`resolve(HERE, "../../engine")` = console/scripts/../../engine = the checked-
//     out sibling). No new CI job or checkout step was needed; this rides the existing one.
//  2. Does it FAIL when it cannot run? Yes: no engine checkout -> exit 2 (distinct from exit 1, so a caller
//     that greps for "the gate failed" cannot conflate "could not check" with "found a defect", the same
//     convention audit-mirror-drift-gate.mjs and verify-citations.mjs already use); an engine behind its own
//     origin/main -> exit 2 unless MIRROR_DRIFT_ALLOW_STALE=1; an anchor that cannot be found on either side
//     -> exit 1 naming exactly which pair and which side (a moved anchor IS a drift worth knowing about, not
//     a reason to go quiet).
//  3. Does it FAIL when there is nothing to check? Yes: PAIRS.length === 0 refuses to run at all (a `assert`
//     at the top, same discipline `derive.mjs` already applies to an empty row set).
//  4. How much of the corpus can it fail on? 27 of the ~30 pairs the sweep enumerated (stated above, asserted
//     at the bottom of this file); 3 named and excluded for a concrete, non-speculative anchor-safety reason;
//     AuditAction/AuditTarget/engine-state fields covered by the pre-existing sibling gate, not this one.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

// Same sibling-resolution order as audit-mirror-drift-gate.mjs: an explicit override, then the unified
// worktree, then the merged repo, then the plain sibling checkout.
const CANDIDATES = /** @type {string[]} */ ([
  process.env.DOWNPIPES_ENGINE,
  resolve(HERE, "../../support-unified-engine"),
  resolve(HERE, "../../support-pack-engine"),
  resolve(HERE, "../../engine"),
  resolve(HERE, "../../../engine"),
].filter(Boolean));

const PROBE_FILE = "src/admin/identity-rbac.ts"; // any file that exists on a real engine checkout
const engineRoot = CANDIDATES.find((c) => existsSync(resolve(c, PROBE_FILE)));
if (engineRoot === undefined) {
  console.error("MIRROR DRIFT GATE: FAIL -- cannot locate the engine, so no mirror pair can be compared.");
  console.error("  Set DOWNPIPES_ENGINE=/path/to/engine, or check the engine out beside this repo.");
  console.error("  This FAILS rather than skips on purpose: a gate that quietly opts out when it cannot check");
  console.error("  reads as a pass, which is the failure it exists to prevent.");
  process.exit(2); // 2, not 1: 1 is reserved for a real drift finding below.
}

if (process.env.MIRROR_DRIFT_ALLOW_STALE !== "1") {
  /** @type {number | null} */
  let behind = null;
  try {
    behind = Number(execFileSync("git", ["-C", engineRoot, "rev-list", "--count", "HEAD..origin/main"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch { /* unknown freshness: not a repo, or no origin/main ref -- nothing to conclude, do not fail */ }
  if (Number.isFinite(behind) && /** @type {number} */ (behind) > 0) {
    console.error(`MIRROR DRIFT GATE: FAIL -- the engine at ${engineRoot} is ${behind} commit(s) behind its own origin/main.`);
    console.error("  Every comparison below would grade the mirror against code that has since moved, and report it");
    console.error("  healthy. Update the checkout, or set MIRROR_DRIFT_ALLOW_STALE=1 if an old tree is deliberate.");
    process.exit(2);
  }
}

console.log(`MIRROR DRIFT GATE: comparing against engine at ${engineRoot}`);

// ---------------------------------------------------------------------------------------------------------
// Extraction. A declaration is `export type NAME = "a" | "b" | ...;` or `export const NAME = ["a", "b", ...]
// as const;` -- in every pair declared below, neither form ever contains a semicolon inside its own body, so
// "from the anchor to the first top-level semicolon" is a correct statement boundary without a full parser.
// Comments ARE stripped first (// line comments and /* block */ comments), because these files carry
// extensive prose comments that quote real member words in plain English, which is exactly what makes a
// naive grep under-count a family like AuditAction (see audit-mirror-drift-gate.mjs's own header).
// ---------------------------------------------------------------------------------------------------------
function stripComments(src) {
  // Block comments first (non-greedy), then line comments. Safe for these files: none of the declarations
  // this gate reads carries a `//` or `/*` inside a string literal member (kebab-case identifiers only).
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// How far past the anchor to look. Generous: several of these declarations (NOTIFY_EVENT_NAMES,
// AuditAction's ilk) carry long per-member prose comments running to hundreds of characters each.
const SCAN_WINDOW = 20000;

function extractAfterAnchor(rawSrc, anchor, label) {
  const idx = rawSrc.indexOf(anchor);
  if (idx === -1) return { error: `cannot locate the anchor ${JSON.stringify(anchor)} for ${label}` };
  // COMMENTS ARE STRIPPED BEFORE THE SEMICOLON SEARCH, not after: ordinary English prose inside a
  // // or /* */ comment is full of semicolons ("warning; the engine may..."), so hunting for the
  // terminating ";" on the RAW text would stop at the first one inside a comment, truncating the real
  // member list -- exactly the failure mode a naive quote-grep on this family of file can produce (see
  // audit-mirror-drift-gate.mjs's own header). Strip first, then find the boundary.
  const window = stripComments(rawSrc.slice(idx + anchor.length, idx + anchor.length + SCAN_WINDOW));
  const semi = window.indexOf(";");
  if (semi === -1) return { error: `no terminating ";" found within ${SCAN_WINDOW} chars after the anchor for ${label} (declaration shape changed, or SCAN_WINDOW is now too small)` };
  const body = window.slice(0, semi);
  // Dotted members (Capability: "downpipe.read") need the "." in the character class alongside the more
  // common kebab-case ("backup-failure") and plain-word ("STANDARD") forms.
  const members = [...body.matchAll(/"([a-zA-Z0-9_.-]+)"/g)].map((m) => m[1]);
  return { members: [...new Set(members)] };
}

// ---------------------------------------------------------------------------------------------------------
// PAIRS. Each declares a console-side and engine-side literal set to extract and compare. `subsetOk: true`
// plus a `knownGap` array is the documented, reviewable way to declare an intentional subset (see header).
// `min` is a parse-sanity floor (not a coverage floor): it catches an anchor that matched but yielded a
// suspiciously short list, which is what a regex silently matching the wrong text looks like.
// ---------------------------------------------------------------------------------------------------------
const PAIRS = [
  { name: "AuthMethod", consoleFile: "src/lib/identity-model.ts", consoleAnchor: "export type AuthMethod =", engineFile: "src/admin/identity-roles.ts", engineAnchor: "export type AuthMethod =", min: 4 },
  { name: "Role", consoleFile: "src/lib/identity-model.ts", consoleAnchor: "export type Role =", engineFile: "src/admin/identity-roles.ts", engineAnchor: "export type Role =", min: 4 },
  { name: "Capability", consoleFile: "src/lib/identity-model.ts", consoleAnchor: "export type Capability =", engineFile: "src/admin/identity-rbac.ts", engineAnchor: "export type Capability =", min: 10 },
  { name: "PostureSeverity", consoleFile: "src/lib/api/types/posture.ts", consoleAnchor: "export type PostureSeverity =", engineFile: "src/admin/posture.ts", engineAnchor: "export type PostureSeverity =", min: 3 },
  { name: "notify ChannelKind", consoleFile: "src/lib/api/types/notifications.ts", consoleAnchor: "export type ChannelKind =", engineFile: "src/notify/types.ts", engineAnchor: "export type ChannelKind =", min: 5 },
  { name: "NotifyEvent", consoleFile: "src/lib/api/types/notifications.ts", consoleAnchor: "export type NotifyEvent =", engineFile: "src/notify/types.ts", engineAnchor: "export const NOTIFY_EVENT_NAMES = [", min: 15 },
  { name: "PushFormat", consoleFile: "src/lib/api/types/push.ts", consoleAnchor: "export type PushFormat =", engineFile: "src/sched/scheduler-do-limits.ts", engineAnchor: "export const PUSH_FORMATS = [", min: 5 },
  { name: "PushSink", consoleFile: "src/lib/api/types/push.ts", consoleAnchor: "export type PushSink =", engineFile: "src/sched/scheduler-do-limits.ts", engineAnchor: "export const PUSH_SINKS = [", min: 2 },
  { name: "IdpSecretMode / SecretMode", consoleFile: "src/lib/api/types/idp.ts", consoleAnchor: "export type IdpSecretMode =", engineFile: "src/admin/idpconn-types.ts", engineAnchor: "export type SecretMode =", min: 3 },
  { name: "ConfigDiffKind / ChangeKind", consoleFile: "src/lib/api/types/config-history.ts", consoleAnchor: "export type ConfigDiffKind =", engineFile: "src/admin/config-diff.ts", engineAnchor: "export type ChangeKind =", min: 2 },
  { name: "ConfigChangeStatus / PendingChangeStatus", consoleFile: "src/lib/api/types/config-changes.ts", consoleAnchor: "export type ConfigChangeStatus =", engineFile: "src/admin/change-control.ts", engineAnchor: "export type PendingChangeStatus =", min: 3 },
  { name: "ExpiryKind", consoleFile: "src/lib/api/types/expiry.ts", consoleAnchor: "export type ExpiryKind =", engineFile: "src/admin/expiry.ts", engineAnchor: "export type ExpiryKind =", min: 3 },
  { name: "ExpiryLifecycleClass", consoleFile: "src/lib/api/types/expiry.ts", consoleAnchor: "export type ExpiryLifecycleClass =", engineFile: "src/admin/expiry.ts", engineAnchor: "export type ExpiryLifecycleClass =", min: 2 },
  { name: "RestoreProvenMethod", consoleFile: "src/lib/api/types/downpipes.ts", consoleAnchor: "export type RestoreProvenMethod =", engineFile: "src/sched/types.ts", engineAnchor: "export type RestoreProvenMethod =", min: 2 },
  { name: "RestoreTestKind / lastRestoreTestKind", consoleFile: "src/lib/api/types/downpipes.ts", consoleAnchor: "export type RestoreTestKind =", engineFile: "src/sched/types.ts", engineAnchor: "lastRestoreTestKind?:", min: 2 },
  { name: "RiskClass", consoleFile: "src/lib/api/types/updates.ts", consoleAnchor: "export type RiskClass =", engineFile: "src/admin/updates.ts", engineAnchor: "export type RiskClass =", min: 2 },
  { name: "UpdateComponentId / UPDATE_COMPONENTS", consoleFile: "src/lib/api/types/updates.ts", consoleAnchor: "export type UpdateComponentId =", engineFile: "src/admin/updates.ts", engineAnchor: "export const UPDATE_COMPONENTS = [", min: 2 },
  { name: "DrillEvidenceKind", consoleFile: "src/lib/api/types/audit.ts", consoleAnchor: "export type DrillEvidenceKind =", engineFile: "src/sched/types.ts", engineAnchor: "export type DrillEvidenceKind =", min: 2 },
  { name: "CoverageResourceType", consoleFile: "src/lib/api/types/coverage.ts", consoleAnchor: "export type CoverageResourceType =", engineFile: "src/admin/coverage.ts", engineAnchor: "export type CoverageResourceType =", min: 3 },
  { name: "CoverageStatus", consoleFile: "src/lib/api/types/coverage.ts", consoleAnchor: "export type CoverageStatus =", engineFile: "src/admin/coverage.ts", engineAnchor: "export type CoverageStatus =", min: 3 },
  { name: "RoleSource", consoleFile: "src/lib/api/types/who.ts", consoleAnchor: "export type RoleSource =", engineFile: "src/admin/identity.ts", engineAnchor: "export type RoleSource =", min: 4 },
  { name: "StorageClass / STORAGE_CLASSES", consoleFile: "src/lib/api/types/destinations.ts", consoleAnchor: "export type StorageClass =", engineFile: "src/dest/factory-validators.ts", engineAnchor: "export const STORAGE_CLASSES = [", min: 3 },
  { name: "OwnerActionStatus", consoleFile: "src/lib/api/types/owner-actions.ts", consoleAnchor: "export type OwnerActionStatus =", engineFile: "src/admin/owner-action.ts", engineAnchor: "export type OwnerActionStatus =", min: 4 },
  { name: "OwnerActionKind", consoleFile: "src/lib/api/types/owner-actions.ts", consoleAnchor: "export type OwnerActionKind =", engineFile: "src/admin/owner-action.ts", engineAnchor: "export type OwnerActionKind =", min: 10 },
  { name: "ConfigChangeKind", consoleFile: "src/lib/api/types/config-changes.ts", consoleAnchor: "export type ConfigChangeKind =", engineFile: "src/admin/change-control.ts", engineAnchor: "export type ConfigChangeKind =", min: 10 },
  { name: "AttestRunState", consoleFile: "src/lib/api/types/attest.ts", consoleAnchor: "export type AttestRunState =", engineFile: "src/sched/types.ts", engineAnchor: "recordCount?: number;\n  state:", min: 3 },
  { name: "restore ApprovalStatus", consoleFile: "src/lib/api/types/rbac.ts", consoleAnchor: "export type ApprovalStatus =", engineFile: "src/admin/approvals.ts", engineAnchor: "export type ApprovalStatus =", min: 5 },
];

if (PAIRS.length === 0) {
  console.error("MIRROR DRIFT GATE: FAIL -- PAIRS is empty. An empty declared-pair list checks nothing and must not pass silently.");
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------------------
// Compare, both directions, per pair.
// ---------------------------------------------------------------------------------------------------------
const failures = [];
let comparedPairs = 0;

for (const pair of PAIRS) {
  let consoleSrc, engineSrc;
  try {
    consoleSrc = readFileSync(resolve(HERE, "..", pair.consoleFile), "utf8");
  } catch {
    failures.push(`${pair.name}: cannot read console file ${pair.consoleFile}.`);
    continue;
  }
  try {
    engineSrc = readFileSync(resolve(engineRoot, pair.engineFile), "utf8");
  } catch {
    failures.push(`${pair.name}: cannot read engine file ${pair.engineFile} at ${engineRoot}.`);
    continue;
  }

  const c = extractAfterAnchor(consoleSrc, pair.consoleAnchor, `${pair.name} (console)`);
  if ("error" in c) { failures.push(`${pair.name}: ${c.error}. Fix this gate's anchor before shipping -- a silent non-match is worse than this failure.`); continue; }
  const e = extractAfterAnchor(engineSrc, pair.engineAnchor, `${pair.name} (engine)`);
  if ("error" in e) { failures.push(`${pair.name}: ${e.error}. Fix this gate's anchor before shipping -- a silent non-match is worse than this failure.`); continue; }

  if (c.members.length < pair.min) { failures.push(`${pair.name}: parsed only ${c.members.length} console member(s) (expected at least ${pair.min}); the anchor matched but the shape looks wrong. Fix this gate.`); continue; }
  if (e.members.length < pair.min) { failures.push(`${pair.name}: parsed only ${e.members.length} engine member(s) (expected at least ${pair.min}); the anchor matched but the shape looks wrong. Fix this gate.`); continue; }

  comparedPairs++;
  const knownGap = new Set(pair.knownGap ?? []);
  const missingFromConsole = e.members.filter((m) => !c.members.includes(m) && !(pair.subsetOk && knownGap.has(m)));
  const surplusInConsole = c.members.filter((m) => !e.members.includes(m));

  for (const m of missingFromConsole) failures.push(`${pair.name}: "${m}" is written by the ENGINE and is MISSING from the console (${pair.consoleFile}). An unrecognised value renders its raw wire string, not a blank -- but it should never need to.`);
  for (const m of surplusInConsole) failures.push(`${pair.name}: "${m}" is held by the CONSOLE (${pair.consoleFile}) and the engine cannot write it. Dead vocabulary in a closed union.`);

  console.log(`  ${pair.name}: engine ${e.members.length}, console ${c.members.length}${pair.subsetOk ? ` (declared subset, ${knownGap.size} known gap(s))` : ""}`);
}

// Parse-sanity floor on the CORPUS itself: if fewer pairs were actually compared than declared (every one
// hit a read/extract error above), this gate is not doing its job even though no drift failure fired.
const EXPECTED_PAIRS = 27;
if (PAIRS.length !== EXPECTED_PAIRS) {
  failures.push(`PAIRS declares ${PAIRS.length} pair(s) but this file's own header says ${EXPECTED_PAIRS}. Update whichever one is stale -- the count is a claim this gate must keep honest about itself.`);
}
if (comparedPairs < PAIRS.length) {
  failures.push(`Only ${comparedPairs} of ${PAIRS.length} declared pairs were actually compared (the rest hit a read/extract error above). That is undercoverage, not a clean pass.`);
}

console.log(`\nMIRROR DRIFT GATE: ${comparedPairs}/${PAIRS.length} declared pairs compared (of the ~30 the corpus sweep found; AuditAction/AuditTarget/engine-state fields covered separately by audit-mirror-drift-gate.mjs; IdpKind and ConfigDiffArea excluded, no stable anchor -- see header).`);

if (failures.length > 0) {
  console.error(`\nMIRROR DRIFT GATE: FAIL -- ${failures.length} finding(s):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("MIRROR DRIFT GATE: PASS -- every declared pair matches (or matches its declared subset) in both directions.");
