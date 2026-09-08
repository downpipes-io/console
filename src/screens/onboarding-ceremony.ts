// First load, onboarding wizard, and the key ceremony (IA screen 10; journey J1).
// The single-track, full-bleed first-run flow that turns a freshly-deployed console
// into a configured, governed, reviewable tenant, and the emotional centre of the
// product: the in-browser key ceremony where the operator watches the no-custody
// promise be true rather than be told it. This is the production realisation of
// the B1 onboarding placeholder (screens/onboarding.ts); it is a
// drop-in replacement at the same route, so the integrator swaps the import in app.ts
// (and this descriptor's route stays "/onboarding/:step", already in app.ts FULL_BLEED).
//
// The five-step onboarding ceremony screen, covering the endpoint shapes and the per-surface honest degrade.
//
// The five steps (flow section 2), each deep-linkable at /onboarding/:step and resumable:
//   1. connect        GET /admin/health (+ the CONSOLE_ORIGIN diagnostic, C2), probed on
//                     entry; the honest sign-in/Access verdict renders as one status line
//                     here (the old verify-access step lapsed: the same verdict lives in
//                     the readiness checklist, the /access verifier and the shell chip)
//   2. ceremony       runKeyCeremony IN THIS BROWSER; the no-custody legend; 5 files;
//                     the printable recovery sheet (public fingerprints only)
//   3. configure      install the ceremony keys to the engine IN THE CONSOLE (no terminal):
//                     collect a one-shot scoped "Edit Cloudflare Workers" token and POST it +
//                     the in-memory material to POST /admin/keys/install (the engine writes its
//                     OWN secrets; the token is never stored), then the bounded GET /admin/status
//                     presence poll confirms; a deeply-collapsed wrangler fallback remains for IaC.
//                     The template alone is enough here: keys install as plain Worker secrets
//                     (engine/src/admin/attach.ts putTagged, one PUT per secret), never a bindings
//                     PATCH, so this step needs no D1 or Secrets Store addition even when the
//                     engine binds one (unlike attaching a new source, or applying an update).
//   4. invite         in-app roles by email (D3, enforced) + the copyable enrolment link
//   5. readiness      a reviewable posture checklist + the first run (POST /trigger)
//
// No-custody invariants honoured (Appendix A, never weakened): the
// break-glass PRIVATE is generated here and only ever offered as the downloaded
// identity.key; there is deliberately NO field, NO command and NO install path that sends
// it to the engine; the signer private + operational pair install to the engine over the
// authenticated same-origin channel (the engine writes them as its OWN secrets via a
// one-shot scoped token that is never stored or logged); the manual-fallback signer value
// is concealed behind a reveal toggle and copyable without revealing; every server-supplied
// string is rendered via textContent / escaped; the recovery sheet carries only PUBLIC
// fingerprints; the console reaches ONLY the in-account engine. The Access verdict reads
// the REAL whoami result and degrades honestly to amber/unknown, never a hardcoded green.
//
// This file is the COORDINATOR: it owns the screen descriptor (route, title, measure,
// actions, render) and re-exports the symbols external callers (the support validator)
// depend on. The reusable leaf helpers and the carousel chrome live in ./onboarding/shared.ts,
// the heavier step renderers in ./onboarding/steps.ts, the live entitlement-probe presentation
// in ./onboarding/preflight.ts, and the rotating card deck in ./onboarding/carousel.ts; the
// file was split for size while keeping the public surface byte-identical. House rules:
// Australian English, no em dashes, precise claims.

import type { Screen, ScreenAction, ScreenContext } from "./common.ts";
import { renderCarousel } from "./onboarding/carousel.ts";

// Re-exports: the support validator imports these honesty-critical preflight mappings from
// this module, so the split keeps its import working unchanged.
export {
  preflightItemPresentation,
  preflightVerdict,
  orderPreflightItems,
} from "./onboarding/preflight.ts";

// ============================================================================
// The screen descriptor (self-owned)
// ============================================================================

// The actions the wizard contributes to the command palette: a single navigation into
// the first-run flow / "re-run setup". Gated to render only when an engine is connected
// (a fresh, unconnected console has no palette anyway, it is on the wizard). The flow is
// re-runnable from Overview / Settings as "Re-run setup", auto-routing to the first
// incomplete step (the router resolves /onboarding/:step; "connect" is the safe entry
// that resumes forward).
const onboardingActions: ScreenAction[] = [
  {
    id: "onboarding.rerun",
    title: "Re-run setup or verify wiring",
    group: "Navigation",
    kind: "navigate",
    keywords: ["onboarding", "setup", "wizard", "ceremony", "wiring", "configure", "first run"],
    target: "/onboarding/connect",
    when: ({ engine }) => engine.connected === true,
  },
];

// The onboarding route PATTERN plus the concrete step-1 home the guided-setup gate and the training walk
// navigate to. Exported together so the walk's route union pins against this screen's own declaration
// (the chapters.ts ROUTE_CHECK pattern) and cannot silently drift from the pattern below.
export const ROUTE_ONBOARDING_PATTERN = "/onboarding/:step";
export const ROUTE_ONBOARDING_CONNECT = "/onboarding/connect";

export const onboardingCeremonyScreen: Screen = {
  // Owns the same route the B1 placeholder did, so this is a true drop-in replacement.
  // It is already in app.ts FULL_BLEED, so the integrator only swaps the import.
  route: ROUTE_ONBOARDING_PATTERN,
  title: "Set up downpipes",
  measure: "full",
  actions: onboardingActions,
  render(ctx: ScreenContext): HTMLElement {
    return renderCarousel(ctx);
  },
};
