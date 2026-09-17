// Pure, dependency-free, deterministic cost ESTIMATION library for the downpipes
// console: the throughput-based storage cost model (the maths behind the pinned spec,
// corrected to the engine's REAL growth behaviour; see GrowthModel).
//
// EVERY figure this module returns is an ESTIMATE, not a quote or a guarantee.
//
// HONEST GROWTH (the load-bearing correction): the live engine's content-address key
// derives from the PER-RUN master key, so dedup applies only WITHIN a run; every run
// stores a FULL snapshot of the source. Storage therefore grows as runs per period
// times archive bytes per run, NOT with churn. That per-run snapshot model is the
// DEFAULT here ("snapshot"). The spec's churn-driven model (a run stores only new or
// changed content because content addressing dedups ACROSS runs) is retained as the
// clearly-labelled "churn-dedup" growth model: a stable addressing key is a recorded
// SPEC-level decision, NOT current behaviour, so that projection applies only once
// cross-run dedup ships. The maths is applied to names, counts, sizes and the
// operator's own pricing inputs.
//
// This is the library's public barrel. The definitions live in three cohesive siblings,
// kept under 500 lines each and re-exported verbatim here so every caller keeps importing
// by name from "lib/cost-model.ts" unchanged:
//   - cost-model-rates.ts: constants, pricing, model inputs, cadence/retention-window
//     conversions and the numeric guards (the base layer);
//   - cost-model-estimate.ts: the estimation engine (derived quantities, the storage-over-time
//     regimes, the cost breakdown and the multi-month projection), built on the base layer;
//   - cost-model-views.ts: the derived views (the marginal/one-off costs and the sensitivity
//     sweeps), built on the estimation engine.
// The barrel re-exports only the surface the library has always exposed; the internal numeric
// guards stay internal to the rates module and withRegime stays internal to the engine.
//
// This library is PURE and DETERMINISTIC by contract:
//   - no DOM access, no engine import, no network;
//   - no wall-clock (Date.now / performance.now) and no randomness (Math.random /
//     crypto) APIs, so the same inputs always give the same outputs and the library is
//     trivially unit-testable.
// It transmits nothing. Nothing here is a no-custody concern: it never touches a key,
// a secret, or archive content, only sizes and counts.
//
// House rules followed: Australian English; precise claims (an estimate is an estimate);
// custom domains only (no vendor URLs appear here at all). exactOptionalPropertyTypes is
// ON, so optional fields are added via conditional spreads and are never assigned
// undefined; noUncheckedIndexedAccess is satisfied by guarding every indexed read.

// --- Rates, inputs and base maths (cost-model-rates.ts) -----------------------

export {
  BYTES_PER_GB,
  CADENCE_SECONDS,
  cadenceSecondsToRunsPerMonth,
  cadenceToRunsPerMonth,
  DAYS_PER_MONTH,
  DEFAULT_DEDUP_RATIO,
  DEFAULT_INPUTS,
  DEFAULT_MANIFEST_OBJECTS,
  DEFAULT_OVERHEAD_BYTES,
  DEFAULT_SEG_BYTES,
  PRESETS,
  retentionWindowToRuns,
  withDefaults,
} from "./cost-model-rates.ts";
export type { Cadence, GrowthModel, Inputs, Pricing, PresetId } from "./cost-model-rates.ts";

// --- The estimation engine (cost-model-estimate.ts) ---------------------------

export {
  churnStoredBytes,
  initialObjects,
  initialWriteCost,
  monthlyCost,
  newObjectsPerRun,
  objectsForBytes,
  perRunStoredBytes,
  project,
  referencedInitialBytes,
  storedBytesAccumulate,
  storedBytesRetained,
  storedSize,
} from "./cost-model-estimate.ts";
// MonthlyCostOptions/ProjectionPoint/ProjectOptions/Regime were re-exported here too, but nothing
// imports them through this barrel path (callers use cost-model-estimate.ts directly), so knip's
// dead-export sweep removed them.
export type {
  CostBreakdown,
  Projection,
  RegimeProjection,
} from "./cost-model-estimate.ts";

// --- The derived views (cost-model-views.ts) ----------------------------------

export { costOfRetention, drillCostOnce, perRunCost, restoreCostOnce, sensitivity } from "./cost-model-views.ts";
// DrillCostOptions/RestoreCostOptions/SensitivityAxis/SensitivityOptions were re-exported here too,
// but nothing imports them through this barrel path (callers use cost-model-views.ts directly), so
// knip's dead-export sweep removed them.
export type { SensitivityPoint } from "./cost-model-views.ts";

// --- The Cloudflare-platform and capacity ledger (cost-model-platform.ts) ------
// The "cost to RUN the backup" (Workers/DO/D1/KV/R2 operations in the customer's own account),
// the capacity/feasibility view, the multi-destination storage rollup, and the combined recurring
// estimate that joins both ledgers with the plan base and the wiggle-room safety margin. Free-tier
// allowances are NOT assumed (paid rates by default); the estimate errs high to avoid bill shock.

export {
  addUsage,
  applySafetyMargin,
  capacity,
  /** @knipignore Cost-model API constant for the optional Cloudflare-source-of-truth path; part of the module surface. */
  CF_INCLUDED,
  CF_RATES,
  clampMargin,
  estimateRunUsage,
  /** @knipignore Cost-model API helper (byte to GB display); part of the module surface. */
  gbMonth,
  PER_RUN_OVERHEAD,
  platformCost,
  recurringEstimate,
  replicationCost,
  rollupStorage,
  SAFETY_MARGIN_DEFAULT,
  SAFETY_MARGIN_SLIDER_MAX,
  SAFETY_MARGIN_SLIDER_STEP,
  scaleUsage,
  usageFromOpCounts,
  usageWithDefaults,
  WORKERS_PAID_BASE_USD,
} from "./cost-model-platform.ts";
// Archetype/CloudflareRates/PlatformBreakdown/PlatformCostOptions/RecurringEstimateOptions/
// ResourceUsage/RunObservation/SourceCostProfile/SourceType were re-exported here too, but nothing
// imports them through this barrel path (callers use cost-model-platform.ts directly), so knip's
// dead-export sweep removed them.
export type {
  CapacityEstimate,
  OpCountsLike,
  RecurringEstimate,
} from "./cost-model-platform.ts";
