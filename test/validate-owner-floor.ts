// validate-owner-floor: the console MIRROR of the single-owner dual-control deadlock guard. The engine
// is the authority; this proves the console stops the operator UPFRONT so
// they never hit a cryptic 400. Run with: node test/validate-owner-floor.ts
//
// Coverage:
//   PURE (src/lib/owner-floor.ts): the floor arithmetic + its fail-safe.
//   RULE A (the dual-control toggle, security-centre/access.ts): a SOLE Owner sees the "Require approval"
//     switch DISABLED with "Add a second Owner ..."; an Owner with a second Owner sees it enabled.
//   RULE B (the members table, access-security/roles-members.ts): with dual control ON, the Remove control on
//     an Owner row is BLOCKED at a two-owner estate (dual-control reason) and enabled at a three-owner estate;
//     with dual control OFF it is enabled down to the last Owner; the last-Owner guard reason is preserved. The
//     demote path (Change role -> a lesser role) is pre-empted inline for a floor-breaching demotion.
//
// It drives the REAL renderRolesTable / configApprovalControl over the shared dom-shim (the
// validate-roles-access-gating.ts approach), so it exercises the actual controls and handlers, not a re-impl.

import type { Caller, EngineClient, RoleEntry } from "../src/api.ts";
import { installNav } from "../src/lib/nav.ts";
import {canRequireDualControl, DUAL_CONTROL_FLOOR_REMOVE_REASON,
  ENABLE_DUAL_CONTROL_NEEDS_TWO_OWNERS, ownerFloor,
  removingOwnerWouldStrand, 
} from "../src/lib/owner-floor.ts";
import { setCaller } from "../src/lib/store.ts";
import { renderRolesTable } from "../src/screens/access-security/roles-members.ts";
import { configApprovalControl } from "../src/screens/security-centre/access.ts";
import { flushAsync, installDomShim, qs, qsa, type ShimNode, textOf } from "./dom-shim.ts";
import { click, findButtonByText } from "./validate-stable-components-shared.ts";

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
// isDisabled reads EITHER refusal state. The members-table Remove control expresses its Owner-floor
// lock with aria-disabled rather than `disabled` now, so it stays in the tab order and its reason is
// real text a keyboard or touch user can reach. Reading only the `disabled` attribute here would not
// merely fail; once corrected the wrong way it would PASS VACUOUSLY on the assertions that matter
// most in this file, the ones asserting a NON-owner row stays enabled and a three-Owner estate can
// trim to two, because every row would read as enabled. Both states are read so the discrimination
// keeps its meaning.
function isDisabled(n: ShimNode | undefined): boolean {
  return n !== undefined && (n.getAttribute("disabled") !== null || n.getAttribute("aria-disabled") === "true");
}
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
function switchOf(root: unknown): ShimNode | undefined {
  return qsa(root, "button").find((b) => b.getAttribute("role") === "switch");
}

const OWNER: Caller = { method: "passkey", email: "owner1@example.com", role: "owner", groups: [], isOnlyOwner: false };
const OWNER_SOLE: Caller = { method: "passkey", email: "owner1@example.com", role: "owner", groups: [], isOnlyOwner: true };
const ONLY_OWNER_REASON = "You cannot remove the only Owner. Promote another member to Owner first.";

function member(email: string, role: RoleEntry["role"]): RoleEntry {
  return { email, role, grantedBy: "owner1@example.com", grantedAt: "2026-01-01T00:00:00.000Z" };
}
const TWO_OWNERS: RoleEntry[] = [member("owner1@example.com", "owner"), member("owner2@example.com", "owner"), member("op@example.com", "operator")];
const THREE_OWNERS: RoleEntry[] = [member("owner1@example.com", "owner"), member("owner2@example.com", "owner"), member("owner3@example.com", "owner")];
const SOLE_OWNER: RoleEntry[] = [member("owner1@example.com", "owner")];

function fakeEngine(): { engine: EngineClient; setRoleCalls: Array<{ email: string; role: string }>; deleteRoleCalls: string[] } {
  const setRoleCalls: Array<{ email: string; role: string }> = [];
  const deleteRoleCalls: string[] = [];
  const engine = {
    async setRole(email: string, role: string) { setRoleCalls.push({ email, role }); return { status: "applied", value: member(email, role as RoleEntry["role"]) }; },
    async deleteRole(email: string) { deleteRoleCalls.push(email); return { status: "applied", value: { deleted: true } }; },
    async getConfigApprovalPolicy() { return { requireConfigApproval: false, requireChangeNumber: false, notifyNewSignInContext: false }; },
  } as unknown as EngineClient;
  return { engine, setRoleCalls, deleteRoleCalls };
}

function removeBtnFor(el: HTMLElement, email: string): ShimNode | undefined {
  const row = rowFor(el, email);
  return row ? findButtonByText(row, "Remove") : undefined;
}

async function main(): Promise<void> {
  installDomShim();
  installNav({ navigate: () => undefined, onUnauthorised: () => undefined, refreshIdentity: async () => undefined, onAuthenticated: async () => undefined, signOut: () => undefined });

  // =============================================================================================
  console.log("-- pure owner-floor mirror (src/lib/owner-floor.ts) --");
  // =============================================================================================
  ok("ownerFloor: off = 1", ownerFloor(false) === 1);
  ok("ownerFloor: on = 2", ownerFloor(true) === 2);
  ok("enable: refused with 1 Owner", canRequireDualControl(1) === false);
  ok("enable: allowed with 2 Owners", canRequireDualControl(2) === true);
  ok("enable: fail-safe on NaN", canRequireDualControl(Number.NaN) === false);
  ok("remove: gate off, 2 Owners -> allowed", removingOwnerWouldStrand(2, false) === false);
  ok("remove: gate off, 1 Owner -> blocked", removingOwnerWouldStrand(1, false) === true);
  ok("remove: gate on, 2 Owners -> blocked", removingOwnerWouldStrand(2, true) === true);
  ok("remove: gate on, 3 Owners -> allowed", removingOwnerWouldStrand(3, true) === false);
  ok("remove: fail-safe on NaN -> blocked", removingOwnerWouldStrand(Number.NaN, true) === true);

  // =============================================================================================
  console.log("\n-- RULE B: the members table Remove control mirrors the Owner floor --");
  // =============================================================================================
  {
    // Dual control ON at a TWO-owner estate: each Owner row's Remove is blocked with the dual-control reason.
    setCaller(OWNER);
    const { engine } = fakeEngine();
    const el = renderRolesTable(engine, TWO_OWNERS, () => undefined, { dualControlOn: true });
    ok("2 owners + dual control ON: Owner-row Remove is DISABLED", isDisabled(removeBtnFor(el, "owner2@example.com")));
    eq("2 owners + dual control ON: the reason is the dual-control floor", titleOf(removeBtnFor(el, "owner2@example.com")), DUAL_CONTROL_FLOOR_REMOVE_REASON);
    ok("2 owners + dual control ON: a NON-owner row Remove stays enabled (no over-block)", isEnabled(removeBtnFor(el, "op@example.com")));
  }
  {
    // Dual control OFF at the same estate: the floor is one, so Remove is enabled (unchanged behaviour).
    setCaller(OWNER);
    const { engine } = fakeEngine();
    const el = renderRolesTable(engine, TWO_OWNERS, () => undefined, { dualControlOn: false });
    ok("2 owners + dual control OFF: Owner-row Remove is ENABLED (floor of one)", isEnabled(removeBtnFor(el, "owner2@example.com")));
  }
  {
    // Dual control ON at a THREE-owner estate: Remove is enabled (the estate can trim to two).
    setCaller(OWNER);
    const { engine } = fakeEngine();
    const el = renderRolesTable(engine, THREE_OWNERS, () => undefined, { dualControlOn: true });
    ok("3 owners + dual control ON: Owner-row Remove is ENABLED (can trim to two)", isEnabled(removeBtnFor(el, "owner3@example.com")));
  }
  {
    // The last-Owner guard still wins its own reason, even under dual control.
    setCaller(OWNER);
    const { engine } = fakeEngine();
    const el = renderRolesTable(engine, SOLE_OWNER, () => undefined, { dualControlOn: true });
    ok("1 owner: Owner-row Remove is DISABLED", isDisabled(removeBtnFor(el, "owner1@example.com")));
    eq("1 owner: the reason is the existing last-Owner text (not the dual-control text)", titleOf(removeBtnFor(el, "owner1@example.com")), ONLY_OWNER_REASON);
  }

  // =============================================================================================
  console.log("\n-- RULE B: a floor-breaching Owner DEMOTION is pre-empted inline (Change role) --");
  // =============================================================================================
  {
    // 2 owners + dual control ON: opening Change role on an Owner and picking a lesser role is refused inline;
    // the engine is never called.
    setCaller(OWNER);
    const { engine, setRoleCalls } = fakeEngine();
    const el = renderRolesTable(engine, TWO_OWNERS, () => undefined, { dualControlOn: true });
    const row = rowFor(el, "owner2@example.com");
    const changeBtn = row ? findButtonByText(row, "Change role") : undefined;
    ok("2 owners + dual control ON: Change role on an Owner row is reachable", isEnabled(changeBtn));
    if (changeBtn) click(changeBtn);
    await flushAsync();
    const modal = qs(document.body, ".dialog--modal");
    ok("the Change-role modal opened", modal !== null);
    const roleSelect = modal ? (qs(modal, "#role-role") as unknown as { value: string } | null) : null;
    ok("the role select rendered", roleSelect !== null);
    if (roleSelect) roleSelect.value = "operator"; // a demotion of this Owner
    const saveBtn = modal ? findButtonByText(modal, "Save role") : undefined;
    if (saveBtn) click(saveBtn);
    await flushAsync();
    eq("the floor-breaching demotion NEVER called engine.setRole", setRoleCalls, []);
    ok("the form shows the dual-control floor reason", modal !== null && textOf(modal).includes(DUAL_CONTROL_FLOOR_REMOVE_REASON));
    const cancelBtn = modal ? findButtonByText(modal, "Cancel") : undefined;
    if (cancelBtn) click(cancelBtn);
    await flushAsync();
  }
  {
    // 3 owners + dual control ON: the SAME demotion is allowed (the engine call fires).
    setCaller(OWNER);
    const { engine, setRoleCalls } = fakeEngine();
    const el = renderRolesTable(engine, THREE_OWNERS, () => undefined, { dualControlOn: true });
    const row = rowFor(el, "owner3@example.com");
    const changeBtn = row ? findButtonByText(row, "Change role") : undefined;
    if (changeBtn) click(changeBtn);
    await flushAsync();
    const modal = qs(document.body, ".dialog--modal");
    const roleSelect = modal ? (qs(modal, "#role-role") as unknown as { value: string } | null) : null;
    if (roleSelect) roleSelect.value = "operator";
    const saveBtn = modal ? findButtonByText(modal, "Save role") : undefined;
    if (saveBtn) click(saveBtn);
    await flushAsync();
    eq("3 owners: the demotion IS allowed (engine.setRole fired)", setRoleCalls, [{ email: "owner3@example.com", role: "operator" }]);
  }

  // =============================================================================================
  console.log("\n-- RULE A: the dual-control toggle mirrors the enable guard --");
  // =============================================================================================
  {
    // A SOLE Owner: the "Require approval" switch is disabled with the "add a second Owner" reason.
    setCaller(OWNER_SOLE);
    const { engine } = fakeEngine();
    const el = configApprovalControl(engine);
    await flushAsync();
    const sw = switchOf(el);
    ok("sole Owner: the Require-approval switch renders", sw !== undefined);
    // Disabled-with-reason, not the native `disabled` attribute: the sole-Owner rule-a
    // refusal is aria-disabled, so the switch stays reachable and announces why. Unlike isDisabled()
    // above (still correct for the Remove button, which IS natively disabled), this switch's own
    // reason states are checked directly.
    ok("sole Owner: the switch is DISABLED (cannot arm dual control)", sw !== undefined && sw.getAttribute("aria-disabled") === "true");
    ok("sole Owner: the card explains a second Owner is needed", textOf(el).includes(ENABLE_DUAL_CONTROL_NEEDS_TWO_OWNERS));
  }
  {
    // An Owner with a second Owner: the switch is enabled (the engine still re-checks server-side).
    setCaller(OWNER);
    const { engine } = fakeEngine();
    const el = configApprovalControl(engine);
    await flushAsync();
    const sw = switchOf(el);
    ok("second Owner present: the Require-approval switch is ENABLED", isEnabled(sw));
    ok("second Owner present: the 'needs a second Owner' note is absent", !textOf(el).includes(ENABLE_DUAL_CONTROL_NEEDS_TWO_OWNERS));
  }

  console.log(failures === 0 ? "\nAll console owner-floor checks passed." : `\n${failures} check(s) FAILED.`);
    if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\nVALIDATE-OWNER-FLOOR THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
