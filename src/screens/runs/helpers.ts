// Leaf helpers for the Runs screen: the run-history flatten, the small aggregation
// helpers, the duration formatter, the verify-at-seal readings, and the empty / loading
// states. Pure or DOM-only, with no dependency on the view or the section modules, so the
// table, the summary band, the detail drawer and the view can all import them freely.

import { h } from "../../lib/dom.ts";
import { skeletonTiles, skeletonRows, emptyState } from "../../components/feedback.ts";
import { navigate } from "../../lib/nav.ts";
import { groupNumber } from "../../lib/format.ts";
import { recordWireAnomaly } from "../../lib/client-diag/ring.ts";
import type { RunHistoryEntry } from "../../api.ts";
import type { FleetRun } from "./types.ts";

const MS_PER_SEC = 1000;
const SEC_PER_MIN = 60;

// loadingSkeleton matches the final layout's shape (a summary band over a table) so the
// first paint does not jump.
export function loadingSkeleton(): HTMLElement {
  const wrap = h("div");
  wrap.appendChild(skeletonTiles(4));
  const section = h("div", { style: "margin-top:var(--space-6)" });
  section.appendChild(h("h2", { class: "section-label", style: "margin-bottom:var(--space-3)" }, "Activity"));
  section.appendChild(skeletonRows(6));
  wrap.appendChild(section);
  return wrap;
}

export function buildEmpty(): HTMLElement {
  return emptyState({
    title: "No runs across any downpipe yet",
    body: "A run appears here the moment a downpipe seals its first backup. Trigger one from its drawer, or wait for its next scheduled run.",
    action: { label: "Go to Downpipes", onClick: () => navigate("/downpipes"), variant: "primary" },
  });
}

// sealVerifyShort is the compact badge label for the verify-at-seal verdict on a verified run: it names
// the depth that actually ran so the operator can tell a keyless chain attestation ("verified at seal")
// from a run that also decrypt-checked a sample ("verified, sampled N"). Presentation only; never fed
// back into a request. A suspect verdict uses a fixed "seal suspect" label at the call site instead.
export function sealVerifyShort(seal: NonNullable<RunHistoryEntry["sealVerification"]>): string {
  // "full" covers every record; a 0-record run (a first backup of an empty source) is legitimately full but
  // reads oddly as "all 0", so fall through to the plain attestation label where there is nothing to count.
  if (seal.tier === "full" && seal.sampled > 0) return `verified, all ${groupNumber(seal.sampled)}`;
  if (seal.tier === "sampled-decrypt") return `verified, sampled ${groupNumber(seal.sampled)}`;
  return "verified at seal";
}

// sealVerifyDetail is the longer, plain-English reading of the verdict for the run drawer's Result row.
// A verified tier-0 verdict states the keyless chain attestation; a sampled-decrypt verdict adds the
// sample count; a suspect verdict states the coarse, secret-free reason (or a generic line when absent).
export function sealVerifyDetail(seal: NonNullable<RunHistoryEntry["sealVerification"]>): string {
  if (seal.status === "suspect") {
    return seal.reason ? `Suspect: ${seal.reason}` : "Suspect: the read-back verification did not pass.";
  }
  if (seal.tier === "full" && seal.sampled > 0) {
    return `Verified at seal (decrypt-checked all ${groupNumber(seal.sampled)} ${seal.sampled === 1 ? "record" : "records"}, full byte coverage).`;
  }
  if (seal.tier === "sampled-decrypt") {
    return `Verified at seal (decrypt-checked ${groupNumber(seal.sampled)} ${seal.sampled === 1 ? "record" : "records"}).`;
  }
  // A bare tier-0 reading leaves the operator unable to tell an intentional configuration from a
  // misconfigured one, and after the seal path gained the run's own per-run key every remaining cause is a
  // setting or a size they can act on. "break-glass" can now only appear on a run sealed before that
  // change, so it is worded as history rather than as a current posture.
  if (seal.tier === "tier-0" && seal.tier0Cause !== undefined) {
    return `Verified at seal (signature, completeness and freshness). ${tier0CausePhrase(seal.tier0Cause)}`;
  }
  return "Verified at seal (signature, completeness and freshness).";
}

// tier0CausePhrase turns the engine's closed tier0Cause word into a sentence that says what to do about
// it. Exhaustive over the enum: a value this build does not know falls through to a plain statement rather
// than an empty string, so a newer engine never renders a dangling full stop.
function tier0CausePhrase(cause: NonNullable<NonNullable<RunHistoryEntry["sealVerification"]>["tier0Cause"]>): string {
  switch (cause) {
    case "sample-off":
      return "The keyed decrypt check is switched off for this engine, so no record's bytes were decrypted.";
    case "too-large":
      return "The run was over the decrypt check's size ceiling, so its bytes were not decrypted.";
    case "too-many-shards":
      return "The run had more shards than the decrypt check's budget allows, so its bytes were not decrypted.";
    case "break-glass":
      return "This run was sealed before the engine could reach the keyed check without an in-account key. Runs sealed since then do reach it.";
    default:
      return "The keyed decrypt check did not run for this run.";
  }
}

// incompleteCount reads the run's incomplete-capture count as a clean number: the engine's
// recordsIncomplete (records this run sealed as incompleteness sentinels, a partial capture). An
// absent, non-finite or non-positive value reads 0 (a fully captured run), so a partial wire shape
// or a legacy row never fabricates an incomplete reading. Presentation only.
//
// The coercion above is right, and it was also SILENT. A recordsIncomplete that arrives non-numeric or
// negative reads as "fully captured", which is the most reassuring answer this function can give, and it gives
// it precisely when the wire is wrong. The customer then sees a clean run beside a restore that comes up short.
// The row records the CLASS of the malformation and never the value. An ABSENT field is NOT recorded: a run
// sealed before this field existed legitimately carries none, and a fault on every old run would be pure noise.
export function incompleteCount(run: RunHistoryEntry): number {
  const v = run.recordsIncomplete;
  if (v === undefined || v === null) return 0; // legitimate: an older run carries no such field
  if (typeof v !== "number" || !Number.isFinite(v)) {
    recordWireAnomaly("count", "non-finite");
    return 0;
  }
  if (v < 0) {
    recordWireAnomaly("count", "negative");
    return 0;
  }
  return v > 0 ? v : 0;
}

// runBytes reads a run's ARCHIVE BYTE figure for display. It returns the number when it is a real,
// finite, non-negative size, and null when there is no honest figure to show.
//
// It exists because `typeof r.archiveBytesWritten === "number"` is a guard that a CORRUPT figure walks straight
// through: typeof NaN and typeof Infinity are both "number". A run whose byte figure arrived non-finite passed
// the guard, reached humanBytes, and rendered "-" -- the identical glyph to a run that legitimately reports no
// figure at all. Two states, one dash, and no row anywhere. The summary band was short by the same amount and
// said nothing either, because sumDefined skips a non-finite entry in silence.
//
// The `bytes` field class already existed for exactly this fault on the topology surface; it simply was never
// applied on the runs surface the gap names. The VALUE never rides: the class and the anomaly do.
//
// NOISE: an ABSENT figure records nothing. An in-flight run and a failed run legitimately carry no byte fields
// (the engine stamps them at successful completion), and a row on every one of those would be noise on the
// commonest states in the product.
export function runBytes(v: number | undefined): number | null {
  if (v === undefined || v === null) return null; // legitimate: in-flight, failed, or an older run
  if (typeof v !== "number" || !Number.isFinite(v)) {
    recordWireAnomaly("bytes", "non-finite");
    return null;
  }
  if (v < 0) {
    recordWireAnomaly("bytes", "negative");
    return null;
  }
  return v;
}

// coerceCount reads one of the engine's other two "short of the live source" counts (recordsSkipped /
// recordsVanished) as a clean number, EXACTLY as incompleteCount reads recordsIncomplete: an absent field
// is a legitimate 0 (an older run, or a run with none, carries none, and a fault on every such run would be
// noise), while a non-finite or negative value reads 0 AND records the wire-anomaly class, so a corrupt
// wire never fabricates a shortfall and never hides one behind the most reassuring answer. Only the class
// travels, never the value.
function coerceCount(v: number | undefined | null): number {
  if (v === undefined || v === null) return 0; // legitimate: an older run or a run with none carries no such field
  if (typeof v !== "number" || !Number.isFinite(v)) {
    recordWireAnomaly("count", "non-finite");
    return 0;
  }
  if (v < 0) {
    recordWireAnomaly("count", "negative");
    return 0;
  }
  return v > 0 ? v : 0;
}

// skippedCount / vanishedCount read the run's other two shortfall counts, both of which mean the archive is
// short of the live source. recordsSkipped is an in-scope record the seal could NOT capture at all (it changed
// mid-crawl behind an etag pin); recordsVanished is an object the LIST returned that was GONE at value-read
// time (deleted between the list page and the read). Guarded like incompleteCount. Presentation only.
function skippedCount(run: RunHistoryEntry): number {
  return coerceCount(run.recordsSkipped);
}
function vanishedCount(run: RunHistoryEntry): number {
  return coerceCount(run.recordsVanished);
}

// shortfallCount is how many records this run is SHORT OF THE LIVE SOURCE across all three engine counts:
// recordsIncomplete (a sentinel marker sealed in place of the real bytes), recordsSkipped (a record the seal
// could not capture at all) and recordsVanished (an object deleted mid-crawl before it could be read). A
// non-zero total means the archive is NOT a full copy, so the run must read as not-fully-captured rather than
// a clean complete ok, whichever of the three drove it (a run short only by skipped or vanished records
// could otherwise read as a clean verified backup, and on restore those records would simply be missing). Presentation only.
export function shortfallCount(run: RunHistoryEntry): number {
  return incompleteCount(run) + skippedCount(run) + vanishedCount(run);
}

// shortfallLabel is the short badge label for a run short of the live source (shortfallCount > 0). It states
// the total in the umbrella wording the console already uses for a partial capture ("2 not fully captured"),
// so a run short by skipped or vanished records reads the same honest not-a-full-copy signal as one short by
// incomplete sentinels. Returns null for a fully captured run (honest absence), so the caller renders nothing.
// Presentation only, never fed back into a request.
export function shortfallLabel(run: RunHistoryEntry): string | null {
  const n = shortfallCount(run);
  return n > 0 ? `${groupNumber(n)} not fully captured` : null;
}

// shortfallReason is the plain-English breakdown of WHY a run is short of the live source, for the drawer's
// outcome: it names each of the three kinds that contributed with its count, so the operator and the support
// pack can tell a partial seal from a record that could not be captured from an object that vanished mid-crawl,
// rather than reading only a bare total. Empty string for a fully captured run. Presentation only.
export function shortfallReason(run: RunHistoryEntry): string {
  const parts: string[] = [];
  const inc = incompleteCount(run);
  const skip = skippedCount(run);
  const van = vanishedCount(run);
  if (inc > 0) parts.push(`${groupNumber(inc)} ${inc === 1 ? "record" : "records"} sealed only partially`);
  if (skip > 0) parts.push(`${groupNumber(skip)} ${skip === 1 ? "record" : "records"} could not be captured (changed mid-crawl)`);
  if (van > 0) parts.push(`${groupNumber(van)} ${van === 1 ? "object" : "objects"} vanished mid-crawl (deleted before it could be read)`);
  return parts.join("; ");
}

// predecessorLine reads a run's predecessor chain pointer for the drawer's Run section,
// honestly: it never coerces a real-but-unavailable predecessor to look like "no predecessor" (an
// empty/blank reading there would misrepresent a pruned or unrecorded link as a broken chain). Returns
// null when the engine has not yet shipped prevRunIdStatus (an older engine), so the row is omitted
// entirely rather than showing a guess.
export function predecessorLine(run: RunHistoryEntry): string | null {
  switch (run.prevRunIdStatus) {
    case "none":
      return "None (this is the first run for this downpipe)";
    case "retained":
      return run.prevRunId ?? "-";
    case "pruned":
      return `${run.prevRunId ?? "-"} (outside the retained run history; not itself a broken chain)`;
    case "unknown":
      return "Not recorded (this run predates predecessor tracking)";
    default:
      return null; // the engine has not reported a chain verdict for this row
  }
}

export function flatten(byDownpipe: Record<string, RunHistoryEntry[]>, names: Map<string, string>): FleetRun[] {
  const out: FleetRun[] = [];
  for (const id of Object.keys(byDownpipe)) {
    // A run whose downpipe no longer exists (or whose list read failed) keeps its id as
    // the honest reading; the name is attached only when the engine supplied one.
    const name = names.get(id);
    for (const e of byDownpipe[id] ?? []) {
      // An UNPARSEABLE startedAt is checked ONCE here, where a run enters the screen, and not in the two
      // sort comparators that read it (helpers below, table.ts). Those comparators run O(n log n) times per
      // repaint and coerce a bad instant to 0, which sorts the run to the end of time and leaves it looking like
      // an ancient row rather than a corrupt one. One recorder, at the point the value arrives, gives support the
      // fact without turning a sort into an emit loop. The value never travels: only the class.
      if (Number.isNaN(Date.parse(e.startedAt))) recordWireAnomaly("timestamp", "unparseable");
      out.push({ ...e, downpipeId: id, ...(name ? { downpipeName: name } : {}) });
    }
  }
  // Newest-first across the whole fleet (the table re-sorts per its own state, but the
  // summary band and the deep-link resolution read this order).
  out.sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
  return out;
}

export function countDownpipes(runs: FleetRun[]): number {
  const ids = new Set<string>();
  for (const r of runs) ids.add(r.downpipeId);
  return ids.size;
}

// sumDefined sums a numeric field across rows, counting only rows that reported a finite
// number, so a partial wire shape never reads as a complete (false) zero.
export function sumDefined(runs: FleetRun[], pick: (r: FleetRun) => number | undefined): { sum: number; count: number } {
  let sum = 0;
  let count = 0;
  for (const r of runs) {
    const v = pick(r);
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
      count++;
    }
  }
  return { sum, count };
}

// humanDuration formats a millisecond duration as a short phrase ("820ms", "3.4s",
// "2m 05s", "1h 12m"). Presentation only, never fed back into a request. Negative or
// non-finite input reads "-".
export function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < MS_PER_SEC) return `${Math.round(ms)}ms`;
  const totalSec = ms / MS_PER_SEC;
  if (totalSec < SEC_PER_MIN) return `${totalSec.toFixed(totalSec < 10 ? 1 : 0)}s`;
  let totalMin = Math.floor(totalSec / SEC_PER_MIN);
  let remSec = Math.round(totalSec - totalMin * SEC_PER_MIN);
  // Carry a rounded-up second so a remainder in [59.5, 60)s reads "2m 00s", never "1m 60s"; the carry can
  // roll the minutes into the hour branch below (59m 60s -> 1h 00m).
  if (remSec === SEC_PER_MIN) { totalMin += 1; remSec = 0; }
  if (totalMin < SEC_PER_MIN) return `${totalMin}m ${String(remSec).padStart(2, "0")}s`;
  const hr = Math.floor(totalMin / SEC_PER_MIN);
  const remMin = totalMin - hr * SEC_PER_MIN;
  return `${hr}h ${String(remMin).padStart(2, "0")}m`;
}
