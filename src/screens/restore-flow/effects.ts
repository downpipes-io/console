// Restore the shared mechanics behind the flow's five restrained, one-shot
// motion cues: the stepper's connector fill (E1, shared.ts restoreStepper), the
// plan-hash seal tick (E2, confirm.ts), the approval-state crossfade (E4, confirm.ts) and the
// receipt seal stroke (E6, receipt.ts) all call into the two helpers below, so confirm.ts and
// receipt.ts stay thin at the call site and neither duplicates the other's stroke-draw code. E5
// (the Apply button's disabled -> enabled fade) needs no helper: it is a plain CSS transition on
// the shared .btn--danger rule, since the native :disabled toggle already drives it.
//
// Every cue here is gated on motionOK() (lib/a11y-prefs.ts) for its JS-driven part; under reduced
// motion each function below skips straight to the finished, static state (a fully drawn glyph, an
// instant swap) rather than playing a fast version of the same animation. Nothing here loops or
// repeats: a draw plays once per genuinely new key and a crossfade plays once per genuine state
// change; a re-render that finds the SAME key/state is always a no-op past the first line. House
// rules: Australian English, no em dashes, precise claims.

import { motionOK } from "../../lib/a11y-prefs.ts";

// drawStrokeOnce animates an aria-hidden glyph's path(s) with a one-shot "draw" via
// stroke-dashoffset (E2's plan-hash seal, E6's receipt tick): each path measures its OWN real
// length at call time (getTotalLength), so the reveal paces evenly across the whole glyph
// regardless of which icon is passed in, then transitions dashoffset to 0 over durationMs.
//
// replay is the CALLER's own "have I already drawn this exact key" decision (E2 compares the plan
// hash string; E6 checks a WeakSet keyed on the applied result object), so this helper holds no
// state of its own; two independent call sites can never share or clobber each other's memory. A
// replay, reduced motion, or a glyph with no <path> children (e.g. a shim/test DOM) leaves the
// glyph in its normal solid-stroke resting state: already complete, never re-drawn, never
// scrambled or masked.
//
// The one-frame requestAnimationFrame below is not a loop: it is the standard "let the browser
// paint the fully-hidden starting state once before transitioning" step a freshly-built element
// needs (a plain CSS transition would otherwise see the "from" and "to" values set in the same
// tick and never animate), the same role the dp-rise / dp-fade-in keyframes play for elements
// that do not need a runtime-measured length.
export function drawStrokeOnce(svg: SVGSVGElement, replay: boolean, durationMs: number): void {
  if (replay || !motionOK()) return;
  const paths = Array.from(svg.querySelectorAll("path"));
  if (paths.length === 0) return;
  for (const path of paths) {
    const len = path.getTotalLength();
    path.style.setProperty("stroke-dasharray", String(len));
    path.style.setProperty("stroke-dashoffset", String(len));
  }
  requestAnimationFrame(() => {
    for (const path of paths) {
      path.style.setProperty("transition", `stroke-dashoffset ${durationMs}ms var(--ease-out)`);
      path.style.setProperty("stroke-dashoffset", "0");
    }
  });
}

// crossfadeSwap (E4) replaces host's content with next by fading host's own opacity to 0,
// swapping the children at that invisible trough, then fading back to 1, so the tint, icon and
// words all change together at once rather than the two states visibly overlapping. durationMs is
// the WHOLE crossfade; each half runs at durationMs / 2. Reentrant-safe: a second call while one
// is already in flight on the SAME host (a rapid double-click on a manual recheck control) skips
// straight to a plain swap rather than stacking two fades on top of each other.
export function crossfadeSwap(host: HTMLElement, next: HTMLElement, durationMs: number): void {
  if (!motionOK() || host.dataset.crossfading === "true") {
    host.replaceChildren(next);
    return;
  }
  host.dataset.crossfading = "true";
  const half = Math.max(1, Math.round(durationMs / 2));
  host.style.setProperty("transition", `opacity ${half}ms var(--ease-in-out)`);
  host.style.setProperty("opacity", "0");
  window.setTimeout(() => {
    host.replaceChildren(next);
    host.style.setProperty("opacity", "1");
    window.setTimeout(() => {
      host.style.setProperty("transition", "");
      host.style.setProperty("opacity", "");
      delete host.dataset.crossfading;
    }, half);
  }, half);
}
