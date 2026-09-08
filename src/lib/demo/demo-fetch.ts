// The faked-backend fetch interceptor for the public, no-login product tour.
// It is a hand-rolled, one-file equivalent of Mock Service Worker with NO new runtime dependency (the
// console ships only @noble), in keeping with the zero-dependency discipline: it replaces globalThis.fetch
// with a wrapper that answers any request whose URL path is under /admin/ from the in-browser demo engine
// (demo-routes-read.route), and delegates everything else (static assets, /engine-topology.json) to the real fetch.
//
// This is THE single chokepoint that fakes the entire backend: every console screen reads and writes
// through the typed EngineClient, which always issues the global fetch against `${base}/admin/...`, so
// intercepting that one path fakes all of it with zero changes to the 24 domain modules and the 66 screens.
//
// Because it is the one chokepoint, it is also where the SIMULATED-action cue fires: when a visitor makes a
// genuine WRITE in tour mode (a state-changing /admin/* call the faked engine actually applies or queues), a
// reassuring, debounced toast tells them it was a local simulation against sample data, so a public demo never
// feels alarmingly real. Reads (GET) and routine polls never trigger it, and an honest refusal (a dual-control
// 403, an unmodelled 501) does not either.
//
// House rules: Australian English, precise claims.

import { toast } from "../../components/toast.ts";
import { buildCallerFromWhoami } from "../app-identity.ts";
import { connect, setCaller, setWhoamiAvailable } from "../store.ts";
import { installTourBanner, installTourCornerMarker, installTourSiteLink, swapTourFavicon, TRAINING_BANNER_TEXT } from "./banner.ts";
import { noteTourDegraded, type TourChromeComponent } from "./demo-drift.ts";
import { notifyDemoRoute } from "./demo-route-signal.ts";
import { route } from "./demo-routes-read.ts";
import { demoStateFromLocation, demoStateLabel } from "./demo-state.ts";
import { applyDemoState, demoWhoami } from "./demo-world.ts";
import { enableTourAnalytics, readTourAttribution } from "./tour/analytics.ts";
import { startTour } from "./tour/persona-fork.ts";
import { startTrainingWalk } from "./tour/training-walk.ts";
import { mountPricingPill } from "./tour/pricing-pill.ts";
import { isTourMode } from "./tour-mode.ts";
import { isTrainingMode } from "./training-mode.ts";

// isTourMode is the cheap boot guard. It lives in its own dependency-free module (tour-mode.ts) so app.ts can
// import the guard statically WITHOUT statically reaching this module (and the whole tour subtree it pulls
// in): the genuine console evaluates only isTourMode on the default bundle, and loads startDemo() + everything
// below through a dynamic import once the guard is true, so esbuild's splitting keeps the tour out of the
// default app.js. It is re-exported here so the established import site (demo-fetch.ts) is unchanged for
// callers and the contract guards (test/validate-tour.ts, test/cov/lib-demo.ts).
export { isTourMode } from "./tour-mode.ts";

// urlOf extracts the request URL string from the three shapes the Fetch API accepts as the first argument
// (a string, a URL, or a Request). The console only ever passes a string for /admin/*, but handling all
// three keeps the interceptor correct for any caller and lets a Request's url drive the path match.
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

// isAdminPath tests whether a request URL targets the engine admin surface (/admin/...), the one path the
// faked engine answers. It resolves the URL against the current origin so a relative `/admin/...` (or an
// absolute same-origin one) both match, and treats an unparseable URL as NOT an admin path (so it falls
// through to the real fetch rather than being swallowed).
function isAdminPath(url: string): boolean {
  try {
    return new URL(url, location.origin).pathname.startsWith("/admin/");
  } catch {
    return false;
  }
}

// isMutatingMethod reports whether an HTTP method is state-changing (a genuine user WRITE), so the simulated-
// action cue fires only for those and never for a read (GET) or a routine background poll (also a GET). The
// method defaults to GET when none is given, exactly as the Fetch API does.
function isMutatingMethod(method: string | undefined): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

// The simulated-action cue copy. Reassuring and precise: the write was a local simulation against sample data
// in the visitor's own browser; nothing left it; it resets on reload. No em dash (house rule).
const SIMULATED_CUE_TEXT = "Simulated action: sample data only, nothing left your browser. Resets on reload.";
// The debounce window for the cue: a burst of writes (a multi-call flow) shows ONE toast after the burst
// settles, rather than stacking a pile of them.
const SIMULATED_CUE_DEBOUNCE_MS = 500;
// The pending-debounce timer for the cue (module-scoped so a burst across separate fetch calls coalesces).
let simulatedCueTimer: ReturnType<typeof setTimeout> | null = null;

// simulatedCueShowing reports whether an IDENTICAL simulated-action toast is currently visible: the debounce
// coalesces a burst, but a second write landing after the window (yet inside the toast's ~5s life) would stack
// the same message twice, so the cue is skipped while its twin is still on screen. Best-effort: a DOM read
// fault reads as not-showing (the cue then fires normally).
function simulatedCueShowing(): boolean {
  try {
    const msgs = document.querySelectorAll(".toast-region .toast__msg");
    for (let i = 0; i < msgs.length; i++) {
      if ((msgs[i]?.textContent ?? "") === SIMULATED_CUE_TEXT) return true;
    }
  } catch {
    // No document / selector fault: treat as not showing.
  }
  return false;
}

// noteSimulatedWrite shows the "this was simulated" toast, debounced. It is called ONLY for a genuine,
// successful user mutation in tour mode (a state-changing /admin/* call that did not honestly refuse): it
// reassures the visitor that the write they just made is a local simulation against sample data, not a real
// action, so a public demo never feels alarmingly real. Best-effort: a toast fault never breaks the fetch.
function noteSimulatedWrite(): void {
  if (simulatedCueTimer !== null) clearTimeout(simulatedCueTimer);
  if (typeof setTimeout !== "function") return;
  simulatedCueTimer = setTimeout(() => {
    simulatedCueTimer = null;
    if (simulatedCueShowing()) return; // an identical cue is already on screen; never stack the same message
    try {
      toast({ message: SIMULATED_CUE_TEXT, tone: "info" });
    } catch {
      // A DOM hiccup showing the cue is non-fatal: the simulated write already happened; the banner still
      // states the demo is sample data, so the honesty posture holds without this transient confirmation.
    }
  }, SIMULATED_CUE_DEBOUNCE_MS);
}

// installed guards against a double install (a second installDemoFetch would wrap the already-wrapped
// fetch and lose the real one); the interceptor is installed exactly once per page load.
let installed = false;

// installDemoFetch replaces globalThis.fetch with the interceptor. For an /admin/* request it returns the
// demo engine's synchronous Response wrapped in a resolved promise (so the call signature stays a normal
// async fetch); every other request goes to the saved real fetch unchanged. Idempotent: a second call is a
// no-op so the real fetch reference is never lost. Returns the real fetch so a caller (or a test) can
// restore it. This is the only place globalThis.fetch is reassigned.
export function installDemoFetch(): typeof fetch {
  // Capture the original reference (not a bound copy) so the returned value IS the real fetch a caller can
  // restore by identity. The console invokes fetch as a free function throughout (never relying on a bound
  // receiver), so calling realFetch(input, init) below is exactly the existing call shape.
  const realFetch = globalThis.fetch;
  if (installed) return realFetch;
  installed = true;

  const demoFetch: typeof fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (isAdminPath(url)) {
      // The faked engine answers synchronously from the in-memory world; wrap it in a resolved promise so
      // the caller sees a normal fetch. A Request's own method/body is honoured by reading them off the
      // Request when no explicit init was passed, so a future fetch(new Request(...)) write still routes.
      const effectiveInit = init ?? (input instanceof Request ? { method: input.method } : undefined);
      // route() returns a Response synchronously for reads + simple writes, and a Promise<Response> for the
      // four async restore dual-control writes (they await a SHA-384 plan hash); Promise.resolve flattens both.
      const settled = Promise.resolve(route(new URL(url, location.origin).pathname + new URL(url, location.origin).search, effectiveInit));
      // The SIMULATED-action cue (tour mode only): when the visitor makes a genuine WRITE (a state-changing
      // method) that the faked engine ACTUALLY applied or queued (a 2xx success or a 202 pending), reassure
      // them it was a local simulation against sample data, so a public demo never feels alarmingly real. It
      // fires ONLY for mutating methods (never a GET read or a routine poll), ONLY in tour mode, and NOT for an
      // honest refusal (a 403 dual-control gate, a 501 unmodelled): those are real demo behaviours the screen
      // explains, and nothing was simulated to confuse the visitor. Debounced so a burst of writes shows one
      // toast. Best-effort + non-blocking: the response is returned unchanged whether or not the cue fires.
      if (isMutatingMethod(effectiveInit?.method)) {
        void settled.then((res) => {
          try {
            if ((res.ok || res.status === 202) && (isTourMode(location) || isTrainingMode(location))) noteSimulatedWrite();
          } catch {
            // A location read fault (some embedding contexts) must not break anything; skip the cue.
          }
        });
      }
      // The route-signal listeners fire AFTER the response settles, reads and writes alike (see
      // demo-route-signal.ts): the training walk's task graders re-evaluate on this signal.
      void settled.then(notifyDemoRoute, notifyDemoRoute);
      return settled;
    }
    return realFetch(input, init);
  };

  globalThis.fetch = demoFetch;
  return realFetch;
}

// installChrome mounts ONE honesty-chrome component under its own guard, so one component's failure can never
// take the others down with it, and records the failure with the component's id. The id is a member of
// the closed TourChromeComponent union, not a bare string: nothing read from the DOM, from a caught exception or
// from the visitor can be passed here even by a future caller who wanted to.
function installChrome(component: TourChromeComponent, mount: () => void): void {
  try {
    mount();
  } catch {
    noteTourDegraded("chrome-install-failed", component);
  }
}

// startDemo is the no-login boot entry the guarded branch in app.ts calls before the existing boot runs. It
// installs the interceptor and points the store at this origin (connect(location.origin)) so the app is
// "connected" without a sign-in: the existing boot then resolves the seeded owner from the faked whoami,
// reads the demo status/setup-state, and lands on the Overview as a verified owner with no engine. It does
// NOT alter any existing boot logic; it only stands up the faked backend the unchanged boot then drives.
export function startDemo(): void {
  installDemoFetch();
  // The demo-state fixture knob (demo-state.ts): a `?demo-state=`
  // query value re-shapes the just-seeded world (empty / minimal / aged / role:<r>) BEFORE anything primes
  // the caller below or a screen reads it. Absent/unrecognised values are the existing default seed,
  // byte-unchanged, so this is a no-op for every visitor who never passes the flag (including every
  // existing tour/demo visitor and the whole pixel-baseline pass). The stamped marker is a cheap,
  // screen-agnostic proof a test can read (readDemoStateMarker, harness lib/visual-state-driver.ts) that
  // the knob actually reached the booted app, distinct from any screen-specific render assertion.
  // Training mode FORCES the training-start variant (a fresh account, the setup gate engaged, dual
  // control off): the walk's whole premise is the gated first run, so the query knob cannot override it.
  const demoState = isTrainingMode() ? ({ kind: "training-start" } as const) : demoStateFromLocation();
  applyDemoState(demoState);
  try {
    document.documentElement.dataset.demoState = demoStateLabel(demoState);
  } catch {
    // A DOM hiccup stamping the marker is non-fatal: the world is already reshaped either way.
  }
  // connect(location.origin) sets the engine URL to THIS origin (the faked surface), so the store builds the
  // one EngineClient and the app reads as connected. No token, no secret: the interceptor answers every
  // /admin/* call locally, so nothing leaves the browser.
  connect(location.origin);
  // PRIME the store's caller SYNCHRONOUSLY from the demo seed, so the very first render already sees the
  // verified owner. app.ts's resolveIdentity() fetches whoami in the BACKGROUND and only then setCaller(), so
  // the store's caller starts null; a free-explore screen that renders BEFORE that async fetch resolves would
  // otherwise see caller() === null and hide owner-gated UI (the Overview "needs your attention" pending-approval
  // item, the Approve button on /restore/approvals). startDemo runs at the very top of boot, before the router
  // and before resolveIdentity, so priming here makes the owner present from the first paint. It uses the SAME
  // buildCallerFromWhoami mapping over the demo's seed whoami (read straight off the world, no engine call this
  // early), so the primed caller is byte-identical to the one resolveIdentity later builds and redundantly sets
  // (harmless). It only seats the store caller + whoamiAvailable; the shell top-bar still updates via
  // resolveIdentity exactly as before, so nothing in the real (non-tour) console boot changes. Best-effort: a
  // shaping fault must never block the no-login boot (resolveIdentity still resolves the owner shortly after).
  try {
    setCaller(buildCallerFromWhoami(demoWhoami()));
    setWhoamiAvailable(true);
  } catch {
    // A shaping hiccup is non-fatal: resolveIdentity resolves the owner a beat later from the same seed whoami.
  }
  // The persistent honesty banner ("Demo. Sample data. Resets on reload."), the DEMO corner marker, the site
  // link, the tour favicon and the pricing pill. They are installed ONLY here (the distinct tour-mode signal,
  // not the engine's throwaway demoMode flag), so they label the faked tour at all times and never render on the
  // genuine console. Idempotent: a redundant startDemo never stacks a second banner. Best-effort: a mount fault
  // must never block the no-login boot the faked backend stands up.
  //
  // The honesty chrome installs one component at a time, each in its OWN guard. It used to be a SINGLE
  // try around all five: the first failure dropped every later one, so a banner mount that threw could leave the
  // tour running with NO DEMO LABELLING AT ALL -- no banner, no corner marker, no site link, no favicon swap --
  // on a public surface whose entire integrity rests on being visibly a demo. That is the cascade the gap names,
  // and splitting the catch is the fix: a component that fails now costs only itself. Each failure is recorded
  // with the component that failed, so the labelling that is missing can be named rather than guessed at.
  //
  // Analytics are enabled BELOW this block, and deliberately so for the rest of the boot, but these events must
  // not be lost: enableTourAnalytics is called first so a chrome failure is actually emitted.
  //
  // The campaign attribution read comes first still: the website's tour links (and the /go/ campaign
  // redirects) carry ?src=, and readTourAttribution admits it through a conservative shape gate so emit()
  // can attach it to tour_started and cta_clicked. It must be read before the welcome card mounts (the
  // welcome's mount emits tour_started), and reading it beside the demo-state knob keeps every query
  // parameter the tour honours read in this one boot entry.
  readTourAttribution();
  enableTourAnalytics();
  // The honesty chrome reads as what the surface IS: the tour is a demo and says DEMO; the training walk
  // is a course and says TRAINING, with the banner naming the course. Same components, same guards, same
  // honesty; only the words follow the mode. The free-roam pricing pill is tour-only: a course a learner
  // chose to take is not a funnel, and marketing chrome inside it would read as exactly that.
  const training = isTrainingMode();
  installChrome("tour-banner", () => void installTourBanner(document, training ? TRAINING_BANNER_TEXT : undefined));
  // The screenshot-robust demo marker: a fixed top-right "DEMO" badge at a z-index ABOVE modals/toasts/palette/
  // tooltips, so the tour reads unmistakably as a demo even with a dialog open or in a cropped screenshot (the
  // bottom banner is hidden by an overlay and croppable). Plus a tour-distinct favicon so the tab icon is not
  // identical to the real console.
  installChrome("tour-corner-marker", () => void installTourCornerMarker(document, training ? "TRAINING" : undefined));
  // The standing way BACK to the marketing site: a persistent "downpipes.io" button directly below the DEMO
  // marker, always visible in both guided and free-roam modes (the funnel is deliberately bidirectional).
  installChrome("tour-site-link", installTourSiteLink);
  installChrome("tour-favicon", swapTourFavicon);
  // The free-roam pricing affordance: one quiet "See pricing" pill above the tour pill slot, appearing after a
  // minute of genuine exploration and hiding whenever the guide's chrome is up.
  if (!training) installChrome("tour-pricing-pill", mountPricingPill);
  // The funnel analytics are already on (enabled above the chrome installs so a chrome failure is emitted): from
  // here the tour emits its small, PII-free funnel events (tour started, per-step reached, the drop step, the
  // ending CTA clicked) to the owner's own Cloudflare Workers Analytics Engine via a same-origin beacon, with no
  // third-party tracker. Best-effort by construction: emit() is fire-and-forget and never blocks boot.
  // The welcome card is the tour's FIRST interaction (DESIGN). startDemo runs at the TOP of boot, before the
  // existing router.start() paints the first screen, so the welcome mount is deferred a task: it then appears
  // OVER the booted Overview as the opening greeting, rather than before the app has rendered. The welcome is
  // position:fixed, so it does not depend on the screen DOM; deferring only sequences it after the first
  // paint. Best-effort: a mount fault must never block the no-login boot the faked backend stands up.
  if (typeof setTimeout === "function") {
    setTimeout(() => {
      try {
        // Training mode launches the task-gated training walk directly (no persona fork: the walk IS the
        // experience, and its first chapter is the onboarding deck a fresh account would meet anyway).
        if (isTrainingMode()) startTrainingWalk();
        else startTour();
      } catch {
        // A DOM hiccup mounting the fork is non-fatal: the demo still boots and the visitor can explore the
        // genuine, faked app; the fork is the tour's entry, never a boot gate. It is also the tour's FIRST
        // interaction, so a visitor who never saw the welcome is a visitor who never had a tour, and in the
        // funnel that has always been indistinguishable from one who chose not to take it.
        noteTourDegraded("welcome-mount-failed");
      }
    }, 0);
  }
}
