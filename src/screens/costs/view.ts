// The cost calculator view: the load -> seed -> render lifecycle and all six states (loading,
// observed, no-fields, empty, error, no-engine), the mode toggle, the inputs and pricing
// sections, the results host and the always-visible assumptions panel. It never blocks: every
// branch ends in a fully usable calculator, and a 401 routes to signed-out. Moved verbatim from
// the cost coordinator for size; it imports the shared leaf (./helpers.ts), the observed-seed
// derivation (./seed.ts), the results builder (./results.ts), the loading skeleton (./loading.ts),
// the standing assumptions copy (./assumptions.ts), the cost-model library and the design-system
// components. House rules: Australian English, no em dashes, precise claims ("estimate" /
// "projected").

import type { EngineClient, RunHistoryEntry } from "../../api.ts";
import {
  cadenceToRunsPerMonth,
  DEFAULT_INPUTS,
  type Inputs,
  type OpCountsLike,
  PRESETS,
  SAFETY_MARGIN_DEFAULT,
  SAFETY_MARGIN_SLIDER_MAX,
  SAFETY_MARGIN_SLIDER_STEP,
  withDefaults,
} from "../../lib/cost-model.ts";
import { clear, h, svgIcon } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { humanBytes } from "../../lib/format.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { buildAssumptionsPanel } from "./assumptions.ts";
import {
  errMessage,
  formGridStyle,
  type HistoryLoad,
  type Mode,
  money,
  plural,
} from "./helpers.ts";
import { buildInputsSection } from "./inputs-section.ts";
import { buildLoadingSkeleton } from "./loading.ts";
import { buildModeToggle } from "./mode-toggle.ts";
import { buildPricingSection, type PricingState } from "./pricing-section.ts";
import { buildResults } from "./results.ts";
import { costBySourceType, summariseHistory } from "./seed.ts";

// ---------------------------------------------------------------------------
// The view: load, seed, the six states, recompute-on-change
// ---------------------------------------------------------------------------

export class CostView {
  readonly el: HTMLElement;
  private engine: EngineClient | null;
  private readonly content: HTMLElement;
  private readonly liveRegion: HTMLElement;

  // The single source of truth for the computation. Both modes keep their OWN inputs so
  // a toggle never loses the operator's edits in the mode they are leaving. The pricing
  // is shared (a destination's rates do not change with the mode).
  // mode, observedSeed and modeReason are read by the extracted mode-toggle builder (it satisfies
  // that module's CostModeToggleHost), so they are public rather than private; nothing else reaches them.
  mode: Mode = "manual";
  private manualInputs: Inputs = { ...DEFAULT_INPUTS };
  private observedInputs: Inputs | null = null;
  observedSeed: Inputs | null = null; // the original seed, for a "reset to observed"
  private observedRuns = 0;
  // observedOpCountsPerRun is the EXACT mean per-run Cloudflare op tally from run history (cost Phase 3),
  // when present; the platform ledger uses it for an exact "cost to run", else it falls back to an estimate.
  private observedOpCountsPerRun: OpCountsLike | null = null;
  // byDownpipe (the raw run-history rings) + sourceTypeByDownpipe (downpipe id -> source type, from
  // listDownpipes) drive the per-source-type cost breakdown. Both best-effort; absent leaves the table off.
  private byDownpipe: Record<string, RunHistoryEntry[]> = {};
  private sourceTypeByDownpipe: Record<string, string> = {};
  // pricingStates is read and mutated by the extracted pricing-section builder (it satisfies that module's
  // CostPricingHost), so it is public rather than private; nothing else reaches it. One entry per
  // destination (the 3-2-1 fan-out): seeded from the account's configured destinations when present, else
  // a single R2-preset default. The estimate sums the destination cost across every entry.
  pricingStates: PricingState[] = [{ presetId: "r2", pricing: { ...PRESETS.r2 }, label: "Destination 1" }];

  // safetyMargin is the wiggle-room slider (a fraction): it pads the whole estimate so the figure errs
  // high, and the operator tunes it down as their real bill comes in. Default SAFETY_MARGIN_DEFAULT.
  private safetyMargin = SAFETY_MARGIN_DEFAULT;
  // destinationPricingLabel is set when the storage rates were prefilled from a destination, so the
  // basis line can say so honestly ("rates prefilled from your destination X").
  private destinationPricingLabel: string | null = null;

  // The reason the active mode is what it is, stated honestly in the mode note.
  modeReason = "";

  // The results region is rebuilt on every recompute; the inputs/pricing controls are
  // built once and persist (so focus and caret survive a recompute, like the data-table
  // filter input). resultsHost is the swap target.
  private readonly resultsHost: HTMLElement;

  constructor(engine: EngineClient | null) {
    this.engine = engine;
    this.content = h("div", { class: "async-region" });
    this.resultsHost = h("div");
    // A polite live region announces a recomputation without stealing focus (spec
    // section 6: "Live region announces a recomputation politely").
    this.liveRegion = h("div", { class: "visually-hidden", role: "status", "aria-live": "polite" });
    this.el = h("div", this.content, this.liveRegion);
  }

  start(): void {
    void this.load();
  }

  // everConnected latches once the element has been seen IN the document; "not connected"
  // means dead ONLY after that (the router attaches the screen inside a view transition, so
  // a fast engine can resolve the first fetch BEFORE attachment - treating that as
  // "navigated away" left the loading skeleton on screen forever; the map's local
  // fixture-engine reproduction caught it).
  private everConnected = false;

  private isAlive(): boolean {
    if (this.el.isConnected) {
      this.everConnected = true;
      return true;
    }
    return !this.everConnected;
  }

  // load performs the single engine read and decides the initial mode. It never blocks:
  // every branch ends in a fully usable calculator. A 401 routes to signed-out (the one
  // exception, a session matter); everything else degrades to manual with a note.
  private async load(): Promise<void> {
    this.renderLoading();
    const result = await this.fetchHistory();
    if (!this.isAlive()) return; // navigated away mid-load; do not render into a detached node

    if (result.kind === "error" && isUnauthorised(result.error)) {
      goSignedOut();
      return;
    }

    // Decide the initial mode from the load (seedable -> observed; everything else -> manual
    // with an honest note on why).
    this.applyInitialMode(result);

    // Prefill the storage rates from the destination the owner already configured, so the estimate
    // needs no separate pricing step (best-effort; the calculator works without it).
    await this.seedPricingFromDestinations();
    if (!this.isAlive()) return; // navigated away during the destination read

    // Map each downpipe to its source type, for the per-source-type cost breakdown (best-effort).
    await this.fetchSourceTypes();
    if (!this.isAlive()) return; // navigated away during the downpipe read

    // In manual mode (no runs to observe yet), seed an initial source size from the account via the
    // analytics-first estate probe, so onboarding shows a real figure with no typing.
    if (this.mode === "manual" && this.observedSeed === null) {
      await this.seedManualFromEstate();
      if (!this.isAlive()) return; // navigated away during the estate read
    }

    this.renderShell();
    // Announce the chosen mode and reason after render so AT users learn why Observed vs
    // Manual is active. Especially important for the partial case where history is present
    // but no observed fields were found (mode='manual', kind='no-fields').
    this.announce(this.modeReason);
  }

  // applyInitialMode sets mode + the honest mode reason (and, when seedable, the observed seed and
  // op counts) from the history load. A seedable load goes to observed; no-fields, empty and a
  // non-401 error all fall back to manual with a note stating exactly why.
  private applyInitialMode(result: HistoryLoad): void {
    if (result.kind === "seedable") {
      this.observedSeed = result.seed;
      this.observedInputs = { ...result.seed };
      this.observedRuns = result.runs;
      this.observedOpCountsPerRun = result.opCountsPerRun ?? null;
      this.mode = "observed";
      this.modeReason = `Observed mode is active, seeded from your last ${result.runs} ${plural(result.runs, "run")}. The figures below project forward from your actual throughput; every value is editable.`;
    } else if (result.kind === "no-fields") {
      this.mode = "manual";
      this.modeReason = `Manual mode is active. Your engine reported ${result.runs} ${plural(result.runs, "run")}, but they do not yet carry the per-run byte and segment counts the observed projection needs, so the estimate uses the defaults below. Every value is editable.`;
    } else if (result.kind === "empty") {
      this.mode = "manual";
      this.modeReason = this.engine
        ? "Manual mode is active. There are no runs to observe yet, so the estimate starts from sensible defaults. Enter your own figures, or run a backup and return to seed the projection from real throughput."
        : "Manual mode is active. No engine is connected, so the estimate starts from sensible defaults. Enter your own figures below.";
    } else {
      // error (non-401): fall back to manual with an inline note, never block (spec 5).
      this.mode = "manual";
      this.modeReason = `Manual mode is active. The run history could not be read (${errMessage(result.error)}), so the observed projection is unavailable; the estimate uses the defaults below. This does not affect the calculator, which runs entirely in your browser.`;
    }
  }

  private async fetchHistory(): Promise<HistoryLoad> {
    if (!this.engine) return { kind: "empty" };
    try {
      const { byDownpipe } = await this.engine.listAllHistory();
      this.byDownpipe = byDownpipe; // kept for the per-source-type breakdown
      return summariseHistory(byDownpipe);
    } catch (error) {
      return { kind: "error", error };
    }
  }

  // seedPricingFromDestinations prefills the pricing list from the account's CONFIGURED destinations, one
  // entry per destination (the real fan-out), so the estimate reflects the true multi-destination cost and
  // the operator does not re-enter rates a destination already carries. The default destination leads (a
  // restore or drill is priced against the first copy). A destination without stored rates gets the R2
  // preset, still counting toward the fan-out. Best-effort and non-blocking: any failure leaves the single
  // preset default in place.
  private async seedPricingFromDestinations(): Promise<void> {
    if (!this.engine) return;
    try {
      const { destinations, defaultId } = await this.engine.listDestinations();
      if (destinations.length === 0) return;
      // Default first, then the rest in listed order, so the primary (restore/drill) copy leads.
      const def = destinations.find((d) => d.id === defaultId);
      const ordered = def ? [def, ...destinations.filter((d) => d.id !== defaultId)] : destinations;
      this.pricingStates = ordered.map((dest, i) => {
        const label = dest.label ?? dest.bucket ?? `Destination ${i + 1}`;
        const dp = dest.pricing;
        if (dp) {
          return {
            presetId: "custom" as const,
            pricing: {
              storagePerGBMonth: dp.storagePerGBMonth,
              classAPerMillion: dp.classAPerMillion,
              classBPerMillion: dp.classBPerMillion,
              egressPerGB: dp.egressPerGB,
            },
            label,
          };
        }
        return { presetId: "r2" as const, pricing: { ...PRESETS.r2 }, label };
      });
      // The single-destination basis line names which destination the rates came from; for a fan-out the
      // "Across N destinations" note in the results carries the explanation instead.
      this.destinationPricingLabel = ordered.length === 1 ? (ordered[0]?.label ?? ordered[0]?.bucket ?? "your destination") : null;
    } catch {
      // best-effort: fall back to the single preset default; the calculator never blocks on this.
    }
  }

  // seedManualFromEstate seeds an initial source size in MANUAL mode from the account's estate size (the
  // analytics-first probe), so a customer who has not run a backup yet still sees a real, populated
  // estimate instead of zeros. Best-effort and non-blocking; it assumes a weekly cadence as a starting
  // point and says so in the mode note, so the figure is honest and obviously adjustable.
  private async seedManualFromEstate(): Promise<void> {
    if (!this.engine) return;
    try {
      const estate = await this.engine.estateSize();
      if (!estate.available || estate.totalBytes <= 0) return;
      this.manualInputs = withDefaults({
        ...this.manualInputs,
        sourceBytes: estate.totalBytes,
        runsPerMonth: cadenceToRunsPerMonth("weekly"),
      });
      this.modeReason += ` Seeded an initial size of about ${humanBytes(estate.totalBytes)} from your account (sized ${estate.sizedSources} of ${estate.sourceCount} ${plural(estate.sourceCount, "source")} via Cloudflare analytics), assuming a weekly cadence; adjust anything below.`;
    } catch {
      // best-effort: leave the manual defaults in place.
    }
  }

  // fetchSourceTypes maps each downpipe id to its source type (from listDownpipes), so the cost screen can
  // break the cost down per source type. Best-effort and non-blocking: a failure leaves the map empty and
  // the breakdown table simply does not render.
  private async fetchSourceTypes(): Promise<void> {
    if (!this.engine) return;
    try {
      const downpipes = await this.engine.listDownpipes();
      const map: Record<string, string> = {};
      for (const d of downpipes) map[d.config.id] = d.config.source.type;
      this.sourceTypeByDownpipe = map;
    } catch {
      // best-effort: without it the per-source-type breakdown is simply omitted.
    }
  }

  private renderLoading(): void {
    clear(this.content);
    this.content.setAttribute("aria-busy", "true");
    // A skeleton tracing the real screen shape: mode/banner block, two-column form-field
    // skeleton, then results (headline + table + chart placeholders). Matches the loaded
    // screen's anatomy so the transition is smooth, rather than a generic 4-tile grid.
    this.content.appendChild(buildLoadingSkeleton());
  }

  // renderShell, activeInputs, setActiveInputs, patchActive, recompute and announce form the
  // host surface the extracted inputs-section and pricing-section builders call (CostInputsHost /
  // CostPricingHost), so they are public rather than private; nothing outside this screen uses them.

  // renderShell builds the persistent screen once the mode is known: the mode toggle,
  // the inputs section, the pricing section, the results host, and the always-visible
  // assumptions panel. The inputs/pricing controls are built ONCE here; recompute()
  // swaps only the resultsHost contents. It reads the instance state (mode, seed, the
  // mode reason), so a re-render after a mode switch needs no load argument.
  renderShell(): void {
    clear(this.content);
    this.content.setAttribute("aria-busy", "false");

    // 1. Mode toggle + the honest note on which mode is active and why.
    // (No standing estimate banner here: the headline card says "An estimate, not a
    // quote" and the assumptions lead below repeats it once; a third pre-form telling
    // was the same sentence three times on one screen.)
    this.content.appendChild(buildModeToggle(this));

    // 2 + 3. Inputs and pricing, side by side on wide, stacked when narrow.
    const formGrid = h("div", { class: "cost-form-grid", style: formGridStyle() });
    formGrid.appendChild(buildInputsSection(this));
    formGrid.appendChild(buildPricingSection(this));
    this.content.appendChild(formGrid);

    // 4. Safety margin (the wiggle slider), persistent so dragging it survives a recompute.
    this.content.appendChild(this.buildMarginControl());

    // 5. Results (rebuilt on every recompute).
    this.content.appendChild(this.resultsHost);

    // 6. The always-visible assumptions-and-limits panel.
    this.content.appendChild(buildAssumptionsPanel());

    // First compute (silent: a fresh render must not announce).
    this.recomputeSilent();
  }

  // ---- the active inputs ----------------------------------------------------

  // activeInputs returns the inputs for the current mode (observed when seeded, else
  // manual). Always run through withDefaults at the consumption point so a partial or
  // out-of-range edit is clamped before it reaches the maths (the library is total, but
  // clamping here keeps the displayed figure and the computed figure consistent).
  activeInputs(): Inputs {
    const raw = this.mode === "observed" && this.observedInputs ? this.observedInputs : this.manualInputs;
    return withDefaults(raw);
  }

  setActiveInputs(next: Inputs): void {
    if (this.mode === "observed" && this.observedInputs) this.observedInputs = next;
    else this.manualInputs = next;
  }

  // patchActive applies a partial change to the current mode's inputs and recomputes. It
  // is the single mutation path the field handlers call, so every edit clamps and
  // recomputes consistently and the OTHER mode's inputs are untouched.
  // Pass skipAnnounce:true when the caller will immediately emit its own, more specific
  // live-region message, suppressing the generic "Estimate updated" announce so AT users
  // do not hear both (only the specific one follows).
  patchActive(patch: Partial<Inputs>, opts?: { skipAnnounce?: boolean }): void {
    const next = withDefaults({ ...this.activeInputs(), ...patch });
    this.setActiveInputs(next);
    if (opts?.skipAnnounce) this.recomputeSilent();
    else this.recompute();
  }

  // ---- 1. mode toggle -------------------------------------------------------

  // The mode toggle (the radiogroup + roving keydown + the mode note) lives in ./mode-toggle.ts
  // (buildModeToggle takes this as its CostModeToggleHost); switchMode below is its single
  // mutation path.

  // switchMode flips the active mode without losing either side's edits. It re-syncs the
  // input controls to the now-active mode's values, updates the toggle + note, and
  // recomputes. The controls are rebuilt (cheap; one section) so their displayed values
  // reflect the mode being switched to, but the OTHER mode's stored inputs are kept.
  switchMode(mode: Mode): void {
    if (mode === this.mode) return;
    if (mode === "observed" && !this.observedSeed) return; // guarded; the button is disabled anyway
    this.mode = mode;
    if (mode === "observed") {
      const runs = this.observedRuns;
      this.modeReason = `Observed mode is active, seeded from your last ${runs} ${plural(runs, "run")}. The figures below project forward from your actual throughput; every value is editable.`;
    } else {
      this.modeReason = this.observedSeed
        ? "Manual mode is active. The figures below are yours to enter; your observed seed is kept and you can switch back to it."
        : "Manual mode is active. Enter your own figures below.";
    }
    // Rebuild the whole shell so the input controls show the active mode's values; both
    // modes' stored inputs persist on the instance, so nothing is lost.
    this.renderShell();
    this.announce(`Switched to ${mode} mode. ${this.mode === "observed" ? "Inputs seeded from run history." : "Inputs are entered."}`);
  }

  // ---- 4. the wiggle-room safety margin --------------------------------------

  // buildMarginControl is the persistent safety-margin slider (the wiggle room): it pads the whole
  // estimate so the figure errs high, and the operator tunes it down as their real bill comes in. It
  // lives OUTSIDE the rebuilt results region so dragging it never loses focus. Input recomputes
  // silently and updates the readout; the change event makes the single polite announcement.
  private buildMarginControl(): HTMLElement {
    const section = h("section", { class: "card cost-margin", "aria-labelledby": "cost-margin-h", style: "margin-top:var(--space-4)" });
    section.appendChild(h("h2", { id: "cost-margin-h", class: "card__title", style: "font-size:var(--text-md);margin-bottom:var(--space-1)" }, "Safety margin (wiggle room)"));
    section.appendChild(
      h(
        "p",
        { class: "field__hint", style: "margin-bottom:var(--space-3)" },
        "Pad the estimate to stay on the safe side of your real bill, from 0 to 50 per cent. Raise it for comfort, then lower it as your actual charges come in.",
      ),
    );
    const readout = h("span", { class: "tnum", style: "min-width:3.5em;text-align:right;font-weight:var(--weight-medium)" }, `+${Math.round(this.safetyMargin * 100)}%`);
    const slider = h("input", { "data-dp": "costs.range.slider",
      type: "range",
      min: "0",
      // The UI cap (50 per cent) is deliberately below the library cap SAFETY_MARGIN_MAX (200 per
      // cent): the slider is for everyday comfort, not the far edge the clamp guards.
      max: String(Math.round(SAFETY_MARGIN_SLIDER_MAX * 100)),
      step: String(Math.round(SAFETY_MARGIN_SLIDER_STEP * 100)),
      value: String(Math.round(this.safetyMargin * 100)),
      class: "cost-margin__slider",
      style: "flex:1",
      "aria-label": "Safety margin percentage",
    });
    slider.addEventListener("input", () => {
      const pct = Number((slider as HTMLInputElement).value);
      this.safetyMargin = Number.isFinite(pct) ? pct / 100 : SAFETY_MARGIN_DEFAULT;
      readout.textContent = `+${Math.round(this.safetyMargin * 100)}%`;
      this.recomputeSilent();
    });
    slider.addEventListener("change", () => {
      this.announce(`Safety margin set to ${Math.round(this.safetyMargin * 100)} per cent.`);
    });
    section.appendChild(h("div", { style: "display:flex;align-items:center;gap:var(--space-3)" }, slider, readout));
    // Group-level doc link (audit G2): the range slider takes no placeholder, so the link that explains
    // what the safety margin does (it pads the headline so the figure errs high) sits below the control.
    section.appendChild(
      h(
        "a",
        { class: "field__doc linklike", href: "https://docs.downpipes.io/day-2/cost-prediction#the-safety-margin", target: "_blank", rel: "noreferrer noopener" },
        "About the safety margin",
        svgIcon(ICON_EXTERNAL, { size: 13 }),
      ),
    );
    return section;
  }

  // recompute rebuilds the results region from the current inputs + pricing and makes the
  // polite "Estimate updated" live-region announcement. Use it for edit-driven recomputes
  // where there is no more-specific message to follow. It never touches the input controls,
  // so focus/caret survive.
  recompute(): void {
    const headlineTotal = this.rebuildResults();
    this.announce(`Estimate updated. Estimated recurring monthly cost ${money(headlineTotal)}.`);
  }

  // recomputeSilent rebuilds the results region without any live-region announcement. Use it
  // for the first compute (initial render), for slider drag (the change event makes the single
  // announcement), and when the caller emits its own, more specific message immediately after.
  recomputeSilent(): void {
    this.rebuildResults();
  }

  // rebuildResults is the shared body of both recompute paths: it builds the results from the
  // current inputs + pricing, replaces the results region and returns the headline total so the
  // announcing path can name it. It never touches the input controls.
  private rebuildResults(): number {
    const inputs = this.activeInputs();
    const pricings = this.pricingStates.map((s) => s.pricing);

    // Per-source-type breakdown from the run history + the downpipe source-type map, priced across the
    // current destinations. Empty (no history or no map) => the table is omitted by results.
    const sourceTypeRows = costBySourceType(this.byDownpipe, this.sourceTypeByDownpipe, pricings);

    const built = buildResults(inputs, pricings, {
      mode: this.mode,
      observedRuns: this.observedRuns,
      // The currency note shows when ANY destination is on custom (entered-currency) rates.
      presetId: this.pricingStates.some((s) => s.presetId === "custom") ? "custom" : (this.pricingStates[0]?.presetId ?? "r2"),
      safetyMargin: this.safetyMargin,
      ...(sourceTypeRows.length > 0 ? { sourceTypeRows } : {}),
      destinationLabel: this.destinationPricingLabel,
      ...(this.observedOpCountsPerRun !== null ? { opCountsPerRun: this.observedOpCountsPerRun } : {}),
    });
    this.resultsHost.replaceChildren(built.el);
    return built.headlineTotal;
  }

  // announce emits a polite live-region message. To ensure AT hears a repeated identical
  // message (e.g. tapping the same quick-set twice), the region is cleared first and the
  // new text is set in a microtask, forcing a mutation even when the string is unchanged.
  announce(message: string): void {
    this.liveRegion.textContent = "";
    // A microtask boundary is enough for assistive tech to detect the empty -> filled
    // transition as a new announcement (no setTimeout needed; queueMicrotask is supported
    // in all target environments alongside the rest of this codebase).
    queueMicrotask(() => { this.liveRegion.textContent = message; });
  }

}
