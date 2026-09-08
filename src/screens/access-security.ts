// Access and security, the Enterprise governance surface, as ONE self-owned area module.
// It unifies four sub-views behind an accessible tablist, each deep-linked:
//
//   /access            Enforcement: the LIVE Cloudflare Zero Trust verifier (the F7 fix,
//                      reads the REAL verdict, never a hardcoded green) + the Access setup
//                      wizard (instructional; the console configures nothing, captures no
//                      secret).
//   /access/roles      Roles and access: the in-app RBAC table (D3 grant/revoke), the
//                      last-Owner guard state (F3, server-side; mirrored here), the role
//                      from the verified identity, the permission matrix, and "what can I
//                      do".
//   /access/audit      Audit log: the tamper-evident, hash-chained record (D4) with the
//                      verify-chain action, export, server-side filters, expandable
//                      change-control detail, and the honest F6 boundary copy.
//   /access/fallback   Sessions and fallback: the session context card, session and
//                      passkey controls, the demoted shared-token disclosure (the
//                      Require-Access lock-out guardrail), and the link to the single
//                      offboarding ceremony on the Roles tab.
//
// The lead aesthetic is Obsidian (the dark default); both themes are first-class (the
// tokens carry the light companion and the teal --trust verified accent). House rules:
// Australian English, no em dashes, precise claims (post-quantum hybrid / tamper-evident,
// never tamper-proof / used a second factor). No custody is never weakened: the verifier
// reads the engine's verdict; the wizard SHOWS the wrangler commands and never submits a
// secret; every server-supplied string is a text node (dom.ts), so the closed audit
// target union and the role table can render only safe fields.
//
// RBAC is MIRRORED, never the control: every action gates on the caller's role from
// whoami (D1), but the engine enforces server-side; an Operator sees restore/role writes
// absent-or-disabled-with-reason, and a self-removal of the only Owner is pre-empted with
// the engine's own reason. The Enterprise surfaces degrade honestly (pendingEngineNote)
// until D1/D3/D4 back them, never faking a capability.
//
// This file is the coordinator: it owns the screen descriptor, the tablist and its keyboard
// focus state, the governance posture disclosure, and the tab dispatcher. Each sub-view panel
// lives in ./access-security/ (enforcement, roles, audit, fallback), and the small leaves
// reused across panels live in ./access-security/shared.ts. The externally-imported test
// helpers are re-exported from shared at the foot, so importers of this module are unchanged.

import { h, svgIcon } from "../lib/dom.ts";
import { pageHeader, requireEngine, lazyDisclosure, type Screen, type ScreenContext } from "./common.ts";
import { navigate } from "../lib/nav.ts";
import { badge } from "../components/status.ts";
import { postureStrip } from "../components/feedback.ts";
import { ICON_SHIELD_CHECK, ICON_LOCK } from "../lib/icons.ts";
import type { EngineClient } from "../api.ts";
import {
  ROUTE_ENFORCEMENT,
  ROUTE_ROLES,
  ROUTE_AUDIT,
  ROUTE_FALLBACK,
  accentBadge,
} from "./access-security/shared.ts";
import { renderEnforcementPanel } from "./access-security/enforcement.ts";
import { renderRolesPanel } from "./access-security/roles.ts";
import { renderAuditPanel } from "./access-security/audit.ts";
import { renderFallbackPanel } from "./access-security/fallback.ts";

// The externally-needed leaf helpers live in shared.ts (pure logic the validators exercise);
// re-export them here so test and app imports from "./access-security.ts" still resolve.
export {
  canTerminateUserSessions,
  canTerminateAllSessions,
  auditSourceIpDisplay,
  ENGINE_STATE_FIELD_LABELS,
} from "./access-security/shared.ts";

type AreaTab = "enforcement" | "roles" | "audit" | "fallback";

// ---------------------------------------------------------------------------
// The screen descriptor. It OWNS the four area routes; the
// integrator wires them from this descriptor. measure:"wide" because the Roles and
// Audit sub-views are dense tables.
// ---------------------------------------------------------------------------

export const accessSecurityScreen: Screen = {
  route: [ROUTE_ENFORCEMENT, ROUTE_ROLES, ROUTE_AUDIT, ROUTE_FALLBACK],
  title: "Access and security",
  measure: "wide",
  actions: [
    {
      id: "access.open",
      title: "Go to Access and security",
      group: "Navigation",
      kind: "navigate",
      keywords: ["access", "security", "zero trust", "cloudflare", "verify", "enforcement"],
      target: ROUTE_ENFORCEMENT,
    },
    {
      id: "access.roles",
      title: "Manage roles and access",
      group: "Navigation",
      kind: "navigate",
      // Carries the group-mapping keywords too: the mapping panel lives on this view, and a second
      // palette action landing on the identical route offered two entries for one destination.
      keywords: ["roles", "rbac", "members", "permissions", "grant", "owner", "approver", "group", "idp", "identity provider", "sso", "group mapping"],
      target: ROUTE_ROLES,
    },
    {
      id: "access.audit",
      title: "Open the audit log",
      group: "Navigation",
      kind: "navigate",
      keywords: ["audit", "log", "tamper-evident", "who did what", "chain", "export"],
      target: ROUTE_AUDIT,
    },
  ],
  render(ctx: ScreenContext): HTMLElement {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root;

    // Resolve the active sub-view from the matched route. Prefer the pattern (what the
    // router bound), fall back to the path so the tab is correct even if a bind adapter
    // does not forward the pattern.
    const tab = tabFor(ctx.pattern || ctx.path);

    // The custody claim lives once, in the posture-strip chip below ("no credential custody,
    // by construction"), not restated in the header.
    // The heading confirms the click. Audit is the one tab with its OWN rail item, so landing
    // on it from the rail must not read "Access and security" (the title would contradict the
    // nav label); it takes the rail's own word, "Audit", distinct from the panel's "Audit log"
    // section heading below. The other tabs are reached from the tab strip directly under this
    // header, so the area framing stays for them.
    const areaHead = {
      title: "Access and security",
      sub: "Your team signs in with Cloudflare Access, a native identity provider, or a passkey; the engine verifies every request and fails closed, and this console guides, verifies and records. Roles and audit apply the same way however a person signed in.",
    };
    const auditHead = {
      title: "Audit",
      sub: "The tamper-evident record of every governed action: who did what, when and from where, hash-chained so any alteration breaks the chain.",
    };
    const head = tab === "audit" ? auditHead : areaHead;
    root.appendChild(pageHeader(head.title, head.sub));

    root.appendChild(buildPostureStrip());
    root.appendChild(buildGovernanceDisclosure());

    // The accessible sub-view tablist. Each tab is a real route the router owns, so
    // the view is deep-linkable and the back button works; selecting a tab navigates.
    root.appendChild(areaTabs(tab));
    root.appendChild(buildTabPanel(tab, engine, ctx.query));
    restoreTabKeyboardFocus(root, tab);
    return root;
  },
};

// buildPostureStrip renders the standing posture in ONE line: counts computed
// from the same MATURITY_ITEMS, never restated by hand.
function buildPostureStrip(): HTMLElement {
  const liveCount = MATURITY_ITEMS.filter((i) => i.live).length;
  const pendingCount = MATURITY_ITEMS.length - liveCount;
  return h(
    "div",
    { style: "margin-top:var(--space-4)" },
    postureStrip(
      [
        { tone: "ok", label: `${liveCount} controls enforced server-side` },
        pendingCount > 0
          ? { tone: "neutral", label: `${pendingCount} optional, disclosed below` }
          : { tone: "ok", label: "no controls pending" },
        { tone: "trust", label: "no credential custody, by construction" },
      ],
      { label: "Governance posture" },
    ),
  );
}

// buildGovernanceDisclosure holds the division-of-responsibility statement and the per-control
// maturity detail behind a single disclosure instead of two stacked cards on every visit, same
// honesty, lower volume.
function buildGovernanceDisclosure(): HTMLElement {
  return h(
    "div",
    { style: "margin-top:var(--space-3)" },
    lazyDisclosure("Governance posture and who enforces what", () => {
      const detail = h("div", { class: "stack-sm" });
      detail.appendChild(responsibilityBody());
      detail.appendChild(maturityBody());
      return detail;
    }),
  );
}

// buildTabPanel wraps the active panel in its own region, labelled by its tab. The route query is
// threaded in so the audit sub-view can seed its server-side filters from the URL and reflect changes
// back via replaceState (console-access-2).
function buildTabPanel(tab: AreaTab, engine: EngineClient, query: URLSearchParams): HTMLElement {
  const panel = h("div", { class: "area-panel", id: `area-panel-${tab}`, role: "tabpanel", "aria-labelledby": `area-tab-${tab}`, tabindex: "0", style: "margin-top:var(--space-5)" });
  panel.appendChild(renderTab(tab, engine, query));
  return panel;
}

// restoreTabKeyboardFocus moves OS focus to the newly-active tab button when the previous interaction
// was a keyboard arrow/Home/End navigation. The flag is set in the keydown handler and consumed here;
// mouse clicks leave it unset so they are unaffected.
function restoreTabKeyboardFocus(root: HTMLElement, tab: AreaTab): void {
  if (!tabKeyboardFocus.consume()) return;
  // queueMicrotask defers until after the caller inserts root into the document, so the button is
  // reachable and focus() moves the real OS focus ring.
  queueMicrotask(() => {
    const activeBtn = root.querySelector<HTMLButtonElement>(`#area-tab-${tab}`);
    activeBtn?.focus();
  });
}

function tabFor(pattern: string): AreaTab {
  switch (pattern) {
    case ROUTE_ROLES: return "roles";
    case ROUTE_AUDIT: return "audit";
    case ROUTE_FALLBACK: return "fallback";
    default: return "enforcement";
  }
}

function renderTab(tab: AreaTab, engine: EngineClient, query: URLSearchParams): HTMLElement {
  switch (tab) {
    case "roles": return renderRolesPanel(engine);
    case "audit": return renderAuditPanel(engine, query);
    case "fallback": return renderFallbackPanel(engine);
    case "enforcement": return renderEnforcementPanel(engine);
  }
}

// ---------------------------------------------------------------------------
// Division of responsibility (storyboard panel 2). The three honest rows.
// ---------------------------------------------------------------------------

function responsibilityBody(): HTMLElement {
  // Disclosure body (the section heading lives in the summary): the three honest
  // division-of-responsibility rows.
  const card = h("div");
  const header = h("div", { style: "display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-3)" });
  header.appendChild(h("h3", { class: "section-title", style: "margin-bottom:0" }, "Who enforces what"));
  header.appendChild(accentBadge("No console-rendered login"));
  card.appendChild(header);

  const rows = h("div", { class: "stack-sm", style: "display:grid;gap:var(--space-3)" });
  rows.appendChild(respRow(ICON_SHIELD_CHECK, "Cloudflare Access, at the edge.", "Enforces sign-in, SSO, MFA and IP rules in front of both this console and your engine. This console does not authenticate you."));
  rows.appendChild(respRow(ICON_SHIELD_CHECK, "Your engine, in your account.", "Verifies the Access token on every request and fails closed, and enforces roles per route. This console renders that faithfully; it is not the boundary."));
  rows.appendChild(respRow(ICON_LOCK, "This console holds no credential.", "It never captures a password, an IdP secret or a Cloudflare token. Where setup needs one, it links you to the Cloudflare dashboard and says so."));
  card.appendChild(rows);
  return card;
}

// maturityCard is the persistent, calm capability-maturity disclosure (C8-04), elevated to
// a security control-plane read: a control-count summary row (live vs pending) sits above
// the per-control detail, so a buyer or reviewer sees the honest posture at a glance and in
// full without hunting across sub-views. It is not an alarm; it uses the same card/inset
// styling and pendingEngineNote tone as the rest of the screen. Each control names its
// proof (the verify action, the maker/approver split) so the claim is checkable.
type MaturityItem = { live: boolean; code: string; label: string; detail: string };

const MATURITY_ITEMS: MaturityItem[] = [
  {
    live: true,
    code: "D1",
    label: "Verified identity (whoami)",
    detail: "The engine verifies the Cloudflare Access token on every request and reports the caller's email and role. Fails closed: no token, no access.",
  },
  {
    live: true,
    code: "D2",
    label: "Dual-control approvals",
    detail: "Applying a restore requires a separate approver. The engine enforces the maker/approver split (maker is not the checker) and records the approver on the audit entry.",
  },
  {
    live: true,
    code: "D3",
    label: "Server-side RBAC",
    detail: "Roles are stored and enforced per route on the engine. Viewer, Operator, Approver and Owner are cumulative, keyed by verified email (however the person signed in: Cloudflare Access, a native identity provider, or a passkey). The last-Owner guard prevents a lockout.",
  },
  {
    live: true,
    code: "D4",
    label: "Tamper-evident audit",
    detail: "Every privileged action is hash-chained in the engine audit store. A break is detectable by the verify-chain action or by comparing the exported head hash. Tamper-evident means detectable, not impossible.",
  },
  {
    live: true,
    code: "D5",
    label: "Audit retention cap and rollover",
    detail: "The engine retains audit entries up to a fixed cap and rolls over oldest-first once that cap is reached, preserving chain verifiability from the earliest retained entry. Export before rollover to retain older entries beyond the cap.",
  },
  {
    live: false,
    code: "IdP",
    label: "Group-claim role mapping (optional)",
    detail: "The console provides a group-to-role mapping panel (Roles and access tab) for teams whose identity provider sends group claims, whether the person signs in through Cloudflare Access, a native identity provider wired under Identity providers, or SAML. The mapping is applied only when a sign-in carries groups; downpipes works fully without it on the passkey or shared-token path, with no Zero Trust seat requirement. The engine honours these mappings once it reads the group claim from the verified sign-in; check your engine build for support.",
  },
  {
    live: false,
    code: "Token",
    label: "Access-only mode (token close-off)",
    detail: "Closing the shared-token fallback path is an out-of-band engine step (remove the engine's admin token once Access verifies), not a console switch. The fallback panel shows the exact command; the console does not claim to enforce it.",
  },
];

function maturityBody(): HTMLElement {
  // Disclosure body: the per-control maturity detail. The at-a-glance counts live in
  // the posture strip on the screen root (computed from the same MATURITY_ITEMS), so
  // the stat-tile summary that used to sit here is gone, the strip carries it.
  const card = h("div");
  card.appendChild(h("h3", { class: "section-title" }, "Governance controls"));
  card.appendChild(h("p", { class: "field__hint measure", style: "margin-bottom:var(--space-4)" }, "Each governance control, what it enforces today and what is pending, with the proof you can check. This disclosure is updated as each capability ships."));

  // The per-control detail list, each row naming its proof so the claim is checkable.
  const list = h("ul", { style: "list-style:none;padding:0;margin:var(--space-4) 0 0;display:grid;gap:var(--space-3)" });
  for (const item of MATURITY_ITEMS) {
    const li = h("li", { style: "display:grid;grid-template-columns:auto 1fr;gap:var(--space-3);align-items:start" });
    const dot = item.live
      ? h("span", { class: "dot dot--ok", "aria-hidden": "true", style: "margin-top:6px;flex:none" })
      : h("span", { class: "dot dot--neutral", "aria-hidden": "true", style: "margin-top:6px;flex:none" });
    const body = h("div");
    body.appendChild(
      h(
        "b",
        { style: "display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" },
        h("span", { class: "section-label" }, item.code),
        h("span", item.label),
        item.live ? badge("ok", "enforced") : badge("default", "pending"),
      ),
    );
    body.appendChild(h("span", { class: "field__hint" }, item.detail));
    li.appendChild(dot);
    li.appendChild(body);
    list.appendChild(li);
  }
  card.appendChild(list);
  return card;
}

function respRow(icon: string, lead: string, rest: string): HTMLElement {
  const row = h("div", { style: "display:grid;grid-template-columns:auto 1fr;gap:var(--space-3);align-items:start" });
  row.appendChild(h("span", { style: "color:var(--trust);flex:none;margin-top:2px" }, svgIcon(icon, { size: 18 })));
  row.appendChild(h("p", h("b", lead), " ", h("span", { style: "color:var(--text-muted)" }, rest)));
  return row;
}

// ---------------------------------------------------------------------------
// The sub-view tablist. Reuses the existing drawer-tab CSS (a generic underline tab
// treatment, no new CSS), wired as a real WAI-ARIA tablist: roving tabindex, arrow
// keys, Home/End. Activating a tab navigates to its route (deep-linkable).
// ---------------------------------------------------------------------------

// Keyboard-focus hand-off between the tablist keydown handler and the next render: the
// handler signals immediately before navigate() so the render knows to restore keyboard
// focus to the newly-active tab button, and the render consumes it once. Mouse clicks
// never signal, so mouse navigation is unaffected. Encapsulated in a closure controller
// so the mutable boolean is not loose module-level surface (console-src-022-10).
const tabKeyboardFocus = (() => {
  let pending = false;
  return {
    signal(): void {
      pending = true;
    },
    consume(): boolean {
      const was = pending;
      pending = false;
      return was;
    },
  };
})();

function areaTabs(active: AreaTab): HTMLElement {
  const defs: Array<{ id: AreaTab; label: string; route: string }> = [
    { id: "enforcement", label: "Enforcement", route: ROUTE_ENFORCEMENT },
    { id: "roles", label: "Roles and access", route: ROUTE_ROLES },
    { id: "audit", label: "Audit log", route: ROUTE_AUDIT },
    // Named for what the panel holds (sessions, passkeys, sign-out levers, the shared-token
    // fallback); no policy is edited here (that lives in Cloudflare).
    { id: "fallback", label: "Sessions and fallback", route: ROUTE_FALLBACK },
  ];

  const list = h("div", { class: "drawer-tablist", role: "tablist", "aria-label": "Access and security sections", style: "margin-top:var(--space-5)" });

  for (const def of defs) {
    const selected = def.id === active;
    const btn = h(
      "button",
      {
        class: "drawer-tab",
        type: "button",
        role: "tab",
        id: `area-tab-${def.id}`,
        "aria-controls": `area-panel-${def.id}`,
        "aria-selected": selected ? "true" : "false",
        tabindex: selected ? "0" : "-1",
      },
      def.label,
    ) as HTMLButtonElement;
    btn.addEventListener("click", () => {
      if (!selected) navigate(def.route);
    });
    list.appendChild(btn);
  }

  list.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft" && ev.key !== "Home" && ev.key !== "End") return;
    const idx = defs.findIndex((d) => d.id === active);
    let next = idx;
    if (ev.key === "ArrowRight") next = (idx + 1) % defs.length;
    else if (ev.key === "ArrowLeft") next = (idx - 1 + defs.length) % defs.length;
    else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = defs.length - 1;
    ev.preventDefault();
    // Signal that the next render should restore focus to the newly-active tab button.
    // This is consumed by the render() path so mouse clicks leave it unset.
    tabKeyboardFocus.signal();
    navigate(defs[next]!.route);
  });

  return list;
}
