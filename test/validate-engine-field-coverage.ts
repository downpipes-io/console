// Every field the engine reports on a restore must reach the console's type boundary.
//
// WHY THIS EXISTS
// ---------------
// Twice now the engine has computed something an operator needed and the console has silently dropped it.
// The cross-zone warning was rendered nowhere, so the first sight of a wrong-zone restore was the engine
// refusing an apply the operator had already confirmed. Then five RestoreResult fields turned out not to
// be DECLARED on the console's type at all, so they arrived on the wire and were discarded at the type
// boundary: mediaFaults, mediaConflictDigests, d1Fault, d1SchemaObjectsFiltered and metadataFieldsDropped.
// Every one of those exists in the engine because the shortfall used to be silent, and the console had
// quietly reinstated the silence while showing a success tick.
//
// Neither gap was visible from either side alone. The engine's tests pass because it reports correctly;
// the console's tests pass because it renders what it declares. Only a cross-repo comparison finds it.
//
// WHAT THIS CHECKS, AND WHAT IT DOES NOT
// --------------------------------------
// It checks DECLARATION, not rendering. A field declared but unrendered is a judgement call about screen
// space; a field not declared cannot be rendered at all and is never a decision anyone made. Requiring
// declaration is the line that can be enforced without arguing about layout.
//
// The engine is read from DOWNPIPES_ENGINE (or ../engine). Absent, this SKIPS rather than fails: the
// console must still build without the engine beside it.
//
//   node test/validate-engine-field-coverage.ts

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verdictCannotCheck, verdictReached, verdictSkipped } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// Fields a console is not expected to declare, each with the reason it is exempt. Deliberately tiny: an
// exemption is a claim that an operator never needs the field, and that claim should be argued once here
// rather than assumed silently by omission.
const EXEMPT: Record<string, string> = {
  mode: "the console already knows which call it made",
  runId: "carried by the caller, not learned from the response",
};

function fieldsOf(src: string, iface: string): string[] {
  const m = new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`).exec(src);
  if (m === null) return [];
  const out: string[] = [];
  for (const line of m[1]!.split("\n")) {
    const f = /^\s{2}(\w+)\??:/.exec(line);
    if (f !== null) out.push(f[1]!);
  }
  return out;
}

// Resolving the engine is not "../engine", and getting that wrong is worse than skipping.
//
// This console is routinely run from console/.worktrees/<name>, where "../engine" resolves to
// console/.worktrees/engine. That path EXISTS in this workspace: it is another session's engine worktree,
// on whatever branch that session is using. The first version of this gate defaulted there and reported a
// confident PASS against an engine nobody chose. Walk up out of any .worktrees/<name> segment to the
// workspace root, exactly as engine/scripts/resync-surface-counts.mjs does, and print what was read, so a
// green names its own source.
function resolveEngine(): string {
  const explicit = process.env.DOWNPIPES_ENGINE;
  if (explicit !== undefined && explicit !== "") return resolve(explicit);
  const here = process.cwd();
  const root = here.includes("/.worktrees/") ? resolve(here.split("/.worktrees/")[0]!, "..") : resolve(here, "..");
  return resolve(root, "engine");
}

const enginePath = resolveEngine();
const engineTypes = resolve(enginePath, "src/admin/restore-types.ts");
// REQUIRE_ENGINE=1 turns the skip into a failure, matching test/engine-path.ts. Without it this gate
// honoured no flag at all, so it could skip inside `npm run validate:workspace`, the one chain that exists
// to run it against a real engine, and report a pass having compared nothing.
if (!existsSync(engineTypes) && process.env.REQUIRE_ENGINE === "1") {
  // A REFUSAL, NOT A FINDING. This printed a FAIL line and exited 1. Every expectation in this
  // file is READ OUT OF the engine's own restore-types.ts, so with no engine there is no expectation to
  // compare the console against and nothing here graded anything. Exit 1 says the console is wrong, which
  // this run has no evidence for either way. Exit 2 is what the same absence already produces in
  // scripts/stepup-call-site-gate.mjs, test/validate-audit-mirror.ts and test/validate-notifications.ts.
  verdictCannotCheck(
    `validate-engine-field-coverage: REFUSED, REQUIRE_ENGINE=1 and there is no engine at ${enginePath}.\n` +
      "  The field set this file grades is read from the engine's own src/admin/restore-types.ts, so with no\n" +
      "  engine there is nothing here that compares anything and it will not report that it did.\n" +
      "  This is the cross-repo chain, so a missing engine is a configuration fault to fix.\n" +
      "  Point it at one with DOWNPIPES_ENGINE=/path/to/engine, or check the engine out beside this repo.",
  );
}
// A SKIP IS A VERDICT, and it has to be declared as one. Reaching the tally below with zero failures and
// zero assertions printed is exactly the "passed by examining nothing" shape the guard exists to catch, so
// it correctly forces exit 1 there. This path is a real, deliberate precondition (the console CI Lint job
// checks console out ALONE, so no engine is beside it), and it is declared with verdictSkipped, which is
// enrolment rather than a bypass: the skip is announced on one greppable line instead of being inferred
// from a silent exit 0. REQUIRE_ENGINE=1 above already turns the same absence into a failure for the one
// chain that must have an engine.
if (!existsSync(engineTypes)) {
  verdictSkipped(`no engine at ${enginePath}, so the console's restore types were compared against nothing`);
  process.exit(0);
} else {
  console.log(`  engine read from ${enginePath}`);
  const engineSrc = readFileSync(engineTypes, "utf8");
  const consoleSrc = readFileSync(new URL("../src/lib/api/types/restore-types.ts", import.meta.url), "utf8");

  for (const iface of ["RestorePlan", "RestoreResult"]) {
    const engineFields = fieldsOf(engineSrc, iface);
    const consoleFields = new Set(fieldsOf(consoleSrc, iface));
    ok(`the engine's ${iface} was parsed, so this gate is not vacuous`, engineFields.length > 5);
    const missing = engineFields.filter((f) => !consoleFields.has(f) && EXEMPT[f] === undefined);
    ok(`every ${iface} field the engine reports is declared in the console (missing: ${missing.join(", ") || "none"})`, missing.length === 0);
  }
  ok("the console declares the fidelity-shortfall fields specifically", ["mediaFaults", "d1Fault", "d1SchemaObjectsFiltered", "metadataFieldsDropped"].every((f) => consoleSrc.includes(f)));
}

console.log(failures === 0 ? "\nENGINE FIELD COVERAGE PASS" : `\n${failures} FAILURE(S)`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) process.exit(1);
