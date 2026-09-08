// Restore (IA screens 3 + 4) run context (the left column): the rich run-detail panel, the
// recent-run timeline strip, and the proof surface, loaded for the run being restored. It
// loads independently of the flow so a slow history fetch never blocks the dry-run. Moved
// verbatim out of restore-flow.ts for size. No-custody is never weakened (counts and dated
// facts only, no value). House rules: Australian English, no em dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { collapsedSection } from "../common.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { blockError, inlineOutcome } from "../../components/error-view.ts";
import { statusWithLabel, runStatusTone } from "../../components/status.ts";
import { relativeTime, absoluteTime, groupNumber, humanBytes } from "../../lib/format.ts";
import type { EngineClient, RunHistoryEntry } from "../../api.ts";
import { cardSkeleton, factRow, runIdCell, legendSwatch, fetchDownpipeNames, downpipeIdentityCell } from "./shared.ts";
import { renderProofCard } from "./proof.ts";

// ---- run context (left column): rich run detail + timeline + drill -----------

export function renderRunContext(
  engine: EngineClient,
  runId: string,
  // onLocated is a best-effort side channel for workspace.ts's mobile identity strip: once the
  // history fetch below resolves the SAME run this card renders, it is handed the run + its owning
  // downpipe id so a compact strip (downpipe id, run id, sealed status) can render above the stepper
  // on narrow widths, without a second fetch or duplicating the locate logic. Never called when the
  // run is not found (there is nothing to name).
  onLocated?: (run: RunHistoryEntry, downpipeId: string) => void,
): HTMLElement {
  const region = h("div", { class: "stack" });
  // Card-shaped placeholder: the loaded content is a card, so a bare row skeleton would
  // lie about the layout and jump on arrival.
  region.appendChild(cardSkeleton(4));

  // Resolve the run's owning downpipe + history ring from the fleet history (the run id
  // is the join key), alongside the fleet's
  // id -> name map (shared.ts fetchDownpipeNames, the same join runs/view.ts already uses) so
  // the run detail card can name the downpipe rather than showing only its raw id. This is
  // read-only context, so a failure degrades to a calm note, never an error that blocks restore;
  // a failed or slow name read degrades to the raw id (fetchDownpipeNames never throws).
  void Promise.all([engine.listAllHistory(), fetchDownpipeNames(engine)])
    .then(([all, names]) => {
      const located = locateRun(all.byDownpipe, runId);
      region.replaceChildren();
      if (!located) {
        // The run is not in the recent ring (it may have rolled off, RING_CAP); the
        // restore can still proceed by run id, so this is an honest note, not a failure.
        region.appendChild(
          inlineOutcome({
            heading: "Run not in the recent ring",
            reason: "This run is not in the recent-run history, which is a bounded ring. You can still build a restore plan from its run id on the right.",
            reassurance: "Restorability evidence for older runs lives in the drill-evidence log.",
          }),
        );
        return;
      }
      // The run detail is the one EAGER context card; the timeline and the proof surface
      // are demoted behind collapsed disclosures so the screen meets the 3-eager-section
      // budget while staying find-in-page-able.
      region.appendChild(renderRunDetailCard(located.run, located.downpipeId, names.get(located.downpipeId)));
      region.appendChild(collapsedSection("Recent runs", renderRunTimeline(located.ring, runId)));
      region.appendChild(collapsedSection("Prove this run restores", renderProofCard(engine, located.run, located.downpipeId)));
      onLocated?.(located.run, located.downpipeId);
    })
    .catch((err) => {
      if (isUnauthorised(err)) return goSignedOut();
      region.replaceChildren(
        blockError(err, () => region.replaceChildren(renderRunContext(engine, runId)), { origin: location.origin }),
      );
    });

  return region;
}

interface LocatedRun {
  run: RunHistoryEntry;
  downpipeId: string;
  ring: RunHistoryEntry[];
}

function locateRun(byDownpipe: Record<string, RunHistoryEntry[]>, runId: string): LocatedRun | null {
  for (const id of Object.keys(byDownpipe)) {
    const ring = byDownpipe[id] ?? [];
    const run = ring.find((r) => r.runId === runId);
    if (run) return { run, downpipeId: id, ring };
  }
  return null;
}

// renderRunDetailCard is the rich run-detail panel (wireframe "Run detail"): the full
// facts of one run as a definition list (records, bytes, freshness, status, errors),
// with status by hue + shape + label. A failed run shows its coarse enumerated error
// inline (escaped, never a stack). downpipeName (best-effort, from fetchDownpipeNames) names
// the owning downpipe beside its id, rather than the id alone.
function renderRunDetailCard(run: RunHistoryEntry, downpipeId: string, downpipeName?: string): HTMLElement {
  const card = h("section", { class: "card stack-sm", "aria-labelledby": "rc-rd-h" });
  const { tone, label } = runStatusTone(run.status);
  card.appendChild(
    h(
      "div",
      { class: "restore-detail__head" },
      h("h2", { class: "card__title", id: "rc-rd-h" }, "Run detail"),
      statusWithLabel(tone, run.status === "ok" ? "Sealed, ok" : label),
    ),
  );

  const facts = h("dl", { class: "run-facts" });
  factRow(facts, "Downpipe", downpipeIdentityCell(downpipeId, downpipeName));
  factRow(facts, "Run id", runIdCell(run.runId));
  factRow(facts, "Index", h("span", { class: "tnum" }, String(run.index)));
  factRow(facts, "Started", h("span", { title: absoluteTime(run.startedAt) }, `${relativeTime(run.startedAt)} (${absoluteTime(run.startedAt)})`));
  factRow(facts, "Records", h("span", { class: "tnum" }, groupNumber(run.recordCount)));
  factRow(facts, "Bytes", h("span", { class: "tnum" }, humanBytes(run.bytes)));
  card.appendChild(facts);

  if (run.status === "failed" && run.error) {
    card.appendChild(inlineOutcome({ heading: "This run failed", reason: run.error, reassurance: "A failed run can still be drilled and, if a prior run is good, restored from." }));
  }
  return card;
}

// renderIdentityStrip (mobile): the same three leading facts renderRunDetailCard shows
// (downpipe, run id, sealed status), condensed to one row. Used ONLY below 1100px (tokens.css hides
// it above that width) so a stacked layout never buries the run identity below a long flow column;
// the full run-detail card above stays the desktop source of truth and this never replaces it.
// Exported so workspace.ts (which owns the identity-strip host, a grid sibling so CSS order can
// place it first on narrow widths) can populate it from the SAME onLocated callback above, without a
// second fetch or a duplicated locate.
export function renderIdentityStrip(run: RunHistoryEntry, downpipeId: string): HTMLElement {
  const { tone, label } = runStatusTone(run.status);
  return h(
    "div",
    { class: "restore-identity-strip__row" },
    h("span", { class: "restore-identity-strip__dp mono" }, downpipeId),
    h("span", { class: "restore-identity-strip__run mono" }, run.runId || "-"),
    statusWithLabel(tone, run.status === "ok" ? "Sealed, ok" : label),
  );
}

// renderRunTimeline is the run-status timeline (wireframe "Recent runs", design-system
// 6.10): a horizontal strip of status cells, newest on the right, each keyboard-
// focusable with a full accessible label, with the run being restored marked. Status is
// hue + shape + texture (the .run-cell CSS carries a hatch/dash for non-colour cues).
// Rendered as a disclosure BODY (the collapsedSection summary carries the heading).
//
// Recent-runs hover focus: hovering or keyboard-focusing one cell lights it and dims
// every sibling cell, mirroring the map's shipped hover-focus idiom (components/
// live-flow-node-layer.ts setFocus / tokens.css .live-flow__node--lit): ONE setFocus call
// re-derives every cell's lit state from scratch on each hover/focus change (rather than each
// cell toggling only its own class), so a fast pointer/keyboard handoff between cells can
// never leave two cells (or none) lit at once. The lit cell also raises a small tooltip (run
// id, status, relative age) built from the SAME .info-tip__pop chrome the (i) tooltip
// primitive uses (info-tip.ts), nested inside .run-cell (already position:relative), so this
// gets the one tooltip look the console already has rather than a second one.
function renderRunTimeline(ring: RunHistoryEntry[], currentRunId: string): HTMLElement {
  const card = h("div", { class: "stack-sm" });
  card.appendChild(h("p", { class: "field__hint", style: "margin:0" }, "Newest on the right. Recent-run ring only."));

  // Oldest to newest (the ring arrives newest-first), so the strip reads left to right.
  const ordered = [...ring].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const strip = h("ul", { class: "run-strip", "aria-label": "Recent run results, oldest to newest" });

  const cellEls: Array<{ el: HTMLButtonElement; tip: HTMLElement }> = [];
  const setFocus = (target: HTMLButtonElement | null): void => {
    strip.classList.toggle("run-strip--focused", target !== null);
    for (const { el, tip } of cellEls) {
      const lit = el === target;
      el.classList.toggle("run-cell--lit", lit);
      tip.hidden = !lit;
    }
  };

  let tipSeq = 0;
  for (const r of ordered) {
    // The canonical tone. The old ladder sent abandoned to "inflight", so a run the engine had given up
    // on wore the still-running treatment in the timeline a frightened customer reads while choosing a
    // restore point. The label and tooltip beside it were already honest, which made the cell the only
    // thing disagreeing with them.
    const cellTone = r.status === "in-flight" ? "inflight" : runStatusTone(r.status).tone;
    const isCurrent = r.runId === currentRunId && r.runId !== "";
    const labelParts = [
      `Run ${r.index}`,
      absoluteTime(r.startedAt),
      r.status,
      r.recordCount !== undefined ? `${groupNumber(r.recordCount)} records` : null,
      isCurrent ? "the run being restored" : null,
    ].filter((p): p is string => p !== null);
    const tipId = `rc-tip-${++tipSeq}`;
    const cell = h(
      "button",
      { "data-dp": "restore-flow.button.cell",
        class: `run-cell run-cell--${cellTone === "inflight" ? "inflight run-cell--info" : cellTone}${isCurrent ? " run-cell--current" : ""}`,
        type: "button",
        "aria-label": labelParts.join(", "),
        "aria-describedby": tipId,
        // NO INLINE OUTLINE. It could not be overridden by `.run-cell:focus-visible`, so the run being
        // restored painted identically whether it held focus or not. The selected look now lives in
        // `.run-cell--current` as an inset shadow, which leaves the outline free for focus.
        ...(isCurrent ? { "aria-current": "true" } : {}),
      },
    );
    if (cellTone === "danger") cell.appendChild(h("span", { class: "run-cell__mark", "aria-hidden": "true" }, "×"));
    if (r.runId && r.runId !== currentRunId) cell.addEventListener("click", () => navigate(`/restore/${encodeURIComponent(r.runId)}`));

    // The tooltip text is deliberately NOT the aria-label above (index + absolute time +
    // record count): it is the three facts an operator scanning the strip for "which run was
    // that" wants fastest (the run id to act on, its status, how long ago), textContent-only
    // like every other customer-data string on this screen.
    const tip = h("span", { class: "info-tip__pop", id: tipId, role: "tooltip" });
    tip.hidden = true;
    tip.textContent = `Run ${r.runId || "-"}, ${runStatusTone(r.status).label}, ${relativeTime(r.startedAt)}`;
    cell.appendChild(tip);
    cell.addEventListener("mouseenter", () => setFocus(cell));
    cell.addEventListener("mouseleave", () => setFocus(null));
    cell.addEventListener("focus", () => setFocus(cell));
    cell.addEventListener("blur", () => setFocus(null));
    cellEls.push({ el: cell, tip });

    strip.appendChild(h("li", cell));
  }
  card.appendChild(strip);

  // The legend (hue + shape), decorative for AT (the cells carry the textual status).
  const legend = h("div", { class: "run-strip__legend", "aria-hidden": "true" });
  legend.appendChild(legendSwatch("ok", "ok"));
  legend.appendChild(legendSwatch("danger", "failed"));
  legend.appendChild(legendSwatch("info", "in flight"));
  card.appendChild(legend);
  return card;
}
