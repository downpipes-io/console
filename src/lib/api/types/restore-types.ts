// Restore request / plan / result / blind-test mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

// RestoreRequest, RestoreApprovalRequest, RestorePlan, RestoreResult, BlindRestoreTest and
// KeylessAttestationResult are copied byte-for-byte from the engine admin types so the two
// sides cannot drift. See the engine contract for the authoritative shapes. (LicenceStatus
// and RunHistoryEntry moved to status.ts in the type-file split.)

export interface RestoreRequest {
  runId: string;
  confirm?: boolean;
  target?: { binding?: string; namespaceId?: string; bucketName?: string };
  include?: string[];
  exclude?: string[];
  maxRecords?: number;
  // recordName (GRANULAR single-record restore) mirrors the engine's RestoreRequest.recordName
  // (engine src/admin/restore-types.ts). When set, the engine plans + applies EXACTLY the one record whose
  // source name equals recordName (an EXACT match, never a prefix), reporting every other record in the run
  // as "not the selected record". It composes with the SAME dry-run-default + dual-control-to-apply safety
  // as a full restore; it only ever NARROWS the scope to one record. When recordName is set the engine
  // ignores include/exclude (recordName is the more specific intent). It is bound into the plan hash, so a
  // single-record apply carries its OWN distinct approval (never reusing a whole-run approval). The console
  // passes the record's source name from the dry-run plan's sample, or one the operator typed. A name is a
  // redaction-safe source name (the customer's own key), never a value (no-custody).
  recordName?: string;
  // cfConfig mirrors the engine's RestoreRequest.cfConfig (engine src/admin/restore-types.ts): the
  // in-console Cloudflare-config restore context. token is an EDIT-scoped Cloudflare API token (for an
  // apply) or a READ token (to compute the dry-run diff); accountId + optional zoneId name the snapshot's
  // account/zone (the console knows them from the downpipe source). The token is NEVER stored and NEVER
  // bound into the plan hash (only the account/zone are). Only idempotent surfaces re-apply; absent leaves
  // cf-config records out of band exactly as before.
  // confirmDifferentAccountId mirrors the engine's CROSS-ACCOUNT confirmation: when accountId is
  // a DIFFERENT account than the one the archive was captured from (or the origin is unrecorded), the engine
  // refuses the cf-config apply unless this echoes accountId exactly. The console sets it only after the
  // operator passes the cross-account type-to-confirm. Not a secret; not bound into the plan hash.
  // confirmDifferentZoneId is the ZONE twin of confirmDifferentAccountId. The engine refuses a
  // cf-config apply that would write zone-scoped surfaces into a zone that is provably not the archive's
  // origin, unless the caller echoes the exact target zone id.
  cfConfig?: { token: string; accountId: string; zoneId?: string; confirmDifferentAccountId?: string; confirmDifferentZoneId?: string };
  // mediaRestore mirrors the engine's RestoreRequest.mediaRestore: the in-account media re-upload context.
  // token is an EDIT-scoped Cloudflare API token; accountId names the account. With it + confirm, captured
  // image/video bytes re-upload (images keep their id; a video gets a new uid). The token is NEVER stored or
  // bound into the plan hash (only accountId is). Absent leaves media records out of band as before.
  // confirmDifferentAccountId mirrors the engine's CROSS-ACCOUNT confirmation, the media twin of
  // the cfConfig field above: a different (or unrecorded-origin) target account is refused unless this echoes
  // accountId exactly. Set only after the operator passes the cross-account type-to-confirm.
  mediaRestore?: { token: string; accountId: string; confirmDifferentAccountId?: string };
  // d1Tables mirrors the engine's RestoreRequest.d1Tables: the D1 TABLE-SUBSET scope. database + the chosen
  // table names restore the header (which creates every table) + schema + only those tables' rows into a
  // FRESH database; createOnly:true instead creates ONLY the selected tables (a minimal extract). It is
  // bound into the plan hash, supersedes include/exclude for that database, and is mutually exclusive with
  // recordName.
  d1Tables?: { database: string; tables: string[]; createOnly?: boolean };
}

// CapsuleResult mirrors the engine's restore-types.ts CapsuleResult byte-for-byte: the
// response of POST /admin/restore/capsule. It is the NON-SECRET material the operator's browser needs to
// recover a chosen run's per-run master locally (keydecap.ts openCapsule) for an in-console break-glass
// restore. masterCapsule is the run's master-capsule wraps (each a recipient fingerprint + a hybrid KEM
// ciphertext + a STREAM-sealed 32-byte master; the SAME shape as keydecap.ts CapsuleWrap) and keyCommitment
// is the DEM aad (hex). NEITHER is decryptable without the break-glass PRIVATE, which never leaves the
// browser, so the payload carries NO key and NO plaintext: it is safe to serve to the authenticated owner
// (the capsule already sits encrypted in the customer's own destination bucket, and the engine
// signature-verifies the run's root manifest before serving). recordCount is the run's declared record count
// (so the browser can estimate the work). On a run that could not be read or whose manifest did not verify it
// is ok:false + a coarse, secret-free reason, with the capsule fields absent (never a 500).
export interface CapsuleResult {
  ok: boolean;
  runId: string;
  masterCapsule?: Array<{ fingerprint: string; kemCiphertext: string; sealed: string }>;
  keyCommitment?: string;
  recordCount?: number;
  reason?: string;
}

// RestoreApprovalRequest is the typed body of a restore-approval request (POST
// /admin/restore/request, raised by requestRestore). It is the dual-control sibling of
// RestoreRequest: the same selectors plus the maker-side blast-radius cues the approver inbox
// shows, but NEVER the Cloudflare token (a secret must not transit or bind into the plan hash).
//
// The blast-radius cues (isLatest / plannedWrites / bytes) are part of the request body, NOT a
// smuggled extra: the engine READS them from the body (engine/src/admin/router.ts
// reqBody.isLatest / plannedWrites / bytes) and cross-checks each against the value it
// RECOMPUTES server-side from the plan, rejecting on any mismatch (ENG-H3). They are typed here
// so the restore screen passes the dry-run plan's REAL figures and a future refactor cannot
// silently drop them (which would make the approver inbox show fabricated zeros or a false
// non-latest flag). Each is optional and exactOptionalPropertyTypes-friendly: a cue is attached
// only when it carries a real value. They are counts and a boolean only (no value, no key).
//
// recordName and cfConfig are ALSO part of the request body and bind into the plan hash (the
// engine recomputes the hash from these at /restore/request and the apply gate). They MUST be
// sent or the dual-control approval the engine mints will carry a planHash that never matches
// the requester's mirror (a granular single-record or a cf-config restore would then be
// approvable in name only and the gate would stick permanently). recordName is the granular
// single-record selector; cfConfig is the Cloudflare-config apply target as account + optional
// zone ONLY. The Cloudflare token is NEVER sent here and NEVER enters the hash: this shape
// carries only accountId/zoneId, matching the engine's redaction-safe binding (no-custody).
export interface RestoreApprovalRequest {
  runId: string;
  target?: { binding?: string; namespaceId?: string; bucketName?: string };
  include?: string[];
  exclude?: string[];
  maxRecords?: number;
  recordName?: string;
  cfConfig?: { accountId: string; zoneId?: string };
  // mediaRestore MUST be sent on the approval request for the same reason as cfConfig: it binds the
  // media re-upload ACCOUNT into the plan hash, so an approval minted without it would never match the
  // hash the requester's screen showed (the gate would stick permanently). Account only, mirroring
  // cfConfig's shape: the media edit token is NEVER sent here and NEVER enters the hash.
  mediaRestore?: { accountId: string };
  // d1Tables MUST be sent on the approval request (like recordName/cfConfig): it binds into the plan hash,
  // so the dual-control approval the engine mints would carry a planHash that never matches the apply if it
  // were omitted (the gate would stick permanently). It is the table-subset scope (createOnly included).
  d1Tables?: { database: string; tables: string[]; createOnly?: boolean };
  reason: string;
  isLatest?: boolean;
  plannedWrites?: number;
  bytes?: number;
}

// RestoreSampleItem mirrors the engine's RestoreSampleItem (engine/src/admin/restore-types.ts):
// sourceType is the engine's full RestoreSinkType union. cf-config and workers records normally
// route to configPlan / outOfBand rather than the sample, but mirroring the union keeps the console
// type in lockstep so a future engine change that routes one into the sample cannot truncate silently.
export interface RestoreSampleItem {
  name: string;
  sourceType: "kv" | "r2" | "secrets" | "d1" | "cf-config" | "workers";
  binding: string;
  namespace?: string;
  bucket?: string;
  plaintextSize: number;
}

// D1DependencyWarning mirrors the engine's D1DependencyWarning (engine/src/admin/restore-types.ts): a
// SELECTED D1 child table whose foreign-key parent is present in the backup but NOT in the restore scope,
// so the child's references would dangle. Advisory only (a D1 restore runs with FK enforcement off); the
// restore screen shows it so the operator can widen the selection before confirming. database is the D1
// database, table the selected child, missingParent the unselected parent.
export interface D1DependencyWarning {
  database: string;
  table: string;
  missingParent: string;
}

// CrossAccountWarning mirrors the engine's CrossAccountWarning (engine src/admin/restore-types.ts): a
// cf-config or media restore LEG whose target Cloudflare account is NOT provably the account the archive was
// captured from, so an apply would write into a DIFFERENT (or unverifiable) account. The restore screen shows
// it and drives the type-to-confirm the engine's apply requires. originAccount is the archive's signed origin
// (null when the archive recorded none, an unverifiable origin); targetAccount is where an apply WOULD write.
export interface CrossAccountWarning {
  leg: "cf-config" | "media";
  originAccount: string | null;
  targetAccount: string;
}

// CrossZoneWarning is the zone twin. zoneSurfaces names the zone-scoped surfaces that would be written,
// rather than counting them, so the operator sees the blast radius.
export interface CrossZoneWarning {
  originZone: string | null;
  targetZone: string;
  zoneSurfaces: string[];
}

export interface RestorePlan {
  // The engine reports the plan's own windowing, and the console had never declared it, so the plan screen
  // derived what it needed and the engine's answer was discarded. Declared so the two cannot disagree.
  outOfWindow?: number;
  windowed?: boolean;
  complete?: boolean;
  ok: boolean;
  runId: string;
  mode: "dry-run";
  recordsVerified: number;
  isLatest: boolean;
  plannedWrites: number;
  bytes: number;
  sample: RestoreSampleItem[];
  // plannedAt / applyDeadline mirror the engine (engine/src/admin/restore-types.ts RestorePlan): the instant
  // this plan was computed, and the last instant an apply of an approval anchored to it may still be
  // writing (plannedAt + the engine's RESTORE_APPLY_DEADLINE_MS -- the approval's own TTL plus the
  // reservation lease an apply holds while it writes). fidelityWarnings above is computed against
  // applyDeadline, not plannedAt, so what the plan warns about already covers every instant the approval
  // permits an apply to land.
  //
  // Both are RFC-3339 UTC millis, present on every plan that actually previewed the run and absent only on
  // the refusal stubs that preview nothing (a reserved binding, a break-glass posture with no read-back
  // key, an out-of-scope request): those write nothing, so a deadline for them would be a fact about no
  // apply. Declared here because an engine field the console does not declare is one it silently discards
  // at the type boundary -- the exact shape that dropped mediaFaults/d1Fault/d1SchemaObjectsFiltered/
  // metadataFieldsDropped before those were caught (test/validate-engine-field-coverage.ts).
  //
  // applyDeadline is rendered (planFigures in restore-flow/plan.ts), labelled and captioned as the
  // WRITE-COMPLETION bound it actually is, not as a refusal boundary: the engine refuses a fresh apply
  // reservation earlier, when the approval itself expires (anchor + APPROVAL_TTL_MS), up to
  // RESTORE_APPLY_LEASE_MS (30 minutes today) before applyDeadline. The plan does not carry that earlier
  // instant, and the console does not re-derive it from RESTORE_APPLY_LEASE_MS client-side, which would
  // duplicate an engine constant here and drift the moment it changes there. plannedAt is declared but not
  // given its own tile: on a freshly computed plan it always reads "just now" and would be pure noise
  // beside the deadline that already anchors to it, the same declared-not-rendered choice already made for
  // outOfWindow/windowed/complete above.
  plannedAt?: string;
  applyDeadline?: string;
  skipped: Array<{ name: string; reason: string }>;
  // configChanges (cf-config dry-run) mirrors the engine: the per-surface diff preview for Cloudflare-config
  // records an apply WOULD write back (idempotent surfaces only), present only when a cfConfig context was
  // supplied. Each is a surface id + a human diff summary + whether it would apply any change.
  configChanges?: Array<{ surface: string; summary: string; willApply: boolean }>;
  // cfConfigSurfaces (F10) mirrors the engine: the RESOLVED cf-config surface allow-list the plan was
  // computed against, in the sorted form the engine's plan hash binds. Present only when a cfConfig context
  // was supplied. renderPlan feeds it back into the client-side hash mirror so the hash shown to the
  // operator matches the one an approval binds to; without it the mirror bound account + zone only and the
  // two silently disagreed for every cf-config restore.
  cfConfigSurfaces?: string[];
  // mediaPlanned (media dry-run) mirrors the engine: the captured media files an apply WOULD re-upload
  // (images to their original id, videos as new uids), present only when a mediaRestore context was supplied.
  mediaPlanned?: Array<{ name: string; type: "images" | "stream" }>;
  // dependencyWarnings mirrors the engine: read-only advisories that a SELECTED D1 child table's foreign-key
  // parent is in the backup but NOT in the restore scope. Present only when at least one is detected.
  dependencyWarnings?: D1DependencyWarning[];
  // fidelityWarnings mirrors the engine: records an apply WOULD write, but not at full fidelity, known from
  // the signed manifest before anything is written. Present only when at least one applies. It is NOT a
  // skipped record and must never be rendered as one: these records land in the account, they just land
  // missing a stored field the engine could not reproduce. Today the one case is Workers KV keys whose
  // captured expiration has already passed, sent as a single "(kv expirations)" row carrying the count.
  //
  // It is declared here because an engine field the console does not declare is an engine field the console
  // silently discards, which is how the same evidence about a reduced-fidelity restore was thrown away on
  // the receipt screen until metadataFieldsDropped was picked up. Absent must read as "nothing to warn
  // about", never as "checked and fine": an older engine does not send it.
  fidelityWarnings?: Array<{ name: string; reason: string }>;
  // crossAccountWarnings mirrors the engine: the cf-config / media legs whose target account
  // is not provably the archive's origin account, so an apply would write into a DIFFERENT (or unverifiable)
  // Cloudflare account. Present only when at least one leg is cross-account; the screen renders it and drives
  // the type-to-confirm the apply requires. Absent on the common same-account restore.
  crossAccountWarnings?: CrossAccountWarning[];
  // crossZoneWarning mirrors the engine's zone guard. The account guard above does not cover the
  // mistake that is easier to make: the right account and the WRONG ZONE. Optional because an older engine
  // does not send it, and absent must read as "no warning", never as "checked and fine".
  crossZoneWarning?: CrossZoneWarning;
  reason?: string;
  // planHash is the dual-control binding key: "sha384:" over the request's
  // decision-relevant fields. It is OPTIONAL here because the engine's dry-run route
  // (engine/src/admin/restore.ts runRestore) does NOT return it in the plan body today; the engine
  // recomputes it server-side from the request alone at /restore/request and the apply gate
  // (engine/src/admin/approvals.ts restorePlanHash). The console derives the SAME value client-side
  // via restorePlanHash(req) below (byte-for-byte: request-only binding, the same canonical JSON and
  // SHA-384), so the restore screen can show the operator the exact hash an approval binds to and
  // re-arm when a changed request yields a new hash. If a future engine adds the field to the dry-run
  // response, this carries it directly; until then the screen computes it. It is redaction-safe (over
  // names, counts and selectors only, never a value or a key).
  planHash?: string;
  // destFallback: present ONLY when the 3-2-1 walk had to fall past at least one destination to produce
  // this plan; a first-choice read carries no field at all. See RestoreDestFallback.
  destFallback?: RestoreDestFallback;
}

// RestoreDestRefusal mirrors the engine (src/admin/restore-types.ts) WHOLE: one destination the 3-2-1 walk
// tried and did not get an answer from. destinationId is the run's own identifier for the customer's own
// bucket, never a credential, an endpoint or a region, and it is absent when the run recorded no
// destination and the read went to the engine default. `reason` is always one of the engine's REASON_*
// literals, at most enriched with the shape-gated S3 detail, so nothing a destination said rides here.
export interface RestoreDestRefusal {
  destinationId?: string;
  reason: string;
}

// RestoreDestFallback is the record of a restore-class operation NOT served by its first-choice
// destination. Mirrored whole, both fields and the optionality, because the absence IS the signal: a
// first-choice restore carries no field, so a fallback is distinguishable by absence rather than by a
// boolean nobody reads.
//
//   servedAt: the 1-based position in the walk of the destination this result came from. It is NEVER 1,
//     because a first-choice result carries no RestoreDestFallback at all.
//   servedDestinationId: which destination the result came from. Absent only when the walk ended on the
//     default.
//   refused: every destination tried before it, IN WALK ORDER, each with its own reason. The order is the
//     diagnosis, and a single "fell back" line would have said none of it.
//
// WHAT A SCREEN RENDERING THIS MUST NOT SAY. A fallback is not a failed check. The engine re-verifies in
// full from the replica's own bytes (its own root, signature, shards, record hashes and run log), so the
// data that was served is proven. What the customer has learnt is that their PRIMARY could not be checked,
// which is an unknown about one destination, not a finding about their run. A check that ran to a verdict
// is a finding and stays terminal on every destination; a check that could not run is an unknown, and the
// second and third copies exist for exactly that. Copy that blurs the two would frighten a customer whose
// restore in fact succeeded and was fully verified.
export interface RestoreDestFallback {
  servedAt: number;
  servedDestinationId?: string;
  refused: RestoreDestRefusal[];
}

// CfConfigSkipClass mirrors the engine's closed vocabulary of WHY one cf-config item did not apply on a
// restore (engine src/admin/restore-types.ts, itself a mirror of sources/cf-config-fault.ts
// CF_WRITE_SKIP_CLASSES, where the classification happens).
//
// It is a CLASS and never a message. The raw Cloudflare sentence that was classified from stays in the
// operator's live response and is recorded nowhere, which is what makes the tally safe to render on a
// receipt and safe to carry in a support pack.
//
// `other` is a real member, not a gap: the engine classifies from Cloudflare's own wording, that wording is
// not a contract, and a refusal worded in a way the classifier does not recognise still lands here and
// still fails the apply. Anything the console renders from this map has to degrade the same way, naming an
// unclassified skip honestly rather than dropping it because it matched no known class.
export type CfConfigSkipClass =
  | "auth"
  | "entitlement"
  | "quota"
  | "validation"
  | "conflict"
  | "no-live-id"
  | "no-live-phase"
  | "live-only-rules"
  | "rate-limited"
  | "api-unavailable"
  | "other";

export interface RestoreResult {
  ok: boolean;
  runId: string;
  mode: "applied";
  recordsVerified: number;
  recordsRestored: number;
  bytesRestored: number;
  isLatest: boolean;
  failures: Array<{ name: string; reason: string }>;
  // skipped lists records that were intentionally not written and do not represent failures. Two kinds
  // reach it: a secrets record (Secrets Store bindings are read-only at runtime; restore out of band via
  // the Cloudflare API or wrangler), and a data record whose captured value is an incompleteness MARKER
  // (the object vanished or was over-ceiling at capture), which is a sentinel rather than real bytes.
  //
  // A non-empty skipped list does not set ok:false on its own, and that is right: nothing failed. It does
  // mean the apply is NOT a clean full restore, because those records are in the archive and are not in
  // the account. restoreOutcome classifies such an apply as "skipped" rather than "clean" for that reason,
  // and the receipt groups them by what to do, the same way the dry-run plan does.
  skipped?: Array<{ name: string; reason: string }>;
  // configApplied (cf-config apply) mirrors the engine: the per-surface result of re-applying
  // Cloudflare-config records to the live account (idempotent surfaces only), each a surface id + the count
  // applied + the count skipped. Present only when a cfConfig context was supplied; a write that throws is
  // recorded in failures (so ok reflects it).
  // skipReasonCounts is the CLOSED {class: count} map BEHIND that bare `skipped` integer, and this
  // mirror was missing it, so the console could show that a surface skipped and could not show WHY. The
  // integer cannot tell "your plan caps DNS records" from "the restore token lacks the edit scope" from
  // "the snapshot item is malformed", and those are three tickets with three different remedies. Every key
  // is a CfConfigSkipClass member and every value a count, so it is safe to render and safe to pack; the
  // raw Cloudflare message stays in the operator's live response and is never recorded.
  configApplied?: Array<{ surface: string; applied: number; skipped: number; skipReasonCounts?: Partial<Record<CfConfigSkipClass, number>> }>;
  // mediaRestored (media apply) mirrors the engine: the captured media files re-uploaded to the live
  // account, each the record name + the restored id and whether it was REMAPPED (a video gets a new uid;
  // an image keeps its id). The remapped entries are the id-map. Present only when a mediaRestore context
  // was supplied; a failed upload is recorded in failures.
  mediaRestored?: Array<{ name: string; restoredId: string; remapped: boolean }>;
  // FIDELITY SHORTFALLS. Each is the engine recording something a restore did NOT fully carry across, and
  // every one was added there to end a silence: d1SchemaObjectsFiltered exists "so an app that breaks
  // after a complete subset restore has an answer", metadataFieldsDropped because dropped TTLs were
  // "SILENT behind a receipt claiming full fidelity". The console was not declaring them at all, so the
  // data arrived on the wire and was discarded at this type boundary, and the receipt went on calling such
  // a restore clean with a success tick. Optional, because an older engine sends none of them.
  mediaFaults?: Record<string, number>;
  mediaConflictDigests?: Array<{ archivedSha384: string; liveSha384: string }>;
  d1Fault?: { d1ErrorClass: string; failedBatchIndex?: number; batchTotal?: number; residualTableCount?: number };
  d1SchemaObjectsFiltered?: number;
  metadataFieldsDropped?: Record<string, number>;
  // The SIGNED restore receipt. The engine attests each restored record's landed bytes against the signed
  // hash, tamper-evident and redaction-safe, and the console currently displays none of it: it builds its
  // own summary from the counts above and discards the attestation. Declared here so the data stops being
  // thrown away at this boundary, but nothing renders it yet, and where it belongs (this screen, a
  // download, the evidence pack) is a design decision rather than a wiring one.
  receipt?: unknown;
  // WINDOWED-RESTORE HONESTY (maxRecords) mirrors the engine's authoritative trio (engine
  // src/admin/restore-types.ts): when a maxRecords cap (or any other non-window skip) leaves records
  // unrestored, outOfWindow is HOW MANY were left unrestored, windowed is outOfWindow > 0, and complete
  // is true only when nothing failed AND nothing fell outside the window. These are the engine's own
  // counts, so the console prefers outOfWindow over deriving (recordsVerified - recordsRestored): the
  // two agree for a pure maxRecords window but diverge when records are skipped for non-window reasons.
  // The console labels a windowed partial differently from a failure so a deliberate windowed apply is
  // never mislabelled "applied with failures". All optional for backward compatibility: an engine build
  // that does not yet emit them leaves them absent, which the console reads as a complete apply (the
  // prior behaviour) and falls back to the derived count. Redaction-safe (counts and a boolean only).
  outOfWindow?: number;
  windowed?: boolean;
  complete?: boolean;
  reason?: string;
  // destFallback: present ONLY when the 3-2-1 walk had to fall past at least one destination to produce
  // this result. On an APPLY it also rides inside the receipt's SIGNED and hashed core, on the same terms
  // as recordsSkipped, so a receipt for a restore served from a replica cannot hash the same as one served
  // from the primary. See RestoreDestFallback for what a screen may and may not say about it.
  destFallback?: RestoreDestFallback;
}

// BlindRestoreTest mirrors the engine's restore-types.ts byte-for-byte: the result of the BLIND
// restore test. The engine decrypts EVERY in-scope record of a run to a DISCARD sink, verifying each
// record's plaintext SHA-384 against the signed recordHash, and NEVER returns or logs a single byte
// of plaintext. It is the strongest single-archive recoverability proof short of an actual apply.
//   ok is true iff every in-scope record verified AND at least one record was in scope (an empty
//     window is not a pass; there is nothing to prove).
//   recordsVerified / bytesVerified: how many in-scope records decrypted-and-verified, and their
//     summed plaintext size. bytesVerified is the real decrypted byte count (a measured throughput
//     figure, the bytes that flowed to the discard sink), not a manifest-declared estimate.
//   failures: per-record COARSE reasons for any record that did not verify. The names are the source
//     names (the customer's own keys, redaction-safe), NEVER a value. A non-empty list means the
//     archive is not fully recoverable.
//   restoreDigest: a "sha384:"-prefixed hash OVER the verified plaintext, computed WITHOUT exposing
//     plaintext (it folds each verified record's (recordId, plaintextSha384) in recordId order), so
//     the SAME archive restoring yields the SAME digest. null when no record verified.
//   downpipeId: the run's own downpipe id recovered from the verified root manifest (redaction-safe);
//     absent when the run could not be opened (a break-glass-only posture or an early failure).
//   reason: a coarse, secret-free note on a top-level failure (or the break-glass-only posture), or
//     absent on a pass.
// No-custody: every field here is a count, a coarse reason, a redaction-safe name, or a hash over
// hashes; this shape can never carry a record value or a key.
export interface BlindRestoreTest {
  ok: boolean;
  runId: string;
  downpipeId?: string;
  recordsVerified: number;
  bytesVerified: number;
  failures: Array<{ name: string; reason: string }>;
  restoreDigest: string | null;
  isLatest: boolean;
  reason?: string;
}

// KeylessAttestationResult mirrors the engine's restore-types.ts byte-for-byte: the Tier 0 KEYLESS
// integrity attestation. It verifies the manifest signature, shard-presence completeness, the
// per-record/Merkle commitment (via the signature that covers them) and the RUNLOG anti-rollback
// WITHOUT any decryption key and WITHOUT touching record plaintext, so it runs even in the
// break-glass-only posture. ok is the AND of the three flags; reason is a coarse, secret-free note on
// the first failing check, or absent on a clean attestation. downpipeId is recovered from the
// SIGNATURE-VERIFIED root manifest (trustworthy even keylessly), absent when the signature did not
// verify. No key and no value ever transit this shape.
export interface KeylessAttestationResult {
  ok: boolean;
  runId: string;
  downpipeId?: string;
  signatureValid: boolean;
  complete: boolean;
  notRolledBack: boolean;
  reason?: string;
}
