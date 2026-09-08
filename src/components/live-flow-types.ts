// The public TYPE surface of the optional live-flow visualisation (live-flow.ts): the render
// and animation mode unions, the tripartite layout shapes (nodes, legs, edges, model), the
// public options/handle, and the colour + table-spec shapes. Split out as a dependency-light
// sibling so the pure model and the canvas renderer share one type source and a screen can
// import the option/handle shapes without pulling in the canvas controller. Moved verbatim
// from live-flow.ts; the declarations are unchanged, so the public surface is identical
// (live-flow.ts re-exports every externally-referenced one by name).
//
// These are pure type declarations: no DOM, no canvas, no runtime. They reuse the SAME
// FlowRecord the SVG map consumes (so the two views cannot disagree) plus the status / weight
// / table shapes from topology. House rules: Australian English, no em dashes, precise claims.

import type {
  FlowRecord,
  StatusPresentation,
  EdgeWeight,
  StatusCounts,
  TopologyTableRow,
} from "./topology-types.ts";
import type { DataColumn } from "./data-table-types.ts";

export interface LiveFlowOptions {
  flows: FlowRecord[];
  // Activating an edge opens the downpipe's detail drawer (the screen owns the route). The
  // operable surface is the accessible table's row buttons; this wires those.
  onActivateEdge?: (id: string) => void;
  // Node-filter affordances. In the canvas2d branch they make the DOM node layer's labelled
  // endpoints real buttons (activating one filters the map to that node; Escape clears); in
  // the SVG fallback they reach renderTopology's own operable nodes. When omitted (the
  // read-only embeds) the node labels render as plain, non-operable marks.
  onActivateNode?: (nodeId: string) => void;
  onClearNodeFilter?: () => void;
  // Compact embed presentation: adds the live-flow--compact modifier (a shorter canvas band;
  // tokens.css) for the overview/onboarding embeds. The data, the encoding and the table
  // contract are identical; only the canvas height changes.
  compact?: boolean;
  // Self-dispose when the rendered root leaves the document (checked on a coarse interval,
  // armed only after the root has first been seen connected). For embeds whose host re-renders
  // without a dispose hook (the overview cards rebuild on every poll), this stops the rAF loop
  // and frees the canvas context within a couple of seconds of detachment instead of leaking one
  // loop per re-render. Screens that own a real lifecycle (the map) keep explicit dispose.
  selfDisposeOnDetach?: boolean;
  // Force the reduced-motion branch (a single static frame, no animation loop) regardless of
  // the media query. Used by tests/screens; when omitted the renderer reads matchMedia.
  reducedMotion?: boolean;
  // The injectable 2D-canvas probe (returns whether a usable 2d context can be created).
  // Defaults, in the render path only, to the real canvas probe; injectable so the decision
  // is testable headless (the raster itself is not, but the DECISION is a pure function of
  // the probe). When the probe fails the view degrades to the SVG topology.
  canvas2dProbe?: () => boolean;
  // The "now" the freshness strings are computed against (epoch ms). Injectable so the model
  // is a pure function of (data, now); the render path defaults it to Date.now. The geometry,
  // the particle rates and the health encoding never depend on it.
  now?: number;
}

export type RenderMode = "canvas2d" | "svg-fallback";

export type AnimationMode = "animated" | "static-frame";

export type Column = "source" | "engine" | "destination";

export interface LiveNode {
  // A stable id. Source/destination ids reuse the topology node-id shape ("<side>:<kind>:
  // <name>") so a screen can cross-reference; the engine hub is the fixed id "engine".
  id: string;
  column: Column;
  kind: FlowRecord["source"]["kind"] | "engine";
  label: string;
  // Normalised centre (x,y in [0,1]); the canvas controller maps these to normalised canvas coordinates.
  x: number;
  y: number;
  // The flow ids incident on this node (drives the hub's aggregate stream and the count).
  flowIds: string[];
}

// One leg of a flow (a source->engine or engine->destination segment). Each carries the
// health presentation (hue + glyph + label), the throughput-derived particle rate and edge
// weight, the "flowing" (live stream) flag, and the cubic control points for a smooth pipe.
export interface LiveLeg {
  // "<flowId>:in" or "<flowId>:out" so the two legs of one flow are distinct but linkable.
  id: string;
  flowId: string;
  leg: "ingress" | "egress";
  fromNodeId: string;
  toNodeId: string;
  // The cubic from (x0,y0) to (x3,y3) with control points (x1,y1),(x2,y2) in normalised
  // space; horizontal control handles so the leg reads as a smooth pipe.
  x0: number; y0: number;
  x1: number; y1: number;
  x2: number; y2: number;
  x3: number; y3: number;
}

// One flow's full live-flow encoding (shared by both its legs): the status presentation, the
// bounded edge weight, the particle emission rate, and the flowing flag. Kept once per flow
// (not per leg) so the two legs of a flow always agree.
export interface LiveEdge {
  flowId: string;
  flow: FlowRecord;
  presentation: StatusPresentation;
  // The bounded thickness step (1/2/3) reused from the SVG map's throughputWeight, so the two
  // views encode volume identically.
  weight: EdgeWeight;
  // The particle emission rate as a bounded step (0..N), derived from throughput AND the
  // running state: a healthy/stale/unknown RUNNING flow is a DENSER stream (more particles),
  // a terminal (failed) or disabled or not-running flow emits no live particles (rate 0), so
  // the stream never fabricates flow. This is the "particles at a rate proportional to
  // throughput, an active run is a denser stream" requirement, made bounded and honest.
  particleRate: number;
  // Whether this flow shows a live particle stream: running AND non-terminal status (the same
  // rule topology.ts uses for the flowing dash). A failed/disabled flow is never "flowing".
  flowing: boolean;
  // The two legs (ingress, egress) for this flow.
  ingress: LiveLeg;
  egress: LiveLeg;
}

export interface LiveFlowModel {
  nodes: LiveNode[];
  edges: LiveEdge[];
  // The flat list of legs (every edge contributes its two legs), the unit the canvas controller
  // iterates to draw pipes and particles.
  legs: LiveLeg[];
  counts: StatusCounts;
  // The engine hub node, surfaced for convenience (it always exists when there is >=1 flow).
  engineNode: LiveNode | null;
}

export interface Rgb { r: number; g: number; b: number; }

export interface LiveFlowTableSpec {
  rows: TopologyTableRow[];
  columns: Array<DataColumn<TopologyTableRow>>;
}

export interface LiveFlowHandle {
  // The root to mount (the canvas-or-SVG visual + the always-present accessible table).
  el: HTMLElement;
  // The render mode actually chosen (after feature detection). Exposed so a screen can label
  // the active view honestly ("Live flow (canvas)" vs "Topology (SVG fallback)").
  mode: RenderMode;
  // The animation mode actually chosen (after the reduced-motion decision).
  animation: AnimationMode;
  // Re-render with a new flow set (after a poll). Rebuilds the model and both projections.
  setFlows: (flows: FlowRecord[]) => void;
  // Tear down the canvas animation loop and free the context (called on navigation away). Safe to
  // call repeatedly and in the SVG-fallback branch (a no-op there).
  dispose: () => void;
}

// The raster controller contract: the drawing surface's lifecycle (model in, resize, tear
// down). One implementation remains - the 2D-canvas controller - after the WebGL controller
// was retired (see chooseRenderMode).
export interface RasterController {
  setModel: (model: LiveFlowModel) => void;
  // Re-measure the canvas, rebuild the size-dependent geometry and repaint (the caller's
  // ResizeObserver drives this so a late-sized or resized canvas is never left stale).
  resize: () => void;
  // setFocus highlights ONE set of flows (a hovered source/destination's paths) by dimming every pipe,
  // particle and anchor NOT in the set, so the hovered node's routes stand out. null clears the focus.
  setFocus: (flowIds: Set<string> | null) => void;
  dispose: () => void;
}
