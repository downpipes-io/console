// Running a command, and the route maps. Navigate inline, dispatch a benign action, or
// open a flow on its owning screen.
//
// The routing contract (the why): a "flow" command is dangerous and NEVER runs inline; it routes to
// the screen that owns its review-then-confirm flow. A "navigate" command routes to its target. A
// benign "action" runs in defaultDispatch when it is genuinely self-contained, else routes to the
// screen that hosts its controls. actionRoute is exported so the validator can pin that contract in
// Node without a DOM (nothing here executes a DOM call at import time). House rules: Australian
// English, no em dashes, precise claims.

import { navigate, caller as currentCaller, signOut } from "../../lib/nav.ts";
import { resolvedTheme, setThemePref } from "../../lib/theme.ts";
import { resolveViewModeForCaller, setViewMode } from "../../lib/view-mode.ts";
import { toast } from "../../components/toast.ts";
import type { Command } from "../../shell/registry.ts";
import type { PaletteDispatch } from "./shared.ts";

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
      toast({ message: `Theme set to ${next === "dark" ? "Obsidian (dark)" : "light"}`, tone: "info" });
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
    default: {
      const route = actionRoute(cmd.target);
      navigate(route);
      return;
    }
  }
}

// flowRoute maps a dangerous-flow target to the screen that owns its review flow.
function flowRoute(target: string): string {
  switch (target) {
    // request-restore and apply-restore both open the Restore screen (an Operator raises the request there;
    // an Approver applies it). request-restore previously carried the route string "/restore" as its target,
    // which this switch does not recognise, so it fell through to "/" and silently landed the operator on
    // Overview. It now carries the action id "restore.request", mapped here, matching apply-restore's
    // "restore.start" pattern.
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
    // Export lives on the audit log, now the Access area's audit sub-tab.
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
