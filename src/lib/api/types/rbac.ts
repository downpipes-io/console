// RBAC role-table + dual-control restore-approval mirror types. See ../types.ts for the barrel.

import type { Role } from "../../identity.ts";

// ---- RBAC mirror: the role table row -------------------------------------
// RoleEntry is a projection of the engine's RoleEntry (identity.ts) with the engine's subject field
// stripped (display-only): a member keyed by the lowercased verified Access email, the role, who
// granted it and when, and an optional time-boxed expiry the engine treats as viewer once past. The
// console renders these escaped; it never decides a role (the engine does).
export interface RoleEntry {
  email: string;
  role: Role;
  grantedBy: string;
  grantedAt: string;
  expiresAt?: string;
  // customRole, when present, names a custom role this grant confers INSTEAD of the built-in role
  // (which the engine pins to "viewer" as the floor). The grant's authority is then the custom role's
  // capability set, resolved from the engine's custom-role table at request time. Present only on a
  // custom-role assignment (exactOptionalPropertyTypes).
  customRole?: string;
}

// RoleGrantResult is the setRole 200 body: a RoleEntry plus the OPTIONAL single-use, email-bound
// enrolment invite token the engine mints on a fresh grant ({...entry, inviteToken}). RoleEntry
// itself stays a byte-for-byte mirror of the engine's stored row, so the token lives on this
// grant-only extension rather than widening RoleEntry. The token is render-only (the copyable
// /#/register?invite= link), never persisted.
export interface RoleGrantResult extends RoleEntry {
  inviteToken?: string;
  // inviteState is the engine's EXPLICIT statement about the registration invite. A committed grant with no
  // inviteToken has several completely different meanings, which inviteState tells apart:
  //
  //   minted            an invite token was minted for a first-time grant (the token rides above).
  //   already-enrolled  no invite was needed: the grantee can already sign in and add keys via self-add.
  //   emailed-to-member the grantee enrolled before and has since lost every factor; the engine minted a
  //                     fresh set-up link but sends it only to the member's own address, never to the
  //                     caller (withholding it stops a roles.write holder enrolling a key in that member's
  //                     name). inviteNotice carries the operator-facing sentence.
  //   withheld          the same re-enrolment case, but the send failed, so nobody has the link yet.
  //                     inviteNotice says how the member can still get in (a banked recovery code) or how
  //                     to send a fresh one.
  //
  // A response carrying NEITHER a token nor this field is an engine that predates the mint, and the console
  // records that skew rather than guessing (roles-members.ts).
  inviteState?: "minted" | "already-enrolled" | "emailed-to-member" | "withheld";
  // inviteNotice is the operator-facing sentence that goes with "emailed-to-member" or "withheld". Absent
  // for every other inviteState.
  inviteNotice?: string;
}

const INVITE_STATES = ["minted", "already-enrolled", "emailed-to-member", "withheld"] as const;
type InviteState = (typeof INVITE_STATES)[number];

// inviteStateOf reads the engine's invite statement off a grant result, or null when the engine did not make
// one (an older build). Null is the SKEW signal, not a default: coercing it to "already-enrolled" would be the
// console asserting a fact the engine never claimed, which is the lie the gap is about.
export function inviteStateOf(value: RoleEntry): InviteState | null {
  const st = (value as RoleGrantResult).inviteState;
  return (INVITE_STATES as readonly string[]).includes(st as string) ? (st as InviteState) : null;
}

// inviteNoticeOf reads the operator-facing sentence the engine sends alongside "emailed-to-member" or
// "withheld", or null when the grant carries none (every other inviteState).
export function inviteNoticeOf(value: RoleEntry): string | null {
  const notice = (value as RoleGrantResult).inviteNotice;
  return typeof notice === "string" && notice !== "" ? notice : null;
}

// inviteTokenOf reads the optional enrolment token off a grant result without an unchecked as-cast:
// it narrows through RoleGrantResult and returns the non-empty string token, or null when the
// engine returned none.
export function inviteTokenOf(value: RoleEntry): string | null {
  const token = (value as RoleGrantResult).inviteToken;
  return typeof token === "string" && token !== "" ? token : null;
}

// GroupRole is the set of roles a group claim may confer: ANY role EXCEPT owner. Owner stays
// explicit per-email; a group can never be mapped to owner (the engine refuses with a 400, and
// this type stops the console even constructing the request).
export type GroupRole = Exclude<Role, "owner">;

// GroupRoleEntry mirrors the engine's GroupRoleEntry (scheduler-do.ts) byte-for-byte: one row of
// the optional identity-provider group->role mapping. group is the customer's own IdP group name
// (redaction-safe directory data). role is any role except owner at write time (a group can never
// map to owner). grantedBy is the Owner email that set it; grantedAt is RFC-3339 UTC millis.
export interface GroupRoleEntry {
  group: string;
  role: Role;
  grantedBy: string;
  grantedAt: string;
  // customRole, when present, names a custom role this group mapping confers INSTEAD of the built-in
  // role (which the engine pins to "viewer"). Present only on a group-to-custom-role mapping.
  customRole?: string;
  // connId, when present, scopes the mapping to sign-ins through that one identity provider connection;
  // absent means global. A mapping's identity is (group, connId), so one group name can have a global row
  // and scoped rows. A delete names the row by both.
  connId?: string;
}

// ---- Dual-control mirror: the restore approval ---------------------------
// ApprovalStatus / RestoreApproval mirror the engine's approvals.ts. The record binds an approval
// to the plan hash; approvedBy MUST differ from requestedBy (maker != checker), enforced
// server-side. The console shows the blast-radius cues (isLatest, plannedWrites, bytes,
// redirectBinding) so an Approver reviews the exact impact, and escapes every string.
//
// "applying" is a real reservation-lease state (RESTORE_APPLY_LEASE_MS): the engine's ApprovalStatus
// (engine/src/admin/approvals.ts) returns it from effectiveStatus while an apply is in flight, and GET
// /restore/approvals returns it verbatim. It is listed here explicitly, matching PruneApprovalStatus
// (restore-flow/prune-approvals.ts), so code can branch on it directly (e.g. "someone else is applying
// this restore right now") rather than relying on a generic string fallback. findUsableApproval
// (shared.ts) requires status === "approved" exactly, so "applying" is never treated as approved.
export type ApprovalStatus = "requested" | "approved" | "applying" | "rejected" | "consumed" | "expired";

export interface RestoreApproval {
  planHash: string;
  runId: string;
  isLatest: boolean;
  plannedWrites: number;
  bytes: number;
  redirectBinding: string | null;
  requestedBy: string;
  requestedAt: string;
  reason: string;
  status: ApprovalStatus;
  approvedBy?: string;
  approvedAt?: string;
  expiresAt: string;
  // rejectReason: WHY the checker turned this restore down, as a CLOSED enum, so the requester's "why was
  // my restore rejected?" has an answer in the console, the engine's record and the audit event. Absent
  // on records rejected before it shipped.
  rejectReason?: RestoreRejectReason;
  // plan is the exact object the engine hashed into planHash (PlanBinding in the engine's restorePlanHash,
  // engine/src/admin/approvals.ts), so what the approver reviews is exactly what the approval authorises,
  // never a separate summary the two could disagree on. Absent on an approval from an engine that predates
  // it, or a record stored before the upgrade: the console must never read an absent plan as "original
  // bindings" (approvals.ts planWriteTargetNode). It never carries a token, a secret value or a key.
  plan?: RestoreApprovalPlan;
}

// RestoreApprovalPlan mirrors the engine's plan shape byte for byte (engine/src/admin/approvals.ts). target
// null or with every field absent means every record writes back to its original binding; otherwise each
// present field is a write that bypasses that binding. destinationId names the archive copy the restore
// reads from: a read source, and the console must never present it as a write target.
export interface RestoreApprovalPlan {
  runId: string;
  target: { binding?: string; namespaceId?: string; bucketName?: string } | null;
  include: string[];
  exclude: string[];
  maxRecords?: number;
  recordName?: string;
  destinationId?: string;
  cfConfig?: { accountId: string; zoneId?: string; surfaces: string[] };
  mediaRestore?: { accountId: string };
  d1Tables?: { database: string; tables: string[]; createOnly?: true };
  // onExisting "skip" leaves a live record with the same name as it is; absent means overwrite, the
  // documented default.
  onExisting?: "skip";
}

// The fixed picker the checker chooses from. A closed enum and NEVER free text: the approver's prose
// would describe the very data they are refusing to touch, and it would ride into the sealed support pack.
// Each member maps to a different remedy, which is what makes it worth carrying.
export const RESTORE_REJECT_REASONS = ["wrong-target", "too-broad", "stale-plan", "policy", "other"] as const;
export type RestoreRejectReason = (typeof RESTORE_REJECT_REASONS)[number];

// The operator-facing label + the line the REQUESTER reads on the rejected card. Presentation only.
export const RESTORE_REJECT_REASON_COPY: Record<RestoreRejectReason, { label: string; requesterLine: string }> = {
  "wrong-target": { label: "Wrong target", requesterLine: "the plan writes to the wrong target. Raise a fresh request against the correct binding or bucket." },
  "too-broad": { label: "Too broad", requesterLine: "the plan restores more than the incident calls for. Raise a narrower request." },
  "stale-plan": { label: "Stale plan", requesterLine: "the plan is out of date. Re-plan against the current run and raise a fresh request." },
  policy: { label: "Against policy", requesterLine: "a governance rule does not permit this restore now. Check with your change approver before raising another." },
  other: { label: "Other", requesterLine: "the approver gave another reason. Ask them before raising a fresh request." },
};
