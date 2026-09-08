// The topology map's fetch lifecycle (the three-source load and the failed-core resolution),
// lifted out of ./controller.ts for size. These are free functions over a small LoadHost
// interface the controller implements: the controller still owns the lifecycle state (in-flight
// guard, first-load latch, the failure count and the "as of" timestamp) and the render / poll
// hooks; the orchestration sequence lives here so the controller stays a thin coordinator. The
// diff is a MOVE; the fetch ordering, the channel-two signed-out routing, the first-load error
// state and the quiet poll-failure handling are unchanged. House rules: Australian English, no
// em dashes, precise claims.

import { goSignedOut } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import type { FlowRecord } from "../../components/topology.ts";
import type { EngineClient } from "../../api.ts";
import { mapDownpipesToFlows, fetchAllSources, type MapData } from "./data.ts";
import { renderFirstLoadError, markStaleFailure } from "./render.ts";

// LoadHost is the slice of the controller the load orchestration reads and mutates: the engine
// it fetches through, the lifecycle flags and the failure bookkeeping, the stable nodes, and the
// render / poll / lifecycle hooks. The controller implements this directly so no state is
// duplicated.
export interface LoadHost {
  engine: EngineClient;
  inFlight: boolean;
  firstLoadDone: boolean;
  pollFailures: number;
  lastLoadedAt: number | null;
  allFlows: FlowRecord[];
  content: HTMLElement;
  staleNote: HTMLElement;
  isAlive(): boolean;
  dispose(): void;
  renderLoading(): void;
  setRefetching(on: boolean): void;
  renderSuccess(flows: FlowRecord[], data: MapData, isPoll: boolean): void;
  schedulePoll(): void;
  refresh(): void;
  announce(message: string): void;
}

// load fetches the three sources independently. `isPoll` distinguishes the first load (skeleton)
// from a refresh (keep the mounted map, show the 2px indeterminate bar, re-feed via setFlows).
// The CORE is the downpipes LIST: if it fails on first load this is the honest error state with
// Retry; history and status failing only weaken flows to unknown.
export async function load(host: LoadHost, isPoll: boolean): Promise<void> {
  if (host.inFlight) return; // never overlap a refresh with itself
  host.inFlight = true;

  if (!host.firstLoadDone) {
    host.renderLoading();
  } else if (isPoll) {
    host.setRefetching(true);
  }

  const data = await fetchAllSources(host.engine);

  // If the screen was navigated away while the load was in flight, do not render into a
  // detached element or schedule another poll; self-dispose and stop.
  if (!host.isAlive()) {
    host.inFlight = false;
    host.dispose();
    return;
  }

  // The list is the core. A 401 anywhere routes to signed-out (channel two). A list failure on
  // first load is the whole-screen error; on a later poll it is kept quiet (the existing map
  // stays, a toast and a polite live-region announce the stale refresh) so a transient blip
  // does not tear down a working view.
  if (!data.downpipes.ok) {
    handleCoreFailure(host, (data.downpipes as { error: unknown }).error);
    return;
  }

  // A 401 surfacing on a later poll for an authenticated read (history/status) routes to
  // signed-out too; otherwise those degrade silently to unknown / relaxed freshness.
  if (!data.history.ok && isUnauthorised((data.history as { error: unknown }).error)) {
    host.inFlight = false;
    goSignedOut();
    return;
  }

  const flows = mapDownpipesToFlows(data);
  host.allFlows = flows;
  host.renderSuccess(flows, data, isPoll);
  host.firstLoadDone = true;
  host.inFlight = false;
  host.setRefetching(false);
  host.schedulePoll();
}

// handleCoreFailure resolves a failed core (downpipes-list) read: a 401 routes to signed-out;
// a first-load failure is the whole-screen error block with Retry; a later poll failure keeps
// the existing map and surfaces the stale refresh (one warn toast on the first consecutive
// failure, the standing stale note and the polite live region thereafter). It clears inFlight
// and schedules the next poll itself.
export function handleCoreFailure(host: LoadHost, err: unknown): void {
  if (isUnauthorised(err)) {
    host.inFlight = false;
    goSignedOut();
    return;
  }
  if (!host.firstLoadDone) {
    // The whole-screen error block with Retry (presentation in ./render.ts); Retry re-runs the
    // load in place (no page reload).
    renderFirstLoadError(host.content, err, () => host.refresh());
    host.inFlight = false;
    host.schedulePoll();
    return;
  }
  // A poll failure with a map already on screen: keep it, but never quietly. The standing
  // stale-data note + the one-shot warn toast are presentation (./render.ts markStaleFailure,
  // which returns the polite-live-region sentence); the controller owns the failure count and
  // the poll scheduling so a long outage neither re-toasts every 30 seconds nor hides that the
  // map is stale.
  host.setRefetching(false);
  host.pollFailures++;
  host.announce(markStaleFailure(host.staleNote, host.pollFailures, host.lastLoadedAt));
  host.inFlight = false;
  host.schedulePoll();
}
