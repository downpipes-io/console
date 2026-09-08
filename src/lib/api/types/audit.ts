// Hash-chained audit + drill-evidence mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

import type { Role, AuthMethod } from "../../identity.ts";

// ---- Audit mirror: the hash-chained event + the read/verify shapes -------
// AuditAction / AuditOutcome / AuditTarget / AuditEvent mirror the engine's audit.ts. The target
// is the SAME closed, redaction-safe union the engine writes (no open string field), so the
// console can only ever render safe fields. The copy says tamper-evident, never tamper-proof.
// THE MIRROR IS THE CONTRACT, AND A HOLE IN IT IS NOT A COSMETIC ONE. The console does not merely
// render these names: describeTarget files a contract-skew row whose vocabulary asserts "a NEWER engine is
// writing vocabulary this build does not know", and the audit filter can only offer an action this union
// holds. A member the CURRENT engine writes and this union lacks therefore produces a diagnosis that is both
// false (the pair is in lockstep) and disabling (support is told to upgrade a console that is already
// current), and the operator cannot filter the trail down to the event that explains their outage. The union
// below is a MEMBER-FOR-MEMBER mirror of the engine's AUDIT_ACTIONS (engine src/admin/audit-types.ts), in the
// engine's own order, and AUDIT_ACTION_LABELS is a complete Record over it, so tsc refuses an unlabelled
// member. Both directions were checked: the engine holds no action this union lacks, and this union holds no
// action the engine cannot write.
export type AuditAction =
  | "restore-apply"
  // restore-verified: the restore RECEIPT anchored to the chain (proof each restored record's landed bytes
  // hash to the signed manifest hash). Target: restore-receipt.
  | "restore-verified"
  | "restore-request"
  | "restore-approve"
  | "restore-reject"
  // A retention-prune APPLY deletes archive bytes outright, so it needs the same
  // maker != checker second-authority pattern as restore-request/approve/reject above, bound to a
  // planHash computed from the downpipe's CURRENT retained/superseded split. Target: prune-approval.
  | "retention-prune-request"
  | "retention-prune-approve"
  | "retention-prune-reject"
  | "downpipe-create"
  | "downpipe-delete"
  // downpipe-roster-reconcile: structural ghost rows in the downpipe roster were repaired back to the
  // "storage key = config.id" invariant. run-trigger: a manual off-schedule run (POST /trigger).
  | "downpipe-roster-reconcile"
  | "run-trigger"
  | "role-change"
  | "group-role-change"
  | "custom-role-change"
  // Native external-IdP lifecycle and sign-ins, and FAILED authentication attempts (a brute-force or
  // credential-stuffing sweep is visible in the trail). A failure verifies no identity, so its actor is null.
  | "idp-connection-change"
  | "idp-sign-in"
  | "authn-failure"
  | "key-ceremony-intent"
  // The in-product key ceremony's results: the install, the break-glass rotation, the posture tightening that
  // removes the operational secrets, and (G027) the two FAILURE rows, which name the step the ceremony died on
  // and the closed cause. An install that died at PUT #2 leaves a HALF-KEYED engine and used to record nothing.
  | "keys-installed"
  | "break-glass-rotated"
  // operational-added: the targeted operational-key ADD (the minimal break-glass-only upgrade path, the
  // inverse of operational-removed below). SIGNER_PRIVATE and BREAK_GLASS_PUBLIC are never touched.
  | "operational-added"
  | "operational-removed"
  | "key-install-failed"
  | "key-removal-failed"
  | "access-policy-change-intent"
  // Security-centre overrides (owner-only): an owner set or withdrew a per-check override
  // (risk-accepted / attested-pass / compensating-control / not-applicable). Mirrored from the
  // engine; the target is the redaction-safe posture-check kind below (the reason text never
  // enters the audit log).
  | "posture-override-set"
  | "posture-override-withdrawn"
  | "config-change-propose"
  | "config-change-approve"
  | "config-change-reject"
  | "config-change-supersede"
  | "config-policy-change"
  // dual control for the high-blast-radius OWNER OPERATIONS (a destination repoint or removal, an engine
  // self-deploy, an IdP connection change). The same requireConfigApproval toggle arms it; propose attributes
  // the maker, approve the checker, execute records that the approved action ran. Target: owneraction.
  | "owner-action-propose"
  | "owner-action-approve"
  | "owner-action-execute"
  | "owner-action-reject"
  // change management (OWNER OPT-IN "Require Change Number"): a CAB-worthy change-controlled action was
  // recorded with the operator's change reference (the CR number, or an Emergency Change). Mirrored from the
  // engine; the target is the redaction-safe `change` kind below.
  | "change-recorded"
  | "bootstrap-consumed"
  | "break-glass-token-retired"
  | "recovery-codes-generated"
  // A fresh set was minted for an email that already had a live set, but held back: the live set still
  // verifies until the operator confirms (STAGED-RECOVERY-CODES-CONFIRM-GATE). Mirrored from
  // the engine; recovery-codes-generated above is the row that says the old set actually died.
  | "recovery-codes-staged"
  | "recovery-code-used"
  | "support-credential-grant"
  | "support-credential-revoke"
  // Account-discovery and archive-destination lifecycle, mirrored from the engine's audit.ts:
  // who flipped account browsing / chose the browsed accounts / chose which token-authenticated source types
  // are available to protect / changed where backups go, and when. Never a token, never a credential.
  | "discovery-token-set"
  | "discovery-token-cleared"
  | "discovery-accounts-set"
  | "discovery-sources-set"
  // engine-account-verified: the engine proved its own
  // Cloudflare account id for the first time, from a successful attach or update-apply. Recorded once
  // (never overwritten); who + when only, never the account id itself.
  | "engine-account-verified"
  | "dest-config-set"
  | "dest-config-cleared"
  // assurance-licence lifecycle: who pinned or removed the signed LICENCE_TOKEN. Never the token bytes.
  | "licence-activated"
  | "licence-cleared"
  // safe-apply engine update lifecycle: promoted (live, pending canary verification), applied (the canary
  // proved it healthy), rolled-back (it did not), refused (aborted before going live). Target: engine-state.
  | "update-promoted"
  | "update-applied"
  | "update-rolled-back"
  | "update-refused"
  // the owner toggled, repointed or re-cadenced the integrity canary. The hourly flights are not audited.
  | "canary-config"
  | "sources-attached"
  | "sources-detached"
  // the operator ATTESTED they deleted a spent ephemeral credential in Cloudflare (the engine holds no CF
  // token and cannot verify Cloudflare-side state, so this is an attestation: who + when, never a value).
  | "expiry-cleanup-attested"
  // Session and credential lifecycle (ASVS V7.4.5 / V7.5.2 / V6.5.6 / V14.2.7), mirrored from the
  // engine's audit.ts. session-terminate records a self / admin / all-users session termination;
  // passkey-credential-revoke records a revoked WebAuthn credential; retention-prune records an
  // ENFORCED archive prune (the engine only audits the apply, never the dry-run report).
  | "session-terminate"
  | "passkey-credential-revoke"
  // signin-factor-revoke (engine OFFBOARD-NO-REVOKE): ONE act, an operator removing every way one
  // person can authenticate across all three sign-in stores at once. Deliberately not three rows, so the
  // question "was the offboarding complete?" is not a join the reader has to perform. Target is the
  // field-less-secret `role` kind naming the member and the role they held AT the revocation.
  | "signin-factor-revoke"
  | "retention-prune"
  // control-plane recovery, all engine-driven: a signed config export was written; the health pass
  // found an EMPTY control plane while the bucket still holds runs (the amnesia signal); a break-glass
  // operator rebuilt the DO from a verified export (the seam where the old hash chain ends); the cron
  // auto-heal re-applied the no-authority resume slice, so backups resumed without a human.
  | "control-plane-exported"
  | "control-plane-empty"
  | "control-plane-reconciled"
  // control-plane-recovery-acknowledged: an authenticated owner cleared the recovery-required latch WITHOUT
  // a reconcile, because the plane had organically un-emptied while the latch stayed set and the reconcile
  // routes refuse once the plane is non-empty. Distinct from control-plane-reconciled so the trail can tell
  // an acknowledge-only clear apart from a genuine rebuild carrying bridgedFrom.
  | "control-plane-recovery-acknowledged"
  | "control-plane-resumed"
  // engine-observed (out of band, actorMethod "engine", no human actor). engine-secret-absent is the
  // presence LOSS: a tracked secret VANISHED (a deploy dropped SIGNER_PRIVATE, the break-glass key or the
  // destination binding), which is why the backups stopped and when. Outcome "failed": never a healthy
  // transition. Without it in this union the audit filter cannot select the one event that explains the outage.
  | "engine-secret-present"
  | "engine-secret-absent"
  | "engine-version-change"
  // The three test-fault events, also engine-observed (actorMethod "engine"). They only ever appear on an
  // estate running with HARNESS_TEST_FAULTS, because a production engine never routes to the hook at all.
  // They are in the engine's CLOSED action set for exactly that reason: their absence from a production
  // chain is then a checkable fact rather than an artefact of where somebody chose to write them, and this
  // union is what lets the audit filter select them and ask "was a fault armed when this verdict was banked".
  | "test-fault-armed"
  | "test-fault-disarmed"
  | "test-fault-fired"
  // the control-plane fault hook's clear (engine sched/scheduler-do-test-fault.ts): a caller cleared a
  // control-plane-recovery-required test fault, distinct from an operator acknowledge or a reconcile.
  | "test-fault-control-plane-cleared"
  // the two audit/metric EGRESS destinations (SIEM audit-log push, OTLP metrics push): who repointed or
  // removed where the trail/snapshot is forwarded, and the engine-driven delivery failures. Never an endpoint
  // or an auth header value. Target: push-destination.
  | "push-destination-set"
  | "push-destination-cleared"
  | "push-delivery-failure"
  | "otlp-push-destination-set"
  | "otlp-push-destination-cleared"
  | "otlp-push-delivery-failure"
  // The key-posture acknowledgement, the custody-share email, and the attended-verification session's four
  // events. All six are written by the CURRENT engine and were missing here: the audit filter could not select
  // them, and each rendered as its raw internal noun.
  | "posture-acknowledged"
  | "custody-share-emailed"
  | "attest-session-started"
  | "attest-session-proven"
  | "attest-run-verified"
  | "attest-session-aborted";

export type AuditOutcome = "success" | "denied" | "failed";
export type AuditActorMethod = AuthMethod | "engine";

// THE SAME MIRROR DISCIPLINE, AND THE SHARPER EDGE OF IT. describeTarget's default arm renders
// "unrecognised target (newer engine?)" AND records a contract-skew row. A target kind the CURRENT engine
// writes and this union lacks therefore files a false skew row on an in-lockstep pair, and does it on the
// engine's most ordinary events: every IdP sign-in (idpconnection), every applied restore's receipt
// (restore-receipt), every archive-destination change (dest-change), every dual-control owner action
// (owneraction), every push-destination mutation and delivery failure (push-destination), and every spent-
// credential attestation (credential-cleanup). Each of the six is mirrored below and rendered by name, so the
// default arm is left to mean only what it says: a kind this build has never heard of.
export type AuditTarget =
  | { readonly kind: "downpipe"; readonly id: string; readonly name?: string }
  | { readonly kind: "run"; readonly runId: string }
  // prune-approval: the retention-prune dual-control record, the counterpart of the "restore" kind
  // below but for a prune approval. downpipeId + counts only (never a run id list); planHash is opaque and
  // recomputable from the downpipe's own live RUNLOG, never a secret; reasonClass is the checker's closed
  // rejection reason, present only on a reject.
  | { readonly kind: "prune-approval"; readonly downpipeId: string; readonly planHash: string; readonly retainedRuns: number; readonly supersededRuns: number; readonly reason?: string; readonly approverEmail?: string; readonly approverSubject?: string; readonly reasonClass?: string }
  | { readonly kind: "restore"; readonly runId: string; readonly redirectBinding: string | null; readonly planHash: string; readonly isLatest: boolean; readonly reason?: string; readonly approverEmail?: string; readonly approverSubject?: string; readonly destinationId?: string }
  // restore-receipt anchors the proof-of-correct-restore receipt to the chain: the run it covers, the
  // canonical SHA-384 of the receipt (so any later edit to the receipt is detectable), how many records were
  // restored, whether every one of them re-verified, and whether a windowed apply left records unrestored.
  // A run id, a hash, integers and booleans; never a record name, value or key. The engine carries a longer
  // optional forensic tail on this target (per-class media/D1/config-skip counts) which rides in the support
  // pack; the console renders the headline facts only.
  // recordsSkipped is the count the apply deliberately did not write (a secrets record has no runtime
  // write path; an incompleteness marker is a sentinel, not real bytes). Omitted when zero. It matters on
  // this entry more than most: it reads "restore-verified / success", and recordsRestored with allVerified
  // alone would tell an auditor the recovery is finished while records from the archive are still absent.
  | { readonly kind: "restore-receipt"; readonly runId: string; readonly receiptSha384: string; readonly recordsRestored: number; readonly allVerified: boolean; readonly complete?: boolean; readonly recordsVerified?: number; readonly failures?: number; readonly recordsSkipped?: number }
  | { readonly kind: "role"; readonly email: string; readonly role: Role }
  | { readonly kind: "grouprole"; readonly group: string; readonly role: Role }
  // affectedGrantCount (DELETE only): how many member and group grants still named this custom role when it
  // was deleted, i.e. how many people the deletion floors to viewer at their next request. A count, never a holder.
  | { readonly kind: "customrole"; readonly name: string; readonly capabilityCount: number; readonly affectedGrantCount?: number }
  | { readonly kind: "configchange"; readonly id: string; readonly changeKind: string; readonly approverEmail?: string }
  // owneraction is the configchange twin for the high-blast-radius owner operations under dual control: the
  // pending action's opaque id, the OPERATION KIND it gates (never its params) and, on approve/execute, the
  // checker's email. The params (destination ids, an artefact sha) deliberately cannot ride on the target.
  | { readonly kind: "owneraction"; readonly id: string; readonly actionKind: string; readonly approverEmail?: string }
  // change: a change-controlled action's CHANGE REFERENCE (the CR ledger entry). actionKind is the engine-set
  // kind (e.g. "dest-remove", "restore-apply"); emergency flags an Emergency Change (a bypass of the number
  // requirement); changeNumber + reason are the operator's already-bounded free text (the same redaction class
  // as the restore reason), null when absent. Mirrored from the engine's audit.ts.
  | { readonly kind: "change"; readonly actionKind: string; readonly emergency: boolean; readonly changeNumber: string | null; readonly reason: string | null }
  // key-ceremony is field-less on the SUCCESS rows (who + when is the whole evidence). The optional fields are
  // the FAILURE evidence: which secret the ceremony died on (a fixed env-var NAME, never a value), the closed
  // cause, and the bounded Cloudflare evidence (a status class plus Cloudflare's own numeric codes), which is
  // what separates a CF edge outage from a token-scope problem without carrying a response body.
  | { readonly kind: "key-ceremony"; readonly step?: string; readonly cause?: string; readonly cfStatusClass?: string; readonly cfCodes?: readonly number[] }
  // access-policy was field-less by design, and that lost the decisive fact on every governance event using it:
  // a config-approval toggle and a change-number toggle wrote byte-identical events, and enabling the canary
  // wrote the same event as disabling it. Every field is a closed enum or a boolean (the policy NAME and the
  // DIRECTION, never a value), so the redaction class is unchanged. gateBypass records that a gated action ran
  // via the bare break-glass token, which is exempt from dual-control auto-apply.
  | {
      readonly kind: "access-policy";
      readonly policyName?: "config-approval" | "change-number" | "notify-signin-context" | "break-glass-retired";
      readonly newValue?: boolean;
      readonly canaryOp?: "enable" | "disable" | "pin" | "cadence";
      readonly gateBypass?: "break-glass";
    }
  | { readonly kind: "posture-check"; readonly checkId: string; readonly overrideKind: string | null }
  // custody-share: a Shamir share emailed to a custodian, as COUNTS ONLY (threshold m of total n). It never
  // carries a share value, a custodian address, the wrapping key or the ciphertext.
  | { readonly kind: "custody-share"; readonly n: number; readonly m: number }
  // posture-ack: the key-posture acknowledgement. Every field is a closed enum, an opaque version or a hash,
  // so no secret and no free-form text can ride here. statementSha384 binds the chain to WHICH words were
  // acknowledged (the words themselves are a frozen repo constant, never in the log), and principalType
  // records the evidentiary weight (a bootstrap-token ack is marked, not disguised as a named one).
  | {
      readonly kind: "posture-ack";
      readonly posture: "operational" | "break-glass-only";
      readonly statementVersion: string;
      readonly statementSha384: string;
      readonly channel: "onboarding" | "keys-rekey";
      readonly principalType: "owner-passkey" | "named-operator" | "bootstrap-admin-token";
    }
  // attest-session: an attended-verification session event. An opaque ULID plus redaction-safe counts; there
  // is no field that could hold a per-run master, the sampling seed or a challenge proof.
  | { readonly kind: "attest-session"; readonly sessionId: string; readonly runs?: number; readonly sampleRate?: number }
  // dest-change is the redaction-safe detail on an archive-destination mutation: the op, the destination id
  // acted on (an operator label, never a credential), the default pointer before and after (clearing the
  // current default silently PROMOTES the next remaining destination, redirecting where unassigned downpipes
  // write), whether a removal was FORCED past the orphan guard, how many origin runs then had no other proven
  // copy, which downpipes those were, and, on a rejected set, a closed reject-reason class.
  | {
      readonly kind: "dest-change";
      readonly op: "set" | "clear" | "default" | "remove";
      readonly id?: string;
      readonly fromDefaultId?: string;
      readonly toDefaultId?: string;
      readonly force?: boolean;
      readonly uncoveredOriginRunCount?: number;
      readonly rejectReason?: "endpoint-not-https" | "missing-fields" | "invalid-config";
      readonly affectedDownpipeNames?: readonly string[];
    }
  // "metrics" is the Prometheus-scrape bearer scope, the third ingest scope alongside the vendor-diagnostics
  // and SIEM-audit-feed pair. The secret and its hash are unrepresentable here, like every other target.
  | { readonly kind: "supportcredential"; readonly scope: "diagnostics" | "audit-feed" | "metrics"; readonly clientId?: string; readonly expiresAt?: string }
  // idpconnection carries the connection's operator-chosen slug, its protocol kind and the lifecycle op (or
  // "signin" for a completed sign-in through it, "test" for a read-only pre-save probe). Never a client secret,
  // private key, signing cert or assertion. The WHO of a sign-in is the event's own actorEmail/actorSubject.
  | { readonly kind: "idpconnection"; readonly connId: string; readonly connKind: "oidc" | "oauth2" | "saml"; readonly op: "create" | "update" | "delete" | "enable" | "disable" | "signin" | "test" }
  // credential-cleanup carries the registry item's id and, when the engine captured it at attach time, the
  // PUBLIC Cloudflare token id descriptor the operator is asked to delete. Never the token value.
  | { readonly kind: "credential-cleanup"; readonly itemId: string; readonly tokenRef?: string }
  // push-destination is the redaction-safe detail on a SIEM/OTLP push destination mutation or delivery
  // outcome: the op, an optional operator-label id, a closed reject-reason class on a refused set, and the
  // CONSECUTIVE failure count on a delivery failure. There is deliberately no free-form field, so neither the
  // endpoint nor the auth header value nor any fragment of a shaped payload can enter the chain.
  | {
      readonly kind: "push-destination";
      readonly op: "set" | "clear" | "test" | "delivery-failure";
      readonly id?: string;
      readonly rejectReason?: "endpoint-invalid" | "format-invalid" | "missing-fields";
      readonly failureCount?: number;
    }
  // "secret-absent" is the true -> false twin of "secret-present": the same closed shape and the same
  // detail vocabulary (a presence-boolean NAME from the engine's fixed tracked-field list), never a value. It
  // is the event that says a deploy dropped the signer key, the break-glass key or the destination binding,
  // which is to say WHY the backups stopped and WHEN. Missing it from this union did not merely leave the row
  // unlabelled: it made the console file a contract-skew row telling support to upgrade a current console.
  | { readonly kind: "engine-state"; readonly field: "secret-present" | "secret-absent" | "engineVersion"; readonly detail: string }
  // test-fault is written ONLY by an estate running with HARNESS_TEST_FAULTS: a production engine never
  // routes to the hook, so the ABSENCE of these rows from a production chain is a checkable fact rather
  // than an artefact of where somebody chose to write them. That is exactly why they are in the engine's
  // CLOSED action set (engine/src/admin/audit-types.ts:341-343) and therefore owed a mirror here.
  //
  // op says which of the three moments this is. armedAt rides on disarm and fire, because a fire without
  // its window is a point in time and a reviewer needs both ends to know which verdicts to doubt. binding
  // is present only where the fault was scoped to one.
  | { readonly kind: "test-fault"; readonly op: "arm" | "disarm" | "fire"; readonly faultKind: string; readonly binding?: string; readonly armedAt?: string };

export interface AuditEvent {
  readonly seq: number;
  readonly ts: string;
  // actorSubject is the engine's stable principal (iss|sub / passkey subject), OPTIONAL on the
  // wire for entries recorded before subject-keying. Opaque and redaction-safe.
  readonly actorSubject?: string | null;
  readonly actorEmail: string | null;
  readonly actorMethod: AuditActorMethod;
  readonly sourceIp: string | null;
  readonly action: AuditAction;
  readonly outcome: AuditOutcome;
  readonly target: AuditTarget;
  readonly prevHash: string;
  readonly hash: string;
}

// AuditPage is the GET /admin/audit response: a newest-first page plus the chain head, so the
// console can show the head hash and page a long log.
export interface AuditPage {
  readonly events: AuditEvent[];
  readonly headSeq: number;
  readonly headHash: string;
}

// ChainVerdict is the GET /admin/audit/verify result: intact through checkedThrough, or the first
// brokenAt. A break is a RESULT (still 200), not an error; the screen shows "break detected at
// entry N", which is the on-screen proof of tamper-evidence.
//
// headTruncated (G313) is the verdict `intact` CANNOT reach. The engine's recompute walks the entries it still
// has, so deleting the NEWEST ones -- the entries recording what an attacker just did -- leaves the survivors
// linking perfectly and intact reads TRUE. The engine's head anchor (written on every append, never lowered by a
// retention rollover) is the witness that sees it, and its verdict rides on this same body: a chain whose tail is
// gone must never render as "Chain intact". headTruncatedAt is the seq the engine committed to.
// rolledOver / rolledOverCount / earliestSeq are the RETENTION side, and the engine has been sending all
// three on this same response since the retention cap was introduced. Nothing here read them, so on an
// estate whose log had rolled the screen said "Chain intact through entry 12345" over a chain that begins
// at 2346, with no mention that the 2,345 entries before it are gone. The engine's own note beside them says
// they exist "so the console can show 'chain begins at entry N, M earlier entries rolled over' rather than a
// spurious break", which is a module asserting in writing what a screen it cannot see does not do.
//
// A rollover is NOT a break and must never render as one: it is retention working as designed, on a chain
// that still recomputes cleanly from its earliest retained entry. What it is, is a permanent and undeclared
// loss of evidence, and the entry it begins at is the only place an operator can read how much.
export interface ChainVerdict {
  readonly intact: boolean;
  readonly checkedThrough: number;
  readonly brokenAt?: number;
  readonly headTruncated?: boolean;
  readonly headTruncatedAt?: number;
  readonly rolledOver?: boolean;
  readonly rolledOverCount?: number;
  readonly earliestSeq?: number;
}

// AuditFilters are the optional server-side query params for the audit list. All optional;
// exactOptionalPropertyTypes-friendly.
// AuditFilters is mutated as a builder by the audit-filters screen (fields set and deleted as
// the operator edits the form), so its properties stay writable by design.
export interface AuditFilters {
  actor?: string;
  action?: AuditAction;
  downpipe?: string;
  outcome?: AuditOutcome;
  from?: string;
  to?: string;
  before?: number;
  limit?: number;
}

// roleRank / hasRole now live in lib/identity.ts (the capability-model mirror) and are re-exported
// at the top of this module, so the cumulative-ladder helpers and the new can()/Capability model
// share one source of truth and the existing "from ../api.ts" callers are unchanged.

// ---- The drill-evidence record (OPTIONAL) --------------------
// DrillEvidenceKind / DrillEvidenceEntry mirror the engine's optional drill-evidence log. "in-account" is an engine-run drill outcome; "offline-rehearsal" is an
// operator-entered record of a rehearsal performed with the offline Go tool (the break-glass-only
// posture). The note is redaction-safe free text (never a secret); the console escapes it on render.
export type DrillEvidenceKind = "in-account" | "offline-rehearsal";

export interface DrillEvidenceEntry {
  readonly runId: string;
  readonly kind: DrillEvidenceKind;
  readonly recordedBy: string | null; // the verified email of who recorded it; null for the token fallback
  readonly recordedAt: string;        // RFC-3339 UTC millis
  readonly note?: string;
}

