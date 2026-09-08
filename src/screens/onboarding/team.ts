// The onboarding team step (optional; honest degrade until D3): the read-only role ladder and
// the Owner-gated grant-by-email form, with the copyable enrolment link the engine mints. Moved
// verbatim from the onboarding step renderers for size; it imports only the shared leaf
// (./shared.ts) and never a sibling deck module, so no cycle forms. House rules: Australian
// English, no em dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { canCap, capGateReason, pendingEngineNote } from "../common.ts";
import { goSignedOut, caller } from "../../lib/nav.ts";
import { isUnauthorised, classifyError } from "../../lib/errors.ts";
import { blockError } from "../../components/error-view.ts";
import { field, validateForm, type Field } from "../../components/field.ts";
import { statusWithLabel } from "../../components/status.ts";
import { copyButton } from "../../components/code-block.ts";
import { toast } from "../../components/toast.ts";
import { setBusy } from "./shared.ts";
import type { EngineClient, RoleEntry } from "../../api.ts";
import { inviteTokenOf } from "../../api.ts";

// ============================================================================
// Step 5: Invite team / assign roles (optional; honest degrade until D3)
// ============================================================================

export function renderRoleModel(): HTMLElement {
  const card = h("div", { class: "card measure" });
  card.appendChild(h("h2", { class: "card__title", style: "margin-bottom:var(--space-3)" }, "The role ladder"));
  const roles: Array<{ role: string; desc: string }> = [
    { role: "Viewer", desc: "Read-only: sees posture and runs; the audit trail is included. Cannot change anything." },
    { role: "Operator", desc: "Runs and edits downpipes, triggers runs, runs drills, dry-runs a restore." },
    { role: "Approver", desc: "Approves a second operator's restore apply (dual control: a second person must approve; the requester cannot approve their own)." },
    { role: "Owner", desc: "Full control: the key ceremony, role administration, update approval, and the break-glass holder." },
  ];
  const ul = h("ul", { class: "readiness-list" });
  for (const r of roles) {
    ul.appendChild(
      h(
        "li",
        { class: "readiness-item" },
        h("span", { style: "display:flex;flex-direction:column;gap:2px" }, h("strong", r.role), h("span", { class: "field__hint" }, r.desc)),
      ),
    );
  }
  card.appendChild(ul);

  // Two narrow off-ladder roles also exist for least-privilege delegation; named here so the
  // four-rung ladder above is not read as the whole set, but kept off the simple ladder list.
  card.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-3)" },
      "Two narrower roles also exist for least-privilege delegation: Restore operator (recovery only) and Access admin (people and access policy only). Grant either later from Access then Roles.",
    ),
  );

  // The bootstrap-Owner row: the current operator, from the real whoami when available.
  const c = caller();
  const who = c?.email ? c.email : "you (the bootstrap Owner)";
  card.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-3)" },
      `So far there is only one member: ${who}, the bootstrap Owner.`,
    ),
  );
  return card;
}

// onGranted, when given, fires once a grant has actually been MADE (stored, or queued for a
// second approver); the deck card uses it to swap its advancing action from "Skip for now" to
// "Continue". It never fires on a validation stop or a failed call.
export function renderInviteForm(engine: EngineClient, onGranted?: () => void): HTMLElement {
  const wrap = h("div", { style: "margin-top:var(--space-4)" });

  // Inviting a teammate POSTs /admin/roles, which the engine gates on roles.write (Owner AND access-admin,
  // the same capability the main Access roles table gates on). Mirror that capability, not the owner ladder:
  // an access-admin's whole job is managing people, so gating this on owner-only under-granted them a control
  // the engine allows (B40, the ML-37 sibling the main table already migrated). A caller without roles.write
  // sees the form absent-with-reason.
  if (!canCap("roles.write")) {
    wrap.appendChild(
      pendingEngineNote({
        what: "Inviting teammates and assigning roles needs permission to manage roles and members, held by the Owner and Access admin roles.",
        dependsOn: capGateReason("roles.write"),
      }),
    );
    return wrap;
  }

  const emailField = field({
    id: "ob-invite-email",
    label: "Teammate email",
    type: "email",
    placeholder: "teammate@example.com",
    validate: (v) => (v !== "" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? "Enter a valid email address." : null),
    doc: { href: "https://docs.downpipes.io/identity-access/roles-and-capabilities" },
  });
  const roleField = field({
    id: "ob-invite-role",
    label: "Role",
    kind: "select",
    value: "viewer",
    options: [
      { value: "viewer", label: "Viewer" },
      { value: "operator", label: "Operator" },
      { value: "approver", label: "Approver" },
      { value: "owner", label: "Owner" },
      { value: "restore-operator", label: "Restore operator" },
      { value: "access-admin", label: "Access admin" },
    ],
    hint: "The built-in role granted to this person: viewer reads, operator runs backups, approver applies restores, owner manages everything.",
    doc: { href: "https://docs.downpipes.io/identity-access/roles-and-capabilities", anchor: "the-six-roles-at-a-glance" },
  });

  // "Grant role" is what the call does (a role-table upsert); whether an invite EMAIL
  // goes out depends on engine email config the console cannot see, so the old "Send
  // invite" label overclaimed.
  const grantBtn = h("button", { "data-dp": "onboarding.button.grant", class: "btn btn--secondary", type: "button" }, "Grant role") as HTMLButtonElement;
  const out = h("div", { class: "ob-verdict", role: "status", "aria-live": "polite" });

  grantBtn.addEventListener("click", () => void handleGrantRole(engine, emailField, roleField, grantBtn, out, onGranted));

  wrap.appendChild(emailField.el);
  wrap.appendChild(roleField.el);
  // Standing invite-email note, stated before the action so the Owner knows what "Grant role" does:
  // the engine emails the person ONLY when an invite sender is configured (an email binding plus a
  // from address). The console never sends it and holds no mail credential.
  wrap.appendChild(
    h("p", { class: "field__hint measure", style: "margin-top:var(--space-1)" }, "If invite email is configured on your engine, the person is emailed a notification that they have been granted access. The console does not send the email and holds no mail credential; until invites are configured, tell them out of band."),
  );
  // The SECOND unannounced step-up in the wizard. POST /admin/roles is a STEPUP_SUBS member and setRole
  // goes through gatedFetch, so on a cookie-borne session "Grant role" opens a browser passkey sheet. Like
  // the key install, this call site has no confirmation modal, so the confirmation-copy gate never judged
  // it and the omission was invisible to the check that exists to catch exactly this.
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint measure", style: "margin-top:var(--space-2)" },
      "You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, no role is granted and you can start again from this form.",
    ),
  );
  wrap.appendChild(h("div", { class: "ob-actions" }, grantBtn));
  wrap.appendChild(out);
  return wrap;
}

// handleGrantRole runs the grant: validate, call setRole, and branch on the outcome. A pending result
// means the change-control gate queued the grant for a second approver (unusual during onboarding, but
// kept honest); a 200 renders the success verdict; a 404/501 is the older-engine "no role store yet"
// note; any other fault is the retryable block error. A 401 hands off to signed-out.
async function handleGrantRole(
  engine: EngineClient,
  emailField: Field,
  roleField: Field,
  grantBtn: HTMLButtonElement,
  out: HTMLElement,
  onGranted?: () => void,
): Promise<void> {
  if (!validateForm([emailField])) return;
  const email = emailField.value();
  if (email === "") {
    emailField.setError("Teammate email is required.");
    return;
  }
  const role = roleField.value() as "viewer" | "operator" | "approver" | "owner";
  setBusy(grantBtn, true, "Granting");
  try {
    const res = await engine.setRole(email, role);
    setBusy(grantBtn, false, "Grant role");
    // The change-control gate may have queued this grant for a second approver (202 -> pending): say
    // so honestly rather than claiming the role was stored.
    if (res.status === "pending") {
      out.replaceChildren(
        statusWithLabel("info", `This grant for ${email} is queued for a second approver before it takes effect.`),
        h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "Your account requires config changes to be approved by a second authorised person (four-eyes). The grant appears in Config approvals until then."),
      );
      toast({ message: "Grant queued for approval", tone: "info" });
      emailField.control.value = "";
      onGranted?.();
      return;
    }
    renderGrantSuccess(res.value, out);
    emailField.control.value = "";
    onGranted?.();
  } catch (err) {
    setBusy(grantBtn, false, "Grant role");
    if (isUnauthorised(err)) return goSignedOut();
    // Only an engine that does not EXPOSE the role store at all (a 404/501 from an older build) reads
    // as pending-engine; any other failure (a 500, a network fault) is a real fault and renders the
    // retryable block error. Dressing a 500 up as a missing feature masked real errors.
    const kind = classifyError(err);
    if (kind.kind === "server" && (kind.status === 404 || kind.status === 501)) {
      out.replaceChildren(
        pendingEngineNote({
          what: "This engine build does not expose the role store yet.",
          dependsOn: "an engine update (the D3 role store).",
          interim: "Your entry was kept; update the engine, then grant again.",
        }),
      );
      return;
    }
    out.replaceChildren(blockError(err, () => grantBtn.click(), { origin: location.origin }));
  }
}

// renderGrantSuccess paints the 200 verdict: the role-stored line plus, when the engine minted one, the
// copyable /#/register?invite= enrolment link (RENDER-ONLY, never persisted, the recovery-codes
// precedent), or the out-of-band fallback note. The granted member's email is rendered escaped via h().
function renderGrantSuccess(entry: RoleEntry, out: HTMLElement): void {
  // The setRole 200 carries the minted ENROLMENT invite token alongside the entry; the console surfaces
  // it as the register link because the engine's registration gate admits only a bootstrap token, an
  // invite token or an authenticated self-add. RoleEntry stays a byte-for-byte engine mirror, so the
  // token is read through the grant-only RoleGrantResult extension (inviteTokenOf).
  const token = inviteTokenOf(entry);
  const inviteLink = token ? `${location.origin}/#/register?invite=${token}` : null;
  const children: HTMLElement[] = [statusWithLabel("ok", `Role stored for ${entry.email} as ${entry.role}.`)];
  if (inviteLink) {
    children.push(
      h(
        "div",
        { class: "key-field__row", style: "margin-top:var(--space-2)" },
        h(
          "code",
          { class: "mono", style: "white-space:nowrap;overflow-x:auto", tabindex: "0", role: "region", "aria-label": "Invite link" },
          inviteLink,
        ),
        copyButton("Copy invite link", () => inviteLink),
      ),
      h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, "Send them this link; it lands them straight in passkey set-up. Shown once; the console does not store it."),
    );
  } else {
    children.push(
      h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "Let them know out of band if invite email is not configured on your engine."),
    );
  }
  out.replaceChildren(...children);
  toast({ message: `Granted ${entry.role} to ${entry.email}.` });
}

