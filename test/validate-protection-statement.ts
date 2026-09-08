// Validate the plain-English protection-statement generator (src/lib/protection-statement.ts).
// Run with: node test/validate-protection-statement.ts
//
// The protection statement is the honest "what is protected, and how well is it proven" read the
// console leads with (the overview lead line + the downpipes subtitle). The whole value of it is
// that it states ONLY what is TRUE: this suite drives the REAL generator across the cadence /
// destination / recency matrix and asserts:
//
//   - cadence renders correctly (daily / weekly / hourly / every Nh) in the backup + assurance clauses;
//   - the destination is named from status the same way the map/overview name it (R2 / S3 / unnamed /
//     not configured / unknown);
//   - last-proven renders with the prover identity ("last proven 2 Jun by alice"), and the date is the
//     plain "D Mon" form (shortDate);
//   - HONEST ABSENCE: a never-proven downpipe reads "never proven" (never a false "verified"); a
//     never-integrity-checked downpipe reads "never integrity-checked"; an absent restore test reads
//     "no scheduled restore test";
//   - a FAILED check is never softened into a pass (integrity FAILED / restore test FAILED);
//   - OVERDUE recency reads "overdue", not current;
//   - the TONE floor: "covered" is NEVER returned unless restorability is actually proven (a
//     backed-up-but-never-proven downpipe is "unproven", never "covered");
//   - the blunt not-covered line names the strongest gap;
//   - the fleet roll-up tone is the WORST across the fleet, the counts are right, and an empty fleet
//     is an honest "nothing protected", never a vacuous "all covered".
//
// Note: protection-statement.ts imports lib/format.ts only (no DOM module), so it is callable in
// Node.js without a DOM (the same pattern validate-format.ts / validate-freshness.ts use).

import {
  protectionStatement,
  fleetProtection,
  destinationFromStatus,
  sourceName,
  sourceTypeLabel,
  shortDate,
  type DestinationDescriptor,
} from "../src/lib/protection-statement.ts";
import type { Downpipe, DownpipeState, SourceSpec, StatusReport, EngineDownpipeState } from "../src/api.ts";
// mapEngineDownpipeState is the BOUNDARY mapping listDownpipes() runs (engine wire shape -> the
// console's DownpipeState). It is imported here so the fixtures below can be built in the REAL engine
// response shape (nested restoreProven { at: epoch-ms, by }, epoch-ms lastRestoreTestAt) and driven
// THROUGH the mapping, exactly as production does. This is what makes the suite fail if the mapping is
// dropped: the previous fixtures were hand-built FLAT DownpipeState objects that bypassed the mapping
// and so passed even though production silently rendered "offline restorability last proven never".
import { mapEngineDownpipeState } from "../src/api.ts";
import { makeChecks } from "./validate-checks.ts";

const checks = makeChecks();
const { ok, eq, has, lacks } = checks;

// ---------------------------------------------------------------------------
// Fixtures. A fixed NOW so the "D Mon" dates and the overdue maths are deterministic.
// ---------------------------------------------------------------------------
const DAY = 86_400_000;
// NOW = UTC (a fixed anchor so the "D Mon" date maths are deterministic), so a 7-Jun proof reads "7 Jun".
const NOW = Date.parse("2026-06-09T12:00:00Z");
const DAILY = 86_400;
const WEEKLY = 604_800;
const HOURLY = 3_600;

function iso(daysAgo: number): string {
  return new Date(NOW - daysAgo * DAY).toISOString();
}

// These helpers build a fixture by spreading overrides over defaults, so passing `undefined` for a key
// is how a case REMOVES a default: `source({ binding: undefined })` is what makes sourceName fall through
// to the namespace, and it is not the same as omitting the key, which leaves the default "uploads" in
// place. Proven by omitting them, at which point two fallback assertions failed.
//
// Partial<T> cannot express that under exactOptionalPropertyTypes, which reads an optional property as
// "absent or a value" and rejects an explicit undefined. Overrides<T> says what these helpers actually
// accept.
// Only the keys that are ALREADY optional accept an explicit undefined. Adding `| undefined` across the
// board would also let a case blank out a required field, and the spread would then build a fixture that
// is not a valid SourceSpec at all, which the compiler is right to refuse.
type Overrides<T> = { [K in keyof T]?: undefined extends T[K] ? T[K] | undefined : T[K] };

// Drops the keys a case blanked out, so what comes back is a genuine SourceSpec rather than one carrying
// an explicit undefined on an optional key. Every reader here behaves identically either way (truthiness,
// or === undefined), and this way the fixture matches the shape the engine would actually be handed.
function strip<T extends object>(o: { [K in keyof T]?: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function source(over: Overrides<SourceSpec> = {}): SourceSpec {
  return strip({ type: "kv", binding: "uploads", include: [], exclude: [], ...over });
}

function config(over: Overrides<Downpipe> = {}): Downpipe {
  return strip({ id: over.id ?? "dp1", name: over.name ?? "uploads", cadenceSeconds: DAILY, enabled: true, source: source(), ...over });
}

function state(over: Overrides<DownpipeState> = {}, cfgOver: Overrides<Downpipe> = {}): DownpipeState {
  return strip({ config: config(cfgOver), nextRunAt: NOW + DAILY * 1000, lastRunId: "r1", inFlight: false, ...over });
}

// EngineRecency is the recency slice of the REAL engine wire shape (the fields that DIFFER from the
// console's DownpipeState): lastRestoreTestAt is EPOCH MS, and restoreProven is the NESTED record
// whose `at` is EPOCH MS and whose `by` is null for the bare-token fallback. Building fixtures in this
// shape (not the flat console shape) is the whole point: it forces the test through the boundary
// mapping, so a dropped mapping makes the assertions FAIL instead of silently passing.
interface EngineRecency {
  lastRestoreTestAt?: number; // epoch ms
  lastRestoreTestOk?: boolean;
  restoreProven?: { at: number; by: string | null; method: "blind-test" | "keyless-attest"; runId: string };
  // integrityVerified is the engine's nested "archive integrity last verified" stamp (epoch ms + path),
  // set ONLY on a PASS. Including it here drives a PASS stamp through the REAL boundary mapping (so the
  // "integrity-checked <date>" read and the derived lastIntegrityVerifiedOk:true can only render if the
  // mapping flattens it), exactly as restoreProven is driven through the mapping below.
  integrityVerified?: { at: number; how: "run" | "attest" };
}

// engineState builds a downpipe in the REAL engine response shape (EngineDownpipeState) and runs it
// through the ACTUAL boundary mapping (mapEngineDownpipeState), returning the console DownpipeState a
// screen would receive from listDownpipes(). Every protection-statement assertion that involves the
// proven date or the restore-test recency goes through here, so the suite exercises engine wire ->
// mapping -> generator end to end. msAgo turns the "N days ago" helper used elsewhere into epoch ms.
function msAgo(daysAgo: number): number {
  return NOW - daysAgo * DAY;
}
// The PASS path for integrity now flows through the REAL mapping via EngineRecency.integrityVerified (the
// engine emits a nested integrityVerified { at: epoch-ms, how } stamp ONLY on a PASS, which mapEngineDownpipeState
// flattens to lastIntegrityVerifiedAt + lastIntegrityVerifiedOk:true). The IntegrityOverlay below remains ONLY
// for the states the engine wire shape genuinely CANNOT express, so the generator's integrity-clause logic can
// still be exercised for them: a FAILED check (lastIntegrityVerifiedOk:false) and an explicit overdue stamp. The
// engine never emits a failed integrity stamp (a failed run does not stamp at all), so those cases are driven by
// the overlay rather than the wire. exactOptionalPropertyTypes: the overlay is spread in only when it carries a value.
interface IntegrityOverlay {
  lastIntegrityVerifiedAt?: string;
  lastIntegrityVerifiedOk?: boolean;
}
function engineState(rec: EngineRecency = {}, cfgOver: Partial<Downpipe> = {}, integrity: IntegrityOverlay = {}): DownpipeState {
  const wire: EngineDownpipeState = {
    config: config(cfgOver),
    nextRunAt: NOW + DAILY * 1000,
    lastRunId: "r1",
    inFlight: false,
    ...(rec.lastRestoreTestAt !== undefined ? { lastRestoreTestAt: rec.lastRestoreTestAt } : {}),
    ...(rec.lastRestoreTestOk !== undefined ? { lastRestoreTestOk: rec.lastRestoreTestOk } : {}),
    ...(rec.restoreProven !== undefined ? { restoreProven: rec.restoreProven } : {}),
    ...(rec.integrityVerified !== undefined ? { integrityVerified: rec.integrityVerified } : {}),
  };
  return {
    ...mapEngineDownpipeState(wire),
    ...(integrity.lastIntegrityVerifiedAt !== undefined ? { lastIntegrityVerifiedAt: integrity.lastIntegrityVerifiedAt } : {}),
    ...(integrity.lastIntegrityVerifiedOk !== undefined ? { lastIntegrityVerifiedOk: integrity.lastIntegrityVerifiedOk } : {}),
  };
}

const R2_DEST: DestinationDescriptor = { name: "R2 dr-archive", configured: true };

// ===========================================================================
// shortDate: the plain "D Mon" form (drives the "last 7 Jun" reads).
// ===========================================================================
console.log("\n-- shortDate: plain D Mon form --");
eq("shortDate(2026-06-07) === 7 Jun", shortDate("2026-06-07T09:00:00Z"), "7 Jun");
eq("shortDate(2026-06-02) === 2 Jun", shortDate("2026-06-02T23:59:00Z"), "2 Jun");
eq("shortDate(2026-01-01) === 1 Jan", shortDate("2026-01-01T00:00:00Z"), "1 Jan");
eq("shortDate(empty) === '' (never invents a date)", shortDate(undefined), "");
eq("shortDate(invalid) === ''", shortDate("not a date"), "");

// ===========================================================================
// sourceName / sourceTypeLabel: name the source the same way map/overview do.
// ===========================================================================
console.log("\n-- source naming --");
eq("KV binding name", sourceName(source({ type: "kv", binding: "uploads" })), "uploads");
eq("KV namespace fallback", sourceName(source({ type: "kv", binding: undefined, namespaceId: "ns-123" })), "ns-123");
eq("R2 bucket fallback", sourceName(source({ type: "r2", binding: undefined, bucketName: "media" })), "media");
eq("secrets count (plural)", sourceName(source({ type: "secrets", binding: undefined, secrets: [{ name: "A", binding: "A" }, { name: "B", binding: "B" }] })), "2 secrets");
eq("secrets count (singular)", sourceName(source({ type: "secrets", binding: undefined, secrets: [{ name: "A", binding: "A" }] })), "1 secret");
eq("type label KV", sourceTypeLabel("kv"), "KV");
eq("type label Secrets", sourceTypeLabel("secrets"), "Secrets");

// ===========================================================================
// destinationFromStatus: honest destination naming.
// ===========================================================================
console.log("\n-- destinationFromStatus --");
function status(over: Partial<StatusReport> = {}): StatusReport {
  return {
    service: "downpipes", engineVersion: "test", signerConfigured: true, breakGlassConfigured: true,
    operationalConfigured: { public: true, private: true }, destConfigured: true, destKind: "r2",
    updateChannelConfigured: false, licenceConfigured: false, downpipeCount: 1, ready: true, ...over,
  };
}
{
  const r2 = destinationFromStatus(status({ destKind: "r2" }), "dr-archive");
  eq("r2 named with bucket", r2.name, "R2 dr-archive");
  eq("r2 configured true", r2.configured, true);
  eq("r2 generic without bucket", destinationFromStatus(status({ destKind: "r2" })).name, "your in-account R2 archive");
  eq("s3 named", destinationFromStatus(status({ destKind: "s3" }), "cold").name, "S3 cold");
  const none = destinationFromStatus(status({ destKind: null, destConfigured: false }));
  eq("not configured -> null name", none.name, null);
  eq("not configured -> configured false", none.configured, false);
  const unknown = destinationFromStatus(null);
  eq("status unreadable -> null name", unknown.name, null);
  eq("status unreadable -> configured null (tri-state, not false)", unknown.configured, null);
}

// ===========================================================================
// The headline example from the spec: a fully-proven daily downpipe.
// "uploads (KV) is backed up daily to R2 dr-archive, integrity-checked daily,
//  restore-tested weekly (last 7 Jun), offline restorability last proven 2 Jun by alice"
// ===========================================================================
// Built from the REAL engine wire shape (nested restoreProven { at: epoch-ms, by }, epoch-ms
// lastRestoreTestAt) driven through the boundary mapping, so the "2 Jun by alice" proven date and the
// "7 Jun" restore-test date can only render if the mapping converts the nested/epoch-ms engine fields.
// If the mapping is dropped (the contract blocker), the proven clause reads "never proven" and the
// two date assertions below FAIL.
console.log("\n-- headline example: fully covered (from the engine wire shape, through the mapping) --");
{
  const s = engineState(
    {
      lastRestoreTestAt: msAgo(2), lastRestoreTestOk: true,
      restoreProven: { at: msAgo(7), by: "alice", method: "blind-test", runId: "RUN-7" },
      // The integrity stamp now flows through the REAL engine wire shape (nested integrityVerified, epoch ms),
      // so "integrity-checked daily" can only render if the boundary mapping flattens it. A run today (how:"run").
      integrityVerified: { at: msAgo(0), how: "run" },
    },
    { cadenceSeconds: DAILY, restoreTestCadenceSeconds: WEEKLY },
  );
  const ps = protectionStatement(s, R2_DEST, NOW);
  has("names subject 'uploads (KV)'", ps.sentence, "uploads (KV)");
  has("backed up daily", ps.sentence, "backed up daily");
  has("to R2 dr-archive", ps.sentence, "to R2 dr-archive");
  has("integrity-checked daily (mapped from nested integrityVerified)", ps.sentence, "integrity-checked daily");
  has("restore-tested weekly", ps.sentence, "restore-tested weekly");
  has("offline restorability last proven (mapped from nested restoreProven)", ps.sentence, "offline restorability last proven 2 Jun by alice");
  has("restore-test last date 7 Jun (mapped from epoch-ms lastRestoreTestAt)", ps.sentence, "(last 7 Jun)");
  eq("ends with a full stop", ps.sentence.endsWith("."), true);
  eq("tone covered (proven + checked + tested + current)", ps.tone, "covered");
  // The not-covered line for a fully covered pipe states the honest floor (evidence, not guarantee).
  has("covered not-covered line states the scope floor", ps.notCovered, "not a guarantee of future recovery");
  lacks("covered statement NEVER says 'never proven'", ps.sentence, "never proven");
}

// ===========================================================================
// BOUNDARY MAPPING (the contract blocker): the engine emits restoreProven as a NESTED
// { at: epoch-ms, by, method, runId } and lastRestoreTestAt as EPOCH MS; the console reads a FLAT
// ISO lastRestoreProvenAt + lastRestoreProvenBy and an ISO lastRestoreTestAt. listDownpipes() maps
// this at the boundary; these vectors drive the REAL mapEngineDownpipeState and assert that a set
// restoreProven.at RENDERS THE PROVEN DATE, not "never". They are the regression guard: without the
// mapping the statement renders "offline restorability last proven never" though both suites are green.
// ===========================================================================
console.log("\n-- boundary mapping: nested restoreProven + epoch-ms restore-test -> rendered date --");
{
  // NEGATIVE CONTROL: a downpipe whose engine restoreProven.at IS SET must render the proven date and
  // prover, NEVER "never proven". This fails loudly if the nested -> flat mapping is dropped.
  const proven = engineState({
    restoreProven: { at: msAgo(7), by: "alice", method: "blind-test", runId: "RUN-7" },
  });
  const psProven = protectionStatement(proven, R2_DEST, NOW);
  has("a SET restoreProven.at renders the proven date (2 Jun)", psProven.sentence, "offline restorability last proven 2 Jun");
  has("the nested restoreProven.by renders as the prover", psProven.sentence, "by alice");
  lacks("a SET restoreProven.at NEVER renders 'never proven'", psProven.sentence, "offline restorability never proven");
  // And the mapped flat fields are exactly what the console contract expects (ISO string + who).
  eq("mapping flattens restoreProven.at to an ISO lastRestoreProvenAt", proven.lastRestoreProvenAt, new Date(msAgo(7)).toISOString());
  eq("mapping flattens restoreProven.by to lastRestoreProvenBy", proven.lastRestoreProvenBy, "alice");

  // The keyless-attest method with a bare-token prover (by:null) still renders the proven date, and
  // maps to an ABSENT lastRestoreProvenBy (no dangling "by ." in the sentence).
  const provenKeyless = engineState({
    restoreProven: { at: msAgo(3), by: null, method: "keyless-attest", runId: "RUN-3" },
  });
  const psKeyless = protectionStatement(provenKeyless, R2_DEST, NOW);
  has("keyless-attest proof renders the proven date (6 Jun)", psKeyless.sentence, "offline restorability last proven 6 Jun");
  lacks("a null prover maps to no dangling 'by '", psKeyless.sentence, "proven 6 Jun by ");
  eq("bare-token by:null maps to an absent lastRestoreProvenBy", provenKeyless.lastRestoreProvenBy, undefined);

  // The epoch-ms lastRestoreTestAt must map to an ISO string the overdue maths (Date.parse) reads:
  // a fresh test (2 days ago, weekly cadence) is "recently tested", not overdue.
  const tested = engineState(
    { lastRestoreTestAt: msAgo(2), lastRestoreTestOk: true },
    { cadenceSeconds: DAILY, restoreTestCadenceSeconds: WEEKLY },
  );
  const psTested = protectionStatement(tested, R2_DEST, NOW);
  has("epoch-ms lastRestoreTestAt maps to the right date (7 Jun)", psTested.sentence, "restore-tested weekly (last 7 Jun)");
  lacks("a fresh mapped restore test is not read as overdue", psTested.sentence, "restore test overdue");
  eq("mapping converts epoch-ms lastRestoreTestAt to an ISO string", tested.lastRestoreTestAt, new Date(msAgo(2)).toISOString());

  // HONEST ABSENCE through the mapping: an engine state with NO restoreProven maps to an absent
  // lastRestoreProvenAt, so the generator honestly reads "never proven" (the mapping never fabricates).
  const neverProven = engineState({ lastRestoreTestAt: msAgo(1), lastRestoreTestOk: true });
  eq("absent engine restoreProven maps to an absent lastRestoreProvenAt", neverProven.lastRestoreProvenAt, undefined);
  has("an unmapped-absent proof honestly reads 'never proven'", protectionStatement(neverProven, R2_DEST, NOW).sentence, "offline restorability never proven");

  // INTEGRITY boundary mapping (the gap this closes): the engine emits integrityVerified as a NESTED
  // { at: epoch-ms, how } stamp set ONLY on a PASS; the console reads a FLAT ISO lastIntegrityVerifiedAt +
  // a derived lastIntegrityVerifiedOk. These drive the REAL mapEngineDownpipeState and assert that a set
  // integrityVerified.at RENDERS the integrity date and a TRUE check, not "never integrity-checked". They
  // are the regression guard: without the mapping the statement renders "never integrity-checked" though
  // the engine verified integrity (the exact failure mode this change fixes), and these assertions FAIL.
  const integ = engineState({ integrityVerified: { at: msAgo(7), how: "run" } }, { cadenceSeconds: WEEKLY });
  const psInteg = protectionStatement(integ, R2_DEST, NOW);
  eq("mapping flattens integrityVerified.at to an ISO lastIntegrityVerifiedAt", integ.lastIntegrityVerifiedAt, new Date(msAgo(7)).toISOString());
  eq("a present integrity stamp derives lastIntegrityVerifiedOk:true (PASS-only on the wire)", integ.lastIntegrityVerifiedOk, true);
  has("a SET integrityVerified.at renders the integrity-checked date, not 'never'", psInteg.sentence, "integrity-checked weekly (last 2 Jun)");
  lacks("a SET integrityVerified.at NEVER renders 'never integrity-checked'", psInteg.sentence, "never integrity-checked");
  // The "attest" path maps identically (the console flattens how away; presence is the affirmative proof).
  const integAttest = engineState({ integrityVerified: { at: msAgo(2), how: "attest" } }, { cadenceSeconds: DAILY });
  eq("the attest path also derives lastIntegrityVerifiedOk:true", integAttest.lastIntegrityVerifiedOk, true);
  lacks("an attest-stamped integrity NEVER reads 'never integrity-checked'", protectionStatement(integAttest, R2_DEST, NOW).sentence, "never integrity-checked");

  // HONEST ABSENCE through the mapping: an engine state with NO integrityVerified maps to absent integrity
  // fields, so the generator honestly reads "never integrity-checked" (the mapping never fabricates a pass).
  const neverInteg = engineState({ restoreProven: { at: msAgo(3), by: "alice", method: "blind-test", runId: "RUN-3" } });
  eq("absent engine integrityVerified maps to an absent lastIntegrityVerifiedAt", neverInteg.lastIntegrityVerifiedAt, undefined);
  eq("absent engine integrityVerified maps to an absent lastIntegrityVerifiedOk", neverInteg.lastIntegrityVerifiedOk, undefined);
  has("an unmapped-absent integrity honestly reads 'never integrity-checked'", protectionStatement(neverInteg, R2_DEST, NOW).sentence, "never integrity-checked");
}

// ===========================================================================
// HONEST ABSENCE: never proven, never checked, no test.
// ===========================================================================
console.log("\n-- honest absence (never proven / never checked) --");
{
  // Backed up daily, but nothing has ever been verified or proven.
  const s = state({}, { cadenceSeconds: DAILY });
  const ps = protectionStatement(s, R2_DEST, NOW);
  has("never integrity-checked", ps.sentence, "never integrity-checked");
  has("no scheduled restore test", ps.sentence, "no scheduled restore test");
  has("offline restorability never proven", ps.sentence, "offline restorability never proven");
  // The honesty FLOOR: a backed-up-but-never-proven downpipe is NEVER "covered".
  eq("tone is unproven (NOT covered)", ps.tone, "unproven");
  ok("tone is NOT covered", ps.tone !== "covered");
  has("not-covered names the proof gap", ps.notCovered, "offline restorability has never been demonstrated");
  has("not-covered: a successful backup is not a proven restore", ps.notCovered, "not the same as a proven restore");
  lacks("never says 'verified'", ps.sentence, "verified");
}

// ===========================================================================
// A configured restore test that has NOT run yet (cadence on, no last test).
// ===========================================================================
console.log("\n-- restore test configured but not yet run --");
{
  const s = state({ lastRestoreProvenAt: undefined }, { restoreTestCadenceSeconds: WEEKLY });
  const ps = protectionStatement(s, R2_DEST, NOW);
  has("restore-tested weekly but not yet run", ps.sentence, "restore-tested weekly but not yet run");
}

// ===========================================================================
// FAILED checks are never softened.
// ===========================================================================
console.log("\n-- failed checks are never softened --");
{
  // Integrity FAILED via the overlay (no engine wire field); the proof is mapped from nested restoreProven.
  const sIntFail = engineState(
    { restoreProven: { at: msAgo(1), by: "bob", method: "blind-test", runId: "RUN-1" } },
    { restoreTestCadenceSeconds: WEEKLY },
    { lastIntegrityVerifiedAt: iso(0), lastIntegrityVerifiedOk: false },
  );
  const psI = protectionStatement(sIntFail, R2_DEST, NOW);
  has("integrity FAILED is loud", psI.sentence, "last integrity check FAILED");
  lacks("a failed integrity check does NOT read 'integrity-checked daily'", psI.sentence, "integrity-checked daily");
  ok("integrity-failed -> not covered", psI.tone !== "covered");

  // A FAILED scheduled restore test mapped from the epoch-ms engine field (lastRestoreTestAt + ok:false).
  const sTestFail = engineState(
    { lastRestoreTestAt: msAgo(1), lastRestoreTestOk: false, restoreProven: { at: msAgo(1), by: "bob", method: "blind-test", runId: "RUN-1" } },
    { restoreTestCadenceSeconds: WEEKLY },
  );
  const psT = protectionStatement(sTestFail, R2_DEST, NOW);
  has("restore test FAILED is loud", psT.sentence, "last restore test FAILED");
  ok("restore-test-failed -> not covered", psT.tone !== "covered");
}

// ===========================================================================
// OVERDUE recency reads overdue, not current.
// ===========================================================================
console.log("\n-- overdue recency --");
{
  // Daily cadence => overdue past 1.5 days. An integrity check 5 days ago is overdue (overlay).
  const s = engineState(
    { restoreProven: { at: msAgo(1), by: "carol", method: "blind-test", runId: "RUN-C" } },
    { cadenceSeconds: DAILY, restoreTestCadenceSeconds: WEEKLY },
    { lastIntegrityVerifiedAt: iso(5), lastIntegrityVerifiedOk: true },
  );
  const ps = protectionStatement(s, R2_DEST, NOW);
  has("integrity overdue read", ps.sentence, "integrity-checked but overdue");
  ok("overdue integrity -> not covered", ps.tone !== "covered");

  // A proof 30 days old (mapped from nested restoreProven.at) against a weekly restore-test cadence is
  // overdue: the overdue maths runs on the MAPPED ISO string, so this exercises the mapping end to end.
  const s2 = engineState(
    { lastRestoreTestAt: msAgo(1), lastRestoreTestOk: true, restoreProven: { at: msAgo(30), by: "dan", method: "blind-test", runId: "RUN-D" } },
    { cadenceSeconds: DAILY, restoreTestCadenceSeconds: WEEKLY },
    { lastIntegrityVerifiedAt: iso(0), lastIntegrityVerifiedOk: true },
  );
  const ps2 = protectionStatement(s2, R2_DEST, NOW);
  has("proof overdue read", ps2.sentence, "but that is overdue");
  ok("overdue proof -> not covered", ps2.tone !== "covered");
  has("not-covered names the overdue proof", ps2.notCovered, "Re-prove it");
}

// ===========================================================================
// UNCOVERED: disabled / no destination.
// ===========================================================================
console.log("\n-- uncovered: disabled / no destination --");
{
  const disabled = state({ lastRestoreProvenAt: iso(1), lastRestoreProvenBy: "x" }, { enabled: false });
  const psD = protectionStatement(disabled, R2_DEST, NOW);
  has("disabled reads NOT backed up + paused", psD.sentence, "is NOT being backed up: this downpipe is paused");
  eq("disabled tone uncovered", psD.tone, "uncovered");
  // Even with a prior proof, a paused pipe is honestly uncovered (no current backup).
  lacks("disabled does not claim covered", psD.sentence, "last proven");

  const noDest = protectionStatement(state(), { name: null, configured: false }, NOW);
  has("no destination reads NO archive destination set", noDest.sentence, "NO archive destination set");
  eq("no destination tone uncovered", noDest.tone, "uncovered");

  // status unreadable: configured null -> the destination is named as un-nameable, not faked.
  const unknownDest = protectionStatement(
    state({ lastRestoreProvenAt: iso(1), lastRestoreProvenBy: "x" }),
    { name: null, configured: null },
    NOW,
  );
  has("unknown destination is honest, not a fake bucket", unknownDest.sentence, "the engine could not be read to name it");
}

// ===========================================================================
// cadence rendering in the backup clause across presets.
// ===========================================================================
console.log("\n-- cadence rendering --");
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  has("hourly", protectionStatement(state({}, { cadenceSeconds: HOURLY }), R2_DEST, NOW).sentence, "backed up hourly");
  has("weekly", protectionStatement(state({}, { cadenceSeconds: WEEKLY }), R2_DEST, NOW).sentence, "backed up weekly");
  has("every 6h", protectionStatement(state({}, { cadenceSeconds: 21_600 }), R2_DEST, NOW).sentence, "backed up every 6h");
  has("no schedule (0 cadence)", protectionStatement(state({}, { cadenceSeconds: 0 }), R2_DEST, NOW).sentence, "backed up on no schedule");
}

// ===========================================================================
// Fleet roll-up: worst tone wins; counts are right; empty fleet is honest.
// ===========================================================================
console.log("\n-- fleet roll-up --");
{
  // The covered downpipe is built from the engine wire shape through the mapping (nested restoreProven
  // + epoch-ms restore-test), so the fleet "covered" path also depends on the boundary mapping.
  const covered = engineState(
    { lastRestoreTestAt: msAgo(1), lastRestoreTestOk: true, restoreProven: { at: msAgo(2), by: "alice", method: "blind-test", runId: "RUN-A" } },
    { id: "a", restoreTestCadenceSeconds: WEEKLY },
    { lastIntegrityVerifiedAt: iso(0), lastIntegrityVerifiedOk: true },
  );
  const unproven = state({}, { id: "b" }); // backed up, never proven
  const uncovered = state({}, { id: "c", enabled: false }); // paused

  const fp = fleetProtection([covered, unproven, uncovered], R2_DEST, NOW);
  eq("counts.covered", fp.counts.covered, 1);
  eq("counts.unproven", fp.counts.unproven, 1);
  eq("counts.uncovered", fp.counts.uncovered, 1);
  eq("fleet tone is the WORST (uncovered)", fp.tone, "uncovered");
  has("summary names total + covered", fp.summary, "3 downpipes");
  has("summary lists covered", fp.summary, "1 covered");
  has("summary lists not covered", fp.summary, "1 not covered");
  has("summary lists not proven", fp.summary, "1 backed up but not proven");
  has("not-covered counts what is not protected", fp.notCovered, "not being backed up");

  // All covered -> tone covered, and the not-covered line is the honest "all proven" floor.
  const allCovered = fleetProtection([covered, { ...covered, config: { ...covered.config, id: "a2" } }], R2_DEST, NOW);
  eq("all covered -> tone covered", allCovered.tone, "covered");
  has("all-covered states proven-not-guaranteed floor", allCovered.notCovered, "not a guarantee of future recovery");

  // One unproven among covered -> fleet is NOT covered (worst wins).
  const mixed = fleetProtection([covered, unproven], R2_DEST, NOW);
  ok("a single unproven pipe makes the fleet NOT covered", mixed.tone !== "covered");
  eq("mixed fleet tone is unproven", mixed.tone, "unproven");
  // A proof-gap-only fleet (nothing uncovered) leads "Proof gap:", not "Not covered:" (everything
  // IS being backed up), and does not restate the heading's backed-up count as a third copy.
  has("proof-gap-only fleet leads with Proof gap:", mixed.notCovered, "Proof gap:");
  lacks("proof-gap-only line never claims Not covered", mixed.notCovered, "Not covered:");
  lacks("proof-gap-only line does not restate the heading's backed-up clause", mixed.notCovered, "backed up but");
  has("proof-gap-only line keeps the honest floor", mixed.notCovered, "A successful backup is not a proven restore");

  // Empty fleet: honest "nothing protected", never a vacuous all-covered.
  const empty = fleetProtection([], R2_DEST, NOW);
  eq("empty fleet tone uncovered", empty.tone, "uncovered");
  has("empty fleet summary is honest", empty.summary, "No downpipes are configured");
  has("empty fleet not-covered is blunt", empty.notCovered, "no backup routes at all");
  ok("empty fleet is NOT covered", empty.tone !== "covered");
}

// ===========================================================================
// The prover identity is escaped/echoed verbatim (a name with spaces survives).
// ===========================================================================
console.log("\n-- prover identity --");
{
  // The prover email is mapped from the nested restoreProven.by, so an email identity survives the mapping.
  const s = engineState(
    { lastRestoreTestAt: msAgo(1), lastRestoreTestOk: true, restoreProven: { at: msAgo(2), by: "alice@example.com", method: "blind-test", runId: "RUN-A" } },
    { restoreTestCadenceSeconds: WEEKLY },
    { lastIntegrityVerifiedAt: iso(0), lastIntegrityVerifiedOk: true },
  );
  has("proven by an email identity", protectionStatement(s, R2_DEST, NOW).sentence, "by alice@example.com");
  // A proof whose engine restoreProven.by is null (the bare-token fallback) maps to an absent prover and
  // still renders honestly (no dangling "by"), proving the null -> absent mapping at the boundary.
  const sNoBy = engineState(
    { lastRestoreTestAt: msAgo(1), lastRestoreTestOk: true, restoreProven: { at: msAgo(2), by: null, method: "keyless-attest", runId: "RUN-A" } },
    { restoreTestCadenceSeconds: WEEKLY },
    { lastIntegrityVerifiedAt: iso(0), lastIntegrityVerifiedOk: true },
  );
  const psNoBy = protectionStatement(sNoBy, R2_DEST, NOW);
  has("proven without a prover still reads cleanly", psNoBy.sentence, "last proven 7 Jun");
  lacks("no dangling ' by .' when prover absent", psNoBy.sentence, "proven 7 Jun by ");
}

// ---------------------------------------------------------------------------
// A PRESENT but UNPARSEABLE recency stamp must never read as healthy.
//
// The bug: Date.parse of a corrupt stamp yields NaN, isOverdue returned false for NaN ("do not invent
// staleness on a bad parse"), and the clause therefore fell through to its SATISFACTORY branch. So a
// downpipe whose integrity/restore-test/proven stamps were garbage rendered "integrity-checked daily",
// "restore-tested", "offline restorability last proven" and a tone of "covered": the console asserted
// protection off a value nobody can read. That is the single most dangerous class of false state, since
// it is indistinguishable from real health.
//
// The fix: an unreadable stamp is its own read. It is never satisfactory, so the tone can never be
// "covered"; it stays everHappened (the engine did record SOMETHING), so it does not collapse to a false
// "never" either. The malformed value itself is never rendered.
// ---------------------------------------------------------------------------
{
  console.log("\nunreadable recency stamps never read as covered");
  const GARBAGE = "not-a-date";

  const badIntegrity = state({ lastIntegrityVerifiedAt: GARBAGE, lastIntegrityVerifiedOk: true, lastRestoreTestAt: iso(1), lastRestoreTestOk: true, lastRestoreProvenAt: iso(1), lastRestoreProvenBy: "alice" });
  const psI = protectionStatement(badIntegrity, R2_DEST, NOW);
  has("unreadable integrity stamp is named", psI.sentence, "integrity-checked but the engine's date for it cannot be read");
  lacks("unreadable integrity stamp never claims a cadence pass", psI.sentence, "integrity-checked daily");
  ok("unreadable integrity stamp forbids the covered tone", psI.tone !== "covered");
  lacks("the malformed value is never rendered", psI.sentence, GARBAGE);

  const badTest = state({ lastIntegrityVerifiedAt: iso(1), lastIntegrityVerifiedOk: true, lastRestoreTestAt: GARBAGE, lastRestoreTestOk: true, lastRestoreProvenAt: iso(1), lastRestoreProvenBy: "alice" }, { restoreTestCadenceSeconds: WEEKLY });
  const psT = protectionStatement(badTest, R2_DEST, NOW);
  has("unreadable restore-test stamp is named", psT.sentence, "restore-tested but the engine's date for it cannot be read");
  ok("unreadable restore-test stamp forbids the covered tone", psT.tone !== "covered");
  lacks("the malformed restore-test value is never rendered", psT.sentence, GARBAGE);

  const badProven = state({ lastIntegrityVerifiedAt: iso(1), lastIntegrityVerifiedOk: true, lastRestoreTestAt: iso(1), lastRestoreTestOk: true, lastRestoreProvenAt: GARBAGE, lastRestoreProvenBy: "alice" });
  const psP = protectionStatement(badProven, R2_DEST, NOW);
  has("unreadable proven stamp is named", psP.sentence, "offline restorability recorded as proven but the engine's date for it cannot be read");
  ok("unreadable proven stamp forbids the covered tone", psP.tone !== "covered");
  eq("an unreadable proof is partial, not a false 'never proven'", psP.tone, "partial");
  lacks("an unreadable proof never reads 'never proven'", psP.sentence, "never proven");
  lacks("the malformed proven value is never rendered", psP.sentence, GARBAGE);

  // Negative control: the SAME fixture with readable stamps still reads covered, so the new branch has
  // not simply broken the healthy path.
  const good = state({ lastIntegrityVerifiedAt: iso(1), lastIntegrityVerifiedOk: true, lastRestoreTestAt: iso(1), lastRestoreTestOk: true, lastRestoreProvenAt: iso(1), lastRestoreProvenBy: "alice" });
  eq("negative control: readable stamps still read covered", protectionStatement(good, R2_DEST, NOW).tone, "covered");
}

// ---------------------------------------------------------------------------
// AN UNREADABLE DESTINATION READ IS NOT A QUIET YES. destinationFromStatus(null) returns
// configured: null, and only `false` was caught, so `null` fell through to the backup clause and could
// reach tone "covered". Every consumer reads `tone` and none renders `sentence`, so the caveat that was
// already in the sentence could not reach anybody: the executive card rendered "Are we protected? Yes"
// in the reassurance hue over a status read that never happened. Same rule as G303 above, applied to the
// destination rather than to a recency stamp.
// ---------------------------------------------------------------------------
{
  console.log("\nan unreadable destination read never reads covered");
  const UNREAD = destinationFromStatus(null);
  eq("the fixture really is the unread state", UNREAD.configured, null);

  const good = state({ lastIntegrityVerifiedAt: iso(1), lastIntegrityVerifiedOk: true, lastRestoreTestAt: iso(1), lastRestoreTestOk: true, lastRestoreProvenAt: iso(1), lastRestoreProvenBy: "alice" });
  const ps = protectionStatement(good, UNREAD, NOW);
  ok("an unread destination forbids the covered tone", ps.tone !== "covered");
  eq("it is partial, not a false 'not being backed up'", ps.tone, "partial");
  has("the sentence still names what could not be read", ps.sentence, "the engine could not be read to name it");
  has("the not-covered line names the read, not a missing destination", ps.notCovered, "the engine could not be read");
  lacks("it never claims the destination is absent", ps.notCovered, "no archive destination is configured");

  // The fleet roll-up is the line a customer actually reads on the Overview, so assert the false
  // all-clear is gone there too, not only on the per-downpipe tone.
  const fleet = fleetProtection([good], UNREAD, NOW);
  lacks("the fleet line no longer claims everything is proven and current", fleet.notCovered, "Every downpipe is backed up and its restorability is proven and current");
  ok("the fleet tone is not covered either", fleet.tone !== "covered");

  // Negative control: the SAME downpipe against a READ destination still reads covered, so the new
  // branch has not simply broken the healthy path.
  eq("negative control: a read destination still reads covered", protectionStatement(good, R2_DEST, NOW).tone, "covered");
  // And a destination read that answered "none configured" keeps its own, stronger verdict.
  eq("negative control: a known-absent destination is still uncovered", protectionStatement(good, destinationFromStatus(status({ destKind: null, destConfigured: false })), NOW).tone, "uncovered");
}

// ---------------------------------------------------------------------------
console.log("");
if (checks.failures > 0) {
  console.log(`VALIDATE-PROTECTION-STATEMENT: ${checks.failures} FAILED`);
  process.exit(1);
}
console.log("VALIDATE-PROTECTION-STATEMENT VECTORS PASS");
