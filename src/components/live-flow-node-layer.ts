// The DOM node layer over the live-flow canvas (extracted from live-flow.ts to keep that file
// under the structural threshold; behaviour-preserving move only): a labelled anchor per
// source/destination node plus the "Engine" caption under the hub ring, positioned by the model's
// normalised coordinates as left/top percentages (so they ride the canvas box through any resize
// with no JS). All names reach the DOM via textContent (h()); nothing here weakens no-custody.

import { h } from "../lib/dom.ts";
import { litNodeIds } from "./live-flow-model.ts";
import type { LiveNode, LiveFlowModel, LiveFlowOptions } from "./live-flow-types.ts";

// Above this many nodes in one column the per-node labels would smear into an unreadable
// stack (a fleet-scale bank of a hundred KV namespaces in a 540px band), so a dense column
// drops its labels for ONE calm summary chip; the GL anchor texture still marks the bank and
// the canonical table below carries every name.
const NODE_LABEL_MAX = 14;

export function buildNodeLayer(layer: HTMLElement, model: LiveFlowModel | null, opts: LiveFlowOptions, onFocus?: (flowIds: Set<string> | null) => void): void {
  layer.replaceChildren();
  layer.classList.remove("live-flow__nodes--focused");
  if (!model || model.nodes.length === 0) return;
  const operable = typeof opts.onActivateNode === "function";

  let sourceCount = 0;
  let destCount = 0;
  for (const node of model.nodes) {
    if (node.column === "source") sourceCount++;
    else if (node.column === "destination") destCount++;
  }

  const pos = (x: number, y: number): string => `left:${(x * 100).toFixed(2)}%;top:${(y * 100).toFixed(2)}%`;

  // Per-element handles so a hover can dim every node NOT on the hovered node's paths (the canvas dims
  // the pipes in parallel via onFocus). Only the individually-rendered (non-dense) nodes are hoverable.
  const els: Array<{ node: LiveNode; el: HTMLElement }> = [];
  // setFocus lights the hovered node, the engine hub and the opposite-column nodes its flows reach, dims
  // the rest, and tells the canvas which flows to keep lit. null clears it. Keyed off the model's flowIds
  // so the DOM dim and the canvas dim are the same set.
  const setFocus = (focusNode: LiveNode | null): void => {
    if (!focusNode) {
      layer.classList.remove("live-flow__nodes--focused");
      for (const { el } of els) el.classList.remove("live-flow__node--lit");
      onFocus?.(null);
      return;
    }
    layer.classList.add("live-flow__nodes--focused");
    const lit = litNodeIds(focusNode, model.nodes);
    for (const { node, el } of els) el.classList.toggle("live-flow__node--lit", lit.has(node.id));
    onFocus?.(new Set(focusNode.flowIds));
  };

  for (const node of model.nodes) {
    const side = node.column === "source" ? "source" : "destination";
    if (node.column !== "engine" && (side === "source" ? sourceCount : destCount) > NODE_LABEL_MAX) {
      continue; // dense column: a summary chip stands in for the smeared labels (appended below)
    }
    const el = buildNodeEl(node, pos, operable, opts, setFocus);
    els.push({ node, el });
    layer.appendChild(el);
  }

  appendSummaryChips(layer, model, pos, sourceCount, destCount);
}

// buildNodeEl renders one node anchor: the decorative engine-hub caption, or a source/destination
// chip that lights its paths on hover/focus and (when operable) filters the map on activation.
function buildNodeEl(
  node: LiveNode,
  pos: (x: number, y: number) => string,
  operable: boolean,
  opts: LiveFlowOptions,
  setFocus: (focusNode: LiveNode | null) => void,
): HTMLElement {
  if (node.column === "engine") {
    // The hub's caption: the GL ring is the mark; this names it. Decorative (the canvas
    // aria-label already states the engine-centred shape), so it is never a button.
    return h(
      "span",
      { class: "live-flow__node live-flow__node--engine", style: pos(node.x, node.y), "aria-hidden": "true" },
      h("span", { class: "live-flow__node-label" }, "Engine"),
    );
  }
  const side = node.column === "source" ? "source" : "destination";
  const { title, dot, label } = nodeChrome(node);
  const cls = `live-flow__node live-flow__node--${side}`;
  // Hover (mouse) AND focus (keyboard) both light this node's paths and dim the rest, so the effect is
  // reachable without a pointer. Pointer leave / blur clears it.
  const focusHandlers = {
    mouseenter: () => setFocus(node),
    mouseleave: () => setFocus(null),
    focus: () => setFocus(node),
    blur: () => setFocus(null),
  };
  if (operable) {
    return h(
      "button",
      { "data-dp": "components-live-flow-node-layer.button.node-el",
        class: cls,
        type: "button",
        style: pos(node.x, node.y),
        "aria-label": `${title}. Hover or focus to highlight its paths; activate to filter the map to it; Escape clears the filter.`,
        on: { click: () => opts.onActivateNode!(node.id), ...focusHandlers },
      },
      dot,
      label,
    );
  }
  return h("span", { class: cls, style: pos(node.x, node.y), on: focusHandlers }, dot, label);
}

// nodeChrome builds the accessible title plus the dot and label elements for a source/destination
// chip. No kind tag when the name already names the kind (the generic "in-account R2 archive"
// fallback would otherwise read "... R2 archive R2").
function nodeChrome(node: LiveNode): { title: string; dot: HTMLElement; label: HTMLElement } {
  const short = kindShort(node.kind);
  const kindTag = short && !node.label.toLowerCase().includes(short.toLowerCase()) ? short : "";
  const title = kindTag ? `${node.label} (${kindTag})` : node.label;
  const dot = h("span", { class: "live-flow__node-dot", "aria-hidden": "true" });
  const label = h(
    "span",
    { class: "live-flow__node-label" },
    h("span", { class: "live-flow__node-name", title }, node.label),
    kindTag ? h("span", { class: "live-flow__node-kind" }, kindTag) : null,
  );
  return { title, dot, label };
}

// kindShort is the compact kind tag beside a node name (the table carries the long form).
function kindShort(kind: LiveNode["kind"]): string {
  switch (kind) {
    case "kv": return "KV";
    case "r2": return "R2";
    case "d1": return "D1";
    case "secrets": return "Secrets";
    case "s3": return "S3";
    default: return ""; // "other" (a placeholder endpoint) and the engine carry no kind tag
  }
}

// appendSummaryChips places one calm count chip at the head of each crowded column (the table is
// the full list). Counts only, honest; the GL anchor texture still marks the dense bank.
function appendSummaryChips(
  layer: HTMLElement,
  model: LiveFlowModel,
  pos: (x: number, y: number) => string,
  sourceCount: number,
  destCount: number,
): void {
  if (sourceCount > NODE_LABEL_MAX) {
    const sourceNode = model.nodes.find((n) => n.column === "source");
    if (sourceNode) {
      layer.appendChild(h("span", { class: "live-flow__node-summary", style: pos(sourceNode.x, 0.045) }, `${sourceCount} sources`));
    }
  }
  if (destCount > NODE_LABEL_MAX) {
    const destNode = model.nodes.find((n) => n.column === "destination");
    if (destNode) {
      layer.appendChild(h("span", { class: "live-flow__node-summary", style: pos(destNode.x, 0.045) }, `${destCount} destinations`));
    }
  }
}
