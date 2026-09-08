// The bottom-centre navigation bar for the public page-walkthrough tour. The old spotlight + dim-scrim was too narrow and hid the product; the
// new model keeps the REAL console screen fully visible and the guide sits ON it, never over it. This bar is the
// guide's one persistent control surface: a big, obvious, premium strip pinned to the bottom centre of the
// viewport, on the console's own design tokens.
//
// Contents: a round Back button; the chapter title + an OBVIOUS segmented progress bar ("2 of 11", one
// filled segment per chapter so the position reads even at chapter 1) with a per-step dwell bar under it (the
// guided-autoplay timing indicator); a round Next button (the primary accent); a Play/Pause autoplay toggle
// (default PAUSED, opt-in); a "?" toggle that shows or hides every info-point marker (default SHOWN); and an Exit
// that drops the guide to free-explore. The bar owns ONLY its own chrome + the controls' handlers; the director
// (tour/director.ts) wires the verbs, drives update() per chapter, and owns the info-points the "?" toggles.
//
// CSP: every style is applied through the CSSOM by the h() builder (per-property setProperty), never an inline
// style attribute or a <style> block, so the bar runs under the console's strict style-src 'self' with no
// 'unsafe-inline'. It reads as a first-class part of the product (the same --accent, --surface-raised,
// --shadow-lg, radius and spacing tokens the console uses), not a bolted-on widget.
//
// Accessibility (the console's WCAG 2.2 AA gate): the bar is a labelled region; every control is a real <button>
// reachable and operable by keyboard with the console's own visible focus ring; the director's keyboard layer
// maps ArrowLeft/Right to Back/Next, Space to Play/Pause and Escape to Exit (this module renders the operable
// buttons + exposes their handlers); a polite ARIA live region announces each chapter; status is conveyed by
// label + shape, not hue alone; and prefers-reduced-motion (OS or the in-app setting, via motionOK) drops the
// bar's entrance animation. The bar is pointer-events:auto over a pointer-transparent host, so it never blocks
// the page while staying clickable itself.
//
// House rules: Australian English, precise claims.

import { motionOK } from "../../a11y-prefs.ts";
import { h, svgIcon } from "../../dom.ts";
import { ICON_CHEVRON_LEFT, ICON_CHEVRON_RIGHT, ICON_CLOSE, ICON_HOURGLASS, ICON_PAUSE, ICON_PLAY, ICON_QUESTION, ICON_SOUND_OFF, ICON_SOUND_ON } from "../../icons.ts";
import { buildCourseParts, createPanelModes, publishPanelHeight, republishPanelHeight, stepLine, type NavBarCta, type TaskDoneMode, watchPanelHeight } from "./nav-bar-course.ts";
import { buildFunnelParts } from "./nav-bar-funnel.ts";
import { applyFocusRing, clearFocusRing } from "./overlay.ts";

// The control handlers the director wires. Each is optional so a chapter can offer only the relevant controls
// (Back is omitted on the first chapter, Next on the last); the bar renders only the buttons whose handler is
// present. play/pause/toggleInfo are toggles in the UI; the director passes both halves and update() chooses the
// glyph from the current state.
export interface NavBarControls {
  onBack?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
  onPlay?: (() => void) | undefined;
  onPause?: (() => void) | undefined;
  onToggleInfo?: (() => void) | undefined;
  onExit?: (() => void) | undefined;
  // onCycleSpeed cycles the guided-autoplay reading pace (more or less time per step); speedLabel is the
  // current pace shown on the control (e.g. "1×" / "2×" / "0.5×"). Present only on the tour's own controls.
  onCycleSpeed?: (() => void) | undefined;
  speedLabel?: string | undefined;
  // The training course's narration toggle. Present only on a course, which is the only surface that has
  // audio; soundOn is the current state, so the control shows what pressing it will do.
  onToggleSound?: (() => void) | undefined;
  soundOn?: boolean | undefined;
}

// The current BEAT's narration (the guided walk's reading unit, beat model): the rail (or
// the compact bottom bar) renders it as the story's always-visible home, paired with the spotlight on
// the beat's anchor. index/count are 0-based/-total within the chapter; tryIt, when present, is the
// short invitation label for a real-interaction beat ("Fly the canary now").
export interface NavBarBeat {
  index: number;
  count: number;
  title: string;
  body: string;
  tryIt?: string | undefined;
  // The training walk's task instruction ("Your turn: ..."): the grader-gated sibling of tryIt. When both
  // are somehow present the task wins (a task beat's instruction is the thing the walk is waiting on).
  task?: string | undefined;
  // The 1-based step within THIS chapter that carries its hands-on task, when the chapter has one. The rail
  // puts it in the step line ("Step 1 of 3, hands-on task at step 3"), because a learner reading step 1 of a
  // course cannot otherwise tell how far it is to the next thing they have to do. Absent on tour beats.
  taskAtStep?: number | undefined;
  // Whether this beat should hand the console back by default on a phone: a hands-on step while the course
  // is speaking. The rail ignores it; there is room for both there.
  handBackScreen?: boolean | undefined;
  // The beat's real documentation link (the training walk links every step to docs.downpipes.io),
  // rendered as a quiet external anchor under the narration. Absent on tour beats.
  docHref?: string | undefined;
  docLabel?: string | undefined;
}

// The imperative handle the director drives. update() sets the chapter title + 1-based progress (and the
// progress track); setControls() rebuilds the buttons for the current chapter (Back/Next presence); setPlaying /
// setInfoVisible flip the two toggles' glyphs; announce() writes the polite live region; focusBar() pulls
// keyboard focus onto the bar (a user-driven chapter change); destroy() tears the bar out.
export interface NavBar {
  // Set the chapter title + 1-based progress ("Sources", 2, 11) and advance the progress track. Rendered as
  // TEXT (never markup), so a chapter title can never inject into the in-account console.
  update(title: string, index: number, total: number): void;
  // Rebuild the control buttons from the handlers for THIS chapter (Back off the first, Next off the last,
  // Play/Pause + "?" + Exit always). The current playing / info-visible state is preserved across the rebuild.
  setControls(controls: NavBarControls): void;
  // Flip the Play/Pause toggle glyph + label to match the autoplay state (the director calls it on play/pause).
  setPlaying(playing: boolean): void;
  // Flip the "?" toggle's pressed state to match whether info-points are shown (the director calls it on toggle).
  setInfoVisible(visible: boolean): void;
  // Update the reading-speed control's visible label (the director calls it when the visitor cycles the pace),
  // repainting just the controls rather than rebuilding the whole bar.
  setSpeed(label: string): void;
  // Paint the current beat's narration (title + body + step position + optional try-it invitation) into the
  // reading area, or clear it (null) on a chapter with no beats (the funnel close, where the CTAs carry the
  // message). The RAIL variant gives this a full reading column; the bottom bar clamps the body to two lines.
  setBeat(beat: NavBarBeat | null): void;
  // Flip the current TASK CARD to its done state (chip DONE, success colouring). The director calls it the
  // moment a task's grader passes, in the pause before the walk advances, so the learner SEES their action
  // land in the course. A no-op when no task card is showing. "already-done" is the Back case: the learner
  // has walked back onto a step they finished, so the card reads as complete and nothing advances.
  markTaskDone(mode?: TaskDoneMode): void;
  // Flip the current TASK CARD to its HAND-OVER state. The director calls it at the one moment a playing
  // course deliberately stops: it has finished explaining a hands-on step, and the learner is now driving.
  // A no-op when no task card is showing.
  handOverTask(): void;
  // Say ON THE CARD why the walk did not move when Next was pressed on an unmet task. The rail announces
  // the same sentence for assistive tech; this is the sighted half, and without it the press reads as a
  // broken button. A no-op when no task card is showing.
  nudgeTask(text: string): void;
  // Re-apply the CURRENT beat's phone default after something changed that decides it (the learner turning
  // the narration off mid-step: the text is then the only instruction there is, so the panel comes back).
  refreshBeatDefault(handBackScreen: boolean): void;
  // Paint the CHAPTER's standing goal line ("what this stage is for, and why it comes here"), or clear it
  // with null. It stands for every beat of the chapter, so the answer to "why am I doing this" is never a
  // step the learner has already paged past. Course-only; the tour passes null.
  setGoal(text: string | null): void;
  // Paint the chapter index (the rail's quiet table of contents): every chapter title with the current one
  // highlighted and the walked ones ticked, so the journey's shape is always visible. Rail-only; the bottom
  // bar has no room and its segmented track carries the position instead.
  setChapters(titles: ReadonlyArray<string>, current: number): void;
  // Render the funnel CTAs above the controls (the closing chapter's two deliberate exits), or clear them when
  // passed an empty list (every non-funnel chapter). Each CTA is a real anchor the browser navigates. `lead`,
  // when present, is the one honest line rendered above the pair (TEXT, never markup).
  setCtas(ctas: ReadonlyArray<NavBarCta>, lead?: string): void;
  // Show (or clear, with null) the mid-tour standing exit at the chapter index's foot: a quiet "I've seen
  // enough" link to the pricing page. Rail-only (the bottom bar has no room; the finale + free-roam pill
  // carry the ask elsewhere); a calm standing affordance, never a nag.
  setEarlyExit(cfg: { href: string; onActivate?: (() => void) | undefined } | null): void;
  // Drive the per-step DWELL bar (the guided-autoplay timing indicator): start it filling 0 -> 100% over
  // `durationMs` (so the visitor sees how long until the next "?"), or pass null to hide + reset it (a pause, a
  // manual chapter). The fill animates via a CSS width transition (instant under reduced motion).
  setDwellActive(durationMs: number | null): void;
  // Announce a string in the polite ARIA live region (the director announces each chapter for screen-reader
  // users, independent of any visual change).
  announce(message: string): void;
  // Move keyboard focus onto the bar (its Next control), so a user-driven chapter change lands the keyboard user
  // on the forward control. Shows the console's visible focus ring; it clears on blur.
  focusBar(): void;
  // The root element (so a test can assert structure + the director can scope queries). Always present between
  // mount and destroy.
  readonly root: HTMLElement;
  // Tear the bar out of the DOM (Exit / teardown). Idempotent.
  destroy(): void;
}

// The stable element id, so a test (and a defensive double-mount) finds the bar deterministically and the
// director re-mounts idempotently. One nav-bar per page.
const ROOT_ID = "tour-nav-bar";

// mountNavBar builds the bar into document.body and returns the handle. Idempotent: a stale bar (a defensive
// double-mount) is removed first. It mounts empty-of-meaning (no title, no controls) until the director's first
// update()/setControls() paints it. A document with no body returns a detached, inert handle (defensive; the
// director mounts at start, when the body exists).
// The rail's variant options. All absent on the tour, which is why every default below is the tour's
// historical behaviour: `eyebrow` names the surface (a course says which course it is), `progressUnit` names
// what the chapter counter counts ("Stage 3 of 8" reads as a course; the tour's bare "3 of 8" is unchanged),
// `labelledControls` gives Back and Next visible words rather than bare chevrons (a learner should never have
// to guess which disc goes back), and `exitLabel`/`exitAria` name the way out in the surface's own terms.
export interface NavBarOptions {
  eyebrow?: string;
  progressUnit?: string;
  labelledControls?: boolean;
  exitLabel?: string;
  exitAria?: string;
}

export function mountNavBar(doc: Document = document, opts: NavBarOptions = {}): NavBar {
  doc.getElementById(ROOT_ID)?.remove();

  let destroyed = false;
  // What the phone panel's mode machine (nav-bar-course.ts) asks back about the current paint, so it never
  // restores a block that has nothing in it: whether a beat is showing at all, whether this chapter set a
  // goal, and whether this beat carries a documentation link.
  let beatShowing = false;
  let goalShowing = false;
  let beatDocHref: string | null = null;
  // NARROW is the phone strip, where four labelled controls do not fit on one line and Back was wrapping
  // onto a row of its own, costing sixty pixels of console for nothing. Back and Next keep their words
  // there (a learner should never have to guess which way is back); Sound and Leave drop to their icons,
  // with the meaning still on the accessible name.
  let narrow = false;
  let playing = false;
  let infoVisible = true;
  let controls: NavBarControls = {};

  // The polite live region: an off-screen announcer the director writes each chapter into. role=status +
  // aria-live=polite so it never interrupts and is read once per chapter.
  const live = h("div", { role: "status", "aria-live": "polite", "aria-atomic": "true", class: "visually-hidden" });

  // The chapter title (e.g. "Sources"), a clear heading on its own line above the progress bar. A 2-line
  // -webkit-box clamp (not nowrap+ellipsis) so a long title (the finale's payoff line) wraps and stays fully
  // readable rather than truncating mid-sentence.
  const titleEl = h("span", {
    // dataset.tourChapterTitle: an inert observation hook (the robot learner and the walk probes read the
    // current chapter off it), the same idiom as the beat block's own data attributes below.
    dataset: { tourChapterTitle: "true" },
    style: ["font-size:var(--text-lg)", "font-weight:var(--weight-semibold)", "color:var(--text)", "letter-spacing:var(--tracking-tight)", "display:-webkit-box", "-webkit-box-orient:vertical", "-webkit-line-clamp:2", "overflow:hidden"].join(";"),
  });
  // The progress label ("2 of 11"), tabular numerals so the count never jitters.
  const progressEl = h("span", {
    style: ["font-size:var(--text-xs)", "font-weight:var(--weight-medium)", "color:var(--text-muted)", "font-variant-numeric:tabular-nums", "white-space:nowrap", "flex:none"].join(";"),
  });

  // ---- the OBVIOUS, segmented progress bar ----
  // A full-width, clearly visible status bar: one SEGMENT per chapter so the position reads even at chapter 1
  // (the first segment is filled). Each segment is a track cell that fills (accent) when reached. A continuous
  // accent underlay also fills proportionally, so it reads as a progress bar at a glance, not just ticks. The
  // group carries role=progressbar with aria-valuenow/min/max for assistive tech. Built dynamically in update()
  // from the chapter total.
  const segmentRow = h("div", {
    role: "progressbar",
    "aria-label": "Tour progress",
    dataset: { tourProgressSegments: "true" },
    style: ["display:flex", "gap:4px", "width:100%", "height:8px", "align-items:stretch"].join(";"),
  });
  // The per-step DWELL bar (the guided-autoplay timing indicator): a thin accent bar UNDER the segment row that
  // fills 0 -> 100% over the current step's dwell while autoplay is playing, so the visitor sees how long until
  // the next "?". Hidden (zero height, no fill) when not playing. The fill width is driven by setDwellActive.
  const dwellFill = h("div", {
    "aria-hidden": "true",
    dataset: { tourDwellFill: "true" },
    style: ["height:100%", "width:0%", "background:var(--accent)", "border-radius:var(--radius-full)"].join(";"),
  });
  const dwellTrack = h("div", {
    "aria-hidden": "true",
    dataset: { tourDwellTrack: "true" },
    style: ["display:none", "width:100%", "height:4px", "background:var(--border-subtle)", "border-radius:var(--radius-full)", "overflow:hidden", "margin-top:var(--space-1)"].join(";"),
  }, dwellFill);

  // ---- the beat block: the story's always-visible home ----
  // The current beat's narration (step position, title, body, optional try-it invitation). In the RAIL
  // variant this is the reading column the whole redesign exists for; in the bottom bar it renders
  // compactly with the body clamped to two lines. Hidden until the director's first setBeat.
  const beatMetaEl = h("span", {
    dataset: { tourBeatMeta: "true" },
    // min-height reserves the line even when a single-beat chapter renders no step counter, so the
    // reading block sits at the same height on every beat (no per-chapter jump).
    style: ["font-size:var(--text-xs)", "font-weight:var(--weight-medium)", "color:var(--text-muted)", "font-variant-numeric:tabular-nums", "letter-spacing:0.02em", "text-transform:uppercase", "min-height:1.2em"].join(";"),
  });
  const beatTitleEl = h("span", {
    dataset: { tourBeatTitle: "true" },
    style: ["font-size:var(--text-md)", "font-weight:var(--weight-semibold)", "color:var(--text)"].join(";"),
  });
  const beatBodyEl = h("p", {
    dataset: { tourBeatBody: "true" },
    style: ["margin:0", "font-size:var(--text-sm)", "line-height:1.55", "color:var(--text-muted)"].join(";"),
  });
  const beatTryEl = h("span", {
    dataset: { tourTryIt: "true" },
    style: ["display:none", "align-items:center", "gap:var(--space-2)", "font-size:var(--text-sm)", "font-weight:var(--weight-semibold)", "color:var(--accent-subtle-fg)"].join(";"),
  });
  // The COURSE parts (nav-bar-course.ts): the eyebrow that names the course, the standing goal line, and the
  // TASK CARD, which is the visible join between what the learner does on the console and what the rail says.
  // The funnel chrome (nav-bar-funnel.ts): the tour's two closing exits and its standing mid-walk exit.
  const funnel = buildFunnelParts();
  const ctaRow = funnel.ctaRow;
  const earlyExitEl = funnel.earlyExitEl;
  const course = buildCourseParts({ ...(opts.eyebrow !== undefined ? { eyebrow: opts.eyebrow } : {}) });
  const taskCardEl = course.taskCardEl;
  // The beat's documentation link (the training walk's per-step doc anchor). A real external anchor in the
  // console's field__doc idiom: target _blank + noreferrer noopener, href set per beat, hidden when absent.
  const beatDocEl = h("a", {
    dataset: { tourBeatDoc: "true" },
    target: "_blank",
    rel: "noreferrer noopener",
    style: ["display:none", "align-items:center", "gap:var(--space-1)", "font-size:var(--text-sm)", "color:var(--text-muted)", "text-decoration:underline", "width:fit-content"].join(";"),
  }) as HTMLAnchorElement;
  const beatBlock = h(
    "div",
    { dataset: { tourBeatBlock: "true" }, style: ["display:none", "flex-direction:column", "gap:var(--space-2)", "min-width:0", "padding-top:var(--space-2)"].join(";") },
    beatMetaEl,
    beatTitleEl,
    beatBodyEl,
    beatTryEl,
    taskCardEl,
    beatDocEl,
  );

  // The title row: the chapter name and its counter, plus (on a phone) the minimise control the modes add.
  const titleRow = h("div", { style: ["display:flex", "align-items:center", "justify-content:space-between", "gap:var(--space-2)", "min-width:0"].join(";") }, titleEl, progressEl);

  // The reading column, top to bottom: the surface's identity line (a course names itself), the chapter
  // title with its counter, the chapter progress track, the autoplay dwell bar, the standing GOAL for this
  // stage, then the current beat.
  const progressBlock = h(
    "div",
    { style: ["display:flex", "flex-direction:column", "gap:var(--space-1)", "min-width:0", "flex:1 1 auto"].join(";") },
    ...(course.eyebrowEl ? [course.eyebrowEl] : []),
    titleRow,
    segmentRow,
    dwellTrack,
    course.goalEl,
    beatBlock,
  );

  // The phone panel's modes (nav-bar-course.ts): compact by default, expandable to the full text, and
  // minimisable to one line so the console gets its screen back. Rail: neither control is rendered.
  const republish = (): void => republishPanelHeight(doc, bar, isRail());
  const modes = createPanelModes({
    progressBlock,
    beatBlock,
    beatBody: beatBodyEl,
    beatDoc: beatDocEl,
    segmentRow,
    eyebrow: course.eyebrowEl,
    goal: course.goalEl,
    isRail: () => isRail(),
    beatShowing: () => beatShowing,
    goalShowing: () => goalShowing,
    docShowing: () => beatDocHref !== null,
    onApplied: republish,
  });
  progressBlock.appendChild(modes.moreBtn);
  titleRow.appendChild(modes.minimiseBtn);

  // The control cluster (Back / Next / Play-Pause / "?" / Exit), rebuilt per chapter by setControls. flex-wrap
  // so a narrow viewport reflows rather than clipping.
  const controlCluster = h("div", {
    role: "group",
    "aria-label": "Tour controls",
    style: ["display:flex", "align-items:center", "gap:var(--space-2)", "flex:none"].join(";"),
  });

  // Next lives in its OWN slot rather than at the tail of the cluster, because the rail lays the foot out as
  // two rows and Next belongs on the walking row with Back, not among the chrome. In the bottom bar the slot
  // sits exactly where Next used to sit (last, on the right), so that variant is unchanged.
  //
  // THE DEFECT THIS FIXES. Four labelled controls (Back, Sound, Leave, Next) measure 324px plus their gaps
  // against a 344px rail with 20px of padding each side, so from the second step of the course onward, the
  // step where Back appears, the row overflowed by 29px and Next hung outside the panel. Every control in it
  // is flex:none by design (the foot must not squash), so nothing could absorb the excess.
  const forwardSlot = h("div", {
    dataset: { tourForwardSlot: "true" },
    style: ["flex:none", "display:flex", "align-items:center"].join(";"),
  });

  // The rail's WALKING row: Back on the left, Next on the right, the two controls that move the walk. Back is
  // absent on the first step and the slot holds its width, so Next never shifts sideways between steps.
  const railNavRow = h("div", {
    dataset: { tourNavRow: "true" },
    style: ["display:flex", "align-items:center", "justify-content:space-between", "gap:var(--space-2)", "width:100%"].join(";"),
  });

  // The funnel-CTA row: the closing chapter's two deliberate exits render here as real anchors, ABOVE the
  // control strip. Empty (and zero-height) on every other chapter. A group label so the two exits read as a set.

  // The horizontal control strip (Back, the chapter title + segmented progress block, the controls, the live
  // region). The progress block grows to fill the width so the segmented bar is genuinely full-width.
  const backSlotEl = backSlot();
  const controlRow = h(
    "div",
    { style: ["position:relative", "display:flex", "align-items:center", "gap:var(--space-4)", "width:100%"].join(";") },
    backSlotEl,
    progressBlock,
    controlCluster,
    forwardSlot,
    live,
  );

  const bar = h(
    "div",
    {
      id: ROOT_ID,
      role: "region",
      "aria-label": "Tour navigation",
      tabindex: "-1",
      dataset: { tourNavBar: "true", frontLayer: "true" }, // data-front-layer: see persona-fork.ts's card
      style: [
        "position:fixed",
        "left:50%",
        "transform:translateX(-50%)",
        "bottom:var(--space-6)",
        "box-sizing:border-box",
        "width:min(840px, 92vw)",
        "display:flex",
        "flex-direction:column",
        "align-items:stretch",
        "gap:var(--space-3)",
        // Taller, more substantial: generous vertical + horizontal padding so the bar reads as a premium control
        // surface, not a thin strip.
        "padding:var(--space-4) var(--space-5)",
        "background:var(--surface-raised)",
        "color:var(--text)",
        "border:1px solid var(--border)",
        "border-radius:var(--radius-lg)",
        "box-shadow:var(--shadow-lg)",
        "font-family:var(--font-sans)",
        "pointer-events:auto",
        "z-index:var(--z-palette)",
        // No default outline: focusBar applies the ring imperatively (a programmatic focus on the Next button is
        // keyboard-style, but the bar container also takes the ring on a user-driven chapter change so the
        // sighted keyboard user sees the bar light up); it clears on blur.
      ].join(";"),
      on: { blur: () => clearFocusRing(bar) },
    },
    ctaRow,
    controlRow,
  );

  const body = doc.body;
  const panelWatch = body ? watchPanelHeight(doc, bar, () => isRail()) : null;
  if (!body) {
    return { update() {}, setControls() {}, setPlaying() {}, setInfoVisible() {}, setSpeed() {}, setBeat() {}, markTaskDone() {}, handOverTask() {}, nudgeTask() {}, refreshBeatDefault() {}, setGoal() {}, setChapters() {}, setCtas() {}, setEarlyExit() {}, setDwellActive() {}, announce() {}, focusBar() {}, root: bar, destroy() {} };
  }
  body.appendChild(bar);

  // The bar rises in once on mount (a premium settle), gated on motionOK() so the in-app reduced-motion opt-out
  // is honoured (the CSS prefers-reduced-motion gate keys only on the OS query). CSP-safe by NAME against the
  // dp-rise keyframe in tokens.css. The translateX(-50%) centring is preserved by dp-rise (it only animates
  // opacity + a small translateY, then settles to `none`, so the centring transform is restored on completion).
  if (motionOK()) bar.style.setProperty("animation", "dp-rise var(--dur) var(--ease-out)");

  // ---- responsive layout (CSP-safe: per-property CSSOM, the bar carries no class for a @media rule) ----
  // On a phone the single horizontal strip (Back + the chapter title/progress block + the Play/Tips/Exit/Next
  // cluster) cannot fit on one line, so the "Chapter X of 11" counter collides with the controls. Below 560px
  // (matching the carousel + welcome-sheet breakpoint) the strip REFLOWS: the progress block takes its own full
  // row on top, and Back + the control cluster wrap, centred, beneath it. Re-applied on resize so a rotation or a
  // desktop window drag reflows live. The wide layout restores the original one-line strip.
  // actionsRow exists only in the RAIL variant: it gathers Back + the control cluster onto one row
  // pinned to the rail's foot (margin-top:auto), so the reading column above breathes. In the bottom
  // bar the two live directly in controlRow exactly as before; applyVariant MOVES the nodes (moving
  // preserves their listeners), so there is one control set however the chrome is laid out.
  const actionsRow = h("div", {
    dataset: { tourActionsRow: "true" },
    // flex:none: the foot controls never shrink when the column is tight (the chapter index is the
    // one flexible region), so Back/Play/Exit/Next hold their size and place on every beat.
    style: ["display:flex", "flex:none", "align-items:center", "justify-content:space-between", "gap:var(--space-2)", "margin-top:auto", "padding-top:var(--space-3)"].join(";"),
  });

  // The chapter index (rail-only): the journey's quiet table of contents. Filled by setChapters; the
  // bottom bar hides it (the segmented track carries position there).
  const chapterList = h("ol", {
    dataset: { tourChapterList: "true" },
    "aria-label": "Chapters",
    style: ["display:none", "flex-direction:column", "gap:2px", "margin:var(--space-2) 0 0", "padding:var(--space-3) 0 0", "list-style:none", "border-top:1px solid var(--border-subtle)", "min-height:0", "overflow-y:auto"].join(";"),
  });

  // isRail: the docked right-rail variant serves comfortable widths; the floating bottom bar serves
  // the rest (phones + narrow windows), where a fixed side column would crush the console.
  function isRail(): boolean {
    const w = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1280;
    return w >= 1024;
  }

  function layoutForWidth(): void {
    const w = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1280;
    const wasNarrow = narrow;
    narrow = !isRail() && w <= 560;
    if (narrow !== wasNarrow) {
      renderBack();
      renderControls();
    }
    if (isRail()) {
      // RAIL: a calm right-hand column. The console shifts left underneath via the body class
      // (tokens.css body.dp-tour-rail .main), so the rail never covers content.
      doc.body?.classList.add("dp-tour-rail");
      bar.style.setProperty("left", "auto");
      bar.style.setProperty("transform", "none");
      bar.style.setProperty("right", "var(--space-4)");
      bar.style.setProperty("top", "calc(var(--header-h, 56px) + var(--space-4))");
      bar.style.setProperty("bottom", "var(--space-4)");
      bar.style.setProperty("width", "344px");
      // The rail's BOX is constant (top+bottom pinned); the whole panel never scrolls. When content
      // is tall (a long beat on a short window) the CHAPTER INDEX below is the one flexible region
      // that shrinks and scrolls, so the narration and the foot controls stay put and no panel-wide
      // scrollbar can appear and shift the content width.
      bar.style.setProperty("overflow-y", "hidden");
      bar.style.setProperty("padding", "var(--space-5)");
      controlRow.style.setProperty("flex-direction", "column");
      controlRow.style.setProperty("align-items", "stretch");
      controlRow.style.setProperty("flex-wrap", "nowrap");
      controlRow.style.setProperty("justify-content", "flex-start");
      controlRow.style.setProperty("gap", "var(--space-3)");
      controlRow.style.setProperty("flex", "1 1 auto");
      controlRow.style.setProperty("min-height", "0");
      // SHRINK-UNDER-PRESSURE, not fixed. This was "0 0 auto", and with the reading column unable to give,
      // a beat one line too long pushed the foot controls out of a box that is pinned top and bottom and is
      // overflow-y:hidden. At some viewport sizes the two flexible regions below can be crushed to
      // 1px and 13px while this column holds 533px and does not yield, leaving Back and Next 15px past the rail's
      // bottom edge, clipped, unseeable and unpressable, with no way to leave the step.
      //
      // "0 1 auto" with min-height 0 is identical whenever the content fits, so the full body and the absent
      // scrollbar are unchanged in the ordinary case. Under pressure the reading column scrolls instead of
      // the controls leaving, which is the priority the rail's own comment already states: of the narration
      // and the foot controls, only one of the two can be recovered by scrolling.
      progressBlock.style.setProperty("flex", "0 1 auto");
      progressBlock.style.setProperty("min-height", "0");
      progressBlock.style.setProperty("overflow-y", "auto");
      progressBlock.style.setProperty("order", "0");
      controlCluster.style.setProperty("flex-wrap", "wrap");
      controlCluster.style.setProperty("justify-content", "flex-end");
      // The narrative order in the rail: header + narration, then the finale's CTAs (when present),
      // then the chapter index, then the foot controls. In the bottom bar the CTA row stays above the
      // strip (its historical spot); moving nodes preserves their listeners.
      controlRow.insertBefore(ctaRow, live);
      controlRow.appendChild(chapterList);
      chapterList.style.setProperty("display", "flex");
      // The index is the flexible region: it shrinks first and scrolls internally when tight, with a
      // stable gutter so a scrollbar appearing never changes the rows' width.
      chapterList.style.setProperty("flex", "1 1 auto");
      chapterList.style.setProperty("scrollbar-gutter", "stable");
      // The standing early exit sits at the index's foot, above the pinned controls.
      controlRow.appendChild(earlyExitEl);
      funnel.refresh(isRail());
      // Gather the controls onto the pinned foot, as TWO rows: the chrome (sound, pause, leave) above, and
      // the walking row (Back, Next) below it. One row cannot hold four labelled controls at 344px, and the
      // walk's own two controls are the ones that must never be the pair that overflows.
      controlRow.appendChild(actionsRow);
      actionsRow.style.setProperty("flex-direction", "column");
      actionsRow.style.setProperty("align-items", "stretch");
      actionsRow.style.setProperty("justify-content", "flex-start");
      actionsRow.style.setProperty("gap", "var(--space-2)");
      actionsRow.appendChild(controlCluster);
      controlCluster.style.setProperty("justify-content", "flex-start");
      actionsRow.appendChild(railNavRow);
      railNavRow.appendChild(backSlotEl);
      railNavRow.appendChild(forwardSlot);
      // The dwell track keeps its box from the start in the rail (empty until autoplay fills it),
      // so pressing Play never shifts the layout below.
      dwellTrack.style.setProperty("display", "block");
      // The reading column gets the full body (no clamp, no scroll cap).
      modes.apply();
      beatBodyEl.style.setProperty("display", "block");
      beatBodyEl.style.setProperty("-webkit-line-clamp", "unset");
      beatBodyEl.style.setProperty("-webkit-box-orient", "unset");
      beatBodyEl.style.setProperty("overflow", "visible");
      beatBodyEl.style.setProperty("max-height", "none");
      return;
    }
    // BOTTOM BAR: restore the floating strip. Move Back + the cluster home first (no-ops when already there).
    doc.body?.classList.remove("dp-tour-rail");
    if (backSlotEl.parentElement !== controlRow) controlRow.insertBefore(backSlotEl, progressBlock);
    if (controlCluster.parentElement !== controlRow) controlRow.insertBefore(controlCluster, live);
    if (forwardSlot.parentElement !== controlRow) controlRow.insertBefore(forwardSlot, live);
    actionsRow.style.setProperty("flex-direction", "row");
    actionsRow.style.setProperty("align-items", "center");
    actionsRow.style.setProperty("justify-content", "space-between");
    railNavRow.remove();
    actionsRow.remove();
    chapterList.style.setProperty("display", "none");
    funnel.refresh(isRail()); // bar variant: hidden (no room; the finale + free-roam pill carry the ask)
    if (ctaRow.parentElement === controlRow) bar.insertBefore(ctaRow, controlRow);
    bar.style.setProperty("right", "auto");
    bar.style.setProperty("top", "auto");
    bar.style.setProperty("left", "50%");
    bar.style.setProperty("transform", "translateX(-50%)");
    bar.style.setProperty("bottom", "var(--space-6)");
    bar.style.setProperty("width", "min(840px, 92vw)");
    bar.style.setProperty("overflow-y", "visible");
    controlRow.style.setProperty("flex-direction", "row");
    controlRow.style.setProperty("align-items", "center");
    controlRow.style.setProperty("flex", "0 1 auto");
    // The floating panel would be enormous if it showed a long narration in full at phone width, and an abrupt
    // 2-line clamp hid most of it mid-sentence. Instead the body reads IN FULL inside a bounded, scrollable
    // region (a partial line peeks so there is an obvious "more"); the title and controls stay put around it.
    beatBodyEl.style.setProperty("display", "block");
    beatBodyEl.style.setProperty("-webkit-line-clamp", "unset");
    beatBodyEl.style.setProperty("-webkit-box-orient", "unset");
    beatBodyEl.style.setProperty("overscroll-behavior", "contain");
    if (w <= 560) {
      controlRow.style.setProperty("flex-wrap", "wrap");
      controlRow.style.setProperty("justify-content", "center");
      controlRow.style.setProperty("gap", "var(--space-3)");
      progressBlock.style.setProperty("flex", "1 1 100%");
      progressBlock.style.setProperty("order", "-1");
      controlCluster.style.setProperty("flex-wrap", "wrap");
      controlCluster.style.setProperty("justify-content", "center");
      bar.style.setProperty("padding", "var(--space-3) var(--space-4)");
    } else {
      // Restore the one-line strip. setProperty back to defaults (not removeProperty: the minimal test DOM
      // shim implements setProperty only).
      controlRow.style.setProperty("flex-wrap", "nowrap");
      controlRow.style.setProperty("justify-content", "flex-start");
      controlRow.style.setProperty("gap", "var(--space-4)");
      progressBlock.style.setProperty("flex", "1 1 auto");
      progressBlock.style.setProperty("order", "0");
      controlCluster.style.setProperty("flex-wrap", "nowrap");
      controlCluster.style.setProperty("justify-content", "normal");
      bar.style.setProperty("padding", "var(--space-4) var(--space-5)");
    }
    modes.apply();
    publishPanelHeight(doc, bar, isRail());
  }
  layoutForWidth();
  const onResize = (): void => layoutForWidth();
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("resize", onResize);
  }

  // ---- the control buttons ----

  // roundButton builds one Back / Next control: a real <button> on the .btn classes for the focus ring +
  // contrast, sized to a comfortable touch target, with the icon + an accessible name. On the tour it is a
  // round icon-only disc, so the name lives in aria-label (never icon-alone). A COURSE asks for
  // labelledControls and gets the word beside the chevron: a learner walking a course should not have to
  // work out which disc goes back, and Back is the control this whole surface most needs to be obvious.
  // `primary` paints the Next accent; `forward` tags it for the director's keyboard layer.
  function roundButton(name: string, icon: string, onClick: () => void, primary: boolean, forward: boolean): HTMLButtonElement {
    const labelled = opts.labelledControls === true;
    const shape = labelled
      ? ["height:44px", "padding:0 var(--space-3)", "gap:var(--space-1)", "border-radius:var(--radius-full)", "display:inline-flex", "align-items:center", "justify-content:center", "pointer-events:auto", "flex:none", "white-space:nowrap"]
      : ["width:44px", "height:44px", "padding:0", "border-radius:var(--radius-full)", "display:inline-flex", "align-items:center", "justify-content:center", "pointer-events:auto", "flex:none"];
    return h(
      "button",
      { "data-dp": "lib-tour-nav-bar.button.click",
        type: "button",
        class: primary ? "btn btn--primary" : "btn btn--secondary",
        "aria-label": name,
        dataset: forward ? { tourAction: "next" } : {},
        style: shape.join(";"),
        on: { click: onClick },
      },
      forward ? null : svgIcon(icon, { size: 18 }),
      labelled ? h("span", name) : null,
      forward ? svgIcon(icon, { size: 18 }) : null,
    ) as HTMLButtonElement;
  }

  // toggleButton builds one labelled toggle control (Play/Pause, the "?" info toggle): a real <button> on the
  // ghost classes with aria-pressed reflecting the state, an icon + a short visible label, and an accessible
  // name. The pressed state is the observable a test (and a screen reader) reads.
  function toggleButton(name: string, icon: string, visibleLabel: string, pressed: boolean, onClick: () => void, hook: string): HTMLButtonElement {
    const showLabel = !narrow;
    return h(
      "button",
      { "data-dp": "lib-tour-nav-bar.toggle.click",
        type: "button",
        class: "btn btn--ghost btn--sm",
        "aria-label": name,
        "aria-pressed": pressed ? "true" : "false",
        dataset: { tourToggle: hook },
        style: ["display:inline-flex", "align-items:center", "gap:var(--space-1)", "pointer-events:auto", "flex:none", "white-space:nowrap"].join(";"),
        on: { click: onClick },
      },
      svgIcon(icon, { size: 16 }),
      showLabel ? h("span", visibleLabel) : null,
    ) as HTMLButtonElement;
  }

  // renderControls rebuilds the cluster from the current controls + state: Back (when offered), the autoplay
  // toggle, the "?" toggle, Exit, and Next (when offered, the primary accent on the right). Re-rendered on every
  // chapter so an ended walk can drop Next and the first chapter can drop Back.
  function renderControls(): void {
    while (controlCluster.firstChild) controlCluster.removeChild(controlCluster.firstChild);
    // The autoplay toggle: Play while paused (the button starts autoplay), Pause while playing.
    if (controls.onPlay || controls.onPause) {
      const t = playing
        ? toggleButton("Pause autoplay", ICON_PAUSE, "Pause", true, () => controls.onPause?.(), "play")
        : toggleButton("Play the tour automatically", ICON_PLAY, "Play", false, () => controls.onPlay?.(), "play");
      controlCluster.appendChild(t);
    }
    // The autoplay-speed cycler: sits beside Pause so a visitor can give themselves more or less time to
    // read each step. It is a PLAYBACK-SPEED control (2× = faster, 0.5× = slower, the universal convention),
    // a CYCLER not a toggle (no aria-pressed); the visible label + the descriptive aria-label carry the pace.
    // The hourglass glyph signals it governs timing. Rendered ONLY while playing: beside Pause its pace
    // meaning is self-evident, while beside a resting Play a bare "1×" read as noise.
    if (controls.onCycleSpeed && playing) {
      const speedLabel = controls.speedLabel ?? "1×";
      controlCluster.appendChild(
        h(
          "button",
          { "data-dp": "lib-tour-nav-bar.button.cycle-speed",
            type: "button",
            class: "btn btn--ghost btn--sm",
            "aria-label": `Autoplay speed ${speedLabel}. Tap to cycle: faster (less time to read) or slower (more time).`,
            title: "Autoplay speed (tap to cycle)",
            dataset: { tourAction: "speed" },
            style: ["display:inline-flex", "align-items:center", "gap:var(--space-1)", "pointer-events:auto", "flex:none", "white-space:nowrap"].join(";"),
            on: { click: () => controls.onCycleSpeed?.() },
          },
          svgIcon(ICON_HOURGLASS, { size: 16 }),
          h("span", speedLabel),
        ),
      );
    }
    // The narration toggle (course only): pressed while the course is speaking. Sound is ON by default, so
    // this control's usual job is to turn it OFF for a learner who would rather read.
    if (controls.onToggleSound) {
      const soundOn = controls.soundOn !== false;
      controlCluster.appendChild(
        toggleButton(
          soundOn ? "Turn the narration off and read instead" : "Turn the narration back on",
          soundOn ? ICON_SOUND_ON : ICON_SOUND_OFF,
          soundOn ? "Sound" : "Muted",
          soundOn,
          () => controls.onToggleSound?.(),
          "sound",
        ),
      );
    }
    // The "?" info-point toggle: pressed when markers are shown (the default).
    if (controls.onToggleInfo) {
      controlCluster.appendChild(
        toggleButton(infoVisible ? "Hide the help points" : "Show the help points", ICON_QUESTION, "Tips", infoVisible, () => controls.onToggleInfo?.(), "info"),
      );
    }
    // Exit to free-explore: a short visible label so it stays narrow; the accessible name is descriptive.
    if (controls.onExit) {
      controlCluster.appendChild(
        h(
          "button",
          { "data-dp": "lib-tour-nav-bar.button.exit",
            type: "button",
            class: "btn btn--ghost btn--sm",
            "aria-label": opts.exitAria ?? "Exit the tour and explore freely",
            dataset: { tourAction: "exit" },
            style: ["display:inline-flex", "align-items:center", "gap:var(--space-1)", "pointer-events:auto", "flex:none", "white-space:nowrap"].join(";"),
            on: { click: () => controls.onExit?.() },
          },
          svgIcon(ICON_CLOSE, { size: 16 }),
          narrow ? null : h("span", opts.exitLabel ?? "Exit"),
        ),
      );
    }
    // Next is the primary forward action on the far right, present before the last chapter. It renders into
    // the forward slot, which the rail puts on its walking row beside Back and the bottom bar keeps in place.
    while (forwardSlot.firstChild) forwardSlot.removeChild(forwardSlot.firstChild);
    if (controls.onNext) {
      forwardSlot.appendChild(roundButton("Next", ICON_CHEVRON_RIGHT, () => controls.onNext?.(), true, true));
    }
  }

  // backSlot holds the Back control on the left; renderBack rebuilds it (present off the first chapter). It is a
  // fixed-width slot so the label does not shift left when Back appears/disappears between chapters.
  function backSlot(): HTMLElement {
    // A labelled Back is wider than a disc, so the slot sizes to its content there and keeps the disc's fixed
    // width otherwise (the label must not shift when Back appears and disappears between chapters).
    const width = opts.labelledControls === true ? "min-width:44px" : "width:44px";
    const slot = h("div", { dataset: { tourBackSlot: "true" }, style: ["flex:none", width, "display:flex"].join(";") });
    return slot;
  }
  function renderBack(): void {
    const slot = backSlotEl;
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    if (controls.onBack) slot.appendChild(roundButton("Back", ICON_CHEVRON_LEFT, () => controls.onBack?.(), false, false));
  }

  return {
    root: bar,
    update(title: string, index: number, total: number): void {
      if (destroyed) return;
      titleEl.textContent = title;
      // Short visible form ("8 of 12"): the word "Chapter" spent width the title needs; the aria-valuetext
      // below keeps the fuller phrasing for assistive tech. A course names the unit it counts ("Stage 3 of
      // 8"), because a bare pair of numbers beside a title does not tell a learner what is being counted.
      progressEl.textContent = opts.progressUnit !== undefined && opts.progressUnit !== "" ? `${opts.progressUnit} ${index} of ${total}` : `${index} of ${total}`;
      // Rebuild the segmented progress bar: one cell per chapter, filled (accent) up to and including the current
      // one, the rest a muted track. This reads as a clear status bar even at chapter 1 (the first cell is
      // filled). role=progressbar carries the numeric position to assistive tech.
      segmentRow.setAttribute("aria-valuenow", String(index));
      segmentRow.setAttribute("aria-valuemin", "1");
      segmentRow.setAttribute("aria-valuemax", String(Math.max(1, total)));
      segmentRow.setAttribute("aria-valuetext", `${opts.progressUnit ?? "Chapter"} ${index} of ${total}`);
      while (segmentRow.firstChild) segmentRow.removeChild(segmentRow.firstChild);
      const count = Math.max(1, total);
      for (let i = 1; i <= count; i++) {
        const done = i <= index;
        // Unfilled cells paint var(--border) (not border-subtle): on the dark theme the subtle tone was
        // invisible against the raised bar, so the track read as missing rather than to-come.
        segmentRow.appendChild(h("div", {
          "aria-hidden": "true",
          dataset: { tourSegment: done ? "done" : "todo" },
          style: ["flex:1 1 0", "height:100%", "border-radius:var(--radius-full)", `background:${done ? "var(--accent)" : "var(--border)"}`, "transition:background var(--dur) var(--ease-out)"].join(";"),
        }));
      }
    },
    setControls(next: NavBarControls): void {
      if (destroyed) return;
      controls = next;
      renderBack();
      renderControls();
    },
    setPlaying(p: boolean): void {
      if (destroyed) return;
      playing = p;
      renderControls();
    },
    setInfoVisible(v: boolean): void {
      if (destroyed) return;
      infoVisible = v;
      renderControls();
    },
    setSpeed(label: string): void {
      if (destroyed) return;
      // Update only the speed control's label (the visitor cycled the pace mid-walk), keeping every other
      // control + the play state intact. renderControls reads controls.speedLabel.
      controls = { ...controls, speedLabel: label };
      renderControls();
    },
    setChapters(titles: ReadonlyArray<string>, current: number): void {
      if (destroyed) return;
      while (chapterList.firstChild) chapterList.removeChild(chapterList.firstChild);
      titles.forEach((title, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        const row = h("li", {
          dataset: { tourChapterRow: state },
          style: [
            "display:flex", "align-items:center", "gap:var(--space-2)",
            "padding:3px 0", "font-size:var(--text-xs)",
            `color:${state === "current" ? "var(--text)" : "var(--text-muted)"}`,
            `font-weight:${state === "current" ? "var(--weight-semibold)" : "var(--weight-regular)"}`,
            "min-width:0",
          ].join(";"),
        },
          h("span", {
            "aria-hidden": "true",
            style: [
              "flex:none", "width:6px", "height:6px", "border-radius:var(--radius-full)",
              `background:${state === "todo" ? "var(--border)" : "var(--accent)"}`,
              `opacity:${state === "done" ? "0.55" : "1"}`,
            ].join(";"),
          }),
          h("span", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0" }, title),
        );
        if (state === "current") row.setAttribute("aria-current", "step");
        chapterList.appendChild(row);
      });
    },
    setBeat(beat: NavBarBeat | null): void {
      if (destroyed) return;
      if (beat === null) {
        beatShowing = false;
        beatBlock.style.setProperty("display", "none");
        return;
      }
      beatShowing = true;
      beatBlock.style.setProperty("display", "flex");
      // The step line is now ALWAYS painted, and it carries the distance to the next hands-on step. A course
      // that showed the counter only on multi-beat chapters, and never said where the task was, left a
      // learner reading step one with no way to tell how much stood between them and the thing they had to
      // do: "I couldn't tell how far I had to go to reach the first completion gate."
      beatMetaEl.textContent = stepLine(beat.index, beat.count, beat.taskAtStep);
      beatTitleEl.textContent = beat.title;
      beatBodyEl.textContent = beat.body;
      // A task renders as the TASK CARD (chip + instruction + where-to-do-it hint, reset to the waiting
      // state per beat); a tour try-it keeps the inline invitation line. Neither hides the other's absence.
      if (beat.task !== undefined && beat.task !== "") {
        course.setTask(beat.task);
        beatTryEl.style.setProperty("display", "none");
      } else if (beat.tryIt !== undefined && beat.tryIt !== "") {
        beatTryEl.textContent = `Try it: ${beat.tryIt}`;
        beatTryEl.style.setProperty("display", "inline-flex");
        course.setTask(null);
      } else {
        beatTryEl.style.setProperty("display", "none");
        course.setTask(null);
      }
      beatDocHref = beat.docHref !== undefined && beat.docHref !== "" ? beat.docHref : null;
      if (beat.docHref !== undefined && beat.docHref !== "") {
        beatDocEl.href = beat.docHref;
        beatDocEl.textContent = beat.docLabel !== undefined && beat.docLabel !== "" ? beat.docLabel : "Read the docs";
        beatDocEl.style.setProperty("display", "inline-flex");
      } else {
        beatDocEl.style.setProperty("display", "none");
      }
      modes.enterBeat(beat.handBackScreen === true);
      republish();
    },
    markTaskDone(mode: TaskDoneMode = "just-done"): void {
      if (destroyed) return;
      course.markTaskDone(mode);
    },
    handOverTask(): void {
      if (destroyed) return;
      course.handOverTask();
    },
    nudgeTask(text: string): void {
      if (destroyed) return;
      course.nudgeTask(text);
    },
    refreshBeatDefault(handBackScreen: boolean): void {
      if (destroyed) return;
      modes.refreshDefault(handBackScreen);
      republish();
    },
    setGoal(text: string | null): void {
      if (destroyed) return;
      goalShowing = text !== null && text !== "";
      course.setGoal(text);
      // On the phone panel the goal belongs to the expanded state; re-apply so setting one mid-chapter
      // cannot push the controls off a compact panel.
      modes.apply();
      republish();
    },
    setCtas(ctas: ReadonlyArray<NavBarCta>, lead?: string): void {
      if (destroyed) return;
      funnel.setCtas(ctas, lead);
    },
    setEarlyExit(cfg: { href: string; onActivate?: (() => void) | undefined } | null): void {
      if (destroyed) return;
      funnel.setEarlyExit(cfg, isRail());
    },
    setDwellActive(durationMs: number | null): void {
      if (destroyed) return;
      if (durationMs === null) {
        // Reset the dwell bar (a pause, or a manual beat). In the RAIL the empty track KEEPS its box
        // (visible but unfilled): toggling display shifted everything below it by a few pixels on
        // every autoplay beat, which read as the panel changing size. The bottom bar keeps its
        // historical hide (its single-strip height is the point there).
        if (isRail()) dwellTrack.style.setProperty("display", "block");
        else dwellTrack.style.setProperty("display", "none");
        dwellFill.style.setProperty("transition", "none");
        dwellFill.style.setProperty("width", "0%");
        return;
      }
      // Show the dwell bar and fill it from 0 to 100% over the step's dwell, so the visitor sees how long until
      // the next "?". Under reduced motion the bar still fills (the timing is information, not decoration) but
      // jumps rather than animating. Reset to 0 first (transition:none), then on the next frame set the target
      // width with the timed transition, so the browser actually animates the fill rather than snapping.
      dwellTrack.style.setProperty("display", "block");
      const reduced = !motionOK();
      // Reset to empty with NO transition, then force a SYNCHRONOUS style/layout flush so the 0% is committed
      // as the transition's start value BEFORE the timed transition to 100% is set. This is the reliable
      // "restart a CSS transition" idiom. Without it, every step AFTER the first kept the previous step's full
      // bar: the old deferred (setTimeout) reset let the 0% and the 100% writes collapse into one frame for an
      // element that had already animated, so the fill stayed full and the visitor could not see how long was
      // left to read. Reading offsetWidth is the reflow trigger; it is a harmless no-op under the test DOM shim
      // (which never lays out, so offsetWidth is undefined and the void simply discards it).
      dwellFill.style.setProperty("transition", "none");
      dwellFill.style.setProperty("width", "0%");
      void dwellFill.offsetWidth;
      if (reduced) {
        // Reduced motion: the timing is information, not decoration, so the bar still fills, but it jumps.
        dwellFill.style.setProperty("width", "100%");
        return;
      }
      dwellFill.style.setProperty("transition", `width ${durationMs}ms linear`);
      dwellFill.style.setProperty("width", "100%");
    },
    announce(message: string): void {
      // Clear then set on the next task so a repeat of the same string still announces (the console's announce
      // idiom). setTimeout is present in both the browser and the test DOM shim.
      live.textContent = "";
      if (typeof setTimeout === "function") setTimeout(() => { live.textContent = message; }, 0);
      else live.textContent = message;
    },
    focusBar(): void {
      if (destroyed) return;
      // Prefer the Next control (the forward action the visitor most likely wants next); fall back to the bar
      // container so focus always lands on the guide on a user-driven chapter change.
      const next = controlCluster.querySelector('[data-tour-action="next"]') as HTMLElement | null;
      const target = next ?? bar;
      if (typeof target.focus === "function") target.focus();
      applyFocusRing(bar);
    },
    destroy(): void {
      destroyed = true;
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("resize", onResize);
      }
      doc.body?.classList.remove("dp-tour-rail");
      panelWatch?.();
      doc.body?.classList.remove("dp-tour-panel");
      doc.body?.style.setProperty("--dp-tour-panel-h", "0px");
      bar.remove();
    },
  };
}
