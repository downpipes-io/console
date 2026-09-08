// The cost calculator's inputs section: source size, stored ratio, schedule cadence, growth
// model, churn (with the low/expected/high quick-set), retention (depth or window) and the
// per-month ops fields. Moved verbatim from view.ts for size; each builder takes the CostInputsHost
// so it can read the active inputs and route every edit through the single patchActive mutation
// path (which clamps and recomputes), exactly as when these were instance methods. House rules:
// Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { field } from "../../components/field.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import { groupNumber } from "../../lib/format.ts";
import {
  cadenceToRunsPerMonth,
  cadenceSecondsToRunsPerMonth,
  retentionWindowToRuns,
  withDefaults,
  type GrowthModel,
  type Inputs,
  type Cadence,
} from "../../lib/cost-model.ts";
import {
  formatNumberInput,
  type ByteUnit,
  bytesToUnit,
  unitToBytes,
  byteUnitOptions,
  ratioToPct,
  pctToRatio,
  matchCadence,
  runsPerMonthToMinutes,
  runsToWindowDays,
  parseNonNeg,
  parsePositive,
  parsePct,
  nonNegNumberError,
  positiveNumberError,
  pctError,
  plural,
} from "./helpers.ts";

// CostInputsHost is the slice of the CostView the inputs builders read and mutate. Keeping it
// to this interface makes the move behaviour-preserving: the builders call exactly the same
// instance methods they did before, now via the host.
export interface CostInputsHost {
  activeInputs(): Inputs;
  setActiveInputs(next: Inputs): void;
  patchActive(patch: Partial<Inputs>, opts?: { skipAnnounce?: boolean }): void;
  renderShell(): void;
  announce(message: string): void;
}

export function buildInputsSection(host: CostInputsHost): HTMLElement {
  const inputs = host.activeInputs();
  const section = h("section", { class: "card cost-inputs", "aria-labelledby": "cost-inputs-h" });
  section.appendChild(h("h2", { id: "cost-inputs-h", class: "card__title", style: "font-size:var(--text-md);margin-bottom:var(--space-1)" }, "Inputs"));
  section.appendChild(h("p", { class: "field__hint", style: "margin-bottom:var(--space-4)" }, "Source, schedule, churn and retention. Bounded inputs are clamped to their valid ranges; your entry is never lost."));

  // Source size (bytes), entered in a friendly unit + a dedup percentage.
  section.appendChild(sourceSizeField(host, inputs));
  section.appendChild(dedupField(host, inputs));

  // Schedule cadence (mirrors the downpipe schedule), as a select of the standard
  // cadences plus a derived runs-per-month read-out.
  section.appendChild(cadenceField(host, inputs));

  // The growth model: per-run snapshots (the live engine's behaviour, the default) or
  // the clearly-labelled future cross-run dedup projection.
  section.appendChild(growthModelField(host, inputs));

  // Churn fraction with low / expected / high quick-set (drives growth only under the
  // future cross-run dedup model).
  section.appendChild(churnField(host, inputs));

  // Retention depth (runs) or a window in days.
  section.appendChild(retentionField(host, inputs));

  // Drills and restores per month.
  section.appendChild(opsFields(host, inputs));

  return section;
}

// sourceSizeField: a number + a unit select (GB/TB), composed into a single .field row.
// The stored value is bytes; the displayed value is the number in the chosen unit.
function sourceSizeField(host: CostInputsHost, inputs: Inputs): HTMLElement {
  const { value, unit } = bytesToUnit(inputs.sourceBytes);
  // The hint is rendered as a sibling BELOW the row (not inside the field) so the field's bottom edge is the
  // input itself; otherwise the in-field hint made the .field taller than the unit select, dropping the GB
  // select ~2 lines below the number on a phone (the row aligns to the input, not the hint).
  const num = field({
    id: "cost-source",
    label: "Source size",
    type: "number",
    placeholder: "500",
    value: formatNumberInput(value),
    validate: (v) => nonNegNumberError(v, "Source size"),
    onInput: (v) => {
      const parsed = parseNonNeg(v);
      if (parsed === null) return; // invalid is surfaced by validate(); do not patch a NaN
      host.patchActive({ sourceBytes: unitToBytes(parsed, unitSelect.value as ByteUnit) });
    },
  });
  num.control.setAttribute("aria-describedby", "cost-source-hint");
  const unitSelect = h("select", { "data-dp": "costs.select.unit", class: "select cost-unit", "aria-label": "Source size unit" }, ...byteUnitOptions(unit)) as HTMLSelectElement;
  unitSelect.addEventListener("change", () => {
    // Re-interpret the CURRENT number in the new unit (the operator changed the unit,
    // not the magnitude); read the live number from the control.
    const parsed = parseNonNeg(num.control.value);
    if (parsed === null) return;
    host.patchActive({ sourceBytes: unitToBytes(parsed, unitSelect.value as ByteUnit) });
  });
  // Compose the number field and the unit select on one row, with the hint beneath the whole row.
  // The trailer reserves a label line so its select sits on the number's line rather than on the
  // bottom edge of a box whose height an error can change. The spacer is a real
  // `.field__label` so it is exactly the line box the sibling label occupies; it is aria-hidden
  // because the select already carries its own accessible name.
  const unitSpacer = h("span", { class: "field__label", "aria-hidden": "true" }, "\u00a0");
  const row = h("div", { class: "cost-field-row" }, num.el, h("div", { class: "cost-field-row__unit" }, unitSpacer, unitSelect));
  const hint = h("p", { class: "field__hint", id: "cost-source-hint" }, "The source logical size, in the unit selected beside it (MB, GB or TB). Stored size is this figure times the stored ratio below.");
  // Group-level doc link (audit G2): the number and its unit select are one control, so the link that
  // explains source size sits below the whole row rather than nested inside the number field (which
  // would make .field taller than the unit select, the same misalignment the sibling hint avoids).
  const doc = h(
    "a",
    { class: "field__doc linklike", href: "https://docs.downpipes.io/day-2/cost-prediction#manual-mode-and-observed-mode", target: "_blank", rel: "noreferrer noopener" },
    "About source size",
    svgIcon(ICON_EXTERNAL, { size: 13 }),
  );
  return h("div", { class: "cost-field" }, row, hint, doc);
}

function dedupField(host: CostInputsHost, inputs: Inputs): HTMLElement {
  const pct = ratioToPct(inputs.dedupRatio);
  return field({
    id: "cost-dedup",
    label: "Stored ratio",
    type: "number",
    placeholder: "60",
    value: formatNumberInput(pct),
    hint: "Stored bytes as a percentage of logical size, capturing within-run dedup plus compression. The default is 60 per cent (a conservative 40 per cent reduction). Between 1 and 100.",
    doc: { href: "https://docs.downpipes.io/day-2/cost-prediction", anchor: "manual-mode-and-observed-mode" },
    validate: (v) => pctError(v, "Stored ratio", 1),
    onInput: (v) => {
      const parsed = parsePct(v, 1);
      if (parsed === null) return;
      host.patchActive({ dedupRatio: pctToRatio(parsed) });
    },
  }).el;
}

// growthModelField selects how per-run growth is modelled: per-run snapshots (the live
// engine's behaviour, the honest default) or cross-run dedup (a recorded SPEC-level
// decision, not current behaviour; the projection applies only once it ships). The whole
// shell is rebuilt on change so the churn field, sensitivity blocks and copy all reflect
// the chosen model consistently.
function growthModelField(host: CostInputsHost, inputs: Inputs): HTMLElement {
  const sel = field({
    id: "cost-growth-model",
    label: "Growth model",
    kind: "select",
    value: inputs.growthModel,
    hint: "Per-run snapshots is the engine as it runs today: the content-address key derives from the per-run master, so dedup applies only within a run and every run stores a full snapshot. Cross-run dedup is a recorded SPEC-level decision, not current behaviour; that projection applies only once it ships.",
    doc: { href: "https://docs.downpipes.io/day-2/cost-prediction", anchor: "the-growth-model-storage-grows-with-runs-not-churn" },
    options: [
      { value: "snapshot", label: "Per-run snapshots (current engine behaviour)" },
      { value: "churn-dedup", label: "Cross-run dedup (future; applies only once it ships)" },
    ],
  });
  sel.control.addEventListener("change", () => {
    const choice: GrowthModel = sel.control.value === "churn-dedup" ? "churn-dedup" : "snapshot";
    const next = withDefaults({ ...host.activeInputs(), growthModel: choice });
    host.setActiveInputs(next);
    // Rebuild the whole shell (not just the results): the churn field's relevance, the
    // sensitivity blocks and the labels all change with the model.
    host.renderShell();
    host.announce(
      choice === "snapshot"
        ? "Growth model set to per-run snapshots, the current engine behaviour."
        : "Growth model set to cross-run dedup, a projection that applies only once cross-run dedup ships.",
    );
  });
  return sel.el;
}

function cadenceField(host: CostInputsHost, inputs: Inputs): HTMLElement {
  // Map the current runs-per-month back to a named cadence when it matches one, else
  // mark "custom" and show the derived figure. The operator picks a named cadence; a
  // custom interval is supported via the seconds field shown for "custom".
  const matched = matchCadence(inputs.runsPerMonth);
  const wrap = h("div", { class: "cost-field" });
  const sel = field({
    id: "cost-cadence",
    label: "Schedule cadence",
    kind: "select",
    value: matched ?? "custom",
    hint: "How often the backup runs. This mirrors the downpipe schedule. Choose a cadence, or Custom to enter an interval.",
    doc: { href: "https://docs.downpipes.io/day-2/cost-prediction", anchor: "manual-mode-and-observed-mode" },
    options: [
      { value: "every15min", label: "Every 15 minutes" },
      { value: "hourly", label: "Hourly" },
      { value: "every6h", label: "Every 6 hours" },
      { value: "daily", label: "Daily" },
      { value: "weekly", label: "Weekly" },
      { value: "custom", label: "Custom interval" },
    ],
  });
  wrap.appendChild(sel.el);

  // The custom-interval field (minutes), shown only when "custom" is selected.
  const customWrap = h("div", { class: "cost-cadence-custom", style: matched ? "display:none" : "" });
  const minutes = matched ? "" : formatNumberInput(runsPerMonthToMinutes(inputs.runsPerMonth));
  const customField = field({
    id: "cost-cadence-custom",
    label: "Custom interval (minutes)",
    type: "number",
    placeholder: "120",
    value: minutes,
    hint: "The interval between runs, in minutes; must be greater than zero. Runs per month are derived from it.",
    doc: { href: "https://docs.downpipes.io/day-2/cost-prediction", anchor: "manual-mode-and-observed-mode" },
    validate: (v) => positiveNumberError(v, "Custom interval"),
    onInput: (v) => {
      const parsed = parsePositive(v);
      if (parsed === null) return;
      host.patchActive({ runsPerMonth: cadenceSecondsToRunsPerMonth(parsed * 60) });
    },
  });
  customWrap.appendChild(customField.el);
  wrap.appendChild(customWrap);

  // A derived runs-per-month read-out (real text, not only the chart).
  const derived = h("p", { class: "field__hint cost-derived", style: "margin-top:var(--space-1)" });
  const setDerived = (rpm: number) => {
    derived.textContent = `Projected ${groupNumber(rpm)} ${plural(Math.round(rpm), "run")} per month.`;
  };
  setDerived(inputs.runsPerMonth);
  wrap.appendChild(derived);

  sel.control.addEventListener("change", () => {
    const choice = sel.control.value as Cadence | "custom";
    if (choice === "custom") {
      customWrap.style.display = "";
      // Seed the custom field from the current cadence so the figure does not jump to 0.
      const cur = host.activeInputs().runsPerMonth;
      (customField.control as HTMLInputElement).value = formatNumberInput(runsPerMonthToMinutes(cur));
      setDerived(cur);
      // Do not patch on switching to custom; wait for the operator's interval entry.
      return;
    }
    customWrap.style.display = "none";
    const rpm = cadenceToRunsPerMonth(choice);
    setDerived(rpm);
    host.patchActive({ runsPerMonth: rpm });
  });

  return wrap;
}

function churnField(host: CostInputsHost, inputs: Inputs): HTMLElement {
  const wrap = h("div", { class: "cost-field" });
  const pct = ratioToPct(inputs.churnFraction);
  const snapshotModel = inputs.growthModel === "snapshot";
  const churn = field({
    id: "cost-churn",
    label: "Churn per run",
    type: "number",
    placeholder: "5",
    value: formatNumberInput(pct),
    // The snapshot mechanism is taught once, at the growth-model control above;
    // this hint only states the consequence for THIS field.
    hint: snapshotModel
      ? "The percentage of logical content new or changed since the previous run, between 0 and 100. No effect under per-run snapshots; it drives growth only under cross-run dedup."
      : "The percentage of logical content new or changed since the previous run; under cross-run dedup it drives the storage that accrues. Between 0 and 100.",
    doc: { href: "https://docs.downpipes.io/day-2/cost-prediction", anchor: "the-growth-model-storage-grows-with-runs-not-churn" },
    validate: (v) => pctError(v, "Churn per run", 0),
    onInput: (v) => {
      const parsed = parsePct(v, 0);
      if (parsed === null) return;
      host.patchActive({ churnFraction: pctToRatio(parsed) });
    },
  });
  wrap.appendChild(churn.el);

  // Low / expected / high quick-set (spec section 5, inputs anatomy). These set the churn field to a
  // small spread of representative fractions and recompute. The control's value is
  // updated so the field and the figure stay consistent.
  const quick = h("div", { class: "cost-quickset", role: "group", "aria-label": "Churn quick-set" });
  const presets: Array<{ label: string; pct: number; hint: string }> = [
    { label: "Low (1%)", pct: 1, hint: "A largely static source." },
    { label: "Expected (5%)", pct: 5, hint: "A typical changing source." },
    { label: "High (20%)", pct: 20, hint: "A rapidly changing source." },
  ];
  for (const p of presets) {
    // btn--secondary (not ghost): a ghost button here read as plain text, not a control.
    const b = h("button", { "data-dp": "costs.button.announce", class: "btn btn--secondary btn--sm cost-quickset__btn", type: "button", title: p.hint }, p.label);
    b.addEventListener("click", () => {
      (churn.control as HTMLInputElement).value = formatNumberInput(p.pct);
      churn.clearError();
      // skipAnnounce: we emit the specific message below, so suppress the generic
      // "Estimate updated" from patchActive/recompute to avoid a silent clobber.
      host.patchActive({ churnFraction: pctToRatio(p.pct) }, { skipAnnounce: true });
      host.announce(`Churn set to ${p.pct} per cent.`);
    });
    quick.appendChild(b);
  }
  wrap.appendChild(quick);
  return wrap;
}

function retentionField(host: CostInputsHost, inputs: Inputs): HTMLElement {
  const wrap = h("div", { class: "cost-field" });
  // Two ways to express retention: a depth in runs, or a window in days converted to
  // runs at the current cadence. We offer a depth field plus a days field; editing
  // either updates retentionRuns (days via retentionWindowToRuns at the live cadence).
  const depth = field({
    id: "cost-retention-runs",
    label: "Retention depth (runs)",
    type: "number",
    placeholder: "30",
    value: formatNumberInput(inputs.retentionRuns),
    hint: "How many recent runs to keep for the retained-with-GC projection, as a whole number of runs (0 or more). 0 means keep everything (the retained curve then equals accumulate).",
    doc: { href: "https://docs.downpipes.io/day-2/cost-prediction", anchor: "manual-mode-and-observed-mode" },
    validate: (v) => nonNegNumberError(v, "Retention depth"),
    onInput: (v) => {
      const parsed = parseNonNeg(v);
      if (parsed === null) return;
      host.patchActive({ retentionRuns: Math.round(parsed) });
      // Keep the days field in step.
      (daysField.control as HTMLInputElement).value = formatNumberInput(runsToWindowDays(Math.round(parsed), host.activeInputs().runsPerMonth));
    },
  });
  wrap.appendChild(depth.el);

  const daysField = field({
    id: "cost-retention-days",
    label: "Retention window (days)",
    type: "number",
    placeholder: "30",
    value: formatNumberInput(runsToWindowDays(inputs.retentionRuns, inputs.runsPerMonth)),
    hint: "Or express retention as a window in days (0 or more); it converts to a run depth at the current cadence.",
    doc: { href: "https://docs.downpipes.io/day-2/cost-prediction", anchor: "manual-mode-and-observed-mode" },
    validate: (v) => nonNegNumberError(v, "Retention window"),
    onInput: (v) => {
      const parsed = parseNonNeg(v);
      if (parsed === null) return;
      const runs = retentionWindowToRuns(parsed, host.activeInputs().runsPerMonth);
      host.patchActive({ retentionRuns: runs });
      (depth.control as HTMLInputElement).value = formatNumberInput(runs);
    },
  });
  wrap.appendChild(daysField.el);
  return wrap;
}

function opsFields(host: CostInputsHost, inputs: Inputs): HTMLElement {
  const wrap = h("div", { class: "cost-field cost-ops" });
  const drills = field({
    id: "cost-drills",
    label: "Drills per month",
    type: "number",
    placeholder: "1",
    value: formatNumberInput(inputs.drillsPerMonth),
    // Teach the noun, not the label: what a drill IS and what it costs. A drill re-verifies the whole
    // archive's structure but only blind-restores a sample of up to 8 records (engine DRILL_SAMPLE_MAX),
    // so its restore cost is bounded by that sample, not the full archive; the hint must not overclaim.
    hint: "An integrity drill re-verifies the whole archive's structure and blind-restores a sample of up to eight records (a small run in full) to prove they recover: in-account reads, never egress. A count per month, 0 or more.",
    doc: { href: "https://docs.downpipes.io/day-2/cost-prediction", anchor: "the-inline-read-amplification-guard" },
    validate: (v) => nonNegNumberError(v, "Drills per month"),
    onInput: (v) => {
      const parsed = parseNonNeg(v);
      if (parsed === null) return;
      host.patchActive({ drillsPerMonth: parsed });
    },
  });
  const restores = field({
    id: "cost-restores",
    label: "Restores per month",
    type: "number",
    placeholder: "1",
    value: formatNumberInput(inputs.restoresPerMonth),
    hint: "In-account restores per month, 0 or more (reads; egress only when data leaves the account).",
    doc: { href: "https://docs.downpipes.io/day-2/cost-prediction", anchor: "the-inline-read-amplification-guard" },
    validate: (v) => nonNegNumberError(v, "Restores per month"),
    onInput: (v) => {
      const parsed = parseNonNeg(v);
      if (parsed === null) return;
      host.patchActive({ restoresPerMonth: parsed });
    },
  });
  wrap.appendChild(drills.el);
  wrap.appendChild(restores.el);
  return wrap;
}
