// Every restore descriptor the engine can shed must have its OWN sentence in the console.
//
// WHY THIS EXISTS
// ---------------
// The engine added `kv-expiration-lapsed` beside `kv-expiration`, and its own comment on
// METADATA_SHED_FIELDS says why the two are separate members rather than one: an UNUSABLE expiration is a
// defect signal, while a LAPSED one is the ordinary consequence of restoring a backup older than the
// namespace's TTLs. The remedy is the same and the conversation with the customer is not.
//
// The console collapsed them straight back into one sentence, `N record(s) lost their <field>, which could
// not be reproduced`, printed over the RAW WIRE KEY. So the case a customer meets whenever they restore an
// old archive was reported with the defect wording and in the transport's words. The console suite was green
// throughout, because its only fixture used an invented field name and asserted structure.
//
// WHAT IT CHECKS
// --------------
// It reads METADATA_SHED_FIELDS out of the engine and DRIVES the real `fidelityShortfalls` with each member,
// requiring that the sentence is the member's own rather than the fall-through, that it never prints the wire
// key, and that it carries the count. It checks the rendered TEXT, because the defect was a line that
// appeared and said the wrong thing: a check that only counts lines passes on the defect it exists to catch.
//
// It does NOT check the wording of a phrase beyond that. What a sentence says to a customer is a judgement;
// a member with no sentence at all is never a decision anyone made.
//
// The fall-through is proved to be reachable by a member the console has never heard of, so "every member has
// its own arm" is measured against a control rather than asserted into a vacuum.
//
// WHY IT REFUSES RATHER THAN SKIPS WHEN THE ENGINE IS ABSENT
// ----------------------------------------------------------
// Same reason as its sibling `validate-restore-reason-vocabulary.ts`: a skip reports the same green as a pass
// on the exact question this file exists to answer, and the console has already been wrong about it once.
//
// House style: Australian English, no em dashes, no rule-of-three.
//
//   node test/validate-metadata-shed-vocabulary.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installDomShim } from "./dom-shim.ts";
installDomShim();

import type { RestoreResult } from "../src/lib/api/types/restore-types.ts";
import { fidelityShortfalls } from "../src/screens/restore-flow/receipt.ts";
import { verdictCannotCheck, verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts
import { engineRoot } from "./engine-root.ts";

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
  console.error("validate-metadata-shed-vocabulary: REFUSED, the engine is not beside this checkout.");
  console.error("  This check compares the console's shed phrases against the engine's own closed list,");
  console.error("  so with no engine it cannot answer its question and will not report that it did.");
  console.error("  Point it at one with DOWNPIPES_ENGINE=/path/to/engine and re-run.");
  verdictCannotCheck();
}

const enginePath = resolve(root, "src/dest/restore-fault.ts");
const engineSrc = readFileSync(enginePath, "utf8");

// Read the members rather than re-typing them. A copy checked against a copy proves nothing, and re-typing
// is how the console came to have a vocabulary that had never matched the engine's.
const listMatch = engineSrc.match(/METADATA_SHED_FIELDS\s*=\s*\[([^\]]*)\]/);
if (listMatch === null) {
  console.error(`validate-metadata-shed-vocabulary: REFUSED, could not find METADATA_SHED_FIELDS in ${enginePath}.`);
  console.error("  The engine's declaration shape changed. Fix this reader rather than dropping the check.");
  verdictCannotCheck();
}

const fields = [...(listMatch[1] ?? "").matchAll(/"([^"]+)"/g)]
  .map((m) => m[1])
  .filter((f): f is string => typeof f === "string" && f !== "");

// A degraded parse reads as an empty list, and an empty list passes every loop below. The floor is the
// difference between "checked three members" and "checked nothing and said nothing".
if (fields.length < 2) {
  console.error(`validate-metadata-shed-vocabulary: REFUSED, parsed only ${fields.length} field(s) from the engine.`);
  verdictCannotCheck();
}

const base: RestoreResult = {
  ok: true,
  runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  mode: "applied",
  recordsVerified: 10,
  recordsRestored: 10,
  bytesRestored: 1024,
  isLatest: true,
  failures: [],
  complete: true,
};

const COUNT = 7;
const lineFor = (field: string): string | null => {
  const lines = fidelityShortfalls({ ...base, metadataFieldsDropped: { [field]: COUNT } });
  return lines.length === 1 ? (lines[0] ?? null) : null;
};

// THE CONTROL, run first. A member the console has never heard of must reach the fall-through, otherwise
// "this member has its own arm" is being measured against nothing and every member would pass.
const UNKNOWN = "dp-control-field-that-does-not-exist";
const fallThrough = lineFor(UNKNOWN);
if (fallThrough === null) {
  console.error("validate-metadata-shed-vocabulary: REFUSED, the control field produced no single shortfall line.");
  verdictCannotCheck();
}
if (!fallThrough.includes(UNKNOWN)) {
  console.error("validate-metadata-shed-vocabulary: REFUSED, the control field did not reach the fall-through arm,");
  console.error(`  so this check cannot tell an own arm from the default. It rendered: ${fallThrough}`);
  verdictCannotCheck();
}
ok(`the fall-through arm is reachable, proved with a field the console has never heard of`);

// The shape the fall-through renders for a given field name, which is what "has no arm of its own" looks
// like from the outside.
const fallThroughFor = (field: string): string => fallThrough.replace(UNKNOWN, field);

const seen = new Map<string, string>();
for (const field of fields) {
  const line = lineFor(field);
  if (line === null) {
    fail(`"${field}" does not produce exactly one shortfall line, so the receipt cannot report it`);
    continue;
  }
  if (line === fallThroughFor(field)) {
    fail(`the engine can shed "${field}" and the console has no sentence for it, so the receipt renders the wire key`);
    continue;
  }
  ok(`"${field}" has its own sentence`);

  if (line.includes(field)) fail(`"${field}" reaches the operator as the raw wire key: ${line}`);
  else ok(`"${field}" is described in the operator's words rather than the transport's`);

  if (!line.includes(String(COUNT))) fail(`"${field}" drops the count, so the operator cannot tell one record from a thousand`);
  else ok(`"${field}" carries its count`);

  const twin = seen.get(line);
  if (twin !== undefined) {
    fail(`"${field}" and "${twin}" render the same sentence, which is the conflation these members exist to end`);
  }
  seen.set(line, field);
}

ok(`compared ${fields.length} engine shed field(s) against the console's phrases`);

verdictReached(failures, checks);
console.log(`\nVERDICT: ${failures === 0 ? "PASS" : "FAIL"} failures=${failures} checks=${checks} entry=validate-metadata-shed-vocabulary.ts`);
process.exit(failures === 0 ? 0 : 1);
