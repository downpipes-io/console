// The contract section-1 role-by-capability table, transcribed ONCE for the whole console test suite.
//
// WHY THIS FILE EXISTS. Two validators held their own hand-typed copy of this table: the TABLE literal
// inside validate-api-capabilities.ts and the EXPECTED literal inside validate-identity.ts. Each called
// itself "the independent oracle", and each was pinned only against the console's own ROLE_CAPABILITIES.
// So the pair proved the console agrees with itself, twice. Neither read the ENGINE, which is the
// enforcement authority and the only place the answer is actually decided.
//
// Two transcriptions of one table is not two oracles. It is one oracle and one opportunity to type it
// differently, and it costs a real bug already on the record: restore-operator lost restore.apply in the
// console mirror while the engine granted it.
//
// So there is now ONE transcription, here, and it is CHECKED against the engine's own source rather than
// merely duplicated: scripts/capability-drift-gate.mjs imports the engine's ROLE_CAPABILITIES, the
// console's ROLE_CAPABILITIES and this table, and fails unless all three agree cell for cell. That gate
// cannot skip. It has no engine-missing branch at all, so it fails when it cannot compare.
//
// The transcription is kept (rather than deriving the table from the engine at test time) because the
// console suite must stay hermetic: a console-only clone with no engine beside it still runs the full
// intrinsic pin. The gate is what makes the transcription trustworthy; the transcription is what makes
// the suite runnable alone.
//
// THE drill.run / restore-operator CELL. The contract's printed capability table groups drill.run in the
// data-ops row, which would exclude restore-operator. The contract PROSE ("it can request, apply, approve,
// and drill"), the DR-responder persona ("run drills") and the engine's own ROLE_CAPABILITIES all grant it.
// The engine is the enforcement authority, so this table grants it too. A console that hid a drill the
// engine allows would be wrong in the direction that costs a customer a recovery rehearsal.

import type { Capability, Role } from "../src/lib/identity.ts";

// The closed role universe, in contract order. Iterating this is what makes a future addition to the Role
// union surface as an unasserted cell rather than passing unnoticed.
export const ROLES: Role[] = ["viewer", "operator", "restore-operator", "approver", "access-admin", "owner"];

// The closed capability universe. Every cell of the table below is asserted over THIS list, not over the
// union of granted capabilities, so a capability no role holds is still asserted absent for every role.
export const CAPABILITIES: Capability[] = [
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

// The read floor every authenticated role holds. restore.verify sits here because proving an archive
// restores writes nothing back and surfaces no plaintext, so it is as safe as a read and never implies
// the power to apply a restore over live data.
const READ_FLOOR: Capability[] = [
  "downpipe.read", "audit.read", "restore.dryrun", "restore.verify", "reports.read", "posture.read", "roles.read",
];

// The data-operations block: create, edit, delete and run downpipes, plus the operational config.
const DATA_OPS: Capability[] = [
  "downpipe.write", "downpipe.delete", "run.trigger", "drill.run",
  "notify.config", "expiry.config", "scheduledtest.config",
];

// Each role lists EXACTLY the capabilities it holds. Anything absent must read as a denial.
export const CAPABILITY_TABLE: Record<Role, Capability[]> = {
  // Reads and the two read-safe restore proofs only.
  viewer: [...READ_FLOOR],
  // Data ops and config, and may raise a restore request. No apply, no approve, no people, no keys.
  operator: [...READ_FLOOR, ...DATA_OPS, "restore.request"],
  // Recovery only: the read floor, drills, and the full restore lifecycle. No data ops, no people, no keys.
  "restore-operator": [...READ_FLOOR, "drill.run", "restore.request", "restore.apply", "restore.approve"],
  // Operator plus apply and approve.
  approver: [...READ_FLOOR, ...DATA_OPS, "restore.request", "restore.apply", "restore.approve"],
  // People only: the read floor plus the role table and the access policy.
  "access-admin": [...READ_FLOOR, "roles.write", "access.policy"],
  // Everything. The only holder of keys.ceremony and posture.riskaccept.
  owner: [
    ...READ_FLOOR, ...DATA_OPS,
    "restore.request", "restore.apply", "restore.approve",
    "roles.write", "access.policy",
    "keys.ceremony", "posture.riskaccept",
  ],
};

// cells expands a role's granted list into an exhaustive capability -> boolean row over CAPABILITIES, so
// an omission reads as an explicit denial rather than as an unasserted cell.
export function cells(granted: Capability[]): Record<Capability, boolean> {
  const out = {} as Record<Capability, boolean>;
  for (const c of CAPABILITIES) out[c] = false;
  for (const c of granted) out[c] = true;
  return out;
}
