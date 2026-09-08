// Verified-identity (WhoAmI / Caller) mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

import type { Role, AuthMethod, Capability, CustomRole } from "../../identity.ts";

// RBAC mirror types. The Role and AuthMethod unions, the cumulative
// roleRank/hasRole ladder, and the full capability model (Capability, ROLE_CAPABILITIES, can,
// PERSONAS) live in lib/identity.ts (the byte-for-byte mirror of the engine's identity.ts) and are
// re-exported above so the existing "from ../api.ts" callers are unchanged. The console mirrors the
// engine's role for client gating, but the engine is the enforcement point; client gating is never
// the control.
//
// The identity contract shared by WhoAmI (the wire shape the engine reports) and Caller (the
// in-memory view the shell holds, resolved from whoami or a degraded default; Caller is not a
// wire type, the engine resolves its own server-side):
//   - subject is the STABLE, IMMUTABLE identity key (the engine's `iss|sub` from the verified Access
//     JWT): the principal authorisation is keyed on, NOT the
//     mutable email a recycled account could inherit (ASVS V10.3.3 / V10.5.2). The console keeps
//     DISPLAYING email (human-legible) and uses subject ONLY as the internal key where it mirrors
//     engine logic, never as an on-screen label (it is an opaque UUID). It is null on the token
//     fallback (the all-or-nothing owner break-glass cannot be attributed) and OPTIONAL on the wire,
//     so an engine that has not deployed it, a degraded default, or a fixture degrades to email-only
//     display without faking an identity key. Redaction-safe opaque id; never a secret/key/value.
//   - method drives the green (access) vs amber (token-fallback) Access verdict; email is the verified
//     Access email (null on the token fallback); sessionExpiresAt is the Access JWT exp in epoch
//     seconds; identityProvider is present only when the verified token carried it; both are
//     exactOptionalPropertyTypes-friendly (present only when known).
//   - isOnlyOwner lets the console pre-empt the last-Owner block without a second round trip.
//   - groups is the verified IdP group list that applied (the customer's own data; [] when none or on
//     the token path); roleSource is the honest basis of the resolved role so the console can explain
//     it.
//   - customRole / capabilities (WhoAmI) and customRole / customCapabilities (Caller) are present ONLY
//     when the effective authority is a NAMED custom role (roleSource "custom"): role is then the
//     "viewer" floor and the capability set is the real authority, so a new affordance can gate by the
//     same set the engine enforces and the console can pick the custom skin / landing. Both absent for
//     the six built-in roles. The capability set is a plain array (a Set does not serialise to JSON).
export interface WhoAmI {
  method: AuthMethod;
  subject?: string | null;
  email: string | null;
  role: Role;
  roleSource: RoleSource;
  groups: string[];
  identityProvider?: string;
  sessionExpiresAt?: number;
  isOnlyOwner: boolean;
  customRole?: CustomRole;
  capabilities?: Capability[];
}

// RoleSource is the honest basis of the resolved role, surfaced so the console can explain WHY
// a caller holds a role: "owner-token" is the bare-token break-glass; "email" is an explicit
// per-email grant; "group" is a role conferred only by an IdP group mapping; "custom" is a NAMED
// custom role conferred by an email grant or group mapping that referenced its name; "default" is the
// least-privilege resting state (viewer, no grant of either kind). Mirrored byte-for-byte from the
// engine's identity.ts so the two sides cannot drift.
export type RoleSource = "owner-token" | "email" | "group" | "custom" | "default";

export interface Caller {
  method: AuthMethod;
  subject?: string | null;
  email: string | null;
  role: Role;
  groups: string[];
  identityProvider?: string;
  sessionExpiresAt?: number;
  isOnlyOwner: boolean;
  customRole?: CustomRole;
  customCapabilities?: Capability[];
}
