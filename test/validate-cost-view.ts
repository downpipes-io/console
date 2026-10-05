// Validates the CostView UI class (src/screens/costs/view.ts): the load -> seed -> render lifecycle
// and its six states, the everConnected guard, the seedPricingFromDestination best-effort path, the
// switchMode input-preservation guarantee, and the recompute / recomputeSilent announcement split.
// validate-cost-model.ts exercises the underlying maths library exhaustively but never touches the
// CostView class; this validator covers the correctness-critical UI behaviours that would otherwise
// ship unverified (a regression in any of them is silent at runtime). It drives the PRODUCTION class
// under the shared DOM shim with a mock EngineClient; it re-implements none of the class. Run:
// node test/validate-cost-view.ts
//
// Every section carries a negative control that would fail if the assertion were vacuous.

// The DOM shim is installed FIRST so the h()-based renderers and lib/dom.ts resolve the element APIs.
// CostView touches document only inside its methods (not at module load), so the order is sound.
import { installDomShim } from "./dom-shim.ts";

installDomShim();

import type { DestinationStatus, Downpipe, EngineClient, RunHistoryEntry } from "../src/api.ts";
import type { EstateSizeReport } from "../src/lib/api/types/cost.ts";
import { DEFAULT_INPUTS } from "../src/lib/cost-model.ts";
import { CostView } from "../src/screens/costs/view.ts";
import { makeEvent } from "./dom-shim-core.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq<T>(label: string, got: T, want: T): void {
  const cond = got === want;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// A mock EngineClient: only the four methods CostView reads (listAllHistory, getDestination,
// estateSize, listDownpipes). Each is configurable per scenario; an unset method rejects (so a
// best-effort path that should swallow the failure is genuinely exercised). Typed through unknown
// because CostView only ever calls these four.
// ---------------------------------------------------------------------------
interface MockOpts {
  history?: Record<string, RunHistoryEntry[]>;
  historyThrows?: boolean;
  destination?: DestinationStatus;
  destinations?: DestinationStatus[];
  defaultId?: string | null;
  destinationThrows?: boolean;
  estate?: EstateSizeReport;
  // downpipes is the configured list listDownpipes returns (its configs); downpipesThrows makes that read fail.
  downpipes?: Downpipe[];
  downpipesThrows?: boolean;
  // downpipeRows is the raw list listDownpipes returns, row by row, when a test needs rows the route can
  // return verbatim (a null row, a row with no config). It takes the place of downpipes when set.
  downpipeRows?: unknown[];
  // reads counts the listDownpipes calls, so a test can pin the one read per load.
  reads?: { listDownpipes: number };
}
function mockEngine(opts: MockOpts): EngineClient {
  // The cost view seeds its pricing list from listDestinations (one entry per destination, the fan-out).
  // A single-destination scenario can pass `destination`; a fan-out passes `destinations`.
  const destList: DestinationStatus[] = opts.destinations ?? (opts.destination ? [opts.destination] : []);
  const m = {
    listAllHistory: () =>
      opts.historyThrows ? Promise.reject(new Error("list history: 500")) : Promise.resolve({ byDownpipe: opts.history ?? {} }),
    getDestination: () =>
      opts.destinationThrows ? Promise.reject(new Error("get destination: 500")) : Promise.resolve(opts.destination ?? { present: false }),
    listDestinations: () =>
      opts.destinationThrows
        ? Promise.reject(new Error("list destinations: 500"))
        : Promise.resolve({ destinations: destList, defaultId: opts.defaultId ?? destList[0]?.id ?? null }),
    estateSize: () => Promise.resolve(opts.estate ?? { totalBytes: 0, totalCount: 0, sizedSources: 0, sourceCount: 0, available: false, perSource: [] }),
    listDownpipes: () => {
      if (opts.reads) opts.reads.listDownpipes += 1;
      return opts.downpipesThrows
        ? Promise.reject(new Error("list downpipes: 500"))
        : Promise.resolve(opts.downpipeRows ?? (opts.downpipes ?? []).map((config) => ({ config, nextRunAt: 0, lastRunId: null, inFlight: false })));
    },
  };
  return m as unknown as EngineClient;
}

// runLoad attaches the view to the connected document body (so isConnected is true: the post-mount
// path), then awaits the class's own load() Promise so every awaited engine read has resolved before
// the assertions read the rendered state. load() is private to the class; the cast reaches it without
// re-implementing anything.
async function runLoad(view: CostView): Promise<void> {
  const body = (globalThis as unknown as { document: { body: { appendChild(n: unknown): void } } }).document.body;
  body.appendChild(view.el);
  await (view as unknown as { load(): Promise<void> }).load();
}

// A run carrying both observed fields, so >= MIN_OBSERVED_RUNS (2) of them seed observed mode.
function seedRun(runId: string, startedAt: string, archiveBytes: number, segments: number): RunHistoryEntry {
  return { runId, index: 0, startedAt, status: "ok", archiveBytesWritten: archiveBytes, segmentsWritten: segments };
}

// ============================================================================
// 1. THE SIX LOAD STATES AND THE MODE THEY RESOLVE TO
// ============================================================================
console.log("\n-- 1. the six load states -> mode --");

// (a) seedable: two runs carrying the observed fields -> observed mode.
{
  const view = new CostView(mockEngine({
    history: { dp1: [seedRun("r1", "2026-06-01T00:00:00Z", 1_000_000, 10), seedRun("r2", "2026-06-08T00:00:00Z", 1_100_000, 11)] },
  }));
  await runLoad(view);
  eq("seedable load -> observed mode", view.mode, "observed");
  ok("seedable load keeps the observed seed for a reset", view.observedSeed !== null);
  ok("seedable load reason names observed mode", view.modeReason.toLowerCase().includes("observed mode is active"));
}

// (b) no-fields: runs present but without the observed byte/segment fields -> manual mode.
{
  const view = new CostView(mockEngine({
    history: { dp1: [{ runId: "r1", index: 0, startedAt: "2026-06-01T00:00:00Z", status: "ok" }] },
  }));
  await runLoad(view);
  eq("no-fields load -> manual mode", view.mode, "manual");
  ok("no-fields load has no observed seed", view.observedSeed === null);
  ok("no-fields reason explains the missing per-run counts", view.modeReason.includes("fewer than two carry the per-run byte and segment counts"));
}

// (c) empty (engine present, no runs) -> manual mode, no seed.
{
  const view = new CostView(mockEngine({ history: {} }));
  await runLoad(view);
  eq("empty load -> manual mode", view.mode, "manual");
  ok("empty load has no observed seed", view.observedSeed === null);
}

// (d) error (non-401 history read fault) -> manual mode with the honest could-not-read note.
{
  const view = new CostView(mockEngine({ historyThrows: true }));
  await runLoad(view);
  eq("error load -> manual mode (never blocks)", view.mode, "manual");
  ok("error reason states the history could not be read", view.modeReason.includes("could not be read"));
}

// (e) no-engine (null engine) -> manual mode, the no-engine reason.
{
  const view = new CostView(null);
  await runLoad(view);
  eq("no-engine load -> manual mode", view.mode, "manual");
  ok("no-engine reason names the no-engine state", view.modeReason.includes("No engine is connected"));
}

// (f) loading: before load resolves the element is marked aria-busy (the sixth state). A fresh view
// that has not loaded shows the loading skeleton state only after renderLoading runs; assert the
// post-load state is NOT busy so the loaded render genuinely cleared it.
{
  const view = new CostView(mockEngine({ history: {} }));
  await runLoad(view);
  const content = view.el.querySelector(".async-region");
  ok("after load the content region is no longer aria-busy (loading state cleared)", content?.getAttribute("aria-busy") !== "true");
}

// ============================================================================
// 2. THE everConnected GUARD (a fast engine resolving BEFORE attachment)
// ============================================================================
console.log("\n-- 2. the everConnected guard --");

// The router attaches the screen inside a view transition, so a fast engine can resolve the first
// fetch BEFORE the element is attached. The guard must NOT treat that pre-attachment state as
// "navigated away" (which would strand the loading skeleton forever). Drive load() WITHOUT attaching:
// the view must still resolve to a real loaded mode, not be left on the skeleton.
{
  const view = new CostView(mockEngine({ history: {} }));
  // No body.appendChild: the element is never connected, mimicking a fetch that resolves pre-mount.
  await (view as unknown as { load(): Promise<void> }).load();
  eq("a fast engine resolving before attachment still renders (manual mode)", view.mode, "manual");
  ok("the loaded shell rendered (the inputs section is present, not a stranded skeleton)", view.el.querySelector("#cost-source") !== null);
}

// ============================================================================
// 3. seedPricingFromDestination BEST-EFFORT (a failure falls back to the preset)
// ============================================================================
console.log("\n-- 3. seedPricingFromDestination best-effort --");

// A destination read that throws must NOT block the calculator: the pricing falls back to the preset
// default (R2). The negative control below proves a SUCCESSFUL destination read does change the state,
// so the fallback assertion is not vacuous.
{
  const view = new CostView(mockEngine({ history: {}, destinationThrows: true }));
  await runLoad(view);
  eq("a destination read failure falls back to the R2 preset", view.pricingStates[0]?.presetId, "r2");
  eq("a destination read failure leaves exactly one (default) destination priced", view.pricingStates.length, 1);
}
// Control: a present destination with stored rates seeds custom pricing (so the path is real).
{
  const dest: DestinationStatus = { present: true, label: "my-bucket", pricing: { storagePerGBMonth: 0.02, classAPerMillion: 5, classBPerMillion: 0.5, egressPerGB: 0 } } as unknown as DestinationStatus;
  const view = new CostView(mockEngine({ history: {}, destination: dest }));
  await runLoad(view);
  eq("control: a present destination seeds custom pricing", view.pricingStates[0]?.presetId, "custom");
}
// Multi-destination seeding: TWO configured destinations seed TWO priced entries (the fan-out), the
// default leads (it is the primary a restore/drill is priced against), and a destination WITHOUT stored
// rates still counts (seeded to the R2 preset). This is the state the estimate sums across.
{
  const d1: DestinationStatus = { present: true, id: "d1", label: "primary", pricing: { storagePerGBMonth: 0.02, classAPerMillion: 5, classBPerMillion: 0.5, egressPerGB: 0 } } as unknown as DestinationStatus;
  const d2: DestinationStatus = { present: true, id: "d2", label: "offsite" } as unknown as DestinationStatus; // no stored pricing
  const view = new CostView(mockEngine({ history: {}, destinations: [d2, d1], defaultId: "d1" }));
  await runLoad(view);
  eq("multi-dest seeding: one priced entry per configured destination", view.pricingStates.length, 2);
  eq("multi-dest seeding: the default destination is placed first (the primary copy)", view.pricingStates[0]?.label, "primary");
  eq("multi-dest seeding: a destination with stored rates seeds custom", view.pricingStates[0]?.presetId, "custom");
  eq("multi-dest seeding: a destination without stored rates falls back to the R2 preset", view.pricingStates[1]?.presetId, "r2");
}
// THE SEED FOLLOWS WHAT THE DOWNPIPES WRITE TO. The estimate sums every listed destination as if each backup
// wrote to all of them, so a destination no downpipe writes to must not be seeded: it would price a copy the
// engine never makes. Three account destinations; the downpipes write to the default (one follows it) and to
// d3 (one pins it). d2 is unused.
{
  const d1 = { present: true, id: "d1", label: "primary" } as unknown as DestinationStatus;
  const d2 = { present: true, id: "d2", label: "unused" } as unknown as DestinationStatus;
  const d3 = { present: true, id: "d3", label: "pinned" } as unknown as DestinationStatus;
  const dp = (id: string, extra: Record<string, unknown>) => ({ config: { id, name: id, cadenceSeconds: 3600, enabled: true, source: { type: "kv", include: [], exclude: [] }, ...extra } });
  const view = new CostView(mockEngine({ history: {}, destinations: [d1, d2, d3], defaultId: "d1", downpipeRows: [dp("a", {}), dp("b", { destinationId: "d3" })] }));
  await runLoad(view);
  eq("in-use seeding: only the destinations a downpipe writes to are priced", view.pricingStates.map((p) => p.label).join(","), "primary,pinned");
  const fanOut = new CostView(mockEngine({ history: {}, destinations: [d1, d2, d3], defaultId: "d1", downpipeRows: [dp("c", { destinationIds: ["d3", "d2"] })] }));
  await runLoad(fanOut);
  eq("in-use seeding: a fan-out prices each destination it names, and not the default it does not use", fanOut.pricingStates.map((p) => p.label).sort().join(","), "pinned,unused");
  const none = new CostView(mockEngine({ history: {}, destinations: [d1, d2, d3], defaultId: "d1", downpipeRows: [] }));
  await runLoad(none);
  eq("in-use seeding: with no downpipes every destination is still priced (the fallback)", none.pricingStates.length, 3);
  const unreadable = new CostView(mockEngine({ history: {}, destinations: [d1, d2, d3], defaultId: "d1", downpipesThrows: true }));
  await runLoad(unreadable);
  eq("in-use seeding: an unreadable downpipe list falls back to every destination", unreadable.pricingStates.length, 3);
  // The in-use ids match no listed destination (a pin to a destination deleted since): the third fallback.
  const dangling = new CostView(mockEngine({ history: {}, destinations: [d1, d2, d3], defaultId: "d1", downpipeRows: [dp("x", { destinationId: "gone" })] }));
  await runLoad(dangling);
  eq("in-use seeding: in-use ids that match no listed destination fall back to every destination", dangling.pricingStates.length, 3);
  // A null row is a stored value the list route returned verbatim. The load must not throw on it, and it is not
  // a downpipe that writes to the default, so only the pinned destination is priced.
  const withNull = new CostView(mockEngine({ history: {}, destinations: [d1, d2, d3], defaultId: "d1", downpipeRows: [null, dp("b", { destinationId: "d3" })] as never }));
  let nullThrew: unknown = null;
  try {
    await runLoad(withNull);
  } catch (e) {
    nullThrew = e;
  }
  eq("in-use seeding: a null row in the downpipe list does not throw out of the load", nullThrew, null);
  eq("in-use seeding: a null row is not counted as a downpipe that writes to the default", withNull.pricingStates.map((p) => p.label).join(","), "pinned");
}

// ============================================================================
// 4. switchMode PRESERVES EACH SIDE'S INPUTS
// ============================================================================
console.log("\n-- 4. switchMode preserves inputs on both sides --");

// Seed observed mode, then edit BOTH sides' inputs distinctly and prove a round-trip switch keeps
// each side's edits (the guarantee that toggling never loses the operator's work in the mode they
// leave). patchActive is the single mutation path the field handlers use.
{
  const view = new CostView(mockEngine({
    history: { dp1: [seedRun("r1", "2026-06-01T00:00:00Z", 2_000_000, 20), seedRun("r2", "2026-06-08T00:00:00Z", 2_000_000, 20)] },
  }));
  await runLoad(view);
  eq("seeded into observed mode", view.mode, "observed");
  // Edit the OBSERVED side.
  view.patchActive({ sourceBytes: 9_000_000 });
  const observedSource = view.activeInputs().sourceBytes;
  // Switch to manual and edit the MANUAL side distinctly.
  view.switchMode("manual");
  eq("switched to manual mode", view.mode, "manual");
  view.patchActive({ sourceBytes: 3_000_000 });
  eq("manual side holds its own edit", view.activeInputs().sourceBytes, 3_000_000);
  // Switch back: the observed edit survived untouched.
  view.switchMode("observed");
  eq("observed side preserved its edit across the round-trip", view.activeInputs().sourceBytes, observedSource);
  // Control: the two sides genuinely differ (a no-op switch would make this vacuous).
  ok("control: the two sides hold distinct inputs", observedSource !== 3_000_000);
}

// ============================================================================
// 5. recompute ANNOUNCES, recomputeSilent DOES NOT (the dual-message suppression)
// ============================================================================
console.log("\n-- 5. recompute vs recomputeSilent announcement split --");

// The live region must announce on an edit-driven recompute but stay silent on the first paint /
// slider drag, so AT users never hear a double mutation. announce() writes via queueMicrotask, so a
// microtask flush is needed before reading the live region text.
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
{
  const view = new CostView(mockEngine({ history: {} }));
  await runLoad(view);
  // The polite live region announce() writes to is the class's own liveRegion (aria-live=polite). Read
  // it directly rather than the first role=status match, so the assertion tracks the exact node the
  // announcement mutates.
  const live = (view as unknown as { liveRegion: { textContent: string } }).liveRegion;
  ok("the polite live region exists", live !== null);
  // recomputeSilent must NOT announce.
  live.textContent = "SENTINEL";
  view.recomputeSilent();
  await flush();
  eq("recomputeSilent leaves the live region unchanged (no announcement)", live.textContent, "SENTINEL");
  // recompute MUST announce (the generic "Estimate updated").
  view.recompute();
  await flush();
  ok("recompute announces the estimate update", live.textContent.includes("Estimate updated"));
  // patchActive with skipAnnounce routes to recomputeSilent (no generic message), so a caller's own
  // specific message is the only one heard. Clear, then patch silently.
  live.textContent = "SENTINEL2";
  view.patchActive({ sourceBytes: DEFAULT_INPUTS.sourceBytes + 1 }, { skipAnnounce: true });
  await flush();
  eq("patchActive skipAnnounce suppresses the generic message", live.textContent, "SENTINEL2");
}

// ============================================================================
// 6. a manual rate edit flips the picker to Custom AND refreshes the egress note
// ============================================================================
console.log("\n-- 6. a rate edit flips to Custom and clears the stale preset egress note --");

// Editing any of the four destination-rate fields flips the preset picker to Custom. Because setting a
// select value in code does not fire its change event, the egress note (refreshed only by the picker's
// change listener) would otherwise keep showing the prior preset's claim, for example R2's no-egress-fees
// note, after the operator has moved to a custom rate that may itself charge egress. patchPricing
// refreshes the note on the flip; this section proves it, with a pre-condition control that fails if vacuous.
{
  const view = new CostView(mockEngine({ history: {} }));
  await runLoad(view);
  eq("starts on the R2 preset", view.pricingStates[0]?.presetId, "r2");
  const note = view.el.querySelector(".cost-egress-note") as HTMLElement | null;
  ok("the egress note is present", note !== null);
  // Pre-condition control: on R2 the note is visible and carries the R2 no-egress-fees claim (the exact
  // text the bug would leave stranded after a flip to Custom, so this guards against a vacuous assertion).
  ok("control: on R2 the note is visible", note !== null && note.style.display !== "none");
  ok("control: on R2 the note carries the R2 no-egress-fees claim", note !== null && (note.textContent ?? "").includes("Cloudflare R2 lists no egress fees"));
  // Edit the storage rate through the real input event the field wires onInput to.
  const storageInput = view.el.querySelector("#cost-price-storage-0") as HTMLInputElement | null;
  ok("the storage rate field is present", storageInput !== null);
  if (storageInput) {
    storageInput.value = "0.099";
    (storageInput as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent(makeEvent({ type: "input", bubbles: true }));
  }
  // The edit flips the picker to Custom (the existing behaviour)...
  eq("a rate edit flips the preset to Custom", view.pricingStates[0]?.presetId, "custom");
  // ...and the egress note is refreshed to the Custom state, so the stale R2 claim is gone. The Custom
  // note says a rate left at 0 prices that cost at nothing, because Custom keeps the figures in the fields.
  ok("the egress note shows the Custom note after the flip", note !== null && note.style.display !== "none" && (note.textContent ?? "").includes("A rate left at 0 prices that cost at nothing"));
  ok("the stale R2 no-egress-fees claim is no longer shown", note !== null && !(note.textContent ?? "").includes("no egress fees"));
}

// ============================================================================
// 7. THE CADENCE FIELD SAYS WHERE ITS FIGURE CAME FROM
// ============================================================================
console.log("\n-- 7. the cadence seed and its label --");

// A new daily downpipe, tested by hand six times four minutes apart. The seed must be the daily schedule
// (2,630,016 / 78,300 = 33.5890 runs a month, the most scheduled runs the engine can start), not the 10,958.4 the four-
// minute gaps give, and the line under the cadence field must name the schedule it came from.
{
  const burst = Array.from({ length: 6 }, (_, i) => seedRun(`m${i}`, new Date(Date.UTC(2026, 8, 25, 1, 4 * i)).toISOString(), 7.2e9, 8));
  const prodKv: Downpipe = { id: "prod-kv", name: "prod-kv", cadenceSeconds: 86_400, enabled: true, source: { type: "kv" } as Downpipe["source"] };
  const view = new CostView(mockEngine({ history: { "prod-kv": burst }, downpipes: [prodKv] }));
  await runLoad(view);
  eq("burst + daily schedule -> observed mode", view.mode, "observed");
  const rpm = view.observedSeed?.runsPerMonth ?? -1;
  ok(`burst + daily schedule: seeded runs a month = 2,630,016 / 78,300 (got ${rpm})`, Math.abs(rpm - (30.44 * 86_400) / 78_300) < 1e-9);
  const basis = view.el.querySelector(".cost-cadence-basis") as HTMLElement | null;
  eq(
    "the cadence line names the schedule, the count and the source-size basis",
    basis?.textContent ?? "",
    "Seeded from the schedule of 1 downpipe: prod-kv, every day, counted at one run every 21 hours 45 minutes, 33.6 a month. Total 33.6 runs a month, the most scheduled runs the engine can start. A run on a cadence can start up to 10 per cent early, and the count includes this. Source size is set so that each run stores what an average run of this downpipe stored.",
  );
  ok("the mode note says runs a month come from the schedules", view.modeReason.includes("Runs a month come from your downpipe schedules."));
  // The Daily preset counts by the same rule as the seed (2,630,016 / 78,300 = 33.5890), so a daily seed opens
  // on Daily, not on a custom interval, and the read-out uses the basis line's rounding (33.6), not a whole 34.
  eq("a daily seed opens on the Daily preset", (view.el.querySelector("#cost-cadence") as HTMLSelectElement | null)?.value, "daily");
  eq("the read-out rounds as the basis line does", view.el.querySelector(".cost-derived")?.textContent, "Projected 33.6 runs per month.");
  // Manual mode: the operator's own cadence, so no seed line, and the hint no longer claims to mirror a schedule.
  view.switchMode("manual");
  ok("manual mode: no seed line under the cadence field", view.el.querySelector(".cost-cadence-basis") === null);
  const cadenceHint = view.el.querySelector("#cost-cadence")?.closest(".field")?.querySelector(".field__hint")?.textContent ?? "";
  ok("manual mode: the cadence hint does not claim to mirror the downpipe schedule", cadenceHint !== "" && !cadenceHint.includes("mirrors the downpipe schedule"));
  ok("manual mode: the cadence hint states the preset rule and the Daily figure", cadenceHint.includes("A named cadence counts the engine's early starts, as Observed mode does: Daily is 33.6 runs a month."));
  // Manual mode, Daily picked from the select: the preset sets the figure the Observed seed gives a daily
  // downpipe, not 30.44. Driven through the real change event the field wires.
  const manualSelect = view.el.querySelector("#cost-cadence") as HTMLSelectElement | null;
  if (manualSelect) {
    manualSelect.value = "daily";
    (manualSelect as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent(makeEvent({ type: "change", bubbles: true }));
  }
  const manualDaily = view.activeInputs().runsPerMonth;
  ok(`manual mode: the Daily preset sets 2,630,016 / 78,300 runs a month, the seed's figure (got ${manualDaily})`, Math.abs(manualDaily - rpm) < 1e-9);
  // Control: back in Observed mode the line returns (so the manual-mode absence is not vacuous).
  view.switchMode("observed");
  ok("control: observed mode shows the seed line again", view.el.querySelector(".cost-cadence-basis") !== null);
}
// The downpipe list cannot be read: the seed falls back to each downpipe's run gaps and says so.
{
  const daily = Array.from({ length: 4 }, (_, i) => seedRun(`d${i}`, new Date(Date.UTC(2026, 8, 20 + i)).toISOString(), 7.2e9, 8));
  const view = new CostView(mockEngine({ history: { "prod-kv": daily }, downpipesThrows: true }));
  await runLoad(view);
  const rpm = view.observedSeed?.runsPerMonth ?? -1;
  ok(`unreadable list: the median one-day gap gives 30.44 runs a month (got ${rpm})`, Math.abs(rpm - 30.44) < 1e-9);
  const basis = view.el.querySelector(".cost-cadence-basis")?.textContent ?? "";
  ok("unreadable list: the line says the list could not be read and manual runs can raise the figure", basis.includes("The downpipe list could not be read") && basis.includes("manual runs can still raise this figure"));
}

// ============================================================================
// 8. ONE DOWNPIPE READ FEEDS THE CADENCE, THE PRICING SEED AND THE SOURCE-TYPE BREAKDOWN
// ============================================================================
console.log("\n-- 8. one downpipe read per load, three seeds --");

// A daily downpipe pinned to d3, on an account with three destinations, plus a null row the list route
// returned verbatim. The load reads the list once. From that one read the runs a month come from the
// schedule, the pricing list holds only d3, and the source-type map names the downpipe's source type. The
// null row is not a configured downpipe, so it does not stop the schedule seed.
{
  const d1 = { present: true, id: "d1", label: "primary" } as unknown as DestinationStatus;
  const d2 = { present: true, id: "d2", label: "unused" } as unknown as DestinationStatus;
  const d3 = { present: true, id: "d3", label: "pinned" } as unknown as DestinationStatus;
  const daily = Array.from({ length: 4 }, (_, i) => seedRun(`s${i}`, new Date(Date.UTC(2026, 8, 20 + i)).toISOString(), 7.2e9, 8));
  const config = { id: "prod-kv", name: "prod-kv", cadenceSeconds: 86_400, enabled: true, source: { type: "kv" }, destinationId: "d3" };
  const reads = { listDownpipes: 0 };
  const view = new CostView(
    mockEngine({
      history: { "prod-kv": daily },
      destinations: [d1, d2, d3],
      defaultId: "d1",
      downpipeRows: [null, { config, nextRunAt: 0, lastRunId: null, inFlight: false }],
      reads,
    }),
  );
  await runLoad(view);
  eq("one load reads the downpipe list once", reads.listDownpipes, 1);
  eq("the one read: observed mode", view.mode, "observed");
  ok("the one read: runs a month come from the schedule", view.modeReason.includes("Runs a month come from your downpipe schedules."));
  eq("the one read: the pricing list holds only the destination the downpipe writes to", view.pricingStates.map((p) => p.label).join(","), "pinned");
  const types = (view as unknown as { sourceTypeByDownpipe: Record<string, string> }).sourceTypeByDownpipe;
  eq("the one read: the source-type map names the downpipe's source type", JSON.stringify(types), JSON.stringify({ "prod-kv": "kv" }));
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nCOST-VIEW VECTORS PASS" : `\n${failures} FAILURE(S)`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) process.exit(1);
