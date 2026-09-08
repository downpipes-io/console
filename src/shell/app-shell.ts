// The app shell: a three-zone
// CSS grid of the nav rail, the context bar, and the main content region, with real
// landmarks, a skip-to-content link, the single locked brand mark, the
// command-palette trigger, the engine identity chip, and the account/session area.
// Built framework-light from lib/dom.ts + tokens.css. The router drives setMain()
// and setActiveRoute(); the shell owns the chrome, the rail collapse/slide-over,
// and the keyboard layer (roving rail, go-to chords, the skip link).
//
// A11y: <header>/<nav aria-label="Primary">/<main id="main">
// landmarks; a skip link is the first focusable element; aria-current="page" on the
// active item; the collapse control is a labelled button with aria-expanded; on
// Compact the rail is a focus-trapped slide-over that restores focus on close.
// Roles gate IN-SCREEN controls, not rail items (nav.ts), so the rail is the same
// for every role.
//
// This is the shell entry. It assembles the DOM once and returns the Shell handles; the
// cohesive rendering and behaviour are split into siblings so each stays well under the
// module-size budget, all threaded through ShellInternals (shell/types.ts):
//   - dom.ts:       the static shell DOM scaffold (skip link, rail, context bar, main region,
//                   scrim, backdrops, announcer, setup strip) the entry then wires behaviour onto;
//   - rail.ts:      curated rail rendering, the active route, the escape hatch, the setup
//                   strip and the view-mode control state;
//   - nav-links.ts: nav-link construction and the "needs attention" count chip (exported
//                   for the validators);
//   - keyboard.ts:  the roving tabindex, the Compact slide-over rail + focus trap and the
//                   global key layer;
//   - chrome.ts:    the engine identity chip and the account/session area;
//   - charge.ts:    the "downpipe charge" navigation flourish on the rail mark.
// buildNavLink, applyNavCount and ICON_REFRESH are re-exported here so existing importers
// keep importing them from the shell entry unchanged.

import type { Caller } from "../api.ts";
import { motionOK } from "../lib/a11y-prefs.ts";
import { recordFocusLanding } from "../lib/client-diag/ring.ts";
import { isTourMode } from "../lib/demo/tour-mode.ts";
import { clear } from "../lib/dom.ts";
import { ICON_REFRESH } from "../lib/icons.ts";
import { takePostNavigationFocus } from "../lib/nav.ts";
import type { SetupView } from "../lib/setup-state.ts";
import {getStoredViewMode,
  resolveViewModeForCaller,
  roleDefaultViewMode, 
  type ViewMode,
} from "../lib/view-mode.ts";
import { chargeRailMark } from "./charge.ts";
import { applyUpdateChip, buildEngineChip, renderAccount, type UpdateChipView } from "./chrome.ts";
import { buildShellDom } from "./dom.ts";
import { wireGlobalKeys, wireRailToggle } from "./keyboard.ts";
import { applyNavCount } from "./nav-links.ts";
import { applyActiveRoute, renderRail, renderSetupStrip, setViewModeControl } from "./rail.ts";
import type { ShellInternals } from "./types.ts";

// The handles the shell exposes to main.ts / the router.
export interface Shell {
  // Replace the main content region (the production form of render(view)). The
  // measure caps the content width: "prose" (~680px) for forms/reading, "wide"
  // (~1280px) for dense tables/dashboards. `quiet` swaps the body
  // in place with no charge flourish, no cross-fade and no focus move: it is for a
  // same-screen re-render (the identity re-render, app.ts) where the controls should
  // simply update in place without flicker or stealing focus; a real navigation omits it.
  setMain(node: Node, measure?: "prose" | "wide" | "full", opts?: { quiet?: boolean }): void;
  // Mark the active nav item from a resolved route pattern (router reports it).
  setActiveRoute(pattern: string): void;
  // Set the context-bar page title (and an optional description in the page header
  // slot the screen may also render; this is the short title in the bar).
  setTitle(title: string): void;
  // Update the engine identity chip (the connected host). Pass null for "not connected".
  setEngine(opts: { host: string | null }): void;
  // Update the account/session area from the resolved caller (or null + degrade note).
  setCaller(caller: Caller | null, whoamiAvailable: boolean): void;
  // Open/close the Compact slide-over rail programmatically (e.g. after navigation).
  closeRail(): void;
  // Show or hide the shell chrome (rail + context bar). Off = full-bleed, for the
  // onboarding wizard and the signed-out state (the one shell exception, IA 2).
  setChrome(on: boolean): void;
  // Reflect the current resolved VIEW MODE (technical | shiny) in the top-bar toggle, so the
  // control shows the framing actually in effect (the role default, or the operator's override).
  // This only updates the control's pressed state; switching is driven by onViewMode.
  setViewMode(mode: ViewMode): void;
  // Reflect the guided-setup state (the setup-first IA): renders the persistent setup strip
  // between the context bar and the main region and re-shapes the rail (locked items carry the
  // inline reason). null = no gating (setup unknown or complete-and-acknowledged).
  setSetup(view: SetupView | null): void;
  // Set the quiet "needs attention" count chip on a nav item (currently only /credentials, from
  // status.expiryWarnings + status.cleanupPending). A count > 0 renders a small text+aria-label
  // pill on that rail link; 0 or null clears it. Honestly absent: the app passes null when the
  // engine did not report the counts, so no chip is shown rather than a fabricated zero. The chip
  // is text-bearing (the integer) with an aria-label, never colour-alone.
  setNavCount(route: string, count: number | null): void;
  // Show or hide the context-bar "Update available" chip from the cached update verdict
  // (lib/app-refresh.ts). null = hidden (the honest default: unconfigured, unverified, up to date,
  // or the verdict not yet loaded -- the chip never flickers in while loading); a view shows it,
  // naming the recommended version when the channel said one. Clicking it navigates to the Updates
  // section on /licence.
  setUpdateAvailable(view: UpdateChipView | null): void;
  // The handlers main.ts wires (so the shell stays free of app wiring).
  onNavigate(fn: (route: string) => void): void;
  onOpenPalette(fn: () => void): void;
  onSignOut(fn: () => void): void;
  // The operator flipped the top-bar view-mode toggle. The app persists the choice and re-renders
  // the active screen in the new framing (the executive shiny surface or the technical console).
  onViewMode(fn: (mode: ViewMode) => void): void;
}

// mountShell builds the shell into the host (the #app element) and returns the
// handles. Idempotent per host (it replaces the host's children).
export function mountShell(host: Element): Shell {
  // The app handlers main.ts wires (onNavigate / onOpenPalette / onSignOut / onViewMode). Held in
  // one mutable record rather than four rebindable locals so the handle setters can patch them in
  // place from buildShellHandles (which cannot rebind locals across a function boundary); every
  // read site (the context-bar callbacks, the keyboard layer, internals.navigateFn) goes through
  // this record, so a later rebind is honoured without rebuilding the DOM.
  const handlers: ShellHandlers = {
    navigate: () => {},
    openPalette: () => {},
    signOut: () => {},
    viewMode: () => {},
  };

  // navLinks is the live route->link map setActiveRoute reads; it is replaced on each rail
  // rebuild. The remainder of the static chrome (skip link, rail, context bar, main region,
  // scrim, backdrops, announcer, setup strip) is assembled by buildShellDom (shell/dom.ts);
  // the context-bar controls reach back here through the handler record above.
  const navLinks = new Map<string, HTMLAnchorElement>();
  const dom = buildShellDom({
    openPalette: () => handlers.openPalette(),
    viewMode: (mode) => handlers.viewMode(mode),
    signOut: () => handlers.signOut(),
    navigate: (route) => handlers.navigate(route),
  });
  const {
    skip, shellEl, mainRegion, mainInner, railToggle, navEl, railFooter, scrim, setupStrip,
    updateChip, engineChip, accountSlot, viewModeToggle, viewExecBtn, viewTechBtn, navAnnounce,
  } = dom;

  host.replaceChildren(skip, shellEl);

  const internals: ShellInternals = {
    navLinks, mainRegion: mainInner, engineChip, accountSlot,
    shellEl, railToggle, navEl, railFooter, scrim,
    caller: null, showAll: false, activePattern: "",
    navigateFn: (route) => handlers.navigate(route),
    setup: null, setupStrip,
    navCounts: new Map(),
  };

  // refreshViewToggle reflects the resolved mode in the segmented control AND decides
  // whether the control is standing chrome at all: it shows only for a caller whose role
  // default is the executive skin or who has flipped it (a stored override). For the
  // technical-default operator it was a permanent two-button choice whose alternate
  // state they never want; the flip stays reachable via the command palette ("Switch
  // console view"). Re-evaluated on caller changes, explicit setViewMode calls and every
  // navigation (a palette flip re-navigates, which lands here).
  const refreshViewToggle = (mode?: ViewMode): void => {
    setViewModeControl(viewExecBtn, viewTechBtn, mode ?? resolveViewModeForCaller(internals.caller));
    viewModeToggle.hidden = roleDefaultViewMode(internals.caller) !== "shiny" && getStoredViewMode() === null;
  };

  // ---- initial rail (full, before any caller resolves) ----
  // Built from the curated nav for a null caller (everything shown), so navigation works from the
  // first paint. setCaller re-renders it once the role's surface is known.
  renderRail(internals);
  refreshViewToggle();

  // ---- rail collapse / slide-over behaviour ----
  const closeRail = wireRailToggle(internals);
  scrim.addEventListener("click", () => closeRail());

  // ---- keyboard layer: "/" opens the palette, "g <letter>" go-to ----
  wireGlobalKeys(() => handlers.openPalette(), (route) => handlers.navigate(route));

  // The public Shell handles (setMain / setActiveRoute / the on* setters) are the cohesive
  // contract main.ts + the router consume; they are built in buildShellHandles (below) from the
  // live DOM + internals + the handler record, so mountShell stays the assembler.
  return buildShellHandles({
    internals, mainInner, mainRegion, navAnnounce, engineChip, updateChip, refreshViewToggle, handlers, closeRail,
  });
}

// ShellHandlers is the mutable record of the app callbacks the shell invokes. The on* handle
// setters patch its fields in place (so a rebind is honoured without rebuilding the DOM), and
// every read site goes through it.
interface ShellHandlers {
  navigate: (route: string) => void;
  openPalette: () => void;
  signOut: () => void;
  viewMode: (mode: ViewMode) => void;
}

// The live references buildShellHandles closes over to implement the public Shell contract.
interface ShellHandleDeps {
  internals: ShellInternals;
  mainInner: HTMLElement;
  mainRegion: HTMLElement;
  navAnnounce: HTMLElement;
  // The initial engine chip element. setEngine replaces THIS node and records the fresh node on
  // internals.engineChip (the live reference), preserving the entry's original capture semantics.
  engineChip: HTMLElement;
  // The "Update available" chip. Never replaced (applyUpdateChip patches it in place), so the
  // direct reference stays live for the whole session.
  updateChip: HTMLButtonElement;
  refreshViewToggle: (mode?: ViewMode) => void;
  handlers: ShellHandlers;
  closeRail: () => void;
}

// buildShellHandles assembles the public Shell handle object from the live shell references.
// Factored out of mountShell so the entry stays the assembler; the methods are unchanged in
// behaviour, just relocated, and read the shell state through deps.
function buildShellHandles(deps: ShellHandleDeps): Shell {
  const { internals, mainInner, mainRegion, navAnnounce, engineChip, updateChip, refreshViewToggle, handlers, closeRail } = deps;
  // The View Transition currently capturing/animating in setMain, so a navigation that arrives while one
  // is still in flight can skip it instead of starting a second (which throws "InvalidStateError:
  // Transition was aborted because of invalid state"). Null between transitions and on any platform
  // without the API.
  let activeViewTransition: { skipTransition?: () => void } | null = null;
  // mainGeneration counts every setMain call (quiet or not). A real navigation's swap runs inside the View
  // Transition API's update callback, which the browser invokes ASYNCHRONOUSLY (after it captures the "old"
  // state, which waits for a rendering opportunity) rather than inline with the setMain call -- confirmed
  // against a real browser: the swap had not
  // run yet immediately after startViewTransition() returned. A QUIET re-render (the identity re-render,
  // app.ts's reRenderCurrentScreenForResolvedIdentity) swaps SYNCHRONOUSLY and returns straight away, with no
  // knowledge that an earlier navigation's transition callback is still pending. When identity resolves fast
  // enough to win that race, the quiet swap painted the CORRECT content, and the earlier transition's deferred
  // callback then fired anyway and clobbered it back to the stale first-paint content -- proven on the
  // break-glass panel AND on /security's owner-only retire control (both raced identically; this was never a
  // per-screen gap, the shared re-render mechanism itself was unguarded against its own async sibling).
  // skipTransition() alone does not fix this: per the View Transitions API it skips only the pseudo-element
  // ANIMATION, not the update callback, so the callback (and its swap) still runs. The generation counter is
  // the actual fix: each setMain call claims the next generation before doing anything else, and the
  // transition's own apply() checks it still holds the generation it claimed before swapping. A LATER setMain
  // call (quiet or not) always wins; a transition callback that fires after being superseded is a no-op.
  let mainGeneration = 0;
  return {
    setMain(node: Node, measure: "prose" | "wide" | "full" = "wide", opts?: { quiet?: boolean }): void {
      const myGeneration = ++mainGeneration;
      // The bare content swap, shared by the quiet path and the transition's update callback: clear the
      // region, set the width-cap class ("full" = no cap, for a screen that owns its own full-bleed
      // layout, e.g. onboarding, which renders its own header/rail/content), and inject the new node.
      const swap = (): void => {
        clear(mainInner);
        mainInner.className = measure === "prose" ? "main__inner measure" : measure === "full" ? "main__inner" : "main__inner measure-wide";
        mainInner.appendChild(node);
      };
      // A QUIET swap (the identity re-render, app.ts): replace the body in place with NO charge flourish,
      // NO cross-fade and NO focus move, so a screen re-painted the moment the verified caller lands has
      // its owner/role controls enable in place, with no flicker and without stealing focus from the
      // operator. Never used for a real navigation (those cross-fade and move focus to the new content).
      //
      // It also SUPERSEDES any transition still in flight from an earlier setMain (skipTransition stops the
      // animation; myGeneration having already been claimed above is what stops that transition's own
      // deferred swap from later overwriting this one -- see the generation comment above).
      if (opts?.quiet) {
        activeViewTransition?.skipTransition?.();
        swap();
        // A quiet swap is a same-screen update and must not steal focus from an in-page control, so it
        // moves none. It still CONSUMES any focus intent the render declared, so an intent can never
        // leak forward and park focus somewhere the NEXT navigation did not ask for.
        //
        // And it says so when there was one to consume. A declaration eaten here is a tab activation
        // whose control did not take focus, which is the same thing the operator reports, so leaving it
        // unrecorded would put a real path to the symptom outside the pack's reach. No declaration is the
        // ordinary case and records nothing.
        if (takePostNavigationFocus().state !== "none") recordFocusLanding("consumed-quiet");
        return;
      }
      // The downpipe charge: blue runs down the rail mark on a real navigation (with a
      // scale-pulse + glow), explaining the route change. motionOK() is the one gate;
      // under reduced motion the node is never injected, so it is the only motion.
      if (motionOK()) chargeRailMark();
      const apply = (): void => {
        // A newer setMain call (quiet or not) has already claimed the region since this transition
        // started: painting now would silently undo it. This is the generation guard (see the comment above).
        if (myGeneration !== mainGeneration) return;
        swap();
        // Move focus to the main region heading area on navigation so keyboard and
        // screen-reader users land in the new content (without stealing focus from
        // an in-page control during a same-screen update, the router calls this only
        // on a real navigation).
        //
        // UNLESS THE SCREEN BEING MOUNTED DECLARED WHERE FOCUS BELONGS. A control whose activation IS the
        // navigation (a tablist whose sections each own a route) must keep focus on itself, or the arrow
        // keys work exactly once. requestPostNavigationFocus is that declaration; it is read HERE, after
        // the swap, which is the only point at which the named element is mounted and can take focus.
        //
        // AND IT IS RECORDED. The reader already computed the one fact that tells a working tablist
        // from the broken one and threw it away: a screen that declared nothing and a screen whose declared
        // element was not mounted when this line read it both answered null, and only the second is the
        // defect. `detached` is that defect in the pack's own words -- the tab moved, focus did not follow,
        // and every further arrow does nothing until the operator re-focuses by hand -- and `honoured` is
        // recorded beside it so the pack can say the mechanism WAS working rather than staying silent.
        const declared = takePostNavigationFocus();
        if (declared.state === "honoured") recordFocusLanding("honoured");
        else if (declared.state === "detached") recordFocusLanding("dropped-detached");
        (declared.el ?? mainRegion).focus({ preventScroll: false });
      };
      // A soft cross-fade between screens (CALM-06c): the View Transitions API is a
      // progressive enhancement, instant swap when unsupported, and HARD-gated by
      // reduced motion, OS-level or the in-app setting (information is never
      // motion-gated, only the fade is).
      // GUARDED so it can never throw or leave a rejected promise unhandled: rapid navigations (the
      // notFound -> "/" double-fire, the setup-gate / role-landing redirects, post-reset churn) used to
      // start a second transition while the first was still capturing, throwing "InvalidStateError:
      // Transition was aborted because of invalid state" and surfacing as an Uncaught (in promise). Now a
      // navigation arriving mid-transition SKIPS the in-flight one (navigations supersede), the
      // ready/finished rejections are swallowed, and ANY failure falls back to the instant swap so the
      // screen always renders.
      const doc = document as Document & {
        startViewTransition?: (cb: () => void) => { finished: Promise<void>; ready: Promise<void>; skipTransition?: () => void };
      };
      if (motionOK() && typeof doc.startViewTransition === "function") {
        activeViewTransition?.skipTransition?.();
        try {
          const t = doc.startViewTransition(apply);
          activeViewTransition = t;
          const clearIfCurrent = (): void => { if (activeViewTransition === t) activeViewTransition = null; };
          // A skipped/aborted transition rejects ready (and finished); the DOM swap still ran in the
          // update callback, so there is nothing to recover, only the promises to settle quietly.
          t.ready?.catch(() => {});
          t.finished?.then(clearIfCurrent, clearIfCurrent);
        } catch {
          // InvalidStateError (or a hidden document): degrade to the instant swap so the screen renders.
          activeViewTransition = null;
          apply();
        }
      } else {
        apply();
      }
    },
    setActiveRoute(pattern: string): void {
      // Remember the active pattern so a later rail rebuild (on a caller change or escape-hatch
      // toggle) re-applies aria-current to the freshly-built links.
      internals.activePattern = pattern;
      applyActiveRoute(internals, pattern);
      // Route-aware chrome: the setup strip suppresses itself on the Overview checklist
      // (renderSetupStrip reads activePattern), and the view toggle re-resolves so a
      // palette-driven mode flip (which re-navigates) is reflected immediately.
      renderSetupStrip(internals);
      refreshViewToggle();
    },
    setTitle(title: string): void {
      // Names the tab/history entry (WCAG 2.4.2). The visible title is the screen's
      // own h1; the context bar shows none (CALM-05).
      // In the public tour ONLY, prefix "(Demo) " so the tab title is NEVER identical to the real console: a
      // cropped or modal-open screenshot that hides the on-page demo markers cannot be passed off as a real
      // downpipes account (the tab/title still reads it as a demo). The guard is the cheap, dependency-free
      // isTourMode, so the genuine console's title is byte-for-byte unchanged.
      document.title = isTourMode() ? `(Demo) ${title} - downpipes console` : `${title} - downpipes console`;
      // Cleared then set on the next task so repeat navigations to the same screen are
      // still announced (the same announce idiom as code-block.ts). A zero timeout is
      // enough: the browser serialises tasks, so the screen reader sees the clear in one
      // task before the set in the next, with no hardcoded latency assumption.
      navAnnounce.textContent = "";
      window.setTimeout(() => {
        navAnnounce.textContent = title;
      }, 0);
    },
    setEngine(opts): void {
      const fresh = buildEngineChip(opts);
      engineChip.replaceWith(fresh);
      internals.engineChip = fresh;
    },
    setCaller(caller, whoamiAvailable): void {
      renderAccount(internals.accountSlot, caller, whoamiAvailable, () => handlers.signOut());
      // Re-curate the rail to the resolved caller's surface (a custom role can hide screens; a
      // built-in role hides nothing, so its rail is unchanged). Reset the escape hatch on a caller
      // change so a fresh identity starts inside its curated surface.
      internals.caller = caller;
      internals.showAll = false;
      renderRail(internals);
      // Reflect the caller's resolved view mode (role default or stored override) in the
      // toggle, including whether the control is shown at all.
      refreshViewToggle();
    },
    setViewMode(mode: ViewMode): void {
      refreshViewToggle(mode);
    },
    setSetup(view: SetupView | null): void {
      internals.setup = view;
      renderSetupStrip(internals);
      renderRail(internals);
    },
    setNavCount(route: string, count: number | null): void {
      // Record the count so any later rail rebuild (a caller/setup change) reproduces the chip, then
      // patch the live link in place so a status refresh updates the chip without rebuilding the rail
      // (no churn, no polling). A null or 0 count clears the chip. The integer is set as text, never
      // markup (textContent inside h()); the chip carries an aria-label, so it reads by shape + label,
      // not colour alone.
      if (count !== null && count > 0) internals.navCounts.set(route, count);
      else internals.navCounts.delete(route);
      const link = internals.navLinks.get(route);
      if (link) applyNavCount(link, internals.navCounts.get(route));
    },
    setUpdateAvailable(view: UpdateChipView | null): void {
      // Patch the standing chip in place (show/hide + version text), so a cache refresh updates the
      // chrome without a rebuild or a reload; hidden is the only state until a real verdict lands.
      applyUpdateChip(updateChip, view);
    },
    closeRail(): void {
      closeRail();
    },
    setChrome(on: boolean): void {
      if (on) delete internals.shellEl.dataset.chrome;
      else internals.shellEl.dataset.chrome = "off";
    },
    onNavigate(fn): void { handlers.navigate = fn; },
    onOpenPalette(fn): void { handlers.openPalette = fn; },
    onSignOut(fn): void { handlers.signOut = fn; },
    onViewMode(fn): void { handlers.viewMode = fn; },
  };
}


// buildNavLink + applyNavCount now live in shell/nav-links.ts; re-exported here so the
// nav/shell validators (test/validate-nav.ts) and any other importer keep importing them
// from the shell entry unchanged.
export { applyNavCount, buildNavLink } from "./nav-links.ts";
// A re-export so main.ts can build a small "refresh" affordance without importing
// icons directly (kept here to keep the icon set centralised through the shell).
export { ICON_REFRESH };
