// The DEFAULT (snapshot) growth-model cross-checks: per-run growth is the FULL stored snapshot,
// churn invariance, the retained steady state, and the snapshot churn/retention sweeps.

import {
  PRESETS,
  DEFAULT_SEG_BYTES,
  DEFAULT_MANIFEST_OBJECTS,
  BYTES_PER_GB,
  withDefaults,
  storedSize,
  churnStoredBytes,
  perRunStoredBytes,
  newObjectsPerRun,
  storedBytesAccumulate,
  storedBytesRetained,
  monthlyCost,
  perRunCost,
  sensitivity,
} from "../src/lib/cost-model.ts";
import {
  type Harness,
  SHARED_PARAMS,
  A0,
  dA,
  makeSnap,
  makeBase,
  isStrictlyIncreasing,
} from "./validate-cost-model-shared.ts";

export function run(h: Harness): void {
  const { ok, approx } = h;
  const params = SHARED_PARAMS;
  const snap = makeSnap();
  const base = makeBase();
  approx("storedSize A0 = S*d = 5e9", storedSize(base.sourceBytes, base.dedupRatio), A0);
  approx("churnStoredBytes dA = S*c*d = 0.5e9", churnStoredBytes(base.sourceBytes, base.churnFraction, base.dedupRatio), dA);

  // -------------------------------------------------------------------------
  // THE DEFAULT (snapshot) MODEL: per-run growth is the FULL stored snapshot A0, not churn.
  // Runs per period x archive bytes per run, on top of the initial seal.
  // -------------------------------------------------------------------------
  ok("snapshot is the default model on the shared params", snap.growthModel === "snapshot");
  approx("snapshot per-run bytes = the FULL snapshot A0 (not churn)", perRunStoredBytes(snap), A0);
  approx("snapshot accumulate m=1: A0 + A0*f = 5e9 + 150e9 = 155e9", storedBytesAccumulate(snap, 1), 155e9);
  approx("snapshot accumulate m=12: 5e9 + 5e9*360 = 1805e9", storedBytesAccumulate(snap, 12), 1805e9);
  approx("snapshot accumulate m=0 is just the initial seal A0", storedBytesAccumulate(snap, 0), A0);
  // Retained window under snapshots holds R whole runs: steady = (A0 + O) * R.
  approx("snapshot retained steady = (A0 + O) * R = 50e9", storedBytesRetained(snap), 50e9);
  approx("snapshot retained is bounded at large m", storedBytesRetained(snap, 1000), 50e9);
  // CHURN INVARIANCE: under per-run snapshots, churn does not move a single figure.
  const snapHighChurn = withDefaults({ ...params, churnFraction: 0.9 });
  approx("snapshot churn invariance: accumulate(m=12) identical at c=0.1 and c=0.9", storedBytesAccumulate(snapHighChurn, 12), storedBytesAccumulate(snap, 12));
  approx(
    "snapshot churn invariance: monthlyCost total identical at c=0.1 and c=0.9",
    monthlyCost(snapHighChurn, PRESETS.r2, { regime: "accumulate", month: 12 }).total,
    monthlyCost(snap, PRESETS.r2, { regime: "accumulate", month: 12 }).total,
  );
  // Per-run objects under snapshots: the whole snapshot's segments + the manifest constant.
  ok("snapshot newObjectsPerRun = ceil(A0/segBytes) + manifest", newObjectsPerRun(snap) === Math.ceil(A0 / DEFAULT_SEG_BYTES) + DEFAULT_MANIFEST_OBJECTS);
  // Per-run marginal cost under snapshots: a month of storage for a FULL snapshot + its writes.
  approx(
    "snapshot perRunCost = A0-month-storage + full-snapshot write ops",
    perRunCost(snap, PRESETS.r2),
    (A0 / BYTES_PER_GB) * 0.015 + (newObjectsPerRun(snap) / 1e6) * 4.5,
  );
  // The snapshot churn sweep is genuinely FLAT (the honest invariance the screen states).
  const snapChurnSweep = sensitivity(snap, PRESETS.r2, "churn", { values: [0.05, 0.1, 0.2], regime: "accumulate", month: 12 });
  ok("snapshot churn sweep is flat (every delta 0)", snapChurnSweep.every((s) => Math.abs(s.deltaFromBaseline) < 1e-9));
  // The snapshot retention sweep still genuinely moves (deeper window = more whole runs kept).
  const snapRetSweep = sensitivity(snap, PRESETS.r2, "retention", { values: [5, 10, 30], month: 12 });
  ok("snapshot retention sweep is strictly increasing", isStrictlyIncreasing(snapRetSweep.map((s) => s.monthlyCost)));
}
