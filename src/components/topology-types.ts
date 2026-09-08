// The public TYPE surface of the topology map (topology.ts): the input shapes a screen maps
// the engine's data onto, the computed-model shapes the SVG and the accessible table both
// read, and the small status/encoding unions. Split out as a dependency-light sibling so the
// renderer and the pure model can share one type source and the map screens can import the
// flow shapes without pulling in the DOM renderer. Moved verbatim from topology.ts; the
// declarations are unchanged, so the public surface is identical (topology.ts re-exports
// every externally-referenced one by name).
//
// These are pure type declarations: no DOM, no runtime, no imports beyond the FlowRecord
// presentation the model produces. House rules: Australian English, no em dashes, precise
// claims.

// ---------------------------------------------------------------------------
// Public input types (the screen maps the engine's data onto these).
// ---------------------------------------------------------------------------

// The kinds the engine surfaces. Sources are KV / R2 / D1 / Secrets Store; destinations
// are R2 buckets and S3 targets (spec section 1). The union is open at the edges via
// "other" so an unrecognised kind degrades to a neutral glyph rather than throwing.
export type NodeKind = "kv" | "r2" | "d1" | "secrets" | "s3" | "other";

// An endpoint of a flow: a named node of a given kind, with an optional secondary line
// (last-seen size or record count if known). The name is server-supplied and escaped.
export interface FlowEndpoint {
  name: string;
  kind: NodeKind;
  // An optional secondary line for the node (e.g. "1,204 keys", "2.1 GB"). Already
  // formatted by the caller; rendered as text.
  secondary?: string;
  // A DESTINATION endpoint the engine currently cannot reach (the replicate pass's last attempt to it
  // failed). Drives the explicit "down" indicator on the destination node, never colour alone: the node
  // also reads the word "down" and names it unreachable in its accessible title (WCAG 1.4.1). Always
  // undefined on a source endpoint and on a reachable destination.
  down?: boolean;
  // B30: the engine's coarse per-destination down REASON (replication.ts DestReplState.reason - auth /
  // worm-refused / throttled / timeout / tls / network / other), when the caller has one to hand. Only
  // meaningful alongside down: true; carries through to LayoutNode so the map node can say WHY a
  // destination is down via destDownReasonLabel, the identical mapping the drawer's Copies row already
  // uses. Absent when the engine sent no reason, or on a source/reachable endpoint.
  downReason?: string;
}

// The honest status of a downpipe (or, for a fan-out edge, of THIS destination's copy). "unknown"
// means the status could not be fetched (a partial load or an unreachable engine); it is NEVER coerced
// to a green (spec 3 / 6). "partial" is the 3-2-1 redundancy state: the run WAS captured (>=1 copy
// exists) but this destination is behind or did not receive it yet, amber, never red, because the data
// is safe elsewhere. A destination that is itself unreachable reads "failed" on its own lane.
// "no-copy" is the lane of a destination the engine has never reported on AND whose silence has outlasted
// at least two SUCCESSFUL backups since it entered the fan-out (the anchor bar in replication.ts, the same bar
// the support pack and the bot use). It has no replication row at all, so nothing is catching up and nothing is
// behind. It is NOT "partial". Folding the two together is the ticket the customer rings about ("one destination
// has shown amber catching up for weeks"): the console kept telling the operator to wait for a copy that was
// never being made. The bar is what keeps the lane honest in the other direction: absence of a row is ALSO the
// state of a destination added five minutes ago, which is owed no copy yet and reads "partial". It stays amber,
// not red, because the run itself succeeded and the data IS safe on the destinations that did report; what is
// missing is the copy on this one, and the honest word for that is "no copy", not "catching up".
export type FlowStatus = "healthy" | "stale" | "partial" | "no-copy" | "failed" | "disabled" | "unknown";

// One flow record: a downpipe from a source to a destination, with its status, freshness,
// cadence and throughput. lastRunAt is an RFC-3339 string or epoch ms or null (never run /
// unknown). bytesPerRun is the last run's byte count or null/undefined when unknown.
export interface FlowRecord {
  id: string;
  source: FlowEndpoint;
  destination: FlowEndpoint;
  status: FlowStatus;
  // RFC-3339 / epoch ms / null. Presentation-only (relative + absolute); never sent back.
  lastRunAt?: string | number | null;
  // Cadence in seconds (e.g. 86400 for daily). Optional: a one-shot downpipe has none.
  cadence?: number;
  // The last run's byte count. Optional/undefined/null = unknown (no fake thickness).
  bytesPerRun?: number | null;
  // Whether the downpipe is enabled (a disabled downpipe still appears, read "disabled").
  enabled: boolean;
  // Whether a run is currently in flight (drives the flowing-dash / running-badge).
  running: boolean;
  // True when this edge's "failed" status comes ONLY from a destination lane being unreachable, not from
  // the downpipe's own capture failing (destinationLaneStatus overrode an otherwise-fine status). The
  // freshness sentence reads differently for the two: a lane failure points at Copies, not Recent runs,
  // because the run itself did not fail. Absent (undefined) for a genuine capture failure or any
  // non-failed status, and for a single-destination downpipe (which has no lane distinction).
  laneFailed?: boolean;
}

// An optional explicit grouping of nodes by kind, with a human label and an order. When
// omitted the model derives groups from the data in first-seen order (deterministic). A
// caller supplies this to fix the column order or to relabel a kind.
export interface NodeGroupSpec {
  kind: NodeKind;
  label: string;
}

export interface TopologyOptions {
  flows: FlowRecord[];
  // Optional explicit source-side and destination-side group ordering/labels.
  sourceGroups?: NodeGroupSpec[];
  destinationGroups?: NodeGroupSpec[];
  // Activating an edge opens the downpipe's detail drawer (the screen owns the route).
  onActivateEdge?: (id: string) => void;
  // Activating a node filters the map to its flows (the screen owns the URL/filter).
  onActivateNode?: (nodeId: string) => void;
  // Clearing the node filter (spec section 4: "Escape clears a node filter"). Wired to an
  // Escape keydown on the node roving-groups; the screen clears the URL/filter. Only has an
  // effect alongside onActivateNode (a node must be activatable to be filtered in the first
  // place), but it is independent so a screen can opt into clear-only behaviour.
  onClearNodeFilter?: () => void;
  // A cap on the number of edges drawn in the SVG (spec section 2: never silently
  // truncate; when a cap applies the component says so on screen and the FULL set still
  // appears in the accessible table). Omit for no cap.
  maxEdges?: number;
  // Force the reduced-motion branch (static running badge, no flowing dash) regardless of
  // the media query. Used by tests/screens; when omitted the renderer reads matchMedia.
  reducedMotion?: boolean;
  // The "now" the freshness strings are computed against (epoch ms). Injectable so the
  // model is a pure function of (data, now) and the validator can pin it. The render path
  // defaults it to Date.now (the only wall-clock read, and only there); the geometry and
  // the status/throughput encoding never depend on it.
  now?: number;
}

// ---------------------------------------------------------------------------
// The computed model. This is the single source both the SVG and the table read; the
// validator asserts against it. The geometry and encoding are produced WITHOUT touching
// the DOM, a clock, or randomness; the freshness strings depend only on the explicit
// `now`. So the whole model is deterministic given (data, now) and testable in bare Node.
// ---------------------------------------------------------------------------

export type ColumnSide = "source" | "destination";

// One laid-out node, with its deterministic position and the flow ids that touch it.
export interface LayoutNode {
  // A stable id derived from the side + kind + name (so two nodes of the same name on
  // different sides, or different kinds, are distinct). Escaped at render only as text.
  id: string;
  side: ColumnSide;
  kind: NodeKind;
  name: string;
  secondary?: string;
  // The geometric centre of the node in the SVG's viewBox coordinate space.
  x: number;
  y: number;
  // The flow ids incident on this node (drives node-level filtering and the count).
  flowIds: string[];
  // A destination node the engine currently cannot reach (any incident downpipe's last replicate
  // attempt to it failed). Drives the explicit "down" badge; undefined on sources and reachable dests.
  down?: boolean;
  // B30: WHY the node is down, the same per-destination reason FlowEndpoint.downReason carries. The node
  // renderer maps it through destDownReasonLabel (replication.ts) - the identical label the drawer's
  // Copies row already shows - so the map and the drawer never disagree about the cause. Undefined when
  // down is false/absent, or when the engine sent no reason for a down destination.
  downReason?: string;
}

// One laid-out group (a kind cluster within a column), with its label and a y-band.
export interface LayoutGroup {
  side: ColumnSide;
  kind: NodeKind;
  label: string;
  // The y of the group's label row (top of the band).
  labelY: number;
  nodeIds: string[];
}

// The presentation of a status: the tone class suffix (hue), the glyph (shape), the human
// label (text), the SVG stroke dash style, and whether the edge is "live" capable (an
// in-flight run can animate). This is the single mapping the whole component obeys.
export interface StatusPresentation {
  status: FlowStatus;
  // The token-tone suffix used by the CSS hooks (e.g. "trust", "warn", "danger",
  // "neutral"). NOT a raw colour; the later CSS pass maps these to tokens.
  tone: StatusTone;
  // The inner SVG markup of the join glyph (from icons.ts; a trusted in-repo constant).
  glyph: string;
  // The human label, e.g. "fresh", "stale", "partial", "failed", "disabled", "unknown".
  label: string;
  // The SVG stroke dash style for the edge: "solid" | "dashed" | "dotted".
  dash: EdgeDash;
}

export type StatusTone = "trust" | "warn" | "danger" | "neutral";
export type EdgeDash = "solid" | "dashed" | "dotted";
export type EdgeWeight = 1 | 2 | 3; // thin | medium | thick (bounded, spec section 3)

// One laid-out edge: the two endpoints, the status presentation, the throughput weight,
// the curved path geometry, and the precomputed accessible name + freshness text. The
// edge and its table row are both built from this, so they cannot disagree.
export interface LayoutEdge {
  id: string;
  sourceNodeId: string;
  destinationNodeId: string;
  flow: FlowRecord;
  presentation: StatusPresentation;
  // The throughput thickness step (1/2/3), derived from bytesPerRun in bounded buckets.
  weight: EdgeWeight;
  // Whether the in-flight animation applies (running AND a non-terminal status). A
  // disabled or failed downpipe is not shown as "flowing" even if a flag says running.
  flowing: boolean;
  // The SVG path 'd' for the curved connector (a cubic between the two node anchors). In a
  // converging/bipartite case the destination end (and the mirror source end) is FANNED to
  // a distinct point on the node edge by incident-edge index, so the pipes separate as they
  // approach rather than collapsing onto one point.
  path: string;
  // The marker anchor: the point on the curve where the join glyph + label sit. This is
  // biased toward the LESS convergent endpoint (so it inherits that end's node separation),
  // NOT the curve's geometric midpoint, which is what collapsed the N->1 case. Named midX/
  // midY for continuity with the renderer/embed; it is the marker anchor, not the centre.
  midX: number;
  midY: number;
  // Whether the marker carries the full "<status> - <freshness>" text plate, or just the
  // status glyph. Glyph-only is chosen deterministically when the full plate would overlap
  // an already-placed marker (a dense convergence); the freshness then reads from the table
  // and the edge <title>. The status itself stays glyph + (in the table) label + hue.
  labelled: boolean;
  // The accessible name for the edge button, e.g.
  //   "uploads-prod KV to archive-bucket R2, fresh, last run 3h ago, 2.1 MB per run".
  accessibleName: string;
  // The freshness phrase (relative) and its absolute companion for the title/aria.
  freshnessLabel: string;
  freshnessTitle: string;
}

// The status tally the SVG's aria-label summarises ("N downpipes, X healthy, ...").
export interface StatusCounts {
  total: number;
  healthy: number;
  stale: number;
  partial: number;
  // G299: destinations the engine has never reported a copy for. Its own bucket, so the aria summary can say
  // "2 with no copy" instead of folding them into "partial" (a copy that is being made) or "unknown" (a status
  // the console could not fetch). It knows exactly what this is.
  noCopy: number;
  failed: number;
  disabled: number;
  unknown: number;
}

export interface TopologyModel {
  nodes: LayoutNode[];
  groups: LayoutGroup[];
  edges: LayoutEdge[];
  counts: StatusCounts;
  // The viewBox the SVG uses. Derived from the laid-out geometry (deterministic).
  width: number;
  height: number;
  // The drawn-vs-total edge accounting when a cap applies (spec section 2: say so on
  // screen, never silently truncate). drawn === total when no cap or under the cap.
  drawnEdgeCount: number;
  totalEdgeCount: number;
  capped: boolean;
}

// An axis-aligned bounding box in viewBox coordinates.
export interface MarkerBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// A row is just the FlowRecord plus its status presentation (so the cell renders hue +
// glyph + label without re-deriving). buildTableRows projects EVERY flow (not the capped
// subset), which is the parity guarantee: the table is a superset-or-equal of the SVG.
export interface TopologyTableRow {
  flow: FlowRecord;
  presentation: StatusPresentation;
}
