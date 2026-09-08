// Live next-runs preview for the Advanced-schedule section, split out of ./editor-schedule.ts
// (move-only). The section wires this onto every relevant input.
//
// The preview no longer OWNS the cron and timezone refusals. It used to write the cron error into a
// bespoke node and call tzField.setError() directly, both of which bypass field()'s validate() funnel, so the
// console's commonest refusal ("the form will not accept my cron") left no evidence anywhere. Both controls now
// carry the validator (editor-schedule-fields.ts) and refuse through the funnel on blur and on submit. The
// preview still READS the same two functions, but only to decide what it can show; it renders no error of its
// own, and it never records (it runs on every keystroke, and a half-typed cron is not a refusal).

import { h, svgIcon } from "../../lib/dom.ts";
import type { Field } from "../../components/field.ts";
import {
  validateCronExpr,
  isValidTimeZone,
  SCHEDULE_TZ_DEFAULT,
  nextCronFires,
  type BlackoutDraft,
} from "../../lib/schedule.ts";
import { ICON_INFO, ICON_RUNS } from "../../lib/icons.ts";

// The dependencies the preview reads: the toggle, the cron / timezone fields, the read of the current
// windows, and the two DOM slots it writes (the inline cron error and the next-runs list).
export interface PreviewDeps {
  enableCheckbox: HTMLInputElement;
  cronField: Field;
  tzField: Field;
  cronPreview: HTMLElement;
  readWindows: () => { windows: BlackoutDraft[]; bad: number[] };
}

// createPreview returns refreshPreview, which recomputes the inline cron error + the next-runs preview
// from the current draft. It runs on every relevant input and on toggle. Honest: it shows the engine's
// own cron error message for a malformed expression, an unknown-timezone note, and otherwise the next
// 3 fire times (with the blackout windows applied) computed client-side, labelled an estimate, since
// the engine is authoritative and dispatches on a ~15-minute pass.
export function createPreview(deps: PreviewDeps): () => void {
  const { enableCheckbox, cronField, tzField, cronPreview, readWindows } = deps;

  return function refreshPreview(): void {
    cronPreview.replaceChildren();
    if (!enableCheckbox.checked) return;

    const cron = cronField.value().trim();
    const tzRaw = tzField.value().trim();
    const tz = tzRaw === "" ? SCHEDULE_TZ_DEFAULT : tzRaw;

    if (cron === "") {
      cronPreview.replaceChildren(
        svgIcon(ICON_INFO, { size: 14 }),
        h("span", "No cron set: this downpipe keeps the interval cadence above; any maintenance windows still apply."),
      );
      return;
    }

    // A malformed cron or an unknown zone is refused by the field itself (on blur / on submit), with the message
    // under the control. Here the preview simply has nothing honest to show, so it shows nothing rather than
    // guessing at the next run times.
    if (validateCronExpr(cron) !== null) return;
    if (!isValidTimeZone(tz)) {
      cronPreview.replaceChildren(svgIcon(ICON_INFO, { size: 14 }), h("span", "Enter a valid timezone to preview the next runs."));
      return;
    }

    const { windows } = readWindows();
    const fires = nextCronFires(cron, tz, 3, Date.now(), windows.map((w) => ({ ...(w.days.length > 0 ? { days: w.days } : {}), startMinute: w.startMinute, endMinute: w.endMinute })));
    if (fires.length === 0) {
      cronPreview.replaceChildren(svgIcon(ICON_INFO, { size: 14 }), h("span", "No upcoming run found in the next few months for this expression. Check the day-of-month / month fields."));
      return;
    }
    const fmt = new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const list = h("ul", { style: "margin:2px 0 0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:2px" });
    for (const f of fires) {
      // Each fire time rendered in the chosen zone via Intl; textContent only.
      list.appendChild(h("li", { class: "mono", style: "font-size:var(--text-xs)" }, fmt.format(new Date(f))));
    }
    cronPreview.replaceChildren(
      h("div", { style: "display:flex;align-items:center;gap:var(--space-2)" }, svgIcon(ICON_RUNS, { size: 14 }), h("span", `Next runs (estimate, ${tz}):`)),
      list,
    );
  };
}
