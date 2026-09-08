// Validate the console VIEW MODE layer: the managerial <-> technical ("shiny") skin, its
// persistence + role-default resolution, the per-role landing, and the curated-nav surface
// shaping with its show-all escape hatch (src/lib/view-mode.ts, plus the two overview framings in
// src/screens/overview.ts). Run with: node test/validate-view-mode.ts
//
// The view-mode layer is PRESENTATION only and carries NO authority (the capability set is the sole
// authority; the engine is always the enforcement point). These vectors therefore prove the four
// behaviours the build names, and pin the honesty/safety floors that make the curation safe:
//
//   1. VIEW MODE PERSISTS + BOTH FRAMINGS RENDER:
//      - getStoredViewMode / setViewMode / clearViewMode round-trip a per-user override through a
//        stateful localStorage shim, and resolveViewMode / resolveViewModeForCaller resolve every
//        (role-default x stored-override) combination, with a stored choice winning over the role
//        default and a null caller never faking an executive skin.
//      - buildExecutiveOverview AND buildOverview both RENDER from the SAME synthetic OverviewData
//        (a real DOM shim runs the production builders): the executive framing renders its
//        plain-English answer cards, the technical framing renders the dashboard and crucially NOT
//        the executive cards, so the two are distinct framings of one honest source.
//
//   2. LANDING RESOLVES PER ROLE: landingRoute maps a surface-id to its route (unknown -> "/"), and
//      landingRouteForCaller lands a built-in role on "/" (Overview) and a custom role on its
//      declared landing screen's route.
//
//   3. CURATED NAV HONOURS SURFACE: curateNavItems / curatedNavForCaller drop a HIDDEN surface item,
//      show a read/edit item with its mode, and always show a route with no surface association; a
//      built-in caller (whose derived surface hides nothing) sees every item.
//
//   4. THE ESCAPE HATCH: with showAll on, a hidden item returns READ-ONLY and flagged viaShowAll
//      (the full rail, read-only); hasCuratedHidden / callerHasCuratedHidden report whether the
//      escape hatch is even worth offering (false for a built-in caller).
//
// Every section carries a negative control that would fail if the assertion were vacuous.

// ---------------------------------------------------------------------------
// A stateful localStorage + DOM shim, installed on globalThis BEFORE the modules under test
// are imported (view-mode.ts reads localStorage at call time; the overview builders create elements
// via document.createElement). The shim is the shared test/dom-shim.ts (the canonical source every
// validator imports); it RUNS the production code, it never re-implements it. installDomShim wires a
// real in-memory localStorage, so the persistence assertions exercise a real get/set/remove round-trip.
// ---------------------------------------------------------------------------

// Static imports (the codebase test idiom). They are hoisted and execute before the test body; none
// of these modules touches a DOM/localStorage global at module-eval time, so the shim installed
// below (before any of them is CALLED) is in place in time. Types are imported type-only.
import {
  isViewMode, getStoredViewMode, setViewMode, clearViewMode, resolveViewMode,
  resolveViewModeForCaller, roleDefaultViewMode,
  landingRoute, landingRouteForCaller, SURFACE_ROUTE, STORAGE_KEY,
  curateNavItems, curatedNavForCaller, hasCuratedHidden, callerHasCuratedHidden,
  type CuratableNavItem,
} from "../src/lib/view-mode.ts";
import {
  buildExecutiveOverview,
  buildOverview,
  executiveAnswers,
  summariseFleet,
  type OverviewData,
  type ExecAnswer,
} from "../src/screens/overview.ts";
import { flatNav } from "../src/shell/nav.ts";
import {
  resolveSurface, builtinPreset,
  type CustomRole, type SurfaceMode, type Capability,
} from "../src/lib/identity.ts";
import type { Caller } from "../src/api.ts";
import { installDomShim, type ShimNode } from "./dom-shim.ts";

// The DOM + stateful localStorage shim is the shared test/dom-shim.ts (installDomShim installs a
// document/window/navigator and a real in-memory localStorage that round-trips writes and reads).
// ShimNode is imported for the rendered-tree casts below. The persistence assertions read the backing
// store through the installed localStorage global (the same MemoryStorage the libs under test write).

// Install the shim BEFORE any imported function is CALLED. The imports above are hoisted and execute
// first, but none of these modules touches a DOM/localStorage global at module-eval time (verified:
// overview.ts imports cleanly with no shim), so installing here -- before the test body calls any of
// them -- is sufficient. view-mode.ts reads localStorage only at call time; the overview builders
// touch document only at call time.
installDomShim();

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq<T>(label: string, got: T, want: T): void {
  const cond = got === want;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// Synthetic callers + a synthetic OverviewData the two framings render from.
// ---------------------------------------------------------------------------

// A built-in OWNER caller: no customRole, so its presentation default is "technical" and its derived
// surface hides nothing (the broadest built-in).
const ownerCaller: Caller = {
  method: "access", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false,
};

// A built-in VIEWER caller (the least-privileged built-in): still "technical", still hides nothing
// (built-ins never hide a screen; that is a custom-role nicety).
const viewerCaller: Caller = {
  method: "access", email: "viewer@example.com", role: "viewer", groups: [], isOnlyOwner: false,
};

// An executive custom role: presentation "shiny", lands on the reports surface, and HIDES the
// operational screens (downpipes/restore/notify) so the curated rail is shaped to a board read.
const execRole: CustomRole = {
  name: "board-reader",
  label: "Board reader",
  capabilities: ["downpipe.read", "audit.read", "reports.read", "posture.read", "restore.dryrun", "roles.read"] as Capability[],
  surface: {
    downpipes: "hidden",
    restore: "hidden",
    notify: "hidden",
    reports: "read",
    posture: "read",
    audit: "read",
  } as Record<string, SurfaceMode>,
  presentation: "shiny",
  landing: "reports",
  createdBy: "owner@example.com",
  createdAt: "2026-06-09T00:00:00.000Z",
};
// A caller on that custom role. The engine pins role to the "viewer" floor for a custom-role holder;
// the custom role's capability set + surface + presentation are the real authority/skin.
const execCaller: Caller = {
  method: "access", email: "ceo@example.com", role: "viewer", groups: [], isOnlyOwner: false,
  customRole: execRole, customCapabilities: execRole.capabilities,
};

// makeOverviewData builds a minimally-real OverviewData. The framings read fleet derivation from
// history+downpipes; here the fleet is EMPTY (no downpipes, no runs) so the technical framing takes
// its light empty-fleet path (no heavy windowed table / topology / cost embeds) while still
// rendering its tiles + grid, and the executive framing still renders all five answer cards (the
// answers render from the data regardless of fleet size). Every settled field is ok so no branch
// throws; the values are honest, benign shapes copied from api.ts.
function makeOverviewData(): OverviewData {
  return {
    health: { ok: true, value: { ok: true, service: "downpipe engine" } },
    status: {
      ok: true,
      value: {
        service: "downpipe engine",
        engineVersion: "0.0.0",
        signerConfigured: true,
        breakGlassConfigured: true,
        operationalConfigured: { public: true, private: true },
        destConfigured: true,
        destKind: "r2",
        updateChannelConfigured: true,
        licenceConfigured: true,
        downpipeCount: 0,
        ready: true,
      },
    },
    licence: { ok: true, value: { tier: "community", valid: false } },
    updates: { ok: true, value: { configured: true, verified: true, currentVersion: "0.0.0" } },
    history: { ok: true, value: {} },
    downpipes: { ok: true, value: [] },
    drillEvidence: { ok: true, value: [] },
    audit: { ok: true, value: [] },
    // NEW CONTRACT (needs-attention-never-empty fix): OverviewData now carries the
    // settled restore-approvals inbox so the needs-attention item renders only on a
    // REAL pending count (> 0), never as a standing prompt. Empty here = no pending
    // approvals, matching the rest of this calm synthetic snapshot.
    approvals: { ok: true, value: [] },
    // Source discovery feeds the Cloudflare-coverage hero. With an empty fleet (no downpipes), this
    // benign shape exercises the added/unadded states without covered ones: one bound KV binding and
    // the Workers token source added (both render "added"); the rest render "not added". The engine
    // advertises every token adapter, so none reads "not on this engine".
    discovery: {
      ok: true,
      value: {
        bound: { kv: ["KV_MAIN"], r2: [], d1: [], secrets: [] },
        tokenPresent: true,
        workersSupported: true,
        streamSupported: true,
        imagesSupported: true,
        artifactsSupported: true,
        cfConfigSurfaces: [{ id: "zone-settings", label: "Zone settings", category: "zone", scope: "zone", restoreTier: "api" }],
        addedSources: ["workers"],
      },
    },
  };
}

const noopCb = { onDrillFleet: () => {}, announce: (_: string) => {} };

// ============================================================================
// 1. VIEW MODE PERSISTS (getStored / set / clear / resolve over role-default x override)
// ============================================================================
console.log("\n-- 1. view-mode persistence + resolution --");

// isViewMode guards a stored / supplied value.
ok("isViewMode accepts 'technical'", isViewMode("technical"));
ok("isViewMode accepts 'shiny'", isViewMode("shiny"));
ok("isViewMode rejects a bogus string (negative control)", !isViewMode("fancy"));
ok("isViewMode rejects null", !isViewMode(null));

// No override stored at the start: getStoredViewMode reads null (the meaningful "user has not
// flipped the toggle" state, distinct from a concrete 'technical').
localStorage.clear();
eq("no stored override reads null", getStoredViewMode(), null);

// setViewMode persists a per-user override that getStoredViewMode reads back (a real round-trip).
setViewMode("shiny");
eq("setViewMode('shiny') persists and reads back", getStoredViewMode(), "shiny");
eq("the override landed in the backing store under the view-mode key", localStorage.getItem(STORAGE_KEY), "shiny");
setViewMode("technical");
eq("setViewMode('technical') overwrites the override", getStoredViewMode(), "technical");

// clearViewMode removes the override so the caller falls back to the role default (null again).
clearViewMode();
eq("clearViewMode removes the override (back to null)", getStoredViewMode(), null);

// A corrupted backing value reads as no-override (the guard rejects it), never a broken skin.
localStorage.setItem(STORAGE_KEY, "garbage");
eq("a corrupted stored value reads as no override", getStoredViewMode(), null);
localStorage.clear();

// resolveViewMode: a stored override WINS over the role default; absent one, the role default
// applies. This is the single resolution rule the shell reads on every navigation.
eq("resolve: no override -> role default (technical)", resolveViewMode("technical", null), "technical");
eq("resolve: no override -> role default (shiny)", resolveViewMode("shiny", null), "shiny");
eq("resolve: stored 'technical' WINS over a 'shiny' role default", resolveViewMode("shiny", "technical"), "technical");
eq("resolve: stored 'shiny' WINS over a 'technical' role default", resolveViewMode("technical", "shiny"), "shiny");
// Negative control: if the override were ignored, this would resolve to the role default 'shiny'.
ok("control: a stored override genuinely overrides (not the role default)", resolveViewMode("shiny", "technical") !== "shiny");

// roleDefaultViewMode: a built-in role defaults to technical; a custom role uses its declared
// presentation; a null caller (whoami pending) defaults to technical (never a faked executive skin).
eq("roleDefault: owner (built-in) -> technical", roleDefaultViewMode(ownerCaller), "technical");
eq("roleDefault: a shiny custom role -> shiny", roleDefaultViewMode(execCaller), "shiny");
eq("roleDefault: null caller -> technical", roleDefaultViewMode(null), "technical");

// resolveViewModeForCaller: the live read combining the role default with the stored override.
localStorage.clear();
eq("forCaller: owner, no override -> technical", resolveViewModeForCaller(ownerCaller), "technical");
eq("forCaller: shiny custom role, no override -> shiny (lands in shiny without flipping)", resolveViewModeForCaller(execCaller), "shiny");
eq("forCaller: null caller, no override -> technical (no faked executive skin)", resolveViewModeForCaller(null), "technical");
// A stored override flips both directions, even against the role default.
setViewMode("technical");
eq("forCaller: a shiny role with a stored 'technical' override -> technical", resolveViewModeForCaller(execCaller), "technical");
setViewMode("shiny");
eq("forCaller: a built-in role with a stored 'shiny' override -> shiny", resolveViewModeForCaller(ownerCaller), "shiny");
localStorage.clear();

// ============================================================================
// 2. BOTH FRAMINGS RENDER (from the SAME OverviewData) and are DISTINCT
// ============================================================================
console.log("\n-- 2. both framings render from the same data --");

const data = makeOverviewData();

// The EXECUTIVE (shiny) framing renders its plain-English answer cards. There are exactly five
// questions (protected / recoverable / compliant / access / cost), each one ov-exec-card.
const exec = buildExecutiveOverview(data, noopCb) as unknown as ShimNode;
const execCards = exec.querySelectorAll(".ov-exec-card");
ok("executive framing renders ov-exec-card answer cards", execCards.length > 0);
eq("executive framing renders exactly five plain-English answers", execCards.length, 5);
// The five questions are present in the rendered text (honest plain-English answers, not jargon).
const execText = exec.textContent;
ok("executive answers include 'Are we protected?'", execText.includes("Are we protected?"));
ok("executive answers include the recoverability question", execText.includes("Can we get it back?"));
ok("executive answers include the evidence/compliance question", execText.includes("Is the evidence in place?"));
ok("executive answers include the access question", execText.includes("Who can touch this?"));
ok("executive answers include the cost question", execText.includes("What does it cost?"));

// Both framings lead with the Cloudflare-coverage hero: the nine advert surfaces as a grid. It reads the
// SAME data, so the two framings cannot disagree about coverage.
ok("executive framing renders the Cloudflare-coverage grid", exec.querySelectorAll(".ov-coverage-grid").length > 0);
eq("executive coverage grid renders all nine surface tiles", exec.querySelectorAll(".surf").length, 9);
ok("coverage hero is titled 'Your Cloudflare account'", execText.includes("Your Cloudflare account"));
ok("coverage summary states the nine-surface total", execText.includes("9 surfaces"));

// The TECHNICAL framing renders the dashboard from the SAME data, and crucially does NOT render the
// executive answer cards (it is a distinct framing). The stat tiles + the two-column grid are its
// shape; the executive card class is absent.
const tech = buildOverview(data, noopCb) as unknown as ShimNode;
const techExecCards = tech.querySelectorAll(".ov-exec-card");
eq("technical framing renders NO executive answer cards (distinct framing)", techExecCards.length, 0);
// statGrid renders class "stat-grid" wrapping individual "stat" tiles (components/stat-tiles.ts):
// both are the technical dashboard's shape and are genuinely present in this render.
ok("technical framing renders the stat-tile grid (its dashboard shape)", tech.querySelectorAll(".stat-grid").length > 0);
ok("technical framing renders the individual stat tiles", tech.querySelectorAll(".stat").length > 0);
ok("technical framing renders the two-column overview grid", tech.querySelectorAll(".ov-grid").length > 0);
ok("technical framing renders the Cloudflare-coverage grid", tech.querySelectorAll(".ov-coverage-grid").length > 0);
eq("technical coverage grid renders all nine surface tiles", tech.querySelectorAll(".surf").length, 9);
// Both framings lead with the SAME honest configuration read (here: ready), so they cannot disagree
// about the underlying state. The recovery question reads "not yet proven" in both since no run has
// happened; the technical framing surfaces that through its recovery tile/posture copy.
ok("technical framing produced a non-empty render", tech.childNodes.length > 0);
ok("executive framing produced a non-empty render", exec.childNodes.length > 0);

// ============================================================================
// 2b. OBS-CONSOLE-1: a PARTIAL engine response degrades, the tiles never throw
// ============================================================================
// A settled result can be ok:true yet carry an undefined/partial value (the type promises the
// shape; the wire does not). The overview tiles + fleet roll-up must render an honest
// placeholder rather than throwing on .tier / Object.keys and blanking the whole dashboard.
console.log("\n-- 2b. partial engine response degrades (tiles never throw) --");
{
  const partial = makeOverviewData();
  // licence settled ok:true but the value is undefined (a truncated/partial read).
  (partial as { licence: unknown }).licence = { ok: true, value: undefined };
  // history + downpipes settled ok:true but undefined (Object.keys/values must be guarded).
  (partial as { history: unknown }).history = { ok: true, value: undefined };
  (partial as { downpipes: unknown }).downpipes = { ok: true, value: undefined };

  let techThrew = false;
  let partTech: ShimNode | null = null;
  try {
    partTech = buildOverview(partial, noopCb) as unknown as ShimNode;
  } catch {
    techThrew = true;
  }
  ok("technical framing does NOT throw on a partial (undefined-value) response", !techThrew);
  ok("partial technical framing still renders the stat-tile grid", partTech !== null && partTech.querySelectorAll(".stat").length > 0);
  // The coverage hero degrades too: with the downpipe list unreadable it still renders its nine tiles
  // (every surface an honest 'unknown'), never throwing or vanishing.
  ok("partial technical framing still renders all nine coverage tiles", partTech !== null && partTech.querySelectorAll(".surf").length === 9);
  // The licence tile defaults the missing tier to a Community fail-open reading, never blank/NaN.
  ok("partial licence tile degrades to an honest 'Community' reading", (partTech?.textContent.includes("Community") ?? false));
  ok("partial licence tile reads fail-open (neutral), not a false Active", (partTech?.textContent.includes("Fail-open") ?? false));

  let execThrew = false;
  try {
    buildExecutiveOverview(partial, noopCb);
  } catch {
    execThrew = true;
  }
  ok("executive framing does NOT throw on a partial (undefined-value) response", !execThrew);
}

// ============================================================================
// 3. LANDING RESOLVES PER ROLE
// ============================================================================
console.log("\n-- 3. per-role landing --");

// landingRoute maps a surface-id to its route. Every SCREEN_WRITE_CAPABILITY key has a route.
eq("landingRoute('downpipes') -> /downpipes", landingRoute("downpipes"), "/downpipes");
eq("landingRoute('reports') -> /reports", landingRoute("reports"), "/reports");
eq("landingRoute('posture') -> /security", landingRoute("posture"), "/security");
eq("landingRoute('people') -> /access/roles", landingRoute("people"), "/access/roles");
eq("landingRoute('expiry') -> /credentials", landingRoute("expiry"), "/credentials");
// An unknown landing id falls back to "/" (Overview): always safe, never a dead end.
eq("landingRoute(unknown) -> / (safe fallback)", landingRoute("no-such-screen"), "/");
// SURFACE_ROUTE is the bridge map; its reports entry is the route the executive role lands on.
eq("SURFACE_ROUTE['reports'] is /reports", SURFACE_ROUTE.reports, "/reports");

// landingRouteForCaller: a built-in role lands on Overview; a custom role lands on its declared
// landing screen's route; a null caller lands on Overview.
eq("landingForCaller: owner (built-in) lands on / (Overview)", landingRouteForCaller(ownerCaller), "/");
eq("landingForCaller: viewer (built-in) lands on / (Overview)", landingRouteForCaller(viewerCaller), "/");
eq("landingForCaller: the board-reader custom role lands on /reports", landingRouteForCaller(execCaller), "/reports");
eq("landingForCaller: null caller lands on / (Overview)", landingRouteForCaller(null), "/");
// Negative control: the executive landing is NOT the Overview default (it is curated to its role).
ok("control: the executive lands somewhere OTHER than Overview", landingRouteForCaller(execCaller) !== "/");

// ============================================================================
// 4. CURATED NAV HONOURS SURFACE
// ============================================================================
console.log("\n-- 4. curated nav honours surface --");

const items: CuratableNavItem[] = flatNav();
ok("flatNav yields the full rail item set", items.length > 0);

// A built-in OWNER caller: its derived surface hides nothing, so every rail item is shown.
const ownerCurated = curatedNavForCaller(items, ownerCaller, false);
eq("built-in owner sees EVERY rail item (nothing hidden)", ownerCurated.length, items.length);
ok("built-in owner: no item is flagged via show-all", ownerCurated.every((i) => !i.viaShowAll));
// hasCuratedHidden over the owner's surface is false, so the escape hatch is not offered.
ok("built-in owner: callerHasCuratedHidden is false (no escape hatch needed)", !callerHasCuratedHidden(items, ownerCaller));

// The executive custom role HIDES the operational screens; the curated rail (without show-all) drops
// exactly those, while always-shown routes (Overview / Map / Runs / Keys / Settings / Licence /
// Costs) and the role's read screens (reports / posture / audit) remain.
const execCuratedClosed = curatedNavForCaller(items, execCaller, false);
const closedRoutes = new Set(execCuratedClosed.map((i) => i.route));
ok("exec curated rail drops the hidden Downpipes item", !closedRoutes.has("/downpipes"));
ok("exec curated rail drops the hidden Restore item", !closedRoutes.has("/restore"));
ok("exec curated rail drops the hidden Notifications item", !closedRoutes.has("/notifications"));
ok("exec curated rail KEEPS Reports (a read surface)", closedRoutes.has("/reports"));
ok("exec curated rail KEEPS Overview (no surface association, always shown)", closedRoutes.has("/"));
ok("exec curated rail KEEPS Map (no surface association, always shown)", closedRoutes.has("/map"));
ok("exec curated rail KEEPS Keys (no surface association, always shown)", closedRoutes.has("/keys"));
// The curated rail is genuinely SMALLER than the full rail (the curation actually shaped it).
ok("exec curated rail is smaller than the full rail (curation applied)", execCuratedClosed.length < items.length);

// curateNavItems directly over a hand-built surface: hidden dropped, read/edit shown with mode, a
// no-surface item always shown. This pins the rule without relying on the role-derived surface.
const handItems: CuratableNavItem[] = [
  { route: "/", label: "Overview", icon: "" }, // no surfaceScreen: always shown
  { route: "/downpipes", label: "Downpipes", icon: "", surfaceScreen: "downpipes" },
  { route: "/reports", label: "Reports", icon: "", surfaceScreen: "reports" },
  { route: "/access", label: "Access", icon: "", surfaceScreen: "access" },
];
const handSurface: Record<string, SurfaceMode> = { downpipes: "hidden", reports: "read", access: "edit" };
const handClosed = curateNavItems(handItems, handSurface, false);
const handByRoute = new Map(handClosed.map((i) => [i.route, i]));
ok("curateNavItems: a hidden surface item is dropped (no show-all)", !handByRoute.has("/downpipes"));
ok("curateNavItems: a no-surface item is always shown (surface null)", handByRoute.get("/")?.surface === null);
eq("curateNavItems: a read surface item is shown read", handByRoute.get("/reports")?.surface, "read");
eq("curateNavItems: an edit surface item is shown edit", handByRoute.get("/access")?.surface, "edit");
// Negative control: a surface item is NOT carried with surface null (that is reserved for
// no-surface routes), so its mode is the resolved surface mode, not null.
ok("control: a surface-bearing item does not read surface null", handByRoute.get("/reports")?.surface !== null);

// activeFor conditional spread: it is preserved on the output when supplied and absent (not present
// as undefined) when omitted. This pins the toCurated spread invariant.
const activeForItems: CuratableNavItem[] = [
  { route: "/reports", label: "Reports", icon: "", surfaceScreen: "reports", activeFor: ["/reports/all"] },
  { route: "/access", label: "Access", icon: "", surfaceScreen: "access" },
];
const activeForSurface: Record<string, SurfaceMode> = { reports: "read", access: "edit" };
const activeForCurated = curateNavItems(activeForItems, activeForSurface, false);
const activeForByRoute = new Map(activeForCurated.map((i) => [i.route, i]));
eq(
  "curateNavItems: activeFor is preserved when supplied",
  activeForByRoute.get("/reports")?.activeFor?.[0],
  "/reports/all",
);
ok(
  "curateNavItems: activeFor key is absent (not undefined) when omitted",
  activeForByRoute.get("/access") !== undefined && !("activeFor" in (activeForByRoute.get("/access") as object)),
);

// hasCuratedHidden reports whether ANY surface item would be hidden by the surface.
ok("hasCuratedHidden true when the surface hides an item", hasCuratedHidden(handItems, handSurface));
ok("hasCuratedHidden false when the surface hides nothing", !hasCuratedHidden(handItems, { downpipes: "read", reports: "read", access: "edit" }));

// ============================================================================
// 5. THE SHOW-ALL ESCAPE HATCH
// ============================================================================
console.log("\n-- 5. the show-all escape hatch --");

// With show-all ON, the executive's hidden items RETURN, read-only and flagged viaShowAll, so the
// full rail is reachable read-only (curation can never trap a caller or hide evidence).
const execCuratedOpen = curatedNavForCaller(items, execCaller, true);
const openByRoute = new Map(execCuratedOpen.map((i) => [i.route, i]));
ok("show-all: the full rail returns (every item present)", execCuratedOpen.length === items.length);
ok("show-all: the previously hidden Downpipes item returns", openByRoute.has("/downpipes"));
ok("show-all: a returned hidden item is flagged viaShowAll", openByRoute.get("/downpipes")?.viaShowAll === true);
eq("show-all: a returned hidden item is shown READ-ONLY", openByRoute.get("/downpipes")?.surface, "read");
// A read screen the role already shows is NOT marked viaShowAll (it was never hidden).
ok("show-all: a never-hidden read screen is not flagged viaShowAll", openByRoute.get("/reports")?.viaShowAll === false);
// An always-shown no-surface route is never flagged viaShowAll either.
ok("show-all: a no-surface route is not flagged viaShowAll", openByRoute.get("/")?.viaShowAll === false);
// callerHasCuratedHidden is true for the executive (so the rail offers the escape hatch at all).
ok("escape hatch offered: callerHasCuratedHidden true for the executive", callerHasCuratedHidden(items, execCaller));

// curateNavItems show-all over the hand-built surface: the hidden item returns read-only+viaShowAll.
const handOpen = curateNavItems(handItems, handSurface, true);
const handOpenByRoute = new Map(handOpen.map((i) => [i.route, i]));
ok("curateNavItems show-all: hidden item returns", handOpenByRoute.has("/downpipes"));
eq("curateNavItems show-all: returned hidden item is read-only", handOpenByRoute.get("/downpipes")?.surface, "read");
ok("curateNavItems show-all: returned hidden item is viaShowAll", handOpenByRoute.get("/downpipes")?.viaShowAll === true);
// Negative control: show-all does NOT spuriously flag the read/edit items it never hid.
ok("control: show-all leaves a never-hidden edit item un-flagged", handOpenByRoute.get("/access")?.viaShowAll === false);

// ============================================================================
// 6. A NULL CALLER + a built-in preset (resolution safety floors)
// ============================================================================
console.log("\n-- 6. null-caller + preset safety floors --");

// A null caller (whoami pending) gets the FULL rail, never a mistakenly-emptied one, and no item is
// marked read-only/show-all (the role is not known yet).
const nullCurated = curatedNavForCaller(items, null, false);
eq("null caller sees the full rail (never emptied)", nullCurated.length, items.length);
ok("null caller: no item flagged viaShowAll", nullCurated.every((i) => !i.viaShowAll));
ok("null caller: callerHasCuratedHidden is false", !callerHasCuratedHidden(items, null));

// resolveSurface for a built-in role hides nothing (sanity: the curation's safety rests on this).
const ownerSurface = resolveSurface("owner", null);
ok("resolveSurface(owner) hides no screen", Object.values(ownerSurface).every((m) => m !== "hidden"));
// A built-in preset is a valid starting point: shiny presentation is never the default for a preset
// (the built-in preset is always technical; shiny is a custom-role choice).
const ownerPreset = builtinPreset("owner");
eq("builtinPreset(owner) defaults to the technical skin", ownerPreset.presentation, "technical");

// ============================================================================
// 7. THE EXECUTIVE ENGINE-OUTAGE COLLAPSE PATH (3+ same-cause unknowns -> one card)
// ============================================================================
console.log("\n-- 7. executive engine-outage collapse --");

// When 3+ answers are unknown because the SAME engine reads failed (downpipes + history + status all
// not ok), buildExecutiveOverview must collapse them into a SINGLE "could not reach the engine" card
// rather than four restatements of one root cause. This is the most safety-critical moment (an engine
// outage); a bug here could silence real failures or render misleading output. The synthetic snapshot
// above has every field ok, so flip exactly the three engine reads that drive the collapse.
function makeOutageData(): OverviewData {
  const d = makeOverviewData();
  return {
    ...d,
    downpipes: { ok: false, error: new Error("list downpipes: 500") },
    history: { ok: false, error: new Error("history: 500") },
    status: { ok: false, error: new Error("status: 500") },
  };
}

const outage = buildExecutiveOverview(makeOutageData(), noopCb) as unknown as ShimNode;
// (a) The single collapse card is present (the honest "could not reach the engine" region). The shim's
// querySelector handles class/id/tag selectors, so match the card by its text rather than its aria
// attribute: the collapse card carries the "Could not reach the engine" heading.
ok("collapse path renders the single unreachable card", outage.textContent.includes("Could not reach the engine"));
// (b) Exactly the non-unknown answers render as answer cards. protected/recoverable/cost/compliant
// are the four engine-read answers that collapse (recoverable AND cost both fail on history); only
// the access answer (a whoami matter, not an engine read) survives, so exactly ONE answer card shows.
const outageCards = outage.querySelectorAll(".ov-exec-card");
eq("collapse path renders only the non-unknown answer cards (access survives)", outageCards.length, 1);
ok("the surviving answer card is the access answer", outage.textContent.includes("Who can touch this?"));
// (c) The correct unknown count is shown: four engine-read answers are unreadable, so the card says
// "4 of the 5 answers cannot be read right now".
ok("the unreachable card states the correct unknown count (4 of 5)", outage.textContent.includes("4 of the 5 answers cannot be read"));
// Negative control: the four collapsed questions are NOT each restated as their own card; the
// "Are we protected?" question text must not appear (it folded into the single collapse card).
ok("control: a collapsed question is not restated as its own card", !outage.textContent.includes("Are we protected?"));

// ============================================================================
// 8. THE PER-ANSWER UNKNOWN BRANCHES (an unreadable source -> tone/verdict 'Unknown')
// ============================================================================
// Each answer-computation function has an honest unknown branch taken when its engine read failed.
// These pure functions are exercised directly (DOM-free) so a regression that emits a confident tone
// on a failed read is caught here, not only through the rendered collapse path.
console.log("\n-- 8. per-answer unknown branches --");

function answerFor(key: string, data: OverviewData): ExecAnswer {
  const found = executiveAnswers(data, summariseFleet(data), { state: "unknown" }).find((a) => a.key === key);
  if (!found) throw new Error(`no answer with key ${key}`);
  return found;
}

// protected -> unknown when the downpipe list cannot be read.
{
  // OverviewData is readonly, so the variant is BUILT rather than mutated after the fact.
  const d = { ...makeOverviewData(), downpipes: { ok: false as const, error: new Error("list downpipes: 500") } };
  const a = answerFor("protected", d);
  eq("protected unknown branch tone", a.tone, "unknown");
  eq("protected unknown branch verdict", a.verdict, "Unknown");
}

// recoverable -> unknown when the run history cannot be read.
{
  // OverviewData is readonly, so the variant is BUILT rather than mutated after the fact.
  const d = { ...makeOverviewData(), history: { ok: false as const, error: new Error("history: 500") } };
  const a = answerFor("recoverable", d);
  eq("recoverable unknown branch tone", a.tone, "unknown");
  eq("recoverable unknown branch verdict", a.verdict, "Unknown");
}

// compliant -> unknown when the evidence source cannot be read.
{
  // OverviewData is readonly, so the variant is BUILT rather than mutated after the fact.
  const d = { ...makeOverviewData(), drillEvidence: { ok: false as const, error: new Error("evidence: 500") }, audit: { ok: false as const, error: new Error("audit: 500") }, status: { ok: false as const, error: new Error("status: 500") } };
  const a = answerFor("compliant", d);
  eq("compliant unknown branch tone", a.tone, "unknown");
  eq("compliant unknown branch verdict", a.verdict, "Unknown");
}

// access -> unknown when the access method cannot be determined.
{
  const a = executiveAnswers(makeOverviewData(), summariseFleet(makeOverviewData()), { state: "unknown" }).find((x) => x.key === "access");
  ok("access unknown branch present", a !== undefined);
  eq("access unknown branch tone", a?.tone, "unknown");
  eq("access unknown branch verdict", a?.verdict, "Unknown");
}

// cost -> unknown when the status (destination) source cannot be read.
{
  // OverviewData is readonly, so the variant is BUILT rather than mutated after the fact.
  const d = { ...makeOverviewData(), status: { ok: false as const, error: new Error("status: 500") }, history: { ok: false as const, error: new Error("history: 500") } };
  const a = answerFor("cost", d);
  eq("cost unknown branch tone", a.tone, "unknown");
  eq("cost unknown branch verdict", a.verdict, "Unknown");
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nVIEW-MODE VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
if (failures > 0) process.exit(1);
