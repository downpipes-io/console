// Command palette + keyboard layer. This is the keyboard spine of the
// console and the single combobox surface that turns the one action registry into a
// fast, role-gated, fuzzy command line.
//
// The palette is fed by the SINGLE action registry (shell/registry.ts COMMANDS +
// every screen's own ScreenAction list via allScreenActions): the same source of
// truth as the go-to chords, the "?" cheat-sheet and any row menus, so RBAC and
// discoverability never drift. Every command is gated by the caller's role (from
// whoami, D1) AND by engine state through its `when`; a command the role cannot run
// is never listed, so the palette never offers an action that 403s (the mirror of the
// engine's per-route minimum; the engine is the enforcement point, this is UX).
//
// Dangerous commands (kind:"flow": Start restore, Delete downpipe, Rotate keys) open
// the safe review-then-confirm flow on their owning screen; they NEVER execute from
// the palette. Benign commands (kind:"action": toggle theme, copy engine URL, open
// recovery sheet) run inline via the dispatcher the integrator wires.
//
// No-custody honoured: the async entity source reads only downpipe NAMES and run IDs
// (already non-secret, in-account) and renders every server-supplied string with
// textContent (lib/dom.ts is textContent-first); the palette shows no secret, no
// fingerprint, no value, and reaches only the connected in-account engine.
//
// This file is the COORDINATOR: it owns the screen descriptor (route, title, measure,
// actions, render) and re-exports the symbols external callers (app.ts, the palette and
// palette-search validators) depend on. The overlay surface, the open singleton and the
// wired registry live in ./command-palette/overlay.ts; the in-page route landing and the
// "?" cheat-sheet in ./command-palette/landing.ts; the DOM-free entity search engine in
// ./command-palette/entities.ts; the command-running and route maps in
// ./command-palette/routing.ts; and the cross-cutting types, this screen's own actions,
// the keycap renderer and the fuzzy matcher in ./command-palette/shared.ts. The file was
// split for size while keeping the public surface byte-identical. House rules: Australian
// English, no em dashes, precise claims.

import type { Screen, ScreenContext } from "./common.ts";
import { paletteActions } from "./command-palette/shared.ts";
import { renderLanding } from "./command-palette/landing.ts";

// Re-exports: external callers import these by name from this module, so the split keeps
// their imports working unchanged.
//   - app.ts imports openCommandPalette, defaultDispatch and setPaletteRegistry.
//   - validate-palette.ts imports actionRoute.
//   - validate-palette-search.ts imports resolveEntityGroups, entityProviderEnabled and
//     the EntityData type.
// resolveEntityGroups, entityProviderEnabled and actionRoute are the PURE, DOM-free
// surfaces the validators run in Node without a DOM; they live in leaf modules that
// execute no DOM call at import time, so importing this coordinator still resolves them
// in Node exactly as before.
export { openCommandPalette, setPaletteRegistry } from "./command-palette/overlay.ts";
export { defaultDispatch, actionRoute } from "./command-palette/routing.ts";
export {
  resolveEntityGroups,
  entityProviderEnabled,
  type EntityData,
} from "./command-palette/entities.ts";
export type {
  PaletteDispatch,
  OpenPaletteOptions,
} from "./command-palette/shared.ts";

// ---------------------------------------------------------------------------
// The screen descriptor (self-owned; the integrator wires route + actions).
// ---------------------------------------------------------------------------
//
// The palette is primarily an overlay summoned with Cmd/Ctrl-K from anywhere, but it
// also owns a real route (/command-palette) so it is deep-linkable and the keyboard
// help is reachable as a page (consistent-help, WCAG 3.2.6). Visiting the route opens
// the overlay over a light in-page landing that also documents the keyboard layer
// (the "?" cheat-sheet), so the surface degrades to a readable page if the overlay is
// dismissed. The actions it contributes feed the one registry via allScreenActions.

export const commandPaletteScreen: Screen = {
  route: "/command-palette",
  title: "Command palette",
  measure: "prose",
  // The palette contributes the keyboard-layer commands to the shared registry. These
  // are benign (kind "action"/"navigate"); the dangerous flows are owned by their own
  // screens. "open-command-palette" and "show-shortcuts" are always available (every
  // role); they gate nothing because opening the palette reveals only what the role
  // may run.
  actions: paletteActions(),
  render(ctx: ScreenContext): HTMLElement {
    return renderLanding(ctx);
  },
};
