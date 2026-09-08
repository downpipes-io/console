// Role-based access control domain functions for the EngineClient (split from client.ts per findings
// console-src-010-01 / console-sys-arch-01 / console-sys-struct-03): the in-account role table, the
// identity-provider group->role mapping, and the composable custom roles. Free functions over the shared
// Transport; request URL/method/body/headers and parse logic moved VERBATIM.
//
// The role table is keyed by the verified Access email. Reading it is allowed for any authenticated role;
// writing (setRole/deleteRole) is Owner-only and enforced SERVER-SIDE (the engine is the control; the
// console mirror is UX only). The last-Owner guard (F3) and maker-side checks live in the engine.

import { engineFetch } from "./engine-fetch.ts";
import type { Role, CustomRole, CustomRoleProposal } from "../identity.ts";
import type { Transport } from "./client-transport.ts";
import type { GroupRole, GroupRoleEntry, MutationResult, RequireAccessPreflight, RoleEntry } from "./types.ts";

// requireAccessPreflight asks the engine whether the shared admin token can safely be closed off, and how
// this caller got in. It is gated on access.policy, the same people-and-access-policy capability as the role
// table, which is why it sits beside it here.
//
// It is a READ that happens to be a POST: the engine stores nothing (ADMIN_TOKEN_DISABLED is an env var the
// console cannot write, by no-custody design) and returns only booleans plus the caller's own auth method.
// The console consults it BEFORE it advises deleting or disabling the token, because that act is out of band
// and irreversible from the app: with no second factor enrolled it locks the operator out, and the in-app
// recovery paths need a working credential too. A refusal is surfaced with the engine's own lockoutWarning.
export async function requireAccessPreflight(t: Transport): Promise<RequireAccessPreflight> {
  const r = await engineFetch(`${t.base}/admin/policy/require-access`, { method: "POST", headers: t.headers(), credentials: "include" });
  return t.parseJson<RequireAccessPreflight>(r, "require access preflight");
}

export async function listRoles(t: Transport): Promise<RoleEntry[]> {
  const r = await engineFetch(`${t.base}/admin/roles`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<RoleEntry[]>(r, "roles");
}

// setRole upserts a member's role. exactOptionalPropertyTypes: expiresAt is added only when a
// value is supplied (a time-boxed grant), matching the engine's optional field. It is a config
// mutation the change-control gate can defer, so it resolves to a MutationResult (applied vs pending).
export async function setRole(t: Transport, email: string, role: Role, expiresAt?: string): Promise<MutationResult<RoleEntry>> {
  const body: { email: string; role: Role; expiresAt?: string } = { email, role, ...(expiresAt !== undefined ? { expiresAt } : {}) };
  const r = await t.gatedFetch("/admin/roles", { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify(body) }, { adminOp: "role-set" });
  return t.parseJsonOrPending<RoleEntry>(r, "set role");
}

// deleteRole removes a member's grant. role-delete is a CHANGE-CONTROL GATED mutation (engine
// change-control.ts maps POST /roles/delete -> gatedConfigMutation("role-delete")): with the gate armed the
// engine answers 202 { queued: true, id } and writes NOTHING, so the member KEEPS their grant, queued for a
// second approver. This read used parseJson, whose only test is `!r.ok` -- and a 202 IS ok -- so the queued
// body parsed and resolved as a successful delete: the screen toasted "Removed <member>" and dropped the row
// while the member's full access PERSISTED. Its sibling
// setRole already reads the same gate's 202 honestly via parseJsonOrPending; the asymmetry was the bug. That
// decoder tells applied from queued: a 202 with the pending shape resolves to { status:"pending" } the caller
// surfaces as "queued for approval", and a malformed 202 throws the honest answer-unreadable error, never a
// false removal.
export async function deleteRole(t: Transport, email: string): Promise<MutationResult<{ deleted: boolean }>> {
  const r = await t.gatedFetch("/admin/roles/delete", { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ email }) }, { adminOp: "role-delete" });
  return t.parseJsonOrPending<{ deleted: boolean }>(r, "delete role");
}

// The group-role mapping lets an org using Cloudflare Access (federating an IdP) drive downpipe roles from
// IdP groups instead of (or in addition to) per-email grants. It is purely additive; an account that never
// configures it behaves exactly as the per-email table. Reading is allowed for any authenticated role;
// writing (setGroupRole/deleteGroupRole) is Owner-only, enforced SERVER-SIDE. A group can never be mapped
// to owner (the engine refuses with a 400).
export async function listGroupRoles(t: Transport): Promise<GroupRoleEntry[]> {
  const r = await engineFetch(`${t.base}/admin/group-roles`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<GroupRoleEntry[]>(r, "list group roles");
}

// setGroupRole upserts a group->role mapping. role is constrained to GroupRole (any role EXCEPT
// owner): the capability model (build contract section 1) lets a group claim confer
// viewer/operator/restore-operator/approver/access-admin, but NEVER owner (owner stays explicit
// per-email; the group-role cap changed from "max approver" to "any role except owner"). The
// engine enforces this at the authority boundary with a 400, and the type prevents the caller from
// even constructing an owner request. exactOptionalPropertyTypes: no optional fields here.
export async function setGroupRole(t: Transport, group: string, role: GroupRole): Promise<MutationResult<GroupRoleEntry>> {
  const r = await t.gatedFetch("/admin/group-roles", { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ group, role }) }, { adminOp: "group-role-set" });
  return t.parseJsonOrPending<GroupRoleEntry>(r, "set group role");
}

// deleteGroupRole removes a group->role mapping. group-role-delete is a CHANGE-CONTROL GATED mutation (engine
// maps POST /group-roles/delete -> gatedConfigMutation("group-role-delete")): with the gate armed the engine
// answers 202 { queued: true, id } and writes nothing, so the mapping still stands, queued for a second
// approver. Like deleteRole (B8c), this read used parseJson and coerced that queued 202 into a false "mapping
// removed". parseJsonOrPending -- the decoder its sibling setGroupRole uses -- resolves the queued 202 to
// { status:"pending" } honestly and throws answer-unreadable on a malformed one, never a false removal.
export async function deleteGroupRole(t: Transport, group: string): Promise<MutationResult<{ deleted: boolean }>> {
  const r = await t.gatedFetch("/admin/group-roles/delete", { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ group }) }, { adminOp: "group-role-delete" });
  return t.parseJsonOrPending<{ deleted: boolean }>(r, "delete group role");
}

// A custom role is an account-defined, NAMED bundle of capabilities composed for the org. Reading the
// catalogue (GET) is allowed for any authenticated role (it is the customer's own role catalogue, never a
// secret; the console escapes the names/labels on render). Creating and deleting are gated on the
// access.policy capability SERVER-SIDE, and the engine re-runs the HARD guardrails (no privilege escalation,
// owner-reserved caps barred, edit-requires-write-cap) against the creator's OWN resolved capability set, so
// a creator can never compose a role more powerful than themselves. The console mirrors the same
// validateCustomRole before POSTing so it never offers a payload the engine would 400, but the engine is the
// enforcement point.

// listCustomRoles returns the custom-role catalogue (any authenticated role may read it).
export async function listCustomRoles(t: Transport): Promise<CustomRole[]> {
  const r = await engineFetch(`${t.base}/admin/custom-roles`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<CustomRole[]>(r, "list custom roles");
}

// createCustomRole creates or updates a custom role from a composed proposal. The engine validates
// and stamps createdBy/createdAt, returning the stored CustomRole; a guardrail/validation failure is
// a 400 { error } the builder surfaces inline. access.policy (Owner or access-admin) server-side.
export async function createCustomRole(t: Transport, proposal: CustomRoleProposal): Promise<MutationResult<CustomRole>> {
  const r = await t.gatedFetch("/admin/custom-roles", { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify(proposal) }, { adminOp: "custom-role-create" });
  return t.parseJsonOrPending<CustomRole>(r, "create custom role");
}

// deleteCustomRole removes a custom role by name (POST-to-delete, consistent with the other deletes).
// Deleting an absent role is an idempotent { deleted: false }. Any grant still referencing the
// deleted role falls back to the viewer floor at resolution server-side (never fails open).
//
// custom-role-delete is a CHANGE-CONTROL GATED mutation (engine change-control.ts). With the gate armed the
// engine answers 202 { pending: true, id } and writes NOTHING: the role still exists, queued for a second
// approver. This read used parseJson, whose only test is `!r.ok` -- and a 202 IS ok -- so the queued body parsed
// and resolved as a successful delete. The screen then toasted "Deleted custom role", reloaded the catalogue
// (which still held the role), and recorded a downgrade of N members that had not happened. parseJsonOrPending
// is what its own sibling createCustomRole has always used, and it is the one that tells the two apart.
export async function deleteCustomRole(t: Transport, name: string): Promise<MutationResult<{ deleted: boolean }>> {
  const r = await t.gatedFetch("/admin/custom-roles/delete", { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ name }) }, { adminOp: "custom-role-delete" });
  return t.parseJsonOrPending<{ deleted: boolean }>(r, "delete custom role");
}

// assignCustomRole grants a member a NAMED custom role instead of a built-in role. It reuses the same
// POST /admin/roles upsert as setRole, but carries the custom-role name (the engine pins the stored
// built-in role to the viewer floor and resolves the authority from the custom role's capability set
// at request time). Owner/access-admin (roles.write) server-side; exactOptionalPropertyTypes:
// expiresAt is added only for a time-boxed grant.
export async function assignCustomRole(t: Transport, email: string, customRole: string, expiresAt?: string): Promise<MutationResult<RoleEntry>> {
  const body: { email: string; customRole: string; expiresAt?: string } = { email, customRole, ...(expiresAt !== undefined ? { expiresAt } : {}) };
  const r = await t.gatedFetch("/admin/roles", { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify(body) }, { adminOp: "role-set" });
  return t.parseJsonOrPending<RoleEntry>(r, "assign custom role");
}

// assignGroupCustomRole maps an identity-provider group to a NAMED custom role (the group-mapping
// equivalent of assignCustomRole). It reuses POST /admin/group-roles, carrying the custom-role name;
// the engine pins the stored role to the viewer floor and resolves the capability set from the custom
// role at request time. access.policy server-side.
export async function assignGroupCustomRole(t: Transport, group: string, customRole: string): Promise<MutationResult<GroupRoleEntry>> {
  const r = await t.gatedFetch("/admin/group-roles", { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ group, customRole }) }, { adminOp: "group-role-set" });
  return t.parseJsonOrPending<GroupRoleEntry>(r, "assign group custom role");
}
