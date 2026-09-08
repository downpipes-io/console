// The rain-backdrop intensity preference (Off / Light / Medium / Storm). Mirrors
// aurora-pref.ts: best-effort localStorage under "dp-rain", a listener set so a control
// on one surface reflects a change applied from another, defaulting to "medium" (on, and
// actually visible, the former "light" drizzle was removed as too faint to see). The
// ambient field (components/ambient-field.ts) reads it and re-evaluates on change. There
// is no HTML attribute, no CSS depends on it; the canvas reads the value.

export type RainPref = "off" | "medium" | "storm";

const STORAGE_KEY = "dp-rain";
const VALUES: RainPref[] = ["off", "medium", "storm"];
import { recordStorageBlocked } from "./client-diag/ring.ts";

// getRainPref reads the stored preference, defaulting to "medium" when unset/unreadable.
// A legacy stored "light" (the removed drizzle tier) is no longer in VALUES, so it does
// not match and falls through to the "medium" default, an automatic migration on read.
export function getRainPref(): RainPref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v !== null && (VALUES as string[]).includes(v)) return v as RainPref;
  } catch (err) {
    // localStorage blocked; fall through to the default. G336: the fall-through is correct and it is also why a
    // locked-down profile has been invisible to support. A motion preference that will not stick is not
    // cosmetic: the operator set it because motion makes them unwell, and every reload undoes it.
    recordStorageBlocked("local", "read", "motion-pref", err);
  }
  return "medium";
}

const listeners: Set<(pref: RainPref) => void> = new Set();

// onRainChange registers a callback fired whenever setRainPref is called, so a control
// rendered on one surface reflects a change applied from another. Returns an unsubscribe.
export function onRainChange(cb: (pref: RainPref) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// setRainPref persists (best-effort) and notifies listeners.
export function setRainPref(pref: RainPref): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch (err) {
    // best-effort persistence; the in-session listeners still fire (G336: and the pack now says why it did not
    // outlive the session).
    recordStorageBlocked("local", "write", "motion-pref", err);
  }
  // Isolate each subscriber: rain has several (Settings control, the canary figure, the
  // ambient canvas), and one throwing on a stale node must never stop the others, that
  // would leave the Settings control's highlight out of step with the applied change.
  for (const cb of listeners) {
    try { cb(pref); } catch { /* a single bad subscriber must not break the rest */ }
  }
}
