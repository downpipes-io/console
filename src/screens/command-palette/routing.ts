// Running a command, and the route maps. Navigate inline, dispatch a benign action, or
// open a flow on its owning screen.
//
// The routing contract (the why): a "flow" command is dangerous and NEVER runs inline; it routes to
// the screen that owns its review-then-confirm flow. A "navigate" command routes to its target. A
// benign "action" runs in defaultDispatch when it is genuinely self-contained, else routes to the
// screen that hosts its controls. actionRoute is exported so the validator can pin that contract in
// Node without a DOM (nothing here executes a DOM call at import time).

import { navigate, caller as currentCaller, signOut } from "../../lib/nav.ts";
import { resolvedTheme, setThemePref } from "../../lib/theme.ts";
import { resolveViewModeForCaller, setViewMode } from "../../lib/view-mode.ts";
import { toast } from "../../components/toast.ts";
import type { Command } from "../../shell/registry.ts";
import type { PaletteDispatch } from "./shared.ts";
import { OVERVIEW_ROOT_ATTR, type OverviewRoot } from "../overview/mount.ts";
import { SETUP_FAILOPEN_CAP_MS } from "../overview.ts";

export async function runCommand(cmd: Command, dispatch: PaletteDispatch): Promise<void> {
  if (cmd.kind === "navigate") {
    navigate(cmd.target);
    return;
  }
  await dispatch(cmd);
}

export function defaultDispatch(cmd: Command): void {
  if (cmd.kind === "flow") {
    // A flow routes to its owning screen with an honest toast, so the operator lands where the
    // review-then-confirm controls are rather than having the flow fire inline.
    const route = flowRoute(cmd.target);
    navigate(route);
    toast({ message: `Opening ${cmd.title.toLowerCase()} where you confirm the details.`, tone: "info" });
    return;
  }
  switch (cmd.target) {
    case "theme.toggle": {
      const next = resolvedTheme() === "dark" ? "light" : "dark";
      setThemePref(next);
      toast({ message: `Theme set to ${next === "dark" ? "Dark" : "Light"}`, tone: "info" });
      return;
    }
    case "view.toggle": {
      const next = resolveViewModeForCaller(currentCaller()) === "shiny" ? "technical" : "shiny";
      setViewMode(next);
      // Re-resolve the route the router is actually on: hash mode on file:// and the
      // root-with-in-app-hash deep-link form both route on the hash; the clean URL is the norm.
      const hashRoute = location.hash.replace(/^#/, "");
      const onHashRoute = location.protocol === "file:" || (location.pathname === "/" && hashRoute.startsWith("/"));
      navigate(onHashRoute && hashRoute ? hashRoute : location.pathname + location.search, { replace: true });
      toast({ message: `Console view set to ${next === "shiny" ? "executive" : "technical"}.`, tone: "info" });
      return;
    }
    case "auth.sign-out": {
      // The REAL sign-out (the shell account-menu path via the nav bridge): ends the engine passkey
      // session, clears in-memory state and lands on the live sign-in. Routing to /settings here
      // would leave the session intact.
      signOut();
      return;
    }
    case "palette.open":
      return;
    case "overview.drill-fleet": {
      // The command's title promises the drills, so it must RUN them, not only open the Overview. The screen
      // exposes the drill as a handle on its root (overview/mount.ts), and the view reports progress on its own
      // status line when the palette started it (overview/view.ts setDrillProgress).
      const before = findOverviewRoot();
      navigate(actionRoute(cmd.target));
      void runOnOverview(before, (root) => root.__overviewDrillFleet);
      return;
    }
    default: {
      const route = actionRoute(cmd.target);
      navigate(route);
      return;
    }
  }
}

// findOverviewRoot is the connected Overview root that carries the screen's handles, or null.
function findOverviewRoot(): OverviewRoot | null {
  if (typeof document === "undefined") return null;
  return document.querySelector(`[${OVERVIEW_ROOT_ATTR}]`) as OverviewRoot | null;
}

// Bounds for waiting on the Overview after a navigation: the router renders it in a later task (inside a
// view transition), and the full dashboard mounts only once the guided-setup gate has settled. On a slow
// engine that gate settles only at the Overview's fail-open cap, so the wait is derived from that cap plus a
// margin for the view transition. A fixed wait shorter than the cap told the operator the drill did not start,
// and the dashboard then mounted with no drill running.
const OVERVIEW_WAIT_STEP_MS = 50;
const OVERVIEW_WAIT_MARGIN_MS = 1000;
export const OVERVIEW_WAIT_STEPS = Math.ceil((SETUP_FAILOPEN_CAP_MS + OVERVIEW_WAIT_MARGIN_MS) / OVERVIEW_WAIT_STEP_MS);
// After this many steps the root seen BEFORE the navigation is accepted, because navigating to the route
// already on screen may not re-render it.
const OVERVIEW_REUSE_AFTER_STEPS = 10;

// runOnOverview waits for the Overview root that the navigation mounted and calls one of its handles. A root
// that was on screen before the navigation is preferred LAST, because a re-render replaces it and a drill
// started on a replaced view would report its progress into a detached node. If no root with the handle
// appears (setup is not finished, or a leave guard kept the operator where they were), it says so rather
// than doing nothing without a word. Exported for the validator; the wait bounds are parameters for it.
export async function runOnOverview(
  before: OverviewRoot | null,
  pick: (root: OverviewRoot) => (() => void) | undefined,
  steps = OVERVIEW_WAIT_STEPS,
  stepMs = OVERVIEW_WAIT_STEP_MS,
): Promise<boolean> {
  for (let i = 0; i < steps; i++) {
    const root = findOverviewRoot();
    const handle = root ? pick(root) : undefined;
    if (root && handle && (root !== before || i >= OVERVIEW_REUSE_AFTER_STEPS)) {
      handle();
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  toast({ message: "The fleet drill did not start. Open the Overview and choose Drill all under Recovery posture.", tone: "warn" });
  return false;
}

// flowRoute maps a dangerous-flow target to the screen that owns its review flow.
function flowRoute(target: string): string {
  switch (target) {
    // request-restore and apply-restore both open the Restore screen (an Operator raises the request there;
    // an Approver applies it). Both carry an action id mapped here to /restore; a target this switch does
    // not recognise falls through to "/" by default, so keeping the mapping in sync with the registry's
    // action ids matters.
    case "restore.request": return "/restore";
    case "restore.start": return "/restore";
    case "downpipe.delete": return "/downpipes";
    case "keys.rotate": return "/keys";
    default: return "/";
  }
}

// actionRoute maps a benign action target to the screen that hosts it (for the default
// dispatcher; the integrator's dispatcher may instead run it inline). Exported so the
// routing contract can be validated independently of the DOM-heavy palette overlay.
export function actionRoute(target: string): string {
  switch (target) {
    case "keys.recovery-sheet": return "/keys";
    case "access.verify": return "/access";
    case "licence.check-updates": return "/licence";
    case "licence.view-provenance": return "/licence";
    // Export lives on the audit log, the Access area's audit sub-tab.
    case "audit.export": return "/access/audit";
    // defaultDispatch runs auth.sign-out inline (the real sign-out via the nav bridge);
    // this mapping remains the screen that HOSTS the sign-out controls, for any consumer
    // that routes rather than dispatches.
    case "auth.sign-out": return "/settings";
    case "settings.alert-webhook": return "/settings";
    case "overview.refresh": return "/";
    case "overview.drill-fleet": return "/";
    default: return "/";
  }
}
