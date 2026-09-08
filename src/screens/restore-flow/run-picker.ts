// The /restore screen's "pick a run" modal, split out of ./flow.ts along its own seam (that module reached
// its line budget as more instrumentation and the upstream restore work landed in it together). This is a self-contained surface: it reads the fleet's run history, lists it, and deep-links
// the chosen run back into the restore flow. It owns no restore state and mutates none.
//
// House rules: Australian English, no em dashes, precise claims.

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
// auto-builds the dry-run plan). Keeping the operator in the restore framing is the whole point: a
// prior full navigation to /runs lost the framing with no obvious way back. The picker owns its own
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
          listHost.replaceChildren(
            h("p", { class: "field__hint" }, "No runs across any downpipe yet. A run appears here the moment a downpipe seals its first backup."),
          );
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

// recentRuns flattens the all-downpipe history envelope into one newest-first list, keeping only runs
// that carry a run id (an unsealed row with no id is not a restore target), capped to RUN_PICKER_MAX.
// names attaches each row's owning downpipe's friendly name (shared.ts fetchDownpipeNames), the same
// join runs/view.ts's flatten() performs; a downpipe absent from the map (a failed name read, or a
// downpipe deleted after the run) leaves downpipeName unset, so runPickerRow falls back to the id alone.
function recentRuns(byDownpipe: Record<string, RunHistoryEntry[]>, names: Map<string, string>): PickerRun[] {
  const out: PickerRun[] = [];
  for (const id of Object.keys(byDownpipe)) {
    const downpipeName = names.get(id);
    for (const run of byDownpipe[id] ?? []) {
      if (run.runId) out.push({ run, downpipeId: id, ...(downpipeName ? { downpipeName } : {}) });
    }
  }
  out.sort((a, b) => (Date.parse(b.run.startedAt) || 0) - (Date.parse(a.run.startedAt) || 0));
  return out.slice(0, RUN_PICKER_MAX);
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
