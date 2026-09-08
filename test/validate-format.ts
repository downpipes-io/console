// Validate the pure formatting helpers in src/lib/format.ts.
// Run with `node test/validate-format.ts` after `npm install`.
// Prints one line per check; exits non-zero on any failure.
//
// Coverage:
//   humanBytes   - boundary values: 0, 1023, 1024, 1 MiB, 1 GiB, large; undefined/non-finite
//   relativeTime - "just now", minutes, hours, days, future, past, null/empty guard
//   absoluteTime - UTC output stability, empty/null guard
//   cadenceLabel - exact aliases (daily, hourly, 12h), divisor paths (whole days, hours,
//                  minutes), and raw-seconds fallback
//   groupNumber  - thousands separators, rounding, undefined/non-finite
//   titleCase    - capitalisation, empty string
//
// relativeTime depends on Date.now(); we pin a fixed "now" by overriding Date.now
// for each block of calls and restoring it immediately after.

import {
  humanBytes,
  relativeTime,
  absoluteTime,
  cadenceLabel,
  scheduleSummary,
  groupNumber,
  titleCase,
} from "../src/lib/format.ts";

let failures = 0;

function _ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function eq(label: string, got: string, want: string): void {
  const cond = got === want;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// Pin Date.now to a fixed epoch-ms for the duration of fn(), then restore it.
function withNow(fixedMs: number, fn: () => void): void {
  const real = Date.now;
  Date.now = () => fixedMs;
  try {
    fn();
  } finally {
    Date.now = real;
  }
}

// A stable epoch for absolute-time and relative-time tests.
// = 1710504000000 ms
const FIXED_NOW = 1710504000000;

// ---------------------------------------------------------------------------
// humanBytes
// ---------------------------------------------------------------------------
console.log("\n-- humanBytes --");

eq("undefined -> dash", humanBytes(undefined), "-");
eq("NaN -> dash", humanBytes(NaN), "-");
eq("Infinity -> dash", humanBytes(Infinity), "-");
eq("0 bytes", humanBytes(0), "0 B");
eq("1 byte", humanBytes(1), "1 B");
eq("1023 bytes (just below 1 KB boundary)", humanBytes(1023), "1023 B");
eq("1024 bytes = 1.0 KB", humanBytes(1024), "1.0 KB");
eq("1025 bytes = 1.0 KB (still < 10 KB, one decimal)", humanBytes(1025), "1.0 KB");
// 10 * 1024 = 10240 -> "10 KB" (v >= 10, toFixed(0))
eq("10240 bytes = 10 KB", humanBytes(10240), "10 KB");
// 1 MiB = 1048576
eq("1048576 bytes = 1.0 MB", humanBytes(1048576), "1.0 MB");
// 1 GiB = 1073741824
eq("1073741824 bytes = 1.0 GB", humanBytes(1073741824), "1.0 GB");
// 1 TiB = 1099511627776
eq("1099511627776 bytes = 1.0 TB", humanBytes(1099511627776), "1.0 TB");
// Large: 2.5 GiB = 2684354560
eq("2684354560 bytes = 2.5 GB", humanBytes(2684354560), "2.5 GB");
// Boundary: 9.9 KB (v < 10 -> one decimal) vs 10 KB (v >= 10 -> zero decimal).
// 9.9 * 1024 = 10137.6; humanBytes rounds v to one decimal: 10137.6/1024 = 9.9 -> "9.9 KB"
eq("10137 bytes = 9.9 KB (one decimal)", humanBytes(10137), "9.9 KB");
// v exactly 10: 10 * 1024 = 10240 -> "10 KB" (zero decimal)
eq("10240 bytes = 10 KB (zero decimal)", humanBytes(10240), "10 KB");

// ---------------------------------------------------------------------------
// relativeTime
// ---------------------------------------------------------------------------
console.log("\n-- relativeTime --");

withNow(FIXED_NOW, () => {
  // null / undefined / empty -> dash
  eq("null -> dash", relativeTime(null), "-");
  eq("undefined -> dash", relativeTime(undefined), "-");
  eq("empty string -> dash", relativeTime(""), "-");
  eq("invalid string -> dash", relativeTime("not-a-date"), "-");

  // just now: within 4 seconds either direction
  eq("0s delta -> just now", relativeTime(FIXED_NOW), "just now");
  eq("3s in past -> just now", relativeTime(FIXED_NOW - 3000), "just now");
  eq("4s in past -> just now (abs < 5 threshold)", relativeTime(FIXED_NOW - 4000), "just now");

  // seconds past (abs >= 5s, < 60s)
  eq("30s past -> 30s ago", relativeTime(FIXED_NOW - 30_000), "30s ago");
  eq("59s past -> 59s ago", relativeTime(FIXED_NOW - 59_000), "59s ago");

  // minutes (60s..3599s)
  eq("60s past -> 1m ago", relativeTime(FIXED_NOW - 60_000), "1m ago");
  eq("90s past -> 2m ago (round)", relativeTime(FIXED_NOW - 90_000), "2m ago");
  // 3599s: min = round(3599/60) = round(59.98) = 60; hr = round(60/60) = 1 -> "1h ago"
  eq("3599s past -> 1h ago (min rounds to 60, hr path)", relativeTime(FIXED_NOW - 3_599_000), "1h ago");

  // hours (min >= 60, hr < 48)
  eq("1h past -> 1h ago", relativeTime(FIXED_NOW - 3_600_000), "1h ago");
  eq("6h past -> 6h ago", relativeTime(FIXED_NOW - 21_600_000), "6h ago");
  eq("47h past -> 47h ago (just below 48h day threshold)", relativeTime(FIXED_NOW - 47 * 3_600_000), "47h ago");

  // days (hr >= 48, day < 14)
  eq("48h past -> 2d ago", relativeTime(FIXED_NOW - 48 * 3_600_000), "2d ago");
  eq("7d past -> 7d ago", relativeTime(FIXED_NOW - 7 * 86_400_000), "7d ago");
  eq("13d past -> 13d ago", relativeTime(FIXED_NOW - 13 * 86_400_000), "13d ago");

  // weeks (day >= 14, wk < 9)
  eq("14d past -> 2w ago", relativeTime(FIXED_NOW - 14 * 86_400_000), "2w ago");
  eq("28d past -> 4w ago", relativeTime(FIXED_NOW - 28 * 86_400_000), "4w ago");

  // future guard: a time 10 minutes ahead should say "in Xm"
  eq("10m future -> in 10m", relativeTime(FIXED_NOW + 10 * 60_000), "in 10m");
  eq("2h future -> in 2h", relativeTime(FIXED_NOW + 2 * 3_600_000), "in 2h");
  eq("3d future -> in 3d", relativeTime(FIXED_NOW + 3 * 86_400_000), "in 3d");

  // numeric epoch-ms input (not a string)
  eq("numeric past (30s) -> 30s ago", relativeTime(FIXED_NOW - 30_000), "30s ago");
  eq("numeric future (1h) -> in 1h", relativeTime(FIXED_NOW + 3_600_000), "in 1h");
});

// ---------------------------------------------------------------------------
// absoluteTime
// ---------------------------------------------------------------------------
console.log("\n-- absoluteTime --");

eq("epoch-ms: 2024-03-15 12:00 UTC", absoluteTime(FIXED_NOW), "2024-03-15 12:00 UTC");
// RFC-3339 string input
eq("rfc3339 string: 2024-03-15 12:00 UTC", absoluteTime("2024-03-15T12:00:00Z"), "2024-03-15 12:00 UTC");
// Midnight padding: = 946684800000
eq("midnight padding: 2000-01-01 00:00 UTC", absoluteTime(946684800000), "2000-01-01 00:00 UTC");
// null / undefined / empty -> empty string (not a dash)
eq("null -> empty string", absoluteTime(null), "");
eq("undefined -> empty string", absoluteTime(undefined), "");
eq("empty string -> empty string", absoluteTime(""), "");

// ---------------------------------------------------------------------------
// cadenceLabel
// ---------------------------------------------------------------------------
console.log("\n-- cadenceLabel --");

// Exact named aliases
eq("86400 -> daily", cadenceLabel(86400), "daily");
eq("3600 -> hourly", cadenceLabel(3600), "hourly");
eq("43200 -> every 12h", cadenceLabel(43200), "every 12h");

// Whole-day multiples (seconds % 86400 === 0, not 86400 itself)
eq("86400 * 2 -> every 2d", cadenceLabel(86400 * 2), "every 2d");
eq("86400 * 7 -> every 7d", cadenceLabel(86400 * 7), "every 7d");

// Whole-hour multiples (seconds % 3600 === 0, not a named alias, not a whole day)
eq("3600 * 2 -> every 2h", cadenceLabel(3600 * 2), "every 2h");
eq("3600 * 6 -> every 6h", cadenceLabel(3600 * 6), "every 6h");
// 3600 * 4 = 14400 -> every 4h
eq("14400 -> every 4h", cadenceLabel(14400), "every 4h");

// Whole-minute multiples (seconds % 60 === 0, not a whole hour)
eq("60 -> every 1m", cadenceLabel(60), "every 1m");
eq("300 -> every 5m", cadenceLabel(300), "every 5m");
eq("900 -> every 15m", cadenceLabel(900), "every 15m");

// Raw seconds fallback (not divisible by 60)
eq("30 -> every 30s", cadenceLabel(30), "every 30s");
eq("1 -> every 1s", cadenceLabel(1), "every 1s");
eq("45 -> every 45s", cadenceLabel(45), "every 45s");

// ---------------------------------------------------------------------------
// scheduleSummary (the schedule the engine will ACTUALLY apply)
// ---------------------------------------------------------------------------
console.log("\n-- scheduleSummary --");

// No schedule, or an empty cron, falls back to the cadence label (byte-unchanged for a plain interval).
eq("no schedule -> cadence label", scheduleSummary(86400, undefined), "daily");
eq("empty cron -> cadence label", scheduleSummary(3600, { cron: "" }), "hourly");
// A cron is shown as the cron the engine schedules off, NEVER the cadence label (a weekly cron must not read "daily").
eq("cron -> the cron, not the cadence", scheduleSummary(86400, { cron: "0 0 * * 0" }), "cron 0 0 * * 0");
eq("cron with a timezone shows the zone", scheduleSummary(86400, { cron: "0 0 * * 0", timeZone: "Australia/Sydney" }), "cron 0 0 * * 0 (Australia/Sydney)");
// A blackout window is noted on either path, since a window defers a fire on both.
eq("cron with one blackout window", scheduleSummary(86400, { cron: "0 9 * * *", blackoutWindows: [{ startMinute: 0, endMinute: 60 }] }), "cron 0 9 * * *, 1 blackout window");
eq("cadence with two blackout windows", scheduleSummary(86400, { blackoutWindows: [{ startMinute: 0, endMinute: 60 }, { startMinute: 120, endMinute: 180 }] }), "daily, 2 blackout windows");

// ---------------------------------------------------------------------------
// groupNumber
// ---------------------------------------------------------------------------
console.log("\n-- groupNumber --");

eq("undefined -> dash", groupNumber(undefined), "-");
eq("NaN -> dash", groupNumber(NaN), "-");
eq("0 -> 0", groupNumber(0), "0");
eq("999 -> 999", groupNumber(999), "999");
eq("1000 -> 1,000", groupNumber(1000), "1,000");
eq("1000000 -> 1,000,000", groupNumber(1000000), "1,000,000");
eq("1234567 -> 1,234,567", groupNumber(1234567), "1,234,567");
// Negative
eq("-1000 -> -1,000", groupNumber(-1000), "-1,000");
// Float rounds to nearest integer
eq("1000.6 rounds to 1,001", groupNumber(1000.6), "1,001");
eq("999.4 rounds to 999", groupNumber(999.4), "999");

// ---------------------------------------------------------------------------
// titleCase
// ---------------------------------------------------------------------------
console.log("\n-- titleCase --");

eq("empty string -> empty", titleCase(""), "");
eq("admin -> Admin", titleCase("admin"), "Admin");
eq("owner -> Owner", titleCase("owner"), "Owner");
eq("already capitalised -> unchanged", titleCase("Admin"), "Admin");
eq("single char -> capitalised", titleCase("a"), "A");
eq("multi-word: first char only", titleCase("active user"), "Active user");
// Null-defence: a PARTIAL engine response can hand a tile an undefined or
// non-string field (the type says string, the wire does not promise it). titleCase must
// degrade to "" rather than throw on .length and blank the whole overview. The casts model
// the runtime shape TypeScript cannot see across a settled-but-partial response.
eq("undefined -> empty (no throw)", titleCase(undefined as unknown as string), "");
eq("null -> empty (no throw)", titleCase(null as unknown as string), "");
eq("number -> empty (no throw)", titleCase(42 as unknown as string), "");
eq("object -> empty (no throw)", titleCase({} as unknown as string), "");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nFORMAT HELPERS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
