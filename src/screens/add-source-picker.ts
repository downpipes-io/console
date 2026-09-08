// The source picker for the "attach a source manually" screen (add-source.ts): the Step 1
// segmented radiogroup (the four binding stores, with token sources appended later by the screen
// when discovery advertises them) plus its roving-tabindex arrow-key handler. Pulled out of the
// screen so the orchestration closure stays small. The button maps stay owned by the screen (the
// other steps mutate them), so they are passed in; the pick is delivered back through onStorePick.
// The markup and keyboard behaviour are byte-identical to the inlined version.
//
// House: Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../lib/dom.ts";
import { STORE_TYPES, storeTypeLabel, type StoreType } from "../lib/add-source.ts";
import { TOKEN_SOURCE_TYPES, type TokenSourceType } from "../lib/token-source.ts";
import { storeIcon } from "./add-source-glyphs.ts";

// SourcePicker is the built Step 1 control: the radiogroup element and the per-type hint paragraph
// the screen updates as the selection changes.
export interface SourcePicker {
  typeSeg: HTMLElement;
  typeHint: HTMLElement;
}

// buildSourcePicker renders the four binding-store radio buttons into typeSeg and installs the
// roving-tabindex arrow handler over the WHOLE radiogroup (stores + any token rows the screen
// appends). typeButtons is populated here; tokenButtons stays empty until the screen appends rows.
// checkedButton returns the currently-checked button (a store, or a token row), so the handler can
// step from the live selection. onStorePick fires when a store button is clicked.
export function buildSourcePicker(
  typeButtons: Map<StoreType, HTMLButtonElement>,
  tokenButtons: Map<TokenSourceType, HTMLButtonElement>,
  currentType: StoreType,
  checkedButton: () => HTMLButtonElement,
  onStorePick: (t: StoreType) => void,
): SourcePicker {
  const typeSeg = h("div", { class: "type-seg", role: "radiogroup", "aria-label": "Source to back up" });
  const typeHint = h("p", { class: "field__hint" });
  for (const t of STORE_TYPES) {
    const checked = t === currentType;
    const btn = h(
      "button",
      { "data-dp": "add-source-picker.radio.store-pick", class: "type-seg__btn", type: "button", role: "radio", "aria-checked": checked ? "true" : "false", tabindex: checked ? "0" : "-1" },
      svgIcon(storeIcon(t), { size: 14 }),
      storeTypeLabel(t),
    ) as HTMLButtonElement;
    btn.addEventListener("click", () => onStorePick(t));
    typeButtons.set(t, btn);
    typeSeg.appendChild(btn);
  }
  // pickOrder is the live roving-tabindex order (stores first, then any appended token buttons). The
  // currently-checked button (a store, or a token row) is the one tab lands on.
  const pickOrder = (): HTMLButtonElement[] => [
    ...STORE_TYPES.map((t) => typeButtons.get(t)!),
    ...TOKEN_SOURCE_TYPES.flatMap((t) => { const b = tokenButtons.get(t); return b ? [b] : []; }),
  ];
  // Roving-tabindex arrow-key handler over the WHOLE radiogroup (stores + token rows), matching the
  // sources screen. A store target runs the binding flow; a token target runs the hand-off.
  typeSeg.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft" && ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "Home" && ev.key !== "End") return;
    const order = pickOrder();
    const idx = order.indexOf(checkedButton());
    let next = idx < 0 ? 0 : idx;
    if (ev.key === "ArrowRight" || ev.key === "ArrowDown") next = (next + 1) % order.length;
    else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") next = (next - 1 + order.length) % order.length;
    else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = order.length - 1;
    ev.preventDefault();
    order[next]!.click();
    order[next]!.focus();
  });

  return { typeSeg, typeHint };
}
