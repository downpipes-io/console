// Modal: a centred dialog over a backdrop, built on the shared overlay engine
// (dialog.ts: focus-trap, inert background, restore-focus, Esc, click-out). This
// and the toast/field/confirm primitives are the "kill the native dialogs" set:
// there is NO native alert()/confirm() anywhere in the console; every confirmation
// and notice routes through these.
//
// A destructive primary is NEVER the default-focused control: a modal with a danger action
// focuses Cancel. The footer renders the primary on the right and Cancel to its left.
//
// Error contract: when an action's onClick rejects, the modal stays open,
// the control state is restored (busy path: spinner cleared + buttons re-enabled),
// and the error is surfaced to the operator via a warn toast. Both the busy and the
// non-busy paths follow this contract so the operator is never left with a silently
// broken action.

import { h } from "../lib/dom.ts";
import { openOverlay, dialogSurface, type OverlayHandle } from "./dialog.ts";
import { toast } from "./toast.ts";

export interface ModalAction {
  label: string;
  // "primary" | "danger" | "secondary"; danger is a solid danger button used only
  // for a confirmed destructive action. secondary is the Cancel default.
  variant: "primary" | "danger" | "secondary";
  // The handler. Return false (or a rejected promise) to keep the modal open (e.g.
  // a validation failure); anything else closes it after the handler resolves.
  // biome-ignore lint/suspicious/noConfusingVoidType: the union is deliberate, a handler may return nothing (void = close) or a boolean (false = keep open).
  onClick: () => void | boolean | Promise<void | boolean>;
  // When true the button shows a busy spinner while onClick is pending.
  busyLabel?: string;
}

export interface ModalOptions {
  title: string;
  // The body content (already-escaped text, or built nodes; never raw server HTML).
  body: Node;
  // The footer actions (primary/danger on the right, Cancel to its left). If
  // omitted, a single "Close" secondary action is rendered.
  actions?: ModalAction[];
  // Called when the modal is dismissed (Esc / click-out / close X / Cancel). The
  // per-action onClick handlers fire first for action clicks.
  onDismiss?: () => void;
  // Whether Esc / click-out dismiss (default true). A genuinely modal step may set
  // false, but the safe default keeps Cancel reachable.
  dismissable?: boolean;
  // When true the surface gets the .dialog--wide variant (880px) for content that needs
  // the width (a JSON view, a wide table); the default stays the standard modal measure.
  wide?: boolean;
  // An OPTIONAL small tokenised icon chip in the header (warn / danger; dialog.ts). Omitted by
  // every existing caller, so this is purely additive: no chip, no behaviour change by default.
  severity?: "warn" | "danger";
}

// _actionErrorMessage extracts a human-readable message from a thrown value.
// Exported with a _test prefix so the validator can assert the extraction logic;
// production callers go through runAction, not this directly.
export function _actionErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// _testRunNonBusyAction exercises the non-busy action error routing without a DOM.
// It runs the provided onClick and calls notifyError with the surfaced message if the
// promise rejects (matching the runAction behaviour). Returns true when the action
// resolved without error, false when it rejected and notifyError was called.
export async function _testRunNonBusyAction(
  // biome-ignore lint/suspicious/noConfusingVoidType: matches the ModalAction.onClick contract, void (close) or boolean (false = keep open).
  onClick: () => void | boolean | Promise<void | boolean>,
  notifyError: (msg: string) => void,
): Promise<boolean> {
  try {
    await onClick();
    return true;
  } catch (err) {
    notifyError(_actionErrorMessage(err));
    return false;
  }
}

// BusyButtonState is the minimal button surface the busy path touches: the busy dataset flag,
// the label, and the disabled state. The seam below operates on this so the busy-path control
// recovery can be asserted without a DOM (parallel to _testRunNonBusyAction).
export interface BusyButtonState {
  busy: string;
  textContent: string;
  disabled: boolean;
}

// _testRunBusyAction exercises the BUSY action path of runAction without a DOM: it sets the
// busy state + busy label + disables the button, runs onClick, then either restores the control
// (a rejection or a `false` result keeps the modal open) or signals a close (any other result).
// It mirrors the busy branch of runAction byte-for-byte in effect, so the validator can assert
// the error-recovery restores busy/label/disabled and that a successful run closes. Returns
// { closed, errored }: closed true when the modal should close, errored true on a rejection.
/**
 * RESERVE THE WIDTH A CONTROL WILL NEED WHEN IT GOES BUSY, so entering that state cannot move whatever
 * sits beside it.
 *
 * The defect this fixes: on /downpipes/new the Next button becomes "Attaching" and the Cancel button
 * next to it moves 4.1px. An operator commits to an action and their way out shifts at the moment a
 * hand is most likely travelling toward it.
 *
 * Timed to the actual pixel travel rather than to a character-count estimate, which would have been wrong. Character count predicted
 * "Acknowledge" to "Acknowledging..." as the worst case at roughly 56px; in pixels it is 24px, joint
 * smallest, because "Acknowledge" is already wide and an ellipsis is narrow. Import at half the
 * character delta is joint largest at 32px. A proportional font does not count characters.
 *
 * WHY THIS RESERVES NOTHING MOST OF THE TIME. Of the busy labels that could be paired with a rest
 * label, two thirds are SHORTER than the label they replace: "Reset to fresh" becomes "Resetting",
 * "Revoke every factor" becomes "Revoking". Reserving there would widen a control at rest for a state
 * narrower than rest, which is cost with no benefit, so the comparison is the rule rather than a
 * refinement of it.
 *
 * SAFE AT 375. The shared modal action row first overflows its dialog at +228px, and the largest
 * reservation any control needs is 32px. The row is justify-content: flex-end, so a growing button
 * extends LEFTWARD, which is why that headroom was found by checking both edges of the dialog and not
 * the row, which grows with the button and can never report a failure.
 *
 * The element must be laid out before this is called, or both measurements read zero and it reserves
 * nothing. That is a silent no-op rather than a wrong reservation, which is the right way round.
 */
export function reserveBusyWidth(btn: HTMLElement, busyLabel: string): void {
  // A host with no layout at all, rather than a host with zero-width layout. The `rest === 0` guard below
  // is the second case; this is the first, and without it the contract stated above inverts: instead of
  // reserving nothing it THROWS, which is how validate-roles-access-gating died mid-run without a verdict.
  // Guarded the way nav-bar-course.ts:397 and director.ts:310 already guard the same call.
  if (typeof btn.getBoundingClientRect !== "function") return;
  const rest = btn.getBoundingClientRect().width;
  if (rest === 0) return;
  const original = btn.textContent;
  btn.textContent = busyLabel;
  const busy = btn.getBoundingClientRect().width;
  btn.textContent = original;
  // Only where the busy state is WIDER. Equal or narrower needs no reservation, and giving it one is
  // how a fix acquires a cost the defect never had.
  if (busy > rest) btn.style.minWidth = `${Math.ceil(busy)}px`;
}

export async function _testRunBusyAction(
  btn: BusyButtonState,
  busyLabel: string,
  // biome-ignore lint/suspicious/noConfusingVoidType: matches the ModalAction.onClick contract, void (close) or boolean (false = keep open).
  onClick: () => void | boolean | Promise<void | boolean>,
  notifyError: (msg: string) => void,
): Promise<{ closed: boolean; errored: boolean }> {
  const original = btn.textContent;
  btn.busy = "true";
  btn.textContent = busyLabel;
  btn.disabled = true;
  try {
    const result = await onClick();
    if (result === false) {
      // Keep open: restore the button and re-enable.
      btn.busy = "false";
      btn.textContent = original;
      btn.disabled = false;
      return { closed: false, errored: false };
    }
  } catch (err) {
    // Restore control state and surface the error.
    btn.busy = "false";
    btn.textContent = original;
    btn.disabled = false;
    notifyError(_actionErrorMessage(err));
    return { closed: false, errored: true };
  }
  return { closed: true, errored: false };
}

// openModal mounts the modal and returns the overlay handle (so a caller can close
// it programmatically). The promise-friendly confirm() wrapper below is the common
// path for a yes/no decision.
export function openModal(opts: ModalOptions): OverlayHandle {
  let handle: OverlayHandle;
  const actions = opts.actions ?? [{ label: "Close", variant: "secondary", onClick: () => {} }];

  const footer = h("div", { class: "dialog__actions" });
  // Cancel-type (secondary) first in the DOM so it is left-of the primary; we focus
  // it as the initial control when a danger action is present.
  let initialFocus: HTMLElement | null = null;
  const buttons: HTMLButtonElement[] = [];

  for (const action of actions) {
    const cls =
      action.variant === "primary" ? "btn btn--primary"
      : action.variant === "danger" ? "btn btn--danger"
      : "btn btn--secondary";
    const btn = h("button", { "data-dp": "components-modal.button.open-modal", class: cls, type: "button" }, action.label) as HTMLButtonElement;
    btn.addEventListener("click", () => void runAction(action, btn));
    buttons.push(btn);
    footer.appendChild(btn);
    if (action.variant === "secondary" && initialFocus === null) initialFocus = btn;
  }

  // If there is a danger action, focus Cancel (the secondary). If there is no
  // secondary but there is a danger action, fall back to the close X (handled by
  // the overlay default first-focusable, which is the header close button).
  const hasDanger = actions.some((a) => a.variant === "danger");
  if (!hasDanger) initialFocus = null; // let the overlay focus the first focusable

  // Tracks whether the current teardown was triggered by an action click, so onClose
  // only calls onDismiss for a genuine dismissal (Esc / click-out / close X / Cancel).
  let closingFromAction = false;

  const { surface } = dialogSurface({
    variant: "modal",
    title: opts.title,
    body: opts.body,
    footer,
    onCloseClick: () => dismiss(),
    ...(opts.severity ? { severity: opts.severity } : {}),
  });
  if (opts.wide) surface.classList.add("dialog--wide");

  handle = openOverlay({
    surface,
    variant: "modal",
    dismissable: opts.dismissable !== false,
    initialFocus,
    onClose: () => {
      if (!closingFromAction) opts.onDismiss?.();
    },
  });

  function dismiss(): void {
    handle.close();
  }

  async function runAction(action: ModalAction, btn: HTMLButtonElement): Promise<void> {
    if (action.busyLabel) {
      btn.dataset.busy = "true";
      const original = btn.textContent;
      btn.textContent = action.busyLabel;
      for (const b of buttons) b.disabled = true;
      try {
        const result = await action.onClick();
        if (result === false) {
          // Keep open: restore the button and re-enable.
          btn.dataset.busy = "false";
          btn.textContent = original;
          for (const b of buttons) b.disabled = false;
          return;
        }
      } catch (err) {
        // Restore control state and surface the error.
        btn.dataset.busy = "false";
        btn.textContent = original;
        for (const b of buttons) b.disabled = false;
        toast({ message: _actionErrorMessage(err), tone: "warn" });
        return;
      }
      closingFromAction = true;
      handle.close();
      return;
    }
    // Non-busy path: no spinner state to restore, but a rejected onClick must still
    // surface the error and keep the modal open (CON-M12 fix).
    try {
      const result = await action.onClick();
      if (result === false) return; // keep open
      closingFromAction = true;
      handle.close();
    } catch (err) {
      toast({ message: _actionErrorMessage(err), tone: "warn" });
      // Modal stays open; the operator can retry or dismiss.
    }
  }

  // Reserved AFTER the overlay is mounted, because a button that is not laid out measures zero.
  for (let i = 0; i < buttons.length; i++) {
    const busy = actions[i]?.busyLabel;
    const btn = buttons[i];
    if (btn !== undefined && busy !== undefined && busy !== "") {
      reserveBusyWidth(btn, busy);
      // THE CONTROL DECLARES ITS IN-FLIGHT STATE WHILE IT IS STILL AT REST, so a reader can put the
      // control into that state and measure it without pressing the real button (a click on this console
      // navigates, submits or deletes).
      //
      // The value is the label the button WILL show, so a reader can put the control into that state
      // itself and measure the difference. It is set here rather than at construction because this is
      // where the label and the button are known together, and it costs one attribute on a control that
      // already carries a reserved width for the same string.
      btn.dataset.busyLabel = busy;
    }
  }

  return handle;
}

// confirmModal is the promise-friendly yes/no the screens use INSTEAD of the native
// confirm(). It resolves true on confirm, false on
// dismiss/cancel. The confirm label and variant are caller-set; for a destructive
// action pass variant "danger" so focus lands on Cancel.
export function confirmModal(opts: {
  title: string;
  body: Node | string;
  confirmLabel: string;
  cancelLabel?: string;
  variant?: "primary" | "danger";
  busyLabel?: string;
  // An OPTIONAL small tokenised icon chip in the header (warn / danger; dialog.ts). Existing callers
  // that omit it are unaffected (no chip, no behaviour change).
  severity?: "warn" | "danger";
}): Promise<boolean> {
  return new Promise((resolve) => {
    let decided = false;
    const settle = (v: boolean) => {
      if (decided) return;
      decided = true;
      resolve(v);
    };
    const bodyNode = typeof opts.body === "string" ? h("p", { style: "color:var(--text)" }, opts.body) : opts.body;
    openModal({
      title: opts.title,
      body: bodyNode,
      onDismiss: () => settle(false),
      ...(opts.severity ? { severity: opts.severity } : {}),
      actions: [
        { label: opts.cancelLabel ?? "Cancel", variant: "secondary", onClick: () => settle(false) },
        {
          label: opts.confirmLabel,
          variant: opts.variant ?? "primary",
          ...(opts.busyLabel ? { busyLabel: opts.busyLabel } : {}),
          onClick: () => settle(true),
        },
      ],
    });
  });
}
