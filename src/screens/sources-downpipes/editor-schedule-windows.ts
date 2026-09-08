// Blackout-window repeater for the Advanced-schedule section, split out of ./editor-schedule.ts
// (move-only). Owns the maintenance-window row DOM and the read into a
// BlackoutDraft; the schedule section composes it and supplies the change callback for the live
// preview. The row markup, the id seeds, the cap, and readWindows() semantics are as they were
// inline, with the id seed moved from a random suffix to a monotonic counter.

import { h, svgIcon } from "../../lib/dom.ts";
import { field } from "../../components/field.ts";
import { parseTimeToMinutes, minutesToTime, type BlackoutDraft } from "../../lib/schedule.ts";
import { ICON_PLUS, ICON_TRASH } from "../../lib/icons.ts";
import { SCHEDULE_MAX_BLACKOUT_WINDOWS } from "../../api.ts";

// Monotonic id seed for label/input pairing. Deterministic and collision-free, so two
// windows never share a checkbox id (a random suffix can collide and silently break the
// label-to-checkbox association).
let _idSeq = 0;
const uid = (): number => ++_idSeq;

// A single mounted maintenance-window row and the inputs the read/validate paths poke at.
interface WindowRow {
  el: HTMLElement;
  dayChecks: HTMLInputElement[];
  startInput: HTMLInputElement;
  endInput: HTMLInputElement;
  error: HTMLElement;
}

// The repeater's public surface: the mountable host + add button, the rows (so assemble() can flag a
// half-filled row inline and focus it), and readWindows() (the single read into BlackoutDraft shape).
export interface WindowsRepeater {
  windowsHost: HTMLElement;
  addWindowBtn: HTMLButtonElement;
  rows: WindowRow[];
  readWindows: () => { windows: BlackoutDraft[]; bad: number[] };
  seedWindow: (w: { days: number[]; startMinute: number; endMinute: number }) => void;
}

// createWindowsRepeater builds the blackout-window repeater. WEEKDAYS is 0=Sunday..6=Saturday to
// match the engine's BlackoutWindow.days; onChange fires whenever a row is added, removed, or edited
// so the section can refresh its preview.
export function createWindowsRepeater(WEEKDAYS: string[], onChange: () => void): WindowsRepeater {
  const windowRows: WindowRow[] = [];
  const windowsHost = h("div", { class: "stack-md", style: "display:flex;flex-direction:column;gap:var(--space-3)" });

  const addWindowBtn = h(
    "button",
    { "data-dp": "sources-downpipes.button.add-window", class: "btn btn--secondary btn--sm", type: "button", style: "align-self:flex-start" },
    svgIcon(ICON_PLUS, { size: 14 }),
    "Add maintenance window",
  ) as HTMLButtonElement;

  function refreshAddBtn(): void {
    const atCap = windowRows.length >= SCHEDULE_MAX_BLACKOUT_WINDOWS;
    addWindowBtn.disabled = atCap;
    addWindowBtn.title = atCap ? `At most ${SCHEDULE_MAX_BLACKOUT_WINDOWS} windows.` : "";
  }

  function addWindowRow(seed?: { days: number[]; startMinute: number; endMinute: number }): void {
    if (windowRows.length >= SCHEDULE_MAX_BLACKOUT_WINDOWS) return;
    const seededDays = new Set(seed?.days ?? []);
    const dayChecks: HTMLInputElement[] = [];
    const dayToggles = h("div", { class: "sched-days", role: "group", "aria-label": "Weekdays this window applies to", style: "display:flex;flex-wrap:wrap;gap:var(--space-1) var(--space-2)" });
    WEEKDAYS.forEach((label, idx) => {
      const cbId = `dp-sched-win-${windowRows.length}-day-${idx}-${uid()}`;
      const cb = h("input", { type: "checkbox", id: cbId, value: String(idx), ...(seededDays.has(idx) ? { checked: true } : {}) }) as HTMLInputElement;
      dayChecks.push(cb);
      dayToggles.appendChild(h("label", { for: cbId, class: "sched-day", style: "display:inline-flex;align-items:center;gap:4px;font-size:var(--text-xs)" }, cb, label));
    });
    const daysHint = h("p", { class: "field__hint", style: "margin:0" }, "Tick weekdays to restrict this window, or leave all unticked for every day.");

    // The maintenance-blackout-windows doc section states this field's HH:MM 24-hour format,
    // the schedule timezone, start-inclusive/end-exclusive, the midnight wrap and 24:00 as end of day. The
    // link rides inside each window row here (not only at the group level) because a row is added at runtime,
    // so it cannot inherit a doc rendered once beside the group; that is why this one is not a duplicate.
    const startField = field({ id: `dp-sched-win-start-${windowRows.length}-${uid()}`, label: "Start (24h)", type: "time", value: seed !== undefined ? minutesToTime(seed.startMinute) : "", hint: "Local time in the timezone above.", doc: { href: "https://docs.downpipes.io/backing-up/overview", anchor: "maintenance-blackout-windows" } });
    const endField = field({ id: `dp-sched-win-end-${windowRows.length}-${uid()}`, label: "End (24h)", type: "time", value: seed !== undefined ? minutesToTime(seed.endMinute) : "", hint: "Exclusive. An end before the start wraps past midnight.", doc: { href: "https://docs.downpipes.io/backing-up/overview", anchor: "maintenance-blackout-windows" } });
    const rowError = h("p", { class: "field__error", role: "alert", hidden: true });

    const delBtn = h(
      "button",
      { "data-dp": "sources-downpipes.button.del#1", class: "btn btn--ghost btn--icon", type: "button", "aria-label": "Remove this maintenance window" },
      svgIcon(ICON_TRASH, { size: 16 }),
    );
    const timesRow = h("div", { style: "display:flex;gap:var(--space-3);flex-wrap:wrap;align-items:flex-end" }, startField.el, endField.el, delBtn);
    const rowEl = h(
      "div",
      { class: "card card--inset", style: "display:flex;flex-direction:column;gap:var(--space-2)" },
      daysHint,
      dayToggles,
      timesRow,
      rowError,
    );
    const entry: WindowRow = { el: rowEl, dayChecks, startInput: startField.control as HTMLInputElement, endInput: endField.control as HTMLInputElement, error: rowError };
    delBtn.addEventListener("click", () => {
      const idx = windowRows.indexOf(entry);
      if (idx >= 0) windowRows.splice(idx, 1);
      rowEl.remove();
      refreshAddBtn();
      onChange();
    });
    startField.control.addEventListener("input", () => onChange());
    endField.control.addEventListener("input", () => onChange());
    for (const cb of dayChecks) cb.addEventListener("change", () => onChange());
    windowRows.push(entry);
    windowsHost.appendChild(rowEl);
    refreshAddBtn();
  }

  addWindowBtn.addEventListener("click", () => {
    addWindowRow();
    onChange();
    windowRows[windowRows.length - 1]?.startInput.focus();
  });

  // readWindows reads the current window rows into the BlackoutDraft shape, parsing the HH:MM times to
  // minutes. A row with BOTH times blank is skipped (an unfilled row is not an error). A row with one
  // time present and the other blank/invalid sets bad so the caller can flag it; the returned draft
  // contains only the well-formed rows. Returns { windows, bad }.
  function readWindows(): { windows: BlackoutDraft[]; bad: number[] } {
    const windows: BlackoutDraft[] = [];
    const bad: number[] = [];
    windowRows.forEach((row, i) => {
      const startRaw = row.startInput.value.trim();
      const endRaw = row.endInput.value.trim();
      if (startRaw === "" && endRaw === "") return; // empty row, ignore
      const start = parseTimeToMinutes(startRaw);
      const end = parseTimeToMinutes(endRaw);
      if (start === null || end === null) {
        bad.push(i);
        return;
      }
      const days = row.dayChecks.filter((cb) => cb.checked).map((cb) => Number(cb.value));
      windows.push({ days, startMinute: start, endMinute: end });
    });
    return { windows, bad };
  }

  // Seed existing windows passed via the host's caller (editing an existing schedule).
  function seedWindow(w: { days: number[]; startMinute: number; endMinute: number }): void {
    addWindowRow(w);
  }

  refreshAddBtn();

  return { windowsHost, addWindowBtn, rows: windowRows, readWindows, seedWindow };
}
