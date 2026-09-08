// Wizard / stepper. The full-bleed, centred, single-track flow
// the onboarding runs: a step rail showing each step's status (done / current /
// upcoming / blocked), the current step's body, and a nav row. Completed steps are
// revisitable; a blocked future step is locked until its prerequisites pass and says
// why. The key ceremony is the emotional centre of this flow, but this component is the
// neutral chassis; the ceremony content is the screen's.
//
// One piece exported from here: stepper(), the ordered-list progress indicator (the
// .stepper token CSS), with status by hue + SHAPE (a tick / a dot / a number / a lock
// glyph) + a text label, never colour alone (WCAG 1.4.1), and aria-current="step" on
// the current step.
//
// Accessibility: the stepper is an ordered list (<ol>) with the current step marked
// aria-current="step"; a revisitable step is a real <button>; a blocked step is a
// disabled control with an inline reason (never a teasing dead link); each step's body
// is a landmark-scoped section with its own heading (the screen supplies the heading);
// the poll/status updates a polite aria-live region. Built from dom.ts + tokens.css.

import { h, svgIcon } from "../lib/dom.ts";
import { ICON_CHECK } from "../lib/icons.ts";

// A locked padlock glyph for a blocked step (a non-colour shape cue that the step is
// not yet reachable). Kept local so the icon set only grows when a real surface needs
// it; this is that surface.
const ICON_LOCK_SMALL = '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>';

// The status of a step. "done" is revisitable; "current" is where the operator is;
// "upcoming" is reachable-once-current-passes (shown as a number, not yet a link);
// "blocked" is locked with a reason (a prerequisite has not passed).
export type StepStatus = "done" | "current" | "upcoming" | "blocked";

export interface WizardStep {
  // A stable id for the step (used for jump-to + the body region id).
  id: string;
  // The short step label shown in the rail (e.g. "Connect", "Key ceremony").
  label: string;
  // The reason a step is blocked, shown inline + as the disabled control's title. Only
  // meaningful when the step resolves to "blocked".
  blockedReason?: string;
}

export interface StepperOptions {
  steps: WizardStep[];
  // The index of the current step (0-based).
  currentIndex: number;
  // Resolve a step's status. A step before the current index defaults to "done" and a
  // step after it to "upcoming"; pass this to override (e.g. mark a future step
  // "blocked" with a reason, or a past step still "current" if revisited). The default
  // resolver implements the before=done / at=current / after=upcoming rule.
  statusOf?: (step: WizardStep, index: number, currentIndex: number) => StepStatus;
  // Jump to a step (only invoked for a "done" step, which is revisitable). Omit to make
  // the stepper purely indicative (no jumping).
  onJump?: (step: WizardStep, index: number) => void;
}

// stepper builds the ordered-list progress indicator. Each item carries its status as a
// marker shape AND a text label AND a hue, so state never relies on colour alone (WCAG 1.4.1).
export function stepper(opts: StepperOptions): HTMLElement {
  const resolve = opts.statusOf ?? defaultStatus;
  const ol = h("ol", { class: "stepper", "aria-label": "Setup steps" });
  opts.steps.forEach((step, i) => {
    ol.appendChild(buildStepItem(step, i, resolve(step, i, opts.currentIndex), opts.onJump));
  });
  return ol;
}

// buildStepItem renders one <li> for the stepper. Factored out of stepper() so that
// function stays a thin map loop.
function buildStepItem(
  step: WizardStep,
  i: number,
  status: StepStatus,
  onJump: StepperOptions["onJump"],
): HTMLElement {
  const li = h("li", { class: `stepper__item stepper__item--${status}` });
  if (status === "current") li.setAttribute("aria-current", "step");

  const marker = h("span", { class: "stepper__marker", "aria-hidden": "true" });
  if (status === "done") marker.appendChild(svgIcon(ICON_CHECK, { size: 12 }));
  else if (status === "blocked") marker.appendChild(svgIcon(ICON_LOCK_SMALL, { size: 12 }));
  else marker.appendChild(document.createTextNode(String(i + 1)));

  // The accessible status word, so a screen reader hears "Connect, done" / "Verify
  // Access, current step" / "Key ceremony, locked: connect first", not just a number.
  const statusWord =
    status === "done" ? "done"
    : status === "current" ? "current step"
    : status === "blocked" ? `locked${step.blockedReason ? `: ${step.blockedReason}` : ""}`
    : "upcoming";

  const labelText = h("span", { class: "stepper__label" }, step.label);
  // The interactive step controls (the jumpable done step, the focusable blocked step) carry an EXPLICIT
  // aria-label so their accessible name is exactly "<label>, <status>". Composing that name from a label span
  // plus a SIBLING visually-hidden status span instead lets the accessible-name-from-content algorithm insert
  // a separator space between the two ("Choose , done"), a stray comma-space a screen reader reads out; an
  // explicit aria-label is deterministic. The non-interactive (current/upcoming) row keeps the inline
  // visually-hidden status span, since it has no control to hang an aria-label on.
  const accName = `${step.label}, ${statusWord}`;

  if (status === "done" && onJump) {
    li.appendChild(h(
      "button",
      { "data-dp": "components-wizard.button.jump", class: "stepper__link", type: "button", "aria-label": accName, on: { click: () => onJump(step, i) } },
      marker,
      labelText,
    ));
  } else if (status === "blocked") {
    // Disabled-with-reason, FOCUSABLE (Primer/Atlassian pattern): keyboard users can land on the
    // blocked step; the aria-label reads the status ("locked: <reason>"), no hover-only title (WCAG 1.4.13).
    li.appendChild(h(
      "span",
      { class: "stepper__blocked", role: "button", "aria-disabled": "true", tabindex: "0", "aria-label": accName },
      marker,
      labelText,
    ));
  } else {
    li.appendChild(marker);
    li.appendChild(labelText);
    li.appendChild(h("span", { class: "visually-hidden" }, `, ${statusWord}`));
  }
  return li;
}

function defaultStatus(_step: WizardStep, index: number, currentIndex: number): StepStatus {
  if (index < currentIndex) return "done";
  if (index === currentIndex) return "current";
  return "upcoming";
}
