// Cadence conversions, the retention-window-to-runs bound, and the model edges (zero churn,
// full churn, zero retention, empty inputs, robustness to bad pricing).

import {
  PRESETS,
  DEFAULT_OVERHEAD_BYTES,
  DEFAULT_MANIFEST_OBJECTS,
  withDefaults,
  churnStoredBytes,
  referencedInitialBytes,
  storedBytesAccumulate,
  storedBytesRetained,
  monthlyCost,
  initialWriteCost,
  perRunCost,
  costOfRetention,
  cadenceToRunsPerMonth,
  cadenceSecondsToRunsPerMonth,
  retentionWindowToRuns,
  CADENCE_SECONDS,
} from "../src/lib/cost-model.ts";
import {
  type Harness,
  SHARED_PARAMS,
  A0,
  makeSnap,
  makeBase,
} from "./validate-cost-model-shared.ts";

export function run(h: Harness): void {
  const { ok, approx } = h;
  const params = SHARED_PARAMS;
  const snap = makeSnap();
  const base = makeBase();
  const r2 = PRESETS.r2;

  // -------------------------------------------------------------------------
  // Cadence conversions: the spec's stated approximations (DAYS_PER_MONTH = 30.44).
  // -------------------------------------------------------------------------
  // The spec's "~= 2880" is a round figure; computed from 30.44 days/month it is 30.44*96 = 2922.24.
  approx("every 15 min ~= 2922.24 runs/month (spec round ~2880)", cadenceToRunsPerMonth("every15min"), 30.44 * 96, 0.001);
  approx("hourly ~= 730 runs/month", cadenceToRunsPerMonth("hourly"), 730.56, 0.01);
  approx("every 6 h ~= 122 runs/month", cadenceToRunsPerMonth("every6h"), 121.76, 0.01);
  approx("daily ~= 30.44 runs/month", cadenceToRunsPerMonth("daily"), 30.44, 0.001);
  approx("weekly ~= 4.348 runs/month", cadenceToRunsPerMonth("weekly"), 30.44 / 7, 0.001);
  // Cross-check the general seconds helper equals the named table.
  approx("cadenceSeconds helper matches daily table", cadenceSecondsToRunsPerMonth(CADENCE_SECONDS.daily), cadenceToRunsPerMonth("daily"));
  ok("cadenceSeconds helper: non-positive interval => 0", cadenceSecondsToRunsPerMonth(0) === 0 && cadenceSecondsToRunsPerMonth(-1) === 0);

  // -------------------------------------------------------------------------
  // Retention window (days) -> runs: R = ceil(f * days / 30.44).
  // -------------------------------------------------------------------------
  // f = 30.44/day cadence (daily), 30-day window => ceil(30.44/30.44 * 30)? Use daily f and 7 days.
  const fDaily = cadenceToRunsPerMonth("daily"); // ~30.44
  // f x days / 30.44 = 30.44 x 7 / 30.44 = exactly 7 (the library snaps sub-epsilon float
  // overshoot so this does not round up to 8).
  ok("retention window 7 days at daily is exactly 7 runs", retentionWindowToRuns(7, fDaily) === 7);
  // Hourly cadence, 1-day window => ceil(730.56 * 1 / 30.44) = ceil(24) = 24.
  ok("retention window 1 day at hourly = 24 runs", retentionWindowToRuns(1, cadenceToRunsPerMonth("hourly")) === 24);
  ok("retention window 0 days => 0 (keep everything)", retentionWindowToRuns(0, fDaily) === 0);
  ok("retention window with 0 runs/month => 0", retentionWindowToRuns(7, 0) === 0);

  // -------------------------------------------------------------------------
  // EDGE: zero churn UNDER CHURN-DEDUP. dA = 0. Accumulate grows only by overhead O; with
  // O=0 it is flat at A0. (This is exactly the claim that was FALSE of the live engine when
  // presented as the default; it is pinned here strictly under the explicit future flag.)
  // -------------------------------------------------------------------------
  const zeroChurn = withDefaults({ ...base, churnFraction: 0 });
  ok("zero-churn edge runs under the explicit churn-dedup flag", zeroChurn.growthModel === "churn-dedup");
  approx("zero churn: dA = 0", churnStoredBytes(zeroChurn.sourceBytes, zeroChurn.churnFraction, zeroChurn.dedupRatio), 0);
  approx("churn-dedup zero churn, O=0: accumulate is flat at A0 for any m", storedBytesAccumulate(zeroChurn, 50), A0);
  approx("zero churn: referencedInitialBytes = A0 (nothing replaced)", referencedInitialBytes(zeroChurn), A0);
  approx("churn-dedup zero churn, O=0: retained steady = A0 + 0*R = A0", storedBytesRetained(zeroChurn), A0);
  // With the default overhead, zero churn still accrues O per run in accumulate.
  const zeroChurnO = withDefaults({ ...base, churnFraction: 0, overheadBytes: DEFAULT_OVERHEAD_BYTES });
  approx("churn-dedup zero churn with O: accumulate m=1 = A0 + O*f", storedBytesAccumulate(zeroChurnO, 1), A0 + DEFAULT_OVERHEAD_BYTES * 30);
  // THE HONEST CONTRAST: under the DEFAULT snapshot model a zero-churn source still grows by
  // a full snapshot per run (the engine re-stores everything every run; a static source is
  // NOT nearly-free after the first seal on the live engine).
  const zeroChurnSnap = withDefaults({ ...params, churnFraction: 0 });
  approx("snapshot zero churn, O=0: accumulate m=1 still grows by A0*f (full snapshot per run)", storedBytesAccumulate(zeroChurnSnap, 1), A0 + A0 * 30);

  // -------------------------------------------------------------------------
  // EDGE: full churn (c = 1) UNDER CHURN-DEDUP. dA = S*d = A0 (every run re-stores the whole
  // logical set as new). referencedInitialBytes -> A0*(1-1)^R = 0 for R>=1. Full churn is the
  // one point where the future model and the live snapshot behaviour coincide.
  // -------------------------------------------------------------------------
  const fullChurn = withDefaults({ ...base, churnFraction: 1 });
  approx("full churn: dA = A0", churnStoredBytes(fullChurn.sourceBytes, fullChurn.churnFraction, fullChurn.dedupRatio), A0);
  approx("full churn: referencedInitialBytes -> 0 for R>=1", referencedInitialBytes(fullChurn), 0);
  // Retained steady (O=0) = 0 + A0*R, which equals the snapshot steady (A0+O)*R at O=0.
  approx("full churn, O=0: retained steady = A0*R", storedBytesRetained(fullChurn), A0 * 10);
  approx("full churn (churn-dedup) coincides with the snapshot steady state", storedBytesRetained(fullChurn), storedBytesRetained(snap));
  // Accumulate m=1 (O=0): A0 + A0*f = A0*(1+30), again coinciding with the snapshot curve.
  approx("full churn, O=0: accumulate m=1 = A0*(1+f)", storedBytesAccumulate(fullChurn, 1), A0 * (1 + 30));
  approx("full churn (churn-dedup) accumulate coincides with the snapshot curve", storedBytesAccumulate(fullChurn, 1), storedBytesAccumulate(snap, 1));

  // -------------------------------------------------------------------------
  // EDGE: zero retention (R = 0) means keep everything; retained degenerates to accumulate.
  // -------------------------------------------------------------------------
  const zeroRet = withDefaults({ ...base, retentionRuns: 0 });
  approx("zero retention: referencedInitialBytes = A0 (keep everything)", referencedInitialBytes(zeroRet), A0);
  approx("zero retention: retained(m=12) == accumulate(m=12)", storedBytesRetained(zeroRet, 12), storedBytesAccumulate(zeroRet, 12));
  approx("zero retention: retained(m=6) == accumulate(m=6)", storedBytesRetained(zeroRet, 6), storedBytesAccumulate(zeroRet, 6));
  // storedBytesRetained with R=0 and the month OMITTED must return a FINITE current snapshot,
  // never Infinity: the finite snapshot is the current size A0.
  ok("storedBytesRetained(R=0, months omitted) is finite", Number.isFinite(storedBytesRetained(zeroRet)));
  approx("storedBytesRetained(R=0, months omitted) = A0 snapshot", storedBytesRetained(zeroRet), A0);
  // Also finite with default overhead present (another path that would have gone non-finite).
  const zeroRetO = withDefaults({ ...base, retentionRuns: 0, overheadBytes: DEFAULT_OVERHEAD_BYTES });
  ok("storedBytesRetained(R=0, with overhead, months omitted) is finite", Number.isFinite(storedBytesRetained(zeroRetO)));
  // costOfRetention with R=0 is ~0 (both regimes identical) at month 12.
  approx("zero retention: costOfRetention ~= 0", costOfRetention(zeroRet, r2, 12), 0, 1e-6);

  // -------------------------------------------------------------------------
  // EDGE: empty inputs (all defaults, S=0) produce all-zero, finite costs (no NaN/Infinity).
  // -------------------------------------------------------------------------
  // Empty inputs: S = 0 and f = 0, so there is no stored size, no writes per month (f = 0),
  // no reads and no egress. A one-off seal and a single marginal run still write the small
  // manifest/capsule constant of objects, so those are a tiny non-zero (manifest-only) cost,
  // which is the honest figure rather than a forced zero.
  const empty = withDefaults({});
  const mcEmpty = monthlyCost(empty, r2, { regime: "accumulate", month: 12 });
  ok("empty inputs: every monthly cost component is 0 and finite", mcEmpty.storage === 0 && mcEmpty.writes === 0 && mcEmpty.reads === 0 && mcEmpty.egress === 0 && mcEmpty.total === 0);
  approx("empty inputs: initialWriteCost is the manifest-only one-off", initialWriteCost(empty, r2), (DEFAULT_MANIFEST_OBJECTS / 1e6) * r2.classAPerMillion);
  approx("empty inputs: perRunCost is the manifest-only write cost", perRunCost(empty, r2), (DEFAULT_MANIFEST_OBJECTS / 1e6) * r2.classAPerMillion);

  // -------------------------------------------------------------------------
  // ROBUSTNESS: negative/NaN pricing can never make a cost negative or non-finite.
  // -------------------------------------------------------------------------
  const badPricing = { storagePerGBMonth: -5, classAPerMillion: Number.NaN, classBPerMillion: -1, egressPerGB: Number.POSITIVE_INFINITY };
  const mcBad = monthlyCost(base, badPricing, { regime: "accumulate", month: 12 });
  ok("bad pricing sanitised: total is finite and >= 0", Number.isFinite(mcBad.total) && mcBad.total >= 0);
}
