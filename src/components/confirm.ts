// Type-to-confirm, the high-blast-radius confirm. A labelled field whose typed value (the run id, or the
// target binding name) must match before the Apply button enables; the impact
// summary is real text; focus lands on Cancel, never the destructive button. Used
// by restore-apply and any redirect or large restore. This replaces the native
// confirm() the old console used for the highest-stakes action, with a proper focus-managed modal stating
// the exact effect in one sentence.
//
// The friction is calibrated: a small same-binding restore
// uses confirmModal (a single button + Cancel); type-to-confirm is reserved for
// genuinely high blast radius. Both live here so the restore flow picks the right
// one from the plan.

import { h } from "../lib/dom.ts";
import { openOverlay, dialogSurface, type OverlayHandle } from "./dialog.ts";

export interface TypeToConfirmOptions {
  title: string;
  // One-sentence statement of the exact effect, e.g. "Write 12,304 verified records
  // back to binding KV_uploads in this account." Rendered as real, escaped text.
  impactSentence: string;
  // Extra body nodes above the type-to-confirm field (e.g. a non-latest warning, a
  // blast-radius summary). Already-built nodes; never raw server HTML.
  extra?: Node[];
  // The exact string the operator must type to enable Apply (the run id or the
  // target binding name). Shown in the field's label/hint so the operator knows it.
  matchValue: string;
  matchLabel: string; // e.g. "run id" or "target binding name"
  confirmLabel: string; // e.g. "Apply restore"
  busyLabel?: string; // shown while the apply is pending
}

// typeToConfirm resolves true when the operator types the match value and clicks
// Apply, false on dismiss/cancel. The Apply button is disabled until the typed
// value matches exactly (a trimmed, case-sensitive compare; ids and binding names
// are case-sensitive).
export function typeToConfirm(opts: TypeToConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let decided = false;
    let handle: OverlayHandle;
    const settle = (v: boolean) => {
      if (decided) return;
      decided = true;
      resolve(v);
    };

    const body = h("div", { class: "confirm-body" });
    body.appendChild(h("p", { class: "confirm-impact", style: "color:var(--text)" }, opts.impactSentence));
    for (const node of opts.extra ?? []) body.appendChild(node);

    const inputId = `ttc-${crypto.randomUUID().slice(0, 8)}`;
    const input = h("input", {
      class: "input",
      id: inputId,
      type: "text",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      "aria-describedby": `${inputId}-hint`,
    }) as HTMLInputElement;
    const fieldEl = h(
      "div",
      { class: "field", style: "margin-top:var(--space-4)" },
      h("label", { class: "field__label", for: inputId }, `Type the ${opts.matchLabel} to confirm`),
      input,
      h("p", { class: "field__hint mono", id: `${inputId}-hint` }, opts.matchValue),
    );
    body.appendChild(fieldEl);

    // Footer: Cancel (left, the default focus) + Apply (right, disabled until match).
    const cancelBtn = h("button", { "data-dp": "components-confirm.button.cancel", class: "btn btn--secondary", type: "button" }, "Cancel") as HTMLButtonElement;
    const applyBtn = h("button", { "data-dp": "components-confirm.button.apply", class: "btn btn--danger", type: "button", disabled: true }, opts.confirmLabel) as HTMLButtonElement;
    const footer = h("div", { class: "dialog__actions" }, cancelBtn, applyBtn);

    // This disabled -> enabled flip is a plain native
    // :disabled toggle, so the restrained opacity/border fade lives entirely in tokens.css's
    // .btn--danger transition; nothing here needs to trigger or gate an animation.
    input.addEventListener("input", () => {
      applyBtn.disabled = input.value.trim() !== opts.matchValue;
    });

    const { surface } = dialogSurface({
      variant: "modal",
      title: opts.title,
      body,
      footer,
      onCloseClick: () => {
        settle(false);
        handle.close();
      },
    });

    handle = openOverlay({
      surface,
      variant: "modal",
      dismissable: true,
      initialFocus: cancelBtn, // focus Cancel, never the destructive Apply
      onClose: () => settle(false), // Esc / click-out / close X all resolve false
    });

    cancelBtn.addEventListener("click", () => {
      settle(false);
      handle.close();
    });
    applyBtn.addEventListener("click", async () => {
      if (input.value.trim() !== opts.matchValue) return;
      if (opts.busyLabel) {
        applyBtn.dataset.busy = "true";
        applyBtn.textContent = opts.busyLabel;
        applyBtn.disabled = true;
        cancelBtn.disabled = true;
      }
      settle(true);
      handle.close();
    });
  });
}
