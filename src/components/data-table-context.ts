// The shared INTERNALS context for the configurable data table (data-table.ts). The
// dataTable() factory is one closure whose inner builders all read and write the same
// live state (the loaded rows, the density, the query, the selection, the roving stop)
// and call across to one another (render -> buildRow -> refreshBulkBar -> render). To keep
// each builder in its own dependency-light sibling without rewriting any logic, the factory
// hands every builder this single mutable context object: the builders read and assign its
// fields exactly as the original inner functions read and assigned the closure variables,
// so the move is behaviour-preserving.
//
// No DOM is constructed at import time. House rules: Australian English, no em dashes,
// precise claims.

import type { DataTableOptions, DataTableState } from "./data-table-types.ts";

// DataTableCtx is the mutable internals the builders share. Fields that were `let` in the
// factory closure stay mutable here (the builders assign them); fields that were `const`
// (the derived sizes, the Sets, the DOM nodes) are readonly. The cross-group callbacks
// (render, onChange, getState, and the per-builder helpers) are assigned once during
// wiring so a builder can call across without importing its sibling at module scope.
export interface DataTableCtx<Row> {
  readonly opts: DataTableOptions<Row>;

  // ---- derived sizing (const in the factory) ----
  readonly winThreshold: number;
  readonly rowHComfortable: number;
  readonly rowHCompact: number;
  readonly viewportH: number;
  readonly selectable: boolean;
  readonly totalCols: number;

  // ---- live state (let in the factory) ----
  allRows: Row[];
  density: "comfortable" | "compact";
  query: string;
  readonly activeFacets: Set<string>;
  sortKey: string | null;
  sortDir: "asc" | "desc" | null;
  readonly selected: Set<string>;
  // How many rows have silently vanished from the live selection since the operator last touched it. The
  // table drops the selection entry for a row that no longer exists (setRows), which is correct rendering and a
  // silent under-run of the next bulk loop: 20 selected, a background refresh lands, 17 acted on, and every
  // count the loop reports agrees with itself. This counts the drop so the bulk-bar click can record it. It is
  // reset whenever the selection is cleared, which is what keeps the LEGITIMATE drop (the rows a successful bulk
  // delete correctly removed) from ever being read as a fault.
  droppedSelections: number;
  // The roving-tabindex active row, tracked BY KEY (not index) so the stop survives
  // windowed slice swaps, sorting and filtering. null = first row.
  activeRowKey: string | null;
  filterInput: HTMLInputElement | null;
  // Per-row cache of the rendered-column filter text so a filter keystroke does not
  // re-render every cell of every row. Keyed by row identity; populated lazily on the
  // first miss and replaced wholesale when setRows() loads a new row set. Unused when
  // opts.filter.getText is supplied (that path is already cheap).
  rowTextCache: WeakMap<object, string>;

  // ---- DOM scaffolding (const in the factory) ----
  readonly root: HTMLElement;
  readonly toolbar: HTMLElement;
  readonly bulkBar: HTMLElement;
  readonly tableWrap: HTMLElement;
  readonly countEl: HTMLElement;

  // ---- cross-group callbacks (wired once after construction) ----
  render: () => void;
  onChange: () => void;
  getState: () => DataTableState;
  visibleRows: () => Row[];
  rowText: (row: Row) => string;
  announceCount: (live: HTMLElement, phrase: string) => void;
  buildThead: (rows: Row[]) => HTMLElement;
  buildRow: (row: Row, index: number, rows: Row[]) => HTMLElement;
  syncHeaderCheckbox: (rows: Row[]) => void;
  refreshBulkBar: () => void;
  wireRovingKeys: (tbody: HTMLElement, rows: Row[]) => void;
  focusRow: (index: number, rows: Row[], tbody: HTMLElement) => void;
  applyToolbarVisibility: () => void;
}
