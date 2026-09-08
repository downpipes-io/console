// Stat tiles. A tile is the
// at-a-glance read of one engine fact: health, configuration readiness, licence tier,
// update availability, last-run-across-the-fleet, freshness. Anatomy: an uppercase
// muted label, a large tabular-numeral value, a one-line secondary, and optionally a
// status line (a hue + shape dot + a text label) or a trend sparkline.
//
// The honesty rule the whole product obeys lives here too: a tile NEVER shows green
// for unknown. The "unknown" state is first-class ("Unknown, could not reach the
// engine"), and the loading state is a skeleton in the value slot, so an unreachable
// engine reads honestly and a poll-driven value never jitters (tabular numerals).
//
// Accessibility: the label and the value are programmatically associated (the value's
// aria-labelledby points at the label id), so a screen reader announces "Engine
// health: healthy" as one unit; a status line is hue + shape + text (never colour
// alone); a sparkline carries its own text alternative (sparkline.ts). Built only
// from the .stat token primitive + dom.ts; the status-line and spark CSS hooks are
// in tokens.css.

import { h, type Child } from "../lib/dom.ts";
import { statusDot, type StatusTone } from "./status.ts";
import { sparkline, type SparklineOptions } from "./sparkline.ts";

let tileSeq = 0;

// The state a tile renders. "loaded" shows the value; "loading" shows a skeleton in
// the value slot (the rest of the tile keeps its shape); "unknown" shows the honest
// could-not-reach copy and a neutral dot, never a stale green.
export type StatState = "loaded" | "loading" | "unknown";

export interface StatTileOptions {
  // The uppercase label (e.g. "Engine health"). Real text; associated with the value.
  label: string;
  // The big value (string or number). For "loading"/"unknown" this is ignored.
  value?: Child;
  // A one-line secondary under the value (e.g. "v0.4.1" or "last good run 3h ago").
  secondary?: Child;
  // An optional status line shown beside/under the value: a hue + shape dot + a text
  // label. Use this when the tile encodes health.
  status?: { tone: StatusTone; label: string };
  // An optional trend sparkline (sparkline.ts handles its own text alternative).
  spark?: SparklineOptions;
  // The tile state. Defaults to "loaded".
  state?: StatState;
  // Honest unknown copy override (defaults to the standard could-not-reach phrase).
  unknownText?: string;
  // An optional click target turns the whole tile into a button (e.g. a tile that
  // routes to the surface it summarises). Kept accessible: a real <button> wrapper.
  onActivate?: () => void;
  // An optional title/tooltip for the tile (e.g. the absolute timestamp behind a
  // relative one).
  title?: string;
}

// buildValueRow renders the tile's value row for one state: a skeleton for "loading", the
// honest could-not-reach line for "unknown", and the big value plus optional status line for
// "loaded". Split out of statTile so each state branch is its own block and statTile reads as
// container + assembly.
function buildValueRow(state: StatState, opts: StatTileOptions, labelId: string): HTMLElement {
  // The value row: the big value plus, if present, the status line inline with it so
  // the dot sits next to the figure (the Obsidian tile treatment).
  const valueRow = h("div", { class: "stat__value-row" });
  if (state === "loading") {
    valueRow.appendChild(h("span", { class: "skeleton stat__value-skeleton", "aria-hidden": "true" }));
    // A visually-hidden live-friendly note so the tile is not silent while loading.
    valueRow.appendChild(h("span", { class: "visually-hidden" }, `${opts.label}: loading`));
  } else if (state === "unknown") {
    // Honest unknown: a neutral dot + the could-not-reach phrase, never a green tick.
    const text = opts.unknownText ?? "Unknown, could not reach the engine";
    valueRow.appendChild(statusDot("neutral", text));
    valueRow.appendChild(h("span", { class: "stat__unknown", "aria-labelledby": labelId }, text));
  } else {
    const valueEl = h("span", { class: "stat__value", "aria-labelledby": labelId });
    appendChild(valueEl, opts.value ?? "-");
    valueRow.appendChild(valueEl);
    if (opts.status) {
      // The status line is hue + shape (the dot) + the visible text label.
      valueRow.appendChild(
        h(
          "span",
          { class: "stat__statusline" },
          h("span", { class: `dot dot--${opts.status.tone}`, "aria-hidden": "true" }),
          h("span", opts.status.label),
        ),
      );
    }
  }
  return valueRow;
}

// statTile builds one tile. When onActivate is set the tile is a <button> (so it is
// keyboard-operable and announced as actionable); otherwise it is a plain region.
export function statTile(opts: StatTileOptions): HTMLElement {
  const state = opts.state ?? "loaded";
  const labelId = `stat-${++tileSeq}`;

  const labelEl = h("span", { class: "stat__label", id: labelId }, opts.label);
  const valueRow = buildValueRow(state, opts, labelId);

  const children: Child[] = [labelEl, valueRow];
  if (state === "loaded" && opts.secondary !== undefined && opts.secondary !== null) {
    const sec = h("span", { class: "stat__secondary" });
    appendChild(sec, opts.secondary);
    children.push(sec);
  }
  if (state === "loaded" && opts.spark) {
    children.push(h("div", { class: "stat__spark" }, sparkline(opts.spark)));
  }

  if (opts.onActivate) {
    const btn = h(
      "button",
      { "data-dp": "components-stat-tiles.button.stat-tile",
        class: "stat stat--button",
        type: "button",
        ...(opts.title ? { title: opts.title } : {}),
        on: { click: () => opts.onActivate!() },
      },
      ...children,
    );
    return btn;
  }
  // A non-interactive tile is a group so the label+value read together.
  return h(
    "div",
    { class: "stat", role: "group", "aria-labelledby": labelId, ...(opts.title ? { title: opts.title } : {}) },
    ...children,
  );
}

// statGrid lays out tiles on the responsive auto-fill grid (the .stat-grid token
// utility). Pass the built tiles; the grid handles the columns.
export function statGrid(...tiles: HTMLElement[]): HTMLElement {
  return h("div", { class: "stat-grid" }, ...tiles);
}

function appendChild(parent: HTMLElement, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (typeof child === "string" || typeof child === "number") {
    parent.appendChild(document.createTextNode(String(child)));
  } else {
    parent.appendChild(child);
  }
}
