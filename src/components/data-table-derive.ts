// The DERIVE-and-sort builders behind the configurable data table (data-table.ts): the
// filter -> facets -> sort pipeline (visibleRows), the /-filter match text (rowText), and
// the header sort cycle (cycleSort). Split out as a dependency-light sibling so the
// component module stays under the size budget. The bodies are moved verbatim from the
// dataTable() factory; the only change is reading the live state and callbacks through the
// shared ctx instead of the closure, so the move is behaviour-preserving.
//
// House rules: Australian English, no em dashes, precise claims.

import { cellText, compareCells } from "./data-table-helpers.ts";
import type { DataTableCtx } from "./data-table-context.ts";

// visibleRows derives the visible set (filter -> facets -> sort).
export function visibleRows<Row>(ctx: DataTableCtx<Row>): Row[] {
  const { opts } = ctx;
  let rows = ctx.allRows;
  const q = ctx.query.toLowerCase();
  if (q) {
    rows = rows.filter((r) => ctx.rowText(r).toLowerCase().includes(q));
  }
  if (ctx.activeFacets.size && opts.facets) {
    // Facets sharing a `group` are a single dimension whose selected values OR (a row matches if it is ANY
    // of them); different groups, and each ungrouped facet, AND. So selecting two mutually-exclusive values
    // of one dimension (status ok + failed) widens the set to their union rather than ANDing to an
    // impossible empty, while orthogonal facets keep narrowing. A row passes when every group has at
    // least one matching selected value AND every ungrouped facet matches.
    const active = opts.facets.filter((f) => ctx.activeFacets.has(f.id));
    const groups = new Map<string, Array<(r: Row) => boolean>>();
    const ungrouped: Array<(r: Row) => boolean> = [];
    for (const f of active) {
      if (f.group !== undefined) {
        const g = groups.get(f.group);
        if (g) g.push(f.predicate);
        else groups.set(f.group, [f.predicate]);
      } else {
        ungrouped.push(f.predicate);
      }
    }
    const groupPredicates = [...groups.values()];
    rows = rows.filter(
      (r) => ungrouped.every((p) => p(r)) && groupPredicates.every((preds) => preds.some((p) => p(r))),
    );
  }
  if (ctx.sortKey && ctx.sortDir) {
    const col = opts.columns.find((c) => c.key === ctx.sortKey);
    if (col?.sortValue) {
      const sv = col.sortValue;
      rows = rows.slice().sort((a, b) => compareCells(sv(a), sv(b)) * (ctx.sortDir === "asc" ? 1 : -1));
    }
  }
  return rows;
}

// rowText is what the /-filter matches: the caller's getText if provided, else a
// concatenation of the rendered cell text (so the filter matches what is on screen).
// The rendered-column path is cached per row (ctx.rowTextCache) so a filter keystroke
// reuses the extract instead of re-rendering every cell on every pass; the cache is
// replaced wholesale by setRows() so a stale row never survives a reload.
export function rowText<Row>(ctx: DataTableCtx<Row>, row: Row): string {
  if (ctx.opts.filter?.getText) return ctx.opts.filter.getText(row);
  if (row !== null && typeof row === "object") {
    const cached = ctx.rowTextCache.get(row);
    if (cached !== undefined) return cached;
    const text = ctx.opts.columns.map((c) => cellText(c.render(row))).join(" ");
    ctx.rowTextCache.set(row, text);
    return text;
  }
  return ctx.opts.columns.map((c) => cellText(c.render(row))).join(" ");
}

// cycleSort cycles asc -> desc -> none for the clicked column.
export function cycleSort<Row>(ctx: DataTableCtx<Row>, key: string): void {
  if (ctx.sortKey !== key) {
    ctx.sortKey = key;
    ctx.sortDir = "asc";
  } else if (ctx.sortDir === "asc") {
    ctx.sortDir = "desc";
  } else if (ctx.sortDir === "desc") {
    ctx.sortKey = null;
    ctx.sortDir = null;
  } else {
    ctx.sortDir = "asc";
  }
  ctx.onChange();
}
