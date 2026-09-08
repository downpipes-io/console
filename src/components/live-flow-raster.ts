// The 2D-CANVAS controller for the live-flow view (extracted from live-flow.ts to keep that file
// under the structural threshold; behaviour-preserving move only): the SAME living map as the GL
// controller, rasterised on the CPU. It exists for environments where WebGL is unavailable
// (graphics acceleration off, a blocklisted GPU, a privacy shield),
// where the old ladder dropped straight to a still SVG diagram. requestAnimationFrame + 2D raster
// need no GPU and no CSS animation support, so this rung animates essentially everywhere. It draws
// from the same model, the same shared geometry constants and the same honesty rules (stream only
// when flowing; sheen per hasAmbientSheen; failed/disabled inert; a single static frame under
// reduced motion), so the two raster views are visually interchangeable. Architecture: the
// STATIC pipes render once into an offscreen layer (rebuilt on data/size/theme change only);
// each frame blits it and draws the dynamic marks (anchors, hub, ripple, sheen, particles).

import { hasAmbientSheen, type StatusTone, type EdgeWeight } from "./topology.ts";
import {
  LIVE_FLOW_MAX_ANIMATED_EDGES,
  coreHalfW,
  HALO_SCALE,
  HALO_ALPHA,
  sheenAlphaFor,
  cubicPoint,
  staticPhase,
  frac,
} from "./live-flow-model.ts";
import { readToneColour, readCssColour } from "./live-flow-colours.ts";
import type {
  AnimationMode,
  LiveNode,
  LiveLeg,
  LiveEdge,
  LiveFlowModel,
  Rgb,
  RasterController,
} from "./live-flow-types.ts";

// Hub breath + ripple animation tuning (seconds, alphas and amplitudes). Named so the
// animation feel can be adjusted in one place; matches the GL pass cycles and amplitudes.
const HUB_BREATH_PERIOD_FLOWING_SEC = 5.2;
const HUB_BREATH_PERIOD_IDLE_SEC = 7.5;
const HUB_RIPPLE_PERIOD_SEC = 4.6;
const HUB_BREATH_AMP_FLOWING = 0.06;
const HUB_BREATH_AMP_IDLE = 0.09;
const HUB_RING_BASE_MAX_PX = 30;
const HUB_RING_BASE_HEIGHT_FRAC = 0.11;
const HUB_RING_ALPHA_FLOWING = 0.6;
const HUB_RING_ALPHA_IDLE = 0.55;
const HUB_RING_ALPHA_AMP = 0.12;
const HUB_RING_WIDTH_PX = 2.2;
const HUB_RIPPLE_ALPHA = 0.26;
const HUB_GLOW_ALPHA = 0.1;

// Anchor marker alpha (smaller markers read fainter so the dense banks stay legible).
const ANCHOR_ALPHA_SMALL = 0.4;
const ANCHOR_ALPHA_LARGE = 0.55;

export function create2dController(canvas: HTMLCanvasElement, animation: AnimationMode): RasterController | null {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) return null;
  const c2d = ctx;

  let model: LiveFlowModel | null = null;
  let rafId: number | null = null;
  let disposed = false;
  let startTime = 0;

  // Hover focus: when a source/destination node is hovered the caller passes its flow ids here, and
  // everything NOT in the set is drawn dimmed so the hovered node's paths stand out. null = no focus.
  let focusFlowIds: Set<string> | null = null;
  const FOCUS_DIM = 0.12; // alpha multiplier for a pipe/particle/anchor outside the focused set
  // An edge is lit when there is no focus, or when its flow is in the focused set.
  const edgeLit = (edge: LiveEdge): boolean => !focusFlowIds || focusFlowIds.has(edge.flow.id);
  // True when two focus sets are equivalent (both null, or the same size with the same members),
  // so a repeated focus event can skip the offscreen rebuild.
  const sameFocus = (a: Set<string> | null, b: Set<string> | null): boolean => {
    if (a === b) return true;
    if (!a || !b || a.size !== b.size) return false;
    for (const id of a) {
      if (!b.has(id)) return false;
    }
    return true;
  };
  // A node is lit when there is no focus, or when any flow incident on it is in the focused set
  // (the hovered node itself, the engine hub, and the opposite-column nodes its paths reach).
  const nodeLit = (node: LiveNode): boolean => !focusFlowIds || node.flowIds.some((f) => focusFlowIds!.has(f));

  // Past the edge budget the per-frame sheen + particle MOTION is skipped and no rAF loop runs (a static
  // frame): the cost of animating O(edges) every frame is what a large fleet cannot afford, not the pipes
  // themselves (those are pre-rendered once into the offscreen layer). Re-read per frame off the live model.
  const overBudget = (): boolean => !!model && model.edges.length > LIVE_FLOW_MAX_ANIMATED_EDGES;

  // The offscreen static-pipe layer (halos + cores), rebuilt only on model/size/theme change.
  const staticLayer = document.createElement("canvas");
  let staticCtx: CanvasRenderingContext2D | null = null;

  // Theme colours, cached like the GL controller (the probe + getComputedStyle are far too
  // costly for a frame path); invalidated on theme change.
  const toneCache = new Map<StatusTone, Rgb>();
  let accentCache: Rgb | null = null;
  const colourFor = (tone: StatusTone): Rgb => {
    let c = toneCache.get(tone);
    if (!c) {
      c = readToneColour(tone);
      toneCache.set(tone, c);
    }
    return c;
  };
  const hubColour = (): Rgb => {
    if (!accentCache) accentCache = readCssColour("--accent", { r: 0.52, g: 0.64, b: 1.0 });
    return accentCache;
  };
  const invalidateColours = (): void => {
    toneCache.clear();
    accentCache = null;
  };

  const pointScale = (): number =>
    typeof window !== "undefined" && window.devicePixelRatio ? Math.min(window.devicePixelRatio, 2) : 1;

  const rgba = (c: Rgb, a: number): string =>
    `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${a})`;

  // resize re-measures the canvas + the offscreen layer against the CSS box and the DPR (the
  // only place layout is read, mirroring the GL controller's event-driven resize contract).
  const resize = (): void => {
    const dpr = pointScale();
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const hgt = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== hgt) {
      canvas.width = w;
      canvas.height = hgt;
    }
    if (staticLayer.width !== w || staticLayer.height !== hgt) {
      staticLayer.width = w;
      staticLayer.height = hgt;
    }
  };

  // legPath traces one cubic leg into the current path of a context, in device pixels.
  const legPath = (g: CanvasRenderingContext2D, leg: LiveLeg): void => {
    const W = canvas.width;
    const H = canvas.height;
    g.moveTo(leg.x0 * W, leg.y0 * H);
    g.bezierCurveTo(leg.x1 * W, leg.y1 * H, leg.x2 * W, leg.y2 * H, leg.x3 * W, leg.y3 * H);
  };

  // buildStatic paints the halo + core pipes once into the offscreen layer, mirroring the GL
  // buildPipeGeometry exactly (same widths, same alphas, same device-pixel floor).
  const buildStatic = (m: LiveFlowModel): void => {
    staticCtx = staticLayer.getContext("2d");
    if (!staticCtx) return;
    const g = staticCtx;
    g.clearRect(0, 0, staticLayer.width, staticLayer.height);
    g.lineCap = "round";
    const heightPx = staticLayer.height > 0 ? staticLayer.height : 1;
    const dpr = pointScale();
    const floorHalfW = (1.25 * dpr) / heightPx;
    const pipeHalfW = (weight: EdgeWeight): number => Math.max(coreHalfW(weight), floorHalfW);
    const runningRgb = colourFor("trust");
    const haloAlpha = m.edges.length <= 3 ? 0.16 : HALO_ALPHA;
    for (const edge of m.edges) {
      if (!edge.flowing) continue;
      g.strokeStyle = rgba(runningRgb, haloAlpha * (edgeLit(edge) ? 1 : FOCUS_DIM));
      g.lineWidth = pipeHalfW(edge.weight) * HALO_SCALE * 2 * heightPx;
      g.beginPath();
      legPath(g, edge.ingress);
      legPath(g, edge.egress);
      g.stroke();
    }
    for (const edge of m.edges) {
      const rgb = colourFor(edge.presentation.tone);
      const alpha = (edge.presentation.tone === "neutral" ? 0.42 : 0.72) * (edgeLit(edge) ? 1 : FOCUS_DIM);
      g.strokeStyle = rgba(rgb, alpha);
      g.lineWidth = pipeHalfW(edge.weight) * 2 * heightPx;
      g.beginPath();
      legPath(g, edge.ingress);
      legPath(g, edge.egress);
      g.stroke();
    }
  };

  // strokeSegment draws the sub-curve of a leg between params [a, b] as a sampled polyline
  // (the sheen pulse and the particle trail both ride this).
  const strokeSegment = (
    leg: LiveLeg,
    range: { a: number; b: number },
    stroke: { style: string; widthPx: number },
  ): void => {
    const { a, b } = range;
    const W = canvas.width;
    const H = canvas.height;
    c2d.strokeStyle = stroke.style;
    c2d.lineWidth = stroke.widthPx;
    c2d.lineCap = "round";
    c2d.beginPath();
    const steps = 8;
    for (let i = 0; i <= steps; i++) {
      const t = Math.min(1, Math.max(0, a + ((b - a) * i) / steps));
      const pt = cubicPoint(leg, t);
      if (i === 0) c2d.moveTo(pt.x * W, pt.y * H);
      else c2d.lineTo(pt.x * W, pt.y * H);
    }
    c2d.stroke();
  };

  const disc = (x: number, y: number, rPx: number, style: string): void => {
    c2d.fillStyle = style;
    c2d.beginPath();
    c2d.arc(x * canvas.width, y * canvas.height, Math.max(0.5, rPx), 0, Math.PI * 2);
    c2d.fill();
  };

  const ring = (cx: number, cy: number, style: { rPx: number; fill: string; widthPx: number }): void => {
    c2d.strokeStyle = style.fill;
    c2d.lineWidth = style.widthPx;
    c2d.beginPath();
    c2d.arc(cx * canvas.width, cy * canvas.height, Math.max(0.5, style.rPx), 0, Math.PI * 2);
    c2d.stroke();
  };

  // drawAnchors paints the source/destination node markers (density-adaptive, identical sizing to
  // the GL pass; the engine hub is drawn separately).
  const drawAnchors = (m: LiveFlowModel, dpr: number, heightPx: number): void => {
    const anchorRgb = colourFor("neutral");
    let sourceCount = 0;
    let destCount = 0;
    for (const node of m.nodes) {
      if (node.column === "source") sourceCount++;
      else if (node.column === "destination") destCount++;
    }
    const bandPx = heightPx * 0.8;
    const anchorSize = (count: number): number => {
      const fit = count > 0 ? (bandPx / count) * 0.85 : 7 * dpr;
      return Math.max(2.5 * dpr, Math.min(7 * dpr, fit));
    };
    for (const node of m.nodes) {
      if (node.column === "engine") continue;
      const size = anchorSize(node.column === "source" ? sourceCount : destCount);
      const alpha = (size < 4 * dpr ? ANCHOR_ALPHA_SMALL : ANCHOR_ALPHA_LARGE) * (nodeLit(node) ? 1 : FOCUS_DIM);
      disc(node.x, node.y, size / 2, rgba(anchorRgb, alpha));
    }
  };

  // drawHub paints the engine hub: breath + the watch ripple (same cycles and amplitudes as the GL pass).
  const drawHub = (m: LiveFlowModel, elapsedSec: number, dpr: number, heightPx: number): void => {
    if (!m.engineNode) return;
    const anyFlowing = m.edges.some((e) => e.flowing);
    const breathPeriod = anyFlowing ? HUB_BREATH_PERIOD_FLOWING_SEC : HUB_BREATH_PERIOD_IDLE_SEC;
    const phase = animation === "animated" ? Math.sin((elapsedSec * 2 * Math.PI) / breathPeriod) : 0;
    const ringBase = Math.min(HUB_RING_BASE_MAX_PX * dpr, heightPx * HUB_RING_BASE_HEIGHT_FRAC);
    const ringSize = ringBase * (1 + (anyFlowing ? HUB_BREATH_AMP_FLOWING : HUB_BREATH_AMP_IDLE) * phase);
    const ringAlpha = (anyFlowing ? HUB_RING_ALPHA_FLOWING : HUB_RING_ALPHA_IDLE) + HUB_RING_ALPHA_AMP * phase;
    const hub = hubColour();
    disc(m.engineNode.x, m.engineNode.y, (ringSize * 0.62) / 2, rgba(hub, HUB_GLOW_ALPHA));
    ring(m.engineNode.x, m.engineNode.y, { rPx: ringSize / 2, fill: rgba(hub, ringAlpha), widthPx: HUB_RING_WIDTH_PX * dpr });
    if (animation === "animated") {
      const rt = frac(elapsedSec / HUB_RIPPLE_PERIOD_SEC);
      const rippleAlpha = HUB_RIPPLE_ALPHA * (1 - rt) ** 1.6;
      if (rippleAlpha > 0.01) {
        ring(m.engineNode.x, m.engineNode.y, { rPx: (ringBase * (1 + rt * 2.2)) / 2, fill: rgba(hub, rippleAlpha), widthPx: 1.6 * dpr });
      }
    }
  };

  // drawSheen paints the idle ambient sheen (hasAmbientSheen; animated mode only; same cadence and
  // alpha). Skipped past the edge budget, the per-frame sheen over every idle edge is the O(edges)
  // cost a large fleet drops.
  const drawSheen = (m: LiveFlowModel, elapsedSec: number, dpr: number, heightPx: number): void => {
    const sheenAlpha = sheenAlphaFor(m.edges.length);
    const floorHalfW = (1.25 * dpr) / heightPx;
    let sheenIndex = 0;
    for (const edge of m.edges) {
      if (!hasAmbientSheen(edge.flow) || !edgeLit(edge)) {
        sheenIndex += 2;
        continue;
      }
      const rgb = colourFor(edge.presentation.tone);
      const halfW = Math.max(coreHalfW(edge.weight), floorHalfW) * 1.6;
      for (const leg of [edge.ingress, edge.egress]) {
        const period = 9 + staticPhase(sheenIndex, 1) * 3;
        const t = frac(staticPhase(sheenIndex, 0) + elapsedSec / period);
        strokeSegment(leg, { a: t - 0.07, b: t + 0.07 }, { style: rgba(rgb, sheenAlpha * 1.5), widthPx: halfW * 2 * heightPx });
        sheenIndex++;
      }
    }
  };

  // drawParticles paints the particle streams (flowing edges only; same phases, rates, sizes and
  // trust hue). The LAST pass in the frame, so a single early return past the edge budget skips all
  // per-frame particle work (the static pipes, anchors and hub are already painted).
  const drawParticles = (m: LiveFlowModel, elapsedSec: number, dpr: number): void => {
    const streamRgb = colourFor("trust");
    let legIndex = 0;
    for (const edge of m.edges) {
      if (!edge.flowing || edge.particleRate <= 0 || !edgeLit(edge)) {
        legIndex += 2;
        continue;
      }
      const perLeg = edge.particleRate;
      const headPx = (4 + edge.weight * 2) * dpr;
      const trailT = 0.04 + edge.particleRate * 0.01;
      for (const leg of [edge.ingress, edge.egress]) {
        for (let k = 0; k < perLeg; k++) {
          const base = (k + 1) / (perLeg + 1);
          const seed = staticPhase(legIndex, k);
          const speed = 0.12 + edge.particleRate * 0.05;
          const t = animation === "static-frame" ? frac(base + seed) : frac(base + seed + elapsedSec * speed);
          strokeSegment(leg, { a: Math.max(0, t - trailT), b: t }, { style: rgba(streamRgb, 0.35), widthPx: headPx * 0.8 });
          const pt = cubicPoint(leg, t);
          disc(pt.x, pt.y, headPx / 2, rgba(streamRgb, 0.95));
        }
        legIndex++;
      }
    }
  };

  // renderFrame mirrors the GL frame: blit the static pipes, then anchors, hub (breath + watch
  // ripple), idle sheen and the particle streams, each pass a named helper above.
  const renderFrame = (elapsedSec: number): void => {
    if (disposed || !model) return;
    const m = model;
    c2d.clearRect(0, 0, canvas.width, canvas.height);
    if (staticCtx) c2d.drawImage(staticLayer, 0, 0);
    const dpr = pointScale();
    const heightPx = canvas.height > 0 ? canvas.height : 1;
    drawAnchors(m, dpr, heightPx);
    drawHub(m, elapsedSec, dpr, heightPx);
    if (animation === "animated" && !overBudget()) drawSheen(m, elapsedSec, dpr, heightPx);
    // Past the edge budget the static pipes, anchors and hub stand alone (no per-frame particles).
    if (overBudget()) return;
    drawParticles(m, elapsedSec, dpr);
  };

  const loop = (ts: number): void => {
    if (disposed) {
      rafId = null;
      return;
    }
    if (startTime === 0) startTime = ts;
    renderFrame((ts - startTime) / 1000);
    if (disposed) {
      rafId = null;
      return;
    }
    rafId = requestAnimationFrame(loop);
  };

  const start = (): void => {
    if (disposed) return;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    startTime = 0;
    // Static frame (no rAF loop) under reduced motion OR past the edge budget; otherwise animate.
    if (animation === "static-frame" || overBudget()) {
      renderFrame(0);
    } else if (typeof requestAnimationFrame === "function") {
      rafId = requestAnimationFrame(loop);
    } else {
      renderFrame(0);
    }
  };

  const rebuildAndRepaint = (): void => {
    if (disposed || !model) return;
    resize();
    buildStatic(model);
    if (animation === "static-frame") renderFrame(0);
  };

  // Theme following, identical contract to the GL controller (recolour on data-theme or the
  // prefers-color-scheme media change; cache invalidated, static layer rebuilt). The wiring +
  // teardown live in a helper so this factory stays under the structural threshold.
  const teardownTheme = wireThemeObserver(() => {
    invalidateColours();
    rebuildAndRepaint();
  });

  return {
    setModel(m: LiveFlowModel): void {
      model = m;
      focusFlowIds = null; // a new flow set invalidates any prior hover focus (the DOM layer is rebuilt too)
      resize();
      buildStatic(m);
      start();
    },
    resize(): void {
      rebuildAndRepaint();
    },
    setFocus(ids: Set<string> | null): void {
      if (disposed) return;
      const next = ids && ids.size > 0 ? ids : null;
      // Repeated hover/focus events for the same node (or repeated blur to no focus) resolve to
      // the same set; skip the offscreen re-rasterise when the focus has not actually changed so
      // rapid mouse movement does not rebuild the static layer on every event.
      if (sameFocus(focusFlowIds, next)) return;
      focusFlowIds = next;
      if (!model) return;
      buildStatic(model); // re-rasterise the pipes with the dim applied
      if (animation === "static-frame") renderFrame(0); // animated mode repaints on its own next frame
    },
    dispose(): void {
      disposed = true;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      teardownTheme();
    },
  };
}

// wireThemeObserver installs the data-theme MutationObserver + the prefers-color-scheme media
// listener that recolour the raster controller, and returns a best-effort teardown. Both are
// optional (an SSR/test environment may lack either), so each is guarded and any failure is
// swallowed; the returned teardown is idempotent.
function wireThemeObserver(onThemeChanged: () => void): () => void {
  let themeObserver: MutationObserver | null = null;
  let mediaQuery: MediaQueryList | null = null;
  if (typeof MutationObserver === "function" && typeof document !== "undefined" && document.documentElement) {
    try {
      themeObserver = new MutationObserver(onThemeChanged);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    } catch {
      themeObserver = null;
    }
  }
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    try {
      mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      if (typeof mediaQuery.addEventListener === "function") mediaQuery.addEventListener("change", onThemeChanged);
    } catch {
      mediaQuery = null;
    }
  }
  return (): void => {
    if (themeObserver) {
      try {
        themeObserver.disconnect();
      } catch {
        /* best-effort */
      }
      themeObserver = null;
    }
    if (mediaQuery && typeof mediaQuery.removeEventListener === "function") {
      try {
        mediaQuery.removeEventListener("change", onThemeChanged);
      } catch {
        /* best-effort */
      }
    }
    mediaQuery = null;
  };
}
