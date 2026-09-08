// The OPTIONAL per-downpipe cron / timezone / blackout-window schedule, mirrored from the engine
// (engine/src/sched/scheduler-do.ts DownpipeSchedule + cron.ts). This module is the console's
// CLIENT-SIDE half: it (a) builds the wire `schedule` object the editor sends, (b) validates the
// SAME shapes the engine's validateConfig rejects so an operator sees an inline reason instead of a
// late 400, and (c) computes the next few fire times for a calm preview.
//
// It is purely additive. The simple interval presets (cadenceSeconds) remain the default path; a
// downpipe only carries a `schedule` when the operator opts into the Advanced schedule disclosure
// and sets a cron and/or blackout windows. A config with NO schedule is byte-unchanged.
//
// HONESTY (the load-bearing reason this lives next to, not inside, the engine): the cron grammar,
// the timezone math, and the validation messages here MIRROR the engine's cron.ts / validateConfig
// EXACTLY (same 5-field grammar, same Vixie dom/dow union rule, same Intl-based wall-clock walk,
// same bounds + reasons). They are deliberately a small re-implementation of the engine's PUBLIC
// SEMANTICS for a pre-flight + a preview; the engine remains the authority and re-validates on save.
// If the two ever diverge the engine wins (it rejects), so the console can only ever be stricter or
// show a wrong-but-harmless preview, never let a bad schedule through.

import { SCHEDULE_MAX_BLACKOUT_WINDOWS, MINUTES_PER_DAY, type DownpipeSchedule, type BlackoutWindow } from "../api.ts";

// The cron grammar, the timezone validation, and the next-fire preview were extracted into sibling
// modules (console-src-021-01 structural split). They are RE-EXPORTED here so existing importers of
// schedule.ts keep their import paths unchanged; the public API of this module is identical.
export { validateCronExpr } from "./schedule-cron.ts";
export { SCHEDULE_TZ_DEFAULT, isValidTimeZone, browserTimeZone, COMMON_TIME_ZONES } from "./schedule-zone.ts";
export { nextCronFires } from "./schedule-preview.ts";

// SCHEDULE_TZ_DEFAULT is re-exported above (from schedule-zone.ts) and used below; import it for the
// local references in the assembler / summary.
import { SCHEDULE_TZ_DEFAULT, isValidTimeZone } from "./schedule-zone.ts";
import { validateCronExpr } from "./schedule-cron.ts";
import { recordWireAnomaly } from "./client-diag/ring.ts";

// ---- blackout-window time <-> minutes helpers (the wire shape is minutes-since-local-midnight) -----
// The UI captures windows as "HH:MM" wall-clock times; the wire carries startMinute/endMinute as
// minutes since local midnight (the engine's BlackoutWindow). These pure helpers convert between the
// two and are exported for the validator.

// parseTimeToMinutes parses "HH:MM" (24-hour) into minutes since midnight (0-1440), or null when the
// string is not a valid HH:MM. "24:00" is accepted as 1440 (end-of-day, the engine's inclusive upper
// bound), which lets a window end exactly at midnight.
export function parseTimeToMinutes(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (m === null) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || min < 0 || min > 59) return null;
  const total = h * 60 + min;
  if (total < 0 || total > MINUTES_PER_DAY) return null;
  return total;
}

// minutesToTime renders minutes-since-midnight (0-1440) as "HH:MM" (24-hour, zero-padded). 1440
// renders as "24:00" (the end-of-day sentinel), so a round-trip is stable.
//
// THE CLAMP IS A SILENT EDIT OF THE CUSTOMER'S SCHEDULE, and it is now recorded. An engine-supplied
// blackout bound outside 0..1440 (or a non-finite one) is coerced to the nearest legal value and renders as a
// perfectly plausible "24:00" or "00:00". The operator sees a normal window, has no way to know it is not the one
// stored, and their next save writes the CLAMPED value back over the real one. The masking and the rewrite are
// both invisible, which is exactly the "malformed engine wire values are masked at render time and never
// machine-flagged" this gap is named for.
//
// The coercion is KEPT (a form cannot render an illegal time), and it is now flagged. The VALUE never rides:
// the field class and the anomaly do, and nothing else.
//
// NOISE: it fires only when the input is genuinely outside the range or not a finite number. Every legitimate
// bound, 0 through 1440 inclusive, records nothing, and operator-typed times come in through parseTimeToMinutes,
// which rejects rather than clamps, so this path only ever sees values the ENGINE supplied.
export function minutesToTime(total: number): string {
  if (!Number.isFinite(total)) recordWireAnomaly("blackout-minute", "non-finite");
  // A NEGATIVE bound is recorded as `negative`, not `out-of-range` (R3). Both are true of it in plain English,
  // but this vocabulary's own definition of out-of-range is narrower than that: it means the value "PARSED, is
  // finite AND IS NOT NEGATIVE, and still lies outside the range". A member's name must not assert a fact the
  // code did not establish, and it must not coalesce two states that clamp in OPPOSITE directions: -5 clamps to
  // 00:00 (the window opens at midnight, earlier than stored) and 3000 clamps to 24:00 (it runs to end of day,
  // later than stored). `negative` already exists and fits exactly.
  else if (total < 0) recordWireAnomaly("blackout-minute", "negative");
  else if (total > MINUTES_PER_DAY) recordWireAnomaly("blackout-minute", "out-of-range");
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY, Math.round(Number.isFinite(total) ? total : 0)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ---- schedule validation (mirror of engine validateConfig's schedule block) ------------------------
// validateSchedule checks a console-built schedule against the SAME rules + bounds + messages the
// engine's validateConfig enforces, returning the first error string or null when valid (or when the
// schedule is undefined, the no-schedule default the engine accepts). The console rejects the same
// shapes the engine would, so the operator gets an inline reason before the POST.
export function validateSchedule(sch: DownpipeSchedule | undefined): string | null {
  if (sch === undefined) return null;
  if (typeof sch !== "object" || sch === null || Array.isArray(sch)) {
    return "schedule must be an object { cron?, timeZone?, blackoutWindows? }";
  }
  if (sch.timeZone !== undefined) {
    if (typeof sch.timeZone !== "string" || sch.timeZone.trim() === "") {
      return "schedule.timeZone must be a non-empty IANA time zone string";
    }
    if (!isValidTimeZone(sch.timeZone)) {
      return `schedule.timeZone "${sch.timeZone}" is not a known IANA time zone`;
    }
  }
  if (sch.cron !== undefined) {
    if (typeof sch.cron !== "string") return "schedule.cron must be a string";
    const cronErr = validateCronExpr(sch.cron);
    if (cronErr !== null) return `schedule.cron is invalid: ${cronErr}`;
  }
  if (sch.blackoutWindows !== undefined) {
    const windowsErr = validateBlackoutWindows(sch.blackoutWindows);
    if (windowsErr !== null) return windowsErr;
  }
  return null;
}

// validateBlackoutWindows checks the optional blackout-window array (split out of validateSchedule
// to keep that function's nesting shallow). Returns an error string or null when valid.
function validateBlackoutWindows(windows: unknown): string | null {
  if (!Array.isArray(windows)) {
    return "schedule.blackoutWindows must be an array";
  }
  if (windows.length > SCHEDULE_MAX_BLACKOUT_WINDOWS) {
    return `schedule.blackoutWindows must not exceed ${SCHEDULE_MAX_BLACKOUT_WINDOWS} windows`;
  }
  for (const w of windows) {
    if (typeof w !== "object" || w === null || Array.isArray(w)) {
      return "each blackout window must be an object { days?, startMinute, endMinute }";
    }
    if (!Number.isInteger(w.startMinute) || w.startMinute < 0 || w.startMinute > MINUTES_PER_DAY) {
      return `blackout window startMinute must be an integer 0-${MINUTES_PER_DAY} (minutes since local midnight)`;
    }
    if (!Number.isInteger(w.endMinute) || w.endMinute < 0 || w.endMinute > MINUTES_PER_DAY) {
      return `blackout window endMinute must be an integer 0-${MINUTES_PER_DAY} (minutes since local midnight)`;
    }
    // Mirror the engine's equal-start-end reject (config-validate.ts), so a fat-finger of the SAME time
    // in both boxes (02:00-02:00) is refused inline instead of drawing a late engine 400. The reason is the
    // engine's own, verbatim, so the two sides read identically.
    if (w.startMinute === w.endMinute) {
      return "blackout window startMinute and endMinute must differ (an equal start and end covers no time, so the window would never apply)";
    }
    if (w.days !== undefined) {
      if (!Array.isArray(w.days)) return "blackout window days must be an array of weekday numbers";
      for (const d of w.days) {
        if (!Number.isInteger(d) || d < 0 || d > 6) {
          return "blackout window days must be integers 0-6 (0 = Sunday)";
        }
      }
    }
  }
  return null;
}

// ---- the wire-object assembler --------------------------------------------------------------------
// ScheduleDraft is the raw, UI-captured form of an Advanced schedule before it becomes the wire
// object: the advanced toggle, the cron text, the timezone text, and the captured blackout windows
// (each already converted to minute fields, with the optional weekday filter). It is what the editor
// hands to assembleSchedule.
export interface BlackoutDraft {
  // The weekdays the window applies to (0=Sunday..6=Saturday). EMPTY = every day (the field is then
  // omitted from the wire object, matching the engine's "absent = every day").
  days: number[];
  startMinute: number;
  endMinute: number;
}

export interface ScheduleDraft {
  // Whether the operator opened the Advanced schedule disclosure AND chose to use it. When false, NO
  // schedule object is produced (the interval-preset back-compat path: cadenceSeconds only).
  advancedOn: boolean;
  // The cron text exactly as typed (may be empty: a schedule may carry ONLY blackout windows, which
  // still rides the interval cadence with the windows applied, the engine supports this).
  cron: string;
  // The IANA timezone text (may be empty: omitted from the wire = engine default UTC).
  timeZone: string;
  windows: BlackoutDraft[];
}

// assembleSchedule turns a ScheduleDraft into the wire `schedule` object, or undefined when the
// advanced path is off OR carries nothing meaningful (no cron, no windows, default/blank tz), so a
// plain interval downpipe sends NO schedule object and is byte-unchanged (back-compat). The fields
// are present only when they carry a real value (exactOptionalPropertyTypes-friendly):
//   - cron: included only when non-empty (trimmed).
//   - timeZone: included only when non-empty AND not the bare default "UTC" with nothing else to
//     anchor (we DO include an explicit non-UTC zone; an explicit "UTC" with a cron is also kept so
//     the operator's intent is recorded, but a blank tz is omitted to let the engine default).
//   - blackoutWindows: included only when there is at least one window; each window omits `days` when
//     it applies every day (empty list).
// This is a PURE function (no DOM, no validation side-effects); the caller validates the result with
// validateSchedule before sending. It is the single place the wire shape is built, so the validator
// can assert the exact object the editor would POST.
export function assembleSchedule(draft: ScheduleDraft): DownpipeSchedule | undefined {
  if (!draft.advancedOn) return undefined;

  const cron = draft.cron.trim();
  const tz = draft.timeZone.trim();
  const windows: BlackoutWindow[] = draft.windows.map((w) => ({
    ...(w.days.length > 0 ? { days: [...w.days].sort((a, b) => a - b) } : {}),
    startMinute: w.startMinute,
    endMinute: w.endMinute,
  }));

  // Nothing meaningful selected (no cron, no windows, and either no tz or just a bare default) -> no
  // schedule object at all, so the downpipe falls back to the interval cadence exactly as before.
  const hasCron = cron !== "";
  const hasWindows = windows.length > 0;
  const hasMeaningfulTz = tz !== "" && tz !== SCHEDULE_TZ_DEFAULT;
  if (!hasCron && !hasWindows && !hasMeaningfulTz) return undefined;

  const schedule: DownpipeSchedule = {
    ...(hasCron ? { cron } : {}),
    // Include the timezone when it is non-empty. A non-default zone anchors the cron/windows; an
    // explicit "UTC" alongside a cron or windows is harmless and records intent. A BLANK tz is
    // omitted so the engine applies its UTC default.
    ...(tz !== "" && (hasCron || hasWindows || hasMeaningfulTz) ? { timeZone: tz } : {}),
    ...(hasWindows ? { blackoutWindows: windows } : {}),
  };
  return schedule;
}

// scheduleSummary renders a calm one-line plain-words summary of a wire schedule for the drawer /
// confirmation. ABSENT reads as the interval default; a cron reads "Cron <expr> (<tz>)"; windows are
// summarised by count. Pure; the caller renders the string as a text node.
export function scheduleSummary(sch: DownpipeSchedule | undefined): string {
  if (sch === undefined) return "Uses the interval cadence above.";
  const parts: string[] = [];
  if (sch.cron !== undefined && sch.cron.trim() !== "") {
    parts.push(`Cron ${sch.cron.trim()} (${sch.timeZone && sch.timeZone.trim() !== "" ? sch.timeZone.trim() : SCHEDULE_TZ_DEFAULT})`);
  } else {
    parts.push("Interval cadence");
  }
  const n = sch.blackoutWindows?.length ?? 0;
  if (n > 0) parts.push(`${n} blackout window${n === 1 ? "" : "s"}`);
  return `${parts.join(", ")}.`;
}
