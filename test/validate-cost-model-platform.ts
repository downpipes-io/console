// The Cloudflare-platform and capacity ledger: platform cost at paid rates, the run->usage
// estimate, exact op-count tallies, capacity (rate-limit bound), usage scaling, the
// multi-destination 3-2-1 rollup, the combined recurring estimate, the wiggle-margin helpers,
// and the per-source-type breakdown.

import {
  PRESETS,
  withDefaults,
  monthlyCost,
  CF_RATES,
  WORKERS_PAID_BASE_USD,
  SAFETY_MARGIN_DEFAULT,
  platformCost,
  estimateRunUsage,
  usageFromOpCounts,
  capacity,
  replicationCost,
  rollupStorage,
  recurringEstimate,
  applySafetyMargin,
  clampMargin,
  scaleUsage,
} from "../src/lib/cost-model.ts";
import { costBySourceType } from "../src/screens/costs.ts";
import type { RunHistoryEntry } from "../src/api.ts";
import { type Harness, makeBase, obsRun } from "./validate-cost-model-shared.ts";

export function run(h: Harness): void {
  const { ok, approx } = h;
  const base = makeBase();
  const r2 = PRESETS.r2;
  const empty = withDefaults({});

  // -------------------------------------------------------------------------
  // PLATFORM LEDGER: the cost to RUN the backup (Cloudflare resources), priced at PAID rates
  // with NO free-tier assumed (the over-estimate, bill-shock-safe stance). The 10k-KV-a-week
  // example, monthly: ~10000 records x 4.33 runs ~= 43_300 KV reads and 43_300 R2 Class A writes.
  // -------------------------------------------------------------------------
  const kvMonthly = { kvReads: 43_300, r2ClassA: 43_300 };
  const plat = platformCost(kvMonthly);
  // KV reads: 43300/1e6 x 0.50 = 0.02165. R2 Class A: 43300/1e6 x 4.50 = 0.19485. Total 0.2165.
  approx("platform: kv reads priced at paid rate", plat.kvReads, (43_300 / 1e6) * 0.5);
  approx("platform: r2 class A priced at paid rate", plat.r2ClassA, (43_300 / 1e6) * 4.5);
  approx("platform: 10k-KV/week total at paid rates ~= $0.2165/mo", plat.total, 0.2165);
  // Over-estimate stance: the default prices the FULL usage; the free tier is NOT netted off.
  ok("platform: free tier NOT assumed (full usage billable by default)", plat.billableUsage.kvReads === 43_300 && plat.billableUsage.r2ClassA === 43_300);

  // Cloudflare-source-of-truth: pass the confirmed remaining headroom; it only ever lowers cost.
  const platCovered = platformCost(kvMonthly, CF_RATES, { remaining: { kvReads: 50_000, r2ClassA: 50_000 } });
  approx("platform: remaining allowance covering all usage nets to $0", platCovered.total, 0);
  const platPartial = platformCost(kvMonthly, CF_RATES, { remaining: { kvReads: 40_000 } });
  // kv billable = 43300 - 40000 = 3300 -> 0.00165; r2 class A unchanged -> 0.19485; total 0.1965.
  approx("platform: partial remaining nets off only confirmed headroom", platPartial.total, (3_300 / 1e6) * 0.5 + (43_300 / 1e6) * 4.5);

  // -------------------------------------------------------------------------
  // RUN -> USAGE estimate (the bridge until the engine meter reports exact counts) and CAPACITY.
  // -------------------------------------------------------------------------
  const kvUsage = estimateRunUsage({ sourceType: "kv", recordCount: 10_000, segmentsWritten: 10_000 });
  ok("estimate: kv run maps records to KV reads and segments to R2 Class A", kvUsage.kvReads === 10_000 && kvUsage.r2ClassA === 10_000);
  ok("estimate: kv run carries the fixed per-run overhead", kvUsage.workerRequests === 50 && kvUsage.doRequests === 200);
  const cfgUsage = estimateRunUsage({ sourceType: "cf-config", recordCount: 51, segmentsWritten: 51 });
  // A config source reads the control-plane API (capacity), so it bills no KV/R2-read data ops;
  // it still writes its 51 archive segments as R2 Class A PUTs.
  ok("estimate: config run bills no data reads, only segment writes", cfgUsage.kvReads === 0 && cfgUsage.r2ClassB === 0 && cfgUsage.r2ClassA === 51);

  // EXACT op tally (cost Phase 3): usageFromOpCounts maps a measured engine OpCounts to priced usage.
  // KV lists price with KV reads; D1 read queries map to D1 rows read; cf-api/secrets reads are
  // control-plane (not billed per call) and do not enter the dollar usage.
  const fromOps = usageFromOpCounts({ kvRead: 1000, kvList: 50, r2ClassA: 200, r2ClassB: 300, d1Read: 40, cfApiRead: 500, secretsRead: 9, subrequests: 2099 });
  ok("exact: KV reads = kvRead + kvList", fromOps.kvReads === 1050);
  ok("exact: R2 classes map straight through", fromOps.r2ClassA === 200 && fromOps.r2ClassB === 300);
  ok("exact: D1 read queries map to D1 rows read", fromOps.d1RowsRead === 40);
  ok("exact: control-plane reads are not billed data ops (no worker/cpu/do invented)", fromOps.workerRequests === 0 && fromOps.workerCpuMs === 0 && fromOps.doRequests === 0);
  // A broad config backup is capacity-bound, not dollar-bound: 1200 API calls at ~4/s = ~300 s.
  const cap = capacity({ sourceType: "cf-config", recordCount: 1_200, segmentsWritten: 1_200 });
  approx("capacity: 1200 config API calls floor ~= 300 s of wall-clock", cap.apiWallclockSeconds, 300);
  ok("capacity: config API calls are counted (rate-limit bound)", cap.apiCalls === 1_200);

  // scaleUsage turns one run's usage into a monthly figure.
  approx("scaleUsage: one kv run x 4.33 runs/mo ~= 43_300 reads", scaleUsage(kvUsage, 4.33).kvReads, 43_300);

  // -------------------------------------------------------------------------
  // MULTI-DESTINATION ROLLUP (3-2-1): each destination carries its own pricing and stores the
  // same bytes, so storage cost sums across destinations while the stored size does not.
  // -------------------------------------------------------------------------
  const oneDest = monthlyCost(base, r2, { regime: "accumulate", month: 12 });
  const rollOne = rollupStorage(base, [r2], { regime: "accumulate", month: 12 });
  approx("rollup: one destination equals monthlyCost", rollOne.total, oneDest.total);
  const rollTwo = rollupStorage(base, [r2, r2], { regime: "accumulate", month: 12 });
  // F4: a second destination is NOT simply twice the bill. The replicate pass reads the run back
  // out of the ORIGIN to feed the replica, so origin-side reads (and, off R2, egress) are charged
  // on top of the summed per-destination cost. Before this term the estimator returned zero for it.
  const replTwo = replicationCost(base, r2, 1);
  approx("rollup: two destinations sum the per-destination cost plus origin-side replication", rollTwo.total, oneDest.total * 2 + replTwo.reads + replTwo.egress);
  ok("replication: a second destination costs the origin real reads", replTwo.reads > 0);
  ok("replication: an R2 origin egresses free, so only reads are charged", replTwo.egress === 0);
  // The finding this fix exists for: an S3 origin really does egress every replicated byte.
  const s3 = PRESETS["s3-standard"];
  const replS3 = replicationCost(base, s3, 1);
  ok("replication: an S3 origin is charged egress for every replicated byte", replS3.egress > 0);
  ok("replication: two replicas cost twice one replica", Math.abs(replicationCost(base, s3, 2).egress - replS3.egress * 2) < 1e-9);
  const replNone = replicationCost(base, r2, 0);
  ok("replication: a single destination has no replication cost", replNone.reads === 0 && replNone.egress === 0);
  approx("rollup: stored size is per-destination, not doubled", rollTwo.averageStoredBytes, oneDest.averageStoredBytes);
  approx("rollup: no destinations is a zero cost", rollupStorage(base, [], { regime: "accumulate", month: 12 }).total, 0);

  // -------------------------------------------------------------------------
  // COMBINED RECURRING ESTIMATE: storage + platform + plan base, padded by the wiggle margin.
  // Empty inputs make storage 0, so the headline is (0 + platform + base) x (1 + margin).
  // -------------------------------------------------------------------------
  const rec = recurringEstimate(empty, [r2], { monthly: { regime: "accumulate", month: 12 }, usagePerMonth: kvMonthly, safetyMargin: 0.2 });
  approx("recurring: storage ledger is zero for empty inputs", rec.storage.total, 0);
  approx("recurring: platform ledger is the paid-rate figure", rec.platform.total, 0.2165);
  approx("recurring: plan base is the Workers Paid base", rec.basePlan, WORKERS_PAID_BASE_USD);
  approx("recurring: subtotal is storage + platform + base", rec.subtotal, 0 + 0.2165 + 5);
  approx("recurring: total applies the 20% wiggle margin", rec.total, (0 + 0.2165 + 5) * 1.2);
  // The default safety margin is applied when none is given.
  const recDefault = recurringEstimate(empty, [r2], { monthly: { regime: "accumulate", month: 12 }, usagePerMonth: kvMonthly });
  // SAFETY_MARGIN_DEFAULT is pinned to its literal first. The line below reads the margin the estimate
  // applied and compares it to the constant the estimate applied it from, so both sides move together
  // and it cannot fail. The margin only ever raises the headline the customer reads, so a default that
  // drifted to 0.5 would pad every unattended estimate by half with the suite green. WORKERS_PAID_BASE_USD
  // needs no pin here: "recurring: subtotal is storage + platform + base" above states it as the literal 5.
  ok("SAFETY_MARGIN_DEFAULT is 20 per cent", SAFETY_MARGIN_DEFAULT === 0.2);
  approx("recurring: default wiggle margin is SAFETY_MARGIN_DEFAULT", recDefault.safetyMargin, SAFETY_MARGIN_DEFAULT);

  // Wiggle helper and its clamp (a stray slider value can never make a cost negative or absurd).
  approx("wiggle: applySafetyMargin pads by the margin", applySafetyMargin(100, 0.2), 120);
  approx("wiggle: a negative margin clamps to 0", clampMargin(-1), 0);
  approx("wiggle: an absurd margin clamps to the cap", clampMargin(99), 2);

  // -------------------------------------------------------------------------
  // COST BY SOURCE TYPE: the per-source-type breakdown over run history + the downpipe source-type map.
  // -------------------------------------------------------------------------
  const opRun = (id: string, archive: number, segments: number, op: number): RunHistoryEntry => ({
    runId: id, index: 0, startedAt: "2026-01-01T00:00:00Z", status: "ok", archiveBytesWritten: archive, segmentsWritten: segments,
    opCounts: { kvRead: op, kvList: 0, r2ClassA: segments, r2ClassB: 0, d1Read: 0, cfApiRead: 0, secretsRead: 0, subrequests: op + segments },
  });
  const bySrcHistory: Record<string, RunHistoryEntry[]> = {
    "kv-dp": [opRun("k0", 5e8, 500, 1000), opRun("k1", 5e8, 500, 1000)], // KV, with EXACT opCounts
    "d1-dp": [obsRun("d0", 1e7, 10), obsRun("d1b", 1e7, 10)], // D1, no opCounts (estimate path)
    orphan: [obsRun("o0", 9e9, 9000), obsRun("o1", 9e9, 9000)], // no source-type mapping -> skipped
  };
  const srcMap: Record<string, string> = { "kv-dp": "kv", "d1-dp": "d1" }; // "orphan" deliberately absent
  const bySrc = costBySourceType(bySrcHistory, srcMap, [PRESETS.r2]);
  ok("by-source: only mapped source types appear (unmapped ring skipped)", bySrc.length === 2 && bySrc.every((r) => r.sourceType === "kv" || r.sourceType === "d1"));
  ok("by-source: rows sorted by total cost descending", (bySrc[0]?.total ?? 0) >= (bySrc[1]?.total ?? 0));
  const kvRow = bySrc.find((r) => r.sourceType === "kv");
  const d1Row = bySrc.find((r) => r.sourceType === "d1");
  ok("by-source: KV row priced from MEASURED opCounts (exact)", kvRow !== undefined && kvRow.exact === true);
  ok("by-source: D1 row is an estimate (no opCounts)", d1Row !== undefined && d1Row.exact === false);
  ok("by-source: total = storage + platform, finite and >= 0", bySrc.every((r) => Number.isFinite(r.total) && r.total >= 0 && Math.abs(r.total - (r.storageCost + r.platformCost)) < 1e-9));
  ok("by-source: an empty source-type map yields no rows", costBySourceType(bySrcHistory, {}, [PRESETS.r2]).length === 0);

  // MULTI-DESTINATION FAN-OUT: two destinations at the same rates sum the DESTINATION storage (each stores
  // the same bytes) but keep the Cloudflare-platform cost ONCE (the source is read and sealed once), so a
  // row's storageCost doubles while its platformCost is unchanged. This is the property the headline relies
  // on; a naive "double everything" or "double nothing" both fail here.
  const bySrc2 = costBySourceType(bySrcHistory, srcMap, [PRESETS.r2, PRESETS.r2]);
  const kv1 = bySrc.find((r) => r.sourceType === "kv");
  const kv2 = bySrc2.find((r) => r.sourceType === "kv");
  ok("multi-dest: destination storage sums across the fan-out (2 dests => 2x storage)", kv1 !== undefined && kv2 !== undefined && Math.abs(kv2.storageCost - 2 * kv1.storageCost) < 1e-6 && kv1.storageCost > 0);
  ok("multi-dest: row total is the summed storage plus the single platform cost", kv2 !== undefined && Math.abs(kv2.total - (kv2.storageCost + kv2.platformCost)) < 1e-9);

  // Prove the platform-once property is NOT vacuously true at zero: a large workload with a real cadence
  // (distinct run timestamps, so runs/month > 0) makes the platform ledger clearly positive, and it stays
  // unchanged as destinations are added while storage keeps doubling. opRun hardcodes one timestamp (cadence
  // 0 => platform 0), so the two runs here are built with a weekly spacing.
  const bigRun = (id: string, started: string): RunHistoryEntry => ({
    runId: id, index: 0, startedAt: started, status: "ok", archiveBytesWritten: 5e11, segmentsWritten: 5e6,
    opCounts: { kvRead: 5e8, kvList: 0, r2ClassA: 5e6, r2ClassB: 0, d1Read: 0, cfApiRead: 0, secretsRead: 0, subrequests: 5e8 },
  });
  const bigHist: Record<string, RunHistoryEntry[]> = { "big-dp": [bigRun("b0", "2026-01-01T00:00:00Z"), bigRun("b1", "2026-01-08T00:00:00Z")] };
  const bigMap: Record<string, string> = { "big-dp": "kv" };
  const big1 = costBySourceType(bigHist, bigMap, [PRESETS.r2])[0];
  const big2 = costBySourceType(bigHist, bigMap, [PRESETS.r2, PRESETS.r2])[0];
  ok("multi-dest (non-trivial): platform cost is positive and charged ONCE across destinations", big1 !== undefined && big2 !== undefined && big1.platformCost > 0 && Math.abs(big2.platformCost - big1.platformCost) < 1e-6);
  ok("multi-dest (non-trivial): destination storage still sums (2x) on the large workload", big1 !== undefined && big2 !== undefined && big1.storageCost > 0 && Math.abs(big2.storageCost - 2 * big1.storageCost) < 1e-3);
}
