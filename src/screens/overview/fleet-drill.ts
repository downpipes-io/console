// Fleet-drill pure helpers: collect the latest-run targets from a fresh history read and
// build the confirmational summary from the loop's accumulated outcomes. The drill loop
// itself stays on the view (it owns the engine, progress paint and live region); only the
// pure pieces live here. Moved verbatim out of view.ts for size; behaviour unchanged.
// House rules: Australian English, no em dashes, precise claims.

import type { RunHistoryEntry } from "../../api.ts";

// Cap on the number of failed ids named in the summary toast before the rest are rolled up
// into an "and N more" tail, so the line stays readable.
const MAX_NAMED_FAILED_IDS = 3;

export interface DrillTarget {
  id: string;
  runId: string;
}

// One drill failure: the downpipe id plus the REASON it did not pass (CON-1). Both the in-flow
// ok:false reason AND the thrown-error reason are captured here, so a 429 storm reads as N labelled
// "rate limited" failures rather than N unexplained "did not pass", and the recovery surface can list
// every failure with its cause (no more "3 named + N more" with no reason behind it).
export interface DrillFailure {
  id: string;
  reason: string;
}

// The accumulated outcomes of the sequential fleet drill, used to compose the summary and the
// per-item failures modal. `failures` is the source of truth for the failed set (its length is the
// failed count); `passed` is counted separately.
export interface DrillOutcomes {
  passed: number;
  failures: DrillFailure[];
  // deferred: downpipes the engine honestly REFUSED to drill because the estate is break-glass-only (no
  // in-account read-back key), classified by the same BREAK_GLASS_PREFIX the three single-run surfaces
  // already key on (restore-flow/proof.ts, runs/detail.ts). Nothing failed here: the posture is a
  // deliberate, correct choice, so these are kept OUT of `failures` and never read as a drill failure.
  deferred: DrillFailure[];
  // G287: how many of the failures gave up only after EXHAUSTING the capped 429 retries. A large-fleet drill
  // that dies to a rate-limit storm and one that dies to N genuinely broken pipes look identical in the drill
  // evidence (N pipes did not pass) and identical in the toast. They are opposite tickets: one is the engine's
  // limiter pacing a fleet that is too big for one sweep, the other is a restorability problem.
  rateLimitExhausted: number;
}

// collectDrillTargets reads the LATEST run of every downpipe from a fresh history fetch so
// the drill exercises the real latest runs. Entries with no latest runId are skipped.
export function collectDrillTargets(byDownpipe: Record<string, RunHistoryEntry[]>): DrillTargets {
  const targets: DrillTarget[] = [];
  let skippedNoRunId = 0;
  for (const id of Object.keys(byDownpipe)) {
    const latest = (byDownpipe[id] ?? [])[0];
    // G287: a downpipe whose latest history row carries no runId is DROPPED from the fleet drill, silently, and
    // it has been since the drill was built. It is not that the drill failed for that pipe: the drill was never
    // attempted, so no evidence is written and the pipe reads exactly like one that has never been drilled. "One
    // downpipe never appears in any drill" was unanswerable because absence looks the same as absence. Count it.
    if (latest?.runId) targets.push({ id, runId: latest.runId });
    else skippedNoRunId++;
  }
  return { targets, skippedNoRunId };
}

// The target list AND what it silently left out (G287). The skip count is part of the result rather than a side
// effect, so the drill loop cannot forget to carry it.
export interface DrillTargets {
  targets: DrillTarget[];
  skippedNoRunId: number;
}

// drillSummary composes the confirmational toast text naming the REAL outcomes (the loop received each
// one; a guessed cause would be dishonest). The toast stays a short headline (the first few ids, then an
// "and N more" tail); the FULL per-failure detail, with every reason, is in the failures modal the view
// opens (CON-1) and the durable, dated drill-evidence log (D4). It points at "the details below" so the
// operator knows the rolled-up tail is not the whole story.
//
// deferred is reported as its OWN clause, distinct from "did not pass": a break-glass-only downpipe is a
// correct, deliberate posture, not a failure, so it is named and explained (not silently merged into the
// passed count, which would read as "verified" when it was not). The common case (no deferred downpipes)
// keeps the original, simpler "N of M passed" reading unchanged.
export function drillSummary(total: number, o: DrillOutcomes): string {
  const failed = o.failures.length;
  const deferred = o.deferred.length;
  if (failed === 0 && deferred === 0) return `Fleet drill complete: ${o.passed} of ${total} passed.`;
  const failList =
    o.failures.slice(0, MAX_NAMED_FAILED_IDS).map((f) => f.id).join(", ") +
    (failed > MAX_NAMED_FAILED_IDS ? ` and ${failed - MAX_NAMED_FAILED_IDS} more` : "");
  const firstReason = o.failures[0]?.reason;
  const segments = [`${o.passed} passed`];
  if (deferred > 0) segments.push(`${deferred} deferred (break-glass-only posture; prove these with attended verification)`);
  if (failed > 0) segments.push(`${failed} did not pass: ${failList}${failed === 1 && firstReason ? ` (${firstReason})` : ""}`);
  return `Fleet drill complete: ${segments.join("; ")}.${failed > 0 ? " See the details below for every reason." : ""}`;
}

// drillFailuresForSummary maps the accumulated failures into the shape openBulkSummary renders (the
// downpipe id as the item name, the captured reason verbatim), so the fleet drill reuses the SAME
// per-item failures modal the bulk run/disable/delete path uses (CON-1). Deferred downpipes are
// deliberately NOT in this list: the modal is the failures surface, and nothing failed for them.
export function drillFailuresForSummary(o: DrillOutcomes): Array<{ name: string; reason: string }> {
  return o.failures.map((f) => ({ name: f.id, reason: f.reason }));
}
