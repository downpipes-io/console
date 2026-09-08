// The document / window / navigator / localStorage installer for the DOM shim, split out of
// dom-shim.ts. installDomShim wires the singletons onto globalThis; the storage helpers back the
// preference libs. dom-shim.ts re-exports these so importers are unchanged.

import { clipboardWrites, env, getClipboardReject, getMatchMediaDark } from "./dom-shim-env.ts";
import { ShimElement, ShimNode } from "./dom-shim-core.ts";
import { selectorListMatches } from "./dom-shim-selectors.ts";
import type { MemoryStorage, ShimDocument, ShimEvent } from "./dom-shim-types.ts";

// installDomShim wires document/window/navigator/localStorage onto globalThis. Idempotent: a second
// call is a no-op once the shim document is in place. Call it BEFORE importing any module that
// touches document at load time (lib/dom.ts creates elements eagerly inside helpers, and several
// components create a singleton live region at module scope).
export function installDomShim(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if ((g.document as { __shim?: boolean } | undefined)?.__shim) return;

  const body = new ShimElement("body");
  body.connectedRoot_ = true;
  const html = new ShimElement("html");
  html.connectedRoot_ = true;
  html.appendChild(body);
  env.SHIM_BODY = body;

  const docListeners: Record<string, Array<{ fn: (ev: ShimEvent) => void; capture: boolean }>> = {};
  const shimDoc = buildShimDocument(body, html, docListeners);
  env.SHIM_DOC = shimDoc;

  g.document = shimDoc;
  g.Node = ShimNode;
  // HTMLElement maps to the shim element class so `node instanceof HTMLElement` guards in screen
  // code (e.g. add-source's post-attach focus hop) resolve true for shim-built elements.
  if (!("HTMLElement" in g)) g.HTMLElement = ShimElement;
  // Element likewise: app-external-link.ts's delegated click handler guards `start instanceof Element`
  // before calling closest() on it. Without this the check throws ReferenceError under node (no such
  // global) instead of resolving true for a shim-built click target.
  if (!("Element" in g)) g.Element = ShimElement;
  g.window = globalThis;
  // window-level (globalThis) addEventListener/dispatchEvent: node has no such global, and the shim
  // did not either until nav.ts started calling window.addEventListener("beforeunload", ...)
  // to catch a real navigation a registered leave guard cannot otherwise see. Same shape as the
  // document-level docListeners above, just keyed on globalThis instead of the shim document, so a
  // test can call dispatchWindowEvent to drive whatever a screen wired onto window.
  const winListeners: Record<string, Array<(ev: ShimEvent) => void>> = {};
  g.addEventListener = (type: string, fn: (ev: ShimEvent) => void) => {
    if (!winListeners[type]) winListeners[type] = [];
    winListeners[type].push(fn);
  };
  g.removeEventListener = (type: string, fn: (ev: ShimEvent) => void) => {
    const l = winListeners[type];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  };
  g.dispatchEvent = (ev: ShimEvent): boolean => {
    for (const fn of [...(winListeners[ev.type] ?? [])]) fn(ev);
    return !ev.defaultPrevented;
  };
  if (!("location" in g)) g.location = { origin: "https://console.test" };
  // matchMedia stub: theme.ts's resolvedTheme() consults it only for the "system" preference.
  // The match result is driven by matchMediaDark so a test can exercise both system branches.
  (g as Record<string, unknown>).matchMedia = (query: string) => ({
    media: query,
    matches: query.includes("dark") ? getMatchMediaDark() : false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
  // window === globalThis here, so setTimeout / clearTimeout already resolve to node's real timers
  // (the components call window.setTimeout for short transient UI: the "Copied" announce, the flash
  // class). We deliberately do NOT reassign them: window.setTimeout already works, and wrapping the
  // global in a function that calls setTimeout would recurse into itself.
  g.localStorage = makeMemoryStorage();
  // sessionStorage too, from the same factory.: src/lib/client-diag/reload-handoff.ts uses
  // sessionStorage to carry the console-build-check class across the one reload the update flow
  // performs, and the shim provided only localStorage. Node 25 happens to expose a native
  // sessionStorage and Node 22 does not, so validate-availability-r2-discrimination.ts passed on a
  // developer's Node 25 and failed on CI's Node 22, where safeStorage() returned null and the handoff
  // silently did nothing. A test asserting a storage handoff has to PROVIDE the storage rather than
  // depend on whichever runtime it happens to meet; the console ships to browsers, where it always
  // exists.
  g.sessionStorage = makeMemoryStorage();
  installNavigator(g);
}

// buildShimDocument constructs the SHIM_DOC object: the create/query/getById/contains methods over the
// shim tree and the document-level event listeners (add/remove/dispatchKey) backed by docListeners.
function buildShimDocument(
  body: ShimElement,
  html: ShimElement,
  docListeners: Record<string, Array<{ fn: (ev: ShimEvent) => void; capture: boolean }>>,
): ShimDocument {
  const collectAll = (sel: string): ShimNode[] => {
    const out: ShimNode[] = [];
    html.walk((n) => {
      if (n.nodeType === 1 && selectorListMatches(n, sel)) out.push(n);
    });
    return out;
  };

  return {
    __shim: true,
    body,
    documentElement: html,
    readyState: "complete",
    activeElement: body,
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (ns: string, tag: string) => new ShimElement(tag, ns),
    createTextNode: (t: string) => {
      const n = new ShimNode("text");
      n.text_ = t == null ? "" : String(t);
      return n;
    },
    createDocumentFragment: () => new ShimNode("fragment"),
    getElementById: (id: string) => {
      let found: ShimNode | null = null;
      html.walk((n) => {
        if (!found && n.nodeType === 1 && n.id === id) found = n;
      });
      return found;
    },
    querySelector: (sel: string) => collectAll(sel)[0] ?? null,
    querySelectorAll: (sel: string) => collectAll(sel),
    contains: (node: ShimNode | null) => (node ? html.contains(node) : false),
    addEventListener: (type: string, fn: (ev: ShimEvent) => void, capture?: boolean) => {
      docListeners[type] ||= []; docListeners[type].push({ fn, capture: !!capture });
    },
    removeEventListener: (type: string, fn: (ev: ShimEvent) => void) => {
      const l = docListeners[type];
      if (!l) return;
      const i = l.findIndex((e) => e.fn === fn);
      if (i >= 0) l.splice(i, 1);
    },
    // dispatchKey lets a test drive the document-level keydown handler dialog.ts installs (Esc / Tab).
    dispatchKey: (ev: ShimEvent) => {
      for (const e of [...(docListeners[ev.type] ?? [])]) e.fn(ev);
    },
  };
}

// installNavigator defines a configurable navigator with a recording clipboard stub so code-block's
// copyButton can run its writeText path. navigator is a read-only accessor global in node, so a plain
// assignment throws (the same reason validate-api leaves it untouched); this falls back through
// defineProperty on the global, then on the existing navigator's clipboard, then leaves it as-is.
function installNavigator(g: Record<string, unknown>): void {
  const navValue = {
    clipboard: {
      writeText: async (text: string): Promise<void> => {
        if (getClipboardReject()) throw new Error("clipboard blocked");
        clipboardWrites.push(text);
      },
    },
  };
  try {
    Object.defineProperty(g, "navigator", { value: navValue, configurable: true, writable: true });
  } catch {
    // If even defineProperty is refused, fall back to mutating the existing navigator's clipboard.
    const existing = g.navigator as { clipboard?: unknown } | undefined;
    if (existing) {
      try {
        Object.defineProperty(existing, "clipboard", {
          value: navValue.clipboard,
          configurable: true,
          writable: true,
        });
      } catch {
        /* last resort: leave navigator as-is; clipboard tests will see the real (absent) API */
      }
    }
  }
}

// makeMemoryStorage is a real in-memory localStorage (get/set/remove) so the preference libs
// (theme, view-mode) round-trip a write then a read, exercising both branches.
export function makeMemoryStorage(): MemoryStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => {
      m.set(k, String(v));
    },
    removeItem: (k) => {
      m.delete(k);
    },
    clear: () => m.clear(),
  };
}

// installBlockedStorage swaps localStorage for one that throws on every access, so the
// best-effort persistence fallbacks (the catch branches in theme.ts and friends) run.
export function installBlockedStorage(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.localStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
    clear: () => {},
  };
}

export function restoreMemoryStorage(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.localStorage = makeMemoryStorage();
}
