// The BULK-action bar behind the configurable data table (data-table.ts): refreshBulkBar
// shows or hides the bar, updates the selected count, and renders the action buttons +
// the clear control. The bar is a polite live region so its appearance is announced.
// Split out as a dependency-light sibling so the component module
// stays under the size budget. The body is moved verbatim from the dataTable() factory;
// the only change is reading the live state and callbacks through the shared ctx instead
// of the closure, so the move is behaviour-preserving.
//
// House rules: Australian English, no em dashes, precise claims.

import { h, clear, svgIcon } from "../lib/dom.ts";
import { ICON_CLOSE } from "../lib/icons.ts";
import { recordSelectionDropped } from "../lib/client-diag/ring.ts";
import type { DataTableCtx } from "./data-table-context.ts";

// refreshBulkBar shows/hides the bulk-action bar and updates the selected count. The
// bar is a polite live region so its appearance is announced.
export function refreshBulkBar<Row>(ctx: DataTableCtx<Row>): void {
  const { opts, selectable, bulkBar } = ctx;
  if (!selectable || !opts.bulkActions) return;
  const selRows = ctx.allRows.filter((r) => ctx.selected.has(opts.rowKey(r)));
  if (selRows.length === 0) {
    bulkBar.hidden = true;
    clear(bulkBar);
    return;
  }
  clear(bulkBar);
  bulkBar.hidden = false;
  bulkBar.appendChild(h("span", { class: "dt-bulkbar__n" }, `${selRows.length} selected`));
  const actions = h("div", { class: "dt-bulkbar__actions" });
  for (const action of opts.bulkActions) {
    const btn = h(
      "button",
      { "data-dp": "components-data-table-bulkbar.button.refresh-bulk-bar", class: action.danger ? "btn btn--danger btn--sm" : "btn btn--secondary btn--sm", type: "button" },
      action.label,
    );
    btn.addEventListener("click", async () => {
      // Rows that vanished from the selection since the operator last touched it, recorded here, at the
      // one moment it becomes a fault: they are about to run a bulk action over fewer rows than they chose, and
      // nothing in the loop's own counts, or in the pack, will ever say so. Recorded before run() so it is
      // captured even if the operator cancels at the confirm (they still selected 20 and were shown 17).
      //
      // A drop that is not followed by a bulk click is never recorded, and the counter is reset on every
      // selection clear, so the rows a successful bulk delete correctly removes cannot cry wolf.
      if (ctx.droppedSelections > 0 && action.diagAction !== undefined) {
        recordSelectionDropped(action.diagAction, ctx.droppedSelections);
        ctx.droppedSelections = 0;
      }
      // The table surfaces the action and the count; a DESTRUCTIVE action is the
      // caller's to route through the safe confirm flow inside run(). The table never
      // confirms or executes a destructive write itself.
      try {
        await action.run(ctx.allRows.filter((r) => ctx.selected.has(opts.rowKey(r))));
      } catch (err) {
        // Announce the failure where the operator is (the bulk bar is already a
        // polite live region), keep the selection so they can retry, and log the
        // detail for the developer (WCAG 4.1.3).
        const n = bulkBar.querySelector<HTMLElement>(".dt-bulkbar__n");
        if (n) n.textContent = `${action.label} failed; the selection is kept, try again. (${err instanceof Error ? err.message : "error"})`;
        console.error("Bulk action failed:", err);
        return;
      }
      if (!action.keepSelection) {
        ctx.selected.clear();
        ctx.droppedSelections = 0;
        ctx.render();
      }
    });
    actions.appendChild(btn);
  }
  const clearBtn = h(
    "button",
    { "data-dp": "components-data-table-bulkbar.button.clear", class: "btn btn--ghost btn--sm dt-bulkbar__clear", type: "button" },
    svgIcon(ICON_CLOSE, { size: 14 }),
    "Clear selection",
  );
  clearBtn.addEventListener("click", () => {
    ctx.selected.clear();
    ctx.droppedSelections = 0;
    ctx.render();
  });
  actions.appendChild(clearBtn);
  bulkBar.appendChild(actions);
}
