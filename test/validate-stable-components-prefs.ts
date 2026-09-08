// Group: the pure preference libs (lib/theme.ts + lib/aurora-pref.ts).
//
//   lib/theme.ts        init / get / set / subscribe + the data-theme attribute writes;
//                       system clears the attribute and resolves via matchMedia.
//   lib/aurora-pref.ts  default OFF; on/off round-trip; the data-aurora attribute;
//                       blocked-storage fallback; unsubscribe.
//
// Drives the REAL libs under the shared DOM shim; never re-implements them.

import {
  installBlockedStorage,
  restoreMemoryStorage,
  setMatchMediaDark,
  type ShimNode,
} from "./dom-shim.ts";
import type { Harness } from "./validate-stable-components-shared.ts";

export async function runPrefs(h: Harness): Promise<void> {
  // The single-consumer preference libs are imported HERE (a direct dynamic import, after the
  // shim is installed) rather than threaded through the shared context: a direct namespace
  // binding lets the dead-code gate resolve onAuroraChange's only usage in the suite.
  const theme = await import("../src/lib/theme.ts");
  const aurora = await import("../src/lib/aurora-pref.ts");

  // =========================================================================
  // 2. lib/theme.ts -- init / get / set / subscribe + the data-theme attribute
  // =========================================================================
  console.log("\n-- theme --");
  restoreMemoryStorage();
  {
    const root = document.documentElement;
    h.eq(theme.getThemePref(), "dark", "default theme is dark (Obsidian)");

    let seen: string | null = null;
    const off = theme.onThemeChange((p) => { seen = p; });

    theme.setThemePref("light");
    h.eq(theme.getThemePref(), "light", "set light round-trips");
    h.eq(seen, "light", "theme listener fired with light");
    h.eq((root as unknown as ShimNode).getAttribute("data-theme"), "light", "light writes data-theme=light on <html>");

    theme.setThemePref("dark");
    h.eq((root as unknown as ShimNode).getAttribute("data-theme"), "dark", "dark writes data-theme=dark");

    theme.setThemePref("system");
    h.eq((root as unknown as ShimNode).getAttribute("data-theme"), null, "system clears the data-theme attribute");

    // resolvedTheme: explicit prefs report themselves; system consults matchMedia.
    theme.setThemePref("light");
    h.eq(theme.resolvedTheme(), "light", "resolvedTheme reports light for the light pref");
    theme.setThemePref("system");
    setMatchMediaDark(true);
    h.eq(theme.resolvedTheme(), "dark", "resolvedTheme(system) resolves dark when matchMedia matches dark");
    setMatchMediaDark(false);
    h.eq(theme.resolvedTheme(), "light", "resolvedTheme(system) resolves light when matchMedia does not match dark");

    // initTheme re-applies the stored preference (the boot call).
    theme.setThemePref("dark");
    (root as unknown as ShimNode).removeAttribute("data-theme"); // simulate a fresh DOM
    theme.initTheme();
    h.eq((root as unknown as ShimNode).getAttribute("data-theme"), "dark", "initTheme re-applies the stored dark pref");

    off();
    // Reset to the default skin so later sections (overlay inert) start clean.
    theme.setThemePref("dark");
  }

  // =========================================================================
  // 2b. lib/aurora-pref.ts -- the opt-in backdrop: default OFF, round-trip,
  //     the data-aurora attribute, blocked storage, unsubscribe
  // =========================================================================
  console.log("\n-- aurora-pref --");
  restoreMemoryStorage();
  {
    const root = document.documentElement as unknown as ShimNode;
    h.eq(aurora.getAuroraPref(), "off", "default is off (Aurora is the opt-in, never the everyday surface)");
    h.eq(root.getAttribute("data-aurora"), null, "no data-aurora attribute until opted in");

    let seen: string | null = null;
    const off = aurora.onAuroraChange((p) => { seen = p; });

    aurora.setAuroraPref("on");
    h.eq(aurora.getAuroraPref(), "on", "set on round-trips");
    h.eq(seen, "on", "aurora listener fired with on");
    h.eq(root.getAttribute("data-aurora"), "on", "on writes data-aurora=on on <html>");

    aurora.setAuroraPref("off");
    h.eq(root.getAttribute("data-aurora"), null, "off clears the data-aurora attribute");

    // initAurora re-applies the stored preference (the shell-boot call).
    aurora.setAuroraPref("on");
    root.removeAttribute("data-aurora"); // simulate a fresh DOM
    aurora.initAurora();
    h.eq(root.getAttribute("data-aurora"), "on", "initAurora re-applies the stored on pref");

    // Unsubscribe stops further notifications.
    off();
    seen = null;
    aurora.setAuroraPref("off");
    h.eq(seen, null, "unsubscribed aurora listener does not fire");
  }
    // Blocked storage: get falls back to off, set still applies for the session.
    installBlockedStorage();
    h.eq(aurora.getAuroraPref(), "off", "blocked storage: get falls back to off");
    aurora.setAuroraPref("on"); // setItem throws internally; the catch keeps it best-effort
    h.eq((document.documentElement as unknown as ShimNode).getAttribute("data-aurora"), "on", "blocked storage: the attribute still applies for the session");
    aurora.setAuroraPref("off");
    restoreMemoryStorage();
}
