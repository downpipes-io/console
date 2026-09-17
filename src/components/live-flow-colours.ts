// Canvas colour helpers for the live-flow raster controller (extracted from live-flow.ts to keep
// that file under the structural threshold; behaviour-preserving move only). They read the live
// theme via the DOM, no app state, so the canvas matches the active light/dark tokens.

import type { StatusTone } from "./topology.ts";
import { statusFallbackRgb, parseCssColour } from "./live-flow-model.ts";
import type { Rgb } from "./live-flow-types.ts";

// readToneColour reads the live CSS custom property for a tone when the DOM is available, so
// the canvas matches the theme; falls back to the honest statusFallbackRgb otherwise.
export function readToneColour(tone: StatusTone): Rgb {
  return readCssColour(toneCssVar(tone), statusFallbackRgb(tone));
}

// readCssColour resolves ANY colour-carrying custom property to 0..1 channels, with a fallback.
//
// The tokens are defined as REFERENCES (e.g. --trust: var(--t-500)), and
// getComputedStyle().getPropertyValue("--trust") returns the unsubstituted "var(--t-500)" string,
// which is not a parseable colour. So instead of reading the custom property directly, we resolve
// the whole chain through the browser: write `color: var(--trust)` onto a throwaway probe element
// attached to the document and read back the COMPUTED `color`, which the browser always serialises
// to an rgb()/rgba() string parseCssColour understands. This is the standard way to resolve a
// custom property to its final value, and it correctly follows light/dark (the probe inherits the
// document's theme). Any failure falls back to the honest static value. Callers CACHE the result
// (the probe + getComputedStyle force a style resolution, far too costly for a frame path).
export function readCssColour(varName: string, fallback: Rgb): Rgb {
  if (
    typeof window === "undefined" ||
    typeof getComputedStyle !== "function" ||
    typeof document === "undefined" ||
    typeof document.createElement !== "function" ||
    !document.body ||
    typeof document.body.appendChild !== "function"
  ) {
    return fallback;
  }
  let probe: HTMLElement | null = null;
  try {
    probe = document.createElement("span");
    // Keep the probe invisible and out of layout; only its computed colour is read.
    probe.style.setProperty("position", "absolute");
    probe.style.setProperty("width", "0");
    probe.style.setProperty("height", "0");
    probe.style.setProperty("overflow", "hidden");
    probe.style.setProperty("visibility", "hidden");
    // Resolve the token chain: the browser substitutes var(--trust) -> var(--t-500) -> #0f8c7d
    // and serialises the computed colour as rgb(...). A bad token leaves color unset -> fallback.
    probe.style.setProperty("color", `var(${varName})`);
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color.trim();
    const parsed = parseCssColour(resolved);
    return parsed ?? fallback;
  } catch {
    return fallback;
  } finally {
    if (probe && typeof probe.remove === "function") {
      try {
        probe.remove();
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

// toneCssVar maps a status tone to the design-token custom property that carries its colour.
// These are the REAL tokens in public/tokens.css (--trust / --warn / --danger / --neutral); the
// earlier --color-* names did not exist, so the canvas always fell back to the static palette and
// never followed the theme. The trust tone uses --trust (the verified teal), distinct from the
// --ok status green, matching the SVG map's tones.
export function toneCssVar(tone: StatusTone): string {
  switch (tone) {
    case "trust": return "--trust";
    case "warn": return "--warn";
    case "danger": return "--danger";
    case "neutral": return "--neutral";
  }
}
