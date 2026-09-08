// The ResourceUsage value type and its arithmetic helpers, factored out of cost-model-platform.ts
// to keep that module under length. ResourceUsage is the count of each Cloudflare resource a
// backup consumes over a period; these helpers default, sum and scale those counts. All pure
// (no DOM, no network, no wall-clock, no randomness) and touching only counts.
//
// House rules: Australian English; exactOptionalPropertyTypes is ON; noUncheckedIndexedAccess is
// satisfied by guarding every indexed read.

import { nonNeg } from "./cost-model-rates.ts";

// ResourceUsage is the count of each Cloudflare resource consumed over a period (per run, or
// per month once scaled). Engine-side storage (Durable Object and D1 runlog bytes) is omitted:
// it is negligible next to the operation and compute counts, and the destination archive bytes
// are the separate storage ledger. All counts are non-negative.
export interface ResourceUsage {
  workerRequests: number;
  workerCpuMs: number;
  doRequests: number;
  doDurationGbS: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  r2ClassA: number;
  r2ClassB: number;
  kvReads: number;
  kvWrites: number;
}

// ZERO_USAGE is the additive identity, used to seed sums and to fill omitted fields.
export const ZERO_USAGE: Readonly<ResourceUsage> = {
  workerRequests: 0,
  workerCpuMs: 0,
  doRequests: 0,
  doDurationGbS: 0,
  d1RowsRead: 0,
  d1RowsWritten: 0,
  r2ClassA: 0,
  r2ClassB: 0,
  kvReads: 0,
  kvWrites: 0,
};

// usageWithDefaults fills any omitted field from ZERO_USAGE and coerces every count to a finite
// non-negative number. Total: a partial (even empty) object yields a complete, valid usage.
export function usageWithDefaults(partial: Partial<ResourceUsage>): ResourceUsage {
  return {
    workerRequests: nonNeg(partial.workerRequests ?? 0),
    workerCpuMs: nonNeg(partial.workerCpuMs ?? 0),
    doRequests: nonNeg(partial.doRequests ?? 0),
    doDurationGbS: nonNeg(partial.doDurationGbS ?? 0),
    d1RowsRead: nonNeg(partial.d1RowsRead ?? 0),
    d1RowsWritten: nonNeg(partial.d1RowsWritten ?? 0),
    r2ClassA: nonNeg(partial.r2ClassA ?? 0),
    r2ClassB: nonNeg(partial.r2ClassB ?? 0),
    kvReads: nonNeg(partial.kvReads ?? 0),
    kvWrites: nonNeg(partial.kvWrites ?? 0),
  };
}

// addUsage returns the element-wise sum of two usages (pure).
export function addUsage(a: ResourceUsage, b: ResourceUsage): ResourceUsage {
  return {
    workerRequests: a.workerRequests + b.workerRequests,
    workerCpuMs: a.workerCpuMs + b.workerCpuMs,
    doRequests: a.doRequests + b.doRequests,
    doDurationGbS: a.doDurationGbS + b.doDurationGbS,
    d1RowsRead: a.d1RowsRead + b.d1RowsRead,
    d1RowsWritten: a.d1RowsWritten + b.d1RowsWritten,
    r2ClassA: a.r2ClassA + b.r2ClassA,
    r2ClassB: a.r2ClassB + b.r2ClassB,
    kvReads: a.kvReads + b.kvReads,
    kvWrites: a.kvWrites + b.kvWrites,
  };
}

// scaleUsage multiplies every count by a non-negative factor (for example runs per month).
export function scaleUsage(u: ResourceUsage, factor: number): ResourceUsage {
  const k = nonNeg(factor);
  return {
    workerRequests: u.workerRequests * k,
    workerCpuMs: u.workerCpuMs * k,
    doRequests: u.doRequests * k,
    doDurationGbS: u.doDurationGbS * k,
    d1RowsRead: u.d1RowsRead * k,
    d1RowsWritten: u.d1RowsWritten * k,
    r2ClassA: u.r2ClassA * k,
    r2ClassB: u.r2ClassB * k,
    kvReads: u.kvReads * k,
    kvWrites: u.kvWrites * k,
  };
}
