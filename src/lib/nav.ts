// The app-level navigation + identity bridge the screens use without each one
// taking a context argument (which would be a large refactor of the shell wiring).
// app.ts installs the handlers at boot (the router's navigate, the signed-out
// routing, and a way to re-resolve the caller after a role change); screens import
// the thin accessors here. This keeps the router and the shell free of screen
// imports (no cycle) while giving every screen the same, consistent navigation and
// the same 401 -> signed-out behaviour.

// Imported from its declaring module rather than the ../api.ts barrel. It is a type-only import and
// so is erased at runtime, but madge counts it and it closed a genuine import cycle
// (api.ts > lib/api/client.ts > lib/api/client-session.ts > lib/nav.ts), which failed the gating
// code-quality job. Naming the real home is also just more honest about where the type lives.
import type { Caller } from "./api/types/who.ts";
// From the leaf, not the store: reading the caller must not pull in the EngineClient.
import { getCaller, isWhoamiAvailable } from "./caller-state.ts";
import { recordBootClass } from "./client-diag/ring.ts";

interface NavBridge {
  navigate: (to: string, opts?: { replace?: boolean }) => void;
  // Route a thrown 401 to the signed-out screen, preserving the intended URL so
  // re-auth returns the operator where they were going.
  onUnauthorised: () => void;
  // Re-resolve the caller from the engine (after a role change that affects the
  // current operator). Updates the store + the shell chip. Returns when done.
  refreshIdentity: () => Promise<void>;
  // A passkey sign-in JUST succeeded (the engine set the session cookie). Boot to the
  // role-appropriate view: navigate to `next` (the URL the operator was heading to,
  // default "/", which Overview redirects per role) and re-resolve the verified identity
  // so the shell chip + role are real and the per-role landing applies on this first
  // successful resolve. The passkey screen fires this on a verified ceremony; app.ts owns
  // the boot. It never throws (a transient whoami failure leaves the next guarded
  // navigation to re-resolve).
  onAuthenticated: (next: string) => Promise<void>;
  // The REAL sign-out (the shell account-menu path, app.ts): ends the engine passkey
  // session when one exists (best-effort), clears the in-memory store, resets the shell
  // chips and lands on the live sign-in. Screens and the palette call this so every
  // "Sign out" control does the same true thing; onUnauthorised above is only the 401
  // ROUTING and deliberately clears nothing (a lapsed session may recover by re-auth).
  signOut: () => void;
}

const bridge: NavBridge = {
  navigate: () => {},
  onUnauthorised: () => {},
  refreshIdentity: async () => {},
  onAuthenticated: async () => {},
  signOut: () => {},
};

// installed says whether app.ts has handed this bridge its REAL handlers yet. Until it has, every
// accessor below resolves to the no-op default above, and a no-op default is the quietest fault in the console:
// the screen calls navigate(), the call returns cleanly, and nothing happens. Every click does nothing, no
// error is thrown, no toast fires and no request is made, so there is nothing for any catch site, any window
// handler or any engine log to see. It is reachable whenever boot did not finish (a boot fault before
// installNav, or a partially loaded page), and the customer's report ("the console is up and every button is
// dead") is otherwise unfalsifiable from the pack.
//
// noteUninstalledBridge records ONE closed-class boot-fault row the first time a screen asks the bridge to do
// something before it exists, and does not change the behaviour it observes: the call still no-ops exactly as
// it does today. The ring coalesces repeats, so a page of dead clicks is one row with a count.
let installed = false;

function noteUninstalledBridge(): void {
  if (installed) return;
  recordBootClass("nav-bridge-uninstalled");
}

// installNav is called once by app.ts at boot with the real handlers.
export function installNav(b: NavBridge): void {
  bridge.navigate = b.navigate;
  bridge.onUnauthorised = b.onUnauthorised;
  bridge.refreshIdentity = b.refreshIdentity;
  bridge.onAuthenticated = b.onAuthenticated;
  bridge.signOut = b.signOut;
  installed = true;
}

// navBridgeInstalled is exported for the validator, which drives the uninstalled bridge and asserts the row.
export function navBridgeInstalled(): boolean {
  return installed;
}

export function navigate(to: string, opts?: { replace?: boolean }): void {
  // A registered leave-guard (a dirty form) gets to veto/confirm first. The guard
  // returns true to proceed; a guard that needs to ask the operator handles its own
  // confirm and calls navigate again once cleared, so navigate just bails here.
  if (leaveGuard && !leaveGuard(to)) return;
  noteUninstalledBridge();
  bridge.navigate(to, opts);
}

// ---- post-navigation focus intent ---------------------------------------------
//
// The shell moves focus to <main> after every real navigation, so a keyboard or screen-reader user lands
// in the new content. That is right for an ordinary route change and WRONG for a control whose activation
// IS the navigation: a tablist whose sections each own a route (the Keys sections, the
// Notifications areas) re-renders the whole screen on an arrow key, and the shell's focus move then lands
// on <main> instead of the newly selected tab. The tablist's own restore could not win that race, because
// a view transition runs the shell's swap-and-focus in a LATER task than the render that scheduled it, and
// a focus() call on a node that is not mounted yet does nothing at all.
//
// Against the built bundle: one ArrowRight can move aria-selected and the roving
// tabindex correctly and still leave focus on MAIN, so every further arrow does nothing and a keyboard user gets
// exactly one tab move per manual re-focus.
//
// So a screen DECLARES where focus belongs after the navigation it is being rendered for, and the shell
// honours that instead of <main>. The intent is consumed once and cleared, and it is ignored unless the
// element it names is actually connected when the shell reads it, so a stale intent can never park focus
// on a detached node.
let postNavFocus: (() => HTMLElement | null) | null = null;

/** Declare, from a screen's render, where focus belongs once the shell mounts it. Consumed once. */
export function requestPostNavigationFocus(get: () => HTMLElement | null): void {
  postNavFocus = get;
}

// PostNavigationFocus is the reader's RESULT, and the reason it is a pair rather than an element is the
// support pack. The three states below were collapsed into one nullable element, which threw away the only
// fact that tells a working tablist from the broken one: `none` (no screen declared anything, the ordinary
// route change, the shell focuses <main> and that is correct) and `detached` (a screen DID declare where
// focus belongs and the element was not mounted when the shell read it, so focus falls to <main> and every
// further arrow key does nothing) both answered null. The caller could not tell them apart and so neither
// could anything downstream of it. `state` is that discrimination, kept.
export type PostNavigationFocus =
  | { state: "none"; el: null } // no declaration: focus <main>, which is right for a real route change
  | { state: "honoured"; el: HTMLElement } // declared and mounted: the activating control keeps focus
  | { state: "detached"; el: null }; // declared and NOT mounted: the defect, focus falls back to <main>

/** The shell's reader: reports the declared element when one is connected, and WHY when there is none. */
export function takePostNavigationFocus(): PostNavigationFocus {
  const claimed = postNavFocus;
  postNavFocus = null;
  if (claimed === null) return { state: "none", el: null };
  const el = claimed();
  return el?.isConnected ? { state: "honoured", el } : { state: "detached", el: null };
}

// ---- referrer-aware back -------------------
// The router keeps no app-side history, so a "Back to X" control cannot know where
// the operator actually came from. This tiny ring records the last two resolved
// PATHS (recordNav, wired into app.ts afterEach), so backTo() can return to the real
// referrer when it is a sensible in-app path and fall back to a screen's structural
// parent otherwise. Paths only (never query secrets); same-path replaceState (a list
// reflecting its filter into the URL) is ignored so it never becomes its own referrer.
let lastPath: string | null = null;
let currentPath: string | null = null;

export function recordNav(path: string): void {
  if (path === currentPath) return; // ignore same-path replaceState (filter reflection)
  lastPath = currentPath;
  currentPath = path;
}

// referrer is the path resolved BEFORE the current one, or null on a cold first load.
export function referrer(): string | null {
  return lastPath;
}

// currentRoute returns the route the app is currently on, as a navigable string (the resolved path plus the
// live query string), so a caller can re-render the current screen by navigating to it again (the router
// re-resolves and re-runs the screen on a same-path navigate). It falls back to "/" before the first
// resolution. Used by the tour's "Reset sample data" control to re-paint the visible screen in place after a
// re-seed, without a full page reload (so the visitor keeps their place and the tour position).
export function currentRoute(): string {
  const path = currentPath ?? "/";
  const search = (typeof location !== "undefined" && location.search) ? location.search : "";
  return path + search;
}

// backTo returns the operator to where they came from when that referrer is a real,
// non-auth in-app path that is not the current screen; otherwise to the given
// structural fallback (a parent route every child screen knows). The fallback keeps
// Back honest on a cold deep-link / refresh, where there is no referrer to return to.
export function backTo(fallback: string): void {
  const ref = lastPath;
  const safe =
    ref?.startsWith("/") &&
    ref !== currentPath &&
    ref !== "/passkey" &&
    ref !== "/signed-out" &&
    !ref.startsWith("/register");
  navigate(safe ? ref! : fallback);
}

// ---- leave guard (the dirty-form discard prompt) ------------------------------
// A screen with unsaved, non-recoverable input registers a guard while dirty; it is
// consulted by navigate() (and so by backTo and every screen-driven navigation). The
// guard owns its own confirm UI and returns false to cancel the navigation (it may
// re-issue navigate once the operator confirms). Cleared on unmount / successful save.
type LeaveGuard = (to: string) => boolean;
let leaveGuard: LeaveGuard | null = null;

// The SPA guard above only ever sees navigate() calls, so a REAL navigation (a
// reload, a tab close, back/forward through browser chrome) bypassed every one of the
// three screens that register a leave guard (the key ceremony, the destination form, the
// new-downpipe wizard) with no prompt at all. Rather than have each of those three wire
// its own window.beforeunload listener (three copies of the same lifecycle, three chances
// to forget it), the dirty check rides the SAME registration this file already owns: a
// caller passes an optional, side-effect-free isDirty alongside its guard, and ONE
// beforeunload listener here (installed once, feature-detected so it never breaks a
// server/test context with no window) asks the browser for its native "leave site?"
// prompt whenever the currently-registered predicate says there is unsaved work. The
// wording of that prompt is the browser's own; the product cannot customise it, so this
// is deliberately a plain isDirty query, never the SPA guard's confirmModal path.
let leaveGuardDirty: (() => boolean) | null = null;
let beforeunloadInstalled = false;

function installBeforeunload(): void {
  if (beforeunloadInstalled) return;
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  window.addEventListener("beforeunload", (e: BeforeUnloadEvent) => {
    if (!leaveGuardDirty?.()) return;
    e.preventDefault();
    e.returnValue = "";
  });
  beforeunloadInstalled = true;
}

export function registerLeaveGuard(guard: LeaveGuard, isDirty?: () => boolean): void {
  leaveGuard = guard;
  leaveGuardDirty = isDirty ?? null;
  if (isDirty) installBeforeunload();
}

export function clearLeaveGuard(guard?: LeaveGuard): void {
  // Clear unconditionally, or only when the caller still owns the guard (so a screen
  // tearing down does not clobber a newer screen's guard).
  if (guard === undefined || leaveGuard === guard) {
    leaveGuard = null;
    leaveGuardDirty = null;
  }
}

// ---- sign-in redirect target (the 401 -> /passkey?next= capture) ------------------
// intendedNextFrom is the pure decision behind app.ts's routeToSignIn: given the currently-resolved
// route, compute the safe in-app path (+ query) a 401 redirects to sign in with, so a successful re-auth
// returns the operator to where they were actually going. Kept here, rather than private in app.ts,
// because app.ts cannot be imported by a test without running its own boot sequence (it boots itself at
// module scope on load), so the decision worth asserting against inputs and outputs needs a home a test
// can import cleanly -- and this file already owns "where should navigation return the operator to"
// (referrer, backTo above), which is this question's sibling.
//
// On an ordinary route this is simply the current path + query, unchanged. While the resolved route IS
// ALREADY the sign-in screen (/passkey or /signed-out), an existing, safe next= already in the query is
// PRESERVED rather than reset to "/". That preservation is the fix:
// routeToSignIn can run more than once in quick succession -- every screen's own load-catch calls
// goSignedOut() independently on its own 401, and a session that has genuinely died answers several
// concurrent admin reads with 401 at once, which a reload or a detour through a screen with several
// settled reads both produce -- so whichever caller's read settles LAST must not clobber the FIRST
// caller's correct capture of the real destination with the bare "/" default. Because the redirect is a
// REPLACE navigation, the later call always used to win, and it always reset to "/" the instant the
// address bar had already become /passkey, discarding the very next= the first call had just, correctly,
// written. A genuine first landing on /passkey or /signed-out with no next= (or an unsafe one) still
// defaults to "/", unchanged: the same-origin guard (a bare in-app path, never "//", a protocol-relative
// off-site redirect) mirrors the one app.ts's onAuthenticated already applies when CONSUMING next= after
// a successful sign-in.
export function intendedNextFrom(current: { path: string; query: URLSearchParams }): string {
  const onAuthRoute = current.path === "/passkey" || current.path === "/signed-out";
  if (!onAuthRoute) return current.path + (current.query.toString() ? `?${current.query.toString()}` : "");
  const existingNext = current.query.get("next");
  return existingNext?.startsWith("/") && !existingNext.startsWith("//") ? existingNext : "/";
}

export function goSignedOut(): void {
  noteUninstalledBridge();
  bridge.onUnauthorised();
}

export function refreshIdentity(): Promise<void> {
  noteUninstalledBridge();
  return bridge.refreshIdentity();
}

// onAuthenticated signals a just-succeeded passkey sign-in (the engine has set the session cookie).
// app.ts boots the role-appropriate view: it navigates to `next` and re-resolves whoami. The passkey
// sign-in screen calls this on a verified ceremony.
export function onAuthenticated(next: string): Promise<void> {
  noteUninstalledBridge();
  return bridge.onAuthenticated(next);
}

// signOut runs the REAL sign-out (the shell account-menu path): the engine passkey
// session is ended best-effort, the in-memory store is cleared, the shell chips reset,
// and the operator lands on the live sign-in. Every "Sign out" control routes here so
// the adjacent "state is cleared" copy is true.
export function signOut(): void {
  noteUninstalledBridge();
  bridge.signOut();
}

// caller / role helpers the screens use to gate controls (the CLIENT mirror of the
// engine's server-side role enforcement; never the control itself).
export function caller(): Caller | null {
  return getCaller();
}

export function whoamiAvailable(): boolean {
  return isWhoamiAvailable();
}
