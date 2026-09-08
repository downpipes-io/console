// The LABELLED FUTURE (churn-dedup) growth-model cross-checks: object counts, the accumulate and
// retained-with-GC regimes, the cost split (storage / writes / reads / egress) on both the
// zero-egress R2 path and the S3 egress path, the projection, the marginal per-run/restore/drill
// views, the retention saving (CON-L24), and the churn/retention/cadence sensitivity sweeps.

import {
  PRESETS,
  DEFAULT_MANIFEST_OBJECTS,
  DEFAULT_OVERHEAD_BYTES,
  BYTES_PER_GB,
  withDefaults,
  storedSize,
  objectsForBytes,
  newObjectsPerRun,
  initialObjects,
  referencedInitialBytes,
  storedBytesAccumulate,
  storedBytesRetained,
  monthlyCost,
  initialWriteCost,
  project,
  perRunCost,
  restoreCostOnce,
  drillCostOnce,
  costOfRetention,
  sensitivity,
  cadenceToRunsPerMonth,
} from "../src/lib/cost-model.ts";
import {
  type Harness,
  A0,
  dA,
  makeBase,
  isNonDecreasing,
  isStrictlyIncreasing,
  distinctCount,
} from "./validate-cost-model-shared.ts";

export function run(h: Harness): void {
  const { ok, approx } = h;
  const base = makeBase();
  const r2 = PRESETS.r2;
  const s3 = PRESETS["s3-standard"];

  // -------------------------------------------------------------------------
  // THE LABELLED FUTURE (churn-dedup) MODEL from here down: the spec's maths, pinned
  // unchanged under its explicit flag. Everything below uses `base` (growthModel
  // "churn-dedup") unless stated otherwise.
  // -------------------------------------------------------------------------

  // Object-count estimate from the engine's segBytes: dA (0.5 GB) < 1 GiB => 1 seg object;
  // plus the manifest constant.
  ok("objectsForBytes(0.5e9, 1 GiB) = 1", objectsForBytes(dA, base.segBytes) === 1);
  ok("objectsForBytes(0) = 0", objectsForBytes(0, base.segBytes) === 0);
  ok("churn-dedup newObjectsPerRun = 1 + manifest constant", newObjectsPerRun(base) === 1 + DEFAULT_MANIFEST_OBJECTS);
  // A0 = 5e9 B over 1 GiB = ceil(4.657) = 5 seg objects, + manifest constant.
  ok("initialObjects = ceil(5e9 / 1GiB) + manifest", initialObjects(base) === Math.ceil(5e9 / base.segBytes) + DEFAULT_MANIFEST_OBJECTS);

  // -------------------------------------------------------------------------
  // Regime 1 (churn-dedup): accumulate. A_acc(m) = A0 + (dA + O)*f*m. With O=0: 5e9 + 15e9*m.
  // -------------------------------------------------------------------------
  approx("churn-dedup accumulate m=1: A = 5e9 + 15e9 = 20e9", storedBytesAccumulate(base, 1), 20e9);
  approx("churn-dedup accumulate m=0.5 (month-1 midpoint): 12.5e9", storedBytesAccumulate(base, 0.5), 12.5e9);
  approx("churn-dedup accumulate m=12: 5e9 + 15e9*12 = 185e9", storedBytesAccumulate(base, 12), 185e9);
  approx("churn-dedup accumulate m=0 is just A0", storedBytesAccumulate(base, 0), A0);
  // Linearity: doubling months past the floor doubles the growth term.
  approx("accumulate growth is linear in n", storedBytesAccumulate(base, 4) - A0, 2 * (storedBytesAccumulate(base, 2) - A0));

  // -------------------------------------------------------------------------
  // Regime 2 (churn-dedup): retained-with-GC. Steady = A0_ref + (dA + O)*R, with
  // A0_ref = A0*(1-c)^R = 5e9 * 0.9^10. Bounded; independent of how long it runs.
  // -------------------------------------------------------------------------
  const a0ref = 5e9 * 0.9 ** 10;
  approx("referencedInitialBytes = A0*(1-c)^R", referencedInitialBytes(base), a0ref);
  const steady = a0ref + dA * 10; // O = 0
  approx("retained steady = A0_ref + dA*R", storedBytesRetained(base), steady);
  // The retention BOUND: retained at a far month equals the same steady value (does not grow).
  approx("retained is bounded: m=12 == m=120 (>=R runs elapsed)", storedBytesRetained(base, 12), storedBytesRetained(base, 120));
  approx("retained at large m equals unbounded steady", storedBytesRetained(base, 1000), steady);
  // The retained footprint never exceeds the accumulate footprint.
  ok("retained <= accumulate at m=12", storedBytesRetained(base, 12) <= storedBytesAccumulate(base, 12));
  // Before R runs have elapsed, GC has nothing to collect: retained tracks accumulate.
  // At m where f*m < R (here f=30, R=10, so m must be < 1/3): use m = 0.2 (6 runs < 10).
  approx("retained tracks accumulate before R runs elapse", storedBytesRetained(base, 0.2), storedBytesAccumulate(base, 0.2));

  // -------------------------------------------------------------------------
  // Cost split, ZERO-EGRESS R2 path. Use the retained regime at month 12.
  //   avgBytes = steady (retained), avgGB = steady/1e9.
  //   storage = avgGB * 0.015
  //   writes  = (newObjectsPerRun * f)/1e6 * 4.50 = (4*30)/1e6 * 4.50
  //   reads   = 0 (no drills/restores)
  //   egress  = 0 (R2 egress price 0)
  // -------------------------------------------------------------------------
  const mcRet = monthlyCost(base, r2, { regime: "retained", month: 12 });
  approx("R2 retained storage = steadyGB * 0.015", mcRet.storage, (steady / BYTES_PER_GB) * 0.015);
  approx("R2 retained writes = (4*30)/1e6 * 4.50", mcRet.writes, ((4 * 30) / 1e6) * 4.5);
  approx("R2 retained reads = 0 (no drills/restores)", mcRet.reads, 0);
  approx("R2 egress is exactly 0 (zero-egress path)", mcRet.egress, 0);
  approx("R2 retained total = storage + writes", mcRet.total, mcRet.storage + mcRet.writes);
  ok("monthlyCost exposes averageStoredBytes (steady)", Math.abs(mcRet.averageStoredBytes - steady) < 1);
  ok("monthlyCost exposes objectsWrittenPerMonth = 4*30", mcRet.objectsWrittenPerMonth === 4 * 30);

  // Accumulate regime at month 12: storage uses the MONTH MIDPOINT (m - 0.5 = 11.5).
  const mcAcc = monthlyCost(base, r2, { regime: "accumulate", month: 12 });
  const accMidBytes = storedBytesAccumulate(base, 11.5); // 5e9 + 15e9*11.5
  approx("accumulate storage uses month midpoint (11.5)", mcAcc.storage, (accMidBytes / BYTES_PER_GB) * 0.015);
  approx("accumulate midpoint bytes = 5e9 + 15e9*11.5 = 177.5e9", accMidBytes, 177.5e9);

  // -------------------------------------------------------------------------
  // S3 egress path (non-zero), with offline recoveries that ALWAYS egress the WHOLE
  // recoverable archive for the regime in play (NOT the aged-down referenced-initial figure;
  // basing it on referencedInitialBytes is the bug this check guards against). In the retained
  // regime at month 12 the recoverable archive is storedBytesRetained at month 12 (the bounded
  // steady state), computed here independently of the egress code path.
  //   2 offline recoveries/month; egress = 2 * (retained archive GB at m=12) * 0.09; restores 0.
  // -------------------------------------------------------------------------
  const offlineInputs = withDefaults({ ...base, offlineRecoveriesPerMonth: 2 });
  const mcS3 = monthlyCost(offlineInputs, s3, { regime: "retained", month: 12 });
  // Independent expectation from the retained regime size (= steady at m=12, here R=10 elapsed),
  // not from referencedInitialBytes. This is strictly larger than the old A0_ref basis.
  const offlineArchiveGBRet = storedBytesRetained(offlineInputs, 12) / BYTES_PER_GB;
  const expectedOfflineEgress = 2 * offlineArchiveGBRet * 0.09;
  approx("S3 offline-recovery egress = 2 * retainedArchiveGB(m=12) * 0.09", mcS3.egress, expectedOfflineEgress);
  ok("S3 egress is non-zero when offline recoveries occur", mcS3.egress > 0);
  // Guard the fix directly: the offline egress basis must be the whole archive, which here is
  // strictly larger than the old aged-down referencedInitialBytes basis (c=0.1, R=10 > 0, dA>0).
  const oldAgedDownEgress = 2 * (referencedInitialBytes(offlineInputs) / BYTES_PER_GB) * 0.09;
  ok("S3 offline egress exceeds the old aged-down A0_ref basis (basis fix)", mcS3.egress > oldAgedDownEgress);

  // Accumulate-regime offline recovery egresses the archive at the MONTH MIDPOINT (m - 0.5),
  // consistent with the storage-average basis. Using end-of-month would overstate
  // egress relative to the averaged storage within the same monthlyCost call.
  const mcS3Acc = monthlyCost(offlineInputs, s3, { regime: "accumulate", month: 12 });
  // Midpoint for month 12 is 11.5 (same basis as storage average).
  const offlineArchiveGBAcc = storedBytesAccumulate(offlineInputs, 11.5) / BYTES_PER_GB;
  approx("S3 accumulate offline egress = 2 * accumulateArchiveGB(midpoint 11.5) * 0.09", mcS3Acc.egress, 2 * offlineArchiveGBAcc * 0.09);
  // Cross-check: the egress basis is strictly less than the old end-of-month basis (accumulate
  // grows monotonically, so midpoint < month-end => midpoint bytes < end-of-month bytes).
  const oldEndOfMonthEgressAcc = 2 * (storedBytesAccumulate(offlineInputs, 12) / BYTES_PER_GB) * 0.09;
  ok("accumulate egress midpoint basis < old end-of-month basis (no inflation)", mcS3Acc.egress < oldEndOfMonthEgressAcc);
  // Also confirm the storage and egress bases are now consistent: both use the midpoint size.
  const midpointBytes = storedBytesAccumulate(offlineInputs, 11.5);
  approx("accumulate egress basis matches the storage average basis (midpoint)", mcS3Acc.averageStoredBytes, midpointBytes);

  // driveEgressFree gate: in-account restores add no egress when true, do when false.
  const restoreInputs = withDefaults({ ...base, restoresPerMonth: 5, driveEgressFree: true });
  const restoreInputsPaid = withDefaults({ ...base, restoresPerMonth: 5, driveEgressFree: false });
  const mcFree = monthlyCost(restoreInputs, s3, { regime: "retained", month: 12, restoreGBPerRestore: 4 });
  const mcPaid = monthlyCost(restoreInputsPaid, s3, { regime: "retained", month: 12, restoreGBPerRestore: 4 });
  approx("driveEgressFree=true: in-account restore egress is 0", mcFree.egress, 0);
  approx("driveEgressFree=false: restore egress = 5 * 4 GB * 0.09", mcPaid.egress, 5 * 4 * 0.09);

  // Reads cross-check: drills + restores priced at Class B over the full averaged objects.
  const readInputs = withDefaults({ ...base, drillsPerMonth: 2, restoresPerMonth: 1 });
  const mcReads = monthlyCost(readInputs, r2, { regime: "retained", month: 12 });
  const fullObjsRet = objectsForBytes(storedBytesRetained(readInputs, 12), readInputs.segBytes);
  approx("reads = (drills+restores)*fullObjs/1e6 * Class B", mcReads.reads, ((2 + 1) * fullObjsRet / 1e6) * r2.classBPerMillion);

  // -------------------------------------------------------------------------
  // Initial one-off seal cost: initialObjects/1e6 * Class A.
  // -------------------------------------------------------------------------
  approx("initialWriteCost = initialObjects/1e6 * Class A", initialWriteCost(base, r2), (initialObjects(base) / 1e6) * 4.5);

  // -------------------------------------------------------------------------
  // Projection: BOTH regimes, cumulative. Check the months and the cumulative-cost
  // recurrence (initial + sum of each whole month's monthlyCost).
  // -------------------------------------------------------------------------
  const proj = project(base, r2, [1, 3, 6, 12]);
  ok("projection returns both regimes", proj.accumulate.points.length === 4 && proj.retained.points.length === 4);
  ok("projection points are sorted ascending", proj.accumulate.points.map((p) => p.month).join(",") === "1,3,6,12");
  approx("projection initialCost matches initialWriteCost", proj.accumulate.initialCost, initialWriteCost(base, r2));
  // Retained stored bytes at month 12 equals the steady value.
  const retM12 = proj.retained.points.find((p) => p.month === 12);
  ok("retained projection point m=12 present", retM12 !== undefined);
  if (retM12) approx("retained projection m=12 storedBytes = steady", retM12.storedBytes, steady);
  // Accumulate stored bytes at month 6 equals A_acc(6).
  const accM6 = proj.accumulate.points.find((p) => p.month === 6);
  if (accM6) approx("accumulate projection m=6 storedBytes = A_acc(6)", accM6.storedBytes, storedBytesAccumulate(base, 6));
  // Cumulative cost at month 1 (retained) = initial + monthlyCost(retained, month 1).
  const retM1 = proj.retained.points.find((p) => p.month === 1);
  if (retM1) approx("retained cumulative m=1 = initial + monthlyCost(m=1)", retM1.cumulativeCost, proj.retained.initialCost + monthlyCost(base, r2, { regime: "retained", month: 1 }).total);
  // Cumulative cost at month 3 (retained) = initial + sum of monthlyCost months 1..3.
  if (retM12) {
    let handCum = proj.retained.initialCost;
    for (let k = 1; k <= 3; k++) handCum += monthlyCost(base, r2, { regime: "retained", month: k }).total;
    const retM3 = proj.retained.points.find((p) => p.month === 3);
    if (retM3) approx("retained cumulative m=3 = initial + sum(1..3)", retM3.cumulativeCost, handCum);
  }
  // Cumulative cost is monotonic non-decreasing across months for each regime.
  ok("accumulate cumulative cost is non-decreasing", isNonDecreasing(proj.accumulate.points.map((p) => p.cumulativeCost)));
  ok("retained cumulative cost is non-decreasing", isNonDecreasing(proj.retained.points.map((p) => p.cumulativeCost)));
  // Fractional marker is honoured for stored size.
  const projFrac = project(base, r2, [0.5]);
  const fracPt = projFrac.accumulate.points[0];
  if (fracPt) approx("fractional marker stored size = A_acc(0.5)", fracPt.storedBytes, storedBytesAccumulate(base, 0.5));

  // -------------------------------------------------------------------------
  // Marginal per-run, restore, drill, and the retention saving.
  // -------------------------------------------------------------------------
  // perRunCost = (dA GB * P_store, one month) + (newObjects/1e6 * Class A).
  const expectedPerRun = (dA / BYTES_PER_GB) * 0.015 + (newObjectsPerRun(base) / 1e6) * 4.5;
  approx("perRunCost = dA-month-storage + write ops", perRunCost(base, r2), expectedPerRun);

  // restoreCostOnce: reads only when in-account; reads + egress when downloaded. The default
  // basis is the WHOLE recoverable archive A0 (= S*d), computed here independently from
  // storedSize, NOT from the aged-down referencedInitialBytes (the bug this guards against).
  const a0Objs = objectsForBytes(storedSize(base.sourceBytes, base.dedupRatio), base.segBytes);
  approx("restoreCostOnce in-account = reads only (over A0)", restoreCostOnce(base, r2), (a0Objs / 1e6) * r2.classBPerMillion);
  // Downloaded restore on S3: reads + egress on the whole recoverable archive GB (A0).
  const a0GB = storedSize(base.sourceBytes, base.dedupRatio) / BYTES_PER_GB;
  approx("restoreCostOnce downloaded (S3) = reads + egress (over A0)", restoreCostOnce(base, s3, { downloaded: true }), (a0Objs / 1e6) * s3.classBPerMillion + a0GB * 0.09);
  // The full-archive A0 basis is at least the old aged-down A0_ref basis (here strictly larger:
  // c=0.1, R=10 > 0). Guards that the one-off restore basis was un-aged-down.
  ok("restoreCostOnce A0 basis >= old aged-down A0_ref basis", storedSize(base.sourceBytes, base.dedupRatio) >= referencedInitialBytes(base));

  // drillCostOnce: read ops only, never egress (even on S3); default basis the whole archive A0.
  approx("drillCostOnce = reads only, no egress (S3, over A0)", drillCostOnce(base, s3), (a0Objs / 1e6) * s3.classBPerMillion);

  // costOfRetention = accumulate - retained, clamped at 0. At month 12, GC has reduced
  // the retained footprint, so the saving is positive; at month 1 with deep retention (R > elapsed runs)
  // the retained regime tracks accumulate exactly, so the raw difference is 0 (or near-zero),
  // not negative. Cross-check manually at month 12.
  const cor = costOfRetention(base, r2, 12);
  // The expected saving is the raw difference acc - ret, but clamped at 0. At month 12 it is positive.
  const corAccAt12 = monthlyCost(base, r2, { regime: "accumulate", month: 12 }).total;
  const corRetAt12 = monthlyCost(base, r2, { regime: "retained", month: 12 }).total;
  approx("costOfRetention = max(0, accumulate(12) - retained(12))", cor, Math.max(0, corAccAt12 - corRetAt12));
  ok("costOfRetention is positive at month 12 (GC saves)", cor > 0);

  // costOfRetention is never negative, even with deep retention + large overhead at an
  // early month where the retained regime has not yet pruned anything. At month 1 with R = 50
  // (50 runs needed before GC prunes), the retained footprint equals the accumulate footprint
  // (no pruning has happened), so the raw difference is ~0. The clamp ensures it is exactly 0,
  // not a small negative artefact from floating-point jitter.
  const deepRetInputs = withDefaults({ ...base, retentionRuns: 50, overheadBytes: DEFAULT_OVERHEAD_BYTES * 100 });
  const corEarly = costOfRetention(deepRetInputs, r2, 1);
  ok("costOfRetention is never negative (early month, deep retention)", corEarly >= 0);
  // With an extreme overhead that inflates the retained cost above accumulate (pathological
  // inputs: negative raw difference), the clamp must return 0 not a negative number.
  // Construct: a near-zero churn source with a huge per-run overhead. The retained steady
  // state scales with R (large), while the accumulate footprint at month 1 is small. Use
  // zero churn so dA = 0 and the retained steady state = A0_ref + O * R >> A0 = accumulate(0.5).
  const pathologicalInputs = withDefaults({ sourceBytes: 1e6, churnFraction: 0, runsPerMonth: 1, retentionRuns: 1000, overheadBytes: 1e9 });
  const corPathological = costOfRetention(pathologicalInputs, PRESETS["s3-standard"], 1);
  ok("costOfRetention is 0 (not negative) when retained exceeds accumulate at early month", corPathological === 0);
  // Verify the raw difference IS actually negative for the pathological inputs (confirming the
  // clamp is doing real work, not a vacuous test on an always-positive input).
  const rawDiff = monthlyCost(pathologicalInputs, PRESETS["s3-standard"], { regime: "accumulate", month: 1 }).total
    - monthlyCost(pathologicalInputs, PRESETS["s3-standard"], { regime: "retained", month: 1 }).total;
  ok("raw acc - ret IS negative for pathological inputs (clamp is non-vacuous)", rawDiff < 0);

  // -------------------------------------------------------------------------
  // Sensitivity sweeps: churn, retention, cadence. Deltas are relative to the baseline.
  // -------------------------------------------------------------------------
  const churnSweep = sensitivity(base, r2, "churn", { values: [0.05, 0.1, 0.2], regime: "accumulate", month: 12 });
  ok("churn sweep returns 3 points sorted", churnSweep.length === 3 && churnSweep[0]!.value === 0.05 && churnSweep[2]!.value === 0.2);
  // Higher churn => higher (or equal) monthly cost in the accumulate regime.
  ok("churn sweep is monotonic non-decreasing in cost", isNonDecreasing(churnSweep.map((s) => s.monthlyCost)));
  // The baseline-matching sample (c=0.1) has delta 0.
  const churnBaselinePt = churnSweep.find((s) => s.value === 0.1);
  if (churnBaselinePt) approx("churn baseline sample delta = 0", churnBaselinePt.deltaFromBaseline, 0, 1e-9);
  // delta = monthlyCost(swept) - baseline, checked at c=0.2.
  const c02 = churnSweep.find((s) => s.value === 0.2);
  if (c02) approx("churn delta = swept - baseline", c02.deltaFromBaseline, c02.monthlyCost - (churnBaselinePt ? churnBaselinePt.monthlyCost : 0));

  // Retention sweep: test the EXACT path the screen uses (costs.ts:1194), which passes NO
  // regime. The retention axis only moves cost under retention GC, so sensitivity forces the
  // retained regime for this axis; an accumulate retention sweep would be a definitional
  // no-op (monthlyCost is invariant in retentionRuns in the accumulate regime), and the old
  // test masked that dead path by passing regime:"retained" explicitly while the screen does
  // not. Here we drive the screen's own call shape and assert the sweep genuinely moves.
  const retSweep = sensitivity(base, r2, "retention", { values: [5, 10, 30], month: 12 });
  ok("retention sweep returns 3 points", retSweep.length === 3);
  // The swept depths (5, 10, 30) are all below the elapsed run count at month 12 (f*12 = 360),
  // so each deeper retention strictly increases the retained footprint and hence the cost: a
  // no-op (flat) sweep would FAIL this, catching the always-zero-delta defect the screen had.
  ok("retention sweep is strictly increasing in cost (deeper retention costs more)", isStrictlyIncreasing(retSweep.map((s) => s.monthlyCost)));
  // The deltas must be distinct and not all zero. This is the assertion the old test lacked:
  // the broken accumulate path produced delta 0 at every depth (isNonDecreasing passed on an
  // all-equal series), so it could not see the contradiction the live screen rendered.
  const retDeltas = retSweep.map((s) => s.deltaFromBaseline);
  ok("retention sweep deltas are all distinct (the sweep is not flat)", distinctCount(retDeltas) === retDeltas.length);
  ok("retention sweep deltas are not all zero", retDeltas.some((d) => Math.abs(d) > 1e-9));
  // The baseline-matching sample (R == base.retentionRuns == 10) has delta exactly 0, and the
  // delta is signed: shallower than baseline is negative (a saving), deeper is positive.
  const retBaselinePt = retSweep.find((s) => s.value === base.retentionRuns);
  if (retBaselinePt) approx("retention baseline sample (R=10) delta = 0", retBaselinePt.deltaFromBaseline, 0, 1e-9);
  const ret5 = retSweep.find((s) => s.value === 5);
  if (ret5) ok("retention shallower than baseline (R=5) has a negative delta (a saving)", ret5.deltaFromBaseline < -1e-9);
  const ret30 = retSweep.find((s) => s.value === 30);
  if (ret30) ok("retention deeper than baseline (R=30) has a positive delta (costs more)", ret30.deltaFromBaseline > 1e-9);

  // Regression guard: the retention axis must be evaluated in the retained regime
  // REGARDLESS of the regime the caller passes (the screen passes none; a caller might pass
  // accumulate). Forcing regime:"accumulate" here must produce the IDENTICAL moving series as
  // the no-regime screen path above, never the flat accumulate series. If a future change
  // re-honoured the caller's regime for this axis, the explicit-accumulate sweep would go flat
  // (every monthlyCost equal to the accumulate baseline) and these checks would fail.
  const retSweepForcedAcc = sensitivity(base, r2, "retention", { values: [5, 10, 30], regime: "accumulate", month: 12 });
  ok(
    "retention axis ignores a caller-supplied accumulate regime (same moving series as the screen path)",
    retSweepForcedAcc.length === retSweep.length && retSweepForcedAcc.every((p, i) => Math.abs(p.monthlyCost - retSweep[i]!.monthlyCost) < 1e-12 && Math.abs(p.deltaFromBaseline - retSweep[i]!.deltaFromBaseline) < 1e-12),
  );
  ok("retention axis under forced-accumulate is still NOT flat", isStrictlyIncreasing(retSweepForcedAcc.map((s) => s.monthlyCost)));
  // And it agrees with costOfRetention's sign: keeping fewer runs than "everything" saves money,
  // so the retained cost at every finite depth here is at or below the accumulate cost at month 12.
  const accAt12 = monthlyCost(base, r2, { regime: "accumulate", month: 12 }).total;
  ok("retained cost at each swept depth <= accumulate cost at month 12 (GC bounds cost)", retSweep.every((s) => s.monthlyCost <= accAt12 + 1e-9));

  const cadSweep = sensitivity(base, r2, "cadence", { values: [cadenceToRunsPerMonth("daily"), cadenceToRunsPerMonth("hourly")], regime: "accumulate", month: 12 });
  ok("cadence sweep returns 2 points", cadSweep.length === 2);
  ok("cadence sweep: more runs => higher cost", isNonDecreasing(cadSweep.map((s) => s.monthlyCost)));
}
