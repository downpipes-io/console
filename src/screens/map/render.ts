// The topology map's body-assembly render helpers (the controller is the lifecycle owner; the
// DOM assembly lives here). These are pure free functions: each builds one cohesive part of the
// map view from the data and handlers it is given, with no reference to the MapView instance, so
// the controller's refresh path stays a thin sequence of calls. They consume the same
// presentation leaves the controller used (./panels.ts, ./view-chrome.ts, ./filter-bar.ts) plus
// the design-system dom helper.

import { h } from "../../lib/dom.ts";
import { absoluteTime } from "../../lib/format.ts";
import { toast } from "../../components/toast.ts";
import { blockError } from "../../components/error-view.ts";
import type { FlowRecord, FlowStatus, NodeKind } from "../../components/topology.ts";
import type { MapData } from "./data.ts";
import { destinationNote } from "./panels.ts";
import {
  unknownNote,
  viewStatusLine,
  filteredEmptyNote,
  emptyAccountCta,
} from "./view-chrome.ts";
import { buildFilterBar, type FilterState } from "./filter-bar.ts";
import type { MapVisual } from "./visual.ts";

// The mutation callbacks the filter bar and the empty-account CTA need. The controller owns
// the state these write; the render helpers only forward them so the assembled chrome stays
// the same DOM the controller produced inline.
export interface MapBodyHandlers {
  onStatus: (s: FlowStatus | null) => void;
  onKind: (k: NodeKind | null) => void;
  onClearNode: () => void;
  onClearAll: () => void;
  onNavigateSources: () => void;
  onCopyDiagnostics: () => void;
}

// The stable nodes and current visual the controller re-parents across renders, passed in so
// the assembled body re-parents the SAME nodes (the visual's focus / roving state and the
// stale note's text are preserved, exactly as the inline assembly did).
export interface MapBodyContext {
  visual: MapVisual | null;
  staleNote: HTMLElement;
  filters: FilterState;
}

// buildMapBody assembles the chrome around the mounted visual: the destination honesty note,
// the standing stale-data note, the filter toolbar (only when there is something to filter),
// an optional partial note, an optional filtered-to-nothing note, then the visual itself
// (which carries the canvas-or-SVG AND the accessible table). The visual element is STABLE
// across re-renders (the controller re-parents the same node), so its internal focus / roving
// state is not needlessly thrown away on a poll.
export function buildMapBody(
  allFlows: FlowRecord[],
  visible: FlowRecord[],
  data: MapData,
  ctx: MapBodyContext,
  handlers: MapBodyHandlers,
): HTMLElement {
  const body = h("div", { class: "topo-screen" });

  // The destination honesty line: N sources -> 1 archive destination, named from the real
  // destKind. Always present so the single-destination model is stated, never implied.
  body.appendChild(destinationNote(allFlows, data));

  // The standing stale-data note (hidden while fresh; populated by a failed poll).
  body.appendChild(ctx.staleNote);

  // The filter toolbar (status + kind), shown only when there is something to filter (more
  // than one flow). Filters live in the query string (replaceState) so a view is shareable
  // and survives refresh. A "Clear" appears when any filter is active.
  if (allFlows.length > 1) {
    body.appendChild(
      buildFilterBar(allFlows, visible, ctx.filters, {
        onStatus: handlers.onStatus,
        onKind: handlers.onKind,
        onClearNode: handlers.onClearNode,
        onClearAll: handlers.onClearAll,
      }),
    );
  }

  // The partial note: when SOME flows could not be resolved to a real
  // status (history unavailable, or the whole status read failed), say so plainly so the
  // "unknown" edges are explained rather than read as a fault.
  const unknownCount = visible.filter((f) => f.status === "unknown").length;
  const note = unknownNote(unknownCount, data.history.ok);
  if (note) body.appendChild(note);

  // A filtered-to-nothing note: the component still renders its empty state + empty table,
  // but we explain it is the FILTER, not an empty account, with a Clear affordance (so
  // data never seems to have vanished).
  if (allFlows.length > 0 && visible.length === 0) {
    body.appendChild(filteredEmptyNote(handlers.onClearAll));
  }

  appendVisual(body, allFlows, ctx.visual, handlers);
  return body;
}

// appendVisual appends the mounted visual (SVG enhancement or WebGL canvas + the always-present
// accessible table; a stable node re-parented across renders), the honest view-status line, and
// the empty-account onboarding CTA. Kept separate from buildMapBody so the chrome assembly stays terse.
export function appendVisual(
  body: HTMLElement,
  allFlows: FlowRecord[],
  visual: MapVisual | null,
  handlers: MapBodyHandlers,
): void {
  // The mounted visual. Stable node, re-parented across renders.
  if (visual) body.appendChild(visual.el);

  // The honest view-status line: which renderer is actually live and whether it is
  // animating, stated in one quiet sentence so "the map looks dead" is diagnosable from a
  // screenshot. Several silently degraded states are otherwise indistinguishable: a static
  // frame via a motion preference, or the SVG fallback after a GL failure, with nothing else
  // on the screen admitting to it.
  if (visual && allFlows.length > 0) {
    body.appendChild(viewStatusLine(visual, () => handlers.onCopyDiagnostics()));
  }

  // The onboarding link beneath the component's own empty-state copy (the component states
  // what the map is; the screen owns the next action, since the component imports no
  // router). Only when the account is genuinely empty (no downpipes at all). ONE CTA, the
  // canonical Sources-first step (the same one the Downpipes empty state teaches): a
  // downpipe's editor has nothing to bind until a source is attached.
  if (allFlows.length === 0) {
    body.appendChild(emptyAccountCta(() => handlers.onNavigateSources()));
  }
}

// renderFirstLoadError replaces the screen content with the honest whole-screen error block
// (inline block with Retry, operator context preserved via location.origin for the
// CONSOLE_ORIGIN hint). Retry re-runs the load in place (no page reload).
export function renderFirstLoadError(content: HTMLElement, err: unknown, onRetry: () => void): void {
  content.replaceChildren(blockError(err, onRetry, { origin: location.origin }));
}

// markStaleFailure updates the standing inline stale-data note for a poll failure with a map
// already on screen: keep it, but never quietly. It writes the "as of" note text and shows it,
// raises ONE warn toast on the first consecutive failure (so a long outage does not re-toast
// every poll), and returns the polite-live-region sentence the controller announces. The caller
// owns the failure COUNT (passed in already incremented) and the timestamp; this is the
// presentation.
export function markStaleFailure(
  staleNote: HTMLElement,
  pollFailures: number,
  lastLoadedAt: number | null,
): string {
  const asOf = lastLoadedAt !== null ? ` (as of ${absoluteTime(lastLoadedAt)})` : "";
  staleNote.textContent = `Could not refresh the map; showing the last known state${asOf}.`;
  staleNote.hidden = false;
  if (pollFailures === 1) {
    toast({ tone: "warn", message: "Could not refresh the map, showing the last known state.", durationMs: 6000 });
  }
  return "Could not refresh the map; showing the last known state.";
}

// summaryAnnouncement builds the polite-live-region sentence spoken after a successful poll:
// how many flows are shown of the total, plus the failed / stale counts when non-zero. Pure.
export function summaryAnnouncement(allFlows: FlowRecord[], visible: FlowRecord[]): string {
  const failed = visible.filter((f) => f.status === "failed").length;
  const stale = visible.filter((f) => f.status === "stale").length;
  // A lane whose destination has never held a copy is spoken too. It is not a failed run and it is not a
  // stale one, so without this count a screen-reader user polling this map would hear nothing about it.
  const noCopy = visible.filter((f) => f.status === "no-copy").length;
  const parts: string[] = [`Map refreshed: ${visible.length} of ${allFlows.length} flows shown`];
  if (failed) parts.push(`${failed} failed`);
  if (stale) parts.push(`${stale} stale`);
  if (noCopy) parts.push(`${noCopy} with no copy`);
  return `${parts.join(", ")}.`;
}
