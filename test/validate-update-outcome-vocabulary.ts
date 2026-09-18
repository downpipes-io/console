// Every settle outcome the engine can PERSIST must be a state this console can render and act on.
//
// WHY THIS EXISTS
// ---------------
// The engine's update outcome enum has seven members (src/admin/update-apply.ts). Two of them exist
// BECAUSE the enum used to assert the opposite of reality, and the engine's own comment says so:
//
//   rollback-failed       the canary said no, the automatic rollback deploy ITSELF failed, and the engine
//                         is STILL SERVING THE BAD BUILD.
//   applied-unconfirmed   the promote was accepted and the confirming read-back could not be performed,
//                         so the engine cannot prove which version is live.
//
// The engine writes whichever one happened straight into `last.outcome` (router-updates.ts, the
// /update-settled write), clears `pending` and drops `rollbackNeeded` in the same DO write.
//
// The console's own wire union carried nine members and neither of those two. Every reader keyed off it
// then fell through its default arm, so on the single most dangerous state the update path can reach the
// licence screen showed a green "Up to date" tile, no last-update line, no rollback control, and a live
// apply flow whose last words were "Still verifying". The engine grew two honest members; nothing told
// the console, and nothing was checking.
//
// A comment claiming parity with another repository, with nothing checking it, is what let that sit. The
// console's union carries exactly such a comment ("MUST track what the engine actually writes"), which is
// why the parity is checked here rather than asserted there.
//
// WHAT IT CHECKS, and it checks DECLARATION rather than wording
// -------------------------------------------------------------
// It reads the UpdateOutcome union out of the engine's update-apply.ts, subtracts the members the engine
// can only ever RETURN and never persist as a settled outcome (dry-run, no-update, refused and promoted
// are handled on their own paths and are listed here with the reason), and requires, for each remaining
// member:
//
//   1. a literal member in the console's UpdateStatusRecord["last"].outcome union,
//   2. a literal arm in recordedSettleOutcome, so the settle recovery does not read it as "unknown",
//   3. a literal arm in lastUpdateSummary, so a fresh page load onto that state is not silent,
//   4. a literal arm in updateUnresolved, which is what stops the summary tile claiming "Up to date" over a
//      state the engine cannot prove it is out of. That one is checked only for the members that ARE such a
//      state, named below, because an ordinary applied or rolled-back settle correctly reads "none" there.
//
// It does not grade the sentences. What a surface says about an incident is a judgement; a member nobody
// declared is never a judgement anyone made.
//
// WHY IT REFUSES RATHER THAN SKIPS WHEN THE ENGINE IS ABSENT
// ----------------------------------------------------------
// The sibling precedent is validate-restore-reason-vocabulary.ts and the reason is identical: a skip here
// reports the same green as a pass, on the exact question this console has already been wrong about. It
// exits at verdictCannotCheck's own code with a sentence naming the missing engine.
//
// AND IT ASSERTS ITS OWN POPULATION
// ---------------------------------
// A parse that degrades to nothing would compare an empty set against an empty set and pass. So the
// engine union must parse to at least five members AND must contain the two members named above, which
// are the ones this check was written for. Without that floor "every engine outcome is declared" is also
// true of a run that read no outcomes.
//
// House style: Australian English, no em dashes, no rule-of-three.
//
//   node test/validate-update-outcome-vocabulary.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verdictCannotCheck, verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts
import { engineRoot } from "./engine-root.ts";

const HERE = new URL(".", import.meta.url).pathname;

/** The console's own sources, which are always present. */
const WIRE_TYPES = resolve(HERE, "../src/lib/api/types/updates.ts");
const LICENCE_SHARED = resolve(HERE, "../src/screens/licence/shared.ts");

// The engine members that are NOT settled outcomes, each with the reason it is excluded rather than a bare
// list. They never reach setUpdateSettled's `last.outcome` on the apply path:
//   dry-run    verified and planned; nothing was uploaded or promoted, so nothing settles,
//   no-update  already on the recommended version, the route short-circuits before a pending exists,
//   refused    aborted BEFORE going live; the engine is unchanged and no pending was armed.
// "promoted" is not an engine UpdateOutcome member at all (it is the promote PHASE's own word, which the
// console's wire union carries separately), so it needs no exclusion here.
const NOT_SETTLED: ReadonlySet<string> = new Set(["dry-run", "no-update", "refused"]);

// The two members this check was written for. Their presence in the parsed engine union is what proves the
// parse read the real thing.
const MUST_BE_PRESENT = ["rollback-failed", "applied-unconfirmed"] as const;

let failures = 0;
let checks = 0;

function fail(msg: string): void {
  failures += 1;
  console.error(`  FAIL ${msg}`);
}

function ok(msg: string): void {
  checks += 1;
  console.log(`  ok   ${msg}`);
}

const root = engineRoot();
if (root === null) {
  console.error("validate-update-outcome-vocabulary: REFUSED, the engine is not beside this checkout.");
  console.error("  This check compares the console's settled-outcome vocabulary against the engine's own");
  console.error("  closed enum, so with no engine it cannot answer its question and will not report that it did.");
  console.error("  Point it at one with DOWNPIPES_ENGINE=/path/to/engine and re-run.");
  verdictCannotCheck();
}

const enginePath = resolve(root, "src/admin/update-apply.ts");
const engineSrc = readFileSync(enginePath, "utf8");

// The engine declares the union on one line as an exported type alias. Read the members rather than
// re-typing them, which is the whole point: a copy checked against a copy proves nothing.
const unionMatch = engineSrc.match(/export type UpdateOutcome\s*=\s*([^;]+);/);
if (unionMatch === null) {
  console.error(`validate-update-outcome-vocabulary: REFUSED, could not find "export type UpdateOutcome" in ${enginePath}.`);
  console.error("  The engine's declaration shape changed. Fix this reader rather than dropping the check.");
  verdictCannotCheck();
}

const engineMembers = [...(unionMatch[1] ?? "").matchAll(/"([^"]+)"/g)]
  .map((m) => m[1])
  .filter((c): c is string => typeof c === "string" && c !== "");

// POPULATION FLOOR. An empty or degraded parse means this reader broke, not that the engine shrank.
if (engineMembers.length < 5) {
  console.error(`validate-update-outcome-vocabulary: REFUSED, parsed only ${engineMembers.length} member(s) from the engine's UpdateOutcome.`);
  verdictCannotCheck();
}
for (const required of MUST_BE_PRESENT) {
  if (!engineMembers.includes(required)) {
    console.error(`validate-update-outcome-vocabulary: REFUSED, the engine's UpdateOutcome does not contain "${required}".`);
    console.error("  That member is the reason this check exists. Either the engine deliberately removed it (say so");
    console.error("  here and in the console) or this reader is parsing the wrong declaration. It will not pass blind.");
    verdictCannotCheck();
  }
}
ok(`parsed ${engineMembers.length} engine UpdateOutcome member(s), including ${MUST_BE_PRESENT.join(" and ")}`);

const settled = engineMembers.filter((m) => !NOT_SETTLED.has(m));
if (settled.length < 2) {
  console.error(`validate-update-outcome-vocabulary: REFUSED, only ${settled.length} settled member(s) survived the exclusion list.`);
  verdictCannotCheck();
}
ok(`${settled.length} of them can be PERSISTED as last.outcome: ${settled.join(", ")}`);

// ---- 1. the console's wire union -------------------------------------------------------------------
const wireSrc = readFileSync(WIRE_TYPES, "utf8");
// Bound the search to the UpdateSettledOutcome interface's own outcome declaration (the named shape
// `last` and `lastConsole` both point at, since 0.2.2's multi-component-updates fix pulled it out of an
// inline `last: null | { ... }` literal so lastConsole could share it byte-for-byte), so an
// identically-spelled member in the pending shape or in a ramp union cannot satisfy this check. That is
// the assertion-satisfied-by-the-wrong-text shape the sibling validator warns about.
const lastStart = wireSrc.indexOf("export interface UpdateSettledOutcome {");
const lastOutcome = lastStart === -1 ? null : wireSrc.slice(lastStart).match(/\n\s*outcome:\s*([^;]+);/);
if (lastOutcome === null) {
  fail("could not find the UpdateSettledOutcome.outcome union in src/lib/api/types/updates.ts, so nothing types what the engine records");
} else {
  const declared = new Set([...(lastOutcome[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  for (const member of settled) {
    if (declared.has(member)) ok(`last.outcome declares "${member}"`);
    else fail(`the engine persists "${member}" and the console's last.outcome union does not declare it, so every reader keyed off that union falls through its default arm`);
  }
}

// ---- 2 and 3. the two readers that decide what an operator is told --------------------------------
const sharedSrc = readFileSync(LICENCE_SHARED, "utf8");

function armsOf(fnName: string): string | null {
  const start = sharedSrc.indexOf(`export function ${fnName}`);
  if (start === -1) return null;
  const end = sharedSrc.indexOf("\n}", start);
  return sharedSrc.slice(start, end === -1 ? undefined : end);
}

for (const [fnName, why, only] of [
  ["recordedSettleOutcome", 'the settle recovery reads it as "unknown", which renders the honest-but-wrong "Still verifying" stall line', null],
  ["lastUpdateSummary", "a fresh page load onto that state shows no last-update line at all", null],
  ["updateUnresolved", 'the summary tile falls through to "Up to date", which claims a proof the engine did not obtain', MUST_BE_PRESENT],
] as const) {
  const body = armsOf(fnName);
  if (body === null) {
    fail(`${fnName} is not exported from src/screens/licence/shared.ts, so nothing maps a recorded outcome`);
    continue;
  }
  const subject = only === null ? settled : settled.filter((m) => (only as readonly string[]).includes(m));
  if (subject.length === 0) {
    fail(`${fnName} was checked against ZERO members, so its arms were not graded at all`);
    continue;
  }
  for (const member of subject) {
    const escaped = member.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`"${escaped}"`).test(body)) ok(`${fnName} has an arm for "${member}"`);
    else fail(`the engine persists "${member}" and ${fnName} has no arm for it, so ${why}`);
  }
}

verdictReached(failures, checks);
console.log(`\nVERDICT: ${failures === 0 ? "PASS" : "FAIL"} failures=${failures} checks=${checks} entry=validate-update-outcome-vocabulary.ts`);
process.exit(failures === 0 ? 0 : 1);
