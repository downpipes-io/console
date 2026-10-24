// The in-app members and roles table, its row actions, the single
// member-removal ceremony, and the grant/change-role modal. The table mirrors the engine;
// the engine is the boundary. openRoleForm is split into buildRoleForm (the fields and
// body), saveRoleForm (the Save action) and presentRoleGrantResult (the committed-grant
// outcome).

import { h, svgIcon } from "../../lib/dom.ts";
import { canDo, canCap, capGateReason, refuseWithReason } from "../common.ts";
import { caller, goSignedOut, refreshIdentity } from "../../lib/nav.ts";
import { errorStatus, isUnauthorised } from "../../lib/errors.ts";
import { recordAdminWrite, recordContractSkew, writeOutcomeForStatus } from "../../lib/client-diag/ring.ts";
import { codeBlock } from "../../components/code-block.ts";
import { dataTable } from "../../components/data-table.ts";
import { field, validateForm } from "../../components/field.ts";
import { confirmModal, openModal } from "../../components/modal.ts";
import { toast } from "../../components/toast.ts";
import { surfacePendingChange } from "../../lib/pending-change-toast.ts";
import { isPendingResult } from "../../lib/api/types/config-changes.ts";
import { emptyState } from "../../components/feedback.ts";
import { relativeTime, absoluteTime, titleCase } from "../../lib/format.ts";
import { ICON_EXTERNAL, ICON_INFO, ICON_PLUS } from "../../lib/icons.ts";
import type { EngineClient, RoleEntry, Role, CustomRole, SignInFactorRevokeResult } from "../../api.ts";
import { inviteStateOf, inviteTokenOf, inviteNoticeOf } from "../../api.ts";
import { roleOrCustomRoleBadge } from "./shared.ts";
import { SELF_REVOKE_REASON, revokeSummary } from "./signin-factors.ts";
import { errorDetail } from "../../components/error-view.ts";
import {
  BUILTIN_ROLE_NAME,
  customRoleChoiceValue,
  customRoleOptionLabel,
  decodeRoleChoice,
  expiryBadge,
  partitionGrantableBuiltinRoles,
  partitionGrantableCustomRoles,
  withheldBuiltinRolesNote,
} from "./roles-helpers.ts";
import { callerEffectiveCapabilities, roleRank } from "../../lib/identity.ts";
import { removingOwnerWouldStrand, DUAL_CONTROL_FLOOR_REMOVE_REASON } from "../../lib/owner-floor.ts";

// Count only non-expired owners, mirroring the engine's effectiveRole()-based count:
// a time-boxed Owner grant that has lapsed must not count (it would diverge from the
// server-side last-Owner guard). Exported as a pure predicate so it can be unit tested.
export function activeOwnerCount(rows: RoleEntry[], now: number = Date.now()): number {
  return rows.filter((r) => r.role === "owner" && (!r.expiresAt || Date.parse(r.expiresAt) > now)).length;
}

// effectiveOwner is the engine's own test for "this row is an Owner": the Owner role with any expiry applied. An
// expired Owner grant is not an Owner to the engine, so it neither queues a removal nor blocks a revoke.
export function effectiveOwner(r: RoleEntry, now: number = Date.now()): boolean {
  return r.role === "owner" && (!r.expiresAt || Date.parse(r.expiresAt) > now);
}

export function renderRolesTable(engine: EngineClient, rows: RoleEntry[], reload: () => void, opts: { dualControlOn?: boolean; customRoles?: readonly CustomRole[]; groupMappings?: number; policyUnknown?: boolean } = {}): HTMLElement {
  const wrap = h("div", { class: "stack", style: "display:grid;gap:var(--space-3)" });
  // The custom-role catalogue is read best-effort beside this table (roles.ts). It feeds two things: the
  // badge, which needs only the names to tell a live custom-role grant from one naming a deleted role, and
  // the grant picker, which needs the whole record (label, capability set) to offer the role and to say what
  // it confers. An empty list is "not known", never "nothing exists".
  const customRoles = opts.customRoles ?? [];
  const knownCustomRoles = customRoles.map((r) => r.name);
  // Gate on the roles.write CAPABILITY, not the canDo("owner") cumulative rank -- the engine's
  // real gate for POST /admin/roles(/delete) is roles.write, which access-admin also holds (it maps to
  // rank 0, off the ladder, so canDo("owner") wrongly denied it this whole table).
  const canManageRoles = canCap("roles.write");
  const me = caller()?.email ?? null;
  const ownerCount = activeOwnerCount(rows);
  // Rule b mirror: while dual control is armed the Owner floor is TWO, not one, so removing or demoting an
  // Owner down to a lone Owner is blocked (it would deadlock dual control: no distinct second approver). Passed
  // in from the panel (best-effort; defaults OFF so a failed policy read never over-blocks). The engine enforces.
  const dualControlOn = opts.dualControlOn === true;

  // Toolbar: a /-filterable members table with the roles.write-gated Add control.
  const addBtn = canManageRoles
    ? h("button", { "data-dp": "access-security.button.add#1", class: "btn btn--primary btn--sm", type: "button" }, svgIcon(ICON_PLUS, { size: 14 }), "Add or change a member")
    : h("button", { "data-dp": "access-security.button.add#2", class: "btn btn--primary btn--sm", type: "button" }, svgIcon(ICON_PLUS, { size: 14 }), "Add or change a member");
  if (canManageRoles) addBtn.addEventListener("click", () => openRoleForm(engine, null, reload, { customRoles }));
  else refuseWithReason(addBtn, capGateReason("roles.write"));

  const toolbar = h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);flex-wrap:wrap" });
  toolbar.appendChild(h("h3", { style: "font-size:var(--text-md)" }, "Members and roles"));
  toolbar.appendChild(addBtn);
  wrap.appendChild(toolbar);

  if (rows.length === 0) {
    wrap.appendChild(
      emptyState({
        title: "Only you so far",
        body: "The first person to sign in through Cloudflare Access or a passkey is the bootstrap Owner. Grant roles by verified email. A Cloudflare Access or passkey member with no grant holds Viewer; an SSO sign-in with no grant is refused.",
        ...(canManageRoles ? { action: { label: "Add a member", onClick: () => openRoleForm(engine, null, reload, { customRoles }) } } : {}),
      }),
    );
    return wrap;
  }

  const handle = dataTable<RoleEntry>({
    label: "Members and roles",
    rows,
    rowKey: (r) => r.email,
    filter: { placeholder: "Filter members by email", resultLabel: "members", getText: (r) => `${r.email} ${r.role} ${r.grantedBy}` },
    initialSort: { key: "email", dir: "asc" },
    columns: [
      {
        key: "email",
        header: "Member",
        sortable: true,
        sortValue: (r) => r.email,
        render: (r) => {
          const cell = h("span", h("span", { class: "mono" }, r.email));
          // The "You" badge compares EMAILS by design: the role-management UI is email-based (invite
          // and display by email; the bind-to-subject step is engine-internal and the subject is not
          // projected onto RoleEntry). Both sides are the
          // engine-canonicalised role-table email, so this is a display match, not an authorisation
          // key (which the engine keys on subject server-side); do not "rectify" it to subject.
          if (me && r.email === me) cell.appendChild(h("span", { class: "badge badge--accent", style: "margin-left:var(--space-2)" }, "You"));
          return cell;
        },
      },
      { key: "role", header: "Role", sortable: true, sortValue: (r) => roleRank(r.role), render: (r) => roleOrCustomRoleBadge(r, knownCustomRoles) },
      { key: "by", header: "Granted by", render: (r) => h("span", { class: "mono" }, r.grantedBy) },
      { key: "at", header: "Granted", sortable: true, sortValue: (r) => r.grantedAt, render: (r) => h("span", { title: absoluteTime(r.grantedAt) }, relativeTime(r.grantedAt)) },
      { key: "exp", header: "Expires", render: (r) => (r.expiresAt ? expiryBadge(r.expiresAt) : h("span", { class: "field__hint" }, "no expiry")) },
      {
        key: "actions",
        header: "Actions",
        srOnlyHeader: true,
        width: "1px",
        render: (r) => rowActions(engine, r, { canManageRoles, me, ownerCount, dualControlOn, customRoles, groupMappings: opts.groupMappings ?? 0, policy: opts.policyUnknown === true ? "unknown" : dualControlOn ? "on" : "off" }, reload),
      },
    ],
  });
  wrap.appendChild(handle.el);

  wrap.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "A member with no grant holds Viewer (through Cloudflare Access or a passkey); an SSO sign-in with none is refused. The system retains at least one Owner (two under dual approval); removing or demoting one below that floor is refused, and the console mirrors the block.",
    ),
  );
  return wrap;
}

// The last-Owner guard reason, shared by the disabled state's title AND a visible hint
// (title-only is invisible to keyboard and touch users).
const ONLY_OWNER_REASON = "You cannot remove the only Owner. Promote another member to Owner first.";

// ownerRemoveLock is the client mirror of the engine's Owner floor for the Remove and demote controls (rule
// b). An Owner row is locked when removing or demoting it would strand the estate below its floor: the last
// Owner keeps the existing reason, and a live dual-control estate at exactly two Owners gets the dual-control
// reason. A non-Owner row is never floor-locked. The engine re-checks server-side; this stops it upfront.
function ownerRemoveLock(role: Role, ownerCount: number, dualControlOn: boolean): { reason: string } | null {
  if (role !== "owner") return null;
  if (ownerCount <= 1) return { reason: ONLY_OWNER_REASON };
  if (removingOwnerWouldStrand(ownerCount, dualControlOn)) return { reason: DUAL_CONTROL_FLOOR_REMOVE_REASON };
  return null;
}

// The engine's requireNotOwnerEscalation hard-blocks any non-Owner caller --
// including access-admin, who otherwise holds roles.write -- from changing or removing an OWNER
// row. Disabling here (rather than offering a control that 400s on click) mirrors this file's own
// isOnlyOwner precedent and the "never a live control that fails server-side" rule (the footer of myPermissions in roles-matrix.ts).
const OWNER_ROW_REASON = "Only an Owner may change or remove another Owner.";

function rowActions(
  engine: EngineClient,
  entry: RoleEntry,
  ctx: { canManageRoles: boolean; me: string | null; ownerCount: number; dualControlOn: boolean; customRoles: readonly CustomRole[]; groupMappings: number; policy: ApprovalPolicy },
  reload: () => void,
): HTMLElement {
  const wrap = h("div", { style: "display:grid;gap:var(--space-1);justify-items:end" });
  if (!ctx.canManageRoles) {
    wrap.appendChild(h("span", { class: "field__hint" }, capGateReason("roles.write")));
    return wrap;
  }

  // See OWNER_ROW_REASON: an owner row is locked for a caller who holds roles.write but is not
  // themselves Owner-ranked (e.g. access-admin); canDo("owner") is the right check here (it is the
  // engine's actual owner-escalation gate), not canManageRoles.
  const ownerRowLocked = entry.role === "owner" && !canDo("owner");
  // The Owner floor lock (raised to two under dual control, rule b): removing or demoting this Owner would
  // strand the estate below its floor. The engine also refuses it server-side.
  const floorLock = ownerRemoveLock(entry.role, ctx.ownerCount, ctx.dualControlOn);

  const btnRow = h("div", { style: "display:flex;gap:var(--space-1);justify-content:flex-end" });
  const changeBtn = h("button", { "data-dp": "access-security.button.change", class: "btn btn--ghost btn--sm", type: "button" }, "Change role");
  if (ownerRowLocked) {
    refuseWithReason(changeBtn, OWNER_ROW_REASON);
  } else {
    // The floor context rides into the form so a demotion of this Owner that would breach the floor is
    // pre-empted inline (saveRoleForm), not left to the engine's 400. Changing to Owner or editing expiry is
    // still allowed; only a floor-breaching demotion is stopped.
    changeBtn.addEventListener("click", () => openRoleForm(engine, entry, reload, { floor: { ownerCount: ctx.ownerCount, dualControlOn: ctx.dualControlOn }, customRoles: ctx.customRoles }));
  }
  btnRow.appendChild(changeBtn);

  // The Owner-floor guard mirror (rule b): pre-empt a removal that would strand the estate with the
  // engine's own reason; the engine also refuses it server-side. Removal routes through the SINGLE offboarding
  // ceremony (IdP checkbox + recorded intent), so which entry point the owner used never changes what is recorded.
  const removeBtn = h("button", { "data-dp": "access-security.button.remove#2", class: "btn btn--ghost btn--sm", type: "button" }, "Remove");
  if (floorLock) {
    refuseWithReason(removeBtn, floorLock.reason);
  } else if (ownerRowLocked) {
    refuseWithReason(removeBtn, OWNER_ROW_REASON);
  } else {
    removeBtn.addEventListener("click", () => openOffboardModal(engine, entry.email, { ownerRemovalQueues: effectiveOwner(entry) && caller()?.method !== "token", me: ctx.me, policy: ctx.policy, groupMappings: ctx.groupMappings }, reload));
  }
  btnRow.appendChild(removeBtn);
  wrap.appendChild(btnRow);
  if (floorLock) {
    wrap.appendChild(h("span", { class: "field__hint", style: "max-width:28ch;text-align:right" }, floorLock.reason));
  } else if (ownerRowLocked) {
    wrap.appendChild(h("span", { class: "field__hint", style: "max-width:28ch;text-align:right" }, OWNER_ROW_REASON));
  }
  return wrap;
}

// offboardToast is the HONEST post-removal message. The member removal and the IdP-cleanup
// attestation are two separate writes, and the second one can fail on its own (an older engine
// without the intent route, a 403, a dropped connection). The message therefore states only what
// actually landed:
//   - not ticked            -> the removal, plus the reminder that the IdP step is still theirs.
//   - ticked, write landed  -> the removal, plus the attestation ("recorded"), which the audit
//                              trail can now be shown to support.
//   - ticked, write FAILED  -> the removal, plus the plain fact that the attestation was NOT
//                              recorded, and the one action that fixes it (tick it again). It is a
//                              WARN, because a compliance reviewer reading the audit export later
//                              would otherwise find nothing where the console promised an entry.
// Pure (no DOM), so the validator can drive all three branches without a browser.
export function offboardToast(email: string, idpConfirmed: boolean, intentRecorded: boolean): { message: string; tone?: "warn" } {
  if (!idpConfirmed) return { message: `Removed ${email}. Remember to remove them in your IdP / Access.` };
  if (intentRecorded) return { message: `Removed ${email}. IdP removal recorded.` };
  return {
    message: `Removed ${email}, but your IdP-removal confirmation was NOT recorded in the audit trail (the engine refused or could not be reached). The removal itself is audited. Confirm it again to record the attestation.`,
    tone: "warn",
  };
}

// What the Remove member modal knows about the person and the estate before anything is sent.
export interface OffboardContext {
  // True when the engine will queue this removal for a second Owner: the target's EFFECTIVE role is Owner (an
  // expired Owner grant is not) and the caller is not the bare ADMIN_TOKEN, which the engine exempts.
  ownerRemovalQueues: boolean;
  me: string | null;
  // The approval policy as the table read it: "unknown" when the read failed.
  policy: ApprovalPolicy;
  // How many IdP group-to-role mappings the estate holds (0 when none, or when the read did not answer).
  groupMappings: number;
}

export type ApprovalPolicy = "on" | "off" | "unknown";

export const OFFBOARD_REVOKE_LABEL = "Also revoke sign-in (passkeys, recovery codes, open invites)";
export const OFFBOARD_REVOKE_DETAIL =
  "This deletes their passkeys, recovery codes and open invites, and ends their sessions, even if they still have access through a group. Recovery codes cannot be restored.";
export const OFFBOARD_GROUP_HINT = "This estate maps IdP groups to roles. Untick this if the person keeps access through a group.";
export const OFFBOARD_QUEUED_REASON = "Sign-in factors remain until the removal is approved; recovery codes cannot be restored.";
export const OFFBOARD_UNKNOWN_REASON = "The console could not read the approval policy, so it does not revoke sign-in in this step. Sign-in factors remain; recovery codes cannot be restored.";
export const OFFBOARD_SKIPPED_ON = "Sign-in was not revoked: removals now need approval, and the removal waits for a second approver. Revoke sign-in after the removal is applied.";
export const OFFBOARD_SKIPPED_ON_APPLIED = "Sign-in was not revoked: removals needed approval when the console checked. Use Revoke sign-in on the Sign-in factors list.";
export const OFFBOARD_SKIPPED_UNKNOWN = "Sign-in was not revoked: the console could not read the approval policy. Use Revoke sign-in on the Sign-in factors list.";
const OFFBOARD_QUEUED_POINTER = "After the removal is applied, use Revoke sign-in on the Sign-in factors list further down this tab.";

export type OffboardRevokePlan = { locked: false } | { locked: true; reason: string; kind: "self" | "queued" | "unknown" };

// offboardRevokePlan decides BEFORE any call whether the revoke option is offered. The 202 that says a delete
// was queued only arrives after the delete is sent, so the console works it out from what it already knows.
//   - Yourself: the engine refuses to revoke your own sign-in factors. The removal still works.
//   - Dual control on: the delete queues for a second approver, whoever the target is.
//   - An Owner target whose removal queues (ownerRemovalQueues): the engine queues the removal of an effective
//     Owner while two or more Owners exist, whatever the dual-control setting, and refuses to revoke that Owner.
//   - The approval policy could not be read: the console cannot know whether the delete will queue, so it
//     does not revoke. An unknown is never read as "off".
// A locked option is unticked and disabled, and nothing is revoked.
export function offboardRevokePlan(email: string, ctx: OffboardContext): OffboardRevokePlan {
  if (ctx.me !== null && email === ctx.me) return { locked: true, reason: SELF_REVOKE_REASON, kind: "self" };
  if (ctx.policy === "on" || ctx.ownerRemovalQueues) return { locked: true, reason: OFFBOARD_QUEUED_REASON, kind: "queued" };
  if (ctx.policy === "unknown") return { locked: true, reason: OFFBOARD_UNKNOWN_REASON, kind: "unknown" };
  return { locked: false };
}

// offboardFailureToast says which half of a two-step removal ran. "revoke" failed first, so nothing was
// deleted; "delete-after-revoke" means the sign-in is already gone and the role is still there.
export function offboardFailureToast(stage: "revoke" | "delete-after-revoke" | "delete", email: string, detail: string): { message: string; tone: "warn" } {
  if (stage === "revoke") return { message: `Could not revoke the sign-in of ${email}, so nothing was removed. Their role and their sign-in are unchanged. ${detail}`, tone: "warn" };
  if (stage === "delete-after-revoke") return { message: `Revoked the sign-in of ${email}, but could not remove the member. Their role is unchanged. ${detail}`, tone: "warn" };
  return { message: `Could not remove the member. ${detail}`, tone: "warn" };
}

// offboardEffectNote is the paragraph under the revoke option. It follows the box: ticked, it says what the
// removal takes; unticked or locked, it says what survives and where to finish the job.
function offboardEffectNote(revoking: boolean, plan: OffboardRevokePlan): string {
  if (revoking) return "Their passkeys, recovery codes and open invites are removed first. Then their role is removed.";
  const survives =
    "Removing the role does not remove their passkey, their recovery codes or any unexpired invite. A passkey or a recovery code still signs them in. A recovery code or an invite can enrol a new passkey only if the engine cannot read the role table, or finds it empty.";
  // Your own row cannot be revoked from the Sign-in factors list (it refuses your own row), so it names who can.
  const finish =
    plan.locked && plan.kind === "self"
      ? "Another admin can revoke your sign-in with Revoke sign-in on the Sign-in factors list."
      : plan.locked && plan.kind === "queued"
        ? OFFBOARD_QUEUED_POINTER
        : "To remove these, use Revoke sign-in on the Sign-in factors list further down this tab.";
  return `${survives} ${finish}`;
}

// openOffboardModal is the SINGLE member-removal ceremony (the roles-table Remove is the only
// entry point; the Sessions and fallback tab links here). It always offers the IdP-cleanup
// confirmation and, when ticked, records it as an audit intent, so the record never depends on
// which path the owner happened to use. It also offers to revoke the person's sign-in (ticked by default
// when the removal takes effect at once). The awaited calls run INSIDE the modal's busy onClick
// (the role-save pattern), so the busyLabel covers the network calls and a double fire is
// impossible (the modal disables its buttons for the duration).
function openOffboardModal(engine: EngineClient, email: string, ctx: OffboardContext, onRemoved: () => void): void {
  const idpConfirm = h("input", { type: "checkbox", id: "offboard-idp", style: "margin-top:3px;flex:none" }) as HTMLInputElement;
  const confirmBody = h("div", { style: "display:grid;gap:var(--space-3)" });
  // Removing an Owner is reachable here only while another Owner exists (the floor lock above refuses it
  // otherwise), and the engine queues that removal for a second Owner's approval whatever the Require
  // Approver setting. Removing any other member stays tied to that setting.
  const effectSentence = ctx.ownerRemovalQueues
    ? "This is audited. It waits for another Owner's approval. It does not end their Cloudflare Access session. The IdP step is yours."
    : "This is audited. It takes effect at once, unless approval for config changes is required; then it waits for a second approver. It does not end their Cloudflare Access session. The IdP step is yours.";
  confirmBody.appendChild(h("p", { style: "color:var(--text)" }, `Remove ${email} from the in-app role table? ${effectSentence} If you tick the confirmation below and the removal takes effect at once, the console asks the engine to record it in the audit trail. If the engine does not record it, you see a warning. A removal that waits for a second approver records no confirmation.`));

  // THE REVOKE OPTION. Removing a role row touches none of the three sign-in stores: the passkey credentials,
  // the banked recovery codes and any unexpired registration invite all survive it, and a passkey or a
  // recovery code still signs the person in. The engine keeps role delete and revoke as two routes because a
  // member can also hold a role through an IdP group, where the delete is only a demotion; the option below
  // therefore says plainly that it removes sign-in whatever a group grants, and the admin can untick it.
  //
  // The decision to offer it is made before any call (offboardRevokePlan). A removal that will queue never
  // revokes ahead of the approval, and the rows the engine refuses to revoke are locked with the reason.
  // When it runs, revoke goes FIRST: after the delete the target resolves as Viewer and the engine's Owner
  // floor no longer applies (the SCIM deprovision orders the two calls the same way).
  const plan = offboardRevokePlan(email, ctx);
  const revokeBox = h("input", { type: "checkbox", id: "offboard-revoke", style: "margin-top:3px;flex:none" }) as HTMLInputElement;
  revokeBox.checked = !plan.locked;
  if (plan.locked) revokeBox.disabled = true;
  const effectNote = h("p", { class: "field__hint measure" }, offboardEffectNote(revokeBox.checked, plan));
  // What the option deletes is said only while it is ticked; a locked or unticked option deletes nothing.
  const detailNote = h("p", { class: "field__hint measure" }, revokeBox.checked ? OFFBOARD_REVOKE_DETAIL : "");
  detailNote.hidden = !revokeBox.checked;
  revokeBox.addEventListener("change", () => {
    effectNote.replaceChildren(offboardEffectNote(revokeBox.checked, plan));
    detailNote.replaceChildren(revokeBox.checked ? OFFBOARD_REVOKE_DETAIL : "");
    detailNote.hidden = !revokeBox.checked;
  });
  const revokeRow = h("label", { for: "offboard-revoke", style: "display:flex;gap:var(--space-2);align-items:flex-start;font-size:var(--text-base)" });
  revokeRow.appendChild(revokeBox);
  revokeRow.appendChild(h("span", OFFBOARD_REVOKE_LABEL));
  confirmBody.appendChild(revokeRow);
  confirmBody.appendChild(detailNote);
  if (!plan.locked && ctx.groupMappings > 0) confirmBody.appendChild(h("p", { class: "field__hint measure" }, OFFBOARD_GROUP_HINT));
  if (plan.locked) confirmBody.appendChild(h("p", { class: "field__hint measure" }, plan.reason));
  confirmBody.appendChild(effectNote);
  confirmBody.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      "You may be asked to confirm with your own passkey before each step. If you dismiss the first prompt, or it fails, nothing changes. If a later step fails or is dismissed, the console says which steps ran.",
    ),
  );
  const idpRow = h("label", { for: "offboard-idp", style: "display:flex;gap:var(--space-2);align-items:flex-start;font-size:var(--text-base)" });
  idpRow.appendChild(idpConfirm);
  idpRow.appendChild(h("span", "I have removed this person in our IdP / Cloudflare Access. ", h("span", { class: "field__hint" }, "Removing the in-app role alone does not end their Access session.")));
  confirmBody.appendChild(idpRow);
  confirmBody.appendChild(h("a", { class: "field__doc linklike", href: "https://docs.downpipes.io/day-2/offboard-member#the-i-have-removed-this-person-confirmation", target: "_blank", rel: "noreferrer noopener", style: "justify-self:start" }, "About this confirmation", svgIcon(ICON_EXTERNAL, { size: 13 })));
  confirmBody.appendChild(
    h(
      "a",
      { class: "btn btn--secondary btn--sm", href: "https://one.dash.cloudflare.com", target: "_blank", rel: "noopener noreferrer", style: "justify-self:start" },
      "Open Cloudflare Access users",
      svgIcon(ICON_EXTERNAL, { size: 14 }),
    ),
  );

  openModal({
    title: "Remove member",
    body: confirmBody,
    actions: [
      { label: "Cancel", variant: "secondary", onClick: () => {} },
      {
        label: "Remove member",
        variant: "danger",
        busyLabel: "Removing",
        onClick: async () => {
          // Step one, only when the box is ticked and unlocked. A failure here deletes nothing. The approval
          // policy is read again just before the revoke: the table can be minutes old, and another Owner can
          // switch approval on in between. On or unreadable, the revoke is skipped and only the role removal
          // is sent, so a delete that queues never follows a revoke.
          let revoked: SignInFactorRevokeResult | null = null;
          let skipped: ApprovalPolicy | null = null;
          if (!plan.locked && revokeBox.checked) {
            let fresh: ApprovalPolicy;
            try {
              fresh = (await engine.getConfigApprovalPolicy()).requireConfigApproval ? "on" : "off";
            } catch (err) {
              if (isUnauthorised(err)) {
                goSignedOut();
                return true;
              }
              fresh = "unknown";
            }
            if (fresh !== "off") {
              skipped = fresh;
            } else {
              try {
                revoked = await engine.revokeSignInFactors(email);
              } catch (err) {
                if (isUnauthorised(err)) {
                  goSignedOut();
                  return true;
                }
                toast(offboardFailureToast("revoke", email, errorDetail(err)));
                return false;
              }
            }
          }
          try {
            const res = await engine.deleteRole(email);
            if (isPendingResult(res)) {
              // role-delete is change-control gated, so a 202 means the removal was QUEUED for a second
              // approver and the member KEEPS their grant. Reading that 202 as a success would toast "Removed"
              // and drop the row while the member's access persisted. Surface the queued state with the same
              // helper the queued custom-role delete uses (so the two cannot drift), leave the row in place,
              // and record no offboarding attestation for a change that has not taken effect. Usually no revoke
              // ran ahead of it: a locked option never revokes, and the policy was read again before the revoke,
              // so a skipped revoke is reported here. One window remains: approval can switch on AFTER that
              // re-read, so the revoke ran and the delete queued. Then the sign-in is already gone and the role
              // waits for a second approver, and the operator is told exactly that.
              surfacePendingChange("member removal");
              if (revoked !== null) toast({ message: `Revoked the sign-in of ${email}. The role removal waits for a second approver.`, tone: "warn" });
              else if (skipped !== null) toast({ message: skipped === "on" ? OFFBOARD_SKIPPED_ON : OFFBOARD_SKIPPED_UNKNOWN, tone: "warn" });
              return true;
            }
            // Record the operator's IdP confirmation as an intent marker if confirmed
            // (gated on roles.write from engine 0.3.7, as the removal is; the only audit write the console performs). It is a
            // SECOND, SEPARATELY FAILABLE write, so its outcome is CARRIED, never assumed: treating a
            // swallowed failure as success would still toast "IdP removal recorded", an
            // attestation the audit trail cannot support (the compliance reviewer later finds
            // no access-policy-change-intent entry and the console's claim is unprovable).
            let intentRecorded = true;
            if (idpConfirm.checked) {
              try {
                await engine.recordAuditIntent("access-policy-change-intent");
                // The APPLIED ending is recorded too, and it is the whole point of this row: a compliance
                // review asking whether the attestation was recorded for a departed employee needs an
                // engine-side audit entry, and that entry is the answer ONLY when the write landed. When it
                // does not land, the entry that would have proved it is exactly the one that does not exist,
                // so the pack is silent BY CONSTRUCTION and no amount of engine-side logging can fix that. The
                // console is the only witness to a write the engine never received, and this pair of rows is
                // the proof either way.
                recordAdminWrite("idp-cleanup-attest", "applied");
              } catch (attestErr) {
                // The removal itself succeeded and IS audited; only the attestation write failed.
                // Say so, rather than claiming a record that does not exist.
                intentRecorded = false;
                // The outcome is derived from the NUMERIC status alone (or from the transport rejection), so no
                // refusal prose, URL or body is read here. A refused attestation and one the engine never saw are
                // different remedies and are different rows.
                const st = errorStatus(attestErr);
                recordAdminWrite("idp-cleanup-attest", st === null ? "unreachable" : writeOutcomeForStatus(st));
              }
            }
            const removed = offboardToast(email, idpConfirm.checked, intentRecorded);
            const addendum = revoked !== null ? revokeSummary(email, revoked).message : skipped === "on" ? OFFBOARD_SKIPPED_ON_APPLIED : skipped === "unknown" ? OFFBOARD_SKIPPED_UNKNOWN : "";
            const tone = skipped !== null ? ("warn" as const) : removed.tone;
            toast(addendum === "" ? removed : { message: `${removed.message} ${addendum}`, ...(tone !== undefined ? { tone } : {}) });
            if (ctx.me && email === ctx.me) await refreshIdentity();
            onRemoved();
            return true;
          } catch (err) {
            if (isUnauthorised(err)) {
              goSignedOut();
              return true;
            }
            // The engine may refuse (last-Owner guard server-side): errorDetail carries its reason
            // through the shared classifyError pipeline, wrapped as customer copy rather than the raw
            // "<verb>: <reason>: <status>" throw.
            toast(offboardFailureToast(revoked === null ? "delete" : "delete-after-revoke", email, errorDetail(err)));
            return false;
          }
        },
      },
    ],
  });
}

// openRoleForm is the grant/change-role modal (roles.write: Owner or access-admin).
// It validates the email and role; the last-Owner guard, the owner-row lock and maker-side
// checks are enforced server-side, so a refusal is shown as the engine's inline reason,
// never a silent failure. Granting Owner is a posture change, so it carries an extra
// confirm (calibrated friction); lesser grants do not over-friction.
export function openRoleForm(
  engine: EngineClient,
  existing: RoleEntry | null,
  reload: () => void,
  opts: { floor?: { ownerCount: number; dualControlOn: boolean }; customRoles?: readonly CustomRole[] } = {},
): void {
  const form = buildRoleForm(existing, opts.customRoles ?? []);

  openModal({
    title: existing ? `Change role for ${existing.email}` : "Add or change a member",
    body: form.body,
    actions: [
      { label: "Cancel", variant: "secondary", onClick: () => {} },
      {
        label: "Save role",
        variant: "primary",
        busyLabel: "Saving",
        onClick: () => saveRoleForm(engine, existing, form, reload, opts.floor),
      },
    ],
  });
}

// The grant/change-role form fields plus the wrapping <form> body, split out of openRoleForm;
// the save handler reads these same field handles back.
interface RoleFormHandles {
  emailField: ReturnType<typeof field>;
  roleField: ReturnType<typeof field>;
  expiryField: ReturnType<typeof field>;
  formError: HTMLElement;
  body: HTMLElement;
  // The custom roles this form actually OFFERED, keyed by name, so the save path names the one it is
  // granting in the toast without re-reading the catalogue (and cannot name one the picker withheld).
  offeredCustomRoles: Map<string, CustomRole>;
}

function buildRoleForm(existing: RoleEntry | null, customRoles: readonly CustomRole[]): RoleFormHandles {
  const emailField = field({
    id: "role-email",
    label: "Member email",
    required: true,
    value: existing?.email ?? "",
    hint: "The person's verified email, lowercased. A later re-invite of a recycled address does not inherit the previous grant.",
    placeholder: "ops@acme.example",
    doc: { href: "https://docs.downpipes.io/identity-access/roles-and-capabilities", anchor: "authority-keys-on-a-stable-subject-not-the-email" },
    validate: (v) => (v.includes("@") && v.includes(".") && v.split("@").length === 2 && v.length >= 5 ? null : "Enter a valid email."),
  });
  if (existing) emailField.control.setAttribute("readonly", "");

  // THE PICKER OFFERS BOTH KINDS OF ROLE: a custom role composed in the builder is granted here, alongside
  // the six built-ins.
  //
  // A custom role is offered only when the CALLER holds every capability it confers: the engine's
  // requireGrantWithinAuthority refuses the rest with a 400, and this screen does not carry a control that
  // fails server-side (the footer of myPermissions in roles-matrix.ts says so). The withheld ones are named
  // below with the reason rather than vanishing, so an owner who cannot find their role learns why.
  //
  // The built-in roles pass the same subset check, and Owner also needs an Owner caller
  // (requireNotOwnerEscalation). So an Access admin is offered Viewer and Access admin only, not the four
  // roles the engine would refuse from them.
  const callerRole = caller()?.role ?? "viewer";
  const callerCaps = callerEffectiveCapabilities(callerRole, caller()?.customRole ?? null);
  const { grantable, withheld } = partitionGrantableCustomRoles(customRoles, callerCaps);
  const offeredCustomRoles = new Map(grantable.map((r) => [r.name, r]));
  const builtins = partitionGrantableBuiltinRoles(["viewer", "operator", "approver", "owner", "restore-operator", "access-admin"], callerRole, callerCaps);
  const offeredBuiltins = new Set(builtins.grantable);

  // The member's CURRENT custom role when the picker cannot re-offer it: either the catalogue read failed or
  // returned nothing, the role has been deleted (its holder is already at the viewer floor), or it confers
  // more than this caller holds. Selecting nothing would silently preselect Viewer and read as no change, so
  // the form says what saving would replace instead of quietly proposing a demotion.
  const heldCustomRole = existing?.customRole?.trim() ?? "";
  const heldCustomRoleUnofferable = heldCustomRole !== "" && !offeredCustomRoles.has(heldCustomRole);
  // The same case for a held BUILT-IN role: an Access admin who opens an Operator's row cannot re-grant
  // Operator, so the select cannot preselect it, and saving would replace it.
  const heldBuiltinUnofferable = existing !== null && heldCustomRole === "" && !offeredBuiltins.has(existing.role);

  // The six built-ins, less the ones this caller cannot grant (above). The descriptors use plain verbs, not
  // product nouns, since this is often first contact.
  const builtinOptions: Array<{ value: Role; label: string }> = [
    { value: "viewer", label: "Viewer (read everything; test a restore without writing)" },
    { value: "operator", label: "Operator (create and edit downpipes, run backups and test restores)" },
    { value: "approver", label: "Approver (apply a restore to live data; approve another's restore)" },
    { value: "owner", label: "Owner (everything, including keys, roles and governance)" },
    { value: "restore-operator", label: "Restore operator (recovery only: run drills, request, apply and approve restores)" },
    { value: "access-admin", label: "Access admin (manage roles and access policy only)" },
  ];
  const roleField = field({
    id: "role-role",
    label: "Role",
    kind: "select",
    value:
      heldCustomRole !== "" && !heldCustomRoleUnofferable
        ? customRoleChoiceValue(heldCustomRole)
        : existing !== null && !heldBuiltinUnofferable && heldCustomRole === ""
          ? existing.role
          : "viewer",
    hint:
      grantable.length > 0
        ? "Viewer to Owner are cumulative (each contains the previous). Restore operator and Access admin are narrow grants outside that ladder. A custom role is granted instead of a built-in one, and its own capability set decides what the holder can do. A Cloudflare Access or passkey member with no grant holds Viewer."
        : "Viewer to Owner are cumulative (each contains the previous). Restore operator and Access admin are narrow grants outside that ladder. A Cloudflare Access or passkey member with no grant holds Viewer.",
    doc: { href: "https://docs.downpipes.io/identity-access/roles-and-capabilities", anchor: "the-role-by-capability-matrix" },
    options: [
      ...builtinOptions.filter((o) => offeredBuiltins.has(o.value)),
      ...grantable.map((r) => ({ value: customRoleChoiceValue(r.name), label: customRoleOptionLabel(r) })),
    ],
  });
  const expiryField = field({
    id: "role-expiry",
    label: "Time-boxed expiry (optional)",
    type: "datetime-local",
    hint: "A just-in-time elevation. When it ends, the member drops to Viewer, unless an identity-provider group mapping grants them a role. Leave blank for no expiry.",
    doc: { href: "https://docs.downpipes.io/identity-access/roles-and-capabilities", anchor: "time-boxed-role-grants" },
  });

  const formError = h("p", { class: "field__error", role: "alert", hidden: true });
  // The invite-email note: the engine emails the granted person when an invite sender is configured
  // (an email binding plus a from address); the console never sends it and holds no mail credential.
  // Shown on a new grant (not a role change of an existing member), since an invite is what a fresh
  // grant produces. Stated as a conditional so it never over-claims that an email definitely went.
  const inviteNote = existing
    ? false
    : h(
        "p",
        { class: "field__hint measure", style: "display:flex;gap:var(--space-2);align-items:flex-start" },
        h("span", { style: "flex:none;margin-top:1px" }, svgIcon(ICON_INFO, { size: 14 })),
        h("span", "If invite email is configured on your engine, this person is emailed notice of the grant. The console does not send the email and holds no mail credential; until invites are configured, let them know out of band."),
      );
  // The withheld custom roles, named with the reason. Silence here would read as "the role you composed is
  // gone"; the engine's refusal is about the GRANTER's own authority, which is a fact only this form knows
  // and which an owner can act on (hold the capability yourself, or have someone who does make the grant).
  const withheldNote =
    withheld.length === 0
      ? false
      : h(
          "p",
          { class: "field__hint measure" },
          `Not offered: ${withheld.map((r) => r.name).join(", ")}. A custom role can only be granted by someone who holds every capability it confers, and this one confers at least one you do not. The engine refuses the grant either way; it is not offered here so the control cannot fail after you press Save.`,
        );

  // The withheld built-in roles, named with the same reason (see withheldBuiltinRolesNote).
  const withheldBuiltinNote = builtins.withheld.length === 0 ? false : h("p", { class: "field__hint measure" }, withheldBuiltinRolesNote(builtins.withheld));

  // The current custom role this picker cannot re-offer. Saying so is the difference between "no change
  // selected" and "you are about to replace a grant with a built-in role", which look identical in a select.
  // A held built-in role this caller cannot grant gets the same sentence, for the same reason.
  const heldNote = heldCustomRoleUnofferable
    ? h(
        "p",
        { class: "field__hint measure" },
        `${existing?.email ?? "This member"} currently holds the custom role ${heldCustomRole}, which is not in the list above (it may have been deleted, or it may confer more than you hold). Saving replaces that grant with the role you pick here.`,
      )
    : heldBuiltinUnofferable && existing !== null
      ? h(
          "p",
          { class: "field__hint measure" },
          `${existing.email} currently holds ${BUILTIN_ROLE_NAME[existing.role]}, which you cannot grant, so it is not in the list above. Saving replaces that role with the role you pick here.`,
        )
      : false;

  // THE CEREMONY, named before they agree to the thing it interrupts. A role grant is a step-up gated write
  // (adminOp role-set), so the engine opens a passkey prompt after Save and before it dispatches. The
  // sentence sits in the form itself rather than in a confirm, because every grant from this modal draws the
  // prompt, not only the Owner grant that carries the extra confirm below.
  const stepUpNote = h(
    "p",
    { class: "field__hint measure" },
    "You may be asked to confirm with your own passkey before this is saved. If you dismiss that prompt, or it fails, nothing is granted and you can start again from here.",
  );

  const body = h("form", { class: "form-stack", style: "display:grid;gap:var(--space-4)", "aria-label": existing ? `Change role for ${existing.email}` : "Invite a user", on: { submit: (ev: Event) => ev.preventDefault() } }, emailField.el, roleField.el, heldNote, withheldBuiltinNote, withheldNote, expiryField.el, stepUpNote, inviteNote, formError);

  return { emailField, roleField, expiryField, formError, body, offeredCustomRoles };
}

// The Save-role modal action: validate, gate the Owner grant behind the calibrated-friction
// confirm, write the grant, then surface the pending-approval / invite-link / refused outcomes.
// Split out of openRoleForm; returns true to close the modal, false to keep it open with input
// preserved.
async function saveRoleForm(engine: EngineClient, existing: RoleEntry | null, form: RoleFormHandles, reload: () => void, floor?: { ownerCount: number; dualControlOn: boolean }): Promise<boolean> {
  const { emailField, roleField, expiryField, formError, offeredCustomRoles } = form;
  formError.hidden = true;
  if (!validateForm([emailField, roleField])) return false;
  // The picker carries built-in roles and custom roles in one closed select, so the value is decoded rather
  // than cast. A value that decodes to neither is refused: the select cannot produce one, and treating an
  // unreadable choice as the viewer floor would turn a console fault into an unrequested demotion.
  const choice = decodeRoleChoice(roleField.value());
  if (choice === null) {
    formError.textContent = "Choose a role for this member.";
    formError.hidden = false;
    return false;
  }
  const email = emailField.value().toLowerCase();
  // A custom role is never owner (the create-time guardrail bars the owner-reserved capabilities and the
  // engine pins the stored built-in role to the viewer floor), so every owner-shaped check below reads it as
  // a non-owner role, which is exactly right: granting one to a current Owner IS a demotion.
  const grantingOwner = choice.kind === "builtin" && choice.role === "owner";

  // Rule b mirror: a demotion of an existing Owner to a non-owner role that would strand the estate below its
  // floor (one Owner by default, two while dual control is armed) is refused server-side; pre-empt it inline
  // so the operator sees WHY here, not a round-trip 400. Only a genuine floor-breaching demotion is stopped;
  // promoting to Owner or editing an Owner's expiry is unaffected. The engine re-checks regardless.
  if (existing?.role === "owner" && !grantingOwner && floor && removingOwnerWouldStrand(floor.ownerCount, floor.dualControlOn)) {
    formError.textContent = floor.ownerCount <= 1 ? ONLY_OWNER_REASON : DUAL_CONTROL_FLOOR_REMOVE_REASON;
    formError.hidden = false;
    return false;
  }

  // Calibrated friction: granting Owner is a posture change, so confirm it; a
  // lesser grant saves directly (design-system 6.16, do not cry wolf).
  if (grantingOwner && existing?.role !== "owner") {
    const ok = await confirmModal({
      title: "Grant Owner",
      body: `Owner can manage roles, run the key ceremony and configure the access policy. Grant Owner to ${email}? You may be asked to confirm with your own passkey. If you dismiss that prompt, or it fails, nothing is granted and you can start again from here.`,
      confirmLabel: "Grant Owner",
      variant: "primary",
    });
    if (!ok) return false;
  }

  const expiresAt = expiryField.value() ? new Date(expiryField.value()).toISOString() : undefined;
  try {
    // Two routes, one upsert: assignCustomRole and setRole are the same POST /admin/roles, differing only in
    // whether the body names a custom role or a built-in one. The engine rejects a custom-role name it does
    // not hold, so a role deleted between the catalogue read and Save is refused rather than half-applied.
    const res = choice.kind === "custom" ? await engine.assignCustomRole(email, choice.name, expiresAt) : await engine.setRole(email, choice.role, expiresAt);
    // The toast names what was granted: the built-in role's title, or the custom role's own label and stored
    // name (the name is what the row badge and the audit entry will carry, so it is the one to show).
    const granted = choice.kind === "custom" ? `${offeredCustomRoles.get(choice.name)?.label ?? choice.name} (${choice.name})` : titleCase(choice.role);
    // The change-control gate may have queued this role change for a second approver (202 ->
    // pending): say so, NOT a false "role updated", and skip the self-refresh (the caller's own
    // role has NOT changed yet). The toast otherwise notes the invite email on a fresh grant (the
    // engine sends it when an invite sender is configured; the console never sends it).
    if (res.status === "pending") {
      surfacePendingChange("role change");
    } else {
      await presentRoleGrantResult(res.value, email, granted, existing);
    }
    reload();
    return true;
  } catch (err) {
    if (isUnauthorised(err)) {
      goSignedOut();
      return true;
    }
    // The engine refused (last-Owner guard, malformed input, not Owner): show
    // its reason inline; input is preserved.
    formError.textContent = `The engine refused the change. ${errorDetail(err)}`;
    formError.hidden = false;
    return false;
  }
}

// The success branch of a committed (non-pending) grant: hand the Owner the single-use invite
// link when the engine returns one, otherwise the conditional-email toast, then self-refresh if
// the grant touched the caller's own role. Split out of openRoleForm.
// granted is the DISPLAY name of what was granted (a built-in role's title, or a custom role's label and
// stored name), already resolved by the caller. It is a string rather than a Role because the grant
// route carries both kinds, and titleCase over a custom-role name would print a built-in-looking word
// for a grant that is not one.
async function presentRoleGrantResult(value: RoleEntry, email: string, granted: string, existing: RoleEntry | null): Promise<void> {
  // A fresh grant may return a single-use, email-bound invite token. The engine
  // emails it when an invite sender is configured; either way the Owner gets the
  // copyable set-up link here so they can hand it over directly (shown once, never
  // stored), matching the onboarding grant flow. The token is read defensively so an
  // engine that does not return it simply falls back to the conditional-email toast.
  const token = inviteTokenOf(value);
  // A grant that commits with NO set-up link is recorded here: an engine that mints invites SAYS which
  // state it is in (inviteState), so the only silence is an engine that predates the mint. An
  // already-enrolled member records NOTHING: no link is the correct outcome for them, and a row would be a
  // fault reported on a healthy path.
  //
  // The engine half of this rides in the pack beside it (status.inviteSenderConfigured and the
  // role-grant-invite-undeliverable counter), which is what tells a deliberate no-invite deployment apart from
  // a misconfigured sender. Neither half carries the token, the recipient or the sender address.
  if (token === null && inviteStateOf(value) === null) recordContractSkew("missing-field", "invite-state");
  const inviteLink = token ? `${location.origin}/#/register?invite=${token}` : null;
  // A re-enrolment grant (the member held a role or a passkey before) never reaches the Owner with a
  // token: the engine mints the fresh set-up link but sends it only to the member's own address, so a
  // roles.write holder cannot enrol a key in that member's name. inviteNotice is the engine's own
  // sentence for this case; "withheld" means the send failed, which is why it is not a success toast.
  const notice = inviteNoticeOf(value);
  if (inviteLink) {
    openModal({
      title: `${email} added as ${granted}`,
      body: h(
        "div",
        { class: "stack-sm" },
        h("p", "Send them this set-up link. It works once, sets up their passkey, and is bound to their email. The engine also emails it if invites are configured."),
        codeBlock(inviteLink, { copyLabel: "Copy the set-up link" }),
      ),
    });
  } else if (notice) {
    toast({ message: notice, tone: inviteStateOf(value) === "withheld" ? "warn" : "info" });
  } else {
    toast({ message: existing ? `Role updated for ${email}` : `Added ${email} as ${granted}. They are emailed if invites are configured on your engine.` });
  }
  const myEmail = caller()?.email;
  if (myEmail && email === myEmail) await refreshIdentity();
}
