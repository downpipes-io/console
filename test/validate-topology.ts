// Validate the topology map's DATA -> LAYOUT mapping, its status/throughput encoding
// (including the first-class unknown and disabled states), its empty/partial cases, and
// the SVG <-> accessible-table PARITY contract (every downpipe the SVG draws appears in
// the table, and the table carries the FULL set even when the SVG is capped). Run with
// `node test/validate-topology.ts`.
//
// This exercises the PURE model layer only (buildTopologyModel + the encoding helpers +
// buildTableRows). That layer touches neither the DOM nor a clock nor randomness, so it
// runs in bare Node and is deterministic: the same input yields the same geometry and the
// same parity every time. The DOM render layer (renderTopology) is a thin projection of
// this model and is not invoked here (there is no DOM in the test runner), exactly as the
// keygen validator exercises the crypto and not the UI.

import {
  buildTopologyModel,
  buildTableRows,
  presentStatus,
  throughputWeight,
  throughputText,
  tally,
  summaryPhrase,
  topologyTableColumns,
  markerBoundingBox,
  boxesIntersect,
  MARKER_BOX,
  type FlowRecord,
  type FlowStatus,
  type TopologyModel,
  type TopologyTableRow,
} from "../src/components/topology.ts";
import { LAYOUT } from "../src/components/topology-geometry.ts";
import {
  ICON_CHECK,
  ICON_RUNS,
  ICON_ALERT,
  ICON_PAUSE,
  ICON_QUESTION,
  ICON_INFO,
} from "../src/lib/icons.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// A fixed instant. The model takes `now` as an explicit option, so the freshness strings
// are a pure function of (data, now); we pass NOW into every build below rather than rely
// on the ambient clock, which is what makes this test deterministic across machines and
// across midnight. (The render path defaults `now` to Date.now; the model does not.)
const NOW = Date.parse("2026-06-07T12:00:00Z");

// Layout constants imported from the production geometry so these assertions track the real
// renderer rather than restating literals. PLATE_HEIGHT is the painted plate's vertical extent
// (labelTop above the anchor plus labelBottom below it). SOURCE_COL_RIGHT is the right edge of
// the source column (padX plus colWidth). If the production geometry changes, these follow.
const PLATE_HEIGHT = MARKER_BOX.labelTop + MARKER_BOX.labelBottom;
const SOURCE_COL_RIGHT = LAYOUT.padX + LAYOUT.colWidth;

function ts(deltaSec: number): string {
  return new Date(NOW + deltaSec * 1000).toISOString();
}

// A representative flow set covering every status, both column sides, multiple kinds,
// known and unknown throughput, an in-flight run, and a disabled downpipe.
function sampleFlows(): FlowRecord[] {
  return [
    {
      id: "dp-1",
      source: { name: "uploads-prod", kind: "kv", secondary: "1,204 keys" },
      destination: { name: "archive-bucket", kind: "r2", secondary: "2.1 GB" },
      status: "healthy",
      lastRunAt: ts(-3 * 3600),
      cadence: 86400,
      bytesPerRun: 2 * 1024 * 1024, // 2 MB -> medium
      enabled: true,
      running: false,
    },
    {
      id: "dp-2",
      source: { name: "sessions", kind: "kv" },
      destination: { name: "archive-bucket", kind: "r2" }, // shares the dest node with dp-1
      status: "stale",
      lastRunAt: ts(-50 * 3600),
      cadence: 3600,
      bytesPerRun: 512 * 1024, // 512 KB -> thin
      enabled: true,
      running: true, // in-flight + stale: flowing applies
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
      running: false,
    },
    {
      id: "dp-4",
      source: { name: "api-tokens", kind: "secrets" },
      destination: { name: "vault-mirror", kind: "r2" },
      status: "disabled",
      lastRunAt: ts(-200 * 3600),
      cadence: 86400,
      bytesPerRun: null, // unknown throughput -> thin, never inflated
      enabled: false,
      running: false,
    },
    {
      id: "dp-5",
      source: { name: "metrics", kind: "kv" },
      destination: { name: "cold-store", kind: "r2" },
      status: "unknown", // status could not be fetched (partial load)
      lastRunAt: null,
      enabled: true,
      running: false,
    },
  ];
}

function main(): void {
  const flows = sampleFlows();
  const model = buildTopologyModel({ flows, now: NOW });

  // ---- 1. DATA -> LAYOUT: nodes, columns, dedup, determinism --------------------------
  // Distinct endpoints: sources uploads-prod, sessions, ledger, api-tokens, metrics (5);
  // destinations archive-bucket (shared by dp-1+dp-2), offsite-s3, vault-mirror,
  // cold-store (4). archive-bucket must dedupe to ONE node.
  const sourceNodes = model.nodes.filter((n) => n.side === "source");
  const destNodes = model.nodes.filter((n) => n.side === "destination");
  ok("5 distinct source nodes", sourceNodes.length === 5);
  ok("4 distinct destination nodes (shared dest deduped)", destNodes.length === 4);
  ok("one edge per flow", model.edges.length === flows.length);

  // The shared destination carries both incident flow ids.
  const archive = destNodes.find((n) => n.name === "archive-bucket");
  ok("shared dest node exists", archive !== undefined);
  const archiveFlowIds = archive?.flowIds ?? [];
  ok(
    "shared dest node has both incident flows",
    archiveFlowIds.includes("dp-1") && archiveFlowIds.includes("dp-2") && archiveFlowIds.length === 2,
  );

  // Sources sit in the left column, destinations in the right; the two columns are
  // horizontally separated and deterministic.
  const allSourceX = new Set(sourceNodes.map((n) => n.x));
  const allDestX = new Set(destNodes.map((n) => n.x));
  ok("all sources share one column x", allSourceX.size === 1);
  ok("all destinations share one column x", allDestX.size === 1);
  ok("destination column is right of the source column", [...allDestX][0]! > [...allSourceX][0]!);

  // Nodes within a column do not overlap vertically and are ordered by first appearance.
  const sortedSourceY = sourceNodes.map((n) => n.y);
  const monotonic = sortedSourceY.every((y, i) => i === 0 || y > sortedSourceY[i - 1]!);
  ok("source nodes are vertically separated and ordered", monotonic);

  // Determinism: a second build of the SAME data yields identical geometry.
  const model2 = buildTopologyModel({ flows: sampleFlows(), now: NOW });
  ok("layout is deterministic (identical geometry on rebuild)", JSON.stringify(geom(model)) === JSON.stringify(geom(model2)));

  // The geometry/encoding does NOT depend on `now`: a far-later instant changes the
  // freshness wording but leaves every position, path, weight and tone identical (proving
  // `now` only feeds the presentation strings, not the layout).
  const modelLater = buildTopologyModel({ flows: sampleFlows(), now: NOW + 30 * 24 * 3600 * 1000 });
  ok("geometry is independent of now", JSON.stringify(geom(model)) === JSON.stringify(geom(modelLater)));
  const dp1Now = model.edges.find((e) => e.id === "dp-1")!;
  const dp1Later = modelLater.edges.find((e) => e.id === "dp-1")!;
  ok("freshness wording DOES move with now", dp1Now.freshnessLabel !== dp1Later.freshnessLabel);
  ok("status tone is unchanged by now", dp1Now.presentation.tone === dp1Later.presentation.tone);

  // The viewBox is positive and encloses the content.
  ok("viewBox has positive dimensions", model.width > 0 && model.height > 0);
  const maxNodeY = Math.max(...model.nodes.map((n) => n.y));
  ok("canvas height encloses the lowest node", model.height > maxNodeY);

  // Each edge's path is a non-empty cubic between its two nodes' x-anchors.
  const everyEdgeHasPath = model.edges.every((e) => e.path.startsWith("M") && e.path.includes("C"));
  ok("every edge has a curved (cubic) path", everyEdgeHasPath);

  // ---- 2. STATUS ENCODING: hue + glyph + label + dash, incl. unknown + disabled -------
  const statuses: FlowStatus[] = ["healthy", "stale", "partial", "no-copy", "failed", "disabled", "unknown"];
  const expectTone: Record<FlowStatus, string> = {
    healthy: "trust",
    stale: "warn",
    partial: "warn", // amber: redundancy degraded but the data is safe (>=1 copy), never danger
    // no-copy ranks worse than partial: a partial copy is behind, a no-copy destination has stayed
    // empty. Same warn tone as both of its neighbours, so the dash below is what has to separate them.
    "no-copy": "warn",
    failed: "danger",
    disabled: "neutral",
    unknown: "neutral",
  };
  const expectDash: Record<FlowStatus, string> = {
    healthy: "solid",
    stale: "solid",
    partial: "dashed", // dashed so a monochrome reader tells partial (dashed) from stale (solid, same warn tone)
    "no-copy": "dotted", // and dotted, so all three warn statuses stay distinguishable without colour
    failed: "dashed",
    disabled: "dotted",
    unknown: "dotted",
  };
  let encodingOk = true;
  let glyphsPresent = true;
  let labelsDistinctFromGreen = true;
  for (const s of statuses) {
    const p = presentStatus(s);
    if (p.tone !== expectTone[s]) encodingOk = false;
    if (p.dash !== expectDash[s]) encodingOk = false;
    if (!p.glyph || p.glyph.length === 0) glyphsPresent = false;
    if (!p.label || p.label.length === 0) labelsDistinctFromGreen = false;
  }
  ok("status -> tone + dash mapping is correct for all seven states", encodingOk);
  ok("every status carries a glyph (shape redundancy, never colour alone)", glyphsPresent);
  ok("every status carries a text label", labelsDistinctFromGreen);

  // The honesty rule: unknown and disabled are NEVER the trust/green tone.
  ok("unknown is not the trust tone (never a stale green)", presentStatus("unknown").tone !== "trust");
  ok("disabled is not the trust tone (never a stale green)", presentStatus("disabled").tone !== "trust");
  ok("only healthy carries the trust tone", presentStatus("healthy").tone === "trust");

  // Each is encoded uniquely enough to distinguish without colour: the (glyph, label, dash)
  // triple differs for failed/disabled/unknown so a monochrome reader still tells them
  // apart. healthy vs stale differ by glyph + label (both solid by design).
  const triple = (s: FlowStatus) => {
    const p = presentStatus(s);
    return `${p.glyph}|${p.label}|${p.dash}`;
  };
  const allTriples = statuses.map(triple);
  ok("each status has a distinct glyph+label+dash signature", new Set(allTriples).size === statuses.length);

  // The SPECIFIC glyph per status (spec section 3): not just unique, but the RIGHT shape.
  // disabled must be the PAUSE glyph and unknown the QUESTION glyph (not the info glyph, so
  // a monochrome user distinguishes them by shape, which the dotted dash alone cannot do
  // since disabled and unknown share it). healthy/stale/failed keep check/clock/alert.
  ok("healthy uses the check glyph", presentStatus("healthy").glyph === ICON_CHECK);
  ok("stale uses the clock glyph", presentStatus("stale").glyph === ICON_RUNS);
  ok("failed uses the alert glyph", presentStatus("failed").glyph === ICON_ALERT);
  ok("disabled uses the PAUSE glyph (not info)", presentStatus("disabled").glyph === ICON_PAUSE);
  ok("unknown uses the QUESTION glyph (not info)", presentStatus("unknown").glyph === ICON_QUESTION);
  // The regression guard for the exact defect: disabled and unknown must NOT both be the
  // info glyph (the previous bug), and must differ from each other by glyph (shape), so the
  // shape redundancy holds where the dash is shared.
  ok("disabled and unknown have DISTINCT glyphs (shape redundancy)", presentStatus("disabled").glyph !== presentStatus("unknown").glyph);
  ok("neither disabled nor unknown reuses the info glyph", presentStatus("disabled").glyph !== ICON_INFO && presentStatus("unknown").glyph !== ICON_INFO);

  // 3-2-1 PARTIAL (redundancy degraded but the data is safe): amber like stale, but a DISTINCT glyph +
  // a dashed stroke so a monochrome reader tells it from stale (same warn tone, solid) and from failed.
  ok("partial carries the warn (amber) tone, never danger", presentStatus("partial").tone === "warn");
  ok("partial reads the word 'partial'", presentStatus("partial").label === "partial");
  ok("partial is shape-distinct from stale (both warn): different glyph or dash", presentStatus("partial").glyph !== presentStatus("stale").glyph || presentStatus("partial").dash !== presentStatus("stale").dash);
  ok("partial is tone-distinct from failed (amber, not red)", presentStatus("partial").tone !== presentStatus("failed").tone);

  // The freshness LINE must match the tone: a partial flow that has run carries a last-run
  // time but is NOT fresh, so its freshness label must read "partial ...", never "fresh ..."
  // (the contradictory-label regression: an amber, dashed edge captioned "fresh").
  const partialRun = buildTopologyModel({
    flows: [{ ...flows[0]!, status: "partial" }], // flows[0] has a real lastRunAt
    now: NOW,
  });
  ok("a partial flow's freshness label starts with 'partial' (not 'fresh')", partialRun.edges[0]!.freshnessLabel.startsWith("partial"));

  // The destination-DOWN node indicator: a down destination ENDPOINT marks its laid-out node down (which
  // buildNode renders as the danger frame + "down" badge), and a source is never marked down.
  const downModel = buildTopologyModel({
    flows: [
      { id: "f-up", source: { name: "kv-a", kind: "kv" }, destination: { name: "bucket-1", kind: "r2" }, status: "healthy", enabled: true, running: false },
      { id: "f-down", source: { name: "kv-a", kind: "kv" }, destination: { name: "bucket-2", kind: "r2", down: true }, status: "failed", enabled: true, running: false },
    ],
    now: NOW,
  });
  ok("a down destination endpoint marks its node down", downModel.nodes.find((n) => n.side === "destination" && n.name === "bucket-2")?.down === true);
  ok("a reachable destination node is NOT marked down", downModel.nodes.find((n) => n.side === "destination" && n.name === "bucket-1")?.down !== true);
  ok("a source node is never marked down", downModel.nodes.find((n) => n.side === "source")?.down !== true);

  // The in-flight + status interaction: a disabled or failed flow is NOT shown flowing
  // even if running is set; a healthy/stale/unknown running flow IS.
  const failedRunning = buildTopologyModel({
    flows: [{ ...flows[2]!, running: true }],
    now: NOW,
  });
  ok("a failed run is not shown as flowing", failedRunning.edges[0]!.flowing === false);
  const staleRunningEdge = model.edges.find((e) => e.id === "dp-2");
  ok("a stale in-flight run is shown as flowing", staleRunningEdge !== undefined && staleRunningEdge.flowing === true);
  const disabledFlowEdge = model.edges.find((e) => e.id === "dp-4");
  ok("a disabled flow is never flowing", disabledFlowEdge !== undefined && disabledFlowEdge.flowing === false);

  // ---- 3. THROUGHPUT ENCODING: three bounded steps; number is the truth ---------------
  ok("thin step for sub-MB throughput", throughputWeight(512 * 1024) === 1);
  ok("medium step for >= 1 MB", throughputWeight(2 * 1024 * 1024) === 2);
  ok("thick step for >= 64 MB", throughputWeight(80 * 1024 * 1024) === 3);
  ok("unknown throughput is the thinnest step (never inflated)", throughputWeight(null) === 1);
  ok("zero throughput is the thinnest step", throughputWeight(0) === 1);
  ok("non-finite throughput is the thinnest step", throughputWeight(Number.NaN) === 1);
  // Weight is bounded to exactly {1,2,3}.
  const weights = model.edges.map((e) => e.weight);
  ok("every weight is one of three bounded steps", weights.every((w) => w === 1 || w === 2 || w === 3));
  // The numeric value is the truth: throughputText surfaces it; unknown is empty (so the
  // UI shows "-"), never a fabricated figure.
  ok("known throughput renders a human byte string", throughputText(2 * 1024 * 1024) === "2.0 MB");
  ok("unknown throughput renders no number (caller shows -)", throughputText(null) === "");

  // ---- 4. SUMMARY + TALLY (the SVG aria-label summary) --------------------------------
  const counts = tally(flows);
  ok("tally counts every category", counts.total === 5 && counts.healthy === 1 && counts.stale === 1 && counts.failed === 1 && counts.disabled === 1 && counts.unknown === 1);
  ok("model.counts uses the FULL set", model.counts.total === 5);
  const phrase = summaryPhrase(counts);
  ok("summary names the total downpipes", phrase.includes("5 downpipes"));
  ok("summary lists failed when present", phrase.includes("1 failed"));
  ok("summary never asserts 0 of a category", !phrase.includes("0 "));

  // ---- 5. EMPTY + PARTIAL cases -------------------------------------------------------
  const empty = buildTopologyModel({ flows: [], now: NOW });
  ok("empty: no nodes", empty.nodes.length === 0);
  ok("empty: no edges", empty.edges.length === 0);
  ok("empty: total is zero", empty.counts.total === 0);
  ok("empty: positive viewBox (not a broken/zero canvas)", empty.width > 0 && empty.height > 0);
  ok("empty: summary reads as no downpipes, not a green", summaryPhrase(empty.counts).toLowerCase().includes("no downpipes"));
  // The empty table projection is also empty (parity holds at zero).
  ok("empty: table rows are empty too", buildTableRows([]).length === 0);

  // Partial: a subset has status unknown; the rest render normally; none coerced to green.
  const partial = buildTopologyModel({
    flows: [
      { ...flows[0]! }, // healthy
      { ...flows[4]! }, // unknown
    ],
    now: NOW,
  });
  ok("partial: both flows produce edges", partial.edges.length === 2);
  const unknownEdge = partial.edges.find((e) => e.flow.status === "unknown");
  ok("partial: the unknown flow stays unknown (not green)", unknownEdge !== undefined && unknownEdge.presentation.tone !== "trust" && unknownEdge.presentation.label === "unknown");
  const healthyEdge = partial.edges.find((e) => e.flow.status === "healthy");
  ok("partial: the healthy flow still reads fresh", healthyEdge !== undefined && healthyEdge.presentation.tone === "trust");

  // A flow that has never run reads "no run yet" in its freshness, not a fabricated time.
  const neverRun = buildTopologyModel({
    flows: [{ ...flows[4]!, status: "healthy", lastRunAt: null }],
    now: NOW,
  });
  ok("never-run healthy flow does not fabricate a last-run time", neverRun.edges[0]!.freshnessTitle === "");

  // ---- 6. SVG <-> ACCESSIBLE-TABLE PARITY (the contract) ------------------------------
  // The table is projected from the FULL flow set; the SVG edges are the drawn set. Parity:
  // every flow the SVG draws MUST appear in the table, and the table carries every flow.
  const rows: readonly TopologyTableRow[] = buildTableRows(flows);
  const tableIds = new Set(rows.map((r) => r.flow.id));
  const svgEdgeIds = new Set(model.edges.map((e) => e.id));
  const flowIds = new Set(flows.map((f) => f.id));

  ok("table has one row per flow", rows.length === flows.length);
  ok("table carries EVERY flow id", flowIds.size === tableIds.size && [...flowIds].every((id) => tableIds.has(id)));
  ok("every SVG edge id appears in the table (parity)", [...svgEdgeIds].every((id) => tableIds.has(id)));
  ok("the table is a superset-or-equal of the SVG edges", svgEdgeIds.size <= tableIds.size);

  // Status parity: the row's presentation matches the edge's presentation for each id.
  let statusParity = true;
  for (const edge of model.edges) {
    const row = rows.find((r) => r.flow.id === edge.id);
    if (!row) {
      statusParity = false;
      continue;
    }
    if (row.presentation.tone !== edge.presentation.tone || row.presentation.label !== edge.presentation.label) statusParity = false;
  }
  ok("status encoding is identical in the SVG edge and its table row", statusParity);

  // ---- 7. CAPPED SVG still has FULL table (never silently truncate) --------------------
  const capped = buildTopologyModel({ flows, maxEdges: 2, now: NOW });
  ok("cap: only the first N edges are drawn in the SVG", capped.edges.length === 2);
  ok("cap: the cap is flagged", capped.capped === true);
  ok("cap: drawn vs total is reported honestly", capped.drawnEdgeCount === 2 && capped.totalEdgeCount === 5);
  ok("cap: model.counts still reflects the FULL set", capped.counts.total === 5);
  // The table projection (full set) still carries every flow despite the SVG cap: this is
  // the parity guarantee under truncation.
  const cappedRows = buildTableRows(flows);
  const cappedSvgIds = new Set(capped.edges.map((e) => e.id));
  ok("cap: table still carries every flow", cappedRows.length === 5);
  ok("cap: every drawn SVG edge is still in the table", [...cappedSvgIds].every((id) => cappedRows.some((r) => r.flow.id === id)));
  ok("cap: the table is a strict superset of the capped SVG", cappedSvgIds.size < cappedRows.length);
  // No cap when under the threshold.
  const uncapped = buildTopologyModel({ flows, maxEdges: 10, now: NOW });
  ok("no cap when under the threshold", uncapped.capped === false && uncapped.edges.length === 5);

  // ---- 8. ACCESSIBLE NAMES carry the full read (so the SVG button == the table row) ----
  const dp1 = model.edges.find((e) => e.id === "dp-1")!;
  ok("edge accessible name names the source", dp1.accessibleName.includes("uploads-prod"));
  ok("edge accessible name names the destination", dp1.accessibleName.includes("archive-bucket"));
  ok("edge accessible name carries the status", dp1.accessibleName.includes("fresh"));
  ok("edge accessible name carries the throughput number", dp1.accessibleName.includes("2.0 MB"));
  ok("edge accessible name carries the cadence", dp1.accessibleName.toLowerCase().includes("daily"));
  const dp2 = model.edges.find((e) => e.id === "dp-2")!;
  ok("a running edge's accessible name says running", dp2.accessibleName.includes("running now"));

  // ---- 9. UNKNOWN KIND degrades gracefully (no throw, neutral handling) ----------------
  const oddKind = buildTopologyModel({
    flows: [
      {
        id: "dp-odd",
        source: { name: "mystery", kind: "other" },
        destination: { name: "archive", kind: "r2" },
        status: "healthy",
        lastRunAt: ts(-3600),
        enabled: true,
        running: false,
      },
    ],
    now: NOW,
  });
  ok("an unrecognised kind still lays out one source + one dest", oddKind.nodes.filter((n) => n.side === "source").length === 1 && oddKind.nodes.filter((n) => n.side === "destination").length === 1);
  ok("an unrecognised kind still produces one edge with a parity table row", oddKind.edges.length === 1 && buildTableRows([oddKind.edges[0]!.flow]).length === 1);

  // ---- 10. THE TABLE IS THE OPERABLE SURFACE: a real open-button column per row ---------
  // The SVG is a pure visual (role="img"); the real, keyboard-operable controls that open a
  // downpipe drawer are the accessible TABLE's per-row buttons (spec section 5). The model
  // layer exposes this as a trailing "open" column, present ONLY when an open handler is
  // supplied (the read-only Overview embed passes none, so it has no open column). We
  // inspect the column descriptors (DOM-free); the render closures build the real <button>.
  const colsNoOpen = topologyTableColumns(NOW);
  ok("no open column when there is no open handler (read-only embed)", colsNoOpen.every((c) => c.key !== "open"));
  let opened: string | null = null;
  const colsWithOpen = topologyTableColumns(NOW, (id) => { opened = id; });
  const openCol = colsWithOpen.find((c) => c.key === "open");
  ok("an open column is present when an open handler is supplied", openCol !== undefined);
  ok("the open column is the trailing column", colsWithOpen[colsWithOpen.length - 1]!.key === "open");
  ok("the open column header is screen-reader only (icon button column)", openCol !== undefined && openCol.srOnlyHeader === true);
  // The base data columns are unchanged by adding the open column (parity of the read).
  ok("adding the open column does not drop the data columns", colsWithOpen.length === colsNoOpen.length + 1);
  void opened; // the wired handler id is asserted in the DOM layer, not the model test

  // ---- 11. N -> 1 DE-COLLISION GEOMETRY (the every-real-deployment case) ----------------
  // The engine has ONE account-wide archive destination, so every real map is N sources to
  // ONE destination. Previously every edge terminated at the SAME point (leftEdgeX, destY)
  // and every join glyph + label was stamped at the SAME X with compressed Ys, so the pipes
  // collapsed into one bundle and the labels' legibility plates painted over each other.
  // Build that exact case (5 sources, 1 shared destination) and assert the de-collision:
  // the destination anchor is FANNED (distinct termination points) and no two marker/label
  // bounding boxes intersect.
  const N1 = nToOne(5);
  const n1 = buildTopologyModel({ flows: N1, now: NOW });
  ok("N->1: 5 source nodes, 1 destination node", n1.nodes.filter((x) => x.side === "source").length === 5 && n1.nodes.filter((x) => x.side === "destination").length === 1);
  ok("N->1: one edge per flow", n1.edges.length === 5);

  // (1) The destination anchor is fanned: the edges no longer all terminate at one Y. Read
  // the termination Y out of each path's final coordinate; they must be DISTINCT (the fan),
  // not all equal to the single destination node's centre (the old collapse).
  const termYs = n1.edges.map((e) => pathEndY(e.path));
  ok("N->1: destination terminations are fanned to distinct points (no collapse)", new Set(termYs).size === n1.edges.length);
  const destCentre = n1.nodes.find((x) => x.side === "destination")!.y;
  ok("N->1: the fan stays on the destination node (within its box)", termYs.every((y) => Math.abs(y - destCentre) <= 26));

  // (2) The markers are de-collided in Y: in the N->1 case the join glyph + label rides the
  // source-side of each pipe, so the markers inherit the sources' vertical separation rather
  // than the old compressed midY band. Adjacent marker anchors must be at least one plate
  // height apart, which is precisely what keeps the labels legible. (They legitimately SHARE
  // an X here: each source has one edge, so the X stagger does not apply; the separation is
  // carried by Y, which is the axis that was collapsing.) The markers also sit clear of the
  // source column (their X is past the source node boxes), so they ride the pipe, not a node.
  const sortedMidY = n1.edges.map((e) => e.midY).sort((a, b) => a - b);
  const yWellSeparated = sortedMidY.every((y, i) => i === 0 || y - sortedMidY[i - 1]! >= PLATE_HEIGHT);
  ok("N->1: adjacent marker anchors are at least a plate height apart in Y", yWellSeparated);
  ok("N->1: markers ride the pipe (clear of the source column)", n1.edges.every((e) => e.midX > SOURCE_COL_RIGHT));

  // (3) THE CORE ASSERTION: no two edge-marker / label bounding boxes intersect. Computed
  // from the SAME geometry the renderer paints (markerBoundingBox), so this is the real
  // legibility contract, not a proxy. In the 5->1 case every marker stays full-labelled
  // (the fan + source-side bias separates them), so this covers every plate.
  ok("N->1: no two marker/label bounding boxes intersect (the de-collision contract)", noBoxOverlaps(n1));
  ok("N->1: every marker keeps its full label in the 5->1 case (fan is enough)", n1.edges.every((e) => e.labelled));

  // The same must hold as the fan grows: 10 sources to 1 destination still de-collides.
  const n1big = buildTopologyModel({ flows: nToOne(10), now: NOW });
  ok("N->1: a larger fan (10->1) still has no overlapping marker boxes", noBoxOverlaps(n1big));

  // (3b) The MIRROR case (1 source -> N destinations) must not regress: all edges share the
  // source Y, so a naive source-anchored marker would stack them. The adaptive marker rides
  // toward the (separated) destination side instead, so the boxes still do not overlap.
  const oneN = buildTopologyModel({ flows: oneToN(5), now: NOW });
  ok("1->N (mirror): one source, 5 destination nodes", oneN.nodes.filter((x) => x.side === "source").length === 1 && oneN.nodes.filter((x) => x.side === "destination").length === 5);
  ok("1->N (mirror): no two marker/label bounding boxes intersect", noBoxOverlaps(oneN));

  // (3c) NO REGRESSION on the general N->M case: the representative mixed sample (a shared
  // destination of degree 2 plus singletons) still has no overlapping labelled plates.
  ok("N->M general: the representative sample has no overlapping marker boxes", noBoxOverlaps(model));

  // (3d) A DENSE mutual mesh (every source to every destination) cannot fit every wide text
  // plate; the brief's graceful degradation is glyph-only markers there. The contract still
  // holds: no two FULL-LABEL plates overlap (glyph-only markers carry no wide plate), the
  // demoted edges' freshness still lives in the always-present table, and the demotion is
  // deterministic.
  const mesh = buildTopologyModel({ flows: meshFlows(3, 3), now: NOW });
  ok("dense mesh: no two FULL-LABEL plates overlap", noLabelledBoxOverlaps(mesh));
  ok("dense mesh: some markers degrade to glyph-only (brief's dense-convergence path)", mesh.edges.some((e) => !e.labelled));
  ok("dense mesh: every flow still appears in the accessible table (freshness preserved)", buildTableRows(mesh.edges.map((e) => e.flow)).length === mesh.edges.length);

  console.log(failures === 0 ? "\nTOPOLOGY MAP VECTORS PASS" : `\n${failures} FAILURE(S)`);
    if (failures > 0) process.exit(1);
}

// nToOne builds the every-real-deployment case: `count` distinct sources, all flowing to a
// single shared destination (the engine's one account-wide archive). Statuses cycle so the
// fan carries a realistic mix; the geometry is what is under test, so the exact statuses do
// not matter. Deterministic (no clock, no randomness).
function nToOne(count: number): FlowRecord[] {
  const statuses: FlowStatus[] = ["healthy", "stale", "failed", "disabled", "unknown"];
  const flows: FlowRecord[] = [];
  for (let i = 0; i < count; i++) {
    flows.push({
      id: `n1-${i}`,
      source: { name: `source-${i}`, kind: "kv" },
      destination: { name: "archive-bucket", kind: "r2" }, // the ONE shared destination
      status: statuses[i % statuses.length]!,
      lastRunAt: ts(-(i + 1) * 3600),
      cadence: 86400,
      bytesPerRun: (i + 1) * 256 * 1024,
      enabled: true,
      running: false,
    });
  }
  return flows;
}

// oneToN is the mirror: ONE source fanning out to `count` distinct destinations. A naive
// "anchor the marker to the source Y" would stack every marker (they share the source); the
// adaptive marker must ride toward the separated destination side instead.
function oneToN(count: number): FlowRecord[] {
  const flows: FlowRecord[] = [];
  for (let i = 0; i < count; i++) {
    flows.push({
      id: `o1-${i}`,
      source: { name: "hub", kind: "kv" }, // the ONE shared source
      destination: { name: `dest-${i}`, kind: "r2" },
      status: "healthy",
      lastRunAt: ts(-(i + 1) * 3600),
      cadence: 86400,
      bytesPerRun: (i + 1) * 256 * 1024,
      enabled: true,
      running: false,
    });
  }
  return flows;
}

// meshFlows builds a dense mutual mesh: every one of `s` sources to every one of `d`
// destinations (s*d edges, every node of high degree). No along-curve placement can fit
// that many wide text plates; this exercises the brief's glyph-only degradation.
function meshFlows(s: number, d: number): FlowRecord[] {
  const flows: FlowRecord[] = [];
  for (let i = 0; i < s; i++) {
    for (let j = 0; j < d; j++) {
      flows.push({
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
  return flows;
}

// pathEndY reads the final Y coordinate out of a cubic path string
// ("M x1 y1 C cx y1 cx y2 x2 y2"): the last number is y2, the termination Y. Pure parse.
function pathEndY(path: string): number {
  const nums = path.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length === 0) throw new Error(`unparseable path: ${path}`);
  return Number(nums[nums.length - 1]);
}

// noBoxOverlaps asserts that NO two edge-marker / label bounding boxes intersect, using the
// exact geometry the renderer paints (markerBoundingBox honours each edge's labelled flag).
// This is the de-collision contract for the converging case. The all-pairs check below is
// O(n^2) in the edge count; that is intentional and fine for the bounded test inputs used here
// (at most 10 edges in the large-fan case, 9 in the mesh case). If a future suite scaled this to
// hundreds of edges a sort-based sweep would be faster, but it is not needed at these sizes.
function noBoxOverlaps(model: TopologyModel): boolean {
  const boxes = model.edges.map((e) => markerBoundingBox(e.midX, e.midY, e.labelled));
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) {
      if (boxesIntersect(boxes[a]!, boxes[b]!)) return false;
    }
  }
  return true;
}

// noLabelledBoxOverlaps is the weaker contract for a dense mesh: no two FULL-LABEL text
// plates overlap (glyph-only markers carry no wide plate and are not collidable text).
function noLabelledBoxOverlaps(model: TopologyModel): boolean {
  const boxes = model.edges.filter((e) => e.labelled).map((e) => markerBoundingBox(e.midX, e.midY, true));
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) {
      if (boxesIntersect(boxes[a]!, boxes[b]!)) return false;
    }
  }
  return true;
}

// geom extracts just the geometry of a model for the determinism check (positions + paths,
// not the FlowRecord references, which would not stringify usefully).
function geom(model: TopologyModel): unknown {
  return {
    nodes: model.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })),
    // labelled is part of the deterministic geometry now (the de-collision decision), so the
    // determinism + now-independence checks cover it too.
    edges: model.edges.map((e) => ({ id: e.id, path: e.path, weight: e.weight, midX: e.midX, midY: e.midY, labelled: e.labelled })),
    groups: model.groups.map((g) => ({ kind: g.kind, side: g.side, labelY: g.labelY })),
    width: model.width,
    height: model.height,
  };
}

main();
