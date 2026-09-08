// Coverage validator for the accessibility preferences module (src/lib/a11y-prefs.ts): the stored
// per-setting reader/writer that mirrors lib/theme.ts (attribute-driven on <html>, best-effort
// localStorage under dp-a11y-* keys, live listeners, and a System default wherever an OS preference
// exists). The other validators touch this module only incidentally (shell/keyboard reads the
// single-key flag, live-flow checks the data-motion attribute), so none of them drive the parser
// arms, applyA11yPrefs across every attribute, motionOK over its OS branches, onA11yChange, the
// storage-blocked catch arms, or the single-key reader functions. This file drives the REAL module
// directly and asserts a real outcome for each path (a parsed value, a flipped root attribute, a
// listener firing, a predicate over a forced OS preference).
//
// It runs under the shared DOM shim (test/dom-shim.ts), exactly as the other component validators do,
// and never edits that shared shim. applyA11yPrefs calls root.style.removeProperty for the default
// text size, an API the shim's style does not model, so (as test/cov/shell-keyboard.ts already does)
// we add the standard remove semantics to the style prototype FOR THIS PROCESS ONLY; the shared shim
// file is untouched. Run with `node test/cov/lib-a11y-prefs.ts` (the cov runner also invokes it).

import {
  installDomShim,
  installBlockedStorage,
  restoreMemoryStorage,
} from "../dom-shim.ts";

installDomShim();

const g = globalThis as unknown as Record<string, unknown>;

// applyA11yPrefs removes the font-size custom property when the text size is the default (100). The
// shared shim models setProperty / getPropertyValue but not removeProperty; add the standard
// semantics to the style prototype for this process only (delete the recorded property) so the real
// path runs. The shared shim file is untouched.
{
  type StyleProto = Record<string, unknown> & { removeProperty?: (p: string) => void };
  const styleProto = Object.getPrototypeOf(
    (g.document as { documentElement: { style: unknown } }).documentElement.style,
  ) as StyleProto;
  if (typeof styleProto.removeProperty !== "function") {
    styleProto.removeProperty = function (this: Record<string, unknown>, prop: string): void {
      delete this[prop];
    };
  }
}

import {
  A11Y_DEFAULTS,
  getA11yPrefs,
  setA11yPref,
  onA11yChange,
  applyA11yPrefs,
  motionOK,
  toastDurationMs,
  singleKeyShortcutsEnabled,
  initA11yPrefs,
} from "../../src/lib/a11y-prefs.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const root = (g.document as { documentElement: { getAttribute(k: string): string | null; style: { getPropertyValue(p: string): string } } }).documentElement;
const KEY_PREFIX = "dp-a11y-";

// matchMedia is a global accessor in the shim; save the original so each motionOK case can install a
// stub and the suite can restore it afterwards. setMatchMedia replaces window.matchMedia with one
// that reports `matches` for the reduced-motion query (or removes it entirely when given null, to
// exercise the typeof-not-function branch).
const realMatchMedia = (g.matchMedia as unknown) ?? undefined;
function setMatchMedia(reduced: boolean | null): void {
  if (reduced === null) {
    delete g.matchMedia;
    return;
  }
  g.matchMedia = (query: string) => ({
    media: query,
    matches: query.includes("prefers-reduced-motion") ? reduced : false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
}
function restoreMatchMedia(): void {
  if (realMatchMedia === undefined) delete g.matchMedia;
  else g.matchMedia = realMatchMedia;
}

function seed(key: string, raw: string): void {
  (g.localStorage as { setItem(k: string, v: string): void }).setItem(KEY_PREFIX + key, raw);
}

function main(): void {
  // ========================================================================
  console.log("\n-- read(): a cold read while storage is blocked falls back to the default --");
    // The very first touch of "singleKeyShortcuts" happens with localStorage throwing on getItem, so
    // read()'s catch sets raw=null and parsePref returns the default ("on"). This drives read()'s
    // storage-throws catch AND parsePref's raw===null arm before any later call warms that key's cache.
    installBlockedStorage();
    ok("singleKeyShortcutsEnabled is true on a blocked cold read (default on)", singleKeyShortcutsEnabled() === true);
    restoreMemoryStorage();

  // ========================================================================
  console.log("\n-- parsePref(): each stored raw value is validated against its allow-list --");
  // ========================================================================
  {
    // Seed a distinct raw value per remaining key, then read them ALL in one getA11yPrefs() pass. Each
    // is a cache MISS (first read of that key), so parsePref runs once per key: a valid string is kept,
    // an unknown string falls back to the default, an absent key is the raw===null default, a valid
    // number in the allow-list is kept (textSize -> the key==="textSize" allow-list arm), and an
    // out-of-range number falls back (toastDuration -> the key!=="textSize" allow-list arm).
    seed("motion", "reduced"); // valid string -> kept
    seed("contrast", "nonsense"); // unknown string -> default ("system")
    seed("textSize", "125"); // valid number, textSize allow-list arm -> kept
    seed("toastDuration", "99999"); // out-of-range number, non-textSize arm -> default (5000)
    seed("statusPalette", "cvd"); // valid string -> kept
    seed("targets", "large"); // valid string -> kept
    seed("focusRing", "always"); // valid string -> kept
    // "underlines" is deliberately left unset, so its read sees raw===null and returns the default.

    const p = getA11yPrefs();
    ok("a valid stored string is kept (motion=reduced)", p.motion === "reduced");
    ok("an unknown stored string falls back to the default (contrast)", p.contrast === A11Y_DEFAULTS.contrast);
    ok("a valid stored number is kept (textSize=125)", p.textSize === 125);
    ok("an out-of-range number falls back to the default (toastDuration)", p.toastDuration === A11Y_DEFAULTS.toastDuration);
    ok("an absent key reads the default (underlines)", p.underlines === A11Y_DEFAULTS.underlines);
    ok("singleKeyShortcuts stays the cached default from the blocked read", p.singleKeyShortcuts === "on");
    ok("a valid statusPalette is kept (cvd)", p.statusPalette === "cvd");
    ok("a valid targets is kept (large)", p.targets === "large");
    ok("a valid focusRing is kept (always)", p.focusRing === "always");
  }

  // ========================================================================
  console.log("\n-- read(): a warm cache returns without touching storage --");
  // ========================================================================
  {
    // Every key is now cached. Change the underlying store, then read again: the cached value wins, so
    // read()'s `key in cached` short-circuit (not a fresh parse) is exercised.
    seed("motion", "full"); // the store now says full, but the cache holds reduced
    const p = getA11yPrefs();
    ok("the warm cache is returned, ignoring a changed store (motion still reduced)", p.motion === "reduced");
  }

  // ========================================================================
  console.log("\n-- applyA11yPrefs(): every preference realises (or clears) its root attribute --");
    // Drive each setting to its NON-default value and assert the matching root attribute is set. The
    // current cache from the parse phase already has motion=reduced / statusPalette=cvd / targets=large
    // / focusRing=always, so apply them all and check the attributes the stylesheet keys off.
    setA11yPref("motion", "reduced");
    setA11yPref("contrast", "more");
    setA11yPref("underlines", "always");
    setA11yPref("targets", "large");
    setA11yPref("focusRing", "always");
    setA11yPref("statusPalette", "cvd");
    setA11yPref("textSize", 150);
    applyA11yPrefs();
    ok("data-motion is reduced when motion=reduced", root.getAttribute("data-motion") === "reduced");
    ok("data-contrast is more when contrast=more", root.getAttribute("data-contrast") === "more");
    ok("data-underlines is always when underlines=always", root.getAttribute("data-underlines") === "always");
    ok("data-targets is large when targets=large", root.getAttribute("data-targets") === "large");
    ok("data-focus is always when focusRing=always", root.getAttribute("data-focus") === "always");
    ok("data-status-palette is cvd when statusPalette=cvd", root.getAttribute("data-status-palette") === "cvd");
    ok("the root font-size is set for a non-default text size (150%)", root.style.getPropertyValue("font-size") === "150%");

    // The "full" motion arm of the data-motion ternary (distinct from the reduced arm above).
    setA11yPref("motion", "full");
    ok("data-motion is full when motion=full", root.getAttribute("data-motion") === "full");

  // ========================================================================
  console.log("\n-- applyA11yPrefs(): System/default values CLEAR the attribute (setOrClear null arm) --");
    // Returning every setting to its System/default value REMOVES the attribute (so the media
    // queries apply untouched), exercising setOrClear's value===null arm and the font-size removal.
    // The lone exception is data-motion: it carries the EFFECTIVE motion (motionOK), not the raw
    // preference, so under the System default with no OS reduced-motion signal (the shim's matchMedia
    // reports matches=false for prefers-reduced-motion) it resolves to "full" rather than clearing,
    // which is what gates the opt-in [data-motion="full"] animations under the default preference.
    setA11yPref("motion", "system");
    setA11yPref("contrast", "system");
    setA11yPref("underlines", "hover");
    setA11yPref("targets", "default");
    setA11yPref("focusRing", "auto");
    setA11yPref("statusPalette", "default");
    setA11yPref("textSize", 100);
    ok("data-motion is full at the System default when motion is allowed", root.getAttribute("data-motion") === "full");
    ok("data-contrast is cleared at the System default", root.getAttribute("data-contrast") === null);
    ok("data-underlines is cleared at the hover default", root.getAttribute("data-underlines") === null);
    ok("data-targets is cleared at the default", root.getAttribute("data-targets") === null);
    ok("data-focus is cleared at the auto default", root.getAttribute("data-focus") === null);
    ok("data-status-palette is cleared at the default", root.getAttribute("data-status-palette") === null);
    ok("the root font-size is removed at the default text size (100)", root.style.getPropertyValue("font-size") === "");

  // ========================================================================
  console.log("\n-- setA11yPref(): persists, updates the cache, and notifies listeners --");
  // ========================================================================
  {
    let seenFromListener: string | null = null;
    let calls = 0;
    const off = onA11yChange((prefs) => {
      calls += 1;
      seenFromListener = prefs.contrast;
    });
    setA11yPref("contrast", "more");
    ok("a registered listener is called on a change", calls === 1);
    ok("the listener receives the fresh prefs snapshot (contrast=more)", seenFromListener === "more");
    ok("the new value is persisted to storage", (g.localStorage as { getItem(k: string): string | null }).getItem(`${KEY_PREFIX}contrast`) === "more");
    ok("the new value is reflected in getA11yPrefs()", getA11yPrefs().contrast === "more");

    // Unsubscribe: the returned disposer removes the listener, so a further change does NOT call it.
    off();
    setA11yPref("contrast", "system");
    ok("an unsubscribed listener is not called again", calls === 1);
    ok("getA11yPrefs() reflects the change made after unsubscribe", getA11yPrefs().contrast === "system");
  }

  // ========================================================================
  console.log("\n-- setA11yPref(): a blocked store still updates the in-session cache (catch arm) --");
  // ========================================================================
  {
    // With localStorage throwing on setItem, setA11yPref must swallow the write failure (best-effort
    // persistence) yet still update the session cache and notify, so get() then agrees within the
    // session. This drives the setItem catch arm.
    // A recorder written only from inside a callback: on a local `let` the compiler keeps the
    // narrowing from its initialiser, because it cannot see the callback run, so the assertion below
    // reads as always-false and proves nothing. Narrowing on an object's properties is discarded at
    // each call, which is the assumption that holds here.
    const rec = { notified: false };
    const off = onA11yChange(() => {
      rec.notified = true;
    });
    installBlockedStorage();
    let threw = false;
    try {
      setA11yPref("underlines", "always");
    } catch {
      threw = true;
    }
    ok("setA11yPref does not throw when the write is blocked", threw === false);
    ok("the blocked write still updated the session cache (underlines=always)", getA11yPrefs().underlines === "always");
    ok("the blocked write still notified listeners", rec.notified === true);
    off();
    restoreMemoryStorage();
    // Reset underlines to the default so later attribute assertions are not affected.
    setA11yPref("underlines", "hover");
  }

  // ========================================================================
  console.log("\n-- motionOK(): the in-app preference and the OS preference combine --");
    // motion="reduced" forces calm regardless of the OS, motion="full" animates regardless of the OS.
    setA11yPref("motion", "reduced");
    ok("motionOK is false when the in-app preference is reduced", motionOK() === false);
    setA11yPref("motion", "full");
    ok("motionOK is true when the in-app preference is full", motionOK() === true);

    // motion="system" defers to prefers-reduced-motion: false when the OS prefers reduced motion.
    setA11yPref("motion", "system");
    setMatchMedia(true);
    ok("motionOK is false on system when the OS prefers reduced motion", motionOK() === false);
    // ...and true when the OS does not prefer reduced motion.
    setMatchMedia(false);
    ok("motionOK is true on system when the OS does not prefer reduced motion", motionOK() === true);
    // ...and true when matchMedia is unavailable (the typeof !== "function" arm: no OS signal -> animate).
    setMatchMedia(null);
    ok("motionOK is true on system when matchMedia is unavailable", motionOK() === true);
    restoreMatchMedia();

  // ========================================================================
  console.log("\n-- toastDurationMs() / singleKeyShortcutsEnabled(): the small reader functions --");
    setA11yPref("toastDuration", 0);
    ok("toastDurationMs reads the stored duration (0 = until dismissed)", toastDurationMs() === 0);
    setA11yPref("toastDuration", 10000);
    ok("toastDurationMs reflects a changed duration (10000)", toastDurationMs() === 10000);

    setA11yPref("singleKeyShortcuts", "off");
    ok("singleKeyShortcutsEnabled is false when turned off", singleKeyShortcutsEnabled() === false);
    setA11yPref("singleKeyShortcuts", "on");
    ok("singleKeyShortcutsEnabled is true when turned back on", singleKeyShortcutsEnabled() === true);

  // ========================================================================
  console.log("\n-- initA11yPrefs(): re-applies the stored preferences at boot --");
    // Set a non-default that maps to an attribute, scrub that attribute off the root by hand, then call
    // initA11yPrefs(): it re-applies, so the attribute returns (the in-memory control and the DOM agree
    // after boot, the same contract as initTheme).
    setA11yPref("targets", "large");
    (root as unknown as { removeAttribute(k: string): void }).removeAttribute("data-targets");
    ok("the data-targets attribute was scrubbed before init", root.getAttribute("data-targets") === null);
    initA11yPrefs();
    ok("initA11yPrefs re-applies the stored attributes (data-targets=large)", root.getAttribute("data-targets") === "large");
    setA11yPref("targets", "default"); // leave the root clean

  if (failures > 0) process.exitCode = 1;

  if (failures > 0) {
    console.error(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("\nA11Y-PREFS COVERAGE VECTORS PASS");
}

main();
