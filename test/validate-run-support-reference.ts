// A failed run's drawer shows the support reference the docs ask the operator to quote.
//
//   node test/validate-run-support-reference.ts
//
// The engine stamps a 12-hex one-way digest of the raw failure text on a FAILED run row (causeDigest,
// engine src/sched/scheduler-do-scheduling.ts), byte-identical to the `[cause <hex>]` it writes to its log
// for the same fault. docs day-2/runs-and-history tells the operator to quote that digest when they raise a
// failed run, but the Runs drawer never showed it, so the only way to find it was a support bundle. The
// drawer now shows it as "Support reference" under the failure verdict.

import { installDomShim, qs, textOf, flushAsync } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts
installDomShim();

const { openRunDetail } = await import("../src/screens/runs/detail.ts");
const { closeAllOverlays } = await import("../src/components/dialog.ts");
import type { FleetRun } from "../src/screens/runs/types.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const engine = new Proxy({}, { get: () => () => new Promise(() => {}) }) as never;

async function drawerText(over: Partial<FleetRun>): Promise<string> {
  closeAllOverlays();
  const run: FleetRun = { runId: "run-1", index: 7, startedAt: "2026-09-20T00:00:00Z", status: "failed", downpipeId: "dp-1", downpipeName: "KV uploads", ...over };
  openRunDetail(engine, run);
  await flushAsync();
  const surface = qs(document.body, ".dialog--drawer");
  return surface ? textOf(surface) : "";
}

async function main(): Promise<void> {
  console.log("(1) a failed run with a digest shows it");
  {
    const t = await drawerText({ error: "destination unreachable", causeDigest: "3fa9c01b7e42" });
    ok("(1a) the failure verdict renders", t.includes("This run failed"));
    ok("(1b) the drawer labels the support reference", t.includes("Support reference"));
    ok("(1c) the drawer shows the digest itself", t.includes("3fa9c01b7e42"));
  }

  console.log("\n(2) nothing that looks like a reference when there is none");
  {
    const legacy = await drawerText({ error: "destination unreachable" });
    ok("(2a) a failed row from an older engine shows no support reference row", !legacy.includes("Support reference"));
    const malformed = await drawerText({ error: "destination unreachable", causeDigest: "<b>not-hex</b>" });
    ok("(2b) a malformed digest is not shown", !malformed.includes("Support reference") && !malformed.includes("not-hex"));
    const okRun = await drawerText({ status: "ok", causeDigest: "3fa9c01b7e42" });
    ok("(2c) a successful run shows no support reference", !okRun.includes("Support reference"));
  }

  console.log(`\n${failures === 0 ? "RUN-SUPPORT-REFERENCE OK: a failed run's drawer shows the digest support joins to the engine log" : `${failures} FAILURE(S)`}`);
  verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
