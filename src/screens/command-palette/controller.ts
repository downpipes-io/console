// The palette controller: the live keyboard + render model bound to one open palette. It
// owns the flat ordered row list, the active index, the stale-result query token and the
// debounce timer, so keyboard movement, Enter and the debounced entity append all operate on
// ONE source of truth. The overlay coordinator builds the static surface, then hands the
// captured elements + the build inputs here and wires the returned render/keydown handlers
// onto the input. This holds per-open instance state (not module state) so each open palette
// has its own controller.
//
// Rendering happens in up to two passes per query, so the leading "Top hit" row always names
// the single best match, static or entity: the static command groups paint instantly
// (buildGroups + composeTopHit with no entity groups yet, so the Top hit is whichever command
// scored best); once the debounced entity source resolves,
// a second full repaint re-runs composeTopHit with the real entity groups, which may promote
// a downpipe/run/destination/credential/audit match into the Top hit slot instead (a keyword
// entity-less command top always loses to a real name match). The active selection survives
// the repaint by row id: unmoved (still row 0, "whatever Enter would have run") it stays on
// row 0, so Enter still runs the (possibly now-different) Top hit; a manually-arrowed
// selection is rebound to the same row if it still exists, else falls back to row 0.

import type { ScreenContext } from "../common.ts";
import type { PaletteDispatch } from "./shared.ts";
import { paintList, announceCount, type PaletteRow, type RowGroup } from "./rows.ts";
import { buildGroups, composeTopHit } from "./groups.ts";
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
// the open overlay. `ctx` is a getter, read once per render, so a caller that resolves while
// the palette is open gates the next paint.
export function createPaletteController(args: {
  input: HTMLInputElement;
  listbox: HTMLElement;
  statusLive: HTMLElement;
  enterHintLabel: HTMLElement;
  ctx: () => Pick<ScreenContext, "caller" | "engine">;
  dispatch: PaletteDispatch;
  supplied: Command[] | undefined;
  close: () => void;
}): PaletteController {
  const { input, listbox, statusLive, enterHintLabel, ctx, dispatch, supplied, close } = args;

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
      enterHintLabel.textContent = "run";
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
    // Enter's hint always names what Enter will do (the Focus Flow pattern: one primary,
    // its keyboard hint runs the obvious answer).
    enterHintLabel.textContent = rows[clamped]!.title;
  };

  const runActive = () => {
    const row = rows[activeIndex];
    if (!row) return;
    row.run();
  };

  let debounceTimer: number | undefined;

  // render paints the STATIC rows (registry commands + this screen's actions) instantly for
  // the current query, with a leading "Top hit" row when the query is non-empty: composeTopHit
  // picks the single best-scoring row across every group, so Enter with no arrow movement runs
  // what was typed rather than whichever fixed group (Navigation, Downpipes, Runs, Actions)
  // happens to sort first. It then schedules the DEBOUNCED async entity source so a downpipe
  // name or run id resolves without a fetch on every keystroke
  // (design-system 6.2); once it settles, a second full repaint re-runs composeTopHit with
  // the real entity groups, which may promote an entity into the Top hit slot instead. The
  // token (bumped here) drops any in-flight entity append for a stale query.
  const render = (query: string) => {
    const token = ++queryToken;
    const q = query.trim();
    const live = ctx();
    const built = buildGroups({
      query: q,
      ctx: live,
      dispatch,
      close,
      supplied,
    });
    // An empty query keeps today's order (no Top hit; recent/contextual ordering is a
    // follow-on, not built here). A non-empty one gets the Top hit group, computed from the
    // static commands alone until the entity source (below) resolves.
    const initialGroups: RowGroup[] = q === "" ? built.groups : composeTopHit(built, [], close);
    // paintList renders the grouped options and returns the flat, run-able row list in
    // visual order; that list IS the keyboard model (one source of truth).
    rows = paintList(listbox, initialGroups, setActive);
    // Choose the first runnable row as active (group headers / the empty row are not in
    // `rows`): the Top hit when there is one, otherwise the first row of the first group.
    setActive(rows.length > 0 ? 0 : -1);
    announceCount(statusLive, rows.length, q);

    // Schedule the entity source (debounced). It reads NAMES/LABELS/IDS only (no-custody)
    // and resolves matched downpipes, runs, destinations, credentials and audit entries
    // (each capability-gated to what the caller may see), never blocking the static
    // results; it uses the per-entity cache when present (so only the first settled query
    // hits the network).
    window.clearTimeout(debounceTimer);
    if (q.length > 0 && live.engine) {
      const engine = live.engine;
      debounceTimer = window.setTimeout(() => {
        // The query may have moved on during the debounce; only append if this is still
        // the current token (appendEntityMatches re-checks too, for the await window).
        if (token !== queryToken) return;
        // Fire-and-forget by design: entity resolution degrades to fewer results, it never breaks the
        // already-painted static rows. The only escape worth acting on is a 401 (the internal 401
        // path closes too); catch it here so an unexpected rejection is not silently swallowed.
        appendEntityMatches({
          engine,
          caller: live.caller,
          query: q,
          token,
          currentToken: () => queryToken,
          listbox,
          close,
          onResolved: (entityGroups) => {
            // A newer render superseded this one while the fetch was in flight: drop it.
            if (token !== queryToken) return;
            // The entity fetch can itself change which COMMANDS are visible: it is what fills the
            // downpipe cache that hasDownpipes reads, so on the first query after a load the static
            // rows above were gated on an empty cache (no Request a restore, no Apply a restore).
            // Rebuild them now, so the repaint gates on what the fetch just learned.
            const fresh = buildGroups({ query: q, ctx: ctx(), dispatch, close, supplied });
            // Nothing new to show: no entity matched and the command rows are the same, so skip the
            // repaint rather than churn the DOM (and the operator's in-flight arrow keys) for nothing.
            // This is the common case, as most queries resolve no entity.
            if (entityGroups.length === 0 && sameItems(fresh.groups, built.groups)) return;
            const composed = composeTopHit(fresh, entityGroups, close);
            // Preserve the operator's selection across the repaint by row id: unmoved (still
            // row 0, "whatever Enter runs") stays on row 0 even if that is now a different
            // row; a manual selection is rebound to the same row if it still exists.
            const wasUnmoved = activeIndex <= 0;
            const previousId = rows[activeIndex]?.el.id;
            rows = paintList(listbox, composed, setActive);
            const rebindIndex = wasUnmoved ? 0 : rows.findIndex((r) => r.el.id === previousId);
            setActive(rebindIndex >= 0 ? rebindIndex : rows.length > 0 ? 0 : -1);
            announceCount(statusLive, rows.length, q);
          },
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

// sameItems reports whether two groupings list the same rows in the same order, by row id.
function sameItems(a: RowGroup[], b: RowGroup[]): boolean {
  const ids = (gs: RowGroup[]): string => gs.map((g) => `${g.label}:${g.items.map((i) => i.id).join(",")}`).join("|");
  return ids(a) === ids(b);
}
