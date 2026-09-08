// The console entry point (the production form of the old monolithic SPA; this is
// the `main.ts` role from, kept as app.ts because that is the
// esbuild entry and the <script> in index.html). It runs the pre-paint theme hook,
// restores the engine connection, mounts the app shell once, registers every IA
// route against the small router, wires the shell handlers, resolves the verified
// identity (degrading honestly when whoami is absent), and starts the router.
//
// The reused logic modules (api.ts, keygen.ts, escape.ts, bytes.ts,
// recovery-sheet.ts) are kept verbatim; the UI layer sits on top of the bespoke
// design system and the shell + router. The shell, the router and every screen body
// are wired so navigation, deep-linking, the back button, theming and the
// trust-honest session area all work end to end.
//
// The screen list + assembled command registry (SCREENS / REGISTRY / FULL_BLEED /
// CEREMONY_PATTERNS) live in lib/app-registry.ts and the external-link interstitial in
// lib/app-external-link.ts; both are re-exported here so the entry's surface is unchanged.

import { initTheme } from "./lib/theme.ts";
import { initA11yPrefs } from "./lib/a11y-prefs.ts";
import { Router, type RouteMatch } from "./lib/router.ts";
import { mountShell, type Shell } from "./shell/app-shell.ts";
import {
  getEngine, getEngineUrl, restoreConnection, adoptProxiedTopology, getCaller, setCaller,
  setWhoamiAvailable, isWhoamiAvailable, signOut as storeSignOut,
  clearSensitiveState, setStepUpRunner,
} from "./lib/store.ts";
import { isUnauthorised } from "./lib/errors.ts";
import { installNav, recordNav, navigate, intendedNextFrom } from "./lib/nav.ts";
import { closeAllOverlays } from "./components/dialog.ts";
import { startRecoveryWatch } from "./lib/recovery-watch.ts";
import {
  setViewMode, resolveViewModeForCaller, landingRouteForCaller, isKnownLandingScreen, type ViewMode,
} from "./lib/view-mode.ts";
import { unknownCapabilityCount } from "./lib/identity-custom-roles.ts";
import { setupAllows } from "./lib/setup-state.ts";
import { toast } from "./components/toast.ts";

import { overviewScreen } from "./screens/overview.ts";
import { runStepUp } from "./screens/passkey.ts";
import { openCommandPalette, defaultDispatch, setPaletteRegistry } from "./screens/command-palette.ts";
import {
  makeScreenContext, screenRoutes, routesOf, type Screen,
} from "./screens/common.ts";

import { SCREENS, REGISTRY, FULL_BLEED, CEREMONY_PATTERNS } from "./lib/app-registry.ts";
import { installExternalLinkInterstitial } from "./lib/app-external-link.ts";
import { buildCallerFromWhoami } from "./lib/app-identity.ts";
import type { Caller } from "./api.ts";
import {
  getSetupView, refreshSetup, forceRefreshSetup, refreshExpiryCount, maybeRefreshExpiryCount,
  maybeRefreshUpdateChip, primeUpdateChipRefresh,
} from "./lib/app-refresh.ts";
// Only the cheap, dependency-free tour guard is imported statically; the heavy tour boot (startDemo and the
// whole faked-backend + tour subtree it pulls in) is loaded with a dynamic import inside the guard below, so
// esbuild's code-splitting keeps the tour entirely out of the default bundle the genuine console ships.
import { isTourMode } from "./lib/demo/tour-mode.ts";
import { isTrainingMode } from "./lib/demo/training-mode.ts";
import { identityFaultFrom, setIdentityFault } from "./lib/identity-remedy.ts";
import { faultClassForError, httpClassForThrown, recordBootFault, recordConsoleSkew, recordContractSkew, recordDeepLinkLost, recordIdentityUnresolved, recordReadDegraded, setActiveScreen, setConsoleBuild } from "./lib/client-diag/ring.ts";
import { consoleVersion, recordServedBundleSkew } from "./lib/console-version.ts";
import { installWindowFaultHandlers } from "./lib/client-diag/window-faults.ts";
import { currentScreenGatedBlind, noteIdentityLanded } from "./lib/client-diag/identity-gate.ts";
import { drainBuildCheckHandoff } from "./lib/client-diag/reload-handoff.ts";
// The window-level fault handlers (Wave C, C5) are installed at MODULE SCOPE, before boot() is called
// below, so a rejection thrown during boot itself is still seen. They record a coarse closed CLASS and
// nothing else, and they filter out the browser's own noise (an aborted fetch, a cross-origin extension
// script); see lib/client-diag/window-faults.ts.
installWindowFaultHandlers();

async function boot(): Promise<void> {
  // Seat the console's own build id on the diagnostics ring, once, at the top of boot. It rides on the
  // envelope of the pack the customer generates, beside the engine's version, and it is what turns "your audit
  // table says unrecognised target (newer engine?)" into "deploy console X": until now the pack identified the
  // engine and nothing at all identified the console the browser was running.
  setConsoleBuild(consoleVersion());
  // And ask, once, whether this tab is running the bundle its own ORIGIN is serving. That is the stale-
  // asset diagnosis, it is the one version comparison the browser can make honestly (both numbers come from the
  // same repo and the same release, unlike the console-versus-engine compare this replaced), and it needs no
  // engine call at all. Fire-and-forget: it never throws and boot never waits on it.
  void recordServedBundleSkew(recordConsoleSkew);
  try {
    // G153: the post-apply console build check writes its outcome and then, ~1.5s later, reloads the tab to finish
    // the update -- and the reload destroys the in-memory ring. So `confirmed` was annihilated on every successful
    // console apply, and "no console-build-check row" was the GUARANTEED state after a healthy update rather than a
    // fact about one. Drain the ONE closed class the check stashed across the ONE reload it itself triggered, before
    // anything else can record. Set-membership admitted, deleted on read.
    drainBuildCheckHandoff();
    await bootInner();
  } catch (err) {
    // Boot fault: the console failed to come up. This is the fault an operator can least describe (there
    // is no screen to read an error off) and support can least see, so it earns a record of its own: the
    // frozen `boot` screen sentinel plus the error's closed faultClass. NOTHING of the error itself travels
    // (no message, name, code or stack). The throw is re-raised unchanged, so the browser reports it exactly
    // as it does today (the re-raised rejection also reaches the window handler, so a boot crash registers
    // as both a boot-fault and an unhandled; both are true of it, and the kinds are distinct).
    recordBootFault(faultClassForError(err));
    throw err;
  }
}

async function bootInner(): Promise<void> {
  const host = document.getElementById("app");
  if (!host) return;

  // 0. Public faked tour (design/self-guided-tour): a single guarded branch that does NOTHING unless the
  //    tour/demo flag is set (a known tour hostname or the ?tour= query param). When set, it dynamically
  //    imports the tour entry (so the tour code is a lazy chunk fetched ONLY here, never in the default
  //    bundle), installs the in-browser fetch interceptor and points the store at this origin BEFORE the
  //    rest of boot runs, so the real console boots with no login, reads the seeded owner from the faked
  //    engine and lands on Overview, with no engine reachable. When the flag is unset this is a no-op and
  //    every line below is byte-for-byte unchanged: the genuine console on its normal host is entirely
  //    unaffected and never downloads the tour chunk. Awaited so the interceptor + store origin are in place
  //    before the boot below issues its first read (the dynamic import resolves from the already-loaded
  //    same-origin chunk, so this adds no perceptible delay on the tour host).
  //    Training mode (training-mode.ts) rides the same guarded dynamic import: the identical faked
  //    backend boots, and startDemo itself branches to the training-start world and the task-gated walk.
  if (isTourMode() || isTrainingMode()) {
    const { startDemo } = await import("./lib/demo/demo-fetch.ts");
    startDemo();
  }

  // 1. Theme + accessibility preferences: re-apply the stored preferences over the pre-paint
  //    inline script's attributes so the in-memory controls and the DOM stay in step.
  initTheme();
  initA11yPrefs();

  // Wire the step-up re-auth ceremony (ASVS V7.5.1) onto every engine client: a sensitive action that
  // returns 401 { stepUpRequired } triggers a fresh passkey assertion -> single-use token -> automatic retry.
  setStepUpRunner(runStepUp);

  // 2. Connection: re-point at a remembered engine URL (no token, no secret; the Access cookie rides
  //    automatically), then let the serving worker declare the proxied topology and adopt + persist it
  //    when it proxies the engine surface (THIS origin is then the engine URL, any split hostname stale).
  restoreConnection();
  await adoptProxiedTopology();

  // 3. Shell: mount once. The router swaps the main region; the shell owns chrome.
  const shell = mountShell(host);

  // External-link interstitial (ASVS V3.7.3): warn before navigating outside the app.
  installExternalLinkInterstitial();

  // 4. Router: register every IA route, then wire the shell handlers and start.
  const router = new Router();
  registerRoutes(router, shell);
  wireShell(shell, router);

  // 4b. Command palette: register the one assembled registry + dispatcher as the palette's default
  //     before router.start(), so EVERY entry point (the shell trigger, Cmd/Ctrl-K, and a first
  //     resolve straight onto /command-palette) opens the same role-gated set.
  setPaletteRegistry(REGISTRY, defaultDispatch);

  // 5. Nav bridge: give the screens a single, consistent navigate + 401-routing +
  //    identity-refresh path without each screen taking a context argument.
  installNav(buildNavBridge(shell, router));

  // The router lifecycle hooks (afterEach overlay/nav/ceremony/setup bookkeeping) and the
  // focus-driven setup + expiry refresh, then start the router.
  installAfterEach(router, shell);
  router.start();
  installFocusRefresh(shell);

  // 6. Identity: resolve the verified caller in the background (honest degrade until whoami is
  //    available, never a faked identity). The FIRST resolve applies the caller's per-role landing +
  //    view mode; thereafter a refresh only updates the chip + the rail.
  void resolveIdentity(shell, router);

  // 6b. INFRA-1: START THE RECOVERY WATCH. The engine latches recoveryRequired out of band (its */15
  //     cron health pass detects control-plane amnesia), so this is a standing condition that can turn
  //     true while a tab is open. It is deliberately started HERE, beside the identity resolve rather
  //     than inside it: the check used to sit after the whoami await in resolveIdentity's try, which
  //     made the loudest banner in the product conditional on an unrelated read succeeding AND sampled
  //     it exactly once per page load, so a tab that booted healthy could never learn that backups had
  //     stopped. The watch re-polls on an interval and on focus, and raises the banner only on a
  //     CONFIRMED recoveryRequired=true (lib/recovery-watch.ts).
  startRecoveryWatch({
    engine: () => getEngine(),
    onReconciled: () => {
      void resolveIdentity(shell, router);
    },
  });

  // 7. Back/forward-cache guard. A page restored from the bfcache does NOT re-run boot, so the
  //    client gates would keep whatever authority they last rendered, leaving a stale authed
  //    render behind Back after a sign-out (which clears the session server-side) or a session
  //    ended in another tab. Re-resolve identity on a persisted pageshow: whoami then reads absent
  //    and the gates fall back to the fail-closed viewer default rather than the prior authority.
  //    A normal restore (still signed in) re-resolves to the same authority and is a no-op render.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) void resolveIdentity(shell, router);
  });
}

// buildNavBridge assembles the single, consistent navigate + 401-routing + identity-refresh
// path the screens use without each taking a context argument. The signed-out routing
// preserves the intended URL so re-auth returns the operator where they were going.
function buildNavBridge(shell: Shell, router: Router): Parameters<typeof installNav>[0] {
  return {
    navigate: (to, opts) => router.navigate(to, opts),
    onUnauthorised: () => routeToSignIn(router),
    refreshIdentity: () => resolveIdentity(shell, router),
    // The REAL sign-out, shared with the shell account menu (wireShell): screens (the
    // Settings and Access "Sign out" buttons) and the palette's auth.sign-out all run
    // the same path, so a "Sign out" control never leaves the session live behind Back.
    signOut: () => performSignOut(shell, router),
    // A passkey sign-in just succeeded (the engine set the session cookie). Boot exactly as a fresh
    // sign-in: navigate to the intended destination (default "/", which Overview redirects per role),
    // then re-resolve the verified identity so the shell chip + role are real and the per-role landing
    // applies on this first successful resolve. Navigate FIRST so resolveIdentity's "still on /" landing
    // check is evaluated against the destination, not the /passkey screen the operator is leaving. The
    // next value is same-origin-guarded here (it ultimately comes from a query param).
    onAuthenticated: async (next: string) => {
      const to = next?.startsWith("/") && !next.startsWith("//") ? next : "/";
      router.navigate(to, { replace: true });
      await resolveIdentity(shell, router);
    },
  };
}

// previousPattern tracks the pattern of the most recently resolved route so the
// afterEach hook can detect departure from the ceremony context. Initialised to the
// empty string (no prior route) so the first navigation never triggers a false clear.
let previousPattern = "";

// installAfterEach registers the router's post-navigation bookkeeping: close stray overlays,
// record the path for the Back affordance, clear in-memory ceremony material on departure from
// a ceremony route, set the chrome/active-route/rail state, and refresh the setup strip and the
// credentials count on real navigations.
function installAfterEach(router: Router, shell: Shell): void {
  router.afterEach((match) => {
    // Close any open overlay so a drawer/modal never outlives the screen it belonged
    // to (without firing its onClose, which would fight the navigation in progress).
    // A screen that opens a drawer for the resolved route opens it after this runs.
    closeAllOverlays();

    // Guard: the notFound handler navigates to "/" which causes the router to fire
    // afterEach twice - first with pattern="*" (the fallback) and then again once
    // the "/" redirect resolves. Skip active-nav and ceremony-clear on the transient
    // "*" call so the redirect's second call sets the correct nav state and
    // previousPattern is not incorrectly advanced to "*".
    if (match.pattern === "*") return;

    // Record the resolved PATH for the referrer-aware Back affordance (lib/nav). Paths
    // only, never query; a same-path replaceState (a list reflecting its filter) is
    // ignored inside recordNav so it never becomes its own referrer.
    recordNav(match.path);

    // Clear in-memory key ceremony material when navigating away from a ceremony or
    // keys route. Staying within the ceremony (e.g. step-to-step within /onboarding/:step)
    // is not a departure, so material is preserved for the duration of the wizard.
    // signOut() already clears ceremony material; this closes the navigation-away gap.
    if (CEREMONY_PATTERNS.has(previousPattern) && !CEREMONY_PATTERNS.has(match.pattern)) {
      clearSensitiveState();
    }
    previousPattern = match.pattern;

    // Attribute any subsequent console-diagnostics record to this screen (Wave C, invariant I3). What is
    // handed over is the resolved route TEMPLATE (for example "/downpipes/:id"), never the concrete path,
    // and screenFromPattern maps it through a table whose values are frozen screen LITERALS, so the value
    // stored is always a member of the closed vocabulary and a customer id could not survive the mapper
    // even if one reached it. Nothing is read from location/history/router params at emit time.
    setActiveScreen(match.pattern);

    const fullBleed = FULL_BLEED.has(match.pattern);
    shell.setChrome(!fullBleed);
    if (!fullBleed) shell.setActiveRoute(match.pattern);
    shell.closeRail(); // close the Compact slide-over after any navigation

    // While the guided setup is live, observe progress after each navigation (the
    // actions that complete a step happen on the step screens, so a step's
    // completion is seen within a navigation of it; the strip and rail re-shape).
    const setupView = getSetupView();
    if (setupView !== null && !setupView.complete) void refreshSetup(shell);
    // Refresh the credentials count chip on navigation too (coalesced), so it tracks the live count
    // over the whole session, a credential added/expired/cleaned on one screen is reflected on the
    // rail by the next navigation. Not a loop: it fires only on real navigations the operator drives.
    maybeRefreshExpiryCount(shell);
    // Keep the context-bar "Update available" chip honest on the same cadence, coalesced HARD to a
    // 15-minute floor inside (the read has the engine consult the vendor channel live). A /licence
    // visit primes the next refresh: an update applied there is reflected on the chip at the next
    // navigation, not up to 15 minutes later. Priming runs AFTER the coalesced refresh so landing
    // on /licence never adds a read of its own (the screen is already fetching the fresh verdict).
    maybeRefreshUpdateChip(shell);
    if (match.pattern === "/licence") primeUpdateChipRefresh();
  });
}

// installFocusRefresh re-reads the guided-setup facts and the credentials count when the tab
// regains focus: the remaining out-of-band setup steps (the source-binding deploy) complete in
// a terminal, and refocusing the console is the natural "did it land?" moment; a credential may
// also have expired while the tab was backgrounded.
function installFocusRefresh(shell: Shell): void {
  window.addEventListener("focus", () => {
    const setupView = getSetupView();
    if (setupView !== null && !setupView.complete) {
      forceRefreshSetup(shell);
    }
    // Re-read the credentials count on refocus too (coalesced): a credential may have expired while
    // the tab was backgrounded, and refocusing is the natural moment to reflect it on the rail.
    maybeRefreshExpiryCount(shell);
    // Same moment for the update chip (a release may have shipped while the tab was backgrounded);
    // still bounded by the chip's own 15-minute floor.
    maybeRefreshUpdateChip(shell);
  });
}

// firstIdentityApplied gates the one-time per-role landing redirect: it must run only on the FIRST
// identity resolution (the initial sign-in), never on a later refreshIdentity (e.g. after a role
// change), so the operator is not yanked off the screen they are on. The view-mode control reflect
// runs every resolve (it is idempotent and harmless).
let firstIdentityApplied = false;

// performSignOut is THE sign-out path, shared by the shell account menu, the Settings and
// Access "Sign out" buttons, and the palette's auth.sign-out (via the nav bridge), so a
// sign-out always genuinely ends what it can and the session does not survive Back.
function performSignOut(shell: Shell, router: Router): void {
  // Tell the engine to clear the passkey session cookie FIRST (before storeSignOut() drops the engine
  // client), so a passkey session is genuinely ended server-side and the __Host- cookie is removed, not
  // just forgotten locally. It is best-effort and fire-and-forget: a token/Access session has no cookie
  // to clear (the call is a harmless no-op), and a transport failure must never block sign-out. The
  // Access edge session, if any, is cleared at the edge, not here (the passkey screen states this).
  const engine = getEngine();
  // G123: this catch is the one whose silence has a SECURITY consequence, not merely a cosmetic one. The
  // console clears its own state and navigates away regardless, so the operator sees a completed sign-out; if
  // the call did not land, the __Host- passkey session cookie was NOT cleared server-side and the session is
  // still good. Nobody is told, on either side of the wire. The row says the teardown was attempted and did
  // not come back, which is what turns "I signed out and my session stayed alive" from an unfalsifiable
  // report into a checkable one.
  if (engine) void engine.passkeyLogout().catch((err: unknown) => recordReadDegraded("passkey-logout", err));
  storeSignOut();
  shell.setCaller(null, false);
  shell.setEngine({ host: null });
  // Return to the live sign-in (the passkey login), not the Access-only signed-out end state, so the
  // operator can sign straight back in with a passkey, Access or the token.
  router.navigate("/passkey");
}

// routeToSignIn is where an unauthenticated-but-reachable request lands: a 401 means the engine is up but
// the caller has NO valid credential (no Access session, no passkey session, no token). That is an
// ACTIONABLE state, not a dead end, so it routes to the passkey sign-in (/passkey) where the operator can
// sign in with a passkey OR follow the Access / token guidance the screen states. The intended URL is
// preserved as ?next= so a successful sign-in returns the operator where they were going. The console must work with passkey OR Access OR token: the passkey screen is a superset of the old
// signed-out guidance (it names Access and the token as the other ways in), so this is the right default.
// The /signed-out screen stays registered for a direct deep link, but the 401 default is the live sign-in.
//
// The capture itself is intendedNextFrom (lib/nav.ts): this can be called more than once in quick
// succession (every screen's own load-catch reacts to its own 401 independently), and that function is
// what stops a later, stale call from clobbering an earlier, correct capture with the bare "/" default.
function routeToSignIn(router: Router): void {
  const to = `/passkey?next=${encodeURIComponent(intendedNextFrom(router.current()))}`;
  router.navigate(to, { replace: true });
}

// registerRoutes binds each self-owned screen to the route pattern(s) it declares
//, straight from the descriptors via screenRoutes, so the router
// table is derived from the screens and the two cannot drift. A screen renders into the
// shell's main region at its measure; full-bleed screens render the same way but the
// afterEach hook above hides the chrome.
function registerRoutes(router: Router, shell: Shell): void {
  const bind = (pattern: string, screen: Screen) =>
    router.add(pattern, (match: RouteMatch) => {
      // The guided-setup gate (an intentional forcing function): while setup is
      // incomplete, a screen beyond the current step redirects to the step's home
      // with the reason. Fail-open by construction: no setupView, no gate. The
      // always-allowed set (Overview, Settings, Keys, onboarding, auth) passes.
      const setupView = getSetupView();
      if (setupView !== null && !setupView.complete && !setupAllows(pattern, setupView)) {
        toast({ message: `Step ${setupView.stepNumber} first: ${setupView.current.label.toLowerCase()}. The rest unlocks as you go.`, tone: "info" });
        // DEFERRED redirect: the router fires afterEach for THIS match after the
        // handler returns, so navigating synchronously here would interleave the
        // two navigations' afterEach calls (redirect first, blocked route second)
        // and leave previousPattern/active-nav state crossed, including a wrong
        // ceremony-material clear. A microtask lets this resolve complete, then
        // redirects cleanly (the same discipline as the palette's route landing).
        const target = setupView.current.route;
        queueMicrotask(() => router.navigate(target, { replace: true }));
        return;
      }
      renderScreen(shell, router, screen, match);
    });

  // Overview owns "/", but its route carries the first-run redirect to onboarding when
  // the engine is not connected (the redirect fires only when no engine client is
  // connected at all), so it
  // is wired here rather than through the plain bind. Its declared route is "/" (asserted
  // below so the descriptor and this special case stay in step).
  if (routesOf(overviewScreen).join(",") !== "/") {
    throw new Error(`overviewScreen.route must be "/" (got ${routesOf(overviewScreen).join(",")})`);
  }
  router.add("/", (match) => {
    if (!getEngine()) {
      router.navigate("/onboarding/connect", { replace: true });
      return;
    }
    renderScreen(shell, router, overviewScreen, match);
  });

  // Every other screen binds straight from its descriptor's route(s).
  screenRoutes(SCREENS, bind);

  // Unknown path: send to Overview (which itself redirects to onboarding when the
  // engine is unconnected). Honest, never a dead end.
  //
  // ...but it WAS a silent one. The redirect is right for the operator and it left support blind: a customer who
  // clicked a deep link in an alert e-mail lands on the dashboard and nothing says a link was lost. The state
  // that matters is not a typo, it is a console version that RENAMED or REMOVED a route, after which every alert
  // link already in flight dead-ends for everyone, silently. recordDeepLinkLost is the producer the
  // `deep-link-lost` kind never had; it records the FACT and never the path (an unroutable path is
  // customer-influenced and routinely carries a downpipe id).
  router.notFound(() => {
    recordDeepLinkLost();
    router.navigate("/", { replace: true });
  });
}

// lastRender holds the screen + matched route the main region is CURRENTLY showing, plus the identity
// render key it was painted against, so resolveIdentity can re-render exactly that screen once the verified
// caller lands (closing the identity-stale-gate race; see reRenderCurrentScreenForResolvedIdentity).
// renderScreen is the single place a screen is painted, so it is the single place this is recorded; a
// redirect (the setup gate, notFound, the first-run onboarding bounce, a role landing) paints its target
// through renderScreen too, so this always names the screen actually on screen and the identity it was
// gated against.
let lastRender: { screen: Screen; match: RouteMatch; identityKey: string } | null = null;

// identityRenderKey is the render-relevant fingerprint of a caller: the exact inputs a screen's CLIENT
// capability/role gates read (the role, the effective custom-role capability set, and the only-owner
// pre-empt) and NOTHING display-only (email, subject, session expiry, groups). Two callers with the same
// key gate every control identically, so a whoami refresh that only slides the session expiry or
// re-reports the same authority is NOT a change and never re-renders the screen. A null caller (whoami
// still pending) maps to a sentinel distinct from every resolved caller (every resolved key starts with a
// role name and carries two "|" separators, which "<pending>" cannot), so the first successful resolve
// always reads as a change against a screen painted while pending. This is the guard that keeps the
// identity re-render one-shot and off the poll path.
function identityRenderKey(c: Caller | null): string {
  if (!c) return "<pending>";
  const caps = c.customCapabilities ? [...c.customCapabilities].sort().join(",") : "";
  return `${c.role}|${caps}|${c.isOnlyOwner ? "1" : "0"}`;
}

// renderScreen renders a screen into the shell, mapping a thrown 401 to the
// signed-out route through the router (channel two of the error model;
//, so chrome and history stay consistent. It builds the screen's
// render context (the matched route + the live engine + caller + navigate) via
// makeScreenContext, so every screen receives the same consistent ctx; a screen may
// read the whole ScreenContext or just the RouteMatch fields. Screen render() is
// synchronous; should a screen become async in its own load path, the same 401
// mapping applies there.
//
// `renderOpts.quiet` marks a same-screen re-render (the identity re-render): the body is swapped in place
// with no cross-fade and no focus move, and the title/announcer are left untouched (the screen and its
// title have not changed, so re-announcing would be spurious screen-reader chatter).
function renderScreen(shell: Shell, router: Router, screen: Screen, match: RouteMatch, renderOpts?: { quiet?: boolean }): void {
  try {
    const ctx = makeScreenContext(match, {
      engine: getEngine(),
      caller: getCaller(),
      navigate: (to, opts) => router.navigate(to, opts),
    });
    const node = screen.render(ctx);
    if (!renderOpts?.quiet) shell.setTitle(screen.title);
    shell.setMain(node, screen.measure, renderOpts);
    // Record what is now on screen and the identity it was gated against, so resolveIdentity can re-render
    // THIS screen once the verified caller lands. After a successful paint only: a render that threw 401
    // above redirected to sign-in, which paints (and records) the sign-in screen instead.
    lastRender = { screen, match, identityKey: identityRenderKey(getCaller()) };
  } catch (err) {
    if (isUnauthorised(err)) {
      // Route through the one sign-in path so chrome (full-bleed), the history entry,
      // and the preserved intended URL are all handled consistently. An unauthenticated
      // but reachable engine lands on the live passkey sign-in, not a dead 401.
      routeToSignIn(router);
      return;
    }
    throw err;
  }
}

// reRenderCurrentScreenForResolvedIdentity re-paints the on-screen screen once the verified caller has
// landed, which is the fix for the identity-stale-gate race (lib/client-diag/identity-gate.ts): a hard
// reload or deep link onto an owner-gated screen (/security, /security/owner-actions, /access/roles/builder)
// paints it while whoami is in flight, its client gates fall back to the fail-closed `viewer` default, and
// until now nothing re-rendered the screen when the report arrived -- so the owner controls stayed disabled
// (populate absent, retire "owner only") until a manual re-nav. This is that missing re-render, and it is
// deliberately narrow:
//   - It fires only from the SUCCESS branch of resolveIdentity, AFTER setCaller stored the whoami-VERIFIED
//     caller, so it can never paint owner controls enabled before the caller is confirmed owner: the initial
//     paint stays fail-closed-while-pending, and this only ever RE-enables once resolved.
//   - It re-renders ONLY when the resolved identity would gate the current screen differently from the key
//     it was last painted with, so a same-identity whoami refresh (the focus refresh, a post-action
//     refreshIdentity) does not touch the screen and any mid-edit state is preserved on every poll but the
//     one that genuinely changes the caller.
//   - A first-resolve landing redirect (a custom role's non-Overview landing) has already navigated,
//     painting the target through renderScreen and advancing lastRender.identityKey to the resolved key, so
//     the guard here sees no change and does not double-render.
//   - The re-render is QUIET (no cross-fade, no focus move), so the controls simply enable in place with no
//     flicker and without stealing focus. renderScreen never calls resolveIdentity, so there is no loop.
function reRenderCurrentScreenForResolvedIdentity(shell: Shell, router: Router, forceForBlindGate: boolean): void {
  if (!lastRender) return;
  // Re-render when the resolved identity would gate the current screen differently from the key it was painted
  // with, OR (B32) when the on-screen screen has a gate that ran blind: a same-identity re-resolve during which
  // a LATE ASYNC gate fell back to the fail-closed `viewer` default, which the identityKey guard alone misses
  // (the resolved caller equals the first-paint caller, so the key is unchanged). This only ADDS a re-render in
  // that proven-race case and cannot loop (renderScreen never calls resolveIdentity; post-resolve the gate is no
  // longer blind, so nothing re-adds to the witness), and cannot weaken the same-identity poll optimisation.
  if (lastRender.identityKey === identityRenderKey(getCaller()) && !forceForBlindGate) return;
  renderScreen(shell, router, lastRender.screen, lastRender.match, { quiet: true });
}

// wirePalette wires the command palette open paths: the shell's trigger (and the "/" focus that
// lands on it) and the global Cmd/Ctrl-K both open it. It is fed by the one assembled REGISTRY so
// its gated set matches the go-to chords and the cheat-sheet, and it reads the live caller + engine
// from the store at open time (gating exactly as the screens do). Dangerous commands open their
// owning screen's review flow via defaultDispatch; they never run from the palette. The overlay is
// torn down by the router's closeAllOverlays on a real navigation (a chosen command navigates), so
// it never outlives the screen it opened on. Opening uses the registered default registry +
// dispatcher (set in boot via setPaletteRegistry), so the trigger, Cmd/Ctrl-K and the route landing
// share one set.
function wirePalette(shell: Shell): void {
  const openPalette = (): void => {
    openCommandPalette();
  };
  shell.onOpenPalette(openPalette);

  // Cmd/Ctrl-K from anywhere opens the palette (the shell's own key layer deliberately
  // ignores modified keys, so this is the one chord that uses a modifier). It is inert
  // while a field or an overlay owns the keyboard is not needed here: opening the palette
  // is always safe, and the palette's own guard refocuses rather than stacking a second.
  document.addEventListener("keydown", (ev: KeyboardEvent) => {
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      openPalette();
    }
  });
}

// wireShell connects the shell's navigate / palette / sign-out handlers to the app.
function wireShell(shell: Shell, router: Router): void {
  // Route the rail/shell navigation through the GUARDED navigate (lib/nav), so a
  // dirty-form leave guard (the create-downpipe wizard) can prompt "Discard?" on a rail
  // click too, not only on screen-initiated navigations. With no guard registered this
  // is identical to router.navigate. Forced redirects (the setup gate, a 401) keep using
  // router.navigate directly and are deliberately never blocked by a dirty form.
  shell.onNavigate((route) => navigate(route));

  wirePalette(shell);

  shell.onSignOut(() => performSignOut(shell, router));

  // The view-mode toggle: the operator flipped between the executive (shiny) framing and the
  // technical console. Persist the per-user override (it wins over the role default), reflect it in
  // the control, and re-resolve the CURRENT route so the active screen re-renders in the new
  // framing (a replace navigation keeps the history entry and the URL). Only the screens that read
  // the view mode (Overview today) change shape; the rest render identically.
  shell.onViewMode((mode: ViewMode) => {
    setViewMode(mode);
    shell.setViewMode(mode);
    const current = router.current();
    const to = current.path + (current.query.toString() ? `?${current.query.toString()}` : "");
    router.navigate(to, { replace: true });
  });

  // Reflect the current connection in the engine chip. Health is not surfaced in the
  // chip (it renders no status lamp): the real health verdict is shown in the Overview
  // screen's own content area, which probes engine health directly. The chip records
  // the host, which is the honest state before a health probe. The host comes from the
  // remembered URL in the store, never by reaching into the client's internals.
  if (getEngine()) {
    shell.setEngine({ host: hostOf(getEngineUrl()) });
  }
}

// resolveIdentity asks the engine for the verified caller (whoami, D1). On success
// the shell shows the real identity, role and (later) session expiry. On a 404/501
// or a transient network failure it degrades honestly: the shell shows "Identity from
// Cloudflare Access" without faking it. A 401 routes to signed-out. The console
// never shows a green verified chip it cannot back (F7).
//
// On the FIRST resolve it also applies the caller's per-role PRESENTATION: the view-mode control
// reflects the resolved framing (the role default or the operator's stored override), and a custom
// role with a non-Overview landing opens the operator there IF they are still on the default entry
// ("/"). The landing redirect is one-time (firstIdentityApplied) and only from "/", so a deep link
// is never overridden and a later role-change refresh never yanks the operator off their screen.
async function resolveIdentity(shell: Shell, router: Router): Promise<void> {
  const engine = getEngine();
  if (!engine) return;
  try {
    const who = await engine.whoami();
    const caller = buildCallerFromWhoami(who);
    setCaller(caller);
    setWhoamiAvailable(true);
    // A resolve clears any earlier fault, so a tab that recovered (a redeployed engine, a widened Access
    // policy) stops offering the remedy for a failure that is over.
    setIdentityFault(null);
    // setCaller on the shell re-curates the rail to the resolved surface and reflects the view mode.
    shell.setCaller(getCaller(), isWhoamiAvailable());

    // G155: THE IDENTITY HAS LANDED. Any capability gate that already ran, on any screen, ran against the `viewer`
    // default because this round trip had not returned; nothing re-renders those screens now that it has. The
    // witness holds the screens that gated themselves blind, and this is the moment the race is PROVEN: it emits
    // one identity-stale-gate row per such screen. A screen gated AFTER this point produces nothing, so a genuine
    // viewer and an Owner who beat the whoami are no longer the same (empty) evidence.
    // B32: capture whether the ON-SCREEN screen has a blind gate BEFORE noteIdentityLanded() clears the
    // witness, so reRenderCurrentScreenForResolvedIdentity below can re-render it even when the resolved
    // caller's render key is UNCHANGED (a same-identity re-resolve during which a late async gate ran blind).
    const currentScreenWasBlind = currentScreenGatedBlind();
    noteIdentityLanded();

    // Resolve the guided-setup state now that an authenticated read is possible
    // (fire-and-forget: the strip and gating engage when it lands; fail-open).
    forceRefreshSetup(shell);
    // Surface the credentials "needs attention" count chip on the rail from the same authenticated
    // status read (fire-and-forget, fail-open). Runs on first sign-in and on every refreshIdentity()
    // (which screens trigger after a credential action), so the chip tracks the live count without a
    // polling loop.
    void refreshExpiryCount(shell);
    // Resolve the context-bar "Update available" chip from the same authenticated moment (the
    // first genuine chance an /admin/updates read can succeed). Fire-and-forget, fail-open, and
    // coalesced to the chip's 15-minute floor across later identity refreshes.
    maybeRefreshUpdateChip(shell);

    // Apply the per-role landing + view mode ONCE, on the first sign-in only.
    if (!firstIdentityApplied) {
      firstIdentityApplied = true;
      // G302: the CONSOLE/ENGINE VOCABULARY SKEW, recorded at the one seam that sees the caller's resolved
      // custom role. Both of these are silently normalised today and both cost the operator something they then
      // report as a defect:
      //
      //   an unknown CAPABILITY is stripped from the role's effective set, so a custom-role holder loses the
      //   buttons it gates and reports "my permissions are wrong"; and
      //   an unknown LANDING id falls back to Overview, so an executive lands on the wrong screen, every time.
      //
      // Both fall out of an engine update or a rollback, and the console has never said anywhere that it saw
      // something it did not recognise, so version skew and a console bug are the same evidence. The two are
      // separate fieldFamily members and separate rows: they are different symptoms with different remedies, and
      // as one row they would coalesce into whichever fired first. The unrecognised STRINGS never ride.
      const cr = getCaller()?.customRole ?? null;
      if (cr) {
        const unknownCaps = unknownCapabilityCount(cr);
        if (unknownCaps > 0) recordContractSkew("unknown-enum-member", "role-capability");
        if (!isKnownLandingScreen(cr.landing)) recordContractSkew("unknown-enum-member", "landing-screen");
      }
      // Reflect the resolved view mode (role default, or the operator's stored override) in the
      // control. shell.setCaller already did this, but doing it explicitly keeps the intent clear.
      shell.setViewMode(resolveViewModeForCaller(getCaller()));
      // Land on the role's most relevant screen, but only when the operator is still on the default
      // entry ("/"); a deep link (e.g. they followed a link to /restore/:id) is never overridden.
      const landing = landingRouteForCaller(getCaller());
      if (landing !== "/" && router.current().path === "/") {
        router.navigate(landing, { replace: true });
      }
    }

    // Close the identity-stale-gate race (lib/client-diag/identity-gate.ts): a hard reload / deep link
    // paints a screen while whoami is still in flight, its capability gates fall back to the fail-closed
    // `viewer` default, and until now NOTHING re-rendered it when the report arrived -- so a genuine Owner
    // sat looking at disabled owner controls (populate absent, retire "owner only") until a manual re-nav.
    // Now that the VERIFIED caller is stored, re-render the on-screen screen so its owner/role controls
    // reflect the real identity. Guarded + quiet (see the helper): a no-op when nothing gating-relevant
    // changed or a first-resolve landing redirect already repainted, and it can never enable owner controls
    // before the caller is confirmed (it runs only here, in the success branch, from the verified caller).
    reRenderCurrentScreenForResolvedIdentity(shell, router, currentScreenWasBlind);
  } catch (err) {
    if (isUnauthorised(err)) {
      // The session is not valid; the next guarded navigation will route to
      // signed-out. Keep the honest degrade in the chip meanwhile.
      //
      // NOT RECORDED (noise discipline): a 401 here is the ordinary lapsed session, which is what the
      // signed-out route exists for. Recording it would put an identity fault in the pack every time a session
      // expired, and a signal that fires on the healthy path devalues the one below.
      shell.setCaller(null, false);
      return;
    }
    // whoami absent (D1 pending) or transient: honest degrade, never a faked role.
    //
    // G155: RECORD THAT THE IDENTITY REPORT WAS ABSENT, NOT LOW. From here every capability gate in the console
    // reads caller() as null and falls back to the least-privileged `viewer` (screens/*/shared.ts callerRole,
    // credentials, notifications, security-centre, the role builder, the command palette). An actual OWNER then
    // sees a console with every control greyed out and "owner only" beside it, and reports exactly that. The
    // two states, "your role is viewer" and "we never learned your role", were indistinguishable in the tab and
    // absent from the pack. This row is the difference, and httpClass separates an engine that REFUSED the read
    // (4xx/5xx) from one that could not be REACHED (network/timeout), which is a different remedy.
    // G123: httpClass ALONE COALESCES 404 WITH 403. httpClassForStatus collapses 401, 403 and 404 alike to "4xx",
    // so a whoami 404 -- an OLDER ENGINE THAT DOES NOT SERVE THE ROUTE (the "whoami absent (D1 pending)" cause of
    // the very "identity pending" chip in the ticket) -- and a whoami 403 produced the byte-identical row and
    // coalesced into it. Route-absent is the state the gap explicitly asks to be told apart, and it was the one
    // that could not be. The recorder now carries faultClass too, which maps 404 to "not-found" and 401/403 to
    // "auth": upgrade the engine, or fix the caller's access. Two rows, two remedies.
    const httpClass = httpClassForThrown(err);
    if (httpClass !== "aborted") recordIdentityUnresolved(httpClass, err);
    // AND PUT THE SAME DISTINCTION WHERE THE CUSTOMER IS. faultClassForError has always separated
    // not-found (the engine predates the route, so update it) from auth (the read was refused, so fix
    // access) from transport (it could not be reached), and it put both in the support pack ONLY. From
    // here every gate in the console refuses because the role could not be read, and until now it STOPPED there,
    // which is a dead end the console had the answer to the whole time. This adds no gate and lifts none;
    // see lib/identity-remedy.ts.
    setIdentityFault(identityFaultFrom(faultClassForError(err)));
    setWhoamiAvailable(false);
    shell.setCaller(null, false);
  }
}

// hostOf extracts the host for the engine chip from the remembered engine URL.
// Best-effort; never throws. House rule: the host is always a custom domain (the
// connect flow enforces "never *.workers.dev"); this only displays it.
function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Boot once the DOM is ready (the script is a module, so it runs after parsing; a
// readiness guard keeps it safe if the host is not yet present).
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  void boot();
}
