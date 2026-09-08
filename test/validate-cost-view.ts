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

import type { DestinationStatus, EngineClient, RunHistoryEntry } from "../src/api.ts";
import type { EstateSizeReport } from "../src/lib/api/types/cost.ts";
import { DEFAULT_INPUTS } from "../src/lib/cost-model.ts";
import { CostView } from "../src/screens/costs/view.ts";
import { makeEvent } from "./dom-shim-core.ts";

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
    listDownpipes: () => Promise.resolve([]),
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
  ok("no-fields reason explains the missing per-run counts", view.modeReason.includes("do not yet carry"));
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
// note, after the operator has moved to a custom rate that may itself charge egress. patchPricing now
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
  // ...and the egress note is refreshed to the Custom state (hidden), so the stale R2 claim is gone.
  ok("the egress note is hidden after the flip to Custom", note !== null && note.style.display === "none");
  ok("the stale R2 no-egress-fees claim is no longer shown", note !== null && !(note.textContent ?? "").includes("no egress fees"));
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nCOST-VIEW VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
