// The accessibility preferences. One module
// owns every stored accessibility setting, mirroring lib/theme.ts exactly:
// attribute-driven on <html> (no JS recolouring), best-effort persistence under
// dp-a11y-* keys, listeners for live UI, and a System default wherever an OS
// preference exists (GDS rule: the console AUGMENTS prefers-* media queries and
// browser zoom, never competes with them).
//
// The pre-paint inline script in index.html applies the stored attributes before
// first paint (no flash); initA11yPrefs() re-applies at boot so the in-memory
// state and the DOM agree, exactly like initTheme().
//
// Consumers:
//   - tokens.css: [data-motion="reduced"], [data-contrast="more"],
//     [data-underlines="always"], [data-targets="large"], [data-focus="always"],
//     [data-status-palette="cvd"] blocks mirror their media-query twins.
//   - motionOK() gates every imperative animation (smooth scroll, view
//     transitions, WebGL loops) on BOTH the OS preference and the setting.
//   - toast.ts reads toastDuration at show time.
//   - the shell's keyboard layer consults singleKeyShortcuts.

// The allowed numeric option sets, named so the interface union and parsePref
// share one source of truth. A per-key lookup (NUMERIC_OPTIONS) means a future
// numeric field with no entry falls back to its default rather than silently
// borrowing toastDuration's allowlist.
export const TEXT_SIZE_OPTIONS = [100, 112.5, 125, 150] as const;
export const TOAST_DURATION_OPTIONS = [5000, 10000, 20000, 0] as const;

export interface A11yPrefs {
  // "system" defers to prefers-reduced-motion; "reduced" forces calm; "full" animates the
  // console's own canvases/transitions even when the OS prefers reduced motion (an explicit,
  // persisted operator choice - the only value that overrides an OS preference, and only here).
  motion: "system" | "reduced" | "full";
  // "system" defers to prefers-contrast; "more" forces the increased-contrast overlay.
  contrast: "system" | "more";
  // Root font-size scale, percent. 100 leaves the browser/root size untouched.
  textSize: (typeof TEXT_SIZE_OPTIONS)[number];
  // Underline links in prose always, or on hover only (the historical default).
  underlines: "always" | "hover";
  // Single-key shortcuts ("/" and the g-chords). Ctrl/Cmd-K always works.
  singleKeyShortcuts: "on" | "off";
  // Toast auto-dismiss in ms; 0 = stay until dismissed.
  toastDuration: (typeof TOAST_DURATION_OPTIONS)[number];
  // Colour-vision-friendly status palette (blue/orange separation). Status is
  // already shape + label redundant; this is comfort, not compliance.
  statusPalette: "default" | "cvd";
  // 44px controls everywhere (the AAA 2.5.5 tier; compact viewports already get it).
  targets: "default" | "large";
  // Show the focus ring on every focus, not only keyboard-determined focus.
  focusRing: "auto" | "always";
}

export const A11Y_DEFAULTS: A11yPrefs = {
  motion: "system",
  contrast: "system",
  textSize: 100,
  underlines: "hover",
  singleKeyShortcuts: "on",
  toastDuration: 5000,
  statusPalette: "default",
  targets: "default",
  focusRing: "auto",
};

const KEY_PREFIX = "dp-a11y-";

// Session cache so a blocked localStorage still behaves coherently (set() then
// get() must agree within the session), mirroring lib/refresh-pref.ts.
const cached: Partial<A11yPrefs> = {};

const listeners: Set<(prefs: A11yPrefs) => void> = new Set();

function read<K extends keyof A11yPrefs>(key: K): A11yPrefs[K] {
  if (key in cached) return cached[key] as A11yPrefs[K];
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY_PREFIX + key);
  } catch {
    raw = null;
  }
  const value = parsePref(key, raw);
  cached[key] = value;
  return value;
}

function parsePref<K extends keyof A11yPrefs>(key: K, raw: string | null): A11yPrefs[K] {
  if (raw === null) return A11Y_DEFAULTS[key];
  const def = A11Y_DEFAULTS[key];
  if (typeof def === "number") {
    const n = Number(raw);
    const numericOptions: Partial<Record<keyof A11yPrefs, readonly number[]>> = {
      textSize: TEXT_SIZE_OPTIONS,
      toastDuration: TOAST_DURATION_OPTIONS,
    };
    const allowed = numericOptions[key];
    if (allowed === undefined) return def as A11yPrefs[K];
    return (allowed.includes(n) ? n : def) as A11yPrefs[K];
  }
  const allowed: Record<string, string[]> = {
    motion: ["system", "reduced", "full"],
    contrast: ["system", "more"],
    underlines: ["always", "hover"],
    singleKeyShortcuts: ["on", "off"],
    statusPalette: ["default", "cvd"],
    targets: ["default", "large"],
    focusRing: ["auto", "always"],
  };
  return ((allowed[key] ?? []).includes(raw) ? raw : def) as A11yPrefs[K];
}

export function getA11yPrefs(): A11yPrefs {
  return {
    motion: read("motion"),
    contrast: read("contrast"),
    textSize: read("textSize"),
    underlines: read("underlines"),
    singleKeyShortcuts: read("singleKeyShortcuts"),
    toastDuration: read("toastDuration"),
    statusPalette: read("statusPalette"),
    targets: read("targets"),
    focusRing: read("focusRing"),
  };
}

export function setA11yPref<K extends keyof A11yPrefs>(key: K, value: A11yPrefs[K]): void {
  cached[key] = value;
  try {
    localStorage.setItem(KEY_PREFIX + key, String(value));
  } catch {
    // Best-effort persistence; the session cache keeps this session coherent.
  }
  applyA11yPrefs();
  const prefs = getA11yPrefs();
  for (const cb of listeners) cb(prefs);
}

export function onA11yChange(cb: (prefs: A11yPrefs) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// applyA11yPrefs realises the stored preferences as root attributes + the root
// font-size. "System"/default values REMOVE the attribute so the media queries
// (or the base styles) apply untouched, the same contract as data-theme -- EXCEPT
// data-motion, which is resolved to its EFFECTIVE value (see below).
export function applyA11yPrefs(): void {
  const root = document.documentElement;
  const p = getA11yPrefs();
  // data-motion carries the EFFECTIVE motion (motionOK), NOT the raw preference, so the opt-in
  // [data-motion="full"] animations (the canary's singing + flight, the Map flow dots, the refetch
  // shimmer) run whenever motion is actually ALLOWED, not only when the operator explicitly picks "Full".
  // "system" + OS-motion-on resolves to "full"; "system" + OS-reduced (or the "reduced" preference)
  // resolves to "reduced". This makes the stylesheet gate agree with the motionOK() predicate the
  // imperative animations already use, instead of leaving "system" with NO attribute, which silently froze
  // every opt-in animation for the DEFAULT preference (a live, flying canary sat static). Safe: nothing
  // keys on data-motion being absent (no :not([data-motion]) rules).
  setOrClear(root, "data-motion", motionOK() ? "full" : "reduced");
  setOrClear(root, "data-contrast", p.contrast === "more" ? "more" : null);
  setOrClear(root, "data-underlines", p.underlines === "always" ? "always" : null);
  setOrClear(root, "data-targets", p.targets === "large" ? "large" : null);
  setOrClear(root, "data-focus", p.focusRing === "always" ? "always" : null);
  setOrClear(root, "data-status-palette", p.statusPalette === "cvd" ? "cvd" : null);
  if (p.textSize === 100) root.style.removeProperty("font-size");
  else root.style.setProperty("font-size", `${p.textSize}%`);
}

function setOrClear(root: HTMLElement, attr: string, value: string | null): void {
  if (value === null) root.removeAttribute(attr);
  else root.setAttribute(attr, value);
}

// motionOK: the ONE predicate every imperative animation consults (the CSS gate
// covers stylesheet motion; this covers smooth scroll, the route cross-fade and
// the WebGL loop). False when the OS prefers reduced motion OR the operator set
// the in-app preference to "reduced"; TRUE when the operator explicitly chose
// "full" (their own persisted decision outranks the OS default for this console
// only, so an animated view is never frozen by an OS setting with no way to opt
// back in).
export function motionOK(): boolean {
  const pref = read("motion");
  if (pref === "reduced") return false;
  if (pref === "full") return true;
  return !(typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

// toastDurationMs: toast.ts reads this at show time (0 = until dismissed).
export function toastDurationMs(): number {
  return read("toastDuration");
}

// singleKeyShortcutsEnabled: the shell's keyboard layer consults this before
// handling "/" or a g-chord (WCAG 2.1.4: single-character shortcuts must be
// disableable). Modifier shortcuts are unaffected.
export function singleKeyShortcutsEnabled(): boolean {
  return read("singleKeyShortcuts") === "on";
}

// initA11yPrefs re-applies the stored preferences at boot (the pre-paint script
// has already set the attributes; this keeps the in-memory control in step).
export function initA11yPrefs(): void {
  applyA11yPrefs();
}
