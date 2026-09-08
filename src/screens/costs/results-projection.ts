// The projection builder (pure given inputs + pricing): the projection table at months 1, 3, 6 and 12
// for both regimes and the two-regime cumulative-cost sparklines. Every figure is consumed from
// lib/cost-model.ts, never reimplemented. Moved verbatim from ./results.ts for size; behaviour is
// unchanged. House rules: Australian English, no em dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { sparkline } from "../../components/sparkline.ts";
import { dataTable, type DataColumn } from "../../components/data-table.ts";
import { humanBytes } from "../../lib/format.ts";
import { HEADLINE_MONTH, money } from "./helpers.ts";
import type { Projection } from "../../lib/cost-model.ts";

// Sparkline geometry (px) for each regime chart, sized to the cost-charts flex column
// (flex-basis 240px). Kept as named constants per house rules on magic numbers.
const COST_SPARKLINE_WIDTH = 260;
const COST_SPARKLINE_HEIGHT = 56;

interface ProjRow {
  month: number;
  accBytes: number;
  accCost: number;
  retBytes: number;
  retCost: number;
}

export function buildProjection(projection: Projection): HTMLElement {
  const section = h("section", { class: "cost-projection", style: "margin-top:var(--space-5)", "aria-labelledby": "cost-proj-h" });
  section.appendChild(h("h3", { id: "cost-proj-h", style: "font-size:var(--text-md);margin-bottom:var(--space-2)" }, "Projection over time"));
  section.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-bottom:var(--space-3)" },
      "Cumulative stored size and cumulative cost at months 1, 3, 6 and 12, with and without retention. Accumulate is the as-built reality; retained-with-GC is what a retention policy would bound it to.",
    ),
  );

  // Join the two regimes' points by month into table rows.
  const rows = joinProjection(projection);

  const columns: Array<DataColumn<ProjRow>> = [
    { key: "month", header: "Month", numeric: true, render: (r) => String(r.month) },
    { key: "accBytes", header: "Stored (accumulate)", numeric: true, render: (r) => humanBytes(r.accBytes) },
    { key: "accCost", header: "Cost to date (accumulate)", numeric: true, render: (r) => money(r.accCost) },
    { key: "retBytes", header: "Stored (retained)", numeric: true, render: (r) => humanBytes(r.retBytes) },
    { key: "retCost", header: "Cost to date (retained)", numeric: true, render: (r) => money(r.retCost) },
  ];

  const table = dataTable<ProjRow>({
    label: "Cost projection by month, with and without retention",
    rows,
    rowKey: (r) => String(r.month),
    columns,
  });
  section.appendChild(table.el);

  // The cumulative-cost sparklines for BOTH regimes, each with its own text alternative
  // and the projection table above as the data equivalent. Reduced motion is respected
  // by the sparkline component (static geometry, no animated transition). When retention
  // is unset the two curves are the same series, so ONE chart renders with a quiet note
  // saying so, rather than two identical unlabelled lines.
  const accSeries = rows.map((r) => r.accCost);
  const retSeries = rows.map((r) => r.retCost);
  const curvesIdentical = rows.every((r) => r.retCost === r.accCost);
  const charts = h("div", { class: "cost-charts", style: "display:flex;flex-wrap:wrap;gap:var(--space-5);margin-top:var(--space-4)" });
  if (curvesIdentical) {
    charts.appendChild(regimeChart("Cumulative cost", accSeries, "accent"));
    section.appendChild(charts);
    section.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "Retention unset: the two curves are identical."));
  } else {
    charts.appendChild(regimeChart("Accumulate cumulative cost", accSeries, "accent"));
    charts.appendChild(regimeChart("Retained cumulative cost", retSeries, "trust"));
    section.appendChild(charts);
  }

  return section;
}

function regimeChart(title: string, series: number[], tone: "accent" | "trust"): HTMLElement {
  const wrap = h("figure", { class: "cost-chart", style: "margin:0;flex:1 1 240px;min-width:0" });
  const last = series.length ? series[series.length - 1] ?? 0 : 0;
  const first = series.length ? series[0] ?? 0 : 0;
  // The caption carries the final projected figure so the chart is readable on its own,
  // not an unlabelled stretched line whose scale lives only in the table above.
  wrap.appendChild(
    h(
      "figcaption",
      { class: "field__hint", style: "margin-bottom:var(--space-1);display:flex;align-items:baseline;gap:var(--space-2);flex-wrap:wrap" },
      title,
      h("strong", { class: "tnum", style: "color:var(--text)" }, money(last)),
    ),
  );
  const dir = last > first ? "rising" : last < first ? "falling" : "flat";
  wrap.appendChild(
    sparkline({
      values: series,
      tone,
      area: true,
      width: COST_SPARKLINE_WIDTH,
      height: COST_SPARKLINE_HEIGHT,
      label: `${title}: ${money(last)} by month ${HEADLINE_MONTH}, ${dir} over the projection. Exact figures are in the table above.`,
    }),
  );
  return wrap;
}

// joinProjection joins the two regimes' projection points by month into table rows. The two
// regimes share the same month markers (project() sorts + de-dupes both with the same input),
// so this index-aligns by month, building a month -> retained-point map to be robust to ordering.
function joinProjection(projection: Projection): ProjRow[] {
  const retByMonth = new Map<number, { storedBytes: number; cumulativeCost: number }>();
  for (const p of projection.retained.points) retByMonth.set(p.month, { storedBytes: p.storedBytes, cumulativeCost: p.cumulativeCost });
  const rows: ProjRow[] = [];
  for (const p of projection.accumulate.points) {
    const ret = retByMonth.get(p.month);
    rows.push({
      month: p.month,
      accBytes: p.storedBytes,
      accCost: p.cumulativeCost,
      retBytes: ret ? ret.storedBytes : p.storedBytes,
      retCost: ret ? ret.cumulativeCost : p.cumulativeCost,
    });
  }
  return rows;
}
