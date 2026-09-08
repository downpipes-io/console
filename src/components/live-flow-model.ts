// The PURE MODEL LAYER of the optional live-flow visualisation (live-flow.ts): the
// feature-detect / fallback decision, the reduced-motion / static-frame decision, the
// tripartite geometry/layout + health/throughput encoding, the honest colour fallbacks, the
// shared accessible-table spec, and the pure pipe/particle maths. This is what the validator
// asserts; the canvas controller is a thin projection of it. Split out of live-flow.ts as a
// dependency-light sibling so the canvas renderer stays under the size budget.
//
// Moved verbatim from live-flow.ts; every function, constant and threshold is byte-for-byte
// the original, so the geometry, the encoding and the decisions are unchanged (live-flow.ts
// re-exports every externally-referenced symbol by name). The model touches no DOM, no clock
// (beyond an explicit `now`) and no randomness, so it runs in the bare-Node validator and is
// deterministic; the small colour-parsing pair is pure string maths. House rules: Australian
// English, no em dashes, precise claims.

import {
  presentStatus,
  throughputWeight,
  tally,
  buildTableRows,
  topologyTableColumns,
} from "./topology.ts";
import type { FlowRecord, StatusTone, EdgeWeight } from "./topology-types.ts";
import type {
  RenderMode,
  AnimationMode,
  Column,
  LiveNode,
  LiveLeg,
  LiveEdge,
  LiveFlowModel,
  Rgb,
  LiveFlowTableSpec,
} from "./live-flow-types.ts";

// The render-mode decision (feature-detect + fallback). PURE: a function of the options and
// an injected probe, so the validator exercises every branch without a GPU.

// chooseRenderMode is THE feature-detect/fallback decision: the 2D-canvas renderer wherever a
// 2d context exists (effectively every browser - CPU raster, no GPU, no graphics
// acceleration, no CSS-animation dependence), else the SVG topology (which carries the same
// accessible table). The WebGL renderer was RETIRED as a renderer after GPU-environment failures
// proved unreliable: one raster path that runs everywhere
// beats a faster path that silently does not. Pure and deterministic given the probe result.
export function chooseRenderMode(opts: { canvas2dAvailable: boolean }): RenderMode {
  return opts.canvas2dAvailable ? "canvas2d" : "svg-fallback";
}

// detectCanvas2d is the 2D feature probe: a throwaway canvas must yield a 2d context. True in
// effectively every browser (2D canvas needs no GPU); guarded for non-DOM/test environments,
// where it returns false so the caller falls back to the SVG topology.
export function detectCanvas2d(): boolean {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return false;
  try {
    const canvas = document.createElement("canvas");
    if (typeof canvas.getContext !== "function") return false;
    return canvas.getContext("2d") !== null;
  } catch {
    return false;
  }
}


// The reduced-motion / static-frame decision. PURE: a function of the forced flag and the
// media-query result, so the validator covers both the animated and the static-frame cases.

// LIVE_FLOW_MAX_ANIMATED_EDGES caps the per-frame ANIMATION cost. Above this many edges the canvas paints
// a single STATIC frame (every pipe + node still drawn, once) instead of running the rAF loop, so the
// O(edges) per-frame idle-sheen + particle work cannot drop frames on a large fleet or a weak CPU. Only
// the MOTION stops past the threshold, the static pipes, node labels, the hover-focus effect, and the
// canonical accessible table are unaffected, and memory is unchanged (two fixed-size canvases either way).
// ~16 canvas ops per idle edge per frame, so this is deliberately conservative: a typical fleet of tens of
// edges animates freely, and only a several-hundred-edge fleet goes static. One-line tunable.
export const LIVE_FLOW_MAX_ANIMATED_EDGES = 200;

// shouldAnimate is the per-render animation decision: animate only when motion is allowed (not reduced
// motion) AND the fleet is small enough to stay within the per-frame budget. Pure; the controller
// re-evaluates it on every data change, so a fleet that grows past the cap drops to static automatically
// (and back to animated if it shrinks). Exported for the validator.
export function shouldAnimate(edgeCount: number, animation: AnimationMode): boolean {
  return animation === "animated" && edgeCount <= LIVE_FLOW_MAX_ANIMATED_EDGES;
}

// chooseAnimationMode is THE reduced-motion decision. Under reduced motion (forced, or the
// media query) the renderer paints a single static frame and runs no loop; otherwise it
// animates. Pure and deterministic given (reducedMotion forced, media-query result).
export function chooseAnimationMode(opts: { reducedMotion?: boolean; mediaReducedMotion: boolean }): AnimationMode {
  if (opts.reducedMotion === true) return "static-frame";
  return opts.mediaReducedMotion ? "static-frame" : "animated";
}

// The PURE geometry/layout + encoding model. No DOM, no clock, no randomness. This is
// what the validator asserts; the 2D canvas renderer is a thin projection of it.
//
// Unlike the SVG map (a bipartite source->destination layout), the live-flow view is a
// TRIPARTITE layout: SOURCES on the left, the ENGINE in the CENTRE, and DESTINATIONS on the
// right. Every flow is drawn as TWO legs through the engine hub: a
// source->engine ingress leg and an engine->destination egress leg. The engine is the single
// account-wide pivot (the no-custody engine the customer runs), so the hub is honest: all
// data passes through it. Coordinates are in NORMALISED canvas coordinates (x,y in [0,1],
// origin top-left), so the 2D canvas renderer scales them to the real pixel size without
// re-laying-out.

// Layout constants in NORMALISED space (x,y in [0,1]). Pure numbers; the geometry depends
// only on these and the data order. The three columns sit at fixed x; nodes spread evenly
// down each column within a top/bottom margin so a tall list still fits the [0,1] band (the
// 2D canvas renderer scales the band to the real canvas height).
const LF_LAYOUT = {
  sourceX: 0.12,
  engineX: 0.5,
  destX: 0.88,
  marginTop: 0.1,
  marginBottom: 0.1,
  // The engine hub's fixed vertical centre.
  engineY: 0.5,
} as const;

// Particle-rate buckets (bytes per run -> a bounded emission-rate step), reusing the SVG
// map's throughput thresholds so the two views agree on "how much moves". The NUMBER is the
// truth (shown in the table); the rate is a reinforcement only. A non-flowing flow is rate 0.
const RATE_THICK = 64 * 1024 * 1024; // >= 64 MB per run -> fastest stream
const RATE_MEDIUM = 1024 * 1024; // >= 1 MB per run -> medium stream
// The bounded rate steps. A running flow with unknown/low throughput still shows a slow,
// honest trickle (rate 1) so "running" reads as live; a denser stream is 2 or 3. The running
// multiplier (a denser stream for an active run) is folded in here: a flow only emits when it
// is flowing, and the step is the throughput bucket.
const RATE_SLOW = 1;
const RATE_MED = 2;
const RATE_FAST = 3;

// particleRateFor maps a flow to its bounded particle emission rate. A non-flowing flow emits
// nothing (rate 0): the stream is never fabricated over a disabled/failed/idle flow. A flowing
// flow emits at the throughput bucket (slow/med/fast), so an active run with more bytes is a
// denser stream. Pure and bounded.
export function particleRateFor(flow: FlowRecord, flowing: boolean): number {
  if (!flowing) return 0;
  const b = flow.bytesPerRun;
  if (b === null || b === undefined || !Number.isFinite(b) || b <= 0) return RATE_SLOW;
  if (b >= RATE_THICK) return RATE_FAST;
  if (b >= RATE_MEDIUM) return RATE_MED;
  return RATE_SLOW;
}

// isFlowing is the shared "show a live stream?" rule, identical to topology.ts: a flow streams
// only when it is genuinely running AND its status is non-terminal (healthy/stale/unknown). A
// failed or disabled flow is never shown flowing, so the visual cannot imply progress that is
// not happening. Pure.
export function isFlowing(flow: FlowRecord): boolean {
  return flow.running && (flow.status === "healthy" || flow.status === "stale" || flow.status === "unknown");
}


// buildLiveFlowModel is the heart of the view: it turns the flow set into the tripartite
// layout (sources left, engine centre, destinations right), with each flow split into an
// ingress and an egress leg through the engine hub, and each flow carrying its health
// presentation, bounded weight, particle rate and flowing flag. PURE: deterministic geometry
// from input order alone (no DOM, no GL, no clock, no randomness). The engine hub exists iff
// there is at least one flow (an empty set yields no nodes and no legs, the honest empty
// state the renderer turns into a calm explanation, never a blank casino).
export function buildLiveFlowModel(opts: { flows: FlowRecord[] }): LiveFlowModel {
  const flows = opts.flows;

  // Distinct source and destination nodes in first-seen order (deterministic), reusing the
  // topology node-id shape so a screen can cross-reference selections between the two views.
  const sources = collectColumn("source", flows, (f) => f.source);
  const dests = collectColumn("destination", flows, (f) => f.destination);

  const nodes: LiveNode[] = [];
  const nodeById = new Map<string, LiveNode>();

  const place = (collected: Collected[], column: Column, x: number, otherCount: number): void => {
    collected.forEach((c, i) => {
      const y = columnY(i, collected.length, column, otherCount);
      const node: LiveNode = { id: c.id, column, kind: c.kind, label: c.label, x, y, flowIds: [] };
      nodes.push(node);
      nodeById.set(node.id, node);
    });
  };
  place(sources, "source", LF_LAYOUT.sourceX, dests.length);
  place(dests, "destination", LF_LAYOUT.destX, sources.length);

  const engineNode = makeEngineNode(flows, nodes, nodeById);
  const { edges, legs } = buildEdges(flows, nodeById, engineNode);

  return { nodes, edges, legs, counts: tally(flows), engineNode };
}

// makeEngineNode appends and returns the single account-wide engine hub every flow passes
// through, present only when there is at least one flow (so the empty state has no orphan hub).
// It mutates the shared node list + index exactly as the inline block did.
function makeEngineNode(flows: FlowRecord[], nodes: LiveNode[], nodeById: Map<string, LiveNode>): LiveNode | null {
  if (flows.length === 0) return null;
  const engineNode: LiveNode = {
    id: "engine",
    column: "engine",
    kind: "engine",
    label: "engine",
    x: LF_LAYOUT.engineX,
    y: LF_LAYOUT.engineY,
    flowIds: [],
  };
  nodes.push(engineNode);
  nodeById.set(engineNode.id, engineNode);
  return engineNode;
}

// buildEdges assembles the per-flow ingress/egress legs through the engine hub, recording the
// flow ids on each touched node. Moved verbatim from buildLiveFlowModel so the geometry and the
// lane fan are unchanged.
function buildEdges(
  flows: FlowRecord[],
  nodeById: Map<string, LiveNode>,
  engineNode: LiveNode | null,
): { edges: LiveEdge[]; legs: LiveLeg[] } {
  const edges: LiveEdge[] = [];
  const legs: LiveLeg[] = [];
  for (let i = 0; i < flows.length; i++) {
    const flow = flows[i]!;
    const sId = nodeId("source", flow.source.kind, flow.source.name);
    const dId = nodeId("destination", flow.destination.kind, flow.destination.name);
    const sNode = nodeById.get(sId);
    const dNode = nodeById.get(dId);
    if (!sNode || !dNode || !engineNode) continue; // defensive; collectColumn guarantees both

    const presentation = presentStatus(flow.status);
    const weight = throughputWeight(flow.bytesPerRun);
    const flowing = isFlowing(flow);
    const particleRate = particleRateFor(flow, flowing);

    // Each flow crosses the hub in its OWN LANE (a small, bounded vertical offset at the hub
    // end of both legs). Without it every engine->destination leg of the single-destination
    // model is the SAME cubic, so N statuses stack into one unreadable line and only the last
    // drawn colour survives; the lane fan keeps each flow's hue legible through the middle
    // while both legs still converge on their endpoint nodes.
    const lane = hubLaneOffset(i, flows.length);
    const ingress = makeLeg(`${flow.id}:in`, flow.id, "ingress", sNode, engineNode, 0, lane);
    const egress = makeLeg(`${flow.id}:out`, flow.id, "egress", engineNode, dNode, lane, 0);

    edges.push({ flowId: flow.id, flow, presentation, weight, particleRate, flowing, ingress, egress });
    legs.push(ingress, egress);

    sNode.flowIds.push(flow.id);
    dNode.flowIds.push(flow.id);
    engineNode.flowIds.push(flow.id);
  }
  return { edges, legs };
}

// columnY spreads `count` nodes evenly down a column within the top/bottom margins. Multiple
// nodes share the usable band. A LONE node is handled by what the OTHER column holds:
//   - 1x1 (one source AND one destination): both are offset off the centre line (source above,
//     destination below) so the graph fans into a clear shallow curve instead of collapsing to
//     one flat horizontal streak (the "just a line, no nodes" symptom);
//   - a lone node FACING A SPREAD column (the real fleet shape: many sources, ONE archive
//     destination) sits ON the centre line, level with the engine hub, so the convergence axis
//     is horizontal and centred rather than kinking below centre (the "not centered" walkthrough
//     finding - the 1x1 offset was wrongly applied to every lone destination).
// Pure and deterministic.
function columnY(index: number, count: number, column: Column, otherCount: number): number {
  const top = LF_LAYOUT.marginTop;
  const bottom = 1 - LF_LAYOUT.marginBottom;
  const span = bottom - top;
  if (count <= 1) {
    if (otherCount > 1) return LF_LAYOUT.engineY; // lone node facing a spread column: centred
    // The 1x1 fan: SHALLOW offsets (a gentle S symmetric about the centre line), enough that
    // the graph does not collapse to one flat streak but not too steep a diagonal (the original
    // 0.24 pushed the endpoints far off-axis).
    if (column === "source") return LF_LAYOUT.engineY - span * 0.12;
    if (column === "destination") return LF_LAYOUT.engineY + span * 0.12;
    return LF_LAYOUT.engineY;
  }
  return top + (span * index) / (count - 1);
}

// hubLaneOffset is the per-flow vertical lane through the engine hub, in normalised height
// units: flows spread evenly across a band centred on the hub, the band growing with the flow
// count but bounded so the braid stays within the hub's visual neighbourhood. Deterministic by
// flow order; a single flow takes the centre line. Exported for the validator (the no-stacked-
// egress invariant).
const HUB_LANE_MAX_HALF = 0.06; // normalised height, max half-band
const HUB_LANE_STEP = 0.022; // per-flow spread step, normalised height
export function hubLaneOffset(index: number, count: number): number {
  if (count <= 1) return 0;
  const half = Math.min(HUB_LANE_MAX_HALF, HUB_LANE_STEP * (count - 1));
  return -half + (2 * half * index) / (count - 1);
}

// makeLeg builds one cubic leg between two nodes, with horizontal control handles half-way
// across the gap so the leg reads as a smooth pipe (matching the SVG map's curve idiom). Pure
// arithmetic in normalised space. fromDy/toDy nudge an endpoint off its node's centre line
// (the hub lane fan); the leg still belongs to its two nodes.
function makeLeg(id: string, flowId: string, leg: "ingress" | "egress", from: LiveNode, to: LiveNode, fromDy = 0, toDy = 0): LiveLeg {
  const x0 = from.x;
  const y0 = from.y + fromDy;
  const x3 = to.x;
  const y3 = to.y + toDy;
  const cx = (x0 + x3) / 2;
  return {
    id,
    flowId,
    leg,
    fromNodeId: from.id,
    toNodeId: to.id,
    x0, y0,
    x1: cx, y1: y0,
    x2: cx, y2: y3,
    x3, y3,
  };
}

interface Collected {
  id: string;
  kind: FlowRecord["source"]["kind"];
  label: string;
}

// collectColumn gathers the distinct endpoints on one side in first-seen order (deterministic),
// reusing the topology node-id shape for cross-referencing.
function collectColumn(side: "source" | "destination", flows: FlowRecord[], pick: (f: FlowRecord) => FlowRecord["source"]): Collected[] {
  const seen = new Map<string, Collected>();
  for (const f of flows) {
    const ep = pick(f);
    const id = nodeId(side, ep.kind, ep.name);
    if (!seen.has(id)) seen.set(id, { id, kind: ep.kind, label: ep.name });
  }
  return [...seen.values()];
}

function nodeId(side: "source" | "destination", kind: string, name: string): string {
  return `${side}:${kind}:${name}`;
}

// Health colour mapping. The 2D canvas renderer needs an RGB triple per status; this keeps the
// encoding HONEST and aligned with the SVG map's tones (trust/warn/danger/neutral). Colours are
// read at render time only as a reinforcement; the glyph + the label (in the table) are the
// non-colour-alone carriers of status. unknown/disabled are NEUTRAL, never the trust hue.
//
// These are token-aligned RGB values (a calm palette, not alarm-red): a muted teal for trust,
// an amber for warn, a desaturated red for danger, a slate for neutral. The 2D canvas renderer
// reads the actual CSS custom properties at runtime when available and falls back to these so
// the canvas matches the theme; the model only needs the honest tone, exposed here for the
// validator to assert the mapping (never a green for unknown/disabled).

// statusFallbackRgb is the calm, token-aligned fallback palette per tone (0..1 channels). The
// renderer prefers live CSS custom properties; this is the honest default and the value the
// validator asserts. NOT alarm-red: danger is a desaturated red, trust a muted teal.
export function statusFallbackRgb(tone: StatusTone): Rgb {
  switch (tone) {
    case "trust": return { r: 0.27, g: 0.71, b: 0.63 }; // muted teal
    case "warn": return { r: 0.85, g: 0.65, b: 0.24 }; // amber
    case "danger": return { r: 0.80, g: 0.36, b: 0.34 }; // desaturated red (calm, not alarm)
    case "neutral": return { r: 0.56, g: 0.60, b: 0.66 }; // slate (unknown/disabled; never green)
  }
}

// The accessible table spec (the canonical representation; parity contract). The renderer and
// the validator BOTH read this, so "the table fallback is always produced" is asserted from
// the same spec the renderer mounts. It reuses topology.ts's buildTableRows +
// topologyTableColumns, so the live-flow table is byte-for-byte the SVG map's table (same
// columns, same row-per-flow, same real open buttons), which is exactly the parity the brief
// requires ("the accessible data table from the existing map stays present and canonical").

// buildTableSpec is the single source for the canonical table in EVERY render branch (the 2D
// canvas renderer, the SVG fallback via renderTopology, and the empty state). It always returns a complete spec
// (one row per flow, the full column set), so the table can never be silently dropped. Pure.
export function buildTableSpec(flows: FlowRecord[], now?: number, onActivateEdge?: (id: string) => void): LiveFlowTableSpec {
  return {
    rows: buildTableRows(flows),
    columns: topologyTableColumns(now, onActivateEdge),
  };
}

// litNodeIds is the set of nodes that stay LIT when a node is hovered/focused: the hovered node itself,
// the engine hub (always central), and the opposite-column nodes its paths reach (any node sharing one of
// its flow ids). Everything else dims. Pure, keyed off the model's flowIds so the DOM node dim and the
// canvas pipe dim agree on the same set. Exported for the validator.
export function litNodeIds(focusNode: LiveNode, nodes: LiveNode[]): Set<string> {
  const flows = new Set(focusNode.flowIds);
  const lit = new Set<string>([focusNode.id]);
  for (const n of nodes) {
    if (n.column === "engine" || n.flowIds.some((f) => flows.has(f))) lit.add(n.id);
  }
  return lit;
}

// Shared pipe-geometry constants: the canvas controller draws from these, so the geometry is
// one source of truth. Half-widths are in normalised height units (the rim feather/AA makes
// the visual edge slightly inside); the halo is the same geometry, wider and faint, drawn
// UNDER the core so a live pipe reads gently lit, never neon. All pure arithmetic.
export function coreHalfW(weight: EdgeWeight): number {
  const baseHalfW = 0.0025; // baseline half-width in normalised height units (zero-weight)
  const perWeightStep = 0.0022; // per-weight-step increment, in normalised height units
  return baseHalfW + weight * perWeightStep;
}
export const HALO_SCALE = 2.6; // halo width = core * HALO_SCALE
export const HALO_ALPHA = 0.085;

// sheenAlphaFor: the idle-pulse alpha, density-scaled so a fleet braid never whites out
// (read by the canvas controller). The edge-count tiers are: a single-tenant map
// (<= SHEEN_SMALL_FLEET edges), a typical fleet (<= SHEEN_MEDIUM_FLEET), and a large
// braid above that, each given a progressively fainter sheen.
const SHEEN_SMALL_FLEET = 8;
const SHEEN_MEDIUM_FLEET = 30;
export function sheenAlphaFor(edgeCount: number): number {
  return edgeCount <= SHEEN_SMALL_FLEET ? 0.14 : edgeCount <= SHEEN_MEDIUM_FLEET ? 0.09 : 0.055;
}

// cubicPoint evaluates a leg's cubic at parameter t in [0,1]. Pure arithmetic; exported-shape
// math reused by both the pipe sampler and the particle marcher so packets ride the drawn pipe.
export function cubicPoint(leg: LiveLeg, t: number): { x: number; y: number } {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * leg.x0 + w1 * leg.x1 + w2 * leg.x2 + w3 * leg.x3,
    y: w0 * leg.y0 + w1 * leg.y1 + w2 * leg.y2 + w3 * leg.y3,
  };
}

// staticPhase is the deterministic per-leg/per-packet phase used for the reduced-motion static
// frame, so the still image is reproducible and never reads a clock. A simple hashed spread
// using the Knuth multiplicative hash.
const KNUTH_HASH_A = 2654435761; // Knuth multiplicative hash (2^32 / phi)
const KNUTH_HASH_B = 40503; // secondary spread multiplier
export function staticPhase(legIndex: number, packet: number): number {
  const n = (legIndex * KNUTH_HASH_A + packet * KNUTH_HASH_B) >>> 0;
  return (n % 1000) / 1000;
}

export function frac(x: number): number {
  return x - Math.floor(x);
}

// parseCssColour parses a #rgb / #rrggbb / rgb()/rgba() string into 0..1 channels. Returns null
// for anything it cannot parse (the caller falls back to the honest tone). Pure.
export function parseCssColour(raw: string): Rgb | null {
  const s = raw.trim();
  if (s === "") return null;
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0]! + hex[0]!, 16);
      const g = parseInt(hex[1]! + hex[1]!, 16);
      const b = parseInt(hex[2]! + hex[2]!, 16);
      if ([r, g, b].some((v) => Number.isNaN(v))) return null;
      return { r: r / 255, g: g / 255, b: b / 255 };
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if ([r, g, b].some((v) => Number.isNaN(v))) return null;
      return { r: r / 255, g: g / 255, b: b / 255 };
    }
    return null;
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1]!.split(",").map((p) => p.trim());
    if (parts.length < 3) return null;
    const r = parseChannel(parts[0]!);
    const g = parseChannel(parts[1]!);
    const b = parseChannel(parts[2]!);
    if (r === null || g === null || b === null) return null;
    return { r, g, b };
  }
  return null;
}

function parseChannel(p: string): number | null {
  if (p.endsWith("%")) {
    const v = parseFloat(p.slice(0, -1));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : null;
  }
  const v = parseFloat(p);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v / 255)) : null;
}
