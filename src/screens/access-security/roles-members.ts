// The in-app members and roles table (D3 grant/revoke), its row actions, the single
// member-removal ceremony, and the grant/change-role modal. The table mirrors the engine;
// the engine is the boundary. Extracted from roles.ts (console-src-025-02, console-src-025-M1)
// with no change to any logic. openRoleForm is split into buildRoleForm (the fields and
// body), saveRoleForm (the Save action) and presentRoleGrantResult (the committed-grant
// outcome) for console-src-025-M1, again with no behaviour change.

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
import type { EngineClient, RoleEntry, Role, CustomRole } from "../../api.ts";
import { inviteStateOf, inviteTokenOf } from "../../api.ts";
import { roleOrCustomRoleBadge } from "./shared.ts";
import { errorDetail } from "../../components/error-view.ts";
import { customRoleChoiceValue, customRoleOptionLabel, decodeRoleChoice, expiryBadge, partitionGrantableCustomRoles } from "./roles-helpers.ts";
import { callerEffectiveCapabilities, roleRank } from "../../lib/identity.ts";
import { removingOwnerWouldStrand, DUAL_CONTROL_FLOOR_REMOVE_REASON } from "../../lib/owner-floor.ts";

// Count only non-expired owners, mirroring the engine's effectiveRole()-based count (C4-2):
// a time-boxed Owner grant that has lapsed must not count (it would diverge from the
// server-side last-Owner guard). Exported as a pure predicate so it can be unit tested.
export function activeOwnerCount(rows: RoleEntry[], now: number = Date.now()): number {
  return rows.filter((r) => r.role === "owner" && (!r.expiresAt || Date.parse(r.expiresAt) > now)).length;
}

export function renderRolesTable(engine: EngineClient, rows: RoleEntry[], reload: () => void, opts: { dualControlOn?: boolean; customRoles?: readonly CustomRole[] } = {}): HTMLElement {
  const wrap = h("div", { class: "stack", style: "display:grid;gap:var(--space-3)" });
  // The custom-role catalogue is read best-effort beside this table (roles.ts). It feeds two things: the
  // badge, which needs only the names to tell a live custom-role grant from one naming a deleted role, and
  // the grant picker, which needs the whole record (label, capability set) to offer the role and to say what
  // it confers. An empty list is "not known", never "nothing exists".
  const customRoles = opts.customRoles ?? [];
  const knownCustomRoles = customRoles.map((r) => r.name);
  // ML-37: gate on the roles.write CAPABILITY, not the canDo("owner") cumulative rank -- the engine's
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
        body: "The first authenticated Access caller is the bootstrap Owner. Grant roles to teammates by their verified email; new members default to Viewer.",
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
        render: (r) => rowActions(engine, r, { canManageRoles, me, ownerCount, dualControlOn, customRoles }, reload),
      },
    ],
  });
  wrap.appendChild(handle.el);

  wrap.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "New members default to Viewer (least privilege). The system always retains at least one Owner, and at least two while dual approval is on so a second Owner can always approve; removing or demoting an Owner below that floor is refused server-side, and the console mirrors the block. Server-side enforcement is the engine's; this table mirrors the gate.",
    ),
  );
  return wrap;
}

// The last-Owner guard reason (F3), shared by the disabled state's title AND a visible hint
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

// ML-37 follow-up: the engine's requireNotOwnerEscalation hard-blocks any non-Owner caller --
// including access-admin, who otherwise holds roles.write -- from changing or removing an OWNER
// row. Disabling here (rather than offering a control that 400s on click) mirrors this file's own
// isOnlyOwner precedent and the "never a live control that fails server-side" rule (roles-matrix.ts:120).
const OWNER_ROW_REASON = "Only an Owner may change or remove another Owner.";

function rowActions(
  engine: EngineClient,
  entry: RoleEntry,
  ctx: { canManageRoles: boolean; me: string | null; ownerCount: number; dualControlOn: boolean; customRoles: readonly CustomRole[] },
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
  // The Owner floor lock (F3 raised to two under dual control, rule b): removing or demoting this Owner would
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

  // The Owner-floor guard mirror (F3 + rule b): pre-empt a removal that would strand the estate with the
  // engine's own reason; the engine also refuses it server-side. Removal routes through the SINGLE offboarding
  // ceremony (IdP checkbox + recorded intent), so which entry point the owner used never changes what is recorded.
  const removeBtn = h("button", { "data-dp": "access-security.button.remove#2", class: "btn btn--ghost btn--sm", type: "button" }, "Remove");
  if (floorLock) {
    refuseWithReason(removeBtn, floorLock.reason);
  } else if (ownerRowLocked) {
    refuseWithReason(removeBtn, OWNER_ROW_REASON);
  } else {
    removeBtn.addEventListener("click", () => openOffboardModal(engine, entry.email, ctx.me, reload));
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

// openOffboardModal is the SINGLE member-removal ceremony (the roles-table Remove is the only
// entry point; the Sessions and fallback tab links here). It always offers the IdP-cleanup
// confirmation and, when ticked, records it as an audit intent, so the record never depends on
// which path the owner happened to use. The awaited delete runs INSIDE the modal's busy onClick
// (the role-save pattern), so the busyLabel covers the network call and a double fire is
// impossible (the modal disables its buttons for the duration).
function openOffboardModal(engine: EngineClient, email: string, me: string | null, onRemoved: () => void): void {
  const idpConfirm = h("input", { type: "checkbox", id: "offboard-idp", style: "margin-top:3px;flex:none" }) as HTMLInputElement;
  const confirmBody = h("div", { style: "display:grid;gap:var(--space-3)" });
  confirmBody.appendChild(h("p", { style: "color:var(--text)" }, `Remove ${email} from the in-app role table? This is immediate and audited, but it does not end their Cloudflare Access session; the IdP step is yours, and the console records that you did it.`));
  // THE THIRD FACT, and it was missing. This ceremony used to name only the Access session, which reads as
  // "the role plus the identity provider closes the door". It does not. Removing a role row touches none of
  // the three sign-in stores: their passkey credentials, their banked recovery codes and any unexpired
  // registration invite all survive it, and each of the last two leads straight back to enrolling a fresh
  // credential. In practice, a majority of identities on an estate can sign in with no role row at all.
  //
  // This states the fact and points at the control; it deliberately does NOT revoke as part of the removal.
  // Removing a role can be a legitimate demotion for somebody who keeps authority through an identity-provider
  // group, and revoking destroys an authenticator and recovery codes irreversibly. The operator decides which
  // one they are doing, which is the same reason the engine refused to fold the two routes together.
  confirmBody.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      "Removing the role does not remove their passkey, their recovery codes or any unexpired invite; each of those is still a way in, and recovery codes on their own are enough to enrol a fresh passkey. To close those too, use Revoke sign-in on the Sign-in factors list further down this tab. It is a separate, irreversible action, so it is not done for you here.",
    ),
  );
  confirmBody.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      "You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is removed and you can start again from this row.",
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
          try {
            const res = await engine.deleteRole(email);
            if (isPendingResult(res)) {
              // B8c: role-delete is change-control gated, so a 202 means the removal was QUEUED for a second
              // approver and the member KEEPS their grant. The pre-fix read coerced that 202 into a success,
              // so the screen toasted "Removed" and dropped the row while the member's access persisted. Surface
              // the queued state with the same helper the queued custom-role delete uses (so the two cannot
              // drift), leave the row in place, and record no offboarding attestation for a change that has not
              // taken effect.
              surfacePendingChange("member removal");
              return true;
            }
            // Record the operator's IdP confirmation as an intent marker if confirmed
            // (Owner-gated audit write; the only audit write the console performs). It is a
            // SECOND, SEPARATELY FAILABLE write, so its outcome is CARRIED, never assumed: a
            // swallowed failure used to still toast "IdP removal recorded", which is an
            // attestation the audit trail cannot support (the compliance reviewer later finds
            // no access-policy-change-intent entry and the console's claim is unprovable).
            let intentRecorded = true;
            if (idpConfirm.checked) {
              try {
                await engine.recordAuditIntent("access-policy-change-intent");
                // The APPLIED ending is recorded too, and it is the whole point of this row. The scenario is a
                // compliance review asking whether the attestation was recorded for a departed employee, and an
                // engine-side audit entry is the answer ONLY when the write landed. When it did not, the entry that
                // would have proved it is exactly the one that does not exist, so the pack is silent BY
                // CONSTRUCTION and no amount of engine-side logging can fix that. The console is the only witness
                // to a write the engine never received, and this pair of rows is the proof either way.
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
            toast(offboardToast(email, idpConfirm.checked, intentRecorded));
            if (me && email === me) await refreshIdentity();
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
            toast({ message: `Could not remove the member. ${errorDetail(err)}`, tone: "warn" });
            return false;
          }
        },
      },
    ],
  });
}

// openRoleForm is the grant/change-role modal (roles.write: Owner or access-admin; ML-37).
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

// The grant/change-role form fields plus the wrapping <form> body. Split out of openRoleForm
// (console-src-025-M1) with no change to any field option or copy; the save handler reads these
// same field handles back.
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
    hint: "The person's verified email, lowercased (however they sign in: Cloudflare Access, a native identity provider, a passkey, or the shared-token fallback). The grant binds to their stable sign-in subject, not the address string, so a later re-invite of a recycled address does not inherit it.",
    placeholder: "ops@acme.example",
    doc: { href: "https://docs.downpipes.io/identity-access/roles-and-capabilities", anchor: "authority-keys-on-a-stable-subject-not-the-email" },
    validate: (v) => (v.includes("@") && v.includes(".") && v.split("@").length === 2 && v.length >= 5 ? null : "Enter a valid email."),
  });
  if (existing) emailField.control.setAttribute("readonly", "");

  // THE PICKER OFFERS BOTH KINDS OF ROLE, and until this was wired it offered only the first. A customer
  // could compose a custom role in the builder and then had no way at all to give it to anybody: the engine
  // has always accepted a custom-role grant, the client layer has always had assignCustomRole, and the whole
  // read side (the badge, the authority resolver, the matrix) was built to display one, but no console
  // control could ever create one. The builder's own empty state promised the opposite, saying a custom role
  // is reached by an explicit grant or a group mapping that names it.
  //
  // A custom role is offered only when the CALLER holds every capability it confers: the engine's
  // requireGrantWithinAuthority refuses the rest with a 400, and this screen does not carry a control that
  // fails server-side (roles-matrix.ts:120). The withheld ones are named below with the reason rather than
  // vanishing, so an owner who cannot find their role learns why.
  const callerCaps = callerEffectiveCapabilities(caller()?.role ?? "viewer", caller()?.customRole ?? null);
  const { grantable, withheld } = partitionGrantableCustomRoles(customRoles, callerCaps);
  const offeredCustomRoles = new Map(grantable.map((r) => [r.name, r]));

  // The member's CURRENT custom role when the picker cannot re-offer it: either the catalogue read failed or
  // returned nothing, the role has been deleted (its holder is already at the viewer floor), or it confers
  // more than this caller holds. Selecting nothing would silently preselect Viewer and read as no change, so
  // the form says what saving would replace instead of quietly proposing a demotion.
  const heldCustomRole = existing?.customRole?.trim() ?? "";
  const heldCustomRoleUnofferable = heldCustomRole !== "" && !offeredCustomRoles.has(heldCustomRole);

  // All six built-ins are grantable here (the builder and the custom-roles card advertise six);
  // the descriptors use plain verbs, not product nouns, since this is often first contact.
  const roleField = field({
    id: "role-role",
    label: "Role",
    kind: "select",
    value: heldCustomRole !== "" && !heldCustomRoleUnofferable ? customRoleChoiceValue(heldCustomRole) : existing?.role ?? "viewer",
    hint:
      grantable.length > 0
        ? "Viewer to Owner are cumulative (each contains the previous). Restore operator and Access admin are narrow grants outside that ladder. A custom role is granted instead of a built-in one, and its own capability set decides what the holder can do. New members default to Viewer."
        : "Viewer to Owner are cumulative (each contains the previous). Restore operator and Access admin are narrow grants outside that ladder. New members default to Viewer.",
    doc: { href: "https://docs.downpipes.io/identity-access/roles-and-capabilities", anchor: "the-role-by-capability-matrix" },
    options: [
      { value: "viewer", label: "Viewer (read everything; test a restore without writing)" },
      { value: "operator", label: "Operator (create and edit downpipes, run backups and test restores)" },
      { value: "approver", label: "Approver (apply a restore to live data; approve another's restore)" },
      { value: "owner", label: "Owner (everything, including keys, roles and governance)" },
      { value: "restore-operator", label: "Restore operator (recovery only: run drills, request, apply and approve restores)" },
      { value: "access-admin", label: "Access admin (manage roles and access policy only)" },
      ...grantable.map((r) => ({ value: customRoleChoiceValue(r.name), label: customRoleOptionLabel(r) })),
    ],
  });
  const expiryField = field({
    id: "role-expiry",
    label: "Time-boxed expiry (optional)",
    type: "datetime-local",
    hint: "A just-in-time elevation that self-revokes at the chosen local date and time; the member then reverts to their standing role (Viewer unless a lower grant remains). Leave blank for no expiry.",
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
        h("span", "If invite email is configured on your engine, this person is emailed a notification that they have been granted access. The console does not send the email and holds no mail credential; until invites are configured, let them know out of band."),
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

  // The current custom role this picker cannot re-offer. Saying so is the difference between "no change
  // selected" and "you are about to replace a grant with a built-in role", which look identical in a select.
  const heldNote = !heldCustomRoleUnofferable
    ? false
    : h(
        "p",
        { class: "field__hint measure" },
        `${existing?.email ?? "This member"} currently holds the custom role ${heldCustomRole}, which is not in the list above (it may have been deleted, or it may confer more than you hold). Saving replaces that grant with the role you pick here.`,
      );

  // THE CEREMONY, named before they agree to the thing it interrupts. A role grant is a step-up gated write
  // (adminOp role-set), so the engine opens a passkey prompt after Save and before it dispatches. The
  // sentence sits in the form itself rather than in a confirm, because every grant from this modal draws the
  // prompt, not only the Owner grant that carries the extra confirm below.
  const stepUpNote = h(
    "p",
    { class: "field__hint measure" },
    "You may be asked to confirm with your own passkey before this is saved. If you dismiss that prompt, or it fails, nothing is granted and you can start again from here.",
  );

  const body = h("form", { class: "form-stack", style: "display:grid;gap:var(--space-4)", "aria-label": existing ? `Change role for ${existing.email}` : "Invite a user", on: { submit: (ev: Event) => ev.preventDefault() } }, emailField.el, roleField.el, heldNote, withheldNote, expiryField.el, stepUpNote, inviteNote, formError);

  return { emailField, roleField, expiryField, formError, body, offeredCustomRoles };
}

// The Save-role modal action: validate, gate the Owner grant behind the calibrated-friction
// confirm, write the grant, then surface the pending-approval / invite-link / refused outcomes.
// Split out of openRoleForm (console-src-025-M1); the control flow and return values are
// unchanged (true closes the modal, false keeps it open with input preserved).
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
      body: `Owner can manage roles, run the key ceremony and configure the access policy. Grant Owner to ${email}? You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is granted and you can start again.`,
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
// the grant touched the caller's own role. Split out of openRoleForm (console-src-025-M1) with no
// change to the token read, copy or refresh logic.
// granted is the DISPLAY name of what was granted (a built-in role's title, or a custom role's label and
// stored name), already resolved by the caller. It is a string rather than a Role because the same grant
// route now carries both kinds, and titleCase over a custom-role name would print a built-in-looking word
// for a grant that is not one.
async function presentRoleGrantResult(value: RoleEntry, email: string, granted: string, existing: RoleEntry | null): Promise<void> {
  // A fresh grant may return a single-use, email-bound invite token. The engine
  // emails it when an invite sender is configured; either way the Owner gets the
  // copyable set-up link here so they can hand it over directly (shown once, never
  // stored), matching the onboarding grant flow. The token is read defensively so an
  // engine that does not return it simply falls back to the conditional-email toast.
  const token = inviteTokenOf(value);
  // A grant that committed with NO set-up link. "The new member never received a set-up link and the
  // owner never saw one to copy" was unanswerable because this fall-through covered two states at once. It no
  // longer does: an engine that mints invites SAYS which state it is in (inviteState), so the only silence left
  // is an engine that predates the mint, and THAT is what is recorded here. An already-enrolled member records
  // NOTHING: no link is the correct outcome for them, and a row would be a fault reported on a healthy path.
  //
  // The engine half of this ticket rides in the pack beside it (status.inviteSenderConfigured and the
  // role-grant-invite-undeliverable counter), which is what tells a deliberate no-invite deployment apart from
  // a misconfigured sender. Neither half carries the token, the recipient or the sender address.
  if (token === null && inviteStateOf(value) === null) recordContractSkew("missing-field", "invite-state");
  const inviteLink = token ? `${location.origin}/#/register?invite=${token}` : null;
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
  } else {
    toast({ message: existing ? `Role updated for ${email}` : `Added ${email} as ${granted}. They are emailed if invites are configured on your engine.` });
  }
  const myEmail = caller()?.email;
  if (myEmail && email === myEmail) await refreshIdentity();
}
