// Validate the pure helpers in src/api.ts and the client/server plan-hash parity.
// Run with: node test/validate-api.ts
//
// This file was split from a single 1700+ line module into
// cohesive sibling groups, each exporting a run function. This orchestrator imports and
// CALLS each group IN THE SAME ORDER the original ran, so the full suite still executes in
// one `node test/validate-api.ts` and the pass count is unchanged. The shared harness
// (test/validate-api-shared.ts) carries the single failure count across every group.
//
// Groups:
//   validate-api-pure.ts          sections 1-5: plan-hash parity, origin guard, roleRank /
//                                 hasRole, projectMonthlyKVReads, listHistory .entries unwrap
//   validate-api-flows.ts         sections 6 / 6B / 7: the REAL restore-flow and onboarding
//                                 screen flows (blast-radius cues, restorability blind
//                                 test, onboarding writes) under the shared DOM shim
//   validate-api-capabilities.ts  the capability model mirror (ROLE_CAPABILITIES / can())
//   validate-api-client.ts        the preflight + support + native-IdP EngineClient methods
//                                 against a recording fetch stub

import { Harness } from "./validate-api-shared.ts";
import { runPure } from "./validate-api-pure.ts";
import { runFlows } from "./validate-api-flows.ts";
import { runCapabilities } from "./validate-api-capabilities.ts";
import { runClient } from "./validate-api-client.ts";

async function main(): Promise<void> {
  const h = new Harness();

  // The pure helpers and the plan-hash parity (no DOM, no network).
  await runPure(h);

  // The REAL restore-flow + onboarding screen flows (DOM shim, in-memory engine doubles).
  await runFlows(h);

  // The capability / role model mirror vs the contract table (pure).
  runCapabilities(h);

  // The preflight + support + native-IdP client methods (fetch-stubbed transport).
  await runClient(h);

  // ==========================================================================
  // Summary
  // ==========================================================================
  console.log(h.failures === 0 ? "\nALL VALIDATE-API VECTORS PASS" : `\n${h.failures} FAILURE(S)`);
  // Exit deterministically. Driving the REAL restore flow schedules production timers
  // (a toast auto-dismiss, the approvals re-check poll) that legitimately outlive this
  // test; without an explicit exit they would keep the node process alive (and a late
  // tick must never be able to flip a green run). Exit 1 on any failure, 0 otherwise.
  if (h.failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  process.exit(h.failures > 0 ? 1 : 0);
}

main().catch((err) => {
  // A thrown error (as opposed to a counted assertion failure) must still fail the run
  // loudly rather than passing silently or hanging.
  console.error("\nVALIDATE-API THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
