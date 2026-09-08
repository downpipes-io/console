// The training-walk launcher: training mode's sibling of persona-fork.ts startTour. There is no persona
// fork here: the walk IS the experience, so the launcher builds the director over the Beginner script and
// starts it directly. The world is the learner's WORK PRODUCT, so the reseed dependency is a deliberate
// no-op: Back re-renders a prior chapter over the world as the learner built it (their destination, their
// downpipe, their runs survive), and the chapter time jumps stay applied through the director's own
// once-per-walk guard. The one thing that resets the training world is a page reload, exactly as the
// banner says.
//
// House rules: Australian English, precise claims.

import { createTourDirector, type TourDirector } from "./director.ts";
import { mountNavBar } from "./nav-bar.ts";
import { createNarrator } from "./narration.ts";
import { mountTrainingFieldCues } from "./training-field-cue.ts";
import { mountTrainingIntro } from "./training-intro.ts";
import { TRAINING_BEGINNER } from "./scripts/training-beginner.ts";

// activeWalk guards against a double launch (two directors, two rails), exactly as startTour guards the
// welcome card. A redundant call returns the existing handle.
let activeWalk: TourDirector | null = null;

// startTrainingWalk is the public entry the training-mode boot path calls (demo-fetch.ts startDemo): it
// builds the director over the Beginner walk and starts it at chapter one, which is the onboarding deck a
// fresh account would meet anyway. Idempotent; returns the director handle so a test can drive it.
//
// The start is DEFERRED until the app's initial route has painted (the same readiness signal the
// director's own awaitScreen reads). The tour never met this race because its director starts on a human
// click long after boot; the walk starts itself at boot, and a director that navigates before the
// router's initial dispatch has its navigation overwritten by the boot landing on Overview, which was
// a case where the rail narrates chapter one over the wrong screen.
export function startTrainingWalk(): TourDirector {
  if (activeWalk !== null) return activeWalk;
  // The course speaks. Sound is on unless this learner turned it off before, and the first step plays inside
  // the gesture that started the course, which is what browsers require.
  const narrator = createNarrator(document);
  // Every credential field the course puts in front of the learner says, on the screen, that any value
  // works. The introduction says it once; this says it where the cursor actually is.
  mountTrainingFieldCues(document);
  const director = createTourDirector(TRAINING_BEGINNER, {
    // The learner's world persists across Back/Restart: see the module header. The director still pins
    // its seed clock; this no-op simply declines to rebuild the world with it.
    reseed: () => {},
    // THE COURSE PLAYS ITSELF. It reads each step aloud and moves on by itself, and the one place it stops is
    // the hands-on step, where it says so and waits for the learner's work to land. A course that moved only
    // when Next was pressed read as a slide deck: the voice stopped, nothing said why, and the learner was
    // left to work out that a button was owed on every step.
    autoplay: true,
    autoStart: true,
    // No speed cycler: the pace here is the length of the voice, and a multiplier over it would cut the voice
    // off part way through the step it is scaling.
    speedControl: false,
    // The rail is dressed as a course: it names the course, counts STAGES rather than bare numbers, puts
    // words on Back and Next, and names its exit and its way back in the course's own terms.
    mountNav: () =>
      mountNavBar(document, {
        eyebrow: "Beginner course",
        progressUnit: "Stage",
        labelledControls: true,
        exitLabel: "Leave",
        exitAria: "Leave the course and look around the console on your own",
      }),
    narrator,
    resumeLabel: "Resume the course",
  });
  activeWalk = director;
  // The course opens with its INTRODUCTION, not with a task. The card says what this page is, how the
  // course works, and what the learner will have built; starting it runs the walk from stage one. The walk
  // still waits for the app's first paint, because a director that navigates before the router's initial
  // dispatch has its navigation overwritten.
  const startWhenPainted = (attempt: number): void => {
    const painted = typeof document !== "undefined" && document.querySelector(".page-header__title, .ob-page") !== null;
    if (painted || attempt >= 100 || typeof setTimeout !== "function") {
      mountTrainingIntro({ onStart: () => director.start() });
      return;
    }
    setTimeout(() => startWhenPainted(attempt + 1), 50);
  };
  startWhenPainted(0);
  return activeWalk;
}
