// The /restore screen's "pick a run" modal. This is a self-contained surface: it reads the fleet's run
// history, lists it, and deep-links the chosen run back into the restore flow. It owns no restore state
// and mutates none.

import { h } from "../../lib/dom.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { skeletonRows } from "../../components/feedback.ts";
import { openModal } from "../../components/modal.ts";
import { runStatusTone, statusWithLabel } from "../../components/status.ts";
import { relativeTime, absoluteTime } from "../../lib/format.ts";
import type { EngineClient, RunHistoryEntry } from "../../api.ts";
import { fetchDownpipeNames } from "./shared.ts";

// How many recent runs the picker lists at most, newest first. The history rings are already bounded
// per downpipe, but a large fleet can still sum to a long list; this keeps the modal a calm, scannable
// length rather than a scroll marathon. A named cap so the choice is explicit.
const RUN_PICKER_MAX = 40;

interface PickerRun {
  run: RunHistoryEntry;
  downpipeId: string;
  // The owning downpipe's friendly name, when the fleet name read (shared.ts fetchDownpipeNames)
  // resolved it. Absent falls back to the id alone (runPickerRow), never a fabricated name.
  downpipeName?: string;
}

// openRunPicker opens a modal OVER the /restore screen listing the recent runs (id, owning downpipe,
// status, age), each row a button that dismisses the picker and deep-links to /restore/:runId (which
// auto-builds the dry-run plan). Keeping the operator in the restore framing is the whole point: a full
// navigation to /runs would lose the framing with no obvious way back. The picker owns its own
// loading / empty / error states; the history read never blocks or replaces the restore form beside it.
//
// onPick overrides what happens on selection: the default deep-links to /restore/:runId (a fresh
// navigation), but the break-glass restore panel passes an onPick that sets the chosen run IN PLACE so the
// operator's already-supplied break-glass key is not discarded by a re-render. It still closes the modal.
export function openRunPicker(engine: EngineClient, onPick?: (runId: string) => void): void {
  const listHost = h("div", { class: "run-picker" });
  listHost.appendChild(skeletonRows(4));
  const handle = openModal({
    title: "Pick a run to restore",
    body: listHost,
    actions: [{ label: "Cancel", variant: "secondary", onClick: () => {} }],
  });

  const load = (): void => {
    listHost.replaceChildren(skeletonRows(4));
    // Fetch the fleet name map (shared.ts fetchDownpipeNames) alongside the history so each row can
    // name its owning downpipe rather than showing only its raw id; a failed/slow name read degrades to
    // an empty map (fetchDownpipeNames never throws), never blocking the picker.
    void Promise.all([engine.listAllHistory(), fetchDownpipeNames(engine)])
      .then(([all, names]) => {
        const runs = recentRuns(all.byDownpipe, names);
        if (runs.length === 0) {
          listHost.replaceChildren(h("p", { class: "field__hint" }, emptyPickerText(all.byDownpipe)));
          return;
        }
        const pick = (runId: string): void => {
          handle.close();
          if (onPick) onPick(runId);
          else navigate(`/restore/${encodeURIComponent(runId)}`);
        };
        listHost.replaceChildren(...runs.map((r) => runPickerRow(r, pick)));
      })
      .catch((err) => {
        if (isUnauthorised(err)) {
          handle.close();
          return goSignedOut();
        }
        // The history read is picker-only context, never the restore itself, so a fault degrades to a
        // calm retryable note rather than an error that dead-ends the modal; the run-id field still works.
        listHost.replaceChildren(
          h(
            "div",
            { class: "run-picker__error stack-sm" },
            h("p", { class: "field__hint" }, "The recent-run history could not be read just now. You can still type a run id on the restore form."),
            h("button", { "data-dp": "restore-flow.button.load", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => load() } }, "Try again"),
          ),
        );
      });
  };
  load();
}

// recentRuns flattens the all-downpipe history envelope into one newest-first list, keeping only SEALED
// runs (status "ok"), capped to RUN_PICKER_MAX. A run id alone does not make a restore target: the engine
// allocates the id when the run starts and keeps it on the row whatever the outcome, so in-flight, failed
// and abandoned rows carry one too (engine sched/scheduler-do-scheduling.ts trigger and completeRun). None
// of those has a sealed archive to restore from, and listing them would offer a row that can only fail at
// the dry run. The filter runs BEFORE the cap, so a burst of failed runs cannot push sealed ones off the
// list. A run that is not listed can still be typed on the restore form. names attaches each row's owning
// downpipe's friendly name (shared.ts fetchDownpipeNames), the same join runs/view.ts's flatten()
// performs; a downpipe absent from the map (a failed name read, or a downpipe deleted after the run)
// leaves downpipeName unset, so runPickerRow falls back to the id alone.
export function recentRuns(byDownpipe: Record<string, RunHistoryEntry[]>, names: Map<string, string>): PickerRun[] {
  const out: PickerRun[] = [];
  for (const id of Object.keys(byDownpipe)) {
    const downpipeName = names.get(id);
    for (const run of byDownpipe[id] ?? []) {
      if (run.runId && run.status === "ok") out.push({ run, downpipeId: id, ...(downpipeName ? { downpipeName } : {}) });
    }
  }
  out.sort((a, b) => (Date.parse(b.run.startedAt) || 0) - (Date.parse(a.run.startedAt) || 0));
  return out.slice(0, RUN_PICKER_MAX);
}

// emptyPickerText is what the picker says when recentRuns returns nothing. There are two cases, and they
// need different words. With no run at all, no downpipe has run yet, so a first seal is what the operator
// waits for. With runs but none sealed, the ring may simply hold only failed runs: it keeps the latest 50
// entries per downpipe and prunes entries older than 400 days (engine sched/history-retention.ts), so a
// source that failed 50 times in a row pushes every sealed run off it. Those sealed runs are still on the
// destination and restore by id (restore-open.ts reads the store by runId, never the ring), so telling that
// operator to wait for a first seal would be false. The date browse reads the same ring, so it is no help.
export function emptyPickerText(byDownpipe: Record<string, RunHistoryEntry[]>): string {
  const anyRun = Object.values(byDownpipe).some((rows) => (rows ?? []).some((r) => Boolean(r.runId)));
  if (!anyRun) return "No sealed runs across any downpipe yet. A run appears here when a downpipe seals its first backup.";
  return "The recent run history has no sealed run. This history keeps only the last 50 runs of each downpipe, and none of the runs in it sealed a backup. A downpipe can have older sealed runs on its destination. To restore one of those runs, type its run id on the restore form. A run that is not in this history is read from your default destination.";
}

// runPickerRow is one selectable run: its id + owning downpipe (named, when known) on the left, status +
// relative age on the right. Activating it dismisses the picker and deep-links to that run's restore
// plan. The run id, downpipe id and downpipe name are the customer's own data (escaped by the h()
// text-node path); no value or key transits.
function runPickerRow(item: PickerRun, onPick: (runId: string) => void): HTMLElement {
  const { tone, label } = runStatusTone(item.run.status);
  return h(
    "button",
    { "data-dp": "restore-flow.button.pick", class: "run-picker__row", type: "button", on: { click: () => onPick(item.run.runId) } },
    h(
      "span",
      { class: "run-picker__main" },
      h("span", { class: "run-picker__run mono" }, item.run.runId),
      h("span", { class: "run-picker__dp" }, item.downpipeName ? `${item.downpipeName} · ` : "", h("span", { class: "mono" }, item.downpipeId)),
    ),
    h(
      "span",
      { class: "run-picker__meta" },
      statusWithLabel(tone, item.run.status === "ok" ? "Sealed, ok" : label),
      h("span", { class: "run-picker__age field__hint", title: absoluteTime(item.run.startedAt) }, relativeTime(item.run.startedAt)),
    ),
  );
}
