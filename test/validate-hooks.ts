// Hook coverage CONTRACT GUARD (the harness's W1.7). Run with: node test/validate-hooks.ts
//
// Pairs with scripts/hook-census.mjs the way test/validate-route-callers.ts pairs with a source-string
// presence check, and the way field-catalogue-gate.mjs pairs with field-census.mjs -- except there is no
// separate hand-maintained catalogue to reconcile against here: scripts/hook-lib.mjs derives BOTH the
// target population (no-id input-like controls, action buttons) and the hook population (every literal
// `data-dp` in source) from the same AST pass, so this gate re-runs that SAME pass fresh (never a
// possibly-stale committed denominator) and asserts three things about the harness's stable-selector
// contract:
//
//   1. no un-hooked target control: every no-id input-like control and every action button carries a
//      `data-dp`. This is the coverage the harness depends on -- a control the harness cannot
//      reach cannot be probed, walked or asserted against, so a gap here is silent, not loud, until a
//      harness spec fails for a reason nobody can see from the console repo alone.
//   2. no orphan hook: a `data-dp` sitting on a control that ALSO now carries a stable static id (dead
//      weight left behind when an id was added to a previously-hooked control, or a hook stamped where
//      the control never needed one).
//   3. no duplicate hook value: two distinct call sites must never emit the identical `data-dp` (the
//      harness would then be unable to tell them apart, and Playwright's own strict-mode locator would
//      throw on the first click).
//
// See scripts/hook-lib.mjs's header comment for the key scheme itself (screen.role.purpose[#n]) -- this
// file only enforces the invariants, it does not repeat the design.

import { join } from "node:path";
import { makeChecks } from "./validate-checks.ts";
import { computeHookCensus } from "../scripts/hook-lib.mjs";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

const checks = makeChecks();
const { ok, eq } = checks;

console.log("-- Hook coverage contract guard (every harness-targetable control carries a data-dp) --");

// Run from the console package root (npm run validate / npm run lint set cwd there).
const SRC = join("src");
const { targets, missing, hooked, redundant, duplicates } = computeHookCensus(SRC);

ok(`the census found control call sites (${targets.length} total, non-zero)`, targets.length > 0);
ok(`the census found hooked controls (${hooked.length} total, non-zero -- a zero here means the census itself broke, not that hooks are healthy)`, hooked.length > 0);

console.log(`\n-- coverage: ${targets.filter((t) => !t.hasStableId).length} controls need a hook, ${hooked.length} carry one --`);

if (missing.length) {
  console.log(`\n${missing.length} control(s) lack a reliable id AND a data-dp hook:`);
  for (const t of missing.slice(0, 40)) console.log(`  ${t.file}:${t.line}  [${t.mechanism} ${t.role}]  ${t.fn ?? ""}  (expected data-dp="${t.key}")`);
  if (missing.length > 40) console.log(`  ... and ${missing.length - 40} more (node scripts/hook-census.mjs --write stamps the lot)`);
}
eq("no un-hooked target control (run `node scripts/hook-census.mjs --write` to stamp any gap)", missing.length, 0);

if (redundant.length) {
  console.log(`\n${redundant.length} control(s) carry a data-dp they no longer need (a stable id was added since):`);
  for (const t of redundant.slice(0, 40)) console.log(`  ${t.file}:${t.line}  data-dp="${t.hookValue}"`);
}
eq("no orphan hook (a data-dp on a control that already has a stable id -- remove it)", redundant.length, 0);

if (duplicates.length) {
  console.log(`\n${duplicates.length} hook value(s) used by more than one call site:`);
  for (const arr of duplicates.slice(0, 20)) console.log(`  "${arr[0].hookValue}"  ->  ${arr.map((t) => `${t.file}:${t.line}`).join(", ")}`);
}
eq("no duplicate data-dp value across distinct call sites", duplicates.length, 0);

// Every hooked control's OWN value must equal what this run's derivation computes for that EXACT call
// site (not merely some valid key belonging to a different control -- a cross-wired copy-paste, e.g. a
// sibling's key pasted onto the wrong button, must not hide behind the duplicate check alone). Compared
// per-target rather than via set membership for exactly that reason.
const staleHooks = hooked.filter((t) => t.key !== t.hookValue);
if (staleHooks.length) {
  console.log(`\n${staleHooks.length} hook(s) whose value does not match this file's current key derivation for that call site:`);
  for (const t of staleHooks.slice(0, 40)) console.log(`  ${t.file}:${t.line}  has data-dp="${t.hookValue}", expected "${t.key}"`);
}
eq("every hook's value matches the current mechanical derivation for its own call site (no drifted/hand-edited value)", staleHooks.length, 0);

console.log(checks.failures === 0 ? "\nHOOK COVERAGE CONTRACT GUARD PASS" : `\n${checks.failures} FAILURE(S)`);
verdictReached(checks.failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (checks.failures > 0) process.exit(1);
