// destinationCell's multi-destination hint (sources-downpipes/detail-config-section.ts) must state the
// real replication cadence. The engine's replicate pass runs only from the cron tick (src/sched
// runReplications, on SliceBudget.passWindow), oldest run first: a run is never replicated the moment it
// seals. The hint used to say "each copy is replicated after every run", which is not the engine's
// contract. This pins the true cadence in the hint's own words, reusing the engine's own phrasing
// ("Replication copies ... at each 15-minute cron tick, oldest first", engine src/sched/dest-removal-text.ts).
//
//   node test/validate-destination-fanout-cadence.ts
//
//

import { installDomShim, flushAsync, textOf } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

const { destinationCell } = await import("../src/screens/sources-downpipes/detail-config-section.ts");

let failures = 0;
function ok(what: string, cond: boolean): void {
  console.log(cond ? `  ok   ${what}` : `  FAIL ${what}`);
  if (!cond) failures++;
}

const dp = { id: "dp1", name: "fan", destinationIds: ["a", "b"] } as never;
const fakeEngine = {
  listDestinations: async () => ({
    destinations: [
      { id: "a", label: "Primary bucket" },
      { id: "b", label: "Copy bucket" },
    ],
  }),
} as never;

console.log("-- a downpipe fanning out to more than one destination --");
{
  const el = destinationCell(fakeEngine, dp, null);
  await flushAsync();
  const text = textOf(el as never);
  ok("names the fan-out and that the primary seals first", /3-2-1 fan-out.*the primary is sealed first/.test(text));
  ok("states the true cadence: the 15-minute cron tick, oldest first", /at each 15-minute cron tick, oldest first/.test(text));
  ok("scopes the ordering to each downpipe, not the whole fleet", /oldest first within each downpipe/.test(text));
  ok("never claims replication runs after every run", !/after every run/.test(text));
}

console.log(failures === 0 ? "\nAll destination fan-out cadence checks passed." : `\n${failures} check(s) failed.`);
verdictReached(failures);
if (failures > 0) process.exit(1);
