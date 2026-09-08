// Validate predecessorLine: the engine now reports each run
// history row's predecessor chain pointer (engine src/admin/run-chain.ts annotatePredecessorChain), and
// the console's run detail drawer shows it so an auditor can reconstruct a downpipe's per-run
// predecessor chain from the console alone, not only from the sealed archive's own RUNLOG. This suite
// drives the REAL console helper (no mock re-implementation) and asserts:
//
//   - a genuine first run (prevRunIdStatus "none") reads a plain, honest "no predecessor" line.
//   - a retained predecessor (its own row present in the same read) shows that run's id.
//   - a PRUNED predecessor (a real id that aged out of the retained window) is shown WITH its id and an
//     honest "not itself a broken chain" qualifier -- never an empty string or a blank row, which would
//     misrepresent an honest truncation as a rewritten/broken chain.
//   - a legacy row recorded before this field existed ("unknown") reads distinctly from "none": the
//     console must not claim a legacy row has no predecessor when it genuinely does not know.
//   - an engine that has not shipped prevRunIdStatus at all (the field absent) renders NOTHING (null),
//     so an older engine never causes the console to guess or fabricate a chain reading.
//
// Run with: node test/validate-run-predecessor.ts.

import { predecessorLine } from "../src/screens/runs/helpers.ts";
import type { FleetRun } from "../src/screens/runs/types.ts";

let failures = 0;
function eq<T>(label: string, got: T, want: T): void {
  const cond = got === want;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

const NOW = Date.now();

function run(over: Partial<FleetRun>): FleetRun {
  return {
    runId: over.runId ?? "r0",
    index: over.index ?? 0,
    startedAt: over.startedAt ?? new Date(NOW).toISOString(),
    status: over.status ?? "ok",
    downpipeId: over.downpipeId ?? "dp",
    ...over,
  };
}

console.log("\n-- predecessorLine honesty --");

eq(
  "a genuine first run reads a plain honest 'no predecessor' line",
  predecessorLine(run({ prevRunId: null, prevRunIdStatus: "none" })),
  "None (this is the first run for this downpipe)",
);

eq(
  "a retained predecessor shows that run's id",
  predecessorLine(run({ prevRunId: "r-prior", prevRunIdStatus: "retained" })),
  "r-prior",
);

eq(
  "a pruned predecessor shows the id WITH an honest not-a-broken-chain qualifier",
  predecessorLine(run({ prevRunId: "r-aged-off", prevRunIdStatus: "pruned" })),
  "r-aged-off (outside the retained run history; not itself a broken chain)",
);

eq(
  "a pruned predecessor NEVER reads as an empty string (that would look like a broken chain)",
  predecessorLine(run({ prevRunId: "r-aged-off", prevRunIdStatus: "pruned" })) === "",
  false,
);

eq(
  "a legacy row (unknown) reads distinctly from a genuine first run (none)",
  predecessorLine(run({ prevRunIdStatus: "unknown" })),
  "Not recorded (this run predates predecessor tracking)",
);

const legacyReading = predecessorLine(run({ prevRunIdStatus: "unknown" }));
const firstRunReading = predecessorLine(run({ prevRunId: null, prevRunIdStatus: "none" }));
eq("'unknown' and 'none' are never the same rendered line", legacyReading === firstRunReading, false);

eq(
  "an engine that has not shipped prevRunIdStatus renders NOTHING (no guess)",
  predecessorLine(run({})),
  null,
);

console.log(failures === 0 ? "\nRUN PREDECESSOR VALIDATIONS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
if (failures > 0) process.exit(1);
