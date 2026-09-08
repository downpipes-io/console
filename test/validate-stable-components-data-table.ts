// Group: components/data-table.ts -- the DOM behaviour of the configurable data table
// (the filter, the sortable headers, the roving-tabindex keyboard navigation, and the
// select-all tri-state header checkbox). The pure sub-function seams (the windowing maths,
// the sort comparator, and the bulk-action rejection guard) are already covered by
// validate-components-data-table.ts; this group renders the REAL component under the shared
// DOM shim and drives its interactive contract end to end.
//
// Drives the production component; it never re-implements any of the paths under test.

import { makeEvent } from "./dom-shim-core.ts";
import { qs as qsShim, qsa as qsaShim } from "./dom-shim.ts";
import { type Ctx, type Harness, attr, fireKeydown } from "./validate-stable-components-shared.ts";

// Fire a real 'change' event at a checkbox after toggling its checked state, mirroring how
// a browser delivers the input's change to the component's listener.
function fireChange(box: unknown): void {
  (box as { dispatchEvent(ev: unknown): boolean }).dispatchEvent(
    makeEvent({ type: "change", bubbles: true, cancelable: true }),
  );
}

interface DP { name: string; size: number }

export function runDataTable(h: Harness, ctx: Ctx): void {
  const { dataTable } = ctx;

  console.log("\n-- data-table (DOM behaviour) --");

  const rows: DP[] = [
    { name: "uploads", size: 30 },
    { name: "exports", size: 10 },
    { name: "archive", size: 20 },
  ];
  const columns = [
    { key: "name", header: "Name", render: (r: DP) => r.name },
    { key: "size", header: "Size", numeric: true, sortable: true, sortValue: (r: DP) => r.size, render: (r: DP) => r.size },
  ];

  // ---- filter narrows the rendered set ----
  {
    // A restored filter query is applied at first paint, so the rendered set is the
    // matching subset (no debounce timer to advance).
    const handle = dataTable<DP>({
      label: "Files",
      rowKey: (r) => r.name,
      columns,
      rows,
      filter: { placeholder: "Filter", resultLabel: "files" },
      initialState: { query: "arch", facets: [], sortKey: null, sortDir: null },
    });
    const bodyRows = qsaShim(handle.el, "tbody tr");
    h.eq(bodyRows.length, 1, "filter narrows the rendered rows to the single match");
    h.eq((qsShim(bodyRows[0]!, "td") as unknown as { textContent: string }).textContent, "archive", "the surviving row is the match");
    // Negative control: an empty query renders every row.
    const all = dataTable<DP>({
      label: "Files",
      rowKey: (r) => r.name,
      columns,
      rows,
      filter: { placeholder: "Filter", resultLabel: "files" },
    });
    h.eq(qsaShim(all.el, "tbody tr").length, 3, "no filter renders every row");
  }

  // ---- facets in the same group OR; different groups (and ungrouped) AND ----
  {
    type FR = { name: string; kind: "a" | "b"; size: number };
    const frows: FR[] = [
      { name: "r1", kind: "a", size: 30 },
      { name: "r2", kind: "b", size: 10 },
      { name: "r3", kind: "a", size: 20 },
      { name: "r4", kind: "b", size: 5 },
    ];
    const fcolumns = [{ key: "name", header: "Name", render: (r: FR) => r.name }];
    const facets = [
      { id: "kind-a", group: "kind", label: "A", predicate: (r: FR) => r.kind === "a" },
      { id: "kind-b", group: "kind", label: "B", predicate: (r: FR) => r.kind === "b" },
      { id: "big", label: "Big", predicate: (r: FR) => r.size > 15 },
    ];
    const render = (active: string[]): number => {
      const handle = dataTable<FR>({
        label: "Facets", rowKey: (r) => r.name, columns: fcolumns, rows: frows, facets,
        initialState: { query: "", facets: active, sortKey: null, sortDir: null },
      });
      return qsaShim(handle.el, "tbody tr").length;
    };
    // Two mutually-exclusive values of ONE dimension must OR to the union, never AND to empty (no row is
    // both kind a AND kind b), so this must render all four (kind a OR kind b).
    h.eq(render(["kind-a", "kind-b"]), 4, "two same-group facets OR to the union (never AND to empty)");
    // One group value alone: just that value.
    h.eq(render(["kind-a"]), 2, "one facet in a group narrows to that value (r1, r3)");
    // A group value AND an orthogonal ungrouped facet: the intersection (kind a AND big).
    h.eq(render(["kind-a", "big"]), 2, "a grouped facet AND an ungrouped facet intersect (kind a that is big: r1, r3)");
    // Both group values AND the ungrouped facet: (a OR b) AND big -> the big rows.
    h.eq(render(["kind-a", "kind-b", "big"]), 2, "same-group OR still ANDs across to the ungrouped facet (big a-or-b: r1, r3)");
    // An ungrouped facet alone keeps its plain narrowing behaviour.
    h.eq(render(["big"]), 2, "an ungrouped facet alone narrows by itself (size>15: r1, r3)");
  }

  // ---- sortable header cycles asc -> desc -> none ----
  {
    const handle = dataTable<DP>({
      label: "Files",
      rowKey: (r) => r.name,
      columns,
      rows,
    });
    const sortBtn = () => qsShim(handle.el, ".dt-sort")!;
    const sortedHeader = () => qsShim(handle.el, "th.dt-th--sortable")!;
    // First click: ascending.
    (sortBtn() as unknown as { click(): void }).click();
    h.eq(attr(sortedHeader(), "aria-sort"), "ascending", "first header click sorts ascending");
    {
      const firstName = (qsShim(qsaShim(handle.el, "tbody tr")[0]!, "td") as unknown as { textContent: string }).textContent;
      h.eq(firstName, "exports", "ascending puts the smallest size first (exports=10)");
    }
    // Second click: descending.
    (sortBtn() as unknown as { click(): void }).click();
    h.eq(attr(sortedHeader(), "aria-sort"), "descending", "second header click sorts descending");
    {
      const firstName = (qsShim(qsaShim(handle.el, "tbody tr")[0]!, "td") as unknown as { textContent: string }).textContent;
      h.eq(firstName, "uploads", "descending puts the largest size first (uploads=30)");
    }
    // Third click: none (back to the input order).
    (sortBtn() as unknown as { click(): void }).click();
    h.eq(attr(sortedHeader(), "aria-sort"), "none", "third header click clears the sort");
    {
      const firstName = (qsShim(qsaShim(handle.el, "tbody tr")[0]!, "td") as unknown as { textContent: string }).textContent;
      h.eq(firstName, "uploads", "cleared sort restores the input order (uploads first)");
    }
  }

  // ---- ArrowDown / ArrowUp move the roving tab stop ----
  {
    const handle = dataTable<DP>({
      label: "Files",
      rowKey: (r) => r.name,
      columns,
      rows,
      onRowActivate: () => {},
    });
    const bodyRows = () => qsaShim(handle.el, "tbody tr");
    // Exactly one row is the tab stop at first paint (the first row).
    h.eq(attr(bodyRows()[0]!, "tabindex"), "0", "first row is the initial tab stop");
    h.eq(attr(bodyRows()[1]!, "tabindex"), "-1", "second row is not the initial tab stop");
    // ArrowDown on the first row moves the stop to the second.
    fireKeydown(bodyRows()[0]!, "ArrowDown");
    h.eq(attr(bodyRows()[1]!, "tabindex"), "0", "ArrowDown moves the tab stop to the next row");
    h.eq(attr(bodyRows()[0]!, "tabindex"), "-1", "ArrowDown clears the old tab stop");
    // ArrowUp on the second row moves the stop back to the first.
    fireKeydown(bodyRows()[1]!, "ArrowUp");
    h.eq(attr(bodyRows()[0]!, "tabindex"), "0", "ArrowUp moves the tab stop back to the previous row");
  }

  // ---- select-all toggles the header checkbox indeterminate state ----
  {
    const handle = dataTable<DP>({
      label: "Files",
      rowKey: (r) => r.name,
      columns,
      rows,
      bulkActions: [{ id: "del", label: "Delete", run: async () => {} }],
    });
    const headBox = () => qsShim(handle.el, "thead .dt-check") as unknown as { checked: boolean; indeterminate: boolean };
    const rowBoxes = () => qsaShim(handle.el, "tbody .dt-check");
    h.ok("header box starts unchecked and determinate", headBox().checked === false && headBox().indeterminate === false);
    // Select-all: check the header box and fire change -> all selected, determinate.
    (headBox() as unknown as { checked: boolean }).checked = true;
    fireChange(qsShim(handle.el, "thead .dt-check"));
    h.ok("select-all checks the header box (all selected, not indeterminate)", headBox().checked === true && headBox().indeterminate === false);
    h.eq(handle.getSelected().length, 3, "select-all selects every visible row");
    // Deselect one row -> header goes indeterminate (some but not all selected).
    const firstRowBox = rowBoxes()[0]!;
    (firstRowBox as unknown as { checked: boolean }).checked = false;
    fireChange(firstRowBox);
    h.ok("deselecting one row sets the header box indeterminate", headBox().indeterminate === true && headBox().checked === false);
    h.eq(handle.getSelected().length, 2, "deselecting one leaves the rest selected");
  }
}
