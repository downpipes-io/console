// Validate that the Sources + downpipes screen's standing auto-refresh never turns a large fleet into
// a history-read storm, OR a history-payload storm.
//
// THE FIRST DEFECT. On a 2,000-downpipe fleet with several hundred runs in progress, the screen's
// auto-refresh (sources-downpipes.ts reload -> table.ts fillFreshness) re-read every in-flight row's run
// history with one GET /admin/history?id=... call per row, 8 in flight at a time: hundreds of concurrent
// requests, repeating every 4 seconds while any run stayed in flight.
//
// THE SECOND DEFECT, found reviewing the first fix. Replacing the per-row fan-out with ONE
// listAllHistory() call (GET /admin/history, no id) traded a request storm for a payload storm: that
// route returns every downpipe's FULL run-history ring (RING_CAP 50 entries each) with no fleet-wide
// cap, which at a few thousand downpipes is tens of megabytes of JSON, repeated on every refresh.
//
// THE THIRD DEFECT, found by a standing check against the real browser. (1) app.ts re-renders the
// on-screen screen the instant the verified caller lands, about 0.2 s after this screen's own first
// paint -- far faster than a bounded first-load fill (real network round trips) ever finishes, so the
// re-render's own load() ran a SECOND full first load: 100 reads in two passes of 50. (2) each refresh
// got its OWN steady budget, so a trickle turn at the end of one refresh and a cohort of on-screen rows
// leaving flight in the NEXT refresh could add up to more than the budget in one real 30 s stretch (20 +
// 10 = 30), even though neither refresh individually exceeded it.
//
// THE FIX actually shipped: fillFreshness never calls listAllHistory. A row currently IN FLIGHT needs no
// history read at all (its State comes straight off the downpipe list's own inFlight flag); a row that
// needs a read is read ONLY if it is currently rendered by the table (the windowed table's visible slice
// + overscan, read straight off the DOM -- see sources-downpipes.ts visibleDownpipeIds), then a status
// facet's other-active-facet match, then a background trickle of whatever is left. The first load has
// its own fixed budget (50); every refresh after it shares ONE rolling budget (steadyBudgetRemaining: at
// most 20 history reads in any 30 s of wall time, not a fresh allowance per refresh). A load() that
// starts while an earlier one is still running (IN_FLIGHT_LOAD) shares that SAME fetch and fill instead
// of running a second one. A row this never reaches reads an honest "Loading" state (helpers.ts
// freshnessFor), never a wrong one.
//
// THIS SUITE drives the REAL screen (sourcesDownpipesScreen.render), the real standing poll
// (window.setTimeout, faked here) and the real fillFreshness, against a stubbed engine whose history
// reads carry REALISTIC, full 50-entry rings (so the byte counts below are not a toy). Measurements, each
// with 2,000 DISTINCT downpipe ids unless stated:
//   A. first load: at most 50 history requests, at most 2 MB of history bytes.
//   B. steady state, 15 s, nothing in flight: 0 requests (0 bytes).
//   C. steady state, 15 s, 20 runs in flight: at most 20 requests, at most 1 MB of history bytes, plus
//      the positive control (a row outside the in-flight cohort with a new run is still re-read).
//   D. the background trickle over 5 minutes of fake time with 20 ALWAYS in flight: off-screen coverage
//      keeps growing, never exceeding 20 reads in any 30 s bucket.
//   E. a Stale/Failed status facet active while rows are unread: a calm note names how many, and clears
//      once every row is read (200 downpipes).
//   F. a re-render about 0.2 s into the first load (the identity-resolve race, simulated with a small
//      per-read latency so the fill is genuinely still in flight): first load still at most 50, not 100.
//   G. the cohort case: a trickle turn, then a cohort of 10 visible rows leaving flight 2 s later:
//      at most 20 history reads in ANY rolling 30 s window, checked per individual request timestamp.
// Plus a standalone measurement of what ONE listAllHistory() call would have cost at this fleet size (the
// number the second defect's fix is justified against).
//
// Run with: node test/validate-fleet-history-refresh.ts

import { installDomShim, qs, qsa, textOf } from "./dom-shim.ts";
installDomShim();

import { connect, setCaller } from "../src/lib/store.ts";
// A NAMESPACE import (not named): _testResetFreshnessPacing is a reset seam this round's fix adds, and
// the RED proof against the PRIOR commit's source (a plain git checkout -- of these two files, this test
// file unchanged) runs against a module that does not export it yet. A named `import { x }` throws a
// hard SyntaxError at module load for a missing export and aborts the whole suite before a single
// assertion runs; the namespace form degrades to `undefined`, read defensively below, so the red proof
// still exercises every scenario's actual behaviour instead of crashing before it starts.
import * as sourcesDownpipesModule from "../src/screens/sources-downpipes.ts";
import { loadingCount, unreadFilterNote } from "../src/screens/sources-downpipes/helpers.ts";
import { closeAllOverlays } from "../src/components/dialog.ts";
const { sourcesDownpipesScreen } = sourcesDownpipesModule;
import type { Caller, Downpipe, DownpipeState, RunHistoryEntry, StatusReport } from "../src/api.ts";
import type { DestinationList, DestinationStatus } from "../src/lib/api/types/destinations.ts";
import type { SourceDiscovery } from "../src/lib/api/types/sources.ts";
import { installNav } from "../src/lib/nav.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
let checks = 0;
function ok(name: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

const OWNER: Caller = { method: "passkey", email: "o@test", role: "owner", groups: [], isOnlyOwner: true };
const NOW = Date.now();
const MB = 1024 * 1024;

// ---- a REALISTIC run-history row, so a byte budget measured against it means something. The fields
// mirror engine src/sched/types.ts RunHistoryEntry's commonly-populated set (never every optional field
// at once, which no real row carries, but a representative one). ------------------------------------
function realisticEntry(id: string, index: number, over: Partial<RunHistoryEntry> = {}): RunHistoryEntry {
  return {
    runId: `01J${id}R${String(index).padStart(5, "0")}ULIDFILLERTEXT`.slice(0, 26),
    index,
    startedAt: new Date(NOW - (200 - index) * 3_600_000).toISOString(),
    status: "ok",
    prevRunId: index > 1 ? `01J${id}R${String(index - 1).padStart(5, "0")}ULIDFILLERTEXT`.slice(0, 26) : null,
    recordCount: 4821,
    bytes: 583921,
    archiveBytesWritten: 583921,
    segmentsWritten: 3,
    durationMs: 48213,
    destinationId: "dest-primary-01",
    opCounts: { kvRead: 120, r2Write: 3, subrequests: 123 },
    ...over,
  } as RunHistoryEntry;
}
// A full RING_CAP-sized ring for one downpipe, newest-first, with the HEAD entry overridable (the
// downpipe's current truth) so the functional checks (transitions, the positive control) control exactly
// what "latest" reads while every call still pays the realistic full-ring byte cost.
function realisticRing(id: string, head: { lastRunId: string; status: RunHistoryEntry["status"] }): RunHistoryEntry[] {
  const RING_SIZE = 50;
  const rows: RunHistoryEntry[] = [];
  for (let i = RING_SIZE; i >= 1; i--) rows.push(realisticEntry(id, i));
  rows[0] = realisticEntry(id, RING_SIZE, { runId: head.lastRunId, status: head.status, startedAt: new Date(NOW).toISOString() });
  return rows;
}

function byteLen(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), "utf8");
}

// ---- a fake virtual clock replacing window.setTimeout/clearTimeout (window === globalThis under the
// DOM shim), so the 15 s windows below cost no real wall time. Node's realSetTimeout/setImmediate are
// left untouched for this driver's own microtask/macrotask draining. ------------------------------------
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function fakeClock(): { advance: (ms: number) => Promise<void>; settle: () => Promise<void>; microtick: (rounds?: number) => Promise<void>; restore: () => void } {
  let virtualNow = 0;
  let nextTimerId = 1;
  const timers: Array<{ id: number; due: number; fn: () => void }> = [];
  (globalThis as unknown as { setTimeout: (fn: () => void, ms?: number) => number }).setTimeout = (fn, ms) => {
    const id = nextTimerId++;
    timers.push({ id, due: virtualNow + (ms ?? 0), fn });
    return id;
  };
  (globalThis as unknown as { clearTimeout: (id: number) => void }).clearTimeout = (id) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i !== -1) timers.splice(i, 1);
  };
  // Date.now() is mocked too, moving in LOCKSTEP with the virtual clock above: the screen's own trickle
  // pacing (sources-downpipes.ts trickleWindow) and RECENT_LOAD TTL read real Date.now(), so a 5-minute
  // fake-time run (the D scenario) needs Date.now() to actually move 5 minutes, not sit frozen at the
  // real wall-clock instant this fakeClock was created.
  const realDateNow = Date.now;
  const dateBase = realDateNow();
  (Date as unknown as { now: () => number }).now = () => dateBase + virtualNow;
  async function drain(rounds = 20_000): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
    await new Promise<void>((r) => realSetTimeout(r, 0));
  }
  async function advance(ms: number): Promise<void> {
    const target = virtualNow + ms;
    // Drain BEFORE checking what timer is due: a chain that has not yet scheduled any timer at all (the
    // first advance() call right after mounting, before listDownpipes/status have even resolved) would
    // otherwise see no due timer, set virtualNow and return with NOTHING having run -- advance() must let
    // already-pending work progress (and possibly arm a timer of its own) before it can know what, if
    // anything, is due within this window.
    await drain();
    for (;;) {
      timers.sort((a, b) => a.due - b.due);
      const next = timers[0];
      if (!next || next.due > target) {
        virtualNow = target;
        return;
      }
      virtualNow = next.due;
      timers.splice(0, 1);
      next.fn();
      await drain();
    }
  }
  return {
    advance,
    // settle drains outstanding microtask/macrotask chains WITHOUT advancing the virtual clock or
    // requiring a timer to be due: the call used right after mounting, before any timer has even been
    // armed yet (load()'s own promise chain, including the awaited first-load fillFreshness, runs on
    // microtasks alone).
    settle: () => drain(),
    // microtick drains a SMALL, bounded number of microtask rounds without advancing the virtual clock:
    // used to let a load() just started make SOME progress (its listDownpipes/status land, the table
    // paints) without running it to completion, so a re-render that follows genuinely lands while the
    // first fill is still in flight (the app.ts identity-resolve race this suite's F scenario drives),
    // rather than accidentally letting it finish first via too thorough a drain.
    microtick: (rounds = 200) => drain(rounds),
    restore: () => {
      (globalThis as unknown as { setTimeout: typeof realSetTimeout }).setTimeout = realSetTimeout;
      (globalThis as unknown as { clearTimeout: typeof realClearTimeout }).clearTimeout = realClearTimeout;
      Date.now = realDateNow;
    },
  };
}

function config(id: string): Downpipe {
  return { id, name: id, cadenceSeconds: 86_400, enabled: true, source: { type: "kv", binding: `SRC_KV_${id}`, include: [], exclude: [] } };
}

const STATUS: StatusReport = {
  service: "engine", engineVersion: "test", signerConfigured: true, breakGlassConfigured: true,
  operationalConfigured: { public: true, private: false }, configKeysConfigured: { recipient: true, wrapKey: true }, destConfigured: true, destKind: "r2",
  updateChannelConfigured: false, licenceConfigured: true, downpipeCount: 2000, ready: true,
};

// A fresh fleet + a fresh connected engine stub. `url` must be unique per scenario: the store is a
// module singleton, and a fresh EngineClient is how a prior scenario's stubbed methods cannot leak into
// the next one.
interface Fleet {
  truth: Map<string, { lastRunId: string; status: RunHistoryEntry["status"] }>;
  inFlightIds: Set<string>;
  historyCalls: number;
  allHistoryCalls: number;
  historyBytes: number;
  currentList: () => DownpipeState[];
  engine: ReturnType<typeof connect>;
}
function makeFleet(url: string, ids: string[], inFlightIds: Set<string>): Fleet {
  const truth = new Map<string, { lastRunId: string; status: RunHistoryEntry["status"] }>();
  for (const id of ids) truth.set(id, { lastRunId: `${id}-r1`, status: inFlightIds.has(id) ? "in-flight" : "ok" });
  const fleet: Fleet = {
    truth,
    inFlightIds,
    historyCalls: 0,
    allHistoryCalls: 0,
    historyBytes: 0,
    currentList: () =>
      ids.map((id) => ({
        config: config(id),
        nextRunAt: NOW + 3_600_000,
        lastRunId: truth.get(id)!.lastRunId,
        inFlight: inFlightIds.has(id),
      })),
    engine: connect(url),
  };
  const stub = fleet.engine as unknown as Record<string, unknown>;
  stub.listDownpipes = async (): Promise<DownpipeState[]> => fleet.currentList();
  stub.status = async (): Promise<StatusReport> => STATUS;
  stub.listHistory = async (id: string): Promise<RunHistoryEntry[]> => {
    fleet.historyCalls++;
    const entries = realisticRing(id, truth.get(id)!);
    fleet.historyBytes += byteLen(entries);
    return entries;
  };
  // Still stubbed (and still counted toward historyBytes) so a RED run against the prior commit, which
  // calls this on a large pending set, measures the payload storm it actually sent.
  stub.listAllHistory = async (): Promise<{ byDownpipe: Record<string, RunHistoryEntry[]> }> => {
    fleet.allHistoryCalls++;
    const byDownpipe: Record<string, RunHistoryEntry[]> = {};
    for (const id of ids) byDownpipe[id] = realisticRing(id, truth.get(id)!);
    fleet.historyBytes += byteLen({ byDownpipe });
    return { byDownpipe };
  };
  // The create wizard (editor-wizard.ts) reads these eagerly on open, independent of the fleet
  // list/history calls above: stubbed here so opening it in a test never reaches a real engine host.
  stub.getDestination = async (): Promise<DestinationStatus> => ({ present: true, bucket: "test-bucket" });
  stub.listDestinations = async (): Promise<DestinationList> => ({ destinations: [], defaultId: null });
  stub.discoverSources = async (): Promise<SourceDiscovery> => ({ bound: { kv: [], r2: [], d1: [], secrets: [] }, tokenPresent: false });
  return fleet;
}

function totalRequests(f: Fleet): number {
  return f.historyCalls + f.allHistoryCalls;
}

function stateCellFor(name: string): string {
  // Name is column 1 and State is column 4: the OWNER caller holds run.trigger/downpipe.delete, so
  // buildTable adds the bulk-selection checkbox column ahead of every data column (see the comment this
  // mirrors in validate-freshness-table.ts, which reads a caller-less table with no such column).
  for (const tr of qsa(document.body, "tbody tr")) {
    const tds = qsa(tr, "td");
    if (tds.length < 5) continue; // the windowed table's leading/trailing spacer rows carry one <td>
    const rowName = textOf(tds[1]);
    if (rowName.startsWith(name)) return textOf(tds[4]);
  }
  return "(row not found)";
}

async function main(): Promise<void> {
  // ---- standalone measurement: what ONE listAllHistory() call costs at this fleet size -------------
  console.log("\n-- the payload listAllHistory would have sent (2,000 downpipes, full 50-entry rings) --");
  const sizeIds = Array.from({ length: 2000 }, (_, i) => `dp-${i}`);
  const byDownpipe: Record<string, RunHistoryEntry[]> = {};
  for (const id of sizeIds) byDownpipe[id] = realisticRing(id, { lastRunId: `${id}-r1`, status: "ok" });
  const allHistoryBytes = byteLen({ byDownpipe });
  console.log(`  listAllHistory JSON for 2,000 downpipes x 50 realistic entries: ${(allHistoryBytes / MB).toFixed(2)} MB`);
  ok(
    `the all-downpipes payload exceeds the 2 MB first-load threshold (${(allHistoryBytes / MB).toFixed(2)} MB > 2 MB), so first load never uses it`,
    allHistoryBytes > 2 * MB,
  );

  // ---- A + B: first load, then 15 s steady state with NOTHING in flight -----------------------------
  console.log("\n-- A: first load (2,000 downpipes, nothing in flight) --");
  {
    const ids = Array.from({ length: 2000 }, (_, i) => `b-dp-${String(i).padStart(4, "0")}`);
    const fleet = makeFleet("https://engine-a.test", ids, new Set());
    setCaller(OWNER);
    sourcesDownpipesModule._testResetFreshnessPacing?.();
    const clock = fakeClock();
    const root = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams(), pattern: "/downpipes" } as never);
    document.body.appendChild(root as never);
    await clock.settle();

    const firstLoadRequests = totalRequests(fleet);
    const firstLoadBytes = fleet.historyBytes;
    console.log(`  first load: ${firstLoadRequests} request(s), ${(firstLoadBytes / MB).toFixed(3)} MB (listHistory=${fleet.historyCalls}, listAllHistory=${fleet.allHistoryCalls})`);
    ok("A: first load rendered the fleet", qsa(document.body, "tbody tr").length > 0);
    ok("A: first load requests <= 50", firstLoadRequests <= 50);
    ok("A: first load bytes <= 2 MB", firstLoadBytes <= 2 * MB);

    console.log("\n-- B: steady state, 15 s, nothing in flight --");
    const afterFirst = totalRequests(fleet);
    const bytesAfterFirst = fleet.historyBytes;
    await clock.advance(15_000);
    const steadyRequests = totalRequests(fleet) - afterFirst;
    const steadyBytes = fleet.historyBytes - bytesAfterFirst;
    console.log(`  steady state: ${steadyRequests} request(s), ${(steadyBytes / MB).toFixed(3)} MB`);
    ok("B: 0 requests over 15 s with nothing in flight", steadyRequests === 0);
    ok("B: 0 bytes over 15 s with nothing in flight", steadyBytes === 0);

    clock.restore();
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
  }

  // ---- C: steady state, 15 s, 20 runs in flight, plus the positive control --------------------------
  console.log("\n-- C: steady state, 15 s, 20 runs in flight --");
  {
    // "a-..." ids sort ahead of "b-dp-..." (name-ascending is the table's default sort), landing them in
    // the windowed table's rendered slice: the in-flight cohort and the control row are what the operator
    // is actually looking at, which is the scenario this budget is about.
    const flightIds = Array.from({ length: 20 }, (_, i) => `a-flight-${String(i).padStart(2, "0")}`);
    const controlId = "a-control";
    const restIds = Array.from({ length: 1979 }, (_, i) => `b-dp-${String(i).padStart(4, "0")}`);
    const ids = [...flightIds, controlId, ...restIds];
    const fleet = makeFleet("https://engine-c.test", ids, new Set(flightIds));
    setCaller(OWNER);
    sourcesDownpipesModule._testResetFreshnessPacing?.();
    // A short REAL wall-clock wait, belt-and-braces with the reset above: on the RED run against
    // the prior commit, _testResetFreshnessPacing does not exist yet (see the import comment), so
    // this is what keeps a prior scenario's RECENT_LOAD from bleeding into this one there.
    await new Promise<void>((r) => realSetTimeout(r, 3_500));
    const clock = fakeClock();
    const root = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams(), pattern: "/downpipes" } as never);
    document.body.appendChild(root as never);
    await clock.settle();
    ok("C: control row starts Ok before its new run lands", stateCellFor(controlId).includes("Ok"));

    const afterFirst = totalRequests(fleet);
    const bytesAfterFirst = fleet.historyBytes;

    // The positive control: a run lands on the (visible, not-in-flight) control downpipe -- a new
    // runId, outcome "failed" so it is unmistakably different from "Ok". Landed BEFORE the window
    // advances, not partway through it: the rolling budget is ONE shared allowance (fix for the
    // cohort case below), so a huge off-screen trickle that got there FIRST could otherwise spend the
    // whole 30 s budget before the control ever becomes pending, and the fix's own ordering rule --
    // on-screen rows served before the trickle, WITHIN the same budget -- is exactly what this proves:
    // the control (visible) wins its read over the trickle (off-screen) the instant both are pending
    // together on the first post-load refresh.
    fleet.truth.set(controlId, { lastRunId: "a-control-r2", status: "failed" });
    await clock.advance(15_000);

    const steadyRequests = totalRequests(fleet) - afterFirst;
    const steadyBytes = fleet.historyBytes - bytesAfterFirst;
    console.log(`  steady state: ${steadyRequests} request(s), ${(steadyBytes / MB).toFixed(3)} MB (listHistory=${fleet.historyCalls}, listAllHistory=${fleet.allHistoryCalls})`);
    ok("C: steady-state requests <= 20 over 15 s with 20 in flight", steadyRequests <= 20);
    ok("C: steady-state bytes <= 1 MB over 15 s with 20 in flight", steadyBytes <= 1 * MB);
    ok(
      "C positive control: the control row's new run WAS re-read (State now reads Failed, not the stale Ok)",
      stateCellFor(controlId).includes("Failed"),
    );
    ok("C: never called listAllHistory (the fix never does)", fleet.allHistoryCalls === 0);

    clock.restore();
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
  }

  // ---- D: the trickle must not starve on a busy fleet -------------------------------------------
  // THE DEFECT THIS GUARDS: trickle used to run only on the slow 30 s cadence with nothing in flight,
  // so a fleet with some run nearly always in flight (20 always in flight here) never trickled at all,
  // and every off-screen row read "Loading" forever. The fix paces the trickle by WALL-CLOCK time (at
  // most FRESHNESS_TRICKLE_INTERVAL_MS between trickles, whatever is in flight), so this suite drives 5
  // REAL MINUTES of fake time (the fast 4 s in-flight cadence runs the whole way) and checks that the
  // off-screen backlog keeps shrinking, at the same bounded rate, the entire time.
  console.log("\n-- D: the trickle keeps covering off-screen rows over 5 minutes, even with 20 always in flight --");
  {
    const flightIds = Array.from({ length: 20 }, (_, i) => `a-flight-${String(i).padStart(2, "0")}`);
    const restIds = Array.from({ length: 1980 }, (_, i) => `b-dp-${String(i).padStart(4, "0")}`);
    const ids = [...flightIds, ...restIds];
    const fleet = makeFleet("https://engine-d.test", ids, new Set(flightIds));
    setCaller(OWNER);
    sourcesDownpipesModule._testResetFreshnessPacing?.();
    // A short REAL wall-clock wait, belt-and-braces with the reset above: on the RED run against
    // the prior commit, _testResetFreshnessPacing does not exist yet (see the import comment), so
    // this is what keeps a prior scenario's RECENT_LOAD from bleeding into this one there.
    await new Promise<void>((r) => realSetTimeout(r, 3_500));
    const clock = fakeClock();
    const root = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams(), pattern: "/downpipes" } as never);
    document.body.appendChild(root as never);
    await clock.settle();

    // historyCalls is a reliable proxy for "distinct rows read so far": the 20 flight ids are NEVER
    // read (always in flight, skipped entirely -- see table.ts fillFreshness), and every other id, once
    // read, never becomes pending again (a stable lastRunId, never in flight), so no id is ever read
    // twice. Every call after first load is therefore a NEW off-screen row the trickle just covered.
    const afterFirstLoad = fleet.historyCalls;
    const BUCKET_MS = 30_000;
    const TOTAL_MS = 5 * 60_000;
    let lastSample = afterFirstLoad;
    let maxBucketRequests = 0;
    const checkpoints: number[] = [];
    for (let elapsed = BUCKET_MS; elapsed <= TOTAL_MS; elapsed += BUCKET_MS) {
      await clock.advance(BUCKET_MS);
      const now = fleet.historyCalls;
      maxBucketRequests = Math.max(maxBucketRequests, now - lastSample);
      lastSample = now;
      if (elapsed === 150_000 || elapsed === TOTAL_MS) checkpoints.push(now - afterFirstLoad);
    }
    const totalFilled = fleet.historyCalls - afterFirstLoad;
    console.log(`  5 min: ${totalFilled} off-screen row(s) filled after first load (checkpoints at 2.5 min / 5 min: ${checkpoints.join(" / ")}), max requests in any 30 s bucket = ${maxBucketRequests}`);
    ok("D: the 2.5-minute checkpoint already shows progress", checkpoints[0]! > 0);
    ok("D: off-screen unread rows strictly decrease between the two checkpoints (the trickle never stalls)", checkpoints[1]! > checkpoints[0]!);
    ok("D: roughly 200 off-screen rows filled over 5 min (~10 trickles of <= 20)", totalFilled >= 140 && totalFilled <= 220);
    ok("D: no 30 s bucket ever exceeds the 20-request trickle budget", maxBucketRequests <= 20);

    clock.restore();
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
  }

  // ---- E: a status facet must not silently undercount ------------------------------------------
  // THE DEFECT THIS GUARDS: a status facet (Stale/Failed) reads each row's freshness, which an unread
  // row cannot honestly answer; filtering to Failed while most of a 2,000-row fleet is still unread
  // would otherwise show a small, complete-LOOKING list that is actually a large undercount. The fix:
  // sources-downpipes.ts's updateUnreadNote names exactly how many rows are still unread while a status
  // facet is active, and clears once every row has been read.
  console.log("\n-- E: a status facet names how many downpipes have not been read yet, and clears once they are --");
  {
    const ids = Array.from({ length: 200 }, (_, i) => `e-dp-${String(i).padStart(3, "0")}`);
    makeFleet("https://engine-e.test", ids, new Set());
    setCaller(OWNER);
    sourcesDownpipesModule._testResetFreshnessPacing?.();
    // A short REAL wall-clock wait, belt-and-braces with the reset above: on the RED run against
    // the prior commit, _testResetFreshnessPacing does not exist yet (see the import comment), so
    // this is what keeps a prior scenario's RECENT_LOAD from bleeding into this one there.
    await new Promise<void>((r) => realSetTimeout(r, 3_500));
    const clock = fakeClock();
    const root = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams("status=failed"), pattern: "/downpipes" } as never);
    document.body.appendChild(root as never);
    await clock.settle();

    const noteText = (): string => {
      const p = qs(document.body, ".note-quiet p");
      return p ? textOf(p) : "";
    };

    const firstNote = noteText();
    console.log(`  after first load: note = ${JSON.stringify(firstNote)}`);
    ok(
      "E: the note appears while the Failed facet is active and rows are unread",
      /^Run state is still loading for \d+ downpipes\. Each one that matches the filter joins it when its run state loads\.$/.test(firstNote),
    );
    const firstCount = Number(firstNote.match(/for (\d+) downpipe/)?.[1] ?? -1);
    ok("E: the note's count matches the unread total after first load (200 - the 50 budget = 150)", firstCount === 150);

    // Advance until every row has been read (the trickle, 30 s cadence with nothing in flight): the
    // note's count must fall as rows are read and clear entirely once none are left.
    for (let i = 0; i < 12 && noteText() !== ""; i++) await clock.advance(30_000);
    console.log(`  after trickling: note = ${JSON.stringify(noteText())}`);
    ok("E: the note clears once every row has been read", noteText() === "");

    clock.restore();
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
  }

  // ---- M: a route rendered within the RECENT_LOAD window opens its surface after the router's afterEach
  // THE DEFECT THIS GUARDS. Within RECENT_LOAD_TTL_MS of a landed first load, load() reuses the landed result
  // synchronously inside render(). The router then runs afterEach, whose first act is closeAllOverlays(), so a
  // surface opened during render() was closed at once: "New downpipe" changed the URL and opened nothing.
  console.log("\n-- M: a route within the reuse window opens its surface after afterEach --");
  {
    const ids = Array.from({ length: 24 }, (_, i) => `m-dp-${String(i).padStart(2, "0")}`);
    const fleet = makeFleet("https://engine-m.test", ids, new Set());
    setCaller(OWNER);
    sourcesDownpipesModule._testResetFreshnessPacing?.();
    await new Promise<void>((r) => realSetTimeout(r, 3_500));
    const clock = fakeClock();
    const root1 = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams(), pattern: "/downpipes" } as never);
    document.body.appendChild(root1 as never);
    closeAllOverlays();
    await clock.advance(500); // the first load and its fill land (no read latency), inside the reuse window
    const before = totalRequests(fleet);
    const root2 = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams(), pattern: "/downpipes/new" } as never);
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
    document.body.appendChild(root2 as never);
    closeAllOverlays(); // the router's afterEach (app.ts installAfterEach) runs right after render()
    await clock.settle();
    ok("M: the navigation reused the landed load (no new history reads)", totalRequests(fleet) === before);
    ok("M: the create editor (an aria-modal dialog) is open after afterEach ran", qsa(document.body, '[aria-modal="true"]').length > 0);
    closeAllOverlays();
    clock.restore();
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
  }

  // ---- L: the filter note counts only rows that read Loading
  // A paused row reads Paused and a never-run row reads Idle without any read, so neither is "still loading", and
  // neither joins a Stale or Failed filter when read. Counting them overstated the note.
  console.log("\n-- L: the unread-filter note counts only Loading rows --");
  {
    const ids = Array.from({ length: 30 }, (_, i) => `l-dp-${String(i).padStart(2, "0")}`);
    const fleet = makeFleet("https://engine-l.test", ids, new Set());
    const list = fleet.currentList().map((d, i) => {
      if (i < 10) return d; // enabled, has run, unread: Loading
      if (i < 20) return { ...d, config: { ...d.config, enabled: false } }; // Paused
      const { lastRunId: _drop, ...rest } = d; // never run: Idle
      return rest as DownpipeState;
    });
    const count = loadingCount(list, new Map());
    console.log(`  Loading rows counted: ${count} of ${list.length}`);
    ok("L: only the 10 enabled, run, unread rows are counted (not the paused or never-run ones)", count === 10);
    ok("L: the note names that count", unreadFilterNote(count).startsWith("Run state is still loading for 10 downpipes."));
    ok("L: the note says only a matching row joins the filter", unreadFilterNote(count).includes("Each one that matches the filter joins it"));
    ok("L: the singular note reads right", unreadFilterNote(1) === "Run state is still loading for 1 downpipe. If it matches the filter, it joins the filter when its run state loads.");
    ok("L: no note when nothing reads Loading", unreadFilterNote(0) === "");
  }

  // ---- F: a re-render mid-first-load (the identity-resolve race) must not double the first-load reads
  // THE DEFECT THIS GUARDS. app.ts re-renders the on-screen screen, from scratch, the instant the
  // verified caller lands (reRenderCurrentScreenForResolvedIdentity) -- measured at about 0.2 s after
  // this screen's own first paint, far faster than a bounded 2,000-row first-load fill (real network
  // round trips) ever finishes. RECENT_LOAD alone only catches a load that has already LANDED; a
  // re-render at 0.2 s finds it still unset and ran a SECOND full first load of its own: 100 reads in
  // two passes of 50, not 50. The fix: IN_FLIGHT_LOAD shares the CURRENTLY RUNNING fetch + fill with any
  // load() that starts while it is still going, not only a landed result.
  console.log("\n-- F: a re-render about 0.2 s into the first load must not run a second first load --");
  {
    const ids = Array.from({ length: 2000 }, (_, i) => `f-dp-${String(i).padStart(4, "0")}`);
    const fleet = makeFleet("https://engine-f.test", ids, new Set());
    setCaller(OWNER);
    sourcesDownpipesModule._testResetFreshnessPacing?.();
    // A short REAL wall-clock wait, belt-and-braces with the reset above: on the RED run against
    // the prior commit, _testResetFreshnessPacing does not exist yet (see the import comment), so
    // this is what keeps a prior scenario's RECENT_LOAD from bleeding into this one there.
    await new Promise<void>((r) => realSetTimeout(r, 3_500));
    const clock = fakeClock();
    // Give each history read a small SIMULATED network latency (via the active fake clock's own
    // setTimeout), so the first load's fill genuinely takes WALL TIME to finish, controllable by
    // clock.advance -- without this, the stub's instant resolution lets a 50-row fill land within a
    // handful of microtask ticks on EITHER code path, too fast for a fixed microtask-round count to
    // reliably still be "in flight" at the moment a re-render lands, on either the old or the new code.
    const instant = fleet.engine.listHistory.bind(fleet.engine);
    (fleet.engine as unknown as { listHistory: (id: string) => Promise<RunHistoryEntry[]> }).listHistory = (id: string) =>
      new Promise((resolve) => {
        window.setTimeout(() => {
          void instant(id).then(resolve);
        }, 50);
      });

    const root1 = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams(), pattern: "/downpipes" } as never);
    document.body.appendChild(root1 as never);
    // 200 ms of virtual time: with a 50 ms simulated read latency and FRESHNESS_CONCURRENCY 4, at most
    // about 16 of the 50 budgeted rows can possibly have landed (4 concurrent x ~4 waves of 50 ms) -- the
    // fill is genuinely still in flight when the "re-render" below lands, matching app.ts's measured
    // ~0.2 s identity-resolve timing against a real network round trip.
    await clock.advance(200);
    // app.ts's identity-resolve re-render: a second render() of the SAME screen, replacing the first in
    // the shell (shell.setMain), while root1's own load() is still running.
    const root2 = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams(), pattern: "/downpipes" } as never);
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
    document.body.appendChild(root2 as never);
    // Enough virtual time for every delayed read either render started to finish landing.
    await clock.advance(5_000);

    const firstLoadRequests = totalRequests(fleet);
    console.log(`  first load after a re-render mid-fill: ${firstLoadRequests} request(s) (listHistory=${fleet.historyCalls}, listAllHistory=${fleet.allHistoryCalls})`);
    ok("F: the re-rendered screen painted the fleet", qsa(document.body, "tbody tr").length > 0);
    ok("F: first load stays at most 50 even with a re-render mid-fill (no second first-load pass)", firstLoadRequests <= 50);

    clock.restore();
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
  }

  // ---- H: a re-render that joins a FAILING first load must paint the failure, not keep its skeleton
  // The re-render is the render on screen, so when the shared load fails it must show the block error
  // with Retry itself. Before this, it started a fresh load() of its own instead of painting.
  console.log("\n-- H: a re-render joining a failing first load paints the block error --");
  {
    const ids = Array.from({ length: 20 }, (_, i) => `h-dp-${String(i).padStart(2, "0")}`);
    const fleet = makeFleet("https://engine-h.test", ids, new Set());
    setCaller(OWNER);
    sourcesDownpipesModule._testResetFreshnessPacing?.();
    await new Promise<void>((r) => realSetTimeout(r, 3_500));
    const clock = fakeClock();
    let listCalls = 0;
    (fleet.engine as unknown as { listDownpipes: () => Promise<DownpipeState[]> }).listDownpipes = () =>
      new Promise((_resolve, reject) => {
        listCalls++;
        window.setTimeout(() => reject(new Error("engine unavailable")), 100);
      });
    const root1 = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams(), pattern: "/downpipes" } as never);
    document.body.appendChild(root1 as never);
    await clock.advance(50);
    const root2 = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams(), pattern: "/downpipes" } as never);
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
    document.body.appendChild(root2 as never);
    await clock.advance(1_000);
    console.log(`  listDownpipes calls: ${listCalls}`);
    ok("H: the re-rendered screen shows the block error", qsa(document.body, ".block-error").length === 1);
    ok("H: the re-rendered screen is not left on a skeleton", qsa(document.body, ".skeleton-row").length === 0);
    ok("H: the failed load is not fetched again without the operator's Retry", listCalls === 1);

    clock.restore();
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
  }

  // ---- G: the cohort case -- a rolling 30 s budget, not a fresh one per refresh --------------
  // THE DEFECT THIS GUARDS. Each refresh used to get its OWN FRESHNESS_STEADY_BUDGET: a trickle turn
  // could spend 20 reads, and a cohort of on-screen rows leaving flight moments later (in a DIFFERENT
  // refresh) could spend another 20 -- 30 reads measured in one real 30 s window, even though neither
  // refresh individually exceeded its own budget. The fix: ONE rolling ledger (steadyBudgetRemaining),
  // shared by every refresh, checked here as a ROLLING window over every individual request's own
  // timestamp (not a per-refresh or fixed-bucket aggregate, which could hide the same overrun a fixed
  // 0-30s/30-60s bucketing would miss if the two bursts straddle a bucket boundary).
  console.log("\n-- G: the cohort case (a trickle turn, then 10 visible rows leave flight 2 s later) --");
  {
    // 10 ids sort first (visible, the cohort that will leave flight); the other 1990 are the off-screen
    // pool the trickle draws from.
    const cohortIds = Array.from({ length: 10 }, (_, i) => `a-cohort-${String(i).padStart(2, "0")}`);
    const restIds = Array.from({ length: 1990 }, (_, i) => `b-dp-${String(i).padStart(4, "0")}`);
    const ids = [...cohortIds, ...restIds];
    // The cohort starts IN FLIGHT (so first load never reads it; its ids are never pending while in
    // flight -- see table.ts fillFreshness) and leaves flight 2 s after a trickle turn has already run.
    const fleet = makeFleet("https://engine-g.test", ids, new Set(cohortIds));
    setCaller(OWNER);
    sourcesDownpipesModule._testResetFreshnessPacing?.();
    // A short REAL wall-clock wait, belt-and-braces with the reset above: on the RED run against
    // the prior commit, _testResetFreshnessPacing does not exist yet (see the import comment), so
    // this is what keeps a prior scenario's RECENT_LOAD from bleeding into this one there.
    await new Promise<void>((r) => realSetTimeout(r, 3_500));
    const clock = fakeClock();
    const root = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams(), pattern: "/downpipes" } as never);
    document.body.appendChild(root as never);
    await clock.settle();

    // requestLog timestamps EVERY history request by virtual wall-clock time, so the rolling-window
    // check below is a true sliding window over individual requests, not a per-refresh or fixed-bucket
    // count (either of which could hide a straddling overrun).
    const requestLog: number[] = [];
    const engineUnknown = fleet.engine as unknown as { listHistory: (id: string) => Promise<RunHistoryEntry[]> };
    const realListHistory = engineUnknown.listHistory.bind(fleet.engine);
    engineUnknown.listHistory = (id: string) => {
      requestLog.push(Date.now());
      return realListHistory(id);
    };

    // Advance PAST a full trickle interval (nothing else is pending on this calm, 0-further-change fleet
    // besides the off-screen pool, since the cohort stays in flight throughout this stretch) before
    // moving the cohort: the standing poll is on the fast 4 s cadence throughout (the cohort is in
    // flight the whole time), so several cycles pass, one of them spending a trickle turn, before the
    // cohort leaves flight.
    await clock.advance(32_000);
    // The cohort leaves flight together, 2 s after whatever trickle turn just ran: every id both clears
    // inFlight AND lands a fresh run (so it is unambiguously pending, matching "a cohort of runs that
    // just finished").
    for (const id of cohortIds) fleet.inFlightIds.delete(id);
    for (const id of cohortIds) fleet.truth.set(id, { lastRunId: `${id}-r2`, status: "ok" });
    await clock.advance(2_000);
    // Give the on-screen cohort a few more cycles to actually be read.
    await clock.advance(10_000);

    const WINDOW_MS = 30_000;
    let maxInAnyWindow = 0;
    for (const t of requestLog) {
      const count = requestLog.filter((other) => other >= t && other < t + WINDOW_MS).length;
      if (count > maxInAnyWindow) maxInAnyWindow = count;
    }
    console.log(`  ${requestLog.length} total request(s); busiest rolling 30 s window: ${maxInAnyWindow}`);
    ok("G: no rolling 30 s window (checked per request, not per refresh) exceeds 20 history reads", maxInAnyWindow <= 20);
    ok("G: the cohort was in fact exercised (at least one request happened)", requestLog.length > 0);

    clock.restore();
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
  }

  // delayHistory gives listHistory the same simulated network latency F uses, so a 2,000-row fleet's
  // bounded first-load fill genuinely takes wall time (controllable by clock.advance) rather than
  // resolving within a handful of microtask ticks -- without it, a join that mistakenly waits for the
  // fill could still look instant in a test.
  function delayHistory(fleet: Fleet): void {
    const instant = fleet.engine.listHistory.bind(fleet.engine);
    (fleet.engine as unknown as { listHistory: (id: string) => Promise<RunHistoryEntry[]> }).listHistory = (id: string) =>
      new Promise((resolve) => {
        window.setTimeout(() => {
          void instant(id).then(resolve);
        }, 50);
      });
  }

  // ---- I: a route that joins the first load opens the CREATE editor immediately, not after the fill --
  // THE DEFECT THIS GUARDS. Clicking "New downpipe" (sources-downpipes.button.create#1) while the first
  // load's fill is still in flight changed the URL but never opened the create editor: the joining
  // render used to await the WHOLE shared load (list + the bounded fill) before painting or opening
  // anything, and the fill can run for seconds on a large fleet. The fix: a joining render awaits only
  // the list + status (IN_FLIGHT_LIST), paints and opens its route at once, then adopts the fill's
  // latestRun map in place when it lands -- it never starts a fill of its own.
  console.log("\n-- I: a route that joins the first load opens the create editor immediately --");
  {
    const ids = Array.from({ length: 2000 }, (_, i) => `i-dp-${String(i).padStart(4, "0")}`);
    const fleet = makeFleet("https://engine-i.test", ids, new Set());
    setCaller(OWNER);
    sourcesDownpipesModule._testResetFreshnessPacing?.();
    await new Promise<void>((r) => realSetTimeout(r, 3_500));
    const clock = fakeClock();
    delayHistory(fleet);

    const root1 = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams(), pattern: "/downpipes" } as never);
    document.body.appendChild(root1 as never);
    // 200 ms in: with a 50 ms simulated read and FRESHNESS_CONCURRENCY 4, the fill is genuinely still
    // running (same timing F uses for the identity-resolve race).
    await clock.advance(200);

    // The click on "New downpipe" changes the URL and re-renders this screen at /downpipes/new, the
    // way navigate() + the router do, while root1's own load() is still filling.
    const root2 = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams(), pattern: "/downpipes/new" } as never);
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
    document.body.appendChild(root2 as never);
    closeAllOverlays(); // the router's afterEach (app.ts installAfterEach) runs right after render()

    // No virtual time advance: only microtasks drain. The join needs just the list + status (both
    // resolve in a microtask here), not the bounded fill, which a 50 ms-per-read budget of 50 keeps
    // genuinely unfinished at this instant.
    await clock.settle();
    const requestsAtOpen = totalRequests(fleet);
    ok("I: the fill has not finished when the editor opens (a genuine join, not a lucky race)", requestsAtOpen < 50);
    ok("I: the create editor (an aria-modal dialog) is in the DOM within 1 s of the navigation", qsa(document.body, '[aria-modal="true"]').length > 0);

    // Let the shared fill land fully, then check the budgets: the joining render must not have started
    // a SECOND fill of its own (2,000 downpipes would otherwise read close to 100, not at most 50).
    await clock.advance(10_000);
    const totalAfterFill = totalRequests(fleet);
    console.log(`  total history requests across both renders: ${totalAfterFill} (listAllHistory=${fleet.allHistoryCalls})`);
    ok("I: at most 50 history requests total (no second fill from the joining render)", totalAfterFill <= 50);
    ok("I: the history budgets held (first load only, never listAllHistory)", fleet.allHistoryCalls === 0);

    clock.restore();
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
  }

  // ---- J: the same join, for the EDIT editor and the IMPORT drawer -------------------------------
  console.log("\n-- J: a route that joins the first load opens the edit editor immediately --");
  {
    const ids = Array.from({ length: 2000 }, (_, i) => `j-dp-${String(i).padStart(4, "0")}`);
    const fleet = makeFleet("https://engine-j.test", ids, new Set());
    setCaller(OWNER);
    sourcesDownpipesModule._testResetFreshnessPacing?.();
    await new Promise<void>((r) => realSetTimeout(r, 3_500));
    const clock = fakeClock();
    delayHistory(fleet);
    const editId = ids[0];

    const root1 = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams(), pattern: "/downpipes" } as never);
    document.body.appendChild(root1 as never);
    await clock.advance(200);

    const root2 = sourcesDownpipesScreen.render({ params: { id: editId }, query: new URLSearchParams(), pattern: "/downpipes/:id/edit" } as never);
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
    document.body.appendChild(root2 as never);
    closeAllOverlays(); // the router's afterEach (app.ts installAfterEach) runs right after render()

    await clock.settle();
    const requestsAtOpen = totalRequests(fleet);
    ok("J: the fill has not finished when the editor opens", requestsAtOpen < 50);
    ok("J: the edit editor's save button is in the DOM within 1 s of the navigation", qsa(document.body, '[data-dp="sources-downpipes.button.save"]').length > 0);

    await clock.advance(10_000);
    const totalAfterFill = totalRequests(fleet);
    console.log(`  total history requests across both renders: ${totalAfterFill}`);
    ok("J: at most 50 history requests total (no second fill from the joining render)", totalAfterFill <= 50);

    clock.restore();
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
  }

  console.log("\n-- J: a route that joins the first load opens the import drawer immediately --");
  {
    const ids = Array.from({ length: 2000 }, (_, i) => `j2-dp-${String(i).padStart(4, "0")}`);
    const fleet = makeFleet("https://engine-j2.test", ids, new Set());
    setCaller(OWNER);
    sourcesDownpipesModule._testResetFreshnessPacing?.();
    await new Promise<void>((r) => realSetTimeout(r, 3_500));
    const clock = fakeClock();
    delayHistory(fleet);

    const root1 = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams(), pattern: "/downpipes" } as never);
    document.body.appendChild(root1 as never);
    await clock.advance(200);

    const root2 = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams("action=import"), pattern: "/downpipes" } as never);
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
    document.body.appendChild(root2 as never);

    await clock.settle();
    const requestsAtOpen = totalRequests(fleet);
    ok("J: the fill has not finished when the import drawer opens", requestsAtOpen < 50);
    ok("J: the import drawer (an aria-modal dialog) is in the DOM within 1 s of the navigation", qsa(document.body, '[aria-modal="true"]').length > 0);

    await clock.advance(10_000);
    const totalAfterFill = totalRequests(fleet);
    console.log(`  total history requests across both renders: ${totalAfterFill}`);
    ok("J: at most 50 history requests total (no second fill from the joining render)", totalAfterFill <= 50);

    clock.restore();
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
  }

  // ---- K: the same join, for the DETAIL DRAWER, and the chain into the editor from it --------------
  // Live end-to-end journeys found the SAME race on the drawer
  // route: Edit, Enable/Disable and Delete never appeared because the drawer never opened. The drawer's
  // own per-downpipe run-history read (detail.ts loadRunHistory) is independent of the fleet-wide fill
  // and its budget: it is ONE read for the opened downpipe, the same read the drawer always makes.
  console.log("\n-- K: a route that joins the first load opens the detail drawer immediately, with its actions wired --");
  {
    const ids = Array.from({ length: 2000 }, (_, i) => `k-dp-${String(i).padStart(4, "0")}`);
    const fleet = makeFleet("https://engine-k.test", ids, new Set());
    setCaller(OWNER);
    sourcesDownpipesModule._testResetFreshnessPacing?.();
    await new Promise<void>((r) => realSetTimeout(r, 3_500));
    const clock = fakeClock();
    delayHistory(fleet);
    const targetId = ids[0];

    // A minimal router stub: the drawer's Edit action calls navigate() (a pure client-side route
    // change, detail.ts), which the real app turns into a fresh render of this screen at the
    // destination route. This test does the same thing the router does.
    let navTo = "";
    installNav({
      navigate: (to: string) => {
        navTo = to;
      },
      onUnauthorised: () => {},
      refreshIdentity: async () => {},
      onAuthenticated: async () => {},
      signOut: () => {},
    });

    const root1 = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams(), pattern: "/downpipes" } as never);
    document.body.appendChild(root1 as never);
    await clock.advance(200);

    const root2 = sourcesDownpipesScreen.render({ params: { id: targetId }, query: new URLSearchParams(), pattern: "/downpipes/:id" } as never);
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
    document.body.appendChild(root2 as never);
    closeAllOverlays(); // the router's afterEach (app.ts installAfterEach) runs right after render()

    await clock.settle();
    const requestsAtOpen = totalRequests(fleet);
    // The fleet-wide fill has had 200 ms of real concurrent reads (root1, 50 ms each, concurrency 4) by
    // now, so some have already landed; it is the UPPER bound (budget 50) that proves no second fill
    // started, not a near-zero count.
    ok("K: the fill has not finished when the drawer opens", requestsAtOpen < 50);
    ok("K: the detail drawer (an aria-modal dialog) is in the DOM within 1 s of the navigation", qsa(document.body, '[aria-modal="true"]').length > 0);

    const actionLabels = qsa(document.body, '[data-dp="components-detail-drawer.button.action-button"]').map((el) => textOf(el as never));
    console.log(`  drawer actions: ${actionLabels.join(", ")}`);
    ok("K: the Edit action is present", actionLabels.some((l) => l.startsWith("Edit")));
    ok("K: the Enable/Disable toggle is present", actionLabels.some((l) => l === "Enable" || l === "Disable"));
    ok("K: the Delete action is present", actionLabels.some((l) => l.startsWith("Delete")));

    const editBtn = qsa(document.body, '[data-dp="components-detail-drawer.button.action-button"]').find((el) => textOf(el as never).startsWith("Edit"));
    ok("K: the Edit action is clickable", editBtn !== undefined);
    (editBtn as unknown as { click: () => void } | undefined)?.click();
    ok("K: clicking Edit navigated to the edit route", navTo === `/downpipes/${targetId}/edit`);

    // The router's own re-render at the destination route: still joining the SAME first load (root1's
    // fill has not landed yet either).
    const root3 = sourcesDownpipesScreen.render({ params: { id: targetId }, query: new URLSearchParams(), pattern: "/downpipes/:id/edit" } as never);
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
    document.body.appendChild(root3 as never);
    closeAllOverlays(); // the router's afterEach (app.ts installAfterEach) runs right after render()
    await clock.settle();
    ok("K: the editor's save button is in the DOM after following Edit, before the fill lands", qsa(document.body, '[data-dp="sources-downpipes.button.save"]').length > 0);

    await clock.advance(10_000);
    const totalAfterFill = totalRequests(fleet);
    console.log(`  total history requests across three renders: ${totalAfterFill}`);
    // At most 50 for the shared fleet-wide fill, plus the drawer's own single read for targetId.
    ok("K: at most 51 history requests total (no second or third fill from the joining renders)", totalAfterFill <= 51);

    clock.restore();
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} validate-fleet-history-refresh: ${checks} checks, ${failures} failures`);
  verdictReached(failures, checks);
  if (failures > 0) process.exit(1);
}

await main();
