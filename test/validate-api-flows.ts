// validate-api: the DOM-driven screen flows coordinator (REAL CODE).
//
// This installs the shared DOM shim ONCE, imports the store/nav bridge and the screens
// AFTER the shim is in place (so the static-import hoisting cannot run before the shim
// exists), then runs the two flow groups in order:
//   validate-api-flows-restore.ts     sections 6 / 6B (restore-flow screen)
//   validate-api-flows-onboarding.ts  section 7 (onboarding-ceremony screen)
//
// Both groups drive the REAL screens, never a copy of their logic; they share the store /
// nav handles this coordinator imports so the modules load exactly once.

import { type Harness, installDomShim } from "./validate-api-shared.ts";
import { runRestoreFlows } from "./validate-api-flows-restore.ts";
import { runOnboardingFlows } from "./validate-api-flows-onboarding.ts";

export async function runFlows(h: Harness): Promise<void> {
  // A minimal DOM + window shim, installed on globalThis BEFORE the screen modules are
  // dynamically imported. The screen graph touches the DOM only at render time (no
  // top-level DOM), so installing the shim here and importing afterwards is sufficient
  // to run the real h()/field()/svgIcon()/toast() code without a browser.
  installDomShim();

  // Import the real modules AFTER the shim is installed (dynamic import so the static
  // import hoisting does not run this before the shim exists). api.ts is already loaded;
  // these add the store/nav bridge and the screen itself.
  const store = await import("../src/lib/store.ts");
  const nav = await import("../src/lib/nav.ts");
  const { restoreFlowScreen } = await import("../src/screens/restore-flow.ts");

  // Sections 6 / 6B: the restore-flow screen (blast-radius cues + restorability blind test).
  await runRestoreFlows(h, store, nav, restoreFlowScreen);

  // Section 7: the onboarding-ceremony screen (audit-intent + invite/setRole writes).
  await runOnboardingFlows(h, store, nav);
}
