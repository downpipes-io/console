// The Runs summary band (throughput / freshness / outcome at a glance): a stat-tile grid
// computed from the full run set the caller passes it (each downpipe's recent-run history
// ring, not the filtered table view), so it reads the fleet's true posture over that ring.
// Each figure is honest: an unknown count reads "-", never a stale zero, and a partial wire
// shape never sums to a false complete total.

import { h } from "../../lib/dom.ts";
import { statTile, statGrid } from "../../components/stat-tiles.ts";
import { relativeTime, absoluteTime, groupNumber, humanBytes } from "../../lib/format.ts";
import { navigate } from "../../lib/nav.ts";
import { runStatusTone, type StatusTone } from "../../components/status.ts";
import { type FleetRun, type RunStatus, isUnsuccessful } from "./types.ts";
import { countDownpipes, sumDefined, shortfallCount } from "./helpers.ts";

export function buildSummary(runs: FleetRun[]): HTMLElement {
  const total = runs.length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const abandoned = runs.filter((r) => r.status === "abandoned").length;
  // The set the tile below is really asking about. Counting only `failed` was how an estate whose runs were
  // all being reclaimed by the lease read a green "none" with the word "needs attention" nowhere on screen:
  // abandoned runs landed in `total` and in none of ok, failed or in-flight, so the band silently did not
  // add up and the one tile a customer scans for trouble was the one that hid it.
  const unsuccessful = failed + abandoned;
  const inFlight = runs.filter((r) => r.status === "in-flight").length;
  const ok = runs.filter((r) => r.status === "ok").length;

  // Freshness: the age of the newest run of any status (the activity recency), with the
  // newest OK run as the secondary (the real recovery point). Honest "-" when absent.
  const newest = runs[0]; // flatten() sorts newest-first
  const newestGood = runs.find((r) => r.status === "ok");
  const newestUnsuccessful = runs.find((r) => isUnsuccessful(r.status));
  // Runs short of the live source (any of recordsIncomplete / recordsSkipped / recordsVanished > 0): such a
  // run is NOT a clean success, so the Latest run tile reads not-fully-captured, not ok, when the newest good
  // run is one of them (a run short only by skipped or vanished records could otherwise read as a plain clean ok).
  // The count across the fleet is the secondary, so a backup short of a full copy is loud here rather than
  // hidden behind a plain ok.
  const newestGoodShortfall = newestGood ? shortfallCount(newestGood) : 0;
  const shortRuns = runs.filter((r) => shortfallCount(r) > 0).length;

  // Throughput across the visible set: total records and archive bytes written, summed
  // only over runs that reported the figure (so a partial wire shape does not read as a
  // false zero; the count of contributing runs is the secondary).
  const recTotals = sumDefined(runs, (r) => r.recordCount);
  const archiveTotals = sumDefined(runs, (r) => r.archiveBytesWritten);
  const dpCount = countDownpipes(runs);

  const attentionSec = attentionSecondary(newestUnsuccessful, abandoned, inFlight);
  const grid = statGrid(
    statTile({
      label: "Runs",
      value: groupNumber(total),
      status: { tone: "neutral", label: `${groupNumber(ok)} ok` },
      secondary: runsSecondary(dpCount, inFlight),
    }),
    statTile({
      // Named for both members of the set it counts. "Failed" over a figure that includes abandoned runs
      // would be the same over-claim in the opposite direction, and the two have different remedies.
      label: "Failed or abandoned",
      value: groupNumber(unsuccessful),
      // Amber rather than red when the count is entirely abandoned runs: nothing has been diagnosed as a
      // failure, and the engine did not report one. It is never green while the count is above zero.
      status: unsuccessful > 0 ? { tone: failed > 0 ? "danger" : "warn", label: "needs attention" } : { tone: "ok", label: "none" },
      ...(attentionSec !== null ? { secondary: attentionSec } : {}),
      // The deep link carries BOTH facets, so the tile lands on the runs it just counted rather than on a
      // filtered view that omits some of them.
      ...(unsuccessful > 0 ? { onActivate: () => navigate("/runs?status=failed,abandoned") } : {}),
    }),
    statTile({
      label: "Latest run",
      value: newest ? relativeTime(newest.startedAt) : "-",
      status: newest ? latestRunTileStatus(newest, newestGoodShortfall) : { tone: "neutral", label: "none" },
      secondary: latestRunSecondary(newestGood, shortRuns),
      ...(newest ? { title: absoluteTime(newest.startedAt) } : {}),
    }),
    statTile({
      label: "Records backed up",
      value: recTotals.count > 0 ? groupNumber(recTotals.sum) : "-",
      secondary: throughputSecondary(recTotals.count, total, archiveTotals),
    }),
  );

  // Every figure above is drawn from each downpipe's recent-run history ring, which is
  // bounded (capped at 50 runs per downpipe, the engine's RING_CAP), the same bound the restore
  // date-picker (restore-flow/date-picker.ts's buildHonestyNote) and the notifications delivery
  // history (notifications/history.ts) already disclose for the identically-shaped ring. Runs
  // never had the disclosure its two siblings settled on, so "Failed or abandoned: 0" read as
  // "nothing has ever failed" rather than "nothing failed within the last 50 runs of each
  // downpipe" -- a materially different claim for anything run more than about once a day.
  return h(
    "div",
    grid,
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-2)" },
      "These totals cover each downpipe's recent-run history, capped at 50 runs per downpipe. A frequently-run downpipe may have more history than this ring holds; an older run is still restorable by its id.",
    ),
  );
}

// runsSecondary names the breadth of activity, with the in-flight count riding along when any
// run is in progress. The count lives here, not under Failed: an in-flight run is activity, and
// under the Failed label it read as if a failure were still running.
function runsSecondary(dpCount: number, inFlight: number): string {
  const base = `${dpCount} ${dpCount === 1 ? "downpipe" : "downpipes"} with activity`;
  return inFlight > 0 ? `${base}, ${groupNumber(inFlight)} in-flight` : base;
}

// attentionSecondary names the newest run in the set the tile counts, and says how many of them were
// abandoned rather than failed, because the two need different things done about them: a failed run has a
// recorded cause to read, an abandoned one has none and means the engine lost the run's verdict.
// While a run IS in flight and nothing needs attention the tile shows no secondary at all: the Runs tile
// carries the count, and repeating the all-quiet line here would be a false claim.
function attentionSecondary(newest: FleetRun | undefined, abandoned: number, inFlight: number): string | null {
  if (newest) {
    const base = `Newest: ${newest.downpipeName ?? newest.downpipeId}, ${relativeTime(newest.startedAt)}`;
    return abandoned > 0 ? `${base}, ${groupNumber(abandoned)} abandoned` : base;
  }
  return inFlight === 0 ? "No runs currently in flight" : null;
}

// throughputSecondary states the archive bytes written (when known) and how many runs
// contributed to the totals, so a partial wire shape reads honestly rather than as a
// complete figure.
function throughputSecondary(contributing: number, total: number, archive: { sum: number; count: number }): string {
  const parts: string[] = [];
  if (archive.count > 0) parts.push(`${humanBytes(archive.sum)} archive written`);
  if (contributing > 0 && contributing < total) parts.push(`over ${groupNumber(contributing)} of ${groupNumber(total)} runs`);
  else if (contributing > 0) parts.push(`over ${groupNumber(contributing)} ${contributing === 1 ? "run" : "runs"}`);
  return parts.length ? parts.join(", ") : "No per-run totals reported yet";
}

function statusToTileStatus(status: RunStatus): { tone: StatusTone; label: string } {
  const { tone, label } = runStatusTone(status);
  return { tone, label };
}

// latestRunTileStatus reads the Latest run tile's status pill. An ok run is downgraded from a plain green ok
// when it is not a clean success, mirroring what the same screen's list row and drawer already flag:
//   - a SUSPECT verify-at-seal read-back reads danger "ok, seal suspect" (the engine read the archive back and
//     the re-read did not pass; fail-open, so the run stays status ok, but the bytes may be corrupt). This is
//     the most recovery-relevant caveat and matches the row's danger "seal suspect" badge + the drawer's
//     suspect outcome (the tile could otherwise read a plain green ok while the row and drawer flagged it).
//   - a NOT-FULLY-CAPTURED run (newestGoodShortfall > 0, i.e. the newest good run is short of the live source
//     by incomplete / skipped / vanished records) reads warn "ok, incomplete".
// Suspect outranks a shortfall. Any other status (failed / in-flight / a clean, verified, fully captured ok)
// reads as before.
function latestRunTileStatus(newest: FleetRun, newestGoodShortfall: number): { tone: StatusTone; label: string } {
  if (newest.status === "ok" && newest.sealVerification?.status === "suspect") return { tone: "danger", label: "ok, seal suspect" };
  if (newest.status === "ok" && newestGoodShortfall > 0) return { tone: "warn", label: "ok, incomplete" };
  return statusToTileStatus(newest.status);
}

// latestRunSecondary names the newest good backup's age, and, when any run is short of the live source, how
// many runs are short of a full copy (so the not-fully-captured signal is visible in the "last run ok"
// summary, not only on the row). An absent good backup reads honestly.
function latestRunSecondary(newestGood: FleetRun | undefined, shortRuns: number): string {
  const base = newestGood ? `Newest good backup ${relativeTime(newestGood.startedAt)}` : "No good backup yet";
  if (shortRuns > 0) {
    return `${base}, ${groupNumber(shortRuns)} ${shortRuns === 1 ? "run" : "runs"} not fully captured`;
  }
  return base;
}
