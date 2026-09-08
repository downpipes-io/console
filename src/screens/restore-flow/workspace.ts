// Restore the two-column workspace: run context on the left (the run
// detail, the collapsed timeline and the proof surface), the restore flow on the right.
// Without a prefilled run there is no run context yet, so the flow renders full width with
// a run picker and the fleet restore-test recency card. Moved verbatim out of
// restore-flow.ts for size. House rules: Australian English, no em dashes, precise claims.
//
// The runless landing: with no prefilled run there is no context column, so the flow
// would otherwise auto-place into the grid's narrow 360px track (the "cramped" bug); the
// --solo modifier drops to a single full-width column and caps the flow at a comfortable
// reading measure, with the recency card as a full-width band below it.
// Sticky context + journey + mobile identity: the context column carries a live
// journey summary (step / plan hash / approval state) above the run-detail card, and a
// compact identity strip (downpipe id / run id / sealed status) renders above the stepper on
// narrow widths only, both sourced from the SAME renderRestoreFlow / renderRunContext calls
// via small side-channel callbacks (no duplicated fetch, no new engine call).

import { h } from "../../lib/dom.ts";
import type { EngineClient } from "../../api.ts";
import { renderRestoreFlow } from "./flow.ts";
import { renderRunContext, renderIdentityStrip } from "./run-context.ts";
import { renderRestoreTestRecencyCard } from "./recency.ts";
import { renderJourneySummary } from "./journey.ts";
import { attendEntryCard } from "./attend.ts";
import { recoverKeyDiscoveryNote } from "./recover-key.ts";
import { breakGlassEntryNote } from "./break-glass.ts";

// ---- the workspace ----------------------------------------------------------

export function renderWorkspace(engine: EngineClient, prefillRun: string | undefined): HTMLElement {
  const workspace = h("div", { class: "restore-workspace" });
  // The runless landing has no context column; --solo gives the lone flow child the full
  // width instead of the grid's narrow first (360px) track.
  if (!prefillRun) workspace.classList.add("restore-workspace--solo");

  // The restore flow column (right / primary).
  const flowCol = h("div", { class: "restore-workspace__flow" });

  if (prefillRun) {
    // The run-context column (left): a rich run detail + recent-run timeline + a drill
    // panel, loaded from the engine for the run being restored. It loads independently
    // of the flow so a slow history fetch never blocks the dry-run.
    const contextCol = h("aside", { class: "restore-workspace__context", "aria-label": "Run context" });

    // The live journey summary sits above the run-detail card (its data is available
    // immediately from flow.ts's own state, unlike the run-detail card's async fetch), so the
    // rail states current progress before the skeleton settles.
    const journey = renderJourneySummary();
    contextCol.appendChild(journey.el);

    // The mobile identity strip is a workspace-level grid sibling (not nested in either
    // column), so CSS `order` can place it above the flow's own stepper on narrow widths; it is
    // populated by the SAME renderRunContext call's onLocated side channel, once the history fetch
    // resolves the run this whole screen is about.
    const identityStrip = h("div", { class: "restore-identity-strip", "aria-label": "Run identity", role: "group" });

    contextCol.appendChild(
      renderRunContext(engine, prefillRun, (run, downpipeId) => {
        identityStrip.replaceChildren(renderIdentityStrip(run, downpipeId));
        identityStrip.classList.add("is-ready");
      }),
    );

    flowCol.appendChild(renderRestoreFlow(engine, prefillRun, undefined, journey.update));
    workspace.appendChild(identityStrip);
    workspace.appendChild(contextCol);
  } else {
    flowCol.appendChild(renderRestoreFlow(engine, prefillRun));
  }

  workspace.appendChild(flowCol);

  // The scheduled-restore-test recency summary (build contract section 5): a fleet-wide
  // read of restorability assurance, so a DR responder sees which downpipes have a proven
  // recent restore test before they need one. It is the natural content of the RUNLESS
  // /restore view only; on /restore/:runId it is irrelevant to the chosen run and blew
  // the eager-section budget, forcing scroll past the receipt area.
  // Wrapped in its own grid-sibling band so it always renders BELOW the flow (never beside
  // it) at every breakpoint, including the solo full-width layout.
  if (!prefillRun) {
    // The attended-verification entry point: the offline-key-only posture's in-platform proof path (the
    // no-CLI replacement for the old "rehearse offline" dead-end). It is a natural sibling of the recency
    // card on the runless landing, in its own full-width band so it never crowds the flow.
    const attendBand = h("div", { class: "restore-workspace__recency" });
    attendBand.appendChild(attendEntryCard(engine));
    // Two quiet secondary links (not their own cards, per the calm-density budget: these are niche,
    // break-glass-only paths): the in-browser split-key reassembly screen, and the in-console break-glass
    // restore panel. Each navigates to a sibling route and never touches attend.ts.
    attendBand.appendChild(recoverKeyDiscoveryNote());
    attendBand.appendChild(breakGlassEntryNote());
    workspace.appendChild(attendBand);

    const recencyBand = h("div", { class: "restore-workspace__recency" });
    recencyBand.appendChild(renderRestoreTestRecencyCard(engine));
    workspace.appendChild(recencyBand);
  }
  return workspace;
}
