// The shell's rail rendering and guided-setup strip (design-system.md 6.1,
// information-architecture.md 2): (re)building the curated nav rail for the current
// caller + show-all state, marking the active route, the show-all escape hatch, the
// quiet setup strip between the context bar and the main region, and the view-mode
// segmented control's pressed state. The shell entry (app-shell.ts) owns the DOM
// assembly and the closures; the rendering that re-runs on a caller / setup / route
// change lives here, threaded through ShellInternals.

import { h, svgIcon, clear } from "../lib/dom.ts";
import { NAV, isItemActive, flatNav } from "./nav.ts";
import { ICON_EYE, ICON_OVERVIEW, ICON_INFO } from "../lib/icons.ts";
import { SETUP_ENTRY_ROUTE, setupAllows, setupLockReason, markSetupCelebrated } from "../lib/setup-state.ts";
import { curatedNavForCaller, callerHasCuratedHidden, type CuratedNavItem, type ViewMode } from "../lib/view-mode.ts";
import type { ShellInternals } from "./types.ts";
import { buildNavLink, applyNavCount, findNavItem } from "./nav-links.ts";
import { wireRovingRail } from "./keyboard.ts";

// setViewModeControl reflects the resolved view mode in the two-button segmented toggle: the active
// button carries aria-pressed="true" and the is-active class (CSS, no inline style write), the
// other clears them. Purely a control-state update; switching is driven by the click handlers.
export function setViewModeControl(execBtn: HTMLButtonElement, techBtn: HTMLButtonElement, mode: ViewMode): void {
  const exec = mode === "shiny";
  execBtn.setAttribute("aria-pressed", exec ? "true" : "false");
  techBtn.setAttribute("aria-pressed", exec ? "false" : "true");
  execBtn.classList.toggle("is-active", exec);
  techBtn.classList.toggle("is-active", !exec);
}

// ---- curated rail rendering -------------------------------------------------
// renderRail (re)builds the nav rail from the curated nav for the current caller + show-all state.
// It rebuilds the grouped structure (dropping a group whose every item is curated away), replaces
// the live navLinks map, re-wires the roving tabindex, re-applies the active route, and renders the
// show-all escape hatch in the footer when the caller's surface hides at least one item. Curation
// is presentational only: a hidden item stays reachable by deep link / the palette, and the escape
// hatch shows the full rail read-only, so the rail can never trap a caller or hide evidence.
export function renderRail(internals: ShellInternals): void {
  const curated = curatedNavForCaller(flatNav(), internals.caller, internals.showAll);
  // Index the curated items by route so the grouped render can look each item up (and drop the
  // ones curated away) while preserving the NAV section structure.
  const byRoute = new Map<string, CuratedNavItem>();
  for (const item of curated) byRoute.set(item.route, item);

  const navLinks = new Map<string, HTMLAnchorElement>();
  clear(internals.navEl);
  for (const group of NAV) {
    // An item shows when (a) surface curation kept it (byRoute) AND (b) its optional caller-aware
    // visibleFor predicate permits it. visibleFor is the rare exception to "show every item to a viewer"
    // (the Config approvals inbox is only surfaced to a role that can approve); it is presentational only,
    // the destination staying reachable by deep link / the palette. An item with no predicate is always
    // shown (subject to surface curation), preserving every existing item's behaviour.
    const visibleItems = group.items.filter((it) => byRoute.has(it.route) && (it.visibleFor === undefined || it.visibleFor(internals.caller)));
    if (visibleItems.length === 0) continue; // drop a group fully curated away
    const groupEl = h("div", { class: "rail__group", role: "group" });
    if (group.label) {
      const labelId = `navgrp-${group.label.toLowerCase()}`;
      groupEl.setAttribute("aria-labelledby", labelId);
      groupEl.appendChild(h("div", { class: "rail__group-label", id: labelId }, group.label));
    }
    for (const it of visibleItems) {
      const curatedItem = byRoute.get(it.route)!;
      // Guided setup: an item not yet meaningful is shown LOCKED with the inline
      // reason (never hidden, never a dead click: navigating still works and the
      // route gate redirects to the setup surface with the same explanation).
      const locked = internals.setup !== null && !internals.setup.complete && !setupAllows(it.route, internals.setup);
      const link = buildNavLink(it, internals.navigateFn, curatedItem, locked && internals.setup !== null ? setupLockReason(internals.setup) : undefined);
      // Re-apply the quiet "needs attention" count chip (e.g. /credentials) so it survives this
      // rebuild; a 0/absent count renders nothing.
      applyNavCount(link, internals.navCounts.get(it.route));
      navLinks.set(it.route, link);
      groupEl.appendChild(link);
    }
    internals.navEl.appendChild(groupEl);
  }
  internals.navLinks = navLinks;

  // Roving tabindex over the freshly-built links (one tab stop, arrows move).
  wireRovingRail(internals.navEl, navLinks);
  // Re-apply the active route so the new links carry aria-current correctly.
  if (internals.activePattern) applyActiveRoute(internals, internals.activePattern);

  // The show-all escape hatch: offered only when the caller's surface actually hides an item (a
  // built-in role hides nothing, so it never sees this). It flips internals.showAll and re-renders.
  renderEscapeHatch(internals);

  // Consistent Help (WCAG 3.2.6): a persistent help entry, ALWAYS last in the rail
  // footer on every screen, linking to the shortcuts/help landing.
  const help = h(
    "a",
    { class: "nav-item", href: "/command-palette", on: { click: (ev: Event) => { ev.preventDefault(); internals.navigateFn("/command-palette"); } } },
    svgIcon(ICON_INFO, { size: 20 }),
    h("span", { class: "nav-item__label" }, "Help and shortcuts"),
  );
  internals.railFooter.appendChild(help);
}

// applyActiveRoute marks the active rail item from a resolved route pattern, reading the live
// navLinks map (which a rebuild replaces). An item is active when the pattern is its own route or
// one of its activeFor patterns (findNavItem reads the static NAV for the activeFor list).
export function applyActiveRoute(internals: ShellInternals, pattern: string): void {
  for (const [route, link] of internals.navLinks) {
    const item = findNavItem(route);
    const active = item ? isItemActive(item, pattern) : route === pattern;
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

// renderEscapeHatch renders (or clears) the "show all (read-only)" affordance in the rail footer.
// It is shown only when the caller's surface hides at least one item, so it never adds clutter for
// a role that already sees everything. Toggling it flips internals.showAll and re-renders the rail;
// when on, the otherwise-hidden items return read-only and the footer offers "show my screens" to
// return to the curated surface.
function renderEscapeHatch(internals: ShellInternals): void {
  clear(internals.railFooter);
  const hides = callerHasCuratedHidden(flatNav(), internals.caller);
  if (!hides) return; // nothing hidden: no escape hatch needed
  const label = internals.showAll ? "Show my screens" : "Show all screens";
  const hint = internals.showAll
    ? "Showing the screens your role hides. The engine still enforces what you can change."
    : "Some screens are hidden by your role. Show them.";
  const btn = h(
    "button",
    { "data-dp": "shell-rail.toggle.render-rail",
      class: "btn btn--ghost btn--sm rail-showall",
      type: "button",
      "aria-pressed": internals.showAll ? "true" : "false",
      title: hint,
      on: {
        click: () => {
          internals.showAll = !internals.showAll;
          renderRail(internals);
        },
      },
    },
    svgIcon(internals.showAll ? ICON_OVERVIEW : ICON_EYE, { size: 14 }),
    h("span", { class: "nav-item__label" }, label),
  );
  internals.railFooter.appendChild(btn);
}

// renderSetupStrip renders the guided-setup line from the one setup model (lib/setup-state.ts setupViewOf):
// step pips + "step N of 7" + one Continue into /setup while setup is incomplete; the same Continue while the
// first backup setup started is not finished; a one-time completion state with a dismiss once setup is
// complete; hidden otherwise. Volume discipline: it is a quiet strip, not a banner, one line, no tint, no
// stacking.
export function renderSetupStrip(internals: ShellInternals): void {
  const strip = internals.setupStrip;
  const view = internals.setup;
  if (view === null) {
    strip.hidden = true;
    clear(strip);
    return;
  }
  // While Overview's not-set-up card is showing (route "/", setup incomplete), the strip would restate the
  // same steps with a second Continue about 100px above it; the card owns the statement there. The strip
  // returns on every other screen.
  if (!view.complete && internals.activePattern === "/") {
    strip.hidden = true;
    clear(strip);
    return;
  }
  clear(strip);
  strip.hidden = false;
  const pips = h(
    "span",
    { class: "setup-strip__pips", "aria-hidden": "true" },
    // Finish never carries its own "done" status in the model (setup-state.ts: it is where the flow ends,
    // not a step the facts complete), so its pip reads its state from view.complete instead: the model
    // stays honest and the last pip still fills once the flow is over, matching every "Setup complete" /
    // "Setup finished" line below.
    ...view.steps.map((st, i) =>
      h("span", { class: `setup-pip${st.done || (st.id === "finish" && view.complete) ? " setup-pip--done" : i === view.currentIndex && !view.complete ? " setup-pip--current" : ""}` }),
    ),
  );
  strip.appendChild(pips);
  // While setup is incomplete, the strip names the step. While it is complete but the first backup setup started
  // is not finished (a downpipe of it failed, or is still running), it says so, on every screen and on Overview
  // too; that locks nothing, has no dismiss, and goes when the last of those downpipes seals. Both offer the one
  // way back into /setup, which resumes on its own (on the run, for the first backup). An owner-only step seen
  // by a non-owner reads as an honest hand-off, not a dead Continue (the caller's role is presentation here; the
  // engine enforces).
  const open = view.firstBackupOpen;
  if (!view.complete || open !== null) {
    const needsOwner = !view.complete && view.current.ownerOnly && internals.caller !== null && internals.caller.role !== "owner";
    strip.appendChild(
      h(
        "span",
        { class: "setup-strip__text" },
        open !== null
          ? `Your first backup is not finished: ${open.sealed} of ${open.total} downpipes sealed.`
          : `Setting up, step ${view.stepNumber} of ${view.steps.length}: ${view.current.label}${needsOwner ? ". An Owner does this step." : ""}`,
      ),
    );
    strip.appendChild(
      h(
        "button",
        { "data-dp": "shell-rail.button.navigate-fn", class: "linklike setup-strip__go", type: "button", on: { click: () => internals.navigateFn(SETUP_ENTRY_ROUTE) } },
        needsOwner ? "View setup" : "Continue setup",
      ),
    );
    return;
  }
  // A console complete by its estate facts alone (set up before this setup page) may have no sealed first
  // backup, so the line claims one only when the step model's First backup is done; otherwise it names
  // what is done (setup) and what is not (no sealed backup yet), never a bare completion claim.
  strip.appendChild(
    h(
      "span",
      { class: "setup-strip__text" },
      view.firstBackupDone ? "Setup complete. Your first backup is sealed." : "Setup finished. No backup has sealed yet.",
    ),
  );
  strip.appendChild(
    h(
      "button",
      { "data-dp": "shell-rail.button.navigate-fn-downpipes", class: "linklike setup-strip__go", type: "button", on: { click: () => internals.navigateFn("/downpipes") } },
      "Open Downpipes",
    ),
  );
  strip.appendChild(
    h(
      "button",
      { "data-dp": "shell-rail.button.render-rail",
        class: "setup-strip__dismiss",
        type: "button",
        "aria-label": "Dismiss the setup strip",
        on: {
          click: () => {
            markSetupCelebrated();
            internals.setup = null;
            renderSetupStrip(internals);
            renderRail(internals);
          },
        },
      },
      "✕",
    ),
  );
}
