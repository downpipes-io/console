// Hook census -- the denominator for the harness's stable-selector coverage, the
// same role field-census.mjs plays for the field catalogue. See scripts/hook-lib.mjs's header for the
// key scheme and the two populations this counts (no-id input-like controls, action buttons).
//
// Two modes:
//   node scripts/hook-census.mjs           report: print the coverage burndown, writing NOTHING, exit 0
//                                           always (report mode never fails the build;
//                                           test/validate-hooks.ts is the enforcing gate).
//   node scripts/hook-census.mjs --write-internal-docs
//                                          ALSO refresh the committed JSONL denominator, which lives in
//                                           internal-docs, a repository this one does not own, so a plain
//                                           report run never dirties a shared repo without being told. The
//                                           flag names its destination on purpose: --write below already
//                                           means something else entirely, and reading it as "the bare run
//                                           does not write" is exactly right about this repo and wrong
//                                           about the other.
//   node scripts/hook-census.mjs --write   ALSO make every hooked-or-hookable call site match this
//                                           run's derivation: INSERT a literal `"data-dp": "<key>"`
//                                           where one is missing, and REPAIR one already present whose
//                                           value has drifted (typically a #n suffix renumbered because
//                                           a new sibling control landed on the same base key). Both are
//                                           spliced into/over the control's own attrs object text.
//                                           Idempotent: a second run finds nothing left to touch.
//                                           Anything this cannot safely splice into (a non-literal attrs
//                                           object, or the checkboxRow helper's positional id argument)
//                                           is listed under "could not auto-stamp" rather than silently
//                                           skipped.
//
// Run with cwd = console/ so "typescript" resolves from console/node_modules.
//
// SIBLING-SUPPLY: an on-demand writer, deliberately in no chain. Refreshing the committed hook census is
// a person's decision, not a gate's, and it refuses rather than skips when internal-docs is not
// resolvable, so nothing here can pass by not checking.
// FS-WRITES: <workspace>/internal-docs/HOOK-CENSUS/hook-census.jsonl
// FS-WRITES-RUN: --write-internal-docs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeHookCensus } from "./hook-lib.mjs";
import { findWorkspaceDir } from "./workspace-root.mjs";
import { announceOutsideWrites, announceOutsideWritesHeld, outsideWriteRequested } from "./outside-write.mjs";

const CONSOLE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(CONSOLE_ROOT, "src");

// WHERE THE CANONICAL CENSUS LIVES, resolved rather than assumed.
//
// Resolving the destination as join(CONSOLE_ROOT, "..", "internal-docs", "HOOK-CENSUS") assumes the
// console checkout's parent IS the workspace root. That holds for the primary checkout and for no
// worktree, and because the write below is mkdirSync({ recursive: true }) a wrong parent produces no
// error at all: it manufactures an internal-docs tree at the guess and reports "Wrote ..." -- in a
// worktree this silently writes every row into a DECOY internal-docs sitting beside it, leaving the
// committed artefact untouched; in a checkout with no sibling it creates an internal-docs/HOOK-CENSUS
// tree from nothing.
//
// This one matters twice over. hook-census.jsonl is the DENOMINATOR functional-census.mjs reads for the
// harness's stable-selector coverage, and functional-catalogue-gate.mjs enforces a ratchet on the figure
// derived from it. A hook census written to, or read from, the wrong tree moves a number a gate then
// enforces.
//
// The refusal below is conditional on --write-internal-docs, and that is the point of the flag rather
// than a detail of it. A report run in a console-only checkout has no write to refuse, and exiting 2 at
// it would be the same bug with the sign flipped: a caller stopped over a repository it was never going
// to touch.
const MARKER = join("internal-docs", "HOOK-CENSUS", "hook-census.jsonl");
const PUBLISH = outsideWriteRequested();
const WORKSPACE = findWorkspaceDir(CONSOLE_ROOT, MARKER);
if (PUBLISH && WORKSPACE === null) {
  console.error(`\n[hook-census] FATAL: could not resolve the workspace root from ${CONSOLE_ROOT}.`);
  console.error(`  Tried the direct parent and the owner of any .worktrees segment; none carries ${MARKER}`);
  console.error("  outside a .worktrees directory, which is refused however it is reached.");
  console.error("  Check internal-docs out beside this repo, or set DOWNPIPES_WORKSPACE=/path/to/workspace-root.");
  console.error("  Refusing to write, because mkdirSync would otherwise CREATE a HOOK-CENSUS tree at the");
  console.error("  guessed path and report success against a denominator no gate reads.\n");
  process.exit(2);
}
const OUT_DIR = WORKSPACE === null ? null : join(WORKSPACE, "internal-docs", "HOOK-CENSUS");
const OUT_JSONL = OUT_DIR === null ? "<workspace-root>/internal-docs/HOOK-CENSUS/hook-census.jsonl  (workspace root unresolved from here)" : join(OUT_DIR, "hook-census.jsonl");
const WRITE = process.argv.includes("--write");

function applyWrite(targets) {
  // Anything needing a hook whose current text does not already match this run's derivation: either it
  // carries none yet (INSERT) or its value has drifted (REPLACE the existing string literal in place).
  const needsWrite = targets.filter((t) => !t.hasStableId && t.canAutoStamp && t.key !== t.hookValue);
  const byFile = new Map();
  for (const t of needsWrite) {
    const arr = byFile.get(t.absFile) ?? [];
    arr.push(t);
    byFile.set(t.absFile, arr);
  }
  let inserted = 0;
  let repaired = 0;
  for (const [absFile, rows] of byFile) {
    let text = readFileSync(absFile, "utf8");
    // One [start, end) span per row -- a REPLACE spans the existing string literal, an INSERT is a
    // zero-width point at the attrs object's opening brace. Apply highest offset first so one edit never
    // shifts another's position within the same file.
    const ops = rows
      .map((t) => ({ t, start: t.hookValue !== null ? t.hookValueStart : t.insertAt, end: t.hookValue !== null ? t.hookValueEnd : t.insertAt }))
      .sort((a, b) => b.start - a.start);
    for (const { t, start, end } of ops) {
      if (t.hookValue !== null) {
        text = text.slice(0, start) + JSON.stringify(t.key) + text.slice(end);
        repaired++;
      } else {
        // Match the house style of a space just inside the brace (`{ class: ... }`), and omit the usual
        // trailing space when the attrs object already opens on whitespace (the common case), so the
        // result reads `{ "data-dp": "...", class: ... }` rather than doubling the space already there.
        const nextChar = text[start];
        const insertion = ` "data-dp": ${JSON.stringify(t.key)},${/\s/.test(nextChar) ? "" : " "}`;
        text = text.slice(0, start) + insertion + text.slice(end);
        inserted++;
      }
    }
    writeFileSync(absFile, text);
  }
  return { inserted, repaired, files: byFile.size };
}

const { targets, missing, hooked, redundant, duplicates } = computeHookCensus(SRC);

let writeResult = null;
if (WRITE) {
  writeResult = applyWrite(targets);
}

// Re-run after a write so the printed report and the JSONL denominator reflect what actually landed
// (not the pre-write snapshot), same discipline as re-reading a file after an edit rather than trusting
// the plan for it.
const final = WRITE ? computeHookCensus(SRC) : { targets, missing, hooked, redundant, duplicates };

// The committed denominator carries the FACTS about a call site and none of the machinery used to edit
// it. Four fields are excluded from what gets serialised, because no reader of this file wants them:
// `absFile`, an absolute path naming whichever checkout ran the census (which can carry a machine-local
// temp directory in the path), plus `insertAt` / `hookValueStart` / `hookValueEnd`, byte offsets
// applyWrite computes fresh from the current text on every run and never reads back.
//
// This is not tidiness. Those four would make every row differ on every run from a different directory,
// so a refresh would rewrite every line whatever had actually changed, and a reviewer would have no way
// to see the real movement in the diff -- a stale `line` or a silently dropped key could pass unnoticed.
// Dropping them makes this artefact a function of console/src alone, so a refresh diff shows exactly what
// moved. functional-census.mjs is its only reader and touches none of the four.
const WRITE_PATH_INTERNALS = new Set(["absFile", "insertAt", "hookValueStart", "hookValueEnd"]);
const committedRow = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !WRITE_PATH_INTERNALS.has(k)));

if (PUBLISH) {
  // OUT_DIR is string | null for the report path above; the refusal at the top of this file already
  // exited when PUBLISH found no workspace, so inside this branch it is a string.
  mkdirSync(/** @type {string} */ (OUT_DIR), { recursive: true });
  writeFileSync(OUT_JSONL, `${final.targets.map((r) => JSON.stringify(committedRow(r))).join("\n")}\n`);
}

const by = (rows, fn) => {
  const m = {};
  for (const r of rows) m[fn(r)] = (m[fn(r)] ?? 0) + 1;
  return m;
};
const total = final.targets.length;
const needing = final.targets.filter((t) => !t.hasStableId);

console.log(`\n[hook-census] ${total} control call sites across ${new Set(final.targets.map((r) => r.file)).size} files`);
console.log(`  no reliable DOM id (need a hook):        ${needing.length}`);
console.log(`    of which action buttons:               ${needing.filter((t) => t.role === "button").length}`);
console.log(`    of which input-like (aria/raw-*):       ${needing.filter((t) => t.role !== "button").length}`);
console.log(`\nCoverage:`);
console.log(`  hooked (data-dp present):                ${final.hooked.length}`);
console.log(`  MISSING (needs one, has none):            ${final.missing.length}`);
console.log(`  redundant (hooked but already has an id): ${final.redundant.length}`);
console.log(`  duplicate hook values (collision):        ${final.duplicates.length}`);

const notStampable = final.missing.filter((t) => !t.canAutoStamp);
if (notStampable.length) {
  console.log(`\nCould not auto-stamp (${notStampable.length}) -- needs a manual data-dp or an API change:`);
  for (const t of notStampable) console.log(`  ${t.file}:${t.line}  [${t.mechanism} ${t.role}]  ${t.fn ?? ""}`);
}

if (writeResult) {
  console.log(`\n[hook-census] --write inserted ${writeResult.inserted} new hook(s) and repaired ${writeResult.repaired} drifted one(s) across ${writeResult.files} file(s).`);
}

if (final.missing.length) {
  console.log(`\nFirst 20 missing (of ${final.missing.length}):`);
  for (const t of final.missing.slice(0, 20)) console.log(`  ${t.key}   ${t.file}:${t.line}  [${t.mechanism}]`);
}
if (final.redundant.length) {
  console.log(`\nRedundant hooks (control already has a stable id -- remove the data-dp):`);
  for (const t of final.redundant.slice(0, 20)) console.log(`  ${t.key}   ${t.file}:${t.line}`);
}
if (final.duplicates.length) {
  console.log(`\nDuplicate hook values (two call sites emit the same data-dp -- rename one):`);
  for (const arr of final.duplicates) console.log(`  "${arr[0].hookValue}"  ->  ${arr.map((t) => `${t.file}:${t.line}`).join(", ")}`);
}

console.log(`\nBy role (of the ${needing.length} needing a hook):`);
for (const [k, v] of Object.entries(by(needing, (r) => r.role)).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);

if (PUBLISH) announceOutsideWrites("[hook-census]", WORKSPACE, [OUT_JSONL]);
else announceOutsideWritesHeld("[hook-census]", [OUT_JSONL]);
