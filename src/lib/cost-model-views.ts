// The derived cost views of the downpipes cost ESTIMATION library: the marginal and
// one-off views (per-run cost, single restore, single drill, the saving from retention)
// and the sensitivity sweeps. These build on the estimation engine (cost-model-estimate.ts)
// and the base layer (cost-model-rates.ts); cost-model.ts re-exports them as one library.
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
  monthlyCost,
  newObjectsPerRun,
  objectsForBytes,
  type ProjectOptions,
  perRunStoredBytes,
  type Regime,
  storedSize,
  withRegime,
} from "./cost-model-estimate.ts";
import { BYTES_PER_GB, CADENCE_RUNS_PER_MONTH, clamp01, dedupeSortedAsc, type Inputs, nonNeg, OBJECTS_PER_MILLION, type Pricing, sanitisePricing } from "./cost-model-rates.ts";

// ---------------------------------------------------------------------------
// Marginal and one-off views
// ---------------------------------------------------------------------------

// perRunCost is the MARGINAL cost of one additional run: that run's new stored bytes priced
// for a single month (storage amortised over one month) plus that run's write operations.
// perRun ~= (perRunGB x P_store, one month) + (newObjects / 1e6 x P_classA), where the per-run
// bytes honour the growth model (the full snapshot under the default; the churn delta under
// churn-dedup). An estimate.
export function perRunCost(inputs: Inputs, pricing: Pricing): number {
  const p = sanitisePricing(pricing);
  const perRunGB = perRunStoredBytes(inputs) / BYTES_PER_GB;
  const storageShare = perRunGB * p.storagePerGBMonth; // one month's storage for this run's bytes
  const writeShare = (newObjectsPerRun(inputs) / OBJECTS_PER_MILLION) * p.classAPerMillion;
  return storageShare + writeShare;
}

// RestoreCostOptions describes a single restore for restoreCostOnce. objectsRead defaults
// to the whole recoverable archive object count (a full restore); downloaded marks whether
// the restored data leaves the account (true => egress on restoreGB, default the whole
// recoverable archive GB); an in-account restore (downloaded false) incurs reads only.
export interface RestoreCostOptions {
  objectsRead?: number;
  downloaded?: boolean;
  restoreGB?: number;
}

// restoreCostOnce returns the estimated cost of a SINGLE restore: the read operations
// (Class B) plus egress on the downloaded GB when the restore leaves the account.
// restoreCostOnce = (objectsReadPerRestore / 1e6 x P_classB) + (restoreGB x P_egress if downloaded).
// The default read and download basis is the whole recoverable archive A0 (= S x d), not the
// aged-down referenced-initial figure A0 x (1 - c)^R: a restore recovers the whole archive,
// so basing it on the surviving share of the ORIGINAL content alone would understate it (the
// same root cause as the offline-recovery egress basis in monthlyCost). This one-off view has
// no regime or month, so A0 is the finite, full-archive basis; the operator can
// override objectsRead and restoreGB for a partial restore.
export function restoreCostOnce(inputs: Inputs, pricing: Pricing, opts: RestoreCostOptions = {}): number {
  const p = sanitisePricing(pricing);
  const a0Bytes = storedSize(inputs.sourceBytes, inputs.dedupRatio);
  const objects = nonNeg(opts.objectsRead ?? objectsForBytes(a0Bytes, inputs.segBytes));
  const reads = (objects / OBJECTS_PER_MILLION) * p.classBPerMillion;
  const downloaded = opts.downloaded ?? false;
  const restoreGB = nonNeg(opts.restoreGB ?? a0Bytes / BYTES_PER_GB);
  const egress = downloaded ? restoreGB * p.egressPerGB : 0;
  return reads + egress;
}

// DrillCostOptions describes a single drill for drillCostOnce. objectsRead defaults to the
// whole recoverable archive object count (a full-archive drill). A drill is in-account, so
// it incurs read operations only and never egress.
export interface DrillCostOptions {
  objectsRead?: number;
}

// drillCostOnce returns the estimated cost of a SINGLE integrity drill: read operations
// only (Class B), no egress. drillCostOnce = (objectsReadPerDrill / 1e6 x P_classB).
// The default read basis is the whole recoverable archive A0 (= S x d), not the aged-down
// referenced-initial figure A0 x (1 - c)^R: a full-archive drill reads the whole archive, so
// basing it on the surviving share of the ORIGINAL content alone would understate it (the same
// root cause as the offline-recovery egress basis in monthlyCost). The operator can override
// objectsRead for a partial drill.
export function drillCostOnce(inputs: Inputs, pricing: Pricing, opts: DrillCostOptions = {}): number {
  const p = sanitisePricing(pricing);
  const a0Bytes = storedSize(inputs.sourceBytes, inputs.dedupRatio);
  const objects = nonNeg(opts.objectsRead ?? objectsForBytes(a0Bytes, inputs.segBytes));
  return (objects / OBJECTS_PER_MILLION) * p.classBPerMillion;
}

// costOfRetention returns the estimated monthly saving of keeping R runs (retained-with-GC)
// versus keeping everything (accumulate) at a chosen month: monthlyCost(accumulate at m)
// minus monthlyCost(retained at R). Clamped at 0: a saving is never negative (if the
// retained cost exceeds the accumulate cost at an early month before GC has had anything to
// prune, the "saving" is zero, not a negative number that would be confusing to display).
export function costOfRetention(inputs: Inputs, pricing: Pricing, month: number, opts: ProjectOptions = {}): number {
  const acc = monthlyCost(inputs, pricing, withRegime("accumulate", nonNeg(month), opts)).total;
  const ret = monthlyCost(inputs, pricing, withRegime("retained", nonNeg(month), opts)).total;
  return Math.max(0, acc - ret);
}

// ---------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------

// SensitivityAxis is the input the screen sweeps to show how the monthly estimate moves.
export type SensitivityAxis = "churn" | "retention" | "cadence";

// SensitivityPoint is one sample on a sensitivity sweep: the axis value, the resulting
// monthly cost, and the signed delta from the baseline (the operator's current inputs).
export interface SensitivityPoint {
  value: number;
  monthlyCost: number;
  deltaFromBaseline: number;
}

// SensitivityOptions selects the regime and month the sweep is evaluated at (default month
// 12; default regime accumulate EXCEPT for the retention axis, which is always evaluated in
// the retained regime, see sensitivity) and supplies the sweep values for the axis. When
// values are omitted, sensible defaults are used: churn sweeps low/expected/high around the
// baseline (0.5x, 1x, 2x of the baseline churn, each clamped to [0, 1]); retention sweeps a
// few run depths; cadence sweeps the standard cadences (as runs-per-month).
export interface SensitivityOptions {
  regime?: Regime;
  month?: number;
  values?: number[];
}

// effectiveSensitivityRegime resolves the regime a sweep is actually evaluated in. The
// retention axis is ALWAYS the retained regime: retentionRuns moves the footprint (and so
// the cost) only under retention GC; in the accumulate regime monthlyCost is provably
// invariant in retentionRuns (storage, writes, reads and egress never read it), so an
// accumulate retention sweep is definitionally a no-op and would report a zero delta at
// every depth. Forcing retained here means the screen sees a real, moving sweep regardless
// of whether the caller passed a regime, and keeps this axis honest at the library level
// (it cannot be defeated by a caller that omits, or wrongly sets, the regime). Every other
// axis honours the caller's regime, defaulting to accumulate.
function effectiveSensitivityRegime(axis: SensitivityAxis, opts: SensitivityOptions): Regime {
  if (axis === "retention") return "retained";
  return opts.regime ?? "accumulate";
}

// sensitivity sweeps one axis and returns the monthly cost at each swept value with its
// delta from the baseline (the operator's current inputs): churn, retention depth, cadence. The baseline and every swept point are
// evaluated in the SAME effective regime so the delta is meaningful; the retention axis is
// always evaluated in the retained regime (see effectiveSensitivityRegime). The CHURN axis is
// honest about the growth model: under the default per-run snapshot model monthlyCost is
// invariant in churn (every run stores a full snapshot), so the churn sweep is genuinely flat
// (all deltas zero); it moves only under the churn-dedup model. The screen states that rather
// than hiding it. Deterministic and pure: for a given inputs/pricing/axis/options it always
// returns the same series. Each monthlyCost is an estimate.
export function sensitivity(inputs: Inputs, pricing: Pricing, axis: SensitivityAxis, opts: SensitivityOptions = {}): SensitivityPoint[] {
  const regime: Regime = effectiveSensitivityRegime(axis, opts);
  const month = nonNeg(opts.month ?? 12);
  const baseline = monthlyCost(inputs, pricing, withRegime(regime, month, {})).total;
  const values = dedupeSortedAsc((opts.values ?? defaultSensitivityValues(axis, inputs)).map((v) => nonNeg(v)));
  return values.map((value) => {
    const swept = applyAxis(inputs, axis, value);
    const mc = monthlyCost(swept, pricing, withRegime(regime, month, {})).total;
    return { value, monthlyCost: mc, deltaFromBaseline: mc - baseline };
  });
}

// applyAxis returns a copy of inputs with the swept axis set to value (clamped to the
// field's valid range). Pure; the argument is not mutated.
function applyAxis(inputs: Inputs, axis: SensitivityAxis, value: number): Inputs {
  switch (axis) {
    case "churn":
      return { ...inputs, churnFraction: clamp01(value) };
    case "retention":
      return { ...inputs, retentionRuns: nonNeg(value) };
    case "cadence":
      return { ...inputs, runsPerMonth: nonNeg(value) };
  }
}

// defaultSensitivityValues supplies the default sweep for an axis when the caller gives none.
function defaultSensitivityValues(axis: SensitivityAxis, inputs: Inputs): number[] {
  switch (axis) {
    case "churn": {
      // low / expected / high around the baseline churn (clamped to [0, 1]).
      const base = clamp01(inputs.churnFraction);
      return [clamp01(base * 0.5), base, clamp01(Math.min(1, base * 2))];
    }
    case "retention":
      // a spread of retention depths in runs.
      return [7, 30, 90, 365];
    case "cadence":
      // the standard cadences expressed as runs per month.
      return [CADENCE_RUNS_PER_MONTH.weekly, CADENCE_RUNS_PER_MONTH.daily, CADENCE_RUNS_PER_MONTH.every6h, CADENCE_RUNS_PER_MONTH.hourly, CADENCE_RUNS_PER_MONTH.every15min];
  }
}
