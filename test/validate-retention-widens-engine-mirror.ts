// retentionWidensPrune in the console (src/screens/sources-downpipes/helpers.ts) mirrors the engine's rule
// of the same name (engine/src/sched/destinations.ts) so the client gate blocks exactly what the DO's
// addDownpipe restore.apply re-check (scheduler-do.ts) would 403 on. Nothing wires the two together, so a
// change on either side that the other does not follow would drift silently: an over-eager console gate
// would refuse a save the engine would accept, and an under-eager one would let an operator submit an arm
// the engine then 403s on. This file runs BOTH functions over one shared vector table and fails on any
// disagreement, between the two functions or against the vector's own expectation.
//
// It reads the engine's source (a cross-repo check), so it lives in validate:workspace:chain beside the
// other mirror gates. With no engine beside this checkout it REFUSES rather than passing: a mirror check
// that cannot see the thing it mirrors has answered nothing. Run:
//   DOWNPIPES_ENGINE=/path/to/engine node test/validate-retention-widens-engine-mirror.ts
//
// engine/src/sched/destinations.ts is a leaf module with no imports of its own (its header comment says
// so), so it loads standalone under plain Node with no Workers-only global in its path.

import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { retentionWidensPrune as consoleRetentionWidensPrune } from "../src/screens/sources-downpipes/helpers.ts";
import { engineRoot } from "./engine-root.ts";
import { verdictCannotCheck, verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

const root = engineRoot();
if (root === null) {
  console.error("validate-retention-widens-engine-mirror: REFUSED, the engine is not beside this checkout.");
  console.error("  This check runs the engine's own retentionWidensPrune and compares it against the");
  console.error("  console's mirror, so with no engine it cannot answer its question and will not report");
  console.error("  that it did. Point it at one with DOWNPIPES_ENGINE=/path/to/engine and re-run.");
  verdictCannotCheck();
}

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

interface Scope {
  destinationId?: string;
  destinationIds?: string[];
  retention?: { keepRuns?: number; keepDays?: number; enforce?: boolean };
}
type EngineRetentionWidensPrune = (prior: Scope | undefined, next: Scope) => boolean;

const engineModuleUrl = pathToFileURL(join(root, "src/sched/destinations.ts")).href;
const engineModule = (await import(engineModuleUrl)) as { retentionWidensPrune?: EngineRetentionWidensPrune };
const engineRetentionWidensPrune = engineModule.retentionWidensPrune;
// A beside-checkout engine that predates this rule is a REFUSAL, not a fail: this checkout has nothing
// wrong with it, the sibling simply does not carry the function yet (the rule can land on the engine's
// main after this console change, same as any other cross-repo mirror check beside it).
if (typeof engineRetentionWidensPrune !== "function") {
  console.error("validate-retention-widens-engine-mirror: REFUSED, the engine beside this checkout has no");
  console.error("  retentionWidensPrune export in src/sched/destinations.ts (its main predates the rule).");
  console.error("  Point DOWNPIPES_ENGINE at a checkout carrying it and re-run.");
  verdictCannotCheck();
}

// The shared vector table. Every case the console's own 25-check suite
// (validate-retention-arm-console.ts, section A) covers, plus: an explicit create (prior undefined, not an
// empty object), a replica PROMOTED to primary (a stored replica that is no longer a replica because it is
// now the primary, not because it left the list), enforce absent read the same as enforce false on either
// side, and a stored bound going to the literal zero read the same as any other lower value, distinct from
// a bound that was never stored (absent) and so is never compared.
const VECTORS: Array<{ name: string; prior: Scope | undefined; next: Scope; expected: boolean }> = [
  { name: "create with enforce true (prior is undefined, not {})", prior: undefined, next: { retention: { keepRuns: 5, enforce: true } }, expected: true },
  { name: "arm from stored enforce false", prior: { retention: { keepRuns: 5, enforce: false } }, next: { retention: { keepRuns: 5, enforce: true } }, expected: true },
  { name: "lowering keepRuns while armed", prior: { retention: { keepRuns: 10, enforce: true } }, next: { retention: { keepRuns: 5, enforce: true } }, expected: true },
  { name: "removing keepRuns while armed", prior: { retention: { keepRuns: 10, enforce: true } }, next: { retention: { enforce: true } }, expected: true },
  { name: "raising keepRuns while armed", prior: { retention: { keepRuns: 10, enforce: true } }, next: { retention: { keepRuns: 20, enforce: true } }, expected: false },
  { name: "a round trip (the same stored value)", prior: { retention: { keepRuns: 10, enforce: true } }, next: { retention: { keepRuns: 10, enforce: true } }, expected: false },
  { name: "turning enforce off, even while removing a bound", prior: { retention: { keepRuns: 10, enforce: true } }, next: { retention: { enforce: false } }, expected: false },
  { name: "unpinning a replica while armed", prior: { retention: { keepRuns: 10, enforce: true }, destinationIds: ["d1", "d2"] }, next: { retention: { keepRuns: 10, enforce: true }, destinationIds: ["d1"] }, expected: true },
  { name: "adding a replica while armed", prior: { retention: { keepRuns: 10, enforce: true }, destinationIds: ["d1"] }, next: { retention: { keepRuns: 10, enforce: true }, destinationIds: ["d1", "d2"] }, expected: false },
  { name: "a replica promoted to primary (still listed, no longer a replica)", prior: { retention: { keepRuns: 10, enforce: true }, destinationIds: ["d1", "d2"] }, next: { retention: { keepRuns: 10, enforce: true }, destinationIds: ["d2", "d1"] }, expected: true },
  { name: "enforce absent on next reads as enforce false: no widen", prior: { retention: { keepRuns: 10, enforce: true } }, next: { retention: { keepRuns: 5 } }, expected: false },
  { name: "enforce absent on prior reads as enforce false: arming still widens", prior: { retention: { keepRuns: 10 } }, next: { retention: { keepRuns: 10, enforce: true } }, expected: true },
  { name: "a bound absent on prior is never compared, even against a small next value", prior: { retention: { keepDays: 30, enforce: true } }, next: { retention: { keepRuns: 1, keepDays: 30, enforce: true } }, expected: false },
  { name: "a stored bound going to the literal zero is a lower value, not an absence", prior: { retention: { keepRuns: 10, enforce: true } }, next: { retention: { keepRuns: 0, enforce: true } }, expected: true },
];

for (const v of VECTORS) {
  const consoleResult = consoleRetentionWidensPrune(v.prior, v.next);
  const engineResult = engineRetentionWidensPrune(v.prior, v.next);
  ok(`${v.name}: console = ${v.expected}`, consoleResult === v.expected);
  ok(`${v.name}: engine = ${v.expected}`, engineResult === v.expected);
  ok(`${v.name}: console and engine agree`, consoleResult === engineResult);
}

console.log(failures === 0 ? `\nRETENTION WIDENS PRUNE ENGINE MIRROR OK (${checks} checks)` : `\n${failures} FAILURE(S) of ${checks}`);
verdictReached(failures, checks);
if (failures > 0) process.exit(1);
