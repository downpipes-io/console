// A small, accessible "(i)" info tooltip: the progressive-disclosure primitive the calm
// ceremony / custody screens use to move explanatory prose OFF the page and behind a
// focusable trigger (calm-density budget: essentials visible,
// everything else one interaction away).
//
// The whole point is to let a screen show one short, load-bearing line and tuck the
// "why / how / the mechanics" into a tooltip the operator opens only if they want it. It
// is a real, keyboard-reachable control, not a hover-only title attribute (those are
// invisible to touch and to keyboard users, and the design system forbids hover-only
// affordances).
//
// Contract:
//   - infoTip(text, opts?) returns a small <button type="button" class="info-tip"> trigger
//     paired with a popover element (role="tooltip"). The button carries an accessible name
//     (aria-label, default "More information"), aria-expanded, and aria-describedby pointing
//     at the popover, so an assistive technology announces the explanatory text when the
//     trigger is focused AND when the popover opens.
//   - The popover content is set via textContent ONLY (never innerHTML / never a raw HTML
//     string), so an interpolated string can never inject markup into the in-account console
//     (the same textContent-first discipline lib/dom.ts enforces everywhere). A "<" in the
//     text is shown literally, not parsed.
//   - It shows on hover, on focus, and on click (a true toggle); Escape closes it and
//     returns focus to the trigger; a blur away from the trigger, or a click/touch/focus
//     OUTSIDE the widget, dismisses it. There are no inline on* handlers anywhere (CSP:
//     style-src/script-src 'self', no 'unsafe-inline'); every binding is addEventListener.
//   - prefers-reduced-motion is honoured by class alone: the popover's open/close is a CSS
//     visibility toggle, and the (optional) fade transition is disabled under the global
//     reduced-motion gate in tokens.css. The component adds no imperative animation.
//
// No network, no state beyond open/closed, no secret ever passes through here.

import { h, svgIcon } from "../lib/dom.ts";
import { ICON_INFO } from "../lib/icons.ts";

// A process-local monotonic counter gives each tooltip a stable, collision-free id for the
// aria-describedby wiring. Deterministic (not Math.random) so a validator can assert the
// wiring without guessing a random suffix.
let tipSeq = 0;

// TOOLTIP_LAYER_ID names the single, shared, fixed-position host every popover on the page can
// be moved into when its usual place (inline, relative to its own trigger) would be clipped by
// an ancestor's overflow. One layer for the whole document, created lazily on first need.
const TOOLTIP_LAYER_ID = "dp-info-tip-layer";

// tooltipLayer returns the shared layer, creating it once. pointer-events:none on the layer
// itself so an EMPTY layer never intercepts a click anywhere on the page; the popover moved
// into it opts back in (pointer-events:auto) so its text stays selectable.
function tooltipLayer(): HTMLElement {
  const existing = document.getElementById(TOOLTIP_LAYER_ID);
  if (existing) return existing;
  const layer = h("div", { id: TOOLTIP_LAYER_ID, class: "info-tip__layer" });
  document.body.appendChild(layer);
  return layer;
}

export interface InfoTipOptions {
  // The accessible name of the trigger button (what a screen reader announces for the
  // control itself). Defaults to "More information". Keep it specific where it helps, e.g.
  // { label: "About the operational key" }.
  label?: string;
}

// infoTip builds the trigger + its popover and returns the trigger element (the popover is
// a child of the same wrapper, positioned relative to it). Append the returned element
// inline next to the text it explains.
export function infoTip(text: string, opts: InfoTipOptions = {}): HTMLElement {
  const id = `info-tip-${++tipSeq}`;
  const label = opts.label ?? "More information";

  // The popover. role="tooltip" + the id is what aria-describedby on the trigger references.
  // textContent ONLY: the explanatory string is treated as text, never markup.
  const pop = h("span", {
    class: "info-tip__pop",
    id,
    role: "tooltip",
  });
  // Hide via the IDL property (not just the attribute) so the closed state is unambiguous
  // and the open/close path below toggles the same property it reads.
  pop.hidden = true;
  pop.textContent = text;

  // The trigger. A real button so it is in the tab order and operable by keyboard; the (i)
  // glyph is decorative (aria-hidden via svgIcon's no-label path) because the button already
  // carries an accessible name through aria-label.
  const trigger = h(
    "button",
    { "data-dp": "components-info-tip.button.trigger",
      class: "info-tip",
      type: "button",
      "aria-label": label,
      "aria-expanded": "false",
      "aria-describedby": id,
    },
    svgIcon(ICON_INFO, { size: 14 }),
  ) as HTMLButtonElement;

  // The wrapper keeps the trigger and the absolutely-positioned popover together so the
  // popover anchors to the trigger and an "outside click" can be detected with a single
  // contains() check. It is display:inline-flex so it sits inline with the text.
  const wrap = h("span", { class: "info-tip__wrap" }, trigger, pop);

  let open = false;

  // isInsideWidget covers the popover WHEREVER IT CURRENTLY LIVES: normally inside wrap, but
  // moved into the shared body-level layer while portalled (see positionPop below). A plain
  // `wrap.contains(target)` stopped being enough the moment portalling could relocate pop
  // outside wrap's own subtree, and would have reopened the outside-dismiss hole this
  // component was built to close.
  const isInsideWidget = (target: Node | null): boolean => !!target && (wrap.contains(target) || pop.contains(target));

  const setOpen = (next: boolean): void => {
    if (next === open) return;
    open = next;
    trigger.setAttribute("aria-expanded", next ? "true" : "false");
    pop.hidden = !next;
    if (next) {
      addDismissListeners();
      positionPop();
      window.addEventListener("resize", onViewportChange, { passive: true });
      window.addEventListener("scroll", onViewportChange, { capture: true, passive: true });
    } else {
      removeDismissListeners();
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      unPortal();
    }
  };

  // ---- Clip-aware positioning (the onboarding "How to" step's info-tip once painted 10%
  // hidden under .cx-stage-wrap, an overflow:hidden ancestor the carousel stage genuinely
  // needs for its card transition and must keep). The popover's own CSS (bottom/left/transform,
  // above and centred on the trigger) is the default and stays the default everywhere it
  // already works: this only steps in for the specific case an ancestor's overflow (or the
  // viewport itself) would clip it, and it moves the popover to a shared, unclipped layer
  // rather than widening or un-hiding the clipping ancestor.
  const onViewportChange = (): void => { if (open) positionPop(); };

  function clipRect(el: Element): { top: number; left: number; right: number; bottom: number } {
    let top = 0;
    let left = 0;
    let right = window.innerWidth;
    let bottom = window.innerHeight;
    for (let node = el.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      const cs = getComputedStyle(node);
      const clipsX = cs.overflowX !== "visible";
      const clipsY = cs.overflowY !== "visible";
      if (!clipsX && !clipsY) continue;
      const r = node.getBoundingClientRect();
      if (clipsX) { left = Math.max(left, r.left); right = Math.min(right, r.right); }
      if (clipsY) { top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom); }
    }
    return { top, left, right, bottom };
  }

  // positionPop measures the popover where its own CSS puts it (above the trigger, centred)
  // and leaves it there when that already paints whole. Only when a clipping ancestor or the
  // viewport would cut it does it move to the fixed, unclipped layer and compute an explicit
  // position anchored to the trigger, flipping below when there is no room above.
  function positionPop(): void {
    // typeof-guarded: absent under the lightweight test DOM shim (test/dom-shim.ts carries no
    // layout engine), where the default CSS position stands untouched and every existing
    // validator keeps grading the same click/focus/escape/dismiss contract it always has.
    if (typeof pop.getBoundingClientRect !== "function" || typeof window === "undefined") return;
    unPortal();
    const rect = pop.getBoundingClientRect();
    const clip = clipRect(wrap);
    const fits = rect.top >= clip.top && rect.bottom <= clip.bottom && rect.left >= clip.left && rect.right <= clip.right;
    if (fits) return;
    portalAndPlace(clip);
  }

  function portalAndPlace(clip: { top: number; left: number; right: number; bottom: number }): void {
    const layer = tooltipLayer();
    layer.appendChild(pop);
    pop.style.setProperty("position", "fixed");
    pop.style.setProperty("bottom", "auto");
    pop.style.setProperty("transform", "none");
    pop.style.setProperty("pointer-events", "auto");
    pop.style.setProperty("left", "0px");
    pop.style.setProperty("top", "0px");
    const tRect = trigger.getBoundingClientRect();
    const gap = 8; // the rendered gap the CSS default (bottom: calc(100% + var(--space-2))) already uses
    const margin = 8;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let top = tRect.top - ph - gap; // prefer the CSS default's own direction: above the trigger
    if (top < clip.top + margin) top = tRect.bottom + gap; // flip below when there is no room above
    top = Math.min(Math.max(top, clip.top + margin), clip.bottom - ph - margin);
    let left = tRect.left + tRect.width / 2 - pw / 2;
    left = Math.min(Math.max(left, clip.left + margin), clip.right - pw - margin);
    pop.style.setProperty("left", `${left}px`);
    pop.style.setProperty("top", `${top}px`);
  }

  // unPortal restores the popover to its normal place inside wrap and drops every inline
  // override, so the CSS default (relative to the trigger) is what the next open measures
  // against. A no-op when pop was never moved.
  function unPortal(): void {
    if (pop.parentElement !== wrap) wrap.appendChild(pop);
    // setProperty(prop, "") rather than removeProperty: the CSSOM-safe idiom this codebase
    // already standardises on (dom.ts never uses a style ATTRIBUTE string, only setProperty),
    // and setting a property to the empty string clears it exactly as removeProperty would.
    for (const prop of ["position", "bottom", "transform", "pointer-events", "left", "top"]) pop.style.setProperty(prop, "");
  }

  // Dismiss when focus or pointer goes outside the whole widget. Bound on the document only
  // while open, and torn down on close (and the global escape handler). focusin covers
  // keyboard tabbing away; pointerdown covers a click/tap elsewhere.
  const onOutsidePointer = (ev: Event): void => {
    if (isInsideWidget(ev.target as Node | null)) return;
    setOpen(false);
  };
  const onOutsideFocus = (ev: Event): void => {
    if (isInsideWidget(ev.target as Node | null)) return;
    setOpen(false);
  };
  const onDocKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape" && open) {
      ev.stopPropagation();
      setOpen(false);
      trigger.focus();
    }
  };
  let dismissBound = false;
  function addDismissListeners(): void {
    if (dismissBound) return;
    dismissBound = true;
    document.addEventListener("pointerdown", onOutsidePointer, true);
    document.addEventListener("focusin", onOutsideFocus, true);
    document.addEventListener("keydown", onDocKey, true);
  }
  function removeDismissListeners(): void {
    if (!dismissBound) return;
    dismissBound = false;
    document.removeEventListener("pointerdown", onOutsidePointer, true);
    document.removeEventListener("focusin", onOutsideFocus, true);
    document.removeEventListener("keydown", onDocKey, true);
  }

  // Click is a true toggle (so a touch / keyboard Enter both work and a second press closes).
  trigger.addEventListener("click", (ev) => {
    ev.preventDefault();
    setOpen(!open);
  });
  // Hover + focus reveal; the popover stays open on hover-out only if focus/keyboard opened
  // it. Pointer-leave from the wrapper closes a hover-opened popover unless the trigger holds
  // focus (so a keyboard user is never surprised by a mouse moving away).
  trigger.addEventListener("focus", () => setOpen(true));
  wrap.addEventListener("mouseenter", () => setOpen(true));
  wrap.addEventListener("mouseleave", (ev) => {
    if (document.activeElement === trigger) return;
    // relatedTarget is where the pointer went. A portalled popover no longer sits inside wrap's
    // own box, so leaving wrap for the (visually adjacent, DOM-relocated) popover must not
    // close it out from under the pointer.
    const related = (ev as MouseEvent).relatedTarget as Node | null;
    if (related && pop.contains(related)) return;
    setOpen(false);
  });
  // Blur away from the trigger (e.g. Shift+Tab) closes when the new focus is outside the
  // widget; the focusin capture handler covers the document-wide case, this is the local one.
  trigger.addEventListener("blur", () => {
    // Defer so the new activeElement is settled; if focus left the widget, close.
    window.setTimeout(() => {
      if (!wrap.contains(document.activeElement as Node | null)) setOpen(false);
    }, 0);
  });

  return wrap;
}

// _testInfoTip exposes the wired widget's parts for the validator without going through a
// browser: the trigger, the popover, the toggle, and the document-key handler the Escape
// path uses. It re-builds a tooltip and reaches in via the returned DOM so the test exercises
// the REAL bindings (not a re-implementation). DOM-only; no network, no secret.
/** @knipignore Test-only export exposing info-tip parts for the validator; retained as test API. */
export function _testInfoTipParts(text: string, opts: InfoTipOptions = {}): {
  wrap: HTMLElement;
  trigger: HTMLButtonElement;
  pop: HTMLElement;
} {
  const wrap = infoTip(text, opts);
  const trigger = wrap.querySelector(".info-tip") as HTMLButtonElement;
  const pop = wrap.querySelector(".info-tip__pop") as HTMLElement;
  return { wrap, trigger, pop };
}
