// Sources + downpipes (IA screen 2): the operational heart of the console. The
// hero management screen, built to production quality from screen 2's design
// (flow.md + storyboard.md + wireframe.html), built on the B1 foundation and the
// shared component layer.
//
// This module is the coordinator: it defines the screen descriptor and the actions
// it contributes, and re-exports the per-section helpers external callers depend on.
// The render flows live in the sibling modules under ./sources-downpipes/ and are
// imported here; the file was split for size while keeping the public surface
// byte-identical.
//
// Invariants kept: every server string enters the DOM via textContent / typed
// element creation (no markup-injection surface); the screen never asks for a
// destination credential and never POSTs one (it shows presence + residency from
// status.destKind only); cost figures are presentation-only and never sent back;
// the two-channel error model is respected (a thrown 401 -> signed-out; a 400 from
// the DO -> inline, input preserved; 5xx/network -> block error with Retry + the
// CONSOLE_ORIGIN diagnostic); RBAC is MIRRORED for the client gate (Viewer reads;
// Operator+ writes) but the engine is the enforcement point.

import type {
  DownpipeState,
  EngineClient,
  StatusReport,
} from "../api.ts";
import type { dataTable } from "../components/data-table.ts";
import { blockError, sessionEnded } from "../components/error-view.ts";
import { noteQuiet, skeletonRows } from "../components/feedback.ts";
import { toast } from "../components/toast.ts";
import { h, refuseWithReason, svgIcon } from "../lib/dom.ts";
import { isUnauthorised } from "../lib/errors.ts";
import { ICON_PLUS } from "../lib/icons.ts";
import { callerCan } from "../lib/identity-custom-roles.ts";
import { goSignedOut, navigate } from "../lib/nav.ts";
import { readRecoveryPosture } from "../lib/operational-key-posture.ts";
import { destinationFromStatus } from "../lib/protection-statement.ts";
import { autoRefreshToggle, getAutoRefresh, onAutoRefreshChange } from "../lib/refresh-pref.ts";
import { canCap, capGateReason, pageHeader, requireEngine, type Screen, type ScreenAction } from "./common.ts";
import { openDetail } from "./sources-downpipes/detail.ts";
import { openCreateWizard, openEditor, openImport, prefillFromQuery } from "./sources-downpipes/editor.ts";
import { errMsg, loadingCount, type RunFacts, unreadFilterNote } from "./sources-downpipes/helpers.ts";
import { buildTable, fillFreshness, FRESHNESS_FIRST_LOAD_BUDGET, FRESHNESS_STEADY_BUDGET, protectionSubtitle, trueEmpty } from "./sources-downpipes/table.ts";

export { openBulkSummary } from "./sources-downpipes/detail.ts";
export { prefillFromQuery } from "./sources-downpipes/editor.ts";
// Re-exports kept so the split preserves external callers' import paths.
export type { RestoreTestRecencyKind } from "./sources-downpipes/helpers.ts";
export {
  restoreTestCadenceLabel,
  restoreTestReasonPhrase,
  restoreTestRecency,
  retentionSummary,
  validateRetention,
} from "./sources-downpipes/helpers.ts";

// The per-downpipe latest-run cache used by the freshness column is render-scoped
// (rebuilt each render()), not global, with THREE narrow exceptions below (IN_FLIGHT_LIST,
// IN_FLIGHT_LOAD and RECENT_LOAD), all there to close the SAME identity-resolve race without paying for
// it with a second full fleet fetch. See load()'s use of all three.
//
// WHY A RACE EXISTS AT ALL: app.ts re-renders the on-screen screen, from scratch, the instant the
// verified caller lands (reRenderCurrentScreenForResolvedIdentity), because whoami always starts pending
// at a cold mount and a screen gated on role/capability must not stay painted against a stale guess.
// That re-render calls this screen's render() again with brand-new closures, and it typically lands
// WELL UNDER A SECOND after this screen's own first paint -- measured at about 0.2 s, which is faster
// than a bounded first-load fill (FRESHNESS_FIRST_LOAD_BUDGET rows, each a real network round trip) ever
// finishes on a large fleet. A load() that assumed the first one had already LANDED by the time a second
// one could start would be wrong on exactly this path, every time: read on.
//
// IN_FLIGHT_LIST settles the moment the shared listDownpipes + status calls land (or fail), well before
// the bounded freshness fill that follows them does. A render that joins a load already in flight (a
// fresh navigation -- create, edit, import, a row's detail drawer, the plain list -- arriving while an
// earlier render's load() is still running) awaits ONLY this: it paints and opens whatever surface its
// route asked for the instant the list is in hand, rather than waiting on a fill that can run for seconds
// on a large fleet. It stays set for the WHOLE load, not just until the list lands (see load()'s own
// comment on why), so a second render joining mid-fill still shares the one fetch rather than starting
// its own.
//
// IN_FLIGHT_LOAD shares the CURRENTLY RUNNING first-load fetch + fill across every render() instance of
// this screen, closing the race load()'s own comment above describes. A render already on screen when the
// fill lands adopts its latestRun map in place (no repaint of anything already painted, no second
// route-open); a render that starts a fresh load() while one is already running shares THIS SAME promise
// instead of running a second full listDownpipes + fillFreshness of its own (a second full history-request
// pass, back to back with the first, for an identity change that never touched the downpipe list -- the
// defect this closes). IN_FLIGHT_LIST and IN_FLIGHT_LOAD are cleared together, the instant the WHOLE load
// (list and fill both) settles, success or not.
//
// RECENT_LOAD, separately, carries a load that has already LANDED (not one still running) across a
// render() that starts within RECENT_LOAD_TTL_MS of it: the rarer case where the identity race lands
// just after the first fill finishes rather than during it. Module scope (all three survive the fresh
// closures a re-render creates); a load() that starts inside the TTL reuses it instead of re-fetching.
// The TTL is short: long enough to absorb a late identity resolve, short enough that a genuine revisit
// moments later still reads fresh. reload() (the mutation and poll path) never consults any of these;
// only the first-mount load() does.
interface ListResult {
  list: DownpipeState[];
  status: StatusReport | null;
}
interface LoadResult {
  list: DownpipeState[];
  status: StatusReport | null;
  latestRun: Map<string, RunFacts>;
}
let IN_FLIGHT_LIST: Promise<ListResult | { error: unknown }> | null = null;
let IN_FLIGHT_LOAD: Promise<LoadResult | { error: unknown }> | null = null;
const RECENT_LOAD_TTL_MS = 3000;
let RECENT_LOAD: { at: number; list: DownpipeState[]; status: StatusReport | null; latestRun: Map<string, RunFacts> } | null = null;

// STEADY_READ_BUDGET_MS / STEADY_READ_BUDGET / STEADY_READS: ONE rolling budget for every history read
// a refresh (reload(), poll-driven or mutation-driven) makes AFTER the first load, at module scope so
// it is the same ledger whichever render() instance of this screen is doing the reading. Each refresh
// used to get its OWN FRESHNESS_STEADY_BUDGET, fresh every time, which let a trickle at the END of one
// refresh and a handful of on-screen reads at the START of the next (a cohort of runs leaving flight
// together, each wanting its own read) add up to more than the budget in any real 30 s stretch, even
// though each refresh individually stayed under it. STEADY_READS holds the wall-clock instant of every
// read issued since the first load; steadyBudgetRemaining() prunes anything older than
// STEADY_READ_BUDGET_MS and returns what is left of STEADY_READ_BUDGET, so the next refresh's budget is
// however much room the TRAILING 30 s actually has, not a flat per-refresh number. The first load keeps
// its own separate, fixed FRESHNESS_FIRST_LOAD_BUDGET (table.ts) and is never charged against this
// ledger: the two are deliberately independent budgets, matching the two distinct numbers reported
// against this screen (a first-load count and a steady-state rate).
const STEADY_READ_BUDGET_MS = 30_000;
let STEADY_READS: number[] = [];
function steadyBudgetRemaining(): number {
  const cutoff = Date.now() - STEADY_READ_BUDGET_MS;
  STEADY_READS = STEADY_READS.filter((at) => at > cutoff);
  return Math.max(0, FRESHNESS_STEADY_BUDGET - STEADY_READS.length);
}
function recordSteadyReads(count: number): void {
  const now = Date.now();
  for (let i = 0; i < count; i++) STEADY_READS.push(now);
}

// _testResetFreshnessPacing clears every module-scope state this file keeps across render()
// instances (IN_FLIGHT_LIST, IN_FLIGHT_LOAD, RECENT_LOAD, the rolling STEADY_READS ledger), for a test harness that
// drives several independent simulated mounts of this screen in one process: without it, a later
// scenario's wall-clock budget check would read leftover timestamps from an earlier scenario's (likely
// faked) clock, which is not a real condition this screen ever faces (an actual page load starts this
// module fresh). Test-only; never called from production code.
export function _testResetFreshnessPacing(): void {
  IN_FLIGHT_LIST = null;
  IN_FLIGHT_LOAD = null;
  RECENT_LOAD = null;
  STEADY_READS = [];
}

// The downpipes list route, exported so an outside caller (the guided tour's chapter vocabulary;
// chapters.ts) references the same literal this descriptor uses, rather than a copy. The other three
// patterns this screen owns (new / :id / :id/edit) have no outside caller today, so they stay inline.
export const ROUTE_DOWNPIPES = "/downpipes";

export const sourcesDownpipesScreen: Screen = {
  // This screen owns the downpipes routes (list + new + detail + edit). The
  // integrator binds these from the descriptor; if both this and the B1
  // downpipes.ts are present, the integrator picks one per pattern (this is the
  // screen-2 build).
  route: [ROUTE_DOWNPIPES, "/downpipes/new", "/downpipes/:id", "/downpipes/:id/edit"],
  title: "Downpipes",
  measure: "wide",
  actions: screenActions(),
  render(ctx) {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root;
    // A non-null alias: the hoisted renderList() below is analysed without the
    // narrowing from the guard above (a function declaration is not narrowed by
    // surrounding control flow), so it reads this unconditional EngineClient.
    const eng: EngineClient = engine;

    const pattern = ctx.pattern;
    const isCreate = pattern === "/downpipes/new";
    const isEdit = pattern === "/downpipes/:id/edit";
    const detailId = pattern === "/downpipes/:id" ? ctx.params.id : undefined;
    const editId = isEdit ? ctx.params.id : undefined;

    // Header: ONE primary action. Too many header buttons leave their order unclear, so this
    // screen keeps a single primary action. Picking and attaching sources
    // is the Sources screen's job; this screen manages routes and creates new ones.
    // The engine gates create AND edit (upsert) on downpipe.write, so mirror that capability rather
    // than the operator ladder rank: a custom role holding downpipe.write can create a downpipe, and
    // the button (and its edit/create deep-links below) must reflect that, never floor it to Viewer.
    const opGate = canCap("downpipe.write");
    // Gated: aria-disabled keeps the button focusable and the reason is announced as the button's
    // DESCRIPTION (the shared primitive), never a hover-only title and never glued into its name.
    const createBtn = opGate
      ? h("button", { "data-dp": "sources-downpipes.button.create#1", class: "btn btn--primary btn--sm", type: "button", on: { click: () => navigate("/downpipes/new") } }, svgIcon(ICON_PLUS, { size: 14 }), "New downpipe")
      : h("button", { "data-dp": "sources-downpipes.button.create#2", class: "btn btn--primary btn--sm", type: "button" }, svgIcon(ICON_PLUS, { size: 14 }), "New downpipe");
    if (!opGate) refuseWithReason(createBtn, capGateReason("downpipe.write"));
    // The auto-refresh pause (WCAG 2.2.2): the list polls in place, so the operator can stop it.
    const headerActions = h("div", { class: "page-header__actions" }, autoRefreshToggle(), createBtn);

    // The residency and verification claims live on the destination surfaces (an S3
    // destination CAN leave the account; this header must not overclaim for it).
    root.appendChild(
      pageHeader(
        "Downpipes",
        "Backup routes from your Cloudflare sources, data stores, Workers, media and account config, to your archive destination. Each downpipe runs on a schedule you set.",
        headerActions,
      ),
    );

    // Section landmark below the h1: the table region gets a real h2 so
    // heading navigation lands on the work surface; visually hidden, the page
    // header already carries the visible title and the table is self-evident.
    root.appendChild(h("h2", { class: "visually-hidden" }, "All downpipes"));
    const region = h("div", { class: "async-region" });
    root.appendChild(region);

    // The live engine status (for the destination clarity block, residency, and
    // the destKind branch). Loaded once alongside the list; null until resolved or
    // if the call fails (the destination block degrades honestly to "unknown").
    let status: StatusReport | null = null;
    // The bindings that already have a downpipe (kv/r2/d1 source bindings + every
    // secrets-source binding), kept fresh by load()/reload() so the Choose-sources
    // picker can mark them untouchable instead of letting a re-create overwrite.
    let knownBindings = new Set<string>();
    const rememberBindings = (list: DownpipeState[]): void => {
      const next = new Set<string>();
      for (const st of list) {
        const src = st.config.source;
        if (typeof src.binding === "string" && src.binding !== "") next.add(src.binding);
        for (const sec of src.secrets ?? []) next.add(sec.binding);
      }
      knownBindings = next;
    };
    // The per-downpipe run facts (newest run + newest good run), for the freshness
    // column and the shared staleness rule. Filled lazily.
    const latestRun = new Map<string, RunFacts>();
    let table: ReturnType<typeof dataTable<DownpipeState>> | null = null;

    // visibleDownpipeIds reads which rows the table CURRENTLY RENDERS: the windowed table
    // (components/data-table-render.ts) past its row-count threshold renders only the visible slice
    // plus a small overscan, so the rendered `tr[data-key]` set already IS "on screen or one scroll
    // away", synchronously and with no extra observer wiring (the same `tr[data-key]` + `.dataset.key`
    // pair detail.ts's own row-scroll lookup reads). fillFreshness reads this set to prioritise a
    // history read the operator can actually see over one further down an unscrolled list.
    const visibleDownpipeIds = (): ReadonlySet<string> => {
      const ids = new Set<string>();
      if (!table) return ids;
      for (const tr of table.el.querySelectorAll<HTMLElement>("tr[data-key]")) {
        const key = tr.dataset.key;
        if (key) ids.add(key);
      }
      return ids;
    };

    // lastList is the most recent list this screen has in hand, kept for the ONE handler that needs a
    // list outside a fetch's own closure: the table's onStateChange (a facet/filter/sort change), which
    // fires from an operator click, not a fetch.
    let lastList: DownpipeState[] = [];

    // statusFacetPriorityIds: while a Stale or Failed status facet is active, an UNREAD row cannot be
    // evaluated against it honestly (see updateUnreadNote below), so a row this build has not read yet
    // that still matches every OTHER active facet (today: the type facets) is worth reading SOONER than
    // an unrelated off-screen row, within fillFreshness's ordinary trickle budget (table.ts
    // FreshnessFillOptions.priorityIds). Deliberately ignores the free-text filter query: it is a
    // priority HINT, not a gate, so reading a row the text filter would anyway exclude costs nothing
    // beyond a slightly less optimal order, never a wrong value.
    const statusFacetPriorityIds = (list: DownpipeState[], facets: readonly string[]): ReadonlySet<string> => {
      if (!facets.some((f) => f.startsWith("status-"))) return new Set();
      const typeFacets = facets.filter((f) => f.startsWith("type-")).map((f) => f.slice("type-".length));
      const ids = new Set<string>();
      for (const d of list) {
        if (d.inFlight || latestRun.get(d.config.id) !== undefined) continue; // already known
        if (typeFacets.length > 0 && !typeFacets.includes(d.config.source.type)) continue;
        ids.add(d.config.id);
      }
      return ids;
    };

    // unreadNoteHost sits just above the table (renderList below), updated in place (never rebuilt via
    // a full renderList) so it never fights the operator's scroll position, sort or selection. It names
    // how many downpipes' run state is still unread WHILE a Stale or Failed status facet is active: that
    // facet is run-state-derived (table.ts buildFacets), so an unread row reads neither Stale nor Failed
    // and simply does not appear, which would otherwise look like a complete, honest count when it is
    // an INCOMPLETE one. ASD-STE100: one short present-tense sentence stating the fact, one stating what
    // happens next; no claim about the product beyond what is true right now.
    const unreadNoteHost = h("div");
    const updateUnreadNote = (list: DownpipeState[], facets: readonly string[]): void => {
      if (!facets.some((f) => f.startsWith("status-"))) {
        unreadNoteHost.replaceChildren();
        return;
      }
      const note = unreadFilterNote(loadingCount(list, latestRun));
      if (note === "") {
        unreadNoteHost.replaceChildren();
        return;
      }
      unreadNoteHost.replaceChildren(noteQuiet(h("p", note)));
    };

    // STANDING in-place auto-refresh (like the Map and Overview pages; pausable per WCAG 2.2.2 via
    // the page-header toggle). The list refreshes on a cadence so a run's status transitions
    // (Running -> ok/failed) appear without a manual reload: without it, "Run now" would show
    // Running and the page would never update on its own. The cadence is FAST while any run is in flight
    // (responsive during a run) and steady otherwise. Self-terminating: the callback bails the instant
    // the screen leaves the DOM (root.isConnected), so it never polls a detached screen; it honours the
    // pause preference, and while the tab is hidden it skips the fetch but keeps ticking so it resumes
    // on its own.
    let pollTimer: number | undefined;
    const POLL_MS = 30_000;
    const INFLIGHT_POLL_MS = 4000;

    const clearPoll = (): void => {
      if (pollTimer !== undefined) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
    };
    const schedulePoll = (list: DownpipeState[]): void => {
      clearPoll();
      // No synchronous bail on !root.isConnected here: the first schedule can run BEFORE the
      // router attaches root (the faked tour engine resolves in a microtask), and bailing then
      // would disable auto-refresh for the life of the screen. The timer's own fire-time check
      // below makes a stray post-unmount timer harmless (it exits without rescheduling).
      const due = list.some((d) => d.inFlight) ? INFLIGHT_POLL_MS : POLL_MS;
      pollTimer = window.setTimeout(() => {
        pollTimer = undefined;
        if (!root.isConnected) return;
        if (getAutoRefresh() === "paused" || document.hidden) {
          schedulePoll([]); // paused/hidden: do not fetch, just keep ticking at the steady cadence
          return;
        }
        reload();
      }, due);
    };

    // reloading/reloadQueued serialise reload() against itself: the freshness fill below can
    // outlast a single poll interval on a large fleet, and firing a second listDownpipes +
    // fillFreshness cycle on top of one still running is exactly how one refresh becomes a storm
    // of overlapping history reads. A call that lands mid-cycle (the standing poll's own timer,
    // or a mutation's save/toggle/undo callback) is coalesced into ONE follow-up run straight
    // after the current one finishes, rather than stacking another concurrent cycle on it.
    let reloading = false;
    let reloadQueued = false;

    // reload re-fetches the list (after a mutation) and refreshes the table rows
    // in place, preserving the operator's filter/sort/selection where the table can.
    const reload = (): void => {
      clearPoll();
      if (reloading) {
        reloadQueued = true;
        return;
      }
      reloading = true;
      void engine
        .listDownpipes()
        .then(async (list) => {
          rememberBindings(list);
          lastList = list;
          if (table) table.setRows(list);
          const facets = table?.getState().facets ?? [];
          updateUnreadNote(list, facets);
          // Refresh the freshness cache for the visible set. Awaited (not fire-and-forget): the
          // next poll must not be armed, and a queued reload must not start, until this cycle's
          // own history reads have finished. budget is whatever the ROLLING ledger has left (see
          // steadyBudgetRemaining's own comment): every refresh shares the one 30 s budget, so a
          // trickle at the end of one refresh and a cohort of on-screen reads at the start of the
          // next cannot add up to more than STEADY_READ_BUDGET between them. allowTrickle stays true
          // on every refresh; the rolling budget alone is what paces an off-screen read now.
          const reads = await fillFreshness(engine, list, latestRun, () => {
            if (table) table.setRows(list);
            updateUnreadNote(list, table?.getState().facets ?? []);
          }, {
            visibleIds: visibleDownpipeIds(),
            budget: steadyBudgetRemaining(),
            allowTrickle: true,
            priorityIds: statusFacetPriorityIds(list, facets),
          });
          recordSteadyReads(reads);
          reloading = false;
          if (reloadQueued) {
            reloadQueued = false;
            reload();
            return;
          }
          // Re-arm the standing poll (fast cadence while a run is in flight, steady otherwise),
          // only now that this cycle is fully done.
          schedulePoll(list);
        })
        .catch((err) => {
          reloading = false;
          if (isUnauthorised(err)) return goSignedOut();
          // A reload failure is non-fatal: keep the current table, surface a toast, and keep the
          // standing poll alive so a transient failure does not end auto-refresh for the screen's life.
          toast({ message: `Could not refresh the downpipes. ${errMsg(err)}`, tone: "warn" });
          schedulePoll([]);
        });
    };

    // paintList remembers the bindings and (re)builds the table. Split out of afterListLoaded so the
    // fresh-fetch path in load() can paint BEFORE running fillFreshness: fillFreshness needs the table's
    // rendered rows to know what is visible (visibleDownpipeIds), so the table has to exist first.
    const paintList = (list: DownpipeState[]): void => {
      rememberBindings(list);
      renderList(list);
    };

    // afterListLoaded is the common tail for a fresh fetch AND a reused RECENT_LOAD (load(), below):
    // arm the standing poll and open whatever surface the route asked for. Split out so the
    // identity-resolve reuse path does not have to duplicate the route-opening logic to stay in step
    // with it. Does NOT paint (see paintList): a fresh fetch paints earlier so fillFreshness can read
    // the table's visible rows, and painting twice would rebuild a large table for nothing.
    const afterListLoaded = (list: DownpipeState[]): void => {
      // Start the standing auto-refresh now that a list is in hand.
      schedulePoll(list);

      // Open the create / edit / detail surface the route asked for, once the
      // list is in hand (so edit/detail can resolve the entity). The
      // ?action=import param is written by the import-downpipes palette
      // command: navigating to /downpipes?action=import directly opens the
      // import drawer so the operator lands with it open, not having to find
      // the button themselves. The param is consumed once and cleared from
      // the URL so the back button is clean.
      const actionParam = ctx.query.get("action");
      if (actionParam === "import") {
        try { history.replaceState({}, "", "/downpipes"); } catch { /* best-effort */ }
        if (opGate) openImport(eng, status, knownBindings, reload);
        else toast({ message: capGateReason("downpipe.write"), tone: "info" });
      } else if (isCreate) {
        // The create editor honours an add-source prefill passed via the query
        // (/downpipes/new?binding=SRC_KV_uploads&type=kv), so the guided add-source
        // flow leads straight into configuring a downpipe against the binding the
        // operator just deployed, without duplicating this editor. The prefill is
        // read-only seeding; the operator can change anything before saving.
        // Gated exactly like the import branch (Operator+): a Viewer deep-linking
        // here gets the gate reason and the list, never an editor that 403s on save.
        if (opGate) openCreateWizard(eng, status, knownBindings, reload, () => navigate(`/downpipes${location.search}`), prefillFromQuery(ctx.query));
        else {
          toast({ message: capGateReason("downpipe.write"), tone: "info" });
          navigate("/downpipes", { replace: true });
        }
      } else if (isEdit && editId) {
        const target = list.find((d) => d.config.id === editId);
        if (!target) navigate("/downpipes", { replace: true });
        else if (opGate) openEditor(engine, target.config, status, reload, () => navigate(`/downpipes${location.search}`), undefined, target.configRev);
        else {
          // Same Operator+ gate as create: land the Viewer on the read-only detail
          // drawer (where every write is disabled-with-reason) instead of an editor.
          toast({ message: capGateReason("downpipe.write"), tone: "info" });
          navigate(`/downpipes/${encodeURIComponent(editId)}`, { replace: true });
        }
      } else if (detailId) {
        const target = list.find((d) => d.config.id === detailId);
        if (target) openDetail(engine, target, { latestRun, status, reload });
        else {
          // A deep link naming a downpipe the list cannot resolve (deleted meanwhile, or an
          // orphaned map edge's id) would otherwise land silently on the bare list, reading as
          // a dead end. Say what happened; the list below is current.
          toast({ message: "That downpipe no longer exists; showing the current list.", tone: "info" });
          navigate("/downpipes", { replace: true });
        }
      }
    };

    // load performs the first-load data fetch: the list + status resolved together,
    // followed by the freshness fill and the route-driven drawer open. It is a named
    // function so the blockError Retry callback can re-invoke it in place (no page
    // reload) rather than discarding the SPA session state on a transient failure.
    const load = (): void => {
      // SHARE a load that is CURRENTLY RUNNING (see the comment on IN_FLIGHT_LIST / IN_FLIGHT_LOAD
      // above): this is what closes the identity-resolve race while the first fill is still going, the
      // common case on a large fleet. Paint a skeleton (this render's own table does not exist yet) and
      // adopt whatever the shared fetch produces. A failed shared load paints its reason here, with a
      // Retry through this render's own load(), because this render is the one on screen and must never
      // stay on a skeleton.
      if (IN_FLIGHT_LIST) {
        region.replaceChildren(skeletonRows(6));
        // A status-filtered deep link (?status=stale/failed) reads the freshness cache directly (the
        // facet filter in table.ts): joining before the bounded fill lands would paint it falsely empty
        // rather than honestly unfilled, so this one case still waits for the WHOLE shared load, same as
        // before.
        if ((ctx.query.get("status") ?? "") !== "") {
          const fullLoad = IN_FLIGHT_LOAD;
          void fullLoad?.then((result) => {
            // PAINT FIRST, THEN LEAVE: this render is the one on screen, so a failed shared load paints
            // its own reason here, with the same Retry the original render offers.
            if ("error" in result) {
              if (isUnauthorised(result.error)) {
                region.replaceChildren(sessionEnded(() => load()));
                return;
              }
              region.replaceChildren(blockError(result.error, () => load(), { origin: location.origin }));
              return;
            }
            status = result.status;
            for (const [id, facts] of result.latestRun) latestRun.set(id, facts);
            paintList(result.list);
            afterListLoaded(result.list);
          });
          return;
        }
        // Every other joining render (create, edit, import, a row's detail drawer, the palette, the
        // plain list) needs only the list + status, not the bounded fill: paint and open the surface the
        // route asked for the instant they land, then adopt the filled freshness data in place once it
        // arrives, without a second fetch and without opening anything twice.
        void IN_FLIGHT_LIST.then((listResult) => {
          // PAINT FIRST, THEN LEAVE: this render is the one on screen, so a failed shared load paints
          // its own reason here, with the same Retry the original render offers.
          if ("error" in listResult) {
            if (isUnauthorised(listResult.error)) {
              region.replaceChildren(sessionEnded(() => load()));
              return;
            }
            region.replaceChildren(blockError(listResult.error, () => load(), { origin: location.origin }));
            return;
          }
          status = listResult.status;
          paintList(listResult.list);
          afterListLoaded(listResult.list);
          const fullLoad = IN_FLIGHT_LOAD;
          if (!fullLoad) {
            // The fill landed between the list result and this line: adopt its facts from RECENT_LOAD, so the
            // rows do not wait for the trickle to read them again.
            if (RECENT_LOAD) {
              for (const [id, facts] of RECENT_LOAD.latestRun) latestRun.set(id, facts);
              if (table) table.setRows(listResult.list);
              updateUnreadNote(listResult.list, table?.getState().facets ?? []);
            }
            return;
          }
          void fullLoad.then((result) => {
            if ("error" in result) return; // already painted above; the owning render shows the same reason
            for (const [id, facts] of result.latestRun) latestRun.set(id, facts);
            if (table) table.setRows(listResult.list);
            updateUnreadNote(listResult.list, table?.getState().facets ?? []);
          });
        });
        return;
      }
      // REUSE a load that landed within RECENT_LOAD_TTL_MS (see the comment on RECENT_LOAD above): the
      // rarer case where the race lands just after the first fill finishes rather than during it. A
      // facet-filtered deep link (?status=...) still reads the cache honestly, because RECENT_LOAD only
      // ever holds a load whose freshness fill had already completed (the facet branch below awaits it
      // before storing).
      if (RECENT_LOAD && Date.now() - RECENT_LOAD.at < RECENT_LOAD_TTL_MS) {
        status = RECENT_LOAD.status;
        for (const [id, facts] of RECENT_LOAD.latestRun) latestRun.set(id, facts);
        const reused = RECENT_LOAD.list;
        paintList(reused);
        // This branch runs inside render(), so open any route surface (create, edit, import, the drawer) on a
        // microtask: the router's afterEach closes every overlay right after render() returns (app.ts
        // installAfterEach), and a surface opened before that is closed at once.
        queueMicrotask(() => afterListLoaded(reused));
        return;
      }
      region.replaceChildren(skeletonRows(6));
      // resolveSharedList settles IN_FLIGHT_LIST for every render() racing this one the moment the list
      // and status land -- a racing render wants to paint and open its own route NOW, not once the
      // bounded fill (which can take seconds on a large fleet) has also landed. resolveShared settles
      // IN_FLIGHT_LOAD once the bounded first fill has actually LANDED (not merely once list/status
      // have): a racing render that needs the filled result (the status-facet deep link) or wants to
      // adopt it in place wants a USABLE result, not one where every row still reads Loading. { error }
      // means the load failed outright; this render's own branch below has already painted why, and a
      // racing render paints the same reason.
      let resolveSharedList!: (result: ListResult | { error: unknown }) => void;
      const sharedList = new Promise<ListResult | { error: unknown }>((resolve) => {
        resolveSharedList = resolve;
      });
      IN_FLIGHT_LIST = sharedList;
      let resolveShared!: (result: LoadResult | { error: unknown }) => void;
      const shared = new Promise<LoadResult | { error: unknown }>((resolve) => {
        resolveShared = resolve;
      });
      // Cleared TOGETHER, once the WHOLE load (list and fill both) settles: a render that joins mid-fill
      // must still find IN_FLIGHT_LIST set (it already resolved, but the load it belongs to has not
      // finished), so a third render arriving after the list lands but before the fill does still shares
      // this same fetch instead of starting a second one.
      IN_FLIGHT_LOAD = shared.finally(() => {
        IN_FLIGHT_LOAD = null;
        IN_FLIGHT_LIST = null;
      });
      void Promise.allSettled([engine.listDownpipes(), engine.status()])
        .then(async (results) => {
          const listRes = results[0];
          const statusRes = results[1];
          if (listRes.status === "rejected") {
            const err = listRes.reason;
            resolveSharedList({ error: err });
            if (isUnauthorised(err)) {
              // PAINT FIRST, THEN LEAVE: the downpipe table is a skeleton until this replaces it.
              region.replaceChildren(sessionEnded(() => load()));
              resolveShared({ error: err });
              return goSignedOut();
            }
            region.replaceChildren(blockError(err, () => load(), { origin: location.origin }));
            resolveShared({ error: err });
            return;
          }
          if (statusRes.status === "fulfilled") status = statusRes.value;
          const list = listRes.value;
          resolveSharedList({ list, status });

          // Paint FIRST (names, schedule, enabled state are all known already): the table exists with
          // its real rendered rows before fillFreshness runs, so it can read which rows the operator
          // can actually see (visibleDownpipeIds) rather than guessing. Those rows carry an honest
          // "Loading" State (helpers.ts freshnessFor) until their own read lands.
          paintList(list);

          // Fill the freshness cache, bounded (table.ts: no more "read everything", see
          // FRESHNESS_FIRST_LOAD_BUDGET's own comment for why). The table re-renders as entries arrive
          // so the first paint is never blocked on it, EXCEPT when the deep link carries a STATUS facet
          // (?status=stale/failed): that facet reads the freshness cache, so an unfilled cache would
          // land the Overview "stale" link on a falsely empty list, even though every absent row now
          // reads an honest "Loading" rather than a wrong one. Hold the skeleton until THIS bounded
          // fill lands, then render with the facet as honest as a first paint can be.
          //
          // Marked `reloading` for the same reason reload() marks itself: this can outlast the standing
          // poll's own first interval (armed right below), and a poll that fired mid-fill must coalesce
          // into one follow-up cycle rather than starting a second concurrent fill on top of this one.
          reloading = true;
          const fillDone = fillFreshness(engine, list, latestRun, () => {
            if (table) table.setRows(list);
            updateUnreadNote(list, table?.getState().facets ?? []);
          }, {
            visibleIds: visibleDownpipeIds(),
            budget: FRESHNESS_FIRST_LOAD_BUDGET,
            allowTrickle: true,
            priorityIds: statusFacetPriorityIds(list, table?.getState().facets ?? []),
          }).then(() => {
            reloading = false;
            const result: LoadResult = { list, status, latestRun: new Map(latestRun) };
            RECENT_LOAD = { at: Date.now(), ...result };
            resolveShared(result);
            if (reloadQueued) {
              reloadQueued = false;
              reload();
            }
          });
          if ((ctx.query.get("status") ?? "") !== "") await fillDone;
          else void fillDone;

          afterListLoaded(list);
        })
        .catch((err) => {
          // A throw inside the .then() callback (renderList, openCreateWizard, etc.)
          // would otherwise be swallowed by the void and leave the screen on the
          // skeleton forever. Mirror the inner listRes-rejection path: sign out on an
          // auth failure, otherwise show the block error with a Retry that re-runs load.
          // resolveSharedList has already settled by this point on every real path (the throw can only
          // happen after the list landed); calling it again is a harmless no-op on an already-settled
          // promise, kept only so this catch mirrors resolveShared's own fallback below.
          resolveSharedList({ error: err });
          resolveShared({ error: err });
          if (isUnauthorised(err)) {
            // PAINT FIRST, THEN LEAVE: a throw inside the .then above leaves the same skeleton behind.
            region.replaceChildren(sessionEnded(() => load()));
            return goSignedOut();
          }
          region.replaceChildren(blockError(err, () => load(), { origin: location.origin }));
        });
    };

    // Resume the refresh immediately when auto-refresh is un-paused; stop the timer on pause. The
    // listener self-cleans when it next fires detached (the codebase idiom; screens swap without a
    // dispose hook), so a navigated-away screen never keeps polling.
    const unsubRefresh = onAutoRefreshChange((pref) => {
      if (!root.isConnected) {
        unsubRefresh();
        clearPoll();
        return;
      }
      if (pref === "paused") clearPoll();
      else reload();
    });

    // Kick off the first load.
    load();

    // renderList builds the table (or the true-empty teaching state).
    function renderList(list: DownpipeState[]): void {
      lastList = list;
      if (list.length === 0) {
        region.replaceChildren(trueEmpty(opGate));
        return;
      }
      table = buildTable(eng, list, latestRun, ctx.query, opGate, reload, destinationFromStatus(status), readRecoveryPosture(status), (st) => updateUnreadNote(lastList, st.facets));
      // The plain-English protection subtitle: the fleet protection summary + the blunt not-covered
      // line, the SAME fleetProtection generator the overview lead line uses (so the two surfaces
      // cannot disagree). Honest: never "all covered" unless every enabled downpipe is proven; reads
      // the engine destination from the loaded status (honest unknown when status was not read).
      const subtitle = protectionSubtitle(list, status);
      // A section heading below the h1 lets assistive technology navigate into the table region by
      // landmark. Visually hidden so the toolbar carries the visual weight; the h2 is structural only.
      const sectionHeading = h("h2", { class: "visually-hidden" }, "Backup routes");
      updateUnreadNote(list, table.getState().facets);
      region.replaceChildren(subtitle, sectionHeading, unreadNoteHost, table.el);

      // The "/" key focuses the filter (flow.md B), unless the operator is typing
      // in a field already. Scoped to this screen's lifetime via the region node.
      region.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key !== "/") return;
        const t = ev.target as HTMLElement;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
        ev.preventDefault();
        table?.focusFilter();
      });
    }

    return root;
  },
};

// screenActions declares the commands this screen contributes to the shared action
// registry / command palette (common.ts ScreenAction). Each is gated by role +
// engine state; a command the role cannot run is not shown (the palette never lists
// an action that would 403). The integrator merges these via allScreenActions().
function screenActions(): ScreenAction[] {
  return [
    {
      id: "goto-downpipes",
      title: "Go to Downpipes",
      group: "Navigation",
      kind: "navigate",
      keywords: ["downpipes", "sources", "backup", "routes"],
      target: "/downpipes",
      shortcut: "g d",
    },
    {
      id: "create-downpipe",
      title: "New downpipe",
      group: "Downpipes",
      kind: "navigate",
      keywords: ["create", "new", "add", "downpipe", "source", "kv", "r2", "secrets", "d1"],
      target: "/downpipes/new",
      // The engine's own gate for creating a downpipe is the downpipe.write CAPABILITY, which is what
      // the screen's own New downpipe button already reads (canCap("downpipe.write") below). Gating on
      // a role-NAME list instead would floor every NAMED custom role to the "viewer" the engine pins
      // on its role field, hiding the command from a custom role that holds downpipe.write. callerCan
      // resolves the effective set; a null caller fails closed.
      when: ({ caller: c }) => c !== null && callerCan(c.role, "downpipe.write", c.customRole ?? null),
    },
    {
      // Navigating directly to /downpipes?action=import makes the screen auto-open the import
      // drawer on arrival, so the operator does not have to find the "Import a list" button
      // manually after being routed to /downpipes.
      id: "import-downpipes",
      title: "Import a list of downpipes",
      group: "Downpipes",
      kind: "navigate",
      keywords: ["import", "bulk", "list", "downpipes", "create"],
      target: "/downpipes?action=import",
      // Same basis as create-downpipe above: a bulk import CREATES downpipes, so it mirrors the
      // downpipe.write capability rather than a role-name list that floors a named custom role.
      when: ({ caller: c }) => c !== null && callerCan(c.role, "downpipe.write", c.customRole ?? null),
    },
  ];
}
