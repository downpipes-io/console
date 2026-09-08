// Cost calculator and predictor (IA screen at /costs). The
// throughput-based storage cost estimator the console carries: given a source size, a
// schedule, a churn rate, a retention policy and the operator's own destination
// pricing, it PROJECTS the storage footprint and its cost. Every figure is an
// ESTIMATE, never a quote or a guarantee; the assumptions panel is always visible and
// every input is overridable.
//
// Honest by construction (the same discipline as overview.ts): the calculator runs ENTIRELY in the browser over names,
// counts, sizes and the operator's pricing inputs. It transmits nothing, logs nothing,
// stores nothing, and never touches a key, a secret or archive content (no-custody).
// The ONLY engine read is listAllHistory(), used to SEED the observed mode from actual
// per-run figures; when that read fails the screen falls back to manual with an inline
// note and never blocks (the error state is a note, not a block, because a manual
// estimate needs no engine at all).
//
// All the maths lives in lib/cost-model.ts and is consumed by the modules, never
// reimplemented: monthlyCost / project / perRunCost / restoreCostOnce / drillCostOnce /
// sensitivity / costOfRetention / the cadence and retention-window conversions / the regimes
// and the PRESETS.
//
// Modes:
//   - Observed (the headline): when listAllHistory() returns runs carrying
//     archiveBytesWritten / segmentsWritten, seed sourceBytes, churnFraction, segBytes
//     (from the observed bytes-per-object), overheadBytes and runsPerMonth from those
//     runs, then let the operator override. Copy reads "based on your last N runs".
//   - Manual: sensible DEFAULT_INPUTS, everything entered. Always available, no engine.
//   The active mode + WHY is stated honestly; switching modes never loses input.
//
// RBAC: viewable by any role (it reads only run history, an ungated read, and computes
// locally). No write, no gated control, so the descriptor exports a single navigation
// action and the screen renders for a Viewer exactly as for an Owner.
//
// House: Australian English; no em dashes; precise claims ("estimate" / "projected" /
// "indicative", never "guaranteed"); custom domains only (none appear here).
//
// This file is the COORDINATOR: it owns the screen descriptor (route, title, measure,
// actions, render) and re-exports the symbols external callers (the cost-model validator)
// depend on. The presentation-only state machine lives in ./costs/view.ts (the CostView
// class), the pure results builder in ./costs/results.ts, the observed-seed derivation in
// ./costs/seed.ts, and the small leaf helpers, constants and state types in ./costs/helpers.ts;
// the file was split for size while keeping the public surface byte-identical.

import { h } from "../lib/dom.ts";
import { pageHeader, type Screen, type ScreenContext } from "./common.ts";
import { CostView } from "./costs/view.ts";

// Re-exports: the cost-model validator imports the observed-seed derivation and its result
// type from this module, so the split keeps its import working unchanged.
export { summariseHistory, costBySourceType } from "./costs/seed.ts";
export type { SourceTypeCostRow } from "./costs/seed.ts";
export type { HistoryLoad } from "./costs/helpers.ts";

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

export const costsScreen: Screen = {
  route: "/costs",
  title: "Cost calculator",
  // Wide: the results carry a multi-column projection table, a stat-tile split and two
  // charts beside the inputs; the prose measure would crush them.
  measure: "wide",
  // Viewable by any role; the one palette entry is a plain navigation to this screen, so
  // it is shown to every caller (no `when` gate) and never 403s.
  actions: [
    {
      id: "costs.open",
      title: "Open the cost calculator",
      group: "Navigation",
      kind: "navigate",
      keywords: ["cost", "calculator", "estimate", "price", "pricing", "storage", "egress", "projection", "predict", "spend"],
      target: "/costs",
    },
  ],
  render(ctx: ScreenContext): HTMLElement {
    const root = h("div");
    root.appendChild(
      pageHeader(
        "Cost calculator",
        // Honest scope: the COMPUTATION is local, but the SCREEN does make one read
        // (the run-history seed for Observed mode), so "nothing is sent anywhere"
        // would overclaim. The estimate-not-a-quote framing is carried ONCE by the
        // headline card and once by the assumptions lead, not repeated here.
        "Project the storage footprint and its cost from a source size, a schedule, a churn rate, a retention policy and your own destination pricing. Computed in your browser; the only request is the run-history read that seeds Observed mode.",
      ),
    );

    // The view owns the load -> seed -> render lifecycle and all the six states. It is
    // built once; an engine being absent is not fatal here (manual mode needs none), so
    // unlike most screens this does NOT requireEngine(): it renders the manual
    // calculator and notes that observed seeding is unavailable without a connection.
    const view = new CostView(ctx.engine);
    root.appendChild(view.el);
    view.start();
    return root;
  },
};
