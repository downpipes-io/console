// The data leaf for the topology map: the pure downpipe -> FlowRecord mapping, the shared
// freshness rule, the source / destination derivation, and the screen-local data types and
// constants. These are the dependency-light building blocks the view controller and the
// presentation helpers both reach for, kept in this leaf so no sibling module imports another
// (one-way imports only). Moved verbatim from the map coordinator for size; behaviour is
// unchanged.
//
// Honest by construction (mirrored from overview.ts):
// the mapping binds to the engine's own data and NEVER fabricates a flow or a green. A
// downpipe whose status cannot be read reads "unknown" (a neutral hue), never a stale teal;
// "stale" (a good run older than the cadence implies) is distinct from "disabled" (a paused
// downpipe is not a failure) and from "unknown" (an unreachable engine is not a backup
// failure). No-custody is never weakened: this leaf derives names, counts, statuses and
// freshness only, all from the in-account engine; it reads no key material.
//
// classifyFreshness and mapDownpipesToFlows are PURE and DOM-free, and nothing in this module
// executes a DOM or canvas call at import time, so the freshness validator imports and runs
// them in Node without a DOM. House rules: Australian English, no em dashes, precise claims.

import { recordWireAnomaly } from "../../lib/client-diag/ring.ts";
import type {
  FlowRecord,
  FlowStatus,
  FlowEndpoint,
  NodeKind,
} from "../../components/topology.ts";
import { destinationLaneStatus, downDestinationIds } from "../../components/replication.ts";
import type { ReplAnchor } from "../../components/replication.ts";
import type {
  DestinationStatus,
  DestinationList,
  DestReplState,
  DownpipeState,
  EngineClient,
  RunHistoryEntry,
  SourceSpec,
  StatusReport,
} from "../../api.ts";

// How many cadence intervals past the last good run before a flow reads STALE. This is the
// freshness threshold shared by the map and the dashboard (overview/fleet-data.ts imports
// classifyFreshness and inherits this value; there is no separate copy). A single late run
// does not cry wolf, while a genuinely stopped backup surfaces loudly.
const STALE_CADENCE_MULTIPLE = 1.5;

// ---- the downpipe -> FlowRecord mapping (the screen's core job) --------------

export interface MapData {
  downpipes: Settled<DownpipeState[]>;
  history: Settled<Record<string, RunHistoryEntry[]>>;
  status: Settled<StatusReport>;
  destination: Settled<DestinationStatus>;
  destinations: Settled<DestinationList>;
  replication: Settled<Record<string, Record<string, DestReplState>>>;
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

// fetchAllSources reads the six engine sources independently, each settled to a Settled<T> so a
// single failure does not reject the whole map: the downpipes LIST is the core (its failure is
// the screen's honest error state); the others degrade to unknown / relaxed freshness. Moved
// out of the view controller for size; the read orchestration belongs with the data leaf.
export async function fetchAllSources(engine: EngineClient): Promise<MapData> {
  const settle = async <T>(p: Promise<T>): Promise<Settled<T>> => {
    try {
      return { ok: true, value: await p };
    } catch (error) {
      return { ok: false, error };
    }
  };
  const [downpipes, history, status, destination, destinations, replication] = await Promise.all([
    settle(engine.listDownpipes()),
    settle(engine.listAllHistory().then((r) => r.byDownpipe)),
    settle(engine.status()),
    // The destination read names the REAL archive (the bucket) on the destination node; it
    // degrades to the generic kind label when unreadable, never blocks the map (not core).
    settle(engine.getDestination()),
    // The full destination COLLECTION: a downpipe pinned to a destination (or fanned across
    // several via destinationIds) draws one edge per destination it writes to, named from this
    // list, instead of a single edge to the default. Degrades to the default-only mapping when
    // unreadable (never blocks the map).
    settle(engine.listDestinations()),
    // Per-destination replication state: drives the per-lane "partial" amber and the destination-down
    // indicator from PROVEN copies/reachability. Non-core: an empty map degrades to the prior behaviour
    // (one shared status per downpipe, no down badge), never blocking the map.
    settle(engine.listReplication().then((r) => r.byDownpipe)),
  ]);
  return { downpipes, history, status, destination, destinations, replication };
}

export function emptyMapData(): MapData {
  return {
    downpipes: { ok: true, value: [] },
    history: { ok: false, error: new Error("not loaded") },
    status: { ok: false, error: new Error("not loaded") },
    destination: { ok: false, error: new Error("not loaded") },
    destinations: { ok: false, error: new Error("not loaded") },
    replication: { ok: false, error: new Error("not loaded") },
  };
}

// mapDownpipesToFlows is the heart of the screen: it turns each downpipe (config + state)
// plus its run history into a FlowRecord the topology component renders. The mapping rules
// (spec section 6, the task brief):
//   - source: from the SourceSpec (kind from source.type; name from the binding /
//     namespaceId / bucketName, or the secrets summary for the Secrets layer);
//   - DESTINATION: the engine's SINGLE configured archive destination (status.destKind /
//     destConfigured). Until per-downpipe destinations exist, every flow points at the same
//     destination node, labelled honestly (see destinationFor);
//   - status: derived from the latest run-history entry (ok -> healthy, failed -> failed),
//     refined by freshness (a good run older than the cadence implies -> stale), with
//     enabled:false -> disabled and no-history / unreachable -> unknown (never a fake green);
//   - bytesPerRun: from the newest entry that carries archiveBytesWritten (the archive write
//     size; an in-flight newest entry has no figure yet and does not blank an earlier one),
//     falling back to undefined (unknown), never inflated;
//   - cadence: cadenceSeconds (the component formats the label);
//   - running: any in-flight history entry, or the engine's inFlight flag.
export function mapDownpipesToFlows(data: MapData, nowMs: number = Date.now()): FlowRecord[] {
  const downpipes = data.downpipes.ok ? data.downpipes.value : [];
  const history = data.history.ok ? data.history.value : {};
  const haveHistory = data.history.ok;
  const now = nowMs;

  const defaultDestination = destinationFor(data);
  const destById = buildDestinationIndex(data);
  const resolveDest = (id: string): FlowEndpoint => destById.get(id) ?? defaultDestination;

  // Per-destination replication state (non-core): which destinations are behind or down, from PROVEN
  // engine outcomes. Empty when unreadable, which degrades to one shared status per downpipe + no badge.
  const replByDp = data.replication?.ok ? data.replication.value : {};
  const downSet = downDestinationIds(replByDp);
  // G299: a FAILED heartbeat read collapses replByDp to {}, which is byte-identical to "this downpipe has no
  // heartbeats". The anchor must not be allowed to convert that silence into proof: with the read faulted, a
  // destination that holds EVERY run has no row either, and "no copy" would be false of exactly the destination
  // that is working. The engine keeps `readable` as a separate flag for this reason and the bot gates on
  // heartbeatsUnreadable; this is the console's copy of that rule. Row absence is evidence only when the read
  // that would have carried the row succeeded.
  const replReadable = data.replication?.ok === true;

  return downpipes.flatMap((state) => {
    const dp = state.config;
    const ring = haveHistory ? history[dp.id] ?? [] : [];
    const latest = ring[0]; // newest-first
    const running = state.inFlight || latest?.status === "in-flight";

    const source = sourceEndpoint(dp.source);
    const status = deriveStatus(state, ring, haveHistory, now);
    const bytesPerRun = latestArchiveBytes(ring);
    // "Caught up" is measured against the newest SUCCESSFUL run (what the engine replicates to the others).
    const latestRunId = ring.find((e) => e.status === "ok")?.runId ?? null;
    const repl = replByDp[dp.id];
    // G299: the anchor rides off the downpipe's OWN engine state (GET /admin/downpipes forwards sealedRuns +
    // replAnchors verbatim), not off the replication read. That matters: the replication heartbeats are the
    // non-core source that degrades to {} when unreadable, and it is exactly the destinations MISSING from that
    // map the lane has to judge. Both fields are honestly absent on a downpipe with no fan-out and on a record
    // written before the anchor shipped, and an absent anchor keeps the milder lane. It is also WITHHELD when
    // the heartbeat read faulted (replReadable), because a missing row is then not evidence of a missing copy.
    const anchor: ReplAnchor = replReadable
      ? {
          ...(state.sealedRuns !== undefined ? { sealedRuns: state.sealedRuns } : {}),
          ...(state.replAnchors !== undefined ? { anchors: state.replAnchors } : {}),
        }
      : {};

    const targets = buildTargets(dp, defaultDestination, resolveDest);
    const fanOut = targets.length >= 2;

    return targets.map(({ endpoint, edgeId, destId }): FlowRecord =>
      buildFlowRecord({ dp, source, status, latest, bytesPerRun, running, latestRunId, repl, anchor, downSet, fanOut }, endpoint, edgeId, destId),
    );
  });
}

// buildDestinationIndex maps id -> endpoint for every console-set destination, so a pinned or fanned
// downpipe names the REAL destination(s) it writes to. The list read is non-core: if it failed the map
// is empty and every downpipe falls back to the default endpoint (the prior N -> 1 behaviour), never
// an error. Console-set destinations are S3-shaped buckets (R2 reached via its S3 endpoint); they
// render as archive nodes. The default keeps its precise destKind glyph via destinationFor.
function buildDestinationIndex(data: MapData): Map<string, FlowEndpoint> {
  const destById = new Map<string, FlowEndpoint>();
  if (data.destinations?.ok) {
    for (const d of data.destinations.value.destinations) {
      if (typeof d.id !== "string" || d.id === "") continue;
      const name = (d.label?.trim()) || (d.bucket?.trim()) || d.id;
      destById.set(d.id, { name, kind: "r2" });
    }
  }
  return destById;
}

interface FlowTarget { endpoint: FlowEndpoint; edgeId: string; destId?: string }

// buildTargets resolves which destination(s) a downpipe writes to: destinationIds (fan-out, ordered,
// index 0 is the primary) wins; else the legacy single destinationId; else the account default. It
// returns one target (one edge) PER destination, so a 1 -> N fan-out renders as N edges to N nodes,
// not a single 1:1. edgeId stays dp.id for the single-destination / default case (drawer deep-links,
// history reads and "Open in Downpipes" key on it unchanged); fan-out gives each edge a unique
// `${dp.id}__${destId}` that downpipeIdOf() recovers dp.id from.
function buildTargets(
  dp: DownpipeState["config"],
  defaultDestination: FlowEndpoint,
  resolveDest: (id: string) => FlowEndpoint,
): FlowTarget[] {
  const ids = dp.destinationIds && dp.destinationIds.length > 0
    ? dp.destinationIds
    : dp.destinationId
      ? [dp.destinationId]
      : [];
  return ids.length === 0
    ? [{ endpoint: defaultDestination, edgeId: dp.id }]
    : ids.length === 1
      ? [{ endpoint: resolveDest(ids[0]!), edgeId: dp.id, destId: ids[0]! }]
      : ids.map((id) => ({ endpoint: resolveDest(id), edgeId: `${dp.id}__${id}`, destId: id }));
}

interface FlowInputs {
  dp: DownpipeState["config"];
  source: FlowEndpoint;
  status: FlowStatus;
  latest: RunHistoryEntry | undefined;
  bytesPerRun: number | undefined;
  running: boolean;
  latestRunId: string | null;
  repl: Record<string, DestReplState> | undefined;
  // G299: the replication ANCHOR for this downpipe (its monotone successful-run count + the per-destination
  // count-at-entry map, off its own engine state). destinationLaneStatus cannot honestly paint the "no copy"
  // lane without it: row absence alone cannot tell a destination added minutes ago from one dark for months.
  anchor: ReplAnchor;
  downSet: Set<string>;
  fanOut: boolean;
}

// buildFlowRecord assembles one FlowRecord (one edge) for a resolved target. exactOptionalPropertyTypes:
// the optional fields are spread only when present, never assigned undefined. lastRunAt is the latest
// run's start (or omitted when none); cadence is the schedule; bytesPerRun is the archive write size
// when known. The capture-level fields are shared by every edge; the STATUS and the destination's down
// flag (plus its down REASON, B30) are per-destination for a fan-out downpipe (a single-destination
// downpipe keeps one shared status, its capture state speaks for its only copy).
function buildFlowRecord(f: FlowInputs, endpoint: FlowEndpoint, edgeId: string, destId?: string): FlowRecord {
  const down = f.fanOut && destId !== undefined && f.downSet.has(destId);
  const laneStatus = f.fanOut && destId !== undefined ? destinationLaneStatus(f.status, destId, f.repl, f.latestRunId, f.anchor) : f.status;
  // A lane-only failure: destinationLaneStatus overrode the status to "failed" because THIS destination is
  // unreachable, while the downpipe's own capture (f.status) did NOT fail. The run succeeded; only this copy
  // did not land, so the freshness sentence must point at Copies, never Recent runs (where there is no
  // failure to find). A genuine capture failure has f.status === "failed" and carries no lane flag.
  const laneFailed = laneStatus === "failed" && f.status !== "failed";
  // B30: the SAME per-destination reason the drawer's Copies row names (replication.ts summariseReplication
  // reads it off this identical DestReplState.reason field), so the map node and the drawer never disagree
  // about why a destination is down. Guarded exactly like summariseReplication's downReasons[id]: a
  // non-empty string only, never a fabricated cause when the engine sent none.
  const rawReason = down && destId !== undefined ? f.repl?.[destId]?.reason : undefined;
  const downReason = typeof rawReason === "string" && rawReason.length > 0 ? rawReason : undefined;
  return {
    id: edgeId,
    source: f.source,
    destination: down ? { ...endpoint, down: true, ...(downReason !== undefined ? { downReason } : {}) } : endpoint,
    status: laneStatus,
    enabled: f.dp.enabled,
    running: f.running,
    ...(laneFailed ? { laneFailed: true } : {}),
    ...(f.latest ? { lastRunAt: f.latest.startedAt } : {}),
    ...(Number.isFinite(f.dp.cadenceSeconds) ? { cadence: f.dp.cadenceSeconds } : {}),
    ...(f.bytesPerRun !== undefined ? { bytesPerRun: f.bytesPerRun } : {}),
  };
}

// downpipeIdOf recovers the downpipe id from a flow/edge id. A single-destination flow's id IS the
// downpipe id; a fan-out edge id is `${downpipeId}__${destId}` (downpipe ids are kebab slugs and never
// contain "__"), so the downpipe id is everything before the first "__". Used for the per-flow history
// read and the "Open in Downpipes" deep link, which key on the real downpipe id.
export function downpipeIdOf(flowId: string): string {
  const i = flowId.indexOf("__");
  return i === -1 ? flowId : flowId.slice(0, i);
}

// The status of one flow as the engine measures it, BEFORE the screen-specific presentation
// (overview keeps an explicit "in-flight" Freshness value; the map carries in-flight as the
// `running` flag and renders the status as "healthy"). This is the single shared vocabulary
// classifyFreshness returns; each screen translates it into its own type below.
//   "in-flight" here means ONLY "a run is in progress and there is no usable last-good run
//   yet" (a healthy-pending first run); it is NEVER returned over an older good run, because
//   staleness is measured from the last SUCCESSFUL run and an in-flight run does not reset it.
export type CoreFreshness = "disabled" | "unknown" | "failed" | "stale" | "healthy" | "in-flight";

// The inputs classifyFreshness needs, as primitives so the dashboard (overview.ts) can feed
// the same rule for ids that appear only in history (no backing config) or when a whole list
// failed to load. The two screens differ in exactly ONE documented place (a never-run but
// enabled+configured pipe): the map reads it "unknown" (nothing has run), the dashboard reads
// it "healthy-pending"; that is the pendingWhenNoRuns flag, and it is orthogonal to the
// freshness/staleness/in-flight precedence the two screens MUST share.
export interface FreshnessInput {
  enabled: boolean;
  hasConfig: boolean; // a backing downpipe config exists (so enabled/cadence are trustworthy)
  haveHistory: boolean; // the history map was readable at all
  haveDownpipes: boolean; // the downpipe list was readable at all
  latestStatus: "ok" | "failed" | "in-flight" | "abandoned" | "none"; // the newest run of any status ("abandoned": the engine retired an in-flight run)
  lastGoodAt: string | null; // the newest OK run's startedAt (drives staleness)
  cadenceSeconds: number | null;
  now: number;
  // When there is no good run AND no run is in flight AND no run has happened at all:
  // true => "healthy" (a freshly created, enabled, configured pipe reads healthy-pending),
  // false => "unknown" (nothing has run, so make no claim). Defaults to false (the honest map
  // reading); overview opts in to the pending reading for its landing roll-up.
  pendingWhenNoRuns?: boolean;
}

// classifyFreshness is the ONE freshness rule shared by the map (deriveStatus) and the
// dashboard (summariseFleet), so the two surfaces cannot disagree about whether a downpipe is
// fresh. It matches the engine's authority (engine/src/notify.ts classify): staleness is
// measured from the last SUCCESSFUL run, and a run currently in flight does NOT reset
// staleness, so a stale good run reads "stale" even while a new run is in progress (a hung or
// repeatedly-restarting run must not mask a silently-stuck backup on either screen). The
// precedence, highest first:
//   disabled (enabled:false; an honesty rule, a paused pipe is not a failure) >
//   unknown (history/list unreadable, never a fake green) >
//   failed (the latest run failed) >
//   stale | healthy (judged on the newest GOOD run's age vs the cadence tolerance) >
//   in-flight (only when there is NO usable last-good run: a healthy-pending first run) >
//   unknown / healthy-pending (no runs yet; see pendingWhenNoRuns).
export function classifyFreshness(input: FreshnessInput): CoreFreshness {
  const { enabled, hasConfig, haveHistory, haveDownpipes, latestStatus, lastGoodAt, cadenceSeconds, now } = input;

  // Nothing readable and no config to lean on: honest unknown.
  if (!haveDownpipes && !hasConfig && !haveHistory) return "unknown";
  // A paused pipe is not a failure; disabled outranks every run-derived state.
  if (hasConfig && !enabled) return "disabled";
  // History unreadable for this pipe: honest unknown (not green, and not stale, which would
  // imply we know the last good run is old).
  if (!haveHistory) return "unknown";
  // The latest run failed: the loudest run-level state.
  if (latestStatus === "failed") return "failed";
  // The newest GOOD run drives freshness. This is evaluated BEFORE the in-flight check, so an
  // in-flight run over an older good run is judged on that good run's age (the fix for the
  // dashboard/map disagreement): an in-flight run does not reset staleness.
  if (lastGoodAt !== null) {
    // G298: THE STAMP IS TESTED FIRST, AND NOT INSIDE THE CADENCE BRANCH, and that ordering is the whole fix. The
    // last GOOD run's instant is what every green claim on this downpipe rests on. If it will not parse, this
    // build cannot date the backup, and it must not then call it fresh. The test used to sit INSIDE
    // `cadenceSeconds > 0`, so a corrupt stamp arriving with an unusable cadence (a string, null, 0, or a cadence
    // this build could not read) skipped the test entirely, fell through to "healthy", and rendered green on the
    // map and "Ok" in the table with an EMPTY PACK: byte-identical to a genuinely fresh downpipe. The cadence
    // decides only whether the stamp is OLD; it has no bearing on whether the stamp is READABLE.
    const startedMs = Date.parse(lastGoodAt);
    if (!Number.isFinite(startedMs)) {
      recordWireAnomaly("timestamp", "unparseable");
      return "unknown";
    }
    if (cadenceSeconds !== null && cadenceSeconds > 0) {
      const ageSec = (now - startedMs) / 1000;
      if (ageSec > cadenceSeconds * STALE_CADENCE_MULTIPLE) return "stale";
      // Readable good run, within the cadence tolerance: genuinely healthy.
      return "healthy";
    }
    // No cadence to judge staleness against. Call it healthy ONLY when we actually hold this pipe's
    // config (a live pipe whose config simply carries no cadence). If the config is unreadable this
    // poll - the downpipes list failed to load, or the pipe was dropped from config while an old run
    // lingers in history - an old good run must NOT read green: without the cadence-bearing config we
    // cannot back a freshness claim, so it is an honest "unknown". This mirrors the no-run case below
    // (line ~350), which already gates a green claim on hasConfig. Otherwise a pipe correctly reading
    // "stale" on a good load would silently upgrade to "Fleet is healthy" the moment only the config
    // read failed while history kept serving the same old run (NDH-overview-stale-config-read).
    if (!hasConfig) return "unknown";
    // A live pipe whose instant is readable and whose config carries no cadence to judge it against:
    // we have a usable backup. A cadence that ARRIVED unreadable is recorded at the seam that reads
    // it (cadenceSecondsOf), so the pack still says why no staleness verdict was reached.
    return "healthy";
  }
  // No good run yet. An in-flight FIRST run is healthy-pending (the running cue conveys it).
  if (latestStatus === "in-flight") return "in-flight";
  // No good run and nothing in flight. With no run at all, defer to the screen's policy;
  // otherwise (only non-ok entries, a contradiction in practice) make no green claim.
  if (latestStatus === "none") return hasConfig && input.pendingWhenNoRuns === true ? "healthy" : "unknown";
  // G298: a run status this console build does not know. The pipe renders "unknown" on the map, which is the
  // same thing an unreadable history renders, so a fleet that is running perfectly on a newer engine can read as
  // a fleet nobody can see. The coarsening is right (no green claim we cannot back); the silence is the bug. The
  // VALUE never rides: a status is engine-supplied and an unknown one is precisely the value not to trust.
  // "abandoned" is a KNOWN terminal status the engine has always minted (an in-flight run the SRE path retires).
  // It was not in the console's union, so it fell into the branch below and stamped a version-skew row on a
  // legitimate, current engine state, coalescing with the genuine future-skew this row exists to catch. It makes
  // no green claim (there is no good run), so the map still reads "unknown"; what changes is that the pack no
  // longer calls a working engine a skewed one.
  const known: string = latestStatus;
  if (known !== "ok" && known !== "failed" && known !== "in-flight" && known !== "abandoned" && known !== "none") {
    recordWireAnomaly("status-enum", "unknown-enum");
  }
  return "unknown";
}

// cadenceSecondsOf (G298) is the ONE seam that reads a downpipe config's cadence for the freshness rule, and the
// only place the console is allowed to coarsen it. Every surface that judges staleness (the map, the downpipes
// table, the Overview fleet roll-up) calls it, because THE SILENT COARSENING WAS THE BUG AND IT LIVED IN THREE
// COPIES: each caller wrote `Number.isFinite(config.cadenceSeconds) ? config.cadenceSeconds : null` (or, on the
// fleet, passed the value straight through), and a null cadence DISABLES THE ENTIRE STALENESS TEST. A downpipe
// whose last good run was two months ago then rendered healthy on the map and "Ok" in the table with an empty
// pack, because a version-skewed or corrupt engine sent a cadence in a shape this build cannot read.
//
// The wire contract is `cadenceSeconds: number` (lib/api/types/downpipes.ts), so anything else is engine skew or
// corruption and the two states are told apart:
//   missing     the field is not there at all (undefined or null): an engine that does not send it.
//   non-finite  the field ARRIVED and is not a usable number (a string, NaN, Infinity): a shape this build
//               cannot read.
// The VALUE never rides: a cadence that failed this test is exactly the value not to be trusted, and the row
// carries the closed field class and the closed anomaly only.
export function cadenceSecondsOf(config: { cadenceSeconds: number }): number | null {
  const raw: unknown = config.cadenceSeconds;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  recordWireAnomaly("cadence", raw === undefined || raw === null ? "missing" : "non-finite");
  return null;
}

// deriveStatus computes the honest FlowStatus for the map by translating the shared
// classifyFreshness result into the topology component's five-state vocabulary: the core
// "in-flight" (a healthy-pending first run) is rendered "healthy" here and the in-flight state
// is carried separately by the FlowRecord's `running` flag (the component animates it), so a
// run currently in progress over an earlier good run is still judged on that good run's age
// (loud staleness is not masked by a run in progress). The same rule runs on the dashboard
// (overview.ts summariseFleet), so the map and the dashboard agree on the same downpipe.
function deriveStatus(
  state: DownpipeState,
  ring: RunHistoryEntry[],
  haveHistory: boolean,
  now: number,
): FlowStatus {
  const latest = ring[0]; // newest-first
  const lastGood = ring.find((e) => e.status === "ok");
  const core = classifyFreshness({
    enabled: state.config.enabled,
    hasConfig: true, // the map iterates the downpipe list, so a config always backs a flow
    haveHistory,
    haveDownpipes: true,
    latestStatus: latest ? latest.status : "none",
    lastGoodAt: lastGood ? lastGood.startedAt : null,
    cadenceSeconds: cadenceSecondsOf(state.config),
    now,
    // The map makes no green claim for a never-run pipe (nothing has run): leave it "unknown".
    pendingWhenNoRuns: false,
  });
  // The map has no "in-flight" status; a healthy-pending first run reads "healthy" and the
  // `running` flag (set in mapDownpipesToFlows) conveys that a run is in progress.
  return core === "in-flight" ? "healthy" : core;
}

// latestArchiveBytes reads the archive write size for the edge thickness + the numeric label
// from the NEWEST history entry that carries a figure. Strictly history[0] is not enough: an
// in-flight newest run has written nothing yet and would blank the figure the previous run
// honestly reported. Within an entry, archiveBytesWritten (the wire-shape extension field for
// the bytes written to the archive) is preferred; the generic bytes field is the fallback
// (still a size only). Omitted entirely when no entry carries either, so the component reads
// unknown (never inflated). It is a count/size only, never a secret (no-custody).
function latestArchiveBytes(ring: RunHistoryEntry[]): number | undefined {
  for (const entry of ring) {
    if (typeof entry.archiveBytesWritten === "number" && Number.isFinite(entry.archiveBytesWritten)) {
      return entry.archiveBytesWritten;
    }
    if (typeof entry.bytes === "number" && Number.isFinite(entry.bytes)) return entry.bytes;
  }
  return undefined;
}

// sourceEndpoint maps a SourceSpec to the component's FlowEndpoint: the kind glyph + the
// human name. The name comes from the binding, then a namespaceId / bucketName override,
// then the secrets summary for the Secrets layer (which has no single binding). All strings
// are server-supplied and reach the DOM via the component's textContent path.
function sourceEndpoint(source: SourceSpec): FlowEndpoint {
  const kind = sourceKind(source.type);
  const name = sourceName(source);
  return { name, kind };
}

function sourceKind(type: SourceSpec["type"]): NodeKind {
  // G298: this switch is exhaustive over the union this console was COMPILED against, which means a source type
  // a newer engine has added returns `undefined` at runtime and the node is drawn with no kind at all. The
  // default below makes it a generic node (which is what every unmapped kind already becomes) and records that
  // the console was handed a source kind it does not know. The type id never rides: it can be operator-named.
  switch (type) {
    case "kv": return "kv";
    case "r2": return "r2";
    case "d1": return "d1";
    case "secrets": return "secrets";
    case "cf-config": return "other"; // config surfaces render as a generic node (no dedicated kind yet)
    case "workers": return "other"; // Workers scripts render as a generic node (no dedicated kind yet)
    case "stream": return "other"; // Stream videos render as a generic node (no dedicated kind yet)
    case "images": return "other"; // Images render as a generic node (no dedicated kind yet)
    case "artifacts": return "other"; // Artifact Registry renders as a generic node (no dedicated kind yet)
    default:
      recordWireAnomaly("source-kind", "unknown-enum");
      return "other";
  }
}

// sourceName names the source node. The binding is the operator's own name for the source
// and wins whenever the engine reports one (the secrets source carries its env binding too,
// so it reads like its sibling binding names, not a lowercase count). A token-authenticated
// source has no binding, so it takes a sentence-case descriptive name, never a fabricated
// UPPERCASE token that reads like a real binding. The secrets count stays as the no-binding
// fallback only.
function sourceName(source: SourceSpec): string {
  if (source.binding) return source.binding;
  switch (source.type) {
    case "secrets": {
      const n = source.secrets?.length ?? 0;
      return `${n} secret${n === 1 ? "" : "s"}`;
    }
    case "cf-config": return "Cloudflare config";
    case "workers": return "Workers";
    case "stream": return "Stream";
    case "images": return "Images";
    case "artifacts": return "Artifacts";
    case "kv": return source.namespaceId ?? "KV";
    case "r2": return source.bucketName ?? "R2";
    case "d1": return "D1";
  }
}

// destinationFor builds the SINGLE archive-destination endpoint every flow points at, from
// the engine's account-wide destination (status.destKind / destConfigured), NAMED from the
// real destination read when available (GET /admin/destination carries the redaction-safe
// bucket name - the walkthrough finding: the node said "in-account R2 archive", not the
// actual archive's name). The label is HONEST about what is known:
//   - destination read ok with a bucket: the REAL bucket name (the kind tag carries R2/S3);
//   - destKind "r2": the in-account R2 archive (the preferred, no-custody destination);
//   - destKind "s3": an S3 archive (out of the Cloudflare account; the kind is "s3");
//   - destConfigured but no destKind: a configured archive of an unnamed kind;
//   - not configured: "destination not selected" (a real state, the engine has no DEST_KIND
//     yet) rendered as a neutral "other" node, not a fake bucket;
//   - status unreachable: "destination unknown" (we could not read the engine), never a
//     fabricated destination.
// This is the ONE place the single-destination model lives; when the engine grows
// per-downpipe destinations, this becomes a per-flow lookup and nothing else changes.
function destinationFor(data: MapData): FlowEndpoint {
  if (!data.status.ok) {
    return { name: "destination (unknown)", kind: "other" };
  }
  const s = data.status.value;
  // The real name, when the engine can state it (a server string; textContent path only).
  const bucket = destinationBucket(data);
  if (s.destKind === "r2") {
    return { name: bucket ?? "in-account R2 archive", kind: "r2" };
  }
  if (s.destKind === "s3") {
    return { name: bucket ?? "S3 archive", kind: "s3" };
  }
  // GCS carries the "s3" NODE kind on purpose: NodeKind is shared with the SOURCE side, where its members
  // are Cloudflare resource types, and widening it for a destination label would ripple into source
  // filtering for a word. On the wire GCS genuinely is an S3-compatible store, so the icon and the kind
  // word are right; the NAME is what tells the operator whose cloud it is.
  if (s.destKind === "gcs") {
    return { name: bucket ?? "Google Cloud Storage archive", kind: "s3" };
  }
  // Azure carries the "s3" NODE kind for the same reason GCS does, and it is a weaker claim than it looks:
  // NodeKind is the map's glyph vocabulary, shared with the SOURCE side where its members are Cloudflare
  // resource types, so widening it for a destination label would ripple into source filtering for a word.
  // Unlike GCS, Azure is not an S3-compatible store on the wire, so "s3" here means only "an object store
  // outside the Cloudflare account"; the NAME is what tells the operator whose cloud it is.
  if (s.destKind === "azure") {
    return { name: bucket ?? "Azure Blob Storage archive", kind: "s3" };
  }
  if (s.destConfigured) {
    return { name: bucket ?? "archive destination", kind: "other" };
  }
  return { name: "destination not selected", kind: "other" };
}

// destinationBucket extracts the real archive name from the destination read, when present.
// A trimmed, non-empty bucket only; anything else is null so the caller keeps the honest
// generic label (never a fabricated name). Optional-chained: a partial MapData (an older
// fixture, or a future caller that skips the destination read) degrades to the generic label
// rather than throwing.
export function destinationBucket(data: MapData): string | null {
  if (!data.destination?.ok) return null;
  const d = data.destination.value;
  if (typeof d.bucket === "string" && d.bucket.trim() !== "") return d.bucket.trim();
  return null;
}
