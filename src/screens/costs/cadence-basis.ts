// The sentence under the Schedule cadence field in Observed mode that says where the seeded runs a month
// came from: which downpipe schedules were counted, at how many runs a month each, and which downpipes
// were left out and why. The derivation is lib/cost-cadence.ts; this only words its CadenceBasis. The
// docs page (day-2/cost-prediction, "Where the Observed-mode runs per month come from") explains the
// counting rule, so the screen names the result and links there.

import { type CadenceBasis, type CountedDownpipe, shortestCadenceGapSeconds } from "../../lib/cost-cadence.ts";
import { groupNumber } from "../../lib/format.ts";
import { plural } from "./helpers.ts";

// NAMED_DOWNPIPES_MAX caps how many downpipes the sentence names one by one; the rest are counted.
const NAMED_DOWNPIPES_MAX = 4;

// runsText formats a runs-a-month figure: one decimal place below 100, whole and grouped above.
export function runsText(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return n < 100 ? String(Math.round(n * 10) / 10) : groupNumber(n);
}

// everyText words a cadence in seconds in the largest whole unit that divides it ("every day",
// "every 6 hours", "every 90 minutes").
function everyText(seconds: number): string {
  const units: Array<[number, string]> = [
    [604_800, "week"],
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
    [1, "second"],
  ];
  for (const [size, unit] of units) {
    if (seconds % size === 0) {
      const n = seconds / size;
      return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
    }
  }
  return `every ${seconds} seconds`;
}

// durationText words a whole number of seconds as days, hours and minutes ("21 hours 45 minutes").
function durationText(seconds: number): string {
  const parts: string[] = [];
  let rest = Math.round(seconds / 60);
  for (const [size, unit] of [[1440, "day"], [60, "hour"], [1, "minute"]] as Array<[number, string]>) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0) parts.push(`${n} ${n === 1 ? unit : `${unit}s`}`);
  }
  return parts.length === 0 ? "0 minutes" : parts.join(" ");
}

// scheduleText words how one counted downpipe's figure was derived. On the cadence path it also names the
// shortest gap the count uses when that differs from the cadence (a daily downpipe is counted at one run
// every 21 hours 45 minutes), because that gap, not the cadence, is what gives the runs a month.
function scheduleText(c: CountedDownpipe): string {
  if (c.how === "cron" && c.cron !== undefined) return `cron ${c.cron}`;
  const every = c.cadenceSeconds !== undefined ? everyText(c.cadenceSeconds) : "";
  const gap = c.cadenceSeconds !== undefined ? shortestCadenceGapSeconds(c.cadenceSeconds) : null;
  const counted = gap !== null && gap !== c.cadenceSeconds ? `, counted at one run every ${durationText(gap)}` : "";
  if (c.how === "cron-fallback") return `${every}${counted}, because its cron cannot run`;
  return `${every}${counted}`;
}

// exclusionsText lists the downpipes left out of the seed, or "" when none were.
function exclusionsText(b: CadenceBasis): string {
  const parts: string[] = [];
  if (b.paused > 0) parts.push(`${b.paused} paused`);
  if (b.unmeasured > 0) parts.push(`${b.unmeasured} with no measured run yet`);
  if (b.notConfigured > 0) parts.push(`${b.notConfigured} no longer configured`);
  if (b.noGap > 0) parts.push(`${b.noGap} with fewer than two runs 7.5 minutes or more apart`);
  return parts.length === 0 ? "" : ` Not counted: ${parts.join(", ")}.`;
}

// describeCadenceBasis is the full sentence for the seeded cadence.
export function describeCadenceBasis(b: CadenceBasis): string {
  const total = b.counted.reduce((s, c) => s + c.runsPerMonth, 0);
  const excluded = exclusionsText(b);
  if (b.source === "none") {
    return `The seed found no downpipe schedule to count, so it starts at 0 runs a month.${excluded}`;
  }
  if (b.source === "run-gaps") {
    const n = b.counted.length;
    return `The downpipe list could not be read, so the seed uses the median gap between the runs of ${n} ${plural(n, "downpipe")}: ${runsText(total)} runs a month. It leaves out gaps under 7.5 minutes and counts at most one run every 15 minutes a downpipe, but manual runs can still raise this figure.${excluded}`;
  }
  const named = b.counted.slice(0, NAMED_DOWNPIPES_MAX).map((c) => `${c.name}, ${scheduleText(c)}, ${runsText(c.runsPerMonth)} a month`);
  const rest = b.counted.length - named.length;
  const list = rest > 0 ? `${named.join("; ")}; and ${rest} more` : named.join("; ");
  const n = b.counted.length;
  // A cadence count sits above one run a cadence (a daily downpipe counts 33.6, not 30.4), so the line says why.
  const early = b.counted.some((c) => c.how === "cadence" || c.how === "cron-fallback")
    ? " A run on a cadence can start up to 10 per cent early, and the count includes this."
    : "";
  // The seed sets source size so that source size x stored ratio is the mean stored bytes a run wrote.
  const source =
    n === 1
      ? "Source size is set so that each run stores what an average run of this downpipe stored."
      : "Source size is set so that each run stores what an average run of these downpipes stored, weighted by their runs a month.";
  return `Seeded from ${n === 1 ? "the schedule of 1 downpipe" : `the schedules of ${n} downpipes`}: ${list}. Total ${runsText(total)} runs a month, the most scheduled runs the engine can start.${early}${excluded} ${source}`;
}
