// Control-plane recovery banner -- the console face of the engine's silence-killer. A SchedulerDO
// storage loss is total control-plane amnesia: backups silently stop and (without the engine latch) the
// first caller would silently re-bootstrap to Owner. The engine latches recovery-required (whoami resolves
// to viewer, never a silent Owner) and signs a no-custody config export to every destination bucket. This
// component makes that loud -- a standing danger banner across the app -- and offers the break-glass-gated
// reconcile: the operator pastes the signed export + its detached signature + the ADMIN_TOKEN (break-glass)
// and the engine rebuilds the control plane after verifying the signature + re-asserting no plaintext secret.
//
// House rules carried through:
//   - No-custody: the banner copy carries names/status/remediation only; the reconcile form holds the token
//     for the one request and never logs/stores it; the export is forwarded verbatim, never re-serialised.
//   - The engine is the enforcement point: this client pre-flight is friendly validation only; the engine
//     re-verifies the signature, the no-custody invariant, the break-glass token and the empty-plane / empty-role-table gate.
//   - Standing-state banner (feedback.banner danger), not a transient toast: the condition persists until a
//     reconcile clears the latch, so it must not auto-dismiss.

import type {
  ControlPlaneApplyStagedResult,
  ControlPlaneReconcileResult,
  ControlPlaneStagedSummary,
  ControlPlaneStatus,
} from "../lib/api/types/control-plane.ts";
import { recordRecoveryRefusal } from "../lib/client-diag/ring.ts";
import {
  looksLikeControlPlaneExport,
  parseReconcileInput,
  type ReconcileInput,
  type RecoveryBannerModel,
  recoveryBannerModel,
} from "../lib/control-plane-recovery.ts";
import { h } from "../lib/dom.ts";
import type { HybridRecipientPrivate } from "../lib/keydecap.ts";
import { withRefusalCode } from "../lib/recovery-refusal-codes.ts";
// Sealed-shape detection reuses the same module the estate-import modal uses (no second port of the shape
// gate). This file imports unsealControlPlaneExport for the sub-case where an estate's bucket holds only
// a `.sealed.json` and whose engine has no CONFIG_RECIPIENT_PRIVATE, so nothing can stage it and no plaintext
// pair was ever written. There, the browser holding the break-glass key is the only thing that can open the
// artefact, exactly as on the estate-import path.
import { looksLikeSealedControlPlaneExport, type SealedControlPlaneExport, unsealControlPlaneExport } from "../lib/sealed-export-unseal.ts";
import { wipeOnDisconnect } from "../screens/restore-flow/reassembly.ts";
import { type BreakGlassKeyPanel, renderBreakGlassKeyPanel } from "./break-glass-key-panel.ts";
import { banner } from "./feedback.ts";
import { type Field, field } from "./field.ts";
import { openModal } from "./modal.ts";
import { toast } from "./toast.ts";

// RecoveryBannerDeps is the (injected, testable) collaborators the banner needs. reconcile relays a validated
// input to the engine (wraps EngineClient.controlPlaneRestore); onReconciled lets the app refresh identity +
// re-poll status after a successful rebuild (the latch clears server-side and the operator re-authenticates
// as the restored role); notify surfaces the success confirmation (injected so a test asserts it without the
// real toast region).
export interface RecoveryBannerDeps {
  reconcile(input: ReconcileInput): Promise<ControlPlaneReconcileResult>;
  // applyStaged confirms an auto-heal-staged recovery with only the ADMIN_TOKEN -- see
  // openApplyStagedModal. Optional so an older wiring (or a test that never exercises the staged state) need
  // not supply it; recoveryDangerBanner falls back to the manual reconcile action when it is absent.
  applyStaged?: (adminToken: string) => Promise<ControlPlaneApplyStagedResult>;
  // restoreSealed relays a locally-unsealed recovery to POST /admin/control-plane/restore-sealed. The
  // browser opens the sealed artefact with the operator's break-glass key and sends the sealed wrapper, its
  // detached signature and the recovered export; the ENGINE verifies all three again against its own pinned
  // signer, so the local unseal is defence in depth and never the authority. Optional for the same reason
  // applyStaged is: an older wiring degrades to the explanatory refusal rather than to a dead button.
  restoreSealed?: (sealed: unknown, sealedSignature: string, exportArtefact: unknown, adminToken: string) => Promise<ControlPlaneReconcileResult>;
  // acknowledge (defect 23) clears the recovery latch and nothing else, over the operator's OWN session: no
  // token, no export, no signature. Optional for the same reason the two above are, and the banner says so
  // rather than rendering a dead button when it is absent.
  acknowledge?: () => Promise<unknown>;
  onReconciled?: (result: ControlPlaneReconcileResult) => void;
  onApplied?: (result: ControlPlaneApplyStagedResult) => void;
  onAcknowledged?: () => void;
  notify?: (msg: string) => void;
}

// RecoveryStatusRead is how the LAST recovery-status read went, carried separately from its result:
//   ok           the engine answered; the status is authoritative.
//   route-absent the engine does not serve the status route (an older build): render nothing, this is not
//                a fault and a standing notice would cry wolf on every poll.
//   failed       the read genuinely failed (5xx, network, timeout): the recovery state is UNKNOWN, which is
//                a different fact from "recovery is not required" and is stated as such.
export type RecoveryStatusRead = "ok" | "route-absent" | "failed";

// The unknown-state copy. Deliberately calm and non-alarming: it reports that a CHECK did not answer, and
// makes no claim at all about the control plane. Exported so the validator pins the exact strings.
export const RECOVERY_UNKNOWN_TITLE = "Recovery status could not be read";
export const RECOVERY_UNKNOWN_BODY =
  "The console could not read the engine's control-plane recovery status, so it cannot tell you whether recovery is required. This is a failed check, not a fault in your backups, and it is not an all-clear either. It usually clears on the next load; if it persists, quote it to support.";

// BANNER_HOST_ID is the singleton host the banner lives in. It is inserted ONCE, as the FIRST child of <body>,
// so the banner sits above the shell chrome (in normal document flow, no CSS position needed) and is never
// replaced by a screen navigation (which only swaps the main region).
//
// This used to be document.body.appendChild(host), which places the host
// LAST in document order -- after the whole shell (#app: the sticky header, the rail, the main region). The
// shell's own root is `min-height: 100vh` (tokens.css .shell), so on any ordinary viewport the "standing
// danger banner across the app" (this file's own header comment) rendered off the BOTTOM of the page, ~800px
// down on a stock 1280x720 view: present in the DOM, danger-toned, correctly wired, and invisible without
// scrolling past the entire Overview screen first. That is a real "estate that needs recovery looks healthy"
// failure mode distinct from the banner not rendering at all, and it survived because nothing that asserts on
// this host checks its position -- element.querySelector().count() and Playwright's isVisible() are both
// blind to being scrolled off-screen, so the DOM-level checks (and the ledger row that recorded them) never
// caught it. Fixed by insertBefore(host, body.firstChild): the host becomes the first thing in <body>, so
// normal document flow puts it above the shell on every load, no z-index/position/fixed-height layout change
// needed, and the shell's own min-height (not a hard height) means nothing below it clips.
const BANNER_HOST_ID = "cp-recovery-banner-host";

// ensureBannerHost returns (creating once) the singleton banner host, inserted as the first child of <body>.
function ensureBannerHost(): HTMLElement {
  const existing = document.getElementById(BANNER_HOST_ID);
  if (existing) return existing;
  const host = h("div", { id: BANNER_HOST_ID, class: "cp-recovery-host" });
  document.body.insertBefore(host, document.body.firstChild);
  return host;
}

// recoveryLatch holds the LAST CONFIRMED recovery-required state: the engine's status (its redaction-safe
// reason feeds the copy) and the reconcile collaborators the break-glass action is wired to. It is raised
// the moment a CONFIRMED read (read === "ok") reports recoveryRequired=true, and lowered ONLY by a CONFIRMED
// read that reports a healthy plane (recoveryRequired=false) -- which, post-reconcile, is exactly what the
// re-poll returns. An UNKNOWN read (a check that FAILED, or a route-absent older engine) is not
// authoritative and never lowers it: the console has already confirmed the scheduler is lost and backups
// have stopped, and a status poll that could not run does not un-confirm that.
//
// This latch closes a real gap: without it, updateRecoveryBanner cleared the host
// and re-derived the banner from THIS call's read alone, so a single later status read that failed, was
// route-absent, or raced against the raising one took a legitimately-shown danger banner back down and left
// the demoted operator on a clean-looking Overview -- a false all-clear over a wiped plane whose backups had
// stopped, the worst class of silence this banner exists to kill. The banner now stands until the engine
// itself, on a read that SUCCEEDED, reports the plane healthy again.
let recoveryLatch: { status: ControlPlaneStatus; deps: RecoveryBannerDeps } | null = null;

// _resetRecoveryLatch clears the module latch between validator cases (module state would otherwise leak
// from one case into the next in a single process). The app never calls it: in the browser a fresh boot
// re-initialises the module, so each load starts from a clean latch.
export function _resetRecoveryLatch(): void {
  recoveryLatch = null;
}

// updateRecoveryBanner is the single entry the app calls after each whoami/status resolve. A CONFIRMED read
// (read === "ok") is authoritative and (re)sets the standing latch below; an UNKNOWN read (failed /
// route-absent) never lowers a raised latch. Whenever the latch stands, the danger banner is re-painted from
// the LATCHED status (so it survives a host that was emptied or re-created) and wired to the LATCHED reconcile
// deps (so the break-glass action works even when the current read is the unavailable stub). Only a confirmed
// healthy read takes it down, so it never over-renders on a healthy plane.
export function updateRecoveryBanner(status: ControlPlaneStatus | null, deps: RecoveryBannerDeps, read: RecoveryStatusRead = "ok"): void {
  const host = ensureBannerHost();
  host.replaceChildren();

  // A CONFIRMED read raises the latch on recoveryRequired=true (capturing the status for the reason copy and
  // the reconcile deps for the break-glass action) and lowers it on a confirmed healthy plane. An UNKNOWN
  // read leaves the latch exactly as it stands.
  if (read === "ok") {
    recoveryLatch = status?.recoveryRequired === true ? { status, deps } : null;
  }

  // A standing recovery-required state always renders the danger banner. It is no longer re-derived from a
  // single (possibly failed, route-absent or racing) read, so it cannot be silenced by one.
  if (recoveryLatch) {
    host.appendChild(recoveryDangerBanner(recoveryBannerModel(recoveryLatch.status), recoveryLatch.deps));
    return;
  }

  // No confirmed recovery-required state. A read that genuinely FAILED still says so calmly (never an
  // all-clear on an unknown state); a route-absent older engine and a confirmed healthy plane show nothing.
  // "The engine says recovery is not required" and "we could not ask the engine" stay different facts.
  if (read === "failed") {
    host.appendChild(
      banner({
        tone: "info",
        message: h(
          "div",
          { class: "cp-recovery__msg" },
          h("strong", {}, RECOVERY_UNKNOWN_TITLE),
          h("div", { class: "cp-recovery__body" }, RECOVERY_UNKNOWN_BODY),
        ),
        dismissible: true,
      }),
    );
  }
}

// stagedSummarySentence states, in the operator's own vocabulary, what the auto-heal already did: the
// generation it recovered from and how many downpipes are running again. It never claims access is restored
// (that is exactly the ONE thing the confirm below still does).
function stagedSummarySentence(staged: ControlPlaneStagedSummary): string {
  return `Your backups have already resumed automatically from a signed export (config v${staged.version}, ${staged.downpipes} downpipe${staged.downpipes === 1 ? "" : "s"}): confirm with your break-glass token to restore operator access.`;
}

// recoveryDangerBanner builds the standing danger banner from the resolved model: the pinned title, the
// consequence-and-remedy body, the engine's redaction-safe reason when it sent one, and ONE break-glass
// action. Every value enters the DOM through h()'s textContent path, never innerHTML.
//
// the action is context-sensitive. When the auto-heal has already staged a recovery (model.staged !==
// null), the manual "paste a plaintext export + signature" reconcile form is not reachable for the artefact
// that produced it -- a sealed estate (the default posture) never has a plaintext-signed pair to paste, only
// the sealed one, and that pair simply does not exist while sealing is on. The right action is the
// break-glass CONFIRM (apply-staged), which needs only the ADMIN_TOKEN. deps.applyStaged is optional (a
// caller that never wires it, or an older build), so this degrades to the manual action rather than wiring a
// button to nothing.
function recoveryDangerBanner(model: RecoveryBannerModel, deps: RecoveryBannerDeps): HTMLElement {
  const offerConfirm = model.exit === "confirm" && model.staged !== null && deps.applyStaged !== undefined;
  const staged = model.staged;
  // The action follows model.exit, which follows the engine's own two emptiness facts, so the
  // console stops offering a route the engine must refuse. TWO EXITS OFFER NO BUTTON AT ALL and that is
  // deliberate: their bodies name the path that is open instead, and a button wired to a guard that cannot
  // pass is what this defect was. A banner with no action is legal (`banner` takes an optional action) and
  // says the true thing rather than a reachable-looking untrue one.
  const acknowledgeReachable = model.exit === "acknowledge" && deps.acknowledge !== undefined;
  return banner({
    tone: model.tone,
    message: h(
      "div",
      { class: "cp-recovery__msg" },
      h("strong", {}, model.title),
      h("div", { class: "cp-recovery__body" }, model.body),
      ...(model.reason ? [h("div", { class: "cp-recovery__reason" }, model.reason)] : []),
      ...(offerConfirm && staged ? [h("div", { class: "cp-recovery__reason" }, stagedSummarySentence(staged))] : []),
      // The degraded acknowledge: an older console bundle whose caller never wired deps.acknowledge would
      // otherwise render the recovered-state copy with no way out and no explanation of why.
      ...(model.exit === "acknowledge" && !acknowledgeReachable ? [h("div", { class: "cp-recovery__reason" }, ACKNOWLEDGE_UNWIRED)] : []),
    ),
    ...(acknowledgeReachable
      ? { action: { label: ACKNOWLEDGE_LABEL, onClick: () => openAcknowledgeModal(deps, model.reason) } }
      : offerConfirm && staged
        ? { action: { label: "Confirm and restore access", onClick: () => openApplyStagedModal(deps, staged) } }
        : model.exit === "reconcile"
          ? { action: { label: "Recover the control plane", onClick: () => openReconcileModal(deps) } }
          : {}),
  });
}

// ACKNOWLEDGE_LABEL names the ACT, not the outcome: it clears a flag, it does not recover anything, and an
// operator mid-incident must not read it as a second restore button. Exported so the validator pins it.
export const ACKNOWLEDGE_LABEL = "Acknowledge recovery";
export const ACKNOWLEDGE_UNWIRED =
  "This console build cannot clear the flag itself. Update the console, or ask support to run the acknowledge for you; your backups are running either way.";

// openAcknowledgeModal is the acknowledge confirmation, and it is deliberately the THINNEST modal in this
// file: no export, no signature, no signer.pub, no break-glass token, nothing to paste and nothing to wipe on
// dismiss, because the call carries no credential at all. What it does carry is the engine's own reason line
// repeated at the point of decision, since clearing the latch clears the signal, and an operator who has not
// actually put right what the reason describes should fix that first. That re-statement is the only reason
// this is a modal rather than a bare button.
export function openAcknowledgeModal(deps: RecoveryBannerDeps, reason: string | null): void {
  const formError = h("p", { class: "field__error", role: "alert", hidden: true });
  const body = h(
    "div",
    { class: "cp-recovery-form" },
    h(
      "p",
      { class: "cp-recovery-form__lead" },
      "This clears the recovery flag and nothing else. It imports nothing, restores no operator roles and needs no break-glass token; it records who cleared it in the audit log. Your configuration is already back, which is why this is the action offered.",
    ),
    ...(reason ? [h("p", { class: "cp-recovery-form__lead" }, `The engine raised it for this reason, and clearing the flag clears the signal: ${reason}`)] : []),
    formError,
  );
  openModal({
    title: ACKNOWLEDGE_LABEL,
    body,
    actions: [
      { label: "Cancel", variant: "secondary", onClick: () => {} },
      {
        label: "Acknowledge",
        variant: "danger",
        busyLabel: "Acknowledging\u2026",
        onClick: () => _testRunAcknowledge(deps, (msg) => showFormError(formError, msg)),
      },
    ],
  });
}

// _testRunAcknowledge is the PURE submit pipeline (no DOM): relay, then notify + onAcknowledged + close, or
// surface the engine refusal and KEEP THE MODAL OPEN. There is nothing to validate first, which is the point
// of the route. Exported with the _test prefix so the validator drives it without a DOM or a network.
export async function _testRunAcknowledge(deps: RecoveryBannerDeps, setFormError: (msg: string) => void): Promise<boolean> {
  setFormError("");
  if (!deps.acknowledge) {
    setFormError(ACKNOWLEDGE_UNWIRED);
    return false;
  }
  try {
    await deps.acknowledge();
    const msg = "Recovery acknowledged: the flag is cleared and the notice will come down on the next status read. Nothing else changed.";
    (deps.notify ?? ((m: string) => toast({ message: m, tone: "success", durationMs: 0 })))(msg);
    deps.onAcknowledged?.();
    return true;
  } catch (err) {
    setFormError(err instanceof Error ? err.message : String(err));
    return false;
  }
}

// openReconcileModal opens the break-glass reconcile form: the signed export JSON, its detached signature,
// and the break-glass token. The primary action validates the input (parseReconcileInput),
// then relays it to the engine; a validation error or an engine refusal is shown inline and KEEPS the modal
// open (returns false), so the operator can correct and retry without re-entering everything.
export function openReconcileModal(deps: RecoveryBannerDeps): void {
  const exportField = field({
    id: "cp-reconcile-export",
    label: "Signed control-plane export (.json)",
    kind: "textarea",
    required: true,
    hint: "Paste the …/_RECOVERY/CONTROL-PLANE/<version>-<time>.json file from your destination bucket.",
    doc: { href: "https://docs.downpipes.io/operations/recovering-downpipes-itself", anchor: "case-1-the-scheduler-was-wiped-the-account-survived" },
  });
  const sigField = field({
    id: "cp-reconcile-sig",
    label: "Detached signature (.json.sig)",
    kind: "textarea",
    required: true,
    hint: "Paste the matching …json.sig file. The engine verifies it against its pinned signer before any rebuild.",
    doc: { href: "https://docs.downpipes.io/operations/recovering-downpipes-itself", anchor: "case-1-the-scheduler-was-wiped-the-account-survived" },
  });
  const tokenField = field({
    id: "cp-reconcile-token",
    label: "Break-glass token (ADMIN_TOKEN)",
    type: "password",
    required: true,
    autocomplete: "off",
    hint: "Sent once to authorise the reconcile; never stored.",
    doc: { href: "https://docs.downpipes.io/operations/recovering-downpipes-itself", anchor: "case-1-the-scheduler-was-wiped-the-account-survived" },
  });
  // the sealed sub-panel. Hidden until the paste is recognisably a sealed artefact, on the same
  // calm-density rule estate-import-modal.ts follows: an operator recovering from a plaintext export must not
  // be shown a key upload and a signer.pub box they will never use. Both appear together, because a sealed
  // artefact needs both and neither is any use alone.
  const pubField = field({
    id: "cp-reconcile-signerpub",
    label: "Recovery kit signer.pub",
    kind: "textarea",
    required: false,
    hint: "Paste the downpipe-signer-public-v1 line from your recovery kit. This browser verifies the sealed artefact against it BEFORE decrypting anything.",
    doc: { href: "https://docs.downpipes.io/operations/recovering-downpipes-itself", anchor: "case-1-the-scheduler-was-wiped-the-account-survived" },
  });
  pubField.el.hidden = true;
  const keyPanel = renderBreakGlassKeyPanel({
    intro: "This is a SEALED export: opening it needs your break-glass key. It is read in this browser and never uploaded; only the configuration it unseals, and the sealed artefact itself for the engine to re-verify, are sent.",
  });

  const formError = h("p", { class: "field__error", role: "alert", hidden: true });

  // refreshSealedPanel toggles both sealed-only controls from the CURRENT paste alone: a cheap local read of
  // the shape, never an unseal (that happens on Reconcile, once a signer.pub is there to verify against).
  // A paste that stops being sealed wipes the key material as well as hiding it, for the reason
  // break-glass-key-panel.ts's header gives: hiding a panel is not the same as forgetting what it holds.
  function refreshSealedPanel(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(exportField.value());
    } catch {
      pubField.el.hidden = true;
      keyPanel.wipeAll();
      keyPanel.setVisible(false);
      return;
    }
    const isSealed = !looksLikeControlPlaneExport(parsed) && looksLikeSealedControlPlaneExport(parsed);
    if (!isSealed) keyPanel.wipeAll();
    pubField.el.hidden = !isSealed;
    keyPanel.setVisible(isSealed);
  }
  exportField.el.addEventListener("input", refreshSealedPanel);

  const body = h(
    "div",
    { class: "cp-recovery-form" },
    h("p", { class: "cp-recovery-form__lead" }, "Rebuild the scheduler control plane from a signed export you pulled out-of-band from your destination bucket. Your break-glass token authorises this; the engine verifies the signature and refuses any export carrying a plaintext secret."),
    exportField.el,
    sigField.el,
    pubField.el,
    keyPanel.el,
    tokenField.el,
    formError,
  );

  // Navigating away is an exit too, and it is the one the overlay teardown cannot run a callback for. Same
  // reasoning as estate-import-modal.ts: this only zeroes buffers, so there is no navigation for it to fight.
  wipeOnDisconnect(body, keyPanel.wipeAll);
  openModal({
    title: "Recover the control plane",
    body,
    onDismiss: () => keyPanel.wipeAll(),
    actions: [
      { label: "Cancel", variant: "secondary", onClick: () => keyPanel.wipeAll() },
      {
        label: "Reconcile",
        variant: "danger",
        busyLabel: "Reconciling…",
        onClick: () =>
          runReconcileFromFields(
            { exportField, sigField, tokenField, pubField, keyPanel },
            deps,
            (msg) => showFormError(formError, msg),
          ),
      },
    ],
  });
}

// runSealedReconcile is the sealed sibling of the pipeline above, kept a separate function because the
// two share no step after the shape read: this one collects a THIRD credential, opens the artefact locally,
// and posts a different route with a different body.
//
// WHY THE ENGINE STILL VERIFIES EVERYTHING. The browser's unseal is a local pre-check whose only privilege is
// holding the key; it proves nothing to the engine, which re-verifies the wrapper's signature, re-checks the
// shape and re-asserts the no-custody invariant on the recovered plaintext before touching the DO. So a
// tampered browser can waste its own time and nothing else.
//
// The refusals are recorded under "cp-restore-sealed", not "cp-restore" and not "estate-import-sealed": this
// is its own flow, and filing its refusals against a neighbour is how a support pack comes to describe a
// recovery nobody attempted.
async function runSealedReconcile(
  sealed: SealedControlPlaneExport,
  raw: { exportText: string; signature: string; token: string; signerPub?: string; identity?: HybridRecipientPrivate | null },
  deps: RecoveryBannerDeps,
  setFormError: (msg: string) => void,
): Promise<boolean> {
  const restoreSealed = deps.restoreSealed;
  if (restoreSealed === undefined) return false;
  const signature = raw.signature.trim();
  const token = raw.token.trim();
  const signerPub = (raw.signerPub ?? "").trim();
  // Each empty-field refusal carries its own code, the same ones the plaintext form and the estate import use
  // for the same omission, so the operator reads one vocabulary across all three recovery surfaces.
  if (signature === "") {
    recordRecoveryRefusal("cp-restore-sealed", "DP-R04");
    setFormError(withRefusalCode("Paste the detached signature for the sealed artefact (the matching ….sealed.json.sig file from your destination bucket).", "DP-R04"));
    return false;
  }
  if (signerPub === "") {
    recordRecoveryRefusal("cp-restore-sealed", "DP-R05");
    setFormError(withRefusalCode("Paste your recovery kit's signer.pub so this browser can verify the sealed artefact against your own key before it decrypts anything.", "DP-R05"));
    return false;
  }
  if (token === "") {
    recordRecoveryRefusal("cp-restore-sealed", "DP-R06");
    setFormError(withRefusalCode("Enter your break-glass token (ADMIN_TOKEN). It authorises the rebuild and is sent once, never stored.", "DP-R06"));
    return false;
  }
  const identity = raw.identity ?? null;
  if (identity === null) {
    recordRecoveryRefusal("cp-restore-sealed", "DP-R03");
    setFormError(withRefusalCode("Supply your break-glass identity.key, or reassemble a split key, above. A sealed export can only be opened with it, and it is read in this browser and never uploaded.", "DP-R03"));
    return false;
  }
  const unsealed = await unsealControlPlaneExport(sealed, signature, signerPub, identity, "cp-restore-sealed");
  if (!unsealed.ok) {
    setFormError(unsealed.error);
    return false;
  }
  try {
    const result = await restoreSealed(unsealed.sealed, unsealed.sealedSignature, unsealed.exportArtefact, token);
    const msg = `Control plane recovered from a sealed export: ${result.downpipes} downpipe(s), ${result.destinations} destination(s), ${result.roles} role(s). Re-enter any secrets marked for re-establishment, then sign in again.`;
    (deps.notify ?? ((m: string) => toast({ message: m, tone: "success", durationMs: 0 })))(msg);
    deps.onReconciled?.(result);
    return true;
  } catch (err) {
    setFormError(err instanceof Error ? err.message : String(err));
    return false;
  }
}

// sealedPastedIntoReconcileMessage names the TRUE cause of a sealed paste into the manual reconcile
// form: not a shape problem, a format one this form cannot open, plus the honest next step -- check for the
// auto-heal's own confirm action first (it needs no pasted export at all), since that is what the vast
// majority of estates on the default sealed posture will find once the next scheduled check runs.
//
// THE TAIL USED TO SAY "wait for the next scheduled check", AND ON THIS SUB-CASE THAT IS FALSE. If no confirm
// action is offered, auto-heal has already tried and refused with "sealed-no-op-key": the latest export is
// sealed and this engine holds no operational key to open it. That refusal is TERMINAL, not transient.
// `engine/src/cron/control-plane-pass.ts:598` says so in its own words, "re-run the key ceremony, or recover
// offline", so no later run of the same check can succeed while the key is missing. Telling an operator to
// wait, on the one screen they reach mid-disaster, spends their time on something that will never happen and
// is the "refusal without a path forward" shape exists to catch. The message now names the cause and
// the real remedies instead.
function sealedPastedIntoReconcileMessage(): string {
  return withRefusalCode(
    "That is a SEALED control-plane export (.sealed.json), which this form cannot open: it needs a plaintext export and a signature over that exact plaintext, and neither exists while sealing is on (the account's default posture). Check above for a \"Confirm and restore access\" action first: your backups have very likely already resumed automatically from this artefact, and confirming needs only your break-glass token, not this export. If no such action is offered, this engine holds no key that can open the sealed export, and waiting will not change that: the automatic recovery has already tried and stopped for that reason. Recovering from here needs the break-glass key ceremony re-run for this estate, or an offline recovery from the same artefact. Contact support with this code and they will tell you which applies.",
    "DP-R03",
  );
}

// openApplyStagedModal confirms an auto-heal-staged recovery: unlike openReconcileModal, it asks for
// ONLY the break-glass token, never the export. WHY NO BROWSER UNSEAL HERE, unlike the estate-import modal's
// fix: this is Case 1 (the scheduler was wiped, the account -- and its env/secret bindings -- survives),
// so THIS SAME ENGINE still holds env.CONFIG_RECIPIENT_PRIVATE, the key the sealed export was ALSO addressed
// to (control-plane-pass.ts loadRecipients(BREAK_GLASS_PUBLIC, CONFIG_RECIPIENT_PUBLIC, "config")), and its
// cron auto-heal has already used it to unseal + re-sign + stage the export server-side
// (unsealAndResignForAutoHeal) before this banner action is ever offered (model.staged is set only once that
// has happened). Asking the operator to also paste their SEPARATE offline break-glass identity.key here would
// duplicate a decrypt the engine can already do with a key it never lost, for no security benefit. Compare
// estate-import: Case 2 there is a FRESH engine that was never a recipient of the old export at all, so
// only the operator's own offline key can open it -- a genuinely different custody shape, not an oversight.
export function openApplyStagedModal(deps: RecoveryBannerDeps, staged: ControlPlaneStagedSummary): void {
  const tokenField = field({
    id: "cp-confirm-token",
    label: "Break-glass token (ADMIN_TOKEN)",
    type: "password",
    required: true,
    autocomplete: "off",
    hint: "Sent once to authorise the confirm; never stored.",
    doc: { href: "https://docs.downpipes.io/operations/recovering-downpipes-itself", anchor: "case-1-the-scheduler-was-wiped-the-account-survived" },
  });
  const formError = h("p", { class: "field__error", role: "alert", hidden: true });

  const body = h(
    "div",
    { class: "cp-recovery-form" },
    h(
      "p",
      { class: "cp-recovery-form__lead" },
      `Your backups have already resumed automatically (config v${staged.version}, ${staged.downpipes} downpipe${staged.downpipes === 1 ? "" : "s"}) from a signed export this engine verified and opened with its own recovery key. Confirming restores operator access (roles, sign-in) with your break-glass token; it does not need the export itself.`,
    ),
    tokenField.el,
    formError,
  );

  openModal({
    title: "Confirm and restore access",
    body,
    actions: [
      { label: "Cancel", variant: "secondary", onClick: () => {} },
      {
        label: "Confirm",
        variant: "danger",
        busyLabel: "Confirming…",
        onClick: () => runApplyStagedFromField(tokenField, deps, (msg) => showFormError(formError, msg)),
      },
    ],
  });
}

// showFormError surfaces a form-level error line (the per-field fields handle their own; this is the engine
// refusal / cross-field message). Toggling hidden keeps the alert region announcing only when populated.
function showFormError(slot: HTMLElement, message: string): void {
  slot.textContent = message;
  slot.hidden = message === "";
}

// runApplyStagedFromField reads the token field and relays to the engine. Returns false to KEEP the modal
// open on any failure (so the operator corrects and retries), true (close) on a successful confirm. Extracted
// so the validate->submit pipeline is unit-testable via _testRunApplyStaged, matching runReconcileFromFields.
async function runApplyStagedFromField(
  tokenField: Field,
  deps: RecoveryBannerDeps,
  setFormError: (msg: string) => void,
): Promise<boolean> {
  return _testRunApplyStaged(tokenField.value(), deps, setFormError);
}

// _testRunApplyStaged is the PURE validate->submit pipeline (no DOM) for the auto-heal confirm: reject an
// empty token before any network call (mirrors parseReconcileInput's DP-R06 empty-token message exactly, so
// the two flows read consistently), else relay to deps.applyStaged; on success notify + onApplied + close, on
// an engine refusal surface the message + keep open. Exported with the _test prefix so the validator drives
// the full pipeline without a real DOM or network. No secret is logged; the token rides only into
// deps.applyStaged.
export async function _testRunApplyStaged(
  tokenRaw: string,
  deps: RecoveryBannerDeps,
  setFormError: (msg: string) => void,
): Promise<boolean> {
  setFormError("");
  const token = tokenRaw.trim();
  if (token === "") {
    recordRecoveryRefusal("cp-restore", "DP-R06");
    setFormError(withRefusalCode("Enter your break-glass token (ADMIN_TOKEN) to authorise the confirm.", "DP-R06"));
    return false;
  }
  if (!deps.applyStaged) {
    // Structural guard, not an operator-reachable state: recoveryDangerBanner only offers this modal when
    // deps.applyStaged is defined. Kept honest rather than throwing, in case a future caller opens this modal
    // directly without checking.
    setFormError("This console build cannot confirm a staged recovery yet; use \"Recover the control plane\" instead, or update the console.");
    return false;
  }
  try {
    const result = await deps.applyStaged(token);
    const msg = `Control plane recovered: backups already resumed automatically, ${result.roles} role(s) restored. Re-enter any secrets marked for re-establishment, then sign in again.`;
    (deps.notify ?? ((m: string) => toast({ message: m, tone: "success", durationMs: 0 })))(msg);
    deps.onApplied?.(result);
    return true;
  } catch (err) {
    setFormError(err instanceof Error ? err.message : String(err));
    return false;
  }
}

// runReconcileFromFields reads the form, validates, and relays to the engine. Returns false to KEEP the modal
// open on any failure (so the operator corrects in place), and true (close) on a successful rebuild. Extracted
// from the action handler so the validate→submit pipeline is unit-testable via _testRunReconcile.
async function runReconcileFromFields(
  fields: { exportField: Field; sigField: Field; tokenField: Field; pubField?: Field; keyPanel?: BreakGlassKeyPanel },
  deps: RecoveryBannerDeps,
  setFormError: (msg: string) => void,
): Promise<boolean> {
  return _testRunReconcile(
    {
      exportText: fields.exportField.value(),
      signature: fields.sigField.value(),
      token: fields.tokenField.value(),
      signerPub: fields.pubField?.value() ?? "",
      identity: fields.keyPanel?.identity() ?? null,
    },
    deps,
    setFormError,
  );
}

// _testRunReconcile is the PURE validate→submit pipeline (no DOM): parse the raw form values, on a validation
// error surface it + keep open, else relay to the engine; on success notify + onReconciled + close, on an
// engine refusal surface the message + keep open. Exported with the _test prefix so the validator drives the
// full pipeline (validation paths, the ADMIN_TOKEN relay, the success callback, the refusal-keeps-open path)
// without a real DOM or network. No secret is logged; the token rides only into deps.reconcile.
export async function _testRunReconcile(
  raw: { exportText: string; signature: string; token: string; signerPub?: string; identity?: HybridRecipientPrivate | null },
  deps: RecoveryBannerDeps,
  setFormError: (msg: string) => void,
): Promise<boolean> {
  setFormError("");
  // a SEALED export pasted here used to fall straight into parseReconcileInput's DP-R03, which names a
  // SHAPE problem ("does not look like a control-plane export") when the real cause is format: the pasted
  // JSON IS a recognisable artefact, a sealed one, and this manual form cannot open it -- it needs a
  // plaintext export plus a signature over that exact plaintext, and while sealing is on (the account's
  // default posture) NEITHER is ever written: engine/src/cron/control-plane-pass.ts's
  // buildControlPlaneArtefactToWrite signs the plaintext OR seals it for one export generation, never both.
  // Detected the SAME way estate-import-modal.ts already tells the two shapes apart (both looksLike checks,
  // sealed only when plaintext does not match first), BEFORE parseReconcileInput's generic gate runs, so the
  // operator reads the true cause instead of a shape refusal that sends them chasing a signature file that
  // was never written.
  const trimmedExport = raw.exportText.trim();
  if (trimmedExport !== "") {
    let parsedForShape: unknown;
    try {
      parsedForShape = JSON.parse(trimmedExport);
    } catch {
      parsedForShape = undefined;
    }
    if (parsedForShape !== undefined && !looksLikeControlPlaneExport(parsedForShape) && looksLikeSealedControlPlaneExport(parsedForShape)) {
      // a sealed paste is no longer a dead end. When the caller wired restoreSealed, the browser opens
      // the artefact with the operator's own break-glass key and relays the recovered export to the engine,
      // which verifies the wrapper, the signature and the export again against its own pinned signer. Without
      // that wiring the old explanatory refusal stands, which is a degradation rather than a broken button.
      if (deps.restoreSealed === undefined) {
        recordRecoveryRefusal("cp-restore", "DP-R03");
        setFormError(sealedPastedIntoReconcileMessage());
        return false;
      }
      return runSealedReconcile(parsedForShape as SealedControlPlaneExport, raw, deps, setFormError);
    }
  }
  const parsed = parseReconcileInput(raw);
  if (!parsed.ok) {
    setFormError(parsed.error);
    return false;
  }
  try {
    const result = await deps.reconcile(parsed.value);
    const msg = `Control plane recovered: ${result.downpipes} downpipe(s), ${result.destinations} destination(s), ${result.roles} role(s). Re-enter any secrets marked for re-establishment, then sign in again.`;
    (deps.notify ?? ((m: string) => toast({ message: m, tone: "success", durationMs: 0 })))(msg);
    deps.onReconciled?.(result);
    return true;
  } catch (err) {
    setFormError(err instanceof Error ? err.message : String(err));
    return false;
  }
}
