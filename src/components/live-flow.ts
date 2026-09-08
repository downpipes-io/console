// The OPTIONAL WebGL "live-flow" visualisation: a
// GPU-accelerated, opt-in PROGRESSIVE ENHANCEMENT over the existing SVG topology. It draws
// SOURCES on the left, the ENGINE in the centre, and DESTINATIONS on the right, with
// particles flowing along each route at a rate proportional to throughput, edge thickness
// for volume, and hue + glyph for health; an active run is a denser stream. It is the
// "single, audited, opt-in spectacle, not the everyday surface" the blueprint calls for:
// calm serious telemetry, not a casino.
//
// FOUR HARD CONTRACTS shape this module, mirrored from topology.ts and the brief:
//
//  1. PROGRESSIVE ENHANCEMENT, NEVER THE ONLY REPRESENTATION. The accessible data table
//     (the canonical form from the SVG map) stays present and canonical in EVERY branch.
//     renderLiveFlow always renders that table; the WebGL canvas is a pure visual sitting
//     on top of it (the canvas carries role="img" + an aria-label summary, exactly as the
//     SVG figure does, and the real operable controls are the table's row buttons).
//
//  2. FEATURE-DETECT AND FALL BACK. When WebGL is unavailable (no context, a blocked or
//     software-blacklisted GPU, an SSR/test environment), the visual DEGRADES to the
//     existing SVG topology component (renderTopology), which itself carries the same
//     accessible table. So the ladder is: WebGL -> SVG -> table, and the table is the floor.
//
//  3. HONOUR prefers-reduced-motion. Under reduced motion (or when motion is force-disabled
//     by a caller/test) the renderer paints a SINGLE STATIC FRAME and runs no animation
//     loop: the pipes, the nodes and a static snapshot of the particles are drawn once and
//     left still. The static frame is deterministic (particle phases are seeded by edge
//     index, not a clock), so it never reads a hidden wall clock.
//
//  4. HONEST BY CONSTRUCTION. The model NEVER fabricates a flow or a green: "unknown" stays
//     unknown (a neutral hue + the question glyph), "disabled" stays paused, and a flow is
//     only shown "flowing" (a live particle stream) when it is genuinely running AND its
//     status is non-terminal (the same rule topology.ts uses). Throughput is the truth: the
//     particle rate and the edge thickness are bounded, explainable functions of the real
//     byte count, never inflated; unknown throughput is the slowest rate and thinnest edge.
//     No-custody is never weakened: the visual renders names, counts, statuses, freshness
//     and byte SIZES only, all from the in-account engine; it transmits nothing.
//
// Like topology.ts, the module is split into a PURE MODEL LAYER and a DOM/GL RENDER LAYER.
// The model (buildLiveFlowModel + the decision helpers) touches no DOM, no GL, no clock
// (beyond an explicit `now`) and no randomness, so it runs in the bare-Node validator and is
// deterministic. Only the render* path touches the canvas, WebGL and matchMedia. Because
// WebGL cannot run headless, the validator asserts the pure parts: the data->geometry/layout
// mapping, the feature-detect/fallback decision, the reduced-motion static-frame decision,
// and that the table fallback is always produced (via the shared table-spec the renderer and
// the validator both read).

import { h } from "../lib/dom.ts";
import {
  renderTopology,
  tally,
  summaryPhrase,
  type FlowRecord,
  type TopologyHandle,
  type TopologyTableRow,
} from "./topology.ts";
import { dataTable } from "./data-table.ts";
import {
  chooseRenderMode,
  chooseAnimationMode,
  detectCanvas2d,
  buildLiveFlowModel,
  buildTableSpec,
} from "./live-flow-model.ts";
import { buildNodeLayer } from "./live-flow-node-layer.ts";
import { create2dController } from "./live-flow-raster.ts";
import { buildCanvasScaffold, toTopologyOptions, type CanvasScaffold } from "./live-flow-scaffold.ts";
import type {
  AnimationMode,
  LiveFlowModel,
  LiveFlowOptions,
  LiveFlowHandle,
  RasterController,
} from "./live-flow-types.ts";

// Public surface. The live-flow view consumes the SAME FlowRecord the SVG map does (the
// screen maps the engine's data once and feeds both), so the two views cannot disagree about
// what is being shown. The input/handle TYPES live in the dependency-light sibling
// live-flow-types.ts and the PURE MODEL + decisions in live-flow-model.ts; re-export both by
// name so a screen, view.ts and the validator import them straight from this module, exactly
// as before.

export type { FlowRecord, FlowStatus } from "./topology.ts";
// The shared idle-ambient rule (one rule, both views): defined beside the SVG renderer,
// re-exported here so the canvas, the validator and any screen read the same predicate.
export { hasAmbientSheen } from "./topology.ts";
export type {
  RenderMode,
  AnimationMode,
  Column,
  LiveNode,
  LiveLeg,
  LiveEdge,
  LiveFlowModel,
  LiveFlowOptions,
  LiveFlowHandle,
  Rgb,
  LiveFlowTableSpec,
} from "./live-flow-types.ts";
export {
  chooseRenderMode,
  detectCanvas2d,
  chooseAnimationMode,
  shouldAnimate,
  LIVE_FLOW_MAX_ANIMATED_EDGES,
  particleRateFor,
  isFlowing,
  buildLiveFlowModel,
  hubLaneOffset,
  statusFallbackRgb,
  buildTableSpec,
  litNodeIds,
  parseCssColour,
} from "./live-flow-model.ts";

// prefersReducedMotion reads the operator's CONSOLE-LEVEL motion preference first (the
// data-motion attribute lib/a11y-prefs.ts maintains on <html>: "reduced" forces calm,
// "full" is the explicit persisted opt-in that animates this console even when the OS
// prefers reduced motion - the only thing that outranks the OS, because the operator said
// so for this app specifically), then falls back to the OS media query. Guarded for a
// non-DOM/SSR/test environment (where the renderer is never called, but the guard keeps the
// module import-safe). Mirrors the topology.ts gate exactly so the two views agree on motion.
// Read via the DOM attribute rather than importing the prefs module, so the component stays
// dependency-light and the decision is overridable in tests by setting the attribute.
function prefersReducedMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement) {
    const pref = document.documentElement.getAttribute("data-motion");
    if (pref === "reduced") return true;
    if (pref === "full") return false;
  }
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// The DOM/canvas render layer. Only this section touches the DOM, the canvas and matchMedia.
// The pure model + decisions in live-flow-model.ts are what the validator asserts; these
// functions are a thin projection of them. The opts-only DOM scaffold (buildCanvasScaffold) and
// the topology-options projection (toTopologyOptions) live in the sibling live-flow-scaffold.ts,
// imported above.

// renderLiveFlow is the public entry. It feature-detects WebGL and, when unavailable, returns
// the SVG topology component (which carries the same accessible table) so the visual always
// degrades cleanly. When WebGL is available it mounts the canvas visual PLUS the canonical
// accessible table (the table is never dropped). It honours prefers-reduced-motion by painting
// a single static frame with no loop. Every server string in the table reaches the DOM via the
// textContent path (the reused topology table); the canvas draws no server text (names live in
// the table and the canvas aria-label summary, which is built from counts only).
export function renderLiveFlow(opts: LiveFlowOptions): LiveFlowHandle {
  const probe2d = opts.canvas2dProbe ?? detectCanvas2d;
  const mode = chooseRenderMode({ canvas2dAvailable: probe2d() });
  const animation = chooseAnimationMode({
    ...(opts.reducedMotion !== undefined ? { reducedMotion: opts.reducedMotion } : {}),
    mediaReducedMotion: prefersReducedMotion(),
  });

  // SVG fallback: delegate the visual to the existing topology component, which renders the SVG
  // enhancement AND the canonical accessible table. This is the "degrade to the existing SVG
  // topology when WebGL is unavailable" contract; the table stays canonical because
  // renderTopology owns it.
  if (mode === "svg-fallback") {
    const topo: TopologyHandle = renderTopology(toTopologyOptions(opts, opts.flows));
    return {
      el: topo.el,
      mode,
      animation,
      setFlows: (flows: FlowRecord[]) => topo.setFlows(flows),
      dispose: () => {
        /* the SVG component owns no animation loop to tear down */
      },
    };
  }

  // Raster branch: the 2D canvas visual + the canonical accessible table, mounted together.
  // The controller owns the drawing surface, the animation loop (or the single static frame)
  // and the teardown; if it cannot initialise, the view degrades to the SVG figure in place,
  // the table present throughout.
  return renderCanvasView(opts, animation);
}

// renderCanvasView mounts the canvas + the canonical table and drives the chosen raster
// controller (WebGL or 2D). The canvas is a PURE VISUAL (role="img" + an aria-label summary
// built from counts only, exactly like the SVG figure), so assistive tech is steered to the
// table for detail. The table is the operable surface (its row buttons open the drawer). The
// visual NEVER replaces the table.
// CanvasState is the mutable slice the canvas-view helpers (buildCanvasFrame, ensureController,
// replaceWithSvgFigure) share. Bundling it lets each step be a named function under the structural
// threshold while keeping one source of truth for the controller / model / disposed flags.
interface CanvasState {
  readonly opts: LiveFlowOptions;
  readonly animation: AnimationMode;
  readonly scaffold: CanvasScaffold;
  current: FlowRecord[];
  controller: RasterController | null;
  resizeObserver: ResizeObserver | null;
  initStarted: boolean;
  disposed: boolean;
  // The current model, built ONCE per data change by buildCanvasFrame and shared by the node layer
  // and the GL controller (so the two projections of one flow set can never disagree).
  lastModel: LiveFlowModel | null;
  // The handle returned to the caller; held on state so replaceWithSvgFigure can repoint it.
  handle: LiveFlowHandle;
}

function renderCanvasView(opts: LiveFlowOptions, animation: AnimationMode): LiveFlowHandle {
  const scaffold = buildCanvasScaffold(opts);
  const state: CanvasState = {
    opts,
    animation,
    scaffold,
    current: opts.flows,
    // The GL controller is created AFTER the canvas is connected/laid out (see ensureController),
    // not at construction time: the canvas has no size until it is in the document, so building it
    // here would size it to 1x1 and, under reduced motion (a single static frame, no loop, no
    // re-measure), leave a permanently blank canvas. The controller owns the rAF loop.
    controller: null,
    resizeObserver: null,
    initStarted: false,
    disposed: false,
    lastModel: null,
    handle: null as unknown as LiveFlowHandle,
  };

  state.handle = {
    el: scaffold.root,
    mode: "canvas2d",
    animation,
    setFlows: (flows: FlowRecord[]) => {
      state.current = flows;
      // Toggle the empty note presence honestly on a poll.
      buildCanvasFrame(state);
    },
    dispose: () => disposeCanvas(state),
  };

  // First paint: mount the table + the aria-label now (synchronous, so the table is present
  // immediately and the empty state is honest), but DEFER the GL controller until the canvas is
  // connected and laid out. buildCanvasFrame seeds the table; ensureController() (invoked below
  // once the canvas is connected) creates the GL context against a real size.
  buildCanvasFrame(state);

  wireDeferredInit({
    canvas: scaffold.canvas,
    ensureController: () => ensureController(state),
    isDisposed: () => state.disposed,
    getController: () => state.controller,
    setResizeObserver: (ro) => {
      state.resizeObserver = ro;
    },
  });

  wireDetachWatcher(opts, scaffold.root, state.handle, () => state.disposed);

  return state.handle;
}

// ensureController creates and seeds the GL controller exactly once, AFTER the canvas is connected
// (so it measures a real size). It is a no-op for the empty (zero-flow) state: there is nothing to
// draw, so no context is acquired; the calm empty note + the table carry the empty case. If GL
// init fails (a context lost between the probe and creation, or an unrecoverable later
// loss), it falls back in place to the SVG topology; the table is already present either way.
function ensureController(state: CanvasState): void {
  if (state.disposed || state.initStarted) return;
  if (state.current.length === 0) return; // m1: no GL for the empty state
  if (typeof document !== "undefined" && !state.scaffold.root.isConnected) return; // wait until mounted
  state.initStarted = true;
  // The probe can pass while real context creation fails, so a failed init still degrades to the
  // SVG figure in place (the table is already present either way).
  state.controller = create2dController(state.scaffold.canvas, state.animation);
  if (state.controller) {
    state.controller.setModel(state.lastModel ?? buildLiveFlowModel({ flows: state.current }));
  } else {
    replaceWithSvgFigure(state);
  }
}

// buildCanvasFrame mounts the table + aria-label, swaps the figure / empty note with the data, and
// (re)feeds the node layer and the GL controller from one shared model per data change.
function buildCanvasFrame(state: CanvasState): void {
  const { canvas, figure, nodeLayer, emptyNote, tableHost } = state.scaffold;
  canvas.setAttribute("aria-label", summaryPhrase(tally(state.current)));
  tableHost.replaceChildren(buildAccessibleTable(state.current, state.opts));
  // The figure and the empty note swap with the data: an empty account hides the (blank) canvas
  // panel and shows the calm explanation; a populated one shows the canvas. CSSOM per-property
  // writes, never an inline style attribute (style-src 'self' discipline).
  const empty = state.current.length === 0;
  figure.style.setProperty("display", empty ? "none" : "block");
  emptyNote.style.setProperty("display", empty ? "grid" : "none");
  // One model per data change, shared by the node layer and the GL controller.
  state.lastModel = empty ? null : buildLiveFlowModel({ flows: state.current });
  // Hovering/focusing a node dims the OTHER paths: the node layer toggles the DOM dim and hands the
  // focused flow set to the canvas controller, which dims the pipes/particles to match.
  buildNodeLayer(nodeLayer, state.lastModel, state.opts, (ids) => state.controller?.setFocus(ids));
  if (empty) {
    // The empty state never holds a GL context. If a previous non-empty poll created one, tear it
    // down so an emptied account does not keep a loop running on a hidden canvas.
    if (state.controller) {
      state.controller.dispose();
      state.controller = null;
      state.initStarted = false;
    }
    return;
  }
  // Non-empty: create the controller if the canvas is connected; otherwise the deferred init
  // (microtask / ResizeObserver) will create it once it is. If it already exists, re-feed it.
  if (!state.controller) {
    ensureController(state);
  } else {
    state.controller.setModel(state.lastModel!);
  }
}

// replaceWithSvgFigure tears the GL controller down (so its context-loss/theme listeners are removed
// and no rAF loop survives the swap) and replaces the whole root with the SVG topology handle, which
// carries its own table. Called for a failed initial init and for an unrecoverable later context
// loss, so the old controller must not be left attached to the detached canvas or to documentElement.
function replaceWithSvgFigure(state: CanvasState): void {
  if (state.controller) {
    state.controller.dispose();
    state.controller = null;
  }
  // renderTopology always includes a table, so to avoid a duplicate we replace the whole root with
  // the topology handle's element (which carries one table) and drop ours.
  const topo = renderTopology(toTopologyOptions(state.opts, state.current));
  state.scaffold.root.replaceChildren(topo.el);
  // Repoint setFlows at the SVG component from here on.
  state.handle.setFlows = (flows: FlowRecord[]) => {
    state.current = flows;
    topo.setFlows(flows);
  };
  state.handle.mode = "svg-fallback";
}

// disposeCanvas stops the resize observer and tears down the GL controller (its rAF loop + context).
function disposeCanvas(state: CanvasState): void {
  state.disposed = true;
  if (state.resizeObserver) {
    try {
      state.resizeObserver.disconnect();
    } catch {
      /* best-effort */
    }
    state.resizeObserver = null;
  }
  if (state.controller) {
    state.controller.dispose();
    state.controller = null;
  }
}

// wireDeferredInit installs the three triggers that create the GL controller AFTER the canvas is
// connected and laid out. ensureController() is idempotent and no-ops for the empty state, so all
// three can fire safely:
//  1. A microtask: if the root is already connected (a synchronous mount), seed immediately so
//     environments without a ResizeObserver still initialise once mounted.
//  2. A ResizeObserver on the canvas: it fires once on observe() after the canvas has a laid-out
//     box (i.e. is connected and sized), the reliable "post-mount" signal in a browser; the first
//     fire seeds the controller, later fires re-measure and repaint (so a static frame is
//     re-rendered at the new size, and the aspect-dependent pipe geometry is rebuilt). Installed
//     unconditionally so a view that starts empty and is later populated still re-measures.
//  3. A last-resort synchronous seed when neither a microtask nor a ResizeObserver exists.
function wireDeferredInit(ctx: {
  canvas: HTMLCanvasElement;
  ensureController: () => void;
  isDisposed: () => boolean;
  getController: () => RasterController | null;
  setResizeObserver: (ro: ResizeObserver | null) => void;
}): void {
  const { canvas, ensureController, isDisposed, getController, setResizeObserver } = ctx;
  if (typeof queueMicrotask === "function") {
    queueMicrotask(() => {
      if (!isDisposed()) ensureController();
    });
  }
  if (typeof ResizeObserver === "function") {
    try {
      const resizeObserver = new ResizeObserver(() => {
        if (isDisposed()) return;
        const controller = getController();
        if (!controller) {
          ensureController();
        } else {
          controller.resize();
        }
      });
      resizeObserver.observe(canvas);
      setResizeObserver(resizeObserver);
    } catch {
      setResizeObserver(null);
    }
  }
  if (typeof queueMicrotask !== "function" && typeof ResizeObserver !== "function") {
    // No microtask AND no ResizeObserver (an exotic environment). Seed synchronously so the canvas
    // is not left permanently blank; if not yet connected the canvas may measure 1x1, but that is
    // strictly better than never drawing, and the resize() path keeps it honest if a size arrives.
    ensureController();
  }
}

// wireDetachWatcher installs the opt-in detachment watcher (see LiveFlowOptions.selfDisposeOnDetach).
// A coarse 2s interval is plenty: a detached canvas shows nothing, so the only cost in the gap is the
// idle loop it exists to stop. Armed only once the root has been seen connected, so a host that mounts
// asynchronously is not torn down before it ever appears. dispose() is idempotent, so an explicit
// dispose racing the watcher is safe in either order.
function wireDetachWatcher(
  opts: LiveFlowOptions,
  root: HTMLElement,
  handle: LiveFlowHandle,
  isDisposed: () => boolean,
): void {
  if (!(opts.selfDisposeOnDetach && typeof window !== "undefined" && typeof window.setInterval === "function")) {
    return;
  }
  let seenConnected = false;
  const detachWatch = window.setInterval(() => {
    if (isDisposed()) {
      window.clearInterval(detachWatch);
      return;
    }
    if (root.isConnected) {
      seenConnected = true;
      return;
    }
    if (seenConnected) {
      window.clearInterval(detachWatch);
      handle.dispose();
    }
  }, 2000);
}

// buildAccessibleTable mounts the canonical data-table from the shared spec, using the SAME
// dataTable component topology.ts uses (one table implementation), with the row activation +
// filter the map uses. Always renders (even empty), carrying EVERY flow, which is the parity
// contract: the visual is an enhancement over this table, never a replacement.
function buildAccessibleTable(flows: FlowRecord[], opts: LiveFlowOptions): HTMLElement {
  const spec = buildTableSpec(flows, opts.now, opts.onActivateEdge);
  // Titled "Flows", not "Downpipes": a row is one flow (downpipe x destination), so a fanned-out
  // downpipe contributes several rows and the count must agree with the filter bar's "N flows".
  const section = h("section", { class: "live-flow__table-section", "aria-label": "Flows, source to destination" });
  section.appendChild(h("h3", { class: "live-flow__table-title" }, "Flows"));
  const handle = dataTable<TopologyTableRow>({
    columns: spec.columns,
    rows: spec.rows,
    rowKey: (r) => r.flow.id,
    label: "Flows, source to destination, with status and freshness",
    rowLabel: (r) => `${r.flow.source.name} to ${r.flow.destination.name}`,
    filter: { placeholder: "Filter flows", resultLabel: "flows" },
    ...(opts.onActivateEdge ? { onRowActivate: (r: TopologyTableRow) => opts.onActivateEdge!(r.flow.id) } : {}),
    empty: h(
      "div",
      { class: "dp-table__empty" },
      "No downpipes configured yet. Configure your first downpipe to see it here and on the live-flow view.",
    ),
  });
  section.appendChild(handle.el);
  return section;
}

// The DOM node layer over the canvas (buildNodeLayer) lives in the sibling live-flow-node-layer.ts
// so this file stays under the structural threshold; imported above and called by build().
//
// The 2D-CANVAS controller (create2dController) lives in the sibling live-flow-raster.ts so this
// file stays under the structural threshold; imported above and called by ensureController.
