// The results builder (pure given inputs + a list of destination pricings): the headline, the storage /
// writes / reads / egress split, the one-off seal, the projection table and the two-regime cumulative
// sparkline, the per-run / per-restore / per-drill marginal costs, the retention insight and the
// sensitivity sweeps. The destination cost is SUMMED across every destination (a backup fans out to all of
// them); a restore or drill reads from one copy. Every figure is consumed from lib/cost-model.ts, never
// reimplemented.
// Moved verbatim from the cost coordinator for size; it imports only the shared leaf
// (./helpers.ts), the cost-model library and the design-system components. House rules:
// Australian English, no em dashes, precise claims ("estimate" / "projected").

import {
  addUsage,
  type CapacityEstimate,
  type CostBreakdown,
  capacity,
  type Inputs,
  initialWriteCost,
  PER_RUN_OVERHEAD,
  type Pricing,
  type Projection,
  project,
  type RecurringEstimate,
  type RegimeProjection,
  recurringEstimate,
  rollupStorage,
  scaleUsage,
  usageFromOpCounts,
  usageWithDefaults,
} from "../../lib/cost-model.ts";
import { h } from "../../lib/dom.ts";
import { HEADLINE_MONTH, PROJECTION_MONTHS } from "./helpers.ts";
import {
  buildHeadline,
  buildInitialCost,
  buildPlatformCard,
  buildSourceTypeBreakdown,
  buildSplitTiles,
} from "./results-cards.ts";
import {
  buildMarginalCosts,
  buildRetentionInsight,
  buildSensitivity,
} from "./results-marginal.ts";
import { buildProjection } from "./results-projection.ts";
import type { ResultsCtx } from "./results-types.ts";

// ---------------------------------------------------------------------------
// Results builder (pure given inputs + pricing): the headline, the split, the
// one-off, the projection table + the two-regime cumulative sparkline, the
// per-run / per-restore / per-drill costs, the retention insight, the sensitivity.
// ---------------------------------------------------------------------------

interface BuiltResults {
  el: HTMLElement;
  headlineTotal: number;
}

// ResultsCtx is the render context; defined in the leaf ./results-types.ts to keep the orchestrator and
// the card builders free of a circular import, and re-exported here so the public API is unchanged.
export type { ResultsCtx } from "./results-types.ts";

export function buildResults(inputs: Inputs, pricings: Pricing[], ctx: ResultsCtx): BuiltResults {
  const wrap = h("section", { class: "cost-results", "aria-labelledby": "cost-results-h", style: "margin-top:var(--space-6)" });
  wrap.appendChild(h("h2", { id: "cost-results-h", class: "section-label", style: "margin-bottom:var(--space-3)" }, "Estimate"));

  // When more than one destination is priced, say plainly what the estimate sums (a backup writes to all
  // of them; a restore reads one), so the headline being N times a single destination is never a mystery.
  if (pricings.length > 1) wrap.appendChild(buildMultiDestinationNote(pricings.length));

  // When the FUTURE cross-run dedup model is selected, every figure below is a projection of
  // behaviour that has not shipped; say so before any number, prominently and plainly.
  if (inputs.growthModel === "churn-dedup") wrap.appendChild(buildDedupProjectionNote());

  // The destination-storage ledger (the as-built accumulate basis at the headline month), summed across
  // every destination: each stores the same bytes and is written to on every run, at its own rates.
  const headline: CostBreakdown = rollupStorage(inputs, pricings, { regime: "accumulate", month: HEADLINE_MONTH });
  const retainedHeadline: CostBreakdown = rollupStorage(inputs, pricings, { regime: "retained", month: HEADLINE_MONTH });

  // The Cloudflare-platform ledger (the cost to RUN the backup) and the per-run capacity, derived from
  // the same inputs and the headline object count.
  const { recurring, cap, exact } = computePlatformLedger(inputs, pricings, ctx, headline);

  // The headline is the FULL recurring monthly cost (storage + Cloudflare resources + plan base),
  // padded by the wiggle-room safety margin; the breakdown sits beneath it so it is never a mystery.
  wrap.appendChild(buildHeadline(recurring, inputs, ctx));
  wrap.appendChild(buildPlatformCard(recurring, cap, exact));

  // Per-source-type breakdown (when run history + the source-type map are available): what each kind of
  // source costs to back up. Observed-only, so it appears once there are runs to attribute.
  if (ctx.sourceTypeRows !== undefined && ctx.sourceTypeRows.length > 0) {
    wrap.appendChild(buildSourceTypeBreakdown(ctx.sourceTypeRows));
  }

  // Destination-storage detail (the split that makes up the storage ledger in the headline).
  wrap.appendChild(h("h3", { style: "font-size:var(--text-md);margin:var(--space-5) 0 var(--space-2)" }, "Destination storage"));
  wrap.appendChild(buildSplitTiles(headline));

  // The one-off initial seal cost, summed across destinations: the first seal is written to each.
  const initial = pricings.reduce((sum, p) => sum + initialWriteCost(inputs, p), 0);
  wrap.appendChild(buildInitialCost(initial));

  // The projection table + the two-regime cumulative-cost sparkline, summed across destinations.
  const projection = sumProjections(pricings.map((p) => project(inputs, p, PROJECTION_MONTHS)));
  wrap.appendChild(buildProjection(projection));

  // Per-run, per-restore, per-drill marginal costs (per-run sums across destinations; a restore or drill
  // reads from the primary copy).
  wrap.appendChild(buildMarginalCosts(inputs, pricings));

  // The retention insight (accumulate vs retained at the headline month), across all destinations.
  wrap.appendChild(buildRetentionInsight(inputs, pricings, headline.total, retainedHeadline.total));

  // The sensitivity view (churn / retention / cadence sweeps as small deltas), across all destinations.
  wrap.appendChild(buildSensitivity(inputs, pricings));

  return { el: wrap, headlineTotal: recurring.total };
}

// buildDedupProjectionNote renders the prominent "this is a projection, not as-built" note shown
// when the cross-run dedup growth model is selected (the mechanism itself is taught at the
// growth-model control, not re-taught here).
function buildDedupProjectionNote(): HTMLElement {
  return h(
    "div",
    { class: "card card--inset", role: "note", style: "margin-bottom:var(--space-3)" },
    h(
      "p",
      h("strong", "Cross-run dedup projection. "),
      "These figures model storage growth as churn only and apply only once cross-run dedup ships; switch the growth model back to per-run snapshots for the as-built estimate.",
    ),
  );
}

// buildMultiDestinationNote renders the plain statement, shown when more than one destination is priced,
// that the estimate sums the destination cost across the fan-out (a backup writes to every destination)
// while a restore or drill reads from one copy. It keeps the headline being a multiple of a single
// destination from ever looking like a mistake.
function buildMultiDestinationNote(count: number): HTMLElement {
  return h(
    "div",
    { class: "card card--inset", role: "note", style: "margin-bottom:var(--space-3)" },
    h(
      "p",
      h("strong", `Across ${count} destinations. `),
      "Storage, write and platform cost are summed over every destination below, because each backup run writes to all of them. A restore or a drill reads from one copy, so those figures are priced against the first destination.",
    ),
  );
}

// sumProjections adds the per-destination projections into one. The destination-storage cost fans out
// (each destination stores the same bytes at its own rates), so the cumulative cost and the one-off
// initial seal are summed point by point; the stored SIZE is identical per destination, so it is taken
// from the first, not summed (mirroring rollupStorage). All projections share the same month markers
// (same inputs), so their points align by index. A single destination returns unchanged.
function sumProjections(projs: Projection[]): Projection {
  const first = projs[0];
  if (first === undefined) return { accumulate: { initialCost: 0, points: [] }, retained: { initialCost: 0, points: [] } };
  if (projs.length === 1) return first;
  const sumRegime = (pick: (p: Projection) => RegimeProjection): RegimeProjection => ({
    initialCost: projs.reduce((s, p) => s + pick(p).initialCost, 0),
    points: pick(first).points.map((pt, i) => ({
      month: pt.month,
      storedBytes: pt.storedBytes,
      cumulativeCost: projs.reduce((s, p) => s + (pick(p).points[i]?.cumulativeCost ?? 0), 0),
    })),
  });
  return { accumulate: sumRegime((p) => p.accumulate), retained: sumRegime((p) => p.retained) };
}

interface PlatformLedger {
  recurring: RecurringEstimate;
  cap: CapacityEstimate;
  // exact is true when the platform figure came from the run history's measured op tally (cost Phase 3).
  exact: boolean;
}

// computePlatformLedger prices the Cloudflare-platform ledger (the cost to RUN the backup) and the
// per-run capacity, from the same inputs and the headline object count. Archive writes are the objects
// written per month; source reads are OVER-estimated as the same count at the most expensive read rate,
// because the source mix is not known at this account-wide view (erring high is the bill-shock-safe
// direction); plus the fixed per-run overhead scaled by the cadence. When the run history carries the
// engine's EXACT per-resource op tally (cost Phase 3) AND the screen is in Observed mode, that is priced
// instead, scaled to the month, plus the per-run compute overhead the meter cannot see (Worker
// requests/CPU and Durable Object duration are not subrequests). The figure sharpens automatically as
// runs report opCounts.
//
// Gating on mode here, not only on the seed's presence, keeps the arithmetic honest with the label it
// produces: a Manual-mode scenario is priced the same estimated way as every other hand-entered figure on
// this screen, and "measured" is true exactly when it is shown.
function computePlatformLedger(inputs: Inputs, pricings: Pricing[], ctx: ResultsCtx, headline: CostBreakdown): PlatformLedger {
  const f = Math.max(0, inputs.runsPerMonth);
  const exactOps = ctx.mode === "observed" ? ctx.opCountsPerRun : undefined;
  const usagePerMonth = exactOps
    ? scaleUsage(addUsage(usageFromOpCounts(exactOps), PER_RUN_OVERHEAD), f)
    : addUsage(scaleUsage(PER_RUN_OVERHEAD, f), usageWithDefaults({ r2ClassA: headline.objectsWrittenPerMonth, kvReads: headline.objectsWrittenPerMonth }));
  // recurringEstimate rolls the destination-storage ledger up across every destination (each stores the
  // same bytes and is written on every run, at its own rates); the Cloudflare-platform ledger is the cost
  // to RUN the backup, computed once from the run's object count (the source is read and sealed once).
  const recurring = recurringEstimate(inputs, pricings, {
    monthly: { regime: "accumulate", month: HEADLINE_MONTH },
    usagePerMonth,
    safetyMargin: ctx.safetyMargin,
  });

  // Capacity/feasibility for ONE run: turn the per-month object count back into per-run subrequests and
  // Worker invocations, so the operator sees the platform LOAD a run imposes, not only its dollar cost.
  const objectsPerRun = f > 0 ? headline.objectsWrittenPerMonth / f : headline.objectsWrittenPerMonth;
  const cap = capacity({ sourceType: "kv", recordCount: objectsPerRun, segmentsWritten: objectsPerRun });

  return { recurring, cap, exact: exactOps !== undefined };
}
