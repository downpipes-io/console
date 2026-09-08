// Overview (IA screen 1) fleet section (the left column): a BOUNDED triage summary of the
// fleet, not the full list. The head is the always-present count roll-up (the whole-fleet
// distribution at a glance, constant height whatever the fleet size); the body is worst-first
// and capped -- a short table of the downpipes that need attention (failed, stale or unknown),
// or, when none do, a calm "fleet is healthy" confirmation that stands in for rows. A
// "View all N downpipes" link hands off to /downpipes, which owns the full, unbounded,
// filterable list. This keeps the Overview a triage screen (its stated job) and stops the left
// column growing one row per downpipe and unbalancing the page against the calm right column.
// The true-empty teaching state and the per-row triage deep-links are kept. House rules:
// Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { canCap, capGateReason } from "../common.ts";
import { navigate } from "../../lib/nav.ts";
import { dataTable, type DataTableState, type DataColumn } from "../../components/data-table.ts";
import { emptyState } from "../../components/feedback.ts";
import { statusWithLabel, runStatusTone, type StatusTone } from "../../components/status.ts";
import { relativeTime, absoluteTime, groupNumber, cadenceLabel } from "../../lib/format.ts";
import { getEngine } from "../../lib/store.ts";
import { fetchSetup, setupChecklistCard } from "../../lib/setup-state.ts";
import { ICON_CHEVRON_RIGHT, ICON_SHIELD_CHECK, ICON_INFO } from "../../lib/icons.ts";
import type { RunHistoryEntry } from "../../api.ts";
import {
  freshnessRank,
  freshnessPresent,
  type FleetRow,
  type FleetSummary,
} from "./shared.ts";

// fleet section (left column)

// The Overview shows only the worst-first HEAD of the fleet (a triage summary); the full,
// unbounded, filterable list lives on /downpipes. This cap bounds the left column so it cannot
// grow one row per downpipe and stretch the page out of balance with the calm right column.
const FLEET_OVERVIEW_MAX_ROWS = 3;
// A downpipe earns a row in the triage summary when its freshness ranks at or above stale:
// failed (0), stale (1) or unknown (2). Healthy / in-flight / paused downpipes are a calm count
// in the head pills, never a row, so the summary surfaces problems and stays quiet otherwise.
const FLEET_ATTENTION_MAX_RANK = 2;
// How many recent runs the timeline strip shows (newest on the right). Kept short so the strip
// stays on one line in the narrow Recent column rather than wrapping and stretching the row.
const RUN_TIMELINE_DEPTH = 5;

export function buildFleetSection(
  fleet: FleetSummary,
  announce: (m: string) => void,
  tableState?: Partial<DataTableState>,
  onTableState?: (st: DataTableState) => void,
): HTMLElement {
  const section = h("section", { "aria-labelledby": "ov-fleet-h" });
  const head = h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap;margin-bottom:var(--space-3)" });
  head.appendChild(h("h2", { id: "ov-fleet-h", style: "font-size:var(--text-lg)" }, "Fleet health"));
  head.appendChild(fleetCounts(fleet));
  section.appendChild(head);

  // True-empty: no downpipes at all (see buildEmptyFleet for the lazy-checklist teach state).
  if (fleet.total === 0) {
    section.appendChild(buildEmptyFleet());
    return section;
  }

  // BOUNDED triage summary, not the full list. fleet.rows is already sorted worst-first
  // (summariseFleet: failed, then stale, then unknown, then oldest last-good), so the downpipes
  // that need attention are simply its leading slice. They lead as a short, capped table; when
  // none do, a calm confirmation stands in their place so the area is never an empty-looking
  // gap. The full, filterable, unbounded list is one click away on /downpipes, which owns it.
  const attention = fleet.rows.filter((r) => freshnessRank(r.freshness) <= FLEET_ATTENTION_MAX_RANK);
  if (attention.length === 0) {
    section.appendChild(buildFleetHealthy(fleet));
  } else {
    section.appendChild(
      buildAttentionTable(attention.slice(0, FLEET_OVERVIEW_MAX_ROWS), announce, tableState, onTableState),
    );
  }
  // The hand-off to /downpipes, shown whenever the fleet holds more than the summary renders
  // (always, when the healthy confirmation stands in for rows), so the summary never reads as
  // the whole fleet and the rest is one click away.
  const shownRows = attention.length === 0 ? 0 : Math.min(attention.length, FLEET_OVERVIEW_MAX_ROWS);
  if (fleet.total > shownRows) section.appendChild(fleetViewAllLink(fleet.total));
  return section;
}

// buildAttentionTable renders the worst-first, capped attention rows as the shared data table,
// so the single-tab-stop roving row navigation and the <=1023px card-stack treatment come for
// free, with the per-row Triage / Open deep-links into the owning Downpipes drawer. The cap
// keeps the row count below the toolbar's threshold, so the filter/facets toolbar stays hidden
// and the short list reads as a clean table; the carried table state is still threaded through
// (a deep-linked filter still rehydrates and reveals the toolbar to clear it).
function buildAttentionTable(
  rows: FleetRow[],
  announce: (m: string) => void,
  tableState?: Partial<DataTableState>,
  onTableState?: (st: DataTableState) => void,
): HTMLElement {
  const handle = dataTable<FleetRow>({
    label: "Downpipes that need attention",
    rows,
    rowKey: (r) => r.id,
    onRowActivate: (r) => navigate(`/downpipes/${encodeURIComponent(r.id)}`),
    filter: { placeholder: "Filter downpipes", resultLabel: "downpipes", getText: (r) => r.id },
    facets: [
      // Freshness is one dimension (a row has exactly one): selecting Failed + Stale shows failed-or-stale
      // rows, never AND to an impossible empty (B38).
      { id: "failed", group: "freshness", label: "Failed", tone: "danger", predicate: (r) => r.freshness === "failed" },
      { id: "stale", group: "freshness", label: "Stale", tone: "warn", predicate: (r) => r.freshness === "stale" },
      { id: "unknown", group: "freshness", label: "Unknown", tone: "neutral", predicate: (r) => r.freshness === "unknown" },
    ],
    initialSort: { key: "status", dir: "asc" },
    columns: fleetColumns(announce),
    empty: emptyState({ title: "No downpipes match", body: "Adjust the filter to see the fleet." }),
    ...(tableState ? { initialState: tableState } : {}),
    ...(onTableState ? { onStateChange: onTableState } : {}),
  });
  return handle.el;
}

// buildFleetHealthy is the calm confirmation that stands in for rows when no downpipe needs
// attention (no failed, stale or unknown). It is a real affirmative read, not an empty gap: the
// head pills carry the exact distribution, this states the newest good backup, and it teaches
// that a downpipe which fell behind would surface here. Honest by construction, it never paints a
// green over a claim it cannot back: the branch runs only when there are no unknowns (so never
// "healthy" over a fleet it could not read); an ALL-paused fleet reads as paused, not healthy;
// and a fleet with no completed backup yet (brand new, or every first run still in flight) reads
// as "not yet", the same hedge the sibling needs-attention card makes, never a green shield over
// zero proven backups.
function buildFleetHealthy(fleet: FleetSummary): HTMLElement {
  const active = fleet.healthy + fleet.inFlight;
  const allPaused = active === 0 && fleet.disabled > 0;
  const newestGood = fleet.newestGoodAt;
  // A neutral (not green) read whenever there is nothing healthy to affirm: an all-paused fleet,
  // or one where no good backup has completed yet.
  const affirmed = !allPaused && newestGood !== null;
  const icon = affirmed ? ICON_SHIELD_CHECK : ICON_INFO;
  const iconColor = affirmed ? "var(--ok-fg)" : "var(--text-muted)";
  const headline = allPaused
    ? "All downpipes are paused"
    : affirmed
      ? "Fleet is healthy"
      : "No backups have completed yet";
  const sub = allPaused
    ? "Paused downpipes are not scheduled to back up; resume one on Downpipes when you are ready."
    : affirmed
      ? `Newest good backup ${relativeTime(newestGood)}. A downpipe that fails or falls behind would appear here, worst first.`
      : "Downpipes are scheduled. A run that fails or falls behind would appear here, worst first.";
  return h(
    "div",
    { class: "card card--inset", style: "display:flex;align-items:flex-start;gap:var(--space-3)" },
    h("span", { style: `color:${iconColor};display:inline-flex;flex:none;margin-top:1px`, "aria-hidden": "true" }, svgIcon(icon, { size: 18 })),
    h(
      "div",
      h("div", { style: "font-weight:var(--weight-medium)" }, headline),
      h("div", { class: "field__hint", style: "margin-top:1px" }, sub),
    ),
  );
}

// fleetViewAllLink hands off to /downpipes, which owns the full, filterable, unbounded list of
// every downpipe (the detail the bounded summary deliberately does not carry).
function fleetViewAllLink(total: number): HTMLElement {
  return h(
    "button",
    { "data-dp": "overview.button.navigate-downpipes#1",
      class: "linklike",
      type: "button",
      style: "margin-top:var(--space-3);display:inline-flex;align-items:center;gap:var(--space-2)",
      on: { click: () => navigate("/downpipes") },
    },
    `View all ${groupNumber(total)} downpipes`,
    svgIcon(ICON_CHEVRON_RIGHT, { size: 14 }),
  );
}

// buildEmptyFleet: the true-empty (no downpipes at all) teach state. While the guided
// setup is incomplete the five-step checklist IS the hero (one decision, the setup-first
// IA); it resolves lazily and replaces the teach state when it lands. Once setup is
// genuinely complete (an emptied fleet later), the teach state stands, pointing at Sources
// where picking starts. The CTA mirrors the downpipe.write gate (creating a downpipe is the action it leads to).
function buildEmptyFleet(): HTMLElement {
  const opGate = canCap("downpipe.write");
  const host = h("div");
  const eng = getEngine();
  if (eng) {
    void fetchSetup(eng).then((view) => {
      if (view !== null && !view.complete && host.isConnected) {
        host.replaceChildren(setupChecklistCard(view, (to) => navigate(to)));
      }
    });
  }
  host.appendChild(
    emptyState({
      title: "No downpipes yet",
      body: "A downpipe is a scheduled backup route from a Cloudflare source (KV, R2, D1, Secrets Store) to your archive bucket. Start from Sources: everything you own is pre-listed, so protecting something is ticking a box.",
      diagram: sourceEngineDestDiagram(),
      ...(opGate
        ? { action: { label: "Choose what to protect", onClick: () => navigate("/sources") } }
        : { action: { label: "Open Downpipes", variant: "secondary" as const, onClick: () => navigate("/downpipes") } }),
    }),
  );
  if (!opGate) {
    host.appendChild(
      h("p", { class: "field__hint", style: "text-align:center;margin-top:var(--space-2)" }, capGateReason("downpipe.write")),
    );
  }
  return host;
}

function downpipeCell(r: FleetRow): HTMLElement {
  return h(
    "div",
    { style: "display:flex;flex-direction:column;gap:1px;min-width:0" },
    h("span", { class: "mono", style: "font-weight:var(--weight-medium);overflow:hidden;text-overflow:ellipsis" }, r.id),
    h("span", { class: "field__hint" }, r.cadenceSeconds ? cadenceLabel(r.cadenceSeconds) : r.hasDownpipe ? "no cadence" : "no longer scheduled"),
  );
}

function lastGoodCell(r: FleetRow): HTMLElement {
  return r.lastGoodAt
    ? h("span", { class: "tnum", title: absoluteTime(r.lastGoodAt) }, relativeTime(r.lastGoodAt))
    : h("span", { class: "field__hint" }, "never");
}

function nextRunCell(r: FleetRow): HTMLElement {
  if (!r.enabled) return h("span", { class: "field__hint" }, "paused");
  if (r.nextRunAt === null) return h("span", { class: "field__hint" }, "-");
  return h("span", { class: "tnum", title: absoluteTime(r.nextRunAt) }, relativeTime(r.nextRunAt));
}

function fleetColumns(announce: (m: string) => void): Array<DataColumn<FleetRow>> {
  return [
    { key: "downpipe", header: "Downpipe", render: downpipeCell, sortable: true, sortValue: (r) => r.id },
    // Sort worst-first: failed (0) < stale (1) < unknown (2) < in-flight (3) < healthy (4) < disabled (5).
    { key: "status", header: "Status", render: freshnessCell, sortable: true, sortValue: (r) => freshnessRank(r.freshness) },
    { key: "lastGood", header: "Last good", render: lastGoodCell, sortable: true, sortValue: (r) => (r.lastGoodAt ? Date.parse(r.lastGoodAt) : 0) },
    { key: "next", header: "Next run", render: nextRunCell, sortable: true, sortValue: (r) => (r.enabled && r.nextRunAt !== null ? r.nextRunAt : Number.MAX_SAFE_INTEGER) },
    { key: "recent", header: "Recent runs", render: (r) => runTimeline(r.recent) },
    { key: "records", header: "Records", numeric: true, render: (r) => (r.lastRecordCount !== null ? groupNumber(r.lastRecordCount) : "-"), sortable: true, sortValue: (r) => r.lastRecordCount ?? -1 },
    { key: "actions", header: "Actions", srOnlyHeader: true, width: "1px", render: (r) => rowActions(r, announce) },
  ];
}

// freshnessCell: hue + shape (the dot) + the text label, never colour alone.
function freshnessCell(r: FleetRow): HTMLElement {
  const { tone, label } = freshnessPresent(r.freshness);
  return h("span", { class: "run-status-cell" }, statusWithLabel(tone, label));
}

// runTimeline renders the recent-run strip (newest on the RIGHT, matching the wireframe),
// one cell per run, status by hue + shape/texture (the run-strip CSS gives failed a hatch
// and in-flight a dashed hollow). The strip carries a SINGLE text alternative: the wrapper
// is a <div role="img"> with the aria-label stating the whole sequence (A11Y-02: role="img"
// on a <ul> conflicts with list semantics and suppresses the children; a <div> carries the
// image role cleanly). Each cell is a decorative <span> (aria-hidden), and the failed/
// in-flight glyph marks are aria-hidden too (A11Y-04), so the strip reads as one labelled
// image, never a stale green and never colour alone (failed = hatch + a cross glyph;
// in-flight = dashed hollow + an ellipsis glyph; the same shape redundancy as
// sources-downpipes).
// Exported for the validator, so the abandoned treatment is driven on the real production builder
// rather than on a re-implementation of it.
export function runTimeline(recent: RunHistoryEntry[]): HTMLElement {
  const cells = recent.slice(0, RUN_TIMELINE_DEPTH).reverse(); // oldest-left, newest-right
  if (cells.length === 0) {
    return h("span", { class: "field__hint" }, "no runs");
  }
  // runStatusTone, not a third hand-written ok/failed/else ladder: the else arm called an ABANDONED run
  // "in-flight" in the strip's aria-label, so a screen-reader user on the Overview was told a run the
  // engine had given up on was still going.
  const parts = cells.map((e) => runStatusTone(e.status).label);
  const label = `Recent runs, oldest to newest: ${parts.join(", ")}.`;
  // nowrap so the short strip stays on one line inside the narrow Recent column rather than
  // wrapping into a tall stack (the .run-strip class wraps by default for the wider tables that
  // share it; this override is local to the Overview's compact triage rows).
  const strip = h("div", { class: "run-strip", role: "img", "aria-label": label, style: "flex-wrap:nowrap" });
  for (const e of cells) {
    // The class follows the canonical tone, so abandoned gets run-cell--warn (its own vertical hatch)
    // rather than the hollow dashed in-flight treatment that made it look like work still in progress.
    const tone = runStatusTone(e.status).tone;
    const cls =
      e.status === "in-flight" ? "run-cell run-cell--inflight" : `run-cell run-cell--${tone}`;
    const cell = h("span", { class: cls, "aria-hidden": "true", title: `${e.status} ${relativeTime(e.startedAt)}` });
    // A shape mark for the non-ok states so they read by glyph + texture, not hue alone, even
    // for a monochrome / colour-blind reader. All three marks are aria-hidden (A11Y-04): the
    // strip's aria-label already carries the textual sequence, so the glyphs are decorative.
    if (e.status === "failed") cell.appendChild(h("span", { class: "run-cell__mark", "aria-hidden": "true" }, "×"));
    // Abandoned earns its own glyph for the same reason failed has one: without a mark it read by hue
    // alone, which this strip is explicitly built not to do.
    else if (e.status === "abandoned") cell.appendChild(h("span", { class: "run-cell__mark", "aria-hidden": "true" }, "!"));
    else if (e.status === "in-flight") cell.appendChild(h("span", { class: "run-cell__mark", "aria-hidden": "true" }, "…"));
    strip.appendChild(cell);
  }
  return strip;
}

// rowActions: a quick deep-link to triage the row, gated as a MIRROR of the engine.
// Overview is diagnosis; the actual write (Run now / Drill / Edit) lives in the
// Downpipes drawer this links to, so a Viewer always sees a read-only "Open" and never a
// write button that 403s.
function rowActions(r: FleetRow, announce: (m: string) => void): HTMLElement {
  const wrap = h("div", { class: "row-actions", style: "justify-content:flex-end" });
  // Triaging a stale or failed row means re-running it, so gate on run.trigger (what the drawer's
  // primary triage verb needs); a caller without it gets the read-only "Open" instead.
  const opGate = canCap("run.trigger");
  // For a stale or failed row, a caller who can trigger a run gets a prominent "Triage" deep-link into
  // the downpipe drawer (where Run now / Edit live); everyone else gets a read-only "Open".
  if ((r.freshness === "stale" || r.freshness === "failed") && opGate) {
    const triage = h(
      "button",
      { "data-dp": "overview.button.triage", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => { announce(`Opening ${r.id} to triage.`); navigate(`/downpipes/${encodeURIComponent(r.id)}`); } } },
      "Triage",
    );
    wrap.appendChild(triage);
  } else {
    const open = h(
      "button",
      { "data-dp": "overview.button.open", class: "btn btn--ghost btn--sm", type: "button", "aria-label": `Open ${r.id}`, on: { click: () => navigate(`/downpipes/${encodeURIComponent(r.id)}`) } },
      "Open",
      svgIcon(ICON_CHEVRON_RIGHT, { size: 14 }),
    );
    wrap.appendChild(open);
  }
  return wrap;
}

function fleetCounts(fleet: FleetSummary): HTMLElement {
  const row = h("div", { style: "display:flex;flex-wrap:wrap;gap:var(--space-2)", "aria-label": "Fleet summary" });
  row.appendChild(countPill("ok", "Healthy", fleet.healthy + fleet.inFlight));
  row.appendChild(countPill("warn", "Stale", fleet.stale));
  row.appendChild(countPill("danger", "Failed", fleet.failed));
  row.appendChild(countPill("neutral", "Paused", fleet.disabled));
  return row;
}

function countPill(tone: StatusTone, label: string, n: number): HTMLElement {
  return h(
    "span",
    { style: "display:inline-flex;align-items:center;gap:var(--space-2);padding:var(--space-1) var(--space-3);border:1px solid var(--border);border-radius:var(--radius-full);font-size:var(--text-sm);background:var(--surface)" },
    h("span", { class: `dot dot--${tone}`, "aria-hidden": "true" }),
    h("span", label),
    h("strong", { class: "tnum", style: "font-weight:var(--weight-semibold)" }, String(n)),
  );
}

function sourceEngineDestDiagram(): HTMLElement {
  // A tiny inline source -> engine -> destination hint (text + arrows; decorative).
  return h(
    "div",
    { style: "display:flex;align-items:center;gap:var(--space-2);justify-content:center;font-size:var(--text-sm);color:var(--text-muted)", "aria-hidden": "true" },
    h("span", { class: "badge" }, "Cloudflare source"),
    h("span", "→"),
    h("span", { class: "badge badge--accent" }, "engine"),
    h("span", "→"),
    h("span", { class: "badge" }, "your archive"),
  );
}
