// The Remove member modal offers to revoke the person's sign-in (passkeys, recovery codes, open invites)
// as well as their role. Run with: node test/validate-offboard-revoke.ts
//
// The engine keeps two routes: POST /admin/roles/delete (queued for a second approver under dual control,
// and for an Owner target while a second Owner exists) and POST /admin/signin-factors/revoke (never queued;
// it refuses yourself, and an Owner target while two or more Owners exist). The modal decides before any
// call whether the removal will queue, because the 202 only arrives after the delete is sent.
//
// This drives the REAL renderRolesTable and the real click handlers over the shared dom-shim. The copy
// strings below are written out in full on purpose, so a drift in the product copy fails here.
//
// Coverage:
//   - default: the option is ticked and enabled, with its label, its detail and no group line.
//   - order: revoke first, then the role delete.
//   - unticked: the role delete only.
//   - queued (dual control on, or an Owner target): the option is unticked and locked with its reason and
//     nothing is revoked.
//   - refused (yourself): locked with the self reason; the removal still works.
//   - group line: shown only when the estate maps IdP groups to roles.
//   - half failures: a failed revoke deletes nothing and says so; a failed delete after a revoke says the
//     sign-in is already revoked; a delete that queues after a revoke says both.

import type { EngineClient, RoleEntry, Caller } from "../src/api.ts";
import { renderRolesTable } from "../src/screens/access-security/roles-members.ts";
import { renderRolesPanel } from "../src/screens/access-security/roles.ts";
import { makeEvent } from "./dom-shim-core.ts";
import { setCaller } from "../src/lib/store.ts";
import { installNav } from "../src/lib/nav.ts";
import { installDomShim, qs, qsa, textOf, flushAsync, type ShimNode } from "./dom-shim.ts";
import { findButtonByText, click } from "./validate-stable-components-shared.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

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

const LABEL = "Also revoke sign-in (passkeys, recovery codes, open invites)";
const DETAIL = "This deletes their passkeys, recovery codes and open invites, and ends their sessions, even if they still have access through a group. Recovery codes cannot be restored.";
const GROUP_LINE = "This estate maps IdP groups to roles. Untick this if the person keeps access through a group.";
const QUEUED_REASON = "Sign-in factors remain until the removal is approved; recovery codes cannot be restored.";
const UNKNOWN_REASON = "The console could not read the approval policy, so it does not revoke sign-in in this step. Sign-in factors remain; recovery codes cannot be restored.";
const SELF_REASON = "You cannot revoke your own sign-in factors here: it would remove every passkey, recovery code and invite you hold, and recovery codes cannot be re-derived. To replace your codes use Regenerate recovery codes; to drop a lost key remove that one passkey credential.";
const TICKED_NOTE = "Their passkeys, recovery codes and open invites are removed first. Then their role is removed.";
const SURVIVES = "Removing the role does not remove their passkey, their recovery codes or any unexpired invite. A passkey or a recovery code still signs them in.";
const POINTER = "After the removal is applied, use Revoke sign-in on the Sign-in factors list further down this tab.";

const OWNER: Caller = { method: "passkey", email: "owner1@example.com", role: "owner", groups: [], isOnlyOwner: false };

const rows: RoleEntry[] = [
  { email: "owner1@example.com", role: "owner", grantedBy: "owner1@example.com", grantedAt: "2026-01-01T00:00:00.000Z" },
  { email: "owner2@example.com", role: "owner", grantedBy: "owner1@example.com", grantedAt: "2026-01-02T00:00:00.000Z" },
  { email: "leaver@example.com", role: "operator", grantedBy: "owner1@example.com", grantedAt: "2026-01-03T00:00:00.000Z" },
  { email: "late@example.com", role: "operator", grantedBy: "owner1@example.com", grantedAt: "2026-01-04T00:00:00.000Z" },
  { email: "oldowner@example.com", role: "owner", grantedBy: "owner1@example.com", grantedAt: "2025-01-01T00:00:00.000Z", expiresAt: "2026-02-01T00:00:00.000Z" },
  { email: "admin@example.com", role: "access-admin", grantedBy: "owner1@example.com", grantedAt: "2026-01-05T00:00:00.000Z" },
];

interface FakeOpts {
  revokeFails?: boolean;
  deleteFails?: boolean;
  deleteQueues?: boolean;
  // What the approval policy read answers when the modal re-reads it at click: "off" (default), "on", or "reject".
  policyAtClick?: "off" | "on" | "reject";
}
function fakeEngine(o: FakeOpts = {}): { engine: EngineClient; calls: string[] } {
  const calls: string[] = [];
  const engine = {
    async revokeSignInFactors(email: string) {
      calls.push(`revoke:${email}`);
      if (o.revokeFails) throw new Error("revoke sign-in factors: the engine refused: 400");
      return { revoked: { passkeyCredentials: 1, recovery: true, invitesLive: 1, invitesExpired: 0 }, sessionsTerminated: true };
    },
    async deleteRole(email: string) {
      calls.push(`delete:${email}`);
      if (o.deleteFails) throw new Error("delete role: the engine refused: 400");
      if (o.deleteQueues) return { status: "pending", changeId: "chg_1", raw: {} };
      return { status: "applied", value: { deleted: true } };
    },
    async getConfigApprovalPolicy() {
      calls.push("policy");
      if (o.policyAtClick === "reject") throw new Error("get config approval policy: 500");
      return { requireConfigApproval: o.policyAtClick === "on" };
    },
    async recordAuditIntent() {
      calls.push("intent");
    },
  } as unknown as EngineClient;
  return { engine, calls };
}

function rowFor(root: unknown, needle: string): ShimNode | undefined {
  // The first cell is the member. Matching the whole row would also match every row the needle's owner granted.
  return qsa(root, "tr").find((tr) => qsa(tr, "td").some((td, i) => i === 0 && textOf(td).startsWith(needle)));
}
function revokeBox(surface: ShimNode | null): ShimNode | undefined {
  return surface ? qsa(surface, "input").find((i) => i.getAttribute("id") === "offboard-revoke") : undefined;
}
function isDisabled(n: ShimNode | undefined): boolean {
  return n !== undefined && (n.getAttribute("disabled") !== null || n.getAttribute("aria-disabled") === "true");
}

// openRemove renders the table and opens the Remove member modal for one row.
async function openRemove(
  engine: EngineClient,
  email: string,
  opts: { dualControlOn?: boolean; groupMappings?: number; policyUnknown?: boolean } = {},
): Promise<ShimNode | null> {
  const el = renderRolesTable(engine, rows, () => undefined, { dualControlOn: opts.dualControlOn ?? false, groupMappings: opts.groupMappings ?? 0, policyUnknown: opts.policyUnknown ?? false });
  const row = rowFor(el, email);
  const removeBtn = row ? findButtonByText(row, "Remove") : undefined;
  if (removeBtn) click(removeBtn);
  await flushAsync();
  return qs(document.body, ".dialog--modal");
}
async function confirm(surface: ShimNode | null): Promise<void> {
  const btn = surface ? findButtonByText(surface, "Remove member") : undefined;
  if (btn) click(btn);
  await flushAsync();
}
async function cancel(): Promise<void> {
  const surface = qs(document.body, ".dialog--modal");
  const btn = surface ? findButtonByText(surface, "Cancel") : undefined;
  if (btn) click(btn);
  await flushAsync();
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
  setCaller(OWNER);

  console.log("\n-- default: the option is ticked, enabled and worded --");
  {
    const { engine } = fakeEngine();
    const surface = await openRemove(engine, "leaver@example.com");
    const box = revokeBox(surface);
    const text = surface ? textOf(surface) : "";
    ok("the modal carries the revoke checkbox", box !== undefined);
    ok("the checkbox is ticked by default", (box as unknown as { checked?: boolean } | undefined)?.checked === true);
    ok("the checkbox is enabled", !isDisabled(box));
    ok("the label reads: Also revoke sign-in (passkeys, recovery codes, open invites)", text.includes(LABEL));
    ok("below it, what it removes, that it holds even through a group, and that recovery codes cannot be restored", text.includes(DETAIL));
    ok("ticked, the note says the sign-in goes first and then the role", text.includes(TICKED_NOTE));
    ok("ticked, the modal does not say the passkey still signs them in", !text.includes(SURVIVES));
    ok("with no group mapping there is no group line", !text.includes(GROUP_LINE));
    ok("an enabled option shows no lock reason", !text.includes(QUEUED_REASON) && !text.includes("You cannot revoke your own sign-in factors"));
    await cancel();
  }

  console.log("\n-- order: revoke first, then the role delete --");
  {
    const { engine, calls } = fakeEngine();
    const surface = await openRemove(engine, "leaver@example.com");
    await confirm(surface);
    eq("the policy is read, then revoke runs, then the role delete", calls, ["policy", "revoke:leaver@example.com", "delete:leaver@example.com"]);
    ok("the modal closes", qs(document.body, ".dialog--modal") === null);
    ok("the toast says the member was removed and the sign-in revoked", textOf(document.body).includes("Removed leaver@example.com.") && textOf(document.body).includes("Revoked 1 passkey credential, their recovery codes, 1 unexpired invite for leaver@example.com."));
  }

  console.log("\n-- unticked: the role delete only --");
  {
    const { engine, calls } = fakeEngine();
    const surface = await openRemove(engine, "leaver@example.com");
    const box = revokeBox(surface);
    if (box) {
      (box as unknown as { checked: boolean }).checked = false;
      box.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
    }
    const text = surface ? textOf(surface) : "";
    ok("unticked, the note says the passkey and recovery code still sign them in", text.includes(SURVIVES));
    ok("unticked, the note points at Revoke sign-in on the Sign-in factors list", text.includes("To remove these, use Revoke sign-in on the Sign-in factors list further down this tab."));
    await confirm(surface);
    eq("only the role delete runs", calls, ["delete:leaver@example.com"]);
  }

  console.log("\n-- queued (dual control on): locked, unticked, nothing revoked --");
  {
    const { engine, calls } = fakeEngine({ deleteQueues: true });
    const surface = await openRemove(engine, "leaver@example.com", { dualControlOn: true });
    const box = revokeBox(surface);
    const text = surface ? textOf(surface) : "";
    ok("the checkbox is disabled", isDisabled(box));
    ok("the checkbox is unticked", (box as unknown as { checked?: boolean } | undefined)?.checked === false);
    ok("the reason reads: Sign-in factors remain until the removal is approved; recovery codes cannot be restored.", text.includes(QUEUED_REASON));
    ok("the note points at Revoke sign-in for after the removal is applied", text.includes(POINTER));
    await confirm(surface);
    eq("only the role delete runs and no revoke is sent", calls, ["delete:leaver@example.com"]);
    ok("the operator is told the removal is queued", textOf(document.body).includes("This member removal is queued for approval."));
  }

  console.log("\n-- queued (an Owner target): locked, nothing revoked --");
  {
    const { engine, calls } = fakeEngine({ deleteQueues: true });
    const surface = await openRemove(engine, "owner2@example.com");
    const box = revokeBox(surface);
    ok("the Owner row's checkbox is disabled", isDisabled(box));
    ok("the Owner row's checkbox is unticked", (box as unknown as { checked?: boolean } | undefined)?.checked === false);
    ok("the Owner row gives the queued reason", (surface ? textOf(surface) : "").includes(QUEUED_REASON));
    await confirm(surface);
    eq("no revoke is sent for an Owner removal", calls, ["delete:owner2@example.com"]);
  }

  console.log("\n-- refused (yourself): locked with the self reason; the removal still works --");
  {
    const { engine, calls } = fakeEngine({ deleteQueues: true });
    const surface = await openRemove(engine, "owner1@example.com");
    const box = revokeBox(surface);
    ok("your own row's checkbox is disabled", isDisabled(box));
    ok("your own row's checkbox is unticked", (box as unknown as { checked?: boolean } | undefined)?.checked === false);
    ok("your own row gives the self-revoke reason", (surface ? textOf(surface) : "").includes(SELF_REASON));
    await confirm(surface);
    eq("the role delete still runs and no revoke is sent", calls, ["delete:owner1@example.com"]);
  }

  console.log("\n-- group line: only when the estate maps IdP groups to roles --");
  {
    const { engine } = fakeEngine();
    const withMap = await openRemove(engine, "leaver@example.com", { groupMappings: 2 });
    ok("with a mapping the group line is shown", (withMap ? textOf(withMap) : "").includes(GROUP_LINE));
    await cancel();
    const without = await openRemove(engine, "leaver@example.com", { groupMappings: 0 });
    ok("with none the group line is absent", !(without ? textOf(without) : "").includes(GROUP_LINE));
    await cancel();
  }

  console.log("\n-- the Roles panel feeds the modal: group mappings and the dual-control read --");
  {
    // The panel makes the same reads the group-mapping screen and the approval policy use, best-effort.
    const panelEngine = (groupRoles: () => Promise<unknown[]>, dual: () => Promise<{ requireConfigApproval: boolean }>): EngineClient =>
      ({
        ...fakeEngine().engine,
        listRoles: async () => rows,
        listCustomRoles: async () => [],
        listGroupRoles: groupRoles,
        getConfigApprovalPolicy: dual,
      }) as unknown as EngineClient;
    const open = async (e: EngineClient): Promise<string> => {
      const panel = renderRolesPanel(e);
      await flushAsync();
      const row = rowFor(panel, "leaver@example.com");
      const removeBtn = row ? findButtonByText(row, "Remove") : undefined;
      if (removeBtn) click(removeBtn);
      await flushAsync();
      const surface = qs(document.body, ".dialog--modal");
      const text = surface ? textOf(surface) : "";
      await cancel();
      return text;
    };
    const mapped = await open(panelEngine(async () => [{ group: "sre", role: "viewer" }, { group: "ops", role: "operator" }], async () => ({ requireConfigApproval: false })));
    ok("two group mappings put the group line in the modal", mapped.includes(GROUP_LINE));
    const none = await open(panelEngine(async () => [], async () => ({ requireConfigApproval: false })));
    ok("no group mapping leaves the group line out", !none.includes(GROUP_LINE));
    const unread = await open(panelEngine(async () => { throw new Error("list group roles: 500"); }, async () => ({ requireConfigApproval: false })));
    ok("a failed group-mapping read leaves the group line out and the option still renders", !unread.includes(GROUP_LINE) && unread.includes(LABEL));
    const dual = await open(panelEngine(async () => [], async () => ({ requireConfigApproval: true })));
    ok("dual control read as on locks the option with the queued reason", dual.includes(QUEUED_REASON));
  }

  console.log("\n-- revoke fails: nothing is deleted, and the line says so --");
  {
    const { engine, calls } = fakeEngine({ revokeFails: true });
    const surface = await openRemove(engine, "leaver@example.com");
    await confirm(surface);
    eq("the role delete is not sent", calls, ["policy", "revoke:leaver@example.com"]);
    const text = textOf(document.body);
    ok("the toast says the revoke failed and nothing was removed", text.includes("Could not revoke the sign-in of leaver@example.com, so nothing was removed. Their role and their sign-in are unchanged."));
    ok("the modal stays open so the admin can retry or untick", qs(document.body, ".dialog--modal") !== null);
    await cancel();
  }

  console.log("\n-- delete fails after a revoke: the line says the sign-in is already revoked --");
  {
    const { engine, calls } = fakeEngine({ deleteFails: true });
    const surface = await openRemove(engine, "leaver@example.com");
    await confirm(surface);
    eq("revoke ran, then the delete was tried", calls, ["policy", "revoke:leaver@example.com", "delete:leaver@example.com"]);
    ok("the toast says the sign-in was revoked and the member was not removed", textOf(document.body).includes("Revoked the sign-in of leaver@example.com, but could not remove the member. Their role is unchanged."));
    await cancel();
  }

  console.log("\n-- delete fails with the option unticked: the plain failure line --");
  {
    const { engine, calls } = fakeEngine({ deleteFails: true });
    const surface = await openRemove(engine, "leaver@example.com");
    const box = revokeBox(surface);
    if (box) (box as unknown as { checked: boolean }).checked = false;
    await confirm(surface);
    eq("no revoke, one delete attempt", calls, ["delete:leaver@example.com"]);
    ok("the plain failure line is used", textOf(document.body).includes("Could not remove the member."));
    await cancel();
  }

  console.log("\n-- the approval policy could not be read when the table loaded: locked, nothing revoked --");
  {
    const { engine, calls } = fakeEngine({ deleteQueues: true });
    const surface = await openRemove(engine, "late@example.com", { policyUnknown: true });
    const box = revokeBox(surface);
    const text = surface ? textOf(surface) : "";
    ok("the checkbox is disabled", isDisabled(box));
    ok("the checkbox is unticked", (box as unknown as { checked?: boolean } | undefined)?.checked === false);
    ok("the reason says the approval policy could not be read", text.includes(UNKNOWN_REASON));
    await confirm(surface);
    eq("no revoke is sent and the policy is not re-read for a locked box", calls, ["delete:late@example.com"]);
  }

  console.log("\n-- the policy turned on after the table loaded: the click re-read skips the revoke --");
  {
    const { engine, calls } = fakeEngine({ policyAtClick: "on", deleteQueues: true });
    const surface = await openRemove(engine, "late@example.com", { dualControlOn: false });
    ok("the table read off, so the box starts ticked", (revokeBox(surface) as unknown as { checked?: boolean } | undefined)?.checked === true);
    await confirm(surface);
    eq("the policy was re-read, no revoke was sent, the role delete was", calls, ["policy", "delete:late@example.com"]);
    const text = textOf(document.body);
    ok("the toast says sign-in was not revoked because removals now need approval", text.includes("Sign-in was not revoked: removals now need approval, and the removal waits for a second approver."));
    ok("the queued toast shows", text.includes("This member removal is queued for approval."));
  }

  console.log("\n-- approval switches on AFTER the re-read: the revoke ran and the delete queued --");
  {
    const { engine, calls } = fakeEngine({ policyAtClick: "off", deleteQueues: true });
    const surface = await openRemove(engine, "late@example.com", { dualControlOn: false });
    await confirm(surface);
    eq("order: policy read, revoke, then the delete that queued", calls, ["policy", "revoke:late@example.com", "delete:late@example.com"]);
    const text = textOf(document.body);
    ok("a warn toast says the sign-in is revoked and the role removal waits", text.includes("Revoked the sign-in of late@example.com. The role removal waits for a second approver."));
    ok("the queued toast shows too", text.includes("This member removal is queued for approval."));
  }

  console.log("\n-- the policy read on at click but the delete applied: the skip says approval was needed when checked --");
  {
    const { engine, calls } = fakeEngine({ policyAtClick: "on" });
    const surface = await openRemove(engine, "leaver@example.com", { dualControlOn: false });
    await confirm(surface);
    eq("no revoke; the delete applied", calls, ["policy", "delete:leaver@example.com"]);
    const text = textOf(document.body);
    ok("the toast uses the applied-path sentence", text.includes("Sign-in was not revoked: removals needed approval when the console checked. Use Revoke sign-in on the Sign-in factors list."));
    ok("it does not claim the removal waits for a second approver", !text.includes("Removed leaver@example.com. Sign-in was not revoked: removals now need approval"));
  }

  console.log("\n-- the click re-read cannot read the policy: the revoke is skipped and the role is removed --");
  {
    const { engine, calls } = fakeEngine({ policyAtClick: "reject" });
    const surface = await openRemove(engine, "leaver@example.com", { dualControlOn: false });
    await confirm(surface);
    eq("no revoke is sent; the role delete is", calls, ["policy", "delete:leaver@example.com"]);
    ok("the toast says sign-in was not revoked and why", textOf(document.body).includes("Sign-in was not revoked: the console could not read the approval policy."));
    ok("the removal itself is reported", textOf(document.body).includes("Removed leaver@example.com."));
  }

  console.log("\n-- the Roles panel: a rejected policy read locks the option --");
  {
    const { engine, calls } = fakeEngine();
    const panelEngine = { ...engine, listRoles: async () => rows, listCustomRoles: async () => [], listGroupRoles: async () => [], getConfigApprovalPolicy: async () => { throw new Error("get config approval policy: 500"); } } as unknown as EngineClient;
    const panel = renderRolesPanel(panelEngine);
    await flushAsync();
    const row = rowFor(panel, "leaver@example.com");
    const btn = row ? findButtonByText(row, "Remove") : undefined;
    if (btn) click(btn);
    await flushAsync();
    const surface = qs(document.body, ".dialog--modal");
    ok("the checkbox is locked and unticked", isDisabled(revokeBox(surface)) && (revokeBox(surface) as unknown as { checked?: boolean } | undefined)?.checked === false);
    ok("with the unreadable-policy reason", (surface ? textOf(surface) : "").includes(UNKNOWN_REASON));
    eq("nothing was called on the engine by opening it", calls, []);
    await cancel();
  }

  console.log("\n-- an EXPIRED Owner row is not an Owner to the engine: not locked --");
  {
    const { engine, calls } = fakeEngine();
    const surface = await openRemove(engine, "oldowner@example.com");
    const box = revokeBox(surface);
    ok("the checkbox is enabled and ticked", !isDisabled(box) && (box as unknown as { checked?: boolean } | undefined)?.checked === true);
    ok("the modal does not say the removal waits for another Owner", !(surface ? textOf(surface) : "").includes("It waits for another Owner's approval."));
    await confirm(surface);
    eq("revoke then delete run", calls, ["policy", "revoke:oldowner@example.com", "delete:oldowner@example.com"]);
  }

  console.log("\n-- the bare ADMIN_TOKEN caller: the engine exempts it from the Owner queue --");
  {
    setCaller({ method: "token", email: null, role: "owner", groups: [], isOnlyOwner: false });
    const { engine, calls } = fakeEngine();
    const surface = await openRemove(engine, "owner2@example.com");
    const box = revokeBox(surface);
    ok("an Owner row is not locked for the token caller", !isDisabled(box) && (box as unknown as { checked?: boolean } | undefined)?.checked === true);
    await confirm(surface);
    eq("revoke then delete run for the Owner", calls, ["policy", "revoke:owner2@example.com", "delete:owner2@example.com"]);
    // With approval on the token caller is still queued, so the lock holds.
    const { engine: e2 } = fakeEngine();
    const locked = await openRemove(e2, "late@example.com", { dualControlOn: true });
    ok("dual control on still locks the token caller", isDisabled(revokeBox(locked)));
    await cancel();
    setCaller(OWNER);
  }

  console.log("\n-- a NON-Owner removing their own row: the self lock, distinct from the Owner lock --");
  {
    setCaller({ method: "passkey", email: "admin@example.com", role: "access-admin", groups: [], isOnlyOwner: false });
    const { engine, calls } = fakeEngine();
    const surface = await openRemove(engine, "admin@example.com");
    const text = surface ? textOf(surface) : "";
    ok("the checkbox is locked", isDisabled(revokeBox(surface)));
    ok("the reason is the self reason", text.includes(SELF_REASON));
    ok("not the queued reason", !text.includes(QUEUED_REASON));
    ok("it does not point at Revoke sign-in, which refuses your own row", !text.includes("use Revoke sign-in"));
    ok("it says another admin can revoke it", text.includes("Another admin can revoke your sign-in with Revoke sign-in on the Sign-in factors list."));
    await confirm(surface);
    eq("only the role delete runs", calls, ["delete:admin@example.com"]);
    setCaller(OWNER);
  }

  console.log("\n-- the deletion text shows only while the option is ticked --");
  {
    const { engine } = fakeEngine();
    const surface = await openRemove(engine, "leaver@example.com");
    const box = revokeBox(surface);
    ok("ticked: the deletion text shows", (surface ? textOf(surface) : "").includes("This deletes their passkeys"));
    if (box) {
      (box as unknown as { checked: boolean }).checked = false;
      box.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
    }
    ok("unticked: the deletion text is gone", !(surface ? textOf(surface) : "").includes("This deletes their passkeys"));
    await cancel();
    const locked = await openRemove(fakeEngine().engine, "late@example.com", { dualControlOn: true });
    ok("locked: no deletion text, the lock reason instead", !(locked ? textOf(locked) : "").includes("This deletes their passkeys") && (locked ? textOf(locked) : "").includes(QUEUED_REASON));
    await cancel();
  }

  console.log(failures === 0 ? "\nAll offboard revoke checks passed." : `\n${failures} check(s) FAILED.`);
  verdictReached(failures);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\nVALIDATE-OFFBOARD-REVOKE THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
