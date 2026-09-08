// Licence and updates: the fail-open licence card (a licence NEVER
// gates the data or recovery path, stated ONCE, in the Licence card, not echoed
// per section) and the update review with provenance (the running version, the
// recommended version, notes, and the pull-not-push, signature-pinned,
// manual-by-default framing, stated once in the Updates section). Buildable today
// against the existing contract (licence, updates, status.engineVersion).
// Calm contract: three eager sections, the tile band, the Licence card (its
// fail-open status PLUS the activation action area folded in, under a hairline: paste-and-Activate, or
// Replace/Remove for a console-activated token), and Updates; Enterprise services and Provenance present
// collapsed. The activation control lives INSIDE the Licence card (a licence's status and its one action
// are the same object), not as a separate fourth card, so the eager-section budget is three.
//
// This file is the COORDINATOR: it owns the screen descriptor (route, title, measure, actions, render)
// and the load -> skeleton -> render lifecycle, and re-exports the symbols external callers (the
// commercial-model validator) depend on. The screen body is assembled by ./licence/view.ts (the moved
// render); the pure DOM-free decision logic, the release-metadata helpers, the summary-band tile
// helpers, the detail-row builders and the heading ids live in the ./licence/shared.ts leaf; the
// activation control in ./licence/activation.ts; the safe-apply update control + release-metadata block in
// ./licence/update.ts; the standalone rollback control in ./licence/rollback.ts; the demoted Provenance and
// Enterprise bodies in ./licence/provenance.ts. The file was split for size while keeping the public
// surface byte-identical: licenceScreen is still the public export, and every validated symbol is
// re-exported from here unchanged. House rules: Australian English, no em dashes, precise claims.

import { h, scrollToSafe } from "../lib/dom.ts";
import { pageHeader, requireEngine, type Screen, type ScreenContext } from "./common.ts";
import { goSignedOut } from "../lib/nav.ts";
import { isUnauthorised } from "../lib/errors.ts";
import { blockError, sessionEnded } from "../components/error-view.ts";
import { skeletonTiles } from "../components/feedback.ts";
import { render } from "./licence/view.ts";
import { UPDATES_HEADING_ID } from "./licence/shared.ts";

// The provenance card's artefact-stamp SHAPE verdict (a PRESENT but unreadable stamp is a build-provenance
// fault, not the benign "unstamped build" absence), re-exported for the same validator. It lives beside its
// only consumer (the provenance card) so the shared leaf stays inside the max-lines budget.
export { ARTEFACT_STAMP_MALFORMED_LINE, artefactStampMalformed } from "./licence/provenance.ts";
export type { ComponentRow, RecordedSettleOutcome, UpdateControlState } from "./licence/shared.ts";
// Re-exports: the commercial-model validator (test/validate-licence.ts) imports the safe-apply state
// machine, the release-metadata helpers and the update gate capability BY NAME from this module, so the
// split keeps every one of those imports working unchanged. They live in the ./licence/shared.ts leaf (all
// pure + DOM-free, so importing them in Node never touches a DOM); re-exporting them here keeps the public
// import surface of screens/licence.ts byte-identical.
export {
  artefactHashState,
  changelogTypeLabel,
  compatBlockedReason,
  componentApplyResultLine,
  componentLabel,
  componentRowLine,
  componentRows,
  consoleCheckFailedLine,
  consoleCheckingLine,
  consoleReloadPromptLine,
  consoleRollbackOutcomeLine,
  consoleUpdateAvailable,
  consoleWasApplied,
  lastUpdateSummary,
  promoteSummaryLine,
  queuedForSecondOwnerLine,
  rampOutcomeLine,
  rampSettleOutcomeLine,
  // Persistence-first settle recovery (the settle-response race): the recorded-truth decision + copy.
  recordedSettleOutcome,
  recordedSettleOutcomeLine,
  releaseComponentsToApply,
  releasedAgoLine,
  riskClassLabel,
  riskClassNeedsCare,
  riskClassTone,
  SETTLE_UNCONFIRMED_LINE,
  semverNewer,
  settleOutcomeLine,
  standaloneRollbackOffered,
  standaloneRollbackOutcomeLine,
  UPDATE_MANAGE_CAP,
  // Multi-component updates: the pure component logic + copy the validator pins.
  UPDATES_HEADING_ID,
  updateControlState,
  updateExplainerText,
  updateRefusalText,
  updateTileLabel,
  updateTileTone,
  updateTileValue,
} from "./licence/shared.ts";

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

export const licenceScreen: Screen = {
  route: "/licence",
  title: "Licence and updates",
  measure: "prose",
  actions: [
    // check-updates matches the COMMANDS baseline id in shell/registry.ts so it is
    // deduped correctly. Declared honestly as a NAVIGATION: opening the screen is
    // the check (every visit refetches licence + updates); there is no separate
    // probe to run, so an "action" kind would promise more than happens. The old
    // "View provenance" entry was removed for the same honesty reason: it resolved
    // to a bare navigate("/licence") and never reached the Provenance section
    // (which now carries id="provenance" for a real deep-link later).
    {
      id: "check-updates",
      title: "Open Licence and updates",
      group: "Navigation",
      kind: "navigate",
      keywords: ["updates", "version", "provenance", "licence", "check"],
      target: "/licence",
    },
  ],
  render(ctx: ScreenContext) {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root;

    root.appendChild(
      pageHeader(
        "Licence and updates",
        "The licence tier, the update channel and release provenance.",
      ),
    );

    const region = h("div", { class: "async-region" });
    root.appendChild(region);

    // load returns the fetch+render Promise so a caller that must act only AFTER the region is
    // rebuilt (the activation section's a11y focus restoration) can await it; the re-render is
    // asynchronous (the Promise.all resolves before render() recreates the Licence card heading),
    // so a synchronous restoreFocus() after reload() would run against the skeleton and no-op.
    const load = (): Promise<void> => {
      // A skeleton tracing the loaded shape (tile band + a card block), so the
      // transition does not reflow from four text rows into tiles and cards.
      region.replaceChildren(
        h(
          "div",
          { "aria-hidden": "true" },
          skeletonTiles(3),
          h(
            "div",
            { class: "skeleton-block", style: "margin-top:var(--space-5)" },
            ...Array.from({ length: 4 }, () => h("div", { class: "skeleton skeleton-row" })),
          ),
        ),
      );
      // updateStatus() is fetched alongside the eager facts but degraded to null on ANY non-auth error
      // (an older engine without the safe-apply route, a transient hiccup): the safe-apply control is an
      // ENHANCEMENT, so its absence must never block the whole Licence screen. An auth failure still
      // propagates (it is the whole-screen signal); everything else resolves to null and the screen renders.
      return Promise.all([
        engine.licence(),
        engine.updates(),
        engine.status(),
        engine.updateStatus().catch((err) => {
          if (isUnauthorised(err)) throw err;
          return null;
        }),
      ])
        .then(([licence, updates, status, updateState]) => region.replaceChildren(render(engine, { licence, updates, status, updateState }, load)))
        .catch((err) => {
          if (isUnauthorised(err)) {
            // PAINT FIRST, THEN LEAVE: the region is a tile-and-card skeleton until this replaces it.
            region.replaceChildren(sessionEnded(() => void load()));
            goSignedOut();
            return;
          }
          region.replaceChildren(blockError(err, load, { origin: location.origin }));
        });
    };
    // The ?open=updates deep link (the shell's "Update available" chip, and any hand-typed link)
    // brings the Updates section into view once the FIRST load has rendered the region (the
    // security-centre ?open= idiom, adapted for this screen's async region). Initial load only: a
    // reload() after an action must never re-yank scroll or focus. On the error/skeleton states the
    // reveal finds no heading and quietly does nothing. Deferred TWO frames: the shell's setMain
    // moves focus to #main inside the View Transition's apply callback (about one frame after this
    // render returns), and on a fast engine (the faked tour) the load can settle BEFORE that, so an
    // immediate reveal would have its focus stolen straight back. Two frames places the deep-link
    // focus strictly after the navigation focus on both the transition and instant-swap paths.
    const openUpdates = ctx.query.get("open") === "updates";
    void load().then(() => {
      if (!openUpdates) return;
      requestAnimationFrame(() => requestAnimationFrame(() => revealUpdatesSection(region)));
    });
    return root;
  },
};

// revealUpdatesSection scrolls to + focuses the Updates section heading inside the rendered region
// (the /licence?open=updates deep link). The heading is the focus target (tabindex=-1, the
// LICENCE_CARD_HEADING_ID idiom) so a keyboard/screen-reader operator lands on the section, not at
// the top of the document; scrollToSafe is the sanctioned smooth-scroll (instant under reduced
// motion), guarded because scrollIntoView is absent under the test shim. Returns whether the
// heading was found (false on the error/skeleton states). Exported for the validator.
export function revealUpdatesSection(region: ParentNode): boolean {
  const heading = region.querySelector<HTMLElement>(`#${UPDATES_HEADING_ID}`);
  if (!heading) return false;
  if (typeof heading.scrollIntoView === "function") scrollToSafe(heading, { block: "start" });
  heading.focus({ preventScroll: true });
  return true;
}
