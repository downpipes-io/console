// THE ONE version-skew decision, shared by every console surface that renders an update verdict.
//
// WHY THIS LEAF EXISTS. The engine's `versionSkew` is a four-member enum whose "uncomparable" member means the
// engine could not tell which way the skew runs. A plain `updateAvailable` boolean cannot carry that
// distinction: it reads false both when the engine is genuinely current and when neither version string
// parsed, so an unreadable version pair renders as a silent, green "Up to date" -- a pass reported where a
// could-not-check is the truth.
//
// Both the Licence card and the Overview tile read the same engine response, so both must derive their verdict
// from this one decision rather than each computing its own: two surfaces answering the same underlying state
// with two different verdicts is the failure this leaf exists to make impossible. Both call sites consult ONE
// decision and share ONE set of words, so neither can drift from the other.
//
// Pure and DOM-free; the validators drive it directly in Node.

import type { UpdateStatus } from "./api/types/updates.ts";

// UpdateSkew is the console's reading of the engine's versionSkew, with ONE member the engine never sends:
// "not-reported", for an engine that predates the field. That member is deliberately NOT folded into
// "uncomparable". An engine that never carried the field is not an engine that tried and failed to compare,
// and an estate that simply has not upgraded yet must not be told its versions cannot be read (that would
// cry wolf on every account running an older build, which is how an honest warning gets ignored).
export type UpdateSkew = "behind" | "current" | "ahead" | "uncomparable" | "not-reported";

// updateSkew reads the engine's verdict, honestly absent when the engine did not send one.
export function updateSkew(upd: UpdateStatus): UpdateSkew {
  const raw = upd.versionSkew;
  if (raw === "behind" || raw === "current" || raw === "ahead" || raw === "uncomparable") return raw;
  return "not-reported";
}

// skewUncomparable is the ONE predicate every update surface tests before it may render a healthy verdict.
// It is true only when the engine explicitly said it could not compare the two version strings.
export function skewUncomparable(upd: UpdateStatus): boolean {
  return updateSkew(upd) === "uncomparable";
}

// The shared words. A tile's VALUE, its status LABEL and its secondary line are three different slots, so
// each gets its own constant rather than one phrase repeated (a tile that reads the same words twice is
// noise). They are exported so both the Licence card and the Overview tile print the same sentence: an
// operator who reads "Versions cannot be compared" on one screen must not meet a different phrase for the
// same state on the other, or the two read as two different faults.
export const SKEW_UNCOMPARABLE_VALUE = "Unknown" as const;
export const SKEW_UNCOMPARABLE_LABEL = "Versions cannot be compared" as const;
export const SKEW_UNCOMPARABLE_SECONDARY =
  "The engine could not read one of the two version strings, so it cannot say whether an update is available. Open Licence and updates to check the channel." as const;
