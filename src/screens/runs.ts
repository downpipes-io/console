// Runs and history: the fleet-wide activity view, the per-downpipe
// history table, and the run detail that hosts Drill and Dry-run restore. This is the
// "what ran, when, and with what result" surface; a silently stopped backup is loud
// here, a failed run shows its coarse enumerated reason inline (escaped, never a stack),
// and in-flight is a REAL state, not a missing row.
//
// Elevated to enterprise grade:
//   - The shared dataTable() carries the dense read: a /-focusable text filter (downpipe
//     id or run id), status facets (ok / failed / in-flight), a comfortable/compact
//     density toggle, sortable columns, newest-first default sort, and large-list
//     windowing. The filter/sort/facet state is reflected back to the URL via
//     replaceState so a filtered view is bookmarkable and survives a refresh. The pre-existing ?status= / ?downpipe= deep links the Overview
//     uses (e.g. /runs?status=failed) still work and seed the table's initial state.
//   - A summary band reads throughput, freshness and outcome at a glance (records and
//     archive bytes written across the visible window, the newest run's age, the
//     failed / in-flight counts), each honest: an unknown count reads "-", never a
//     stale zero.
//   - The run detail drawer renders status via the status widget (hue + shape + label,
//     never the raw enum string) and shows the RICH per-run detail the wire
//     shape now carries: records, plaintext bytes, archive bytes written, segments
//     written, duration (humanised), the run id, index, started time, and any coarse
//     error. After a successful in-account drill it records drill evidence best-effort,
//     so a recoverability trail exists; a missing evidence route never
//     shadows the drill result.
//
// Honesty + safety carried through: each server-supplied string enters the DOM via
// textContent / typed element creation (dom.ts), so there is no markup-injection
// surface; the two-channel error model holds (a thrown 401 -> signed-out; an in-flow
// drill ok:false is an EXPECTED inline outcome, not a toast; a 5xx/network on the load
// is a block error with Retry, never a stale green); RBAC is a CLIENT MIRROR of the
// engine's server-side gate (the drill is Operator+, shown disabled-with-reason to a
// Viewer), but the engine is the enforcement point. No-custody: nothing here transmits,
// logs or stores any secret; the rich detail is counts and sizes only. Australian
// English, no em dashes, precise claims.
//
// This file is the COORDINATOR: it owns the screen DESCRIPTOR ({ route, title, measure,
// render, actions }) and the page-level chrome (the palette actions + header actions),
// and delegates the rest to ./runs/. The data-bound lifecycle and the six states live in
// ./runs/view.ts (the RunsView class); the summary band in ./runs/summary.ts; the data
// table and its URL reflection in ./runs/table.ts; the run detail drawer in
// ./runs/detail.ts; the shared types/constants in ./runs/types.ts; and the leaf helpers
// (flatten, the aggregations, the duration and seal readings, the empty/loading states)
// in ./runs/helpers.ts. The file was split for size while keeping its public surface
// (runsScreen) unchanged.

import { h, svgIcon } from "../lib/dom.ts";
import { pageHeader, requireEngine, type Screen, type ScreenAction, type ScreenContext } from "./common.ts";
import { navigate } from "../lib/nav.ts";
import { ICON_MAP, ICON_COSTS, ICON_REFRESH } from "../lib/icons.ts";
import { RunsView } from "./runs/view.ts";

// The runs list route, exported so an outside caller (the guided tour's chapter vocabulary;
// chapters.ts) references the same literal this descriptor uses, rather than a copy.
export const ROUTE_RUNS = "/runs";

export const runsScreen: Screen = {
  route: [ROUTE_RUNS, "/runs/:downpipeId/:index"],
  title: "Runs",
  measure: "wide",
  // The screen contributes its own palette commands (console-runs-3): a navigation to
  // the activity view and a "show failed runs" shortcut. Both MIRROR the engine's read
  // gate (history is viewable by any role), so neither lists an action that would 403.
  actions: runsActions(),
  render(ctx: ScreenContext) {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root; // requireEngine routed to onboarding

    const detailDp = ctx.pattern === "/runs/:downpipeId/:index" ? ctx.params.downpipeId : undefined;
    const detailIndex = ctx.pattern === "/runs/:downpipeId/:index" ? ctx.params.index : undefined;

    // The async region owns the six-state matrix (loading / empty / filtered-empty /
    // partial-via-table / error / success). It is built once; the screen drives it.
    const view = new RunsView(engine, ctx.query, { detailDp, detailIndex });

    root.appendChild(
      pageHeader(
        "Runs",
        "What ran, when, and with what result, across the fleet and per downpipe. A silently stopped backup is loud here.",
        headerActions(() => view.refresh()),
      ),
    );
    root.appendChild(view.el);
    view.start();

    // Expose the refresh for the action registry (mirrors overview.ts/map.ts): a
    // dispatcher can reach the live view's in-place refresh without a module singleton.
    (root as HTMLElement & { __runsRefresh?: () => void }).__runsRefresh = () => view.refresh();

    return root;
  },
};

// runsActions are the screen-owned palette commands (console-runs-3). Deduplicated by id
// against the shell baseline (common.ts allScreenActions, first wins). There is
// deliberately NO "Refresh runs" command: as a navigation it wiped the operator's
// ?status/?q/?sort mid-triage; the header Refresh button reloads in place instead.
// (Reinstating it needs a defaultDispatch case that reaches the live view's
// __runsRefresh handle rather than navigating.)
function runsActions(): ScreenAction[] {
  return [
    {
      id: "runs.open",
      title: "Go to Runs",
      group: "Navigation",
      kind: "navigate",
      keywords: ["runs", "activity", "history", "what ran"],
      target: "/runs",
    },
    {
      id: "runs.failed",
      title: "Show failed runs",
      group: "Runs",
      kind: "navigate",
      keywords: ["failed", "errors", "broken", "runs", "triage"],
      target: "/runs?status=failed",
    },
  ];
}

// headerActions builds the page-header action slot: a manual in-place Refresh (the
// screen does not poll, and refreshing must not wipe the filter/facet/sort state the
// way a bare navigation would) plus deep links to the topology map and the cost
// surface (both viewable by any role).
function headerActions(onRefresh: () => void): HTMLElement {
  const refresh = h(
    "button",
    { "data-dp": "runs.button.refresh", class: "btn btn--secondary btn--sm", type: "button", on: { click: onRefresh } },
    svgIcon(ICON_REFRESH, { size: 14 }),
    "Refresh",
  );
  const map = h(
    "button",
    { "data-dp": "runs.button.map", class: "btn btn--ghost btn--sm", type: "button", on: { click: () => navigate("/map") } },
    svgIcon(ICON_MAP, { size: 14 }),
    "View map",
  );
  const costs = h(
    "button",
    { "data-dp": "runs.button.costs", class: "btn btn--ghost btn--sm", type: "button", on: { click: () => navigate("/costs") } },
    svgIcon(ICON_COSTS, { size: 14 }),
    "View costs",
  );
  return h("div", { class: "page-header__actions" }, refresh, map, costs);
}
