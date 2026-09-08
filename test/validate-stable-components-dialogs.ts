// Group: the confirm + modal dialogs.
//
//   components/confirm.ts  type-to-confirm gating: Apply disabled until the exact match;
//                          Cancel focus; resolves true only on a matching Apply, false on
//                          Cancel / Esc.
//   components/modal.ts    openModal / confirmModal; danger focuses Cancel; onClick:false keeps
//                          it open; a rejected onClick keeps it open and surfaces a warn toast;
//                          the busy path restores the label; the _actionErrorMessage seam.
//
// Drives the REAL dialog components under the shared DOM shim; never re-implements them.

import {
  qs,
  textOf,
  flushAsync,
  activeElement,
  dispatchDocKey,
  keydown,
  type ShimNode,
  type ShimEvent,
} from "./dom-shim.ts";
import { type Ctx, type Harness, SN, click, findButtonByText } from "./validate-stable-components-shared.ts";

export async function runDialogs(h: Harness, ctx: Ctx): Promise<void> {
  const { h: hEl, dialog, typeToConfirm, openModal, confirmModal } = ctx;

  // =========================================================================
  // 7. components/confirm.ts -- type-to-confirm gating + Cancel focus
  // =========================================================================
  console.log("\n-- confirm (type-to-confirm) --");
  {
    const p = typeToConfirm({
      title: "Apply restore",
      impactSentence: "Write 12,304 verified records back to KV_uploads.",
      matchValue: "RUN-XYZ",
      matchLabel: "run id",
      confirmLabel: "Apply restore",
      extra: [hEl("p", { class: "warn-extra" }, "Not the latest snapshot.")],
    });
    await flushAsync();
    const surface = qs(document.body, ".dialog--modal")!;
    h.eq(textOf(qs(surface, ".confirm-impact")), "Write 12,304 verified records back to KV_uploads.", "impact sentence shown");
    h.ok("the extra warning node is rendered above the field", qs(surface, ".warn-extra") !== null);
    const input = qs(surface, "input")!;
    const applyBtn = findButtonByText(surface, "Apply restore")!;
    const cancelBtn = findButtonByText(surface, "Cancel")!;
    h.eq(applyBtn.getAttribute("disabled"), "", "Apply is disabled before a match");
    h.eq(activeElement(), cancelBtn as unknown as ShimNode, "focus lands on Cancel, never the destructive Apply");

    // A wrong value keeps Apply disabled.
    input.value = "RUN-WRONG";
    input.dispatchEvent({ type: "input", target: input, currentTarget: input, defaultPrevented: false, bubbles: true, preventDefault() {}, stopPropagation() {} } as ShimEvent);
    h.eq(applyBtn.disabled, true, "a non-matching value keeps Apply disabled");

    // The exact match enables Apply; clicking it resolves true and closes.
    input.value = "RUN-XYZ";
    input.dispatchEvent({ type: "input", target: input, currentTarget: input, defaultPrevented: false, bubbles: true, preventDefault() {}, stopPropagation() {} } as ShimEvent);
    h.eq(applyBtn.disabled, false, "the exact match enables Apply");
    click(applyBtn);
    const result = await p;
    h.eq(result, true, "a matching Apply resolves true");
    h.ok("the dialog closed after Apply", document.querySelector(".overlay") === null);
  }
  {
    // Cancel resolves false.
    const p = typeToConfirm({ title: "T", impactSentence: "S", matchValue: "M", matchLabel: "id", confirmLabel: "Go" });
    await flushAsync();
    const surface = qs(document.body, ".dialog--modal")!;
    click(findButtonByText(surface, "Cancel"));
    h.eq(await p, false, "Cancel resolves false");
  }
  {
    // Esc resolves false (the onClose path).
    const p = typeToConfirm({ title: "T2", impactSentence: "S", matchValue: "M", matchLabel: "id", confirmLabel: "Go" });
    await flushAsync();
    dispatchDocKey(keydown({ key: "Escape" }));
    h.eq(await p, false, "Esc dismiss resolves false");
  }

  // =========================================================================
  // 8. components/modal.ts -- openModal / confirmModal + the error contract
  // =========================================================================
  console.log("\n-- modal --");
  {
    // confirmModal with a danger variant focuses Cancel; confirm resolves true.
    const p = confirmModal({ title: "Delete?", body: "This removes the downpipe.", confirmLabel: "Delete", variant: "danger" });
    await flushAsync();
    const surface = qs(document.body, ".dialog--modal")!;
    const cancel = findButtonByText(surface, "Cancel")!;
    h.eq(activeElement(), cancel as unknown as ShimNode, "danger confirmModal focuses Cancel");
    h.ok("the confirm label is the danger button", SN(findButtonByText(surface, "Delete")).className.includes("btn--danger"));
    click(findButtonByText(surface, "Delete"));
    h.eq(await p, true, "confirmModal resolves true on confirm");
  }
  {
    // confirmModal Cancel resolves false.
    const p = confirmModal({ title: "Q", body: hEl("p", "node body"), confirmLabel: "Yes" });
    await flushAsync();
    click(findButtonByText(qs(document.body, ".dialog--modal"), "Cancel"));
    h.eq(await p, false, "confirmModal resolves false on cancel");
  }
  {
    // openModal default actions -> a single Close. Clicking an action closes the modal but is NOT
    // a "dismissal": onDismiss fires only for a genuine dismissal (Esc / click-out / close X), so a
    // Close-action click closes WITHOUT calling onDismiss. (This is the closingFromAction contract.)
    let dismissedByAction = 0;
    openModal({ title: "Notice", body: hEl("p", "fyi"), onDismiss: () => { dismissedByAction++; } });
    await flushAsync();
    const surface = qs(document.body, ".dialog--modal")!;
    h.ok("default action is a single Close", findButtonByText(surface, "Close") !== undefined);
    click(findButtonByText(surface, "Close"));
    await flushAsync(); // runAction is async (awaits onClick) before handle.close()
    h.ok("clicking the Close action closes the modal", document.querySelector(".overlay") === null);
    h.eq(dismissedByAction, 0, "a Close-action click does NOT fire onDismiss (only Esc/click-out/X do)");

    // Esc IS a genuine dismissal: onDismiss fires.
    let dismissedByEsc = 0;
    openModal({ title: "Notice2", body: hEl("p", "fyi"), onDismiss: () => { dismissedByEsc++; } });
    await flushAsync();
    dispatchDocKey(keydown({ key: "Escape" }));
    h.eq(dismissedByEsc, 1, "Esc fires onDismiss (a genuine dismissal)");
  }
  {
    // onClick returning false keeps the modal OPEN (validation-failure path).
    let calls = 0;
    openModal({
      title: "Keep open",
      body: hEl("p", "x"),
      actions: [{ label: "Submit", variant: "primary", onClick: () => { calls++; return false; } }],
    });
    await flushAsync();
    const surface = qs(document.body, ".dialog--modal")!;
    click(findButtonByText(surface, "Submit"));
    await flushAsync();
    h.eq(calls, 1, "the action ran");
    h.ok("an action returning false keeps the modal open", document.querySelector(".overlay") !== null);
    dialog.closeAllOverlays();
  }
  {
    // A REJECTED onClick keeps the modal open and surfaces a warn toast (non-busy path).
    openModal({
      title: "Throwy",
      body: hEl("p", "x"),
      actions: [{ label: "Do", variant: "primary", onClick: () => { throw new Error("boom"); } }],
    });
    await flushAsync();
    const surface = qs(document.body, ".dialog--modal")!;
    click(findButtonByText(surface, "Do"));
    await flushAsync();
    h.ok("a rejected onClick keeps the modal open", document.querySelector(".overlay") !== null);
    const toastEl = qs(document.body, ".toast");
    h.ok("a warn toast is surfaced on a rejected action", toastEl !== null && textOf(toastEl).includes("boom"));
    dialog.closeAllOverlays();
  }
  {
    // The busy path: a rejected onClick restores the button label and surfaces the error.
    openModal({
      title: "Busy throw",
      body: hEl("p", "x"),
      actions: [{ label: "Save", variant: "primary", busyLabel: "Saving...", onClick: async () => { throw new Error("nope"); } }],
    });
    await flushAsync();
    const surface = qs(document.body, ".dialog--modal")!;
    const save = findButtonByText(surface, "Save")!;
    click(save);
    await flushAsync();
    h.ok("busy-path rejection keeps the modal open", document.querySelector(".overlay") !== null);
    h.eq(textOf(save), "Save", "busy-path rejection restores the original button label");
    h.eq(save.disabled, false, "busy-path rejection re-enables the button");
    dialog.closeAllOverlays();
  }
  {
    // _actionErrorMessage extracts Error.message, else String(value).
    const modal = await import("../src/components/modal.ts");
    h.eq(modal._actionErrorMessage(new Error("hi")), "hi", "_actionErrorMessage reads Error.message");
    h.eq(modal._actionErrorMessage("plain"), "plain", "_actionErrorMessage stringifies a non-Error");
    h.eq(await modal._testRunNonBusyAction(() => true, () => {}), true, "_testRunNonBusyAction returns true on success");
    let surfaced = "";
    h.eq(await modal._testRunNonBusyAction(() => { throw new Error("z"); }, (m) => { surfaced = m; }), false, "_testRunNonBusyAction returns false on rejection");
    h.eq(surfaced, "z", "_testRunNonBusyAction routes the message to notifyError");
  }
}
