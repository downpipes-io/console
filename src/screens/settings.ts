// Settings (IA screen 8): engine connection (custom domain only, with the
// CONSOLE_ORIGIN diagnostic), appearance (System / Light / Dark, the three-way
// theme control), data-residency transparency, the supportability tools (the signed
// support bundle, the email-delivery test, the platform-issued pull credentials),
// and the controlled offboarding flow. Stale/failure alert routing lives on the
// Notifications screen (a channel plus a rule); this screen only points at it. None of the engine's
// secrets are written here; the console cannot deprovision the IdP, so offboarding
// guides that step and removes the in-app role. The ONE secret that ever
// appears on this screen is a freshly MINTED support credential, which the engine
// returns exactly once: it is shown once behind a conceal/reveal field, copyable
// without revealing, never persisted anywhere by the console.
//
// This file is the COORDINATOR: it owns the screen descriptor (route, title, measure, actions, render) and
// re-exports the symbols external callers (the supportability validator) depend on. The supportability tools
// (bundle, email test, pull credentials) and their pure presentation helpers live in ./settings/support.ts;
// the appearance + accessibility sections in ./settings/appearance.ts; the connection, residency, hand-off,
// offboarding and demo sections in ./settings/sections.ts. The file was split for size while keeping the
// public surface byte-identical.

import { h } from "../lib/dom.ts";
import { pageHeader, screenScaffold, lazyDisclosure, requireEngine, type Screen } from "./common.ts";
import { renderConnection, renderResidency, renderBackupConfigPointers, renderAccessControlPointers, renderOffboarding, renderDemoSection } from "./settings/sections.ts";
import { renderAppearance, renderAccessibility } from "./settings/appearance.ts";
import { renderSupportBundle, renderEmailDelivery, renderPullCredentials } from "./settings/support.ts";

// Re-exports: the supportability validator (test/validate-support.ts) imports the pure presentation helpers
// BY NAME from this module, so the split keeps every one of those imports working unchanged. They live in the
// ./settings/support.ts module (all pure + DOM-free); re-exporting them here keeps the public import surface
// of screens/settings.ts byte-identical.
export { vendorSealPresentation, supportGrantPresentation, latestPullAt, supportBundleFileName, emailTestVerdict, accessPerimeterNote, metricsEndpointNote, downloadJsonText } from "./settings/support.ts";

// Re-exports: the push validator (test/validate-push.ts) imports these pure presentation helpers BY NAME
// from this module, mirroring the support re-export above. They live in ./settings/push-model.ts (all pure +
// DOM-free, split from the push panel's DOM); re-exporting them here keeps the public import surface stable.
export {
  pushFormatLabel,
  pushSinkLabel,
  pushDialsOutNote,
  validatePushEndpoint,
  validatePushFormatSink,
  validateSyslogHost,
  validateSyslogPort,
  parseSyslogPort,
  buildPushInputFields,
  buildPushSubmission,
  buildToggleSubmission,
  canTogglePush,
  pushDestinationTargetLabel,
  pushDestinationDetailLine,
  pushStatePresentation,
  pushLagPresentation,
  pushAttemptLine,
  pushFailReasonCopy,
  pushTrailLines,
  pushTrailSummary,
  pushTestOutcomeCopy,
  PUSH_TOGGLE_UNRECONSTRUCTABLE,
} from "./settings/push-model.ts";

// Re-exports: the OTLP push validator (test/validate-otlp-push.ts) imports these pure presentation
// helpers BY NAME from this module, mirroring the push re-export above. They live in
// ./settings/otlp-push-model.ts (all pure + DOM-free, split from the panel's DOM); re-exporting them
// here keeps the public import surface stable.
export {
  OTLP_TOGGLE_UNRECONSTRUCTABLE,
  validateOtlpPushEndpoint,
  otlpPushDialsOutNote,
  buildOtlpPushInputFields,
  buildOtlpPushSubmission,
  buildOtlpToggleSubmission,
  otlpPushStatePresentation,
  otlpPushDetailLine,
  otlpAttemptLine,
  otlpTrailLines,
  otlpTrailSummary,
} from "./settings/otlp-push-model.ts";

export const settingsScreen: Screen = {
  route: "/settings",
  title: "Settings",
  measure: "prose",
  actions: [
    // These IDs match the COMMANDS baseline in shell/registry.ts. reconcileRegistry
    // puts COMMANDS first, so these are deduped away if the baseline already carries
    // them. They are declared here so this screen self-documents the actions it owns,
    // and so the palette is fed from screen descriptors when the baseline is trimmed.
    {
      id: "sign-out",
      title: "Sign out",
      group: "Actions",
      kind: "action",
      keywords: ["sign out", "log out", "clear", "session"],
      target: "auth.sign-out",
    },
    {
      id: "toggle-theme",
      title: "Toggle theme",
      group: "Actions",
      kind: "action",
      keywords: ["theme", "dark", "light", "appearance", "settings"],
      target: "theme.toggle",
    },
    {
      // Alert routing is owned by the Notifications screen (channels + rules); this
      // entry is an honest navigation there, not an action hosted here.
      id: "configure-alert-webhook",
      title: "Configure stale and failure alerts",
      group: "Navigation",
      kind: "navigate",
      keywords: ["webhook", "alert", "sre", "slack", "pagerduty", "siem", "stale", "failure", "notification", "channel"],
      target: "/notifications",
      when: (ctx) => ctx.engine.connected === true,
    },
    {
      // Dual control (four-eyes) is owned by the Security Centre; this is a deep
      // link straight to the toggle (opens and scrolls to it) so the palette finds it by
      // the names owners search for, not just "security centre".
      id: "configure-dual-control",
      title: "Dual control (four-eyes)",
      group: "Navigation",
      kind: "navigate",
      keywords: ["dual control", "four eyes", "four-eyes", "approval", "config change approval", "maker checker", "second approver", "security"],
      target: "/security?open=dual-control",
      when: (ctx) => ctx.engine.connected === true,
    },
  ],
  render() {
    const engine = requireEngine();
    if (!engine) return h("div");

    // The question this screen answers: "is the console
    // correctly connected, and how do I change a setting?" Eager: the live
    // connection verdict and appearance, the two everyone touches. Everything
    // else mounts inside collapsed disclosures on first open, one tool per
    // disclosure, so each opens to exactly one job and fetches nothing it
    // does not show.
    return screenScaffold(
      pageHeader("Settings", "Engine connection, appearance, data residency and offboarding. The console writes none of the engine's secrets."),
      renderConnection(engine),
      renderAppearance(),
      renderBackupConfigPointers(engine),
      renderAccessControlPointers(),
      h(
        "div",
        { class: "stack-sm measure" },
        lazyDisclosure("Accessibility", () => renderAccessibility()),
        lazyDisclosure("Data and residency", () => renderResidency(engine)),
        lazyDisclosure("Support bundle", () => renderSupportBundle(engine)),
        lazyDisclosure("Email delivery", () => renderEmailDelivery(engine)),
        // The SIEM audit-log push, the OTLP metrics push and the SIEM/metrics PULL credentials now live on the
        // Integrations screen (one vendor-locked place to connect a destination). What remains here is the
        // DIAGNOSTICS credential, which is a support-access concern, not an integration: a read-only feed for
        // Maelstrom support, so it keeps its home in Settings.
        lazyDisclosure("Diagnostics access credential", () => renderPullCredentials(engine, "diagnostics")),
        // No danger tone: the body is guidance plus a role hand-off and a plain sign out,
        // nothing destructive, so the red summary was a false alarm.
        lazyDisclosure("Offboarding and sign out", () => renderOffboarding()),
      ),
      // Demo-only: renders nothing unless the engine reports demoMode (a throwaway demo deployment).
      renderDemoSection(engine),
    );
  },
};
