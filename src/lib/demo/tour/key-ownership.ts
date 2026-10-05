// Which keys the tour's keyboard layer may take (director.ts wireKeys). The walk binds ArrowRight, Enter,
// ArrowLeft, Space and Escape on the whole document, so it must first leave alone the keys that belong to the
// page under it: typing in a field, and the keys the setup surface and modal dialogs use themselves.

// keyBelongsToPage reports whether a key is the page's to handle, not the course's: the page already acted on
// it (defaultPrevented), or it was pressed inside the setup surface (.fb-page) or inside a modal dialog. Escape
// also belongs to the page while any modal dialog is open, because Escape is how the dialog closes. The arrow
// keys and Enter pressed elsewhere still move the course while a dialog is open: the walk's own drawer beats
// open a modal drawer, which keeps focus inside it, and the arrow keys are then a keyboard user's only way on.
// The persona fork is a non-modal dialog (aria-modal=false) and does not count. Duck-typed, as isTypingTarget
// is, so it reads the same in the browser and a headless DOM.
export function keyBelongsToPage(ev: KeyboardEvent, doc: Document): boolean {
  if (ev.defaultPrevented) return true;
  const el = ev.target as { closest?: (sel: string) => unknown } | null;
  if (el && typeof el.closest === "function" && el.closest(".fb-page, dialog[open], [role='dialog'][aria-modal='true']")) return true;
  return ev.key === "Escape" && typeof doc.querySelector === "function" && doc.querySelector("dialog[open], [role='dialog'][aria-modal='true']") !== null;
}

// isTypingTarget reports whether an event target is a text-entry control, so the keyboard layer never hijacks
// keys the visitor is typing into a field. It duck-types on tagName / isContentEditable rather than `instanceof
// Element`, so it does not depend on a global Element constructor and reads the same in the browser and a
// headless DOM.
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}
