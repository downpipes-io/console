// Validate the pure logic of the heavy interaction components: the data-table's
// windowing maths and sort comparator; the sparkline phrase derivation; the
// status/runStatusTone mapping; the trust-chip accessVerdictFromCaller state
// machine; the verdict<->trust-chip mirror contract; and the modal action
// error-surfacing contract. Tests exercise the MATHS and STATE only, not DOM
// rendering. Every section includes negative controls that would pass vacuously
// if the assertion were wrong.
//
// This file is a thin orchestrator: the assertions live in sibling area modules
// (validate-components-*.ts) and are called here in the original source order so
// `node test/validate-components.ts` runs the full suite unchanged.
// Run with `node test/validate-components.ts`.
//
import { makeOk, type SuiteState } from "./validate-components-shared.ts";
import {
  runDataTableMaths,
  runDataTableBulkAction,
} from "./validate-components-data-table.ts";
import { runSparklineStatus } from "./validate-components-sparkline-status.ts";
import {
  runTrustStateMachine,
  runTrustMirror,
} from "./validate-components-trust.ts";
import { runModalDrawer } from "./validate-components-modal-drawer.ts";
import {
  runAccessSecurityLabelsAndProbe,
  runAccessSecurityAuditIp,
} from "./validate-components-access-security.ts";

async function main(): Promise<void> {
  const state: SuiteState = { failures: 0 };
  const ok = makeOk(state);

  // Sections run in the same order as the original single-file suite so the
  // output and assertion sequence are byte-for-byte preserved.
  runDataTableMaths(ok);                 // 1, 2: windowing maths + compareCells
  runSparklineStatus(ok);                // 3, 4: derivePhrase + runStatusTone
  runTrustStateMachine(ok);              // 5: accessVerdictFromCaller
  await runModalDrawer(ok);              // 6, 7: modal error surfacing + tab guard
  await runDataTableBulkAction(ok);      // 8: bulk action rejection handling
  runAccessSecurityLabelsAndProbe(ok);   // 9, 10: field labels + health probe
  runTrustMirror(ok);                    // 11: verdict<->trust-chip mirror
  runAccessSecurityAuditIp(ok);          // 12: audit Source-IP cell

  // ===========================================================================
  // Summary
  // ===========================================================================
  console.log(state.failures === 0 ? "\nCOMPONENT LOGIC VECTORS PASS" : `\n${state.failures} FAILURE(S)`);
  if (state.failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
