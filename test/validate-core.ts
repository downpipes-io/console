// Validate the pure logic in the five core library modules:
//   src/lib/store.ts    -- get/set/subscribe state machine, signOut, clearSensitiveState
//   src/lib/router.ts   -- path/pattern matching, param extraction, unknown-route fallback
//   src/shell/nav.ts    -- isItemActive active-state derivation
//   src/lib/theme.ts    -- getThemePref / resolvedTheme / setThemePref resolution
//   src/lib/nav.ts      -- installNav bridge and navigate/goSignedOut delegation
//
// All tests exercise REAL production exports. No DOM rendering is tested here; every
// section exercises logic and state, with explicit negative controls that would pass
// vacuously if the assertion were wrong.
//
// Run with: node test/validate-core.ts

// ---------------------------------------------------------------------------
// Minimal stubs for the browser globals the production modules reference.
// The modules are imported server-side via Node; any DOM/browser API they
// reference at MODULE-EVAL time must be stubbed before the import.
// ---------------------------------------------------------------------------

// Stub localStorage (store.ts and theme.ts use it). We want a Map-backed stub
// so we can inspect and pre-populate values.
const localStorageStore: Map<string, string> = new Map();
(globalThis as Record<string, unknown>).localStorage = {
  getItem(k: string): string | null { return localStorageStore.get(k) ?? null; },
  setItem(k: string, v: string): void { localStorageStore.set(k, v); },
  removeItem(k: string): void { localStorageStore.delete(k); },
  clear(): void { localStorageStore.clear(); },
};

// Stub location (router.ts reads location.protocol / .pathname / .search / .hash in
// some code paths, and theme.ts has no direct location use). We set protocol to
// "https:" so the router stays in pathname mode, not hash mode.
(globalThis as Record<string, unknown>).location = {
  protocol: "https:",
  pathname: "/",
  search: "",
  hash: "",
  href: "https://localhost/",
};

// Stub window.matchMedia (resolvedTheme / theme.ts uses it).
(globalThis as Record<string, unknown>).window = {
  matchMedia: (query: string) => ({
    matches: query.includes("dark"),
    media: query,
    addListener: () => {},
    removeListener: () => {},
  }),
};

// Stub document (router.ts references document indirectly via window.addEventListener
// which is stubbed below; we stub the minimum theme.ts needs).
(globalThis as Record<string, unknown>).document = {
  documentElement: {
    getAttribute: () => null,
    setAttribute: () => {},
    removeAttribute: () => {},
  },
};

// Stub window.addEventListener / history for router.ts start() (we call resolve()
// directly in tests so these never fire; the stub prevents a ReferenceError at import
// or start() time).
(globalThis as Record<string, unknown>).history = {
  pushState: () => {},
  replaceState: () => {},
};
if (typeof (globalThis as Record<string, unknown>).window === "object") {
  (globalThis as Record<string, unknown>).window = {
    ...(globalThis as Record<string, unknown>).window as object,
    addEventListener: () => {},
    clearTimeout: () => {},
    setTimeout: () => 0,
  };
}

// ---------------------------------------------------------------------------
// Imports (after stubs so no ReferenceError at eval time)
// ---------------------------------------------------------------------------

import {
  getEngine,
  getEngineUrl,
  connect,
  getCaller,
  setCaller,
  isWhoamiAvailable,
  setWhoamiAvailable,
  getDownpipesCache,
  setDownpipesCache,
  getRunsCache,
  setRunsCache,
  getCeremony,
  setCeremony,
  clearSensitiveState,
  signOut,
} from "../src/lib/store.ts";

import {
  Router,
} from "../src/lib/router.ts";

// Split the internal helpers out of router.ts by testing them indirectly via the
// Router class (they are unexported); we verify them by observing RouteMatch output.

import { isItemActive, NAV } from "../src/shell/nav.ts";
import type { NavItem } from "../src/shell/nav.ts";

import {
  getThemePref,
  setThemePref,
  resolvedTheme,
  onThemeChange,
} from "../src/lib/theme.ts";

import {
  installNav,
  navigate,
  goSignedOut,
  onAuthenticated as navOnAuthenticated,
  signOut as navSignOut,
} from "../src/lib/nav.ts";

import type { Caller } from "../src/api.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let failures = 0;

function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function eq<T>(label: string, got: T, want: T): void {
  const cond = got === want;
  console.log(
    cond
      ? `  ok   ${label}`
      : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`,
  );
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// 1. STORE -- get/set/subscribe state machine
// ---------------------------------------------------------------------------
console.log("\n-- store: caller get/set --");

// Before any mutation the caller is null.
ok("getCaller() is null before set", getCaller() === null);

const testCaller: Caller = {
  method: "token",
  email: "alice@example.com",
  role: "owner",
  groups: [],
  isOnlyOwner: true,
};

setCaller(testCaller);
ok("getCaller() returns the value just set", getCaller() === testCaller);

// Setting null clears it.
setCaller(null);
ok("setCaller(null) clears the caller", getCaller() === null);

// Negative control: setCaller with a different object is reflected.
const anotherCaller: Caller = { method: "access", email: "bob@example.com", role: "viewer", groups: [], isOnlyOwner: false };
setCaller(anotherCaller);
ok("getCaller() is NOT the old caller after update", getCaller() !== testCaller);
ok("getCaller() is the new caller after update", getCaller() === anotherCaller);

console.log("\n-- store: whoami flag --");

ok("isWhoamiAvailable() is false before set", isWhoamiAvailable() === false);
setWhoamiAvailable(true);
ok("isWhoamiAvailable() is true after setWhoamiAvailable(true)", isWhoamiAvailable() === true);
setWhoamiAvailable(false);
ok("isWhoamiAvailable() is false after setWhoamiAvailable(false)", isWhoamiAvailable() === false);

// Negative control: toggling to false after true does not stay true.
setWhoamiAvailable(true);
setWhoamiAvailable(false);
ok("double-toggle: whoami returns false", isWhoamiAvailable() === false);

console.log("\n-- store: entity caches --");

ok("getDownpipesCache() is null before set", getDownpipesCache() === null);
setDownpipesCache([]);
ok("getDownpipesCache() returns the empty array after set", Array.isArray(getDownpipesCache()) && getDownpipesCache()!.length === 0);

// Negative control: null assignment clears the cache.
setDownpipesCache(null);
ok("setDownpipesCache(null) clears back to null", getDownpipesCache() === null);

ok("getRunsCache('x') is undefined before set", getRunsCache("x") === undefined);
setRunsCache("dp-01", []);
ok("getRunsCache('dp-01') returns the set value", Array.isArray(getRunsCache("dp-01")));
ok("getRunsCache('other') is still undefined (isolated key)", getRunsCache("other") === undefined);

console.log("\n-- store: ceremony (in-memory key material) --");

ok("getCeremony() is null before set", getCeremony() === null);

const fakeCeremony = { key: "abc" };
setCeremony(fakeCeremony);
ok("getCeremony() returns the set value", getCeremony() === fakeCeremony);

// clearSensitiveState nulls only ceremony, not caller.
setCaller(testCaller);
clearSensitiveState();
ok("clearSensitiveState() clears ceremony to null", getCeremony() === null);
ok("clearSensitiveState() does NOT clear caller", getCaller() === testCaller);

// Calling clearSensitiveState when ceremony is already null is a no-op.
clearSensitiveState();
ok("clearSensitiveState() on null ceremony is a no-op (no throw)", getCeremony() === null);

// Negative control: setCeremony after clearSensitiveState brings it back.
setCeremony(fakeCeremony);
ok("ceremony can be restored after clear", getCeremony() === fakeCeremony);

console.log("\n-- store: signOut --");

// Set every field to a non-null value, then confirm signOut clears them.
setCaller(testCaller);
setWhoamiAvailable(true);
setDownpipesCache([]);
setRunsCache("dp-02", []);
setCeremony({ k: 1 });
// connect() sets engine + engineUrl so we can confirm those are cleared too.
// Use a localhost URL so EngineClient does not throw on non-https.
connect("http://localhost:8787");
ok("engine is non-null after connect", getEngine() !== null);
ok("engineUrl is set after connect", getEngineUrl() !== null);

signOut();

ok("signOut: engine is null", getEngine() === null);
ok("signOut: caller is null", getCaller() === null);
ok("signOut: whoami is false", isWhoamiAvailable() === false);
ok("signOut: downpipes cache is null", getDownpipesCache() === null);
ok("signOut: ceremony is null", getCeremony() === null);
// engineUrl is deliberately KEPT by signOut (holds no secret; enables re-auth).
ok("signOut: engineUrl is KEPT (no secret held)", getEngineUrl() !== null);

// Negative control: a second signOut is safe AND changes nothing. The condition here used to be the
// literal `true`, so the line could not fail: a second signOut that threw would have crashed the file
// (which the verdict guard would catch), but one that quietly cleared engineUrl, or restored any of the
// six fields above, would have gone unnoticed. The state is captured and compared instead.
const afterFirstSignOut = JSON.stringify([getEngine(), getCaller(), isWhoamiAvailable(), getDownpipesCache(), getCeremony(), getEngineUrl()]);
signOut();
ok("second signOut is a no-op: every field it touches is exactly where the first left it", JSON.stringify([getEngine(), getCaller(), isWhoamiAvailable(), getDownpipesCache(), getCeremony(), getEngineUrl()]) === afterFirstSignOut);

// ---------------------------------------------------------------------------
// 2. ROUTER -- path<->pattern matching, params, fallback
// ---------------------------------------------------------------------------
console.log("\n-- router: known routes resolve --");

// We test the matching logic in isolation by creating a Router, wiring handlers,
// and calling navigate() which calls resolve() internally.

// Patch location for the router's current() method.
function setPath(p: string, search = ""): void {
  const loc = (globalThis as Record<string, unknown>).location as Record<string, string>;
  loc.pathname = p;
  loc.search = search;
  loc.hash = "";
}

function makeRouter(): {
  router: Router;
  lastMatch: import("../src/lib/router.ts").RouteMatch | null;
  afterEachMatch: import("../src/lib/router.ts").RouteMatch | null;
} {
  const result = {
    router: new Router(),
    lastMatch: null as import("../src/lib/router.ts").RouteMatch | null,
    afterEachMatch: null as import("../src/lib/router.ts").RouteMatch | null,
  };
  return result;
}

// ---- root "/" ----
setPath("/");
{
  const state = makeRouter();
  let hit = false;
  state.router.add("/", (m) => { hit = true; state.lastMatch = m; });
  state.router.add("/other", () => {});
  state.router.navigate("/");
  ok("root / resolves", hit);
  ok("root / has pattern '/'", state.lastMatch?.pattern === "/");
  ok("root / has no params", Object.keys(state.lastMatch?.params ?? {}).length === 0);
}

// ---- /downpipes ----
{
  setPath("/downpipes");
  const state = makeRouter();
  let hit = false;
  state.router.add("/", () => {});
  state.router.add("/downpipes", (m) => { hit = true; state.lastMatch = m; });
  state.router.navigate("/downpipes");
  ok("/downpipes resolves", hit);
  ok("/downpipes pattern is '/downpipes'", state.lastMatch?.pattern === "/downpipes");
}

// ---- /downpipes/:id -- param extraction ----
{
  setPath("/downpipes/dp-abc-123");
  const state = makeRouter();
  let hit = false;
  state.router.add("/downpipes/:id", (m) => { hit = true; state.lastMatch = m; });
  state.router.navigate("/downpipes/dp-abc-123");
  ok("/downpipes/:id resolves", hit);
  eq("/downpipes/:id extracts id param", state.lastMatch?.params.id ?? "", "dp-abc-123");
  ok("/downpipes/:id path is '/downpipes/dp-abc-123'", state.lastMatch?.path === "/downpipes/dp-abc-123");
}

// ---- /runs/:downpipeId/:index -- two params ----
{
  setPath("/runs/dp-xyz/7");
  const state = makeRouter();
  let hit = false;
  state.router.add("/runs/:downpipeId/:index", (m) => { hit = true; state.lastMatch = m; });
  state.router.navigate("/runs/dp-xyz/7");
  ok("/runs/:downpipeId/:index resolves", hit);
  eq("/runs/:downpipeId/:index extracts downpipeId", state.lastMatch?.params.downpipeId ?? "", "dp-xyz");
  eq("/runs/:downpipeId/:index extracts index", state.lastMatch?.params.index ?? "", "7");
}

// ---- onboarding/:step ----
{
  setPath("/onboarding/connect");
  const state = makeRouter();
  let stepHit = "";
  state.router.add("/onboarding/:step", (m) => { stepHit = m.params.step ?? ""; });
  state.router.navigate("/onboarding/connect");
  eq("/onboarding/:step extracts step=connect", stepHit, "connect");
}

// ---- /access/audit -- two-segment static path ----
{
  setPath("/access/audit");
  const state = makeRouter();
  let hit = false;
  state.router.add("/access", () => {});
  state.router.add("/access/audit", (m) => { hit = true; state.lastMatch = m; });
  state.router.navigate("/access/audit");
  ok("/access/audit resolves to its own pattern", hit);
  ok("/access/audit pattern is '/access/audit'", state.lastMatch?.pattern === "/access/audit");
}

// ---- unknown path falls back to notFound ----
console.log("\n-- router: unknown route falls back --");

{
  setPath("/not-a-real-screen");
  const state = makeRouter();
  let fallbackHit = false;
  let knownHit = false;
  state.router.add("/downpipes", () => { knownHit = true; });
  state.router.notFound((m) => { fallbackHit = true; state.lastMatch = m; });
  state.router.navigate("/not-a-real-screen");
  ok("unknown route triggers notFound handler", fallbackHit);
  ok("unknown route does NOT trigger a known handler", !knownHit);
  ok("unknown route fallback match has pattern '*'", state.lastMatch?.pattern === "*");
}

// ---- no fallback registered: no throw on unknown route ----
{
  setPath("/completely-unknown");
  const r = new Router();
  r.add("/downpipes", () => {});
  let threw = false;
  try { r.navigate("/completely-unknown"); } catch { threw = true; }
  ok("no notFound registered: unknown path does not throw", !threw);
}

// ---- query string is parsed ----
console.log("\n-- router: query string parsing --");

{
  setPath("/runs", "?status=failed&downpipe=dp-1");
  const state = makeRouter();
  state.router.add("/runs", (m) => { state.lastMatch = m; });
  state.router.navigate("/runs?status=failed&downpipe=dp-1");
  eq("query: status=failed extracted", state.lastMatch?.query.get("status") ?? "", "failed");
  eq("query: downpipe=dp-1 extracted", state.lastMatch?.query.get("downpipe") ?? "", "dp-1");
}

// ---- afterEach is called after each resolution ----
{
  setPath("/keys");
  let afterEachPattern = "";
  const r = new Router();
  r.add("/keys", () => {});
  r.afterEach((m) => { afterEachPattern = m.pattern; });
  r.navigate("/keys");
  eq("afterEach receives the resolved pattern", afterEachPattern, "/keys");
}

// The full route list is derived at lib/app-registry.ts (ROUTES, computed from the screens' own
// descriptors); scripts/route-table-gate.mjs independently re-parses every screen's `route:` field off
// disk and asserts the two agree.

// ---------------------------------------------------------------------------
// 3. NAV -- isItemActive active-state derivation (shell/nav.ts)
// ---------------------------------------------------------------------------
console.log("\n-- nav: isItemActive --");

// A minimal NavItem with no activeFor.
const overviewItem: NavItem = { route: "/", label: "Overview", icon: "" };
ok("isItemActive: route match when pattern === item.route", isItemActive(overviewItem, "/"));
ok("isItemActive: no match when pattern differs", !isItemActive(overviewItem, "/downpipes"));

// An item with activeFor.
const downpipesItem: NavItem = {
  route: "/downpipes",
  label: "Downpipes",
  icon: "",
  activeFor: ["/downpipes", "/downpipes/new", "/downpipes/:id", "/downpipes/:id/edit"],
};
ok("isItemActive: route match on own route", isItemActive(downpipesItem, "/downpipes"));
ok("isItemActive: active when pattern is in activeFor (/downpipes/:id)", isItemActive(downpipesItem, "/downpipes/:id"));
ok("isItemActive: active for /downpipes/new", isItemActive(downpipesItem, "/downpipes/new"));
ok("isItemActive: active for /downpipes/:id/edit", isItemActive(downpipesItem, "/downpipes/:id/edit"));
ok("isItemActive: NOT active for /runs", !isItemActive(downpipesItem, "/runs"));
ok("isItemActive: NOT active for /", !isItemActive(downpipesItem, "/"));

// An item whose route is a sub-path that another item also covers.
const accessItem: NavItem = {
  route: "/access",
  label: "Access",
  icon: "",
  activeFor: ["/access", "/access/roles", "/access/fallback"],
};
const auditItem: NavItem = {
  route: "/access/audit",
  label: "Audit",
  icon: "",
  // No activeFor (only its exact route).
};
ok("access: active for /access/roles (in activeFor)", isItemActive(accessItem, "/access/roles"));
ok("access: NOT active for /access/audit (deliberately excluded)", !isItemActive(accessItem, "/access/audit"));
ok("audit: active for /access/audit (own route)", isItemActive(auditItem, "/access/audit"));
ok("audit: NOT active for /access (parent)", !isItemActive(auditItem, "/access"));

// Negative control: an item with an empty activeFor is active only on its own route.
const settingsItem: NavItem = { route: "/settings", label: "Settings", icon: "" };
ok("settings: active for /settings (own route)", isItemActive(settingsItem, "/settings"));
ok("settings: NOT active for /settings/other (not in activeFor)", !isItemActive(settingsItem, "/settings/other"));

// NAV contains items covering the canonical route table.
console.log("\n-- nav: NAV table completeness --");
const allItems = NAV.flatMap((g) => g.items);
const allRoutes = allItems.map((i) => i.route);
ok("NAV has an item for '/'",                     allRoutes.includes("/"));
ok("NAV has an item for '/downpipes'",            allRoutes.includes("/downpipes"));
ok("NAV has an item for '/access'",               allRoutes.includes("/access"));
ok("NAV has an item for '/access/audit'",         allRoutes.includes("/access/audit"));
ok("NAV has an item for '/keys'",                 allRoutes.includes("/keys"));
ok("NAV has an item for '/settings'",             allRoutes.includes("/settings"));
// Negative control: no item for a fictitious route.
ok("NAV has no item for '/nonexistent'",          !allRoutes.includes("/nonexistent"));

// ---------------------------------------------------------------------------
// 4. THEME -- getThemePref / setThemePref / resolvedTheme
// ---------------------------------------------------------------------------
console.log("\n-- theme: getThemePref default --");

// Clear the localStorage stub so we start from a clean state.
localStorageStore.clear();
// Default when nothing stored: "dark" (Obsidian).
eq("getThemePref() defaults to 'dark' when nothing stored", getThemePref(), "dark");

// Negative control: unrecognised stored value falls back to default.
localStorageStore.set("dp-theme", "invalid-value");
eq("getThemePref() falls back to 'dark' for unrecognised stored value", getThemePref(), "dark");

console.log("\n-- theme: setThemePref persistence --");

setThemePref("light");
eq("setThemePref('light') persists to localStorage", localStorageStore.get("dp-theme") ?? "", "light");
eq("getThemePref() reads back 'light'", getThemePref(), "light");

setThemePref("dark");
eq("setThemePref('dark') persists to localStorage", localStorageStore.get("dp-theme") ?? "", "dark");
eq("getThemePref() reads back 'dark'", getThemePref(), "dark");

setThemePref("system");
eq("setThemePref('system') persists to localStorage", localStorageStore.get("dp-theme") ?? "", "system");
eq("getThemePref() reads back 'system'", getThemePref(), "system");

// Negative control: overwriting 'light' with 'dark' takes effect immediately.
setThemePref("light");
setThemePref("dark");
eq("overwrite 'light' -> 'dark' is reflected", getThemePref(), "dark");

console.log("\n-- theme: resolvedTheme --");

// With pref = "light" the resolved theme is "light" regardless of the media query.
setThemePref("light");
eq("resolvedTheme with pref=light is 'light'", resolvedTheme(), "light");

// With pref = "dark" the resolved theme is "dark".
setThemePref("dark");
eq("resolvedTheme with pref=dark is 'dark'", resolvedTheme(), "dark");

// With pref = "system" the resolved theme defers to the matchMedia stub.
// Our stub returns matches:true for any query containing "dark", so system resolves to "dark".
setThemePref("system");
const systemResolved = resolvedTheme();
ok("resolvedTheme with pref=system is either 'light' or 'dark'", systemResolved === "light" || systemResolved === "dark");

// Negative control: resolvedTheme never returns "system" (that is a preference, not a
// resolved value; the function always collapses it to "light" or "dark").
// Read through a widened binding deliberately. The declared return type is "light" | "dark", so
// comparing the call directly against "system" is a tautology the compiler rejects, and a negative
// control that cannot fail is not a control. What this guards is an implementation that returns
// "system" while still declaring it does not, which the type alone does not catch and which is the
// exact mistake the function's collapse step exists to prevent.
const resolvedAsString: string = resolvedTheme();
ok("resolvedTheme never returns 'system'", resolvedAsString !== "system");

// ---------------------------------------------------------------------------
// 4b. THEME -- onThemeChange subscription
// ---------------------------------------------------------------------------
console.log("\n-- theme: onThemeChange subscription --");

// A listener receives each setThemePref call.
const themeEvents: string[] = [];
const unsub1 = onThemeChange((p) => themeEvents.push(p));

setThemePref("light");
ok("onThemeChange fires on setThemePref('light')", themeEvents.length === 1 && themeEvents[0] === "light");

setThemePref("dark");
ok("onThemeChange fires on setThemePref('dark')", themeEvents.length === 2 && themeEvents[1] === "dark");

setThemePref("system");
ok("onThemeChange fires on setThemePref('system')", themeEvents.length === 3 && themeEvents[2] === "system");

// Multiple listeners all fire.
const secondEvents: string[] = [];
const unsub2 = onThemeChange((p) => secondEvents.push(p));
setThemePref("light");
ok("two listeners both receive the event", themeEvents.length === 4 && secondEvents.length === 1);

// Unsubscribing stops delivery.
unsub1();
setThemePref("dark");
ok("unsubscribed listener no longer receives events", themeEvents.length === 4); // no new entry
ok("remaining listener still receives events after unsub1", secondEvents.length === 2);

// Unsub the second one; no listeners, no throw.
unsub2();
let noThrow = true;
try { setThemePref("light"); } catch { noThrow = false; }
ok("setThemePref with no listeners does not throw", noThrow);

// Negative control: calling the unsub fn twice is safe.
let doubleUnsubThrew = false;
try { unsub1(); unsub2(); } catch { doubleUnsubThrew = true; }
ok("calling unsub twice does not throw", !doubleUnsubThrew);

// ---------------------------------------------------------------------------
// 5. LIB NAV -- installNav bridge delegation
// ---------------------------------------------------------------------------
console.log("\n-- lib/nav: installNav and navigate delegation --");

const navigateCalls: string[] = [];
let onUnauthorisedCalls = 0;
let refreshIdentityCalls = 0;
const onAuthenticatedCalls: string[] = [];
let signOutCalls = 0;

installNav({
  navigate(to) { navigateCalls.push(to); },
  onUnauthorised() { onUnauthorisedCalls++; },
  refreshIdentity: async () => { refreshIdentityCalls++; },
  onAuthenticated: async (next) => { onAuthenticatedCalls.push(next); },
  signOut: () => { signOutCalls++; },
});

navigate("/downpipes");
ok("navigate() delegates to the installed handler", navigateCalls.includes("/downpipes"));

navigate("/keys");
ok("navigate() passes the target through unchanged", navigateCalls.at(-1) === "/keys");

// Negative control: calling navigate twice records two distinct calls.
const before = navigateCalls.length;
navigate("/runs");
navigate("/restore");
ok("two navigate() calls produce two recorded destinations", navigateCalls.length === before + 2);

goSignedOut();
ok("goSignedOut() calls onUnauthorised on the installed bridge", onUnauthorisedCalls === 1);

// Calling goSignedOut again increments the counter (bridge is stateful).
goSignedOut();
ok("goSignedOut() twice calls onUnauthorised twice", onUnauthorisedCalls === 2);

// Negative control: navigate does NOT trigger onUnauthorised.
const countBefore = onUnauthorisedCalls;
navigate("/settings");
ok("navigate() does NOT call onUnauthorised", onUnauthorisedCalls === countBefore);

// onAuthenticated delegates to the installed bridge, passing the target through.
await navOnAuthenticated("/overview");
ok("onAuthenticated() delegates to the installed bridge", onAuthenticatedCalls.includes("/overview"));
ok("onAuthenticated() passes the next target through unchanged", onAuthenticatedCalls.at(-1) === "/overview");

// signOut delegates to the installed bridge (distinct from the 401 onUnauthorised routing).
navSignOut();
ok("signOut() delegates to the installed bridge", signOutCalls === 1);

// Negative control: none of the navigate / goSignedOut / onAuthenticated / signOut flows above
// re-resolve identity. refreshIdentity is reserved for explicit role-change handling, so it must
// stay at zero here. A regression that fired it spuriously would break this assertion.
ok("refreshIdentity() is NOT called during normal navigate/goSignedOut flows", refreshIdentityCalls === 0);

// Before installNav is called the default bridge is a no-op (no throw). We test this by
// creating a fresh module state: we cannot re-import, so we install a no-op bridge and
// confirm no throw occurs.
installNav({
  navigate() {},
  onUnauthorised() {},
  refreshIdentity: async () => {},
  onAuthenticated: async () => {},
  signOut: () => {},
});
let noopThrew = false;
try {
  navigate("/overview");
  goSignedOut();
} catch {
  noopThrew = true;
}
ok("no-op bridge: navigate/goSignedOut do not throw", !noopThrew);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nCORE UNIT VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
