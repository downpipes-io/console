// The source-to-destination TOPOLOGY MAP. The visual centrepiece of the console: a bipartite
// flow map with SOURCES on the left,
// DESTINATIONS on the right, and DOWNPIPES as the connectors, answering at a glance what
// is being protected, where it lands, whether each flow is healthy and fresh, and how
// much it moves.
//
// Two hard contracts shape the whole module:
//
//  1. The SVG is a PROGRESSIVE ENHANCEMENT over an accessible representation that always
//     exists (spec section 5). The map ALSO renders a real data-table (data-table.ts)
//     carrying EVERY flow the SVG shows. Parity is the contract, not a nicety: both the
//     SVG and the table are projected from the SAME computed model (buildTopologyModel),
//     so they cannot drift. The model layer is what the validator asserts.
//
//  2. The module is PURE FROM DATA and framework-light. The GEOMETRY and the STATUS /
//     THROUGHPUT ENCODING are a deterministic function of the input order alone (no d3, no
//     dependency, no Math.random, no DOM, no wall-clock read): buildTopologyModel emits
//     identical positions, paths and encodings every time for the same input. The only
//     time-dependent fields are the human FRESHNESS strings ("last run 3h ago"), which are
//     a pure function of an EXPLICIT `now` (a caller-injectable option that defaults, in
//     the render path only, to Date.now), so even those are deterministic given their
//     inputs and never read a hidden clock inside the geometry. The model touches no DOM at
//     all, so it runs in the bare-Node validator. Only the render* functions touch the DOM
//     and read matchMedia (reduced-motion); the validator passes a fixed `now`.
//
// Status is conveyed by HUE and GLYPH and a TEXT LABEL together, never colour alone (WCAG
// 1.4.1); "unknown" and "disabled" are first-class states (never a stale green, spec
// section 3 / 6). Throughput maps to one of three bounded edge thicknesses, with the
// numeric value the source of truth in the label and the table. An in-flight run animates
// a flowing dash, gated under prefers-reduced-motion to a static "running" badge instead.
//
// No-custody is never weakened: the map renders names, counts, statuses and freshness
// only. Every server-supplied string (a node name, a downpipe id) reaches the DOM through
// dom.ts textContent, so there is no markup-injection surface; the SVG <text> nodes are
// set via textContent for the same reason. The component imports no engine module; the
// screen passes the data in.

import { h } from "../lib/dom.ts";
import { dataTable } from "./data-table.ts";
import { buildTopologyModel, buildTableRows } from "./topology-model.ts";
import { buildSvgFigure } from "./topology-svg.ts";
import { topologyTableColumns } from "./topology-table.ts";
import type {
  FlowRecord,
  TopologyOptions,
  TopologyModel,
  TopologyTableRow,
} from "./topology-types.ts";

// The type surface lives in the dependency-light sibling topology-types.ts; re-export it by
// name so a screen (and live-flow.ts) can import the shapes straight from this module,
// exactly as before. The render handle (TopologyHandle) is declared below, beside the render
// layer it describes, and exported directly.
export type {
  NodeKind,
  FlowEndpoint,
  FlowStatus,
  FlowRecord,
  NodeGroupSpec,
  TopologyOptions,
  ColumnSide,
  LayoutNode,
  LayoutGroup,
  StatusPresentation,
  StatusTone,
  EdgeDash,
  EdgeWeight,
  LayoutEdge,
  StatusCounts,
  TopologyModel,
  MarkerBox,
  TopologyTableRow,
} from "./topology-types.ts";
// The pure model + encoding lives in topology-model.ts; re-export the public surface by name
// so the validator and live-flow.ts keep importing it from this module (no surface change).
export {
  hasAmbientSheen,
  buildTopologyModel,
  presentStatus,
  throughputWeight,
  throughputText,
  tally,
  summaryPhrase,
  buildTableRows,
  markerBoundingBox,
  boxesIntersect,
  MARKER_BOX,
  ARROWHEAD_MARKER_ID,
} from "./topology-model.ts";
// The accessible-table column set lives in topology-table.ts; re-export it by name (the
// validator and live-flow.ts import topologyTableColumns from this module).
export { topologyTableColumns } from "./topology-table.ts";

// A module-local counter giving each renderTopology call a unique, deterministic instance
// id. Two instances on one page (the full /map AND the compact Overview embed, spec
// section 7) must not share the aria-describedby id, or the duplicate id breaks the
// association for assistive tech. Deterministic (a simple increment in render order), not
// random, so it never reads a clock or Math.random.
let topologyInstanceSeq = 0;

// The DOM render layer. Only this section touches the DOM, relative time and matchMedia.
// The pure model above is what the validator asserts; these functions are thin
// projections of it. The two projections (SVG + table) share model.edges and the full
// flow set, which is the parity contract.

export interface TopologyHandle {
  // The root to mount (figure + the accessible table + the optional cap notice).
  el: HTMLElement;
  // The computed model (the screen can read the tally for an Overview summary).
  model: TopologyModel;
  // Re-render with a new flow set (after a poll). Rebuilds the model and both projections.
  setFlows: (flows: FlowRecord[]) => void;
}

// renderTopology builds the full component: the empty state OR the SVG enhancement plus
// the always-present accessible table (plus a cap notice when the SVG is capped). The SVG
// is a pure visual: it carries role="img" + an aria-label summary + a visually-hidden
// longer description, and its shapes are NOT the keyboard/AT operable surface. The real,
// keyboard-operable controls that open a downpipe drawer are the accessible TABLE's row
// buttons (spec section 5: real buttons with accessible names, not bare SVG shapes). A
// roving-tabindex model still groups the SVG's source nodes, destination nodes and edges
// for sighted pointer/keyboard panning, but activation flows through the real buttons.
export function renderTopology(opts: TopologyOptions): TopologyHandle {
  const root = h("div", { class: "topo" });
  // A stable per-instance id suffix so two maps on one page (full /map + Overview embed,
  // spec section 7) never share the aria-describedby id. Allocated once per renderTopology
  // (not per build()), so a poll re-render keeps the same id rather than leaking ids.
  const instanceId = `topo-${++topologyInstanceSeq}`;

  let current = opts.flows;

  // build() renders into root and returns the model it built, rather than building one model
  // for the handle literal and discarding it to build another inside build() (the discarded
  // model also read a different Date.now()). The handle's model is the value build() returns.
  const build = (): TopologyModel => {
    // One instant per render, shared by the model (edge labels) and the table (last-run
    // cells), so the SVG and the table show the identical relative freshness. A poll
    // re-renders and re-resolves the instant.
    const now = opts.now ?? Date.now();
    const model = buildTopologyModel({ ...opts, flows: current, now });
    root.replaceChildren(buildBody(model, opts, current, now, instanceId));
    return model;
  };

  const handle: TopologyHandle = {
    el: root,
    model: build(),
    setFlows(flows: FlowRecord[]): void {
      current = flows;
      handle.model = build();
    },
  };

  return handle;
}

function buildBody(model: TopologyModel, opts: TopologyOptions, allFlows: FlowRecord[], now: number, instanceId: string): HTMLElement {
  const body = h("div", { class: "topo__body" });

  // Empty state (spec section 6): a calm explanation, never a blank canvas and never a
  // fake green. The accessible table also renders empty so the structure is consistent.
  if (model.counts.total === 0) {
    body.appendChild(buildEmptyState());
    body.appendChild(buildAccessibleTable(allFlows, opts, now));
    return body;
  }

  // The SVG enhancement (aria-hidden=false; it carries its own role/label). It is the
  // wide-viewport enhancement; the CSS reflows/hides it at narrow widths in favour of the
  // table. Marked as an enhancement so assistive tech is steered to the table for detail.
  body.appendChild(buildSvgFigure(model, opts, instanceId));

  // The cap notice (spec section 2: say so on screen, never silently truncate).
  if (model.capped) {
    body.appendChild(
      h(
        "p",
        { class: "topo__cap-notice field__hint", role: "note" },
        `Showing the first ${model.drawnEdgeCount} of ${model.totalEdgeCount} downpipes on the map. The table below lists all of them.`,
      ),
    );
  }

  // The canonical accessible table (always present), carrying EVERY flow.
  body.appendChild(buildAccessibleTable(allFlows, opts, now));

  return body;
}

function buildEmptyState(): HTMLElement {
  return h(
    "div",
    { class: "topo__empty card card--inset" },
    h("p", { class: "topo__empty-title" }, "No downpipes yet"),
    h(
      "p",
      { class: "field__hint" },
      "This map shows each downpipe from its source to its destination, with status, freshness and how much it moves. Configure your first downpipe to populate it.",
    ),
  );
}

// buildAccessibleTable is the canonical representation AND the operable surface: a
// data-table with one row per flow (downpipe x destination) carrying source, destination, status, last run,
// cadence, throughput, and (when onActivateEdge is supplied) a trailing REAL <button> per
// row that opens the same downpipe drawer the edge does. It always renders (even empty) and
// carries EVERY flow, which is the parity contract. The whole row stays click/Enter
// activatable as a convenience; the explicit per-row button is the real,
// accessibly-named control that AT and keyboard users rely on (spec section 5).
function buildAccessibleTable(flows: FlowRecord[], opts: TopologyOptions, now?: number): HTMLElement {
  const rows = buildTableRows(flows);
  // Titled "Flows", not "Downpipes": a row is one flow (downpipe x destination), so a fanned-out
  // downpipe contributes several rows and the count must agree with the filter bar's "N flows".
  const section = h("section", { class: "topo__table", "aria-label": "Flows, source to destination" });
  const heading = h("h3", { class: "topo__table-title" }, "Flows");
  section.appendChild(heading);

  const handle = dataTable<TopologyTableRow>({
    columns: topologyTableColumns(now, opts.onActivateEdge),
    rows,
    rowKey: (r) => r.flow.id,
    label: "Flows, source to destination, with status and freshness",
    rowLabel: (r) => `${r.flow.source.name} to ${r.flow.destination.name}`,
    filter: { placeholder: "Filter flows", resultLabel: "flows" },
    ...(opts.onActivateEdge ? { onRowActivate: (r: TopologyTableRow) => opts.onActivateEdge!(r.flow.id) } : {}),
    empty: h(
      "div",
      { class: "dp-table__empty" },
      "No downpipes configured yet. Configure your first downpipe to see it here and on the map.",
    ),
  });
  section.appendChild(handle.el);
  return section;
}