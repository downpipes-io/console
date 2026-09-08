// A small, typed table primitive. Not the full
// sort/filter/virtualise machine (data-table.ts is that machine); this is the focused
// subset the ported screens need now: a real <table> with <th scope>, typed columns, a
// row-click that opens a detail drawer, and an empty slot. Numeric columns get tabular
// numerals and right alignment for a finance-grade read. Every cell value that is
// server-supplied goes in via textContent (the dom.ts default), so there is no
// markup-injection surface.

import { h, type Child } from "../lib/dom.ts";

export interface Column<Row> {
  key: string;
  header: string;
  // Render a cell for a row. Return a Node, string, or number; strings/numbers are
  // added as text nodes (safe). Keep server strings as text, never innerHTML.
  render: (row: Row) => Child;
  align?: "left" | "right";
  numeric?: boolean; // tabular numerals + right align
  // A screen-reader-only header is sometimes wanted for an actions column.
  srOnlyHeader?: boolean;
}

export interface TableOptions<Row> {
  columns: Array<Column<Row>>;
  rows: Row[];
  // Open a detail (drawer) for a row. When set, rows are keyboard-focusable and
  // Enter/Space/click open the detail (roving handled simply: each row is a button-
  // like <tr> with tabindex and a role). Kept simple and accessible.
  onRowActivate?: (row: Row) => void;
  // A stable key per row for aria and any future keying.
  rowKey: (row: Row) => string;
  // The accessible caption / label for the table.
  label: string;
  // An optional empty-state node shown when rows is empty.
  empty?: Node;
}

// buildTableHead builds the <thead> row with one <th scope="col"> per column (numeric columns
// get the right-align class; a screen-reader-only header renders a visually-hidden span).
function buildTableHead<Row>(opts: TableOptions<Row>): HTMLElement {
  const thead = h("thead");
  const headRow = h("tr");
  for (const col of opts.columns) {
    const numericCol = col.numeric || col.align === "right";
    const th = h("th", numericCol ? { scope: "col", class: "num" } : { scope: "col" });
    if (col.srOnlyHeader) th.appendChild(h("span", { class: "visually-hidden" }, col.header));
    else th.appendChild(document.createTextNode(col.header));
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  return thead;
}

// wireRowActivation makes a row button-like (focusable, role=button) and routes click +
// Enter/Space to opts.onRowActivate, ignoring events that originate on an inner control so
// those keep their own behaviour.
function wireRowActivation<Row>(tr: HTMLElement, row: Row, opts: TableOptions<Row>): void {
  tr.classList.add("dp-table__row--activatable");
  tr.setAttribute("tabindex", "0");
  tr.setAttribute("role", "button");
  const activate = () => opts.onRowActivate!(row);
  tr.addEventListener("click", (ev) => {
    // Ignore clicks that originate on an interactive control inside the row
    // (a switch, an overflow button), so those keep their own behaviour.
    if ((ev.target as HTMLElement).closest("button, a, input, select")) return;
    activate();
  });
  tr.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") {
      if ((ev.target as HTMLElement) !== tr) return; // let inner controls handle their keys
      ev.preventDefault();
      activate();
    }
  });
}

// buildTableBody builds the <tbody>: the empty slot when there are no rows, otherwise one row
// per record with its cells (and the activation wiring when onRowActivate is set).
function buildTableBody<Row>(opts: TableOptions<Row>): HTMLElement {
  const tbody = h("tbody");
  if (opts.rows.length === 0) {
    const tr = h("tr");
    const td = h("td", { colspan: String(opts.columns.length), class: "dp-table__empty" });
    if (opts.empty) td.appendChild(opts.empty);
    else td.appendChild(document.createTextNode("No rows."));
    tr.appendChild(td);
    tbody.appendChild(tr);
    return tbody;
  }
  for (const row of opts.rows) {
    const tr = h("tr", { dataset: { key: opts.rowKey(row) } });
    if (opts.onRowActivate) wireRowActivation(tr, row, opts);
    for (const col of opts.columns) {
      const numericCol = col.numeric || col.align === "right";
      const td = h("td", numericCol ? { class: "num" } : {});
      const cell = col.render(row);
      if (cell === null || cell === undefined || cell === false) {
        // empty cell
      } else if (typeof cell === "string" || typeof cell === "number") {
        td.appendChild(document.createTextNode(String(cell)));
      } else {
        td.appendChild(cell);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  return tbody;
}

export function table<Row>(opts: TableOptions<Row>): HTMLElement {
  const tableEl = h("table", { class: "dp-table", "aria-label": opts.label });
  tableEl.appendChild(buildTableHead(opts));
  tableEl.appendChild(buildTableBody(opts));

  // A horizontally-scrollable wrapper so dense tables scroll inside their region
  // rather than blowing out the grid. When rows are NOT
  // activatable there is no focusable child to scroll the clipped columns into
  // view, so the wrapper itself becomes a labelled, focusable region (WCAG 2.1.1);
  // activatable rows already scroll on focus.
  const wrap = h("div", { class: "dp-table-wrap" }, tableEl);
  if (!opts.onRowActivate) {
    wrap.setAttribute("tabindex", "0");
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", opts.label);
  }
  return wrap;
}
