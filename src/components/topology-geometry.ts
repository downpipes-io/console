// The deterministic GEOMETRY of the topology model: the layout grid constants, the de-collision
// fan + marker constants, the SVG coordinate rounding, the node-incidence tallies, the fan and
// marker-bias maths, the cubic-Bezier point sampling, the marker bounding boxes and the marker
// de-collision pass. Split out of topology-model.ts as a dependency-light sibling so the model
// leaf stays under the size budget; topology-model.ts re-exports the public surface by name so
// no importer changes.
//
// Moved verbatim from topology-model.ts; every function, constant and threshold is byte-for-
// byte the original, so the geometry is unchanged. The whole layer touches no DOM, no clock and
// no randomness, so it is deterministic. House rules: Australian English, no em dashes, precise
// claims.

import type { LayoutEdge, MarkerBox } from "./topology-types.ts";

// ---------------------------------------------------------------------------
// Layout constants. Pure numbers; the deterministic geometry depends only on these and
// the data order (no measurement, no DOM).
// ---------------------------------------------------------------------------

// LAYOUT is the deterministic layout grid (column anchors, padding, node rhythm). The SVG
// renderer reads a few of these (the column x and the node box size) to place the group
// labels and node boxes against the same geometry the model lays out, so it is exported for
// the sibling renderer; it stays a single source of truth for the layout numbers.
export const LAYOUT = {
  // Horizontal anchors for the two columns and the canvas padding.
  padX: 24,
  colWidth: 168, // a node box's nominal width (for the viewBox + anchor maths)
  channel: 220, // the routed-edge channel between the columns
  // Vertical rhythm.
  padTop: 16,
  groupLabelH: 22, // the band a group label occupies
  groupGap: 18, // gap between one group's last node and the next group's label
  nodeH: 52, // a node row's height
  nodeGap: 10, // gap between nodes within a group
  padBottom: 16,
} as const;

// De-collision geometry (the N-sources-to-ONE-destination case, and its mirror). When
// many edges share an endpoint, terminating them all at that node's single centre point
// collapses the pipes into one indistinguishable bundle and stamps every join glyph +
// label at the same place. Two pure, deterministic mechanisms separate them:
//
//  - FAN: each edge incident on a shared node terminates (and the mirror end departs) at a
//    distinct point spread across that node's left/right edge by incident-edge index, so
//    pipes separate as they approach rather than collapsing to one point. The fan stays
//    within the node box height so the pipes still clearly land on that node.
//  - MARKER PLACEMENT: the join glyph + label ride the curve at a parameter biased toward
//    whichever endpoint is LESS convergent (so the marker inherits that end's already-
//    separated node spacing). A final deterministic pass demotes any marker whose full
//    text plate would still overlap an already-placed one to a GLYPH-ONLY marker (the
//    freshness text then lives at the source side via the accessible table and the edge
//    <title>), so no two TEXT plates ever intersect, in any topology.
// 4px top + 4px bottom; the fan stays inside the painted node box rather than touching the edge.
const FAN_NODE_PAD_Y = 8;

const FAN = {
  // The per-step vertical separation between adjacent fanned endpoints, capped so the whole
  // fan stays inside the node box (nodeH) and the pipes visibly land on that node.
  step: 12,
  maxSpan: LAYOUT.nodeH - FAN_NODE_PAD_Y, // 44: the fan band never exceeds the node box
  // The along-curve parameter the marker rides toward the less-convergent endpoint, and a
  // gentle per-edge spread for edges that share that endpoint (separates them horizontally).
  // markerTNear is kept small so the marker rides the early, source-side portion of the
  // pipe, where the source nodes' vertical spacing (>= nodeH + nodeGap) is least compressed
  // by the fan; that source spacing is what guarantees the labels clear one another in the
  // N->1 case (the every-real-deployment case).
  markerTNear: 0.24, // nearer the source (t small) when the source side is better separated
  markerTFar: 0.76, // nearer the destination (t large) when the dest side is better separated
  markerTSpread: 0.05, // per-shared-endpoint index nudge along the curve
} as const;

// The marker bounding boxes the de-collision pass (and the validator) reason about. A
// FULL-LABEL marker carries the "<status> - <freshness>" text plate; a GLYPH-ONLY marker
// carries just the status glyph. The plate is CENTRED on the marker anchor (the rendered
// <text> uses text-anchor: middle and the glyph sits at the anchor), so the box is symmetric
// about midX and runs from the glyph row above the anchor to below the label baseline. These
// are bounded constants (no text measurement, so the model stays pure and DOM-free), sized
// to the longest realistic "<status> - <freshness>" string; the renderer paints a legibility
// plate (a paint-order stroke halo) over the same span, so the no-overlap guarantee the
// validator asserts is computed from the geometry the renderer actually lays down.
export const MARKER_BOX = {
  glyphHalf: 10, // a glyph-only marker's half-extent around the anchor (a ~20px box)
  labelHalfW: 75, // half the full-label plate width; the plate spans [midX - h, midX + h]
  labelTop: 12, // the plate top above the anchor (the glyph row)
  labelDY: 22, // the label text BASELINE below the anchor (the rendered <text> y offset)
  // How far below the anchor the plate actually extends: the label baseline (labelDY) plus
  // descenders and a little padding. The box bottom is `midY + labelBottom`; this is the
  // real painted extent, kept honest so the no-overlap guarantee matches what is drawn.
  labelBottom: 30,
} as const;

// The id of the shared <defs> arrowhead marker. A persistent, motion-independent direction
// cue: an SVG marker-end on every edge pointing source -> destination, inheriting
// currentColor so it tones per status and themes for free (and is redundant with the
// column layout, not colour-only). One id per document is enough; the marker is defined
// once and referenced by all edges.
export const ARROWHEAD_MARKER_ID = "topo-arrowhead";

// round trims an SVG coordinate to two decimals (compact path data); round0n rounds to a
// whole number for the integer fields (node centres, label anchors), keeping the markup
// lean and the model's numeric fields clean integers.
export function round(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}
export function round0n(n: number): number {
  return Math.round(n);
}

// ---------------------------------------------------------------------------
// De-collision geometry helpers. All pure, deterministic, DOM/clock/randomness-free.
// ---------------------------------------------------------------------------

// countIncidence tallies how many flows touch each node (by the supplied key), so the fan
// and the marker bias know each node's degree. Input order in; deterministic.
export function countIncidence<T>(flows: T[], key: (f: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of flows) {
    const k = key(f);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

// nextIndex returns the running 0-based index for a key and advances it, so each edge gets
// a stable position within the set sharing one endpoint (first-seen order). Deterministic.
export function nextIndex(seen: Map<string, number>, key: string): number {
  const i = seen.get(key) ?? 0;
  seen.set(key, i + 1);
  return i;
}

// fanOffset spreads the `count` edges incident on one node across a bounded vertical band
// centred on the node, by this edge's index. A single edge sits dead-centre (offset 0). The
// band is bounded to the node box (FAN.maxSpan), so even a large fan still lands clearly on
// the node rather than spilling past it. Symmetric and deterministic.
export function fanOffset(index: number, count: number): number {
  if (count <= 1) return 0;
  const span = Math.min(FAN.maxSpan, (count - 1) * FAN.step);
  const stepGap = span / (count - 1);
  return round0n(-span / 2 + index * stepGap);
}

// markerParam picks the along-curve parameter t (0 at the source, 1 at the destination) for
// the join glyph + label. It rides toward whichever endpoint is LESS convergent, so the
// marker inherits that end's already-separated node spacing: nearer the SOURCE when the
// source side has no more edges than the destination side (the N->1 case), nearer the
// DESTINATION otherwise (the 1->N mirror). A gentle per-shared-endpoint nudge spreads
// markers that share an endpoint along the curve so they also separate horizontally.
export function markerParam(srcCount: number, dstCount: number, srcIdx: number, dstIdx: number): number {
  if (srcCount <= dstCount) {
    if (srcCount <= 1) return FAN.markerTNear;
    return FAN.markerTNear + FAN.markerTSpread * (srcIdx - (srcCount - 1) / 2);
  }
  if (dstCount <= 1) return FAN.markerTFar;
  return FAN.markerTFar + FAN.markerTSpread * (dstIdx - (dstCount - 1) / 2);
}

// cubicAt evaluates one axis of a cubic Bezier at parameter t (the curve uses horizontal
// control handles, so x and y are evaluated with the same formula on their own control
// values). Pure arithmetic; the marker anchor is a point ON the drawn curve.
export function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

// markerBoundingBox returns the box a marker paints, in viewBox coordinates: the wide
// "<status> - <freshness>" text plate when labelled, or the small glyph box when glyph-only.
// This is the SINGLE source the de-collision pass AND the validator reason about, so the
// "no two plates overlap" guarantee the test asserts is computed from the same geometry the
// renderer lays down (no drift). Pure: derived from the anchor and the bounded box constants
// (no DOM text measurement).
export function markerBoundingBox(midX: number, midY: number, labelled: boolean): MarkerBox {
  if (!labelled) {
    const h = MARKER_BOX.glyphHalf;
    return { x0: midX - h, y0: midY - h, x1: midX + h, y1: midY + h };
  }
  return {
    x0: midX - MARKER_BOX.labelHalfW,
    y0: midY - MARKER_BOX.labelTop,
    x1: midX + MARKER_BOX.labelHalfW,
    y1: midY + MARKER_BOX.labelBottom,
  };
}

// boxesIntersect is the standard AABB overlap test (touching edges do not count as an
// overlap, so abutting plates are allowed). Pure.
export function boxesIntersect(a: MarkerBox, b: MarkerBox): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

// decollideMarkers walks the edges in input order and demotes any whose FULL text plate
// would overlap an already-kept full plate to a glyph-only marker (edge.labelled = false).
// Kept plates accumulate; glyph-only markers carry no wide plate so they are not tracked as
// collidable text. The result: no two TEXT plates intersect in any topology, deterministic
// from input order. Mutates edge.labelled in place.
//
// The keptPlates.some() scan makes this O(n^2) in the kept-edge count. That is negligible at the
// expected scale (dozens of downpipes per account) and runs once per layout build. If a future
// release raised the edge cap into the hundreds, a row-bucket spatial index keyed by midY range
// would bound the scan; it is not needed at the current scale.
export function decollideMarkers(edges: LayoutEdge[]): void {
  const keptPlates: MarkerBox[] = [];
  for (const edge of edges) {
    const plate = markerBoundingBox(edge.midX, edge.midY, true);
    if (keptPlates.some((k) => boxesIntersect(k, plate))) {
      edge.labelled = false;
    } else {
      edge.labelled = true;
      keptPlates.push(plate);
    }
  }
}
