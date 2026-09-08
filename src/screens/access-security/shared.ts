// Shared leaf helpers for the Access and security area module. These are the small,
// dependency-free building blocks reused across more than one of the four sub-view panels
// (enforcement, roles, audit, fallback), kept here so each panel module imports only this
// leaf and never imports a sibling panel (which would form a cycle). The exported helpers
// at the foot are the pure-logic extracts the validators exercise; they are re-exported from
// the coordinator so the public import surface of access-security.ts is unchanged.

import { h, svgIcon } from "../../lib/dom.ts";
import { can, type Role as CapRole } from "../../lib/identity.ts";
import { caller, whoamiAvailable } from "../../lib/nav.ts";
import { badge, type StatusTone } from "../../components/status.ts";
import { titleCase } from "../../lib/format.ts";
import type { AccessVerdict } from "../../components/verdict.ts";
import { accessVerdictFromCaller } from "../../components/trust-chips.ts";
import type { Role, AuditEvent } from "../../api.ts";

// The four area routes. They live here (a leaf) because the panel modules deep-link to
// each other (the enforcement panel links to Roles, the audit panel rewrites the audit URL,
// the fallback panel links to Roles), so importing them from the coordinator would couple a
// panel back to its owner. The coordinator imports them from here too.
export const ROUTE_ENFORCEMENT = "/access";
export const ROUTE_ROLES = "/access/roles";
export const ROUTE_AUDIT = "/access/audit";
export const ROUTE_FALLBACK = "/access/fallback";

// AUDIT_PAGE_LIMIT is the audit log page size: how many events one read returns and the
// threshold at which the "Load older events" affordance appears. A single named source so
// the seed default and the pagination guards cannot drift (console-src-023-03).
export const AUDIT_PAGE_LIMIT = 100;

// deriveVerdict reads the boot-resolved caller. If whoami is unavailable the verdict is
// session-present (authenticated, method unknown), NEVER verified-green.
//
// IT DELEGATES TO accessVerdictFromCaller, WHICH IS THE CONSOLE'S ONE READ OF THE SIGN-IN METHOD.
// This module used to hold a private copy of that mapping (access -> access, passkey -> passkey, EVERYTHING
// ELSE -> the shared break-glass token), and it was the copy on the ACCESS AND SECURITY SCREEN itself: the very
// screen the rest of the console sends a customer to when it wants them to harden their posture. A live OIDC
// session, a live SAML session, a recovery-code sign-in and a method this build has never heard of all landed on
// "Token fallback in use ... anyone with this URL and the shared admin token can administer it", which is the
// worst thing the console can say about a customer's security and was untrue in all four, and none of them
// recorded a thing. There is one mapping now, it answers honestly for all six engine methods, and an
// unrecognised method answers `unknown` AND records the wire anomaly (the method string never rides).
export function deriveVerdict(): AccessVerdict {
  const c = caller();
  if (whoamiAvailable() && c) {
    return accessVerdictFromCaller(c, true);
  }
  return { state: "session-present" };
}

// reauthenticate bounces the browser through Cloudflare Access so the edge re-issues the
// session; the console never collects a credential. We send the browser to the same
// origin (Access intercepts and re-authenticates); the intended URL is preserved.
export function reauthenticate(): void {
  // The edge owns auth; navigating to the app under Access triggers the re-auth flow.
  location.assign(location.href);
}

export function noteLine(icon: string, text: string): HTMLElement {
  return h(
    "p",
    { class: "field__hint measure", style: "display:flex;gap:var(--space-2);align-items:flex-start" },
    h("span", { style: "flex:none;margin-top:1px" }, svgIcon(icon, { size: 16 })),
    h("span", text),
  );
}

// statusLine is a read-only posture row: a hue + shape dot, a bold title, and a muted
// detail. Used for honest read-only posture disclosures (the require-Access posture and the
// admin break-glass warning), so a state reads by colour AND shape AND text, never colour
// alone (WCAG 1.4.1). It is not a control: it states what is, with no affordance that implies
// it can change it here. A leaf so both the fallback panel and its sessions-passkeys section use it.
export function statusLine(tone: StatusTone, title: string, detail: string): HTMLElement {
  return h(
    "div",
    { style: "display:grid;grid-template-columns:auto 1fr;gap:var(--space-3);align-items:start" },
    h("span", { class: `dot dot--${tone}`, "aria-hidden": "true", style: "margin-top:6px;flex:none" }),
    h(
      "div",
      h("b", { style: "display:block" }, title),
      h("span", { class: "field__hint" }, detail),
    ),
  );
}

export function roleBadge(role: Role): HTMLElement {
  const tone: StatusTone | "default" = role === "owner" ? "trust" : role === "approver" ? "info" : role === "operator" ? "ok" : "default";
  return badge(tone, titleCase(role));
}

// accentBadge is the indigo-accent pill (the "No console-rendered login" / "Owner only"
// markers). The shared badge() helper covers the semantic status tones; this emits the
// real .badge--accent treatment without widening the shared component's tone union.
export function accentBadge(label: string): HTMLElement {
  return h("span", { class: "badge badge--accent" }, h("span", label));
}

// roleOrCustomRoleBadge names a grant's EFFECTIVE role for a members/groups table cell. A grant that
// confers a custom role carries only the role's NAME on the row (RoleEntry/GroupMapping.customRole is a
// string; the engine pins the built-in role field to the "viewer" floor), so rendering roleBadge(role)
// alone would mislabel every custom-role holder as "Viewer" - the exact false-authority the table must
// not print. When a custom role is named, show it as an accent pill (distinct from the six built-in
// role tones) so the row tells the truth about the grant; otherwise fall back to the built-in badge.
// The name is engine-canonicalised and rendered via h()'s escaping text-node path (never innerHTML).
// customRoleIsMissing answers whether a grant names a custom role that no longer exists. Pure over the two
// values so it is unit-tested without a DOM.
//
// Deleting a custom role deliberately does NOT sweep the grants that name it: resolveAuthority ignores a name
// that is gone, so every holder falls back to the VIEWER FLOOR at their next request. That is the right engine
// behaviour (least privilege, not fail-open, and no unbounded write), but it means the grant row keeps a role
// name that confers nothing.
//
// An EMPTY list is "not known", never "nothing exists". The catalogue is read best-effort beside these tables,
// so a failed read must not declare every custom-role grant dead.
export function customRoleIsMissing(entry: { customRole?: string }, knownCustomRoles: readonly string[]): boolean {
  const named = entry.customRole?.trim() ?? "";
  if (named === "" || knownCustomRoles.length === 0) return false;
  return !knownCustomRoles.some((n) => n.trim().toLowerCase() === named.toLowerCase());
}

export function roleOrCustomRoleBadge(entry: { role: Role; customRole?: string }, knownCustomRoles: readonly string[] = []): HTMLElement {
  if (entry.customRole && entry.customRole.trim() !== "") {
    // A named role that has been DELETED must not print as authority the holder does not have. This is the
    // same false-authority this function exists to prevent, in the other direction: rendering the pill alone
    // tells an owner auditing the table that the grant is live when the holder is actually at the viewer floor.
    if (customRoleIsMissing(entry, knownCustomRoles)) {
      return h(
        "span",
        accentBadge(entry.customRole),
        h("span", { class: "field__hint nowrap", style: "margin-left:var(--space-1)" }, "(deleted: viewer floor)"),
      );
    }
    return accentBadge(entry.customRole);
  }
  return roleBadge(entry.role);
}

// errText now lives in lib/errors.ts; re-exported here so the access-security screens keep their local import.
export { errText } from "../../lib/errors.ts";

// canTerminateUserSessions / canTerminateAllSessions are the CLIENT gate mirrors for the two admin
// session levers, exported pure so the validator asserts them against the engine's gates. The engine is
// the enforcement point; these only decide whether the console offers the control or shows it
// disabled-with-reason. terminate-user gates on roles.write (owner AND access-admin hold it);
// terminate-all is owner-only (the engine additionally requires callerRole === owner before rotating the
// session key). A null role (whoami pending) is handled by the canCap/canDo callers, which fail closed.
export function canTerminateUserSessions(role: CapRole): boolean {
  return can(role, "roles.write");
}
export function canTerminateAllSessions(role: CapRole): boolean {
  return role === "owner";
}

// auditSourceIpDisplay decides how to render the "Source IP" cell honestly, so the panel's "from where"
// promise is not undermined by treating a legitimately-blank system event the same as a missing IP.
//   - "ip": the event carries a source IP -> show it (the normal human-action case).
//   - "system": the event is engine-INITIATED (actorMethod "engine") and so HAS no client request to read
//     an IP from -> blank is CORRECT here, shown as "system" / "engine-initiated" rather than a bare dash,
//     so an operator sees this is an engine action with no origin, not a recording gap.
//   - "missing": a NON-engine (human) event that genuinely lacks an IP (e.g. a pre-fix entry, or a path
//     that could not capture one) -> the honest "not recorded" dash, distinct from the system case.
// The text reuses the engine actor wording so the two surfaces stay consistent. Engine actors that DID
// somehow carry an IP (none do today) still render the IP, which is the most informative honest choice.
export function auditSourceIpDisplay(e: Pick<AuditEvent, "sourceIp" | "actorMethod">): { kind: "ip" | "system" | "missing"; text: string } {
  if (e.sourceIp) return { kind: "ip", text: e.sourceIp };
  if (e.actorMethod === "engine") return { kind: "system", text: "system" };
  return { kind: "missing", text: "not recorded" };
}

// ---------------------------------------------------------------------------
// Engine-state field label mapping (CON-L4). Exported for testing.
// Maps the raw internal API field names to human-readable strings that are safe
// to show in the UI. Any field not listed falls back to the raw name so a
// future engine-state field never silently disappears from the audit log.
// ---------------------------------------------------------------------------

// EVERY member of the engine's engine-state field union is labelled here, and the completeness is the fix
// (G289). "secret-absent" is the G027 presence LOSS: a tracked secret VANISHED, which is the engine saying a
// deploy dropped the signer key, the break-glass key or the destination binding, and therefore why the
// backups stopped. It fell out of this two-entry table, so describeTarget took the unknown-field arm and
// recorded a contract-skew row whose vocabulary asserts "a NEWER engine is writing fields this build does not
// know" -- a row byte-identical to a genuinely-newer engine's, on the one screen the "backups stopped" ticket
// lands on. Support holding the pack of a customer whose backups had stopped was told to upgrade a console
// that was in lockstep with its engine. A field with no label here must mean what the row says it means.
export const ENGINE_STATE_FIELD_LABELS: Readonly<Record<string, string>> = {
  "secret-present": "Engine secret present",
  "secret-absent": "Engine secret MISSING",
  "engineVersion": "Engine version",
};

