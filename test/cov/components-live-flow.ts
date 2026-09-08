// Coverage validator for src/components/live-flow.ts: the DOM/canvas RENDER layer of the optional
// live-flow visualisation. The pure model + decisions live in live-flow-model.ts and are pinned by
// test/validate-live-flow.ts; that suite also exercises the SVG-fallback branch, the reduced-motion
// static frame, the node layer and the hover focus. This file drives the parts that suite leaves
// cold: the ANIMATED render loop (the breath, the watch ripple, the idle sheen and the particle
// streams under requestAnimationFrame), the theme-change and resize repaint paths, the live-colour
// probe, the in-place degrade to the SVG figure when the 2d context cannot be acquired, the
// empty <-> populated controller teardown, the dense-destination summary chip, the self-dispose
// watcher, and the matchMedia motion fallback.
//
// WebGL was retired; the one raster renderer is the 2D canvas controller, so a hand
// rolled 2D context + a fireable ResizeObserver/MutationObserver + a controllable rAF are enough to
// run the whole render path headless. The stub is a richer sibling of the one in
// validate-live-flow.ts (this one's getComputedStyle returns a real parseable colour, its observers
// genuinely fire, and its rAF/setInterval are driven by the test), kept local so the shared suite's
// careful stub is untouched. It reads no real GPU and transmits nothing. Run with
// `node test/cov/components-live-flow.ts` (auto-run by test/cov/run.mjs).

import {
  renderLiveFlow,
  buildLiveFlowModel,
  type FlowRecord,
  type LiveFlowHandle,
} from "../../src/components/live-flow.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const NOW = Date.parse("2026-06-07T12:00:00Z");
function ts(deltaSec: number): string {
  return new Date(NOW + deltaSec * 1000).toISOString();
}

// ---------------------------------------------------------------------------------------------
// A local DOM + 2D-canvas stub. Only what the render layer, the reused topology/data-table table,
// and the 2D controller touch is implemented. Unlike the shared suite's stub, the observers here
// FIRE on demand and getComputedStyle resolves a real colour, so the animated/theme/resize/colour
// paths run. CSSOM writes go through setProperty (never a style attribute), so the CSP-safe
// discipline is preserved.
// ---------------------------------------------------------------------------------------------

class StubStyle {
  props: Record<string, string> = {};
  setProperty(name: string, value: string): void {
    this.props[name] = String(value);
  }
  getPropertyValue(name: string): string {
    return this.props[name] ?? "";
  }
  removeProperty(name: string): void {
    delete this.props[name];
  }
}

interface StubEvent {
  type: string;
  key?: string;
  defaultPrevented: boolean;
  preventDefault(): void;
}

class StubClassList {
  private owner: StubNode;
  constructor(owner: StubNode) {
    this.owner = owner;
  }
  private tokens(): Set<string> {
    return new Set((this.owner.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
  }
  private write(set: Set<string>): void {
    this.owner.setAttribute("class", [...set].join(" "));
  }
  add(...cs: string[]): void {
    const t = this.tokens();
    for (const c of cs) t.add(c);
    this.write(t);
  }
  remove(...cs: string[]): void {
    const t = this.tokens();
    for (const c of cs) t.delete(c);
    this.write(t);
  }
  contains(c: string): boolean {
    return this.tokens().has(c);
  }
  toggle(c: string, force?: boolean): boolean {
    const t = this.tokens();
    const has = t.has(c);
    const on = force === undefined ? !has : force;
    if (on) t.add(c);
    else t.delete(c);
    this.write(t);
    return on;
  }
}

let nodeSeq = 0;
const CONNECTED = new Set<number>();

class StubNode {
  readonly nid = ++nodeSeq;
  kind: "element" | "text";
  nodeType: number;
  tagName = "";
  childNodes: StubNode[] = [];
  parentNode: StubNode | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(ev: StubEvent) => void>> = {};
  style = new StubStyle();
  classList: StubClassList;
  dataset: Record<string, string> = {};
  text_ = "";
  // A fixed non-zero client box so resize() measures a real size.
  clientWidth = 800;
  clientHeight = 400;
  width = 0;
  height = 0;
  ctx2d: Fake2d | null = null;
  // When true a <canvas> getContext("2d") returns null (a probe that passed but real creation
  // fails: the in-place degrade-to-SVG path). When set to "throw", getContext throws.
  ctxFail: boolean | "throw" = false;

  constructor(kind: "element" | "text", tag = "") {
    this.kind = kind;
    this.nodeType = kind === "text" ? 3 : 1;
    this.tagName = tag.toUpperCase();
    this.classList = new StubClassList(this);
  }

  get className(): string {
    return this.attrs.class ?? "";
  }
  set className(v: string) {
    this.attrs.class = String(v);
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k: string): void {
    delete this.attrs[k];
  }
  hasAttribute(k: string): boolean {
    return k in this.attrs;
  }

  appendChild(child: StubNode | null): StubNode | null {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child: StubNode): StubNode {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) {
      this.childNodes.splice(i, 1);
      child.parentNode = null;
    }
    return child;
  }
  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  replaceChildren(...nodes: StubNode[]): void {
    for (const c of [...this.childNodes]) this.removeChild(c);
    for (const n of nodes) this.appendChild(n);
  }

  get isConnected(): boolean {
    let n: StubNode | null = this;
    while (n) {
      if (CONNECTED.has(n.nid)) return true;
      n = n.parentNode;
    }
    return false;
  }

  set textContent(v: string) {
    this.text_ = v == null ? "" : String(v);
    this.childNodes = [];
  }
  get textContent(): string {
    if (this.kind === "text") return this.text_;
    let out = this.text_ || "";
    for (const c of this.childNodes) out += c.textContent;
    return out;
  }

  addEventListener(type: string, fn: (ev: StubEvent) => void): void {
    this.listeners[type] ||= []; this.listeners[type].push(fn);
  }
  removeEventListener(type: string, fn: (ev: StubEvent) => void): void {
    const l = this.listeners[type];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  dispatchEvent(ev: StubEvent): boolean {
    for (const fn of [...(this.listeners[ev.type] ?? [])]) fn.call(this, ev);
    return !ev.defaultPrevented;
  }
  focus(): void {
    /* no-op */
  }

  getContext(kind: string): Fake2d | null {
    if (kind !== "2d") return null;
    if (this.ctxFail === "throw") throw new Error("context creation refused");
    if (this.ctxFail) return null;
    this.ctx2d ||= new Fake2d();
    return this.ctx2d;
  }

  // closest: the data-table's row click guard calls ev.target.closest("button, a, input, ...") to
  // skip activation when the click landed on an inner control. Only the tag-list form is needed; a
  // row click whose target is the row itself walks up and matches none of these (returns null), so
  // the row activation proceeds.
  closest(sel: string): StubNode | null {
    const tags = sel.split(",").map((s) => s.trim().toUpperCase());
    let n: StubNode | null = this;
    while (n) {
      if (n.nodeType === 1 && tags.includes(n.tagName)) return n;
      n = n.parentNode;
    }
    return null;
  }

  private walk(cb: (n: StubNode) => void): void {
    for (const c of this.childNodes) {
      cb(c);
      c.walk(cb);
    }
  }
  querySelector(sel: string): StubNode | null {
    let found: StubNode | null = null;
    const want = sel.toUpperCase();
    this.walk((n) => {
      if (!found && n.nodeType === 1 && n.tagName === want) found = n;
    });
    return found;
  }
  querySelectorAll(sel: string): StubNode[] {
    const out: StubNode[] = [];
    const want = sel.toUpperCase();
    this.walk((n) => {
      if (n.nodeType === 1 && n.tagName === want) out.push(n);
    });
    return out;
  }
}

// Fake2d records each draw call, and the style/width set on it, so a test can prove a given frame
// (a particle stream, the hub ring, a dimmed pipe) was genuinely painted and not skipped.
class Fake2d {
  strokeStyle = "";
  fillStyle = "";
  lineWidth = 0;
  lineCap = "";
  drawCalls = 0;
  strokeCount = 0;
  fillCount = 0;
  drawImageCount = 0;
  strokeStyles: string[] = [];
  clearRect(): void {}
  drawImage(): void {
    this.drawCalls++;
    this.drawImageCount++;
  }
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  bezierCurveTo(): void {}
  arc(): void {}
  stroke(): void {
    this.drawCalls++;
    this.strokeCount++;
    this.strokeStyles.push(this.strokeStyle);
  }
  fill(): void {
    this.drawCalls++;
    this.fillCount++;
  }
}

// ---- controllable rAF, observers, matchMedia, setInterval ----------------------------------

interface RafHarness {
  scheduleCount: number;
  queue: Array<(ts: number) => void>;
  flush(ts?: number): void;
  restore(): void;
}
// A real (driven) rAF: callbacks queue; flush() runs the ones currently queued (so a loop that
// re-requests on each frame advances one tick per flush, never an infinite synchronous spin).
let _rafHarness: RafHarness | null = null;
function installRaf(): RafHarness {
  const g = globalThis as unknown as Record<string, unknown>;
  const prevRaf = g.requestAnimationFrame;
  const prevCancel = g.cancelAnimationFrame;
  const ids = new Map<number, (ts: number) => void>();
  let idSeq = 0;
  const h: RafHarness = {
    scheduleCount: 0,
    queue: [],
    flush(ts = 16): void {
      const due = this.queue;
      this.queue = [];
      for (const cb of due) cb(ts);
    },
    restore(): void {
      g.requestAnimationFrame = prevRaf;
      g.cancelAnimationFrame = prevCancel;
      _rafHarness = null;
    },
  };
  g.requestAnimationFrame = (cb: (ts: number) => void): number => {
    h.scheduleCount++;
    const id = ++idSeq;
    ids.set(id, cb);
    h.queue.push(cb);
    return id;
  };
  g.cancelAnimationFrame = (id: number): void => {
    const cb = ids.get(id);
    if (cb) {
      const i = h.queue.indexOf(cb);
      if (i >= 0) h.queue.splice(i, 1);
      ids.delete(id);
    }
  };
  _rafHarness = h;
  return h;
}

// Fireable observers: the controller installs a MutationObserver (theme) and renderCanvasView a
// ResizeObserver (post-mount seed + resize). The shared suite's observers never fire; these expose
// their callbacks so a test can drive a theme change and a resize.
const resizeCbs: Array<() => void> = [];
const mutationCbs: Array<() => void> = [];
function fireResize(): void {
  for (const cb of [...resizeCbs]) cb();
}
function fireMutation(): void {
  for (const cb of [...mutationCbs]) cb();
}

// matchMedia: the test sets reduceMatch/darkMatch before a render to drive prefersReducedMotion's
// media branch and the controller's prefers-color-scheme follow.
let reduceMatch = false;
let darkMatch = false;
let matchMediaThrows = false;

// setInterval/clearInterval capture for the self-dispose watcher: the test holds the registered
// callback and fires it by hand (no real timer).
interface IntervalReg {
  fn: () => void;
  cleared: boolean;
}
const intervals: IntervalReg[] = [];

function installStubDom(opts?: { noComputedStyle?: boolean; bodyless?: boolean }): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const make = (tag: string): StubNode => new StubNode("element", tag);
  const docEl = make("html");
  const body = make("body");
  docEl.appendChild(body);
  CONNECTED.add(docEl.nid);
  g.document = {
    __stub: true,
    documentElement: docEl,
    body: opts?.bodyless ? null : body,
    createElement: (tag: string) => make(tag),
    createElementNS: (_ns: string, tag: string) => make(tag),
    createTextNode: (t: string) => {
      const n = new StubNode("text");
      n.text_ = t == null ? "" : String(t);
      return n;
    },
    createDocumentFragment: () => new StubNode("element", "fragment"),
    readyState: "complete",
  };
  g.Node = StubNode;
  g.window = globalThis;
  g.matchMedia = (q: string) => {
    if (matchMediaThrows) throw new Error("matchMedia blocked");
    return {
      matches: q.includes("reduce") ? reduceMatch : q.includes("dark") ? darkMatch : false,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    };
  };
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = g.matchMedia;
  // getComputedStyle resolves the colour probe to a REAL rgb() string so readCssColour parses a
  // live value (the success path + the probe.remove() cleanup), unless a test wants the empty
  // fallback. A distinctive value so a test can tell a themed colour from the static fallback.
  if (opts?.noComputedStyle) {
    g.getComputedStyle = () => ({ color: "", getPropertyValue: () => "" });
  } else {
    g.getComputedStyle = () => ({ color: "rgb(10, 200, 150)", getPropertyValue: () => "" });
  }
  g.MutationObserver = class {
    cb: () => void;
    constructor(cb: () => void) {
      this.cb = cb;
      mutationCbs.push(cb);
    }
    observe(): void {}
    disconnect(): void {
      const i = mutationCbs.indexOf(this.cb);
      if (i >= 0) mutationCbs.splice(i, 1);
    }
  };
  g.ResizeObserver = class {
    cb: () => void;
    constructor(cb: () => void) {
      this.cb = cb;
      resizeCbs.push(cb);
    }
    observe(): void {}
    disconnect(): void {
      const i = resizeCbs.indexOf(this.cb);
      if (i >= 0) resizeCbs.splice(i, 1);
    }
  };
  // devicePixelRatio drives the pointScale() branch (a DPR > 1 exercises the Math.min(dpr, 2)
  // clamp and the device-pixel floor arithmetic).
  (globalThis as unknown as { devicePixelRatio: number }).devicePixelRatio = 2;
  // window.setInterval / clearInterval for the self-dispose watcher: captured, never a real timer.
  (g.window as Record<string, unknown>).setInterval = (fn: () => void): IntervalReg => {
    const reg: IntervalReg = { fn, cleared: false };
    intervals.push(reg);
    return reg;
  };
  (g.window as Record<string, unknown>).clearInterval = (reg: IntervalReg): void => {
    if (reg) reg.cleared = true;
  };
}

function uninstallStubDom(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.document;
  delete g.Node;
  resizeCbs.length = 0;
  mutationCbs.length = 0;
  intervals.length = 0;
  reduceMatch = false;
  darkMatch = false;
  matchMediaThrows = false;
  delete (globalThis as unknown as Record<string, unknown>).requestAnimationFrame;
  delete (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame;
}

async function flushMicrotasks(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function markConnected(root: unknown): void {
  CONNECTED.add((root as StubNode).nid);
}

// canvasOf / fake2dOf pull the canvas and its recording 2D context out of a rendered root.
function canvasOf(handle: LiveFlowHandle): StubNode | null {
  return (handle.el as unknown as StubNode).querySelector("canvas");
}
function fake2dOf(handle: LiveFlowHandle): Fake2d | null {
  const c = canvasOf(handle);
  return c ? (c.getContext("2d") as Fake2d | null) : null;
}
function byClass(root: StubNode, tag: string, cls: string): StubNode[] {
  return root.querySelectorAll(tag).filter((n) => n.classList.contains(cls));
}

// A representative multi-status flow set (one running healthy edge so a live stream is drawn, an
// idle stale edge so the ambient sheen is drawn, a failed and a disabled edge that must stay inert,
// and a couple of distinct sources/destinations so the node layer and anchors have content).
function sampleFlows(): FlowRecord[] {
  return [
    {
      id: "dp-1",
      source: { name: "uploads-prod", kind: "kv" },
      destination: { name: "archive-bucket", kind: "r2" },
      status: "healthy",
      lastRunAt: ts(-3 * 3600),
      cadence: 86400,
      bytesPerRun: 2 * 1024 * 1024,
      enabled: true,
      running: true, // flowing -> a live particle stream
    },
    {
      id: "dp-2",
      source: { name: "sessions", kind: "kv" },
      destination: { name: "cold-store", kind: "r2" },
      status: "stale",
      lastRunAt: ts(-50 * 3600),
      cadence: 3600,
      bytesPerRun: 512 * 1024,
      enabled: true,
      running: false, // idle -> ambient sheen
    },
    {
      id: "dp-3",
      source: { name: "ledger", kind: "d1" },
      destination: { name: "offsite-s3", kind: "s3" },
      status: "failed",
      lastRunAt: ts(-2 * 3600),
      cadence: 43200,
      bytesPerRun: 80 * 1024 * 1024,
      enabled: true,
      running: false, // inert
    },
    {
      id: "dp-4",
      source: { name: "api-tokens", kind: "secrets" },
      destination: { name: "vault-mirror", kind: "r2" },
      status: "disabled",
      lastRunAt: ts(-200 * 3600),
      cadence: 86400,
      bytesPerRun: null,
      enabled: false,
      running: false, // inert
    },
  ];
}

async function main(): Promise<void> {
  await animatedFrameTests();
  await themeAndResizeTests();
  await degradeToSvgTests();
  await emptyTransitionTests();
  await denseDestinationTests();
  await selfDisposeTests();
  await matchMediaMotionTests();
  await svgFallbackOptionTests();
  await compactAndRepollTests();
  await kindAndIdleTests();
  await exoticEnvTests();
  await tableRowAndStaticFocusTests();
  await scaleGuardAndNoRafTests();

  console.log(failures === 0 ? "\nLIVE-FLOW RENDER-COVERAGE PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) process.exit(1);
}

// (1) The ANIMATED render loop. With animation === "animated" the controller schedules a rAF loop;
// flushing it runs renderFrame at a non-zero elapsed time, exercising the hub breath + the watch
// ripple, the idle ambient sheen over the stale edge, and the live particle stream over the running
// edge. The static-frame suite never reaches any of these.
async function animatedFrameTests(): Promise<void> {
  installStubDom();
  const raf = installRaf();
  let handle: LiveFlowHandle | null = null;
  try {
    handle = renderLiveFlow({
      flows: sampleFlows(),
      reducedMotion: false, // animate
      onActivateEdge: () => {},
      onActivateNode: () => {},
      onClearNodeFilter: () => {},
      now: NOW,
    });
    ok("animated: no reduced motion takes the animated mode", handle.animation === "animated");
    markConnected(handle.el);
    await flushMicrotasks(); // the deferred init creates + seeds the controller, which calls start()
    ok("animated: the view runs the canvas2d renderer", handle.mode === "canvas2d");
    ok("animated: start() schedules a requestAnimationFrame loop", raf.scheduleCount > 0);

    const g = fake2dOf(handle);
    ok("animated: the controller has a 2d context", g !== null);
    const beforeFlush = g!.drawCalls;
    // Advance the loop one frame at a non-zero timestamp: renderFrame runs with elapsed > 0, so the
    // breath/ripple/sheen/particle formulas all evaluate (the static frame is elapsed 0).
    raf.flush(1234);
    ok("animated: flushing the rAF loop paints another frame (draw calls grew)", g!.drawCalls > beforeFlush);
    ok("animated: the loop re-requests the next frame (a running animation)", raf.scheduleCount >= 2);
    // The static-pipe layer was blitted (drawImage) and the particle/hub strokes ran.
    ok("animated: the static pipe layer is blitted each frame", g!.drawImageCount > 0);
    ok("animated: strokes were drawn (pipes, ring, sheen and the particle trail)", g!.strokeCount > 0);
    ok("animated: discs were filled (anchors, hub core and the particle heads)", g!.fillCount > 0);

    // A second flush advances elapsed again (the watch ripple + the moving particle phase change),
    // proving the loop keeps painting rather than freezing after one frame.
    const afterFirst = g!.drawCalls;
    raf.flush(5678);
    ok("animated: a second frame paints again (the loop is alive across frames)", g!.drawCalls > afterFirst);

    // Hover focus through the controller: hovering a source node hands its flow ids to setFocus,
    // which re-rasterises the pipes with the dim applied and (in animated mode) repaints next frame.
    const buttons = byClass(handle.el as unknown as StubNode, "button", "live-flow__node");
    ok("animated: operable node buttons are present", buttons.length > 0);
    const srcButton = buttons.find((b) => b.textContent.includes("uploads-prod"));
    if (srcButton) {
      srcButton.dispatchEvent({ type: "mouseenter", defaultPrevented: false, preventDefault() {} });
    }
    ok("animated: hovering a source marks the node layer focused (dim the rest)", (handle.el as unknown as StubNode).querySelectorAll("div").some((d) => d.classList.contains("live-flow__nodes--focused")));
    const afterFocus = g!.drawCalls;
    raf.flush(9000);
    ok("animated: a focused frame still paints (the dimmed pipes redraw)", g!.drawCalls > afterFocus);
    if (srcButton) {
      srcButton.dispatchEvent({ type: "mouseleave", defaultPrevented: false, preventDefault() {} });
    }
    ok("animated: leaving the node clears the focus", !(handle.el as unknown as StubNode).querySelectorAll("div").some((d) => d.classList.contains("live-flow__nodes--focused")));

    // dispose() cancels the loop: after disposing, a flush runs no surviving callback (the loop's
    // own disposed-guard returns and nulls rafId), so the draw count does not grow.
    handle.dispose();
    raf.flush(12000);
    const settled = g!.drawCalls;
    raf.flush(13000);
    ok("animated: dispose stops the loop (no further frames after teardown)", g!.drawCalls === settled);
  } finally {
    if (handle) handle.dispose();
    raf.restore();
    uninstallStubDom();
  }
}

// (2) Theme change + resize repaint, plus the LIVE-COLOUR probe. getComputedStyle returns a real
// rgb() here, so colourFor/hubColour resolve themed colours (not the static fallback) and cache
// them; a MutationObserver theme change invalidates the cache and rebuilds the static layer; a
// ResizeObserver resize re-measures and rebuilds too.
async function themeAndResizeTests(): Promise<void> {
  installStubDom();
  const raf = installRaf();
  let handle: LiveFlowHandle | null = null;
  try {
    // Reduced motion so repaints are synchronous (static frame) and countable without flushing rAF.
    handle = renderLiveFlow({ flows: sampleFlows(), reducedMotion: true, onActivateEdge: () => {}, now: NOW });
    markConnected(handle.el);
    await flushMicrotasks();
    const g = fake2dOf(handle);
    ok("theme: the controller initialised under the stub 2d context", g !== null && g.drawCalls > 0);
    // A themed colour was resolved from getComputedStyle (rgb(10,200,150)) and used as a stroke
    // style. Its 0..1 channels round-trip back to the 8-bit values, so the live theme (not the
    // static fallback teal) reached the canvas.
    const themed = g!.strokeStyles.some((s) => s.includes("10, 200, 150"));
    ok("theme: a live theme colour from getComputedStyle reached the canvas (not the static fallback)", themed);

    const beforeTheme = g!.drawCalls;
    fireMutation(); // a data-theme change: onThemeChanged -> invalidateColours -> rebuildAndRepaint
    ok("theme: a theme mutation triggers a repaint (the static layer is rebuilt and redrawn)", g!.drawCalls > beforeTheme);

    const beforeResize = g!.drawCalls;
    // Grow the canvas box, then fire the ResizeObserver: resize() re-measures and (in static mode)
    // repaints at the new size.
    (canvasOf(handle) as StubNode).clientWidth = 1200;
    (canvasOf(handle) as StubNode).clientHeight = 600;
    fireResize();
    ok("resize: a resize re-measures the canvas to the new device pixels", (canvasOf(handle) as StubNode).width === 1200 * 2);
    ok("resize: a resize repaints the static frame at the new size", g!.drawCalls > beforeResize);

    // dispose() tears down the theme observer + media listener (its disconnect removes the
    // registered callback), so a later mutation no longer reaches a disposed controller.
    handle.dispose();
    const afterDispose = g!.drawCalls;
    fireMutation();
    ok("theme: after dispose a theme mutation no longer repaints (listeners removed)", g!.drawCalls === afterDispose);
  } finally {
    if (handle) handle.dispose();
    raf.restore();
    uninstallStubDom();
  }
}

// (3) The in-place degrade to the SVG figure. The probe passes (a usable canvas was detected) but
// the real getContext("2d") returns null, so create2dController returns null and the view replaces
// itself with the SVG topology figure (which carries the canonical table). Also covers getContext
// THROWING (the controller's try/catch), and that the repointed handle.setFlows then drives the SVG
// component and the mode flips to svg-fallback.
async function degradeToSvgTests(): Promise<void> {
  installStubDom();
  const raf = installRaf();
  let handle: LiveFlowHandle | null = null;
  try {
    // Force the canvas's 2d context to fail AFTER the probe passed. The probe (canvas2dProbe) is
    // injected true; the live canvas is flagged so its getContext returns null. Every optional
    // handler is wired so replaceWithSvgFigure's topoOpts takes each conditional-spread truthy arm.
    handle = renderLiveFlow({
      flows: sampleFlows(),
      canvas2dProbe: () => true,
      reducedMotion: true,
      onActivateEdge: () => {},
      onActivateNode: () => {},
      onClearNodeFilter: () => {},
      now: NOW,
    });
    ok("degrade: the chosen render mode starts as canvas2d (the probe passed)", handle.mode === "canvas2d");
    const canvas = canvasOf(handle) as StubNode;
    canvas.ctxFail = true; // real context creation now fails
    markConnected(handle.el);
    await flushMicrotasks(); // ensureController runs, create2dController returns null, replaceWithSvgFigure
    ok("degrade: a failed context degrades the view to svg-fallback in place", handle.mode === "svg-fallback");
    const table = (handle.el as unknown as StubNode).querySelector("table");
    ok("degrade: the degraded view still carries the canonical topology TABLE", table !== null);
    // The repointed setFlows now drives the SVG component (no throw, table still present).
    handle.setFlows(sampleFlows().slice(0, 2));
    const table2 = (handle.el as unknown as StubNode).querySelector("table");
    ok("degrade: setFlows on the degraded handle still renders a table (drives the SVG component)", table2 !== null);
    handle.dispose();

    // getContext THROWING is caught (the try/catch in create2dController), so the view still
    // degrades cleanly rather than propagating the throw.
    const h2 = renderLiveFlow({
      flows: sampleFlows(),
      canvas2dProbe: () => true,
      reducedMotion: true,
      now: NOW,
    });
    (canvasOf(h2) as StubNode).ctxFail = "throw";
    markConnected(h2.el);
    await flushMicrotasks();
    ok("degrade: a getContext that THROWS is caught and degrades to svg-fallback", h2.mode === "svg-fallback");
    h2.dispose();

    // A degrade with NEITHER reducedMotion NOR now set, so replaceWithSvgFigure's topoOpts takes the
    // falsy arm of those conditional spreads too (both arms covered across the degrade cases).
    const h3 = renderLiveFlow({ flows: sampleFlows(), canvas2dProbe: () => true });
    (canvasOf(h3) as StubNode).ctxFail = true;
    markConnected(h3.el);
    await flushMicrotasks();
    ok("degrade: a bare degrade (no reducedMotion/now) still mounts the canonical table", h3.mode === "svg-fallback" && (h3.el as unknown as StubNode).querySelector("table") !== null);
    h3.dispose();
  } finally {
    if (handle) handle.dispose();
    raf.restore();
    uninstallStubDom();
  }
}

// (4) The empty <-> populated transition. A view that starts populated and is then emptied tears
// down its live controller (no loop on a hidden canvas) and shows the calm empty note; repopulating
// rebuilds the controller. A view that starts EMPTY acquires no context (the m1 guard) until it is
// populated.
async function emptyTransitionTests(): Promise<void> {
  installStubDom();
  const raf = installRaf();
  let handle: LiveFlowHandle | null = null;
  try {
    handle = renderLiveFlow({ flows: sampleFlows(), reducedMotion: false, onActivateEdge: () => {}, now: NOW });
    markConnected(handle.el);
    await flushMicrotasks();
    ok("empty: a populated view first runs the canvas controller", raf.scheduleCount > 0);
    const figure = byClass(handle.el as unknown as StubNode, "figure", "live-flow__figure")[0];
    const note = byClass(handle.el as unknown as StubNode, "div", "live-flow__empty")[0];
    ok("empty: a populated view shows the figure and hides the empty note", figure !== undefined && figure.style.getPropertyValue("display") === "block" && note!.style.getPropertyValue("display") === "none");

    const scheduleBeforeEmpty = raf.scheduleCount;
    handle.setFlows([]); // empties the account: tear down the controller, show the empty note
    ok("empty: an emptied account hides the figure and shows the calm empty note", figure!.style.getPropertyValue("display") === "none" && note!.style.getPropertyValue("display") === "grid");
    // The torn-down controller schedules no further frames even when its old rAF callback fires.
    raf.flush(1000);
    ok("empty: the emptied account stops scheduling new frames (controller disposed)", raf.scheduleCount === scheduleBeforeEmpty);
    ok("empty: an emptied account renders no node-layer buttons (no ghost labels)", byClass(handle.el as unknown as StubNode, "button", "live-flow__node").length === 0);

    // Repopulate: the controller is recreated and animates again.
    handle.setFlows(sampleFlows());
    await flushMicrotasks();
    ok("empty: repopulating shows the figure again", figure!.style.getPropertyValue("display") === "block");
    ok("empty: repopulating rebuilds the live controller (new frames scheduled)", raf.scheduleCount > scheduleBeforeEmpty);
    handle.dispose();

    // A view that STARTS empty: no context acquired (the m1 zero-flow guard), the empty note shown,
    // the table still present (the parity floor never disappears).
    const eh = renderLiveFlow({ flows: [], reducedMotion: true, onActivateEdge: () => {}, now: NOW });
    markConnected(eh.el);
    const scheduleBeforeStartEmpty = raf.scheduleCount;
    await flushMicrotasks();
    ok("empty: a view that starts empty acquires no canvas context (no frames)", raf.scheduleCount === scheduleBeforeStartEmpty);
    // The accessible table SECTION is always mounted (even empty): data-table renders its empty
    // placeholder for a zero-row set rather than a <table>, but the canonical section + heading
    // are present, so the parity floor never disappears.
    ok("empty: a view that starts empty still mounts the canonical table section", byClass(eh.el as unknown as StubNode, "section", "live-flow__table-section").length === 1);
    // Firing the (installed) ResizeObserver while still empty re-runs ensureController, which no-ops
    // for the zero-flow state (still no context).
    fireResize();
    ok("empty: a resize on an empty view still acquires no context", raf.scheduleCount === scheduleBeforeStartEmpty);
    eh.dispose();
  } finally {
    if (handle) handle.dispose();
    raf.restore();
    uninstallStubDom();
  }
}

// (5) The dense-DESTINATION summary chip. The shared suite covers a dense SOURCE column; this drives
// the symmetric destination branch (many destinations fanning from one source) so both count-chip
// arms run, and confirms the dense side drops its per-node labels for one honest count.
async function denseDestinationTests(): Promise<void> {
  installStubDom();
  const raf = installRaf();
  let handle: LiveFlowHandle | null = null;
  try {
    const dense: FlowRecord[] = [];
    for (let i = 0; i < 18; i++) {
      dense.push({
        id: `dp-x${i}`,
        source: { name: "one-source", kind: "kv" },
        destination: { name: `bucket-${i}`, kind: "r2" },
        status: "healthy",
        lastRunAt: ts(-3600),
        cadence: 86400,
        bytesPerRun: 1024,
        enabled: true,
        running: false,
      });
    }
    handle = renderLiveFlow({ flows: dense, reducedMotion: true, onActivateNode: () => {}, now: NOW });
    const root = handle.el as unknown as StubNode;
    const buttons = byClass(root, "button", "live-flow__node");
    ok("dense-dest: a dense destination column drops per-node labels (only the lone source stays)", buttons.length === 1 && buttons[0]!.textContent.includes("one-source"));
    const chips = byClass(root, "span", "live-flow__node-summary");
    ok("dense-dest: the crowded destination side is summarised by one honest count chip", chips.length === 1 && chips[0]!.textContent === "18 destinations");
    handle.dispose();
  } finally {
    if (handle) handle.dispose();
    raf.restore();
    uninstallStubDom();
  }
}

// (6) The self-dispose watcher (selfDisposeOnDetach). Armed only after the root has been seen
// connected; once the root detaches it disposes the handle and clears its own interval. Driven by
// the captured setInterval callback (no real timer).
async function selfDisposeTests(): Promise<void> {
  installStubDom();
  const raf = installRaf();
  let handle: LiveFlowHandle | null = null;
  try {
    handle = renderLiveFlow({
      flows: sampleFlows(),
      reducedMotion: false,
      selfDisposeOnDetach: true,
      onActivateEdge: () => {},
      now: NOW,
    });
    markConnected(handle.el);
    await flushMicrotasks();
    ok("self-dispose: a watcher interval was armed", intervals.length === 1);
    const reg = intervals[0]!;
    // First tick while connected: the watcher just records "seen connected" and keeps watching.
    reg.fn();
    ok("self-dispose: while connected the watcher keeps running (not yet cleared)", reg.cleared === false);
    const scheduledBeforeDetach = raf.scheduleCount;
    // Detach the root, then tick: the watcher sees it was connected and is now gone, so it disposes
    // the handle (stopping the loop) and clears the interval.
    CONNECTED.delete((handle.el as unknown as StubNode).nid);
    reg.fn();
    ok("self-dispose: a detached (previously connected) root clears the watcher interval", reg.cleared === true);
    // The handle was disposed: a flush schedules no new frames.
    raf.flush(2000);
    ok("self-dispose: detachment disposed the handle (the rAF loop stopped)", raf.scheduleCount === scheduledBeforeDetach);
    handle.dispose(); // idempotent
  } finally {
    if (handle) handle.dispose();
    raf.restore();
    uninstallStubDom();
  }

  // A watcher whose handle is disposed BEFORE detachment: the next tick sees disposed and clears the
  // interval immediately (the disposed-first arm of the watcher).
  installStubDom();
  const raf2 = installRaf();
  try {
    const h = renderLiveFlow({ flows: sampleFlows(), reducedMotion: true, selfDisposeOnDetach: true, now: NOW });
    markConnected(h.el);
    await flushMicrotasks();
    const reg = intervals[0]!;
    h.dispose();
    reg.fn();
    ok("self-dispose: a tick after an explicit dispose clears the watcher interval", reg.cleared === true);
  } finally {
    raf2.restore();
    uninstallStubDom();
  }
}

// (7) prefersReducedMotion's matchMedia fallback. With NO data-motion attribute the renderer reads
// the OS media query: reduceMatch true -> static frame, false -> animated. (The data-motion override
// is covered by the shared suite; this pins the bare matchMedia arm and the throw guard.)
async function matchMediaMotionTests(): Promise<void> {
  installStubDom();
  const raf = installRaf();
  try {
    // No data-motion attribute set; the OS prefers reduced motion.
    reduceMatch = true;
    const a = renderLiveFlow({ flows: sampleFlows(), onActivateEdge: () => {}, now: NOW });
    ok("matchMedia: OS reduce query (no console override) -> static frame", a.animation === "static-frame");
    a.dispose();

    reduceMatch = false;
    const b = renderLiveFlow({ flows: sampleFlows(), onActivateEdge: () => {}, now: NOW });
    ok("matchMedia: OS allows motion (no console override) -> animated", b.animation === "animated");
    b.dispose();

    // matchMedia throwing is caught by prefersReducedMotion (returns false -> animated).
    matchMediaThrows = true;
    const c = renderLiveFlow({ flows: sampleFlows(), onActivateEdge: () => {}, now: NOW });
    ok("matchMedia: a throwing matchMedia is caught (defaults to animated, no crash)", c.animation === "animated");
    c.dispose();
    matchMediaThrows = false;
  } finally {
    raf.restore();
    uninstallStubDom();
  }

  // The colour probe's no-body fallback: with document.body absent, readCssColour returns the honest
  // static fallback rather than throwing (the canvas still paints the fallback palette).
  installStubDom({ bodyless: true });
  const raf2 = installRaf();
  let handle: LiveFlowHandle | null = null;
  try {
    handle = renderLiveFlow({ flows: sampleFlows(), reducedMotion: true, onActivateEdge: () => {}, now: NOW });
    markConnected(handle.el);
    await flushMicrotasks();
    const g = fake2dOf(handle);
    ok("colour: with no document.body the probe falls back and the canvas still paints", g !== null && g.drawCalls > 0);
    // The static fallback teal (0.27, 0.71, 0.63 -> rgb(69, 181, 161)) reached the canvas, since the
    // live probe could not run.
    ok("colour: the honest static fallback colour is used when the probe cannot run", g!.strokeStyles.some((s) => s.includes("69, 181, 161")));
    handle.dispose();
  } finally {
    if (handle) handle.dispose();
    raf2.restore();
    uninstallStubDom();
  }

  // The empty-string computed colour fallback: getComputedStyle returns "" (an unset/bad token), so
  // parseCssColour returns null and readCssColour falls back to the static value, the probe still
  // removed in the finally.
  installStubDom({ noComputedStyle: true });
  const raf3 = installRaf();
  let h3: LiveFlowHandle | null = null;
  try {
    h3 = renderLiveFlow({ flows: sampleFlows(), reducedMotion: true, onActivateEdge: () => {}, now: NOW });
    markConnected(h3.el);
    await flushMicrotasks();
    const g = fake2dOf(h3);
    ok("colour: an empty computed colour falls back to the static palette (probe still cleaned up)", (g?.strokeStyles.some((s) => s.includes("69, 181, 161")) ?? false));
    h3.dispose();
  } finally {
    if (h3) h3.dispose();
    raf3.restore();
    uninstallStubDom();
  }

  // Reference buildLiveFlowModel so the import reads as used (the render path builds the model
  // internally; this is a direct sanity check the same model shape the renderer consumes is sound).
  installStubDom();
  try {
    const m = buildLiveFlowModel({ flows: sampleFlows() });
    ok("model: the render path's model has one edge per flow", m.edges.length === sampleFlows().length);
  } finally {
    uninstallStubDom();
  }
}

// (8) The SVG-fallback branch with EVERY optional handler wired (and its degraded handle's
// setFlows + dispose). The shared suite's fallback case wires only onActivateEdge + now; this
// passes onActivateNode, onClearNodeFilter and reducedMotion too, so every conditional spread arm
// of the fallback's topoOpts is taken, then drives the fallback handle's setFlows and dispose.
async function svgFallbackOptionTests(): Promise<void> {
  installStubDom();
  const raf = installRaf();
  try {
    const handle = renderLiveFlow({
      flows: sampleFlows(),
      canvas2dProbe: () => false, // force the svg-fallback branch
      onActivateEdge: () => {},
      onActivateNode: () => {},
      onClearNodeFilter: () => {},
      reducedMotion: true,
      now: NOW,
    });
    ok("svg-fallback: no usable canvas yields the svg-fallback mode", handle.mode === "svg-fallback");
    ok("svg-fallback: the fallback root carries the canonical topology table", (handle.el as unknown as StubNode).querySelector("table") !== null);
    // The fallback handle's setFlows drives the SVG topology component (the table re-renders, no throw).
    handle.setFlows(sampleFlows().slice(0, 2));
    ok("svg-fallback: setFlows on the fallback handle re-renders (drives the SVG component)", (handle.el as unknown as StubNode).querySelector("table") !== null);
    handle.dispose(); // the fallback dispose is a no-op (the SVG owns no loop); must not throw
    ok("svg-fallback: dispose on the fallback handle is a safe no-op", true);

    // The SAME branch with NO optional handlers, so the falsy arms of every conditional spread are
    // also taken (both arms of each spread now covered).
    const bare = renderLiveFlow({ flows: sampleFlows(), canvas2dProbe: () => false });
    ok("svg-fallback: a bare fallback (no handlers) still mounts the canonical table", (bare.el as unknown as StubNode).querySelector("table") !== null);
    bare.dispose();
  } finally {
    raf.restore();
    uninstallStubDom();
  }
}

// (9) The compact embed + the populate -> populate re-feed. compact:true exercises the
// live-flow--compact class arm. A setFlows with a DIFFERENT non-empty set while the controller is
// already alive takes the build() "controller already exists, re-feed it" branch (setModel on a
// live controller, which in animated mode also cancels the running loop in start()).
async function compactAndRepollTests(): Promise<void> {
  installStubDom();
  const raf = installRaf();
  let handle: LiveFlowHandle | null = null;
  try {
    handle = renderLiveFlow({ flows: sampleFlows(), reducedMotion: false, compact: true, onActivateEdge: () => {}, now: NOW });
    ok("compact: the compact modifier is applied to the root", (handle.el as unknown as StubNode).classList.contains("live-flow--compact"));
    markConnected(handle.el);
    await flushMicrotasks();
    ok("compact: the compact view still runs the canvas controller", handle.mode === "canvas2d" && raf.scheduleCount > 0);
    raf.flush(100); // the loop is running, rafId set
    const g = fake2dOf(handle);
    const scheduleBefore = raf.scheduleCount;
    // Re-feed a different non-empty set while the controller is alive: build() re-feeds the existing
    // controller (setModel), and start() cancels the in-flight loop then schedules a fresh one (in
    // animated mode the paint happens on the next scheduled frame, not synchronously).
    const next = sampleFlows().map((f) => ({ ...f, id: `${f.id}-b` }));
    handle.setFlows(next);
    ok("re-poll: a re-feed with a live controller schedules a fresh animated loop (setModel re-seed)", raf.scheduleCount > scheduleBefore);
    const before = g!.drawCalls;
    raf.flush(3000); // the fresh loop paints the re-fed model
    ok("re-poll: the re-fed model paints on its next frame", g!.drawCalls > before);
    handle.dispose();
  } finally {
    if (handle) handle.dispose();
    raf.restore();
    uninstallStubDom();
  }
}

// (10) kindShort's "other"/default arm + an all-idle frame (no flowing edge), so the anyFlowing
// FALSE arm of the hub breath/ripple runs. A node with an unrecognised kind carries no kind tag.
async function kindAndIdleTests(): Promise<void> {
  installStubDom();
  const raf = installRaf();
  let handle: LiveFlowHandle | null = null;
  try {
    // An "other" kind (a placeholder endpoint): kindShort returns "" so no kind tag is appended.
    const flows: FlowRecord[] = [
      {
        id: "dp-other",
        source: { name: "placeholder-src", kind: "other" },
        destination: { name: "placeholder-dst", kind: "other" },
        status: "healthy",
        lastRunAt: ts(-3600),
        cadence: 86400,
        bytesPerRun: 1024,
        enabled: true,
        running: false, // idle: no flowing edge in the whole set -> anyFlowing is false
      },
    ];
    handle = renderLiveFlow({ flows, reducedMotion: false, onActivateNode: () => {}, now: NOW });
    markConnected(handle.el);
    await flushMicrotasks();
    raf.flush(2000); // animate one frame with no flowing edge (the anyFlowing=false hub branch)
    const g = fake2dOf(handle);
    ok("kind: an all-idle animated frame still paints the hub and anchors", g !== null && g.drawCalls > 0);
    // The "other"-kind nodes render their names but no kind tag (kindShort default "").
    const kinds = byClass(handle.el as unknown as StubNode, "span", "live-flow__node-kind");
    ok("kind: an 'other' kind node carries no kind tag", kinds.length === 0);
    const buttons = byClass(handle.el as unknown as StubNode, "button", "live-flow__node");
    ok("kind: the 'other' endpoints still render their names", buttons.some((b) => b.textContent.includes("placeholder-src")) && buttons.some((b) => b.textContent.includes("placeholder-dst")));
    // Focus then blur a node via the keyboard handlers (focus/blur), the keyboard-reachable twin of
    // the mouse hover, so the focus/blur node-layer handlers run.
    const src = buttons.find((b) => b.textContent.includes("placeholder-src"));
    if (src) {
      src.dispatchEvent({ type: "focus", defaultPrevented: false, preventDefault() {} });
      ok("kind: keyboard focus on a node lights its paths", (handle.el as unknown as StubNode).querySelectorAll("div").some((d) => d.classList.contains("live-flow__nodes--focused")));
      src.dispatchEvent({ type: "blur", defaultPrevented: false, preventDefault() {} });
      ok("kind: keyboard blur clears the focus", !(handle.el as unknown as StubNode).querySelectorAll("div").some((d) => d.classList.contains("live-flow__nodes--focused")));
    }
    handle.dispose();
  } finally {
    if (handle) handle.dispose();
    raf.restore();
    uninstallStubDom();
  }
}

// (11) Exotic environments: NO queueMicrotask and NO ResizeObserver (the last-resort synchronous
// seed), a ResizeObserver whose constructor throws (the catch that nulls it), and the controller's
// setFocus disposed/no-model guards. These are the defensive arms a hostile or minimal host hits.
async function exoticEnvTests(): Promise<void> {
  // (a) no queueMicrotask AND no ResizeObserver: renderCanvasView seeds the controller synchronously
  // at the end of construction (neither deferral mechanism exists).
  installStubDom();
  const raf = installRaf();
  const g = globalThis as unknown as Record<string, unknown>;
  const prevQM = g.queueMicrotask;
  const prevRO = g.ResizeObserver;
  let handle: LiveFlowHandle | null = null;
  try {
    delete g.queueMicrotask;
    delete g.ResizeObserver;
    // The root is connected from the start so the synchronous seed measures a real size.
    handle = renderLiveFlow({ flows: sampleFlows(), reducedMotion: true, onActivateEdge: () => {}, now: NOW });
    markConnected(handle.el);
    // Re-feed once so build() re-runs ensureController now that the root is marked connected (the
    // initial synchronous seed ran before markConnected, so it deferred on !root.isConnected).
    handle.setFlows(sampleFlows());
    const fk = fake2dOf(handle);
    ok("exotic: with no microtask and no ResizeObserver the controller still seeds (canvas painted)", fk !== null && fk.drawCalls > 0);
    handle.dispose();
  } finally {
    g.queueMicrotask = prevQM;
    g.ResizeObserver = prevRO;
    raf.restore();
    uninstallStubDom();
  }

  // (b) a ResizeObserver whose constructor throws: renderCanvasView's try/catch nulls it and the
  // view still initialises via the microtask path.
  installStubDom();
  const raf2 = installRaf();
  const g2 = globalThis as unknown as Record<string, unknown>;
  try {
    g2.ResizeObserver = class {
      constructor() {
        throw new Error("ResizeObserver refused");
      }
    };
    const h = renderLiveFlow({ flows: sampleFlows(), reducedMotion: true, onActivateEdge: () => {}, now: NOW });
    markConnected(h.el);
    await flushMicrotasks();
    const fk = fake2dOf(h);
    ok("exotic: a throwing ResizeObserver constructor is caught; the view still initialises", fk !== null && fk.drawCalls > 0);
    h.dispose();
  } finally {
    raf2.restore();
    uninstallStubDom();
  }

  // (b2) a hostile theme-wiring host: the controller's MutationObserver constructor AND
  // window.matchMedia both throw. Both are wrapped in their own try/catch (the theme follower is
  // best-effort), so the controller still initialises and paints; only the live theme-following is
  // dropped. reducedMotion is forced so the static frame paints synchronously.
  installStubDom();
  const raf2b = installRaf();
  const g2b = globalThis as unknown as Record<string, unknown>;
  try {
    g2b.MutationObserver = class {
      constructor() {
        throw new Error("MutationObserver refused");
      }
    };
    matchMediaThrows = true; // the controller's prefers-color-scheme matchMedia throws too
    const h = renderLiveFlow({ flows: sampleFlows(), reducedMotion: true, onActivateEdge: () => {}, now: NOW });
    markConnected(h.el);
    await flushMicrotasks();
    const fk = fake2dOf(h);
    ok("exotic: a hostile theme host (MutationObserver + matchMedia throw) still initialises and paints", fk !== null && fk.drawCalls > 0);
    h.dispose();
  } finally {
    matchMediaThrows = false;
    raf2b.restore();
    uninstallStubDom();
  }

  // (c) the controller's setFocus guards. setFocus is reached through the node layer's hover, but its
  // disposed and no-model arms are defensive. Drive them by hovering AFTER dispose (disposed guard)
  // and by hovering on a populated then re-fed-empty controller path. We do this through the public
  // surface: render animated, dispose, then dispatch a hover (the node layer's setFocus calls
  // controller?.setFocus, which returns at the disposed guard without throwing).
  installStubDom();
  const raf3 = installRaf();
  let h3: LiveFlowHandle | null = null;
  try {
    h3 = renderLiveFlow({ flows: sampleFlows(), reducedMotion: false, onActivateNode: () => {}, now: NOW });
    markConnected(h3.el);
    await flushMicrotasks();
    const buttons = byClass(h3.el as unknown as StubNode, "button", "live-flow__node");
    const src = buttons.find((b) => b.textContent.includes("uploads-prod"));
    h3.dispose(); // the controller is now disposed
    // A hover after dispose: the node layer still toggles its DOM class and calls controller.setFocus,
    // whose disposed guard returns immediately (no throw, no paint).
    let threw = false;
    try {
      if (src) src.dispatchEvent({ type: "mouseenter", defaultPrevented: false, preventDefault() {} });
    } catch {
      threw = true;
    }
    ok("exotic: a hover after dispose is safe (the controller setFocus disposed-guard returns)", threw === false);
  } finally {
    if (h3) h3.dispose();
    raf3.restore();
    uninstallStubDom();
  }
}

// (12) The canonical table's ROW ACTIVATION (buildAccessibleTable wires onRowActivate when an
// onActivateEdge handler is supplied: activating a table row opens that downpipe), plus a STATIC
// frame hover (the controller setFocus static-frame repaint arm). The table is the operable surface,
// so activating a row is the real "open the downpipe" affordance.
async function tableRowAndStaticFocusTests(): Promise<void> {
  installStubDom();
  const raf = installRaf();
  let handle: LiveFlowHandle | null = null;
  try {
    let opened: string | null = null;
    handle = renderLiveFlow({
      flows: sampleFlows(),
      reducedMotion: true, // static frame: setFocus repaints synchronously (the static-frame arm)
      onActivateEdge: (id: string) => {
        opened = id;
      },
      onActivateNode: () => {},
      now: NOW,
    });
    markConnected(handle.el);
    await flushMicrotasks();
    const root = handle.el as unknown as StubNode;
    // The data-table renders one <tr data-key> per flow inside the canonical section. Click the first
    // activatable row (target = the row itself, so the inner-control guard does not skip it).
    const rows = root.querySelectorAll("tr").filter((r) => r.classList.contains("dp-table__row--activatable"));
    ok("table-row: the canonical table has activatable rows when an open handler is wired", rows.length > 0);
    if (rows.length > 0) {
      rows[0]!.dispatchEvent({ type: "click", target: rows[0], defaultPrevented: false, preventDefault() {} } as unknown as StubEvent);
    }
    ok("table-row: activating a table row opens that downpipe (onRowActivate -> onActivateEdge)", opened !== null);

    // Static hover: hovering a node in the static-frame view re-rasterises the pipes (dim) and repaints
    // the single frame at once (the controller setFocus static-frame arm), no rAF loop involved.
    const g = fake2dOf(handle);
    const before = g!.drawCalls;
    const buttons = byClass(root, "button", "live-flow__node");
    const src = buttons.find((b) => b.textContent.includes("uploads-prod"));
    if (src) src.dispatchEvent({ type: "mouseenter", defaultPrevented: false, preventDefault() {} });
    ok("table-row: a static-frame hover repaints the single frame at once (setFocus static arm)", g!.drawCalls > before);
    if (src) src.dispatchEvent({ type: "mouseleave", defaultPrevented: false, preventDefault() {} });
    const afterClear = g!.drawCalls;
    ok("table-row: clearing a static-frame hover repaints again", afterClear > before);
    handle.dispose();
  } finally {
    if (handle) handle.dispose();
    raf.restore();
    uninstallStubDom();
  }
}

// (13) The scale guard + the no-requestAnimationFrame fallback. A fleet past the animated-edge cap
// (LIVE_FLOW_MAX_ANIMATED_EDGES = 200) drops to a single static frame even when motion is allowed:
// start() takes the overBudget() arm (renderFrame(0), no rAF loop), and renderFrame's overBudget()
// early return skips the per-frame particle work (the pipes/hub are still painted). Separately, an
// environment with NO requestAnimationFrame paints one frame rather than leaving a blank canvas.
async function scaleGuardAndNoRafTests(): Promise<void> {
  // (a) over the edge budget, animation allowed: a static frame, no loop scheduled.
  installStubDom();
  const raf = installRaf();
  let handle: LiveFlowHandle | null = null;
  try {
    const big: FlowRecord[] = [];
    for (let i = 0; i < 205; i++) {
      big.push({
        id: `dp-big${i}`,
        source: { name: `src-${i}`, kind: "kv" },
        destination: { name: `dst-${i}`, kind: "r2" },
        status: "healthy",
        lastRunAt: ts(-3600),
        cadence: 86400,
        bytesPerRun: 1024,
        enabled: true,
        running: true, // running, but the fleet is past the cap so motion is dropped
      });
    }
    handle = renderLiveFlow({ flows: big, reducedMotion: false, onActivateEdge: () => {}, now: NOW });
    ok("scale: a large fleet still reports the animated mode (the cap is applied per frame, not in the mode)", handle.animation === "animated");
    markConnected(handle.el);
    await flushMicrotasks();
    const g = fake2dOf(handle);
    ok("scale: a fleet past the edge cap still paints a static frame (pipes + hub drawn)", g !== null && g.drawCalls > 0);
    // The over-budget controller paints ONCE (no rAF loop): flushing the rAF queue (the canonical
    // table's own windowing rAF lives there too, but it never touches the canvas) leaves the canvas
    // draw count unchanged. A running controller loop would keep repainting the canvas each flush.
    const canvasDrawsBefore = g!.drawCalls;
    raf.flush(4000);
    raf.flush(8000);
    ok("scale: a fleet past the edge cap runs no canvas loop (the static-at-scale guard)", g!.drawCalls === canvasDrawsBefore);
    handle.dispose();
  } finally {
    if (handle) handle.dispose();
    raf.restore();
    uninstallStubDom();
  }

  // (b) animation allowed but NO requestAnimationFrame in the environment: start() paints one frame
  // via the final else rather than leaving the canvas blank.
  installStubDom();
  const g2 = globalThis as unknown as Record<string, unknown>;
  let h2: LiveFlowHandle | null = null;
  try {
    delete g2.requestAnimationFrame;
    delete g2.cancelAnimationFrame;
    h2 = renderLiveFlow({ flows: sampleFlows(), reducedMotion: false, onActivateEdge: () => {}, now: NOW });
    ok("no-raf: the animated mode is still chosen", h2.animation === "animated");
    markConnected(h2.el);
    await flushMicrotasks();
    const fk = fake2dOf(h2);
    ok("no-raf: with no requestAnimationFrame the controller still paints a single frame (not blank)", fk !== null && fk.drawCalls > 0);
    h2.dispose();
  } finally {
    if (h2) h2.dispose();
    uninstallStubDom();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
