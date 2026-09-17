// Mutable singletons and recorded state for the DOM shim, split out so the core node classes and
// the document installer can share SHIM_DOC / SHIM_BODY and the feature flags without importing
// each other (that would form a runtime cycle). dom-shim.ts re-exports the public helpers so
// importers are unchanged. This module depends only on the type declarations.

// ShimNode comes from core, which DEFINES it. dom-shim-types imports it for its own declarations but
// does not re-export it, so naming it here was reaching for something that module does not publish.
import type { ShimNode } from "./dom-shim-core.ts";
import type { ShimDocument } from "./dom-shim-types.ts";

// env is the single mutable holder the node classes and the document installer both read/write.
// SHIM_DOC and SHIM_BODY are populated by installDomShim; before that they are null and the focus
// helpers are not exercised (every test installs the shim before mounting a tree).
export const env: { SHIM_DOC: ShimDocument | null; SHIM_BODY: ShimNode | null } = {
  SHIM_DOC: null,
  SHIM_BODY: null,
};

// clipboardWrites records every navigator.clipboard.writeText call so a test can assert WHAT was
// copied (and, for the no-custody hygiene checks, that a concealed value was the real value copied
// rather than the dot run shown on screen). It never logs the value; the test inspects it locally.
export const clipboardWrites: string[] = [];
let clipboardShouldReject = false;

// matchMediaDark drives the matchMedia("(prefers-color-scheme: dark)") result so a test can
// exercise theme.ts's resolvedTheme() "system" branch resolving to dark vs light.
let matchMediaDark = true;
export function setMatchMediaDark(dark: boolean): void {
  matchMediaDark = dark;
}
export function getMatchMediaDark(): boolean {
  return matchMediaDark;
}

export function setClipboardReject(reject: boolean): void {
  clipboardShouldReject = reject;
}
export function getClipboardReject(): boolean {
  return clipboardShouldReject;
}

export function resetClipboard(): void {
  clipboardWrites.length = 0;
  clipboardShouldReject = false;
}
