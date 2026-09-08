// Overview (IA screen 1) view controller: OverviewView owns the loading / partial / error
// / success lifecycle for the data-bound body, the in-place poll (paused on a hidden tab
// and on the operator's WCAG 2.2.2 preference), the value-settle on changed tiles, and the
// fleet drill (the one write this surface owns; Operator+). The header/trust-row builders
// live in ./header.ts, the data fetch in ./fetch.ts, the fleet-drill pure helpers in
// ./fleet-drill.ts, the view-state helpers in ./view-state.ts, and mountFullOverview (which
// wires it all together) in ./mount.ts. Moved verbatim out of overview.ts for size.
// House rules: Australian English, no em dashes, precise claims.

import { h, clear } from "../../lib/dom.ts";
import { canCap, capGateReason } from "../common.ts";
import type { ViewMode } from "../../lib/view-mode.ts";
import { motionOK } from "../../lib/a11y-prefs.ts";
import { getAutoRefresh, onAutoRefreshChange } from "../../lib/refresh-pref.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { isRateLimited, rateLimitDelayMs, bulkFailureReason, sleep, MAX_RATE_LIMIT_RETRIES } from "../../lib/bulk-pacing.ts";
import { openBulkSummary } from "../../components/bulk-summary.ts";
import { blockError } from "../../components/error-view.ts";
import { skeletonTiles, skeletonRows, banner } from "../../components/feedback.ts";
import type { DataTableState } from "../../components/data-table.ts";
import { toast } from "../../components/toast.ts";
import { relativeTime, absoluteTime } from "../../lib/format.ts";
import type { EngineClient, RunHistoryEntry, SourceDiscovery } from "../../api.ts";
import type { OverviewData, Settled } from "./shared.ts";
import { buildOverview } from "./build.ts";
import { buildExecutiveOverview } from "./executive.ts";
import { fetchOverviewData } from "./fetch.ts";
import { fleetStateFromQuery, reflectFleetState, dataSnapshot, errMessage } from "./view-state.ts";
import { collectDrillTargets, drillSummary, drillFailuresForSummary, type DrillOutcomes, type DrillTarget } from "./fleet-drill.ts";
import { recordFleetDrill, recordUnhandled } from "../../lib/client-diag/ring.ts";
import { faultClassForError, errorClassForError } from "../../lib/client-diag/classify.ts";
import { BREAK_GLASS_PREFIX } from "../restore-flow/shared.ts";

// The poll cadence for the in-place refresh. Observability is computed in-account from
// the engine's own data; nothing phones home (the no-analytics ethos). Poll-driven
// refreshes update values in place (never blank the page) and pause when the tab is
// hidden so a backgrounded console makes no requests.
const POLL_MS = 30_000;
// Cadence for the lightweight stamp repaint (keeps the relative time honest when no poll
// runs). Kept as its own constant so it can diverge from POLL_MS without surprise.
const STAMP_REPAINT_MS = 30_000;

// Skeleton counts for the first-load placeholder. OVERVIEW_TILE_COUNT matches the real status
// tile count built in build.ts; FLEET_SKELETON_ROWS is a representative fleet size for the
// loading rows. Named so a tile-layout change has one place to update.
const OVERVIEW_TILE_COUNT = 5;
const FLEET_SKELETON_ROWS = 5;

// LoadKind distinguishes the two load modes the lifecycle branches on, replacing a boolean flag:
// "initial" is the first load (show the skeleton, never settle tiles);
// "poll" is an in-place refresh (keep the rendered content, show the 2px bar, settle changed tiles).
type LoadKind = "initial" | "poll";

// OverviewView owns the loading / partial / error / success lifecycle for the data-bound
// body, plus the in-place poll. It keeps the body mounted across polls so a refresh
// updates values in place (a 2px indeterminate bar marks the refetch) rather than
// blanking the page (flow.md states summary: never blank on a poll).
export class OverviewView {
  readonly el: HTMLElement;
  private engine: EngineClient;
  private viewMode: ViewMode;
  private content: HTMLElement;
  private liveRegion: HTMLElement;
  private pollTimer: number | undefined;
  private firstLoadDone = false;
  private inFlight = false;
  private disposed = false;
  // Unsubscribe for the auto-refresh preference listener (set in start()).
  private unsubRefreshPref: (() => void) | null = null;
  // The fleet table's live filter/sort/facet state, carried across poll rebuilds so a
  // 30s refresh does not wipe what the operator typed or sorted, AND reflected to the
  // URL so leaving Overview and returning (or bookmarking) preserves the view (the
  // navigation design, mirroring Runs/Map). Seeded from the URL on construction.
  private fleetTableState: Partial<DataTableState> | null = fleetStateFromQuery();
  // The last rendered snapshot (normalised). A poll that fetches identical data skips
  // the rebuild entirely, so focus, table state and the live region are untouched.
  private lastSnapshot: string | null = null;
  // The cached source-discovery for the surface-coverage hero (bound bindings + the added token set).
  // Discovery makes LIVE Cloudflare API calls, so it is fetched ONCE on the first load and reused on every
  // 30s poll (the green/covered layer still refreshes from the polled downpipe list); a manual refresh is
  // the only path that re-reads it. null until the first load resolves it.
  private discovery: Settled<SourceDiscovery> | null = null;
  // Per-tile last-rendered values (keyed by the tile's unique label), so a poll can
  // settle ONLY the tiles whose value actually changed (Wave 1 value-settle).
  private prevTileValues = new Map<string, string>();
  // Double-submit guard for the fleet drill (the button also disables; this guards the
  // palette path too).
  private drillInFlight = false;
  // The header "Updated …" stamp + the epoch of the last completed load it states.
  private updatedStamp: HTMLElement;
  private lastLoadAt: number | null = null;
  private stampTimer: number | undefined;
  // The visible fleet-drill progress line for paths with no button on screen (the
  // palette, or the recovery disclosure closed). Hidden whenever no drill is running.
  private drillStatus: HTMLElement;

  constructor(engine: EngineClient, viewMode: ViewMode, updatedStamp: HTMLElement) {
    this.engine = engine;
    this.viewMode = viewMode;
    this.updatedStamp = updatedStamp;
    this.content = h("div", { class: "async-region" });
    // A polite live region announces background refresh outcomes for assistive tech
    // (a new failure surfacing on a poll) without stealing focus.
    this.liveRegion = h("div", { class: "visually-hidden", role: "status", "aria-live": "polite" });
    this.drillStatus = h("p", { class: "field__hint", hidden: true });
    this.el = h("div", this.drillStatus, this.content, this.liveRegion);
  }

  start(): void {
    void this.load("initial");
    // Pause polling when the tab is hidden so a backgrounded console is silent; resume
    // (with an immediate refresh) when it returns to the foreground.
    document.addEventListener("visibilitychange", this.onVisibility);
    // The operator's auto-refresh preference (WCAG 2.2.2): pausing stops the cadence
    // at once; resuming refreshes in place. Manual Refresh works regardless. The stamp
    // repaints either way so the pause is stated the moment it takes effect.
    this.unsubRefreshPref = onAutoRefreshChange((pref) => {
      if (!this.isAlive()) {
        this.dispose();
        return;
      }
      if (pref === "paused") this.stopPoll();
      else void this.load("poll");
      this.paintStamp();
    });
    // Keep the stamp's relative time honest when no poll repaints it (hidden tab, the
    // paused preference): a light repaint of one text node, self-disposing with the view
    // like every other timer here.
    this.stampTimer = window.setInterval(() => {
      if (!this.isAlive()) {
        this.dispose();
        return;
      }
      this.paintStamp();
    }, STAMP_REPAINT_MS);
  }

  // refresh is the manual / palette refresh: an in-place reload that shows the partial
  // indicator rather than the first-load skeleton. It is the ONE path that re-reads source
  // discovery (forceDiscovery), so an operator who just added a source can refresh to see the
  // coverage hero update; the background poll reuses the cached discovery to spare the CF API budget.
  refresh(): void {
    void this.load("poll", true);
  }

  // isAlive: the view is alive while its element is in the document. The integrator's
  // router swaps the main content on navigation (shell.setMain -> replaceChildren), which
  // DETACHES this element without calling dispose(). So the lifecycle is bound to DOM
  // connectedness: any callback that fires after the screen is navigated away finds the
  // element detached and self-disposes, so the poll timer and the document listener never
  // outlive the screen (no integrator dispose() call is required).
  // everConnected latches once the element has been seen IN the document; "not connected"
  // means dead ONLY after that (the router attaches the screen inside a view transition, so
  // a fast engine can resolve the first fetch BEFORE attachment - treating that as
  // "navigated away" left the loading skeleton on screen forever; the map's local
  // fixture-engine reproduction caught it).
  private everConnected = false;

  private isAlive(): boolean {
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
      void this.load("poll");
    }
  };

  private stopPoll(): void {
    if (this.pollTimer !== undefined) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private schedulePoll(): void {
    this.stopPoll();
    // No cadence while hidden, disposed, or paused by the operator (WCAG 2.2.2).
    if (this.disposed || document.hidden || getAutoRefresh() === "paused") return;
    this.pollTimer = window.setTimeout(() => {
      // If the screen was navigated away (element detached) self-dispose instead of
      // polling a dead screen; otherwise refresh in place. A view still unattached a whole
      // interval after rendering is an abandoned navigation, not the attach race.
      if (!this.isAlive() || (!this.el.isConnected && !this.everConnected)) {
        this.dispose();
        return;
      }
      void this.load("poll");
    }, POLL_MS);
  }

  // load fetches the nine reads (health, status, licence, updates, history, downpipes, drill-evidence,
  // audit, approvals) independently, plus source discovery for the coverage hero. `kind` distinguishes the
  // first load (skeletons) from a refresh (keep the rendered content, show a 2px indeterminate bar).
  // forceDiscovery re-reads source discovery (the manual refresh path); otherwise the cached discovery is
  // carried into the fetch so the 30s poll never touches the live Cloudflare API.
  private async load(kind: LoadKind, forceDiscovery = false): Promise<void> {
    if (this.inFlight) return; // never overlap a refresh with itself
    this.inFlight = true;

    if (!this.firstLoadDone) {
      this.renderLoading();
    } else if (kind === "poll") {
      this.setRefetching(true);
    }

    const data = await fetchOverviewData(this.engine, forceDiscovery ? null : this.discovery);
    // Cache the discovery so the next poll reuses it (a fresh read happens only on the first load and on a
    // manual refresh). The fetch echoes back the carried value on a poll, so this is a no-op then.
    this.discovery = data.discovery;
    // If the screen was navigated away while the load was in flight, do not render into a
    // detached element or schedule another poll; self-dispose and stop.
    if (!this.isAlive()) {
      this.inFlight = false;
      this.dispose();
      return;
    }

    // If the core reads failed (or a session expired mid-poll), the error path owns the
    // whole-screen state and we are done for this load.
    if (this.handleLoadError(data)) return;

    // THE LAST-RESORT CATCH. buildOverview now guards each section, so a section fault fails as a
    // section; this is the floor under a throw that reaches neither, and it exists because of what its
    // ABSENCE did. Every other exit from this method clears inFlight and reschedules the poll by hand;
    // a throw skipped all of them, so the rejection escaped `void this.load(...)`, `inFlight` stayed
    // true for the life of the tab, no further load was ever scheduled, and the first-load SKELETON
    // stayed on screen for ever. That is worse than a blank page: a skeleton reads as "still loading",
    // so the operator waits instead of acting, and the poll that would have recovered the screen on the
    // next tick was already disarmed. This can happen with a single malformed downpipe row.
    //
    // The recovery is deliberate about which state it leaves behind. On the FIRST load there is nothing
    // on screen but the skeleton, so the whole-screen block error replaces it with something readable
    // and a Retry. On a POLL the previously rendered body is still correct and still true, so it is
    // LEFT ALONE (flow.md: never blank on a poll) and the next poll is allowed to try again. Either way
    // inFlight is cleared and the cadence is restored, so the screen can never be permanently stuck.
    try {
      this.renderContent(data, kind);
    } catch (err) {
      recordUnhandled(faultClassForError(err), "window-error", errorClassForError(err));
      if (!this.firstLoadDone) {
        clear(this.content);
        this.content.appendChild(blockError(err, () => this.refresh(), { origin: location.origin }));
      }
      this.inFlight = false;
      this.setRefetching(false);
      this.schedulePoll();
      return;
    }
    this.firstLoadDone = true;
    this.lastLoadAt = Date.now();
    this.paintStamp();
    this.inFlight = false;
    this.setRefetching(false);
    this.schedulePoll();
  }

  // handleLoadError owns the fatal-load whole-screen states, returning true when it has
  // taken over (the caller then stops). The CORE is health+status: if BOTH could not be
  // reached on the first load, this is the honest "could not reach the engine" state (a 401
  // short-circuits to signed-out; a transport error shows the block error with Retry).
  // Otherwise the page renders and individual tiles degrade to unknown. A 401 surfacing on a
  // later poll (session expired mid-session) routes to signed-out even if some unauthenticated
  // read still answered.
  private handleLoadError(data: OverviewData): boolean {
    const coreDown = !data.health.ok && !data.status.ok;
    if (coreDown && !this.firstLoadDone) {
      // Both reads failed. Surface the STATUS error (the authenticated, diagnostic read;
      // health is unauthenticated and less informative). A 401 routes to signed-out.
      const e = (data.status as { error: unknown }).error;
      if (isUnauthorised(e)) {
        this.inFlight = false;
        goSignedOut();
        return true;
      }
      clear(this.content);
      this.content.appendChild(blockError(e, () => this.refresh(), { origin: location.origin }));
      this.inFlight = false;
      this.schedulePoll();
      return true;
    }
    const auth401 = !data.status.ok && isUnauthorised((data.status as { error: unknown }).error);
    if (auth401) {
      this.inFlight = false;
      goSignedOut();
      return true;
    }
    return false;
  }

  // paintStamp states when the data on screen was last fetched ("Updated 2m ago"),
  // emphasised and explicit while auto-refresh is paused: the persisted pause survives
  // sessions, and without the stamp a paused console presented day-old "Healthy" tiles
  // as current. Hue + text, never colour alone; the title carries the exact instant.
  private paintStamp(): void {
    if (this.lastLoadAt === null) return;
    const paused = getAutoRefresh() === "paused";
    this.updatedStamp.textContent = paused
      ? `Updated ${relativeTime(this.lastLoadAt)} (auto-refresh paused)`
      : `Updated ${relativeTime(this.lastLoadAt)}`;
    this.updatedStamp.setAttribute("title", absoluteTime(this.lastLoadAt));
    this.updatedStamp.style.color = paused ? "var(--warn)" : "";
  }

  private renderLoading(): void {
    clear(this.content);
    this.content.appendChild(skeletonTiles(OVERVIEW_TILE_COUNT));
    const fleet = h("div", { style: "margin-top:var(--space-6)" });
    fleet.appendChild(h("h2", { class: "section-label", style: "margin-bottom:var(--space-3)" }, "Fleet health"));
    fleet.appendChild(skeletonRows(FLEET_SKELETON_ROWS));
    this.content.appendChild(fleet);
  }

  private setRefetching(on: boolean): void {
    // A 2px indeterminate top bar over the content while a poll refetches; never blanks.
    this.content.setAttribute("aria-busy", on ? "true" : "false");
    this.content.classList.toggle("is-refetching", on);
  }

  private renderContent(data: OverviewData, kind: LoadKind): void {
    const isPoll = kind === "poll";
    // A poll that fetched IDENTICAL data skips the rebuild: replacing the body would
    // wipe the fleet table's filter/sort/focus and re-announce the result count for no
    // new information. The snapshot is the normalised settled data (errors reduced to
    // their message), so only a real change re-renders.
    const snapshot = dataSnapshot(data);
    if (isPoll && this.firstLoadDone && snapshot === this.lastSnapshot) return;
    this.lastSnapshot = snapshot;

    // Branch on the view mode: the EXECUTIVE (shiny) framing renders the five plain-English answers
    // (each clicking through to its evidence); the TECHNICAL framing renders the existing dashboard.
    // Both read the SAME OverviewData, so the two surfaces cannot disagree about the honest read.
    const built = this.viewMode === "shiny"
      ? buildExecutiveOverview(data, {
          onDrillFleet: () => this.drillFleet(),
          announce: (m) => this.announce(m),
          onRefresh: () => this.refresh(),
        })
      : buildOverview(data, {
          onDrillFleet: () => this.drillFleet(),
          announce: (m) => this.announce(m),
          // Carry the fleet table's filter/sort/facet state across the rebuild so a
          // poll never resets what the operator typed or sorted.
          ...(this.fleetTableState ? { fleetTableState: this.fleetTableState } : {}),
          onFleetTableState: (st) => { this.fleetTableState = st; reflectFleetState(st); },
        });
    // Proactive source-drift banner: when the engine reports configured source bindings missing (a deploy
    // dropped them, so their next backups fail), surface a standing warning ABOVE the overview that links
    // straight to the Sources screen's re-attach, rather than waiting for the operator to notice a failed
    // run. Count only (no names here); absent/zero shows nothing. Built each render from the fresh status.
    const detached = data.status.ok ? (data.status.value.sourcesDetachedCount ?? 0) : 0;
    const driftBanner = detached > 0
      ? banner({
          tone: "warn",
          message: `${detached} source${detached === 1 ? "" : "s"} ${detached === 1 ? "is" : "are"} no longer attached to the engine, so ${detached === 1 ? "its" : "their"} next backups will fail. Re-attach ${detached === 1 ? "it" : "them"} on the Sources screen.`,
          action: { label: "Re-attach sources", onClick: () => navigate("/sources") },
        })
      : null;
    // On a poll we replace the content in one operation (replaceChildren) so the swap is
    // atomic and never shows a half-built frame; the values are recomputed from fresh
    // data and the tabular numerals keep figures from jittering.
    this.content.replaceChildren(...(driftBanner ? [driftBanner] : []), built);
    // Value-settle: highlight only the stat tiles whose value actually changed on a
    // poll, so the dashboard breathes when reality changes and stays still otherwise.
    this.settleChangedTiles(kind);
  }

  // settleChangedTiles diffs the just-rendered stat tiles against the previously
  // rendered values (keyed by the tile's unique label) and plays a one-shot settle
  // wash on the ones that changed. motionOK() is the gate; when motion is off it
  // still records the new values so a later re-enable does not flash everything as
  // "changed". Never fires on the first render or on the initial (non-poll) build.
  private settleChangedTiles(kind: LoadKind): void {
    const next = new Map<string, string>();
    const firstPass = this.prevTileValues.size === 0;
    const animate = motionOK() && kind === "poll" && !firstPass;
    this.content.querySelectorAll(".stat").forEach((tile) => {
      const key = tile.querySelector(".stat__label")?.textContent?.trim() ?? "";
      if (!key) return;
      const val = tile.querySelector(".stat__value, .stat__unknown")?.textContent?.trim() ?? "";
      next.set(key, val);
      const prev = this.prevTileValues.get(key);
      if (animate && prev !== undefined && prev !== val) {
        tile.classList.add("dp-settle");
        tile.addEventListener("animationend", () => tile.classList.remove("dp-settle"), { once: true });
      }
    });
    this.prevTileValues = next;
  }

  private announce(message: string): void {
    this.liveRegion.textContent = message;
  }

  // drillFleet runs POST /admin/drill for the LATEST run of every downpipe (the one
  // write this surface owns; Operator+, J5 step 3). It is gated client-side as a MIRROR
  // of the engine; the engine is the enforcement point. Each outcome is reported as it
  // completes (partial state), a mix of pass/fail is shown honestly, and an ok:false
  // (e.g. a break-glass-only posture) is an expected inline outcome, not an error.
  async drillFleet(): Promise<void> {
    if (!canCap("drill.run")) {
      toast({ message: capGateReason("drill.run"), tone: "warn" });
      return;
    }
    // Never overlap a fleet drill with itself (the button also disables; this guard
    // covers the palette path too, so a double dispatch cannot double-fire the drills).
    if (this.drillInFlight) return;
    this.drillInFlight = true;
    try {
      await this.drillFleetInner();
    } finally {
      this.drillInFlight = false;
      this.setDrillProgress(null);
    }
  }

  // setDrillProgress paints the per-drill progress where the operator can see it: on the
  // Drill all button when it is on screen (the recovery disclosure is open), else on the
  // view's own status line (the palette path has no button to watch). null clears the
  // line; the post-drill refresh rebuilds the button with its normal label.
  private setDrillProgress(message: string | null): void {
    if (message === null) {
      this.drillStatus.hidden = true;
      this.drillStatus.textContent = "";
      return;
    }
    const btn = this.content.querySelector<HTMLButtonElement>('[data-drill-all="true"]');
    if (btn) {
      btn.textContent = message;
    } else {
      this.drillStatus.hidden = false;
      this.drillStatus.textContent = message;
    }
  }

  private async drillFleetInner(): Promise<void> {
    // Read the current fleet from a fresh history fetch so we drill the real latest runs.
    let byDownpipe: Record<string, RunHistoryEntry[]>;
    try {
      byDownpipe = (await this.engine.listAllHistory()).byDownpipe;
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      // G287: the fleet read failed, so NOT ONE drill was attempted. From the engine's side this is
      // indistinguishable from a drill that was never started: no drill arrived, no evidence was written, and
      // the drill dates on every pipe simply stay where they were. "We drill every week and the evidence stopped
      // a month ago" is answered by this row and by nothing else in the pack.
      recordFleetDrill("fleet-read-failed", { targeted: 0, passed: 0, failed: 0, deferred: 0, skippedNoRunId: 0, rateLimitExhausted: 0 });
      toast({ message: `Could not read the fleet to drill (${errMessage(err)}).`, tone: "warn" });
      return;
    }
    const { targets, skippedNoRunId } = collectDrillTargets(byDownpipe);
    if (targets.length === 0) {
      // Nothing to drill is a LEGITIMATE state on a fresh account and is not recorded as a fault. But a fleet
      // whose pipes were ALL skipped for want of a runId is not that state at all, and it is exactly the "one
      // downpipe never appears in any drill" ticket at fleet scale, so the skip count is recorded.
      if (skippedNoRunId > 0) {
        recordFleetDrill("none", { targeted: 0, passed: 0, failed: 0, deferred: 0, skippedNoRunId, rateLimitExhausted: 0 });
      }
      toast({ message: "No runs to drill yet. Trigger a downpipe first.", tone: "info" });
      return;
    }

    const o: DrillOutcomes = { passed: 0, failures: [], deferred: [], rateLimitExhausted: 0 };
    let done = 0;
    for (const t of targets) {
      done++;
      // A 401 mid-loop routes to signed-out and aborts the whole drill (no summary, no
      // refresh); every other outcome is accumulated and the loop continues.
      if ((await this.drillOne(t, done, targets.length, o)) === "signed-out") {
        // G287: THE ABORT. The remaining targets were never attempted, so the engine's drill evidence shows a
        // partial sweep that is byte-identical to a deliberate partial drill: 8 of 30 pipes drilled on one date,
        // and no way to tell "the operator drilled 8" from "the drill died at pipe 9". `targeted` stays the FULL
        // list (what the loop set out to do) and the abort cause says why the rest is missing.
        recordFleetDrill("signed-out", {
          targeted: targets.length,
          passed: o.passed,
          failed: o.failures.length,
          deferred: o.deferred.length,
          skippedNoRunId,
          rateLimitExhausted: o.rateLimitExhausted,
        });
        return;
      }
    }
    // G287: the session ran to completion. Recorded on EVERY ending, not only the bad ones: `passed` is the
    // denominator that makes `failed` mean something, and a clean session that produces no row at all is what
    // made an aborted one impossible to recognise.
    recordFleetDrill("none", {
      targeted: targets.length,
      passed: o.passed,
      failed: o.failures.length,
      deferred: o.deferred.length,
      skippedNoRunId,
      rateLimitExhausted: o.rateLimitExhausted,
    });
    // A confirmational toast naming the REAL outcomes (the loop received each one; a
    // guessed cause would be dishonest); the durable, dated record is the drill-evidence
    // log (D4), written best-effort above, not this toast (the toast is never the only
    // record of a privileged action). A break-glass-only downpipe deferred is never a failure, so the
    // tone still keys on failures alone; when any were deferred, an attend action points at the real
    // next step (proving them with attended verification) rather than leaving the clause inert.
    const summary = drillSummary(targets.length, o);
    toast({
      message: summary,
      tone: o.failures.length === 0 ? "success" : "warn",
      ...(o.deferred.length > 0 ? { action: { label: "Prove with attended verification", onClick: () => navigate("/restore/attend") } } : {}),
    });
    this.announce(summary);
    // CON-1: every failure, with its REASON, in the shared per-item failures modal (the same surface
    // the bulk run/disable/delete path uses) so a 30-failure drill explains all 30 rather than naming 3
    // and pointing at a surface that does not list them. The toast stays the short headline.
    if (o.failures.length > 0) openBulkSummary("drill", "drilled", o.passed, drillFailuresForSummary(o));
    // Refresh in place so the recovery posture reflects the new outcomes (including the new
    // last-drilled stamp from the evidence just recorded, when D4-ext is wired).
    void this.load("poll");
  }

  // drillOne runs a single sequential drill, paints its progress and accumulates the
  // outcome into `o`. It returns "signed-out" when a 401 surfaced (the caller aborts the
  // whole fleet drill), else "done".
  private async drillOne(t: DrillTarget, done: number, total: number, o: DrillOutcomes): Promise<"signed-out" | "done"> {
    // Visible progress per drill (one sequential POST per downpipe): the Drill all
    // button (when on screen) and the status line repaint with the same text the live
    // region announces, so a long fleet drill is never dead air.
    const progress = `Drilling ${done} of ${total}: ${t.id}`;
    this.announce(progress);
    this.setDrillProgress(progress);
    // CON-2: a 429 from the engine's limiter is honoured (Retry-After, capped) and the drill of this
    // run is retried up to MAX_RATE_LIMIT_RETRIES times before being recorded as a labelled failure, so
    // a fleet-drill 429 storm paces itself rather than hammering and reading as N unexplained failures.
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      try {
        const res = await this.engine.drill(t.runId);
        if (res.ok) {
          o.passed++;
          // console-overview-2: after a drill SUCCEEDS, record the durable, dated drill
          // evidence (D4-ext), so a privileged action leaves a trail, not just a toast. It
          // is BEST-EFFORT: a missing or not-yet-wired drill-evidence route (404/501) must
          // not shadow the drill result, so the error is swallowed (a 401 is the one
          // exception, routed to signed-out, since the whole session has expired).
          await this.recordDrillEvidenceBestEffort(t.runId);
        } else {
          // CON-1: capture the REAL ok:false reason (the in-flow outcome), never a bare "did not pass".
          const reason = res.reason ?? "did not pass (the engine gave no reason)";
          // The engine's own classified refusal for a break-glass-only estate (missingBinding:
          // "operational-private") starts with this exact prefix, the same test the three single-run
          // surfaces already key on (restore-flow/proof.ts, runs/detail.ts). Nothing failed: the posture
          // is deliberate, so it is kept OUT of failures and never reads as a fleet-drill failure.
          if ((res.reason ?? "").startsWith(BREAK_GLASS_PREFIX)) {
            o.deferred.push({ id: t.id, reason });
          } else {
            o.failures.push({ id: t.id, reason });
          }
        }
        return "done";
      } catch (err) {
        if (isUnauthorised(err)) {
          goSignedOut();
          return "signed-out";
        }
        lastErr = err;
        if (isRateLimited(err) && attempt < MAX_RATE_LIMIT_RETRIES) {
          this.setDrillProgress(`Rate limited; pausing before retrying ${t.id}`);
          await sleep(rateLimitDelayMs(err));
          continue;
        }
        // G287: this drill gave up while STILL rate-limited, having spent every retry it is allowed. A
        // large-fleet drill dying to a 429 storm and one dying to N unrestorable pipes produce the same count of
        // failures and the same toast; only this tells them apart, and they are opposite remedies.
        if (isRateLimited(err)) o.rateLimitExhausted++;
        break;
      }
    }
    // CON-1: the thrown-error path now records a REASON (a 429 reads as "rate limited", every other
    // fault keeps its engine message) rather than an unexplained id in the failed set.
    o.failures.push({ id: t.id, reason: bulkFailureReason(lastErr) });
    return "done";
  }

  // recordDrillEvidenceBestEffort writes one in-account drill-evidence entry, swallowing a
  // not-yet-wired route or any non-auth error so it never shadows the drill result
  // (console-overview-2 / console-restore-1). A 401 propagates so the caller routes to
  // signed-out; everything else is silent (the evidence trail is a fast-follow, not a gate).
  private async recordDrillEvidenceBestEffort(runId: string): Promise<void> {
    try {
      await this.engine.recordDrillEvidence(runId, "in-account");
    } catch (err) {
      if (isUnauthorised(err)) throw err;
      // D4-ext not wired (404/501) or a transient failure: do not surface; the drill result
      // already stands and the recovery card states the evidence trail is an engine addition.
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopPoll();
    if (this.stampTimer !== undefined) {
      window.clearInterval(this.stampTimer);
      this.stampTimer = undefined;
    }
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.unsubRefreshPref?.();
    this.unsubRefreshPref = null;
  }
}

