// The one composer of a beat's SPOKEN text, shared by the three things that must never disagree about it:
// the narration player (what the speakers say), the narration gate (what the committed audio was rendered
// from), and the rail's polite live region, which announces this same string with the beat's heading in
// front of it (announcementTextFor).
//
// It is a pure function over a beat, with no DOM and no imports beyond the beat's own type, so the gate can
// call it under node and hash the result. That hash is the whole freshness mechanism: change a beat's words
// without re-rendering its audio and the gate fails, rather than the course shipping narration that no
// longer matches the screen a learner is reading.
//
// House rules: Australian English, no em dashes, precise claims.

// The shape this reads. Deliberately structural rather than an import of InfoPoint, so the gate does not
// pull the director (and the whole tour chrome) into a node script to hash a string.
export interface NarratableBeat {
  title: string;
  body: string;
  task?: { label: string } | undefined;
}

// THE HAND-OVER, spoken. A course that plays itself has to say out loud where it stops, because the learner
// cannot see a timer and silence on its own reads as a fault. "Your task: X." named the work but not the
// change of driver, so the voice ended and the learner sat waiting for a course that was already waiting for
// them. This is the sentence that changes hands, and it is spoken on every hands-on step.
const HAND_OVER = "Now it is your turn.";
// What ends the turn. The graders watch the console and pick the course up by themselves, so the honest
// instruction is to work and not to press anything, with the button named only as the way out if the course
// does not notice.
const TURN_ENDS = "Take your time and try the options. The course starts again by itself as soon as you have done it. If it does not, press Next.";

// narrationTextFor composes what is SPOKEN about a beat: its prose, and, on a hands-on step, the hand-over.
//
// THE HEADING IS NOT SPOKEN. A card heading is written to be read at a glance above the paragraph it labels
// ("Create it", "Create yours"), and a voice that says it aloud before the sentence sounds like it is reading
// a page rather than teaching. The heading stays on the rail, where it does its job, and it is still
// ANNOUNCED to a screen reader by announcementTextFor below, which is a different job again: a learner who
// cannot see the card needs the heading said.
export function narrationTextFor(beat: NarratableBeat): string {
  return beat.task ? `${beat.body} ${HAND_OVER} ${beat.task.label}. ${TURN_ENDS}` : beat.body;
}

// announcementTextFor is what a SCREEN READER hears when the walk moves to a beat: the heading, then exactly
// what the voice says. It is composed from narrationTextFor rather than beside it, so the two cannot drift
// over the words themselves. The trailing full stop after the heading is what stops a synthesiser running it
// into the body.
export function announcementTextFor(beat: NarratableBeat): string {
  return `${beat.title}. ${narrationTextFor(beat)}`;
}

// narrationStepId names a beat's audio the way the manifest and the shipped file agree on: 1-based chapter
// and 1-based beat.
export function narrationStepId(chapterIndex: number, beatIndex: number): string {
  return `${chapterIndex + 1}-${beatIndex + 1}`;
}
