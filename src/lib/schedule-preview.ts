// The bounded next-fire preview, extracted from schedule.ts (console-src-021-01 structural split).
// It computes the next few wall-clock fire times of a cron in a timezone, mirroring the engine's
// minute-walk, for a calm UI preview. The engine remains authoritative; this is a small client-side
// estimate. Behaviour is byte-identical to the original block.

import { MINUTES_PER_DAY, type BlackoutWindow } from "../api.ts";
import { type ConsoleCronSpec, parseCron } from "./schedule-cron.ts";
import { isValidTimeZone } from "./schedule-zone.ts";

// ---- next-fire preview (mirror of engine cron.ts nextFireAfter, bounded for the UI) ----------------
// The preview computes the next few wall-clock fire times of a cron in a timezone, mirroring the
// engine's minute-walk: decompose each candidate minute into the zone's wall-clock fields via Intl,
// test against the cron (Vixie dom/dow union), and on a match emit that epoch. It walks at most
// PREVIEW_MAX_SEARCH_MINUTES ahead (a bounded slice, not the engine's 4-year cap; the preview only
// needs the next handful, and a cron with no near fire just yields fewer/no rows, which the UI shows
// honestly as "no upcoming run found"). The blackout windows are applied so the preview reflects
// what the engine would actually schedule (a fire inside a window is deferred past it).

// A bounded forward search for the PREVIEW only (35 days of minutes). The engine searches 4 years
// to honour a Feb-29-only cron; the preview deliberately does not, to keep the walk cheap on the
// browser main thread (a once-a-month cron near the end of the window is the worst case, so the
// window is kept modest). A cron with no fire inside it just yields fewer/no rows, shown honestly.
const PREVIEW_MAX_SEARCH_MINUTES = 35 * 24 * 60;

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface WallTime {
  year: number;
  month: number;
  dom: number;
  hour: number;
  minute: number;
  dow: number;
}

// formatterFor builds (and the caller may reuse) an Intl formatter that renders a zone's wall-clock
// fields. Mirrors the engine's getFormatter options exactly (h23, 2-digit fields, short weekday).
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
}

// wallTimeInZone decomposes a UTC epoch (ms) into the target zone's wall-clock fields, via the
// formatter (mirror of the engine).
function wallTimeInZone(fmt: Intl.DateTimeFormat, epochMs: number): WallTime {
  const parts = fmt.formatToParts(new Date(epochMs));
  const get = (t: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour"));
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    dom: Number(get("day")),
    hour: hour === 24 ? 0 : hour,
    minute: Number(get("minute")),
    dow: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

// cronMatches applies the Vixie dom/dow union rule (the engine's cronMatches): both dom and dow
// restricted -> EITHER matches; one "*" -> only the other constrains; both "*" -> always.
function cronMatches(spec: ConsoleCronSpec, w: WallTime): boolean {
  if (!spec.minute.values.has(w.minute)) return false;
  if (!spec.hour.values.has(w.hour)) return false;
  if (!spec.month.values.has(w.month)) return false;
  const domOK = spec.dom.values.has(w.dom);
  const dowOK = spec.dow.values.has(w.dow);
  if (spec.dom.star && spec.dow.star) return true;
  if (spec.dom.star) return dowOK;
  if (spec.dow.star) return domOK;
  return domOK || dowOK;
}

// zoneOffsetMs / wallFieldsToEpoch mirror the engine: convert target-zone wall-clock fields back to
// a UTC epoch, resolving DST by measuring the zone offset at the candidate instant (two iterations
// settle every real zone, including across a transition).
function zoneOffsetMs(fmt: Intl.DateTimeFormat, epochMs: number): number {
  const w = wallTimeInZone(fmt, epochMs);
  const asUTC = Date.UTC(w.year, w.month - 1, w.dom, w.hour, w.minute, 0, 0);
  const flooredEpoch = Math.floor(epochMs / 60000) * 60000;
  return asUTC - flooredEpoch;
}

function wallFieldsToEpoch(fmt: Intl.DateTimeFormat, y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  const o1 = zoneOffsetMs(fmt, guess);
  let epoch = guess - o1;
  const o2 = zoneOffsetMs(fmt, epoch);
  if (o2 !== o1) epoch = guess - o2;
  return epoch;
}

// localMinuteOfDay returns the wall-clock minute-of-day (0-1439) + weekday for an epoch in the zone,
// mirroring the engine helper the blackout-window logic uses.
function localMinuteOfDay(fmt: Intl.DateTimeFormat, epochMs: number): { minuteOfDay: number; dow: number } {
  const w = wallTimeInZone(fmt, epochMs);
  return { minuteOfDay: w.hour * 60 + w.minute, dow: w.dow };
}

// windowCoversLocalMinute mirrors the engine's blackout membership test: a window blacks out
// [startMinute, endMinute) (or, when startMinute > endMinute, the wrap [start,1440) U [0,end)),
// gated by the optional `days` filter (absent = every day). startMinute === endMinute is an EMPTY
// window (covers nothing), matching the engine's half-open interval.
function windowCoversLocalMinute(w: BlackoutWindow, minuteOfDay: number, dow: number): boolean {
  if (w.days !== undefined && w.days.length > 0 && !w.days.includes(dow)) return false;
  if (w.startMinute === w.endMinute) return false;
  if (w.startMinute < w.endMinute) return minuteOfDay >= w.startMinute && minuteOfDay < w.endMinute;
  // Wrapping window past midnight.
  return minuteOfDay >= w.startMinute || minuteOfDay < w.endMinute;
}

// deferredPastBlackouts pushes a candidate fire forward minute-by-minute while it lands inside any
// active blackout window, mirroring the spirit of the engine's deferPastBlackouts (windows only ever
// push a fire LATER). Bounded by a day of minutes per hop; returns the original epoch when no window
// covers it. The preview applies this so the rows reflect what the engine would actually run.
function deferredPastBlackouts(fmt: Intl.DateTimeFormat, epochMs: number, windows: BlackoutWindow[]): number {
  if (windows.length === 0) return epochMs;
  let cursor = epochMs;
  // At most a few days of deferral across stacked windows; a pathological set just yields the last
  // cursor, which the preview shows honestly (it is only an estimate, the engine is authoritative).
  for (let i = 0; i <= (MINUTES_PER_DAY + 1) * 4; i++) {
    const { minuteOfDay, dow } = localMinuteOfDay(fmt, cursor);
    const covered = windows.some((w) => windowCoversLocalMinute(w, minuteOfDay, dow));
    if (!covered) return cursor;
    cursor += 60000;
  }
  return cursor;
}

// nextCronFires computes up to `count` upcoming fire epochs (ms) for a cron in an IANA timezone,
// strictly after `fromMs`, applying the blackout windows. Returns [] when the cron is malformed, the
// zone is unknown, or no fire is found within the bounded preview window, the UI renders an honest
// "no upcoming run found" rather than inventing times. This MIRRORS the engine's nextFireAfter
// minute-walk semantics (DST-correct, fall-back de-dup) for a small client-side estimate; the engine
// remains authoritative and may differ at the margins (e.g. a Feb-29-only cron beyond the preview
// window), which is why the UI labels it an estimate.
export function nextCronFires(
  expr: string,
  timeZone: string,
  count: number,
  fromMs: number = Date.now(),
  windows: BlackoutWindow[] = [],
): number[] {
  let spec: ConsoleCronSpec;
  try {
    spec = parseCron(expr);
  } catch {
    return [];
  }
  if (!isValidTimeZone(timeZone)) return [];
  if (!Number.isFinite(fromMs) || count <= 0) return [];

  const fmt = formatterFor(timeZone);
  const fires: number[] = [];
  let cursor = Math.floor(fromMs / 60000) * 60000 + 60000;
  let prevFrom = fromMs;

  for (let i = 0; i < PREVIEW_MAX_SEARCH_MINUTES && fires.length < count; i++) {
    const w = wallTimeInZone(fmt, cursor);
    if (cronMatches(spec, w)) {
      const fire = wallFieldsToEpoch(fmt, w.year, w.month, w.dom, w.hour, w.minute);
      // Strictly-after guard (mirrors the engine): across a fall-back overlap the wall minute can map
      // to an earlier instant than the cursor, so skip a fire that is not strictly after the source.
      if (fire > prevFrom) {
        const deferred = deferredPastBlackouts(fmt, fire, windows);
        fires.push(deferred);
        // Advance the "from" past this emitted fire (use the pre-deferral fire so the next cron match
        // is found correctly; the deferral only affects the displayed instant, not the cron cursor).
        prevFrom = fire;
      }
    }
    cursor += 60000;
  }
  return fires;
}
