// Nav-link construction for the shell rail: the single source for
// a rail link's markup, its read-only/locked tooltip shaping, and the quiet "needs
// attention" count chip. The rail renderer (rail.ts) builds every link through here, and
// buildNavLink / applyNavCount are exported for the nav/shell validators so the tests
// exercise the production path rather than a copy.

import { h, svgIcon } from "../lib/dom.ts";
import { NAV, type NavItem } from "./nav.ts";
import type { CuratedNavItem } from "../lib/view-mode.ts";

// Exported for the nav/shell validators: they build a REAL rail link and
// assert the count chip's presence/text/aria, exercising the production code rather than a copy.
export function buildNavLink(item: NavItem, onNavigate: (route: string) => void, curated?: CuratedNavItem, setupLockedReason?: string): HTMLAnchorElement {
  // A read-only item is one the role can see but not edit, or one only present via the show-all
  // escape hatch (outside the curated surface). It is marked with a quiet "read-only" tooltip + a
  // data attribute (no inline style), so the rail reads honestly; the engine is still the gate.
  const readOnly = curated ? (curated.viaShowAll || curated.surface === "read") : false;
  const title = setupLockedReason !== undefined
    ? `${item.label}, ${setupLockedReason}`
    : curated?.viaShowAll
      ? `${item.label} (outside your role; read-only)`
      : readOnly
        ? `${item.label} (read-only)`
        : item.label;
  const link = h(
    "a",
    {
      class: "nav-item",
      href: item.route,
      // The label stays in the DOM (visually-hidden when collapsed) so the
      // accessible name survives collapse; a tooltip mirrors it via title.
      title,
      ...(readOnly ? { dataset: { readonly: "true" } } : {}),
      ...(setupLockedReason !== undefined ? { "data-setup-locked": "true", "aria-description": setupLockedReason } : {}),
      on: {
        click: (ev: Event) => {
          // Intercept for the SPA router; allow modified clicks (new tab) through.
          const me = ev as MouseEvent;
          if (me.metaKey || me.ctrlKey || me.shiftKey || me.altKey) return;
          ev.preventDefault();
          onNavigate(item.route);
        },
      },
    },
    svgIcon(item.icon, { size: 20 }),
    h("span", { class: "nav-item__label" }, item.label),
  ) as HTMLAnchorElement;
  return link;
}

// applyNavCount renders (or clears) the quiet "needs attention" count chip on a nav link. A count > 0
// adds a small `.nav-item__count` pill whose TEXT is the integer (set via h()'s textContent, never
// markup) and sets an aria-label on the link ("N items need attention") so the signal reads by shape
// + label, not colour alone. A 0/undefined count removes the chip and the
// aria-label, restoring the bare link. Idempotent: it clears any existing chip first, so repeated
// calls (a status refresh) replace rather than stack. No animation, no ambient motion.
// Exported for the nav/shell validators (see buildNavLink).
export function applyNavCount(link: HTMLAnchorElement, count: number | undefined): void {
  link.querySelector(".nav-item__count")?.remove();
  if (count === undefined || count <= 0) {
    link.removeAttribute("aria-label");
    return;
  }
  const noun = count === 1 ? "item needs" : "items need";
  link.setAttribute("aria-label", `${link.querySelector(".nav-item__label")?.textContent ?? ""}, ${count} ${noun} attention`.trim());
  // The chip is the LAST child so it sits to the right of the label; the integer is text content,
  // and aria-hidden because the link's aria-label already announces the count to assistive tech (so
  // the number is not read twice).
  link.appendChild(h("span", { class: "nav-item__count", "aria-hidden": "true" }, String(count)));
}

// findNavItem looks an item up by route in the static NAV (used to resolve activeFor patterns).
export function findNavItem(route: string): NavItem | undefined {
  for (const group of NAV) {
    for (const item of group.items) if (item.route === route) return item;
  }
  return undefined;
}
