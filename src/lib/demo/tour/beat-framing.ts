// The BEAT FRAMING layer: everything the guide does to put the current beat's subject where the reader can
// actually see it. It scrolls the anchor into the band that is clear of the console's sticky top bar and of
// the guide's own panel, it scrolls the anchor's own sideways-scrolling region when it has one, and it
// records what the DOM established when it cannot frame the subject at all.
//
// It was lifted out of director.ts unchanged in behaviour. The director is a control-flow state machine over
// shared closure state (the chapter index, the beat index, the render token, autoplay); this is geometry over
// the document, and it reads only four facts from the director, which are injected below. Keeping it here
// keeps the state machine readable and keeps both modules inside the console's size budget.
//
// House rules: Australian English, no em dashes, precise claims.

import { motionOK } from "../../a11y-prefs.ts";
import { noteTourDegraded } from "../demo-drift.ts";
import { topChromeClearance } from "./spotlight.ts";

// The four facts the framer reads back from the director, plus the one thing it asks the director to do
// (the phone panel's scroll slack, which the director also releases on Exit and teardown, so it owns it).
export interface BeatFramerDeps {
  doc: Document;
  // The interval between framing retries (8 of them, ~2.5s in production; a test drives it fast).
  frameMs: number;
  // Whether the guide is still alive (a destroyed director frames nothing).
  alive: () => boolean;
  // The director's render token, so a beat or chapter change abandons an in-flight retry ladder.
  token: () => number;
  // The current chapter's stable id, for the degradation record.
  chapterId: () => string;
  // The guide panel's own box, which is what decides whether the guide is a bottom panel or a side rail.
  navRect: () => { top: number; height: number; width: number } | undefined;
  // Add (or release, with 0) the document's temporary bottom padding, so an anchor at the foot of a short
  // page can still be lifted above the phone panel.
  setBottomSlack: (px: number) => void;
}

// The framer's one verb. `frame` seats the beat's anchor and starts the retry ladder; the director calls it
// once per beat with the render token that beat belongs to.
export interface BeatFramer {
  frame(beat: { anchor: string }, token: number, attempt: number): void;
}

export function createBeatFramer(deps: BeatFramerDeps): BeatFramer {
  const doc = deps.doc;

  // THE FRAMER STOPS WHEN THE LEARNER TAKES THE SCREEN, and the phone is why. The ladder below re-scrolls the
  // anchor into the band up to eight times over about two and a half seconds. On a desktop the subject is
  // seated on the first or second try and the rest are no-ops. On a phone the stage is short, a tall subject
  // can never be seated in it, and the ladder therefore scrolls again every 320ms while the learner is trying
  // to read or work: the highlight visibly wanders, which is exactly what a learner reported.
  //
  // Two independent stops. FIRST, a real gesture anywhere outside the guide's own panel cancels the ladder
  // for the beat it lands in: the learner has taken control of the viewport and the course must not take it
  // back. Presses on the panel itself are the course's own controls and are not gestures in this sense.
  // SECOND, a scroll that does not bring the subject closer ends the ladder, because scrolling again cannot
  // help and the code already treats an unframable subject as a legitimate state rather than a fault.
  let gestureToken = -1;
  const noteGesture = (ev: Event): void => {
    const t = ev.target as Element | null;
    if (t && typeof t.closest === "function" && t.closest("#tour-nav-bar, #training-intro")) return;
    gestureToken = deps.token();
  };
  if (typeof doc.addEventListener === "function") {
    doc.addEventListener("touchstart", noteGesture, { capture: true, passive: true });
    doc.addEventListener("wheel", noteGesture, { capture: true, passive: true });
  }
  // The distance the last attempt left between the subject and where it should sit, per beat token, so an
  // attempt that did not improve on the previous one can end the ladder rather than repeating it.
  let lastDelta = Number.POSITIVE_INFINITY;
  let lastDeltaToken = -1;
// bringIntoView scrolls the chapter's annotated components into a comfortable band (clear of the fixed top
// bar and the bottom nav-bar), retrying for ~2.5s: a screen often renders the relevant section a beat after
// the chapter mounts (an async load on /reports, /access/audit), so a one-shot scroll at mount finds nothing.
// A cluster that FITS the band is median-centred (the upper "?"s above centre, the lower ones below). A
// cluster whose span EXCEEDS the band cannot all show at once, so the TOPMOST anchor is seated just under the
// fixed top bar instead: the chapter's content then fills downward from its start (median-centring opened
// chapter 1 mid-scroll and stranded chapter 7's failed-flight marker below the fold). Token-guarded so a
// chapter change stops it; guarded for the headless test DOM (no scrollTo/scrollIntoView/setTimeout there).
// A scroll flourish never breaks the walk.
// beatIntoView scrolls the CURRENT beat's anchor into the comfortable band (under the fixed top
// bar, clear of the bottom-bar variant's band), retrying for ~2.5s because a screen often renders
// the relevant section a beat after the chapter mounts (an async load on /reports, /access/audit).
// One anchor per beat means the framing is always "centre the subject", never a cluster compromise.
// Token-guarded so a beat/chapter change stops it; a scroll flourish never breaks the walk.
//
// The retry closure used to be SHARED by the "no element" branch and the "element found, but the
// scroll did not seat it in the band" branch, and both exhausted into ONE noteTourDegraded("anchor-missing").
// Three different states therefore produced a byte-identical row, and the third was not a fault:
//   * the data-tour-id was renamed or removed         -> the hook must be restored
//   * the anchor is present but has NO BOX            -> the reveal (the drawer the preAction opens) is broken
//   * the anchor is present, visible, and UNFRAMABLE  -> nothing is wrong. The tour's own fixed bottom bar is
//     why BOTTOM_BAND exists, and the demo's seeded screens are short and often do not scroll at all, so an
//     anchor low on a short page can never be seated in the band however many times we scroll to it. That
//     third state fired on EVERY session of such a chapter: a permanent false positive on a legitimate state.
// The exhaustion branch now records only what the DOM ESTABLISHED, and records nothing at all for the third.

// nearestScroller returns the closest scrollable ancestor of `node` that ISN'T the document (e.g. the run
// drawer's own scrolling body), or null when the document itself scrolls. A window scroll cannot move an
// anchor that lives inside a dialog/drawer, so beatIntoView scrolls THAT container instead. Test-DOM guarded.
function nearestScroller(node: HTMLElement): HTMLElement | null {
  if (typeof getComputedStyle !== "function") return null;
  let p = node.parentElement;
  while (p && p !== doc.body && p !== doc.documentElement) {
    const cs = getComputedStyle(p);
    if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && p.scrollHeight > p.clientHeight + 2) return p;
    p = p.parentElement;
  }
  return null;
}

// nearestScrollerX is the horizontal twin of nearestScroller: the closest ancestor that scrolls SIDEWAYS
// (the downpipes table's own .dp-table-wrap), or null when nothing does. Test-DOM guarded.
function nearestScrollerX(node: HTMLElement): HTMLElement | null {
  if (typeof getComputedStyle !== "function") return null;
  let p = node.parentElement;
  while (p && p !== doc.body && p !== doc.documentElement) {
    const cs = getComputedStyle(p);
    if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && p.scrollWidth > p.clientWidth + 2) return p;
    p = p.parentElement;
  }
  return null;
}

// seatAnchorAcross scrolls the anchor's own sideways-scrolling region so the subject is inside it, and it
// is the axis nothing had ever driven. A subject in a horizontally scrolling region can be laid out far
// outside that region's client box and so be CLIPPED ENTIRELY while still reporting a rect. For example,
// at 1024 with the guide docked as a rail, the downpipes table's visible band is 272 to 648 and dp-coverage
// sits at x=997, so the beat can frame a rectangle over the guide panel for something nobody can see.
// Instant rather than smooth, deliberately: the caller measures the anchor immediately afterwards, and a
// smooth scroll would have it measure the position the anchor is LEAVING.
function seatAnchorAcross(el: HTMLElement): void {
  const sc = nearestScrollerX(el);
  if (sc === null || typeof el.getBoundingClientRect !== "function" || typeof sc.getBoundingClientRect !== "function") return;
  const er = el.getBoundingClientRect();
  const sr = sc.getBoundingClientRect();
  const MARGIN = 16;
  const bandLeft = sr.left + MARGIN;
  const bandRight = sr.left + sc.clientWidth - MARGIN;
  if (er.left < bandLeft) sc.scrollLeft += er.left - bandLeft;
  else if (er.left + er.width > bandRight) sc.scrollLeft += Math.min(er.left - bandLeft, er.left + er.width - bandRight);
}

function beatIntoView(beat: { anchor: string }, token: number, attempt: number): void {
  if (!deps.alive() || token !== deps.token()) return;
  // The learner touched or scrolled during this beat: the viewport is theirs now.
  if (gestureToken === token) return;
  if (lastDeltaToken !== token) {
    lastDeltaToken = token;
    lastDelta = Number.POSITIVE_INFINITY;
  }
  const el = deps.doc.querySelector(`[data-tour-id="${beat.anchor}"]`) as HTMLElement | null;
  if (el !== null) seatAnchorAcross(el);
  const measurable = el !== null && typeof el.getBoundingClientRect === "function";
  const rc = measurable ? el.getBoundingClientRect() : null;
  // A box of 0x0 after the full retry window means the element is in the DOM and hidden or collapsed. A
  // measurable element with any extent is present and visible, whether or not it can be framed.
  const boxless = rc !== null && rc.width === 0 && rc.height === 0;

  // Recorded ONCE, at exhaustion, and never from the spotlight's own 60fps tick, which would beacon a thousand
  // times a minute for one broken anchor and drown every other signal on the channel.
  const retry = (): void => {
    if (attempt >= 8) {
      if (el === null) noteTourDegraded("anchor-missing", deps.chapterId(), beat.anchor);
      else if (boxless) noteTourDegraded("anchor-not-visible", deps.chapterId(), beat.anchor);
      // else: present, visible, and the scroll could not frame it. Legitimate. No event.
      // An element the DOM cannot measure at all (a headless document with no layout) is also silent: we
      // learnt nothing about it, and a row asserting it was missing would be a fact the code never tested.
      return;
    }
    const w = typeof window !== "undefined" ? window : undefined;
    if (w && typeof w.setTimeout === "function") w.setTimeout(() => beatIntoView(beat, token, attempt + 1), deps.frameMs);
  };

  // rc !== null implies el !== null (rc is only measured off a non-null el), but the null check is explicit so
  // the scroll path below narrows to a real element.
  if (rc === null || el === null) { retry(); return; }
  const vh = (typeof window !== "undefined" && window.innerHeight) || 800;
  const vw = (typeof window !== "undefined" && window.innerWidth) || 1024;
  // Clearance under the console's own sticky top bar, computed rather than assumed: a fixed constant of
  // 76 (--header-h's 56px plus a 20px margin) is right at desktop widths and wrong wherever the bar
  // wraps, because tokens.css lays the shell out as `minmax(var(--header-h), auto)` below the wide breakpoint,
  // so the bar is 89px at 768 and 141px at 390. A fixed constant would accept an
  // anchor seated BEHIND the bar, and the scroll target seated the top of a tall section behind it too.
  const TOP_CLEARANCE = topChromeClearance(doc, rc) + 20;
  const BOTTOM_BAND = 130;
  // On a phone the guide is a TALL bottom-pinned panel (the beat narration now lives inside it, ~30% of the
  // viewport), not a slim right rail. scrollIntoView({block:"center"}) centres the anchor in the FULL viewport,
  // so an anchor below the vertical middle lands BEHIND the panel (the tour points at something it is covering)
  // and a tall section can sit off the top with nothing visible. Measure the panel's real height and frame the
  // anchor in the STAGE that remains ABOVE it instead. The desktop rail keeps the original path unchanged.
  //
  // Both "already framed" early returns below are gated on !boxless (G338). A 0x0 anchor can sit at coordinates
  // that satisfy the band test, and returning early on one would declare a hidden element comfortably in view:
  // the retry ladder would never run, and the exhaustion branch would never record anchor-not-visible. The
  // evidence for a broken reveal depends on a boxless anchor NOT taking these returns.
  const navRect = deps.navRect();
  const isBottomBar = !!navRect && navRect.height > 0 && navRect.width >= vw * 0.6 && navRect.top >= vh * 0.4;
  if (isBottomBar && navRect) {
    const stageTop = TOP_CLEARANCE;
    const stageBottom = Math.round(navRect.top) - 16; // clear the panel plus a margin
    const stageH = Math.max(48, stageBottom - stageTop);
    // Enough bottom slack that even a page-foot anchor can scroll up into the stage (cleared on Exit/destroy).
    deps.setBottomSlack(vh - stageBottom + stageH / 2 + 24);
    if (!boxless && rc.top >= stageTop - 8 && rc.bottom <= stageBottom + 8) return; // already framed above the panel
    // Seat a section taller than the stage with its top under the fixed bar; otherwise centre it in the stage.
    const desiredTop = rc.height >= stageH ? stageTop : stageTop + (stageH - rc.height) / 2;
    const delta = Math.round(rc.top - desiredTop);
    // A scroll that leaves the subject no closer than the last attempt did cannot be helped by another one.
    // Ending here is what stops the highlight wandering on a short screen.
    const improved = Math.abs(delta) < lastDelta - 2;
    lastDelta = Math.abs(delta);
    if (Math.abs(delta) > 2 && (attempt === 0 || improved)) {
      // Scroll whatever actually owns the anchor: an inner container (the run drawer) if it has one, else the
      // document. Both move the anchor the same amount in viewport space, so the one stage delta applies.
      const sc = nearestScroller(el);
      const smooth = motionOK() ? "smooth" : "auto";
      const w = typeof window !== "undefined" ? window : undefined;
      if (sc && typeof sc.scrollBy === "function") sc.scrollBy({ top: delta, left: 0, behavior: smooth });
      else if (sc) sc.scrollTop += delta;
      else if (w && typeof w.scrollBy === "function") w.scrollBy({ top: delta, left: 0, behavior: smooth });
      else if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", behavior: smooth });
    }
    retry();
    return;
  }
  if (!boxless && rc.top >= TOP_CLEARANCE - 40 && rc.bottom <= vh - BOTTOM_BAND) return; // already comfortably in view
  if (typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "center", behavior: motionOK() ? "smooth" : "auto" });
  }
  retry();
}

  return { frame: beatIntoView };
}
