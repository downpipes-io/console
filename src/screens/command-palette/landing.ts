// The in-page landing (the /command-palette route + the "?" cheat-sheet). Visiting the
// route opens the overlay over a light in-page landing that also documents the keyboard
// layer, so the surface degrades to a readable page if the overlay is dismissed. The
// cheat-sheet reads the SAME role-gated registry the overlay does (via collectCommands +
// the wired defaultRegistry from ./overlay.ts), so the help and the palette can never
// drift. Moved verbatim from the palette coordinator for size; behaviour is unchanged.
// House rules: Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { pageHeader, type ScreenContext } from "../common.ts";
import { goToShortcuts } from "../../shell/registry.ts";
import { ICON_SEARCH } from "../../lib/icons.ts";
import { keycaps, kindHint } from "./shared.ts";
import { openCommandPalette, collectCommands, defaultRegistry } from "./overlay.ts";

export function renderLanding(ctx: ScreenContext): HTMLElement {
  const root = h("div");
  root.appendChild(
    pageHeader(
      "Command palette and keyboard shortcuts",
      "Press Cmd or Ctrl and K from anywhere to search and jump. Everything you can do is one command away, gated to your role. Dangerous actions open their review-then-confirm flow; they never run from the palette.",
      h(
        "button",
        { "data-dp": "command-palette.button.open-command-palette",
          class: "btn btn--primary btn--sm",
          type: "button",
          on: { click: () => openCommandPalette({ ctx }) },
        },
        svgIcon(ICON_SEARCH, { size: 14 }),
        "Open palette",
      ),
    ),
  );

  // The cheat-sheet: the go-to chords + the registry actions visible to this role, so
  // the help and the palette can never drift (both read the one registry). This is the
  // page the "?" shortcut and the /command-palette route land on.
  root.appendChild(renderCheatSheet(ctx));

  // The overlay auto-opens ONLY when the route carries the explicit intent flag
  // (/command-palette?open=1): the Help rail link and the "?" cheat-sheet must land on
  // a readable help page, not a search box to Esc out of first. Cmd/Ctrl-K and the
  // trigger open the overlay directly (no navigation), so they are unaffected.
  // Deferred a tick so the screen is mounted first (the overlay inerts #app, which
  // must already hold this screen).
  if (ctx.query.get("open") === "1") {
    queueMicrotask(() => openCommandPalette({ ctx }));
  }

  return root;
}

function renderCheatSheet(ctx: Pick<ScreenContext, "caller" | "engine">): HTMLElement {
  const card = h("div", { class: "card measure", style: "margin-top:var(--space-5)" });
  card.appendChild(
    h("div", { class: "card__header" }, h("h2", { class: "card__title" }, "Keyboard layer")),
  );

  // Global keys (the shell wires these; documented here from the one registry).
  const globals: Array<{ keys: string[]; what: string }> = [
    { keys: ["Cmd", "K"], what: "Open the command palette (Ctrl K on Windows and Linux)" },
    { keys: ["/"], what: "Open the command palette (a screen with a filter claims it first)" },
    { keys: ["?"], what: "Open this keyboard help" },
    { keys: ["Esc"], what: "Close the topmost overlay" },
    { keys: ["Up"], what: "Move the active result up" },
    { keys: ["Down"], what: "Move the active result down" },
    { keys: ["Enter"], what: "Run the active result" },
  ];
  card.appendChild(sectionLabel("Global"));
  card.appendChild(shortcutList(globals));

  // Go-to chords (derived from the registry so they never drift from the palette).
  const chords = goToShortcuts();
  if (chords.length > 0) {
    card.appendChild(sectionLabel("Go to"));
    card.appendChild(
      shortcutList(
        chords.map((c) => ({
          keys: c.chord.split(" "),
          what: c.title.replace(/^Go to /, ""),
        })),
      ),
    );
  }

  // The commands available to THIS role + engine state, grouped, so the cheat-sheet is
  // an honest list of what the operator can actually run (the same filter, AND the same
  // assembled registry, the palette applies). A viewer sees fewer rows than an owner.
  // Chorded navigations already have their own "Go to" section above, so they are
  // filtered out here rather than listed twice on one cheat-sheet.
  const all = collectCommands(ctx, defaultRegistry);
  const cmds = all.filter((c) => !(c.kind === "navigate" && c.shortcut));
  if (cmds.length > 0) {
    card.appendChild(sectionLabel("Commands available to you"));
    const list = h("ul", { class: "shortcut-list", style: "list-style:none;margin:0;padding:0" });
    for (const c of cmds) {
      list.appendChild(
        h(
          "li",
          { class: "shortcut-row" },
          h("span", { class: "shortcut-row__what" }, c.title),
          c.shortcut
            ? h("span", { class: "shortcut-row__keys" }, ...keycaps(c.shortcut.split(" ")))
            : h("span", { class: "shortcut-row__keys field__hint" }, kindHint(c.kind)),
        ),
      );
    }
    card.appendChild(list);
  } else if (all.length === 0) {
    // No commands resolved AT ALL (no caller yet): honest, never a blank. When only the
    // chorded navigations resolved, the "Go to" section above already lists them.
    card.appendChild(
      h(
        "p",
        { class: "field__hint", style: "margin-top:var(--space-3)" },
        "Your role has not been resolved yet, so the command list is held back rather than guessed. It appears once the engine reports your role.",
      ),
    );
  }
  return card;
}

function sectionLabel(text: string): HTMLElement {
  return h("p", { class: "section-label", style: "margin:var(--space-4) 0 var(--space-2)" }, text);
}

function shortcutList(rows: Array<{ keys: string[]; what: string }>): HTMLElement {
  const list = h("ul", { class: "shortcut-list", style: "list-style:none;margin:0;padding:0" });
  for (const r of rows) {
    list.appendChild(
      h(
        "li",
        { class: "shortcut-row" },
        h("span", { class: "shortcut-row__what" }, r.what),
        h("span", { class: "shortcut-row__keys" }, ...keycaps(r.keys)),
      ),
    );
  }
  return list;
}
