import type { Capability } from "../lib/identity.ts";

// CAPABILITY_PHRASE: the customer-facing half of a capability-gated disabled-with-reason message
// (screens/common.ts capGateReason). A Capability is an internal dotted engine symbol
// ("restore.apply", "downpipe.write", "access.policy"); a customer reading a disabled control's
// tooltip should never see the symbol itself, only a plain phrase for the permission it names.
//
// Kept as a sibling constant, the same shape as canary-copy.ts, so screens/common.ts stays the shared
// scaffolding module and this one piece of customer copy has a single place to read and extend.
//
// EXHAUSTIVENESS IS COMPILER-ENFORCED. CAPABILITY_PHRASE is typed `Record<Capability, string>`, not
// `Partial<Capability, string>` or a lookup with a default branch: TypeScript requires a Record type to
// supply every key of its index union, so omitting a member (or a future addition to the Capability
// union landing here without a phrase) is a `tsc` error, not a silently-missing case papered over by a
// fallback that would print the raw identifier again. There is deliberately no default/fallback branch
// in capabilityPhrase() below for exactly that reason: a fallback would swallow the compiler error this
// map exists to force.
export const CAPABILITY_PHRASE: Record<Capability, string> = {
  "downpipe.read": "permission to view downpipes",
  "downpipe.write": "permission to create or edit downpipes",
  "downpipe.delete": "permission to delete downpipes",
  "run.trigger": "permission to trigger a backup run",
  "drill.run": "permission to run a recovery drill",
  "restore.dryrun": "permission to run a restore dry run",
  "restore.verify": "permission to verify restorability",
  "restore.request": "permission to request a restore",
  "restore.apply": "permission to apply a restore",
  "restore.approve": "permission to approve a restore",
  "roles.read": "permission to view roles",
  "roles.write": "permission to manage roles",
  "access.policy": "permission to manage access policy",
  "keys.ceremony": "permission to run the key ceremony",
  "audit.read": "permission to view the audit log",
  "notify.config": "permission to configure notifications",
  "expiry.config": "permission to configure expiry settings",
  "scheduledtest.config": "permission to configure scheduled tests",
  "reports.read": "permission to view reports",
  "posture.read": "permission to view security posture",
  "posture.riskaccept": "permission to accept a security risk",
};

// capabilityPhrase looks up the customer-facing phrase for a capability. The Record type above already
// guarantees every Capability member has an entry, so this is a plain, total lookup: no default case,
// no identifier fallback.
export function capabilityPhrase(capability: Capability): string {
  return CAPABILITY_PHRASE[capability];
}
