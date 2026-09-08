// Shared leaf helpers for the command palette area: the dispatcher contract types, this
// screen's registry actions, the keycap renderer, the kind-hint phrasing and the
// zero-dependency fuzzy matcher. They live in this leaf so no sibling module imports
// another (which would form a cycle).

import { h, type Child } from "../../lib/dom.ts";
import type { ScreenAction } from "../common.ts";
import type { Command, CommandKind } from "../../shell/registry.ts";

// The dispatcher contract: the palette resolves WHICH command was chosen; it does not
// own app IO. The integrator passes a dispatch(command) when opening the palette. The
// built-in default handles the benign actions inline and routes a dangerous "flow" to
// its owning screen's route, so it NEVER executes a dangerous action inline.

// The dispatcher receives the chosen registry Command. For a non-navigate kind the
// Command.target is an action id (for example "restore.start"); the built-in defaultDispatch maps
// the well-known ones to the owning screen's route so a dangerous flow opens in context (never
// executes from the palette). The alias was transparent (no narrower contract than Command), so
// Command is used directly here.
export type PaletteDispatch = (command: Command) => void | Promise<void>

export interface OpenPaletteOptions {
  // The render context (caller + engine), so the palette gates exactly as the screen
  // and the registry do. When omitted the palette reads the live store directly.
  ctx?: Pick<import("../common.ts").ScreenContext, "caller" | "engine"> | null;
  // The integrator's dispatcher. Omitted -> the built-in defaultDispatch.
  dispatch?: PaletteDispatch;
  // The full action set, so the palette is fed by the ONE registry the integrator
  // assembles: allScreenActions(SCREENS) folded into the static COMMANDS. The palette still
  // applies the role + engine-state `when` gate to whatever it
  // is given, so the gating is identical to the go-to layer and the cheat-sheet. Omitted
  // -> the palette uses the static COMMANDS + this screen's own actions, which is the
  // correct day-one set before the integrator threads the elevated screens' actions in.
  commands?: Command[];
}

// paletteActions are the commands this screen owns in the one registry. Kept here so
// the screen is genuinely self-owned (it declares the route AND the actions). The IDs
// are distinct from the static COMMANDS so allScreenActions dedup never collides.
export function paletteActions(): ScreenAction[] {
  return [
    {
      id: "open-command-palette",
      title: "Open command palette",
      group: "Actions",
      kind: "action",
      keywords: ["command", "palette", "search", "run", "cmd k", "ctrl k"],
      target: "palette.open",
      shortcut: "Cmd K",
    },
    {
      id: "show-shortcuts",
      title: "Keyboard shortcuts",
      group: "Actions",
      kind: "navigate",
      keywords: ["keyboard", "shortcuts", "cheat sheet", "help", "keys", "chords"],
      target: "/command-palette",
      shortcut: "?",
    },
  ];
}

// keycaps renders a chord as a row of <kbd> caps. A sequential chord of single letters
// (the go-to chords, "g" then "o") reads "g then o"; a modifier combo ("Cmd" + "K") reads
// as adjacent caps. The "then" separator is aria-hidden (the caps carry the meaning).
export const MODIFIERS = new Set(["cmd", "ctrl", "shift", "alt", "opt", "option", "meta"]);

export function keycaps(keys: string[]): Child[] {
  const sequential = keys.length === 2 && keys.every((k) => k.length === 1) && !MODIFIERS.has(keys[0]!.toLowerCase());
  const out: Child[] = [];
  keys.forEach((k, i) => {
    if (i > 0 && sequential) {
      out.push(h("span", { class: "shortcut-row__then", "aria-hidden": "true" }, " then "));
    }
    out.push(h("kbd", { class: "kbd" }, k));
  });
  return out;
}

export function kindHint(kind: CommandKind): string {
  return kind === "flow" ? "opens a review flow" : kind === "navigate" ? "jumps" : "runs";
}

// ---------------------------------------------------------------------------
// The fuzzy subsequence matcher (zero-dependency, light scoring).
// ---------------------------------------------------------------------------

// The scoring weights, named so the relative balance is tunable in one place. The
// rationale: a hit is worth a small base; a consecutive run is rewarded progressively
// (run length added each step) so a tight match beats a scattered one; a match at a
// word boundary or string start gets a fixed bump; a match within the first
// SCORE_EARLINESS_THRESHOLD characters gets a small earliness nudge; and a full prefix
// or exact match is the strongest signal of all.
const SCORE_BASE_HIT = 1;
const SCORE_BOUNDARY_BONUS = 3;
const SCORE_EARLINESS_THRESHOLD = 8;
const SCORE_EARLINESS_BONUS = 1;
const SCORE_PREFIX_BONUS = 6;
const SCORE_EXACT_BONUS = 10;

// fuzzyScore returns a score + the matched character indices if `query` is a
// case-insensitive subsequence of `text`, or null otherwise. So "gd" ranks "Go to
// Downpipes" well and a scattered match ranks below a tight one. Kept small and
// allocation-light (it runs on every keystroke over the whole registry).
export function fuzzyScore(text: string, query: string): { score: number; indices: number[] } | null {
  if (query === "") return { score: 0, indices: [] };
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const indices: number[] = [];
  let ti = 0;
  let qi = 0;
  let score = 0;
  let run = 0;
  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) {
      indices.push(ti);
      score += SCORE_BASE_HIT;
      run += 1;
      score += run; // consecutive run bonus, grows with the run
      if (ti === 0 || isBoundary(text, ti)) score += SCORE_BOUNDARY_BONUS;
      if (ti < SCORE_EARLINESS_THRESHOLD) score += SCORE_EARLINESS_BONUS;
      qi += 1;
    } else {
      run = 0;
    }
    ti += 1;
  }
  if (qi < q.length) return null; // not a full subsequence
  if (t.startsWith(q)) score += SCORE_PREFIX_BONUS;
  if (t === q) score += SCORE_EXACT_BONUS;
  return { score, indices };
}

// isBoundary reports whether position i in `text` begins a new word (so a match there
// scores higher). True after a separator, or at a lower->upper camel transition.
export function isBoundary(text: string, i: number): boolean {
  const prev = text[i - 1];
  if (prev === undefined) return true;
  if (prev === " " || prev === "-" || prev === "/" || prev === "." || prev === "_") return true;
  const cur = text[i]!;
  return prev === prev.toLowerCase() && cur === cur.toUpperCase() && cur !== cur.toLowerCase();
}
