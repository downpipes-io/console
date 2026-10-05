// ONE MALFORMED DOWNPIPE ROW MUST NOT BLANK THE MAP.
//
// The engine's list route returns every stored dp: value verbatim, so a roster ghost or a partial storage write
// reaches the console as a row with no config, or a config with no source. mapDownpipesToFlows dereferenced
// state.config.id and dp.source.type with no guard, so one such row threw, the throw escaped the map load, and
// the whole Map stayed on its first-load skeleton. The drawer's roster clean-up, which is the remedy for exactly
// that row, was on the screen that could not render.
//
// WHAT THIS PINS, as three properties that can each fail on their own:
//   1. NO THROW. The real flow builder, the real body builder and the drawer's list lookups survive a list that
//      holds a config-absent row and a source-absent row.
//   2. THE ADDRESSABLE ROW IS DRAWN. A row with a readable id becomes an "unknown" edge, which is the status the
//      drawer keys its roster note and clean-up on. The healthy rows keep their own edges.
//   3. THE UNADDRESSABLE ROW IS COUNTED. A row with no id cannot be drawn, so the map states the count rather
//      than dropping the row without a word. That holds for a row whose source IS readable but whose id is
//      not: readDownpipe does not judge the id, and that row was drawn as an edge whose id was undefined.
//   4. THE DRAWER NAMES THE FAULT. The unknown edge for an unreadable record shows the fault and the support
//      pack in place of "no run yet" or "not a backup failure", even when the roster report lists it as
//      never-ran and its history holds a failed run, and the Map counts it apart from the run-less edges.
//
// Run: node test/validate-map-malformed-row.ts

import { flushAsync, installDomShim, textOf } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

const { mapDownpipesToFlows, unplacedDownpipeCount } = await import("../src/screens/map/data.ts");
const { buildMapBody } = await import("../src/screens/map/render.ts");
const { buildMapDrawer, copiesRow } = await import("../src/screens/map/drawer.ts");
const { DOWNPIPE_FAULT_REMEDY, downpipeFaultClause } = await import("../src/lib/downpipe-readable.ts");
type MapData = import("../src/screens/map/data.ts").MapData;
type DownpipeState = import("../src/api.ts").DownpipeState;

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const RAN_AT = new Date(NOW - 60_000).toISOString();

function healthy(id: string): DownpipeState {
  return {
    config: { id, name: id, cadenceSeconds: 3600, enabled: true, source: { type: "kv", binding: `KV_${id}`, include: [], exclude: [] } },
    nextRunAt: NOW + 3_600_000,
    lastRunId: "r1",
    inFlight: false,
  } as DownpipeState;
}

// A partial storage write: the value carries no config object at all, so it has no id either.
const CONFIG_ABSENT = { nextRunAt: NOW, inFlight: false } as unknown as DownpipeState;
// A config that names a downpipe and nothing to back up.
const SOURCE_ABSENT = { config: { id: "ghost", name: "ghost", cadenceSeconds: 3600, enabled: true }, inFlight: false } as unknown as DownpipeState;
// A config with a readable source and NO id: readDownpipe reads it, readDownpipeId does not.
const ID_ABSENT = { config: { name: "anon", cadenceSeconds: 3600, enabled: true, source: { type: "kv", binding: "KV_ANON", include: [], exclude: [] } }, inFlight: false } as unknown as DownpipeState;

const RING = [{ runId: "r1", index: 1, status: "ok" as const, startedAt: RAN_AT, finishedAt: RAN_AT }];

function dataFor(rows: DownpipeState[]): MapData {
  return {
    downpipes: { ok: true, value: rows },
    history: { ok: true, value: { a: RING, b: RING } },
    status: { ok: true, value: { destConfigured: true, destKind: "r2" } as never },
    destination: { ok: true, value: { configured: true, kind: "r2" } as never },
    destinations: { ok: true, value: { destinations: [] } as never },
    replication: { ok: true, value: {} },
  };
}

const HEALTHY = dataFor([healthy("a"), healthy("b")]);
const FAULTED = dataFor([healthy("a"), CONFIG_ABSENT, SOURCE_ABSENT, healthy("b")]);
const ID_FAULTED = dataFor([healthy("a"), ID_ABSENT]);

console.log("\n-- 1. no throw --");
let flows: ReturnType<typeof mapDownpipesToFlows> = [];
let threw: unknown = null;
try {
  flows = mapDownpipesToFlows(FAULTED, NOW);
} catch (e) {
  threw = e;
}
ok("mapDownpipesToFlows does not throw on a config-absent row and a source-absent row", threw === null);

let bodyText = "";
try {
  const body = buildMapBody(flows, flows, FAULTED, { visual: null, staleNote: document.createElement("p"), filters: { statusFilter: null, kindFilter: null, nodeFilter: null } } as never, {
    onStatus: () => {},
    onKind: () => {},
    onClearNode: () => {},
    onClearAll: () => {},
    onNavigateSources: () => {},
    onCopyDiagnostics: () => {},
  });
  bodyText = textOf(body as never);
} catch (e) {
  threw = e;
}
ok("the map body builds over the faulted list", threw === null && bodyText !== "");

let drawerThrew = false;
try {
  copiesRow(FAULTED, "a");
  copiesRow(FAULTED, "ghost");
} catch {
  drawerThrew = true;
}
ok("the drawer's list lookup does not throw when a config-absent row precedes the target", !drawerThrew);

console.log("\n-- 2. the addressable row is drawn as unknown --");
ok("both healthy rows keep their own edges", flows.some((f) => f.id === "a") && flows.some((f) => f.id === "b"));
const ghost = flows.find((f) => f.id === "ghost");
ok("the source-absent row with a readable id is drawn", ghost !== undefined);
ok("it reads 'unknown', the status the drawer offers the roster note and clean-up on", ghost?.status === "unknown");
ok("its source node names the fault rather than a fabricated binding", ghost?.source.name === "source (unreadable)");
ok("the healthy rows do not read unknown", flows.filter((f) => f.id === "a" || f.id === "b").every((f) => f.status === "healthy"));

console.log("\n-- 3. the unaddressable row is counted, not dropped --");
ok("unplacedDownpipeCount counts the one row with no readable id", unplacedDownpipeCount(FAULTED) === 1);
ok("a healthy list counts zero (the count can fail)", unplacedDownpipeCount(HEALTHY) === 0);
ok("the map states the unplaced record", bodyText.includes("1 downpipe record that has no readable id"));
ok("the note does not claim the record is unprotected", !/unprotected|not backed up/i.test(bodyText));
const healthyFlows = mapDownpipesToFlows(HEALTHY, NOW);
const healthyText = textOf(buildMapBody(healthyFlows, healthyFlows, HEALTHY, { visual: null, staleNote: document.createElement("p"), filters: { statusFilter: null, kindFilter: null, nodeFilter: null } } as never, {
  onStatus: () => {},
  onKind: () => {},
  onClearNode: () => {},
  onClearAll: () => {},
  onNavigateSources: () => {},
  onCopyDiagnostics: () => {},
}) as never);
ok("the healthy control shows no unplaced note, so the naming check is not free", !healthyText.includes("no readable id"));

const idFlows = mapDownpipesToFlows(ID_FAULTED, NOW);
ok("a row with a readable source and no id draws no edge", idFlows.length === 1 && idFlows[0]?.id === "a");
ok("no edge carries an undefined or empty id", idFlows.every((f) => typeof f.id === "string" && f.id !== ""));
ok("unplacedDownpipeCount counts that row", unplacedDownpipeCount(ID_FAULTED) === 1);

console.log("\n-- 4. the drawer and the notes name the fault --");
ok("the unreadable edge carries its read fault", ghost?.readFault === "source-absent");
ok("the healthy edges carry no read fault", flows.filter((f) => f.id === "a" || f.id === "b").every((f) => f.readFault === undefined));
ok("the map counts the unreadable record apart", bodyText.includes("The console could not read 1 downpipe record"));
ok("and not as a flow with no readable run yet", !bodyText.includes("no readable run yet"));

// The engine lists a source-absent row whose key matches its id under neverRan, and the row has a failed run in
// its history. Neither may produce the generic unknown copy.
const failedRing = [{ runId: "r9", index: 9, status: "failed" as const, startedAt: RAN_AT, finishedAt: RAN_AT }];
const stubEngine = {
  listHistory: () => Promise.resolve(failedRing),
  rosterHygiene: () => Promise.resolve({ ghosts: [], ghostCount: 0, neverRan: [{ id: "ghost" }] }),
};
const faultedWithHistory: MapData = { ...FAULTED, history: { ok: true, value: { a: RING, b: RING, ghost: failedRing } } };
if (ghost !== undefined) {
  const handle = buildMapDrawer(ghost, { engine: stubEngine as never, lastData: faultedWithHistory, onClose: () => {}, refresh: () => {}, canDelete: true, canReconcile: true });
  await flushAsync();
  const drawerText = textOf(document.body as never);
  ok("the drawer names what could not be read", drawerText.includes(downpipeFaultClause("source-absent")));
  ok("the drawer gives the support-pack remedy", drawerText.includes(DOWNPIPE_FAULT_REMEDY));
  ok("the drawer does not say the first scheduled run will start it", !drawerText.includes("first scheduled time"));
  ok("the drawer does not say this is not a backup failure", !drawerText.includes("not a backup failure"));
  ok("the drawer does not say the first backup will set it", !drawerText.includes("first backup will set this"));
  ok("the drawer still lists the failed run under Recent runs", drawerText.includes("Recent runs"));
  handle.close();
}
// The control: a readable edge that reads unknown still gets the generic copy, so the checks above can fail.
{
  const plain = { id: "plain", status: "unknown", source: { name: "src", kind: "kv" }, destination: { name: "dest", kind: "r2" }, enabled: true, running: false } as never;
  const neverRanEngine = { listHistory: () => Promise.resolve([]), rosterHygiene: () => Promise.resolve({ ghosts: [], ghostCount: 0, neverRan: [{ id: "plain" }] }) };
  const plainData: MapData = { ...HEALTHY, history: { ok: true, value: { plain: [] } } };
  const handle = buildMapDrawer(plain, { engine: neverRanEngine as never, lastData: plainData, onClose: () => {}, refresh: () => {}, canDelete: true, canReconcile: true });
  await flushAsync();
  const plainText = textOf(document.body as never);
  ok("control: a readable never-ran edge still says it starts at its first scheduled time", plainText.includes("first scheduled time"));
  ok("control: and names no read fault", !plainText.includes(DOWNPIPE_FAULT_REMEDY));
  handle.close();
}

console.log(failures === 0 ? "\nPASS validate-map-malformed-row" : `\nFAIL validate-map-malformed-row (${failures})`);
verdictReached(failures, checks);
process.exit(failures === 0 ? 0 : 1);
