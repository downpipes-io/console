// The appearance and accessibility sections of the Settings screen: the three-way theme control, the Aurora
// and Rain backdrops, and the accessibility radiogroups (motion, contrast, text size, link underlines,
// single-key shortcuts, notification duration, status palette, control size, focus ring, auto-refresh) plus
// the accessibility statement. Every control augments the browser/OS, never replaces it (the GDS rule): System
// defers to the prefers-* media query and text size composes with browser zoom. The mechanism is
// lib/a11y-prefs.ts, attributes on <html>, applied pre-paint by index.html. Moved verbatim from the settings
// coordinator for size; behaviour, copy and markup are unchanged.
//
// House style: Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { lazyDisclosure } from "../common.ts";
import { getThemePref, setThemePref, onThemeChange, type ThemePref } from "../../lib/theme.ts";
import { getAuroraPref, setAuroraPref, onAuroraChange, type AuroraPref } from "../../lib/aurora-pref.ts";
import { getRainPref, setRainPref, onRainChange, type RainPref } from "../../lib/rain-pref.ts";
import { getA11yPrefs, setA11yPref, type A11yPrefs } from "../../lib/a11y-prefs.ts";
import { getAutoRefresh, setAutoRefresh } from "../../lib/refresh-pref.ts";
import { ICON_SUN, ICON_MOON, ICON_MONITOR } from "../../lib/icons.ts";

export function renderAppearance(): HTMLElement {
  // Unboxed section; the scaffold's gap owns the rhythm (no margin-top styles).
  const card = h("section", { class: "measure" });
  card.appendChild(h("h2", { class: "section-title" }, "Appearance"));
  card.appendChild(h("p", { class: "field__hint", style: "margin-bottom:var(--space-3)" }, "Saved to this browser."));

  const theme = buildThemeControl();
  card.appendChild(theme.el);
  const aurora = buildAuroraControl();
  card.appendChild(aurora.el);
  const rain = buildRainControl();
  card.appendChild(rain.el);

  // Sync the radiogroups whenever a preference is set from any surface (e.g. the
  // palette's theme.toggle, or the rain control changed on another open view).
  // Unsubscribes when the card leaves the DOM via a MutationObserver, so the listeners
  // do not leak across screen navigations.
  const unsub = onThemeChange(theme.update);
  const unsubAurora = onAuroraChange(aurora.update);
  const unsubRain = onRainChange(rain.update);
  const unsubAll = (): void => {
    unsub();
    unsubAurora();
    unsubRain();
  };
  const observer = new MutationObserver(() => {
    if (!card.isConnected) {
      unsubAll();
      observer.disconnect();
    }
  });
  // Watch only the card's parent for child removals, not the whole document subtree: the
  // card is removed from its parent on navigate, so a childList watch on that parent is the
  // narrowest signal. Deferred one task so the card has been appended and parentNode is set.
  window.setTimeout(() => {
    const parent = card.parentNode;
    if (parent === null) {
      unsubAll();
      return;
    }
    observer.observe(parent, { childList: true });
  }, 0);
  return card;
}

// buildThemeControl builds the three-way theme radiogroup with a visible "Theme" label (the same
// visible-label pattern the Rain control uses, so the control is named on screen, not only to AT).
// It returns the element plus an `update` that reflects an externally-set preference onto the
// buttons without a re-render (the caller wires it to onThemeChange so the palette's theme.toggle
// keeps this control in sync).
function buildThemeControl(): { el: HTMLElement; update: (pref: ThemePref) => void } {
  const group = h("div", { class: "theme-control", role: "radiogroup", "aria-labelledby": "set-theme-label" });
  const current = getThemePref();
  const options: Array<{ pref: ThemePref; label: string; icon: string }> = [
    { pref: "system", label: "System", icon: ICON_MONITOR },
    { pref: "light", label: "Light", icon: ICON_SUN },
    { pref: "dark", label: "Dark", icon: ICON_MOON },
  ];
  const buttons: HTMLButtonElement[] = [];
  const update = (pref: ThemePref): void => {
    for (let i = 0; i < options.length; i++) {
      const active = options[i]!.pref === pref;
      buttons[i]!.classList.toggle("theme-option--active", active);
      buttons[i]!.setAttribute("aria-checked", active ? "true" : "false");
    }
  };
  for (const o of options) {
    const btn = h(
      "button",
      { "data-dp": "settings.radio.set-theme-pref",
        class: `theme-option${o.pref === current ? " theme-option--active" : ""}`,
        type: "button",
        role: "radio",
        "aria-checked": o.pref === current ? "true" : "false",
      },
      svgIcon(o.icon, { size: 16 }),
      h("span", o.label),
    ) as HTMLButtonElement;
    // update is called via the onThemeChange listener the caller wires, so no separate update here.
    btn.addEventListener("click", () => setThemePref(o.pref));
    buttons.push(btn);
    group.appendChild(btn);
  }
  const el = h(
    "div",
    { class: "field" },
    h("label", { id: "set-theme-label", style: "display:block;font-weight:var(--weight-medium);margin-bottom:var(--space-2)" }, "Theme"),
    group,
  );
  return { el, update };
}

// buildAuroraControl builds the Aurora backdrop opt-in (aurora-pref.ts; off by default) in the SAME
// Off / On segmented theme-option idiom the Theme and Rain controls use, so the three appearance
// controls read and operate identically. One short hint: the wash carries no information. Returns
// the element plus an `update` the caller wires to onAuroraChange.
function buildAuroraControl(): { el: HTMLElement; update: (pref: AuroraPref) => void } {
  const group = h("div", { class: "theme-control", role: "radiogroup", "aria-labelledby": "set-aurora-label" });
  const current = getAuroraPref();
  const options: Array<{ pref: AuroraPref; label: string }> = [
    { pref: "off", label: "Off" },
    { pref: "on", label: "On" },
  ];
  const buttons: HTMLButtonElement[] = [];
  const update = (pref: AuroraPref): void => {
    for (let i = 0; i < options.length; i++) {
      const active = options[i]!.pref === pref;
      buttons[i]!.classList.toggle("theme-option--active", active);
      buttons[i]!.setAttribute("aria-checked", active ? "true" : "false");
    }
  };
  for (const o of options) {
    const btn = h(
      "button",
      { "data-dp": "settings.radio.set-aurora-pref",
        class: `theme-option${o.pref === current ? " theme-option--active" : ""}`,
        type: "button",
        role: "radio",
        "aria-checked": o.pref === current ? "true" : "false",
      },
      h("span", o.label),
    ) as HTMLButtonElement;
    btn.addEventListener("click", () => setAuroraPref(o.pref));
    buttons.push(btn);
    group.appendChild(btn);
  }
  const el = h(
    "div",
    { class: "field", style: "margin-top:var(--space-4)" },
    h("label", { id: "set-aurora-label", style: "display:block;font-weight:var(--weight-medium);margin-bottom:var(--space-2)" }, "Aurora backdrop"),
    group,
    h("p", { class: "field__hint" }, "A faint colour wash behind the console. Decorative only; honours reduced motion."),
  );
  return { el, update };
}

// buildRainControl builds the Rain backdrop intensity radiogroup (rain-pref.ts). Off / Medium / Storm;
// Storm adds occasional lightning. (The former "light" drizzle was removed as too faint, so medium is
// the gentlest tier.) Decorative; honours reduced motion. Returns the element plus an `update` the
// caller wires to onRainChange.
function buildRainControl(): { el: HTMLElement; update: (pref: RainPref) => void } {
  const rainGroup = h("div", { class: "theme-control", role: "radiogroup", "aria-labelledby": "set-rain-label", style: "flex-wrap:wrap" });
  const rainCurrent = getRainPref();
  const rainOptions: Array<{ pref: RainPref; label: string }> = [
    { pref: "off", label: "Off" },
    { pref: "medium", label: "Medium" },
    { pref: "storm", label: "Storm" },
  ];
  const rainButtons: HTMLButtonElement[] = [];
  const update = (pref: RainPref): void => {
    for (let i = 0; i < rainOptions.length; i++) {
      const active = rainOptions[i]!.pref === pref;
      rainButtons[i]!.classList.toggle("theme-option--active", active);
      rainButtons[i]!.setAttribute("aria-checked", active ? "true" : "false");
    }
  };
  for (const o of rainOptions) {
    const btn = h(
      "button",
      { "data-dp": "settings.radio.set-rain-pref",
        class: `theme-option${o.pref === rainCurrent ? " theme-option--active" : ""}`,
        type: "button",
        role: "radio",
        "aria-checked": o.pref === rainCurrent ? "true" : "false",
      },
      h("span", o.label),
    ) as HTMLButtonElement;
    btn.addEventListener("click", () => setRainPref(o.pref));
    rainButtons.push(btn);
    rainGroup.appendChild(btn);
  }
  const el = h(
    "div",
    { class: "field", style: "margin-top:var(--space-4)" },
    h("label", { id: "set-rain-label", style: "display:block;font-weight:var(--weight-medium);margin-bottom:var(--space-2)" }, "Rain backdrop"),
    rainGroup,
    h("p", { class: "field__hint" }, "A rain effect behind the console. Medium is a steady rain; Storm adds heavier rain and occasional lightning. Off stops it. Decorative; honours reduced motion."),
  );
  return { el, update };
}

// ---------------------------------------------------------------------------
// Accessibility. Every control augments the
// browser/OS, never replaces it: System defers to the prefers-* media query and
// text size composes with browser zoom (the GDS rule). The mechanism is
// lib/a11y-prefs.ts, attributes on <html>, applied pre-paint by index.html.
// ---------------------------------------------------------------------------

export function renderAccessibility(): HTMLElement {
  // No inner heading: this renders inside the "Accessibility" disclosure, whose summary
  // already carries the section's h2 (a second h2 here read the same title twice).
  const section = h("section", { class: "measure" });
  section.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-bottom:var(--space-3)" },
      "These augment your browser and operating-system settings, never replace them: System defers to the OS preference, and text size composes with browser zoom. Preferences persist to this browser only.",
    ),
  );

  const stack = h("div", { class: "stack-sm" });
  for (const row of accessibilityRows()) {
    stack.appendChild(prefRow(row.label, row.hint, row.options, row.current, row.onSelect));
  }
  section.appendChild(stack);
  section.appendChild(
    h(
      "div",
      { style: "margin-top:var(--space-4)" },
      lazyDisclosure("Accessibility statement", () => accessibilityStatement()),
    ),
  );
  return section;
}

// A11yRowSpec describes one accessibility radiogroup row: its label, hint, options, the current value
// and the setter to call on selection. The setter owns its own value coercion (some prefs are numbers).
interface A11yRowSpec {
  label: string;
  hint: string;
  options: Array<{ value: string; label: string }>;
  current: string;
  onSelect: (value: string) => void;
}

// accessibilityRows is the data table renderAccessibility iterates: each entry is one prefRow. Driving
// the render from this list keeps renderAccessibility short and makes adding a control a one-row edit.
function accessibilityRows(): A11yRowSpec[] {
  const p = getA11yPrefs();
  return [
    {
      label: "Motion",
      hint: "System follows the OS reduced-motion preference. Reduced forces calm. Full animates this console (the live map and transitions) even when the OS prefers reduced motion.",
      options: [{ value: "system", label: "System" }, { value: "reduced", label: "Reduced" }, { value: "full", label: "Full" }],
      current: p.motion,
      onSelect: (v) => setA11yPref("motion", v as A11yPrefs["motion"]),
    },
    {
      label: "Contrast",
      hint: "Raise secondary text and hairlines; thicken the focus ring.",
      options: [{ value: "system", label: "System" }, { value: "more", label: "Increased" }],
      current: p.contrast,
      onSelect: (v) => setA11yPref("contrast", v as A11yPrefs["contrast"]),
    },
    {
      label: "Text size",
      hint: "Scales the whole console; composes with browser zoom.",
      options: [
        { value: "100", label: "100%" },
        { value: "112.5", label: "112%" },
        { value: "125", label: "125%" },
        { value: "150", label: "150%" },
      ],
      current: String(p.textSize),
      onSelect: (v) => setA11yPref("textSize", Number(v) as A11yPrefs["textSize"]),
    },
    {
      label: "Link underlines",
      hint: "Underline links at rest, not only on hover.",
      options: [{ value: "hover", label: "On hover" }, { value: "always", label: "Always" }],
      current: p.underlines,
      onSelect: (v) => setA11yPref("underlines", v as A11yPrefs["underlines"]),
    },
    {
      label: "Single-key shortcuts",
      hint: "“/” focuses search and “g” chords navigate. Turning these off never affects Ctrl/Cmd-K.",
      options: [{ value: "on", label: "On" }, { value: "off", label: "Off" }],
      current: p.singleKeyShortcuts,
      onSelect: (v) => setA11yPref("singleKeyShortcuts", v as A11yPrefs["singleKeyShortcuts"]),
    },
    {
      label: "Notification duration",
      hint: "How long toasts stay. They always pause under the pointer or keyboard focus.",
      options: [
        { value: "5000", label: "5s" },
        { value: "10000", label: "10s" },
        { value: "20000", label: "20s" },
        { value: "0", label: "Until dismissed" },
      ],
      current: String(p.toastDuration),
      onSelect: (v) => setA11yPref("toastDuration", Number(v) as A11yPrefs["toastDuration"]),
    },
    {
      label: "Status palette",
      hint: "Shift the ok/failed hues to blue/amber for red-green colour vision. Status is always shape + label as well, so this is comfort, not a requirement.",
      options: [{ value: "default", label: "Default" }, { value: "cvd", label: "Colour-vision friendly" }],
      current: p.statusPalette,
      onSelect: (v) => setA11yPref("statusPalette", v as A11yPrefs["statusPalette"]),
    },
    {
      label: "Control size",
      hint: "44px controls everywhere (touch viewports already get them).",
      options: [{ value: "default", label: "Default" }, { value: "large", label: "Large" }],
      current: p.targets,
      onSelect: (v) => setA11yPref("targets", v as A11yPrefs["targets"]),
    },
    {
      label: "Focus ring",
      hint: "Show the keyboard focus ring on every focus, including pointer clicks.",
      options: [{ value: "auto", label: "Keyboard only" }, { value: "always", label: "Always" }],
      current: p.focusRing,
      onSelect: (v) => setA11yPref("focusRing", v as A11yPrefs["focusRing"]),
    },
    {
      label: "Auto-refresh",
      hint: "The Overview and Topology map refresh in place every 30 seconds; pausing stops the cadence (manual Refresh always works).",
      options: [{ value: "on", label: "On" }, { value: "paused", label: "Paused" }],
      current: getAutoRefresh(),
      onSelect: (v) => setAutoRefresh(v as "on" | "paused"),
    },
  ];
}

// prefRow: one labelled radiogroup row in the appearance idiom (theme-option
// buttons), so every accessibility control reads and operates the same way.
function prefRow(
  label: string,
  hint: string,
  options: Array<{ value: string; label: string }>,
  current: string,
  onSelect: (value: string) => void,
): HTMLElement {
  const row = h("div");
  const id = `a11y-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  row.appendChild(h("span", { class: "field__label", id }, label));
  row.appendChild(h("p", { class: "field__hint", style: "margin:2px 0 var(--space-2)" }, hint));
  const group = h("div", { class: "theme-control", role: "radiogroup", "aria-labelledby": id, style: "flex-wrap:wrap" });
  const btns: HTMLButtonElement[] = [];
  for (const o of options) {
    const btn = h(
      "button",
      { "data-dp": "settings.radio.select",
        class: `theme-option${o.value === current ? " theme-option--active" : ""}`,
        type: "button",
        role: "radio",
        "aria-checked": o.value === current ? "true" : "false",
      },
      h("span", o.label),
    ) as HTMLButtonElement;
    btn.addEventListener("click", () => {
      for (const b of btns) {
        b.classList.remove("theme-option--active");
        b.setAttribute("aria-checked", "false");
      }
      btn.classList.add("theme-option--active");
      btn.setAttribute("aria-checked", "true");
      onSelect(o.value);
    });
    btns.push(btn);
    group.appendChild(btn);
  }
  row.appendChild(group);
  return row;
}

// The accessibility statement (audit §8): the conformance claim, what backs it,
// the known limits, and where the settings live. Honest and specific, the same
// register as the rest of the console's security copy.
function accessibilityStatement(): HTMLElement {
  const wrap = h("div", { class: "stack-sm" });
  wrap.appendChild(h("p",
    "This console targets WCAG 2.2 Level AA across both themes. Conformance is engineered, not asserted: every composed colour pair is computed and gated in the validation suite (validate-contrast), status is always conveyed by shape and label as well as hue, every surface is keyboard-operable with a visible focus ring, motion is gated behind your reduced-motion preference, and authentication is passkey-first with no cognitive test (WCAG 3.3.9, Level AAA)."));
  wrap.appendChild(h("p",
    "Beyond AA, the settings above provide an increased-contrast theme (toward the AAA 7:1 tier), 44px control sizing (AAA target size), adjustable notification timing, a colour-vision-friendly status palette, full-console text scaling, and a kill switch for single-key shortcuts. Forced-colors (Windows High Contrast) and print are first-class renderings."));
  wrap.appendChild(h("p", { class: "field__hint" },
    "Known limits: assistive-technology testing (NVDA, JAWS, VoiceOver) is run as a manual release pass, and the topology visualisation is a progressive enhancement whose canonical, operable form is its accessible table. For procurement mappings (EN 301 549) or to report an accessibility issue, use the support bundle path under Support and diagnostics, the report reaches the vendor with your ticket."));
  return wrap;
}
