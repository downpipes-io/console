// Shared SVG primitives for the topology render layer (the namespace constant, the
// textContent-only <text>/<glyph> helpers, the roving-tabindex group wiring and the
// reduced-motion read). Split out of topology-svg.ts so the edge and node builders share
// them without a circular import; runtime behaviour is identical (these are the byte-for-byte
// helpers the renderer always used). No-custody is never weakened: every server-supplied
// string reaches the DOM through textContent (svgText), so there is no markup-injection
// surface.

import { svgIcon } from "../lib/dom.ts";

export const SVG_NS = "http://www.w3.org/2000/svg";

// ---------------------------------------------------------------------------
// Small SVG text/glyph helpers. SVG <text> content is set via textContent (never parsed
// as markup), so a server-supplied node name cannot inject markup.
// ---------------------------------------------------------------------------

export function svgText(content: string, x: number, y: number, className: string): SVGTextElement {
  const t = document.createElementNS(SVG_NS, "text");
  t.setAttribute("class", className);
  t.setAttribute("x", String(x));
  t.setAttribute("y", String(y));
  t.textContent = content; // textContent: the name is escaped, never markup
  return t;
}

// svgGlyph renders an icons.ts glyph inline (a trusted in-repo constant) on the 24px grid,
// scaled to 16px, with currentColor stroke so it themes for free. Reuses dom.ts svgIcon
// for the wrapper, nested inside the parent SVG.
export function svgGlyph(pathMarkup: string): SVGSVGElement {
  return svgIcon(pathMarkup, { size: 16 });
}

// applyRovingGroup makes a set of focusable elements a single tab stop with arrow-key
// movement: the first is tabindex 0, the rest -1; ArrowUp/Down/
// Left/Right and Home/End move focus and the tab stop. Pure DOM; safe to call with zero
// matches (an empty column).
//
// WCAG 1.3.1 / 4.1.2 guard: an element that is aria-hidden (or is inside an
// aria-hidden ancestor) must not receive keyboard focus. The roving group filters out
// any matched element that carries aria-hidden="true" directly, because a focusable
// aria-hidden element is invisible to assistive tech while reachable via Tab - the
// screen-reader user skips the stop but keyboard-only users can still land on it, and
// browser focus rings appear on invisible-to-AT content. The SVG node <g> elements
// ARE aria-hidden (the SVG is role="img"; the operable surface is the table row
// buttons), so they are excluded here. The edge hit paths are also aria-hidden but
// similarly excluded - sighted keyboard panning still works via the non-aria-hidden
// path (the container's keydown listener routes focus among the items), and the gate
// prevents the roving stop from ever landing on an aria-hidden target.
export function applyRovingGroup(container: Element, selector: string): void {
  const all = Array.from(container.querySelectorAll<SVGElement>(selector));
  // Exclude aria-hidden elements so keyboard focus never lands on an AT-invisible node.
  const items = all.filter((el) => el.getAttribute("aria-hidden") !== "true");
  if (items.length === 0) return;
  // Ensure any excluded aria-hidden element never holds a tab stop (it may already
  // carry tabindex="-1" from buildNode; remove any positive value to be safe).
  all.forEach((el) => { if (el.getAttribute("aria-hidden") === "true") el.removeAttribute("tabindex"); });
  items.forEach((it, i) => {
    it.setAttribute("tabindex", i === 0 ? "0" : "-1");
  });

  container.addEventListener("keydown", (ev: Event) => {
    const ke = ev as KeyboardEvent;
    if (ke.key !== "ArrowDown" && ke.key !== "ArrowUp" && ke.key !== "ArrowLeft" && ke.key !== "ArrowRight" && ke.key !== "Home" && ke.key !== "End") return;
    const active = document.activeElement as SVGElement | null;
    const idx = active ? items.indexOf(active) : -1;
    if (idx < 0) return;
    let next = idx;
    if (ke.key === "ArrowDown" || ke.key === "ArrowRight") next = Math.min(items.length - 1, idx + 1);
    else if (ke.key === "ArrowUp" || ke.key === "ArrowLeft") next = Math.max(0, idx - 1);
    else if (ke.key === "Home") next = 0;
    else if (ke.key === "End") next = items.length - 1;
    if (next === idx) return;
    ke.preventDefault();
    items.forEach((it) => {
      it.setAttribute("tabindex", "-1");
    });
    const target = items[next]!;
    target.setAttribute("tabindex", "0");
    // focus() is defined on SVGElement in the DOM lib; the runtime guard keeps a shimmed/non-DOM
    // test environment safe where the element may not carry it.
    if (typeof target.focus === "function") {
      target.focus();
    }
  });
}

// prefersReducedMotion reads the operator's console-level motion preference first (the
// data-motion attribute lib/a11y-prefs.ts maintains: "reduced" forces calm, "full" is the
// explicit opt-in that outranks the OS query), then the media query, guarded for a
// non-DOM/SSR/test environment (where the renderer is never called, but the guard keeps the
// module import-safe). Mirrors live-flow.ts exactly so the two views agree on motion; the
// CSS reduced-motion block is belt-and-braces over it.
export function prefersReducedMotion(): boolean {
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
