// Restore the pending-approval inbox (/restore/approvals): restore
// requests awaiting a second authorised identity. The approver must differ from the
// requester (maker is not checker), and approval is bound to the exact plan. Each card
// shows the blast-radius cues so the approver reviews the real impact, not a rubber-stamp;
// a requester sees the explicit "you cannot approve your own request" state. Moved verbatim
// out of restore-flow.ts for size: no confirmation / dual-control wording and no plan-hash
// handling is changed. House rules: Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { pageHeader, canCap, pendingEngineNote } from "../common.ts";
import { capabilityPhrase } from "../capability-copy.ts";
import { goSignedOut, caller } from "../../lib/nav.ts";
import { isUnauthorised, classifyError } from "../../lib/errors.ts";
import { blockError, errorDetail } from "../../components/error-view.ts";
import { emptyState, banner } from "../../components/feedback.ts";
import { confirmModal } from "../../components/modal.ts";
import { openOverlay, dialogSurface } from "../../components/dialog.ts";
import { RESTORE_REJECT_REASONS, RESTORE_REJECT_REASON_COPY, type RestoreRejectReason } from "../../lib/api/types/rbac.ts";
import { toast } from "../../components/toast.ts";
import { copyButton } from "../../components/code-block.ts";
import { badge } from "../../components/status.ts";
import { relativeTime, absoluteTime, groupNumber, humanBytes } from "../../lib/format.ts";
import { ICON_CHECK } from "../../lib/icons.ts";
import type { EngineClient, RestoreApproval } from "../../api.ts";
import { cardSkeleton, approvalStatusBadge, cue, buildRunNameJoin, downpipeIdentityCell, type RunIdentity } from "./shared.ts";

// ---- the pending-approval inbox (/restore/approvals) ------------------------

// The silent re-fetch cadence for the inbox, matching the overview poll cadence. Named so a
// change to that shared cadence is made in one place rather than as a bare literal.
const APPROVALS_POLL_MS = 15_000;

export function renderApprovalsInbox(engine: EngineClient): HTMLElement {
  const root = h("div");
  root.appendChild(
    pageHeader(
      "Pending restore approvals",
      "Restore requests awaiting a second authorised identity. The approver must differ from the requester (maker is not checker), and approval is bound to the exact plan.",
      undefined,
      // Referrer-aware: returns to the run-prefilled restore the approver opened the
      // inbox from (the round-trip the fixed "Back to restore" could not do), or the
      // restore home on a cold deep-link.
      { label: "Restore", to: "/restore" },
    ),
  );

  const region = h("div", { class: "async-region" });
  root.appendChild(region);

  const me = caller()?.email ?? null;

  // canApprove is re-read on every render (canCap is a cheap synchronous session read) rather
  // than captured once, so a role change that triggers a re-render also refreshes the gate
  // hint. It gates on restore.approve, the capability the engine enforces on POST /admin/restore/approve
  // and /reject (gate(caller, "restore.approve"), held by Restore operator, Approver and Owner). Gating by
  // that capability, not the approver role rank, matters because a restore-operator sits off the rank
  // ladder yet holds restore.approve, so the old canDo("approver") rank check hid the approve/reject
  // actions from the recovery-only role the engine accepts as a second signer. This is a presentation
  // hint only: the engine enforces the gate (and maker != checker) server-side on every approve and
  // reject call, so the hint can never grant an action the engine refuses.

  // Best-effort runId -> downpipe identity join (shared.ts buildRunNameJoin), so each card can name
  // WHAT it is approving rather than showing only "Run <raw id>" -- the exact gap a second approver
  // otherwise hits. Fetched once per load()/retry (never throws; a failed read yields an empty join),
  // NOT re-fetched on every 15 s poll tick below (which only re-checks approval status), so the inbox
  // never turns a lightweight poll into three reads forever.
  let nameJoin = new Map<string, RunIdentity>();

  // The records currently rendered (serialised), so the poll can skip a swap that would
  // rebuild an identical list and destroy keyboard focus mid-approve.
  let shownJson: string | null = null;
  const show = (records: RestoreApproval[]): void => {
    shownJson = JSON.stringify(records);
    region.replaceChildren(renderInbox(engine, records, me, canCap("restore.approve"), load, nameJoin));
  };

  const load = () => {
    // Card-shaped placeholders: the loaded content is a stack of approval cards, so a
    // bare row skeleton would lie about the layout and jump on arrival.
    region.replaceChildren(h("div", { class: "approval-list" }, cardSkeleton(3), cardSkeleton(3)));
    void Promise.all([engine.listApprovals(), buildRunNameJoin(engine)])
      .then(([records, join]) => {
        nameJoin = join;
        show(records);
      })
      .catch((err) => {
        if (isUnauthorised(err)) return goSignedOut();
        handleApprovalsLoadError(err, region, load);
      });
  };

  const stopPoll = startApprovalsPoll(engine, root, (records) => {
    // Skip the swap when nothing changed (rebuilding identical cards is churn for no new
    // information) and while focus is inside the inbox (the swap would destroy keyboard focus
    // mid-approve); the next tick applies it once focus moves on.
    if (JSON.stringify(records) === shownJson) return;
    if (region.contains(document.activeElement)) return;
    show(records);
  });
  void stopPoll; // teardown is self-driven (root detach); the handle is kept for clarity

  load();
  return root;
}

// handleApprovalsLoadError renders the load-failure region: a design-acknowledged degrade
// (404 or 501, the approvals list route not yet wired on this engine build) shows the
// pending-engine note in the user's vocabulary; a genuine transport fault (5xx or network)
// shows a block error with Retry so the operator can re-poll without navigating away.
function handleApprovalsLoadError(err: unknown, region: HTMLElement, reload: () => void): void {
  const kind = classifyError(err, { origin: location.origin });
  if (kind.kind === "server" && (kind.status === 404 || kind.status === 501)) {
    region.replaceChildren(
      pendingEngineNote({
        what: "The pending-approval inbox could not load: this engine build does not support restore approvals yet.",
        dependsOn: "an engine update",
        interim: `The engine returned: ${err instanceof Error ? err.message : String(err)}. The approvals route (GET /admin/restore/approvals) is not available on this engine build; update the engine to enable restore approvals.`,
      }),
    );
  } else {
    region.replaceChildren(blockError(err, reload, { origin: location.origin }));
  }
}

// startApprovalsPoll runs the silent ~15 s re-fetch (matching the overview poll cadence) so a
// pending approval appears without a manual reload, and returns a stop() handle. Rules:
//   - Never blanks the list; onRecords is called only on a successful fetch (errors are
//     swallowed to avoid clobbering a good list).
//   - Stops immediately when `root` is detached (navigated away) so it never runs in the
//     background after the view is gone, and clears the interval on teardown.
//   - A sign-out on the poll still hands off to goSignedOut (auth is the one exception: a
//     lapsed session must not be silently absorbed).
function startApprovalsPoll(engine: EngineClient, root: HTMLElement, onRecords: (records: RestoreApproval[]) => void): () => void {
  const pollTick = window.setInterval(() => {
    if (!root.isConnected) { window.clearInterval(pollTick); return; }
    void engine.listApprovals().then((records) => {
      if (!root.isConnected) return; // navigated away while the fetch was in flight
      onRecords(records);
    }).catch((err: unknown) => {
      if (isUnauthorised(err)) { window.clearInterval(pollTick); goSignedOut(); }
      // Any other error: leave the current list in place (never blank it on a poll fault).
    });
  }, APPROVALS_POLL_MS);
  return () => window.clearInterval(pollTick);
}

function renderInbox(engine: EngineClient, records: RestoreApproval[], me: string | null, canApprove: boolean, reload: () => void, nameJoin: Map<string, RunIdentity>): HTMLElement {
  if (records.length === 0) {
    return emptyState({ title: "No pending approvals", body: "Restore requests awaiting a second signer will appear here. Raise one from the restore review panel." });
  }
  // Centre the list in a readable measure (matching the console's single-column screens)
  // rather than letting one small card sit in a full-bleed empty canvas, and name the end of the
  // list explicitly (the muted footnote below) so a short inbox reads as complete, not truncated.
  const wrap = h("div", { class: "approval-inbox" });
  const list = h("div", { class: "approval-list" });
  for (const r of records) {
    list.appendChild(renderApprovalCard(engine, r, me, canApprove, reload, nameJoin.get(r.runId)));
  }
  wrap.appendChild(list);
  wrap.appendChild(h("p", { class: "approval-inbox__footnote field__hint" }, "That is every pending approval."));
  return wrap;
}

// identity is this card's best-effort runId -> downpipe join (shared.ts buildRunNameJoin), absent when
// the run has rolled off every retained ring (RING_CAP) or the join read failed -- the card then falls
// back to the raw run id alone, exactly as before this feature, never a fabricated name.
function renderApprovalCard(engine: EngineClient, r: RestoreApproval, me: string | null, canApprove: boolean, reload: () => void, identity: RunIdentity | undefined): HTMLElement {
  // isMine drives the "you raised this, so you cannot approve it (maker != checker)" UX hint. It
  // compares the caller's EMAIL to the approval's requestedBy because that field is email (display)
  // on the RestoreApproval wire shape. The engine enforces maker != checker on the stable SUBJECT
  // and refuses a self-approval
  // there regardless, so this email compare is a presentation hint only, never the control.
  const isMine = me !== null && r.requestedBy === me;
  // THE WINDOW THE APPROVER HAS TO ACT INSIDE, read once per card so the cue below and the actions at the
  // foot cannot disagree with each other mid-render. null means "this console cannot read a deadline for
  // this record", which is never the same thing as "the deadline has passed"; see approvalDeadlineMs.
  const nowMs = Date.now();
  const deadlineMs = approvalDeadlineMs(r);
  const lapsed = deadlineMs !== null && deadlineMs <= nowMs;
  const card = h("div", { class: "card approval-card" });
  // data-tour-id is an inert hook the public page-walkthrough tour pins a "?" info-point to (the maker/checker
  // dual-control gate). No behaviour; no effect on the genuine console. Set on the status badge here and the
  // maker cue below.
  const statusBadge = approvalStatusBadge(r.status);
  statusBadge.dataset.tourId = "approval-status";
  // The headline names WHAT is being approved: the downpipe's friendly name when the best-effort
  // runId -> downpipe join (approvals.ts renderApprovalsInbox, shared.ts buildRunNameJoin) resolved it,
  // falling back to "Run <id>" exactly as before this feature when it did not (the run rolled off every
  // retained history ring, or the join read failed) -- a second approver could previously tell only the
  // raw run id, never what it belonged to. The run id itself is never dropped: it always reappears as its
  // own cue row below, so it stays visible (and copyable via the plan-hash-adjacent mono styling) either way.
  const title = identity?.downpipeName
    ? h("h3", { class: "card__title" }, identity.downpipeName)
    : h("h3", { class: "card__title mono" }, `Run ${r.runId}`);
  card.appendChild(h("div", { class: "card__header" }, title, statusBadge));

  // Blast-radius cues so the approver reviews the exact impact, not a rubber-stamp.
  const cues = h("div", { class: "approval-cues" });
  // The downpipe identity cue: shown whenever the join resolved AT LEAST the id (a name is a bonus on
  // top), so an approver can jump to that downpipe even without a name. Omitted entirely when the join
  // has nothing (never a "downpipe unknown" placeholder row).
  if (identity) approvalCueNode(cues, "Downpipe", downpipeIdentityCell(identity.downpipeId, identity.downpipeName));
  approvalCueNode(cues, "Run id", h("span", { class: "mono" }, r.runId));
  const makerValue = cue(cues, "Requested by", r.requestedBy);
  // Tag the "Requested by" VALUE (content-sized, the requester's email) so the tour's maker/checker "?" sits
  // beside the words, not across the cue row. cue() hands back the value element it just built: a
  // first-match query here used to aim the tour's spotlight at the FIRST cue, which the Downpipe and Run id
  // rows above pushed onto the downpipe name. Inert; no behaviour change.
  makerValue.setAttribute("data-tour-id", "approval-maker");
  // The value is a directory email with no natural break point (a domain must never shred
  // character-by-character). Ellipsis-truncate it instead, with the full address on a title attribute
  // for a hover / assistive-tech read.
  makerValue.classList.add("approval-cue__value--email");
  makerValue.title = r.requestedBy;
  cue(cues, "Requested", relativeTime(r.requestedAt));
  approvalWindowCue(cues, r, deadlineMs, nowMs);
  cue(cues, "Planned writes", groupNumber(r.plannedWrites));
  cue(cues, "Bytes", humanBytes(r.bytes));
  cue(cues, "Latest run", r.isLatest ? "Yes" : "No, an older run");
  // The restore target is always shown (not only on a redirect) so the approver sees where
  // records land as plainly as they see how many; a redirect gets a DANGER chip because writing
  // every record somewhere other than its origin is the most dangerous option on offer here.
  approvalCueNode(cues, "Target", targetValueNode(r));
  card.appendChild(cues);

  if (r.isLatest === false) {
    card.appendChild(banner({ tone: "warn", message: "This request restores an older run over current data (not the latest run)." }));
  }

  card.appendChild(h("p", { class: "approval-reason" }, h("span", { class: "field__hint" }, "Reason: "), r.reason));
  card.appendChild(
    h("p", { class: "field__hint mono", title: r.planHash }, `Plan ${r.planHash.slice(0, 28)}…`, copyButton("Copy plan hash", () => r.planHash)),
  );

  if (r.status === "requested" && lapsed) {
    // A record the engine handed over as still open whose deadline has since passed on this reader's clock.
    // That is reachable rather than hypothetical: the 15 s poll above SKIPS its swap while focus is inside
    // the inbox, so the approver who has tabbed to Approve is exactly the reader whose card never refreshes
    // its server-computed status. Withdrawing the actions can only ever refuse EARLIER than the engine and
    // never grant, because approvals.ts's canApprove and canReject both refuse a lapsed record outright: an
    // Approve offered here could only ever produce a toast naming a refusal the card already knew about.
    card.appendChild(
      h(
        "p",
        { class: "field__hint" },
        `This request's window closed at ${absoluteTime(r.expiresAt)}, so the engine now refuses an approval or a rejection against it. Raise a fresh request from a new dry run to proceed.`,
      ),
    );
  } else if (r.status === "requested") {
    card.appendChild(renderApprovalActions(engine, r, isMine, canApprove, reload, identity));
  } else if (r.status === "approved" && r.approvedBy) {
    // A lapsed approval cannot be spent, so the line that tells the requester they may now apply this plan
    // would be flatly false on one. The honest version names the instant instead of implying an open path.
    card.appendChild(
      h(
        "p",
        { class: "field__hint" },
        lapsed
          ? `Approved by ${r.approvedBy}, but the window closed at ${absoluteTime(r.expiresAt)}, so no apply can spend this approval. Raise a fresh request from a new dry run to proceed.`
          : `Approved by ${r.approvedBy}. The requester can now apply this exact plan.`,
      ),
    );
  } else if (r.status === "consumed") {
    card.appendChild(h("p", { class: "field__hint" }, "This approval was used to apply the restore and cannot be reused."));
  } else if (r.status === "expired") {
    card.appendChild(h("p", { class: "field__hint" }, "This request expired before it was approved. Raise a fresh request to proceed."));
  } else if (r.status === "rejected") {
    // The checker's CLOSED reason, and what the REQUESTER should do about it. The reject wire used to
    // carry no reason at all, so this line could only ever state the fact and shrug: "raise a fresh request if
    // it is still needed" is advice that walks a requester straight back into the same refusal when the plan was
    // too broad or aimed at the wrong target. A record rejected before this shipped has no reason and honestly
    // keeps the old line, rather than being given a fabricated one.
    const copy = r.rejectReason ? RESTORE_REJECT_REASON_COPY[r.rejectReason] : undefined;
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

function renderApprovalActions(engine: EngineClient, r: RestoreApproval, isMine: boolean, canApprove: boolean, reload: () => void, identity: RunIdentity | undefined): HTMLElement {
  const actions = h("div", { class: "approval-actions" });

  // Maker is not checker: a requester cannot approve their own request, shown as the
  // explicit "you cannot approve your own request" state the storyboard calls for.
  if (isMine) {
    actions.appendChild(
      banner({ tone: "info", message: "You raised this request, so you cannot approve it. A different authorised approver must sign off." }),
    );
    return actions;
  }
  if (!canApprove) {
    actions.appendChild(h("p", { class: "field__hint" }, `Approving requires the Approver or Owner role, or the recovery-only Restore operator role; each holds ${capabilityPhrase("restore.approve")} that the engine enforces.`));
    return actions;
  }

  const approveBtn = h("button", { "data-dp": "restore-flow.button.approve#1", class: "btn btn--primary btn--sm", type: "button", dataset: { tourId: "approval-approve" } }, svgIcon(ICON_CHECK, { size: 14 }), "Approve") as HTMLButtonElement;
  const rejectBtn = h("button", { "data-dp": "restore-flow.button.reject#1", class: "btn btn--secondary btn--sm", type: "button" }, "Reject") as HTMLButtonElement;

  approveBtn.addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "Approve restore",
      // Restate the facts the checker signs (the downpipe, run id, planned writes, the target, the
      // short plan hash) so the decision is made against the same structured facts the pending card
      // shows, not the one-line summary alone. This only SURFACES what the plan hash already binds; the
      // gate itself (the engine's maker != checker check, bound to the exact plan hash) is unchanged.
      body: approveConfirmBody(r, identity),
      confirmLabel: "Approve",
      busyLabel: "Approving",
      // A small tokenised icon chip in the dialog header so the chrome itself signals weight
      // before the operator reads any copy. Button hierarchy is unchanged (still primary Approve).
      severity: "warn",
    });
    if (!ok) return;
    try {
      await engine.approveRestore(r.planHash);
      toast({ message: "Restore approved" });
      reload();
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      // The engine refuses a self-approval (maker == checker) with a 400 that carries its own reason
      // (readErrorReason); errorDetail runs the shared classifyError pipeline so that reason (or a
      // 403/429/network fault) reads as customer copy, never the raw "<verb>: <reason>: <status>" throw.
      toast({ message: `Could not approve. ${errorDetail(err)}`, tone: "warn" });
    }
  });
  rejectBtn.addEventListener("click", async () => {
    // A reject is the RECOVERABLE action (a fresh request can always be raised), so it
    // carries the default confirm weight; the danger variant stays off it so friction
    // tracks consequence (the Approve unlocks a live-data write; this does not).
    //
    // The confirm is now the picker. The checker chooses a reason and that choice IS the confirm, so the
    // reason cannot be skipped and there is no extra step to skip it in. It is a fixed set of buttons rather
    // than a text box, deliberately and in both directions: a free-text box would carry the approver's prose
    // (which names the customer's own data, the binding they meant to protect, the incident) into the sealed
    // support pack, and it would also let the reason be left blank, which is the state the gap is about.
    const picked = await pickRejectReason(r.runId);
    if (picked === null) return;
    try {
      await engine.rejectRestore(r.planHash, picked);
      toast({ message: "Restore rejected" });
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

// ---- the approver's own window ----------------------------------------------

// approvalDeadlineMs reads the approval's own expiry instant, or null when this console cannot read one
// from the record.
//
// NULL IS NOT "EXPIRED" AND IS NEVER TREATED AS ONE. An absent or unreadable expiresAt is a record whose
// window this console does not know, not a record whose window has closed, and both call sites fall back to
// exactly what the card did before rather than to a refusal. The engine draws the same distinction on its
// own side: effectiveStatus (engine/src/admin/approvals.ts) guards its expiry check on Number.isFinite, so
// a timestamp it cannot parse never reads as expired there either.
//
// The type says expiresAt is a required string, and the wire is not the type: an older engine build, or a
// record whose stored timestamp is garbled, can hand over neither. The read is therefore made against what
// actually arrived rather than against the declaration.
//
// THE DURATION of the window is not derived, restated or hard-coded anywhere in this file. The engine owns
// it (APPROVAL_TTL_MS, plus the reservation lease that together make up RESTORE_APPLY_DEADLINE_MS) and
// anchors it to the dry run rather than to the request, so any number written into console copy would be a
// second source of truth that drifts from it. Only the instant the engine sent is ever shown.
function approvalDeadlineMs(r: RestoreApproval): number | null {
  const raw: unknown = (r as { expiresAt?: unknown }).expiresAt;
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

// approvalWindowCue names the approver's own deadline on the card: "Expires in 3h" while it is still open,
// and "Expired 30m ago" once it has closed, so a lapsed record can never read as a window still running.
// The exact instant rides as the value's title, which is format.ts's own stated contract for relativeTime
// ("The absolute time is shown as a title at the call site for precision").
//
// This is the same cue, the same shared helper and the same label the owner-action card has carried all
// along (screens/owner-actions.ts, the other dual-control inbox), not a shape invented for this screen.
//
// Nothing at all is rendered when the deadline is unreadable. A "-" row would assert that the console knows
// this approval's window and is showing it to the approver, which is the opposite of what is true.
function approvalWindowCue(host: HTMLElement, r: RestoreApproval, deadlineMs: number | null, nowMs: number): void {
  if (deadlineMs === null) return;
  const value = cue(host, deadlineMs <= nowMs ? "Expired" : "Expires", relativeTime(r.expiresAt));
  value.setAttribute("title", absoluteTime(r.expiresAt));
}

// ---- Helpers: the restore target as a structured field -------------------

// targetValueNode renders the Target cue's value: the plain "Original bindings" fact for the
// common, safe case, or a DANGER-toned chip naming the exact redirect binding for the rare, most
// dangerous option (every record is written somewhere other than where it came from). Shared by
// the pending card and the Approve confirm modal so the same fact reads identically in both places.
function targetValueNode(r: RestoreApproval): Node {
  if (r.redirectBinding === null) return document.createTextNode("Original bindings");
  const wrap = h("span", { class: "approval-target-redirect" });
  wrap.appendChild(badge("danger", "Redirect"));
  wrap.appendChild(document.createTextNode(`all records to ${r.redirectBinding}`));
  return wrap;
}

// approvalCueNode appends a labelled cue row whose value is a built node rather than plain text
// (the Target chip, the restated mono plan hash), mirroring cue()'s exact DOM shape (shared.ts) so
// the two families of rows sit flush in the same grid. cue() itself is untouched and stays the
// plain-text path every other caller (including config-changes.ts and owner-actions.ts, which
// reuse the same "approval-cue"/"approval-cue__value" classes) keeps using.
function approvalCueNode(host: HTMLElement, label: string, value: Node): void {
  host.appendChild(h("div", { class: "approval-cue" }, h("span", { class: "field__hint" }, label), h("span", { class: "approval-cue__value" }, value)));
}

// shortPlanHash derives the short, human-scannable form of the dual-control plan hash the checker
// signs: the "sha384:" mechanism prefix is dropped (it names the hash function, not the plan) and
// the first 16 hex characters are kept, enough to eyeball-match against the full hash shown (and
// copyable) on the card without repeating the whole digest in the confirm dialog. This only
// RESTATES a fact the plan hash already binds; it changes no gate.
function shortPlanHash(planHash: string): string {
  const digest = planHash.startsWith("sha384:") ? planHash.slice("sha384:".length) : planHash;
  return digest.slice(0, 16);
}

// approveConfirmBody restates the exact facts the checker signs before they confirm: WHICH downpipe
// (when the join resolved a name -- the actual decision point, so this is the most important place for
// it, more than the list card), the run id, the planned writes, the restore target (Original bindings,
// or the danger-toned redirect chip), and the short plan hash. The decision is then made against the
// same structured facts the pending card shows, not a single summary sentence alone. This only SURFACES
// what the plan hash already binds; it changes no gate.
function approveConfirmBody(r: RestoreApproval, identity: RunIdentity | undefined): HTMLElement {
  const wrap = h("div", { class: "form-stack" });
  const what = identity?.downpipeName ? `${identity.downpipeName} (run ${r.runId})` : `run ${r.runId}`;
  wrap.appendChild(
    h("p", `Approve the restore of ${what}? The requester can then apply this exact plan. This is recorded with both identities.`),
  );
  const cues = h("div", { class: "approval-cues" });
  if (identity) approvalCueNode(cues, "Downpipe", downpipeIdentityCell(identity.downpipeId, identity.downpipeName));
  approvalCueNode(cues, "Run id", h("span", { class: "approval-cue__value--mono" }, r.runId));
  cue(cues, "Planned writes", groupNumber(r.plannedWrites));
  approvalCueNode(cues, "Target", targetValueNode(r));
  approvalCueNode(cues, "Plan hash", h("span", { class: "approval-cue__value--mono approval-cue__value--hash" }, shortPlanHash(r.planHash)));
  wrap.appendChild(cues);
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      "You may be asked to confirm with your own passkey before the approval is recorded. If you dismiss that prompt, or it fails, nothing is approved and you can start again from this card.",
    ),
  );
  return wrap;
}


// pickRejectReason is the checker's fixed reason picker: one button per closed member, and the choice IS
// the confirm. It resolves to the chosen member, or null if the checker backed out.
//
// Buttons, not a select and not a text field. The reason must be a closed member (an approver's free text would
// describe the customer's data and it rides into the sealed pack), and a picker whose members are buttons cannot
// be left empty, which is the whole failure the gap names: a rejection with no reason attached to it anywhere.
function pickRejectReason(runId: string): Promise<RestoreRejectReason | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: RestoreRejectReason | null): void => {
      if (settled) return;
      settled = true;
      handle.close();
      resolve(v);
    };

    const body = h("div", { style: "display:grid;gap:var(--space-3)" });
    body.appendChild(
      h("p", { class: "measure" }, `Reject the restore of run ${runId}? Choose the reason. The requester sees it, and it is recorded against the request.`),
    );
    const list = h("div", { style: "display:grid;gap:var(--space-2)" });
    for (const reason of RESTORE_REJECT_REASONS) {
      const copy = RESTORE_REJECT_REASON_COPY[reason];
      const btn = h(
        "button",
        { "data-dp": "restore-flow.button.finish#1", class: "btn btn--secondary", type: "button", style: "justify-content:flex-start;text-align:left" },
        copy.label,
      ) as HTMLButtonElement;
      btn.addEventListener("click", () => finish(reason));
      list.appendChild(btn);
    }
    body.appendChild(list);

    const cancelBtn = h("button", { "data-dp": "restore-flow.button.cancel#1", class: "btn btn--ghost", type: "button" }, "Cancel") as HTMLButtonElement;
    cancelBtn.addEventListener("click", () => finish(null));
    const footer = h("div", { class: "dialog__actions" }, cancelBtn);
    const { surface } = dialogSurface({ variant: "modal", title: "Reject restore", body, footer, onCloseClick: () => finish(null) });
    // onClose fires on ANY dismissal (Escape, the backdrop, the close cross), so backing out of the picker can
    // never resolve to a silent rejection with no reason: it resolves to null and no request is made.
    const handle = openOverlay({ surface, variant: "modal", dismissable: true, onClose: () => finish(null), initialFocus: cancelBtn });
  });
}
