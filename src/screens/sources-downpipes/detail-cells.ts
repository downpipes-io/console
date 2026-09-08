// The small drawer render cells for the downpipe detail drawer (flow.md C): pure UI
// builders for the freshness banner, the run-history strip and skeleton, and the
// restore-test / retention Configuration cells. Moved verbatim from detail.ts to keep
// that module under the structural threshold. Australian English, no em dashes, precise
// claims.

import { h } from "../../lib/dom.ts";
import { navigate } from "../../lib/nav.ts";
import { runStatusTone, type StatusTone } from "../../components/status.ts";
import { absoluteTime } from "../../lib/format.ts";
import type { DownpipeState, RetentionPolicy, RunHistoryEntry } from "../../api.ts";
import {
  type Freshness,
  restoreTestRecency,
  retentionSummary,
} from "./helpers.ts";

// The run-history strip shows at most this many recent runs (newest on the right).
const MAX_RUN_STRIP_ENTRIES = 20;
// The loading skeleton shows half a strip of placeholder cells.
const SKELETON_STRIP_CELLS = MAX_RUN_STRIP_ENTRIES / 2;

// restoreTestRecencyCell renders the last-scheduled-restore-test recency as a hue + shape
// + label line plus an honest detail hint, for the drawer Configuration section. The read
// is computed by the pure restoreTestRecency() above so it never invents a green.
export function restoreTestRecencyCell(state: DownpipeState): HTMLElement {
  const r = restoreTestRecency(state);
  return h(
    "span",
    { style: "display:inline-flex;flex-direction:column;gap:var(--space-1)" },
    h(
      "span",
      { style: "display:inline-flex;align-items:center;gap:var(--space-1)" },
      h("span", { class: `dot dot--${r.tone}`, "aria-hidden": "true" }),
      r.label,
    ),
    h("span", { class: "field__hint" }, r.detail),
  );
}

// retentionCell renders the retention policy for the drawer Configuration section as a hue + shape +
// label line plus the plain-words summary. An ENFORCED policy (the engine deletes on the schedule) reads
// warn (a destructive posture worth a glance); a report-only or absent policy reads neutral. The summary
// text comes from the pure retentionSummary() so the copy never overstates the deletion gate.
export function retentionCell(r: RetentionPolicy | undefined): HTMLElement {
  const enforced = r?.enforce === true;
  const label = r === undefined || (r.keepRuns === undefined && r.keepDays === undefined)
    ? "Keep everything"
    : enforced ? "Deletion enforced" : "Report-only";
  const tone: StatusTone = enforced ? "warn" : "neutral";
  return h(
    "span",
    { style: "display:inline-flex;flex-direction:column;gap:var(--space-1)" },
    h(
      "span",
      { style: "display:inline-flex;align-items:center;gap:var(--space-1)" },
      h("span", { class: `dot dot--${tone}`, "aria-hidden": "true" }),
      label,
    ),
    h("span", { class: "field__hint" }, retentionSummary(r)),
  );
}

// freshnessBanner builds the honest, hue + shape + label freshness summary for the
// detail drawer.
export function freshnessBanner(f: Freshness): HTMLElement {
  const cls = f.tone === "danger" ? "freshness freshness--danger" : f.tone === "warn" ? "freshness freshness--warn" : f.tone === "ok" ? "freshness freshness--ok" : "freshness";
  return h(
    "div",
    { class: cls },
    h("span", { class: `dot dot--${f.tone} freshness__dot`, "aria-hidden": "true" }),
    h("div", h("strong", `${f.label}. `), f.reason ?? "This downpipe needs attention."),
  );
}

// runStrip renders the per-downpipe history as a horizontal status strip (newest
// last per the wireframe; the engine returns newest-first so we reverse for the
// timeline reading). Each cell is keyboard-operable and carries a text label.
export function runStrip(entries: RunHistoryEntry[], downpipeId: string): HTMLElement {
  if (entries.length === 0) return h("p", { class: "field__hint" }, "No runs yet. Run one now, or wait for the next scheduled run.");
  const strip = h("ul", { class: "run-strip", role: "list", "aria-label": "Recent runs, newest on the right" });
  // Show up to MAX_RUN_STRIP_ENTRIES, oldest-to-newest (the engine ring is newest-first).
  const ordered = entries.slice(0, MAX_RUN_STRIP_ENTRIES).reverse();
  for (const e of ordered) {
    // The canonical tone, so an abandoned run stops wearing the in-flight hue in the downpipe drawer.
    const tone = runStatusTone(e.status).tone;
    const label = `Run ${e.index}, ${absoluteTime(e.startedAt)}, ${e.status}${e.error ? `, ${e.error}` : ""}`;
    const classes = ["run-cell", `run-cell--${tone}`];
    if (e.status === "in-flight") classes.push("run-cell--inflight");
    const cell = h("li", {
      class: classes.join(" "),
      tabindex: "0",
      role: "button",
      title: label,
      "aria-label": label,
      on: {
        click: () => navigate(`/runs/${encodeURIComponent(downpipeId)}/${e.index}`),
        keydown: (ev: Event) => {
          const ke = ev as KeyboardEvent;
          if (ke.key === "Enter" || ke.key === " ") {
            if (ke.target !== cell) return;
            ke.preventDefault();
            navigate(`/runs/${encodeURIComponent(downpipeId)}/${e.index}`);
          }
        },
      },
    });
    if (e.status === "failed") cell.appendChild(h("span", { class: "run-cell__mark", "aria-hidden": "true" }, "x"));
    else if (e.status === "abandoned") cell.appendChild(h("span", { class: "run-cell__mark", "aria-hidden": "true" }, "!"));
    else if (e.status === "in-flight") cell.appendChild(h("span", { class: "run-cell__mark", "aria-hidden": "true" }, "."));
    strip.appendChild(cell);
  }
  return strip;
}

export function runsSkeletonStrip(): HTMLElement {
  const strip = h("div", { class: "run-strip", "aria-busy": "true", "aria-hidden": "true" });
  for (let i = 0; i < SKELETON_STRIP_CELLS; i++) strip.appendChild(h("span", { class: "skeleton run-cell" }));
  return strip;
}
