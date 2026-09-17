#!/usr/bin/env node
// Field-bounds gate: a control whose catalogue row states a bound must be able to refuse a value
// outside it, at the field, on blur.
//
// THE DEFECT THIS GUARDS AGAINST. components/field.ts validates on blur only when the field carries
// a rule:
//
//     control.addEventListener("blur", () => {
//       if (opts.required || opts.validate) validate();
//     });
//
// A field() call that passes neither is therefore SILENT on blur by construction, whatever its
// catalogue row says it accepts and whatever its own hint tells the operator. A field can accept a
// value that flatly contradicts its own hint: a "1 to 64 chars" hint with no enforcement takes a
// 65th character, and a "whole number, 1 to 10,000" hint takes 0 or a negative number just as
// easily. The refusal, where one exists at all, comes later and elsewhere, at a form-level error on
// submit, so an operator who never presses Save is never told.
//
// THE RULE, NOT A LIST (internal-docs/GUARD-THAT-CHECKS-A-LIST.md). This gate names no field. It
// asks a property of every field() call the census finds: if the catalogue states a bound for it,
// it must carry `required` or `validate`. A control added tomorrow with a bounded accepted_values
// cell and no validator fails this gate on its first run, which naming known offenders by hand could
// never do.
//
// WHAT IT DOES NOT CLAIM. Carrying a validator is not proof the validator is correct, or that its
// message is helpful. That is test/validate-field-bounds.ts, which drives the real controls and
// asserts each message's exact identity. This gate closes the structural hole underneath it: a
// field with no rule at all cannot refuse anything, so no message test can even be written for it.
//
// Usage:
//   node scripts/field-bounds-gate.mjs                          use the committed census
//   node scripts/field-bounds-gate.mjs --census <path>          use a freshly written one
//   node scripts/field-bounds-gate.mjs --list                   print every bounded field and its state

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findWorkspaceDir } from "./workspace-root.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// WHERE THE CATALOGUE LIVES, resolved rather than assumed. join(HERE, "..", "..") would assert that
// the console checkout's parent is the workspace root, which is true of the primary checkout and of no
// worktree. The floors below catch a truncated file, but not a wrong one: the inputs can resolve to a
// DIFFERENT repo's real files that are plausibly sized, so the gate would grade this checkout's controls
// against another checkout's bounds and report a confident, wrong number. Refuse instead.
const MARKER = join("internal-docs", "FIELD-CATALOGUE", "catalogue.jsonl");
const WORKSPACE = findWorkspaceDir(join(HERE, ".."), MARKER);
if (WORKSPACE === null) {
  console.error(`\nFATAL field-bounds: could not resolve the workspace root from ${join(HERE, "..")}.`);
  console.error(`  Tried the direct parent and the owner of any .worktrees segment; none carries ${MARKER}`);
  console.error("  outside a .worktrees directory, which is refused however it is reached.");
  console.error("  Check internal-docs out beside this repo, or set DOWNPIPES_WORKSPACE=/path/to/workspace-root.\n");
  process.exit(2);
}
const CAMPAIGN = join(WORKSPACE, "internal-docs", "FIELD-CATALOGUE");
const CATALOGUE = join(CAMPAIGN, "catalogue.jsonl");
const censusArg = process.argv.indexOf("--census");
const CENSUS = censusArg > -1 ? process.argv[censusArg + 1] : join(CAMPAIGN, "field-census.jsonl");
const LIST = process.argv.includes("--list");

// ---- refuse to run rather than pass hollow -----------------------------------------------------
// A gate whose inputs went missing reads exactly like a gate that found nothing wrong. Both files
// are required, and both are floored: the catalogue has held 260-plus rows since it was built and
// the census 250-plus controls, so a fraction of that is a moved layout or a half-written file, not
// a shrinking console.
// Exit 2, not 1: a missing input is "could not check", which is a different fact from "a bound is
// unenforceable" and must not share an exit code with it.
for (const [label, path] of [["catalogue", CATALOGUE], ["census", CENSUS]]) {
  if (!existsSync(path)) {
    console.error(`FATAL field-bounds: no ${label} at ${path}. Run 'node scripts/field-census.mjs' first, and check the internal-docs sibling is checked out.`);
    process.exit(2);
  }
}
const readJsonl = (p) => readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const catalogue = readJsonl(CATALOGUE);
const census = readJsonl(CENSUS);
// EXIT 2, THE SAME AS THE ABSENT-FILE REFUSAL ABOVE. A file that is not there and a file that is there but
// truncated are the same fact for this gate: it has no usable catalogue or census, so it cannot establish
// anything about any bound. Exiting 1 here would put "a bound is unenforceable" in a chain's verdict over
// an input this gate has just said it cannot read. The comment at the top of the absent-file loop already
// draws that line ("a missing input is could not check, which is a different fact from a bound is
// unenforceable and must not share an exit code with it"); both checks now sit on the same side of it.
if (catalogue.length < 200) {
  console.error(`FATAL field-bounds: the catalogue holds only ${catalogue.length} rows. It has held 260-plus since it was built; this is a truncated or wrong file, and every bound would read as absent.`);
  console.error(`  Nothing was graded. Re-derive it and check the internal-docs sibling is checked out and current: ${CATALOGUE}`);
  process.exit(2);
}
if (census.length < 200) {
  console.error(`FATAL field-bounds: the census holds only ${census.length} controls. This is a failed census run, not a smaller console.`);
  console.error(`  Nothing was graded. Re-run 'node scripts/field-census.mjs' and re-run this gate: ${CENSUS}`);
  process.exit(2);
}

// ---- which rows state a bound ------------------------------------------------------------------
// Ported from harness/compiler/compile-probes.mjs (extractBound, W3.5), which is the origin and the
// more detailed version: it turns each bound into the boundary probes the live harness replays. Only
// the DECISION is needed here (does this row state a bound at all), not the edge values, so the
// patterns are carried over unchanged and the arithmetic is not. Keep the two in step: a pattern
// added there and not here means a newly-bounded field this gate would not ask about.
const BOUNDARY_CONTROLS = new Set(["input", "text", "textarea", "number", "password", "search"]);
const TWO_SIDED_PATTERNS = [
  /\bMIN_\w+\s+(\d+)\b[\s\S]*?\bMAX_\w+\s+(\d+)\b/,
  /\b(\d+)\s*(?:to|-|–|\.\.)\s*(\d+)\s*char/i,
  /\b(?:Integer p|P)ercentage\s+(\d+)\s*(?:to|-|–|\.\.)\s*(\d+)\b/i,
];

function statesBound(row) {
  if (!BOUNDARY_CONTROLS.has(row.control)) return null;
  const accepted = String(row.accepted_values ?? "");
  if (!accepted) return null;
  const fullText = [row.accepted_values, row.client_validator, row.server_validator].filter(Boolean).join(" || ");

  for (const re of TWO_SIDED_PATTERNS) if (re.test(fullText)) return "two-sided";
  if (/\bsecond/i.test(fullText) && /\b(\d+)\s*to\s*(\d+)\b/.test(fullText)) return "seconds";

  const head = accepted.slice(0, 100);
  if (/\bMIN_\w+\s+(\d+)\b/.test(fullText)) return "named-const-min";
  if (/\bat least\s+(\d+)\b/i.test(head)) return "at-least";
  if (/\bnon-negative (?:number|integer)\b/i.test(accepted)) return "non-negative";
  if (/\bpositive integer\b/i.test(accepted)) return "positive-integer";
  if (/\binteger\s*0\+/i.test(accepted)) return "n-plus";

  if (/\bup to\s+(\d+)\s*char/i.test(head)) return "up-to-chars";
  if (/\bfree text up to\s+(\d+)\s*chars?\s*\(maxlength\)/i.test(head)) return "maxlength";
  if (/\bMAX_\w+\s+(\d+)\b/.test(fullText.slice(0, 160))) return "named-const-max";

  return null;
}

// ---- the join --------------------------------------------------------------------------------
// The census is the AST ground truth (it records each call's own hasValidate / required); the
// catalogue is the authority on what the control accepts. A row present in one and not the other is
// the field-catalogue gate's business, not this one's, so an unmatched key is counted and reported
// rather than failed twice.
const censusByKey = new Map();
for (const c of census) if (c.key) censusByKey.set(c.key, c);

const bounded = [];
let unmatched = 0;
for (const row of catalogue) {
  const kind = statesBound(row);
  if (kind === null) continue;
  const c = censusByKey.get(row.key);
  if (!c) {
    unmatched++;
    continue;
  }
  // Only field() controls have an `<id>-error` slot to render into. A raw h("input") carries no
  // error slot and no blur wiring, so "add a validator" is not the fix for one; those are a
  // different finding and are counted separately rather than being quietly dropped.
  bounded.push({ key: row.key, kind, mechanism: c.mechanism, file: c.file, line: c.line, hasValidate: c.hasValidate === true, required: c.required === true });
}

if (bounded.length < 30) {
  console.error(`FAIL field-bounds: only ${bounded.length} catalogue rows read as bounded. The catalogue held 60-plus when this gate was written; a collapse to ${bounded.length} means the patterns above stopped matching the catalogue's prose, so this gate is no longer asking about most of the fields it exists for.`);
  process.exit(1);
}

const fieldBounded = bounded.filter((b) => b.mechanism === "field");
const rawBounded = bounded.filter((b) => b.mechanism !== "field");

// THE RULE IS `validate`, NOT `required`. `required` refuses exactly one value, the empty string, so
// it enforces a minimum LENGTH of 1 and nothing else: it cannot refuse 0 against a minimum of 1, -5
// against a non-negative rule, or a 65th character against a maximum of 64. A bounded control needs
// a validator.
//
// THE BURNDOWN BELOW IS NOT AN EXEMPTION FROM THE RULE. Each entry is a control that carries
// `required` and states a bound its `required` cannot enforce, recorded by name with what is
// unenforced. Recording an entry here is not fixing it: the control still needs its own mirrored
// rule and its own message test.
//
// A NEW field cannot land here silently: the map is keyed on the catalogue key, so a control added
// tomorrow with a bounded accepted_values cell and no validator fails, exactly as one with no rule at
// all does. Removing an entry (by wiring its validator) clears the burndown; adding one is a decision
// on the record. An entry whose control has since GAINED a validator is itself a failure below, so the
// list cannot rot into a permanent allowlist.
//
// THE BURNDOWN IS EMPTY, AND THAT IS A MEASURED STATE RATHER THAN A DELETION. Every bounded field()
// control carries a validator wired from its own existing rule: validateResourceName, validateDatabaseId
// and validateHexId for identifier fields (the same functions validateSourceInput calls at Attach, so
// the two moments cannot disagree), atMostChars for length-bounded text boxes, and pushAuthSecret for a
// secret field (kept in step with the engine's own isValidPushHeaderValue by
// scripts/push-secret-drift-gate.mjs). No validator is tighter than the field's own catalogued bound:
// every catalogued valid input stays clean.
//
// Clearing an entry means driving the real control against a served bundle rather than reading it out of
// source, checking the field's own error slot both after blur and after the screen's own submit action,
// and confirming the same driver reports red against the unfixed control and green against the fixed one.
//
// A NEW entry is still a decision on the record, and an empty map does not weaken the rule above it: a
// bounded field() control landing tomorrow with `required` and no validator fails `unrecorded` on its
// first run, exactly as it would if this map held names.
const REQUIRED_ONLY_BURNDOWN = new Map([]);

const silent = fieldBounded.filter((b) => !b.hasValidate && !b.required);
const requiredOnly = fieldBounded.filter((b) => !b.hasValidate && b.required);
const unrecorded = requiredOnly.filter((b) => !REQUIRED_ONLY_BURNDOWN.has(b.key));
// A burndown entry for a control that now HAS a validator is a stale entry, and a stale entry is how
// a burndown becomes an allowlist that quietly excuses a future regression on the same key.
const stale = [...REQUIRED_ONLY_BURNDOWN.keys()].filter((k) => {
  const b = fieldBounded.find((x) => x.key === k);
  return b === undefined || b.hasValidate;
});

if (LIST) {
  for (const b of bounded.sort((a, z) => a.key.localeCompare(z.key))) {
    const state = b.mechanism !== "field" ? "n/a (not a field() control)" : b.hasValidate ? "validate" : b.required ? "required" : "SILENT";
    console.log(`${state.padEnd(28)} ${b.kind.padEnd(18)} ${b.key}`);
  }
  console.log("");
}

console.log(`[field-bounds] catalogue ${catalogue.length} rows / census ${census.length} controls`);
console.log(`[field-bounds] bounded rows: ${bounded.length} (${fieldBounded.length} field() controls, ${rawBounded.length} raw controls with no error slot, ${unmatched} not in the census)`);
console.log(`[field-bounds] bounded field() controls carrying a validator: ${fieldBounded.length - silent.length - requiredOnly.length} of ${fieldBounded.length}`);
console.log(`[field-bounds] burndown, bounded and 'required' only (the upper bound is unenforced on blur): ${requiredOnly.length}`);

let failed = false;

if (silent.length > 0) {
  console.error("");
  console.error(`FAIL field-bounds: ${silent.length} field() control(s) state a bound in the catalogue and can never refuse one, because they pass neither 'validate' nor 'required' and field.ts only validates on blur when one is present:`);
  for (const s of silent.sort((a, z) => a.key.localeCompare(z.key))) console.error(`  ${s.file}:${s.line}  ${s.key}  (bound: ${s.kind})`);
  failed = true;
}

if (unrecorded.length > 0) {
  console.error("");
  console.error(`FAIL field-bounds: ${unrecorded.length} bounded field() control(s) carry 'required' but no validator, and are not in the burndown. 'required' refuses only the empty string, so it cannot refuse a value that is merely out of bounds:`);
  for (const s of unrecorded.sort((a, z) => a.key.localeCompare(z.key))) console.error(`  ${s.file}:${s.line}  ${s.key}  (bound: ${s.kind})`);
  failed = true;
}

if (stale.length > 0) {
  console.error("");
  console.error(`FAIL field-bounds: ${stale.length} burndown entr(y/ies) no longer describe a bounded, validator-less control. Delete them, or the burndown becomes an allowlist that excuses the next regression on the same key:`);
  for (const k of stale) console.error(`  ${k}`);
  failed = true;
}

if (failed) {
  console.error("");
  console.error("Wire a validator from src/components/field-bounds.ts, then add its message to test/validate-field-bounds.ts.");
  process.exit(1);
}

console.log("[field-bounds] OK: every bounded field() control carries a validator, or is a recorded burndown entry");
