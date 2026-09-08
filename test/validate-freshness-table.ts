// Validate that the /downpipes State column stays LIVE across the in-place auto-refresh
// (the frozen-verdict regression). The screen builds the fleet table ONCE per mount
// (sources-downpipes.ts renderList) and every poll / Run-now reload after that refreshes it
// in place via setRows; buildTable memoises the per-row freshness verdict, and that memo
// used to outlive the row set. The run facts load
// asynchronously after the first paint (fillFreshness), so the memo was always filled with
// the facts-absent verdict: every enabled downpipe read "Idle" FOREVER while the Last-run
// column, which reads the latestRun map directly, kept moving (the reported "last run
// updates but the state never does", second occurrence; the first was the fillFreshness
// re-fetch filter, fixed with the same symptom in its comment).
//
// This suite drives the REAL buildTable (the production dataTable under the shared DOM
// shim) through the screen's actual lifecycle: build with an EMPTY latestRun map (the
// mount-time paint), then fill the map and setRows (the fillFreshness callback), then keep
// mutating facts and setRows (the standing poll). It asserts the State cell tracks the
// facts on every refresh: Idle -> Ok, then Failed, then Running, then Paused. The freshness
// RULE itself (staleness, the shared classifyFreshness) is validate-freshness.ts's job;
// this file is only about the verdict staying live across setRows.
//
// Run with: node test/validate-freshness-table.ts.
//
// The table creates DOM, so the DOM shim is installed first (the same pattern
// validate-run-incomplete.ts uses). None of the imported modules execute DOM at import time.

import { installDomShim } from "./dom-shim.ts";
installDomShim();

import { qsa } from "./dom-shim.ts";
import { buildTable } from "../src/screens/sources-downpipes/table.ts";
import type { RunFacts } from "../src/screens/sources-downpipes/helpers.ts";
import { destinationFromStatus } from "../src/lib/protection-statement.ts";
import type { DownpipeState, EngineClient, RunHistoryEntry } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const NOW = Date.now();
const HOUR = 3_600_000;

// A daily-cadence, enabled KV downpipe; fresh objects per call, the way each
// listDownpipes fetch hands the screen a brand-new array of brand-new states.
function dp(id: string, over: Partial<DownpipeState> = {}): DownpipeState {
  return {
    config: { id, name: id, cadenceSeconds: 86_400, enabled: true, source: { type: "kv", binding: `SRC_KV_${id}`, include: [], exclude: [] } },
    nextRunAt: NOW + HOUR,
    lastRunId: "r1",
    inFlight: false,
    ...over,
  };
}

function run(runId: string, status: RunHistoryEntry["status"], agoMs: number, error?: string): RunHistoryEntry {
  return { runId, index: 0, startedAt: new Date(NOW - agoMs).toISOString(), status, ...(error !== undefined ? { error } : {}) };
}

// The State cell of the named row. Columns: name, source, schedule, STATE, coverage,
// last, next, enabled; rows sort name-ascending, so the row is found by its name cell,
// never by index into an assumed order.
function stateCell(root: unknown, name: string): string {
  for (const tr of qsa(root as never, "tbody tr")) {
    const tds = qsa(tr, "td");
    const rowName = (tds[0] as unknown as { textContent: string } | undefined)?.textContent ?? "";
    if (rowName.startsWith(name)) return (tds[3] as unknown as { textContent: string }).textContent;
  }
  return "(row not found)";
}
function lastRunCell(root: unknown, name: string): string {
  for (const tr of qsa(root as never, "tbody tr")) {
    const tds = qsa(tr, "td");
    const rowName = (tds[0] as unknown as { textContent: string } | undefined)?.textContent ?? "";
    if (rowName.startsWith(name)) return (tds[5] as unknown as { textContent: string }).textContent;
  }
  return "(row not found)";
}

// The engine client is only invoked from interaction handlers (the enable switch, bulk
// actions), none of which this suite fires; a bare stub keeps the table honest that
// rendering never calls the API.
const engine = {} as unknown as EngineClient;
const noop = (): void => {};

console.log("\n-- /downpipes State column stays live across setRows --");

// Mount-time paint: the run facts have not loaded yet (fillFreshness is in flight), so the
// honest read is Idle with the Last-run cell on its loading hint.
const latestRun = new Map<string, RunFacts>();
const table = buildTable(engine, [dp("alpha", { lastRunId: "a2" }), dp("bravo", { lastRunId: "b1" })], latestRun, new URLSearchParams(), false, noop, destinationFromStatus(null));
ok("mount paint (facts not yet loaded): alpha reads Idle", stateCell(table.el, "alpha").includes("Idle"));
ok("mount paint: bravo reads Idle", stateCell(table.el, "bravo").includes("Idle"));
ok("mount paint: alpha Last-run shows the loading hint", lastRunCell(table.el, "alpha").includes("loading"));

// The fillFreshness callback: facts arrive, the screen calls setRows with a fresh list.
// THE REGRESSION: the memoised mount-time "Idle" must not survive this refresh.
latestRun.set("alpha", { latest: run("a2", "ok", HOUR), lastGood: run("a2", "ok", HOUR) });
latestRun.set("bravo", { latest: run("b1", "failed", HOUR, "boom"), lastGood: run("b0", "ok", 2 * HOUR) });
table.setRows([dp("alpha", { lastRunId: "a2" }), dp("bravo", { lastRunId: "b1" })]);
ok("facts filled + setRows: alpha reads Ok (was the frozen Idle)", stateCell(table.el, "alpha").includes("Ok"));
ok("facts filled + setRows: alpha no longer reads Idle", !stateCell(table.el, "alpha").includes("Idle"));
ok("facts filled + setRows: bravo reads Failed", stateCell(table.el, "bravo").includes("Failed"));
ok("facts filled + setRows: bravo carries the failure reason", stateCell(table.el, "bravo").includes("boom"));
ok("facts filled + setRows: alpha Last-run left the loading hint", !lastRunCell(table.el, "alpha").includes("loading"));

// A later poll after a new run lands and fails: the verdict must keep tracking the facts,
// not just leave the first-fill value in place.
latestRun.set("alpha", { latest: run("a3", "failed", HOUR / 2, "dest write refused"), lastGood: run("a2", "ok", HOUR) });
table.setRows([dp("alpha", { lastRunId: "a3" }), dp("bravo", { lastRunId: "b1" })]);
ok("next poll (new failed run): alpha reads Failed", stateCell(table.el, "alpha").includes("Failed"));

// A run in flight on a later poll reads Running.
table.setRows([dp("alpha", { lastRunId: "a3", inFlight: true }), dp("bravo", { lastRunId: "b1" })]);
ok("next poll (run in flight): alpha reads Running", stateCell(table.el, "alpha").includes("Running"));

// A pause taken from another surface lands on the next poll.
table.setRows([dp("alpha", { lastRunId: "a3", config: { ...dp("alpha").config, enabled: false } }), dp("bravo", { lastRunId: "b1" })]);
ok("next poll (disabled): alpha reads Paused", stateCell(table.el, "alpha").includes("Paused"));

// The Schedule column must show the schedule the engine ACTUALLY applies. A downpipe with a cron schedule
// is scheduled off the cron, not cadenceSeconds, so its Schedule cell must show the cron and NEVER the cadence
// label ("Daily"). A plain-interval downpipe still reads its cadence. The Schedule column is td[2].
{
  const scheduleCell = (root: unknown, name: string): string => {
    for (const tr of qsa(root as never, "tbody tr")) {
      const tds = qsa(tr, "td");
      const rowName = (tds[0] as unknown as { textContent: string } | undefined)?.textContent ?? "";
      if (rowName.startsWith(name)) return (tds[2] as unknown as { textContent: string }).textContent;
    }
    return "(row not found)";
  };
  const cronRow = dp("weekly", { config: { ...dp("weekly").config, schedule: { cron: "0 0 * * 0" } } });
  const t2 = buildTable(engine, [cronRow, dp("plain")], new Map(), new URLSearchParams(), false, noop, destinationFromStatus(null));
  ok("a cron downpipe's Schedule cell shows the cron, not the cadence label", scheduleCell(t2.el, "weekly").includes("0 0 * * 0") && !scheduleCell(t2.el, "weekly").toLowerCase().includes("daily"));
  ok("a plain-interval downpipe's Schedule cell still shows its cadence", scheduleCell(t2.el, "plain").toLowerCase().includes("daily"));
}

console.log("");
if (failures > 0) {
  console.log(`VALIDATE-FRESHNESS-TABLE: ${failures} FAILED`);
  process.exit(1);
}
console.log("VALIDATE-FRESHNESS-TABLE VECTORS PASS");
