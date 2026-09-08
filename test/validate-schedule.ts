// Validate the per-downpipe Advanced-schedule helpers (src/lib/schedule.ts): the CLIENT-SIDE half of
// the engine's optional DownpipeConfig.schedule (cron / timezone / blackout windows). These are pure
// functions (no DOM; only Intl, which Node provides), so this validator drives them directly, using
// the same approach validate-format.ts uses for the pure formatting helpers.
//
// Run with `node test/validate-schedule.ts`.
//
// Coverage (each load-bearing property of the contract + the task's required proofs):
//   BACK-COMPAT (the central guarantee):
//     - assembleSchedule with advancedOn=false returns undefined (a plain interval downpipe sends NO
//       schedule object, byte-unchanged from a pre-schedule create/edit).
//     - assembleSchedule with advancedOn=true but nothing meaningful (no cron, no windows, blank/UTC
//       tz) ALSO returns undefined (opening the disclosure but setting nothing is still interval-only).
//   WIRE ASSEMBLY (the disclosure assembles a correct schedule object):
//     - cron + non-default timezone + blackout windows assemble into the exact wire shape, with the
//       blackout times captured as minutes-since-local-midnight, and the optional `days` present only
//       when the window is weekday-restricted (omitted for an every-day window).
//     - the assembled object passes validateSchedule (so the console would not self-reject what it built).
//   CLIENT-SIDE CRON VALIDATION (rejects a malformed cron, accepts a valid one):
//     - validateCronExpr accepts the standard forms (*, N, A-B, lists, steps; the dow=7 alias) and
//       REJECTS a wrong field count, out-of-range values, @-macros, and named fields, with a reason.
//     - validateSchedule wraps a bad cron as "schedule.cron is invalid: ..." and rejects an unknown
//       timezone and an out-of-range / malformed blackout window (mirroring the engine's bounds).
//   TIME <-> MINUTES round-trip (the blackout wire encoding):
//     - parseTimeToMinutes / minutesToTime are inverse over valid HH:MM, and parseTimeToMinutes
//       rejects junk; 24:00 maps to 1440 (the engine's inclusive end-of-day bound).
//   NEXT-RUNS PREVIEW (the honest client-side estimate that mirrors the engine's nextFireAfter):
//     - nextCronFires returns the requested count of STRICTLY-INCREASING future epochs whose
//       wall-clock fields in the zone satisfy the cron; an empty array for a malformed cron / unknown
//       zone; and DEFERS a fire that lands inside a blackout window to after the window.
//
// Each section carries a negative control that would fail on a wrong/no-op implementation.

import {
  validateCronExpr,
  validateSchedule,
  isValidTimeZone,
  browserTimeZone,
  assembleSchedule,
  parseTimeToMinutes,
  minutesToTime,
  nextCronFires,
  scheduleSummary,
  SCHEDULE_TZ_DEFAULT,
  COMMON_TIME_ZONES,
  type ScheduleDraft,
} from "../src/lib/schedule.ts";
import { SCHEDULE_MAX_BLACKOUT_WINDOWS, MINUTES_PER_DAY, type DownpipeSchedule } from "../src/api.ts";
import { installDomShim, qs, qsa } from "./dom-shim.ts";
installDomShim();
import { buildScheduleSection } from "../src/screens/sources-downpipes/editor-schedule.ts";
import { makeChecks } from "./validate-checks.ts";

const checks = makeChecks();
const { ok } = checks;

// A small deep-equal for the assembled wire object (plain JSON shapes only).
function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// BACK-COMPAT: a plain interval downpipe sends NO schedule object
// ---------------------------------------------------------------------------
console.log("\n-- schedule: back-compat (interval-only sends no schedule object) --");
{
  const intervalOnly: ScheduleDraft = { advancedOn: false, cron: "0 2 * * *", timeZone: "Australia/Sydney", windows: [{ days: [1], startMinute: 60, endMinute: 120 }] };
  // advancedOn=false MUST drop everything, even if the (now-hidden) fields hold values.
  ok("advancedOn=false -> assembleSchedule returns undefined (no schedule sent)", assembleSchedule(intervalOnly) === undefined);

  // advancedOn=true but nothing meaningful (no cron, no windows, default tz) is STILL interval-only.
  const emptyAdvanced: ScheduleDraft = { advancedOn: true, cron: "   ", timeZone: "UTC", windows: [] };
  ok("advancedOn=true but empty (no cron/windows, UTC) -> undefined", assembleSchedule(emptyAdvanced) === undefined);
  const blankTz: ScheduleDraft = { advancedOn: true, cron: "", timeZone: "", windows: [] };
  ok("advancedOn=true, all blank -> undefined", assembleSchedule(blankTz) === undefined);

  // Negative control: a cron present DOES produce a schedule (proving the undefined above is real).
  ok("negative: advancedOn=true with a cron DOES produce a schedule", assembleSchedule({ advancedOn: true, cron: "0 2 * * *", timeZone: "", windows: [] }) !== undefined);
}

// ---------------------------------------------------------------------------
// WIRE ASSEMBLY: cron + tz + blackout windows in minutes
// ---------------------------------------------------------------------------
console.log("\n-- schedule: assembles a correct wire object (cron + tz + blackout in minutes) --");
{
  // 02:30 daily in Sydney, plus two windows: a weekday-restricted one (Mon+Tue, 01:00-03:00) and an
  // every-day one (22:00-23:00). The wire carries minutes-since-midnight; `days` only on the restricted one.
  const draft: ScheduleDraft = {
    advancedOn: true,
    cron: "30 2 * * *",
    timeZone: "Australia/Sydney",
    windows: [
      { days: [2, 1], startMinute: 60, endMinute: 180 }, // unsorted days on purpose
      { days: [], startMinute: 1320, endMinute: 1380 },
    ],
  };
  const wire = assembleSchedule(draft);
  const expected: DownpipeSchedule = {
    cron: "30 2 * * *",
    timeZone: "Australia/Sydney",
    blackoutWindows: [
      { days: [1, 2], startMinute: 60, endMinute: 180 }, // days sorted ascending
      { startMinute: 1320, endMinute: 1380 }, // every-day window: NO days field
    ],
  };
  ok("assembled wire object matches the expected cron/tz/blackout shape", eq(wire, expected));
  ok("blackout startMinute is minutes-since-local-midnight (01:00 -> 60)", wire?.blackoutWindows?.[0]?.startMinute === 60);
  ok("every-day window OMITS the days field (absent = every day)", wire?.blackoutWindows?.[1] !== undefined && !("days" in (wire!.blackoutWindows![1] as object)));
  ok("weekday-restricted window keeps a sorted days array", eq(wire?.blackoutWindows?.[0]?.days, [1, 2]));
  // The console must not self-reject what it assembled.
  ok("the assembled object passes validateSchedule (no self-rejection)", validateSchedule(wire) === null);

  // A schedule with ONLY blackout windows (no cron) is valid and rides the interval cadence.
  const windowsOnly = assembleSchedule({ advancedOn: true, cron: "", timeZone: "UTC", windows: [{ days: [], startMinute: 60, endMinute: 180 }] });
  ok("windows-only (no cron) still assembles a schedule", windowsOnly !== undefined && windowsOnly.cron === undefined && (windowsOnly.blackoutWindows?.length ?? 0) === 1);
  ok("windows-only passes validateSchedule", validateSchedule(windowsOnly) === null);

  // A bare non-UTC timezone alone is meaningful enough to anchor (it changes nothing without a cron,
  // but records intent); a non-default tz with nothing else still produces a schedule carrying the tz.
  const tzOnly = assembleSchedule({ advancedOn: true, cron: "", timeZone: "America/New_York", windows: [] });
  ok("non-default tz alone produces a schedule carrying the timezone", tzOnly !== undefined && tzOnly.timeZone === "America/New_York" && tzOnly.cron === undefined);
}

// ---------------------------------------------------------------------------
// CLIENT-SIDE CRON VALIDATION: accept valid, reject malformed
// ---------------------------------------------------------------------------
console.log("\n-- schedule: client-side cron validation (accepts valid, rejects malformed) --");
{
  // Valid forms across the grammar.
  const valid = [
    "* * * * *",
    "0 2 * * *",
    "30 1 * * 1",
    "*/15 * * * *",
    "0 0 1 1 *",
    "0 0 13 * 5", // dom+dow union
    "0 0 * * 7", // dow=7 alias for Sunday
    "0 9-17 * * 1-5",
    "0,30 * * * *",
    "0 0 29 2 *", // Feb 29: valid grammar (rare fire, but accepted)
  ];
  let allValid = true;
  for (const c of valid) {
    const err = validateCronExpr(c);
    if (err !== null) { allValid = false; console.log(`       (unexpected reject: "${c}" -> ${err})`); }
  }
  ok("every standard cron form is accepted (null error)", allValid);

  // Malformed expressions each rejected with a reason.
  const bad: Array<[string, RegExp]> = [
    ["0 2 * *", /5 fields/i], // 4 fields
    ["0 2 * * * *", /5 fields/i], // 6 fields
    ["60 2 * * *", /out of range/i], // minute 60
    ["0 24 * * *", /out of range/i], // hour 24
    ["0 2 32 * *", /out of range/i], // dom 32
    ["0 2 * 13 *", /out of range/i], // month 13
    ["0 2 * * 8", /out of range/i], // dow 8
    ["@daily", /macro/i], // @-macro
    ["0 2 * * MON", /not a valid number|out of range/i], // named field
    ["5-1 * * * *", /A <= B/i], // inverted range
    ["*/0 * * * *", /at least 1/i], // zero step
  ];
  let allRejected = true;
  for (const [c, re] of bad) {
    const err = validateCronExpr(c);
    if (err === null || !re.test(err)) { allRejected = false; console.log(`       (expected reject matching ${re}: "${c}" -> ${err})`); }
  }
  ok("every malformed cron is rejected with a matching reason", allRejected);
  // Negative control: the valid set is not vacuously rejected (proves the accept path is real).
  ok("negative: a known-good cron is NOT rejected", validateCronExpr("0 2 * * *") === null);
}

// ---------------------------------------------------------------------------
// validateSchedule: tz + blackout bounds mirror the engine
// ---------------------------------------------------------------------------
console.log("\n-- schedule: validateSchedule mirrors the engine's tz + blackout bounds --");
{
  ok("undefined schedule is accepted (the no-schedule default)", validateSchedule(undefined) === null);

  // A malformed cron is wrapped with the engine's prefix.
  const badCron = validateSchedule({ cron: "0 99 * * *" });
  ok("a bad cron is reported as 'schedule.cron is invalid: ...'", badCron !== null && /schedule\.cron is invalid/i.test(badCron));

  // Unknown timezone.
  const badTz = validateSchedule({ timeZone: "Mars/Olympus" });
  ok("an unknown timezone is rejected", badTz !== null && /not a known IANA time zone/i.test(badTz));
  ok("a blank timezone is rejected", validateSchedule({ timeZone: "   " }) !== null);

  // Blackout window bounds.
  ok("startMinute > 1440 is rejected", validateSchedule({ blackoutWindows: [{ startMinute: 1441, endMinute: 60 }] }) !== null);
  ok("a non-integer endMinute is rejected", validateSchedule({ blackoutWindows: [{ startMinute: 60, endMinute: 90.5 }] }) !== null);
  ok("a weekday outside 0-6 is rejected", validateSchedule({ blackoutWindows: [{ days: [7], startMinute: 60, endMinute: 120 }] }) !== null);
  ok("too many windows is rejected", validateSchedule({ blackoutWindows: Array.from({ length: SCHEDULE_MAX_BLACKOUT_WINDOWS + 1 }, () => ({ startMinute: 0, endMinute: 60 })) }) !== null);
  // An equal start and end covers no time (a fat-finger of the same time in both boxes), which the engine
  // rejects; the console mirrors that reject inline instead of drawing a late engine 400.
  ok("an equal-start-end blackout window is rejected (mirrors the engine's equal-start-end reject)", validateSchedule({ blackoutWindows: [{ startMinute: 120, endMinute: 120 }] }) !== null);
  ok("a start<end window is still accepted (the reject is only for equal times)", validateSchedule({ blackoutWindows: [{ startMinute: 120, endMinute: 180 }] }) === null);
  // A well-formed window at the boundary is accepted.
  ok("a window 0..1440 with valid days is accepted", validateSchedule({ blackoutWindows: [{ days: [0, 6], startMinute: 0, endMinute: MINUTES_PER_DAY }] }) === null);
  // Negative control: a fully valid schedule passes.
  ok("negative: a valid cron+tz+window schedule passes", validateSchedule({ cron: "0 2 * * *", timeZone: "UTC", blackoutWindows: [{ startMinute: 60, endMinute: 120 }] }) === null);

  // isValidTimeZone sanity (it backs the tz checks).
  ok("isValidTimeZone accepts UTC and a real zone", isValidTimeZone("UTC") && isValidTimeZone("Australia/Sydney"));
  ok("isValidTimeZone rejects junk", !isValidTimeZone("Nowhere/Nope") && !isValidTimeZone(""));
}

// ---------------------------------------------------------------------------
// TIME <-> MINUTES round-trip (the blackout wire encoding)
// ---------------------------------------------------------------------------
console.log("\n-- schedule: HH:MM <-> minutes-since-midnight round-trip --");
{
  const cases: Array<[string, number]> = [["00:00", 0], ["01:00", 60], ["09:30", 570], ["22:00", 1320], ["23:59", 1439], ["24:00", 1440]];
  let roundTrips = true;
  for (const [s, m] of cases) {
    if (parseTimeToMinutes(s) !== m) { roundTrips = false; console.log(`       (parse "${s}" -> ${parseTimeToMinutes(s)}, expected ${m})`); }
  }
  ok("parseTimeToMinutes maps valid HH:MM to the right minute count (incl. 24:00 -> 1440)", roundTrips);
  ok("minutesToTime inverts parseTimeToMinutes over the range", minutesToTime(0) === "00:00" && minutesToTime(570) === "09:30" && minutesToTime(1320) === "22:00" && minutesToTime(1440) === "24:00");
  ok("parseTimeToMinutes rejects junk (no colon, bad minute, empty)", parseTimeToMinutes("2pm") === null && parseTimeToMinutes("10:75") === null && parseTimeToMinutes("") === null);
}

// ---------------------------------------------------------------------------
// NEXT-RUNS PREVIEW: the honest client-side estimate (mirrors nextFireAfter)
// ---------------------------------------------------------------------------
console.log("\n-- schedule: next-runs preview (strictly-increasing future fires; blackout deferral) --");
{
  // From a fixed instant, "0 2 * * *" in UTC fires at the next 02:00 UTC, then daily after.
  const from = Date.UTC(2026, 0, 1, 0, 0, 0); // UTC
  const fires = nextCronFires("0 2 * * *", "UTC", 3, from);
  ok("returns the requested number of fire times", fires.length === 3);
  ok("every fire is strictly after the source instant", fires.every((f) => f > from));
  ok("fires are strictly increasing", fires[0]! < fires[1]! && fires[1]! < fires[2]!);
  // First fire is UTC; subsequent are +24h.
  ok("first fire is the next 02:00 UTC", fires[0] === Date.UTC(2026, 0, 1, 2, 0, 0));
  ok("daily cadence: each fire is 24h after the previous", fires[1]! - fires[0]! === 86400000 && fires[2]! - fires[1]! === 86400000);

  // A blackout window covering 02:00-03:00 UTC defers the 02:00 fire to 03:00.
  const deferred = nextCronFires("0 2 * * *", "UTC", 1, from, [{ startMinute: 120, endMinute: 180 }]);
  ok("a fire inside a blackout window is deferred to after the window", deferred.length === 1 && deferred[0] === Date.UTC(2026, 0, 1, 3, 0, 0));

  // Day-restriction guard: the same 02:00-03:00 window restricted to Monday (days:[1]) must NOT
  // defer a fire that lands, which is a Thursday. This exercises the day filter on
  // the deferral path, distinct from the every-day window above.
  const notDeferred = nextCronFires("0 2 * * *", "UTC", 1, from, [{ startMinute: 120, endMinute: 180, days: [1] }]);
  ok(
    "a fire on a day outside a weekday-restricted blackout window is NOT deferred",
    notDeferred.length === 1 && notDeferred[0] === Date.UTC(2026, 0, 1, 2, 0, 0),
  );

  // Malformed cron / unknown zone -> empty (the UI shows an honest 'no preview', never invented times).
  ok("a malformed cron yields no preview rows", nextCronFires("0 99 * * *", "UTC", 3, from).length === 0);
  ok("an unknown timezone yields no preview rows", nextCronFires("0 2 * * *", "Nowhere/Nope", 3, from).length === 0);
  // Negative control: the valid case above DID return rows (so the empties are real, not a broken walk).
  ok("negative: the valid cron+zone DID return rows", fires.length > 0);

  // Timezone correctness: "0 2 * * *" in Australia/Sydney is NOT 02:00 UTC (Sydney is ahead of UTC),
  // proving the walk reads wall-clock in the chosen zone, not UTC.
  const syd = nextCronFires("0 2 * * *", "Australia/Sydney", 1, from);
  ok("a zoned cron fires at the zone's wall-clock time, not UTC", syd.length === 1 && syd[0] !== Date.UTC(2026, 0, 1, 2, 0, 0));
}

// ---------------------------------------------------------------------------
// scheduleSummary: a calm plain-words line for the drawer
// ---------------------------------------------------------------------------
console.log("\n-- schedule: scheduleSummary plain-words line --");
{
  ok("absent schedule reads as the interval default", scheduleSummary(undefined) === "Uses the interval cadence above.");
  const s = scheduleSummary({ cron: "0 2 * * *", timeZone: "Australia/Sydney", blackoutWindows: [{ startMinute: 60, endMinute: 120 }] });
  ok("a cron schedule names the cron + tz + window count", /Cron 0 2 \* \* \* \(Australia\/Sydney\)/.test(s) && /1 blackout window/.test(s));
  // A schedule with no tz uses the UTC default label.
  ok("a cron with no tz labels UTC", /\(UTC\)/.test(scheduleSummary({ cron: "0 2 * * *" })));
  ok("SCHEDULE_TZ_DEFAULT is UTC", SCHEDULE_TZ_DEFAULT === "UTC");
}

// ---------------------------------------------------------------------------
// CRON GRAMMAR: every malformed-term branch the engine's parseField rejects
// ---------------------------------------------------------------------------
// validateCronExpr is the only public door into parseCron / parseCronField, so each grammar branch is
// driven through it. Each input below trips exactly one guard, with the field-named reason asserted, so
// a regression that silently accepts (or mis-messages) a bad term is caught.
console.log("\n-- schedule: cron grammar rejects each malformed term shape --");
{
  const grammar: Array<[string, RegExp, string]> = [
    // An EMPTY field inside an otherwise-5-field expression (two spaces collapse, so an empty field
    // is produced by a leading/embedded literal empty term only via the field-count path; the direct
    // "field is empty" guard fires when a field trims to "" after the 5-way split keeps a blank).
    ["\t0\t2\t*\t*\t\t", /field is empty|5 fields/i, "empty trailing field"],
    // An empty LIST item: "1,,2" leaves a "" between the commas.
    ["1,,2 * * * *", /empty list item/i, "empty list item"],
    // A step that is not a positive integer: "*/x".
    ["*/x * * * *", /step .* must be a positive integer/i, "non-numeric step"],
    // A step base that is MISSING: "/5" (slash with nothing before it).
    ["/5 * * * *", /step is missing its base/i, "missing step base"],
    // A range with a non-numeric endpoint: "a-b".
    ["a-b * * * *", /must be two integers A-B/i, "non-numeric range endpoints"],
    // A RANGE whose upper bound is out of range (distinct from a bare out-of-range value): "10-70" in
    // the minute field (max 59) trips the range bounds check, not the single-value check.
    ["10-70 * * * *", /range .* out of range/i, "range upper bound out of range"],
    // A term that is none of number / range / step: "abc".
    ["abc * * * *", /not a valid number, range, or step/i, "junk term"],
    // A non-string expression (defensive door): an empty/whitespace expression is the empty guard.
    ["   ", /cron expression is empty/i, "all-whitespace expression"],
  ];
  let allHit = true;
  for (const [expr, re, why] of grammar) {
    const err = validateCronExpr(expr);
    if (err === null || !re.test(err)) { allHit = false; console.log(`       (${why}: "${expr}" -> ${err})`); }
  }
  ok("each malformed-term branch is rejected with its field-named reason", allHit);

  // The A/n step form (a base NUMBER with a step, e.g. "5/10"): a valid, accepted shape that drives the
  // lo=n / hi=max expansion branch. 5/10 in the minute field means 5,15,25,35,45,55.
  ok("the A/n step form (base number + step) is accepted", validateCronExpr("5/10 * * * *") === null);
  // And it actually expands to the stepped set, proving the lo=n/hi=max branch computed real values:
  // "5/10 0 1 1 *" fires only at minute 5,15,25,35,45,55 of hour 0 on 1 Jan. The first fire from just
  // before 00:05 is 00:05; the second is 00:15 (a +10-minute step), confirming the expansion.
  {
    const from = Date.UTC(2026, 0, 1, 0, 4, 0); // 00:04 UTC, 1 Jan
    const f = nextCronFires("5/10 0 1 1 *", "UTC", 2, from);
    ok("A/n step expands to the stepped minute set (00:05 then 00:15)",
      f.length === 2 && f[0] === Date.UTC(2026, 0, 1, 0, 5, 0) && f[1]! - f[0]! === 10 * 60000);
  }

  // A non-string expression goes through the typeof guard (the editor only ever passes a string, but
  // the guard exists; exercise it through the public function with a cast).
  ok("a non-string cron expression is rejected", validateCronExpr(undefined as unknown as string) !== null);
}

// ---------------------------------------------------------------------------
// validateSchedule: the type-guard branches (non-object / wrong-typed fields)
// ---------------------------------------------------------------------------
// These cover the defensive shape guards the engine's validateConfig also enforces, so a hand-built or
// corrupted schedule object is rejected with the engine's own message rather than slipping through.
console.log("\n-- schedule: validateSchedule rejects malformed shapes (type guards) --");
{
  // The schedule itself must be a plain object (not an array, not a primitive, not null-with-a-cron).
  ok("a non-object schedule is rejected", validateSchedule([] as unknown as undefined) !== null);
  ok("a primitive schedule is rejected", validateSchedule("nope" as unknown as undefined) !== null);

  // cron must be a string (a number cron trips the typeof guard before validateCronExpr).
  const cronType = validateSchedule({ cron: 1234 as unknown as string });
  ok("a non-string cron is rejected as 'schedule.cron must be a string'", cronType !== null && /schedule\.cron must be a string/i.test(cronType));

  // blackoutWindows must be an array.
  const bwType = validateSchedule({ blackoutWindows: { startMinute: 0, endMinute: 60 } as unknown as [] });
  ok("a non-array blackoutWindows is rejected", bwType !== null && /must be an array/i.test(bwType));

  // each window must be an object.
  const winType = validateSchedule({ blackoutWindows: ["07:00" as unknown as { startMinute: number; endMinute: number }] });
  ok("a non-object blackout window is rejected", winType !== null && /each blackout window must be an object/i.test(winType));

  // window.days, when present, must be an array.
  const daysType = validateSchedule({ blackoutWindows: [{ days: 3 as unknown as number[], startMinute: 0, endMinute: 60 }] });
  ok("a non-array window.days is rejected", daysType !== null && /days must be an array/i.test(daysType));

  // A negative startMinute (the lower-bound arm of the integer-range guard).
  ok("a negative startMinute is rejected", validateSchedule({ blackoutWindows: [{ startMinute: -1, endMinute: 60 }] }) !== null);
  // A negative endMinute.
  ok("a negative endMinute is rejected", validateSchedule({ blackoutWindows: [{ startMinute: 0, endMinute: -1 }] }) !== null);
}

// ---------------------------------------------------------------------------
// cronMatches via nextCronFires: month mismatch + single dom/dow star arms
// ---------------------------------------------------------------------------
// cronMatches is private; it is driven through nextCronFires. These inputs force the month-mismatch
// early-out and each single-star arm of the Vixie dom/dow union, so the preview matches the engine's
// fire selection exactly.
console.log("\n-- schedule: cronMatches month + dom/dow single-star arms (via preview) --");
{
  // MONTH constraint: "0 0 1 3 *" fires only at 00:00 on 1 March. Starting from 5 Feb, the first fire
  // is (so the month guard skipped the rest of February), proving the month early-out
  // works. The 5 Feb start keeps the fire inside the bounded 35-day preview window (a 1 Jan start
  // would now fall outside it, which the preview honestly returns as no rows).
  const marchOnly = nextCronFires("0 0 1 3 *", "UTC", 1, Date.UTC(2026, 1, 5, 0, 0, 0));
  ok("a month-constrained cron skips non-matching months (fires only in March)",
    marchOnly.length === 1 && marchOnly[0] === Date.UTC(2026, 2, 1, 0, 0, 0));

  // dom restricted, dow STAR: "0 0 15 * *" fires on the 15th of every month regardless of weekday.
  // From 1 Jan the first fire is the 15th (the dow.star -> only dom constrains arm).
  const domOnly = nextCronFires("0 0 15 * *", "UTC", 1, Date.UTC(2026, 0, 1, 0, 0, 0));
  ok("dom set, dow=* fires on the day-of-month (dow.star arm)",
    domOnly.length === 1 && domOnly[0] === Date.UTC(2026, 0, 15, 0, 0, 0));

  // dom STAR, dow restricted: "0 0 * * 1" fires every Monday. is a Thursday; the first
  // Monday at/after 00:00 is (the dom.star -> only dow constrains arm).
  const dowOnly = nextCronFires("0 0 * * 1", "UTC", 1, Date.UTC(2026, 0, 1, 0, 0, 0));
  ok("dom=*, dow set fires on the weekday (dom.star arm)",
    dowOnly.length === 1 && dowOnly[0] === Date.UTC(2026, 0, 5, 0, 0, 0));

  // BOTH restricted (the union arm, domOK || dowOK): "0 0 13 * 5" fires on the 13th OR any Friday.
  // From 1 Jan 2026, the first Friday is the 2nd (dowOK true even though it is not the 13th).
  const union = nextCronFires("0 0 13 * 5", "UTC", 1, Date.UTC(2026, 0, 1, 0, 0, 0));
  ok("dom+dow both set fires on EITHER (union arm: first Friday before the 13th)",
    union.length === 1 && union[0] === Date.UTC(2026, 0, 2, 0, 0, 0));
}

// ---------------------------------------------------------------------------
// nextCronFires guards: count <= 0 and a non-finite fromMs return []
// ---------------------------------------------------------------------------
console.log("\n-- schedule: nextCronFires input guards (count<=0, non-finite from) --");
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  ok("count <= 0 yields no rows", nextCronFires("0 2 * * *", "UTC", 0, Date.UTC(2026, 0, 1)).length === 0);
  ok("a negative count yields no rows", nextCronFires("0 2 * * *", "UTC", -3, Date.UTC(2026, 0, 1)).length === 0);
  ok("a non-finite fromMs yields no rows", nextCronFires("0 2 * * *", "UTC", 3, Number.NaN).length === 0);
  // Negative control: the same cron/zone with a sane count + from DOES return rows.
  ok("negative: a sane count + from DID return rows", nextCronFires("0 2 * * *", "UTC", 2, Date.UTC(2026, 0, 1)).length === 2);
}

// ---------------------------------------------------------------------------
// Blackout window membership shapes (via nextCronFires deferral)
// ---------------------------------------------------------------------------
// windowCoversLocalMinute is private; it is driven through nextCronFires' deferral. These cover the
// day-filtered window, an EMPTY (start===end) window, and a WRAPPING (past-midnight) window, matching
// the engine's half-open membership test exactly.
console.log("\n-- schedule: blackout window membership (day filter, empty, wrapping) --");
{
  const base = Date.UTC(2026, 0, 1, 0, 0, 0); // UTC (a Thursday, dow=4)

  // DAY-FILTERED window that does NOT cover the fire's weekday: "0 2 * * *" fires Thu 02:00; a window
  // 02:00-03:00 restricted to MONDAY only (days:[1]) must NOT defer it (the day filter excludes it).
  const notMon = nextCronFires("0 2 * * *", "UTC", 1, base, [{ days: [1], startMinute: 120, endMinute: 180 }]);
  ok("a window restricted to a non-matching weekday does NOT defer the fire",
    notMon.length === 1 && notMon[0] === Date.UTC(2026, 0, 1, 2, 0, 0));

  // DAY-FILTERED window that DOES cover the weekday (Thursday=4) DOES defer: 02:00 -> 03:00.
  const thu = nextCronFires("0 2 * * *", "UTC", 1, base, [{ days: [4], startMinute: 120, endMinute: 180 }]);
  ok("a window restricted to the matching weekday DOES defer the fire",
    thu.length === 1 && thu[0] === Date.UTC(2026, 0, 1, 3, 0, 0));

  // EMPTY window (startMinute === endMinute) covers nothing, so the fire is NOT deferred.
  const empty = nextCronFires("0 2 * * *", "UTC", 1, base, [{ startMinute: 120, endMinute: 120 }]);
  ok("an empty window (start === end) covers nothing and does not defer",
    empty.length === 1 && empty[0] === Date.UTC(2026, 0, 1, 2, 0, 0));

  // WRAPPING window past midnight: 23:00-01:00 (startMinute 1380 > endMinute 60). A 00:30 fire lands
  // inside the [start,1440) U [0,end) wrap and is deferred to 01:00. "30 0 * * *" fires 00:30.
  const wrap = nextCronFires("30 0 * * *", "UTC", 1, base, [{ startMinute: 1380, endMinute: 60 }]);
  ok("a wrapping (past-midnight) window defers a fire that lands in the wrap",
    wrap.length === 1 && wrap[0] === Date.UTC(2026, 0, 1, 1, 0, 0));
  // And the same wrapping window does NOT touch a fire OUTSIDE the wrap (12:00 is clear).
  const wrapClear = nextCronFires("0 12 * * *", "UTC", 1, base, [{ startMinute: 1380, endMinute: 60 }]);
  ok("a wrapping window leaves a fire outside the wrap untouched",
    wrapClear.length === 1 && wrapClear[0] === Date.UTC(2026, 0, 1, 12, 0, 0));
}

// ---------------------------------------------------------------------------
// DST: an autumn fall-back day exercises the two-iteration offset settle
// ---------------------------------------------------------------------------
// wallFieldsToEpoch settles the zone offset in two iterations so a fire across a DST transition maps to
// the right instant. Australia/Sydney falls back 03:00 -> 02:00 on the first Sunday of April, which
// LENGTHENS that local day to 25 hours. A daily 02:30 cron fired across that boundary therefore has a
// 25-hour inter-fire gap, which a fixed-24h-stride implementation (blind to the offset change) could
// never produce, so this proves the offset re-settled (the o2 !== o1 arm of wallFieldsToEpoch).
console.log("\n-- schedule: DST offset settle across an autumn fall-back boundary --");
{
  // is the first Sunday of April; Sydney falls back 03:00 -> 02:00 that morning.
  // Start the search before that day and ask for the 02:30 Sydney fires around the transition.
  const beforeDst = Date.UTC(2026, 3, 3, 0, 0, 0); // UTC
  const fires = nextCronFires("30 2 * * *", "Australia/Sydney", 3, beforeDst);
  ok("a cron across a DST fall-back returns the requested fires", fires.length === 3);
  ok("DST fires remain strictly increasing across the transition",
    fires[0]! < fires[1]! && fires[1]! < fires[2]!);
  // The fall-back day is 25 hours long, so the gap spanning the transition is exactly 25h, while a
  // normal day stays at 24h. Seeing a 25h gap proves the offset re-settled rather than blindly striding.
  const gaps = [fires[1]! - fires[0]!, fires[2]! - fires[1]!];
  ok("the DST fall-back day lengthens one inter-fire gap to 25h",
    gaps.every((g) => g > 0) && gaps.includes(25 * 3600000));
}

// ---------------------------------------------------------------------------
// parseTimeToMinutes: the out-of-range arm (HH:MM that parses but exceeds 1440)
// ---------------------------------------------------------------------------
console.log("\n-- schedule: parseTimeToMinutes out-of-range arm --");
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  // "24:30" matches the HH:MM regex (hours can be 24) and the minute is 0-59, so it passes those
  // guards, but 24*60+30 = 1470 exceeds MINUTES_PER_DAY (1440) and is rejected by the total bound.
  ok("a time past 24:00 (e.g. 24:30 -> 1470) is rejected by the total bound", parseTimeToMinutes("24:30") === null);
  // "25:00" likewise exceeds the day.
  ok("25:00 is rejected", parseTimeToMinutes("25:00") === null);
}

// ---------------------------------------------------------------------------
// scheduleSummary: the no-cron ("Interval cadence") arm + plural windows
// ---------------------------------------------------------------------------
console.log("\n-- schedule: scheduleSummary no-cron + plural-window arms --");
{
  // A schedule with NO cron (windows only) reads "Interval cadence" (the else arm of the cron check).
  const windowsOnly = scheduleSummary({ blackoutWindows: [{ startMinute: 60, endMinute: 120 }, { startMinute: 180, endMinute: 240 }] });
  ok("a windows-only schedule reads 'Interval cadence'", /^Interval cadence/.test(windowsOnly));
  // TWO windows uses the PLURAL "windows" (the n === 1 ? '' : 's' false arm).
  ok("two windows are summarised as plural '2 blackout windows'", /2 blackout windows/.test(windowsOnly));
  // A cron whose text is only whitespace falls back to the interval arm too (the trim() === '' branch).
  ok("a whitespace-only cron falls back to 'Interval cadence'", /^Interval cadence/.test(scheduleSummary({ cron: "   " })));
  // A schedule with no windows omits the window clause entirely (n === 0 -> the if is not taken).
  ok("a cron with no windows omits the window clause", scheduleSummary({ cron: "0 2 * * *", timeZone: "UTC" }) === "Cron 0 2 * * * (UTC).");
}

// ---------------------------------------------------------------------------
// browserTimeZone + COMMON_TIME_ZONES (the picker defaults)
// ---------------------------------------------------------------------------
console.log("\n-- schedule: browserTimeZone resolves a valid zone (picker default) --");
{
  // browserTimeZone reads the host's resolved zone via Intl and falls back to UTC. On any conformant
  // runtime (Node here) it returns a NON-EMPTY string that is itself a valid IANA zone (it self-checks
  // with isValidTimeZone before returning the resolved value).
  const tz = browserTimeZone();
  ok("browserTimeZone returns a non-empty string", typeof tz === "string" && tz.trim() !== "");
  ok("browserTimeZone returns a valid IANA zone (or the UTC fallback)", isValidTimeZone(tz));

  // COMMON_TIME_ZONES is the picker datalist: UTC first, and every listed zone must itself be a valid
  // IANA zone (a typo in the list would offer the operator an un-saveable default).
  ok("COMMON_TIME_ZONES leads with UTC", COMMON_TIME_ZONES[0] === "UTC");
  ok("every COMMON_TIME_ZONES entry is a valid IANA zone", COMMON_TIME_ZONES.length > 1 && COMMON_TIME_ZONES.every((z) => isValidTimeZone(z)));
}

// ---------------------------------------------------------------------------
// The Advanced-schedule SECTION component (buildScheduleSection): the client-side
// gate before a schedule reaches the engine. assemble() flags a half-filled window
// row (blocking, no submit) and otherwise returns the assembled wire schedule;
// readWindows()'s empty/half/full semantics are exercised through it. Driven under
// the DOM shim, exactly as the other component validators run.
// ---------------------------------------------------------------------------
console.log("\n-- schedule: buildScheduleSection assemble() / window-row semantics (component) --");
{
  // (a) Editing an EXISTING schedule (advanced seeded ON, one well-formed window): assemble() returns
  // the wire schedule with no error, and getDraft's shape is reflected in that assembled object.
  const seeded = buildScheduleSection({ cron: "0 3 * * *", timeZone: "Australia/Sydney", blackoutWindows: [{ days: [1, 2], startMinute: 120, endMinute: 240 }] });
  const seededRes = seeded.assemble();
  ok("a seeded (existing) schedule assembles with no error", seededRes.error === null && seededRes.schedule !== undefined);
  ok("the assembled schedule carries the seeded cron + timezone (getDraft shape)", seededRes.schedule?.cron === "0 3 * * *" && seededRes.schedule?.timeZone === "Australia/Sydney");
  ok("the assembled schedule carries the one seeded blackout window", (seededRes.schedule?.blackoutWindows?.length ?? 0) === 1 && seededRes.schedule?.blackoutWindows?.[0]?.startMinute === 120);

  // (b) A fully-BLANK window row (both times empty) is skipped by readWindows(): assemble() succeeds and
  // drops the empty row, never an error. Add an empty row to the seeded section and re-assemble.
  const removeBtn = qs(seeded.el, "button[aria-label='Remove this maintenance window']"); // sanity: a row exists
  ok("the seeded section mounted at least one window row", removeBtn !== null);
  // Append a genuinely empty extra row via the public add button.
  const addWindow = qsa(seeded.el, "button").find((b) => b.textContent.includes("Add maintenance window"));
  ok("the add-maintenance-window button is present", addWindow !== undefined);
  addWindow?.click();
  const afterEmpty = seeded.assemble();
  ok("an empty window row is skipped (no error, still assembles)", afterEmpty.error === null && afterEmpty.schedule !== undefined);

  // (c) A HALF-FILLED window row (start set, end blank) is a blocking error: assemble() returns an error,
  // an undefined schedule, and the row's inline error is shown. Build a fresh section, add a row, set only
  // the start time.
  const half = buildScheduleSection({ cron: "0 4 * * *", timeZone: "UTC", blackoutWindows: [] });
  const halfAdd = qsa(half.el, "button").find((b) => b.textContent.includes("Add maintenance window"));
  halfAdd?.click();
  const timeInputs = qsa(half.el, "input[type='time']");
  ok("the added window row exposes two time inputs", timeInputs.length >= 2);
  if (timeInputs[0]) timeInputs[0].value = "09:00"; // start set, end left blank
  const halfRes = half.assemble();
  ok("a half-filled window row blocks assembly (error set, no schedule)", halfRes.error !== null && halfRes.schedule === undefined);
  const rowErr = qsa(half.el, "p.field__error[role='alert']").find((p) => p.textContent.includes("Set both a start and an end time"));
  ok("the half-filled row surfaces an inline error", rowErr !== undefined && rowErr.hidden === false);

  // (d) Completing the row (both times valid) clears the block: assemble() now succeeds.
  if (timeInputs[1]) timeInputs[1].value = "11:00";
  const fullRes = half.assemble();
  ok("completing both times clears the block and assembles", fullRes.error === null && fullRes.schedule !== undefined);
  ok("the completed window is captured in minutes (09:00 -> 540, 11:00 -> 660)", fullRes.schedule?.blackoutWindows?.[0]?.startMinute === 540 && fullRes.schedule?.blackoutWindows?.[0]?.endMinute === 660);
}

console.log(checks.failures === 0 ? "\nSCHEDULE VALIDATORS PASS" : `\n${checks.failures} FAILURE(S)`);
if (checks.failures > 0) process.exitCode = 1;
if (checks.failures > 0) process.exit(1);
