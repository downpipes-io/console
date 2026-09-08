// The course INTRODUCTION: the card a learner meets before the Beginner walk starts.
//
// WHY IT EXISTS. The walk used to begin on the onboarding deck with a rail beside it, and a first learner
// said the plain truth about that: "The console doesn't even have an introduction to explain what this is. I
// can't tell what I am doing, why I am doing it." A course that starts mid-task teaches nothing in its first
// minute. This card answers four questions before anything moves: what this page is, how the course works,
// what the learner will have built at the end, and how long it takes.
//
// It is the training sibling of the tour's welcome card (persona-fork.ts) and follows the same discipline: a
// labelled, NON-trapping dialog (aria-modal=false) with no dim backdrop, so the real console stays visible
// behind it; every style applied per-property through the h() builder's CSSOM path, so it runs under the
// console's strict style-src 'self'; and focus moves into the card on mount and back out when it goes.
//
// There is one action, and that is deliberate. The tour offers "free explore" because a visitor may only want
// a look. A course is a course: the way in is to start it. Escape starts it as well, so a keyboard user is
// never held by a card they cannot dismiss.
//
// House rules: Australian English, no em dashes, no rule-of-three, precise claims.

import { h } from "../../dom.ts";
import { motionOK } from "../../a11y-prefs.ts";
import { applyFocusRing } from "./overlay.ts";

// The stable element id: a second mount is a no-op, and a test finds the card deterministically.
const INTRO_ID = "training-intro";

// The handle the launcher (and a test) drives.
export interface TrainingIntro {
  // Start the course: tear the card down and run the caller's onStart. Idempotent.
  start(): void;
  // Drop the card without starting (teardown only; nothing in the product calls it on its own).
  destroy(): void;
  readonly root: HTMLElement;
}

export interface TrainingIntroDeps {
  doc?: Document;
  onStart: () => void;
}

// What the card says about how the course works. Short sentences, one instruction each. The second and third
// are the ones that matter most now that the course plays itself: a learner who does not know it will move on
// its own sits waiting for a button, and a learner who does not know it will STOP has no idea their turn has
// come. Both are said here, before anything moves.
const HOW_IT_WORKS: ReadonlyArray<string> = [
  "There are eight stages, in the order a real operator does them.",
  "The course plays itself. It reads each stage aloud and moves on by itself, and you can turn the voice off on the panel whenever you like.",
  "It stops at every step you do yourself and tells you so. Work the console, and the course picks itself up the moment your work lands.",
  "Back returns to any stage you have finished. Your work stays as you left it.",
];

// pointerIsCoarse reports whether the primary input is a finger rather than a mouse, so copy about keys can
// be left off a touch device. Never throws: a browser (or the headless shim) that cannot answer is treated
// as a keyboard device, which is the safe way to be wrong here (an extra sentence, not a missing one).
function pointerIsCoarse(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

// mountTrainingIntro builds the card into document.body and returns its handle. A document with no body
// returns an inert handle, so a headless boot cannot throw here.
export function mountTrainingIntro(deps: TrainingIntroDeps): TrainingIntro {
  const doc = deps.doc ?? document;
  const existing = doc.getElementById(INTRO_ID);
  if (existing) return { start() {}, destroy() { existing.remove(); }, root: existing };

  let started = false;
  let keyHandler: ((ev: KeyboardEvent) => void) | null = null;
  const launchEl = (doc.activeElement as HTMLElement | null) ?? null;

  const titleId = `${INTRO_ID}-title`;

  const eyebrow = h("span", {
    style: ["font-size:var(--text-xs)", "font-weight:var(--weight-semibold)", "letter-spacing:0.08em", "text-transform:uppercase", "color:var(--accent-subtle-fg)"].join(";"),
  }, "Downpipes training");

  const heading = h("h2", {
    id: titleId,
    style: ["margin:0", "font-size:var(--text-xl)", "font-weight:var(--weight-semibold)", "color:var(--text)", "letter-spacing:var(--tracking-tight)"].join(";"),
  }, "Beginner course: set up Downpipes from nothing");

  const timing = h("span", {
    style: ["font-size:var(--text-xs)", "font-weight:var(--weight-semibold)", "padding:2px 10px", "border-radius:var(--radius-full)", "background:var(--accent-subtle-bg)", "color:var(--accent-subtle-fg)", "flex:none"].join(";"),
  }, "About 30 minutes");

  const para = (text: string): HTMLElement =>
    h("p", { style: ["margin:0", "font-size:var(--text-sm)", "line-height:1.6", "color:var(--text-muted)"].join(";") }, text);

  const sectionTitle = (text: string): HTMLElement =>
    h("span", { style: ["font-size:var(--text-xs)", "font-weight:var(--weight-semibold)", "letter-spacing:0.06em", "text-transform:uppercase", "color:var(--text-muted)"].join(";") }, text);

  const list = h(
    "ul",
    { style: ["margin:0", "padding:0 0 0 var(--space-4)", "display:flex", "flex-direction:column", "gap:var(--space-1)"].join(";") },
    ...HOW_IT_WORKS.map((item) => h("li", { style: ["font-size:var(--text-sm)", "line-height:1.55", "color:var(--text)"].join(";") }, item)),
  );

  const startBtn = h(
    "button",
    {
      "data-dp": "lib-tour-training-intro.button.start",
      type: "button",
      class: "btn btn--primary",
      "aria-label": "Start the Beginner course",
      dataset: { trainingIntroStart: "true" },
      style: ["display:inline-flex", "align-items:center", "justify-content:center", "gap:var(--space-2)", "pointer-events:auto", "flex:none"].join(";"),
      on: { click: () => start() },
    },
    h("span", "Start the course"),
  ) as HTMLButtonElement;

  const card = h(
    "div",
    {
      id: INTRO_ID,
      role: "dialog",
      "aria-modal": "false",
      "aria-labelledby": titleId,
      tabindex: "-1",
      dataset: { trainingIntro: "true", frontLayer: "true" }, // data-front-layer: see persona-fork.ts's card
      style: [
        "position:fixed",
        "left:50%",
        "top:50%",
        "transform:translate(-50%, -50%)",
        "box-sizing:border-box",
        "width:min(560px, 92vw)",
        "max-height:88vh",
        "overflow-y:auto",
        "display:flex",
        "flex-direction:column",
        "gap:var(--space-4)",
        "padding:var(--space-5)",
        "background:var(--surface-raised)",
        "color:var(--text)",
        "border:1px solid var(--border)",
        "border-radius:var(--radius-lg)",
        "box-shadow:var(--shadow-lg)",
        "font-family:var(--font-sans)",
        "pointer-events:auto",
        "z-index:var(--z-palette)",
      ].join(";"),
    },
    h("div", { style: ["display:flex", "align-items:center", "justify-content:space-between", "gap:var(--space-3)"].join(";") }, eyebrow, timing),
    heading,
    para("This page is the real Downpipes console, running on sample data inside your browser. No Cloudflare account is connected, nothing you type leaves this tab, and a reload starts the course again."),
    // The one line a learner most needs before they meet a form. It is called out rather than left inside
    // the paragraph above, because a learner who thinks they need a real Cloudflare token stops here.
    h(
      "p",
      {
        dataset: { trainingIntroPlaceholders: "true" },
        style: [
          "margin:0",
          "padding:var(--space-3)",
          "border-left:3px solid var(--accent)",
          "border-radius:var(--radius-sm)",
          "background:var(--accent-subtle-bg)",
          "color:var(--text)",
          "font-size:var(--text-sm)",
          "font-weight:var(--weight-medium)",
          "line-height:1.55",
        ].join(";"),
      },
      "You never need a real credential. Where the console asks for a key, a token or a secret, type anything at all: the course accepts it and shows you what the product would do.",
    ),
    h(
      "div",
      { style: ["display:flex", "flex-direction:column", "gap:var(--space-2)"].join(";") },
      sectionTitle("How the course works"),
      list,
    ),
    h(
      "div",
      { style: ["display:flex", "flex-direction:column", "gap:var(--space-2)"].join(";") },
      sectionTitle("What you will have built"),
      para("A verified destination, a connected Cloudflare account, an attached source, a scheduled backup, a completed run you can read, and a failed run that you diagnose and rerun."),
    ),
    h(
      "div",
      { style: ["display:flex", "align-items:center", "gap:var(--space-3)", "flex-wrap:wrap"].join(";") },
      startBtn,
      // The Escape hint is for a device that HAS an Escape key. On a phone it was advice about a key the
      // reader does not have, which is the kind of line that quietly tells a learner the thing was not
      // built for them. Escape still starts the course wherever a keyboard exists; only the sentence is
      // conditional, and a device we cannot ask is treated as one with a keyboard.
      pointerIsCoarse() ? null : h("span", { style: ["font-size:var(--text-xs)", "color:var(--text-muted)"].join(";") }, "Escape starts it too."),
    ),
    // SAID ONLY ON A PHONE, and said plainly rather than hidden. The course asks a learner to fill in real
    // forms in an admin console built for a desk, and no amount of layout work changes that. It runs here,
    // it is graded here, and it is easier on a laptop; a learner who knows that before they start can
    // choose, which is better than discovering it three stages in.
    pointerIsCoarse()
      ? h(
          "p",
          {
            dataset: { trainingIntroSmallScreen: "true" },
            style: ["margin:0", "font-size:var(--text-xs)", "line-height:1.5", "color:var(--text-muted)"].join(";"),
          },
          "You are on a small screen. The course works here, and it asks you to fill in real forms in a console built for a desk, so it is easier on a laptop. On a phone the course reads each step aloud and steps out of the way while you work.",
        )
      : null,
  );

  const body = doc.body;
  if (!body) return { start() {}, destroy() {}, root: card };
  body.appendChild(card);
  if (motionOK()) card.style.setProperty("animation", "dp-rise var(--dur) var(--ease-out)");

  // Focus lands on the one action, so a keyboard learner starts with a press of Enter.
  if (typeof startBtn.focus === "function") {
    try {
      startBtn.focus();
      applyFocusRing(card);
    } catch {
      // A focus hiccup must never block the course; the button is still reachable by Tab.
    }
  }

  keyHandler = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    start();
  };
  doc.addEventListener("keydown", keyHandler as EventListener);

  function teardown(): void {
    if (keyHandler) {
      doc.removeEventListener("keydown", keyHandler as EventListener);
      keyHandler = null;
    }
    card.remove();
    // Hand focus back where it was, so the keyboard path stays continuous (WCAG 2.4.3). The walk moves it
    // onto the rail a moment later.
    if (launchEl && typeof launchEl.focus === "function" && launchEl.isConnected !== false) {
      try {
        launchEl.focus();
      } catch {
        // The browser default (focus at <body>) is an acceptable fallback here.
      }
    }
  }

  function start(): void {
    if (started) return;
    started = true;
    teardown();
    deps.onStart();
  }

  return { start, destroy: teardown, root: card };
}
