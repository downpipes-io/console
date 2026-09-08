// Coverage validator for the PURE MODEL LAYER src/components/topology-model.ts: the small
// data -> layout + encoding helpers that the existing suites (test/validate-topology.ts and
// the live-flow validators) leave on partial branch coverage. That layer touches no DOM, no
// clock (beyond an explicit `now`) and no randomness, so this runs in bare Node and is
// deterministic. It pins the arms the broader suites do not reach: the ambient-sheen rule,
// the default-now path, the explicit group-spec ordering, the later-flow down propagation,
// the freshness phrasing across every unit and a future time, the time parsing guards, the
// summary phrase's singular/empty-detail/zero-category arms, the partial tally arm, the
// 1->N marker bias, and the glyph-only marker box. No network, no real clock.
//
// House rules: Australian English, no em dashes, precise claims.

import {
  hasAmbientSheen,
  buildTopologyModel,
  presentStatus,
  throughputWeight,
  throughputText,
  tally,
  summaryPhrase,
  buildTableRows,
  markerBoundingBox,
  boxesIntersect,
  relativeFrom,
  toMsLocal,
  kindWord,
  LAYOUT,
  MARKER_BOX,
} from "../../src/components/topology-model.ts";
import type {
  FlowRecord,
  FlowStatus,
  NodeKind,
} from "../../src/components/topology-types.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// A fixed instant so the freshness strings are a pure function of (data, now); we pass NOW
// into the builds that pin wording. The default-now build below deliberately omits it.
const NOW = Date.parse("2026-06-07T12:00:00Z");
function ts(deltaSec: number): string {
  return new Date(NOW + deltaSec * 1000).toISOString();
}

// A minimal enabled, healthy flow with a sensible default endpoint pair. Tests override only
// the fields under inspection so each arm is reached with the least incidental data.
// These fixtures build by spreading overrides over defaults, so passing `undefined` for a key is how a
// case REMOVES a default rather than a redundant way of omitting it. Partial<T> cannot express that under
// exactOptionalPropertyTypes, which reads an optional property as "absent or a value" and refuses an
// explicit undefined. Overrides<T> permits it on the keys that are ALREADY optional and only those:
// across the board it would also let a case blank a REQUIRED field and build an invalid fixture. strip
// drops the blanked keys on the way out, so what comes back is a genuine value rather than one carrying
// an explicit undefined on an optional key.
type Overrides<T> = { [K in keyof T]?: undefined extends T[K] ? T[K] | undefined : T[K] };
function strip<T extends object>(o: { [K in keyof T]?: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function flow(over: Overrides<FlowRecord>): FlowRecord {
  return strip({
    id: "f",
    source: { name: "src", kind: "kv" },
    destination: { name: "dst", kind: "r2" },
    status: "healthy",
    lastRunAt: ts(-3600),
    cadence: 86400,
    bytesPerRun: 1024 * 1024,
    enabled: true,
    running: false,
    ...over,
  });
}

function main(): void {
  ambientSheenTests();
  defaultNowTests();
  groupSpecTests();
  laterFlowDownTests();
  partialTallyTests();
  summaryPhraseTests();
  freshnessAndTimeTests();
  markerParamMirrorTests();
  markerBoxGlyphOnlyTests();
  miscEncodingTests();
  builderBranchTests();

  console.log(failures === 0 ? "\nTOPOLOGY-MODEL COVERAGE PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) process.exit(1);
}

// (1) hasAmbientSheen is the shared IDLE-motion rule (the SVG drift here, the canvas sheen in
// live-flow.ts read the same function). It is the whole function the broader suites reach
// only through the renderer. A FLOWING edge (running + a watched status) takes the bright
// in-flight stream INSTEAD, so it carries no ambient sheen; an enabled, idle, watched edge
// DOES; a disabled or failed edge stays inert either way.
function ambientSheenTests(): void {
  // running + watched -> the in-flight stream owns it, NO ambient sheen (the first guard's true arm).
  ok("sheen: a running healthy edge takes the in-flight stream, not the sheen", hasAmbientSheen(flow({ running: true, status: "healthy" })) === false);
  ok("sheen: a running stale edge is in-flight, not sheened", hasAmbientSheen(flow({ running: true, status: "stale" })) === false);
  ok("sheen: a running partial edge is in-flight, not sheened", hasAmbientSheen(flow({ running: true, status: "partial" })) === false);
  ok("sheen: a running unknown edge is in-flight, not sheened", hasAmbientSheen(flow({ running: true, status: "unknown" })) === false);

  // enabled + idle + watched -> the ambient sheen rides its own hue (the second clause's true arm).
  ok("sheen: an idle enabled healthy edge carries the ambient sheen (alive between runs)", hasAmbientSheen(flow({ running: false, status: "healthy" })) === true);
  ok("sheen: an idle enabled stale edge carries the sheen", hasAmbientSheen(flow({ running: false, status: "stale" })) === true);
  ok("sheen: an idle enabled partial edge carries the sheen", hasAmbientSheen(flow({ running: false, status: "partial" })) === true);
  ok("sheen: a young account's first idle unknown edge reads alive (sheen), not dead", hasAmbientSheen(flow({ running: false, status: "unknown" })) === true);

  // failed / disabled -> inert: the red and the stillness ARE the statement (the second clause's false arm).
  ok("sheen: a failed edge stays inert (no sheen)", hasAmbientSheen(flow({ status: "failed" })) === false);
  ok("sheen: a disabled edge stays inert (no sheen)", hasAmbientSheen(flow({ status: "disabled", enabled: false })) === false);
  // disabled but somehow running: still inert (running + disabled is not a watched status).
  ok("sheen: a disabled edge marked running is still inert", hasAmbientSheen(flow({ status: "disabled", running: true })) === false);
  // enabled === false with a watched status: the enabled clause gates it off.
  ok("sheen: an enabled=false healthy edge carries no sheen (gated by enabled)", hasAmbientSheen(flow({ enabled: false, status: "healthy" })) === false);
}

// (2) buildTopologyModel with NO `now`: the freshness clock falls back to Date.now (the `??`
// right arm). We cannot assert the exact wording (it depends on the wall clock), but the
// model must still build a consistent shape, which proves the default path runs without a
// passed instant.
function defaultNowTests(): void {
  const model = buildTopologyModel({ flows: [flow({})] }); // no `now`: exercises `opts.now ?? Date.now()`
  ok("default-now: a model builds without an explicit now", model.edges.length === 1 && model.counts.total === 1);
  ok("default-now: the single edge still carries a freshness label", typeof model.edges[0]!.freshnessLabel === "string" && model.edges[0]!.freshnessLabel.length > 0);
}

// (3) groupNodes with an EXPLICIT group spec (sourceGroups / destinationGroups): the spec
// fixes order and labels, drops a deliberately empty group, and any kind present in the data
// but absent from the spec follows in first-seen order (never dropped). This is the whole
// `if (spec?.length)` block the broader suites do not pass a spec to.
function groupSpecTests(): void {
  const flows: FlowRecord[] = [
    // d1 source first in the data, but the spec lists kv first, so kv must come first.
    flow({ id: "g1", source: { name: "ledger", kind: "d1" }, destination: { name: "b1", kind: "r2" } }),
    flow({ id: "g2", source: { name: "uploads", kind: "kv" }, destination: { name: "b2", kind: "s3" } }),
    // a "secrets" source present in the data but ABSENT from the spec: must still appear, last.
    flow({ id: "g3", source: { name: "tokens", kind: "secrets" }, destination: { name: "b3", kind: "r2" } }),
  ];
  const model = buildTopologyModel({
    flows,
    now: NOW,
    sourceGroups: [
      { kind: "kv", label: "Key-value" }, // listed before d1 though d1 appears first in data
      { kind: "d1", label: "Databases" },
      { kind: "other", label: "Empty on purpose" }, // no data of this kind: the group is dropped
    ],
  });
  const sourceGroups = model.groups.filter((g) => g.side === "source");
  ok("group-spec: the kv group is ordered first per the spec (not data order)", sourceGroups[0]!.kind === "kv");
  ok("group-spec: the kv group uses the spec label", sourceGroups[0]!.label === "Key-value");
  ok("group-spec: the d1 group follows in spec order with its spec label", sourceGroups[1]!.kind === "d1" && sourceGroups[1]!.label === "Databases");
  ok("group-spec: an empty spec group is dropped (no nodes, no band)", !sourceGroups.some((g) => g.kind === "other"));
  // The unspecified kind (secrets) is appended after the spec groups in first-seen order with
  // its derived default label, never dropped.
  const secretsGroup = sourceGroups.find((g) => g.kind === "secrets");
  ok("group-spec: a data kind absent from the spec is still grouped (never dropped)", secretsGroup !== undefined);
  ok("group-spec: the unspecified kind follows the spec groups", sourceGroups.indexOf(secretsGroup!) > sourceGroups.indexOf(sourceGroups[1]!));
  ok("group-spec: the unspecified kind uses the derived default label", secretsGroup!.label === "Secrets Store");
}

// (4) collectNodes: a destination shared by several flows reads DOWN the moment ANY one of
// them reports its endpoint down, even when the FIRST occurrence was reachable. This is the
// `else if (ep.down) existing.down = true` arm: the node already exists (first flow) and a
// LATER flow flips it down, so the badge never under-reports an outage.
function laterFlowDownTests(): void {
  const flows: FlowRecord[] = [
    // first occurrence of "shared-dest": reachable.
    flow({ id: "d1", source: { name: "s1", kind: "kv" }, destination: { name: "shared-dest", kind: "r2" } }),
    // second occurrence of the SAME dest, this time down: must flip the existing node down.
    flow({ id: "d2", source: { name: "s2", kind: "kv" }, destination: { name: "shared-dest", kind: "r2", down: true }, status: "failed" }),
  ];
  const model = buildTopologyModel({ flows, now: NOW });
  const dest = model.nodes.find((n) => n.side === "destination" && n.name === "shared-dest");
  ok("later-down: a shared dest deduped to one node", model.nodes.filter((n) => n.side === "destination" && n.name === "shared-dest").length === 1);
  ok("later-down: a later flow's down endpoint flips the already-seen node down", dest?.down === true);
}

// (5) tally with a PARTIAL status: the `else if (f.status === "partial")` arm the
// representative sample (which carries no partial flow) never reaches.
function partialTallyTests(): void {
  const counts = tally([
    flow({ id: "p1", status: "partial" }),
    flow({ id: "p2", status: "partial" }),
    flow({ id: "p3", status: "healthy" }),
  ]);
  ok("tally: the partial arm counts partial flows", counts.partial === 2);
  ok("tally: the total still spans every flow", counts.total === 3 && counts.healthy === 1);

  // The model's counts also surface partial (it tallies the FULL flow set).
  const model = buildTopologyModel({ flows: [flow({ id: "p4", status: "partial" })], now: NOW });
  ok("tally: the model summary carries the partial count", model.counts.partial === 1);
  // The partial edge encodes the warn tone with a distinct (info) glyph + dashed stroke.
  ok("tally: a partial edge encodes warn + dashed (not danger)", model.edges[0]!.presentation.tone === "warn" && model.edges[0]!.presentation.dash === "dashed");
}

// (6) summaryPhrase edge arms: the SINGULAR noun (total === 1), the EMPTY-detail clause (a
// single category equal to the total leaves no "beyond the total" parts), and each of the
// per-category falsy arms (a count of 0 is never listed). The broader suite only pins the
// multi-category, plural phrasing.
function summaryPhraseTests(): void {
  // One healthy downpipe: SINGULAR noun, and only the healthy category is listed, so the
  // falsy arms of stale/partial/failed/disabled/unknown all run (none is listed) and no zero
  // is ever asserted.
  const one = tally([flow({ id: "s1", status: "healthy" })]);
  const onePhrase = summaryPhrase(one);
  ok("summary: a single downpipe uses the singular noun", onePhrase.includes("1 downpipe") && !onePhrase.includes("1 downpipes"));
  ok("summary: a single healthy total never asserts a zero category", !onePhrase.includes("0 "));
  ok("summary: a single healthy total lists exactly the one fresh category", onePhrase.includes("1 fresh") && !onePhrase.includes("stale") && !onePhrase.includes("failed"));

  // A non-empty total with NO listed category leaves an EMPTY detail clause (the parts.length
  // false arm): tally always lands a flow in a category, so we build the counts directly to
  // pin the function's defensive empty-detail path (a noun, a full stop, no colon list).
  const totalOnly = summaryPhrase({ total: 4, healthy: 0, stale: 0, partial: 0, noCopy: 0, failed: 0, disabled: 0, unknown: 0 });
  ok("summary: a positive total with no listed category lists no detail clause", !totalOnly.includes(":") && totalOnly.includes("4 downpipes"));

  // The no-copy clause, added beside partial, which nothing here exercised previously. It matters
  // that it reads differently from partial: a partial copy is behind, a no-copy destination has stayed
  // empty, and the phrase is what an operator scanning the map summary sees first.
  const withNoCopy = summaryPhrase({ total: 3, healthy: 1, stale: 0, partial: 1, noCopy: 1, failed: 0, disabled: 0, unknown: 0 });
  ok("summary: a no-copy flow is named as such", withNoCopy.includes("1 with no copy"));
  ok("summary: no-copy reads differently from partial, which is beside it", withNoCopy.includes("1 partial") && withNoCopy.includes("1 with no copy"));

  // A single disabled downpipe: the disabled arm IS listed (it is below the total), but the
  // plural noun still applies only above one; here total === 1 so still singular, and the
  // healthy falsy arm runs.
  const disabledOnly = tally([flow({ id: "s2", status: "disabled", enabled: false })]);
  const disabledPhrase = summaryPhrase(disabledOnly);
  ok("summary: a disabled-only map lists the disabled category", disabledPhrase.includes("1 disabled"));

  // Every category present at least once: every truthy arm runs, plural noun, full detail.
  const all = tally([
    flow({ id: "a1", status: "healthy" }),
    flow({ id: "a2", status: "stale" }),
    flow({ id: "a3", status: "partial" }),
    flow({ id: "a4", status: "failed" }),
    flow({ id: "a5", status: "disabled", enabled: false }),
    flow({ id: "a6", status: "unknown" }),
  ]);
  const allPhrase = summaryPhrase(all);
  ok("summary: a full map names the plural total", allPhrase.includes("6 downpipes"));
  ok("summary: the partial category is listed when present", allPhrase.includes("1 partial"));
  ok("summary: the unknown category is listed when present", allPhrase.includes("1 unknown"));
  ok("summary: the stale category is listed when present", allPhrase.includes("1 stale"));

  // The empty map reads explicitly (the total === 0 early return).
  ok("summary: an empty map reads as none configured yet", summaryPhrase(tally([])).toLowerCase().includes("no downpipes"));
}

// (7) freshnessPhrase / relativeFrom / unitPhrase / toMsLocal across every arm. The model's
// freshness wording covers the recent units through the renderer; this pins a FUTURE time
// ("in ..."), "just now", the higher unit ladder (weeks / months / years) and the time
// parsing guards (a number input, a non-finite number, an unparseable string).
function freshnessAndTimeTests(): void {
  // relativeFrom: the future arm ("in N..."), the "just now" arm (|delta| < 5s), the past arm.
  ok("relative: a near-now instant reads 'just now'", relativeFrom(NOW + 2000, NOW) === "just now");
  ok("relative: a future instant reads 'in ...'", relativeFrom(NOW + 3600 * 1000, NOW).startsWith("in "));
  ok("relative: a past instant reads '... ago'", relativeFrom(NOW - 3600 * 1000, NOW).endsWith("ago"));
  // An unparseable input reads the dash sentinel (the ms === null guard).
  ok("relative: an unparseable input reads the dash sentinel", relativeFrom("not a date", NOW) === "-");
  ok("relative: a null input reads the dash sentinel", relativeFrom(null, NOW) === "-");

  // unitPhrase ladder, driven through relativeFrom's past arm at chosen offsets.
  ok("units: seconds under a minute", relativeFrom(NOW - 30 * 1000, NOW) === "30s ago");
  ok("units: minutes under an hour", relativeFrom(NOW - 30 * 60 * 1000, NOW) === "30m ago");
  ok("units: hours under two days", relativeFrom(NOW - 30 * 3600 * 1000, NOW) === "30h ago");
  ok("units: days under a fortnight", relativeFrom(NOW - 5 * 24 * 3600 * 1000, NOW) === "5d ago");
  ok("units: weeks under nine", relativeFrom(NOW - 35 * 24 * 3600 * 1000, NOW).endsWith("w ago"));
  ok("units: months under eighteen", relativeFrom(NOW - 120 * 24 * 3600 * 1000, NOW).endsWith("mo ago"));
  ok("units: years past the month ceiling", relativeFrom(NOW - 800 * 24 * 3600 * 1000, NOW).endsWith("y ago"));

  // toMsLocal directly: a number passes through (finite) or is rejected (NaN); a string is
  // parsed; the empty/null inputs read null.
  ok("toMs: a finite number passes through unchanged", toMsLocal(1234) === 1234);
  ok("toMs: a non-finite number is rejected (null)", toMsLocal(Number.NaN) === null);
  ok("toMs: a valid ISO string parses to epoch ms", toMsLocal("2026-06-07T12:00:00Z") === NOW);
  ok("toMs: an unparseable string is rejected (null)", toMsLocal("nope") === null);
  ok("toMs: an empty string is null", toMsLocal("") === null);
  ok("toMs: null is null", toMsLocal(null) === null);
  ok("toMs: undefined is null", toMsLocal(undefined) === null);

  // freshnessPhrase via the model: disabled/unknown/never-run read honestly; failed/stale/
  // fresh carry the relative clause.
  const disabled = buildTopologyModel({ flows: [flow({ id: "fp1", status: "disabled", enabled: false })], now: NOW });
  ok("freshness: a disabled flow reads 'disabled'", disabled.edges[0]!.freshnessLabel === "disabled");
  const unknown = buildTopologyModel({ flows: [flow({ id: "fp2", status: "unknown" })], now: NOW });
  ok("freshness: an unknown flow reads 'status unknown'", unknown.edges[0]!.freshnessLabel === "status unknown");
  const neverRun = buildTopologyModel({ flows: [flow({ id: "fp3", status: "healthy", lastRunAt: null })], now: NOW });
  ok("freshness: a never-run flow reads 'no run yet'", neverRun.edges[0]!.freshnessLabel === "no run yet");
  const failed = buildTopologyModel({ flows: [flow({ id: "fp4", status: "failed", lastRunAt: ts(-3600) })], now: NOW });
  ok("freshness: a failed flow carries a 'failed ...' clause", failed.edges[0]!.freshnessLabel.startsWith("failed "));
  const stale = buildTopologyModel({ flows: [flow({ id: "fp5", status: "stale", lastRunAt: ts(-50 * 3600) })], now: NOW });
  ok("freshness: a stale flow carries a 'stale, last run ...' clause", stale.edges[0]!.freshnessLabel.startsWith("stale, last run "));
  const fresh = buildTopologyModel({ flows: [flow({ id: "fp6", status: "healthy", lastRunAt: ts(-3600) })], now: NOW });
  ok("freshness: a healthy flow carries a 'fresh, last run ...' clause", fresh.edges[0]!.freshnessLabel.startsWith("fresh, last run "));
  // An empty-string lastRunAt is also a never-run read (the lastRunAt === "" guard).
  const emptyTime = buildTopologyModel({ flows: [flow({ id: "fp7", status: "healthy", lastRunAt: "" })], now: NOW });
  ok("freshness: an empty last-run time reads 'no run yet'", emptyTime.edges[0]!.freshnessLabel === "no run yet");
  ok("freshness: an empty last-run time leaves no absolute title", emptyTime.edges[0]!.freshnessTitle === "");
}

// (8) markerParam through the 1->N MIRROR: one source fanning to several destinations where
// a destination is ALSO shared, so for some edge srcCount > dstCount AND dstCount > 1. That
// reaches the destination-side SPREAD return (the last arm of markerParam) which the broader
// suite's clean 1->N (every dest a singleton, dstCount === 1) does not. The contract under
// test is still the de-collision one: no two marker plates overlap.
function markerParamMirrorTests(): void {
  // hub -> dest-A (x2) + dest-B: hub srcCount = 3; dest-A dstCount = 2, dest-B dstCount = 1.
  // For the hub->dest-A edges, srcCount(3) > dstCount(2) and dstCount(2) > 1: the dst-side
  // spread arm. For hub->dest-B, srcCount(3) > dstCount(1): the dstCount <= 1 arm.
  const flows: FlowRecord[] = [
    flow({ id: "mp1", source: { name: "hub", kind: "kv" }, destination: { name: "dest-A", kind: "r2" } }),
    flow({ id: "mp2", source: { name: "hub", kind: "kv" }, destination: { name: "dest-A", kind: "r2" } }),
    flow({ id: "mp3", source: { name: "hub", kind: "kv" }, destination: { name: "dest-B", kind: "s3" } }),
  ];
  const model = buildTopologyModel({ flows, now: NOW });
  ok("mirror: one source, two distinct destination nodes", model.nodes.filter((n) => n.side === "source").length === 1 && model.nodes.filter((n) => n.side === "destination").length === 2);
  // The two edges sharing dest-A must not land their markers at the same X (the dst-side
  // spread nudges them apart along the curve).
  const aEdges = model.edges.filter((e) => e.destinationNodeId.includes("dest-A"));
  ok("mirror: the two shared-destination edges exist", aEdges.length === 2);
  ok("mirror: the dst-side spread separates markers sharing a destination in X", aEdges[0]!.midX !== aEdges[1]!.midX);
  // No two FULL-LABEL plates overlap (the de-collision contract still holds in the mirror).
  const labelledBoxes = model.edges.filter((e) => e.labelled).map((e) => markerBoundingBox(e.midX, e.midY, true));
  let overlap = false;
  for (let a = 0; a < labelledBoxes.length; a++) {
    for (let b = a + 1; b < labelledBoxes.length; b++) {
      if (boxesIntersect(labelledBoxes[a]!, labelledBoxes[b]!)) overlap = true;
    }
  }
  ok("mirror: no two full-label plates overlap in the shared-destination mirror", !overlap);

  // The SOURCE-side marker spread arm: an edge where the source is at least as convergent as
  // the destination AND the source is shared (srcCount > 1, srcCount <= dstCount). The clean
  // N->1 fan keeps srcCount === 1, so it never reaches this arm. A pair of edges from ONE
  // source to ONE destination has srcCount === dstCount === 2, so each rides the source-side
  // spread (markerTNear plus a per-shared-source nudge). The nudge must separate them in X.
  const parallel: FlowRecord[] = [
    flow({ id: "pp1", source: { name: "shared-src", kind: "kv" }, destination: { name: "shared-dest", kind: "r2" } }),
    flow({ id: "pp2", source: { name: "shared-src", kind: "kv" }, destination: { name: "shared-dest", kind: "r2" } }),
  ];
  const parallelModel = buildTopologyModel({ flows: parallel, now: NOW });
  ok("source-spread: one source and one destination carry both parallel edges", parallelModel.nodes.length === 2 && parallelModel.edges.length === 2);
  ok("source-spread: the source-side spread separates the two parallel markers in X", parallelModel.edges[0]!.midX !== parallelModel.edges[1]!.midX);
}

// (9) markerBoundingBox for a GLYPH-ONLY marker (labelled === false): the small symmetric
// glyph box (a ~20px square around the anchor), distinct from the wide text plate. The
// broader suite computes plate boxes (labelled true) and filters glyph-only edges out before
// measuring, so the !labelled arm is reached only here, directly.
function markerBoxGlyphOnlyTests(): void {
  const glyph = markerBoundingBox(100, 200, false);
  ok("glyph-box: a glyph-only box is the small symmetric square around the anchor", glyph.x0 === 100 - MARKER_BOX.glyphHalf && glyph.x1 === 100 + MARKER_BOX.glyphHalf && glyph.y0 === 200 - MARKER_BOX.glyphHalf && glyph.y1 === 200 + MARKER_BOX.glyphHalf);

  const plate = markerBoundingBox(100, 200, true);
  ok("glyph-box: a full plate is wider than the glyph box (the de-collision distinction)", (plate.x1 - plate.x0) > (glyph.x1 - glyph.x0));
  ok("glyph-box: the full plate spans the bounded label half-widths about the anchor", plate.x0 === 100 - MARKER_BOX.labelHalfW && plate.x1 === 100 + MARKER_BOX.labelHalfW);

  // boxesIntersect treats touching edges as non-overlapping: two glyph boxes that only abut
  // do not intersect; two that share area do.
  const a = markerBoundingBox(0, 0, false);
  const abutting = markerBoundingBox(2 * MARKER_BOX.glyphHalf, 0, false); // x0 == a.x1: touching
  ok("glyph-box: abutting glyph boxes do not count as overlapping", boxesIntersect(a, abutting) === false);
  const overlapping = markerBoundingBox(MARKER_BOX.glyphHalf, 0, false); // shares half the span
  ok("glyph-box: overlapping glyph boxes do intersect", boxesIntersect(a, overlapping) === true);
}

// (10) A few small encoders the model exposes directly, so the assertions read meaningfully
// rather than only riding the renderer: kindWord (every kind plus the catch-all), the
// throughput weight ladder and its truthful numeric text, and the buildTableRows projection.
function miscEncodingTests(): void {
  const kinds: NodeKind[] = ["kv", "r2", "d1", "secrets", "s3", "other"];
  const words = kinds.map(kindWord);
  ok("kindWord: every kind maps to a non-empty word", words.every((w) => typeof w === "string" && w.length > 0));
  ok("kindWord: r2 reads 'R2'", kindWord("r2") === "R2");
  ok("kindWord: the catch-all 'other' reads 'source' (token-authenticated sources are not stores)", kindWord("other") === "source");
  ok("kindWord: every kind word is distinct", new Set(words).size === words.length);

  // throughputWeight ladder and the truthful number.
  ok("throughput: sub-MB is the thinnest step", throughputWeight(512 * 1024) === 1);
  ok("throughput: >= 1 MB is medium", throughputWeight(2 * 1024 * 1024) === 2);
  ok("throughput: >= 64 MB is thick", throughputWeight(80 * 1024 * 1024) === 3);
  ok("throughput: unknown is the thinnest step (never inflated)", throughputWeight(null) === 1 && throughputWeight(undefined) === 1);
  ok("throughput: zero and non-finite are the thinnest step", throughputWeight(0) === 1 && throughputWeight(Number.NaN) === 1);
  ok("throughput: a negative figure is the thinnest step", throughputWeight(-5) === 1);
  ok("throughput: a known figure renders a human byte string", throughputText(2 * 1024 * 1024) === "2.0 MB");
  ok("throughput: unknown renders no number (caller shows the dash)", throughputText(null) === "" && throughputText(undefined) === "" && throughputText(Number.NaN) === "");

  // presentStatus covers all six arms (the encoding source of truth).
  const statuses: FlowStatus[] = ["healthy", "stale", "partial", "failed", "disabled", "unknown"];
  ok("present: every status yields a glyph + label + tone + dash", statuses.every((s) => {
    const p = presentStatus(s);
    return p.glyph.length > 0 && p.label.length > 0 && p.tone.length > 0 && p.dash.length > 0;
  }));

  // buildTableRows projects EVERY flow (the parity floor); each row carries its presentation.
  const rows = buildTableRows([flow({ id: "t1", status: "healthy" }), flow({ id: "t2", status: "failed" })]);
  ok("table-rows: one row per flow with its status presentation", rows.length === 2 && rows[1]!.presentation.label === "failed");
  ok("table-rows: an empty flow set projects no rows", buildTableRows([]).length === 0);

  // The exported LAYOUT constants are read (single source of truth for the geometry numbers).
  ok("layout: the layout grid exposes a positive node box", LAYOUT.nodeH > 0 && LAYOUT.colWidth > 0);
}

// (11) Builder branches the encoders above do not reach on their own: a RUNNING flow (the
// flowing ternary's full right-hand evaluation), a FIRST-occurrence node carrying both a
// secondary and a down flag (the collect + place spreads), the default kind labels for the
// secrets and s3 kinds (no group spec, so the derived-label path), and the edge cap with the
// drawn subset both below and at the threshold.
function builderBranchTests(): void {
  // A running, watched flow through the builder: flow.running is true so the `&&` evaluates
  // its status clause and the edge is marked flowing.
  const running = buildTopologyModel({ flows: [flow({ id: "b1", status: "stale", running: true })], now: NOW });
  ok("builder: a running watched flow is marked flowing", running.edges[0]!.flowing === true);
  // A running but failed flow: the status clause is false, so it is NOT flowing.
  const runningFailed = buildTopologyModel({ flows: [flow({ id: "b2", status: "failed", running: true })], now: NOW });
  ok("builder: a running failed flow is not flowing (status clause false)", runningFailed.edges[0]!.flowing === false);

  // A FIRST-occurrence node carrying a secondary AND down: the collectNodes secondary + down
  // spreads and the placeColumn secondary spread all run on the first sighting (not the later
  // `else if` path the shared-dest test drives).
  const decorated = buildTopologyModel({
    flows: [flow({ id: "b3", source: { name: "s", kind: "kv", secondary: "1,024 keys" }, destination: { name: "d", kind: "r2", secondary: "2.1 GB", down: true }, status: "failed" })],
    now: NOW,
  });
  const srcNode = decorated.nodes.find((n) => n.side === "source");
  const dstNode = decorated.nodes.find((n) => n.side === "destination");
  ok("builder: a first-occurrence node keeps its secondary line", srcNode?.secondary === "1,024 keys");
  ok("builder: a first-occurrence down destination is marked down on sight", dstNode?.down === true && dstNode?.secondary === "2.1 GB");

  // The default kind labels for secrets and s3 (no group spec, so groupNodes derives them via
  // defaultKindLabel: the secrets and s3 switch arms).
  const labels = buildTopologyModel({
    flows: [
      flow({ id: "b4", source: { name: "tokens", kind: "secrets" }, destination: { name: "off", kind: "s3" } }),
    ],
    now: NOW,
  });
  const srcGroup = labels.groups.find((g) => g.side === "source" && g.kind === "secrets");
  const dstGroup = labels.groups.find((g) => g.side === "destination" && g.kind === "s3");
  ok("builder: the secrets kind derives the 'Secrets Store' label", srcGroup?.label === "Secrets Store");
  ok("builder: the s3 kind derives the 'S3 targets' label", dstGroup?.label === "S3 targets");
  // The remaining default labels too (kv, d1) so every defaultKindLabel arm is reached.
  const moreLabels = buildTopologyModel({
    flows: [flow({ id: "b5", source: { name: "db", kind: "d1" }, destination: { name: "kvd", kind: "kv" } })],
    now: NOW,
  });
  ok("builder: the d1 kind derives the 'D1 databases' label", moreLabels.groups.find((g) => g.kind === "d1")?.label === "D1 databases");
  ok("builder: the kv kind derives the 'KV namespaces' label", moreLabels.groups.find((g) => g.kind === "kv" && g.side === "destination")?.label === "KV namespaces");
  // An "other" kind through the default path (the other arm of defaultKindLabel).
  const otherLabel = buildTopologyModel({
    flows: [flow({ id: "b6", source: { name: "misc", kind: "other" }, destination: { name: "r2d", kind: "r2" } })],
    now: NOW,
  });
  ok("builder: the other kind derives the 'Other' label", otherLabel.groups.find((g) => g.kind === "other")?.label === "Other");
  ok("builder: the r2 kind derives the 'R2 buckets' label", otherLabel.groups.find((g) => g.kind === "r2")?.label === "R2 buckets");

  // The edge cap: with maxEdges below the count the SVG draws the first N (cap !== undefined +
  // length > cap, both true); with maxEdges at or above the count nothing is dropped (the
  // length > cap false arm); with no maxEdges the cap clause short-circuits (cap === undefined).
  const many = [flow({ id: "c1" }), flow({ id: "c2", source: { name: "s2", kind: "kv" } }), flow({ id: "c3", source: { name: "s3", kind: "kv" } })];
  const capped = buildTopologyModel({ flows: many, maxEdges: 2, now: NOW });
  ok("builder: an explicit cap below the count draws only the first N edges", capped.edges.length === 2 && capped.capped === true && capped.drawnEdgeCount === 2 && capped.totalEdgeCount === 3);
  const atThreshold = buildTopologyModel({ flows: many, maxEdges: 3, now: NOW });
  ok("builder: a cap at the count draws everything (not flagged capped)", atThreshold.edges.length === 3 && atThreshold.capped === false);
  const aboveThreshold = buildTopologyModel({ flows: many, maxEdges: 10, now: NOW });
  ok("builder: a cap above the count draws everything", aboveThreshold.edges.length === 3 && aboveThreshold.capped === false);
  const noCap = buildTopologyModel({ flows: many, now: NOW });
  ok("builder: no maxEdges draws everything (cap clause short-circuits)", noCap.edges.length === 3 && noCap.capped === false);

  // The accessible name's freshness clause: when the freshness phrase equals the status label
  // (a disabled flow: both read "disabled"), the duplicate clause is dropped (the freshness
  // !== label guard false arm); when it differs (a fresh flow), the relative clause is added.
  const disabledName = buildTopologyModel({ flows: [flow({ id: "b7", status: "disabled", enabled: false })], now: NOW }).edges[0]!.accessibleName;
  ok("builder: a disabled flow's accessible name reads 'disabled' once (no duplicate clause)", disabledName.split("disabled").length === 2);
  const freshName = buildTopologyModel({ flows: [flow({ id: "b8", status: "healthy", lastRunAt: ts(-3600) })], now: NOW }).edges[0]!.accessibleName;
  ok("builder: a fresh flow's accessible name carries the distinct freshness clause", freshName.includes("fresh, last run"));
  // A flow with no cadence and unknown throughput: the cadence + bytes clauses are skipped
  // (the optional-clause false arms of buildAccessibleName).
  const sparseName = buildTopologyModel({ flows: [flow({ id: "b9", cadence: undefined, bytesPerRun: null })], now: NOW }).edges[0]!.accessibleName;
  ok("builder: an accessible name omits cadence + throughput when absent", !sparseName.toLowerCase().includes("daily") && !sparseName.includes("per run"));
}

main();
