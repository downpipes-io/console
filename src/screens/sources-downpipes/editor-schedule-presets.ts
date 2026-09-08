// Schedule interval-preset picker + next-run preview + live KV cost line (flow.md E) for the upsert
// editor, split out of ./editor-upsert.ts (move-only). See ./editor.ts for the barrel.

import { h, svgIcon } from "../../lib/dom.ts";
import { ICON_RUNS, ICON_EXTERNAL } from "../../lib/icons.ts";
import { CADENCE_PRESETS, relForCadence, type SourceType } from "./helpers.ts";
import { buildCostLine } from "./editor-cost-line.ts";

// buildSchedulePresets owns the cadence radiogroup, the next-run preview and the cost line. It owns
// the live cadence value (getCadence) and recomputes the projection on every cadence change. costInputs
// supplies the two things the projection reads from outside this section: the current source type (the
// cost line only shows for KV) and the approximate record count (entered in Advanced). The caller drives
// recalc() from a source-type change and from the count field's input.
export function buildSchedulePresets(
  initialCadence: number,
  costInputs: () => { currentType: SourceType; count: number },
): {
  el: HTMLElement;
  getCadence: () => number;
  setCadence: (seconds: number) => void;
  recalc: () => void;
} {
  let cadence = initialCadence;
  const presetGroup = h("div", { class: "sched-presets", role: "radiogroup", "aria-labelledby": "sched-label" });
  const presetButtons = new Map<number, HTMLButtonElement>();
  for (const p of CADENCE_PRESETS) {
    const checked = p.seconds === cadence;
    const btn = h(
      "button",
      { "data-dp": "sources-downpipes.radio.set-cadence", class: "sched-preset", type: "button", role: "radio", "aria-checked": checked ? "true" : "false", tabindex: checked ? "0" : "-1" },
      h("span", { class: "sched-preset__title" }, p.title),
      h("span", { class: "sched-preset__sub" }, p.sub),
    ) as HTMLButtonElement;
    btn.addEventListener("click", () => setCadence(p.seconds));
    presetButtons.set(p.seconds, btn);
    presetGroup.appendChild(btn);
  }
  // Roving-tabindex arrow-key handler for the schedule-preset radiogroup.
  presetGroup.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft" && ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "Home" && ev.key !== "End") return;
    const order = CADENCE_PRESETS.map((p) => p.seconds);
    const idx = order.indexOf(cadence);
    let next = idx;
    if (ev.key === "ArrowRight" || ev.key === "ArrowDown") next = (idx + 1) % order.length;
    else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") next = (idx - 1 + order.length) % order.length;
    else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = order.length - 1;
    ev.preventDefault();
    setCadence(order[next]!);
    presetButtons.get(order[next]!)!.focus();
  });
  // The sentence lives in ONE span (icon + sentence are the only flex items), so the
  // container's flex gap applies between icon and sentence only, never inside it (the
  // separate text nodes were each a flex item, doubling the gaps around the strong).
  const nextrunSentence = (seconds: number): HTMLElement =>
    h("span", "First run about ", h("strong", relForCadence(seconds)), " after you save.");
  const nextrunPreview = h(
    "div",
    { class: "sched-nextrun" },
    svgIcon(ICON_RUNS, { size: 14 }),
    nextrunSentence(cadence),
  );

  const cost = buildCostLine(() => setCadence(86400));
  const recalc = (): void => {
    const { currentType, count } = costInputs();
    cost.el.style.display = currentType === "kv" ? "" : "none";
    cost.recalc(currentType, cadence, count);
  };

  function setCadence(seconds: number): void {
    cadence = seconds;
    for (const [s, btn] of presetButtons) {
      const sel = s === seconds;
      btn.setAttribute("aria-checked", sel ? "true" : "false");
      btn.tabIndex = sel ? 0 : -1;
    }
    nextrunPreview.replaceChildren(svgIcon(ICON_RUNS, { size: 14 }), nextrunSentence(seconds));
    recalc();
  }

  const el = h(
    "div",
    { class: "field" },
    h("span", { class: "field__label", id: "sched-label" }, "Schedule"),
    presetGroup,
    nextrunPreview,
    // Group-level doc link: the preset radios are one cadence control, so the link
    // explaining the interval and the ~15-minute dispatch floor lives on the group.
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/backing-up/overview#the-fifteen-minute-floor", target: "_blank", rel: "noreferrer noopener" },
      "About backup schedules",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
    cost.el,
  );

  return { el, getCadence: () => cadence, setCadence, recalc };
}
