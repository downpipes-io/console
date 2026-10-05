// The fleet data table for the Sources + downpipes screen (flow.md A/B/I): the protection
// subtitle, the per-row coverage cell, the sortable/filterable/faceted table with bulk actions,
// the URL state round-trip, the per-row enable switch, the true-empty teaching state, and the
// lazy freshness fill.

import type {
  Downpipe,
  DownpipeState,
  EngineClient,
  StatusReport,
} from "../../api.ts";
import { type BulkAction, type DataColumn, dataTable, type DataTableState, type Facet } from "../../components/data-table.ts";
import { emptyState } from "../../components/feedback.ts";
import { badge, type StatusTone, statusWithLabel } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { absoluteTime, relativeTime, scheduleSummary, titleCase } from "../../lib/format.ts";
import { ICON_ALERT, ICON_RUNS } from "../../lib/icons.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import type { RecoveryPosture } from "../../lib/operational-key-posture.ts";
import { surfacePendingChange } from "../../lib/pending-change-toast.ts";
import { type DestinationDescriptor, destinationFromStatus, fleetProtection, type ProtectionStatement, type ProtectionTone, protectionStatement } from "../../lib/protection-statement.ts";
import { ARTIFACTS_GA } from "../../lib/token-source.ts";
import { canCap, capGateReason } from "../common.ts";
import { bulkDelete, bulkDisable, bulkTrigger } from "./detail.ts";
import {
  errMsg,
  type Freshness,
  freshnessFor,
  ICON_KV,
  ICON_R2,
  type RunFacts,
  sourcePill,
  sourceSub,
} from "./helpers.ts";

// ---- plain-English protection subtitle (the lead line on the downpipes screen) ----
// protectionSubtitle renders the fleet protection summary + the blunt not-covered line as the
// subtitle above the table. It reuses the SAME fleetProtection generator the overview lead line
// uses (lib/protection-statement.ts), so the two surfaces cannot disagree. Honest: never "all
// covered" unless every enabled downpipe's restorability is proven; reads the engine destination
// from the loaded status (an honest unknown when status could not be read). Every string reaches
// the DOM via textContent; the dot is a class paired with the label (never colour alone); no
// <style> is injected (strict CSP: per-property CSSOM only, via the h() builder).
export function protectionSubtitle(list: DownpipeState[], status: StatusReport | null): HTMLElement {
  const fp = fleetProtection(list, destinationFromStatus(status));
  const tone = protectionToneToStatus(fp.tone);
  return h(
    "div",
    { class: "card card--inset", role: "region", "aria-label": "Protection statement", style: "display:flex;align-items:flex-start;gap:var(--space-3);margin-bottom:var(--space-3)" },
    h("span", { class: `dot dot--${tone}`, "aria-hidden": "true", style: "margin-top:6px;flex:none" }),
    h(
      "div",
      { style: "min-width:0" },
      h("p", { style: "font-weight:var(--weight-medium)" }, fp.summary),
      h("p", { class: "field__hint", style: "margin-top:2px" }, fp.notCovered),
    ),
  );
}

// protectionToneToStatus maps the protection tone to the status-dot tone vocabulary (covered = ok,
// partial / unproven = warn, uncovered = danger). Never maps unproven/uncovered to ok (honesty floor).
// unreadable = NEUTRAL: the honest could-not-tell hue. See the twin mapper in screens/overview/tiles.ts
// for why it is neither warn nor danger; the two must answer identically or the fleet subtitle and the
// Overview lead would hue the same downpipe two ways.
function protectionToneToStatus(tone: ProtectionTone): StatusTone {
  switch (tone) {
    case "covered": return "ok";
    case "partial": return "warn";
    case "unproven": return "warn";
    case "uncovered": return "danger";
    case "unreadable": return "neutral";
  }
}

// TONE_SORT orders the coverage column worst-first when sorted ascending, so a sort surfaces the
// downpipes that need attention (not-covered, then could-not-read, then unproven, then gap, then
// covered). It mirrors TONE_RANK in lib/protection-statement.ts exactly: a sort that disagreed with the
// fleet roll-up would put the worst row somewhere other than the top of the table the roll-up points at.
const TONE_SORT: Record<ProtectionTone, number> = { uncovered: 0, unreadable: 1, unproven: 2, partial: 3, covered: 4 };

// coverageLabel is the SHORT per-row label for the coverage column (the fleet subtitle uses the long
// phrasing; the cell is terse). "Backed up, gap" names the partial state plainly: bytes are written
// but restorability is not currently proven. "No backup yet" is an uncovered row whose runs have never
// succeeded: it sorts and hues with "Not backed up", and the words say that nothing has been written yet.
function coverageLabel(st: ProtectionStatement): string {
  if (st.noBackupYet) return "No backup yet";
  switch (st.tone) {
    case "covered": return "Covered";
    case "partial": return "Backed up, gap";
    case "unproven": return "Backed up, unproven";
    case "uncovered": return "Not backed up";
    // Not "Unknown": unknown reads as a fact about the backup that nobody has established, and an operator
    // scanning this column would file it beside a downpipe that has never run. This says the CONSOLE could
    // not read the record, which is the actual finding and points at the actual remedy.
    case "unreadable": return "Could not be read";
  }
}

// coverageTooltip explains, for the gap states, WHAT the gap is and HOW to close it. It reuses the
// per-downpipe not-covered line (the SAME generator the subtitle and overview use, so the surfaces
// cannot disagree) and appends the concrete next step. That step depends on the recovery posture: a
// drill only runs where the engine holds a usable operational key, so a break-glass-only estate is
// pointed at an attended verification instead, never at a drill the engine will refuse. When the
// posture itself could not be read, the tip states only what holds in both postures. A covered
// downpipe gets the honest scope note (evidence of past recoverability, not a guarantee). This is a
// title="" tooltip, matching the console's other cell tooltips (Last run / Next run); the same text
// is also the cell's aria-label.
function coverageTooltip(st: ProtectionStatement, posture: RecoveryPosture = "unknown"): string {
  if (st.tone === "covered" || st.tone === "uncovered") return st.notCovered;
  const fix =
    posture === "break-glass-only"
      ? " To close the gap, open this downpipe and run an attended verification to prove the bytes can actually be restored."
      : posture === "operational"
        ? " To close the gap, open this downpipe and run Verify restore (drill), or start a restore drill, to prove the bytes can actually be restored."
        : " To close the gap, open this downpipe to prove the bytes can actually be restored.";
  return `${st.notCovered}${fix}`;
}

// coverageCell renders the per-row coverage indicator: a dot + short label (hue + shape + text, never
// colour alone), with a tooltip explaining the gap and the fix. A successful backup proves bytes were
// written, not that they can be restored, so a backed-up-but-unproven downpipe reads honestly here.
//
// THE VISIBLE LABEL IS THE CLAIM AND THE TIP IS THE QUALIFICATION, so where the tip is reachable
// decides which claim a reader actually receives. For a covered row the label is the bare word
// "Covered" and the tip is st.notCovered, the blunt per-downpipe line naming what that does NOT
// assert. A title is hover-only, so a reader without a mouse was receiving "Covered" unqualified,
// which is the stronger claim. The FLEET-wide equivalent of that line is rendered as visible prose
// three times over (this file's header hint, overview/tiles.ts and overview/executive.ts), but the
// PER-DOWNPIPE line had no visible or focusable carrier anywhere.
//
// The aria-label alone did not close that. This is a bare span, so its implicit role is generic,
// and ARIA prohibits aria-label there; a browser is entitled to drop it from the accessibility tree
// rather than expose it, so the one remedy present was the one that could silently not fire. The
// visually-hidden span does not depend on that reading: it is real text in the DOM, which a screen
// reader reads the same way it reads the visible label beside it. It is the idiom this console
// already uses for exactly this (sources/account.ts, sources/cf-wide.ts). The aria-label is KEPT,
// so the two do not compete and whichever the browser honours carries the same words.
//
// Still open, and deliberately not solved here: a SIGHTED keyboard or touch user gets neither, and
// the fix for them cannot be a per-row info-tip without spending the calm-density budget on every
// row of the fleet table. That is a design decision, not a defect fix.
function coverageCell(state: DownpipeState, dest: DestinationDescriptor, posture: RecoveryPosture = "unknown"): HTMLElement {
  const st = protectionStatement(state, dest);
  const tip = coverageTooltip(st, posture);
  const cell = h(
    "span",
    { class: "dp-name", title: tip, "aria-label": `Coverage: ${coverageLabel(st)}. ${tip}` },
    statusWithLabel(protectionToneToStatus(st.tone), coverageLabel(st)),
    h("span", { class: "visually-hidden" }, `. ${tip}`),
  );
  return cell;
}

// ---- the data table (flow.md A/B/I) -----------------------------------------

// buildColumns assembles the row columns. Lifted out of buildTable so the
// coordinator reads as assembly and each column stays scannable on its own.
// FreshnessFn resolves a row to its freshness, memoised per render so the state column and the
// stale/failed facets do not each recompute it.
type FreshnessFn = (d: DownpipeState) => Freshness;

function buildColumns(
  engine: EngineClient,
  latestRun: Map<string, RunFacts>,
  freshness: FreshnessFn,
  opGate: boolean,
  reload: () => void,
  dest: DestinationDescriptor,
  posture: RecoveryPosture = "unknown",
): Array<DataColumn<DownpipeState>> {
  // Inert tags for the public page-walkthrough tour: it pins a "?" info-point to a downpipe's source-pill,
  // schedule and coverage cells, so the marker sits on the actual component, not the column header or a wide
  // cell. The data-tour-id is set on EVERY row (the table re-renders rows on sort / filter / poll, so a one-shot
  // flag would be consumed on the first paint then lost on a re-render); the tour resolves the anchor with
  // document.querySelector, which returns the FIRST (top) match, so the marker pins to the top row. No behaviour,
  // no effect on the genuine console.
  const tagRow = (key: string, el: HTMLElement): HTMLElement => { el.dataset.tourId = `dp-${key}`; return el; };
  return [
    {
      key: "name",
      header: "Name",
      sortable: true,
      sortValue: (d) => d.config.name,
      // The name (config.name, 1 to 256 chars) and its binding are capped and ellipsised in the wide table
      // layout (tokens.css .dp-name--cell): a maximal-length name would otherwise balloon this cell and shove
      // the page-header controls off-screen. The full name rides a title attribute (set via
      // setAttribute, never innerHTML) so it stays available on hover and to assistive tech; the row still
      // opens the detail drawer where the full name is the heading. The =<1023 card-stack lets it wrap instead.
      render: (d) => {
        const sub = sourceSub(d.config.source);
        // tagRow("name") is the anchor a walk pins its "open your downpipe" step to: the name is what the
        // learner clicks to open the drawer, so the spotlight sits on the thing being asked for rather than
        // on a neighbouring cell that happens to be nearby.
        return tagRow("name", h(
          "span",
          { class: "dp-name dp-name--cell" },
          h("span", { class: "linklike dp-name__label", title: d.config.name }, d.config.name),
          h("span", { class: "dp-name__sub mono", title: sub }, sub),
        ));
      },
    },
    {
      key: "source",
      header: "Source",
      sortable: true,
      sortValue: (d) => d.config.source.type,
      render: (d) => tagRow("source-type", sourcePill(d.config.source.type)),
    },
    {
      key: "schedule",
      header: "Schedule",
      sortable: true,
      sortValue: (d) => d.config.cadenceSeconds,
      render: (d) => tagRow("schedule", h("span", titleCase(scheduleSummary(d.config.cadenceSeconds, d.config.schedule)))),
    },
    {
      key: "state",
      header: "State",
      sortable: true,
      sortValue: (d) => freshness(d).label,
      render: (d) => {
        const f = freshness(d);
        const cell = h("span", { class: "dp-name" }, statusWithLabel(f.tone, f.label));
        if (f.reason && (f.tone === "danger" || f.stale)) {
          cell.appendChild(h("span", { class: "run-reason" }, svgIcon(ICON_ALERT, { size: 11 }), f.reason));
        }
        return cell;
      },
    },
    {
      // Coverage: per-row, whether this downpipe's restorability is PROVEN, or whether it is only
      // backed up (a gap). The fleet subtitle says how many have a gap; this column says WHICH ones,
      // and the tooltip explains the gap and the concrete step to close it. The honesty floor is the
      // same as the fleet read (lib/protection-statement.ts): never "Covered" unless restorability is
      // actually proven.
      key: "coverage",
      header: "Coverage",
      sortable: true,
      sortValue: (d) => TONE_SORT[protectionStatement(d, dest).tone],
      render: (d) => tagRow("coverage", coverageCell(d, dest, posture)),
    },
    {
      key: "last",
      header: "Last run",
      sortable: true,
      sortValue: (d) => {
        const r = latestRun.get(d.config.id)?.latest;
        return r ? Date.parse(r.startedAt) : null;
      },
      render: (d) => {
        const facts = latestRun.get(d.config.id);
        const r = facts?.latest;
        if (r) return h("span", { class: "mono", title: absoluteTime(r.startedAt) }, relativeTime(r.startedAt));
        // "loading" is honest only while fillFreshness has never resolved this row (facts absent): once it
        // HAS resolved, `facts` is present even when the fetch found nothing (fillFreshness always calls
        // cache.set, success or failure). `d.lastRunId` alone cannot distinguish a row still in flight from
        // one that has resolved and matched no run in its history (the ring may not hold it). A resolved
        // row tells its two honest empties apart: a failed fetch reads "Could not be read" (the same
        // wording the coverage column uses for a read the console could not complete); a fetch that
        // succeeded and simply found no matching run reads "Not in run history" when the config names a
        // run, never the reused "no runs yet", which would deny a run this downpipe config says it has.
        if (facts === undefined) return h("span", { class: "field__hint" }, d.lastRunId ? "loading" : "no runs yet");
        if (facts.readFailed) return h("span", { class: "field__hint" }, "Could not be read");
        return h("span", { class: "field__hint" }, d.lastRunId ? "Not in run history" : "no runs yet");
      },
    },
    {
      key: "next",
      header: "Next run",
      numeric: true,
      sortable: true,
      // A paused downpipe sorts last (its next run is not a real future time).
      sortValue: (d) => (d.config.enabled ? d.nextRunAt : Number.POSITIVE_INFINITY),
      render: (d) =>
        d.config.enabled
          ? h("span", { class: "mono", title: absoluteTime(d.nextRunAt) }, relativeTime(d.nextRunAt))
          : h("span", { class: "field__hint" }, "Paused"),
    },
    {
      key: "enabled",
      header: "Enabled",
      render: (d) => enabledSwitch(engine, d, opGate, reload),
    },
  ];
}

// buildFacets assembles the filter facets. One facet per offered source type plus the
// stale/failed status facets. The Artifact Registry facet is held behind the ARTIFACTS_GA
// beta gate (lib/token-source.ts): while Artifact Registry is a Cloudflare closed beta the
// console offers no way to create one, so its filter chip stays hidden rather than showing a
// chip that can never match. The predicate is kept intact and dormant; it snaps back with the
// flag so an existing artifacts downpipe stays filterable once the source goes GA.
function buildFacets(freshness: FreshnessFn): Array<Facet<DownpipeState>> {
  // Two dimensions: source `type` (a downpipe has exactly one) and `status` (freshness). Facets within a
  // dimension OR (selecting KV + R2 shows KV-or-R2 downpipes), the two dimensions AND (KV + Failed shows
  // failed KV downpipes). Without the groups, two type facets ANDed to an impossible empty.
  return [
    { id: "type-kv", group: "type", label: "KV", predicate: (d) => d.config.source.type === "kv" },
    { id: "type-r2", group: "type", label: "R2", predicate: (d) => d.config.source.type === "r2" },
    { id: "type-d1", group: "type", label: "D1", predicate: (d) => d.config.source.type === "d1" },
    { id: "type-secrets", group: "type", label: "Secrets", predicate: (d) => d.config.source.type === "secrets" },
    { id: "type-cf-config", group: "type", label: "Config", predicate: (d) => d.config.source.type === "cf-config" },
    { id: "type-workers", group: "type", label: "Workers", predicate: (d) => d.config.source.type === "workers" },
    { id: "type-stream", group: "type", label: "Stream", predicate: (d) => d.config.source.type === "stream" },
    { id: "type-images", group: "type", label: "Images", predicate: (d) => d.config.source.type === "images" },
    ...(ARTIFACTS_GA
      ? [{ id: "type-artifacts", group: "type", label: "Artifacts", predicate: (d: DownpipeState) => d.config.source.type === "artifacts" }]
      : []),
    { id: "status-stale", group: "status", label: "Stale", tone: "warn", predicate: (d) => freshness(d).stale },
    { id: "status-failed", group: "status", label: "Failed", tone: "danger", predicate: (d) => freshness(d).tone === "danger" },
  ];
}

export function buildTable(
  engine: EngineClient,
  list: DownpipeState[],
  latestRun: Map<string, RunFacts>,
  query: URLSearchParams,
  opGate: boolean,
  reload: () => void,
  dest: DestinationDescriptor,
  posture: RecoveryPosture = "unknown",
  // onFacetStateChange: fired alongside reflectStateInUrl on every sort/filter/facet change, so a
  // caller (sources-downpipes.ts, the unread-rows note beside a status facet) can react to the SAME
  // state the URL reflects without re-deriving it. Optional; existing callers (tests) are unaffected.
  onFacetStateChange?: (state: DataTableState) => void,
): ReturnType<typeof dataTable<DownpipeState>> {
  // Memoise freshness per downpipe id for the CURRENT row set: within one set the state column,
  // the stale/failed facets and the state sort share one computation per row rather than
  // recomputing it four times. The memo must not outlive the row
  // set: the table is built once per mount and then refreshed in place via setRows (the standing
  // auto-refresh), so the wrapper below clears this cache on every setRows. Without that, the
  // verdicts computed at mount (before fillFreshness has loaded any run facts) are served
  // forever: every enabled downpipe reads "Idle" while the Last-run column, which reads
  // latestRun directly, keeps moving.
  const freshnessCache = new Map<string, Freshness>();
  const freshness: FreshnessFn = (d) => {
    const cached = freshnessCache.get(d.config.id);
    if (cached) return cached;
    const f = freshnessFor(d, latestRun.get(d.config.id));
    freshnessCache.set(d.config.id, f);
    return f;
  };

  const columns = buildColumns(engine, latestRun, freshness, opGate, reload, dest, posture);
  const facets = buildFacets(freshness);

  // Bulk actions (flow.md I), Operator+ only. A destructive bulk action routes
  // through the safe confirm flow inside run() (the table never confirms itself).
  // "Restore..." is a NAVIGATION, not a write: there is no bulkRestore API (restore is the
  // highest-blast-radius action, so this stays UI-only batching over the existing per-run APIs).
  // It hands the selected ids to the batch restore queue (restore-flow/batch.ts), which drives
  // each downpipe's OWN dry-run/request/approve/apply independently. The URL is built inline
  // (matching restore-flow/batch.ts's
  // buildBatchUrl byte-for-byte) rather than imported, so this screen does not take on a
  // cross-directory dependency on the restore-flow module for one query-string line.
  // Each bulk verb gates on the SAME engine capability its per-item route enforces, independently: a
  // custom role may hold only some of them (the engine gates bulk trigger on run.trigger, delete on
  // downpipe.delete, disable/upsert on downpipe.write, and the batch-restore flow on restore.request), so
  // collapsing them onto one flag would show a control that then 403s. Built-in operator/approver/owner
  // hold all four together, so their bulk bar is unchanged.
  const bulkActions: Array<BulkAction<DownpipeState>> = [];
  if (canCap("run.trigger")) bulkActions.push({ id: "bulk-trigger", label: "Run now", diagAction: "run", run: (rows) => bulkTrigger(engine, rows, reload) });
  if (opGate) bulkActions.push({ id: "bulk-disable", label: "Disable", diagAction: "disable", run: (rows) => bulkDisable(engine, rows, reload) });
  if (canCap("restore.request")) {
    bulkActions.push({
      id: "bulk-restore",
      label: "Restore...",
      keepSelection: true,
      run: async (rows) => {
        navigate(`/restore/batch?${new URLSearchParams({ ids: rows.map((r) => r.config.id).join(",") }).toString()}`);
      },
    });
  }
  if (canCap("downpipe.delete")) bulkActions.push({ id: "bulk-delete", label: "Delete", danger: true, diagAction: "delete", run: (rows) => bulkDelete(engine, rows, reload) });

  // Parse the initial state from the URL (flow.md A/B: deep-linkable filters).
  const initialState: Parameters<typeof dataTable<DownpipeState>>[0]["initialState"] = stateFromQuery(query);

  const table = dataTable<DownpipeState>({
    label: "Downpipes",
    rows: list,
    rowKey: (d) => d.config.id,
    // Carry the live query string (filter/facets/sort, reflected by reflectStateInUrl)
    // onto the detail URL so closing the drawer returns to the same filtered view.
    onRowActivate: (d) => navigate(`/downpipes/${encodeURIComponent(d.config.id)}${location.search}`),
    columns,
    facets,
    filter: { placeholder: "Filter by name or binding   ( / )", resultLabel: "downpipes", getText: (d) => `${d.config.name} ${sourceSub(d.config.source)} ${d.config.source.type}` },
    density: true,
    ...(bulkActions.length ? { bulkActions } : {}),
    initialSort: { key: "name", dir: "asc" },
    initialState,
    onStateChange: (st) => {
      reflectStateInUrl(st);
      onFacetStateChange?.(st);
    },
    empty: trueEmpty(opGate),
  });
  return {
    ...table,
    // A new row set carries new verdict inputs (lastRunId / inFlight / enabled), and the reload
    // path that calls setRows also refreshes latestRun (fillFreshness), so the memoised verdicts
    // are stale the moment rows are replaced. Cleared here, not inside the render (sort / facet /
    // filter re-renders of the SAME row set are exactly what the memo is for).
    setRows(rows: DownpipeState[]): void {
      freshnessCache.clear();
      table.setRows(rows);
    },
  };
}

// stateFromQuery maps the URL query (?type=kv,r2&status=stale&q=...&sort=name:asc)
// to the table's initial state. Facet ids are the table's, so type=kv -> type-kv.
function stateFromQuery(query: URLSearchParams): { query?: string; facets?: string[]; sortKey?: string | null; sortDir?: "asc" | "desc" | null } {
  const out: { query?: string; facets?: string[]; sortKey?: string | null; sortDir?: "asc" | "desc" | null } = {};
  const q = query.get("q");
  if (q) out.query = q;
  const facets: string[] = [];
  const types = query.get("type");
  if (types) for (const t of types.split(",")) if (t) facets.push(`type-${t}`);
  const st = query.get("status");
  if (st) for (const s of st.split(",")) if (s) facets.push(`status-${s}`);
  if (facets.length) out.facets = facets;
  const sort = query.get("sort");
  if (sort) {
    const [key, dir] = sort.split(":");
    if (key) out.sortKey = key;
    if (dir === "asc" || dir === "desc") out.sortDir = dir;
  }
  return out;
}

// reflectStateInUrl writes the table state back to the query string (shareable,
// survives refresh) without adding a history entry (replaceState).
function reflectStateInUrl(st: { query: string; facets: string[]; sortKey: string | null; sortDir: "asc" | "desc" | null }): void {
  const qs = new URLSearchParams();
  if (st.query) qs.set("q", st.query);
  const types = st.facets.filter((f) => f.startsWith("type-")).map((f) => f.slice("type-".length));
  const statuses = st.facets.filter((f) => f.startsWith("status-")).map((f) => f.slice("status-".length));
  if (types.length) qs.set("type", types.join(","));
  if (statuses.length) qs.set("status", statuses.join(","));
  if (st.sortKey && st.sortDir) qs.set("sort", `${st.sortKey}:${st.sortDir}`);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  try {
    history.replaceState({}, "", `/downpipes${suffix}`);
  } catch {
    // best-effort; a blocked history API just means the URL is not reflected.
  }
}

// enabledSwitch builds the per-row enable/disable switch (flow.md F). Operator+
// only; a Viewer sees it disabled-with-reason. Toggling is optimistic with an Undo
// toast; a failed write reverts the flip and marks the row (never a lie about state).
function enabledSwitch(engine: EngineClient, state: DownpipeState, opGate: boolean, reload: () => void): HTMLElement {
  const wrap = h("span", { class: "switch" });
  const input = h("input", { "data-dp": "sources-downpipes.checkbox.enabled-switch",
    type: "checkbox",
    "aria-label": `Enable ${state.config.name}`,
  }) as HTMLInputElement;
  input.checked = state.config.enabled;
  if (!opGate) {
    // THIS ONE KEEPS `disabled`, DELIBERATELY, and it is the only control on this screen that does.
    // The rest of the console's gated buttons use aria-disabled so they stay focusable and their
    // reason is reachable, but a CHECKBOX is not a button: aria-disabled is an announcement, and a
    // clicked checkbox flips its own checked state before any handler runs. A refused operator would
    // see the switch move and the downpipe stay exactly as it was, which is a lie about state, and a
    // lie about whether a backup is enabled is worse than an unreachable reason.
    //
    // The reason needs more than one carrier. A title alone fires on hover, so it is mouse-only, and
    // sitting it on a bare span (implicit role generic) is not guaranteed to reach assistive tech. It
    // is real DOM text in a visually-hidden span, which a screen reader reads with the row and a
    // phone can reach, with the title kept for the mouse. The keyboard user still cannot TAB to a
    // disabled checkbox; that half is not fixed here and is recorded rather than papered over.
    input.disabled = true;
    wrap.title = capGateReason("downpipe.write");
    wrap.appendChild(h("span", { class: "visually-hidden" }, capGateReason("downpipe.write")));
  }
  wrap.appendChild(input);
  wrap.appendChild(h("span", { class: "track" }, h("span", { class: "thumb" })));

  // The row-level pending trace: after a queued-for-approval toggle the switch snaps
  // back, so a small info badge beside it records that the change is queued (the next
  // reload re-renders the row, clearing it). Built once; inserted at most once.
  const pendingBadge = badge("info", "Pending approval");
  pendingBadge.style.marginLeft = "var(--space-2)";

  if (opGate) {
    input.addEventListener("change", async () => {
      const want = input.checked;
      const next: Downpipe = { ...state.config, enabled: want };
      try {
        // THE ROW SWITCH SPREADS THE CONFIG THIS TABLE LOADED, and unlike the drawer's toggle it does not
        // re-read first, so the window here is the lifetime of the list. `state.configRev` is the revision
        // that list was read at, so a row another operator has edited since is refused with 409 naming the
        // field that moved (surfaced by the catch below) instead of being silently reverted by the flip.
        const res = await engine.addDownpipe(next, state.configRev);
        // Gate queued it: the flip has NOT taken effect, so revert the optimistic switch and surface the
        // pending state with NO Undo (there is nothing to undo; it is queued for an approver, not applied).
        if (res.status === "pending") {
          input.checked = !want;
          if (!pendingBadge.isConnected) wrap.parentElement?.appendChild(pendingBadge);
          surfacePendingChange("change");
          return;
        }
        toast({
          message: want ? `Enabled ${state.config.name}` : `Disabled ${state.config.name}`,
          action: {
            label: "Undo",
            onClick: async () => {
              try {
                // The Undo re-reads so it can state a CURRENT base: undoing a flip must not carry this
                // table's stale config back over an edit that landed in between, and a base stated off the
                // stale row would be refused for a collision the operator has no way to see.
                const current = (await engine.listDownpipes()).find((d) => d.config.id === state.config.id) ?? null;
                if (current !== null) await engine.addDownpipe({ ...current.config, enabled: !want }, current.configRev);
                reload();
              } catch {
                /* undo is best-effort */
              }
            },
          },
        });
        reload();
      } catch (err) {
        // Revert the optimistic flip; the switch must reflect reality (flow.md F).
        input.checked = !want;
        if (isUnauthorised(err)) return goSignedOut();
        toast({ message: `Could not change ${state.config.name}. ${errMsg(err)}`, tone: "warn" });
      }
    });
  }
  return wrap;
}

// trueEmpty is the first-run teaching state (flow.md A): a source->engine->archive
// diagram, an explanation, and Create/Import (Operator+) or an onboarding route for
// Viewers. The elevated version shows two actions (Create and Import) for Operators
// and routes Viewers to the onboarding flow if they need to set up the engine first.
export function trueEmpty(opGate: boolean): HTMLElement {
  const diagram = h(
    "div",
    { class: "empty-diagram", style: "display:flex;align-items:center;gap:var(--space-2);color:var(--text-muted);font-size:var(--text-xs);justify-content:center" },
    h("span", { style: "display:inline-flex;align-items:center;gap:var(--space-1)" }, svgIcon(ICON_KV, { size: 16 }), "Source"),
    h("span", { "aria-hidden": "true" }, "->"),
    h("span", { style: "display:inline-flex;align-items:center;gap:var(--space-1)" }, svgIcon(ICON_RUNS, { size: 16 }), "Engine"),
    h("span", { "aria-hidden": "true" }, "->"),
    h("span", { style: "display:inline-flex;align-items:center;gap:var(--space-1)" }, svgIcon(ICON_R2, { size: 16 }), "Archive"),
  );
  if (opGate) {
    // Operator: offer both Create and Import as clear entry points. dataset.tourId: the inert
    // training-walk anchor; the walk's first-downpipe chapter pins its spotlight on this empty state.
    const wrap = h("div", { dataset: { tourId: "downpipes-empty" } });
    wrap.appendChild(
      emptyState({
        title: "No downpipes yet",
        body: `A downpipe is a backup route from a Cloudflare source (KV, R2, Secrets Store, D1, Workers scripts, Stream, Images${ARTIFACTS_GA ? ", Artifact Registry" : ""} or account-level config) to your archive bucket. Create one here: the wizard lists everything in your account, protects whatever you pick (one token, used once), confirms the destination and schedule, nothing to type.`,
        diagram,
        action: { label: "New downpipe", onClick: () => navigate("/downpipes/new") },
      }),
    );
    // A secondary "Import a list" anchor below the primary CTA, so bulk-setup is
    // not hidden behind a single primary button.
    const importHint = h(
      "p",
      { class: "field__hint", style: "text-align:center;margin-top:var(--space-2)" },
      "Have multiple sources? ",
      h("button", { "data-dp": "sources-downpipes.button.navigate-downpipes-action-import",
        class: "btn btn--ghost btn--sm",
        type: "button",
        style: "display:inline;padding:0;font-size:inherit;text-decoration:underline",
        on: { click: () => navigate("/downpipes?action=import") },
      }, "Import a list of bindings"),
      " to create them all at once.",
    );
    wrap.appendChild(importHint);
    return wrap;
  }
  // Viewer: explain the empty state and route to the setup surface.
  return emptyState({
    title: "No downpipes configured",
    body: "Backup routes appear here once an Operator sets them up. Ask your account owner to finish setup, which creates a downpipe for each source to protect.",
    diagram,
    action: { label: "View setup", variant: "secondary", onClick: () => navigate("/setup") },
  });
}

// FRESHNESS_CONCURRENCY bounds how many GET /admin/history?id= reads fillFreshness runs at once. A
// bulk-created or actively-running fleet can put thousands of downpipes on this screen at once; with
// FRESHNESS_FIRST_LOAD_BUDGET / FRESHNESS_STEADY_BUDGET below already capping how MANY rows a single
// call ever reads, this only bounds how many of those run at the same instant.
const FRESHNESS_CONCURRENCY = 4;
// FRESHNESS_FIRST_LOAD_BUDGET caps how many rows the FIRST fillFreshness call may read by id, a fixed
// allowance of its own, never shared with any refresh after it. FRESHNESS_STEADY_BUDGET is the size of
// the ROLLING budget sources-downpipes.ts (steadyBudgetRemaining) enforces across EVERY refresh after
// the first load: at most this many history reads in any 30 s of wall time, shared by every refresh,
// not a fresh allowance per refresh (see that function's own header for why a flat per-refresh cap let
// two refreshes' reads add up to more than the budget in a real 30 s stretch). There is deliberately no
// "read everything in one shot" path any more: GET /admin/history with no id returns every downpipe's
// FULL run-history ring (RING_CAP entries each, no fleet-wide cap -- engine
// src/sched/scheduler-do-run-history.ts history(null)), which at a few thousand downpipes runs to tens
// of megabytes of JSON. That traded a request storm for a payload storm, so this never calls it; a
// refresh instead reads only what the operator can see (or just saw finish), plus a small trickle of
// the rest so an off-screen row's facts eventually arrive. A row this never reaches stays honestly
// "Loading" (helpers.ts freshnessFor) rather than a wrong value.
export const FRESHNESS_FIRST_LOAD_BUDGET = 50;
export const FRESHNESS_STEADY_BUDGET = 20;

// The inputs fillFreshness needs beyond the list/cache: which rows the table currently RENDERS (read
// first; the windowed table at components/data-table-render.ts only ever renders the visible slice
// plus a small overscan, so "currently rendered" already IS "on screen or one scroll away", with no
// extra observer wiring and no lag), how many rows this call may read by id in total, and whether the
// remainder of that budget may go to a row OUTSIDE visibleIds (the background trickle). budget is the
// ONE place pacing lives: sources-downpipes.ts hands the first load its own fixed
// FRESHNESS_FIRST_LOAD_BUDGET, and every refresh after it a ROLLING remainder (at most
// FRESHNESS_STEADY_BUDGET history reads in any 30 s of wall time, shared across every refresh, never a
// fresh allowance per refresh) -- this function itself does no pacing and does not know which caller it
// is; it only ever reads up to the number it was handed. allowTrickle still gates whether a row outside
// visibleIds may spend any of that budget at all (a fleet with some run almost always in flight must
// still trickle eventually, or an off-screen row would read "Loading" forever, so the caller keeps this
// true on every refresh and lets budget alone do the pacing).
//
// priorityIds is the one case an off-screen row jumps the ordinary trickle queue, WITHIN the same
// budget (never an extra allowance): an active status facet (Stale/Failed) cannot evaluate an unread
// row honestly, so sources-downpipes.ts names the unread rows that still match every OTHER active
// facet, and those are read before an unrelated off-screen row, so the filtered view settles sooner.
// Optional; empty when nothing asks for a priority.
export interface FreshnessFillOptions {
  visibleIds: ReadonlySet<string>;
  budget: number;
  allowTrickle: boolean;
  priorityIds?: ReadonlySet<string>;
}

// fillFreshness lazily loads the run facts for each downpipe, deduped against the cache: the newest run
// of any status plus the newest GOOD run, because the shared staleness rule measures from the last
// successful run. Failures are swallowed per-downpipe (the cell reads "loading" then falls back to the
// lastRunId-derived idle state) so one bad call does not break the fleet view. A 401 routes to signed-out.
// Returns the number of history reads it actually issued (0 on an empty budget or nothing pending), so
// the caller can charge that exact count against its own pacing (sources-downpipes.ts's rolling budget).
export async function fillFreshness(
  engine: EngineClient,
  list: DownpipeState[],
  cache: Map<string, RunFacts>,
  onUpdate: () => void,
  { visibleIds, budget, allowTrickle, priorityIds = new Set<string>() }: FreshnessFillOptions,
): Promise<number> {
  // A row currently IN FLIGHT needs no history read at all: freshnessFor reads d.inFlight straight off
  // the downpipe list to show "Running", for as long as it keeps running, at zero history-read cost.
  // pending is therefore a row whose facts cannot be trusted as they stand:
  //   - never read (facts absent): the honest "Loading" state (helpers.ts) covers it until this reaches it;
  //   - WAS in flight last time this ran and is not any more (sawInFlight, stamped below): the ONLY way
  //     to learn how a run ended, because a FAILED run clears inFlight but does NOT advance lastRunId
  //     (engine src/sched/scheduler-do-scheduling.ts completeRun: lastRunId only moves on a truthy
  //     req.runId, the successful-run convention; an empty runId is the failed convention and leaves
  //     lastRunId untouched) -- a filter on lastRunId alone would silently miss every failed run;
  //   - not in flight, never seen in flight, but a newer run landed anyway (lastRunId moved): a run that
  //     both started and finished between two polls, so this cycle never observed it in flight.
  const pending = list.filter((d) => {
    const facts = cache.get(d.config.id);
    if (!facts) return true;
    if (d.inFlight) return false;
    if (facts.sawInFlight) return true;
    const cachedRunId = facts.latest?.runId ?? null;
    return (d.lastRunId ?? null) !== cachedRunId;
  });

  // Stamp every row's CURRENT in-flight state onto its cached facts now (in memory, no network), so a
  // row this cycle never reads (steady and not pending, or past budget below) still carries the right
  // sawInFlight for the NEXT cycle. A pending row's facts are replaced wholesale once its own read
  // lands, below, which carries the same stamp.
  for (const d of list) {
    const facts = cache.get(d.config.id);
    if (facts) facts.sawInFlight = d.inFlight;
  }

  if (pending.length === 0) {
    onUpdate();
    return 0;
  }

  // Visible-pending rows always go first (including a row that just LEFT flight: it is still visible,
  // and is exactly the row the caller's own ordering comment calls out); priority rows (an active
  // status facet's other-facets match, see FreshnessFillOptions) go next; a trickle of whatever is left
  // fills the rest. slice(0, budget) is the hard cap: this reads at most `budget` rows, in any mix of
  // the three, however large the pending set -- budget is where ALL pacing lives (see this function's
  // own header); a visible row past the budget simply waits for the budget the caller hands the next
  // refresh, the same as a trickled one.
  const visible = pending.filter((d) => visibleIds.has(d.config.id));
  const offScreen = allowTrickle ? pending.filter((d) => !visibleIds.has(d.config.id)) : [];
  const priority = offScreen.filter((d) => priorityIds.has(d.config.id));
  const rest = offScreen.filter((d) => !priorityIds.has(d.config.id));
  const queue = [...visible, ...priority, ...rest].slice(0, budget);
  if (queue.length === 0) {
    onUpdate();
    return 0;
  }

  let unauth = false;
  let cursor = 0;
  let sinceUpdate = 0;
  const worker = async (): Promise<void> => {
    while (cursor < queue.length && !unauth) {
      const d = queue[cursor]!;
      cursor++;
      try {
        const entries = await engine.listHistory(d.config.id);
        cache.set(d.config.id, { latest: entries[0], lastGood: entries.find((e) => e.status === "ok"), sawInFlight: d.inFlight });
      } catch (err) {
        if (isUnauthorised(err)) unauth = true;
        // Mark as resolved, the read itself having failed, so the cell stops showing "loading" and reads
        // "Could not be read" rather than the honest-empty "Not in run history" a succeeded, empty read gets.
        cache.set(d.config.id, { latest: undefined, lastGood: undefined, readFailed: true, sawInFlight: d.inFlight });
      }
      // Repaint periodically on a large fill so the visible rows do not sit on
      // "loading" until the whole queue resolves.
      sinceUpdate++;
      if (sinceUpdate >= 10) {
        sinceUpdate = 0;
        onUpdate();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FRESHNESS_CONCURRENCY, queue.length) }, () => worker()));
  if (unauth) {
    goSignedOut();
    return cursor;
  }
  onUpdate();
  return cursor;
}
