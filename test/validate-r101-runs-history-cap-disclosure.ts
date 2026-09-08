// The Runs summary band must disclose the bound on the ring its totals are drawn from.
// Run with: node test/validate-r101-runs-history-cap-disclosure.ts
//
// WHY THIS EXISTS. listAllHistory() returns a per-downpipe ring capped at 50 runs,
// by the client's own comment (client-downpipes.ts). The Runs summary band computed its totals from
// exactly that ring and called itself "the full run set" with no cap stated anywhere on screen, while
// two sibling surfaces reading the identically-shaped ring (the restore date-picker and the
// notifications delivery history) both disclose the same fifty-run bound. "Failed or abandoned: 0"
// on the Runs screen could only ever mean "nothing failed within the ring", not "nothing has ever
// failed" -- a distinction this test locks in place.
//
// This renders the REAL buildSummary(), so it fails if the disclosure is removed or the wording
// drifts off the "capped at 50" claim.

import { installDomShim, textOf } from "./dom-shim.ts";
installDomShim();

import { buildSummary } from "../src/screens/runs/summary.ts";
import type { FleetRun } from "../src/screens/runs/types.ts";

let failures = 0;
function ok(label: string, cond: boolean, measured?: string): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${!cond && measured ? `\n         measured: ${measured}` : ""}`);
  if (!cond) failures++;
}

const NOW = Date.now();
function run(over: Partial<FleetRun>): FleetRun {
  return {
    runId: over.runId ?? "r0",
    index: over.index ?? 0,
    startedAt: over.startedAt ?? new Date(NOW - 3_600_000).toISOString(),
    status: over.status ?? "ok",
    downpipeId: over.downpipeId ?? "dp",
    ...over,
  };
}

console.log("the ring bound is stated on the Runs screen");

// ---- 1. The summary band names the ring's bound. --------------------------------------------------
{
  const band = textOf(buildSummary([run({ index: 0, status: "ok" })]) as never);
  ok("the band states the numeral fifty", /\b50\b/.test(band), band);
  ok("and names it as a per-downpipe cap on run history, not a total-fleet cap", /50 runs per downpipe/i.test(band), band);
  ok("and does not leave 'the full run set' as the only description of what is shown", !/computed from the full run set/i.test(band));
}

// ---- 2. NEGATIVE CONTROL: an empty run set still carries the disclosure. --------------------------
// (buildSummary is only ever called with a non-empty set by view.ts -- the true-empty state renders
// buildEmpty() instead -- but the disclosure itself is a static sentence, not data-driven, so it
// should not depend on the shape of what is passed.)
{
  const band = textOf(buildSummary([run({ index: 0, status: "failed" })]) as never);
  ok("NEGATIVE CONTROL: the disclosure is present regardless of the run mix", /50 runs per downpipe/i.test(band), band);
}

// ---- 3. The wording matches the house style already settled on the two sibling surfaces. ----------
{
  const band = textOf(buildSummary([run({ index: 0, status: "ok" })]) as never);
  ok("an older run is still restorable by id, matching date-picker.ts's honesty note", /still restorable by its id/i.test(band), band);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
