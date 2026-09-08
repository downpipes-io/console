// Retention-prune dual-control inbox (/restore/prune-approvals): prune requests awaiting a second
// authorised identity. Mirrors restore-flow/approvals.ts's shape (poll cadence, card layout, maker != checker
// UX, the fixed reject-reason picker) as a SIBLING, not a generalisation of it: a prune approval carries
// downpipe id/name + retained/superseded counts, never a run/target/bytes triple, so folding the two into one
// generic component would either lose those restore-specific cues or force this screen to fake ones it does
// not have. See lib/api/types/retention-prune.ts's header for why PruneApproval is its own type rather than a
// reuse of RestoreApproval.
//
// This is the completion this row exists to ship: without it, an operator who supplies a break-glass key,
// previews a plan and clicks Apply on an enforce-on downpipe hits an unexplained 403 with no portal path
// forward -- the no-customer-CLI violation the row was raised to remove, moved one layer down into "raise a
// dual-control request via a raw API call". This screen, plus break-glass-prune.ts's inline request panel,
// close that: every step (request, approve, reject, apply) completes inside the portal.
//
// House rules: Australian English, no em dashes, precise claims.

import type { EngineClient, PruneApproval, PruneRejectReason } from "../../api.ts";
import { PRUNE_REJECT_REASON_COPY, PRUNE_REJECT_REASONS } from "../../api.ts";
import { copyButton } from "../../components/code-block.ts";
import { dialogSurface, openOverlay } from "../../components/dialog.ts";
import { blockError, errorDetail } from "../../components/error-view.ts";
import { banner, emptyState } from "../../components/feedback.ts";
import { confirmModal } from "../../components/modal.ts";
import { badge } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { classifyError, isUnauthorised } from "../../lib/errors.ts";
import { groupNumber, relativeTime, titleCase } from "../../lib/format.ts";
import { ICON_CHECK } from "../../lib/icons.ts";
import { caller, goSignedOut, navigate } from "../../lib/nav.ts";
import { capabilityPhrase } from "../capability-copy.ts";
import { canCap, pageHeader, pendingEngineNote } from "../common.ts";
import { cardSkeleton, cue } from "./shared.ts";

// The silent re-fetch cadence, matching restore's own approvals poll (approvals.ts APPROVALS_POLL_MS).
const PRUNE_APPROVALS_POLL_MS = 15_000;

export function renderPruneApprovalsInbox(engine: EngineClient): HTMLElement {
  const root = h("div");
  root.appendChild(
    pageHeader(
      "Pending prune approvals",
      "Retention-prune requests awaiting a second authorised identity. The approver must differ from the requester (maker is not checker), and approval is bound to the exact retained/superseded split.",
      undefined,
      { label: "Restore", to: "/restore" },
    ),
  );

  const region = h("div", { class: "async-region" });
  root.appendChild(region);

  const me = caller()?.email ?? null;

  // Best-effort downpipeId -> name join (this downpipe's own live list), so each card can name WHAT is
  // being pruned rather than showing only the raw id. Fetched once per load()/retry, never re-fetched on
  // every poll tick (which only re-checks approval status).
  let nameById = new Map<string, string>();

  let shownJson: string | null = null;
  const show = (records: PruneApproval[]): void => {
    shownJson = JSON.stringify(records);
    region.replaceChildren(renderInbox(engine, records, me, canCap("restore.approve"), load, nameById));
  };

  const load = (): void => {
    region.replaceChildren(h("div", { class: "approval-list" }, cardSkeleton(3), cardSkeleton(3)));
    void Promise.all([engine.retentionPruneApprovals(), engine.listDownpipes().catch(() => [])])
      .then(([records, downpipes]) => {
        nameById = new Map(downpipes.map((d) => [d.config.id, d.config.name] as const));
        show(records);
      })
      .catch((err) => {
        if (isUnauthorised(err)) return goSignedOut();
        handlePruneApprovalsLoadError(err, region, load);
      });
  };

  const stopPoll = startPruneApprovalsPoll(engine, root, (records) => {
    if (JSON.stringify(records) === shownJson) return;
    if (region.contains(document.activeElement)) return;
    show(records);
  });
  void stopPoll;

  load();
  return root;
}

function handlePruneApprovalsLoadError(err: unknown, region: HTMLElement, reload: () => void): void {
  const kind = classifyError(err, { origin: location.origin });
  if (kind.kind === "server" && (kind.status === 404 || kind.status === 501)) {
    region.replaceChildren(
      pendingEngineNote({
        what: "The pending prune-approval inbox could not load: this engine build does not support prune approvals yet.",
        dependsOn: "an engine update",
        interim: `The engine returned: ${err instanceof Error ? err.message : String(err)}. The approvals route (GET /admin/retention-prune/approvals) is not available on this engine build; update the engine to enable prune approvals.`,
      }),
    );
  } else {
    region.replaceChildren(blockError(err, reload, { origin: location.origin }));
  }
}

function startPruneApprovalsPoll(engine: EngineClient, root: HTMLElement, onRecords: (records: PruneApproval[]) => void): () => void {
  const pollTick = window.setInterval(() => {
    if (!root.isConnected) { window.clearInterval(pollTick); return; }
    void engine.retentionPruneApprovals().then((records) => {
      if (!root.isConnected) return;
      onRecords(records);
    }).catch((err: unknown) => {
      if (isUnauthorised(err)) { window.clearInterval(pollTick); goSignedOut(); }
    });
  }, PRUNE_APPROVALS_POLL_MS);
  return () => window.clearInterval(pollTick);
}

function renderInbox(engine: EngineClient, records: PruneApproval[], me: string | null, canApprove: boolean, reload: () => void, nameById: Map<string, string>): HTMLElement {
  if (records.length === 0) {
    return emptyState({ title: "No pending prune approvals", body: "Prune requests awaiting a second signer will appear here. Raise one from a downpipe's break-glass prune panel." });
  }
  const wrap = h("div", { class: "approval-inbox" });
  const list = h("div", { class: "approval-list" });
  for (const r of records) list.appendChild(renderPruneApprovalCard(engine, r, me, canApprove, reload, nameById.get(r.downpipeId)));
  wrap.appendChild(list);
  wrap.appendChild(h("p", { class: "approval-inbox__footnote field__hint" }, "That is every pending prune approval."));
  return wrap;
}

// pruneApprovalStatusBadge mirrors approvalStatusBadge (shared.ts) over PruneApprovalStatus, which is the
// SAME closed member set restore's ApprovalStatus mirror uses (requested/approved/rejected/consumed/
// expired); kept as its own function rather than importing the restore one so a future divergence in either
// vocabulary cannot silently change the other's rendering.
function pruneApprovalStatusBadge(status: PruneApproval["status"]): HTMLElement {
  if (status === "requested") return badge("info", "Awaiting approval");
  if (status === "applying") return badge("info", "Applying");
  const tone = status === "approved" ? "ok" : status === "rejected" ? "danger" : status === "expired" ? "neutral" : "info";
  return badge(tone, titleCase(status));
}

function renderPruneApprovalCard(engine: EngineClient, r: PruneApproval, me: string | null, canApprove: boolean, reload: () => void, downpipeName: string | undefined): HTMLElement {
  const isMine = me !== null && r.requestedBy === me;
  const card = h("div", { class: "card approval-card" });
  const title = downpipeName ? h("h3", { class: "card__title" }, downpipeName) : h("h3", { class: "card__title mono" }, r.downpipeId);
  card.appendChild(h("div", { class: "card__header" }, title, pruneApprovalStatusBadge(r.status)));

  const cues = h("div", { class: "approval-cues" });
  cue(cues, "Downpipe id", r.downpipeId);
  const makerValue = cue(cues, "Requested by", r.requestedBy);
  makerValue.classList.add("approval-cue__value--email");
  makerValue.title = r.requestedBy;
  cue(cues, "Requested", relativeTime(r.requestedAt));
  cue(cues, "Runs retained", groupNumber(r.retainedRuns));
  cue(cues, "Runs superseded", groupNumber(r.supersededRuns));
  card.appendChild(cues);

  card.appendChild(h("p", { class: "approval-reason" }, h("span", { class: "field__hint" }, "Reason: "), r.reason));
  card.appendChild(h("p", { class: "field__hint mono", title: r.planHash }, `Plan ${r.planHash.slice(0, 28)}…`, copyButton("Copy plan hash", () => r.planHash)));

  if (r.status === "requested") {
    card.appendChild(renderPruneApprovalActions(engine, r, isMine, canApprove, reload, downpipeName));
  } else if (r.status === "approved" && r.approvedBy) {
    card.appendChild(h("p", { class: "field__hint" }, `Approved by ${r.approvedBy}. The requester can now apply this exact plan from the downpipe's break-glass prune panel.`));
  } else if (r.status === "applying") {
    // The state the engine is briefly in between a reserved apply and its commit (or a
    // release back to "approved" on a failed/errored attempt). This should be seen rarely and briefly since
    // the engine releases the reservation on every exception path (engine/src/admin/router-retention-prune.ts),
    // but a bare badge with no sentence read as broken rather than in-progress.
    card.appendChild(h("p", { class: "field__hint" }, "This plan is being applied now. It normally finishes within moments; if the badge is still here after a few minutes, refresh the page or check with the requester."));
  } else if (r.status === "consumed") {
    card.appendChild(h("p", { class: "field__hint" }, "This approval was used to apply the prune and cannot be reused."));
  } else if (r.status === "expired") {
    card.appendChild(h("p", { class: "field__hint" }, "This request expired before it was approved. Raise a fresh request to proceed."));
  } else if (r.status === "rejected") {
    const copy = r.rejectReason ? PRUNE_REJECT_REASON_COPY[r.rejectReason] : undefined;
    card.appendChild(
      h(
        "p",
        { class: "field__hint" },
        copy
          ? `Rejected${r.approvedBy ? ` by ${r.approvedBy}` : ""}: ${copy.label.toLowerCase()}. Because ${copy.requesterLine}`
          : `Rejected${r.approvedBy ? ` by ${r.approvedBy}` : ""}. Raise a fresh request if it is still needed.`,
      ),
    );
  }
  return card;
}

function renderPruneApprovalActions(engine: EngineClient, r: PruneApproval, isMine: boolean, canApprove: boolean, reload: () => void, downpipeName: string | undefined): HTMLElement {
  const actions = h("div", { class: "approval-actions" });

  if (isMine) {
    actions.appendChild(banner({ tone: "info", message: "You raised this request, so you cannot approve it. A different authorised approver must sign off." }));
    return actions;
  }
  if (!canApprove) {
    actions.appendChild(h("p", { class: "field__hint" }, `Approving requires ${capabilityPhrase("restore.approve")}, which the engine enforces on this route too.`));
    return actions;
  }

  const approveBtn = h("button", { "data-dp": "restore-flow.button.approve#2", class: "btn btn--primary btn--sm", type: "button" }, svgIcon(ICON_CHECK, { size: 14 }), "Approve") as HTMLButtonElement;
  const rejectBtn = h("button", { "data-dp": "restore-flow.button.reject#2", class: "btn btn--secondary btn--sm", type: "button" }, "Reject") as HTMLButtonElement;

  approveBtn.addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "Approve prune",
      body: approveConfirmBody(r, downpipeName),
      confirmLabel: "Approve",
      busyLabel: "Approving",
      severity: "warn",
    });
    if (!ok) return;
    try {
      await engine.retentionPruneApprove(r.planHash);
      toast({ message: "Prune approved" });
      reload();
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      toast({ message: `Could not approve. ${errorDetail(err)}`, tone: "warn" });
    }
  });
  rejectBtn.addEventListener("click", async () => {
    const picked = await pickPruneRejectReason(downpipeName ?? r.downpipeId);
    if (picked === null) return;
    try {
      await engine.retentionPruneReject(r.planHash, picked);
      toast({ message: "Prune rejected" });
      reload();
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      toast({ message: `Could not reject. ${errorDetail(err)}`, tone: "warn" });
    }
  });
  actions.appendChild(approveBtn);
  actions.appendChild(rejectBtn);
  return actions;
}

function shortPlanHash(planHash: string): string {
  const digest = planHash.startsWith("sha384:") ? planHash.slice("sha384:".length) : planHash;
  return digest.slice(0, 16);
}

function approveConfirmBody(r: PruneApproval, downpipeName: string | undefined): HTMLElement {
  const wrap = h("div", { class: "form-stack" });
  const what = downpipeName ?? r.downpipeId;
  wrap.appendChild(h("p", `Approve the retention prune of ${what}? The requester can then apply this exact plan from the break-glass prune panel. This is recorded with both identities.`));
  const cues = h("div", { class: "approval-cues" });
  cue(cues, "Downpipe", what);
  cue(cues, "Runs retained", groupNumber(r.retainedRuns));
  cue(cues, "Runs superseded", groupNumber(r.supersededRuns));
  cue(cues, "Plan hash", shortPlanHash(r.planHash));
  wrap.appendChild(cues);
  // This is the maker-not-checker's last chance to catch a mistake before archive bytes
  // are destroyed, and the run counts above are the only blast-radius figure the request route can compute
  // (engine/src/admin/router-retention-prune.ts POST /retention-prune/request runs partitionRuns keylessly,
  // before anyone has recovered a master; the real object/segment counts only exist once planPrune runs at
  // preview/apply time). Say that plainly rather than let the run counts alone read as the whole picture.
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "Object and segment counts are not known until apply: raising a request needs no archive key, so the run counts above are the only blast-radius figure available before you approve.",
    ),
  );
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      "You may be asked to confirm with your own passkey before the approval is recorded. If you dismiss that prompt, or it fails, nothing is approved and you can start again from this card.",
    ),
  );
  return wrap;
}

// pickPruneRejectReason mirrors pickRejectReason (approvals.ts): a fixed picker over the CLOSED
// PRUNE_REJECT_REASONS, so a rejection can never leave the record (or the sealed pack) with no reason on it.
function pickPruneRejectReason(what: string): Promise<PruneRejectReason | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: PruneRejectReason | null): void => {
      if (settled) return;
      settled = true;
      handle.close();
      resolve(v);
    };

    const body = h("div", { style: "display:grid;gap:var(--space-3)" });
    body.appendChild(h("p", { class: "measure" }, `Reject the retention prune of ${what}? Choose the reason. The requester sees it, and it is recorded against the request.`));
    const list = h("div", { style: "display:grid;gap:var(--space-2)" });
    for (const reason of PRUNE_REJECT_REASONS) {
      const copy = PRUNE_REJECT_REASON_COPY[reason];
      const btn = h("button", { "data-dp": "restore-flow.button.finish#2", class: "btn btn--secondary", type: "button", style: "justify-content:flex-start;text-align:left" }, copy.label) as HTMLButtonElement;
      btn.addEventListener("click", () => finish(reason));
      list.appendChild(btn);
    }
    body.appendChild(list);

    const cancelBtn = h("button", { "data-dp": "restore-flow.button.cancel#2", class: "btn btn--ghost", type: "button" }, "Cancel") as HTMLButtonElement;
    cancelBtn.addEventListener("click", () => finish(null));
    const footer = h("div", { class: "dialog__actions" }, cancelBtn);
    const { surface } = dialogSurface({ variant: "modal", title: "Reject prune", body, footer, onCloseClick: () => finish(null) });
    const handle = openOverlay({ surface, variant: "modal", dismissable: true, onClose: () => finish(null), initialFocus: cancelBtn });
  });
}

// pruneApprovalsEntryNote is a small, calm-density secondary line pointing at the inbox, matching
// breakGlassPruneEntryNote's shape.
export function pruneApprovalsEntryNote(): HTMLElement {
  const link = h(
    "button",
    { "data-dp": "restore-flow.button.navigate-restore-prune-approvals", class: "btn btn--ghost btn--sm", type: "button", on: { click: () => navigate("/restore/prune-approvals") } },
    svgIcon(ICON_CHECK, { size: 13 }),
    "Pending prune approvals",
  );
  return h("p", { class: "field__hint measure", style: "margin:0;display:flex;align-items:center;gap:var(--space-2)" }, "Waiting on a distinct approver?", link);
}
