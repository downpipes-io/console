// The tour director: the self-driving controller over a typed CHAPTER script for the public page-walkthrough
// tour. The old spotlight + dim-scrim model was
// too narrow and hid the product; the new model keeps the REAL console screen fully visible (no scrim, no
// spotlight, no bubble) and the guide sits ON it: a bottom-centre nav-bar (tour/nav-bar.ts) plus "?" info-points
// pinned to the screen's components (tour/info-point.ts). The visitor reads the whole page and dives into any
// "?"; Back/Next walk the chapters; Play (autoplay) is opt-in and default paused.
//
// For each chapter the director navigates the SPA router to the chapter's route, waits for the target screen to
// render, runs an optional preAction (e.g. opening a run drawer), mounts that chapter's info-points and updates
// the nav-bar. Because the faked backend (the demo-world.ts + demo-routes-*.ts modules) is deterministic, every chapter reconstructs the same
// world every time, so the tour cannot flake on a slow or failing network call and Back is a cheap, exact
// replay. The director owns ONLY control flow: it holds no DOM chrome of its own (that is the nav-bar +
// info-points) and no tour content of its own (a chapter script is data the welcome card hands in). It is
// additive and lives entirely behind the tour/demo flag; nothing here runs on the genuine console.
//
// Controls (DESIGN): MANUAL by default (the visitor drives with Back / Next; the tour never advances on its
// own). Play turns it into a GUIDED autoplay: it reveals the current chapter's "?" explanations one at a time,
// each held a dwell scaled to its prose (a visible per-step dwell bar in the nav shows how long until the next),
// and only after the last "?" advances to the next chapter; on the last chapter it stops back to manual. Pause
// returns to manual at once (closing the open "?"). A "?" toggle shows or hides every info-point (default shown);
// a segmented progress bar (chapter n of N); Exit to free-explore (drop the guide, leave the visitor in the real
// faked app) and Resume (bring the guide back at the chapter they left).
//
// Accessibility (the console's WCAG 2.2 AA gate): keyboard operable (ArrowLeft/Right = Back/Next, Space =
// Play/Pause, Escape = Exit, all reachable + operable by key); a polite ARIA live region announces each chapter
// (the nav-bar owns it; the director writes it); prefers-reduced-motion honoured (the nav-bar + info-points
// drop their animations; autoplay still advances, it just does not animate). Autoplay never traps: Pause and
// Exit are always one key away, and an autoplay advance never steals keyboard focus.
//
// House rules: Australian English, precise claims.

import { navigate as navBridge, clearLeaveGuard as clearLeaveGuardBridge } from "../../nav.ts";
import { singleKeyShortcutsEnabled } from "../../a11y-prefs.ts";
import { resetWorld } from "../demo-world.ts";
import { mountNavBar, type NavBar } from "./nav-bar.ts";
import { createReadingSpeed } from "./reading-speed.ts";
import { createSpotlight, type Spotlight } from "./spotlight.ts";
import { createBeatFramer } from "./beat-framing.ts";
import { h, svgIcon } from "../../dom.ts";
import { ICON_PLAY } from "../../icons.ts";
import { emit } from "./analytics.ts";
import { noteTourDegraded, registerTourVocabulary } from "../demo-drift.ts";
import { onDemoRoute } from "../demo-route-signal.ts";
import { announcementTextFor, narrationStepId } from "./narration-text.ts";

// One tour chapter. A chapter is DATA, not code: it names a route to navigate to, a short title for the nav-bar,
// an optional preAction the director runs once the chapter's screen has rendered (a side effect like opening a
// drawer), and the info-points (the "?" markers) to mount on that screen. Typing the script means a renamed
// route or a missing field is a build error in the script module, not a runtime surprise.

// A BEAT: the guided walk's reading unit ( beat model; formerly the "?" info-point). Each
// beat anchors the story to one component: the rail narrates the title + body while the spotlight
// dims the console around the anchor, and Next advances beat by beat. `interact`, when present,
// marks a try-it beat: the spotlight pulses an invitation on the REAL control, the rail shows the
// label, and the walk advances when the visitor genuinely clicks it (autoplay performs the click).
export interface InfoPoint {
  // The data-tour-id value of the component this beat explains. The spotlight finds it with
  // document.querySelector(`[data-tour-id="${anchor}"]`); an absent anchor hides the spotlight and
  // the walk still narrates, so a chapter degrades gracefully.
  anchor: string;
  // The beat heading + the body prose. Both reach the DOM as TEXT (never markup), so a chapter
  // string can never inject into the in-account console.
  title: string;
  body: string;
  // Retained from the popover era for script compatibility; the beat model does not read it.
  placement?: "top" | "bottom" | "left" | "right";
  // Marks a try-it beat: `label` is the short invitation ("Fly the canary now"). The anchored
  // control is the console's REAL button; the faked engine makes the click safe and reversible.
  interact?: { label: string };
  // Marks a TASK beat (the training walk's grader-gated unit). `label` is the short instruction the rail
  // shows ("Verify and save an R2 destination"); `done` is a pure predicate over the demo world the
  // director re-evaluates on every settled faked-engine request (demo-route-signal.ts) and on beat entry,
  // and the walk advances ONLY when it passes: Next nudges with the instruction instead of skipping, so a
  // learner cannot page past the work. `nudge`, when present, replaces the default locked-Next line.
  task?: { label: string; done: () => boolean; nudge?: string };
  // The beat's real documentation link (the training walk links every step to docs.downpipes.io). The
  // nav-bar renders it as a quiet external anchor under the narration; absent on tour beats, whose
  // screens carry their own field-level doc links.
  doc?: { href: string; label: string };
}

// chapterKey is currentChapterId for a chapter already in hand: its route, the stable script id.
function chapterKey(chapter: TourChapter): string {
  return chapter.route;
}

// ctaHrefValid checks that an ending CTA's href would actually resolve (G338). An href that does not parse
// against the tour origin would navigate the demo tab to a broken URL at the moment the prospect decided to
// act. The href is a compile-time constant in the tour scripts; a mis-edit of one is exactly what this catches.
function ctaHrefValid(href: string): boolean {
  if (href.startsWith("mailto:")) return href.length > "mailto:".length;
  try {
    new URL(href, typeof location !== "undefined" ? location.href : "https://tour.downpipes.io");
    return true;
  } catch {
    return false;
  }
}

export interface TourChapter {
  // The SPA route this chapter lives on (a router path, e.g. "/" or "/sources"). The director navigates here
  // before mounting the chapter, so a chapter always lands on the right screen first.
  route: string;
  // The chapter's short title for the nav-bar ("Overview", "Sources"). Rendered as TEXT (never markup).
  title: string;
  // What this chapter is FOR, in one or two short sentences, and why it comes here. The rail keeps it up for
  // every beat of the chapter. A course needs it: a learner who can see only the current step cannot tell
  // what they are doing or why they are doing it, which is what a first learner reported. Absent on the
  // tour, whose chapters are shown rather than worked.
  goal?: string;
  // An optional side effect to run AFTER the chapter's screen has rendered and BEFORE its beats present
  // (e.g. opening a run drawer so a beat can spotlight it). Best-effort: a throw is swallowed so a flourish
  // never breaks the walk. May be async; the director awaits it.
  preAction?: () => void | Promise<void>;
  // An optional world TRANSFORM the training walk applies at this chapter's boundary, BEFORE navigating to
  // its route (the "jump into the future": demo-state.ts advanceWorldDays / injectRunFailure through
  // demo-world.ts applyWorldTransform). Applied at most ONCE per walk however often the chapter re-renders
  // (Back must not advance the world a second month), and only at the boundary, where the navigation
  // forces a fresh render, so no mounted screen holds the pre-jump world. Best-effort like preAction.
  worldTransform?: () => void;
  // The chapter's beats, walked in order. Kept under the historical `infoPoints` name so the chapter
  // scripts and their validators read unchanged.
  infoPoints: ReadonlyArray<InfoPoint>;
  // Optional funnel CTAs the nav-bar renders above its controls (the closing funnel chapter's two deliberate
  // exits). Absent (or empty) on every other chapter, where the nav-bar shows no CTA row. The director maps
  // these onto the nav-bar and wires each click to emit the cta_clicked conversion event.
  ctas?: ReadonlyArray<TourCta>;
  // The one honest line above the CTA pair (the finale's framing). Rendered as TEXT.
  ctaLead?: string;
}

// A funnel call-to-action a chapter may offer (the closing funnel chapter's deliberate exits). It is DATA: the
// visible label, the href (an https docs link or a mailto), and a coarse, fixed `kind` ("deploy" | "support")
// that names the CTA for the analytics conversion event WITHOUT carrying any free text. The closing chapter
// renders these as real anchors in its nav-bar region; the director wires each click to emit a cta_clicked
// event before the browser's own navigation proceeds. Kept on the chapter type so the funnel chapter (added in
// a later stage) carries its exits as data, exactly as the old script did.
export interface TourCta {
  label: string;
  href: string;
  kind: string;
  primary?: boolean;
}

// Guided autoplay dwell scaling (DESIGN: Play reveals the "?"s one at a time, each held long enough to read).
// The per-step dwell is the body length times MS_PER_CHAR, clamped to [MIN_DWELL_MS, MAX_DWELL_MS], so a short
// explanation holds the floor (~6s) and a long one holds proportionally longer, never less than enough to read.
const MS_PER_CHAR = 45;
const MIN_DWELL_MS = 6000;
const MAX_DWELL_MS = 15000;
// A short beat between closing one "?" and opening the next, so the reveal reads as a deliberate step rather
// than a jump-cut.
const STEP_GAP_MS = 700;
// The dwell on a chapter that has NO info-points (the funnel close) before guided autoplay advances/stops.
const EMPTY_CHAPTER_DWELL_MS = 4000;

// SPEECH PACING. Where a walk is narrated, the VOICE is the pace and the reading dwell above is not: the dwell
// is scaled for the eye (45ms a character, capped at 15 seconds) and the same words spoken run about twice as
// long, so a narrated walk paced by the reading dwell talks over itself on nearly every step. The course
// therefore holds each step for as long as its audio actually is, plus a breath, and advances on the voice's
// own end event where the browser gives it.
//
// SPEECH_TAIL_MS is that breath. SPEECH_GUARD_MS is the upper bound the walk holds while the length of a step
// is still unknown: long enough that no real step is cut off (the longest is about 27 seconds), short enough
// that a course whose audio never loads and never errors still moves rather than hanging forever.
const SPEECH_TAIL_MS = 900;
const SPEECH_GUARD_MS = 45000;

// dwellForBody scales a step's hold to its prose length so the visitor has time to read it. An empty body (the
// funnel close, which has no "?"s) uses the dedicated empty-chapter dwell.
function dwellForBody(body: string): number {
  if (body.length === 0) return EMPTY_CHAPTER_DWELL_MS;
  return Math.min(MAX_DWELL_MS, Math.max(MIN_DWELL_MS, body.length * MS_PER_CHAR));
}

// How long the director waits for a chapter's screen to render before mounting its info-points anyway. The
// faked backend is synchronous, so a screen normally paints within a frame; this is the upper bound that keeps
// the tour moving if a screen ever fails to surface its page header, rather than hanging.
const RENDER_TIMEOUT_MS = 4000;

// The poll interval used to await a screen render when MutationObserver is unavailable (the headless test DOM).
// In a real browser the observer fires immediately; this fallback keeps the director correct and testable.
const RENDER_POLL_MS = 50;

// The hook the director waits for to decide a chapter's screen has rendered: the page-header h1 every console
// screen paints via common.ts pageHeader(), OR the onboarding deck's own root (.ob-page), the one full-bleed
// screen with no page header that a walk visits (the training walk's first chapter). Without the second
// selector every visit to the deck sat out the full render timeout and recorded a screen-render-timeout for a
// screen that had painted perfectly well.
const SCREEN_READY_SELECTOR = ".page-header__title, .ob-page";

// The chip the spotlight pins to the lit area on a hands-on step. It is short on purpose: the instruction
// itself is in the rail, and the chip's one job is to say that the rail is talking about THIS place.
const SPOT_TASK_LABEL = "Your task is here";

// The director's public handle. start() runs the chapter script from chapter 0; the rest are the control verbs
// the nav-bar buttons + the keyboard layer call.
export interface TourDirector {
  start(): void;
  next(): void;
  back(): void;
  restart(): void;
  pause(): void;
  play(): void;
  toggleInfo(): void;
  exit(): void;
  resume(): void;
  destroy(): void;
  // The current 0-based chapter index (for a test / a deep link). -1 before start.
  readonly index: number;
}

// Dependencies the director needs, all injectable so the coverage validator can drive it headless with a fake
// navigate + a controllable clock. In production every default is the real console wiring.
export interface DirectorDeps {
  // Navigate the SPA router to a path. Defaults to the console's nav bridge, so a chapter's route change goes
  // through the one router.
  navigate?: (to: string) => void;
  // Clear any registered router leave-guard (a screen's dirty-form veto) before the director navigates. The
  // director's per-chapter navigation is authoritative (the script is the source of truth), so a stale guard
  // left by a free-explore screen must not silently veto it.
  clearLeaveGuard?: () => void;
  // Build the nav-bar. Defaults to the real nav-bar; a test can inject a spy.
  mountNav?: () => NavBar;
  // Build the spotlight stage. Defaults to the real layer; a test can inject a spy.
  mountSpot?: () => Spotlight;
  // Re-seed the deterministic faked world (for Back / Restart). It takes the pinned seed clock the director
  // captured once at start(), so every reseed in a run rebuilds the world against the SAME `now` and is
  // therefore byte-identical. Defaults to demo-world.resetWorld.
  reseed?: (now: number) => void;
  // The document to operate on. Defaults to the ambient document.
  doc?: Document;
  // The upper bound (ms) the director waits for a chapter's screen render, and the poll interval used where
  // MutationObserver is absent. Overridable so a test can drive the async paths quickly.
  renderTimeoutMs?: number;
  renderPollMs?: number;
  // Whether the guided AUTOPLAY controls are offered at all (default true).
  autoplay?: boolean;
  // Whether the walk STARTS playing (default false, the tour: autoplay there is opt-in and a visitor presses
  // Play). A course passes true, because a course that only moves when its learner presses Next reads as a
  // slide deck: the words stop, nothing says why, and the learner is left to work out that a button is owed.
  // Playing, the walk teaches itself and stops only where it means to, which is the hands-on step.
  autoStart?: boolean;
  // Whether the autoplay SPEED cycler is offered (default: with autoplay). A narrated walk passes false,
  // because there the pace is the length of the voice and a multiplier over it would cut the voice off.
  speedControl?: boolean;
  // The guided-autoplay timing, overridable so a test can drive the one-"?"-at-a-time walk fast (production uses
  // the generous defaults). dwellMs maps a step's body to its hold; stepGapMs is the beat between "?"s; settleMs
  // is the beat after a chapter renders before the walk begins.
  dwellMs?: (body: string) => number;
  stepGapMs?: number;
  settleMs?: number;
  // The interval between beatIntoView's scroll-framing retries (8 of them, ~2.5s in production). Overridable so
  // a test can drive the EXHAUSTION branch -- the branch that decides whether an anchor is absent, boxless or
  // merely unframable -- without waiting out the real window.
  beatFrameMs?: number;
  // The mid-tour standing exit (marketing data, threaded by the launcher so the director stays
  // script-agnostic): shown at the rail's chapter-index foot from `fromChapter` (0-based, default 2)
  // until the finale; each click emits cta_clicked with `kind`.
  earlyExit?: { href: string; kind: string; fromChapter?: number };
  // The course NARRATOR (tour/narration.ts), threaded by the launcher so the director stays surface-agnostic.
  // The director tells it which step is now current; the narrator decides whether to speak, remembers the
  // learner's preference and owns the audio element. Absent on the tour, which has no narration.
  narrator?: {
    speak(stepId: string, hooks?: { onDuration?: (ms: number) => void; onEnded?: () => void; onBlocked?: () => void }): void;
    stop(): void;
    enabled(): boolean;
    setEnabled(on: boolean, currentStepId?: string): void;
  };
  // The word on the affordance that brings the guide back after Exit. The tour resumes a tour; a course
  // resumes a course, and a learner who left should read the way back in the course's own words.
  resumeLabel?: string;
}

// createTourDirector builds a director over a chapter script. The script is the typed chapter array (the
// welcome card hands in the single guided walk); the director is the engine that runs any script it is handed.
export function createTourDirector(script: ReadonlyArray<TourChapter>, deps: DirectorDeps = {}): TourDirector {
  const navigate = deps.navigate ?? navBridge;
  const clearLeaveGuard = deps.clearLeaveGuard ?? clearLeaveGuardBridge;
  const mountNav = deps.mountNav ?? (() => mountNavBar(doc));
  const mountSpot = deps.mountSpot ?? (() => createSpotlight(doc));
  const reseed = deps.reseed ?? ((now: number) => resetWorld(now));
  const autoplayOffered = deps.autoplay !== false;
  const autoStart = deps.autoStart === true && autoplayOffered;
  const speedOffered = deps.speedControl ?? autoplayOffered;
  const beatFrameMs = deps.beatFrameMs ?? 320;
  const doc = deps.doc ?? document;
  const renderTimeoutMs = deps.renderTimeoutMs ?? RENDER_TIMEOUT_MS;
  const renderPollMs = deps.renderPollMs ?? RENDER_POLL_MS;
  const dwellMs = deps.dwellMs ?? dwellForBody;
  const stepGapMs = deps.stepGapMs ?? STEP_GAP_MS;
  const settleMs = deps.settleMs ?? 400;

  let navBar: NavBar | null = null;
  let spot: Spotlight | null = null;
  // The beat framer (beat-framing.ts): the geometry half of presenting a beat, reading back only the four
  // facts below so the state machine here stays the one owner of chapter/beat/token/playing.
  const framer = createBeatFramer({
    doc,
    frameMs: beatFrameMs,
    alive: () => !destroyed,
    token: () => renderToken,
    chapterId: () => currentChapterId(),
    navRect: () => navBar?.root?.getBoundingClientRect?.(),
    setBottomSlack: (px: number) => setTourBottomSlack(px),
  });
  let idx = -1;
  // currentChapterId names the chapter a degradation event belongs to (G338). The chapter's ROUTE is its stable
  // id: it is a fixed product vocabulary written by the tour scripts (a router path like "/sources"), never a
  // title a copy edit will move and never anything a visitor typed.
  const currentChapterId = (): string => script[idx]?.route ?? "unknown";

  // G338 (R2): hand the drift recorder THIS script's vocabulary, so a degradation event can carry a chapter
  // route or a beat anchor only if the running script actually contains it. Anything else is dropped whole at
  // the emitter. The convention that every call site passes a script constant is thereby made a boundary: a
  // future caller who reached for an exception message or a value off the page would emit the stage and nothing
  // else. "unknown" (the out-of-range fallback above) is deliberately not a member, so it is dropped too.
  registerTourVocabulary(
    script.map((c) => c.route),
    script.flatMap((c) => c.infoPoints.map((p) => p.anchor)),
  );
  // The 0-based beat within the current chapter (the beat model's inner cursor), and where a chapter
  // change should enter: Back into a prior chapter lands on its LAST beat, so the walk reverses
  // beat-perfectly rather than restarting the chapter.
  let beatIdx = 0;
  let pendingEntry: "first" | "last" = "first";
  // The teardown for the current try-it beat's real-click observer (one at a time; cleared on every
  // beat change / pause / exit so a stale listener never advances a superseded walk).
  let interactCleanup: (() => void) | null = null;
  // The wall clock captured ONCE when a fresh run begins (start/restart), then threaded into EVERY reseed of
  // that run, so Back/Restart rebuild the world byte-identically to the forward pass (resetWorld derives every
  // absolute time from `now`). A fresh run re-captures it, so the demo still reads as "just now"-ish each time.
  let seedClock = Date.now();
  let playing = false; // guided autoplay is opt-in: default MANUAL (the visitor drives with Back/Next)
  // THE CURRENT BEAT'S SPEECH, and it is the pace. speechPaceMs is how long this step's audio actually is,
  // once the browser has read it; speechSilent says the course will not speak this step at all (the learner
  // muted it, the browser refused, the file would not load), which hands the pace back to the reading dwell.
  // stepClosed makes the end of a step happen ONCE however it arrived: the voice ending and the hold expiring
  // are two signals for one event, and without the latch a step could advance twice.
  let speechPaceMs: number | null = null;
  let speechSilent = true;
  let stepClosed = false;
  // The visitor's reading pace for the guided autoplay (reading-speed.ts): a per-step dwell multiplier they
  // cycle so they get more or less time to read, remembered across chapters and reloads.
  const readingSpeed = createReadingSpeed();
  let dwellTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  // A monotonically increasing token so a late async chapter render (an awaited screen that resolves after the
  // visitor has already pressed Next/Back) is dropped instead of mounting a stale chapter over the current one.
  let renderToken = 0;
  let keyHandler: ((ev: KeyboardEvent) => void) | null = null;
  let resumeButton: HTMLElement | null = null;
  // The element that held focus when the guide was first mounted (the control the visitor launched the tour
  // from). Captured BEFORE the director moves focus into the nav-bar, so destroy() can hand focus back to where
  // the visitor was, rather than stranding them at <body> (WCAG 2.4.3). Never the guide's own chrome.
  let launchEl: HTMLElement | null = null;
  let destroyed = false;
  // True once a drop has been counted for this run (Exit, or the page unloading), so the funnel never
  // double-counts a single departure. Reset by start/restart.
  let dropCounted = false;
  let unloadHandler: (() => void) | null = null;
  // The pending advance a passed grader scheduled, held so clearTask can cancel it.
  let taskAdvanceTimer: ReturnType<typeof setTimeout> | null = null;
  // The current TASK beat's route-signal subscription disposer (the training walk's grader re-evaluation),
  // torn down on every beat change exactly like interactCleanup, so a stale grader can never advance a
  // superseded walk.
  let taskCleanup: (() => void) | null = null;
  // The chapter indexes whose worldTransform has ALREADY run this walk: a jump applies at most once
  // however often its chapter re-renders (Back must not advance the world a second month). Reset by
  // start/restart, so a fresh walk jumps afresh.
  const transformsApplied = new Set<number>();
  // True while a chapter render is IN FLIGHT (renderChapter entered, entry beat not yet presented).
  // next()/back() are no-ops in that window: they would read the PREVIOUS chapter's beat index against
  // the NEW chapter's beats, and a beatIdx past the new chapter's last beat makes next() cross straight
  // into the chapter after it, skipping every beat AND every task gate between: a Next landing during a
  // chapter's render can skip its token task entirely.
  let chapterRendering = false;

  // clearTimers cancels any pending autoplay dwell + screen-render poll, so a control press never leaves a stale
  // timer that fires into a superseded chapter.
  function clearTimers(): void {
    if (dwellTimer !== null) { clearTimer(dwellTimer); dwellTimer = null; }
    if (pollTimer !== null) { clearTimer(pollTimer); pollTimer = null; }
  }

  // navTo is the director's authoritative navigation to a chapter's route. nav.ts silently DROPS a navigate when
  // a leave-guard is registered (a dirty-form veto), so a guard left by a free-explore screen after Exit could
  // otherwise veto the director's per-chapter nav on Resume, leaving the SPA on the wrong screen while the guide
  // points at a different chapter. The script is the source of truth, so the director clears any such guard
  // FIRST, then navigates, so the navigation always lands.
  function navTo(route: string): void {
    clearLeaveGuard();
    navigate(route);
  }

  // screenReady reports whether the chapter's screen has surfaced its page header within the main region (or the
  // document, as a fallback for a header outside #main). Never throws.
  function screenReady(): boolean {
    const scope = doc.getElementById("main") ?? doc.body ?? doc;
    try {
      return (scope.querySelector(SCREEN_READY_SELECTOR) ?? doc.querySelector(SCREEN_READY_SELECTOR)) !== null;
    } catch {
      return false;
    }
  }

  // awaitScreen resolves once the chapter's screen has rendered (its page header is present), or after the
  // render timeout regardless (so the info-points mount against whatever is there rather than the tour hanging).
  // It uses MutationObserver when available (a real browser: the screen paints within a frame and the observer
  // fires at once) and falls back to a setTimeout poll where MutationObserver is absent (the headless test DOM).
  function awaitScreen(): Promise<void> {
    if (screenReady()) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const deadline = Date.now() + renderTimeoutMs;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        observer?.disconnect();
        if (pollTimer !== null) { clearTimer(pollTimer); pollTimer = null; }
        // G338: the tour proceeds either way (a hung tour is worse than a mistimed one), so a screen that never
        // painted has always been indistinguishable from one that painted instantly: the chapter then narrates
        // over a BLANK OR WRONG screen and nobody but a human replaying the tour ever knows. finish() is reached
        // on both paths, so the readiness is re-checked HERE to tell them apart.
        if (!screenReady()) noteTourDegraded("screen-render-timeout", currentChapterId());
        resolve();
      };
      const MO = (typeof globalThis !== "undefined" ? (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver : undefined);
      const observer = typeof MO === "function"
        ? new MO(() => {
            if (screenReady() || Date.now() >= deadline) finish();
          })
        : null;
      if (observer) {
        const rootNode = doc.getElementById("main") ?? doc.body;
        if (rootNode) observer.observe(rootNode, { childList: true, subtree: true });
      }
      // The poll runs in BOTH modes: it is the sole mechanism without MutationObserver, and the timeout guard
      // with it. It re-checks readiness + the deadline on each tick.
      const poll = (): void => {
        if (screenReady() || Date.now() >= deadline) { finish(); return; }
        pollTimer = setTimeout(poll, renderPollMs);
      };
      pollTimer = setTimeout(poll, renderPollMs);
    });
  }

  // readingSpeedMul / readingSpeedLabel read the current pace (reading-speed.ts owns the options, the storage
  // and the cycle); dwellMul scales each step's dwell by the inverse of the visible label, so a higher speed
  // is a shorter hold.
  function readingSpeedMul(): number { return readingSpeed.mul(); }
  function readingSpeedLabel(): string { return readingSpeed.label(); }
  // cycleReadingSpeed advances to the next pace, repaints the nav control and announces it. It takes effect on
  // the NEXT step (the current dwell is already armed), so a mid-step change never jolts the bar.
  function cycleReadingSpeed(): void {
    const label = readingSpeed.cycle();
    navBar?.setSpeed(label);
    navBar?.announce(`Autoplay speed ${label}`);
  }

  // controlsFor builds the nav control handlers for the CURRENT beat position, offering only the
  // controls that do something here (the rail renders only offered controls): Back once there is
  // anywhere back to go (an earlier beat or chapter); Next, Play/Pause and the reading-speed cycler
  // until the very last beat of the last chapter (where there is nothing left to walk); Exit always.
  function controlsFor(): Parameters<NavBar["setControls"]>[0] {
    const beats = script[idx]?.infoPoints ?? [];
    const atEnd = idx >= script.length - 1 && beatIdx >= beats.length - 1;
    return {
      onBack: idx > 0 || beatIdx > 0 ? () => back() : undefined,
      onNext: !atEnd ? () => next() : undefined,
      onPlay: autoplayOffered && !atEnd ? () => play() : undefined,
      onPause: autoplayOffered && !atEnd ? () => pause() : undefined,
      onExit: () => exit(),
      ...(deps.narrator
        ? {
            onToggleSound: (): void => {
              const now = !deps.narrator!.enabled();
              deps.narrator!.setEnabled(now, narrationStepId(idx, beatIdx));
              navBar?.setControls(controlsFor());
              // The panel's phone default depends on this: a hands-on step hands the screen back while the
              // course is speaking, and takes it back the moment it is not.
              const b = script[idx]?.infoPoints[beatIdx];
              navBar?.refreshBeatDefault(b?.task !== undefined && now);
              navBar?.announce(now ? "Narration on." : "Narration off. Every step is still written on this panel.");
            },
            soundOn: deps.narrator.enabled(),
          }
        : {}),
      onCycleSpeed: speedOffered && autoplayOffered && !atEnd ? () => cycleReadingSpeed() : undefined,
      speedLabel: readingSpeedLabel(),
    };
  }

  // renderChapter walks to the chapter at `idx`: navigate, await the screen render, run the optional preAction,
  // mount the chapter's info-points and update the nav-bar, announce, then arm the autoplay dwell (unless paused
  // or already on the last chapter). `moveFocus` says whether to pull keyboard focus onto the nav-bar: true on a
  // USER-DRIVEN chapter change (start / Next / Back / Restart / Resume), false on an autoplay auto-advance.
  // Seizing focus on every autoplay tick would yank a keyboard or screen-reader user (who may be reading the
  // page, which the non-blocking guide invites) back onto the bar every few seconds (WCAG 2.4.3 / 3.2.x); the
  // polite live region carries each auto-advanced chapter to assistive tech WITHOUT moving focus.

  // clearInteract tears down the current try-it beat's real-click observer (a beat change, a pause,
  // an exit), so a stale listener can never advance a superseded walk.
  function clearInteract(): void {
    interactCleanup?.();
    interactCleanup = null;
  }

  // clearTask tears down the current task beat's grader subscription AND any advance it has already
  // scheduled, the task twin of clearInteract. The pending advance matters: a grader that passes arms a
  // short pause so the learner sees their work acknowledged, and a learner who presses Next inside that
  // pause would otherwise be carried two steps, one by their press and one by the timer nobody cancelled.
  function clearTask(): void {
    taskCleanup?.();
    taskCleanup = null;
    if (taskAdvanceTimer !== null) { clearTimer(taskAdvanceTimer); taskAdvanceTimer = null; }
  }

  // taskBlocksAdvance reports whether the CURRENT beat is a task the learner has not completed. The one
  // gate next() consults: a task beat's grader must pass before the walk moves, however the advance was
  // asked for (Next, ArrowRight, or an autoplay dwell). A grader fault reads as NOT blocking (fail-open:
  // a broken grader must not brick the walk; the robot learner asserts the graders themselves).
  function taskBlocksAdvance(): boolean {
    const b = script[idx]?.infoPoints[beatIdx];
    if (!b?.task) return false;
    try {
      return !b.task.done();
    } catch {
      return false;
    }
  }

  // armTask subscribes the current task beat's grader to the demo-route signal: after every settled faked
  // request the grader re-evaluates over the mutated world, and on a pass the walk advances a moment
  // later, exactly like a try-it click (the pause lets the console's own response paint first). Evaluated
  // once on arm too, so a task the world already satisfies (a Back onto a finished step) never re-locks.
  function armTask(beat: InfoPoint): void {
    clearTask();
    const task = beat.task;
    if (!task) return;
    const token = renderToken;
    const advance = (): void => {
      if (!destroyed && token === renderToken) next(playing);
    };
    // `arrival` is true only for the evaluation the beat is ENTERED with, and the difference is what makes
    // Back work. A task whose grader already passes on arrival is a step the learner finished earlier, so
    // the card reads as complete and NOTHING advances: walking back onto a completed step used to re-arm
    // the grader, see it pass at once, and throw the learner forward again, which made every stage they had
    // finished impossible to return to.
    const evaluate = (arrival: boolean): void => {
      if (destroyed || token !== renderToken) { clearTask(); return; }
      let passed = false;
      try {
        passed = task.done();
      } catch {
        return; // a grader fault on this signal: stay armed, the next signal re-evaluates
      }
      if (!passed) return;
      clearTask();
      // The learner's action just landed: flip the task card to DONE so the link between what they did on
      // the screen and the course beside it is VISIBLE, then advance after the same beat a try-it takes.
      navBar?.markTaskDone(arrival ? "already-done" : "just-done");
      if (arrival) return;
      // A learner who works ahead of the voice: the course is still explaining this step and they have
      // already done it. The card says so at once, and the walk lets the sentence finish rather than cutting
      // the voice off mid-word. closeStep then advances on its own, because the gate no longer blocks.
      if (playing && !stepClosed) return;
      if (typeof setTimeout === "function") taskAdvanceTimer = setTimeout(() => { taskAdvanceTimer = null; advance(); }, 900);
      else advance();
    };
    taskCleanup = onDemoRoute(() => evaluate(false));
    evaluate(true);
  }

  // armInteract watches for a GENUINE click on the try-it beat's anchored control (capture phase, so
  // it observes without interfering), then advances the walk a moment later, after the console has
  // visibly responded. The control's own handler runs untouched: the observer never preventDefaults,
  // and the faked engine makes the action safe and reversible.
  function armInteract(beat: InfoPoint): void {
    clearInteract();
    const token = renderToken;
    const onClick = (ev: Event): void => {
      if (destroyed || token !== renderToken) { clearInteract(); return; }
      const t = ev.target as Element | null;
      if (!t || typeof t.closest !== "function") return;
      if (!t.closest(`[data-tour-id="${beat.anchor}"]`)) return;
      clearInteract();
      // Advance as AUTO when autoplay performed the click itself (an autoplay advance never seizes
      // keyboard focus); a hands-on click while paused is user-driven and may move focus to the guide.
      const advance = (): void => { if (!destroyed && token === renderToken) next(playing); };
      if (typeof setTimeout === "function") setTimeout(advance, 900);
      else advance();
    };
    doc.addEventListener("click", onClick, true);
    interactCleanup = () => doc.removeEventListener("click", onClick, true);
  }

  // presentBeat paints the CURRENT beat: the rail narration (step position, title, body, try-it
  // invitation), the spotlight on the beat's anchor (pulsing on a try-it), the controls for this
  // position, the scroll framing, and the polite announcement (the live region carries the ACTUAL
  // narration, so assistive tech hears the story, not a hint to go hunting). A chapter with no beats
  // (the funnel close) clears the reading area and the spotlight; its CTAs carry the message.
  function presentBeat(moveFocus: boolean): void {
    if (destroyed || !navBar) return;
    clearInteract();
    clearTask();
    const chapter = script[idx];
    if (!chapter) return;
    const beats = chapter.infoPoints;
    const b = beats[beatIdx];
    navBar.update(chapter.title, idx + 1, script.length);
    navBar.setChapters(script.map((c) => c.title), idx);
    navBar.setControls(controlsFor());
    navBar.setPlaying(playing);
    // The chapter's goal stands for every beat of it, so it is set here rather than per beat.
    navBar.setGoal(chapter.goal ?? null);
    if (!b) {
      navBar.setBeat(null);
      spot?.target(null);
      navBar.announce(`${chapter.title}. Chapter ${idx + 1} of ${script.length}.`);
      if (moveFocus) navBar.focusBar();
      return;
    }
    // Where the hands-on step of THIS chapter sits, so the rail can say how far it is from here. A chapter
    // with no task passes nothing and the rail prints the plain counter.
    const taskStep = beats.findIndex((x) => x.task !== undefined);
    navBar.setBeat({
      index: beatIdx,
      count: beats.length,
      title: b.title,
      body: b.body,
      tryIt: b.interact?.label,
      task: b.task?.label,
      docHref: b.doc?.href,
      docLabel: b.doc?.label,
      ...(taskStep >= 0 ? { taskAtStep: taskStep + 1 } : {}),
      // On a phone a hands-on step gives the console back when the course is speaking: the voice carries the
      // instruction and the learner needs the screen. Muted, the panel stays where it is, because the text is
      // then the only instruction there is.
      handBackScreen: b.task !== undefined && deps.narrator?.enabled() === true,
    });
    // The lit area gets a chip on a hands-on step. Without it the learner sees a rectangle light up and a
    // paragraph appear, and nothing says the two are about the same thing.
    spot?.target(b.anchor, {
      pulse: b.interact !== undefined || b.task !== undefined,
      ...(b.task !== undefined ? { label: SPOT_TASK_LABEL } : {}),
    });
    framer.frame(b, renderToken, 0);
    // ONE composer for what this beat SAYS (narration-text.ts): the audio the course speaks and the hash the
    // narration gate holds that audio to are narrationTextFor; the live region a screen reader hears is that
    // same string with the heading in front of it, because a learner who cannot see the card needs the
    // heading said and a learner listening to the voice does not.
    navBar.announce(announcementTextFor(b));
    // And the course reads the step aloud, unless the learner has turned that off. The three hooks are how the
    // walk PACES ITSELF BY THE VOICE: how long this step is, when it finished, and whether it will be spoken
    // at all. A walk with no narrator (the tour) keeps the reading dwell, which is what its dwell was written
    // for.
    speechPaceMs = null;
    speechSilent = deps.narrator?.enabled() !== true;
    stepClosed = false;
    const speechToken = renderToken;
    const fresh = (): boolean => !destroyed && speechToken === renderToken;
    deps.narrator?.speak(narrationStepId(idx, beatIdx), {
      onDuration: (ms: number) => {
        if (!fresh()) return;
        speechPaceMs = ms;
        if (playing) armAutoDwell();
      },
      onEnded: () => {
        if (!fresh() || !playing) return;
        closeStep();
      },
      onBlocked: () => {
        if (!fresh()) return;
        speechSilent = true;
        if (playing) armAutoDwell();
      },
    });
    if (b.interact) armInteract(b);
    if (b.task) armTask(b);
    if (moveFocus) navBar.focusBar();
  }

  function renderChapter(moveFocus: boolean): void {
    if (destroyed || idx < 0 || idx >= script.length || !navBar) return;
    const chapter = script[idx]!;
    const token = ++renderToken;
    chapterRendering = true;
    clearTimers();
    clearInteract();
    clearTask();
    spot?.target(null); // the stage rests while the next screen renders (no stale cutout mid-navigation)
    // The training walk's time jump applies at the chapter BOUNDARY, before the navigation, so the new
    // screen's first render is already over the advanced world, and at most once per walk (Back into a
    // jump chapter must not advance the world again).
    if (chapter.worldTransform && !transformsApplied.has(idx)) {
      transformsApplied.add(idx);
      try {
        chapter.worldTransform();
      } catch {
        noteTourDegraded("world-transform-failed", chapterKey(chapter));
      }
    }
    navTo(chapter.route);
    void awaitScreen().then(async () => {
      // Drop a stale render: the visitor moved on while the screen was rendering.
      if (token !== renderToken || destroyed || !navBar) return;
      // Route verification with a short retry. The setup-first gate (lib/setup-state.ts setupAllows)
      // checks a CACHED view and refreshes it on navigation, so the walk's first navigation into a step
      // the learner just unlocked can be bounced by the stale view while the refresh admits the retry:
      // for example a chapter where an install has flipped keysReady
      // moments earlier, so the director's single navTo is redirected back to the deck. A pathname the
      // environment cannot report (the headless shim) reads as unverifiable and is left alone.
      for (let attempt = 0; attempt < 4; attempt++) {
        let path: string | null = null;
        try {
          path = typeof location.pathname === "string" ? location.pathname : null;
        } catch {
          path = null;
        }
        if (path === null || path === chapter.route || path.startsWith(`${chapter.route}/`)) break;
        navTo(chapter.route);
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (token !== renderToken || destroyed || !navBar) return;
      }
      // The optional side effect (e.g. open a drawer) runs after the screen is up and before the beats
      // present, so a beat can spotlight something the preAction reveals. Best-effort: a throw never
      // breaks the walk.
      if (chapter.preAction) {
        // G338: the pre-action opens the drawer / disclosure the chapter is about to narrate. When it throws, the
        // chapter demonstrates NOTHING and still reads as a clean session in the funnel.
        try { await chapter.preAction(); } catch { noteTourDegraded("preaction-failed", chapterKey(chapter)); }
        if (token !== renderToken || destroyed || !navBar) return;
      }
      // Enter the chapter at the requested beat: first on a forward move, LAST on a Back into a prior
      // chapter, so the walk reverses beat-perfectly.
      const beats = chapter.infoPoints;
      beatIdx = pendingEntry === "last" ? Math.max(0, beats.length - 1) : 0;
      pendingEntry = "first";
      // The closing funnel chapter's deliberate exits render in the nav-bar; every click emits the cta_clicked
      // conversion event (the analytics belong to the director; the bar only renders the anchor + fires
      // onActivate) before the browser's own navigation proceeds. A chapter with no ctas clears the row.
      // G338: the finale CTA is the conversion, and a CTA whose href does not resolve navigates the demo tab to a
      // broken URL at the exact moment the prospect decided to act. The href is checked BEFORE it is rendered,
      // and a bad one is recorded (it is still rendered: hiding the conversion would be a worse failure than a
      // broken link, and the event is what gets it fixed).
      for (const cta of chapter.ctas ?? []) {
        if (!ctaHrefValid(cta.href)) noteTourDegraded("cta-href-invalid", chapterKey(chapter));
      }
      navBar.setCtas((chapter.ctas ?? []).map((cta) => ({
        label: cta.label,
        href: cta.href,
        primary: cta.primary === true,
        onActivate: () => { emit({ name: "cta_clicked", detail: cta.kind, route: chapter.route }); },
      })), chapter.ctaLead);
      // The standing early exit: live from its start chapter until the finale (where the CTA pair
      // takes over). A calm, spatially stable affordance, never a nag.
      const ee = deps.earlyExit;
      navBar.setEarlyExit(
        ee !== undefined && idx >= (ee.fromChapter ?? 2) && idx < script.length - 1
          ? { href: ee.href, onActivate: () => { emit({ name: "cta_clicked", detail: ee.kind, route: chapter.route }); } }
          : null,
      );
      // Count that the visitor reached this chapter (the per-chapter funnel point). Emitted once per painted
      // chapter, AFTER the stale-render guard above, so a dropped late render does not over-count.
      emit({ name: "step_reached", stepIndex: idx, route: chapter.route });
      // Paint the entry beat: the rail narration, the spotlight, the controls, the framing and the polite
      // announcement all come from the one presenter, on the manual and autoplay paths alike. The render
      // window closes here: the entry beat is current, so the verbs operate on coherent state again.
      chapterRendering = false;
      presentBeat(moveFocus);
      // Guided autoplay: if playing, arm the dwell for this beat (a brief settle first, so a scrolled-in
      // section has laid out). Nothing auto-advances when paused (default): the tour never moves on its own.
      navBar.setDwellActive(null);
      if (playing) {
        const startToken = renderToken;
        const begin = (): void => { if (playing && !destroyed && startToken === renderToken) armAutoDwell(); };
        if (typeof setTimeout === "function") setTimeout(begin, settleMs);
        else begin();
      }
    });
  }

  // clearDwell cancels the current step hold/gap timer (a pause, a control press, a chapter change).
  function clearDwell(): void {
    if (dwellTimer !== null) { clearTimer(dwellTimer); dwellTimer = null; }
  }

  // paceForBeat is how long the CURRENT step holds. The voice decides where there is one: a step's audio is
  // its own honest length, and the reading dwell (scaled for the eye) is the pace only for a silent course.
  // While a spoken step's length is still unknown the walk holds on the guard rather than moving under the
  // voice, and the returned `known` says whether the dwell bar may show the hold as a real countdown.
  function paceForBeat(): { ms: number; known: boolean } {
    const b = script[idx]?.infoPoints[beatIdx];
    if (speechPaceMs !== null) return { ms: speechPaceMs + SPEECH_TAIL_MS, known: true };
    if (!speechSilent) return { ms: SPEECH_GUARD_MS, known: false };
    return { ms: Math.round(dwellMs(b?.body ?? "") * readingSpeedMul()), known: true };
  }

  // armAutoDwell holds the CURRENT beat for its pace, then closes the step. Re-armable: the voice reporting
  // its length mid-hold re-arms to the real pace. Guarded so a pause / exit / beat change abandons the stale
  // timer, and inert once the step has already closed (the voice's own end event usually gets there first).
  function armAutoDwell(): void {
    if (!playing || destroyed || !navBar || stepClosed) return;
    clearDwell();
    const stepToken = renderToken;
    const pace = paceForBeat();
    // The dwell bar is honest or it is absent: it never counts down a guard, which is a guess.
    navBar.setDwellActive(pace.known ? pace.ms : null);
    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      if (!playing || destroyed || stepToken !== renderToken) return;
      closeStep();
    }, pace.ms);
  }

  // closeStep runs the end of the current step ONCE, however it arrived (the voice finished, or the hold
  // expired). What happens next is the whole shape of a guided course:
  //
  //   a HANDS-ON step  the course HANDS OVER and stops. Nothing advances, because the learner has work to do
  //                    and the grader is watching for it; armTask picks the walk up again the moment it lands.
  //   a try-it step    autoplay performs the real click, and the interact observer advances after it.
  //   anything else    a short gap, then the next step.
  function closeStep(): void {
    if (!playing || destroyed || stepClosed) return;
    stepClosed = true;
    clearDwell();
    navBar?.setDwellActive(null);
    const stepToken = renderToken;
    const b = script[idx]?.infoPoints[beatIdx];
    if (b?.task && taskBlocksAdvance()) { passControl(b); return; }
    if (b?.interact) {
      const el = doc.querySelector(`[data-tour-id="${b.anchor}"]`) as HTMLElement | null;
      if (el && typeof el.click === "function") {
        try { el.click(); return; } catch { noteTourDegraded("autoplay-click-failed", currentChapterId(), b.anchor); }
      } else {
        // G338: the control the autoplay was to demonstrate is not there. The walk advances anyway (correct: a
        // stuck tour is worse), so the visitor is told about an interaction that never happened, and the funnel
        // records a step_reached exactly as though it had.
        noteTourDegraded("autoplay-click-failed", currentChapterId(), b.anchor);
      }
      // The control is absent (a degraded chapter): fall through to a plain advance.
    }
    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      if (playing && !destroyed && stepToken === renderToken) autoNext();
    }, stepGapMs);
  }

  // passControl is the moment the course stops teaching and the learner starts driving. It is the one place a
  // playing walk deliberately stops, so it says so plainly on the card and to assistive tech, rather than
  // letting the words simply run out and leave the learner wondering whether it broke.
  function passControl(beat: InfoPoint): void {
    navBar?.setDwellActive(null);
    navBar?.handOverTask();
    navBar?.announce(`Now it is your turn. ${beat.task?.label ?? "Do the step on the highlighted part of the console"}. The course starts again by itself as soon as you have.`);
  }

  // autoNext advances the autoplay walk one beat (or one chapter past the last beat), stopping at the
  // very end (back to manual, exactly where the finale's CTAs sit).
  function autoNext(): void {
    if (!playing || destroyed) return;
    const beats = script[idx]?.infoPoints ?? [];
    if (beatIdx < beats.length - 1) {
      beatIdx += 1;
      presentBeat(false);
      armAutoDwell();
      return;
    }
    if (idx >= script.length - 1) { pause(); return; }
    next(true);
  }

  // setDemoBannerHidden display-toggles the floating "Demo. Sample data." pill (banner.ts #tour-demo-banner):
  // it docks bottom-centre, exactly where the guide's nav-bar sits, so while the guide is mounted the pill is
  // hidden (the top-right DEMO corner pill keeps the honesty label the whole time) and Exit/destroy restore it
  // for free-explore. Display only, never removed: the banner module owns its lifecycle.
  function setDemoBannerHidden(hidden: boolean): void {
    const banner = doc.getElementById("tour-demo-banner");
    banner?.style.setProperty("display", hidden ? "none" : "flex");
  }

  // On a phone the bottom guide panel is tall (~30% of the viewport), so a beat whose anchor sits low on the
  // page cannot be scrolled above it (there is nothing below it to scroll into). While the guide runs on a
  // phone the tour adds temporary bottom slack to the document so beatIntoView can lift ANY anchor into the
  // stage above the panel; it is sized from the measured panel height and cleared on Exit / destroy.
  function setTourBottomSlack(px: number): void {
    doc.body?.style.setProperty("padding-bottom", px > 0 ? `${Math.round(px)}px` : "");
  }

  // ensureGuide mounts the nav-bar + info-points + wires the keyboard layer + the page-teardown drop listener if
  // not already up (start / resume).
  function ensureGuide(): void {
    captureLaunchFocus();
    if (!navBar) navBar = mountNav();
    if (!spot) spot = mountSpot();
    wireKeys();
    wireUnload();
    hideResumeButton();
    setDemoBannerHidden(true);
  }

  // wireKeys installs the global keyboard layer while the guide is shown: ArrowRight / Enter advance, ArrowLeft
  // goes back, Space toggles play/pause, Escape exits. Re-entrant-safe: only one handler is ever bound.
  //
  // WCAG 2.1.4 (Character Key Shortcuts): Space is a single PRINTABLE character bound document-wide, so it is
  // gated on singleKeyShortcutsEnabled() exactly as the shell's own key layer gates "/" and the g-chords. Arrow /
  // Enter / Escape are exempt non-character keys and stay unconditional. Operability is preserved either way:
  // the nav-bar's Pause and Exit are always one Tab and Enter away.
  function wireKeys(): void {
    if (keyHandler) return;
    keyHandler = (ev: KeyboardEvent): void => {
      if (destroyed || !navBar) return;
      // Never hijack typing into a field (the visitor exploring a form): ignore keys when focus is in an
      // input/textarea/select/contenteditable.
      if (isTypingTarget(ev.target)) return;
      switch (ev.key) {
        case "ArrowRight":
        case "Enter":
          ev.preventDefault();
          next();
          break;
        case "ArrowLeft":
          ev.preventDefault();
          back();
          break;
        case " ":
        case "Spacebar":
          if (!singleKeyShortcutsEnabled()) break;
          ev.preventDefault();
          if (playing) pause();
          else play();
          break;
        case "Escape":
          ev.preventDefault();
          exit();
          break;
        default:
          break;
      }
    };
    doc.addEventListener("keydown", keyHandler as EventListener);
  }

  // unwireKeys removes the keyboard layer (on Exit / destroy), so the keys are inert in free-explore mode.
  function unwireKeys(): void {
    if (keyHandler) {
      doc.removeEventListener("keydown", keyHandler as EventListener);
      keyHandler = null;
    }
  }

  // wireUnload installs a pagehide listener that counts a drop_step if the visitor closes or navigates away while
  // the guide is still showing (the funnel-leak metric this design tracks). pagehide is the reliable page-teardown
  // signal (close, reload, bfcache), and a beacon survives it (analytics.emit prefers navigator.sendBeacon).
  // Wired while the guide is up; removed on Exit/destroy. Re-entrant-safe. A view with no window skips it.
  function wireUnload(): void {
    if (unloadHandler) return;
    const win = (typeof window !== "undefined" ? window : undefined) as (Window & typeof globalThis) | undefined;
    if (!win || typeof win.addEventListener !== "function") return;
    unloadHandler = (): void => {
      if (destroyed) return;
      countDrop("unload");
    };
    win.addEventListener("pagehide", unloadHandler);
  }

  // unwireUnload removes the page-teardown listener (on Exit/destroy), so a later unload in free-explore (the
  // guide already gone) does not count a second drop.
  function unwireUnload(): void {
    if (unloadHandler) {
      const win = (typeof window !== "undefined" ? window : undefined) as (Window & typeof globalThis) | undefined;
      win?.removeEventListener("pagehide", unloadHandler);
      unloadHandler = null;
    }
  }

  // countDrop emits the drop_step funnel event exactly once per run (the dropCounted guard), tagged with the
  // chapter the visitor was on and a coarse reason ("exit" / "unload"). Best-effort + behind the flag inside emit().
  function countDrop(reason: string): void {
    if (dropCounted) return;
    dropCounted = true;
    const onChapter = idx >= 0 && idx < script.length;
    emit(onChapter ? { name: "drop_step", stepIndex: idx, route: script[idx]!.route, detail: reason } : { name: "drop_step", stepIndex: idx, detail: reason });
  }

  // showResumeButton mounts a single small, fixed "Resume tour" affordance after Exit, so the visitor can bring
  // the guide back at the chapter they left (DESIGN: free-explore with a one-tap return). It is a real button,
  // keyboard reachable, tokenised, and removed on resume.
  function showResumeButton(): void {
    if (resumeButton) return;
    const body = doc.body;
    if (!body) return;
    const btn = h(
      "button",
      {
        type: "button",
        id: "tour-resume",
        class: "btn btn--primary",
        "aria-label": deps.resumeLabel ?? "Resume tour",
        dataset: { frontLayer: "true" }, // see persona-fork.ts's card: a --z-palette layer tokens.css lifts a confirm above
        style: ["position:fixed", "right:var(--space-4)", "bottom:var(--space-6)", "z-index:var(--z-palette)", "display:inline-flex", "align-items:center", "gap:var(--space-2)", "box-shadow:var(--shadow-lg)", "pointer-events:auto"].join(";"),
        on: { click: () => resume() },
      },
      h("span", { "aria-hidden": "true", style: "display:inline-flex" }, svgIcon(ICON_PLAY, { size: 14 })),
      h("span", deps.resumeLabel ?? "Resume tour"),
    );
    body.appendChild(btn);
    resumeButton = btn;
  }

  // hideResumeButton removes the resume affordance (on resume / destroy).
  function hideResumeButton(): void {
    resumeButton?.remove();
    resumeButton = null;
  }

  // captureLaunchFocus remembers the element that holds focus the moment the guide is first shown (the control
  // the visitor pressed to start the tour), so destroy() can return focus there instead of stranding a keyboard
  // user at <body>. Called from ensureGuide/resume BEFORE focus is moved onto the nav-bar. It never captures the
  // guide's own chrome or the Resume button, and only captures once per launch.
  function captureLaunchFocus(): void {
    if (launchEl) return;
    const active = doc.activeElement as HTMLElement | null;
    if (!active || active === doc.body) return;
    if (active.closest?.("#tour-nav-bar, #tour-resume, #tour-spotlight")) return;
    launchEl = active;
  }

  // focusEl moves keyboard focus to an element if it is still focusable and connected, so the focus path stays
  // continuous (Exit -> the Resume button; destroy -> the launch control). Guards a headless DOM / a detached node.
  function focusEl(el: HTMLElement | null): void {
    if (!el || typeof el.focus !== "function") return;
    if ("isConnected" in el && el.isConnected === false) return;
    try {
      el.focus();
    } catch {
      // A DOM hiccup restoring focus must never break the teardown; the visitor keeps the browser default.
    }
  }

  // ---- the public control verbs ----

  function start(): void {
    if (destroyed) return;
    ensureGuide();
    // The tour is opt-in and starts paused; a course starts playing, so it teaches from the first step
    // without being asked to.
    playing = autoStart;
    dropCounted = false; // a fresh run: a later Exit/unload counts a drop again
    // Pin the seed clock ONCE for this run, then reseed against it (Back/Restart reuse this exact `now`).
    seedClock = Date.now();
    reseed(seedClock);
    transformsApplied.clear(); // a fresh walk jumps afresh
    idx = 0;
    pendingEntry = "first";
    renderChapter(true);
  }

  // next advances one BEAT, crossing into the next chapter past the last beat. `auto` is true only when the
  // autoplay path advances; every operator entry (the Next button, ArrowRight/Enter) calls it with no
  // argument. A user-driven Next moves focus onto the guide; an autoplay auto-advance does not.
  function next(auto = false): void {
    if (destroyed || idx < 0 || chapterRendering) return;
    // A task beat gates every advance path until its grader passes: the training walk's whole promise is
    // that progress is earned by doing, so Next (and an autoplay dwell) nudges instead of skipping. The
    // nudge narrates the instruction, so a keyboard or screen-reader learner hears WHY nothing moved.
    if (taskBlocksAdvance()) {
      if (!auto) {
        const t = script[idx]?.infoPoints[beatIdx]?.task;
        const why = t?.nudge ?? `Finish this step first: ${t?.label ?? "complete the task on screen"}.`;
        // Both halves of the refusal: the live region for assistive tech, and the card itself for the
        // learner who just pressed a button and watched nothing happen.
        navBar?.announce(why);
        navBar?.nudgeTask(why);
      }
      return;
    }
    const beats = script[idx]?.infoPoints ?? [];
    if (beatIdx < beats.length - 1) {
      beatIdx += 1;
      clearDwell();
      navBar?.setDwellActive(null);
      presentBeat(!auto);
      if (playing) armAutoDwell();
      return;
    }
    if (idx >= script.length - 1) return; // the very end: nothing forward
    idx += 1;
    pendingEntry = "first";
    renderChapter(!auto);
  }

  // back steps one BEAT; from a chapter's first beat it re-seeds the deterministic world and re-renders the
  // prior chapter at its LAST beat, so the walk reverses beat-perfectly. Re-seeding keeps Back byte-identical
  // to the forward pass (a try-it beat's simulated write is unwound). From the very first beat there is
  // nowhere to go back to.
  function back(): void {
    if (destroyed || !navBar || chapterRendering) return;
    if (beatIdx > 0) {
      beatIdx -= 1;
      clearDwell();
      navBar.setDwellActive(null);
      presentBeat(true);
      if (playing) armAutoDwell();
      return;
    }
    if (idx <= 0) return;
    clearTimers();
    reseed(seedClock);
    idx -= 1;
    pendingEntry = "last";
    renderChapter(true);
  }

  function restart(): void {
    if (destroyed) return;
    ensureGuide();
    clearTimers();
    playing = autoStart;
    dropCounted = false;
    seedClock = Date.now();
    reseed(seedClock);
    transformsApplied.clear();
    idx = 0;
    pendingEntry = "first";
    renderChapter(true);
  }

  function pause(): void {
    if (destroyed) return;
    playing = false;
    clearDwell();
    // Stop the guided walk and return to manual: hide the dwell bar, flip the toggle.
    navBar?.setDwellActive(null);
    navBar?.setPlaying(playing);
    navBar?.setControls(controlsFor());
    navBar?.announce(autoStart ? "Paused. Use Back and Next to move at your own pace." : "Tour paused. Use Back and Next to read at your own pace.");
  }

  function play(): void {
    if (destroyed || !autoplayOffered) return;
    playing = true;
    navBar?.setPlaying(playing);
    navBar?.setControls(controlsFor());
    navBar?.announce(autoStart ? "Playing. The course moves on by itself, and waits at every step you have to do yourself." : "Guided tour playing. Each step holds while you read, then moves on.");
    // Play DOES something immediately: arm the hold on the current beat. A step already closed (a learner who
    // paused on a hands-on step and pressed play again) is handed over rather than re-held.
    if (stepClosed) {
      const b = script[idx]?.infoPoints[beatIdx];
      if (b?.task && taskBlocksAdvance()) { passControl(b); return; }
      stepClosed = false;
    }
    armAutoDwell();
  }

  // toggleInfo is retired by the beat model (the rail always narrates; there are no markers to hide). The verb
  // stays on the interface as a benign no-op so an old deep integration cannot throw.
  function toggleInfo(): void {
    /* retired: the rail narrates every beat */
  }

  // exit drops the guide and the keyboard layer, leaving the visitor in the real, faked app to click anywhere,
  // and shows the one-tap Resume affordance. The world is NOT re-seeded (the visitor keeps exploring from where
  // the tour left it); a later Restart re-seeds.
  function exit(): void {
    if (destroyed) return;
    deps.narrator?.stop();
    clearTimers();
    clearInteract();
    clearTask();
    countDrop("exit");
    // Invalidate any in-flight render so a late resolve does not paint after the guide is gone.
    renderToken++;
    unwireKeys();
    unwireUnload();
    spot?.destroy();
    spot = null;
    navBar?.destroy();
    navBar = null;
    setDemoBannerHidden(false); // the guide's nav-bar is gone, so the honesty pill takes the bottom band back
    setTourBottomSlack(0); // release the phone scroll slack the guide added
    showResumeButton();
    // Destroying the nav-bar removed the control that may have held focus, so move focus onto the freshly mounted
    // Resume button so the keyboard path is continuous (WCAG 2.4.3).
    focusEl(resumeButton);
  }

  // resume re-mounts the guide and re-renders the current chapter (or chapter 0 if the visitor exited before
  // start), bringing the walk back exactly where they left it. It does not re-seed.
  function resume(): void {
    if (destroyed) return;
    hideResumeButton();
    navBar = mountNav();
    spot = mountSpot();
    wireKeys();
    wireUnload();
    setDemoBannerHidden(true); // the guide's nav-bar retakes the bottom band from the honesty pill
    dropCounted = false;
    if (idx < 0) idx = 0;
    renderChapter(true);
  }

  // destroy is the hard teardown (leaving the tour entirely): cancel timers, drop the guide, the keyboard layer
  // and the resume button, and freeze the verbs.
  function destroy(): void {
    deps.narrator?.stop();
    clearTimers();
    clearInteract();
    clearTask();
    renderToken++;
    unwireKeys();
    unwireUnload();
    spot?.destroy();
    spot = null;
    navBar?.destroy();
    navBar = null;
    setDemoBannerHidden(false);
    setTourBottomSlack(0); // release the phone scroll slack the guide added
    hideResumeButton();
    destroyed = true;
    // Hand keyboard focus back to the control the visitor launched the tour from (WCAG 2.4.3).
    focusEl(launchEl);
    launchEl = null;
  }

  return {
    start, next, back, restart, pause, play, toggleInfo, exit, resume, destroy,
    get index(): number { return idx; },
  };
}

// clearTimer cancels a timer id from either setTimeout family (the return type differs between the browser and
// node typings, so this narrows the call site once).
function clearTimer(id: ReturnType<typeof setTimeout>): void {
  clearTimeout(id);
}

// isTypingTarget reports whether an event target is a text-entry control, so the keyboard layer never hijacks
// keys the visitor is typing into a field. It duck-types on tagName / isContentEditable rather than `instanceof
// Element`, so it does not depend on a global Element constructor and reads the same in the browser and a
// headless DOM.
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}
