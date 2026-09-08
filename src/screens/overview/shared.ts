// Overview (IA screen 1) shared leaves: the data types the whole surface turns on, the
// cost-card constants, and the small cross-cutting helpers reused across the per-section
// render modules. Split out of overview.ts for size while keeping every definition byte-
// identical (a move, never a rewrite). House rules: Australian English, no em dashes,
// precise claims.

import type {
  AuditEvent,
  DownpipeState,
  DrillEvidenceEntry,
  LicenceStatus,
  RestoreApproval,
  RunHistoryEntry,
  SourceDiscovery,
  StatusReport,
  UpdateStatus,
} from "../../api.ts";
import type { StatusTone } from "../../components/status.ts";
import { recordWireAnomaly } from "../../lib/client-diag/ring.ts";
import { classifyError } from "../../lib/errors.ts";

// The projection horizon the compact cost card reports, matching the /costs screen's
// headline (month 12, accumulate basis), so the two surfaces agree on the same number.
export const COST_HEADLINE_MONTH = 12;

// The minimum run-history entries carrying the observed byte/segment fields before the
// cost card switches from a calm prompt to a real projection. Matches the /costs screen's
// MIN_OBSERVED_RUNS so the observed seed is a real per-run delta, not a single point.
export const COST_MIN_OBSERVED_RUNS = 2;

// The currency prefix the cost card shows, matching the /costs screen. The presets are
// indicative public list prices; the dedicated screen is where the operator enters their
// own contracted rates. This card is an at-a-glance estimate that links there.
export const COST_CURRENCY_PREFIX = "$";

// The freshness state of one downpipe, the honest distinction the whole surface turns
// on (flow.md Flow C decision point). "disabled" is NOT a failure; "unknown" is NOT a
// stale green; "in-flight" is a real state, not a missing row.
export type Freshness = "healthy" | "stale" | "failed" | "disabled" | "in-flight" | "unknown";

export interface FleetRow {
  readonly id: string;
  readonly freshness: Freshness;
  readonly lastStatus: "ok" | "failed" | "in-flight" | "abandoned" | "none";
  readonly lastGoodAt: string | null; // the most recent OK run's startedAt
  readonly lastRunAt: string | null; // the most recent run of any status
  readonly nextRunAt: number | null; // epoch ms, or null when disabled / not in the downpipe list
  readonly enabled: boolean;
  readonly cadenceSeconds: number | null;
  readonly recent: RunHistoryEntry[]; // newest-first ring, for the timeline + sparkline
  readonly lastRecordCount: number | null;
  readonly hasDownpipe: boolean; // present in GET /downpipes (so we trust enabled/nextRunAt/cadence)
  readonly inFlight: boolean; // a run is currently in progress (latest run in-flight, or the engine
                     // flag); a RUNNING CUE only, carried separately from freshness so an
                     // in-flight run never masks an underlying stale state (mirrors map.ts)
  // configUnreadable: the row IS in GET /downpipes and its configuration could not be read (no config
  // object, no source, or a source with no type). Distinct from hasDownpipe:false, which means the row is
  // not in the config list at all: the remedy differs completely (a roster clean-up on the Map, versus a
  // downpipe that was deleted while its run history survives), and the two must never coalesce. The row is
  // kept and labelled rather than dropped, so the console's fleet count cannot silently disagree with the
  // engine's. See lib/downpipe-readable.ts for the one decision behind it.
  readonly configUnreadable: boolean;
}

export interface FleetSummary {
  readonly total: number;
  readonly healthy: number;
  readonly stale: number;
  readonly failed: number;
  readonly disabled: number;
  readonly inFlight: number;
  readonly rows: FleetRow[];
  // Recovery-point context: the age (ms) of the most recent good backup fleet-wide.
  readonly newestGoodAt: string | null;
  // The OLDEST good backup among downpipes that are meant to be protected, which is the fleet's
  // actual worst-case recovery point. The RPO tile read newestGoodAt, so a fleet with one
  // downpipe backed up five minutes ago and nine untouched for a month reported five minutes. A
  // recovery point is set by the stalest protected system, never the freshest, so the headline read
  // reassuring in exactly the direction that hides risk. Disabled downpipes are excluded because
  // they are not expected to back up; a disabled downpipe is a decision, not a gap.
  readonly worstGoodAt: string | null;
  // How many non-disabled downpipes have NEVER had a good backup. This is deliberately separate from
  // worstGoodAt rather than folded into it: their recovery point is not old, it does not exist, and
  // rendering "unbounded" as any duration would be a smaller number than the truth.
  readonly noGoodBackupCount: number;
  // Whether ANY downpipe has at least one run (drives the true-empty teaching state).
  readonly anyRuns: boolean;
  // runsRolledOverCount is how many runs the engine RECORDED that the bounded rings no longer hold, and
  // runlogCounterReset says that figure is a FLOOR rather than a measurement (the account-global counter
  // has been wound back below a retained index, so the true loss is at least this). Both come from the
  // history read, both are OPTIONAL, and an ABSENT count is an unknown rather than a zero: it means the
  // engine did not publish one, not that nothing rolled. anyRuns:false with a rolled-over count above zero
  // is the estate that has LOST its record of its backups, which anyRuns alone reports as a new estate.
  readonly runsRolledOverCount?: number;
  readonly runlogCounterReset?: true;
}

// The independently-resolved snapshot. Each field is a settled result so one failing
// source does not blank the rest; the tiles read each field's own ok/unknown. Exported so the
// view-mode validator can build a synthetic snapshot and render BOTH framings against the same
// data (proving they read one source and cannot disagree); it is already the parameter type of the
// exported summariseFleet / executiveAnswers, so naming it is a strict completion of that surface.
export interface OverviewData {
  readonly health: Settled<{ ok: boolean; service?: string }>;
  readonly status: Settled<StatusReport>;
  readonly licence: Settled<LicenceStatus>;
  readonly updates: Settled<UpdateStatus>;
  readonly history: Settled<Record<string, RunHistoryEntry[]>>;
  // The RUN-HISTORY ROLLOVER COUNTERS, from the SAME single GET /admin/history read that fills `history`
  // above (fetch.ts derives both from one response; there is no second engine call).
  //
  // WHY THEY ARE A SEPARATE FIELD RATHER THAN A NUMBER ON `history`. `history` is the rings, and the rings
  // are what SURVIVES. A count of survivors cannot report what was destroyed: an estate whose history has
  // entirely rolled out of the bounded ring and a brand-new estate that has never run anything both answer
  // with an empty map. The counters are the other half, and the Overview needs both to tell those two
  // apart instead of printing "Nothing needs your attention yet" over each.
  //
  // OPTIONAL, and absent is not zero: an engine older than the counters omits them, and reading an absent
  // counter as 0 would tell every such estate that nothing had rolled over.
  readonly historyRollover?: Settled<{ recordedTotal?: number; retainedCount?: number; rolledOverCount?: number; counterReset?: true }>;
  readonly downpipes: Settled<DownpipeState[]>;
  // The durable, dated drill-evidence + audit trail. Best-effort reads: an unwired route
  // settles as an error and the recovery card shows the "pending engine" copy (never a faked
  // history; console-overview-1), without blanking the screen or routing to signed-out.
  readonly drillEvidence: Settled<DrillEvidenceEntry[]>;
  readonly audit: Settled<AuditEvent[]>;
  // The restore-approvals inbox (dual control), read so the needs-attention list states a real
  // pending count, not a standing prompt. Best-effort: an unwired or refused route settles as an
  // error and the item is omitted (an unknown is not an action item); never blanks the screen.
  readonly approvals: Settled<RestoreApproval[]>;
  // discovery is GET /admin/sources/discover: the bound bindings (kv/r2/d1/secrets) plus the added
  // token-source set, the input the surface-coverage hero needs to tell "added as a source" (amber) from
  // "not added" (slate). It makes LIVE Cloudflare API calls, so the view fetches it ONCE per visit and
  // caches it, NEVER on the 30s poll (the green/covered layer keeps updating from the downpipe list). A
  // failed read degrades the non-covered tiles to an honest "unknown", never a false "not added".
  readonly discovery: Settled<SourceDiscovery>;
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

// trailReadState classifies the durable drill-evidence + audit trail read for the recovery-evidence copy:
// "live" when either read succeeded, "not-wired" when BOTH failed as a genuine 404/501 (the route is not
// built yet, so an "until it ships" framing is honest), or "faulted" when both failed and at least one was
// a real fault (a 500 or a network throw) - so a broken or unreachable engine is not described as an unbuilt
// feature (B44, the roll-up sibling of the per-tile B39 fix).
export function trailReadState(drillEvidence: Settled<unknown>, audit: Settled<unknown>): "live" | "not-wired" | "faulted" {
  if (drillEvidence.ok || audit.ok) return "live";
  const bothNotWired = [drillEvidence, audit].every((s) => {
    const cls = classifyError(s.error);
    return cls.kind === "server" && (cls.status === 404 || cls.status === 501);
  });
  return bothNotWired ? "not-wired" : "faulted";
}

// ---- cross-cutting leaf helpers ---------------------------------------------

export function freshnessPresent(f: Freshness): { tone: StatusTone; label: string } {
  switch (f) {
    case "healthy": return { tone: "ok", label: "Healthy" };
    case "stale": return { tone: "warn", label: "Stale" };
    case "failed": return { tone: "danger", label: "Failed" };
    // The user-facing word for enabled:false is "Paused" everywhere (Overview, the
    // Downpipes State column, the drawer badge); the internal state name stays "disabled".
    case "disabled": return { tone: "neutral", label: "Paused" };
    case "in-flight": return { tone: "info", label: "Running" };
    case "unknown": return { tone: "neutral", label: "Unknown" };
  }
}

export function freshnessRank(f: Freshness): number {
  switch (f) {
    case "failed": return 0;
    case "stale": return 1;
    case "unknown": return 2;
    case "in-flight": return 3;
    case "healthy": return 4;
    case "disabled": return 5;
  }
}

// newestDrill returns the most recent drill-evidence entry by recordedAt (the engine returns
// them in an unspecified order, so sort defensively), or null when the list is empty.
export function newestDrill(entries: DrillEvidenceEntry[]): DrillEvidenceEntry | null {
  let best: DrillEvidenceEntry | null = null;
  let bestMs = -Infinity;
  let unparseable = 0;
  for (const e of entries) {
    const ms = Date.parse(e.recordedAt);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = e;
    } else if (!Number.isFinite(ms)) {
      unparseable++;
    }
  }
  // A drill-evidence stamp the console cannot parse. The entry is skipped by the newest-wins pick above, so
  // an unparseable stamp on the LATEST drill quietly promotes an OLDER one (or falls through to the first entry in
  // whatever order the engine returned), and the card then shows stale evidence dressed as current. That is a
  // posture claim the customer is relying on, and nothing has ever flagged it. Its own field class: the remedy is
  // an engine-side data fix, and the symptom (a drill date that does not move) is nothing like a corrupt run
  // timestamp. The malformed value never rides.
  if (unparseable > 0) recordWireAnomaly("drill-recorded-at", "unparseable");
  // Fall back to the first entry if none parsed (still better than nothing; honest).
  return best ?? entries[0] ?? null;
}

export function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
