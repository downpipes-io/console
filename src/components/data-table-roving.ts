// The ROVING-tabindex keyboard navigation behind the configurable data table
// (data-table.ts): wireRovingKeys (the ArrowUp/Down + Home/End handler that moves the one
// tab stop) and focusRow (which moves the tab stop and focus to a row,
// scrolling a windowed off-screen row into view first). Split out as a dependency-light
// sibling so the component module stays under the size budget. The bodies are moved
// verbatim from the dataTable() factory; the only change is reading the live state and
// callbacks through the shared ctx instead of the closure, so the move is
// behaviour-preserving.
//
// House rules: Australian English, no em dashes, precise claims.

import { cssEscape } from "./data-table-helpers.ts";
import type { DataTableCtx } from "./data-table-context.ts";

// wireRovingKeys installs one keydown handler on the tbody so ArrowUp/Down + Home/End
// move the active row (one tab stop). For the plain path it is
// called each render on a fresh tbody. For the windowed path it is called once on the
// persistent tbody (outside paint()) and the closure captures the live rows array so it
// stays correct as paint() swaps the slice. A rowKey to index Map is built once per call
// so each keydown is an O(1) lookup rather than a full scan.
export function wireRovingKeys<Row>(ctx: DataTableCtx<Row>, tbody: HTMLElement, rows: Row[]): void {
  const { opts } = ctx;
  if (!opts.onRowActivate) return;
  const indexByKey = new Map<string, number>();
  rows.forEach((r, i) => {
    indexByKey.set(opts.rowKey(r), i);
  });
  tbody.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "Home" && ev.key !== "End") return;
    const current = (ev.target as HTMLElement).closest("tr");
    if (!current || current.classList.contains("dt-spacer")) return;
    const key = current.dataset.key;
    if (key === undefined) return;
    const idx = indexByKey.get(key);
    if (idx === undefined || idx < 0) return;
    let next = idx;
    if (ev.key === "ArrowDown") next = Math.min(rows.length - 1, idx + 1);
    else if (ev.key === "ArrowUp") next = Math.max(0, idx - 1);
    else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = rows.length - 1;
    if (next === idx) return;
    ev.preventDefault();
    ctx.activeRowKey = opts.rowKey(rows[next]!);
    ctx.focusRow(next, rows, tbody);
  });
}

// focusRow moves the tab stop + focus to row `index`. In the windowed body the row
// may not be mounted; we scroll it into view then focus on the next frame.
export function focusRow<Row>(ctx: DataTableCtx<Row>, index: number, rows: Row[], tbody: HTMLElement): void {
  const { opts } = ctx;
  const targetKey = opts.rowKey(rows[index]!);
  const found = tbody.querySelector<HTMLElement>(`tr[data-key="${cssEscape(targetKey)}"]`);
  // Clear the old stop.
  tbody.querySelectorAll<HTMLElement>('tr[tabindex="0"]').forEach((t) => {
    t.setAttribute("tabindex", "-1");
  });
  if (found) {
    found.setAttribute("tabindex", "0");
    found.focus();
  } else {
    // Windowed and off-screen: scroll the viewport so the row paints, then focus.
    const viewport = ctx.root.querySelector<HTMLElement>(".dt-viewport");
    if (viewport) {
      const rowH = ctx.density === "compact" ? ctx.rowHCompact : ctx.rowHComfortable;
      viewport.scrollTop = Math.max(0, index * rowH - ctx.viewportH / 2);
      requestAnimationFrame(() => {
        const reFound = tbody.querySelector<HTMLElement>(`tr[data-key="${cssEscape(targetKey)}"]`);
        if (reFound) {
          tbody.querySelectorAll<HTMLElement>('tr[tabindex="0"]').forEach((t) => {
            t.setAttribute("tabindex", "-1");
          });
          reFound.setAttribute("tabindex", "0");
          reFound.focus();
        }
      });
    }
  }
}
