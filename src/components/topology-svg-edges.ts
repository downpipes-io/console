// The EDGE builders for the topology SVG render layer (split out of topology-svg.ts to keep
// that file under the structural threshold). buildEdge orchestrates the per-edge group; the
// named sub-builders draw each part; buildArrowheadDefs builds the shared <defs> arrowhead
// marker every edge references. Behaviour is identical (this code moved unchanged from
// topology-svg.ts). No-custody is never weakened: every server-supplied string reaches the
// DOM through svgText (textContent), so there is no markup-injection surface.

import { hasAmbientSheen, ARROWHEAD_MARKER_ID, MARKER_BOX } from "./topology-model.ts";
import type { LayoutEdge } from "./topology-types.ts";
import { SVG_NS, svgText, svgGlyph } from "./topology-svg-util.ts";

// buildEdge draws the curved connector + the join glyph + the visible label, and overlays
// a transparent, focusable hit path that is a sighted pointer/keyboard panning target with
// a click handler as PROGRESSIVE ENHANCEMENT (not the keyboard/AT path; that is the table
// row button). The edge <g> carries a <title> with the full accessible read INCLUDING the
// running state, so the in-flight state is conveyed even on the read-only Overview embed
// (no onActivate). The flowing-dash overlay is added only when running AND motion is
// allowed; otherwise a static "running" badge with a "running" TEXT label is drawn, so the
// state reads by glyph + label + hue, never colour or shape alone. The per-part assembly is
// factored into named sub-builders below; this stays the orchestrator of the edge group.
export function buildEdge(edge: LayoutEdge, reduced: boolean, onActivate?: (id: string) => void): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", `topo-edge topo-edge--${edge.presentation.tone} topo-edge--w${edge.weight} topo-edge--${edge.presentation.dash}`);
  g.setAttribute("data-flow-id", edge.id);

  g.appendChild(buildEdgeTitle(edge));
  g.appendChild(buildEdgeLine(edge));
  const ambient = buildEdgeAmbient(edge, reduced);
  if (ambient) g.appendChild(ambient);
  if (edge.flowing) g.appendChild(buildEdgeRunning(edge, reduced));
  g.appendChild(buildEdgeMarker(edge));
  const hit = buildEdgeHit(edge, onActivate);
  if (hit) g.appendChild(hit);

  return g;
}

// buildEdgeTitle builds the <title> on the edge group: the full accessible read, plus the
// running state and the absolute last-run time when known. Present regardless of onActivate,
// so the read-only Overview embed still carries the status (incl. in-flight) for a
// hovering/AT user.
function buildEdgeTitle(edge: LayoutEdge): SVGTitleElement {
  const groupTitle = document.createElementNS(SVG_NS, "title");
  const titleParts = [edge.accessibleName];
  if (edge.flowing && !edge.accessibleName.includes("running")) titleParts.push("running now");
  if (edge.freshnessTitle) titleParts.push(`last run ${edge.freshnessTitle}`);
  groupTitle.textContent = titleParts.join(", ");
  return groupTitle;
}

// buildEdgeLine builds the visible stroke. Dash style is a class hook the CSS pass styles; we
// set a minimal inline stroke-dasharray fallback so the dashed/dotted distinction holds even
// before the CSS lands (the shape redundancy must not depend on the later pass). The
// marker-end is the persistent direction cue (source -> destination); the arrowhead inherits
// the edge's currentColor so it tones per status. It is referenced by url(#id), and the
// arrowhead shape itself reads at rest, independent of the (motion-gated) flow animation.
function buildEdgeLine(edge: LayoutEdge): SVGPathElement {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("class", "topo-edge__line");
  path.setAttribute("d", edge.path);
  path.setAttribute("fill", "none");
  path.setAttribute("marker-end", `url(#${ARROWHEAD_MARKER_ID})`);
  if (edge.presentation.dash === "dashed") path.setAttribute("stroke-dasharray", "7 5");
  else if (edge.presentation.dash === "dotted") path.setAttribute("stroke-dasharray", "1.5 5");
  return path;
}

// buildEdgeAmbient builds the IDLE ambient drift (the SVG twin of the canvas sheen): a slow,
// dim long-dash overlay in the edge's own status hue, drifting toward the destination, on
// every watched idle route (hasAmbientSheen). Decorative (aria-hidden); CSS owns the motion
// and the reduced-motion gates; not built at all when the renderer is in its reduced branch,
// hence the null return that buildEdge skips appending.
function buildEdgeAmbient(edge: LayoutEdge, reduced: boolean): SVGPathElement | null {
  if (reduced || edge.flowing || !hasAmbientSheen(edge.flow)) return null;
  const ambient = document.createElementNS(SVG_NS, "path");
  ambient.setAttribute("class", "topo-edge__ambient");
  ambient.setAttribute("d", edge.path);
  ambient.setAttribute("fill", "none");
  ambient.setAttribute("aria-hidden", "true");
  return ambient;
}

// buildEdgeRunning builds the in-flight indication: a flowing dash overlay when motion is
// allowed, else a static running badge marker at the midpoint. EITHER WAY a "running" TEXT
// label is drawn beside it so the state never relies on the (decorative, aria-hidden) dot or
// dash shape alone, and the table also carries "running". The decorative marks are
// aria-hidden. The motion-branch flow path attaches to the edge group directly (it spans the
// whole curve, not the badge), so this returns the badge group and appends the flow to `g`.
function buildEdgeRunning(edge: LayoutEdge, reduced: boolean): SVGGElement {
  const badge = document.createElementNS(SVG_NS, "g");
  badge.setAttribute("class", "topo-edge__running");
  if (!reduced) {
    const flow = document.createElementNS(SVG_NS, "path");
    flow.setAttribute("class", "topo-edge__flow");
    flow.setAttribute("d", edge.path);
    flow.setAttribute("fill", "none");
    flow.setAttribute("stroke-dasharray", "6 10");
    flow.setAttribute("aria-hidden", "true");
    badge.appendChild(flow);
  } else {
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("class", "topo-edge__running-dot");
    dot.setAttribute("cx", String(edge.midX - 26));
    dot.setAttribute("cy", String(edge.midY - 14));
    dot.setAttribute("r", "4");
    dot.setAttribute("aria-hidden", "true");
    badge.appendChild(dot);
  }
  // The accessible text equivalent for the in-flight state, present in both the motion
  // and reduced-motion branches so a running edge always reads "running" by text.
  badge.appendChild(svgText("running", edge.midX - 18, edge.midY - 10, "topo-edge__running-label"));
  return badge;
}

// buildEdgeMarker builds the join glyph + the label group (decorative; the <title> and the
// table row carry the operable meaning). The glyph is the status SHAPE; the text is the
// status + freshness. The marker rides the curve biased toward the less-convergent endpoint
// (edge.midX/midY), so it does not collapse onto a shared node. When the de-collision pass
// demoted a crowded edge to glyph-only (edge.labelled === false), the wide text plate is
// omitted so no two plates overlap; the freshness still reads from the always-present table
// and the edge <title>, and the status remains conveyed by the glyph (shape) here plus the
// table's hue + label. The marker carries a class hook so the CSS pass can paint a legibility
// plate behind the text exactly the size markerBoundingBox reserves.
function buildEdgeMarker(edge: LayoutEdge): SVGGElement {
  const marker = document.createElementNS(SVG_NS, "g");
  marker.setAttribute("class", edge.labelled ? "topo-edge__marker" : "topo-edge__marker topo-edge__marker--glyph-only");
  marker.setAttribute("aria-hidden", "true");
  marker.setAttribute("transform", `translate(${edge.midX}, ${edge.midY})`);
  marker.appendChild(svgGlyph(edge.presentation.glyph));
  if (edge.labelled) {
    // When the freshness phrase already states the status word ("status unknown"), the
    // joined form would read "unknown - status unknown"; say it once.
    const labelJoin = edge.freshnessLabel.toLowerCase().includes(edge.presentation.label.toLowerCase())
      ? edge.freshnessLabel
      : `${edge.presentation.label} - ${edge.freshnessLabel}`;
    const labelText = svgText(labelJoin, 0, MARKER_BOX.labelDY, "topo-edge__label");
    marker.appendChild(labelText);
  }
  return marker;
}

// buildEdgeHit builds the hit target: a wide, transparent path over the curve. It is a
// sighted pointer/keyboard panning target (roving group sets one tabindex to 0) with a
// click/Enter/Space handler as PROGRESSIVE ENHANCEMENT only; it is NOT role="button" and is
// hidden from assistive tech (the SVG is role="img"; the operable control is the table row
// button). Returns null when no onActivate handler is supplied (the read-only Overview embed).
function buildEdgeHit(edge: LayoutEdge, onActivate?: (id: string) => void): SVGPathElement | null {
  if (!onActivate) return null;
  const hit = document.createElementNS(SVG_NS, "path");
  hit.setAttribute("class", "topo-edge__hit");
  hit.setAttribute("d", edge.path);
  hit.setAttribute("fill", "none");
  hit.setAttribute("stroke", "transparent");
  hit.setAttribute("stroke-width", "16");
  hit.setAttribute("aria-hidden", "true");
  hit.setAttribute("tabindex", "-1"); // roving group sets one to 0
  const activate = () => onActivate(edge.id);
  hit.addEventListener("click", activate);
  hit.addEventListener("keydown", (ev: Event) => {
    const ke = ev as KeyboardEvent;
    if (ke.key === "Enter" || ke.key === " ") {
      ke.preventDefault();
      activate();
    }
  });
  return hit;
}

// buildArrowheadDefs builds the shared <defs> with the single source -> destination
// arrowhead marker every edge references via marker-end. The arrowhead fill is currentColor
// so it inherits the edge's tone (the CSS pass sets `color` on the edge group, and an SVG
// marker's contents resolve currentColor against the element that references the marker), so
// it tones per status and themes for free, with no per-edge marker and no colour-only cue
// (it is a shape at the destination end, redundant with the column layout). orient="auto"
// turns it to follow the curve's arrival direction; the curve arrives horizontally at the
// destination, so the arrow points into the destination node. markerUnits="userSpaceOnUse"
// keeps a constant arrow size regardless of the edge's stroke-width (throughput weight), so
// a thick pipe does not get an oversized head.
export function buildArrowheadDefs(): SVGDefsElement {
  const defs = document.createElementNS(SVG_NS, "defs") as SVGDefsElement;
  const marker = document.createElementNS(SVG_NS, "marker");
  marker.setAttribute("id", ARROWHEAD_MARKER_ID);
  marker.setAttribute("viewBox", "0 0 10 10");
  // Anchor the arrow's tip a little before the path end so the head sits at the node edge
  // rather than overshooting into it; the y ref centres the head on the stroke.
  marker.setAttribute("refX", "8");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "7");
  marker.setAttribute("markerHeight", "7");
  marker.setAttribute("orient", "auto");
  marker.setAttribute("markerUnits", "userSpaceOnUse");
  const tip = document.createElementNS(SVG_NS, "path");
  // A simple filled triangle pointing in the +x (travel) direction.
  tip.setAttribute("d", "M0 1 L9 5 L0 9 Z");
  tip.setAttribute("fill", "currentColor");
  tip.setAttribute("class", "topo-edge__arrowhead");
  marker.appendChild(tip);
  defs.appendChild(marker);
  return defs;
}
