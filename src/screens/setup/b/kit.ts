// Focus Flow (concept B) building blocks: option tiles (a native radio group), check rows (native
// checkboxes), labelled text fields whose errors link through aria-describedby, the inline message lines,
// and the one-level sheet (a native <dialog>). Every control is a native input, styled; nothing here uses
// innerHTML (icons go through svgIcon, which parses in-repo constants only), and every dynamic style goes
// through the CSSOM.
//
// Keyboard: a radio group answers the number keys 1 to 9 ONLY while focus is inside that group (WCAG 2.1.4:
// a single-character shortcut is scoped to its own component). Arrow keys stay the browser's own roving
// selection. Enter on a radio or a checkbox submits the question (enterSubmits, on the stage form).

import { type DocRef, docLink } from "../../../components/doc-link.ts";
import type { FieldValidator } from "../../../components/field-bounds.ts";
import { h, svgIcon } from "../../../lib/dom.ts";
import { ICON_ALERT, ICON_CHECK, ICON_INFO, ICON_LOCK, ICON_X_CIRCLE } from "../../../lib/icons.ts";
import { enter } from "../../../lib/motion.ts";

let seq = 0;
// uid gives each control a document-unique id (two pages can be in the DOM during the shell's swap).
export function uid(prefix: string): string {
  seq += 1;
  return `fb-${prefix}-${seq}`;
}

export interface TileChoice<T extends string> {
  id: T;
  label: string;
  // One or two consequence lines, shown on the tile face.
  lines: string[];
  // Shown as text when the context cannot support this option; the radio is disabled.
  unavailable?: string;
  // Content revealed inside the tile while it is chosen (one level, never nested).
  extra?: () => Node | null;
}

export interface TileGroup<T extends string> {
  el: HTMLFieldSetElement;
  value: () => T | null;
  // The chosen tile's title element (the answer that travels into the plan on commit).
  chosenTitle: () => HTMLElement | null;
  focusFirst: () => void;
  setError: (msg: string | null) => void;
}

// tileGroup renders a fieldset of option tiles over native radios. Nothing is preselected unless
// `selected` says so. `showChosen` adds the word "Chosen" on the selected tile (safety questions), so the
// state never rests on colour alone. Number-key hints show only when the group binds them.
export function tileGroup<T extends string>(opts: {
  name: string;
  legend?: string;
  labelledBy?: string;
  choices: readonly TileChoice<T>[];
  selected: T | null;
  onChange?: (id: T) => void;
  showChosen?: boolean;
  columns?: 1 | 2 | 3 | 4;
  numberKeys?: boolean;
}): TileGroup<T> {
  const errId = uid("err");
  const set = h("fieldset", {
    class: `fb-tiles fb-tiles--c${opts.columns ?? 1}`,
    ...(opts.labelledBy !== undefined && opts.legend === undefined ? { "aria-labelledby": opts.labelledBy } : {}),
  });
  if (opts.legend !== undefined) set.appendChild(h("legend", { class: "fb-legend" }, opts.legend));
  const grid = h("div", { class: "fb-tiles__grid" });
  set.appendChild(grid);
  const err = h("p", { class: "fb-msg fb-msg--error", id: errId, hidden: true });
  set.appendChild(err);
  const numbered = opts.numberKeys !== false;
  const inputs: Array<{ id: T; input: HTMLInputElement; title: HTMLElement; extraHost: HTMLElement; choice: TileChoice<T> }> = [];
  const group = uid(opts.name);
  let n = 0;
  for (const c of opts.choices) {
    n += 1;
    const id = uid(opts.name);
    const descId = `${id}-d`;
    const input = h("input", { "data-dp": "setup.radio.tile-group",
      class: "fb-tile__input",
      type: "radio",
      name: group,
      value: c.id,
      "aria-describedby": c.unavailable !== undefined ? `${descId} ${descId}-u` : descId,
      ...(c.unavailable !== undefined ? { disabled: true } : {}),
    }) as HTMLInputElement;
    input.id = id;
    input.checked = opts.selected === c.id;
    const title = h("span", { class: "fb-tile__title" }, c.label);
    const extraHost = h("div", { class: "fb-tile__extra" });
    const face = h(
      "label",
      { class: "fb-tile__face", for: id },
      h("span", { class: "fb-tile__mark", "aria-hidden": "true" }, svgIcon(ICON_CHECK, { size: 12 })),
      title,
      opts.showChosen ? h("span", { class: "fb-tile__chosen", "aria-hidden": "true" }, "Chosen") : null,
      numbered && n <= 9 ? h("span", { class: "fb-tile__key", "aria-hidden": "true" }, String(n)) : null,
      h("span", { class: "fb-tile__lines", id: descId, "aria-hidden": "true" }, ...c.lines.map((l) => h("span", { class: "fb-tile__line" }, l))),
      c.unavailable !== undefined ? h("span", { class: "fb-tile__why", id: `${descId}-u`, "aria-hidden": "true" }, svgIcon(ICON_LOCK, { size: 12 }), c.unavailable) : null,
    );
    // The native radio covers the tile's face (transparent), so a click anywhere on the face is a click on the
    // radio itself; the label still names it. Revealed fields sit below the face, outside the radio.
    const tile = h("div", { class: `fb-tile${c.unavailable !== undefined ? " fb-tile--off" : ""}` }, h("div", { class: "fb-tile__head" }, input, face), extraHost);
    grid.appendChild(tile);
    inputs.push({ id: c.id, input, title, extraHost, choice: c });
  }
  const paintExtras = (): void => {
    for (const it of inputs) {
      const want = it.input.checked && it.choice.extra !== undefined;
      if (want && it.extraHost.childElementCount === 0) {
        const node = it.choice.extra!();
        if (node) {
          it.extraHost.appendChild(node);
          enter(it.extraHost, { from: "below", distance: 6, duration: "--dur-2" });
        }
      } else if (!want && it.extraHost.childElementCount > 0) it.extraHost.replaceChildren();
    }
  };
  for (const it of inputs) {
    it.input.addEventListener("change", () => {
      if (!it.input.checked) return;
      setError(null);
      paintExtras();
      opts.onChange?.(it.id);
    });
  }
  paintExtras();
  if (numbered) bindNumberKeys(set, () => inputs.map((x) => x.input));
  function setError(msg: string | null): void {
    err.textContent = msg ?? "";
    err.hidden = msg === null;
    // role=alert only while a message shows, so a screen reader hears the refusal once, when it happens.
    if (msg === null) err.removeAttribute("role");
    else err.setAttribute("role", "alert");
    const first = inputs.find((x) => !x.input.disabled)?.input;
    for (const it of inputs) it.input.removeAttribute("aria-invalid");
    if (msg !== null && first) {
      first.setAttribute("aria-invalid", "true");
      const ids = (first.getAttribute("aria-describedby") ?? "").split(" ").filter((x) => x !== "");
      if (!ids.includes(errId)) first.setAttribute("aria-describedby", [...ids, errId].join(" "));
    }
  }
  return {
    el: set,
    value: () => inputs.find((x) => x.input.checked)?.id ?? null,
    chosenTitle: () => inputs.find((x) => x.input.checked)?.title ?? null,
    focusFirst: () => (inputs.find((x) => x.input.checked) ?? inputs.find((x) => !x.input.disabled))?.input.focus(),
    setError,
  };
}

// bindNumberKeys makes 1 to 9 select the matching radio while focus is inside this group and not in a text
// field. The handler lives on the group itself, never on the page.
function bindNumberKeys(group: HTMLElement, radios: () => HTMLInputElement[]): void {
  group.addEventListener("keydown", (ev) => {
    const e = ev as KeyboardEvent;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!/^[1-9]$/.test(e.key)) return;
    const t = e.target as HTMLElement | null;
    if (t instanceof HTMLInputElement && t.type !== "radio" && t.type !== "checkbox") return;
    if (t instanceof HTMLTextAreaElement) return;
    const r = radios()[Number(e.key) - 1];
    if (!r || r.disabled) return;
    e.preventDefault();
    r.focus();
    if (!r.checked) {
      r.checked = true;
      r.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
}

export interface CheckRow {
  el: HTMLElement;
  input: HTMLInputElement;
}

// checkRow renders one native checkbox with a persistent visible label and an optional muted line.
// `reasonId` names a reason shown once for a whole group (the row is disabled, and its own line is left out).
export function checkRow(opts: { label: string; secondary?: string; checked: boolean; disabledReason?: string; reasonId?: string; onChange: (v: boolean) => void; icon?: string }): CheckRow {
  const id = uid("chk");
  const descId = opts.reasonId ?? `${id}-d`;
  const ownLine = opts.reasonId === undefined && (opts.secondary !== undefined || opts.disabledReason !== undefined);
  const input = h("input", { "data-dp": "setup.checkbox.change",
    class: "fb-check__input",
    type: "checkbox",
    ...(ownLine || opts.reasonId !== undefined ? { "aria-describedby": descId } : {}),
    ...(opts.disabledReason !== undefined || opts.reasonId !== undefined ? { disabled: true } : {}),
  }) as HTMLInputElement;
  input.id = id;
  input.checked = opts.checked;
  input.addEventListener("change", () => opts.onChange(input.checked));
  const el = h(
    "div",
    { class: `fb-check${opts.disabledReason !== undefined || opts.reasonId !== undefined ? " fb-check--off" : ""}` },
    input,
    h(
      "label",
      { class: "fb-check__face", for: id },
      h("span", { class: "fb-check__mark", "aria-hidden": "true" }, svgIcon(ICON_CHECK, { size: 12 })),
      h("span", { class: "fb-check__label" }, opts.label),
      ownLine ? h("span", { class: "fb-check__line", id: descId, "aria-hidden": "true" }, opts.disabledReason ?? opts.secondary ?? "") : null,
    ),
  );
  return { el, input };
}

export interface Field {
  el: HTMLElement;
  input: HTMLInputElement;
  setError: (msg: string | null) => void;
  // check runs the field's own rule on its current value, shows the refusal (or clears it) and returns it.
  // A field with no rule returns null.
  check: () => string | null;
}

// field renders a labelled single-line input. The label is persistent and visible; the error line is linked
// through aria-describedby and never uses the success tone. Secrets use type=password with autocomplete off.
//
// The id is required and static at every call site, the same rule as components/field.ts: it is the key the
// field catalogue (a sibling repo) files the control under, and the selector a harness uses.
// The outgoing copy motion-b.ts animates strips ids, so a static id is never on the page twice. A typeable
// field carries a placeholder example and every field carries its docs link, both read by the field census.
export function field(opts: {
  id: string;
  label: string;
  type?: "text" | "password" | "email" | "number" | "url";
  value?: string;
  placeholder?: string;
  hint?: string;
  doc?: DocRef;
  // The field's own rule, in the console's validator shape (components/field-bounds.ts). The question runs it
  // when it commits, through check(). It never runs on blur: the setup spec shows an error, and role=alert,
  // only on submit (phase2/b/design/SPEC.md, "Errors use role=alert only on submit").
  validate?: FieldValidator;
  autocomplete?: string;
  inputmode?: string;
  size?: "md" | "lg";
  onInput?: (v: string) => void;
}): Field {
  const id = opts.id;
  const hintId = `${id}-h`;
  const errId = `${id}-e`;
  const input = h("input", {
    id,
    class: `input fb-input${opts.size === "lg" ? " fb-input--lg" : ""}`,
    type: opts.type ?? "text",
    autocomplete: opts.autocomplete ?? "off",
    spellcheck: "false",
    "aria-describedby": opts.hint !== undefined ? `${hintId} ${errId}` : errId,
    ...(opts.placeholder !== undefined ? { placeholder: opts.placeholder } : {}),
    ...(opts.inputmode !== undefined ? { inputmode: opts.inputmode } : {}),
  }) as HTMLInputElement;
  if (opts.value !== undefined) input.value = opts.value;
  if (opts.onInput) {
    const cb = opts.onInput;
    input.addEventListener("input", () => cb(input.value));
  }
  const err = h("p", { class: "fb-msg fb-msg--error", id: errId, hidden: true });
  const el = h(
    "div",
    { class: "fb-field" },
    h("label", { class: "fb-field__label", for: id }, opts.label),
    input,
    opts.hint !== undefined ? h("p", { class: "fb-field__hint", id: hintId }, opts.hint) : null,
    opts.doc !== undefined ? docLink(opts.doc) : null,
    err,
  );
  const result: Field = {
    el,
    input,
    setError: (msg) => {
      err.replaceChildren(...(msg === null ? [] : [svgIcon(ICON_X_CIRCLE, { size: 14 }), msg]));
      err.hidden = msg === null;
      // Focus stays in the field, so the error announces itself (role=alert while shown).
      if (msg === null) {
        input.removeAttribute("aria-invalid");
        err.removeAttribute("role");
      } else {
        input.setAttribute("aria-invalid", "true");
        err.setAttribute("role", "alert");
      }
    },
    check: () => {
      const msg = opts.validate ? opts.validate(input.value, { badInput: input.validity?.badInput === true }) : null;
      result.setError(msg);
      return msg;
    },
  };
  return result;
}

export type MsgKind = "error" | "warn" | "info" | "trust";

// message is a persistent inline line. An error or refusal uses the danger tokens; an action needed now uses
// warn; neither ever uses the success tone. role=alert only for errors, so a screen reader hears a refusal
// once, when it happens.
export function message(kind: MsgKind): { el: HTMLElement; set: (msg: string | null, extra?: Node | null) => void } {
  const icon = kind === "error" ? ICON_X_CIRCLE : kind === "warn" ? ICON_ALERT : ICON_INFO;
  const el = h("div", { class: `fb-msg fb-msg--${kind}`, ...(kind === "error" ? { role: "alert" } : { role: "status" }), hidden: true });
  return {
    el,
    set: (msg, extra) => {
      el.replaceChildren(...(msg === null ? [] : [svgIcon(icon, { size: 16 }), h("span", { class: "fb-msg__text" }, msg), extra ?? null].filter((x): x is Node => x !== null)));
      el.hidden = msg === null;
    },
  };
}

// line is a static muted line with a glyph (the trust line, a fixed fact, a pointer).
export function line(icon: string, text: string | Node, cls = ""): HTMLElement {
  return h("p", { class: `fb-line ${cls}`.trim() }, svgIcon(icon, { size: 16 }), h("span", text));
}

// The Cloudflare dashboard pages setup links to. Each is a NAVIGATION (externalLink opens it in a new tab);
// nothing here fetches them, so the console's connect-src does not govern them.
export const CF_API_TOKENS = "https://dash.cloudflare.com/profile/api-tokens";
export const CF_R2_TOKENS = "https://dash.cloudflare.com/?to=/:account/r2/api-tokens";

export function externalLink(label: string, href: string): HTMLAnchorElement {
  return h("a", { class: "fb-link", href, target: "_blank", rel: "noreferrer noopener" }, label) as HTMLAnchorElement;
}

export function textButton(label: string, onClick: () => void, extra: Record<string, string> = {}): HTMLButtonElement {
  return h("button", { "data-dp": "setup.button.click#1", class: "fb-textbtn", type: "button", ...extra, on: { click: () => onClick() } }, label) as HTMLButtonElement;
}

// sheet is the ONE level of depth the setup surface allows: a native modal dialog (focus trapped, Escape
// closes, focus returns to the opener). It never opens another sheet. Where showModal is missing (the
// Node DOM shim), it falls back to the open attribute.
export function openSheet(opts: { title: string; body: Node[]; opener?: HTMLElement | null; onClose?: () => void; actions?: Node[] }): { close: () => void; el: HTMLDialogElement } {
  const titleId = uid("sheet");
  const closeBtn = h("button", { "data-dp": "setup.button.close", class: "btn btn--secondary", type: "button" }, "Close");
  const dlg = h(
    "dialog",
    { class: "fb-sheet", "aria-labelledby": titleId },
    h("div", { class: "fb-sheet__inner" }, h("h2", { id: titleId, tabindex: "-1", class: "fb-sheet__title" }, opts.title), ...opts.body, h("div", { class: "fb-sheet__actions" }, ...(opts.actions ?? []), closeBtn)),
  ) as HTMLDialogElement;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (typeof dlg.close === "function" && dlg.open) dlg.close();
    dlg.remove();
    opts.onClose?.();
    if (opts.opener?.isConnected) opts.opener.focus();
  };
  closeBtn.addEventListener("click", close);
  dlg.addEventListener("close", close);
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  document.body.appendChild(dlg);
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
  enter(dlg, { from: "right", distance: 24, duration: "--dur-2" });
  const t = dlg.querySelector<HTMLElement>(".fb-sheet__title");
  t?.focus();
  return { close, el: dlg };
}

// kbd is the keyboard hint beside the primary action. It is text, not a control.
export function kbd(text: string): HTMLElement {
  return h("kbd", { class: "fb-kbd", "aria-hidden": "true" }, text);
}

// enterSubmits makes Enter on a radio, a checkbox or the question's heading submit the question. Enter in a
// single-line text field already submits the form natively. `fromHeading: false` leaves the heading out: on
// arrival focus is on the h1, so a view whose primary records an attestation or leaves setup (Finish) must
// not run it from one Enter the user meant for the view before.
export function enterSubmits(form: HTMLFormElement, opts: { fromHeading?: boolean } = {}): void {
  form.addEventListener("keydown", (ev) => {
    const e = ev as KeyboardEvent;
    if (e.key !== "Enter" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
    const t = e.target as HTMLElement | null;
    const tile = t instanceof HTMLInputElement && (t.type === "radio" || t.type === "checkbox");
    const heading = t instanceof HTMLHeadingElement && opts.fromHeading !== false;
    if (!tile && !heading) return;
    e.preventDefault();
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { cancelable: true }));
  });
}
