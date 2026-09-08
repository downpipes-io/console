// The console VIEW MODE: the managerial-vs-technical ("shiny") skin the operator console
// renders in, plus the per-role landing and curated-nav resolution that go with it. This is a
// PRESENTATION layer only and carries NO authority: the capability set is the sole authority
// (lib/identity.ts), the engine is always the enforcement point, and nothing here ever gates a
// write. The view mode chooses a skin; the surface map chooses which rail items to show; neither
// can grant a capability the engine would refuse.
//
// Two framings of the SAME honest data:
//   - "technical" the full operator console (the default, and what every built-in role gets);
//   - "shiny"     the executive, reassurance-first surface: plain-English answers that each click
//                 through to the technical evidence. It never hides a number; it leads with the
//                 plain answer and links to the detail.
//
// The choice resolves from two inputs, in order:
//   1. the ROLE PRESENTATION DEFAULT (resolvePresentation, from a custom role; built-ins default
//      to "technical"). This is what a role lands in the FIRST time, so an executive seat opens in
//      the shiny framing without the operator having to flip it.
//   2. a per-user STORED override (localStorage "dp-view-mode"), so once the operator flips the
//      toggle their choice sticks across reloads and wins over the role default.
//
// All of this module is PURE (no DOM): getViewMode/setViewMode mirror lib/theme.ts
// (best-effort localStorage, a listener set), and the resolution helpers are
// referentially-transparent functions over the caller's resolved role/customRole/surface, so they
// are exhaustively unit-testable without a DOM.

import { recordStorageBlocked } from "./client-diag/ring.ts";

import type { Caller } from "../api.ts";
import {
  resolvePresentation,
  resolveSurface,
  type Presentation,
  type SurfaceMode,
} from "./identity.ts";

// ViewMode is the resolved skin the shell renders in. It is the same two-member vocabulary as the
// custom-role Presentation hint (technical|shiny); kept as its own alias so a screen reads "view
// mode" at the point of use while the persistence and the role default speak the same values.
export type ViewMode = Presentation;

export const STORAGE_KEY = "dp-view-mode";

// isViewMode is the guard for a stored / supplied value, so a corrupted localStorage entry or an
// unexpected string reads as "no stored preference" rather than rendering a broken skin.
export function isViewMode(v: unknown): v is ViewMode {
  return v === "technical" || v === "shiny";
}

// getStoredViewMode reads the per-user OVERRIDE, or null when none is stored (or localStorage is
// unreadable). Null is the meaningful "the user has not flipped the toggle" state the resolver
// needs, distinct from a concrete "technical": a stored "technical" is a deliberate user choice
// that must win over a role default of "shiny", whereas null means "fall back to the role default".
export function getStoredViewMode(): ViewMode | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isViewMode(v)) return v;
  } catch (err) {
    // localStorage blocked; treat as no stored override. The operator's flip to the technical console is
    // silently undone on every reload, and the console has never been able to say the browser refused to keep it.
    recordStorageBlocked("local", "read", "view-mode", err);
  }
  return null;
}

// resolveViewMode is the single resolution rule the shell reads on every navigation: a stored user
// override wins; absent one, the role's presentation default applies. Pure over (roleDefault,
// stored), so the test pins every combination without a DOM. A caller convenience that reads the
// live store is resolveViewModeForCaller below.
export function resolveViewMode(roleDefault: ViewMode, stored: ViewMode | null): ViewMode {
  return stored ?? roleDefault;
}

// resolveViewModeForCaller is the live read: the caller's role presentation default (from a custom
// role, else "technical") combined with the stored per-user override. A null caller (whoami
// pending) has no role default, so it resolves to the stored override or the calm "technical"
// default, never a faked executive skin before the role is known.
export function resolveViewModeForCaller(caller: Caller | null): ViewMode {
  const roleDefault = roleDefaultViewMode(caller);
  return resolveViewMode(roleDefault, getStoredViewMode());
}

// roleDefaultViewMode is the presentation default a caller's role lands in BEFORE any user
// override: the custom role's declared presentation when a custom role applies, else "technical"
// (every built-in role gets the full technical console; "shiny" is a custom-role-only default). A
// null caller defaults to "technical" (the calm resting state until the role is known).
export function roleDefaultViewMode(caller: Caller | null): ViewMode {
  if (!caller) return "technical";
  return resolvePresentation(caller.role, caller.customRole ?? null);
}

// setViewMode persists the per-user override (best-effort). The shell re-reads the resolved mode
// explicitly after a flip (app.ts calls shell.setViewMode), so there is no live pub-sub here.
// Persisting a blocked localStorage still leaves the in-session choice applied by the caller.
export function setViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch (err) {
    // best-effort persistence; the in-session choice still applies via the caller's explicit re-read.
    recordStorageBlocked("local", "write", "view-mode", err);
  }
}

// clearViewMode removes the per-user override so the caller falls back to the role default. Used by
// a "reset to my role default" affordance; best-effort like setViewMode.
export function clearViewMode(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    // best-effort; nothing to clear in a blocked localStorage.
    recordStorageBlocked("local", "remove", "view-mode", err);
  }
}

// ---- surface <-> route mapping ----------------------------------------------------------------
// A custom role declares its per-screen surface against the SCREEN ids the engine knows (lib/
// identity.ts SCREEN_WRITE_CAPABILITY keys: downpipes/restore/approvals/people/access/notify/
// expiry/audit/reports/posture), but the console nav is keyed by ROUTE. These two maps are the
// single bridge between the two vocabularies, so the curated nav (which shapes ROUTE items) can ask
// "what surface does this route address" and the landing resolver (which reads a surface-id landing)
// can ask "what route do I open". Kept here, next to the resolution logic, as the one crossing point.

// SURFACE_ROUTE maps a surface SCREEN id to the console ROUTE its holder opens on. A screen the nav
// reaches by a different path than its bare id (people -> /access/roles, access -> /access, posture
// -> /security, expiry -> /credentials, notify -> /notifications, audit -> /access/audit) is mapped
// explicitly so a landing on that surface opens the right place. Every SCREEN_WRITE_CAPABILITY key
// is present, so a landing id always resolves to a route.
export const SURFACE_ROUTE: Record<string, string> = {
  downpipes: "/downpipes",
  restore: "/restore",
  approvals: "/restore/approvals",
  people: "/access/roles",
  access: "/access",
  notify: "/notifications",
  expiry: "/credentials",
  audit: "/access/audit",
  reports: "/reports",
  posture: "/security",
};

// landingRoute resolves a surface-id landing (the value a custom role stores, e.g. "downpipes") to
// the route the console navigates to. An unknown id (a future engine screen the console does not yet
// route) falls back to "/" (Overview), which is always safe and never a dead end.
export function landingRoute(landingScreenId: string): string {
  return SURFACE_ROUTE[landingScreenId] ?? "/";
}

// isKnownLandingScreen reports whether this console build can route a custom role's landing id. It is the
// PREDICATE behind the "/" fallback above, split out so the console can RECORD the skew rather than only absorb
// it: the fallback is safe (Overview is never a dead end) and it is also the ticket, because an executive whose
// role lands them on a screen this console cannot route silently arrives on Overview instead, every time, and
// nothing anywhere says the id was not recognised. Pure; the id is tested and never returned.
export function isKnownLandingScreen(landingScreenId: string): boolean {
  return SURFACE_ROUTE[landingScreenId] !== undefined;
}

// landingRouteForCaller is the per-role landing the app opens a caller on. A custom role lands on its
// declared landing screen (resolved to a route); a built-in role lands on "/" (Overview), its
// established home. A null caller (whoami pending) also lands on "/". This is a SUGGESTION the app
// applies on first resolve; the operator may navigate anywhere their surface permits afterwards.
export function landingRouteForCaller(caller: Caller | null): string {
  if (!caller?.customRole) return "/";
  return landingRoute(caller.customRole.landing);
}

// ---- curated nav ------------------------------------------------------------------------------
// The curated nav shapes the rail by the caller's SURFACE: a screen the role HIDES is dropped from
// the rail (so an executive surface is not cluttered with screens they never use), a read/edit
// screen is shown. Crucially this is a CONSOLE convenience, never an authority boundary: a hidden
// item is still reachable two ways so the curation can never trap a caller or hide evidence:
//   1. the SHOW-ALL escape hatch (showAll = true) renders the FULL rail read-only, and
//   2. deep links / the command palette still route to any screen the engine permits.
// Overview, and any route with NO surface association (the planning/system screens: Map, Runs,
// Keys, Settings, Licence, Costs), are ALWAYS shown: they carry no per-screen surface a custom role
// could hide, and dropping them would strand the caller.

// CuratedNavItem is one resolved rail row: the underlying route + label + icon (carried through from
// the static NAV), plus the resolved surface mode for the screen it addresses (or null when the
// route has no surface association) and whether it is shown read-only because of the escape hatch.
export interface CuratedNavItem {
  route: string;
  label: string;
  icon: string;
  activeFor?: string[];
  // The surface mode for the screen this route addresses, or null when the route has no surface
  // association (Overview and the system/planning screens). Carried so the rail can mark a
  // read-only item (a screen the role can see but not edit) distinctly from an editable one.
  surface: SurfaceMode | null;
  // True when this item is only present because the SHOW-ALL escape hatch is on (the role would
  // otherwise have hidden it). The rail renders these with a read-only affordance so the caller
  // understands they have stepped outside their curated surface.
  viaShowAll: boolean;
}

// A nav item, as the curator needs it: the route fields plus the surface screen id it addresses (or
// undefined for an always-shown route). This is the shape shell/nav.ts passes in, so the pure
// curation logic here has no dependency on the rail's NavGroup structure.
export interface CuratableNavItem {
  route: string;
  label: string;
  icon: string;
  activeFor?: string[];
  // The surface SCREEN id this route addresses (a SCREEN_WRITE_CAPABILITY key), or undefined for a
  // route with no per-screen surface (Overview / the system screens), which is always shown.
  surfaceScreen?: string;
}

// curateNavItems applies the caller's surface to a flat list of nav items, returning the items to
// SHOW with their resolved surface mode. The rule:
//   - a route with NO surface association is always shown (surface: null);
//   - a route whose surface is "read" or "edit" is shown with that mode;
//   - a route whose surface is "hidden" is DROPPED, unless showAll is on, in which case it is shown
//     read-only and flagged viaShowAll so the rail can mark it as outside the curated surface.
// Pure over (items, surface, showAll); the surface map is resolveSurface's output (a built-in role's
// derived surface never hides anything, so a built-in caller sees every item regardless of showAll).
export function curateNavItems(
  items: CuratableNavItem[],
  surface: Record<string, SurfaceMode>,
  showAll: boolean,
): CuratedNavItem[] {
  const out: CuratedNavItem[] = [];
  for (const item of items) {
    // A route with no surface association is always shown (it carries no per-screen surface a role
    // could hide). surface stays null so the rail does not mark it read-only/edit.
    if (item.surfaceScreen === undefined) {
      out.push(toCurated(item, null, false));
      continue;
    }
    const mode = surface[item.surfaceScreen] ?? "read";
    if (mode === "hidden") {
      // Hidden by the role's surface: drop it, unless the escape hatch is on, in which case show it
      // read-only and flag it as reached via show-all (the engine still gates any write).
      if (showAll) out.push(toCurated(item, "read", true));
      continue;
    }
    out.push(toCurated(item, mode, false));
  }
  return out;
}

function toCurated(item: CuratableNavItem, surface: SurfaceMode | null, viaShowAll: boolean): CuratedNavItem {
  return {
    route: item.route,
    label: item.label,
    icon: item.icon,
    ...(item.activeFor !== undefined ? { activeFor: item.activeFor } : {}),
    surface,
    viaShowAll,
  };
}

// hasCuratedHidden reports whether the caller's surface would hide ANY surface-bearing nav item, so
// the rail only offers the "show all" escape hatch when it is meaningful (a built-in caller, whose
// derived surface hides nothing, never sees the escape hatch). Pure over (items, surface).
export function hasCuratedHidden(items: CuratableNavItem[], surface: Record<string, SurfaceMode>): boolean {
  for (const item of items) {
    if (item.surfaceScreen === undefined) continue;
    if ((surface[item.surfaceScreen] ?? "read") === "hidden") return true;
  }
  return false;
}

// curatedNavForCaller is the live convenience the shell calls: it resolves the caller's surface
// (from the built-in role or the custom role) and curates the items. A null caller (whoami pending)
// gets the FULL rail (no surface to curate by yet), so the rail is never mistakenly emptied before
// the role is known.
export function curatedNavForCaller(
  items: CuratableNavItem[],
  caller: Caller | null,
  showAll: boolean,
): CuratedNavItem[] {
  if (!caller) {
    // No resolved role yet: show everything read-as-is (no curation, no show-all marking).
    return items.map((item) => toCurated(item, item.surfaceScreen === undefined ? null : "read", false));
  }
  const surface = resolveSurface(caller.role, caller.customRole ?? null);
  return curateNavItems(items, surface, showAll);
}

// callerHasCuratedHidden is the live companion to hasCuratedHidden: does this caller's surface hide
// any rail item (so the escape hatch is worth offering). A null caller hides nothing.
export function callerHasCuratedHidden(items: CuratableNavItem[], caller: Caller | null): boolean {
  if (!caller) return false;
  const surface = resolveSurface(caller.role, caller.customRole ?? null);
  return hasCuratedHidden(items, surface);
}
