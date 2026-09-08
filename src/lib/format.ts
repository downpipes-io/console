// Presentation-only formatting helpers (humanBytes is presentation only, never fed back into a
// request). Numbers use grouping; bytes use binary units;
// times render as a relative phrase plus an absolute title. None of these values is
// ever sent back to the engine.

import type { DownpipeSchedule } from "./api/types/downpipes.ts";

// humanBytes formats a byte count using 1024-based divisions displayed with SI labels
// (KB, MB, GB, TB) for brevity, matching the old console. Tabular numerals are applied
// by the .tnum/.mono class at the call site.
export function humanBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "-";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

// groupNumber formats an integer with thousands separators (record counts, KV-read
// projections). Locale-independent grouping with a comma to keep the build stable.
export function groupNumber(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "-";
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// relativeTime turns an RFC-3339 / epoch-ms timestamp into a short relative phrase
// ("3h ago", "in 2d"). Returns "-" for an empty/invalid input. The absolute time is
// shown as a title at the call site for precision.
export function relativeTime(input: string | number | null | undefined): string {
  const ms = toMs(input);
  if (ms === null) return "-";
  const deltaSec = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(deltaSec);
  const future = deltaSec > 0;
  const phrase = pickUnit(abs);
  if (abs < 5) return "just now";
  return future ? `in ${phrase}` : `${phrase} ago`;
}

function pickUnit(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 14) return `${day}d`;
  const wk = Math.round(day / 7);
  if (wk < 9) return `${wk}w`;
  const mo = Math.round(day / 30);
  if (mo < 18) return `${mo}mo`;
  return `${Math.round(day / 365)}y`;
}

// absoluteTime formats an absolute UTC timestamp for a title/tooltip. ISO-ish and
// stable (no locale surprises) so a screenshot in a review reads cleanly.
export function absoluteTime(input: string | number | null | undefined): string {
  const ms = toMs(input);
  if (ms === null) return "";
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// dateOnly formats an absolute UTC date as "YYYY-MM-DD UTC" (no time of day), for places
// that read better as a plain date than a full timestamp (a subscription valid-until line).
// Same UTC-stable, locale-independent treatment as absoluteTime so a screenshot in a review
// reads cleanly; returns "" for an empty/invalid input.
export function dateOnly(input: string | number | null | undefined): string {
  const ms = toMs(input);
  if (ms === null) return "";
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} UTC`;
}

function toMs(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  const n = Date.parse(input);
  return Number.isFinite(n) ? n : null;
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_HALF_DAY = 43200;
const SECONDS_PER_DAY = 86400;

// cadenceLabel turns cadence seconds into a friendly phrase ("daily", "hourly",
// "every 6h") for the downpipes table.
export function cadenceLabel(seconds: number): string {
  if (seconds === SECONDS_PER_DAY) return "daily";
  if (seconds === SECONDS_PER_HOUR) return "hourly";
  if (seconds === SECONDS_PER_HALF_DAY) return "every 12h";
  if (seconds % SECONDS_PER_DAY === 0) return `every ${seconds / SECONDS_PER_DAY}d`;
  if (seconds % SECONDS_PER_HOUR === 0) return `every ${seconds / SECONDS_PER_HOUR}h`;
  if (seconds % SECONDS_PER_MINUTE === 0) return `every ${seconds / SECONDS_PER_MINUTE}m`;
  return `every ${seconds}s`;
}

// scheduleSummary is the schedule the engine will ACTUALLY apply, for the read surfaces (the fleet table and
// the detail drawer). When schedule.cron is present the engine schedules off the cron (in schedule.timeZone),
// NOT cadenceSeconds (engine scheduler-do-scheduling.ts, and the DownpipeSchedule type comment), so rendering
// the cadence label alone misreports a cron downpipe as a plain interval (a weekly cron reading "daily") and
// hides any blackout window (B58). Show the cron with its zone when present, else the cadence label; note a
// blackout window on either path, since a window defers a fire on both.
export function scheduleSummary(cadenceSeconds: number, schedule?: DownpipeSchedule): string {
  const base =
    schedule?.cron !== undefined && schedule.cron !== ""
      ? `cron ${schedule.cron}${schedule.timeZone ? ` (${schedule.timeZone})` : ""}`
      : cadenceLabel(cadenceSeconds);
  const windows = schedule?.blackoutWindows?.length ?? 0;
  return windows > 0 ? `${base}, ${windows} blackout window${windows === 1 ? "" : "s"}` : base;
}

// titleCase capitalises the first letter (for role labels, enum displays). Null-defensive:
// a PARTIAL engine response can hand a tile an undefined/non-string field (the type says
// string, the wire does not promise it), so a non-string input degrades to "" rather than
// throwing on .length and blanking the whole overview (honest-degrade philosophy; OBS-CONSOLE-1).
export function titleCase(s: string): string {
  if (typeof s !== "string" || s.length === 0) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}
