// The palette overlay: the combobox surface, the module-level open singleton, the
// integrator-supplied default registry, and all the DOM-side machinery that builds it.
// ---------------------------------------------------------------------------
//
// This module owns the FOUR module-level mutable bindings that make the palette a
// singleton (openHandle / openInput / defaultRegistry / defaultRegistryDispatch) and every
// function that reads or writes them (setPaletteRegistry, openCommandPalette), so the
// open/close guard and the wired registry share ONE source of truth; nothing else
// re-declares them. openCommandPalette is the coordinator: it builds the static DOM
// (./surface.ts), wires the live keyboard + render model (./controller.ts), and opens the
// overlay. The cohesive pieces it drives live in siblings: the registry-to-grouped-rows
// builder + the role/engine gate (./groups.ts, re-exporting collectCommands for the route
// landing), the async entity fetch+render that consumes the DOM-free entity engine
// (./entity-append.ts), the row model and its builders (./rows.ts), and the
// belt-and-braces style guard below. Split from the original single file for size;
// behaviour is unchanged.
//
// Accessibility: role="dialog" aria-modal with an accessible name;
// the input is role="combobox" controlling a role="listbox" via aria-controls;
// selection moves with aria-activedescendant (the visual active row moves WITHOUT
// shifting DOM focus off the input); focus is trapped and restored to the trigger on
// close (the shared overlay engine); the result count is announced politely; Esc
// closes; Up/Down/Home/End move the active row; Enter runs it.
//
// No-custody honoured: the async entity source reads only downpipe NAMES and run IDs
// (already non-secret, in-account) and renders every server-supplied string with
// textContent (lib/dom.ts is textContent-first); the palette shows no secret, no
// fingerprint, no value, and reaches only the connected in-account engine. House rules:
// Australian English, no em dashes, precise claims.

import { openOverlay, type OverlayHandle } from "../../components/dialog.ts";
import { caller as currentCaller } from "../../lib/nav.ts";
import { getEngine } from "../../lib/store.ts";
import type { Command } from "../../shell/registry.ts";
import type {
  PaletteDispatch,
  OpenPaletteOptions,
} from "./shared.ts";
import { defaultDispatch } from "./routing.ts";
import { collectCommands } from "./groups.ts";
import { buildPaletteSurface } from "./surface.ts";
import { createPaletteController } from "./controller.ts";

// Re-exported so the route-landing cheat-sheet (./landing.ts) reads the SAME role-gated
// command set the overlay does, without reaching past this module for the moved helper.
export { collectCommands };

// ---------------------------------------------------------------------------
// The palette overlay (the combobox surface).
// ---------------------------------------------------------------------------

// A guard so Cmd/Ctrl-K (or a second trigger click) never stacks two palettes; the
// open instance is tracked and re-focused instead of re-opened. The guard re-checks the
// input is still in the document, because the router's closeAllOverlays() tears the
// overlay down WITHOUT firing onClose (dialog.ts), which would otherwise leave a stale
// handle pointing at a detached input; if it is detached, we drop the stale state and
// open a fresh palette.
let openHandle: OverlayHandle | null = null;
let openInput: HTMLInputElement | null = null;

// The integrator-supplied default registry + dispatcher, set once at boot so EVERY entry
// point (Cmd/Ctrl-K via the shell, the /command-palette route landing, a deep link) opens
// the SAME assembled, role-gated command set rather than the bare static COMMANDS. When
// unset (e.g. a unit test importing the module directly) the palette falls back to the
// static COMMANDS + this screen's own actions, which is the correct standalone behaviour.
export let defaultRegistry: Command[] | undefined;
let defaultRegistryDispatch: PaletteDispatch | undefined;

// setPaletteRegistry wires the one assembled registry (and optionally the dispatcher) the
// integrator builds in app.ts, so the palette's content is consistent across entry points.
export function setPaletteRegistry(commands: Command[], dispatch?: PaletteDispatch): void {
  defaultRegistry = commands;
  defaultRegistryDispatch = dispatch;
}

// openCommandPalette mounts the palette over the current screen. The integrator calls
// this from shell.onOpenPalette and from the /command-palette route; it is safe to
// call when one is already open (it just refocuses). Returns the overlay handle (or
// the existing one) so a caller can close it programmatically.
export function openCommandPalette(opts: OpenPaletteOptions = {}): OverlayHandle {
  if (openHandle && openInput && document.contains(openInput)) {
    openInput.focus();
    return openHandle;
  }
  // A stale handle from a closeAllOverlays() teardown: clear it and open fresh.
  openHandle = null;
  openInput = null;
  ensureStyles();

  const ctx = opts.ctx ?? { caller: currentCaller(), engine: getEngine() };
  const dispatch = opts.dispatch ?? defaultRegistryDispatch ?? defaultDispatch;
  // The command set: an explicit per-open list wins; otherwise the integrator's assembled
  // registry (setPaletteRegistry); otherwise undefined, which collectCommands reads as the
  // static COMMANDS + this screen's own actions (the standalone fallback).
  const suppliedCommands = opts.commands ?? defaultRegistry;

  // The static DOM surface (dialog shell, combobox input, listbox, live region, footer).
  const { surface, input, listbox, statusLive } = buildPaletteSurface();

  // closePalette closes the open overlay (the handle is assigned below; the arrow reads it
  // lazily so it is bound by the time any row or keystroke fires).
  const closePalette = () => {
    openHandle?.close();
  };

  // The live keyboard + render model for this open palette (owns rows / active index /
  // query token / debounce). It paints the static rows and schedules the entity append.
  const controller = createPaletteController({
    input,
    listbox,
    statusLive,
    ctx,
    dispatch,
    supplied: suppliedCommands,
    close: closePalette,
  });

  // Every keystroke re-renders the static rows immediately (instant feel); the entity
  // source inside render is the only debounced part.
  input.addEventListener("input", () => controller.render(input.value));

  // Keyboard: Up/Down/Home/End move the active row; Enter runs it; Esc is handled by
  // the overlay engine (it closes the topmost layer). Tab is trapped by the overlay.
  input.addEventListener("keydown", controller.handleKeydown);

  openHandle = openOverlay({
    surface,
    variant: "modal",
    dismissable: true,
    initialFocus: input,
    onClose: () => {
      openHandle = null;
      openInput = null;
    },
  });
  openInput = input;

  // First paint: the empty-query state (recent/contextual commands first).
  controller.render("");

  return openHandle;
}

// ---------------------------------------------------------------------------
// Component CSS: in public/tokens.css (section 14). console-command-palette-1.
// ---------------------------------------------------------------------------
//
// All palette CSS (.cmdp*, .spinner*, .shortcut-*, @keyframes cmdp-spin, and
// the @media (max-width: 767px) palette compact rule) now lives in section 14
// of public/tokens.css, which is the design-system authority for all component
// styles. The ensureStyles() guard below is kept as a belt-and-braces fallback
// for any build environment where tokens.css is not linked (e.g. isolated unit
// tests): it injects an empty marker element so the guard fires only once and
// the palette still renders in those environments. In production the browser
// sees the rules from the linked stylesheet and the marker element is a no-op.
function ensureStyles(): void {
  // No-op when the stylesheet is already linked (tokens.css section 14 owns the
  // rules). The guard id is kept so the palette does not re-check on every open.
  if (document.getElementById("cmdp-styles")) return;
  const marker = document.createElement("meta");
  marker.id = "cmdp-styles";
  document.head.appendChild(marker);
}
