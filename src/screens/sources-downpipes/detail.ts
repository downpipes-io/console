// The downpipe detail drawer (flow.md C) for the Sources + downpipes screen: opening a
// downpipe in a deep-linkable drawer and wiring its run-now / drill / enable / delete
// actions. The per-downpipe and bulk actions live in detail-actions.ts; the small drawer
// render cells live in detail-cells.ts. Australian English, no em dashes, precise claims.

import type {
  DownpipeState,
  EngineClient,
  RunHistoryEntry,
  StatusReport,
} from "../../api.ts";
import { drawerSection, kvRow, openDetailDrawer } from "../../components/detail-drawer.ts";
import { inlineRetry } from "../../components/error-view.ts";
import { badge } from "../../components/status.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { absoluteTime, groupNumber, humanBytes, relativeTime, scheduleSummary, titleCase } from "../../lib/format.ts";
import { ICON_EXTERNAL, ICON_MAP, ICON_PLAY, ICON_TRASH } from "../../lib/icons.ts";
import { goSignedOut, navigate, requestPostNavigationFocus } from "../../lib/nav.ts";
import { sourceTypeLabel } from "../../lib/protection-statement.ts";
import { canCap, capGateReason } from "../common.ts";
import {
  bulkDelete,
  bulkDisable,
  bulkTrigger,
  deleteDownpipe,
  drillLatest,
  openBulkSummary,
  runNow,
  toggleEnabled,
} from "./detail-actions.ts";
import {
  freshnessBanner,
  restoreTestRecencyCell,
  retentionCell,
  runStrip,
  runsSkeletonStrip,
} from "./detail-cells.ts";
import { cfConfigDiscoverySection, destinationCell } from "./detail-config-section.ts";
import {
  actionChip,
  type Freshness,
  freshnessFor,
  type RunFacts,
  restoreTestCadenceLabel,
  sourceIcon,
  sourceSub,
} from "./helpers.ts";

// Re-exported so importers keep the original detail.ts entry point (the bulk bar in
// table.ts and the Sources screen's bulk-summary re-export). No importer changes.
export { bulkDelete, bulkDisable, bulkTrigger, openBulkSummary };

// ---- detail drawer (flow.md C) ----------------------------------------------

// The freshness banner host (honest, hue + shape + label). Computed from the cached
// latest run, then refined when the full history loads. The host is always in the
// body (a stable slot) so the refine can equally SHOW or CLEAR it: a downpipe that
// looked stale from a partial cache but is fine once the full history loads must not
// keep a lingering stale banner. Returns the initial freshness (drives the title
// badge and first banner) and the showBanner closure (the history load refines it).
function mountFreshnessBanner(
  body: HTMLElement,
  state: DownpipeState,
  latestRun: Map<string, RunFacts>,
): { fresh: Freshness; showBanner: (f: Freshness) => void } {
  const freshnessHost = h("div");
  body.appendChild(freshnessHost);
  const showBanner = (f: Freshness): void => {
    if (f.reason || f.tone === "danger" || f.stale) freshnessHost.replaceChildren(freshnessBanner(f));
    else freshnessHost.replaceChildren();
  };
  const fresh = freshnessFor(state, latestRun.get(state.config.id));
  showBanner(fresh);
  return { fresh, showBanner };
}

// The run-status strip (history, envelope unwrapped C1) plus the throughput slot.
// Both load lazily; the rest of the drawer is immediately usable. Returns the runs
// section (the run actions are appended to it later, NEXT TO the strip) and the
// hosts. The async history load below refines the banner and fills throughput.
function mountRunsSection(
  body: HTMLElement,
): { runsSection: HTMLElement; runsHost: HTMLElement; throughputHost: HTMLElement } {
  const runsSection = drawerSection("Recent runs");
  const runsHost = h("div", runsSkeletonStrip());
  runsSection.appendChild(runsHost);
  body.appendChild(runsSection);
  // Throughput slot: populated once history arrives; kept empty until then so the
  // layout does not shift. Shown only when the engine reports archiveBytesWritten.
  const throughputHost = h("div");
  body.appendChild(throughputHost);
  return { runsSection, runsHost, throughputHost };
}

// Build the throughput summary from the latest completed run. The slot stays empty
// until the engine reports archiveBytesWritten or a duration.
function fillThroughput(throughputHost: HTMLElement, latest: RunHistoryEntry | undefined): void {
  if (!latest || (latest.archiveBytesWritten === undefined && latest.durationMs === undefined)) return;
  throughputHost.replaceChildren(
    drawerSection(
      "Last run throughput",
      ...(latest.archiveBytesWritten !== undefined
        ? [kvRow("Archive written", humanBytes(latest.archiveBytesWritten))]
        : []),
      ...(latest.segmentsWritten !== undefined
        ? [kvRow("Segments written", groupNumber(latest.segmentsWritten))]
        : []),
      ...(latest.durationMs !== undefined
        ? [kvRow("Duration", latest.durationMs < 1000 ? `${latest.durationMs}ms` : `${(latest.durationMs / 1000).toFixed(1)}s`)]
        : []),
      ...(latest.recordCount !== undefined
        ? [kvRow("Records", groupNumber(latest.recordCount))]
        : []),
    ),
  );
}

// Load the run history lazily and wire its three effects: the strip, the banner
// refinement (the newest GOOD run drives the shared staleness rule), and the
// throughput summary. A per-section failure stays inline (flow.md C), not global.
function loadRunHistory(
  engine: EngineClient,
  state: DownpipeState,
  runsHost: HTMLElement,
  throughputHost: HTMLElement,
  showBanner: (f: Freshness) => void,
): void {
  const dpId = state.config.id;
  void engine
    .listHistory(dpId)
    .then((entries) => {
      runsHost.replaceChildren(runStrip(entries, dpId));
      showBanner(freshnessFor(state, { latest: entries[0], lastGood: entries.find((e) => e.status === "ok") }));
      fillThroughput(throughputHost, entries.find((e) => e.status === "ok"));
    })
    .catch((err) => {
      if (isUnauthorised(err)) return goSignedOut();
      // P4.2: "Could not load recent runs." named no remedy and left nothing to press. This read also
      // feeds the freshness banner and the throughput summary, so a failure here quietly takes three
      // things off the drawer at once; the Retry brings all three back.
      runsHost.replaceChildren(
        inlineRetry({
          message: "The engine did not answer with this downpipe's run history, so no runs, freshness or throughput are shown. The configuration above is unaffected.",
          onReload: () => loadRunHistory(engine, state, runsHost, throughputHost, showBanner),
        }),
      );
    });
}

// The /map link that jumps straight to this downpipe on the topology view.
function mapLinkFor(dpId: string): HTMLElement {
  return h(
    "a",
    {
      href: `/map?highlight=${encodeURIComponent(dpId)}`,
      class: "linklike",
      style: "display:inline-flex;align-items:center;gap:var(--space-1);font-size:var(--text-sm);text-decoration:underline",
      on: {
        click: (ev: Event) => {
          ev.preventDefault();
          navigate(`/map?highlight=${encodeURIComponent(dpId)}`);
        },
      },
    },
    svgIcon(ICON_MAP, { size: 13 }),
    "View on map",
    svgIcon(ICON_EXTERNAL, { size: 11 }),
  );
}

// The Configuration drawer section. Cadence is rendered as a friendly human phrase
// (e.g. "daily", "every 6h") not raw seconds. Next run shows both relative and
// absolute so a glance tells the operator when the next seal will happen.
function buildConfigSection(
  engine: EngineClient,
  state: DownpipeState,
  status: StatusReport | null,
): HTMLElement {
  const dp = state.config;
  // Destination(s): the per-downpipe fan-out selection resolved to the real destination
  // labels (detail-config-section.ts). Loaded async like the run history; falls back to the
  // honest one-line summary if the list cannot be read.
  const destHost = destinationCell(engine, dp, status);

  const configRows: Node[] = [
    kvRow("Source type", h("span", { class: `source-pill source-pill--${dp.source.type}`, style: "vertical-align:middle" }, svgIcon(sourceIcon(dp.source.type), { size: 13 }), sourceTypeLabel(dp.source.type))),
    kvRow("Source name / binding", sourceSub(dp.source)),
    ...(dp.source.include.length ? [kvRow("Include prefixes", dp.source.include.join(", "))] : []),
    ...(dp.source.exclude.length ? [kvRow("Exclude prefixes", dp.source.exclude.join(", "))] : []),
    // File-content capture (stream/images/artifacts): whether the run captures the resource bytes too, not
    // just the metadata inventory. Shown only for the media types that have a separate content to capture.
    ...((dp.source.type === "stream" || dp.source.type === "images" || dp.source.type === "artifacts")
      ? [kvRow("File contents", dp.source.includeContent === true
          ? h("span", { style: "display:inline-flex;align-items:center;gap:var(--space-1)" }, h("span", { class: "dot dot--ok", "aria-hidden": "true" }), "Captured (inventory + file bytes)")
          : h("span", { style: "display:inline-flex;align-items:center;gap:var(--space-1)" }, h("span", { class: "dot dot--neutral", "aria-hidden": "true" }), "Inventory only"))]
      : []),
    kvRow("Schedule", titleCase(scheduleSummary(dp.cadenceSeconds, dp.schedule))),
    // Scheduled restore test (build contract section 5): the cadence + the last-test
    // recency, so the operator sees recoverability assurance alongside the backup
    // schedule. The recency read is honest (never a stale green): a never-tested or
    // overdue downpipe reads warn, a failed last test reads danger.
    kvRow("Restore test cadence", restoreTestCadenceLabel(dp.restoreTestCadenceSeconds)),
    kvRow("Last restore test", restoreTestRecencyCell(state)),
    // Retention policy in plain words (ASVS V14.2.7). Honest about the deletion gate: an enforced
    // policy says deletion is enforced; a report-only or absent policy says so, never implying a
    // delete that is not happening. A warn dot flags the destructive enforced state.
    kvRow("Retention", retentionCell(dp.retention)),
    // Enabled/Paused, and what a pause MEANS, stated here rather than only on a documentation page.
    // The consequence of pausing is not what a reader would assume and it is not self-evident from a
    // switch: it stops scheduled runs AND it stops the retention prune for this downpipe, so nothing
    // in the archive is deleted while it is paused. The one thing it does not stop is the canary,
    // which is not a downpipe and keeps flying against the destination until it is turned off on its
    // own screen. Naming that here is the point: the operator is told at the control, not elsewhere.
    kvRow("Enabled", dp.enabled
      ? h("span", { style: "display:inline-flex;align-items:center;gap:var(--space-1)" }, h("span", { class: "dot dot--ok", "aria-hidden": "true" }), "Enabled")
      : h("span", { style: "display:grid;gap:2px" },
          h("span", { style: "display:inline-flex;align-items:center;gap:var(--space-1)" }, h("span", { class: "dot dot--neutral", "aria-hidden": "true" }), "Paused"),
          h("span", { class: "field__hint" }, "No runs are scheduled and retention deletes nothing for this downpipe while it is paused. The canary is not a downpipe and keeps flying."))),
    // Next run: the relative phrase on its own line with the absolute UTC as a muted
    // sub-line (stacked, never run together as "in 22h<date>").
    kvRow("Next run", dp.enabled
      ? h("span", { style: "display:grid;gap:2px" }, h("span", relativeTime(state.nextRunAt)), h("span", { class: "field__hint" }, absoluteTime(state.nextRunAt)))
      : "Not scheduled (paused)"),
    kvRow("Destination", destHost),
    kvRow("Topology", mapLinkFor(dp.id)),
  ];
  return drawerSection("Configuration", ...configRows);
}

// The two restore-flavoured actions (flow.md C step 4) appended NEXT TO the run
// strip (the runs give "latest" its meaning and teach the drill noun), keeping the
// footer to the four route-level actions. Role-gated.
function mountRunActions(engine: EngineClient, state: DownpipeState, runsSection: HTMLElement): void {
  // The drill route is gated engine-side on drill.run (operator / restore-operator / approver / owner:
  // "a recovery rehearsal is part of the recovery role", router-pipelines.ts), NOT on the viewer-up
  // read-safe restore.verify. So a caller who lacks drill.run must see the chip disabled-with-reason,
  // never enabled-then-403. Gate on canCap("drill.run") first, then on having a run to drill.
  const canDrill = canCap("drill.run");
  runsSection.appendChild(
    h(
      "div",
      { style: "display:flex;gap:var(--space-2);margin-top:var(--space-2);flex-wrap:wrap" },
      actionChip("Verify restore (drill)", canDrill ? (state.lastRunId ? null : "No run to drill yet.") : capGateReason("drill.run"), () => void drillLatest(engine, state)),
      actionChip("Start restore from latest", state.lastRunId ? null : "No run to restore from yet.", () => {
        // Guard on the value, not just the disabled chip: never route to a malformed
        // /restore/ URL even if the disable contract changes.
        if (state.lastRunId) navigate(`/restore/${encodeURIComponent(state.lastRunId)}`);
      }),
    ),
  );
}

// findRowByKey re-finds a downpipe's table row by its data-key IN THE LIVE TREE at call time (never a
// captured node reference), so a caller evaluating this after a navigation has rebuilt the table still
// lands on the current row for the same downpipe. Shared by openDownpipeDrawer's focusReturn (evaluated
// when the drawer closes) and its onClose's own post-navigation focus declaration (evaluated again once
// the list's re-render lands), so the two close-time focus paths agree on the one way to find the row.
function findRowByKey(id: string): HTMLElement | null {
  for (const tr of document.querySelectorAll<HTMLElement>("tr[data-key]")) {
    if (tr.dataset.key === id) return tr;
  }
  return null;
}

// Open the detail drawer with the four route-level actions in the footer. The danger
// Delete is grouped right by the drawer's footer builder. onClose returns to the list
// WITH the query string the row carried in, so the operator's filter/facets/sort
// survive the open-and-close round trip.
function openDownpipeDrawer(
  engine: EngineClient,
  state: DownpipeState,
  latestRun: Map<string, RunFacts>,
  body: HTMLElement,
  fresh: Freshness,
  reload: () => void,
): void {
  const dp = state.config;
  // Per-action capability gates, each mirroring the engine's own per-route gate: the four footer verbs
  // bundle THREE distinct capabilities (run.trigger, downpipe.write, downpipe.delete) a custom role may
  // hold only some of, so they must gate independently rather than share one operator-ladder rank.
  const canTrigger = canCap("run.trigger");
  const canWrite = canCap("downpipe.write");
  const canDelete = canCap("downpipe.delete");
  const handle = openDetailDrawer({
    title: dp.name,
    meta: h("span", { class: "mono" }, sourceSub(dp.source)),
    badges: [badge(fresh.tone, fresh.label), badge(dp.enabled ? "ok" : "neutral", dp.enabled ? "Enabled" : "Paused")],
    body,
    // Keyed by the downpipe id: a screen re-render that re-fires the /downpipes/:id
    // deep-link's openDetail side effect (app.ts's identity-resolved quiet re-render,
    // which runs a fresh load() outside the router) hits openOverlay's idempotency guard
    // instead of stacking a second drawer over this one.
    key: `downpipes-detail:${dp.id}`,
    // Return keyboard focus to the invoking row on close. This drawer is opened by a route change
    // (onRowActivate -> navigate("/downpipes/:id")) that re-runs load() and rebuilds every <tr>,
    // so the row node that had focus at open is detached by close time. A resolver re-finds the
    // current row by its data-key (the downpipe id, set on every dataTable <tr>) so focus lands
    // back on the row the user activated, not on <main> (B25).
    focusReturn: () => findRowByKey(dp.id),
    // onClose fires a SECOND, real navigation (back to the plain list), and that is exactly where the
    // focusReturn above used to get quietly undone: teardown() restores focus to the row synchronously,
    // then this navigate() call resolves the /downpipes route, whose screen declares no post-navigation
    // focus intent of its own -- an ORDINARY route change, which is correctly supposed to move focus to
    // <main> (lib/nav.ts's PostNavigationFocus "none" case). The shell's setMain applies that move on a
    // LATER tick (the View Transition's deferred update callback), after teardown() has already returned,
    // so it silently overwrites the just-restored row a moment later: focus can land on
    // <main>, not the row, even though the row was briefly focused first.
    // Declaring the SAME re-find here, on the console's own post-navigation-focus channel, re-resolves
    // the row in whatever fresh table this navigation's own re-render produces, so the shell's deferred
    // focus move honours it instead of defaulting to <main>.
    onClose: () => {
      requestPostNavigationFocus(() => findRowByKey(dp.id));
      navigate(`/downpipes${location.search}`);
    },
    actions: [
      {
        label: "Run now",
        icon: svgIcon(ICON_PLAY, { size: 14 }),
        ...(canTrigger ? {} : { disabled: true, disabledReason: capGateReason("run.trigger"), gateOp: "downpipe-run" as const }),
        onClick: () => void runNow(engine, state, { latest: latestRun.get(dp.id)?.latest, reload, closeDrawer: () => handle.close() }),
      },
      {
        label: "Edit",
        ...(canWrite ? {} : { disabled: true, disabledReason: capGateReason("downpipe.write"), gateOp: "downpipe-edit" as const }),
        onClick: () => navigate(`/downpipes/${encodeURIComponent(dp.id)}/edit`),
      },
      {
        label: dp.enabled ? "Disable" : "Enable",
        ...(canWrite ? {} : { disabled: true, disabledReason: capGateReason("downpipe.write"), gateOp: "downpipe-toggle" as const }),
        onClick: () => void toggleEnabled(engine, state, reload, () => handle.close()),
      },
      {
        label: "Delete",
        variant: "danger",
        icon: svgIcon(ICON_TRASH, { size: 14 }),
        ...(canDelete ? {} : { disabled: true, disabledReason: capGateReason("downpipe.delete"), gateOp: "downpipe-delete" as const }),
        onClick: () => void deleteDownpipe(engine, dp, reload, () => handle.close(), state.configRev),
      },
    ],
  });
}

export function openDetail(
  engine: EngineClient,
  state: DownpipeState,
  opts: {
    latestRun: Map<string, RunFacts>;
    status: StatusReport | null;
    reload: () => void;
  },
): void {
  const { latestRun, status, reload } = opts;
  const dp = state.config;
  // The cf-config discovery panel's mode + Rediscover both mutate the downpipe server-side
  // (router-discovery.ts gates each on downpipe.write), so gate them on that capability, never the
  // operator ladder rank a custom role is floored off. The drawer's own verbs gate per-action inside.
  const writeGate = canCap("downpipe.write");

  const body = h("div");

  const { fresh, showBanner } = mountFreshnessBanner(body, state, latestRun);

  const { runsSection, runsHost, throughputHost } = mountRunsSection(body);
  loadRunHistory(engine, state, runsHost, throughputHost, showBanner);

  body.appendChild(buildConfigSection(engine, state, status));

  // cf-config discovery + capture mode panel (detail-config-section.ts): the auto/manual mode,
  // the last-discovery recency + counts, and a Rediscover button. Gated on downpipe.write (both
  // controls mutate the downpipe). Other source types skip the panel entirely.
  if (dp.source.type === "cf-config") {
    body.appendChild(cfConfigDiscoverySection(engine, dp, state, writeGate, reload));
  }

  // mountRunActions reads canCap("drill.run") for its own chip; openDownpipeDrawer reads its three
  // per-action gates internally. Neither takes a shared operator-rank flag any longer.
  mountRunActions(engine, state, runsSection);

  openDownpipeDrawer(engine, state, latestRun, body, fresh, reload);
}
