// Every restore-screen safety guard must be LOAD-BEARING: neuter it and something must go red.
//
// WHY THIS EXISTS, AND WHY HERE RATHER THAN ONLY IN THE ENGINE
// ------------------------------------------------------------
// The engine has a sweep of this shape. It found one gap on its first run, then found none at all when it
// was widened to guards in code nobody had touched recently. That is the useful result: gaps cluster in
// code that has just been changed, because that is where a guard arrives before its test does.
//
// Everything this file checks was written in the same fortnight. By that reasoning it is the likeliest
// place in this repo to be carrying a guard that nothing holds up, so it gets the same treatment rather
// than the benefit of the doubt.
//
// These guards are all of one kind: the engine computes a safety signal and the CONSOLE must show it or
// act on it. That failure has happened here twice already. The cross-zone warning was computed and
// rendered nowhere, so an operator's first sight of a wrong-zone restore was the engine refusing an apply
// they had already confirmed. Five fidelity fields were undeclared on the console type, so a restore that
// quietly lost twelve TTLs was titled "Restore applied" with a success tick.
//
// WHAT IT IS NOT
// --------------
// Not general mutation testing. A general run would spend its time on mutants nobody would write. The
// question is narrow: is each guard we CLAIM to have actually held up by a test?
//
// SAFETY: it edits source files in place and restores them, verifying the original bytes afterwards. A
// failed restore exits non-zero rather than leaving mutated source behind.
//
// Run with `node test/validate-restore-guards-are-load-bearing.ts`. Slow (a gate per guard), so it has its
// own npm script rather than sitting in a chain.
//
// FS-WRITES: none outside this repo

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { verdictCannotCheck, verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

interface Guard {
  what: string;
  file: string;
  find: string;
  replace: string;
  gate: string;
}

const GUARDS: Guard[] = [
  {
    // The engine reports what a restore did NOT carry across. If the classifier ignores it, the screen
    // titles a lossy restore "Restore applied" with a success tick, which is what it used to do.
    what: "a restore that lost fidelity is NOT classified clean",
    file: "src/screens/restore-flow/receipt.ts",
    find: "const reduced = !failed && !windowed && !skipped && shortfalls.length > 0;",
    replace: "const reduced = false;",
    gate: "test/validate-restore-fidelity-render.ts",
  },
  {
    // Classifying it is half the job; the operator only benefits if the receipt SAYS so.
    what: "the shortfall block is actually rendered on the receipt",
    file: "src/screens/restore-flow/receipt.ts",
    find: "if (outcome.shortfalls.length > 0) {",
    replace: "if (false) {",
    gate: "test/validate-restore-fidelity-render.ts",
  },
  {
    // The signed attestation is the artefact an auditor gets. Offering it is the whole point of T30.
    what: "the signed receipt is offered as a download when the engine returns one",
    file: "src/screens/restore-flow/receipt.ts",
    find: "if (res.receipt !== undefined && res.receipt !== null) {",
    replace: "if (false) {",
    gate: "test/validate-restore-fidelity-render.ts",
  },
  {
    // Gating on a PROVEN mismatch matters in BOTH directions: the engine warns but does not refuse when the
    // origin zone is unreadable, so demanding a type-to-confirm there would block a restore the engine is
    // happy to run.
    what: "the cross-zone confirm gates on a PROVEN mismatch, not on the warning merely existing",
    file: "src/screens/restore-flow/plan.ts",
    find: "return plan.crossZoneWarning !== undefined && plan.crossZoneWarning.originZone !== null;",
    replace: "return plan.crossZoneWarning !== undefined;",
    gate: "test/validate-restore-crosszone-render.ts",
  },
  {
    // The hash shown to the operator must be the hash the approval binds to, or a
    // requester and an approver cannot compare them.
    what: "the plan-hash mirror binds the cf-config surface set the engine resolved",
    file: "src/lib/api/helpers.ts",
    find: "...(req.cfConfig.surfaces !== undefined ? { surfaces: req.cfConfig.surfaces } : {}),",
    replace: "",
    gate: "test/validate-api.ts",
  },
  // These three gates were the opposite shape to the four above: the console
  // was too STRICT, not too lax. Each of these panels gated on the cumulative role RANK (canDo("approver"),
  // canDo("operator")) while the engine gates on the CAPABILITY, and a restore-operator sits off that
  // ladder at roleRank 0 while holding restore.request, restore.apply and restore.approve. The recovery-only
  // role that exists for disaster recovery was therefore offered no way to finish a restore in the console,
  // though the engine accepted it at the wire.
  //
  // Because the failure direction is UNDER-offering, the neuter has to be a STRICTER gate rather than the
  // usual `if (false)`. Keying each gate on downpipe.write does exactly that and needs no new import:
  // restore-operator is recovery-only and holds no data-ops capability, so it goes back into hiding, which
  // is the defect itself. It also widens an Operator onto the apply track, so the negative assertions are
  // exercised in the same run. SECTION 6R / 6S of validate-api-flows-restore.ts is what should notice.
  {
    // A plan crossing into TWO OR MORE distinct foreign Cloudflare accounts (a
    // cf-config leg and a media leg targeting DIFFERENT accounts) must require the operator to type EVERY
    // one of them, not just the first warning. Reading only crossAccountWarnings[0] let a second, untyped
    // foreign account ride through on a confirmation the operator aimed at the first: applyRestore stamps
    // confirmDifferentAccountId onto every cross-account leg once the gate arms, so whichever accounts the
    // gate did not make the operator type were confirmed to the engine anyway. See
    // test/validate-restore-cross-account-confirm.ts for the full reproduction and proof.
    what: "the cross-account type-to-confirm binds ALL distinct foreign target accounts, not just the first",
    file: "src/screens/restore-flow/confirm.ts",
    find: "const crossAccountTargets = flags.isCrossAccount ? crossAccountConfirmTargets(plan.crossAccountWarnings ?? []) : [];",
    replace: "const crossAccountTargets = flags.isCrossAccount ? (plan.crossAccountWarnings?.[0] ? [plan.crossAccountWarnings[0].targetAccount] : []) : [];",
    gate: "test/validate-restore-cross-account-confirm.ts",
  },
  {
    what: "the single-run confirm panel gates on the restore.apply CAPABILITY, not the approver rank",
    file: "src/screens/restore-flow/confirm.ts",
    find: 'if (!canCap("restore.apply")) {',
    replace: 'if (!canCap("downpipe.write")) {',
    gate: "test/validate-api.ts",
  },
  {
    what: "the batch per-row Apply gates on the restore.apply CAPABILITY, not the approver rank",
    file: "src/screens/restore-flow/batch.ts",
    find: 'if (canCap("restore.apply")) {',
    replace: 'if (canCap("downpipe.write")) {',
    gate: "test/validate-api.ts",
  },
  {
    what: "the batch request-all control gates on the restore.request CAPABILITY, not the operator rank",
    file: "src/screens/restore-flow/batch.ts",
    find: 'canCap("restore.request")\n      ? h(',
    replace: 'canCap("downpipe.write")\n      ? h(',
    gate: "test/validate-api.ts",
  },
];

let unguarded = 0;
let broken = 0;

for (const g of GUARDS) {
  const original = readFileSync(g.file, "utf8");
  if (!original.includes(g.find)) {
    // Source moved or was reworded. NOT a pass: this file can no longer prove anything about that guard,
    // and a silently-skipped case is the failure mode the whole sweep is written against.
    console.log(`  BROKEN  ${g.what}\n          its source no longer contains the expected condition in ${g.file}; update this file`);
    broken++;
    continue;
  }
  let restored = false;
  try {
    writeFileSync(g.file, original.replace(g.find, g.replace), "utf8");
    const r = spawnSync("node", [g.gate], { encoding: "utf8" });
    const died = r.status !== 0;
    console.log(died ? `  ok      ${g.what}\n          (removing it fails ${g.gate})` : `  UNGUARDED ${g.what}\n          removing it from ${g.file} changes NOTHING in ${g.gate}`);
    if (!died) unguarded++;
  } finally {
    writeFileSync(g.file, original, "utf8");
    restored = readFileSync(g.file, "utf8") === original;
  }
  if (!restored) {
    console.error(`\n*** ${g.file} WAS NOT RESTORED. Check it before doing anything else. ***`);
    // Exit 2 UNCHANGED. verdictCannotCheck declares the refusal and performs that same exit itself.
    verdictCannotCheck();
  }
}

console.log(
  unguarded === 0 && broken === 0
    ? `\nRESTORE GUARDS ARE LOAD-BEARING: all ${GUARDS.length} checked`
    : `\n${unguarded} UNGUARDED, ${broken} BROKEN of ${GUARDS.length}`,
);
verdictReached(unguarded); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (unguarded > 0 || broken > 0) process.exit(1);
