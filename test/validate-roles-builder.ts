// Validate the custom role builder's pure composition + guard logic (src/screens/roles-builder.ts)
// and the custom-role model + resolution helpers it composes over (src/lib/identity.ts)
// (composable custom roles). Run with: node test/validate-roles-builder.ts
//
// The builder UI is DOM-heavy, but its load-bearing logic is extracted into pure functions, testable
// without a DOM (none of the imported modules execute DOM at import time, so importing them in Node
// succeeds). This validator proves the three contract guarantees the task names:
//
//   1. The builder COMPOSES a valid role PAYLOAD: composeProposal(state) over a real composition yields
//      a CustomRoleProposal that validateCustomRole ACCEPTS (against the creator's own capabilities),
//      and the composed payload round-trips to exactly the capabilities/surface/presentation/landing the
//      operator picked.
//   2. The PREVIEW reflects SURFACE + CAPS: previewRole returns ok with the composed role; the resolved
//      capability set and per-screen surface (resolveSurface / surfaceMode / nonHiddenScreens) reflect
//      what was selected; the six built-in presets compose to valid roles.
//   3. EDIT-REQUIRES-WRITE-CAP: canSetScreenEdit mirrors the engine guard (edit only when the screen's
//      write capability is held and the screen has a write side); validateCustomRole REJECTS a surface
//      that marks a screen "edit" without its write cap; and unticking a write cap demotes the screen.
//
// It also pins the hard guardrails the builder mirrors so the console can never offer a payload the
// engine would 400 (owner-reserved bar, no-escalation, built-in name collision, hidden landing).

import {
  emptyBuilderState,
  stateFromPreset,
  composeProposal,
  previewRole,
  canSetScreenEdit,
  demoteEditsLosingWriteCap,
  nonHiddenScreens,
  type BuilderState,
} from "../src/screens/roles-builder.ts";
// creatorCapabilities resolves the live caller's own effective set (the no-escalation basis). It reads the
// store-held caller, so it is imported from the DOM-free shared leaf and exercised against a stubbed caller
// here. It must honour a caller's custom role, not collapse to the built-in floor.
import { creatorCapabilities } from "../src/screens/roles-builder/shared.ts";
import { activeOwnerCount } from "../src/screens/access-security/roles-members.ts";
import type { RoleEntry } from "../src/api.ts";
import { setCaller } from "../src/lib/store.ts";
import {
  ROLE_CAPABILITIES,
  ALL_CAPABILITIES,
  OWNER_RESERVED_CAPABILITIES,
  SCREEN_WRITE_CAPABILITY,
  validateCustomRole,
  builtinPreset,
  capabilitiesOfCustomRole,
  callerEffectiveCapabilities,
  callerCan,
  resolveSurface,
  surfaceMode,
  resolvePresentation,
  isScreen,
  isCapability,
  CUSTOM_ROLE_NAME_PATTERN,
  type Capability,
  type CustomRole,
  type Role,
  type SurfaceMode,
} from "../src/lib/identity.ts";
import { makeChecks } from "./validate-checks.ts";

const checks = makeChecks();
const { ok } = checks;

// The owner's full set is the broadest creator: it can grant any non-owner-reserved capability, so it
// is the basis for the "compose anything" cases. access-admin is the narrowest builder caller (it holds
// access.policy), used to prove the no-escalation guard bites.
const OWNER_CAPS = ROLE_CAPABILITIES.owner;
const ACCESS_ADMIN_CAPS = ROLE_CAPABILITIES["access-admin"];

// ============================================================================
// 1. The builder composes a VALID role PAYLOAD.
// ============================================================================
console.log("\n-- 1. composeProposal -> a payload validateCustomRole accepts --");
{
  // A realistic "kv-restorer": a recovery-only seat that can apply restores, restricted to the restore
  // and approvals screens editable, audit visible, everything else hidden, shiny skin, lands on restore.
  const state: BuilderState = emptyBuilderState();
  state.name = "kv-restorer";
  state.label = "KV restorer";
  state.capabilities = new Set<Capability>(["restore.dryrun", "restore.apply", "restore.approve", "audit.read", "downpipe.read"]);
  state.surface = new Map<string, SurfaceMode>([
    ["restore", "edit"],
    ["approvals", "edit"],
    ["audit", "read"],
    ["downpipes", "hidden"],
    ["people", "hidden"],
  ]);
  state.presentation = "shiny";
  state.landing = "restore";

  const proposal = composeProposal(state);
  ok("composed name/label match the state", proposal.name === "kv-restorer" && proposal.label === "KV restorer");
  ok("composed capabilities are the selected set (canonical order)", JSON.stringify(proposal.capabilities) === JSON.stringify(ALL_CAPABILITIES.filter((c) => state.capabilities.has(c))));
  ok("composed surface is the declared map", JSON.stringify(proposal.surface) === JSON.stringify({ restore: "edit", approvals: "edit", audit: "read", downpipes: "hidden", people: "hidden" }));
  ok("composed presentation + landing match", proposal.presentation === "shiny" && proposal.landing === "restore");

  const verdict = validateCustomRole(proposal, OWNER_CAPS);
  ok("owner can compose this role (validateCustomRole accepts)", verdict.ok === true);
  if (verdict.ok) {
    ok("accepted role carries exactly the composed capabilities", JSON.stringify(verdict.role.capabilities) === JSON.stringify(proposal.capabilities));
    ok("accepted role carries the composed surface", JSON.stringify(verdict.role.surface) === JSON.stringify(proposal.surface));
    ok("accepted role carries presentation shiny + landing restore", verdict.role.presentation === "shiny" && verdict.role.landing === "restore");
  }
}

// previewRole is the SAME verdict path the live preview renders, so it must agree with validateCustomRole.
console.log("\n-- previewRole == validateCustomRole(composeProposal(state)) --");
{
  const state = emptyBuilderState();
  state.name = "compliance-reader";
  state.label = "Compliance reader";
  state.capabilities = new Set<Capability>(["downpipe.read", "audit.read", "reports.read", "posture.read"]);
  state.landing = "reports";
  const pv = previewRole(state, OWNER_CAPS);
  const direct = validateCustomRole(composeProposal(state), OWNER_CAPS);
  ok("previewRole accepts a read-only compliance seat", pv.ok === true);
  ok("previewRole agrees with the direct validateCustomRole verdict", JSON.stringify(pv) === JSON.stringify(direct));
}

// ============================================================================
// 2. The PREVIEW reflects SURFACE + CAPS.
// ============================================================================
console.log("\n-- 2. preview reflects surface + capabilities --");
{
  const state = emptyBuilderState();
  state.name = "ops-lite";
  state.label = "Ops lite";
  state.capabilities = new Set<Capability>(["downpipe.read", "downpipe.write", "run.trigger", "audit.read", "reports.read", "posture.read", "restore.dryrun"]);
  state.surface = new Map<string, SurfaceMode>([
    ["downpipes", "edit"],
    ["notify", "hidden"],
    ["expiry", "hidden"],
  ]);
  state.landing = "downpipes";

  const pv = previewRole(state, OWNER_CAPS);
  ok("ops-lite composes valid (downpipes edit is backed by downpipe.write)", pv.ok === true);
  if (pv.ok) {
    // The resolved effective capability set the preview would gate on equals the materialised set.
    const role: CustomRole = { ...pv.role, createdBy: null, createdAt: "2026-06-09T00:00:00.000Z" };
    const eff = capabilitiesOfCustomRole(role);
    ok("preview effective caps include the selected write cap", eff.has("downpipe.write"));
    ok("preview effective caps exclude an unselected cap", !eff.has("restore.apply"));
    // callerEffectiveCapabilities over the custom role equals the materialised set (the gating basis).
    const viaCaller = callerEffectiveCapabilities("viewer", role);
    ok("callerEffectiveCapabilities(custom) == capabilitiesOfCustomRole", [...eff].every((c) => viaCaller.has(c)) && [...viaCaller].every((c) => eff.has(c as Capability)));
    ok("callerCan over the custom role mirrors the set (write yes, apply no)", callerCan("viewer", "downpipe.write", role) && !callerCan("viewer", "restore.apply", role));

    // The surface the preview renders: declared modes win, undeclared screens default to read, hidden
    // screens are excluded from the visible set.
    const surf = resolveSurface("viewer", role);
    ok("resolveSurface keeps downpipes editable", surf.downpipes === "edit");
    ok("resolveSurface hides notify + expiry", surf.notify === "hidden" && surf.expiry === "hidden");
    ok("resolveSurface defaults an undeclared screen (audit) to read", surf.audit === "read");
    ok("surfaceMode reads one screen the same as resolveSurface", surfaceMode("viewer", "downpipes", role) === "edit");
    const visible = nonHiddenScreens(state);
    ok("nonHiddenScreens excludes the hidden screens", !visible.includes("notify") && !visible.includes("expiry"));
    ok("nonHiddenScreens includes a read/edit screen", visible.includes("downpipes") && visible.includes("audit"));
    ok("resolvePresentation reads the custom skin (technical here)", resolvePresentation("viewer", role) === "technical");
  }
}

// The six built-in presets compose to valid roles (editable starting points the operator can save).
console.log("\n-- the six built-in presets compose to valid roles --");
{
  const BUILTINS: Role[] = ["viewer", "operator", "restore-operator", "approver", "access-admin", "owner"];
  for (const role of BUILTINS) {
    const preset = builtinPreset(role);
    // A preset must be name-able (the name is the built-in id, which validateCustomRole rejects as a
    // collision); the BUILDER blanks the name and labels it "(custom)". Simulate that: give it a fresh
    // name and re-validate, which is what the operator does after picking a preset.
    const state = stateFromPreset(role);
    state.name = `${role}-custom-seat`;
    const pv = previewRole(state, OWNER_CAPS);
    ok(`preset ${role} composes a valid role once named`, pv.ok === true);
    // The preset never carries an owner-reserved capability (a custom role can never hold them).
    ok(`preset ${role} drops owner-reserved capabilities`, preset.capabilities.every((c) => !OWNER_RESERVED_CAPABILITIES.has(c)));
    // resolvePresentation for a built-in caller (no custom role) is always technical.
    ok(`built-in ${role} caller renders the technical skin`, resolvePresentation(role, null) === "technical");
  }
  // The owner preset, being the broadest, must NOT contain keys.ceremony / posture.riskaccept.
  const ownerPreset = builtinPreset("owner");
  ok("owner preset excludes keys.ceremony and posture.riskaccept", !ownerPreset.capabilities.includes("keys.ceremony") && !ownerPreset.capabilities.includes("posture.riskaccept"));
}

// A built-in caller's surface is derived from its capabilities (no custom role), so a built-in caller
// renders editable screens exactly where it holds the write cap.
console.log("\n-- a built-in caller's surface derives from its capabilities --");
{
  const opSurface = resolveSurface("operator", null);
  ok("operator surface: downpipes editable (holds downpipe.write)", opSurface.downpipes === "edit");
  ok("operator surface: notify editable (holds notify.config)", opSurface.notify === "edit");
  ok("operator surface: people read-only (lacks roles.write)", opSurface.people === "read");
  ok("operator surface: audit read-only (no write side)", opSurface.audit === "read");
  const viewerSurface = resolveSurface("viewer", null);
  ok("viewer surface: downpipes read-only (lacks downpipe.write)", viewerSurface.downpipes === "read");
  ok("viewer surface never hides a known screen", Object.keys(SCREEN_WRITE_CAPABILITY).every((s) => viewerSurface[s] !== "hidden"));
}

// ============================================================================
// 3. EDIT-REQUIRES-WRITE-CAP (the load-bearing guard, mirrored from the engine).
// ============================================================================
console.log("\n-- 3. edit-requires-write-cap --");
{
  // canSetScreenEdit: a screen with a write side is editable only when the set holds that write cap.
  const withWrite = new Set<Capability>(["downpipe.write"]);
  ok("canSetScreenEdit(downpipes) true with downpipe.write", canSetScreenEdit("downpipes", withWrite));
  ok("canSetScreenEdit(downpipes) false without downpipe.write", !canSetScreenEdit("downpipes", new Set<Capability>(["downpipe.read"])));
  ok("canSetScreenEdit(restore) needs restore.apply", canSetScreenEdit("restore", new Set<Capability>(["restore.apply"])) && !canSetScreenEdit("restore", new Set<Capability>(["restore.dryrun"])));
  // A read-only screen (no write side) is NEVER editable, even with every capability held.
  ok("canSetScreenEdit(audit) is always false (no write side)", !canSetScreenEdit("audit", OWNER_CAPS));
  ok("canSetScreenEdit(reports) is always false (no write side)", !canSetScreenEdit("reports", OWNER_CAPS));
  ok("canSetScreenEdit(posture) is always false (no write side)", !canSetScreenEdit("posture", OWNER_CAPS));

  // validateCustomRole REJECTS a surface that marks a screen "edit" without its write cap.
  const noWriteState = emptyBuilderState();
  noWriteState.name = "bad-editor";
  noWriteState.label = "Bad editor";
  noWriteState.capabilities = new Set<Capability>(["downpipe.read"]); // read only, NO downpipe.write
  noWriteState.surface = new Map<string, SurfaceMode>([["downpipes", "edit"]]);
  noWriteState.landing = "downpipes";
  const bad = previewRole(noWriteState, OWNER_CAPS);
  ok("validateCustomRole REJECTS downpipes=edit without downpipe.write", bad.ok === false);
  if (!bad.ok) ok("the rejection names the missing write capability", bad.reason.includes("downpipe.write"));

  // validateCustomRole REJECTS edit on a read-only screen (audit has no write side).
  const auditEditState = emptyBuilderState();
  auditEditState.name = "audit-editor";
  auditEditState.label = "Audit editor";
  auditEditState.capabilities = new Set<Capability>(["audit.read"]);
  auditEditState.surface = new Map<string, SurfaceMode>([["audit", "edit"]]);
  auditEditState.landing = "audit";
  const auditBad = previewRole(auditEditState, OWNER_CAPS);
  ok("validateCustomRole REJECTS audit=edit (no write surface)", auditBad.ok === false);
  if (!auditBad.ok) ok("the rejection says audit has no write surface", auditBad.reason.includes("audit"));

  // demoteEditsLosingWriteCap: unticking the write cap demotes the screen edit -> read in place.
  const demote = emptyBuilderState();
  demote.capabilities = new Set<Capability>(["restore.apply"]);
  demote.surface = new Map<string, SurfaceMode>([["restore", "edit"]]);
  ok("restore starts editable with restore.apply", canSetScreenEdit("restore", demote.capabilities));
  demote.capabilities.delete("restore.apply"); // operator unticks the write cap
  demoteEditsLosingWriteCap(demote);
  ok("demoteEditsLosingWriteCap drops restore edit -> read", demote.surface.get("restore") === "read");
}

// ============================================================================
// 4. The hard guardrails the builder mirrors (so the console never offers a payload the engine 400s).
// ============================================================================
console.log("\n-- 4. the mirrored hard guardrails --");
{
  // Owner-reserved bar: a custom role can never hold keys.ceremony / posture.riskaccept.
  for (const reserved of [...OWNER_RESERVED_CAPABILITIES]) {
    const s = emptyBuilderState();
    s.name = "wants-reserved";
    s.label = "Wants reserved";
    s.capabilities = new Set<Capability>(["downpipe.read", reserved]);
    s.landing = "audit";
    const v = previewRole(s, OWNER_CAPS);
    ok(`owner-reserved ${reserved} is rejected even for an owner creator`, v.ok === false);
  }

  // No privilege escalation: an access-admin (no downpipe.write) cannot grant downpipe.write.
  const escalate = emptyBuilderState();
  escalate.name = "escalator";
  escalate.label = "Escalator";
  escalate.capabilities = new Set<Capability>(["roles.write", "downpipe.write"]); // access-admin holds roles.write but NOT downpipe.write
  escalate.landing = "people";
  const esc = previewRole(escalate, ACCESS_ADMIN_CAPS);
  ok("no-escalation: access-admin cannot grant downpipe.write it does not hold", esc.ok === false);
  if (!esc.ok) ok("the no-escalation rejection names downpipe.write", esc.reason.includes("downpipe.write"));
  // The same composition succeeds for an owner creator (who holds downpipe.write).
  const escOwner = previewRole(escalate, OWNER_CAPS);
  ok("the same role composes for an owner creator (who holds it)", escOwner.ok === true);

  // No privilege escalation when the CREATOR is themselves on a CUSTOM ROLE: the creator's basis
  // comes from capabilitiesOfCustomRole, not a built-in. Build a narrow custom role (read-only,
  // no downpipe.write), derive its effective set, and confirm validateCustomRole rejects a proposal
  // that tries to grant downpipe.write which the creator does not hold.
  const narrowState = emptyBuilderState();
  narrowState.name = "narrow-creator";
  narrowState.label = "Narrow creator";
  narrowState.capabilities = new Set<Capability>(["downpipe.read", "roles.write"]); // can build roles, but holds no downpipe.write
  narrowState.landing = "audit";
  const narrowPreview = previewRole(narrowState, OWNER_CAPS);
  ok("the narrow custom creator role composes (owner can mint it)", narrowPreview.ok === true);
  if (narrowPreview.ok) {
    const narrowRole: CustomRole = { ...narrowPreview.role, createdBy: null, createdAt: "2026-06-09T00:00:00.000Z" };
    const narrowCreatorCaps = capabilitiesOfCustomRole(narrowRole);
    const escFromCustom = emptyBuilderState();
    escFromCustom.name = "custom-escalator";
    escFromCustom.label = "Custom escalator";
    escFromCustom.capabilities = new Set<Capability>(["downpipe.read", "downpipe.write"]); // grants a cap the custom creator lacks
    escFromCustom.landing = "audit";
    const fromCustom = validateCustomRole(composeProposal(escFromCustom), narrowCreatorCaps);
    ok("no-escalation: a custom-role creator cannot grant a cap their custom role lacks", fromCustom.ok === false);
    if (!fromCustom.ok) ok("the custom-creator rejection names downpipe.write", fromCustom.reason.includes("downpipe.write"));
  }

  // Built-in name collision: a custom role can never be named after a built-in role.
  for (const name of ["viewer", "operator", "owner", "access-admin", "restore-operator", "approver"]) {
    const s = emptyBuilderState();
    s.name = name;
    s.label = "Shadow";
    s.capabilities = new Set<Capability>(["downpipe.read"]);
    s.landing = "audit";
    ok(`name "${name}" collides with a built-in and is rejected`, previewRole(s, OWNER_CAPS).ok === false);
  }

  // The name pattern: a valid custom name, an invalid one (uppercase, leading hyphen), and an empty one.
  ok('CUSTOM_ROLE_NAME_PATTERN accepts "kv-restorer"', CUSTOM_ROLE_NAME_PATTERN.test("kv-restorer"));
  ok('CUSTOM_ROLE_NAME_PATTERN rejects "KV-Restorer" (uppercase)', !CUSTOM_ROLE_NAME_PATTERN.test("KV-Restorer"));
  ok('CUSTOM_ROLE_NAME_PATTERN rejects "-leading"', !CUSTOM_ROLE_NAME_PATTERN.test("-leading"));
  ok('CUSTOM_ROLE_NAME_PATTERN rejects "trailing-"', !CUSTOM_ROLE_NAME_PATTERN.test("trailing-"));

  // Empty capabilities is rejected (a role must grant at least one).
  const emptyCaps = emptyBuilderState();
  emptyCaps.name = "empty";
  emptyCaps.label = "Empty";
  emptyCaps.landing = "audit";
  ok("a role with no capabilities is rejected", previewRole(emptyCaps, OWNER_CAPS).ok === false);

  // A hidden landing is rejected (you cannot land a holder on a screen you hid from them).
  const hiddenLanding = emptyBuilderState();
  hiddenLanding.name = "hidden-landing";
  hiddenLanding.label = "Hidden landing";
  hiddenLanding.capabilities = new Set<Capability>(["downpipe.read"]);
  hiddenLanding.surface = new Map<string, SurfaceMode>([["downpipes", "hidden"]]);
  hiddenLanding.landing = "downpipes";
  ok("landing on a hidden screen is rejected", previewRole(hiddenLanding, OWNER_CAPS).ok === false);

  // isScreen / isCapability guard the contract keys.
  ok("isScreen accepts a known screen and rejects an unknown one", isScreen("downpipes") && !isScreen("nope"));
  ok("isCapability accepts a known cap and rejects an unknown one", isCapability("downpipe.write") && !isCapability("downpipe.superuser"));
  // SCREEN_WRITE_CAPABILITY's non-null write caps are all real capabilities.
  ok("every SCREEN_WRITE_CAPABILITY value is null or a real capability", Object.values(SCREEN_WRITE_CAPABILITY).every((c) => c === null || isCapability(c)));
}

// ============================================================================
// 5. creatorCapabilities honours the caller's CUSTOM role.
// The builder is access.policy-gated, but a caller may hold access.policy via a NAMED custom role whose
// effective set is NOT the built-in floor (role is then the "viewer" floor). creatorCapabilities feeds the
// no-escalation guard, so it must resolve the SAME effective set the engine recomputes for that caller:
// callerEffectiveCapabilities(c.role, c.customRole ?? null), never just ROLE_CAPABILITIES[c.role].
// ============================================================================
console.log("\n-- 5. creatorCapabilities resolves a custom-role caller's own set --");
{
  // A caller on a NAMED custom role: the engine sets role to the "viewer" floor and carries the custom
  // record as the real authority. The custom set holds access.policy (so the caller can reach the builder)
  // plus restore.apply and roles.write, which a built-in viewer never holds. The bug returned the viewer
  // built-in set, so these caps were absent from the creator's basis.
  const customRole: CustomRole = {
    name: "access-curator",
    label: "Access curator",
    capabilities: ["downpipe.read", "roles.read", "roles.write", "access.policy", "restore.dryrun", "restore.apply", "audit.read"],
    surface: { people: "edit", access: "edit", restore: "edit" },
    presentation: "technical",
    landing: "people",
    createdBy: null,
    createdAt: "2026-06-09T00:00:00.000Z",
  };
  setCaller({ method: "passkey", subject: "sub-curator", email: null, role: "viewer", groups: [], isOnlyOwner: false, customRole });
  const set = creatorCapabilities();
  const expected = capabilitiesOfCustomRole(customRole);
  ok("creatorCapabilities returns the CUSTOM role's set, not the viewer floor", [...expected].every((c) => set.has(c)) && [...set].every((c) => expected.has(c as Capability)));
  ok("creatorCapabilities includes a cap the viewer floor lacks (roles.write)", set.has("roles.write"));
  ok("creatorCapabilities includes restore.apply from the custom role", set.has("restore.apply"));
  // It must NOT be the built-in viewer set (the pre-fix behaviour), proven by a cap the viewer never holds.
  ok("creatorCapabilities is NOT the built-in viewer set", !(ROLE_CAPABILITIES.viewer as ReadonlySet<Capability>).has("roles.write") && set.has("roles.write"));

  // A BUILT-IN caller (no custom role) still resolves to its ROLE_CAPABILITIES set unchanged.
  setCaller({ method: "passkey", subject: "sub-admin", email: null, role: "access-admin", groups: [], isOnlyOwner: false });
  const builtinSet = creatorCapabilities();
  ok("a built-in access-admin caller still resolves to its ROLE_CAPABILITIES set", [...ACCESS_ADMIN_CAPS].every((c) => builtinSet.has(c)) && [...builtinSet].every((c) => (ACCESS_ADMIN_CAPS as ReadonlySet<Capability>).has(c as Capability)));

  // No caller resolves to the empty set (signed-out / pre-resolve).
  setCaller(null);
  ok("no caller resolves to an empty capability set", creatorCapabilities().size === 0);
}

// activeOwnerCount: the last-Owner guard client mirror counts only non-expired owners.
// A regression here would mis-disable the Remove button, so pin the boundary cases directly.
{
  console.log("\n-- activeOwnerCount (last-Owner guard mirror) --");
  const NOW = Date.parse("2026-06-01T00:00:00.000Z");
  const PAST = "2026-05-01T00:00:00.000Z";
  const FUTURE = "2026-07-01T00:00:00.000Z";
  const entry = (role: Role, expiresAt?: string): RoleEntry =>
    expiresAt === undefined
      ? { email: `${role}@example.com`, role, grantedBy: "owner@example.com", grantedAt: PAST }
      : { email: `${role}@example.com`, role, grantedBy: "owner@example.com", grantedAt: PAST, expiresAt };

  ok("one non-expired owner counts as 1", activeOwnerCount([entry("owner")], NOW) === 1);
  ok("an expired owner does NOT count", activeOwnerCount([entry("owner", PAST)], NOW) === 0);
  ok("expired owner plus active owner counts as 1", activeOwnerCount([entry("owner", PAST), entry("owner", FUTURE)], NOW) === 1);
  ok("two active owners count as 2", activeOwnerCount([entry("owner"), entry("owner", FUTURE)], NOW) === 2);
  ok("a non-owner row never counts", activeOwnerCount([entry("access-admin"), entry("viewer")], NOW) === 0);
}

console.log(checks.failures === 0 ? "\nROLE BUILDER VECTORS PASS" : `\n${checks.failures} FAILURE(S)`);
if (checks.failures > 0) process.exitCode = 1;
if (checks.failures > 0) process.exit(1);
