// In-console break-glass restore: the offline-key-only posture's IN-PLATFORM restore path.
//
// On a break-glass-only estate the engine holds no operational key, so it cannot open a run to restore it on
// its own. This panel is the no-CLI replacement: the operator supplies their break-glass PRIVATE in this
// browser (by uploading identity.key, or by reassembling an M-of-N Shamir quorum here), the browser fetches
// the chosen run's NON-SECRET master capsule (POST /admin/restore/capsule), recovers THAT run's 32-byte
// per-run master locally (keydecap.ts openCapsule, exactly as attended verification does), and previews the
// restore by sending ONLY that master back on the x-downpipes-restore-master transport HEADER. The engine
// then opens the run from the master and returns the dry-run plan; the break-glass refusal is lifted for that
// one call because a valid master was supplied.
//
// CUSTODY (the load-bearing part). The break-glass PRIVATE never leaves this tab: it is used only for the
// local openCapsule decap and is NEVER a field on any request (not the capsule fetch, not the restore, not an
// error path, not telemetry). Only the recovered 32-byte MASTER crosses the wire, and only on the header
// (client-downpipes.ts restore()), never in the JSON body the engine hashes / audits / persists. Both the
// private and the master live in THIS render's own closures and are nulled on teardown / navigation away (see
// teardown below and the direct unit test test/validate-break-glass-restore.ts). A wrong key fails the local
// decap and is surfaced as a plain "this key does not match this archive", never a raw crypto error.
//
// SCOPE. This panel does the single-actor part end to end: supply key -> recover master -> DRY-RUN preview
// with the master. Applying over live data additionally needs a second authorised identity's approval bound
// to the plan hash (maker != checker, enforced server-side); that dual-control apply is the standard restore
// flow's job and is signposted here, not faked.
//
// House rules: Australian English, no em dashes, no rule-of-three, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { canCap, capGateReason, collapsedSection } from "../common.ts";
import { capabilityPhrase } from "../capability-copy.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { blockError, inlineOutcome } from "../../components/error-view.ts";
import { badge } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { setBtnBusy } from "../../components/custody-step-helpers.ts";
import { ICON_LOCK, ICON_KEYS, ICON_RESTORE, ICON_CHEVRON_RIGHT } from "../../lib/icons.ts";
import { openCapsule, type HybridRecipientPrivate } from "../../lib/keydecap.ts";
import { b64urlEncode } from "../../bytes.ts";
import { groupNumber, titleCase } from "../../lib/format.ts";
import { restorePlanHash, type CapsuleResult, type EngineClient, type RestorePlan, type RestoreRequest, type RestoreResult } from "../../api.ts";
import { readIdentityFile } from "./attend.ts";
import { type ReassemblyCard, renderReassemblyCard } from "./reassembly.ts";
import { openRunPicker } from "./run-picker.ts";
// renderConfirm is the SAME dual-control confirm+apply block the standard restore flow uses
// (restore-flow/plan.ts). Reusing it here (rather than a second apply implementation) is what makes this
// panel's apply path share the same capability gate + dual-control reservation with every other apply in the
// product, with no second code path to drift out of sync. crossZoneNeedsConfirm and LARGE_RESTORE_WRITES
// mirror the exact same friction-calibration inputs plan.ts computes for the standard flow's own dry-run.
import { renderConfirm, stopConfirmGate } from "./confirm.ts";
import { crossZoneNeedsConfirm } from "./plan.ts";
import { LARGE_RESTORE_WRITES } from "./shared.ts";

// BreakGlassPanel is the mounted handle: the panel element, an explicit teardown that nulls BOTH sensitive
// closures, and a test-only inspection seam so the teardown-wipe unit test can assert the wipe directly.
export interface BreakGlassPanel {
  el: HTMLElement;
  // teardown best-effort zeros the recovered master, best-effort zeros the parsed private's key bytes, and
  // NULLS both closure references. Idempotent; safe to call more than once.
  teardown(): void;
  // peekSensitiveForTest returns the CURRENT sensitive closure references so the unit test can assert
  // teardown nulled the private AND zeroed-then-nulled the master. It is test-only (never called by
  // production code); returning the master reference is what lets the test verify it was zeroed in place.
  peekSensitiveForTest(): { hasPrivate: boolean; master: Uint8Array | null };
}

// keyHandlingNote is the standing honesty block for this panel: the private is read/recovered here and never
// sent; only the single-run master crosses, and only to open the run for the preview.
function keyHandlingNote(): HTMLElement {
  return h(
    "p",
    { class: "field__hint measure", style: "display:flex;gap:var(--space-2);align-items:flex-start" },
    h("span", { style: "flex:none;margin-top:1px;color:var(--trust)" }, svgIcon(ICON_LOCK, { size: 14 })),
    h(
      "span",
      "Your break-glass key is read in this browser and never uploaded. To preview a run, only that one run's recovered key is sent to your own engine to open it, held for the request and forgotten. We never receive your break-glass key.",
    ),
  );
}

// keyDocLink is the group-level external doc link for the raw identity.key file input (a raw control cannot
// ride a field()'s doc option; the attend runner's keyDocLink() sets the precedent). It links to the
// attended-verification page's "How your key is handled" section, which states the identical key-handling
// guarantee this panel relies on (the key is read in the browser and never sent, and only a per-run key
// reaches the engine). The href is a string literal so the doc-link gate resolves the anchor.
function keyDocLink(): HTMLElement {
  return h(
    "a",
    { class: "field__doc linklike", href: "https://docs.downpipes.io/recovery/attended-verification#how-your-key-is-handled", target: "_blank", rel: "noreferrer noopener" },
    "How your key is handled",
    svgIcon(ICON_CHEVRON_RIGHT, { size: 13 }),
  );
}

// renderBreakGlassRestore builds the panel. engine is the connected client; prefillRun is an optional run id
// deep-linked in (else the operator chooses one with the run picker). It returns the panel handle so the
// screen wrapper can mount it and wire teardown, and the unit test can drive + inspect it.
export function renderBreakGlassRestore(engine: EngineClient, prefillRun?: string): BreakGlassPanel {
  const root = h("div", { class: "stack", style: "display:grid;gap:var(--space-4);max-width:48rem" });

  // ---- sensitive closure state (the whole point of the custody design). privateKey is the parsed break-
  // glass private; master is the run's recovered 32-byte per-run master. We hold the PARSED private (rather
  // than the raw identity.key text) so its 96 key bytes can be best-effort ZEROED on teardown, which is
  // strictly better than a bare string null; the immutable-string caveat still applies to the identity.key
  // TEXT those bytes were parsed from (held transiently by the FileReader / the reassembly decrypt output),
  // which cannot be wiped, exactly as reassembly.ts's zero() notes. Neither is EVER put on a request. ------
  let privateKey: HybridRecipientPrivate | null = null;
  let privateSource: "file" | "reassembly" | null = null;
  let master: Uint8Array | null = null;
  let runId: string | null = prefillRun && prefillRun !== "" ? prefillRun : null;
  // scopeInclude narrows a re-preview to specific
  // record names after a partial apply failure. null/empty means the whole run, matching every preview run
  // before this existed. Reset whenever a fresh run or key invalidates the current scope.
  let scopeInclude: string[] | null = null;

  const wipeMaster = (): void => {
    if (master) master.fill(0); // zero the recovered per-run master in place before dropping it
    master = null;
  };
  const wipePrivate = (): void => {
    if (privateKey) {
      // Best-effort zero the parsed key bytes (both are views over the same 96-byte decode, so this wipes it
      // whole). Best-effort only: the identity.key TEXT they were parsed from is an immutable JS string that
      // cannot be wiped (reassembly.ts / recover-key.ts:54-60 state the same caveat).
      privateKey.x25519Scalar.fill(0);
      privateKey.mlkemSeed.fill(0);
    }
    privateKey = null;
    privateSource = null;
  };
  // reassemblyCard holds the split-key card this panel mounts further down (the `renderReassemblyCard` call
  // below), so teardown can reach it. A mutable holder rather than a direct reference to that `const`,
  // because the capability gate above returns the panel BEFORE the card is ever constructed, and a teardown
  // naming the const directly would throw on that path instead of wiping.
  let reassemblyCard: ReassemblyCard | null = null;
  // resetKeyStatus puts the panel's key line back to its "nothing here" default. A mutable holder for the
  // same reason reassemblyCard is one: the capability gate above returns BEFORE keyStatus exists, so naming
  // it directly from teardown would throw on that path instead of resetting.
  //
  // WHY IT IS NEEDED AT ALL. Reconstructing a split key from a quorum, then editing the share list, correctly
  // drops the private on the staleness rule, but the status line would otherwise still say "Split key
  // reassembled in this browser. Nothing was uploaded." with no key held. An operator mid-incident reads that
  // as custody state, and it would be the opposite of the truth, so this panel resets its own line on the
  // same event that invalidates the key.
  let resetKeyStatus: (() => void) | null = null;
  // confirmSection holds the confirm+apply block this panel mounts from renderConfirm, for the same reason
  // reassemblyCard and resetKeyStatus are held: it does not exist until a preview succeeds, and it is
  // replaced whole on every re-preview.
  //
  // WHY IT MUST BE STOPPED RATHER THAN JUST DROPPED. That block runs a dual-control approval gate with its
  // own timers (confirm.ts's startApprovalGate), and this panel dismisses it by REPLACING planHost's
  // children, which does not detach `root` from the document, so the disconnect observer confirm.ts also
  // installs never fires for this caller. Dropping the reference left an armed lapse timer, up to the
  // approval's whole remaining lifetime, holding the detached block. This is also the panel a customer
  // reaches mid-incident, so it is the one most likely to be opened, previewed and left.
  let confirmSection: HTMLElement | null = null;
  const stopConfirmGateHere = (): void => {
    stopConfirmGate(confirmSection);
    confirmSection = null;
  };
  const teardown = (): void => {
    wipeMaster();
    wipePrivate();
    stopConfirmGateHere();
    // The card independently holds the raw Shamir shares, the envelope's ciphertext/iv and, once quorum is
    // met, the reconstructed break-glass private. wipeMaster()/wipePrivate() never touched any of it, so a
    // teardown that stopped there left the secret REBUILDABLE: the material the reconstruct runs on was
    // still loaded and the control still ran. Wiping the two derived copies while leaving the inputs that
    // produce them is not a teardown. Best-effort-idempotent and safe when nothing was ever loaded.
    reassemblyCard?.teardown();
    resetKeyStatus?.();
  };

  root.appendChild(h("h2", { style: "margin:0;font-size:var(--text-lg)" }, "Break-glass restore"));
  root.appendChild(
    h(
      "p",
      { class: "field__hint measure", style: "margin:0" },
      "In the offline-key-only posture the engine holds no operational key, so it cannot open a run on its own. Supply your break-glass key here to recover a run's key in your browser and preview its restore. Only that one run's recovered key is sent to your engine; your break-glass key never leaves this browser.",
    ),
  );
  root.appendChild(keyHandlingNote());

  // Gate mirror: the FIRST engine call this panel makes is POST /admin/restore/capsule, gated on
  // restore.verify (the read-safe viewer floor). Mirror exactly that capability here (canCap), the SAME gate
  // the reassembly screen and proof.ts use, so the console gate matches the engine both directions.
  if (!canCap("restore.verify")) {
    root.appendChild(
      inlineOutcome({
        heading: `${titleCase(capabilityPhrase("restore.verify"))} required`,
        reason: capGateReason("restore.verify"),
        reassurance: `Break-glass restore recovers a run's key in your browser and asks the engine to open it, so it gates on the same ${capabilityPhrase("restore.verify")} the engine enforces on the capsule route. It writes nothing on its own.`,
      }),
    );
    return { el: root, teardown, peekSensitiveForTest: () => ({ hasPrivate: privateKey !== null, master }) };
  }

  const planHost = h("div", { role: "status", "aria-live": "polite" });

  // ---- 1. the run to restore -----------------------------------------------------------------------------
  const runValue = h("span", { class: "mono" }, runId ?? "none chosen yet");
  const runStatus = h("p", { class: "field__hint", style: "margin:0" }, "Choose the run you want to restore.");
  const chooseRunBtn = h(
    "button",
    { "data-dp": "restore-flow.button.choose-run", class: "btn btn--secondary btn--sm", type: "button" },
    runId ? "Change run" : "Choose a run",
  ) as HTMLButtonElement;
  chooseRunBtn.addEventListener("click", () => {
    // In-place onPick so the operator's already-supplied key is NOT discarded by a navigation/re-render.
    openRunPicker(engine, (chosen) => {
      runId = chosen;
      scopeInclude = null; // a new run invalidates any record-name scope from a prior retry-subset
      runValue.textContent = chosen;
      chooseRunBtn.textContent = "Change run";
      stopConfirmGateHere(); // the plan being dropped may carry a live approval gate
      planHost.replaceChildren(); // a new run invalidates any shown plan
      wipeMaster(); // and any master recovered for the previous run
      updatePreviewEnabled();
    });
  });
  const runCard = h(
    "section",
    { class: "card", style: "display:grid;gap:var(--space-2)" },
    h("h3", { class: "card__title" }, "Run to restore"),
    h("p", { style: "margin:0;display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap" }, h("span", "Run:"), runValue, chooseRunBtn),
    runStatus,
  );
  root.appendChild(runCard);

  // ---- 2. supply the break-glass key ---------------------------------------------------------------------
  const keyStatus = h("p", { class: "field__hint", role: "status", "aria-live": "polite", style: "margin:0" }, "No key supplied yet.");
  resetKeyStatus = (): void => {
    keyStatus.textContent = "No key supplied yet.";
  };

  // setPrivate accepts a freshly parsed private from EITHER supply path, zeroing any prior private + master
  // first (a new key invalidates a master recovered from the old one).
  const setPrivate = (id: HybridRecipientPrivate, source: "file" | "reassembly", statusEl: HTMLElement): void => {
    wipePrivate();
    wipeMaster();
    privateKey = id;
    privateSource = source;
    keyStatus.replaceChildren(statusEl);
    stopConfirmGateHere(); // as above: a new key drops the plan, and with it any live approval gate
    planHost.replaceChildren();
    updatePreviewEnabled();
  };
  const clearPrivate = (): void => {
    wipePrivate();
    wipeMaster();
    updatePreviewEnabled();
  };

  // 2a. identity.key file (reuses attend.ts readIdentityFile: FileReader + parseIdentityFile, read locally,
  // never uploaded). The parsed private is held only in the privateKey closure above.
  const fileInput = h("input", { id: "bg-identity", type: "file", accept: ".key,text/plain", "aria-label": "Select your identity.key file" }) as HTMLInputElement;
  const keyErr = h("p", { class: "field__error", role: "alert", hidden: true });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    keyErr.hidden = true;
    void readIdentityFile(file)
      .then((id) => {
        setPrivate(id, "file", h("span", { style: "display:inline-flex;align-items:center;gap:var(--space-2)" }, badge("ok", "Key read in this browser", { dot: true }), document.createTextNode("It was not uploaded.")));
      })
      .catch((e: unknown) => {
        clearPrivate();
        keyErr.textContent = e instanceof Error ? `${e.message}. No key left this device.` : "That file could not be read.";
        keyErr.hidden = false;
        keyStatus.textContent = "No key supplied yet.";
      });
  });

  const keyCard = h(
    "section",
    { class: "card", style: "display:grid;gap:var(--space-3)" },
    h("h3", { class: "card__title" }, "Your break-glass key"),
    h(
      "div",
      { class: "field" },
      h("label", { class: "field__label", for: "bg-identity" }, "Upload identity.key"),
      fileInput,
      h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, "Select the identity.key you saved offline. It is read here and never uploaded."),
      keyDocLink(),
    ),
    keyErr,
    keyStatus,
  );

  // 2b. reassemble a split key (the shared reassembly card, in no-download mode: the recovered identity.key
  // text is parsed to a private for the decap, never offered as a file). onInvalidated drops a
  // reassembly-sourced private when its inputs change, so a stale key can never be used for a preview.
  const reassembly = renderReassemblyCard({
    showDownload: false,
    onRecovered: (recovered) => {
      // The card hands back the PARSED key, so the recovered identity.key text never reaches this closure
      // and there is no second unwipeable copy of it here.
      if (recovered === null) {
        keyErr.hidden = true;
        keyStatus.textContent = "The reassembled file is not a standard identity.key, so it cannot be used to open a run.";
        clearPrivate();
        return;
      }
      keyErr.hidden = true;
      setPrivate(recovered, "reassembly", h("span", { style: "display:inline-flex;align-items:center;gap:var(--space-2)" }, badge("ok", "Split key reassembled in this browser", { dot: true }), document.createTextNode("Nothing was uploaded.")));
    },
    onInvalidated: () => {
      // The reassembly inputs changed: if the current private came from reassembly, it is now stale.
      if (privateSource === "reassembly") {
        clearPrivate();
        resetKeyStatus?.();
      }
    },
  });
  // Hand the card to teardown (declared above the capability gate's early return, so it is reachable here
  // and null on the path where this line never runs).
  reassemblyCard = reassembly;
  keyCard.appendChild(collapsedSection("Reassemble a split (M-of-N) key instead", reassembly.el));
  root.appendChild(keyCard);

  // ---- 3. preview the restore ----------------------------------------------------------------------------
  const previewBtn = h(
    "button",
    { "data-dp": "restore-flow.button.preview", class: "btn btn--primary", type: "button", disabled: true },
    svgIcon(ICON_RESTORE, { size: 15 }),
    "Preview the restore",
  ) as HTMLButtonElement;

  function updatePreviewEnabled(): void {
    const ready = runId !== null && privateKey !== null;
    previewBtn.disabled = !ready;
    previewBtn.title = ready
      ? ""
      : runId === null && privateKey === null
        ? "Choose a run and load an identity.key first."
        : runId === null
          ? "Choose a run first."
          : "Load an identity.key (or reassemble a split key) first.";
  }

  const runPreview = async (): Promise<void> => {
    const rid = runId;
    const priv = privateKey;
    if (!rid || !priv) return;
    wipeMaster(); // derive a fresh master for THIS preview; drop any prior one first
    setBtnBusy(previewBtn, true, "Recovering this run's key");
    // Stopped HERE, beside the clear it belongs to, rather than beside the mount at the foot of this
    // function: there are six early returns between the two, and each of them replaces planHost with an
    // error surface, so a stop placed at the mount would be skipped on exactly the paths that drop a
    // previously mounted gate and never build a new one.
    stopConfirmGateHere();
    planHost.replaceChildren();

    // (i) fetch the run's NON-SECRET master capsule (gated restore.verify server-side).
    let capsule: CapsuleResult;
    try {
      capsule = await engine.restoreCapsule(rid);
    } catch (err) {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: the preview did not run, and the button must not be left reading
        // "Recovering this run's key" over a plan host this handler emptied on the way in.
        setBtnBusy(previewBtn, false, "Preview the restore");
        return void goSignedOut();
      }
      setBtnBusy(previewBtn, false, "Preview the restore");
      planHost.replaceChildren(blockError(err, () => void runPreview(), { origin: location.origin }));
      return;
    }
    if (!capsule.ok || !capsule.masterCapsule || capsule.keyCommitment === undefined) {
      setBtnBusy(previewBtn, false, "Preview the restore");
      planHost.replaceChildren(
        inlineOutcome({
          heading: "This run's key capsule could not be read",
          reason: capsule.reason ?? "The engine could not read this run's key capsule.",
          reassurance: "This is about the run, not your key. Try another run, or check the run sealed successfully. Nothing was sent from your key.",
        }),
      );
      return;
    }

    // (ii) recover THIS run's 32-byte master locally with the break-glass private. A wrong key (no matching
    // wrap, or a failed decap) throws here and is surfaced as a plain, non-cryptographic message. The private
    // is used ONLY for this local call; it is never sent.
    let derived: Uint8Array;
    try {
      derived = await openCapsule(capsule.masterCapsule, priv, capsule.keyCommitment);
    } catch {
      setBtnBusy(previewBtn, false, "Preview the restore");
      planHost.replaceChildren(
        inlineOutcome({
          heading: "This key does not match this archive",
          reason: "The break-glass key you supplied did not recover this run's key. Check you selected the identity.key (or the shares) for THIS estate.",
          reassurance: "Nothing was sent. Your key stays in this browser; try a different key or run.",
        }),
      );
      return;
    }
    master = derived;
    // masterB64 is captured HERE, once, as a plain string: it survives a LATER wipeMaster() (choosing a
    // new run or key while the confirm/apply block below is mid-poll for a distinct approver, which can run
    // for real wall-clock time) because a JS string is immutable and wipeMaster() only zeros the Uint8Array
    // `master` derives from. This is the SAME immutable-string caveat already documented for the private
    // (reassembly.ts's zero()), stated here rather than silently relied on. Re-reading master below the dual-
    // control wait would risk a null/zeroed value if the operator changed run or key in another part of this
    // same panel while a distinct approver was still signing.
    const masterB64 = b64urlEncode(master);

    // req is reused for the preview call below, the plan-hash the confirm block's dual-control gate binds to,
    // and (via applyReq = {...req, confirm:true} inside confirm.ts) the eventual apply -- exactly the same
    // single-request-object discipline plan.ts's standard flow already follows, which is what keeps the plan
    // hash the operator is shown identical to the one the engine recomputes at apply time. scopeInclude
    // narrows to specific record names after a partial apply failure; absent/empty means
    // the whole run, matching every preview before this existed.
    const req: RestoreRequest = { runId: rid, ...(scopeInclude && scopeInclude.length > 0 ? { include: scopeInclude } : {}) };

    // (iii) preview the restore, sending ONLY the recovered master, and ONLY on the transport header. The
    // request body carries just the runId (a dry-run: confirm omitted, so nothing is written).
    let res: RestorePlan | RestoreResult;
    try {
      // CHANGE UNRECORDED: req omits confirm, so this is the read-only dry-run leg of the multiplexed POST
      // /restore. The engine writes nothing and records no config mutation, so demanding a change number here
      // would interrupt the operator for a read. The apply that follows this preview collects one.
      res = await engine.restore(req, undefined, { restoreMasterB64: masterB64 });
    } catch (err) {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: the same reasoning as the capsule read above.
        setBtnBusy(previewBtn, false, "Preview the restore");
        return void goSignedOut();
      }
      setBtnBusy(previewBtn, false, "Preview the restore");
      planHost.replaceChildren(blockError(err, () => void runPreview(), { origin: location.origin }));
      return;
    }
    setBtnBusy(previewBtn, false, "Preview the restore");
    if (res.mode !== "dry-run") {
      planHost.replaceChildren(inlineOutcome({ heading: "Unexpected response", reason: "The engine did not return a dry-run plan for this preview." }));
      return;
    }
    if (!res.ok) {
      planHost.replaceChildren(
        inlineOutcome({
          heading: "The engine could not plan this restore",
          reason: res.reason ?? "The engine opened the run but could not build a restore plan.",
          reassurance: "Nothing was written. Recheck the run and your key, then preview again.",
        }),
      );
      return;
    }
    planHost.replaceChildren(renderPlan(res));
    toast({ message: "Restore preview built. Nothing was written." });

    // (iv) The real apply path. This reuses the STANDARD flow's own confirm+apply block (confirm.ts),
    // the identical capability gate + dual-control reservation every other restore apply goes through,
    // with the recovered master threaded onto the apply call via opts (see confirm.ts's header comment). This
    // is what "raise it from the standard restore flow" used to gesture at without a working path behind it;
    // now the path is here, on the SAME screen the master was recovered on, rather than sent to a standard
    // flow that has nowhere to accept a break-glass key at all. paintStepper is a no-op: this panel has no
    // step indicator of its own. reenter re-runs THIS preview scoped to a partial apply failure's failed
    // record names, reusing the already-supplied key rather than discarding it.
    const confirmFlags = {
      highImpact: res.isLatest === false,
      isLarge: res.plannedWrites >= LARGE_RESTORE_WRITES,
      isRedirect: false, // this panel only ever restores to the run's original bindings, never a redirect
      isNonLatest: res.isLatest === false,
      isCrossAccount: (res.crossAccountWarnings?.length ?? 0) > 0,
      isCrossZone: crossZoneNeedsConfirm(res),
    };
    let confirmPlanHash: string | null = null;
    try {
      confirmPlanHash = await restorePlanHash(req);
    } catch {
      // confirm.ts and plan.ts carry the same catch: the hash is a cue the dual-control gate binds to;
      // a null hash degrades the confirm block to "awaiting approval" honestly rather than a misleading armed
      // Apply. Never fatal to the preview, which has already rendered above.
      confirmPlanHash = null;
    }
    confirmSection = await renderConfirm(
      engine,
      res,
      req,
      confirmPlanHash,
      confirmFlags,
      () => {},
      (prefill) => {
        scopeInclude = prefill.include && prefill.include.length > 0 ? prefill.include : null;
        stopConfirmGateHere();
        planHost.replaceChildren();
        void runPreview();
      },
      { restoreMasterB64: masterB64 },
    );
    planHost.appendChild(confirmSection);
  };
  previewBtn.addEventListener("click", () => void runPreview());

  root.appendChild(h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap" }, previewBtn));
  root.appendChild(planHost);
  updatePreviewEnabled();

  return { el: root, teardown, peekSensitiveForTest: () => ({ hasPrivate: privateKey !== null, master }) };
}

// breakGlassEntryNote is a small, calm-density secondary line (not its own card) pointing at this panel, for
// the /restore runless landing (workspace.ts), next to the attended-verification entry card and the split-key
// reassembly note. Deliberately minimal: this is a niche, break-glass-only path, so it earns a line, not a
// band. Navigates inline, matching recoverKeyDiscoveryNote's shape.
export function breakGlassEntryNote(): HTMLElement {
  const link = h(
    "button",
    { "data-dp": "restore-flow.button.navigate-restore-break-glass#1", class: "btn btn--ghost btn--sm", type: "button", on: { click: () => navigate("/restore/break-glass") } },
    svgIcon(ICON_RESTORE, { size: 13 }),
    "Restore with your break-glass key",
  );
  return h(
    "p",
    { class: "field__hint measure", style: "margin:0;display:flex;align-items:center;gap:var(--space-2)" },
    "On an offline-key-only estate?",
    link,
  );
}

// renderPlan renders the dry-run plan summary: the honest counts + a short sample of the records an apply
// WOULD write, plus the standing note that applying over live data goes through dual control. All values are
// redaction-safe (counts + source names, never a value); names render via createTextNode only (h()).
function renderPlan(plan: RestorePlan): HTMLElement {
  const wrap = h("section", { class: "card", style: "display:grid;gap:var(--space-3);margin-top:var(--space-3)" });
  const head = h("div", { class: "card__header" });
  head.appendChild(h("h3", { class: "card__title" }, "Restore preview (dry-run)"));
  head.appendChild(badge("ok", "opened with your key"));
  wrap.appendChild(head);
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint measure", style: "margin:0" },
      `${groupNumber(plan.recordsVerified)} ${plan.recordsVerified === 1 ? "record" : "records"} verified. An apply would write ${groupNumber(plan.plannedWrites)} ${plan.plannedWrites === 1 ? "record" : "records"} (about ${groupNumber(plan.bytes)} bytes). This is the latest run for its downpipe: ${plan.isLatest ? "yes" : "no"}.`,
    ),
  );
  const sample = plan.sample.slice(0, 8);
  if (sample.length > 0) {
    const ul = h("ul", { style: "list-style:none;padding:0;margin:0;display:grid;gap:var(--space-1)" });
    for (const s of sample) {
      ul.appendChild(
        h(
          "li",
          { style: "display:flex;gap:var(--space-2);align-items:center" },
          svgIcon(ICON_KEYS, { size: 13 }),
          h("span", { class: "mono" }, s.name),
          h("span", { class: "field__hint" }, `(${s.sourceType})`),
        ),
      );
    }
    wrap.appendChild(h("div", h("p", { class: "field__hint", style: "margin:0 0 var(--space-1)" }, "A sample of what would be restored:"), ul));
  }
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint measure", style: "margin:0" },
      // This used to send the operator to "the standard restore flow" for the apply -- a path that does
      // not accept a break-glass key at all (confirm.ts had no parameter to carry one). The real apply gate
      // (the identical dual-control confirm + Apply the standard flow uses) now renders directly below, on
      // this same screen, so this line states only what THIS preview did, never a claim about where to go next.
      "This preview wrote nothing. Applying a restore over live data needs a second authorised person's approval bound to this plan (dual control), shown below.",
    ),
  );
  return wrap;
}
