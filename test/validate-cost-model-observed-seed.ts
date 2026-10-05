// The observed-seed derivation: the HONEST per-run snapshot basis seeded from REAL run history,
// the byte-driven (not run-count) churn signal for the labelled future model, and the
// NaN-safe churn clamp on the overview seed.

import {
  DEFAULT_DEDUP_RATIO,
  perRunStoredBytes,
  storedSize,
  DEFAULT_INPUTS,
  type Inputs,
} from "../src/lib/cost-model.ts";
import { summariseHistory } from "../src/screens/costs.ts";
import { observedCostSeed } from "../src/screens/overview.ts";
import type { RunHistoryEntry } from "../src/api.ts";
import { type Harness, obsRun } from "./validate-cost-model-shared.ts";

export function run(h: Harness): void {
  const { ok, approx } = h;
  // -------------------------------------------------------------------------
  // Observed seed: the HONEST per-run snapshot basis. The default projection is runs per
  // period x archive bytes per run, so the seed must anchor the model's PER-RUN bytes on the
  // REAL observed mean per-run archiveBytesWritten (run history is already honest data), and
  // it must seed the DEFAULT growth model (snapshot), never the future churn-dedup one.
  // Churn is still derived from the byte shape (bytes, not run count) because it
  // seeds the clearly-labelled future model; it must not move the default projection.
  // summariseHistory is the screen's own observed-seed function.
  // -------------------------------------------------------------------------
  const obsSeed = (history: RunHistoryEntry[]): Inputs => {
    const load = summariseHistory({ dp: history });
    if (load.kind !== "seedable") throw new Error(`expected seedable, got ${load.kind}`);
    return load.seed;
  };

  // CASE A: a 1e9 first write then four 1e7 runs. Churn (for the labelled future model) is
  // the incremental mean over the largest write: 1e7 / 1e9 = 0.01, NOT 1/5 = 0.2.
  const seedA = obsSeed([obsRun("r0", 1e9), obsRun("r1", 1e7), obsRun("r2", 1e7), obsRun("r3", 1e7), obsRun("r4", 1e7)]);
  approx("observed churn from byte shape (big seal + small deltas) = incrementalMean/baseline = 0.01", seedA.churnFraction, 0.01);
  ok("observed churn is NOT the 1/runCount artefact (would be 0.2 for 5 runs)", Math.abs(seedA.churnFraction - 1 / 5) > 1e-6);
  // THE HONEST PINS: the seed carries the default snapshot model, and the model's per-run
  // bytes equal the REAL observed mean per-run write ((1e9 + 4 x 1e7) / 5 = 2.08e8), so the
  // default projection is literally runs-per-period x observed-archive-bytes-per-run.
  ok("observed seed: growth model is the default snapshot (never the future model)", seedA.growthModel === "snapshot");
  const meanA = (1e9 + 4 * 1e7) / 5;
  approx("observed seed: per-run snapshot bytes = the observed mean per-run write", perRunStoredBytes(seedA), meanA);
  approx("observed seed: storedSize(S, d) round-trips the observed mean", storedSize(seedA.sourceBytes, seedA.dedupRatio), meanA);

  // CASE B: SAME run count (5) but a volatile shape (1e9 seal then four 5e8 deltas). Churn is
  // 5e8 / 1e9 = 0.5, distinct from CASE A despite the identical run count: proof the signal is
  // byte-driven, not count-driven.
  const seedB = obsSeed([obsRun("r0", 1e9), obsRun("r1", 5e8), obsRun("r2", 5e8), obsRun("r3", 5e8), obsRun("r4", 5e8)]);
  approx("observed churn moves with byte volume (same N=5, volatile shape) = 0.5", seedB.churnFraction, 0.5);
  ok("same run count, different bytes => different churn (not 1/N)", Math.abs(seedB.churnFraction - seedA.churnFraction) > 0.1);

  // CASE C: DIFFERENT run count (10) but the SAME byte shape as CASE A (1e9 seal + nine 1e7
  // deltas). Churn stays 0.01, NOT 1/10 = 0.1: proof it is independent of how many rows exist.
  const seedC = obsSeed([obsRun("r0", 1e9), ...Array.from({ length: 9 }, (_, i) => obsRun(`r${i + 1}`, 1e7))]);
  approx("observed churn is run-count independent (N=10, same shape as N=5) = 0.01", seedC.churnFraction, 0.01);
  ok("different run count, same bytes => same churn (not 1/N which would be 0.1)", Math.abs(seedC.churnFraction - seedA.churnFraction) < 1e-9);

  // CASE D: a UNIFORM set (three equal 5e8 writes) is the EXPECTED live-engine shape (every
  // run a full snapshot). Churn is unidentifiable (no seal/delta split), so it stays at the
  // model default rather than a fabricated figure, and the per-run bytes are the observed
  // per-run write itself, NOT the cumulative footprint (the old sum-based basis would have
  // tripled the per-run figure to 1.5e9 and overstated every projected month).
  const seedD = obsSeed([obsRun("r0", 5e8), obsRun("r1", 5e8), obsRun("r2", 5e8)]);
  approx("observed churn falls back to the model default when unidentifiable (uniform sizes)", seedD.churnFraction, DEFAULT_INPUTS.churnFraction);
  approx("observed seed: uniform (live-engine) shape seeds per-run bytes = the real per-run write", perRunStoredBytes(seedD), 5e8);
  approx("observed seed: sourceBytes = mean per-run bytes / d (never the cumulative sum)", seedD.sourceBytes, 5e8 / DEFAULT_DEDUP_RATIO);

  // CASE E: a single incremental run after the seal is still identifiable (one delta is enough
  // to form the ratio): 1e7 / 1e9 = 0.01.
  const seedE = obsSeed([obsRun("r0", 1e9), obsRun("r1", 1e7)]);
  approx("observed churn identifiable from a single incremental run = 0.01", seedE.churnFraction, 0.01);

  // -------------------------------------------------------------------------
  // overview.ts observedCostSeed churnFraction clamp must be NaN-safe.
  // The overview seed uses Math.min/Max + Number.isFinite, matching costs.ts clamp01.
  // A zero-byte history (sumArchiveBytes = 0) must produce churn 0 (not NaN from 0/0).
  // A normal run produces a finite churn in [0, 1]; the seeds from costs.ts and the
  // overview path agree on a normal case.
  // -------------------------------------------------------------------------
  // Normal case: observedCostSeed produces a finite churn in [0, 1].
  const ovRun = (archive: number, segments = 1): RunHistoryEntry => ({ runId: "r", index: 0, startedAt: "2026-01-01T00:00:00Z", status: "ok", archiveBytesWritten: archive, segmentsWritten: segments });
  const ovResult = observedCostSeed({ dp: [ovRun(1e9), ovRun(1e7), ovRun(1e7)] });
  ok("observedCostSeed returns non-null for >= COST_MIN_OBSERVED_RUNS runs", ovResult !== null);
  if (ovResult) {
    ok("overview observedCostSeed churnFraction is finite", Number.isFinite(ovResult.inputs.churnFraction));
    ok("overview observedCostSeed churnFraction is in [0, 1]", ovResult.inputs.churnFraction >= 0 && ovResult.inputs.churnFraction <= 1);
  }
  // Edge: all-zero archive bytes. sumArchiveBytes = 0, so the ratio 0/0 must not produce NaN.
  const ovZero = observedCostSeed({ dp: [ovRun(0), ovRun(0), ovRun(0)] });
  if (ovZero) {
    ok("zero-byte history churnFraction is finite (not NaN from 0/0)", Number.isFinite(ovZero.inputs.churnFraction));
    approx("zero-byte history churnFraction = 0", ovZero.inputs.churnFraction, 0);
  }
}
