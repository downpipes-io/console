// Validates the console's bulk-loop resilience layer: src/lib/bulk-pacing.ts (429 recognition,
// Retry-After -> capped backoff, honest 429 labelling, sleep), src/screens/overview/fleet-drill.ts (each
// failure carries a reason), and src/components/slow-note.ts (a reassurance line after a threshold that
// cancels cleanly on a fast call).
//
// Run with: node test/validate-bulk-pacing.ts.

import { installDomShim } from "./dom-shim.ts";
installDomShim();

import {
  isRateLimited,
  rateLimitDelayMs,
  bulkFailureReason,
  sleep,
  DEFAULT_RATE_LIMIT_BACKOFF_MS,
  MAX_RATE_LIMIT_BACKOFF_MS,
  MAX_RATE_LIMIT_RETRIES,
} from "../src/lib/bulk-pacing.ts";
import { drillSummary, drillFailuresForSummary, type DrillOutcomes } from "../src/screens/overview/fleet-drill.ts";
import { scheduleSlowNote, runningNote, SLOW_NOTE_THRESHOLD_MS } from "../src/components/slow-note.ts";
import { h } from "../src/lib/dom.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// Message shapes follow exactly what the transport throws (see validate-errors.ts):
//   429 with Retry-After: "<verb>: retry-after=<n>: 429"
//   429 without:          "<verb>: 429"
const err429ra = (n: number): Error => new Error(`backup run: retry-after=${n}: 429`);
const err429plain = new Error("backup run: 429");
const err500 = new Error("backup run: 500");

// ---- isRateLimited: the hot-path predicate the loops branch on (CON-2) ---------
ok("isRateLimited true for a 429 with Retry-After", isRateLimited(err429ra(30)) === true);
ok("isRateLimited true for a 429 without Retry-After", isRateLimited(err429plain) === true);
ok("isRateLimited false for a 500 (negative control)", isRateLimited(err500) === false);
ok("isRateLimited false for a network TypeError", isRateLimited(new TypeError("Failed to fetch")) === false);

// ---- the two backoff figures, pinned before they are used as expectations ------
// The Retry-After path below is checked against the literal 30_000, but the default and the cap
// are only ever compared to themselves: rateLimitDelayMs returns the constant and the assertion
// expects the constant, so both move together and neither check can fail. At a 60-second default
// every un-hinted 429 stalls the bulk loop for a minute, and at a 10-minute cap the clamp that
// exists to stop the UI wedging stops doing it, both with the suite green. Pinned here.
ok("DEFAULT_RATE_LIMIT_BACKOFF_MS is 2 seconds", DEFAULT_RATE_LIMIT_BACKOFF_MS === 2_000);
ok("MAX_RATE_LIMIT_BACKOFF_MS is 60 seconds", MAX_RATE_LIMIT_BACKOFF_MS === 60_000);
ok("the default backoff is below the cap", DEFAULT_RATE_LIMIT_BACKOFF_MS < MAX_RATE_LIMIT_BACKOFF_MS);

// ---- rateLimitDelayMs: Retry-After -> capped backoff in ms ---------------------
ok("rateLimitDelayMs honours a numeric Retry-After (30s -> 30000ms)", rateLimitDelayMs(err429ra(30)) === 30_000);
ok("rateLimitDelayMs uses the default backoff when no Retry-After", rateLimitDelayMs(err429plain) === DEFAULT_RATE_LIMIT_BACKOFF_MS);
// A hostile/huge Retry-After is clamped to the cap so the UI can never wedge for minutes.
ok("rateLimitDelayMs clamps a huge Retry-After to the cap", rateLimitDelayMs(err429ra(9999)) === MAX_RATE_LIMIT_BACKOFF_MS);
// A Retry-After at exactly the cap boundary stays at the cap (not over).
ok("rateLimitDelayMs at the cap boundary equals the cap", rateLimitDelayMs(err429ra(MAX_RATE_LIMIT_BACKOFF_MS / 1000)) === MAX_RATE_LIMIT_BACKOFF_MS);
// Defensive: a non-429 thrown into the delay helper yields the default, never NaN/0.
ok("rateLimitDelayMs on a non-429 yields the default (defensive)", rateLimitDelayMs(err500) === DEFAULT_RATE_LIMIT_BACKOFF_MS);
// The retry budget is bounded so a persistently-throttled item cannot loop forever.
ok("MAX_RATE_LIMIT_RETRIES is a small finite budget", Number.isInteger(MAX_RATE_LIMIT_RETRIES) && MAX_RATE_LIMIT_RETRIES > 0 && MAX_RATE_LIMIT_RETRIES <= 10);

// ---- bulkFailureReason: a 429 is labelled DISTINCTLY (CON-2), not "did not pass" ---
const reason429ra = bulkFailureReason(err429ra(59));
ok("bulkFailureReason names a 429 as rate limited", /rate limited/i.test(reason429ra));
ok("bulkFailureReason includes the Retry-After when known", reason429ra.includes("59"));
ok("bulkFailureReason notes retries were exhausted", /exhausted/i.test(reason429ra));
const reason429plain = bulkFailureReason(err429plain);
ok("bulkFailureReason labels a 429 with no Retry-After as rate limited", /rate limited/i.test(reason429plain));
// A non-429 keeps its raw engine message (it is NOT mislabelled as rate limited).
const reason500 = bulkFailureReason(err500);
ok("bulkFailureReason keeps a non-429's raw message", reason500.includes("500"));
ok("bulkFailureReason does NOT call a 500 rate limited (negative control)", !/rate limited/i.test(reason500));

// ---- sleep: the one impure helper, resolves after the given ms -----------------
{
  const t0 = Date.now();
  await sleep(15);
  ok("sleep resolves after roughly the requested delay", Date.now() - t0 >= 10);
}

// ---- fleet-drill: every failure carries a reason -----------------------
// A 30-failure drill must explain all 30, not name 3 and drop a reason-less tail.
const manyFailures: DrillOutcomes = {
  passed: 5,
  failures: Array.from({ length: 30 }, (_, i) => ({ id: `dp-${i}`, reason: i === 0 ? "rate limited by the engine (retry after 59s)" : "did not pass" })),
  deferred: [],
  rateLimitExhausted: 0,
};
const summaryMany = drillSummary(35, manyFailures);
ok("drillSummary reports the real passed count", summaryMany.includes("5 passed"));
ok("drillSummary reports the real failed count (30)", summaryMany.includes("30 did not pass"));
ok("drillSummary rolls the long tail into 'and N more'", summaryMany.includes("and 27 more"));
ok("drillSummary points at the full per-failure detail", /details below|every reason/i.test(summaryMany));
// The MODAL shape (drillFailuresForSummary) is the source of truth: ALL 30 are present WITH reasons.
const modalRows = drillFailuresForSummary(manyFailures);
ok("drillFailuresForSummary carries EVERY failure (all 30, not 3)", modalRows.length === 30);
ok("drillFailuresForSummary maps the downpipe id to the item name", modalRows[0]!.name === "dp-0");
ok("drillFailuresForSummary carries the captured reason verbatim", modalRows[0]!.reason.includes("rate limited"));
ok("every modal row has a non-empty reason (no reason-less failure)", modalRows.every((r) => r.reason.length > 0));

// Single-failure: the summary inlines the one reason; the all-pass summary stays clean.
const oneFail: DrillOutcomes = { passed: 2, failures: [{ id: "dp-x", reason: "object missing" }], deferred: [], rateLimitExhausted: 0 };
ok("drillSummary inlines the single failure's reason", drillSummary(3, oneFail).includes("object missing"));
const allPass: DrillOutcomes = { passed: 4, failures: [], deferred: [], rateLimitExhausted: 0 };
ok("drillSummary all-pass reads complete with no failure tail", drillSummary(4, allPass).includes("4 of 4 passed"));
ok("drillSummary all-pass does NOT say 'did not pass' (negative control)", !drillSummary(4, allPass).includes("did not pass"));

// ---- fleet-drill: deferred (break-glass-only posture) is NEVER a failure -----
// A break-glass-only downpipe is a correct, deliberate posture: the engine's own honest refusal, not a
// drill failure. It must read as its own named clause, never merged into "passed" (which would claim
// something was verified when it was not) or into "failures" (which would misreport the posture as broken).
const someDeferred: DrillOutcomes = {
  passed: 3,
  failures: [],
  deferred: [
    { id: "dp-bg1", reason: "break-glass-only posture: no in-account read-back key" },
    { id: "dp-bg2", reason: "break-glass-only posture: no in-account read-back key" },
  ],
  rateLimitExhausted: 0,
};
const summaryDeferred = drillSummary(5, someDeferred);
ok("drillSummary names the real passed count alongside deferred", summaryDeferred.includes("3 passed"));
ok("drillSummary reports the deferred count with the posture reason", summaryDeferred.includes("2 deferred") && /break-glass-only posture/i.test(summaryDeferred));
ok("drillSummary points deferred at attended verification", /attended verification/i.test(summaryDeferred));
ok("drillSummary does NOT say 'did not pass' for a deferred-only session (negative control)", !summaryDeferred.includes("did not pass"));
ok(
  "drillSummary never reads as 'N of N passed' when some were only deferred, not verified (negative control, the REFUTER bar)",
  !summaryDeferred.includes("of 5 passed") && !summaryDeferred.includes("of 3 passed"),
);

// A fully break-glass-only fleet (0 passed, all deferred): the exact case the refuter flagged -- it must
// never read as "all clear" or "all verified" when nothing was actually verified.
const allDeferred: DrillOutcomes = {
  passed: 0,
  failures: [],
  deferred: [
    { id: "dp-1", reason: "break-glass-only posture: no in-account read-back key" },
    { id: "dp-2", reason: "break-glass-only posture: no in-account read-back key" },
    { id: "dp-3", reason: "break-glass-only posture: no in-account read-back key" },
  ],
  rateLimitExhausted: 0,
};
const summaryAllDeferred = drillSummary(3, allDeferred);
ok("drillSummary an all-deferred fleet states 0 passed plainly (never hidden)", summaryAllDeferred.includes("0 passed"));
ok("drillSummary an all-deferred fleet names the deferred count", summaryAllDeferred.includes("3 deferred"));
ok("drillSummary an all-deferred fleet does NOT say 'did not pass' (negative control)", !summaryAllDeferred.includes("did not pass"));
ok("drillSummary an all-deferred fleet does NOT read as verified (negative control)", !/\b3 of 3 passed\b/.test(summaryAllDeferred));

// A session with BOTH a genuine failure AND a deferred posture-refusal: the two stay distinct, in both the
// summary text and the failures modal (deferred downpipes never appear in the failures-only modal).
const bothFailAndDefer: DrillOutcomes = {
  passed: 1,
  failures: [{ id: "dp-broken", reason: "object missing" }],
  deferred: [{ id: "dp-bg", reason: "break-glass-only posture: no in-account read-back key" }],
  rateLimitExhausted: 0,
};
const summaryBoth = drillSummary(3, bothFailAndDefer);
ok("drillSummary a mixed session names the real failure count distinctly from deferred", summaryBoth.includes("1 did not pass") && summaryBoth.includes("1 deferred"));
const modalBoth = drillFailuresForSummary(bothFailAndDefer);
ok("drillFailuresForSummary NEVER includes a deferred downpipe (the modal is failures-only)", !modalBoth.some((f) => f.name === "dp-bg"));
ok("drillFailuresForSummary still carries the genuine failure", modalBoth.some((f) => f.name === "dp-broken"));

// The common case (no break-glass-only pipes in this drill) is unchanged: the original "N of M passed" reading.
const noDeferred: DrillOutcomes = { passed: 4, failures: [], deferred: [], rateLimitExhausted: 0 };
ok("drillSummary with no deferred and no failures keeps the original 'N of M passed' reading unchanged", drillSummary(4, noDeferred).includes("4 of 4 passed"));

// ---- slow-note: paints after the threshold, cancels cleanly ------------
ok("SLOW_NOTE_THRESHOLD_MS is a sane multi-second threshold", SLOW_NOTE_THRESHOLD_MS >= 1_000);
// runningNote renders a spinner + the message text (no innerHTML; typed builder).
const note = runningNote("Still restoring.");
ok("runningNote renders the message text", (note.textContent ?? "").includes("Still restoring."));
ok("runningNote includes a spinner element", (note as unknown as { querySelector(s: string): unknown }).querySelector(".ob-spinner") !== null);

// A FAST call: cancel before the threshold -> the note never paints (no flash on a quick restore).
{
  const target = h("div", {}, h("span", "placeholder"));
  const cancel = scheduleSlowNote(target, "Still restoring.", 20);
  cancel();
  await sleep(40);
  ok("scheduleSlowNote does NOT paint when cancelled before the threshold", (target.textContent ?? "").includes("placeholder"));
  ok("scheduleSlowNote leaves the original children intact when cancelled", !(target.textContent ?? "").includes("Still restoring."));
}

// A SLOW call: let the threshold elapse -> the note replaces the target's children.
{
  const target = h("div", {}, h("span", "placeholder"));
  const cancel = scheduleSlowNote(target, "Still restoring, a large run takes a while.", 10);
  await sleep(40);
  ok("scheduleSlowNote paints the running note after the threshold", (target.textContent ?? "").includes("Still restoring"));
  ok("scheduleSlowNote replaces the original children (placeholder gone)", !(target.textContent ?? "").includes("placeholder"));
  cancel(); // idempotent: cancelling after it fired is a no-op
}

console.log(failures === 0 ? "\nBULK-PACING / DRILL / SLOW-NOTE VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
