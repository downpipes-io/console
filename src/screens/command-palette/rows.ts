// The palette row model and the DOM render helpers that build it. The flat run-able row,
// the grouped-item shapes, the per-command glyph map, the matched-character highlighter, the
// single option-row builder shared by the static command rows and the async entity rows, the
// grouped-list painter that returns the keyboard model, the result-count announcement and the
// keyboard-hint chip. These build DOM but hold no state; they are a leaf so both the overlay's
// instant static render and its async entity append import them from one place and the row
// anatomy never drifts. Moved verbatim from the palette coordinator for size; behaviour is
// unchanged. House rules: Australian English, no em dashes, precise claims.

import { h, svgIcon, clear, type Child } from "../../lib/dom.ts";
import {
  ICON_SEARCH,
  ICON_OVERVIEW,
  ICON_DOWNPIPES,
  ICON_RUNS,
  ICON_RESTORE,
  ICON_KEYS,
  ICON_ACCESS,
  ICON_AUDIT,
  ICON_SETTINGS,
  ICON_LICENCE,
  ICON_PLUS,
  ICON_PLAY,
  ICON_REFRESH,
  ICON_EXTERNAL,
  ICON_INFO,
  ICON_CHEVRON_RIGHT,
  ICON_ALERT,
  ICON_SHIELD_CHECK,
} from "../../lib/icons.ts";
import type { Command, CommandKind } from "../../shell/registry.ts";
import { keycaps } from "./shared.ts";

// Accessibility tick between clearing and re-setting the live region, so a screen reader re-announces
// an identical phrase (an unchanged textContent is not re-read). Short enough to feel instant.
const ANNOUNCE_TICK_MS = 30;

export interface PaletteRow {
  el: HTMLLIElement;
  run: () => void;
}

export interface RowGroup {
  label: string;
  items: BuiltItem[];
}

export interface BuiltItem {
  id: string;
  title: string;
  // The matched-character ranges in the title, for highlighting.
  matches: number[];
  icon: string;
  hint?: string; // a keyboard chord or a "review step" cue (commands)
  meta?: string; // a trailing meta line (entities: source type / "latest run of X")
  kind: CommandKind;
  run: () => void;
}

export function toBuiltItem(cmd: Command, matches: number[], run: () => void): BuiltItem {
  return {
    id: cmd.id,
    title: cmd.title,
    matches,
    icon: iconFor(cmd),
    ...(cmd.shortcut ? { hint: cmd.shortcut } : cmd.kind === "flow" ? { hint: "review" } : {}),
    kind: cmd.kind,
    run,
  };
}

// iconFor picks a glyph for a command from its target/group (the icon set is the
// console's bespoke inline-SVG set; no icon font). Navigation commands map to their
// destination glyph so the palette mirrors the rail.
function iconFor(cmd: Command): string {
  if (cmd.kind === "navigate") {
    switch (cmd.target) {
      case "/": return ICON_OVERVIEW;
      case "/downpipes": return ICON_DOWNPIPES;
      case "/downpipes/new": return ICON_PLUS;
      case "/runs": return ICON_RUNS;
      case "/restore": return ICON_RESTORE;
      case "/restore/approvals": return ICON_RESTORE;
      case "/keys": return ICON_KEYS;
      case "/access": return ICON_ACCESS;
      case "/access/roles": return ICON_ACCESS;
      // The elevated Access area owns the tamper-evident log at /access/audit; keep the
      // legacy /audit mapped too so a stale deep link still resolves to the right glyph.
      case "/access/audit": return ICON_AUDIT;
      case "/audit": return ICON_AUDIT;
      case "/settings": return ICON_SETTINGS;
      case "/licence": return ICON_LICENCE;
      // Notifications + Security centre (section 9): mirror their rail glyphs.
      case "/notifications": return ICON_ALERT;
      case "/notifications/rules": return ICON_ALERT;
      case "/security": return ICON_SHIELD_CHECK;
      case "/onboarding/connect": return ICON_REFRESH;
      default: return ICON_CHEVRON_RIGHT;
    }
  }
  switch (cmd.target) {
    case "restore.start": return ICON_RESTORE;
    case "keys.recovery-sheet": return ICON_KEYS;
    case "access.verify": return ICON_ACCESS;
    case "licence.check-updates": return ICON_REFRESH;
    case "audit.export": return ICON_AUDIT;
    case "theme.toggle": return ICON_INFO;
    case "view.toggle": return ICON_OVERVIEW;
    case "auth.sign-out": return ICON_EXTERNAL;
    case "palette.open": return ICON_SEARCH;
    default: return ICON_PLAY;
  }
}

// ---------------------------------------------------------------------------
// Painting the grouped list into the listbox (and reporting back the flat rows).
// ---------------------------------------------------------------------------

// paintList renders the grouped items as listbox options (with presentational group
// headers) and RETURNS the flat, run-able row list in visual order. That returned list
// is the keyboard model, so the DOM and the model are one source built together. A
// truly-empty result paints a teaching empty row (not an option) and returns []. Each
// option carries role="option" + aria-selected; the active row is set by the caller via
// aria-activedescendant. Highlighting marks matched characters with <mark>.
export function paintList(
  listbox: HTMLElement,
  groups: RowGroup[],
  setActive: (i: number) => void,
): PaletteRow[] {
  clear(listbox);
  const rows: PaletteRow[] = [];

  if (groups.length === 0) {
    listbox.appendChild(
      h(
        "li",
        { class: "cmdp__empty", role: "presentation" },
        h("span", { class: "cmdp__empty-title" }, "No matches"),
        // Every suggested verb must resolve for every role today (both "restore" and "drill"
        // match ungated commands); a suggestion that returns "No matches" again teaches the
        // operator the palette is broken.
        h("span", { class: "field__hint" }, "Try a downpipe name, or a verb like restore or drill."),
      ),
    );
    return rows;
  }

  let flatIndex = 0;
  for (const group of groups) {
    // A group header (presentational; the options carry the semantics).
    listbox.appendChild(h("li", { class: "cmdp__group", role: "presentation" }, group.label));
    for (const item of group.items) {
      const idx = flatIndex++;
      const li = buildOptionRow(item, () => setActive(idx));
      listbox.appendChild(li);
      rows.push({ el: li, run: item.run });
    }
  }
  return rows;
}

// buildOptionRow builds one listbox <li role="option"> for a command/entity item: the
// glyph, the highlighted title, and a trailing hint (a keyboard chord, a "review step"
// badge for a dangerous flow, or an entity meta line). Hovering sets it active so mouse
// and keyboard agree; a click runs it. Shared by the static rows and the async entity
// rows so the row anatomy never drifts.
export function buildOptionRow(item: BuiltItem, onHover: () => void): HTMLLIElement {
  const li = h("li", {
    class: "cmdp__row",
    id: `cmdp-opt-${item.id}`,
    role: "option",
    "aria-selected": "false",
  }) as HTMLLIElement;
  li.appendChild(h("span", { class: "cmdp__row-icon", "aria-hidden": "true" }, svgIcon(item.icon, { size: 16 })));
  li.appendChild(h("span", { class: "cmdp__row-title" }, ...highlight(item.title, item.matches)));
  if (item.meta) {
    li.appendChild(h("span", { class: "cmdp__row-hint cmdp__row-hint--meta" }, item.meta));
  } else if (item.hint) {
    // A chord hint is either a multi-key combo (whitespace, like "Cmd K") or a single-glyph key
    // (length 1, like "?"). The "review" flow badge is neither (length 6, no whitespace), so it
    // falls through to the flow branch without a separate guard.
    const isChord = /\s/.test(item.hint) || item.hint.length === 1;
    li.appendChild(
      isChord
        ? h("span", { class: "cmdp__row-hint" }, ...keycaps(item.hint.split(" ")))
        : h("span", { class: "cmdp__row-hint cmdp__row-hint--flow" }, item.hint === "review" ? "review step" : item.hint),
    );
  } else if (item.kind === "flow") {
    li.appendChild(h("span", { class: "cmdp__row-hint cmdp__row-hint--flow" }, "review step"));
  }
  li.addEventListener("mousemove", onHover);
  li.addEventListener("click", () => item.run());
  return li;
}

// highlight splits a title into text + <mark> runs for the matched indices.
function highlight(title: string, matches: number[]): Child[] {
  if (matches.length === 0) return [title];
  const set = new Set(matches);
  const out: Child[] = [];
  let buf = "";
  let marking = false;
  const flush = () => {
    if (buf === "") return;
    out.push(marking ? h("mark", { class: "cmdp__mark" }, buf) : buf);
    buf = "";
  };
  for (let i = 0; i < title.length; i++) {
    const isMark = set.has(i);
    if (isMark !== marking) {
      flush();
      marking = isMark;
    }
    buf += title[i];
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// The keyboard-hint chip + the result-count live announcement.
// ---------------------------------------------------------------------------

export function hint(keys: string[], label: string): HTMLElement {
  return h(
    "span",
    { class: "cmdp__hint" },
    ...keycaps(keys),
    h("span", { class: "cmdp__hint-label" }, label),
  );
}

export function announceCount(live: HTMLElement, count: number, query: string): void {
  const phrase =
    count === 0
      ? query
        ? `No results for ${query}`
        : "No commands available"
      : `${count} ${count === 1 ? "result" : "results"}${query ? ` for ${query}` : ""}`;
  // Clear then set on a tick (ANNOUNCE_TICK_MS) so a repeat phrase is still announced.
  live.textContent = "";
  window.setTimeout(() => { live.textContent = phrase; }, ANNOUNCE_TICK_MS);
}
