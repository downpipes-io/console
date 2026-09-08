// THE FUNNEL CHROME: the parts of the guide rail that exist for the marketing TOUR, as nav-bar-course.ts
// holds the parts that exist for the training course. Two deliberate exits on the closing chapter, and one
// quiet standing exit at the chapter index's foot from the middle of the walk onwards.
//
// They live here for the same two reasons the course parts do: the rail is a large module, and these are a
// surface's own furniture rather than the rail's. A course never renders either of them.
//
// CSP: every style is applied per-property through the h() builder's CSSOM path, never an inline style
// attribute, so this runs under the console's strict style-src 'self'.
//
// House rules: Australian English, no em dashes, no rule-of-three, precise claims.

import { h, svgIcon, type Attrs } from "../../dom.ts";
import { ICON_EXTERNAL } from "../../icons.ts";
import type { NavBarCta } from "./nav-bar-course.ts";

// The funnel parts the rail places and drives.
export interface FunnelParts {
  // The closing chapter's two exits, rendered as real anchors. Empty and zero-height on every other chapter.
  ctaRow: HTMLElement;
  // The standing mid-walk exit at the chapter index's foot. Rail-only.
  earlyExitEl: HTMLElement;
  // Render the CTAs (or clear them with an empty list). `lead` is the one honest line above the pair.
  setCtas(ctas: ReadonlyArray<NavBarCta>, lead?: string): void;
  // Show or clear the standing exit. It is rail-only, so the rail says which variant it is wearing.
  setEarlyExit(cfg: { href: string; onActivate?: (() => void) | undefined } | null, isRail: boolean): void;
  // Re-apply the standing exit's visibility after a layout change.
  refresh(isRail: boolean): void;
}

export function buildFunnelParts(): FunnelParts {
  // The funnel-CTA row: the closing chapter's two deliberate exits render here as real anchors, ABOVE the
  // control strip. Empty (and zero-height) on every other chapter. A group label so the two read as a set.
  const ctaRow = h("div", {
    role: "group",
    "aria-label": "What next",
    dataset: { tourCtaRow: "true" },
    style: ["display:none", "flex-wrap:wrap", "gap:var(--space-2)", "width:100%"].join(";"),
  });

// The mid-tour standing exit (rail-only): a quiet "I've seen enough" link to the pricing page at
// the chapter index's foot. Configured by setEarlyExit (the director shows it from chapter 3 and
// hides it on the finale, where the CTA pair takes over). Spatially stable, out of the click path.
let earlyExitCfg: { href: string; onActivate?: (() => void) | undefined } | null = null;
const earlyExitLink = h(
  "a",
  {
    dataset: { tourEarlyExit: "true" },
    target: "_blank",
    rel: "noopener noreferrer",
    style: ["font-size:var(--text-sm)", "font-weight:var(--weight-semibold)", "color:var(--accent-subtle-fg)", "text-decoration:none", "pointer-events:auto"].join(";"),
    on: { click: () => earlyExitCfg?.onActivate?.() },
  },
  "I've seen enough",
) as HTMLAnchorElement;
const earlyExitEl = h(
  "div",
  { dataset: { tourEarlyExitRow: "true" }, style: ["display:none", "flex:none", "flex-direction:column", "gap:2px", "padding-top:var(--space-3)", "margin-top:var(--space-2)", "border-top:1px solid var(--border-subtle)"].join(";") },
  earlyExitLink,
  h("span", { style: ["font-size:var(--text-xs)", "color:var(--text-muted)"].join(";") }, "Skip to pricing. Short version: what you're watching is free."),
);
function refreshEarlyExit(isRail: boolean): void {
  if (earlyExitCfg !== null && isRail) {
    earlyExitLink.setAttribute("href", earlyExitCfg.href);
    earlyExitEl.style.setProperty("display", "flex");
  } else {
    earlyExitEl.style.setProperty("display", "none");
  }
}


// ctaAnchor builds one funnel CTA as a real <a>: the console's .btn classes (primary highlights the deploy
// exit; secondary the support exit), the label as TEXT (never markup), and the href. An https target opens in
// a new tab (target=_blank + rel hardening, so the opened page cannot reach back) with a trailing external
// glyph; a mailto is a plain same-context anchor. The click fires onActivate (the director's cta_clicked emit)
// then lets the native navigation proceed, so the bar never navigates programmatically.
function ctaAnchor(cta: NavBarCta): HTMLAnchorElement {
  const http = isHttp(cta.href);
  const cls = cta.primary ? "btn btn--primary btn--sm" : "btn btn--secondary btn--sm";
  const linkAttrs: Attrs = http ? { target: "_blank", rel: "noopener noreferrer" } : {};
  const attrs: Attrs = {
    class: cls,
    href: cta.href,
    "aria-label": cta.label,
    dataset: { tourCta: cta.primary ? "deploy" : "support" },
    style: ["display:inline-flex", "align-items:center", "justify-content:center", "gap:var(--space-2)", "pointer-events:auto", "text-decoration:none", "flex:1 1 auto"].join(";"),
    on: { click: () => cta.onActivate?.() },
    ...linkAttrs,
  };
  return h(
    "a",
    attrs,
    h("span", cta.label),
    http ? h("span", { "aria-hidden": "true", style: "display:inline-flex" }, svgIcon(ICON_EXTERNAL, { size: 14 })) : null,
  ) as HTMLAnchorElement;
}


  return {
    ctaRow,
    earlyExitEl,
    setCtas(ctas: ReadonlyArray<NavBarCta>, lead?: string): void {
      while (ctaRow.firstChild) ctaRow.removeChild(ctaRow.firstChild);
      if (ctas.length === 0) {
        ctaRow.style.setProperty("display", "none");
        return;
      }
      if (lead !== undefined && lead !== "") {
        ctaRow.appendChild(
          h("p", { dataset: { tourCtaLead: "true" }, style: ["margin:0", "flex:1 1 100%", "font-size:var(--text-sm)", "color:var(--text-muted)", "line-height:1.5"].join(";") }, lead),
        );
      }
      for (const cta of ctas) ctaRow.appendChild(ctaAnchor(cta));
      ctaRow.style.setProperty("display", "flex");
    },
    setEarlyExit(cfg, isRail): void {
      earlyExitCfg = cfg;
      refreshEarlyExit(isRail);
    },
    refresh(isRail): void {
      refreshEarlyExit(isRail);
    },
  };
}

// isHttp tells whether a CTA href is an http(s) URL (resolved against the current origin), so only those get
// target=_blank + rel + the external-link glyph; a mailto: (or any non-http scheme) is a same-context handoff
// the browser makes without a new tab. An unparseable href is treated as non-http (a plain in-context link).
function isHttp(href: string): boolean {
  try {
    const proto = new URL(href, typeof location !== "undefined" ? location.href : "https://tour.downpipes.io").protocol;
    return proto === "https:" || proto === "http:";
  } catch {
    return false;
  }
}
