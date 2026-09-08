// Live KV cost-projection line for the upsert editor (KV only), split out of ./editor-upsert.ts
// (move-only, console-src-053). See ./editor.ts for the barrel.
//
// role=status + aria-live so a change is announced; the warn classification adds an icon + label,
// never colour alone. It recalculates from the approx record count (in Advanced) + the cadence.

import { h, svgIcon } from "../../lib/dom.ts";
import { groupNumber } from "../../lib/format.ts";
import { ICON_ALERT, ICON_INFO } from "../../lib/icons.ts";
import { projectMonthlyKVReads } from "../../api.ts";
import { cadenceSecondsToRunsPerMonth } from "../../lib/cost-model.ts";
import { BILL_SHOCK_THRESHOLD } from "./helpers.ts";

// buildCostLine builds the cost-line element and exposes recalc(currentType, cadence, count): the
// caller drives it from setType / setCadence / the count field's input. onUseDaily fires when the
// "Use daily" steer button is clicked (the editor switches the cadence to 86400).
export function buildCostLine(onUseDaily: () => void): {
  el: HTMLElement;
  recalc: (currentType: string, cadence: number, count: number) => void;
} {
  const costIcon = h("span");
  const costNum = h("span", { class: "cost-line__num" });
  const costRuns = h("span", { class: "mono" });
  const costMain = h("span", costNum, " KV reads per month at this cadence (", costRuns, " runs).");
  const costDetail = h("div", { class: "cost-line__detail" });
  const useDailyBtn = h("button", { "data-dp": "sources-downpipes.button.use-daily", class: "btn btn--secondary btn--sm cost-line__steer", type: "button", on: { click: () => onUseDaily() } }, "Use daily");
  const el = h(
    "div",
    { class: "cost-line", role: "status", "aria-live": "polite" },
    costIcon,
    h("div", { class: "cost-line__body" }, costMain, costDetail, useDailyBtn),
  );

  const recalc = (currentType: string, cadence: number, count: number): void => {
    if (currentType !== "kv") return;
    // The SAME average month the read projection below is computed over (DAYS_PER_MONTH, 30.44).
    // This line used to recompute the run count from a local 30-day month while
    // projectMonthlyKVReads divided by its own 30-day constant, so the two happened to agree with
    // each other and both disagreed with every runs-per-month figure on the costs screen.
    const runsPerMonth = Math.round(cadenceSecondsToRunsPerMonth(cadence));
    const reads = projectMonthlyKVReads(count, cadence);
    costNum.textContent = groupNumber(reads);
    costRuns.textContent = groupNumber(runsPerMonth);
    const high = reads > BILL_SHOCK_THRESHOLD;
    el.classList.toggle("cost-line--warn", high);
    // With no record count entered there is nothing to project: hide the zero
    // projection line (a "0 reads" headline reads as a claim, not a placeholder)
    // and let the one prompt line carry the run count instead.
    costMain.hidden = count === 0;
    if (count === 0) {
      costDetail.textContent = `Enter an approximate record count in Advanced to project monthly KV reads (${groupNumber(runsPerMonth)} runs at this cadence).`;
      useDailyBtn.style.display = "none";
      costIcon.replaceChildren(svgIcon(ICON_INFO, { size: 16 }));
    } else if (high) {
      costDetail.textContent = "KV has no change feed, so each run reads every record. Consider a daily cadence for a namespace this large.";
      useDailyBtn.style.display = cadence === 86400 ? "none" : "inline-flex";
      costIcon.replaceChildren(svgIcon(ICON_ALERT, { size: 16 }));
    } else {
      costDetail.textContent = "Within a reasonable budget for this namespace at this cadence.";
      useDailyBtn.style.display = "none";
      costIcon.replaceChildren(svgIcon(ICON_INFO, { size: 16 }));
    }
  };

  return { el, recalc };
}
