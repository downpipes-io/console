// The auto-refresh preference (WCAG 2.2.2 Pause, Stop, Hide). The polling screens
// (Overview, Topology map) refresh in place on a cadence; auto-updating content
// must offer the operator a pause. This module is the single stored preference
// plus the shared page-header control, mirroring lib/theme.ts: best-effort
// persistence under "dp-auto-refresh" (a blocked localStorage still applies for
// the session via the module cache), listeners for live UI, "on" the default.
//
// Contract for a polling view: consult getAutoRefresh() in its schedulePoll()
// (skip scheduling when "paused"), and subscribe via onAutoRefreshChange to stop
// the timer on pause / refresh immediately on resume. Manual Refresh stays
// available regardless, pausing the cadence never removes the operator's
// ability to fetch.

import { h, svgIcon } from "./dom.ts";
import { ICON_PAUSE, ICON_PLAY } from "./icons.ts";
import { recordStorageBlocked } from "./client-diag/ring.ts";

export type AutoRefreshPref = "on" | "paused";

const STORAGE_KEY = "dp-auto-refresh";

// The session cache makes the preference coherent within a session even when
// localStorage is blocked (set() then get() must agree, or a paused poller
// would silently resume on its next schedule).
let cached: AutoRefreshPref | null = null;

const listeners: Set<(pref: AutoRefreshPref) => void> = new Set();

export function getAutoRefresh(): AutoRefreshPref {
  if (cached !== null) return cached;
  try {
    cached = localStorage.getItem(STORAGE_KEY) === "paused" ? "paused" : "on";
  } catch (err) {
    // A blocked localStorage silently RE-ENABLES auto-refresh against a motion-sensitivity pause on every
    // reload, which is the accessibility half of this gap and the one the customer feels.
    cached = "on";
    recordStorageBlocked("local", "read", "refresh-pref", err);
  }
  return cached;
}

export function setAutoRefresh(pref: AutoRefreshPref): void {
  cached = pref;
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch (err) {
    // Best-effort persistence; the session cache keeps this session coherent.
    recordStorageBlocked("local", "write", "refresh-pref", err);
  }
  for (const cb of listeners) {
    try {
      cb(pref);
    } catch {
      // Isolated: one subscriber throwing on a stale node must never stop the others.
    }
  }
}

export function onAutoRefreshChange(cb: (pref: AutoRefreshPref) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// autoRefreshToggle builds the page-header control: an action button whose label
// states the action it performs ("Pause auto-refresh" / "Resume auto-refresh"),
// flipping with the preference. Lifecycle follows the codebase idiom: screens are
// swapped without dispose, so the listener self-cleans when it fires detached.
export function autoRefreshToggle(): HTMLButtonElement {
  const btn = h("button", { "data-dp": "lib-refresh-pref.button.set-auto-refresh", class: "btn btn--ghost btn--sm", type: "button" }) as HTMLButtonElement;
  const paint = (pref: AutoRefreshPref): void => {
    btn.replaceChildren(
      svgIcon(pref === "on" ? ICON_PAUSE : ICON_PLAY, { size: 14 }),
      document.createTextNode(pref === "on" ? "Pause auto-refresh" : "Resume auto-refresh"),
    );
  };
  paint(getAutoRefresh());
  btn.addEventListener("click", () => {
    setAutoRefresh(getAutoRefresh() === "on" ? "paused" : "on");
  });
  const unsub = onAutoRefreshChange((pref) => {
    if (!btn.isConnected) {
      unsub();
      return;
    }
    paint(pref);
  });
  return btn;
}
