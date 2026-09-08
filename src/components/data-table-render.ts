// The RENDER builders behind the configurable data table (data-table.ts): render (the
// filtered-vs-total count + the empty/plain/windowed branch), announceCount (the polite
// live-region re-announce), renderPlain (every row), renderWindowed (the visible slice +
// overscan with honest aria-rowcount), and the two empty nodes (filteredEmptyNode,
// defaultEmpty). Split out as a dependency-light sibling so the component module stays
// under the size budget. The bodies are moved verbatim from the dataTable() factory; the
// only change is reading the live state and callbacks through the shared ctx instead of
// the closure, so the move is behaviour-preserving.
//
// House rules: Australian English, no em dashes, precise claims.

import { h, clear } from "../lib/dom.ts";
import { _testWindowSlice } from "./data-table-helpers.ts";
import type { DataTableCtx } from "./data-table-context.ts";

export function render<Row>(ctx: DataTableCtx<Row>): void {
  const { opts, tableWrap, countEl } = ctx;
  const rows = ctx.visibleRows();
  // The result count (filtered vs total). announceCount clears then sets on a tick
  // so a repeated identical phrase (e.g. two identical filter queries) is still
  // announced by the live region (WCAG 4.1.3). The pattern mirrors command-palette.ts.
  const total = ctx.allRows.length;
  const label = opts.filter?.resultLabel ?? "rows";
  const phrase = rows.length === total ? `${total} ${label}` : `${rows.length} of ${total} ${label}`;
  ctx.announceCount(countEl, phrase);

  clear(tableWrap);

  // True-empty (no rows at all) vs filtered-to-empty (rows exist, none match).
  if (total === 0) {
    tableWrap.appendChild(opts.empty ?? defaultEmpty());
    return;
  }
  if (rows.length === 0) {
    ctx.announceCount(countEl, `0 of ${total} ${label}`);
    tableWrap.appendChild(filteredEmptyNode(ctx));
    return;
  }

  // Past the threshold a windowing viewport renders only the visible slice plus
  // overscan; at or below it every row renders (simpler, Ctrl-F works).
  if (rows.length > ctx.winThreshold) {
    tableWrap.appendChild(renderWindowed(ctx, rows));
  } else {
    tableWrap.appendChild(renderPlain(ctx, rows));
  }
  ctx.refreshBulkBar();
}

// announceCount clears then sets the live region text on a microtask so a repeated
// identical phrase is still announced by the polite live region (a DOM no-change is
// not announced). Mirrors the same pattern in command-palette.ts (announceCount).
export function announceCount(live: HTMLElement, phrase: string): void {
  live.textContent = "";
  window.setTimeout(() => { live.textContent = phrase; }, 30);
}

// renderPlain renders every row (the under-threshold path; Ctrl-F works, simplest a11y).
export function renderPlain<Row>(ctx: DataTableCtx<Row>, rows: Row[]): HTMLElement {
  const { opts } = ctx;
  const tableEl = h("table", { class: "dp-table", "aria-label": opts.label });
  tableEl.appendChild(ctx.buildThead(rows));
  const tbody = h("tbody");
  rows.forEach((row, i) => {
    tbody.appendChild(ctx.buildRow(row, i, rows));
  });
  // The active key may have been filtered or sorted away: guarantee exactly one
  // tab stop remains (the windowed paint() applies the same guard).
  if (opts.onRowActivate && !tbody.querySelector('tr[data-key][tabindex="0"]')) {
    tbody.querySelector<HTMLElement>("tr[data-key]")?.setAttribute("tabindex", "0");
  }
  tableEl.appendChild(tbody);
  ctx.wireRovingKeys(tbody, rows);
  return tableEl;
}

// renderWindowed renders only the visible slice plus overscan inside a full-height
// spacer, maintaining aria-rowcount / aria-rowindex so assistive tech reports the
// true totals. A scroll handler swaps the slice.
export function renderWindowed<Row>(ctx: DataTableCtx<Row>, rows: Row[]): HTMLElement {
  const { opts, totalCols } = ctx;
  // Mutable: the configured pitch is corrected by a real measurement after the
  // first paint (zoom / text-spacing overrides grow rows past the assumption,
  // which would drift the spacer maths, WCAG 1.4.12).
  let rowH = ctx.density === "compact" ? ctx.rowHCompact : ctx.rowHComfortable;
  const overscan = 6;
  const total = rows.length;

  const tableEl = h("table", { class: "dp-table dt-table--windowed", "aria-label": opts.label, role: "table", "aria-rowcount": String(total + 1) });
  const thead = ctx.buildThead(rows);
  // The header is aria-rowindex 1.
  thead.querySelector("tr")?.setAttribute("aria-rowindex", "1");
  tableEl.appendChild(thead);

  const tbody = h("tbody");
  tableEl.appendChild(tbody);

  // A leading + trailing spacer <tr>, each sized to the off-screen rows above/below
  // the window, keeps the scrollbar honest while only the visible slice renders. This
  // is table-correct (the spacers are real rows in the tbody, not transforms).
  const viewport = h("div", { class: "dt-viewport" });
  viewport.style.height = `${ctx.viewportH}px`;
  viewport.style.overflowY = "auto";
  // Keyboard scroll access (WCAG 2.1.1): with activatable rows, roving focus
  // scrolls the viewport; without them nothing inside is focusable, so the
  // viewport itself must take focus to be scrollable from the keyboard.
  if (!opts.onRowActivate) {
    viewport.setAttribute("tabindex", "0");
    viewport.setAttribute("role", "region");
    viewport.setAttribute("aria-label", opts.label);
  }

  const topSpacer = h("tr", { class: "dt-spacer", "aria-hidden": "true" });
  const topCell = h("td", { colspan: String(totalCols) });
  topSpacer.appendChild(topCell);
  const bottomSpacer = h("tr", { class: "dt-spacer", "aria-hidden": "true" });
  const bottomCell = h("td", { colspan: String(totalCols) });
  bottomSpacer.appendChild(bottomCell);

  let lastStart = -1;
  const paint = () => {
    const scrollTop = viewport.scrollTop;
    const { start, end } = _testWindowSlice(scrollTop, total, rowH, ctx.viewportH, overscan);
    if (start === lastStart) return;
    lastStart = start;

    clear(tbody);
    topCell.style.height = `${start * rowH}px`;
    topCell.style.padding = "0";
    tbody.appendChild(topSpacer);
    for (let i = start; i < end; i++) {
      const r = rows[i]!;
      const tr = ctx.buildRow(r, i, rows);
      // aria-rowindex is 1-based and accounts for the header row at index 1.
      tr.setAttribute("aria-rowindex", String(i + 2));
      tbody.appendChild(tr);
    }
    bottomCell.style.height = `${(total - end) * rowH}px`;
    bottomCell.style.padding = "0";
    tbody.appendChild(bottomSpacer);
    // Roving tabindex must keep exactly one tab stop AMONG THE RENDERED rows: when the
    // active/first row has scrolled out of the window, buildRow leaves no row at
    // tabindex 0, which would strand keyboard users. Guarantee a stop on the first
    // rendered data row of the slice if none is present.
    if (opts.onRowActivate && !tbody.querySelector('tr[data-key][tabindex="0"]')) {
      const firstDataRow = tbody.querySelector<HTMLElement>("tr[data-key]");
      firstDataRow?.setAttribute("tabindex", "0");
    }
  };

  // Wire the roving-key handler ONCE on the persistent windowed tbody (not inside
  // paint(), which runs on every scroll and would stack duplicate listeners). The
  // handler reads the live rows via closure and resolves the focused row by its
  // data-key, so it stays correct as paint() swaps the rendered slice.
  ctx.wireRovingKeys(tbody, rows);

  viewport.addEventListener("scroll", paint);
  // The table sits inside the scroll viewport.
  viewport.appendChild(tableEl);
  paint();

  // Correct the configured pitch with a real measurement once the first slice has
  // painted in the document: under zoom or text-spacing overrides rows outgrow
  // the assumed height and the spacer maths would drift. One corrective repaint.
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      const first = tbody.querySelector<HTMLElement>("tr[data-key]");
      const measured = first?.getBoundingClientRect().height ?? 0;
      if (measured > 0 && Math.abs(measured - rowH) > 1) {
        rowH = measured;
        lastStart = -1;
        paint();
      }
    });
  }

  // A note for assistive tech that the table is windowed (the row count is the true
  // total via aria-rowcount; this clarifies scrolling reveals more).
  const wrap = h("div", { class: "dt-windowed-wrap" }, viewport);
  wrap.appendChild(h("span", { class: "visually-hidden" }, `${total} rows; scroll to load more into view.`));
  return wrap;
}

export function filteredEmptyNode<Row>(ctx: DataTableCtx<Row>): HTMLElement {
  const card = h("div", { class: "dp-table__empty dt-filtered-empty" });
  card.appendChild(h("p", { style: "color:var(--text)" }, "No rows match the current filter."));
  const clearBtn = h("button", { "data-dp": "components-data-table-render.button.clear", class: "btn btn--secondary btn--sm", type: "button" }, "Clear filters");
  clearBtn.addEventListener("click", () => {
    ctx.query = "";
    ctx.activeFacets.clear();
    if (ctx.filterInput) ctx.filterInput.value = "";
    // Reset facet chips' pressed state.
    ctx.toolbar.querySelectorAll<HTMLElement>(".dt-facet").forEach((c) => {
      c.setAttribute("aria-pressed", "false");
    });
    ctx.onChange();
  });
  card.appendChild(h("div", { style: "margin-top:var(--space-3)" }, clearBtn));
  return card;
}

export function defaultEmpty(): HTMLElement {
  return h("div", { class: "dp-table__empty" }, "No rows.");
}
