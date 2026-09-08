// Overview / dashboard (IA screen 1, observability-recovery design area). The
// post-onboarding landing and the read-only "observe and reassure" half of the
// console: engine health, configuration readiness (PRESENCE, not "valid"), licence
// tier (fail-open, never a gate), update availability, the fleet health roll-up with
// freshness against cadence, the recovery-posture summary, and the no-custody + Access
// trust telemetry as REAL chips (reading the verdict, never hardcoded).
//
// Honest by construction:
//   - Each tile resolves INDEPENDENTLY (Promise.allSettled) and shows an honest
//     "unknown, could not reach the engine" when ITS source fails, never a stale green,
//     and a slow GET /admin/history never blanks the licence tile.
//   - "stale" is loud by default and DISTINCT from "disabled" (a paused pipe is not a
//     failure) and from "unknown" (an unreachable engine is not a backup failure).
//   - The Access chip reads the real whoami verdict; the no-custody chip is a true
//     constant the product earns by construction (keygen.ts; no upload path anywhere).
//   - The licence is fail-open: a community/invalid licence is NEUTRAL, not a warning
//     (a warning would imply a data-path problem, which is false).
//
// RBAC is a client MIRROR of the engine's server-side enforcement (D3): the one write
// this surface owns is the fleet drill (Operator+); a Viewer sees it absent-with-reason.
// Diagnosis lives here; the fix (Run now / Edit / Restore) hands off to the area that
// owns it (Downpipes / Runs / Restore), which the rows and needs-me items deep-link to.
//
// Buildable today against the existing contract (health/status/licence/updates/history
// + downpipes + POST /drill for the fleet drill). The durable drill-evidence + audit
// store is engine dependency D4; the recovery panel says so rather than faking a
// history (information-architecture.md 8.2, the D-dependency map).
//
// This file is the COORDINATOR: it owns the screen descriptor (route, title, measure,
// actions, render) and the guided-setup gate, and re-exports the symbols external callers
// (app.ts, the validators) depend on. The data types and the per-section render flows live
// in the sibling modules under ./overview/ (shared, fleet-data, tiles, fleet-section,
// recovery, executive, build, view) and are imported here; the file was split for size
// while keeping the public surface byte-identical. House rules: Australian English, no em
// dashes, precise claims.

import { h } from "../lib/dom.ts";
import { pageHeader, requireEngine, type Screen } from "./common.ts";
import { navigate } from "../lib/nav.ts";
import { callerCan } from "../lib/identity-custom-roles.ts";
import { skeletonTiles } from "../components/feedback.ts";
import { fetchSetupHealed, setupChecklistCard } from "../lib/setup-state.ts";
import { mountFullOverview } from "./overview/mount.ts";

// Re-exports: external callers import these from this module, so the split keeps their
// imports working unchanged. The view-mode / freshness / cost-model validators read the
// fleet + cost derivations and the executive/technical builders; the OverviewData /
// FleetSummary / Settled types are the parameter types those builders take.
export type {
  FleetSummary,
  OverviewData,
  Settled,
} from "./overview/shared.ts";
export { summariseFleet, observedCostSeed } from "./overview/fleet-data.ts";
export { buildOverview } from "./overview/build.ts";
// The Cloudflare-coverage hero's pure per-surface status function (exhaustively unit-tested) + its types.
// Re-exported so the surface-coverage validator imports them here (the barrel), like the other builders.
// The renderer (buildSurfaceCoverageGrid) is imported directly by build.ts / executive.ts, so it is not
// re-exported here.
export {
  surfaceCoverage,
  discoveryFailureClass,
  discoveryFailureNote,
  type DiscoveryFailure,
  type SurfaceType,
  type SurfaceState,
  type SurfaceCoverage,
} from "./overview/surface-coverage.ts";
export {
  type ExecVerdict,
  type ExecAnswer,
  executiveAnswers,
  buildExecutiveOverview,
} from "./overview/executive.ts";

// A slow setup read shows the skeleton after this grace, then falls open to the dashboard at
// the cap. The invariant is SKELETON_GRACE_MS < SETUP_FAILOPEN_CAP_MS (skeleton must appear
// before the fail-open fires); do not invert these.
const SKELETON_GRACE_MS = 1500;
const SETUP_FAILOPEN_CAP_MS = 4000;

// The overview's own route, exported so a caller outside this screen (the guided tour's chapter
// vocabulary; chapters.ts) references the same literal this descriptor uses, rather than a copy.
export const ROUTE_OVERVIEW = "/";

export const overviewScreen: Screen = {
  route: ROUTE_OVERVIEW,
  title: "Overview",
  measure: "wide",
  // The command palette / registry surfaces the fleet drill from here (Operator+); the
  // gate MIRRORS the engine and the item is hidden for a role that cannot run it, so the
  // palette never lists an action that would 403. The integrator wires these.
  actions: [
    {
      id: "overview.refresh",
      title: "Refresh overview",
      group: "Navigation",
      kind: "action",
      keywords: ["reload", "refresh", "overview", "dashboard"],
      target: "overview.refresh",
    },
    {
      id: "overview.drill-fleet",
      title: "Drill latest run of every downpipe",
      group: "Actions",
      kind: "action",
      keywords: ["drill", "fleet", "recovery", "prove", "recoverable", "evidence"],
      target: "overview.drill-fleet",
      // The SAME gate the on-screen Drill all button and the dispatched action already read
      // (overview/view.ts drillFleet, canCap("drill.run")), which is the engine's own gate for
      // POST /admin/drill and /admin/drill-all (router-pipelines.ts). It was a role-NAME list
      // (operator/approver/owner) while the button beside it was a capability check, so the two
      // entry points to one action disagreed: restore-operator holds drill.run and had the button
      // enabled, yet the palette hid the command. callerCan resolves a named custom role's real
      // capability set rather than the "viewer" floor the engine pins on its role field.
      when: ({ caller: c }) => c !== null && callerCan(c.role, "drill.run", c.customRole ?? null),
    },
  ],
  render() {
    // The question this screen answers: "is everything
    // healthy, and what needs me?" Eager: the protection lead, the tiles, the
    // fleet table, the attention list. Demoted: recovery posture (disclosure),
    // the topology/cost previews (a quiet link row to the owning screens).
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root; // requireEngine routed to onboarding

    // GUIDED SETUP: while setup is incomplete, this screen is the checklist and
    // NOTHING else, the same one-decision gate every other screen honours
    // (owner feedback: Overview must not render a dashboard of
    // tiles, chips and tables around the setup card). The full dashboard mounts
    // below only once the facts say complete (fail-open: unknown renders it).
    const gatedHost = h("div");
    root.appendChild(gatedHost);
    // The verdict mounts exactly once, and the dashboard NEVER paints before it: a slow
    // setup read shows the loading skeleton (not the dashboard), so a late incomplete
    // result can never yank a rendered dashboard away mid-read while still honouring
    // the absolute gate above. Fail-open is preserved by the hard cap (a hung read
    // still lands on the dashboard).
    let settled = false;
    const settle = (mount: () => void): void => {
      if (settled) return;
      settled = true;
      gatedHost.replaceChildren();
      mount();
    };
    const mountDashboard = (): void => settle(() => mountFullOverview(gatedHost, engine));
    void fetchSetupHealed(engine).then((view) => {
      if (view !== null && !view.complete) {
        // Once the keys ceremony is done, the header reads as progress (the console is set up; the
        // remaining steps connect backups) rather than "nothing is set up", so finishing the wizard
        // does not feel like starting over.
        const keysDone = view.steps.find((s) => s.id === "keys")?.done === true;
        const subtitle = keysDone
          ? "Your console is set up. A few more steps connect your backups."
          : "Backups are not flowing yet. A few steps get you there.";
        settle(() => {
          gatedHost.append(
            pageHeader("Overview", subtitle),
            h("div", { class: "measure" }, setupChecklistCard(view, (to) => navigate(to))),
          );
        });
        return;
      }
      mountDashboard();
    }).catch(() => mountDashboard());
    // A slow setup read must not blank the screen: after a short grace, show the loading
    // skeleton while the verdict is pending (settle() replaces it when the read lands).
    window.setTimeout(() => {
      if (!settled && gatedHost.childElementCount === 0) gatedHost.appendChild(skeletonTiles(5));
    }, SKELETON_GRACE_MS);
    // The fail-open hard cap: a setup read that never settles must not hold the screen
    // on a skeleton forever; the dashboard is the safe default (unknown renders it).
    window.setTimeout(() => {
      if (!settled) mountDashboard();
    }, SETUP_FAILOPEN_CAP_MS);

    return root;
  },
};
