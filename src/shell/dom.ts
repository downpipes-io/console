// The shell's static DOM scaffold: the skip link, the nav rail, the context bar (with the
// command-palette trigger, the view-mode toggle, the engine chip and the account slot), the
// main region, the Compact slide-over scrim, the aurora + ambient backdrops, the polite
// navigation announcer and the setup strip. Factored out of the shell entry (app-shell.ts)
// so mountShell stays the assembler that wires behaviour, not the bulk DOM builder.
//
// The context-bar controls reach back to the app through CALLBACKS held in mountShell's
// closures; those are mutable (rebound by onOpenPalette / onViewMode / onSignOut), so they
// are read here via accessor functions (ShellDomCallbacks) rather than captured by value, so
// a later rebind is honoured. The builder returns every live DOM reference the entry threads
// into ShellInternals and the public handles.

import { h, svgIcon } from "../lib/dom.ts";
import { brandMark } from "./brand.ts";
import { ambientField } from "../components/ambient-field.ts";
import { initAurora } from "../lib/aurora-pref.ts";
import { ICON_SEARCH, ICON_MENU, ICON_EYE, ICON_OVERVIEW } from "../lib/icons.ts";
import type { ViewMode } from "../lib/view-mode.ts";
import { buildEngineChip, buildUpdateChip, renderAccount, UPDATE_CHIP_ROUTE } from "./chrome.ts";

// The callbacks the context-bar controls invoke. Read lazily (accessors) so mountShell can
// rebind them after the shell is built without rebuilding the DOM.
export interface ShellDomCallbacks {
  openPalette(): void;
  viewMode(mode: ViewMode): void;
  signOut(): void;
  // Route navigation for chrome that deep-links (the update chip). Same guarded navigate the
  // rail links use, threaded through mountShell's handler record.
  navigate(route: string): void;
}

// Every live DOM reference the shell entry threads into ShellInternals and the handles.
export interface ShellDom {
  skip: HTMLElement;
  navEl: HTMLElement;
  railFooter: HTMLElement;
  rail: HTMLElement;
  railToggle: HTMLButtonElement;
  viewModeToggle: HTMLElement;
  viewExecBtn: HTMLButtonElement;
  viewTechBtn: HTMLButtonElement;
  updateChip: HTMLButtonElement;
  engineChip: HTMLElement;
  accountSlot: HTMLElement;
  mainRegion: HTMLElement;
  mainInner: HTMLElement;
  scrim: HTMLElement;
  navAnnounce: HTMLElement;
  setupStrip: HTMLElement;
  shellEl: HTMLElement;
}

// buildNavRail builds the rail aside (brand mark + the live nav element + the footer that
// holds the show-all escape hatch). navEl is the live route->link container the curated rail
// renders into; railFooter receives the escape hatch when the caller's surface hides items.
function buildNavRail(): { rail: HTMLElement; navEl: HTMLElement; railFooter: HTMLElement } {
  // The rail is built from the CURATED nav: a flat list shaped to the caller's per-role surface
  // (a screen the role hides is dropped, with a show-all escape hatch). It is rebuilt whenever the
  // caller resolves or the escape hatch flips (renderRail). The first build, before any caller is
  // known, shows the full rail (curatedNavForCaller returns everything for a null caller), so
  // navigation works from the first paint and curation only narrows it once a custom role's surface
  // is known.
  const navEl = h("nav", { class: "rail__nav", "aria-label": "Primary" });
  const brand = h("div", { class: "rail__brand" }, brandMark({ size: 22 }));
  // The rail footer holds the show-all escape hatch (rendered only when the caller's surface hides
  // at least one item) and leaves room for the theme control (the account menu carries theme too).
  const railFooter = h("div", { class: "rail__footer" });
  const rail = h("aside", { class: "rail" }, brand, navEl, railFooter);
  rail.id = "primary-rail";
  return { rail, navEl, railFooter };
}

// buildPaletteTrigger builds the command-palette button (search or jump-to). The visible label
// collapses to an icon at the Compact breakpoint; the aria-label keeps the accessible name in
// every state.
function buildPaletteTrigger(cb: ShellDomCallbacks): HTMLElement {
  return h(
    "button",
    { "data-dp": "shell-dom.button.open-palette",
      class: "palette-trigger",
      type: "button",
      "aria-label": "Open command palette (search or jump to)",
      on: { click: () => cb.openPalette() },
    },
    svgIcon(ICON_SEARCH, { size: 14 }),
    // The visible text label is hidden at the Compact breakpoint (the button collapses to an
    // icon-only control there to avoid horizontal overflow at 320px); the button's aria-label keeps
    // the accessible name in every state, so the icon-only form is still announced as the command
    // palette trigger.
    h("span", { class: "palette-trigger__label" }, "Search or jump to"),
    h("span", { class: "palette-trigger__hint" }, h("kbd", { class: "kbd" }, "/")),
  );
}

// buildViewModeToggle builds the two-button segmented Executive | Technical control. It is a
// PRESENTATION control only, with no authority: it changes the skin, never what the engine
// permits. Activating one calls cb.viewMode, which the app persists + re-renders against; the
// pressed state is set by the entry's refreshViewToggle.
function buildViewModeToggle(cb: ShellDomCallbacks): {
  viewModeToggle: HTMLElement;
  viewExecBtn: HTMLButtonElement;
  viewTechBtn: HTMLButtonElement;
} {
  const viewModeToggle = h("div", {
    class: "view-toggle",
    role: "group",
    "aria-label": "Console view",
  });
  const viewExecBtn = h(
    "button",
    { "data-dp": "shell-dom.toggle.view-exec", class: "btn btn--ghost btn--sm view-toggle__btn", type: "button", "aria-pressed": "false", "aria-label": "Executive view (plain-English answers)", on: { click: () => cb.viewMode("shiny") } },
    svgIcon(ICON_EYE, { size: 14 }),
    h("span", { class: "view-toggle__label" }, "Executive"),
  ) as HTMLButtonElement;
  const viewTechBtn = h(
    "button",
    { "data-dp": "shell-dom.toggle.view-tech", class: "btn btn--ghost btn--sm view-toggle__btn", type: "button", "aria-pressed": "false", "aria-label": "Technical view (the full operator console)", on: { click: () => cb.viewMode("technical") } },
    svgIcon(ICON_OVERVIEW, { size: 14 }),
    h("span", { class: "view-toggle__label" }, "Technical"),
  ) as HTMLButtonElement;
  viewModeToggle.append(viewExecBtn, viewTechBtn);
  return { viewModeToggle, viewExecBtn, viewTechBtn };
}

// buildContextBar builds the header chrome: the rail toggle, the view-mode toggle, the palette
// trigger, the engine identity chip and the account/session slot. The bar carries NO title:
// every screen's pageHeader renders the one h1 below.
function buildContextBar(cb: ShellDomCallbacks): {
  contextBar: HTMLElement;
  railToggle: HTMLButtonElement;
  viewModeToggle: HTMLElement;
  viewExecBtn: HTMLButtonElement;
  viewTechBtn: HTMLButtonElement;
  updateChip: HTMLButtonElement;
  engineChip: HTMLElement;
  accountSlot: HTMLElement;
} {
  const paletteTrigger = buildPaletteTrigger(cb);

  // aria-expanded starts "false": correct for the Compact slide-over (closed at mount) but not for the
  // wide/medium rail (expanded at mount, since data-rail starts "default"). This static markup has no way
  // to know the viewport width, so it always builds the Compact-correct starting point; wireRailToggle
  // (shell/keyboard.ts) seeds the breakpoint-correct value right after mount.
  const railToggle = h(
    "button",
    { "data-dp": "shell-dom.button.rail-toggle",
      class: "btn btn--ghost btn--icon rail-toggle",
      type: "button",
      "aria-label": "Open navigation",
      "aria-expanded": "false",
      "aria-controls": "primary-rail",
    },
    svgIcon(ICON_MENU, { size: 20 }),
  ) as HTMLButtonElement;

  const { viewModeToggle, viewExecBtn, viewTechBtn } = buildViewModeToggle(cb);

  // The "Update available" chip: built hidden; the app shows it via setUpdateAvailable only when a
  // verified release genuinely carries a newer component. Its click deep-links to the Updates
  // section on Licence and updates (the ?open= idiom the licence coordinator handles).
  const updateChip = buildUpdateChip(() => cb.navigate(UPDATE_CHIP_ROUTE));

  const engineChip = buildEngineChip({ host: null });
  const accountSlot = h("div", { class: "account-slot" });
  // Initial degraded account state until whoami resolves.
  renderAccount(accountSlot, null, false, () => cb.signOut());

  const contextBar = h(
    "header",
    { class: "context-bar" },
    railToggle,
    h("div", { class: "context-bar__spacer" }),
    updateChip,
    viewModeToggle,
    paletteTrigger,
    engineChip,
    accountSlot,
  );
  return { contextBar, railToggle, viewModeToggle, viewExecBtn, viewTechBtn, updateChip, engineChip, accountSlot };
}

// buildBackdrops builds the decorative fixed layers behind all content: the aurora wash
// (shown only while <html data-aurora="on">) and the owner's ambient atomic-green-snow drift
// (gated on motionOK() inside ambientField, hidden when the aurora wash is on). Both are
// aria-hidden, pointer-events none, at z-index -1.
function buildBackdrops(): { auroraField: HTMLElement; ambientCanvas: HTMLElement } {
  const auroraField = h("div", { class: "aurora-field", "aria-hidden": "true" }, h("div", { class: "aurora-field__teal" }));
  initAurora();
  // The ambient field (the owner's atomic-green-snow): a very subtle drift behind all
  // content, gated on motionOK() and hidden when the Aurora wash is on. See
  // components/ambient-field.ts. Mounted like auroraField, a fixed layer at z-index -1.
  const ambientCanvas = ambientField();
  return { auroraField, ambientCanvas };
}

// buildShellDom assembles the whole static shell DOM and returns every live reference the
// entry threads into ShellInternals and the public handles. mountShell wires behaviour
// (rail collapse, keyboard layer, the handles) onto these references afterwards.
export function buildShellDom(cb: ShellDomCallbacks): ShellDom {
  // ---- skip link (first focusable element) ----
  const skip = h("a", { class: "skip-link", href: "#main" }, "Skip to content");

  // ---- nav rail ----
  const { rail, navEl, railFooter } = buildNavRail();

  // ---- context bar (header) ----
  const { contextBar, railToggle, viewModeToggle, viewExecBtn, viewTechBtn, updateChip, engineChip, accountSlot } =
    buildContextBar(cb);

  // ---- main region ----
  const mainRegion = h("main", { class: "main", id: "main", tabindex: "-1" });
  const mainInner = h("div", { class: "main__inner measure-wide" });
  mainRegion.appendChild(mainInner);

  // ---- scrim (Compact slide-over backdrop) ----
  const scrim = h("div", { class: "rail-scrim", "aria-hidden": "true" });

  // ---- aurora + ambient backdrops (opt-in; lib/aurora-pref.ts + tokens.css) ----
  const { auroraField, ambientCanvas } = buildBackdrops();

  // Polite navigation announcer: focus moving to main is the primary
  // signal; this names the destination screen for assistive tech explicitly.
  const navAnnounce = h("div", { class: "visually-hidden", role: "status", "aria-live": "polite" });

  // The setup strip (the guided first run): one quiet line + step pips between the
  // context bar and the main region. Hidden until setSetup provides a view; hidden
  // with the chrome on full-bleed routes (CSS keys off data-chrome).
  const setupStrip = h("div", { class: "setup-strip", role: "region", "aria-label": "Setup progress", hidden: true });

  const shellEl = h("div", { class: "shell" }, auroraField, ambientCanvas, rail, contextBar, setupStrip, mainRegion, scrim, navAnnounce);
  shellEl.dataset.rail = "default";

  return {
    skip,
    navEl, railFooter, rail, railToggle,
    viewModeToggle, viewExecBtn, viewTechBtn,
    updateChip, engineChip, accountSlot,
    mainRegion, mainInner,
    scrim, navAnnounce, setupStrip, shellEl,
  };
}
