// The deep-linked read drawer reconciliation for the topology map, lifted out
// of ./controller.ts for size. These are free functions over a small DrawerHost interface the
// controller implements: the controller still owns the mutable selection state (openId, the
// open handle, the suppress-navigation guard) and exposes it here, so the drawer open / sync
// logic is one cohesive unit without the controller carrying it inline. The diff is a MOVE;
// the URL writes, the open / close ordering and the lifecycle are unchanged. House rules:
// Australian English, no em dashes, precise claims.

import { navigate } from "../../lib/nav.ts";
import { canDo, canCap } from "../common.ts";
import type { FlowRecord } from "../../components/topology.ts";
import type { EngineClient } from "../../api.ts";
import type { MapData } from "./data.ts";
import { buildMapDrawer } from "./drawer.ts";
import type { FilterState } from "./filter-bar.ts";
import { MAP_ROUTE, buildFilterQuery, filterSuffix } from "./url.ts";

// DrawerHost is the slice of the controller the drawer logic reads and mutates: the engine and
// stashed data the drawer build needs, the current filters and selection, and the guarded
// close path. The controller implements this directly so no state is duplicated.
export interface DrawerHost {
  engine: EngineClient;
  lastData: MapData | null;
  openId: string | null;
  drawerHandle: { close: () => void } | null;
  suppressDrawerNav: boolean;
  filters(): FilterState;
  reflectFiltersInUrl(): void;
  // refresh re-runs the map load (the controller's LoadHost refresh), so a mutation made from the
  // drawer (delete / roster clean-up) drops its edge at once instead of waiting for the poll.
  refresh(): void;
}

// closeOpenDrawer closes any open drawer WITHOUT navigating (the suppress guard stops the
// onClose path from recursing into a navigate), then clears the handle. A no-op when nothing
// is open. Shared by the two close branches in syncMapDrawer and by the controller's dispose.
export function closeOpenDrawer(host: DrawerHost): void {
  if (!host.drawerHandle) return;
  host.suppressDrawerNav = true;
  host.drawerHandle.close();
  host.drawerHandle = null;
  host.suppressDrawerNav = false;
}

// openMapDrawer is wired to onActivateEdge: open the downpipe's detail drawer, deep-linked at
// /map (the selection rides in ?open=<id> so the base path stays /map and closing returns to
// /map). Read-oriented (viewable by any role): config + recent runs + a link into the
// Downpipes surface for the gated actions. It pushes the open state to the URL, then syncs.
export function openMapDrawer(host: DrawerHost, id: string, flows: FlowRecord[]): void {
  if (host.openId === id && host.drawerHandle) return; // already open on this flow
  host.openId = id;
  // pushState (not replace) so the back button closes the drawer (returns to /map),
  // matching the deep-linkable-drawer contract (detail-drawer.ts U1).
  const qs = buildFilterQuery(host.filters(), id);
  try {
    history.pushState({}, "", `${MAP_ROUTE}?${qs.toString()}`);
  } catch {
    // best-effort
  }
  syncMapDrawer(host, flows);
}

// syncMapDrawer reconciles the open drawer with host.openId: it opens the drawer when the URL
// names a flow that is not already open, and closes a drawer whose flow vanished (a poll that
// dropped it). Closing the drawer (Esc / click-out / the close X) navigates back to /map (the
// base path with the current filters), which clears ?open and re-resolves this screen. An
// already-open drawer is left untouched on a poll (no flicker, no focus theft); it reads a
// snapshot at open time and links to the live Downpipes surface for detail.
export function syncMapDrawer(host: DrawerHost, flows: FlowRecord[]): void {
  if (host.openId === null) {
    // No selection in the URL: ensure any open drawer is closed (without recursing into a
    // navigate, since the URL already reflects the closed state).
    closeOpenDrawer(host);
    return;
  }

  const target = flows.find((f) => f.id === host.openId);
  if (!target) {
    // The selected flow is not in the (possibly freshly polled) set: close honestly and
    // drop the selection from the URL rather than leaving a dangling drawer.
    closeOpenDrawer(host);
    host.openId = null;
    host.reflectFiltersInUrl();
    return;
  }

  // Already open on this flow: leave it untouched (it is a snapshot; detail is live in
  // Downpipes), so a poll does not flicker the drawer or steal focus.
  if (host.drawerHandle) return;

  // Open the drawer for the target flow, loading its recent runs lazily. The drawer build
  // lives in ./drawer.ts (size); the host passes the engine, the stashed MapData, and the
  // guarded onClose it owns.
  host.drawerHandle = buildMapDrawer(target, {
    engine: host.engine,
    lastData: host.lastData,
    refresh: () => host.refresh(),
    // Gates for the drawer's write actions: delete mirrors the engine's downpipe.delete capability;
    // the roster clean-up stays owner-grade. Resolved here (once per open) so the drawer stays
    // presentation-only.
    canDelete: canCap("downpipe.delete"),
    canReconcile: canDo("owner"),
    onClose: () => {
      host.drawerHandle = null;
      if (host.suppressDrawerNav) return;
      host.openId = null;
      navigate(`${MAP_ROUTE}${filterSuffix(host.filters())}`);
    },
  });
}
