// The Runs data table: the dense fleet-wide activity grid built on the shared dataTable()
// (a /-focusable text filter, status facets, sortable columns, newest-first default sort
// and large-list windowing) plus the URL reflection that makes a filtered view
// bookmarkable and refresh-safe. The legacy Overview deep links
// (?status=failed, ?downpipe=<id>) seed the initial state and normalise to the canonical
// ?q= / ?status= / ?sort= shape on the next reflect.

import { h } from "../../lib/dom.ts";
import { navigate } from "../../lib/nav.ts";
import { dataTable, type DataColumn, type Facet, type DataTableHandle, type DataTableState } from "../../components/data-table.ts";
import { badge, statusWithLabel, runStatusTone } from "../../components/status.ts";
import { relativeTime, absoluteTime, groupNumber, humanBytes } from "../../lib/format.ts";
import { type FleetRun, type RunStatus, STATUS_FACETS, isUnsuccessful } from "./types.ts";
import { buildEmpty, humanDuration, sealVerifyShort, shortfallLabel, runBytes } from "./helpers.ts";

export function buildTable(
  runs: FleetRun[],
  query: URLSearchParams,
): DataTableHandle<FleetRun> {
  const columns: Array<DataColumn<FleetRun>> = [
    {
      key: "downpipe",
      header: "Downpipe",
      sortable: true,
      sortValue: (r) => r.downpipeName ?? r.downpipeId,
      // The human name (Downpipe.name) is the primary reading; the slug id is demoted to
      // the mono hint. When the list read supplied no name, the id stays primary (honest,
      // never a blank).
      render: (r) => {
        const stack = h("div", { style: "display:flex;flex-direction:column;gap:1px;min-width:0" });
        if (r.downpipeName && r.downpipeName !== r.downpipeId) {
          stack.appendChild(h("span", { style: "font-weight:var(--weight-medium);overflow:hidden;text-overflow:ellipsis" }, r.downpipeName));
          stack.appendChild(h("span", { class: "field__hint mono" }, `${r.downpipeId} run ${groupNumber(r.index)}`));
        } else {
          stack.appendChild(h("span", { class: "mono", style: "font-weight:var(--weight-medium);overflow:hidden;text-overflow:ellipsis" }, r.downpipeId));
          stack.appendChild(h("span", { class: "field__hint mono" }, `run ${groupNumber(r.index)}`));
        }
        return stack;
      },
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      // Sort worst-first by default direction: failed (0) < abandoned (1) < in-flight (2) < ok (3).
      sortValue: (r) => statusRank(r.status),
      render: (r) => {
        const { tone, label } = runStatusTone(r.status);
        const wrap = h("span", { class: "run-status-cell" }, statusWithLabel(tone, label));
        // The recorded reason, for BOTH terminal unsuccessful statuses. It used to be failure-scoped, so the
        // one string an abandoned run carries, the engine's "abandoned (run lease expired)", never reached the
        // row that was showing it as abandoned and explaining nothing.
        if (isUnsuccessful(r.status) && r.error) wrap.appendChild(h("span", { class: "field__hint run-status-cell__err" }, r.error));
        // The verify-at-seal verdict as a small calm badge beside the status, when the run carries it.
        // A verified run earns a quiet trust badge; a suspect verdict a danger badge that reads as a
        // real recoverability signal. An older run without the field shows nothing (honest absence).
        const seal = r.sealVerification;
        if (seal) {
          const b =
            seal.status === "verified"
              ? badge("trust", sealVerifyShort(seal))
              : badge("danger", "seal suspect");
          b.classList.add("run-status-cell__seal");
          wrap.appendChild(b);
        }
        // A run short of the live source (any of recordsIncomplete / recordsSkipped / recordsVanished > 0) is
        // NOT a clean success: a calm warn badge beside the status states the total count so the operator sees
        // the backup is short of a full copy rather than reading a plain ok, whichever of the three drove it. Absent or 0 on all three shows nothing.
        const shortfall = shortfallLabel(r);
        if (shortfall) {
          const ib = badge("warn", shortfall);
          ib.classList.add("run-status-cell__seal");
          wrap.appendChild(ib);
        }
        return wrap;
      },
    },
    {
      key: "started",
      header: "Started",
      sortable: true,
      sortValue: (r) => Date.parse(r.startedAt) || 0,
      render: (r) => h("span", { class: "tnum", title: absoluteTime(r.startedAt) }, relativeTime(r.startedAt)),
    },
    {
      key: "duration",
      header: "Duration",
      numeric: true,
      sortable: true,
      sortValue: (r) => (typeof r.durationMs === "number" ? r.durationMs : null),
      render: (r) => (typeof r.durationMs === "number" ? h("span", { class: "tnum" }, humanDuration(r.durationMs)) : h("span", { class: "field__hint" }, "-")),
    },
    {
      key: "records",
      header: "Records",
      numeric: true,
      sortable: true,
      sortValue: (r) => (typeof r.recordCount === "number" ? r.recordCount : null),
      render: (r) => (typeof r.recordCount === "number" ? h("span", { class: "tnum" }, groupNumber(r.recordCount)) : h("span", { class: "field__hint" }, "-")),
    },
    {
      key: "archive",
      header: "Archive written",
      numeric: true,
      sortable: true,
      // The archive bytes WRITTEN only: never fall back to r.bytes (the plaintext READ
      // size, a different and larger quantity shown as "Plaintext read" in the drawer),
      // which would put a misleading figure under this header and disagree with the
      // summary band's archive total (buildSummary sums archiveBytesWritten with no
      // fallback). An absent figure reads "-", never a borrowed one.
      // runBytes is the guard, not `typeof === "number"`: typeof NaN is "number", so a CORRUPT byte
      // figure walked through the old test, rendered the same "-" as an absent one, and recorded nothing. The
      // sort reads the same helper so a corrupt row cannot sort as if it had a size.
      sortValue: (r) => runBytes(r.archiveBytesWritten),
      render: (r) => {
        const b = runBytes(r.archiveBytesWritten);
        return b !== null ? h("span", { class: "tnum" }, humanBytes(b)) : h("span", { class: "field__hint" }, "-");
      },
    },
    {
      key: "run",
      header: "Run id",
      sortable: true,
      sortValue: (r) => r.runId,
      render: (r) => h("span", { class: "mono nowrap", style: "overflow:hidden;text-overflow:ellipsis" }, r.runId || "-"),
    },
  ];

  const facets: Array<Facet<FleetRun>> = STATUS_FACETS.map((f) => ({
    id: `status-${f.id}`,
    // One dimension: a run is exactly one status, so selecting ok + failed must show ok-or-failed runs
    // (the union the ?status=ok,failed URL already writes), never AND to an impossible empty.
    group: "status",
    label: f.label,
    tone: f.tone,
    predicate: (r: FleetRun) => r.status === f.id,
  }));

  return dataTable<FleetRun>({
    label: "Runs across the fleet",
    rows: runs,
    rowKey: (r) => `${r.downpipeId}:${r.index}`,
    // Carry the live query string (filter/facets/sort, reflected by reflectStateInUrl)
    // onto the detail URL so closing the drawer returns to the same filtered view.
    onRowActivate: (r) => navigate(`/runs/${encodeURIComponent(r.downpipeId)}/${r.index}${location.search}`),
    columns,
    facets,
    filter: {
      placeholder: "Filter by downpipe or run id   ( / )",
      resultLabel: "runs",
      getText: (r) => `${r.downpipeName ?? ""} ${r.downpipeId} ${r.runId}`,
    },
    density: true,
    // Newest-first by default: sort the started column descending.
    initialSort: { key: "started", dir: "desc" },
    initialState: stateFromQuery(query),
    onStateChange: (st) => reflectStateInUrl(st),
    empty: buildEmpty(),
  });
}

// statusRank orders the status sort worst-first in the ascending direction so a single click on Status
// surfaces the runs that need attention (failed < abandoned < in-flight < ok).
//
// Abandoned used to fall through to the ok bucket, so a worst-first sort BURIED it at the bottom of the
// table beside the successes. It sits below failed because a failed run carries a diagnosed cause and an
// abandoned one carries a lost verdict, and above in-flight because it is terminal.
function statusRank(s: RunStatus): number {
  if (s === "failed") return 0;
  if (s === "abandoned") return 1;
  return s === "in-flight" ? 2 : 3;
}

// stateFromQuery maps the URL query to the table's initial state. It honours BOTH the
// table's own reflected shape (?q=, ?status=ok,failed, ?sort=started:desc) AND the
// pre-existing Overview deep link (?status=failed as a single value, ?downpipe=<id>),
// so /runs?status=failed still pre-selects the failed facet and /runs?downpipe=uploads
// seeds the text filter. Facet ids are the table's, so status=failed -> status-failed.
function stateFromQuery(query: URLSearchParams): Partial<DataTableState> {
  const out: Partial<DataTableState> = {};

  // Text filter: the table's ?q=, or the legacy ?downpipe=<id> (which seeds the text
  // filter, since the filter matches the downpipe id).
  const q = query.get("q") ?? query.get("downpipe");
  if (q) out.query = q;

  // Status facets: a comma-list (?status=ok,failed) or a single legacy value
  // (?status=failed). Each known status maps to its facet id.
  const status = query.get("status");
  if (status) {
    const ids: string[] = [];
    for (const raw of status.split(",")) {
      const s = raw.trim();
      if (isRunStatus(s)) ids.push(`status-${s}`);
    }
    if (ids.length) out.facets = ids;
  }

  const sort = query.get("sort");
  if (sort) {
    const [key, dir] = sort.split(":");
    if (key) out.sortKey = key;
    if (dir === "asc" || dir === "desc") out.sortDir = dir;
  }
  return out;
}

// reflectStateInUrl writes the table state back to the query string via replaceState so
// a filtered view is bookmarkable and survives a refresh, WITHOUT adding a history entry. It writes the canonical shape (?q=, ?status=ok,failed,
// ?sort=started:desc); the legacy ?downpipe= read is one-way (it seeds, then normalises
// to ?q= on the next reflect), which keeps a single canonical URL the back button and a
// shared link both resolve to.
function reflectStateInUrl(st: DataTableState): void {
  const qs = new URLSearchParams();
  if (st.query) qs.set("q", st.query);
  const statuses = st.facets
    .filter((f) => f.startsWith("status-"))
    .map((f) => f.slice("status-".length))
    .filter(isRunStatus);
  if (statuses.length) qs.set("status", statuses.join(","));
  if (st.sortKey && st.sortDir) qs.set("sort", `${st.sortKey}:${st.sortDir}`);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  try {
    history.replaceState({}, "", `/runs${suffix}`);
  } catch {
    // Best-effort: a blocked history API just means the URL is not reflected.
  }
}

// isRunStatus guards the ?status= query. It is derived from STATUS_FACETS rather than re-listing the
// members, because the hand-written copy is what silently dropped ?status=abandoned: the facet existed
// nowhere, the guard rejected the value, and stateFromQuery discarded a link an operator had been given.
function isRunStatus(s: string): s is RunStatus {
  return STATUS_FACETS.some((f) => f.id === s);
}
