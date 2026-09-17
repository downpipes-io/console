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
      // "Not run" would be a CLAIM that the check was never attempted, so it must not be the label for an
      // outcome this build does not know or a row that carries no outcome at all: an operator reading a
      // flight report needs to tell "we did not check this" apart from "we cannot read what the check said".
      // The tone stays the honest neutral; only the word changes.
      return { tone: "neutral", label: "Unknown" };
  }
}

// destStateLabel maps a destination's liveness to a short badge label.
// "Pending" is reserved for a canary that has NOT YET FLOWN. A liveness this build does not know, or a
// flight row that carries none, returns "Unknown" rather than "Pending": the canary exists to be the early
// warning that a destination has silently gone bad, so "we have not looked yet" is the single most
// dangerous thing to say when the truth is "we cannot read what we found". The tone stays honest; only the
// word distinguishes the two.
export function destStateLabel(status: CanaryLiveness): string {
  return status === "alive" ? "Alive"
    : status === "dead" ? "Dead"
    : status === "ailing" ? "Ailing"
    : status === "disabled" ? "Off"
    : status === "pending" ? "Pending"
    : "Unknown";
}
