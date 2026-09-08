// The console identity mirror core (build contract section 1: the capability and role model). This is
// the client side of the engine's src/admin/identity.ts: the SAME Role union, Capability union,
// ROLE_CAPABILITIES map and can() lookup, so the console can show/hide an affordance with exactly
// the gate the engine enforces server-side. The engine is ALWAYS the enforcement point; this mirror
// is UX only and never a control. Mirrored byte-for-byte so the two sides cannot drift.
//
// This module holds the core role/capability model and the legacy cumulative ladder; the composable
// custom-role model lives in identity-custom-roles.ts and the personas in identity-personas.ts. They
// are re-exported through identity.ts so importers see one barrel and cannot drift.
//
// Node 25 strip-types compatible: no enums, explicit field declarations, no parameter properties.
// exactOptionalPropertyTypes is on; ReadonlySet keeps the capability sets immutable.

// AuthMethod: "access" is a verified Cloudflare Access JWT (attributable to an email); "passkey" is
// the engine's OWN WebAuthn sign-in (a passkey session cookie, also attributable to an email, the free
// front door independent of Cloudflare Access); "oidc" and "saml" are the engine's NATIVE IdP sessions
// (the merged, live native identity provider: an OIDC or SAML assertion the engine verified itself, and
// attributable to an email exactly as the other two are); "recovery" is a recovery-code sign-in (verified
// and attributable, but a break-glass-adjacent path worth naming); "token" is the ADMIN_TOKEN bearer
// fallback (the all-or-nothing owner break-glass, not attributable).
//
// It is mirrored byte-for-byte from the engine's src/admin/identity-roles.ts. It held THREE members while the
// engine minted six, and native IdP is merged and live, so every OIDC/SAML customer was handing this console a
// method it did not know: the trust chip fell through to the amber break-glass claim, telling those customers
// their fleet ran on the shared token. Drift in this union is not a cosmetic bug, it is a false claim about the
// customer's security posture.
export type AuthMethod = "access" | "passkey" | "oidc" | "saml" | "recovery" | "token";

// holdsFirstPartySession mirrors the engine's isCookieBorneMethod (src/admin/identity-roles.ts) over the console's
// narrower AuthMethod union: a caller authenticates via the engine's OWN ambient session cookie only when they
// signed in with a passkey. "access" presents a Cloudflare Access JWT and "token" a bearer, and NEITHER has a
// first-party session for the engine to manage.
//
// It exists for a real noise rule, and it is the difference between a signal and a phantom. The engine refuses
// "sign out my other sessions" with a 400 for a caller who holds no first-party session, and for an access/token
// caller THAT REFUSAL IS CORRECT AND EXPECTED (the screen says so). Claiming it as a refused privileged write wrote
// a guaranteed phantom row into every token-auth console's pack, and wrote it into the very row a genuine refusal
// coalesces into. A null caller (identity not yet resolved) reports false: we do not claim a write we cannot
// attribute.
export function holdsFirstPartySession(method: AuthMethod | undefined): boolean {
  return method === "passkey";
}

// The role union. The four original roles keep EXACTLY their current powers (so the engine's
// validate-rbac / validate-group-roles outcomes are unchanged); the two NEW roles are narrow:
//   - restore-operator: recovery only (request/apply/approve/drill), never data ops or people/keys.
//   - access-admin: people and access policy only, never data/restore/keys.
export type Role =
  | "viewer"
  | "operator"
  | "restore-operator" // NEW: recovery only
  | "approver"
  | "access-admin" // NEW: people and access policy only
  | "owner";

// The capability union. A capability is the unit a route gates on; can() reads ROLE_CAPABILITIES.
// restore.verify (restorability assurance) is a read-SAFE recoverability-proof capability: it gates the
// BLIND restore test and the KEYLESS integrity attestation, both of which prove a sealed archive can be
// recovered WITHOUT writing a byte back and WITHOUT surfacing any plaintext, so it sits in the read
// floor alongside restore.dryrun rather than implying restore.apply (proving recoverability is not the
// power to overwrite live data; the keyless attestation decrypts nothing at all).
export type Capability =
  | "downpipe.read" | "downpipe.write" | "downpipe.delete"
  | "run.trigger" | "drill.run"
  | "restore.dryrun" | "restore.verify" | "restore.request" | "restore.apply" | "restore.approve"
  | "roles.read" | "roles.write" | "access.policy"
  | "keys.ceremony"
  | "audit.read"
  | "notify.config" | "expiry.config" | "scheduledtest.config"
  | "reports.read"
  | "posture.read" | "posture.riskaccept";

// The capabilities every authenticated role holds (the read floor): the universal reads plus
// roles.read (anyone may read the role table) and the read-safe restore.verify (proving recoverability
// exposes nothing). Spread into each role below so the map is the single source of truth and the four
// original roles' totals stay in lockstep with the engine.
const READ_FLOOR: readonly Capability[] = [
  "downpipe.read",
  "audit.read",
  "restore.dryrun",
  "restore.verify",
  "reports.read",
  "posture.read",
  "roles.read",
];

// The data-operations bundle (operator/approver/owner): write/delete/trigger/drill plus the
// per-feature config gates the contract groups with data ops for the existing roles
// (notify/expiry/scheduledtest config), and the ability to RAISE a restore request.
const DATA_OPS: readonly Capability[] = [
  "downpipe.write",
  "downpipe.delete",
  "run.trigger",
  "drill.run",
  "notify.config",
  "expiry.config",
  "scheduledtest.config",
  "restore.request",
];

// ROLE_CAPABILITIES is the ONLY source of truth for what a role can do; can() reads it. It mirrors
// the engine's identity.ts table exactly (contract section 1). The four original roles keep their
// current powers: viewer (reads + dryrun), operator (data ops, no apply, no people), approver
// (operator + apply + approve), owner (everything). The two new roles are the narrow additions.
export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  // Viewer: reads + dry-run only.
  viewer: new Set<Capability>([...READ_FLOOR]),
  // Operator: data ops (write/delete/trigger/drill, notify/expiry/scheduledtest config) and may
  // raise a restore request, but cannot apply/approve, manage people, or run the key ceremony.
  operator: new Set<Capability>([...READ_FLOOR, ...DATA_OPS]),
  // Restore-operator: recovery only. It can run drills and the full restore lifecycle (request,
  // apply with an approval, approve), but cannot create/edit/delete or trigger downpipes, configure
  // notify/expiry, or manage people or keys. drill.run is part of the recovery surface: the contract
  // prose ("it can request, apply, approve, and drill") and the DR-responder persona ("run drills")
  // both grant it, and the engine's ROLE_CAPABILITIES (the enforcement authority this mirror must
  // match exactly) includes drill.run for restore-operator. The capability table's data-ops row,
  // which groups drill.run with the downpipe write/delete/trigger ops, is the outlier; the engine
  // table is authoritative, so this mirror holds drill.run to match it (validate-identity asserts
  // the two are byte-for-byte equal).
  "restore-operator": new Set<Capability>([
    ...READ_FLOOR,
    "drill.run",
    "restore.request",
    "restore.apply",
    "restore.approve",
  ]),
  // Approver: everything operator can do, plus apply + approve (dual control; maker != checker is
  // enforced server-side regardless of this capability).
  approver: new Set<Capability>([
    ...READ_FLOOR,
    ...DATA_OPS,
    "restore.apply",
    "restore.approve",
  ]),
  // Access-admin: people only. It can write the role table and the access policy, but holds no
  // data, restore, or key capability.
  "access-admin": new Set<Capability>([
    ...READ_FLOOR,
    "roles.write",
    "access.policy",
  ]),
  // Owner: every capability (the union of all of the above plus the owner-only ones).
  owner: new Set<Capability>([
    ...READ_FLOOR,
    ...DATA_OPS,
    "restore.apply",
    "restore.approve",
    "roles.write",
    "access.policy",
    "keys.ceremony",
    "posture.riskaccept",
  ]),
};

// can is the role-to-capability lookup the console gates every new affordance with. It mirrors the
// engine's can() exactly; it is the client mirror of the server gate, never the control itself.
export function can(role: Role, capability: Capability): boolean {
  const caps = ROLE_CAPABILITIES[role];
  return caps.has(capability);
}

// isRole is the runtime guard for a role string arriving from the engine or a form field, matching
// the engine's identity.ts isRole over the six-member union.
export function isRole(v: unknown): v is Role {
  return (
    v === "viewer" ||
    v === "operator" ||
    v === "restore-operator" ||
    v === "approver" ||
    v === "access-admin" ||
    v === "owner"
  );
}

// ALL_CAPABILITIES is the value-level companion to the Capability union (the union is type-only and
// cannot be iterated at runtime): the closed universe the capability matrix renders and the universe a
// proposed custom role's list is validated against. Kept in lockstep with the Capability union above.
export const ALL_CAPABILITIES: readonly Capability[] = [
  "downpipe.read", "downpipe.write", "downpipe.delete",
  "run.trigger", "drill.run",
  "restore.dryrun", "restore.verify", "restore.request", "restore.apply", "restore.approve",
  "roles.read", "roles.write", "access.policy",
  "keys.ceremony",
  "audit.read",
  "notify.config", "expiry.config", "scheduledtest.config",
  "reports.read",
  "posture.read", "posture.riskaccept",
];

// isCapability is the guard for a client-supplied capability string, mirroring the engine's
// isCapability: it rejects anything that is not one of the closed Capability values, so a crafted
// capability name cannot land in a composed custom role. A linear membership test over the small,
// fixed ALL_CAPABILITIES universe.
export function isCapability(v: unknown): v is Capability {
  return typeof v === "string" && (ALL_CAPABILITIES as readonly string[]).includes(v);
}

// ---- legacy cumulative-ladder helpers (the four original roles) -------------------------------
// roleRank / hasRole are the EXISTING cumulative ladder for the four original roles
// (viewer < operator < approver < owner), kept byte-for-byte so the shell, the command registry and
// the existing screens that gate "at least operator/approver" keep their exact behaviour and the
// validate-api rank assertions still pass. The TWO NEW roles are NOT on this linear ladder (they are
// capability SETS, not a rank), so they are mapped to rank 0 here: on the cumulative DATA ladder they
// hold no more than viewer's data-write power (restore-operator's recovery powers and access-admin's
// people powers are NOT expressible as "at least operator"). NEW code MUST gate with can(role, cap),
// never roleRank/hasRole, so a restore-operator's restore powers and an access-admin's people powers
// are surfaced by their real capability, not this conservative cumulative rank. Mapping them to 0
// keeps every legacy cumulative gate fail-safe: neither new role can ever falsely satisfy an
// "at least operator/approver/owner" check, so the ladder never over-grants.
export function roleRank(role: Role): number {
  switch (role) {
    case "viewer": return 0;
    case "operator": return 1;
    case "approver": return 2;
    case "owner": return 3;
    // The two new roles are off the cumulative ladder; rank 0 keeps legacy "at least X" gates
    // conservative (they gate by capability via can(), not by this rank).
    case "restore-operator": return 0;
    case "access-admin": return 0;
  }
}

// hasRole is the cumulative >= check the nav and the action registry use to show/hide a legacy
// capability. It mirrors the engine's per-route minimum for the four original roles; it is never the
// enforcement point, and new affordances gate with can() instead.
export function hasRole(role: Role, atLeast: Role): boolean {
  return roleRank(role) >= roleRank(atLeast);
}
