// The canary FIGURE: the animated bird in its state pose. The figure is created once and only
// re-stated, so CSS can transition it between poses (take-off, landing, death) rather than hard-cut.
// The only innerHTML is the trusted in-repo canary SVG constant.

import { h } from "../lib/dom.ts";
import { getRainPref, type RainPref } from "../lib/rain-pref.ts";
import type { CanaryView, CanaryLiveness } from "../api.ts";
import { CANARY_SVG } from "./canary-art.ts";

// FigureState is the bird's pose: the five liveness states plus "flying" (a flight is in progress,
// the bird flaps until it lands alive or dies).
export type FigureState = CanaryLiveness | "flying";

// FIGURE_TITLE is the short hover / assistive-tech label per pose. It is set on the SVG <title> every
// time the pose changes, so the tooltip can never disagree with the bird (the stale-title bug: the
// markup ships with an "alive" title that must be re-synced for pending/dead/etc.).
const FIGURE_TITLE: Record<FigureState, string> = {
  alive: "Canary alive, singing.",
  dead: "Canary dead. Evacuate the coalmine.",
  ailing: "Canary ailing, the flight could not complete.",
  pending: "Canary awaiting its first flight.",
  disabled: "Canary off.",
  flying: "Canary in flight: writing, sealing, reading, restoring and verifying its known data.",
};

// setFigureState updates an EXISTING figure's state class + the <title>/<desc>, WITHOUT re-injecting
// the SVG. Keeping the same DOM nodes is what lets CSS transitions animate the bird between poses
// (take-off, landing, death) rather than hard-cut. The figure is created once and only re-stated.
export function setFigureState(box: HTMLElement, state: FigureState): void {
  const svg = box.querySelector("svg.canary");
  if (svg) svg.setAttribute("class", `canary canary--${state}`);
  const title = box.querySelector("title");
  if (title) title.textContent = FIGURE_TITLE[state];
  const desc = box.querySelector("desc");
  if (desc) desc.textContent = FIGURE_TITLE[state];
}

// figureStateOf maps a view to the bird's pose: "flying" while a flight runs, else the liveness.
export function figureStateOf(view: CanaryView): FigureState {
  return view.inFlight ? "flying" : view.status;
}

// setFigureRain reflects the rain-backdrop preference (lib/rain-pref.ts) onto the figure as a
// data-rain attribute. The canary art reads it in CSS to add a storm-only flourish: an umbrella the
// bird raises while it sings (.canary--alive[data-rain="storm"]). It is set as an ATTRIBUTE, not a
// class, precisely so setFigureState (which rewrites only the class on each pose change) never
// clobbers it.
export function setFigureRain(box: HTMLElement, pref: RainPref): void {
  const svg = box.querySelector("svg.canary");
  if (svg) svg.setAttribute("data-rain", pref);
}

// canaryFigure injects the trusted in-repo canary SVG ONCE (innerHTML over a known in-repo constant,
// the same justification as svgIcon) and sets the initial pose. Thereafter the same element is kept in
// the DOM and only re-stated via setFigureState, so the figure can transition between poses.
export function canaryFigure(state: FigureState): HTMLElement {
  const box = h("div", { class: "canary-figure", style: "width:min(260px,60vw);margin-inline:auto" });
  box.innerHTML = CANARY_SVG;
  setFigureState(box, state);
  setFigureRain(box, getRainPref());
  return box;
}
