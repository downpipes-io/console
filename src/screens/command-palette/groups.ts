// Building the grouped rows from the one registry + the fuzzy matcher. buildGroups turns
// the current query into grouped, role-gated, fuzzy-ranked items; collectCommands resolves
// the role + engine-state-gated command set from the ONE registry; engineStateFor derives
// the small engine-state facts a command's `when` may gate on; actionToCommand adapts this
// screen's own actions to the Command shape. These hold no module state; they are a leaf so
// the overlay's instant static render imports them from one place. Moved verbatim from the
// overlay for size; behaviour is unchanged. House rules: Australian English, no em dashes,
// precise claims.

import type { ScreenContext, ScreenAction } from "../common.ts";
import { getDownpipesCache } from "../../lib/store.ts";
import { COMMANDS, type Command } from "../../shell/registry.ts";
import type { EngineClient } from "../../api.ts";
import { paletteActions, fuzzyScore, type PaletteDispatch } from "./shared.ts";
import { runCommand } from "./routing.ts";
import { toast } from "../../components/toast.ts";
import { toBuiltItem, type RowGroup, type BuiltItem } from "./rows.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { goSignedOut } from "../../lib/nav.ts";

// Scored is one fuzzy-ranked command plus the title match ranges to highlight.
interface Scored {
  cmd: Command;
  score: number;
  matches: number[];
}

// PaletteEngineState is the small set of engine-state facts a command's `when` may gate on. Every
// field is optional, so an unknown reads as undefined and a `when` should not hide a command on it.
interface PaletteEngineState {
  ready?: boolean;
  downpipeCount?: number;
  updateAvailable?: boolean;
  connected?: boolean;
}

// buildGroups turns the current query into grouped, role-gated, fuzzy-ranked items
// from the one registry (static COMMANDS + this screen's own actions; the async entity
// rows are appended separately). It returns the grouped structure; paintList builds the
// DOM and the flat run-able row list from it.
export function buildGroups(args: {
  query: string;
  ctx: Pick<ScreenContext, "caller" | "engine">;
  dispatch: PaletteDispatch;
  close: () => void;
  // The integrator's assembled registry (allScreenActions + COMMANDS), or undefined to
  // use the static COMMANDS + this screen's own actions.
  supplied: Command[] | undefined;
}): RowGroup[] {
  const { query, ctx, dispatch, close, supplied } = args;
  const visible = collectCommands(ctx, supplied);

  // Score + filter. Empty query: keep all (contextual order: Navigation first, then
  // the rest as authored). Non-empty: fuzzy subsequence match on title + keywords.
  const scored: Scored[] = [];
  for (const cmd of visible) {
    if (query === "") {
      scored.push({ cmd, score: 0, matches: [] });
      continue;
    }
    const titleMatch = fuzzyScore(cmd.title, query);
    const kwHay = cmd.keywords.join(" ");
    const kwMatch = fuzzyScore(kwHay, query);
    // Prefer a title hit (and carry its match ranges for highlighting); fall back to a
    // keyword hit (no title ranges to highlight, which is correct). Neither hit means the
    // command does not match the query.
    let best: { score: number; indices: number[] };
    if (titleMatch && (!kwMatch || titleMatch.score >= kwMatch.score)) {
      best = titleMatch;
    } else if (kwMatch) {
      best = kwMatch;
    } else {
      continue;
    }
    scored.push({ cmd, score: best.score, matches: titleMatch ? titleMatch.indices : [] });
  }
  if (query !== "") scored.sort((a, b) => b.score - a.score);

  // Group in the canonical order (Navigation, Downpipes, Runs, Actions).
  const order: Command["group"][] = ["Navigation", "Downpipes", "Runs", "Actions"];
  const byGroup = new Map<string, BuiltItem[]>();
  for (const g of order) byGroup.set(g, []);
  for (const s of scored) {
    const item = toBuiltItem(s.cmd, s.matches, () => {
      close();
      // The built-in dispatch is synchronous, but an integrator-supplied dispatcher may reject
      // (for example a network error on an inline action). The palette has already closed, so
      // surface the failure as a toast rather than letting the rejection vanish.
      runCommand(s.cmd, dispatch).catch((err) => {
        // A palette action can be any integrator-supplied dispatcher, so no specific classification is
        // possible here; a 401 still gets its own honest route (the palette has already closed, and
        // this is the one place that dispatch's rejection is ever seen), and every other failure gets a
        // customer sentence rather than the raw engine transport string ("<verb>: <status>").
        if (isUnauthorised(err)) return void goSignedOut();
        toast({ message: `Could not complete "${s.cmd.title}". Try again.`, tone: "warn" });
      });
    });
    byGroup.get(s.cmd.group)!.push(item);
  }

  const groups: RowGroup[] = [];
  for (const g of order) {
    const items = byGroup.get(g)!;
    if (items.length > 0) groups.push({ label: g, items });
  }
  return groups;
}

// collectCommands resolves the role + engine-state-gated command set the palette
// shows, from the ONE registry. The base list is either the
// integrator's assembled registry (allScreenActions(SCREENS) + COMMANDS, passed in) or,
// when none is supplied, the static COMMANDS, in both cases plus this screen's own
// actions (open palette, show shortcuts). Every command is filtered through its own
// `when(caller, engineState)` so the gating is identical to the go-to layer and the
// cheat-sheet; a command the role cannot run is dropped, so the palette never lists one
// that 403s. Deduplicated by id (first wins, matching allScreenActions).
export function collectCommands(ctx: Pick<ScreenContext, "caller" | "engine">, supplied?: Command[]): Command[] {
  const engineState = engineStateFor(ctx.engine);
  const base = supplied ?? COMMANDS;
  const gateCtx = { caller: ctx.caller, engine: engineState };

  const seen = new Set<string>();
  const out: Command[] = [];
  const consider = (cmd: Command) => {
    if (seen.has(cmd.id)) return;
    if (cmd.when && !cmd.when(gateCtx)) return; // the gate IS the registry's own `when`
    seen.add(cmd.id);
    out.push(cmd);
  };
  for (const cmd of base) consider(cmd);
  // The palette's own screen actions, adapted to the Command shape and gated the same
  // way, so its commands are present even when the static COMMANDS do not list them.
  for (const a of paletteActions()) {
    const cmd = actionToCommand(a);
    const passes = a.when ? a.when(gateCtx) : true;
    if (passes) consider(cmd);
  }
  return out;
}

// engineStateFor derives the small engine-state facts a command's `when` may gate on,
// from the connected client. The palette does not block on a fetch to build these; it
// uses the cheaply-known facts (connected, and the cached downpipe count). ready /
// updateAvailable are left undefined unless the screen passed them, so a `when` that
// reads them treats them as unknown (it should not hide a command on an unknown).
function engineStateFor(engine: EngineClient | null): PaletteEngineState {
  const cache = getDownpipesCache();
  return {
    connected: engine !== null,
    ...(cache ? { downpipeCount: cache.length } : {}),
  };
}

function actionToCommand(a: ScreenAction): Command {
  return {
    id: a.id,
    title: a.title,
    group: a.group,
    kind: a.kind,
    keywords: a.keywords,
    target: a.target,
    ...(a.shortcut !== undefined ? { shortcut: a.shortcut } : {}),
  };
}
