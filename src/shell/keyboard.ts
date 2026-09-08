// The shell's keyboard and focus layer: the roving tabindex over
// the rail (one tab stop, arrows move), the Compact slide-over rail (open/close with a
// minimal focus trap that restores focus on close), and the global key layer ("/" opens
// the palette, "?" opens the shortcut cheat sheet, "g <letter>" go-to chords). The shell
// entry (app-shell.ts) wires these once at mount; the rail renderer (rail.ts) re-applies
// the roving tabindex after each rail rebuild.

import { singleKeyShortcutsEnabled } from "../lib/a11y-prefs.ts";
import { isOverlayOpen } from "../components/dialog.ts";
import { goToShortcuts } from "./registry.ts";
import type { ShellInternals } from "./types.ts";

// Width below which the rail becomes a slide-over rather than a persistent strip. Must
// match the @media (max-width: 767px) breakpoint in tokens.css; if the design token
// changes, update both sites.
const BREAKPOINT_COMPACT_PX = 767;
// Window to complete a two-key go-to chord (g <letter>) before it resets.
const CHORD_PENDING_MS = 1200;

// ---- roving tabindex on the rail (one tab stop, arrows move) -----------------

export function wireRovingRail(navEl: HTMLElement, navLinks: Map<string, HTMLAnchorElement>): void {
  const links = [...navLinks.values()];
  links.forEach((l, i) => {
    l.setAttribute("tabindex", i === 0 ? "0" : "-1");
  });

  navEl.addEventListener("keydown", (ev: KeyboardEvent) => {
    // biome-ignore lint/complexity/useIndexOf: indexOf requires HTMLAnchorElement, but document.activeElement is Element | null; findIndex with strict equality keeps the types honest
    const idx = links.findIndex((l) => l === document.activeElement);
    if (idx < 0) return;
    let next = idx;
    if (ev.key === "ArrowDown") next = (idx + 1) % links.length;
    else if (ev.key === "ArrowUp") next = (idx - 1 + links.length) % links.length;
    else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = links.length - 1;
    else return;
    ev.preventDefault();
    links[idx]!.setAttribute("tabindex", "-1");
    const target = links[next]!;
    target.setAttribute("tabindex", "0");
    target.focus();
  });
}

// ---- rail toggle / slide-over (Compact) -------------------------------------

// RailTrapState owns the slide-over rail's focus-return element and active trap
// handler. It is created per wireRailToggle call and threaded into openRail /
// closeRail rather than held at module scope, so the constraint (one trap at a
// time) is explicit and re-wiring the shell starts from a fresh state.
interface RailTrapState {
  focusReturn: HTMLElement | null;
  trapHandler: ((ev: KeyboardEvent) => void) | null;
}

// wireRailToggle owns the slide-over's trap state and returns a closeRail bound to
// it, so the scrim click and the shell's public closeRail() share the one state
// without a module-level variable.
export function wireRailToggle(internals: ShellInternals): () => void {
  const trap: RailTrapState = { focusReturn: null, trapHandler: null };
  internals.railToggle.addEventListener("click", () => {
    const open = internals.shellEl.dataset.rail === "open";
    if (open) closeRail(internals, trap);
    else openRail(internals, trap);
  });
  seedRailToggleAriaExpanded(internals);
  return () => closeRail(internals, trap);
}

// seedRailToggleAriaExpanded sets the toggle's aria-expanded to match the rail's ACTUAL state at mount,
// rather than the "false" the static markup is built with (shell/dom.ts), which is only correct for the
// Compact slide-over (closed at mount). At Compact the drawer always starts closed, so aria-expanded
// stays "false" regardless of data-rail. At wide/medium the rail starts expanded unless data-rail is
// already "collapsed": the same rule openRail's own wide/medium branch uses on every later toggle, so
// this seed and that branch never disagree. A one-time init run once after mount; every later state
// change remains openRail/closeRail's job, untouched here.
function seedRailToggleAriaExpanded(internals: ShellInternals): void {
  const compact = window.matchMedia(`(max-width: ${BREAKPOINT_COMPACT_PX}px)`).matches;
  const expanded = !compact && internals.shellEl.dataset.rail !== "collapsed";
  internals.railToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function openRail(internals: ShellInternals, trap: RailTrapState): void {
  // Only meaningful at Compact, where the rail is a slide-over; at wider widths
  // the rail is always visible and the toggle simply collapses/expands the strip.
  const compact = window.matchMedia(`(max-width: ${BREAKPOINT_COMPACT_PX}px)`).matches;
  if (compact) {
    trap.focusReturn = document.activeElement as HTMLElement;
    internals.shellEl.dataset.rail = "open";
    internals.railToggle.setAttribute("aria-expanded", "true");
    internals.railToggle.setAttribute("aria-label", "Close navigation");
    // Focus the first nav link and trap focus within the rail.
    const firstLink = internals.navEl.querySelector<HTMLElement>(".nav-item");
    firstLink?.focus();
    trapFocus(internals.shellEl.querySelector<HTMLElement>(".rail")!, () => closeRail(internals, trap), trap);
  } else {
    // Wide/medium: toggle the collapsed icon-strip state.
    internals.shellEl.dataset.rail = internals.shellEl.dataset.rail === "collapsed" ? "default" : "collapsed";
    internals.railToggle.setAttribute(
      "aria-expanded",
      internals.shellEl.dataset.rail === "collapsed" ? "false" : "true",
    );
  }
}

export function closeRail(internals: ShellInternals, trap: RailTrapState): void {
  if (internals.shellEl.dataset.rail === "open") {
    internals.shellEl.dataset.rail = "default";
    internals.railToggle.setAttribute("aria-expanded", "false");
    internals.railToggle.setAttribute("aria-label", "Open navigation");
    releaseTrap(trap);
    trap.focusReturn?.focus();
    trap.focusReturn = null;
  }
}

// trapFocus keeps Tab within `container` and closes on Esc. A minimal trap for the
// slide-over rail; the full stack-aware primitive is in components/dialog.ts (trapTab).
function trapFocus(container: HTMLElement, onEsc: () => void, trap: RailTrapState): void {
  releaseTrap(trap);
  trap.trapHandler = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      onEsc();
      return;
    }
    if (ev.key !== "Tab") return;
    const focusables = getFocusable(container);
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    if (ev.shiftKey && active === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", trap.trapHandler, true);
}

function releaseTrap(trap: RailTrapState): void {
  if (trap.trapHandler) {
    document.removeEventListener("keydown", trap.trapHandler, true);
    trap.trapHandler = null;
  }
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

// ---- global keyboard layer --------------------------------------------------

export function wireGlobalKeys(openPalette: () => void, onNavigate: (route: string) => void): void {
  const chords = goToShortcuts(); // [{ chord: "g o", route: "/", title }]
  let pendingG = false;
  let pendingTimer: number | undefined;

  document.addEventListener("keydown", (ev: KeyboardEvent) => {
    // A screen-scoped handler that already claimed this key wins (Runs and Downpipes
    // bind "/" to focus their table filter); the global layer must never steal a
    // handled key on its way up to the document.
    if (ev.defaultPrevented) return;
    // Never hijack keys while the operator is typing in a field or an overlay owns
    // the keyboard. The overlay check is what this comment always promised and the
    // handler never implemented (the filed defect): a modal, drawer, confirm, or the
    // command palette all mount through dialog.ts's one overlay engine, so
    // isOverlayOpen() is a single structural check that covers every dialog shape in
    // the console, not a per-shape enumeration. A pending "g" is also reset so a
    // dialog opened between the "g" and its letter cannot be escaped by completing
    // the chord after the dialog appears.
    if (isTypingTarget(ev.target)) return;
    if (isOverlayOpen()) {
      pendingG = false;
      window.clearTimeout(pendingTimer);
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // The single-key shortcuts can be turned OFF in Settings > Accessibility
    // (WCAG 2.1.4); Cmd/Ctrl-K still opens the palette regardless.
    if (!singleKeyShortcutsEnabled()) return;

    // "/" OPENS the palette, exactly like Cmd/Ctrl-K (the trigger's visible kbd "/"
    // hint promises search-on-slash; merely focusing the trigger ate the characters
    // typed straight after it into the global key layer).
    if (ev.key === "/" && !pendingG) {
      ev.preventDefault();
      openPalette();
      return;
    }

    // "?" opens the shortcut cheat sheet (the command-palette landing renders it), so
    // the key every keyboard-first product binds to "show me the shortcuts" does
    // something here too. Shift is naturally held for "?" and is not in the modifier
    // guard above, so this fires; a typing target was already excluded.
    if (ev.key === "?" && !pendingG) {
      ev.preventDefault();
      onNavigate("/command-palette");
      return;
    }

    // "g" then a letter jumps (go-to). The chord map comes from the registry.
    if (ev.key === "g" && !pendingG) {
      pendingG = true;
      window.clearTimeout(pendingTimer);
      pendingTimer = window.setTimeout(() => { pendingG = false; }, CHORD_PENDING_MS);
      return;
    }
    if (pendingG) {
      pendingG = false;
      window.clearTimeout(pendingTimer);
      const chord = `g ${ev.key.toLowerCase()}`;
      const match = chords.find((c) => c.chord === chord);
      if (match) {
        ev.preventDefault();
        onNavigate(match.route);
      }
    }
  });
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}
