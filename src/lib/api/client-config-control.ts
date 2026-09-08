// Config change-control + read-only config version-history domain functions for the EngineClient. Free
// functions over the shared Transport.
//
// An account can REQUIRE that every config mutation (saving a downpipe, setting a role or custom role, a
// notify channel/rule/webhook, a posture risk-accept, an expiry item) be approved by a SECOND authorised
// identity before it applies (maker != checker). When the policy is ON the engine answers a config mutation
// with HTTP 202 + { queued: true, id, status, contentHash } (handled centrally by parseJsonOrPending) and
// queues the change for review. This block is the policy read/write + the pending-change inbox
// (list/approve/reject), the config-mutation analogue of the restore dual-control approvals.
//
// Authority (the ENGINE enforces; this mirror is UX only): reading the policy and the pending list is any
// authenticated role (downpipe.read, the read floor). Setting the policy is OWNER-ONLY. ARMING (off -> on)
// is immediate; DISARMING (on -> off) is itself gated by the owner-action dual-control layer (a lone owner's
// disarm queues for a second owner rather than applying -- see setConfigApprovalPolicy below). Approving/
// rejecting a change requires the approver to hold the change's OWN write capability AND to differ from the
// proposer (maker != checker); the engine refuses a self-approval and a missing capability.

import type { Transport } from "./client-transport.ts";
import { engineFetch } from "./engine-fetch.ts";
import type {
  ConfigApprovalPolicy,
  ConfigChange,
  ConfigDiffResult,
  ConfigHistory,
  ConfigSnapshotResult,
  ConfigVersionResult,
  OwnerActionResult,
} from "./types.ts";

// getConfigApprovalPolicy returns whether config changes currently require a second approver. Any
// authenticated role may read it (downpipe.read).
export async function getConfigApprovalPolicy(t: Transport): Promise<ConfigApprovalPolicy> {
  const r = await engineFetch(`${t.base}/admin/config/approval-policy`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<ConfigApprovalPolicy>(r, "get config approval policy");
}

// setConfigApprovalPolicy turns the four-eyes gate on or off. OWNER-ONLY, enforced server-side. ARMING (off
// -> on) applies immediately. DISARMING (on -> off) is the engine's asymmetric off-switch
// (router-config-version.ts / scheduler-do-routing-config.ts): an attributable owner's disarm is itself
// routed through the owner-action dual-control gate (kind "dual-control-disable"), so a LONE owner's disarm
// QUEUES for a SECOND owner (202 + the OwnerActionQueued body) rather than applying -- the policy stays ON.
// parseJsonOrOwnerAction is the correct read for exactly this reason: the plain parseJson this used to
// call cannot tell a queued 202 from an applied one, so it cast the queued body
// {ownerActionQueued,id,status} straight to ConfigApprovalPolicy, and requireConfigApproval read back as
// undefined (falsy) -- an owner who queued a disarm was told the gate had already turned off, while it was,
// correctly, still on.
export async function setConfigApprovalPolicy(t: Transport, requireConfigApproval: boolean): Promise<OwnerActionResult<ConfigApprovalPolicy>> {
  const r = await engineFetch(`${t.base}/admin/config/approval-policy`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ requireConfigApproval }) }, { adminOp: "approval-policy-set" });
  return t.parseJsonOrOwnerAction<ConfigApprovalPolicy>(r, "set config approval policy");
}

// setChangeNumberPolicy turns the OWNER-OPT-IN "Require Change Number" change-management policy on or off.
// OWNER-ONLY, enforced server-side; it applies immediately and is audited. The engine returns the new flag.
// It is read back via getConfigApprovalPolicy (whose view carries requireChangeNumber alongside the
// dual-control flag), so this returns only the one flag it sets.
export async function setChangeNumberPolicy(t: Transport, requireChangeNumber: boolean): Promise<{ requireChangeNumber: boolean }> {
  const r = await engineFetch(`${t.base}/admin/config/change-number-policy`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ requireChangeNumber }) }, { adminOp: "change-number-policy-set" });
  return t.parseJson<{ requireChangeNumber: boolean }>(r, "set change number policy");
}

// setRestoreApprovalPolicy turns the OWNER-OPT-IN second-approver requirement on a RESTORE APPLY on or off.
// OWNER-ONLY, enforced server-side; it applies immediately and is audited.
//
// IT IS A DIFFERENT POLICY FROM setConfigApprovalPolicy, not a second name for it. That one gates config
// MUTATIONS and carries the asymmetric off switch (a disarm queues for a second owner, hence
// parseJsonOrOwnerAction there). This one gates a WRITE-BACK OVER LIVE DATA, applies in both directions
// immediately, and so reads with the plain parseJson.
//
// ARMING CAN BE REFUSED, and the refusal is the useful part: the engine holds a two-identity floor, because
// an approval must come from someone other than the requester, so arming on a one-identity estate would
// leave nobody able to approve a restore. The thrown error carries the engine's sentence, which names the
// remedy (appoint a second Owner or Approver first) rather than only the refusal.
export async function setRestoreApprovalPolicy(t: Transport, requireRestoreApproval: boolean): Promise<{ requireRestoreApproval: boolean }> {
  const r = await engineFetch(`${t.base}/admin/config/restore-approval-policy`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ requireRestoreApproval }) });
  return t.parseJson<{ requireRestoreApproval: boolean }>(r, "set restore approval policy");
}

// getAttendedCadence reads the estate-wide attended-verification interval in whole days, 0 when none is
// stated. Readable by anyone who can view the config (downpipe.read): it is one integer, it names no run and
// carries no proof history, so rendering the estate's stated rhythm is not a disclosure.
export async function getAttendedCadence(t: Transport): Promise<{ attendedCadenceDays: number }> {
  const r = await engineFetch(`${t.base}/admin/config/attended-cadence`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<{ attendedCadenceDays: number }>(r, "read the attended-verification cadence");
}

// setAttendedCadence states the estate-wide attended-verification interval. OWNER-ONLY, enforced server-side
// (the engine's DO re-resolves the caller, so this is not the only gate), applied immediately and audited
// with the new interval, because lengthening a proof interval is exactly the change a reviewer needs to see.
// 0 clears the cadence; the engine refuses anything outside 0 or 1 to 3650.
export async function setAttendedCadence(t: Transport, attendedCadenceDays: number): Promise<{ attendedCadenceDays: number }> {
  const r = await engineFetch(`${t.base}/admin/config/attended-cadence`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ attendedCadenceDays }) });
  return t.parseJson<{ attendedCadenceDays: number }>(r, "set the attended-verification cadence");
}

// setSignInContextPolicy turns the OWNER-OPT-IN unusual-location sign-in notify on or off.
// OWNER-ONLY, enforced server-side; it applies immediately and is audited. Read back via
// getConfigApprovalPolicy (whose view carries notifyNewSignInContext), so this returns the one flag it sets.
//
// ROUTED THROUGH gatedFetch, and this half must land BEFORE the engine gates the route.
// The step-up ceremony lives in
// Transport.gatedFetch, not in bare engineFetch: a plain caller meeting a 401 { stepUpRequired: true } shows
// the operator an authentication error instead of a passkey prompt. So gating the engine first would turn a
// working toggle into a dead end for every cookie-borne owner.
//
// Why this toggle is worth the ceremony at all: turning the notify OFF is the move an attacker makes BEFORE
// the attempt, not after. It is the same argument that already gates /notify/rules, and it is stronger here
// because there is no undo prompt and no visible effect, which is the exact profile the step-up gate exists
// for. gatedFetch only acts on a step-up 401, so the 200 path is unchanged for any caller the engine does
// not challenge, including bare-token and Access callers, which stay exempt.
export async function setSignInContextPolicy(t: Transport, notifyNewSignInContext: boolean): Promise<{ notifyNewSignInContext: boolean }> {
  const r = await t.gatedFetch(`/admin/config/signin-context-policy`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ notifyNewSignInContext }) }, { adminOp: "signin-context-set" });
  return t.parseJson<{ notifyNewSignInContext: boolean }>(r, "set sign-in context policy");
}

// listConfigChanges returns the pending config changes awaiting a second approver, each with its
// plain-English diff, who proposed it and when, and its status. Any authenticated role may read it
// (downpipe.read); the inbox shows the proposer their own queued change too (with Approve disabled).
export async function listConfigChanges(t: Transport): Promise<ConfigChange[]> {
  const r = await engineFetch(`${t.base}/admin/config/changes`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<ConfigChange[]>(r, "list config changes");
}

// approveConfigChange approves a pending change by id, applying it. The approver MUST hold the change's
// own write capability AND differ from the proposer (maker != checker); the engine refuses a
// self-approval (a 400/403 the inbox surfaces inline). The console mirrors the maker != checker + the
// capability gate so the button is never a dead end, but the engine is the authority.
export async function approveConfigChange(t: Transport, id: string): Promise<ConfigChange> {
  const r = await t.gatedFetch(`/admin/config/changes/${encodeURIComponent(id)}/approve`, { method: "POST", headers: t.headers(), credentials: "include" });
  return t.parseJsonOrReason<ConfigChange>(r, "approve config change");
}

// rejectConfigChange rejects a pending change by id (it is not applied). Same authority as approve
// (the change's write capability); a rejecter who is the proposer is allowed (you may withdraw your own).
export async function rejectConfigChange(t: Transport, id: string): Promise<ConfigChange> {
  const r = await engineFetch(`${t.base}/admin/config/changes/${encodeURIComponent(id)}/reject`, { method: "POST", headers: t.headers(), credentials: "include" });
  return t.parseJsonOrReason<ConfigChange>(r, "reject config change");
}

// The engine versions its OWN governance configuration: every config mutation captures a hash-chained,
// signed snapshot, so an operator gets a git-style history plus a plain-English (Australian) diff. These four
// readers mirror that surface. Reading the history/version/diff is gated on downpipe.read (any authenticated
// role, the read floor); a MANUAL snapshot is a config-policy act gated on access.policy (Owner /
// access-admin). No-custody: every shape is an id, a timestamp, an author email, a hash label, a
// redaction-safe summary/diff line; never a value or a key. There is NO config rollback endpoint, so this
// surface is read-only history plus the manual snapshot capture (rollback is not delivered).

// getConfigHistory returns the version headers newest-first, the chain head, and the verify verdict
// (the recomputed hash chain + signed digests), so the console can show the timeline AND an honest
// chain-intact / first-broken-version badge. Readable by any authenticated role (downpipe.read).
export async function getConfigHistory(t: Transport): Promise<ConfigHistory> {
  const r = await engineFetch(`${t.base}/admin/config/history`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<ConfigHistory>(r, "get config history");
}

// getConfigVersion returns one full version (the header + the normalised posture snapshot) by id, or
// { found: false } for an unknown/aged-out id. The console shows the snapshot read-only (downpipe.read).
export async function getConfigVersion(t: Transport, id: number): Promise<ConfigVersionResult> {
  const r = await engineFetch(`${t.base}/admin/config/version?id=${encodeURIComponent(String(id))}`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<ConfigVersionResult>(r, "get config version");
}

// getConfigDiff returns the plain-English (Australian) change list between two versions (from -> to), or
// { found: false } when either id is unknown. The engine pre-renders each line so the console never
// re-derives a diff; it reads only the snapshots' named metadata, never a secret (downpipe.read).
export async function getConfigDiff(t: Transport, from: number, to: number): Promise<ConfigDiffResult> {
  const r = await engineFetch(`${t.base}/admin/config/diff?from=${encodeURIComponent(String(from))}&to=${encodeURIComponent(String(to))}`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<ConfigDiffResult>(r, "get config diff");
}

// snapshotConfig captures the CURRENT posture as a new signed history version now. It is a config-policy
// act (access.policy: Owner / access-admin), enforced server-side; the engine de-dupes against the head,
// so a snapshot of an unchanged posture returns { created: false } rather than churning a version. No
// body is sent (the engine captures what is already stored; this is observability, not a config write).
export async function snapshotConfig(t: Transport): Promise<ConfigSnapshotResult> {
  const r = await engineFetch(`${t.base}/admin/config/snapshot`, { method: "POST", headers: t.headers(), credentials: "include" });
  return t.parseJson<ConfigSnapshotResult>(r, "snapshot config");
}
