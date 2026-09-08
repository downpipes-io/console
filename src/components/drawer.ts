// Drawer: a right-side panel for entity detail (a downpipe or a run), built on the
// shared overlay engine (dialog.ts: focus-trap, inert background, restore-focus,
// Esc, click-out). The drawer is deep-linkable: the caller reflects the selected entity in the URL
// when opening and returns to the list URL on close, restoring the back-button and shareability the
// router-less console lacked. On Compact it presents as a bottom sheet (the CSS
// switches the geometry; the engine is identical).
//
// The drawer keeps the operator in place in the list (progressive disclosure): it
// is a layer over the table, not a navigation away from it.

import { h } from "../lib/dom.ts";
import { openOverlay, dialogSurface, type OverlayHandle } from "./dialog.ts";

export interface DrawerOptions {
  title: string;
  body: Node;
  // An optional footer action row for the entity (e.g. Run now, Edit, Delete).
  footer?: Node | null;
  // Called when the drawer is dismissed (Esc / click-out / close X). The caller
  // uses this to navigate back to the list URL so the URL reflects the closed state.
  onClose?: () => void;
}

// openDrawer mounts the drawer and returns the handle. The caller is responsible
// for the URL: navigate to /downpipes/:id before openDrawer, and in onClose
// navigate back to /downpipes.
export function openDrawer(opts: DrawerOptions): OverlayHandle {
  let handle: OverlayHandle;

  const { surface } = dialogSurface({
    variant: "drawer",
    title: opts.title,
    body: opts.body,
    footer: opts.footer ?? null,
    onCloseClick: () => handle.close(),
  });

  handle = openOverlay({
    surface,
    variant: "drawer",
    dismissable: true,
    ...(opts.onClose ? { onClose: opts.onClose } : {}),
  });

  return handle;
}

// drawerSection is a small labelled block helper for the drawer body (config,
// runs, freshness). Keeps the section heading order correct (h3 under the dialog's
// h2 title) so the document outline stays valid.
export function drawerSection(title: string, ...content: Node[]): HTMLElement {
  const section = h("section", { class: "drawer-section" }, h("h3", { class: "drawer-section__title" }, title));
  for (const c of content) section.appendChild(c);
  return section;
}
