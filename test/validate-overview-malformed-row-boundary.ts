// ONE MALFORMED DOWNPIPE ROW MUST NOT BLANK THE OVERVIEW, and where a section cannot be built the
// screen must say so IN THAT SECTION'S PLACE.
//
// WHAT THIS PINS, and it is two properties rather than one, because a repair for the first can
// introduce the second. The crash is that a row the console cannot read threw and, with no boundary
// anywhere in buildOverview and no catch on the async load, froze the whole screen on its first-load
// skeleton: nine stat tiles to none, in a real browser on the served bundle. The repair's own
// failure mode is quieter: a section that fails and renders NOTHING passes any check that only asks
// whether the page came up. A tile that quietly disappears is the same defect wearing better clothes.
//
// SO IT ASSERTS THREE THINGS THAT CAN EACH FAIL SEPARATELY:
//   1. NO THROW. Every Overview builder survives a downpipe list carrying a malformed row.
//   2. NO SILENT DROP. The unreadable row is still COUNTED and still on screen. Dropping it would make
//      the console's fleet count silently disagree with the engine's, which is unfalsifiable from the
//      operator's chair.
//   3. NO COLLISION, AND A NAME. The rendered text of a faulted estate must differ from a healthy one,
//      and the difference must actually say a downpipe could not be read rather than only moving a
//      number. Byte-identity is the test that cannot be satisfied by vocabulary; the naming test is the
//      one that catches a screen that differs and explains nothing.
//
// AND IT GRADES ITS OWN NAMING TEST. The healthy control is run through the same names-a-fault check,
// and if the healthy screen already matches it, the check passes for free and the run says so rather
// than reporting a green. A detector that cannot fail is not a detector.
//
// A companion browser-level check drives the committed public/ bundle in a real Chromium against a
// same-origin fixture engine, to prove the same properties hold once assets are actually built and
// served. This file is what keeps the same properties from regressing without a browser in the loop.
//
// Run with `node test/validate-overview-malformed-row-boundary.ts`.

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { readDownpipe, readDownpipeId } from "../src/lib/downpipe-readable.ts";
import { protectionStatement, fleetProtection, sourceTypeLabel, destinationFromStatus } from "../src/lib/protection-statement.ts";
import { buildOverview } from "../src/screens/overview/build.ts";
import { summariseFleet } from "../src/screens/overview/fleet-data.ts";
import type { DownpipeState, StatusReport } from "../src/api.ts";
import type { OverviewData } from "../src/screens/overview/shared.ts";

let failures = 0;
let checks = 0;
function ok(label: string): void { checks++; console.log(`  ok   ${label}`); }
function fail(label: string): void { checks++; failures++; console.log(`  FAIL ${label}`); }
function is(label: string, cond: boolean): void { (cond ? ok : fail)(label); }

// ---------------------------------------------------------------------------
// The estate
// ---------------------------------------------------------------------------

// The wall clock, NOT a pinned date: the healthy rows' proven/verified stamps sit hours before NOW, and
// buildOverview reads the REAL Date.now(), so a pinned fixture date would eventually read as stale, the
// coverage line would qualify itself, and the unqualified-all-clear check would go red with nothing
// wrong. A pinned world the screen's own clock has moved past is a fixture no estate ever resembles.
// Every offset below is relative, so the fixture stays deterministic in shape at any wall clock.
const NOW = Date.now();
const HOUR = 3_600_000;

function healthyRow(id: string, type: "kv" | "r2" | "d1", binding: string): DownpipeState {
  return {
    config: { id, name: id, cadenceSeconds: 86400, enabled: true, source: { type, binding, include: [], exclude: [] } },
    nextRunAt: NOW + HOUR,
    lastRunId: `run-${id}`,
    inFlight: false,
    lastRestoreTestAt: new Date(NOW - 2 * HOUR).toISOString(),
    lastRestoreTestOk: true,
    lastRestoreProvenAt: new Date(NOW - 3 * HOUR).toISOString(),
    lastRestoreProvenBy: "alice",
    lastIntegrityVerifiedAt: new Date(NOW - 2 * HOUR).toISOString(),
    lastIntegrityVerifiedOk: true,
  } as DownpipeState;
}

const HEALTHY: DownpipeState[] = [healthyRow("dp-uploads", "kv", "UPLOADS"), healthyRow("dp-archive", "r2", "ARCHIVE"), healthyRow("dp-ledger", "d1", "LEDGER")];

// The three malformed shapes are the ones the engine's own roster-hygiene module names and says the
// list returns, cast through `unknown` exactly as they arrive: the declared type is what the contract
// promises, not what the wire carried.
const ROW_SOURCE_ABSENT = { config: { id: "dp-ghost", name: "ghost", cadenceSeconds: 86400, enabled: true }, nextRunAt: null, lastRunId: null, inFlight: false } as unknown as DownpipeState;
const ROW_TYPE_ABSENT = { config: { id: "dp-ghost", name: "ghost", cadenceSeconds: 86400, enabled: true, source: { include: [], exclude: [] } }, nextRunAt: null, lastRunId: null, inFlight: false } as unknown as DownpipeState;
const ROW_CONFIG_NULL = { config: null, nextRunAt: null, lastRunId: null, inFlight: false } as unknown as DownpipeState;
const MALFORMED: Array<[string, DownpipeState]> = [["source absent", ROW_SOURCE_ABSENT], ["source type absent", ROW_TYPE_ABSENT], ["config null", ROW_CONFIG_NULL]];

const STATUS: StatusReport = {
  service: "downpipes-engine",
  engineVersion: "0.1.10",
  signerConfigured: true,
  breakGlassConfigured: true,
  operationalConfigured: { public: true, private: true },
  destConfigured: true,
  destKind: "r2",
  updateChannelConfigured: true,
  licenceConfigured: true,
  downpipeCount: 3,
  ready: true,
} as StatusReport;

const DEST = destinationFromStatus(STATUS);

function overviewData(rows: DownpipeState[]): OverviewData {
  return {
    health: { ok: true, value: { ok: true, service: "downpipes-engine" } },
    status: { ok: true, value: STATUS },
    licence: { ok: true, value: { tier: "business", valid: true } },
    updates: { ok: true, value: { current: "0.1.10" } },
    history: { ok: true, value: {} },
    downpipes: { ok: true, value: rows },
    drillEvidence: { ok: true, value: [] },
    audit: { ok: true, value: [] },
    approvals: { ok: true, value: [] },
    // Discovery SETTLES OK. It was `ok:false` in the first draft of this file, and the naming check's
    // own self-grading assertion caught it: a failed discovery makes the coverage hero print "6 could
    // not be read", so the healthy control matched the names-a-fault pattern and the check would have
    // passed for free on every arm. The control has to be genuinely healthy or an absent phrase in a
    // faulted arm proves nothing.
    discovery: { ok: true, value: { bound: { kv: ["UPLOADS"], r2: ["ARCHIVE"], d1: ["LEDGER"], secrets: [] }, accounts: [], tokenPresent: false } },
  } as unknown as OverviewData;
}

const CB = { onDrillFleet: () => {}, announce: () => {} };

function renderText(rows: DownpipeState[]): string {
  const el = buildOverview(overviewData(rows), CB);
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------

console.log("one malformed row must not blank the Overview");

// 1. THE READER. Each malformed shape is classified, and a healthy row is not.
console.log("\nthe reader");
for (const [label, row] of MALFORMED) {
  is(`${label}: readDownpipe refuses it`, readDownpipe(row).readable === false);
}
is("a healthy row reads as readable", readDownpipe(HEALTHY[0]!).readable === true);
is("a healthy row's id reads back", readDownpipeId(HEALTHY[0]!) === "dp-uploads");
is("a config-null row has no readable id", readDownpipeId(ROW_CONFIG_NULL) === null);
// THE CONTROL THAT MATTERS MOST HERE: a source type this build does not know is READABLE, not a fault.
// Coarsening version skew into corruption would file an engine one release ahead as a malformed roster.
const FUTURE_TYPE = { config: { id: "dp-new", name: "new", cadenceSeconds: 86400, enabled: true, source: { type: "queues", include: [], exclude: [] } }, nextRunAt: null, lastRunId: null, inFlight: false } as unknown as DownpipeState;
is("an UNKNOWN but present source type is readable, not a read fault", readDownpipe(FUTURE_TYPE).readable === true);
is("sourceTypeLabel names an unknown type rather than returning undefined", sourceTypeLabel("queues" as never) === "queues");

// 2. NO THROW, anywhere on the Overview.
console.log("\nno throw");
for (const [label, row] of MALFORMED) {
  const rows = [...HEALTHY, row];
  let threw: string | null = null;
  try {
    protectionStatement(row, DEST, NOW);
    fleetProtection(rows, DEST, NOW);
    summariseFleet(overviewData(rows), NOW);
    buildOverview(overviewData(rows), CB);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  is(`${label}: no builder on the Overview throws${threw === null ? "" : ` (threw: ${threw})`}`, threw === null);
}

// 3. NO SILENT DROP. The row is counted, and the fleet total moves.
console.log("\nno silent drop");
for (const [label, row] of MALFORMED) {
  const rows = [...HEALTHY, row];
  const fp = fleetProtection(rows, DEST, NOW);
  is(`${label}: the unreadable row is counted as unreadable`, fp.counts.unreadable === 1);
  is(`${label}: the fleet total counts all four rows, not three`, fp.counts.covered + fp.counts.partial + fp.counts.unproven + fp.counts.uncovered + fp.counts.unreadable === 4);
  is(`${label}: the fleet roll-up keeps a row for it`, summariseFleet(overviewData(rows), NOW).total === 4);
  is(`${label}: the tone is never "covered" with a row we could not read`, fp.tone !== "covered");
}

// 4. NO COLLISION, AND A NAME.
console.log("\nno collision, and a name");
const NAMES_A_FAULT = /could not be read|cannot be described/i;
const healthyText = renderText(HEALTHY);
const blindAt = NAMES_A_FAULT.exec(healthyText);
if (blindAt !== null) {
  // The surrounding text is printed because "the check is blind" is useless without the phrase that
  // blinded it: the repair is either to narrow the pattern or to fix a control that is not healthy.
  fail(`THE NAMING CHECK IS BLIND: the healthy control already matches the names-a-fault test, so it passes for free. Matched at: ...${healthyText.slice(Math.max(0, blindAt.index - 90), blindAt.index + 90)}...`);
} else {
  ok("the naming check is live: a healthy estate does not match it");
}
for (const [label, row] of MALFORMED) {
  const text = renderText([...HEALTHY, row]);
  is(`${label}: the screen is NOT byte-identical to a healthy estate`, text !== healthyText);
  is(`${label}: the screen says a downpipe could not be read`, NAMES_A_FAULT.test(text));
}
// The all-clear must not survive an unreadable row. This is the sentence with the most to lose.
is("a healthy estate still gets the unqualified all-clear", /Every downpipe is backed up/.test(healthyText));
is("an estate with an unreadable row does NOT get the unqualified all-clear", !/Every downpipe is backed up/.test(renderText([...HEALTHY, ROW_SOURCE_ABSENT])));

// 5. THE HEALTHY PATH IS UNTOUCHED. Every unreadable arm is guarded on a count that is zero, so a fleet
//    with nothing wrong reads exactly as it did before the fifth tone existed. This is the control that
//    fails if this repair ever starts crying wolf.
console.log("\nthe healthy path is untouched");
const clean = fleetProtection(HEALTHY, DEST, NOW);
is("a healthy fleet summary names no unreadable rows", clean.summary === "3 downpipes: 3 covered.");
is("a healthy fleet tone is still covered", clean.tone === "covered");
is("a healthy fleet not-covered line is the unqualified all-clear", clean.notCovered.startsWith("Every downpipe is backed up and its restorability is proven and current."));

// 6. THE BOUNDARY. A section that throws must be replaced by a NAMED card, never by nothing. Driven by
//    handing the roll-up a history ring of the wrong TYPE, which no field guard anticipates: that is
//    what an error boundary is the floor under, and an assertion about a boundary nothing exercises is
//    an assertion about nothing.
console.log("\nthe boundary: a tile that cannot render fails as a tile");
const wrongShape = overviewData(HEALTHY) as unknown as { history: { ok: boolean; value: unknown } };
wrongShape.history = { ok: true, value: { "dp-uploads": { 0: { runId: "r", status: "ok" } } } };
let boundaryThrew: string | null = null;
let boundaryText = "";
try {
  boundaryText = (buildOverview(wrongShape as unknown as OverviewData, CB).textContent ?? "").replace(/\s+/g, " ").trim();
} catch (e) {
  boundaryThrew = e instanceof Error ? e.message : String(e);
}
is(`a section that throws does not take the screen down${boundaryThrew === null ? "" : ` (threw: ${boundaryThrew})`}`, boundaryThrew === null);
is("the rest of the Overview still rendered", boundaryText.length > 200);
is("the failed section is NAMED in its own place, not silently omitted", /could not be rendered/.test(boundaryText));
is("the card says this is a fault in the screen, not a finding about the estate", /says nothing about whether your backups are running/.test(boundaryText));

console.log(`\nVERDICT: ${failures === 0 ? "PASS" : "FAIL"} failures=${failures} checks=${checks}`);
if (failures > 0) process.exitCode = 1;
if (failures > 0) process.exit(1);
