// Restore the live journey summary: a compact, always-current read of the
// flow's progress, built for the context rail so a sticky rail states more than just the run
// identity while the operator scrolls a long plan/confirm column. Driven entirely by the callback
// flow.ts already fires at its existing paintStepper / plan-hash seams (no new engine calls, no
// state duplicated here beyond what is shown): the current step's label, the short plan hash once a
// plan exists, and a plain-English approval-state read derived from the SAME step number the
// stepper itself paints, so the two surfaces can never disagree. Purely presentational; the
// dual-control gate itself is untouched in confirm.ts. House rules: Australian English, no em
// dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { copyButton } from "../../components/code-block.ts";
import { RESTORE_STEPS, RESTORE_STEP_COUNT, type RestoreJourneyInfo } from "./shared.ts";

export interface JourneySummary {
  el: HTMLElement;
  update(info: RestoreJourneyInfo): void;
}

// approvalStateLabel reads the plain-English approval state off the SAME step number the stepper
// paints (shared.ts restoreStepper), so the journey summary can never show a state that disagrees
// with the stepper above it. Steps 1-2 have no request yet; 3 is the real wait (raised, awaiting a
// distinct approver); 4 is armed; 5 is the write in flight; beyond the last step is the terminal
// applied state (the paintStepper(RESTORE_STEP_COUNT + 1) call, confirm.ts, apply success).
function approvalStateLabel(step: number): string {
  if (step > RESTORE_STEP_COUNT) return "Applied";
  if (step >= 5) return "Applying now";
  if (step === 4) return "Approved, ready to apply";
  if (step === 3) return "Awaiting a distinct approver";
  return "Not yet requested";
}

// renderJourneySummary builds the summary once; workspace.ts mounts journey.el in the context rail
// and threads journey.update into renderRestoreFlow's onJourney callback, so it repaints at the same
// points the flow's own stepper does. Calm: a few rows, not a second flow.
export function renderJourneySummary(): JourneySummary {
  const stepValue = h("dd", { class: "restore-journey__value" }, RESTORE_STEPS[0]);
  const approvalValue = h("dd", { class: "restore-journey__value" }, "Not yet requested");
  const facts = h(
    "dl",
    { class: "restore-journey__facts" },
    h("dt", "Step"), stepValue,
    h("dt", "Approval"), approvalValue,
  );

  // The plan-hash row is a redaction-safe cue (names, counts and selectors only, never a value or a
  // key), hidden until a plan exists; the FULL hash is copied (fullHash), never the truncated display.
  let fullHash: string | null = null;
  const hashValue = h("span", { class: "mono" });
  const hashRow = h(
    "div",
    { class: "restore-journey__hash" },
    h("span", { class: "field__hint" }, "Plan "),
    hashValue,
    copyButton("Copy plan hash", () => fullHash ?? ""),
  );
  hashRow.style.setProperty("display", "none");

  const el = h(
    "section",
    { class: "restore-journey", "aria-label": "Restore progress summary" },
    h("h2", { class: "restore-journey__title" }, "Progress"),
    facts,
    hashRow,
  );

  const update = (info: RestoreJourneyInfo): void => {
    const label = RESTORE_STEPS[Math.min(Math.max(info.step, 1), RESTORE_STEP_COUNT) - 1] ?? RESTORE_STEPS[0];
    stepValue.textContent = label;
    approvalValue.textContent = approvalStateLabel(info.step);
    fullHash = info.planHash;
    if (info.planHash) {
      hashValue.textContent = `${info.planHash.slice(0, 20)}…`;
      hashValue.title = info.planHash;
      hashRow.style.setProperty("display", "");
    } else {
      hashRow.style.setProperty("display", "none");
    }
  };

  return { el, update };
}
