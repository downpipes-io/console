// An ABANDONED run must not read as a success anywhere on the Runs screen.
//
// WHAT THE ENGINE CALLS IT, checked at source rather than inferred. The persisted union is
// `"in-flight" | "ok" | "failed" | "abandoned"` (engine src/sched/types.ts RunHistoryEntry) and the admin
// history route returns the rows verbatim. "abandoned" has exactly ONE writer in the whole engine: the
// lease reclaim in src/sched/scheduler-do-scheduling.ts, where the next trigger finds an in-flight row
// whose 30-minute lease has expired and stamps `error = "abandoned (run lease expired)"`. The /complete
// wire type is `"ok" | "failed"`, so a seal driver cannot report one. It means the engine never received a
// verdict, which is not the same fact as a failure the engine diagnosed, and the engine keeps them apart
// on purpose while collapsing them to failure at every consumer that counts health (metrics, the strike
// counter, OTLP and the staleness classifier).
//
// WHAT THE CONSOLE DID WITH IT. The status pill was correct, warn "abandoned", and nothing else was. The
// Runs screen's status vocabulary was a hand-written three-member list beside a type alias that derived
// correctly from the wire, so an abandoned run had no facet, was hidden whenever any status facet was
// active, was dropped from ?status=abandoned, sorted worst-first into the same bucket as ok, showed none of
// its recorded reason, and was counted by neither the ok, failed nor in-flight figure. The Failed tile
// therefore read a green 0 "none" on an estate whose runs were all being reclaimed by the lease.
//
// The fix names it rather than reclassifying it: counted with failures where the question is "does anything
// need attention", named apart everywhere the operator is told what happened.
//
import { readFileSync } from "node:fs";
import { installDomShim, textOf, qsa, flushAsync } from "./dom-shim.ts";
installDomShim();

import { STATUS_FACETS, isUnsuccessful, type FleetRun } from "../src/screens/runs/types.ts";
import { buildSummary } from "../src/screens/runs/summary.ts";
import { buildTable } from "../src/screens/runs/table.ts";
import { runStatusTone } from "../src/components/status.ts";

let failures = 0;
function ok(what: string, cond: boolean): void {
  console.log(cond ? `  ok   ${what}` : `  FAIL ${what}`);
  if (!cond) failures++;
}

const NOW = Date.now();
const HOUR = 3_600_000;
function run(over: Partial<FleetRun>): FleetRun {
  return {
    runId: over.runId ?? "r0",
    index: over.index ?? 0,
    startedAt: over.startedAt ?? new Date(NOW - HOUR).toISOString(),
    status: over.status ?? "ok",
    downpipeId: over.downpipeId ?? "dp",
    ...over,
  };
}
// The engine's own string, minted at the lease reclaim and nowhere else.
const LEASE = "abandoned (run lease expired)";

console.log("-- the vocabulary the screen shares actually contains it --");
{
  const ids = STATUS_FACETS.map((f) => f.id);
  ok("abandoned is a status facet, so it can be filtered for", ids.includes("abandoned"));
  ok("and it carries the warn tone, which is neither ok nor a diagnosed failure", STATUS_FACETS.find((f) => f.id === "abandoned")?.tone === "warn");
  ok("the pill itself already read abandoned, and still does", runStatusTone("abandoned").label === "abandoned");
  ok("it is never green", runStatusTone("abandoned").tone !== "ok");
  ok("isUnsuccessful holds for abandoned", isUnsuccessful("abandoned"));
  ok("and for failed", isUnsuccessful("failed"));
  ok("NEGATIVE CONTROL: not for ok", !isUnsuccessful("ok"));
  ok("NEGATIVE CONTROL: not for in-flight, which is activity rather than an outcome", !isUnsuccessful("in-flight"));
}

console.log("\n-- the summary band no longer reads as all clear --");
{
  // The case that made this a defect rather than a rough edge: nothing FAILED, and three runs were lost.
  const band = textOf(buildSummary([
    run({ index: 3, status: "abandoned", error: LEASE, downpipeName: "Nightly KV" }),
    run({ index: 2, status: "abandoned", error: LEASE }),
    run({ index: 1, status: "abandoned", error: LEASE }),
    run({ index: 0, status: "ok" }),
  ]) as never);
  ok("the attention tile counts them", /Failed or abandoned/.test(band) && /\b3\b/.test(band));
  ok("it says something needs attention", /needs attention/.test(band));
  ok("it does NOT read none", !/\bnone\b/.test(band));
  ok("the tile is named for what it counts rather than calling them failures", !/^Failed$/m.test(band));
  ok("and it names the newest of them, so the operator has somewhere to start", /Nightly KV/.test(band));
  ok("with the abandoned count called out, because the remedy differs from a failure", /3 abandoned/.test(band));

  // NEGATIVE CONTROL: a clean estate still reads clean. A tile that can no longer say "none" would be the
  // same defect pointed the other way.
  const clean = textOf(buildSummary([run({ index: 1, status: "ok" }), run({ index: 0, status: "ok" })]) as never);
  ok("NEGATIVE CONTROL: an estate with nothing wrong still reads none", /none/.test(clean));
  ok("NEGATIVE CONTROL: and does not claim anything needs attention", !/needs attention/.test(clean));

  // NEGATIVE CONTROL: a real failure is still a real failure, and still names itself.
  const failedBand = textOf(buildSummary([run({ index: 0, status: "failed", error: "source read refused", downpipeName: "Uploads" })]) as never);
  ok("NEGATIVE CONTROL: a failed run still counts and still names its downpipe", /Uploads/.test(failedBand) && /needs attention/.test(failedBand));
  // The tile LABEL names both members, so the assertion is on the COUNT rather than on the word.
  ok("NEGATIVE CONTROL: and no abandoned count is invented for it", !/\d+ abandoned/.test(failedBand));
}

console.log("\n-- the table can find one, sort to it, and say what happened --");
{
  const handle = buildTable([
    run({ index: 2, status: "ok" }),
    run({ index: 1, status: "abandoned", error: LEASE, runId: "r-abandoned" }),
    run({ index: 0, status: "failed", error: "source read refused" }),
  ], new URLSearchParams());
  const root = handle.el as unknown;
  const tableText = textOf(root as never);

  ok("the abandoned facet is offered on the screen", qsa(root as never, "button").some((b: unknown) => textOf(b as never).trim() === "abandoned"));
  ok("the row shows the engine's recorded reason instead of an unexplained pill", tableText.includes(LEASE));
  // NEGATIVE CONTROL: the failed row's reason is untouched by the widening.
  ok("NEGATIVE CONTROL: a failed row still shows its own reason", tableText.includes("source read refused"));

  // The ?status= guard used to reject the value outright, so a link naming abandoned runs silently showed
  // everything. Driving the real builder with the real query is the only way to prove the guard changed.
  const deep = buildTable([
    run({ index: 1, status: "abandoned", error: LEASE, runId: "r-abandoned" }),
    run({ index: 0, status: "ok", runId: "r-fine" }),
  ], new URLSearchParams("status=abandoned"));
  const deepText = textOf(deep.el as never);
  ok("?status=abandoned selects the abandoned run", deepText.includes("r-abandoned"));
  ok("and filters the successful one out, so the link is not silently ignored", !deepText.includes("r-fine"));

  // And the tile's own deep link, which now names both members of the set it counted.
  const both = buildTable([
    run({ index: 2, status: "abandoned", error: LEASE, runId: "r-abandoned" }),
    run({ index: 1, status: "failed", error: "e", runId: "r-failed" }),
    run({ index: 0, status: "ok", runId: "r-fine" }),
  ], new URLSearchParams("status=failed,abandoned"));
  const bothText = textOf(both.el as never);
  ok("the tile's deep link shows both kinds", bothText.includes("r-abandoned") && bothText.includes("r-failed"));
  ok("and only those", !bothText.includes("r-fine"));
}

console.log("\n-- and the drawer gives the run a verdict of its own --");
{
  const { openRunDetail } = await import("../src/screens/runs/detail.ts");
  const { installNav } = await import("../src/lib/nav.ts");
  installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

  openRunDetail({} as never, run({ status: "abandoned", error: LEASE, downpipeId: "dp-nightly", downpipeName: "Nightly KV" }));
  await flushAsync();
  const drawer = textOf(document.body as never);
  ok("the drawer states the run was abandoned", /This run was abandoned/.test(drawer));
  ok("it says the engine never received a result, which is the actual fact", /never received a result/.test(drawer));
  ok("it says nothing was sealed, so nobody treats it as a recovery point", /not a recovery point/i.test(drawer));
  ok("it does not call it a diagnosed failure", !/This run failed/.test(drawer));
  ok("and the throughput section says why there are no figures rather than drawing dashes", /never received a result for this run/.test(drawer));
}

// ---------------------------------------------------------------------------------------------
// THE FOUR SITES OFF THE RUNS SCREEN. Everything above this line drives screens/runs/, which was
// the scope of the original fix, and all of it was already green. It was green while four OTHER
// surfaces still sent an abandoned run down an `else` arm, because each had hand-written its own
// ok / failed / else ladder instead of calling runStatusTone. Three were wrong only in the hue;
// the map drawer was wrong in the VISIBLE TEXT, printing "in-flight" for a run the engine had
// already reclaimed. A customer met these before they ever reached the Runs screen.
//
// Driven on the real exported builders, never on a copy of their logic.
console.log("\n-- an abandoned run off the Runs screen --");
{
  const { recentRunsList } = await import("../src/screens/map/panels.ts");
  const { runStrip } = await import("../src/screens/sources-downpipes/detail-cells.ts");
  const { runTimeline } = await import("../src/screens/overview/fleet-section.ts");

  const entry = { index: 7, status: "abandoned" as const, startedAt: NOW - 3_600_000, error: LEASE };
  const okEntry = { index: 8, status: "ok" as const, startedAt: NOW - 1_800_000 };

  // 1. The map flow drawer. The visible-text defect.
  const mapList = recentRunsList([entry] as never);
  const mapText = textOf(mapList as never);
  ok("map drawer calls an abandoned run abandoned", /abandoned/.test(mapText));
  ok("map drawer does NOT call it in-flight", !/in-flight/.test(mapText));
  ok("map drawer shows the engine's reason, which it used to withhold", mapText.includes(LEASE));

  // 2. The downpipe drawer run strip. Hue-only defect, so the read is on the class.
  const strip = runStrip([entry] as never, "dp-nightly");
  const stripCells = qsa(strip as never, ".run-cell");
  const stripCls = String((stripCells[0] as { className?: string }).className ?? "");
  ok("downpipe strip tones abandoned as warn", /run-cell--warn/.test(stripCls));
  ok("downpipe strip does not tone it as in-flight info", !/run-cell--info|run-cell--inflight/.test(stripCls));

  // 3. The Overview fleet timeline: both the label and the cell.
  const timeline = runTimeline([entry] as never);
  const tlLabel = String((timeline as { getAttribute: (a: string) => string | null }).getAttribute("aria-label") ?? "");
  ok("Overview strip's aria-label says abandoned", /abandoned/.test(tlLabel));
  ok("Overview strip's aria-label does not say in-flight", !/in-flight/.test(tlLabel));
  const tlCells = qsa(timeline as never, ".run-cell");
  const tlCls = String((tlCells[0] as { className?: string }).className ?? "");
  ok("Overview strip tones abandoned as warn", /run-cell--warn/.test(tlCls));
  ok("Overview strip does not give it the in-flight treatment", !/run-cell--inflight/.test(tlCls));

  // ANTI-VACUITY. If these reads simply cannot see a status, every assertion above is free. Drive the
  // same builders with an OK run and require the opposite answer.
  const okMapText = textOf(recentRunsList([okEntry] as never) as never);
  ok("anti-vacuity: the same map read reports ok for an ok run", /ok/.test(okMapText) && !/abandoned/.test(okMapText));
  const okCls = String((qsa(runStrip([okEntry] as never, "dp") as never, ".run-cell")[0] as { className?: string }).className ?? "");
  ok("anti-vacuity: the same class read reports ok for an ok run", /run-cell--ok/.test(okCls) && !/run-cell--warn/.test(okCls));
}

// The Runs screen's own live region. It sat a hundred lines from the summary tile that already said
// "Failed or abandoned" and counted only `status === "failed"`, so an all-abandoned refresh announced
// "no failures" to the one user who could not see the tile.
console.log("\n-- the refresh announcement counts what the tile counts --");
{
  const runs = [
    run({ status: "abandoned", error: LEASE }),
    run({ status: "abandoned", error: LEASE }),
    run({ status: "ok" }),
  ];
  const unsuccessful = runs.filter((r) => isUnsuccessful(r.status)).length;
  ok("isUnsuccessful counts both abandoned runs", unsuccessful === 2);
  ok("anti-vacuity: it does not also count the ok run", unsuccessful !== runs.length);
  const src = readFileSync(new URL("../src/screens/runs/view.ts", import.meta.url), "utf8");
  ok("the announcement no longer filters on the failed literal", !/filter\(\(r\) => r\.status === "failed"\)/.test(src));
  ok("it counts the unsuccessful set instead", /filter\(\(r\) => isUnsuccessful\(r\.status\)\)/.test(src));
  // Scoped to the announced STRING, not to the file: the prose above the fix quotes the old wording to
  // record what the defect was, and a bare file-wide grep would read that comment as the defect itself.
  ok("the calm announcement no longer claims 'no failures' over abandoned runs", !/total, no failures\./.test(src));
  ok("it names the same set the summary tile names", /none failed or abandoned\./.test(src));
}

console.log("");
if (failures > 0) process.exitCode = 1;
if (failures > 0) {
  console.error(`validate-run-abandoned-visible: ${failures} FAILED`);
  process.exit(1);
}
console.log("ABANDONED RUNS ARE VISIBLE");
