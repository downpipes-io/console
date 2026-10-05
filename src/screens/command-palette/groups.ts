// Building the grouped rows from the one registry + the fuzzy matcher, and composing them
// with the (possibly not-yet-loaded) async entity matches into the final "Top hit first"
// row list. buildGroups turns the current query into grouped, role-gated, fuzzy-ranked
// command items PLUS the single best-scoring one of them (`top`); composeTopHit merges that
// with the entity groups entity-append.ts resolves, promoting whichever of the two scores
// highest into its own "Top hit" group ahead of the fixed Navigation/Downpipes/Runs/Actions
// order. collectCommands resolves the role + engine-state-gated command set from the ONE
// registry; engineStateFor derives the small engine-state facts a command's `when` may gate
// on; actionToCommand adapts this screen's own actions to the Command shape. These hold no
// module state; they are a leaf so the overlay's instant static render imports them from one
// place.

import type { ScreenContext, ScreenAction } from "../common.ts";
import { getDownpipesCache } from "../../lib/store.ts";
import { COMMANDS, type Command } from "../../shell/registry.ts";
import type { EngineClient } from "../../api.ts";
import { paletteActions, fuzzyScore, type PaletteDispatch } from "./shared.ts";
import { runCommand } from "./routing.ts";
import { toast } from "../../components/toast.ts";
import { toBuiltItem, type RowGroup, type BuiltItem } from "./rows.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import type { EntityGroup, EntityMatch } from "./entities.ts";

// Scored is one fuzzy-ranked command plus the title match ranges to highlight and its
// bucket (0: the query matched the TITLE; 1: it matched only a keyword). The bucket, not
// the raw score, decides ranking first: a title match always outranks a keyword-only one,
// however the two scores compare, so a strong keyword hit on an unrelated command never
// outranks a weak but real title hit on the command the operator typed for.
interface Scored {
  cmd: Command;
  score: number;
  bucket: 0 | 1;
  matches: number[];
}

// RankedTop is the single best-scoring STATIC command, carried alongside its already-built
// row and its owning group, so composeTopHit can either promote it (leave it out of that
// group) or leave it where buildGroups put it (an entity outranked it instead).
export interface RankedTop {
  item: BuiltItem;
  group: Command["group"];
  score: number;
  bucket: 0 | 1;
}

// PaletteEngineState is the small set of engine-state facts a command's `when` may gate on. Every
// field is optional, so an unknown reads as undefined and a `when` should not hide a command on it.
interface PaletteEngineState {
  ready?: boolean;
  downpipeCount?: number;
  updateAvailable?: boolean;
  connected?: boolean;
}

// buildGroups turns the current query into grouped, role-gated, fuzzy-ranked items from the
// one registry (static COMMANDS + this screen's own actions; the async entity rows are
// resolved separately and merged in by composeTopHit below). Alongside the groups (every
// matching command, in its normal group, normal order) it returns `top`: the single
// best-scoring command by (bucket asc, score desc), or null when the query matched nothing.
// paintList builds the DOM and the flat run-able row list from whatever RowGroup[] the
// caller ultimately paints (these groups directly, or composeTopHit's merged result).
export function buildGroups(args: {
  query: string;
  ctx: Pick<ScreenContext, "caller" | "engine">;
  dispatch: PaletteDispatch;
  close: () => void;
  // The integrator's assembled registry (allScreenActions + COMMANDS), or undefined to
  // use the static COMMANDS + this screen's own actions.
  supplied: Command[] | undefined;
}): { groups: RowGroup[]; top: RankedTop | null } {
  const { query, ctx, dispatch, close, supplied } = args;
  const visible = collectCommands(ctx, supplied);

  // Score + filter. Empty query: keep all (contextual order: Navigation first, then the rest
  // as authored; no bucket/ranking applies). Non-empty: fuzzy subsequence match, title first.
  // A title match (bucket 0) is kept even when a keyword match on the SAME command would have
  // scored higher raw, because the bucket is what "a title match always outranks a
  // keyword-only match" means; only a command whose title does not match at all falls back to
  // its keyword score (bucket 1).
  const scored: Scored[] = [];
  for (const cmd of visible) {
    if (query === "") {
      scored.push({ cmd, score: 0, bucket: 0, matches: [] });
      continue;
    }
    const titleMatch = fuzzyScore(cmd.title, query);
    if (titleMatch) {
      scored.push({ cmd, score: titleMatch.score, bucket: 0, matches: titleMatch.indices });
      continue;
    }
    const kwMatch = fuzzyScore(cmd.keywords.join(" "), query);
    if (kwMatch) scored.push({ cmd, score: kwMatch.score, bucket: 1, matches: [] });
    // Neither the title nor a keyword matched: the command is not offered for this query.
  }
  if (query !== "") scored.sort((a, b) => a.bucket - b.bucket || b.score - a.score);

  // Group in the canonical order (Navigation, Downpipes, Runs, Actions).
  const order: Command["group"][] = ["Navigation", "Downpipes", "Runs", "Actions"];
  const byGroup = new Map<string, BuiltItem[]>();
  for (const g of order) byGroup.set(g, []);
  let top: RankedTop | null = null;
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
    // `scored` is already sorted best-first for a non-empty query, so the FIRST item built is
    // the top candidate; every later one is worse or tied-and-later, never better.
    if (query !== "" && top === null) top = { item, group: s.cmd.group, score: s.score, bucket: s.bucket };
  }

  const groups: RowGroup[] = [];
  for (const g of order) {
    const items = byGroup.get(g)!;
    if (items.length > 0) groups.push({ label: g, items });
  }
  return { groups, top };
}

// entityToBuiltItem adapts one resolved entity match into the SAME BuiltItem shape the
// static command rows use, so paintList renders every row (command or entity, promoted to
// Top hit or not) through the one row builder (rows.ts buildOptionRow). Running it closes
// the palette then navigates, exactly as the async entity source has always done.
function entityToBuiltItem(m: EntityMatch, close: () => void): BuiltItem {
  return {
    id: `entity-${m.id}`,
    title: m.title,
    matches: m.matches,
    icon: m.icon,
    meta: m.meta,
    kind: "navigate",
    run: () => {
      close();
      navigate(m.route);
    },
  };
}

// composeTopHit merges buildGroups' static result with the (possibly empty, not-yet-loaded)
// async entity groups into the final paintable row list: a leading "Top hit" group holding
// the single best-scoring row across BOTH sources, then every other row in the existing
// fixed order (statics first, entity groups after, neither repeating the promoted row). An
// entity match is always a name/title match (bucket 0, the same footing as a command title
// match; there is no keyword-only entity), so it beats a keyword-only command top outright
// and otherwise wins or loses on score like any other bucket-0 candidate. Called only for a
// non-empty query; the controller keeps buildGroups' own order on an empty one.
export function composeTopHit(
  built: { groups: RowGroup[]; top: RankedTop | null },
  entityGroups: EntityGroup[],
  close: () => void,
): RowGroup[] {
  let bestEntity: EntityMatch | null = null;
  for (const g of entityGroups) {
    for (const m of g.matches) {
      if (!bestEntity || m.score > bestEntity.score) bestEntity = m;
    }
  }

  const cmdTop = built.top;
  const entityWins = bestEntity !== null && (!cmdTop || cmdTop.bucket === 1 || bestEntity.score > cmdTop.score);

  // The command groups, with the promoted command top (if any) pulled out of its normal
  // group; unchanged when an entity was promoted instead (the command top stays put).
  const commandGroups =
    !entityWins && cmdTop
      ? built.groups
          .map((g) => (g.label === cmdTop.group ? { label: g.label, items: g.items.filter((it) => it.id !== cmdTop.item.id) } : g))
          .filter((g) => g.items.length > 0)
      : built.groups;

  // The entity groups, with the promoted entity (if any) pulled out of its group.
  const entityRowGroups: RowGroup[] = [];
  for (const g of entityGroups) {
    const items = g.matches.filter((m) => !(entityWins && bestEntity && m.id === bestEntity.id)).map((m) => entityToBuiltItem(m, close));
    if (items.length > 0) entityRowGroups.push({ label: g.label, items });
  }

  const topItem: BuiltItem | null = entityWins && bestEntity ? entityToBuiltItem(bestEntity, close) : cmdTop ? cmdTop.item : null;

  const result: RowGroup[] = [];
  if (topItem) result.push({ label: "Top hit", items: [topItem] });
  result.push(...commandGroups, ...entityRowGroups);
  return result;
}

// collectCommands resolves the role + engine-state-gated command set the palette
// shows, from the ONE registry (build-contract 2.1). The base list is either the
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
