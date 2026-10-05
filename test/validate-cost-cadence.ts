// Validates the cost estimate's cadence seed (src/lib/cost-cadence.ts, used by the Costs screen's
// summariseHistory and the overview's observedCostSeed): runs a month come from what the engine SCHEDULES
// for each downpipe, not from the gaps between every recorded run in the account.
//
// THE DEFECT THIS PINS. The observed seed took the mean gap between run start times across EVERY
// downpipe, manual runs included. A new daily downpipe tested with six manual runs four minutes apart
// seeded 30.44 x 86,400 / 240 = 10,958.4 runs a month, and two daily downpipes staggered by twelve hours
// seeded one downpipe running twice a day. Every expectation below is computed by hand in the comment
// beside it, independent of the library. Run: node test/validate-cost-cadence.ts
//
// The engine constants the derivation mirrors (the 15-minute dispatch tick and the 10 per cent early
// jitter) are checked against the engine's own source by test/validate-cost-cadence-engine-mirror.ts.

import type { Downpipe, RunHistoryEntry } from "../src/api.ts";
import {
  cadenceRunsPerMonth,
  cronRunsPerMonth,
  deriveAccountCadence,
  runGapRunsPerMonth,
  scheduledRunsPerMonth,
  shortestCadenceGapSeconds,
} from "../src/lib/cost-cadence.ts";
import { monthlyCost, PRESETS, rollupStorage } from "../src/lib/cost-model.ts";
import { describeCadenceBasis } from "../src/screens/costs/cadence-basis.ts";
import { costBySourceType, summariseHistory } from "../src/screens/costs.ts";
import { observedCostSeed } from "../src/screens/overview.ts";
import { executiveAnswers } from "../src/screens/overview/executive.ts";
import { summariseFleet } from "../src/screens/overview/fleet-data.ts";
import type { OverviewData } from "../src/screens/overview/shared.ts";
import { money } from "../src/screens/costs/helpers.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function approx(label: string, got: number, want: number, tol = 1e-9): void {
  checks++;
  const cond = Math.abs(got - want) <= tol * Math.max(1, Math.abs(want));
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${got} want=${want}`);
  if (!cond) failures++;
}

// The month the model averages over: DAYS_PER_MONTH (30.44) days of seconds.
const MONTH_S = 30.44 * 86_400; // 2,630,016

// A configured downpipe, as listDownpipes returns its config. Only id, name, cadenceSeconds, enabled and
// schedule are read by the derivation.
function downpipe(id: string, cadenceSeconds: number, extra: Partial<Downpipe> = {}): Downpipe {
  return { id, name: id, cadenceSeconds, enabled: true, source: { type: "kv" } as Downpipe["source"], ...extra };
}

// A completed run carrying the per-run byte counts the observed seed reads.
function run(id: string, startedAt: string, archiveBytes: number, segments = 8): RunHistoryEntry {
  return { runId: id, index: 0, startedAt, status: "ok", archiveBytesWritten: archiveBytes, segmentsWritten: segments };
}

// 12 GB of logical source at the default 60 per cent stored ratio writes 7.2e9 stored bytes a run.
const RUN_12GB = 7.2e9;
const RUN_1GB = 0.6e9;

// ============================================================================
// 1. THE CADENCE PATH: the most runs the engine can start
// ============================================================================
console.log("\n-- 1. cadence path: shortest gap = (floor(0.9 x cadence / 900) + 1) x 900 --");
// Daily: 0.9 x 86,400 = 77,760 s = 86.4 ticks -> 87 ticks = 78,300 s (21 h 45 min).
approx("daily: shortest gap 78,300 s", shortestCadenceGapSeconds(86_400) ?? -1, 78_300);
approx("daily: 2,630,016 / 78,300 = 33.5890 runs a month", cadenceRunsPerMonth(86_400), MONTH_S / 78_300);
// Hourly: 0.9 x 3,600 = 3,240 s = 3.6 ticks -> 4 ticks = 3,600 s. The tick absorbs the early start.
approx("hourly: 2,630,016 / 3,600 = 730.56 runs a month", cadenceRunsPerMonth(3_600), 730.56);
// Every 6 hours: 0.9 x 21,600 = 19,440 s = 21.6 ticks -> 22 ticks = 19,800 s.
approx("every 6 hours: 2,630,016 / 19,800 = 132.8291 runs a month", cadenceRunsPerMonth(21_600), MONTH_S / 19_800);
// Weekly: 0.9 x 604,800 = 544,320 s = 604.8 ticks -> 605 ticks = 544,500 s.
approx("weekly: 2,630,016 / 544,500 = 4.8301 runs a month", cadenceRunsPerMonth(604_800), MONTH_S / 544_500);
// 60 s (the engine's floor): below one tick, so one run a tick: 2,630,016 / 900 = 2,922.24.
approx("60 s: one run a 15-minute tick = 2,922.24 runs a month", cadenceRunsPerMonth(60), 2_922.24);
// 1,000 minutes: 0.9 x 60,000 = 54,000 s = exactly 60 ticks. The next run is due strictly AFTER that
// instant (the jitter is strictly below a tenth), so it starts on tick 61: 54,900 s.
approx("1,000 minutes: an exact tick multiple rounds to the NEXT tick (54,900 s)", shortestCadenceGapSeconds(60_000) ?? -1, 54_900);
ok("a non-positive cadence has no gap", shortestCadenceGapSeconds(0) === null && cadenceRunsPerMonth(-1) === 0);

// ============================================================================
// 2. THE CRON PATH: distinct 15-minute ticks over four whole years (1,461 days)
// ============================================================================
console.log("\n-- 2. cron path --");
// One fire a day on 1,461 days: 1,461 x 30.44 / 1,461 = 30.44.
approx("0 2 * * *: 30.44 runs a month", cronRunsPerMonth("0 2 * * *") ?? -1, 30.44);
// Four fires an hour on the tick: 96 a day, 96 x 30.44 = 2,922.24.
approx("*/15 * * * *: 2,922.24 runs a month", cronRunsPerMonth("*/15 * * * *") ?? -1, 2_922.24);
// Every 5 minutes: 12 fires an hour but only the ticks they start on count. Minutes 1-15 start on :15,
// 16-30 on :30, 31-45 on :45, and 50 and 55 on the next hour's :00 tick, the same tick as that hour's :00
// fire. So 96 ticks a day, plus the final day's 23:50 and 23:55 fires, which land just after the window's end:
// 1,461 x 96 + 1 = 140,257 runs.
approx("*/5 * * * *: 140,257 x 30.44 / 1,461 runs a month (fires collapse onto the tick)", cronRunsPerMonth("*/5 * * * *") ?? -1, (140_257 * 30.44) / 1_461);
// Mondays: the first Monday falls 5 days into the window; floor((1,460 - 5) / 7) + 1 = 208 Mondays in the window.
approx("30 3 * * 1: 208 Mondays x 30.44 / 1,461", cronRunsPerMonth("30 3 * * 1") ?? -1, (208 * 30.44) / 1_461);
// The first of each month: 48 in four years, 48 x 30.44 / 1,461 = 1.00008.
approx("0 2 1 * *: 48 x 30.44 / 1,461 (monthly)", cronRunsPerMonth("0 2 1 * *") ?? -1, (48 * 30.44) / 1_461);
// Vixie union: the 1st OR a Monday. 48 + 208 minus the 7 firsts that are Mondays (one in each of seven
// months across the four-year window) = 249.
approx("0 2 1 * 1: 249 x 30.44 / 1,461 (day-of-month OR day-of-week)", cronRunsPerMonth("0 2 1 * 1") ?? -1, (249 * 30.44) / 1_461);
// 29 February: once in the window (2028).
approx("0 0 29 2 *: 1 x 30.44 / 1,461", cronRunsPerMonth("0 0 29 2 *") ?? -1, 30.44 / 1_461);
ok("30 February never fires: null (the engine falls back to the cadence)", cronRunsPerMonth("0 0 30 2 *") === null);
ok("a malformed cron: null", cronRunsPerMonth("0 25 * * *") === null && cronRunsPerMonth("@daily") === null);

// ============================================================================
// 3. ONE DOWNPIPE'S SCHEDULE, in the engine's dispatch order
// ============================================================================
console.log("\n-- 3. scheduledRunsPerMonth --");
{
  const cron = scheduledRunsPerMonth(downpipe("a", 86_400, { schedule: { cron: "0 */6 * * *", timeZone: "Australia/Sydney" } }));
  ok("a resolvable cron is counted from the cron", cron.how === "cron");
  approx("0 */6 * * *: 4 x 30.44 = 121.76 runs a month", cron.runsPerMonth, 121.76);
  const badZone = scheduledRunsPerMonth(downpipe("b", 86_400, { schedule: { cron: "0 2 * * *", timeZone: "Mars/Olympus" } }));
  ok("an unknown time zone runs on the cadence (engine tz-invalid fallback)", badZone.how === "cron-fallback");
  approx("that fallback counts the daily cadence: 33.5890", badZone.runsPerMonth, MONTH_S / 78_300);
  const never = scheduledRunsPerMonth(downpipe("c", 3_600, { schedule: { cron: "0 0 30 2 *" } }));
  ok("a cron with no fire runs on the cadence (engine no-next-fire fallback)", never.how === "cron-fallback");
  approx("that fallback counts the hourly cadence: 730.56", never.runsPerMonth, 730.56);
  const windowsOnly = scheduledRunsPerMonth(downpipe("d", 86_400, { schedule: { blackoutWindows: [{ startMinute: 60, endMinute: 240 }] } }));
  ok("blackout windows alone keep the cadence path (they only delay a run)", windowsOnly.how === "cadence");
  approx("blackout windows are not counted: still 33.5890", windowsOnly.runsPerMonth, MONTH_S / 78_300);
  const paused = scheduledRunsPerMonth(downpipe("e", 86_400, { enabled: false }));
  ok("a disabled downpipe starts no scheduled run", paused.how === "paused" && paused.runsPerMonth === 0);
}

// ============================================================================
// 4. THE REPORTED DEFECT, through the screen's own summariseHistory
// ============================================================================
console.log("\n-- 4. a burst of manual runs and several downpipes --");
{
  // A new daily downpipe of a 12 GB source, tested by hand six times, four minutes apart.
  const burst = Array.from({ length: 6 }, (_, i) => run(`m${i}`, new Date(Date.UTC(2026, 8, 25, 1, 4 * i)).toISOString(), RUN_12GB));
  const load = summariseHistory({ "prod-kv": burst }, [downpipe("prod-kv", 86_400)]);
  ok("burst: the load is seedable", load.kind === "seedable");
  if (load.kind === "seedable") {
    // Before: 30.44 x 86,400 / 240 = 10,958.4 runs a month. After: the daily schedule, 33.5890.
    approx("burst: runs a month = the daily schedule, 2,630,016 / 78,300 (not 10,958.4)", load.seed.runsPerMonth, MONTH_S / 78_300);
    approx("burst: source size = 7.2e9 / 0.6 = 12e9", load.seed.sourceBytes, 12e9);
    ok("burst: the basis records the schedule of prod-kv", load.cadence.source === "schedule" && load.cadence.counted.length === 1 && load.cadence.counted[0]?.how === "cadence");
    // The figure the finding priced: destination storage at month 12 (accumulate, month midpoint 11.5) at
    // R2's 0.015 a GB-month: (7.2e9 + 65,536) x 33.5890 x 11.5 / 1e9 x 0.015 = 41.72.
    const storage = rollupStorage(load.seed, [PRESETS.r2], { regime: "accumulate", month: 12 }).storage;
    approx("burst: month-12 storage at R2 = (7.2e9 + 65,536) x 33.5890 x 11.5 / 1e9 x 0.015", storage, ((7.2e9 + 65_536) * (MONTH_S / 78_300) * 11.5 * 0.015) / 1e9);
    const text = describeCadenceBasis(load.cadence);
    ok("burst: the line names the downpipe, its schedule, the gap it counts and its runs", text.includes("prod-kv, every day, counted at one run every 21 hours 45 minutes, 33.6 a month"));
  }

  // Two daily downpipes, 12 GB and 1 GB, whose runs start twelve hours apart. Pooled gaps read twelve hours.
  const a = Array.from({ length: 5 }, (_, i) => run(`a${i}`, new Date(Date.UTC(2026, 8, 20 + i, 0)).toISOString(), RUN_12GB));
  const b = Array.from({ length: 5 }, (_, i) => run(`b${i}`, new Date(Date.UTC(2026, 8, 20 + i, 12)).toISOString(), RUN_1GB));
  const both = { "prod-kv": a, "audit-d1": b };
  const configs = [downpipe("prod-kv", 86_400), downpipe("audit-d1", 86_400)];
  const two = summariseHistory(both, configs);
  if (two.kind === "seedable") {
    // Each downpipe 33.5890, so 67.1779 in total.
    approx("two downpipes: runs a month = 2 x 33.5890", two.seed.runsPerMonth, (2 * MONTH_S) / 78_300);
    // Equal run counts, so the weighted mean run is (7.2e9 + 0.6e9) / 2 = 3.9e9, and S = 3.9e9 / 0.6 = 6.5e9.
    approx("two downpipes: source size = (7.2e9 + 0.6e9) / 2 / 0.6 = 6.5e9", two.seed.sourceBytes, 6.5e9);
    // S x d x f is the sum of each downpipe's own runs x bytes: 33.5890 x (7.2e9 + 0.6e9).
    approx("two downpipes: S x d x f = 33.5890 x 7.8e9", two.seed.sourceBytes * 0.6 * two.seed.runsPerMonth, (MONTH_S / 78_300) * 7.8e9, 1e-9);
    // The line names both schedules, says why a daily cadence counts 33.6, and says how source size is set.
    const text = describeCadenceBasis(two.cadence);
    ok("two downpipes: the line names both schedules", text.startsWith("Seeded from the schedules of 2 downpipes: prod-kv, every day, counted at one run every 21 hours 45 minutes, 33.6 a month; audit-d1, every day, counted at one run every 21 hours 45 minutes, 33.6 a month. Total 67.2 runs a month"));
    ok("two downpipes: the line says a cadence run can start early", text.includes("A run on a cadence can start up to 10 per cent early"));
    ok("two downpipes: the line says the source size is weighted by runs a month", text.endsWith("what an average run of these downpipes stored, weighted by their runs a month."));
  } else ok("two downpipes: the load is seedable", false);
  // A cron downpipe starts on its fires, not early, so its line has no early-start sentence.
  const cronOnly = summariseHistory({ "prod-kv": a }, [downpipe("prod-kv", 86_400, { schedule: { cron: "0 2 * * *" } })]);
  if (cronOnly.kind === "seedable") {
    const text = describeCadenceBasis(cronOnly.cadence);
    ok("cron: the line names the cron and 30.4 a month", text.includes("prod-kv, cron 0 2 * * *, 30.4 a month"));
    ok("cron: no early-start sentence (a cron fire is not jittered)", !text.includes("10 per cent early"));
  } else ok("cron: the load is seedable", false);
  // The per-source-type rows count each type's own downpipes only: 33.5890 each, never 67.1779.
  const rows = costBySourceType(both, { "prod-kv": "kv", "audit-d1": "d1" }, [PRESETS.r2], configs);
  const kv = rows.find((r) => r.sourceType === "kv");
  // KV row: (7.2e9 + 65,536) x 33.5890 x 11.5 / 1e9 x 0.015 = 41.72.
  approx("per source type: the KV row prices its own downpipe's schedule", kv?.storageCost ?? -1, ((7.2e9 + 65_536) * (MONTH_S / 78_300) * 11.5 * 0.015) / 1e9);

  // Weighting by schedule: a daily 12 GB downpipe and an hourly 1 GB one. f = 33.5890 + 730.56 = 764.1490.
  const hourly = summariseHistory(both, [downpipe("prod-kv", 86_400), downpipe("audit-d1", 3_600)]);
  if (hourly.kind === "seedable") {
    const fDaily = MONTH_S / 78_300;
    approx("daily + hourly: runs a month = 33.5890 + 730.56", hourly.seed.runsPerMonth, fDaily + 730.56);
    // S x d x f = 33.5890 x 7.2e9 + 730.56 x 0.6e9 = 241.84e9 + 438.34e9 = 680.18e9.
    approx("daily + hourly: S x d x f = 33.5890 x 7.2e9 + 730.56 x 0.6e9", hourly.seed.sourceBytes * 0.6 * hourly.seed.runsPerMonth, fDaily * 7.2e9 + 730.56 * 0.6e9, 1e-9);
  } else ok("daily + hourly: the load is seedable", false);

  // The overview card uses the same derivation, so its seed matches the screen's.
  const ov = observedCostSeed(both, configs);
  ok("overview seed: the same runs a month as the Costs screen", ov !== null && two.kind === "seedable" && Math.abs(ov.inputs.runsPerMonth - two.seed.runsPerMonth) < 1e-9);
  ok("overview seed: the same source size as the Costs screen", ov !== null && two.kind === "seedable" && Math.abs(ov.inputs.sourceBytes - two.seed.sourceBytes) < 1e-3);
}

// ============================================================================
// 5. WHAT IS LEFT OUT, AND THE RUN-GAP FALLBACK
// ============================================================================
console.log("\n-- 5. exclusions and the fallback --");
{
  const daily = (p: string) => Array.from({ length: 3 }, (_, i) => run(`${p}${i}`, new Date(Date.UTC(2026, 8, 20 + i)).toISOString(), RUN_12GB));
  const hist = { live: daily("l"), paused: daily("p"), gone: daily("g") };
  const configs = [downpipe("live", 86_400), downpipe("paused", 86_400, { enabled: false }), downpipe("new", 86_400)];
  const c = deriveAccountCadence(hist, hist, configs);
  approx("only the live downpipe counts: 33.5890", c.runsPerMonth, MONTH_S / 78_300);
  ok("paused 1, no longer configured 1, no measured run 1", c.basis.paused === 1 && c.basis.notConfigured === 1 && c.basis.unmeasured === 1);
  ok("the line says what was left out", describeCadenceBasis(c.basis).includes("Not counted: 1 paused, 1 with no measured run yet, 1 no longer configured."));

  // The downpipe list could not be read: eight daily runs plus a burst of three manual runs four minutes
  // after the last. The ten gaps sorted are 240, 240, 240, then seven of 86,400 s; the median is the mean of
  // the 5th and 6th, 86,400 s, so 30.44 runs a month. (The mean of the gaps would be 60,552 s: 43.43.)
  const ring = [
    ...Array.from({ length: 8 }, (_, i) => run(`d${i}`, new Date(Date.UTC(2026, 8, 10 + i)).toISOString(), RUN_12GB)),
    ...Array.from({ length: 3 }, (_, i) => run(`m${i}`, new Date(Date.UTC(2026, 8, 17, 0, 4 * (i + 1))).toISOString(), RUN_12GB)),
  ];
  approx("run-gap fallback: the median gap, 30.44 runs a month", runGapRunsPerMonth(ring), 30.44);
  const fb = summariseHistory({ solo: ring }, null);
  ok("run-gap fallback: the basis says so", fb.kind === "seedable" && fb.cadence.source === "run-gaps" && describeCadenceBasis(fb.cadence).includes("manual runs can still raise this figure"));
  // Two downpipes on the fallback are NOT pooled: two daily rings give 2 x 30.44, not one twelve-hour cadence.
  const a = Array.from({ length: 4 }, (_, i) => run(`a${i}`, new Date(Date.UTC(2026, 8, 20 + i, 0)).toISOString(), RUN_12GB));
  const b = Array.from({ length: 4 }, (_, i) => run(`b${i}`, new Date(Date.UTC(2026, 8, 20 + i, 12)).toISOString(), RUN_12GB));
  const pooled = summariseHistory({ a, b }, null);
  approx("run-gap fallback: each downpipe's own gaps, 2 x 30.44", pooled.kind === "seedable" ? pooled.seed.runsPerMonth : -1, 60.88);
  const none = deriveAccountCadence({ x: [run("x0", "2026-09-20T00:00:00Z", RUN_12GB)] }, {}, []);
  ok("nothing countable: 0 runs a month, source none", none.runsPerMonth === 0 && none.basis.source === "none");

  // The fallback leaves out gaps under half a tick (450 s), because the engine starts at most one
  // scheduled run a tick. Six manual runs four minutes apart, the first four minutes after the last daily
  // run: the six 240 s gaps are left out, so only the daily gaps remain and the figure is 30.44.
  const burstAfter = (days: number) => [
    ...Array.from({ length: days }, (_, i) => run(`d${i}`, new Date(Date.UTC(2026, 8, 10 + i)).toISOString(), RUN_12GB)),
    ...Array.from({ length: 6 }, (_, i) => run(`m${i}`, new Date(Date.UTC(2026, 8, 10 + days - 1, 0, 4 * (i + 1))).toISOString(), RUN_12GB)),
  ];
  approx("fallback: 6 manual runs after 6 daily runs count 30.44 (not 1,461)", runGapRunsPerMonth(burstAfter(6)), 30.44);
  approx("fallback: 6 manual runs after 3 daily runs count 30.44 (not 10,958)", runGapRunsPerMonth(burstAfter(3)), 30.44);
  // A burst alone leaves no gap to measure, so the downpipe is left out, and the line says why.
  const burstOnly = Array.from({ length: 6 }, (_, i) => run(`b${i}`, new Date(Date.UTC(2026, 8, 25, 1, 4 * i)).toISOString(), RUN_12GB));
  approx("fallback: a burst alone counts 0", runGapRunsPerMonth(burstOnly), 0);
  const alone = deriveAccountCadence({ solo: burstOnly }, { solo: burstOnly }, null);
  ok("fallback: a burst alone is left out as no measurable gap", alone.basis.noGap === 1 && describeCadenceBasis(alone.basis).includes("1 with fewer than two runs 7.5 minutes or more apart"));
  // The cap: runs eight minutes apart (480 s, kept) would be 2,630,016 / 480 = 5,479.2 a month; one run a
  // 15-minute tick is the most a schedule starts, 96 x 30.44 = 2,922.24.
  const eight = Array.from({ length: 5 }, (_, i) => run(`e${i}`, new Date(Date.UTC(2026, 8, 25, 1, 8 * i)).toISOString(), RUN_12GB));
  approx("fallback: capped at one run a tick, 2,922.24", runGapRunsPerMonth(eight), 2_922.24);
}

// ============================================================================
// 6. THE OVERVIEW COST CARD passes the downpipe list through (executiveAnswers, not observedCostSeed)
// ============================================================================
console.log("\n-- 6. the overview cost card --");
{
  // A daily downpipe of a 12 GB source, tested by hand six times, four minutes apart, plus two daily runs.
  const ring = [
    run("d0", "2026-09-23T00:00:00Z", RUN_12GB),
    run("d1", "2026-09-24T00:00:00Z", RUN_12GB),
    ...Array.from({ length: 6 }, (_, i) => run(`m${i}`, new Date(Date.UTC(2026, 8, 25, 1, 4 * i)).toISOString(), RUN_12GB)),
  ];
  const config = downpipe("prod-kv", 86_400);
  const state = { config, nextRunAt: 0, lastRunId: null, inFlight: false };
  const overview = (downpipes: OverviewData["downpipes"]): OverviewData =>
    ({
      health: { ok: true, value: { ok: true } },
      status: { ok: false, error: new Error("not read") },
      licence: { ok: false, error: new Error("not read") },
      updates: { ok: false, error: new Error("not read") },
      history: { ok: true, value: { "prod-kv": ring } },
      downpipes,
      drillEvidence: { ok: true, value: [] },
      audit: { ok: true, value: [] },
      approvals: { ok: true, value: [] },
      discovery: { ok: false, error: new Error("not read") },
    }) as unknown as OverviewData;
  const card = (d: OverviewData) => executiveAnswers(d, summariseFleet(d), { state: "unknown" } as never).find((a) => a.key === "cost");
  const listed = overview({ ok: true, value: [state] as never });
  const screen = summariseHistory({ "prod-kv": ring }, [config]);
  const onScreen = screen.kind === "seedable" ? monthlyCost(screen.seed, PRESETS.r2, { regime: "accumulate", month: 12 }).total : -1;
  const got = card(listed);
  ok("overview card: the Costs screen seed is on the schedule (33.5890 runs a month)", screen.kind === "seedable" && Math.abs(screen.seed.runsPerMonth - MONTH_S / 78_300) < 1e-9);
  ok("overview card: its headline is the Costs screen seed's month-12 figure", got?.verdict === `About ${money(onScreen)} / month`);
  ok("overview card: the detail names both sources", got?.detail.includes("sizes from your last 8 runs, runs a month from your downpipe schedules") === true);
  // With the downpipe list unreadable, the card falls back to run gaps and says so. The ring keeps two
  // gaps, 86,400 s and 90,000 s (the burst gaps are left out), so the median is 88,200 s and the figure
  // is 29.82 runs a month: a different figure.
  const unlisted = card(overview({ ok: false, error: new Error("list downpipes: 500") }));
  ok("overview card: an unreadable list falls back to run gaps, and the detail says so", unlisted?.detail.includes("runs a month from the gaps between your recorded runs, because the downpipe list could not be read") === true);
  ok("overview card: the fallback figure differs from the schedule figure", unlisted?.verdict !== got?.verdict);
}

console.log(failures === 0 ? `\nCOST CADENCE OK (${checks} checks)` : `\n${failures} FAILURE(S) of ${checks}`);
verdictReached(failures, checks);
if (failures > 0) process.exit(1);
