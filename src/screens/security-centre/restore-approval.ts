// The RESTORE-APPLY second-approver toggle (owner opt-in, off by default).
//
// WHY IT IS A SEPARATE CONTROL FROM THE ONE IN access.ts. That switch gates config MUTATIONS and carries the
// asymmetric off switch: an attributable owner's disarm queues for a second owner, so its client reads a 202
// as well as a 200. This one gates a WRITE-BACK OVER LIVE DATA, applies in both directions immediately, and
// has no queued disarm, so sharing that machinery would mean carrying a branch that can never fire here.
//
// WHY THE POLICY EXISTS AT ALL. The gate used to be unconditional. canApprove refuses a same-subject AND a
// same-email approval, so on a one-identity estate no restore approval could ever be granted and the apply
// was unreachable, in a configuration the product itself calls valid (one Owner is the floor while config
// dual control is off). Optional, off by default, is what lets a one-person team recover.
//
// House style: Australian English, no em dashes, no rule-of-three, precise claims.
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
import { caller, goSignedOut, navigate } from "../../lib/nav.ts";
import { callerRole, errText, POLICY_READ_FAILED } from "./shared.ts";

interface RestoreApprovalView {
  readonly isOwner: boolean;
  // onlyOwner mirrors the engine's two-identity arm floor. An approval must come from someone other than the
  // requester, so a solo estate that armed this would have nobody able to approve a restore. The engine
  // refuses it server-side regardless; saying so here means the operator reads the reason before the click.
  readonly onlyOwner: boolean;
  readonly sw: HTMLButtonElement;
  readonly swLabel: HTMLElement;
  readonly stateLine: HTMLElement;
  readonly disabledReason: HTMLElement;
  readonly setSwitchDisabled: (reason: string | null) => void;
  current: boolean;
}

export function restoreApprovalControl(engine: EngineClient): HTMLElement {
  const isOwner = can(callerRole(), "access.policy") && callerRole() === "owner";
  const onlyOwner = caller()?.isOnlyOwner === true;
  const card = h("section", { "aria-label": "Require a second approver for restores", style: "display:grid;gap:var(--space-3)" });

  const header = h("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-3);flex-wrap:wrap" });
  const heading = h("div", { style: "display:grid;gap:var(--space-1)" });
  heading.appendChild(
    h(
      "ul",
      { class: "field__hint", style: "margin:0;padding-left:var(--space-4);display:grid;gap:var(--space-1)" },
      h("li", "When on: applying a restore over live data needs a second authorised person to approve that exact plan, and the approver cannot be the person who requested it."),
      h("li", "When off: you can run a restore on your own. The dry run, the plan the approval would have bound to, the passkey re-check and the full audit trail all still apply."),
      h("li", "Turning it on needs a second Owner or Approver in the estate, because a lone operator would have nobody able to approve their restore."),
    ),
  );
  heading.appendChild(
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/recovery/dual-control", target: "_blank", rel: "noreferrer noopener" },
      "About dual control for restores",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );
  header.appendChild(heading);

  const sw = h("button", { "data-dp": "security-centre.switch.restore-approval-control",
    type: "button",
    role: "switch",
    class: "btn btn--secondary btn--sm cfg-approval__switch",
    "aria-checked": "false",
    "aria-label": "Require a second approver for restores",
    disabled: true,
  }) as HTMLButtonElement;
  const swLabel = h("span", { class: "cfg-approval__switch-label" }, "Loading");
  sw.appendChild(swLabel);
  header.appendChild(h("div", { class: "cfg-approval__control", style: "display:flex;align-items:center;gap:var(--space-2)" }, sw));
  card.appendChild(header);

  const stateLine = h("div", { class: "cfg-approval__state", style: "display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap" });
  card.appendChild(stateLine);

  // The disabled-with-reason slot, created once and re-inserted by every reflect: a standing
  // refusal stays reachable and announced rather than dropping out of the tab order. See access.ts for the
  // fuller version of the native-disabled versus aria-disabled split this follows.
  const disabledReason = h("p", { class: "field__hint", id: "restore-approval-disabled-reason", hidden: true });
  disabledReason.hidden = true; // property, not just the attribute -- see field.ts's own SHIM NOTE.
  const setSwitchDisabled = disabledWithReason(sw, disabledReason);

  const view: RestoreApprovalView = { isOwner, onlyOwner, sw, swLabel, stateLine, disabledReason, setSwitchDisabled, current: false };
  sw.addEventListener("click", () => void onToggle(engine, view));
  loadPolicy(engine, view);
  return card;
}

// reflect paints the switch and state line for a known value and busy/availability state.
function reflect(view: RestoreApprovalView, on: boolean, opts: { busy?: boolean; available?: boolean } = {}): void {
  const { isOwner, onlyOwner, sw, swLabel, stateLine, disabledReason, setSwitchDisabled } = view;
  const available = opts.available !== false;
  sw.setAttribute("aria-checked", on ? "true" : "false");
  sw.classList.toggle("cfg-approval__switch--on", on);
  swLabel.textContent = on ? "On" : "Off";
  sw.disabled = opts.busy === true || !available;
  // The standing refusal, in the order the operator meets it: not an Owner at all, then the arm floor. The
  // floor is stated only while the policy is OFF, because it blocks ARMING; an estate that is already on
  // must always be able to turn it back off. UNAVAILABLE clears the refusal rather than writing it into a
  // node the replaceChildren below removes (the dangling aria-describedby proven live).
  setSwitchDisabled(
    !available ? null : !isOwner ? "Only an Owner can change this requirement." : onlyOwner && !on ? "This estate has one identity. Appoint a second Owner or Approver first, otherwise nobody could approve a restore." : null,
  );
  stateLine.replaceChildren();
  if (!available) {
    stateLine.appendChild(h("span", { class: "field__hint" }, "This engine build does not support the restore-approval policy yet."));
    return;
  }
  stateLine.appendChild(
    on
      ? statusWithLabel("trust", "On: a restore apply needs a second person to approve it.")
      : statusWithLabel("neutral", "Off: you can apply a restore on your own."),
  );
  if (!isOwner) {
    stateLine.appendChild(badge("neutral", "Owner only"));
    stateLine.appendChild(disabledReason);
  } else if (onlyOwner && !on) {
    stateLine.appendChild(badge("neutral", "Needs a second person"));
    stateLine.appendChild(disabledReason);
  }
  if (on) {
    stateLine.appendChild(
      h("button", { "data-dp": "security-centre.button.navigate-restore-approvals", class: "btn btn--ghost btn--sm", type: "button", on: { click: () => navigate("/restore/approvals") } }, "Open the approvals inbox"),
    );
  }
}

// loadPolicy reads the flag from the shared approval-policy view. An engine that does not report it yet
// degrades to the honest unavailable note rather than showing a confident "Off" it did not read.
function loadPolicy(engine: EngineClient, view: RestoreApprovalView): void {
  void engine
    .getConfigApprovalPolicy()
    .then((p) => {
      if (p.requireRestoreApproval === undefined) { reflect(view, false, { available: false }); return; }
      view.current = p.requireRestoreApproval === true;
      reflect(view, view.current);
    })
    .catch((err) => {
      if (isUnauthorised(err)) return goSignedOut();
      const kind = classifyError(err, { origin: location.origin });
      if (kind.kind === "server" && (kind.status === 404 || kind.status === 501)) { reflect(view, false, { available: false }); return; }
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

// onToggle confirms, saves, and reflects the engine's returned value. A failure restores the prior state so
// the switch never lies. The ARM refusal is surfaced verbatim: the engine's sentence names the remedy
// (appoint a second Owner or Approver), which a generic "could not save" would throw away.
async function onToggle(engine: EngineClient, view: RestoreApprovalView): Promise<void> {
  if (!view.isOwner || view.sw.disabled) return;
  const next = !view.current;
  const ok = await confirmModal({
    title: next ? "Require a second approver for restores" : "Stop requiring a second approver",
    body: next
      ? "Turn ON the second-approver requirement? From now on, applying a restore over live data will need a second authorised person to approve the exact plan, and they cannot be the person who requested it. Make sure a second Owner or Approver exists first, otherwise nobody will be able to approve a restore."
      : "Turn OFF the second-approver requirement? A restore apply will proceed on the identity of whoever runs it. The dry run, the plan binding, the passkey re-check and the audit trail are unchanged, and approvals already recorded are kept.",
    confirmLabel: next ? "Require a second approver" : "Stop requiring",
    variant: next ? "primary" : "danger",
    busyLabel: "Saving",
  });
  if (!ok) return;
  reflect(view, view.current, { busy: true });
  try {
    const saved = await engine.setRestoreApprovalPolicy(next);
    view.current = saved.requireRestoreApproval === true;
    reflect(view, view.current);
    toast({ message: view.current ? "A restore apply now needs a second approver" : "A restore apply no longer needs a second approver" });
  } catch (err) {
    if (isUnauthorised(err)) {
      // PAINT FIRST, THEN LEAVE: the busy reflect above disabled this switch and the restore is on the
      // other branch, so repaint before navigating away.
      reflect(view, view.current);
      return goSignedOut();
    }
    reflect(view, view.current); // the change did not take; restore the prior state
    toast({ message: `Could not change the policy (${errText(err)}).`, tone: "warn" });
  }
}
