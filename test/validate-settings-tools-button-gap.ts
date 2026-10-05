// The Settings "Backup configuration" section's two tool buttons ("Download config export" and
// "Recover an estate from a signed export", settings/sections.ts renderBackupConfigPointers) rendered as
// bare adjacent siblings with no space between them, so they touched with a 0px gap. This pins the
// structural cause in Node (no real box model under a DOM shim): the two buttons share a row container
// that declares a real gap, the way every other button row in Settings does (push.ts, otlp-push.ts).
// Run with: node test/validate-settings-tools-button-gap.ts

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { renderBackupConfigPointers } from "../src/screens/settings/sections.ts";
import type { EngineClient } from "../src/api.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
let checks = 0;

function ok(label: string, cond: boolean): void {
  checks += 1;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures += 1;
}

const engineStub = {} as unknown as EngineClient; // the two buttons only touch it on click; render never does
const section = renderBackupConfigPointers(engineStub) as unknown as HTMLElement;

const dlBtn = section.querySelector('[data-dp="settings.button.backup-config-pointers"]');
const importBtn = section.querySelector('[data-dp="settings.button.import"]');
ok("the download-export button renders", dlBtn !== null);
ok("the recover-estate button renders", importBtn !== null);

const sameParent = dlBtn !== null && importBtn !== null && dlBtn.parentNode === importBtn.parentNode;
ok("the two buttons share one row container", sameParent);

const rowGap = sameParent ? ((dlBtn!.parentNode as HTMLElement).style.getPropertyValue("gap") || "") : "";
ok(`the shared row declares a real gap ("${rowGap}"), not the 0px touch the two buttons had with no wrapper`, rowGap !== "" && rowGap !== "0" && rowGap !== "0px");

verdictReached(failures, checks);
console.log(`validate-settings-tools-button-gap: ${checks} checks, ${failures} failures`);
if (failures > 0) {
  console.error(`validate-settings-tools-button-gap: ${failures} FAILURES`);
  process.exit(1);
}
