// Focus Flow (concept B) shared types: the question ids, the view a question renders, and the context it
// receives. Kept apart so the page, the plan and the step modules import them without a cycle.

import type { SetupSnapshot, SetupStepId } from "../../../lib/setup-flow/index.ts";

// Every question has its own URL (/setup/<step>/<sub>). Order here is the main-path order.
export type QId =
  | "welcome"
  | "connect"
  | "provider"
  | "bucket"
  | "lock"
  | "credentials"
  | "pricing"
  | "protect"
  | "posture"
  | "custody"
  | "generate"
  | "saved"
  | "apply"
  | "manual"
  | "revoke"
  | "backup"
  | "run"
  | "finish"
  | "hardening"
  | "check"
  | "team"
  | "approval";

// The plan's decision lines.
export type LineId =
  | "scope"
  | "token"
  | "provider"
  | "bucket"
  | "lock"
  | "accessKey"
  | "prices"
  | "sources"
  | "posture"
  | "custody"
  | "files"
  | "saved"
  | "route"
  | "installed"
  | "revoked"
  | "downpipes"
  | "schedule"
  | "retention"
  | "restore";

export interface Primary {
  label: string;
  busyLabel?: string;
  // The sentence the reason line reads, with role=status, while the primary is busy: what is happening now, in
  // words a screen reader announces (focus stays in the field, so the button's own aria-busy is not heard).
  busyText?: string;
  // Returns the reason the action cannot run yet (shown as text beside it), or null.
  reason?: () => string | null;
  run: () => void | Promise<void>;
}

export interface QView {
  // Defaults to "<Step>, n of 7".
  eyebrow?: string;
  title: string;
  lede?: Array<string | Node>;
  body: Node[];
  primary: Primary | null;
  // Secondary actions, in the action row after the primary.
  secondary?: Node[];
  // Where focus lands on arrival (the h1 when absent).
  focus?: () => HTMLElement | null;
  // Hide the plan column (the posture comparison needs the width and the words).
  hidePlan?: boolean;
  // Finish: the plan has become the receipt in the stage, so the plan column and the Plan button go.
  receipt?: boolean;
  // False on a view whose primary records an attestation or leaves setup: Enter on the h1 (where focus lands
  // on arrival) does not run it. Enter from a field, a tile or a tick still does.
  enterFromHeading?: false;
  // Called on every model change while this view is shown (for live values only; never rebuild a control).
  onSnapshot?: (s: SetupSnapshot) => void;
  // Called when the view is replaced.
  dispose?: () => void;
}

export interface QCtx {
  s: SetupSnapshot;
  q: QId;
  // The path to return to after a Change, or null.
  ret: string | null;
  // Moves to the next question: the return path after a Change, else the first undecided question.
  next: () => void;
  // Moves to a named question (through the guarded navigate).
  go: (id: QId, opts?: { replace?: boolean; back?: boolean; ret?: string | null }) => void;
  // Marks a question as answered (concept-local record of answers the draft does not carry).
  answer: (id: QId) => void;
  // The chosen tile's title travels into its plan line on the next navigation (motion only).
  flight: (el: HTMLElement | null, line: LineId) => void;
  // Re-evaluates the primary's reason and label.
  refresh: () => void;
  setPrimaryLabel: (label: string) => void;
  setBusy: (busy: boolean) => void;
  // Rebuilds this question from the latest snapshot (focus returns to the h1 when it fell to the body).
  rerender: () => void;
}

export interface QDef {
  id: QId;
  step: SetupStepId;
  sub: string | null;
  // The plan line the marker sits on while this question shows.
  line: LineId | null;
  render: (c: QCtx) => QView;
}
