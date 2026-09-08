// The topology map screen's thin public surface: the command-palette actions it contributes,
// the route the coordinator builds its descriptor from, and a re-export of renderMap (the
// lifecycle controller MapView and its body now live in ./controller.ts, lifted out for size;
// the diff is a move, behaviour is unchanged). The coordinator (../map.ts) imports renderMap,
// screenActions, MAP_ROUTE and the Screen type from here, so the public surface is unchanged.
// House rules: Australian English, no em dashes, precise claims.

import type { Screen, ScreenAction } from "../common.ts";
import { MAP_ROUTE } from "./url.ts";

// renderMap builds the screen body (the page header with the WCAG 2.2.2 auto-refresh pause and
// the MapView lifecycle controller). It lives in ./controller.ts with the MapView class it
// instantiates; re-exported here so the coordinator's import is unchanged.
export { renderMap } from "./controller.ts";

// screenActions declares the commands this screen contributes to the shared action registry
// / command palette (common.ts ScreenAction). A go-to and a refresh; both are Navigation
// actions to MAP_ROUTE, so dispatching either routes to /map (the refresh re-renders the
// screen, which loads fresh on mount). The integrator merges these via allScreenActions().
export function screenActions(): ScreenAction[] {
  return [
    {
      id: "goto-map",
      title: "Go to Topology map",
      group: "Navigation",
      kind: "navigate",
      keywords: ["map", "topology", "sources", "destinations", "flows", "diagram"],
      target: MAP_ROUTE,
      shortcut: "g m",
    },
    {
      id: "map.refresh",
      title: "Refresh the topology map",
      group: "Navigation",
      kind: "navigate",
      keywords: ["refresh", "reload", "map", "topology"],
      target: MAP_ROUTE,
    },
  ];
}

// The route + the Screen type the coordinator uses for the descriptor. Re-exported so the
// coordinator builds the descriptor without re-importing common.ts / url.ts for a single symbol.
export { MAP_ROUTE };
export type { Screen };
