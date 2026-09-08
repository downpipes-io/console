// In-console break-glass retention prune: the offline-key-only posture's no-CLI replacement for
// `downpipe prune`.
//
// On a break-glass-only estate the engine holds no in-account read-back key, so its cron retention pass
// honestly defers a downpipe's ENFORCED prune every tick (cron/retention-pass.ts, engine side): it cannot
// decrypt the shard manifests to compute the retained/orphan segment sets. This panel is that pass's no-CLI
// replacement: the operator supplies their break-glass key in THIS browser (identity.key, or a reassembled
// M-of-N quorum), the browser fetches the downpipe's current candidate runs' NON-SECRET master capsules
// (POST /admin/retention-prune/candidate), recovers each run's 32-byte master locally (keydecap.ts
// openCapsule), and hands back ONLY those per-run masters, batched, so the engine can plan (and, only when
// this downpipe's OWN Retention "Enforce" toggle is already on, apply) the SAME prune the cron would have
// run with a held key. It performs no new authority: enforce is read from the stored config, never from a
// client claim, so this panel can only ever fulfil a deletion the estate's own owner already armed.
//
// CUSTODY (the load-bearing part, identical to break-glass.ts). The break-glass PRIVATE never leaves this
// tab: it is used only for the local openCapsule decap and is NEVER a field on any request. Only the
// recovered 32-byte per-run MASTERS cross the wire, in the JSON body of the apply call (never a header
// trick is needed here: retention-prune/apply is not a restore-shaped route with a hashed audit body, so
// the masters are simply request fields the engine reads once and never persists). Both the private and
// every recovered master live in THIS render's own closures and are nulled/zeroed on teardown.
//
// SCOPE. This panel does the whole single-actor arc: pick a downpipe -> supply key -> load candidates ->
// recover masters -> PREVIEW the plan -> an explicit separate APPLY. Nothing is deleted by the preview
// step; only the apply step can delete, and only when the downpipe's own stored Enforce is on.
//
// House rules: Australian English, no em dashes, no rule-of-three, precise claims.

import type { DownpipeState, EngineClient, PruneApplyResult, PruneCandidateResult } from "../../api.ts";
import { b64urlEncode } from "../../bytes.ts";
import { setBtnBusy } from "../../components/custody-step-helpers.ts";
import { blockError, inlineOutcome } from "../../components/error-view.ts";
import { field, validateForm } from "../../components/field.ts";
import { badge } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { verdictSurface } from "../../components/verdict.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { classifyError, isUnauthorised } from "../../lib/errors.ts";
import { groupNumber } from "../../lib/format.ts";
import { ICON_CHEVRON_RIGHT, ICON_LOCK, ICON_TRASH } from "../../lib/icons.ts";
import { type HybridRecipientPrivate, openCapsule } from "../../lib/keydecap.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { capabilityPhrase } from "../capability-copy.ts";
import { canCap, capGateReason, collapsedSection, pendingEngineNote } from "../common.ts";
import { readIdentityFile } from "./attend.ts";
import { pruneApprovalsEntryNote } from "./prune-approvals.ts";
import { type ReassemblyCard, renderReassemblyCard } from "./reassembly.ts";

// BreakGlassPrunePanel is the mounted handle, mirroring BreakGlassPanel (break-glass.ts): the panel
// element, an explicit teardown that wipes both sensitive closures, and a test-only inspection seam.
export interface BreakGlassPrunePanel {
  el: HTMLElement;
  teardown(): void;
  peekSensitiveForTest(): { hasPrivate: boolean; masterCount: number };
}

function keyDocLink(): HTMLElement {
  return h(
    "a",
    { class: "field__doc linklike", href: "https://docs.downpipes.io/recovery/attended-verification#how-your-key-is-handled", target: "_blank", rel: "noreferrer noopener" },
    "How your key is handled",
    svgIcon(ICON_CHEVRON_RIGHT, { size: 13 }),
  );
}

function pruneDocLink(): HTMLElement {
  return h(
    "a",
    { class: "field__doc linklike", href: "https://docs.downpipes.io/backing-up/retention-and-pruning", target: "_blank", rel: "noreferrer noopener" },
    "Retention and pruning",
    svgIcon(ICON_CHEVRON_RIGHT, { size: 13 }),
  );
}

// outcomeCard renders one apply/preview response honestly, per its closed `mode`. Counts only; never a
// run name or a value.
function outcomeCard(res: PruneApplyResult): HTMLElement {
  const rows = [
    `${groupNumber(res.retainedRuns)} run(s) retained`,
    `${groupNumber(res.supersededRuns)} run(s) ${res.mode === "preview" ? "would be" : "marked"} superseded`,
    `${groupNumber(res.runTreeObjects)} run-tree object(s) ${res.mode === "preview" ? "would be" : ""} deleted`,
    `${groupNumber(res.orphanSegs)} orphaned segment(s) ${res.mode === "preview" ? "would be" : ""} deleted`,
  ];
  if (res.mode === "preview") {
    return inlineOutcome({
      heading: "Preview: nothing was deleted",
      reason: rows.join(". "),
      reassurance: "This is a preview only. Nothing was written or deleted. Use Apply to run this pass for real.",
    });
  }
  if (res.mode === "abstained") {
    return inlineOutcome({
      heading: "Deferred: a retained run could not be opened",
      reason: `A run this downpipe still needs to keep could not be opened with the keys supplied, so the whole pass deferred rather than risk deleting something it still needs. Nothing was written or deleted. ${rows.join(". ")}.`,
      reassurance: "Recover the missing run's key (or check you supplied the right key/quorum for this estate) and try again.",
    });
  }
  if (res.mode === "no-op") {
    return inlineOutcome({
      heading: "Nothing to prune this pass",
      reason: "Every run is already within the retention window, or already pruned. Nothing was written or deleted.",
    });
  }
  if (res.mode === "partial") {
    return inlineOutcome({
      heading: "Applied, but stopped partway",
      reason: `The prune committed the supersede but a delete failed partway through: ${rows.join(". ")}.${res.wormBlocked ? " The destination's write-once policy refused at least one delete; that object will never drain." : ""}`,
      reassurance: "A later pass retries the remainder; this is safe (a superseded run stays retained until its objects are actually gone).",
    });
  }
  const card = h("section", { class: "card", style: "display:grid;gap:var(--space-2)" });
  const head = h("div", { class: "card__header" });
  head.appendChild(h("h3", { class: "card__title" }, "Applied"));
  head.appendChild(badge("ok", "prune applied"));
  card.appendChild(head);
  card.appendChild(h("p", { class: "field__hint measure", style: "margin:0" }, `${rows.join(". ")}.`));
  return card;
}

// incompleteBatchCard renders the "incomplete-batch" mode: the batch covered less than every candidate
// run BEFORE any plan was even computed, so nothing was assessed and nothing was deleted. Run ids only
// (never a value or a record), matching outcomeCard's own disclosure rule; the ids are already visible
// elsewhere in the console's own run list, so naming them here just tells the operator which key to try.
function incompleteBatchCard(res: PruneApplyResult): HTMLElement {
  const ids = res.missingRunIds ?? [];
  const shown = ids.slice(0, 8);
  return inlineOutcome({
    heading: "Some runs could not be opened",
    reason: `${groupNumber(ids.length)} run(s) in this downpipe's current retained/superseded split could not be opened with the key(s) supplied, so nothing was planned and nothing was deleted.${shown.length > 0 ? ` Runs: ${shown.join(", ")}${ids.length > shown.length ? `, and ${groupNumber(ids.length - shown.length)} more` : ""}.` : ""}`,
    reassurance: "Recover the missing run(s)' key (check you supplied the right key, or the right M-of-N quorum, for this estate), then Recover keys and preview again.",
  });
}

// notApprovedPanel renders the "not-approved" mode: this downpipe's Enforce toggle is on and a real
// delete was intended, but no distinct approver has signed off this exact plan yet. This is the panel
// This is exactly the second review this panel exists to provide: without it, an operator on exactly the estate posture this row exists
// to serve hit an unexplained 403 with no portal path forward -- the no-customer-CLI violation the row
// was raised to remove, moved one layer down. The wording of the refusal line is deliberately the same
// as the standard restore flow's own dual-control banner (restore-flow/confirm.ts renderArmed), because
// it is the same rule (a distinct second identity must approve before an irreversible action proceeds).
function notApprovedPanel(engine: EngineClient, downpipeId: string, res: PruneApplyResult): HTMLElement {
  const wrap = h("div", { style: "display:grid;gap:var(--space-3)" });
  wrap.appendChild(
    inlineOutcome({
      heading: "A second authorised identity needs to approve this plan",
      reason: `This downpipe's Enforce toggle is on, so this Apply would actually delete: ${groupNumber(res.retainedRuns)} run(s) retained, ${groupNumber(res.supersededRuns)} run(s) superseded. Nothing was written or deleted. This apply needs a second authorised identity to approve this exact plan first; the approver must differ from you.`,
      reassurance: "Raise the request below; a different authorised operator approves it from the pending prune approvals inbox. Once approved, click Recover keys and preview again, then Apply.",
    }),
  );

  const panel = h("section", { class: "card card--inset" });
  panel.appendChild(h("h3", { class: "card__title" }, "Request approval"));
  if (res.planHash) {
    panel.appendChild(h("p", { class: "field__hint mono", style: "margin:0", title: res.planHash }, `Plan ${res.planHash.slice(0, 28)}…`));
  }
  const reasonField = field({ id: "bgp-prune-reason", label: "Reason for this prune", required: true, kind: "textarea", placeholder: "Clearing superseded runs past the retention window", hint: "Recorded in the audit trail. Not a secret.", doc: { href: "https://docs.downpipes.io/backing-up/retention-and-pruning", anchor: "the-three-knobs" } });
  panel.appendChild(reasonField.el);

  const requestBtn = h(
    "button",
    { "data-dp": "restore-flow.button.request#1", class: "btn btn--secondary", type: "button", style: "margin-top:var(--space-3)" },
    "Request approval",
  ) as HTMLButtonElement;
  const outcomeHost = h("div");
  // async/await + try/finally, the same idiom confirm.ts's renderRequestPanel uses for the identical
  // request-a-dual-control-approval interaction: a finally that ALWAYS releases requestBtn covers every
  // exit path (including the isUnauthorised early return) at once, rather than needing the release
  // repeated in each branch.
  requestBtn.addEventListener("click", () => {
    if (!validateForm([reasonField])) return;
    requestBtn.dataset.busy = "true";
    requestBtn.disabled = true;
    void (async () => {
      try {
        await engine.retentionPruneRequest({ downpipeId, reason: reasonField.value() });
        outcomeHost.replaceChildren(
          verdictSurface({
            tone: "info",
            title: "Awaiting approval",
            body: `Request raised. It is in the pending prune approvals inbox; an approver other than you must approve it. Once a distinct approver signs this exact plan, click Recover keys and preview again, then Apply.`,
            action: { label: "Open the pending prune approvals inbox", onClick: () => navigate("/restore/prune-approvals") },
          }),
        );
        toast({ message: "Prune approval requested" });
      } catch (err) {
        if (isUnauthorised(err)) return goSignedOut();
        const kind = classifyError(err, { origin: location.origin });
        if (kind.kind === "server" && (kind.status === 404 || kind.status === 501)) {
          outcomeHost.replaceChildren(
            pendingEngineNote({
              what: "The approval request could not be recorded: this engine build does not support prune approvals yet.",
              dependsOn: "an engine update",
              interim: `The engine returned: ${err instanceof Error ? err.message : String(err)}. The request route (POST /admin/retention-prune/request) is not on this engine build; update the engine to enable prune approvals.`,
            }),
          );
        } else {
          outcomeHost.replaceChildren(blockError(err, () => requestBtn.click(), { origin: location.origin }));
        }
      } finally {
        requestBtn.dataset.busy = "false";
        requestBtn.disabled = false;
      }
    })();
  });
  panel.appendChild(requestBtn);
  panel.appendChild(outcomeHost);
  wrap.appendChild(panel);
  wrap.appendChild(pruneApprovalsEntryNote());
  return wrap;
}

// renderOutcome dispatches an apply/preview response to the right renderer by its closed `mode`:
// "incomplete-batch" and "not-approved" refused before a plan existed (or before dual control was
// checked) and need their OWN telling, distinct from outcomeCard's five plan-bearing modes.
function renderOutcome(engine: EngineClient, downpipeId: string, res: PruneApplyResult): HTMLElement {
  if (res.mode === "incomplete-batch") return incompleteBatchCard(res);
  if (res.mode === "not-approved") return notApprovedPanel(engine, downpipeId, res);
  return outcomeCard(res);
}

// renderBreakGlassPrune builds the panel. engine is the connected client; prefillDownpipeId optionally
// deep-links a downpipe in (from the Retention section of that downpipe's editor); otherwise the operator
// picks one from the downpipes that carry a retention policy.
export function renderBreakGlassPrune(engine: EngineClient, prefillDownpipeId?: string): BreakGlassPrunePanel {
  const root = h("div", { class: "stack", style: "display:grid;gap:var(--space-4);max-width:48rem" });

  // ---- sensitive closure state (the same shape break-glass.ts uses): the parsed break-glass private, and
  // the per-run masters recovered from it, keyed by runId. Neither is EVER put on a request except the
  // masters, batched, on the apply call itself. --------------------------------------------------------
  let privateKey: HybridRecipientPrivate | null = null;
  let privateSource: "file" | "reassembly" | null = null;
  const masters = new Map<string, Uint8Array>();
  let downpipeId: string | null = prefillDownpipeId && prefillDownpipeId !== "" ? prefillDownpipeId : null;
  let candidates: PruneCandidateResult | null = null;

  const wipeMasters = (): void => {
    for (const m of masters.values()) m.fill(0);
    masters.clear();
  };
  const wipePrivate = (): void => {
    if (privateKey) {
      privateKey.x25519Scalar.fill(0);
      privateKey.mlkemSeed.fill(0);
    }
    privateKey = null;
    privateSource = null;
  };
  // reassemblyCard holds the split-key card this panel mounts further down, so teardown can reach it. A
  // mutable holder rather than a direct reference to that `const`, because the capability gate below returns
  // the panel BEFORE the card is ever constructed, and a teardown naming the const directly would throw on
  // that path instead of wiping.
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
  const teardown = (): void => {
    wipeMasters();
    wipePrivate();
    // The card independently holds the raw Shamir shares, the envelope's ciphertext/iv and, once quorum is
    // met, the reconstructed break-glass private. Wiping the masters and the parsed private while leaving
    // the material that REBUILDS them is not a teardown, and this panel's teardown stopped exactly there.
    // Best-effort-idempotent and safe when nothing was ever loaded into the card.
    reassemblyCard?.teardown();
    resetKeyStatus?.();
  };

  root.appendChild(h("h2", { style: "margin:0;font-size:var(--text-lg)" }, "Prune with your key"));
  root.appendChild(
    h(
      "p",
      { class: "field__hint measure", style: "margin:0" },
      "In the offline-key-only posture the engine holds no operational key, so it cannot open a run to compute what a retention prune would delete. Supply your break-glass key here to run this downpipe's prune pass from your browser instead of a terminal.",
    ),
  );
  root.appendChild(
    h(
      "p",
      { class: "field__hint measure", style: "display:flex;gap:var(--space-2);align-items:flex-start" },
      h("span", { style: "flex:none;margin-top:1px;color:var(--trust)" }, svgIcon(ICON_LOCK, { size: 14 })),
      h(
        "span",
        "Your break-glass key is read in this browser and never uploaded. Only the recovered per-run keys for the runs you choose to prune are sent to your own engine, held for the request and forgotten. We never receive your break-glass key.",
      ),
    ),
  );

  // Gate mirror: the panel's whole point is the destructive APPLY call (restore.apply, restore-operator/
  // approver/owner; every holder also holds drill.run, so this can never sit below the attend session's
  // floor). It reuses restore.apply -- the same capability the standard restore flow's apply gates on --
  // because deleting archived runs is at least as consequential as overwriting live data with one, and the
  // console mirrors the engine's actual gate rather than the weaker read-only capsule floor.
  if (!canCap("restore.apply")) {
    root.appendChild(
      inlineOutcome({
        heading: "Permission to apply a retention prune required",
        reason: capGateReason("restore.apply"),
        reassurance: `Pruning with your key needs the same ${capabilityPhrase("restore.apply")} the standard restore flow's apply step needs, because it deletes archived backup data the way an approved restore apply also writes it. It writes nothing on its own until you choose Apply.`,
      }),
    );
    return { el: root, teardown, peekSensitiveForTest: () => ({ hasPrivate: privateKey !== null, masterCount: masters.size }) };
  }

  const planHost = h("div", { role: "status", "aria-live": "polite" });
  const applyBtn = h(
    "button",
    { "data-dp": "restore-flow.button.apply#2", class: "btn btn--danger btn--sm", type: "button", disabled: true, title: "Recover keys and preview first." },
    svgIcon(ICON_TRASH, { size: 14 }),
    "Apply now",
  ) as HTMLButtonElement;

  // APPLY KEEPS `disabled`, DELIBERATELY, and it is the site that most wanted the migration and least
  // could take it. Every other gated control in this console moved to aria-disabled so it stays in the
  // tab order and its reason is reachable, but aria-disabled is an announcement, not an enforcement,
  // and this button's handler is attached UNCONDITIONALLY at the bottom of this function because the
  // button is re-armed later in the same session (setApplyEnabled below). Dropping `disabled` here
  // would leave a live handler on a control that deletes archived backup data, reachable by Enter
  // before the keys have been recovered and the plan previewed. That is not an accessibility fix; it
  // is a data-loss route wearing one.
  //
  // THE REASON IS CARRIED IN TEXT, NOT ONLY IN THE TITLE, and that is a correction to what this comment
  // used to claim. It said the reason was not lost to a non-mouse reader because planHost below is
  // role="status" aria-live="polite" and states the sequence. planHost is built EMPTY and every other
  // reference either clears it or fills it AFTER a preview or an apply, so at the one moment the Apply is
  // refused, before anything has been previewed, it is empty and the ONLY carrier of the reason was a
  // hover title. A phone has no hover. So the justification was true of the screen later and false of the
  // screen exactly when it mattered.
  //
  // The remedy is the one the third preserved control already uses (sources-downpipes' enabled switch):
  // keep `disabled`, and put the reason in real DOM text in a visually-hidden span beside the control.
  // That costs nothing against the calm-density budget, it is read by everything rather than depending on
  // a role permitting aria-label, and it does NOT touch the disabled property or the handler, so none of
  // the safety reasoning below is weakened by it.
  //
  // WHAT IS STILL NOT FIXED, recorded rather than dressed up: the control cannot be FOCUSED, so a keyboard
  // user reaches the reason by reading the region rather than by tabbing onto the button. Fixing that
  // properly means the handler moving behind the readiness test, which is a behavioural change to a
  // destructive path and belongs in its own pass with its own proof.
  const APPLY_HELD_REASON = "Recover keys and preview first.";
  const APPLY_REASON_CLASS = "bgp-apply-reason";

  // THE REASON IS RE-ATTACHED ON EVERY ARMING, not held as a node reference, and that is load-bearing
  // rather than defensive. setBtnBusy (components/custody-step-helpers.ts) calls replaceChildren on this
  // button to swap in its spinner, so any span appended once is DETACHED by the first apply attempt and
  // every later write lands on an orphan node that is no longer in the document. A held reference would
  // therefore have carried the reason correctly right up until the customer used the button, and then
  // silently stopped, which is the same shape as the two setBusy defects this migration already turned up.
  // Rebuilding it here means the reason survives every busy cycle, because setApplyEnabled is what runs
  // after one.
  const setApplyEnabled = (enabled: boolean): void => {
    applyBtn.disabled = !enabled;
    applyBtn.title = enabled ? "" : APPLY_HELD_REASON;
    for (const old of Array.from(applyBtn.querySelectorAll(`.${APPLY_REASON_CLASS}`))) old.remove();
    if (!enabled) {
      applyBtn.appendChild(h("span", { class: `visually-hidden ${APPLY_REASON_CLASS}` }, `: ${APPLY_HELD_REASON}`));
    }
  };
  // The initial hold, stated the same way rather than as a special case at build time.
  setApplyEnabled(false);

  // ---- 1. the downpipe to prune ----------------------------------------------------------------------
  const dpValue = h("span", { class: "mono" }, downpipeId ?? "none chosen yet");
  const dpStatus = h("p", { class: "field__hint", style: "margin:0" }, "Choose a downpipe with a retention policy.");
  const dpSelectHost = h("div");
  const dpCard = h(
    "section",
    { class: "card", style: "display:grid;gap:var(--space-2)" },
    h("h3", { class: "card__title" }, "Downpipe to prune"),
    downpipeId ? h("p", { style: "margin:0" }, h("span", "Downpipe: "), dpValue) : dpSelectHost,
    dpStatus,
  );
  root.appendChild(dpCard);

  const loadCandidatesBtn = h(
    "button",
    { "data-dp": "restore-flow.button.load-candidates", class: "btn btn--secondary btn--sm", type: "button", disabled: downpipeId === null },
    "Load this downpipe's runs",
  ) as HTMLButtonElement;
  const candidatesHost = h("div", { role: "status", "aria-live": "polite" });

  if (!downpipeId) {
    void engine
      .listDownpipes()
      .then((list: DownpipeState[]) => {
        const withRetention = list.filter((d) => d.config.retention !== undefined);
        if (withRetention.length === 0) {
          dpSelectHost.replaceChildren(h("p", { class: "field__hint", style: "margin:0" }, "No downpipe here has a retention policy configured yet. Set one on a downpipe's Retention section first."));
          return;
        }
        const dpField = field({
          id: "bgp-downpipe",
          label: "Downpipe",
          kind: "select",
          value: "",
          options: [{ value: "", label: "Choose one…" }, ...withRetention.map((d) => ({ value: d.config.id, label: d.config.name }))],
          hint: "Only downpipes with a retention policy are listed.",
          doc: { href: "https://docs.downpipes.io/backing-up/retention-and-pruning", anchor: "the-three-knobs" },
          onInput: (v) => {
            downpipeId = v === "" ? null : v;
            dpValue.textContent = downpipeId ?? "none chosen yet";
            loadCandidatesBtn.disabled = downpipeId === null;
            candidates = null;
            candidatesHost.replaceChildren();
            planHost.replaceChildren();
            setApplyEnabled(false);
          },
        });
        dpSelectHost.replaceChildren(dpField.el);
      })
      .catch(() => {
        dpSelectHost.replaceChildren(h("p", { class: "field__hint" }, "The downpipe list could not be read just now. Reload and try again."));
      });
  }

  loadCandidatesBtn.addEventListener("click", () => {
    const id = downpipeId;
    if (!id) return;
    setBtnBusy(loadCandidatesBtn, true, "Loading");
    candidatesHost.replaceChildren();
    void engine
      .retentionPruneCandidate(id)
      .then((res) => {
        candidates = res;
        setBtnBusy(loadCandidatesBtn, false, "Load this downpipe's runs");
        const n = res.retainedRunIds.length + res.supersededRunIds.length;
        candidatesHost.replaceChildren(
          h(
            "p",
            { class: "field__hint measure", style: "margin:0" },
            `${groupNumber(n)} run(s) in scope: ${groupNumber(res.retainedRunIds.length)} retained, ${groupNumber(res.supersededRunIds.length)} over the retention window. `,
            res.policy.enforce
              ? "This downpipe's Enforce toggle is ON: an Apply below will actually delete."
              : "This downpipe's Enforce toggle is OFF: Apply will only ever preview, until you turn it on in the downpipe's Retention section.",
            res.failures && res.failures.length > 0 ? ` ${groupNumber(res.failures.length)} run(s) could not be read at all; recovering their keys below will not help.` : "",
          ),
        );
        updateRecoverEnabled();
      })
      .catch((err: unknown) => {
        setBtnBusy(loadCandidatesBtn, false, "Load this downpipe's runs");
        if (isUnauthorised(err)) return void goSignedOut();
        candidatesHost.replaceChildren(blockError(err, () => loadCandidatesBtn.click(), { origin: location.origin }));
      });
  });
  dpCard.appendChild(h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap" }, loadCandidatesBtn));
  dpCard.appendChild(candidatesHost);

  // ---- 2. supply the break-glass key (identical shape to break-glass.ts) ------------------------------
  const keyStatus = h("p", { class: "field__hint", role: "status", "aria-live": "polite", style: "margin:0" }, "No key supplied yet.");
  resetKeyStatus = (): void => {
    keyStatus.textContent = "No key supplied yet.";
  };
  const setPrivate = (id: HybridRecipientPrivate, source: "file" | "reassembly", statusEl: HTMLElement): void => {
    wipePrivate();
    wipeMasters();
    privateKey = id;
    privateSource = source;
    keyStatus.replaceChildren(statusEl);
    planHost.replaceChildren();
    setApplyEnabled(false);
    updateRecoverEnabled();
  };
  const clearPrivate = (): void => {
    wipePrivate();
    wipeMasters();
    updateRecoverEnabled();
  };

  const fileInput = h("input", { id: "bgp-identity", type: "file", accept: ".key,text/plain", "aria-label": "Select your identity.key file" }) as HTMLInputElement;
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
      h("label", { class: "field__label", for: "bgp-identity" }, "Upload identity.key"),
      fileInput,
      h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, "Select the identity.key you saved offline. It is read here and never uploaded."),
      keyDocLink(),
    ),
    keyErr,
    keyStatus,
  );
  const reassembly = renderReassemblyCard({
    showDownload: false,
    onRecovered: (recovered) => {
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

  // ---- 3. recover keys + preview ------------------------------------------------------------------------
  const recoverBtn = h(
    "button",
    { "data-dp": "restore-flow.button.recover", class: "btn btn--primary", type: "button", disabled: true },
    "Recover keys and preview",
  ) as HTMLButtonElement;

  function updateRecoverEnabled(): void {
    const ready = candidates !== null && privateKey !== null;
    recoverBtn.disabled = !ready;
    recoverBtn.title = ready
      ? ""
      : candidates === null && privateKey === null
        ? "Load this downpipe's runs and supply an identity.key first."
        : candidates === null
          ? "Load this downpipe's runs first."
          : "Load an identity.key (or reassemble a split key) first.";
  }

  const runPreviewOrApply = async (previewOnly: boolean): Promise<void> => {
    const id = downpipeId;
    const cand = candidates;
    if (!id || !cand) return;
    const btn = previewOnly ? recoverBtn : applyBtn;
    setBtnBusy(btn, true, previewOnly ? "Recovering keys" : "Applying");
    planHost.replaceChildren();
    try {
      // Recover a master for every candidate run this call needs (only on the preview leg; the apply leg
      // reuses the masters already recovered). A run whose capsule failed to read, or whose master this
      // key does not open, is simply left OUT of the batch: the engine's planner treats a missing/wrong
      // master exactly like an unreadable run (ABSTAIN if it was retained; silently skipped if superseded).
      if (previewOnly) {
        wipeMasters();
        const priv = privateKey;
        // PAINT FIRST, THEN LEAVE: recoverBtn is disabled unless privateKey is set (updateRecoverEnabled),
        // so this is defensive only, but a busy button must still be released on every path.
        if (!priv) {
          setBtnBusy(btn, false, "Recover keys and preview");
          return;
        }
        for (const c of cand.capsules) {
          try {
            masters.set(c.runId, await openCapsule(c.masterCapsule, priv, c.keyCommitment));
          } catch {
            // This run's key did not recover under the supplied identity; left out of the batch on
            // purpose (see the comment above).
          }
        }
      }
      const batch = [...masters.entries()].map(([runId, m]) => ({ runId, masterB64: b64urlEncode(m) }));
      const res = await engine.retentionPruneApply({ downpipeId: id, batch, previewOnly });
      setBtnBusy(btn, false, previewOnly ? "Recover keys and preview" : "Apply now");
      planHost.replaceChildren(renderOutcome(engine, id, res));
      if (!previewOnly) {
        // Every apply attempt (whichever mode it lands on, including a "not-approved" or "incomplete-batch"
        // refusal) consumes this leg's recovered masters: they are held only for the single request they
        // were built for, never longer. A refusal is not a licence to keep the batch armed and silently
        // retry -- the operator recovers keys and previews again (recovering masters costs nothing but a
        // click; the key itself is still held in this tab), so notApprovedPanel's own copy above says
        // exactly that rather than promising a same-batch retry this code does not actually offer.
        wipeMasters();
        if (res.mode === "applied" || res.mode === "partial") toast({ message: res.mode === "applied" ? "Prune applied." : "Prune applied, but stopped partway." });
        else if (res.mode === "abstained" || res.mode === "no-op") toast({ message: "Prune run finished; nothing was deleted this pass." });
      }
      // Apply re-arms only once there is a batch to send: a preview leg that recovered at least one master
      // leaves Apply enabled; an apply leg always wipes its batch above, so Apply disables again until the
      // operator previews afresh (this is also what makes notApprovedPanel's "preview again, then Apply"
      // guidance true rather than aspirational).
      setApplyEnabled(masters.size > 0);
    } catch (err) {
      setBtnBusy(btn, false, previewOnly ? "Recover keys and preview" : "Apply now");
      if (isUnauthorised(err)) return void goSignedOut();
      planHost.replaceChildren(blockError(err, () => void runPreviewOrApply(previewOnly), { origin: location.origin }));
    }
  };
  recoverBtn.addEventListener("click", () => void runPreviewOrApply(true));
  applyBtn.addEventListener("click", () => void runPreviewOrApply(false));

  root.appendChild(h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap" }, recoverBtn, applyBtn));
  root.appendChild(planHost);
  root.appendChild(h("p", { class: "field__hint measure", style: "margin:0" }, "Preview never deletes anything. Apply only deletes when this downpipe's own Enforce toggle is already on; otherwise it previews too.", pruneDocLink()));
  // THE CEREMONY, named before the button rather than discovered after it. Both legs run through the same
  // gated route, so the prompt can open on the harmless preview as well as on the apply, and it opens while
  // the operator has their offline identity.key loaded in this panel. Unnamed, at that moment, the sheet
  // reads as the key being rejected.
  root.appendChild(
    h("p", { class: "field__hint measure", style: "margin:0" }, "You may be asked to confirm with your own passkey on either button. That is your sign-in passkey, not the identity.key you loaded here. If you dismiss that prompt, or it fails, nothing is deleted and the keys you recovered stay in this panel."),
  );

  return { el: root, teardown, peekSensitiveForTest: () => ({ hasPrivate: privateKey !== null, masterCount: masters.size }) };
}

// breakGlassPruneEntryNote is a small, calm-density secondary line pointing at this panel, matching
// breakGlassEntryNote's shape exactly.
export function breakGlassPruneEntryNote(downpipeId?: string): HTMLElement {
  const target = downpipeId ? `/restore/break-glass-prune/${encodeURIComponent(downpipeId)}` : "/restore/break-glass-prune";
  const link = h(
    "button",
    { "data-dp": "restore-flow.button.navigate#2", class: "btn btn--ghost btn--sm", type: "button", on: { click: () => navigate(target) } },
    svgIcon(ICON_TRASH, { size: 13 }),
    "Prune with your key",
  );
  return h("p", { class: "field__hint measure", style: "margin:0;display:flex;align-items:center;gap:var(--space-2)" }, "On an offline-key-only estate?", link);
}
