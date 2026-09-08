// The deep-linkable DETAIL DRAWER. The richer
// entity-detail surface the dense screens open over a table so the operator keeps their
// place in the list: a header with a title + meta line + status badges, labelled
// sections, key-value rows, and a footer action row that groups routine actions left
// and the destructive action (in its danger treatment) to the right.
//
// THERE IS NO TABSET HERE, and its absence is a decision rather than an omission. The
// component shipped an optional `tabs` option (with `initialTab`, `onTabChange`, a
// roving-tabindex tablist and lazily-built panels) in the hi-fi component build of
// , and in the whole history of `src/` not one of the five callers ever
// passed it: the destination, downpipe, map-node, run and credential drawers each
// carry one to four short sections an operator opens the drawer to read at once, and
// putting half of any of them a click away hides what the drawer is for. Design-system
// 6.14 names the drawer tabset as an EXAMPLE of where tabs are used; its three shipped
// instances are the ROUTE tablists on /access, /notifications and /keys, which own a
// real URL each and build their own tablist on the shared `.drawer-tab*` CSS. Removed
// rather than left as a permanently unreachable control in the action
// catalogue. Restoring it is `git show` on this file, not a rewrite.
//
// It is built ON the shared overlay engine (dialog.ts: focus-trap, inert background,
// restore-focus, Esc, click-out) and the B1 drawer geometry, NOT a re-implementation of
// any of it: openDetailDrawer composes dialogSurface({variant:"drawer"}) + openOverlay,
// exactly as the simpler openDrawer (drawer.ts) does, and adds the richer body chrome.
// On Compact the CSS switches the geometry to a bottom sheet (the engine is identical).
//
// Deep-linkable (U1): the caller reflects the selected entity in the URL before opening
// and navigates back to the list URL in onClose, so the back button and shareable links
// work in the router-less-feeling SPA. The drawer does not touch the URL itself; it
// calls back.
//
// A11y (6.11): role="dialog" aria-modal with an accessible name (the title); focus
// moves in and is trapped; Esc closes; focus returns to the invoking control. Every
// server string is added via textContent (dom.ts), so there is no markup-injection
// surface.

import { recordGovGate } from "../lib/client-diag/ring.ts";
import type { ClientDiagAdminOp } from "../lib/client-diag/vocab.ts";
import { type Child, h, refuseWithReason } from "../lib/dom.ts";
import { dialogSurface, type OverlayHandle, openOverlay } from "./dialog.ts";
import { drawerSection as _drawerSection } from "./drawer.ts";

// A status badge-like chip to show beside the title (e.g. enabled/disabled, running).
// Kept as a pre-built node so the caller composes it from status.ts badge()/the dot.
export interface DetailDrawerOptions {
  // The drawer title (the entity name); the dialog's accessible name.
  title: string;
  // An optional meta line under the title (e.g. "KV - KV_uploads - daily"). Real text
  // or a built node; server strings are escaped by textContent.
  meta?: Child;
  // Optional badges/chips shown on the title row (built nodes from status.ts).
  badges?: Node[];
  // The drawer body.
  body?: Node;
  // The footer actions. Routine actions render left-to-right; an action flagged
  // danger:true is pushed to the right in the danger treatment. A destructive action's
  // handler is the CALLER's to route through the safe confirm flow; this only renders
  // the button.
  actions?: DrawerAction[];
  // Called on dismiss (Esc / click-out / close X). The caller navigates back to the
  // list URL here so the URL reflects the closed state.
  onClose?: () => void;
  // REQUIRED: an idempotency key naming the entity this drawer represents (e.g.
  // "downpipes-detail:<id>"), forwarded to openOverlay's own `key` guard (dialog.ts). A second
  // openDetailDrawer call with the SAME key, while the first is still open, is a no-op that
  // hands back the existing handle rather than stacking a duplicate drawer over it.
  //
  // this was OPTIONAL until every call site but one (sources-downpipes/detail.ts) shipped
  // without it, which is exactly how a screen re-render (app.ts's identity-resolved quiet
  // re-render, a fresh screen.render() outside the router, so closeAllOverlays never fires for
  // it) re-fired a deep link's "open this drawer" side effect and stacked a second
  // .overlay--drawer over the first, covering its Edit/Remove buttons. A caller-supplied,
  // optional key is a hazard a future call site can silently omit; making it REQUIRED moves the
  // guard from "remember to opt in" to "cannot compile without one" -- the compiler is the
  // propagation mechanism now, not a reviewer's memory. There is no reasonable default to derive
  // it FOR the caller (this component has no notion of the caller's entity id), so the key stays
  // caller-supplied; a stable value derived from whatever uniquely identifies the row (its id, or
  // a composite like `${downpipeId}:${runIndex}` when a bare id can repeat) is normally already
  // at hand at the call site (see the rowKey a caller's own table likely already computes).
  key: string;
  // Forwarded to openOverlay's focusReturn: the control to return focus to on close. Pass a
  // FUNCTION to have it re-evaluated at close time (a drawer opened by a route change that
  // rebuilds its invoking row needs to re-find the current row, not a detached captured node).
  // Omit it for the default (restore whatever had focus at open). B25.
  focusReturn?: HTMLElement | (() => HTMLElement | null);
}

export interface DrawerAction {
  label: string;
  onClick: () => void;
  // "secondary" (default) | "primary" | "danger". A danger action is grouped right.
  variant?: "secondary" | "primary" | "danger";
  // An optional leading icon (svgIcon node).
  icon?: Node;
  // Disabled-with-reason (a role gate): the button is disabled and carries the reason
  // as its title, never hidden-then-403 (the gate reads as governed).
  disabled?: boolean;
  disabledReason?: string;
  // gateOp (G252) names the privileged write this action WOULD have made, in the same closed op vocabulary the
  // admin-write rows use. It is supplied by the call site because only the call site knows, and it is what makes
  // a client-side role refusal visible at all: a greyed-out button makes NO request, so there is no 403 anywhere
  // and no audit event anywhere, and an Owner reporting that Delete is disabled has nothing to point support at.
  // The disabledReason is NOT recorded: it is human prose that names roles and can be reworded, and the op is
  // the durable fact.
  gateOp?: ClientDiagAdminOp;
  // tourId stamps the button with an inert data-tour-id, so a walk can pin its spotlight on the ACTION a
  // learner is being asked to take rather than on the prose beside it. No behaviour, and nothing the
  // genuine console reads: the tour and the training walk resolve anchors with querySelector.
  tourId?: string;
}

// openDetailDrawer mounts the drawer and returns the overlay handle (so a caller can
// close it programmatically, e.g. after a delete). It reuses the shared overlay engine.
export function openDetailDrawer(opts: DetailDrawerOptions): OverlayHandle {
  let handle: OverlayHandle;

  // The drawer body: the rich header chrome (meta + badges) sits at the top of the body
  // (the dialog header already owns the title + the close X), then the body itself.
  const bodyRoot = h("div", { class: "detail-drawer__content" });

  if (opts.meta !== undefined || (opts.badges?.length)) {
    const sub = h("div", { class: "detail-drawer__subhead" });
    if (opts.badges?.length) {
      const badgeRow = h("div", { class: "detail-drawer__badges" });
      for (const b of opts.badges) badgeRow.appendChild(b);
      sub.appendChild(badgeRow);
    }
    if (opts.meta !== undefined && opts.meta !== null && opts.meta !== false) {
      const metaEl = h("p", { class: "detail-drawer__meta" });
      if (typeof opts.meta === "string" || typeof opts.meta === "number") metaEl.appendChild(document.createTextNode(String(opts.meta)));
      else metaEl.appendChild(opts.meta as Node);
      sub.appendChild(metaEl);
    }
    bodyRoot.appendChild(sub);
  }

  if (opts.body) {
    bodyRoot.appendChild(opts.body);
  }

  // The footer action row, with routine actions left and the danger action grouped right.
  let footer: Node | null = null;
  if (opts.actions?.length) {
    footer = buildFooter(opts.actions);
  }

  const { surface } = dialogSurface({
    variant: "drawer",
    title: opts.title,
    body: bodyRoot,
    footer,
    onCloseClick: () => handle.close(),
  });

  handle = openOverlay({
    surface,
    variant: "drawer",
    dismissable: true,
    key: opts.key,
    ...(opts.onClose ? { onClose: opts.onClose } : {}),
    ...(opts.focusReturn !== undefined ? { focusReturn: opts.focusReturn } : {}),
  });

  return handle;
}

function buildFooter(actions: DrawerAction[]): HTMLElement {
  const footer = h("div", { class: "drawer-actions" });
  const routine = actions.filter((a) => a.variant !== "danger");
  const danger = actions.filter((a) => a.variant === "danger");

  for (const action of routine) {
    footer.appendChild(buildActionButton(action));
  }
  if (danger.length) {
    // The danger group is pushed right (the "danger zone" idiom: destructive actions
    // sit apart from the routine ones so a delete is never adjacent to a Run now).
    const dangerGroup = h("div", { class: "drawer-actions__danger" });
    for (const action of danger) dangerGroup.appendChild(buildActionButton(action));
    footer.appendChild(dangerGroup);
  }
  return footer;
}

function buildActionButton(action: DrawerAction): HTMLButtonElement {
  const cls =
    action.variant === "primary" ? "btn btn--primary btn--sm"
    : action.variant === "danger" ? "btn btn--danger btn--sm"
    : "btn btn--secondary btn--sm";
  // Disabled-with-reason, FOCUSABLE (Primer/Atlassian pattern): aria-disabled
  // keeps the button in the tab order so keyboard/AT users can discover it, and the
  // reason is announced via a visually-hidden description, not a hover-only title.
  const btn = h(
    "button",
    { "data-dp": "components-detail-drawer.button.action-button",
      class: cls,
      type: "button",
      ...(action.disabled ? { "aria-disabled": "true" } : {}),
    },
  ) as HTMLButtonElement;
  if (action.tourId !== undefined) btn.dataset.tourId = action.tourId;
  if (action.icon) btn.appendChild(action.icon);
  btn.appendChild(document.createTextNode(action.label));
  if (action.disabled && action.disabledReason) {
    // Through the SHARED primitive rather than a local copy of it: the reason becomes the control's
    // DESCRIPTION, so the name stays "Verify now" instead of announcing "Verify now : the engine has
    // not reported a run yet".
    refuseWithReason(btn, action.disabledReason);
  }
  // G252: the CLIENT-SIDE ROLE REFUSAL, recorded where it is actually shown. This is the only place the fact
  // exists: the button makes no request, so the engine never hears about it, and the refusal is a grey control
  // and a screen-reader line that die with the tab. Recorded only when the action is BOTH disabled and names the
  // op it would have made, so an ordinarily disabled control (a button greyed out because a form is empty or a
  // request is in flight) never produces a governance row it has nothing to do with.
  if (action.disabled === true && action.gateOp !== undefined) recordGovGate("role-gate-refusal-shown", action.gateOp);
  if (!action.disabled) btn.addEventListener("click", () => action.onClick());
  return btn;
}

// drawerSection is re-exported from drawer.ts (the canonical implementation) so
// screens can import everything they need from a single detail-drawer import.
// The duplicate body has been removed; drawer.ts is the single source of truth.
export { _drawerSection as drawerSection };

// kvRow is the standard key-value row for a drawer config section: a label column and
// a left-aligned value column (the .kv-row grid in tokens.css). The value is added via
// textContent when a string, so a server-supplied value cannot inject markup.
export function kvRow(label: string, value: Child): HTMLElement {
  const valueEl = h("span", { class: "kv-row__value" });
  if (typeof value === "string" || typeof value === "number") valueEl.appendChild(document.createTextNode(String(value)));
  else if (value !== null && value !== undefined && value !== false) valueEl.appendChild(value as Node);
  return h("div", { class: "kv-row" }, h("span", { class: "kv-row__label" }, label), valueEl);
}
