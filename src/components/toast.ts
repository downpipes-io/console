// The toast region. A
// fixed region that stacks transient confirmations. Toasts are CONFIRMATIONAL and
// GLOBAL only ("Downpipe created", "Run triggered", "Audit exported"). Other
// channels own everything else: validation goes inline (field.ts) while a
// destructive decision goes to the confirm flow (modal.ts), and a privileged
// action's record of truth is the audit log, never a toast. This is the channel
// rule that keeps the two-channel error model clean.
//
// A11y: the region is an ARIA live region, role="status" aria-live="polite" for
// success/info and role="alert" aria-live="assertive" only for a genuine
// interrupt. Auto-dismiss 4 to 6s, pause on hover/focus, keyboard-dismissible,
// reduced-motion aware (the rise animation is gated by the global rule in
// tokens.css). Replaces every native alert() the old console used.

import { h, svgIcon } from "../lib/dom.ts";
import { ICON_CHECK, ICON_INFO, ICON_ALERT, ICON_CLOSE } from "../lib/icons.ts";
import { toastDurationMs } from "../lib/a11y-prefs.ts";

export type ToastTone = "success" | "info" | "warn";

export interface ToastOptions {
  message: string;
  tone?: ToastTone; // default "success"
  // An optional single action (Undo / View). Undo is offered ONLY where a true
  // inverse exists (e.g. disable/enable a downpipe); an irreversible write gets no
  // fake undo.
  action?: { label: string; onClick: () => void };
  // Auto-dismiss in ms; default 5000 (within the 4 to 6s window). 0 disables
  // auto-dismiss (kept until the operator dismisses; used sparingly).
  durationMs?: number;
}

// Two live regions: polite for success/info, assertive for warnings. They are
// created lazily and reused, so there is a single, stable live region of each
// politeness (announcement requires the region to pre-exist in the DOM).
let politeRegion: HTMLElement | null = null;
let assertiveRegion: HTMLElement | null = null;

function ensureRegions(): { polite: HTMLElement; assertive: HTMLElement } {
  if (!politeRegion) {
    politeRegion = h("div", { class: "toast-region", role: "status", "aria-live": "polite", "aria-atomic": "false" });
    document.body.appendChild(politeRegion);
  }
  if (!assertiveRegion) {
    assertiveRegion = h("div", { class: "toast-region toast-region--assertive", role: "alert", "aria-live": "assertive", "aria-atomic": "false" });
    document.body.appendChild(assertiveRegion);
  }
  return { polite: politeRegion, assertive: assertiveRegion };
}

const MAX_VISIBLE = 4;

// toast shows a transient confirmation. Returns a dismiss function for the rare
// caller that wants to clear it early.
export function toast(opts: ToastOptions): () => void {
  const tone = opts.tone ?? "success";
  const { polite, assertive } = ensureRegions();
  const region = tone === "warn" ? assertive : polite;

  // Cap the visible count; drop the oldest if over the cap (the queue is implicit:
  // a burst simply trims the eldest, which is fine for confirmations).
  while (region.childElementCount >= MAX_VISIBLE && region.firstElementChild) {
    region.firstElementChild.remove();
  }

  const icon =
    tone === "success" ? ICON_CHECK
    : tone === "warn" ? ICON_ALERT
    : ICON_INFO;

  const el = h("div", { class: `toast toast--${tone}`, role: "group" });
  el.appendChild(h("span", { class: "toast__icon" }, svgIcon(icon, { size: 16 })));
  el.appendChild(h("span", { class: "toast__msg" }, opts.message));

  let timer: number | undefined;
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    window.clearTimeout(timer);
    el.remove();
  };

  if (opts.action) {
    const action = opts.action;
    el.appendChild(
      h(
        "button",
        { "data-dp": "components-toast.button.dismiss",
          class: "btn btn--ghost btn--sm toast__action",
          type: "button",
          on: {
            click: () => {
              action.onClick();
              dismiss();
            },
          },
        },
        action.label,
      ),
    );
  }

  const closeBtn = h(
    "button",
    { "data-dp": "components-toast.button.close", class: "btn btn--ghost btn--icon btn--sm toast__close", type: "button", "aria-label": "Dismiss", on: { click: () => dismiss() } },
    svgIcon(ICON_CLOSE, { size: 14 }),
  );
  el.appendChild(closeBtn);

  region.appendChild(el);

  // The operator's toast-duration preference applies unless the caller pinned a
  // duration; 0 = stay until dismissed (WCAG 2.2.1 headroom).
  const duration = opts.durationMs ?? toastDurationMs();
  const startTimer = () => {
    if (duration > 0) timer = window.setTimeout(dismiss, duration);
  };
  // Pause on hover/focus, resume on leave/blur.
  el.addEventListener("mouseenter", () => window.clearTimeout(timer));
  el.addEventListener("mouseleave", startTimer);
  el.addEventListener("focusin", () => window.clearTimeout(timer));
  el.addEventListener("focusout", startTimer);
  startTimer();

  return dismiss;
}
