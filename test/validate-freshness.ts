// Validate the SHARED freshness rule and the corrected observed-churn seed.
// Run with: node test/validate-freshness.ts
//
// Coverage:
//   Overview and Map must agree on freshness, on ONE rule that matches the engine's
//   authority (engine/src/notify.ts classify): staleness is measured from the last SUCCESSFUL
//   run, and a run currently IN-FLIGHT does NOT reset staleness. The headline regression is an
//   in-flight-but-stale fleet: the dashboard (overview.ts summariseFleet) used to short-circuit
//   to "in-flight" (folded into Healthy) and mask the stale signal, while the map (map.ts
//   deriveStatus) correctly read "stale". This suite drives the REAL screen functions
//   (summariseFleet / mapDownpipesToFlows) plus the shared classifyFreshness across the
//   freshness matrix and asserts the two surfaces agree, that the running cue survives a stale
//   reading, and that the fleet roll-up counts the stale pipe as stale (not Healthy).
//
//   The observed-churn seed (overview.ts observedCostSeed) must derive from actual
//   per-run byte deltas, not collapse to 1/N (the run count). This asserts the seeded churn
//   moves with the byte VOLUME/shape (a seal-heavy fleet reads low, a churn-heavy fleet reads
//   high) at a FIXED run count, is scale-invariant (a pure fraction), and stays steady as the
//   run count grows for a fixed seal+incremental shape (the 1/N collapse would have halved it).
//
// Note: overview.ts / map.ts import DOM modules (lib/dom.ts, components/*), but none execute
// DOM calls at module level, so the imports succeed in Node.js and the pure functions
// (summariseFleet, mapDownpipesToFlows, classifyFreshness, observedCostSeed) are callable
// without a DOM (the same pattern validate-palette.ts uses).

import { summariseFleet, observedCostSeed } from "../src/screens/overview.ts";
import { mapDownpipesToFlows, classifyFreshness } from "../src/screens/map.ts";
import type { Downpipe, DownpipeState, RunHistoryEntry, StatusReport } from "../src/api.ts";

let failures = 0;

function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function eq<T>(label: string, got: T, want: T): void {
  const cond = got === want;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

function approx(label: string, got: number, want: number, tol = 1e-9): void {
  const cond = Number.isFinite(got) && Math.abs(got - want) <= tol;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${got} want~=${want}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
const HOUR = 3_600_000;
const NOW = Date.now();
const CADENCE_SECONDS = 86_400; // daily; STALE tolerance is 1.5x => 36h.
const STALE_GOOD_AT = new Date(NOW - 3 * 24 * HOUR).toISOString(); // 72h ago > 36h => stale
const FRESH_GOOD_AT = new Date(NOW - 1 * HOUR).toISOString(); // 1h ago => fresh
const NOW_ISO = new Date(NOW).toISOString();

function config(id: string): Downpipe {
  return { id, name: id, cadenceSeconds: CADENCE_SECONDS, enabled: true, source: { type: "kv", binding: "KV", include: [], exclude: [] } };
}

function state(id: string, inFlight: boolean): DownpipeState {
  return { config: config(id), nextRunAt: NOW + CADENCE_SECONDS * 1000, lastRunId: `${id}-x`, inFlight };
}

const STATUS: StatusReport = {
  service: "downpipes", engineVersion: "test", signerConfigured: true, breakGlassConfigured: true,
  operationalConfigured: { public: true, private: true }, destConfigured: true, destKind: "r2",
  updateChannelConfigured: false, licenceConfigured: false, downpipeCount: 1, ready: true,
};

// Run summariseFleet (overview) and mapDownpipesToFlows (map) over the SAME single-downpipe
// history + config, returning the dashboard row and the map flow for the one pipe.
function bothSurfaces(id: string, ring: RunHistoryEntry[], inFlightFlag: boolean) {
  const dp = state(id, inFlightFlag);
  const fleet = summariseFleet({
    health: { ok: true, value: { ok: true } },
    status: { ok: true, value: STATUS },
    licence: { ok: false, error: new Error("not loaded") },
    updates: { ok: false, error: new Error("not loaded") },
    history: { ok: true, value: { [id]: ring } },
    downpipes: { ok: true, value: [dp] },
    drillEvidence: { ok: false, error: new Error("not loaded") },
    audit: { ok: false, error: new Error("not loaded") },
    // Required on OverviewData, not exercised by a freshness test.
    approvals: { ok: false, error: new Error("not loaded") },
    discovery: { ok: false, error: new Error("not loaded") },
  }, NOW);
  const flows = mapDownpipesToFlows({
    downpipes: { ok: true, value: [dp] },
    history: { ok: true, value: { [id]: ring } },
    status: { ok: true, value: STATUS },
    // The destination read names the node only; freshness is independent of it.
    destination: { ok: false, error: new Error("not loaded") },
    // Required on MapData and equally irrelevant here: freshness is computed from the run history,
    // not from where copies landed. Marked not-loaded rather than faked, which is this file's
    // convention for a read a test does not exercise.
    destinations: { ok: false, error: new Error("not loaded") },
    replication: { ok: false, error: new Error("not loaded") },
  }, NOW);
  return { fleet, row: fleet.rows[0]!, flow: flows[0]! };
}

// The map renders the shared core "in-flight" (a healthy-pending first run) as "healthy" and
// carries in-flight via the running flag; translate the overview Freshness the same way before
// comparing the two surfaces' STATUS vocabularies.
function asMapStatus(freshness: string): string {
  return freshness === "in-flight" ? "healthy" : freshness;
}

// ===========================================================================
// CON-H4: the headline regression -- an in-flight run over an OLDER GOOD run.
// ===========================================================================
console.log("\n-- CON-H4: in-flight-but-stale fleet (the masked case) --");

{
  // newest-first ring: a run currently in-flight on top of a last-good run that is 3 days old.
  const ring: RunHistoryEntry[] = [
    { runId: "r2", index: 1, startedAt: NOW_ISO, status: "in-flight" },
    { runId: "r1", index: 0, startedAt: STALE_GOOD_AT, status: "ok", archiveBytesWritten: 100, segmentsWritten: 1 },
  ];
  const { fleet, row, flow } = bothSurfaces("dp", ring, true);

  // The core authority: an in-flight run does not reset staleness, so the last good run's age governs.
  eq("classifyFreshness(in-flight over stale good) === stale",
    classifyFreshness({ enabled: true, hasConfig: true, haveHistory: true, haveDownpipes: true, latestStatus: "in-flight", lastGoodAt: STALE_GOOD_AT, cadenceSeconds: CADENCE_SECONDS, now: NOW, pendingWhenNoRuns: true }),
    "stale");

  // The two surfaces must agree, and both must read STALE (not a masking in-flight/healthy).
  eq("overview summariseFleet row.freshness === stale", row.freshness, "stale");
  eq("map mapDownpipesToFlows flow.status === stale", flow.status, "stale");
  ok("overview and map AGREE on freshness (stale)", asMapStatus(row.freshness) === flow.status);

  // The running cue must SURVIVE the stale reading (the run still animates), carried separately.
  ok("overview row.inFlight cue is preserved (true)", row.inFlight === true);
  ok("map flow.running cue is preserved (true)", flow.running === true);

  // The fleet roll-up must count the pipe as stale -- so the stale banner / needs-me / Stale
  // pill all fire -- and NOT fold it into in-flight/Healthy (which is what masked it before).
  eq("fleet.stale counts the stuck pipe (1)", fleet.stale, 1);
  eq("fleet.inFlight does NOT count it (0)", fleet.inFlight, 0);
  eq("fleet.healthy does NOT count it (0)", fleet.healthy, 0);
  // The Healthy pill is healthy + inFlight (fleetCounts); it must be 0 for a lone stuck pipe.
  eq("Healthy pill (healthy + inFlight) === 0", fleet.healthy + fleet.inFlight, 0);
}

// ===========================================================================
// CON-H4: full freshness matrix -- overview and map agree on every case.
// ===========================================================================
console.log("\n-- CON-H4: overview/map parity across the freshness matrix --");

interface MatrixCase { label: string; ring: RunHistoryEntry[]; inFlightFlag: boolean; expect: string; }
const matrix: MatrixCase[] = [
  {
    label: "in-flight over STALE good -> stale",
    ring: [
      { runId: "b", index: 1, startedAt: NOW_ISO, status: "in-flight" },
      { runId: "a", index: 0, startedAt: STALE_GOOD_AT, status: "ok", archiveBytesWritten: 1, segmentsWritten: 1 },
    ],
    inFlightFlag: true, expect: "stale",
  },
  {
    label: "in-flight over FRESH good -> healthy",
    ring: [
      { runId: "b", index: 1, startedAt: NOW_ISO, status: "in-flight" },
      { runId: "a", index: 0, startedAt: FRESH_GOOD_AT, status: "ok", archiveBytesWritten: 1, segmentsWritten: 1 },
    ],
    inFlightFlag: true, expect: "healthy",
  },
  {
    label: "in-flight FIRST run, no good run -> healthy-pending",
    ring: [{ runId: "b", index: 0, startedAt: NOW_ISO, status: "in-flight" }],
    inFlightFlag: true, expect: "healthy",
  },
  {
    label: "plain STALE good, no in-flight -> stale",
    ring: [{ runId: "a", index: 0, startedAt: STALE_GOOD_AT, status: "ok", archiveBytesWritten: 1, segmentsWritten: 1 }],
    inFlightFlag: false, expect: "stale",
  },
  {
    label: "plain FRESH good -> healthy",
    ring: [{ runId: "a", index: 0, startedAt: FRESH_GOOD_AT, status: "ok", archiveBytesWritten: 1, segmentsWritten: 1 }],
    inFlightFlag: false, expect: "healthy",
  },
  {
    label: "latest FAILED over stale good -> failed",
    ring: [
      { runId: "b", index: 1, startedAt: NOW_ISO, status: "failed" },
      { runId: "a", index: 0, startedAt: STALE_GOOD_AT, status: "ok", archiveBytesWritten: 1, segmentsWritten: 1 },
    ],
    inFlightFlag: false, expect: "failed",
  },
];

for (const c of matrix) {
  const { row, flow } = bothSurfaces("dp", c.ring, c.inFlightFlag);
  // Compare in the map's status vocabulary (in-flight-pending -> healthy on both screens).
  eq(`map status: ${c.label}`, flow.status, c.expect);
  ok(`overview agrees with map: ${c.label}`, asMapStatus(row.freshness) === flow.status);
}

// ===========================================================================
// CON-H4: disabled is an honesty rule and is the same on both surfaces.
// ===========================================================================
console.log("\n-- CON-H4: disabled (paused is not a failure) parity --");
{
  const id = "dp";
  const ring: RunHistoryEntry[] = [{ runId: "a", index: 0, startedAt: STALE_GOOD_AT, status: "ok" }];
  const dp: DownpipeState = { config: { ...config(id), enabled: false }, nextRunAt: NOW, lastRunId: "a", inFlight: false };
  const fleet = summariseFleet({
    health: { ok: true, value: { ok: true } }, status: { ok: true, value: STATUS },
    licence: { ok: false, error: 1 }, updates: { ok: false, error: 1 },
    history: { ok: true, value: { [id]: ring } }, downpipes: { ok: true, value: [dp] },
    drillEvidence: { ok: false, error: 1 }, audit: { ok: false, error: 1 },
    // Required on OverviewData and not exercised by a freshness test, so marked not-loaded rather
    // than faked, matching every other read in this fixture.
    approvals: { ok: false, error: 1 }, discovery: { ok: false, error: 1 },
  }, NOW);
  const flow = mapDownpipesToFlows({ downpipes: { ok: true, value: [dp] }, history: { ok: true, value: { [id]: ring } }, status: { ok: true, value: STATUS }, destination: { ok: false, error: 1 }, destinations: { ok: false, error: 1 }, replication: { ok: false, error: 1 } }, NOW)[0]!;
  eq("disabled pipe: overview freshness === disabled", fleet.rows[0]!.freshness, "disabled");
  eq("disabled pipe: map status === disabled", flow.status, "disabled");
  ok("disabled pipe: a stale good run does NOT make it stale (honesty rule)", fleet.rows[0]!.freshness === "disabled" && flow.status === "disabled");
}

// ===========================================================================
// CON-H4: unreadable history reads unknown (never a fake green or fake stale).
// ===========================================================================
console.log("\n-- CON-H4: unreadable history -> unknown parity --");
{
  const id = "dp";
  const dp = state(id, false);
  const fleet = summariseFleet({
    health: { ok: true, value: { ok: true } }, status: { ok: true, value: STATUS },
    licence: { ok: false, error: 1 }, updates: { ok: false, error: 1 },
    history: { ok: false, error: new Error("history unreadable") }, downpipes: { ok: true, value: [dp] },
    drillEvidence: { ok: false, error: 1 }, audit: { ok: false, error: 1 },
    // Required on OverviewData and not exercised by a freshness test, so marked not-loaded rather
    // than faked, matching every other read in this fixture.
    approvals: { ok: false, error: 1 }, discovery: { ok: false, error: 1 },
  }, NOW);
  const flow = mapDownpipesToFlows({ downpipes: { ok: true, value: [dp] }, history: { ok: false, error: new Error("history unreadable") }, status: { ok: true, value: STATUS }, destination: { ok: false, error: 1 }, destinations: { ok: false, error: 1 }, replication: { ok: false, error: 1 } }, NOW)[0]!;
  eq("history unreadable: overview freshness === unknown", fleet.rows[0]!.freshness, "unknown");
  eq("history unreadable: map status === unknown", flow.status, "unknown");
}

// ===========================================================================
// CON-H4: classifyFreshness is the engine-authority rule (direct unit checks).
// ===========================================================================
console.log("\n-- CON-H4: classifyFreshness engine-authority precedence --");
{
  const base = { hasConfig: true, haveHistory: true, haveDownpipes: true, cadenceSeconds: CADENCE_SECONDS, now: NOW } as const;
  // Staleness from the last good run, regardless of an in-flight run on top.
  eq("in-flight + stale good => stale", classifyFreshness({ ...base, enabled: true, latestStatus: "in-flight", lastGoodAt: STALE_GOOD_AT }), "stale");
  eq("in-flight + fresh good => healthy", classifyFreshness({ ...base, enabled: true, latestStatus: "in-flight", lastGoodAt: FRESH_GOOD_AT }), "healthy");
  // in-flight is a status ONLY when there is no usable last-good run (a healthy-pending first run).
  eq("in-flight + no good => in-flight (pending)", classifyFreshness({ ...base, enabled: true, latestStatus: "in-flight", lastGoodAt: null }), "in-flight");
  // failed always outranks a (stale) good run.
  eq("failed latest => failed", classifyFreshness({ ...base, enabled: true, latestStatus: "failed", lastGoodAt: STALE_GOOD_AT }), "failed");
  // disabled outranks everything.
  eq("disabled => disabled", classifyFreshness({ ...base, enabled: false, latestStatus: "ok", lastGoodAt: FRESH_GOOD_AT }), "disabled");
  // No cadence to judge against: a good run reads healthy (we have a backup).
  eq("good run, no cadence => healthy", classifyFreshness({ ...base, cadenceSeconds: null, enabled: true, latestStatus: "ok", lastGoodAt: STALE_GOOD_AT }), "healthy");
  // NDH-overview-stale-config-read regression: the "no cadence => healthy" reading holds ONLY when
  // we actually hold this pipe's config. If the config read failed this poll (hasConfig:false, so
  // there is no cadence to judge against) while history keeps serving an old good run, that pipe
  // must NOT read healthy - without the config we cannot back a freshness claim, so it is honest
  // "unknown". Otherwise a pipe correctly reading "stale" on a good load silently upgrades to
  // "Fleet is healthy" the moment only the downpipes/config read fails. Default-FAILs the old code.
  eq("good old run but CONFIG unreadable (no cadence) => unknown, NOT healthy",
    classifyFreshness({ ...base, hasConfig: false, haveDownpipes: false, cadenceSeconds: null, enabled: true, latestStatus: "ok", lastGoodAt: STALE_GOOD_AT }), "unknown");
  // A pipe dropped from config (list read OK, this pipe absent) with a lingering old run is the
  // same honesty case: no config to back a green claim => unknown, not a stale-masking healthy.
  eq("good old run, pipe dropped from config (no cadence) => unknown",
    classifyFreshness({ ...base, hasConfig: false, haveDownpipes: true, cadenceSeconds: null, enabled: true, latestStatus: "ok", lastGoodAt: STALE_GOOD_AT }), "unknown");
  // The pendingWhenNoRuns policy difference between the two screens (the only divergence).
  eq("no runs, pendingWhenNoRuns=true (dashboard) => healthy", classifyFreshness({ ...base, enabled: true, latestStatus: "none", lastGoodAt: null, pendingWhenNoRuns: true }), "healthy");
  eq("no runs, pendingWhenNoRuns=false (map) => unknown", classifyFreshness({ ...base, enabled: true, latestStatus: "none", lastGoodAt: null, pendingWhenNoRuns: false }), "unknown");
}

// ===========================================================================
// CON-H14: the observed-churn seed moves with byte volume, not just run count.
// ===========================================================================
console.log("\n-- CON-H14: observed-churn seed (no 1/N collapse) --");

// Build N runs across one downpipe carrying the given per-run archive byte sizes.
function seedFor(bytes: number[]): { churnFraction: number; sourceBytes: number } {
  const ring: RunHistoryEntry[] = bytes.map((b, i) => ({
    runId: `r${i}`, index: i,
    startedAt: new Date(NOW - (bytes.length - i) * HOUR).toISOString(),
    status: "ok", archiveBytesWritten: b, segmentsWritten: 1,
  }));
  const seed = observedCostSeed({ dp: ring });
  ok(`observedCostSeed returns a seed for ${bytes.length} runs`, seed !== null);
  return { churnFraction: seed!.inputs.churnFraction, sourceBytes: seed!.inputs.sourceBytes };
}

// Seal-heavy: a dominant first seal then tiny incrementals => LOW churn (a near-static source).
const sealHeavy = seedFor([1000, 10, 10, 10, 10]);
// Churn-heavy: large ongoing per-run deltas => HIGH churn.
const churnHeavy = seedFor([1000, 800, 800, 800, 800]);
// Uniform runs: no distinguishable seal structure; this is the degenerate 1/N reading.
const uniform = seedFor([200, 200, 200, 200, 200]);

// The CORE CON-H14 contract: at the SAME run count (N=5), churn moves with the byte shape.
ok("seal-heavy churn < churn-heavy churn (moves with byte volume, not just N)", sealHeavy.churnFraction < churnHeavy.churnFraction);
ok("seal-heavy churn is small (a near-static source reads low)", sealHeavy.churnFraction < 0.05);
ok("churn-heavy churn is large (a churning source reads high)", churnHeavy.churnFraction > 0.15);

// The old 1/N formula would have made ALL three of these read exactly 0.2 at N=5; prove the
// seal-heavy and churn-heavy readings are NOT that degenerate value (the byte volumes matter).
ok("seal-heavy churn is NOT the old 1/N value (0.2)", Math.abs(sealHeavy.churnFraction - 0.2) > 1e-6);
ok("churn-heavy churn is NOT the old 1/N value (0.2)", Math.abs(churnHeavy.churnFraction - 0.2) > 1e-6);

// Scale invariance: churn is a dimensionless FRACTION, so scaling every run by 1000x leaves it
// unchanged (only sourceBytes scales). The old formula was also scale-invariant; this just
// guards that the corrected formula stays a proper fraction.
const sealHeavyScaled = seedFor([1_000_000, 10_000, 10_000, 10_000, 10_000]);
approx("churn is scale-invariant (x1000 source => same churn)", sealHeavyScaled.churnFraction, sealHeavy.churnFraction, 1e-12);
ok("sourceBytes DOES scale with byte volume (x1000)", sealHeavyScaled.sourceBytes > sealHeavy.sourceBytes * 900);

// No 1/N collapse as N grows: extend the seal-heavy fleet with more tiny incrementals. Under
// the old 1/N rule the churn would have HALVED from 0.2 (N=5) to 0.1 (N=10); the corrected
// estimator stays ~steady because the seal-vs-incremental SHAPE is unchanged.
const sealHeavyN10 = seedFor([1000, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
ok("churn does NOT collapse toward 1/N as N grows (stays << old 0.1 at N=10)", sealHeavyN10.churnFraction < 0.05);
ok("seal-heavy churn at N=10 is close to N=5 (shape-driven, not count-driven)", Math.abs(sealHeavyN10.churnFraction - sealHeavy.churnFraction) < 0.01);

// The churn is a valid fraction in [0, 1] for every fixture above.
for (const [name, c] of [["seal-heavy", sealHeavy.churnFraction], ["churn-heavy", churnHeavy.churnFraction], ["uniform", uniform.churnFraction], ["seal-heavy N=10", sealHeavyN10.churnFraction]] as const) {
  ok(`churn(${name}) is a valid fraction in [0,1]`, c >= 0 && c <= 1);
}

// ===========================================================================
// OBS-CONSOLE-1: a PARTIAL engine response degrades, never throws.
// A settled result can be ok:true yet carry an undefined value (the type promises a map /
// list; the wire does not). The fleet roll-up must coalesce and render an honest empty
// reading rather than throwing on Object.keys/Object.values and blanking the whole overview.
// ===========================================================================
console.log("\n-- OBS-CONSOLE-1: partial engine response degrades honestly --");

{
  // history.ok === true but value is undefined (a partial/truncated response).
  const partial = {
    health: { ok: true as const, value: { ok: true } },
    status: { ok: true as const, value: STATUS },
    licence: { ok: false as const, error: new Error("not loaded") },
    updates: { ok: false as const, error: new Error("not loaded") },
    history: { ok: true as const, value: undefined as unknown as Record<string, RunHistoryEntry[]> },
    downpipes: { ok: true as const, value: undefined as unknown as DownpipeState[] },
    drillEvidence: { ok: false as const, error: new Error("not loaded") },
    audit: { ok: false as const, error: new Error("not loaded") },
    approvals: { ok: false as const, error: new Error("not loaded") },
    discovery: { ok: false as const, error: new Error("not loaded") },
  };
  let threw = false;
  let summary: ReturnType<typeof summariseFleet> | null = null;
  try {
    summary = summariseFleet(partial, NOW);
  } catch {
    threw = true;
  }
  ok("summariseFleet(undefined history+downpipes) does NOT throw", !threw);
  ok("partial fleet degrades to an honest empty roll-up (total 0)", summary !== null && summary.total === 0);
  ok("partial fleet reports no runs (anyRuns false)", summary !== null && summary.anyRuns === false);
  ok("partial fleet rows is an empty array", summary !== null && summary.rows.length === 0);

  // observedCostSeed must survive an undefined history map the same way (Object.keys guard).
  let costThrew = false;
  let seed: ReturnType<typeof observedCostSeed> | undefined;
  try {
    seed = observedCostSeed(undefined as unknown as Record<string, RunHistoryEntry[]>);
  } catch {
    costThrew = true;
  }
  ok("observedCostSeed(undefined map) does NOT throw", !costThrew);
  ok("observedCostSeed(undefined map) returns null (no runs to seed)", seed === null);
}

// ---------------------------------------------------------------------------
console.log("");
if (failures > 0) {
  console.log(`VALIDATE-FRESHNESS: ${failures} FAILED`);
  process.exit(1);
}
console.log("VALIDATE-FRESHNESS VECTORS PASS");
