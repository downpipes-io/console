// Tone mapping helpers for the Canary screen: liveness and aspect outcomes to a status tone (colour +
// dot shape) so every state reads by hue AND shape AND text, never colour alone.

import type { CanaryLiveness, CanaryAspectOutcome } from "../api.ts";
import type { StatusTone } from "../components/status.ts";

// toneForStatus maps the bird's liveness to a status tone (colour + dot shape). alive is ok (green
// circle), dead is danger (red square), ailing is warn (amber triangle), pending/disabled are quiet.
export function toneForStatus(status: CanaryLiveness): StatusTone {
  switch (status) {
    case "alive":
      return "ok";
    case "dead":
      return "danger";
    case "ailing":
      return "warn";
    default:
      return "neutral";
  }
}

// toneForAspect maps one flight aspect's outcome to a tone + short label, so each check reads by
// hue + shape + text. A note (an immutable bucket refusing the delete-probe) is informational, never
// a failure.
export function toneForAspect(outcome: CanaryAspectOutcome): { tone: StatusTone; label: string } {
  switch (outcome) {
    case "pass":
      return { tone: "ok", label: "Pass" };
    case "fail":
      return { tone: "danger", label: "Fail" };
    case "note":
      return { tone: "info", label: "Note" };
    case "skip":
      return { tone: "neutral", label: "Not run" };
    default:
      // destStateLabel's defect, eight lines up, in this function's own closed set. "Not run" is a CLAIM
      // that the check was never attempted, and the default arm handed it to any outcome this build does
      // not know and to a row that carried no outcome at all, byte-identically to an aspect that genuinely
      // did not run. An operator reading a flight report cannot tell "we did not check this" from "we
      // cannot read what the check said". The tone was already the honest neutral; the word was the lie.
      return { tone: "neutral", label: "Unknown" };
  }
}

// destStateLabel maps a destination's liveness to a short badge label.
// "Pending" is the label for a canary that has NOT YET FLOWN, and it was also the else arm, so a liveness
// this build does not know and a flight row that carried none both read "Pending" beside the honest neutral
// dot, byte-identical to a canary genuinely waiting for its first flight. The canary exists to be the early
// warning that a destination has silently gone bad, so "we have not looked yet" is the single most
// dangerous thing to say when the truth is "we cannot read what we found". The tone was already honest; the
// word is what changes.
export function destStateLabel(status: CanaryLiveness): string {
  return status === "alive" ? "Alive"
    : status === "dead" ? "Dead"
    : status === "ailing" ? "Ailing"
    : status === "disabled" ? "Off"
    : status === "pending" ? "Pending"
    : "Unknown";
}
