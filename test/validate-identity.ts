// Validate the console capability mirror in src/lib/identity.ts: the
// Role / Capability unions, ROLE_CAPABILITIES map and can() lookup, plus the legacy cumulative
// ladder (roleRank/hasRole) and the persona list. Run with `node test/validate-identity.ts`.
//
// The console mirror is UX-only: the engine is ALWAYS the enforcement point. This mirror exists so a
// client affordance is shown ONLY when the server would allow it, which means it MUST match the
// engine's identity.ts byte-for-byte or the console would offer (or hide) an action the engine
// disagrees with. So this file proves the mirror two ways:
//
//   1. INTRINSIC: every cell of the contract section-1 capability table is asserted directly against
//      the console's ROLE_CAPABILITIES, so the table is pinned independently of the engine. This also
//      pins the backward-compat invariants (the four original roles keep their exact prior powers,
//      owner-exclusive caps, the two narrow roles' boundaries). The table lives in
//      test/capability-table.ts, transcribed once for the whole suite.
//   2. PARITY: when an engine checkout is available, the engine's ROLE_CAPABILITIES and can() are
//      imported and asserted EQUAL to the console's over every (role x capability) pair, so the two
//      sides cannot drift. Without one, the block skips with a visible note so the suite stays
//      runnable alone; the intrinsic block still pins the contract.
//
// Note on the drill.run / restore-operator cell: the contract's capability TABLE groups drill.run in
// the data-ops row (which restore-operator does not hold), but the contract PROSE, the DR-responder
// persona, and the engine's ROLE_CAPABILITIES all grant drill.run to restore-operator. The engine is
// the enforcement authority, so the mirror holds drill.run for restore-operator and this validator
// asserts it (and the engine parity block confirms the two agree).

import { CAPABILITIES, CAPABILITY_TABLE, ROLES, cells } from "./capability-table.ts";
import { importFromEngine } from "./engine-path.ts";
import {
  ROLE_CAPABILITIES,
  can,
  isRole,
  roleRank,
  hasRole,
  PERSONAS,
  type Role,
  type Capability,
} from "../src/lib/identity.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// The closed Capability universe, aliased from the shared table so this validator iterates every
// member and a future addition to the union surfaces as an unasserted-cell failure below. ROLES comes
// from the same place, so the two validators and the drift gate cannot disagree about the universe.
const CAPS: Capability[] = CAPABILITIES;

// ============================================================================
// The contract section-1 grant table, expanded from the shared transcription into exhaustive
// capability -> boolean rows. `true` means the role holds the capability. The engine's
// ROLE_CAPABILITIES (the enforcement authority) is built to this same table, with the documented
// drill.run/restore-operator resolution, and capability-drift-gate.mjs fails unless the two agree.
// Every cell is asserted against the console map below.
// ============================================================================
const EXPECTED: Record<Role, Record<Capability, boolean>> = Object.fromEntries(
  ROLES.map((r) => [r, cells(CAPABILITY_TABLE[r])]),
) as Record<Role, Record<Capability, boolean>>;

// ============================================================================
// 1. INTRINSIC: every (role, capability) cell of can() and ROLE_CAPABILITIES matches EXPECTED.
// ============================================================================
// A suite that iterates an empty universe asserts nothing and prints a pass. The floors are the closed
// six-role, twenty-one-capability model; a legitimate ADDITION raises them and still passes, while a
// removal has to be a decision recorded here rather than a silent loss of every cell below it.
console.log("\n-- the table under test is not empty --");
ok(`ROLES covers the closed six-role model (got ${ROLES.length})`, ROLES.length >= 6);
ok(`CAPS covers the closed capability universe (got ${CAPS.length})`, CAPS.length >= 21);
ok("every role has an EXPECTED row", ROLES.every((r) => EXPECTED[r] !== undefined));

console.log("\n-- can() matches the contract table, every cell --");
for (const role of ROLES) {
  for (const cap of CAPS) {
    const want = EXPECTED[role][cap];
    const gotCan = can(role, cap);
    const gotSet = ROLE_CAPABILITIES[role].has(cap);
    ok(`${role} ${want ? "has" : "lacks"} ${cap}`, gotCan === want);
    // can() and the raw set must agree (can() is just the set lookup; this guards a future refactor).
    ok(`${role}/${cap}: can() agrees with the raw set`, gotCan === gotSet);
  }
}

// The set must contain EXACTLY the expected capabilities (no extra grant slipped in beyond the cells
// asserted above). Size equality plus the per-cell checks above is an exact-set proof.
console.log("\n-- each role's set is exactly the expected size (no extra grants) --");
for (const role of ROLES) {
  const want = CAPS.filter((c) => EXPECTED[role][c]).length;
  ok(`${role} grants exactly ${want} capabilities`, ROLE_CAPABILITIES[role].size === want);
}

// ============================================================================
// 2. Backward-compat + boundary invariants, stated as named properties (defence beyond the cells).
// ============================================================================
console.log("\n-- backward-compat: the four original roles keep their exact powers --");
// Viewer: reads + dryrun only; NO write/delete/trigger/apply/people/keys.
ok("viewer can read downpipes", can("viewer", "downpipe.read"));
ok("viewer can dry-run a restore", can("viewer", "restore.dryrun"));
// restore.verify is read-SAFE (the blind test / keyless attestation prove recoverability without
// writing or disclosing anything), so it sits in the viewer floor alongside restore.dryrun and does
// NOT imply the power to apply a restore.
ok("viewer can verify restorability (read-safe blind test / keyless attestation)", can("viewer", "restore.verify"));
ok("viewer holding restore.verify does NOT imply restore.apply", can("viewer", "restore.verify") && !can("viewer", "restore.apply"));
ok("viewer can read roles", can("viewer", "roles.read"));
ok("viewer cannot write a downpipe", !can("viewer", "downpipe.write"));
ok("viewer cannot trigger a run", !can("viewer", "run.trigger"));
ok("viewer cannot apply a restore", !can("viewer", "restore.apply"));
ok("viewer cannot write roles", !can("viewer", "roles.write"));
ok("viewer cannot run the key ceremony", !can("viewer", "keys.ceremony"));

// Operator: data ops + config + raise a request; NO apply/approve, NO people, NO keys.
ok("operator can write/delete/trigger/drill", can("operator", "downpipe.write") && can("operator", "downpipe.delete") && can("operator", "run.trigger") && can("operator", "drill.run"));
ok("operator can configure notify/expiry/scheduledtest", can("operator", "notify.config") && can("operator", "expiry.config") && can("operator", "scheduledtest.config"));
ok("operator can raise a restore request", can("operator", "restore.request"));
ok("operator cannot apply a restore", !can("operator", "restore.apply"));
ok("operator cannot approve a restore", !can("operator", "restore.approve"));
ok("operator cannot write roles or the access policy", !can("operator", "roles.write") && !can("operator", "access.policy"));
ok("operator cannot run the key ceremony", !can("operator", "keys.ceremony"));
ok("operator cannot risk-accept a posture check", !can("operator", "posture.riskaccept"));

// Approver: operator + apply + approve; still NO people, NO keys.
ok("approver has every operator capability", CAPS.filter((c) => can("operator", c)).every((c) => can("approver", c)));
ok("approver can apply and approve a restore", can("approver", "restore.apply") && can("approver", "restore.approve"));
ok("approver cannot write roles or run the key ceremony", !can("approver", "roles.write") && !can("approver", "keys.ceremony"));

// Owner: everything (the closure over every capability).
ok("owner holds every capability", CAPS.every((c) => can("owner", c)));

console.log("\n-- the two narrow roles are a SUBSET, not a prefix, of owner --");
// restore-operator: recovery only (drill + the full restore lifecycle), NO data ops, NO people/keys.
ok("restore-operator can drill", can("restore-operator", "drill.run"));
ok("restore-operator can request/apply/approve a restore", can("restore-operator", "restore.request") && can("restore-operator", "restore.apply") && can("restore-operator", "restore.approve"));
ok("restore-operator cannot create/edit/delete a downpipe", !can("restore-operator", "downpipe.write") && !can("restore-operator", "downpipe.delete"));
ok("restore-operator cannot trigger a backup run", !can("restore-operator", "run.trigger"));
ok("restore-operator cannot configure notify/expiry", !can("restore-operator", "notify.config") && !can("restore-operator", "expiry.config"));
ok("restore-operator cannot manage people", !can("restore-operator", "roles.write") && !can("restore-operator", "access.policy"));
ok("restore-operator cannot run the key ceremony", !can("restore-operator", "keys.ceremony"));

// access-admin: people only, NO data/restore-write/keys (it keeps the read floor, incl. restore.dryrun).
ok("access-admin can write roles and the access policy", can("access-admin", "roles.write") && can("access-admin", "access.policy"));
ok("access-admin keeps the read floor (downpipe.read, audit.read, reports.read, posture.read)", can("access-admin", "downpipe.read") && can("access-admin", "audit.read") && can("access-admin", "reports.read") && can("access-admin", "posture.read"));
ok("access-admin cannot write a downpipe or trigger a run", !can("access-admin", "downpipe.write") && !can("access-admin", "run.trigger"));
ok("access-admin cannot drill or apply/request a restore", !can("access-admin", "drill.run") && !can("access-admin", "restore.apply") && !can("access-admin", "restore.request"));
ok("access-admin cannot run the key ceremony or risk-accept", !can("access-admin", "keys.ceremony") && !can("access-admin", "posture.riskaccept"));

console.log("\n-- owner-exclusive capabilities --");
for (const cap of ["keys.ceremony", "posture.riskaccept"] as Capability[]) {
  const holders = ROLES.filter((r) => can(r, cap));
  ok(`${cap} is owner-exclusive`, holders.length === 1 && holders[0] === "owner");
}

console.log("\n-- the universal read floor every authenticated role holds --");
for (const cap of ["downpipe.read", "audit.read", "restore.dryrun", "restore.verify", "reports.read", "posture.read", "roles.read"] as Capability[]) {
  ok(`every role holds ${cap}`, ROLES.every((r) => can(r, cap)));
}

// ============================================================================
// 3. isRole runtime guard over the six-member union.
// ============================================================================
console.log("\n-- isRole --");
for (const r of ROLES) ok(`isRole("${r}") is true`, isRole(r));
ok('isRole("admin") is false', !isRole("admin"));
ok('isRole("") is false', !isRole(""));
ok("isRole(null) is false", !isRole(null));
ok("isRole(undefined) is false", !isRole(undefined));
ok("isRole(42) is false", !isRole(42));
ok('isRole("Owner") is false (case-sensitive)', !isRole("Owner"));

// ============================================================================
// 4. Legacy cumulative ladder (roleRank/hasRole) for the four original roles. The two narrow roles
// are deliberately OFF the ladder (rank 0) so a legacy "at least X" gate can never over-grant them;
// new affordances gate with can(), not this ladder.
// ============================================================================
console.log("\n-- legacy cumulative ladder (the four original roles) --");
ok("rank order viewer<operator<approver<owner", roleRank("viewer") < roleRank("operator") && roleRank("operator") < roleRank("approver") && roleRank("approver") < roleRank("owner"));
ok("owner >= approver (hasRole)", hasRole("owner", "approver"));
ok("approver >= operator (hasRole)", hasRole("approver", "operator"));
ok("operator >= viewer (hasRole)", hasRole("operator", "viewer"));
ok("viewer is NOT >= operator", !hasRole("viewer", "operator"));
// The narrow roles sit at rank 0 so no legacy "at least operator/approver/owner" gate ever passes them.
ok("restore-operator is NOT >= operator on the legacy ladder", !hasRole("restore-operator", "operator"));
ok("restore-operator is NOT >= approver on the legacy ladder", !hasRole("restore-operator", "approver"));
ok("access-admin is NOT >= operator on the legacy ladder", !hasRole("access-admin", "operator"));
ok("access-admin is NOT >= owner on the legacy ladder", !hasRole("access-admin", "owner"));
ok("every role >= viewer (the floor)", ROLES.every((r) => hasRole(r, "viewer")));

// ============================================================================
// 5. PERSONAS recommend only valid roles, and never owner-by-group (owner stays explicit per-email).
// ============================================================================
console.log("\n-- personas --");
ok("PERSONAS is a non-empty list", Array.isArray(PERSONAS) && PERSONAS.length > 0);
ok("every persona recommends a valid role", PERSONAS.every((p) => isRole(p.recommendedRole)));
ok("every persona has a non-empty id, label and blurb", PERSONAS.every((p) => p.id.length > 0 && p.label.length > 0 && p.blurb.length > 0));
ok("persona ids are unique", new Set(PERSONAS.map((p) => p.id)).size === PERSONAS.length);
ok("a DR-responder persona maps to restore-operator", PERSONAS.some((p) => p.recommendedRole === "restore-operator"));
ok("a CTO/owner persona maps to owner", PERSONAS.some((p) => p.recommendedRole === "owner"));
// No persona copy may carry an em dash (house style) or an AI attribution. The check is for the em dash
// character itself (U+2014), not the ASCII hyphen-minus, which legitimately appears in copy ("read-only",
// "audit-only", "Day-to-day").
ok("no persona blurb contains an em dash", !PERSONAS.some((p) => p.blurb.includes("—") || p.label.includes("—")));

// ============================================================================
// 6. PARITY: assert the console mirror equals the engine's ROLE_CAPABILITIES / can() byte-for-byte.
// identity.ts is pure logic (no crypto deps), so importing it is clean. With no engine checkout
// available this block prints a note and returns, which is right for a standalone clone that has
// no engine to compare against; the intrinsic block above still pins the contract.
// ============================================================================
async function checkEngineParity(): Promise<void> {
  console.log("\n-- engine parity (console mirror == engine ROLE_CAPABILITIES) --");
  // Resolves an optional sibling engine checkout; see test/engine-path.ts.
  const HERE = new URL(".", import.meta.url).pathname;
  type EngIdentity = {
    ROLE_CAPABILITIES: Record<string, ReadonlySet<string>>;
    can: (role: string, cap: string) => boolean;
    isRole: (v: unknown) => boolean;
  };
  const loaded = await importFromEngine<EngIdentity>(HERE, "src/admin/identity.ts");
  let eng: EngIdentity;
  if (loaded !== null) {
    eng = loaded;
  } else {
    console.log("  note engine checkout not available; skipping the engine-parity cross-check");
    console.log("       (the intrinsic table assertions above already pin the contract).");
    return;
  }

  // The role sets the two sides expose must be identical (same role universe).
  const engRoles = Object.keys(eng.ROLE_CAPABILITIES).sort();
  const conRoles = Object.keys(ROLE_CAPABILITIES).sort();
  ok("engine and console expose the same role set", JSON.stringify(engRoles) === JSON.stringify(conRoles));

  // Every (role, capability) verdict agrees via can(), and the raw sets are equal element-for-element.
  for (const role of ROLES) {
    const engSet = eng.ROLE_CAPABILITIES[role];
    ok(`engine has role ${role}`, engSet !== undefined);
    if (engSet === undefined) continue;
    // Set equality: same size and every console capability is in the engine set and vice versa.
    const conSet = ROLE_CAPABILITIES[role];
    const sameSize = engSet.size === conSet.size;
    const conSubset = [...conSet].every((c) => engSet.has(c));
    const engSubset = [...engSet].every((c) => conSet.has(c as Capability));
    ok(`${role}: console capability set equals the engine's exactly`, sameSize && conSubset && engSubset);
    // can() verdict agrees for every capability in the union universe.
    for (const cap of CAPS) {
      ok(`${role}/${cap}: console can() == engine can()`, can(role, cap) === eng.can(role, cap));
    }
  }

  // isRole agrees on the union members and on a clear non-member.
  for (const r of ROLES) ok(`isRole parity for "${r}"`, eng.isRole(r) === isRole(r));
  ok('isRole parity for "admin"', eng.isRole("admin") === isRole("admin"));
}

async function main(): Promise<void> {
  await checkEngineParity();
  console.log(failures === 0 ? "\nIDENTITY / CAPABILITY MIRROR VECTORS PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
