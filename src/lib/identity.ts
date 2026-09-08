// The console identity mirror (build contract section 1: the capability and role model). This is the
// client side of the engine's src/admin/identity.ts: the SAME Role union, Capability union,
// ROLE_CAPABILITIES map and can() lookup, so the console can show/hide an affordance with exactly the
// gate the engine enforces server-side. The engine is ALWAYS the enforcement point; this mirror is UX
// only and never a control. Mirrored byte-for-byte so the two sides cannot drift.
//
// This file is the BARREL: the model split into three cohesive sibling modules so no single file is an
// over-large god module, and re-exported here so every importer continues to import from lib/identity.ts
// with its public surface unchanged:
//   - identity-model.ts: the core Role/Capability/AuthMethod unions, ROLE_CAPABILITIES, can/isRole,
//     ALL_CAPABILITIES/isCapability and the legacy cumulative ladder (roleRank/hasRole);
//   - identity-custom-roles.ts: the composable custom-role model (types, name pattern, the
//     edit-requires-write-cap guardrails, validateCustomRole and the caller/surface/preset resolvers);
//   - identity-personas.ts: the job-title -> recommended-role persona suggestion set.
// The diff that introduced this barrel MOVED code only; no logic changed, so validate-identity's
// byte-for-byte assertions against the engine still hold.

export type { AuthMethod, Capability, Role } from "./identity-model.ts";
export {
  ALL_CAPABILITIES,
  can,
  hasRole,
  holdsFirstPartySession,
  isCapability,
  isRole,
  ROLE_CAPABILITIES,
  roleRank,
} from "./identity-model.ts";

export type {
  CustomRole,
  CustomRoleProposal,
  Presentation,
  SurfaceMode,
} from "./identity-custom-roles.ts";
export {
  builtinPreset,
  callerCan,
  callerEffectiveCapabilities,
  capabilitiesOfCustomRole,
  CUSTOM_ROLE_NAME_PATTERN,
  isScreen,
  OWNER_RESERVED_CAPABILITIES,
  resolvePresentation,
  resolveSurface,
  SCREEN_WRITE_CAPABILITY,
  surfaceMode,
  titleCaseRole,
  validateCustomRole,
} from "./identity-custom-roles.ts";

export type { Persona } from "./identity-personas.ts";
export { PERSONAS } from "./identity-personas.ts";
