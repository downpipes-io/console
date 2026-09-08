// The marginal-cost, retention-insight and sensitivity builders (pure given inputs + destinations): the
// per-run / per-restore / per-drill marginal costs, the accumulate-vs-retained saving insight, and the
// churn / retention / cadence sensitivity sweeps. Every figure is consumed from lib/cost-model.ts, never
// reimplemented. Across a multi-destination fan-out, the figures that scale with the fan-out (per-run,
// retention saving, the sensitivity sweeps) sum across every destination; a restore or a drill reads from
// ONE copy, so both are priced against the first (primary) destination. House rules: Australian English,
// no em dashes, precise claims.

import { type DataColumn, dataTable } from "../../components/data-table.ts";
import {
  costOfRetention,
  drillCostOnce,
  type Inputs,
  PRESETS,
  type Pricing,
  perRunCost,
  restoreCostOnce,
  type SensitivityPoint,
  sensitivity,
} from "../../lib/cost-model.ts";
import { type Child, h } from "../../lib/dom.ts";
import { groupNumber } from "../../lib/format.ts";
import {
  formatNumberInput,
  HEADLINE_MONTH,
  money,
  plural,
  ratioToPct,
} from "./helpers.ts";

export function buildMarginalCosts(inputs: Inputs, pricings: Pricing[]): HTMLElement {
  const multi = pricings.length > 1;
  // A restore or a drill reads from ONE copy (the first, primary destination), so both are priced there.
  const primary = pricings[0] ?? PRESETS.r2;
  // One more run writes to EVERY destination, so its marginal cost sums across the fan-out.
  const perRun = pricings.reduce((sum, p) => sum + perRunCost(inputs, p), 0);
  // A single restore and a single drill, in their default full-archive basis. The restore is shown as the
  // in-account read-only case (no download) plus, when the primary destination charges egress, the
  // downloaded case, so the operator sees both.
  const drill = drillCostOnce(inputs, primary);
  const restoreInAccount = restoreCostOnce(inputs, primary, { downloaded: false });
  const restoreDownloaded = restoreCostOnce(inputs, primary, { downloaded: true });
  const egressCharged = primary.egressPerGB > 0;
  // Restore and drill read one copy; name that copy only when there is more than one destination.
  const fromPrimary = multi ? " from your first destination" : "";

  const section = h("section", { class: "cost-marginal", style: "margin-top:var(--space-5)", "aria-labelledby": "cost-marg-h" });
  section.appendChild(h("h3", { id: "cost-marg-h", style: "font-size:var(--text-md);margin-bottom:var(--space-2)" }, "Marginal and one-off costs"));
  const grid = h("div", { class: "cost-marginal__grid" });
  grid.appendChild(marginalRow("One additional run", money(perRun), `The marginal cost of one more run: its new stored bytes for a month plus its write operations${multi ? ", summed across every destination" : ""}.`));
  grid.appendChild(marginalRow("One integrity drill", money(drill), `A full-archive drill${fromPrimary}: read operations only, never egress.`));
  grid.appendChild(
    marginalRow(
      "One restore (in account)",
      money(restoreInAccount),
      `A full restore back into the account${fromPrimary}: read operations only when the destination is in-account.`,
    ),
  );
  if (egressCharged) {
    grid.appendChild(
      marginalRow(
        "One restore (downloaded out)",
        money(restoreDownloaded),
        `A full restore downloaded out of the account${fromPrimary}: read operations plus egress on the recovered size at your entered rate.`,
      ),
    );
  }
  section.appendChild(grid);
  return section;
}

function marginalRow(label: string, value: string, sub: string): HTMLElement {
  return h(
    "div",
    { class: "cost-marginal__row card card--inset" },
    h("div", { style: "display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-3)" }, h("span", { style: "font-weight:var(--weight-medium)" }, label), h("span", { class: "tnum" }, value)),
    h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, sub),
  );
}

export function buildRetentionInsight(inputs: Inputs, pricings: Pricing[], accTotal: number, retTotal: number): HTMLElement {
  // The retained-vs-accumulate saving accrues in every destination (each holds the same runs), so it sums
  // across the fan-out; accTotal/retTotal are already the summed headline totals.
  const saving = pricings.reduce((s, p) => s + costOfRetention(inputs, p, HEADLINE_MONTH), 0);
  const card = h("div", { class: "cost-retention card card--inset", style: "margin-top:var(--space-5)", role: "note" });
  let body: string;
  if (inputs.retentionRuns === 0) {
    body =
      "Retention depth is set to keep everything, so the retained projection equals accumulate and there is no modelled saving. Set a retention depth or window above to see what enabling enforcement would bound the cost to.";
  } else if (saving > 0) {
    body = `At month ${HEADLINE_MONTH}, keeping ${groupNumber(inputs.retentionRuns)} ${plural(inputs.retentionRuns, "run")} instead of keeping everything is projected to cost ${money(retTotal)} per month against ${money(accTotal)}, a saving of about ${money(saving)} per month. This is the saving enabling enforcement on that policy would deliver; with enforcement off, nothing is pruned and the accumulate figure is what you are billed.`;
  } else {
    body = `At month ${HEADLINE_MONTH} the retained and accumulate projections are within ${money(Math.abs(saving))} per month at these inputs, so retention does not change the cost materially here. It bounds cost over longer horizons as runs accrue.`;
  }
  card.appendChild(h("div", { style: "font-weight:var(--weight-medium);margin-bottom:var(--space-1)" }, "Retention insight"));
  card.appendChild(h("p", body));
  return card;
}

export function buildSensitivity(inputs: Inputs, pricings: Pricing[]): HTMLElement {
  const section = h("section", { class: "cost-sensitivity", style: "margin-top:var(--space-5)", "aria-labelledby": "cost-sens-h" });
  section.appendChild(h("h3", { id: "cost-sens-h", style: "font-size:var(--text-md);margin-bottom:var(--space-2)" }, "Sensitivity"));
  section.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-bottom:var(--space-3)" },
      `How the projected month-${HEADLINE_MONTH} monthly cost moves as churn, retention depth and cadence change, against your current inputs. Each row shows the swept value, the resulting monthly cost and the change from your baseline.`,
    ),
  );

  // Each sweep is run per destination and summed point by point (same swept values, so points align by
  // index), so the sensitivity matches the summed headline.
  const sweep = (axis: "retention" | "cadence" | "churn"): SensitivityPoint[] =>
    sumSensitivity(pricings.map((p) => sensitivity(inputs, p, axis, { month: HEADLINE_MONTH })));
  const retention = sweep("retention");
  const cadence = sweep("cadence");

  const grid = h("div", { class: "cost-sensitivity__grid", style: "display:flex;flex-wrap:wrap;gap:var(--space-5)" });
  // The churn axis is honest about the growth model: under the default per-run snapshot
  // behaviour churn does not move the cost at all (every run stores a full snapshot), so a
  // churn sweep would be a flat table pretending to be analysis. State that plainly instead;
  // sweep churn only under the cross-run dedup model, where it genuinely drives growth.
  if (inputs.growthModel === "churn-dedup") {
    const churn = sweep("churn");
    grid.appendChild(sensitivityBlock("Churn", churn, (v) => `${formatNumberInput(ratioToPct(v))}%`));
  } else {
    const note = h("div", { class: "cost-sensitivity__block", style: "flex:1 1 240px;min-width:0" });
    note.appendChild(h("h4", { style: "font-size:var(--text-sm);color:var(--text-muted);margin-bottom:var(--space-2)" }, "Churn"));
    note.appendChild(
      h(
        "p",
        { class: "field__hint" },
        "Churn does not move this projection under per-run snapshots; it becomes a cost driver only under the cross-run dedup growth model.",
      ),
    );
    grid.appendChild(note);
  }
  grid.appendChild(sensitivityBlock("Retention depth", retention, (v) => `${groupNumber(v)} ${plural(Math.round(v), "run")}`));
  grid.appendChild(sensitivityBlock("Cadence", cadence, (v) => `${groupNumber(v)} runs/mo`));
  section.appendChild(grid);
  return section;
}

// sumSensitivity adds per-destination sweeps into one: the swept value is identical across destinations
// (same inputs), so points align by index; the monthly cost and the baseline delta are summed, matching
// the summed headline. A single destination (or an empty set) returns unchanged.
function sumSensitivity(sweeps: SensitivityPoint[][]): SensitivityPoint[] {
  const first = sweeps[0];
  if (first === undefined) return [];
  if (sweeps.length === 1) return first;
  return first.map((pt, i) => ({
    value: pt.value,
    monthlyCost: sweeps.reduce((s, sw) => s + (sw[i]?.monthlyCost ?? 0), 0),
    deltaFromBaseline: sweeps.reduce((s, sw) => s + (sw[i]?.deltaFromBaseline ?? 0), 0),
  }));
}

interface SensRow {
  value: string;
  monthly: number;
  delta: number;
}

function sensitivityBlock(title: string, points: SensitivityPoint[], fmtValue: (v: number) => string): HTMLElement {
  const block = h("div", { class: "cost-sensitivity__block", style: "flex:1 1 240px;min-width:0" });
  block.appendChild(h("h4", { style: "font-size:var(--text-sm);color:var(--text-muted);margin-bottom:var(--space-2)" }, title));
  const rows: SensRow[] = points.map((p) => ({ value: fmtValue(p.value), monthly: p.monthlyCost, delta: p.deltaFromBaseline }));
  const columns: Array<DataColumn<SensRow>> = [
    { key: "value", header: title, render: (r) => r.value },
    { key: "monthly", header: "Monthly", numeric: true, render: (r) => money(r.monthly) },
    { key: "delta", header: "Change", numeric: true, render: (r) => deltaCell(r.delta) },
  ];
  const table = dataTable<SensRow>({
    label: `${title} sensitivity`,
    rows,
    rowKey: (r) => r.value,
    columns,
  });
  block.appendChild(table.el);
  return block;
}

function deltaCell(delta: number): Child {
  if (delta === 0) return h("span", { class: "field__hint" }, "baseline");
  const sign = delta > 0 ? "+" : "-";
  // money() already prefixes the currency; the sign sits before it (e.g. "+$1.20").
  return h("span", { class: "tnum" }, `${sign}${money(Math.abs(delta))}`);
}
