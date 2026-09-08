// The single LOCKED brand mark. It is
// drawn from the one canonical source in lib/icons.ts (BRAND_MARK + BRAND_NAME)
// so the mark and the wordmark cannot drift. Use brandMark() everywhere the
// product identity appears (the rail, the wizard, the signed-out screen); never
// draw the mark inline elsewhere.

import { h } from "../lib/dom.ts";
import { BRAND_MARK, BRAND_MARK_VIEWBOX, BRAND_NAME } from "../lib/icons.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

// brandGlyph builds the mark on its native 512 grid (the owner's downpipes-mark.svg),
// NOT through the generic 24-grid svgIcon, its fixed viewBox/stroke-width would crop
// the bold downspout. currentColor keeps it themed; the route "charge" animates the
// downspout subpath inside the ".dp-mark-body" group (shell/app-shell.ts).
function brandGlyph(size: number, label?: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("viewBox", BRAND_MARK_VIEWBOX);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("class", "brand__glyph");
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  // BRAND_MARK must remain a compile-time constant from lib/icons.ts. It must never be
  // assigned a server-fetched or user-supplied value (for example a white-label logo
  // from the engine); doing so would turn this innerHTML write into a stored-XSS sink.
  svg.innerHTML = BRAND_MARK;
  return svg;
}

export interface BrandOptions {
  // size of the mark glyph in px (default 22, the rail size).
  size?: number;
  // when true, render only the mark (no wordmark), e.g. in the collapsed rail.
  markOnly?: boolean;
  // an accessible label for the mark when it stands alone (markOnly); ignored when
  // the wordmark is shown (the visible text is the accessible name then).
  label?: string;
}

// brandMark renders the mark, optionally with the wordmark beside it. The glyph
// uses currentColor so it inherits the surrounding text colour and themes for
// free. When the wordmark shows, the glyph is decorative (aria-hidden) and the
// visible text carries the accessible name; when markOnly, the glyph carries the
// label.
export function brandMark(opts: BrandOptions = {}): HTMLElement {
  const size = opts.size ?? 22;
  const wrap = h("span", {
    class: "brand",
    style: "display:inline-flex;align-items:center;gap:var(--space-2);color:var(--text);font-weight:var(--weight-semibold);",
  });

  if (opts.markOnly) {
    const glyph = brandGlyph(size, opts.label ?? BRAND_NAME);
    wrap.appendChild(glyph);
    return wrap;
  }

  const glyph = brandGlyph(size);
  glyph.style.color = "var(--accent)"; // the mark takes the action accent for a confident, single brand colour
  wrap.appendChild(glyph);
  wrap.appendChild(
    h("span", { class: "rail__brand-name", style: "font-size:var(--text-md);letter-spacing:-0.01em;" }, BRAND_NAME),
  );
  return wrap;
}
