// The two access-posture CONTROLS of the Security centre: the dual control (four-eyes) policy toggle,
// and the recovery codes + break-glass surface (the caller's own remaining single-use recovery codes with a
// Regenerate, and the Owner-only "Retire break-glass token" control). Both mirror the engine's owner-only
// writes (a non-owner sees the state read-only, never a hidden 403) and degrade honestly on an engine that
// does not back the route. The fresh recovery set is shown ONCE in a modal that cannot be dismissed until the
// save-confirm is ticked. Moved verbatim from the security-centre coordinator for size; it imports the shared
// leaf (./shared.ts) only, so it never imports another section module (which would form a cycle).
//
// House rules: no-custody (no value or key transits; the fresh codes are shown once and never re-fetchable);
// precise claims; Australian English, no em dashes.

import { type EngineClient, isOwnerActionQueuedResult, type RecoveryCodesResult, type StatusReport } from "../../api.ts";
import { inlineRetry, sessionEnded, stepUpAwareText } from "../../components/error-view.ts";
import { skeletonRows } from "../../components/feedback.ts";
import { disabledWithReason } from "../../components/field.ts";
import { confirmModal, openModal } from "../../components/modal.ts";
import { hasUsableRecoveryCodes, recoveryCodesPanel } from "../../components/recovery-codes-panel.ts";
import { requireChange } from "../../components/require-change.ts";
import { badge, type StatusTone, statusWithLabel } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { recordContractSkew } from "../../lib/client-diag/ring.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { classifyError, isUnauthorised, isStepUpRequired } from "../../lib/errors.ts";
import { deliverFile } from "../../lib/file-delivery.ts";
import { titleCase } from "../../lib/format.ts";
import { ICON_EXTERNAL, ICON_REFRESH } from "../../lib/icons.ts";
import { can } from "../../lib/identity.ts";
import { caller, goSignedOut, navigate } from "../../lib/nav.ts";
import { blindGateRemedy } from "../../lib/identity-remedy.ts";
import { ENABLE_DUAL_CONTROL_NEEDS_TWO_OWNERS } from "../../lib/owner-floor.ts";
import { surfaceQueuedOwnerAction } from "../../lib/pending-change-toast.ts";
import { callerRole, errText, POLICY_READ_FAILED } from "./shared.ts";

// configApprovalControl renders the four-eyes / dual-control policy toggle: a clearly-labelled switch
// bound to get/setConfigApprovalPolicy. It loads the current policy on render (honest skeleton meanwhile),
// shows a one-line plain-English explanation of what turning it on does, and is ENABLED only for an Owner
// (the engine's POST is owner-only; everyone else sees it read-only with "owner only" so a reviewer can
// still SEE the state). Toggling it confirms (it changes the posture of every future config change), calls
// setConfigApprovalPolicy, and reflects the engine's returned policy. A 404/501 (engine without the gate)
// degrades to an honest "not available on this engine" note rather than a broken control. Strict-CSP safe:
// h() builder, a role="switch" button with aria-checked, no inline handler.
export function configApprovalControl(engine: EngineClient): HTMLElement {
  const isOwner = can(callerRole(), "access.policy") && callerRole() === "owner";
  // Disclosure body (the heading lives in the wrapping summary; the label below
  // keeps "four-eyes / dual control" in the body for clarity and the validator).
  const card = h("section", { "aria-label": "Require approval for config changes (four-eyes / dual control)", style: "display:grid;gap:var(--space-3)" });

  const header = h("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-3);flex-wrap:wrap" });
  const heading = h("div", { style: "display:grid;gap:var(--space-1)" });
  // The plain-English statement of what the control does, as three short scannable lines
  // (what on means / who must differ / what off means) rather than one dense paragraph.
  heading.appendChild(
    h(
      "ul",
      { class: "field__hint", style: "margin:0;padding-left:var(--space-4);display:grid;gap:var(--space-1)" },
      h("li", "When on: saving a downpipe, a role, a notification rule, the alert webhook, a posture risk-accept or an expiry item is queued until a second authorised person approves it."),
      h("li", "The approver must differ from whoever proposed the change (maker is not checker)."),
      h("li", "When off: those changes apply immediately."),
    ),
  );
  // Group-level doc link for this toggle: the page that sets out four-eyes change
  // control in full, exactly what it covers and what it does not.
  heading.appendChild(
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/identity-access/change-control#what-the-gate-covers-and-what-it-does-not", target: "_blank", rel: "noreferrer noopener" },
      "About four-eyes change control",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );
  header.appendChild(heading);

  // The switch + its status, built once and updated by the loader. Disabled until the policy loads (and
  // permanently for a non-owner). The status text is the screen-reader and visual state label.
  const sw = h("button", { "data-dp": "security-centre.switch.config-approval-control",
    type: "button",
    role: "switch",
    class: "btn btn--secondary btn--sm cfg-approval__switch",
    "aria-checked": "false",
    "aria-label": "Require approval for config changes",
    disabled: true,
  }) as HTMLButtonElement;
  const swLabel = h("span", { class: "cfg-approval__switch-label" }, "Loading");
  sw.appendChild(swLabel);
  header.appendChild(h("div", { class: "cfg-approval__control", style: "display:flex;align-items:center;gap:var(--space-2)" }, sw));
  card.appendChild(header);

  // The state line under the header (read-only note for a non-owner, the link to the inbox, the loaded
  // state), replaced as the policy loads / changes.
  const stateLine = h("div", { class: "cfg-approval__state", style: "display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap" });
  card.appendChild(stateLine);

  // The disabled-with-reason slot: a STANDING permission refusal (not an Owner, or the
  // sole-Owner rule a mirror below) is aria-disabled + reachable + announced, via the shared
  // disabledWithReason primitive, rather than the switch dropping out of the tab order the way the
  // native `disabled` attribute would. Created once so the
  // keydown/mousedown guards are wired once; reflectApprovalPolicy re-inserts the SAME node into
  // stateLine on every repaint rather than rebuilding it, so the primitive's own closure keeps
  // targeting a live DOM node. The native `disabled` attribute stays in use for the two states that are
  // NOT a permission refusal -- the initial load and mid-save busy lock, and "this engine build does not
  // support the feature yet" -- because those are transient or absence-of-feature states with no stable
  // reason worth a keyboard/screen-reader user tabbing onto, not a refusal about who this caller is.
  const disabledReason = h("p", { class: "field__hint", id: "cfg-approval-disabled-reason", hidden: true });
  disabledReason.hidden = true; // property, not just the attribute -- see field.ts's own SHIM NOTE.
  const setSwitchDisabled = disabledWithReason(sw, disabledReason);

  // onlyOwner mirrors the engine's dual-control enable guard (rule a): Require Approver needs a DISTINCT second
  // Owner to approve, so a lone Owner cannot arm it (they would deadlock themselves, with every maker=checker
  // change unapprovable). isOnlyOwner is the engine's own whoami signal, so for this Owner caller it is exactly
  // "one Owner exists"; the engine re-checks the count server-side regardless.
  const onlyOwner = caller()?.isOnlyOwner === true;
  // The shared mutable view passed to the named helpers below: the switch + label + state line and the
  // current loaded value (so the click handler knows what to flip to). Kept as one object so reflect /
  // load / the click handler take it as an explicit parameter instead of closing over loose locals.
  const view: ApprovalView = { isOwner, onlyOwner, sw, swLabel, stateLine, disabledReason, setSwitchDisabled, current: false };

  sw.addEventListener("click", () => void onApprovalToggle(engine, view));

  loadApprovalPolicy(engine, view);
  return card;
}

// The mutable view configApprovalControl shares with its helpers: the rendered controls plus the current
// loaded policy value (which the click handler reads to decide what to flip to and writes after a save).
interface ApprovalView {
  readonly isOwner: boolean;
  // onlyOwner: this Owner is the estate's SOLE Owner, so dual control cannot yet be armed (rule a mirror).
  readonly onlyOwner: boolean;
  readonly sw: HTMLButtonElement;
  readonly swLabel: HTMLElement;
  readonly stateLine: HTMLElement;
  // The disabled-with-reason slot + setter, created once in configApprovalControl and reused
  // by every reflectApprovalPolicy repaint. See the construction comment there.
  readonly disabledReason: HTMLElement;
  readonly setSwitchDisabled: (reason: string | null) => void;
  current: boolean;
}

// reflectApprovalPolicy paints the switch + state line for a known policy value and busy/availability state.
function reflectApprovalPolicy(view: ApprovalView, on: boolean, opts: { busy?: boolean; available?: boolean } = {}): void {
  const { isOwner, onlyOwner, sw, swLabel, stateLine, disabledReason, setSwitchDisabled } = view;
  const available = opts.available !== false;
  // Rule a mirror: an Owner who is the SOLE Owner cannot ARM dual control (there is no distinct second Owner to
  // approve). This only blocks turning it ON (when it is currently OFF); turning it OFF is always allowed, so a
  // gate that is somehow ON can still be disarmed. The engine refuses the arm server-side regardless.
  const cannotEnable = isOwner && !on && onlyOwner;
  sw.setAttribute("aria-checked", on ? "true" : "false");
  sw.classList.toggle("cfg-approval__switch--on", on);
  swLabel.textContent = on ? "On" : "Off";
  // Native `disabled` for the two states that are NOT a permission refusal: mid-save busy, and an engine
  // build that does not carry the route at all. aria-disabled (via setSwitchDisabled below) for the two
  // that ARE a refusal about who this caller is: not an Owner, or the sole-Owner rule a mirror.
  sw.disabled = opts.busy === true || !available;
  // UNAVAILABLE clears the standing refusal rather than stating it into a node the replaceChildren()
  // below removes and the early return never re-appends: the same dangling-aria-describedby defect that
  // was proven live in signin-context.ts, identical in shape here. An absent feature is
  // not a refusal about who this caller is, which is this file's own split a few lines above.
  setSwitchDisabled(!available ? null : !isOwner ? "Only an Owner can change this requirement." : cannotEnable ? ENABLE_DUAL_CONTROL_NEEDS_TWO_OWNERS : null);
  stateLine.replaceChildren();
  if (!available) {
    stateLine.appendChild(h("span", { class: "field__hint" }, "This engine build does not support config change-control yet."));
    return;
  }
  stateLine.appendChild(
    on
      ? statusWithLabel("trust", "Four-eyes is ON: config changes need a second approver.")
      : statusWithLabel("neutral", "Four-eyes is OFF: config changes apply immediately."),
  );
  if (!isOwner) {
    stateLine.appendChild(badge("neutral", "Owner only"));
  } else if (cannotEnable) {
    stateLine.appendChild(badge("neutral", "Needs a second Owner"));
  }
  if (!isOwner || cannotEnable) stateLine.appendChild(disabledReason);
  if (on) {
    stateLine.appendChild(
      h("button", { "data-dp": "security-centre.button.navigate-config-changes", class: "btn btn--ghost btn--sm", type: "button", on: { click: () => navigate("/config/changes") } }, "Open config approvals"),
    );
    // The same requirement also gates high-blast-radius owner actions (for example a destination repoint
    // or an identity-provider change), which queue in a separate owner-approval inbox for a second owner.
    // Offer a direct link so an owner does not have to hunt for where those queue (it is owner-only; the
    // engine enforces).
    if (isOwner) {
      stateLine.appendChild(
        h("button", { "data-dp": "security-centre.button.navigate-security-owner-actions", class: "btn btn--ghost btn--sm", type: "button", on: { click: () => navigate("/security/owner-actions") } }, "Open owner approvals"),
      );
    }
  }
}

// loadApprovalPolicy loads the current policy and reflects it. A not-yet-wired engine (404/501) degrades to
// the honest unavailable note; any other fault shows a quiet inline hint and leaves the switch disabled.
function loadApprovalPolicy(engine: EngineClient, view: ApprovalView): void {
  void engine
    .getConfigApprovalPolicy()
    .then((p) => { view.current = p.requireConfigApproval; reflectApprovalPolicy(view, view.current); })
    .catch((err) => {
      if (isUnauthorised(err)) return goSignedOut();
      const kind = classifyError(err, { origin: location.origin });
      if (kind.kind === "server" && (kind.status === 404 || kind.status === 501)) { reflectApprovalPolicy(view, false, { available: false }); return; }
      // This branch used to end the control's life. The switch was disabled, the label read
      // "Unavailable", and the only thing under it was `Could not load the policy (get approval policy:
      // 500).` -- the engine client's own throw, parenthesised. It named no remedy, and because the control
      // is BUILT ONCE at screen render there was nothing to press and no way back short of reloading the
      // tab. All three switches on this screen read the same policy, so one engine fault dead-ended three
      // controls at once.
      view.sw.disabled = true;
      view.swLabel.textContent = "Unavailable";
      view.stateLine.replaceChildren(
        inlineRetry({
          message: POLICY_READ_FAILED,
          onReload: () => { view.swLabel.textContent = "Loading"; view.stateLine.replaceChildren(); loadApprovalPolicy(engine, view); },
        }),
      );
    });
}

// onApprovalToggle confirms the change (it shifts the posture of every future config change), saves it, and
// reflects the engine's returned policy. A failure restores the prior state so the switch never lies.
async function onApprovalToggle(engine: EngineClient, view: ApprovalView): Promise<void> {
  if (!view.isOwner || view.sw.disabled) return;
  const next = !view.current;
  // Rule a backstop: never send an arm the engine will refuse. The switch is already disabled for a sole
  // Owner, so this only fires if the disabled state was ever bypassed; it says WHY upfront rather than letting
  // the engine 400. Turning OFF is never blocked.
  if (next && view.onlyOwner) {
    toast({ message: ENABLE_DUAL_CONTROL_NEEDS_TWO_OWNERS, tone: "warn" });
    return;
  }
  const ok = await confirmModal({
    title: next ? "Require approval for config changes" : "Stop requiring approval for config changes",
    body: next
      ? "Turn ON four-eyes / dual control? From now on, every config change is queued for a second authorised person to approve before it takes effect. This does not affect changes already applied."
      : "Turn OFF four-eyes / dual control? Config changes will apply immediately again, with no second approver. Any change currently queued stays in the Config approvals inbox. Disarming is itself gated: if this account has more than one owner, your disarm may queue for a second owner instead of taking effect immediately.",
    confirmLabel: next ? "Require approval" : "Stop requiring approval",
    variant: next ? "primary" : "danger",
    busyLabel: "Saving",
  });
  if (!ok) return;
  reflectApprovalPolicy(view, view.current, { busy: true });
  try {
    const res = await engine.setConfigApprovalPolicy(next);
    if (isOwnerActionQueuedResult(res)) {
      // Disarming is the engine's asymmetric off-switch -- a lone attributable owner's disarm QUEUES
      // for a SECOND owner rather than applying, so the policy has NOT changed. Repaint the ACTUAL,
      // unchanged state (never the optimistic "next" value), instead of showing "Off" for a gate that is
      // still armed, and say so honestly via the same queued-owner-action toast every other gated owner
      // mutation uses.
      reflectApprovalPolicy(view, view.current);
      surfaceQueuedOwnerAction(next ? "Turning on four-eyes / dual control" : "Turning off four-eyes / dual control");
      return;
    }
    view.current = res.value.requireConfigApproval;
    reflectApprovalPolicy(view, view.current);
    toast({ message: view.current ? "Config changes now require a second approver" : "Config changes no longer require approval" });
  } catch (err) {
    if (isUnauthorised(err)) {
      // PAINT FIRST, THEN LEAVE: the busy reflect above disabled this switch, and the restore below
      // is on the other branch.
      reflectApprovalPolicy(view, view.current);
      return goSignedOut();
    }
    reflectApprovalPolicy(view, view.current); // restore the prior state; the change did not take
    toast({ message: `Could not change the policy (${errText(err)}).`, tone: "warn" });
  }
}

// ===========================================================================
// Recovery codes + break-glass token (the engine's own sign-in break-glass surface).
// ===========================================================================

// recoveryAccessControl renders the recovery-code posture: the caller's OWN remaining single-use recovery
// codes (loaded from GET /admin/status), a Regenerate action (any signed-in user may regenerate their own
// codes; the engine reads the verified identity, so there is no email field and one user can never
// regenerate another's), and the Owner-only "Retire break-glass token" control. Regenerate shows the fresh
// set ONCE in the same one-time panel as enrolment (inside a modal that cannot be dismissed until the
// save-confirm is ticked). The retire control is ENABLED only for an Owner (others see it read-only with
// "owner only"), mirrors the engine's owner-only POST, and surfaces the engine's refuse-until-break-glass
// error PLAINLY when no alternative break-glass exists yet. A status surface an older engine does not report
// degrades to an honest "not available" note. Strict-CSP safe: h() builder, real listeners, no inline
// handler. No value or key transits; the counts/flags are booleans + a number, and the fresh codes are
// shown once and never re-fetchable.
export function recoveryAccessControl(engine: EngineClient): HTMLElement {
  const isOwner = can(callerRole(), "access.policy") && callerRole() === "owner";
  // Disclosure body (the heading lives in the wrapping summary).
  const card = h("section", { "aria-label": "Recovery codes and break-glass", style: "display:grid;gap:var(--space-4)" });

  const header = h("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-3);flex-wrap:wrap" });
  const heading = h("div", { style: "display:grid;gap:var(--space-1)" });
  heading.appendChild(
    h("p", { class: "field__hint", style: "margin:0" }, "Single-use recovery codes are the offline way back in if you lose your passkey. Regenerate yours below if you are running low; the new set replaces the old. An Owner can also retire the static bootstrap token once a real break-glass exists."),
  );
  header.appendChild(heading);
  card.appendChild(header);

  // The body: a count + Regenerate row, then the retire control. Replaced as the status loads.
  const body = h("div", { class: "stack", style: "display:grid;gap:var(--space-4)" });
  body.appendChild(skeletonRows(2));
  card.appendChild(body);

  const load = (): void => {
    body.replaceChildren(skeletonRows(2));
    void engine
      .status()
      .then((status) => body.replaceChildren(renderRecoveryAccess(engine, status, isOwner, load)))
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the recovery-code block is a skeleton until this replaces it.
          body.replaceChildren(sessionEnded(load));
          return goSignedOut();
        }
        // The failed read took the WHOLE panel with it. Behind this one line sat the operator's
        // remaining recovery-code count, the Regenerate control and the Owner-only break-glass retire, and
        // all of it was replaced by a parenthesised engine verb with nothing to press. `load` is right here
        // in scope and re-runs the read, so the dead end was never necessary.
        body.replaceChildren(
          inlineRetry({
            message: "The engine did not answer with your recovery-code status, so it is not shown. Your codes are unaffected: this is a failed read, not a change to them.",
            onReload: load,
          }),
        );
      });
  };
  load();
  return card;
}

// renderRecoveryAccess builds the loaded body: the recovery-code count + Regenerate, then the retire
// control. Exported so the validator can render it against a stub StatusReport and inspect the tree (the
// remaining count, the Regenerate affordance, and the owner-only retire gating) without a live engine.
export function renderRecoveryAccess(engine: EngineClient, status: StatusReport, isOwner: boolean, reload: () => void): HTMLElement {
  const wrap = h("div", { class: "stack", style: "display:grid;gap:var(--space-4)" });

  // ---- The recovery-code count + Regenerate ----
  const remaining = status.recoveryCodesRemaining;
  const countCard = h("div", { class: "card card--inset", style: "display:grid;gap:var(--space-3)" });
  const countRow = h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);flex-wrap:wrap" });
  const countLead = h("div", { style: "display:grid;gap:var(--space-1)" });
  countLead.appendChild(h("span", { class: "section-label" }, "Your recovery codes"));
  if (remaining === undefined) {
    // An older engine that does not report the count: honest absence, never a fabricated number.
    //
    // "Why did my recovery-code count vanish?" A field the status payload dropped and an engine that never
    // carried it are the same screen, and the pack could see the engine VERSION but never that the console had
    // actually been handed a status payload with the field missing. Joined to engine.version this pins it to a
    // deploy; on its own the engine version only says which build is running, not what it stopped sending.
    recordContractSkew("missing-field", "status-fields");
    countLead.appendChild(h("span", { class: "field__hint" }, "This engine does not report your remaining recovery-code count."));
  } else if (!recoveryCountReadable(remaining)) {
    // Reported, and not a count. A DIFFERENT state from the absent one above and from every healthy one
    // below, so it gets its own sentence and its own row in the pack; the malformed value is never printed.
    recordContractSkew("wrong-shape", "status-fields");
    countLead.appendChild(
      h(
        "span",
        { style: "display:inline-flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" },
        statusWithLabel("warn", "Recovery-code count could not be read"),
      ),
    );
    countLead.appendChild(h("span", { class: "field__hint" }, RECOVERY_COUNT_UNREADABLE_LINE));
  } else {
    countLead.appendChild(
      h(
        "span",
        { style: "display:inline-flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" },
        statusWithLabel(recoveryCountTone(remaining), `${remaining} unused ${remaining === 1 ? "code" : "codes"} remaining`),
      ),
    );
    if (remaining === 0) countLead.appendChild(h("span", { class: "field__hint" }, "You have no unused recovery codes. Regenerate a fresh set and save them offline."));
    else if (remaining <= RECOVERY_CODES_LOW_AT) countLead.appendChild(h("span", { class: "field__hint" }, "You are running low. Regenerate a fresh set and save them offline; the new set replaces the old."));
  }
  countRow.appendChild(countLead);
  const regenBtn = h("button", { "data-dp": "security-centre.button.regen", class: "btn btn--secondary btn--sm", type: "button" }, svgIcon(ICON_REFRESH, { size: 14 }), "Regenerate recovery codes") as HTMLButtonElement;
  regenBtn.addEventListener("click", () => void regenerateRecoveryCodesFlow(engine, reload));
  countRow.appendChild(regenBtn);
  countCard.appendChild(countRow);
  countCard.appendChild(h("p", { class: "field__hint", style: "margin:0" }, "Regenerating mints a fresh set of single-use codes for your own account and invalidates every previous code. The new set is shown once; save it offline."));
  wrap.appendChild(countCard);

  // ---- The Owner-only retire-break-glass-token control (near the dispose-bootstrap-token finding) ----
  wrap.appendChild(retireBreakGlassControl(engine, status, isOwner, reload));

  return wrap;
}

// recoveryCountTone gives the remaining-code count an honest tone, never a stale green: 0 reads danger
// (no way back in via a code), low reads warn, healthy reads ok. Exported for the validator.
export const RECOVERY_CODES_LOW_AT = 3;
export function recoveryCountTone(remaining: number): StatusTone {
  // A value that is not a usable count may NOT fall through to a tone at all: every comparison below is
  // false for NaN, so an unreadable count used to earn the SAME ok green a healthy eight does. The caller
  // gates on recoveryCountReadable first; this guard is the belt to that brace, and it fails to warn, never
  // to ok. See recoveryCountReadable for the measured symptom.
  if (!recoveryCountReadable(remaining)) return "warn";
  if (remaining <= 0) return "danger";
  if (remaining <= RECOVERY_CODES_LOW_AT) return "warn";
  return "ok";
}

// recoveryCountReadable is the ONE test of whether the engine's recoveryCodesRemaining may be believed. A
// count is a non-negative integer and nothing else.
//
// THE FIELD IS TYPED `number | undefined` AND THE WIRE DOES NOT PROMISE EITHER. Driving the real renderer:
// a count of NaN rendered "NaN unused codes remaining" beside an OK GREEN dot, the same hue a healthy eight
// earns, because every `<=` comparison is false for NaN and the function fell through to its healthy arm; a
// count of null rendered a DANGER dot beside the words "You are running low", two different verdicts inside
// one card, because `null <= 0` is true (null coerces to 0) while `null === 0` is false. A string "8" read
// as ok by coercion, which happens to be right and is right by accident.
//
// This is deliberately NOT folded into the absent case above. "This engine does not report your remaining
// recovery-code count" is a true and calm sentence about an older build; "the engine reported a count this
// console cannot read" is a fault in a live build, and telling an operator the wrong one of those two sends
// them to the wrong remedy. Exported for the validator.
export function recoveryCountReadable(remaining: unknown): remaining is number {
  return typeof remaining === "number" && Number.isInteger(remaining) && remaining >= 0;
}

// RECOVERY_COUNT_UNREADABLE_LINE is what the card says when the engine reported a count that is not one.
// The break-glass path is the last way back into a locked-out account, so the sentence names the check the
// operator can still make for themselves rather than leaving them with a bare fault.
export const RECOVERY_COUNT_UNREADABLE_LINE =
  "Your engine reported a remaining recovery-code count this console cannot read, so the count is not shown. Regenerate a fresh set if you are not certain you still hold usable codes; the raw figure travels in a support pack.";

// regenerateRecoveryCodesFlow confirms (regenerating invalidates the old codes), calls
// regenerateRecoveryCodes, and shows the fresh set ONCE in the same one-time panel as enrolment, inside a
// modal that cannot be dismissed until the save-confirm is ticked. On the panel's confirm the modal closes
// and the screen reloads (so the count refreshes to the new total). A failure surfaces as a warn toast.
async function regenerateRecoveryCodesFlow(engine: EngineClient, reload: () => void): Promise<void> {
  const ok = await confirmModal({
    title: "Regenerate recovery codes",
    body: "Generate a fresh set of recovery codes? Your current codes will stop working immediately, and the new set is shown only once. Make sure you can save the new codes offline now. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is regenerated and your current codes keep working.",
    confirmLabel: "Regenerate codes",
    variant: "primary",
    busyLabel: "Generating",
  });
  if (!ok) return;
  let result: RecoveryCodesResult;
  try {
    result = await engine.regenerateRecoveryCodes();
  } catch (err) {
    if (isUnauthorised(err)) return goSignedOut();
    toast({ message: `Could not regenerate your recovery codes. ${stepUpAwareText(err)}`, tone: "warn" });
    return;
  }
  // A 200 is not proof the body is USABLE. The engine's write succeeded at the HTTP layer (this is
  // not the catch block above) but the answer did not carry a set of codes to show -- the public tour's
  // demo world used to fall through its unmodelled /admin/auth/* fallback to a generic {ok:true} shape here,
  // and recoveryCodesPanel would then throw on the missing array. The panel itself no longer throws on this
  // (hasUsableRecoveryCodes backs it too), but failing HERE, before a non-dismissable modal opens, gives the
  // operator the same actionable warn toast a thrown/refused write gets, rather than a modal whose only
  // exit is a "your codes could not be shown" dead end.
  if (!hasUsableRecoveryCodes(result.recoveryCodes)) {
    toast({ message: "Could not regenerate your recovery codes (the engine's response did not include the new codes). Reload and check your remaining code count before relying on either set.", tone: "warn" });
    return;
  }
  // Show the fresh set once, in a modal whose body IS the one-time panel. The panel's own save-confirm gates
  // the Continue; Continue closes the modal and reloads the count. The modal is not dismissable so the codes
  // cannot be lost by an Esc / click-out before the save-confirm (the panel is the only way out).
  const handle = openModal({
    title: "Save your new recovery codes",
    dismissable: false,
    body: recoveryCodesPanel({
      codes: result.recoveryCodes,
      context: "regenerate",
      downloadText: localDownloadText,
      onConfirm: () => {
        handle.close();
        toast({ message: "New recovery codes generated. Your previous codes no longer work." });
        reload();
      },
    }),
    // No footer actions: the panel owns the only exit (its save-confirmed Continue), so a "Close" button
    // that bypassed the save-confirm is deliberately not offered.
    actions: [],
  });
}

// retireBreakGlassControl renders the Owner-only "Retire break-glass token" control. It states the current
// disposition (already retired / token fallback disabled, or still active), explains the change takes effect
// immediately with no redeploy, and (for an Owner) offers the retire action. A non-Owner sees it read-only
// ("owner only"). On retire the engine's refuse-until-break-glass error is surfaced PLAINLY (its own reason),
// so the operator learns WHY (no alternative break-glass exists yet) rather than seeing a bare failure.
function retireBreakGlassControl(engine: EngineClient, status: StatusReport, isOwner: boolean, reload: () => void): HTMLElement {
  const retired = status.breakGlassTokenRetired === true;
  const fallbackOff = status.tokenFallbackDisabled === true;
  const card = h("div", { class: "card card--inset", style: "display:grid;gap:var(--space-3)" });

  const head = h("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-3);flex-wrap:wrap" });
  const lead = h("div", { style: "display:grid;gap:var(--space-1)" });
  lead.appendChild(h("span", { class: "section-label" }, "Bootstrap break-glass token"));
  // The honest current-state line.
  if (retired || fallbackOff) {
    lead.appendChild(h("span", { style: "display:inline-flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" }, statusWithLabel("ok", "Retired: the static bootstrap token can no longer sign in.")));
  } else {
    lead.appendChild(h("span", { style: "display:inline-flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" }, statusWithLabel("warn", "Active: the static bootstrap token can still sign in.")));
  }
  lead.appendChild(h("p", { class: "field__hint", style: "margin:0" }, "Retiring disposes the bootstrap token inside the engine. It takes effect immediately, with no redeploy. The engine refuses to retire it until another break-glass exists (your recovery codes are acknowledged, or a second Owner is set up), so you cannot lock yourself out."));
  head.appendChild(lead);

  if (retired || fallbackOff) {
    // Nothing to do: it is already retired. Show the state, no button.
    head.appendChild(badge("ok", "retired"));
    card.appendChild(head);
    return card;
  }

  // Disabled-with-reason, not the native `disabled` attribute + a `title` tooltip a
  // keyboard/screen-reader user never sees: a non-owner still tabs onto the button and hears why it
  // is refused, via the shared disabledWithReason primitive. Two literal h() calls, one per branch
  // (not one call with a computed data-dp), so the static hook census still reads both `#1`/`#2`
  // hooks as it did before.
  if (isOwner) {
    const retireBtn = h("button", { "data-dp": "security-centre.button.retire#1", class: "btn btn--secondary btn--sm", type: "button" }, "Retire break-glass token") as HTMLButtonElement;
    retireBtn.addEventListener("click", () => void retireBreakGlassFlow(engine, reload));
    head.appendChild(retireBtn);
  } else {
    const retireBtn = h("button", { "data-dp": "security-centre.button.retire#2", class: "btn btn--secondary btn--sm", type: "button" }, "Retire break-glass token") as HTMLButtonElement;
    const retireReason = h("p", { class: "field__hint", id: "retire-break-glass-disabled-reason", hidden: true });
    retireReason.hidden = true; // property, not just the attribute -- see field.ts's own SHIM NOTE.
    disabledWithReason(retireBtn, retireReason)(retireGateReason());
    head.appendChild(retireBtn);
    head.appendChild(retireReason);
  }
  card.appendChild(head);

  if (!isOwner) card.appendChild(h("p", { class: "field__hint", style: "display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" }, badge("neutral", "Owner only"), h("span", "Only an Owner can retire the break-glass token.")));

  return card;
}

// retireBreakGlassFlow confirms (it is a security-tightening, one-way change), calls retireBreakGlassToken,
// and surfaces the outcome. The engine's refuse-until-break-glass error is surfaced PLAINLY: its own reason
// (folded into the thrown message by the client) is shown so the operator learns it must set up another
// break-glass first. A success toasts and reloads (so the state line flips to "retired").
async function retireBreakGlassFlow(engine: EngineClient, reload: () => void): Promise<void> {
  const ok = await confirmModal({
    title: "Retire the break-glass token",
    body: "Dispose the static bootstrap token now? It can no longer sign in after this, and the change takes effect immediately without a redeploy. This is one-way: re-enabling a static token would need a redeploy. Make sure you still have another way in first, such as your passkey or your recovery codes, or a second Owner who can let you back in. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is retired and the token still works.",
    confirmLabel: "Retire token",
    variant: "danger",
    busyLabel: "Retiring",
  });
  if (!ok) return;
  // Change management (owner opt-in): retiring the break-glass token removes the way back in, a
  // change-controlled action. Collect a change reference after the confirmation (a no-op when the policy is off).
  const cr = await requireChange(engine, "Retire the break-glass token", "break-glass-retire");
  if (!cr.proceed) return;
  try {
    const res = await engine.retireBreakGlassToken(cr.change ?? undefined);
    // QUEUED, NOT RETIRED. Retiring is a gated owner action, so with dual control armed the engine answers
    // 202 and the latch is NOT set: the static token still signs in until a second owner approves. This
    // branch used to be absent, so the screen claimed the token could no longer sign in while it could,
    // which is the one failure mode this control must never have (an operator told a way in is closed stops
    // treating the live bootstrap token as live).
    if (isOwnerActionQueuedResult(res)) {
      surfaceQueuedOwnerAction("Retiring the break-glass token");
      reload();
      return;
    }
    toast({ message: "Break-glass token retired. The static token can no longer sign in." });
    reload();
  } catch (err) {
    if (isUnauthorised(err)) return goSignedOut();
    // Surface the engine's own reason PLAINLY (the refuse-until-break-glass message, or any other), so the
    // operator learns WHY. errText carries the folded "<verb>: <reason>: <status>" message from the client.
    //
    // EXCEPT for the step-up state, which retireRefuseText cannot help laundering. Its regex pulls the middle
    // group out of "retire break-glass token: <reason>: <status>", and on a cancelled ceremony that middle
    // group is the internal marker constant, so the toast read "Could not retire the break-glass token:
    // stepup-required" -- a protocol token dressed as the engine's explanation. The engine refused nothing
    // there; the operator dismissed their own passkey prompt and the token is untouched.
    toast({
      message: isStepUpRequired(err)
        ? `The break-glass token was not retired. ${stepUpAwareText(err)}`
        : `Could not retire the break-glass token: ${retireRefuseText(err)}`,
      tone: "warn",
    });
  }
}

// retireGateReason is the disabled-button reason for a non-Owner caller.
function retireGateReason(): string {
  const c = caller();
  if (!c) return `Requires the Owner role. ${blindGateRemedy()}`;
  return `Retiring the break-glass token is Owner only; your role (${titleCase(c.role)}) cannot. The engine enforces this server-side.`;
}

// retireRefuseText extracts a clean, human reason from a retire failure. The client folds the engine's
// reason into a "retire break-glass token: <reason>: <status>" message; this pulls the <reason> out so the
// toast reads the engine's explanation plainly (e.g. "no break-glass exists yet"), not the verb/status
// scaffolding. A message without that shape degrades to the raw text. Exported for the validator (the
// load-bearing "the engine's refuse reason is surfaced" behaviour).
export function retireRefuseText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Shape: "retire break-glass token: <reason>: <status>" -> <reason>. Strip the leading verb and the
  // trailing ": <status>" if present.
  const m = /^retire break-glass token:\s*(.*?)(?::\s*\d{3})?\s*$/.exec(raw);
  if (m?.[1] && m[1].trim() !== "") return m[1].trim();
  return raw;
}

// localDownloadText delivers the REGENERATED recovery codes to disk through the guarded primitive, and
// returns whether the browser accepted the delivery. It carries exactly the same
// stakes as the enrolment path in passkey/ceremony.ts, and slightly worse: regenerating has ALREADY
// invalidated the previous set, so an operator whose download is silently refused here is left with no
// working codes at all. A missing capability and a refused one are the same answer, false, and both are
// recorded in the ring that rides inside the support pack.
function localDownloadText(name: string, content: string): boolean {
  return deliverFile(name, content, "text/plain", "recovery-codes");
}
