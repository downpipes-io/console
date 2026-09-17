// Config change-control mirror types. See ../types.ts for the barrel.

// ---- Config change-control mirror: the deferred-mutation result + the pending change ------------
// The engine's opt-in four-eyes / dual-control gate (config approval policy) can DEFER a config
// mutation instead of applying it: when the policy is ON, a config-mutation route answers HTTP 202 with
// a { pending: true, id, ... } body and queues a ConfigChange for a second approver. These types model
// that on the console side so a mutation site resolves to a DISCRIMINATED result (applied vs pending)
// rather than a thrown error, and the change-requests inbox renders the queued changes.

// ConfigChangeKind is the closed set of config mutations the gate can defer, mirroring the engine's OWN
// literal values verbatim (engine/src/admin/change-control.ts's ConfigChangeKind), because GET
// /config/changes sends the engine's dash-form kind with no translation. All 18 engine kinds are listed
// here, including coverage-inventory and cf-config-mode-set, so kindMeta's lookup resolves every real
// change and every pending-change card renders a human label rather than the raw engine kind string. The
// console maps each to a human label + the write capability an approver must hold (see
// CONFIG_CHANGE_KIND in lib/config-changes.ts). It is kept as a string-typed union the console renders
// defensively: an unknown kind from a newer engine still lists with its raw id and the diff (never
// dropped).
export type ConfigChangeKind =
  | "downpipe-upsert"
  | "downpipe-delete"
  | "role-set"
  | "role-delete"
  | "group-role-set"
  | "group-role-delete"
  | "custom-role-set"
  | "custom-role-delete"
  | "notify-channel-set"
  | "notify-channel-delete"
  | "notify-rule-set"
  | "notify-rule-delete"
  | "posture-accept"
  | "posture-unaccept"
  | "expiry-item-set"
  | "expiry-item-delete"
  | "coverage-inventory"
  | "cf-config-mode-set";

// ConfigChangeStatus is a pending change's lifecycle state, mirroring the engine's own literals
// (scheduler-do-change-control.ts writes exactly these): "pending" awaits a second approver; "applied"
// was approved and took effect; "rejected" was declined; "superseded" was cleared because the config it
// targeted moved on before a second owner acted (the engine has NO time-based expiry, so there is no
// "expired" state to mirror).
export type ConfigChangeStatus = "pending" | "applied" | "rejected" | "superseded";

// PendingChangeLine mirrors the engine's PendingChangeLine (admin/change-control.ts, populated by
// scheduler-do-change-control.ts's proposeConfigMutation from diffConfig(current, wouldBe)): one line of a
// pending change's plain-English diff. kind is the closed added/removed/changed set (the same three
// literals the config-history diff's ConfigDiffKind uses); area is left as a plain string on the wire (the
// engine's interface widens it past the closed history-diff area union on purpose, so a newer area name
// here needs no matching console change); text is the one-line description, rendered as a text node. This
// is an ARRAY OF OBJECTS, not a string: treating it as a bare string or string[] and calling
// String.prototype.replace on each element throws on an object.
export interface PendingChangeLine {
  readonly kind: "added" | "removed" | "changed";
  readonly area: string;
  readonly text: string;
}

// ConfigChange is one queued config mutation the engine is holding for a second approver. id is the
// change's storage id (the same id a deferred mutation's 202 body returned); kind is the mutation class;
// proposedBy is the verified email of the maker (null on the bare-token break-glass); proposedAt is
// RFC-3339; diff is the PLAIN-ENGLISH change description the engine pre-rendered, as the PendingChangeLine
// objects the engine's PendingConfigChange.diff carries (never a bare string), so the approver reviews the
// exact effect without the console re-deriving it; status is the lifecycle state. No-custody: every field
// is an id, a coarse kind, a redaction-safe diff line, an email and a timestamp; never a value or a key.
// The console escapes every string on render.
export interface ConfigChange {
  readonly id: string;
  readonly kind: ConfigChangeKind;
  readonly proposedBy: string | null;
  readonly proposedAt: string;
  readonly diff: PendingChangeLine[];
  readonly status: ConfigChangeStatus;
  // approvedBy / approvedAt are present once a change is applied or rejected (the distinct checker, or
  // the proposer on a self-reject). Carried so the inbox can show who actioned a non-pending change.
  readonly approvedBy?: string;
  readonly approvedAt?: string;
}

// ConfigApprovalPolicy is the GET /admin/config/approval-policy body: the governance-policy flags the console
// reads. requireConfigApproval is whether config mutations require a second approver (four-eyes / dual
// control). requireChangeNumber is the OWNER-OPT-IN "Require Change Number" policy: when true, a CAB-worthy
// change-controlled action needs a change reference attached. requireChangeNumber is OPTIONAL so an older
// engine that does not report it reads the default false (the feature reads as off). Each is a single boolean.
export interface ConfigApprovalPolicy {
  readonly requireConfigApproval: boolean;
  readonly requireChangeNumber?: boolean;
  // notifyNewSignInContext: the owner-opt-in "notify on a sign-in from a new network
  // context" policy. OPTIONAL: an older engine omits it and the console degrades honestly.
  readonly notifyNewSignInContext?: boolean;
  // requireRestoreApproval: the OWNER-OPT-IN second-approver requirement on a RESTORE APPLY, a separate
  // policy from requireConfigApproval above (that one gates config mutations; this one gates a write-back
  // over live data). OPTIONAL so an older engine that does not report it reads the default FALSE, which is
  // also the engine's own default: an approval must come from someone other than the requester, so an
  // unconditional gate would lock a one-identity estate out of restore entirely.
  readonly requireRestoreApproval?: boolean;
}

// MutationResult is the discriminated result of a CONFIG MUTATION that the change-control gate may defer.
// "applied" carries the engine's applied record (the normal path, and the ONLY path when the gate is
// off); "pending" carries the queued change's id (and kind when the engine supplied it) so the caller
// shows "queued for approval" with a link to the change-requests inbox, rather than a false "saved". This
// is what lets every mutation site handle the 202 uniformly via one narrow on result.status, and it is
// why parseJsonOrPending resolves instead of throwing on a 202. raw is the verbatim pending body for a
// caller that wants the diff immediately; it carries no value or key (id/kind/diff only).
export type MutationResult<T> =
  | { readonly status: "applied"; readonly value: T }
  | { readonly status: "pending"; readonly changeId: string; readonly raw: PendingChangeBody };

// PendingChangeBody is the engine's 202 deferred-mutation body, matching EXACTLY what the engine sends.
// There is one gated-config 202 in the whole engine (sched/scheduler-do.ts, the change-control gate):
//
//     return this.jsonStatus({ queued: true, id: p.id, status: p.status, contentHash: p.contentHash }, 202);
//
// The word "pending" appears in no engine response body anywhere: the wire carries `queued: true`, which
// is what isPendingChangeBody checks for.
//
// `status` and `contentHash` are the engine's; a mutation site needs only the id (the inbox at
// listConfigChanges is the authoritative render of a change), so they are modelled and not otherwise read.
export interface PendingChangeBody {
  readonly queued: true;
  readonly id: string;
  readonly status?: string;
  readonly contentHash?: string;
}

// isPendingChangeBody is the runtime guard parseJsonOrPending uses to recognise a deferred-mutation 202 body:
// an object with queued === true and a non-empty string id, which is what the engine sends. On a 202, anything
// else (an unexpected shape, or a body that did not parse as JSON at all) is a malformed pending body: it
// records a contract-drift row and THROWS an honest "answer-unreadable" error rather than fabricating a
// pending id the inbox could not resolve, or being read as a false "applied" success.
export function isPendingChangeBody(v: unknown): v is PendingChangeBody {
  if (typeof v !== "object" || v === null) return false;
  const candidate = v as { queued?: unknown; id?: unknown };
  return candidate.queued === true && typeof candidate.id === "string" && candidate.id.length > 0;
}

// isPendingResult / isAppliedResult are the caller-side narrows on a MutationResult, so a screen reads
// `if (isPendingResult(res))` rather than re-deriving the discriminant. Pure, trivially correct.
export function isPendingResult<T>(r: MutationResult<T>): r is { readonly status: "pending"; readonly changeId: string; readonly kind?: string; readonly raw: PendingChangeBody } {
  return r.status === "pending";
}

export function isAppliedResult<T>(r: MutationResult<T>): r is { readonly status: "applied"; readonly value: T } {
  return r.status === "applied";
}
