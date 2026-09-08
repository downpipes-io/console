// Validates the pure presentation and parsing helpers in src/screens/costs/helpers.ts: the
// currency / number formatting (money, formatRate, formatNumberInput), the byte-unit picker
// (bytesToUnit, unitToBytes), the percentage error helper (pctError), the input parser
// (parseNonNeg), the cadence matcher (matchCadence) and the single-occurrence list helper
// (withoutOneOccurrence). These are deterministic, operator-facing, and otherwise unverified;
// an edge-case regression here ships as a wrong display value. Run:
//   node test/validate-cost-helpers.ts
// Prints one line per check; exits non-zero on any failure.
//
// Some helpers build DOM (byteUnitOptions), but every helper exercised here is pure and does
// not touch document, so no DOM shim is needed.

import {
  money,
  formatRate,
  formatNumberInput,
  bytesToUnit,
  unitToBytes,
  pctError,
  parseNonNeg,
  matchCadence,
  withoutOneOccurrence,
} from "../src/screens/costs/helpers.ts";
import { cadenceToRunsPerMonth, type Cadence } from "../src/lib/cost-model.ts";

let failures = 0;

function eq(label: string, got: unknown, want: unknown): void {
  const cond = got === want;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
console.log("-- money --");

eq("undefined -> dash", money(undefined), "-");
eq("Infinity -> dash", money(Infinity), "-");
eq("NaN -> dash", money(NaN), "-");
eq("negative clamps to zero", money(-0.5), "$0.00");
eq("zero -> $0.00", money(0), "$0.00");
eq("sub-cent uses 4 decimals", money(0.005), "$0.0050");
eq("under 1000 uses cents", money(999.99), "$999.99");
eq("1000 groups, no cents", money(1000), "$1,000");
eq("1e6 groups, no cents", money(1e6), "$1,000,000");

// ---------------------------------------------------------------------------
console.log("\n-- formatRate / formatNumberInput --");

eq("formatRate non-finite -> 0", formatRate(NaN), "0");
eq("formatRate 0 -> 0", formatRate(0), "0");
eq("formatRate trims trailing zeros", formatRate(0.015), "0.015");
eq("formatRate rounds to 4 dp", formatRate(0.012345), "0.0123");
eq("formatNumberInput integer has no point", formatNumberInput(5), "5");
eq("formatNumberInput non-finite -> 0", formatNumberInput(Infinity), "0");
eq("formatNumberInput trims fraction", formatNumberInput(1.5), "1.5");

// ---------------------------------------------------------------------------
console.log("\n-- bytesToUnit / unitToBytes --");

eq("zero bytes -> 0 GB", JSON.stringify(bytesToUnit(0)), JSON.stringify({ value: 0, unit: "GB" }));
eq("small bytes -> MB", JSON.stringify(bytesToUnit(5e6)), JSON.stringify({ value: 5, unit: "MB" }));
eq("mid bytes -> GB", JSON.stringify(bytesToUnit(2e9)), JSON.stringify({ value: 2, unit: "GB" }));
eq("large bytes -> TB", JSON.stringify(bytesToUnit(3e12)), JSON.stringify({ value: 3, unit: "TB" }));
eq("negative clamps to 0 GB", JSON.stringify(bytesToUnit(-1)), JSON.stringify({ value: 0, unit: "GB" }));
eq("unitToBytes MB", unitToBytes(5, "MB"), 5e6);
eq("unitToBytes GB", unitToBytes(2, "GB"), 2e9);
eq("unitToBytes TB", unitToBytes(3, "TB"), 3e12);
eq("unitToBytes negative clamps", unitToBytes(-4, "GB"), 0);

// ---------------------------------------------------------------------------
console.log("\n-- pctError --");

eq("empty is not an error", pctError("", "Dedup", 0), null);
eq("non-number -> message", pctError("abc", "Dedup", 0), "Dedup must be a number.");
eq("below min 0 -> negative message", pctError("-1", "Dedup", 0), "Dedup cannot be negative.");
eq("below min 10 -> at-least message", pctError("5", "Dedup", 10), "Dedup must be at least 10.");
eq("over 100 -> exceed message", pctError("101", "Dedup", 0), "Dedup cannot exceed 100.");
eq("in range -> null", pctError("60", "Dedup", 0), null);

// ---------------------------------------------------------------------------
console.log("\n-- parseNonNeg --");

eq("empty -> null", parseNonNeg(""), null);
eq("whitespace -> null", parseNonNeg("   "), null);
eq("negative -> null", parseNonNeg("-1"), null);
eq("non-number -> null", parseNonNeg("abc"), null);
eq("zero -> 0", parseNonNeg("0"), 0);
eq("decimal -> number", parseNonNeg("1.5"), 1.5);
eq("Infinity literal -> null", parseNonNeg("Infinity"), null);

// ---------------------------------------------------------------------------
console.log("\n-- matchCadence --");

const named: Cadence[] = ["every15min", "hourly", "every6h", "daily", "weekly"];
for (const c of named) {
  eq(`exact runs-per-month matches ${c}`, matchCadence(cadenceToRunsPerMonth(c)), c);
}
ok("a custom interval matches no named cadence", matchCadence(cadenceToRunsPerMonth("daily") * 1.5) === null);
ok("zero runs matches no named cadence", matchCadence(0) === null);

// ---------------------------------------------------------------------------
console.log("\n-- withoutOneOccurrence --");

eq("missing element -> unchanged", JSON.stringify(withoutOneOccurrence([1, 2, 3], 9)), JSON.stringify([1, 2, 3]));
eq("removes only the first duplicate", JSON.stringify(withoutOneOccurrence([5, 5, 5], 5)), JSON.stringify([5, 5]));
eq("removes the single match", JSON.stringify(withoutOneOccurrence([1, 2, 3], 2)), JSON.stringify([1, 3]));
eq("empty list -> empty", JSON.stringify(withoutOneOccurrence([], 1)), JSON.stringify([]));

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nCOST HELPERS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
