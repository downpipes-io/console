// The optional identity-provider group-to-role mapping panel and its table, add-row form
// and row actions. Clearly framed as irrelevant unless a sign-in carries group claims;
// downpipes works fully without it. access.policy-gated writes (Owner or access-admin;
// ML-37). Extracted from roles.ts (console-src-025-02, console-src-025-M1) with no change
// to any logic beyond the ML-37 capability-gate fix.

import { featureOutcomeForError, recordFeatureProbe } from "../../lib/client-diag/ring.ts";
import type { ClientDiagFeatureClass } from "../../lib/client-diag/vocab.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { canCap, capGateReason, pendingEngineNote } from "../common.ts";
import { navigate, goSignedOut, caller } from "../../lib/nav.ts";
import { isUnauthorised, classifyError } from "../../lib/errors.ts";
import { blockError, sessionEnded, stepUpAwareText } from "../../components/error-view.ts";
import { dataTable } from "../../components/data-table.ts";
import { field, validateForm } from "../../components/field.ts";
import { openModal } from "../../components/modal.ts";
import { toast } from "../../components/toast.ts";
import { surfacePendingChange } from "../../lib/pending-change-toast.ts";
import { isPendingResult, type MutationResult } from "../../lib/api/types/config-changes.ts";
import { skeletonRows, emptyState } from "../../components/feedback.ts";
import { relativeTime, absoluteTime, titleCase } from "../../lib/format.ts";
import { ICON_INFO, ICON_PLUS } from "../../lib/icons.ts";
import type { EngineClient, GroupRoleEntry, CustomRole } from "../../api.ts";
import { roleOrCustomRoleBadge, noteLine } from "./shared.ts";
import { callerEffectiveCapabilities, roleRank } from "../../lib/identity.ts";
import { customRoleChoiceValue, customRoleOptionLabel, decodeRoleChoice, partitionGrantableCustomRoles } from "./roles-helpers.ts";

// groupRoleMappingPanel is the OPTIONAL identity-provider group-to-role mapping
// surface. It is clearly framed as irrelevant unless a sign-in carries group claims
// (Cloudflare Access, OR a native identity provider wired under Identity providers,
// OR SAML). Downpipes works fully without it on the passkey or shared-token path; no
// Zero Trust seats, no IdP licences are required. access.policy-gated writes (Owner or
// access-admin, matching the engine's gate on POST/DELETE /admin/group-roles); everyone
// else sees the table read-only.
export function groupRoleMappingPanel(engine: EngineClient): HTMLElement {
  // ML-37: gate on the access.policy CAPABILITY, not canDo("owner") -- the engine's real gate for
  // POST/DELETE /admin/group-roles is access.policy, which access-admin also holds (canDo("owner")
  // maps access-admin to rank 0, wrongly denying it this whole panel).
  const canManage = canCap("access.policy");
  // The wrapping disclosure's summary carries the "Group to role mapping (optional)" heading.
  const card = h("section", { class: "card" });
  card.appendChild(
    h("p", { class: "card__desc" },
      "Optional. This panel is only relevant if your sign-in carries group claims, through Cloudflare Access, a native identity provider, or SAML. Downpipes works fully without it on the passkey or shared-token path, with no Cloudflare Zero Trust seats or identity-provider licences required. Group-to-role mapping applies the same way however the person signed in; it takes effect once a sign-in sends groups.",
    ),
  );
  // The pointer to the native-IdP management surface (where OIDC / OAuth2 / SAML connections live), so an
  // owner who wants group claims from their own IdP knows where to wire it.
  card.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-2)" },
      "To sign in with your own identity provider (and receive its group claims), wire it under ",
      h("button", { "data-dp": "access-security.button.navigate-access-idp", class: "linklike", type: "button", on: { click: () => navigate("/access/idp") } }, "Identity providers"),
      ".",
    ),
  );

  // The owner note: owners are deliberately excluded from group mapping so a whole
  // group can never become break-glass holders. This also keeps the last-Owner guard
  // intact (a group mapping cannot silently satisfy the one-Owner minimum).
  card.appendChild(
    noteLine(
      ICON_INFO,
      "Groups can be mapped to any role except Owner (Viewer, Operator, Approver, Restore operator or Access admin), or to any custom role you have composed. Owner is deliberately excluded: a whole group cannot become break-glass holders, and this keeps the last-Owner guard intact. Owner stays an explicit per-person grant. A custom role can never be Owner, so mapping one is never a way around that.",
    ),
  );

  if (!canManage) {
    card.appendChild(
      h(
        "div",
        { class: "card card--inset measure", style: "margin-top:var(--space-3)" },
        h("p", { style: "color:var(--text)" }, "Group-to-role mapping requires the Owner or Access-admin role for writes. You can see the current mapping below."),
        h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, capGateReason("access.policy")),
      ),
    );
  }

  const region = h("div", { class: "async-region", style: "margin-top:var(--space-4)" });
  card.appendChild(region);

  const load = (): void => {
    region.replaceChildren(skeletonRows(3));
    void Promise.all([
      engine.listGroupRoles(),
      // The custom-role catalogue, read BEST-EFFORT: a failed read degrades to "not known" (no claim either
      // way) rather than taking the mappings table down with it. The WHOLE record is kept, not just the name:
      // the badge needs only the names, to tell a live custom-role mapping from one naming a deleted role,
      // but the add-row picker needs the label and the capability set to offer the role and say what it grants.
      engine.listCustomRoles().catch((): CustomRole[] => []),
    ])
      .then(([rows, customRoles]) => region.replaceChildren(renderGroupRolesTable(engine, rows, canManage, load, customRoles)))
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the mappings table is a skeleton until this replaces it.
          region.replaceChildren(sessionEnded(load));
          return goSignedOut();
        }
        // The group-role mappings are how an IdP group grants a role, so a table that never loads is a
        // customer who cannot see (or fix) who their SSO is granting access to. Broken and unbuilt are, again,
        // one tile today.
        recordFeature("group-roles", err);
        renderGroupRoleLoadError(region, err, load);
      });
  };
  load();

  return card;
}

// renderGroupRoleLoadError degrades the group-roles region honestly: a 404/501 means the engine build
// does not yet support the group-roles route (a pending-engine note, not an error), while any other
// failure (a 500, a network throw) is the engine live and broken, which reads as the honest block error
// with Retry rather than a second pending-engine note that framed a real fault as unbuilt.
function renderGroupRoleLoadError(region: HTMLElement, err: unknown, reload: () => void): void {
  const kind = classifyError(err);
  const notWired = kind.kind === "server" && (kind.status === 404 || kind.status === 501);
  if (notWired) {
    region.replaceChildren(
      pendingEngineNote({
        what: "Group-to-role mapping is not yet active on this engine build. The table will appear once the engine supports the group-roles route.",
        dependsOn: "engine support for GET/PUT/DELETE /admin/group-roles",
        interim: "Group mapping applies when a sign-in carries groups (Cloudflare Access, or a native identity provider that sends groups).",
      }),
    );
    return;
  }
  region.replaceChildren(blockError(err, reload, { origin: location.origin }));
}

function renderGroupRolesTable(
  engine: EngineClient,
  rows: GroupRoleEntry[],
  canManage: boolean,
  reload: () => void,
  customRoles: readonly CustomRole[] = [],
): HTMLElement {
  const wrap = h("div", { class: "stack", style: "display:grid;gap:var(--space-3)" });
  const knownCustomRoles = customRoles.map((r) => r.name);

  // The add-row form (roles.write/access.policy holders only), shown at the top so the
  // operator can immediately add a mapping without scrolling past an empty table.
  if (canManage) {
    wrap.appendChild(groupRoleAddRow(engine, reload, customRoles));
  }

  if (rows.length === 0) {
    wrap.appendChild(
      emptyState({
        title: "No group mappings",
        body: "No identity-provider groups are mapped to a role yet. Add a mapping below; it takes effect once a sign-in carries groups (Cloudflare Access, or a native identity provider that sends groups).",
      }),
    );
    return wrap;
  }

  // The mapping table: group name, role, granted by, granted when, remove action.
  const handle = dataTable<GroupRoleEntry>({
    label: "Group role mappings",
    rows,
    rowKey: (r) => r.group,
    filter: { placeholder: "Filter by group name", resultLabel: "mappings", getText: (r) => `${r.group} ${r.role}` },
    initialSort: { key: "group", dir: "asc" },
    columns: [
      {
        key: "group",
        header: "Group",
        sortable: true,
        sortValue: (r) => r.group,
        // Groups are customer directory data: escape via text node (the dataTable
        // render callback returns an element; h() text-node path handles escaping).
        render: (r) => h("span", { class: "mono" }, r.group),
      },
      { key: "role", header: "Role", sortable: true, sortValue: (r) => roleRank(r.role), render: (r) => roleOrCustomRoleBadge(r, knownCustomRoles) },
      { key: "by", header: "Granted by", render: (r) => h("span", { class: "mono" }, r.grantedBy) },
      { key: "at", header: "Granted", sortable: true, sortValue: (r) => r.grantedAt, render: (r) => h("span", { title: absoluteTime(r.grantedAt) }, relativeTime(r.grantedAt)) },
      {
        key: "actions",
        header: "Actions",
        srOnlyHeader: true,
        width: "1px",
        render: (r) => groupRoleRowActions(engine, r, canManage, reload),
      },
    ],
  });
  wrap.appendChild(handle.el);

  return wrap;
}

// groupRoleAddRow is the inline add-a-mapping form (access.policy: Owner or access-admin).
// Group name + role picker limited to viewer/operator/approver (no owner). Two-channel
// feedback: toast on success; inline block error on transport failure; input is never lost.
function groupRoleAddRow(engine: EngineClient, reload: () => void, customRoles: readonly CustomRole[] = []): HTMLElement {
  const wrap = h("div", { class: "card card--inset", style: "display:grid;gap:var(--space-3)" });
  wrap.appendChild(h("h4", { style: "font-size:var(--text-base);margin:0" }, "Add a group mapping"));

  const groupField = field({
    id: "group-role-group",
    label: "Group name",
    required: true,
    placeholder: "platform-engineering",
    hint: "The group name exactly as your identity provider sends it (in the Access token, or in a native OIDC/SAML sign-in). One name, up to 256 characters.",
    doc: { href: "https://docs.downpipes.io/identity-access/group-to-role-mapping" },
    autocomplete: "off",
    // Mirror the engine's normaliseGroup bounds (1..256, no ASCII control characters) so an over-long
    // or control-char-bearing group name is refused inline rather than drawing a late engine 400.
    validate: (v) => (v.length < 1 ? "Group name is required." : v.length > 256 ? "Use at most 256 characters." : [...v].some((c) => { const n = c.charCodeAt(0); return n < 0x20 || n === 0x7f; }) ? "The group name cannot contain control characters." : null),
  });

  // The mapping picker offers custom roles alongside the built-ins, which is the group-keyed half of the
  // grant that could not be made from the console at all until it was wired: the engine's setGroupRole has
  // always taken a customRole, assignGroupCustomRole has always existed in the client layer, and the mapping
  // table has always rendered the custom-role badge. A custom role is offered only when the caller holds
  // every capability it confers, mirroring requireGrantWithinAuthority, which the engine applies to a group
  // mapping exactly as it does to a per-person grant.
  const callerCaps = callerEffectiveCapabilities(caller()?.role ?? "viewer", caller()?.customRole ?? null);
  const { grantable, withheld } = partitionGrantableCustomRoles(customRoles, callerCaps);
  const offeredCustomRoles = new Map(grantable.map((r) => [r.name, r]));

  const roleField = field({
    id: "group-role-role",
    label: "Role",
    kind: "select",
    value: "viewer",
    hint:
      grantable.length > 0
        ? "Owner is not available for group mapping; it stays an explicit per-person grant. A custom role is mapped instead of a built-in one, and its own capability set decides what the group's members can do."
        : "Owner is not available for group mapping; it stays an explicit per-person grant.",
    doc: { href: "https://docs.downpipes.io/identity-access/group-to-role-mapping", anchor: "a-group-can-never-confer-owner" },
    options: [
      { value: "viewer", label: "Viewer" },
      { value: "operator", label: "Operator" },
      { value: "approver", label: "Approver" },
      { value: "restore-operator", label: "Restore operator" },
      { value: "access-admin", label: "Access admin" },
      ...grantable.map((r) => ({ value: customRoleChoiceValue(r.name), label: customRoleOptionLabel(r) })),
    ],
  });

  const formGrid = h("div", { class: "field-2up" });
  formGrid.appendChild(groupField.el);
  formGrid.appendChild(roleField.el);
  wrap.appendChild(formGrid);

  // The withheld custom roles, named with the reason rather than dropped in silence (see the members form).
  if (withheld.length > 0) {
    wrap.appendChild(
      h(
        "p",
        { class: "field__hint measure" },
        `Not offered: ${withheld.map((r) => r.name).join(", ")}. A custom role can only be mapped by someone who holds every capability it confers, and this one confers at least one you do not.`,
      ),
    );
  }

  // THE CEREMONY, named before the button rather than discovered after it. Adding a mapping is a step-up
  // gated write (adminOp group-role-set), so the engine opens a passkey prompt when Add mapping is pressed.
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      "You may be asked to confirm with your own passkey when you add a mapping. If you dismiss that prompt, or it fails, nothing is saved and your entry is kept here so you can try again.",
    ),
  );

  // Inline error slot: transport errors appear here; input is never lost.
  const saveError = h("p", { class: "field__error", role: "alert", hidden: true });
  wrap.appendChild(saveError);

  const saveBtn = h("button", { "data-dp": "access-security.button.save", class: "btn btn--primary btn--sm", type: "button" }, svgIcon(ICON_PLUS, { size: 14 }), "Add mapping");
  saveBtn.addEventListener("click", async () => {
    saveError.hidden = true;
    if (!validateForm([groupField])) return;
    const groupName = groupField.value();
    // Decoded, not cast: the select now carries built-in roles and custom roles in one closed list. A value
    // that decodes to neither is refused rather than sent, so a console fault cannot map a whole directory
    // group to a role nobody chose.
    const choice = decodeRoleChoice(roleField.value());
    if (choice === null) {
      saveError.textContent = "Choose a role for this mapping.";
      saveError.hidden = false;
      return;
    }
    // One POST /admin/group-roles, two bodies: the mapping names either a custom role or a built-in one.
    // Resolved to a thunk plus its display name BEFORE the write, because owner is the one built-in a group
    // may never confer and the type says so (GroupRole excludes it). The check is kept rather than cast away:
    // the engine's cap is the boundary, and a console that quietly narrowed owner to something else here
    // would map a whole directory group to a role the operator did not choose.
    let write: () => Promise<MutationResult<GroupRoleEntry>>;
    let mapped: string;
    if (choice.kind === "custom") {
      const name = choice.name;
      write = () => engine.assignGroupCustomRole(groupName, name);
      mapped = `${offeredCustomRoles.get(name)?.label ?? name} (${name})`;
    } else {
      if (choice.role === "owner") {
        saveError.textContent = "A group cannot be mapped to Owner. Owner stays an explicit per-person grant.";
        saveError.hidden = false;
        return;
      }
      const role = choice.role;
      write = () => engine.setGroupRole(groupName, role);
      mapped = titleCase(role);
    }
    saveBtn.disabled = true;
    try {
      const res = await write();
      if (res.status === "pending") surfacePendingChange("group mapping");
      else toast({ message: `Group mapping added: ${groupName} → ${mapped}` });
      // Reset the form; input was persisted until the save succeeded.
      (groupField.control as HTMLInputElement).value = "";
      groupField.clearError();
      reload();
    } catch (err) {
      if (isUnauthorised(err)) { goSignedOut(); return; }
      // Transport error: show inline, never lose the group name. stepUpAwareText, not errText: a cancelled
      // step-up ceremony throws "set group role: stepup-required: 401", and printing that raw put an internal
      // marker and a bare status in front of the operator, reading as a lapsed session when the session is fine.
      saveError.textContent = `Could not save the mapping. ${stepUpAwareText(err)}`;
      saveError.hidden = false;
    } finally {
      saveBtn.disabled = false;
    }
  });
  wrap.appendChild(h("div", saveBtn));

  return wrap;
}

function groupRoleRowActions(
  engine: EngineClient,
  entry: GroupRoleEntry,
  canManage: boolean,
  reload: () => void,
): HTMLElement {
  const wrap = h("div", { style: "display:flex;gap:var(--space-1);justify-content:flex-end" });
  if (!canManage) {
    wrap.appendChild(h("span", { class: "field__hint" }, capGateReason("access.policy")));
    return wrap;
  }

  const removeBtn = h("button", { "data-dp": "access-security.button.remove#1", class: "btn btn--ghost btn--sm", type: "button" }, "Remove");
  // The awaited delete runs INSIDE the confirm modal's busy onClick (the role-save
  // pattern), so the busyLabel covers the network call and a double fire is impossible.
  removeBtn.addEventListener("click", () => {
    openModal({
      title: "Remove group mapping",
      body: h(
        "div",
        { style: "display:grid;gap:var(--space-3)" },
        h("p", { style: "color:var(--text)" }, `Remove the mapping for group "${entry.group}"? Members whose role came only from this group will fall back to the default (Viewer). Members with a direct email grant keep their grant.`),
        h("p", { class: "field__hint measure" }, "You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is removed and you can start again from this row."),
      ),
      actions: [
        { label: "Cancel", variant: "secondary", onClick: () => {} },
        {
          label: "Remove mapping",
          variant: "danger",
          busyLabel: "Removing",
          onClick: async () => {
            try {
              const res = await engine.deleteGroupRole(entry.group);
              if (isPendingResult(res)) {
                // B8c: group-role-delete is change-control gated, so a 202 means the removal was QUEUED for a
                // second approver and the mapping still stands. The pre-fix read coerced that 202 into a
                // success ("mapping removed"); surface the queued state honestly and leave the row in place.
                surfacePendingChange("group mapping removal");
                return true;
              }
              toast({ message: `Group mapping removed: ${entry.group}` });
              reload();
              return true;
            } catch (err) {
              if (isUnauthorised(err)) {
                goSignedOut();
                return true;
              }
              toast({ message: `Could not remove the mapping. ${stepUpAwareText(err)}`, tone: "warn" });
              return false;
            }
          },
        },
      ],
    });
  });
  wrap.appendChild(removeBtn);
  return wrap;
}

// recordFeature: the feature-skew emit helper (see roles.ts). A 401 records nothing: a lapsed session is the ordinary
// state of a console left open overnight, and a fault row for each one would bury the true faults.
function recordFeature(featureClass: ClientDiagFeatureClass, err: unknown): void {
  const outcome = featureOutcomeForError(err);
  if (outcome !== null) recordFeatureProbe(featureClass, outcome);
}
