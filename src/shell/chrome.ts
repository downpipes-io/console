// The shell's context-bar chrome bits that stand apart from the rail: the engine
// identity chip (the connected host) and the account/session area (the
// honestly-verified identity, or the degrade note until whoami resolves). The
// shell entry (app-shell.ts) builds and refreshes both from here so the entry stays the
// assembler, not the renderer.

import { h, clear, svgIcon } from "../lib/dom.ts";
import { accessChip, accessVerdictFromCaller } from "../components/trust-chips.ts";
import { isTourMode } from "../lib/demo/tour-mode.ts";
import { ICON_UPDATE } from "../lib/icons.ts";
import type { Caller } from "../api.ts";

// ---- "Update available" chip --------------------------------------------------------------------

// UpdateChipView is the chip's rendered state: non-null = a verified release genuinely carries a
// newer engine or console component (the pure decision is updateChipView in lib/app-refresh.ts). It
// names WHICH components have an update, NOT a version: the engine and the console version
// independently, so a single number on the chip could not say which it meant. The chip itself is
// dumb: it renders "Update available" and navigates on activation; the decision stays in one place.
export interface UpdateChipView {
  components: string[];
}

// updateChipAriaLabel is the chip's accessible name from the components with an update -- "Engine update
// available" / "Console update available" / "Engine and console updates available" -- so the icon-only
// Compact form still announces exactly what is available, without a version.
export function updateChipAriaLabel(components: string[]): string {
  const names = components.map((c) => (c === "engine" ? "Engine" : c === "console" ? "Console" : c.charAt(0).toUpperCase() + c.slice(1)));
  if (names.length === 0) return "Update available";
  if (names.length === 1) return `${names[0]} update available`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} updates available`;
}

// UPDATE_CHIP_ROUTE is where activating the chip lands: the Updates section on Licence and updates,
// via the ?open= deep-link idiom the licence coordinator handles (the security-centre precedent).
// One exported constant so the shell wiring (dom.ts) and the validator cannot drift from the screen.
export const UPDATE_CHIP_ROUTE = "/licence?open=updates" as const;

// buildUpdateChip builds the context-bar "Update available" pill: HIDDEN until applyUpdateChip is
// handed a real verdict, so it can never flicker in while status loads. It is a real <button>
// (keyboard activation + the universal focus-visible ring for free) whose one job is to deep-link
// to the Updates section on Licence and updates. The glyph is a locally-authored inline SVG
// (lib/icons.ts, no external asset); the text label collapses at the Compact breakpoint
// (tokens.css) while the aria-label keeps the accessible name in every state.
export function buildUpdateChip(onOpen: () => void): HTMLButtonElement {
  const chip = h(
    "button",
    { "data-dp": "shell-chrome.button.chip",
      class: "update-chip",
      type: "button",
      "aria-label": "Update available",
      title: "An update is available. Open the Updates section on Licence and updates.",
      on: { click: () => onOpen() },
    },
    svgIcon(ICON_UPDATE, { size: 14 }),
    h("span", { class: "update-chip__label" }, "Update available"),
  );
  chip.hidden = true;
  return chip;
}

// applyUpdateChip shows or hides the chip from the cached verdict. null hides it outright (the
// honest default: unconfigured, unverified, up to date, or the status not yet loaded); a view shows
// it, with the recommended version beside the label when the channel named one. Idempotent: a
// refresh replaces the version text in place, so the chip appears/disappears with the cache and
// never stacks or flickers. The aria-label names the version, so the icon-only Compact form still
// announces the whole fact.
export function applyUpdateChip(chip: HTMLButtonElement, view: UpdateChipView | null): void {
  if (view === null) {
    chip.hidden = true;
    chip.setAttribute("aria-label", "Update available");
    return;
  }
  chip.setAttribute("aria-label", updateChipAriaLabel(view.components));
  chip.hidden = false;
}

// ---- engine identity chip ---------------------------------------------------

// The chip names the connected host, nothing more. It deliberately carries NO status
// dot: nothing ever drove one (the app only ever knew "unknown"), so a lamp here was a
// permanently grey light that read like a broken indicator. The real health verdict
// lives on the Overview, which probes the engine and can be honest about it.
export function buildEngineChip(opts: { host: string | null }): HTMLElement {
  return h(
    "div",
    { class: "engine-chip", title: opts.host ? `Engine: ${opts.host}` : "No engine connected" },
    h("span", { class: "engine-chip__host mono" }, opts.host ?? "Not connected"),
  );
}

// ---- account / session area -------------------------------------------------

// renderAccount shows the verified identity + role honestly. Until whoami (D1) is
// available it shows the degrade note ("Signed in; identity pending", the engine does
// not yet report it), NEVER a faked identity or a hardcoded green verified chip.
//
// Design decision: the account area is intentionally minimal (the honest identity /
// role chip + a sign-out affordance), not an account dropdown. The capabilities a
// dropdown would have duplicated live in their own homes: a caller inspects their
// effective permissions at /access/roles, re-authenticates through the step-up
// ceremony a gated action triggers, and changes the theme in the Settings appearance
// section. Keeping those one place each avoids a second, drift-prone surface here.
export function renderAccount(slot: HTMLElement, caller: Caller | null, whoamiAvailable: boolean, onSignOut: () => void): void {
  clear(slot);

  if (caller && whoamiAvailable) {
    const roleLabel = caller.role.charAt(0).toUpperCase() + caller.role.slice(1);
    // The Access verdict chip reads the REAL verdict from the resolved caller's
    // method (access -> verified teal, token -> amber fallback), NEVER a hardcoded
    // green. It is the persistent trust telemetry in its design home (the
    // account area). The verdict chip already carries the
    // verified email, so no second copy of it renders beside it.
    slot.appendChild(
      h(
        "div",
        // Layout (inline-flex/gap) lives on the .account-chip class in tokens.css so a viewport media
        // query can make it wrap + shrink on mobile; an inline style would out-rank the query.
        { class: "account-chip" },
        accessChip(accessVerdictFromCaller(caller, whoamiAvailable)),
        h("span", { class: "badge" }, roleLabel),
        // In the public tour ONLY, qualify the verified identity as a SAMPLE one, so even the green
        // "Access verified: <email> / Owner" state reads unmistakably as a demo and cannot be screenshotted as a
        // real account. The guard is the cheap, dependency-free isTourMode, so the genuine console's chip is
        // byte-for-byte unchanged (no qualifier renders there). data-tour-id is an inert hook for a test/marker.
        isTourMode()
          ? h("span", { class: "badge badge--accent", dataset: { tourIdentityDemo: "true" }, title: "This is a sample identity in the product tour, not a real signed-in account." }, "Sample identity")
          : null,
        h(
          "button",
          { "data-dp": "shell-chrome.button.sign-out#1", class: "btn btn--ghost btn--sm", type: "button", on: { click: () => onSignOut() } },
          "Sign out",
        ),
      ),
    );
    return;
  }

  // Degraded: whoami not available. Honest copy, no faked identity, no green chip.
  slot.appendChild(
    h(
      "div",
      // Layout on the .account-chip class (see the verified branch) so the mobile media query can wrap it.
      { class: "account-chip" },
      h(
        "span",
        { class: "account-chip__id", style: "font-size:var(--text-sm);color:var(--text-muted);", title: "The engine does not yet report the verified identity (whoami pending)." },
        "Signed in; identity pending",
      ),
      h(
        "button",
        { "data-dp": "shell-chrome.button.sign-out#2", class: "btn btn--ghost btn--sm", type: "button", on: { click: () => onSignOut() } },
        "Sign out",
      ),
    ),
  );
}
