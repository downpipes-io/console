// The tour's STAGE: one soft spotlight that dims the console around the current beat's anchor and
// morphs between anchors as the walk advances (the rail narrates; this points). It replaces the old
// hunt-the-"?" mechanic as the guided walk's attention anchor: a single fixed "hole" element whose
// enormous box-shadow paints the dim, so the cutout
// needs no SVG mask, the dim can never intercept a click (a shadow is paint, not a hit target, and
// the hole itself is pointer-events:none), and the morph is a plain CSS transition on the hole's
// box metrics. Under reduced motion the morph is instant (information is never motion-gated).
//
// Tracking: the anchor is re-resolved and re-measured on a rAF loop (the same live-tracking
// discipline as the info-point layer), so a spotlight pinned to a row inside a scrolling page, a
// drawer that mounts a beat later, or a layout shift stays glued to its subject. An anchor that is
// absent (not yet rendered) or display:none hides the spotlight rather than pointing at nothing;
// the loop keeps watching, so it appears the moment the anchor mounts.
//
// House rules: Australian English; styling is per-property CSSOM (strict CSP).

import { motionOK } from "../../a11y-prefs.ts";

export interface Spotlight {
  // Aim the spotlight at the component carrying this data-tour-id (null hides it). `pulse` adds the
  // try-it ring (a slow accent pulse inviting a REAL click on the anchored control). `label`, when given,
  // pins a short CALLOUT chip to the lit area ("Your task is here"): the training course passes it on every
  // hands-on step, because a lit rectangle alone does not tell a learner that the instruction in the rail
  // is about THAT thing. Absent on the tour, which is why nothing renders without it.
  target(anchorId: string | null, opts?: { pulse?: boolean; label?: string }): void;
  // The root element (so a test can assert presence + metrics).
  readonly root: HTMLElement;
  // Tear the layer out (Exit / teardown). Idempotent.
  destroy(): void;
}

// The stable element id (one spotlight per page; a defensive re-mount replaces a stale one).
const ROOT_ID = "tour-spotlight";
// The callout chip's id, spelled as a LITERAL rather than built from ROOT_ID. A concatenated id cannot be
// found by a simple text search, and an assertion over an id nothing can produce
// passes vacuously: locator matches nothing, count reads 0, and the test goes green over an absence.
const CALLOUT_ID = "tour-spotlight-callout";
// Breathing room between the anchor's box and the cutout edge, and the cutout's corner radius
// (driver.js-calibre defaults: ~10px padding, gentle radius).
const PADDING = 10;
const RADIUS = 10;
// The dim wash: dark enough to stage the beat, light enough that the whole console stays readable
// (the walkthrough model shows real pages, never a blackout).
const DIM = "rgba(3, 7, 14, 0.44)";
// The smallest hole worth painting. Below this the cutout is a hairline over a fully dimmed console, which
// reads as "the tour is pointing at nothing" rather than as a spotlight; hiding is the honest state.
const MIN_EXTENT = 8;

// A rect the tour measures: the shape both this module and director.ts read off an anchor.
interface Box { top: number; left: number; width: number; height: number }

// topChromeClearance answers ONE question for ONE anchor: below which y must this anchor's spotlight (and the
// director's scroll framing) stay, so the console's own sticky top bar is not painted over the subject. It
// returns 0 when the bar does not cover this anchor at all, so nothing is clamped that need not be.
//
// THE HEIGHT IS COMPUTED, NOT ASSUMED, because tokens.css lays the shell out as `minmax(var(--header-h), auto)`
// below the wide breakpoint, so the sticky .context-bar measures 89px at 768 and 141px at 390. A fixed
// constant is right on a desktop and wrong on a phone: it would paint the hole up to 81px under a bar that
// is painted over it.
//
// AND THE OVERLAP IS PUT TO THE BROWSER RATHER THAN INFERRED FROM TWO RECTANGLES, because a first draft of
// this repair got that wrong and made things worse on three beats. The run-detail drawer is an overlay with
// its own stacking context and paints ABOVE the bar, so an anchor inside it can overlap the bar's box while
// being entirely visible: at a narrow width, run-status can sit at y=126 under a 141px bar where elementFromPoint
// still answers the anchor. Clamping on the rectangles alone cut that anchor's hole down to 28% of it.
// elementFromPoint answers what the reader would actually touch, so that is what decides.
export function topChromeClearance(doc: Document, rc: Box | null): number {
  const el = doc.querySelector("header.context-bar") as HTMLElement | null;
  const r = el && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
  if (!el || !r || r.height <= 0 || r.top > 1) return 0;
  const bottom = r.top + r.height;
  if (rc === null || typeof doc.elementFromPoint !== "function") return bottom;
  const w = typeof window !== "undefined" ? window : undefined;
  const vw = w?.innerWidth || 1024;
  // Sampled in the bar's own band, in the anchor's column: whatever is painted there is what a subject in
  // that column would be behind. The bar itself means the clamp is real; anything else (the run drawer, a
  // dialog) means this anchor's layer is above the bar and the clamp would hide a visible subject.
  const x = Math.min(Math.max(rc.left + Math.min(rc.width / 2, 40), 1), vw - 1);
  const hit = doc.elementFromPoint(x, Math.max(bottom - 2, 1));
  return hit !== null && (hit === el || el.contains(hit)) ? bottom : 0;
}

export function createSpotlight(doc: Document = document): Spotlight {
  doc.getElementById(ROOT_ID)?.remove();

  let destroyed = false;
  let anchorId: string | null = null;
  let pulsing = false;
  let calloutText: string | null = null;
  let raf = 0;
  // The last painted box, so the loop writes styles only on real movement (avoids transition churn
  // from sub-pixel jitter while tracking).
  let last = { top: -1, left: -1, w: -1, h: -1, visible: false };

  const hole = h(doc, "div", ROOT_ID);
  const s = hole.style;
  s.setProperty("position", "fixed");
  s.setProperty("pointer-events", "none");
  s.setProperty("box-sizing", "border-box");
  s.setProperty("border-radius", `${RADIUS}px`);
  s.setProperty("box-shadow", `0 0 0 200vmax ${DIM}`);
  s.setProperty("border", "1px solid color-mix(in srgb, var(--accent) 55%, transparent)");
  // Below the tour chrome (the rail must sit on the lit side of the dim), above the app content.
  s.setProperty("z-index", "calc(var(--z-palette) - 1)");
  s.setProperty("opacity", "0");
  s.setProperty("top", "0px");
  s.setProperty("left", "0px");
  s.setProperty("width", "0px");
  s.setProperty("height", "0px");
  if (motionOK()) {
    s.setProperty("transition", "top 0.4s var(--ease-out), left 0.4s var(--ease-out), width 0.4s var(--ease-out), height 0.4s var(--ease-out), opacity 0.25s var(--ease-out)");
  }

  // The CALLOUT chip: a small accent tag that rides with the lit area and names what it is. It exists to
  // join the two halves of a course screen. The rail states the task; the spotlight lights the place; the
  // chip says that the two are the same thing. It is painted only when a caller passes a label, so the tour
  // is unchanged. aria-hidden, because the rail already announces the task to assistive tech, and a
  // duplicate announcement helps nobody. pointer-events:none, so it can never take a click from the control
  // it points at.
  const callout = h(doc, "div", CALLOUT_ID);
  const cs = callout.style;
  cs.setProperty("position", "fixed");
  cs.setProperty("pointer-events", "none");
  cs.setProperty("display", "none");
  cs.setProperty("max-width", "min(280px, 60vw)");
  cs.setProperty("padding", "4px 10px");
  cs.setProperty("border-radius", "var(--radius-full)");
  cs.setProperty("background", "var(--accent)");
  cs.setProperty("color", "var(--accent-fg, #fff)");
  cs.setProperty("font-family", "var(--font-sans)");
  cs.setProperty("font-size", "var(--text-xs)");
  cs.setProperty("font-weight", "var(--weight-semibold)");
  cs.setProperty("letter-spacing", "0.02em");
  cs.setProperty("white-space", "nowrap");
  cs.setProperty("overflow", "hidden");
  cs.setProperty("text-overflow", "ellipsis");
  cs.setProperty("box-shadow", "var(--shadow-md, 0 2px 8px rgba(0,0,0,0.3))");
  cs.setProperty("z-index", "calc(var(--z-palette) - 1)");

  const body = doc.body;
  if (body) {
    body.appendChild(hole);
    body.appendChild(callout);
  }

  // The visible stage: the RECTANGLE of viewport a spotlight may paint into, bounded by the console's sticky
  // top bar, the tour's own guide panel (a floating bottom panel on a phone, a docked right rail on a desktop)
  // and the viewport edges. Used to clamp a spotlight so it never cuts a hole larger than the screen, and never
  // cuts one under a piece of chrome that is painted over it.
  //
  // THE TOP EDGE IS COMPUTED, NOT ASSUMED: a fixed constant of 60 (the 56px --header-h plus a 4px margin) is
  // correct at desktop widths and wrong at every width where the bar wraps, because tokens.css lays the shell
  // out as `minmax(var(--header-h), auto)` below the wide breakpoint, so the sticky .context-bar measures 89px
  // at 768 and 141px at 390. A fixed constant would paint the hole up
  // to 81px UNDER a bar that is painted over it, across beats at both 768 and 390.
  //
  // THE RIGHT EDGE IS THE OTHER HALF OF THE SAME MISTAKE. Only top and bottom were ever clamped, so at 1024,
  // where the guide docks as a 344px right rail, a hole tracking an anchor in a wide table ran under the rail
  // and, once, 83px off the right of the viewport: a hole wider than the screen paints no dim at that edge, so
  // there is no spotlight. The rail is detected as the not-bottom-bar variant of the same element.
  function stageRect(rc: Box | null): { top: number; bottom: number; left: number; right: number } {
    const w = typeof window !== "undefined" ? window : undefined;
    const vh = w?.innerHeight || 800;
    const vw = w?.innerWidth || 1024;
    const chrome = topChromeClearance(doc, rc);
    const top = chrome > 0 ? chrome + 4 : 0;
    let bottom = vh - 12;
    let right = vw - 4;
    const nav = doc.getElementById("tour-nav-bar");
    const nr = nav && typeof nav.getBoundingClientRect === "function" ? nav.getBoundingClientRect() : null;
    if (nr && nr.height > 0) {
      if (nr.width >= vw * 0.6 && nr.top >= vh * 0.4) bottom = nr.top - 12;
      else if (nr.left >= vw * 0.5) right = nr.left - 12;
    }
    if (bottom < top) bottom = top;
    if (right < 4) right = 4;
    return { top, bottom, left: 4, right };
  }

  function hide(): void {
    if (last.visible || last.top === -1) {
      s.setProperty("opacity", "0");
      last = { ...last, visible: false };
    }
    cs.setProperty("display", "none");
  }

  // calloutChromeFloor is the lowest edge of whatever bar is pinned to the top of THIS screen: the console's
  // own sticky context bar on a normal page, or the onboarding deck's ob-top on the full-bleed setup screen.
  // The deck is why this is not topChromeClearance: that function asks about header.context-bar only, and the
  // deck does not have one, so the chip was seated at y=0 across the product logo on a phone.
  function calloutChromeFloor(): number {
    let floor = 0;
    for (const sel of ["header.context-bar", ".ob-top"]) {
      const el = doc.querySelector(sel) as HTMLElement | null;
      const r = el && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
      if (r && r.height > 0 && r.top <= 1) floor = Math.max(floor, r.top + r.height);
    }
    return floor;
  }

  // placeCallout seats the chip against the lit area: above it when there is room under the top chrome,
  // otherwise just inside its top edge. It follows the lit area's left edge for an ordinary control, and
  // CENTRES on a wide one, because a whole-screen subject (the onboarding deck) put the chip in the far
  // top-left corner over the console's own logo, where it read as chrome rather than as a pointer. The
  // vertical seat is clamped into the stage for the same reason: a lit area whose top is off-screen must
  // not push the chip up behind the fixed bar.
  function placeCallout(top: number, left: number, width: number, stage: { top: number; bottom: number }): void {
    if (calloutText === null) {
      cs.setProperty("display", "none");
      return;
    }
    if (callout.textContent !== calloutText) callout.textContent = calloutText;
    cs.setProperty("display", "block");
    const w = typeof window !== "undefined" ? window : undefined;
    const vw = w?.innerWidth || 1024;
    const chipW = callout.offsetWidth || 180;
    const above = top - 28;
    const seat = above >= stage.top + 4 ? above : Math.min(top + 8, stage.bottom - 26);
    // Never under the console's own sticky bar: at a narrow width with a full-screen subject, the chip could
    // sit at y=0 across the product logo, which reads as broken chrome rather than as a pointer at anything. The
    // bar's height is asked for directly here (rather than taken from the stage, which is computed for the
    // SUBJECT and is 0 when the bar does not cover it) because the chip and the subject are not in the same
    // place: a subject that clears the bar can still have its chip seated behind it.
    const chromeFloor = calloutChromeFloor() + 4;
    const y = Math.max(stage.top + 4, chromeFloor, seat);
    // A wide subject centres; a narrow one keeps its left edge, which is what points at a single control.
    const WIDE = 480;
    const wanted = width >= WIDE ? left + width / 2 - chipW / 2 : left;
    const x = Math.max(4, Math.min(wanted, vw - chipW - 8));
    cs.setProperty("top", `${Math.round(y)}px`);
    cs.setProperty("left", `${Math.round(x)}px`);
  }

  function scheduleNext(): void {
    const w = typeof window !== "undefined" ? window : undefined;
    if (w && typeof w.requestAnimationFrame === "function") raf = w.requestAnimationFrame(tick);
  }

  // coveredByOverlay reports whether a MODAL is painted over the anchor: the browser is asked what is at the
  // anchor's centre, and the answer is inside a dialog the anchor is not part of.
  //
  // On the training course at a narrow viewport: the course's downpipe step anchors the empty-state
  // table, the learner presses New downpipe, and the
  // create dialog opens over it. The anchor is still there, still measurable, and completely hidden, so the
  // spotlight lit a 378x431 rectangle over the dialog, pointing at something nobody could see, with its top
  // 122px behind the sticky bar. An anchor inside a drawer is the OPPOSITE case and stays lit: there the
  // dialog contains the anchor, which is how the tour's run-detail beats work.
  function coveredByOverlay(el: HTMLElement, rc: Box): boolean {
    if (typeof doc.elementFromPoint !== "function") return false;
    const w = typeof window !== "undefined" ? window : undefined;
    const vw = w?.innerWidth || 1024;
    const vh = w?.innerHeight || 800;
    const x = Math.min(Math.max(rc.left + rc.width / 2, 1), vw - 1);
    const y = Math.min(Math.max(rc.top + rc.height / 2, 1), vh - 1);
    const hit = doc.elementFromPoint(x, y);
    if (!hit || hit === el || el.contains(hit)) return false;
    const overlay = typeof hit.closest === "function" ? hit.closest('[role="dialog"], dialog') : null;
    return overlay !== null && !overlay.contains(el);
  }

  function tick(): void {
    if (destroyed) return;
    if (anchorId !== null) {
      const el = doc.querySelector(`[data-tour-id="${anchorId}"]`) as HTMLElement | null;
      const rc = el && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
      if (rc && rc.width > 0 && rc.height > 0 && el !== null && coveredByOverlay(el, rc)) {
        // Hiding is the honest state, exactly as it is for an anchor with no overlap with the stage.
        hide();
        scheduleNext();
        return;
      }
      if (rc && rc.width > 0 && rc.height > 0) {
        // A section taller than the viewport (a 2-column integrations/provider grid on a phone) would cut a hole
        // bigger than the screen: no dim, so no spotlight, and the box runs off under the panel. Clamp the hole
        // to the visible STAGE (under the top bar, above the floating bottom panel, clear of the docked rail) so
        // an over-tall or over-wide anchor frames what is actually on screen; a normal anchor sits inside the
        // stage and is unaffected.
        const stage = stageRect(rc);
        const rawTop = rc.top - PADDING;
        const rawBottom = rc.top + rc.height + PADDING; // == rc.bottom + PADDING, but robust when a rect lacks .bottom
        const rawLeft = rc.left - PADDING;
        const rawRight = rc.left + rc.width + PADDING;
        const top = Math.round(Math.max(rawTop, stage.top));
        const hgt = Math.round(Math.max(0, Math.min(rawBottom, stage.bottom) - Math.max(rawTop, stage.top)));
        const left = Math.round(Math.max(rawLeft, stage.left));
        const w = Math.round(Math.max(0, Math.min(rawRight, stage.right) - Math.max(rawLeft, stage.left)));
        // An anchor whose overlap with the stage is nothing (scrolled off the top, or sitting entirely behind
        // the docked rail) used to leave a 2px sliver painted at full opacity, which reads as a fully dimmed
        // console pointing at nothing. There is no honest hole to cut, so hide, exactly as an absent anchor
        // does; the loop keeps watching, so the spotlight returns the moment the anchor is back on the stage.
        if (w < MIN_EXTENT || hgt < MIN_EXTENT) {
          hide();
          scheduleNext();
          return;
        }
        // Write only on real movement (>1px) or a visibility change, so tracking a static anchor is free.
        if (!last.visible || Math.abs(top - last.top) > 1 || Math.abs(left - last.left) > 1 || Math.abs(w - last.w) > 1 || Math.abs(hgt - last.h) > 1) {
          s.setProperty("top", `${top}px`);
          s.setProperty("left", `${left}px`);
          s.setProperty("width", `${w}px`);
          s.setProperty("height", `${hgt}px`);
          s.setProperty("opacity", "1");
          last = { top, left, w, h: hgt, visible: true };
        }
        // The chip is re-seated every frame the lit area is up, so it tracks a scroll exactly as the hole
        // does. Its own writes are two properties, and only while a label is set.
        placeCallout(top, left, w, stage);
      } else {
        hide();
      }
    } else {
      hide();
    }
    scheduleNext();
  }
  tick();

  return {
    target(id: string | null, opts?: { pulse?: boolean; label?: string }): void {
      if (destroyed) return;
      const firstAim = anchorId === null && id !== null;
      anchorId = id;
      const nextLabel = opts?.label !== undefined && opts.label !== "" ? opts.label : null;
      if (nextLabel !== calloutText) {
        calloutText = nextLabel;
        if (calloutText === null) cs.setProperty("display", "none");
      }
      const nextPulse = opts?.pulse === true;
      if (nextPulse !== pulsing) {
        pulsing = nextPulse;
        // The try-it ring: a named keyframe in tokens.css (dp-tour-invite), gated on the effective
        // motion preference by the [data-motion] attribute the pre-paint script sets.
        if (pulsing) hole.classList.add("tour-spot--invite");
        else hole.classList.remove("tour-spot--invite");
      }
      // A brand-new aim should appear IN PLACE rather than flying in from 0x0 at the viewport corner:
      // suppress the transition for the first paint, then restore it on the next frame.
      if (firstAim && motionOK()) {
        s.setProperty("transition", "opacity 0.25s var(--ease-out)");
        const w = typeof window !== "undefined" ? window : undefined;
        const restore = (): void => {
          if (!destroyed) s.setProperty("transition", "top 0.4s var(--ease-out), left 0.4s var(--ease-out), width 0.4s var(--ease-out), height 0.4s var(--ease-out), opacity 0.25s var(--ease-out)");
        };
        if (w && typeof w.requestAnimationFrame === "function") w.requestAnimationFrame(() => w.requestAnimationFrame(restore));
        else restore();
      }
    },
    root: hole,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      const w = typeof window !== "undefined" ? window : undefined;
      if (raf && w && typeof w.cancelAnimationFrame === "function") w.cancelAnimationFrame(raf);
      hole.remove();
      callout.remove();
    },
  };
}

// h builds the one element this module needs without importing the app's dom helper (the tour layer
// keeps its chrome dependency-light; ids/classes only, all styling via CSSOM above).
function h(doc: Document, tag: string, id: string): HTMLElement {
  const el = doc.createElement(tag);
  el.id = id;
  el.setAttribute("aria-hidden", "true");
  return el;
}
