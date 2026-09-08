// Retention-prune mirror types, split out like the sibling domain type modules (attest.ts,
// restore-types.ts). This is the break-glass-only posture's no-CLI replacement for `downpipe prune`: the
// engine cannot decrypt a run's shard manifests without an in-account key, so the browser recovers each
// candidate run's master locally from the operator's break-glass key (or an M-of-N quorum) and hands back
// ONLY those per-run masters, batched. These shapes are redaction-safe by construction: run ids, counts and
// non-secret capsule wraps only, never a value or a recovered master. House rules: Australian English, no
// em dashes, precise claims.

import type { CapsuleWrap } from "../../keydecap.ts";

// PruneCapsule is one candidate run's master-recovery bundle, the same shape AttestCapsule carries: the
// browser opens the wrap addressed to the held break-glass identity to recover the 32-byte per-run master
// locally. The master itself is NEVER served.
export interface PruneCapsule {
  runId: string;
  masterCapsule: CapsuleWrap[];
  keyCommitment: string;
  recordCount: number;
}

// PruneCandidatePolicy is the downpipe's OWN stored retention policy, echoed back so the panel can show the
// operator what will actually happen: enforce is the literal stored value (not a client claim), so a panel
// for a downpipe with enforce off can honestly say a later apply call will only ever preview.
export interface PruneCandidatePolicy {
  keepRuns?: number;
  keepDays?: number;
  enforce: boolean;
}

// PruneCandidateResult is POST /admin/retention-prune/candidate's body: the downpipe's current
// retained/superseded split (from its live RUNLOG, recomputed fresh on every call) plus the non-secret
// capsules for every run in that split, so the browser can recover each one's master before an apply.
// failures lists a run whose capsule could not be read (a signature that will not verify, a missing
// manifest); a failure on a RETAINED run predicts an eventual ABSTAIN once an apply is attempted.
export interface PruneCandidateResult {
  downpipeId: string;
  policy: PruneCandidatePolicy;
  retainedRunIds: string[];
  supersededRunIds: string[];
  capsules: PruneCapsule[];
  failures?: Array<{ runId: string; reason: string }>;
}

// isPruneCandidateResult narrows an unknown value to PruneCandidateResult (a route the engine, or a
// demo/stub standing in for it, has not modelled is indistinguishable from a real success by status code
// alone). Deliberately loose beyond the fields a caller actually indexes, so a harmless engine-side field
// addition never trips it.
export function isPruneCandidateResult(v: unknown): v is PruneCandidateResult {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.downpipeId === "string" && Array.isArray(o.retainedRunIds) && Array.isArray(o.supersededRunIds) && Array.isArray(o.capsules);
}

// PruneApplyMode is the CLOSED outcome an apply call reports:
//   "incomplete-batch" -- a candidate run (retained OR superseded) could not be opened under the supplied
//     batch, so the whole call refused BEFORE any plan was even computed; missingRunIds names every one.
//   "not-approved" -- this downpipe's stored enforce is on and previewOnly was not set (a REAL delete was
//     intended), but no usable dual-control approval (a distinct approver's sign-off on this EXACT plan)
//     is armed; planHash is the value a request/approve cycle must be raised against.
//   "preview" -- this downpipe's own stored enforce is off, or previewOnly was requested -- nothing was
//     deleted, and no approval was needed or checked.
//   "abstained" -- a retained run in the batch would not open, so the whole pass deferred (the ABSTAIN
//     invariant); nothing was deleted. Expected unreachable once "incomplete-batch" already refused first,
//     kept as an honest defensive backstop.
//   "no-op" -- the plan is empty, nothing in scope this pass.
//   "applied" -- the prune committed.
//   "partial" -- an applied prune died mid-delete; the counts are what actually committed, never the plan.
export type PruneApplyMode = "incomplete-batch" | "not-approved" | "preview" | "abstained" | "no-op" | "applied" | "partial";

// PruneApplyResult is POST /admin/retention-prune/apply's body: counts only, never a run's content.
// downpipeId, mode and retainedRuns/supersededRuns are the only fields present on EVERY mode.
// runTreeObjects/orphanSegs are present on "abstained"/"no-op"/"applied"/"partial" (planPrune actually ran);
// absent on "incomplete-batch" (refused before any plan was computed) and "not-approved" (refused before
// dual control was even checked). missingRunIds is present only on "incomplete-batch"; planHash + error
// only on "not-approved"; deferred* only on "abstained"; wormBlocked only on "partial".
export interface PruneApplyResult {
  downpipeId: string;
  mode: PruneApplyMode;
  retainedRuns: number;
  supersededRuns: number;
  runTreeObjects?: number;
  orphanSegs?: number;
  missingRunIds?: string[];
  planHash?: string;
  error?: string;
  deferredClass?: string;
  blockingRunId?: string;
  wormBlocked?: boolean;
}

// isPruneApplyResult mirrors isPruneCandidateResult's guard for the apply route.
export function isPruneApplyResult(v: unknown): v is PruneApplyResult {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.downpipeId === "string" && typeof o.mode === "string";
}

// ---- Dual control (mirroring lib/api/types/rbac.ts's RestoreApproval shape) ---------------------
// A prune apply deletes archive bytes outright, a LESS reversible act than a restore apply (which
// overwrites live data but leaves the archive itself untouched), so it needs its own maker != checker
// second-authority approval, mirroring D2's request -> approve -> apply structurally (never reusing
// RestoreApproval, which carries restore-specific blast-radius cues -- target binding, isLatest, bytes --
// this action has none of). Bound to a KEYLESS planHash over the downpipe id + its CURRENT retained/
// superseded split, so a request can be raised and reviewed before anyone recovers a master.
// "applying" mirrors the engine's own live status (engine/src/admin/prune-approvals.ts:33): the atomic
// reserve between approved and consumed/rejected-back-to-approved, lease-guarded (ASVS 2.1.6). Omitting it
// here left renderPruneApprovalCard's status branch with no case for it, so a card in that state fell
// through to a bare badge with no explanatory sentence, unlike every other status.
export type PruneApprovalStatus = "requested" | "approved" | "applying" | "rejected" | "consumed" | "expired";

export interface PruneApproval {
  planHash: string;
  downpipeId: string;
  retainedRuns: number;
  supersededRuns: number;
  requestedBy: string;
  requestedAt: string;
  reason: string;
  status: PruneApprovalStatus;
  approvedBy?: string;
  approvedAt?: string;
  expiresAt: string;
  rejectReason?: PruneRejectReason;
}

// The fixed picker the checker chooses from (mirroring RESTORE_REJECT_REASONS): a closed enum, never
// free text, because the approver's prose would describe the customer's own archive contents and it would
// ride into the sealed support pack. Matches engine/src/admin/prune-approvals.ts's PRUNE_REJECT_REASONS.
export const PRUNE_REJECT_REASONS = ["stale-plan", "policy", "too-broad", "other"] as const;
export type PruneRejectReason = (typeof PRUNE_REJECT_REASONS)[number];

// The operator-facing label + the line the REQUESTER reads on the rejected card. Presentation only.
export const PRUNE_REJECT_REASON_COPY: Record<PruneRejectReason, { label: string; requesterLine: string }> = {
  "stale-plan": { label: "Stale plan", requesterLine: "the plan is out of date. Re-plan against the current runs and raise a fresh request." },
  policy: { label: "Against policy", requesterLine: "a governance rule does not permit this prune now. Check with your change approver before raising another." },
  "too-broad": { label: "Too broad", requesterLine: "the plan would supersede more than the cleanup calls for. Narrow the retention window first, then raise a fresh request." },
  other: { label: "Other", requesterLine: "the approver gave another reason. Ask them before raising a fresh request." },
};

// isPruneApproval / isPruneApprovalList mirror the narrowing discipline: a route the engine (or a
// demo/stub standing in for it) has not modelled is indistinguishable from a real success by status code
// alone, so the response shape is checked before any field is indexed.
export function isPruneApproval(v: unknown): v is PruneApproval {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.planHash === "string" && typeof o.downpipeId === "string" && typeof o.status === "string";
}
export function isPruneApprovalList(v: unknown): v is PruneApproval[] {
  return Array.isArray(v) && v.every(isPruneApproval);
}
