// THE NEW DOWNPIPE WIZARD'S RESTORE-TEST PROMISE MUST MATCH THE ACCOUNT'S OWN KEY CUSTODY.
//
// The name step always said "A weekly scheduled restore test is also configured.", whatever the account's
// key posture. Under a strict break-glass-only posture (status.operationalConfigured.private === false)
// the engine keeps no operational read-back key in-account, so it cannot run that test unattended: the
// wizard was promising a thing the engine cannot do. This drives the real wizard to its name step under
// both postures and reads the hint text an operator actually sees.
//
// Run: node test/validate-wizard-restore-test-posture.ts

import { flushAsync, installDomShim, textOf } from "./dom-shim.ts";
import { makeEvent } from "./dom-shim-core.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

const { EngineClient } = await import("../src/api.ts");
const { openCreateWizard } = await import("../src/screens/sources-downpipes/editor-wizard.ts");
type StatusReport = import("../src/api.ts").StatusReport;

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const OPERATIONAL: StatusReport = {
  service: "engine", engineVersion: "test", signerConfigured: true, breakGlassConfigured: true,
  operationalConfigured: { public: true, private: true }, configKeysConfigured: { recipient: true, wrapKey: true }, destConfigured: true, destKind: "r2",
  updateChannelConfigured: false, licenceConfigured: true, downpipeCount: 0, ready: true,
};
const STRICT_CUSTODY: StatusReport = { ...OPERATIONAL, operationalConfigured: { public: false, private: false } };

// An operational key left bound beside the OPERATIONAL_RETIRED marker (a strict re-key that did not
// remove the pair): present, but not usable. The engine opens no run with it, so the wizard must read this
// the same as STRICT_CUSTODY, not as OPERATIONAL.
const RETIRED_HELD: StatusReport = { ...OPERATIONAL, operationalRetired: true };

// openToNameStep opens the real wizard over a stubbed engine (one bound KV source, a configured
// destination, no existing downpipes), ticks that source, and clicks Continue once to reach the name step
// (the step whose hint carries the restore-test promise). It returns the full body text so the hint text
// can be read as an operator would see it.
async function openToNameStep(status: StatusReport): Promise<string> {
  (document.body as unknown as { replaceChildren: () => void }).replaceChildren();
  const engine = new EngineClient("https://engine.test");
  const stub = engine as unknown as Record<string, unknown>;
  stub.discoverSources = async () => ({ bound: { kv: ["KV_uploads"], r2: [], d1: [], secrets: [] }, tokenPresent: false });
  stub.listDestinations = async () => ({ destinations: [{ id: "d1", label: "Primary" }], defaultId: "d1" });
  stub.getDestination = async () => ({ present: true, source: "console", bucket: "archive", endpointHost: "r2.example" });
  stub.listDownpipes = async () => [];
  openCreateWizard(engine, status, new Set<string>(), () => {}, () => {});
  await flushAsync(20);

  const checkbox = (document.body as unknown as { querySelectorAll: (s: string) => Array<{ getAttribute: (n: string) => string | null; checked: boolean; dispatchEvent: (e: unknown) => boolean }> })
    .querySelectorAll("input")
    .find((box) => box.getAttribute("type") === "checkbox");
  if (!checkbox) throw new Error("KV source checkbox not found");
  checkbox.checked = true;
  checkbox.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
  await flushAsync(10);

  const continueBtn = (document.body as unknown as { querySelectorAll: (s: string) => Array<{ textContent: string; click?: () => void }> })
    .querySelectorAll("button")
    .find((b) => /^Continue/.test(b.textContent));
  if (!continueBtn?.click) throw new Error("Continue button not found");
  continueBtn.click();
  await flushAsync(20);

  return textOf(document.body as never);
}

async function main(): Promise<void> {
  console.log("\n-- the wizard's restore-test promise matches the account's key custody --");

  const operationalText = await openToNameStep(OPERATIONAL);
  ok("with an operational key, the wizard promises the scheduled test", operationalText.includes("A weekly scheduled restore test is also configured."));
  ok("with an operational key, the wizard does not raise strict custody", !operationalText.includes("break-glass-only key posture"));

  const strictText = await openToNameStep(STRICT_CUSTODY);
  ok("under strict break-glass-only custody, the wizard does not promise a scheduled test", !strictText.includes("A weekly scheduled restore test is also configured."));
  ok("under strict break-glass-only custody, the wizard states the engine cannot self-test", strictText.includes("The engine cannot self-test in a break-glass-only key posture."));
  ok("under strict break-glass-only custody, the wizard names attended verification instead", strictText.includes("Prove recoverability with attended verification."));

  const retiredText = await openToNameStep(RETIRED_HELD);
  ok("with the operational key retired but still bound, the wizard does not promise a scheduled test", !retiredText.includes("A weekly scheduled restore test is also configured."));
  ok("with the operational key retired but still bound, the wizard states the engine cannot self-test", retiredText.includes("The engine cannot self-test in a break-glass-only key posture."));

  console.log(`\n${failures === 0 ? "WIZARD-RESTORE-TEST-POSTURE OK" : `${failures} FAILURE(S)`}`);
  verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
