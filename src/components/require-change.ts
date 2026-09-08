// requireChange: the OWNER-OPT-IN "Require Change Number" gate the console runs BEFORE a CAB-worthy
// change-controlled action (a destination repoint/remove, an IdP change, a restore apply, an engine update,
// and the other owner actions). When the policy is OFF (the default) it is a NO-OP: it resolves immediately
// with no reference and shows nothing, so the action behaves exactly as before. When the policy is ON it
// presents a focused modal that collects EITHER a change number (a normal CAB change) OR an Emergency Change
// (a deliberate bypass of the number requirement, made to STAND OUT) with a required justification, and
// returns the ChangeRef the caller threads into the client call (which rides it to the engine as the
// X-Downpipes-Change header). The engine is the authority and records the change-recorded CR; this is the UX
// that lets the operator supply the reference rather than hit a bare "change number required" rejection.
//
// House rules: no-custody (the reference is the operator's own non-secret ticket text); precise claims;
// Australian English, no em dashes.

import { h } from "../lib/dom.ts";
import { recordGovGate } from "../lib/client-diag/ring.ts";
import type { ClientDiagAdminOp } from "../lib/client-diag/vocab.ts";
import { openModal } from "./modal.ts";
import { field } from "./field.ts";
import { atMostChars } from "./field-bounds.ts";
import { CHANGE_NUMBER_MAX, CHANGE_REASON_MAX, type ChangeRef } from "../lib/change-ref.ts";
import type { EngineClient } from "../api.ts";

// RequireChangeResult is the gate outcome: proceed (with the collected reference, or null when the policy is
// off) or cancel (the operator dismissed the modal; the action must NOT run). The caller threads `change`
// into the client method on proceed and returns early on cancel.
export interface RequireChangeResult {
  proceed: boolean;
  change: ChangeRef | null;
}

// requireChange reads the policy and, when Require Change Number is on, collects the reference. It FAILS OPEN
// for UX on a policy-read fault (proceed with no reference): the engine still enforces, so an action that
// genuinely needed a reference returns a 400 the caller surfaces, rather than blocking the operator on a
// transient read. actionLabel is a short human description of the action (e.g. "Repoint the destination").
//
// THE FAIL-OPEN IS RECORDED. The fail-open itself is kept, and deliberately: the engine is the
// authority, it refuses the action with a 400 if a reference was genuinely required, and blocking every
// change-controlled action in the console on a transient policy read would turn one flaky GET into a total
// outage of the product's write path. What was wrong was that it was SILENT. The customer's report is exactly
// "the console sometimes does not ask for a change number, and then the action fails with change number
// required", and both halves of that sentence were unfalsifiable: the engine counts its own 400s
// (configIntegrity.changeControlRefusals) and has no way to know the console never asked, and the console knew
// and told nobody. The row is the missing half, and the two JOIN in the pack: a change-control refusal with a
// change-prompt-skipped row beside it, on the same op, is a console that never prompted, not an operator who
// ignored the prompt. gateOp names WHICH action it fell on, because a skipped prompt on a restore apply and one
// on a destination repoint are not the same incident.
export async function requireChange(engine: EngineClient, actionLabel: string, gateOp: ClientDiagAdminOp): Promise<RequireChangeResult> {
  let required = false;
  try {
    required = (await engine.getConfigApprovalPolicy()).requireChangeNumber === true;
  } catch {
    // Could not read the policy; the engine remains the authority and will refuse if needed. The operator is
    // about to be sent at a change-controlled action with NO prompt and NO reference: recorded, never guessed.
    required = false;
    recordGovGate("change-prompt-skipped-policy-read-failed", gateOp);
  }
  if (!required) return { proceed: true, change: null };
  return collectChange(actionLabel);
}

// collectChange presents the change-collection modal and resolves with the operator's choice. The modal has a
// NORMAL mode (a required change-number field) and an EMERGENCY mode (a loud warn banner, a required
// justification, and an optional change number) toggled by a prominent affordance, so an emergency is a
// deliberate, visible act, not a silent skip.
function collectChange(actionLabel: string): Promise<RequireChangeResult> {
  return new Promise<RequireChangeResult>((resolve) => {
    let settled = false;
    const settle = (r: RequireChangeResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let emergency = false;

    const numberField = field({ id: "cm-change-number", label: "Change number", placeholder: "e.g. CHG0012345", required: true, validate: atMostChars({ noun: "The change number", max: CHANGE_NUMBER_MAX, remedy: "Shorten it to the reference your change record uses, for example CHG0012345." }), hint: "Your CAB or ITIL change ticket reference, recorded in the audit log against this change.", doc: { href: "https://docs.downpipes.io/identity-access/change-control", anchor: "require-change-number" } });
    numberField.control.setAttribute("maxlength", String(CHANGE_NUMBER_MAX));
    const reasonField = field({ id: "cm-emergency-reason", label: "Justification", kind: "textarea", placeholder: "Why is this an emergency, and what is being changed?", required: true, validate: atMostChars({ noun: "The justification", max: CHANGE_REASON_MAX, remedy: "Say what is being changed and why it cannot wait, in a sentence or two; the full detail belongs in the retrospective change record." }), doc: { href: "https://docs.downpipes.io/identity-access/change-control", anchor: "require-change-number" } });
    reasonField.control.setAttribute("maxlength", String(CHANGE_REASON_MAX));
    // maxlength alone caps TYPING; it does not cap a paste in every browser, and it says nothing when
    // it truncates, so a pasted-over-length reference silently became a different reference. All three
    // controls here refuse it at the field instead, with the bound named.
    const emNumberField = field({ id: "cm-emergency-number", label: "Change number (optional)", placeholder: "e.g. CHG0012399", hint: "Only if a retrospective change record has been raised.", validate: atMostChars({ noun: "The change number", max: CHANGE_NUMBER_MAX, remedy: "Shorten it to the reference your change record uses, for example CHG0012399." }), doc: { href: "https://docs.downpipes.io/identity-access/change-control", anchor: "require-change-number" } });
    emNumberField.control.setAttribute("maxlength", String(CHANGE_NUMBER_MAX));

    const intro = h("p", { class: "field__hint", style: "margin:0" }, `This account requires a change number for change-controlled actions. ${actionLabel} is one of them.`);

    // NORMAL mode: the change-number field + the affordance to switch to an emergency.
    const emBtn = h("button", { "data-dp": "components-require-change.button.set-mode-true", type: "button", class: "btn btn--ghost btn--sm", style: "color:var(--warn-fg);justify-self:start" }, "No change number? Raise as an Emergency Change") as HTMLButtonElement;
    const normalGroup = h("div", { style: "display:grid;gap:var(--space-2)" }, numberField.el, emBtn);

    // EMERGENCY mode (hidden until chosen): a LOUD banner so it stands out, the required justification, an
    // optional number, and a way back to a normal change.
    const banner = h(
      "div",
      { role: "alert", style: "display:flex;gap:var(--space-2);align-items:flex-start;padding:var(--space-3);border-radius:var(--radius-2);background:var(--warn-bg);border:1px solid var(--warn-border);color:var(--warn-fg)" },
      h("strong", { style: "white-space:nowrap" }, "Emergency Change."),
      h("span", "This bypasses the change-number requirement and is flagged in compliance for retrospective review (validate a change record is raised afterwards). Use it only for a genuine emergency."),
    );
    const backBtn = h("button", { "data-dp": "components-require-change.button.back", type: "button", class: "btn btn--ghost btn--sm", style: "justify-self:start" }, "Back to a normal change") as HTMLButtonElement;
    const emergencyGroup = h("div", { style: "display:none;gap:var(--space-3)" }, banner, reasonField.el, emNumberField.el, backBtn);

    const body = h("div", { style: "display:grid;gap:var(--space-3)" }, intro, normalGroup, emergencyGroup);

    const setMode = (em: boolean): void => {
      emergency = em;
      normalGroup.style.display = em ? "none" : "grid";
      emergencyGroup.style.display = em ? "grid" : "none";
      numberField.clearError();
      reasonField.clearError();
      (em ? reasonField : numberField).focus();
    };
    emBtn.addEventListener("click", () => setMode(true));
    backBtn.addEventListener("click", () => setMode(false));

    openModal({
      title: "Record the change",
      body,
      dismissable: true,
      onDismiss: () => settle({ proceed: false, change: null }),
      actions: [
        { label: "Cancel", variant: "secondary", onClick: () => settle({ proceed: false, change: null }) },
        {
          label: "Confirm change",
          variant: "primary",
          onClick: () => {
            if (emergency) {
              if (!reasonField.validate()) return false; // keep open; the field shows its own error
              const num = emNumberField.value();
              settle({ proceed: true, change: { number: num === "" ? null : num, emergency: true, reason: reasonField.value() } });
              return;
            }
            if (!numberField.validate()) return false; // keep open
            settle({ proceed: true, change: { number: numberField.value(), emergency: false, reason: null } });
            return;
          },
        },
      ],
    });
  });
}
