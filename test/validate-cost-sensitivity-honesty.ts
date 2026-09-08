// Cost estimator: the sensitivity view's growth-model HONESTY + multi-destination sum. The
// sensitivity MODEL (sensitivity()) is well-covered by validate-cost-model-churn-dedup, but the rendered view
// (buildSensitivity in results-marginal.ts) was untested -- including a deliberate honesty choice: under the
// default per-run SNAPSHOT growth model a churn sweep would be a FLAT table pretending to be analysis (every run
// stores a full snapshot, so churn does not move the cost), so the view shows a plain NOTE instead; it sweeps
// churn only under the cross-run DEDUP model where churn genuinely drives growth. A regression that always
// rendered the churn sweep would show a misleading flat table to the customer. This renders the real
// buildSensitivity and asserts, default-FAIL: under snapshot the Churn block is a note (not a sweep table); under
// churn-dedup it IS a sweep table; Retention and Cadence are always sweep tables; and the sensitivity sums across
// a 3-2-1 fan-out (two destinations show larger figures than one). Net-zero: pure render under the DOM shim, no
// network, no engine. Run: node test/validate-cost-sensitivity-honesty.ts
import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { DEFAULT_INPUTS } from "../src/lib/cost-model.ts";
import { buildSensitivity } from "../src/screens/costs/results-marginal.ts";

// A realistic workload so the sweeps carry non-trivial figures.
const base = { ...DEFAULT_INPUTS, sourceBytes: 5e12, churnFraction: 0.1, runsPerMonth: 30, retentionRuns: 30, segBytes: 1048576 };
// `as const` on each, so the field keeps its GrowthModel literal instead of widening to string. Without
// it the spread infers a plain string and neither fixture is the union the estimator takes, which also
// means a value that stops being a growth model would widen quietly rather than fail here.
const snapshot = { ...base, growthModel: "snapshot" as const };
const churnDedup = { ...base, growthModel: "churn-dedup" as const };
const primary = { storagePerGBMonth: 0.02, classAPerMillion: 5, classBPerMillion: 0.5, egressPerGB: 0 };
const secondary = { storagePerGBMonth: 0.2, classAPerMillion: 50, classBPerMillion: 5, egressPerGB: 0.09 };

let assertions = 0;
let failures = 0;
function ok(label: string, cond: boolean, detail = ""): void {
  assertions++;
  console.log(cond ? `  ok   ${label}${detail ? ` (${detail})` : ""}` : `  FAIL ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) failures++;
}
// Find a sensitivity block (Churn / Retention depth / Cadence) by its h4 title.
function block(section: HTMLElement, title: string): HTMLElement | undefined {
  return [...section.querySelectorAll(".cost-sensitivity__block")].find((b) => (b.querySelector("h4")?.textContent ?? "") === title) as HTMLElement | undefined;
}
function has(el: HTMLElement | undefined, needle: string): boolean {
  return (el?.textContent ?? "").includes(needle);
}
// Sum the numeric dollar cells (.tnum) in a block -- higher when the sweep is summed across more destinations.
function tnumSum(el: HTMLElement | undefined): number {
  if (!el) return 0;
  return [...el.querySelectorAll(".tnum")].reduce((s, c) => s + (Number.parseFloat((c.textContent ?? "").replace(/[^0-9.]/g, "")) || 0), 0);
}

function main(): void {
  const snapSens = buildSensitivity(snapshot, [primary]);
  const dedupSens1 = buildSensitivity(churnDedup, [primary]);
  const dedupSens2 = buildSensitivity(churnDedup, [primary, secondary]);

  const snapChurn = block(snapSens, "Churn");
  const dedupChurn = block(dedupSens1, "Churn");

  // HONESTY: under snapshot the Churn block is a plain note, never a flat sweep table.
  ok("HONESTY (snapshot): the Churn sensitivity is a plain note ('does not move this projection'), NOT a misleading flat sweep table", has(snapChurn, "does not move this projection") && !has(snapChurn, "Change") && !has(snapChurn, "Monthly"));

  // Under churn-dedup the Churn block IS a sweep table (churn genuinely drives growth there).
  ok("under churn-dedup: the Churn sensitivity IS a sweep table (Monthly + Change columns), not the note", !has(dedupChurn, "does not move this projection") && has(dedupChurn, "Monthly") && has(dedupChurn, "Change"));

  // Retention and Cadence are always sweep tables, under BOTH growth models.
  ok("Retention depth + Cadence are sweep tables under BOTH growth models (only churn is conditional)", has(block(snapSens, "Retention depth"), "Change") && has(block(snapSens, "Cadence"), "Change") && has(block(dedupSens1, "Retention depth"), "Change") && has(block(dedupSens1, "Cadence"), "Change"));

  // MULTI-DEST SUM: two destinations show substantially larger sensitivity figures than one (sumSensitivity).
  const ret1 = tnumSum(block(dedupSens1, "Retention depth"));
  const ret2 = tnumSum(block(dedupSens2, "Retention depth"));
  ok("MULTI-DEST: the sensitivity sweep sums across the 3-2-1 fan-out (two destinations >> one)", ret1 > 0 && ret2 > ret1 * 1.5, `1-dest=${ret1.toFixed(2)}, 2-dest=${ret2.toFixed(2)}`);

  console.log(failures === 0
    ? `\nSENSITIVITY HONESTY OK: the churn sweep is shown only under the growth model where churn drives cost (a note, never a flat misleading table, under snapshot); retention/cadence always sweep; and the sweeps sum across the destination fan-out. ${assertions} assertions, net-zero.`
    : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main();
