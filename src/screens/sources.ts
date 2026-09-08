// Sources: the catalogue of everything the engine can see, promoted from a drawer
// inside Downpipes to a first-class screen (the IA reorganisation, owner feedback
// : Destinations, Sources, Downpipes in that order; nothing hand-typed).
//
// ONE question: what in your Cloudflare account is protected, and what is not yet?
// The screen answers it in three honest tiers (protected; attached but not yet
// protected; everything across your accounts via a read-only token); until the token
// is set and nothing is bound, the screen IS the connect form.
//
// This file is the COORDINATOR: it owns the screen DESCRIPTOR (route, title, measure,
// actions, render) and the actions it contributes, and re-exports the one per-section
// helper external callers depend on (attachTokenHelp, the deploy-token modal the Keys
// screen, the by-id add-source screen and the onboarding configure step reuse). The
// screen body and the three-tier render live in ./sources/view.ts; the shared leaf
// (glyphs, the selectable list, the small string helpers) in ./sources/shared.ts; the
// token forms in ./sources/token-entry.ts and ./sources/token-help.ts; the add-source
// wizard in ./sources/add-source.ts; the on-engine tiers in ./sources/tiers.ts; and the
// account catalogue in ./sources/account.ts. The file was split for size while keeping
// the public surface byte-identical.
//
// Invariants kept: server strings enter the DOM via textContent only; the token is sent
// once over the authenticated same-origin channel and never persisted client-side; RBAC
// is mirrored (Owner sets the token; Operator+ creates), the engine enforces. Australian
// English, no em dashes, precise claims.

import { h } from "../lib/dom.ts";
import { requireEngine, type Screen, type ScreenAction } from "./common.ts";
import type { EngineClient } from "../api.ts";
import { renderSources } from "./sources/view.ts";

// Re-export: external callers import attachTokenHelp from this module (the Keys screen,
// the by-id add-source screen, the onboarding configure step), so the split keeps their
// imports working unchanged.
export { attachTokenHelp } from "./sources/token-help.ts";

// This screen's own route, exported so an outside caller (the guided tour's chapter vocabulary;
// chapters.ts) references the same literal this descriptor uses, rather than a copy.
export const ROUTE_SOURCES = "/sources";

export const sourcesScreen: Screen = {
  route: ROUTE_SOURCES,
  title: "Sources",
  measure: "wide",
  actions: screenActions(),
  render() {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root;
    const eng: EngineClient = engine;
    return renderSources(eng);
  },
};

function screenActions(): ScreenAction[] {
  return [
    // One palette row per destination: the connect-account keywords fold into the
    // navigation command (both rows navigated to the identical route).
    {
      id: "go-sources",
      title: "Go to Sources",
      group: "Navigation",
      kind: "navigate",
      keywords: ["sources", "catalogue", "discover", "kv", "r2", "d1", "secrets", "token", "accounts", "connect", "account", "api token", "browse"],
      target: "/sources",
    },
  ];
}
