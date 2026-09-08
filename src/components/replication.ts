// Replication roll-up: turn the engine's per-destination replication state (api.ts DestReplState) into
// the honest 3-2-1 redundancy signals the map shows, "N of M copies", the amber "partial" lane to a
// destination that is behind, and the "down" badge on a destination the engine cannot reach. Every value
// here is derived from PROVEN engine outcomes (a destination's holdsRunId, its last reachability), never
// inferred from staleness or the canary, so the numbers cannot over-claim. Pure; unit-tested.

import type { DestReplState } from "../api.ts";
// Sourced from the dependency-light type sibling (not the topology.ts barrel): topology-svg-nodes.ts is
// about to import destDownReasonLabel from this module (B30), and the barrel pulls in the SVG renderer
// itself. Importing the leaf type here keeps this pure, DOM-free module out of that import cycle.
import type { FlowStatus } from "./topology-types.ts";

export type Redundancy = "single" | "full" | "partial" | "none" | "pending";

// ReplAnchor is the evidence that separates a destination added five minutes ago from one that has held
// no copy for months, threaded off the engine's DownpipeState (sealedRuns + replAnchors, forwarded by GET
// /admin/downpipes). Both fields are counts: sealedRuns is the downpipe's monotone lifetime count of SUCCESSFUL
// runs; anchors maps each configured destination id to the value of sealedRuns when that destination entered the
// fan-out. sealedRuns - anchor[id] is therefore how many backups have SUCCEEDED since that destination was
// configured and still produced no copy of anything.
export interface ReplAnchor {
  sealedRuns?: number;
  anchors?: Record<string, number>;
}

// NO_COPY_SEALED_RUNS is the bar a destination's silence must clear before the console will call it a fault, and
// it is deliberately the SAME bar the pack and the bot use (engine support-sections-downpipes.ts
// neverReportedSealedRunsSince, and the bot's threshold on it). Two successful backups have completed since this
// destination joined the fan-out, and it holds neither: that is not a destination waiting for its first copy,
// that is a copy nobody is making.
//
// WHY A BAR AT ALL. The absence of a replication row is not a fault on its own. A destination an operator adds to
// a running downpipe has no row until the next backup completes, which can be a full cadence away, and the engine
// is behaving perfectly for every minute of it. Firing the escalate lane there is crying wolf at the customer who
// did nothing wrong, and a map that cries wolf devalues every true warning on it. Under the bar the lane reads
// "catching up", which for a genuinely new destination is not a hedge, it is the correct advice.
export const NO_COPY_SEALED_RUNS = 2;

// neverReportedIsProven is THE single decision the whole no-copy lane turns on, so it lives in one place and
// every consumer goes through it. Given a destination the engine has reported NOTHING about, has its silence
// gone on long enough to be a fault?
//
//   no anchor at all  -> FALSE. A record written before the anchor shipped, or an anchor the wire dropped: the
//                        age of the silence CANNOT be established, so no claim is made about it. Honest absence,
//                        never a guessed zero (the bot is held to the same silence).
//   since < 2         -> FALSE. Fewer than two backups have succeeded since it was configured. Nothing is owed
//                        yet; it is catching up.
//   since >= 2        -> TRUE. Backups have succeeded and this destination holds none of them.
export function neverReportedIsProven(destId: string, anchor: ReplAnchor | undefined): boolean {
  const a = anchor?.anchors?.[destId];
  if (typeof a !== "number" || !Number.isFinite(a) || a < 0) return false;
  const raw = anchor?.sealedRuns;
  const head = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  return Math.max(0, head - Math.floor(a)) >= NO_COPY_SEALED_RUNS;
}

export interface ReplicationSummary {
  intended: number; // destinations this downpipe should have a copy on (its fan-out width)
  copies: number; // destinations that PROVABLY hold the latest run
  downIds: string[]; // destinations whose last seal-or-mirror attempt failed (unreachable)
  // downReasons maps each down destination id to the engine's coarse per-destination down REASON (the
  // DEST_DOWN_REASONS class it sent: auth/worm-refused/throttled/timeout/network/tls/other), so a surface
  // can say WHY a destination is down (a credential to rotate vs a retention lock vs a throttling store)
  // instead of a flat "unreachable" that sends triage to the wrong side (B30). A down destination the
  // engine sent no reason for is simply absent from this map.
  downReasons: Record<string, string>;
  // G299: `pending` used to mean two DIFFERENT things and the operator could not act on either.
  //
  //   catching up   the engine HAS reported on this destination: it is reachable, its last attempt succeeded,
  //                 and it does not yet hold the latest run. This resolves itself. Wait.
  //   never reported the engine has said NOTHING about this destination, ever. It is not behind; it is not in
  //                 the replication map at all. A destination that has been configured for a month and has never
  //                 produced a replication row is not catching up, it is not being replicated to, and it will
  //                 stay amber for as long as anyone looks at it. Escalate.
  //
  // Folding them together is why "one destination has shown amber catching up for weeks" is a real ticket: the
  // console kept telling the operator to wait for a copy that was never being made.
  //
  // THE ANCHOR SPLITS "never reported" AGAIN, and it has to. Row absence alone is the state of a destination
  // added five minutes ago AND of one dark since March, so "escalate" was being said to both. A never-reported
  // destination under the bar (NO_COPY_SEALED_RUNS, or one whose age cannot be established at all) is counted in
  // pendingIds: it is genuinely catching up, and "wait" IS the right advice for it. Only a destination the
  // anchor PROVES has stayed empty across at least two successful backups lands in neverReportedIds.
  pendingIds: string[]; // reachable and still catching up: reported-and-behind, plus a never-reported destination too young to judge
  neverReportedIds: string[]; // PROVEN empty: no replication row, and >=2 backups have succeeded since it joined the fan-out
  redundancy: Redundancy;
}

// summariseReplication rolls one downpipe's per-destination state into its redundancy posture. latestRunId
// is the run "caught up" is measured against (the downpipe's last successful run); a destination holds a
// copy when its proven holdsRunId equals it. "single" = a one-destination downpipe (no redundancy concept);
// "pending" = a fan-out downpipe with no successful run yet (nothing to replicate, so not a shortfall).
export function summariseReplication(
  destinationIds: string[],
  repl: Record<string, DestReplState> | undefined,
  latestRunId: string | null,
  anchor?: ReplAnchor,
): ReplicationSummary {
  const intended = destinationIds.length;
  if (intended <= 1) return { intended, copies: intended, downIds: [], downReasons: {}, pendingIds: [], neverReportedIds: [], redundancy: "single" };

  const downIds: string[] = [];
  const downReasons: Record<string, string> = {};
  const pendingIds: string[] = [];
  const neverReportedIds: string[] = [];
  let copies = 0;
  for (const id of destinationIds) {
    const st = repl?.[id];
    const holdsLatest = !!st && !!latestRunId && st.holdsRunId === latestRunId;
    if (holdsLatest) copies++;
    if (st && !st.lastOk) {
      downIds.push(id); // last attempt failed: unreachable
      if (typeof st.reason === "string" && st.reason.length > 0) downReasons[id] = st.reason; // WHY it is down (B30)
    }
    // G299: a destination the engine has never reported on, whose silence the ANCHOR proves has outlasted at
    // least two successful backups, is not "catching up". Nothing is catching up: there is no replication row
    // for it anywhere, which means no copy is being made. It used to be folded in with the reachable-but-behind
    // destinations and it stayed amber indefinitely, so the operator waited instead of escalating.
    //
    // The anchor is what makes that claim safe to make. Without it, this same branch fired on a destination the
    // operator added minutes ago (no backup has completed yet, so of course there is no row), which is the
    // healthiest configuration in the product. Under the bar the destination falls through to pendingIds and
    // reads "catching up", which is exactly what it is doing.
    else if (st === undefined) (neverReportedIsProven(id, anchor) ? neverReportedIds : pendingIds).push(id);
    else if (!holdsLatest) pendingIds.push(id); // reported, reachable, not caught up yet
  }
  const redundancy: Redundancy = !latestRunId ? "pending" : copies >= intended ? "full" : copies > 0 ? "partial" : "none";
  return { intended, copies, downIds, downReasons, pendingIds, neverReportedIds, redundancy };
}

// destDownReasonLabel maps the engine's closed per-destination down reason (DEST_DOWN_REASONS in
// engine/src/dest/classify.ts) to an operator label, so a down destination reads WHY it is down (each
// reason needs a different action) rather than a flat "unreachable" (B30). It returns null for the generic
// classes ("other", or an unrecognised newer-engine class, or an absent reason) where the bare "down"
// already says all that can be honestly said - never a guessed cause.
export function destDownReasonLabel(reason: string | undefined): string | null {
  switch (reason) {
    case "auth": return "credential rejected";
    case "worm-refused": return "retention lock refused the write";
    case "throttled": return "the store is rate-limiting";
    case "timeout": return "the request timed out";
    case "tls": return "TLS or certificate failure";
    case "network": return "network failure";
    default: return null; // "other", absent, or an unrecognised class
  }
}

// distinctDownReasonLabels returns the DISTINCT operator labels among a summary's down destinations (order
// stable by first appearance), so a surface can name the actionable reasons ("2 down: credential rejected;
// retention lock refused the write") without listing every destination. Generic/absent reasons contribute
// nothing (they are already conveyed by "down"), so an empty result means "no specific reason to add".
export function distinctDownReasonLabels(summary: ReplicationSummary): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of summary.downIds) {
    const label = destDownReasonLabel(summary.downReasons[id]);
    if (label !== null && !seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}

// destinationLaneStatus is the per-EDGE status under failover: the status of ONE destination's copy of a
// downpipe, layered over the downpipe's own capture status. Capture-level states (failed / disabled /
// unknown) apply to every lane unchanged, the data itself is not safe or not measured, so no single
// destination can read greener than the run. For a CAPTURED downpipe (healthy / stale): a destination that
// is unreachable reads "failed" on its own lane; one that is reachable but does not yet hold the latest run
// reads "partial" (amber: the data IS safe elsewhere, this copy is catching up); one that holds the latest
// run reads the downpipe's own status (as fresh as the run). A downpipe with no run yet keeps its status on
// every lane (no redundancy overlay before there is anything to replicate).
export function destinationLaneStatus(
  downpipeStatus: FlowStatus,
  destId: string,
  repl: Record<string, DestReplState> | undefined,
  latestRunId: string | null,
  anchor?: ReplAnchor,
): FlowStatus {
  if (downpipeStatus === "failed" || downpipeStatus === "disabled" || downpipeStatus === "unknown") return downpipeStatus;
  const st = repl?.[destId];
  if (st && !st.lastOk) return "failed"; // this destination is unreachable, regardless of runs
  if (!latestRunId) return downpipeStatus; // nothing captured yet: no redundancy overlay
  // G299: THE LANE ON THE MAP EDGE THE CUSTOMER IS RINGING ABOUT, AND THE ONE THAT CRIED WOLF.
  //
  // `!st` (no replication row at all) once fell into the same amber "partial" category as a destination
  // whose holdsRunId is merely behind latestRunId, so a destination that had held no copy of any
  // backup since the day it was configured painted exactly like one that would catch up on the next pass. Only
  // the drawer's detail line told them apart, and nobody opens a drawer on a lane that says it is catching up.
  //
  // Splitting them fixed that and broke something worse. Row absence ALONE is not evidence of a fault: a
  // destination an operator adds to a running downpipe has no replication row until the next backup completes,
  // which is up to a full cadence away, and the engine is behaving correctly for every minute of it. Painting
  // "no copy" there put the second-worst status in the whole fleet (panels.ts STATUS_RANK: worse than stale,
  // worse than partial) on a perfectly healthy configuration, and a map that cries wolf devalues every true
  // warning it shows.
  //
  // The ANCHOR is the missing evidence, and it is the SAME anchor the pack and the bot already gate on: how many
  // backups have SUCCEEDED since this destination entered the fan-out and still produced no copy. Under two, the
  // lane stays "partial" (catching up), which for a new destination is the correct advice, not a hedge. At two
  // or more, the silence has outlasted backups that did complete, and "no copy" is the honest word. A destination
  // whose anchor the engine does not hold (a legacy record) keeps the milder lane: its age cannot be established,
  // so no claim is made about it.
  if (!st) return neverReportedIsProven(destId, anchor) ? "no-copy" : "partial";
  if (st.holdsRunId !== latestRunId) return "partial"; // reported and reachable, catching up
  return downpipeStatus; // holds the latest run
}

// downDestinationIds aggregates every destination that ANY downpipe currently cannot reach, for the map's
// destination-node "down" badge (a destination shared by several downpipes is down the moment one of them
// reports it unreachable, so the badge never under-reports an outage).
export function downDestinationIds(replByDownpipe: Record<string, Record<string, DestReplState>>): Set<string> {
  const down = new Set<string>();
  for (const repl of Object.values(replByDownpipe)) {
    for (const [id, st] of Object.entries(repl)) if (st && !st.lastOk) down.add(id);
  }
  return down;
}
