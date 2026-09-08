// Downpipe + run + licence + restore-apply domain functions for the EngineClient. Each free function takes
// the shared Transport and the SAME arguments the EngineClient method took, with the request URL, method,
// body, headers and parse/throw logic moved VERBATIM. The EngineClient method is now a thin delegator.

import type { ChangeRef } from "../change-ref.ts";
import type { Transport } from "./client-transport.ts";
import { engineFetch } from "./engine-fetch.ts";
import { mapEngineDownpipeState } from "./helpers.ts";
import type {
  BulkDownpipeResponse,
  BulkDownpipeSend,
  CapsuleResult,
  Downpipe,
  DownpipeBase,
  DownpipeState,
  DrillResult,
  EngineDownpipeState,
  LicenceStatus,
  MutationResult,
  PointInTimeRun,
  RestorePlan,
  RestoreRequest,
  RestoreResult,
  RunHistoryEntry,
  WhoAmI,
} from "./types.ts";

// RESTORE_MASTER_HEADER is the transport header the browser-recovered per-run master rides on for
// an in-console break-glass restore: base64url(32 bytes). It mirrors the engine's constant of the same name
// (engine/src/admin/router-restore.ts). The master is deliberately kept OFF the RestoreRequest body so it is
// STRUCTURALLY excluded from the JSON the engine hashes (restorePlanHash), audits, persists and returns; it
// rides a distinct header exactly the way the optional X-Downpipes-Change reference already does. The break-
// glass PRIVATE is NEVER sent anywhere; only this 32-byte master crosses, and only on this header.
const RESTORE_MASTER_HEADER = "x-downpipes-restore-master";

export async function health(t: Transport): Promise<{ ok: boolean; service?: string }> {
  const r = await engineFetch(`${t.base}/admin/health`, { credentials: "include" });
  // Route through parseJson like every other method so a non-2xx (including a CF Access
  // redirect HTML body, C2-1) is classified rather than throwing an unclassified parse error.
  return t.parseJson<{ ok: boolean; service?: string }>(r, "health");
}

export async function listDownpipes(t: Transport): Promise<DownpipeState[]> {
  const r = await engineFetch(`${t.base}/admin/downpipes`, { headers: t.headers(), credentials: "include" });
  // The engine (the scheduler DO) returns its OWN DownpipeState shape, which differs from the
  // console's on two recency fields, so the raw wire shape MUST be mapped here at the single
  // boundary every consumer flows through (protectionStatement, the fleet recency card, the
  // restore screen's last-proven line, the downpipes subtitle). Mapping at this chokepoint keeps
  // the console's DownpipeState a stable ISO-string contract and means a dropped mapping cannot
  // silently render "never" while both test suites still pass (the contract-blocker this fixes):
  //   - restoreProven is a NESTED object { at: epoch-ms, by, method, runId } on the engine, but the
  //     console reads FLAT lastRestoreProvenAt (an ISO string) + lastRestoreProvenBy. We flatten it
  //     and convert `at` (epoch ms) to an ISO string so shortDate/dateOnly/Date.parse all read it.
  //   - lastRestoreTestAt is epoch ms (a number) on the engine, but the console's overdue maths
  //     (protection-statement.ts and sources-downpipes.ts) does Date.parse(at), which yields NaN on
  //     a number, so we convert it to an ISO string too. lastRestoreTestOk passes through unchanged.
  //   - integrityVerified is a NESTED object { at: epoch-ms, how } on the engine, set ONLY on a PASS
  //     (a clean run seal, or a passed attestation / blind test), but the console reads FLAT ISO
  //     lastIntegrityVerifiedAt + a derived lastIntegrityVerifiedOk. We flatten it the same way, so the
  //     statement reads "integrity-checked" with the real date once a run has completed; an absent stamp
  //     still maps to nothing and reads "never integrity-checked" rather than a false pass.
  // No value or key is in this payload; these are recency stamps + a coarse prover/path label only.
  const wire = await t.parseJson<EngineDownpipeState[]>(r, "list downpipes");
  return wire.map(mapEngineDownpipeState);
}

// addDownpipe saves (creates or updates) a downpipe. It is a CONFIG MUTATION the change-control gate
// can defer, so it resolves to a MutationResult: { status:"applied", value } normally, or
// { status:"pending", changeId } when the gate queued it for a second approver (HTTP 202). The save
// screens narrow on result.status to show "saved" vs "queued for approval".
//
// ---- THE BASE IT STATES, AND WHY A REFUSAL IS THE POINT ----------------------------------------------
// `base` is the revision the screen READ this downpipe at, sent as `ifMatchRev` beside the config. The
// route is a WHOLE-OBJECT upsert, so before the engine's precondition existed two operators who loaded the
// same downpipe and saved different edits were BOTH answered 200, one edit was discarded with nothing said,
// and neither operator could tell. Driven live: a schedule change made inside another
// operator's open drawer was reverted by a switch flip that toasted `Enabled <name>`.
//
// A caller that states a base and loses is answered 409 with a sentence naming the field that moved, which
// parseJsonOrPending folds into the thrown error (409 is neither 401/403/429 nor 5xx, so the reason rides).
// A caller that states NOTHING is applied exactly as before: `undefined` omits the key, and the engine reads
// it with `in`, so omitted and null are two different statements and this cannot accidentally declare a
// create. That matters for the paths that genuinely hold no revision (a create from the wizard, a bulk
// import), which must not guess one.
//
// This is deliberately NOT a re-read before the write. Re-reading would narrow the window from the lifetime
// of an open screen to one round trip and would STILL overwrite silently, which is a repair that looks done.
export async function addDownpipe(t: Transport, dp: Downpipe, base?: DownpipeBase): Promise<MutationResult<DownpipeState>> {
  const body: unknown = base === undefined ? dp : { ...(dp as unknown as Record<string, unknown>), ifMatchRev: base };
  const r = await engineFetch(`${t.base}/admin/downpipes`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify(body) });
  return t.parseJsonOrPending<DownpipeState>(r, "add downpipe");
}

// bulkAddDownpipes creates MANY downpipes in one engine call (POST /admin/downpipes/bulk): the
// many-to-many create (the wizard's multi-source selection, the Sources bulk protect). Outcomes are
// PER ITEM inside a 200 (applied / pending / error, index-aligned), so one bad item never voids its
// siblings. An OVERSIZED batch is the one non-2xx handled here: the engine refuses it whole with 400 +
// { maxBatch } (the cap is lower while config approval is on), which resolves to { rebatch: maxBatch }
// so the caller re-slices deterministically instead of sniffing an error message. Every other non-2xx
// routes through parseJson's classifier (Access redirect, 401, 429 pacing) exactly like addDownpipe.
export async function bulkAddDownpipes(t: Transport, dps: Downpipe[]): Promise<BulkDownpipeSend> {
  const r = await engineFetch(`${t.base}/admin/downpipes/bulk`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ downpipes: dps }) });
  if (r.status === 400) {
    // Read a CLONE so the original body is still unread for parseJson/failResponse below when this
    // 400 is not the oversize shape (a malformed-request 400 keeps its classified throw).
    try {
      const body = (await r.clone().json()) as { maxBatch?: unknown };
      if (typeof body.maxBatch === "number" && body.maxBatch > 0) return { rebatch: body.maxBatch };
    } catch {
      // Not JSON: fall through to the classified throw.
    }
  }
  return t.parseJson<BulkDownpipeResponse>(r, "bulk add downpipes");
}

export async function trigger(t: Transport, id: string): Promise<{ runId: string; index: number; prevRunId?: string } | { skipped: string }> {
  const r = await engineFetch(`${t.base}/admin/trigger`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ id }) });
  return t.parseJsonOrReason<{ runId: string; index: number; prevRunId?: string } | { skipped: string }>(r, "trigger");
}

// deleteDownpipe is a CONFIG MUTATION the change-control gate can defer, exactly like addDownpipe:
// { status:"applied", value } normally, or { status:"pending", changeId } when the gate queued it
// (HTTP 202). The old plain parse read a queued 202 body as `{ deleted: undefined }`, so the console
// told the operator "the engine reported nothing was deleted" about a delete that was actually
// QUEUED FOR APPROVAL, and the row (honestly) stayed - which reads as an undeletable downpipe.
// `swept` counts key-id mismatch ghost rows the engine removed alongside the direct delete
// (roster-hygiene); absent in the common case.
//
// `base` states the revision the screen read, exactly as addDownpipe does, and the delete needs it for the
// OTHER half of the same collision: a delete racing a save answered {"deleted":true} while the saving
// operator's whole-object upsert recreated the downpipe, enabled and on its cadence, so the deleting
// operator was told a backup had stopped while the product went on running it. Stating the base makes the
// engine refuse the delete with `deleted-under-you` / `base-moved` instead, and `deletedRev` on the success
// says WHICH revision was removed. `null` is nonsense on a delete and the engine refuses it as unreadable
// rather than reading it as "unstated", so this never sends one.
export async function deleteDownpipe(t: Transport, id: string, base?: DownpipeBase): Promise<MutationResult<{ deleted: boolean; swept?: number; deletedRev?: number }>> {
  const body = base === undefined || base === null ? { id } : { id, ifMatchRev: base };
  const r = await engineFetch(`${t.base}/admin/downpipes/delete`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify(body) });
  return t.parseJsonOrPending<{ deleted: boolean; swept?: number; deletedRev?: number }>(r, "delete");
}

// RosterHygiene mirrors the engine's roster structural-integrity report (redaction-safe ids/keys
// only, lists bounded engine-side): ghost rows the delete route cannot reach, and well-formed rows
// that have never run (what a standing "Unknown" map edge is when the roster is sound).
export interface RosterHygiene {
  scanned: number;
  ghosts: Array<{ key: string; embeddedId: string | null; kind: string }>;
  ghostCount: number;
  neverRan: Array<{ id: string; enabled: boolean }>;
  neverRanCount: number;
}

export async function rosterHygiene(t: Transport): Promise<RosterHygiene> {
  const r = await engineFetch(`${t.base}/admin/downpipes/roster-hygiene`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<RosterHygiene>(r, "roster hygiene");
}

// reconcileRoster heals the structural ghosts (owner-grade on the engine, keys.ceremony): removes
// malformed/twinned ghost rows and rehomes twinless mismatches under their embedded id. Never-ran
// downpipes are valid configs and are never touched.
export async function reconcileRoster(t: Transport): Promise<{ removed: number; rehomed: number; ghostsRemaining: number }> {
  const r = await engineFetch(`${t.base}/admin/downpipes/reconcile-roster`, { method: "POST", headers: t.headers(), credentials: "include", body: "{}" });
  return t.parseJson<{ removed: number; rehomed: number; ghostsRemaining: number }>(r, "reconcile roster");
}

export async function drill(t: Transport, runId: string): Promise<DrillResult> {
  const r = await engineFetch(`${t.base}/admin/drill`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ runId }) });
  return t.parseJson<DrillResult>(r, "drill");
}

// restore is on the recovery path: the engine dry-runs by default (confirm omitted/false)
// and only writes verified plaintext back when confirm:true. The route always answers 200
// with ok:false for an in-flow failure so the caller renders result.reason; a non-2xx here
// is an auth/transport fault only, mirroring drill.
//
// The one non-2xx that is NOT a bare auth/transport fault is the apply's dual-control 403:
// the engine returns 403 { error: "restore not approved", planHash } when an apply lacks a
// usable approval (a distinct approver, maker != checker; engine/src/admin/router.ts POST
// /restore). That is a DIFFERENT condition from a role denial (the gate's own 403), so we read
// the JSON body and FOLD the engine's `error` into the thrown message in the
// "<verb>: <reason>: <status>" form the classifier parses (the status stays trailing so
// extractStatus still finds it, and the reason substring lets classifyError map it to
// "restore-unapproved" rather than the role-denied "forbidden"). A body we cannot read or that
// carries no `error` degrades to the plain "restore: <status>" message. No value or key is in
// this body; the engine's error payload is names/reason/planHash only (no-custody).
export async function restore(t: Transport, req: RestoreRequest, change?: ChangeRef, opts?: { restoreMasterB64?: string }): Promise<RestorePlan | RestoreResult> {
  // The OPTIONAL change reference (change management) rides as the X-Downpipes-Change header on an APPLY
  // (confirm:true is a change-controlled action); the engine records the change-recorded CR before applying.
  const headers = t.headers(change);
  // G-P0-008: the OPTIONAL browser-recovered per-run master (base64url of 32 raw bytes) rides the distinct
  // x-downpipes-restore-master transport header, NEVER a body field. It is the in-console break-glass restore's
  // key handoff: the browser decapsulated it locally from the run capsule (keydecap.ts openCapsule) with the
  // operator's break-glass private, which stays in the tab. Keeping it on a header (never merged into the JSON
  // body the engine hashes/audits/persists) makes its exclusion from the plan hash and the record STRUCTURAL.
  // Attached only when supplied; an absent value leaves the wire byte-unchanged for an ordinary operational
  // restore. The engine's decodeRestoreMaster rejects any non-32-byte value with a 400, so the caller must
  // send the 32-byte MASTER, never the 96-byte private.
  if (opts?.restoreMasterB64 !== undefined && opts.restoreMasterB64 !== "") headers[RESTORE_MASTER_HEADER] = opts.restoreMasterB64;
  // gatedFetch, NOT a bare engineFetch. This route is a sensitive write (ASVS V7.5.1) and the engine can
  // answer it 401 { stepUpRequired: true }; only gatedFetch runs the re-auth ceremony and retries with the
  // x-downpipes-stepup header. On a plain engineFetch the 401 was final.
  //
  // WHAT THAT COST, driven live rather than inferred. A maker plans and requests, a distinct approver
  // approves, and a real review takes long enough that the maker's session passes the 300-second freshness
  // window. The approval is present and the session is perfectly valid, so the apply gate arms; the apply
  // then answers 401 step-up required and stops there. The console painted "Try again, and approve the
  // passkey prompt when it appears" for a call path that could not raise one: the credential API was
  // called ZERO times across the whole apply. The only escape was outside the flow entirely,
  // and for the in-console break-glass restore it is worse, because the per-run master is decapsulated in
  // the tab and lost with it.
  //
  // 22 other sensitive writes already route this way, and retention-prune/apply (client-retention-prune.ts)
  // is the closest match: also maker-checker, also an apply, already gated. This applies that pattern.
  //
  // THE MASTER HEADER SURVIVES THE RETRY, which is the detail that matters most here. gatedFetch rebuilds
  // the retry's headers with `new Headers(init.headers)` from the SAME init, so x-downpipes-restore-master
  // rides the second attempt unchanged. A retry that dropped it would turn a step-up into a restore the
  // engine cannot open, which is a worse failure than the one being fixed.
  //
  // The dry-run plan goes through the same call and is unaffected: gatedFetch only diverges on a 401
  // carrying stepUpRequired, so a request that never needed step-up is byte-for-byte the same on the wire.
  const r = await t.gatedFetch("/admin/restore", { method: "POST", headers, credentials: "include", body: JSON.stringify(req) });
  if (!r.ok) {
    // foldableReason reads a CLONE, so the original body is still unread for failResponse below. It folds
    // the dual-control reason on any status and an ordinary validation reason on a 400/422, and returns
    // null for every OTHER 401/403/429/5xx so failResponse's closed markers survive. Folding a 403
    // unconditionally here is what made a capability gate and a CSRF-origin fault both render as "Your role
    // does not permit this action" on the apply.
    const reason = await t.foldableReason(r);
    if (reason !== null) throw new Error(`restore: ${reason}: ${r.status}`);
    // No usable dual-control reason: fall through to the shared throw path, which also recognises
    // an Access-redirect non-2xx body (C2-1) before degrading to the plain "restore: <status>".
    return t.failResponse(r, "restore");
  }
  return t.parseJson<RestorePlan | RestoreResult>(r, "restore");
}

// restoreCapsule fetches a chosen run's master capsule so the operator's browser can decap the
// run's per-run master locally (keydecap.ts openCapsule) for an in-console break-glass restore. The engine
// serves only the NON-SECRET wraps + key commitment (undecryptable without the break-glass private, which
// never leaves the browser), gated on restore.verify (the read-safe viewer floor the blind-test/attest
// routes also gate on), and signature-verifies the run's root manifest before serving. A read/verify fault is
// an honest ok:false + a coarse reason (never a 500). An auth/transport non-2xx routes through the shared
// throw path; a dual-control-style { error } reason is folded into the message exactly as restore() does. No
// key and no value are in this payload.
export async function restoreCapsule(t: Transport, runId: string): Promise<CapsuleResult> {
  const r = await engineFetch(`${t.base}/admin/restore/capsule`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ runId }) });
  if (!r.ok) {
    const reason = await t.foldableReason(r);
    if (reason !== null) throw new Error(`fetch restore capsule: ${reason}: ${r.status}`);
    return t.failResponse(r, "fetch restore capsule");
  }
  return t.parseJson<CapsuleResult>(r, "fetch restore capsule");
}

// licence is fail-open: the engine answers 200 with tier 'community' for any
// absent/invalid/expired licence, so this never gates backups or restore. The card is the
// only caller of this route; the recovery path never consults it.
export async function licence(t: Transport): Promise<LicenceStatus> {
  const r = await engineFetch(`${t.base}/admin/licence`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<LicenceStatus>(r, "licence");
}

// setLicence ACTIVATES (token) or CLEARS (null) the console-set licence token. The engine verifies a
// pasted token LIVE against the pinned vendor signer BEFORE anything is stored (a typo, the wrong
// signer, or an expired token is refused with the honest reason and never stored, verify-before-store,
// mirroring setDestination), stores it in the scheduler DO (runtime, no CLI, no redeploy, no Worker
// secret), audits who activated the licence, and returns the verified redaction-safe status. Owner-
// exclusive server-side (the engine gates with keys.ceremony). Fail-open is absolute: a licence never
// gates the data or recovery path, so this only ever changes the reported tier. The engine refusal
// carries a plain { error } reason worth surfacing verbatim (HTTP 400), so fold it into the throw exactly
// as setDestination does, so the Licence card can show it inline at the paste field.
export async function setLicence(t: Transport, token: string | null): Promise<LicenceStatus> {
  const r = await engineFetch(`${t.base}/admin/licence`, {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify({ token }),
  });
  if (!r.ok) {
    // foldableReason, not readErrorReason: the verify-before-store refusals this fold exists for are HTTP 400
    // and still ride verbatim, while a 403/401/429/5xx falls to failResponse so its closed marker reaches the
    // copy layer (the block at the foot of client-transport.ts).
    const reason = await t.foldableReason(r);
    if (reason !== null) throw new Error(`set licence: ${reason}: ${r.status}`);
    return t.failResponse(r, "set licence");
  }
  return t.parseJson<LicenceStatus>(r, "set licence");
}

// listHistory returns the bounded recent-run ring for one downpipe, newest-first. Run
// history is not a gated assurance feature, so this renders fully at tier 'community'.
// The engine returns the envelope { entries: RunHistoryEntry[] },
// an OBJECT, not a bare array; the previous `return r.json()` typed as the array left history
// broken against the real engine (.length undefined, .map not a function). Unwrap .entries
// here so the new Runs UI binds to a real array.
export async function listHistory(t: Transport, id: string): Promise<RunHistoryEntry[]> {
  const r = await engineFetch(`${t.base}/admin/history?id=${encodeURIComponent(id)}`, { headers: t.headers(), credentials: "include" });
  const body = await t.parseJson<{ entries?: RunHistoryEntry[] }>(r, "history");
  return body.entries ?? [];
}

// runsAt resolves a POINT-IN-TIME recovery target (GET /admin/runs/at?downpipe=&at=<rfc3339>), the
// latest SUCCESSFUL run of `downpipe` that completed AT-OR-BEFORE the instant `at`, read from the
// retained run-history ring (engine src/admin/router.ts GET /runs/at -> the DO runAt handler; the shape
// is engine src/admin/restore-types.ts PointInTimeRun via resolveRunAt). It is the join behind picking a
// moment on a recovery timeline: the resolved runId then flows through the existing restore path. The
// engine answers found:true with runId/completedAt/index, or an HONEST miss (found:false) carrying the
// retainedFrom/retainedTo window bounds when T precedes every retained run, so the console can state the
// recoverable window plainly rather than fabricating a run. `at` is an RFC-3339 timestamp. A malformed
// query (missing downpipe / unparseable at) is a 400 the api layer throws; a well-formed query is always
// 200 (found true or false). reports/downpipe.read tier. No-custody: a run id + a timestamp + an index
// only, never a value or a key.
export async function runsAt(t: Transport, downpipe: string, at: string): Promise<PointInTimeRun> {
  const qs = new URLSearchParams({ downpipe, at });
  const r = await engineFetch(`${t.base}/admin/runs/at?${qs.toString()}`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<PointInTimeRun>(r, "runs at");
}

// whoami returns the verified Access identity, the caller's resolved role, and the session
// expiry (engine dependency D1). It powers the session chip, the honest Access verdict
// (method "access" -> verified, "token" -> the fallback caution), the role display and the
// last-Owner UX. The console NEVER fakes a verified state: until D1 ships this call is absent
// and the shell degrades honestly (see the D-dependency map). credentials:"include" carries
// the Access cookie; the console cannot read the JWT itself.
export async function whoami(t: Transport): Promise<WhoAmI> {
  const r = await engineFetch(`${t.base}/admin/whoami`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<WhoAmI>(r, "whoami");
}

// listAllHistory: the no-id variant returns every downpipe's ring keyed by id. The console renders
// per-downpipe, so it leans on listHistory(id); this exists for completeness and a future overview.
//
// ---- THE COUNTERS BESIDE THE RINGS, AND WHY READING THEM IS THE WHOLE POINT ---------------------------
// The rings alone CANNOT separate two opposite estates. An estate whose run history has entirely rolled
// out of the bounded ring and a brand-new estate that has never run anything both answer with an empty
// byDownpipe, so the Overview printed the same sentence over both: "Nothing needs your attention yet."
// One of those estates has lost every record of its backups and one has nothing to lose.
//
// The engine has published the fact that separates them: runsRecordedTotal is derived
// from the account-global monotonic runlogCounter, which is already populated on every estate now
// running, so it answers for history that is already gone rather than only for loss observed from here.
// runsRolledOverCount is recordedTotal - retainedCount clamped at zero, and runlogCounterReset says the
// figure is a FLOOR rather than a measurement (a counter wound back below a retained index under-reports
// the loss, and saying so is the honest answer).
//
// ALL FOUR ARE OPTIONAL, and absent is not zero. An engine older than that change omits them entirely,
// and a console that read an absent counter as 0 would tell every estate on an older engine that nothing
// had rolled over, which is the defect wearing the costume of its fix.
export interface AllHistory {
  byDownpipe: Record<string, RunHistoryEntry[]>;
  runsRecordedTotal?: number;
  runsRetainedCount?: number;
  runsRolledOverCount?: number;
  runlogCounterReset?: true;
}

export async function listAllHistory(t: Transport): Promise<AllHistory> {
  const r = await engineFetch(`${t.base}/admin/history`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<AllHistory>(r, "history");
}
