#!/usr/bin/env node
// Two claims about the offline-key-only posture that keep coming back, banned in shipped console copy.
//
// WHY THIS EXISTS. Both claims were true when they were written and outlived the code, and both understate
// what a customer KEEPS by choosing the stricter custody posture. That direction matters: an error that
// overstates a posture's cost talks people out of the stronger option, on the screen where they choose.
//
//   1. "in-console restore stops in break-glass-only". It does not. Restore opens a run from a
//      browser-supplied per-run master and refuses only when there is NEITHER an operational key NOR a
//      supplied master (engine src/admin/restore.ts). The posture keeps in-console restore, attended.
//
//   2. "the engine cannot auto-recover its own configuration without the operational key". It can. The
//      sealed config export is opened by the dedicated CONFIG recipient key, which engine
//      scripts/deploy.sh installs in BOTH postures and which the break-glass-only switch does not touch
//      (it deletes only the two OPERATIONAL secrets). The offline reader is for a FRESH ACCOUNT, where the
//      new engine's keys were never recipients of the old export.
//
// Both claims recur across multiple surfaces when they do: the posture acceptance statement, the Keys
// screen, the ceremony-time disclosure and the docs corpus, so a fix in one place does not retire them from
// the others. A literal-phrase scan is what catches a recurrence; nothing else in this repo does.
//
// SCOPE, and it is narrow on purpose. This scans src/ only, which is what ships to a customer. Test files
// and this gate itself must be able to write the banned wording in order to check for it. A phrase ban
// cannot catch a paraphrase, and this does not pretend to: it catches the literal regression a writer
// copying stale copy would make.
//
// The docs corpus has the same two rules in its own must-not-claim gate, by the same ids. The sibling
// cross-check below asserts they are still there, so deleting one side is a failure rather than a silent
// half-guard.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { findWorkspaceDir } from "./workspace-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN = join(ROOT, "src");
const REQUIRE_SIBLING = process.argv.includes("--require");

const RULES = [
  {
    id: "bgonly-loses-console-restore",
    pattern: /in[-\s]console\s+restores?\s*,?\s+and\s+retention\s+pruning/gi,
    message:
      "Offline-key-only does NOT lose in-console restore: it keeps it ATTENDED, with the operator supplying\n" +
      "    the break-glass key in the browser. Name what actually stops (scheduled restore tests, drills,\n" +
      "    retention pruning) and say restore keeps working with the operator present.",
  },
  {
    // A THIRD claim class, complementing the first two: those ban claims that UNDERSTATE the stricter
    // posture; this one bans the opposite, copy that still calls the operational key the default. Strict
    // break-glass-only is the default posture; an operational key is opted into.
    //
    // It matters most on THIS surface, because the console is where the posture is chosen. Copy telling a
    // customer the operational key is the default, on the screen where they are deciding, is worse than the
    // same sentence in a reference page.
    //
    // Writing this rule ahead of a regression, rather than sweeping for one after it appears, is what
    // closes the surface before a customer sees it: the same phrasing can spread across many places once
    // it starts, and a phrase ban catches it before that happens rather than after.
    //
    // "the default card is Add an operational key" is a UI default, not a posture, and is not matched.
    id: "operational-key-is-default",
    // The true statement, which the pattern would otherwise catch: break-glass-only IS the default now, and
    // saying so contains "the default" close to "operational key" in the same sentence.
    allowNear: /break-glass-only[^.\n]{0,40}(?:is|as)\s+the\s+default|default[^.\n]{0,20}break-glass-only/i,
    pattern: /(?:by default|the default)(?!\s+card)[^.\n]{0,60}operational key|operational key[^.\n]{0,30}by default|default[^.\n]{0,40}two-recipient|two-recipient[^.\n]{0,25}(?:is|as)\s+the\s+default/gi,
    message:
      "Strict break-glass-only is the DEFAULT posture from 2026-07-28; an operational key is opted INTO.\n" +
      "    Say 'the optional operational key', or 'where an operational key has been added', rather than\n" +
      "    calling it the default. This is the screen where the posture is chosen, so the wording decides.",
  },
  {
    id: "bgonly-loses-config-autoheal",
    pattern: /\bauto[-\s]?(?:heal|recover)\w*\b[^.]{0,120}\boperational\s+key\b|\boperational\s+key\b[^.]{0,120}\bauto[-\s]?(?:heal|recover)\w*\b/gi,
    message:
      "Config auto-recovery does not depend on the operational key. The sealed config export is opened by the\n" +
      "    dedicated config-recipient key, held in BOTH postures, so an engine that kept its secrets\n" +
      "    auto-recovers either way. The offline reader is for recovering into a FRESH ACCOUNT.",
  },
];

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const scanned = files(SCAN);
// A gate that scans nothing reads exactly like a passing gate.
if (scanned.length < 100) {
  console.error(`FAIL posture-claims: expected this repo's source, found only ${scanned.length} files. Has the layout moved?`);
  process.exit(1);
}

const hits = [];
for (const p of scanned) {
  const body = readFileSync(p, "utf8");
  const lines = body.split("\n");
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(body)) continue;
    lines.forEach((line, i) => {
      rule.pattern.lastIndex = 0;
      // allowNear, matching the docs gate's idiom: a line that states the TRUE version of the claim is not
      // a hit. Needed because "break-glass-only custody is the default" contains "the default ... key" and
      // would otherwise be banned for saying exactly the right thing.
      if (rule.allowNear?.test(line)) return;
      if (rule.pattern.test(line)) hits.push({ rule, file: relative(ROOT, p), line: i + 1 });
    });
  }
}

if (hits.length > 0) {
  console.error(`FAIL posture-claims: ${hits.length} forbidden claim(s) about the offline-key-only posture.\n`);
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  [${h.rule.id}]`);
    console.error(`    ${h.rule.message}\n`);
  }
  process.exit(1);
}

// The cross-repo half. These two rules exist in the docs corpus gate under the same ids, and a claim banned
// on one surface and allowed on the other is half a guard. Absent sibling SKIPS by default (a console-only
// checkout must stay buildable) and FAILS under --require, which is the posture verify-doc-links already
// takes and which CI passes.
// WHERE THE DOCS SIBLING IS, resolved rather than assumed. A naive resolve(ROOT, "../docs") asserts this
// checkout's parent is the workspace root, which is true of the primary checkout and of no worktree. The
// absent-sibling refusal below is right on its own; it just cannot fire when the naive guess lands on a
// real but unrelated docs tree, and then a rule id that stranger happens to carry would read here as
// "still paired" when this checkout's pairing is gone.
const DOCS_MARKER = join("docs", "scripts", "must-not-claim-lint.mjs");
const WORKSPACE = findWorkspaceDir(ROOT, DOCS_MARKER);
const DOCS_REPO = WORKSPACE === null ? null : join(WORKSPACE, "docs");
const docsMarkerPath = WORKSPACE === null ? null : join(WORKSPACE, DOCS_MARKER);
if (docsMarkerPath === null || !existsSync(docsMarkerPath)) {
  if (REQUIRE_SIBLING) {
    console.error("FAIL posture-claims: --require was passed and the docs sibling did not resolve beside this checkout, so the paired docs rules could not be confirmed.");
    // Exit 2, not 1: 1 is reserved for a real paired-rule loss found below.
    process.exit(2);
  }
  console.log(`ok   posture-claims: ${scanned.length} files clean (docs sibling absent, paired rules not confirmed)`);
  process.exit(0);
}
// A docs checkout merely BEHIND its own origin/main can still carry a rule id upstream has since removed,
// which would read here as "still paired" when it is not. No fetch, so unknown freshness (no origin/main
// ref) is not judged either way. POSTURE_CLAIMS_ALLOW_STALE=1 overrides.
if (process.env.POSTURE_CLAIMS_ALLOW_STALE !== "1") {
  let behind = null;
  try {
    behind = Number(execFileSync("git", ["-C", /** @type {string} */ (DOCS_REPO), "rev-list", "--count", "HEAD..origin/main"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch { /* unknown freshness, nothing to conclude */ }
  if (Number.isFinite(behind) && /** @type {number} */ (behind) > 0) {
    console.error(`FAIL posture-claims: ${DOCS_REPO} is ${behind} commit(s) behind its own origin/main.`);
    console.error("  A rule id this old checkout still carries may already be gone upstream, which would read here");
    console.error("  as still paired. Update the checkout, or set POSTURE_CLAIMS_ALLOW_STALE=1 if deliberate.");
    process.exit(2);
  }
}
const docsBody = readFileSync(docsMarkerPath, "utf8");
const missing = RULES.filter((r) => !docsBody.includes(`id: "${r.id}"`)).map((r) => r.id);
if (missing.length > 0) {
  console.error(
    `FAIL posture-claims: the docs corpus gate no longer carries ${missing.join(", ")}.\n\n` +
      "  Both surfaces ban these claims, because both carried them. Removing the rule from one side leaves\n" +
      "  the claim free to come back through that side, which is how it reached five places the first time.",
  );
  process.exit(1);
}

console.log(`ok   posture-claims: ${scanned.length} files clean, and all ${RULES.length} rules still paired in the docs gate`);
