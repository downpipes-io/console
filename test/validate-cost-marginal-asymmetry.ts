// Cost estimator: the multi-destination MARGINAL-COST asymmetry. The multi-
// destination estimator sums STORAGE, WRITE and per-run cost across the 3-2-1 fan-out
// (a backup run writes to every destination) but prices a RESTORE and a DRILL on the PRIMARY (first) destination
// only, because a restore or drill reads ONE copy. validate-cost-model-platform covers the storage fan-out
// (2x/3x) and validate-cost-view covers the seeding order, but nothing asserted the MARGINAL-cost wiring in
// results-marginal.ts (buildMarginalCosts): that per-run sums while restore/drill stay on the primary. A
// regression that summed the restore across destinations would OVER-charge the customer's estimate by the
// fan-out factor. This renders the real buildMarginalCosts with one destination and with two (a different-rate
// secondary) and asserts, default-FAIL: the per-run row INCREASES by exactly the secondary's per-run cost (the
// fan-out is real and summed), while the drill and in-account-restore rows are UNCHANGED (priced on the primary
// only), and the multi-destination copy names "your first destination". Net-zero: pure render under the DOM shim,
// no network, no engine. Run: node test/validate-cost-marginal-asymmetry.ts
import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { DEFAULT_INPUTS, drillCostOnce, perRunCost, restoreCostOnce } from "../src/lib/cost-model.ts";
import { buildMarginalCosts } from "../src/screens/costs/results-marginal.ts";

// A realistic large workload so per-run, drill and restore are all non-trivial (dollars, not sub-cent), and so
// the summed fan-out is clearly distinguishable from the primary-only figures.
const inputs = { ...DEFAULT_INPUTS, sourceBytes: 5e12, churnFraction: 0.1, runsPerMonth: 30, retentionRuns: 30, segBytes: 1048576, drillsPerMonth: 1, restoresPerMonth: 1, driveEgressFree: false };
const primary = { storagePerGBMonth: 0.02, classAPerMillion: 5, classBPerMillion: 0.5, egressPerGB: 0 };
const secondary = { storagePerGBMonth: 0.2, classAPerMillion: 50, classBPerMillion: 5, egressPerGB: 0.09 };

let assertions = 0;
let failures = 0;
function ok(label: string, cond: boolean, detail = ""): void {
  assertions++;
  console.log(cond ? `  ok   ${label}${detail ? ` (${detail})` : ""}` : `  FAIL ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) failures++;
}
// Extract the numeric dollar value of a marginal row by its label.
function rowNum(section: HTMLElement, label: string): number {
  const rows = [...section.querySelectorAll(".cost-marginal__row")];
  const row = rows.find((r) => (r.textContent ?? "").includes(label));
  if (!row) throw new Error(`marginal row not found: ${label}`);
  const val = (row.querySelector(".tnum")?.textContent ?? "").replace(/[^0-9.]/g, "");
  return Number.parseFloat(val);
}

function main(): void {
  const single = buildMarginalCosts(inputs, [primary]);
  const multi = buildMarginalCosts(inputs, [primary, secondary]);

  const perRunS = rowNum(single, "One additional run");
  const perRunM = rowNum(multi, "One additional run");
  const drillS = rowNum(single, "One integrity drill");
  const drillM = rowNum(multi, "One integrity drill");
  const restoreS = rowNum(single, "One restore (in account)");
  const restoreM = rowNum(multi, "One restore (in account)");

  // Oracles from the model (no rounding): a run writes to every destination; a drill/restore reads the primary.
  const perRunSum = perRunCost(inputs, primary) + perRunCost(inputs, secondary);
  const drillPrimary = drillCostOnce(inputs, primary);
  const drillSummed = drillCostOnce(inputs, primary) + drillCostOnce(inputs, secondary);
  const restorePrimary = restoreCostOnce(inputs, primary, { downloaded: false });

  console.log(`  [values] perRun single=${perRunS} multi=${perRunM}; drill single=${drillS} multi=${drillM}; restore single=${restoreS} multi=${restoreM}`);

  // Sanity: the figures are non-trivial, so "unchanged" below is a real signal, not a vacuous zero.
  ok("SANITY: per-run, drill and in-account-restore are all non-trivial (> $0.01), so the assertions are not vacuous", perRunS > 0.01 && drillS > 0.01 && restoreS > 0.01, `perRun=${perRunS}, drill=${drillS}, restore=${restoreS}`);

  // PER-RUN SUMS across the fan-out: adding a destination increases it by exactly the secondary's per-run cost.
  ok("PER-RUN SUMS: the per-run row equals the fan-out sum (a run writes to every destination)", Math.abs(perRunM - perRunSum) < 0.01 && perRunM > perRunS + 0.01, `multi=${perRunM.toFixed(4)} vs sum=${perRunSum.toFixed(4)}, single=${perRunS.toFixed(4)}`);

  // DRILL priced on the PRIMARY only: unchanged when a second destination is added, and NOT the summed figure.
  ok("DRILL on PRIMARY: the drill row is UNCHANGED when a 2nd destination is added (reads one copy)", drillM === drillS && Math.abs(drillM - drillPrimary) < 0.01, `single=${drillS} multi=${drillM} primary-oracle=${drillPrimary.toFixed(4)}`);
  ok("DRILL is NOT summed across destinations (a regression that fanned it out would over-charge)", Math.abs(drillM - drillSummed) > 0.01, `drillM=${drillM} vs summed=${drillSummed.toFixed(4)}`);

  // RESTORE (in account) priced on the PRIMARY only: unchanged by the 2nd destination.
  ok("RESTORE on PRIMARY: the in-account restore row is UNCHANGED by the 2nd destination", restoreM === restoreS && Math.abs(restoreM - restorePrimary) < 0.01, `single=${restoreS} multi=${restoreM}`);

  // The customer-facing copy names the primary only when there is a fan-out.
  const multiText = multi.textContent ?? "";
  const singleText = single.textContent ?? "";
  ok("COPY: with a fan-out, restore/drill say 'from your first destination'; per-run says 'summed across every destination'", multiText.includes("from your first destination") && multiText.includes("summed across every destination"));
  ok("COPY: with a single destination, neither the primary-naming nor the summed-across wording appears", !singleText.includes("from your first destination") && !singleText.includes("summed across every destination"));

  console.log(failures === 0
    ? `\nMARGINAL-COST ASYMMETRY OK: per-run sums across the 3-2-1 fan-out while a restore and a drill are priced on the primary destination only -- adding a destination never inflates the one-copy restore/drill figures. ${assertions} assertions, net-zero.`
    : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main();
