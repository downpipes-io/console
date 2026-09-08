// Static field construction for the Advanced-schedule section, split out of ./editor-schedule.ts
// (move-only). Builds the enable row, the timezone field + datalist, and the
// cron field + its live next-runs preview slot.
//
// The cron and the timezone now carry a `validate`, so they refuse THROUGH THE FIELD FUNNEL like every
// other control in the console. They did not before: the cron's refusal was hand-rolled into a bespoke error node
// by the live preview, and the timezone's was written with a direct setError(). Neither ran field()'s validate(),
// so "the form will not accept my cron" -- the ticket, verbatim -- produced no row anywhere, and was
// indistinguishable from no refusal at all. The validators are the same two functions the preview already called
// (validateCronExpr, the mirror of the engine's validateCron; isValidTimeZone, the mirror of its Intl probe), so
// the console refuses exactly what it refused before, at blur and at submit rather than on every keystroke, which
// is the design system's rule for every other field.

import { h } from "../../lib/dom.ts";
import { field, type Field } from "../../components/field.ts";
import { infoTip } from "../../components/info-tip.ts";
import { browserTimeZone, COMMON_TIME_ZONES, SCHEDULE_TZ_DEFAULT, isValidTimeZone, validateCronExpr } from "../../lib/schedule.ts";
import type { DownpipeSchedule } from "../../api.ts";

// The constructed schedule fields the section wires up: the opt-in checkbox + its row, the timezone
// field (with its datalist already wired via the list attribute), and the cron field with its inline
// error + live next-runs preview slots.
export interface ScheduleFields {
  enableCheckbox: HTMLInputElement;
  enableRow: HTMLElement;
  tzField: Field;
  tzDatalist: HTMLElement;
  cronField: Field;
  cronPreview: HTMLElement;
}

// buildScheduleFields constructs the static inputs for the section. startsOn seeds the opt-in ON when
// editing a downpipe that already carries a meaningful schedule.
export function buildScheduleFields(existing: DownpipeSchedule | undefined, startsOn: boolean): ScheduleFields {
  const enableCheckbox = h("input", { type: "checkbox", id: "dp-sched-advanced" }) as HTMLInputElement;
  enableCheckbox.checked = startsOn;
  const enableRow = h(
    "div",
    { class: "checkbox-row" },
    enableCheckbox,
    h(
      "label",
      { for: "dp-sched-advanced" },
      "Use a cron schedule and/or maintenance windows",
      infoTip(
        "Off keeps the simple interval above. On lets you set an exact cron time (in a timezone, DST-correct) and/or windows the engine must not run in. A cron fires at the exact minute you set with no jitter, but the engine checks schedules about every 15 minutes, so a time like 07:07 runs at the next check after 07:07, not to the second.",
        { label: "About advanced scheduling" },
      ),
    ),
  );

  // The timezone input, backed by a datalist of common IANA zones (the operator may type any valid
  // IANA zone; validation is by Intl, not membership). Defaults to the existing zone, else the
  // browser's resolved zone, clearly labelled; UTC is always offered first.
  const browserTz = browserTimeZone();
  const tzListId = "dp-sched-tz-list";
  const tzDatalist = h("datalist", { id: tzListId });
  for (const z of COMMON_TIME_ZONES) tzDatalist.appendChild(h("option", { value: z }));
  const tzField = field({
    id: "dp-sched-tz",
    label: "Timezone",
    value: existing?.timeZone ?? browserTz,
    hint: browserTz === SCHEDULE_TZ_DEFAULT
      ? "A case-sensitive IANA zone name the cron and windows are read in (e.g. Australia/Sydney), not a UTC offset. Defaults to UTC."
      : `A case-sensitive IANA zone name the cron and windows are read in, not a UTC offset. Your browser zone is ${browserTz}; UTC is the engine default.`,
    placeholder: "UTC",
    doc: { href: "https://docs.downpipes.io/backing-up/overview", anchor: "the-fifteen-minute-floor" },
    // Blank means the engine default (UTC), which is why an empty zone is not a refusal.
    validate: (v) => (v === "" || isValidTimeZone(v) ? null : `"${v}" is not a known IANA time zone.`),
  });
  tzField.control.setAttribute("list", tzListId);
  tzField.control.classList.add("mono");

  // The cron expression input + its inline error + a live human-readable next-runs preview.
  const cronField = field({
    id: "dp-sched-cron",
    label: "Cron expression (5 fields: minute hour day-of-month month day-of-week)",
    value: existing?.cron ?? "",
    hint: "Standard 5-field crontab (minute hour day-of-month month day-of-week), e.g. 0 2 * * * (02:00 daily), 30 1 * * 1 (01:30 each Monday), */15 * * * * (every 15 min). The engine dispatches on a ~15-minute tick, so a time like 07:07 fires at the next tick after 07:07, not to the second. Leave blank to keep the interval cadence above but still apply any maintenance windows below.",
    placeholder: "0 2 * * *",
    doc: { href: "https://docs.downpipes.io/backing-up/overview", anchor: "the-fifteen-minute-floor" },
    // Blank is legitimate and documented: the downpipe keeps the interval cadence above and the windows still
    // apply. Only a NON-EMPTY expression the console cannot parse is a refusal.
    validate: (v) => (v === "" ? null : validateCronExpr(v)),
  });
  cronField.control.classList.add("mono");
  const cronPreview = h("div", { class: "sched-nextrun", role: "status", "aria-live": "polite" });

  return { enableCheckbox, enableRow, tzField, tzDatalist, cronField, cronPreview };
}
