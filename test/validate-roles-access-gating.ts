// RBAC mirror drift (ASVS V8.2): the members table (roles-members.ts) and the group-to-role mapping panel
// (roles-groups.ts) used to gate their Add/Change-role/Remove controls on canDo("owner") -- the cumulative
// RANK ladder, which maps access-admin to rank 0 (identity-model.ts's own comment there warns new code
// must gate on can(role, cap), never roleRank/hasRole) -- instead of the CAPABILITY the engine actually
// enforces (roles.write for POST /admin/roles*, access.policy for POST /admin/group-roles*), both of
// which access-admin holds. That denied an authorised access-admin caller a console control the engine
// would accept from them (fail-CLOSED, not an escalation), pushing an owner to over-grant the far more
// powerful built-in Owner role instead of the narrower access-admin the product designed for exactly
// this case.
//
// Run with: node test/validate-roles-access-gating.ts
//
// This drives the REAL renderRolesTable / groupRoleMappingPanel over the shared dom-shim (the
// validate-sessions-passkeys.ts approach), so it exercises the actual gate AND the actual click
// handlers, never a reimplementation of them.
//
// Coverage:
//   - root cause: canCap("roles.write") / canCap("access.policy") are TRUE for access-admin while
//     canDo("owner") is FALSE for it (the exact mismatch the finding describes); viewer/owner unchanged.
//   - renderRolesTable: the "Add or change a member" control is enabled for access-admin (not just
//     owner) and its handler is actually wired (a click opens the real grant modal); a viewer sees it
//     disabled-with-reason naming the roles.write capability, never a bare "Owner only".
//   - row actions: access-admin can Change role / Remove a non-owner row end to end (the real
//     engine.deleteRole call fires). An OWNER row is locked for access-admin (the engine's
//     requireNotOwnerEscalation would 400 it) with a named reason and NO attached handler
//     (a click is a genuine no-op, not just a greyed-out button); an actual Owner is unaffected. The
//     pre-existing last-Owner guard (isOnlyOwner) is unchanged by the refactor, including the
//     combined edge case (access-admin viewing the sole Owner).
//   - groupRoleMappingPanel: the add-mapping form and row Remove are usable end to end by access-admin
//     (not just owner, including a real engine.setGroupRole/deleteGroupRole call); a viewer sees the
//     capability-named reason, never the bare "Owner only".

import type { EngineClient, RoleEntry, GroupRoleEntry, Caller, CustomRole } from "../src/api.ts";
import { canDo, canCap, capGateReason } from "../src/screens/common.ts";
import { renderRolesTable, offboardToast } from "../src/screens/access-security/roles-members.ts";
import { groupRoleMappingPanel } from "../src/screens/access-security/roles-groups.ts";
import { myPermissions } from "../src/screens/access-security/roles-matrix.ts";
import { roleOrCustomRoleBadge } from "../src/screens/access-security/shared.ts";
import { customRoleChoiceValue, decodeRoleChoice, partitionGrantableCustomRoles } from "../src/screens/access-security/roles-helpers.ts";
import { callerEffectiveCapabilities } from "../src/lib/identity.ts";
import { setCaller, setWhoamiAvailable } from "../src/lib/store.ts";
import { installNav } from "../src/lib/nav.ts";
import { installDomShim, qs, qsa, textOf, flushAsync, type ShimNode } from "./dom-shim.ts";
import { findButtonByText, click } from "./validate-stable-components-shared.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(label: string, got: unknown, want: unknown): void {
  const cond = JSON.stringify(got) === JSON.stringify(want);
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// isDisabled reads EITHER refusal state, and reading only one of the two is how this check would
// quietly stop checking. Every gated control here now expresses its refusal with aria-disabled rather
// than `disabled`, so it stays in the tab order and its reason is real text a keyboard or touch user
// can reach. A reader looking only for the `disabled` attribute would report every locked row as
// unlocked, and the DISCRIMINATION assertions below (the same access-admin IS allowed a non-owner row)
// would then pass vacuously, because both rows would read as enabled. Both states are read.
//
// The title read below stays property-first with an attribute fallback: the shim mirrors `disabled`
// from the property setter into the attribute but does not mirror `title` in either direction, so a
// site that set it either way is still read. Confirmed empirically against the shim.
function isDisabled(n: ShimNode | undefined): boolean {
  return n !== undefined && (n.getAttribute("disabled") !== null || n.getAttribute("aria-disabled") === "true");
}
// isEnabled requires BOTH presence and not-disabled: `!isDisabled(x)` alone is true for
// `x === undefined` too (vacuously, since an absent control disables nothing), which would let
// an "is enabled" assertion pass even when the control never rendered at all -- confirmed by
// stash-reverting the production fix and re-running this file, which caught exactly that gap on
// two "enabled" assertions below before this helper was introduced.
function isEnabled(n: ShimNode | undefined): boolean {
  return n !== undefined && !isDisabled(n);
}
function titleOf(n: ShimNode | undefined): string {
  if (n === undefined) return "";
  return (n as unknown as { title?: string }).title || n.getAttribute("title") || "";
}
function rowFor(root: unknown, needle: string): ShimNode | undefined {
  return qsa(root, "tr").find((tr) => textOf(tr).includes(needle));
}

const OWNER: Caller = { method: "passkey", email: "owner1@example.com", role: "owner", groups: [], isOnlyOwner: false };
const ACCESS_ADMIN: Caller = { method: "passkey", email: "admin@example.com", role: "access-admin", groups: [], isOnlyOwner: false };
const VIEWER: Caller = { method: "passkey", email: "viewer@example.com", role: "viewer", groups: [], isOnlyOwner: false };
const RESTORE_OPERATOR: Caller = { method: "passkey", email: "ro@example.com", role: "restore-operator", groups: [], isOnlyOwner: false };

// A custom role that confers three capabilities (access.policy / roles.write / downpipe.write). The
// engine pins a custom-role grant's built-in role to the "viewer" FLOOR and carries the real authority as
// this object; the console must gate on its capability set, never the floor.
const CUSTOM_ROLE: CustomRole = {
  name: "backup-operator",
  label: "Backup Operator",
  capabilities: ["access.policy", "roles.write", "downpipe.write"],
  surface: {},
  presentation: "technical",
  landing: "overview",
  createdBy: "owner1@example.com",
  createdAt: "2026-07-21T00:00:00.000Z",
};
const CUSTOM_ROLE_CALLER: Caller = {
  method: "passkey", email: "custom@example.com", role: "viewer", groups: [], isOnlyOwner: false,
  customRole: CUSTOM_ROLE, customCapabilities: ["access.policy", "roles.write", "downpipe.write"],
};

function fakeMemberEngine(): { engine: EngineClient; deleteRoleCalls: string[] } {
  const deleteRoleCalls: string[] = [];
  const engine = {
    async deleteRole(email: string) {
      deleteRoleCalls.push(email);
      // deleteRole now resolves to a MutationResult (applied vs the change-control-queued 202).
      return { status: "applied", value: { deleted: true } };
    },
  } as unknown as EngineClient;
  return { engine, deleteRoleCalls };
}

async function main(): Promise<void> {
  installDomShim();
  installNav({
    navigate: () => undefined,
    onUnauthorised: () => undefined,
    refreshIdentity: async () => undefined,
    onAuthenticated: async () => undefined,
    signOut: () => undefined,
  });

  // ------------------------------------------------------------------------
  console.log("\n-- root cause: canCap(roles.write / access.policy) vs canDo(owner), per role --");
    setCaller(ACCESS_ADMIN);
    ok("access-admin holds roles.write (canCap)", canCap("roles.write"));
    ok("access-admin holds access.policy (canCap)", canCap("access.policy"));
    ok("access-admin is NOT owner-ranked (canDo) -- the root cause of the mirror drift", !canDo("owner"));

    setCaller(VIEWER);
    ok("viewer does NOT hold roles.write", !canCap("roles.write"));
    ok("viewer does NOT hold access.policy", !canCap("access.policy"));
    ok("viewer is not owner-ranked either (no false positive introduced by the fix)", !canDo("owner"));

    setCaller(OWNER);
    ok("owner holds roles.write", canCap("roles.write"));
    ok("owner holds access.policy", canCap("access.policy"));
    ok("owner is owner-ranked", canDo("owner"));

  // ------------------------------------------------------------------------
  console.log("\n-- a NAMED custom role gates by its capability set, never the viewer floor --");
  // ------------------------------------------------------------------------
  {
    setCaller(CUSTOM_ROLE_CALLER);
    // canCap must resolve the caller's EFFECTIVE set (the custom role's capabilities), not can(role) over the
    // "viewer" floor -- else every capability-gated control across the console is hidden from a custom-role holder.
    ok("Custom-role holder holds access.policy via its capability set (canCap), despite the role=viewer floor", canCap("access.policy"));
    ok("Custom-role holder holds roles.write (canCap)", canCap("roles.write"));
    ok("Custom-role holder holds downpipe.write (canCap)", canCap("downpipe.write"));
    ok("Custom-role holder does NOT hold a capability it never listed (canCap keys.ceremony false)", !canCap("keys.ceremony"));
    // canDo is the role-LADDER gate and MUST still floor: the engine pins the grant to role=viewer, so a
    // ladder-gated route genuinely denies the holder. The fix must not leak custom-role authority onto the ladder.
    ok("Custom-role holder is NOT owner-ranked -- canDo still mirrors the engine's viewer floor (no escalation)", !canDo("owner"));
    // The disabled-reason copy for a capability the custom role lacks names the custom role, not the floor.
    // keys.ceremony is OWNER-RESERVED, so its remedy is the reserved one: no Owner can grant it to this
    // custom role, and the sentence that said otherwise was naming an impossible action. The custom-role
    // half of the claim is unchanged and still asserted.
    eq(
      "CapGateReason names the custom role, not the viewer floor",
      capGateReason("keys.ceremony"),
      "Requires permission to run the key ceremony; your Backup Operator role does not hold it. It is reserved to the Owner and cannot be granted to another role, so an Owner needs to do this one.",
    );
    // The same read on a GRANTABLE capability the custom role lacks, so this claim is not resting on
    // the one capability whose remedy is special.
    eq(
      "And does the same on a grantable capability, with the grant remedy",
      capGateReason("restore.approve"),
      "Requires permission to approve a restore; your Backup Operator role does not hold it. An Owner can change this on the Access screen.",
    );
    // THE LADDER GENERATOR HAD THE SAME BUG AND KEPT IT. capGateReason was taught to read customRole; its
    // sibling gateReason was not, and it reads c.role, which for a custom-role holder is the engine's
    // viewer FLOOR. So a customer on "Backup Operator" was told "you are Viewer" on the onboarding key
    // generation, the destination form, the sources token entry and the push toggle: a false statement
    // about their own identity, inside the sentence explaining why they are stuck.
    {
      const { gateReason: gr } = await import("../src/screens/common.ts");
      const said = gr("owner");
      ok("GateReason names the custom role the caller actually holds", said.includes("Backup Operator"));
      ok("And never tells a custom-role holder they are a Viewer", !/you are Viewer/.test(said));
      ok("While still naming the role the control requires", said.startsWith("Requires the Owner role;"));
    }

    // E1/E2: a members/groups row that confers a custom role shows the role's NAME, not the "viewer" floor badge.
    // A members/groups row carries the engine's canonical custom-role NAME (a lowercase-hyphen wire value,
    // never the human label), so the badge shows the name. Using the real name here (not "Backup Operator",
    // which is a space-bearing label that fails CUSTOM_ROLE_NAME_PATTERN and can never reach a row) keeps the
    // fixture honest and lets the assertions below prove the name/label seam.
    ok("RoleOrCustomRoleBadge names the custom role on a granted row", textOf(roleOrCustomRoleBadge({ role: "viewer", customRole: "backup-operator" })).includes("backup-operator"));
    ok("RoleOrCustomRoleBadge never prints the misleading 'Viewer' floor for a custom-role row", !textOf(roleOrCustomRoleBadge({ role: "viewer", customRole: "backup-operator" })).includes("Viewer"));
    ok("RoleOrCustomRoleBadge falls back to the built-in badge when no custom role is present", textOf(roleOrCustomRoleBadge({ role: "operator" })).toLowerCase().includes("operator"));

    // E1 in the REAL render path: renderRolesTable prints the custom role's name on that member's row.
    const { engine: customEngine } = fakeMemberEngine();
    const customRow: RoleEntry[] = [{ email: "custom@example.com", role: "viewer", grantedBy: "owner1@example.com", grantedAt: "2026-01-04T00:00:00.000Z", customRole: "backup-operator" }];
    const customTable = renderRolesTable(customEngine, customRow, () => undefined);
    ok("The members table prints the custom role's NAME on the granted row (E1)", textOf(customTable).includes("backup-operator"));
    // The seam: the ROW shows the wire name, never the human label (only the caller's own whoami object carries
    // the label, rendered by the matrix below). A table that wrongly reached for the label would fail here.
    ok("The members row shows the name, not the human label (name/label seam held)", !textOf(customTable).includes("Backup Operator"));

    // ---- A grant naming a DELETED custom role ------------------------------------------------------------
    //
    // deleteCustomRole deliberately does not sweep the grants that name it: resolveAuthority ignores a name
    // that is gone, so every holder drops to the VIEWER FLOOR at their next request. Right engine behaviour,
    // but it leaves a row carrying a role name that confers nothing. Printing the pill alone tells an owner
    // auditing the table that the grant is live, which is the false authority this badge exists to prevent,
    // in the other direction.
    const liveCat = ["backup-operator"];
    ok(
      "a grant naming a LIVE custom role is not marked deleted",
      !textOf(roleOrCustomRoleBadge({ role: "viewer", customRole: "backup-operator" }, liveCat)).includes("deleted"),
    );
    ok(
      "a grant naming a DELETED custom role says so",
      textOf(roleOrCustomRoleBadge({ role: "viewer", customRole: "gone-role" }, liveCat)).includes("deleted"),
    );
    ok(
      "and names the floor the holder actually has",
      textOf(roleOrCustomRoleBadge({ role: "viewer", customRole: "gone-role" }, liveCat)).includes("viewer floor"),
    );
    ok(
      "the role name is still shown, so the row can be found and fixed",
      textOf(roleOrCustomRoleBadge({ role: "viewer", customRole: "gone-role" }, liveCat)).includes("gone-role"),
    );
    // The catalogue read is best-effort, so an EMPTY list must mean "not known", never "all deleted".
    ok(
      "an empty catalogue makes no claim either way",
      !textOf(roleOrCustomRoleBadge({ role: "viewer", customRole: "backup-operator" }, [])).includes("deleted"),
    );
    // Names are engine-canonicalised to lower case; a catalogue entry differing only in case is the SAME role.
    ok(
      "matching is case-insensitive, so a case difference is not a deletion",
      !textOf(roleOrCustomRoleBadge({ role: "viewer", customRole: "Backup-Operator" }, liveCat)).includes("deleted"),
    );
    // A built-in role row must never acquire the marker, whatever the catalogue says.
    ok(
      "a built-in role row is never marked deleted",
      !textOf(roleOrCustomRoleBadge({ role: "operator" }, liveCat)).includes("deleted"),
    );

    // E3: the "What can I do" matrix resolves the caller's EFFECTIVE capabilities and names the custom role.
    setWhoamiAvailable(true);
    const perms = myPermissions();
    ok("The permission matrix head names the custom role, not the 'Viewer' floor (E3)", textOf(perms).includes("Backup Operator"));
    // roles.write IS held by the custom role, so its row is allowed and its requires-hint is ABSENT. Pre-fix
    // (can("viewer", "roles.write") === false) this row was denied and the hint would show -- the regression guard.
    ok("A capability the custom role HOLDS is not shown as denied (roles.write requires-hint absent)", !textOf(perms).includes("requires Access admin or Owner"));
    // keys.ceremony is NOT held, so it is still honestly shown as denied (the fix did not flip everything green).
    ok("A capability the custom role LACKS is still shown as denied (keys.ceremony requires Owner)", textOf(perms).includes("requires Owner"));

    // ---- WRITE-surface coherence ------------------------------------------------------------------------
    // The custom role holds downpipe.write but NOT downpipe.delete or run.trigger, so the three downpipe
    // verbs the detail drawer renders must gate INDEPENDENTLY: create/edit enabled, delete + trigger disabled.
    // canCap is exactly what the drawer reads per action, so asserting it here asserts the drawer's own gates.
    ok("CanCap('downpipe.write') true (Edit + New downpipe enabled)", canCap("downpipe.write"));
    ok("CanCap('downpipe.delete') false (Delete stays disabled)", !canCap("downpipe.delete"));
    ok("CanCap('run.trigger') false (Run now stays disabled)", !canCap("run.trigger"));
    ok("CanCap('drill.run') false (Drill stays disabled)", !canCap("drill.run"));
    // Coherence: the matrix and the write gate must AGREE. The split matrix shows "Create and edit" allowed
    // AND "Delete downpipes"/"Trigger a downpipe run" as requires-hinted, never a single row that claims all
    // three while the drawer disables two of them (the self-contradiction a half-fix would leave behind).
    // READ PER ROW, NOT PER PAGE. These three used to ask whether the label appeared anywhere in the
    // matrix, and roles-matrix.ts emits `cap.label` in the ALLOWED branch and the DENIED branch alike:
    // only the dot class and the trailing requires-badge differ. So the presence of "Create and edit
    // downpipes" was true whether the row was allowed or denied, and the two "still gated" lines were
    // satisfied by exactly the same text they would show if the gate had been lifted. The proof is in the
    // rendered matrix itself: "Delete downpipes" is a DENIED row here and its label prints verbatim.
    // These are the coherence claims, so they now read each row's own state.
    const permRow = (label: string): ShimNode | undefined => qsa(perms, "li").find((li) => textOf(li).includes(label));
    const rowIsAllowed = (label: string): boolean => {
      const row = permRow(label);
      // The allowed branch renders dot--ok and no badge; the denied branch renders dot--neutral and a
      // "requires ..." badge inside the SAME li. Both are checked, so neither alone can carry the claim.
      return row !== undefined && qsa(row, ".dot--ok").length === 1 && !textOf(row).includes("requires ");
    };
    const rowIsDenied = (label: string, requires: string): boolean => {
      const row = permRow(label);
      return row !== undefined && qsa(row, ".dot--neutral").length === 1 && textOf(row).includes(`requires ${requires}`);
    };
    ok("The create/edit ROW is allowed, dot and all, with no requires-hint on it", rowIsAllowed("Create and edit downpipes"));
    ok("The Delete ROW is gated and says so on the row (matches canCap('downpipe.delete') false)", rowIsDenied("Delete downpipes", "Operator, Approver or Owner"));
    ok("The Trigger ROW is gated and says so on the row (matches canCap('run.trigger') false)", rowIsDenied("Trigger a downpipe run", "Operator, Approver or Owner"));
    // And the discrimination the three lines above rest on: allowed and denied rows must be
    // DISTINGUISHABLE at all. If roles-matrix.ts ever rendered one shape for both, every per-row assertion
    // here would go quietly weak rather than red, which is the failure this whole block was rewritten for.
    ok("Allowed and denied rows are told apart by the render, not by their label", rowIsAllowed("Create and edit downpipes") !== rowIsAllowed("Delete downpipes"));
    setWhoamiAvailable(false);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- restore-operator: run.trigger and drill.run are DISTINCT (the canary vs drill seam) --");
    // restore-operator is off the operator ladder: the engine grants it drill.run + the restore lifecycle,
    // but NOT run.trigger / downpipe.write / downpipe.delete. So a capability gate must tell run.trigger and
    // drill.run apart, or a control that posts /canary/run or /trigger (run.trigger) is enabled then 403s. This
    // is an exact mis-mirror worth locking down (canary was wrongly gated on drill.run).
    setCaller(RESTORE_OPERATOR);
    ok("restore-operator HOLDS drill.run (drill / canary-drill controls enabled)", canCap("drill.run"));
    ok("restore-operator does NOT hold run.trigger (Fly the canary now + Run now stay disabled, engine gates /canary/run + /trigger on run.trigger)", !canCap("run.trigger"));
    ok("restore-operator does NOT hold downpipe.write (New downpipe / Edit disabled)", !canCap("downpipe.write"));
    ok("restore-operator does NOT hold downpipe.delete (Delete disabled)", !canCap("downpipe.delete"));
    ok("restore-operator HOLDS restore.request (restore inbox nav + bulk-restore enabled)", canCap("restore.request"));

  const memberRows: RoleEntry[] = [
    { email: "owner1@example.com", role: "owner", grantedBy: "owner1@example.com", grantedAt: "2026-01-01T00:00:00.000Z" },
    { email: "owner2@example.com", role: "owner", grantedBy: "owner1@example.com", grantedAt: "2026-01-02T00:00:00.000Z" },
    { email: "teammate@example.com", role: "operator", grantedBy: "owner1@example.com", grantedAt: "2026-01-03T00:00:00.000Z" },
  ];

  // ------------------------------------------------------------------------
  console.log("\n-- renderRolesTable: the Add control gates on roles.write, not owner rank --");
  // ------------------------------------------------------------------------
  {
    setCaller(OWNER);
    const { engine } = fakeMemberEngine();
    const el = renderRolesTable(engine, memberRows, () => undefined);
    const addBtn = findButtonByText(el, "Add or change a member");
    ok("owner: the Add control renders", addBtn !== undefined);
    ok("owner: the Add control is enabled", isEnabled(addBtn));
  }
  {
    setCaller(ACCESS_ADMIN);
    const { engine } = fakeMemberEngine();
    const el = renderRolesTable(engine, memberRows, () => undefined);
    const addBtn = findButtonByText(el, "Add or change a member");
    ok("access-admin: the Add control renders", addBtn !== undefined);
    ok("access-admin: the Add control is ENABLED (the RBAC mirror-drift regression)", isEnabled(addBtn));

    // Prove the handler is actually attached (the old bug ALSO skipped addEventListener for a
    // non-owner), not just that the disabled flag happens to read false.
    if (addBtn) click(addBtn);
    await flushAsync();
    const surface = qs(document.body, ".dialog--modal");
    ok("access-admin: clicking Add opens the real grant modal", surface !== null);
    ok("access-admin: the opened modal is the add/change-member modal", surface !== null && textOf(surface).includes("Add or change a member"));
    const cancelBtn = surface ? findButtonByText(surface, "Cancel") : undefined;
    ok("access-admin: the modal has a Cancel action", cancelBtn !== undefined);
    if (cancelBtn) click(cancelBtn);
    await flushAsync();
    ok("access-admin: the modal closes on Cancel", qs(document.body, ".dialog--modal") === null);
  }
  {
    setCaller(VIEWER);
    const { engine } = fakeMemberEngine();
    const el = renderRolesTable(engine, memberRows, () => undefined);
    const addBtn = findButtonByText(el, "Add or change a member");
    ok("viewer: the Add control is disabled", isDisabled(addBtn));
    eq(
      "viewer: the disabled reason names the roles.write capability (not a bare 'Owner only')",
      titleOf(addBtn),
      "Requires permission to manage roles; your Viewer role does not hold it. An Owner can change this on the Access screen.",
    );

    // The empty-table state gates its own "Add a member" action the same way.
    const emptyEl = renderRolesTable(engine, [], () => undefined);
    ok("viewer: the empty-state has no Add action", findButtonByText(emptyEl, "Add a member") === undefined);
  }
  {
    setCaller(OWNER);
    const { engine } = fakeMemberEngine();
    const emptyEl = renderRolesTable(engine, [], () => undefined);
    ok("owner: the empty-state DOES offer an Add action", findButtonByText(emptyEl, "Add a member") !== undefined);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- renderRolesTable row actions: access-admin acts on a non-owner row end to end --");
  // ------------------------------------------------------------------------
  {
    setCaller(ACCESS_ADMIN);
    const { engine, deleteRoleCalls } = fakeMemberEngine();
    const el = renderRolesTable(engine, memberRows, () => undefined);
    const row = rowFor(el, "teammate@example.com");
    ok("access-admin: the operator row renders", row !== undefined);
    const changeBtn = row ? findButtonByText(row, "Change role") : undefined;
    const removeBtn = row ? findButtonByText(row, "Remove") : undefined;
    ok("access-admin: Change role is enabled on a non-owner row", isEnabled(changeBtn));
    ok("access-admin: Remove is enabled on a non-owner row", isEnabled(removeBtn));

    if (removeBtn) click(removeBtn);
    await flushAsync();
    const surface = qs(document.body, ".dialog--modal");
    const confirmBtn = surface ? findButtonByText(surface, "Remove member") : undefined;
    ok("access-admin: the remove-member confirm modal opens", confirmBtn !== undefined);
    if (confirmBtn) click(confirmBtn);
    await flushAsync();
    eq("access-admin: engine.deleteRole actually fired for the operator", deleteRoleCalls, ["teammate@example.com"]);
    ok("access-admin: the confirm modal closes afterwards", qs(document.body, ".dialog--modal") === null);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- renderRolesTable row actions: an OWNER row is locked for access-admin --");
  // ------------------------------------------------------------------------
  {
    setCaller(ACCESS_ADMIN);
    const { engine, deleteRoleCalls } = fakeMemberEngine();
    const el = renderRolesTable(engine, memberRows, () => undefined);
    const row = rowFor(el, "owner2@example.com");
    const changeBtn = row ? findButtonByText(row, "Change role") : undefined;
    const removeBtn = row ? findButtonByText(row, "Remove") : undefined;
    ok("access-admin: Change role is DISABLED on an Owner row", isDisabled(changeBtn));
    ok("access-admin: Remove is DISABLED on an Owner row", isDisabled(removeBtn));
    eq("access-admin: the reason names the owner-escalation rule", titleOf(changeBtn), "Only an Owner may change or remove another Owner.");
    eq("access-admin: Remove carries the same reason", titleOf(removeBtn), "Only an Owner may change or remove another Owner.");

    // No listener is attached in the locked state, so a click must be a genuine no-op (this is
    // not merely a visual disable the engine would still 400 on -- a real dead-end button never
    // exists in the DOM at all).
    if (changeBtn) click(changeBtn);
    if (removeBtn) click(removeBtn);
    await flushAsync();
    eq("access-admin: clicking the locked Owner row never calls the engine", deleteRoleCalls, []);
    ok("access-admin: clicking the locked row opens no modal", qs(document.body, ".dialog--modal") === null);
  }
  {
    // An actual Owner caller is unaffected: they can still act on another Owner's row.
    setCaller(OWNER);
    const { engine } = fakeMemberEngine();
    const el = renderRolesTable(engine, memberRows, () => undefined);
    const row = rowFor(el, "owner2@example.com");
    const changeBtn = row ? findButtonByText(row, "Change role") : undefined;
    const removeBtn = row ? findButtonByText(row, "Remove") : undefined;
    ok("owner: Change role stays enabled on another Owner's row", isEnabled(changeBtn));
    ok("owner: Remove stays enabled on another Owner's row (2 active owners, not the last one)", isEnabled(removeBtn));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- renderRolesTable: the pre-existing last-Owner guard is unchanged by the refactor --");
  // ------------------------------------------------------------------------
  const soleOwnerRow: RoleEntry[] = [{ email: "owner1@example.com", role: "owner", grantedBy: "owner1@example.com", grantedAt: "2026-01-01T00:00:00.000Z" }];
  {
    setCaller(OWNER);
    const { engine } = fakeMemberEngine();
    const el = renderRolesTable(engine, soleOwnerRow, () => undefined);
    const row = rowFor(el, "owner1@example.com");
    const changeBtn = row ? findButtonByText(row, "Change role") : undefined;
    const removeBtn = row ? findButtonByText(row, "Remove") : undefined;
    ok("owner viewing the sole Owner row: Change role stays enabled", isEnabled(changeBtn));
    ok("owner viewing the sole Owner row: Remove is disabled (the last-Owner guard)", isDisabled(removeBtn));
    eq(
      "the reason is the last-Owner text, not the new owner-row-lock text",
      titleOf(removeBtn),
      "You cannot remove the only Owner. Promote another member to Owner first.",
    );
  }
  {
    // The combined edge case this fix introduces: access-admin viewing the SOLE Owner. Both guards
    // are simultaneously true; Remove shows the (also true) last-Owner reason, Change role shows the
    // owner-row-lock reason (isOnlyOwner never gated Change role, before or after this fix).
    setCaller(ACCESS_ADMIN);
    const { engine } = fakeMemberEngine();
    const el = renderRolesTable(engine, soleOwnerRow, () => undefined);
    const row = rowFor(el, "owner1@example.com");
    const changeBtn = row ? findButtonByText(row, "Change role") : undefined;
    const removeBtn = row ? findButtonByText(row, "Remove") : undefined;
    ok("access-admin viewing the sole Owner: Change role is disabled (owner-row lock)", isDisabled(changeBtn));
    ok("access-admin viewing the sole Owner: Remove is disabled (last-Owner guard wins)", isDisabled(removeBtn));
    eq("access-admin viewing the sole Owner: Change role names the owner-escalation rule", titleOf(changeBtn), "Only an Owner may change or remove another Owner.");
    eq("access-admin viewing the sole Owner: Remove names the last-Owner guard", titleOf(removeBtn), "You cannot remove the only Owner. Promote another member to Owner first.");
  }

  // ------------------------------------------------------------------------
  console.log("\n-- groupRoleMappingPanel: gates on access.policy, not owner rank --");
  // ------------------------------------------------------------------------
  const groupRows: GroupRoleEntry[] = [{ group: "engineering", role: "operator", grantedBy: "owner1@example.com", grantedAt: "2026-01-01T00:00:00.000Z" }];

  async function renderGroupPanel(deleteGroupRoleCalls: string[], setGroupRoleCalls: Array<{ group: string; role: string }>): Promise<HTMLElement> {
    const engine = {
      async listGroupRoles() {
        return groupRows;
      },
      // The mappings table reads the custom-role catalogue beside the rows to tell a live custom-role grant
      // from one naming a deleted role. The fixture answers with the roles the group rows name, so the table
      // makes no deletion claim about them.
      async listCustomRoles() {
        return groupRows.filter((r) => r.customRole).map((r) => ({ name: r.customRole, label: r.customRole, capabilities: [] }));
      },
      async deleteGroupRole(group: string) {
        deleteGroupRoleCalls.push(group);
        // deleteGroupRole now resolves to a MutationResult (applied vs the change-control-queued 202).
        return { status: "applied", value: { deleted: true } };
      },
      async setGroupRole(group: string, role: string) {
        setGroupRoleCalls.push({ group, role });
        return { status: "applied", value: { group, role, grantedBy: "owner1@example.com", grantedAt: "2026-01-01T00:00:00.000Z" } };
      },
    } as unknown as EngineClient;
    const panel = groupRoleMappingPanel(engine);
    await flushAsync();
    return panel;
  }

  {
    setCaller(OWNER);
    const panel = await renderGroupPanel([], []);
    ok("owner: the add-mapping form renders", findButtonByText(panel, "Add mapping") !== undefined);
    ok("owner: no gated-access card (the panel is fully usable)", !textOf(panel).includes("requires the Owner or Access-admin role for writes"));
    const row = rowFor(panel, "engineering");
    const removeBtn = row ? findButtonByText(row, "Remove") : undefined;
    ok("owner: Remove is enabled on a group-mapping row", isEnabled(removeBtn));
  }
  {
    setCaller(ACCESS_ADMIN);
    const deleteGroupRoleCalls: string[] = [];
    const panel = await renderGroupPanel(deleteGroupRoleCalls, []);
    ok("access-admin: the add-mapping form renders (the RBAC mirror-drift regression)", findButtonByText(panel, "Add mapping") !== undefined);
    ok("access-admin: no gated-access card", !textOf(panel).includes("requires the Owner or Access-admin role for writes"));
    const row = rowFor(panel, "engineering");
    const removeBtn = row ? findButtonByText(row, "Remove") : undefined;
    ok("access-admin: Remove is enabled on a group-mapping row", isEnabled(removeBtn));

    if (removeBtn) click(removeBtn);
    await flushAsync();
    const surface = qs(document.body, ".dialog--modal");
    const confirmBtn = surface ? findButtonByText(surface, "Remove mapping") : undefined;
    ok("access-admin: the remove-mapping confirm modal opens", confirmBtn !== undefined);
    if (confirmBtn) click(confirmBtn);
    await flushAsync();
    eq("access-admin: engine.deleteGroupRole actually fired", deleteGroupRoleCalls, ["engineering"]);
    ok("access-admin: the confirm modal closes afterwards", qs(document.body, ".dialog--modal") === null);
  }
  {
    // The add-mapping form is not just rendered but actually wired for access-admin: filling the
    // group name and clicking Add mapping must reach the real engine.setGroupRole.
    setCaller(ACCESS_ADMIN);
    const setGroupRoleCalls: Array<{ group: string; role: string }> = [];
    const panel = await renderGroupPanel([], setGroupRoleCalls);
    const groupInput = qs(panel, "#group-role-group") as unknown as { value: string } | null;
    ok("access-admin: the add-mapping group-name field renders", groupInput !== null);
    if (groupInput) groupInput.value = "sre-oncall";
    const addMappingBtn = findButtonByText(panel, "Add mapping");
    ok("access-admin: the Add mapping button renders", addMappingBtn !== undefined);
    if (addMappingBtn) click(addMappingBtn);
    await flushAsync();
    eq("access-admin: engine.setGroupRole actually fired for the new mapping", setGroupRoleCalls, [{ group: "sre-oncall", role: "viewer" }]);
  }
  {
    setCaller(VIEWER);
    const panel = await renderGroupPanel([], []);
    ok("viewer: no add-mapping form", findButtonByText(panel, "Add mapping") === undefined);
    ok("viewer: sees the gated-access card naming both roles", textOf(panel).includes("requires the Owner or Access-admin role for writes"));
    const row = rowFor(panel, "engineering");
    ok("viewer: the row shows no live buttons", row !== undefined && qsa(row, "button").length === 0);
    ok("viewer: the row denial names the access.policy capability", row !== undefined && textOf(row).includes("Requires permission to manage access policy; your Viewer role does not hold it. An Owner can change this on the Access screen."));
    ok("viewer: the row denial is NOT the bare 'Owner only' string", row !== undefined && !textOf(row).includes("Owner only"));
  }

  // ------------------------------------------------------------------------
  // The IdP-cleanup attestation must never be CLAIMED when its write failed.
  //
  // The bug: removing a member is one engine call; recording the operator's "I have removed them in our
  // IdP" confirmation is a SECOND, separately failable audit write. That write sat in an empty catch, and
  // the toast said "IdP removal recorded." either way. So a compliance reviewer later reads the audit
  // export, finds no access-policy-change-intent entry for a departed employee, and the console's claim
  // is not merely unprovable, it is FALSE. A failed attestation write is exactly the entry that does not
  // exist, so the pack is silent about it by construction: the only fix is to stop asserting it.
  {
    console.log("\nthe offboarding toast states only what actually landed");
    const landed = offboardToast("bob@example.com", true, true);
    ok("ticked + write landed: the attestation is claimed", landed.message.includes("IdP removal recorded."));
    ok("ticked + write landed: not a warning", landed.tone === undefined);

    const lost = offboardToast("bob@example.com", true, false);
    ok("ticked + write FAILED: the attestation is NOT claimed", !lost.message.includes("IdP removal recorded."));
    ok("ticked + write FAILED: it says the confirmation was not recorded", lost.message.includes("NOT recorded in the audit trail"));
    ok("ticked + write FAILED: it still confirms the removal itself succeeded", lost.message.includes("The removal itself is audited."));
    ok("ticked + write FAILED: it is a warning, not a calm success", lost.tone === "warn");

    const unticked = offboardToast("bob@example.com", false, true);
    ok("not ticked: no attestation is claimed", !unticked.message.includes("IdP removal recorded."));
    ok("not ticked: the operator is reminded the IdP step is theirs", unticked.message.includes("Remember to remove them in your IdP / Access."));
    ok("not ticked: not a warning (nothing failed)", unticked.tone === undefined);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- a group-roles read fault reads an honest error, not a second pending-engine note --");
  // ------------------------------------------------------------------------
  {
    setCaller(OWNER);
    const panelWithLoadError = async (err: Error): Promise<HTMLElement> => {
      // listCustomRoles is present and REJECTS here on purpose: the mappings read is what this case is about,
      // and a catalogue failure must not be the thing that decides the outcome.
      const engine = { async listGroupRoles() { throw err; }, async listCustomRoles() { throw err; } } as unknown as EngineClient;
      const panel = groupRoleMappingPanel(engine);
      await flushAsync();
      return panel;
    };
    // A 404 is the genuine not-wired build: the pending-engine note is honest.
    const notWired = await panelWithLoadError(new Error("group-roles: 404"));
    ok("A 404 keeps the pending-engine note (route genuinely not wired)", textOf(notWired).includes("not yet active on this engine build"));
    ok("The 404 note is not a block-error Retry", findButtonByText(notWired, "Retry") === undefined);
    // A 500 is the engine live and broken: an honest block error with Retry, never a second pending note.
    const broken = await panelWithLoadError(new Error("group-roles: 500"));
    ok("A 500 renders a block error with Retry", findButtonByText(broken, "Retry") !== undefined);
    ok("The 500 does NOT render the 'could not load' pending-engine note", !textOf(broken).includes("not yet active on this engine build"));
    // A network throw (unreachable) is likewise a real fault, not an unbuilt feature.
    const network = await panelWithLoadError(new TypeError("Failed to fetch"));
    ok("A network throw renders a block error with Retry", findButtonByText(network, "Retry") !== undefined);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- the custom-role grant: a role you can compose is a role you can hand out --");
  // ------------------------------------------------------------------------
  // The gap this closes was a SCREEN THAT WAS NEVER WIRED, not a missing feature. The engine's setRole and
  // setGroupRole have always taken a customRole in place of a built-in one and rejected an unknown name; the
  // client layer has always had assignCustomRole and assignGroupCustomRole; the whole read side (the row
  // badge, callerCan, the matrix, the dangling-reference warning) was built to display the result. Only the
  // two pickers were missing, so a customer could compose a custom role in the builder and then had no
  // console control that could give it to anybody, while the builder's own empty state told them a custom
  // role is reached by an explicit grant or a group mapping that names it.
  //
  // These assertions therefore drive the REAL pickers and assert on the REAL client call, not on the option
  // list alone: an option a customer can select that sends setRole would look identical in the DOM and would
  // grant the viewer floor instead of the role they chose.
  {
    // The picker's own encoding, checked directly because both screens depend on it and a silent change of
    // shape would send a custom-role name into the built-in role field.
    eq("decodeRoleChoice reads a custom choice back", decodeRoleChoice(customRoleChoiceValue("backup-operator")), { kind: "custom", name: "backup-operator" });
    eq("decodeRoleChoice reads a built-in choice back", decodeRoleChoice("owner"), { kind: "builtin", role: "owner" });
    ok("decodeRoleChoice refuses a value that names neither, rather than falling back to the viewer floor", decodeRoleChoice("superuser") === null);
    ok("decodeRoleChoice refuses an empty custom name", decodeRoleChoice("custom:") === null);

    // The no-escalation mirror. Owner holds every capability, access-admin holds roles.write and
    // access.policy but NOT downpipe.write, which backup-operator confers, so the engine's
    // requireGrantWithinAuthority would refuse that grant from an access-admin with a 400.
    const ownerCaps = callerEffectiveCapabilities("owner", null);
    const adminCaps = callerEffectiveCapabilities("access-admin", null);
    eq("an owner may grant backup-operator", partitionGrantableCustomRoles([CUSTOM_ROLE], ownerCaps).grantable.map((r) => r.name), ["backup-operator"]);
    eq("an access-admin may NOT: backup-operator confers downpipe.write, which they do not hold", partitionGrantableCustomRoles([CUSTOM_ROLE], adminCaps).withheld.map((r) => r.name), ["backup-operator"]);
  }
  {
    // THE DIRECT GRANT, end to end. The fake records which client method the Save actually called: the whole
    // point is that a custom-role choice must NOT travel as setRole.
    setCaller(OWNER);
    const calls: string[] = [];
    const engine = {
      async setRole(email: string, role: string) { calls.push(`setRole:${email}:${role}`); return { status: "applied", value: { email, role, grantedBy: "owner1@example.com", grantedAt: "2026-08-04T00:00:00.000Z" } }; },
      async assignCustomRole(email: string, customRole: string) { calls.push(`assignCustomRole:${email}:${customRole}`); return { status: "applied", value: { email, role: "viewer", customRole, grantedBy: "owner1@example.com", grantedAt: "2026-08-04T00:00:00.000Z", inviteState: "already-enrolled" } }; },
    } as unknown as EngineClient;

    const el = renderRolesTable(engine, memberRows, () => undefined, { customRoles: [CUSTOM_ROLE] });
    const addBtn = findButtonByText(el, "Add or change a member");
    if (addBtn) click(addBtn);
    await flushAsync();
    const surface = qs(document.body, ".dialog--modal");
    ok("owner: the grant modal opens", surface !== null);

    const roleSelect = surface ? qs(surface, "select#role-role") : null;
    const optionValues = roleSelect === null ? [] : qsa(roleSelect, "option").map((o) => o.getAttribute("value"));
    ok("the picker offers the custom role alongside the six built-ins", optionValues.includes("custom:backup-operator"));
    ok("the six built-ins are still all there (the custom entries are an addition, not a replacement)", ["viewer", "operator", "approver", "owner", "restore-operator", "access-admin"].every((r) => optionValues.includes(r)));
    ok("the custom option names the role's label, its stored name and how much authority it confers", textOf(roleSelect).includes("Backup Operator (custom role: backup-operator, 3 capabilities)"));

    // The ceremony, named before they agree to it: every grant from this modal is a step-up gated write.
    const modalText = surface === null ? "" : textOf(surface);
    ok("the form says a passkey prompt may appear", modalText.includes("asked to confirm with your own passkey"));
    ok("and says what a dismissed prompt leaves behind", /dismiss[^.]{0,160}\bnothing\b/i.test(modalText));

    // Select the custom role and save. This is the assertion the whole pass exists for.
    const emailInput = surface ? qs(surface, "input#role-email") : null;
    if (emailInput) (emailInput as unknown as { value: string }).value = "newcomer@example.com";
    if (roleSelect) (roleSelect as unknown as { value: string }).value = "custom:backup-operator";
    const saveBtn = surface ? findButtonByText(surface, "Save role") : undefined;
    ok("the modal has a Save action", saveBtn !== undefined);
    if (saveBtn) click(saveBtn);
    await flushAsync();
    eq("saving a custom-role choice calls assignCustomRole, never setRole", calls, ["assignCustomRole:newcomer@example.com:backup-operator"]);
    const done = qs(document.body, ".dialog--modal");
    if (done) { const c = findButtonByText(done, "Cancel"); if (c) click(c); }
    await flushAsync();
  }
  {
    // The withheld direction, in the real render: an access-admin cannot confer downpipe.write, so the option
    // is not offered (never a live control that fails server-side) and the form says why rather than dropping it.
    setCaller(ACCESS_ADMIN);
    const { engine } = fakeMemberEngine();
    const el = renderRolesTable(engine, memberRows, () => undefined, { customRoles: [CUSTOM_ROLE] });
    const addBtn = findButtonByText(el, "Add or change a member");
    if (addBtn) click(addBtn);
    await flushAsync();
    const surface = qs(document.body, ".dialog--modal");
    const roleSelect = surface ? qs(surface, "select#role-role") : null;
    const optionValues = roleSelect === null ? [] : qsa(roleSelect, "option").map((o) => o.getAttribute("value"));
    ok("access-admin: the custom role they cannot confer is NOT offered", !optionValues.includes("custom:backup-operator"));
    ok("access-admin: the form names it as withheld rather than dropping it in silence", surface !== null && textOf(surface).includes("Not offered: backup-operator"));
    const cancelBtn = surface ? findButtonByText(surface, "Cancel") : undefined;
    if (cancelBtn) click(cancelBtn);
    await flushAsync();
  }
  {
    // The negative control, so a green above cannot be the picker printing custom entries unconditionally.
    setCaller(OWNER);
    const { engine } = fakeMemberEngine();
    const el = renderRolesTable(engine, memberRows, () => undefined);
    const addBtn = findButtonByText(el, "Add or change a member");
    if (addBtn) click(addBtn);
    await flushAsync();
    const surface = qs(document.body, ".dialog--modal");
    const roleSelect = surface ? qs(surface, "select#role-role") : null;
    const optionValues = roleSelect === null ? [] : qsa(roleSelect, "option").map((o) => o.getAttribute("value"));
    eq("with an empty catalogue the picker offers exactly the six built-ins", optionValues, ["viewer", "operator", "approver", "owner", "restore-operator", "access-admin"]);
    ok("and says nothing about withheld roles", surface !== null && !textOf(surface).includes("Not offered:"));
    const cancelBtn = surface ? findButtonByText(surface, "Cancel") : undefined;
    if (cancelBtn) click(cancelBtn);
    await flushAsync();
  }
  {
    // THE GROUP MAPPING, the other half of the same gap. Same discipline: assert on the client call.
    setCaller(OWNER);
    const calls: string[] = [];
    const engine = {
      async listGroupRoles(): Promise<GroupRoleEntry[]> { return []; },
      async listCustomRoles(): Promise<CustomRole[]> { return [CUSTOM_ROLE]; },
      async setGroupRole(group: string, role: string) { calls.push(`setGroupRole:${group}:${role}`); return { status: "applied", value: { group, role, grantedBy: "owner1@example.com", grantedAt: "2026-08-04T00:00:00.000Z" } }; },
      async assignGroupCustomRole(group: string, customRole: string) { calls.push(`assignGroupCustomRole:${group}:${customRole}`); return { status: "applied", value: { group, role: "viewer", customRole, grantedBy: "owner1@example.com", grantedAt: "2026-08-04T00:00:00.000Z" } }; },
    } as unknown as EngineClient;
    const panel = groupRoleMappingPanel(engine);
    await flushAsync();

    const roleSelect = qs(panel, "select#group-role-role");
    const optionValues = roleSelect === null ? [] : qsa(roleSelect, "option").map((o) => o.getAttribute("value"));
    ok("the mapping picker offers the custom role", optionValues.includes("custom:backup-operator"));
    ok("the mapping picker still never offers Owner (a group can never confer it)", !optionValues.includes("owner"));
    ok("the add-row says a passkey prompt may appear", textOf(panel).includes("asked to confirm with your own passkey"));
    ok("and says what a dismissed prompt leaves behind", /dismiss[^.]{0,160}\bnothing\b/i.test(textOf(panel)));

    const groupInput = qs(panel, "input#group-role-group");
    if (groupInput) (groupInput as unknown as { value: string }).value = "platform-engineering";
    if (roleSelect) (roleSelect as unknown as { value: string }).value = "custom:backup-operator";
    const saveBtn = findButtonByText(panel, "Add mapping");
    ok("the add-row has a save control", saveBtn !== undefined);
    if (saveBtn) click(saveBtn);
    await flushAsync();
    eq("mapping a group to a custom role calls assignGroupCustomRole, never setGroupRole", calls, ["assignGroupCustomRole:platform-engineering:backup-operator"]);
  }

  // ------------------------------------------------------------------------
  // EVERY AUTHORISATION REFUSAL NAMES A REMEDY. The two generators named what was needed and why it was
  // refused and then stopped, across roughly forty call sites, so a customer read a correct refusal and
  // was told nothing about how to stop being stuck. A refusal a customer cannot act on is a defect even
  // when the refusal is right. Asserted over the WHOLE closed capability union rather than a sample, so a
  // future capability cannot arrive without the remedy.
  {
    console.log("\n-- every authorisation refusal names who can lift it --");
    setCaller({ method: "access", email: "v@test", role: "viewer", groups: [] } as unknown as Caller);
    setWhoamiAvailable(true);
    const { CAPABILITY_PHRASE } = await import("../src/screens/capability-copy.ts");
    const caps = Object.keys(CAPABILITY_PHRASE) as Array<keyof typeof CAPABILITY_PHRASE>;
    ok("the capability union was read, not an empty list", caps.length > 0);
    // THERE ARE TWO LAWFUL REMEDIES, and which one is correct depends on whether the capability can be
    // granted at all. keys.ceremony and posture.riskaccept are OWNER_RESERVED_CAPABILITIES: the owner
    // built-in alone holds them, the role builder refuses to place them in a custom role, and the engine
    // mirrors that bar. Telling their refused caller "An Owner can change this on the Access screen" named
    // an action NO Owner can take, which is the failure GRANT_REMEDY's own note calls the unrecoverable
    // one. So the assertion is no longer "every refusal carries the grant sentence"; it is "every refusal
    // carries the remedy that is TRUE for it", which is a stronger claim and still total over the union.
    const { OWNER_RESERVED_CAPABILITIES } = await import("../src/lib/identity.ts");
    const GRANT = "An Owner can change this on the Access screen.";
    const RESERVED = "It is reserved to the Owner and cannot be granted to another role, so an Owner needs to do this one.";
    ok("every capability refusal still names a remedy", caps.every((c) => capGateReason(c).endsWith(GRANT) || capGateReason(c).endsWith(RESERVED)));
    ok(
      "a grantable capability is told an Owner can grant it",
      caps.every((c) => OWNER_RESERVED_CAPABILITIES.has(c) || capGateReason(c).endsWith(GRANT)),
    );
    ok(
      "an owner-reserved capability is NEVER told to ask for a grant that cannot exist",
      caps.every((c) => !OWNER_RESERVED_CAPABILITIES.has(c) || (capGateReason(c).endsWith(RESERVED) && !capGateReason(c).includes(GRANT))),
    );
    // ANTI-VACUITY: if the reserved set were empty, the two assertions above would both hold for free.
    ok("anti-vacuity: the owner-reserved set is not empty and is a subset of the phrased union", OWNER_RESERVED_CAPABILITIES.size > 0 && caps.some((c) => OWNER_RESERVED_CAPABILITIES.has(c)));
    ok("and still names the permission and the role held", capGateReason("restore.apply").startsWith("Requires permission to apply a restore; your Viewer role does not hold it."));

    const { gateReason } = await import("../src/screens/common.ts");
    ok("the role-ladder refusal names a remedy too", /An Owner can change this on the Access screen\./.test(gateReason("owner")));

    // NEGATIVE CONTROL: the blind-gate branch is a DIFFERENT state with a different answer. The console
    // has not learned the caller's role, so nobody needs to grant anything and telling them to ask an
    // Owner would send a real Owner to themselves. That branch must stay as it was.
    setCaller(null);
    setWhoamiAvailable(false);
    ok("negative control: an unresolved identity is not told to ask for a permission", !/An Owner can change this/.test(capGateReason("restore.apply")));
    // Same claim, new sentence: the blind refusal now carries a remedy after it (lib/identity-remedy.ts).
    ok("negative control: and it still says the role was never reported", /has not reported your role/.test(capGateReason("restore.apply")));
  }

  // ------------------------------------------------------------------------
  console.log(failures === 0 ? "\nAll roles access-gating checks passed." : `\n${failures} check(s) FAILED.`);
    if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\nVALIDATE-ROLES-ACCESS-GATING THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
