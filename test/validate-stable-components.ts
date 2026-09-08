// Coverage on the STABLE, shared (non-screen-specific) components and the pure preference libs.
// These surfaces are low-churn (the design-system primitives + the localStorage preference helpers)
// and were under-tested: most were at 30-65% statements with their main functions never entered.
// This validator RENDERS the REAL components under the shared DOM shim (test/dom-shim.ts, the same
// hand-rolled approach proven in validate-api / validate-passkey-login) and drives their behaviour,
// so the assertions exercise production code paths rather than re-implementing them.
//
// Run with: node test/validate-stable-components.ts
//
// This file is a THIN orchestrator. The suite was split into cohesive sibling groups, each
// exporting a run function; this file installs the shim once, loads the real components, then
// imports and CALLS each group in the original order so the full suite still runs end to end:
//   validate-stable-components-prefs.ts     sections 2 / 2b (lib/theme + lib/aurora-pref)
//   validate-stable-components-table.ts     section 3 (components/table)
//   validate-stable-components-overlays.ts  sections 4 / 5 / 6 (dialog + drawer + detail-drawer)
//   validate-stable-components-dialogs.ts   sections 7 / 8 (confirm + modal)
//   validate-stable-components-display.ts   sections 9 / 10 / 11 / 12 (code-block + sparkline +
//                                           wizard + error-view)
// The shared harness, the node helpers, and the component loader live in
// validate-stable-components-shared.ts so a single failure count spans the whole suite.
//
// Surfaces covered (and the contract each section asserts):
//   lib/theme.ts           initTheme/get/set/subscribe; data-theme attribute writes; system clears it.
//   lib/aurora-pref.ts     default OFF; on/off round-trip; data-aurora attribute; blocked-storage fallback.
//   components/table.ts    header scope, numeric alignment, empty slot, row activation (click+keys),
//                          inner-control click is NOT treated as a row activation.
//   components/dialog.ts   the overlay engine: mount, background inert, focus-in, Esc + click-out
//                          dismiss, nested stack inert, closeAllOverlays (no onClose), dialogSurface ARIA.
//   components/drawer.ts   openDrawer composes the engine; drawerSection heading order.
//   components/detail-drawer.ts  subhead, danger-grouped
//                          footer; disabled action carries reason and no click handler; kvRow text-safety.
//   components/confirm.ts  type-to-confirm gating: Apply disabled until the exact match; Cancel focus;
//                          resolves true only on a matching Apply, false on Cancel/Esc.
//   components/modal.ts    openModal/confirmModal; danger focuses Cancel; onClick:false keeps it open;
//                          a rejected onClick keeps it open and surfaces a warn toast.
//   components/code-block.ts  codeBlock literal content + copy; keyField CONCEALMENT (fixed-length dot
//                          run, never the value or its real length) yet copies the REAL value.
//   components/sparkline.ts  sparkline (multi/single/empty point geometry) + miniBars + the derived
//                          text-alternative phrase; every chart carries a role=img aria-label + caption.
//   components/wizard.ts   stepper status by SHAPE (tick/number/lock) + accessible status word;
//                          a done step is a real button (revisitable); a blocked step is disabled.
//   components/error-view.ts  blockError describe() across every ErrorKind branch (incl. the
//                          health-gated console-origin promotion) + Retry; inlineOutcome reassurance.
//
// No-custody hygiene asserted: keyField never renders the secret or its real length; copy still
// copies the real bytes (concealment by construction). The shim's clipboard is a local recorder;
// nothing is logged.

import { installDomShim } from "./dom-shim.ts";

// Install BEFORE importing any module that touches document at load time.
installDomShim();

import { Harness, loadComponents } from "./validate-stable-components-shared.ts";
import { runPrefs } from "./validate-stable-components-prefs.ts";
import { runTable } from "./validate-stable-components-table.ts";
import { runDataTable } from "./validate-stable-components-data-table.ts";
import { runOverlays } from "./validate-stable-components-overlays.ts";
import { runDialogs } from "./validate-stable-components-dialogs.ts";
import { runDisplay } from "./validate-stable-components-display.ts";

async function main(): Promise<void> {
  const h = new Harness();
  // Load the real components AFTER the shim is installed (dynamic import inside the loader so
  // the static-import hoisting cannot run a module that touches document before the shim exists).
  const ctx = await loadComponents();

  // (The former section 1, lib/map-view-pref.ts, was retired with the map's SVG/WebGL toggle:
  // the live-flow view is now the map's one renderer, so there is no preference to persist.)

  // Sections 2 / 2b: the pure preference libs (theme + aurora). This group loads the libs
  // itself (after the shim is installed) rather than from ctx.
  await runPrefs(h);

  // Section 3: the table component.
  runTable(h, ctx);

  // Section 3b: the configurable data-table component's DOM behaviour (filter, sort,
  // roving keys, select-all tri-state).
  runDataTable(h, ctx);

  // Sections 4 / 5 / 6: the overlay family (dialog engine + drawer + detail-drawer).
  await runOverlays(h, ctx);

  // Sections 7 / 8: the confirm + modal dialogs.
  await runDialogs(h, ctx);

  // Sections 9 / 10 / 11 / 12: the display primitives (code-block + sparkline + wizard + error-view).
  await runDisplay(h, ctx);

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(h.failures === 0 ? "\nSTABLE-COMPONENT VECTORS PASS" : `\n${h.failures} FAILURE(S)`);
  // Driving the real overlays / toasts schedules production timers (toast auto-dismiss, the
  // copy flash) that legitimately outlive the assertions; exit deterministically so a late
  // tick can never flip a green run.
  if (h.failures > 0) process.exitCode = 1;
  process.exit(h.failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nVALIDATE-STABLE-COMPONENTS THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
