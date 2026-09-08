// The actions for an AVAILABLE update (Preview, Update now, the opt-in gradual ramp, and, when the engine
// advertises components, the per-component rows + advanced per-component controls). The one-shot token
// custody, copy and control flow of the original engine-only body are unchanged; the live apply progression
// itself lives in update-apply-flow.ts (shared with the advanced per-component apply). Component awareness
// is STRICTLY additive: with no UpdateStatus.components (an old engine) this body renders exactly the
// pre-multi-component card. House rules: Australian English, no em dashes, precise claims.

import type { EngineClient, RequiredStep, UpdateComponentId, UpdateStatus } from "../../api.ts";
import { type Field, field, validateForm } from "../../components/field.ts";
import { consoleVersion } from "../../lib/console-version.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { capGateReason, refuseWithReason } from "../common.ts";
import {
  compatBlockedReason,
  componentRows,
  promoteSummaryLine,
  queuedForSecondOwnerLine,
  releaseComponentsToApply,
  renderUpdateSteps,
  UPDATE_MANAGE_CAP,
  type UpdateBodyEnv,
  updateRefusalText,
} from "./shared.ts";
import { renderComponentResults, runLiveApplyFlow } from "./update-apply-flow.ts";
import { componentAdvancedSection } from "./update-components-advanced.ts";
import { destinationGateNode } from "./update-outcome-render.ts";
import { rampSection } from "./update-ramp.ts";

// PreviewContext carries the shared closures preview() drives: the engine, the shared progress/error region,
// the two buttons (updateBtn is OPTIONAL: the destination-gate case, design s4, renders Preview with no
// apply control at all, so there is nothing to disable/re-enable alongside it), the resolved gate booleans,
// the component-aware request set (null on an old engine), and the error channel. ApplyContext (below) is the
// SUPERSET updateNow() needs (the token field + wrapper it never has without a destination). Splitting the
// two means the destination-gate branch can build a real, type-safe context for Preview without fabricating
// unused token-field values.
interface PreviewContext {
  engine: EngineClient;
  out: HTMLElement;
  previewBtn: HTMLButtonElement;
  updateBtn?: HTMLButtonElement;
  canManage: boolean;
  canApply: boolean;
  // requested is the component set the release apply addresses: null = legacy engine-only (the engine sent
  // no components map; nothing component-aware goes on the wire), else the release's to-update set.
  requested: UpdateComponentId[] | null;
  // showError writes the engine's reason (or a transport fault) into the shared region as the single inline
  // error channel, never a toast, never a per-line banner stack (calm density).
  showError: (err: unknown) => void;
  // refreshApplyEnabled re-derives Update-now's enabled state from the acknowledgement gate + queued flag (the
  // SINGLE writer). preview()'s finally and updateNow()'s tail call this instead of writing updateBtn.disabled
  // directly, so neither can reopen the acknowledgement gate. markQueuedForSecondOwner records that the apply
  // was deferred to a second owner, so refreshApplyEnabled then keeps the button disabled. Both are OPTIONAL on
  // PreviewContext: the destination-gate branch (design s4) renders Preview with no apply control at all, so
  // there is no button to refresh and no queue to mark -- preview() calls refreshApplyEnabled with `?.()`.
  refreshApplyEnabled?: () => void;
  markQueuedForSecondOwner?: () => void;
}

// ApplyContext extends PreviewContext with what updateNow() additionally needs: the reload/focus callbacks,
// the token field + its wrapper, the channel's expected console version for the post-apply build check, and
// the ack-gate callbacks narrowed to REQUIRED (the full apply path always has an Update-now button to gate).
interface ApplyContext extends PreviewContext {
  reload: () => void;
  restoreFocus: () => void;
  updateBtn: HTMLButtonElement;
  tokenField: Field;
  tokenWrap: HTMLElement;
  // expectedConsoleVersion is the channel's console version, for the post-apply build check (null when the
  // console is not in play).
  expectedConsoleVersion: string | null;
  refreshApplyEnabled: () => void;
  markQueuedForSecondOwner: () => void;
}

// PREVIEW: a dry-run apply with NO token (api.ts omits the token entirely for dryRun). It verifies the
// artefact(s) and reports the plan as a checklist + the "would deploy X, rollback target Y" line, plus the
// per-component plan rows when a component-aware engine sent them; it deploys nothing. Calm and non-alarming
// throughout. A dry-run never returns the 202 queue (the engine gates only live deploys), so the result is
// always the structured PromoteResult. Preview is offered even with no destination configured (design s4): a
// dry-run deploys nothing, so it can never hit the destination gate.
async function preview(ctx: PreviewContext): Promise<void> {
  const { engine, out, previewBtn, updateBtn, canManage, requested, showError } = ctx;
  previewBtn.disabled = true;
  if (updateBtn) updateBtn.disabled = true;
  previewBtn.textContent = "Verifying";
  out.replaceChildren(h("p", { class: "field__hint" }, "Verifying the new version and planning the update. Nothing is deployed by a preview."));
  try {
    const res = await engine.applyUpdate({ dryRun: true, ...(requested !== null && requested.length > 0 ? { components: requested } : {}) });
    if (res.status === "queued") {
      // Defensive: a dry-run is never gated, but if the engine ever queues one, say so honestly rather than
      // claiming a plan. (Unreachable on the current engine.)
      out.replaceChildren(h("p", { style: "color:var(--text)" }, queuedForSecondOwnerLine("apply")));
      return;
    }
    out.replaceChildren(
      h("p", { style: "color:var(--text)" }, promoteSummaryLine(res.value)),
      renderUpdateSteps(res.value.steps),
    );
    renderComponentResults(out, res.value.componentResults);
  } catch (err) {
    if (isUnauthorised(err)) return goSignedOut();
    showError(err);
  } finally {
    previewBtn.disabled = !canManage;
    // Re-derive Update-now through the acknowledgement gate (the single writer of its enabled state), NOT a
    // bare `!canApply`: a preview must never enable an apply whose blocking steps are still unacknowledged (it
    // changed nothing). Optional-chained: the destination-gate branch (design s4) has no apply button and no
    // ack gate, so there is nothing to refresh.
    ctx.refreshApplyEnabled?.();
    previewBtn.textContent = "Preview update (dry-run)";
  }
}

// UPDATE NOW: first press reveals the token field; the second press (with a token) runs the live apply flow
// (update-apply-flow.ts): apply -> settle (when the engine is in the set) -> the console build check (when
// the console landed). The token lives ONLY in `token` here and in the flow's call scope.
async function updateNow(ctx: ApplyContext): Promise<void> {
  const { engine, out, reload, restoreFocus, previewBtn, updateBtn, tokenField, tokenWrap, canManage, requested, expectedConsoleVersion } = ctx;
  if (tokenWrap.hidden) {
    // First press: reveal the token field and focus it. No deploy happens until the operator pastes a token
    // and presses again, so a single click can never deploy.
    tokenWrap.hidden = false;
    tokenField.focus();
    out.replaceChildren(
      h("p", { class: "field__hint" }, "Paste your one-shot Cloudflare deploy token, then press Update now again to verify, deploy and canary-check the new version."),
    );
    return;
  }
  if (!validateForm([tokenField])) return;
  // The one-shot token, held ONLY in this local for the apply -> settle -> check chain. Never persisted or
  // copied anywhere that outlives this handler.
  const token = tokenField.value();
  previewBtn.disabled = true;
  updateBtn.disabled = true;
  updateBtn.textContent = "Deploying…";
  const outcome = await runLiveApplyFlow({ engine, out, reload, restoreFocus }, token, requested, expectedConsoleVersion);
  if (outcome === "queued") {
    // Queued for a second owner: record it so refreshApplyEnabled keeps Update-now disabled (re-enabling
    // would only invite a duplicate queue entry; the queued message tells the operator what to do).
    ctx.markQueuedForSecondOwner();
    tokenWrap.hidden = true;
  }
  previewBtn.disabled = !canManage;
  // Re-derive Update-now through the acknowledgement gate + queued flag, NOT a bare reset: on a no-reload
  // outcome (a refusal, a settle-pending recovery, a transport fault, the console build check) the section
  // is not re-rendered, so a blind `disabled = !canApply` here would reopen the gate on a release whose
  // blocking steps the operator has since unacknowledged.
  ctx.refreshApplyEnabled();
  updateBtn.textContent = "Update now";
}


// availableUpdateBody builds the actions for an AVAILABLE update: Preview (dry-run, no token), Update now
// (collect the one-shot token, run the live flow), the ADVANCED per-component controls (component-aware
// engines only), and the ADVANCED default-off gradual ramp. It renders into `out` (the shared calm
// progress/error region). When the engine's compat verdict says the release is NOT applicable onto this
// engine (compatible:false), the apply/ramp are DISABLED with the honest reason rather than letting the
// owner click into a guaranteed refusal. Owner-gated as disabled-with-reason; the engine enforces. The 202
// owner-action queue (a migration/breaking apply/ramp under dual control) is surfaced as "queued for a
// second owner's approval", never read as a deploy.
export function availableUpdateBody(engine: EngineClient, updates: UpdateStatus, env: UpdateBodyEnv): HTMLElement {
  const { out, reload, restoreFocus, canManage, destConfigured } = env;
  const body = h("div");

  // Component awareness (multi-component updates): derived ONCE from the engine's components map + this
  // bundle's own baked version. rows is [] on an old engine, and then NOTHING component-aware renders and
  // requested stays null (the legacy engine-only wire shape).
  const ownVersion = consoleVersion();
  const rows = componentRows(updates, ownVersion);
  const toApply = releaseComponentsToApply(updates, ownVersion);
  const requested: UpdateComponentId[] | null = rows.length > 0 && toApply.length > 0 ? toApply : null;
  const expectedConsoleVersion = requested?.includes("console") === true ? (updates.components?.console?.recommendedVersion ?? null) : null;

  // The per-component version rows now render ONCE, in the read-only Updates section above (view.ts), so the
  // apply control does not restate them; `rows` here is still what decides the requested component set.

  // COMPAT VERDICT: when the engine reports the release is not applicable onto this engine, disable the live
  // apply + ramp honestly (a dry-run preview is still allowed, it changes nothing and shows the plan/reason).
  // The reason is stated as a calm standing note, not a tinted banner. The engine ALSO enforces this server-side.
  const compatBlocked = compatBlockedReason(updates);
  // canApply folds the owner gate AND the compat verdict: a live deploy is offered only when the operator is the
  // owner and the release is compatible. (Preview ignores compat, it is a no-op verification.)
  const canApply = canManage && compatBlocked === null;

  const actions = h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center;margin-top:var(--space-3)" });

  const previewBtn = h(
    "button",
    { "data-busy-label": "Verifying", "data-dp": "licence.button.preview", class: "btn btn--secondary btn--sm", type: "button" },
    "Preview update (dry-run)",
  ) as HTMLButtonElement;

  const showError = (err: unknown): void => {
    out.replaceChildren(h("p", { class: "field__error", role: "alert" }, updateRefusalText(err)));
  };

  // DESTINATION GATE (design s4): a live apply can never confirm a canary flight with nowhere to fly it, so
  // with no destination configured the apply control (the token, Update now, the advanced per-component
  // controls, the ramp) is REPLACED by the exact s4 line + a link to /destinations. Preview stays available
  // (it deploys nothing, so it is never blocked by a missing destination); wire it up and return early,
  // before any token field or apply handler exists at all.
  if (!destConfigured) {
    const previewCtx: PreviewContext = { engine, out, previewBtn, canManage, canApply: false, requested, showError };
    if (canManage) previewBtn.addEventListener("click", () => void preview(previewCtx));
    else refuseWithReason(previewBtn, capGateReason(UPDATE_MANAGE_CAP));
    actions.appendChild(previewBtn);
    body.appendChild(actions);
    body.appendChild(destinationGateNode());
    return body;
  }

  // The one-shot token field (Update now). It is a single-line secret-class input: autocomplete off (a
  // one-shot token, never a saved credential), and the hint names EXACTLY which Cloudflare token and that it
  // is used once and never stored. It sits collapsed-by-default behind the "Update now" intent so the calm
  // first read is the explainer + the two buttons, not a paste field demanding attention.
  const tokenField = field({
    id: "update-deploy-token",
    label: "One-shot deploy token",
    type: "password",
    placeholder: "Paste your Cloudflare API token",
    hint: "A Cloudflare API token with the \"Edit Cloudflare Workers\" permission. If your engine binds a Secrets Store secret as a backup source, add Secrets Store edit to the token as well: the template predates Secrets Store, and the upload-version step refuses without it. It is used once to deploy and verify, then discarded; it is never stored, logged, or sent to the vendor.",
    doc: { href: "https://docs.downpipes.io/operations/update-channel-applying", anchor: "what-the-operator-does" },
    autocomplete: "off",
    validate: (v) => (v.length >= 1 ? null : "Paste the deploy token to apply the update."),
  });
  // The token field is hidden until "Update now" is pressed (a two-step intent: review first, then commit a
  // token), so the resting state is calm. It is revealed in place, never in a modal.
  const tokenWrap = h("div", { hidden: true, style: "margin-top:var(--space-3)" }, tokenField.el);

  const updateBtn = h(
    "button",
    { "data-busy-label": "Deploying\u2026", "data-dp": "licence.button.update", class: "btn btn--primary btn--sm", type: "button" },
    "Update now",
  ) as HTMLButtonElement;

  // The compat-blocked note (honest disable reason), shown once when the release cannot be applied onto this
  // engine. The dry-run preview stays available to inspect the plan + the reason.
  if (compatBlocked && canManage) {
    body.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, compatBlocked));
  }

  // DV-112 acknowledgement gate: a release step marked blocking must be acknowledged before the LIVE apply
  // enables (its own field comment is that intent; previously the "Required" badge was visual only). When the
  // operator can apply and the release carries blocking steps, Update-now starts disabled and a per-step
  // checklist gates it: the button enables only once every blocking step is ticked. Preview is unaffected (it
  // changes nothing), and a release with no blocking step behaves exactly as before. The engine still deploys
  // only what it verifies; this is the console honouring the release author's blocking marker.
  const blockingSteps: RequiredStep[] = (Array.isArray(updates.requiredSteps) ? (updates.requiredSteps as RequiredStep[]) : []).filter((s) => s.blocking === true);
  // refreshApplyEnabled is the SINGLE writer of Update-now's enabled state. Every path that could re-enable
  // the button (the checkboxes here, preview()'s finally, updateNow()'s tail) routes through it, so none of
  // them can reopen the gate by blindly resetting `disabled = !canApply`: the button is enabled only when the
  // operator can apply, the apply is not already queued for a second owner, AND every blocking step is
  // acknowledged. `acked`/`queuedForSecondOwner` live at this scope so the module-level handlers can re-derive
  // the state through the ctx callbacks rather than each owning a private copy.
  const acked = new Set<number>();
  let queuedForSecondOwner = false;
  const refreshApplyEnabled = (): void => {
    // The REFUSED case returns early, and that early return is load-bearing rather than tidy. Update-now is
    // refused once, above, by refuseWithReason, which leaves it focusable with its reason as text. This
    // function is reachable while refused: Preview is wired for any canManage caller, and a compat-blocked
    // release gives exactly that state (canManage true, canApply false), so preview()'s finally would have
    // re-applied `disabled` to the refused button and taken it back out of the tab order mid-session.
    if (!canApply) return;
    updateBtn.disabled = queuedForSecondOwner || acked.size < blockingSteps.length;
  };
  if (canApply && blockingSteps.length > 0) {
    updateBtn.title = "Acknowledge each required step below before you can apply.";
    const ackBlock = h("div", { class: "stack-sm", role: "group", "aria-label": "Acknowledge the release's required steps", style: "margin-top:var(--space-3)" });
    ackBlock.appendChild(h("p", { class: "field__hint" }, "This release marks steps you must complete before applying. Acknowledge each to enable Update now:"));
    blockingSteps.forEach((step, i) => {
      const id = `update-ack-${i}`;
      const cb = h("input", { type: "checkbox", id }) as HTMLInputElement;
      cb.addEventListener("change", () => { if (cb.checked) acked.add(i); else acked.delete(i); refreshApplyEnabled(); });
      ackBlock.appendChild(h("label", { for: id, style: "display:flex;gap:var(--space-2);align-items:flex-start;cursor:pointer" }, cb, h("span", { style: "color:var(--text)" }, step.text)));
    });
    // Group-level doc link (the field audit's G2): the acknowledgement checkboxes are one gate, so the link
    // explaining why a blocking step must be ticked before Update now enables lives on the group, not a row.
    ackBlock.appendChild(
      h(
        "a",
        { class: "field__doc linklike", href: "https://docs.downpipes.io/operations/update-channel-applying#what-the-operator-does", target: "_blank", rel: "noreferrer noopener" },
        "About required release steps",
        svgIcon(ICON_EXTERNAL, { size: 13 }),
      ),
    );
    body.appendChild(ackBlock);
  }
  // Set the resting state now: disabled while any blocking step is unacknowledged, else per canApply. (showError
  // is defined ABOVE, before the destination-gate branch, which needs it too -- so it is not re-declared here.)
  refreshApplyEnabled();

  // The shared closures the two handlers drive, gathered once so preview()/updateNow() stay module-level.
  // markQueuedForSecondOwner + refreshApplyEnabled let updateNow()/preview() re-derive the button state
  // through the gate instead of overwriting it.
  const ctx: ApplyContext = { engine, out, reload, restoreFocus, previewBtn, updateBtn, tokenField, tokenWrap, canManage, canApply, requested, expectedConsoleVersion, showError, refreshApplyEnabled, markQueuedForSecondOwner: () => { queuedForSecondOwner = true; } };

  if (canManage) previewBtn.addEventListener("click", () => void preview(ctx));
  else refuseWithReason(previewBtn, capGateReason(UPDATE_MANAGE_CAP));
  if (canApply) updateBtn.addEventListener("click", () => void updateNow(ctx));
  // compatBlocked FIRST, deliberately: a caller who holds the capability and is looking at a release that
  // cannot be applied onto this engine must be told THAT, not told they lack a permission they hold.
  else refuseWithReason(updateBtn, compatBlocked ?? capGateReason(UPDATE_MANAGE_CAP));
  actions.appendChild(previewBtn);
  actions.appendChild(updateBtn);
  body.appendChild(actions);
  body.appendChild(tokenWrap);

  if (canApply) {
    // ADVANCED per-component controls (component-aware engines ONLY; componentAdvancedSection returns null
    // without a components map): apply one component alone, or roll one back. Collapsed, clearly secondary.
    const advanced = componentAdvancedSection(engine, updates, env, ownVersion);
    if (advanced) body.appendChild(advanced);
    // OPT-IN gradual ramp: an advanced, DEFAULT-OFF alternative to the atomic apply, collapsed below the
    // normal controls so it stays clearly secondary. Only offered when a live apply is offered (owner +
    // compatible). The ramp is engine-only by design (a static-assets swap has no traffic percentage).
    body.appendChild(rampSection(engine, out, reload, restoreFocus));
  }

  return body;
}
