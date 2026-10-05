// Focus Flow chrome: the 3 px progress line (one denominator, the seven steps), the top bar (the brand
// mark, "Leave setup", the theme control) and the phone plan sheet. The top bar is not sticky; only the
// progress line is fixed, and it is 3 px tall.

import { h, svgIcon } from "../../../lib/dom.ts";
import { ICON_MONITOR, ICON_MOON, ICON_SUN } from "../../../lib/icons.ts";
import { navigate } from "../../../lib/nav.ts";
import { getThemePref, setThemePref, type ThemePref } from "../../../lib/theme.ts";
import { brandMark } from "../../../shell/brand.ts";

// progressLine fills by steps done plus the share of the current step's questions answered, so the line
// moves on every question, not only at a step's end. The value stays in whole steps.
export function progressLine(done: number, share = 0, question = ""): HTMLElement {
  const fill = h("div", { class: "fb-progress__fill" });
  fill.style.setProperty("--fb-fill", String(Math.max(0, Math.min(7, done + share)) / 7));
  return h(
    "div",
    { class: "fb-progress", role: "progressbar", "aria-label": "Setup progress", "aria-valuemin": "0", "aria-valuemax": "7", "aria-valuenow": String(done), "aria-valuetext": `${done} of 7 steps done${question}` },
    fill,
  );
}

// themeControl is the three-way System, Light, Dark control (lib/theme.ts), as pressed buttons.
export function themeControl(): HTMLElement {
  const opts: Array<{ id: ThemePref; label: string; icon: string }> = [
    { id: "system", label: "System", icon: ICON_MONITOR },
    { id: "light", label: "Light", icon: ICON_SUN },
    { id: "dark", label: "Dark", icon: ICON_MOON },
  ];
  const wrap = h("div", { class: "fb-theme", role: "group", "aria-label": "Theme" });
  const btns: HTMLButtonElement[] = [];
  const paint = (): void => {
    const cur = getThemePref();
    for (const b of btns) b.setAttribute("aria-pressed", String(b.dataset.pref === cur));
  };
  for (const o of opts) {
    const b = h("button", { "data-dp": "setup.button.paint", class: "fb-theme__btn", type: "button", dataset: { pref: o.id }, on: { click: () => { setThemePref(o.id); paint(); } } }, svgIcon(o.icon, { size: 14 }), o.label) as HTMLButtonElement;
    btns.push(b);
    wrap.appendChild(b);
  }
  paint();
  return wrap;
}

export function topBar(): HTMLElement {
  const leave = h("button", { "data-dp": "setup.button.leave", class: "fb-textbtn", type: "button", on: { click: () => navigate("/") } }, "Leave setup");
  return h(
    "header",
    { class: "fb-top" },
    h("div", { class: "fb-top__brand" }, brandMark({ size: 22 }), h("span", { class: "fb-top__label" }, "Setup")),
    h("div", { class: "fb-top__tools" }, leave, h("div", { class: "fb-top__theme" }, themeControl())),
  );
}
