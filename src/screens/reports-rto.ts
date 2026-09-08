// The recovery-time (RTO) sub-section of the SLA report card, moved out of reports.ts to
// keep the screen module under its size bound (console-struct-miss-reports).
// Behaviour-preserving: the symbol is identical to its former definition.
//
// rtoPanel is the recovery-TIME (RTO) sub-section of the SLA card, the companion to the RPO/freshness
// signal. It loads GET /admin/rto independently (so a slow or unavailable RTO read never shadows the SLA
// report) and renders the FLEET estimate as the headline plus the per-downpipe estimates beneath. Every
// estimate is honest: an unknown one (no drill history) reads "Unknown (no recovery drills yet)" and never
// fabricates a number; a known one reads the formatted duration with its "based on N drills" basis. The
// fixed engine caveat (the estimate is derived and approximate) is shown once when any estimate is known.

import { h } from "../lib/dom.ts";
import { goSignedOut } from "../lib/nav.ts";
import { isUnauthorised } from "../lib/errors.ts";
import { skeletonRows } from "../components/feedback.ts";
import { inlineRetry, sessionEnded } from "../components/error-view.ts";
import type { EngineClient, RtoEstimate } from "../api.ts";
import { rtoEstimateLine } from "./reports-helpers.ts";

export function rtoPanel(engine: EngineClient): HTMLElement {
  const wrap = h("section", { class: "rto-panel", "aria-label": "Recovery time estimate", style: "display:grid;gap:var(--space-2);margin-top:var(--space-3);padding-top:var(--space-3);border-top:1px solid var(--border-subtle)" });
  wrap.appendChild(h("h3", { class: "section-label", style: "margin:0" }, "Recovery time (RTO)"));
  const body = h("div", skeletonRows(1));
  wrap.appendChild(body);

  const load = (): void => {
    body.replaceChildren(skeletonRows(1));
    void engine
      .rto()
      .then((rep) => body.replaceChildren(renderRtoPanelBody(rep)))
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the RTO line is a skeleton until this replaces it.
          body.replaceChildren(sessionEnded(load));
          return goSignedOut();
        }
        // A quiet inline note, not a block error: the RTO panel is a companion to the SLA report, so a
        // failed RTO read must not break the card.
        //
        // It used to read "The recovery-time estimate is unavailable right now (rto: 500)." and stop
        // there. The parenthesis was the engine client's own throw, which is an internal verb rather than
        // anything an operator can act on, and there was no way to ask again.
        body.replaceChildren(
          inlineRetry({
            message: "The engine did not answer with a recovery-time estimate, so none is shown. No estimate has been discarded: this read can be repeated.",
            onReload: load,
          }),
        );
      });
  };
  load();

  return wrap;
}

// renderRtoPanelBody builds the RTO panel body from the engine's estimate: the fleet headline,
// the per-downpipe list (when any were returned), and the fixed engine caveat. A pure
// DOM-construction function (no fetch, no side-effects) so the load path stays a thin wrapper.
function renderRtoPanelBody(rep: { fleet: RtoEstimate; downpipes: RtoEstimate[] }): HTMLElement {
  const grid = h("div", { style: "display:grid;gap:var(--space-2)" });

  // The fleet headline.
  const fleet = rtoEstimateLine(rep.fleet);
  const fleetLine = h("div", { style: "display:flex;gap:var(--space-2);align-items:baseline;flex-wrap:wrap" });
  fleetLine.appendChild(h("span", { class: "field__hint", style: "min-width:6rem" }, "Across the fleet"));
  fleetLine.appendChild(h("span", { style: fleet.known ? "font-weight:var(--weight-semibold)" : "color:var(--text-muted)" }, fleet.value));
  fleetLine.appendChild(h("span", { class: "field__hint" }, fleet.basis));
  grid.appendChild(fleetLine);

  // Per-downpipe estimates, when any were returned (the no-id call returns one per downpipe). A
  // downpipe with no name falls back to its id (honest, never a blank).
  const named = rep.downpipes.filter((d) => d.id !== undefined);
  if (named.length > 0) {
    const list = h("ul", { class: "rto-panel__list", style: "list-style:none;margin:0;padding:0;display:grid;gap:var(--space-1)" });
    for (const d of named) {
      const line = rtoEstimateLine(d);
      list.appendChild(
        h(
          "li",
          { style: "display:flex;gap:var(--space-2);align-items:baseline;flex-wrap:wrap" },
          h("span", { class: "mono field__hint", style: "min-width:6rem" }, d.name ?? d.id ?? "-"),
          h("span", { style: line.known ? "" : "color:var(--text-muted)" }, line.value),
          h("span", { class: "field__hint" }, line.basis),
        ),
      );
    }
    grid.appendChild(list);
  }

  // The fixed engine caveat, shown once when at least one estimate is known (a derived projection,
  // approximate, never a guaranteed recovery time). Omitted when everything is unknown (there is no
  // number to caveat). Prefer the engine's own caveat string so the two sides state it identically.
  const anyKnown = rep.fleet.known || named.some((d) => d.known);
  if (anyKnown) {
    const caveat = rep.fleet.caveat ?? named.find((d) => d.caveat)?.caveat
      ?? "Derived from observed restore-test throughput, scaled to the current archive size; an approximate projection, not a guaranteed recovery time.";
    grid.appendChild(h("p", { class: "field__hint measure", style: "margin:0" }, caveat));
  } else {
    grid.appendChild(h("p", { class: "field__hint measure", style: "margin:0" }, "Run a restore test (a drill) so a recovery-time estimate can be derived from its measured throughput."));
  }

  return grid;
}
