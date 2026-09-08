// Shared types and constants for the Runs screen, used across the view,
// the summary band, the data table and the run detail drawer. Kept in one leaf module so
// each section module imports the same vocabulary without forming a cycle.

import type { RunHistoryEntry } from "../../api.ts";
import type { StatusTone } from "../../components/status.ts";

// A run row carried with its owning downpipe id (the fleet view flattens all rings).
export interface FleetRun extends RunHistoryEntry {
  downpipeId: string;
  // The downpipe's human name (Downpipe.name), when the list read supplied it. The id
  // stays the stable key; the name is the operator-facing reading.
  downpipeName?: string;
}

// The break-glass drill reason prefix (BREAK_GLASS_PREFIX) is the canonical export of
// restore-flow/shared.ts; the run detail drawer imports it directly from there so the
// console keeps one definition. It is not re-declared here.

// The status filter values the Overview deep-links to (/runs?status=failed) and the
// table's status facets. Kept as one vocabulary so the legacy ?status= link and the
// faceted UI agree (a deep link pre-selects the matching facet).
export type RunStatus = RunHistoryEntry["status"]; // "in-flight" | "ok" | "failed" | "abandoned"
//
// ABANDONED WAS MISSING FROM THIS LIST AND THAT IS WHY IT READ AS SUCCESS EVERYWHERE. The alias above
// derives from the wire type, so it always contained "abandoned"; this array is hand-written, and the three
// entries were the whole vocabulary the table's facets, its status sort and its URL guard shared. An
// abandoned run was therefore unfilterable, hidden whenever any status facet was active, dropped from
// ?status=abandoned, and sorted into the same worst-first bucket as ok.
//
// It is its own facet rather than folded into failed, because the engine keeps the two apart deliberately.
// "abandoned" is minted at exactly one place, the lease reclaim in engine src/sched/scheduler-do-scheduling.ts
// (the next trigger finds an in-flight row whose 30-minute lease has expired and stamps
// "abandoned (run lease expired)"). The /complete wire type cannot even express it, so a seal driver never
// reports one. That is "the verdict was lost", not "it failed for THIS reason", and the difference is exactly
// what the operator needs: a failed run has a diagnosed cause, an abandoned one has a lost verdict, and the
// engine's own comment at scheduler-do-sre-alerting.ts says the full entry "keeps the distinct abandoned
// status for the console display".
//
// warn, not danger: the engine counts it as a failure for staleness, strikes, metrics and OTLP, so it is
// never green, and it is not the same red as a failure the engine can explain.
export const STATUS_FACETS: ReadonlyArray<{ id: RunStatus; label: string; tone: StatusTone }> = [
  { id: "ok", label: "ok", tone: "ok" },
  { id: "failed", label: "failed", tone: "danger" },
  { id: "abandoned", label: "abandoned", tone: "warn" },
  { id: "in-flight", label: "in-flight", tone: "info" },
];

// UNSUCCESSFUL is the set the engine itself treats as failure-like: a run that failed with a diagnosis and
// a run whose verdict was lost. The engine collapses them at every consumer that counts health (metrics.ts
// "attempts = successes + failures", the strike counter, the OTLP push and the staleness classifier), while
// keeping them distinct in storage. The console now does the same: counted together where the question is
// "does anything need attention", named apart everywhere the operator is told what happened.
export function isUnsuccessful(s: RunStatus): boolean {
  return s === "failed" || s === "abandoned";
}
