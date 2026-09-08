// The shared "still running" reassurance affordance. A long single-call action (a large restore
// apply, a proof) is one un-streamed request behind a busy button; with no progress and no slow-note it
// reads as a hang. After a threshold this paints a spinner + message into a target region so the operator
// sees it is still working, not stuck. It does not invent progress (the call is not streamed); it states
// honestly that a large run takes a while and nothing is lost. The .ob-spinner is reduced-motion gated in
// tokens.css. House rules: Australian English, no em dashes, precise claims.

import { h } from "../lib/dom.ts";

// The past-this-many-ms point at which a still-running call stops reading as instant and starts reading
// as a possible hang. Mirrors the restore proof card's existing threshold so the two feel consistent.
export const SLOW_NOTE_THRESHOLD_MS = 10_000;

// runningNote builds the spinner + message line painted while a long action is in flight.
export function runningNote(msg: string): HTMLElement {
  return h(
    "p",
    { class: "field__hint", style: "display:flex;align-items:center;gap:var(--space-2);margin:0" },
    h("span", { class: "ob-spinner", "aria-hidden": "true" }),
    h("span", msg),
  );
}

// scheduleSlowNote arms a timer that, after thresholdMs, replaces `target`'s children with the running
// note. It returns a cancel function the caller MUST invoke when the action lands (success or failure):
// the cancel clears the timer so a fast call never flashes the note, and a slow call's note is left in
// place only until the caller paints the real outcome over it. Pure timer wiring (window.setTimeout), so
// the DOM shim drives it under the validators.
export function scheduleSlowNote(target: HTMLElement, msg: string, thresholdMs: number = SLOW_NOTE_THRESHOLD_MS): () => void {
  const timer = window.setTimeout(() => {
    target.replaceChildren(runningNote(msg));
  }, thresholdMs);
  return () => window.clearTimeout(timer);
}
