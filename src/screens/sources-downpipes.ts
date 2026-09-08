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
// Operator+ writes) but the engine is the enforcement point. Australian English,
// no em dashes, precise claims.

import type {
  DownpipeState,
  EngineClient,
  StatusReport,
} from "../api.ts";
import type { dataTable } from "../components/data-table.ts";
import { blockError, sessionEnded } from "../components/error-view.ts";
import { skeletonRows } from "../components/feedback.ts";
import { toast } from "../components/toast.ts";
import { h, refuseWithReason, svgIcon } from "../lib/dom.ts";
import { isUnauthorised } from "../lib/errors.ts";
import { ICON_PLUS } from "../lib/icons.ts";
import { callerCan } from "../lib/identity-custom-roles.ts";
import { goSignedOut, navigate } from "../lib/nav.ts";
import { destinationFromStatus } from "../lib/protection-statement.ts";
import { autoRefreshToggle, getAutoRefresh, onAutoRefreshChange } from "../lib/refresh-pref.ts";
import { canCap, capGateReason, pageHeader, requireEngine, type Screen, type ScreenAction } from "./common.ts";
import { openDetail } from "./sources-downpipes/detail.ts";
import { openCreateWizard, openEditor, openImport, prefillFromQuery } from "./sources-downpipes/editor.ts";
import { errMsg, type RunFacts } from "./sources-downpipes/helpers.ts";
import { buildTable, fillFreshness, protectionSubtitle, trueEmpty } from "./sources-downpipes/table.ts";

export { openBulkSummary } from "./sources-downpipes/detail.ts";
export { prefillFromQuery } from "./sources-downpipes/editor.ts";
// Re-exports kept so the split preserves external callers' import paths.
export type { RestoreTestRecencyKind } from "./sources-downpipes/helpers.ts";
export {
  friendlyName,
  type RestoreTestRecency,
  restoreTestCadenceLabel,
  restoreTestReasonPhrase,
  restoreTestRecency,
  retentionSummary,
  validateRetention,
} from "./sources-downpipes/helpers.ts";

// The per-downpipe latest-run cache used by the freshness column is render-scoped
// (rebuilt each render()), not global.

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

    // Header: ONE primary action (the IA reorganisation, owner feedback:
    // too many buttons whose order was not obvious). Picking and attaching sources
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

    // Section landmark below the h1 (A11Y-09): the table region gets a real h2 so
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

    // STANDING in-place auto-refresh (like the Map and Overview pages; pausable per WCAG 2.2.2 via
    // the page-header toggle). The list refreshes on a cadence so a run's status transitions
    // (Running -> ok/failed) appear without a manual reload, the reported gap was that "Run now"
    // showed Running and then the page never updated. The cadence is FAST while any run is in flight
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

    // reload re-fetches the list (after a mutation) and refreshes the table rows
    // in place, preserving the operator's filter/sort/selection where the table can.
    const reload = (): void => {
      void engine
        .listDownpipes()
        .then((list) => {
          rememberBindings(list);
          if (table) table.setRows(list);
          // Refresh the freshness cache for the visible set.
          void fillFreshness(engine, list, latestRun, () => {
            if (table) table.setRows(list);
          });
          // Re-arm the standing poll (fast cadence while a run is in flight, steady otherwise).
          schedulePoll(list);
        })
        .catch((err) => {
          if (isUnauthorised(err)) return goSignedOut();
          // A reload failure is non-fatal: keep the current table, surface a toast.
          toast({ message: `Could not refresh the downpipes. ${errMsg(err)}`, tone: "warn" });
        });
    };

    // load performs the first-load data fetch: the list + status resolved together,
    // followed by the freshness fill and the route-driven drawer open. It is a named
    // function so the blockError Retry callback can re-invoke it in place (no page
    // reload) rather than discarding the SPA session state on a transient failure.
    const load = (): void => {
      region.replaceChildren(skeletonRows(6));
      void Promise.allSettled([engine.listDownpipes(), engine.status()])
        .then(async (results) => {
          const listRes = results[0];
          const statusRes = results[1];
          if (listRes.status === "rejected") {
            const err = listRes.reason;
            if (isUnauthorised(err)) {
              // PAINT FIRST, THEN LEAVE: the downpipe table is a skeleton until this replaces it.
              region.replaceChildren(sessionEnded(() => load()));
              return goSignedOut();
            }
            region.replaceChildren(blockError(err, () => load(), { origin: location.origin }));
            return;
          }
          if (statusRes.status === "fulfilled") status = statusRes.value;
          const list = listRes.value;
          rememberBindings(list);

          // Fill the freshness cache before first paint where it is cheap; the table
          // re-renders as entries arrive so the first paint is never blocked on it.
          // EXCEPT when the deep link carries a STATUS facet (?status=stale/failed):
          // those facets read the freshness cache, so evaluating them over an empty
          // cache would land the Overview "stale" link on a falsely empty list. Hold
          // the skeleton until the cache is filled, then render with the facet honest.
          const fillDone = fillFreshness(engine, list, latestRun, () => {
            if (table) table.setRows(list);
          });
          if ((ctx.query.get("status") ?? "") !== "") await fillDone;
          else void fillDone;

          renderList(list);
          // Start the standing auto-refresh now that the first list is in hand.
          schedulePoll(list);

          // Open the create / edit / detail surface the route asked for, once the
          // list is in hand (so edit/detail can resolve the entity). The
          // ?action=import param is written by the import-downpipes palette
          // command: navigating to /downpipes?action=import
          // directly opens the import drawer so the operator lands with it open,
          // not having to find the button themselves. The param is consumed once
          // and cleared from the URL so the back button is clean.
          const actionParam = ctx.query.get("action");
          if (actionParam === "import") {
            try { history.replaceState({}, "", "/downpipes"); } catch { /* best-effort */ }
            if (opGate) openImport(eng, status, knownBindings, reload);
            else toast({ message: "Import requires Operator role or above.", tone: "info" });
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
              // orphaned map edge's id) used to land silently on the bare list, which read as a
              // dead end. Say what happened; the list below is current.
              toast({ message: "That downpipe no longer exists; showing the current list.", tone: "info" });
              navigate("/downpipes", { replace: true });
            }
          }
        })
        .catch((err) => {
          // A throw inside the .then() callback (renderList, openCreateWizard, etc.)
          // would otherwise be swallowed by the void and leave the screen on the
          // skeleton forever. Mirror the inner listRes-rejection path: sign out on an
          // auth failure, otherwise show the block error with a Retry that re-runs load.
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
      if (list.length === 0) {
        region.replaceChildren(trueEmpty(opGate));
        return;
      }
      table = buildTable(eng, list, latestRun, ctx.query, opGate, reload, destinationFromStatus(status));
      // The plain-English protection subtitle: the fleet protection summary + the blunt not-covered
      // line, the SAME fleetProtection generator the overview lead line uses (so the two surfaces
      // cannot disagree). Honest: never "all covered" unless every enabled downpipe is proven; reads
      // the engine destination from the loaded status (honest unknown when status was not read).
      const subtitle = protectionSubtitle(list, status);
      // A11Y-09: provide a section heading below the h1 so assistive technology
      // can navigate into the table region by landmark. Visually hidden so the
      // toolbar carries the visual weight; the h2 is structural only.
      const sectionHeading = h("h2", { class: "visually-hidden" }, "Backup routes");
      region.replaceChildren(subtitle, sectionHeading, table.el);

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
      // the screen's own New downpipe button already reads (canCap("downpipe.write") below). The old
      // role-NAME list agreed with it for the six built-ins but floored every NAMED custom role to the
      // "viewer" the engine pins on its role field, hiding the command from a custom role that holds
      // downpipe.write. callerCan resolves the effective set; a null caller fails closed.
      when: ({ caller: c }) => c !== null && callerCan(c.role, "downpipe.write", c.customRole ?? null),
    },
    {
      // Navigate directly to /downpipes?action=import so the
      // screen auto-opens the import drawer on arrival. The operator does not have
      // to find the "Import a list" button manually after being routed to /downpipes.
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
