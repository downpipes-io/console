// The topology map's RENDERER EVIDENCE.
//
// "The map is frozen", "the map is just a static diagram", "the map renders dead for one user". Every one of
// those is a BROWSER ticket (a locked-down profile refusing a canvas, an extension freezing the animation
// loop, an accessibility setting the operator themselves chose), and the answer is browser advice. Until now
// the only evidence was the Copy-view-diagnostics block, which reaches support ONLY if the customer manually
// pastes it: a purpose-built remote-support affordance that depends on the customer being able to use the
// console they are ringing about.
//
// This module turns the same facts into a coarse, ALWAYS-COLLECTED row in the diagnostics ring, so the pack
// the customer generates carries them. It is the classifying half only: two bounded probes and one pure
// decision. It records nothing itself; the controller does, once per mount.
//
// NO-CUSTODY. Nothing here reads a user agent, a GPU vendor or renderer string, a URL or any customer value.
// The probes return CLOSED members, and the decision returns a CLOSED member. The manual diagnostics block
// keeps its richer, human-readable content (it goes to the operator's own clipboard, never to a bundle).
//
// WEBGL IS DELIBERATELY ABSENT. The console's live view is canvas2d and never asks for a WebGL context, so a
// browser without WebGL renders the full live map. A webgl-blocked row would fire on a perfectly healthy
// session, which is the false alarm this module is built to avoid; the causes below are the ones that actually degrade
// what the operator sees.

import type { ClientDiagDegradeCause, ClientDiagRendererMode } from "../../lib/client-diag/vocab.ts";

// RAF_FREEZE_GUARD_MS is how long a live requestAnimationFrame is given to produce two frames before it is
// called frozen. Matched to the manual diagnostics block's own guard so the two readings cannot disagree.
const RAF_FREEZE_GUARD_MS = 1500;
// CSS_ANIM_SAMPLE_MS is the window over which a running CSS animation must ADVANCE its currentTime.
const CSS_ANIM_SAMPLE_MS = 400;

/** Did the browser's animation loop actually tick? A closed member, never a duration. */
export type RafOutcome = "ticking" | "frozen" | "unavailable";
/** Did the page's CSS animations advance? `none` means there were none to sample, which is not a fault. */
export type CssAnimOutcome = "advancing" | "frozen" | "none" | "unavailable";

// probeRaf resolves whether requestAnimationFrame produces two frames within the freeze guard. A frozen loop
// is the "the map is hung" ticket: the canvas is live, the renderer is canvas2d, and nothing moves. It always
// settles (the guard resolves it), so a caller can await it without an unbounded wait.
export async function probeRaf(win: Pick<Window, "requestAnimationFrame" | "setTimeout" | "clearTimeout"> = window): Promise<RafOutcome> {
  if (typeof win.requestAnimationFrame !== "function") return "unavailable";
  return new Promise<RafOutcome>((resolve) => {
    let settled = false;
    const guard = win.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve("frozen");
    }, RAF_FREEZE_GUARD_MS);
    win.requestAnimationFrame(() =>
      win.requestAnimationFrame(() => {
        if (settled) return;
        settled = true;
        win.clearTimeout(guard);
        resolve("ticking");
      }),
    );
  });
}

// probeCssAnimations samples a RUNNING CSS animation and reports whether its currentTime advances. A frozen
// animation with a ticking rAF names an extension one layer up from the canvas. `none` (no running animation on
// the page) is honestly distinct from frozen: under reduced motion the console runs none by design.
//
// R2: it used to sample getAnimations[0], an ARBITRARY document-wide animation, and call any
// animation whose currentTime did not advance "frozen". A FINISHED animation with a fill mode stays in
// getAnimations() with its currentTime pinned at the end -- the console ships one (tokens.css, the restore-step
// fill) -- as do paused and idle-timeline animations. Any of them landing at index 0 read as css-anim-frozen on a
// perfectly healthy page. Only an animation whose playState is "running" is capable of advancing, so only a
// running one can be evidence that nothing is advancing.
export async function probeCssAnimations(doc: Document = document): Promise<CssAnimOutcome> {
  if (typeof doc.getAnimations !== "function") return "unavailable";
  const sample = doc.getAnimations().find((a) => a.playState === "running");
  if (sample === undefined) return "none";
  const before = Number(sample.currentTime ?? 0);
  await new Promise((r) => setTimeout(r, CSS_ANIM_SAMPLE_MS));
  // Re-read the playState: an animation that FINISHED during the sample window stopped advancing legitimately.
  if (sample.playState !== "running") return "none";
  const after = Number(sample.currentTime ?? 0);
  return after > before ? "advancing" : "frozen";
}

/** Was the document visible for the WHOLE probe window? A boolean, never a timestamp or a URL. */
export interface VisibilityWatch {
  /** True if the document was hidden at the start, at the end, or at any moment in between. */
  everHidden(): boolean;
  stop(): void;
}

// watchVisibility is the guard that stops an ORDINARY BACKGROUNDED TAB from manufacturing the gap's own headline
// fault (R2). A hidden document SUSPENDS requestAnimationFrame while setTimeout keeps ticking, so probeRaf's
// freeze guard fires and returns "frozen" on a browser with nothing wrong with it. The map's first load is not
// gated on visibility (only the poll cadence is), so the map really does mount in hidden documents: a restored
// session's background tab, a deep link opened in a new background tab, a cmd-tab away mid-load, a minimised
// window, a phone whose browser went to the background.
//
// Sampling visibility ONCE before the probe is not enough: a tab hidden HALFWAY THROUGH produces the same false
// frozen reading. So this samples at the start, listens for every visibilitychange across the window, and is read
// again at the end. Any hidden moment at all makes the loop reading unusable, and the caller records `unobserved`
// rather than a fault it did not observe.
export function watchVisibility(doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document): VisibilityWatch {
  let hidden = doc.visibilityState !== "visible";
  const onChange = (): void => {
    if (doc.visibilityState !== "visible") hidden = true;
  };
  if (typeof doc.addEventListener === "function") doc.addEventListener("visibilitychange", onChange);
  return {
    everHidden: () => hidden || doc.visibilityState !== "visible",
    stop: () => {
      if (typeof doc.removeEventListener === "function") doc.removeEventListener("visibilitychange", onChange);
    },
  };
}

/** The inputs the decision is made from. Pure data, so the decision is testable without a DOM. */
export interface RendererFacts {
  mode: ClientDiagRendererMode;
  animation: "animated" | "static-frame";
  raf: RafOutcome;
  cssAnim: CssAnimOutcome;
  // Was the document hidden at ANY point across the probe window? When it was, the rAF and CSS readings are not
  // evidence of anything: the browser suspends both by design in a background tab.
  everHidden: boolean;
}

// classifyRenderer is the PURE decision: which single cause explains what the operator is looking at. The
// order is the order of severity to the customer, and each branch is a different sentence down the phone:
//
//   1. svg-fallback        the browser refused a 2d context. Nothing else matters: the live view is not there.
//   2. raf frozen          canvas2d is live and the loop is dead. This is the "the map is hung" report, and it
//                          outranks the CSS reading because the map is drawn by the rAF loop, not by CSS.
//   3. css animations frozen  the loop ticks and the page's CSS animations do not: the same class of extension
//                          one layer up, and the operator sees a half-dead console around a live map.
//   4. static frame        the operator (or their OS) asked for reduced motion. A LEGITIMATE state and the one
//                          benign explanation for a still map, which is exactly why it must be tellable from
//                          the three above rather than folded into them.
//   5. none                the live view was running. Recorded, so the pack can say so.
//
// A frozen rAF under reduced motion is NOT reported as raf-frozen: the console runs no animation loop in that
// mode, so there is nothing for an extension to freeze and the reading would be meaningless. That guard is
// what stops the most common accessibility configuration in the estate from manufacturing a fault every time.
export function classifyRenderer(f: RendererFacts): ClientDiagDegradeCause {
  // canvas-blocked outranks everything, INCLUDING a hidden document: a browser that refused a 2d context refused
  // it whether anyone was looking or not, and the operator is on the SVG fallback the next time they look.
  if (f.mode === "svg-fallback") return "canvas-blocked";
  // reduced-motion is likewise observation-independent: it is read off the operator's own stated preference, not
  // off a moving pixel, so it stays true (and stays reportable) in a background tab.
  if (f.animation === "static-frame") return "reduced-motion";
  // unobserved (R2) sits ABOVE the two motion readings and below the two facts that do not need an observer. A
  // hidden document suspends requestAnimationFrame while the freeze guard's setTimeout keeps running, so every
  // reading below this line would be a fault reported on a healthy browser that simply was not in the foreground.
  if (f.everHidden) return "unobserved";
  // An ABSENT requestAnimationFrame is recorded as raf-frozen, not as its own member: a loop that cannot run
  // and a loop that will not tick give the operator the identical dead map and the identical remedy (find what
  // in this browser is stopping the animation loop). Inventing a member for a distinction nobody can act on
  // would split one signal in two for no gain.
  if (f.raf === "frozen" || f.raf === "unavailable") return "raf-frozen";
  if (f.cssAnim === "frozen") return "css-anim-frozen";
  return "none";
}
