// validate-api: the capability and role model mirror.
//
// The console's ROLE_CAPABILITIES / can() must match the contract's role-to-capability table
// (the declared single source of truth) EXACTLY, so the client gate is the engine gate. This
// section pins the WHOLE table as a fixture and asserts can(role, cap) for every (role, cap) pair
// (a present capability is true; an absent one is false), then cross-checks ROLE_CAPABILITIES has
// no extra/missing capability per role. If a future edit drifts a single cell, a pair fails.
//
// The table itself lives in test/capability-table.ts, transcribed once for the whole suite and
// checked against the ENGINE's own ROLE_CAPABILITIES by scripts/capability-drift-gate.mjs. It used
// to be a second hand-typed copy here, which pinned the console against itself and read the engine
// nowhere. Read that file for why one checked transcription beats two unchecked ones.

import {
  ROLE_CAPABILITIES,
  can,
  isRole,
  PERSONAS,
  type Capability,
  type Role as IdentityRole,
} from "../src/lib/identity.ts";

import { CAPABILITIES, CAPABILITY_TABLE, ROLES } from "./capability-table.ts";
import type { Harness } from "./validate-api-shared.ts";

export function runCapabilities(h: Harness): void {
  const ok = h.ok.bind(h);
  const eq = h.eq.bind(h);

  console.log("\n-- capability model: ROLE_CAPABILITIES / can() vs the contract table --");

  const TABLE: Record<IdentityRole, Capability[]> = CAPABILITY_TABLE;

  // The CLOSED capability universe, not the union of granted cells: a capability no role holds is
  // still asserted absent for every role, which the union-of-granted version could not see.
  const ALL_CAPS: Capability[] = CAPABILITIES;
  const ALL_ROLES: IdentityRole[] = ROLES;

  // 7a. can(role, cap) matches the table for EVERY (role, cap) pair (present => true, absent => false).
  for (const role of ALL_ROLES) {
    const held = new Set(TABLE[role]);
    for (const cap of ALL_CAPS) {
      const want = held.has(cap);
      eq(can(role, cap), want, `can(${role}, ${cap}) = ${want}`);
    }
  }

  // 7b. ROLE_CAPABILITIES has EXACTLY the table's set per role (no extra capability, no missing one):
  // same size and same membership, so a stray capability added to the map (not in the table) is caught.
  for (const role of ALL_ROLES) {
    const set = ROLE_CAPABILITIES[role];
    eq(set.size, TABLE[role].length, `ROLE_CAPABILITIES[${role}] size = ${TABLE[role].length}`);
    const allPresent = TABLE[role].every((c) => set.has(c));
    ok(`ROLE_CAPABILITIES[${role}] contains exactly its table capabilities`, allPresent && set.size === TABLE[role].length);
  }

  // 7c. The contract's backward-compatibility invariants for the four original roles, asserted
  // directly (these are the load-bearing "unchanged powers" guarantees):
  ok("viewer cannot write a downpipe", !can("viewer", "downpipe.write"));
  ok("viewer can dry-run a restore", can("viewer", "restore.dryrun"));
  // restore.verify (blind restore test / keyless attestation) is read-safe and lives in the viewer
  // floor; holding it never implies the power to apply a restore over live data.
  ok("viewer can verify restorability but cannot apply", can("viewer", "restore.verify") && !can("viewer", "restore.apply"));
  ok("operator can write but NOT apply a restore", can("operator", "downpipe.write") && !can("operator", "restore.apply"));
  ok("operator cannot manage people", !can("operator", "roles.write"));
  ok("approver can apply and approve a restore", can("approver", "restore.apply") && can("approver", "restore.approve"));
  ok("owner can run the key ceremony and accept risk", can("owner", "keys.ceremony") && can("owner", "posture.riskaccept"));
  ok("owner holds every capability in the universe", ALL_CAPS.every((c) => can("owner", c)));

  // 7d. The new narrow roles' guardrails (the reason they exist):
  ok("restore-operator can apply/approve a restore", can("restore-operator", "restore.apply") && can("restore-operator", "restore.approve"));
  ok("restore-operator can run a drill (recovery surface; engine grants it)", can("restore-operator", "drill.run"));
  ok("restore-operator CANNOT write/trigger downpipes", !can("restore-operator", "downpipe.write") && !can("restore-operator", "run.trigger"));
  ok("restore-operator CANNOT manage people or keys", !can("restore-operator", "roles.write") && !can("restore-operator", "keys.ceremony"));
  ok("access-admin CAN manage roles + access policy", can("access-admin", "roles.write") && can("access-admin", "access.policy"));
  ok("access-admin CANNOT touch data or restore", !can("access-admin", "downpipe.write") && !can("access-admin", "restore.request") && !can("access-admin", "restore.apply"));
  ok("access-admin holds NO key/posture-risk capability", !can("access-admin", "keys.ceremony") && !can("access-admin", "posture.riskaccept"));
  // posture.riskaccept and keys.ceremony are OWNER-ONLY across the whole role set.
  ok("posture.riskaccept is owner-only", ALL_ROLES.every((r) => can(r, "posture.riskaccept") === (r === "owner")));
  ok("keys.ceremony is owner-only", ALL_ROLES.every((r) => can(r, "keys.ceremony") === (r === "owner")));

  // 7e. isRole guards the six-member union and rejects junk (owner stays a valid role string).
  for (const role of ALL_ROLES) ok(`isRole accepts ${role}`, isRole(role));
  ok("isRole rejects an unknown role string", !isRole("superadmin"));
  ok("isRole rejects a non-string", !isRole(3) && !isRole(null) && !isRole(undefined));

  // 7f. PERSONAS: each recommends a VALID role, has non-empty fields, and the ids are unique. The
  // contract's persona-to-role intent is spot-checked (DR responder -> restore-operator; CTO -> owner).
  ok("PERSONAS is non-empty", PERSONAS.length > 0);
  ok("every persona recommends a valid role", PERSONAS.every((p) => isRole(p.recommendedRole)));
  ok("every persona has a non-empty id/label/blurb", PERSONAS.every((p) => p.id.length > 0 && p.label.length > 0 && p.blurb.length > 0));
  ok("persona ids are unique", new Set(PERSONAS.map((p) => p.id)).size === PERSONAS.length);
  ok("a DR-responder persona maps to restore-operator", PERSONAS.some((p) => p.recommendedRole === "restore-operator"));
  ok("a CTO/owner persona maps to owner", PERSONAS.some((p) => p.recommendedRole === "owner"));
  ok("an access-admin persona exists", PERSONAS.some((p) => p.recommendedRole === "access-admin"));
}
