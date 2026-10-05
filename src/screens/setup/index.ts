// The first-run setup surface (/setup, /setup/:step, /setup/:step/:sub). This module owns the screen
// DESCRIPTOR: the routes, the title, the full-bleed measure and the palette action. The step logic lives in
// the headless model at lib/setup-flow/ (README.md there is the API), and the look lives in b/ (Focus Flow:
// one question at a time, with "Your backup plan" beside it).
//
// The routes are registered from this descriptor (lib/app-registry.ts SCREENS), they are full bleed
// (FULL_BLEED), always reachable during setup (lib/setup-state.ts ALWAYS_ALLOWED), and they keep in-memory
// key material alive while the user moves between questions (CEREMONY_PATTERNS).

import type { ScreenAction } from "../common.ts";
import { defineScreen } from "../common.ts";
import { setupIncomplete } from "../../lib/setup-state.ts";
import { renderFocusFlow } from "./b/page.ts";

// The setup entry, exported so the tour's route vocabulary pins against this screen's own declaration.
export const ROUTE_SETUP = "/setup";

// The palette's way back into an unfinished setup. It shows only while the shell has read the setup facts
// and a numbered step is unfinished (lib/setup-state.ts setupIncomplete); once setup is complete there is
// nothing to continue, and the ordinary screens own every setting.
const setupActions: ScreenAction[] = [
  {
    id: "setup.continue",
    title: "Continue setup",
    group: "Navigation",
    kind: "navigate",
    keywords: ["setup", "first run", "onboarding", "get started", "keys", "destination", "connect", "first backup"],
    target: ROUTE_SETUP,
    when: ({ engine }) => engine.connected === true && setupIncomplete(),
  },
  // The engine's own wiring report after setup: the keys it holds and every preflight probe it has observed
  // (the read-only "What your engine reports" view, lib/setup-flow/actions-apply.ts readEngineChecks). It
  // replaces the retired deck's "Re-run setup or verify wiring". While setup is unfinished, setup itself reads
  // the same report at Apply, so the palette offers "Continue setup" instead.
  {
    id: "setup.check-wiring",
    title: "Check engine wiring",
    // Navigation, beside "Continue setup": it opens a view. The palette lists Navigation first, so a search for
    // "wiring" does not put a looser keyword match from another group ahead of it.
    group: "Navigation",
    kind: "navigate",
    keywords: ["wiring", "preflight", "engine check", "verify wiring", "prerequisites", "bindings", "setup"],
    target: `${ROUTE_SETUP}/finish/check`,
    when: ({ engine }) => engine.connected === true && !setupIncomplete(),
  },
];

export const setupScreen = defineScreen({
  route: ["/setup", "/setup/:step", "/setup/:step/:sub"],
  title: "Set up",
  measure: "full",
  render: renderFocusFlow,
  actions: setupActions,
});
