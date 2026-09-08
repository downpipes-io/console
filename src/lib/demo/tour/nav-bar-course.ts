// The COURSE parts of the guide rail: the pieces that exist only when the rail is running a training course
// rather than the marketing tour (the eyebrow that names the course, the standing GOAL line that says what
// this stage is for and why, and the TASK CARD that carries the hands-on instruction and visibly acknowledges
// the learner's action). They live here rather than in nav-bar.ts for two reasons: the rail is a large module
// already, and these parts are the ones a course owns end to end, so the seam is the surface, not the widget.
//
// The whole reason the task card exists is the link between the two halves of the screen. A learner reported
// the rail reading as "a text box on the side, not linked" to the console beside it: the course said things
// and the console did things and nothing joined them. The card is the join. It states the task as a task,
// says where on the screen to do it (the spotlight is aimed there), and flips to DONE the moment the grader
// sees the learner's action land, before the walk moves.
//
// CSP: every style is applied per-property through the h() builder's CSSOM path, never an inline style
// attribute or a <style> block, exactly as the rest of the guide chrome is, so this runs under the console's
// strict style-src 'self'.
//
// House rules: Australian English, no em dashes, no rule-of-three, precise claims.

import { h, svgIcon } from "../../dom.ts";
import { ICON_CHEVRON_DOWN, ICON_CHEVRON_UP } from "../../icons.ts";

// How the task card acknowledges a pass. "just-done" is the learner's action landing NOW (the chip flips and
// the walk advances a beat later); "already-done" is arriving on a step the learner finished earlier (a Back
// into a completed stage), where the card must read as complete and NOTHING may advance.
export type TaskDoneMode = "just-done" | "already-done";

// A funnel call-to-action the nav-bar renders on the closing chapter: the visible label, the href (an https
// docs link or a mailto), whether it is the primary (accent) exit, and an optional onActivate the director
// wires to emit the cta_clicked event. The bar renders it as a real <a> (an https target opens a new tab,
// rel-hardened, governed by the console's external-link handling; a mailto is a plain same-context handoff), so
// the bar never navigates programmatically.
//
// Lives in this leaf module, not in nav-bar.ts where it first lived: nav-bar-funnel.ts needs the shape too,
// and nav-bar.ts imports buildFunnelParts from nav-bar-funnel.ts at runtime, so a type import back from
// nav-bar-funnel.ts to nav-bar.ts closed a madge cycle even though it was type-only (madge does not skip
// type-only imports). nav-bar-course.ts imports nothing from either sibling, so it carries the shared shape
// with no cycle, the same way it already carries TaskDoneMode and CourseParts.
export interface NavBarCta {
  label: string;
  href: string;
  primary?: boolean;
  onActivate?: (() => void) | undefined;
}

// The handle nav-bar.ts drives. The elements are exposed so the rail can place them in its own layout; the
// verbs own everything about their state, so the rail never reaches inside them.
export interface CourseParts {
  // The course identity line above the chapter title ("BEGINNER COURSE"), or null when no eyebrow was asked
  // for (the tour).
  eyebrowEl: HTMLElement | null;
  // The standing goal line: what this stage is for, and why it comes here. Hidden until setGoal.
  goalEl: HTMLElement;
  // The task card: chip, instruction, and the where-to-do-it hint. Hidden until setTask.
  taskCardEl: HTMLElement;
  // Paint the current chapter's goal, or clear it (null) on a chapter with none.
  setGoal(text: string | null): void;
  // Paint the current beat's task instruction in its WAITING state, or clear the card (null) on a beat with
  // no task. Every beat entry calls this, so a card can never carry a previous step's instruction.
  setTask(text: string | null): void;
  // Flip the card to its done state. No-op when no card is showing.
  markTaskDone(mode: TaskDoneMode): void;
  // Flip the card to its HAND-OVER state: the course has finished explaining this step and has stopped, and
  // the learner is now driving. This is the one place a playing course deliberately stops, so the card says
  // so rather than leaving a learner to wonder whether the words simply ran out.
  handOverTask(): void;
  // Say, on the card, why the walk did not move when the learner pressed Next. Without this the refusal is
  // invisible: the button is pressed, nothing happens, and only a screen reader is told anything.
  nudgeTask(text: string): void;
  // Whether a task card is currently showing (the rail asks before flipping it).
  taskShowing(): boolean;
}

// The waiting-state hint under the instruction: it names WHERE, because the spotlight is already pointing
// there and the two together are the link between the rail and the console.
const HINT_WAITING = "Do it on the highlighted part of the console. The course waits here until you have.";
// The HAND-OVER hint: the course has stopped talking and is now waiting on the learner. It says both halves a
// learner needs at that moment, which is what happens while they work and what ends their turn.
const HINT_HANDOVER = "Take your time and try the options. The course starts again by itself as soon as you have done it. If it does not, press Next.";
// The just-completed hint: the learner's action landed, and the course says so before it moves.
const HINT_JUST_DONE = "Done. The course moves on in a moment.";
// The revisited hint: a Back onto a step already completed. The work stands, and Next goes forward again.
const HINT_ALREADY_DONE = "You completed this step earlier. Your work is still here; Next takes you forward.";

// buildCourseParts constructs the three course-only parts. It renders nothing on its own: the rail places
// the elements and drives the verbs.
export function buildCourseParts(opts: { eyebrow?: string } = {}): CourseParts {
  const eyebrowEl =
    opts.eyebrow !== undefined && opts.eyebrow !== ""
      ? h(
          "span",
          {
            dataset: { tourEyebrow: "true" },
            style: ["font-size:var(--text-xs)", "font-weight:var(--weight-semibold)", "letter-spacing:0.08em", "text-transform:uppercase", "color:var(--accent-subtle-fg)"].join(";"),
          },
          opts.eyebrow,
        )
      : null;

  // The GOAL line: a quiet, standing answer to "what am I doing here, and why". It sits under the chapter
  // title for the WHOLE stage (every beat of it), so the answer is never a step the learner has already
  // paged past.
  const goalTextEl = h("span", {
    dataset: { tourGoalText: "true" },
    style: ["font-size:var(--text-sm)", "line-height:1.5", "color:var(--text)"].join(";"),
  });
  const goalEl = h(
    "div",
    {
      dataset: { tourGoal: "true" },
      style: [
        "display:none",
        "flex-direction:column",
        "gap:2px",
        "padding:var(--space-2) var(--space-3)",
        "border-left:3px solid var(--accent)",
        "border-radius:var(--radius-sm)",
        "background:var(--surface-sunken, var(--surface))",
      ].join(";"),
    },
    h(
      "span",
      {
        "aria-hidden": "true",
        style: ["font-size:var(--text-xs)", "font-weight:var(--weight-semibold)", "letter-spacing:0.06em", "text-transform:uppercase", "color:var(--text-muted)"].join(";"),
      },
      "Goal of this stage",
    ),
    goalTextEl,
  );

  const taskChipEl = h(
    "span",
    {
      dataset: { tourTaskChip: "true" },
      style: ["font-size:var(--text-xs)", "font-weight:var(--weight-semibold)", "letter-spacing:0.06em", "padding:2px 8px", "border-radius:var(--radius-full)", "background:var(--accent-subtle-bg)", "color:var(--accent-subtle-fg)", "flex:none"].join(";"),
    },
    "YOUR TASK",
  );
  const taskTextEl = h("span", {
    dataset: { tourTaskText: "true" },
    style: ["font-size:var(--text-sm)", "font-weight:var(--weight-semibold)", "color:var(--text)", "line-height:1.45"].join(";"),
  });
  const taskHintEl = h("span", {
    dataset: { tourTaskHint: "true" },
    style: ["font-size:var(--text-xs)", "line-height:1.45", "color:var(--text-muted)"].join(";"),
  });
  const taskCardEl = h(
    "div",
    {
      dataset: { tourTaskCard: "true" },
      style: ["display:none", "flex-direction:column", "gap:var(--space-2)", "padding:var(--space-3)", "border:1px solid var(--accent-subtle-fg)", "border-radius:var(--radius-md)", "background:var(--accent-subtle-bg)"].join(";"),
    },
    h("div", { style: ["display:flex", "align-items:flex-start", "gap:var(--space-2)"].join(";") }, taskChipEl, taskTextEl),
    taskHintEl,
  );

  return {
    eyebrowEl,
    goalEl,
    taskCardEl,
    setGoal(text: string | null): void {
      if (text === null || text === "") {
        goalEl.style.setProperty("display", "none");
        return;
      }
      goalTextEl.textContent = text;
      goalEl.style.setProperty("display", "flex");
    },
    setTask(text: string | null): void {
      if (text === null || text === "") {
        taskCardEl.style.setProperty("display", "none");
        return;
      }
      taskChipEl.textContent = "YOUR TASK";
      taskChipEl.style.setProperty("background", "var(--accent-subtle-bg)");
      taskChipEl.style.setProperty("color", "var(--accent-subtle-fg)");
      taskCardEl.style.setProperty("border-color", "var(--accent-subtle-fg)");
      taskTextEl.textContent = text;
      taskHintEl.textContent = HINT_WAITING;
      taskCardEl.style.setProperty("display", "flex");
    },
    handOverTask(): void {
      if (taskCardEl.style.getPropertyValue("display") === "none") return;
      taskChipEl.textContent = "YOUR TURN";
      taskTextEl.textContent = taskTextEl.textContent ?? "";
      taskHintEl.textContent = HINT_HANDOVER;
      // The same named keyframe the refusal uses (CSP-safe, from tokens.css), re-armed by clearing it first,
      // so the card visibly changes hands rather than quietly swapping two lines of text.
      taskCardEl.style.setProperty("animation", "none");
      taskCardEl.style.setProperty("animation", "dp-rise var(--dur) var(--ease-out)");
    },
    markTaskDone(mode: TaskDoneMode): void {
      if (taskCardEl.style.getPropertyValue("display") === "none") return;
      taskChipEl.textContent = "DONE";
      taskChipEl.style.setProperty("background", "var(--success-subtle-bg, var(--accent-subtle-bg))");
      taskChipEl.style.setProperty("color", "var(--success-fg, var(--accent-subtle-fg))");
      taskCardEl.style.setProperty("border-color", "var(--success-fg, var(--accent-subtle-fg))");
      taskHintEl.textContent = mode === "already-done" ? HINT_ALREADY_DONE : HINT_JUST_DONE;
    },
    nudgeTask(text: string): void {
      if (taskCardEl.style.getPropertyValue("display") === "none") return;
      taskHintEl.textContent = text;
      // A named keyframe from tokens.css (CSP-safe: no inline style block), re-armed by clearing it first,
      // so a second press of Next moves the card again rather than reading as a dead control.
      taskCardEl.style.setProperty("animation", "none");
      taskCardEl.style.setProperty("animation", "dp-rise var(--dur) var(--ease-out)");
    },
    taskShowing(): boolean {
      return taskCardEl.style.getPropertyValue("display") !== "none";
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// THE PHONE PANEL'S MODES, and the measurement that produced them.
//
// Below the rail breakpoint the guide is a panel sitting OVER the console. At 390 it had grown to 577px of
// an 844px viewport on a task step: the course was covering the screen it was asking the learner to work,
// and the goal and the prose were each clipped mid-sentence by their own scroll caps. Three states fix it,
// and each has one job:
//
//   COMPACT (the default here)  which stage, which step, the task, the controls. The prose is not clipped,
//                               it is not shown, and one control brings it back.
//   EXPANDED                    everything, inside ONE scrolling reading column, so no sentence is ever cut.
//   MINIMISED                   one line and the controls. The console gets the screen back, which a
//                               full-height product screen (the onboarding deck) needs. The narration keeps
//                               speaking while it is minimised, which is the point of it on a phone.
//
// The rail is untouched: a desktop has room for the whole panel, and neither control is rendered there.
// ---------------------------------------------------------------------------------------------------

// The elements the mode machine paints, handed in by the rail so this module owns behaviour and not layout.
export interface PanelModeParts {
  progressBlock: HTMLElement;
  beatBlock: HTMLElement;
  beatBody: HTMLElement;
  beatDoc: HTMLElement;
  segmentRow: HTMLElement;
  eyebrow: HTMLElement | null;
  goal: HTMLElement;
  // What the rail knows and this module must ask about, rather than guess: the layout variant, whether a
  // beat is painted at all (a chapter with none must not restore an empty block), whether the chapter has a
  // goal, and whether the current beat carries a documentation link.
  isRail(): boolean;
  beatShowing(): boolean;
  goalShowing(): boolean;
  docShowing(): boolean;
  // Called after every mode change, so the rail can republish the panel's measured height (the full-bleed
  // screens reserve room from it).
  onApplied?: () => void;
}

export interface PanelModes {
  // Re-apply the default WITHIN the current beat, after something changed that decides it (the learner
  // muting the course mid-step). A learner who has already pressed a mode control on this beat owns the
  // panel: their choice stands and this does nothing, which is the whole reason the flag exists.
  refreshDefault(autoMinimise: boolean): void;
  // Set the default for a NEWLY ENTERED beat. On a phone a hands-on step hands the console back by default
  // WHEN THE COURSE IS SPEAKING, because the voice is then carrying the instruction and the screen is what
  // the learner needs. With the sound off the panel stays compact, because the text is the only instruction
  // there is. A learner who presses either control on this beat owns the panel until the next one.
  enterBeat(autoMinimise: boolean): void;
  // The two controls, for the rail to place: "Read the step" in the reading column, minimise in the title row.
  moreBtn: HTMLElement;
  minimiseBtn: HTMLElement;
  // Re-paint the current mode. The rail calls it on layout changes and after every beat paint.
  apply(): void;
}

// setChildren swaps a control's contents using only removeChild/appendChild, which is the idiom the rest of
// the guide chrome uses and the one the headless test DOM implements (it has no replaceChild).
function setChildren(el: HTMLElement, kids: Array<Node>): void {
  while (el.firstChild) el.removeChild(el.firstChild);
  for (const k of kids) el.appendChild(k);
}

export function createPanelModes(parts: PanelModeParts): PanelModes {
  let compact = true;
  let minimised = false;
  // Whether the learner has pressed a mode control since this beat began. Their choice wins for the rest of
  // the beat; the next beat gets its own default.
  let chosenThisBeat = false;

  const moreLabel = h("span", {}, "Read the step");
  const moreBtn = h(
    "button",
    { "data-dp": "lib-tour-nav-bar-course.button.more",
      type: "button",
      class: "btn btn--ghost btn--sm",
      "aria-expanded": "false",
      dataset: { tourMore: "true" },
      style: ["display:none", "align-items:center", "gap:var(--space-1)", "align-self:flex-start", "pointer-events:auto", "white-space:nowrap"].join(";"),
      on: { click: () => { compact = !compact; chosenThisBeat = true; apply(); } },
    },
    svgIcon(ICON_CHEVRON_DOWN, { size: 14 }),
    moreLabel,
  ) as HTMLButtonElement;

  const minimiseBtn = h(
    "button",
    { "data-dp": "lib-tour-nav-bar-course.button.minimise",
      type: "button",
      class: "btn btn--ghost btn--sm",
      "aria-expanded": "true",
      dataset: { tourMinimise: "true" },
      style: ["display:none", "align-items:center", "justify-content:center", "padding:2px 6px", "flex:none", "pointer-events:auto"].join(";"),
      "aria-label": "Minimise the course panel",
      on: { click: () => { minimised = !minimised; chosenThisBeat = true; apply(); } },
    },
    svgIcon(ICON_CHEVRON_DOWN, { size: 16 }),
  ) as HTMLButtonElement;

  function apply(): void {
    const show = (el: HTMLElement | null, value: string): void => el?.style.setProperty("display", value);
    // Every early return below is a painted state, so the notification hangs off the call rather than the
    // end of the function.
    if (parts.onApplied) queueMicrotask(() => parts.onApplied?.());
    if (parts.isRail()) {
      show(moreBtn, "none");
      show(minimiseBtn, "none");
      show(parts.beatBlock, parts.beatShowing() ? "flex" : "none");
      show(parts.segmentRow, "flex");
      show(parts.eyebrow, "block");
      show(parts.goal, parts.goalShowing() ? "flex" : "none");
      parts.progressBlock.style.setProperty("max-height", "none");
      parts.progressBlock.style.setProperty("overflow-y", "visible");
      parts.goal.style.setProperty("max-height", "none");
      parts.goal.style.setProperty("overflow-y", "visible");
      show(parts.beatBody, "block");
      parts.beatBody.style.setProperty("max-height", "none");
      parts.beatBody.style.setProperty("overflow-y", "visible");
      return;
    }
    show(minimiseBtn, "inline-flex");
    minimiseBtn.setAttribute("aria-expanded", minimised ? "false" : "true");
    minimiseBtn.setAttribute("aria-label", minimised ? "Show the course panel" : "Minimise the course panel");
    setChildren(minimiseBtn, [svgIcon(minimised ? ICON_CHEVRON_UP : ICON_CHEVRON_DOWN, { size: 16 })]);
    // Neither block keeps a cap of its own on a phone: the column scrolls as one region when expanded, so
    // a sentence is never cut in half by a box it does not know about.
    parts.goal.style.setProperty("max-height", "none");
    parts.goal.style.setProperty("overflow-y", "visible");
    parts.beatBody.style.setProperty("max-height", "none");
    parts.beatBody.style.setProperty("overflow-y", "visible");

    if (minimised) {
      show(parts.beatBlock, "none");
      show(parts.goal, "none");
      show(parts.segmentRow, "none");
      show(moreBtn, "none");
      show(parts.eyebrow, "none");
      parts.progressBlock.style.setProperty("max-height", "none");
      parts.progressBlock.style.setProperty("overflow-y", "visible");
      return;
    }

    show(parts.beatBlock, parts.beatShowing() ? "flex" : "none");
    show(moreBtn, "inline-flex");
    moreBtn.setAttribute("aria-expanded", compact ? "false" : "true");
    moreLabel.textContent = compact ? "Read the step" : "Hide the text";
    setChildren(moreBtn, [svgIcon(compact ? ICON_CHEVRON_DOWN : ICON_CHEVRON_UP, { size: 14 }), moreLabel]);

    if (compact) {
      show(parts.goal, "none");
      show(parts.beatBody, "none");
      show(parts.segmentRow, "none");
      show(parts.beatDoc, "none");
      show(parts.eyebrow, "none");
      parts.progressBlock.style.setProperty("max-height", "none");
      parts.progressBlock.style.setProperty("overflow-y", "visible");
      return;
    }
    show(parts.segmentRow, "flex");
    show(parts.eyebrow, "block");
    if (parts.docShowing()) show(parts.beatDoc, "inline-flex");
    show(parts.goal, parts.goalShowing() ? "flex" : "none");
    show(parts.beatBody, "block");
    parts.progressBlock.style.setProperty("max-height", "52vh");
    parts.progressBlock.style.setProperty("overflow-y", "auto");
    parts.progressBlock.style.setProperty("overscroll-behavior", "contain");
  }

  function enterBeat(autoMinimise: boolean): void {
    chosenThisBeat = false;
    if (parts.isRail()) {
      minimised = false;
      apply();
      return;
    }
    minimised = autoMinimise;
    apply();
  }

  function refreshDefault(autoMinimise: boolean): void {
    if (chosenThisBeat || parts.isRail()) return;
    minimised = autoMinimise;
    apply();
  }

  return { moreBtn, minimiseBtn, apply, enterBeat, refreshDefault };
}

// The phone panel's measured height, published to the page as a custom property so a full-bleed screen
// (the onboarding deck, which lives outside .main and never saw the guide) can reserve room for it. The
// rail's clearance is a fixed column in tokens.css; the panel's is not, because its height is the length
// of a task instruction and changes with the mode the learner chose.
export function publishPanelHeight(doc: Document, bar: HTMLElement, isRail: boolean): void {
  const body = doc.body;
  if (!body) return;
  if (isRail) {
    body.classList.remove("dp-tour-panel");
    body.style.setProperty("--dp-tour-panel-h", "0px");
    return;
  }
  body.classList.add("dp-tour-panel");
  const h = typeof bar.getBoundingClientRect === "function" ? Math.round(bar.getBoundingClientRect().height) : 0;
  body.style.setProperty("--dp-tour-panel-h", `${h > 0 ? h + 16 : 0}px`);
}

// republishPanelHeight is the same publication, deferred a frame: a mode change repaints the panel, and its
// height is only true once that paint has happened.
export function republishPanelHeight(doc: Document, bar: HTMLElement, isRail: boolean): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => publishPanelHeight(doc, bar, isRail));
  else publishPanelHeight(doc, bar, isRail);
}

// stepLine composes a beat's position line: where the learner is within this stage, and (on a stage that has
// one) where its hands-on step sits relative to here. The counter is always painted, so the reading block's
// height does not jump between a one-beat stage and a many-beat one, and a learner reading step one can see
// how far it is to the thing they have to do.
export function stepLine(index: number, count: number, taskAtStep?: number): string {
  const here = `Step ${index + 1} of ${count}`;
  if (taskAtStep === undefined) return count > 1 ? here : "";
  if (taskAtStep === index + 1) return `${here} · hands-on, this one`;
  if (taskAtStep > index + 1) return `${here} · hands-on at step ${taskAtStep}`;
  return `${here} · hands-on step done`;
}

// watchPanelHeight keeps the published height honest without relying on the call sites remembering to
// republish. At a narrow width, publishing only on the events this module knows about can leave the correction to
// land AFTER a learner had scrolled, and the page then moved 58px under them. A ResizeObserver fires on
// every box change, including the ones no call site predicts: a task card painting, a mode change settling,
// a font arriving. Returns its own disconnect, and is a no-op where ResizeObserver does not exist (the
// headless test DOM), where the explicit publishes still run.
export function watchPanelHeight(doc: Document, bar: HTMLElement, isRail: () => boolean): (() => void) | null {
  const RO = (typeof globalThis !== "undefined" ? (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver : undefined);
  if (typeof RO !== "function") return null;
  const observer = new RO(() => publishPanelHeight(doc, bar, isRail()));
  observer.observe(bar);
  return () => observer.disconnect();
}
