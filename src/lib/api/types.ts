// Wire and mirror type definitions for the in-account engine admin API, split out of api.ts so
// the barrel stays thin. Every shape here is redaction-safe by construction and the runtime guards
// are pure. Re-exported verbatim from ./api.ts, so callers that import from there are unchanged.
//
// This module was itself split by domain into ./types/<domain>.ts (move-only, a god-module split):
// the definitions moved verbatim into sibling modules and are RE-EXPORTED here, so every importer
// (api.ts does `export *` from this file) sees the identical surface. The only cross-module type
// references are the engine identity mirror (Role / AuthMethod / Capability / CustomRole, imported
// from ../identity.ts where needed) and CanaryLiveness (canary -> updates).

export * from "./types/config-changes.ts";
export * from "./types/config-history.ts";
export * from "./types/sources.ts";
export * from "./types/destinations.ts";
export * from "./types/keys.ts";
export * from "./types/downpipes.ts";
export * from "./types/attest.ts";
export * from "./types/retention-prune.ts";
export * from "./types/canary.ts";
export * from "./types/idp.ts";
export * from "./types/restore-types.ts";
export * from "./types/recovery.ts";
export * from "./types/updates.ts";
export * from "./types/status.ts";
export * from "./types/preflight.ts";
export * from "./types/support.ts";
export * from "./types/push.ts";
export * from "./types/otlp-push.ts";
export * from "./types/who.ts";
export * from "./types/passkey.ts";
export * from "./types/signin-factors.ts";
export * from "./types/rbac.ts";
export * from "./types/audit.ts";
export * from "./types/notifications.ts";
export * from "./types/expiry.ts";
export * from "./types/reporting.ts";
export * from "./types/posture.ts";
export * from "./types/coverage.ts";
export * from "./types/cost.ts";
export * from "./types/owner-actions.ts";
export * from "./types/control-plane.ts";
