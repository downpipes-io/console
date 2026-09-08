// Owner-action dual-control inbox types (the high-blast-radius mutations a SECOND owner must approve).
// Split out of the monolithic api.ts alongside the other per-domain type modules. OwnerActionQueued
// and isOwnerActionQueued live in ./updates.ts (the 202 body the deferring mutations return); this module
// carries the inbox/listing types and the caller-side result narrows that build on it. Redaction-safe by
// construction: every field is an id, a coarse kind, a pre-rendered summary, an email or a timestamp, never
// a value or a key.

import type { OwnerActionQueued } from "./updates.ts";

// OwnerActionResult is the discriminated result of a HIGH-BLAST-RADIUS OWNER MUTATION the owner-action
// dual-control gate may DEFER (the destination repoint/add/remove/default, the IdP connection
// create/delete/enable, the discovery-token set). When the org dual-control toggle is OFF (the default) the
// engine applies the mutation and answers the usual 2xx, so result is "result" and the success path is
// BYTE-UNCHANGED. When it is ON the engine RECORDS a pending owner action and answers HTTP 202 with the
// OwnerActionQueued body { ownerActionQueued:true, id, status:"pending" } WITHOUT applying anything: a SECOND
// owner must approve before the action runs. This type lets every gated mutation site narrow on result.status
// and surface "queued for a second owner to approve" (with the queued id, so it can point at the owner-action
// inbox) rather than a false "saved / removed / default set / connection created". It mirrors UpdateApplyResult
// (the apply/ramp shape applyUpdate already uses), but carries the full OwnerActionQueued body so a caller has
// the id to link with. No-custody: the queued body is { ownerActionQueued, id, status }, an owner-action record
// id only, never a value or a key.
export type OwnerActionResult<T> =
  | { status: "result"; value: T }
  | { status: "queued"; queued: OwnerActionQueued };

// isOwnerActionQueuedResult / isOwnerActionAppliedResult are the caller-side narrows on an OwnerActionResult,
// so a screen reads `if (isOwnerActionQueuedResult(res))` rather than re-deriving the discriminant. Pure.
export function isOwnerActionQueuedResult<T>(r: OwnerActionResult<T>): r is { status: "queued"; queued: OwnerActionQueued } {
  return r.status === "queued";
}

export function isOwnerActionAppliedResult<T>(r: OwnerActionResult<T>): r is { status: "result"; value: T } {
  return r.status === "result";
}

// OwnerActionKind is the closed set of high-blast-radius owner operations the dual-control gate covers,
// mirroring the engine's OwnerActionKind (engine src/admin/owner-action.ts). The console renders each to a
// human label (see OWNER_ACTION_KIND in lib/owner-actions.ts) and lists an unknown kind from a newer engine
// with its raw id (never dropped). It is the owner-action analogue of ConfigChangeKind.
export type OwnerActionKind =
  | "dest-set"
  | "dest-put"
  | "dest-remove"
  | "dest-default"
  | "update-apply"
  | "update-settle"
  | "idp-conn-create"
  | "idp-conn-delete"
  | "idp-conn-enabled"
  | "idp-conn-cert"
  | "break-glass-retire"
  | "discovery-token-set"
  | "discovery-accounts-set"
  | "sources-attach"
  | "support-credential-mint"
  | "push-dest-set"
  | "otlp-push-dest-set"
  | "dual-control-disable";

// OwnerActionStatus is a pending owner action's lifecycle state as the inbox listing reports it. The listing
// (GET /admin/owner-actions) returns only "pending" (awaiting a second owner) and "approved" (a distinct owner
// approved; the action is ARMED to execute, either DO-executed already or awaiting the maker's token re-submit
// for a router-executed kind); terminal records drop out of the listing. Mirrors the engine's OwnerActionStatus.
export type OwnerActionStatus = "pending" | "approved" | "executed" | "rejected" | "expired";

// OwnerAction is one queued high-blast-radius owner action the engine is holding for a SECOND owner, the
// redaction-safe inbox view returned by GET /admin/owner-actions (the engine's viewOwnerAction projection).
// id is the owner-action record id (the same id the deferred mutation's 202 returned); kind is the operation
// class; summary is the PLAIN-ENGLISH, redaction-safe description the engine pre-rendered (host/bucket/scope/
// connection id only, NEVER the secret), so the approver reviews the exact effect; proposedBy is the verified
// maker email; proposedBySubject is the maker's stable principal (the maker != checker axis); proposedAt /
// expiresAt are RFC-3339; status is the lifecycle state. params is the action's redaction-safe params (the
// engine STRIPS any live secret server-side before listing, the destination secret access key, the IdP client
// secret, the discovery token); the console renders only the summary, never raw params, so a credential can
// never reach the screen. approverSubject / approvedBy / approvedAt are present once a distinct owner approved
// an armed (router-executed) action. No-custody: every field is an id, a coarse kind, a redaction-safe summary,
// an email and a timestamp; never a value or a key. The console escapes every string on render.
export interface OwnerAction {
  id: string;
  kind: OwnerActionKind;
  summary: string;
  proposedBy: string;
  proposedBySubject: string | null;
  proposedAt: string;
  expiresAt: string;
  status: OwnerActionStatus;
  // params is carried REDACTION-SAFE (the engine strips secrets server-side); the console renders the summary,
  // not raw params, so this is present for completeness and a future detail view, never displayed verbatim.
  params?: unknown;
  approverSubject?: string;
  approvedBy?: string;
  approvedAt?: string;
}
