// The OPT-IN Aurora backdrop control. Aurora is a faint colour wash behind the app canvas,
// "an opt-in progressive enhancement, not the everyday surface", so it is OFF unless the
// operator turns it on in Settings; the choice persists to localStorage under "dp-aurora".
//
// The mechanism mirrors lib/theme.ts exactly and is attribute-driven so there is no JS
// painting: "on" writes data-aurora="on" on <html> and tokens.css shows the fixed
// .aurora-field layer behind the shell; "off" removes the attribute and the layer hides.
// The wash is purely decorative (aria-hidden, pointer-events none, carries no information),
// its drift animations sit behind the global prefers-reduced-motion gate, and print hides it.

export type AuroraPref = "on" | "off";

const STORAGE_KEY = "dp-aurora";

// getAuroraPref reads the stored preference, defaulting to "off" (the everyday surface is
// the calm canvas; Aurora is the opt-in) when unset or unreadable.
export function getAuroraPref(): AuroraPref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "on" || v === "off") return v;
  } catch {
    // localStorage blocked; fall through to the default.
  }
  return "off";
}

// applyAurora writes (or clears) the data-aurora attribute to realise a preference; the
// tokens.css layer does the rest (no JS recolouring).
function applyAurora(pref: AuroraPref): void {
  const root = document.documentElement;
  if (pref === "on") {
    root.setAttribute("data-aurora", "on");
  } else {
    root.removeAttribute("data-aurora");
  }
}

// onAuroraChange registers a callback that fires whenever setAuroraPref is called, so a
// control rendered on one surface reflects a toggle applied from another. Returns an
// unsubscribe function.
const auroraListeners: Set<(pref: AuroraPref) => void> = new Set();
export function onAuroraChange(cb: (pref: AuroraPref) => void): () => void {
  auroraListeners.add(cb);
  return () => { auroraListeners.delete(cb); };
}

// setAuroraPref persists and applies a preference. Persisting is best-effort (a blocked
// localStorage still applies for the session). Notifies listeners after applying.
export function setAuroraPref(pref: AuroraPref): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // best-effort persistence; applying still works for this session.
  }
  applyAurora(pref);
  for (const cb of auroraListeners) cb(pref);
}

// initAurora applies the stored preference at boot (called once when the shell builds).
// Unlike the theme there is no pre-paint script: the default is off, so the worst case for
// an opted-in operator is the wash fading in at boot rather than a flash of the wrong skin.
export function initAurora(): void {
  applyAurora(getAuroraPref());
}
