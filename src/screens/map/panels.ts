// The presentation helpers for the topology map: the filter-bar facet vocabulary, the drawer
// detail renderers (the freshness line, the recent-runs strip), the destination honesty note,
// the small label/tone/parse helpers, and the WebGL probe for the view-status line. These are
// the DOM-producing leaves the view controller composes; they import the data leaf (./data.ts)
// for the destination-name read but never import a sibling that imports them back (one-way
// imports only). Moved verbatim from the map coordinator for size; behaviour is unchanged.
//
// No-custody is never weakened: every server-supplied string (a downpipe name, a binding, a
// bucket name, a run id) reaches the DOM through the dom.ts textContent path (h() / kvRow /
// the component's svgText), so there is no markup-injection surface; the WebGL probe reads
// local facts only and shows them to the operator. House rules: Australian English, no em
// dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { navigate } from "../../lib/nav.ts";
import { statusWithLabel, runStatusTone, type StatusTone } from "../../components/status.ts";
import { isUnsuccessful } from "../runs/types.ts";
import { relativeTime, absoluteTime } from "../../lib/format.ts";
import { ICON_INFO, ICON_ALERT } from "../../lib/icons.ts";
import type {
  FlowRecord,
  FlowStatus,
  FlowEndpoint,
  NodeKind,
} from "../../components/topology.ts";
import type { RunHistoryEntry } from "../../api.ts";
import { destinationBucket, type MapData } from "./data.ts";

// The number of recent runs shown in the drawer ring, matching the engine run-history
// ring depth. If the engine ring changes, change this in step.
const RECENT_RUNS_DISPLAY_LIMIT = 12;

// destinationNote is the on-screen statement of the single-destination model (so it is
// stated, never merely implied by the visual). It names the destination from the real
// destKind and explains the N -> 1 shape honestly, including the not-configured and
// unreachable cases.
export function destinationNote(flows: FlowRecord[], data: MapData): HTMLElement {
  const wrap = h("p", { class: "field__hint", style: "margin-top:var(--space-2)" });
  if (!data.status.ok) {
    wrap.appendChild(svgIcon(ICON_ALERT, { size: 13 }));
    wrap.appendChild(document.createTextNode(" The archive destination could not be read from the engine, so it is shown as unknown. The map still shows each source and its flow."));
    return wrap;
  }
  const s = data.status.value;
  const configured = s.destKind === "r2" || s.destKind === "s3" || s.destKind === "gcs" || s.destKind === "azure" || s.destConfigured;
  // Name the real archive in the sentence when the engine can state it (the same redaction-
  // safe bucket name the node carries), so the note reads "writes to your in-account R2
  // archive, downpipes-archive" rather than only the kind.
  const bucket = destinationBucket(data);
  const named = bucket !== null ? `, ${bucket}` : "";
  let destPhrase: string;
  if (s.destKind === "r2") destPhrase = `your in-account R2 archive${named}`;
  else if (s.destKind === "s3") destPhrase = `an S3 archive${named} (out of your Cloudflare account)`;
  else if (s.destKind === "gcs") destPhrase = `a Google Cloud Storage archive${named} (out of your Cloudflare account)`;
  else if (s.destKind === "azure") destPhrase = `an Azure Blob Storage archive${named} (out of your Cloudflare account)`;
  else if (s.destConfigured) destPhrase = `your configured archive destination${named}`;
  else destPhrase = "an archive destination that is not yet selected";

  const flowCount = flows.length;
  const distinctDests = new Set(flows.map((f) => f.destination.name)).size;
  wrap.appendChild(svgIcon(ICON_INFO, { size: 13 }));
  if (flowCount === 0) {
    wrap.appendChild(document.createTextNode(` Downpipes write to ${destPhrase}. Add downpipes and the map shows each source flowing to the destination(s) you choose.`));
  } else if (distinctDests > 1) {
    // Multi-destination / fan-out: name the spread honestly (one edge per destination a source is
    // copied to). The default phrase still names the account default for downpipes that follow it.
    wrap.appendChild(document.createTextNode(` ${flowCount} flows across ${distinctDests} destinations. Fan a source out to more than one destination and each one keeps a copy of every run.`));
  } else {
    const noun = flowCount === 1 ? "downpipe writes" : "downpipes write";
    // One destination in view: state the fact once (the visual carries the convergence).
    wrap.appendChild(document.createTextNode(` ${flowCount} ${noun} to ${destPhrase}.`));
  }
  if (!configured) {
    // The console owns the fix: link to the Destinations screen rather than naming a raw
    // engine env var.
    wrap.appendChild(document.createTextNode(" "));
    wrap.appendChild(h("button", { "data-dp": "map.button.navigate-destinations", class: "linklike", type: "button", on: { click: () => navigate("/destinations") } }, "Choose it on Destinations"));
    wrap.appendChild(document.createTextNode("."));
  }
  return wrap;
}

// ---- presentation helpers (drawer + filter bar) -----------------------------

// STATUS_RANK is the SINGLE type-checked source of truth for the FlowStatus membership and the
// filter-bar order. It is a Record<FlowStatus, number>, so the compiler errors if a FlowStatus
// variant is added without a rank (this is what stopped 'partial' from silently dropping out of the
// filter bar and the URL filter again). STATUS_ORDER and parseStatusFilter's allow-list are both
// DERIVED from it, so they can never drift from FlowStatus by hand.
// "no-copy" ranks WORSE than partial (a copy that is behind is being made; a copy that has stayed empty
// across successive successful backups is not), and better than a failed run (the data is still safe on the
// destinations that did report). Rank 1 of 7 is a severe thing to say, and it is EARNED before it is said: the
// lane is anchor-gated (replication.ts destinationLaneStatus), so a destination added minutes ago to a running
// downpipe ranks as "partial", not second-worst in the fleet.
const STATUS_RANK: Record<FlowStatus, number> = {
  failed: 0, "no-copy": 1, stale: 2, partial: 3, unknown: 4, healthy: 5, disabled: 6,
};
export const STATUS_ORDER: FlowStatus[] = (Object.keys(STATUS_RANK) as FlowStatus[]).sort(
  (a, b) => STATUS_RANK[a] - STATUS_RANK[b],
);

// KIND_RANK is the same single type-checked source of truth for NodeKind: the compiler errors if a
// NodeKind variant is added without a rank, so KIND_ORDER and parseKindFilter's allow-list cannot
// drift from NodeKind by hand.
const KIND_RANK: Record<NodeKind, number> = {
  kv: 0, r2: 1, d1: 2, secrets: 3, s3: 4, other: 5,
};
export const KIND_ORDER: NodeKind[] = (Object.keys(KIND_RANK) as NodeKind[]).sort(
  (a, b) => KIND_RANK[a] - KIND_RANK[b],
);

export function parseStatusFilter(raw: string | null): FlowStatus | null {
  if (!raw) return null;
  return Object.hasOwn(STATUS_RANK, raw) ? (raw as FlowStatus) : null;
}

export function parseKindFilter(raw: string | null): NodeKind | null {
  if (!raw) return null;
  return Object.hasOwn(KIND_RANK, raw) ? (raw as NodeKind) : null;
}

// statusPresent maps a FlowStatus to a tone + label for the drawer badge and the freshness
// line, mirroring the component's own status vocabulary (never a stale green for unknown).
export function statusPresent(status: FlowStatus): { tone: StatusTone; label: string } {
  switch (status) {
    case "healthy": return { tone: "trust", label: "Fresh" };
    case "stale": return { tone: "warn", label: "Stale" };
    case "partial": return { tone: "warn", label: "Partial" };
    case "no-copy": return { tone: "warn", label: "No copy" };
    case "failed": return { tone: "danger", label: "Failed" };
    case "disabled": return { tone: "neutral", label: "Disabled" };
    case "unknown": return { tone: "neutral", label: "Unknown" };
  }
}

export function statusFilterLabel(status: FlowStatus): string {
  switch (status) {
    case "healthy": return "Fresh";
    case "stale": return "Stale";
    case "partial": return "Partial";
    case "no-copy": return "No copy";
    case "failed": return "Failed";
    case "disabled": return "Disabled";
    case "unknown": return "Unknown";
  }
}

export function statusFilterTone(status: FlowStatus): StatusTone {
  return statusPresent(status).tone;
}

export function kindLabel(kind: NodeKind): string {
  switch (kind) {
    case "kv": return "KV";
    case "r2": return "R2";
    case "d1": return "D1";
    case "secrets": return "Secrets";
    case "s3": return "S3";
    case "other": return "Other";
  }
}

export function kindWord(kind: NodeKind): string {
  switch (kind) {
    case "kv": return "KV";
    case "r2": return "R2";
    case "d1": return "D1";
    case "secrets": return "Secrets Store";
    case "s3": return "S3";
    // "other" covers the token-authenticated sources (Cloudflare config / Workers / Stream /
    // Images / Artifacts), which are not stores; endpointText still skips the word entirely
    // for placeholder destination endpoints.
    case "other": return "source";
  }
}

// flowTouchesNode reports whether a flow is incident on a node id ("<side>:<kind>:<name>",
// the component's stable id). A source-side id matches the flow's source; a destination-side
// id matches its destination. We rebuild the same id shape the component uses.
export function flowTouchesNode(flow: FlowRecord, nodeId: string): boolean {
  return endpointNodeId("source", flow.source) === nodeId || endpointNodeId("destination", flow.destination) === nodeId;
}

function endpointNodeId(side: "source" | "destination", ep: FlowEndpoint): string {
  return `${side}:${ep.kind}:${ep.name}`;
}

// nodeFilterLabel extracts a friendly label from a node id for the filter chip.
export function nodeFilterLabel(nodeId: string): string {
  const parts = nodeId.split(":");
  // "<side>:<kind>:<name>" -> the name is everything after the second colon (a name may
  // itself contain a colon, so re-join the tail).
  if (parts.length >= 3) return parts.slice(2).join(":");
  return nodeId;
}

export function endpointText(ep: FlowEndpoint): string {
  // "other" is the placeholder kind ("destination not selected" / "destination
  // (unknown)"): a placeholder is not a store, so it takes no kind parenthetical.
  return ep.kind === "other" ? ep.name : `${ep.name} (${kindWord(ep.kind)})`;
}

export function lastRunText(flow: FlowRecord): string {
  if (flow.lastRunAt == null || flow.lastRunAt === "") return "no run yet";
  const rel = relativeTime(flow.lastRunAt);
  const abs = absoluteTime(flow.lastRunAt);
  return abs ? `${rel} (${abs})` : rel;
}

// freshnessLine renders the honest hue + shape + label freshness summary at the top of the
// drawer (mirrors the freshness banner idiom from sources-downpipes.ts). `ring` is the
// last-fetched run history for this flow, or null when that read failed: "unknown" covers
// both a configured pipe that has never run AND an unreadable history (deriveStatus,
// pendingWhenNoRuns:false), and the two deserve different words.
export function freshnessLine(flow: FlowRecord, ring: RunHistoryEntry[] | null): HTMLElement {
  const p = statusPresent(flow.status);
  const detail =
    // A "failed" edge has two distinct origins. A lane-only failure (this destination is unreachable but the
    // backup run itself completed) must NOT send the operator to Recent runs, which shows no failure since
    // the capture succeeded; the real cause is the drawer's own Copies line below. A genuine capture failure
    // keeps the original sentence. That drew the partial/no-copy distinction; this extends it to "failed".
    flow.status === "failed"
      ? (flow.laneFailed
        ? "A destination is unreachable, so this copy is behind; the backup run itself completed. See Copies below for which destinations are affected."
        : "The latest run failed; the reason is under Recent runs below.")
    : flow.status === "stale" ? "The last good backup is older than the expected cadence."
    // This sentence now says what the console can PROVE. The lane only fires once at least two backups have
    // succeeded since this destination joined the fan-out and it holds neither of them, so "no copy is being made"
    // is an earned claim, not an inference from an absent row. A destination added minutes ago reads "partial"
    // (catching up) and never reaches these words, which is why they can be this firm.
    : flow.status === "no-copy" ? "Backups have completed since this destination was added and it has never reported holding one, so no copy is being made here. Waiting will not fix it. The other destinations still hold the backup."
    : flow.status === "partial" ? "Some destination copies are not up to date; the flow is still writing but redundancy is reduced."
    : flow.status === "disabled" ? "This downpipe is paused; it is not running on a schedule."
    : flow.status === "unknown"
      ? (ring !== null && ring.length === 0
        ? "No run yet; the first backup will set this."
        : "The status could not be read; this is not a backup failure.")
    : flow.running ? "A run is in progress."
    : "The latest backup is current.";
  return h(
    "div",
    { class: "card card--inset", style: "display:flex;align-items:flex-start;gap:var(--space-3);margin-bottom:var(--space-3)" },
    statusWithLabel(p.tone, p.label),
    h("span", { class: "field__hint" }, detail),
  );
}

// recentRunsList renders the recent-run ring as a compact accessible list (newest first),
// each entry status by hue + shape + label, with an absolute time. No bare colour.
export function recentRunsList(entries: RunHistoryEntry[]): HTMLElement {
  const list = h("ul", { class: "topo-runs", role: "list", style: "list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--space-1)" });
  for (const e of entries.slice(0, RECENT_RUNS_DISPLAY_LIMIT)) {
    // runStatusTone is the canonical mapping (components/status.ts). This site used to re-derive it as
    // ok / failed / else, which sent an ABANDONED run down the else arm and printed the visible word
    // "in-flight" for a run the engine had already given up on. That is the worst of the abandoned
    // regressions, because it is wrong in the text rather than only in the hue.
    const { tone, label } = runStatusTone(e.status);
    const abs = absoluteTime(e.startedAt);
    const li = h(
      "li",
      { style: "display:flex;align-items:center;gap:var(--space-2)", ...(abs ? { title: abs } : {}) },
      statusWithLabel(tone, label),
      h("span", { class: "field__hint mono" }, relativeTime(e.startedAt)),
    );
    // isUnsuccessful, not `=== "failed"`: the engine's reason string for an abandoned run ("abandoned
    // (run lease expired)") was being withheld here, so the one line explaining what happened never
    // reached this drawer. runs/table.ts already made exactly this fix.
    if (isUnsuccessful(e.status) && e.error) {
      li.appendChild(h("span", { class: "field__hint" }, e.error));
    }
    list.appendChild(li);
  }
  return list;
}

// probeWebglInfo reports WebGL availability and, where the browser permits, the unmasked
// renderer string - the single fact that distinguishes "no GPU at all", "software raster"
// and "blocked by a privacy shield". Read locally, shown to the operator only.
export function probeWebglInfo(): string {
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl") ?? c.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return "unavailable";
    try {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number } | null;
      if (dbg) return `available (${String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))})`;
    } catch {
      /* masked */
    }
    return "available (renderer masked)";
  } catch (err) {
    return `error: ${String(err)}`;
  }
}
