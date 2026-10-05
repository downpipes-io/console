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
  initialWriteCost,
  project,
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
  // Runs per period x archive bytes per run. The first seal IS the first run, so there is no
  // separate initial A0 on top: n runs store exactly n snapshots (A0 + O each, O = 0 here).
  // -------------------------------------------------------------------------
  ok("snapshot is the default model on the shared params", snap.growthModel === "snapshot");
  approx("snapshot per-run bytes = the FULL snapshot A0 (not churn)", perRunStoredBytes(snap), A0);
  approx("snapshot accumulate m=1: A0*f = 5e9*30 = 150e9 (30 runs, 30 snapshots)", storedBytesAccumulate(snap, 1), 150e9);
  approx("snapshot accumulate m=12: 5e9*360 = 1800e9", storedBytesAccumulate(snap, 12), 1800e9);
  approx("snapshot accumulate m=0 is 0: no run has stored anything yet", storedBytesAccumulate(snap, 0), 0);
  // At n = R runs nothing has been collected yet, so accumulate and the retained steady state must be the
  // SAME R snapshots: R = 10 at f = 30 is m = 1/3, and (A0 + O) x 10 = 50e9. The old A0 + A0 x n read 55e9
  // here, one snapshot more than the window holds, and the retained curve dropped by A0 at that point.
  approx("snapshot accumulate at n = R equals the retained steady state (10 runs = 50e9)", storedBytesAccumulate(snap, 10 / 30), 50e9);
  approx("snapshot retained is continuous at n = R", storedBytesRetained(snap, 10 / 30), storedBytesRetained(snap));
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
  // THE FIRST RUN'S WRITES ARE CHARGED ONCE. Under snapshots the first seal is an ordinary run, so the
  // projection adds no one-off on top of the monthly writes. Hand vector at 64 KiB segments (65,536 B):
  // a run writes ceil(5e9 / 65,536) + 3 = 76,294 + 3 = 76,297 objects. f = 30, so month 1 writes
  // 30 x 76,297 = 2,288,910 objects = 2,288,910 / 1e6 x 4.5 = 10.300095 (30 runs, not 31).
  const snap64k = withDefaults({ ...params, segBytes: 65_536 });
  ok("64 KiB segments: a snapshot run writes 76,297 objects", newObjectsPerRun(snap64k) === 76_297);
  approx("snapshot initialWriteCost is 0: the first seal is the first run", initialWriteCost(snap64k, PRESETS.r2), 0);
  const m1 = monthlyCost(snap64k, PRESETS.r2, { regime: "accumulate", month: 1 });
  approx("64 KiB segments: month-1 writes = 30 x 76,297 / 1e6 x 4.5 = 10.300095", m1.writes, 10.300095);
  const proj64k = project(snap64k, PRESETS.r2, [1]);
  approx("snapshot projection initialCost is 0", proj64k.accumulate.initialCost, 0);
  approx("snapshot cumulative cost at month 1 = monthlyCost(m=1), with no second copy of the first run's writes", proj64k.accumulate.points[0]?.cumulativeCost ?? -1, m1.total);

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
