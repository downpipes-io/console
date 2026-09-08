// THE TRUTHFULNESS CENSUS: for every customer-visible surface enrolled here, inject each fault class and
// grade the SENTENCE the operator reads, not the status code.
//
// THE ONE PROPERTY. A DAMAGED OR UNKNOWN STATE MUST NEVER PRODUCE THE ANSWER A HEALTHY ONE PRODUCES. Where
// a surface cannot tell, it must say it cannot tell. A could-not-check outranks a pass on a customer screen.
//
// HOW IT GRADES. It does not assert that a particular string appears. It renders the REAL production
// renderer over a family of labelled states, canonicalises what the operator would read (the visible text
// plus the status-dot HUES, because half of a tile's sentence is its colour), and looks for a COLLISION: two
// states of different truth class that produce a BYTE-IDENTICAL answer.
//
// WHAT IT REFUSES TO DO. It refuses to grade a surface that does not declare at least one healthy state and
// at least one damaged-or-unknown state, because "no surface lies under fault" is also true of a run that
// injected no faults. It refuses a run that drove zero surfaces or zero states. And it prints the census
// (surfaces, states, collisions) so the population is asserted rather than implied. A read is not a grading.
//
// THE FOUR REPAIRS THIS PINS, each measured on the real renderer before and after:
//   overview.updates-tile        versionSkew "uncomparable" answered exactly as "current" did, in ok green
//   overview.needs-me            a refused read answered exactly as a healthy fleet / a brand-new estate did
//   security.recovery-code-count an unreadable count earned the ok green a healthy eight earns
//   overview.config-tile         a status payload naming no gap still printed "Missing: . Open to fix."
//
// AND THE CONTROLS, which matter as much: five surfaces are enrolled that ALREADY discriminate (the Licence
// card's own update tile, the executive framing's five answers, the protection lead, the estate-band
// figures, the recovery-posture read tiles). If a repair here ever starts crying wolf on a healthy estate,
// or a future edit narrows one of those, this file goes red on the control rather than on the finding.
//
// Run with `node test/validate-surface-honesty.ts`.

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { buildTiles, buildProtectionLead } from "../src/screens/overview/tiles.ts";
import { buildNeedsMe } from "../src/screens/overview/recovery.ts";
import { summariseFleet } from "../src/screens/overview/fleet-data.ts";
import { executiveAnswers } from "../src/screens/overview/executive.ts";
import { renderRecoveryAccess } from "../src/screens/security-centre/access.ts";
import { estateFiguresUnreadable, estateSummaryLine } from "../src/screens/licence/estate-band.ts";
import { updateTileTone, updateTileValue, updateTileLabel } from "../src/screens/licence/shared.ts";
// ---- the second wave's surfaces (see "THE SECOND WAVE" below) ----------------------------
import { runStatusTone, statusWithLabel } from "../src/components/status.ts";
import { scoreBadge } from "../src/screens/security-centre/shared.ts";
import { scoreBand } from "../src/screens/security-centre/posture.ts";
import { rtoEstimateLine } from "../src/screens/reports-helpers.ts";
import { toneForStatus, destStateLabel, toneForAspect } from "../src/screens/canary-tone.ts";
import { freshnessLine } from "../src/screens/map/panels.ts";
import { pushAttemptLine, pushTrailSummary } from "../src/screens/settings/push-model.ts";
import { lastProvenLine } from "../src/screens/restore-flow/shared.ts";
import { vintageSummary } from "../src/screens/keys/vintages.ts";
import { emailTestVerdict } from "../src/screens/settings/support.ts";

let failures = 0;
function ok(label: string): void { console.log(`  ok   ${label}`); }
function fail(label: string): void { failures++; console.log(`  FAIL ${label}`); }

// ---------------------------------------------------------------------------
// The fault vocabulary
// ---------------------------------------------------------------------------

// Truth is the class a state belongs to, and it is what makes a collision a defect rather than a
// coincidence. Two HEALTHY states may answer identically (two current engines say "Up to date" and should).
// A DAMAGED or UNKNOWN state answering as a HEALTHY one is the property breaking.
type Truth = "healthy" | "damaged" | "unknown";

interface Cell { readonly name: string; readonly truth: Truth; readonly state: unknown }
interface Surface {
  readonly id: string;
  // render returns the ANSWER the operator reads: canonicalised text plus tone hues.
  readonly render: (state: never) => string;
  // glance, when the surface encodes health in status dots, returns the HUE VECTOR alone. It is a SECOND
  // grading axis and it exists because the first one nearly missed a real defect.
  //
  // A recovery-code count of NaN can render "NaN unused codes remaining" beside an OK GREEN dot. Against a
  // healthy eight the full answer differs (the digits differ), but the hue vector is identical, and the hue
  // is what an operator reads at a GLANCE, before any word. The honesty rule that stat-tiles.ts states in
  // its own header, "a tile NEVER shows green for unknown", is a rule about exactly this projection, so the
  // census grades it as its own axis.
  readonly glance?: (state: never) => string;
  readonly cells: readonly Cell[];
}

type Any = Record<string, unknown>;
const settledOk = <T,>(value: T) => ({ ok: true as const, value });
const settledErr = (e: unknown) => ({ ok: false as const, error: e });

function httpError(status: number): Error {
  const e = new Error(`http ${status}`) as Error & Any;
  (e as Any).status = status;
  (e as Any).name = "HttpError";
  return e;
}
const E500 = httpError(500);
const E403 = httpError(403);

// answerOf canonicalises what the operator reads off a rendered node: every status-dot HUE in document
// order, then the visible text with runs of whitespace collapsed. The hue is included deliberately. A tile
// that keeps its words and swaps ok green for warn amber has changed what it says, and a text-only compare
// would score that as no change at all.
function huesOf(node: unknown): string {
  const hues: string[] = [];
  const walk = (n: Any): void => {
    for (const m of String((n.className as string) ?? "").matchAll(/dot--([a-z-]+)/g)) hues.push(m[1] as string);
    for (const c of ((n.childNodes as Any[]) ?? [])) walk(c);
  };
  walk(node as Any);
  return `[${hues.join(",")}]`;
}

function answerOf(node: unknown): string {
  const hues: string[] = [];
  const walk = (n: Any): void => {
    for (const m of String((n.className as string) ?? "").matchAll(/dot--([a-z-]+)/g)) hues.push(m[1] as string);
    for (const c of ((n.childNodes as Any[]) ?? [])) walk(c);
  };
  walk(node as Any);
  const text = String(((node as Any).textContent as string) ?? "").replace(/\s+/g, " ").trim();
  return `[${hues.join(",")}] ${text}`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UPD_CURRENT = { configured: true, verified: true, updateAvailable: false, currentVersion: "0.1.10", recommendedVersion: "0.1.10", versionSkew: "current" };
const UPD_UNCOMPARABLE = { ...UPD_CURRENT, recommendedVersion: "not-a-version", versionSkew: "uncomparable" };
const UPD_AHEAD = { configured: true, verified: true, updateAvailable: false, currentVersion: "0.2.0", recommendedVersion: "0.1.10", versionSkew: "ahead" };
const UPD_BEHIND = { configured: true, verified: true, updateAvailable: true, currentVersion: "0.1.9", recommendedVersion: "0.1.10", versionSkew: "behind" };
const UPD_OLD_ENGINE = { configured: true, verified: true, updateAvailable: false, currentVersion: "0.1.10", recommendedVersion: "0.1.10" };

const STATUS_OK = {
  ready: true, signerConfigured: true, breakGlassConfigured: true, destConfigured: true,
  operationalConfigured: { private: true }, recoveryCodesRemaining: 8,
};

function healthyData(over: Any = {}): Any {
  return {
    health: settledOk({ ok: true, service: "downpipe engine" }),
    status: settledOk(STATUS_OK),
    licence: settledOk({ valid: true, tier: "business", notAfter: "2027-01-01T00:00:00Z" }),
    updates: settledOk(UPD_CURRENT),
    history: settledOk({ dp1: [{ status: "ok", startedAt: new Date(Date.now() - 3_600_000).toISOString(), recordCount: 5, archiveBytesWritten: 1000, segmentsWritten: 2 }] }),
    downpipes: settledOk([{ config: { id: "dp1", enabled: true, cadenceSeconds: 86_400, source: { type: "kv", namespaceId: "n1" } }, nextRunAt: Date.now() + 3_600_000 }]),
    drillEvidence: settledOk([{ recordedAt: new Date(Date.now() - 7_200_000).toISOString(), kind: "in-account", recordedBy: "a@b.c" }]),
    audit: settledOk([]),
    approvals: settledOk([]),
    discovery: settledOk({ bindings: [], tokenSources: [] }),
    ...over,
  };
}

const NEW_ESTATE = healthyData({ history: settledOk({}), downpipes: settledOk([]), drillEvidence: settledOk([]) });
const ALL_REFUSED: Any = {
  health: settledErr(E500), status: settledErr(E500), licence: settledErr(E500), updates: settledErr(E500),
  history: settledErr(E500), downpipes: settledErr(E500), drillEvidence: settledErr(E500), audit: settledErr(E500),
  approvals: settledErr(E500), discovery: settledErr(E500),
};

// ---- second-wave fixtures --------------------------------------------------
// flowRecord is one edge on the estate map. Only the fields the freshness sentence reads are varied; the
// rest are held constant so a difference in the answer can only have come from the status or the ring.
function flowRecord(over: Any = {}): Any {
  return {
    id: "dp1",
    source: { id: "kv:n1", kind: "kv", label: "sessions" },
    destination: { id: "r2:b1", kind: "r2", label: "backups" },
    status: "healthy",
    lastRunAt: "2026-08-13T00:00:00Z",
    cadence: 86_400,
    bytesPerRun: 1000,
    enabled: true,
    running: false,
    ...over,
  };
}
const RUN_OK = { runId: "r1", status: "ok", startedAt: "2026-08-13T00:00:00Z", recordCount: 5 };
// postureReport wraps a bare score in the smallest well-formed PostureReport the score band renders from.
// The checks are held constant and healthy, so the only thing that can move the tile's answer is the score.
function postureReport(score: unknown): Any {
  return {
    generatedAt: "2026-08-13T00:00:00Z",
    score,
    checks: [{ id: "c1", title: "A check", status: "pass", severity: "low", control: "CIS 1.1", observed: "fine", method: "platform", remediation: "none" }],
  };
}
const PUSH_OK = { at: "2026-08-13T00:00:00Z", ok: true, count: 10, fromSeq: 1, toSeq: 10, httpStatus: 200 };
const PUSH_FAIL = { at: "2026-08-13T00:00:00Z", ok: false, count: 10, fromSeq: 1, toSeq: 10, httpStatus: 503 };

const renderTile = (index: number) => (data: Any): string => {
  const grid = buildTiles(data as never, summariseFleet(data as never)) as unknown as Any;
  return answerOf(((grid.childNodes as unknown[]) ?? [])[index]);
};

const renderTileHues = (index: number) => (data: Any): string => {
  const grid = buildTiles(data as never, summariseFleet(data as never)) as unknown as Any;
  return huesOf(((grid.childNodes as unknown[]) ?? [])[index]);
};

// ---------------------------------------------------------------------------
// The enrolled surfaces
// ---------------------------------------------------------------------------

const SURFACES: Surface[] = [
  // ---- REPAIRED IN THIS PASS -----------------------------------------------
  {
    id: "overview.updates-tile",
    render: (d) => renderTile(3)(d as Any),
    glance: (d) => renderTileHues(3)(d as Any),
    cells: [
      { name: "engine is genuinely current", truth: "healthy", state: healthyData({ updates: settledOk(UPD_CURRENT) }) },
      { name: "engine is ahead of the channel", truth: "healthy", state: healthyData({ updates: settledOk(UPD_AHEAD) }) },
      { name: "an update is genuinely offered", truth: "healthy", state: healthyData({ updates: settledOk(UPD_BEHIND) }) },
      { name: "an older engine that never sent versionSkew", truth: "healthy", state: healthyData({ updates: settledOk(UPD_OLD_ENGINE) }) },
      { name: "the engine could not compare the two versions", truth: "unknown", state: healthyData({ updates: settledOk(UPD_UNCOMPARABLE) }) },
      { name: "the channel is configured and unverified", truth: "damaged", state: healthyData({ updates: settledOk({ ...UPD_CURRENT, verified: false }) }) },
      { name: "the update read was refused", truth: "unknown", state: healthyData({ updates: settledErr(E500) }) },
    ],
  },
  {
    id: "overview.needs-me",
    render: (d) => answerOf(buildNeedsMe(d as never, summariseFleet(d as never))),
    cells: [
      { name: "a healthy fleet with a dated drill", truth: "healthy", state: healthyData() },
      { name: "a brand-new estate with nothing configured", truth: "healthy", state: NEW_ESTATE },
      { name: "the downpipe list was refused", truth: "unknown", state: healthyData({ downpipes: settledErr(E500) }) },
      { name: "the run history was refused", truth: "unknown", state: healthyData({ history: settledErr(E500) }) },
      { name: "the approvals inbox was refused", truth: "unknown", state: healthyData({ approvals: settledErr(E403) }) },
      { name: "the update channel read was refused", truth: "unknown", state: healthyData({ updates: settledErr(E500) }) },
      { name: "every read was refused", truth: "unknown", state: ALL_REFUSED },
    ],
  },
  {
    id: "overview.config-tile",
    render: (d) => renderTile(1)(d as Any),
    glance: (d) => renderTileHues(1)(d as Any),
    cells: [
      { name: "signer, break-glass and destination all present", truth: "healthy", state: healthyData() },
      { name: "the destination is genuinely missing", truth: "damaged", state: healthyData({ status: settledOk({ ...STATUS_OK, ready: false, destConfigured: false }) }) },
      { name: "not ready and no sub-flag was reported", truth: "unknown", state: healthyData({ status: settledOk({ ready: false, operationalConfigured: { private: true } }) }) },
      // The measured empty-enumeration state: every part reported PRESENT and `ready` absent, so the gap
      // list is empty and the old tile still promised to name one. Caught by the third pass below, not by
      // the collision passes: "Missing: . Open to fix." collides with nothing, it is simply not a sentence.
      { name: "ready absent while all three parts report present", truth: "unknown", state: healthyData({ status: settledOk({ signerConfigured: true, breakGlassConfigured: true, destConfigured: true, operationalConfigured: { private: true } }) }) },
      { name: "the status read was refused", truth: "unknown", state: healthyData({ status: settledErr(E500) }) },
    ],
  },
  {
    id: "security.recovery-code-count",
    render: (s) => answerOf(renderRecoveryAccess({} as never, s as never, true, () => {})),
    glance: (s) => huesOf(renderRecoveryAccess({} as never, s as never, true, () => {})),
    cells: [
      { name: "eight unused codes", truth: "healthy", state: { ...STATUS_OK, recoveryCodesRemaining: 8 } },
      { name: "two unused codes, genuinely low", truth: "damaged", state: { ...STATUS_OK, recoveryCodesRemaining: 2 } },
      { name: "no unused codes at all", truth: "damaged", state: { ...STATUS_OK, recoveryCodesRemaining: 0 } },
      { name: "an engine that does not report the count", truth: "unknown", state: { ...STATUS_OK, recoveryCodesRemaining: undefined } },
      { name: "a count that is NaN", truth: "unknown", state: { ...STATUS_OK, recoveryCodesRemaining: Number.NaN } },
      { name: "a count that is null", truth: "unknown", state: { ...STATUS_OK, recoveryCodesRemaining: null } },
      { name: "a count that arrived as a string", truth: "unknown", state: { ...STATUS_OK, recoveryCodesRemaining: "8" } },
      { name: "a negative count", truth: "unknown", state: { ...STATUS_OK, recoveryCodesRemaining: -1 } },
    ],
  },

  // ---- CONTROLS: surfaces that already discriminate ------------------------
  // These are here so a repair that starts crying wolf, or an edit that narrows one of them back into a
  // silent pass, goes red HERE rather than going unnoticed. A finding without a control beside it is a
  // measurement with nothing to compare against.
  {
    id: "licence.update-tile",
    render: (u) => `${updateTileTone(u as never)} | ${updateTileValue(u as never)} | ${updateTileLabel(u as never)}`,
    cells: [
      { name: "engine is genuinely current", truth: "healthy", state: UPD_CURRENT },
      { name: "engine is ahead of the channel", truth: "healthy", state: UPD_AHEAD },
      { name: "an update is genuinely offered", truth: "healthy", state: UPD_BEHIND },
      { name: "an older engine that never sent versionSkew", truth: "healthy", state: UPD_OLD_ENGINE },
      { name: "the engine could not compare the two versions", truth: "unknown", state: UPD_UNCOMPARABLE },
      { name: "the channel is configured and unverified", truth: "damaged", state: { ...UPD_CURRENT, verified: false } },
      { name: "the channel is not configured", truth: "damaged", state: { ...UPD_CURRENT, configured: false } },
    ],
  },
  {
    id: "overview.protection-lead",
    render: (d) => answerOf(buildProtectionLead(d as never)),
    cells: [
      { name: "one downpipe, backed up", truth: "healthy", state: healthyData() },
      { name: "no downpipes configured at all", truth: "healthy", state: NEW_ESTATE },
      { name: "the downpipe list was refused", truth: "unknown", state: healthyData({ downpipes: settledErr(E500) }) },
      { name: "the downpipe list settled ok carrying nothing", truth: "unknown", state: healthyData({ downpipes: settledOk(undefined) }) },
    ],
  },
  {
    id: "overview.executive-answers",
    render: (d) => executiveAnswers(d as never, summariseFleet(d as never), { state: "unknown" } as never)
      .map((a) => { const x = a as unknown as Any; return `${x.key as string}=${x.tone as string}:${x.headline as string}`; }).join(" | "),
    cells: [
      { name: "a healthy fleet with a dated drill", truth: "healthy", state: healthyData() },
      { name: "a brand-new estate", truth: "healthy", state: NEW_ESTATE },
      { name: "the downpipe list was refused", truth: "unknown", state: healthyData({ downpipes: settledErr(E500) }) },
      { name: "the run history was refused", truth: "unknown", state: healthyData({ history: settledErr(E500) }) },
      { name: "the status read was refused", truth: "unknown", state: healthyData({ status: settledErr(E500) }) },
      { name: "every read was refused", truth: "unknown", state: ALL_REFUSED },
    ],
  },
  {
    id: "licence.estate-figures",
    render: (e) => `${JSON.stringify(estateSummaryLine(e as never))} | unreadable=${estateFiguresUnreadable(e as never)}`,
    cells: [
      { name: "a measured estate", truth: "healthy", state: { totalProtectedBytes: 1024 ** 4, accounts: 3, downpipes: 5 } },
      { name: "an estate measured at zero", truth: "healthy", state: { totalProtectedBytes: 0, accounts: 1, downpipes: 0 } },
      { name: "no estate reported at all", truth: "healthy", state: null },
      { name: "a byte total that is NaN", truth: "unknown", state: { totalProtectedBytes: Number.NaN, accounts: 3 } },
      { name: "a negative byte total", truth: "unknown", state: { totalProtectedBytes: -1, accounts: 3 } },
      { name: "an absent account count", truth: "unknown", state: { totalProtectedBytes: 1024 ** 4 } },
    ],
  },
  {
    id: "overview.recovery-point-tile",
    render: (d) => renderTile(4)(d as Any),
    glance: (d) => renderTileHues(4)(d as Any),
    cells: [
      { name: "a fleet with a good backup", truth: "healthy", state: healthyData() },
      { name: "a brand-new estate with no runs", truth: "healthy", state: NEW_ESTATE },
      { name: "the run history was refused", truth: "unknown", state: healthyData({ history: settledErr(E500) }) },
      { name: "a downpipe that has never completed a good backup", truth: "damaged", state: healthyData({ history: settledOk({ dp1: [{ status: "failed", startedAt: new Date().toISOString() }] }) }) },
    ],
  },

  // ==========================================================================
  // THE SECOND WAVE: the customer-visible surfaces the first pass did not enrol.
  // ==========================================================================
  //
  // The first pass enrolled nine surfaces on Overview, Security Centre and Licence, and four of them lied.
  // Everything below is a surface an operator reads a health verdict off, reached by a route the first pass
  // did not walk: the run pickers, the map drawer, the reports panel, the canary, the notification trail,
  // the key vintages and the restore recency.
  //
  // THE SIBLING RULE IS WHY SEVERAL OF THESE ARE HERE: recoveryCountTone's defect was that every comparison
  // in a numeric band is FALSE for NaN and TRUE-by-coercion for null and for a numeric string, so an
  // unreadable count fell through to the healthy arm. That function has siblings on the tree doing the
  // identical thing to a different number, so a repair on one band without its siblings is a real risk.
  {
    // THE RUN STATUS, which is the single most consequential label in the product: it is what the RESTORE
    // RUN PICKER shows beside each run an operator is about to recover from (restore-flow/run-picker.ts:112,
    // run-context.ts:98 and :131, date-picker.ts), and what the downpipe drawer's run strip shows.
    id: "runs.run-status",
    render: (s) => { const t = runStatusTone(s as never); return answerOf(statusWithLabel(t.tone, t.label)); },
    glance: (s) => { const t = runStatusTone(s as never); return huesOf(statusWithLabel(t.tone, t.label)); },
    cells: [
      { name: "a run that completed", truth: "healthy", state: "ok" },
      { name: "a run that is genuinely still in flight", truth: "healthy", state: "in-flight" },
      { name: "a run that failed", truth: "damaged", state: "failed" },
      { name: "a run the engine abandoned", truth: "damaged", state: "abandoned" },
      { name: "a status a newer engine sends that this console does not know", truth: "unknown", state: "cancelled" },
      { name: "a run row that carried no status at all", truth: "unknown", state: undefined },
      { name: "a status that arrived null", truth: "unknown", state: null },
      { name: "a status that arrived empty", truth: "unknown", state: "" },
    ],
  },
  {
    // THE POSTURE SCORE, the headline of the Security Centre and the figure that leads the signed posture
    // report. This is recoveryCountTone's closest sibling on the tree: the same 0..100 band shape, the same
    // `>=` comparisons, and no readability test in front of them.
    id: "security.posture-score",
    render: (n) => answerOf(scoreBadge(n as never)),
    glance: (n) => huesOf(scoreBadge(n as never)),
    cells: [
      { name: "a strong score", truth: "healthy", state: 95 },
      { name: "a fair score", truth: "healthy", state: 88 },
      { name: "a score that needs work", truth: "healthy", state: 40 },
      { name: "a genuine zero, every check failing", truth: "healthy", state: 0 },
      { name: "a score that is NaN", truth: "unknown", state: Number.NaN },
      { name: "a score that arrived null", truth: "unknown", state: null },
      { name: "a score the engine did not send", truth: "unknown", state: undefined },
      { name: "a score that arrived as a string", truth: "unknown", state: "88" },
      { name: "a negative score", truth: "unknown", state: -5 },
      { name: "a score above the scale", truth: "unknown", state: 150 },
    ],
  },
  {
    // THE POSTURE SCORE TILE, the SECOND consumer of the same number, enrolled as its own surface because
    // the badge above it was not enough to see it. Planting the tile's old behaviour back turned no cell
    // red while only scoreBadge was enrolled, which is precisely the hole the first pass found in its own
    // instrument twice over: a check that cannot see the failure it is grading. The tile re-derives
    // `Math.round(report.score) / 100` itself, so it is a separate answer on the same screen.
    //
    // NO GLANCE PROJECTION HERE: the score BAND is a whole card, one badge plus four stat tiles, and the
    // four tiles report the check counts, which have nothing to do with the score. Their ok hues sit in a
    // combined hue vector, which would make the reassuring-hue test match on them rather than on the
    // score's own tone. The score's OWN hue is already graded on security.posture-score above, where the
    // projection is the badge alone; here the byte-identity axis tells all five faulted states apart on the
    // text, which is what this surface exists to check.
    id: "security.posture-score-tile",
    render: (n) => answerOf(scoreBand(postureReport(n) as never)),
    cells: [
      { name: "a strong score", truth: "healthy", state: 95 },
      { name: "a fair score", truth: "healthy", state: 88 },
      { name: "a genuine zero, every check failing", truth: "healthy", state: 0 },
      { name: "a score that is NaN", truth: "unknown", state: Number.NaN },
      { name: "a score that arrived null", truth: "unknown", state: null },
      { name: "a score the engine did not send", truth: "unknown", state: undefined },
      { name: "a score that arrived as a string", truth: "unknown", state: "88" },
      { name: "a score above the scale", truth: "unknown", state: 150 },
    ],
  },
  {
    // THE RECOVERY-TIME ESTIMATE, the RTO figure on Reports, which is the number an executive reads as
    // "how long until we are back". The honest-unknown arm here is a REAL product state (no drills yet)
    // and it is enrolled as healthy for exactly that reason: the question is whether anything else can
    // reach it.
    id: "reports.rto-estimate",
    render: (e) => { const l = rtoEstimateLine(e as never); return `known=${l.known} | ${l.value} | ${l.basis}`; },
    cells: [
      { name: "a measured estimate from three drills", truth: "healthy", state: { known: true, estimateSeconds: 7200, basedOnDrills: 3, confidence: "medium" } },
      { name: "no drills yet, the honest unknown", truth: "healthy", state: { known: false } },
      { name: "an estimate the engine could not project", truth: "healthy", state: { known: false, reason: "The last drill did not record a throughput." } },
      { name: "a projection that arrived NaN", truth: "unknown", state: { known: true, estimateSeconds: Number.NaN, basedOnDrills: 3, confidence: "medium" } },
      { name: "a projection that arrived negative", truth: "unknown", state: { known: true, estimateSeconds: -1, basedOnDrills: 3, confidence: "medium" } },
      { name: "a projection that arrived as a string", truth: "unknown", state: { known: true, estimateSeconds: "7200", basedOnDrills: 3, confidence: "medium" } },
      { name: "a known estimate with no seconds field at all", truth: "unknown", state: { known: true, basedOnDrills: 3, confidence: "medium" } },
    ],
  },
  {
    // THE CANARY'S LIVENESS BADGE. The canary exists to be the early warning that a destination has gone
    // bad, so a canary whose own liveness cannot be read is precisely the state that must not read calm.
    id: "canary.liveness-badge",
    render: (s) => answerOf(statusWithLabel(toneForStatus(s as never), destStateLabel(s as never))),
    glance: (s) => huesOf(statusWithLabel(toneForStatus(s as never), destStateLabel(s as never))),
    cells: [
      { name: "the canary is alive", truth: "healthy", state: "alive" },
      { name: "the canary has not flown yet", truth: "healthy", state: "pending" },
      { name: "the canary is switched off", truth: "healthy", state: "disabled" },
      { name: "the canary is dead", truth: "damaged", state: "dead" },
      { name: "the canary is ailing", truth: "damaged", state: "ailing" },
      { name: "a liveness a newer engine sends that this console does not know", truth: "unknown", state: "quarantined" },
      { name: "a flight row that carried no liveness at all", truth: "unknown", state: undefined },
    ],
  },
  {
    // THE CANARY'S PER-ASPECT OUTCOME, enrolled because it is destStateLabel's SIBLING IN THE SAME FILE,
    // doing the identical thing to a different closed set. A sibling function doing the same coercion often
    // hides in the next function down.
    id: "canary.aspect-outcome",
    render: (o) => { const t = toneForAspect(o as never); return `${t.tone} | ${t.label}`; },
    cells: [
      { name: "the aspect passed", truth: "healthy", state: "pass" },
      { name: "the aspect was noted, not failed", truth: "healthy", state: "note" },
      { name: "the aspect genuinely did not run", truth: "healthy", state: "skip" },
      { name: "the aspect failed", truth: "damaged", state: "fail" },
      { name: "an outcome a newer engine sends that this console does not know", truth: "unknown", state: "inconclusive" },
      { name: "an aspect row that carried no outcome at all", truth: "unknown", state: undefined },
    ],
  },
  {
    // THE MAP DRAWER'S FRESHNESS LINE, the sentence the operator reads after clicking an edge on the
    // estate map. It already tells a never-run pipe apart from an unreadable history, which is why it is
    // worth grading: the discrimination it has is the discrimination the rest of it should have.
    id: "map.flow-freshness",
    render: (x) => { const s = x as Any; return answerOf(freshnessLine(s.flow as never, s.ring as never)); },
    glance: (x) => { const s = x as Any; return huesOf(freshnessLine(s.flow as never, s.ring as never)); },
    cells: [
      { name: "a fresh flow with runs behind it", truth: "healthy", state: { flow: flowRecord({ status: "healthy" }), ring: [RUN_OK] } },
      { name: "a flow whose downpipe is paused", truth: "healthy", state: { flow: flowRecord({ status: "disabled", enabled: false }), ring: [RUN_OK] } },
      { name: "a configured flow that has never run", truth: "healthy", state: { flow: flowRecord({ status: "unknown" }), ring: [] } },
      { name: "a run is in progress", truth: "healthy", state: { flow: flowRecord({ status: "healthy", running: true }), ring: [RUN_OK] } },
      { name: "the flow is stale", truth: "damaged", state: { flow: flowRecord({ status: "stale" }), ring: [RUN_OK] } },
      { name: "the latest run failed", truth: "damaged", state: { flow: flowRecord({ status: "failed" }), ring: [RUN_OK] } },
      { name: "this destination holds no copy", truth: "damaged", state: { flow: flowRecord({ status: "no-copy" }), ring: [RUN_OK] } },
      { name: "the run history could not be read", truth: "unknown", state: { flow: flowRecord({ status: "unknown" }), ring: null } },
      // A FlowStatus this build does not know is NOT REACHABLE here and is deliberately not enrolled:
      // statusPresent (map/panels.ts:122) is an exhaustive switch with no default, so an unknown value would
      // make freshnessLine dereference .tone off undefined. FlowStatus is not a wire value, though: it is
      // DERIVED console-side by deriveStatus (map/data.ts:419) out of a closed set, and the only wire enum
      // behind it already goes through classifyFreshness's unknown-enum guard. The surface stays enrolled on
      // its real states, where it is a CONTROL: it already tells a never-run pipe from an unreadable history.
    ],
  },
  {
    // THE AUDIT-PUSH DELIVERY TRAIL on Settings, which is the only place an operator can see whether their
    // SIEM is actually receiving the audit log. A row that cannot say how much it sent is a row that
    // cannot answer the question the screen exists for.
    id: "settings.push-attempt",
    render: (a) => { const l = pushAttemptLine(a as never); return `${l.tone} | ${l.text}`; },
    cells: [
      { name: "a real batch the sink accepted", truth: "healthy", state: { at: "2026-08-13T00:00:00Z", ok: true, count: 500, fromSeq: 1, toSeq: 500, httpStatus: 200 } },
      { name: "a genuine single test event the sink accepted", truth: "healthy", state: { at: "2026-08-13T00:00:00Z", ok: true, httpStatus: 200 } },
      { name: "a batch the sink refused", truth: "damaged", state: { at: "2026-08-13T00:00:00Z", ok: false, count: 500, fromSeq: 1, toSeq: 500, httpStatus: 503 } },
      { name: "a batch accepted whose answer could not be read", truth: "damaged", state: { at: "2026-08-13T00:00:00Z", ok: true, count: 500, fromSeq: 1, toSeq: 500, httpStatus: 200, reason: "unparseable body" } },
      { name: "a real batch whose counts did not arrive", truth: "unknown", state: { at: "2026-08-13T00:00:00Z", ok: true, httpStatus: 200, fromSeq: 1, toSeq: 500 } },
    ],
  },
  {
    // THE RESTORABILITY RECENCY, the dated "last proven" line on the restore flow. It is the claim that a
    // recovery has actually been rehearsed, so a date it cannot read must not become a proof it asserts.
    id: "restore.last-proven",
    render: (s) => lastProvenLine(s as never),
    cells: [
      { name: "proven, with a date and a prover", truth: "healthy", state: { lastRestoreProvenAt: "2026-08-01T00:00:00Z", lastRestoreProvenBy: "a@b.c" } },
      { name: "never proven yet", truth: "healthy", state: { config: { id: "dp1" } } },
      { name: "no state fetched at all", truth: "healthy", state: undefined },
      { name: "a proof date this console cannot parse", truth: "unknown", state: { lastRestoreProvenAt: "yesterday", lastRestoreProvenBy: "a@b.c" } },
      { name: "a proof date that arrived as a number of nothing", truth: "unknown", state: { lastRestoreProvenAt: Number.NaN, lastRestoreProvenBy: "a@b.c" } },
    ],
  },

  // ---- SECOND-WAVE CONTROLS: surfaces that already discriminate --------------
  {
    // The key-vintage verdict is the model answer for this whole property and it is enrolled as a control
    // for that reason: it tests historyReadOk and `truncated` BEFORE it says anything, so a partial read
    // gets its own sentence rather than the all-clear. If an edit ever collapses those arms, this reddens.
    id: "keys.vintage-verdict",
    render: (i) => { const v = vintageSummary(i as never); return `${v.tone} | ${v.title} | ${v.detail}`; },
    cells: [
      { name: "a complete pass with nothing stranded", truth: "healthy", state: { historyReadOk: true, truncated: false, stranded: { runCount: 0, unknownCount: 0 }, vintages: [] } },
      { name: "runs genuinely stranded to a retired key", truth: "damaged", state: { historyReadOk: true, truncated: false, stranded: { runCount: 3, unknownCount: 0 }, vintages: [] } },
      { name: "the run history could not be read", truth: "unknown", state: { historyReadOk: false, truncated: false, stranded: { runCount: 0, unknownCount: 0 }, vintages: [] } },
      { name: "the pass did not read every run", truth: "unknown", state: { historyReadOk: true, truncated: true, stranded: { runCount: 0, unknownCount: 0 }, vintages: [] } },
      { name: "some runs could not be attributed to a vintage", truth: "unknown", state: { historyReadOk: true, truncated: false, stranded: { runCount: 0, unknownCount: 2 }, vintages: [] } },
    ],
  },
  {
    // The email-test verdict is a control on the OTHER half of the property: a refusal must name the fix.
    // Every failing arm here names a specific remedy, and the catch-all still names one.
    id: "settings.email-test",
    render: (r) => emailTestVerdict(r as never),
    cells: [
      { name: "the send succeeded", truth: "healthy", state: { ok: true } },
      { name: "the sending domain is not onboarded", truth: "damaged", state: { ok: false, code: "E_SENDER_DOMAIN_NOT_AVAILABLE" } },
      { name: "no send_email binding is bound", truth: "damaged", state: { ok: false, reason: "email-not-configured" } },
      { name: "the signed-in identity has no address", truth: "damaged", state: { ok: false, reason: "email-test-needs-identity" } },
      { name: "a failure with no class at all", truth: "unknown", state: { ok: false } },
    ],
  },
  {
    // The push trail's aggregate sentence, a control on the count: an empty trail says so, and a full
    // trail says the older entries rolled over rather than implying it saw everything.
    id: "settings.push-trail-summary",
    render: (t) => pushTrailSummary(t as never),
    cells: [
      { name: "no attempts yet", truth: "healthy", state: [] },
      { name: "three attempts, the last one accepted", truth: "healthy", state: [PUSH_OK, PUSH_OK, PUSH_OK] },
      { name: "three attempts, the last one refused", truth: "damaged", state: [PUSH_OK, PUSH_OK, PUSH_FAIL] },
    ],
  },
];

// ---------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------

console.log("-- population --");
if (SURFACES.length === 0) fail("the census enrolled ZERO surfaces, so it graded nothing");
else ok(`${SURFACES.length} surfaces enrolled`);

let totalCells = 0;
for (const s of SURFACES) {
  totalCells += s.cells.length;
  const healthy = s.cells.filter((c) => c.truth === "healthy").length;
  const faulted = s.cells.filter((c) => c.truth !== "healthy").length;
  if (healthy === 0) fail(`${s.id} declares no HEALTHY state, so a collision could not be defined for it`);
  else if (faulted === 0) fail(`${s.id} injects no fault, so "it does not lie under fault" would be vacuously true of it`);
  else ok(`${s.id}: ${healthy} healthy + ${faulted} faulted states`);
}
if (totalCells === 0) fail("the census drove ZERO states");
else ok(`${totalCells} states driven in total`);

console.log("\n-- collisions (a damaged or unknown state answering as a healthy one) --");
let collisions = 0;
let compared = 0;
for (const surface of SURFACES) {
  const answers = new Map<string, string>(); // cell name -> answer
  for (const cell of surface.cells) {
    let answer: string;
    try {
      answer = surface.render(cell.state as never);
    } catch (e) {
      // A THROW IS NOT A PASS. A renderer that dies on a fault renders nothing at all, which is a state the
      // operator cannot read either; it is graded as a finding rather than skipped.
      fail(`${surface.id} / ${cell.name}: the renderer THREW (${e instanceof Error ? e.message : String(e)}), so the operator reads nothing`);
      continue;
    }
    answers.set(cell.name, answer);
  }
  const healthyAnswers = new Map<string, string>(); // answer -> the healthy cell that produced it
  for (const cell of surface.cells) {
    if (cell.truth !== "healthy") continue;
    const a = answers.get(cell.name);
    if (a !== undefined && !healthyAnswers.has(a)) healthyAnswers.set(a, cell.name);
  }
  for (const cell of surface.cells) {
    if (cell.truth === "healthy") continue;
    const a = answers.get(cell.name);
    if (a === undefined) continue;
    compared++;
    const twin = healthyAnswers.get(a);
    if (twin !== undefined) {
      collisions++;
      fail(`${surface.id}: "${cell.name}" (${cell.truth}) answers BYTE-IDENTICALLY to "${twin}" (healthy)\n         both read: ${a}`);
    } else {
      ok(`${surface.id}: "${cell.name}" (${cell.truth}) is told apart from every healthy state`);
    }
  }
}
if (compared === 0) fail("no damaged state was ever compared against a healthy one, so nothing was graded");
else ok(`${compared} damaged/unknown states compared against their surface's healthy answers`);

// REASSURING is the hue set that CLAIMS things are fine. It is deliberately not every hue.
//
// NEUTRAL IS NOT REASSURANCE AND MUST NOT BE GRADED AS ONE. It is this product's honest could-not-tell hue,
// and stat-tiles.ts uses it for the unknown state on purpose, so a refused read and a brand-new estate with
// nothing to say BOTH wear neutral and both are telling the truth. A rule that flagged that pair would cry
// wolf on the very state the repair exists to produce, and a warning that fires on the honest answer is how
// an honest answer gets removed. Note this narrowing is the opposite of one refused earlier: it drops
// a class that is not a defect, rather than folding a could-not-check into a pass.
const REASSURING = ["ok", "trust"] as const;

console.log("\n-- glance collisions (a faulted state wearing a healthy state's exact reassuring hues) --");
let glanceCollisions = 0;
let glanceCompared = 0;
let glanceSurfaces = 0;
for (const surface of SURFACES) {
  const glance = surface.glance;
  if (glance === undefined) continue;
  glanceSurfaces++;
  const hues = new Map<string, string>();
  const healthyHues = new Map<string, string>();
  for (const cell of surface.cells) {
    let h: string;
    try { h = glance(cell.state as never); } catch { continue; }
    hues.set(cell.name, h);
    if (cell.truth === "healthy" && !healthyHues.has(h)) healthyHues.set(h, cell.name);
  }
  for (const cell of surface.cells) {
    if (cell.truth === "healthy") continue;
    const h = hues.get(cell.name);
    if (h === undefined) continue;
    glanceCompared++;
    const twin = healthyHues.get(h);
    if (twin !== undefined && REASSURING.some((r) => h.includes(r))) {
      glanceCollisions++;
      fail(`${surface.id}: "${cell.name}" (${cell.truth}) wears the EXACT reassuring hues of "${twin}" (healthy): ${h}`);
    } else if (twin !== undefined) {
      ok(`${surface.id}: "${cell.name}" (${cell.truth}) shares only non-reassuring hues with "${twin}": ${h}`);
    } else {
      ok(`${surface.id}: "${cell.name}" (${cell.truth}) does not wear a healthy state's hues`);
    }
  }
}
// The glance axis is only meaningful over surfaces that declare it, so it asserts its own population too
// rather than reporting a silent zero.
if (glanceSurfaces === 0) fail("no surface declared a glance projection, so the hue axis graded nothing");
else ok(`${glanceSurfaces} surfaces graded on hue alone, ${glanceCompared} faulted states compared`);

// THIRD PASS: IS THE REFUSAL HONEST? A collision detector cannot see this class: the config tile's old
// behaviour produced "Missing: . Open to fix.", which is byte-identical to nothing at all. It is not a lie
// about health, it is a sentence that promises to name something and then names nothing, which is a refusal
// an operator cannot act on. It needed its own pass.
//
// The rule is deliberately narrow and syntactic so it cannot be argued with: an enumeration marker (a colon
// or the words "Missing"/"Open") immediately followed by the end of the clause. It scans EVERY answer the
// census already rendered, so it costs nothing and it covers every surface, not just the one that failed.
console.log("\n-- empty enumerations (a refusal that names nothing) --");
const EMPTY_ENUMERATION = /(?::\s*[.,]|\bMissing:\s*(?:[.]|$))/;
let danglers = 0;
let scanned = 0;
for (const surface of SURFACES) {
  for (const cell of surface.cells) {
    let answer: string;
    try { answer = surface.render(cell.state as never); } catch { continue; }
    scanned++;
    if (EMPTY_ENUMERATION.test(answer)) {
      danglers++;
      fail(`${surface.id}: "${cell.name}" promises to name something and names nothing\n         reads: ${answer}`);
    }
  }
}
if (scanned === 0) fail("no answer was scanned for an empty enumeration, so this pass graded nothing");
else ok(`${scanned} answers scanned, ${danglers} promising to name something they do not name`);

// FOURTH PASS: DID THE SENTENCE KEEP ITS CLAIM AND DROP ITS VALUE? This is the empty-enumeration rule's
// nearer relative, and it is here because a real defect sat just outside the third pass's reach. The restore
// screen's recency line renders `Restorability last proven ${dateOnly(at)}.` and dateOnly returns the EMPTY
// STRING for any instant it cannot parse, so a corrupt proof stamp reads "Restorability last proven ." The
// verb survives, the date vanishes, and the strongest claim on the restore path is asserted over nothing.
// It carries no colon and no "Missing", so the third pass could not see it.
//
// The rule is again deliberately syntactic and again deliberately narrow: a gap where a value was
// interpolated leaves either whitespace immediately before the closing full stop, or two spaces in a row
// between the words that surrounded it. Both are printing artefacts of an empty interpolation and neither
// is something prose does on purpose. IT IS VERIFIED NOT TO CRY WOLF: it is run over every answer the census
// renders, including the nine surfaces the first pass enrolled and the three second-wave controls, and it
// finds nothing there.
console.log("\n-- blanked values (a sentence that kept its claim and lost the value) --");
const BLANKED_VALUE = /(?:\s\.(?:\s|$)|\S {2,}\S)/;
let blanked = 0;
let blankScanned = 0;
for (const surface of SURFACES) {
  for (const cell of surface.cells) {
    let answer: string;
    try { answer = surface.render(cell.state as never); } catch { continue; }
    blankScanned++;
    if (BLANKED_VALUE.test(answer)) {
      blanked++;
      fail(`${surface.id}: "${cell.name}" states its claim with the value blanked out\n         reads: ${answer}`);
    }
  }
}
if (blankScanned === 0) fail("no answer was scanned for a blanked value, so this pass graded nothing");
else ok(`${blankScanned} answers scanned, ${blanked} stating a claim over a blanked value`);

// FIFTH PASS: IS A JAVASCRIPT NON-VALUE BEING READ AS A FIGURE? An unreadable score can wear a different
// HUE from every healthy one, so the collision axis alone separates the states no matter what figure the
// tile prints beside them. A tile that goes on printing the literal "NaN / 100" would still be told apart
// by hue, and it is still a lie: "NaN" is not a score, and an operator reading it has been shown the
// console's internals where a number belongs.
//
// The rule is a word-boundary match on NaN and undefined in an answer an operator reads. Neither is English
// and neither is valid JSON, which is what makes the rule safe to state this bluntly.
//
// `null` is deliberately not in it: `null` is legitimate JSON output (some surfaces here project their
// state via JSON.stringify for the byte-identity comparison, and a function honestly returning null encodes
// as the four characters "null" in that debug encoding rather than on any screen), whereas NaN and
// undefined are never legitimate values for an operator to read.
console.log("\n-- non-values on screen (a JavaScript nothing printed where a value belongs) --");
// NO LEADING \b: written as /\b(?:NaN|undefined)\b/ the pattern would miss the defect, because answerOf
// canonicalises DOM textContent and adjacent nodes concatenate with no separator: the posture tile can
// render "ScoreNaN / 100", where the character before the N is a word character and the leading word
// boundary never matches. A trailing lookahead is enough to keep the match from firing inside a longer word.
const NON_VALUE = /(?:NaN|undefined)(?![A-Za-z])/;
let nonValues = 0;
let nvScanned = 0;
for (const surface of SURFACES) {
  for (const cell of surface.cells) {
    let answer: string;
    try { answer = surface.render(cell.state as never); } catch { continue; }
    nvScanned++;
    if (NON_VALUE.test(answer)) {
      nonValues++;
      fail(`${surface.id}: "${cell.name}" prints a JavaScript non-value where a value belongs\n         reads: ${answer}`);
    }
  }
}
if (nvScanned === 0) fail("no answer was scanned for a non-value, so this pass graded nothing");
else ok(`${nvScanned} answers scanned, ${nonValues} printing a JavaScript non-value`);

console.log(`\nCENSUS: surfaces=${SURFACES.length} states=${totalCells} faulted-compared=${compared} collisions=${collisions} glance-collisions=${glanceCollisions} empty-enumerations=${danglers} blanked-values=${blanked} non-values=${nonValues}`);
console.log(failures === 0 ? "\nSURFACE HONESTY PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
