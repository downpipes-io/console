// The STATUS, THROUGHPUT and FRESHNESS encoding of the topology model: the deterministic
// mapping from a flow's raw status + bytes-per-run + last-run time to the hue/glyph/label/dash
// presentation, the bounded throughput steps, the human freshness phrasing against an explicit
// `now`, and the accessible-name composition the table and the SVG join both read. Split out
// of topology-model.ts as a dependency-light sibling so the model leaf stays under the size
// budget; topology-model.ts re-exports the public surface by name so no importer changes.
//
// Moved verbatim from topology-model.ts; every function, constant and threshold is byte-for-
// byte the original, so the encoding and the freshness strings are unchanged. The whole layer
// touches no DOM, no clock (beyond an explicit `now`) and no randomness, so it is deterministic.
// House rules: Australian English, no em dashes, precise claims.

import { recordWireAnomaly } from "../lib/client-diag/ring.ts";
import {
  ICON_CHECK,
  ICON_RUNS,
  ICON_ALERT,
  ICON_INFO,
  ICON_PAUSE,
  ICON_X_CIRCLE,
  ICON_QUESTION,
} from "../lib/icons.ts";
import { humanBytes, absoluteTime, cadenceLabel } from "../lib/format.ts";
import type {
  NodeKind,
  FlowStatus,
  FlowRecord,
  StatusPresentation,
  EdgeWeight,
  StatusCounts,
} from "./topology-types.ts";

// Throughput buckets (bytes per run -> one of three bounded steps). The thresholds are
// fixed so the mapping is deterministic and explainable; the NUMBER is the truth (the
// thickness is a reinforcement only, spec section 3). Unknown throughput is the thinnest
// step (it is never inflated into a thick "lots of data" read).
const THROUGHPUT_MEDIUM = 1024 * 1024; // >= 1 MB per run reads as medium
const THROUGHPUT_THICK = 64 * 1024 * 1024; // >= 64 MB per run reads as thick

// presentStatus is THE status mapping (hue + glyph + label + dash). Every surface (the
// SVG join, the edge label, the table cell) reads it, so there is one place the encoding
// lives. "unknown" and "disabled" are first-class and never green.
export function presentStatus(status: FlowStatus): StatusPresentation {
  switch (status) {
    case "healthy":
      return { status, tone: "trust", glyph: ICON_CHECK, label: "fresh", dash: "solid" };
    case "stale":
      return { status, tone: "warn", glyph: ICON_RUNS, label: "stale", dash: "solid" };
    case "partial":
      // 3-2-1 redundancy degraded but the data IS safe (>=1 copy made): amber like stale, but a
      // DISTINCT glyph + a dashed stroke so a monochrome reader tells "partial" from "stale" (both warn)
      // and from "failed" (danger). Never red, calling an under-replicated-but-captured run a failure
      // would be dishonest the other way.
      return { status, tone: "warn", glyph: ICON_INFO, label: "partial", dash: "dashed" };
    case "no-copy":
      // The engine has NEVER reported on this destination, so this copy is not behind, it does not
      // exist. Amber like partial (the run succeeded and the data IS safe on the destinations that reported),
      // but distinct on all three channels a monochrome reader has: its own glyph (an absence, not an
      // information note), its own dash (dotted: nothing has ever flowed down this lane) and its own word.
      // Reading it as "partial" is what told operators to wait for weeks for a copy nobody was making.
      return { status, tone: "warn", glyph: ICON_X_CIRCLE, label: "no copy", dash: "dotted" };
    case "failed":
      return { status, tone: "danger", glyph: ICON_ALERT, label: "failed", dash: "dashed" };
    case "disabled":
      // A PAUSE glyph (spec section 3): the disabled shape must differ from unknown so a
      // monochrome reader tells them apart by shape, not just by the (shared) dotted dash.
      return { status, tone: "neutral", glyph: ICON_PAUSE, label: "disabled", dash: "dotted" };
    case "unknown":
      // A QUESTION glyph (spec section 3): never a stale green, and shape-distinct from
      // disabled.
      return { status, tone: "neutral", glyph: ICON_QUESTION, label: "unknown", dash: "dotted" };
  }
}

// throughputWeight maps bytes-per-run to one of three bounded steps. Unknown/zero is the
// thinnest step (never inflated). The NUMBER is the truth shown in the label/table; this
// is a reinforcement only.
export function throughputWeight(bytesPerRun: number | null | undefined): EdgeWeight {
  // G298: a byte figure that ARRIVED as a number and is not finite (a NaN out of a division, an Infinity out of
  // a bad aggregate) silently becomes the thinnest edge, which is the same edge a downpipe moving nothing gets.
  // Absent (null/undefined) is the honest not-measured case and is NOT recorded; a non-finite NUMBER is a wire
  // fault and is. The value itself is not a member of anything and never rides.
  if (typeof bytesPerRun === "number" && !Number.isFinite(bytesPerRun)) recordWireAnomaly("bytes", "non-finite");
  if (bytesPerRun === null || bytesPerRun === undefined || !Number.isFinite(bytesPerRun) || bytesPerRun <= 0) return 1;
  if (bytesPerRun >= THROUGHPUT_THICK) return 3;
  if (bytesPerRun >= THROUGHPUT_MEDIUM) return 2;
  return 1;
}

// tally counts statuses for the SVG's aria-label summary. The total is the FULL flow set
// (not the drawn subset), so the summary is honest even when the canvas is capped.
export function tally(flows: FlowRecord[]): StatusCounts {
  const counts: StatusCounts = { total: flows.length, healthy: 0, stale: 0, partial: 0, noCopy: 0, failed: 0, disabled: 0, unknown: 0 };
  for (const f of flows) {
    if (f.status === "healthy") counts.healthy++;
    else if (f.status === "stale") counts.stale++;
    else if (f.status === "partial") counts.partial++;
    // G299: counted in its OWN bucket. The else-fallthrough below lands on `unknown`, so a no-copy lane would
    // have been tallied as "status could not be fetched" -- the aria summary would have said the console did
    // not know, when it knows exactly: that copy has never been made.
    else if (f.status === "no-copy") counts.noCopy++;
    else if (f.status === "failed") counts.failed++;
    else if (f.status === "disabled") counts.disabled++;
    else counts.unknown++;
  }
  return counts;
}

// summaryPhrase builds the SVG's aria-label: "N downpipes, X fresh, Y stale, Z failed, ..."
// Only non-zero categories beyond the total are listed, so the phrase stays terse and
// honest (it never claims "0 failed" as reassurance). An empty map reads explicitly.
export function summaryPhrase(counts: StatusCounts): string {
  if (counts.total === 0) return "Topology map: no downpipes configured yet.";
  const parts: string[] = [];
  if (counts.healthy) parts.push(`${counts.healthy} fresh`);
  if (counts.stale) parts.push(`${counts.stale} stale`);
  if (counts.partial) parts.push(`${counts.partial} partial`);
  if (counts.noCopy) parts.push(`${counts.noCopy} with no copy`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.disabled) parts.push(`${counts.disabled} disabled`);
  if (counts.unknown) parts.push(`${counts.unknown} unknown`);
  const noun = counts.total === 1 ? "downpipe" : "downpipes";
  const detail = parts.length ? `: ${parts.join(", ")}` : "";
  return `Topology map of ${counts.total} ${noun}${detail}.`;
}

// defaultKindLabel is the fallback group label for a node kind when no explicit group spec
// supplies one. Pure switch over the bounded kind set.
export function defaultKindLabel(kind: NodeKind): string {
  switch (kind) {
    case "kv": return "KV namespaces";
    case "r2": return "R2 buckets";
    case "d1": return "D1 databases";
    case "secrets": return "Secrets Store";
    case "s3": return "S3 targets";
    case "other": return "Other";
  }
}

// freshnessPhrase builds the human freshness text for a flow against an explicit `now`
// (presentation only, never fed back to the engine). It is a pure function of (flow, now),
// so the model stays deterministic; the disabled/unknown/never-run states read honestly
// and never imply a fresh run.
export function freshnessPhrase(flow: FlowRecord, now: number): string {
  if (flow.status === "disabled") return "disabled";
  if (flow.status === "unknown") return "status unknown";
  if (flow.lastRunAt === undefined || flow.lastRunAt === null || flow.lastRunAt === "") return "no run yet";
  const rel = relativeFrom(flow.lastRunAt, now);
  if (flow.status === "failed") return `failed ${rel}`;
  if (flow.status === "stale") return `stale, last run ${rel}`;
  // partial is amber (redundancy degraded but the data is safe): it ran, so it carries a
  // last-run time, but it is NOT fresh. Name it honestly rather than falling through to the
  // "fresh" wording, which would contradict the partial tone and glyph.
  if (flow.status === "partial") return `partial, last run ${rel}`;
  // G299: never fall through to "fresh". The RUN is fresh; this destination's copy of it does not exist.
  if (flow.status === "no-copy") return `no copy on this destination, last run ${rel}`;
  return `fresh, last run ${rel}`;
}

// relativeFrom is a relative-time phrase against an EXPLICIT `now` (epoch ms). The shared
// relativeTime (format.ts) reads the ambient Date.now and so has no injection point; this
// local form keeps buildTopologyModel a pure function of (data, now). Same unit ladder and
// Australian-English wording; presentation only.
export function relativeFrom(input: string | number | null | undefined, now: number): string {
  const ms = toMsLocal(input);
  if (ms === null) return "-";
  const deltaSec = Math.round((ms - now) / 1000);
  const abs = Math.abs(deltaSec);
  if (abs < 5) return "just now";
  return deltaSec > 0 ? `in ${unitPhrase(abs)}` : `${unitPhrase(abs)} ago`;
}

function unitPhrase(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 14) return `${day}d`;
  const wk = Math.round(day / 7);
  if (wk < 9) return `${wk}w`;
  const mo = Math.round(day / 30);
  if (mo < 18) return `${mo}mo`;
  return `${Math.round(day / 365)}y`;
}

export function toMsLocal(input: string | number | null | undefined): number | null {
  // ABSENT is legitimate (a downpipe that has never run has no last-run instant) and is not recorded: a row
  // there would fire on every fresh account. A value that ARRIVED and would not parse is a wire fault, and it is
  // the "freshness shows a dash beside runs that exist" ticket (G298). The value never rides.
  if (input === null || input === undefined || input === "") return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) recordWireAnomaly("timestamp", "non-finite");
    return Number.isFinite(input) ? input : null;
  }
  const n = Date.parse(input);
  if (!Number.isFinite(n)) recordWireAnomaly("timestamp", "unparseable");
  return Number.isFinite(n) ? n : null;
}

export function absoluteTimeOrEmpty(input: string | number | null | undefined): string {
  if (input === undefined || input === null || input === "") return "";
  return absoluteTime(input);
}

// buildAccessibleName composes the edge button's accessible name from the same fields the
// table row shows, so the two cannot disagree: source, destination, status, freshness,
// cadence, throughput.
export function buildAccessibleName(flow: FlowRecord, presentation: StatusPresentation, freshness: string): string {
  const parts: string[] = [];
  parts.push(`${flow.source.name} ${kindWord(flow.source.kind)} to ${flow.destination.name} ${kindWord(flow.destination.kind)}`);
  parts.push(presentation.label);
  // freshness already encodes the relative time for the non-trivial states; for the fresh
  // state it repeats "fresh, last run ...", which is acceptable in an accessible name. Skip it
  // when it carries no extra detail beyond the status word already pushed (the exact "disabled"
  // case, and the "unknown" label versus "status unknown" freshness case): the accessible name
  // then reads the status once rather than twice, matching the SVG marker's de-duplication guard.
  const label = presentation.label.toLowerCase();
  const fresh = freshness.toLowerCase();
  const freshnessOnlyRestatesStatus = fresh === label || fresh === `status ${label}`;
  if (freshness && !freshnessOnlyRestatesStatus) parts.push(freshness);
  if (flow.cadence !== undefined && Number.isFinite(flow.cadence)) parts.push(cadenceLabel(flow.cadence));
  const bytes = throughputText(flow.bytesPerRun);
  if (bytes) parts.push(`${bytes} per run`);
  if (flow.running) parts.push("running now");
  return parts.join(", ");
}

export function kindWord(kind: NodeKind): string {
  switch (kind) {
    case "kv": return "KV";
    case "r2": return "R2";
    case "d1": return "D1";
    case "secrets": return "Secrets Store";
    case "s3": return "S3";
    // "other" covers the token-authenticated sources (Cloudflare config / Workers / Stream /
    // Images / Artifacts), which are not stores: "source" reads sensibly beside their
    // descriptive names ("Cloudflare config source"), where "store" did not.
    case "other": return "source";
  }
}

// throughputText is the truthful numeric throughput ("2.1 MB" / "" when unknown). The
// thickness is a reinforcement; this string is the source of truth.
export function throughputText(bytesPerRun: number | null | undefined): string {
  if (bytesPerRun === null || bytesPerRun === undefined || !Number.isFinite(bytesPerRun)) return "";
  return humanBytes(bytesPerRun);
}
