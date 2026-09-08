// The cost calculator's destination-pricing section: a LIST of destinations (the 3-2-1 fan-out),
// each a preset picker (R2 / S3 / Custom, with Custom the route for the two stores whose rates are not
// banked), four editable rate fields and a preset-conditional egress
// note. The estimate below SUMS storage, write and platform cost across every destination listed here,
// because a backup fans out to all of them; a restore or drill reads from ONE copy. Add or remove
// destinations to match the real setup. Each block reads and mutates its own PricingState in the host's
// pricingStates array and routes recompute/announce through the host; the block's four rate-field
// references live in that block's closure so applyPreset can refresh them. Ids are suffixed with the
// destination index so multiple blocks never collide.
// House rules: Australian English, no em dashes, precise claims.

import { type Field, field } from "../../components/field.ts";
import type { ClientDiagFormField } from "../../lib/client-diag/vocab.ts";
import { PRESETS, type PresetId, type Pricing } from "../../lib/cost-model.ts";
import { clear, h, svgIcon } from "../../lib/dom.ts";
import { ICON_INFO, ICON_PLUS, ICON_TRASH } from "../../lib/icons.ts";
import {
  CURRENCY_PREFIX,
  formatRate,
  nonNegNumberError,
  parseNonNeg,
  presetLabel,
} from "./helpers.ts";

// PricingState mirrors ONE destination: the picker selection, the live (possibly overridden) rates,
// and a display label. presetId is "custom" once any rate is edited away from a named preset.
export interface PricingState {
  presetId: PresetId;
  pricing: Pricing;
  label: string;
}

// CostPricingHost is the slice of the CostView the pricing builder reads and mutates. The builder
// mutates the host's pricingStates array (add/remove a destination, or patch a destination's rates)
// and calls host.recompute/announce. recompute() always announces; recomputeSilent() does not, for
// the paths that emit their own, more specific message immediately after.
export interface CostPricingHost {
  pricingStates: PricingState[];
  recompute(): void;
  recomputeSilent(): void;
  announce(message: string): void;
}

// countLabel renders "1 destination" / "N destinations" for the live-region announcements.
function countLabel(n: number): string {
  return `${n} ${n === 1 ? "destination" : "destinations"}`;
}

export function buildPricingSection(host: CostPricingHost): HTMLElement {
  const section = h("section", { class: "card cost-pricing", "aria-labelledby": "cost-pricing-h" });
  section.appendChild(h("h2", { id: "cost-pricing-h", class: "card__title", style: "font-size:var(--text-md);margin-bottom:var(--space-1)" }, "Destination pricing"));
  section.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-bottom:var(--space-4)" },
      "Indicative public list pricing; enter your own contracted rates. The estimate sums storage and write cost across every destination here, because a backup fans out to all of them; a restore or drill reads from one copy. Editing any rate switches that destination's picker to Custom.",
    ),
  );

  // The list of destination blocks, rebuilt on add or remove (discrete clicks, so a rebuild never
  // interrupts typing: a rate edit patches state and recomputes the results only, leaving the list DOM
  // in place). The container carries the blocks; the add button sits beneath it.
  const list = h("div", { class: "cost-dest-list", style: "display:flex;flex-direction:column;gap:var(--space-4)" });
  section.appendChild(list);

  const renderList = (): void => {
    clear(list);
    host.pricingStates.forEach((state, index) => {
      list.appendChild(buildDestinationBlock(host, state, index, renderList));
    });
  };

  const addBtn = h(
    "button",
    { "data-dp": "costs.button.add", class: "btn btn--secondary btn--sm", type: "button", style: "margin-top:var(--space-3)" },
    h("span", { style: "display:inline-flex;vertical-align:middle;margin-right:var(--space-1)", "aria-hidden": "true" }, svgIcon(ICON_PLUS, { size: 16 })),
    "Add destination",
  );
  addBtn.addEventListener("click", () => {
    const n = host.pricingStates.length + 1;
    host.pricingStates.push({ presetId: "r2", pricing: { ...PRESETS.r2 }, label: `Destination ${n}` });
    renderList();
    // Suppress the generic "Estimate updated" so only the specific add message is heard.
    host.recomputeSilent();
    host.announce(`Added a destination. The estimate now sums ${countLabel(host.pricingStates.length)}.`);
  });
  section.appendChild(addBtn);

  renderList();
  return section;
}

// buildDestinationBlock renders ONE destination's controls: a header (label + a remove control when
// more than one destination remains), the preset picker, the four editable rate fields and the
// preset-conditional egress note. It mutates the passed PricingState (a live element of the host's
// pricingStates array) and routes recompute/announce through the host. rerender rebuilds the whole
// list after a remove, so the remaining blocks re-index and the last remove hides its own control.
function buildDestinationBlock(host: CostPricingHost, state: PricingState, index: number, rerender: () => void): HTMLElement {
  const block = h("div", { class: "cost-dest-block card card--inset", style: "padding:var(--space-4)" });

  // Header: the destination label and, when more than one destination is present, a remove control.
  const header = h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);margin-bottom:var(--space-3)" });
  header.appendChild(h("h3", { style: "font-size:var(--text-sm);font-weight:600;margin:0" }, state.label));
  if (host.pricingStates.length > 1) {
    const removeBtn = h(
      "button",
      { "data-dp": "costs.button.remove", class: "btn btn--ghost btn--sm", type: "button", "aria-label": `Remove ${state.label}` },
      svgIcon(ICON_TRASH, { size: 16 }),
    );
    removeBtn.addEventListener("click", () => {
      const removedLabel = state.label;
      host.pricingStates.splice(index, 1);
      rerender();
      host.recomputeSilent();
      host.announce(`Removed ${removedLabel}. The estimate now sums ${countLabel(host.pricingStates.length)}.`);
    });
    header.appendChild(removeBtn);
  }
  block.appendChild(header);

  // The four rate fields, captured here so applyPreset can refresh their displayed values; this is the
  // per-block equivalent of the former single priceFields instance field, used only in this block.
  let priceFields: { storage: Field; classA: Field; classB: Field; egress: Field } | null = null;

  // diagField is passed because these ids carry the pricing block's index (`cost-price-storage-0`), while
  // the closed vocabulary holds the family name. Without it formFieldFor sees an id it does not know and
  // drops the refusal, so the four members added to answer "the cost screen will not take my rate" could
  // never be emitted and that ticket still landed nowhere.
  const priceField = (
    id: string,
    diagField: ClientDiagFormField,
    label: string,
    unitHint: string,
    value: number,
    onChange: (n: number) => void,
  ): Field =>
    field({
      id,
      diagField,
      label,
      type: "number",
      value: formatRate(value),
      hint: `${CURRENCY_PREFIX} ${unitHint}. Non-negative.`,
      doc: { href: "https://docs.downpipes.io/day-2/cost-prediction", anchor: "where-the-rates-come-from" },
      validate: (v) => nonNegNumberError(v, label, true),
      onInput: (v) => {
        const parsed = parseNonNeg(v);
        if (parsed === null) return;
        onChange(parsed);
      },
    });

  // Preset-conditional egress note, defined before patchPricing so a manual rate edit that flips the
  // picker to Custom can refresh it. For R2 the note states R2 lists no egress fees for data transfer
  // out; for S3 it explains egress is billed at the entered rate; for Custom it is hidden (the entered
  // egress rate speaks for itself). Hidden for presets that do not warrant it.
  const egressNote = h("div", { class: "cost-egress-note card card--inset", style: "margin-top:var(--space-3)", role: "note" });
  const egressNoteText = h("span");
  egressNote.appendChild(
    h(
      "p",
      h("span", { style: "color:var(--trust);display:inline-flex;vertical-align:middle;margin-right:var(--space-2)", "aria-hidden": "true" }, svgIcon(ICON_INFO, { size: 16 })),
      egressNoteText,
    ),
  );

  const updateEgressNote = (id: PresetId): void => {
    if (id === "r2") {
      egressNote.style.display = "";
      egressNoteText.textContent =
        "Cloudflare R2 lists no egress fees for data transfer out, so an offline recovery download is not separately billed for egress on R2. Verify this against your own plan, as terms can change. Other destinations (such as S3) bill egress at the rate entered above.";
    } else if (id === "s3-standard") {
      egressNote.style.display = "";
      egressNoteText.textContent =
        "Amazon S3 bills egress at the entered rate above. Every download out of the account (an offline recovery or a restore to a different account) incurs that charge on the recovered size.";
    } else {
      // Custom: no note by default; the entered egress rate speaks for itself.
      egressNote.style.display = "none";
      egressNoteText.textContent = "";
    }
  };

  const patchPricing = (patch: Partial<Pricing>, presetPicker: Field): void => {
    state.pricing = { ...state.pricing, ...patch };
    // Any manual edit means the rates are no longer a named preset.
    if (state.presetId !== "custom") {
      state.presetId = "custom";
      (presetPicker.control as HTMLSelectElement).value = "custom";
      // Setting the select value in code does not fire its change event, so the egress note (refreshed
      // by the change listener) would otherwise keep showing the prior preset's claim after the operator
      // has moved to a custom rate that may itself charge egress. Refresh it here to match the Custom state.
      updateEgressNote("custom");
    }
    host.recompute();
  };

  const applyPreset = (id: PresetId): void => {
    state.presetId = id;
    state.pricing = { ...PRESETS[id] };
    // Refresh the four rate fields to the preset values.
    if (priceFields) {
      (priceFields.storage.control as HTMLInputElement).value = formatRate(state.pricing.storagePerGBMonth);
      (priceFields.classA.control as HTMLInputElement).value = formatRate(state.pricing.classAPerMillion);
      (priceFields.classB.control as HTMLInputElement).value = formatRate(state.pricing.classBPerMillion);
      (priceFields.egress.control as HTMLInputElement).value = formatRate(state.pricing.egressPerGB);
      priceFields.storage.clearError();
      priceFields.classA.clearError();
      priceFields.classB.clearError();
      priceFields.egress.clearError();
    }
    // Suppress the generic "Estimate updated" so only the specific preset message is heard.
    host.recomputeSilent();
    host.announce(`${state.label}: pricing preset set to ${presetLabel(id)}.`);
  };

  // The preset picker (R2 / S3 / Custom). Picking a named preset fills every rate; the picker reverts
  // to Custom once any field is edited.
  const presetPicker = field({
    id: `cost-preset-${index}`,
    label: "Preset",
    kind: "select",
    value: state.presetId,
    // NAMES ALL FOUR STORES, because the product writes to four and this picker banks rates for two. A
    // Google Cloud or Azure operator reading a list of R2 and Amazon S3 has no way to tell whether their
    // store is unmodelled or simply unlisted, and the honest answer is neither: their rates are not banked
    // because nobody has compared them against the published list, which is what PRESET_PROVENANCE records
    // and what PRESET_CHECK_MAX_AGE_DAYS ages out. Inventing two more presets to round the set out would
    // put unchecked figures in front of a customer under the same label as checked ones.
    hint: "A starting point. Rates are banked for Cloudflare R2 and Amazon S3; for Google Cloud Storage or Azure Blob Storage choose Custom and enter your own.",
    doc: { href: "https://docs.downpipes.io/day-2/cost-prediction", anchor: "where-the-rates-come-from" },
    options: [
      { value: "r2", label: "Cloudflare R2" },
      { value: "s3-standard", label: "Amazon S3 Standard" },
      { value: "custom", label: "Custom" },
    ],
  });
  block.appendChild(presetPicker.el);

  // The four editable rate fields. Build them once and keep references so picking a preset can refresh
  // their displayed values.
  const storage = priceField(`cost-price-storage-${index}`, "cost-price-storage", "Storage", "per GB-month", state.pricing.storagePerGBMonth, (n) => patchPricing({ storagePerGBMonth: n }, presetPicker));
  const classA = priceField(`cost-price-classa-${index}`, "cost-price-classa", "Write operations", "per million writes / Class A", state.pricing.classAPerMillion, (n) => patchPricing({ classAPerMillion: n }, presetPicker));
  const classB = priceField(`cost-price-classb-${index}`, "cost-price-classb", "Read operations", "per million reads / Class B", state.pricing.classBPerMillion, (n) => patchPricing({ classBPerMillion: n }, presetPicker));
  const egress = priceField(`cost-price-egress-${index}`, "cost-price-egress", "Egress", "per GB out of the account", state.pricing.egressPerGB, (n) => patchPricing({ egressPerGB: n }, presetPicker));

  priceFields = { storage, classA, classB, egress };

  // NAME EACH RATE BY ITS DESTINATION. This screen renders one pricing block per
  // destination, and every block carries the same five labels: Preset, Storage, Write operations, Read
  // operations, Egress. On screen the block's own heading tells them apart. In the accessibility tree it
  // does not: a screen reader announced "Storage" three times with nothing to say which destination it
  // priced, and a locator by accessible name resolved three controls rather than one, which is the shape
  // recorded in THE-REKEY-CEREMONY-OFFERS-TWO-DEPLOY-TOKEN-FIELDS-wire28.
  //
  // The VISIBLE label is unchanged and the accessible name still STARTS with it, so the visible text
  // remains a prefix of the accessible name and speech input still reaches the control by what is
  // printed beside it.
  for (const [f, visible] of [
    [presetPicker, "Preset"],
    [storage, "Storage"],
    [classA, "Write operations"],
    [classB, "Read operations"],
    [egress, "Egress"],
  ] as const) {
    f.control.setAttribute("aria-label", `${visible}, ${state.label}`);
  }

  // Real per-field placeholder examples: the priceField helper is shared across the four rates, so the
  // distinct examples are set on each control. Figures track the R2 preset (storage, writes, reads) and
  // the S3 preset (egress); see PRESETS.
  (storage.control as HTMLInputElement).placeholder = "0.015";
  (classA.control as HTMLInputElement).placeholder = "4.5";
  (classB.control as HTMLInputElement).placeholder = "0.36";
  (egress.control as HTMLInputElement).placeholder = "0.09";

  const grid = h("div", { class: "cost-price-grid" }, storage.el, classA.el, classB.el, egress.el);
  block.appendChild(grid);

  updateEgressNote(state.presetId);
  block.appendChild(egressNote);

  presetPicker.control.addEventListener("change", () => {
    const id = presetPicker.control.value as PresetId;
    updateEgressNote(id);
    applyPreset(id);
  });

  return block;
}
