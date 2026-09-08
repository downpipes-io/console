// The shared overlay engine behind the modal and the drawer. It owns the three things every dialog
// must get right and that the old console got wrong (it used native confirm/alert with no focus
// management at all):
//
//   1. focus moves IN on open and is TRAPPED (Tab/Shift-Tab cycle within),
//   2. the background is made INERT (the shell gets the `inert` attribute, with an
//      aria-hidden fallback) so neither the pointer nor a screen reader can reach
//      it,
//   3. focus RETURNS to the invoking control on close.
//
// Esc closes the topmost layer. A stack supports nested overlays (a confirm raised
// from within a drawer). Motion is a short fade/scale gated on reduced motion by
// the global rule in tokens.css. No framework, no dependency; just the DOM.

import { clear, h, svgIcon } from "../lib/dom.ts";
import { ICON_ALERT } from "../lib/icons.ts";

// A mounted overlay handle. close() tears it down and restores focus; the el is the
// backdrop wrapper (so a caller can query within it if needed).
export interface OverlayHandle {
  el: HTMLElement;
  close: () => void;
}

interface OverlayEntry {
  backdrop: HTMLElement;
  surface: HTMLElement;
  // A resolver evaluated at CLOSE time (see resolveFocusReturn). The default captures the
  // open-time activeElement; a caller can pass a function to re-find its invoking control.
  focusReturn: () => HTMLElement | null;
  onClose: (() => void) | undefined;
  // The optional idempotency key this entry was opened with (see openOverlay's `key` option).
  // undefined for every ordinary overlay (modals, confirms, wizards): the guard below only ever
  // matches a caller that deliberately opts in.
  key: string | undefined;
}

// The live overlay stack. The topmost entry owns Esc and the focus trap.
const stack: OverlayEntry[] = [];

// One document-level keydown handler drives Esc + Tab trapping for the topmost
// overlay only, so nested overlays behave correctly and there is a single listener.
let keyHandlerInstalled = false;

function installKeyHandler(): void {
  if (keyHandlerInstalled) return;
  keyHandlerInstalled = true;
  document.addEventListener(
    "keydown",
    (ev: KeyboardEvent) => {
      const top = stack[stack.length - 1];
      if (!top) return;
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        teardown(top);
        return;
      }
      if (ev.key === "Tab") {
        trapTab(ev, top.surface);
      }
    },
    true, // capture: own the keys before the page (the background is inert anyway)
  );
}

// The elements made inert while an overlay is open: everything in #app that is not
// the overlay root. We toggle a single attribute on the whole app subtree (#app,
// which holds the skip link + the shell) so the cost is O(1); the overlay backdrop is
// appended to document.body (a sibling of #app), so it stays interactive.
function setBackgroundInert(on: boolean): void {
  const target = document.getElementById("app") ?? document.querySelector<HTMLElement>(".shell");
  if (!target) return;
  if (on) {
    // `inert` removes the subtree from the tab order and from the a11y tree, and
    // blocks pointer events. aria-hidden is a belt-and-braces fallback for engines
    // that lag on inert (kept in step so it is cleared together).
    target.setAttribute("inert", "");
    target.setAttribute("aria-hidden", "true");
  } else {
    target.removeAttribute("inert");
    target.removeAttribute("aria-hidden");
  }
}

// openOverlay mounts a backdrop + a surface, traps focus, inerts the background,
// and returns a handle. `surface` is the dialog element (role/aria set by the
// caller: modal sets role="dialog" aria-modal, drawer the same). `labelledBy` is
// the id of the title element for the accessible name. `dismissable` (default true)
// allows click-out + Esc; a destructive confirm may keep it true (Cancel is the
// safe default) but never auto-confirms.
export function openOverlay(opts: {
  surface: HTMLElement;
  variant: "modal" | "drawer";
  onClose?: () => void;
  dismissable?: boolean;
  // The element to focus on open; defaults to the first focusable in the surface,
  // falling back to the surface itself. For a destructive dialog the caller passes
  // the Cancel button so focus never lands on the dangerous control (F-review).
  initialFocus?: HTMLElement | null;
  // An OPTIONAL idempotency key naming the ENTITY this overlay represents (e.g.
  // "downpipes-detail:<id>"). Omitted by every ordinary caller (confirms, modals, the
  // create/edit/import wizards), which stack exactly as before: this parameter changes
  // NOTHING unless a caller opts in.
  //
  // When a caller does pass a key and an overlay with the SAME key is already mounted,
  // this call is a no-op: it returns the ALREADY-OPEN overlay's handle instead of building
  // and stacking a second, visually identical surface on top of it. This is the fix for a
  // console re-render stacking a duplicate deep-linked drawer: app.ts's
  // reRenderCurrentScreenForResolvedIdentity quietly re-paints the current screen once the
  // boot-time whoami resolves (a fresh screen.render() -> a fresh load()), and that re-render
  // does NOT go through the router (so installAfterEach's closeAllOverlays never runs for
  // it) -- a route-driven "open this deep-linked drawer" side effect then fires a second
  // time while the first drawer is still mounted (the second .overlay--drawer covered the first
  // one's Edit button). Keying the drawer by the entity id
  // makes the second open a safe no-op instead of a stack. A confirm or any other unkeyed
  // overlay raised over a keyed drawer is unaffected: it never collides on a key.
  key?: string;
  // The control to return focus to on close. Defaults to whatever had focus at OPEN time (the
  // invoking control), restored guarded by document.contains. Pass a FUNCTION to have it
  // re-evaluated at CLOSE time instead: a drawer opened by a route change re-runs the screen's
  // load() and rebuilds the invoking row, detaching the open-time node, so a captured node would
  // be gone by close and focus would fall back to <main>. A resolver re-finds the current row
  // (e.g. by its data-key) so a keyboard user returns to the row they activated (B25).
  focusReturn?: HTMLElement | (() => HTMLElement | null);
}): OverlayHandle {
  if (opts.key !== undefined) {
    const existing = stack.find((e) => e.key === opts.key);
    if (existing) return { el: existing.backdrop, close: () => teardown(existing) };
  }

  installKeyHandler();
  const dismissable = opts.dismissable !== false;

  const backdrop = h("div", {
    class: `overlay overlay--${opts.variant}`,
    // The backdrop is presentational; the surface carries the dialog semantics.
  });
  backdrop.appendChild(opts.surface);

  if (dismissable) {
    backdrop.addEventListener("mousedown", (ev: MouseEvent) => {
      // Click-out only when the press starts on the backdrop itself, so a drag that
      // ends on the backdrop (text selection inside the dialog) does not dismiss.
      if (ev.target === backdrop) {
        const entry = stack[stack.length - 1];
        if (entry && entry.backdrop === backdrop) teardown(entry);
      }
    });
  }

  const entry: OverlayEntry = {
    backdrop,
    surface: opts.surface,
    focusReturn: resolveFocusReturn(opts.focusReturn),
    onClose: opts.onClose,
    key: opts.key,
  };

  // Only the first overlay inerts the background; nested overlays sit above an
  // already-inert background (and the previous surface is itself inerted below).
  if (stack.length === 0) setBackgroundInert(true);
  else inertElement(stack[stack.length - 1]!.surface, true);

  stack.push(entry);
  document.body.appendChild(backdrop);

  // Move focus in. Prefer the caller's choice, then the first focusable, then the
  // surface (which is tabindex -1 so it can hold focus).
  const focusTarget =
    opts.initialFocus ?? firstFocusable(opts.surface) ?? opts.surface;
  // A microtask so the element is laid out (and any entrance class applied) first.
  queueMicrotask(() => focusTarget.focus());

  return {
    el: backdrop,
    close: () => teardown(entry),
  };
}

function teardown(entry: OverlayEntry): void {
  const idx = stack.indexOf(entry);
  if (idx < 0) return;
  stack.splice(idx, 1);
  entry.backdrop.remove();

  if (stack.length === 0) setBackgroundInert(false);
  else inertElement(stack[stack.length - 1]!.surface, false);

  // Restore focus to the invoking control (F-review: focus returns on close). The resolver is
  // evaluated NOW, at close, so a caller whose invoking element was rebuilt by a reload can
  // re-find the current one; a resolver that finds nothing (or a detached node) leaves focus be.
  const focusTarget = entry.focusReturn();
  if (focusTarget && document.contains(focusTarget)) {
    focusTarget.focus();
  }
  entry.onClose?.();
}

// resolveFocusReturn normalises openOverlay's focusReturn option into a resolver evaluated at
// CLOSE time. Undefined (the default for every caller) or a plain element captures the node NOW
// (the pre-B25 behaviour: whatever had focus at open, restored if still in the document). A
// function is kept as-is and re-evaluated at close, so a caller whose invoking element is rebuilt
// by a reload re-finds the current one instead of restoring a detached node (B25).
function resolveFocusReturn(opt: HTMLElement | (() => HTMLElement | null) | undefined): () => HTMLElement | null {
  if (typeof opt === "function") return opt;
  const node = opt ?? ((document.activeElement as HTMLElement | null) ?? null);
  return () => node;
}

function inertElement(el: HTMLElement, on: boolean): void {
  if (on) el.setAttribute("inert", "");
  else el.removeAttribute("inert");
}

// closeAllOverlays tears down every open overlay WITHOUT invoking their onClose
// callbacks. The router calls this on a real navigation so a drawer/modal does not
// outlive the screen it belonged to (and so a drawer's "navigate back to the list"
// onClose does not fight the navigation that is already happening). It restores the
// background interactivity and is safe to call when nothing is open. Focus
// restoration (entry.focusReturn) is intentionally skipped here: the router renders a
// new screen that manages its own focus, so restoring focus to the prior trigger
// would land focus on an element about to be replaced.
export function closeAllOverlays(): void {
  if (stack.length === 0) return;
  for (const entry of stack) entry.backdrop.remove();
  stack.length = 0;
  setBackgroundInert(false);
}

// trapTab keeps Tab/Shift-Tab within the surface (focus trap). When focus is at an edge it wraps; if nothing is focusable it holds
// focus on the surface.
function trapTab(ev: KeyboardEvent, surface: HTMLElement): void {
  const focusables = focusableWithin(surface);
  if (focusables.length === 0) {
    ev.preventDefault();
    surface.focus();
    return;
  }
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const active = document.activeElement;
  if (ev.shiftKey) {
    if (active === first || active === surface) {
      ev.preventDefault();
      last.focus();
    }
  } else {
    if (active === last) {
      ev.preventDefault();
      first.focus();
    }
  }
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => !el.hasAttribute("disabled") && el.tabIndex !== -1 && isVisible(el),
  );
}

function firstFocusable(container: HTMLElement): HTMLElement | null {
  return focusableWithin(container)[0] ?? null;
}

function isVisible(el: HTMLElement): boolean {
  // offsetParent is null for display:none; a dialog is on-screen so this is enough
  // (we deliberately avoid getComputedStyle for cost on every Tab).
  return el.offsetParent !== null || el === document.activeElement;
}

// dialogSurface builds the standard dialog surface element (the inner panel) with
// the correct ARIA, a title, an optional close button, a body, and an optional
// footer action row. Shared by modal() and drawer() so the semantics never drift.
export function dialogSurface(opts: {
  variant: "modal" | "drawer";
  title: string;
  body: Node;
  footer?: Node | null;
  // Whether to render a header close button (an icon X). Default true.
  closeButton?: boolean;
  onCloseClick?: () => void;
  describedById?: string;
  // An OPTIONAL small tokenised icon chip rendered beside the title (warn / danger), so the dialog's
  // chrome itself carries a severity cue before the operator reads the title or body copy. Omitted by
  // every existing caller today, so this is purely additive: no chip, no layout change, no behaviour
  // change for a caller that does not pass it.
  severity?: "warn" | "danger";
}): { surface: HTMLElement; titleId: string } {
  const titleId = `dlg-title-${crypto.randomUUID().slice(0, 8)}`;
  const surface = h("div", {
    class: `dialog dialog--${opts.variant}`,
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": titleId,
    ...(opts.describedById ? { "aria-describedby": opts.describedById } : {}),
    tabindex: "-1",
  });

  const heading = h("div", { class: "dialog__heading" });
  if (opts.severity) heading.appendChild(severityChip(opts.severity));
  heading.appendChild(h("h2", { class: "dialog__title", id: titleId }, opts.title));
  const header = h("div", { class: "dialog__header" }, heading);
  if (opts.closeButton !== false) {
    // The close X is hand-drawn rather than imported from icons.ts (closeXIcon below).
    const closeBtn = h(
      "button",
      { "data-dp": "components-dialog.button.close",
        class: "btn btn--ghost btn--icon btn--sm dialog__close",
        type: "button",
        "aria-label": "Close",
        on: { click: () => opts.onCloseClick?.() },
      },
    );
    closeBtn.appendChild(closeXIcon());
    header.appendChild(closeBtn);
  }

  const body = h("div", { class: "dialog__body" });
  body.appendChild(opts.body);

  surface.appendChild(header);
  surface.appendChild(body);
  if (opts.footer) {
    const footer = h("div", { class: "dialog__footer" });
    footer.appendChild(opts.footer);
    surface.appendChild(footer);
  }
  return { surface, titleId };
}

// A tiny inline X, kept hand-drawn rather than switching to icons.ts's ICON_CLOSE (svgIcon and
// icons.ts are now imported anyway, for the severity chip below, so this is a minimal-diff choice,
// not a cycle concern). The innerHTML below is a fixed string literal with no interpolation or user
// input, so there is no injection surface.
function closeXIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = '<path d="M6 6 18 18"/><path d="M18 6 6 18"/>';
  return svg;
}

// severityChip renders the dialog header's OPTIONAL severity cue: a small tokenised icon chip (warn
// / danger) using the same alert glyph the banner family already uses for both tones (feedback.ts),
// so a dialog's chrome signals weight before the operator reads any copy. It sits beside the visible
// title text, so it is decorative (aria-hidden): the title and body still carry the actual meaning
// for assistive tech.
function severityChip(severity: "warn" | "danger"): HTMLElement {
  const chip = h("span", { class: `dialog__severity dialog__severity--${severity}`, "aria-hidden": "true" });
  chip.appendChild(svgIcon(ICON_ALERT, { size: 16 }));
  return chip;
}

// clearNode is a re-export of the dom.ts clear helper for callers that rebuild a dialog body in place.
export { clear as clearNode };

// isOverlayOpen reports whether ANY overlay is currently mounted (modal, drawer, confirm,
// wizard step, or the command palette: every one of them is built via dialogSurface and
// mounted through openOverlay, the console's one sanctioned path to a dialog -- "there is
// NO native alert()/confirm() anywhere in the console; every confirmation and notice routes
// through these", header comment above). Consulted by the shell's global key layer
// (shell/keyboard.ts) so a chord typed on a non-input element inside an open dialog does not
// fall through to a document-level navigation and abandon it. Because this reads the overlay
// engine's own mount count rather than enumerating dialog CSS classes or ARIA roles, it cannot
// miss a modal SHAPE a caller invents later: any surface opened through openOverlay is counted
// by construction, and a surface that skips openOverlay already violates the existing "kill
// the native dialogs" mandate before this function is any part of the picture. Appended at the
// end of the file (rather than beside `stack` above) so it never shifts the line number of any
// existing data-dp hook the functional-catalogue census tracks by file:line.
export function isOverlayOpen(): boolean {
  return stack.length > 0;
}
