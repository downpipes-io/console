// The configurable DATA TABLE. One typed table machine the
// dense screens compose: a /-focusable filter, faceted chips, sortable headers with a
// caret + aria-sort, multi-select with a select-all-visible indeterminate header box,
// a bulk-action bar that appears on selection, a comfortable/compact density toggle,
// roving-tabindex row navigation, and large-list windowing past a threshold. It is a
// SUPERSET of the focused table.ts primitive (which the already-ported screens use and
// which stays untouched); a screen reaches for this when it needs sort/select/bulk and
// for the simple read it keeps table().
//
// Honesty + safety carried through: every cell value is server-supplied via Child and
// added with textContent (dom.ts), so there is no markup-injection surface; a bulk
// DESTRUCTIVE action is the caller's to route through the safe confirm flow (the table
// only surfaces the action button and the selected count, it never executes a
// destructive write itself). Numeric columns get tabular numerals + right alignment
// for a finance-grade read.
//
// Accessibility: a real <table> with <th scope="col">; aria-sort on the sorted header
// and the sort control is a real <button> inside the th; roving tabindex on the body
// rows (one tab stop, ArrowUp/Down + Home/End move the active row, Enter/Space opens
// the detail) so a long table is one tab stop, not hundreds; the filter is a labelled
// search input; the select-all checkbox exposes its indeterminate state; the bulk bar
// is a polite live region announced when it appears; the windowed body maintains
// aria-rowcount + aria-rowindex so assistive tech reports the true totals. Density is a
// data-density attribute the token CSS scales from. Built from dom.ts + tokens.css.
//
// STRUCTURE: this module owns the factory's lifecycle (the live state, the DOM
// scaffolding, the imperative handle) and delegates each cohesive group of builders to a
// dependency-light sibling that reads the shared internals through a single ctx object:
// derive/sort (data-table-derive.ts), header/rows (data-table-rows.ts), roving keys
// (data-table-roving.ts), the bulk bar (data-table-bulkbar.ts), the render path
// (data-table-render.ts), and the toolbar (data-table-toolbar.ts). The split is
// behaviour-preserving: the bodies moved verbatim, reading the closure variables through
// ctx instead. The pure helpers and the type surface stay in their existing siblings.

import { h } from "../lib/dom.ts";
import type {
  DataTableOptions,
  DataTableHandle,
  DataTableState,
} from "./data-table-types.ts";
import type { DataTableCtx } from "./data-table-context.ts";
import { visibleRows, rowText } from "./data-table-derive.ts";
import { buildThead, buildRow, syncHeaderCheckbox } from "./data-table-rows.ts";
import { wireRovingKeys, focusRow } from "./data-table-roving.ts";
import { refreshBulkBar } from "./data-table-bulkbar.ts";
import { render, announceCount } from "./data-table-render.ts";
import { buildToolbar, applyToolbarVisibility } from "./data-table-toolbar.ts";

// The type surface lives in the dependency-light sibling data-table-types.ts; re-export it
// by name so a screen can import the shapes straight from this module, exactly as before.
export type {
  DataColumn,
  Facet,
  BulkAction,
  DataTableOptions,
  DataTableState,
  DataTableHandle,
} from "./data-table-types.ts";
// The pure test seams live in data-table-helpers.ts; re-export them by name so the
// validator keeps importing them from this module (the public surface is unchanged).
export { _testWindowSlice, _testCompareCells, _testBulkActionRejection } from "./data-table-helpers.ts";

export function dataTable<Row>(opts: DataTableOptions<Row>): DataTableHandle<Row> {
  const winThreshold = opts.windowThreshold ?? 150;
  const rowHComfortable = opts.rowHeightComfortable ?? 49;
  const rowHCompact = opts.rowHeightCompact ?? 37;
  const viewportH = opts.viewportHeight ?? 520;

  const density: "comfortable" | "compact" = opts.initialDensity ?? "comfortable";
  const selectable = (opts.bulkActions?.length ?? 0) > 0;
  const totalCols = opts.columns.length + (selectable ? 1 : 0);

  // ---- root scaffolding ----
  const root = h("div", { class: "data-table" });
  root.dataset.density = density;

  const toolbar = h("div", { class: "dt-toolbar" });
  const bulkBar = h("div", { class: "dt-bulkbar", role: "status", "aria-live": "polite", hidden: true });
  const tableWrap = h("div", { class: "dp-table-wrap dt-wrap" });
  // Horizontal scroll access for keyboard users (WCAG 2.1.1): when rows are not
  // activatable there is no focusable child whose focus scrolls clipped columns
  // into view, so the wrap itself is a labelled, focusable region.
  if (!opts.onRowActivate) {
    tableWrap.setAttribute("tabindex", "0");
    tableWrap.setAttribute("role", "region");
    tableWrap.setAttribute("aria-label", opts.label);
  }

  // countEl is also the polite live region for the result count (WCAG 4.1.3). The
  // role="status" + aria-live="polite" make every update to its text content announced
  // to assistive tech. It doubles as the visible hint, so a single element carries both
  // roles and there is no dead/duplicate live region.
  const countEl = h("span", { class: "dt-count field__hint", role: "status", "aria-live": "polite" });

  // The shared internals every builder reads and writes. The fields that were `let` in
  // the old single closure (allRows, density, query, sortKey, sortDir, activeRowKey,
  // filterInput) stay mutable; the builders assign them exactly as before. The callbacks
  // are wired immediately below so a builder can call across to a sibling.
  const ctx: DataTableCtx<Row> = {
    opts,
    winThreshold,
    rowHComfortable,
    rowHCompact,
    viewportH,
    selectable,
    totalCols,
    allRows: opts.rows.slice(),
    density,
    query: opts.initialState?.query ?? "",
    activeFacets: new Set<string>(opts.initialState?.facets ?? []),
    sortKey: opts.initialState?.sortKey ?? opts.initialSort?.key ?? null,
    sortDir: opts.initialState?.sortDir ?? opts.initialSort?.dir ?? null,
    selected: new Set<string>(),
    droppedSelections: 0,
    activeRowKey: null,
    filterInput: null,
    rowTextCache: new WeakMap<object, string>(),
    root,
    toolbar,
    bulkBar,
    tableWrap,
    countEl,
    // The callbacks are filled in just below (declared here so the shape is complete).
    render: () => {},
    onChange: () => {},
    getState,
    visibleRows: () => visibleRows(ctx),
    rowText: (row) => rowText(ctx, row),
    announceCount,
    buildThead: (rows) => buildThead(ctx, rows),
    buildRow: (row, index, rows) => buildRow(ctx, row, index, rows),
    syncHeaderCheckbox: (rows) => syncHeaderCheckbox(ctx, rows),
    refreshBulkBar: () => refreshBulkBar(ctx),
    wireRovingKeys: (tbody, rows) => wireRovingKeys(ctx, tbody, rows),
    focusRow: (index, rows, tbody) => focusRow(ctx, index, rows, tbody),
    applyToolbarVisibility: () => applyToolbarVisibility(ctx),
  };
  ctx.render = () => render(ctx);
  ctx.onChange = onChange;

  buildToolbar(ctx);

  root.appendChild(toolbar);
  if (selectable) root.appendChild(bulkBar);
  root.appendChild(tableWrap);

  // onChange re-renders and notifies the screen so it can reflect state in the URL.
  function onChange(): void {
    ctx.activeRowKey = null; // a filter/sort change resets the roving stop to the first row
    applyToolbarVisibility(ctx);
    render(ctx);
    opts.onStateChange?.(getState());
  }

  function getState(): DataTableState {
    return { query: ctx.query, facets: [...ctx.activeFacets], sortKey: ctx.sortKey, sortDir: ctx.sortDir };
  }

  // First paint.
  applyToolbarVisibility(ctx);
  render(ctx);

  return {
    el: root,
    setRows(rows: Row[]): void {
      ctx.allRows = rows.slice();
      // A fresh row set invalidates the rendered-column filter cache.
      ctx.rowTextCache = new WeakMap<object, string>();
      // Drop selections for rows that no longer exist.
      //
      // Count the drop. This is the site where "I selected 20 downpipes but only 17 were acted on" is
      // born: a background refresh lands between the operator ticking the rows and clicking the action, the
      // vanished rows leave the selection, and the loop then runs over the survivors and reports counts that are
      // perfectly self-consistent. Nothing was ever wrong-looking, in the console or in the pack.
      //
      // The count is not recorded HERE, deliberately. A drop is not a fault on its own: the drop that follows a
      // successful bulk delete is the rows correctly going away, and recording it would fire on every healthy
      // bulk delete in the product. It is recorded only if the operator then CLICKS a bulk action with rows
      // already missing (data-table-bulkbar.ts), and the counter is reset the moment the selection is cleared.
      const live = new Set(ctx.allRows.map(opts.rowKey));
      for (const k of [...ctx.selected]) {
        if (!live.has(k)) {
          ctx.selected.delete(k);
          ctx.droppedSelections++;
        }
      }
      applyToolbarVisibility(ctx);
      render(ctx);
    },
    getSelected(): Row[] {
      return ctx.allRows.filter((r) => ctx.selected.has(opts.rowKey(r)));
    },
    clearSelection(): void {
      ctx.selected.clear();
      ctx.droppedSelections = 0;
      render(ctx);
    },
    getState,
    focusFilter(): void {
      ctx.filterInput?.focus();
    },
  };
}
