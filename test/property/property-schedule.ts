// fast-check property tests: a SMALL, BOUNDED set of generative properties over the schedule
// blackout-window time helpers in src/lib/schedule.ts. ADDITIVE to the deterministic Node
// validators (test/validate-schedule.ts), which assert fixed reference vectors; these assert
// invariants over MANY random inputs that a fixed vector cannot.
//
// Run:  node test/property/property-schedule.ts   (or: npm run test:property)
//
// Kept deliberately fast: low run counts and a bounded input domain (the wire's own 0..1440
// minutes-since-midnight range), so this stays well inside a CI step and never becomes a slow
// gate. It exercises:
//   - minutesToTime SHAPE: for every in-range integer, the result is always "HH:MM", zero-padded
//   - roundtrip: parseTimeToMinutes(minutesToTime(n)) === n for every in-range integer n
//   - roundtrip the other way: parseTimeToMinutes(s) followed by minutesToTime gives back the
//     same canonical "HH:MM" string, for every well-formed HH:MM string in range
//
// It does not exercise minutesToTime's out-of-range clamp path (that path calls
// recordWireAnomaly, a side effect this file is not testing); every generator here stays inside
// 0..1440, the same range parseTimeToMinutes itself accepts.
import fc from "fast-check";

import { minutesToTime, parseTimeToMinutes } from "../../src/lib/schedule.ts";

let failures = 0;
function prop(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${label}: ${(e as Error).message}`);
  }
}

const RUNS = { numRuns: 200 };
const minuteOfDay = fc.integer({ min: 0, max: 1440 });

console.log("schedule blackout-window time-helper property vectors (fast-check)");

prop("minutesToTime always returns zero-padded HH:MM for an in-range integer", () => {
  fc.assert(
    fc.property(minuteOfDay, (n) => /^\d{2}:\d{2}$/.test(minutesToTime(n))),
    RUNS,
  );
});

prop("roundtrip: parseTimeToMinutes(minutesToTime(n)) === n for every in-range integer n", () => {
  fc.assert(
    fc.property(minuteOfDay, (n) => parseTimeToMinutes(minutesToTime(n)) === n),
    RUNS,
  );
});

prop("roundtrip the other way: a well-formed HH:MM string survives parse -> render unchanged", () => {
  // Build the canonical string a valid (h, m) pair renders as, so the input is already in the
  // exact shape minutesToTime would produce, then check parse -> render is the identity on it.
  const hm = fc.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 })).map(
    ([h, m]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
  );
  fc.assert(
    fc.property(hm, (s) => {
      const mins = parseTimeToMinutes(s);
      return mins !== null && minutesToTime(mins) === s;
    }),
    RUNS,
  );
});

prop("parseTimeToMinutes rejects the end-of-day sentinel only at 24:00, and accepts it there", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 59 }), (m) => {
      const isMidnightSentinel = m === 0;
      const result = parseTimeToMinutes(`24:${String(m).padStart(2, "0")}`);
      return isMidnightSentinel ? result === 1440 : result === null;
    }),
    RUNS,
  );
});

if (failures === 0) {
  console.log("\nall schedule time-helper property vectors passed");
  process.exit(0);
} else {
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
