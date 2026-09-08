// Coverage validator for the DOM RENDER layer of src/components/topology.ts: the part
// test/validate-topology.ts deliberately leaves cold. That suite pins the PURE model
// (buildTopologyModel + the encoding helpers + buildTableRows), which touches no DOM, no
// clock and no randomness. This file drives the projections that only run in a browser:
// renderTopology and its setFlows re-render, the empty and capped bodies, the SVG figure
// (arrowhead defs, edges, group labels, node groups), every edge state (the flowing dash
// under motion, the static running badge + dot under reduced motion, the idle ambient
// sheen, the dashed and dotted stroke fallbacks, the glyph-only demotion, the label dedup),
// every node state (a down destination, a reachable node with and without a secondary, the
// activation handlers), the kind-glyph map, the small SVG text/glyph helpers, and the
// prefers-reduced-motion resolver (the data-motion override, the matchMedia query and its
// throw guard).
//
// It uses the shared test/dom-shim.ts (createElementNS, querySelector, event dispatch,
// focus/activeElement and matchMedia are all the render layer touches: no canvas, no rAF),
// exactly as the other component coverage validators render the real production code under
// plain node. No network, no real clock (a fixed `now` is passed throughout), nothing read
// from a real GPU or DOM. Run with `node test/cov/components-topology.ts` (auto-run by
// test/cov/run.mjs).

import { installDomShim, qs, qsa, keydown } from "../dom-shim.ts";
import type { FlowRecord, TopologyOptions } from "../../src/components/topology.ts";

installDomShim();

// The shim must be installed BEFORE importing the component (lib/dom.ts builds elements
// eagerly inside helpers at import time), so the runtime import sits under installDomShim().
// The types are pulled separately via `import type` (erased before run), so the dynamic
// import carries only the runtime value, exactly as validate-idp.ts does.
const { renderTopology } = await import("../../src/components/topology.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const NOW = Date.parse("2026-06-07T12:00:00Z");
function ts(deltaSec: number): string {
  return new Date(NOW + deltaSec * 1000).toISOString();
}

// A small key-event helper the shim understands (it builds a bubbling, cancelable keydown
// carrying `key`); dispatched at the element the handler is attached to.
function fireKey(node: unknown, key: string): void {
  (node as { dispatchEvent: (ev: unknown) => boolean }).dispatchEvent(keydown({ key }));
}

// A representative flow set covering every status, both column sides, several kinds, known
// and unknown throughput, an in-flight (flowing) run, a disabled downpipe and a shared
// destination, so one render exercises most edge and node arms at once.
function sampleFlows(): FlowRecord[] {
  return [
    {
      id: "dp-1",
      source: { name: "uploads-prod", kind: "kv", secondary: "1,204 keys" },
      destination: { name: "archive-bucket", kind: "r2", secondary: "2.1 GB" },
      status: "healthy",
      lastRunAt: ts(-3 * 3600),
      cadence: 86400,
      bytesPerRun: 2 * 1024 * 1024, // 2 MB -> medium weight
      enabled: true,
      running: false, // idle + healthy -> the ambient sheen overlay is drawn
    },
    {
      id: "dp-2",
      source: { name: "sessions", kind: "kv" },
      destination: { name: "archive-bucket", kind: "r2" }, // shares the dest node with dp-1
      status: "stale",
      lastRunAt: ts(-50 * 3600),
      cadence: 3600,
      bytesPerRun: 512 * 1024, // 512 KB -> thin weight
      enabled: true,
      running: true, // in-flight + stale -> flowing (the dash / badge path)
    },
    {
      id: "dp-3",
      source: { name: "ledger", kind: "d1" },
      destination: { name: "offsite-s3", kind: "s3" },
      status: "failed", // failed -> dashed stroke, inert (never flowing, no sheen)
      lastRunAt: ts(-2 * 3600),
      cadence: 43200,
      bytesPerRun: 80 * 1024 * 1024, // 80 MB -> thick weight
      enabled: true,
      running: false,
    },
    {
      id: "dp-4",
      source: { name: "api-tokens", kind: "secrets" },
      destination: { name: "vault-mirror", kind: "r2", down: true, downReason: "auth" }, // a DOWN destination node, WHY it is down (B30)
      status: "disabled", // disabled -> dotted stroke, inert
      lastRunAt: ts(-200 * 3600),
      cadence: 86400,
      bytesPerRun: null, // unknown throughput
      enabled: false,
      running: false,
    },
    {
      id: "dp-5",
      source: { name: "metrics", kind: "other" }, // an unrecognised kind -> kindGlyph default arm
      destination: { name: "cold-store", kind: "r2" },
      status: "unknown", // unknown -> dotted stroke, BUT enabled + idle -> ambient sheen
      lastRunAt: null,
      enabled: true,
      running: false,
    },
  ];
}

function main(): void {
  renderAndSetFlowsTests();
  edgeStateTests();
  reducedMotionRenderTests();
  nodeAndHandlerTests();
  downReasonFallbackTests();
  emptyStateTests();
  cappedNoticeTests();
  readOnlyEmbedTests();
  prefersReducedMotionTests();

  console.log(failures === 0 ? "\nTOPOLOGY RENDER-COVERAGE PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) process.exit(1);
}

// (1) renderTopology builds the full populated component, and setFlows re-renders it in
// place keeping the SAME aria-describedby instance id (the poll path). This drives the
// renderTopology closure, build(), buildBody's populated branch and buildSvgFigure end to
// end, with every optional handler wired so each conditional arm is taken.
function renderAndSetFlowsTests(): void {
  let openedEdge: string | null = null;
  let openedNode: string | null = null;
  let cleared = 0;
  const opts: TopologyOptions = {
    flows: sampleFlows(),
    now: NOW,
    reducedMotion: false, // animate: the flowing dash + ambient sheen branches
    onActivateEdge: (id) => { openedEdge = id; },
    onActivateNode: (id) => { openedNode = id; },
    onClearNodeFilter: () => { cleared += 1; },
  };
  const handle = renderTopology(opts);
  const root = handle.el;

  ok("render: the root carries the topo class", (root as { className: string }).className.includes("topo"));
  ok("render: the handle exposes the computed model", handle.model !== undefined && handle.model.counts.total === 5);

  // The SVG figure exists with its role/label + a per-instance described-by id.
  const svg = qs(root, "svg.topo-svg");
  ok("render: an SVG figure is drawn for a populated map", svg !== null);
  ok("render: the SVG carries role=img (a pure visual)", svg!.getAttribute("role") === "img");
  const describedBy = svg!.getAttribute("aria-describedby");
  ok("render: the SVG references a per-instance figcaption id", typeof describedBy === "string" && describedBy.endsWith("-desc"));
  const caption = qs(root, "figcaption");
  ok("render: the figcaption id matches the SVG aria-describedby", caption !== null && caption.getAttribute("id") === describedBy);

  // The arrowhead marker is defined once in <defs>.
  ok("render: a single shared arrowhead marker is defined", qsa(root, "marker").length === 1);

  // One edge group per flow; the group labels and node groups are present.
  ok("render: one edge group per flow", qsa(root, "g.topo-edge").length === 5);
  ok("render: two roving node groups (sources + destinations)", qsa(root, "g.topo-svg__nodegroup").length === 2);

  // The canonical accessible table is always present and carries every flow as a row.
  ok("render: the canonical table is mounted", qs(root, "section.topo__table") !== null);
  const rows = qsa(root, "tr").filter((r) => r.classList.contains("dp-table__row--activatable"));
  ok("render: the table has one activatable row per flow (the operable surface)", rows.length === 5);

  // setFlows re-renders with a new set and keeps the SAME instance id (no id leak on poll).
  handle.setFlows(sampleFlows().slice(0, 2));
  const svg2 = qs(root, "svg.topo-svg");
  ok("re-poll: setFlows rebuilds the SVG", svg2 !== null);
  ok("re-poll: the aria-describedby id is stable across a poll re-render", svg2!.getAttribute("aria-describedby") === describedBy);
  ok("re-poll: the rebuilt map has two edges for the smaller set", qsa(root, "g.topo-edge").length === 2);
  ok("re-poll: the handle model is updated to the new set", handle.model.counts.total === 2);

  // Two instances on one page get DISTINCT described-by ids (the module instance counter).
  const other = renderTopology({ flows: sampleFlows(), now: NOW });
  const otherDesc = qs(other.el, "svg.topo-svg")!.getAttribute("aria-describedby");
  ok("instance: a second map gets a distinct aria-describedby id", otherDesc !== describedBy);

  // Activating a table row opens the downpipe (the real operable control wired to onActivateEdge).
  const handle3 = renderTopology(opts);
  const activatable = qsa(handle3.el, "tr").filter((r) => r.classList.contains("dp-table__row--activatable"));
  if (activatable.length > 0) {
    activatable[0]!.dispatchEvent({ type: "click", target: activatable[0], currentTarget: activatable[0], defaultPrevented: false, bubbles: true, preventDefault(this: { defaultPrevented: boolean }) { this.defaultPrevented = true; }, stopPropagation() {} } as unknown as Parameters<typeof activatable[0]["dispatchEvent"]>[0]);
  }
  ok("table-row: activating a row opens that downpipe (onActivateEdge fired)", openedEdge !== null);

  // openedNode + cleared are exercised in the node-handler test below; reference them here so
  // the wired handlers above read as used.
  void openedNode;
  void cleared;
}

// (2) Edge states under MOTION. The flowing edge draws the animated flow dash + a "running"
// text label; the idle healthy/unknown edges draw the ambient sheen; the failed edge is a
// dashed stroke; the disabled edge is a dotted stroke. The edge <title> carries the full
// accessible read plus "running now" and the absolute last-run time when known.
function edgeStateTests(): void {
  const handle = renderTopology({ flows: sampleFlows(), now: NOW, reducedMotion: false, onActivateEdge: () => {} });
  const root = handle.el;

  const edgeById = (id: string) => qsa(root, "g.topo-edge").find((g) => g.getAttribute("data-flow-id") === id);

  // The flowing (stale + running) edge: an animated flow path + the running badge + the label.
  const flowing = edgeById("dp-2");
  ok("edge: the in-flight edge group exists", flowing !== undefined);
  ok("edge: a flowing edge under motion draws the animated flow dash", qs(flowing!, ".topo-edge__flow") !== null);
  const runningLabel = qs(flowing!, ".topo-edge__running-label");
  ok("edge: a flowing edge draws a 'running' TEXT label (never shape/colour alone)", runningLabel !== null && runningLabel.textContent === "running");
  ok("edge: a flowing edge under motion draws NO static running dot", qs(flowing!, ".topo-edge__running-dot") === null);

  // The idle healthy edge: the ambient sheen overlay rides its own status hue.
  const idleHealthy = edgeById("dp-1");
  ok("edge: an idle watched (healthy) edge draws the ambient sheen overlay", qs(idleHealthy!, ".topo-edge__ambient") !== null);
  // The idle unknown edge also draws the sheen (a young account's first route is alive).
  const idleUnknown = edgeById("dp-5");
  ok("edge: an idle unknown edge also draws the ambient sheen (alive, not dead)", qs(idleUnknown!, ".topo-edge__ambient") !== null);

  // The failed edge: inert (no sheen, no flow) and a DASHED stroke fallback.
  const failed = edgeById("dp-3");
  ok("edge: a failed edge draws no ambient sheen (inert)", qs(failed!, ".topo-edge__ambient") === null);
  const failedLine = qs(failed!, "path.topo-edge__line");
  ok("edge: a failed edge sets a dashed stroke-dasharray fallback", failedLine!.getAttribute("stroke-dasharray") === "7 5");

  // The disabled edge: inert and a DOTTED stroke fallback.
  const disabled = edgeById("dp-4");
  ok("edge: a disabled edge draws no ambient sheen (inert)", qs(disabled!, ".topo-edge__ambient") === null);
  const disabledLine = qs(disabled!, "path.topo-edge__line");
  ok("edge: a disabled edge sets a dotted stroke-dasharray fallback", disabledLine!.getAttribute("stroke-dasharray") === "1.5 5");

  // Every edge line references the shared arrowhead marker.
  ok("edge: every edge line carries the marker-end arrowhead reference", qsa(root, "path.topo-edge__line").every((p) => (p.getAttribute("marker-end") ?? "").startsWith("url(#")));

  // The edge <title> read: the flowing edge title says "running now"; an edge with a known
  // last run carries an absolute "last run ..." clause.
  const flowingTitle = qs(flowing!, "title");
  ok("edge: a running edge's <title> says running now", (flowingTitle!.textContent).includes("running now"));
  const healthyTitle = qs(idleHealthy!, "title");
  ok("edge: an edge with a known last run carries an absolute last-run clause in the title", (healthyTitle!.textContent).includes("last run"));

  // The edge hit target is present (an onActivate handler was supplied) and is a focusable,
  // aria-hidden panning target (the operable surface is the table, not the SVG shape).
  ok("edge: a wired edge draws a transparent hit path", qs(flowing!, "path.topo-edge__hit") !== null);
  ok("edge: the hit path is aria-hidden (not an AT control)", qs(flowing!, "path.topo-edge__hit")!.getAttribute("aria-hidden") === "true");

  // Activating the edge hit path is a progressive-enhancement convenience: click and the
  // keyboard Enter/Space all open the downpipe. Drive each so the click + keydown handlers
  // and the Enter/Space guard branch all run.
  let opened: string | null = null;
  const wired = renderTopology({ flows: sampleFlows(), now: NOW, onActivateEdge: (id) => { opened = id; } });
  const hit = qs(qsa(wired.el, "g.topo-edge").find((g) => g.getAttribute("data-flow-id") === "dp-1")!, "path.topo-edge__hit")!;
  hit.dispatchEvent({ type: "click", defaultPrevented: false, bubbles: false, preventDefault() {}, stopPropagation() {}, target: hit, currentTarget: hit } as unknown as Parameters<typeof hit["dispatchEvent"]>[0]);
  ok("edge: clicking the hit path opens the downpipe (progressive enhancement)", opened === "dp-1");
  opened = null;
  fireKey(hit, "Enter");
  ok("edge: pressing Enter on the hit path opens the downpipe", opened === "dp-1");
  opened = null;
  fireKey(hit, " ");
  ok("edge: pressing Space on the hit path opens the downpipe", opened === "dp-1");
  opened = null;
  fireKey(hit, "Tab"); // an unrelated key is a no-op (the else of the Enter/Space guard)
  ok("edge: an unrelated key on the hit path does not open the downpipe", opened === null);
}

// (3) The REDUCED-MOTION render. With reducedMotion forced the flowing edge draws the static
// running DOT (not the animated dash) but STILL the "running" text label, and idle edges draw
// NO ambient sheen (the renderer's reduced branch). This is the not-(motion) arm of every
// motion-gated block in buildEdge.
function reducedMotionRenderTests(): void {
  const handle = renderTopology({ flows: sampleFlows(), now: NOW, reducedMotion: true });
  const root = handle.el;
  const flowing = qsa(root, "g.topo-edge").find((g) => g.getAttribute("data-flow-id") === "dp-2")!;

  ok("reduced: a flowing edge draws the static running DOT (motion gated off)", qs(flowing, ".topo-edge__running-dot") !== null);
  ok("reduced: a flowing edge draws NO animated flow dash under reduced motion", qs(flowing, ".topo-edge__flow") === null);
  const label = qs(flowing, ".topo-edge__running-label");
  ok("reduced: a flowing edge STILL draws the 'running' text label (text, not shape)", label !== null && label.textContent === "running");

  // No idle edge carries the ambient sheen in the reduced branch (CSS owns motion; the
  // renderer does not even append it).
  ok("reduced: no idle edge draws the ambient sheen under reduced motion", qsa(root, ".topo-edge__ambient").length === 0);
}

// (4) Node states and the node-level handlers. A DOWN destination node carries the down
// class + a worded "down - KIND" line + a "currently unreachable" accessible title; a
// reachable node with a secondary shows "KIND - secondary"; a node with NO secondary shows
// just the kind word. Activating a node (click / Enter / Space) filters the map, and Escape
// at the group level clears the node filter. The glyph-only marker demotion is asserted too.
function nodeAndHandlerTests(): void {
  let activatedNode: string | null = null;
  let cleared = 0;
  const handle = renderTopology({
    flows: sampleFlows(),
    now: NOW,
    onActivateNode: (id) => { activatedNode = id; },
    onClearNodeFilter: () => { cleared += 1; },
  });
  const root = handle.el;
  const nodeById = (id: string) => qsa(root, "g.topo-node").find((g) => g.getAttribute("data-node-id") === id);

  // The DOWN destination (vault-mirror): the down class + the worded down line naming WHY.
  // sampleFlows gives it the "auth" reason; destDownReasonLabel maps that to "credential rejected",
  // the SAME label the drawer's Copies row would show for the same DestReplState.reason.
  const downNode = qsa(root, "g.topo-node").find((g) => g.classList.contains("topo-node--down"));
  ok("node: a down destination carries the down modifier class", downNode !== undefined);
  const downLine = qs(downNode!, ".topo-node__down");
  ok("node: a down destination states the outage in WORDS on the node", downLine !== null);
  ok("node: the down line names WHY, not just 'down - KIND'", downLine!.textContent === "down - credential rejected");
  const downTitle = qs(downNode!, "title");
  ok("node: a down destination's title says currently unreachable", (downTitle!.textContent).includes("currently unreachable"));
  ok("node: the title's reason matches the same label as the visible line", (downTitle!.textContent).includes("currently unreachable (credential rejected)"));

  // A reachable node WITH a secondary shows the muted "KIND - secondary" line.
  const withSecondary = qsa(root, "g.topo-node").find((g) => (qs(g, ".topo-node__secondary")?.textContent ?? "").includes(" - "));
  ok("node: a reachable node with a secondary shows the 'KIND - secondary' line", withSecondary !== undefined);

  // A reachable node with NO secondary shows just the kind word (the secondary-absent arm).
  const sessions = qsa(root, "g.topo-node").find((g) => (qs(g, ".topo-node__name")?.textContent ?? "") === "sessions");
  ok("node: a node with no secondary still renders one source node", sessions !== undefined);
  const secLine = qs(sessions!, ".topo-node__secondary");
  ok("node: a secondary-less node's line is just the kind word (no ' - ')", secLine !== null && !secLine.textContent.includes(" - "));

  // The accessible title pluralises: a singleton dest reads "1 downpipe"; the shared dest
  // (degree 2) reads "2 downpipes".
  const offsite = qsa(root, "g.topo-node").find((g) => (qs(g, ".topo-node__name")?.textContent ?? "") === "offsite-s3");
  ok("node: a single-flow node title reads '1 downpipe' (singular)", (qs(offsite!, "title")!.textContent).includes("1 downpipe"));
  const archive = qsa(root, "g.topo-node").find((g) => (qs(g, ".topo-node__name")?.textContent ?? "") === "archive-bucket");
  ok("node: a shared (degree 2) node title reads '2 downpipes' (plural)", (qs(archive!, "title")!.textContent).includes("2 downpipes"));

  // Activating a node: click, Enter and Space all filter the map; an unrelated key is a no-op.
  const target = nodeById("source:metrics") ?? sessions!;
  target.dispatchEvent({ type: "click", defaultPrevented: false, bubbles: false, preventDefault() {}, stopPropagation() {}, target, currentTarget: target } as unknown as Parameters<typeof target["dispatchEvent"]>[0]);
  ok("node: clicking a node filters the map (onActivateNode fired)", activatedNode !== null);
  activatedNode = null;
  fireKey(target, "Enter");
  ok("node: pressing Enter on a node filters the map", activatedNode !== null);
  activatedNode = null;
  fireKey(target, " ");
  ok("node: pressing Space on a node filters the map", activatedNode !== null);
  activatedNode = null;
  fireKey(target, "Tab");
  ok("node: an unrelated key on a node does not filter (the Enter/Space guard else)", activatedNode === null);

  // Escape at the node group level clears the filter (the onClearNodeFilter handler). Esc and
  // the legacy "Esc" key string both fire it; an unrelated key does not.
  const group = qsa(root, "g.topo-svg__nodegroup")[0]!;
  fireKey(group, "Escape");
  ok("node: Escape on a node group clears the node filter", cleared === 1);
  fireKey(group, "Esc");
  ok("node: the legacy 'Esc' key string also clears the filter", cleared === 2);
  fireKey(group, "ArrowDown");
  ok("node: an unrelated key on the group is a no-op for the clear handler", cleared === 2);

  // The glyph-only demotion: a dense mutual mesh forces some markers to drop their wide text
  // plate (the labelled === false arm of buildEdge's marker), so a glyph-only marker class is
  // present. This is the same degradation the model test pins; here it must reach the DOM.
  const mesh: FlowRecord[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      mesh.push({
        id: `m-${i}-${j}`,
        source: { name: `src-${i}`, kind: "kv" },
        destination: { name: `dst-${j}`, kind: "r2" },
        status: "healthy",
        lastRunAt: ts(-3600),
        cadence: 86400,
        bytesPerRun: 1024 * 1024,
        enabled: true,
        running: false,
      });
    }
  }
  const meshHandle = renderTopology({ flows: mesh, now: NOW });
  ok("node: a dense mesh demotes some markers to glyph-only (no wide plate)", qsa(meshHandle.el, ".topo-edge__marker--glyph-only").length > 0);
  ok("node: a dense mesh still draws a full-label marker on the uncrowded edges", qsa(meshHandle.el, ".topo-edge__marker").some((m) => !m.classList.contains("topo-edge__marker--glyph-only")));
}

// (4b) The no-reason fallback: a down destination the engine gave NO reason for (an absent DestReplState.reason,
// same as "other" or an unrecognised newer-engine class) must NOT grow a dangling "down - " or an empty
// "(...)" parenthetical. It keeps the ORIGINAL bare "down - KIND" line and the plain "currently
// unreachable" title. A separate one-flow render (not sampleFlows(), whose vault-mirror node now carries
// a reason) keeps this isolated from the counts every other test in this file pins against the shared 5-flow sample.
function downReasonFallbackTests(): void {
  const flows: FlowRecord[] = [
    {
      id: "fallback-1",
      source: { name: "kv-a", kind: "kv" },
      destination: { name: "legacy-store", kind: "r2", down: true }, // down, but NO reason supplied
      status: "failed",
      enabled: true,
      running: false,
    },
  ];
  const handle = renderTopology({ flows, now: NOW });
  const downNode = qsa(handle.el, "g.topo-node").find((g) => g.classList.contains("topo-node--down"));
  ok("fallback: a down destination with no reason still renders down", downNode !== undefined);
  const downLine = qs(downNode!, ".topo-node__down");
  ok("fallback: the line falls back to the bare 'down - KIND' text", downLine !== null && downLine.textContent === "down - R2");
  ok("fallback: the line never renders a dangling 'down - ' with nothing after it", !downLine!.textContent.endsWith("down - "));
  const downTitle = qs(downNode!, "title");
  ok("fallback: the title still says currently unreachable", (downTitle!.textContent).includes("currently unreachable"));
  ok("fallback: the title adds no empty/dangling parenthetical when there is no reason label", !downTitle!.textContent.includes("("));
}

// (5) The EMPTY state (zero flows). buildBody takes its early empty branch: a calm note, no
// SVG figure, and the accessible table still rendered (empty) so the structure is consistent.
function emptyStateTests(): void {
  const handle = renderTopology({ flows: [], now: NOW });
  const root = handle.el;
  ok("empty: a calm empty-state card is shown", qs(root, ".topo__empty") !== null);
  ok("empty: the empty card states there are no downpipes yet", (qs(root, ".topo__empty-title")!.textContent) === "No downpipes yet");
  ok("empty: no SVG figure is drawn for an empty map", qs(root, "svg.topo-svg") === null);
  ok("empty: the accessible table section is STILL mounted (parity at zero)", qs(root, "section.topo__table") !== null);
  ok("empty: the handle model reports zero total", handle.model.counts.total === 0);

  // setFlows from empty to populated grows the SVG; back to empty restores the empty card.
  handle.setFlows(sampleFlows());
  ok("empty: repopulating draws the SVG figure", qs(root, "svg.topo-svg") !== null);
  handle.setFlows([]);
  ok("empty: emptying again restores the calm empty card", qs(root, ".topo__empty") !== null && qs(root, "svg.topo-svg") === null);
}

// (6) The CAP notice. With maxEdges below the flow count the SVG draws the first N edges and
// an on-screen note states the honest "first N of M" cap (never a silent truncation); the
// table still carries every flow.
function cappedNoticeTests(): void {
  const handle = renderTopology({ flows: sampleFlows(), maxEdges: 2, now: NOW });
  const root = handle.el;
  const notice = qs(root, ".topo__cap-notice");
  ok("cap: an on-screen cap notice is shown when the SVG is capped", notice !== null);
  ok("cap: the notice reports the honest first-N-of-M counts", (notice!.textContent).includes("first 2 of 5"));
  ok("cap: the SVG draws only the capped number of edges", qsa(root, "g.topo-edge").length === 2);
  // The full table is still present below the cap notice (the parity floor under truncation):
  // every flow is a body row even when the SVG only drew the first two. (The SVG cap does not
  // touch the table; body rows are the tbody's <tr> regardless of the open handler.)
  const bodyRows = qsa(qs(root, "tbody")!, "tr");
  ok("cap: the table still carries every flow despite the SVG cap", bodyRows.length === 5);

  // Under the threshold: no cap notice at all (the capped === false arm of buildBody).
  const uncapped = renderTopology({ flows: sampleFlows(), maxEdges: 10, now: NOW });
  ok("cap: no cap notice when under the threshold", qs(uncapped.el, ".topo__cap-notice") === null);
}

// (7) The READ-ONLY Overview embed: NO handlers supplied. buildEdge omits the hit path (no
// onActivate), buildNode omits the activation wiring, buildNodeGroup omits the Escape clear
// handler, and buildAccessibleTable renders without the trailing per-row open button. The
// edge <title> STILL carries the in-flight read (so a hovering user sees it even read-only).
function readOnlyEmbedTests(): void {
  const handle = renderTopology({ flows: sampleFlows(), now: NOW }); // no onActivate*, no onClear
  const root = handle.el;

  ok("read-only: a read-only embed draws no edge hit paths (no progressive-enhancement target)", qsa(root, "path.topo-edge__hit").length === 0);
  // A node still renders, but with no roving tabindex activation wiring on it.
  const node = qsa(root, "g.topo-node")[0]!;
  ok("read-only: a node still renders in a read-only embed", node !== undefined);
  // The flowing edge's <title> still says running now even with no handler (the read-only
  // Overview must still convey the in-flight state to a hovering / AT user).
  const flowing = qsa(root, "g.topo-edge").find((g) => g.getAttribute("data-flow-id") === "dp-2")!;
  ok("read-only: a flowing edge's <title> still says running now with no handler", (qs(flowing, "title")!.textContent).includes("running now"));
  // The table renders with no trailing open-button column (no onActivateEdge).
  ok("read-only: the read-only table mounts (no open-button column)", qs(root, "section.topo__table") !== null);
}

// (8) prefersReducedMotion: the resolver buildSvgFigure falls back to when no reducedMotion
// option is passed. The console-level data-motion attribute outranks the OS query ("reduced"
// forces calm, "full" forces motion); with no attribute the matchMedia query is consulted;
// and a throwing matchMedia is caught (defaults to motion-allowed). We assert through the
// rendered output: a flowing edge draws the static dot under "reduced" and the animated dash
// under "full".
function prefersReducedMotionTests(): void {
  const docEl = (globalThis as unknown as { document: { documentElement: { setAttribute(k: string, v: string): void; removeAttribute(k: string): void } } }).document.documentElement;

  // data-motion="reduced": the console override forces calm even with no option passed.
  docEl.setAttribute("data-motion", "reduced");
  const reducedHandle = renderTopology({ flows: sampleFlows(), now: NOW });
  const reducedFlowing = qsa(reducedHandle.el, "g.topo-edge").find((g) => g.getAttribute("data-flow-id") === "dp-2")!;
  ok("prefers: data-motion=reduced forces the static running dot (no option passed)", qs(reducedFlowing, ".topo-edge__running-dot") !== null);

  // data-motion="full": the explicit opt-in forces motion (outranks even an OS reduce query).
  docEl.setAttribute("data-motion", "full");
  const fullHandle = renderTopology({ flows: sampleFlows(), now: NOW });
  const fullFlowing = qsa(fullHandle.el, "g.topo-edge").find((g) => g.getAttribute("data-flow-id") === "dp-2")!;
  ok("prefers: data-motion=full forces the animated flow dash (the explicit opt-in)", qs(fullFlowing, ".topo-edge__flow") !== null);

  // No data-motion attribute: the matchMedia query is consulted. The shim's matchMedia
  // returns matches=false for a reduce query, so motion is allowed (the animated dash).
  docEl.removeAttribute("data-motion");
  const mediaHandle = renderTopology({ flows: sampleFlows(), now: NOW });
  const mediaFlowing = qsa(mediaHandle.el, "g.topo-edge").find((g) => g.getAttribute("data-flow-id") === "dp-2")!;
  ok("prefers: with no override the matchMedia query allows motion (animated dash)", qs(mediaFlowing, ".topo-edge__flow") !== null);

  // A throwing matchMedia is caught (returns false -> motion allowed). Swap the global for one
  // that throws, render, then restore it so later runs are unaffected.
  const g = globalThis as unknown as { matchMedia: unknown; window: { matchMedia: unknown } };
  const prev = g.matchMedia;
  const thrower = () => { throw new Error("matchMedia blocked"); };
  g.matchMedia = thrower;
  g.window.matchMedia = thrower;
  try {
    const throwHandle = renderTopology({ flows: sampleFlows(), now: NOW });
    const throwFlowing = qsa(throwHandle.el, "g.topo-edge").find((g2) => g2.getAttribute("data-flow-id") === "dp-2")!;
    ok("prefers: a throwing matchMedia is caught and defaults to motion-allowed", qs(throwFlowing, ".topo-edge__flow") !== null);
  } finally {
    g.matchMedia = prev;
    g.window.matchMedia = prev;
  }
}

main();
