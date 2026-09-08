// The static DOM surface of the palette: the role="dialog" shell with its visually-hidden
// title, the role="combobox" input, the role="listbox" results list, the polite result-count
// live region and the keyboard-hint footer. This is pure DOM construction with no state and no
// closures; the overlay coordinator wires the live model (rows / active index) and the event
// listeners onto the returned elements. The element ids are constants so the aria wiring
// (aria-controls / aria-labelledby / aria-activedescendant) is stable. Moved verbatim from the
// overlay for size; behaviour is unchanged. House rules: Australian English, no em dashes,
// precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { ICON_SEARCH } from "../../lib/icons.ts";
import { hint } from "./rows.ts";

export interface PaletteSurface {
  surface: HTMLElement;
  input: HTMLInputElement;
  listbox: HTMLElement;
  statusLive: HTMLElement;
}

// buildPaletteSurface assembles the static palette DOM and returns the handles the
// coordinator binds behaviour onto. No event listeners and no model are attached here.
export function buildPaletteSurface(): PaletteSurface {
  const listboxId = "cmdp-listbox";
  const inputId = "cmdp-input";
  const titleId = "cmdp-title";
  const statusId = "cmdp-status";

  // The accessible title (visually hidden; the input's placeholder is the visible cue).
  const title = h("h2", { class: "visually-hidden", id: titleId }, "Command palette");

  const input = h("input", {
    class: "cmdp__input",
    id: inputId,
    type: "text",
    role: "combobox",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: false,
    "aria-expanded": "true",
    "aria-controls": listboxId,
    "aria-autocomplete": "list",
    "aria-activedescendant": "",
    "aria-labelledby": titleId,
    // The honest claim: commands and downpipe names match instantly; a query also
    // resolves a run id, a destination, a tracked credential and an audit entry number
    // through the debounced entity source, each capability-gated to what the caller may
    // see. The placeholder names what genuinely resolves.
    placeholder: "Search commands, downpipes, runs, destinations and credentials",
  }) as HTMLInputElement;

  const listbox = h("ul", {
    class: "cmdp__list",
    id: listboxId,
    role: "listbox",
    "aria-label": "Results",
  });

  // The polite live region announcing the result count (4.1.3). Kept inside the dialog
  // so it is read while the palette has focus.
  const statusLive = h("span", {
    class: "visually-hidden",
    id: statusId,
    role: "status",
    "aria-live": "polite",
  });

  // No standing footer caveat about dangerous actions: each dangerous row already
  // carries its own "review step" badge (the same fact at two levels of one surface).
  const footer = h(
    "div",
    { class: "cmdp__footer" },
    hint(["Up", "Down"], "navigate"),
    hint(["Enter"], "run"),
    hint(["Esc"], "close"),
  );

  const surface = h(
    "div",
    {
      class: "cmdp",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": titleId,
      tabindex: "-1",
    },
    title,
    h(
      "div",
      { class: "cmdp__search" },
      h("span", { class: "cmdp__search-icon", "aria-hidden": "true" }, svgIcon(ICON_SEARCH, { size: 16 })),
      input,
    ),
    listbox,
    footer,
    statusLive,
  );

  return { surface, input, listbox, statusLive };
}
