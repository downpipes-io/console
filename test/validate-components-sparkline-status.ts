// Sparkline and status area of the validate-components suite: the sparkline
// phrase derivation and the runStatusTone mapping.

import { _testDerivePhrase } from "../src/components/sparkline.ts";
import { runStatusTone } from "../src/components/status.ts";

type Ok = (label: string, cond: boolean) => void;

export function runSparklineStatus(ok: Ok): void {

// ===========================================================================
// 3. SPARKLINE -- PHRASE DERIVATION
// ===========================================================================
// derivePhrase builds the accessible text alternative for a chart. It must report
// the latest finite value, the trend direction and a sensible phrase for every
// edge case. Negative controls confirm the direction word is correct.

console.log("\n-- sparkline derivePhrase --");

// 3a. No data.
ok("empty series: 'no data yet' phrase", _testDerivePhrase([]).includes("no data yet"));
ok("all-NaN series: 'no data yet' phrase", _testDerivePhrase([NaN, NaN]).includes("no data yet"));
// Negative control: must not claim a positive trend on empty data.
ok("empty series: no 'up' claim", !_testDerivePhrase([]).includes("up"));

// 3b. Single data point.
ok("single point: includes the value", _testDerivePhrase([42]).includes("42"));
ok("single point: notes one data point", _testDerivePhrase([42]).includes("one data point"));
// Negative control: must not produce a direction word when there is only one point.
ok("single point: no 'up'/'down'/'steady' direction", !_testDerivePhrase([42]).includes("up") && !_testDerivePhrase([42]).includes("down") && !_testDerivePhrase([42]).includes("steady"));

// 3c. Rising series: last > first.
ok("rising series: direction is 'up'", _testDerivePhrase([10, 20, 30]).includes("up"));
ok("rising series: latest value is the last element", _testDerivePhrase([10, 20, 30]).includes("30"));
// Negative control: 'down' must not appear in a rising series.
ok("rising series: NOT 'down'", !_testDerivePhrase([10, 20, 30]).includes("down"));

// 3d. Falling series: last < first.
ok("falling series: direction is 'down'", _testDerivePhrase([30, 20, 10]).includes("down"));
ok("falling series: latest value is the last element", _testDerivePhrase([30, 20, 10]).includes("10"));
// Negative control: 'up' must not appear in a falling series.
ok("falling series: NOT 'up'", !_testDerivePhrase([30, 20, 10]).includes("up"));

// 3e. Flat series: last == first.
ok("flat series: direction is 'steady'", _testDerivePhrase([5, 5, 5]).includes("steady"));
// Negative control: a flat series is neither 'up' nor 'down'.
ok("flat series: NOT 'up' or 'down'", !_testDerivePhrase([5, 5, 5]).includes("up") && !_testDerivePhrase([5, 5, 5]).includes("down"));

// 3f. Gaps (NaN values): the direction is derived from the FINITE extremes; the
// "last N points" count reflects the finite data points compared, not the gaps.
ok("series with gaps: direction from finite endpoints", _testDerivePhrase([10, NaN, 30]).includes("up"));
ok("series with gaps: latest value is the last finite value", _testDerivePhrase([10, NaN, 30]).includes("30"));
// The point count in the phrase counts only the finite data points (two here), so the
// assistive-technology text never overstates how many real points were compared.
ok("series with gaps: point count reflects finite points compared", _testDerivePhrase([10, NaN, 30]).includes("2 points"));

// 3g. Unit label is prepended when supplied.
ok("with unitLabel: label appears in phrase", _testDerivePhrase([100], "records").includes("records"));
ok("with unitLabel + empty data: label in no-data phrase", _testDerivePhrase([], "records").includes("records"));
// Negative control: without unitLabel the prefix must be absent.
ok("without unitLabel: no stray colon prefix", !_testDerivePhrase([100]).startsWith(":"));

// 3h. Large numbers are grouped with commas.
ok("large value: thousands grouped in phrase", _testDerivePhrase([1234567]).includes("1,234,567"));
// Negative control: un-grouped form must not appear.
ok("large value: NOT the un-grouped string '1234567'", !_testDerivePhrase([1234567]).includes("1234567"));

// ===========================================================================
// 4. STATUS -- runStatusTone
// ===========================================================================
// runStatusTone maps a run execution status to a tone + label. The three states
// each have a distinct, meaningful tone; none may share a tone since they convey
// different health signals.

console.log("\n-- status runStatusTone --");

const statusOk = runStatusTone("ok");
const statusFailed = runStatusTone("failed");
const statusFlight = runStatusTone("in-flight");

ok("ok: tone is 'ok'", statusOk.tone === "ok");
ok("ok: label is 'ok'", statusOk.label === "ok");

ok("failed: tone is 'danger'", statusFailed.tone === "danger");
ok("failed: label is 'failed'", statusFailed.label === "failed");
// Negative control: a failed run must NOT carry the ok tone.
ok("failed: NOT the 'ok' tone", statusFailed.tone !== "ok");

ok("in-flight: tone is 'info'", statusFlight.tone === "info");
ok("in-flight: label is 'in-flight'", statusFlight.label === "in-flight");
// Negative control: in-flight is a live state, so it must not be 'ok' or 'danger'.
ok("in-flight: NOT 'ok' tone", statusFlight.tone !== "ok");
ok("in-flight: NOT 'danger' tone", statusFlight.tone !== "danger");

// All three tones are distinct (no two statuses share a tone).
const tones = [statusOk.tone, statusFailed.tone, statusFlight.tone];
ok("all three run-status tones are distinct", new Set(tones).size === 3);

}
