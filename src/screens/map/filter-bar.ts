// The map's filter toolbar: the status + kind facet rows, the node-filter chip, the result
// count and the Clear-all. Factored out of view.ts for size. It builds DOM and reads the
// current filter values but owns no view lifecycle, so the view passes the present filter
// state plus the mutation callbacks (each writes the filter to the URL and re-projects from the
// cached flow set, no refetch) as parameters. Moved verbatim from view.ts; behaviour unchanged.
//
// No-custody is never weakened: every label reaches the DOM through the dom.ts textContent path
// (h()), so there is no markup-injection surface. House rules: Australian English, no em dashes,
// precise claims.

import { h } from "../../lib/dom.ts";
import type { StatusTone } from "../../components/status.ts";
import type { FlowRecord, FlowStatus, NodeKind } from "../../components/topology.ts";
import {
  STATUS_ORDER,
  KIND_ORDER,
  statusFilterLabel,
  statusFilterTone,
  kindLabel,
  nodeFilterLabel,
} from "./panels.ts";

// The present filter selection the bar reads (a FlowStatus / NodeKind / node id, or null = all).
export interface FilterState {
  statusFilter: FlowStatus | null;
  kindFilter: NodeKind | null;
  nodeFilter: string | null;
}

// The view-owned mutation callbacks: each writes the filter to the URL and re-projects.
export interface FilterCallbacks {
  onStatus: (s: FlowStatus | null) => void;
  onKind: (k: NodeKind | null) => void;
  onClearNode: () => void;
  onClearAll: () => void;
}

// buildFilterBar renders the status + kind facet rows. Each is a small set of toggle buttons
// (single-select per dimension); the active one carries aria-pressed. Activating one writes the
// filter to the URL and re-projects from the cached flow set (no refetch).
export function buildFilterBar(
  allFlows: FlowRecord[],
  visible: FlowRecord[],
  state: FilterState,
  cb: FilterCallbacks,
): HTMLElement {
  const bar = h("div", {
    class: "topo-filters",
    role: "group",
    "aria-label": "Filter the map",
    style: "display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-3);margin-top:var(--space-3)",
  });
  const status = statusFacets(allFlows, state, cb);
  if (status) bar.appendChild(status);
  const kind = kindFacets(allFlows, state, cb);
  if (kind) bar.appendChild(kind);
  if (state.nodeFilter) bar.appendChild(nodeChip(state.nodeFilter, cb));
  resultCount(bar, allFlows, visible, state, cb);
  return bar;
}

// statusFacets renders the status facet group (only the statuses actually present, so the bar
// stays honest and terse). role=group + aria-label associates the visible "Status:" hint with
// the buttons programmatically (WCAG 1.3.1 Info and Relationships). Returns null when no status
// is present (nothing to filter).
function statusFacets(allFlows: FlowRecord[], state: FilterState, cb: FilterCallbacks): HTMLElement | null {
  // One pass to collect the present statuses, then order them by STATUS_ORDER (O(n) rather
  // than the O(facets x flows) of a some() scan per facet, since this runs on the poll path).
  const seen = new Set<FlowStatus>();
  for (const f of allFlows) seen.add(f.status);
  const presentStatuses = STATUS_ORDER.filter((s) => seen.has(s));
  if (presentStatuses.length === 0) return null;
  const group = h("div", {
    role: "group",
    "aria-label": "Status filter",
    style: "display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)",
  });
  group.appendChild(h("span", { class: "field__hint", "aria-hidden": "true" }, "Status:"));
  group.appendChild(facetButton("All statuses", state.statusFilter === null, () => cb.onStatus(null)));
  for (const s of presentStatuses) {
    group.appendChild(
      facetButton(statusFilterLabel(s), state.statusFilter === s, () => cb.onStatus(s), statusFilterTone(s)),
    );
  }
  return group;
}

// kindFacets renders the source-kind facet group (kinds present). Same pattern as statusFacets;
// the visible "Source:" hint is aria-hidden to avoid a double-announcement with the group label.
// Returns null unless more than one kind is present (a single kind is nothing to filter by).
function kindFacets(allFlows: FlowRecord[], state: FilterState, cb: FilterCallbacks): HTMLElement | null {
  // One pass to collect the present kinds, then order them by KIND_ORDER (see statusFacets).
  const seen = new Set<NodeKind>();
  for (const f of allFlows) seen.add(f.source.kind);
  const presentKinds = KIND_ORDER.filter((k) => seen.has(k));
  if (presentKinds.length <= 1) return null;
  const group = h("div", {
    role: "group",
    "aria-label": "Source filter",
    style: "display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)",
  });
  group.appendChild(h("span", { class: "field__hint", "aria-hidden": "true" }, "Source:"));
  group.appendChild(facetButton("All sources", state.kindFilter === null, () => cb.onKind(null)));
  for (const k of presentKinds) {
    group.appendChild(facetButton(kindLabel(k), state.kindFilter === k, () => cb.onKind(k)));
  }
  return group;
}

// nodeChip is the node-filter chip with a clear affordance (set by activating a node).
function nodeChip(nodeFilter: string, cb: FilterCallbacks): HTMLElement {
  return h(
    "span",
    { class: "badge badge--info", style: "display:inline-flex;align-items:center;gap:var(--space-1)" },
    `Node: ${nodeFilterLabel(nodeFilter)}`,
    h(
      "button",
      { "data-dp": "map.button.clear-node", class: "btn btn--ghost btn--sm", type: "button", "aria-label": "Clear node filter", style: "padding:0 var(--space-1)", on: { click: () => cb.onClearNode() } },
      "x",
    ),
  );
}

// resultCount appends the "N of M flows" count and, when any filter is active, the Clear-all.
function resultCount(bar: HTMLElement, allFlows: FlowRecord[], visible: FlowRecord[], state: FilterState, cb: FilterCallbacks): void {
  const anyFilter = state.statusFilter !== null || state.kindFilter !== null || state.nodeFilter !== null;
  bar.appendChild(
    h(
      "span",
      { class: "field__hint", style: "margin-left:auto" },
      `${visible.length} of ${allFlows.length} ${allFlows.length === 1 ? "flow" : "flows"}`,
    ),
  );
  if (anyFilter) {
    bar.appendChild(
      h(
        "button",
        { "data-dp": "map.button.clear-all#1", class: "btn btn--ghost btn--sm", type: "button", on: { click: () => cb.onClearAll() } },
        "Clear filters",
      ),
    );
  }
}

// facetButton is one single-select toggle: the active one carries aria-pressed and a tonal dot
// when a status tone is supplied.
function facetButton(label: string, active: boolean, onClick: () => void, tone?: StatusTone): HTMLElement {
  const btn = h(
    "button",
    { "data-dp": "map.toggle.click",
      class: active ? "btn btn--secondary btn--sm is-active" : "btn btn--ghost btn--sm",
      type: "button",
      "aria-pressed": active ? "true" : "false",
      on: { click: onClick },
    },
  );
  if (tone) btn.appendChild(h("span", { class: `dot dot--${tone}`, "aria-hidden": "true", style: "margin-right:var(--space-1)" }));
  btn.appendChild(h("span", label));
  return btn;
}
