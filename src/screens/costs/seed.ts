// Observed-vs-manual seeding: read run history and decide the mode and seed. summariseHistory
// inspects every downpipe's run ring and, when enough recent runs carry the observed per-run
// fields, builds an honest observed seed (it reads ONLY counts and sizes, never content);
// otherwise it reports no-fields or empty. Exported for the observed-seed unit test
// (validate-cost-model.ts); pure and DOM-free, so it is safe to import outside the browser. It
// imports only the shared leaf (./helpers.ts) and the cost-model library.

import type { Downpipe, RunHistoryEntry, RunOpCounts } from "../../api.ts";
import { deriveAccountCadence } from "../../lib/cost-cadence.ts";
import {
  addUsage,
  DEFAULT_DEDUP_RATIO,
  DEFAULT_INPUTS,
  DEFAULT_OVERHEAD_BYTES,
  DEFAULT_SEG_BYTES,
  type OpCountsLike,
  PER_RUN_OVERHEAD,
  type Pricing,
  platformCost,
  rollupStorage,
  scaleUsage,
  usageFromOpCounts,
  usageWithDefaults,
  withDefaults,
} from "../../lib/cost-model.ts";
import {
  clamp01,
  clampNonNeg,
  HEADLINE_MONTH,
  type HistoryLoad,
  MIN_OBSERVED_RUNS,
  withoutOneOccurrence,
} from "./helpers.ts";

// meanOpCounts averages the EXACT per-resource op tallies across the runs that carry them,
// giving the mean per-run usage the platform ledger scales by the cadence. Runs from an older engine omit
// opCounts, so the caller averages only over those that have it (an honest exact figure, never diluted by
// zeros). Pure.
function meanOpCounts(list: RunOpCounts[]): OpCountsLike {
  const n = Math.max(1, list.length);
  const mean = (k: keyof RunOpCounts): number => list.reduce((s, o) => s + clampNonNeg(o[k]), 0) / n;
  return {
    kvRead: mean("kvRead"),
    kvList: mean("kvList"),
    r2ClassA: mean("r2ClassA"),
    r2ClassB: mean("r2ClassB"),
    d1Read: mean("d1Read"),
    cfApiRead: mean("cfApiRead"),
    secretsRead: mean("secretsRead"),
    subrequests: mean("subrequests"),
  };
}

// ---------------------------------------------------------------------------
// Observed-vs-manual seeding: read run history and decide.
// ---------------------------------------------------------------------------

// summariseHistory inspects every downpipe's run ring and, when enough recent runs
// carry the observed per-run fields (archiveBytesWritten / segmentsWritten), builds an
// observed seed. Otherwise it reports no-fields (runs exist, but without the throughput
// counts) or empty (no runs at all). It reads ONLY counts and sizes, never content.
//
// The seed (honest per-run snapshot basis; the DEFAULT growth model):
//   - sourceBytes (S): anchored so the model's PER-RUN bytes equal the REAL observed mean
//     per-run archiveBytesWritten. Under the live engine every run stores a full snapshot,
//     so per-run growth = A0 = S x d, and S = meanPerRunBytes / d. This is what makes the
//     observed projection "runs per period times archive bytes per run" with the archive
//     bytes taken straight from run history, which is already honest data.
//   - churnFraction (c): seeded for the clearly-labelled FUTURE cross-run dedup model only
//     (it does not move the default projection). When the byte shape identifies a baseline
//     seal + incremental deltas it is the incremental mean over the baseline; otherwise it
//     stays at the model default rather than fabricating a figure.
//   - segBytes: the observed bytes-per-object (mean archiveBytesWritten / mean
//     segmentsWritten), so object-count estimates match the real writer granularity.
//   - runsPerMonth (f): the sum, over the downpipes in the run history, of the runs a month
//     each one's CONFIGURED schedule starts (lib/cost-cadence.ts deriveAccountCadence). Only
//     when the downpipe list could not be read (downpipes === null) does it fall back to the
//     median gap between each downpipe's own recorded runs. It never pools the start times of
//     different downpipes, and a manual run does not change a scheduled figure.
//   - sourceBytes is then weighted by those run counts across downpipes, so S x d x f is the
//     sum of each downpipe's runs a month times its own mean bytes per run.
//   - overheadBytes: kept at the default (the per-run fixed overhead is not separately
//     reported; archiveBytesWritten already includes it, so the modelled O stays small and
//     the observed mean carries the real weight).
// Exported for the observed-seed unit test (validate-cost-model.ts); pure and DOM-free, so it
// is safe to import outside the browser. It reads ONLY counts and sizes, never content.
export function summariseHistory(byDownpipe: Record<string, RunHistoryEntry[]>, downpipes: Downpipe[] | null = null): HistoryLoad {
  // Flatten every run across downpipes. A combined view is the right basis for an
  // account-wide cost estimate (the destination bill is account-wide).
  const all: RunHistoryEntry[] = Object.values(byDownpipe).flatMap((ring) => ring ?? []);
  if (all.length === 0) return { kind: "empty" };

  // The runs that carry BOTH observed fields and are usable (finite, non-negative), per downpipe
  // (the cadence is derived per downpipe) and flattened (the byte shape and segment size are account-wide).
  const measuredByDownpipe: Record<string, RunHistoryEntry[]> = {};
  for (const [id, ring] of Object.entries(byDownpipe)) measuredByDownpipe[id] = (ring ?? []).filter(hasObservedFields);
  const withFields = Object.values(measuredByDownpipe).flat();
  if (withFields.length < MIN_OBSERVED_RUNS) {
    return { kind: "no-fields", runs: all.length };
  }

  // Cumulative stored bytes observed (the sum of per-run new stored bytes), plus the per-run
  // breakdown we need to separate the FIRST full seal from the later incremental runs.
  let sumArchiveBytes = 0;
  let sumSegments = 0;
  const archivePerRun: number[] = [];
  for (const e of withFields) {
    const a = clampNonNeg(e.archiveBytesWritten);
    sumArchiveBytes += a;
    sumSegments += clampNonNeg(e.segmentsWritten);
    archivePerRun.push(a);
  }

  const opCountsPerRun = deriveOpCountsPerRun(withFields);
  const churnFraction = deriveChurnFraction(archivePerRun);
  const cadence = deriveAccountCadence(measuredByDownpipe, byDownpipe, downpipes);
  const impliedSourceBytes = anchorSourceBytes(cadence.meanRunBytes);

  // Bytes per object: the observed writer granularity. Guard the divisor; fall back to
  // the default segment size when no segments were observed.
  const segBytes = sumSegments > 0 ? Math.max(1, sumArchiveBytes / sumSegments) : DEFAULT_SEG_BYTES;

  const seed = withDefaults({
    sourceBytes: impliedSourceBytes,
    dedupRatio: DEFAULT_DEDUP_RATIO,
    churnFraction,
    runsPerMonth: cadence.runsPerMonth,
    segBytes,
    // Retention and ops are workload policy, not throughput, so they stay at the
    // defaults for the operator to set; overhead stays at the modelled default.
    overheadBytes: DEFAULT_OVERHEAD_BYTES,
  });

  return { kind: "seedable", seed, runs: withFields.length, cadence: cadence.basis, ...(opCountsPerRun !== undefined ? { opCountsPerRun } : {}) };
}

// hasObservedFields reports whether a run carries both observed per-run counts as finite, non-negative
// numbers (the runs the observed seed can use).
function hasObservedFields(e: RunHistoryEntry): boolean {
  return (
    typeof e.archiveBytesWritten === "number" &&
    Number.isFinite(e.archiveBytesWritten) &&
    e.archiveBytesWritten >= 0 &&
    typeof e.segmentsWritten === "number" &&
    Number.isFinite(e.segmentsWritten) &&
    e.segmentsWritten >= 0
  );
}

// deriveOpCountsPerRun averages the EXACT per-resource op tally over the runs that carry
// opCounts. Absent on older-engine rows, so it averages only over those that have it; undefined when
// none do (the platform ledger then falls back to its estimate). Reads only counts, never content.
function deriveOpCountsPerRun(withFields: RunHistoryEntry[]): OpCountsLike | undefined {
  const opRuns = withFields.filter((e): e is RunHistoryEntry & { opCounts: RunOpCounts } => e.opCounts !== undefined);
  return opRuns.length > 0 ? meanOpCounts(opRuns.map((e) => e.opCounts)) : undefined;
}

// deriveChurnFraction reads churn from the run-byte SHAPE, not the run COUNT. archiveBytesWritten is the
// new STORED bytes a run added: the first full seal writes the whole baseline archive A0 in one run,
// while every later run writes only that run's churn delta dA. So the honest per-run churn fraction is
// the mean incremental write as a share of the baseline seal, c = dA / A0 (exactly the model's own
// definition, dA = S*c*d over A0 = S*d). This depends on the bytes each run actually wrote, so a
// near-static source reads a small churn and a volatile one a large churn, regardless of history length.
//
// A derivation that takes the MEAN per-run write over the CUMULATIVE sum, mean / sum, reduces
// algebraically to 1 / runCount: it ignores every byte value and turns the churn fraction into a function
// of history length alone (10 runs -> always 10 per cent, 30 runs -> always 3.3 per cent), which would feed
// a misleading churn percentage into the screen, the retained-GC aging term (1 - c)^R and the sweep. The
// byte-shape derivation below avoids that failure mode.
//
// Identify the baseline seal as the largest single-run write (the full seal stores all of A0 at once;
// every incremental run stores only dA <= A0, so the max is the seal's robust proxy even when several
// downpipes' rings are combined). The incremental mean is the mean of the remaining runs (the baseline
// occurrence removed once).
//
// Honest fallback when the byte shape cannot identify a baseline + incremental split: a single usable
// run (no incremental run after removing the seal), a zero-byte baseline, or a uniform set where the
// largest write is not strictly larger than the rest (so a full seal cannot be told apart from a run of
// equal-sized incrementals; under the live engine a uniform set is in fact the EXPECTED shape, every run
// being a full snapshot). In those unidentifiable cases we do NOT fabricate a churn from the byte
// pattern; we leave churn at the model default and let the operator set it (the field is editable with
// low/expected/high presets). Churn seeds the clearly-labelled future cross-run dedup model only; it does
// not move the default per-run snapshot projection either way.
function deriveChurnFraction(archivePerRun: number[]): number {
  const baselineArchiveBytes = archivePerRun.reduce((m, a) => (a > m ? a : m), 0);
  const incrementalRuns = withoutOneOccurrence(archivePerRun, baselineArchiveBytes);
  const incrementalMean = incrementalRuns.length > 0 ? incrementalRuns.reduce((s, a) => s + a, 0) / incrementalRuns.length : 0;
  const churnIdentifiable = incrementalRuns.length > 0 && baselineArchiveBytes > 0 && baselineArchiveBytes > incrementalMean;
  return churnIdentifiable ? clamp01(incrementalMean / baselineArchiveBytes) : DEFAULT_INPUTS.churnFraction;
}

// anchorSourceBytes returns the implied logical source size, anchored so the model's PER-RUN bytes are
// the REAL observed mean per-run write: under the default per-run snapshot model each run stores
// A0 = S x d, so S = meanRunBytes / d makes the projection literally "runs per period times the
// archive bytes a run actually writes" (the honest, run-history-driven basis). meanRunBytes is weighted
// by each downpipe's runs a month (deriveAccountCadence). Guard the divisor (the default ratio is
// positive by construction).
function anchorSourceBytes(meanRunBytes: number): number {
  return meanRunBytes / Math.max(Number.EPSILON, DEFAULT_DEDUP_RATIO);
}

// ---------------------------------------------------------------------------
// Cost by source type (the per-source-type breakdown)
// ---------------------------------------------------------------------------

// SourceTypeCostRow is one source type's observed monthly cost to back up: how much storage and how much
// Cloudflare-resource (platform) cost it accrues, from its own run history. exact is true when the
// platform figure came from the run's MEASURED op tally (opCounts), false when estimated from object
// counts. The account-wide plan base and the wiggle margin are NOT split in (they sit in the headline).
export interface SourceTypeCostRow {
  sourceType: string;
  runs: number;
  storedBytes: number;
  storageCost: number;
  platformCost: number;
  total: number;
  exact: boolean;
}

// costBySourceType breaks the observed monthly cost down per source type, so the operator sees which data
// costs what to back up (for example "Workers KV $X/mo, D1 $Y/mo"). For each source type it runs the SAME
// observed seed over just that type's downpipes, then prices destination storage (accumulate basis, the
// headline month) plus the Cloudflare platform ledger (EXACT from the run history's opCounts when present,
// else the over-estimate from object counts). Pure; reads only counts and sizes, never content. A source
// type with no usable observed run history is omitted (no honest figure to show). Rows are sorted by total
// monthly cost, descending, so the biggest line is first.
export function costBySourceType(
  byDownpipe: Record<string, RunHistoryEntry[]>,
  sourceTypeByDownpipe: Record<string, string>,
  pricings: Pricing[],
  downpipes: Downpipe[] | null = null,
): SourceTypeCostRow[] {
  // Group the downpipe rings by source type (a ring whose downpipe is unknown, for example a deleted
  // downpipe, is skipped: there is no source type to attribute its cost to).
  const byType = new Map<string, Record<string, RunHistoryEntry[]>>();
  for (const id of Object.keys(byDownpipe)) {
    const t = sourceTypeByDownpipe[id];
    if (t === undefined) continue;
    const bucket = byType.get(t) ?? {};
    bucket[id] = byDownpipe[id] ?? [];
    byType.set(t, bucket);
  }
  const rows: SourceTypeCostRow[] = [];
  for (const [sourceType, subset] of byType) {
    // The same seed over just this type's downpipes: their own schedules, so a row's runs a month is the
    // sum of that type's downpipes, never the whole account's.
    const load = summariseHistory(subset, downpipes);
    if (load.kind !== "seedable") continue; // no observed throughput for this source type yet
    const seed = load.seed;
    // Destination storage sums across the fan-out (each destination stores this type's bytes at its own
    // rates); the object count it also reports is per-destination (identical per copy), which is what the
    // platform usage estimate below needs.
    const storage = rollupStorage(seed, pricings, { regime: "accumulate", month: HEADLINE_MONTH });
    const f = seed.runsPerMonth;
    const op = load.opCountsPerRun;
    // Platform usage: the EXACT measured ops scaled to the month (plus per-run compute overhead) when the
    // history carries opCounts; otherwise the same object-count over-estimate the headline uses.
    const usage = op
      ? scaleUsage(addUsage(usageFromOpCounts(op), PER_RUN_OVERHEAD), f)
      : addUsage(scaleUsage(PER_RUN_OVERHEAD, f), usageWithDefaults({ r2ClassA: storage.objectsWrittenPerMonth, kvReads: storage.objectsWrittenPerMonth }));
    const platform = platformCost(usage);
    let runs = 0;
    for (const id of Object.keys(subset)) runs += (subset[id] ?? []).length;
    rows.push({
      sourceType,
      runs,
      storedBytes: storage.averageStoredBytes,
      storageCost: storage.storage,
      platformCost: platform.total,
      total: storage.storage + platform.total,
      exact: op !== undefined,
    });
  }
  rows.sort((a, b) => b.total - a.total);
  return rows;
}
