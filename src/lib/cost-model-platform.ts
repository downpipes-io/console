// The Cloudflare-resource (platform) and capacity layer of the downpipes cost ESTIMATION
// library, plus the combined recurring estimate that joins it to the destination-storage
// engine in cost-model-estimate.ts. This answers "what does it cost to RUN the backup"
// (Workers, Durable Objects, D1, KV and R2 operations in the customer's own account), as
// distinct from "what does it cost to STORE" (the destination bill, cost-model-estimate.ts).
// cost-model.ts re-exports this as part of the one library.
//
// EVERY figure this module returns is an ESTIMATE, not a quote or a guarantee.
//
// THREE DELIBERATE STANCES:
//   1. Over-estimate, never under. Free-tier allowances are NOT assumed: the customer's other
//      workloads may already have spent them, so usage is priced at the PAID rate by default.
//      The optional `remaining` allowance (a Cloudflare-source-of-truth reading) nets off only
//      the headroom Cloudflare confirms is still free, which only ever lowers the figure.
//   2. A customer-tunable safety margin (the wiggle-room slider) pads the headline; the customer
//      raises it for comfort and lowers it as their real bill comes in.
//   3. No-custody is inherent: everything runs in the customer's own account. This module is
//      still pure (no DOM, no network, no wall-clock, no randomness) and touches only counts.
//
// House rules: Australian English; precise claims (an estimate is an estimate); no vendor URLs;
// exactOptionalPropertyTypes is ON (optional fields via conditional spreads, never assigned
// undefined); noUncheckedIndexedAccess is satisfied by guarding every indexed read.

import { BYTES_PER_GB, type Inputs, nonNeg, OBJECTS_PER_MILLION, type Pricing, sanitisePricing } from "./cost-model-rates.ts";
import { type CostBreakdown, monthlyCost, type MonthlyCostOptions, newObjectsPerRun, perRunStoredBytes } from "./cost-model-estimate.ts";
// ResourceUsage and its arithmetic helpers live in a sibling module (length). Re-exported below
// so the public surface of this module is unchanged for importers.
import {
  addUsage,
  type ResourceUsage,
  scaleUsage,
  usageWithDefaults,
  ZERO_USAGE,
} from "./cost-model-usage.ts";

export { addUsage, type ResourceUsage, scaleUsage, usageWithDefaults, ZERO_USAGE };

// ---------------------------------------------------------------------------
// Cloudflare resource rates (the paid-rate table)
// ---------------------------------------------------------------------------

// WORKERS_PAID_BASE_USD is the flat monthly base of the Workers Paid plan the engine needs to
// run. It dominates the bill for small backups, so the estimate states it explicitly.
export const WORKERS_PAID_BASE_USD = 5;

// SAFETY_MARGIN_DEFAULT is the wiggle-room slider's default padding (20 per cent). The customer
// tunes it; it only ever raises the estimate, never lowers a real cost.
export const SAFETY_MARGIN_DEFAULT = 0.2;

// CF_API_RATE_LIMIT_PER_SECOND is the indicative Cloudflare control-plane API limit (about
// 1200 requests per 5 minutes per account = 4 per second). Used by the capacity ledger to turn
// a config backup's API-call count into a wall-clock floor. Verify against your account's limit.
export const CF_API_RATE_LIMIT_PER_SECOND = 1200 / 300;

// PER_INVOCATION_SUBREQUEST_BUDGET is the engine's per-invocation subrequest budget (the seal
// slices yield before the platform's per-invocation cap). Used to estimate invocation count.
export const PER_INVOCATION_SUBREQUEST_BUDGET = 700;

// CloudflareRates is the per-unit PAID price of each Cloudflare resource the backup consumes,
// on the Workers Paid plan. INDICATIVE public list pricing: verify against current Cloudflare
// pricing before relying on it. The per-million fields are priced as count / 1e6 x rate.
export interface CloudflareRates {
  planBasePerMonth: number;
  workerRequestsPerMillion: number;
  workerCpuPerMillionMs: number;
  doRequestsPerMillion: number;
  doDurationPerMillionGbS: number;
  d1RowsReadPerMillion: number;
  d1RowsWrittenPerMillion: number;
  r2ClassAPerMillion: number;
  r2ClassBPerMillion: number;
  kvReadsPerMillion: number;
  kvWritesPerMillion: number;
}

// CF_RATES is the indicative paid-rate table. NOT a
// quote; verify against current Cloudflare pricing. The destination R2/S3 STORAGE rate is NOT
// here: storage is the destination bill (Pricing, cost-model-rates.ts), priced separately.
export const CF_RATES: Readonly<CloudflareRates> = {
  planBasePerMonth: WORKERS_PAID_BASE_USD,
  workerRequestsPerMillion: 0.3,
  workerCpuPerMillionMs: 0.02,
  doRequestsPerMillion: 0.15,
  doDurationPerMillionGbS: 12.5,
  d1RowsReadPerMillion: 0.001,
  d1RowsWrittenPerMillion: 1.0,
  r2ClassAPerMillion: 4.5,
  r2ClassBPerMillion: 0.36,
  kvReadsPerMillion: 0.5,
  kvWritesPerMillion: 5.0,
};

// CF_INCLUDED is the Workers Paid monthly included allowance per resource. It is used ONLY by
// the optional Cloudflare-source-of-truth path (pass the REMAINING headroom as `remaining` to
// platformCost); the default estimate never subtracts it, because the allowance may already be
// spent by the customer's other workloads. Indicative; verify against current Cloudflare terms.
/** @knipignore Cost-model API constant for the optional Cloudflare-source-of-truth path; part of the module surface. */
export const CF_INCLUDED: Readonly<ResourceUsage> = {
  workerRequests: 10_000_000,
  workerCpuMs: 30_000_000,
  doRequests: 1_000_000,
  doDurationGbS: 400_000,
  d1RowsRead: 25_000_000_000,
  d1RowsWritten: 50_000_000,
  r2ClassA: 1_000_000,
  r2ClassB: 10_000_000,
  kvReads: 10_000_000,
  kvWrites: 1_000_000,
};

// ---------------------------------------------------------------------------
// Source cost profiles (the per-source-type op shape; scales to the CF surface)
// ---------------------------------------------------------------------------

// SourceType is the engine's data-plane source union (engine/src/sources/types.ts). The cost
// model keys an op profile off it; adding a source means adding one profile entry, never
// rewriting the maths, so this scales to the wider Cloudflare product surface.
export type SourceType = "kv" | "r2" | "d1" | "secrets" | "cf-config" | "workers" | "stream" | "images" | "artifacts";

// Archetype is the cost shape a source falls into: the
// five shapes the 96-product surface collapses to. Only the four backup-relevant shapes appear
// here; non-goal products are never backed up, so they have no profile.
export type Archetype = "bulk-datastore" | "media-blob" | "config-surface" | "identity-inventory";

// BilledReadResource names which billed Cloudflare resource a source's per-record READ consumes,
// or "none" for a source whose read is a control-plane API call (counted as capacity, not
// dollars). Writes are universal: every source writes its archive segments as R2 Class A PUTs.
type BilledReadResource = "kvReads" | "r2ClassB" | "d1RowsRead" | "none";

// SourceCostProfile is the cost descriptor for one source type. readResource/readsPerRecord give
// the billed read ops a record costs; apiReadsPerRecord is the control-plane API calls a record
// costs (capacity, not dollars). The universal write (R2 Class A per archive segment) is added
// by estimateRunUsage from the observed segment count, not encoded here.
export interface SourceCostProfile {
  archetype: Archetype;
  readResource: BilledReadResource;
  readsPerRecord: number;
  apiReadsPerRecord: number;
}

// SOURCE_COST_PROFILES maps each current source type to its cost profile. Bulk datastores read
// billed data ops per record (a KV get, an R2 get, D1 rows); config/identity/secret sources read
// the Cloudflare control-plane API, which is rate-limited (capacity) rather than billed per call.
export const SOURCE_COST_PROFILES: Readonly<Record<SourceType, Readonly<SourceCostProfile>>> = {
  kv: { archetype: "bulk-datastore", readResource: "kvReads", readsPerRecord: 1, apiReadsPerRecord: 0 },
  r2: { archetype: "bulk-datastore", readResource: "r2ClassB", readsPerRecord: 1, apiReadsPerRecord: 0 },
  // d1 reads rows, not records; recordCount under-counts rows, so this is a known lower bound
  // until the engine meter reports real D1 rows read (design Phase 3).
  d1: { archetype: "bulk-datastore", readResource: "d1RowsRead", readsPerRecord: 1, apiReadsPerRecord: 0 },
  // secrets are read from the secret store (not a billed data op) and captured value-free.
  secrets: { archetype: "identity-inventory", readResource: "none", readsPerRecord: 0, apiReadsPerRecord: 1 },
  // cf-config and workers read the control-plane API: capacity, not dollars.
  "cf-config": { archetype: "config-surface", readResource: "none", readsPerRecord: 0, apiReadsPerRecord: 1 },
  workers: { archetype: "config-surface", readResource: "none", readsPerRecord: 0, apiReadsPerRecord: 1 },
  // stream reads the control-plane API for the video INVENTORY (metadata, one record per video); the
  // video binaries are out of v1 scope, so like cf-config/workers it is capacity, not billed data ops.
  stream: { archetype: "config-surface", readResource: "none", readsPerRecord: 0, apiReadsPerRecord: 1 },
  // images reads the control-plane API for the image INVENTORY (metadata, one record per image); the
  // image binaries are out of v1 scope, so like stream it is capacity, not billed data ops.
  images: { archetype: "config-surface", readResource: "none", readsPerRecord: 0, apiReadsPerRecord: 1 },
  // artifacts reads the control-plane API for the namespace/repo INVENTORY; repo contents are out of v1
  // scope, so like stream/images it is capacity, not billed data ops.
  artifacts: { archetype: "config-surface", readResource: "none", readsPerRecord: 0, apiReadsPerRecord: 1 },
};

// profileFor returns a source type's profile, or a conservative config-surface default for an
// unknown type (satisfies noUncheckedIndexedAccess and degrades safely as new sources appear).
export function profileFor(sourceType: string): SourceCostProfile {
  const p = (SOURCE_COST_PROFILES as Record<string, SourceCostProfile | undefined>)[sourceType];
  return p ?? { archetype: "config-surface", readResource: "none", readsPerRecord: 0, apiReadsPerRecord: 1 };
}

// PER_RUN_OVERHEAD is the small fixed Cloudflare cost of running ONE backup, independent of the
// source: the scheduler and seal Durable Object requests and duration, the runlog D1 writes, and
// the Worker invocations. A labelled ESTIMATE (the engine meter will report exact counts, design
// Phase 3); deliberately generous, per the over-estimate stance.
export const PER_RUN_OVERHEAD: Readonly<ResourceUsage> = {
  workerRequests: 50,
  workerCpuMs: 2000,
  doRequests: 200,
  doDurationGbS: 5,
  d1RowsRead: 50,
  d1RowsWritten: 20,
  r2ClassA: 0,
  r2ClassB: 0,
  kvReads: 0,
  kvWrites: 0,
};

// RunObservation is what a single completed run reports today (engine RunHistoryEntry): the
// record count and the archive objects written. recordCount drives the read ops; segmentsWritten
// is the real R2 Class A write count after packing.
export interface RunObservation {
  sourceType: string;
  recordCount: number;
  segmentsWritten: number;
}

// estimateRunUsage estimates the Cloudflare resource usage of ONE run from what a run reports
// today, using the source's cost profile plus the fixed per-run overhead. The two dominant,
// defensible terms are the billed reads (recordCount mapped to the source's read resource) and
// the writes (segmentsWritten as R2 Class A PUTs); the overhead is a labelled constant. This is
// the bridge until the engine meter persists exact per-resource counts (design Phase 3).
export function estimateRunUsage(obs: RunObservation): ResourceUsage {
  const profile = profileFor(obs.sourceType);
  const records = nonNeg(obs.recordCount);
  const reads = records * nonNeg(profile.readsPerRecord);
  const readPart: Partial<ResourceUsage> = profile.readResource === "none" ? {} : { [profile.readResource]: reads };
  // Every source writes its archive segments as R2 Class A PUTs (the real, post-packing count).
  const writePart: Partial<ResourceUsage> = { r2ClassA: nonNeg(obs.segmentsWritten) };
  return addUsage(PER_RUN_OVERHEAD, usageWithDefaults({ ...readPart, ...writePart }));
}

// OpCountsLike is the engine's per-run metered-operation tally (engine OpCounts / wire RunOpCounts), taken
// structurally so this pure library does not import a wire type. Every field is optional and defaulted.
export interface OpCountsLike {
  kvRead?: number;
  kvList?: number;
  r2ClassA?: number;
  r2ClassB?: number;
  d1Read?: number;
  cfApiRead?: number;
  secretsRead?: number;
  subrequests?: number;
}

// usageFromOpCounts maps an EXACT engine op tally to the priced ResourceUsage: this is the precise
// "cost to run the backup" data ops, no longer an estimate. KV lists are priced with KV reads; D1 read
// queries approximate D1 rows read (a lower bound until the engine meters rows); cf-api and secrets reads
// are control-plane (rate-limited capacity, not billed per call), so they do not enter the dollar usage.
// Worker requests, CPU and Durable Object duration are not subrequests and so are not in opCounts; the
// caller adds the per-run compute overhead (PER_RUN_OVERHEAD) for those.
export function usageFromOpCounts(op: OpCountsLike): ResourceUsage {
  return usageWithDefaults({
    kvReads: nonNeg(op.kvRead ?? 0) + nonNeg(op.kvList ?? 0),
    r2ClassA: nonNeg(op.r2ClassA ?? 0),
    r2ClassB: nonNeg(op.r2ClassB ?? 0),
    d1RowsRead: nonNeg(op.d1Read ?? 0),
  });
}

// ---------------------------------------------------------------------------
// The platform-cost ledger (Cloudflare resources, paid rates)
// ---------------------------------------------------------------------------

// PlatformBreakdown is the per-resource dollar cost of running the backup over a period, plus the
// total. It does NOT include the plan base (added once by recurringEstimate). Every figure an
// estimate. billableUsage is the usage actually priced (after netting off any confirmed
// remaining allowance), exposed so the screen can show the basis.
export interface PlatformBreakdown {
  workerRequests: number;
  workerCpu: number;
  doRequests: number;
  doDuration: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  r2ClassA: number;
  r2ClassB: number;
  kvReads: number;
  kvWrites: number;
  total: number;
  billableUsage: ResourceUsage;
}

// PlatformCostOptions carries the optional Cloudflare-source-of-truth headroom. `remaining` is
// the allowance Cloudflare reports is STILL FREE this month for each resource; when given, it is
// netted off before pricing (billable = max(0, usage - remaining)). Omitted by default, so the
// default estimate prices the FULL usage at paid rates and never assumes a free tier.
export interface PlatformCostOptions {
  remaining?: Partial<ResourceUsage>;
}

// platformCost prices a month's Cloudflare resource usage at the paid rate table. By default it
// assumes NO free-tier headroom (the over-estimate, bill-shock-safe stance); pass opts.remaining
// (a Cloudflare-confirmed reading) to net off only the allowance that genuinely remains.
// `usage` is a Partial, matching what this function already does with it: the first thing it does is
// hand it to usageWithDefaults, which fills every missing field with zero, and `remaining` beside it
// has always been declared Partial for the same reason. Requiring all fourteen fields of a caller
// that only cares about two said the opposite of what the body does. Widening an input breaks no
// existing caller, since a full ResourceUsage is a valid Partial.
export function platformCost(usage: Partial<ResourceUsage>, rates: CloudflareRates = CF_RATES, opts: PlatformCostOptions = {}): PlatformBreakdown {
  const u = usageWithDefaults(usage);
  const remaining = usageWithDefaults(opts.remaining ?? {});
  const billable: ResourceUsage = {
    workerRequests: Math.max(0, u.workerRequests - remaining.workerRequests),
    workerCpuMs: Math.max(0, u.workerCpuMs - remaining.workerCpuMs),
    doRequests: Math.max(0, u.doRequests - remaining.doRequests),
    doDurationGbS: Math.max(0, u.doDurationGbS - remaining.doDurationGbS),
    d1RowsRead: Math.max(0, u.d1RowsRead - remaining.d1RowsRead),
    d1RowsWritten: Math.max(0, u.d1RowsWritten - remaining.d1RowsWritten),
    r2ClassA: Math.max(0, u.r2ClassA - remaining.r2ClassA),
    r2ClassB: Math.max(0, u.r2ClassB - remaining.r2ClassB),
    kvReads: Math.max(0, u.kvReads - remaining.kvReads),
    kvWrites: Math.max(0, u.kvWrites - remaining.kvWrites),
  };
  const perMillion = (count: number, rate: number): number => (count / 1e6) * nonNeg(rate);
  const workerRequests = perMillion(billable.workerRequests, rates.workerRequestsPerMillion);
  const workerCpu = perMillion(billable.workerCpuMs, rates.workerCpuPerMillionMs);
  const doRequests = perMillion(billable.doRequests, rates.doRequestsPerMillion);
  const doDuration = perMillion(billable.doDurationGbS, rates.doDurationPerMillionGbS);
  const d1RowsRead = perMillion(billable.d1RowsRead, rates.d1RowsReadPerMillion);
  const d1RowsWritten = perMillion(billable.d1RowsWritten, rates.d1RowsWrittenPerMillion);
  const r2ClassA = perMillion(billable.r2ClassA, rates.r2ClassAPerMillion);
  const r2ClassB = perMillion(billable.r2ClassB, rates.r2ClassBPerMillion);
  const kvReads = perMillion(billable.kvReads, rates.kvReadsPerMillion);
  const kvWrites = perMillion(billable.kvWrites, rates.kvWritesPerMillion);
  const total = workerRequests + workerCpu + doRequests + doDuration + d1RowsRead + d1RowsWritten + r2ClassA + r2ClassB + kvReads + kvWrites;
  return { workerRequests, workerCpu, doRequests, doDuration, d1RowsRead, d1RowsWritten, r2ClassA, r2ClassB, kvReads, kvWrites, total, billableUsage: billable };
}

// ---------------------------------------------------------------------------
// The capacity ledger (not dollars: API rate limit, subrequests, wall-clock)
// ---------------------------------------------------------------------------

// CapacityEstimate is the feasibility view of ONE run: the control-plane API calls it makes
// (rate-limit-bound), the billed-data subrequests, the resulting Worker invocations, and the
// wall-clock floor the API rate limit imposes. At config scale this, not dollars, is the binding
// constraint. Every figure an estimate.
export interface CapacityEstimate {
  apiCalls: number;
  subrequests: number;
  invocations: number;
  apiWallclockSeconds: number;
}

// capacity estimates one run's feasibility from its record count, segment count and source
// profile. API calls are the source's control-plane reads (config/identity sources); subrequests
// are the billed-data reads plus the segment writes; invocations are the subrequests over the
// per-invocation budget; the wall-clock floor is the API calls divided by the rate limit.
export function capacity(obs: RunObservation): CapacityEstimate {
  const profile = profileFor(obs.sourceType);
  const records = nonNeg(obs.recordCount);
  const segments = nonNeg(obs.segmentsWritten);
  const apiCalls = records * nonNeg(profile.apiReadsPerRecord);
  const billedReads = profile.readResource === "none" ? 0 : records * nonNeg(profile.readsPerRecord);
  const subrequests = billedReads + segments;
  const invocations = subrequests === 0 ? 1 : Math.ceil(subrequests / PER_INVOCATION_SUBREQUEST_BUDGET);
  const apiWallclockSeconds = CF_API_RATE_LIMIT_PER_SECOND > 0 ? apiCalls / CF_API_RATE_LIMIT_PER_SECOND : 0;
  return { apiCalls, subrequests, invocations, apiWallclockSeconds };
}

// ---------------------------------------------------------------------------
// Multi-destination storage rollup (3-2-1)
// ---------------------------------------------------------------------------

// replicationCost prices the ORIGIN-SIDE cost of feeding replicas, which is the one term a
// per-destination sum structurally cannot see. The engine does not write a run N times in
// parallel: seal writes to the primary, then a separate cron pass (engine seal/replicate.ts)
// READS the run tree and the content-addressed segment store back OUT of the origin and copies
// them to each replica, deduping by exists. Summing monthlyCost per destination therefore counts
// every replica's storage and writes correctly and charges NOTHING for the reads and the egress
// that origin pays to serve them.
//
// That omission is in the expensive direction, which is the direction that damages trust: an AWS
// S3 primary with one replica really does egress every replicated byte at 0.09 USD per GB, and
// the estimator showed zero. R2 origins are unaffected because their egress rate is genuinely 0.
//
// Basis: the replicate pass copies what a run NEWLY wrote (dedup-by-exists skips what a replica
// already holds), so the per-run object and byte counts are the same ones the write term uses.
export function replicationCost(inputs: Inputs, origin: Pricing, replicaCount: number): { reads: number; egress: number } {
  const replicas = Math.max(0, Math.floor(nonNeg(replicaCount)));
  if (replicas === 0) return { reads: 0, egress: 0 };
  const p = sanitisePricing(origin);
  const runs = nonNeg(inputs.runsPerMonth);
  const copiedObjects = newObjectsPerRun(inputs) * runs * replicas;
  const copiedGB = (perRunStoredBytes(inputs) / BYTES_PER_GB) * runs * replicas;
  return {
    reads: (copiedObjects / OBJECTS_PER_MILLION) * p.classBPerMillion,
    egress: copiedGB * p.egressPerGB,
  };
}

// rollupStorage sums the destination-storage cost across every destination a source writes to
// (the 3-2-1 primary plus replicas), because each destination carries its own pricing and stores
// the same bytes, then adds the origin-side replication term above. With no pricing it returns a
// zero breakdown; with one it equals monthlyCost, because a lone destination is replicated nowhere.
export function rollupStorage(inputs: Inputs, pricings: Pricing[], opts: MonthlyCostOptions): CostBreakdown {
  if (pricings.length === 0) {
    return { storage: 0, writes: 0, reads: 0, egress: 0, total: 0, averageStoredBytes: 0, objectsWrittenPerMonth: 0 };
  }
  let acc: CostBreakdown | null = null;
  for (const pricing of pricings) {
    const b = monthlyCost(inputs, pricing, opts);
    acc =
      acc === null
        ? b
        : {
            storage: acc.storage + b.storage,
            writes: acc.writes + b.writes,
            reads: acc.reads + b.reads,
            egress: acc.egress + b.egress,
            total: acc.total + b.total,
            // The stored size and object count are per-destination identical (the same bytes are
            // written to each), so report the single-destination figure, not the sum.
            averageStoredBytes: b.averageStoredBytes,
            objectsWrittenPerMonth: b.objectsWrittenPerMonth,
          };
  }
  // acc is non-null here (pricings.length > 0), but guard for the type checker.
  const summed = acc ?? { storage: 0, writes: 0, reads: 0, egress: 0, total: 0, averageStoredBytes: 0, objectsWrittenPerMonth: 0 };
  // The first pricing is the origin, matching the engine's primaryDestinationId (the first
  // non-blank destination id); every other destination is fed BY it, so the replication read and
  // egress are charged against the origin's own rates, not the replica's.
  const repl = replicationCost(inputs, pricings[0]!, pricings.length - 1);
  return {
    ...summed,
    reads: summed.reads + repl.reads,
    egress: summed.egress + repl.egress,
    total: summed.total + repl.reads + repl.egress,
  };
}

// ---------------------------------------------------------------------------
// The combined recurring estimate (both ledgers + base plan + wiggle)
// ---------------------------------------------------------------------------

// RecurringEstimate is the headline: the destination-storage ledger, the Cloudflare-platform
// ledger, the plan base, their subtotal, the applied safety margin and the padded total. Every
// figure is an estimate; the total errs high by design.
export interface RecurringEstimate {
  storage: CostBreakdown;
  platform: PlatformBreakdown;
  basePlan: number;
  subtotal: number;
  safetyMargin: number;
  total: number;
}

// RecurringEstimateOptions composes the storage options (regime, month, drill/restore reads), the
// per-month Cloudflare usage, the optional Cloudflare-source-of-truth remaining allowance, the
// rate table override and the safety margin (the wiggle slider; default SAFETY_MARGIN_DEFAULT).
export interface RecurringEstimateOptions {
  monthly: MonthlyCostOptions;
  // Partial for the same reason as platformCost's own `usage`, which is exactly where this value goes.
  usagePerMonth: Partial<ResourceUsage>;
  remaining?: Partial<ResourceUsage>;
  rates?: CloudflareRates;
  safetyMargin?: number;
}

// recurringEstimate joins the two ledgers into the customer-facing monthly figure: the storage
// cost across all destinations, plus the Cloudflare resource cost at paid rates (free tier not
// assumed), plus the plan base, all padded by the wiggle-room safety margin. This is the number
// the headline shows.
export function recurringEstimate(inputs: Inputs, pricings: Pricing[], opts: RecurringEstimateOptions): RecurringEstimate {
  const rates = opts.rates ?? CF_RATES;
  const storage = rollupStorage(inputs, pricings, opts.monthly);
  const platform = platformCost(opts.usagePerMonth, rates, opts.remaining !== undefined ? { remaining: opts.remaining } : {});
  const basePlan = nonNeg(rates.planBasePerMonth);
  const subtotal = storage.total + platform.total + basePlan;
  const safetyMargin = clampMargin(opts.safetyMargin ?? SAFETY_MARGIN_DEFAULT);
  const total = subtotal * (1 + safetyMargin);
  return { storage, platform, basePlan, subtotal, safetyMargin, total };
}

// applySafetyMargin pads an amount by the wiggle-room margin (amount x (1 + margin)). The margin
// is clamped to a sane band so a stray value cannot make a cost negative or absurd.
export function applySafetyMargin(amount: number, margin: number): number {
  return nonNeg(amount) * (1 + clampMargin(margin));
}

// SAFETY_MARGIN_MAX caps the wiggle slider (200 per cent of padding is already far beyond any
// honest estimate; the cap stops a slip of the slider producing a meaningless number).
export const SAFETY_MARGIN_MAX = 2;

// SAFETY_MARGIN_SLIDER_MAX / _STEP bound the UI slider. The slider caps at 50 per cent of padding,
// deliberately lower than SAFETY_MARGIN_MAX (200 per cent): the slider is for everyday comfort, not
// for the far edge the clamp guards. A value above the slider cap can still arrive via clampMargin.
export const SAFETY_MARGIN_SLIDER_MAX = 0.5;
export const SAFETY_MARGIN_SLIDER_STEP = 0.05;

// clampMargin clamps a safety margin to [0, SAFETY_MARGIN_MAX] and coerces non-finite to 0.
export function clampMargin(margin: number): number {
  if (!Number.isFinite(margin)) return 0;
  return Math.min(SAFETY_MARGIN_MAX, Math.max(0, margin));
}

// gbMonth converts a byte count to GB for storage-rate display (decimal GB, matching pricing).
/** @knipignore Cost-model API helper (byte to GB display); part of the module surface. */
export function gbMonth(bytes: number): number {
  return nonNeg(bytes) / BYTES_PER_GB;
}
