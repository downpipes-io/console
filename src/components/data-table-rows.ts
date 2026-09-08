// The HEADER and ROW builders behind the configurable data table (data-table.ts):
// buildThead (the column headers with the select-all box and sortable sort buttons),
// buildRow (a data row with its roving-tabindex activation, the per-row checkbox, and the
// cells), and syncHeaderCheckbox (the header tri-state recompute). Split out as a
// dependency-light sibling so the component module stays under the size budget. The bodies
// are moved verbatim from the dataTable() factory; the only change is reading the live
// state and callbacks through the shared ctx instead of the closure, so the move is
// behaviour-preserving.
//
// House rules: Australian English, no em dashes, precise claims.

import { h } from "../lib/dom.ts";
import { appendCell, cellText } from "./data-table-helpers.ts";
import { cycleSort } from "./data-table-derive.ts";
import type { DataTableCtx } from "./data-table-context.ts";

export function buildThead<Row>(ctx: DataTableCtx<Row>, rows: Row[]): HTMLElement {
  const { opts, selectable } = ctx;
  const thead = h("thead");
  const headRow = h("tr");

  if (selectable) {
    const th = h("th", { scope: "col", class: "dt-col-check" });
    const allKeys = rows.map(opts.rowKey);
    const selectedVisible = allKeys.filter((k) => ctx.selected.has(k)).length;
    const allSelected = allKeys.length > 0 && selectedVisible === allKeys.length;
    const someSelected = selectedVisible > 0 && !allSelected;
    const box = h("input", { "data-dp": "components-data-table-rows.checkbox.box#1",
      type: "checkbox",
      class: "dt-check",
      "aria-label": "Select all rows",
    }) as HTMLInputElement;
    box.checked = allSelected;
    box.indeterminate = someSelected;
    box.addEventListener("change", () => {
      if (box.checked) for (const k of allKeys) ctx.selected.add(k);
      else for (const k of allKeys) ctx.selected.delete(k);
      ctx.render(); // re-render to update per-row boxes + the bulk bar
    });
    th.appendChild(box);
    headRow.appendChild(th);
  }

  for (const col of opts.columns) {
    const numericCol = col.numeric || col.align === "right";
    const th = h("th", { scope: "col", ...(numericCol ? { class: "num" } : {}) });
    if (col.width) th.style.width = col.width;

    if (col.sortable && col.sortValue) {
      const isSorted = ctx.sortKey === col.key;
      const dir = isSorted ? ctx.sortDir : null;
      th.setAttribute("aria-sort", dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none");
      const btn = h(
        "button",
        { "data-dp": "components-data-table-rows.button.cycle-sort", class: "dt-sort", type: "button" },
        col.srOnlyHeader ? h("span", { class: "visually-hidden" }, col.header) : document.createTextNode(col.header),
        h("span", { class: "dt-sort__caret", "aria-hidden": "true" }),
      );
      btn.addEventListener("click", () => cycleSort(ctx, col.key));
      th.appendChild(btn);
      th.classList.add("dt-th--sortable");
    } else {
      if (col.srOnlyHeader) th.appendChild(h("span", { class: "visually-hidden" }, col.header));
      else th.appendChild(document.createTextNode(col.header));
    }
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  return thead;
}

export function buildRow<Row>(ctx: DataTableCtx<Row>, row: Row, index: number, rows: Row[]): HTMLElement {
  const { opts, selectable } = ctx;
  const key = opts.rowKey(row);
  const tr = h("tr", { dataset: { key } });
  const isSelected = ctx.selected.has(key);
  if (isSelected) tr.setAttribute("aria-selected", "true");

  if (opts.onRowActivate) {
    tr.classList.add("dp-table__row--activatable");
    // Roving tabindex: exactly one row is the tab stop (the active one, or the first).
    const isActiveStop = ctx.activeRowKey === null ? index === 0 : key === ctx.activeRowKey;
    tr.setAttribute("tabindex", isActiveStop ? "0" : "-1");
    tr.setAttribute("role", "button");
    const activate = () => opts.onRowActivate!(row);
    tr.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest("button, a, input, select, label")) return;
      ctx.activeRowKey = key;
      activate();
    });
    tr.addEventListener("keydown", (ev: KeyboardEvent) => {
      if ((ev.key === "Enter" || ev.key === " ") && (ev.target as HTMLElement) === tr) {
        ev.preventDefault();
        ctx.activeRowKey = key;
        activate();
      }
    });
  }

  if (selectable) {
    const td = h("td", { class: "dt-col-check" });
    // Derive a unique, context-full label for this row's checkbox. The caller may
    // supply rowLabel; otherwise the table extracts the first column's rendered text
    // (the primary identifier visible on screen). If that yields an empty string, fall
    // back to a stable positional label ("row N") so the name is at least unique.
    const rowLabelText = opts.rowLabel
      ? opts.rowLabel(row)
      : (() => {
          const firstCol = opts.columns[0];
          const text = firstCol ? cellText(firstCol.render(row)) : "";
          return text.trim() !== "" ? text.trim() : `row ${index + 1}`;
        })();
    const box = h("input", { "data-dp": "components-data-table-rows.checkbox.box#2",
      type: "checkbox",
      class: "dt-check",
      "aria-label": `Select ${rowLabelText}`,
    }) as HTMLInputElement;
    box.checked = isSelected;
    box.addEventListener("change", () => {
      if (box.checked) ctx.selected.add(key);
      else ctx.selected.delete(key);
      if (box.checked) tr.setAttribute("aria-selected", "true");
      else tr.removeAttribute("aria-selected");
      // Update the header tri-state + the bulk bar without a full re-render (keeps
      // checkbox focus); recompute against the current visible set.
      ctx.syncHeaderCheckbox(rows);
      ctx.refreshBulkBar();
    });
    td.appendChild(box);
    tr.appendChild(td);
  }

  for (const col of opts.columns) {
    const numericCol = col.numeric || col.align === "right";
    // data-label carries the column header so the responsive card layout (tokens.css §20c, ≤1023) can render
    // it as the row-stacked cell's inline label (td::before) once the thead is visually hidden. Inert on the
    // wide/table layout. Skipped for an empty header (e.g. an actions column) so no stray label renders.
    const td = h("td", { ...(numericCol ? { class: "num" } : {}), ...(col.header ? { dataset: { label: col.header } } : {}) });
    const cell = col.render(row);
    appendCell(td, cell);
    tr.appendChild(td);
  }
  return tr;
}

export function syncHeaderCheckbox<Row>(ctx: DataTableCtx<Row>, rows: Row[]): void {
  const box = ctx.tableWrap.querySelector<HTMLInputElement>("thead .dt-check");
  if (!box) return;
  const allKeys = rows.map(ctx.opts.rowKey);
  const selectedVisible = allKeys.filter((k) => ctx.selected.has(k)).length;
  const allSelected = allKeys.length > 0 && selectedVisible === allKeys.length;
  box.checked = allSelected;
  box.indeterminate = selectedVisible > 0 && !allSelected;
}
