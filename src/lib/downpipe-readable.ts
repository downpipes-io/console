// Can this console read this downpipe's configuration at all? ONE decision, in ONE leaf, for every
// surface that walks the downpipe list.
//
// WHY THIS EXISTS, and it is a measurement rather than a worry. The engine's own roster-hygiene module
// (engine/src/sched/roster-hygiene.ts) names the class in its own words: "MALFORMED: dp:X holds a value
// with no readable string config.id at all", and it states that the list returns such rows. The list route
// does exactly that: engine listDownpipes returns every dp: value verbatim with no validation, and the
// console's single mapping boundary (lib/api/helpers.ts mapEngineDownpipeState) passes `config` straight
// through, because its job is the recency-field contract, not shape validation. So a roster ghost, a
// partial storage write, or an engine of a version this console does not know can hand the browser a row
// with no source, no type, or no config object at all.
//
// WHAT IT COST BEFORE THIS EXISTED. Driven on the SERVED bundle in a real Chromium: three well-formed
// downpipes plus ONE malformed row, and the Overview never left its first-load skeleton. Not a degraded
// tile: 2,632 characters of body text and nine stat tiles became 559 characters and none, because the
// throw escaped an async load with no catch. The screen the operator lands on to find out something is
// wrong is the screen that disappears when something is wrong, and it takes the other nine tiles with it,
// including the ones that would have named the fault.
//
// THE RULE THIS ENCODES. An unreadable row is neither covered nor uncovered: it is a row we cannot speak
// for. It is NEVER silently dropped (a downpipe that vanishes from the fleet count is the same defect
// wearing better clothes) and it is NEVER folded into a posture, because "not backed up" is a claim about
// a downpipe whose config we could not read and may well be false. It is named, counted separately, and
// hued neutral, which is this product's honest could-not-tell.
//
// PURE + presentation-free: it reads the state, records the contract break, and returns a verdict. No
// value, no key, no name and no wire string ever leaves here; the fault is a closed vocabulary member.
// Australian English, no em dashes, precise claims.

import type { Downpipe, DownpipeState } from "../api.ts";
import { recordContractSkew } from "./client-diag/ring.ts";

// DownpipeReadFault is WHY the row could not be read, as a closed set. It is deliberately not the wire
// value and not the field name: a malformed roster row is exactly the payload that is not to be trusted.
// The three members are the three shapes measured against the served bundle, each of which threw at a
// different line, so a support engineer can tell them apart:
//   config-absent       the state carried no config object at all (a partial storage write)
//   source-absent       a config with no source (the row names a downpipe but nothing to back up)
//   source-type-absent  a source with no readable type word (the source-naming floor threw on it)
export type DownpipeReadFault = "config-absent" | "source-absent" | "source-type-absent";

// The source types this console build can name. Kept as a SET rather than a switch so an unknown-but-
// present type is not a read fault: it is a readable row this build simply has no word for, which is
// version skew and a different ticket. sourceTypeLabel is what renders it, and it is guarded there.
const KNOWN_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "kv", "r2", "secrets", "d1", "cf-config", "workers", "stream", "images", "artifacts",
]);

// ReadDownpipe is the verdict. `readable: true` narrows `config` to a real Downpipe, so every caller that
// takes the true arm keeps the full type it had before this guard existed and NOTHING on the healthy path
// changes shape.
export type ReadDownpipe =
  | { readable: true; config: Downpipe }
  | { readable: false; fault: DownpipeReadFault };

// readDownpipe is the one decision. It is the ONLY place that judges whether a downpipe row can be spoken
// for, so the Overview's protection lead, the fleet roll-up and the downpipes table cannot disagree about
// which rows they can read (the lesson of the versionSkew repair that landed in one file and left the
// screen the operator lands on still broken).
//
// It RECORDS the break as a contract skew, because silence here is its own defect: an unreadable row and a
// row that simply does not exist would otherwise be identical in the support pack, and the remedy differs
// completely (a roster heal versus nothing at all). The family is `downpipe-config`, distinct from
// `downpipe-list`: the list settling ok with no array is an engine-console contract break on the whole
// read, while this is ONE row inside a perfectly good list, and it is healed by the roster clean-up on the
// Map rather than by retrying the call.
export function readDownpipe(state: DownpipeState): ReadDownpipe {
  // The state itself is untrusted: the declared type is what the contract promises, not what arrived.
  const cfg: unknown = (state as { config?: unknown } | null | undefined)?.config;
  if (typeof cfg !== "object" || cfg === null) {
    recordContractSkew("missing-field", "downpipe-config");
    return { readable: false, fault: "config-absent" };
  }
  const source: unknown = (cfg as { source?: unknown }).source;
  if (typeof source !== "object" || source === null) {
    recordContractSkew("missing-field", "downpipe-config");
    return { readable: false, fault: "source-absent" };
  }
  const type: unknown = (source as { type?: unknown }).type;
  if (typeof type !== "string" || type === "") {
    recordContractSkew("missing-field", "downpipe-config");
    return { readable: false, fault: "source-type-absent" };
  }
  // A PRESENT type this build does not know is readable, not a fault: it names a source we can still count,
  // schedule against and speak for. It is recorded as version skew rather than corruption, and
  // sourceTypeLabel renders it honestly rather than as an empty parenthetical.
  if (!KNOWN_SOURCE_TYPES.has(type)) recordContractSkew("unknown-enum-member", "downpipe-config");
  return { readable: true, config: cfg as Downpipe };
}

// readDownpipeId is the same decision for the ONE field the fleet roll-up indexes by. It is separate
// because the fleet table needs an id before it needs a source, and a row with a readable id and an
// unreadable source is still a row the table can place: it names the downpipe and says what it could not
// read about it, which is strictly more than dropping it. Returns null when the id itself is unreadable,
// and the caller then keys the row on its position rather than losing it.
export function readDownpipeId(state: DownpipeState): string | null {
  const cfg: unknown = (state as { config?: unknown } | null | undefined)?.config;
  if (typeof cfg !== "object" || cfg === null) return null;
  const id: unknown = (cfg as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : null;
}

// downpipeFaultClause is the operator's words for a fault, used in the per-downpipe sentence and in the
// fleet not-covered line so the two cannot drift. It names what could not be read and what to do, and it
// is careful NOT to assert that the downpipe is unprotected: the console could not read the row, which is
// not evidence about the backup. The remedy is real and reachable: the Map screen's drawer runs the
// engine's roster-hygiene report and offers the owner-grade clean-up for orphaned roster records.
export function downpipeFaultClause(fault: DownpipeReadFault): string {
  switch (fault) {
    case "config-absent":
      return "the engine returned a downpipe with no configuration at all";
    case "source-absent":
      return "the engine returned a downpipe whose configuration names no source";
    case "source-type-absent":
      return "the engine returned a downpipe whose source has no readable type";
  }
}

// DOWNPIPE_FAULT_REMEDY is the one shared remedy line. It states the honest limit of the claim first (this
// is not a finding about the backup) and then the route that can actually resolve it.
export const DOWNPIPE_FAULT_REMEDY =
  "This is not a claim that the downpipe is unprotected: the console could not read the record, so it can say nothing either way. Open the Map and use the roster check to name and clean up orphaned roster records.";
