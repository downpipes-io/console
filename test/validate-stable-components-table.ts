// Group: components/table.ts -- header semantics, numeric alignment, the empty
// slot, and row activation (click + Enter + Space) with the inner-control guard.
//
// Drives the REAL table component under the shared DOM shim; never re-implements it.

import { qs, qsa, textOf, classesOf } from "./dom-shim.ts";
import { type Ctx, type Harness, attr, click, fireKeydown } from "./validate-stable-components-shared.ts";

export function runTable(h: Harness, ctx: Ctx): void {
  const { h: hEl, table } = ctx;

  // =========================================================================
  // 3. components/table.ts -- header semantics, numeric alignment, empty, rows
  // =========================================================================
  console.log("\n-- table --");
  interface DP { name: string; records: number }
  {
    const rows: DP[] = [
      { name: "uploads", records: 1200 },
      { name: "exports", records: 34 },
    ];
    let activated: DP | null = null;
    const wrap = table<DP>({
      label: "Downpipes",
      rowKey: (r) => r.name,
      columns: [
        { key: "name", header: "Name", render: (r) => r.name },
        { key: "records", header: "Records", numeric: true, render: (r) => r.records },
      ],
      rows,
      onRowActivate: (r) => { activated = r; },
    });

    const tableEl = qs(wrap, "table")!;
    h.eq(attr(tableEl, "aria-label"), "Downpipes", "table carries the accessible label");
    const ths = qsa(wrap, "th");
    h.eq(ths.length, 2, "two header cells");
    h.ok("every th has scope=col", ths.every((th) => attr(th, "scope") === "col"));
    h.ok("numeric header gets the num class (right alignment)", classesOf(ths[1]).includes("num"));
    h.ok("non-numeric header has no num class", !classesOf(ths[0]).includes("num"));

    const bodyRows = qsa(qs(wrap, "tbody"), "tr");
    h.eq(bodyRows.length, 2, "two body rows");
    h.ok("an activatable row is a role=button with tabindex 0", attr(bodyRows[0], "role") === "button" && attr(bodyRows[0], "tabindex") === "0");

    // Row activation by click, Enter, and Space.
    click(bodyRows[0]);
    h.eq(activated && (activated as DP).name, "uploads", "row click activates the row");
    activated = null;
    fireKeydown(bodyRows[1], "Enter");
    h.eq(activated && (activated as DP).name, "exports", "Enter activates the focused row");
    activated = null;
    fireKeydown(bodyRows[0], " ");
    h.eq(activated && (activated as DP).name, "uploads", "Space activates the focused row");

    // A numeric cell carries the num class.
    const recordCell = qsa(bodyRows[0], "td")[1]!;
    h.ok("numeric cell gets the num class", classesOf(recordCell).includes("num"));
  }
  {
    // Empty state.
    const wrap = table<DP>({
      label: "Empty",
      rowKey: (r) => r.name,
      columns: [{ key: "name", header: "Name", render: (r) => r.name }],
      rows: [],
    });
    const emptyTd = qs(wrap, ".dp-table__empty");
    h.ok("empty table renders the empty slot", emptyTd !== null);
    h.eq(textOf(emptyTd), "No rows.", "default empty text");
    // A non-activatable row is not present (no onRowActivate => no rows + no role=button).
    h.ok("empty table has no activatable rows", qsa(wrap, "[role=button]").length === 0);
  }
  {
    // A click that originates on an inner control must NOT activate the row.
    let activated = false;
    const wrap = table<DP>({
      label: "Inner",
      rowKey: (r) => r.name,
      columns: [
        { key: "name", header: "Name", render: (r) => r.name },
        { key: "act", header: "Action", srOnlyHeader: true, render: () => hEl("button", { type: "button" }, "Toggle") },
      ],
      rows: [{ name: "x", records: 1 }],
      onRowActivate: () => { activated = true; },
    });
    const innerBtn = qs(wrap, "button")!;
    click(innerBtn); // closest("button,...") matches the button -> row activation skipped
    h.ok("a click on an inner control does NOT activate the row", activated === false);
    // The sr-only header still emits the header text in a visually-hidden span.
    h.ok("sr-only header renders a visually-hidden span", qsa(wrap, ".visually-hidden").length >= 1);
  }
}
