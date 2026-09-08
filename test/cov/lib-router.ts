// Coverage validator for the parts of the History-API router (src/lib/router.ts) that the pure-logic
// suite in test/validate-core.ts does not reach. validate-core.ts exercises pathname-mode matching,
// params, the query string, notFound and afterEach; what it leaves uncovered is everything keyed off
// the OTHER mode and the lifecycle:
//   - hash mode (the file:// / no-server case): the constructor's useHash branch, current() reading
//     the hash, navigate() prefixing "#", and start() re-resolving on a hashchange,
//   - the EMAILED in-app hash deep link in pathname mode (pathname "/" + "#/register?invite="),
//     which routes the hash's path + query instead of falling through to "/",
//   - start()'s listen-once guard and the popstate / hashchange re-resolution,
//   - navigate()'s replace (history.replaceState) arm,
//   - safeDecode's catch arm for a malformed percent-escape in a :param.
//
// The router renders no component, so this validator stubs only the four browser surfaces it actually
// touches (location, window.addEventListener, history.pushState / replaceState) BEFORE importing the
// module, exactly as validate-core.ts stubs them; it does not use the shared DOM shim. useHash is read
// once in the constructor, so each mode is set up by patching location.protocol before constructing
// the Router under test. Run with `node test/cov/lib-router.ts` (the cov runner also invokes it).

// ---------------------------------------------------------------------------
// Browser-global stubs (set before the import so the module evaluates cleanly).
// ---------------------------------------------------------------------------

// A mutable location the tests rewrite per case. protocol drives the constructor's mode choice;
// pathname / search / hash drive current(). We default to pathname mode (https:).
interface MutableLocation {
  protocol: string;
  pathname: string;
  search: string;
  hash: string;
  href: string;
}
const loc: MutableLocation = {
  protocol: "https:",
  pathname: "/",
  search: "",
  hash: "",
  href: "https://localhost/",
};
(globalThis as Record<string, unknown>).location = loc;

// A recording history so navigate()'s push and replace arms can be observed without a real history.
interface HistoryCall {
  kind: "push" | "replace";
  url: string;
}
const historyCalls: HistoryCall[] = [];
(globalThis as Record<string, unknown>).history = {
  pushState: (_s: unknown, _t: string, url: string): void => {
    historyCalls.push({ kind: "push", url });
  },
  replaceState: (_s: unknown, _t: string, url: string): void => {
    historyCalls.push({ kind: "replace", url });
  },
};

// A window whose addEventListener records the popstate / hashchange callbacks so start() can be
// observed to register them and the tests can fire them to drive a re-resolution.
const winListeners: Record<string, Array<() => void>> = {};
(globalThis as Record<string, unknown>).window = {
  addEventListener: (type: string, fn: () => void): void => {
    winListeners[type] ||= []; winListeners[type].push(fn);
  },
};
function fireWindow(type: string): void {
  for (const fn of winListeners[type] ?? []) fn();
}

// ---------------------------------------------------------------------------
// Imports (after the stubs so no ReferenceError at module-eval time).
// ---------------------------------------------------------------------------

import { Router } from "../../src/lib/router.ts";
import type { RouteMatch } from "../../src/lib/router.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}
function eq<T>(label: string, got: T, want: T): void {
  const cond = got === want;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// setLoc rewrites the shared mutable location for a case. protocol stays whatever was last set unless
// overridden, so a hash-mode block sets it explicitly and the rest stay in the https: default.
function setLoc(patch: Partial<MutableLocation>): void {
  Object.assign(loc, patch);
}

// ===========================================================================
console.log("\n-- constructor: mode is chosen once from location.protocol --");
// ===========================================================================
{
  // The default https: protocol selects pathname (clean-URL) mode: a navigate target is pushed
  // verbatim, with no "#" prefix.
  setLoc({ protocol: "https:", pathname: "/keys", search: "", hash: "" });
  historyCalls.length = 0;
  const r = new Router();
  r.add("/keys", () => {});
  r.navigate("/keys");
  ok("pathname mode pushes the target with no '#' prefix", historyCalls.at(-1)?.url === "/keys");

  // The file: protocol selects hash mode: navigate prefixes "#" so the URL stays a fragment (the
  // static-host / file:// case where the server cannot route a clean path).
  setLoc({ protocol: "file:", pathname: "/index.html", search: "", hash: "#/keys" });
  historyCalls.length = 0;
  const hr = new Router();
  hr.add("/keys", () => {});
  hr.navigate("/keys");
  ok("hash mode prefixes the navigate target with '#'", historyCalls.at(-1)?.url === "#/keys");
  // Negative control: the prefixed form is NOT the bare path, proving the branch actually diverged.
  ok("hash mode did NOT push the bare path", historyCalls.at(-1)?.url !== "/keys");
}

// ===========================================================================
console.log("\n-- hash mode: current() and resolve() route on the hash --");
// ===========================================================================
{
  // In hash mode current() reads the path + query out of location.hash, NOT the pathname, so a
  // "#/runs?status=failed" resolves the /runs route with its query, even though the pathname is a
  // static file path that names no route.
  setLoc({ protocol: "file:", pathname: "/console/index.html", search: "?ignored=1", hash: "#/runs?status=failed" });
  const r = new Router();
  let match: RouteMatch | null = null;
  r.add("/runs", (m) => { match = m; });
  r.add("/", () => {});
  // navigate() recomputes the target as "#" + to, then resolve() reads the (now stale) hash; to test
  // resolve() reading the hash we set the hash directly and call navigate to trigger a resolve.
  setLoc({ hash: "#/runs?status=failed" });
  r.navigate("/runs?status=failed");
  ok("hash mode resolves the hash path to its route", match !== null && (match as RouteMatch).pattern === "/runs");
  eq("hash mode parses the hash query (not the pathname search)", (match as RouteMatch | null)?.query.get("status") ?? "", "failed");
  ok("hash mode ignored the pathname search string", (match as RouteMatch | null)?.query.get("ignored") === null);

  // An EMPTY hash in hash mode resolves to the root (parseHashRoute's "|| '/'" default).
  setLoc({ hash: "" });
  let rootHit = false;
  const r2 = new Router();
  r2.add("/", () => { rootHit = true; });
  r2.navigate("/");
  ok("hash mode with an empty hash resolves to '/'", rootHit);
}

// ===========================================================================
console.log("\n-- pathname mode: an emailed in-app hash deep link routes the hash --");
// ===========================================================================
{
  // The invite link is ${ORIGIN}/#/register?invite=<token>: the pathname is the root and the hash
  // names an in-app route. In pathname mode current() must parse the hash (path + query) rather than
  // fall through to "/", so /register resolves and ?invite= reaches the screen.
  setLoc({ protocol: "https:", pathname: "/", search: "", hash: "#/register?invite=tok-123" });
  const r = new Router();
  let match: RouteMatch | null = null;
  r.add("/", () => { match = { pattern: "/", params: {}, query: new URLSearchParams(), path: "/" }; });
  r.add("/register", (m) => { match = m; });
  r.navigate("/"); // navigate target is irrelevant; resolve() reads location for the in-app hash
  ok("a root pathname + in-app hash resolves the hash's route, not '/'", (match as RouteMatch | null)?.pattern === "/register");
  eq("the in-app hash deep link carries its query to the screen", (match as RouteMatch | null)?.query.get("invite") ?? "", "tok-123");

  // Negative control 1: a root pathname with a PLAIN fragment anchor ("#section", not "#/...") is NOT
  // treated as a route, so current() reads the pathname and resolves "/".
  setLoc({ protocol: "https:", pathname: "/", search: "", hash: "#section" });
  let rootHit = false;
  const r2 = new Router();
  r2.add("/", () => { rootHit = true; });
  r2.add("/register", () => {});
  r2.navigate("/");
  ok("a plain '#section' fragment is not mistaken for an in-app route (resolves '/')", rootHit);

  // Negative control 2: a NON-root pathname is read directly even with an in-app hash present, so the
  // hash deep-link special case never hijacks a real path.
  setLoc({ protocol: "https:", pathname: "/keys", search: "", hash: "#/register?invite=tok-999" });
  let keysHit = false;
  let registerHit = false;
  const r3 = new Router();
  r3.add("/keys", () => { keysHit = true; });
  r3.add("/register", () => { registerHit = true; });
  r3.navigate("/keys");
  ok("a non-root pathname is read directly (hash deep-link is ignored)", keysHit && !registerHit);
}

// ===========================================================================
console.log("\n-- start(): listens once and re-resolves on popstate / hashchange --");
// ===========================================================================
{
  // start() registers a popstate and a hashchange listener and resolves the current URL once. We
  // count resolutions via the handler, then fire each captured listener to confirm it re-resolves.
  winListeners.popstate = [];
  winListeners.hashchange = [];
  setLoc({ protocol: "https:", pathname: "/keys", search: "", hash: "" });
  let resolveCount = 0;
  const r = new Router();
  r.add("/keys", () => { resolveCount++; });
  r.start();
  ok("start() resolves the current URL once", resolveCount === 1);
  ok("start() registers a popstate listener", (winListeners.popstate?.length ?? 0) === 1);
  ok("start() registers a hashchange listener", (winListeners.hashchange?.length ?? 0) === 1);

  // A back-button popstate re-resolves.
  fireWindow("popstate");
  ok("a popstate event re-resolves the current URL", resolveCount === 2);
  // A hashchange (an in-app hash deep link landing) re-resolves.
  fireWindow("hashchange");
  ok("a hashchange event re-resolves the current URL", resolveCount === 3);

  // The started guard: a second start() is a no-op (it neither resolves again nor double-registers).
  const popBefore = winListeners.popstate?.length ?? 0;
  r.start();
  ok("a second start() does not resolve again (started guard)", resolveCount === 3);
  ok("a second start() does not register a second popstate listener", (winListeners.popstate?.length ?? 0) === popBefore);
}

// ===========================================================================
console.log("\n-- navigate(): replace swaps the history entry instead of pushing --");
// ===========================================================================
{
  // The redirect form (e.g. unconfigured -> onboarding) uses replace so the unconfigured URL is not
  // left in the back stack.
  setLoc({ protocol: "https:", pathname: "/onboarding/keys", search: "", hash: "" });
  historyCalls.length = 0;
  const r = new Router();
  r.add("/onboarding/:step", () => {});
  r.navigate("/onboarding/keys", { replace: true });
  eq("navigate replace uses history.replaceState", historyCalls.at(-1)?.kind ?? "", "replace");
  ok("navigate replace did NOT push a new entry", !historyCalls.some((c) => c.kind === "push"));

  // The default (no opts) pushes a new entry, the negative control for the replace arm.
  historyCalls.length = 0;
  r.navigate("/onboarding/keys");
  eq("navigate default uses history.pushState", historyCalls.at(-1)?.kind ?? "", "push");
}

// ===========================================================================
console.log("\n-- safeDecode: a malformed percent-escape in a :param is returned raw --");
// ===========================================================================
{
  // A well-formed encoded param is decoded.
  setLoc({ protocol: "https:", pathname: "/downpipes/a%20b", search: "", hash: "" });
  const r = new Router();
  let goodParam = "";
  r.add("/downpipes/:id", (m) => { goodParam = m.params.id ?? ""; });
  r.navigate("/downpipes/a%20b");
  eq("a well-formed encoded param is URL-decoded", goodParam, "a b");

  // A malformed percent-escape ("%E0%A4%A" is truncated) makes decodeURIComponent throw; safeDecode's
  // catch returns the raw segment unchanged rather than propagating the error. We read the param the
  // handler actually receives, so the assertion confirms the catch arm's raw passthrough.
  setLoc({ pathname: "/downpipes/%E0%A4%A" });
  let badParam = "";
  let badHit = false;
  let threw = false;
  try {
    r.navigate("/downpipes/%E0%A4%A");
  } catch {
    threw = true;
  }
  // Re-register a fresh handler so badParam captures the malformed case, not the earlier good one.
  const r2 = new Router();
  r2.add("/downpipes/:id", (m) => { badHit = true; badParam = m.params.id ?? ""; });
  r2.navigate("/downpipes/%E0%A4%A");
  ok("a malformed percent-escape does not throw (safeDecode catch)", !threw && badHit);
  eq("a malformed percent-escape param is returned raw", badParam, "%E0%A4%A");
}

// ===========================================================================
console.log("\n-- resolve(): the fallback arm also runs afterEach --");
// ===========================================================================
{
  // When BOTH a notFound and an afterEach are registered, an unknown route runs the fallback AND then
  // afterEach with the "*" match. validate-core covers fallback-without-afterEach and
  // afterEach-without-fallback; this is the combined arm (the onChange call inside the fallback block).
  setLoc({ protocol: "https:", pathname: "/no-such-screen", search: "", hash: "" });
  let fallbackHit = false;
  let afterEachPattern = "";
  const r = new Router();
  r.add("/keys", () => {});
  r.notFound(() => { fallbackHit = true; });
  r.afterEach((m) => { afterEachPattern = m.pattern; });
  r.navigate("/no-such-screen");
  ok("an unknown route runs the notFound fallback", fallbackHit);
  eq("afterEach also fires for the fallback, with the '*' pattern", afterEachPattern, "*");
}

// ===========================================================================
console.log("\n-- parseHashRoute / normalisePath: no-query and trailing-slash branches --");
// ===========================================================================
{
  // A hash deep link with NO query ("#/passkey") drives parseHashRoute's empty-query arm (the split
  // yields no second part, so the query is an empty URLSearchParams).
  setLoc({ protocol: "https:", pathname: "/", search: "", hash: "#/passkey" });
  let match: RouteMatch | null = null;
  const r = new Router();
  r.add("/", () => {});
  r.add("/passkey", (m) => { match = m; });
  r.navigate("/");
  ok("an in-app hash with no query resolves its route", (match as RouteMatch | null)?.pattern === "/passkey");
  ok("an in-app hash with no query yields an empty query", [...((match as RouteMatch | null)?.query.keys() ?? [])].length === 0);

  // A pathname carrying a TRAILING slash ("/downpipes/") is normalised by current() to "/downpipes"
  // (normalisePath strips the trailing slash for anything but the root), so the route still matches.
  setLoc({ protocol: "https:", pathname: "/downpipes/", search: "", hash: "" });
  let trailingHit = false;
  let trailingPath = "";
  const r2 = new Router();
  r2.add("/downpipes", (m) => { trailingHit = true; trailingPath = m.path; });
  r2.navigate("/downpipes/");
  ok("a trailing-slash pathname still matches its route", trailingHit);
  eq("the trailing slash is stripped from the resolved path", trailingPath, "/downpipes");

  // The root "/" is NOT stripped (the length>1 guard protects it): "/" still resolves to the root.
  setLoc({ protocol: "https:", pathname: "/", search: "", hash: "" });
  let rootHit = false;
  const r3 = new Router();
  r3.add("/", () => { rootHit = true; });
  r3.navigate("/");
  ok("the root '/' is preserved (not stripped to empty)", rootHit);

  // A hash that is ONLY a query ("#?foo=bar") has an empty path part before the "?", so parseHashRoute
  // falls back to the root path while still parsing the query (the `p || "/"` arm). In hash mode this
  // resolves the root route and the query reaches it.
  setLoc({ protocol: "file:", pathname: "/index.html", search: "", hash: "#?foo=bar" });
  let qOnlyHit = false;
  let qOnlyVal = "";
  const r4 = new Router();
  r4.add("/", (m) => { qOnlyHit = true; qOnlyVal = m.query.get("foo") ?? ""; });
  r4.navigate("/?foo=bar");
  ok("a query-only hash falls back to the root path", qOnlyHit);
  eq("a query-only hash still parses its query", qOnlyVal, "bar");
}

// There used to be a section here asserting three spot values of a hand-maintained `ROUTES` export
// from this module. That export was removed: router.ts is a generic, screen-agnostic module and never
// bound from it, so it was a second, driftable copy of what the screens already declare (it stopped at 29
// entries while the screens had grown to 47, and nothing here would have caught that -- the three spot
// checks below happened to all still be present). The real, FULL, derived list now lives at
// lib/app-registry.ts (ROUTES, computed from the screens), and scripts/route-table-gate.mjs is the
// non-vacuous gate that asserts it agrees with what is actually on disk -- see that script for the
// coverage this section used to gesture at without providing.

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures > 0) process.exitCode = 1;
if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nROUTER COVERAGE VECTORS PASS");
