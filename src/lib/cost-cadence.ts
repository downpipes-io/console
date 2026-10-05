// Runs per month from what the engine SCHEDULES, for the cost estimate's cadence seed. The Costs screen
// (screens/costs/seed.ts) and the overview cost card (screens/overview/fleet-data.ts) both seed the cost
// model's runsPerMonth from here, so the two figures agree.
//
// THE RULE. Runs a month are the sum, over the downpipes in the run history, of the runs the engine
// starts from each downpipe's configured schedule. The run history supplies only the per-run bytes. The
// gaps between recorded runs are not a schedule: a burst of manual runs four minutes apart would read as
// a four-minute cadence, and two daily downpipes twelve hours apart would read as one downpipe that runs
// twice a day. So the run gaps are read only when the downpipe list cannot be read, and then per
// downpipe. The run record carries no field that says whether a run was started by hand (engine
// src/sched/types.ts RunHistoryEntry), so that fallback cannot leave manual runs out, and the screen
// says so.
//
// Pure and DOM-free: no wall clock, no randomness, no network. The cron walk uses a FIXED four-year
// window, so the same schedule always gives the same figure.

import type { Downpipe, RunHistoryEntry } from "../api.ts";
import { cadenceSecondsToRunsPerMonth, DAYS_PER_MONTH } from "./cost-model.ts";
import { type ConsoleCronSpec, parseCron } from "./schedule-cron.ts";
import { isValidTimeZone, SCHEDULE_TZ_DEFAULT } from "./schedule-zone.ts";

// ENGINE_DISPATCH_TICK_SECONDS mirrors engine src/cron/cron-cadence.ts CRON_CADENCE_MS (15 minutes). The
// engine starts a scheduled run only on this tick: a downpipe whose next run is due at 01:05 starts on
// the 01:15 tick. test/validate-cost-cadence.ts reads the engine constant and fails if the two differ.
export const ENGINE_DISPATCH_TICK_SECONDS = 15 * 60;

// ENGINE_CADENCE_JITTER_FRACTION mirrors engine src/sched/schedule-window.ts JITTER_FRACTION (0.1). On
// the cadence path the engine sets the next run to completion + cadence minus a random part of up to
// this fraction of the cadence, so a run can fall due up to 10 per cent early and never falls due after the
// cadence (it then starts at the next dispatch tick, or a later one when a tick runs low on budget). The engine
// comment on that constant says a run COUNT derived from a cadence must divide by the 0.9 floor, "That
// includes cost and quota projections". The validator reads this constant from the engine too.
export const ENGINE_CADENCE_JITTER_FRACTION = 0.1;

// The cron walk counts fires over four whole calendar years (1,461 days), so a
// monthly, a weekly and a 29 February cron all count at their true long-run rate. The engine searches up
// to four years ahead for a cron's next fire (engine src/sched/cron.ts), so the window matches.
const CRON_WINDOW_START_MS = Date.UTC(2025, 0, 1);
const CRON_WINDOW_DAYS = 1461;
const MINUTES_PER_DAY = 1440;
const TICK_MINUTES = ENGINE_DISPATCH_TICK_SECONDS / 60;
const TICKS_PER_DAY = MINUTES_PER_DAY / TICK_MINUTES;
const MS_PER_DAY = 86_400_000;
// The run-gap fallback leaves out gaps under half a tick and caps a downpipe at one run a tick.
const MIN_SCHEDULED_GAP_MS = (ENGINE_DISPATCH_TICK_SECONDS * 1000) / 2;
const MAX_RUNS_PER_MONTH = TICKS_PER_DAY * DAYS_PER_MONTH;

// ScheduledRunsHow names the path a downpipe's figure came from:
//   "cadence"        the downpipe has no cron, so the engine runs it on cadenceSeconds;
//   "cron"           the downpipe has a cron that the engine can resolve;
//   "cron-fallback"  the downpipe has a cron with an unknown time zone, a malformed expression or no fire
//                    in four years, so the engine runs it on cadenceSeconds instead (engine
//                    scheduler-do-scheduling.ts nextWithJitter), and this counts it that way;
//   "paused"         the downpipe is disabled, so the engine starts no scheduled run.
export type ScheduledRunsHow = "cadence" | "cron" | "cron-fallback" | "paused";

export interface ScheduledRuns {
  runsPerMonth: number;
  how: ScheduledRunsHow;
}

// ScheduleSource is the slice of a downpipe config the derivation reads.
export type ScheduleSource = Pick<Downpipe, "cadenceSeconds" | "enabled" | "schedule">;

// shortestCadenceGapSeconds is the shortest gap the engine can leave between two runs of a downpipe on the
// cadence path. A run starts on a tick T. The engine sets the next run to more than T + 0.9 x cadence
// (the jitter is strictly less than a tenth of the cadence), and the next run starts on the first tick at
// or after that instant. So the gap is at least (floor(0.9 x cadence / tick) + 1) ticks. Daily: 0.9 x
// 86,400 = 77,760 s = 86.4 ticks, so 87 ticks = 78,300 s (21 h 45 min). Hourly: 3.6 ticks, so 4 ticks
// = 3,600 s. A cadence below one tick runs once a tick. Returns null for a cadence that is not a positive
// finite number (the engine refuses one below 60 s at save, engine src/sched/config-validate.ts).
export function shortestCadenceGapSeconds(cadenceSeconds: number): number | null {
  if (!Number.isFinite(cadenceSeconds) || cadenceSeconds <= 0) return null;
  const earliest = (1 - ENGINE_CADENCE_JITTER_FRACTION) * cadenceSeconds;
  return (Math.floor(earliest / ENGINE_DISPATCH_TICK_SECONDS) + 1) * ENGINE_DISPATCH_TICK_SECONDS;
}

// cadenceRunsPerMonth is the most runs a month the cadence path can start: the month divided by the
// shortest gap. 0 for an unusable cadence.
export function cadenceRunsPerMonth(cadenceSeconds: number): number {
  const gap = shortestCadenceGapSeconds(cadenceSeconds);
  return gap === null ? 0 : cadenceSecondsToRunsPerMonth(gap);
}

// dayMatches applies the cron day rule to one calendar day: the month must match, then the Vixie
// day-of-month / day-of-week union (both restricted: either matches; one "*": only the other counts),
// the rule the engine's cronMatches applies.
function dayMatches(spec: ConsoleCronSpec, month: number, dom: number, dow: number): boolean {
  if (!spec.month.values.has(month)) return false;
  const domOK = spec.dom.values.has(dom);
  const dowOK = spec.dow.values.has(dow);
  if (spec.dom.star && spec.dow.star) return true;
  if (spec.dom.star) return dowOK;
  if (spec.dow.star) return domOK;
  return domOK || dowOK;
}

// cronDayTicks lists, in ascending order, the dispatch ticks one matching day's fires start on, as a tick
// index from that day's midnight (0 to 96; 96 is the next day's midnight tick). A fire at minute m starts
// on the first tick at or after it, ceil(m / 15). Fires that fall before the same tick start ONE run: the
// engine computes the next fire after the run it just started, so the others are passed over.
function cronDayTicks(spec: ConsoleCronSpec): number[] {
  const ticks = new Set<number>();
  for (const hour of spec.hour.values) {
    for (const minute of spec.minute.values) ticks.add(Math.ceil((hour * 60 + minute) / TICK_MINUTES));
  }
  return [...ticks].sort((a, b) => a - b);
}

// cronRunsPerMonth counts the runs a cron starts over the fixed four-year window and scales the count to
// DAYS_PER_MONTH. It walks calendar days in wall-clock time. That needs no time-zone conversion, because
// every current time-zone offset is a whole number of quarter hours, so a wall-clock minute falls in the
// same place relative to the 15-minute tick in every zone. Daylight-saving changes are not modelled: at
// most one hour of fires a year is added or lost at a change. Returns null when the expression does not
// parse or never fires in the window; the engine then runs the downpipe on its cadence.
export function cronRunsPerMonth(expr: string): number | null {
  let spec: ConsoleCronSpec;
  try {
    spec = parseCron(expr);
  } catch {
    return null;
  }
  const dayTicks = cronDayTicks(spec);
  let runs = 0;
  let lastTick = -1;
  for (let day = 0; day < CRON_WINDOW_DAYS; day++) {
    const d = new Date(CRON_WINDOW_START_MS + day * MS_PER_DAY);
    if (!dayMatches(spec, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay())) continue;
    for (const t of dayTicks) {
      const tick = day * TICKS_PER_DAY + t;
      if (tick !== lastTick) {
        runs++;
        lastTick = tick;
      }
    }
  }
  if (runs === 0) return null;
  return (runs * DAYS_PER_MONTH) / CRON_WINDOW_DAYS;
}

// scheduledRunsPerMonth is the most runs a month the engine will start for one downpipe, from its
// configuration alone. It follows the engine's own dispatch order (nextWithJitter): a disabled downpipe
// starts no scheduled run; a cron in a time zone the runtime knows, that parses and that fires, is
// counted from the cron; anything else runs on cadenceSeconds. Blackout windows are not counted: they
// only ever move a run later, so leaving them out keeps this figure an upper bound.
export function scheduledRunsPerMonth(dp: ScheduleSource): ScheduledRuns {
  if (dp.enabled === false) return { runsPerMonth: 0, how: "paused" };
  const cron = dp.schedule?.cron;
  if (cron !== undefined && cron !== "") {
    const rawZone = dp.schedule?.timeZone;
    const zone = rawZone !== undefined && rawZone.trim() !== "" ? rawZone : SCHEDULE_TZ_DEFAULT;
    const fromCron = isValidTimeZone(zone) ? cronRunsPerMonth(cron) : null;
    if (fromCron !== null) return { runsPerMonth: fromCron, how: "cron" };
    return { runsPerMonth: cadenceRunsPerMonth(dp.cadenceSeconds), how: "cron-fallback" };
  }
  return { runsPerMonth: cadenceRunsPerMonth(dp.cadenceSeconds), how: "cadence" };
}

// runGapRunsPerMonth is the fallback for one downpipe when its schedule cannot be read: the median gap
// between the start times of its own recorded runs, as runs a month. The median, not the mean, so a short
// burst of manual runs does not set the figure while it is less than half of the gaps. Gaps under half a
// dispatch tick are left out first: the engine starts at most one scheduled run a tick, so two runs that
// close together include at least one manual run. Half a tick, not a whole one, leaves room for the time
// a scheduled run takes to start after its tick. The result is capped at one run a tick
// (MAX_RUNS_PER_MONTH), the most a schedule can start. Returns 0 when no gap is left.
export function runGapRunsPerMonth(ring: RunHistoryEntry[]): number {
  const times = ring.map((e) => Date.parse(e.startedAt)).filter((t) => Number.isFinite(t));
  times.sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const gap = (times[i] ?? 0) - (times[i - 1] ?? 0);
    if (gap >= MIN_SCHEDULED_GAP_MS) gaps.push(gap);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 === 1 ? (gaps[mid] ?? 0) : ((gaps[mid - 1] ?? 0) + (gaps[mid] ?? 0)) / 2;
  return Math.min(MAX_RUNS_PER_MONTH, cadenceSecondsToRunsPerMonth(median / 1000));
}

// CadenceSource names where the seeded runs a month came from:
//   "schedule"  the configured schedules of the downpipes in the run history;
//   "run-gaps"  the downpipe list could not be read, so the median gap between each downpipe's runs;
//   "none"      no downpipe could be counted, so the seed is 0 runs a month.
export type CadenceSource = "schedule" | "run-gaps" | "none";

// CountedDownpipe is one downpipe that contributes to the seed: its runs a month, how that was derived,
// and its mean stored bytes per run from the run history.
export interface CountedDownpipe {
  id: string;
  name: string;
  runsPerMonth: number;
  how: ScheduledRunsHow | "run-gaps";
  cadenceSeconds?: number;
  cron?: string;
  meanRunBytes: number;
}

// CadenceBasis records exactly what the seeded runs a month rest on, so the screen can say so. The three
// counts are downpipes left out, and why.
export interface CadenceBasis {
  source: CadenceSource;
  counted: CountedDownpipe[];
  // paused: configured, disabled downpipes with measured runs (no scheduled run to project).
  paused: number;
  // notConfigured: downpipes in the run history that the downpipe list no longer holds.
  notConfigured: number;
  // unmeasured: configured, enabled downpipes with no run that carries the per-run byte counts yet.
  unmeasured: number;
  // noGap: on the run-gaps fallback, downpipes with no gap of at least half a tick between two runs.
  noGap: number;
}

export interface AccountCadence {
  runsPerMonth: number;
  // meanRunBytes is the stored bytes a run writes, averaged over the counted downpipes and weighted by
  // each one's runs a month, so meanRunBytes x runsPerMonth is the sum over the downpipes of their own
  // runs x bytes. With no counted downpipe it is the plain mean over every measured run.
  meanRunBytes: number;
  basis: CadenceBasis;
}

// deriveAccountCadence combines the downpipes into the single source the cost model takes (a size per
// run and a run count). measuredByDownpipe holds, per downpipe, only the runs that carry the per-run byte
// counts; ringsByDownpipe holds every recorded run (the run-gaps fallback reads all start times).
// downpipes is the configured downpipe list, or null when it could not be read.
export function deriveAccountCadence(
  measuredByDownpipe: Record<string, RunHistoryEntry[]>,
  ringsByDownpipe: Record<string, RunHistoryEntry[]>,
  downpipes: Downpipe[] | null,
): AccountCadence {
  const basis: CadenceBasis = { source: "none", counted: [], paused: 0, notConfigured: 0, unmeasured: 0, noGap: 0 };
  const configs = downpipes === null ? null : new Map(downpipes.map((d) => [d.id, d]));
  let allBytes = 0;
  let allRuns = 0;
  for (const [id, measured] of Object.entries(measuredByDownpipe)) {
    if (measured.length === 0) continue;
    const bytes = measured.reduce((s, e) => s + Math.max(0, e.archiveBytesWritten ?? 0), 0);
    allBytes += bytes;
    allRuns += measured.length;
    const meanRunBytes = bytes / measured.length;
    if (configs === null) {
      const runsPerMonth = runGapRunsPerMonth(ringsByDownpipe[id] ?? measured);
      if (runsPerMonth > 0) basis.counted.push({ id, name: id, runsPerMonth, how: "run-gaps", meanRunBytes });
      else basis.noGap++;
      continue;
    }
    const config = configs.get(id);
    if (config === undefined) {
      basis.notConfigured++;
      continue;
    }
    const scheduled = scheduledRunsPerMonth(config);
    if (scheduled.how === "paused") {
      basis.paused++;
      continue;
    }
    basis.counted.push({
      id,
      name: config.name || id,
      runsPerMonth: scheduled.runsPerMonth,
      how: scheduled.how,
      cadenceSeconds: config.cadenceSeconds,
      ...(scheduled.how === "cron" && config.schedule?.cron !== undefined ? { cron: config.schedule.cron } : {}),
      meanRunBytes,
    });
  }
  if (configs !== null) {
    for (const d of configs.values()) {
      if (d.enabled !== false && (measuredByDownpipe[d.id]?.length ?? 0) === 0) basis.unmeasured++;
    }
  }
  const runsPerMonth = basis.counted.reduce((s, c) => s + c.runsPerMonth, 0);
  if (runsPerMonth > 0) {
    basis.source = configs === null ? "run-gaps" : "schedule";
    const weighted = basis.counted.reduce((s, c) => s + c.runsPerMonth * c.meanRunBytes, 0);
    return { runsPerMonth, meanRunBytes: weighted / runsPerMonth, basis };
  }
  return { runsPerMonth: 0, meanRunBytes: allRuns > 0 ? allBytes / allRuns : 0, basis };
}
