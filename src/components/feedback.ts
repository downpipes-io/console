// Empty, skeleton (loading), and banner primitives.
// These cover three of the six states every screen must handle (empty / loading /
// the global notice; the error states live in error-view.ts). Empty TEACHES rather
// than apologises and distinguishes true-empty from filtered-empty; the skeleton
// matches the final layout's shape and is reduced-motion aware via tokens.css; the
// banner is the sparing global notice (an available update, an Access-not-enforced
// caution).

import { h, svgIcon, type Child } from "../lib/dom.ts";
import { ICON_INFO, ICON_ALERT, ICON_CLOSE } from "../lib/icons.ts";
import { statusWithLabel, type StatusTone } from "./status.ts";

// emptyState: a one-line explanation, an optional single next action, and (where it
// helps) a small inline diagram. Distinct copy for true vs filtered empty is the
// caller's job (it passes different text); this renders either.
export function emptyState(opts: {
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void; variant?: "primary" | "secondary" };
  // An optional small inline node above the text (e.g. a source->engine->dest hint).
  diagram?: Node;
}): HTMLElement {
  const card = h("div", { class: "empty-state card card--inset measure" });
  if (opts.diagram) card.appendChild(h("div", { class: "empty-state__diagram" }, opts.diagram));
  card.appendChild(h("h3", { class: "empty-state__title" }, opts.title));
  if (opts.body) card.appendChild(h("p", { class: "empty-state__body" }, opts.body));
  if (opts.action) {
    const cls = opts.action.variant === "secondary" ? "btn btn--secondary" : "btn btn--primary";
    card.appendChild(
      h(
        "div",
        { class: "empty-state__action", style: "margin-top:var(--space-4)" },
        h("button", { "data-dp": "components-feedback.button.click#1", class: cls, type: "button", on: { click: () => opts.action!.onClick() } }, opts.action.label),
      ),
    );
  }
  return card;
}

// skeletonRows builds N skeleton bars (used while a list/table first loads). The
// container is aria-busy and the bars are aria-hidden; the shimmer is gated by
// reduced motion in tokens.css (it falls back to a static tint).
export function skeletonRows(count = 4): HTMLElement {
  const wrap = h("div", { class: "skeleton-block", "aria-busy": "true", "aria-hidden": "true" });
  for (let i = 0; i < count; i++) wrap.appendChild(h("div", { class: "skeleton skeleton-row" }));
  return wrap;
}

// skeletonTiles builds a grid of N skeleton stat tiles (Overview first load).
export function skeletonTiles(count = 4): HTMLElement {
  const wrap = h("div", { class: "stat-grid", "aria-busy": "true", "aria-hidden": "true" });
  for (let i = 0; i < count; i++) wrap.appendChild(h("div", { class: "skeleton skeleton-tile" }));
  return wrap;
}

// banner: a full-width notice at the top of a screen. Semantic variants info / warn
// / danger. A persistent posture warning (Access not enforced) is not dismissible
// until resolved (dismissible defaults false; pass true for transient notices).
export function banner(opts: {
  tone: "info" | "warn" | "danger";
  message: Child;
  action?: { label: string; onClick: () => void };
  dismissible?: boolean;
}): HTMLElement {
  const icon = opts.tone === "info" ? ICON_INFO : ICON_ALERT;
  const el = h("div", { class: `banner banner--${opts.tone}`, role: "region", "aria-label": "Notice" });
  el.appendChild(h("span", { class: "banner__icon" }, svgIcon(icon, { size: 18 })));
  const msg = h("div", { class: "banner__msg" });
  if (typeof opts.message === "string" || typeof opts.message === "number") msg.appendChild(document.createTextNode(String(opts.message)));
  else if (opts.message) msg.appendChild(opts.message as Node);
  el.appendChild(msg);
  if (opts.action) {
    el.appendChild(
      h("button", { "data-dp": "components-feedback.button.click#2", class: "btn btn--secondary btn--sm banner__action", type: "button", on: { click: () => opts.action!.onClick() } }, opts.action.label),
    );
  }
  if (opts.dismissible) {
    el.appendChild(
      h("button", { "data-dp": "components-feedback.button.remove", class: "btn btn--ghost btn--icon btn--sm banner__close", type: "button", "aria-label": "Dismiss", on: { click: () => el.remove() } }, svgIcon(ICON_CLOSE, { size: 14 })),
    );
  }
  return el;
}

// noteQuiet: the calm informational note, one muted line, no border,
// no tint. Use it for standing context; the tinted banner family above stays
// reserved for action-needed-now.
export function noteQuiet(...content: Child[]): HTMLElement {
  return h("div", { class: "note-quiet" }, ...content);
}

// postureStrip: ONE line carrying a screen's standing posture, a few
// dot + phrase items, replacing stacked caveat banners. Each item keeps the
// hue + phrase + label contract (statusWithLabel); the full detail belongs
// behind its own affordance, never inline.
//
// The strip carries NO trailing affordance of its own, deliberately. It used to
// take an optional `detail: { label, onClick }` that rendered a trailing
// link-like button, and in the whole life of the component not one of its three
// callers ever passed it: /access renders a lazyDisclosure ("Governance posture
// and who enforces what") immediately below the strip, /identity-providers puts
// the detail in the provider grid the strip sits above, and /credentials puts it
// in the expiry table directly beneath. Design-system 7a asks for "detail behind
// its own affordance", which all three already satisfy on the same screen; a
// trailing link would have been a second affordance for detail already on the
// page. Removed rather than left as a permanently unreachable control
// in the action catalogue.
export function postureStrip(
  items: Array<{ tone: StatusTone; label: string }>,
  opts: { label?: string } = {},
): HTMLElement {
  const strip = h("div", { class: "posture-strip", role: "region", "aria-label": opts.label ?? "Posture" });
  for (const item of items) {
    strip.appendChild(h("span", { class: "posture-strip__item" }, statusWithLabel(item.tone, item.label)));
  }
  return strip;
}
