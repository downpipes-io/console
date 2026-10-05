#!/usr/bin/env node
// Audit-mirror drift gate: the console MIRRORS the engine's closed audit vocabulary, and a hole in that mirror
// is not cosmetic.
//
// WHY THIS EXISTS. The console does not merely render the engine's audit vocabulary, it REASONS about
// it. describeTarget files a client-diagnostics contract-skew row whose meaning is "a NEWER engine is writing
// vocabulary this build does not know", and that row rides into the support pack. So a member the CURRENT
// engine writes and the console's mirror LACKS produces a diagnosis that is false (the pair is in lockstep)
// and disabling (support is told to upgrade a console that is already current) and indistinguishable from the
// genuine article (the row is byte-identical to a real newer-engine row). The audit filter compounds it: an
// action absent from the console's union cannot be selected, so the operator cannot narrow the trail down to
// the event that explains their outage.
//
// This is not a marginal case. The engine's engine-secret-absent event is the one that says a deploy dropped
// the signer key, the break-glass key or the destination binding, which is to say WHY the backups stopped and
// WHEN. If its target field ("secret-absent") falls out of the console's label table, a customer whose backups
// have stopped gets a pack whose only console-side row says "upgrade your console" instead of naming the
// real cause.
//
// A fix that targets only the one member that gets noticed leaves its siblings in the same file untouched.
// This gate compares EVERY member of EVERY audit vocabulary, in BOTH directions, so there is no member left
// to notice next time.
//
// Direction matters, and both directions fail here (unlike the client-diag gate, where the engine's surplus is
// merely unused vocabulary). A member the ENGINE writes and the console lacks makes the console lie about the
// engine. A member the CONSOLE holds and the engine cannot write is an action no operator can ever filter to
// and a target no event can ever carry: dead vocabulary in a closed union, which is its own class of defect.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

// The engine repo: an explicit override, then the unified worktree, then the merged repo. The worktree wins
// while a build is in flight, because it IS the engine that will ship. Same resolution as the client-diag gate.
// The cast is comment-only. `.filter(Boolean)` drops the undefined DOWNPIPES_ENGINE at runtime but does not
// narrow the type, so without it every use of an element reads as string | undefined.
const CANDIDATES = /** @type {string[]} */ ([
  process.env.DOWNPIPES_ENGINE,
  resolve(HERE, "../../support-unified-engine"),
  resolve(HERE, "../../support-pack-engine"),
  resolve(HERE, "../../engine"),
  resolve(HERE, "../../../engine"),
].filter(Boolean));

const ENGINE_TYPES = "src/admin/audit-types.ts";
const engineRoot = CANDIDATES.find((c) => existsSync(resolve(c, ENGINE_TYPES)));
if (engineRoot === undefined) {
  console.error("AUDIT MIRROR DRIFT GATE: FAIL -- cannot locate the engine, so the mirror cannot be compared.");
  console.error("  Set DOWNPIPES_ENGINE=/path/to/engine, or check the engine out beside this repo.");
  console.error("  This FAILS rather than skips on purpose: a gate that quietly opts out when it cannot check");
  console.error("  reads as a pass, which is the failure it exists to prevent.");
  // Exit 2, not 1: 1 is reserved for a real drift finding below. A caller that greps for
  // any non-zero exit, without reading the message, must not read "could not check" as "found a defect".
  process.exit(2);
}

// A resolved engine that is merely BEHIND its own origin/main reports every comparison against code that
// has since moved, as though it were current -- the same failure shape verify-citations.mjs can hit
// against a stale engine checkout. No fetch, so an engine whose origin/main ref is unknown is not judged
// either way; only a KNOWN positive distance refuses. AUDIT_MIRROR_ALLOW_STALE=1 proceeds anyway.
if (process.env.AUDIT_MIRROR_ALLOW_STALE !== "1") {
  /** @type {number | null} */
  let behind = null;
  try {
    behind = Number(execFileSync("git", ["-C", engineRoot, "rev-list", "--count", "HEAD..origin/main"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch { /* unknown freshness: not a repo, or no origin/main ref -- nothing to conclude, do not fail */ }
  if (Number.isFinite(behind) && /** @type {number} */ (behind) > 0) {
    console.error(`AUDIT MIRROR DRIFT GATE: FAIL -- the engine at ${engineRoot} is ${behind} commit(s) behind its own origin/main.`);
    console.error("  Every comparison below would grade the mirror against code that has since moved, and report it");
    console.error("  healthy. Update the checkout, or set AUDIT_MIRROR_ALLOW_STALE=1 if an old tree is deliberate.");
    process.exit(2);
  }
}

console.log(`AUDIT MIRROR DRIFT GATE: comparing against engine at ${engineRoot}`);

const engineSrc = readFileSync(resolve(engineRoot, ENGINE_TYPES), "utf8");
const consoleTypes = readFileSync(resolve(HERE, "../src/lib/api/types/audit.ts"), "utf8");
const consoleDisplay = readFileSync(resolve(HERE, "../src/screens/access-security/audit-display.ts"), "utf8");
const consoleShared = readFileSync(resolve(HERE, "../src/screens/access-security/shared.ts"), "utf8");

// slice returns the text BETWEEN two anchors, exclusive of both, and FAILS the gate when either anchor has
// moved. A parse that silently finds nothing is a gate that silently passes, which is the whole failure mode
// this file exists to prevent; every extractor below is length-asserted for the same reason. The start anchor
// is excluded so an anchor that itself contains a quoted member (the engine-state kind) cannot be counted as one.
function slice(src, startAnchor, endAnchor, what) {
  const a = src.indexOf(startAnchor);
  const b = a === -1 ? -1 : src.indexOf(endAnchor, a + startAnchor.length);
  if (a === -1 || b === -1) {
    console.error(`AUDIT MIRROR DRIFT GATE: FAIL -- cannot locate ${what} (the anchors moved). Fix this gate before shipping.`);
    process.exit(1);
  }
  return src.slice(a + startAnchor.length, b);
}

function members(text, re) {
  return [...text.matchAll(re)].map((m) => m[1]);
}

// The floors are PARSE-SANITY floors, not coverage floors: they catch a regex that has stopped matching
// (which would make this gate pass vacuously). The ENGINE-side floors are set near its real counts because the
// engine is the source of truth; the CONSOLE-side floors are deliberately low, so that a console member going
// MISSING is reported by compare() as the drift it is, not as a broken parse.
function assertFound(list, what, atLeast) {
  if (list.length < atLeast) {
    console.error(`AUDIT MIRROR DRIFT GATE: FAIL -- parsed only ${list.length} ${what} (expected at least ${atLeast}). The source shape changed; fix this gate.`);
    process.exit(1);
  }
  return list;
}

// ---- ENGINE side (the source of truth) ------------------------------------------------------------------
const engineActions = assertFound(members(slice(engineSrc, "export const AUDIT_ACTIONS = [", "] as const;", "the engine's AUDIT_ACTIONS"), /^\s*"([a-z0-9-]+)",/gm), "engine actions", 50);
const engineTargetBlock = slice(engineSrc, "export type AuditTarget =", "\n\n", "the engine's AuditTarget union");
const engineTargetKinds = assertFound([...new Set(members(engineTargetBlock, /kind: "([a-z-]+)"/g))], "engine target kinds", 15);
const engineStateFields = assertFound(members(slice(engineSrc, '"engine-state"; field:', "detail: string", "the engine's engine-state field union"), /"([a-zA-Z-]+)"(?=\s*[|;])/g), "engine-state fields", 2);

// ---- CONSOLE side (the mirror) --------------------------------------------------------------------------
const consoleActions = assertFound(members(slice(consoleTypes, "export type AuditAction =", "export type AuditOutcome", "the console's AuditAction union"), /^\s*\|\s*"([a-z0-9-]+)"/gm), "console actions", 5);
const consoleTargetBlock = slice(consoleTypes, "export type AuditTarget =", "export interface AuditEvent", "the console's AuditTarget union");
const consoleTargetKinds = assertFound([...new Set(members(consoleTargetBlock, /readonly kind: "([a-z-]+)"/g))], "console target kinds", 5);
const consoleStateFields = assertFound(members(slice(consoleTargetBlock, '"engine-state"; readonly field:', "readonly detail", "the console's engine-state field union"), /"([a-zA-Z-]+)"(?=\s*[|;])/g), "console engine-state fields", 1);
const actionLabels = assertFound(members(slice(consoleDisplay, "const AUDIT_ACTION_LABELS", "};", "AUDIT_ACTION_LABELS"), /^\s*"([a-z0-9-]+)":/gm), "action labels", 5);
const groupedActions = assertFound(members(slice(consoleDisplay, "export const AUDIT_ACTION_GROUPS", "\n];", "AUDIT_ACTION_GROUPS"), /"([a-z0-9-]+)"/g).filter((a) => engineActions.includes(a) || !a.includes(" ")), "grouped actions", 5);
const describedKinds = assertFound([...new Set(members(slice(consoleDisplay, "export function describeTarget", "export function outcomeStatus", "describeTarget"), /^\s*case "([a-z-]+)":/gm))], "described target kinds", 5);
const stateFieldLabels = assertFound(members(slice(consoleShared, "export const ENGINE_STATE_FIELD_LABELS", "};", "ENGINE_STATE_FIELD_LABELS"), /^\s*"([a-zA-Z-]+)":/gm), "engine-state field labels", 1);

const failures = [];
function compare(what, engine, consoleSide, missingWhy, surplusWhy) {
  for (const m of engine) if (!consoleSide.includes(m)) failures.push(`${what}: "${m}" is written by the ENGINE and is MISSING from the console. ${missingWhy}`);
  for (const m of consoleSide) if (!engine.includes(m)) failures.push(`${what}: "${m}" is held by the CONSOLE and the engine cannot write it. ${surplusWhy}`);
}

compare("AuditAction union (src/lib/api/types/audit.ts)", engineActions, consoleActions, "The audit filter cannot select the event, and the action renders as a hyphen-stripped internal noun.", "Dead vocabulary: a filter option that can never match a row.");
compare("AUDIT_ACTION_LABELS (audit-display.ts)", engineActions, actionLabels, "The operator is shown the raw internal noun.", "Dead label.");
compare("AUDIT_ACTION_GROUPS (audit-display.ts)", engineActions, [...new Set(groupedActions)], "The action is not offered in the server-side filter, so the trail cannot be narrowed to it.", "Dead filter option.");
compare("AuditTarget union (src/lib/api/types/audit.ts)", engineTargetKinds, consoleTargetKinds, "describeTarget takes the default arm: it renders 'unrecognised target (newer engine?)' AND records a FALSE contract-skew row against an in-lockstep pair.", "Dead target variant.");
compare("describeTarget cases (audit-display.ts)", engineTargetKinds, describedKinds, "The kind falls to the default arm and files a FALSE contract-skew row.", "Dead case arm.");
compare("engine-state field union (src/lib/api/types/audit.ts)", engineStateFields, consoleStateFields, "The field cannot be narrowed by tsc and its label cannot be relied on.", "Dead field member.");
compare("ENGINE_STATE_FIELD_LABELS (access-security/shared.ts)", engineStateFields, stateFieldLabels, "describeTarget records a FALSE contract-skew{unknown-enum-member, audit-field-name} row: support is told to upgrade a console that is in lockstep with its engine.", "Dead label.");

const dupes = groupedActions.filter((a, i) => groupedActions.indexOf(a) !== i);
for (const d of [...new Set(dupes)]) failures.push(`AUDIT_ACTION_GROUPS: "${d}" appears in more than one group, so the filter select offers it twice.`);

console.log(`  engine actions ${engineActions.length}, console actions ${consoleActions.length}, labels ${actionLabels.length}, filter options ${groupedActions.length}`);
console.log(`  engine target kinds ${engineTargetKinds.length}, console target kinds ${consoleTargetKinds.length}, describeTarget cases ${describedKinds.length}`);
console.log(`  engine-state fields ${engineStateFields.length}, console fields ${consoleStateFields.length}, labels ${stateFieldLabels.length}`);

if (failures.length > 0) {
  console.error(`\nAUDIT MIRROR DRIFT GATE: FAIL -- ${failures.length} drift(s) between the engine's audit vocabulary and the console's mirror:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("AUDIT MIRROR DRIFT GATE: PASS -- every audit action, target kind and engine-state field matches in both directions.");
