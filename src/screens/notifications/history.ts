// Notifications panel 3, HISTORY (delivery outcomes, newest first): the recent delivery outcomes with a manual
// refresh, the filter + facets table, and the honest fail-open read, a not-delivered row means the channel
// rejected or was unreachable, never that a backup was blocked. History is capped, so the oldest entries roll off.
// Moved verbatim from the notifications coordinator for size; it imports the shared leaf (./shared.ts) only, so
// it never imports another panel module (which would form a cycle).
//
// House rules: redaction-safe one-liners; status by hue + shape + label; Australian English, no em dashes.

import { h, svgIcon } from "../../lib/dom.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { blockError, sessionEnded } from "../../components/error-view.ts";
import { skeletonRows, emptyState } from "../../components/feedback.ts";
import { dataTable } from "../../components/data-table.ts";
import { badge, statusWithLabel } from "../../components/status.ts";
import { relativeTime, absoluteTime } from "../../lib/format.ts";
import { ICON_REFRESH } from "../../lib/icons.ts";
import type { EngineClient, NotifyHistoryEntry } from "../../api.ts";
import { severityRank, severityBadge, eventLabel, kindBadge } from "./shared.ts";

export function renderHistoryPanel(engine: EngineClient): HTMLElement {
  const wrap = h("section", { class: "stack", style: "display:grid;gap:var(--space-5)", "aria-labelledby": "history-h" });

  const refreshBtn = h("button", { "data-dp": "notifications.button.refresh", class: "btn btn--secondary btn--sm", type: "button" }, svgIcon(ICON_REFRESH, { size: 14 }), "Refresh") as HTMLButtonElement;
  const toolbar = h("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-3);flex-wrap:wrap" });
  const lead = h("div", { style: "display:grid;gap:var(--space-1)" });
  lead.appendChild(h("h2", { id: "history-h", style: "font-size:var(--text-lg)" }, "Delivery history"));
  lead.appendChild(h("p", { class: "field__hint measure" }, "The recent delivery outcomes, newest first. History is capped, so the oldest entries roll off. Delivery is fail-open: a not-delivered row means the channel rejected or was unreachable, never that a backup was blocked."));
  toolbar.appendChild(lead);
  toolbar.appendChild(refreshBtn);
  wrap.appendChild(toolbar);

  const region = h("div", { class: "async-region" });
  wrap.appendChild(region);

  const load = (): void => {
    region.replaceChildren(skeletonRows(6));
    void engine
      .listNotifyHistory()
      .then((rows) => region.replaceChildren(renderHistoryTable(rows)))
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the delivery history is a skeleton until this replaces it.
          region.replaceChildren(sessionEnded(load));
          return goSignedOut();
        }
        region.replaceChildren(blockError(err, load, { origin: location.origin }));
      });
  };
  refreshBtn.addEventListener("click", load);
  load();

  return wrap;
}

function renderHistoryTable(rows: NotifyHistoryEntry[]): HTMLElement {
  const wrap = h("div", { class: "stack", style: "display:grid;gap:var(--space-3)" });

  if (rows.length === 0) {
    wrap.appendChild(
      emptyState({
        title: "No deliveries yet",
        body: "When an event matches a rule and is delivered to a channel, the outcome appears here. A test send also records a row.",
      }),
    );
    return wrap;
  }

  // Newest-first is the engine's order; the table's default sort keeps it but also lets
  // the operator re-sort by any column. Facets give a fast within-page narrow.
  const handle = dataTable<NotifyHistoryEntry>({
    label: "Delivery history",
    rows,
    rowKey: (e) => String(e.seq),
    filter: { placeholder: "Filter history", resultLabel: "deliveries", getText: (e) => `${e.event} ${e.severity} ${e.channelKind} ${e.detail} ${e.delivered ? "delivered" : "failed"}${e.test === true ? " test" : ""}` },
    facets: [
      // Outcome is one dimension (delivered vs not): selecting both shows all deliveries, never AND to empty
      // (B38). Severity and the test flag are orthogonal, so they keep narrowing (AND).
      { id: "delivered", group: "outcome", label: "delivered", tone: "ok", predicate: (e) => e.delivered },
      { id: "failed", group: "outcome", label: "not delivered", tone: "danger", predicate: (e) => !e.delivered },
      { id: "critical", label: "critical", tone: "danger", predicate: (e) => e.severity === "critical" },
      { id: "test", label: "test sends", tone: "info", predicate: (e) => e.test === true },
    ],
    initialSort: { key: "seq", dir: "desc" },
    columns: [
      { key: "delivered", header: "Outcome", sortable: true, sortValue: (e) => (e.delivered ? 1 : 0), render: (e) => (e.delivered ? statusWithLabel("ok", "delivered") : statusWithLabel("danger", "not delivered")) },
      { key: "severity", header: "Severity", sortable: true, sortValue: (e) => severityRank(e.severity), render: (e) => severityBadge(e.severity) },
      { key: "event", header: "Event", sortable: true, sortValue: (e) => e.event, render: (e) => (e.test === true ? badge("info", "Test send") : badge("default", eventLabel(e.event))) },
      { key: "channel", header: "Channel", render: (e) => kindBadge(e.channelKind) },
      { key: "detail", header: "Detail (redacted)", render: (e) => h("span", { class: "field__hint" }, e.detail) },
      { key: "ts", header: "When", sortable: true, sortValue: (e) => e.ts, render: (e) => h("span", { title: absoluteTime(e.ts) }, relativeTime(e.ts)) },
    ],
  });
  wrap.appendChild(handle.el);

  return wrap;
}
