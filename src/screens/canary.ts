// Canary backup: the on-by-default known-answer integrity flight, as a first-class screen. The
// question this screen answers (the calm contract): "Is the canary singing, and what did its last
// flight prove?"
//
// The canary is a small piece of known data the engine sends down the pipe on a schedule (the
// cadence is configurable; hourly is only the default), a synthetic backup whose every byte is known
// in advance. While it returns intact, the whole write, seal, read, restore and verify path is
// proven byte for byte for this destination. If a single bit strays, the canary is dead and you stop
// trusting that destination for real restores until it is investigated.
//
// The screen renders the redaction-safe engine view (GET /admin/canary): the animated bird in its
// state pose, the live status (colour AND shape AND label, never colour alone), the last flight's
// eight-aspect proof, and behind disclosures what one green canary proves, the owner controls
// (enable, repoint the destination once more than one exists, fly now), and the recent-flight ring.
//
// Gates: reading is any authenticated role; flying it now is operator and up; toggling it, repointing
// its destination or changing its cadence is OWNER-exclusive server-side, so those controls render
// disabled-with-reason for everyone else (never hidden-then-403). The engine is the enforcement
// point; canDo/gateReason are the client mirror only. Every server string enters the DOM via the
// typed h() builder / textContent (no innerHTML over server data); the only innerHTML is the trusted
// in-repo canary SVG constant. Australian English, no em dashes, precise claims.
//
// The copy constant, tone mapping, figure helpers, rendered sections and the client-side death
// preview live in sibling modules (canary-copy / canary-tone / canary-figure / canary-sections /
// canary-sim); this module owns the persistent figure lifecycle and the load/apply/rerender wiring.

import { h } from "../lib/dom.ts";
import { pageHeader, requireEngine, type Screen } from "./common.ts";
import { goSignedOut } from "../lib/nav.ts";
import { isUnauthorised } from "../lib/errors.ts";
import { blockError, sessionEnded } from "../components/error-view.ts";
import { skeletonRows } from "../components/feedback.ts";
import { onRainChange } from "../lib/rain-pref.ts";
import type { CanaryView } from "../api.ts";
import { CANARY_COPY } from "./canary-copy.ts";
import { canaryFigure, setFigureState, setFigureRain, figureStateOf } from "./canary-figure.ts";
import { renderStatusBlock, startFlightWatch, renderDestinations, renderProves, renderSettings, renderHistory } from "./canary-sections.ts";
import { simulatedDeadView, simBanner } from "./canary-sim.ts";

// Delay before the death demo applies the dead pose: long enough for the take-off transition to
// read, short enough that the interim preview state never lingers as if it were a real flight.
const SIM_DEATH_DELAY_MS = 1200;

// watchRainPreference keeps the figure's data-rain in sync with the rain-backdrop preference, so the
// singing bird raises (or lowers) its umbrella the instant Storm is selected from any surface. The
// subscription is removed when the screen leaves the DOM (root.isConnected becomes false), mirroring
// the settings card, so it never leaks across navigations.
function watchRainPreference(root: HTMLElement, figure: HTMLElement): void {
  const unsubRain = onRainChange((pref) => setFigureRain(figure, pref));
  const rainObserver = new MutationObserver(() => {
    if (!root.isConnected) {
      unsubRain();
      rainObserver.disconnect();
    }
  });
  rainObserver.observe(document.documentElement, { childList: true, subtree: true });
}

// This screen's own route, exported so an outside caller (the guided tour's chapter vocabulary;
// chapters.ts) references the same literal this descriptor uses, rather than a copy.
export const ROUTE_CANARY = "/canary";

export const canaryScreen: Screen = {
  route: ROUTE_CANARY,
  title: "Canary",
  measure: "prose",
  actions: [
    {
      id: "go-canary",
      title: "Go to the Canary",
      group: "Navigation",
      kind: "navigate",
      keywords: ["canary", "integrity", "coalmine", "known answer", "byte exact", "restore test", "evacuate"],
      target: "/canary",
    },
  ],
  render() {
    const engine = requireEngine();
    if (!engine) return h("div");
    const root = h("div");
    root.appendChild(pageHeader("Canary", CANARY_COPY.intro));
    const region = h("div", { class: "async-region", style: "margin-top:var(--space-5)" });
    root.appendChild(region);

    // The canary illustration is built ONCE and kept mounted; only its state class is re-set, so it
    // TRANSITIONS between poses (take-off, landing, death) instead of hard-cutting. The sections around
    // it live in slots refreshed with data. The persistent container is detached only by the loading
    // skeleton or an error, and re-attached on the next update, so the figure stays mounted otherwise.
    const figure = canaryFigure("pending");
    watchRainPreference(root, figure);
    const statusSlot = h("div");
    const heroCard = h("section", { class: "card", style: "display:grid;grid-template-columns:minmax(0,260px) 1fr;gap:var(--space-6);align-items:center" }, figure, statusSlot);
    const bannerSlot = h("div");
    const lastFlightSlot = h("div");
    const provesEl = renderProves();
    const settingsSlot = h("div");
    const historySlot = h("div");
    const container = h("div", { style: "display:flex;flex-direction:column;gap:var(--space-6)" }, bannerSlot, heroCard, lastFlightSlot, provesEl, settingsSlot, historySlot);

    let built = false;
    let currentView: CanaryView | null = null;

    // rerender is the LIGHT update used during a flight: it re-states the persistent figure (which
    // transitions) and repaints the status block, leaving the disclosures below untouched.
    const rerender = (v: CanaryView): void => {
      setFigureState(figure, figureStateOf(v));
      statusSlot.replaceChildren(renderStatusBlock(engine, v, root, { reload: load, rerender, simulate }));
    };

    // apply is the FULL update: the figure plus every section (used on load, on a settled flight, and
    // for the death preview). It re-attaches the persistent container only when detached, never
    // otherwise, so the figure stays mounted and can transition.
    const apply = (view: CanaryView, sim?: boolean): void => {
      currentView = view;
      if (container.parentNode !== region) {
        region.replaceChildren(container);
        built = true;
      }
      bannerSlot.replaceChildren(...(sim ? [simBanner(load)] : []));
      setFigureState(figure, figureStateOf(view));
      // The preview flag flows through so an interim in-flight state during the death demo reads as
      // a preview, never as the live "flying right now" wording under the demo banner.
      statusSlot.replaceChildren(renderStatusBlock(engine, view, root, { reload: load, rerender, simulate }, sim === true));
      lastFlightSlot.replaceChildren(renderDestinations(view));
      settingsSlot.replaceChildren(renderSettings(engine, view, load));
      historySlot.replaceChildren(renderHistory(view));
    };

    // simulate runs the death demo: the bird takes off (figure -> flying, transitions), then dies
    // (figure -> dead, transitions) with the failed aspects, behind the demo banner. It never calls the
    // engine.
    const simulate = (): void => {
      const base = currentView;
      if (!base) return;
      apply({ ...base, inFlight: true }, true);
      window.setTimeout(() => apply(simulatedDeadView(base), true), SIM_DEATH_DELAY_MS);
    };

    const load = (): void => {
      if (!built) region.replaceChildren(skeletonRows(4));
      void engine
        .getCanary()
        .then((view) => {
          apply(view);
          // A flight already in progress (a cron flight, or a reload mid-flight): watch it land or die.
          if (view.inFlight) startFlightWatch(engine, root, view.runSeq - 1, rerender, load);
        })
        .catch((err) => {
          if (isUnauthorised(err)) {
            // PAINT FIRST, THEN LEAVE. Only the FIRST load seeds the skeleton (`if (!built)`), so this
            // replaces it on exactly the path that has one; a later 401 replaces a stale figure with the
            // same sentence, which is the honest state either way.
            region.replaceChildren(sessionEnded(load));
            return goSignedOut();
          }
          region.replaceChildren(blockError(err, load, { origin: location.origin }));
        });
    };

    load();
    return root;
  },
};
