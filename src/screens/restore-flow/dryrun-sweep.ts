// E3 - the dry-run verification sweep: while the read-only dry-run request is genuinely still
// pending past SWEEP_DELAY_MS, a thin low-alpha canvas2d scanline (the --trust hue) sweeps the
// loading skeleton rows top-to-bottom ONCE over SWEEP_DURATION_MS, then removes itself; the
// skeleton and its "Verifying the run" note (shared.ts loadingPlan) are untouched underneath and
// simply keep showing for as long as the request is genuinely still in flight. This is a calm,
// one-shot cue bound to a REAL pending request: it never claims a percentage or a step, only
// that the read is still happening, which is the one honest thing it is allowed to say.
//
// Lifecycle mirrors components/ambient-field.ts (the canonical reference): motionOK() gates it
// before any requestAnimationFrame starts, onA11yChange can stop it if the preference flips
// live, and document.hidden pauses/stops it so a backgrounded tab burns no CPU. Unlike
// ambient-field it never loops: the sweep draws AT MOST once, then tears itself down, whether or
// not the request is still pending afterwards.
//
// It also feature-detects canvas2d and rAF (the same guard components/live-flow-model.ts
// detectCanvas2d and components/live-flow-raster.ts start() use), which ambient-field does not
// need (it only ever mounts from the real browser shell chrome). This module mounts from a
// screen's own render() path, which the DOM shim test/validate-tour.ts drives directly, so it
// must degrade to "no canvas, plain skeleton" rather than throw wherever that environment lacks
// a real canvas/rAF.

import { h } from "../../lib/dom.ts";
import { motionOK, onA11yChange } from "../../lib/a11y-prefs.ts";

// How long the request must still be pending before the sweep is worth showing at all (a fast
// dry-run never earns any motion, per the "calm and earned" brief).
const SWEEP_DELAY_MS = 1500;
// How long the one-shot sweep itself takes to cross the skeleton rows top to bottom.
const SWEEP_DURATION_MS = 1200;

export interface DryRunSweepHandle {
  // stop tears down everything this handle owns (the scheduled timer, an in-progress rAF, the
  // canvas, the listeners) immediately. Call it the moment the real request settles - success or
  // failure - whether or not the sweep ever actually started drawing.
  stop: () => void;
}

// readToken safely reads a CSS custom property off the root, falling back when getComputedStyle
// is not a function (the DOM shim tests run under) rather than throwing.
function readToken(name: string, fallback: string): string {
  if (typeof getComputedStyle !== "function") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// mountDryRunSweep watches `card` (the .card.restore-plan loadingPlan() built) for
// SWEEP_DELAY_MS; if stop() has not been called by then (the request is genuinely still
// pending), it draws one top-to-bottom scanline over its ".skeleton-block" rows. Safe to call
// unconditionally: a no-op under reduced motion, a hidden tab, a missing canvas2d/rAF
// environment, or a host with nothing laid out to sweep.
export function mountDryRunSweep(card: HTMLElement): DryRunSweepHandle {
  if (!motionOK() || document.hidden) return { stop: () => {} };
  // Capability gate: bail to a clean no-op in any environment without the DOM/animation APIs the
  // sweep needs. The validate-* DOM shim drives the real render()/runDryRun path but has no
  // addEventListener / requestAnimationFrame / window timers, so the skeleton must simply show
  // with no canvas overlay rather than throw.
  if (
    typeof document.addEventListener !== "function" ||
    typeof requestAnimationFrame !== "function" ||
    typeof window === "undefined" ||
    typeof window.setTimeout !== "function"
  ) {
    return { stop: () => {} };
  }

  const rows = card.querySelector<HTMLElement>(".skeleton-block") ?? card;
  let disposed = false;
  let raf = 0;
  let timer = 0;
  let canvas: HTMLCanvasElement | null = null;

  const teardownCanvas = (): void => {
    if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    raf = 0;
    if (canvas) {
      canvas.remove();
      canvas = null;
    }
  };

  const stop = (): void => {
    if (disposed) return;
    disposed = true;
    if (timer) window.clearTimeout(timer);
    timer = 0;
    teardownCanvas();
    unsubA11y();
    document.removeEventListener("visibilitychange", onVisibility);
  };

  // A live preference flip mid-wait or mid-sweep is a hard stop (MANDATORY gating): the console
  // never keeps animating once reduced motion is asked for, even for a one-shot cue.
  const unsubA11y = onA11yChange(() => {
    if (!motionOK()) stop();
  });
  const onVisibility = (): void => {
    if (document.hidden) stop();
  };
  document.addEventListener("visibilitychange", onVisibility);

  const runSweep = (): void => {
    if (disposed || !motionOK() || document.hidden) return;
    const rect = rows.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const hgt = Math.max(1, Math.round(rect.height));
    if (w <= 1 || hgt <= 1) return; // nothing laid out (e.g. a collapsed ancestor); skip quietly

    const cv = h("canvas", {
      class: "dryrun-sweep",
      "aria-hidden": "true",
      style: "position:absolute;inset:0;pointer-events:none;",
    });
    // Feature-detect rather than trust the type: the DOM shim tests render against has no real
    // canvas backend, so this is the same guard detectCanvas2d/live-flow-raster's start() use.
    if (typeof cv.getContext !== "function" || typeof requestAnimationFrame !== "function") return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.floor(w * dpr);
    cv.height = Math.floor(hgt * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // .skeleton-block carries no position of its own; give it one so the overlay anchors to
    // exactly its box rather than escaping to a distant positioned ancestor.
    rows.style.setProperty("position", "relative");
    rows.appendChild(cv);
    canvas = cv;

    const trust = readToken("--trust", "#0f8c7d");
    // A THIN band (not a broad glow): about 8% of the skeleton's height, floored so it still
    // reads on a short host.
    const band = Math.max(10, hgt * 0.08);
    let start = 0;

    const frame = (now: number): void => {
      if (disposed) return;
      if (start === 0) start = now;
      const t = Math.min(1, (now - start) / SWEEP_DURATION_MS);
      const eased = 1 - (1 - t) * (1 - t) * (1 - t); // easeOutCubic: a calm settle, never a hard stop
      ctx.clearRect(0, 0, w, hgt);
      const y = eased * (hgt + band) - band;
      const grad = ctx.createLinearGradient(0, y, 0, y + band);
      grad.addColorStop(0, "transparent");
      grad.addColorStop(0.5, trust);
      grad.addColorStop(1, "transparent");
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = grad;
      ctx.fillRect(0, y, w, band);
      ctx.globalAlpha = 1;
      if (t >= 1) {
        teardownCanvas();
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  };

  timer = window.setTimeout(() => {
    timer = 0;
    runSweep();
  }, SWEEP_DELAY_MS);

  return { stop };
}
