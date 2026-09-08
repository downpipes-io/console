// Restore: the whole-account BATCH restore queue (/restore/batch): "recover my whole account in one sitting". By design, this batches
// the UI ONLY. It is a sequencer/queue over the EXISTING per-run dry-run -> request -> approve -> apply
// APIs (POST /admin/restore, /restore/request, /restore/approve, and GET /restore/approvals) -- there is
// no bulkRestore route and this file adds none. EACH row keeps its OWN planHash and its OWN independent
// second-approver approval; nothing here creates a single approval that covers many runs, and nothing
// weakens maker != checker (findUsableApproval, shared.ts) or the per-planHash guarantee the single-run
// confirm gate already enforces. A shared poll only READS the approvals list once per tick and matches
// each row against its own distinct planHash -- see pollTick below for the proof this stays per-run.
//
// Scope, deliberately narrow (do not over-promise): each row restores that downpipe's LATEST run to its
// ORIGINAL bindings only. No redirect, no include/exclude/max, no cf-config, no media, no D1 table-subset
// -- those advanced options stay on the single-run flow (/restore/:runId), reachable per row via "Restore
// individually". House rules: Australian English, no em dashes, no rule-of-three, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { pageHeader, canCap, capGateReason } from "../common.ts";
import { capabilityPhrase } from "../capability-copy.ts";
import { goSignedOut, navigate, caller } from "../../lib/nav.ts";
import { isUnauthorised, classifyError } from "../../lib/errors.ts";
import { blockError, sessionEnded } from "../../components/error-view.ts";
import { banner, skeletonRows } from "../../components/feedback.ts";
import { field, validateForm, type Field } from "../../components/field.ts";
import { confirmModal } from "../../components/modal.ts";
import { typeToConfirm } from "../../components/confirm.ts";
import { requireChange } from "../../components/require-change.ts";
import { toast } from "../../components/toast.ts";
import { statusWithLabel, type StatusTone } from "../../components/status.ts";
import { groupNumber, humanBytes } from "../../lib/format.ts";
import { ICON_RESTORE, ICON_CHECK, ICON_ALERT, ICON_CLOSE, ICON_REFRESH, ICON_ROLES } from "../../lib/icons.ts";
import { isRateLimited, rateLimitDelayMs, bulkFailureReason, sleep, MAX_RATE_LIMIT_RETRIES } from "../../lib/bulk-pacing.ts";
import { restorePlanHash, type EngineClient, type DownpipeState, type RestorePlan, type RestoreResult, type RestoreApproval } from "../../api.ts";
import { findUsableApproval, makeGateBlockReporter, reportPlanHashFailed, writeSummarySentence, LARGE_RESTORE_WRITES, noteApplyNotSent, noteApplyOutcome } from "./shared.ts";
import { restoreOutcome } from "./receipt.ts";

// ---- constants ----------------------------------------------------------------------------------

// The shared approvals-list poll cadence, matching the pending-approvals inbox (approvals.ts) so an
// operator watching both screens sees the same responsiveness.
const BATCH_POLL_MS = 15_000;
// A bounded worker pool for the initial dry-run pass (mirrors table.ts's fillFreshness FRESHNESS_CONCURRENCY):
// a large batch must not fire one dry-run per downpipe simultaneously and storm the scheduler / trip the
// per-caller rate limit. Each dry-run is read-only (writes nothing), so this is about pacing, not safety.
const BATCH_DRY_RUN_CONCURRENCY = 3;

// ---- row state machine ---------------------------------------------------------------------------
// Each row moves strictly forward through its OWN phases; nothing here ever reads or writes another
// row's state. "blocked" and "apply-failed" are honest terminal-with-retry states, never silently hidden.
type RowPhase =
  | "blocked" // no runId to restore from, the downpipe no longer exists, or the dry-run reported ok:false
  | "planning" // the dry-run is in flight
  | "planned" // a usable dry-run plan exists; ready to request approval
  | "requesting" // the approval request is in flight
  | "awaiting-approval" // the request was raised; the shared poll below watches for a distinct approver's signature
  | "approved" // a usable approval (maker != checker) was found for THIS row's planHash; ready to apply
  | "applying" // the apply is in flight
  | "applied" // the apply completed (see result.ok / failures for the honest outcome)
  | "apply-failed"; // the apply threw, or raced a consumed/expired approval

interface BatchRow {
  downpipeId: string;
  downpipeName: string;
  runId: string | null;
  phase: RowPhase;
  plan?: RestorePlan;
  // planHash is computed client-side the SAME way the single-run flow does (helpers.ts restorePlanHash),
  // over {runId} alone (batch mode never sets target/include/exclude/recordName/cfConfig/mediaRestore/
  // d1Tables), so it is deterministic from runId and DIFFERENT for every row (two rows never collide
  // unless they somehow shared a runId, which cannot happen -- a runId belongs to exactly one downpipe).
  planHash: string | null;
  approval?: RestoreApproval;
  result?: RestoreResult;
  blockedReason?: string;
  applyFailedReason?: string;
  el: HTMLElement;
}

// parseIds reads the comma-joined ?ids= query param (built by the Downpipes bulk bar's "Restore..."
// action, table.ts), deduped and order-preserving. Malformed or empty input yields an empty list, which
// renderBatchQueue reports as an honest "nothing selected" state rather than guessing.
function parseIds(query: URLSearchParams): string[] {
  const raw = query.get("ids") ?? "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id !== "" && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// buildBatchUrl is the single place the ?ids= query is assembled, so the entry point (table.ts) and this
// screen agree on the exact encoding (URLSearchParams handles any characters an id could carry).
export function buildBatchUrl(downpipeIds: string[]): string {
  return `/restore/batch?${new URLSearchParams({ ids: downpipeIds.join(",") }).toString()}`;
}

// ---- entry point ----------------------------------------------------------------------------------

export function renderBatchQueue(engine: EngineClient, query: URLSearchParams): HTMLElement {
  const root = h("div");
  root.appendChild(
    pageHeader(
      "Batch restore",
      "Restore several downpipes' latest runs in one sitting. Each row runs its own dry-run, its own dual-control request and its own approval; approving one row never arms another. Every row restores to its original bindings -- for a redirect, a single record or another advanced option, restore that downpipe individually.",
      undefined,
      { label: "Restore", to: "/restore" },
    ),
  );

  const ids = parseIds(query);
  if (ids.length === 0) {
    root.appendChild(
      banner({
        tone: "info",
        message: 'No downpipes were selected. From the Downpipes list, select some rows, then choose "Restore..." in the bulk bar to start a batch.',
      }),
    );
    return root;
  }

  const region = h("div", { class: "async-region" });
  region.appendChild(skeletonRows(Math.min(ids.length, 6)));
  root.appendChild(region);

  const load = (): void => {
    region.replaceChildren(skeletonRows(Math.min(ids.length, 6)));
    void resolveSeeds(engine, ids)
      .then((seeds) => region.replaceChildren(renderQueue(engine, seeds)))
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the batch queue is a skeleton until this replaces it.
          region.replaceChildren(sessionEnded(load));
          return goSignedOut();
        }
        region.replaceChildren(blockError(err, load, { origin: location.origin }));
      });
  };
  load();

  return root;
}

interface Seed { downpipeId: string; downpipeName: string; runId: string | null; missing: boolean }

// resolveSeeds reads the fleet ONCE (engine.listDownpipes) and resolves each selected id to its name and
// latest run id, in the order the operator selected them. An id no longer in the fleet (deleted between
// selection and arriving here) resolves honestly as missing, rather than silently dropped.
async function resolveSeeds(engine: EngineClient, ids: string[]): Promise<Seed[]> {
  const states = await engine.listDownpipes();
  const byId = new Map<string, DownpipeState>(states.map((s) => [s.config.id, s] as const));
  return ids.map((id) => {
    const s = byId.get(id);
    return s
      ? { downpipeId: id, downpipeName: s.config.name, runId: s.lastRunId, missing: false }
      : { downpipeId: id, downpipeName: id, runId: null, missing: true };
  });
}

// QueueCtx groups the collaborators every row action needs, so row builders take one object rather than
// six positional parameters.
interface QueueCtx {
  engine: EngineClient;
  me: string | null;
  reasonField: Field;
  summaryEl: HTMLElement;
  rows: BatchRow[];
  repaintSummary: () => void;
  // noteGateBlock is the queue's per-class latched reporter for a row whose Apply did not arm. It lives
  // on the context so every row in ONE queue shares one latch: the approval sweep re-runs every few seconds, and
  // a count that grew with the polling would say nothing about how many restores were actually blocked.
  noteGateBlock: ReturnType<typeof makeGateBlockReporter>;
}

function renderQueue(engine: EngineClient, seeds: Seed[]): HTMLElement {
  const wrap = h("div", { class: "stack" });

  // A row with a real runId starts "planning" (the dry-run pool below picks it up immediately); a row
  // with no runId to plan from (a missing downpipe, or one with no completed run yet) starts "blocked"
  // with the reason stated up front, never a silent gap.
  const rows: BatchRow[] = seeds.map((s): BatchRow => {
    const blockedReason = s.missing
      ? "This downpipe no longer exists (it may have been deleted since you selected it)."
      : s.runId === null
        ? "No completed run yet for this downpipe. Trigger a run first, then retry here."
        : null;
    return {
      downpipeId: s.downpipeId,
      downpipeName: s.downpipeName,
      runId: s.runId,
      planHash: null,
      el: h("div", { class: "card stack-sm batch-row" }),
      phase: blockedReason !== null ? "blocked" : "planning",
      ...(blockedReason !== null ? { blockedReason } : {}),
    };
  });

  const reasonField = field({
    id: "rsb-reason",
    label: "Reason for this batch",
    required: true,
    kind: "textarea",
    placeholder: "Bulk restore of staging KV after the failed deploy",
    hint: "Recorded on each individual request's audit trail. Not a secret. Fill this in before requesting approval, individually or for all planned rows at once.",
    doc: { href: "https://docs.downpipes.io/recovery/dual-control" },
  });

  const summaryEl = h("p", { class: "field__hint", role: "status" });
  const ctx: QueueCtx = {
    engine,
    me: caller()?.email ?? null,
    reasonField,
    summaryEl,
    rows,
    repaintSummary: () => repaintSummary(ctx),
    noteGateBlock: makeGateBlockReporter(),
  };

  const listEl = h("div", { class: "stack" });
  for (const row of rows) listEl.appendChild(row.el);
  for (const row of rows) paintRow(row, ctx);
  repaintSummary(ctx);

  const requestAllBtn = h(
    "button",
    { "data-dp": "restore-flow.button.request-all", class: "btn btn--secondary", type: "button" },
    svgIcon(ICON_ROLES, { size: 14 }),
    "Request approval for all planned rows",
  ) as HTMLButtonElement;
  requestAllBtn.addEventListener("click", () => void requestAllPlanned(ctx, requestAllBtn));

  // The "request approval for all planned rows" button raises one dual-control request per row, so it
  // gates on the capability those requests hit: restore.request (engine gate(caller, "restore.request")
  // at router-restore.ts, held by Operator, Restore operator, Approver and Owner). Gating by CAPABILITY,
  // not the cumulative role rank, matters because a restore-operator sits off the rank ladder yet
  // holds restore.request, so the old canDo("operator") rank check hid the request path from the
  // recovery-only role the engine accepts. A caller without restore.request (a Viewer, an Access-admin)
  // still sees only the summary.
  const controls = h(
    "div",
    { class: "card form-stack" },
    reasonField.el,
    canCap("restore.request")
      ? h("div", { style: "display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap" }, requestAllBtn, summaryEl)
      : summaryEl,
  );

  wrap.appendChild(controls);
  wrap.appendChild(listEl);

  startBatchPoll(wrap, ctx);
  void runDryRunPool(ctx);

  return wrap;
}

// repaintSummary shows one calm status line (never a multi-tile dashboard, per the calm-density budget):
// how many of each phase, worst-first, so the operator sees progress at a glance without extra chrome.
function repaintSummary(ctx: QueueCtx): void {
  const counts = new Map<RowPhase, number>();
  for (const r of ctx.rows) counts.set(r.phase, (counts.get(r.phase) ?? 0) + 1);
  const order: RowPhase[] = ["blocked", "apply-failed", "planning", "planned", "requesting", "awaiting-approval", "approved", "applying", "applied"];
  const labels: Record<RowPhase, string> = {
    blocked: "blocked",
    "apply-failed": "apply failed",
    planning: "building plans",
    planned: "planned",
    requesting: "requesting",
    "awaiting-approval": "awaiting approval",
    approved: "ready to apply",
    applying: "applying",
    applied: "applied",
  };
  const parts = order.filter((p) => (counts.get(p) ?? 0) > 0).map((p) => `${counts.get(p)} ${labels[p]}`);
  ctx.summaryEl.textContent = `${ctx.rows.length} downpipe${ctx.rows.length === 1 ? "" : "s"} in this batch: ${parts.join(", ")}.`;
}

// ---- the dry-run pool (bounded concurrency, mirrors table.ts fillFreshness) ------------------------

async function runDryRunPool(ctx: QueueCtx): Promise<void> {
  const pending = ctx.rows.filter((r) => r.phase === "planning");
  let cursor = 0;
  let unauth = false;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length && !unauth) {
      const row = pending[cursor++]!;
      const outcome = await dryRunOne(ctx.engine, row);
      if (outcome === "signed-out") { unauth = true; break; }
      paintRow(row, ctx);
      ctx.repaintSummary();
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCH_DRY_RUN_CONCURRENCY, pending.length) }, () => worker()));
  if (unauth) goSignedOut();
}

// dryRunOne runs ONE row's dry-run (read-only) with the SAME 429 pacing/retry the other bulk loops use
// (lib/bulk-pacing.ts), then updates the row's phase/plan/planHash in place (paint is the caller's job,
// so the pool above can batch it identically to every other outcome).
async function dryRunOne(engine: EngineClient, row: BatchRow): Promise<"ok" | "signed-out"> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    try {
      // CHANGE UNRECORDED: the request omits confirm, so this is the read-only dry-run leg of the multiplexed
      // POST /restore. The engine writes nothing and records no config mutation, so demanding a change number
      // here would interrupt the operator for a read, once per row of the batch. applyRowClick collects one.
      const res = await engine.restore({ runId: row.runId! });
      if (res.mode !== "dry-run") {
        row.phase = "blocked";
        row.blockedReason = "The engine did not return a dry-run plan.";
        return "ok";
      }
      if (!res.ok) {
        row.phase = "blocked";
        row.blockedReason = res.reason ?? "The engine could not build a plan for this run.";
        return "ok";
      }
      row.plan = res;
      // The same swallowed plan-hash failure as the single-run flow, and the same consequence. A null hash
      // here means this row's Apply can never arm, whoever approves it. The catch records the class and keeps the
      // null (the row still plans, and the engine remains the authority); the throw itself is never read.
      row.planHash = await restorePlanHash({ runId: row.runId! }).catch(() => {
        // The SHARED latch, for the same reason as the single-run flow: checkApprovals re-observes this null hash
        // for this row on every poll, so one blocked row must contribute one row and not one per notice.
        reportPlanHashFailed(row.runId ?? null);
        return null;
      });
      row.phase = "planned";
      return "ok";
    } catch (err) {
      if (isUnauthorised(err)) return "signed-out";
      lastErr = err;
      if (isRateLimited(err) && attempt < MAX_RATE_LIMIT_RETRIES) {
        await sleep(rateLimitDelayMs(err));
        continue;
      }
      break;
    }
  }
  row.phase = "blocked";
  row.blockedReason = bulkFailureReason(lastErr);
  return "ok";
}

function retryDryRun(row: BatchRow, ctx: QueueCtx): void {
  row.phase = "planning";
  paintRow(row, ctx);
  void dryRunOne(ctx.engine, row).then((outcome) => {
    if (outcome === "signed-out") return goSignedOut();
    paintRow(row, ctx);
    ctx.repaintSummary();
  });
}

// ---- requesting approval (per row, and the "request all planned" convenience) ----------------------
// requestAllPlanned is the batch-queue analogue of bulkTrigger/bulkDisable/bulkDelete
// (sources-downpipes/detail-actions.ts): it fires N INDEPENDENT requestRestore calls, one per planned
// row, each producing its OWN approval record bound to its OWN planHash. This is a UI convenience over
// clicking "Request approval" N times, exactly as bulkTrigger is a convenience over N individual trigger
// clicks -- it does not create, and could not create, a single approval spanning multiple runs (each
// call's body carries exactly one runId and the engine mints exactly one approval record per call).

async function requestAllPlanned(ctx: QueueCtx, btn: HTMLButtonElement): Promise<void> {
  if (!validateForm([ctx.reasonField])) return;
  const targets = ctx.rows.filter((r) => r.phase === "planned");
  if (targets.length === 0) {
    toast({ message: "No rows are ready to request (build a plan first, or check for blocked rows)." });
    return;
  }
  btn.disabled = true;
  btn.dataset.busy = "true";
  let unauth = false;
  let done = 0;
  for (const row of targets) {
    if (unauth) break;
    const outcome = await requestOne(ctx.engine, row, ctx.reasonField.value());
    if (outcome === "signed-out") { unauth = true; break; }
    paintRow(row, ctx);
    ctx.repaintSummary();
    if (row.phase === "awaiting-approval") done++;
  }
  btn.disabled = false;
  btn.dataset.busy = "false";
  if (unauth) return goSignedOut();
  toast({ message: `Requested approval for ${done} of ${targets.length} row${targets.length === 1 ? "" : "s"}.` });
  // Fast feedback: one immediate sweep in case any of these already has a usable approval
  // (e.g. a distinct approver acted between the dry-run and this click), rather than making
  // every freshly-requested row wait for the next periodic sweep.
  if (await checkApprovals(ctx) === "signed-out") goSignedOut();
}

async function requestRowClick(row: BatchRow, ctx: QueueCtx): Promise<void> {
  if (!validateForm([ctx.reasonField])) return;
  row.phase = "requesting";
  paintRow(row, ctx);
  const outcome = await requestOne(ctx.engine, row, ctx.reasonField.value());
  if (outcome === "signed-out") return goSignedOut();
  paintRow(row, ctx);
  ctx.repaintSummary();
  // Fast feedback (see requestAllPlanned): one immediate sweep for this row's own planHash.
  if (await checkApprovals(ctx) === "signed-out") goSignedOut();
}

// requestOne raises ONE row's dual-control request. The body carries ONLY this row's runId + reason +
// this row's OWN recomputed blast-radius cues (isLatest/plannedWrites/bytes from ITS dry-run plan) --
// never another row's data, never a list of runs. The engine mints one RestoreApproval keyed to this
// row's planHash alone (approvals.ts restorePlanHash, engine-side), exactly as a single-run request would.
async function requestOne(engine: EngineClient, row: BatchRow, reason: string): Promise<"ok" | "signed-out"> {
  if (!row.plan || row.runId === null) {
    row.phase = "blocked";
    row.blockedReason = "No plan to request approval for.";
    return "ok";
  }
  try {
    const record = await engine.requestRestore({
      runId: row.runId,
      reason,
      isLatest: row.plan.isLatest,
      ...(row.plan.plannedWrites > 0 ? { plannedWrites: row.plan.plannedWrites } : {}),
      ...(row.plan.bytes > 0 ? { bytes: row.plan.bytes } : {}),
    });
    row.approval = record;
    row.phase = "awaiting-approval";
    return "ok";
  } catch (err) {
    if (isUnauthorised(err)) return "signed-out";
    row.phase = "planned"; // the plan is still valid; only the request attempt failed
    toast({ message: `Could not request approval for ${row.downpipeName} (${bulkFailureReason(err)}).`, tone: "warn" });
    return "ok";
  }
}

// ---- the shared approvals check: reads ONCE per sweep, matches EACH row against its OWN planHash -------
// This is the crux of the safety property the owner decision demands: checkApprovals calls
// listApprovals() ONE time (a read, never a control), then for every row still waiting it calls
// findUsableApproval (shared.ts, the SAME maker != checker mirror the single-run confirm gate uses) with
// THAT row's own distinct planHash. Two rows never share a planHash (each is a hash over a distinct
// runId), so a distinct approver signing row A's request can only ever satisfy
// findUsableApproval(records, A's hash, me) -- it structurally cannot satisfy row B's lookup, whose
// planHash argument differs. Nothing here aggregates statuses, counts approvals toward a threshold, or
// treats "some rows approved" as "the batch is approved": each row's Apply enables strictly on its own
// findUsableApproval result. Called both immediately after a row is requested (requestRowClick /
// requestAllPlanned, for fast feedback) and on the periodic sweep below (startBatchPoll, for an approval
// that arrives later from a distinct approver acting in their own time).
async function checkApprovals(ctx: QueueCtx): Promise<"ok" | "signed-out"> {
  const waiting = ctx.rows.filter((r) => r.phase === "requesting" || r.phase === "awaiting-approval");
  if (waiting.length === 0) return "ok";
  try {
    const records = await ctx.engine.listApprovals();
    for (const row of waiting) {
      const usable = findUsableApproval(records, row.planHash, ctx.me);
      // A row whose Apply will not arm says WHY, per row and once per class (the sweep below re-enters
      // here every few seconds for as long as the operator leaves the queue open). A row genuinely waiting for
      // its approver records nothing: that is the ceremony working.
      if (!usable) ctx.noteGateBlock(records, row.planHash, ctx.me, row.runId);
      if (usable) {
        row.approval = usable;
        row.phase = "approved";
        paintRow(row, ctx);
      }
    }
    ctx.repaintSummary();
    return "ok";
  } catch (err) {
    if (isUnauthorised(err)) return "signed-out";
    return "ok"; // a transient fault leaves every row's state untouched; the next sweep tries again
  }
}

// startBatchPoll mirrors approvals.ts's startApprovalsPoll exactly: a plain setInterval that stops
// itself once `root` leaves the document (navigated away), so no explicit teardown call is needed.
function startBatchPoll(root: HTMLElement, ctx: QueueCtx): void {
  const timer = window.setInterval(() => {
    if (!root.isConnected) { window.clearInterval(timer); return; }
    void checkApprovals(ctx).then((outcome) => {
      if (outcome === "signed-out") { window.clearInterval(timer); goSignedOut(); }
    });
  }, BATCH_POLL_MS);
}

// ---- applying (strictly per row, never bulk -- the owner's critical safety boundary) -----------------
// There is deliberately NO "apply all approved" button. Apply is the highest-consequence action in the
// console; every click here is its own deliberate decision, gated on THIS row's own usable approval,
// with its own confirm friction calibrated to ITS OWN plan (large / non-latest), exactly mirroring
// confirm.ts's applyRestore for a single run. Batch mode never redirects, so the type-to-confirm match
// value is always the run id (never a target binding).

async function confirmRowApply(row: BatchRow): Promise<boolean> {
  const plan = row.plan!;
  const isLarge = plan.plannedWrites >= LARGE_RESTORE_WRITES;
  const isNonLatest = plan.isLatest === false;
  const oneSentence = writeSummarySentence(plan, { runId: row.runId! });
  if (isLarge || isNonLatest) {
    const extra: Node[] = [];
    if (isNonLatest) extra.push(h("p", { class: "field__hint" }, "This is not the latest run; it restores older data over current data."));
    extra.push(h("p", { class: "field__hint" }, "A cancel stops further writes but does not undo records already written; the engine does not roll back."));
    // THE CEREMONY, named before the button rather than discovered after it. Each row in this queue is its
    // own apply, and the engine gates every one of them (requireStepUp inside the confirm:true branch of
    // POST /restore), so an operator working down a queue can meet the prompt on any row.
    extra.push(h("p", { class: "field__hint" }, "You may be asked to confirm with your own passkey before this row starts restoring. If you dismiss that prompt, or it fails, nothing is written for this row and the rest of the queue is untouched."));
    return typeToConfirm({
      title: `Apply restore: ${row.downpipeName}`,
      impactSentence: oneSentence,
      extra,
      matchValue: row.runId!,
      matchLabel: "run id",
      confirmLabel: "Apply restore",
      busyLabel: "Restoring",
    });
  }
  return confirmModal({
    title: `Apply restore: ${row.downpipeName}`,
    body: h(
      "div",
      h("p", { style: "color:var(--text)" }, oneSentence),
      h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "A cancel stops further writes but does not undo records already written."),
      // Both branches carry it: a customer only ever sees one of them, and which one is decided by the size
      // of the run in that row.
      h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "You may be asked to confirm with your own passkey before this row starts restoring. If you dismiss that prompt, or it fails, nothing is written for this row and the rest of the queue is untouched."),
    ),
    confirmLabel: "Apply restore",
    variant: "danger",
    busyLabel: "Restoring",
  });
}

async function applyRowClick(row: BatchRow, ctx: QueueCtx): Promise<void> {
  if (!row.plan || row.runId === null) return;
  const confirmed = await confirmRowApply(row);
  if (!confirmed) return;

  const cr = await requireChange(ctx.engine, `Apply this restore (${row.downpipeName})`, "restore-apply");
  if (!cr.proceed) return;

  row.phase = "applying";
  paintRow(row, ctx);
  try {
    const res = await ctx.engine.restore({ runId: row.runId, confirm: true }, cr.change ?? undefined);
    // The queue applies for real, one live write per row, and recorded nothing at all. It now records
    // the SAME apply-outcome row the single-run confirm records, through the same emit, so a queue row that
    // reported success and wrote nothing is as visible in the pack as a single apply that did.
    noteApplyOutcome(res);
    if (res.mode !== "applied") {
      row.phase = "apply-failed";
      row.applyFailedReason = "The engine did not return an apply result.";
      paintRow(row, ctx);
      return;
    }
    row.result = res;
    row.phase = "applied";
    paintRow(row, ctx);
  } catch (err) {
    // This apply POST fired and did not come back, so whether the engine wrote is unknown here too.
    noteApplyNotSent();
    if (isUnauthorised(err)) return goSignedOut();
    const kind = classifyError(err, { origin: location.origin });
    if (kind.kind === "restore-unapproved") {
      // A race: the approval was consumed/rejected/expired between arming and this click. Sending the row
      // back to "planned" would be wrong (a fresh plan is not needed; the SAME plan still stands), so it
      // goes back to "awaiting-approval" instead, re-entering the poll for a fresh approval, honestly.
      row.phase = "awaiting-approval";
      delete row.approval;
      // THE SAME SIX CAUSES ARRIVE HERE AS THE SAME FLAT 403, and this row said the same wrong thing about
      // them as the single-run gate did. classifyRestoreApplyRefusal (engine/src/admin/approvals.ts) tells
      // expired, consumed, applying-lease, pending, self-approval and missing-approver apart;
      // router-restore answers all six with { error: "restore not approved" }. "A distinct approver must
      // sign it again" is the remedy for ONE of them, and for a CONSUMED approval it is an instruction to
      // run the same restore a second time, on the surface that applies rows in a batch. Repaired here
      // beside the single-run gate rather than left as its unrepaired sibling, on the same reasoning and
      // against the same engine fact; the single-run path was the one another pass drove, and this one
      // is a code-identical twin recorded as not yet applied.
      toast({ message: `${row.downpipeName}: the engine refused this apply on the approval. It may already have been used, in which case this restore has already run. Check this run before applying it again.`, tone: "warn" });
    } else {
      row.phase = "apply-failed";
      // The apply POST fired and did not come back (the comment above noteApplyNotSent says so), so this row
      // cannot say the write did not happen, only that it cannot tell. bulkFailureReason describes the
      // TRANSPORT, which is right for every read in this queue and is the wrong half of the story for the
      // one call that writes.
      row.applyFailedReason = `${bulkFailureReason(err)} The apply was sent and its response did not arrive, so whether the engine wrote anything is unknown. Check this run before applying it again.`;
    }
    paintRow(row, ctx);
  }
  ctx.repaintSummary();
}

// ---- row rendering ----------------------------------------------------------------------------------

// statusTone reads the row's outcome, not just its phase, for "applied": the apply CALL succeeding
// (phase "applied") is not the same fact as the RESULT being clean (restoreOutcome, the same classifier
// the single-run receipt uses) -- a partial or failed apply must not read as a plain "ok" badge.
function statusTone(row: BatchRow): StatusTone {
  switch (row.phase) {
    case "blocked":
    case "apply-failed":
      return "danger";
    case "applied": {
      const kind = restoreOutcome(row.result!).kind;
      // Every non-clean kind used to land on danger, so a restore that wrote every record and merely lost
      // a TTL showed the same alarm as one that failed outright. Each kind is now named explicitly, and
      // only a genuine failure is danger.
      //
      // "skipped" arrived from the other side of this merge with the same fall-through: a restore that
      // deliberately did not write a secrets record (there is no runtime write path for one) reported
      // "Applied with failures" in red, which is both wrong and the exact reading that sends someone
      // hunting for a fault that does not exist. Nothing failed; some records are outstanding.
      // A SWITCH rather than an if-chain, so the compiler is what catches the next kind. Both times a kind
      // was added to RestoreOutcomeKind it landed on the wrong branch here and nothing complained, because
      // a fall-through is a valid program. `never` makes the omission a type error instead.
      switch (kind) {
        case "clean":
          return "ok";
        case "windowed":
        case "skipped":
        case "reduced":
          return "warn";
        case "failed":
          return "danger";
        default: {
          const exhaustive: never = kind;
          return exhaustive;
        }
      }
    }
    case "approved":
      return "ok";
    case "planning":
    case "requesting":
      return "info";
    default:
      return "neutral";
  }
}

function statusLabel(row: BatchRow): string {
  if (row.phase === "applied") {
    const kind = restoreOutcome(row.result!).kind;
    // Exhaustive for the same reason as statusTone above: the label is where a missed kind reads as a
    // confident wrong sentence rather than a blank.
    switch (kind) {
      case "clean":
        return "Applied";
      case "windowed":
        return "Applied (windowed)";
      case "skipped":
        return "Applied (records outstanding)";
      case "reduced":
        return "Applied (reduced fidelity)";
      case "failed":
        return "Applied with failures";
      default: {
        const exhaustive: never = kind;
        return exhaustive;
      }
    }
  }
  return PHASE_LABEL[row.phase];
}

const PHASE_LABEL: Record<RowPhase, string> = {
  blocked: "Blocked",
  planning: "Building plan",
  planned: "Plan ready",
  requesting: "Requesting",
  "awaiting-approval": "Awaiting approval",
  approved: "Approved, ready to apply",
  applying: "Applying",
  applied: "Applied",
  "apply-failed": "Apply failed",
};

// paintRow rebuilds ONE row's contents from its current phase (never the whole list, so an unrelated
// row's focus/scroll position is undisturbed). data-phase / data-plan-hash are inert hooks (no
// behaviour) that let a test assert per-row phase and prove two rows never share a plan hash.
function paintRow(row: BatchRow, ctx: QueueCtx): void {
  row.el.dataset.phase = row.phase;
  row.el.dataset.downpipeId = row.downpipeId;
  row.el.dataset.planHash = row.planHash ?? "";

  const removeBtn = h(
    "button",
    { "data-dp": "restore-flow.button.remove", class: "btn btn--ghost btn--sm", type: "button", "aria-label": `Remove ${row.downpipeName} from this batch` },
    svgIcon(ICON_CLOSE, { size: 14 }),
  );
  removeBtn.addEventListener("click", () => {
    ctx.rows.splice(ctx.rows.indexOf(row), 1);
    row.el.remove();
    ctx.repaintSummary();
  });

  const head = h(
    "div",
    { style: "display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);flex-wrap:wrap" },
    h("span", { style: "display:grid;gap:2px" }, h("span", { style: "font-weight:var(--weight-semibold)" }, row.downpipeName), h("span", { class: "mono field__hint" }, row.downpipeId)),
    h("span", { style: "display:flex;align-items:center;gap:var(--space-2)" }, statusWithLabel(statusTone(row), statusLabel(row)), removeBtn),
  );
  row.el.replaceChildren(head);
  row.el.appendChild(rowBody(row, ctx));
}

function rowBody(row: BatchRow, ctx: QueueCtx): HTMLElement {
  const body = h("div", { class: "stack-sm" });
  switch (row.phase) {
    case "blocked": {
      body.appendChild(h("p", { class: "field__hint" }, row.blockedReason ?? "This row cannot be planned."));
      if (row.runId !== null) {
        const retryBtn = h("button", { "data-dp": "restore-flow.button.retry", class: "btn btn--secondary btn--sm", type: "button" }, svgIcon(ICON_REFRESH, { size: 13 }), "Retry");
        retryBtn.addEventListener("click", () => retryDryRun(row, ctx));
        body.appendChild(retryBtn);
      }
      return body;
    }
    case "planning": {
      body.appendChild(h("p", { class: "field__hint" }, "Verifying the run. Nothing is being written."));
      return body;
    }
    case "planned":
    case "requesting":
    case "awaiting-approval":
    case "approved": {
      if (row.plan) body.appendChild(planSummaryLine(row.plan));
      if (row.planHash) body.appendChild(planHashLine(row.planHash));
      if (row.phase === "planned") {
        // Raising this row's request hits restore.request (POST /admin/restore/request), so it gates on
        // that capability, not the role rank. A restore-operator holds restore.request and now sees the
        // button; a Viewer or Access-admin (neither holds it) still gets the read-only note.
        if (canCap("restore.request")) {
          const btn = h("button", { "data-dp": "restore-flow.button.row-body", class: "btn btn--secondary btn--sm", type: "button" }, "Request approval") as HTMLButtonElement;
          btn.addEventListener("click", () => void requestRowClick(row, ctx));
          body.appendChild(btn);
        } else {
          body.appendChild(h("p", { class: "field__hint" }, `Requesting approval requires ${capabilityPhrase("restore.request")}. ${capGateReason("restore.request")}`));
        }
      } else if (row.phase === "requesting") {
        body.appendChild(h("p", { class: "field__hint" }, "Raising the request…"));
      } else if (row.phase === "awaiting-approval") {
        body.appendChild(
          h(
            "p",
            { class: "field__hint" },
            "Awaiting a distinct approver. ",
            h("button", { "data-dp": "restore-flow.button.navigate-restore-approvals#2", class: "linklike", type: "button", on: { click: () => navigate("/restore/approvals") } }, "Open the approvals inbox"),
            ".",
          ),
        );
      } else if (row.phase === "approved") {
        // Applying hits restore.apply (POST /admin/restore with confirm, engine gate(caller,
        // "restore.apply")), held by Restore operator, Approver and Owner. Gating by that capability
        // rather than the approver rank matters because a restore-operator holds restore.apply and now
        // sees Apply once a distinct approver signs; an Operator (holds restore.request but not
        // restore.apply) still gets the read-only note, exactly as the engine refuses its apply.
        if (canCap("restore.apply")) {
          const applyBtn = h("button", { "data-dp": "restore-flow.button.apply#1", class: "btn btn--danger btn--sm", type: "button" }, svgIcon(ICON_RESTORE, { size: 13 }), "Apply") as HTMLButtonElement;
          applyBtn.addEventListener("click", () => void applyRowClick(row, ctx));
          body.appendChild(h("p", { class: "field__hint" }, `Approved by ${row.approval?.approvedBy ?? "a distinct approver"}.`));
          body.appendChild(applyBtn);
        } else {
          body.appendChild(h("p", { class: "field__hint" }, `Approved; applying requires ${capabilityPhrase("restore.apply")}. ${capGateReason("restore.apply")}`));
        }
      }
      body.appendChild(individualLink(row));
      return body;
    }
    case "applying": {
      body.appendChild(h("p", { class: "field__hint" }, "Restoring…"));
      return body;
    }
    case "applied": {
      const res = row.result!;
      const outcome = restoreOutcome(res);
      body.appendChild(
        h(
          "p",
          { class: "field__hint" },
          svgIcon(outcome.partial ? ICON_ALERT : ICON_CHECK, { size: 13 }),
          ` ${outcome.title}: ${groupNumber(res.recordsRestored)} of ${groupNumber(res.recordsVerified)} records, ${humanBytes(res.bytesRestored)} written.`,
        ),
      );
      const viewBtn = h("button", { "data-dp": "restore-flow.button.view", class: "btn btn--secondary btn--sm", type: "button" }, "View run");
      viewBtn.addEventListener("click", () => navigate(`/restore/${encodeURIComponent(row.runId ?? "")}`));
      body.appendChild(viewBtn);
      return body;
    }
    case "apply-failed": {
      body.appendChild(banner({ tone: "danger", message: row.applyFailedReason ?? "The apply failed." }));
      body.appendChild(individualLink(row));
      return body;
    }
    default:
      return body;
  }
}

function planSummaryLine(plan: RestorePlan): HTMLElement {
  return h(
    "p",
    { class: "field__hint" },
    `${groupNumber(plan.plannedWrites)} record${plan.plannedWrites === 1 ? "" : "s"} to write, ${humanBytes(plan.bytes)}${plan.isLatest ? "" : " (an older run, not the latest)"}.`,
  );
}

function planHashLine(planHash: string): HTMLElement {
  return h("p", { class: "field__hint mono", title: planHash }, `Plan ${planHash.slice(0, 20)}…`);
}

// individualLink is the escape hatch to the full single-run flow (redirect target, a single record,
// cf-config, media, D1 table-subset) that this deliberately simple queue does not offer.
function individualLink(row: BatchRow): HTMLElement {
  const btn = h("button", { "data-dp": "restore-flow.button.navigate#1", class: "linklike", type: "button" }, "Restore this one individually, with advanced options");
  btn.addEventListener("click", () => navigate(`/restore/${encodeURIComponent(row.runId ?? "")}`));
  return h("p", { class: "field__hint" }, btn);
}
