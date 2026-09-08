// The per-downpipe and bulk actions (flow.md G/H/I) for the downpipe detail drawer and
// the bulk bar: run-now / drill / enable / delete, plus the honest partial-success bulk
// operations and the per-item failures summary. Moved verbatim from detail.ts to keep that
// module under the structural threshold. Australian English, no em dashes, precise claims.

// openBulkSummary now lives as a shared component (reused by the fleet drill); re-exported here so
// the existing detail.ts -> sources-downpipes.ts -> tiers.ts import chain is unchanged.
import { openBulkSummary } from "../../components/bulk-summary.ts";
import { isForbidden, isUnauthorised } from "../../lib/errors.ts";
import { goSignedOut } from "../../lib/nav.ts";

export { openBulkSummary };

import type {
  Downpipe,
  DownpipeBase,
  DownpipeState,
  EngineClient,
  RunHistoryEntry,
} from "../../api.ts";
import { confirmModal } from "../../components/modal.ts";
import { toast } from "../../components/toast.ts";
import { bulkFailureReason, isRateLimited, MAX_RATE_LIMIT_RETRIES, rateLimitDelayMs, sleep } from "../../lib/bulk-pacing.ts";
import { recordBulkOutcome } from "../../lib/client-diag/ring.ts";
import type { ClientDiagBulkAction } from "../../lib/client-diag/vocab.ts";
import { groupNumber } from "../../lib/format.ts";
import { surfacePendingChange } from "../../lib/pending-change-toast.ts";
import { BILL_SHOCK_PER_RUN_THRESHOLD, errMsg } from "./helpers.ts";

// ---- per-downpipe actions ---------------------------------------------------

// runNow triggers a run (flow.md G). For a large KV source it first shows a
// cost-aware confirm; "skipped" is an expected in-flow outcome (a run is already
// in flight), not an error. After a successful trigger the drawer is closed (exactly
// like toggleEnabled) so its now-stale state does not linger.
export async function runNow(
  engine: EngineClient,
  state: DownpipeState,
  opts: { latest: RunHistoryEntry | undefined; reload: () => void; closeDrawer: () => void },
): Promise<void> {
  const { latest, reload, closeDrawer } = opts;
  const dp = state.config;
  // The cost caution at the moment of action (flow.md G step 2): KV + a KNOWN
  // per-run read count (the latest run's recordCount) above the threshold. An
  // unknown count (every freshly created downpipe) triggers immediately: warning
  // on no evidence trains click-through (the BILL_SHOCK note), and the cost line
  // teaches once the first run reports a count.
  if (dp.source.type === "kv") {
    const records = latest?.recordCount;
    if (records !== undefined && records > BILL_SHOCK_PER_RUN_THRESHOLD) {
      const ok = await confirmModal({
        title: "Run now",
        body: `This run re-reads about ${groupNumber(records)} records from ${dp.name}. KV has no change feed, so each run reads every record. Continue?`,
        confirmLabel: "Run now",
        busyLabel: "Starting",
      });
      if (!ok) return;
    }
  }
  try {
    const res = await engine.trigger(dp.id);
    if ("skipped" in res) {
      toast({ message: `A run is already in progress for ${dp.name}; this trigger was skipped.`, tone: "info" });
    } else {
      toast({ message: `Run started for ${dp.name} (${res.runId}).` });
      // A run is now in flight, so the open drawer's status strip and badges are stale;
      // close it (toggleEnabled does the same) and let reload refresh the list.
      closeDrawer();
    }
    reload();
  } catch (err) {
    if (isUnauthorised(err)) return goSignedOut();
    toast({ message: `Could not start a run. ${errMsg(err)}`, tone: "warn" });
  }
}

// drillLatest runs an in-account drill of the latest run (an expected in-flow
// outcome model: 200 with ok:false renders inline, not an error toast).
export async function drillLatest(engine: EngineClient, state: DownpipeState): Promise<void> {
  const runId = state.lastRunId;
  if (!runId) return;
  try {
    const res = await engine.drill(runId);
    if (res.ok) toast({ message: `Drill passed for ${state.config.name}: ${groupNumber(res.recordsVerified)} records verified.` });
    else toast({ message: `Drill could not complete: ${res.reason ?? "unknown reason"}. Nothing was written.`, tone: "info" });
  } catch (err) {
    if (isUnauthorised(err)) return goSignedOut();
    // A 403 is a capability denial (drill.run): the chip should already be gated disabled-with-reason,
    // but a direct probe or a role change mid-flight can still 403. Say so plainly, not a generic fault.
    if (isForbidden(err)) {
      toast({ message: "You do not have permission to run a drill; it requires permission to run a recovery drill (an Operator, Restore operator, Approver or Owner).", tone: "info" });
      return;
    }
    toast({ message: `Could not run a drill. ${errMsg(err)}`, tone: "warn" });
  }
}

// changedApartFromEnabled names the fields on which the configuration this SCREEN loaded disagrees with
// the configuration the engine currently holds, ignoring `enabled` itself. It is a pure function and is
// exported so it can be exercised without a browser.
//
// It compares the two objects field by field on the union of their keys, by canonical JSON with sorted
// keys, so a nested schedule, retention policy or destination list is compared by VALUE and a key that
// exists on one side only counts as a difference rather than being skipped.
export function changedApartFromEnabled(pageConfig: Downpipe, liveConfig: Downpipe): string[] {
  const canonical = (v: unknown): string =>
    JSON.stringify(v, (_k, val: unknown) =>
      val !== null && typeof val === "object" && !Array.isArray(val)
        ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : val,
    ) ?? "undefined";
  const keys = new Set([...Object.keys(pageConfig), ...Object.keys(liveConfig)]);
  keys.delete("enabled");
  const moved: string[] = [];
  for (const k of [...keys].sort()) {
    if (canonical((pageConfig as unknown as Record<string, unknown>)[k]) !== canonical((liveConfig as unknown as Record<string, unknown>)[k])) moved.push(k);
  }
  return moved;
}

// toggleEnabled flips enabled from the drawer (flow.md F). Optimistic + Undo; the
// drawer is reloaded by closing it (so its stale config does not linger).
//
// ---- WHY IT READS BEFORE IT WRITES, AND REFUSES RATHER THAN NARROWING A WINDOW -----------------------
// This used to be `const next = { ...dp, enabled: !dp.enabled }` over `state.config`, THE CONFIGURATION
// THIS SCREEN LOADED, posted to `POST /admin/downpipes`, which is a WHOLE-OBJECT upsert taking no
// precondition of any kind: no ETag, no If-Match, no base version. So the spread carried this page's
// stale copy of the cadence, the schedule, the source filter, the destination list and the retention
// policy back over whatever the account was actually in, and an operator who clicked one switch reverted
// a colleague's edit to a field they never touched. Both operators were told they succeeded.
//
// Driven live: a second operator's schedule change from daily to hourly, made entirely inside this
// operator's read-to-write window of 5,340 ms, was reverted by the switch, and the toast said
// `Enabled <name>`.
// THE WINDOW IS THE LIFETIME OF AN OPEN DRAWER, so nobody has to be lucky.
//
// Re-reading and then writing would only NARROW that window, from the lifetime of a screen to one round
// trip, and a repair that narrows a window while still overwriting silently is a repair that only looks
// done. So the read is used to DECIDE rather than to refresh: if anything
// but `enabled` has moved since this screen loaded, the flip is refused and the operator is told what
// happened, which is the same thing the engine's change-control path already says when an approved change
// finds its base moved. Only the `enabled` field is then flipped, on the LIVE record.
//
// WHAT THIS USED NOT TO CLOSE, AND NOW DOES. This comment used to end "the engine-side upsert still has no
// precondition, so two saves landing inside the same round trip can still discard one of each other; that
// is a separate defect, recorded against the engine, and it is not repairable from here". Both halves have
// since landed: the engine takes a stated base on the upsert and the delete and refuses a moved one with
// 409 (engine/src/sched/downpipe-precondition.ts), and the write below states it. The round-trip window is
// closed by the engine's own read-decide-write inside the storage boundary, not by anything on this screen.
export async function toggleEnabled(engine: EngineClient, state: DownpipeState, reload: () => void, closeDrawer: () => void): Promise<void> {
  const dp = state.config;
  try {
    const live = (await engine.listDownpipes()).find((d) => d.config.id === dp.id) ?? null;
    if (live === null) {
      // Somebody deleted it while this drawer was open. Flipping a switch on a downpipe that is gone
      // would recreate it, which is the opposite of what either operator asked for.
      toast({ message: `${dp.name} was deleted while this screen was open, so the switch was not flipped.`, tone: "warn" });
      closeDrawer();
      reload();
      return;
    }
    const moved = changedApartFromEnabled(dp, live.config);
    if (moved.length > 0) {
      toast({ message: `${dp.name} changed since this screen loaded, so the switch was not flipped. ${moved.length === 1 ? "The field that changed is" : "The fields that changed are"} ${moved.join(", ")}. Reopen it to see the current configuration.`, tone: "warn" });
      closeDrawer();
      reload();
      return;
    }
    const next: Downpipe = { ...live.config, enabled: !live.config.enabled };
    // AND THE BASE IS STATED, which is what closes the half this screen could not. The check above compares
    // this screen's config to the live one and refuses a flip that would revert an edit, but it is a
    // read-then-write: an edit landing between the read on the line above and this write is still inside
    // one round trip, and until the engine had a precondition nothing could see it. `live.configRev` is
    // the revision that read returned, so if anything moved in between the engine refuses with 409 and
    // names the field, rather than both operators being told they succeeded.
    const res = await engine.addDownpipe(next, live.configRev);
    // Gate queued it: nothing changed yet, so surface the pending state (no Undo) and close the drawer so
    // its stale config does not linger; reload reflects the unchanged current state.
    if (res.status === "pending") {
      surfacePendingChange("change");
      closeDrawer();
      reload();
      return;
    }
    toast({
      message: dp.enabled ? `Disabled ${dp.name}` : `Enabled ${dp.name}`,
      action: {
        label: "Undo",
        onClick: async () => {
          try {
            // The Undo carried the SAME stale object a second time, for the same reason and with the
            // same consequence. It now flips `enabled` back on the LIVE record and touches nothing else,
            // so undoing a switch cannot revert somebody else's edit either.
            const current = (await engine.listDownpipes()).find((d) => d.config.id === dp.id) ?? null;
            if (current !== null) await engine.addDownpipe({ ...current.config, enabled: dp.enabled }, current.configRev);
            reload();
          } catch {
            /* best-effort */
          }
        },
      },
    });
    closeDrawer();
    reload();
  } catch (err) {
    if (isUnauthorised(err)) return goSignedOut();
    toast({ message: `Could not change the enabled state. ${errMsg(err)}`, tone: "warn" });
  }
}

// deleteDownpipe is the danger tier (flow.md H): the safe modal (never
// window.confirm), Disable offered as the safer default, a single confirm
// calibrated to the reversible blast radius (archives remain). A 200 deleted:false
// is reported honestly, not a fake success.
// `base` is the revision the drawer READ this downpipe at. It is stated for the same reason the save
// states one, from the other side of the same collision: before the engine had a precondition, a delete
// racing another operator's save answered {"deleted":true} while that save recreated the downpipe, enabled
// and on its cadence, so this operator was told a backup had stopped while the product went on running it.
export async function deleteDownpipe(engine: EngineClient, dp: Downpipe, reload: () => void, closeDrawer: () => void, base?: DownpipeBase): Promise<void> {
  const ok = await confirmModal({
    title: "Delete this downpipe?",
    body: `This stops scheduled backups for ${dp.name} and removes its run history. Existing archives in your destination are not deleted. You can recreate the route later.`,
    confirmLabel: "Delete downpipe",
    cancelLabel: "Cancel",
    variant: "danger",
    busyLabel: "Deleting",
  });
  if (!ok) return;
  try {
    const res = await engine.deleteDownpipe(dp.id, base);
    if (res.status === "pending") {
      // The change-control gate queued the delete for a second approver (HTTP 202). The old plain
      // parse fell into the "nothing was deleted" warning here, which read as an undeletable
      // downpipe; say the queued state honestly instead.
      closeDrawer();
      surfacePendingChange("delete");
      reload();
    } else if (res.value.deleted) {
      closeDrawer();
      toast({ message: `Deleted ${dp.name}` });
      reload();
    } else {
      // A 200 deleted:false: the entity may already be gone, so the drawer must not
      // stay open over a stale list. Say only what is known (no guessed reason).
      closeDrawer();
      toast({ message: `The engine reported nothing was deleted for ${dp.name}; the list has been refreshed.`, tone: "warn" });
      reload();
    }
  } catch (err) {
    if (isUnauthorised(err)) return goSignedOut();
    toast({ message: `Could not delete ${dp.name}. ${errMsg(err)}`, tone: "warn" });
  }
}

// ---- bulk operations (flow.md I) --------------------------------------------

// bulkTrigger triggers each selected downpipe (flow.md I). The cost-aware confirm
// summarises the count and the aggregate KV read caution; partial success is
// reported per item; an auth failure halts the batch honestly.
export async function bulkTrigger(engine: EngineClient, rows: DownpipeState[], reload: () => void): Promise<void> {
  const noun = rows.length === 1 ? "downpipe" : "downpipes";
  const kvCount = rows.filter((r) => r.config.source.type === "kv").length;
  const ok = await confirmModal({
    title: `Run ${rows.length} ${noun} now?`,
    body:
      kvCount > 0
        ? `This starts a run for ${rows.length} ${noun}. ${kvCount} ${kvCount === 1 ? "is a KV source" : "are KV sources"}; KV has no change feed, so each run reads every record. Continue?`
        : `This starts a run for ${rows.length} ${noun}. Continue?`,
    confirmLabel: "Run now",
  });
  if (!ok) return;
  await runBatch("run", rows, (r) => engine.trigger(r.config.id), "started", reload);
}

// bulkDisable disables each selected downpipe. The confirm is kept as the
// SELECTION-SCOPE check (the N may include off-screen rows); dropping it without a
// bulk Undo would leave the widest-blast surface with neither confirm nor undo,
// worse than either the per-row switch (optimistic + Undo) or this.
export async function bulkDisable(engine: EngineClient, rows: DownpipeState[], reload: () => void): Promise<void> {
  const noun = rows.length === 1 ? "downpipe" : "downpipes";
  const ok = await confirmModal({
    title: `Disable ${rows.length} ${noun}?`,
    // The body used to say only "This pauses scheduled backups ... Re-enable at any time", which named
    // one of the two things a pause now does and offered a reversibility the archive did not have: the
    // retention prune went on deleting a paused downpipe's run trees, and re-enabling never brought them
    // back. The engine now stands the prune down on a pause, so the sentence can say what pause means in
    // full, and it names the one activity a pause does NOT stop, at the control rather than on a page.
    body: `This pauses scheduled backups for ${rows.length === 1 ? "the selected downpipe" : `all ${rows.length} selected downpipes`}, and stops the retention prune deleting anything for ${rows.length === 1 ? "it" : "them"}. Re-enable at any time. The canary is not a downpipe and keeps flying against your destinations until you turn it off on the Canary screen.`,
    confirmLabel: "Disable",
  });
  if (!ok) return;
  // Each row states the revision the LIST was read at. A bulk disable is the widest-blast write on this
  // screen and it spreads each row's whole config back, so a row another operator edited since this list
  // loaded is refused as its own per-item failure and named in the batch summary, rather than being
  // reverted while the summary says N disabled.
  await runBatch("disable", rows, (r) => engine.addDownpipe({ ...r.config, enabled: false }, r.configRev), "disabled", reload);
}

// bulkDelete deletes each selected downpipe through the safe-confirm modal,
// summarising the count and naming the consequence (archives remain).
export async function bulkDelete(engine: EngineClient, rows: DownpipeState[], reload: () => void): Promise<void> {
  const noun = rows.length === 1 ? "downpipe" : "downpipes";
  const ok = await confirmModal({
    title: `Delete ${rows.length} ${noun}?`,
    body: `This stops scheduled backups for ${rows.length} ${noun} and removes ${rows.length === 1 ? "its" : "their"} run history. Existing archives in your destination are not deleted.`,
    confirmLabel: `Delete ${rows.length}`,
    variant: "danger",
    busyLabel: "Deleting",
  });
  if (!ok) return;
  await runBatch(
    "delete",
    rows,
    async (r) => {
      const res = await engine.deleteDownpipe(r.config.id, r.configRev);
      // A change-gate-queued delete did NOT delete; report it as this item's honest per-item
      // outcome rather than counting it as done (the batch summary names it).
      if (res.status === "pending") throw new Error("queued for approval; a second approver must approve it");
      return res;
    },
    "deleted",
    reload,
  );
}

// runBatch executes a per-item async op over the selected rows, reporting HONEST
// partial success (flow.md I step 3): progress, then a summary with per-item
// failures. There is no transaction; an auth failure halts the remaining items
// rather than firing N failed auth requests.
// `action` is the closed bulk-action id, threaded from the three entry points above. It is what tells a
// half-failed DELETE apart from a half-failed RUN in the ring; before it, both produced the identical tuple and
// coalesced into one row. `verb` stays the operator-facing prose the toast and the modal render.
// Exported for the validator: this loop decides what a fleet-wide action reports, and its
// partial-success, retry-cap and halt paths are the ones an operator trusts when something goes wrong.
export async function runBatch<T>(
  action: ClientDiagBulkAction,
  rows: DownpipeState[],
  op: (row: DownpipeState) => Promise<T>,
  verb: string,
  reload: () => void,
): Promise<void> {
  const failures: Array<{ name: string; reason: string }> = [];
  let done = 0;
  let halted = false;
  let haltReason = "";

  // A small live progress region in a modal-less inline summary is overkill for a
  // bulk action triggered from the bulk bar; we announce progress + the final
  // summary via the toast/live region, and show the per-item failures in a modal
  // when there are any (so they are real, focusable text, not a vanishing toast).
  // The toast component cannot update its message in place, so the progress line is a
  // static count of the batch (never a stale "0 of N" counter); the per-item outcome is
  // the honest summary + failures modal below.
  const progress = toast({ message: `Processing ${rows.length} ${rows.length === 1 ? "item" : "items"}...`, durationMs: 0, tone: "info" });

  for (const row of rows) {
    const outcome = await runItemPaced(op, row);
    if (outcome === "signed-out") {
      // A session expiry cut the batch short, so the rest was never attempted.
      // Counts only (how many items did not complete); the downpipe names never enter the ring.
      halted = true;
      haltReason = "your Access session expired";
      recordBulkOutcome(action, "auth", rows.length - done);
      break;
    }
    if (outcome === "ok") {
      done++;
      continue;
    }
    failures.push({ name: row.config.name, reason: outcome.reason });
  }
  progress();

  reload();

  if (halted) {
    // An auth failure mid-batch is the unauthorised path; route to signed-out, but
    // first tell the operator what completed (flow.md I step 4).
    toast({ message: `Stopped after ${done} of ${rows.length} (${haltReason}). Re-authenticate to continue.`, tone: "warn" });
    return goSignedOut();
  }

  if (failures.length === 0) {
    toast({ message: `${done} ${verb}.` });
    return;
  }

  // Partial: a summary with per-item outcomes (honest, never a blanket "done").
  toast({ message: `${done} ${verb}, ${failures.length} failed.`, tone: "warn" });
  openBulkSummary(action, verb, done, failures);
}

// runItemPaced runs ONE bulk item with 429 pacing. A success returns "ok"; a session expiry
// (401) returns "signed-out" so the caller halts the batch honestly; any other terminal failure returns
// a labelled reason. On a 429 the engine's Retry-After is honoured (capped) and the item is retried up
// to MAX_RATE_LIMIT_RETRIES times before being recorded as a labelled "rate limited" failure, so a
// limiter storm no longer reads as N unexplained failures and the loop yields instead of hammering.
async function runItemPaced<T>(op: (row: DownpipeState) => Promise<T>, row: DownpipeState): Promise<"ok" | "signed-out" | { reason: string }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    try {
      await op(row);
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
  return { reason: bulkFailureReason(lastErr) };
}
