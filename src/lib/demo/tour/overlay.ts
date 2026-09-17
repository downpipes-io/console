// Shared tour chrome helpers for the public page-walkthrough tour. The real console screen is the star, fully
// visible, and the guide (the bottom-centre nav-bar + the "?" info-points) sits ON it, never over it. This
// module owns the visible focus-ring helper pair, shared by the nav-bar (tour/nav-bar.ts), the info-points
// (tour/info-point.ts) and the welcome card (tour/persona-fork.ts): the one place the console's own focus ring
// is drawn imperatively through the CSSOM, so every piece of tour chrome shows the identical ring.
//
// CSP: every style is applied through the CSSOM (per-property setProperty), never an inline style attribute or a
// <style> block, so this runs under the console's strict style-src 'self' with no 'unsafe-inline'.

// applyFocusRing draws the console's own visible focus ring on a container the tour focuses programmatically (the
// nav-bar on a chapter change, a "?" marker on a pointer open, the welcome card panel). It mirrors the global
// :focus-visible rule in tokens.css (2px --ring, 2px offset) but is set imperatively, because a .focus() on a
// tabindex=-1 container is not a keyboard-initiated focus and so never matches :focus-visible: without this a
// sighted keyboard user would get NO visible cue that focus moved into the tour chrome. The shared helper means
// the ring is identical everywhere the tour draws it.
export function applyFocusRing(el: HTMLElement): void {
  el.style.setProperty("outline", "2px solid var(--ring)");
  el.style.setProperty("outline-offset", "2px");
  el.style.setProperty("border-radius", "var(--radius-lg)");
}

// clearFocusRing removes the ring applyFocusRing drew, so the cue shows ONLY while the container itself holds
// focus (the user tabbing to a control inside it, or away, clears it via the blur listener that calls this).
// This mirrors how :focus (not :focus-visible) would fall off the container in a browser. The border-radius is
// left as set (it matches the chrome's own radius, so clearing it is unnecessary and would be churn).
export function clearFocusRing(el: HTMLElement): void {
  el.style.setProperty("outline", "none");
  el.style.setProperty("outline-offset", "0");
}
