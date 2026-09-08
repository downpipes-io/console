// Validate the run-level SHORT-OF-SOURCE indicator. The engine reports three
// run-level "short of the live source" counts -- recordsIncomplete (a sentinel marker sealed in place of the
// real bytes), recordsSkipped (a record the seal could not capture at all) and recordsVanished (an object
// deleted mid-crawl before it could be read) -- and a suspect verify-at-seal verdict. A run short by ANY of
// the three counts, or with a suspect verify, must NOT read as a clean complete verified success. This suite
// drives the REAL console helpers and the REAL Runs summary band and asserts:
//
//   - incompleteCount reads recordsIncomplete honestly: a positive finite count is surfaced, an absent /
//     zero / non-finite / negative value reads 0 (a fully captured run, never a fabricated reading), and it
//     is DISTINCT from recordsSkipped (the etag-mid-crawl skips).
//   - shortfallCount / shortfallLabel / shortfallReason fold ALL THREE counts: a run short only by
//     skipped or vanished records reads not-fully-captured, with an honest total and a per-kind reason,
//     never a clean complete ok. A corrupt or negative count never fabricates a shortfall.
//   - the Runs summary band's "Latest run" tile reads "ok, incomplete" (not a plain ok) and names how many
//     runs are not fully captured when the newest good run is short of the source by any of the three counts,
//     and reads a plain "ok" with no such line for a clean fully captured run.
//   - the Latest run tile reads danger "ok, seal suspect" (not a plain green ok) when the latest run's
//     verify-at-seal read-back was SUSPECT, matching the list row + drawer.
//
// Run with: node test/validate-run-incomplete.ts.
//
// The summary band creates DOM, so the DOM shim is installed first (the same pattern the map-panels /
// data-table validators use); the helpers are pure and need no DOM. None of the imported modules
// execute DOM at import time.

import { installDomShim } from "./dom-shim.ts";
installDomShim();

import { incompleteCount, shortfallCount, shortfallLabel, shortfallReason, sealVerifyShort, sealVerifyDetail, humanDuration } from "../src/screens/runs/helpers.ts";
import { buildSummary } from "../src/screens/runs/summary.ts";
import type { FleetRun } from "../src/screens/runs/types.ts";

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

function text(el: unknown): string {
  return (el as unknown as { textContent: string }).textContent;
}

// ===========================================================================
// incompleteCount / incompleteLabel: honest reading of recordsIncomplete.
// ===========================================================================
console.log("\n-- incompleteCount / incompleteLabel honesty --");

eq("incompleteCount reads a positive count", incompleteCount(run({ recordsIncomplete: 3 })), 3);
eq("incompleteCount of an absent field reads 0 (fully captured)", incompleteCount(run({})), 0);
eq("incompleteCount of 0 reads 0", incompleteCount(run({ recordsIncomplete: 0 })), 0);
eq("incompleteCount of a negative value reads 0 (never a fabricated reading)", incompleteCount(run({ recordsIncomplete: -2 })), 0);
eq("incompleteCount of a non-finite value reads 0", incompleteCount(run({ recordsIncomplete: Number.NaN })), 0);
// DISTINCT from recordsSkipped: a run that ONLY skipped (etag mid-crawl) is fully captured for the rest.
eq("incompleteCount ignores recordsSkipped (distinct fields)", incompleteCount(run({ recordsSkipped: 5 })), 0);

eq("shortfallLabel of a partial (incomplete) run names the count", shortfallLabel(run({ recordsIncomplete: 2 })), "2 not fully captured");
eq("shortfallLabel of a fully captured run is null", shortfallLabel(run({})), null);
eq("shortfallLabel of 0 is null", shortfallLabel(run({ recordsIncomplete: 0 })), null);

// ===========================================================================
// shortfallCount / shortfallLabel / shortfallReason fold ALL THREE engine counts, so a run short only
// by SKIPPED or VANISHED records (recordsIncomplete = 0) is still shown as short of a full copy, never a
// clean complete ok. recordsSkipped = an in-scope record the seal could not capture (etag mid-crawl);
// recordsVanished = an object the list returned that was gone at value-read time (deleted mid-crawl).
// ===========================================================================
console.log("\n-- short-of-source folds incomplete + skipped + vanished --");

eq("shortfallCount sums incomplete + skipped + vanished", shortfallCount(run({ recordsIncomplete: 1, recordsSkipped: 2, recordsVanished: 3 })), 6);
eq("shortfallCount of a skipped-only run is non-zero (was shown as clean before)", shortfallCount(run({ recordsSkipped: 3 })), 3);
eq("shortfallCount of a vanished-only run is non-zero", shortfallCount(run({ recordsVanished: 1 })), 1);
eq("shortfallCount of a fully captured run is 0", shortfallCount(run({})), 0);
eq("shortfallCount coerces a non-finite skipped to 0 (never a fabricated shortfall)", shortfallCount(run({ recordsSkipped: Number.NaN })), 0);
eq("shortfallCount coerces a negative vanished to 0", shortfallCount(run({ recordsVanished: -4 })), 0);

eq("shortfallLabel of a skipped-only run names the count", shortfallLabel(run({ recordsSkipped: 3 })), "3 not fully captured");
eq("shortfallLabel of a vanished-only run names the count", shortfallLabel(run({ recordsVanished: 1 })), "1 not fully captured");

// shortfallReason names WHICH kinds were short, so the drawer states an honest reason not just a total.
ok("shortfallReason of an incomplete run names the partial-seal kind", shortfallReason(run({ recordsIncomplete: 2 })).includes("sealed only partially"));
ok("shortfallReason of a skipped-only run names the could-not-capture kind", shortfallReason(run({ recordsSkipped: 3 })).includes("could not be captured"));
ok("shortfallReason of a vanished-only run names the vanished-mid-crawl kind", shortfallReason(run({ recordsVanished: 2 })).includes("vanished mid-crawl"));
eq("shortfallReason of a fully captured run is empty", shortfallReason(run({})), "");

// ===========================================================================
// Summary band "Latest run" tile: a partial newest-good run reads incomplete, a
// fully captured one reads a plain ok with no incomplete line.
// ===========================================================================
console.log("\n-- Runs summary band partial-capture signal --");

// A newest run that completed OK but sealed 2 records only partially: the tile must NOT read a plain ok.
{
  const incompleteSummary = text(buildSummary([run({ runId: "a", index: 1, status: "ok", recordsIncomplete: 2, startedAt: new Date(NOW - HOUR).toISOString() })]));
  ok("partial run: Latest run tile reads 'ok, incomplete' (not a plain clean success)", incompleteSummary.includes("ok, incomplete"));
  ok("partial run: summary names the not-fully-captured run count", incompleteSummary.includes("not fully captured"));
}

// A clean, fully captured run (no recordsIncomplete): the tile reads a plain ok with NO incomplete line.
{
  const cleanSummary = text(buildSummary([run({ runId: "b", index: 1, status: "ok", startedAt: new Date(NOW - HOUR).toISOString() })]));
  ok("clean run: summary does NOT show the not-fully-captured indicator", !cleanSummary.includes("not fully captured"));
  ok("clean run: summary does NOT read 'ok, incomplete'", !cleanSummary.includes("ok, incomplete"));
}

// A newest run that only SKIPPED records (etag mid-crawl) is STILL short of a full copy, so the tile
// must NOT read a plain clean ok -- it downgrades and the summary names the not-fully-captured run count.
{
  const skippedOnly = text(buildSummary([run({ runId: "c", index: 1, status: "ok", recordsSkipped: 4, startedAt: new Date(NOW - HOUR).toISOString() })]));
  ok("skipped-only run: Latest run tile downgrades from a plain clean ok", skippedOnly.includes("ok, incomplete"));
  ok("skipped-only run: summary names the not-fully-captured run count", skippedOnly.includes("not fully captured"));
}

// Same for a run that only VANISHED records (an object deleted mid-crawl before it could be read).
{
  const vanishedOnly = text(buildSummary([run({ runId: "d", index: 1, status: "ok", recordsVanished: 2, startedAt: new Date(NOW - HOUR).toISOString() })]));
  ok("vanished-only run: Latest run tile downgrades from a plain clean ok", vanishedOnly.includes("ok, incomplete"));
  ok("vanished-only run: summary names the not-fully-captured run count", vanishedOnly.includes("not fully captured"));
}

// ===========================================================================
// The Latest run tile downgrades for a verify-at-seal SUSPECT latest, matching the list row + drawer,
// so the most-read tile does not read a plain green ok on a backup whose integrity re-read did not pass.
// ===========================================================================
console.log("\n-- Latest run tile downgrades for a suspect verify-at-seal latest --");

// A suspect latest (the engine read the archive back and the re-read did not pass): the tile reads danger
// "ok, seal suspect", NOT a plain green ok, mirroring the row's danger "seal suspect" badge.
{
  const suspectLatest = text(buildSummary([run({ runId: "s", index: 1, status: "ok", startedAt: new Date(NOW - HOUR).toISOString(), sealVerification: { status: "suspect", tier: "tier-0", sampled: 0, at: NOW, reason: "read-back mismatch" } })]));
  ok("suspect latest: Latest run tile reads 'ok, seal suspect' (not a plain clean ok)", suspectLatest.includes("ok, seal suspect"));
}

// Non-vacuity contrast: a clean, VERIFIED latest is not downgraded at all (no suspect, no incomplete), so the
// downgrade above is a real discrimination, not an always-fire.
{
  const verifiedLatest = text(buildSummary([run({ runId: "v", index: 1, status: "ok", startedAt: new Date(NOW - HOUR).toISOString(), sealVerification: { status: "verified", tier: "full", sampled: 10, at: NOW } })]));
  ok("verified latest: Latest run tile does NOT read 'seal suspect'", !verifiedLatest.includes("seal suspect"));
  ok("verified latest: a clean verified latest is not downgraded to incomplete", !verifiedLatest.includes("ok, incomplete"));
}

// verify-at-seal tier labels: the "full" tier (every record decrypt-checked) must read distinctly from
// tier-0 (keyless chain attestation) and from a sample, so an operator can see full-record coverage.
{
  const full = { status: "verified" as const, tier: "full" as const, sampled: 1200, at: NOW };
  const sampled = { status: "verified" as const, tier: "sampled-decrypt" as const, sampled: 50, at: NOW };
  const tier0 = { status: "verified" as const, tier: "tier-0" as const, sampled: 0, at: NOW };
  const suspect = { status: "suspect" as const, tier: "tier-0" as const, sampled: 0, at: NOW, reason: "read-back mismatch" };
  // Short badge: full says "all N", distinct from the sample and from bare tier-0.
  ok("full-tier short badge reads 'verified, all N'", sealVerifyShort(full) === "verified, all 1,200");
  ok("full-tier short badge is DISTINCT from sampled + tier-0", sealVerifyShort(full) !== sealVerifyShort(sampled) && sealVerifyShort(full) !== sealVerifyShort(tier0));
  eq("sampled short badge unchanged", sealVerifyShort(sampled), "verified, sampled 50");
  eq("tier-0 short badge unchanged", sealVerifyShort(tier0), "verified at seal");
  // Long detail: full states full byte coverage over all records.
  ok("full-tier detail states full byte coverage over all records", sealVerifyDetail(full).includes("all 1,200 records") && sealVerifyDetail(full).includes("full byte coverage"));
  ok("full-tier detail is DISTINCT from the sampled detail", sealVerifyDetail(full) !== sealVerifyDetail(sampled));
  ok("a suspect verdict still reads suspect regardless of tier", sealVerifyDetail(suspect).startsWith("Suspect:"));

  // tier0Cause: a bare tier-0 reading cannot tell an intentional configuration from a misconfigured one,
  // and the engine has recorded WHY since the support pack needed it. After the seal path gained the run's
  // own per-run key, every remaining cause is a setting or a size the operator can act on, so it belongs in
  // front of them rather than only in a pack support has to be asked for.
  const t0 = (cause?: "break-glass" | "sample-off" | "too-large" | "too-many-shards") =>
    sealVerifyDetail({ status: "verified", tier: "tier-0", sampled: 0, at: 1, ...(cause ? { tier0Cause: cause } : {}) });
  ok("tier-0 with no recorded cause reads exactly as before (legacy rows are unchanged)", t0() === "Verified at seal (signature, completeness and freshness).");
  ok("tier-0 still states what WAS checked before saying what was not", t0("sample-off").startsWith("Verified at seal (signature, completeness and freshness)."));
  ok("sample-off names the switch, not a fault", t0("sample-off").includes("switched off"));
  ok("too-large names the size ceiling", t0("too-large").includes("size ceiling"));
  ok("too-many-shards names the shard budget", t0("too-many-shards").includes("budget"));
  // break-glass can only reach a run sealed before the keyed tier worked without a key, so it must read as
  // history. Wording it as a current posture would tell a break-glass-only operator their runs are not
  // decrypt-checked, which is the claim this whole workstream exists to retire.
  ok("break-glass reads as history, and says current runs do reach the keyed check", t0("break-glass").includes("sealed before") && t0("break-glass").includes("do reach it"));
  ok("each cause reads differently (the phrase is not a constant)", new Set([t0("sample-off"), t0("too-large"), t0("too-many-shards"), t0("break-glass")]).size === 4);
  // A cause never rides a verdict that DID decrypt, so the sampled/full details must be untouched by it.
  ok("a sampled verdict ignores a stray cause", !sealVerifyDetail({ ...sampled, tier0Cause: "sample-off" }).includes("switched off"));

  // Edge: a 0-record run (a first backup of an empty source) is legitimately tier "full" with sampled 0. It
  // must not read as the odd "verified, all 0"; it falls through to the plain attestation label.
  const emptyFull = { status: "verified" as const, tier: "full" as const, sampled: 0, at: NOW };
  eq("full tier with 0 records reads the plain attestation, not 'all 0'", sealVerifyShort(emptyFull), "verified at seal");
  ok("full tier with 0 records detail does not claim 'all 0 records'", !sealVerifyDetail(emptyFull).includes("all 0"));
}

// ---------------------------------------------------------------------------
// humanDuration: a remainder in [59.5, 60)s must carry to the next minute ("2m 00s"), never render "1m 60s"
// (the non-normalised Math.round carry produces this rounding error).
eq("humanDuration carries a rounded-up second (119500ms -> 2m 00s, never 1m 60s)", humanDuration(119500), "2m 00s");
eq("humanDuration 59m 59.5s carries into the hour (3599500ms -> 1h 00m)", humanDuration(3599500), "1h 00m");
eq("humanDuration a normal minute and seconds (125000ms -> 2m 05s)", humanDuration(125000), "2m 05s");
eq("humanDuration sub-minute keeps one decimal (3400ms -> 3.4s)", humanDuration(3400), "3.4s");
eq("humanDuration hours and minutes (4320000ms -> 1h 12m)", humanDuration(4320000), "1h 12m");
eq("humanDuration negative reads '-'", humanDuration(-5), "-");

// ---------------------------------------------------------------------------
// A FAILED RUN MUST OFFER A WAY OUT OF ITSELF.
//
// The drawer's verbs were Drill this run and Build a restore plan, both of them things to do with an
// archive that exists. The commonest day-two action on a run that FAILED is to fix the cause and run it
// again, and Run now lives on the downpipe, not here. Nothing in this drawer led there: the downpipe's
// name sat in the title as inert text and the only navigations in the file were /runs and /restore. The
// customer had to already know where to go, which is the assumption that makes a screen a dead end.
console.log("\n-- a failed run offers a route to the downpipe that can re-run it --");
{
  const { openRunDetail } = await import("../src/screens/runs/detail.ts");
  const { qsa, textOf, flushAsync } = await import("./dom-shim.ts");
  const { installNav } = await import("../src/lib/nav.ts");
  const went: string[] = [];
  installNav({ navigate: (to: string) => { went.push(to); }, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

  openRunDetail({} as never, run({ status: "failed", error: "source read refused", downpipeId: "dp-nightly", downpipeName: "Nightly KV" }));
  await flushAsync();
  const labels = qsa(document.body as never, "button").map((b: unknown) => textOf(b).trim());
  ok("the drawer offers a route to the owning downpipe", labels.some((l: string) => /Open the downpipe/.test(l)));
  const openBtn = qsa(document.body as never, "button").find((b: unknown) => /Open the downpipe/.test(textOf(b)));
  (openBtn as unknown as { click: () => void } | undefined)?.click();
  if (!went.includes("/downpipes/dp-nightly")) console.log(`         navigated: ${JSON.stringify(went)}`);
  ok("and it goes to the downpipe the run belongs to, where Run now lives", went.includes("/downpipes/dp-nightly"));
}

// ---------------------------------------------------------------------------
console.log("");
if (failures > 0) process.exitCode = 1;
if (failures > 0) {
  console.log(`VALIDATE-RUN-INCOMPLETE: ${failures} FAILED`);
  process.exit(1);
}
console.log("VALIDATE-RUN-INCOMPLETE VECTORS PASS");
