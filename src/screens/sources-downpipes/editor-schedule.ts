// Advanced-schedule disclosure section (engine DownpipeConfig.schedule), split out of ./editor.ts
// (move-only, B8-5). Exported so editor-upsert.ts mounts it; see ./editor.ts for the barrel.
//
// The section's static fields, blackout-window repeater, and live preview are factored into sibling
// modules (editor-schedule-fields.ts / editor-schedule-windows.ts / editor-schedule-preview.ts);
// this file orchestrates them and owns the assemble / showError closures.

import { h, svgIcon } from "../../lib/dom.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import {
  SCHEDULE_TZ_DEFAULT,
  assembleSchedule,
  type ScheduleDraft,
} from "../../lib/schedule.ts";
import type { DownpipeSchedule } from "../../api.ts";
import { validateForm } from "../../components/field.ts";
import { buildScheduleFields } from "./editor-schedule-fields.ts";
import { createWindowsRepeater } from "./editor-schedule-windows.ts";
import { createPreview } from "./editor-schedule-preview.ts";

// ---- Advanced schedule section (engine DownpipeConfig.schedule) --------------
// buildScheduleSection builds the collapsed "Advanced schedule" disclosure and returns its element
// plus the two methods the editor's submit path needs: assemble() (the wire `schedule` object, or
// undefined when the advanced path is off / empty, the interval-preset back-compat) and showError()
// (surface a reason inline, opening the disclosure). It is a SELF-CONTAINED closure: it owns the
// cron / timezone / blackout-window DOM and their live preview, and reads its own draft on demand.
//
// CALM: the disclosure is shut by default; the simple interval presets remain the default schedule.
// HONESTY: a cron fires at EXACT wall-clock times in the chosen zone (no jitter), but the engine
// dispatches on a ~15-minute pass, so a :07 cron lands at the next tick after :07, stated calmly in
// the cron tooltip so the operator is not surprised. CSP: every dynamic string reaches the DOM via
// textContent / the h() helper; no innerHTML of dynamic data; no inline on* handlers.
//
// All weekday helpers use 0=Sunday..6=Saturday to match the engine's BlackoutWindow.days + cron dow.
export function buildScheduleSection(existing: DownpipeSchedule | undefined): {
  el: HTMLElement;
  // assemble() returns the wire schedule (or undefined for the interval-only back-compat path) plus a
  // blocking error string when a window row is half-filled (one time set, the other blank/invalid). On
  // an error the schedule is undefined and the caller must NOT submit; the row error is already shown.
  assemble: () => { schedule: DownpipeSchedule | undefined; error: string | null };
  showError: (message: string) => void;
  // validateFields() runs the cron and timezone validators at SUBMIT (validate on blur, then
  // on submit), opening the disclosure and focusing the first refusal. It returns true when the advanced path is
  // OFF: the fields are then not part of the downpipe at all, and refusing (or recording) a stale value the
  // operator has already opted out of would be a fault raised on a legitimate state.
  validateFields: () => boolean;
} {
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // The opt-in. Seed ON when editing a downpipe that already carries a schedule, so the operator sees
  // and can edit the current schedule in place rather than it silently reverting to interval-only.
  const startsOn = existing !== undefined
    && ((existing.cron !== undefined && existing.cron.trim() !== "")
      || (existing.blackoutWindows !== undefined && existing.blackoutWindows.length > 0)
      || (existing.timeZone !== undefined && existing.timeZone.trim() !== "" && existing.timeZone.trim() !== SCHEDULE_TZ_DEFAULT));

  const { enableCheckbox, enableRow, tzField, tzDatalist, cronField, cronPreview } = buildScheduleFields(existing, startsOn);

  // The blackout-window repeater. refreshPreview is hoisted via the closure below; the repeater calls
  // it on any row add / remove / edit.
  const windows = createWindowsRepeater(WEEKDAYS, () => refreshPreview());
  const { windowsHost, addWindowBtn, rows: windowRows, readWindows } = windows;

  // Seed existing windows when editing.
  for (const w of existing?.blackoutWindows ?? []) {
    windows.seedWindow({ days: w.days ?? [], startMinute: w.startMinute, endMinute: w.endMinute });
  }

  // getDraft assembles the raw UI capture into a ScheduleDraft (the input to assembleSchedule). It is
  // the single read of the section's state; the preview, the assemble, and the validator all go
  // through it so they can never disagree.
  function getDraft(): ScheduleDraft {
    return {
      advancedOn: enableCheckbox.checked,
      cron: cronField.value(),
      timeZone: tzField.value(),
      windows: readWindows().windows,
    };
  }

  const refreshPreview = createPreview({ enableCheckbox, cronField, tzField, cronPreview, readWindows });

  cronField.control.addEventListener("input", refreshPreview);
  tzField.control.addEventListener("input", refreshPreview);
  enableCheckbox.addEventListener("change", () => {
    body.hidden = !enableCheckbox.checked;
    refreshPreview();
  });

  const sectionError = h("p", { class: "field__error", role: "alert", hidden: true });

  const body = h(
    "div",
    { class: "disclosure__body", hidden: !startsOn },
    tzField.el,
    tzDatalist,
    h("div", { class: "field" }, cronField.el, cronPreview),
    h(
      "div",
      { class: "field" },
      h("span", { class: "field__label" }, "Maintenance windows (no runs during these times)"),
      h("p", { class: "field__hint" }, "Optional. Each window is a start and end time (24-hour HH:MM) in the timezone above; an end before the start wraps past midnight. The engine defers a run that would land inside a window to the first moment after it; windows never cancel a run or move it earlier."),
      windowsHost,
      addWindowBtn,
      // Group-level doc link (audit G2): the per-row start/end time fields are one maintenance-window
      // control, so the link explaining how windows defer a run lives on the group, not on each row.
      h(
        "a",
        { class: "field__doc linklike", href: "https://docs.downpipes.io/backing-up/overview#maintenance-blackout-windows", target: "_blank", rel: "noreferrer noopener" },
        "About maintenance windows",
        svgIcon(ICON_EXTERNAL, { size: 13 }),
      ),
    ),
    sectionError,
  );

  const el = h(
    "details",
    { class: "disclosure" },
    h("summary", "Advanced schedule: cron, timezone, maintenance windows"),
    h("div", { class: "disclosure__body" }, enableRow, body),
  );

  // Initial preview render (covers the editing-an-existing-schedule case).
  refreshPreview();

  function showError(message: string): void {
    (el as HTMLDetailsElement).open = true;
    body.hidden = false;
    enableCheckbox.checked = true;
    sectionError.textContent = message;
    sectionError.hidden = false;
  }

  function assemble(): { schedule: DownpipeSchedule | undefined; error: string | null } {
    sectionError.hidden = true;
    sectionError.textContent = "";
    // Flag any malformed window rows inline before assembling (one time present, the other blank/bad).
    const { bad } = readWindows();
    windowRows.forEach((row, i) => {
      if (bad.includes(i)) {
        row.error.textContent = "Set both a start and an end time (24-hour, HH:MM), or clear both to remove this window.";
        row.error.hidden = false;
      } else {
        row.error.hidden = true;
        row.error.textContent = "";
      }
    });
    if (bad.length > 0) {
      (el as HTMLDetailsElement).open = true;
      body.hidden = false;
      windowRows[bad[0]!]?.startInput.focus();
      // A half-filled window row is a blocking error: do NOT assemble (an empty/half row would
      // otherwise be silently dropped, hiding the mistake). The row error is already shown.
      return { schedule: undefined, error: "Fix the highlighted maintenance window." };
    }
    return { schedule: assembleSchedule(getDraft()), error: null };
  }

  function validateFields(): boolean {
    if (!enableCheckbox.checked) return true;
    if (validateForm([tzField, cronField])) return true;
    (el as HTMLDetailsElement).open = true;
    body.hidden = false;
    return false;
  }

  return { el, assemble, showError, validateFields };
}
