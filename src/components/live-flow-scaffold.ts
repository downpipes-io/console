// The static DOM scaffold + the topology-options projection for the live-flow canvas view
// (extracted from live-flow.ts to keep that file and renderCanvasView under the structural
// threshold; behaviour-preserving move only). These build the elements/options that depend ONLY on
// opts (never on the per-poll controller/model state), so the renderer's wiring stays focused.

import { h } from "../lib/dom.ts";
import { tally, summaryPhrase, type FlowRecord, type TopologyOptions } from "./topology.ts";
import type { LiveFlowOptions } from "./live-flow-types.ts";

// toTopologyOptions maps the live-flow options onto the SVG topology's options for a fallback
// render, copying only the keys the caller actually supplied (so an undefined never overwrites a
// topology default). The same projection is needed by the initial WebGL-unavailable branch and by
// the in-place degrade after a failed canvas init, so it is one named helper, not two copies.
export function toTopologyOptions(opts: LiveFlowOptions, flows: FlowRecord[]): TopologyOptions {
  return {
    flows,
    ...(opts.onActivateEdge ? { onActivateEdge: opts.onActivateEdge } : {}),
    ...(opts.onActivateNode ? { onActivateNode: opts.onActivateNode } : {}),
    ...(opts.onClearNodeFilter ? { onClearNodeFilter: opts.onClearNodeFilter } : {}),
    ...(opts.reducedMotion !== undefined ? { reducedMotion: opts.reducedMotion } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };
}

// The static DOM scaffold of the canvas view: the elements that depend only on opts (never on the
// per-poll controller/model state). Pure construction: the same elements, attributes and structure
// as the original inline scaffold, just assembled here.
export interface CanvasScaffold {
  root: HTMLElement;
  figure: HTMLElement;
  canvas: HTMLCanvasElement;
  nodeLayer: HTMLElement;
  emptyNote: HTMLElement;
  tableHost: HTMLElement;
}

export function buildCanvasScaffold(opts: LiveFlowOptions): CanvasScaffold {
  const root = h("div", { class: opts.compact ? "live-flow live-flow--compact" : "live-flow" });

  // tabindex and role match the console's existing accessible-scroller pattern (see
  // src/screens/onboarding/team.ts, the invite-link row): a box that scrolls horizontally must be
  // focusable, or a keyboard user cannot reach the content the scrollbar exposes to a mouse.
  const figure = h("figure", {
    class: "live-flow__figure",
    tabindex: "0",
    role: "region",
    "aria-label": "Data flow diagram, scrolls horizontally on narrow screens",
  });
  const canvas = document.createElement("canvas");
  canvas.className = "live-flow__canvas";
  canvas.setAttribute("role", "img");
  // The summary aria-label is built from COUNTS ONLY (no server names on the canvas); the
  // detail lives in the table the figure is paired with.
  canvas.setAttribute("aria-label", summaryPhrase(tally(opts.flows)));

  // The stage pairs the canvas with the DOM NODE LAYER: HTML labels + anchor dots positioned
  // by the model's normalised coordinates (left/top percentages track the canvas box through
  // any resize with no JS). The GL canvas draws pipes, streams and the hub ring; the LAYER is
  // what makes the endpoints legible (the original canvas marked nodes only with ~6px slate
  // discs at 0.4 alpha and no names at all, so the map read as bare curves with no node names
  // at all). DOM text stays crisp at any DPR, follows
  // the theme tokens, and keeps every server string on the textContent path. When the caller
  // wires onActivateNode the labels are real buttons (activate to filter, Escape to clear),
  // the same affordance the SVG topology's nodes carry; otherwise (the read-only embeds) the
  // layer is decorative and hidden from assistive tech, whose canonical surface is the table.
  const stage = h("div", { class: "live-flow__stage" });
  const nodeLayer = h(
    "div",
    {
      class: "live-flow__nodes",
      ...(opts.onActivateNode ? {} : { "aria-hidden": "true" }),
      on: {
        keydown: (ev: Event) => {
          if ((ev as KeyboardEvent).key === "Escape" && opts.onClearNodeFilter) opts.onClearNodeFilter();
        },
      },
    },
  );
  stage.appendChild(canvas);
  stage.appendChild(nodeLayer);
  figure.appendChild(stage);

  // The visually-hidden caption restating the accessible-first contract (steer AT to the
  // table), mirroring the SVG figure's figcaption.
  figure.appendChild(
    h(
      "figcaption",
      { class: "visually-hidden" },
      `${summaryPhrase(tally(opts.flows))} Sources are on the left, the engine in the centre, and destinations on the right, with a flowing stream per running downpipe. Status is shown by colour and an icon. The full list with every downpipe, with a button on each row to open it, is in the table that follows.`,
    ),
  );

  // The empty state (honest, calm; never a blank casino, never a fake green). When there are
  // no flows the canvas would draw nothing, so we show the same calm explanation the SVG map
  // does, and still render the (empty) accessible table beneath for a consistent structure.
  // Always mounted; build() toggles it (and hides the would-be-blank figure) so a poll that
  // empties or populates the account keeps the view honest in both directions.
  const emptyNote = h(
    "div",
    { class: "live-flow__empty card card--inset" },
    h("p", { class: "live-flow__empty-title" }, "No downpipes yet"),
    h(
      "p",
      { class: "field__hint" },
      "This live-flow view shows each downpipe streaming from its source through the engine to its destination. Configure your first downpipe to populate it.",
    ),
  );

  root.appendChild(figure);
  root.appendChild(emptyNote);

  // The canonical accessible table (always present), carrying EVERY flow, built from the shared
  // spec the validator also reads. This is the parity floor: the visual is an enhancement over
  // this table, never a replacement.
  const tableHost = h("div", { class: "live-flow__table" });
  root.appendChild(tableHost);

  return { root, figure, canvas, nodeLayer, emptyNote, tableHost };
}
