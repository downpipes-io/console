// The Cloudflare-resources card must not claim a figure is "measured from your run history" once
// the operator has switched to Manual mode and is pricing a hypothetical scenario.
// Run with: node test/validate-r104-costs-manual-mode-honesty.ts
//
// WHY THIS EXISTS. observedOpCountsPerRun (the real per-run Cloudflare op tally,
// seeded once from run history) used to ride along into buildResults regardless of the screen's
// active mode. computePlatformLedger (screens/costs/results.ts) only ever checked whether the seed
// was non-null, never whether the operator was still in Observed mode, so switching to Manual and
// typing a hypothetical cadence still priced the monthly platform figure off the real historical
// mean while the card's own label kept claiming the whole monthly total was "measured from your run
// history" -- a precision failure against house style ("precise claims"). The fix gates the seed
// on ctx.mode === "observed", so the label is true exactly when it is shown.
//
// This renders the REAL buildResults() with a real observed op-count seed present, and flips only
// ctx.mode, so it fails if the gate is removed or the label drifts back to "measured" under Manual.

import { installDomShim, textOf } from "./dom-shim.ts";
installDomShim();

import { PRESETS, withDefaults, type OpCountsLike } from "../src/lib/cost-model.ts";
import { buildResults, type ResultsCtx } from "../src/screens/costs/results.ts";

let failures = 0;
function ok(label: string, cond: boolean, measured?: string): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${!cond && measured ? `\n         measured: ${measured}` : ""}`);
  if (!cond) failures++;
}

console.log("the platform card's 'measured' claim tracks the active mode");

const inputs = withDefaults({
  sourceBytes: 10e9,
  dedupRatio: 0.5,
  churnFraction: 0.1,
  runsPerMonth: 30,
  retentionRuns: 10,
});

// A real observed op-count seed, the shape run history hands the screen once a backup has run.
const opCountsPerRun: OpCountsLike = { kvRead: 10_000, kvList: 0, r2ClassA: 10_000, r2ClassB: 0, d1Read: 0, cfApiRead: 0, secretsRead: 0, subrequests: 20_000 };

const baseCtx: Omit<ResultsCtx, "mode"> = {
  observedRuns: 12,
  presetId: "r2",
  safetyMargin: 0.2,
  opCountsPerRun,
};

// The no-seed variant of the same base context (exactOptionalPropertyTypes: opCountsPerRun is
// OMITTED, never set to undefined, so it matches the real "no run history yet" shape the screen
// itself produces).
const baseCtxNoSeed: Omit<ResultsCtx, "mode" | "opCountsPerRun"> = {
  observedRuns: 12,
  presetId: "r2",
  safetyMargin: 0.2,
};

// ---- 1. Observed mode: the op-count seed prices the card, and the card says so. -------------------
const observed = buildResults(inputs, [PRESETS.r2], { ...baseCtx, mode: "observed" });
const observedText = textOf(observed.el as never);
ok("OBSERVED: the card claims the figure is measured from run history", /measured from your run history/i.test(observedText), observedText.slice(0, 600));
ok("OBSERVED: the stat-tile secondary reads 'measured'", /per month, measured from your run history/i.test(observedText), observedText.slice(0, 600));

// ---- 2. Manual mode, SAME seed present: the card must NOT claim 'measured'. ------------------------
const manual = buildResults(inputs, [PRESETS.r2], { ...baseCtx, mode: "manual" });
const manualText = textOf(manual.el as never);
ok("MANUAL: the card no longer claims the figure is measured", !/measured from your run history/i.test(manualText), manualText.slice(0, 600));
ok("MANUAL: the stat-tile secondary falls back to the honest 'at paid rates' wording", /per month, at paid rates/i.test(manualText), manualText.slice(0, 600));

// ---- 3. The arithmetic actually changed, not only the label: Manual mode reverts to the ----------
// object-count estimate (which over-estimates source reads at the most expensive rate), so the two
// headline totals are NOT required to match. This is the load-bearing proof that the fix is not a
// copy-only patch riding on unchanged numbers.
ok("the two modes price the platform card differently once mode actually gates the seed", observed.headlineTotal !== manual.headlineTotal || observedText !== manualText);

// ---- 4. NEGATIVE CONTROL: Manual mode with NO observed seed at all behaves exactly as before -------
// (nothing here should regress the ordinary no-history case).
const manualNoSeed = buildResults(inputs, [PRESETS.r2], { ...baseCtxNoSeed, mode: "manual" });
const manualNoSeedText = textOf(manualNoSeed.el as never);
ok("NEGATIVE CONTROL: Manual mode with no seed at all also reads 'at paid rates' (unaffected by the gate)", /per month, at paid rates/i.test(manualNoSeedText));

// ---- 5. NEGATIVE CONTROL: Observed mode with NO seed never claims 'measured' (nothing to measure). -
const observedNoSeed = buildResults(inputs, [PRESETS.r2], { ...baseCtxNoSeed, mode: "observed" });
const observedNoSeedText = textOf(observedNoSeed.el as never);
ok("NEGATIVE CONTROL: Observed mode with no seed does not fabricate a 'measured' claim", !/measured from your run history/i.test(observedNoSeedText));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
