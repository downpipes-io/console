// The free-roam pricing affordance (marketing brief): visitors who skip or exit the tour
// and click around the live demo previously met NO call to action anywhere. This mounts one quiet
// "See pricing" pill stacked above the bottom-right tour pill slot, appearing only after genuine
// exploration time (delayed-then-stable reads as earned; immediate reads as clutter) and hiding
// itself whenever the guided tour's chrome is up (the rail carries its own asks there). It is a real
// anchor to the pricing page; the ?src=pricing-roam parameter is counted server-side on
// downpipes.io, so the tour itself still sends nothing anywhere. Styling is per-property CSSOM
// (strict CSP); the emit is the local, flag-gated funnel event the other CTAs share.
//
// House rules: Australian English, no em dashes.

import { emit } from "./analytics.ts";

// The stable id (one pill per page; the director-independent guide check reads the nav-bar id).
const ROOT_ID = "tour-pricing-pill";
// How long a free-roaming visitor explores before the ask appears.
const SHOW_DELAY_MS = 60_000;

// mountPricingPill arms the pill. delayMs is injectable for the validators; production uses the
// default. Idempotent: a stale pill is replaced. A document with no body is a no-op.
export function mountPricingPill(doc: Document = document, delayMs: number = SHOW_DELAY_MS): void {
  doc.getElementById(ROOT_ID)?.remove();
  const body = doc.body;
  if (!body) return;

  let armed = false;

  const pill = doc.createElement("a");
  pill.id = ROOT_ID;
  pill.className = "btn btn--secondary btn--sm";
  pill.textContent = "See pricing";
  pill.setAttribute("href", "https://downpipes.io/pricing?src=pricing-roam");
  pill.setAttribute("target", "_blank");
  pill.setAttribute("rel", "noopener noreferrer");
  pill.setAttribute("aria-label", "See pricing (opens downpipes.io)");
  pill.setAttribute("title", "Community is free. Support is the only paid thing.");
  // data-front-layer: see persona-fork.ts's card for why (a --z-palette layer outside the overlay
  // engine; tokens.css lifts a confirm/modal above it when this attribute is present).
  pill.dataset.frontLayer = "true";
  const s = pill.style;
  s.setProperty("position", "fixed");
  s.setProperty("right", "var(--space-4)");
  // Stacked directly above the "Take the tour" / "Resume tour" pill slot (they are bottom-right too).
  s.setProperty("bottom", "calc(var(--space-6) + 52px)");
  s.setProperty("z-index", "var(--z-palette)");
  s.setProperty("display", "none");
  s.setProperty("align-items", "center");
  s.setProperty("gap", "var(--space-2)");
  s.setProperty("box-shadow", "var(--shadow-lg)");
  s.setProperty("pointer-events", "auto");
  s.setProperty("text-decoration", "none");
  pill.addEventListener("click", () => emit({ name: "cta_clicked", detail: "pricing-roam" }));
  body.appendChild(pill);

  // Visible only when BOTH hold: the exploration delay has elapsed AND the guided tour's chrome is
  // down (the rail carries its own pricing paths while guiding). The guide check watches the DOM
  // itself, so this module needs no wiring into the director.
  const refresh = (): void => {
    const guideUp = doc.getElementById("tour-nav-bar") !== null || doc.getElementById("tour-persona-fork") !== null;
    s.setProperty("display", armed && !guideUp ? "inline-flex" : "none");
  };

  if (typeof setTimeout === "function") {
    setTimeout(() => { armed = true; refresh(); }, delayMs);
  }
  const MO = (typeof globalThis !== "undefined" ? (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver : undefined);
  if (typeof MO === "function") {
    new MO(refresh).observe(body, { childList: true });
  }
}
