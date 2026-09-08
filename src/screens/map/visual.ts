// The map's one mounted visual: the WebGL live-flow view, wrapped in the small MapVisual
// abstraction the controller's lifecycle drives. Factored out of ./controller.ts for size.
// buildVisual feature-detects internally and falls back to the SVG topology when WebGL is
// unavailable, and honours prefers-reduced-motion by painting a static frame; the canonical
// accessible table stays present in every branch. It owns no view state and no `this`: the
// controller passes the interaction handlers (open a flow, filter by a node, clear the node
// filter) as parameters. Moved verbatim from ./controller.ts; behaviour is unchanged. House
// rules: Australian English, no em dashes, precise claims.

import { renderLiveFlow, type LiveFlowHandle } from "../../components/live-flow.ts";
import type { FlowRecord } from "../../components/topology.ts";

// MapVisual is the small abstraction over the mounted map renderer (the live-flow view, which
// internally degrades to the SVG topology): el + setFlows + dispose (tears down the animation
// loop and frees the GL context; a no-op on the SVG fallback). The screen holds one MapVisual,
// so the rest of the lifecycle (poll re-feed, filter re-project, navigation teardown) is
// renderer-agnostic.
export interface MapVisual {
  el: HTMLElement;
  setFlows: (flows: FlowRecord[]) => void;
  dispose: () => void;
  // Live renderer facts for the honest view-status line (read at render time: the live-flow
  // handle mutates its own mode if it degrades to the SVG figure after an init failure).
  mode: () => "canvas2d" | "svg-fallback";
  animation: () => "animated" | "static-frame";
}

// The controller-owned interaction handlers wired into the renderer (each owns the URL/route).
export interface VisualHandlers {
  // Activating an edge opens the deep-linked read drawer (the screen owns the route).
  onActivateEdge: (id: string) => void;
  // Activating a node filters the map to its kind (SVG fallback only; the screen owns the
  // URL/filter). Escape on the node groups clears the node filter (spec section 4).
  onActivateNode: (nodeId: string) => void;
  onClearNodeFilter: () => void;
}

// buildVisual builds the map's one visual: the WebGL live-flow view. It feature-detects
// internally and falls back to the SVG topology when WebGL is unavailable, and honours
// prefers-reduced-motion by painting a static frame; the canonical accessible table stays
// present in every branch. All interaction handlers are wired (open a flow via the table's
// row buttons; the node-filter affordances reach the SVG fallback, the canvas itself draws
// no operable nodes and filtering there is the toolbar's job).
export function buildVisual(visible: FlowRecord[], handlers: VisualHandlers): MapVisual {
  const lf: LiveFlowHandle = renderLiveFlow({
    flows: visible,
    onActivateEdge: handlers.onActivateEdge,
    onActivateNode: handlers.onActivateNode,
    onClearNodeFilter: handlers.onClearNodeFilter,
  });
  return {
    el: lf.el,
    setFlows: (f: FlowRecord[]) => lf.setFlows(f),
    dispose: () => lf.dispose(),
    mode: () => lf.mode,
    animation: () => lf.animation,
  };
}
