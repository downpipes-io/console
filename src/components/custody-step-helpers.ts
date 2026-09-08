// Small local helpers for the custody step (no network anywhere). These were extracted from
// custody-step.ts to keep that file under the structural budget; the logic is byte-for-byte
// the same. They are shared by the step root and the per-tier panels.
//
// House rules: Australian English; no em dashes; CSSOM via node.style / the h() style helper
// (never setAttribute("style")); every server/operator string via textContent or escape;
// status by shape + label, not colour alone; accessible labels on every control.

import { h, svgIcon } from "../lib/dom.ts";
import type { StatusTone } from "./status.ts";
import {
  ICON_INFO,
  ICON_CHECK,
  ICON_ALERT,
} from "../lib/icons.ts";
import type { CustodianSignoff } from "../lib/custody.ts";

// resizeSignoffs grows or shrinks a sign-off list to exactly n entries, preserving holders
// for indices that survive. Pure-ish (operates on the passed array, returns a new one).
export function resizeSignoffs(current: CustodianSignoff[], n: number): CustodianSignoff[] {
  const out: CustodianSignoff[] = [];
  for (let i = 1; i <= n; i++) {
    const existing = current.find((s) => s.shareIndex === i);
    out.push(existing ?? { shareIndex: i, holder: "" });
  }
  return out;
}

// surfaceNote builds a small inline note card (status by tone glyph + label, not colour
// alone). It mirrors verdictSurface's intent but is local to keep the dependency surface
// tight and the styling consistent within the step.
export function surfaceNote(tone: StatusTone, title: string, body: string): HTMLElement {
  const glyph = tone === "ok" ? ICON_CHECK : tone === "warn" ? ICON_ALERT : ICON_INFO;
  const card = h("div", { class: `custody-note custody-note--${tone}`, role: "note" });
  card.appendChild(
    h(
      "p",
      { class: "custody-note__title", style: "display:flex;align-items:center;gap:var(--space-2);font-weight:var(--weight-semibold)" },
      svgIcon(glyph, { size: 15 }),
      title,
    ),
  );
  card.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, body));
  return card;
}

export function spinnerLine(text: string): HTMLElement {
  return h(
    "span",
    { class: "status", style: "display:inline-flex;align-items:center;gap:var(--space-2)" },
    h("span", { class: "ob-spinner", "aria-hidden": "true" }),
    h("span", text),
  );
}

export function setBtnBusy(btn: HTMLButtonElement, busy: boolean, label: string): void {
  if (busy) {
    btn.dataset.busy = "true";
    btn.setAttribute("aria-busy", "true");
    btn.disabled = true;
    btn.replaceChildren(h("span", { class: "btn__spinner", "aria-hidden": "true" }), document.createTextNode(` ${label}`));
  } else {
    btn.dataset.busy = "false";
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
    btn.replaceChildren(document.createTextNode(label));
  }
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// todayISO is today's date as a sortable YYYY-MM-DD string (local time), used to pre-fill the
// custodian sign-off date so the operator is not left to type it. It matches the placeholder
// format the recovery sheet already shows and stays locale-stable (no slashes/ambiguity).
export function todayISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
