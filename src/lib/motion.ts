// The motion helpers for the setup surface (and anything else that wants them). Every helper:
//   - checks motionOK() first (the OS setting, or the in-app Settings > Accessibility preference), and is
//     INSTANT under reduced motion, leaving the element exactly as the full-motion path ends it;
//   - feature-detects its API (element.animate), so a validator that mounts screens in the Node DOM shim,
//     which has none, runs it as a no-op;
//   - reads durations and easings from the named tokens in public/tokens.css (--dur-1..4, --ease-emph,
//     --ease-exit), falling back to the same values when a token cannot be read.
// WAAPI writes no style attribute, so it stays inside the CSP (style-src 'self').

import { motionOK } from "./a11y-prefs.ts";

export { motionOK };

export type DurationToken = "--dur-1" | "--dur-2" | "--dur-3" | "--dur-4";
export type EasingToken = "--ease-emph" | "--ease-exit";

const DURATION_FALLBACK: Record<DurationToken, number> = { "--dur-1": 120, "--dur-2": 200, "--dur-3": 280, "--dur-4": 400 };
const EASING_FALLBACK: Record<EasingToken, string> = { "--ease-emph": "cubic-bezier(0.2, 0, 0, 1)", "--ease-exit": "cubic-bezier(0.4, 0, 1, 1)" };

function readToken(name: string): string {
  try {
    if (typeof getComputedStyle !== "function" || typeof document === "undefined") return "";
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return "";
  }
}

// durationMs reads a duration token in milliseconds (0 under reduced motion, where the token collapses).
export function durationMs(token: DurationToken): number {
  if (!motionOK()) return 0;
  const raw = readToken(token);
  const m = /^([\d.]+)(ms|s)$/.exec(raw);
  if (!m) return DURATION_FALLBACK[token];
  const n = Number(m[1]) * (m[2] === "s" ? 1000 : 1);
  return Number.isFinite(n) ? n : DURATION_FALLBACK[token];
}

export function easing(token: EasingToken): string {
  return readToken(token) || EASING_FALLBACK[token];
}

function canAnimate(el: Element): el is Element & { animate: Element["animate"] } {
  return typeof (el as { animate?: unknown }).animate === "function";
}

export interface EnterOptions {
  // Where the element comes from. "fade" moves nothing.
  from?: "below" | "above" | "left" | "right" | "fade";
  // How far it travels, in px (default 8).
  distance?: number;
  duration?: DurationToken;
  // Delay in ms, for at most three groups arriving in DOM order.
  delay?: number;
}

// enter animates an element into place (opacity and a short translate). It returns the Animation, or null
// when it did nothing (reduced motion, or no WAAPI): the element is then already in its final state. The
// animation uses fill "backwards", so a delayed group is invisible until its turn and never blanks
// content that is already showing.
export function enter(el: HTMLElement, opts: EnterOptions = {}): Animation | null {
  if (!motionOK() || !canAnimate(el)) return null;
  const d = opts.distance ?? 8;
  const from = opts.from ?? "below";
  const dx = from === "left" ? -d : from === "right" ? d : 0;
  const dy = from === "below" ? d : from === "above" ? -d : 0;
  try {
    return el.animate(
      [
        { opacity: 0, transform: `translate(${dx}px, ${dy}px)` },
        { opacity: 1, transform: "none" },
      ],
      { duration: durationMs(opts.duration ?? "--dur-3"), delay: opts.delay ?? 0, easing: easing("--ease-emph"), fill: "backwards" },
    );
  } catch {
    return null;
  }
}
