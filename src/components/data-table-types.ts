// The public TYPE surface of the configurable data table (data-table.ts). Split out as a
// dependency-light sibling so the component module stays under the size budget and the
// screens that only need the column/facet/state shapes can import them without pulling in
// the whole machine. Moved verbatim from data-table.ts; the declarations are unchanged, so
// the public surface is identical (data-table.ts re-exports every one of these by name).
//
// These are pure type declarations: no DOM, no runtime, no imports beyond the Child shape
// the cell renderer returns. House rules: Australian English, no em dashes, precise claims.

import type { ClientDiagBulkAction } from "../lib/client-diag/vocab.ts";
import type { Child } from "../lib/dom.ts";

// A column declaration ({ key, header, render, sortable, align,
// numeric, width }). `render` returns a Child added safely; `sortValue` provides the
// comparable for sorting (a number sorts numerically, a string case-insensitively);
// `filterText` provides extra text the /-filter matches beyond the rendered cell.
export interface DataColumn<Row> {
  key: string;
  header: string;
  render: (row: Row) => Child;
  align?: "left" | "right";
  numeric?: boolean; // tabular numerals + right align
  sortable?: boolean;
  // The comparable value for sorting this column. Omit on a non-sortable column.
  sortValue?: (row: Row) => string | number | null | undefined;
  // A column width hint (a CSS length), e.g. "1px" for a tight actions column.
  width?: string;
  // A screen-reader-only header (for a checkbox or an actions column).
  srOnlyHeader?: boolean;
}

// A faceted filter chip: a labelled toggle that narrows the set by a predicate (source
// type kv/r2/d1/secrets, status ok/failed/idle). Active facets reflect in the count and
// are clearable. The caller supplies the predicate so the table stays data-agnostic.
export interface Facet<Row> {
  id: string;
  label: string;
  predicate: (row: Row) => boolean;
  // An optional status tone for a leading dot (hue + shape, paired with the label).
  tone?: "ok" | "warn" | "danger" | "info" | "neutral" | "trust";
  // An optional dimension name. Facets sharing a group are OR-combined (a row matches ANY selected
  // value of that dimension); facets in different groups, and ungrouped facets, are AND-combined. Group
  // a set of MUTUALLY EXCLUSIVE values (status ok/failed, source type kv/r2/...) so selecting two of
  // them widens the set instead of ANDing to an impossible empty; leave orthogonal facets ungrouped.
  group?: string;
}

// A bulk action surfaced when rows are selected. `run` receives the selected rows; a
// DESTRUCTIVE action sets danger:true (the table styles it and the CALLER routes it
// through the safe confirm flow; the table never confirms or executes destructively
// itself). The table clears the selection after run() resolves unless keepSelection.
export interface BulkAction<Row> {
  id: string;
  label: string;
  danger?: boolean;
  run: (rows: Row[]) => void | Promise<void>;
  keepSelection?: boolean;
  // The closed bulk-action id for the console-diagnostics ring. Set it on an action whose loop can act on
  // fewer rows than the operator selected: the table drops the selection entries for rows that VANISHED on a
  // refresh (setRows, below), so a bulk delete of 20 can quietly delete 17, and every count the loop reports is
  // then self-consistent and wrong. With this set, the click records how many rows went missing before the loop
  // ran. Omit it on an action that opens a further surface rather than looping (Restore..., which keeps the
  // selection and hands off), where there is no loop to under-run.
  diagAction?: ClientDiagBulkAction;
}

export interface DataTableOptions<Row> {
  columns: Array<DataColumn<Row>>;
  rows: Row[];
  // A stable key per row (for selection, aria, and windowing identity).
  rowKey: (row: Row) => string;
  // The accessible caption / label for the table.
  label: string;
  // Open a detail (drawer) for a row. When set, rows are roving-tabindex focusable and
  // Enter/Space/click open the detail. A click on an inner control (checkbox, button,
  // link) is ignored so those keep their own behaviour.
  onRowActivate?: (row: Row) => void;

  // ---- toolbar features (all optional) ----
  // A /-focusable text filter over the loaded set. `placeholder` labels it; the table
  // matches the query against each row's rendered text + any column filterText.
  filter?: { placeholder: string; resultLabel?: string; getText?: (row: Row) => string };
  // Faceted chips. Facets sharing a Facet.group are OR-combined (any selected value of that dimension
  // matches); facets in different groups, and ungrouped facets, are AND-combined. Active facets narrow
  // the set and reflect in the count.
  facets?: Array<Facet<Row>>;
  // Multi-select with a header select-all (indeterminate aware) + per-row checkboxes +
  // a bulk-action bar. Provide the actions to enable it.
  bulkActions?: Array<BulkAction<Row>>;
  // A density toggle (comfortable | compact). Off by default; pass true to show it.
  density?: boolean;
  initialDensity?: "comfortable" | "compact";

  // ---- sort ----
  // The initial sort: a column key + direction. Omit for the natural row order.
  initialSort?: { key: string; dir: "asc" | "desc" };

  // ---- per-row selection label ----
  // A human-readable label for a row, used as the per-row checkbox aria-label:
  //   "Select <label>" (e.g. "Select uploads-prod").
  // When omitted the table derives it from the first column's rendered text, falling
  // back to the row index ("row N") if the first column has no extractable text, so the
  // label is always unique and context-free.
  rowLabel?: (row: Row) => string;

  // ---- deep-link hooks (the screen owns the URL; the table calls back) ----
  // Called whenever the filter/facets/sort change, so the screen can reflect state in
  // the query string. The
  // table never touches the URL itself.
  onStateChange?: (state: DataTableState) => void;
  // The initial state from the URL (the screen parses the query and passes it in).
  initialState?: Partial<DataTableState>;

  // ---- windowing ----
  // Render-all threshold. At or below this many (post-filter) rows, every row renders
  // (simpler, Ctrl-F works). Above it, a windowing viewport renders only visible rows
  // plus overscan. Default 150.
  windowThreshold?: number;
  // The fixed row height (px) used for windowing maths; must match the CSS row height
  // for the current density. Defaults are provided per density; override if the screen
  // customises row height.
  rowHeightComfortable?: number;
  rowHeightCompact?: number;
  // The windowed viewport height (px). Default 520.
  viewportHeight?: number;

  // ---- empty ----
  // The true-empty node (no rows at all). A filtered-to-empty state is rendered by the
  // table itself with a Clear control (so the operator never thinks data vanished).
  empty?: Node;
}

// The serialisable filter/sort state the screen reflects in the URL.
export interface DataTableState {
  query: string;
  facets: string[]; // active facet ids
  sortKey: string | null;
  sortDir: "asc" | "desc" | null;
}

// The handle the screen holds: the root element to mount, plus imperative controls to
// refresh rows (after a mutation), read/clear the selection, and read the live state.
export interface DataTableHandle<Row> {
  el: HTMLElement;
  setRows: (rows: Row[]) => void;
  getSelected: () => Row[];
  clearSelection: () => void;
  getState: () => DataTableState;
  // Focus the filter input (the "/" key handler in a screen can call this).
  focusFilter: () => void;
}
