// A typed client for the in-account engine admin API. The console is the only caller;
// requests carry the operator's Cloudflare Access session (cookies, sent automatically)
// or a bearer token. No request ever goes to the vendor.
//
// This module is now a thin BARREL: the EngineClient, the wire/mirror types, and the
// engine-origin + plan-hash helpers live under ./lib/api/ and are re-exported here so every
// existing "from ../api.ts" / "./api.ts" caller keeps working unchanged.

// Re-export the identity mirror (build contract section 1) from api.ts so the existing callers that
// import Role / AuthMethod / roleRank / hasRole "from ../api.ts" keep working unchanged while the
// single source of truth lives in lib/identity.ts (the Role/Capability/ROLE_CAPABILITIES/can/PERSONAS
// mirror of the engine). New code should import the capability model (Capability, can, PERSONAS)
// directly from lib/identity.ts and gate affordances with can(role, capability).
export { roleRank, hasRole } from "./lib/identity.ts";
export type { Role, AuthMethod } from "./lib/identity.ts";
// Re-export the custom-role model so callers that read the engine's custom-role CRUD + assignment from
// api.ts get the same types (CustomRole/CustomRoleProposal/Capability/Presentation/SurfaceMode) without
// a second import; the single source of truth still lives in lib/identity.ts (the engine mirror).
export type { Capability, CustomRole, CustomRoleProposal, Presentation, SurfaceMode } from "./lib/identity.ts";

// The wire/mirror types + the runtime guards, and the EngineClient itself, re-exported verbatim so the
// barrel's surface is unchanged.
export * from "./lib/api/types.ts";
export * from "./lib/api/client.ts";
// The helpers: re-export ONLY the symbols that were public on api.ts before the split (the engine-origin
// validator, the state-mapping boundary, and the two plan-hash / cost projections). The transport guard
// and the canonical-JSON internals stay module-private to lib/api, exactly as they were here.
export { mapEngineDownpipeState, engineOriginError, projectMonthlyKVReads, restorePlanHash } from "./lib/api/helpers.ts";
