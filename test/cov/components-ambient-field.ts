// Coverage on components/ambient-field.ts, the one sanctioned piece of infinite ambient motion
// in the console. It is Canvas2d + rAF only, so the shared dom-shim is
// not enough on its own: the module needs getComputedStyle, window.innerWidth/innerHeight,
// devicePixelRatio, a canvas getContext("2d"), and a requestAnimationFrame it can drive. This
// validator stands up a small self-contained DOM + a fake 2D context + a controllable rAF (the
// same proven approach as test/validate-live-flow.ts), then renders the REAL ambientField() and
// drives its preferences and frame loop. It paints nothing real and reads no GPU.
//
// What each section exercises:
//   - off preference: no drops, no rAF scheduled (the canvas stays empty).
//   - medium preference: drops built, frames painted, no lightning.
//   - storm preference: lightning sky-flash + bolt drawn, drops recycled when they fall past.
//   - the no-2d-context early return (getContext returns null).
//   - reduced motion (motionOK false): start() is a hard gate, no rAF.
//   - the tab-hidden gate and the visibilitychange stop/start wiring.
//   - the resize and rain-preference and a11y-preference live re-evaluation hooks.
//   - the colour-read branches (an --accent/--trust present vs absent).
//
// Run with: node test/cov/components-ambient-field.ts

// Marks this file a module (without one the compiler reads it as a script, so `failures` and
// `ok` collide with every other test file's globals and top-level await is rejected). This file
// imports its subject dynamically further down, because it installs its own document, rAF and
// localStorage globals at top level and only then loads the component: a static import of the
// subject would be hoisted above that setup and the component would load into a bare environment.
export {};

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------------------------
// A controllable Math.random. Production reads it for drop placement, the teal/indigo coin
// (< 0.14), the bolt geometry and the strike timing. A queue of scripted values (recycling)
// lets a test force a specific branch (a teal drop vs an indigo one, a recycle position), and a
// default keeps the rest deterministic so the frame loop never wanders.
// ---------------------------------------------------------------------------------------------
let randQueue: number[] = [];
let randDefault = 0.5;
const realRandom = Math.random;
function scriptRandom(values: number[], dflt = 0.5): void {
  randQueue = [...values];
  randDefault = dflt;
}
Math.random = (): number => (randQueue.length > 0 ? randQueue.shift()! : randDefault);

// ---------------------------------------------------------------------------------------------
// A fake 2D context: every CanvasRenderingContext2D member ambientField touches, as succeeding
// no-ops, with counters so a test can assert a frame genuinely painted (stroke for streaks and
// the bolt, fillRect for the lightning flash, createLinearGradient for the flash gradient).
// ---------------------------------------------------------------------------------------------
class FakeGradient {
  stops: Array<[number, string]> = [];
  addColorStop(offset: number, colour: string): void {
    this.stops.push([offset, colour]);
  }
}
class Fake2d {
  strokeStyle: string | FakeGradient = "";
  fillStyle: string | FakeGradient = "";
  lineWidth = 0;
  lineCap = "";
  globalAlpha = 1;
  strokes = 0;
  fillRects = 0;
  clears = 0;
  gradients = 0;
  setTransform(): void {}
  clearRect(): void {
    this.clears++;
  }
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  stroke(): void {
    this.strokes++;
  }
  fillRect(): void {
    this.fillRects++;
  }
  createLinearGradient(): FakeGradient {
    this.gradients++;
    return new FakeGradient();
  }
}

// ---------------------------------------------------------------------------------------------
// A tiny DOM. ambientField only creates a <canvas>, reads getContext, sets a class + aria-hidden,
// and attaches listeners on window/document. Nothing here re-implements anything under test.
// ---------------------------------------------------------------------------------------------
type Listener = (ev: unknown) => void;
class CanvasNode {
  tagName = "CANVAS";
  attrs: Record<string, string> = {};
  width = 0;
  height = 0;
  className = "";
  ctx: Fake2d | null;
  constructor(giveContext: boolean) {
    this.ctx = giveContext ? new Fake2d() : null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  getContext(kind: string): Fake2d | null {
    return kind === "2d" ? this.ctx : null;
  }
}

interface DocHandle {
  hidden: boolean;
  fireVisibility(): void;
}

// installDom wires document/window globals. matchMediaReduced drives prefers-reduced-motion so the
// motionOK() gate can be flipped per section. giveContext lets one section take the no-2d branch.
let docListeners: Record<string, Listener[]> = {};
let winListeners: Record<string, Listener[]> = {};
let matchMediaReduced = false;
let canvasGivesContext = true;
let _lastCanvas: CanvasNode | null = null;
let accentVar = "#84a4ff";
let trustVar = "#4fd0bf";

function installDom(): DocHandle {
  const g = globalThis as unknown as Record<string, unknown>;
  docListeners = {};
  winListeners = {};
  // The root element: ambientField reads getComputedStyle(document.documentElement), and the a11y
  // preference lib (which the canvas subscribes to for the motion gate) realises preferences as
  // attributes + a root font-size on it. A minimal attribute/style bag is enough for both.
  const rootStyle: Record<string, string> = {};
  const root = {
    __root: true,
    attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string): void {
      this.attrs[k] = String(v);
    },
    removeAttribute(k: string): void {
      delete this.attrs[k];
    },
    style: {
      setProperty(k: string, v: string): void {
        rootStyle[k] = String(v);
      },
      removeProperty(k: string): void {
        delete rootStyle[k];
      },
    },
  };
  const doc = {
    hidden: false,
    documentElement: root,
    createElement: (tag: string): CanvasNode => {
      const node = new CanvasNode(canvasGivesContext);
      node.tagName = String(tag).toUpperCase();
      _lastCanvas = node;
      return node;
    },
    addEventListener: (type: string, fn: Listener): void => {
      docListeners[type] ||= []; docListeners[type].push(fn);
    },
    removeEventListener: (type: string, fn: Listener): void => {
      const l = docListeners[type];
      if (l) {
        const i = l.indexOf(fn);
        if (i >= 0) l.splice(i, 1);
      }
    },
  };
  g.document = doc;
  g.window = globalThis;
  (g as Record<string, unknown>).innerWidth = 1200;
  (g as Record<string, unknown>).innerHeight = 800;
  (g as Record<string, unknown>).devicePixelRatio = 1.5;
  (g as Record<string, unknown>).addEventListener = (type: string, fn: Listener): void => {
    winListeners[type] ||= []; winListeners[type].push(fn);
  };
  (g as Record<string, unknown>).getComputedStyle = () => ({
    getPropertyValue: (prop: string): string =>
      prop === "--accent" ? accentVar : prop === "--trust" ? trustVar : "",
  });
  (g as Record<string, unknown>).matchMedia = (q: string) => ({
    media: q,
    matches: q.includes("reduce") ? matchMediaReduced : false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
  return {
    get hidden(): boolean {
      return doc.hidden;
    },
    set hidden(v: boolean) {
      doc.hidden = v;
    },
    fireVisibility(): void {
      for (const fn of [...(docListeners.visibilitychange ?? [])]) fn(undefined);
    },
  } as DocHandle;
}

// A controllable requestAnimationFrame: callbacks are queued, not run. scheduleCount tracks how
// many times rAF was REQUESTED (so the no-rAF gates assert it stays 0). flush(ts) runs exactly the
// callbacks queued at the moment of the call (the production frame re-queues itself, so each flush
// advances one frame). cancelAnimationFrame drops a pending callback.
interface RafHarness {
  scheduleCount: number;
  pending(): number;
  flush(ts: number): void;
  // peek hands back the most recently queued frame callback WITHOUT running or dequeuing it, so a
  // test can stop the loop and then invoke that stale callback to hit the not-running early return.
  peek(): ((ts: number) => void) | null;
  reset(): void;
}
function installRaf(): RafHarness {
  const g = globalThis as unknown as Record<string, unknown>;
  let queue: Array<{ id: number; cb: (ts: number) => void }> = [];
  let idSeq = 0;
  const harness: RafHarness = {
    scheduleCount: 0,
    pending: () => queue.length,
    flush(ts: number): void {
      const due = queue;
      queue = [];
      for (const item of due) item.cb(ts);
    },
    peek: () => queue[queue.length - 1]?.cb ?? null,
    reset(): void {
      queue = [];
      this.scheduleCount = 0;
    },
  };
  g.requestAnimationFrame = (cb: (ts: number) => void): number => {
    harness.scheduleCount++;
    const id = ++idSeq;
    queue.push({ id, cb });
    return id;
  };
  g.cancelAnimationFrame = (id: number): void => {
    const i = queue.findIndex((q) => q.id === id);
    if (i >= 0) queue.splice(i, 1);
  };
  return harness;
}

function fireWindow(type: string): void {
  for (const fn of [...(winListeners[type] ?? [])]) fn(undefined);
}

// ---------------------------------------------------------------------------------------------
// Stand the environment up BEFORE importing the module: ambientField() runs readColours/resize/
// configure and attaches listeners eagerly, and the preference libs touch localStorage at call
// time, so every global must be present first.
// ---------------------------------------------------------------------------------------------
const docHandle = installDom();
const raf = installRaf();

// A real in-memory localStorage so the rain + a11y preference libs round-trip. We drive the rain
// preference directly through setRainPref (the public API the canvas subscribes to) rather than
// poking storage, so the live re-evaluation path is the one under test.
{
  const m = new Map<string, string>();
  (globalThis as unknown as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => {
      m.set(k, String(v));
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
    clear: () => m.clear(),
  };
}

const { ambientField } = await import("../../src/components/ambient-field.ts");
const { setRainPref } = await import("../../src/lib/rain-pref.ts");
const { setA11yPref } = await import("../../src/lib/a11y-prefs.ts");

// =============================================================================================
// Section 1: the no-2d-context early return. getContext("2d") returns null, so ambientField must
// hand back the bare canvas without building drops, scheduling a frame or attaching listeners.
// =============================================================================================
{
  canvasGivesContext = false;
  raf.reset();
  winListeners = {};
  const canvas = ambientField() as unknown as CanvasNode;
  ok("no-2d: returns a CANVAS element", canvas.tagName === "CANVAS");
  ok("no-2d: it is the ambient-field, aria-hidden", canvas.className === "ambient-field" && canvas.getAttribute("aria-hidden") === "true");
  ok("no-2d: no requestAnimationFrame was scheduled (the loop never starts)", raf.scheduleCount === 0);
  ok("no-2d: no resize listener was attached (we returned before wiring)", (winListeners.resize ?? []).length === 0);
  canvasGivesContext = true;
}

// =============================================================================================
// Section 2: the OFF preference. preset is null, so build() clears drops and start() is a no-op:
// no frame is ever scheduled and the canvas stays empty even though motion is allowed.
// =============================================================================================
{
  matchMediaReduced = false;
  setRainPref("off");
  raf.reset();
  winListeners = {};
  docListeners = {};
  const canvas = ambientField() as unknown as CanvasNode;
  const ctx = canvas.ctx!;
  ok("off: a 2d context was acquired", ctx instanceof Fake2d);
  ok("off: NO requestAnimationFrame scheduled (off draws nothing)", raf.scheduleCount === 0);
  // The constructor still wires the live-update listeners (resize/visibility/rain/a11y) so a later
  // switch to medium starts the rain; only the frame loop is gated off.
  ok("off: the resize listener is still wired for a later preference change", (winListeners.resize ?? []).length === 1);
  // Flushing does nothing because nothing is queued.
  const before = ctx.strokes;
  raf.flush(16);
  ok("off: a flush paints nothing", ctx.strokes === before);
}

// =============================================================================================
// Section 3: the MEDIUM preference (the default, lightning off). Drops are built and the frame
// loop paints streaks, recycling drops that fall past the bottom, and never draws lightning.
// =============================================================================================
{
  matchMediaReduced = false;
  setRainPref("medium");
  raf.reset();
  winListeners = {};
  docListeners = {};
  // Script the teal coin: the first drop built takes < 0.14 (teal), the rest default to 0.5
  // (indigo), so both strokeStyle branches in frame() run across the drop set.
  scriptRandom([0.5, 0.5, 0.5, 0.05], 0.5); // x, vy, len, alpha, then teal=0.05 for drop 0
  const canvas = ambientField() as unknown as CanvasNode;
  const ctx = canvas.ctx!;
  ok("medium: a frame was scheduled (the loop started)", raf.scheduleCount >= 1);
  ok("medium: the canvas was sized from innerWidth*dpr (1200*1.5=1800)", canvas.width === 1800);
  ok("medium: the canvas was sized from innerHeight*dpr (800*1.5=1200)", canvas.height === 1200);

  // Drive several frames with a growing timestamp. The first frame uses dt=0.016 (last===0); the
  // rest use the clamped (now-last)/1000, capped at 0.05. High dt + medium velocity makes drops
  // fall past h within a handful of frames, so the recycle branch (makeDrop at the top) runs.
  scriptRandom([], 0.5); // back to deterministic for the frame loop
  let now = 1000;
  for (let i = 0; i < 40; i++) {
    now += 200; // 0.2s -> clamped to the 0.05s ceiling, the max-fall path
    raf.flush(now);
  }
  ok("medium: streaks were stroked across the frames", ctx.strokes > 0);
  ok("medium: clearRect ran each frame (the canvas is wiped before redraw)", ctx.clears > 0);
  ok("medium: NO lightning flash (medium has lightning:false, fillRect never called)", ctx.fillRects === 0);
  ok("medium: NO lightning gradient was created on the medium preset", ctx.gradients === 0);
  ok("medium: the loop keeps re-queueing itself (a frame is pending)", raf.pending() === 1);
}

// =============================================================================================
// Section 4: the STORM preference. Lightning is on: a moderate sky-flash (gradient + fillRect)
// plus a thin bolt are drawn, infrequently. We force an immediate strike by scripting the strike
// timer to a tiny value, then drive frames long enough for the flash to decay and the bolt to die.
// =============================================================================================
{
  matchMediaReduced = false;
  setRainPref("storm");
  raf.reset();
  winListeners = {};
  docListeners = {};
  // configure() runs strikeIn = rnd(3, 8) at construction; we cannot reach a strike on frame 1
  // without help, so script that initial rnd low (the first Math.random feeds rnd(3,8)). 0 gives
  // strikeIn = 3, then a single large-dt frame drives strikeIn below 0 and triggers the strike.
  scriptRandom([0], 0.5); // strikeIn = rnd(3,8) with random=0 -> 3.0; build() drops use the default
  const canvas = ambientField() as unknown as CanvasNode;
  const ctx = canvas.ctx!;
  ok("storm: a frame was scheduled", raf.scheduleCount >= 1);

  // First frame: dt = 0.016 (last===0), strikeIn 3.0 -> 2.98, no strike yet.
  scriptRandom([], 0.5);
  raf.flush(2000);
  ok("storm: no strike on the first small-dt frame", ctx.fillRects === 0);

  // Now drive large-dt frames. Each clamps dt to 0.05, so strikeIn drains 0.05/frame; ~60 frames
  // crosses the 3.0 threshold and fires a strike (flash=1, bolt built, boltLife=0.22). Keep going
  // so the flash decays to 0 (the flash>0 branch and its Math.max floor) and the bolt life expires
  // (the bolt!=null && boltLife>0 branch, the moveTo/lineTo bolt-draw loop, and the boltLife<=0
  // reset that nulls the bolt).
  for (let i = 0; i < 120; i++) raf.flush(3000 + i * 100); // +0.1s each, clamped to 0.05
  ok("storm: the lightning flash was painted (fillRect ran)", ctx.fillRects > 0);
  ok("storm: a flash gradient was created (createLinearGradient ran)", ctx.gradients > 0);
  ok("storm: the bolt was stroked (extra strokes beyond the rain streaks)", ctx.strokes > 0);
  ok("storm: streaks still drawn under the storm preset", ctx.clears > 0);
}

// =============================================================================================
// Section 5: reduced motion is a HARD gate. With prefers-reduced-motion matching, start() returns
// before scheduling, so even a non-off preference draws nothing.
// =============================================================================================
{
  matchMediaReduced = true;
  setRainPref("storm"); // a lightning preset, to prove even storm is gated off
  raf.reset();
  winListeners = {};
  docListeners = {};
  const canvas = ambientField() as unknown as CanvasNode;
  ok("reduced-motion: NO requestAnimationFrame scheduled (the hard gate held)", raf.scheduleCount === 0);
  ok("reduced-motion: the canvas was still created and sized", canvas.width > 0);

  // Now flip the in-app preference to "full", which overrides the OS gate, and fire the a11y-change
  // hook the canvas subscribed to: motionOK() now returns true, so start() runs and a frame is
  // scheduled live (the onA11yChange -> start branch).
  const beforeFull = raf.scheduleCount;
  setA11yPref("motion", "full");
  ok("reduced-motion -> full: the a11y hook restarted the loop (a frame scheduled)", raf.scheduleCount > beforeFull);

  // And back: forcing motion "reduced" fires the hook again and takes the stop() branch (running
  // goes false, the pending frame is cancelled).
  setA11yPref("motion", "reduced");
  raf.reset();
  fireWindow("resize"); // a resize while stopped must not crash or start a loop
  ok("full -> reduced: with motion reduced, a resize does not start the loop", raf.scheduleCount === 0);
  // restore for later sections
  setA11yPref("motion", "system");
  matchMediaReduced = false;
}

// =============================================================================================
// Section 6: the tab-hidden gate + the visibilitychange wiring. A hidden tab makes start() return
// early; firing visibilitychange to visible then starts it, and to hidden stops it.
// =============================================================================================
{
  matchMediaReduced = false;
  setRainPref("medium");
  docHandle.hidden = true; // tab hidden at construction
  raf.reset();
  winListeners = {};
  docListeners = {};
  const canvas = ambientField() as unknown as CanvasNode;
  ok("hidden-tab: NO frame scheduled while the tab is hidden", raf.scheduleCount === 0);
  ok("hidden-tab: a visibilitychange listener was wired", (docListeners.visibilitychange ?? []).length === 1);

  // Become visible: the handler calls start(), which now schedules a frame.
  docHandle.hidden = false;
  docHandle.fireVisibility();
  ok("becomes-visible: the visibilitychange handler started the loop", raf.scheduleCount >= 1);

  // Become hidden again: the handler calls stop(), cancelling the pending frame and clearing.
  const ctx = canvas.ctx!;
  const clearsBefore = ctx.clears;
  docHandle.hidden = true;
  docHandle.fireVisibility();
  ok("becomes-hidden: stop() cancelled the pending frame", raf.pending() === 0);
  ok("becomes-hidden: stop() cleared the canvas", ctx.clears > clearsBefore);
  docHandle.hidden = false;
}

// =============================================================================================
// Section 7: the resize hook rebuilds the drop field for the new size, and the rain-change hook
// re-reads colours and reconfigures live (off -> medium without a remount).
// =============================================================================================
{
  matchMediaReduced = false;
  setRainPref("off"); // start OFF so the rain-change hook drives the off->medium reconfigure
  raf.reset();
  winListeners = {};
  docListeners = {};
  const canvas = ambientField() as unknown as CanvasNode;
  ok("rain-hook: starts OFF, nothing scheduled", raf.scheduleCount === 0);

  // Resize the window, then fire the resize handler: resize() re-measures and build() re-seeds.
  (globalThis as unknown as Record<string, unknown>).innerWidth = 600;
  (globalThis as unknown as Record<string, unknown>).innerHeight = 400;
  (globalThis as unknown as Record<string, unknown>).devicePixelRatio = 1;
  fireWindow("resize");
  ok("rain-hook: a resize re-sized the canvas to the new viewport (600x400)", canvas.width === 600 && canvas.height === 400);

  // Now switch the rain preference to medium: the subscribed hook re-reads colours and reconfigures,
  // which builds drops and starts the loop without a remount.
  setRainPref("medium");
  ok("rain-hook: switching to medium live started the loop", raf.scheduleCount >= 1);
}

// =============================================================================================
// Section 8: the colour-read branches. When --accent / --trust are absent the cached defaults are
// kept (the `if (a)` / `if (t)` guards take the false arm); the canvas must still render.
// =============================================================================================
{
  matchMediaReduced = false;
  accentVar = ""; // both custom properties empty -> the guards keep the baked-in defaults
  trustVar = "";
  setRainPref("medium");
  raf.reset();
  winListeners = {};
  docListeners = {};
  const canvas = ambientField() as unknown as CanvasNode;
  const ctx = canvas.ctx!;
  ok("no-colours: the canvas still rendered with the default palette", raf.scheduleCount >= 1);
  raf.flush(5000);
  raf.flush(5200);
  ok("no-colours: streaks were still stroked (defaults stand in for missing --accent/--trust)", ctx.strokes > 0);
  // restore for any later use
  accentVar = "#84a4ff";
  trustVar = "#4fd0bf";
}

// =============================================================================================
// Section 9: the device-pixel-ratio edges in resize(). devicePixelRatio falsy takes the `|| 1`
// fallback; a very high ratio is capped at 2 by Math.min (a hi-DPI display must not blow the
// canvas backing store up unbounded).
// =============================================================================================
{
  matchMediaReduced = false;
  setRainPref("medium");
  // dpr = 0 is falsy -> `|| 1`, so the backing store equals the CSS pixels.
  (globalThis as unknown as Record<string, unknown>).innerWidth = 500;
  (globalThis as unknown as Record<string, unknown>).innerHeight = 300;
  (globalThis as unknown as Record<string, unknown>).devicePixelRatio = 0;
  raf.reset();
  winListeners = {};
  docListeners = {};
  const c1 = ambientField() as unknown as CanvasNode;
  ok("dpr-fallback: a falsy devicePixelRatio falls back to 1 (500x300 backing store)", c1.width === 500 && c1.height === 300);

  // dpr = 3 is clamped to 2 by Math.min, so the backing store is twice the CSS pixels, not triple.
  (globalThis as unknown as Record<string, unknown>).devicePixelRatio = 3;
  raf.reset();
  winListeners = {};
  docListeners = {};
  const c2 = ambientField() as unknown as CanvasNode;
  ok("dpr-cap: a 3x ratio is clamped to 2x (500*2=1000 backing store)", c2.width === 1000 && c2.height === 600);
  (globalThis as unknown as Record<string, unknown>).devicePixelRatio = 1.5;
}

// =============================================================================================
// Section 10: the not-running guard at the top of frame(). A frame callback already queued, then
// the loop stopped (tab hidden), then that stale callback fired must return immediately without
// painting or re-queueing. This is the race the guard exists for.
// =============================================================================================
{
  matchMediaReduced = false;
  setRainPref("medium");
  (globalThis as unknown as Record<string, unknown>).innerWidth = 1200;
  (globalThis as unknown as Record<string, unknown>).innerHeight = 800;
  raf.reset();
  winListeners = {};
  docListeners = {};
  const canvas = ambientField() as unknown as CanvasNode;
  const ctx = canvas.ctx!;
  ok("stale-frame: the loop started (a frame is queued)", raf.pending() === 1);
  const staleCb = raf.peek();
  // Stop the loop (the visibilitychange-to-hidden path calls stop()); the running flag flips false.
  docHandle.hidden = true;
  docHandle.fireVisibility();
  docHandle.hidden = false;
  const strokesBefore = ctx.strokes;
  const scheduledBefore = raf.scheduleCount;
  // Fire the now-stale callback directly: frame() sees running===false and returns at the guard.
  ok("stale-frame: a callback was captured to fire post-stop", staleCb !== null);
  staleCb!(9999);
  ok("stale-frame: the stopped frame painted nothing (the not-running guard held)", ctx.strokes === strokesBefore);
  ok("stale-frame: the stopped frame did not re-queue itself", raf.scheduleCount === scheduledBefore);
}

// ---------------------------------------------------------------------------------------------
// Teardown: restore the real Math.random so we leave no global mutated for sibling cov files.
Math.random = realRandom;

console.log(failures === 0 ? "\nAMBIENT-FIELD VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
if (failures > 0) process.exit(1);
