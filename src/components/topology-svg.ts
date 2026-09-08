// The SVG RENDER LAYER for the topology map (topology.ts is the orchestrator; this is the
// inline-SVG projection it mounts). This module is where the DOM, matchMedia (reduced
// motion) and the SVG namespace live; topology.ts keeps the empty state, the accessible
// table and the body assembly. The pure model + encoding stay in topology-model.ts, and the
// validator asserts that model, not this projection. Splitting the SVG builders out keeps
// topology.ts under the structural threshold while leaving the public surface and runtime
// behaviour identical (topology.ts imports buildSvgFigure from here; nothing else changes).
//
// This file stays the figure/layer ORCHESTRATOR. The per-part SVG builders now live in
// sibling modules to keep this file under the structural threshold: topology-svg-edges.ts
// (the edge group + the shared arrowhead defs), topology-svg-nodes.ts (the node columns +
// group labels) and topology-svg-util.ts (the SVG namespace constant, the textContent-only
// text/glyph helpers, the roving-tabindex wiring and the reduced-motion read). The only
// public export is buildSvgFigure (what topology.ts imports); the moved per-part builders are
// imported from those siblings here instead of re-declared, so behaviour is unchanged.
//
// The SVG is a PURE VISUAL enhancement (role="img"): its shapes are not the keyboard/AT
// operable surface. The real, keyboard-operable controls that open a downpipe drawer are the
// accessible TABLE's row buttons (topology.ts buildAccessibleTable; spec section 5). A
// roving-tabindex model still groups the SVG's source nodes, destination nodes and edges for
// sighted pointer/keyboard panning, but activation flows through the real table buttons.
//
// No-custody is never weakened: every server-supplied string (a node name, a downpipe id)
// reaches the DOM through dom.ts textContent (svgText in the util module), so there is no
// markup-injection surface; the SVG <text> nodes are set via textContent for the same reason.

import { h } from "../lib/dom.ts";
import { summaryPhrase } from "./topology-model.ts";
import type { TopologyOptions, TopologyModel } from "./topology-types.ts";
import { SVG_NS, applyRovingGroup, prefersReducedMotion } from "./topology-svg-util.ts";
import { buildEdge, buildArrowheadDefs } from "./topology-svg-edges.ts";
import { buildGroupLabel, buildNodeGroup } from "./topology-svg-nodes.ts";

// buildSvgFigure wraps the inline SVG in a <figure> with a visually-hidden <figcaption>
// longer description, and sets role="img" + aria-label on the SVG (the summary). The SVG
// is a PURE VISUAL enhancement (role="img"): its shapes are not the keyboard/AT operable
// surface. The real buttons that open a drawer are the accessible table's row buttons
// (spec section 5). The descId is per-instance so two maps on one page do not collide
// (spec section 7). A roving-tabindex model still groups the SVG nodes/edges for sighted
// pointer/keyboard panning; activation flows through the real table buttons.
export function buildSvgFigure(model: TopologyModel, opts: TopologyOptions, instanceId: string): HTMLElement {
  const reduced = opts.reducedMotion ?? prefersReducedMotion();

  // The figure scrolls horizontally on narrow viewports (the SVG keeps a minimum
  // width); focusable so keyboard users can scroll the clipped map (WCAG 2.1.1).
  // Activation still flows through the parity table; this is scroll access only.
  const figure = h("figure", { class: "topo__figure", tabindex: "0", "aria-label": "Topology diagram (scrollable)" });

  const { svg } = buildSvgRoot(model, instanceId, figure);
  appendSvgLayers(svg, model, opts, reduced);

  figure.appendChild(svg);
  return figure;
}

// buildSvgRoot builds the <svg> element (role="img" + the aria-label summary + the
// aria-describedby link) and appends the visually-hidden <figcaption> longer description to
// the figure. The descId is per-instance so two maps on one page do not collide (spec
// section 7). The figcaption restates the accessible-first contract so a screen-reader user
// is pointed at the table for detail.
function buildSvgRoot(model: TopologyModel, instanceId: string, figure: HTMLElement): { svg: SVGSVGElement } {
  const summary = summaryPhrase(model.counts);
  const descId = `${instanceId}-desc`;

  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("class", "topo-svg");
  svg.setAttribute("viewBox", `0 0 ${model.width} ${model.height}`);
  svg.setAttribute("width", String(model.width));
  svg.setAttribute("height", String(model.height));
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", summary);
  svg.setAttribute("aria-describedby", descId);

  // The longer description (visually hidden, referenced by the SVG). It restates the
  // accessible-first contract so a screen-reader user is pointed at the table for detail.
  figure.appendChild(
    h(
      "figcaption",
      { id: descId, class: "visually-hidden" },
      `${summary} Sources are on the left, destinations on the right, connected by one line per downpipe. Status is shown by colour paired with a text label, with a glyph reinforcing each tone. The full list with every downpipe, with a button on each row to open it, is in the table that follows.`,
    ),
  );

  return { svg };
}

// appendSvgLayers builds and appends the SVG's contents in draw order: the shared arrowhead
// <defs>, then edges first (under the nodes), then group labels, then nodes, so the nodes sit
// on top and the edges read as passing behind them. The two roving-tabindex node groups
// (sources, destinations) and the edge group are a sighted pointer/keyboard panning aid; the
// SVG's role="img" means assistive tech reads the single summary, and the real operable
// controls are the table row buttons.
function appendSvgLayers(svg: SVGSVGElement, model: TopologyModel, opts: TopologyOptions, reduced: boolean): void {
  // A persistent, motion-INDEPENDENT direction cue: a single arrowhead marker in <defs>,
  // referenced by every edge's marker-end, pointing source -> destination. It inherits
  // currentColor (fill), so it tones per status (the edge sets the colour) and themes for
  // free, and it is a SHAPE at a POSITION (the destination end), redundant with the column
  // layout, never colour-only. Defined once per SVG; arrowheads read even at rest and under
  // prefers-reduced-motion, when the flowing-dash animation is gated off.
  svg.appendChild(buildArrowheadDefs());

  // Draw order: edges first (under the nodes), then group labels, then nodes, so the nodes
  // sit on top and the edges read as passing behind them.
  const edgeLayer = document.createElementNS(SVG_NS, "g");
  edgeLayer.setAttribute("class", "topo-svg__edges");
  for (const edge of model.edges) edgeLayer.appendChild(buildEdge(edge, reduced, opts.onActivateEdge));
  svg.appendChild(edgeLayer);

  const groupLayer = document.createElementNS(SVG_NS, "g");
  groupLayer.setAttribute("class", "topo-svg__groups");
  groupLayer.setAttribute("aria-hidden", "true");
  for (const group of model.groups) groupLayer.appendChild(buildGroupLabel(group));
  svg.appendChild(groupLayer);

  // Two roving-tabindex node groups (sources, destinations) and one for the edges. Each
  // group is a focusable set where arrows move within and Tab moves between (spec 4). These
  // are a sighted pointer/keyboard panning aid; the SVG's role="img" means assistive tech
  // reads the single summary, and the real operable controls are the table row buttons.
  const sourceNodes = model.nodes.filter((n) => n.side === "source");
  const destNodes = model.nodes.filter((n) => n.side === "destination");

  const nodeLayer = document.createElementNS(SVG_NS, "g");
  nodeLayer.setAttribute("class", "topo-svg__nodes");
  const sourceGroupEl = buildNodeGroup(sourceNodes, "Source nodes", opts.onActivateNode, opts.onClearNodeFilter);
  const destGroupEl = buildNodeGroup(destNodes, "Destination nodes", opts.onActivateNode, opts.onClearNodeFilter);
  nodeLayer.appendChild(sourceGroupEl);
  nodeLayer.appendChild(destGroupEl);
  svg.appendChild(nodeLayer);

  // Apply roving tabindex to the edges as a group too.
  applyRovingGroup(edgeLayer, "g.topo-edge > .topo-edge__hit");
}
