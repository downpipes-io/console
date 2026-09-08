// The PURE MODEL LAYER of the topology map (topology.ts): the deterministic data -> layout +
// status/throughput encoding, with the de-collision geometry and the freshness phrasing. This
// is the single source both the SVG renderer and the accessible table read; the validator
// asserts against it. Split out of topology.ts as a dependency-light sibling so the renderer
// stays under the size budget and the map data leaf can import the encoding without the DOM.
//
// The model builder lives here; the STATUS/THROUGHPUT/FRESHNESS encoding lives in
// topology-encoding.ts and the layout/de-collision GEOMETRY lives in topology-geometry.ts,
// both dependency-light siblings split out so this leaf stays under the size budget. The split
// moved the logic here without behaviour change; topology.ts now re-exports from this module
// rather than keeping its own copy, so there is no second copy to keep in sync. This file also
// re-exports the moved sibling surface by name so topology.ts and the validators keep
// importing it from here unchanged. The whole layer touches no DOM, no clock (beyond an
// explicit `now`) and no randomness, so it runs in the bare-Node validator and is
// deterministic. House rules: Australian English, no em dashes, precise claims.

import type {
  NodeKind,
  FlowEndpoint,
  FlowRecord,
  NodeGroupSpec,
  TopologyOptions,
  ColumnSide,
  LayoutNode,
  LayoutGroup,
  LayoutEdge,
  TopologyModel,
  TopologyTableRow,
} from "./topology-types.ts";
import {
  presentStatus,
  throughputWeight,
  tally,
  defaultKindLabel,
  freshnessPhrase,
  absoluteTimeOrEmpty,
  buildAccessibleName,
} from "./topology-encoding.ts";
import {
  LAYOUT,
  round,
  round0n,
  countIncidence,
  nextIndex,
  fanOffset,
  markerParam,
  cubicAt,
  decollideMarkers,
} from "./topology-geometry.ts";

// Re-export the moved public surface by name so topology.ts, topology-table.ts, live-flow.ts
// and the validators keep importing every symbol from this module exactly as before. The
// encoding and the geometry now live in dependency-light siblings; the public API here is
// unchanged.
export {
  presentStatus,
  throughputWeight,
  throughputText,
  tally,
  summaryPhrase,
  relativeFrom,
  toMsLocal,
  kindWord,
} from "./topology-encoding.ts";
export {
  LAYOUT,
  MARKER_BOX,
  ARROWHEAD_MARKER_ID,
  markerBoundingBox,
  boxesIntersect,
} from "./topology-geometry.ts";

// hasAmbientSheen decides which edges carry IDLE ambient motion (the SVG drift overlay here;
// the canvas sheen in live-flow.ts, which re-exports this so the two views share ONE rule).
// Honest by construction: the motion rides the edge's OWN status hue, claiming only what the
// edge already claims - a configured, enabled route the engine is watching is alive between
// runs (healthy, stale, and yes unknown: a young account's first route must not read dead).
// A FLOWING edge takes the bright trust stream/dash INSTEAD (the exclusive in-flight signal);
// failed and disabled edges stay inert (the red and the stillness ARE their statements). Pure.
// G299: a "no-copy" lane is DELIBERATELY absent from both allow-lists here (and from the flowing-dash
// predicate below): the engine has never reported a copy on that destination, so the lane has never carried
// anything, and animating it (in either register) would claim a liveness that has never existed. The stillness
// is the statement, exactly as it is for a failed edge.
export function hasAmbientSheen(flow: FlowRecord): boolean {
  if (flow.running && (flow.status === "healthy" || flow.status === "stale" || flow.status === "partial" || flow.status === "unknown")) return false;
  return flow.enabled && (flow.status === "healthy" || flow.status === "stale" || flow.status === "partial" || flow.status === "unknown");
}

// ---------------------------------------------------------------------------
// The PURE model builder. No DOM, no clock, no randomness.
// ---------------------------------------------------------------------------

export function buildTopologyModel(opts: TopologyOptions): TopologyModel {
  const flows = opts.flows;
  const totalEdgeCount = flows.length;
  // The freshness clock. Explicit when supplied (the validator pins it); otherwise the
  // current time. relativeTime reads Date.now internally; passing it the same `now` keeps
  // the relative and absolute phrases consistent and the model deterministic per `now`.
  const now = opts.now ?? Date.now();

  // Apply the optional edge cap deterministically (the first N in input order). The FULL
  // set still reaches the table; only the SVG is capped (spec section 2). prioritiseFlows
  // is intentionally NOT applied here so the cap is a stable, explainable head-of-list;
  // a screen wanting "failed first" sorts its input before calling.
  const cap = opts.maxEdges;
  const drawnFlows = cap !== undefined && flows.length > cap ? flows.slice(0, cap) : flows;
  const capped = drawnFlows.length < totalEdgeCount;

  // --- 1. collect the distinct nodes per side, in first-seen order (deterministic). ---
  const sourceNodes = collectNodes("source", drawnFlows, (f) => f.source);
  const destNodes = collectNodes("destination", drawnFlows, (f) => f.destination);

  // --- 2. order the nodes into groups by kind, honouring an explicit group order. ---
  const sourceGrouped = groupNodes("source", sourceNodes, opts.sourceGroups);
  const destGrouped = groupNodes("destination", destNodes, opts.destinationGroups);

  // --- 3. lay out each column vertically (group label band, then its nodes). ---
  const sourceX = LAYOUT.padX + LAYOUT.colWidth / 2;
  const destX = LAYOUT.padX + LAYOUT.colWidth + LAYOUT.channel + LAYOUT.colWidth / 2;

  const placedSources = placeColumn(sourceGrouped, sourceX);
  const placedDests = placeColumn(destGrouped, destX);

  const nodes: LayoutNode[] = [...placedSources.nodes, ...placedDests.nodes];
  const groups: LayoutGroup[] = [...placedSources.groups, ...placedDests.groups];

  // A lookup from a node id to its placed position (for the edge anchors).
  const nodeById = new Map<string, LayoutNode>();
  for (const n of nodes) nodeById.set(n.id, n);

  // --- 4 + 5. build the edges from the drawn flows (status + throughput encoding, the fan
  // and marker geometry, the de-collision pass), then wire each node's incident flow ids. ---
  const edges = buildEdges(drawnFlows, nodeById, now);

  // --- 6. the canvas size for the summary (the status tally is computed inline below). ---
  const { width, height } = canvasSize(placedSources.bottom, placedDests.bottom);

  return {
    nodes,
    groups,
    edges,
    counts: tally(flows),
    width,
    height,
    drawnEdgeCount: drawnFlows.length,
    totalEdgeCount,
    capped,
  };
}

// canvasSize derives the SVG canvas width and height from the two columns' bottoms. The width
// is fixed by the column + channel layout; the height is the taller column's content bottom
// (never less than one node row) plus the bottom pad.
function canvasSize(sourceBottom: number, destBottom: number): { width: number; height: number } {
  const contentBottom = Math.max(sourceBottom, destBottom, LAYOUT.padTop + LAYOUT.nodeH);
  const width = LAYOUT.padX + LAYOUT.colWidth + LAYOUT.channel + LAYOUT.colWidth + LAYOUT.padX;
  const height = contentBottom + LAYOUT.padBottom;
  return { width, height };
}

// buildEdges builds the layout edges from the DRAWN (post-cap) flows against the placed
// nodes: the status + throughput encoding, the fanned cubic curve, the marker anchor biased
// toward the less-convergent endpoint, the freshness phrasing, then the de-collision pass and
// the per-node incident-flow wiring. Everything here is over the drawn flows, so the fan and
// the incidence counts reflect exactly what is on the canvas (a capped-out edge neither fans
// nor crowds the markers, and still reaches the full table, section 2). It mutates the placed
// nodes' flowIds in place (step 5), matching the original inline logic byte-for-byte.
function buildEdges(drawnFlows: FlowRecord[], nodeById: Map<string, LayoutNode>, now: number): LayoutEdge[] {
  const rightEdgeX = LAYOUT.padX + LAYOUT.colWidth; // right edge of the source column
  const leftEdgeX = LAYOUT.padX + LAYOUT.colWidth + LAYOUT.channel; // left edge of dest col

  // Incidence over the drawn flows: how many edges touch each source/destination node, and
  // this edge's running index among the edges that share that node (both in input order, so
  // deterministic). These drive the fan and the marker bias: the FAN spreads the shared end
  // by index, and the marker rides toward whichever end is LESS convergent.
  const srcIncidence = countIncidence(drawnFlows, (f) => endpointNodeId("source", f.source));
  const dstIncidence = countIncidence(drawnFlows, (f) => endpointNodeId("destination", f.destination));
  const srcSeen = new Map<string, number>();
  const dstSeen = new Map<string, number>();

  const edges: LayoutEdge[] = [];
  for (const flow of drawnFlows) {
    const sId = endpointNodeId("source", flow.source);
    const dId = endpointNodeId("destination", flow.destination);
    const sNode = nodeById.get(sId);
    const dNode = nodeById.get(dId);
    if (!sNode || !dNode) continue; // defensive; collectNodes guarantees both exist

    const presentation = presentStatus(flow.status);
    const weight = throughputWeight(flow.bytesPerRun);
    const flowing = flow.running && (flow.status === "healthy" || flow.status === "stale" || flow.status === "partial" || flow.status === "unknown");

    // This edge's position within the set sharing each endpoint, and those set sizes.
    const sCount = srcIncidence.get(sId) ?? 1;
    const dCount = dstIncidence.get(dId) ?? 1;
    const sIdx = nextIndex(srcSeen, sId);
    const dIdx = nextIndex(dstSeen, dId);

    // The curve: a cubic from the source node's right edge to the destination node's left
    // edge, with horizontal control handles in the channel so edges read as smooth pipes.
    // FAN both ends by incident-edge index so converging pipes separate as they approach a
    // shared node (and diverging pipes separate as they leave one): the single-destination
    // case no longer collapses every edge onto one point.
    const x1 = rightEdgeX;
    const y1 = sNode.y + fanOffset(sIdx, sCount);
    const x2 = leftEdgeX;
    const y2 = dNode.y + fanOffset(dIdx, dCount);
    const cx = (x1 + x2) / 2;
    const path = `M${round(x1)} ${round(y1)} C${round(cx)} ${round(y1)} ${round(cx)} ${round(y2)} ${round(x2)} ${round(y2)}`;

    // The marker anchor rides the curve toward the LESS convergent endpoint, so it inherits
    // that end's already-separated node spacing (in the N->1 case that is the source side;
    // in the 1->N mirror it is the destination side). A gentle per-shared-endpoint nudge
    // spreads markers that share an endpoint horizontally too.
    const t = markerParam(sCount, dCount, sIdx, dIdx);
    const midX = round0n(cubicAt(x1, cx, cx, x2, t));
    const midY = round0n(cubicAt(y1, y1, y2, y2, t));

    const freshnessLabel = freshnessPhrase(flow, now);
    const freshnessTitle = absoluteTimeOrEmpty(flow.lastRunAt);
    const accessibleName = buildAccessibleName(flow, presentation, freshnessLabel);

    edges.push({
      id: flow.id,
      sourceNodeId: sId,
      destinationNodeId: dId,
      flow,
      presentation,
      weight,
      flowing,
      path,
      midX,
      midY,
      // Provisionally full-labelled; the de-collision pass below may demote crowded ones.
      labelled: true,
      accessibleName,
      freshnessLabel,
      // Non-optional: "" when the flow has never run / has no parseable time (the renderer
      // checks for "" before adding a <title>), so there is no undefined to assign.
      freshnessTitle,
    });
  }

  // De-collision pass: in input order, keep an edge's FULL text plate only if it would not
  // overlap an already-kept full plate; otherwise demote it to a glyph-only marker (its
  // freshness still reads from the table and the edge <title>). Pure and deterministic
  // (stable input order), so no two TEXT plates ever intersect, in any topology. Glyph-only
  // markers carry no wide plate, so they do not crowd. This is the brief's graceful
  // degradation for a very dense convergence; the common N->1 fan keeps every label.
  decollideMarkers(edges);

  // --- 5. wire each node's incident flow ids (drives filtering + the node count). ---
  for (const edge of edges) {
    nodeById.get(edge.sourceNodeId)?.flowIds.push(edge.id);
    nodeById.get(edge.destinationNodeId)?.flowIds.push(edge.id);
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Pure layout helpers.
// ---------------------------------------------------------------------------

// endpointNodeId derives the stable, collision-safe id for an endpoint. Encoding the side
// and kind means a source and a destination of the same name are distinct nodes, and the
// id is reproducible from the data alone (no counter, no randomness).
function endpointNodeId(side: ColumnSide, ep: FlowEndpoint): string {
  return `${side}:${ep.kind}:${ep.name}`;
}

interface CollectedNode {
  id: string;
  side: ColumnSide;
  kind: NodeKind;
  name: string;
  secondary?: string;
  down?: boolean;
  // Threaded from FlowEndpoint.downReason through to LayoutNode.downReason (topology-types.ts).
  downReason?: string;
}

// collectNodes gathers the distinct endpoints on one side in first-seen order. The first
// occurrence's secondary line wins (the screen passes a single descriptor per node). A node is marked
// DOWN if ANY incident flow's endpoint is down (a destination shared by several downpipes reads down the
// moment one of them cannot reach it), so the badge never under-reports an outage.
function collectNodes(side: ColumnSide, flows: FlowRecord[], pick: (f: FlowRecord) => FlowEndpoint): CollectedNode[] {
  const seen = new Map<string, CollectedNode>();
  for (const f of flows) {
    const ep = pick(f);
    const id = endpointNodeId(side, ep);
    const existing = seen.get(id);
    if (!existing) {
      seen.set(id, {
        id,
        side,
        kind: ep.kind,
        name: ep.name,
        ...(ep.secondary !== undefined ? { secondary: ep.secondary } : {}),
        ...(ep.down ? { down: true } : {}),
        // B30: the first down reason seen for this node wins (mirrors "secondary" above), so a node
        // shared by several downpipes reads one settled reason rather than flickering with input order.
        ...(ep.down && ep.downReason !== undefined ? { downReason: ep.downReason } : {}),
      });
    } else if (ep.down) {
      existing.down = true;
      if (existing.downReason === undefined && ep.downReason !== undefined) existing.downReason = ep.downReason;
    }
  }
  return [...seen.values()];
}

interface GroupedColumn {
  side: ColumnSide;
  groups: Array<{ kind: NodeKind; label: string; nodes: CollectedNode[] }>;
}

// groupNodes clusters a column's nodes by kind. An explicit group spec fixes the order and
// labels (and may introduce a deliberately empty group, which is dropped); otherwise the
// groups follow first-seen kind order with a derived label. Within a group, node order is
// first-seen (deterministic).
function groupNodes(side: ColumnSide, nodes: CollectedNode[], spec: NodeGroupSpec[] | undefined): GroupedColumn {
  const byKind = new Map<NodeKind, CollectedNode[]>();
  const kindOrder: NodeKind[] = [];
  for (const n of nodes) {
    let bucket = byKind.get(n.kind);
    if (!bucket) {
      bucket = [];
      byKind.set(n.kind, bucket);
      kindOrder.push(n.kind);
    }
    bucket.push(n);
  }

  const groups: GroupedColumn["groups"] = [];
  if (spec?.length) {
    // Explicit order first; any kinds present in the data but absent from the spec follow
    // in first-seen order (never dropped).
    const usedKinds = new Set<NodeKind>();
    for (const g of spec) {
      const bucket = byKind.get(g.kind);
      if (bucket?.length) {
        groups.push({ kind: g.kind, label: g.label, nodes: bucket });
        usedKinds.add(g.kind);
      }
    }
    for (const kind of kindOrder) {
      if (usedKinds.has(kind)) continue;
      const bucket = byKind.get(kind)!;
      groups.push({ kind, label: defaultKindLabel(kind), nodes: bucket });
    }
  } else {
    for (const kind of kindOrder) {
      groups.push({ kind, label: defaultKindLabel(kind), nodes: byKind.get(kind)! });
    }
  }
  return { side, groups };
}

interface PlacedColumn {
  nodes: LayoutNode[];
  groups: LayoutGroup[];
  bottom: number;
}

// placeColumn assigns deterministic (x, y) positions down a column: each group emits a
// label band then its nodes, with fixed rhythm. y is the node's vertical centre.
function placeColumn(column: GroupedColumn, x: number): PlacedColumn {
  const outNodes: LayoutNode[] = [];
  const outGroups: LayoutGroup[] = [];
  let cursor = LAYOUT.padTop;

  column.groups.forEach((g, gi) => {
    if (gi > 0) cursor += LAYOUT.groupGap;
    const labelY = cursor;
    cursor += LAYOUT.groupLabelH;

    const nodeIds: string[] = [];
    for (const n of g.nodes) {
      const centreY = cursor + LAYOUT.nodeH / 2;
      outNodes.push({
        id: n.id,
        side: n.side,
        kind: n.kind,
        name: n.name,
        ...(n.secondary !== undefined ? { secondary: n.secondary } : {}),
        ...(n.down ? { down: true } : {}),
        ...(n.down && n.downReason !== undefined ? { downReason: n.downReason } : {}),
        x,
        y: round0n(centreY),
        flowIds: [],
      });
      nodeIds.push(n.id);
      cursor += LAYOUT.nodeH + LAYOUT.nodeGap;
    }
    outGroups.push({ side: column.side, kind: g.kind, label: g.label, labelY, nodeIds });
  });

  return { nodes: outNodes, groups: outGroups, bottom: cursor };
}

// buildTableRows projects EVERY flow (not the capped subset), which is the parity guarantee:
// the table is a superset-or-equal of the SVG. A row is just the FlowRecord plus its status
// presentation (so the cell renders hue + glyph + label without re-deriving).
export function buildTableRows(flows: FlowRecord[]): TopologyTableRow[] {
  return flows.map((flow) => ({ flow, presentation: presentStatus(flow.status) }));
}
