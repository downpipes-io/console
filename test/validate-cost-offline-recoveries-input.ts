// TC-cost-offline-recoveries-input: the Costs screen must offer an input for offline recoveries per
// month, and a value typed into it must reach the model and move the projected egress.
// Run with: node test/validate-cost-offline-recoveries-input.ts
//
// WHY THIS EXISTS. src/lib/cost-model-estimate.ts prices an offline recovery as a download of the
// whole recoverable archive (offlineEgressGB = offlineRecoveriesPerMonth x offlineArchiveGB). Until
// this test, nothing outside src/lib/cost-model-rates.ts wrote offlineRecoveriesPerMonth, which
// defaults to 0, and no screen had an input for it. So the projection could never include
// offline-recovery egress, even on Amazon S3, which bills egress. This test renders the REAL inputs
// section, types into the control the way an operator would, and grades the model's egress figure
// with the value the screen patched in. It fails if the control is missing, if it is not wired to
// offlineRecoveriesPerMonth, or if it stops following the sibling inputs' validation idiom.

import { installDomShim, qs } from "./dom-shim.ts";
installDomShim();
const { makeEvent } = await import("./dom-shim-core.ts");

import { PRESETS, monthlyCost, withDefaults, type Inputs } from "../src/lib/cost-model.ts";
import { buildInputsSection, type CostInputsHost } from "../src/screens/costs/inputs-section.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean, measured?: string): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${!cond && measured ? `\n         measured: ${measured}` : ""}`);
  if (!cond) failures++;
}

console.log("TC-cost-offline-recoveries-input: offline recoveries per month reach the egress figure");

// A host that routes patchActive through withDefaults, the same clamp the real CostView applies.
let active: Inputs = withDefaults({ sourceBytes: 100e9, dedupRatio: 0.5, churnFraction: 0.05, runsPerMonth: 30, retentionRuns: 10 });
const host: CostInputsHost = {
  activeInputs: () => active,
  setActiveInputs: (next) => {
    active = next;
  },
  patchActive: (patch) => {
    active = withDefaults({ ...active, ...patch });
  },
  cadenceBasisText: () => null,
  renderShell: () => {},
  announce: () => {},
};

const s3 = PRESETS["s3-standard"];
const egressAt = (i: Inputs): number => monthlyCost(i, s3, { regime: "retained", month: 6 }).egress;

// ---- 1. The default is 0, so the default projection has no offline-recovery egress. -------------
ok("the model default for offline recoveries is 0", active.offlineRecoveriesPerMonth === 0, String(active.offlineRecoveriesPerMonth));
const baseEgress = egressAt(active);
ok("NEGATIVE CONTROL: with 0 offline recoveries the S3 egress is 0", baseEgress === 0, String(baseEgress));

// ---- 2. The control exists on the rendered section. -------------------------------------------
const section = buildInputsSection(host);
const control = qs(section, "#cost-offline-recoveries") as unknown as
  | { value: string; getAttribute(n: string): string | null; dispatchEvent(e: ReturnType<typeof makeEvent>): void }
  | null;
ok("the inputs section renders #cost-offline-recoveries", control !== null);
if (control !== null) {
  ok("the control is a number input", control.getAttribute("type") === "number", String(control.getAttribute("type")));
  ok("the control shows the current value, 0", control.value === "0", JSON.stringify(control.value));

  // ---- 3. Typing a value reaches offlineRecoveriesPerMonth and moves the S3 egress. -----------
  control.value = "2";
  control.dispatchEvent(makeEvent({ type: "input" }));
  ok("typing 2 patches offlineRecoveriesPerMonth to 2", active.offlineRecoveriesPerMonth === 2, String(active.offlineRecoveriesPerMonth));
  const twoEgress = egressAt(active);
  ok("with 2 offline recoveries the S3 egress is above 0", twoEgress > 0, String(twoEgress));

  control.value = "4";
  control.dispatchEvent(makeEvent({ type: "input" }));
  const fourEgress = egressAt(active);
  ok("4 offline recoveries price exactly twice the egress of 2", Math.abs(fourEgress - 2 * twoEgress) < 1e-9, `${fourEgress} vs 2 x ${twoEgress}`);

  // ---- 4. The sibling validation idiom: a negative entry is refused and never patched. --------
  control.value = "-1";
  control.dispatchEvent(makeEvent({ type: "input" }));
  ok("a negative entry does not patch the model (stays 4)", active.offlineRecoveriesPerMonth === 4, String(active.offlineRecoveriesPerMonth));
  control.value = "1.5";
  control.dispatchEvent(makeEvent({ type: "input" }));
  ok("a fractional entry is rounded to a whole number of recoveries", active.offlineRecoveriesPerMonth === 2, String(active.offlineRecoveriesPerMonth));
}

// ---- 5. R2 has no egress rate, so the same recoveries price no egress there. ---------------------
const r2Egress = monthlyCost({ ...active, offlineRecoveriesPerMonth: 2 }, PRESETS.r2, { regime: "retained", month: 6 }).egress;
ok("on R2 (egress 0 per GB) the recoveries add no egress", r2Egress === 0, String(r2Egress));

verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) {
  console.log(`\nFAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: offline recoveries per month are an input and move the projected egress");
