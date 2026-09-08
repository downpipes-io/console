// The NODE + group-label builders for the topology SVG render layer (split out of
// topology-svg.ts to keep that file under the structural threshold). buildNodeGroup builds
// one roving-tabindex column; buildNode draws a single node; wireNodeInteractivity attaches
// the title and the (progressive-enhancement) activation; kindGlyph maps a kind to a glyph.
// Behaviour is identical (this code moved unchanged from topology-svg.ts). No-custody is
// never weakened: every server-supplied string reaches the DOM through svgText (textContent),
// so there is no markup-injection surface.

import { ICON_INFO, ICON_DOWNPIPES } from "../lib/icons.ts";
import { kindWord, LAYOUT } from "./topology-model.ts";
// destDownReasonLabel is the SAME mapping the drawer's Copies row uses (distinctDownReasonLabels),
// so the node's danger line and accessible name never disagree with the drawer about why a destination
// is down. Imported from replication.ts directly (not via the topology.ts barrel, which pulls in this
// very renderer) - replication.ts is a pure, DOM-free sibling, so this stays a one-way import.
import { destDownReasonLabel } from "./replication.ts";
import type { NodeKind, LayoutNode, LayoutGroup } from "./topology-types.ts";
import { SVG_NS, svgText, svgGlyph, applyRovingGroup } from "./topology-svg-util.ts";

export function buildGroupLabel(group: LayoutGroup): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "topo-svg__group");
  // Centre the caption above its OWN column for BOTH sides (text-anchor:middle in CSS) so the source and
  // destination labels sit in the SAME place relative to their nodes. Previously both were left-aligned at
  // the column's left edge, which read inconsistently (beside the wide source column, beneath the far
  // destination column). The column's left edge is padX (source) or padX+colWidth+channel (destination);
  // its centre is that plus half a node box.
  const colLeft = group.side === "source" ? LAYOUT.padX : LAYOUT.padX + LAYOUT.colWidth + LAYOUT.channel;
  g.appendChild(svgText(group.label, colLeft + LAYOUT.colWidth / 2, group.labelY + 14, "topo-svg__group-label"));
  return g;
}

// buildNodeGroup builds one roving-tabindex set of nodes (a column). Each node carries a
// kind glyph, the name, and the secondary line; activating it (pointer/keyboard panning
// enhancement) filters the map to its flows. Arrow keys move within the group; Escape
// clears the node filter (spec section 4) via onClearNodeFilter when supplied.
export function buildNodeGroup(nodes: LayoutNode[], groupLabel: string, onActivate?: (id: string) => void, onClearNodeFilter?: () => void): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "topo-svg__nodegroup");
  g.setAttribute("role", "group");
  g.setAttribute("aria-label", groupLabel);

  nodes.forEach((node) => {
    g.appendChild(buildNode(node, onActivate));
  });
  applyRovingGroup(g, ".topo-node");

  // Escape clears a node filter (spec section 4). Wired at the group level so it fires for
  // whichever node currently holds the roving focus. Guarded so it only acts when a clear
  // handler is supplied (otherwise Escape is a no-op and bubbles normally).
  if (onClearNodeFilter) {
    g.addEventListener("keydown", (ev: Event) => {
      const ke = ev as KeyboardEvent;
      if (ke.key === "Escape" || ke.key === "Esc") {
        ke.preventDefault();
        onClearNodeFilter();
      }
    });
  }
  return g;
}

function buildNode(node: LayoutNode, onActivate?: (id: string) => void): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", `topo-node topo-node--${node.side} topo-node--${node.kind}${node.down ? " topo-node--down" : ""}`);
  g.setAttribute("data-node-id", node.id);
  g.setAttribute("transform", `translate(${node.x}, ${node.y})`);

  const w = LAYOUT.colWidth;
  const half = w / 2;
  const boxH = LAYOUT.nodeH;

  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("class", "topo-node__box");
  rect.setAttribute("x", String(-half));
  rect.setAttribute("y", String(-boxH / 2));
  rect.setAttribute("width", String(w));
  rect.setAttribute("height", String(boxH));
  rect.setAttribute("rx", "8");
  g.appendChild(rect);

  // The kind glyph (shape) + the name + the secondary line (all text via textContent). MIRROR the
  // content across the channel so the two columns read as a true left<->right pair: the source column
  // hugs its OUTER (left) edge, the destination column hugs its OUTER (right) edge. Both sides used to
  // anchor the icon+text to the LEFT of the box, so the destination column's identical placement drifted
  // toward the centre channel instead of mirroring the source, the asymmetry the operator reported
  // ("sources left of the node, destinations not"). The glyph is 16px (svgGlyph), inset 14px from the
  // box's outer edge; the text starts 34px in. The destination text-anchor is flipped to "end" in CSS
  // (.topo-node--destination), so a destination name at +half-34 right-aligns and flows toward the centre,
  // exactly mirroring a source name at -half+34 that left-aligns and flows toward the centre.
  const isDest = node.side === "destination";
  const glyphX = isDest ? half - 30 : -half + 14;
  const textX = isDest ? half - 34 : -half + 34;

  const glyphG = document.createElementNS(SVG_NS, "g");
  glyphG.setAttribute("class", "topo-node__glyph");
  glyphG.setAttribute("aria-hidden", "true");
  glyphG.setAttribute("transform", `translate(${glyphX}, ${-7})`);
  glyphG.appendChild(svgGlyph(kindGlyph(node.kind)));
  g.appendChild(glyphG);

  g.appendChild(svgText(node.name, textX, -2, "topo-node__name"));
  const kindLine = node.secondary ? `${kindWord(node.kind)} - ${node.secondary}` : kindWord(node.kind);
  // A reachable node shows its muted "KIND - secondary" line; a DOWN destination replaces it with a
  // danger-toned line naming WHY (B30), so the outage is stated in WORDS (not colour alone) right on the
  // node, matching the drawer's Copies row instead of leaving the operator to open the drawer to find out.
  // destDownReasonLabel returns null for a generic/absent/unrecognised reason; the fallback is the
  // original bare "down - KIND" text, so this never renders a dangling "down - " with nothing after it.
  const downReasonLabel = node.down ? destDownReasonLabel(node.downReason) : null;
  const downLine = downReasonLabel ? `down - ${downReasonLabel}` : `down - ${kindWord(node.kind)}`;
  g.appendChild(node.down ? svgText(downLine, textX, 14, "topo-node__down") : svgText(kindLine, textX, 14, "topo-node__secondary"));

  wireNodeInteractivity(g, node, onActivate);
  return g;
}

// wireNodeInteractivity attaches the node's <title> (the node read: name, kind, incident
// count, for a hovering pointer user), marks the group aria-hidden, and wires the
// pointer/keyboard activation when filtering is enabled. The node is NOT a bare-shape ARIA
// button: the SVG is role="img" and the operable surface is the table. When filtering is
// enabled the node is a sighted pointer/keyboard panning target (roving tabindex,
// click/Enter/Space filter the map) as a progressive enhancement; it is aria-hidden so
// assistive tech is not given a bare-shape control.
function wireNodeInteractivity(g: SVGGElement, node: LayoutNode, onActivate?: (id: string) => void): void {
  const count = node.flowIds.length;
  // B30: the accessible name GAINS the down reason (the same destDownReasonLabel mapping the visible node
  // line and the drawer use) rather than losing the existing "currently unreachable" wording; a
  // generic/absent reason leaves the phrase exactly as it read before.
  const downReasonLabel = node.down ? destDownReasonLabel(node.downReason) : null;
  const downPhrase = node.down ? `, currently unreachable${downReasonLabel ? ` (${downReasonLabel})` : ""}` : "";
  const accessibleName = `${node.name}, ${kindWord(node.kind)}, ${count} ${count === 1 ? "downpipe" : "downpipes"}${node.secondary ? `, ${node.secondary}` : ""}${downPhrase}`;
  const nodeTitle = document.createElementNS(SVG_NS, "title");
  nodeTitle.textContent = accessibleName;
  g.appendChild(nodeTitle);
  g.setAttribute("aria-hidden", "true");
  if (onActivate) {
    g.setAttribute("tabindex", "-1"); // roving group sets one to 0
    const activate = () => onActivate(node.id);
    g.addEventListener("click", activate);
    g.addEventListener("keydown", (ev: Event) => {
      const ke = ev as KeyboardEvent;
      if (ke.key === "Enter" || ke.key === " ") {
        ke.preventDefault();
        activate();
      }
    });
  }
}

// kindGlyph maps a node kind to a glyph (shape redundancy alongside the kind label). The
// downpipes mark stands in for a generic data node; unknown kinds get the info glyph.
function kindGlyph(kind: NodeKind): string {
  switch (kind) {
    case "kv":
    case "r2":
    case "d1":
    case "s3":
      return ICON_DOWNPIPES;
    case "secrets":
      return ICON_INFO;
    case "other":
      return ICON_INFO;
  }
}
