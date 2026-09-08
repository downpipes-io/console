// The OWNER-OPT-IN "Notify on a sign-in from a new location" control of the Security centre (ASVS
// V6.3.5). It mirrors the change-number toggle exactly: a clearly-labelled switch bound to the
// signin-context policy, ENABLED only for an Owner (the engine's POST is owner-only; everyone else sees
// the state read-only), loaded from the same approval-policy view (which carries notifyNewSignInContext),
// and degrading honestly on an engine that does not back it. When ON, a successful sign-in whose COARSE
// network context (an IPv4 /24 or IPv6 /48 prefix) is not in that operator's recent baseline sends a
// warning notification through the configured channels. The check runs entirely in the customer's own
// account: the raw IP is never stored, only the coarse prefix in a small rolling per-operator set.
//
// House rules: no-custody (no value or key transits); precise claims; Australian English, no em dashes.

import type { EngineClient } from "../../api.ts";
import { inlineRetry, stepUpAwareText } from "../../components/error-view.ts";
import { disabledWithReason } from "../../components/field.ts";
import { confirmModal } from "../../components/modal.ts";
import { badge, statusWithLabel } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { recordContractSkew } from "../../lib/client-diag/ring.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { classifyError, isUnauthorised } from "../../lib/errors.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import { can } from "../../lib/identity.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { callerRole, POLICY_READ_FAILED } from "./shared.ts";

// The mutable view the control shares with its helpers: the rendered switch + labels + state line and the
// current loaded value (so the click handler knows what to flip to and writes it back after a save).
interface SignInContextView {
  readonly isOwner: boolean;
  readonly sw: HTMLButtonElement;
  readonly swLabel: HTMLElement;
  readonly stateLine: HTMLElement;
  // The disabled-with-reason slot + setter. See the construction comment in signInContextControl.
  readonly disabledReason: HTMLElement;
  readonly setSwitchDisabled: (reason: string | null) => void;
  current: boolean;
}

// signInContextControl renders the "Notify on a new sign-in location" switch. It loads the current policy
// on render (honest skeleton meanwhile), explains itself in plain English, and is enabled only for an Owner.
export function signInContextControl(engine: EngineClient): HTMLElement {
  const isOwner = can(callerRole(), "access.policy") && callerRole() === "owner";
  const card = h("section", { "aria-label": "Notify on a sign-in from a new location", style: "display:grid;gap:var(--space-3)" });

  const header = h("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-3);flex-wrap:wrap" });
  const heading = h("div", { style: "display:grid;gap:var(--space-1)" });
  heading.appendChild(
    h(
      "ul",
      { class: "field__hint", style: "margin:0;padding-left:var(--space-4);display:grid;gap:var(--space-1)" },
      h("li", "When on: a successful sign-in (passkey or identity provider) from a network not seen recently for that operator sends a warning notification, the \"did you just sign in from a new place?\" signal that helps a human spot a takeover."),
      h("li", "Privacy: the comparison uses a coarse network prefix only (an IPv4 /24 or IPv6 /48). The raw IP address is never stored, the small per-operator history expires after 90 days, and the notification itself names no address, person or place."),
      h("li", "Noise: the first sign-in ever seen sets the baseline and does not notify; a phone hopping addresses inside one carrier network stays quiet. It is off by default because roaming operators may still find it chatty."),
      h(
        "li",
        "After a quiet spell: if an operator does not sign in at all for 90 days their whole history expires, so their next sign-in is notified even from a network they have used for years. That is the check working rather than a false alarm, and it is the one case where the alert can arrive from a familiar place. Support packs record it as a lapsed baseline so a support engineer can tell the two apart.",
      ),
    ),
  );
  // Group-level doc link (the field audit's G2) for this owner-opt-in switch: the alert-events section
  // that documents the sign-in-new-context event, what it compares, and that it never blocks a sign-in.
  heading.appendChild(
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/day-2/alert-events#sign-in-from-a-new-location-opt-in", target: "_blank", rel: "noreferrer noopener" },
      "About new-location sign-in alerts",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );
  header.appendChild(heading);

  const sw = h("button", { "data-dp": "security-centre.switch.sign-in-context-control",
    type: "button",
    role: "switch",
    class: "btn btn--secondary btn--sm cfg-approval__switch",
    "aria-checked": "false",
    "aria-label": "Notify on a sign-in from a new location",
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
  const disabledReason = h("p", { class: "field__hint", id: "signin-context-disabled-reason", hidden: true });
  disabledReason.hidden = true; // property, not just the attribute -- see field.ts's own SHIM NOTE.
  const setSwitchDisabled = disabledWithReason(sw, disabledReason);

  const view: SignInContextView = { isOwner, sw, swLabel, stateLine, disabledReason, setSwitchDisabled, current: false };
  sw.addEventListener("click", () => void onToggle(engine, view));
  loadPolicy(engine, view);
  return card;
}

// reflect paints the switch + state line for a known value and busy/availability state.
function reflect(view: SignInContextView, on: boolean, opts: { busy?: boolean; available?: boolean } = {}): void {
  const { isOwner, sw, swLabel, stateLine, disabledReason, setSwitchDisabled } = view;
  const available = opts.available !== false;
  sw.setAttribute("aria-checked", on ? "true" : "false");
  sw.classList.toggle("cfg-approval__switch--on", on);
  swLabel.textContent = on ? "On" : "Off";
  sw.disabled = opts.busy === true || !available;
  // UNAVAILABLE clears the standing refusal instead of stating it. Proven live in Chromium on
  // : with `available` false, this used to set aria-disabled + aria-describedby ->
  // "signin-context-disabled-reason", then stateLine.replaceChildren() below removed that node and the
  // early return skipped the !isOwner branch that re-appends it, leaving the switch pointing at an id
  // getElementById could not resolve. A screen reader then read a disabled switch with NO reason, on a
  // control the native `disabled` had already dropped out of the tab order. An absent feature is not a
  // refusal about who this caller is (this file's own split, above), so null is the accurate state.
  setSwitchDisabled(available && !isOwner ? "Only an Owner can change this notification." : null);
  stateLine.replaceChildren();
  if (!available) {
    stateLine.appendChild(h("span", { class: "field__hint" }, "This engine build does not support the new-location sign-in notification yet."));
    return;
  }
  stateLine.appendChild(
    on
      ? statusWithLabel("trust", "On: an unusual sign-in location sends a warning notification.")
      : statusWithLabel("neutral", "Off: sign-ins do not check for a new location."),
  );
  if (!isOwner) {
    stateLine.appendChild(badge("neutral", "Owner only"));
    stateLine.appendChild(disabledReason);
  }
  if (on) {
    stateLine.appendChild(
      h("button", { "data-dp": "security-centre.button.navigate-notifications", class: "btn btn--ghost btn--sm", type: "button", on: { click: () => navigate("/notifications") } }, "Open Notifications"),
    );
  }
}

// loadPolicy loads the current flag from the shared approval-policy view and reflects it. A not-yet-wired
// engine (404/501, or a view without the field) degrades to the honest unavailable note.
function loadPolicy(engine: EngineClient, view: SignInContextView): void {
  void engine
    .getConfigApprovalPolicy()
    .then((p) => {
      // "why did the sign-in notification option vanish?" The approval-policy payload came back without
      // the field and the console honestly hid the control. That is right, and it is also indistinguishable from
      // an engine that never had the feature. This row says the console SAW a policy payload with the field
      // missing, which the engine version alone cannot say.
      if (p.notifyNewSignInContext === undefined) { recordContractSkew("missing-field", "policy-fields"); reflect(view, false, { available: false }); return; }
      view.current = p.notifyNewSignInContext === true;
      reflect(view, view.current);
    })
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

// onToggle confirms the change, saves it, and reflects the engine's returned value. A failure restores the
// prior state so the switch never lies.
async function onToggle(engine: EngineClient, view: SignInContextView): Promise<void> {
  if (!view.isOwner || view.sw.disabled) return;
  const next = !view.current;
  const ok = await confirmModal({
    title: next ? "Notify on a new sign-in location" : "Stop notifying on a new sign-in location",
    // The passkey sentence is required, not decorative: this write is step-up gated on the engine, so a
    // prompt WILL open between pressing the button and the change taking effect. An unannounced prompt in
    // the middle of a security change is the thing stepup-announce-gate exists to prevent, and the wording
    // is the one this console standardised on at access-security/signin-factors.ts:331 rather than a second
    // phrasing of the same promise.
    body: next
      ? "Turn ON the new-location notification? A successful sign-in from a network not seen recently for that operator will send a warning through your configured notification channels. Only a coarse network prefix is compared; the raw IP address is never stored and the notification names no address, person or place. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing changes and you can start again from this card."
      : "Turn OFF the new-location notification? Sign-ins will no longer check for a new network context. The small per-operator history simply expires. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing changes and you can start again from this card.",
    confirmLabel: next ? "Turn on" : "Turn off",
    variant: next ? "primary" : "danger",
    busyLabel: "Saving",
  });
  if (!ok) return;
  reflect(view, view.current, { busy: true });
  try {
    const saved = await engine.setSignInContextPolicy(next);
    view.current = saved.notifyNewSignInContext === true;
    reflect(view, view.current);
    toast({ message: view.current ? "Unusual sign-in locations now send a notification" : "Sign-ins no longer check for a new location" });
  } catch (err) {
    if (isUnauthorised(err)) {
      // PAINT FIRST, THEN LEAVE: the busy reflect above disabled this switch, and the restore below
      // is on the other branch.
      reflect(view, view.current);
      return goSignedOut();
    }
    reflect(view, view.current); // restore the prior state; the change did not take
    // This write is step-up gated on the engine, so a CANCELLED ceremony arrives here as a 401 whose raw
    // message is "stepup-required: 401". Rendering that at an operator says nothing about what they did or
    // what to do next. stepUpAwareText gives that one state its own advice and passes every other error
    // through with the engine's own reason, which is the reason worth showing.
    toast({ message: `Could not change the policy (${stepUpAwareText(err)}).`, tone: "warn" });
  }
}
