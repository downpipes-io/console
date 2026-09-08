// The three-way theme control: System / Light / Dark, persisted to localStorage under "dp-theme".
// Obsidian (dark) is the default skin when the preference is unset; the pre-paint
// inline script in index.html applies that default before first paint to avoid a
// flash, and THIS module is the runtime control that keeps the same contract.
//
// The mechanism is attribute-driven so there is no JS recolouring: a stored
// "light"/"dark" writes data-theme on <html> (the override wins over the media
// query); "system" removes the attribute so prefers-color-scheme applies. The
// tokens.css layer does the rest.

import { recordStorageBlocked } from "./client-diag/ring.ts";

export type ThemePref = "system" | "light" | "dark";

const STORAGE_KEY = "dp-theme";

// getThemePref reads the stored preference, defaulting to "dark" (Obsidian) when
// unset or unreadable, matching the pre-paint script exactly.
export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch (err) {
    // localStorage blocked; fall through to the default.
    recordStorageBlocked("local", "read", "theme", err);
  }
  return "dark";
}

// applyTheme writes (or clears) the data-theme attribute to realise a preference.
// "system" clears the attribute so the prefers-color-scheme media query applies;
// "light"/"dark" set the override.
function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", pref);
  }
}

// onThemeChange registers a callback that fires whenever setThemePref is called. Used
// by any live UI (e.g. the Settings radiogroup) that must reflect a toggle applied from
// a different surface (e.g. the command palette). Returns an unsubscribe function.
const themeListeners: Set<(pref: ThemePref) => void> = new Set();
export function onThemeChange(cb: (pref: ThemePref) => void): () => void {
  themeListeners.add(cb);
  return () => { themeListeners.delete(cb); };
}

// setThemePref persists and applies a preference. Persisting is best-effort (a
// blocked localStorage still applies for the session). Notifies any registered
// onThemeChange listeners after applying.
export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch (err) {
    // best-effort persistence; applying still works for this session.
    recordStorageBlocked("local", "write", "theme", err);
  }
  applyTheme(pref);
  // Isolate each subscriber so a future throwing listener can never stop the Settings
  // radiogroup's updateButtons from running (which would desync the selected highlight).
  for (const cb of themeListeners) {
    try { cb(pref); } catch { /* a single bad subscriber must not break the rest */ }
  }
}

// resolvedTheme reports the theme actually in effect right now (so a control can
// show the System option resolving to light or dark). Reads the media query when
// the preference is "system".
export function resolvedTheme(): "light" | "dark" {
  const pref = getThemePref();
  if (pref === "light" || pref === "dark") return pref;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// initTheme re-applies the stored preference at boot. The pre-paint script has
// already set the attribute; this keeps the in-memory control and the DOM in
// step, and is the single call main.ts makes on start.
export function initTheme(): void {
  applyTheme(getThemePref());
}
