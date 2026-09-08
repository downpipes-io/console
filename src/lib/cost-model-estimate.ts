// The estimation engine of the downpipes cost ESTIMATION library: the core derived
// quantities (stored size, object counts), the two storage-over-time regimes, the
// monthly cost breakdown, the multi-month projection, the marginal/one-off views, and
// the sensitivity sweeps. It builds on cost-model-rates.ts (constants, pricing, inputs,
// cadence conversions and the numeric guards); cost-model.ts re-exports both as one
// library.
//
// EVERY figure this module returns is an ESTIMATE, not a quote or a guarantee.
//
// This module is PURE and DETERMINISTIC by contract:
//   - no DOM access, no engine import, no network;
//   - no wall-clock (Date.now / performance.now) and no randomness (Math.random /
//     crypto) APIs, so the same inputs always give the same outputs and the module is
//     trivially unit-testable.
// It transmits nothing. Nothing here is a no-custody concern: it never touches a key,
// a secret, or archive content, only sizes and counts.
//
// House rules followed: Australian English; precise claims (an estimate is an estimate);
// custom domains only (no vendor URLs appear here at all). exactOptionalPropertyTypes is
// ON, so optional fields are added via conditional spreads and are never assigned
// undefined; noUncheckedIndexedAccess is satisfied by guarding every indexed read.

import {
  BYTES_PER_GB,
  clamp01,
  clampDedup,
  DEFAULT_MANIFEST_OBJECTS,
  dedupeSortedAsc,
  type Inputs,
  nonNeg,
  OBJECTS_PER_MILLION,
  type Pricing,
  sanitisePricing,
} from "./cost-model-rates.ts";

// ---------------------------------------------------------------------------
// Core derived quantities
// ---------------------------------------------------------------------------

// storedSize returns A0, the stored archive size in bytes for a logical size S at stored
// ratio d (A0 = S x d). This is an estimate of the initial sealed footprint.
export function storedSize(sourceBytes: number, dedupRatio: number): number {
  return nonNeg(sourceBytes) * clampDedup(dedupRatio);
}

// churnStoredBytes returns dA under the CHURN-DEDUP model: the new unique STORED bytes a
// single run would add for source S, churn c and stored ratio d (dA = S x c x d), IF the
// addressing key were stable across runs. That is a recorded SPEC-level decision, not
// current engine behaviour; use perRunStoredBytes for the model-aware per-run growth.
export function churnStoredBytes(sourceBytes: number, churnFraction: number, dedupRatio: number): number {
  return nonNeg(sourceBytes) * clamp01(churnFraction) * clampDedup(dedupRatio);
}

// perRunStoredBytes returns the stored bytes ONE run adds (before the fixed overhead O),
// honouring the growth model. Under the DEFAULT "snapshot" model every run stores the full
// snapshot A0 = S x d (the live engine: the addressing key is per-run, so nothing dedups
// across runs); under "churn-dedup" a run stores only its churn, S x c x d. An estimate.
export function perRunStoredBytes(inputs: Inputs): number {
  if (inputs.growthModel === "churn-dedup") {
    return churnStoredBytes(inputs.sourceBytes, inputs.churnFraction, inputs.dedupRatio);
  }
  return storedSize(inputs.sourceBytes, inputs.dedupRatio);
}

// objectsForBytes estimates the destination-object count for a given stored byte count,
// from the writer's segment size: ceil(bytes / segBytes). Zero bytes is zero objects.
// This is an ESTIMATE (see DEFAULT_SEG_BYTES); a lower bound for many small records.
export function objectsForBytes(storedBytes: number, segBytes: number): number {
  const b = nonNeg(storedBytes);
  if (b === 0) return 0;
  return Math.ceil(b / Math.max(1, segBytes));
}

// newObjectsPerRun estimates the destination objects a single run writes: the segment
// objects for that run's stored bytes (the full snapshot under the default model; the churn
// delta under churn-dedup) plus a small constant of manifest/capsule objects
// (DEFAULT_MANIFEST_OBJECTS): newObjects ~= ceil(perRunBytes / segBytes) + manifestObjects.
export function newObjectsPerRun(inputs: Inputs): number {
  const perRun = perRunStoredBytes(inputs);
  return objectsForBytes(perRun, inputs.segBytes) + DEFAULT_MANIFEST_OBJECTS;
}

// initialObjects estimates the objects the FIRST full seal of A0 writes: the segment
// objects for A0 plus the manifest constant.
export function initialObjects(inputs: Inputs): number {
  const a0 = storedSize(inputs.sourceBytes, inputs.dedupRatio);
  return objectsForBytes(a0, inputs.segBytes) + DEFAULT_MANIFEST_OBJECTS;
}

// referencedInitialBytes estimates A0_ref, the share of the initial content A0 still
// referenced by one of the most-recent R retained runs UNDER THE CHURN-DEDUP MODEL (cross-run
// dedup; not current engine behaviour). With a churn fraction c replacing content each run,
// the original content survives geometrically: A0_ref ~= A0 x (1 - c)^R. Under the default
// per-run snapshot model this concept does not apply (a retained window simply holds R whole
// snapshots; the initial seal ages out of the window entirely), so only the churn-dedup
// retained regime consumes this. Edges are exact: c = 0 keeps all of A0; c = 1 (and R >= 1)
// references essentially none of the original. R = 0 means "keep everything", so A0 stays
// fully referenced.
export function referencedInitialBytes(inputs: Inputs): number {
  const a0 = storedSize(inputs.sourceBytes, inputs.dedupRatio);
  const R = nonNeg(inputs.retentionRuns);
  if (R === 0) return a0; // keep everything: all of A0 is still referenced
  const c = clamp01(inputs.churnFraction);
  return a0 * (1 - c) ** R;
}

// ---------------------------------------------------------------------------
// Storage over time: the two regimes
// ---------------------------------------------------------------------------

// Regime names the two storage-over-time models the screen shows side by side.
//   "accumulate": no segment collection runs, so every run's new content persists. This models
//     retention enforcement being OFF, which is the DEFAULT, not an engine that cannot collect.
//   "retained":   retention keeps only the most-recent R runs and collects what they no longer
//     reference, so storage is bounded. This is what enabling enforcement on a policy would save.
//
// The distinction is not pedantic. The engine's manifest-driven segment collection exists and runs,
// deleting unreferenced segments once enforcement is on. Describing accumulate as "the as-built
// reality of an engine that does not yet GC" told a customer their bill must grow forever when the
// saving was one setting away, which is what the screen's own strings said until they were corrected.
export type Regime = "accumulate" | "retained";

// storedBytesAccumulate returns A_accumulate(m) in BYTES: A0 + (perRunBytes + O) x n, with
// the run count n = f x m (fractional m and n are allowed for month-midpoint averaging).
// Under the DEFAULT snapshot model perRunBytes = A0 (every run stores a full snapshot), so
// this is "runs per period times archive bytes per run" on top of the initial seal; under
// churn-dedup it is the spec's churn-driven growth. An estimate that grows roughly linearly
// with run count either way.
export function storedBytesAccumulate(inputs: Inputs, months: number): number {
  const a0 = storedSize(inputs.sourceBytes, inputs.dedupRatio);
  const perRun = perRunStoredBytes(inputs);
  const n = nonNeg(inputs.runsPerMonth) * nonNeg(months);
  return a0 + (perRun + nonNeg(inputs.overheadBytes)) * n;
}

// storedBytesRetained returns the retained-with-GC footprint in BYTES at month m, bounded by
// the model-aware steady state:
//   snapshot (DEFAULT): a retained window simply holds the most-recent R whole runs, each a
//     full snapshot, so steady = (A0 + O) x R. The initial seal ages out of the window like
//     any other run (no cross-run referencing exists to keep it partially alive).
//   churn-dedup (FUTURE): the spec's steady state A0_ref + (dA + O) x R, where the original
//     content survives geometrically (referencedInitialBytes).
// The retained curve grows with accumulate until R runs have elapsed (GC has nothing to
// collect yet), then settles at the bounded steady state:
//   elapsed runs n = f x m;
//   n <= R : retained == storedBytesAccumulate(m)   (pre-steady, nothing collected yet)
//   n  > R : retained == steady                      (bounded thereafter)
// Called with no month it returns the steady state. Bounded regardless of how long the
// schedule runs. An estimate.
export function storedBytesRetained(inputs: Inputs, months?: number): number {
  const R = nonNeg(inputs.retentionRuns);
  // R = 0 means "keep everything": the retained regime degenerates to accumulate. When a month
  // is given, that is the accumulate footprint at that month. When the month is omitted the
  // "keep everything" regime has no bounded steady state (it grows without limit), so rather
  // than return a non-finite Infinity (which would propagate NaN/Infinity to any caller, such
  // as a sensitivity sweep or the screen), return the finite current snapshot: the accumulate
  // footprint at month 0, i.e. the initial stored size A0. Callers that want a later snapshot
  // pass an explicit month.
  if (R === 0) {
    return storedBytesAccumulate(inputs, months ?? 0);
  }
  const perRun = perRunStoredBytes(inputs);
  const steady =
    inputs.growthModel === "churn-dedup"
      ? referencedInitialBytes(inputs) + (perRun + nonNeg(inputs.overheadBytes)) * R
      : (perRun + nonNeg(inputs.overheadBytes)) * R;
  if (months === undefined) return steady;
  // Before R runs have elapsed, GC has not pruned anything yet, so retained tracks the
  // accumulate curve; once R runs have passed the footprint is the bounded steady state.
  const elapsed = nonNeg(inputs.runsPerMonth) * nonNeg(months);
  if (elapsed <= R) return storedBytesAccumulate(inputs, months);
  return steady;
}

// ---------------------------------------------------------------------------
// Cost breakdown
// ---------------------------------------------------------------------------

// CostBreakdown is a monthly cost split into its four components plus the total, all in the
// pricing currency. Every figure is an ESTIMATE. averageStoredBytes is the stored size the
// storage cost was computed over (month-midpoint for accumulate; for retained, the accumulate
// footprint before R runs have elapsed and the bounded steady state thereafter),
// exposed so the screen can show the basis. objectsWrittenPerMonth and the read/egress
// drivers are exposed for the assumptions panel.
export interface CostBreakdown {
  storage: number;
  writes: number;
  reads: number;
  egress: number;
  total: number;
  averageStoredBytes: number;
  objectsWrittenPerMonth: number;
}

// MonthlyCostOptions selects the regime and the month the average is taken at, plus the
// per-drill / per-restore read and download assumptions. objectsReadPerDrill /
// objectsReadPerRestore default to the whole estimated object count of the averaged stored
// size (a full-archive drill/restore), the conservative case; the operator can override.
// restoreGBPerRestore defaults to the whole referenced archive size in GB (a full restore).
export interface MonthlyCostOptions {
  regime: Regime;
  // month: the month index the average is taken at, for the accumulate regime's midpoint
  // (storage is averaged over [month-1, month], i.e. at month - 0.5). Default 12.
  month?: number;
  // objectsReadPerDrill: objects a single drill reads. Default: all objects of the averaged
  // stored size.
  objectsReadPerDrill?: number;
  // objectsReadPerRestore: objects a single restore reads. Default: all objects of the
  // averaged stored size.
  objectsReadPerRestore?: number;
  // restoreGBPerRestore: GB downloaded per restore (out of the account). Default 0 (an
  // in-account restore downloads nothing); set to the restored GB when data leaves the account.
  restoreGBPerRestore?: number;
}

// monthlyCost returns the estimated monthly cost split (storage / writes / reads / egress
// and the total) for the chosen regime.
//
//   storage = A_avg_GB x P_store
//   writes  = (newObjects x f) / 1e6 x P_classA
//   reads   = (drills x objectsPerDrill + restores x objectsPerRestore) / 1e6 x P_classB
//   egress  = (restores x restoreGB + offlineRecoveries x archiveGB) x P_egress
//             (in-account drills/restores contribute 0 egress when driveEgressFree)
//   total   = storage + writes + reads + egress
//
// A_avg is the month-midpoint stored size for accumulate; for retained, the actual retained
// footprint at the given month (accumulate until R runs elapsed, then the bounded steady state).
// archiveGB is the WHOLE recoverable archive at this month for the regime in play (an offline
// recovery downloads the whole archive, not the spec's aged-down A0 x (1 - c)^R simplification);
// see the egress block below. For R2 (P_egress = 0) the egress term is exactly 0; the screen
// surfaces that as an advantage.
export function monthlyCost(inputs: Inputs, pricing: Pricing, opts: MonthlyCostOptions): CostBreakdown {
  const p = sanitisePricing(pricing);
  const month = nonNeg(opts.month ?? 12);
  const f = nonNeg(inputs.runsPerMonth);

  // Average stored size for the regime, in bytes then GB. The accumulate regime averages
  // over the month (its month midpoint, m - 0.5). The retained regime accumulates until R runs
  // have elapsed and only then settles at its bounded steady-state footprint (see
  // storedBytesRetained); this average uses that steady state for the later months. When
  // retention is "keep everything" (R = 0) it degenerates to accumulate and uses the same
  // midpoint, so the two regimes coincide exactly in that case.
  const midpoint = Math.max(0, month - 0.5);
  const retainedDegenerates = nonNeg(inputs.retentionRuns) === 0;
  const avgBytes =
    opts.regime === "accumulate" || retainedDegenerates
      ? storedBytesAccumulate(inputs, midpoint)
      : storedBytesRetained(inputs, month);
  const avgGB = avgBytes / BYTES_PER_GB;

  // Storage.
  const storage = avgGB * p.storagePerGBMonth;

  // Writes: objects written per month is per-run objects times runs per month.
  const objectsWrittenPerMonth = newObjectsPerRun(inputs) * f;
  const writes = (objectsWrittenPerMonth / OBJECTS_PER_MILLION) * p.classAPerMillion;

  // Reads: default a full-archive drill/restore over the averaged stored size.
  const fullObjects = objectsForBytes(avgBytes, inputs.segBytes);
  const objectsPerDrill = nonNeg(opts.objectsReadPerDrill ?? fullObjects);
  const objectsPerRestore = nonNeg(opts.objectsReadPerRestore ?? fullObjects);
  const readObjects = nonNeg(inputs.drillsPerMonth) * objectsPerDrill + nonNeg(inputs.restoresPerMonth) * objectsPerRestore;
  const reads = (readObjects / OBJECTS_PER_MILLION) * p.classBPerMillion;

  // Egress: in-account drills are always egress-free; in-account restores are egress-free
  // when driveEgressFree, otherwise the restore download counts. Offline recoveries always
  // egress the WHOLE recoverable archive present in this regime at this month.
  const restoreGB = nonNeg(opts.restoreGBPerRestore ?? 0);
  const inAccountRestoreEgressGB = inputs.driveEgressFree ? 0 : nonNeg(inputs.restoresPerMonth) * restoreGB;
  // An offline recovery downloads the full recoverable archive, so its egress basis must be
  // the recoverable archive size for the regime in play, not the aged-down referenced-initial
  // figure A0 x (1 - c)^R. A simpler treatment of this term reduces to A0 (= S x d), which
  // understates it badly because it ignores every byte of churn accrued since the first seal,
  // and is doubly wrong in the accumulate regime where nothing has been garbage-collected.
  // We implement the more correct regime-aware version, using the SAME time point as the
  // storage average (the month midpoint for accumulate, the steady state for retained) so that
  // both components of the bill are computed on a consistent archive-size basis within a single
  // monthlyCost call. The retained regime at its steady state is already independent of month,
  // so the midpoint and end-of-month both yield the same value there; for accumulate the
  // midpoint avoids overstating the egress relative to the averaged storage. When retention is
  // "keep everything" (R = 0) the retained regime degenerates to accumulate, so both bases
  // coincide. This basis is at least A0 (the spec's literal minimum) and grows correctly.
  const offlineArchiveBytes =
    opts.regime === "accumulate" || retainedDegenerates
      ? storedBytesAccumulate(inputs, midpoint)
      : storedBytesRetained(inputs, month);
  const offlineArchiveGB = offlineArchiveBytes / BYTES_PER_GB;
  const offlineEgressGB = nonNeg(inputs.offlineRecoveriesPerMonth) * offlineArchiveGB;
  // When the operator does mark restores as out-of-account downloads even with driveEgressFree
  // off-account, the restoreGB term above already covers it; offline recoveries are the
  // explicit out-of-account path and always count.
  const egress = (inAccountRestoreEgressGB + offlineEgressGB) * p.egressPerGB;

  const total = storage + writes + reads + egress;
  return { storage, writes, reads, egress, total, averageStoredBytes: avgBytes, objectsWrittenPerMonth };
}

// initialWriteCost returns the one-off cost of the FIRST full seal of A0: the initial
// object count over a million, priced at Class A. spec section 2.2 one-off. An estimate.
export function initialWriteCost(inputs: Inputs, pricing: Pricing): number {
  const p = sanitisePricing(pricing);
  return (initialObjects(inputs) / OBJECTS_PER_MILLION) * p.classAPerMillion;
}

// ---------------------------------------------------------------------------
// Projection over months
// ---------------------------------------------------------------------------

// ProjectionPoint is one row of the projection table for one regime at one month:
// the cumulative stored bytes at that month and the cumulative cost to that month
// (the sum of each month's monthlyCost from month 1 to this month). Every figure an estimate.
export interface ProjectionPoint {
  month: number;
  storedBytes: number;
  cumulativeCost: number;
}

// RegimeProjection is the per-regime projection: the requested points plus the one-off
// initial seal cost (charged once, at the start, and included in every cumulativeCost).
export interface RegimeProjection {
  initialCost: number;
  points: ProjectionPoint[];
}

// Projection holds both regimes side by side, as the screen renders them.
export interface Projection {
  accumulate: RegimeProjection;
  retained: RegimeProjection;
}

// ProjectOptions carries the read/restore assumptions through to each month's monthlyCost
// (same meaning as on MonthlyCostOptions). The regime and month are set per point internally.
export type ProjectOptions = Omit<MonthlyCostOptions, "regime" | "month">;

// project returns BOTH regimes (accumulate and retained-with-GC) over the given month
// markers (for example [1, 3, 6, 12]). For each regime and each marker it reports the
// cumulative stored bytes at that month and the cumulative cost up to and including that
// month, computed by summing each integer month's monthlyCost from month 1 to the marker
// plus the one-off initial seal cost. Months are sorted ascending and de-duplicated; a
// fractional marker is honoured for the stored-size reading and its cumulative cost sums
// the whole months up to floor(marker) plus a pro-rata part-month. This is the deterministic
// projection behind the screen's table and sparkline. Every figure is an estimate.
export function project(inputs: Inputs, pricing: Pricing, months: number[], opts: ProjectOptions = {}): Projection {
  const markers = dedupeSortedAsc(months.map((m) => nonNeg(m)));
  return {
    accumulate: projectRegime(inputs, pricing, markers, "accumulate", opts),
    retained: projectRegime(inputs, pricing, markers, "retained", opts),
  };
}

function projectRegime(inputs: Inputs, pricing: Pricing, markers: number[], regime: Regime, opts: ProjectOptions): RegimeProjection {
  const initialCost = initialWriteCost(inputs, pricing);
  const maxMarker = markers.length === 0 ? 0 : (markers[markers.length - 1] ?? 0);

  // Pre-compute the cumulative monthly cost at each integer month up to the largest marker,
  // so a marker's cumulative cost is a lookup plus a part-month. monthlyCost at integer
  // month k charges for the month ending at k.
  const wholeMonths = Math.floor(maxMarker);
  const cumAtMonth: number[] = new Array<number>(wholeMonths + 1).fill(0);
  let running = initialCost;
  for (let k = 1; k <= wholeMonths; k++) {
    running += monthlyCost(inputs, pricing, withRegime(regime, k, opts)).total;
    cumAtMonth[k] = running;
  }

  const points: ProjectionPoint[] = markers.map((m) => {
    const whole = Math.floor(m);
    const frac = m - whole;
    const base = whole === 0 ? initialCost : (cumAtMonth[whole] ?? initialCost);
    // Pro-rata the part-month at the cost of the next month boundary.
    const partMonth = frac > 0 ? monthlyCost(inputs, pricing, withRegime(regime, whole + 1, opts)).total * frac : 0;
    const cumulativeCost = base + partMonth;
    const storedBytes = regime === "accumulate" ? storedBytesAccumulate(inputs, m) : storedBytesRetained(inputs, m);
    return { month: m, storedBytes, cumulativeCost };
  });

  return { initialCost, points };
}

// withRegime builds a MonthlyCostOptions for projectRegime (and the derived views in
// cost-model-views.ts), spreading the optional read/restore fields conditionally so an
// absent field is never assigned undefined (exactOptionalPropertyTypes).
export function withRegime(regime: Regime, month: number, opts: ProjectOptions): MonthlyCostOptions {
  return {
    regime,
    month,
    ...(opts.objectsReadPerDrill !== undefined ? { objectsReadPerDrill: opts.objectsReadPerDrill } : {}),
    ...(opts.objectsReadPerRestore !== undefined ? { objectsReadPerRestore: opts.objectsReadPerRestore } : {}),
    ...(opts.restoreGBPerRestore !== undefined ? { restoreGBPerRestore: opts.restoreGBPerRestore } : {}),
  };
}
