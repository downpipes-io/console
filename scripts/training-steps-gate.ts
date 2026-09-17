// The training-steps manifest deriver AND gate. The Beginner walk's chapters live in console source
// (src/lib/demo/tour/scripts/training-beginner.ts), and the harness's robot learner replays them from a
// committed JSONL manifest (internal-docs/TRAINING/steps.jsonl) rather than importing console source
// across a repo boundary. A hand-authored manifest would be a third reader that drifts, so the manifest is
// DERIVED from the script here, exactly like the field and functional censuses: the plain run re-derives
// and COMPARES against the committed artefact and fails on any difference, and --write-internal-docs
// refreshes it.
//
// Fail-loud discipline (internal-docs/GATE-THAT-CANNOT-CHECK.md): a missing internal-docs sibling, a
// missing committed manifest, or a derivation under the row floor is a refusal (exit 2), never a pass.
//
// Usage:
//   node scripts/training-steps-gate.ts                       # gate: derive, compare, fail on drift
//   node scripts/training-steps-gate.ts --write-internal-docs # refresh the committed manifest
//
// FS-WRITES: <workspace>/internal-docs/TRAINING/steps.jsonl
// FS-WRITES-RUN: --write-internal-docs
//
// IN validate:workspace:chain, NOT lint:chain. The Lint job checks out console alone, with no internal-docs
// sibling and deliberately no cross-repo token, so this gate would refuse on every run there (exit 2)
// without checking anything: a correct refusal, but one the Lint job could never clear. npm run
// validate:workspace runs as the Cross-repo gates job's own step, which checks out internal-docs beside
// console before the chain runs, so this member gets the sibling it needs. There is no lenient half kept in
// lint:chain: the exit-2 refusal above is the whole gate, and running it where the sibling is absent by
// construction would buy nothing but a standing red.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The script module renders nothing, but its import graph touches DOM-adjacent modules; the shared test
// shim makes the import safe under node exactly as it does for every validator.
import { installDomShim } from "../test/dom-shim.ts";
import { findWorkspaceDir } from "./workspace-root.mjs";
import { announceOutsideWrites, announceOutsideWritesHeld, outsideWriteRequested } from "./outside-write.mjs";

installDomShim();
const g = globalThis as unknown as Record<string, unknown>;
g.location = g.location ?? { origin: "https://console.test", search: "", hostname: "console.test", href: "https://console.test/" };

const { TRAINING_BEGINNER } = await import("../src/lib/demo/tour/scripts/training-beginner.ts");

const CONSOLE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = join("internal-docs", "TRAINING");
const MANIFEST_REL = join("internal-docs", "TRAINING", "steps.jsonl");

// The derived rows: one per beat, in walk order. step is "<chapter>.<beat>" (1-based both sides);
// chapterGoal is what the stage is for, which the rail keeps up for the whole stage; jump marks a chapter
// that advances the world at its boundary; task carries the grader-gated instruction the robot learner
// completes; doc_url is the step's real documentation link. The grader function itself is
// code and stays in the script; the manifest carries everything a replayer or an auditor needs to name a
// step, which is what the freshness gates key on.
interface StepRow {
  step: string;
  chapter: number;
  chapterTitle: string;
  chapterGoal: string;
  route: string;
  beatTitle: string;
  anchor: string;
  jump?: boolean;
  task?: string;
  doc_url?: string;
}

const rows: StepRow[] = [];
for (const [ci, chapter] of TRAINING_BEGINNER.entries()) {
  for (const [bi, beat] of chapter.infoPoints.entries()) {
    rows.push({
      step: `${ci + 1}.${bi + 1}`,
      chapter: ci + 1,
      chapterTitle: chapter.title,
      chapterGoal: chapter.goal ?? "",
      route: chapter.route,
      beatTitle: beat.title,
      anchor: beat.anchor,
      ...(bi === 0 && chapter.worldTransform !== undefined ? { jump: true } : {}),
      ...(beat.task !== undefined ? { task: beat.task.label } : {}),
      ...(beat.doc !== undefined ? { doc_url: beat.doc.href } : {}),
    });
  }
}

// Anti-vacuity: the Beginner walk is eight chapters of two-plus beats; a derivation under the floor means
// the import silently returned nothing, and a comparison over nothing is not a check.
const ROW_FLOOR = 15;
if (rows.length < ROW_FLOOR) {
  console.error(`[training-steps] REFUSED: derived only ${rows.length} row(s), below the floor of ${ROW_FLOOR}. The script import silently collapsed; nothing was checked.`);
  process.exit(2);
}

const serialised = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const workspace = findWorkspaceDir(CONSOLE_ROOT, MARKER) ?? findWorkspaceDir(CONSOLE_ROOT, join("internal-docs", "FIELD-CATALOGUE"));
if (workspace === null) {
  console.error("[training-steps] REFUSED: no internal-docs sibling resolves from this checkout, so the committed manifest cannot be graded (exit 2, could-not-check, never a pass).");
  process.exit(2);
}
const manifestPath = join(workspace, MANIFEST_REL);

if (outsideWriteRequested()) {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, serialised);
  announceOutsideWrites("[training-steps]", workspace, [manifestPath]);
  console.log(`[training-steps] wrote ${rows.length} step row(s) to ${manifestPath}`);
  process.exit(0);
}

announceOutsideWritesHeld("[training-steps]", [manifestPath]);
if (!existsSync(manifestPath)) {
  console.error(`[training-steps] FAIL: no committed manifest at ${manifestPath}. Derive it: node scripts/training-steps-gate.ts --write-internal-docs, then commit internal-docs.`);
  process.exit(1);
}
const committed = readFileSync(manifestPath, "utf8");
if (committed === serialised) {
  console.log(`[training-steps] OK: the committed manifest matches the walk (${rows.length} step row(s)).`);
  process.exit(0);
}
const committedLines = committed.split("\n").filter((l) => l !== "");
const derivedLines = serialised.split("\n").filter((l) => l !== "");
let firstDiff = 0;
while (firstDiff < Math.min(committedLines.length, derivedLines.length) && committedLines[firstDiff] === derivedLines[firstDiff]) firstDiff++;
console.error(`[training-steps] FAIL: the committed manifest is NOT what the walk derives (${committedLines.length} committed vs ${derivedLines.length} derived row(s); first difference at row ${firstDiff + 1}).`);
console.error(`  committed: ${committedLines[firstDiff] ?? "(absent)"}`);
console.error(`  derived:   ${derivedLines[firstDiff] ?? "(absent)"}`);
console.error("  This is a chore, not a decision: node scripts/training-steps-gate.ts --write-internal-docs, commit internal-docs, and re-run.");
process.exit(1);
