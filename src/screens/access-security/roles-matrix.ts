// The static capability model cards on the Roles and access tab: the permission matrix
// (what each role can do) and "what can I do" (the caller's own effective capabilities).
// These describe the model, not live data. Extracted from roles.ts (console-src-025-02,
// console-src-025-M1) with no change to any logic.

import { h } from "../../lib/dom.ts";
import { callerEffectiveCapabilities, type Capability } from "../../lib/identity.ts";
import { caller, whoamiAvailable } from "../../lib/nav.ts";
import { table } from "../../components/table.ts";
import { badge } from "../../components/status.ts";
import { roleBadge, accentBadge } from "./shared.ts";

// One row of the static permission matrix: a labelled action and whether each cumulative
// built-in role (viewer < operator < approver < owner) can perform it.
interface MatrixRow {
  action: string;
  viewer: boolean;
  operator: boolean;
  approver: boolean;
  owner: boolean;
}

export function permissionMatrix(): HTMLElement {
  const card = h("section", { class: "card", "aria-labelledby": "perm-matrix-h" });
  const head = h("div", { class: "card__header" });
  head.appendChild(h("h3", { class: "card__title", id: "perm-matrix-h" }, "Permission matrix"));
  head.appendChild(h("span", { class: "field__hint" }, "read < operate < restore < administer"));
  card.appendChild(head);

  const rows: MatrixRow[] = [
    { action: "View everything and export audit", viewer: true, operator: true, approver: true, owner: true },
    { action: "Restore dry-run (writes nothing)", viewer: true, operator: true, approver: true, owner: true },
    { action: "Create, edit, delete, trigger, drill", viewer: false, operator: true, approver: true, owner: true },
    { action: "Restore apply (write to live data)", viewer: false, operator: false, approver: true, owner: true },
    { action: "Approve another user's restore", viewer: false, operator: false, approver: true, owner: true },
    { action: "Key ceremony, rotate keys, manage roles", viewer: false, operator: false, approver: false, owner: true },
  ];
  const yesNo = (on: boolean): HTMLElement => (on ? h("span", { class: "status", style: "display:inline-flex;align-items:center;gap:var(--space-1);color:var(--ok-fg)" }, h("span", { class: "dot dot--ok", "aria-hidden": "true" }), "yes") : h("span", { class: "field__hint" }, "no"));

  card.appendChild(
    table<MatrixRow>({
      label: "What each role can do",
      rows,
      rowKey: (r) => r.action,
      columns: [
        { key: "action", header: "Action", render: (r) => r.action },
        // Categorical yes/no cells, not numerics: left-align under their headers (no align:"right",
        // which would right-float them and apply tabular-numeral treatment meant for numbers).
        { key: "viewer", header: "Viewer", render: (r) => yesNo(r.viewer) },
        { key: "operator", header: "Operator", render: (r) => yesNo(r.operator) },
        { key: "approver", header: "Approver", render: (r) => yesNo(r.approver) },
        { key: "owner", header: "Owner", render: (r) => yesNo(r.owner) },
      ],
    }),
  );
  // The other two grantable built-ins sit outside the cumulative ladder, so they get a
  // footnote rather than columns of mostly-no.
  card.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-3)" },
      "Two further built-in roles sit outside this cumulative ladder and are granted the same way: Restore operator (recovery only: run drills, request, apply and approve restores) and Access admin (manage roles and access policy only).",
    ),
  );
  return card;
}

// myPermissions shows the caller's OWN effective capabilities from their real role (D1),
// so there is no guessing. Pre-whoami it states the role is not yet reported, honestly.
export function myPermissions(): HTMLElement {
  const card = h("section", { class: "card", "aria-labelledby": "my-perms-h" });
  const c = caller();
  const role = whoamiAvailable() && c ? c.role : null;

  const head = h("div", { class: "card__header" });
  head.appendChild(h("h3", { class: "card__title", id: "my-perms-h" }, "What can I do"));
  // A caller on a NAMED custom role carries role="viewer" (the engine's floor); naming the built-in
  // "Viewer" would print false authority, so show the custom role's own label when one applies.
  if (role && c?.customRole) head.appendChild(accentBadge(c.customRole.label));
  else if (role) head.appendChild(roleBadge(role));
  else head.appendChild(badge("warn", "Role not yet reported"));
  card.appendChild(head);

  if (!role) {
    card.appendChild(h("p", { class: "field__hint" }, "The engine does not yet report your verified role (whoami pending). The console will not claim a capability it cannot back; once the role is reported, your effective permissions are listed here."));
    return card;
  }

  card.appendChild(h("p", { class: "field__hint", style: "margin-bottom:var(--space-3)" }, "Your effective permissions, so there is no guessing."));

  // Each row is gated by the REAL capability it represents over the caller's EFFECTIVE capability set
  // (callerEffectiveCapabilities: the custom role's own set when one applies, else ROLE_CAPABILITIES for
  // the built-in role), never the cumulative roleRank: the rank maps restore-operator and access-admin to
  // 0, which would falsely deny a restore-operator their apply/approve and an access-admin their role
  // writes, and reading the built-in role alone would floor a custom-role holder (role="viewer") to a
  // viewer's capabilities. The "requires" hint names the role(s) that hold the capability honestly, since
  // several caps belong to the off-ladder roles, not a single cumulative tier. Each row maps to ONE
  // capability so no role is ever misrepresented (the old "create, edit, trigger AND drill" row conflated
  // downpipe writes with restore-operator's recovery-only drill; they are split here).
  const caps: Array<{ cap: Capability; label: string; requires: string }> = [
    { cap: "restore.dryrun", label: "View, filter and export everything, and run dry-run restores", requires: "any role" },
    // Split per capability: the engine gates create/edit, delete and trigger on
    // THREE distinct capabilities, so a custom role holding only some must not read as holding all. A single
    // "create, edit, delete and trigger" row over-reported a downpipe.write-only custom role against the
    // per-action gates the downpipe drawer actually renders.
    { cap: "downpipe.write", label: "Create and edit downpipes", requires: "Operator, Approver or Owner" },
    { cap: "downpipe.delete", label: "Delete downpipes", requires: "Operator, Approver or Owner" },
    { cap: "run.trigger", label: "Trigger a downpipe run", requires: "Operator, Approver or Owner" },
    { cap: "drill.run", label: "Run recovery drills", requires: "Operator, Restore operator, Approver or Owner" },
    { cap: "restore.apply", label: "Apply a restore over live data, and approve another user's restore", requires: "Restore operator, Approver or Owner" },
    { cap: "roles.write", label: "Manage roles and the access policy", requires: "Access admin or Owner" },
    { cap: "keys.ceremony", label: "Run the key ceremony and rotate keys", requires: "Owner" },
  ];
  const effective = callerEffectiveCapabilities(role, c?.customRole ?? null);
  const list = h("ul", { style: "list-style:none;padding:0;margin:0;display:grid;gap:var(--space-2)" });
  for (const cap of caps) {
    const allowed = effective.has(cap.cap);
    const li = h("li", { style: "display:flex;gap:var(--space-2);align-items:flex-start" });
    if (allowed) {
      li.appendChild(h("span", { class: "dot dot--ok", "aria-hidden": "true", style: "margin-top:6px;flex:none" }));
      li.appendChild(h("span", cap.label));
    } else {
      li.appendChild(h("span", { class: "dot dot--neutral", "aria-hidden": "true", style: "margin-top:6px;flex:none" }));
      li.appendChild(h("span", { class: "field__hint" }, cap.label, h("span", { style: "margin-left:var(--space-2)" }, badge("default", `requires ${cap.requires}`))));
    }
    list.appendChild(li);
  }
  card.appendChild(list);
  card.appendChild(h("hr", { style: "border:none;border-top:1px solid var(--border-subtle);margin:var(--space-4) 0" }));
  card.appendChild(h("p", { class: "field__hint" }, "A gated control is shown disabled with the required role, never a live button that fails on click."));
  return card;
}
