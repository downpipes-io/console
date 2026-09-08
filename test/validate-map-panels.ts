// Validates the topology map presentation + filter leaves (src/screens/map/panels.ts and the pure
// filter application in src/screens/map/url.ts): the parsers, the status / kind vocabularies, the
// node-id label split, the freshness line text, the recent-runs list, and applyFilters over a
// cached flow set. These drive the operator's primary health-monitoring view, so a regression in
// any of them silently shows wrong filter counts or wrong freshness words. The DOM-producing
// helpers (freshnessLine, recentRunsList, destinationNote) render under the shared DOM shim and
// are asserted by their textContent. Run: node test/validate-map-panels.ts.

// The DOM shim is installed FIRST so the h()-based renderers and lib/dom.ts resolve the element
// APIs. None of the modules below touch document at LOAD time (their document use is inside
// functions), so the install order is sound.
import { installDomShim } from "./dom-shim.ts";
installDomShim();

import {
  STATUS_ORDER,
  KIND_ORDER,
  parseStatusFilter,
  parseKindFilter,
  statusPresent,
  statusFilterLabel,
  statusFilterTone,
  kindLabel,
  nodeFilterLabel,
  freshnessLine,
  recentRunsList,
  destinationNote,
} from "../src/screens/map/panels.ts";
import { applyFilters } from "../src/screens/map/url.ts";
import type { FilterState } from "../src/screens/map/filter-bar.ts";
import type { FlowRecord, FlowStatus, NodeKind, FlowEndpoint } from "../src/components/topology.ts";
import type { RunHistoryEntry } from "../src/api.ts";
import type { MapData } from "../src/screens/map/data.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// Every FlowStatus the map can carry (the source of truth the parsers / labels must cover).
const ALL_STATUSES: FlowStatus[] = ["healthy", "stale", "partial", "no-copy", "failed", "disabled", "unknown"];
const ALL_KINDS: NodeKind[] = ["kv", "r2", "d1", "secrets", "s3", "other"];

function endpoint(kind: NodeKind, name: string): FlowEndpoint {
  return { kind, name };
}

function flow(id: string, status: FlowStatus, sourceKind: NodeKind, sourceName: string): FlowRecord {
  return {
    id,
    source: endpoint(sourceKind, sourceName),
    destination: endpoint("r2", "downpipes-archive"),
    status,
    enabled: status !== "disabled",
    running: false,
  };
}

// ---- the status / kind vocabularies cover every value (including 'partial') ----------------

for (const s of ALL_STATUSES) {
  // statusPresent and statusFilterLabel must return a non-empty label for EVERY status, so a new
  // status (here 'partial') can never fall through to undefined and blank the badge.
  const present = statusPresent(s);
  ok(`statusPresent(${s}) yields a non-empty label + tone`, present.label.length > 0 && present.tone.length > 0);
  ok(`statusFilterLabel(${s}) is non-empty`, statusFilterLabel(s).length > 0);
  ok(`statusFilterTone(${s}) matches statusPresent`, statusFilterTone(s) === present.tone);
}
ok("'partial' presents as a warn tone (not a false-green)", statusPresent("partial").tone === "warn");
// The never-reported lane is its own filterable status. It is amber (the run succeeded and the data is
// safe on the destinations that reported), and it reads a DIFFERENT word from partial, because "catching up"
// is what kept a destination that was making no copy at all looking like one that would fix itself.
ok("'no-copy' presents as a warn tone (never a false-green, never a false-red)", statusPresent("no-copy").tone === "warn");
ok("'no-copy' does not read as 'Partial'", statusPresent("no-copy").label !== statusPresent("partial").label);
ok("STATUS_ORDER includes 'no-copy', so the map can be filtered to exactly these lanes", STATUS_ORDER.includes("no-copy"));
ok("'no-copy' sorts WORSE than 'partial' (a copy that is behind is being made; this one is not)", STATUS_ORDER.indexOf("no-copy") < STATUS_ORDER.indexOf("partial"));
ok("STATUS_ORDER includes 'partial'", STATUS_ORDER.includes("partial"));
ok("STATUS_ORDER covers every FlowStatus exactly once", STATUS_ORDER.length === ALL_STATUSES.length && ALL_STATUSES.every((s) => STATUS_ORDER.includes(s)));

for (const k of ALL_KINDS) {
  ok(`kindLabel(${k}) is non-empty`, kindLabel(k).length > 0);
}
ok("KIND_ORDER covers every NodeKind", KIND_ORDER.length === ALL_KINDS.length && ALL_KINDS.every((k) => KIND_ORDER.includes(k)));

// ---- the parsers accept the valid set, reject junk, and treat null as 'all' -----------------

for (const s of ALL_STATUSES) {
  ok(`parseStatusFilter('${s}') round-trips`, parseStatusFilter(s) === s);
}
ok("parseStatusFilter(null) is null (all)", parseStatusFilter(null) === null);
ok("parseStatusFilter('') is null", parseStatusFilter("") === null);
ok("parseStatusFilter('bogus') is null", parseStatusFilter("bogus") === null);
ok("parseStatusFilter('Healthy') is null (case-sensitive, no coercion)", parseStatusFilter("Healthy") === null);

for (const k of ALL_KINDS) {
  ok(`parseKindFilter('${k}') round-trips`, parseKindFilter(k) === k);
}
ok("parseKindFilter(null) is null (all)", parseKindFilter(null) === null);
ok("parseKindFilter('bogus') is null", parseKindFilter("bogus") === null);

// ---- nodeFilterLabel: the name is the tail after '<side>:<kind>:', colons in the name kept ----

ok("nodeFilterLabel of a plain id returns the name", nodeFilterLabel("source:kv:my-namespace") === "my-namespace");
ok("nodeFilterLabel keeps a colon inside the name", nodeFilterLabel("destination:r2:bucket:with:colons") === "bucket:with:colons");
ok("nodeFilterLabel of a malformed id (no separators) returns it whole", nodeFilterLabel("orphan") === "orphan");
ok("nodeFilterLabel of a two-part id returns it whole", nodeFilterLabel("source:kv") === "source:kv");

// ---- applyFilters: every combination is a pure view over the cached flow set -----------------

const flows: FlowRecord[] = [
  flow("a", "healthy", "kv", "ns-a"),
  flow("b", "failed", "r2", "bucket-b"),
  flow("c", "partial", "kv", "ns-c"),
  flow("d", "stale", "d1", "db-d"),
];
const noFilter: FilterState = { statusFilter: null, kindFilter: null, nodeFilter: null };
ok("no filter returns the whole set", applyFilters(flows, noFilter).length === 4);

const partialOnly: FilterState = { statusFilter: "partial", kindFilter: null, nodeFilter: null };
ok("status=partial selects only the partial flow", applyFilters(flows, partialOnly).map((f) => f.id).join(",") === "c");

const kvOnly: FilterState = { statusFilter: null, kindFilter: "kv", nodeFilter: null };
ok("kind=kv selects both KV-sourced flows", applyFilters(flows, kvOnly).map((f) => f.id).join(",") === "a,c");

const kvAndHealthy: FilterState = { statusFilter: "healthy", kindFilter: "kv", nodeFilter: null };
ok("status+kind compose (kv AND healthy)", applyFilters(flows, kvAndHealthy).map((f) => f.id).join(",") === "a");

const nodeFilter: FilterState = { statusFilter: null, kindFilter: null, nodeFilter: "source:kv:ns-c" };
ok("node filter selects the flow incident on that node", applyFilters(flows, nodeFilter).map((f) => f.id).join(",") === "c");

const noMatch: FilterState = { statusFilter: "disabled", kindFilter: null, nodeFilter: null };
ok("a filter with no match returns the empty set", applyFilters(flows, noMatch).length === 0);

// ---- freshnessLine: the detail text differs per status (the 'partial' fall-through guard) -----

function freshnessText(status: FlowStatus, ring: RunHistoryEntry[] | null): string {
  return (freshnessLine(flow("x", status, "kv", "ns-x"), ring) as unknown as { textContent: string }).textContent;
}
const failedText = freshnessText("failed", null);
ok("freshnessLine(failed) names the failure", failedText.includes("failed"));
ok("freshnessLine(stale) names the cadence", freshnessText("stale", null).includes("older than the expected cadence"));
ok("freshnessLine(disabled) names the pause", freshnessText("disabled", null).includes("paused"));
ok("freshnessLine(partial) is non-empty (no fall-through to blank)", freshnessText("partial", null).length > 0);
ok("freshnessLine(healthy) reads current", freshnessText("healthy", null).includes("current"));
ok("freshnessLine(unknown, never run) names the first backup", freshnessText("unknown", []).includes("No run yet"));
ok("freshnessLine(unknown, unreadable) says not a failure", freshnessText("unknown", null).includes("not a backup failure"));

// A "failed" edge has two origins. A genuine capture failure points at Recent runs; a lane-only
// failure (one destination unreachable, the run itself fine) must point at Copies, because Recent runs
// shows no failure. The two must render DIFFERENT sentences off the laneFailed flag.
function freshnessTextFlow(f: FlowRecord): string {
  return (freshnessLine(f, null) as unknown as { textContent: string }).textContent;
}
const captureFailed = freshnessTextFlow(flow("cap", "failed", "kv", "ns-cap"));
const laneFailed = freshnessTextFlow({ ...flow("lane", "failed", "kv", "ns-lane"), laneFailed: true });
ok("a genuine capture failure still points at Recent runs", captureFailed.includes("under Recent runs"));
ok("a lane-only failure does NOT point at Recent runs (no failure is there to find)", !laneFailed.includes("Recent runs"));
ok("a lane-only failure points at Copies below (where the real cause is)", laneFailed.includes("Copies below"));
ok("a lane-only failure states the run itself completed (the run did not fail)", laneFailed.includes("backup run itself completed"));
ok("the two 'failed' origins render DIFFERENT sentences (never conflated)", captureFailed !== laneFailed);

// ---- recentRunsList: caps at 12 entries and assigns a tone word per run status ---------------

function run(index: number, status: RunHistoryEntry["status"]): RunHistoryEntry {
  return { runId: `r${index}`, index, startedAt: "2026-06-22T00:00:00Z", status };
}
const fifteen = Array.from({ length: 15 }, (_, i) => run(i, "ok"));
const list = recentRunsList(fifteen) as unknown as { querySelectorAll(sel: string): unknown[] };
ok("recentRunsList caps the rendered rows at 12", list.querySelectorAll("li").length === 12);

const mixed = recentRunsList([run(0, "ok"), run(1, "failed"), run(2, "in-flight")]) as unknown as { textContent: string };
ok("recentRunsList labels an ok run", mixed.textContent.includes("ok"));
ok("recentRunsList labels a failed run", mixed.textContent.includes("failed"));
ok("recentRunsList labels an in-flight run", mixed.textContent.includes("in-flight"));

const withError = recentRunsList([{ ...run(0, "failed"), error: "destination unreachable" }]) as unknown as { textContent: string };
ok("recentRunsList surfaces a failed run's error text", withError.textContent.includes("destination unreachable"));

// ---- destinationNote: the honesty statement adapts to flow count + destination state ----------

function note(data: MapData, fs: FlowRecord[]): string {
  return (destinationNote(fs, data) as unknown as { textContent: string }).textContent;
}
// destinationNote reads only data.status (destKind / destConfigured) and the bucket via
// destinationBucket(data.destination); the other Settled fields are unread here, so a partial
// fixture cast to MapData is sound for this leaf.
function mapDataWith(status: MapData["status"], destBucket: string | null): MapData {
  return {
    status,
    destination: destBucket !== null ? { ok: true, value: { bucket: destBucket } } : { ok: false, error: null },
  } as unknown as MapData;
}
const okR2 = { ok: true as const, value: { destKind: "r2", destConfigured: true } } as unknown as MapData["status"];
const r2Data = mapDataWith(okR2, "downpipes-archive");
ok("destinationNote(no flows, R2) invites adding downpipes", note(r2Data, []).includes("Add downpipes"));
ok("destinationNote(one flow, R2) names the R2 archive", note(r2Data, [flow("a", "healthy", "kv", "ns-a")]).includes("R2 archive"));
ok("destinationNote names the real bucket when the engine states it", note(r2Data, [flow("a", "healthy", "kv", "ns-a")]).includes("downpipes-archive"));

const unreadable = mapDataWith({ ok: false, error: null } as unknown as MapData["status"], null);
ok("destinationNote(unreadable destination) is honest about unknown", note(unreadable, []).includes("could not be read"));

if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nMAP PANELS VECTORS PASS");
