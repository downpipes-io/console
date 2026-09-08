// The plan screen must render the engine's applyDeadline honestly, and must not invent one when the
// engine did not send it. Run with:
//   node test/validate-restore-apply-deadline.ts
//
// WHY THIS EXISTS. The engine's RestorePlan carries plannedAt / applyDeadline (engine/src/admin/
// restore-types.ts): the instant a dry-run plan was computed, and the last instant an apply of an approval
// anchored to it may still be writing (RESTORE_APPLY_DEADLINE_MS past plannedAt -- the approval's own TTL
// plus the reservation lease an apply holds while it writes). The console did not declare either field
// (validate-engine-field-coverage.ts caught it: "missing: plannedAt, applyDeadline"), so both arrived on the
// wire and were silently discarded at the type boundary, the same shape that dropped
// mediaFaults/d1Fault/d1SchemaObjectsFiltered/metadataFieldsDropped before those were caught.
//
// Declaring the field fixes the coverage gate; this test is the separate claim that the console then does
// something honest with it. THIS MATTERS BECAUSE THE FIRST DRAFT WAS NOT HONEST: it labelled applyDeadline
// "Apply deadline" and said "apply must land before this / past this instant the engine refuses the apply
// outright". That is true of the approval's own expiresAt (anchor + APPROVAL_TTL_MS), not of applyDeadline
// (expiresAt + RESTORE_APPLY_LEASE_MS, thirty minutes later): engine/src/admin/approvals.ts's
// effectiveStatus reads "expired" at expiresAt, before the reservation-lease branch is ever reached, so a
// FRESH apply reservation is refused up to thirty minutes before applyDeadline, not at it. applyDeadline is
// the write-completion bound for an apply that already reserved earlier, and the assertions below check
// the copy says exactly that rather than overstating the operator's remaining time.
//
// Both assertions are run as a PAIR so neither is vacuous: a plan that carries applyDeadline must show it,
// and a plan that omits it (an older engine, or the field genuinely absent) must not invent one. A suite that
// only checked the positive case would still pass if the render always printed a fixed deadline regardless
// of what the plan said.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

import { installDomShim, qs, textOf } from "./dom-shim.ts";
installDomShim();

import type { RestorePlan, RestoreRequest } from "../src/lib/api/types/restore-types.ts";
import { renderPlan } from "../src/screens/restore-flow/plan.ts";
import { absoluteTime, relativeTime } from "../src/lib/format.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const engine = { listApprovals: async () => [], requestRestore: async () => ({}), restore: async () => ({}) } as never;

const RUN = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const req: RestoreRequest = { runId: RUN };

async function render(plan: RestorePlan): Promise<HTMLElement> {
  return await renderPlan(engine, plan, () => req, () => undefined, () => undefined);
}

async function main(): Promise<void> {
  console.log("-- a plan carrying applyDeadline renders it honestly, as a write-completion bound --");
  {
    // A round instant with no fractional-second noise, matching a real dry-run's plannedAt/applyDeadline
    // pair.
    const deadline = "2026-08-09T09:00:00.000Z";
    const plan: RestorePlan = {
      ok: true, runId: RUN, mode: "dry-run",
      recordsVerified: 12, isLatest: true, plannedWrites: 12, bytes: 2048,
      sample: [], skipped: [],
      plannedAt: "2026-08-09T07:47:00.000Z",
      applyDeadline: deadline,
    };
    const el = await render(plan);
    const figs = textOf(qs(el as never, ".restore-figs")!).replace(/\s+/g, " ");
    ok("the figure row carries a last-possible-write figure", /Last possible write/.test(figs));
    // The value is the ABSOLUTE instant (absoluteTime's own stated design: stable in a screenshot), not a
    // bare relative phrase that goes stale the moment the reader looks away.
    ok("the deadline value is the honest absolute instant, not a placeholder", figs.includes(`Last possible write${absoluteTime(deadline)}`));
    ok("the caption states this is when writing can continue until, not an apply deadline", /writing can continue until this instant at the latest/.test(figs));
    ok("the caption says approval and reservation happen earlier", /approve and reserve the apply earlier/.test(figs));
    // The relative phrase rides in the caption too, matching format.ts's own relativeTime output exactly
    // rather than a hand-rolled duration string that could quietly drift from the shared formatter.
    ok("the caption's relative phrase matches the shared formatter, not a re-derived one", figs.includes(`(${relativeTime(deadline)})`));
    // THE REGRESSION THIS GUARDS AGAINST: the first draft's copy read as a refusal boundary ("apply must
    // land before this", "the engine refuses the apply outright"), which overstates the operator's real
    // remaining time by up to RESTORE_APPLY_LEASE_MS (engine/src/admin/approvals.ts), because the approval
    // itself expires, and a fresh reservation is refused, earlier than applyDeadline. Neither phrase, nor
    // any claim that the apply itself is refused at this instant, may appear anywhere in the figure row.
    ok("the copy never claims the apply is refused at this instant (that claim belongs to the approval's own expiry, not applyDeadline)", !/refuses the apply/.test(figs) && !/apply must land before/.test(figs));
  }

  console.log("\n-- a plan that omits applyDeadline (an older engine) invents no deadline --");
  {
    // Same plan, applyDeadline/plannedAt genuinely absent -- both are optional on the wire type precisely
    // for this case. A refusal stub (plan.ok === false) never reaches planFigures at all, so the negative
    // control has to be an OK plan with the fields missing, not a refusal, or it would prove nothing about
    // planFigures's own branch.
    const plan: RestorePlan = {
      ok: true, runId: RUN, mode: "dry-run",
      recordsVerified: 12, isLatest: true, plannedWrites: 12, bytes: 2048,
      sample: [], skipped: [],
    };
    const el = await render(plan);
    const figs = textOf(qs(el as never, ".restore-figs")!).replace(/\s+/g, " ");
    ok("no write-completion figure is invented when the engine sent none", !/Last possible write/.test(figs));
    // The negative control's own positive: the other figures still render, so an empty .restore-figs is not
    // what is making the assertion above pass.
    ok("the negative control is not vacuous: the figure row still renders other figures", /Records verified/.test(figs) && /Planned writes/.test(figs));
  }

  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) process.exit(1);
}

main();
