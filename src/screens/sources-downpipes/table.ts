// The fleet data table for the Sources + downpipes screen (flow.md A/B/I): the protection
// subtitle, the per-row coverage cell, the sortable/filterable/faceted table with bulk actions,
// the URL state round-trip, the per-row enable switch, the true-empty teaching state, and the
// lazy freshness fill. Moved verbatim from the screen module. Australian English, no em dashes,
// precise claims.

import type {
  Downpipe,
  DownpipeState,
  EngineClient,
  StatusReport,
} from "../../api.ts";
import { type BulkAction, type DataColumn, dataTable, type Facet } from "../../components/data-table.ts";
import { emptyState } from "../../components/feedback.ts";
import { badge, type StatusTone, statusWithLabel } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { absoluteTime, relativeTime, scheduleSummary, titleCase } from "../../lib/format.ts";
import { ICON_ALERT, ICON_RUNS } from "../../lib/icons.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
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
// but restorability is not currently proven.
function coverageLabel(tone: ProtectionTone): string {
  switch (tone) {
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
// cannot disagree) and appends the concrete next step: the "Verify restore (drill)" action lives in
// this downpipe's detail drawer (next to the run strip). A covered downpipe gets the honest scope
// note (evidence of past recoverability, not a guarantee). This is a title="" tooltip, matching the
// console's other cell tooltips (Last run / Next run); the same text is also the cell's aria-label.
function coverageTooltip(st: ProtectionStatement): string {
  if (st.tone === "covered") return st.notCovered;
  const fix =
    st.tone === "uncovered"
      ? ""
      : " To close the gap, open this downpipe and run Verify restore (drill), or start a restore drill, to prove the bytes can actually be restored.";
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
function coverageCell(state: DownpipeState, dest: DestinationDescriptor): HTMLElement {
  const st = protectionStatement(state, dest);
  const tip = coverageTooltip(st);
  const cell = h(
    "span",
    { class: "dp-name", title: tip, "aria-label": `Coverage: ${coverageLabel(st.tone)}. ${tip}` },
    statusWithLabel(protectionToneToStatus(st.tone), coverageLabel(st.tone)),
    h("span", { class: "visually-hidden" }, `. ${tip}`),
  );
  return cell;
}

// ---- the data table (flow.md A/B/I) -----------------------------------------

// buildColumns assembles the row columns. Lifted out of buildTable so the
// coordinator reads as assembly and each column stays scannable on its own.
// FreshnessFn resolves a row to its freshness, memoised per render so the state column and the
// stale/failed facets do not each recompute it (finding console-src-055-11).
type FreshnessFn = (d: DownpipeState) => Freshness;

function buildColumns(
  engine: EngineClient,
  latestRun: Map<string, RunFacts>,
  freshness: FreshnessFn,
  opGate: boolean,
  reload: () => void,
  dest: DestinationDescriptor,
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
      render: (d) => tagRow("coverage", coverageCell(d, dest)),
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
        const r = latestRun.get(d.config.id)?.latest;
        if (!r) return h("span", { class: "field__hint" }, d.lastRunId ? "loading" : "no runs yet");
        return h("span", { class: "mono", title: absoluteTime(r.startedAt) }, relativeTime(r.startedAt));
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
  // failed KV downpipes). Without the groups, two type facets ANDed to an impossible empty (the B38 class).
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
): ReturnType<typeof dataTable<DownpipeState>> {
  // Memoise freshness per downpipe id for the CURRENT row set: within one set the state column,
  // the stale/failed facets and the state sort share one computation per row rather than
  // recomputing it four times (finding console-src-055-11). The memo must not outlive the row
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

  const columns = buildColumns(engine, latestRun, freshness, opGate, reload, dest);
  const facets = buildFacets(freshness);

  // Bulk actions (flow.md I), Operator+ only. A destructive bulk action routes
  // through the safe confirm flow inside run() (the table never confirms itself).
  // "Restore..." is a NAVIGATION, not a write: there is no bulkRestore API (restore is the
  // highest-blast-radius action; the owner decision was UI-only batching over the existing
  // per-run APIs, source-granularity audit item 8). It hands the selected ids to the batch
  // restore queue (restore-flow/batch.ts), which drives each downpipe's OWN dry-run/request/
  // approve/apply independently. The URL is built inline (matching restore-flow/batch.ts's
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
    onStateChange: (st) => reflectStateInUrl(st),
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
    // The rest of the console's gated buttons moved to aria-disabled so they stay focusable and their
    // reason is reachable, but a CHECKBOX is not a button: aria-disabled is an announcement, and a
    // clicked checkbox flips its own checked state before any handler runs. A refused operator would
    // see the switch move and the downpipe stay exactly as it was, which is a lie about state, and a
    // lie about whether a backup is enabled is worse than an unreachable reason.
    //
    // What DOES change is the carrier. The reason lived only in the wrapper's title, which fires on
    // hover and so was mouse-only, and sat on a bare span whose implicit role is generic. It is now
    // real DOM text in a visually-hidden span, which a screen reader reads with the row and a phone
    // can reach. The title stays for the mouse. The keyboard user still cannot TAB to a disabled
    // checkbox; that half is not fixed here and is recorded rather than papered over.
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
        body: "A downpipe is a backup route from a Cloudflare source (KV, R2, Secrets Store, D1, Workers scripts, Stream, Images, Artifact Registry or account-level config) to your archive bucket. Create one here: the wizard lists everything in your account, protects whatever you pick (one token, used once), confirms the destination and schedule, nothing to type.",
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
  // Viewer: explain the empty state and route to the onboarding guide.
  return emptyState({
    title: "No downpipes configured",
    body: "Backup routes appear here once an Operator sets them up. Ask your account owner to complete the engine onboarding, then create a downpipe for each source to protect.",
    diagram,
    // The router only matches /onboarding/:step; the bare /onboarding would fall
    // through to Overview, so the link names the first step explicitly.
    action: { label: "Go to onboarding guide", variant: "secondary", onClick: () => navigate("/onboarding/connect") },
  });
}

// fillFreshness lazily loads the run facts for each downpipe (one history call each,
// deduped against the cache): the newest run of any status plus the newest GOOD run,
// because the shared staleness rule measures from the last successful run. Failures are
// swallowed per-downpipe (the cell reads "loading" then falls back to the
// lastRunId-derived idle state) so one bad call does not break the fleet view. A 401
// routes to signed-out.
export async function fillFreshness(
  engine: EngineClient,
  list: DownpipeState[],
  cache: Map<string, RunFacts>,
  onUpdate: () => void,
): Promise<void> {
  // Re-fetch a downpipe's run facts when they are ABSENT or have gone STALE since the cache was filled: a
  // newer run has landed (its lastRunId no longer matches the cached latest run's id) or a run is in
  // flight (its status will transition). The cache is otherwise kept, so the in-place auto-refresh
  // re-fetches only the downpipes that actually MOVED (not the whole fleet each poll), and the State
  // column reflects a Running -> ok/failed transition without a manual reload. Previously the filter was
  // `!cache.has(id)`, so once a downpipe's facts were cached they never refreshed: the State froze while
  // the relative Last-run time merely ticked against the clock (the reported "last run updates but state
  // never does").
  const pending = list.filter((d) => {
    const facts = cache.get(d.config.id);
    if (!facts) return true;
    const cachedRunId = facts.latest?.runId ?? null;
    return (d.lastRunId ?? null) !== cachedRunId || d.inFlight === true || facts.latest?.status === "in-flight";
  });
  if (pending.length === 0) {
    onUpdate();
    return;
  }
  let unauth = false;
  // BOUNDED concurrency (a shared cursor over the pending list, FRESHNESS_CONCURRENCY workers): a
  // bulk-created fleet can put a thousand downpipes on this screen at once, and an unbounded
  // Promise.all would fire one history request per downpipe simultaneously, hammering the
  // single-threaded scheduler DO and tripping the per-caller rate limit. Eight in flight keeps the
  // fill fast for a normal fleet while a large one streams in batch by batch (the periodic
  // onUpdate below repaints as facts arrive, so early rows fill in while the tail loads).
  const FRESHNESS_CONCURRENCY = 8;
  let cursor = 0;
  let sinceUpdate = 0;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length && !unauth) {
      const d = pending[cursor++]!;
      try {
        const entries = await engine.listHistory(d.config.id);
        cache.set(d.config.id, { latest: entries[0], lastGood: entries.find((e) => e.status === "ok") });
      } catch (err) {
        if (isUnauthorised(err)) unauth = true;
        // Mark as resolved-with-nothing so the cell stops showing "loading".
        cache.set(d.config.id, { latest: undefined, lastGood: undefined });
      }
      // Repaint periodically on a large fill so the visible rows do not sit on
      // "loading" until the whole fleet resolves.
      sinceUpdate++;
      if (sinceUpdate >= 50) {
        sinceUpdate = 0;
        onUpdate();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FRESHNESS_CONCURRENCY, pending.length) }, () => worker()));
  if (unauth) return goSignedOut();
  onUpdate();
}
