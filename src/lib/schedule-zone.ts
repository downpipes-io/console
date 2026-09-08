// Timezone validation + the picker zone list, extracted from schedule.ts (console-src-021-01
// structural split). The console's CLIENT-SIDE mirror of the engine cron.ts isValidTimeZone probe.
// Behaviour is byte-identical to the original block.

// SCHEDULE_TZ_DEFAULT mirrors the engine: a schedule with no timeZone is interpreted in UTC.
export const SCHEDULE_TZ_DEFAULT = "UTC";

// ---- timezone validation (mirror of engine cron.ts isValidTimeZone) -------------------------------
// isValidTimeZone probes an IANA zone id with Intl.DateTimeFormat, returning false for an unknown
// zone (the engine rejects the same). A conformant runtime (the browser, like workerd) throws a
// RangeError constructing a formatter for an unknown zone.
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || timeZone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// browserTimeZone returns the browser's resolved IANA zone (e.g. "Australia/Sydney"), or
// SCHEDULE_TZ_DEFAULT when it cannot be read. Used to offer the operator their own zone as the
// sensible default in the picker, clearly labelled.
export function browserTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz.trim() !== "" && isValidTimeZone(tz) ? tz : SCHEDULE_TZ_DEFAULT;
  } catch {
    return SCHEDULE_TZ_DEFAULT;
  }
}

// COMMON_TIME_ZONES is a sensible, short IANA list for the picker datalist (the operator can still
// type any valid IANA zone; this is a convenience, not a closed set). UTC first, then a spread of
// common zones. Validation is by Intl, not membership, so an unlisted-but-valid zone is accepted.
export const COMMON_TIME_ZONES: string[] = [
  "UTC",
  "Australia/Sydney",
  "Australia/Perth",
  "Pacific/Auckland",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
];
