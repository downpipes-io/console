// Coverage validator for the point-in-time restore calendar's pure logic (src/lib/recovery-calendar.ts):
// grouping a run-history ring by UTC calendar day, the ring's own floor, the four-way honest day
// classification (available / failed-only / empty / beyond-ring), and the month-grid helpers. This
// module touches no DOM and no browser global, so unlike most files here it needs no shim: it is
// imported and driven directly, the same way the engine's resolveRunAt is unit-tested directly over a
// plain RunHistoryEntry[]. Run with `node test/cov/lib-recovery-calendar.ts` (the cov runner also
// invokes it).
//
// The fixture ring below is built deliberately to pin the two hazards the module's own header names:
//   - a run that STARTS one UTC day but COMPLETES the next (grouping must key off completion, not start)
//   - the day immediately BEFORE the ring's floor, and the day immediately AFTER it, each with NO ring
//     entry of their own, must classify oppositely ("beyond-ring" vs "empty") -- the exact boundary-day
//     misclassification the adversarial review flagged.

import type { RunHistoryEntry } from "../../src/api.ts";
import {
  addMonthsUTC,
  classifyDay,
  completionMs,
  type DayBucket,
  dayKey,
  dayStartMs,
  firstWeekdayUTC,
  groupRingByDay,
  isCurrentUTCMonth,
  monthGrid,
  monthLabel,
  ringFloorMs,
} from "../../src/lib/recovery-calendar.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// A minimal RunHistoryEntry: only the fields this module reads (runId/index/startedAt/status/
// durationMs); every other field on the real interface is optional.
function run(runId: string, index: number, startedAt: string, status: RunHistoryEntry["status"], durationMs?: number): RunHistoryEntry {
  return { runId, index, startedAt, status, ...(durationMs !== undefined ? { durationMs } : {}) };
}

function main(): void {
  // ========================================================================
  console.log("\n-- completionMs(): completion instant, its fallback, and the unparseable exclusion --");
  // ========================================================================
  {
    const withDuration = run("run-a", 1, "2026-07-10T23:50:00.000Z", "ok", 20 * 60 * 1000);
    ok("completionMs adds durationMs to startedAt", completionMs(withDuration) === Date.UTC(2026, 6, 11, 0, 10, 0, 0));

    const noDuration = run("run-b", 2, "2026-07-11T00:05:00.000Z", "ok");
    ok("completionMs falls back to startedAt when durationMs is absent", completionMs(noDuration) === Date.UTC(2026, 6, 11, 0, 5, 0, 0));

    const negativeDuration = run("run-neg", 3, "2026-07-11T00:05:00.000Z", "ok", -500);
    ok("a negative durationMs is treated as absent (the conservative fallback)", completionMs(negativeDuration) === Date.UTC(2026, 6, 11, 0, 5, 0, 0));

    const corrupt = run("run-bad", 4, "not-a-real-timestamp", "ok");
    ok("completionMs returns null for an unparseable startedAt", completionMs(corrupt) === null);
  }

  // ========================================================================
  console.log("\n-- dayKey() / dayStartMs(): the UTC day key round-trips --");
    ok('dayKey renders a UTC midnight instant as "YYYY-MM-DD"', dayKey(Date.UTC(2026, 6, 11, 0, 0, 0, 0)) === "2026-07-11");
    ok("dayKey renders a late-day UTC instant on the SAME day (not the next)", dayKey(Date.UTC(2026, 6, 11, 23, 59, 59, 999)) === "2026-07-11");
    ok("dayKey pads single-digit month and day", dayKey(Date.UTC(2026, 0, 5, 12, 0, 0, 0)) === "2026-01-05");
    ok("dayStartMs is the inverse of dayKey (round-trips to UTC midnight)", dayStartMs("2026-07-11") === Date.UTC(2026, 6, 11, 0, 0, 0, 0));

  // ---- the fixture ring -------------------------------------------------------
  // Three calendar days carry ring data: 07-09 (failed-only), 07-11 (a boundary-crossing run plus a
  // second ok run plus a failed run -- still "available"), and 07-15 (a lone later ok run). The ring's
  // floor is therefore the EARLIER of the two 07-11 completions (run-b, 00:05), not run-a's later
  // completion (00:10) despite run-a's EARLIER startedAt -- this is the completion-vs-start distinction
  // the module's header calls out.
  const boundaryCrossing = run("run-a", 10, "2026-07-10T23:50:00.000Z", "ok", 20 * 60 * 1000); // completes 07-11T00:10Z
  const secondSameDay = run("run-b", 11, "2026-07-11T00:05:00.000Z", "ok"); // completes 07-11T00:05Z (no duration)
  const sameDayFailure = run("run-c", 12, "2026-07-11T12:00:00.000Z", "failed", 1000);
  const priorDayFailedOnly = run("run-d", 9, "2026-07-09T05:00:00.000Z", "failed");
  const laterOk = run("run-f", 15, "2026-07-15T08:00:00.000Z", "ok", 5000);
  const unplaceable = run("run-bad", 16, "not-a-date", "ok");
  const ring: RunHistoryEntry[] = [boundaryCrossing, secondSameDay, sameDayFailure, priorDayFailedOnly, laterOk, unplaceable];

  // ========================================================================
  console.log("\n-- groupRingByDay(): buckets by COMPLETION day, sorted ascending, drops the unplaceable row --");
  // ========================================================================
  {
    const byDay = groupRingByDay(ring);
    ok("three distinct calendar days are populated", byDay.size === 3);
    ok("the unparseable row contributes no bucket", !([...byDay.values()].some((b) => b.entries.some((e) => e.entry.runId === "run-bad"))));

    const day0711 = byDay.get("2026-07-11") as DayBucket;
    ok("2026-07-11 holds all three same-day rows (two ok, one failed)", day0711 !== undefined && day0711.entries.length === 3);
    ok(
      "run-a (starts 07-10, completes 07-11) is grouped under its COMPLETION day, not its start day",
      day0711.entries.some((e) => e.entry.runId === "run-a"),
    );
    ok(
      "entries are sorted ascending by completion instant: run-b (00:05) precedes run-a (00:10) despite starting LATER",
      day0711.entries[0]?.entry.runId === "run-b" && day0711.entries[1]?.entry.runId === "run-a" && day0711.entries[2]?.entry.runId === "run-c",
    );

    const day0709 = byDay.get("2026-07-09");
    ok("2026-07-09 holds only the failed row", day0709 !== undefined && day0709.entries.length === 1 && day0709.entries[0]?.entry.status === "failed");

    const day0715 = byDay.get("2026-07-15");
    ok("2026-07-15 holds the later lone ok row", day0715 !== undefined && day0715.entries.length === 1 && day0715.entries[0]?.entry.runId === "run-f");
  }

  // ========================================================================
  console.log("\n-- ringFloorMs(): the minimum OK completion instant, never a failed/abandoned one --");
  // ========================================================================
  {
    const floor = ringFloorMs(ring);
    ok(
      "the floor is run-b's completion (00:05), the EARLIEST ok completion, not run-a's (00:10) or any failed row",
      floor === Date.UTC(2026, 6, 11, 0, 5, 0, 0),
    );

    const noOkRing: RunHistoryEntry[] = [priorDayFailedOnly, sameDayFailure];
    ok("a ring with no successful run at all has a null floor", ringFloorMs(noOkRing) === null);

    const singleOk: RunHistoryEntry[] = [laterOk];
    ok("a single-entry ring floors at that entry's own completion", ringFloorMs(singleOk) === completionMs(laterOk));
  }

  // ========================================================================
  console.log("\n-- classifyDay(): the four honest states, including the boundary days --");
  // ========================================================================
  {
    const byDay = groupRingByDay(ring);
    const floor = ringFloorMs(ring) as number;

    ok('a day with an ok run is "available"', classifyDay("2026-07-11", byDay.get("2026-07-11"), floor) === "available");
    ok('a day with ring data but no ok run is "failed-only", never "available"', classifyDay("2026-07-09", byDay.get("2026-07-09"), floor) === "failed-only");
    ok(
      '"failed-only" holds even though 07-09 is calendar-earlier than the floor day (ring data always wins over the floor)',
      classifyDay("2026-07-09", byDay.get("2026-07-09"), floor) !== "beyond-ring",
    );

    // The load-bearing boundary pair: 07-10 (no ring entry, entirely before the floor day) must read
    // "beyond-ring"; 07-12 (no ring entry, the day immediately AFTER the floor day) must read "empty".
    // These are adjacent days on either side of the floor with IDENTICAL "no ring entry" shape, so this
    // is exactly the misclassification the adversarial review demanded be pinned down.
    ok('the day immediately BEFORE the floor day, with no ring entry, is "beyond-ring"', classifyDay("2026-07-10", undefined, floor) === "beyond-ring");
    ok('the day immediately AFTER the floor day, with no ring entry, is "empty"', classifyDay("2026-07-12", undefined, floor) === "empty");
    ok('a day well before the floor, with no ring entry, is "beyond-ring"', classifyDay("2026-07-01", undefined, floor) === "beyond-ring");
    ok('a day well after the floor, with no ring entry, is "empty"', classifyDay("2026-07-20", undefined, floor) === "empty");

    ok('with a null floor (no ok run anywhere), a run-free day is "beyond-ring", never "empty"', classifyDay("2026-07-01", undefined, null) === "beyond-ring");
    ok('with a null floor, a day that DOES carry (failed-only) ring data is still "failed-only"', classifyDay("2026-07-09", byDay.get("2026-07-09"), null) === "failed-only");
  }

  // ========================================================================
  console.log("\n-- monthGrid(): every day of July 2026, correctly classified, no date maths left to the caller --");
  // ========================================================================
  {
    const julyAnchor = Date.UTC(2026, 6, 15, 9, 30, 0, 0); // any instant inside July; only year/month matter
    const grid = monthGrid(ring, julyAnchor);
    ok("July 2026 has 31 days, one CalendarDay per day", grid.length === 31);
    ok("day 1 is 2026-07-01", grid[0]?.day === "2026-07-01");
    ok("the last day is 2026-07-31", grid[30]?.day === "2026-07-31");

    const byDay = new Map(grid.map((d) => [d.day, d]));
    ok('grid classifies 07-09 as "failed-only"', byDay.get("2026-07-09")?.cls === "failed-only");
    ok('grid classifies 07-10 as "beyond-ring"', byDay.get("2026-07-10")?.cls === "beyond-ring");
    ok('grid classifies 07-11 as "available" and carries its bucket', byDay.get("2026-07-11")?.cls === "available" && byDay.get("2026-07-11")?.bucket?.entries.length === 3);
    ok('grid classifies 07-12 as "empty"', byDay.get("2026-07-12")?.cls === "empty");
    ok('grid classifies 07-15 as "available"', byDay.get("2026-07-15")?.cls === "available");
    ok('grid classifies 07-31 (well after the floor, no runs) as "empty"', byDay.get("2026-07-31")?.cls === "empty");

    // A leap-year February (2024) and a non-leap February (2026) both come out the right length, over
    // an EMPTY ring (every day "beyond-ring" when there is no floor at all, exercising that branch too).
    const emptyRing: RunHistoryEntry[] = [];
    ok("February 2024 (leap year) has 29 days", monthGrid(emptyRing, Date.UTC(2024, 1, 10)).length === 29);
    ok("February 2026 (not a leap year) has 28 days", monthGrid(emptyRing, Date.UTC(2026, 1, 10)).length === 28);
    ok('every day of an empty ring is "beyond-ring" (no floor to be within)', monthGrid(emptyRing, Date.UTC(2026, 1, 10)).every((d) => d.cls === "beyond-ring"));

    // floorMsOverride (date-picker.ts wires this to the LIVE resolver's own retainedFrom, read via
    // runsAt, rather than always recomputing the floor locally): supplying an EARLIER override than the
    // ring's own floor pulls 07-10 back from "beyond-ring" into "empty" (the override, not ringFloorMs,
    // now decides), proving the override genuinely wins over the local computation rather than being
    // silently ignored.
    const earlierOverrideMs = Date.UTC(2026, 6, 9, 0, 0, 0, 0); // 07-09, before the ring's own 07-11 floor
    const overriddenGrid = monthGrid(ring, julyAnchor, earlierOverrideMs);
    const overriddenByDay = new Map(overriddenGrid.map((d) => [d.day, d]));
    ok('floorMsOverride widens the floor: 07-10 is "empty" under the earlier override, not "beyond-ring"', overriddenByDay.get("2026-07-10")?.cls === "empty");
    ok('an overridden floor does not disturb a day with its own ring data (07-11 stays "available")', overriddenByDay.get("2026-07-11")?.cls === "available");
  }

  // ========================================================================
  console.log("\n-- firstWeekdayUTC() / addMonthsUTC(): calendar-grid layout helpers --");
  // ========================================================================
  {
    // Self-consistent, environment-independent check: walking firstWeekdayUTC forward by a month's
    // length must land back on a weekday exactly `daysInThatMonth mod 7` further along, for ANY month,
    // without hardcoding a real-world weekday. has 30 days.
    const juneAnchor = Date.UTC(2026, 5, 10);
    const julyAnchorFirst = addMonthsUTC(juneAnchor, 1);
    ok("addMonthsUTC steps to the 1st of the next UTC month", julyAnchorFirst === Date.UTC(2026, 6, 1));
    const juneFirstWeekday = firstWeekdayUTC(juneAnchor);
    const julyFirstWeekday = firstWeekdayUTC(julyAnchorFirst);
    const juneDays = 30;
    ok(
      "firstWeekdayUTC advances consistently with the number of days in the preceding month (mod 7)",
      julyFirstWeekday === (juneFirstWeekday + juneDays) % 7,
    );
    ok("firstWeekdayUTC returns a value in the Sunday(0)..Saturday(6) range", juneFirstWeekday >= 0 && juneFirstWeekday <= 6);

    ok("addMonthsUTC rolls a December anchor over into January of the next year", addMonthsUTC(Date.UTC(2026, 11, 15), 1) === Date.UTC(2027, 0, 1));
    ok("addMonthsUTC(-1) rolls a January anchor back into December of the previous year", addMonthsUTC(Date.UTC(2026, 0, 15), -1) === Date.UTC(2025, 11, 1));
    ok("addMonthsUTC(0) stays in the same UTC month (normalised to the 1st)", addMonthsUTC(Date.UTC(2026, 6, 22), 0) === Date.UTC(2026, 6, 1));
  }

  // ========================================================================
  console.log("\n-- isCurrentUTCMonth(): compares year AND month, against an explicit reference instant --");
    ok("the same UTC year and month is current", isCurrentUTCMonth(Date.UTC(2026, 6, 3), Date.UTC(2026, 6, 28)) === true);
    ok("a different month in the same year is not current", isCurrentUTCMonth(Date.UTC(2026, 5, 3), Date.UTC(2026, 6, 1)) === false);
    ok("the same month number in a different year is not current", isCurrentUTCMonth(Date.UTC(2025, 6, 3), Date.UTC(2026, 6, 1)) === false);
    ok("isCurrentUTCMonth defaults nowMs to the real current instant (does not throw)", typeof isCurrentUTCMonth(Date.UTC(2026, 6, 3)) === "boolean");

  // ========================================================================
  console.log("\n-- monthLabel(): a fixed, locale-independent English month name plus the UTC year --");
    ok('monthLabel renders "July 2026"', monthLabel(Date.UTC(2026, 6, 15)) === "July 2026");
    ok('monthLabel renders "January 2027" (the zero-indexed month table is correct at both ends)', monthLabel(Date.UTC(2027, 0, 1)) === "January 2027");
    ok('monthLabel renders "December 2025"', monthLabel(Date.UTC(2025, 11, 31, 23, 0, 0, 0)) === "December 2025");

  if (failures > 0) process.exitCode = 1;

  if (failures > 0) {
    console.error(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("\nRECOVERY-CALENDAR COVERAGE VECTORS PASS");
}

main();
