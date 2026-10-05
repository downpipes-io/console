// TC-cost-custom-preset-keeps-rates: choosing Custom in a destination's preset picker must keep the
// rates already in the four fields, not replace them with zeros.
// Run with: node test/validate-cost-custom-preset-keeps-rates.ts
//
// WHY THIS EXISTS. PRESETS.custom is all zeros, and applyPreset wrote whatever preset was picked into
// the four rate fields. So choosing Custom, which the picker's hint tells an operator on Google Cloud
// Storage or Azure Blob Storage to do, silently set every rate to 0. A 0 reads exactly like a rate the
// operator typed, and the validator accepts it, so the estimate could show a destination costed at
// nothing with no sign that anything had been reset. Custom means "I will edit these", so it keeps the
// figures in front of the operator as the starting point.

import { installDomShim, qs } from "./dom-shim.ts";
installDomShim();
const { makeEvent } = await import("./dom-shim-core.ts");

import { PRESETS } from "../src/lib/cost-model.ts";
import { buildPricingSection, type CostPricingHost, type PricingState } from "../src/screens/costs/pricing-section.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean, measured?: string): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${!cond && measured ? `\n         measured: ${measured}` : ""}`);
  if (!cond) failures++;
}

console.log("TC-cost-custom-preset-keeps-rates: Custom keeps the rates in the fields");

const states: PricingState[] = [{ presetId: "r2", pricing: { ...PRESETS.r2 }, label: "Destination 1" }];
const host: CostPricingHost = {
  pricingStates: states,
  recompute: () => {},
  recomputeSilent: () => {},
  announce: () => {},
};

type Ctl = { value: string; dispatchEvent(e: ReturnType<typeof makeEvent>): void };
const section = buildPricingSection(host);
const picker = qs(section, "#cost-preset-0") as unknown as Ctl | null;
const storage = qs(section, "#cost-price-storage-0") as unknown as Ctl | null;
const classA = qs(section, "#cost-price-classa-0") as unknown as Ctl | null;
ok("the section renders the preset picker and the rate fields", picker !== null && storage !== null && classA !== null);

if (picker !== null && storage !== null && classA !== null) {
  // Positive control: picking a NAMED preset still loads that preset's figures.
  picker.value = "s3-standard";
  picker.dispatchEvent(makeEvent({ type: "change" }));
  ok("picking Amazon S3 loads its storage rate", states[0]?.pricing.storagePerGBMonth === PRESETS["s3-standard"].storagePerGBMonth, String(states[0]?.pricing.storagePerGBMonth));

  picker.value = "r2";
  picker.dispatchEvent(makeEvent({ type: "change" }));
  ok("picking Cloudflare R2 loads its storage rate", states[0]?.pricing.storagePerGBMonth === PRESETS.r2.storagePerGBMonth, String(states[0]?.pricing.storagePerGBMonth));

  // The defect: Custom must not zero the rates.
  picker.value = "custom";
  picker.dispatchEvent(makeEvent({ type: "change" }));
  ok("choosing Custom marks the destination custom", states[0]?.presetId === "custom", String(states[0]?.presetId));
  ok("choosing Custom keeps the storage rate (not 0)", states[0]?.pricing.storagePerGBMonth === PRESETS.r2.storagePerGBMonth, String(states[0]?.pricing.storagePerGBMonth));
  ok("choosing Custom keeps the write rate (not 0)", states[0]?.pricing.classAPerMillion === PRESETS.r2.classAPerMillion, String(states[0]?.pricing.classAPerMillion));
  const noteText = section.textContent ?? "";
  ok("a Custom destination is told a 0 rate prices that cost at nothing", /A rate left at 0 prices that cost at nothing/.test(noteText));
  ok("the storage field still shows the kept rate", storage.value !== "0" && Number(storage.value) === PRESETS.r2.storagePerGBMonth, JSON.stringify(storage.value));
}

console.log(failures === 0 ? "\nCUSTOM PRESET PASS" : `\n${failures} FAILURE(S)`);
verdictReached(failures);
process.exitCode = failures === 0 ? 0 : 1;
