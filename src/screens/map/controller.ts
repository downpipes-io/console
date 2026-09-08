// The topology map view controller: MapView owns the six-state lifecycle (empty / loading /
// partial / error / success), the in-place freshness poll (paused on a hidden tab and on the
// operator's WCAG 2.2.2 preference), the URL-reflected filters, and the route-driven read
// drawer. It keeps the topology component MOUNTED across polls so a refresh re-feeds it via
// setFlows (a 2px indeterminate bar marks the refetch) rather than blanking the canvas. Lifted
// out of ./view.ts (the thin public surface) for size; the diff is a move, behaviour is
// unchanged. It imports the pure data leaf (./data.ts), the presentation helpers (./panels.ts,
// ./view-chrome.ts, ./filter-bar.ts, ./drawer.ts), the URL helpers (./url.ts), common.ts (one
// level up) and the design-system components. House rules: Australian English, no em dashes,
// precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import { recordCapabilityFault, recordRendererState } from "../../lib/client-diag/ring.ts";
import { classifyRenderer, probeCssAnimations, probeRaf, watchVisibility } from "./renderer-diag.ts";
import { autoRefreshToggle, getAutoRefresh, onAutoRefreshChange } from "../../lib/refresh-pref.ts";
import { pageHeader, requireEngine } from "../common.ts";
import { navigate } from "../../lib/nav.ts";
import { toast } from "../../components/toast.ts";
import type {
  FlowRecord,
  FlowStatus,
  NodeKind,
} from "../../components/topology.ts";
import type { EngineClient } from "../../api.ts";
import {
  emptyMapData,
  type MapData,
} from "./data.ts";
import {
  parseStatusFilter,
  parseKindFilter,
  nodeFilterLabel,
} from "./panels.ts";
import {
  renderLoadingSkeleton,
  gatherDiagnostics,
} from "./view-chrome.ts";
import type { FilterState } from "./filter-bar.ts";
import {
  buildMapBody,
  summaryAnnouncement,
  type MapBodyContext,
  type MapBodyHandlers,
} from "./render.ts";
import {
  openMapDrawer,
  syncMapDrawer,
  closeOpenDrawer,
  type DrawerHost,
} from "./drawer-sync.ts";
import { load, type LoadHost } from "./load.ts";
import {
  applyFilters,
  reflectFiltersInUrl,
} from "./url.ts";
import { buildVisual, type MapVisual } from "./visual.ts";

// The poll cadence for the in-place freshness refresh, on the SAME cadence as the Overview
// (spec section 6: "polling for freshness on the same cadence as overview"). Nothing phones
// home; the freshness is recomputed in-account from the engine's own data. The poll pauses
// when the tab is hidden, so a backgrounded console makes no requests.
const POLL_MS = 30_000;

// How long the copy-diagnostics confirmation toast stays on screen.
const DIAGNOSTICS_TOAST_MS = 5000;

// MapView owns the loading / partial / error / success lifecycle for the data-bound body,
// plus the in-place poll. It keeps the topology component MOUNTED across polls so a refresh
// re-feeds it via setFlows (a 2px indeterminate bar marks the refetch) rather than blanking
// the canvas (spec section 6: never blank on a poll). The lifecycle is bound to DOM
// connectedness (mirroring overview.ts): the router swaps main content on navigation, which
// detaches this element without a dispose() call, so any callback that fires after the
// screen is navigated away finds the element detached and self-disposes.
class MapView implements DrawerHost, LoadHost {
  readonly el: HTMLElement;
  // Public so the drawer reconciliation in ./drawer-sync.ts (DrawerHost) and the fetch
  // lifecycle in ./load.ts (LoadHost) can read the engine and the stashed data they need; the
  // controller still owns these.
  engine: EngineClient;
  // Public for the LoadHost surface (./load.ts mounts the skeleton / error block here).
  content: HTMLElement;
  private liveRegion: HTMLElement;
  private pollTimer: number | undefined;
  // Public for the LoadHost surface (the fetch lifecycle's first-load latch + overlap guard).
  firstLoadDone = false;
  inFlight = false;
  private disposed = false;
  // Unsubscribe for the auto-refresh preference listener (set in start()).
  private unsubRefreshPref: (() => void) | null = null;

  // The mounted VISUAL (built on first success, re-fed on poll): the WebGL live-flow view,
  // the map's one renderer. It feature-detects internally and degrades to the SVG topology
  // when WebGL is unavailable, with the canonical accessible data table present in every
  // branch, so no toggle is needed and no preference is stored. The last flow set is kept so
  // a filter change re-projects without a network round trip.
  private visual: MapVisual | null = null;
  // Public for the LoadHost surface (the load stashes the mapped flow set here).
  allFlows: FlowRecord[] = [];
  // The last fetched data, kept so a filter-only re-render can rebuild the destination /
  // partial notes without a refetch (filters are a pure view over the last fetched flows).
  // Public for the DrawerHost surface (the drawer build reads it).
  lastData: MapData | null = null;
  // Consecutive failed core polls (0 = the last refresh succeeded). The FIRST failure
  // raises one warn toast; later ones keep to the standing note + the polite live region,
  // so an engine restart does not re-toast every 30 seconds. Public for the LoadHost surface.
  pollFailures = 0;
  // When the on-screen data was last fetched successfully (the note's "as of" time). Public
  // for the LoadHost surface (the stale note's timestamp).
  lastLoadedAt: number | null = null;
  // The standing inline stale-data cue (honesty: after the toast fades, staleness must
  // stay visible). One stable node, re-parented by buildBody, populated while polls fail
  // and cleared by the next successful refresh. A hint, not a banner (calm budget);
  // role "note" like the partial notes (the polite live region does the speaking, so the
  // cue is not announced twice).
  // Public for the LoadHost surface (./load.ts populates / clears the stale note).
  staleNote = h("p", { class: "field__hint", role: "note", hidden: true, style: "margin-top:var(--space-2)" });

  // The current filters, parsed from the URL and reflected back to it (shareable, survive
  // refresh). statusFilter is a FlowStatus or null (all); kindFilter is a source NodeKind
  // or null (all); nodeFilter is a node id (from activating a node) or null.
  private statusFilter: FlowStatus | null = null;
  private kindFilter: NodeKind | null = null;
  private nodeFilter: string | null = null;
  // The selected downpipe id (the open drawer), reflected as ?open=<id>. Tracked so a poll
  // does not reopen it and a navigation away closes it cleanly. Public for the DrawerHost
  // surface that ./drawer-sync.ts reconciles.
  openId: string | null = null;
  drawerHandle: { close: () => void } | null = null;
  // Guards the drawer onClose -> navigate so the close we trigger ourselves (on a real
  // navigation away, or when re-syncing) does not recurse back into a navigate.
  suppressDrawerNav = false;

  constructor(engine: EngineClient, query: URLSearchParams) {
    this.engine = engine;
    this.statusFilter = parseStatusFilter(query.get("status"));
    this.kindFilter = parseKindFilter(query.get("kind"));
    this.nodeFilter = query.get("node") || null;
    this.openId = query.get("open") || null;
    this.content = h("div", { class: "async-region" });
    // A polite live region announces background refresh outcomes for assistive tech (a new
    // failure surfacing on a poll, or "filtered to N flows") without stealing focus.
    this.liveRegion = h("div", { class: "visually-hidden", role: "status", "aria-live": "polite" });
    this.el = h("div", this.content, this.liveRegion);
  }

  start(): void {
    void this.load(false);
    document.addEventListener("visibilitychange", this.onVisibility);
    // The operator's auto-refresh preference (WCAG 2.2.2): pausing stops the cadence
    // at once; resuming refreshes in place. Manual Refresh works regardless.
    this.unsubRefreshPref = onAutoRefreshChange((pref) => {
      if (!this.isAlive()) {
        this.dispose();
        return;
      }
      if (pref === "paused") this.stopPoll();
      else void this.load(true);
    });
  }

  refresh(): void {
    void this.load(true);
  }

  // everConnected latches once the element has been seen IN the document. isAlive treats
  // "not connected" as dead ONLY after that latch: the router attaches the screen inside a
  // view transition, so a fast engine (local dev, a warm cache) can resolve the first fetch
  // BEFORE the element is attached - reading that as "navigated away" silently disposed the
  // view and left the loading skeleton on screen forever (caught by the local fixture-engine
  // reproduction, where every fetch returns in microseconds).
  private everConnected = false;

  isAlive(): boolean {
    if (this.disposed) return false;
    if (this.el.isConnected) {
      this.everConnected = true;
      return true;
    }
    return !this.everConnected;
  }

  private onVisibility = (): void => {
    if (!this.isAlive()) {
      this.dispose();
      return;
    }
    if (document.hidden) {
      this.stopPoll();
    } else {
      void this.load(true);
    }
  };

  private stopPoll(): void {
    if (this.pollTimer !== undefined) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  schedulePoll(): void {
    this.stopPoll();
    // No cadence while hidden, disposed, or paused by the operator (WCAG 2.2.2).
    if (this.disposed || document.hidden || getAutoRefresh() === "paused") return;
    this.pollTimer = window.setTimeout(() => {
      // A view still unattached a whole poll interval after rendering is an abandoned
      // navigation, not the attach race the everConnected latch covers; stop it here.
      if (!this.isAlive() || (!this.el.isConnected && !this.everConnected)) {
        this.dispose();
        return;
      }
      void this.load(true);
    }, POLL_MS);
  }

  // The fetch lifecycle (the three-source load + the failed-core resolution) lives in ./load.ts
  // as free functions over the LoadHost slice this class implements; this thin method is the
  // wiring point the start / poll / visibility / refresh paths call.
  private load(isPoll: boolean): Promise<void> {
    return load(this, isPoll);
  }

  renderLoading(): void {
    // The two-column skeleton (spec section 6: never a blank canvas) is the stateless leaf
    // renderLoadingSkeleton; the view owns mounting it.
    this.content.replaceChildren(renderLoadingSkeleton());
  }

  setRefetching(on: boolean): void {
    // A 2px indeterminate top bar over the content while a poll refetches; never blanks.
    this.content.setAttribute("aria-busy", on ? "true" : "false");
    this.content.classList.toggle("is-refetching", on);
  }

  // renderSuccess builds (first time) or re-feeds (poll) the topology component, applies the
  // current filters, and re-syncs the drawer to the URL. The component owns the empty state
  // internally (an empty flow set renders its calm "no downpipes yet" explanation plus an
  // empty accessible table), so an account with no downpipes flows through here too, never a
  // blank canvas. We add the onboarding link beneath the component's empty copy.
  renderSuccess(flows: FlowRecord[], data: MapData, isPoll: boolean): void {
    // Stash the fetched data so a filter-only re-render can rebuild the destination /
    // partial notes without a refetch.
    this.lastData = data;
    // A successful fetch clears the stale-data cue and re-arms the one-toast guard.
    this.lastLoadedAt = Date.now();
    this.pollFailures = 0;
    this.staleNote.hidden = true;
    this.staleNote.textContent = "";
    const visible = this.applyFilters(flows);

    if (!this.visual) {
      // First success: build the chosen visual once, wire the interactions, mount it.
      this.visual = this.buildVisual(visible);
      this.content.replaceChildren(this.buildBody(flows, visible, data));
      // Record WHICH RENDERER IS LIVE, once per mount, into the diagnostics ring the customer's own
      // support pack carries. Fire-and-forget (the probes are bounded and never block the paint), and recorded
      // on EVERY mount, not only the degraded ones: `none` beside canvas2d is what lets the pack say the live
      // view was healthy, and without it "the map is frozen" and "the customer never opened the map" are the
      // same absence. The probes read no user agent, no GPU string and no URL.
      void this.recordRenderer();
    } else {
      // Poll / filter re-render: re-feed the SAME mounted visual so the canvas never blanks
      // (setFlows rebuilds the model + the always-present table), then refresh the chrome (the
      // view toggle, the filter bar counts, the destination note, the partial note) around it.
      this.visual.setFlows(visible);
      this.content.replaceChildren(this.buildBody(flows, visible, data));
    }

    // Re-sync the drawer to the URL: open the one the route asks for (if not already open),
    // or close one whose flow a poll dropped.
    this.syncDrawer(flows);

    if (isPoll) this.announce(summaryAnnouncement(flows, visible));
  }

  // buildVisual wires the controller-owned interaction handlers (open a flow, filter by a node,
  // clear the node filter) to the stateless ./visual.ts builder, which owns the renderer choice
  // (WebGL live-flow with the SVG topology fallback). Kept as a thin method so the lifecycle
  // stays here and the renderer detail stays a leaf.
  private buildVisual(visible: FlowRecord[]): MapVisual {
    return buildVisual(visible, {
      onActivateEdge: (id: string) => this.openDrawer(id),
      onActivateNode: (nodeId: string) => this.filterByNode(nodeId),
      onClearNodeFilter: () => this.clearNodeFilter(),
    });
  }

  // buildBody assembles the chrome around the mounted visual. The DOM assembly itself lives in
  // the pure ./render.ts buildMapBody (lifted out for size); the controller passes the stable
  // nodes it re-parents (the visual, the stale note), the current filters, and the mutation /
  // navigation handlers it owns. The visual element is STABLE across re-renders (the same node
  // is re-parented), so its internal focus / roving state is not needlessly thrown away on a poll.
  private buildBody(allFlows: FlowRecord[], visible: FlowRecord[], data: MapData): HTMLElement {
    return buildMapBody(allFlows, visible, data, this.bodyContext(), this.bodyHandlers());
  }

  // bodyContext bundles the stable nodes + current filters the render helpers re-parent / read.
  private bodyContext(): MapBodyContext {
    return { visual: this.visual, staleNote: this.staleNote, filters: this.filters() };
  }

  // bodyHandlers bundles the controller-owned mutation / navigation callbacks the render
  // helpers forward into the filter bar, the filtered-empty note and the empty-account CTA
  // (each writes the filter to the URL and re-projects from the cached flow set, no refetch).
  private bodyHandlers(): MapBodyHandlers {
    return {
      onStatus: (s) => this.setStatusFilter(s),
      onKind: (k) => this.setKindFilter(k),
      onClearNode: () => this.clearNodeFilter(),
      onClearAll: () => this.clearAllFilters(),
      onNavigateSources: () => navigate("/sources"),
      onCopyDiagnostics: () => void this.copyDiagnostics(),
    };
  }

  // ---- filter mutations (URL-reflected, re-project from cache, no refetch) ----

  // The present filter selection as the FilterState the url.ts / filter-bar.ts helpers read.
  // Public for the DrawerHost surface (./drawer-sync.ts reads it for the deep-link query).
  filters(): FilterState {
    return { statusFilter: this.statusFilter, kindFilter: this.kindFilter, nodeFilter: this.nodeFilter };
  }

  private applyFilters(flows: FlowRecord[]): FlowRecord[] {
    return applyFilters(flows, this.filters());
  }

  private setStatusFilter(s: FlowStatus | null): void {
    this.statusFilter = s;
    this.reflectFiltersInUrl();
    this.reproject();
  }

  private setKindFilter(k: NodeKind | null): void {
    this.kindFilter = k;
    this.reflectFiltersInUrl();
    this.reproject();
  }

  // filterByNode is wired to onActivateNode: activating a node filters the map to the flows
  // incident on it. A node id is "<side>:<kind>:<name>" (the component's stable id); we store
  // the whole id so a source node and a destination node filter correctly, and so the chip
  // can show a friendly label.
  private filterByNode(nodeId: string): void {
    this.nodeFilter = nodeId;
    this.reflectFiltersInUrl();
    this.reproject();
    this.announce(`Filtered the map to ${nodeFilterLabel(nodeId)}.`);
  }

  private clearNodeFilter(): void {
    if (this.nodeFilter === null) return;
    this.nodeFilter = null;
    this.reflectFiltersInUrl();
    this.reproject();
    this.announce("Cleared the node filter.");
  }

  private clearAllFilters(): void {
    this.statusFilter = null;
    this.kindFilter = null;
    this.nodeFilter = null;
    this.reflectFiltersInUrl();
    this.reproject();
    this.announce("Cleared all filters.");
  }

  // reproject re-applies the filters to the cached flow set and re-feeds the component, then
  // rebuilds the chrome. No network: a filter is a pure view over the last fetched flows
  // (and the last fetched MapData, stashed at fetch time, for the destination/partial notes).
  private reproject(): void {
    const visible = this.applyFilters(this.allFlows);
    if (this.visual) this.visual.setFlows(visible);
    // Rebuild the chrome (the view toggle, the filter bar's active states + counts, the notes)
    // around the re-fed visual, which buildBody re-parents.
    this.content.replaceChildren(this.buildBody(this.allFlows, visible, this.lastData ?? emptyMapData()));
  }

  // Public for the DrawerHost surface (./drawer-sync.ts drops ?open when a flow vanishes).
  reflectFiltersInUrl(): void {
    reflectFiltersInUrl(this.filters(), this.openId);
  }

  // ---- the deep-linked read drawer (spec section 4) ---------------------------
  // The reconciliation lives in ./drawer-sync.ts (free functions over the DrawerHost slice this
  // class implements); these thin methods are the wiring points the visual handlers and the
  // success path call. openDrawer is wired to onActivateEdge; syncDrawer runs after each render.

  private openDrawer(id: string): void {
    openMapDrawer(this, id, this.allFlows);
  }

  private syncDrawer(flows: FlowRecord[]): void {
    syncMapDrawer(this, flows);
  }

  announce(message: string): void {
    this.liveRegion.textContent = message;
  }

  // copyDiagnostics gathers the redaction-safe environment facts that decide what this map
  // can show, samples real motion (two rAF ticks; CSS animation currentTime advance), and
  // copies the block to the clipboard. Built after a day of remote guessing about a frozen
  // map: one paste of this block names the culprit (no WebGL, an emulated/forced
  // reduced-motion state, a frozen rAF, an extension freezing animations) without another
  // round trip. Local reads only; the operator chooses where the text goes.
  // recordRenderer runs the two bounded environment probes and files ONE coarse row: the renderer that is live
  // and the single cause that explains it. Guarded so a probe that throws in an exotic host can never break the
  // map it is diagnosing.
  private async recordRenderer(): Promise<void> {
    const visual = this.visual;
    if (!visual) return;
    // Watch the document's visibility ACROSS the whole probe window, not just before it. In a hidden
    // document the browser suspends requestAnimationFrame while setTimeout keeps running, so probeRaf's freeze
    // guard fires and a healthy browser reads as raf-frozen. The map's first load is deliberately NOT gated on
    // visibility (only the poll cadence is: "a backgrounded console makes no requests"), so the map genuinely
    // does mount in background tabs, and every one of those sessions used to file the gap's own headline fault.
    // A tab hidden HALFWAY THROUGH gives the same false reading, which is why the watch spans the window.
    const watch = watchVisibility();
    try {
      const [raf, cssAnim] = await Promise.all([probeRaf(), probeCssAnimations()]);
      const mode = visual.mode();
      recordRendererState(mode, classifyRenderer({ mode, animation: visual.animation(), raf, cssAnim, everHidden: watch.everHidden() }));
    } catch {
      // A probe that threw teaches nothing and must not be reported as a renderer fault: an invented cause is
      // worse evidence than none.
    } finally {
      watch.stop();
    }
  }

  private async copyDiagnostics(): Promise<void> {
    // The redaction-safe environment facts are gathered by the stateless leaf gatherDiagnostics
    // (local reads only, no transmission); the view owns the clipboard write + toast.
    const text = await gatherDiagnostics(this.allFlows, this.visual);
    try {
      await navigator.clipboard.writeText(text);
      toast({ tone: "success", message: "View diagnostics copied to the clipboard.", durationMs: DIAGNOSTICS_TOAST_MS });
    } catch {
      // Clipboard blocked (for example a cross-origin frame): write the block to the browser
      // console for manual copy and point the operator there, rather than a blocking modal
      // that some embedded environments suppress.
      //
      // This is the console's OWN remote-support affordance failing, so the failure is recorded. The
      // block then reaches support only if the operator can find their browser console, which is precisely the
      // ask a locked-down corporate browser makes hardest. `map-diagnostics` is its own surface so a dead
      // clipboard here is never mistaken for a dead clipboard on the recovery codes.
      recordCapabilityFault("clipboard", "map-diagnostics", typeof navigator !== "undefined" && navigator.clipboard !== undefined ? "refused" : "unavailable");
      console.info("View diagnostics:\n%s", text);
      toast({
        tone: "info",
        message: "Clipboard unavailable. The diagnostics were written to the browser console.",
        durationMs: DIAGNOSTICS_TOAST_MS,
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopPoll();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.unsubRefreshPref?.();
    this.unsubRefreshPref = null;
    // Tear down the mounted visual (stops the WebGL animation loop + frees the context when the
    // live-flow view is active; a no-op for the SVG view), so a navigation away does not leave a
    // requestAnimationFrame loop running against a detached canvas.
    if (this.visual) {
      this.visual.dispose();
      this.visual = null;
    }
    // Close any open drawer without navigating (the screen is going away).
    closeOpenDrawer(this);
  }
}

// renderMap builds the screen body: the page header (with the WCAG 2.2.2 auto-refresh pause)
// and the MapView lifecycle controller. The coordinator's descriptor render simply returns this
// (the same approach the overview / onboarding coordinators use), keeping the descriptor thin
// and the lifecycle here.
export function renderMap(ctx: { query: URLSearchParams }): HTMLElement {
  const engine = requireEngine();
  const root = h("div");
  if (!engine) return root; // requireEngine routed to onboarding

  root.appendChild(
    pageHeader(
      "Topology map",
      "Each downpipe from its Cloudflare source to your archive destination, with status, freshness and how much it moves. Open a flow for its detail, or jump to Downpipes to act on it; the drawer also carries a gated delete and orphan clean-up.",
      // The auto-refresh pause (WCAG 2.2.2): the map polls in place; the operator
      // can stop the cadence.
      autoRefreshToggle(),
    ),
  );
  // The screen-level doc link (field audit G2): the map screen carried no path to its own
  // documentation. This explains what the map renders, how freshness and coverage stay honest, and
  // what the drawer's two gated clean-up actions do.
  root.appendChild(
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/day-2/topology-map", target: "_blank", rel: "noreferrer noopener", style: "display:inline-flex;margin-bottom:var(--space-3)" },
      "About the topology map",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );

  // The view owns the six-state lifecycle (empty / loading / partial / error / success)
  // plus the in-place poll and the route-driven drawer. It is built once; the screen
  // drives it (load on mount, poll in place, open the drawer the route asks for).
  const view = new MapView(engine, ctx.query);
  root.appendChild(view.el);
  view.start();

  // The map.refresh command (screenActions in ./view.ts) is a Navigation action to MAP_ROUTE:
  // dispatching it re-routes to /map, which re-renders the screen (a fresh MapView that loads
  // on mount), rather than poking an in-place handler on this element. The view also polls in
  // place every 30 seconds and offers a manual Refresh in its header, so no extra hook is kept
  // on the root.
  return root;
}
