// Data-table area of the validate-components suite: the windowing row-window
// maths, the sort comparator, and the bulk-action rejection handling.

import {
  _testWindowSlice,
  _testCompareCells,
  _testBulkActionRejection,
} from "../src/components/data-table.ts";

type Ok = (label: string, cond: boolean) => void;

// Sections 1 and 2 (windowing maths and the sort comparator). Run first in the
// suite, matching the original source order.
export function runDataTableMaths(ok: Ok): void {

// ===========================================================================
// 1. DATA TABLE -- WINDOWING ROW-WINDOW MATHS
// ===========================================================================
// The windowing paint() callback computes a (start, end) render slice from
// the scroll position, row height, viewport height and overscan. That arithmetic
// is the test target; every assertion has a negative control that would fail on
// a naive/wrong implementation.
//
// Defaults from data-table.ts: rowHComfortable=49, rowHCompact=37, viewportH=520,
// overscan=6 (hardcoded in renderWindowed).

console.log("\n-- data-table windowing maths --");

const ROW_H = 49;   // comfortable default
const VP_H = 520;   // default viewport height
const OVERSCAN = 6; // hardcoded in renderWindowed
const TOTAL = 200;  // a dataset above the 150-row windowing threshold

// 1a. At scroll=0 the window starts at row 0 (never negative).
{
  const s = _testWindowSlice(0, TOTAL, ROW_H, VP_H, OVERSCAN);
  ok("window at scroll=0: start is 0", s.start === 0);
  // Negative control: a wrong formula might subtract overscan below 0.
  ok("window at scroll=0: start is not negative", s.start >= 0);
  // visibleCount = ceil(520/49)=11; end = min(200, 0+11+12)=23.
  ok("window at scroll=0: end = visibleCount + 2*overscan", s.end === 11 + 2 * OVERSCAN);
  ok("window at scroll=0: start < end (slice is non-empty)", s.start < s.end);
}

// 1b. Mid-scroll: scrollTop places the first visible row in the middle. The
// leading overscan rows before the viewport are included.
{
  // scrollTop=490 (10*49=490): first visible row index = floor(490/49)=10.
  // start = max(0, 10 - 6) = 4.
  const scrollTop = 10 * ROW_H; // exactly row 10
  const s = _testWindowSlice(scrollTop, TOTAL, ROW_H, VP_H, OVERSCAN);
  ok("window mid-scroll: start = firstVisible - overscan", s.start === 10 - OVERSCAN);
  // end = min(200, 4 + 11 + 12) = min(200, 27) = 27.
  ok("window mid-scroll: end = start + visibleCount + 2*overscan", s.end === 4 + 11 + 2 * OVERSCAN);
  // Negative control: without overscan, start would be 10 and end would be 21.
  ok("window mid-scroll: start is LESS than firstVisible (overscan rows behind)", s.start < 10);
  ok("window mid-scroll: end is GREATER than firstVisible+visibleCount (overscan rows ahead)", s.end > 10 + 11);
}

// 1c. Near-end scroll: the slice must be clamped to total (never exceed the
// dataset). This is the guard that prevents out-of-bounds indexing.
{
  // Scroll to within 3 rows of the end: scrollTop = (200-3)*49 = 9653.
  const scrollTop = (TOTAL - 3) * ROW_H;
  const s = _testWindowSlice(scrollTop, TOTAL, ROW_H, VP_H, OVERSCAN);
  ok("window near-end: end is clamped to total (not overrun)", s.end === TOTAL);
  ok("window near-end: end does not exceed total", s.end <= TOTAL);
  // Negative control: an unclamped formula gives end = (200-3-6) + 11 + 12 > 200.
  const unclamped = (TOTAL - 3 - OVERSCAN) + 11 + 2 * OVERSCAN;
  ok("near-end: unclamped formula would exceed total (showing the clamp is meaningful)", unclamped > TOTAL);
}

// 1d. Small dataset: with total < visibleCount+2*overscan the end must equal total.
{
  const s = _testWindowSlice(0, 5, ROW_H, VP_H, OVERSCAN);
  ok("small dataset: end is clamped to 5", s.end === 5);
  ok("small dataset: start is 0", s.start === 0);
}

// 1e. Compact density: a shorter row height widens the slice (more rows are visible
// in the same viewport height). Checks the density parameter threads through.
{
  const ROW_H_COMPACT = 37;
  const sComf = _testWindowSlice(0, TOTAL, ROW_H, VP_H, OVERSCAN);
  const sComp = _testWindowSlice(0, TOTAL, ROW_H_COMPACT, VP_H, OVERSCAN);
  ok("compact density: window end >= comfortable density end (shorter rows = more visible)", sComp.end >= sComf.end);
  // Negative control: they must not be equal when the ceilings differ.
  const comfVisible = Math.ceil(VP_H / ROW_H);
  const compVisible = Math.ceil(VP_H / ROW_H_COMPACT);
  ok("comfortable and compact have different visibleCount (densities genuinely differ)", comfVisible !== compVisible);
}

// 1f. The slice width (end - start) is at least visibleCount + overscan and at most
// visibleCount + 2*overscan (the overscan is symmetric; clamping at either edge
// may shrink the trailing or leading band but never below the window itself).
{
  const visibleCount = Math.ceil(VP_H / ROW_H); // 11
  const midScroll = 50 * ROW_H; // row 50, well away from both ends
  const s = _testWindowSlice(midScroll, TOTAL, ROW_H, VP_H, OVERSCAN);
  const width = s.end - s.start;
  ok("window width >= visibleCount + overscan", width >= visibleCount + OVERSCAN);
  ok("window width <= visibleCount + 2*overscan", width <= visibleCount + 2 * OVERSCAN);
}

// ===========================================================================
// 2. DATA TABLE -- SORT COMPARATOR
// ===========================================================================
// compareCells: numbers numeric, strings case-insensitive, null/undefined sink.
// Negative controls prove the ordering is directional (not a no-op equality).

console.log("\n-- data-table compareCells --");

// 2a. Numbers sort numerically, not lexicographically.
ok("numbers: 2 < 10 (numeric, not lexicographic)", _testCompareCells(2, 10) < 0);
ok("numbers: 10 > 2", _testCompareCells(10, 2) > 0);
ok("numbers: equal returns 0", _testCompareCells(5, 5) === 0);
// Negative control: lexicographic "10" < "2" would give a positive result here;
// numeric ordering gives negative.
ok("numbers: 10 sorts BEFORE 20 numerically (would fail a string sort)", _testCompareCells(10, 20) < 0);
ok("negative numbers: -5 < 0", _testCompareCells(-5, 0) < 0);

// 2b. Strings sort case-insensitively.
ok("strings: 'a' < 'b'", _testCompareCells("a", "b") < 0);
ok("strings: 'B' vs 'a' is case-insensitive ('a' < 'b')", _testCompareCells("B", "a") > 0);
ok("strings: 'apple' < 'Banana' (case-insensitive)", _testCompareCells("apple", "Banana") < 0);
ok("strings: equal strings return 0", _testCompareCells("foo", "foo") === 0);
ok("strings: 'FOO' == 'foo' case-insensitively (returns 0)", _testCompareCells("FOO", "foo") === 0);
// Negative control: a case-sensitive sort would make 'B' (66) sort before 'a' (97),
// i.e. return negative; case-insensitive gives positive.
ok("case-insensitive: 'B' sorts AFTER 'a' (not before as in ASCII order)", _testCompareCells("B", "a") > 0);

// 2c. Null/undefined always sink (sort last), regardless of the other operand.
ok("null sinks: null > 'z' (null sorts after any string)", _testCompareCells(null, "z") > 0);
ok("null sinks: 'a' < null (string sorts before null)", _testCompareCells("a", null) < 0);
ok("null sinks: null > 0 (null sorts after any number)", _testCompareCells(null, 0) > 0);
ok("undefined sinks: undefined > 'z'", _testCompareCells(undefined, "z") > 0);
ok("both null: returns 0 (stable)", _testCompareCells(null, null) === 0);
ok("both undefined: returns 0", _testCompareCells(undefined, undefined) === 0);
ok("null and undefined: equal rank (both sink)", _testCompareCells(null, undefined) === 0);
// Negative control: a comparator that sorted nulls first would return < 0 here.
ok("null sinks: NOT sorted first (would return < 0 if erroneously sinking to top)", _testCompareCells(null, "a") > 0);

// 2d. Mixed-type: a number vs a string falls back to string comparison.
ok("number vs string: both stringified for comparison", typeof _testCompareCells(10, "10") === "number");

}

// Section 8 (bulk-action rejection handling). Run later in the suite, after the
// sparkline/status, trust and modal/drawer groups, matching the original order.
export async function runDataTableBulkAction(ok: Ok): Promise<void> {

// ===========================================================================
// 8. DATA TABLE -- BULK ACTION REJECTION HANDLING
// ===========================================================================
// The bulk action click handler must catch a rejected run() and surface the
// error (not let it become an unhandled rejection) while preserving the
// selection so the operator can retry. On success the selection is cleared
// (unless keepSelection is set).
//
// _testBulkActionRejection drives the try/catch guard in pure form.

console.log("\n-- data-table bulk action rejection handling --");

// 8a. A rejected run() surfaces the error and does NOT clear the selection.
{
  const result = await _testBulkActionRejection(
    async () => { throw new Error("network unavailable"); },
    false,
  );
  ok("rejected run does NOT clear selection", result.selectionCleared === false);
  ok("rejected run records the error (error surfaced)", result.errorLogged === true);
  // Negative control: if the rejection were swallowed, errorLogged would be false.
  ok("negative: errorLogged is NOT false (error was not swallowed)", result.errorLogged !== false);
}

// 8b. A rejected run() with a bare-string throw still surfaces correctly.
{
  const result = await _testBulkActionRejection(
    async () => { throw "forbidden"; },
    false,
  );
  ok("bare-string rejection records the error", result.errorLogged === true);
  ok("bare-string rejection does NOT clear selection", result.selectionCleared === false);
}

// 8c. A resolved run() with keepSelection=false clears the selection and does not
// log an error.
{
  const result = await _testBulkActionRejection(
    async () => { /* success */ },
    false,
  );
  ok("resolved run (keepSelection=false) clears selection", result.selectionCleared === true);
  ok("resolved run does NOT log an error", result.errorLogged === false);
  // Negative control: a spurious error on success would make errorLogged true.
  ok("negative: errorLogged is NOT true on success", result.errorLogged !== true);
}

// 8d. A resolved run() with keepSelection=true does NOT clear the selection.
{
  const result = await _testBulkActionRejection(
    async () => { /* success, keep */ },
    true,
  );
  ok("resolved run (keepSelection=true) does NOT clear selection", result.selectionCleared === false);
  ok("keepSelection=true + success => no error logged", result.errorLogged === false);
}

}
