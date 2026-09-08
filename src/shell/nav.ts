// The navigation rail definition. The rail maps
// one-to-one to the screen map, grouped under small uppercase section labels (not
// heavy dividers). The go-to chords are generated from the same action registry as
// the palette (registry.ts) so they never drift.
//
// Roles gate IN-SCREEN destructive controls, NOT whole rail items: a Viewer still
// sees every rail item, because a Viewer needs to READ Audit, Access status, run
// health and recovery posture (IA 2.2, "Roles gate visibility, not just enabling"
// applies to controls; the rail items themselves stay visible to all). So no nav
// item carries a role gate here.

import {
  ICON_OVERVIEW, ICON_DOWNPIPES, ICON_RUNS, ICON_RESTORE,
  ICON_ACCESS, ICON_AUDIT, ICON_KEYS, ICON_SETTINGS, ICON_LICENCE,
  ICON_MAP, ICON_COSTS, ICON_ALERT, ICON_SHIELD_CHECK, ICON_INTEGRATIONS,
  ICON_REPORT, ICON_HOURGLASS, ICON_ROLES, ICON_LOCK,
  ICON_DESTINATIONS, ICON_SOURCES, ICON_CANARY,
} from "../lib/icons.ts";
import type { Caller } from "../api.ts";
import { callerCanApproveConfigChange } from "../lib/config-changes.ts";
import { callerCanApproveOwnerAction } from "../lib/owner-actions.ts";
import { callerCan } from "../lib/identity.ts";

export interface NavItem {
  // The route this item links to (a pattern one of SCREENS binds; see lib/app-registry.ts ROUTES).
  route: string;
  // The visible label and accessible name.
  label: string;
  // The inner SVG markup for the leading glyph (lib/icons.ts).
  icon: string;
  // The route patterns that should mark this item active (so /downpipes/:id keeps
  // Downpipes active). The item's own route is always included.
  activeFor?: string[];
  // The surface SCREEN id this item addresses (a SCREEN_WRITE_CAPABILITY key in lib/identity.ts:
  // downpipes/restore/approvals/people/access/notify/expiry/audit/reports/posture), used by the
  // CURATED nav to shape the rail to the caller's per-role surface (a screen the role HIDES is
  // dropped from the rail, with a show-all escape hatch). Curation is a CONSOLE convenience only,
  // never an authority boundary: the engine still gates every write, and a hidden item stays
  // reachable by deep link / the command palette. An item with NO surfaceScreen (Overview and the
  // planning/system screens: Map, Runs, Keys, Settings, Licence, Costs) is ALWAYS shown, because it
  // carries no per-screen surface a custom role could hide.
  surfaceScreen?: string;
  // An OPTIONAL caller-aware visibility predicate, evaluated by renderRail AFTER surface curation. It is
  // the rare exception to "the rail shows every item to a viewer": an item whose destination is only
  // meaningful to a subset of roles (the Config approvals inbox, which only an approver-ish role can
  // action) declares this so a viewer is not shown a rail item they can do nothing on. PRESENTATION only,
  // never an authority boundary: the destination stays reachable by deep link / the command palette for
  // any authenticated role the engine permits, and the engine enforces every action. Most items omit it
  // and are always shown.
  visibleFor?: (caller: Caller | null) => boolean;
}

export interface NavGroup {
  // The group's uppercase section label, or null for the ungrouped top item.
  label: string | null;
  items: NavItem[];
}

// The rail structure, top to bottom (IA 2.2).
export const NAV: NavGroup[] = [
  {
    label: null,
    items: [
      { route: "/", label: "Overview", icon: ICON_OVERVIEW },
    ],
  },
  {
    label: "Operate",
    items: [
      // The water path, in dependency order (the setup-first IA, owner feedback
      // ): Destinations (where backups land, nothing works without it),
      // Sources (what to protect, discovered, never typed), then Downpipes (the
      // routes between them). Add-a-source left the rail: it is Sources' advanced
      // sub-screen (/sources/advanced) now.
      { route: "/destinations", label: "Destinations", icon: ICON_DESTINATIONS, surfaceScreen: "downpipes" },
      { route: "/sources", label: "Sources", icon: ICON_SOURCES, activeFor: ["/sources", "/sources/advanced", "/sources/add"], surfaceScreen: "downpipes" },
      { route: "/downpipes", label: "Downpipes", icon: ICON_DOWNPIPES, activeFor: ["/downpipes", "/downpipes/new", "/downpipes/:id", "/downpipes/:id/edit"], surfaceScreen: "downpipes" },
      // Map sits immediately after Downpipes: it is an at-a-glance topology view of the
      // same sources, so it reads as a companion overview of what Downpipes configures.
      // It carries no per-screen surface (it is a read-only companion of Downpipes), so it
      // is always shown.
      { route: "/map", label: "Map", icon: ICON_MAP },
      // Runs is a read-only activity log with no per-screen surface; always shown.
      { route: "/runs", label: "Runs", icon: ICON_RUNS, activeFor: ["/runs", "/runs/:downpipeId/:index"] },
      // Notifications is the alerting surface: where backup/restore/posture events are
      // routed. It sits in Operate because it is part of running the fleet (deciding what
      // reaches whom). Its sub-views (rules, history) keep Notifications active.
      { route: "/notifications", label: "Notifications", icon: ICON_ALERT, activeFor: ["/notifications", "/notifications/rules", "/notifications/history"], surfaceScreen: "notify" },
      // Integrations is the SIEM / observability / ITSM / notification catalogue: where the audit trail and
      // metrics egress. Part of running the fleet, so it sits in Operate with Notifications. It carries no
      // per-screen surface (each of its four config systems keeps its own in-screen gate), so it is always
      // shown, like Settings.
      { route: "/integrations", label: "Integrations", icon: ICON_INTEGRATIONS },
    ],
  },
  {
    label: "Govern",
    items: [
      // Security centre: the posture score and severity-ranked control checks. It leads the
      // Govern group because it is the at-a-glance read of recoverability and access posture
      // that the Access and Audit surfaces below detail. It addresses the "posture" surface.
      { route: "/security", label: "Security centre", icon: ICON_SHIELD_CHECK, surfaceScreen: "posture" },
      // Canary backup: the on-by-default known-answer integrity flight. It sits in Govern as a
      // continuous-assurance read (is the write/seal/read/restore/verify path proven byte-exact for
      // this destination?), beside the posture and audit surfaces it complements.
      { route: "/canary", label: "Canary", icon: ICON_CANARY },
      // Access is the unified governance area (the elevated access-security module owns
      // /access plus its Roles, Audit and Fallback sub-tabs). Roles and Fallback are
      // sub-tabs reached from within Access (IA 2.2, "Roles kept under Access to avoid
      // rail bloat"); Access stays active for them. The audit sub-tab is deliberately NOT
      // in Access's activeFor because Audit has its own rail item below: keeping it out
      // means exactly one item carries aria-current="page" on /access/audit (the Audit
      // leaf), the most specific match, while Access still owns enforcement/roles/fallback.
      // It addresses the "access" surface (the people/roles "people" surface is reached via
      // the Roles sub-tab from within Access, which has no rail item of its own).
      { route: "/access", label: "Access", icon: ICON_ACCESS, activeFor: ["/access", "/access/roles", "/access/roles/builder", "/access/fallback"], surfaceScreen: "access" },
      // Identity providers: the native external-IdP SSO management surface (OIDC / OAuth2 / SAML
      // connections). It sits under Govern beside Access because it is the OTHER way a team's identity is
      // established (Cloudflare Access at the edge, OR a native IdP wired here, OR passkeys). Management is
      // owner-reserved (keys.ceremony) and the engine enforces it, so visibleFor surfaces the rail item
      // only for a caller who could actually manage a connection; it stays reachable by deep link / the
      // palette / the Roles tab link for anyone the engine permits to read it. It addresses the "access"
      // surface so a custom role that hides access hides it too.
      { route: "/access/idp", label: "Identity providers", icon: ICON_KEYS, surfaceScreen: "access", visibleFor: (c) => c !== null && callerCan(c.role, "keys.ceremony", c.customRole) },
      // Audit keeps its own rail item (IA 2.2 screen 7) but deep-links into the Access
      // area's audit sub-tab, which is the elevated owner of the tamper-evident log.
      { route: "/access/audit", label: "Audit", icon: ICON_AUDIT, surfaceScreen: "audit" },
      // Reports: the four signed, tamper-evident reports (restore tests, SLA, immutability,
      // posture). It sits in Govern as the evidence surface an auditor or a board pack reads.
      { route: "/reports", label: "Reports", icon: ICON_REPORT, surfaceScreen: "reports" },
      // Config approvals: the DUAL-CONTROL config change-control inbox (the pending config mutations the
      // opt-in four-eyes / dual-control gate is holding for a SECOND APPROVER). Named "Config approvals" (it
      // pairs with "Owner approvals" below) so it reads as a dual-control APPROVAL queue and is not confused
      // with the separate change-management "Change records" report (the change-NUMBER ledger). It sits in
      // Govern next to the access/audit surfaces because it is a governance control. visibleFor surfaces it
      // only for a role that could actually APPROVE a config change (holds a config write capability), so a
      // pure viewer is not shown an inbox they can do nothing on; it stays reachable by deep link / the
      // palette for anyone, and addresses the "approvals" surface so a custom role that hides approvals hides it.
      { route: "/config/changes", label: "Config approvals", icon: ICON_ROLES, surfaceScreen: "approvals", visibleFor: (c) => callerCanApproveConfigChange(c) },
      // Owner approvals: the HIGH-BLAST-RADIUS owner-action inbox (the pending owner operations the same
      // opt-in dual-control gate is holding for a SECOND OWNER, a destination repoint/remove, an
      // identity-provider connection change, the account-browsing token set, ...). It sits beside Change
      // requests because it is the other half of the same dual-control control. visibleFor surfaces it only
      // for an owner (the only role that can APPROVE one), so a non-owner is not shown an inbox they can do
      // nothing on; it stays reachable by deep link / the palette for anyone the engine permits to read it,
      // and addresses the "approvals" surface so a custom role that hides approvals hides it too.
      { route: "/security/owner-actions", label: "Owner approvals", icon: ICON_LOCK, surfaceScreen: "approvals", visibleFor: (c) => callerCanApproveOwnerAction(c) },
      // Credentials and expiry: the dated items recovery depends on (a destination key, a
      // licence, a certificate). It sits in Govern because a silent expiry is a recoverability
      // and compliance risk; the write surface is capability-gated inside the screen. It
      // addresses the "expiry" surface.
      { route: "/credentials", label: "Credentials", icon: ICON_HOURGLASS, surfaceScreen: "expiry" },
    ],
  },
  {
    label: "Recover",
    items: [
      // Restore lives in the group named for it (the owner scanning for recovery looks
      // here first), beside Keys: together they are the recovery surface and the keys
      // recovery depends on. Its activeFor patterns are unchanged.
      { route: "/restore", label: "Restore", icon: ICON_RESTORE, activeFor: ["/restore", "/restore/:runId", "/restore/approvals"], surfaceScreen: "restore" },
      // Keys' four sections (Posture, Rotate break-glass, Custody, Offline recovery) are four routes,
      // so the rail item stays active on all of them; /keys itself serves Posture.
      { route: "/keys", label: "Keys", icon: ICON_KEYS, activeFor: ["/keys", "/keys/rotate", "/keys/custody", "/keys/recovery"] },
    ],
  },
  {
    label: "System",
    items: [
      { route: "/settings", label: "Settings", icon: ICON_SETTINGS },
      { route: "/licence", label: "Licence and updates", icon: ICON_LICENCE },
      // Costs is a browser-local planning calculator; no write, no gated control. It
      // lives in System rather than Operate because it is not an operational view of
      // live data: it is a planning and estimation tool the operator uses before or
      // alongside provisioning.
      { route: "/costs", label: "Costs", icon: ICON_COSTS },
    ],
  },
];

// isItemActive decides whether a nav item is the active one for a resolved route
// pattern (the router reports `pattern`, e.g. "/downpipes/:id"). An item is active
// if the resolved pattern is its own route or one of its activeFor patterns.
export function isItemActive(item: NavItem, resolvedPattern: string): boolean {
  if (resolvedPattern === item.route) return true;
  return (item.activeFor ?? []).includes(resolvedPattern);
}

// flatNav flattens the grouped NAV into the flat list the curated-nav resolver (lib/view-mode.ts)
// consumes, carrying each item's surface association. The curation is purely presentational: it
// shapes which rail items show for a caller's per-role surface, never what the engine permits. The
// grouped NAV stays the source of truth for the rail's section structure; this is the input the
// pure curator reasons over. exactOptionalPropertyTypes: activeFor / surfaceScreen are spread only
// when present, so an absent value is omitted rather than carried as undefined.
export function flatNav(): Array<{ route: string; label: string; icon: string; activeFor?: string[]; surfaceScreen?: string }> {
  const out: Array<{ route: string; label: string; icon: string; activeFor?: string[]; surfaceScreen?: string }> = [];
  for (const group of NAV) {
    for (const item of group.items) {
      out.push({
        route: item.route,
        label: item.label,
        icon: item.icon,
        ...(item.activeFor !== undefined ? { activeFor: item.activeFor } : {}),
        ...(item.surfaceScreen !== undefined ? { surfaceScreen: item.surfaceScreen } : {}),
      });
    }
  }
  return out;
}
