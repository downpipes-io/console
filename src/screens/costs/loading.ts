// The cost calculator's loading skeleton: a placeholder tracing the real screen shape
// (mode/banner block, two-column form-field skeleton, then results: headline + table +
// chart placeholders), so the transition into the loaded screen is smooth rather than a
// generic tile grid. Moved verbatim from view.ts for size; it is a pure DOM builder with
// no instance state. House rules: Australian English, no em dashes.

import { h } from "../../lib/dom.ts";
import { skeletonTiles } from "../../components/feedback.ts";

// buildLoadingSkeleton returns the cost screen's loading placeholder. It traces the real
// screen anatomy so the transition is smooth, rather than a generic 4-tile grid.
export function buildLoadingSkeleton(): HTMLElement {
  const wrap = h("div", { class: "cost-skeleton", "aria-hidden": "true" });

  // Mode + banner block.
  const modeBanner = h("div", { style: "margin-bottom:var(--space-4)" });
  modeBanner.appendChild(h("div", { class: "skeleton skeleton-row", style: "width:120px;margin-bottom:var(--space-2)" }));
  modeBanner.appendChild(h("div", { class: "skeleton skeleton-row", style: "width:80%;margin-bottom:var(--space-2)" }));
  wrap.appendChild(modeBanner);

  // Two-column form-field skeleton (inputs | pricing), matching formGridStyle().
  const formGrid = h("div", { style: "display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--space-5);margin-top:var(--space-2)" });
  const inputsCol = h("div");
  for (let i = 0; i < 5; i++) inputsCol.appendChild(h("div", { class: "skeleton skeleton-row", style: "margin-bottom:var(--space-3)" }));
  const pricingCol = h("div");
  for (let i = 0; i < 4; i++) pricingCol.appendChild(h("div", { class: "skeleton skeleton-row", style: "margin-bottom:var(--space-3)" }));
  formGrid.appendChild(inputsCol);
  formGrid.appendChild(pricingCol);
  wrap.appendChild(formGrid);

  // Results section skeleton: headline value + split tiles row + table rows + two chart bars.
  const resultsBlock = h("div", { style: "margin-top:var(--space-6)" });
  resultsBlock.appendChild(h("div", { class: "skeleton skeleton-row", style: "width:200px;height:2.5rem;margin-bottom:var(--space-3)" }));
  resultsBlock.appendChild(skeletonTiles(4));
  resultsBlock.appendChild(h("div", { class: "skeleton-block", style: "margin-top:var(--space-4)" }, ...Array.from({ length: 4 }, () => h("div", { class: "skeleton skeleton-row" }))));
  const chartRow = h("div", { style: "display:flex;gap:var(--space-5);margin-top:var(--space-4)" });
  chartRow.appendChild(h("div", { class: "skeleton", style: "flex:1 1 240px;height:56px;border-radius:var(--radius-sm)" }));
  chartRow.appendChild(h("div", { class: "skeleton", style: "flex:1 1 240px;height:56px;border-radius:var(--radius-sm)" }));
  resultsBlock.appendChild(chartRow);
  wrap.appendChild(resultsBlock);

  return wrap;
}
