// Overview (IA screen 1) fleet + cost computation: the pure, DOM-free data derivations
// the dashboard and the validators read. summariseFleet joins run history with config to
// the honest freshness roll-up; observedCostSeed seeds the cost model from observed run
// history (the SAME seeding the /costs screen uses). Moved verbatim out of overview.ts for
// size. House rules: Australian English, no em dashes, precise claims.

import type { DownpipeState, RunHistoryEntry } from "../../api.ts";
// The freshness rule is SHARED with the map (the single source of truth), so the dashboard
// and the map cannot disagree about whether a downpipe is fresh; see map.ts classifyFreshness.
import { recordContractSkew } from "../../lib/client-diag/ring.ts";
import {
  cadenceSecondsToRunsPerMonth,
  DEFAULT_DEDUP_RATIO,
  DEFAULT_OVERHEAD_BYTES,
  DEFAULT_SEG_BYTES,
  type Inputs,
  withDefaults,
} from "../../lib/cost-model.ts";
import { readDownpipe, readDownpipeId } from "../../lib/downpipe-readable.ts";
import { type CoreFreshness, cadenceSecondsOf, classifyFreshness } from "../map.ts";
import {
  COST_MIN_OBSERVED_RUNS,
  type FleetRow,
  type FleetSummary,
  type Freshness,
  freshnessRank,
  type OverviewData,
} from "./shared.ts";

// observedCostSeed derives the cost-model Inputs from observed run history, REUSING the exact
// seeding the /costs screen's observed mode uses (costs.ts summariseHistory), so the overview
// headline and the calculator's observed headline agree on the same number. It returns null
// when fewer than COST_MIN_OBSERVED_RUNS runs carry the per-run byte/segment fields (so the
// card shows the calm prompt rather than a single-point guess). It reads ONLY sizes and
// counts, never archive content, a key or a secret (no-custody).
export function observedCostSeed(byDownpipe: Record<string, RunHistoryEntry[]>): { inputs: Inputs; runs: number } | null {
  // Flatten every run across downpipes: the destination bill is account-wide. Null-defensive:
  // a partial settlement can hand us an undefined map, so coalesce before Object.keys (OBS-CONSOLE-1).
  const all: RunHistoryEntry[] = [];
  for (const id of Object.keys(byDownpipe ?? {})) {
    for (const e of byDownpipe[id] ?? []) all.push(e);
  }
  const hasCostFields = (e: RunHistoryEntry): boolean =>
    typeof e.archiveBytesWritten === "number" && Number.isFinite(e.archiveBytesWritten) && e.archiveBytesWritten >= 0 &&
    typeof e.segmentsWritten === "number" && Number.isFinite(e.segmentsWritten) && e.segmentsWritten >= 0;
  const withFields = all.filter(hasCostFields);

  // G330: successful runs exist and not one of them carries the throughput fields the cost card needs, so the
  // card never projects and the operator reads "not projected yet" as if the estate were simply young.
  //
  // IT IS SCOPED TO status "ok", AND THAT IS THE WHOLE FIX. The engine stamps archiveBytesWritten and
  // segmentsWritten at COMPLETION and nowhere else: an in-flight row is appended at trigger with no byte fields,
  // a failed completion posts none, and an abandoned run never completes. Testing `all` therefore fired on three
  // ordinary, legitimate states -- a first backup still running, an estate whose every backup is failing (the
  // commonest support state there is), an abandoned run -- and produced the SAME row as the defect, on every
  // Overview render. Four states, one row, and the three noisiest of them were the healthy ones.
  //
  // WHAT THE ROW ASSERTS, precisely: every SUCCEEDED run in this ring lacks the throughput fields. It does not
  // assert a contract break, because the browser cannot establish one: an ok run recorded before the engine
  // version that added the fields also, legitimately, lacks them (engine types.ts says so outright). The pack
  // carries engine.version beside this row, which is what tells those two apart, and the row's job is to point
  // at the question rather than to answer it.
  const okRuns = all.filter((e) => e.status === "ok");
  if (okRuns.length > 0 && !okRuns.some(hasCostFields)) recordContractSkew("missing-field", "run-cost-fields");
  if (withFields.length < COST_MIN_OBSERVED_RUNS) return null;

  let sumArchiveBytes = 0;
  let sumSegments = 0;
  for (const e of withFields) {
    sumArchiveBytes += Math.max(0, e.archiveBytesWritten ?? 0);
    sumSegments += Math.max(0, e.segmentsWritten ?? 0);
  }
  // Implied logical source size, anchored on the MEAN per-run archive bytes so the model's
  // PER-RUN snapshot bytes equal the real observed mean write: under the default per-run
  // snapshot growth model (the live engine: the addressing key is per-run, so every run
  // stores a full snapshot) per-run growth is A0 = S x d, and S = meanPerRunBytes / d makes
  // the projection "runs per period times the archive bytes a run actually writes", straight
  // from run history. This matches costs.ts summariseHistory exactly so the overview headline
  // and the calculator's observed headline agree on the same number.
  const meanPerRunBytes = sumArchiveBytes / Math.max(1, withFields.length);
  const impliedSourceBytes = meanPerRunBytes / Math.max(Number.EPSILON, DEFAULT_DEDUP_RATIO);

  const inputs = withDefaults({
    sourceBytes: impliedSourceBytes,
    dedupRatio: DEFAULT_DEDUP_RATIO,
    churnFraction: deriveChurnFraction(withFields, sumArchiveBytes),
    // Cadence: the mean interval between consecutive run start times, as runs-per-month.
    runsPerMonth: observedRunsPerMonthFor(withFields),
    segBytes: deriveSegBytes(sumArchiveBytes, sumSegments),
    overheadBytes: DEFAULT_OVERHEAD_BYTES,
  });
  return { inputs, runs: withFields.length };
}

// deriveChurnFraction estimates the churn fraction (c) that seeds the clearly-labelled FUTURE
// cross-run dedup model only (the default per-run snapshot projection is churn-independent, so this
// never moves the card's own figure). It reads the byte shape: the per-run delta as a share of the
// cumulative stored size, with the single largest run (a one-off full seal) excluded from the delta
// cohort (CON-H14: the signal must follow bytes, not the run count). Clamped to [0, 1]; all-zero
// history reads as 0 churn (the NaN-safe CON-L27 guard).
function deriveChurnFraction(withFields: RunHistoryEntry[], sumArchiveBytes: number): number {
  let maxArchiveBytes = 0;
  for (const e of withFields) maxArchiveBytes = Math.max(maxArchiveBytes, Math.max(0, e.archiveBytesWritten ?? 0));
  // The incremental cohort is every run bar one (the full seal). withFields.length >= 2
  // (COST_MIN_OBSERVED_RUNS), so the divisor is always >= 1.
  const incrementalRuns = withFields.length - 1;
  const meanIncrementalArchivePerRun = incrementalRuns > 0 ? (sumArchiveBytes - maxArchiveBytes) / incrementalRuns : 0;
  const churnFractionRaw = sumArchiveBytes > 0 ? meanIncrementalArchivePerRun / sumArchiveBytes : 0;
  return Number.isFinite(churnFractionRaw) ? Math.min(1, Math.max(0, churnFractionRaw)) : 0;
}

// deriveSegBytes returns the observed writer granularity (bytes per object), falling back to the
// default segment size when no segments were observed.
function deriveSegBytes(sumArchiveBytes: number, sumSegments: number): number {
  return sumSegments > 0 ? Math.max(1, sumArchiveBytes / sumSegments) : DEFAULT_SEG_BYTES;
}

// observedRunsPerMonthFor derives runs-per-month from the mean interval between consecutive
// run start times (mirroring costs.ts observedRunsPerMonth), returning 0 when fewer than two
// timestamps parse or the mean gap is non-positive (the library then treats f as 0).
function observedRunsPerMonthFor(runs: RunHistoryEntry[]): number {
  const times: number[] = [];
  for (const e of runs) {
    const t = Date.parse(e.startedAt);
    if (Number.isFinite(t)) times.push(t);
  }
  if (times.length < 2) return 0;
  times.sort((a, b) => a - b);
  let sumGapMs = 0;
  let gaps = 0;
  for (let i = 1; i < times.length; i++) {
    const prev = times[i - 1];
    const cur = times[i];
    if (prev === undefined || cur === undefined) continue;
    const gap = cur - prev;
    if (gap > 0) { sumGapMs += gap; gaps++; }
  }
  if (gaps === 0) return 0;
  return cadenceSecondsToRunsPerMonth(sumGapMs / gaps / 1000);
}

// ---- fleet computation ------------------------------------------------------

// summariseFleet joins the run history (the source of truth for what ran) with the
// downpipe config list (enabled / nextRunAt / cadence). Freshness is computed in-account:
//   - disabled        config.enabled === false (NOT stale; an honesty rule)
//   - in-flight       the latest run is in-flight
//   - failed          the latest run failed
//   - stale           enabled, but the newest good run is older than STALE_CADENCE_MULTIPLE * cadence
//   - healthy         enabled and current
//   - unknown         present in config but no run history could be read for it
// A downpipe that appears in history but not in the (failed-to-load) config list is shown
// with hasDownpipe:false so the UI does not assert a cadence/next-run it cannot back.
export function summariseFleet(data: OverviewData, nowMs: number = Date.now()): FleetSummary {
  // Null-defensive: a PARTIAL engine response can settle ok:true with an undefined value
  // (the type promises Record<string,RunHistoryEntry[]>; the wire does not). Coalescing to {}
  // keeps the Object.keys/Object.values walks below from throwing and blanking the whole fleet
  // table; the fleet then degrades to an honest empty/unknown reading (OBS-CONSOLE-1).
  const history = (data.history.ok ? data.history.value : {}) ?? {};
  const rows = buildFleetRows(data, history, nowMs);

  // Worst offenders first (failed, then stale, then unknown), then oldest last-good.
  rows.sort((a, b) => {
    const ra = freshnessRank(a.freshness);
    const rb = freshnessRank(b.freshness);
    if (ra !== rb) return ra - rb;
    const at = (x: string | null) => (x ? Date.parse(x) : 0);
    return at(a.lastGoodAt) - at(b.lastGoodAt);
  });

  const counts = buildFleetCounts(rows);
  const newestGoodAt = newestGoodFrom(rows);
  const { worstGoodAt, noGoodBackupCount } = worstRecoveryPointFrom(rows);
  const anyRuns = Object.values(history).some((ring) => (ring?.length ?? 0) > 0);
  // The rollover counters ride alongside anyRuns rather than folded into it, because they answer a
  // DIFFERENT question. anyRuns is "does the fleet hold a run record now"; rolledOverCount is "how many
  // did the engine record that we no longer hold". An estate that has lost every run answers false and a
  // positive count, and only the pair separates it from an estate that has never run anything. An absent
  // count stays absent (an unknown, from an engine that does not publish one), never a zero.
  const rollover = data.historyRollover?.ok === true ? data.historyRollover.value : undefined;
  return {
    total: rows.length,
    ...counts,
    rows,
    newestGoodAt,
    worstGoodAt,
    noGoodBackupCount,
    anyRuns,
    ...(typeof rollover?.rolledOverCount === "number" ? { runsRolledOverCount: rollover.rolledOverCount } : {}),
    ...(rollover?.counterReset === true ? { runlogCounterReset: true as const } : {}),
  };
}

// buildFleetRows maps the id-union (config ids and history ids) to one FleetRow each, computing the
// per-pipe freshness with the ONE rule shared with the map (map.ts classifyFreshness) so the
// dashboard and the map cannot disagree about the same downpipe.
function buildFleetRows(data: OverviewData, history: Record<string, RunHistoryEntry[]>, nowMs: number): FleetRow[] {
  // Same null-defence as the history map: a partial ok:true settlement can carry an undefined
  // list, so coalesce to [] before the for-of below (OBS-CONSOLE-1).
  const downpipes = (data.downpipes.ok ? data.downpipes.value : []) ?? [];
  const haveHistory = data.history.ok;
  const haveDownpipes = data.downpipes.ok;

  // Index the config by id. THE ROW-LEVEL GUARD (OBS-CONSOLE-1). The list guard three lines
  // above defends the CONTAINER and this line then read `d.config.id` off each ROW with nothing at all: a
  // roster record with no config object threw a TypeError here, and because buildOverview had no boundary
  // and the async load had no catch, the whole Overview froze on its first-load skeleton: nine stat tiles
  // can go to none, from one bad row among three good ones.
  //
  // An unreadable row is KEPT, under a stable placeholder key, and never dropped. Dropping it would be the
  // quieter defect: the fleet count would silently disagree with the engine's, and an operator counting
  // five downpipes in the engine and four here has no way to learn why. The key is derived from the row's
  // POSITION so it is stable across a re-render of the same response and cannot collide with a real id
  // (a real config.id can never contain a space).
  const byId = new Map<string, DownpipeState>();
  downpipes.forEach((d, i) => {
    const id = readDownpipeId(d);
    byId.set(id ?? `unreadable downpipe ${i + 1}`, d);
  });

  // The set of ids to show: union of config ids and history ids (so a pipe with runs but
  // dropped from config, or a freshly created pipe with no runs yet, both appear).
  const ids = new Set<string>([...Object.keys(history), ...byId.keys()]);

  const rows: FleetRow[] = [];
  const now = nowMs;

  for (const id of ids) {
    const ring = history[id] ?? [];
    const latest = ring[0]; // newest-first
    const dp = byId.get(id);
    // `dp.config` is read through the shared reader for the same reason as the index above: a row can be
    // present in the map and still carry no readable config. An unreadable row is treated exactly as a row
    // with no backing config at all, which the freshness rule already handles honestly (hasConfig:false
    // yields "unknown", never a healthy green), so no new freshness state is invented for it.
    const dpRead = dp ? readDownpipe(dp) : null;
    const dpConfig = dpRead?.readable ? dpRead.config : null;
    // `enabled` defaults TRUE for a row with no config (unchanged): a history-only row is assumed live so
    // it is judged on its staleness rather than excused as disabled. An unreadable row inherits the same
    // default for the same reason: excusing it would hide it from the stale and failed counters.
    const enabled = dpConfig ? dpConfig.enabled : true;
    // G298: the cadence goes through the ONE seam (map.ts cadenceSecondsOf), which records a cadence that arrived
    // in a shape this build cannot read instead of nulling it silently. This caller did not even coerce: it passed
    // the raw value into the freshness rule, where a non-number simply failed `cadenceSeconds > 0` and disabled the
    // staleness test, so the Overview's fleet roll-up counted a two-month-old backup as fresh. A row with NO
    // backing config records nothing: there is no cadence to read, which is not an anomaly.
    const cadenceSeconds = dpConfig ? cadenceSecondsOf(dpConfig) : null;
    const nextRunAt = dpConfig?.enabled ? dp?.nextRunAt ?? null : null;

    // The newest OK run (for last-good age + RPO).
    const lastGood = ring.find((e) => e.status === "ok") ?? null;
    const lastGoodAt = lastGood ? lastGood.startedAt : null;

    const lastStatus: FleetRow["lastStatus"] = latest ? latest.status : "none";

    // Whether a run is currently in progress: a RUNNING CUE only (the latest run is in-flight,
    // or the engine's live flag), carried SEPARATELY from freshness exactly as the map does
    // (map.ts mapDownpipesToFlows). Decoupling it is what lets an in-flight run animate without
    // masking an underlying stale state.
    const runInFlight = (latest ? latest.status === "in-flight" : false) || (dp?.inFlight ?? false);

    // Compute freshness with the ONE rule shared with the map (map.ts classifyFreshness), so
    // the dashboard and the map cannot disagree about the same downpipe. The rule matches the
    // engine's authority (notify.ts classify): staleness is measured from the last SUCCESSFUL
    // run and a run in flight does NOT reset it, so an in-flight run over an older good run is
    // judged on that good run's age (it reads "stale" here, never a masking "in-flight").
    // pendingWhenNoRuns:true keeps the dashboard's reading of a freshly created, enabled,
    // configured pipe as healthy-pending (the one place the dashboard differs from the map,
    // which makes no claim for a never-run pipe); it does not touch the staleness precedence.
    const freshness: Freshness = classifyFreshness({
      enabled,
      hasConfig: dpConfig !== null,
      haveHistory,
      haveDownpipes,
      latestStatus: lastStatus,
      lastGoodAt,
      cadenceSeconds,
      now,
      pendingWhenNoRuns: true,
    }) satisfies CoreFreshness;

    rows.push({
      id,
      freshness,
      lastStatus,
      lastGoodAt,
      lastRunAt: latest ? latest.startedAt : null,
      nextRunAt,
      enabled,
      cadenceSeconds,
      recent: ring,
      lastRecordCount: latest && typeof latest.recordCount === "number" ? latest.recordCount : null,
      hasDownpipe: !!dp,
      inFlight: runInFlight,
      // configUnreadable marks a row that IS in the engine's list and whose configuration this console
      // could not read. It is carried on the row rather than derived at render, so every consumer of a
      // FleetRow (the table, the counters, the needs-me list) reads the SAME judgement instead of each
      // re-deciding it, and a row that is present-but-unreadable can never be mistaken for one that is
      // simply absent from config.
      configUnreadable: dp !== undefined && dpConfig === null,
    });
  }
  return rows;
}

// buildFleetCounts reduces the rows to the freshness pill counters. "in-flight" here is only ever a
// healthy-pending FIRST run (no good run yet); it folds into the Healthy pill. A run in progress over
// a stale/failed/healthy good run does NOT land in "in-flight" (it is classified on that good run),
// so the running cue (row.inFlight) and the stale signal coexist instead of the run masking staleness.
function buildFleetCounts(rows: FleetRow[]): { healthy: number; stale: number; failed: number; disabled: number; inFlight: number } {
  let healthy = 0;
  let stale = 0;
  let failed = 0;
  let disabled = 0;
  let inFlight = 0;
  for (const row of rows) {
    switch (row.freshness) {
      case "healthy": healthy++; break;
      case "stale": stale++; break;
      case "failed": failed++; break;
      case "disabled": disabled++; break;
      case "in-flight": inFlight++; break;
      case "unknown": break;
    }
  }
  return { healthy, stale, failed, disabled, inFlight };
}

// worstRecoveryPointFrom returns the fleet's WORST-CASE recovery point: the oldest last-good
// timestamp among downpipes that are meant to be protected, plus a count of those that have never
// had a good backup at all.
//
// The RPO tile used to read the NEWEST good backup, so a fleet with one downpipe backed up
// five minutes ago and nine untouched for a month reported "5m ago, Fleet-wide". A recovery point is
// how much you could lose right now, and that is set by the stalest protected system.
//
// Two decisions worth stating because neither is obvious from the code alone:
//
// Disabled downpipes are EXCLUDED. A disabled downpipe is a decision somebody made, not an unmet
// obligation, and counting it would make the metric permanently alarming for a fleet that is
// behaving exactly as configured. That is how a risk metric gets ignored.
//
// A downpipe with no good backup EVER is counted separately rather than folded in as a very old
// timestamp. Its recovery point is not large, it is undefined, and there is no honest duration to
// print for it. Folding it in would print a number SMALLER than the truth, which is the same class
// of error this whole change exists to fix.
// Exported for test/validate-recovery-point-is-worst-case.ts, which drives THIS function over fleets
// whose right answer is known by construction. A test that re-implemented the rule would be a copy
// checked against a copy and would prove nothing about what renders.
export function worstRecoveryPointFrom(rows: readonly Pick<FleetRow, "freshness" | "lastGoodAt">[]): { worstGoodAt: string | null; noGoodBackupCount: number } {
  let worstGoodAt: string | null = null;
  let noGoodBackupCount = 0;
  for (const row of rows) {
    if (row.freshness === "disabled") continue;
    const lastGoodAt = row.lastGoodAt;
    if (!lastGoodAt) {
      noGoodBackupCount += 1;
      continue;
    }
    if (!worstGoodAt || Date.parse(lastGoodAt) < Date.parse(worstGoodAt)) {
      worstGoodAt = lastGoodAt;
    }
  }
  return { worstGoodAt, noGoodBackupCount };
}

// newestGoodFrom returns the newest last-good timestamp across all rows (for last-good age + RPO).
function newestGoodFrom(rows: FleetRow[]): string | null {
  let newestGoodAt: string | null = null;
  for (const row of rows) {
    const lastGoodAt = row.lastGoodAt;
    if (lastGoodAt && (!newestGoodAt || Date.parse(lastGoodAt) > Date.parse(newestGoodAt))) {
      newestGoodAt = lastGoodAt;
    }
  }
  return newestGoodAt;
}
