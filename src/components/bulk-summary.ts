// The shared per-item failures summary modal for a bulk loop (the honest partial-success surface). It
// was the private openBulkSummary on the downpipes detail actions; it is lifted here so EVERY bulk loop
// reuses the SAME surface (the bulk run/disable/delete path, the Sources bulk-protect, and the fleet
// drill) rather than re-implementing it or truncating its failures to "3 named + N more". Each
// failure is a real, focusable list item (not a vanishing toast), so a 30-failure drill explains all 30.
//
// No-custody: every server-supplied string (a name, a reason) enters the DOM via the typed h() builder
// (textContent under the hood), never innerHTML. House rules: Australian English, no em dashes.

import { h } from "../lib/dom.ts";
import { bulkReasonForFailures, recordBulkOutcome } from "../lib/client-diag/ring.ts";
import type { ClientDiagBulkAction } from "../lib/client-diag/vocab.ts";
import { openOverlay, dialogSurface } from "./dialog.ts";

// openBulkSummary shows the per-item failures in a modal. Each failure is a list item (not a focusable
// div); the reading cursor reaches the content naturally, and the dialog body is scrollable via keyboard.
//
// `action` is the closed bulk-action id and it is required. `verb` is operator-facing prose ("created",
// "drilled") and is not a member of anything, so it renders and never rides; `action` is the product constant
// that tells the recorded row apart from every other bulk loop's. They are separate parameters for exactly that
// reason: deriving one from the other would put a rendered string into the ring.
export function openBulkSummary(action: ClientDiagBulkAction, verb: string, done: number, failures: Array<{ name: string; reason: string }>): void {
  // This is the seam: every bulk loop in the console (bulk protect, the import,
  // the bulk run/disable/delete, the fleet drill) funnels its per-item failures HERE, and until now they
  // existed ONLY inside this dialog. The operator dismisses it and the evidence is gone, so a "some of my
  // downpipes would not create" ticket arrives with nothing behind it. Recording at the one shared surface
  // gives complete coverage of the kind, exactly as engine-fetch.ts does for engine calls, without asking
  // six call sites to remember.
  //
  // COUNTS ONLY. `count` is the number of items that did not complete; the reasonClass is the closed class
  // the attempted-versus-failed relation reduces to (every attempted item failed, or some succeeded), and
  // `action` is WHICH bulk loop this was, without which a half-failed delete and a half-failed run were
  // one row wearing whichever ran first. The per-item NAMES and REASONS rendered below are operator labels and
  // engine text: they are read to build the DOM and never enter the ring. Nothing about WHICH item failed
  // leaves the browser.
  //
  // CLASSIFIED BY CAUSE, not by counts. Counts alone made a batch the engine REFUSED (malformed input) and a
  // batch that died because the engine was DOWN into the same row, and those have opposite remedies. The failure
  // reasons are read ONLY through errorStatus (a number or null; it copies nothing) to select a closed class.
  if (failures.length > 0) recordBulkOutcome(action, bulkReasonForFailures(done, failures), failures.length);

  const body = h("div", { class: "bulk-summary" });
  body.appendChild(h("p", { class: "bulk-summary__head" }, `${done} ${verb}, ${failures.length} failed. No transaction runs; each downpipe is its own request.`));
  const listEl = h("ul", { class: "bulk-summary__list" });
  for (const f of failures) {
    listEl.appendChild(
      h(
        "li",
        { class: "bulk-summary__item" },
        h("span", { class: "dot dot--danger", "aria-hidden": "true" }),
        h("span", { class: "visually-hidden" }, "failed: "),
        h("span", { class: "mono" }, f.name),
        h("span", { class: "bulk-summary__reason" }, f.reason),
      ),
    );
  }
  body.appendChild(listEl);

  const closeBtn = h("button", { "data-dp": "components-bulk-summary.button.close", class: "btn btn--secondary", type: "button" }, "Close") as HTMLButtonElement;
  const footer = h("div", { class: "dialog__actions" }, closeBtn);
  const { surface } = dialogSurface({ variant: "modal", title: "Some items did not complete", body, footer, onCloseClick: () => handle.close() });
  const handle = openOverlay({ surface, variant: "modal", dismissable: true });
  closeBtn.addEventListener("click", () => handle.close());
}
