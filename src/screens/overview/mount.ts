// Overview mount: wires the page header, the trust row and the data-bound view together.
// mountFullOverview renders the complete Overview body so the guided-setup gate can decide
// WHAT mounts without duplicating any of it. Moved verbatim out of view.ts for size;
// behaviour unchanged.
// House rules: Australian English, no em dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { pageHeader } from "../common.ts";
import { resolveViewModeForCaller } from "../../lib/view-mode.ts";
import { caller } from "../../lib/nav.ts";
import type { EngineClient } from "../../api.ts";
import { OverviewView } from "./view.ts";
import { headerActions, trustRow } from "./header.ts";

// The Overview root carries two typed callback handles so the action registry can drive
// a refresh or a fleet drill-down without a module singleton (the screen may re-render).
// Naming the contract here lets the compiler catch a renamed handle in any reader.
interface OverviewRoot extends HTMLElement {
  __overviewRefresh?: () => void;
  __overviewDrillFleet?: () => void;
}

// mountFullOverview renders the complete Overview dashboard into the host: header,
// trust chips and the async data region. It is called by overview.ts once the
// guided-setup gate (in overview.ts) passes, so it can assume setup is complete.
export function mountFullOverview(root: HTMLElement, engine: EngineClient): void {
  // The two-column layout (.ov-grid and the embedded-card grid) and its medium/compact
  // collapse live in tokens.css section 13, served from the linked stylesheet. No <style> is
  // injected, so the console runs under a strict CSP with style-src 'self' (no 'unsafe-inline').

  // The VIEW MODE the operator's console renders in: the EXECUTIVE (shiny) framing -- plain-English
  // answers that each click through to evidence -- or the TECHNICAL console (the existing dashboard).
  // It is resolved from the caller's role presentation default + the operator's stored override
  // (lib/view-mode.ts). It is read at render time; flipping the top-bar toggle re-resolves the route
  // (app.ts), so a fresh render runs with the new mode. Both framings read the SAME OverviewData, so
  // they can never disagree about what is protected, recoverable or owed.
  const viewMode = resolveViewModeForCaller(caller());

  // The "Updated …" freshness stamp beside the Refresh control: the view repaints it on
  // every load (and on a light cadence while paused), so the screen always states when
  // its data was last fetched and a paused console never presents old tiles as current.
  const updatedStamp = h("span", { class: "field__hint tnum" });
  root.appendChild(
    pageHeader(
      "Overview",
      viewMode === "shiny"
        ? "Plain-English answers; each opens its evidence."
        : "Account health, backup freshness and recovery posture at a glance.",
      headerActions(() => view.refresh(), updatedStamp),
    ),
  );

  // Trust telemetry row: the Access verdict (REAL, never hardcoded) + the no-custody
  // constant, each a real chip reading the live verdict. Rendered immediately (it does not
  // depend on the async load), so the honest trust read is present from the first paint.
  root.appendChild(trustRow());

  // The async region owns the six-state matrix for the data-bound body. It is built
  // once; the screen drives it (load on mount, poll in place, manual refresh). The view mode is
  // passed in so the body renders the executive or the technical framing from the same data.
  const view = new OverviewView(engine, viewMode, updatedStamp);
  root.appendChild(view.el);
  view.start();

  // Expose the refresh for the action registry (overview.refresh): the integrator
  // dispatches the action id, which the screen can route to this handler. Kept on the
  // element so a single registered handler can find the live view without a module
  // singleton (the screen may be re-rendered).
  (root as OverviewRoot).__overviewRefresh = () => view.refresh();
  (root as OverviewRoot).__overviewDrillFleet = () => view.drillFleet();
}
