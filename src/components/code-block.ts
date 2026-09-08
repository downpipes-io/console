// CodeBlock, CopyButton and KeyField.
// These carry the no-custody concealment hygiene the configure step depends on:
//
//  - CodeBlock: a monospace block (the wrangler commands / wrangler.toml additions).
//    Content is set via textContent so placeholders like <your-archive-bucket> render
//    LITERALLY and there is zero markup-injection surface.
//  - CopyButton: copies a value lazily (reads it at click time), shows a transient
//    "Copied" state announced politely, and can copy a CONCEALED value WITHOUT
//    revealing it on screen.
//  - KeyField: for the single private value the engine legitimately holds (the
//    signer), and any value the operator must paste: concealed behind a reveal
//    toggle showing a FIXED-LENGTH dot run (never the real length), set via
//    textContent; copy works without revealing. There is deliberately NO field for
//    the break-glass private key (the engine never holds it; the system must not add
//    one).

import { h, svgIcon } from "../lib/dom.ts";
import { ICON_COPY, ICON_EYE, ICON_EYE_OFF } from "../lib/icons.ts";

// A single polite live region for "Copied" announcements (created once, reused).
let copyLive: HTMLElement | null = null;
function announce(msg: string): void {
  if (!copyLive) {
    copyLive = h("div", { class: "visually-hidden", role: "status", "aria-live": "polite" });
    document.body.appendChild(copyLive);
  }
  copyLive.textContent = "";
  // On the next task so the change is announced even for a repeat value. A zero timeout is
  // enough: tasks are serialised, so the screen reader sees the clear before the set.
  window.setTimeout(() => { if (copyLive) copyLive.textContent = msg; }, 0);
}

// copyButton builds a small ghost icon button that copies getText() at click time.
// It never reveals a concealed value; it copies the real bytes from the getter.
export function copyButton(label: string, getText: () => string): HTMLButtonElement {
  const btn = h(
    "button",
    { "data-dp": "components-code-block.button.copy-button", class: "btn btn--ghost btn--icon btn--sm copy-btn", type: "button", "aria-label": label },
    svgIcon(ICON_COPY, { size: 14 }),
  ) as HTMLButtonElement;
  btn.addEventListener("click", async () => {
    const text = getText();
    try {
      await navigator.clipboard.writeText(text);
      announce("Copied");
      flashCopied(btn);
    } catch {
      // Clipboard blocked (no permission / insecure context). Fall back to a select-
      // and-prompt-free path is not possible without revealing; announce honestly.
      announce("Copy failed; select the value manually");
    }
  });
  return btn;
}

function flashCopied(btn: HTMLButtonElement): void {
  btn.classList.add("copy-btn--done");
  window.setTimeout(() => btn.classList.remove("copy-btn--done"), 1200);
}

// codeBlock builds a monospace block with a per-block copy button. Content is set
// via textContent (placeholders render literally); whitespace is preserved by the
// <pre> element. An optional copyLabel overrides the default "Copy command" label.
export function codeBlock(content: string, opts: { copyLabel?: string; label?: string } = {}): HTMLElement {
  // The pre scrolls horizontally (long commands); a focusable region so Firefox/
  // Safari keyboard users can scroll the clipped command into view (WCAG 2.1.1).
  // The universal :focus-visible ring covers the indicator.
  const pre = h("pre", {
    class: "code code-block__pre",
    tabindex: "0",
    role: "region",
    "aria-label": opts.label ?? "Command",
  });
  pre.textContent = content; // literal; no markup parsed
  const copy = copyButton(opts.copyLabel ?? "Copy command", () => content);
  return h("div", { class: "code-block" }, pre, h("div", { class: "code-block__copy" }, copy));
}

// keyField builds the conceal/reveal field for the ONE private value the engine
// legitimately holds (the signer). The value is concealed by default behind a
// fixed-length dot run; an explicit eye toggle reveals it; copy works without
// revealing. There is deliberately no keyField for the break-glass private key.
export function keyField(opts: { label: string; value: string }): HTMLElement {
  const DOTS = "•".repeat(24); // fixed-length, NEVER the real length
  let revealed = false;

  // Focusable: the revealed value scrolls horizontally and keyboard users must be
  // able to scroll it to verify the full string (WCAG 2.1.1).
  const valueEl = h("code", {
    class: "key-field__value mono",
    tabindex: "0",
    role: "region",
    "aria-label": opts.label,
  });
  valueEl.textContent = DOTS;

  const reveal = h(
    "button",
    { "data-dp": "components-code-block.toggle.reveal", class: "btn btn--ghost btn--icon btn--sm", type: "button", "aria-pressed": "false", "aria-label": `Reveal ${opts.label}` },
    svgIcon(ICON_EYE, { size: 14 }),
  ) as HTMLButtonElement;
  reveal.addEventListener("click", () => {
    revealed = !revealed;
    valueEl.textContent = revealed ? opts.value : DOTS;
    reveal.setAttribute("aria-pressed", revealed ? "true" : "false");
    reveal.setAttribute("aria-label", revealed ? `Hide ${opts.label}` : `Reveal ${opts.label}`);
    reveal.replaceChildren(svgIcon(revealed ? ICON_EYE_OFF : ICON_EYE, { size: 14 }));
  });

  const copy = copyButton(`Copy ${opts.label}`, () => opts.value); // copies the real value, concealed

  return h(
    "div",
    { class: "key-field" },
    h("span", { class: "key-field__label field__label" }, opts.label),
    h("div", { class: "key-field__row" }, valueEl, reveal, copy),
  );
}
