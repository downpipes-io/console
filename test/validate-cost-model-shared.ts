// Shared harness, builders and helpers for the cost-model validator split. The validator's
// assertions are grouped into sibling modules (validate-cost-model-<area>.ts), each exporting a
// `run(ctx)` that receives this Harness so every group reports through the SAME failure counter
// and prints in the SAME style as the original single-file validator. Behaviour-preserving: the
// orchestrator (validate-cost-model.ts) calls each group in the original order.

import { withDefaults, type Inputs } from "../src/lib/cost-model.ts";
import type { RunHistoryEntry } from "../src/api.ts";

// Harness carries the running failure count and the ok/approx assertion functions. A single
// Harness instance threads through every group so the suite's failure tally is global.
export interface Harness {
  failures: number;
  ok(label: string, cond: boolean): void;
  approx(label: string, got: number, want: number, tol?: number): void;
}

// makeHarness builds the shared assertion harness with the exact reporting behaviour of the
// original validator (one line per check, increment failures on a miss).
export function makeHarness(): Harness {
  const h: Harness = {
    failures: 0,
    ok(label: string, cond: boolean): void {
      console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
      if (!cond) h.failures++;
    },
    // approx compares floats within a relative+absolute tolerance (currency/byte arithmetic).
    approx(label: string, got: number, want: number, tol = 1e-6): void {
      const diff = Math.abs(got - want);
      const scale = Math.max(1, Math.abs(want));
      const cond = diff <= tol * scale;
      console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${got} want=${want} diff=${diff}`);
      if (!cond) h.failures++;
    },
  };
  return h;
}

// A clean shared parameter set for the regime/cost cross-checks.
//   S = 10 GB (10e9 B), d = 0.5  => A0 = 5e9 B = 5 GB
//   c = 0.1; f = 30, R = 10, O = 0 (set explicitly for clean arithmetic)
//   segBytes default 1 GiB.
export const SHARED_PARAMS = {
  sourceBytes: 10e9,
  dedupRatio: 0.5,
  churnFraction: 0.1,
  runsPerMonth: 30,
  retentionRuns: 10,
  overheadBytes: 0,
  drillsPerMonth: 0,
  restoresPerMonth: 0,
  offlineRecoveriesPerMonth: 0,
  driveEgressFree: true,
};

// A0 = S*d (the full stored snapshot); dA = S*c*d (the per-run churn delta). Both are pinned by
// the assertions; exported so every group shares the identical hand-computed constants.
export const A0 = 5e9;
export const dA = 0.5e9;

// `snap` is the DEFAULT (per-run snapshot) model: per-run growth = A0 = 5e9.
export function makeSnap(): Inputs {
  return withDefaults(SHARED_PARAMS);
}

// `base` is the SAME parameters under the EXPLICIT churn-dedup flag (the labelled future
// projection): per-run growth = dA = S*c*d = 0.5e9. The spec's maths is pinned under it.
export function makeBase(): Inputs {
  return withDefaults({ ...SHARED_PARAMS, growthModel: "churn-dedup" });
}

// obsRun builds a run-history entry for the observed-seed and by-source cross-checks.
export const obsRun = (id: string, archive: number, segments = 1): RunHistoryEntry => ({
  runId: id,
  index: 0,
  startedAt: "2026-01-01T00:00:00Z",
  status: "ok",
  archiveBytesWritten: archive,
  segmentsWritten: segments,
});

// isNonDecreasing reports whether a series never decreases step to step (within a tiny
// floating tolerance), used for the monotonicity cross-checks.
export function isNonDecreasing(xs: number[]): boolean {
  for (let i = 1; i < xs.length; i++) {
    const prev = xs[i - 1];
    const cur = xs[i];
    if (prev === undefined || cur === undefined) return false;
    if (cur < prev - 1e-9) return false;
  }
  return true;
}

// isStrictlyIncreasing reports whether each step is genuinely larger than the last (beyond a
// tiny floating tolerance). Unlike isNonDecreasing, an all-equal (flat) series FAILS this, so
// it is the assertion that catches a sweep which silently produces the same cost at every
// swept value.
export function isStrictlyIncreasing(xs: number[]): boolean {
  for (let i = 1; i < xs.length; i++) {
    const prev = xs[i - 1];
    const cur = xs[i];
    if (prev === undefined || cur === undefined) return false;
    if (cur <= prev + 1e-9) return false;
  }
  return true;
}

// distinctCount counts the distinct values in a series within a tiny floating tolerance
// (used to assert a sweep's deltas genuinely differ from one another rather than collapsing
// to a single repeated value).
export function distinctCount(xs: number[]): number {
  const seen: number[] = [];
  for (const x of xs) {
    if (!seen.some((s) => Math.abs(s - x) < 1e-9)) seen.push(x);
  }
  return seen.length;
}
