// The shell's internal state shape, shared by the shell entry (app-shell.ts) and its
// chrome siblings (rail.ts, keyboard.ts) so each can type the live handle it mutates
// without importing the entry (which would form a cycle). The PUBLIC shell contract
// (the Shell interface main.ts / the router consume) lives with mountShell in
// app-shell.ts; this module carries the private internals only.

import type { Caller } from "../api.ts";
import type { SetupView } from "../lib/setup-state.ts";

// ShellInternals is the mutable handle the shell entry threads through its chrome
// helpers: the live DOM references, the curated-rail state, the active route, the
// navigate callback, the guided-setup view and the per-route attention counts. It is an
// implementation detail of the shell, never exposed to callers.
export interface ShellInternals {
  navLinks: Map<string, HTMLAnchorElement>;
  mainRegion: HTMLElement;
  engineChip: HTMLElement;
  accountSlot: HTMLElement;
  shellEl: HTMLElement;
  railToggle: HTMLButtonElement;
  navEl: HTMLElement;
  railFooter: HTMLElement;
  scrim: HTMLElement;
  // The current resolved caller + show-all escape-hatch state the rail is curated against, so a
  // re-render (on a caller change or an escape-hatch toggle) reproduces the same shaping.
  caller: Caller | null;
  showAll: boolean;
  // The active route pattern last reported by the router, re-applied after a rail rebuild so the
  // freshly-built links carry aria-current="page" correctly.
  activePattern: string;
  navigateFn: (route: string) => void;
  // The guided-setup view the strip + rail gating render from (null = no gating).
  setup: SetupView | null;
  setupStrip: HTMLElement;
  // Route -> "needs attention" count, surfaced as a quiet chip on the matching rail link (only
  // /credentials today). A count > 0 renders the chip; an absent/0 entry renders none. Re-applied on
  // every rail rebuild (a caller/setup change) so the chip survives a re-render, and refreshed in
  // place by setNavCount when the status read lands.
  navCounts: Map<string, number>;
}
