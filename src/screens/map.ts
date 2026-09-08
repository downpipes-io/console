// The source-to-destination TOPOLOGY MAP screen. The dedicated /map screen: the visual centrepiece that
// answers at a glance what is being protected, where it lands, whether each flow is fresh,
// and how much it moves. It is the SCREEN half of the build split: it
// fetches the real engine data, maps each downpipe to the component's FlowRecord input,
// owns the URL / filters / drawer wiring, and renders the accessible table ALONGSIDE the
// visual. It does NOT reimplement the visualisation; it consumes components/live-flow.ts
// (renderLiveFlow), the WebGL view that degrades to the SVG topology where WebGL is
// unavailable and carries the accessible data-table in every branch (the parity contract
// lives in the components, not here).
//
// Honest by construction (mirrored from overview.ts):
//   - The map binds to the engine's own data (listDownpipes + listAllHistory + status) and
//     NEVER fabricates a flow or a green. A downpipe whose status cannot be read reads
//     "unknown" (a question glyph, neutral hue), never a stale teal.
//   - "stale" (last good run older than the cadence implies) is distinct from "disabled"
//     (a paused downpipe is not a failure) and from "unknown" (an unreachable engine is not
//     a backup failure), the same freshness vocabulary overview.ts turns on.
//   - Each fetch settles independently (Promise.allSettled): the list is the CORE (its
//     failure is the screen's error state with Retry, operator input preserved); history
//     and status degrading only weaken individual flows to "unknown" or relax the cadence
//     freshness check, they never blank the map.
//   - The canvas never blanks on a poll: the component is mounted once and re-fed via
//     setFlows; a 2px indeterminate bar marks the refetch (the async-region idiom).
//
// The single-destination decision (honest labelling): the engine today configures ONE
// archive destination account-wide (status.destKind / status.destConfigured; api.ts
// StatusReport has no per-downpipe destination). So the map is genuinely N sources -> 1
// archive destination, and it says so: every flow points at the same destination node,
// labelled from the real destKind ("In-account R2" / "S3 archive" / the honest "destination
// not selected" / "destination unknown" when status is unreachable). When the engine grows
// per-downpipe destinations the mapping below changes in one place (destinationFor); until
// then the map does not invent a fan-out it cannot back.
//
// Role: viewable by ANY role, role-agnostic to view. The map is pure
// observability; it owns no write. Activating an edge opens a READ-oriented detail drawer
// (config + recent runs) deep-linked at /map (the selection rides in the query so the base
// path stays /map and closing returns to /map); the drawer links through to the Downpipes
// surface for the gated actions (Run now / Edit / Restore), so a Viewer is never shown a
// write control that would 403.
//
// No-custody is never weakened: the map renders names, counts, statuses and freshness only,
// all from the in-account engine; it transmits nothing and shows no key material. Every
// server-supplied string (a downpipe name, a binding, a bucket name, a run id) reaches the
// DOM through the dom.ts textContent path (h() / kvRow / the component's svgText), so there
// is no markup-injection surface. Australian English; no em dashes; precise claims.
//
// This file is the COORDINATOR: it owns the screen DESCRIPTOR (mapScreen: { route, title,
// measure, render, actions }) and re-exports the symbols external callers depend on (the
// freshness validator imports mapDownpipesToFlows + classifyFreshness by name). The data
// derivation and the freshness rule live in the pure leaf ./map/data.ts, the presentation
// helpers and drawer renderers in ./map/panels.ts, and the six-state view controller plus the
// render entry point in ./map/view.ts; the file was split for size while keeping the public
// surface byte-identical. The descriptor is wired into the router/palette elsewhere.

import { renderMap, screenActions, MAP_ROUTE, type Screen } from "./map/view.ts";

// Re-exports: the freshness validator imports mapDownpipesToFlows + classifyFreshness from
// this module, so the split keeps those imports working unchanged. The remaining derivation
// symbols (downpipeIdOf, the CoreFreshness / FreshnessInput types) are re-exported too so any
// future caller that keys off the coordinator keeps a stable surface; they are otherwise
// screen-internal. These all live in the pure, DOM-free leaf so the validator runs them in
// Node without a DOM.
export { mapDownpipesToFlows, classifyFreshness, cadenceSecondsOf, downpipeIdOf } from "./map/data.ts";
export type { CoreFreshness, FreshnessInput } from "./map/data.ts";

export const mapScreen: Screen = {
  route: MAP_ROUTE,
  title: "Topology map",
  // Wide: the map is a dense, two-column visual plus a wide accessible table.
  measure: "wide",
  actions: screenActions(),
  render(ctx) {
    // The body assembly (header + the six-state MapView controller + the map.refresh hook)
    // lives in ./map/view.ts; the descriptor stays thin and just returns it, the same way the
    // overview / onboarding coordinators delegate their render.
    return renderMap(ctx);
  },
};
