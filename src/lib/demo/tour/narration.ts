// The course NARRATOR: it reads each step aloud from the audio committed under public/narration, which was
// rendered from this same script by scripts/render-narration.py and is held to it by scripts/narration-gate.ts.
//
// SOUND IS ON BY DEFAULT, and that is a decision rather than an accident. A course a learner chose to take
// is a place where being spoken to is the point; the alternative, a mute course with a control nobody
// presses, is a feature that ships switched off. The learner can turn it off from the rail at any time and
// the choice is remembered.
//
// AUTOPLAY IS NOT A FIGHT WITH THE BROWSER. Audio may only start after a real gesture, and the course has
// exactly the right one: the learner presses "Start the course" on the introduction card, which is what
// begins the walk. Every step after that plays inside that same permission. If a browser refuses anyway
// (an unusual policy, or a page restored from history), play() rejects, nothing is thrown, and the next
// step tries again; the rail keeps its own state honest by asking blocked() rather than assuming.
//
// NOTHING IS AUDIO-ONLY. Every word spoken here is on the rail as text, so the course is complete with the
// sound off. That is why the toggle can be a plain preference and not an accessibility gate.
//
// House rules: Australian English, no em dashes, precise claims.

// Where the rendered steps live, relative to the site root. The training worker serves public/ as assets, so
// this is a same-origin request and the console's connect-src is untouched (audio is media-src).
const BASE = "/narration/";

// The remembered preference. Absent means ON: a first-time learner gets the course as designed.
const STORAGE_KEY = "downpipes:training:sound";

// What the player tells the course about the step it is speaking. The course PACES ITSELF BY THE VOICE, so
// these two are not decoration: onDuration is how long this step will take to say (the rail's dwell bar shows
// exactly that), and onEnded is the moment the course may move on. Without them the walk would advance on a
// dwell scaled to READING, and speech of the same words runs about twice as long, so the voice would be cut
// off part way through nearly every step.
export interface SpeechHooks {
  // The step's length in milliseconds, once the browser has read the file's metadata. May never fire (sound
  // off, a refused play, a file that will not load), which is why the caller must hold a fallback pace.
  onDuration?: (ms: number) => void;
  // The voice has finished this step. Fires once per speak(), never after a later speak() supersedes it.
  onEnded?: () => void;
  // This step will NOT be spoken: the browser refused to play, or the audio would not load. The caller must
  // then pace the step itself, because neither of the two hooks above is coming.
  onBlocked?: () => void;
}

export interface Narrator {
  // Speak the step with this id ("3-2", chapter 3 beat 2). Stops whatever was playing first, so a learner
  // pressing Next quickly is never read two steps at once. A no-op while sound is off. The optional hooks
  // report the step's length and its end, which is how the course paces itself by the voice.
  speak(stepId: string, hooks?: SpeechHooks): void;
  // Stop and rewind the current step (a beat change handles itself; this is for Exit and teardown).
  stop(): void;
  // Whether sound is currently on.
  enabled(): boolean;
  // Turn sound on or off and remember it. Turning it off stops the current step at once; turning it on
  // speaks the step it is given, so the control does something audible immediately either way.
  setEnabled(on: boolean, currentStepId?: string): void;
  // True when the browser refused the last play(). The rail uses it to explain a silent course rather than
  // leaving the learner to wonder.
  blocked(): boolean;
  // Tear the audio element out (destroy).
  destroy(): void;
}

// readPreference reads the remembered choice, defaulting to ON. Never throws: storage is blocked in private
// windows, and a course that cannot read a preference should still speak.
function readPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

function writePreference(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Storage blocked: the choice still holds for this session, it simply is not remembered.
  }
}

// createNarrator builds the player over one reused <audio> element. A document with no body (the headless
// shim) returns an inert narrator whose verbs are safe no-ops, so nothing here can break a boot or a test.
export function createNarrator(doc: Document = document, base: string = BASE): Narrator {
  let on = readPreference();
  let refused = false;
  // The step currently loaded, and the hooks that belong to it. A stale <audio> event (metadata arriving for
  // a step the learner has already left) is dropped by comparing the token, so the course is never paced by a
  // superseded step's length.
  let speechToken = 0;
  let currentStep: string | null = null;
  let currentHooks: SpeechHooks = {};

  const el = typeof doc.createElement === "function" ? (doc.createElement("audio") as HTMLAudioElement) : null;
  if (el && doc.body) {
    el.preload = "none";
    // Hidden, not display:none: the element is a player, never a control. The rail owns the visible toggle.
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("data-training-narration", "true");
    el.style?.setProperty?.("display", "none");
    doc.body.appendChild(el);
  }

  function halt(): void {
    if (!el) return;
    try {
      el.pause();
      el.currentTime = 0;
    } catch {
      // A pause on an element with no source is harmless; nothing to unwind.
    }
  }

  function play(stepId: string, hooks: SpeechHooks = {}): void {
    if (!el || !on) return;
    halt();
    currentStep = stepId;
    currentHooks = hooks;
    const token = ++speechToken;
    // preload=none is set on the element, so metadata arrives only once play() has asked for the file. Both
    // listeners are one-shot and token-guarded: the element is reused for every step of the course.
    const onMeta = (): void => {
      el.removeEventListener("loadedmetadata", onMeta);
      if (token !== speechToken) return;
      const secs = typeof el.duration === "number" && Number.isFinite(el.duration) ? el.duration : 0;
      if (secs > 0) hooks.onDuration?.(Math.round(secs * 1000));
    };
    const onEnd = (): void => {
      el.removeEventListener("ended", onEnd);
      if (token !== speechToken) return;
      hooks.onEnded?.();
    };
    const onErr = (): void => {
      el.removeEventListener("error", onErr);
      if (token !== speechToken) return;
      refused = true;
      hooks.onBlocked?.();
    };
    // The headless shim's elements carry no listener surface, so every subscription is optional. Without the
    // events the caller keeps its own pace, which is exactly the silent-course path.
    if (typeof el.addEventListener === "function") {
      el.addEventListener("loadedmetadata", onMeta);
      el.addEventListener("ended", onEnd);
      el.addEventListener("error", onErr);
    }
    try {
      el.src = `${base}s${stepId}.mp3`;
      const p = el.play() as unknown as Promise<void> | undefined;
      if (p && typeof p.then === "function") {
        p.then(
          () => {
            refused = false;
          },
          () => {
            // Refused by policy, or the file is not there. Either way the course carries on in text; the
            // next step tries again, and the rail can say so. The caller is told, because a course pacing
            // itself by a voice that is not coming would otherwise hold on this step forever.
            refused = true;
            if (token === speechToken) hooks.onBlocked?.();
          },
        );
      }
    } catch {
      refused = true;
      hooks.onBlocked?.();
    }
  }

  return {
    speak(stepId: string, hooks: SpeechHooks = {}): void {
      play(stepId, hooks);
    },
    stop(): void {
      speechToken += 1; // a stop is not an end: the pending listeners must not report one
      halt();
    },
    enabled(): boolean {
      return on;
    },
    setEnabled(next: boolean, currentStepId?: string): void {
      on = next;
      writePreference(next);
      if (!next) {
        speechToken += 1;
        halt();
        return;
      }
      refused = false;
      // Replay with the hooks the course armed for this step, so turning the sound back on hands the pace
      // back to the voice rather than leaving the walk on the reading dwell.
      const id = currentStepId ?? currentStep;
      if (id !== null && id !== undefined) play(id, id === currentStep ? currentHooks : {});
    },
    blocked(): boolean {
      return refused;
    },
    destroy(): void {
      halt();
      el?.remove();
    },
  };
}
