// Downpipe / schedule / retention / state mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

import type { CfConfigDiscovery, SourceSpec } from "./sources.ts";

export interface Downpipe {
  id: string;
  name: string;
  cadenceSeconds: number;
  enabled: boolean;
  source: SourceSpec;
  // destinationId selects which archive destination this downpipe writes to (multi-destination).
  // ABSENT means the DEFAULT destination (so it follows whatever is default), which is the common
  // case; a specific id PINS this downpipe to that destination. Round-trips through POST
  // /admin/downpipes; the engine's validateConfig bounds the shape and addDownpipe checks it is live.
  destinationId?: string;
  // destinationIds is the FAN-OUT list (3-2-1): index 0 is the PRIMARY the run seals to, the rest are
  // REPLICAS the finalised run is copied to. SUPERSEDES destinationId when present. >=2 entries = a
  // source written to 2 places (3 copies incl. the live source). Round-trips through /admin/downpipes.
  destinationIds?: string[];
  // restoreTestCadenceSeconds: how often the engine runs a scheduled
  // restore test (a sample-verify drill, no writes) for this downpipe. 0 or absent = off; the
  // engine defaults a newly created downpipe to weekly (604800) when omitted. Editing it is gated
  // by the scheduledtest.config capability, which the upsert already covers via downpipe.write for
  // the existing roles. It is a cadence in seconds only (no value, no key); no-custody holds.
  restoreTestCadenceSeconds?: number;
  // retention (ASVS V14.2.7) is the per-downpipe archive RETENTION policy, mirrored byte-for-byte
  // from the engine's DownpipeConfig.retention (engine/src/sched/scheduler-do.ts RetentionPolicy). It
  // ROUND-TRIPS through POST /admin/downpipes unchanged: addDownpipe sends it and the engine's
  // validateConfig bounds it (at least one of keepRuns/keepDays; each a positive integer within a
  // backstop; enforce a boolean). ABSENT means keep everything (no prune), so a pre-retention config
  // is unchanged. enforce is the SAFETY GATE: absent/false is dry-run (the engine computes and LOGS the
  // prune plan but deletes nothing); ONLY enforce === true makes the engine DELETE superseded runs and
  // their now-unreferenced segments on the schedule. exactOptionalPropertyTypes: each field is present
  // only when it carries a real value. No value or key transits; these are counts and a boolean only.
  retention?: RetentionPolicy;
  // schedule is the OPTIONAL per-downpipe cron / timezone / blackout schedule, mirrored byte-for-byte
  // from the engine's DownpipeConfig.schedule (engine/src/sched/scheduler-do.ts DownpipeSchedule). It
  // ROUND-TRIPS through POST /admin/downpipes: addDownpipe sends it and the engine's validateConfig
  // bounds it (a 5-field cron, a known IANA timeZone, sane blackout windows). ABSENT means the
  // existing cadenceSeconds path (every pre-schedule config is byte-unchanged), so a plain interval
  // downpipe sends NO schedule object. When schedule.cron is present the engine schedules off the cron
  // (in schedule.timeZone, DST-correct) instead of cadenceSeconds; blackoutWindows defer a fire out of
  // a maintenance window on either path. The console mirrors the engine's validation in
  // lib/schedule.ts (validateSchedule) so a malformed schedule is rejected inline before the POST.
  schedule?: DownpipeSchedule;
}

// DownpipeSchedule mirrors the engine's DownpipeSchedule (engine/src/sched/scheduler-do.ts). It is
// purely additive: cadenceSeconds remains the default cadence; a config with no schedule is
// byte-unchanged. cron is a 5-field crontab expression (minute hour day-of-month month day-of-week);
// when present the engine schedules off it (next matching wall-clock minute in timeZone) instead of
// cadenceSeconds. timeZone is the IANA zone the cron fields AND the blackout-window minutes are
// interpreted in (optional; the engine defaults to "UTC"). blackoutWindows are maintenance windows a
// fire is deferred out of (they apply on BOTH the cron path and the cadence path). The engine
// validates the whole object at save time and rejects a malformed one. exactOptionalPropertyTypes:
// each field is present only when it carries a real value. No value or key transits.
export interface DownpipeSchedule {
  cron?: string;
  timeZone?: string;
  blackoutWindows?: BlackoutWindow[];
}

// BlackoutWindow mirrors the engine's BlackoutWindow (engine/src/sched/scheduler-do.ts). A
// maintenance window expressed in MINUTES SINCE LOCAL MIDNIGHT in the schedule's timeZone. startMinute
// is inclusive, endMinute is EXCLUSIVE, both in [0, MINUTES_PER_DAY]. A non-wrapping window
// (startMinute <= endMinute) blacks out [start, end); a wrapping window (startMinute > endMinute, e.g.
// 22:00-06:00) blacks out [start, 1440) U [0, end). The optional `days` filter (0=Sunday..6=Saturday)
// restricts the window to those weekdays; ABSENT means every day. Windows only ever PUSH a fire later.
export interface BlackoutWindow {
  days?: number[];
  startMinute: number;
  endMinute: number;
}

// SCHEDULE_MAX_BLACKOUT_WINDOWS / MINUTES_PER_DAY mirror the engine's bounds
// (engine/src/sched/scheduler-do.ts) so the console can reject an out-of-range schedule inline before
// the engine 400s. SCHEDULE_MAX_BLACKOUT_WINDOWS caps the per-downpipe window list; MINUTES_PER_DAY
// is the inclusive upper bound on a window's startMinute/endMinute (minutes since local midnight).
export const SCHEDULE_MAX_BLACKOUT_WINDOWS = 32;
export const MINUTES_PER_DAY = 1440;

// RetentionPolicy mirrors the engine's RetentionPolicy (engine/src/sched/scheduler-do.ts). keepRuns
// retains the N most-recent runs (a positive integer); keepDays retains runs within N days of now (a
// positive integer); when both are set a run is RETAINED if it satisfies EITHER (the union is kept).
// enforce is the deletion gate: it must be the literal boolean true to apply a prune; absent or false
// is dry-run (the plan is computed and reported in the engine log, nothing is deleted). The engine's
// validateConfig requires at least one of keepRuns/keepDays when retention is present and bounds each
// to 1..RETENTION_MAX (keepRuns 10000, keepDays 36500). The console mirrors that floor in
// validateRetention (lib/format.ts is not the home; the editor validates inline) before POSTing.
export interface RetentionPolicy {
  keepRuns?: number;
  keepDays?: number;
  enforce?: boolean;
}

// RETENTION_MAX_KEEP_RUNS / RETENTION_MAX_KEEP_DAYS mirror the engine's backstops
// (engine/src/sched/scheduler-do.ts) so the console can reject an out-of-range value inline before the
// engine 400s. They are bounds, not defaults: an absent retention means keep everything.
export const RETENTION_MAX_KEEP_RUNS = 10000;
export const RETENTION_MAX_KEEP_DAYS = 36500;

export interface DownpipeState {
  config: Downpipe;
  nextRunAt: number;
  lastRunId: string | null;
  inFlight: boolean;
  // Protection-statement recency fields the plain-English protection statement
  // (lib/protection-statement.ts) and the restore screen's last-proven line consume, in the
  // console's NORMALISED form (ISO strings + flat fields). These are NOT the engine's raw wire shape:
  // listDownpipes() maps the engine's nested/epoch-ms shape onto these at the boundary (see
  // EngineDownpipeState / mapEngineDownpipeState below), so a consumer never has to know the engine
  // emits restoreProven as a nested object or lastRestoreTestAt as epoch ms. Each is HONESTLY ABSENT
  // (exactOptionalPropertyTypes) until the corresponding thing has actually happened; the generator
  // renders "never proven" / "never integrity-checked" rather than a false "verified" when a field is
  // missing.
  //
  // lastIntegrityVerifiedAt is when the engine last AFFIRMATIVELY verified the integrity of this
  // downpipe's archive, and lastIntegrityVerifiedOk is the pass/fail of that last check. The engine
  // carries this as a NESTED integrityVerified { at: epoch-ms, how } record set ONLY on a PASS (a run
  // that sealed cleanly, or a passed keyless attestation / blind restore test); the boundary mapping
  // flattens it to lastIntegrityVerifiedAt (ISO string, from `at`) + a derived lastIntegrityVerifiedOk:
  // true (the engine only ever stamps a PASS, so a present stamp is always a pass). Absent until a run
  // has completed or an attestation has passed at least once; the generator says "never integrity-checked"
  // when so. These are recency + a coarse path only (no value, no key); no-custody holds.
  lastIntegrityVerifiedAt?: string;
  lastIntegrityVerifiedOk?: boolean;
  // lastRestoreTestAt / lastRestoreTestOk are the recency + outcome of the most recent SCHEDULED
  // restore test. The engine stores lastRestoreTestAt as EPOCH MS (a number); the boundary mapping
  // converts it to an ISO string here so the overdue maths (Date.parse) reads it. Absent until the
  // first scheduled test has run.
  lastRestoreTestAt?: string;
  lastRestoreTestOk?: boolean;
  // lastRestoreTestReason is the engine's CLOSED coarse cause code for the most recent scheduled
  // restore-test FAILURE (integrity / freshness / object-missing / dest-access / origin-removed /
  // not-configured / recovery-check / other), absent when the last completion was a pass or a
  // deferral. restoreTestConsecutiveFailures counts failures in a row (absent = none). The recency
  // helper names the cause in plain words; without these the screen said "investigate" with no WHY.
  lastRestoreTestReason?: string;
  restoreTestConsecutiveFailures?: number;
  // lastRestoreTestDeferred marks the most recent completion a DEFERRAL and which kind: "no-run"
  // (no completed backup existed at test time) or "posture" (break-glass-only, the engine cannot
  // self-test). A deferral is recorded ok:false on the wire (never a false pass); this field is what
  // lets the console render "could not test" instead of the false-alarm "tested and FAILED".
  lastRestoreTestDeferred?: "no-run" | "posture";
  // lastRestoreTestKind / lastRestoreTestSampleRate are the METHOD-FAITHFUL compliance fields the engine
  // now stamps alongside the restore-test recency: which path produced the last evidence ("scheduled" =
  // the engine's own sample-verify drill; "attended" = an operator-driven attended verification), and, for
  // an attended pass, the per-run record sample rate it recorded (1..100). They are what let the recency
  // read say "attended verification, N% sample" faithfully and, critically, refuse the fully-green
  // "recently tested" for a sub-100 attended sample (recoverability was only partially exercised). Both
  // absent on a state predating the stamp; the recency read treats an absent kind as the scheduled path.
  lastRestoreTestKind?: RestoreTestKind;
  lastRestoreTestSampleRate?: number;
  // lastRestoreProvenAt is when offline restorability was last PROVEN for this downpipe (a passed
  // BLIND restore test or KEYLESS attestation), and lastRestoreProvenBy is the verified identity who
  // proved it (the Access email, or a coarse actor label for the token path). The engine carries this
  // as a NESTED restoreProven { at: epoch-ms, by, method, runId } record; the boundary mapping
  // flattens it to lastRestoreProvenAt (ISO string, from `at`) + lastRestoreProvenBy (from `by`).
  // Both absent until restore has actually been proven at least once; the generator says "never
  // proven" when so. These are recency + who only (no value, no key); no-custody holds.
  lastRestoreProvenAt?: string;
  lastRestoreProvenBy?: string;
  // restoreProvenMethod is the flattened restoreProven.method (which assurance tier proved restorability
  // last). The boundary mapping used to DROP it; it is kept now so the "restorability last proven" and
  // coverage surfaces can name the method faithfully ("attended verification", "blind restore test",
  // "keyless attestation") rather than a generic claim. Absent until restore has been proven at least once.
  restoreProvenMethod?: RestoreProvenMethod;
  // cfConfigDiscovery is the cached cf-config surface-discovery result (auto-mode read-cost control):
  // which surfaces are present/empty/unavailable and when last probed. Same shape on both sides (epoch
  // ms), copied through the boundary mapping unchanged. Absent until first discovered (capture then
  // fail-safes to ALL surfaces). The detail drawer shows the counts + last-discovered time.
  cfConfigDiscovery?: CfConfigDiscovery;
  // sealedRuns / replAnchors are THE REPLICATION ANCHOR, mirrored byte-for-byte from the engine
  // (engine/src/sched/types.ts DownpipeState) and forwarded on the wire by GET /admin/downpipes
  // (scheduler-do.ts listDownpipes returns the state verbatim). They pass through the boundary mapping
  // unchanged: they are already counts.
  //
  // WHY THE CONSOLE NEEDS THEM. "This destination has no replication row" is, on its own, BOTH the state of a
  // destination added five minutes ago and the state of one that has held no copy since March. The engine's
  // pack and the bot already refuse to speak on that ambiguity: they carry the anchor and only escalate at two
  // successful backups. The console is the screen the gap actually names, and without the anchor its map edge
  // painted the escalate-flavoured "no copy" lane on a healthy configuration the moment an operator added a
  // destination to a running downpipe, and could not tell it from a leg that had been dark for months.
  //
  // sealedRuns is the downpipe's MONOTONE lifetime count of successful runs (absent on a record written before
  // the anchor shipped; read as 0). replAnchors maps each configured destination id to the value of sealedRuns
  // when that destination ENTERED the fan-out, so sealedRuns - anchor = how many backups have succeeded since
  // it was configured and still produced no copy. Counts only, keyed by the customer's own destination ids
  // (which the console already holds in cfg.destinationIds): no timestamp of a customer event, no value, no key.
  sealedRuns?: number;
  replAnchors?: Record<string, number>;
  // configRev is the downpipe's CONFIG revision as the engine keeps it, and it is what a save or a delete
  // states back as its base (see addDownpipe / deleteDownpipe in lib/api/client-downpipes.ts). The engine
  // bumps it on a config write and on NOTHING ELSE, so a backup running is not a collision: a run rewrites
  // the record constantly (heartbeats, completions, restore-test stamps) and carries the revision through
  // untouched. Stating it turns the whole-object upsert from "last writer wins, silently" into a decision.
  //
  // ABSENT on a record written before the engine's precondition shipped, and absent is NOT zero: a screen
  // that holds no revision states nothing rather than stating 0, because 0 is the revision a pre-existing
  // record READS as engine-side and stating it would refuse a save that has no collision in it. An absent
  // revision therefore leaves that one save exactly as unprotected as it was, which is honest, rather than
  // making it refuse for a reason the operator cannot act on.
  configRev?: number;
}

// RestoreProvenMethod mirrors the engine's restoreProven.method: which assurance tier set the
// "offline restorability last proven" record. "blind-test" is the keyed BLIND restore test (every
// in-scope record decrypted-and-verified to a discard sink); "keyless-attest" is the Tier 0 keyless
// integrity attestation (signature + completeness + anti-rollback, no decryption key); "attended-blind-test"
// is an ATTENDED verification pass (the offline-key-only in-platform proof, where the operator supplied the
// per-run masters through their browser). The boundary mapping now KEEPS this on the console DownpipeState
// (restoreProvenMethod) so the recency / coverage surfaces can render the method faithfully rather than a
// generic "restore test: pass"; an attended pass with a sub-100 sample must never read as fully green.
export type RestoreProvenMethod = "blind-test" | "keyless-attest" | "attended-blind-test";

// RestoreTestKind mirrors the engine's lastRestoreTestKind stamp: whether the most recent restore-test
// evidence came from a SCHEDULED sample-verify drill the engine ran on its own (operational posture) or an
// ATTENDED verification the operator drove in the browser (offline-key-only posture). Absent on a legacy
// state that predates the stamp; the recency read treats an absent kind as the scheduled path (its prior
// meaning), so older rows are byte-unchanged.
export type RestoreTestKind = "scheduled" | "attended";

// IntegrityVerifiedHow mirrors the engine's integrityVerified.how: which path affirmatively verified the
// archive integrity. "run" is a successful run completion (the seal built the per-record hashes, signed the
// manifest and appended + re-signed the RUNLOG chain); "attest" is a passed keyless attestation or blind
// restore test. Carried on the engine wire shape only; the console flattens it away (the statement does not
// yet distinguish them, only that integrity WAS verified and WHEN).
export type IntegrityVerifiedHow = "run" | "attest";

// EngineDownpipeState is the engine's OWN DownpipeState as it crosses the wire from GET
// /admin/downpipes (the scheduler DO returns its state verbatim; see
// engine/src/sched/scheduler-do.ts). It is mirrored here ONLY so listDownpipes can map it onto the
// console's DownpipeState; it is not exported and no screen consumes it directly. The three fields that
// DIFFER from the console's shape are the reason this type exists:
//   - restoreProven is a NESTED object whose `at` is EPOCH MS (the console reads a flat ISO
//     lastRestoreProvenAt + lastRestoreProvenBy);
//   - integrityVerified is a NESTED object whose `at` is EPOCH MS, set ONLY on a PASS (the console reads
//     a flat ISO lastIntegrityVerifiedAt + a derived lastIntegrityVerifiedOk:true);
//   - lastRestoreTestAt is EPOCH MS, a number (the console reads an ISO string).
// config / nextRunAt / lastRunId / inFlight / restoreTestCadenceSeconds / lastRestoreTestOk are
// identical on both sides and pass through unchanged.
// Exported so the protection-statement validator can build a fixture in the REAL engine wire shape
// and drive it through mapEngineDownpipeState, proving the boundary mapping (not a flat fixture that
// would hide the nested/epoch-ms mismatch this fixes).
export interface EngineDownpipeState {
  config: Downpipe;
  nextRunAt: number;
  lastRunId: string | null;
  inFlight: boolean;
  lastRestoreTestAt?: number; // epoch ms on the engine
  lastRestoreTestOk?: boolean;
  lastRestoreTestReason?: string; // closed coarse cause code, failures only
  restoreTestConsecutiveFailures?: number;
  lastRestoreTestDeferred?: "no-run" | "posture"; // the last completion was a deferral, not a failure
  lastRestoreTestKind?: RestoreTestKind; // scheduled (engine drill) vs attended (operator-driven), epoch-identical passthrough
  lastRestoreTestSampleRate?: number; // the attended pass's per-run record sample rate (1..100), passthrough
  restoreProven?: {
    at: number; // epoch ms the proof passed
    by: string | null; // the prover's verified email; null for the bare-token fallback
    method: RestoreProvenMethod;
    runId: string;
  };
  // integrityVerified is the engine's "archive integrity last verified" stamp, set ONLY on a PASS (a clean
  // run seal, or a passed attestation / blind test), so its presence is the affirmative proof. `at` is
  // epoch ms; `how` is the coarse path. No key, no value, no runId.
  integrityVerified?: {
    at: number; // epoch ms the integrity was last verified
    how: IntegrityVerifiedHow;
  };
  // cfConfigDiscovery passes through unchanged (same shape both sides); the mapper copies it verbatim.
  cfConfigDiscovery?: CfConfigDiscovery;
  // sealedRuns / replAnchors are the replication anchor as the engine emits it: a monotone count of
  // successful runs, and the per-destination count-at-entry map. Same shape on both sides (counts, no epoch),
  // so the mapper SANITISES them (a non-finite or negative wire value is dropped) rather than converting them.
  // See the console DownpipeState above for what they discriminate and why the map edge is wrong without them.
  sealedRuns?: number;
  replAnchors?: Record<string, number>;
  // configRev is the engine's per-downpipe CONFIG revision (engine/src/sched/downpipe-precondition.ts). It
  // is a count on both sides, so the mapper SANITISES it rather than converting it. Absent on a record
  // written before the engine's precondition shipped.
  configRev?: number;
}

// DownpipeBase is what a save or a delete STATES about the record it is changing, and it is the console
// half of the engine's precondition. Three states, and the difference between the first two matters:
//   undefined  the caller states nothing, so the engine applies the write with no base check. This is the
//              behaviour every console write had until the precondition shipped, and it is what a screen
//              that genuinely does not hold a revision must send, rather than guessing one.
//   null       "I believe this downpipe does not exist and I mean to create it", which the engine refuses
//              with `already-exists` if something is already there.
//   a number   "I read this record at revision N", which the engine refuses with `base-moved` if it has
//              since moved, naming the field another operator changed.
// It is threaded as its own argument rather than folded into the Downpipe config object, because it is a
// statement ABOUT the request and not part of the customer's configuration: the engine strips it before
// storing for exactly that reason, and a console that put it in the config would be relying on that strip.
export type DownpipeBase = number | null | undefined;

// BulkDownpipeItemResult is one item's outcome from POST /admin/downpipes/bulk, index-aligned with the
// request's downpipes array. "applied" = stored (gate off); "pending" = queued for a second approver
// (gate on; changeId names the pending change); "error" = refused with the engine's bounded reason.
export interface BulkDownpipeItemResult {
  id: string;
  status: "applied" | "pending" | "error";
  changeId?: string;
  error?: string;
}

// BulkDownpipeResponse is the whole-batch result of POST /admin/downpipes/bulk (a 200 even when items
// failed: outcomes are PER ITEM, so one bad item never voids its siblings). An OVERSIZED batch instead
// answers 400 with the cap echoed as maxBatch; the client narrows on `rebatch` (see bulkAddDownpipes).
export interface BulkDownpipeResponse {
  results: BulkDownpipeItemResult[];
  applied: number;
  pending: number;
  failed: number;
}

// BulkDownpipeSend is bulkAddDownpipes's discriminated result: the batch outcome, or the engine's
// instruction to RE-BATCH at maxBatch (an oversized request under the engine's current cap, which is
// lower while config approval is on). The caller re-slices and resends; nothing was processed.
export type BulkDownpipeSend = BulkDownpipeResponse | { rebatch: number };
