// A shared, dependency-free DOM shim for the console's DOM-touching validators.
//
// This is the SAME hand-rolled approach already proven inline in validate-api.ts and
// validate-passkey-login.ts (no jsdom, no new dependency, in keeping with the @noble-only
// runtime + no-new-npm-deps rule). It is extracted here so the stable-surface tests can
// render the REAL production components (dialog/modal/drawer/confirm/code-block/sparkline/
// wizard/table/error-view) under plain node without each test re-copying ~180 lines of shim.
//
// It exists ONLY to RUN the production code; it never re-implements anything under test.
// The surface it covers is exactly what those components touch:
//   - element / text / fragment / NS-element creation,
//   - the tree ops (append/remove/replaceChildren/firstChild/childElementCount/isConnected),
//   - attributes + the mapped properties (class/id/hidden/value/disabled/placeholder/checked/
//     textContent/innerHTML/tabIndex),
//   - classList / dataset / style (CSSOM setProperty + property writes, never a style attribute),
//   - event listeners + dispatch + click(),
//   - querySelector(All) including the attribute / :not() selectors the focus trap uses,
//   - document-level getElementById / querySelector / activeElement / contains,
//   - focus() tracking activeElement, and offsetParent (visible by default),
//   - window.setTimeout / clearTimeout and navigator.clipboard (a recording stub).
//
// NOTE on focus selectors: dialog.ts's FOCUSABLE_SELECTOR uses real CSS attribute selectors
// (a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), ...). selectorMatches
// understands tag, .class, #id, [attr], [attr="val"], and multiple :not([...]) clauses
// anywhere in a compound selector, so the focus trap resolves the same focusable set it would
// in a browser.
//
// The shim was split into cohesive sibling modules to keep each file under the per-file size
// budget; this file is now a thin barrel that re-exports the public surface so the 26 importing
// tests are unchanged:
//   - dom-shim-types.ts     interface declarations (ShimEvent, ShimEventInit, MemoryStorage, ...)
//   - dom-shim-env.ts       the mutable SHIM_DOC / SHIM_BODY singletons + clipboard / matchMedia state
//   - dom-shim-selectors.ts the CSS-subset selector matcher
//   - dom-shim-core.ts      ShimNode / ShimElement and makeEvent
//   - dom-shim-document.ts  installDomShim + the localStorage helpers
//   - dom-shim-bridges.ts   qs / qsa / textOf / classesOf / keydown / focus + flush helpers

export type { ShimEvent, ShimEventInit, MemoryStorage } from "./dom-shim-types.ts";
export { ShimNode, ShimElement } from "./dom-shim-core.ts";
export {
  clipboardWrites,
  resetClipboard,
  setClipboardReject,
  setMatchMediaDark,
} from "./dom-shim-env.ts";
export {
  installBlockedStorage,
  installDomShim,
  makeMemoryStorage,
  restoreMemoryStorage,
} from "./dom-shim-document.ts";
export {
  activeElement,
  classesOf,
  dispatchDocKey,
  dispatchWindowEvent,
  docClick,
  flushAsync,
  keydown,
  markConnected,
  qs,
  qsa,
  textOf,
} from "./dom-shim-bridges.ts";
