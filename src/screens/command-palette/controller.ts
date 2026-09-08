// The palette controller: the live keyboard + render model bound to one open palette. It
// owns the flat ordered row list, the active index, the stale-result query token and the
// debounce timer, so keyboard movement, Enter and the debounced entity append all operate on
// ONE source of truth. The overlay coordinator builds the static surface, then hands the
// captured elements + the build inputs here and wires the returned render/keydown handlers
// onto the input. This holds per-open instance state (not module state) so each open palette
// has its own controller. Moved verbatim from the overlay for size; behaviour is unchanged.
// House rules: Australian English, no em dashes, precise claims.

import type { ScreenContext } from "../common.ts";
import type { PaletteDispatch } from "./shared.ts";
import { paintList, announceCount, type PaletteRow } from "./rows.ts";
import { buildGroups } from "./groups.ts";
import { appendEntityMatches } from "./entity-append.ts";
import type { Command } from "../../shell/registry.ts";
import { isUnauthorised } from "../../lib/errors.ts";

// Debounce on the entity (downpipe name / run id) source: below the typical 150 ms perceptible
// threshold, above a single keystroke repeat so a fast typist does not fire a fetch per character.
const ENTITY_DEBOUNCE_MS = 140;

export interface PaletteController {
  // render paints the static rows for the query and schedules the debounced entity append.
  render: (query: string) => void;
  // handleKeydown moves the active row (Up/Down/Home/End) or runs it (Enter).
  handleKeydown: (ev: KeyboardEvent) => void;
}

// createPaletteController wires the live model onto the supplied surface elements. `ctx`,
// `dispatch` and `supplied` are the build inputs (registry + caller/engine); `close` closes
// the open overlay.
export function createPaletteController(args: {
  input: HTMLInputElement;
  listbox: HTMLElement;
  statusLive: HTMLElement;
  ctx: Pick<ScreenContext, "caller" | "engine">;
  dispatch: PaletteDispatch;
  supplied: Command[] | undefined;
  close: () => void;
}): PaletteController {
  const { input, listbox, statusLive, ctx, dispatch, supplied, close } = args;

  // The live model: the flat ordered list of currently-rendered rows and the active
  // index, so keyboard movement and Enter operate on one source.
  let rows: PaletteRow[] = [];
  let activeIndex = -1;
  // A token to drop stale async results (a slow downpipes fetch must not overwrite a
  // newer query's render).
  let queryToken = 0;

  const setActive = (index: number) => {
    if (rows.length === 0) {
      activeIndex = -1;
      input.setAttribute("aria-activedescendant", "");
      return;
    }
    const clamped = ((index % rows.length) + rows.length) % rows.length;
    activeIndex = clamped;
    rows.forEach((r, i) => {
      const on = i === clamped;
      r.el.setAttribute("aria-selected", on ? "true" : "false");
      r.el.classList.toggle("cmdp__row--active", on);
      if (on) {
        input.setAttribute("aria-activedescendant", r.el.id);
        r.el.scrollIntoView({ block: "nearest" });
      }
    });
  };

  const runActive = () => {
    const row = rows[activeIndex];
    if (!row) return;
    row.run();
  };

  let debounceTimer: number | undefined;

  // render paints the STATIC rows (registry commands + this screen's actions) instantly
  // for the current query, then schedules the DEBOUNCED async entity source so a
  // downpipe name or run id resolves without a fetch on every keystroke (design-system
  // 6.2). The token (bumped here) drops any in-flight entity append for a stale query.
  const render = (query: string) => {
    const token = ++queryToken;
    const q = query.trim();
    const groups = buildGroups({
      query: q,
      ctx,
      dispatch,
      close,
      supplied,
    });
    // paintList renders the grouped options and returns the flat, run-able row list in
    // visual order; that list IS the keyboard model (one source of truth).
    rows = paintList(listbox, groups, setActive);
    // Choose the first runnable row as active (group headers / the empty row are not in
    // `rows`).
    setActive(rows.length > 0 ? 0 : -1);
    announceCount(statusLive, rows.length, q);

    // Schedule the entity source (debounced). It reads NAMES/LABELS/IDS only (no-custody)
    // and merges matched downpipes, runs, destinations, credentials and audit entries in
    // (each capability-gated to what the caller may see), never blocking the static
    // results; it uses the per-entity cache when present (so only the first settled query
    // hits the network).
    window.clearTimeout(debounceTimer);
    if (q.length > 0 && ctx.engine) {
      const engine = ctx.engine;
      debounceTimer = window.setTimeout(() => {
        // The query may have moved on during the debounce; only append if this is still
        // the current token (appendEntityMatches re-checks too, for the await window).
        if (token !== queryToken) return;
        // Fire-and-forget by design: entity append degrades to fewer results, it never breaks the
        // already-painted static rows. The only escape worth acting on is a 401 (the internal 401
        // path closes too); catch it here so an unexpected rejection is not silently swallowed.
        appendEntityMatches({
          engine,
          caller: ctx.caller,
          query: q,
          token,
          currentToken: () => queryToken,
          listbox,
          getRows: () => rows,
          setRows: (r) => { rows = r; },
          setActiveAt: (i) => setActive(i),
          rebindActive: () => setActive(activeIndex < 0 ? 0 : activeIndex),
          announce: (n) => announceCount(statusLive, n, q),
          close,
        }).catch((err) => {
          if (isUnauthorised(err)) close();
        });
      }, ENTITY_DEBOUNCE_MS);
    }
  };

  // Keyboard: Up/Down/Home/End move the active row; Enter runs it; Esc is handled by
  // the overlay engine (it closes the topmost layer). Tab is trapped by the overlay.
  const handleKeydown = (ev: KeyboardEvent) => {
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        setActive(activeIndex + 1);
        break;
      case "ArrowUp":
        ev.preventDefault();
        setActive(activeIndex - 1);
        break;
      case "Home":
        ev.preventDefault();
        setActive(0);
        break;
      case "End":
        ev.preventDefault();
        setActive(rows.length - 1);
        break;
      case "Enter":
        ev.preventDefault();
        runActive();
        break;
      default:
        break;
    }
  };

  return { render, handleKeydown };
}
