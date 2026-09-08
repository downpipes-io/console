// The /restore screen's "browse by date" modal: a small calendar over ONE downpipe's recent-run
// history ring (RunHistoryEntry[], engine GET /admin/history?id=), grouped and classified by
// lib/recovery-calendar.ts. Days with a successful run are marked; activating a day reveals that day's
// runs (any status, earliest first); picking a time dismisses the modal and deep-links to
// /restore/:runId exactly as run-picker.ts's runPickerRow does.
// This is a discovery-and-framing surface only: it reads the fleet's names and one downpipe's ring and
// otherwise touches nothing (no engine write, no state beyond which downpipe/month/day is showing).
//
// HONESTY. This calendar shows the RECENT-RUN
// HISTORY RING, a bounded view (RING_CAP = 50, engine/src/sched/scheduler-do-limits.ts:520) that is a
// DIFFERENT mechanism from the archive's retention policy, never a claim that one is always shorter than
// the other. A day before the ring's own floor is labelled as beyond the shown
// history, NEVER "outside the retained window" or "unrecoverable": a run that has rolled off the ring
// remains restorable by its id (engine/src/admin/restore-open.ts's openVerifiedRun reads the destination
// object store by runId and never consults the ring), exactly as run-context.ts:47-54 already tells an
// operator who lands on an off-ring run directly ("This run is not in the recent-run history, which is a
// bounded ring. You can still build a restore plan from its run id"). This screen names that limit
// plainly and offers a direct path to the run-id picker for anything older; see buildHonestyNote() below.
// See lib/recovery-calendar.ts's own header for the full reasoning (also covers the UTC pin and the
// floor-consistency fix).
//
// Every control here is a plain <button> (or a non-interactive <span> for a day with
// nothing to pick): no <select>, no typeable input, no radio, no aria-pressed/aria-checked/role=radio/
// role=switch toggle. The day cells use role="gridcell" + aria-selected (the ARIA grid pattern's own
// selection attribute, not a toggle role), so the grid describes its selection state honestly to assistive
// technology without introducing a hidden form control.
//
// House rules: Australian English, no em dashes, no rule-of-three.

import type { DownpipeState, EngineClient, RunHistoryEntry } from "../../api.ts";
import type { OverlayHandle } from "../../components/dialog.ts";
import { skeletonRows } from "../../components/feedback.ts";
import { openModal } from "../../components/modal.ts";
import { runStatusTone, statusWithLabel } from "../../components/status.ts";
import { h } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { absoluteTime, dateOnly } from "../../lib/format.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import {
  addMonthsUTC,
  type CalendarDay,
  type CalendarEntry,
  firstWeekdayUTC,
  isCurrentUTCMonth,
  monthGrid,
  monthLabel,
} from "../../lib/recovery-calendar.ts";
import { openRunPicker } from "./run-picker.ts";
import { legendSwatch } from "./shared.ts";
import { refuseWithReason } from "../common.ts";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

// A deliberately impossible instant: no real run can have completed at or before the Unix epoch. Querying
// runsAt with it always misses, and resolveRunAt computes its retainedFrom/retainedTo window bounds
// INDEPENDENTLY of the queried instant, attaching them to every miss (engine/src/admin/point-in-time.ts).
// So this is a clean, honest way to read the ring's AUTHORITATIVE floor straight from the live resolver,
// over the existing GET /admin/runs/at route, with no new engine surface.
const EPOCH_ZERO_ISO = "1970-01-01T00:00:00.000Z";

// openDateBrowser opens a modal OVER the /restore screen: a downpipe chooser (skipped when the fleet
// has exactly one downpipe), then a month calendar for the chosen downpipe's ring. Activating a time
// row dismisses the modal and deep-links to /restore/:runId, which auto-builds the dry-run plan --
// identical to openRunPicker's own mechanism, so the calendar is a second DISCOVERY path onto the same,
// unchanged restore flow (nothing downstream of the runId changes).
//
// onPick (the sibling of openRunPicker's own) overrides what happens on selection, and the restore flow
// passes one. The default deep-link re-mounts that flow from empty fields, which silently discards the
// target, the scope and the edit tokens the operator had already supplied on the runless landing; flow.ts's
// chooseRun decides between the bookmarkable URL and setting the run IN PLACE. It still closes the modal.
export function openDateBrowser(engine: EngineClient, onPick?: (runId: string) => void): void {
  const body = h("div", { class: "restore-calendar" });
  body.appendChild(skeletonRows(4));
  const handle = openModal({
    title: "Browse by date",
    body,
    wide: true,
    actions: [{ label: "Close", variant: "secondary", onClick: () => {} }],
  });

  // Named loadFleet (not "load"): run-picker.ts's own retry closure is already named "load", and giving
  // this one the same name would collide with, and renumber, that already-shipped identifier elsewhere.
  const loadFleet = (): void => {
    body.replaceChildren(skeletonRows(4));
    // listDownpipes is called directly (not the error-swallowing fetchDownpipeNames helper): a genuine
    // empty fleet and a FAILED read must read differently here, since the calendar's very first step is
    // choosing among live downpipe ids, not merely naming ones already known some other way.
    void engine
      .listDownpipes()
      .then((states) => {
        if (states.length === 0) {
          body.replaceChildren(
            h("p", { class: "field__hint" }, "No downpipes yet. A calendar appears here once a downpipe exists and has run."),
          );
          return;
        }
        if (states.length === 1) {
          const only = states[0] as DownpipeState;
          openForDownpipe(engine, body, handle, only, states, onPick);
          return;
        }
        renderDownpipeChooser(engine, body, handle, states, onPick);
      })
      .catch((err) => {
        if (isUnauthorised(err)) {
          handle.close();
          return goSignedOut();
        }
        body.replaceChildren(
          h(
            "div",
            { class: "stack-sm" },
            h("p", { class: "field__hint" }, "The downpipe list could not be read just now."),
            h("button", { "data-dp": "restore-flow.button.load-fleet", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => loadFleet() } }, "Try again"),
          ),
        );
      });
  };
  loadFleet();
}

// renderDownpipeChooser lists every downpipe as a button (never a <select>, see the module header): a
// multi-downpipe fleet picks which downpipe's ring to browse first, since a calendar reads awkwardly
// with several downpipes' runs overlaid on one grid.
function renderDownpipeChooser(engine: EngineClient, body: HTMLElement, handle: OverlayHandle, states: DownpipeState[], onPick?: (runId: string) => void): void {
  body.replaceChildren(
    h("p", { class: "field__hint" }, "Choose a downpipe to browse its recent-run calendar."),
    h(
      "div",
      { class: "run-picker" },
      ...states.map((s) =>
        h(
          "button",
          {
            "data-dp": "restore-flow.button.open-for-downpipe#1",
            class: "run-picker__row",
            type: "button",
            on: { click: () => openForDownpipe(engine, body, handle, s, states, onPick) },
          },
          h(
            "span",
            { class: "run-picker__main" },
            s.config.name ? s.config.name : h("span", { class: "mono" }, s.config.id),
            s.config.name ? h("span", { class: "run-picker__dp field__hint mono" }, ` ${s.config.id}`) : null,
          ),
        ),
      ),
    ),
  );
}

// openForDownpipe reads ONE downpipe's ring (GET /admin/history?id=, up to RING_CAP = 50 entries) and,
// on success, hands off to the calendar painter. This is lighter than the flat picker's fleet-wide
// listAllHistory() on a large fleet and is naturally per-downpipe (plan section 4).
function openForDownpipe(engine: EngineClient, body: HTMLElement, handle: OverlayHandle, state: DownpipeState, allStates: DownpipeState[], onPick?: (runId: string) => void): void {
  body.replaceChildren(skeletonRows(4));
  // The ring (for the grid + time lists) and the AUTHORITATIVE floor (runsAt, see EPOCH_ZERO_ISO above)
  // are read in parallel. A failed or unavailable runsAt read degrades to the ring's own client-computed
  // floor (recovery-calendar.ts's ringFloorMs, the identical rule) and never blocks the calendar: this is
  // a cross-check against the authoritative source, not a hard dependency of rendering it.
  const ringRead = engine.listHistory(state.config.id);
  const floorRead = engine.runsAt(state.config.id, EPOCH_ZERO_ISO).catch(() => null);
  void Promise.all([ringRead, floorRead])
    .then(([ring, resolved]) => {
      const parsed = resolved?.retainedFrom ? Date.parse(resolved.retainedFrom) : Number.NaN;
      const floorMsOverride = Number.isFinite(parsed) ? parsed : undefined;
      mountCalendar(engine, body, handle, state, allStates, ring, floorMsOverride, onPick);
    })
    .catch((err) => {
      if (isUnauthorised(err)) {
        handle.close();
        return goSignedOut();
      }
      const label = state.config.name || state.config.id;
      body.replaceChildren(
        h(
          "div",
          { class: "stack-sm" },
          h("p", { class: "field__hint" }, `The run history for ${label} could not be read just now.`),
          h(
            "button",
            { "data-dp": "restore-flow.button.open-for-downpipe#2", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => openForDownpipe(engine, body, handle, state, allStates, onPick) } },
            "Try again",
          ),
        ),
      );
    });
}

// mountCalendar owns the small in-modal state (which month is shown, which day is expanded) and repaints
// the whole body on every change; the ring itself is fetched once and never refetched for a month/day
// change (pure client-side re-slicing over an at-most-50-row array, cheap enough to always redraw fully
// rather than patch in place).
function mountCalendar(
  engine: EngineClient,
  body: HTMLElement,
  handle: OverlayHandle,
  state: DownpipeState,
  allStates: DownpipeState[],
  ring: RunHistoryEntry[],
  floorMsOverride: number | undefined,
  onPick?: (runId: string) => void,
): void {
  let monthAnchorMs = addMonthsUTC(Date.now(), 0); // the 1st of the current UTC month
  let selectedDay: string | null = null;
  let firstPaint = true;

  const paint = (): void => {
    const grid = monthGrid(ring, monthAnchorMs, floorMsOverride);
    if (firstPaint) {
      // Open on something useful rather than an inert grid: default to the LATEST restorable day already
      // visible in the current month, if there is one. Never re-applied after a deliberate month change
      // (the operator's own click always wins from here on).
      firstPaint = false;
      const latest = [...grid].reverse().find((d) => d.cls === "available");
      if (latest) selectedDay = latest.day;
    }
    body.replaceChildren(
      renderCalendarView({
        state,
        allStates,
        grid,
        monthAnchorMs,
        selectedDay,
        onChangeDownpipe: allStates.length > 1 ? () => renderDownpipeChooser(engine, body, handle, allStates, onPick) : null,
        onPrevMonth: () => {
          monthAnchorMs = addMonthsUTC(monthAnchorMs, -1);
          selectedDay = null;
          paint();
        },
        onNextMonth: () => {
          monthAnchorMs = addMonthsUTC(monthAnchorMs, 1);
          selectedDay = null;
          paint();
        },
        onDayPick: (day) => {
          selectedDay = day;
          paint();
        },
        onOpenRunPicker: () => {
          handle.close();
          openRunPicker(engine, onPick);
        },
        onPickRun: (runId) => {
          handle.close();
          if (onPick) onPick(runId);
          else navigate(`/restore/${encodeURIComponent(runId)}`);
        },
      }),
    );
  };
  paint();
}

interface CalendarViewArgs {
  state: DownpipeState;
  allStates: DownpipeState[];
  grid: CalendarDay[];
  monthAnchorMs: number;
  selectedDay: string | null;
  onChangeDownpipe: (() => void) | null;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onDayPick: (day: string) => void;
  onOpenRunPicker: () => void;
  onPickRun: (runId: string) => void;
}

// Exported for test/validate-gate-refusal-reachable.ts, which drives the at-current-month refusal on
// the Next control and asserts the paging callback is unreachable from it. Reaching it through
// openDateBrowser would mean driving a modal and a run fetch to test a month boundary.
export function renderCalendarView(args: CalendarViewArgs): HTMLElement {
  const { state, grid, monthAnchorMs, selectedDay } = args;
  const wrap = h("div", { class: "stack-sm" });

  if (args.onChangeDownpipe) {
    wrap.appendChild(
      h(
        "button",
        { "data-dp": "restore-flow.button.change-downpipe", class: "linklike", type: "button", on: { click: () => args.onChangeDownpipe?.() } },
        "Change downpipe",
      ),
    );
  }
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin:0" },
      "Recent-run calendar for ",
      state.config.name ? `${state.config.name} ` : "",
      h("span", { class: "mono" }, state.config.id),
      ".",
    ),
  );

  // Month navigation. Next is capped at the current UTC month: a future month is guaranteed empty, so
  // there is nothing honest to page forward into.
  const prevBtn = h(
    "button",
    { "data-dp": "restore-flow.button.prev", class: "btn btn--ghost btn--sm", type: "button", "aria-label": "Previous month", on: { click: () => args.onPrevMonth() } },
    "‹ Prev",
  );
  const atCurrentMonth = isCurrentUTCMonth(monthAnchorMs);
  const nextBtn = h(
    "button",
    {
      "data-dp": "restore-flow.button.next",
      class: "btn btn--ghost btn--sm",
      type: "button",
      "aria-label": "Next month",
      // The click is attached CONDITIONALLY, which it was not before. It used to ride in this attrs
      // object unconditionally and rely on `disabled` to have the browser swallow it. That is the one
      // thing that cannot survive dropping `disabled`, so the handler moves behind the same test the
      // refusal is behind, and the refusal below is then provably inert rather than inert by courtesy
      // of the browser.
      ...(atCurrentMonth ? {} : { on: { click: () => args.onNextMonth() } }),
    },
    "Next ›",
  );
  if (atCurrentMonth) refuseWithReason(nextBtn, "This is the current month; there is nothing to page forward into.");
  wrap.appendChild(
    h(
      "div",
      { class: "restore-calendar__nav" },
      prevBtn,
      h("h3", { class: "restore-calendar__month", "aria-live": "polite" }, monthLabel(monthAnchorMs)),
      nextBtn,
    ),
  );

  wrap.appendChild(buildGrid(grid, monthAnchorMs, selectedDay, args.onDayPick));
  wrap.appendChild(buildLegend());
  wrap.appendChild(buildHonestyNote(args.onOpenRunPicker));
  wrap.appendChild(buildTimeList(grid, selectedDay, state, args.onPickRun));

  return wrap;
}

// buildGrid renders the ARIA grid pattern (role="grid" > role="row" > role="gridcell"/"columnheader"):
// a weekday header row, then week rows padded with non-interactive leading blanks so day 1 lands under
// its correct weekday column. CSS (tokens.css .restore-calendar__week) lays each week out as a 7-column
// row; the blanks and the weekday header are aria-hidden decoration around the real gridcells.
function buildGrid(grid: CalendarDay[], monthAnchorMs: number, selectedDay: string | null, onDayPick: (day: string) => void): HTMLElement {
  const gridEl = h("div", { class: "restore-calendar__grid", role: "grid", "aria-label": `${monthLabel(monthAnchorMs)}, recent-run calendar` });

  const header = h("div", { class: "restore-calendar__week restore-calendar__weekdays", role: "row" });
  for (const wd of WEEKDAY_LABELS) {
    header.appendChild(h("span", { class: "restore-calendar__weekday", role: "columnheader", "aria-hidden": "true" }, wd));
  }
  gridEl.appendChild(header);

  const cells: HTMLElement[] = [];
  const leading = firstWeekdayUTC(monthAnchorMs);
  for (let i = 0; i < leading; i++) cells.push(h("span", { class: "cal-day cal-day--blank", "aria-hidden": "true" }));
  for (const d of grid) cells.push(renderDayCell(d, selectedDay, onDayPick));

  let row = h("div", { class: "restore-calendar__week", role: "row" });
  gridEl.appendChild(row);
  for (const cell of cells) {
    if (row.childElementCount === 7) {
      row = h("div", { class: "restore-calendar__week", role: "row" });
      gridEl.appendChild(row);
    }
    row.appendChild(cell);
  }
  return gridEl;
}

// renderDayCell: an "empty" or "beyond-ring" day is a plain, non-interactive gridcell (nothing to pick,
// so nothing is clickable); "available" and "failed-only" are buttons carrying role="gridcell" +
// aria-selected (the grid-pattern's own selection attribute, NOT aria-pressed/aria-checked/role=radio/
// role=switch, which is not the ARIA grid pattern's own selection attribute -- see the module header).
// The callback is named onSelectDay (not "onPick"): run-picker.ts's runPickerRow already owns "onPick"
// for its own click handler, and reusing that name here would collide with it.
function renderDayCell(d: CalendarDay, selectedDay: string | null, onSelectDay: (day: string) => void): HTMLElement {
  const label = dayCellLabel(d);
  const dayNum = String(Number(d.day.slice(8, 10)));
  if (d.cls === "empty" || d.cls === "beyond-ring") {
    return h(
      "span",
      { class: `cal-day cal-day--${d.cls}`, role: "gridcell", "aria-label": label },
      h("span", { class: "cal-day__num", "aria-hidden": "true" }, dayNum),
    );
  }
  const selected = d.day === selectedDay;
  return h(
    "button",
    {
      "data-dp": "restore-flow.button.select-day",
      class: `cal-day cal-day--${d.cls}${selected ? " cal-day--selected" : ""}`,
      type: "button",
      role: "gridcell",
      "aria-selected": selected ? "true" : "false",
      "aria-label": label,
      on: { click: () => onSelectDay(d.day) },
    },
    h("span", { class: "cal-day__num", "aria-hidden": "true" }, dayNum),
  );
}

function dayCellLabel(d: CalendarDay): string {
  const date = dateOnly(d.day);
  if (d.cls === "available") {
    const n = d.bucket?.entries.filter((e) => e.entry.status === "ok").length ?? 0;
    return `${date}, ${n} restorable ${n === 1 ? "run" : "runs"}. Activate to see the times.`;
  }
  if (d.cls === "failed-only") return `${date}, no successful run this day.`;
  if (d.cls === "beyond-ring") return `${date}, beyond the recent-run history shown here.`;
  return `${date}, no run.`;
}

// buildLegend explains the two marked states plus the honest discovery limit. "empty" carries no legend
// entry: it is the plain, unmarked default, exactly as an ordinary calendar day with nothing on it reads.
function buildLegend(): HTMLElement {
  const legend = h("div", { class: "run-strip__legend", "aria-hidden": "true" });
  legend.appendChild(legendSwatch("ok", "restorable"));
  legend.appendChild(legendSwatch("danger", "no successful run"));
  legend.appendChild(legendSwatch("neutral", "beyond the shown history"));
  return legend;
}

// buildHonestyNote is the load-bearing honesty affordance (the refuter's non-negotiable correction): it
// names the ring's own limit plainly and gives a direct, one-click path to the run-id picker, which DOES
// reach older, still-restorable runs. Mirrors run-context.ts's existing "not in the recent ring" wording
// so the two surfaces never disagree about what the ring boundary means.
function buildHonestyNote(onOpenRunPicker: () => void): HTMLElement {
  return h(
    "div",
    { class: "field__hint restore-calendar__honesty" },
    h(
      "p",
      { style: "margin:0" },
      "This calendar shows the recent-run history ring, a bounded list of recent runs, capped at fifty, which is a different thing from your archive's retention. A day beyond it is not a claim the archive is gone: an older run is still restorable by its id.",
    ),
    h(
      "button",
      { "data-dp": "restore-flow.button.open-run-picker", class: "linklike", type: "button", on: { click: () => onOpenRunPicker() } },
      "Browse all runs by id instead",
    ),
  );
}

// buildTimeList renders the selected day's runs (ANY status, earliest first -- the same inclusive
// listing run-picker.ts already shows, so a day with only a failed run still lets the operator see and
// pick it if they choose to). Absent selection, or a day with no bucket (nothing to list), shows a calm
// hint rather than an empty box.
function buildTimeList(grid: CalendarDay[], selectedDay: string | null, state: DownpipeState, onSelectRun: (runId: string) => void): HTMLElement {
  const bucket = selectedDay ? grid.find((d) => d.day === selectedDay)?.bucket : undefined;
  if (!bucket || bucket.entries.length === 0) {
    return h(
      "p",
      { class: "field__hint", role: "status" },
      selectedDay ? "No runs recorded for that day." : "Activate a highlighted day to see its times.",
    );
  }
  return h(
    "div",
    { class: "stack-sm" },
    h("h3", { class: "restore-subhead" }, `Runs on ${dateOnly(selectedDay as string)}`),
    h("div", { class: "run-picker" }, ...bucket.entries.map((e) => renderTimeRow(e, state, onSelectRun))),
  );
}

// renderTimeRow mirrors run-picker.ts's runPickerRow look and behaviour exactly (plan section 3: reuse
// the exact selection mechanism): activating it deep-links to /restore/:runId, auto-building the dry-run.
// The displayed time is the run's COMPLETION instant (the same instant this calendar groups and floors
// by, and the instant a point-in-time recovery target actually resolves to), with the start time in the
// title tooltip for an operator used to reading the run-picker's own started-at framing. A row with no
// runId (an unsealed placeholder) is never rendered: it is not a restore target. The callback is named
// onSelectRun (not "onPick"): run-picker.ts's own runPickerRow already owns "onPick".
function renderTimeRow(item: CalendarEntry, state: DownpipeState, onSelectRun: (runId: string) => void): HTMLElement | null {
  if (!item.entry.runId) return null;
  const { tone, label } = runStatusTone(item.entry.status);
  return h(
    "button",
    { "data-dp": "restore-flow.button.select-run", class: "run-picker__row", type: "button", on: { click: () => onSelectRun(item.entry.runId) } },
    h(
      "span",
      { class: "run-picker__main" },
      h("span", { class: "run-picker__run mono" }, item.entry.runId),
      h("span", { class: "run-picker__dp field__hint mono" }, state.config.id),
    ),
    h(
      "span",
      { class: "run-picker__meta" },
      statusWithLabel(tone, item.entry.status === "ok" ? "Sealed, ok" : label),
      h("span", { class: "run-picker__age field__hint", title: `Started ${absoluteTime(item.entry.startedAt)}` }, absoluteTime(item.completedAtMs)),
    ),
  );
}
