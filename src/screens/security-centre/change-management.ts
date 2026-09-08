// The OWNER-OPT-IN "Require Change Number" control of the Security centre (change management). It mirrors the
// dual-control toggle (security-centre/access.ts): a clearly-labelled switch bound to the change-number
// policy, ENABLED only for an Owner (the engine's POST is owner-only; everyone else sees the state read-only),
// loaded from the same approval-policy view (which carries requireChangeNumber), and degrading honestly on an
// engine that does not back it. When ON, a CAB-worthy change-controlled action (a destination repoint/remove,
// an IdP change, a restore apply, a break-glass-token retire, a support-credential mint) requires the operator to
// attach a change number (or raise an Emergency Change); the engine records it in the audit log and flags any
// emergency change in compliance.
//
// House rules: no-custody (no value or key transits); precise claims; Australian English, no em dashes.

import type { EngineClient } from "../../api.ts";
import { inlineRetry } from "../../components/error-view.ts";
import { disabledWithReason } from "../../components/field.ts";
import { confirmModal } from "../../components/modal.ts";
import { badge, statusWithLabel } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { classifyError, isUnauthorised } from "../../lib/errors.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import { can } from "../../lib/identity.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { callerRole, errText, POLICY_READ_FAILED } from "./shared.ts";

// The mutable view the control shares with its helpers: the rendered switch + labels + state line and the
// current loaded value (so the click handler knows what to flip to and writes it back after a save).
interface ChangeNumberView {
  readonly isOwner: boolean;
  readonly sw: HTMLButtonElement;
  readonly swLabel: HTMLElement;
  readonly stateLine: HTMLElement;
  // The disabled-with-reason slot + setter. See the construction comment in changeNumberControl.
  readonly disabledReason: HTMLElement;
  readonly setSwitchDisabled: (reason: string | null) => void;
  current: boolean;
}

// changeNumberControl renders the "Require change number" switch. It loads the current policy on render
// (honest skeleton meanwhile), shows a one-line plain-English explanation, and is enabled only for an Owner.
export function changeNumberControl(engine: EngineClient): HTMLElement {
  const isOwner = can(callerRole(), "access.policy") && callerRole() === "owner";
  const card = h("section", { "aria-label": "Require a change number for change-controlled actions", style: "display:grid;gap:var(--space-3)" });

  const header = h("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-3);flex-wrap:wrap" });
  const heading = h("div", { style: "display:grid;gap:var(--space-1)" });
  // What the control does, as three short scannable lines (how it differs from dual control /
  // what gets recorded when on / what is exempt) rather than one dense paragraph.
  heading.appendChild(
    h(
      "ul",
      { class: "field__hint", style: "margin:0;padding-left:var(--space-4);display:grid;gap:var(--space-1)" },
      h("li", "Separate from dual control (four-eyes) above: dual control adds a second approver before a change applies; this records a change number against the action for the audit trail and adds no approver."),
      h("li", "When on: a change-controlled action (repointing or removing a destination, an identity-provider change, applying a restore, retiring the break-glass token or minting a support credential) asks for a change number, recorded in the audit log. An emergency without a number can proceed as an Emergency Change with a justification, flagged in compliance for retrospective review."),
      h("li", "Not affected: everyday settings and config, dual-control config approvals, and adding backup sources."),
    ),
  );
  // Group-level doc link for this switch: the page section that sets out the
  // change-number policy in full, what it records and how it differs from four-eyes dual control.
  heading.appendChild(
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/identity-access/change-control#require-change-number", target: "_blank", rel: "noreferrer noopener" },
      "About change numbers",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );
  header.appendChild(heading);

  const sw = h("button", { "data-dp": "security-centre.switch.change-number-control",
    type: "button",
    role: "switch",
    class: "btn btn--secondary btn--sm cfg-approval__switch",
    "aria-checked": "false",
    "aria-label": "Require a change number",
    disabled: true,
  }) as HTMLButtonElement;
  const swLabel = h("span", { class: "cfg-approval__switch-label" }, "Loading");
  sw.appendChild(swLabel);
  header.appendChild(h("div", { class: "cfg-approval__control", style: "display:flex;align-items:center;gap:var(--space-2)" }, sw));
  card.appendChild(header);

  const stateLine = h("div", { class: "cfg-approval__state", style: "display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap" });
  card.appendChild(stateLine);

  // The disabled-with-reason slot: a non-owner's standing refusal is aria-disabled + reachable
  // + announced (via the shared disabledWithReason primitive) rather than dropping the switch out of the
  // tab order the way native `disabled` would. Created once;
  // reflect() re-inserts the SAME node on every repaint. Native `disabled` stays in use for the load and
  // busy states and for "this engine build does not support the feature", none of which is a refusal
  // about who this caller is -- see security-centre/access.ts's own fuller version of this split.
  const disabledReason = h("p", { class: "field__hint", id: "change-number-disabled-reason", hidden: true });
  disabledReason.hidden = true; // property, not just the attribute -- see field.ts's own SHIM NOTE.
  const setSwitchDisabled = disabledWithReason(sw, disabledReason);

  const view: ChangeNumberView = { isOwner, sw, swLabel, stateLine, disabledReason, setSwitchDisabled, current: false };
  sw.addEventListener("click", () => void onToggle(engine, view));
  loadPolicy(engine, view);
  return card;
}

// reflect paints the switch + state line for a known value and busy/availability state.
function reflect(view: ChangeNumberView, on: boolean, opts: { busy?: boolean; available?: boolean } = {}): void {
  const { isOwner, sw, swLabel, stateLine, disabledReason, setSwitchDisabled } = view;
  const available = opts.available !== false;
  sw.setAttribute("aria-checked", on ? "true" : "false");
  sw.classList.toggle("cfg-approval__switch--on", on);
  swLabel.textContent = on ? "On" : "Off";
  sw.disabled = opts.busy === true || !available;
  // UNAVAILABLE clears the standing refusal rather than stating it into a node the replaceChildren()
  // below removes and the early return never re-appends: the same dangling-aria-describedby defect that
  // was proven live in signin-context.ts, identical in shape here. An absent feature is
  // not a refusal about who this caller is.
  setSwitchDisabled(available && !isOwner ? "Only an Owner can change this requirement." : null);
  stateLine.replaceChildren();
  if (!available) {
    stateLine.appendChild(h("span", { class: "field__hint" }, "This engine build does not support change-number recording yet."));
    return;
  }
  stateLine.appendChild(
    on
      ? statusWithLabel("trust", "On: change-controlled actions ask for a change number.")
      : statusWithLabel("neutral", "Off: change-controlled actions do not ask for a change number."),
  );
  if (!isOwner) {
    stateLine.appendChild(badge("neutral", "Owner only"));
    stateLine.appendChild(disabledReason);
  }
  if (on) {
    stateLine.appendChild(
      h("button", { "data-dp": "security-centre.button.navigate-reports", class: "btn btn--ghost btn--sm", type: "button", on: { click: () => navigate("/reports") } }, "Open the Change requests report"),
    );
  }
}

// loadPolicy loads the current change-number flag from the shared approval-policy view and reflects it. A
// not-yet-wired engine (404/501) degrades to the honest unavailable note; any other fault disables the switch.
function loadPolicy(engine: EngineClient, view: ChangeNumberView): void {
  void engine
    .getConfigApprovalPolicy()
    .then((p) => { view.current = p.requireChangeNumber === true; reflect(view, view.current); })
    .catch((err) => {
      if (isUnauthorised(err)) return goSignedOut();
      const kind = classifyError(err, { origin: location.origin });
      if (kind.kind === "server" && (kind.status === 404 || kind.status === 501)) { reflect(view, false, { available: false }); return; }
      // See security-centre/access.ts loadApprovalPolicy. This branch disabled the switch for the
      // life of the screen and left a parenthesised engine verb under it, with nothing to press.
      view.sw.disabled = true;
      view.swLabel.textContent = "Unavailable";
      view.stateLine.replaceChildren(
        inlineRetry({
          message: POLICY_READ_FAILED,
          onReload: () => { view.swLabel.textContent = "Loading"; view.stateLine.replaceChildren(); loadPolicy(engine, view); },
        }),
      );
    });
}

// onToggle confirms the change (it shifts the requirement for every future change-controlled action), saves
// it, and reflects the engine's returned value. A failure restores the prior state so the switch never lies.
async function onToggle(engine: EngineClient, view: ChangeNumberView): Promise<void> {
  if (!view.isOwner || view.sw.disabled) return;
  const next = !view.current;
  const ok = await confirmModal({
    title: next ? "Require a change number" : "Stop requiring a change number",
    body: next
      ? "Turn ON change numbers? From now on, a change-controlled action (a destination repoint or removal, an identity-provider change, applying a restore, retiring the break-glass token, minting a support credential) will ask for a change number, recorded in the audit log. This is separate from dual control: it adds no second approver. An operator without a number can still proceed by raising an Emergency Change, which is flagged in compliance for retrospective review."
      : "Turn OFF change numbers? Change-controlled actions will no longer ask for a change number. Records already in the audit log are kept.",
    confirmLabel: next ? "Require change number" : "Stop requiring",
    variant: next ? "primary" : "danger",
    busyLabel: "Saving",
  });
  if (!ok) return;
  reflect(view, view.current, { busy: true });
  try {
    const saved = await engine.setChangeNumberPolicy(next);
    view.current = saved.requireChangeNumber === true;
    reflect(view, view.current);
    toast({ message: view.current ? "Change-controlled actions now require a change number" : "Change-controlled actions no longer require a change number" });
  } catch (err) {
    if (isUnauthorised(err)) {
      // PAINT FIRST, THEN LEAVE: the busy reflect above disabled this switch, and the restore below
      // is on the other branch.
      reflect(view, view.current);
      return goSignedOut();
    }
    reflect(view, view.current); // restore the prior state; the change did not take
    toast({ message: `Could not change the policy (${errText(err)}).`, tone: "warn" });
  }
}
