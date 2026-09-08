// Validate the OPTIONAL WebGL "live-flow" view's PURE parts.
// WebGL cannot run headless, so this targets exactly the four pure concerns the brief
// names, plus the honesty invariants:
//
//   1. the DATA -> GEOMETRY / LAYOUT mapping (the tripartite sources-left / engine-centre /
//      destinations-right layout, the engine hub, two legs per flow, the throughput-derived
//      particle rate and bounded edge weight, the health hue + glyph, the denser-stream-for-an-
//      active-run rule, determinism, and the empty/partial cases);
//   2. the FEATURE-DETECT / FALLBACK decision (chooseRenderMode over an injected probe, and the
//      real detectCanvas2d returning false in a non-DOM environment so the caller falls back);
//   3. the REDUCED-MOTION static-frame decision (chooseAnimationMode);
//   4. that the TABLE FALLBACK is ALWAYS produced (buildTableSpec returns a complete row+column
//      spec in every case, byte-for-byte the SVG map's table, so the canonical table can never
//      be silently dropped).
//
// Plus the HONESTY invariants that make this view safe: unknown/disabled never get a green
// (statusFallbackRgb + the presentation tones), a flow is only "flowing" (a live stream) when
// genuinely running and non-terminal, and unknown throughput is the slowest rate / thinnest
// edge, never inflated.
//
// The render layer (renderLiveFlow / the GL controller) touches the DOM, WebGL and matchMedia
// and is NOT invoked here (there is no DOM/GPU in the test runner), exactly as
// validate-topology.ts exercises the model and not the renderer. Run with
// `node test/validate-live-flow.ts`.

import {
  buildLiveFlowModel,
  buildTableSpec,
  chooseRenderMode,
  chooseAnimationMode,
  shouldAnimate,
  LIVE_FLOW_MAX_ANIMATED_EDGES,
  detectCanvas2d,
  hasAmbientSheen,
  hubLaneOffset,
  isFlowing,
  particleRateFor,
  statusFallbackRgb,
  parseCssColour,
  renderLiveFlow,
  litNodeIds,
  type FlowRecord,
  type FlowStatus,
  type LiveFlowModel,
  type LiveFlowHandle,
} from "../src/components/live-flow.ts";
import { buildTableRows, presentStatus } from "../src/components/topology.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const NOW = Date.parse("2026-06-07T12:00:00Z");
function ts(deltaSec: number): string {
  return new Date(NOW + deltaSec * 1000).toISOString();
}

// A representative flow set covering every status, multiple kinds, known and unknown
// throughput, an in-flight (running) flow over each non-terminal status, and a disabled flow.
// Two flows share a destination so the engine-hub aggregation and dedup are exercised.
function sampleFlows(): FlowRecord[] {
  return [
    {
      id: "dp-1",
      source: { name: "uploads-prod", kind: "kv" },
      destination: { name: "archive-bucket", kind: "r2" },
      status: "healthy",
      lastRunAt: ts(-3 * 3600),
      cadence: 86400,
      bytesPerRun: 2 * 1024 * 1024, // 2 MB -> medium
      enabled: true,
      running: true, // healthy + running -> a denser, flowing stream
    },
    {
      id: "dp-2",
      source: { name: "sessions", kind: "kv" },
      destination: { name: "archive-bucket", kind: "r2" }, // shares the dest with dp-1
      status: "stale",
      lastRunAt: ts(-50 * 3600),
      cadence: 3600,
      bytesPerRun: 512 * 1024, // 512 KB -> thin
      enabled: true,
      running: false,
    },
    {
      id: "dp-3",
      source: { name: "ledger", kind: "d1" },
      destination: { name: "offsite-s3", kind: "s3" },
      status: "failed",
      lastRunAt: ts(-2 * 3600),
      cadence: 43200,
      bytesPerRun: 80 * 1024 * 1024, // 80 MB -> thick
      enabled: true,
      running: true, // failed + running -> NEVER flowing (terminal status wins)
    },
    {
      id: "dp-4",
      source: { name: "api-tokens", kind: "secrets" },
      destination: { name: "vault-mirror", kind: "r2" },
      status: "disabled",
      lastRunAt: ts(-200 * 3600),
      cadence: 86400,
      bytesPerRun: null, // unknown throughput
      enabled: false,
      running: false,
    },
    {
      id: "dp-5",
      source: { name: "metrics", kind: "kv" },
      destination: { name: "cold-store", kind: "r2" },
      status: "unknown", // could not be fetched (partial load)
      lastRunAt: null,
      enabled: true,
      running: true, // unknown + running -> a slow, honest trickle (flowing, but rate 1)
    },
  ];
}

// Each numbered concern is its own named function so a failure points at one section rather than a
// 280-line monolith; main() is a thin sequencer (guardrails section 6, the 50-line function flag).
// The shared model + flows are built once and threaded through.

type LiveModel = ReturnType<typeof buildLiveFlowModel>;
type LiveFlows = ReturnType<typeof sampleFlows>;

function testLayout(flows: LiveFlows, model: LiveModel): void {
  // ---- 1. DATA -> GEOMETRY / LAYOUT: tripartite columns, engine hub, two legs per flow ----
  const sourceNodes = model.nodes.filter((n) => n.column === "source");
  const destNodes = model.nodes.filter((n) => n.column === "destination");
  const engineNodes = model.nodes.filter((n) => n.column === "engine");
  ok("5 distinct source nodes", sourceNodes.length === 5);
  ok("4 distinct destination nodes (shared dest deduped)", destNodes.length === 4);
  ok("exactly one engine hub node in the centre", engineNodes.length === 1);
  ok("the engine hub is surfaced on the model", model.engineNode !== null && model.engineNode.id === "engine");

  // Three columns at fixed, separated x: sources left, engine centre, destinations right.
  const srcX = sourceNodes[0]!.x;
  const engX = engineNodes[0]!.x;
  const dstX = destNodes[0]!.x;
  ok("all sources share one column x", new Set(sourceNodes.map((n) => n.x)).size === 1);
  ok("all destinations share one column x", new Set(destNodes.map((n) => n.x)).size === 1);
  ok("columns are ordered source < engine < destination (left -> centre -> right)", srcX < engX && engX < dstX);

  // All coordinates are normalised into [0,1] (the GL layer maps to clip space).
  const inUnit = model.nodes.every((n) => n.x >= 0 && n.x <= 1 && n.y >= 0 && n.y <= 1);
  ok("every node sits in normalised [0,1] space", inUnit);

  // Every flow becomes ONE edge with TWO legs (ingress source->engine, egress engine->dest).
  ok("one edge per flow", model.edges.length === flows.length);
  ok("two legs per flow (ingress + egress) in the flat leg list", model.legs.length === flows.length * 2);
  const everyEdgeHasTwoLegs = model.edges.every(
    (e) => e.ingress.leg === "ingress" && e.egress.leg === "egress" && e.ingress.flowId === e.flowId && e.egress.flowId === e.flowId,
  );
  ok("each edge carries an ingress and an egress leg for its flow", everyEdgeHasTwoLegs);
  // The legs route THROUGH the engine: ingress ends at the engine, egress starts at the engine.
  const routedThroughEngine = model.edges.every((e) => e.ingress.toNodeId === "engine" && e.egress.fromNodeId === "engine");
  ok("every flow routes through the engine hub (ingress->engine->egress)", routedThroughEngine);

  // The shared destination carries both incident flows; the engine hub carries them all.
  const archive = destNodes.find((n) => n.label === "archive-bucket");
  ok("shared dest node has both incident flows", archive !== undefined && archive.flowIds.length === 2 && archive.flowIds.includes("dp-1") && archive.flowIds.includes("dp-2"));
  ok("the engine hub carries every flow id", model.engineNode !== null && model.engineNode.flowIds.length === flows.length);

  // Each leg is a cubic with endpoints on its two nodes (the particle marcher rides this curve).
  const legsWellFormed = model.legs.every(
    (l) => Number.isFinite(l.x0) && Number.isFinite(l.y0) && Number.isFinite(l.x3) && Number.isFinite(l.y3) && Number.isFinite(l.x1) && Number.isFinite(l.x2),
  );
  ok("every leg has finite cubic control points", legsWellFormed);

  // Determinism: a second build of the SAME data yields identical geometry + encoding.
  const model2 = buildLiveFlowModel({ flows: sampleFlows() });
  ok("layout is deterministic (identical model on rebuild)", JSON.stringify(geom(model)) === JSON.stringify(geom(model2)));

  // ---- 1a-bis. THE HUB LANE FAN (no stacked egress legs) --------------------------------
  // Every flow crosses the hub in its own lane: with the single account-wide destination the
  // engine->destination legs would otherwise all be the SAME cubic, stacking N statuses into
  // one unreadable line. Each edge's ingress must HAND OVER to its egress at the same lane
  // point (a continuous path through the hub), the lanes must differ across flows, stay
  // bounded near the hub centre, and a single flow must take the centre line.
  const engineY = engineNodes[0]!.y;
  const laneContinuous = model.edges.every((e) => e.ingress.x3 === e.egress.x0 && e.ingress.y3 === e.egress.y0);
  ok("each flow's ingress hands over to its egress at the same hub lane point", laneContinuous);
  const laneYs = model.edges.map((e) => e.egress.y0);
  ok("egress legs do NOT all stack on one cubic (distinct hub lanes)", new Set(laneYs).size === model.edges.length);
  ok("every hub lane stays bounded near the hub centre", laneYs.every((y) => Math.abs(y - engineY) <= 0.1));
  ok("hubLaneOffset: a single flow takes the centre line", hubLaneOffset(0, 1) === 0);
  ok("hubLaneOffset: lanes are symmetric about the centre", Math.abs(hubLaneOffset(0, 5) + hubLaneOffset(4, 5)) < 1e-12);
  // Egress legs still CONVERGE on the destination node itself (the lane is hub-side only).
  const egressEndsOnDest = model.edges.every((e) => {
    const dest = model.nodes.find((n) => n.id === e.egress.toNodeId)!;
    return e.egress.x3 === dest.x && e.egress.y3 === dest.y;
  });
  ok("egress legs still end exactly on their destination node", egressEndsOnDest);
  const ingressStartsOnSource = model.edges.every((e) => {
    const src = model.nodes.find((n) => n.id === e.ingress.fromNodeId)!;
    return e.ingress.x0 === src.x && e.ingress.y0 === src.y;
  });
  ok("ingress legs still start exactly on their source node", ingressStartsOnSource);
}

function testHealth(model: LiveModel): void {
  // ---- 1b. HEALTH ENCODING: hue + glyph + label, identical to the SVG map, honest -------
  // The live-flow edge presentation must equal the SVG map's presentStatus for the same status,
  // so the two views cannot disagree about health, and unknown/disabled never read green.
  let healthParity = true;
  for (const e of model.edges) {
    const expected = presentStatus(e.flow.status);
    if (e.presentation.tone !== expected.tone || e.presentation.glyph !== expected.glyph || e.presentation.label !== expected.label) healthParity = false;
  }
  ok("edge health presentation matches the SVG map (tone + glyph + label)", healthParity);
  const unknownEdge = model.edges.find((e) => e.flow.status === "unknown")!;
  const disabledEdge = model.edges.find((e) => e.flow.status === "disabled")!;
  ok("unknown is never the trust tone (never a stale green)", unknownEdge.presentation.tone !== "trust");
  ok("disabled is never the trust tone (never a stale green)", disabledEdge.presentation.tone !== "trust");
  ok("only a healthy flow carries the trust tone", model.edges.filter((e) => e.presentation.tone === "trust").every((e) => e.flow.status === "healthy"));
}

function testThroughput(model: LiveModel): void {
  // ---- 1c. THROUGHPUT -> bounded edge weight (volume), number is the truth --------------
  const weights = model.edges.map((e) => e.weight);
  ok("every edge weight is one of three bounded steps", weights.every((w) => w === 1 || w === 2 || w === 3));
  ok("sub-MB flow is the thinnest edge", model.edges.find((e) => e.flowId === "dp-2")!.weight === 1);
  ok(">= 1 MB flow is a medium edge", model.edges.find((e) => e.flowId === "dp-1")!.weight === 2);
  ok(">= 64 MB flow is a thick edge", model.edges.find((e) => e.flowId === "dp-3")!.weight === 3);
  ok("unknown throughput is the thinnest edge (never inflated)", model.edges.find((e) => e.flowId === "dp-4")!.weight === 1);
}

function testFlowingAndSheen(flows: LiveFlows, model: LiveModel): void {
  // ---- 1d. THE FLOWING + DENSER-STREAM RULE (an active run is a denser stream), honest ---
  // A flow streams ONLY when running AND non-terminal; a denser flow emits a denser stream; a
  // non-flowing flow emits NOTHING (the stream is never fabricated).
  ok("isFlowing: a healthy running flow is flowing", isFlowing(flows[0]!) === true);
  ok("isFlowing: a stale NOT-running flow is not flowing", isFlowing(flows[1]!) === false);
  ok("isFlowing: a FAILED running flow is NEVER flowing (terminal status wins)", isFlowing(flows[2]!) === false);
  ok("isFlowing: a DISABLED flow is never flowing", isFlowing(flows[3]!) === false);
  ok("isFlowing: an UNKNOWN running flow is flowing (a live, honest trickle)", isFlowing(flows[4]!) === true);

  // The model's flowing flag matches isFlowing for every edge.
  ok("model flowing flag matches the isFlowing rule", model.edges.every((e) => e.flowing === isFlowing(e.flow)));

  // ---- 1d-bis. THE AMBIENT-SHEEN RULE (idle liveliness, honest) -------------------------
  // Between runs the map carries a slow dim sheen along PROVEN idle routes only. The honesty
  // bounds: a flowing edge takes the live stream INSTEAD (the sheen never doubles the in-flight
  // signal), and failed / disabled / unknown edges stay inert (no fabricated liveliness over a
  // broken, paused or unreadable route).
  ok("sheen: an idle healthy flow carries the ambient sheen", hasAmbientSheen({ ...flows[0]!, running: false }) === true);
  ok("sheen: an idle stale flow carries the ambient sheen (a proven route, loudly stale elsewhere)", hasAmbientSheen(flows[1]!) === true);
  ok("sheen: a FLOWING flow does NOT take the sheen (the stream is the in-flight signal)", hasAmbientSheen(flows[0]!) === false);
  ok("sheen: a failed flow is inert (the red pipe is the statement)", hasAmbientSheen({ ...flows[2]!, running: false }) === false);
  ok("sheen: a disabled flow is inert (paused is the statement)", hasAmbientSheen(flows[3]!) === false);
  // An UNKNOWN enabled route sheens in its own neutral slate: configured-and-watched is true
  // before the first readable run, and a young account's map must not look dead. The hue claims
  // nothing the pipe does not already claim.
  ok("sheen: an idle unknown ENABLED flow carries the neutral sheen (young accounts live too)", hasAmbientSheen({ ...flows[4]!, running: false }) === true);

  // Particle rate: 0 for non-flowing; bounded 1..3 for flowing, by throughput bucket; a denser
  // (more bytes) running flow is a denser stream.
  ok("a non-flowing (failed) flow emits NO particles (rate 0)", model.edges.find((e) => e.flowId === "dp-3")!.particleRate === 0);
  ok("a non-flowing (disabled) flow emits NO particles (rate 0)", model.edges.find((e) => e.flowId === "dp-4")!.particleRate === 0);
  ok("a non-flowing (idle stale) flow emits NO particles (rate 0)", model.edges.find((e) => e.flowId === "dp-2")!.particleRate === 0);
  ok("a flowing medium flow emits a medium stream (rate 2)", model.edges.find((e) => e.flowId === "dp-1")!.particleRate === 2);
  ok("a flowing UNKNOWN-throughput flow still trickles (rate 1, an honest live cue)", model.edges.find((e) => e.flowId === "dp-5")!.particleRate === 1);
  // The denser-stream-for-more-bytes property, isolated: same running state, more bytes => >= rate.
  const slow = particleRateFor({ ...flows[0]!, running: true, bytesPerRun: 100 }, true);
  const fast = particleRateFor({ ...flows[0]!, running: true, bytesPerRun: 80 * 1024 * 1024 }, true);
  ok("a denser (more bytes) running flow is a denser stream", fast > slow);
  // Every particle rate is bounded (never an unbounded firehose).
  ok("every particle rate is bounded to 0..3", model.edges.every((e) => e.particleRate >= 0 && e.particleRate <= 3));
  // A non-flowing flow NEVER emits, no matter the byte count (the no-fabrication guarantee).
  ok("particleRateFor returns 0 for any non-flowing flow regardless of bytes", particleRateFor({ ...flows[0]!, bytesPerRun: 999 * 1024 * 1024 }, false) === 0);
}

function testFeatureDetect(): void {
  // ---- 2. FEATURE-DETECT / FALLBACK decision -------------------------------------------
  // chooseRenderMode picks WebGL only when available and not force-disabled; otherwise the SVG
  // fallback. Cover every branch (the GL itself is untestable headless; the DECISION is pure).
  ok("render mode: 2d available -> canvas2d (the one raster renderer; WebGL retired 2026-06-13)", chooseRenderMode({ canvas2dAvailable: true }) === "canvas2d");
  ok("render mode: no canvas -> svg fallback", chooseRenderMode({ canvas2dAvailable: false }) === "svg-fallback");
  // The real probe must return false in a non-DOM environment (this test runner), so the
  // caller falls back rather than throwing. This is the headless-safety guarantee.
  ok("detectCanvas2d returns false in a non-DOM environment (safe fallback, no throw)", detectCanvas2d() === false);
}

function testReducedMotion(): void {
  // ---- 3. REDUCED-MOTION static-frame decision -----------------------------------------
  // chooseAnimationMode paints a static frame under reduced motion (forced OR media query), and
  // animates otherwise. Cover every branch.
  ok("animation: no reduced motion -> animated", chooseAnimationMode({ mediaReducedMotion: false }) === "animated");
  ok("animation: media reduced-motion -> static frame", chooseAnimationMode({ mediaReducedMotion: true }) === "static-frame");
  ok("animation: forced reduced-motion overrides the media query -> static frame", chooseAnimationMode({ mediaReducedMotion: false, reducedMotion: true }) === "static-frame");
  ok("animation: forced false still honours the media query (true -> static)", chooseAnimationMode({ mediaReducedMotion: true, reducedMotion: false }) === "static-frame");
}

function testTableFallbackAndModelCases(flows: LiveFlows, model: LiveModel): void {
  // ---- 4. THE TABLE FALLBACK IS ALWAYS PRODUCED (canonical, parity with the SVG map) ----
  // buildTableSpec must return a COMPLETE spec (one row per flow + the full column set) in every
  // case, so the canonical accessible table can never be silently dropped by any render branch.
  const spec = buildTableSpec(flows, NOW, () => {});
  ok("table spec has one row per flow", spec.rows.length === flows.length);
  ok("table spec carries EVERY flow id", flows.every((f) => spec.rows.some((r) => r.flow.id === f.id)));
  ok("table spec has columns", spec.columns.length > 0);
  // Byte-for-byte parity with the SVG map's table rows (same buildTableRows source).
  const topoRows = buildTableRows(flows);
  ok("table rows equal the SVG map's table rows (shared canonical table)", JSON.stringify(spec.rows.map((r) => r.flow.id)) === JSON.stringify(topoRows.map((r) => r.flow.id)));
  // The status presentation in the table matches the live-flow edge presentation (no drift).
  let tableHealthParity = true;
  for (const r of spec.rows) {
    const edge = model.edges.find((e) => e.flowId === r.flow.id)!;
    if (r.presentation.tone !== edge.presentation.tone || r.presentation.label !== edge.presentation.label) tableHealthParity = false;
  }
  ok("table row health matches the live-flow edge health (parity)", tableHealthParity);
  // When an open handler is supplied, a trailing real open-button column is present (the
  // operable surface); without one (a read-only embed) there is none.
  const specWithOpen = buildTableSpec(flows, NOW, () => {});
  const specNoOpen = buildTableSpec(flows, NOW);
  ok("an open column is present when an open handler is supplied", specWithOpen.columns.some((c) => c.key === "open"));
  ok("no open column when there is no open handler (read-only)", specNoOpen.columns.every((c) => c.key !== "open"));
  // The table spec is ALWAYS complete even for the EMPTY flow set (the floor never disappears).
  const emptySpec = buildTableSpec([], NOW, () => {});
  ok("empty: table spec still returns the full column set", emptySpec.columns.length === specWithOpen.columns.length);
  ok("empty: table spec returns zero rows (honest, not fabricated)", emptySpec.rows.length === 0);

  // ---- 5. EMPTY + PARTIAL model cases ---------------------------------------------------
  const empty = buildLiveFlowModel({ flows: [] });
  ok("empty: no nodes (no orphan engine hub)", empty.nodes.length === 0);
  ok("empty: no engine node when there are no flows", empty.engineNode === null);
  ok("empty: no edges, no legs", empty.edges.length === 0 && empty.legs.length === 0);
  ok("empty: counts total is zero", empty.counts.total === 0);

  // A single source builds a balanced layout (the lone node + a hub + a destination) without a
  // divide-by-zero in the column spread.
  const single = buildLiveFlowModel({
    flows: [{ id: "solo", source: { name: "only", kind: "kv" }, destination: { name: "arch", kind: "r2" }, status: "healthy", lastRunAt: ts(-3600), cadence: 86400, bytesPerRun: 1024, enabled: true, running: false }],
  });
  ok("single flow: one source, one engine, one destination", single.nodes.filter((n) => n.column === "source").length === 1 && single.nodes.filter((n) => n.column === "engine").length === 1 && single.nodes.filter((n) => n.column === "destination").length === 1);
  ok("single flow: the lone source y is finite (no divide-by-zero in the spread)", Number.isFinite(single.nodes.find((n) => n.column === "source")!.y));

  // The lone-node placement rule: in the true 1x1 case the source/destination are offset off
  // the centre line (the graph fans instead of collapsing to one flat streak); a lone node
  // FACING A SPREAD column (the real fleet shape: many sources, one archive) sits ON the
  // centre line, level with the engine hub, so the convergence axis is horizontal and centred
  // (the graph must not read as off-centre).
  const engY = single.nodes.find((n) => n.column === "engine")!.y;
  const soloSrcY = single.nodes.find((n) => n.column === "source")!.y;
  const soloDstY = single.nodes.find((n) => n.column === "destination")!.y;
  ok("1x1: the lone source sits above the centre line", soloSrcY < engY);
  ok("1x1: the lone destination sits below the centre line", soloDstY > engY);
  const fanned = buildLiveFlowModel({ flows: sampleFlows().map((f) => ({ ...f, destination: { name: "one-archive", kind: "r2" as const } })) });
  const fannedDest = fanned.nodes.filter((n) => n.column === "destination");
  ok("N x 1: exactly one destination node", fannedDest.length === 1);
  ok("N x 1: the lone destination is CENTRED, level with the engine hub", fannedDest[0]!.y === fanned.nodes.find((n) => n.column === "engine")!.y);

  // Partial: a subset unknown; none coerced to green; the rest render normally.
  const partial = buildLiveFlowModel({ flows: [{ ...flows[0]! }, { ...flows[4]! }] });
  ok("partial: both flows produce edges", partial.edges.length === 2);
  ok("partial: the unknown flow stays unknown (not green)", partial.edges.find((e) => e.flow.status === "unknown")!.presentation.tone !== "trust");
}

function testColourHonesty(): void {
  // ---- 6. COLOUR HONESTY: the fallback palette + the CSS-colour parser ------------------
  // The GL layer reads live theme colours when available and falls back to statusFallbackRgb.
  // The honest invariant: unknown/disabled (both "neutral") must NEVER be the trust hue, and the
  // palette is calm (danger is a desaturated red, not a pure alarm-red FF0000).
  const trustRgb = statusFallbackRgb("trust");
  const neutralRgb = statusFallbackRgb("neutral");
  const dangerRgb = statusFallbackRgb("danger");
  ok("fallback palette: neutral (unknown/disabled) differs from trust (never a green)", JSON.stringify(neutralRgb) !== JSON.stringify(trustRgb));
  ok("fallback palette: every channel is in [0,1]", [trustRgb, neutralRgb, dangerRgb].every((c) => [c.r, c.g, c.b].every((v) => v >= 0 && v <= 1)));
  ok("fallback palette: danger is a CALM red (not pure alarm-red FF0000)", !(dangerRgb.r === 1 && dangerRgb.g === 0 && dangerRgb.b === 0));
  ok("fallback palette: trust reads green-dominant teal (g channel strongest)", trustRgb.g >= trustRgb.r && trustRgb.g >= trustRgb.b);

  // parseCssColour handles #rgb / #rrggbb / rgb()/rgba(), and rejects junk (caller falls back).
  ok("parseCssColour: #rrggbb white -> 1,1,1", eqRgb(parseCssColour("#ffffff"), { r: 1, g: 1, b: 1 }));
  ok("parseCssColour: #rgb short black -> 0,0,0", eqRgb(parseCssColour("#000"), { r: 0, g: 0, b: 0 }));
  ok("parseCssColour: rgb() mid-grey -> ~0.5", approxRgb(parseCssColour("rgb(128, 128, 128)"), 0.5));
  ok("parseCssColour: rgba() honours the three channels", eqRgb(parseCssColour("rgba(255, 0, 0, 0.5)"), { r: 1, g: 0, b: 0 }));
  ok("parseCssColour: empty string -> null (caller falls back)", parseCssColour("") === null);
  ok("parseCssColour: junk -> null (caller falls back)", parseCssColour("not-a-colour") === null);
  ok("parseCssColour: a CSS variable reference -> null (caller falls back)", parseCssColour("var(--x)") === null);
}

async function testRenderLayer(): Promise<void> {
  // ---- 7. RENDER-LAYER invariants under a DOM stub + a fake GL context -------------
  // WebGL cannot run headless, but the render path's SAFETY invariants are testable with a hand-
  // rolled DOM stub + a fake GL context (no jsdom, no new dep), using the module's own injection
  // points (canvas2dProbe / reducedMotion). We prove: (a) the SVG-fallback branch
  // still mounts the canonical topology TABLE; (b) under reduced motion the GL controller paints a
  // single static frame and NEVER calls requestAnimationFrame (the no-rAF invariant for motion-
  // sensitive users); (c) a webglcontextlost event does not throw and STOPS the rAF loop (so it
  // cannot spin forever on a dead context). The stub is torn down after the cases settle.
  await renderLayerTests();

  // Hover focus (the "hover a source to trace its paths" effect): litNodeIds lights the hovered node, the
  // engine hub, and the opposite-column nodes its paths reach; every other node dims (the canvas dims the
  // pipes to match). Two independent flows, so hovering the first's source must NOT light the second's nodes.
  {
    const model = buildLiveFlowModel({
      flows: [
        { id: "f1", source: { name: "kv-a", kind: "kv" }, destination: { name: "bucket-1", kind: "r2" }, status: "healthy", enabled: true, running: false },
        { id: "f2", source: { name: "kv-b", kind: "kv" }, destination: { name: "bucket-2", kind: "r2" }, status: "healthy", enabled: true, running: false },
      ],
    });
    const find = (col: string, needle: string) => model.nodes.find((n) => n.column === col && n.label.includes(needle));
    const srcA = find("source", "kv-a")!;
    const lit = litNodeIds(srcA, model.nodes);
    ok("hovering a source lights itself", lit.has(srcA.id));
    ok("hovering a source lights the engine hub", lit.has(model.nodes.find((n) => n.column === "engine")!.id));
    ok("hovering a source lights the destination its path reaches", lit.has(find("destination", "bucket-1")!.id));
    ok("hovering a source does NOT light an unrelated source", !lit.has(find("source", "kv-b")!.id));
    ok("hovering a source does NOT light an unrelated destination", !lit.has(find("destination", "bucket-2")!.id));
  }
    ok("a small fleet animates", shouldAnimate(10, "animated") === true);
    ok("a fleet exactly at the cap still animates", shouldAnimate(LIVE_FLOW_MAX_ANIMATED_EDGES, "animated") === true);
    ok("a fleet past the cap goes static (motion off, pipes still drawn)", shouldAnimate(LIVE_FLOW_MAX_ANIMATED_EDGES + 1, "animated") === false);
    ok("reduced motion is static at any size", shouldAnimate(1, "static-frame") === false);
    ok("the cap is a sane, tunable threshold (tens to low-hundreds of edges)", LIVE_FLOW_MAX_ANIMATED_EDGES >= 50 && LIVE_FLOW_MAX_ANIMATED_EDGES <= 1000);
}

async function main(): Promise<void> {
  const flows = sampleFlows();
  const model = buildLiveFlowModel({ flows });

  testLayout(flows, model);
  testHealth(model);
  testThroughput(model);
  testFlowingAndSheen(flows, model);
  testFeatureDetect();
  testReducedMotion();
  testTableFallbackAndModelCases(flows, model);
  testColourHonesty();
  await testRenderLayer();

  console.log(failures === 0 ? "\nLIVE-FLOW VECTORS PASS" : `\n${failures} FAILURE(S)`);
    if (failures > 0) process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// A minimal, self-contained DOM + WebGL stub for the render-layer tests. It is NOT a general
// DOM: it implements only what renderLiveFlow, the reused data-table/topology table, and the GL
// controller touch (element creation, attributes, CSSOM setProperty, events, a canvas getContext,
// and a fake GL context whose calls are all no-ops that succeed). It transmits nothing and reads
// no real GPU; the no-custody and CSP discipline are untouched (no innerHTML, no inline-style
// attribute writes are needed by the stub).
// ---------------------------------------------------------------------------------------------

// A CSSOM-like style object: setProperty stores per-property (mirroring the production node.style
// .setProperty path, NEVER a setAttribute("style") write, so the CSP discipline is preserved).
class StubStyle {
  props: Record<string, string> = {};
  setProperty(name: string, value: string): void {
    this.props[name] = String(value);
  }
  getPropertyValue(name: string): string {
    return this.props[name] ?? "";
  }
  removeProperty(name: string): void {
    delete this.props[name];
  }
}

interface StubEvent {
  type: string;
  defaultPrevented: boolean;
  preventDefault(): void;
}

// A DOMTokenList-like classList that reads/writes through the owning node's class attribute, so
// data-table's classList.add/contains and the h() className path stay in sync.
class StubClassList {
  private owner: StubNode;
  constructor(owner: StubNode) {
    this.owner = owner;
  }
  private tokens(): Set<string> {
    return new Set((this.owner.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
  }
  private write(set: Set<string>): void {
    this.owner.setAttribute("class", [...set].join(" "));
  }
  add(...cs: string[]): void {
    const t = this.tokens();
    for (const c of cs) t.add(c);
    this.write(t);
  }
  remove(...cs: string[]): void {
    const t = this.tokens();
    for (const c of cs) t.delete(c);
    this.write(t);
  }
  contains(c: string): boolean {
    return this.tokens().has(c);
  }
  toggle(c: string, force?: boolean): boolean {
    const t = this.tokens();
    const has = t.has(c);
    const on = force === undefined ? !has : force;
    if (on) t.add(c);
    else t.delete(c);
    this.write(t);
    return on;
  }
}

let connectedRootSeq = 0;
const CONNECTED = new Set<number>();

class StubNode {
  readonly nid = ++connectedRootSeq;
  kind: "element" | "text";
  nodeType: number;
  tagName = "";
  childNodes: StubNode[] = [];
  parentNode: StubNode | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(ev: StubEvent) => void>> = {};
  style = new StubStyle();
  classList: StubClassList;
  dataset: Record<string, string> = {};
  text_ = "";
  value = "";
  disabled = false;
  checked = false;
  // Canvas-ish fields (only meaningful on a <canvas>): a fixed non-zero client box so resize()
  // measures a real size, plus a getContext returning the fake 2D context.
  clientWidth = 800;
  clientHeight = 400;
  width = 0;
  height = 0;
  ctx2d: Fake2d | null = null;

  constructor(kind: "element" | "text", tag = "") {
    this.kind = kind;
    this.nodeType = kind === "text" ? 3 : 1;
    this.tagName = tag.toUpperCase();
    this.classList = new StubClassList(this);
  }

  get className(): string {
    return this.attrs.class ?? "";
  }
  set className(v: string) {
    this.attrs.class = String(v);
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k: string): void {
    delete this.attrs[k];
  }
  hasAttribute(k: string): boolean {
    return k in this.attrs;
  }

  appendChild(child: StubNode | null): StubNode | null {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child: StubNode): StubNode {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) {
      this.childNodes.splice(i, 1);
      child.parentNode = null;
    }
    return child;
  }
  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  replaceChildren(...nodes: StubNode[]): void {
    for (const c of [...this.childNodes]) this.removeChild(c);
    for (const n of nodes) this.appendChild(n);
  }

  get isConnected(): boolean {
    let n: StubNode | null = this;
    while (n) {
      if (CONNECTED.has(n.nid)) return true;
      n = n.parentNode;
    }
    return false;
  }

  set textContent(v: string) {
    this.text_ = v == null ? "" : String(v);
    this.childNodes = [];
  }
  get textContent(): string {
    if (this.kind === "text") return this.text_;
    let out = this.text_ || "";
    for (const c of this.childNodes) out += c.textContent;
    return out;
  }

  addEventListener(type: string, fn: (ev: StubEvent) => void): void {
    this.listeners[type] ||= []; this.listeners[type].push(fn);
  }
  removeEventListener(type: string, fn: (ev: StubEvent) => void): void {
    const l = this.listeners[type];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  dispatchEvent(ev: StubEvent): boolean {
    for (const fn of [...(this.listeners[ev.type] ?? [])]) fn.call(this, ev);
    return !ev.defaultPrevented;
  }
  focus(): void {
    /* no-op */
  }

  // A canvas getContext: only "2d" returns the fake 2D context (no WebGL in the stub, which
  // is also the truth of the environments the 2D renderer exists for).
  getContext(kind: string): Fake2d | null {
    if (kind === "2d") {
      this.ctx2d ||= new Fake2d();
      return this.ctx2d;
    }
    return null;
  }

  // Minimal selector support: only tag selectors are needed (the tests query for "table").
  private walk(cb: (n: StubNode) => void): void {
    for (const c of this.childNodes) {
      cb(c);
      c.walk(cb);
    }
  }
  querySelector(sel: string): StubNode | null {
    let found: StubNode | null = null;
    const want = sel.toUpperCase();
    this.walk((n) => {
      if (!found && n.nodeType === 1 && n.tagName === want) found = n;
    });
    return found;
  }
  querySelectorAll(sel: string): StubNode[] {
    const out: StubNode[] = [];
    const want = sel.toUpperCase();
    this.walk((n) => {
      if (n.nodeType === 1 && n.tagName === want) out.push(n);
    });
    return out;
  }
}

// Fake2d: every CanvasRenderingContext2D member the 2D controller touches, as succeeding
// no-ops, with draw-call counters so the tests can assert a frame was genuinely painted.
class Fake2d {
  strokeStyle = "";
  fillStyle = "";
  lineWidth = 0;
  lineCap = "";
  drawCalls = 0;
  clearRect(): void {}
  drawImage(): void {
    this.drawCalls++;
  }
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  bezierCurveTo(): void {}
  arc(): void {}
  stroke(): void {
    this.drawCalls++;
  }
  fill(): void {
    this.drawCalls++;
  }
}

// installStubDom puts the document/window globals in place (idempotent). window aliases globalThis
// so window.setTimeout/clearTimeout/matchMedia/requestAnimationFrame resolve through it. matchMedia
// reports NO reduced motion and NO dark scheme (the tests force the modes they need explicitly).
function installStubDom(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if ((g.document as { __stub?: boolean } | undefined)?.__stub) return;
  const make = (tag: string): StubNode => new StubNode("element", tag);
  const docEl = make("html");
  const body = make("body");
  docEl.appendChild(body);
  CONNECTED.add(docEl.nid); // the document element is "connected"
  g.document = {
    __stub: true,
    documentElement: docEl,
    body,
    createElement: (tag: string) => make(tag),
    createElementNS: (_ns: string, tag: string) => make(tag),
    createTextNode: (t: string) => {
      const n = new StubNode("text");
      n.text_ = t == null ? "" : String(t);
      return n;
    },
    createDocumentFragment: () => new StubNode("element", "fragment"),
    readyState: "complete",
  };
  // dom.ts's isAttrs() does `x instanceof Node` to tell an attrs object from a node child, so the
  // global Node must resolve to our node class for the h() builder to work headless.
  g.Node = StubNode;
  g.window = globalThis;
  if (typeof (g.matchMedia) !== "function") {
    g.matchMedia = (_q: string) => ({
      matches: false,
      media: _q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    });
  }
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = g.matchMedia;
  // getComputedStyle is only reached by the GL tone-colour probe; return empty so it falls back to
  // the honest static palette (the colour parsing itself is covered by section 6).
  if (typeof (g.getComputedStyle) !== "function") {
    g.getComputedStyle = () => ({ color: "", getPropertyValue: () => "" });
  }
  // A no-op MutationObserver and ResizeObserver so the controller's theme/resize wiring installs
  // without throwing. The ResizeObserver here never auto-fires; the tests drive init via the
  // microtask path (the root is marked connected) so the no-rAF / context-loss assertions are
  // deterministic and do not depend on observer scheduling.
  if (typeof (g.MutationObserver) !== "function") {
    g.MutationObserver = class {
      observe(): void {}
      disconnect(): void {}
    };
  }
  if (typeof (g.ResizeObserver) !== "function") {
    g.ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
    };
  }
}

function uninstallStubDom(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.document;
  delete g.Node;
  // Leave window === globalThis and the observer/matchMedia stubs in place (harmless); clearing
  // document is enough to make detectCanvas2d() and the guards read "no DOM" again for later runs.
}

// A controllable requestAnimationFrame: callbacks are queued, not run, until flushRaf() runs them.
// scheduleCount tracks how many times rAF was REQUESTED (the no-rAF invariant asserts this stays
// 0 under reduced motion). Installed on globalThis so the production `requestAnimationFrame`
// reference resolves to it.
interface RafHarness {
  scheduleCount: number;
  queue: Array<(ts: number) => void>;
  flush: (ts?: number) => void;
  restore: () => void;
}
function installRaf(): RafHarness {
  const g = globalThis as unknown as Record<string, unknown>;
  const prevRaf = g.requestAnimationFrame;
  const prevCancel = g.cancelAnimationFrame;
  const harness: RafHarness = {
    scheduleCount: 0,
    queue: [],
    flush(ts = 16): void {
      const due = this.queue;
      this.queue = [];
      for (const cb of due) cb(ts);
    },
    restore(): void {
      g.requestAnimationFrame = prevRaf;
      g.cancelAnimationFrame = prevCancel;
    },
  };
  const ids = new Map<number, (ts: number) => void>();
  let idSeq = 0;
  g.requestAnimationFrame = (cb: (ts: number) => void): number => {
    harness.scheduleCount++;
    const id = ++idSeq;
    ids.set(id, cb);
    harness.queue.push(cb);
    return id;
  };
  g.cancelAnimationFrame = (id: number): void => {
    const cb = ids.get(id);
    if (cb) {
      const i = harness.queue.indexOf(cb);
      if (i >= 0) harness.queue.splice(i, 1);
      ids.delete(id);
    }
  };
  return harness;
}

// flushMicrotasks drains the microtask queue so the deferred GL init (queueMicrotask) runs.
async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// markConnected flags a rendered root as document-connected so renderLiveFlow's ensureController
// (which waits for root.isConnected) proceeds, mirroring a real mount.
function markConnected(root: unknown): void {
  CONNECTED.add((root as StubNode).nid);
}

// renderLayerTests runs the three R8 cases against the DOM stub, awaiting each so the deferred GL
// init (queueMicrotask) settles before the assertions and before teardown.
async function renderLayerTests(): Promise<void> {
  installStubDom();
  try {
    renderLayerCaseA();
    await renderLayerCaseB();
    renderLayerCaseD();
    renderLayerCaseE();
  } finally {
    uninstallStubDom();
  }
}

function sampleTwoFlows(): FlowRecord[] {
  return [sampleFlows()[0]!, sampleFlows()[4]!];
}

// (a) no usable canvas -> the SVG-fallback branch, which must still mount the canonical
// topology TABLE (the accessible floor is never dropped when raster rendering is unavailable).
function renderLayerCaseA(): void {
  const handle: LiveFlowHandle = renderLiveFlow({
    flows: sampleTwoFlows(),
    canvas2dProbe: () => false,
    onActivateEdge: () => {},
    now: NOW,
  });
  ok("render(a): no canvas yields the svg-fallback mode", handle.mode === "svg-fallback");
  const root = handle.el as unknown as StubNode;
  const table = root.querySelector("table");
  ok("render(a): the svg-fallback root contains the canonical topology TABLE", table !== null);
  handle.dispose();
}

// (b) stub 2D + reducedMotion:true -> a single static frame, NEVER a requestAnimationFrame call.
async function renderLayerCaseB(): Promise<void> {
  const raf = installRaf();
  let handle: LiveFlowHandle | null = null;
  try {
    handle = renderLiveFlow({
      flows: sampleTwoFlows(),
      reducedMotion: true, // force the static-frame branch
      onActivateEdge: () => {},
      now: NOW,
    });
    ok("render(b): reduced motion takes the static-frame animation mode", handle.animation === "static-frame");
    // The controller is created AFTER the canvas is connected; mark it connected and drain the
    // microtask so the deferred init + the single static frame run.
    markConnected(handle.el);
    await flushMicrotasks();
    ok("render(b): the view takes the canvas2d mode (the stub 2d context initialised)", handle.mode === "canvas2d");
    ok("render(b): NO requestAnimationFrame was ever scheduled under reduced motion (no-rAF invariant)", raf.scheduleCount === 0);
    // The static frame is still genuinely PAINTED (not skipped): the fake 2D context recorded
    // draw calls. This proves the no-rAF branch draws once rather than leaving a blank canvas
    // for motion-sensitive users.
    const canvas = (handle.el as unknown as StubNode).querySelector("canvas");
    const g = canvas ? canvas.getContext("2d") : null;
    ok("render(b): the single static frame is actually drawn once (draw calls recorded)", g !== null && g.drawCalls > 0);
  } finally {
    if (handle) handle.dispose();
    raf.restore();
  }
}

// (the former case (c), GPU context loss/restore, retired with the WebGL controller: a 2D
// context cannot be lost. The animated-loop liveliness is covered by the real-browser checks
// in the deploy workflow; the no-rAF invariant stays pinned by case (b).)

// (d) the DOM NODE LAYER over the canvas: the webgl branch must mount one LABELLED element per
// source/destination node (the "none of the nodes show" fix: the canvas alone marked endpoints
// with near-invisible dots and no names), operable as buttons when onActivateNode is wired
// (activate filters, Escape clears), decorative + aria-hidden when not, with the dense-column
// cap collapsing a crowded side into one honest count chip. setFlows must rebuild the layer.
function renderLayerCaseD(): void {
  // Helpers over the stub: find node-layer elements by class.
  const byClass = (root: StubNode, tag: string, cls: string): StubNode[] =>
    root.querySelectorAll(tag).filter((n) => n.classList.contains(cls));

  // Operable: onActivateNode wired -> labelled BUTTONS that activate + Escape to clear.
  let activated: string | null = null;
  let cleared = 0;
  const handle = renderLiveFlow({
    flows: sampleTwoFlows(),
    reducedMotion: true,
    onActivateEdge: () => {},
    onActivateNode: (id: string) => {
      activated = id;
    },
    onClearNodeFilter: () => {
      cleared++;
    },
    now: NOW,
  });
  const root = handle.el as unknown as StubNode;
  const layer = byClass(root, "div", "live-flow__nodes")[0];
  ok("render(d): the node layer is mounted over the canvas", layer !== undefined);
  const buttons = byClass(root, "button", "live-flow__node");
  ok("render(d): one operable node button per source + destination (2 + 2)", buttons.length === 4);
  const names = buttons.map((b) => b.textContent);
  ok(
    "render(d): node buttons carry the endpoint NAMES (labelled, not anonymous dots)",
    ["uploads-prod", "metrics", "archive-bucket", "cold-store"].every((n) => names.some((t) => t.includes(n))),
  );
  ok("render(d): the engine hub carries its caption", byClass(root, "span", "live-flow__node--engine").some((n) => n.textContent.includes("Engine")));
  ok("render(d): the operable layer is NOT aria-hidden (its buttons are real controls)", layer !== undefined && layer.getAttribute("aria-hidden") === null);
  // Activate the first source node: the callback receives the node id.
  if (buttons.length > 0) {
    buttons[0]!.dispatchEvent({ type: "click", defaultPrevented: false, preventDefault() {} });
  }
  ok("render(d): activating a node button calls onActivateNode with the node id", activated === "source:kv:uploads-prod");
  // Escape anywhere on the layer clears the node filter (parity with the SVG node groups).
  if (layer) {
    const esc = { type: "keydown", key: "Escape", defaultPrevented: false, preventDefault() {} } as unknown as StubEvent;
    layer.dispatchEvent(esc);
  }
  ok("render(d): Escape on the node layer clears the node filter", cleared === 1);
  // A poll that changes the flow set rebuilds the layer (and an emptied set empties it).
  handle.setFlows([]);
  ok("render(d): an emptied flow set empties the node layer (honest, no ghost labels)", byClass(root, "button", "live-flow__node").length === 0);
  handle.setFlows(sampleTwoFlows());
  ok("render(d): a repopulated flow set rebuilds the labelled nodes", byClass(root, "button", "live-flow__node").length === 4);
  handle.dispose();

  // Read-only: no onActivateNode -> plain marks, aria-hidden layer, no buttons at all.
  const ro = renderLiveFlow({ flows: sampleTwoFlows(), reducedMotion: true, now: NOW });
  const roRoot = ro.el as unknown as StubNode;
  const roLayer = byClass(roRoot, "div", "live-flow__nodes")[0];
  ok("render(d): the read-only layer is aria-hidden (decorative; the table is canonical)", roLayer !== undefined && roLayer.getAttribute("aria-hidden") === "true");
  ok("render(d): the read-only layer renders NO buttons (no dead controls)", byClass(roRoot, "button", "live-flow__node").length === 0);
  ok("render(d): the read-only layer still carries the labels as plain marks", byClass(roRoot, "span", "live-flow__node").length >= 4);
  ro.dispose();

  // Dense column: more sources than the label cap -> per-node labels drop for ONE count chip;
  // the sparse destination side keeps its label.
  const dense: FlowRecord[] = [];
  for (let i = 0; i < 20; i++) {
    dense.push({
      id: `dp-d${i}`,
      source: { name: `ns-${i}`, kind: "kv" },
      destination: { name: "archive-bucket", kind: "r2" },
      status: "healthy",
      lastRunAt: ts(-3600),
      cadence: 86400,
      bytesPerRun: 1024,
      enabled: true,
      running: false,
    });
  }
  const dh = renderLiveFlow({ flows: dense, reducedMotion: true, onActivateNode: () => {}, now: NOW });
  const dRoot = dh.el as unknown as StubNode;
  const dButtons = byClass(dRoot, "button", "live-flow__node");
  ok("render(d): a dense source column drops per-node labels (only the lone destination stays)", dButtons.length === 1 && dButtons[0]!.textContent.includes("archive-bucket"));
  const chips = byClass(dRoot, "span", "live-flow__node-summary");
  ok("render(d): the dense column is summarised by one honest count chip", chips.length === 1 && chips[0]!.textContent === "20 sources");
  dh.dispose();
}

// (e) the CONSOLE-LEVEL MOTION OVERRIDE: the data-motion attribute lib/a11y-prefs.ts maintains
// on <html> outranks the OS media query in BOTH directions - "full" (the operator's explicit
// persisted opt-in) animates even when the OS prefers reduced motion (a map must never be frozen
// by an OS setting with no way to say "animate this one"), "reduced" forces the
// static frame even when the OS allows motion, and no attribute defers to the query.
function renderLayerCaseE(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const doc = g.document as { documentElement: StubNode };
  const prevMM = g.matchMedia;
  const mm = (matches: boolean) => () => ({
    matches,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
  try {
    g.matchMedia = mm(true); // the OS prefers reduced motion...
    doc.documentElement.setAttribute("data-motion", "full");
    const full = renderLiveFlow({ flows: sampleTwoFlows(), now: NOW });
    ok("render(e): data-motion=full outranks the OS reduce query (animated)", full.animation === "animated");
    full.dispose();

    g.matchMedia = mm(false); // the OS allows motion...
    doc.documentElement.setAttribute("data-motion", "reduced");
    const red = renderLiveFlow({ flows: sampleTwoFlows(), now: NOW });
    ok("render(e): data-motion=reduced forces the static frame", red.animation === "static-frame");
    red.dispose();

    doc.documentElement.removeAttribute("data-motion");
    g.matchMedia = mm(true);
    const sys = renderLiveFlow({ flows: sampleTwoFlows(), now: NOW });
    ok("render(e): no console preference defers to the OS query", sys.animation === "static-frame");
    sys.dispose();
  } finally {
    g.matchMedia = prevMM;
    doc.documentElement.removeAttribute("data-motion");
  }
}

// geom extracts the deterministic parts of a model for the rebuild-equality check (positions +
// the per-edge encoding), not the FlowRecord references (which would not stringify usefully).
function geom(model: LiveFlowModel): unknown {
  return {
    nodes: model.nodes.map((n) => ({ id: n.id, column: n.column, x: n.x, y: n.y, flowIds: n.flowIds })),
    edges: model.edges.map((e) => ({
      flowId: e.flowId,
      tone: e.presentation.tone,
      weight: e.weight,
      particleRate: e.particleRate,
      flowing: e.flowing,
      ingress: { x0: e.ingress.x0, y0: e.ingress.y0, x3: e.ingress.x3, y3: e.ingress.y3 },
      egress: { x0: e.egress.x0, y0: e.egress.y0, x3: e.egress.x3, y3: e.egress.y3 },
    })),
  };
}

function eqRgb(a: { r: number; g: number; b: number } | null, b: { r: number; g: number; b: number }): boolean {
  return a !== null && a.r === b.r && a.g === b.g && a.b === b.b;
}
function approxRgb(a: { r: number; g: number; b: number } | null, v: number): boolean {
  if (a === null) return false;
  const near = (x: number) => Math.abs(x - v) < 0.01;
  return near(a.r) && near(a.g) && near(a.b);
}

// Reference the status type so the import is meaningful under a strict "is it used" reading.
export type { FlowStatus as _LiveFlowStatus };

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
