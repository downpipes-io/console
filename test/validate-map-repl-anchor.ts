// THE CRY-WOLF REGRESSION: DRIVE THE REAL MAP SCREEN.
//
// The engine carries an anchor that says HOW MANY successful backups have completed since a destination joined a
// downpipe's fan-out (sealedRuns minus the destination's replAnchors entry). The support pack projects it and the
// bot gates on it: the bot only fires "this destination has never held a copy" at two or more, so a destination
// added minutes ago does not cry wolf. The console never got the anchor, and the console is the SITE the gap
// names. So its map edge (components/replication.ts destinationLaneStatus) painted the escalate-flavoured
// "no-copy" lane -- ranked 1 of 7, WORSE than stale and partial (screens/map/panels.ts STATUS_RANK) -- on a
// destination configured five minutes ago, and could not tell it from one dark for months.
//
// THIS SUITE DRIVES THE REAL SCREEN, not the pure helper (test/validate-replication.ts covers that). It builds the
// real MapData an engine poll produces and runs it through the REAL mapDownpipesToFlows, then asserts on EVERY
// consumer of the lane, because the milder half of this bug is a consumer the fix forgets:
//
//   1. the map LANE          screens/map/data.ts        -> destinationLaneStatus on the fan-out edge
//   2. the panel RANK        screens/map/panels.ts      -> STATUS_ORDER / parseStatusFilter (the filter bar)
//   3. the panel TONE+LABEL  screens/map/panels.ts      -> statusPresent / statusFilterLabel (the drawer badge)
//   4. the panel EXPLAINER   screens/map/panels.ts      -> freshnessLine ("no copy is being made here")
//   5. the LIVE REGION       screens/map/render.ts      -> summaryAnnouncement (what a screen reader hears)
//   6. the SVG aria SUMMARY  components/topology-encoding.ts -> tally / freshnessPhrase
//   7. the EDGE MOTION       components/topology-model.ts    -> hasAmbientSheen (a no-copy lane is inert)
//   8. the DRAWER LINE       screens/map/drawer.ts      -> copiesRow ("N of M copies - 1 never reported")
//
// TWO STATES, ONE FLEET, and they must not paint the same lane:
//   NEW   a destination added minutes ago to a downpipe that has already run 5 times. Healthy. Owed nothing yet.
//   DARK  a destination that has held no copy across those same 5 successful backups. Escalate.
//
// Run: node test/validate-map-repl-anchor.ts

import { installDomShim, textOf } from "./dom-shim.ts";

installDomShim();

const { mapDownpipesToFlows } = await import("../src/screens/map/data.ts");
const { statusPresent, statusFilterLabel, STATUS_ORDER, freshnessLine } = await import("../src/screens/map/panels.ts");
const { summaryAnnouncement } = await import("../src/screens/map/render.ts");
const { tally, freshnessPhrase } = await import("../src/components/topology-encoding.ts");
const { hasAmbientSheen } = await import("../src/components/topology-model.ts");
const { copiesRow } = await import("../src/screens/map/drawer.ts");
const { mapEngineDownpipeState } = await import("../src/lib/api/helpers.ts");
type MapData = import("../src/screens/map/data.ts").MapData;
type FlowRecord = import("../src/components/topology.ts").FlowRecord;

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// ---- the fleet, in the ENGINE's own wire shape ------------------------------------------------------------
// Both downpipes fan out to d1 (which reports and holds every run) and d2 (which the engine has NEVER reported
// on). The ONLY thing that differs is the anchor, which is the point: without it these two rows are identical.
const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);
const RAN_AT = new Date(NOW - 60_000).toISOString(); // one minute ago: fresh at a 1h cadence

function wire(id: string, sealedRuns: number, d2Anchor: number) {
  return {
    config: {
      id,
      name: id,
      cadenceSeconds: 3600,
      enabled: true,
      // include/exclude are REQUIRED on SourceSpec; empty means every surface, which is what this
      // fixture intends. The map never reads them, so they complete the shape without changing it.
      source: { type: "kv" as const, binding: "KV", namespaceId: "ns", include: [], exclude: [] },
      destinationIds: ["d1", "d2"],
    },
    nextRunAt: NOW + 3_600_000,
    lastRunId: "r5",
    inFlight: false,
    // THE ANCHOR, exactly as GET /admin/downpipes forwards it (scheduler-do.ts listDownpipes returns the state
    // verbatim). 5 successful backups for all time; d1 and d2 anchored at the count they entered the fan-out at.
    sealedRuns,
    replAnchors: { d1: 0, d2: d2Anchor },
  };
}

// NEW: d2 anchored at 5, the CURRENT count. An operator added it minutes ago to a downpipe that has already run
// five times. No backup has completed since, so no copy is owed and no row can exist yet.
// DARK: d2 anchored at 0. Five backups have SUCCEEDED since d2 joined and it holds none of them.
const FLEET = [wire("new", 5, 5), wire("dark", 5, 0)].map(mapEngineDownpipeState);

// index is REQUIRED on RunHistoryEntry and is the RUNLOG position; r5 is the fifth run, and the map
// never reads it, so this completes the shape without moving anything the test asserts.
const RING = [{ runId: "r5", index: 5, status: "ok" as const, startedAt: RAN_AT, finishedAt: RAN_AT }];

const DATA: MapData = {
  downpipes: { ok: true, value: FLEET },
  history: { ok: true, value: { new: RING, dark: RING } },
  status: { ok: true, value: { destConfigured: true, destKind: "r2" } as never },
  destination: { ok: true, value: { configured: true, kind: "r2" } as never },
  destinations: { ok: true, value: { destinations: [{ id: "d1", label: "Primary" }, { id: "d2", label: "Offsite" }] } as never },
  // d2 has NO replication heartbeat on either downpipe. That absence is the whole ambiguity.
  replication: { ok: true, value: { new: { d1: { holdsRunId: "r5", holdsIndex: 5, lastOk: true, lastAttemptAt: NOW } }, dark: { d1: { holdsRunId: "r5", holdsIndex: 5, lastOk: true, lastAttemptAt: NOW } } } },
};

const flows = mapDownpipesToFlows(DATA, NOW);
const edge = (dp: string, dest: string): FlowRecord => flows.find((f) => f.id === `${dp}__${dest}`) as FlowRecord;

const newD2 = edge("new", "d2");
const darkD2 = edge("dark", "d2");
const newD1 = edge("new", "d1");

// ---- THE PRINTOUT: the two states, on the real screen -----------------------------------------------------
function print(title: string, f: FlowRecord, dpId: string): void {
  const p = statusPresent(f.status);
  const row = copiesRow(DATA, f.id);
  console.log(`\n  ${title}`);
  console.log(`    lane status      ${f.status}`);
  console.log(`    filter rank      ${STATUS_ORDER.indexOf(f.status) + 1} of ${STATUS_ORDER.length}  (${statusFilterLabel(f.status)})`);
  console.log(`    badge tone       ${p.tone} / "${p.label}"`);
  console.log(`    live region      "${summaryAnnouncement(flows.filter((x) => x.id.startsWith(`${dpId}__`)), flows.filter((x) => x.id.startsWith(`${dpId}__`)))}"`);
  console.log(`    aria edge phrase "${freshnessPhrase(f, NOW)}"`);
  console.log(`    explainer        "${textOf(freshnessLine(f, RING as never))}"`);
  console.log(`    drawer line      "${row ? textOf(row) : "(none)"}"`);
  console.log(`    ambient motion   ${hasAmbientSheen(f) ? "alive (the lane carries data)" : "inert (the stillness is the statement)"}`);
}

console.log("\n=== the two states, driven through the real map screen ===");
print("NEW   destination added minutes ago to a downpipe that has run 5 times", newD2, "new");
print("DARK  destination that has held no copy across those same 5 backups", darkD2, "dark");

// ---- the assertions, consumer by consumer ------------------------------------------------------------------
console.log("\n-- 1. the map LANE (screens/map/data.ts -> destinationLaneStatus) --");
ok("THE CRY-WOLF: the just-added destination does NOT paint the escalate lane", newD2.status !== "no-copy");
ok("the just-added destination reads 'partial' (catching up), which is the correct advice for it", newD2.status === "partial");
ok("the destination dark across 5 successful backups DOES paint 'no-copy'", darkD2.status === "no-copy");
ok("THE TWO STATES DO NOT PAINT THE SAME LANE (the whole fix)", newD2.status !== darkD2.status);
ok("the healthy destination on the same downpipe is untouched", newD1.status === "healthy");

console.log("\n-- 2. the panel RANK (screens/map/panels.ts STATUS_ORDER) --");
ok("the dark lane ranks WORSE than partial (a copy that is behind is being made; this one is not)",
  STATUS_ORDER.indexOf(darkD2.status) < STATUS_ORDER.indexOf("partial"));
ok("THE REGRESSION: the just-added destination no longer ranks second-worst in the fleet",
  STATUS_ORDER.indexOf(newD2.status) > STATUS_ORDER.indexOf("no-copy"));
ok("the just-added destination ranks BETTER than stale, as a healthy configuration must",
  STATUS_ORDER.indexOf(newD2.status) > STATUS_ORDER.indexOf("stale"));

console.log("\n-- 3. the panel TONE + LABEL (statusPresent / statusFilterLabel) --");
ok("the dark lane is badged 'No copy'", statusPresent(darkD2.status).label === "No copy");
ok("the just-added lane is badged 'Partial', never 'No copy'", statusPresent(newD2.status).label === "Partial");
ok("neither is red: the run succeeded and the data IS safe on the destination that reported",
  statusPresent(darkD2.status).tone === "warn" && statusPresent(newD2.status).tone === "warn");

console.log("\n-- 4. the panel EXPLAINER (freshnessLine) --");
const newText = textOf(freshnessLine(newD2, RING as never));
const darkText = textOf(freshnessLine(darkD2, RING as never));
ok("the dark lane tells the operator no copy is being made here", darkText.includes("no copy is being made here"));
ok("the dark lane tells the operator waiting will not fix it", darkText.includes("Waiting will not fix it"));
ok("THE REGRESSION: the just-added lane is NOT told 'no copy is being made here'", !newText.includes("no copy is being made"));
ok("the just-added lane is told redundancy is reduced while it catches up", newText.includes("not up to date"));

console.log("\n-- 5. the LIVE REGION (screens/map/render.ts summaryAnnouncement) --");
const spoken = summaryAnnouncement(flows, flows);
ok("the screen reader hears exactly ONE lane with no copy across the whole fleet", spoken.includes("1 with no copy"));
ok("THE REGRESSION: it does not hear two (the just-added destination is not spoken as a fault)", !spoken.includes("2 with no copy"));
console.log(`    spoken: "${spoken}"`);

console.log("\n-- 6. the SVG aria SUMMARY (components/topology-encoding.ts tally) --");
const counts = tally(flows);
ok("exactly one no-copy lane is tallied for the aria-label", counts.noCopy === 1);
ok("the just-added lane is tallied as partial, not as no-copy and not as unknown", counts.partial === 1 && counts.unknown === 0);
ok("the aria edge phrase for the dark lane names the absent copy", freshnessPhrase(darkD2, NOW).startsWith("no copy on this destination"));
ok("the aria edge phrase for the just-added lane says partial, never 'fresh' and never 'no copy'",
  freshnessPhrase(newD2, NOW).startsWith("partial,"));

console.log("\n-- 7. the EDGE MOTION (components/topology-model.ts hasAmbientSheen) --");
ok("the dark lane is INERT: nothing has ever flowed down it, so animating it would claim a liveness it never had",
  !hasAmbientSheen(darkD2));
ok("THE REGRESSION: the just-added lane is ALIVE, as any enabled partial lane is", hasAmbientSheen(newD2));

console.log("\n-- 8. the DRAWER LINE (screens/map/drawer.ts copiesRow) --");
const darkRow = copiesRow(DATA, darkD2.id);
const newRow = copiesRow(DATA, newD2.id);
ok("the dark downpipe's drawer says 1 of 2 copies, 1 never reported", textOf(darkRow as never) === "Copies1 of 2 copies - 1 never reported");
ok("THE REGRESSION: the just-added downpipe's drawer says catching up, NOT 'never reported'",
  textOf(newRow as never) === "Copies1 of 2 copies - catching up");
ok("THE DRAWER AND THE MAP AGREE: no lane says 'catching up' over a drawer that says 'never reported'",
  (newD2.status === "no-copy") === textOf(newRow as never).includes("never reported")
  && (darkD2.status === "no-copy") === textOf(darkRow as never).includes("never reported"));

console.log("\n-- the bar is the SAME one the pack and the bot use --");
ok("ONE successful backup since it joined is not yet a fault", edgeAt(4).status === "partial");
ok("TWO is: the silence has now outlasted backups that did complete", edgeAt(3).status === "no-copy");

// A FAILED heartbeat read collapses the replication map to {}, so a destination that holds EVERY run is as
// row-less as one that holds nothing. The anchor must not convert that silence into proof, or one transient DO
// blip paints "no copy" over the whole fleet, including the destinations that are working. The engine keeps
// `readable` as a separate flag for exactly this, and the bot gates on heartbeatsUnreadable.
console.log("\n-- a read that FAULTED proves nothing --");
{
  const unreadable: MapData = {
    ...DATA,
    downpipes: { ok: true, value: [mapEngineDownpipeState(wire("dark", 5, 0))] },
    history: { ok: true, value: { dark: RING } },
    replication: { ok: false, error: "read failed" },
  };
  const flows = mapDownpipesToFlows(unreadable, NOW);
  const d1 = flows.find((f) => f.id === "dark__d1") as FlowRecord; // holds every run
  const d2 = flows.find((f) => f.id === "dark__d2") as FlowRecord; // genuinely dark
  ok("the destination that HOLDS EVERY RUN is not called 'no copy' because the read faulted", d1.status !== "no-copy");
  ok("and neither is the dark one: with no read, absence is not evidence", d2.status !== "no-copy");
  ok("nothing in the fleet claims 'no copy' off a failed read", flows.every((f) => f.status !== "no-copy"));
}
function edgeAt(anchor: number): FlowRecord {
  const one = mapEngineDownpipeState(wire("t", 5, anchor));
  const d: MapData = { ...DATA, downpipes: { ok: true, value: [one] }, history: { ok: true, value: { t: RING } }, replication: { ok: true, value: { t: { d1: { holdsRunId: "r5", holdsIndex: 5, lastOk: true, lastAttemptAt: NOW } } } } };
  return mapDownpipesToFlows(d, NOW).find((f) => f.id === "t__d2") as FlowRecord;
}

if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nMAP REPLICATION-ANCHOR VECTORS PASS");
