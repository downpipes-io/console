// CONSOLE-side coverage for four support-diagnostics defects, each with the same shape: a fix that lands on one
// producer of a shared classification while a sibling producer of the same value keeps the old behaviour. So
// each test below drives every producer of the value it checks, through the real entry point, over bytes the
// engine actually emits.
//
//   THE EDITOR's discovery read (buildCfConfigSection, which editor-upsert calls unconditionally on every
//        cf-config editor open) is driven directly, alongside its wizard twin: a CLEARED discovery token must not
//        read as "this engine predates the feature, update the engine" about a healthy, current engine, and must
//        not coalesce with the state that genuinely means it.
//   THE CONSOLE'S OWN 500 (worker.ts last-resort handler: status 500 + the frozen fault header) is driven through
//        the real transport, and asserted not byte-identical to an engine 5xx at any of the three seams that
//        classify it: the feature probe, the block-error transport row, and the wizard's readiness poll.
//   EVERY VENDOR in the shipped integrations catalogue is driven through the real mark renderer and asserted to
//        record NOTHING: the guard this once fired on read a console-side constant, `vendor-mark`, which is no
//        longer a member of the vocabulary, and this test is what keeps it that way.
//   THE CORRUPT-STAMP x CADENCE MATRIX is driven through mapDownpipesToFlows AND freshnessFor, the two surfaces
//        that judge freshness, and asserted to make no green claim on a run this build cannot date.
//
// Run with `node test/validate-support-posture-gaps-r5.ts`.

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import {
  cfRediscoverThrowClass,
  featureOutcomeForError,
  reset as resetRing,
  setActiveScreen,
  snapshot,
} from "../src/lib/client-diag/ring.ts";
import { EngineClient } from "../src/lib/api/client.ts";
import { Transport } from "../src/lib/api/client-transport.ts";
import { listRoles } from "../src/lib/api/client-rbac.ts";
import { blockError } from "../src/components/error-view.ts";
import { engineFaultOutcome } from "../src/screens/onboarding/steps.ts";
import { buildCfConfigSection } from "../src/screens/sources-downpipes/editor-cf-config-section.ts";
import { integrationMark } from "../src/screens/integrations/marks.ts";
import { CATALOGUE } from "../src/screens/integrations/catalogue.ts";
import { mapDownpipesToFlows } from "../src/screens/map/data.ts";
import { summariseFleet } from "../src/screens/overview/fleet-data.ts";
import { freshnessFor } from "../src/screens/sources-downpipes/helpers.ts";
import { CONSOLE_ORIGIN_FAULT, CONSOLE_ORIGIN_FAULT_HEADER } from "../src/lib/errors.ts";
import { CLIENT_DIAG_FIELD_FAMILIES, type ClientDiagnosticRecord } from "../src/lib/client-diag/vocab.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq<T>(label: string, got: T, want: T): void {
  const pass = got === want;
  console.log(pass ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!pass) failures++;
}

const rows = (): ClientDiagnosticRecord[] => snapshot().records;
const rowsOf = (kind: string): ClientDiagnosticRecord[] => rows().filter((r) => r.kind === kind);

const realFetch = globalThis.fetch;
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input instanceof Request ? input.url : input), init))) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------------------------------------
// THE EDITOR is a second producer of this classification, alongside the wizard: its discovery read must gate
// on tokenPresent the same way.
// ---------------------------------------------------------------------------------------------------------
async function g243(): Promise<void> {
  console.log("\n-- a cleared discovery token is not an out-of-date engine (the EDITOR twin) --");
  setActiveScreen("/downpipes");

  // The editor is reached with a LIVE cf-config downpipe (this is the "cf-config backups capture nothing new"
  // ticket: the downpipe has been running for weeks). buildCfConfigSection is called unconditionally on every open
  // (editor-upsert.ts:123), and it re-reads the catalogue with the real EngineClient.
  const existing = {
    id: "dp-cf",
    name: "cf",
    enabled: true,
    cadenceSeconds: 86400,
    source: { type: "cf-config", accountId: "acct", include: ["dns"], cfConfigMode: "manual" },
  };
  const openEditor = async (discovery: unknown): Promise<void> => {
    stubFetch(() => new Response(JSON.stringify(discovery), { status: 200, headers: { "content-type": "application/json" } }));
    const engine = new EngineClient("https://engine.example");
    buildCfConfigSection(engine, existing as never, undefined, true);
    // the section's discovery read is a floating promise; let its .then run
    await new Promise((r) => setTimeout(r, 0));
    globalThis.fetch = realFetch;
  };
  const BOUND = { kv: [], r2: [], d1: [], secrets: [] };

  // THE TOKEN IS CLEARED. setDiscoveryToken({token:null}) is a real owner control (the engine deletes the key
  // and audits discovery-token-cleared); existing downpipes are untouched. GET /sources/discover then takes the
  // no-token branch and returns THESE EXACT BYTES (engine router-discovery.ts): the early return, with no
  // capability fields at all. The engine is healthy and current, and it files its own no-token discovery
  // observation server-side.
  resetRing();
  await openEditor({ bound: BOUND, tokenPresent: false });
  eq("a CLEARED discovery token records NOTHING in the editor (never 'update the engine')", rowsOf("catalogue-degraded").length, 0);

  // THE ONLY STATE THE MEMBER MEANS. A token IS stored, so the engine walked the token path, and the catalogue
  // it returns on that path is a STATIC COMPILED-IN list: an empty one can only mean this engine predates the
  // feature. Remedy: update the engine.
  resetRing();
  await openEditor({ bound: BOUND, tokenPresent: true, accounts: [{ accountId: "a", accountName: "A", zones: [] }], cfConfigSurfaces: [] });
  eq("an OLD engine (token present, empty catalogue) records cf-catalogue-empty", rowsOf("catalogue-degraded")[0]?.catalogueClass, "cf-catalogue-empty");
  eq("...and exactly one row", rowsOf("catalogue-degraded").length, 1);

  // AN ENGINE TOO OLD TO REPORT tokenPresent AT ALL. That is account-tier skew, which token-source-tier already
  // carries; it is not a catalogue fault and this screen must not claim one.
  resetRing();
  await openEditor({ bound: BOUND });
  eq("(NOISE): an engine that does not report tokenPresent records NOTHING here", rowsOf("catalogue-degraded").length, 0);

  // THE COALESCING TO GUARD AGAINST: both states into ONE ring, which would happen if they were identical on
  // every tuple-key field (kind, screen, catalogueClass) and merged into a single count of 2 -- support could then
  // not tell "update the engine" from "the owner cleared the token", and the row would name the wrong remedy for
  // the second.
  resetRing();
  await openEditor({ bound: BOUND, tokenPresent: true, accounts: [], cfConfigSurfaces: [] });
  await openEditor({ bound: BOUND, tokenPresent: false });
  eq("the old engine and the cleared token are ONE row, not one coalesced count of two", rowsOf("catalogue-degraded").length, 1);
  eq("...and the count belongs to the old engine alone", rowsOf("catalogue-degraded")[0]?.count, 1);

  // NOISE: a healthy, current engine with a live catalogue records nothing at all, however often the editor opens.
  resetRing();
  const surfaces = [{ id: "dns", label: "DNS", category: "zone", scope: "zone" }];
  await openEditor({ bound: BOUND, tokenPresent: true, accounts: [{ accountId: "a", accountName: "A", zones: [] }], cfConfigSurfaces: surfaces });
  await openEditor({ bound: BOUND, tokenPresent: true, accounts: [{ accountId: "a", accountName: "A", zones: [] }], cfConfigSurfaces: surfaces });
  eq("(NOISE): two opens against a healthy engine record NOTHING", rowsOf("catalogue-degraded").length, 0);
}

// ---------------------------------------------------------------------------------------------------------
// THE CONSOLE'S OWN 500 must not read as an engine that received the request and refused it.
// ---------------------------------------------------------------------------------------------------------
async function g250(): Promise<void> {
  console.log("\n-- a console-origin 500 is not a broken engine --");
  setActiveScreen("/access/security");

  // The exact response the console's own worker manufactures (worker.ts last-resort handler): status 500, the
  // frozen fault header, the plain-text body. It is what the browser sees when the proxied dispatch throws, and
  // when the BOUND ENGINE service binding's fetch REJECTS (the engine worker deleted, throwing on boot, or over its
  // resource limits). The engine received nothing.
  const consoleOwn500 = (): Response => new Response("internal error", { status: 500, headers: { [CONSOLE_ORIGIN_FAULT_HEADER]: CONSOLE_ORIGIN_FAULT } });
  // A 5xx THE ENGINE ITSELF ANSWERED carries no such header: it saw the call, and its refusal is in its own logs.
  const engineOwn500 = (): Response => new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } });

  const thrown = async (r: () => Response): Promise<unknown> => {
    stubFetch(() => r());
    try {
      await listRoles(new Transport("https://engine.example"));
      throw new Error("expected a throw");
    } catch (e) {
      return e;
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  // THE FEATURE PROBE, the row support reads for "is this feature broken or simply not built".
  const consoleErr = await thrown(consoleOwn500);
  const engineErr = await thrown(engineOwn500);
  eq("the CONSOLE'S OWN 500 is console-origin-fault, not server-error (the engine is not broken: nothing reached it)", featureOutcomeForError(consoleErr), "console-origin-fault");
  eq("a 5xx THE ENGINE answered is still server-error (and only here is the remedy the engine's logs)", featureOutcomeForError(engineErr), "server-error");
  ok("the two 500s are NOT the same verdict", featureOutcomeForError(consoleErr) !== featureOutcomeForError(engineErr));

  // ...and they do not coalesce in the ring either: the tuple key must separate them, or the count is one number
  // over two opposite remedies.
  resetRing();
  const probe = await import("../src/lib/client-diag/ring.ts");
  for (const e of [consoleErr, engineErr]) {
    const outcome = featureOutcomeForError(e);
    if (outcome !== null) probe.recordFeatureProbe("roles-table", outcome);
  }
  eq("a console-origin 500 and an engine 500 on the same screen are TWO rows", rowsOf("feature-probe").length, 2);

  // THE PACK MUST NOT CONTRADICT ITSELF. The RESPONSE seam reads the header and records the engine-call row as
  // {network, transport} (no request reached the engine); the THROW seam must agree, not say server-error, since
  // it is the throw-derived row support reads.
  resetRing();
  await thrown(consoleOwn500);
  const call = rowsOf("engine-call")[0];
  eq("the engine-call row for a console-origin 500 is network/transport (the engine did not answer it)", `${call?.httpClass}/${call?.faultClass}`, "network/transport");
  resetRing();
  await thrown(engineOwn500);
  const call2 = rowsOf("engine-call")[0];
  eq("the engine-call row for an ENGINE 5xx is 5xx/server (it did answer it)", `${call2?.httpClass}/${call2?.faultClass}`, "5xx/server");

  // THE BLOCK ERROR, which every screen renders on a failed read and which records its own transport row, must
  // not fall through to `server-error`: that would be the same fabricated engine fault by another door.
  resetRing();
  blockError(consoleErr, () => {});
  eq("blockError records transport console-origin-fault, not server-error", rowsOf("transport-fault")[0]?.transportClass, "console-origin-fault");
  resetRing();
  blockError(engineErr, () => {});
  eq("NOISE: blockError on an ENGINE 5xx still records server-error", rowsOf("transport-fault")[0]?.transportClass, "server-error");

  // THE ONBOARDING WIZARD's readiness poll classifies by the same kind. `engine-not-ok` means "the engine
  // answered and refused, so read its logs"; there is no request in them to find.
  eq("the wizard reads a console-origin 500 as console-origin-fault, not engine-not-ok", engineFaultOutcome(consoleErr), "console-origin-fault");
  eq("NOISE: the wizard still reads an ENGINE 5xx as engine-not-ok", engineFaultOutcome(engineErr), "engine-not-ok");

  // THE CF REDISCOVER throw classifier reads the same kinds. With no status in the message it would fall to
  // cf-rediscover-transport, which asserts nothing answered at all: this console answered.
  eq("a console-origin 500 on the rediscover is the residual, not a transport claim", cfRediscoverThrowClass(consoleErr), "cf-rediscover-failed");

  // REDACTION: the throw carries the frozen product token and nothing from the body.
  ok("REDACTION: the thrown message carries the frozen token only, never the body", String((consoleErr as Error).message).includes(CONSOLE_ORIGIN_FAULT) && !String((consoleErr as Error).message).includes("internal error"));
}

// ---------------------------------------------------------------------------------------------------------
// the fieldFamily whose only producer reads a CONSOLE-SIDE CONSTANT.
// ---------------------------------------------------------------------------------------------------------
function g289(): void {
  console.log("\n-- a contract-drift family the engine could never populate --");
  setActiveScreen("/integrations");

  // THE WHOLE SHIPPED CATALOGUE, through the REAL renderer, exactly as the three production callers do (they all
  // pass vendor.mark off CATALOGUE). Not one row: the guard is unsatisfiable for every engine version, every
  // account and every render, because the engine does not name vendors. That is why `vendor-mark` is not a
  // member of the vocabulary.
  resetRing();
  for (const v of CATALOGUE) integrationMark(v.mark, v.name, 34);
  eq("every vendor in the shipped catalogue renders and records NOTHING", rowsOf("contract-skew").length, 0);
  ok("the catalogue is not empty (the assertion above is about the renderer, not about zero vendors)", CATALOGUE.length > 0);
  ok("`vendor-mark` is not a member of the contract-skew field families", !(CLIENT_DIAG_FIELD_FAMILIES as readonly string[]).includes("vendor-mark"));
}

// ---------------------------------------------------------------------------------------------------------
// the corrupt stamp x cadence matrix, on both surfaces that judge freshness.
// ---------------------------------------------------------------------------------------------------------
function g298(): void {
  console.log("\n-- no green claim on a backup this build cannot date --");
  setActiveScreen("/downpipes");

  const NOW = Date.parse("2026-07-13T00:00:00.000Z");
  const GOOD = "2026-07-12T23:00:00.000Z"; // an hour ago
  const OLD = "2026-05-01T00:00:00.000Z"; // 73 days ago
  const CORRUPT = "not-a-date";
  const STATUS = {
    service: "downpipes", engineVersion: "test", signerConfigured: true, breakGlassConfigured: true,
    operationalConfigured: { public: true, private: true }, destConfigured: true, destKind: "r2",
    updateChannelConfigured: false, licenceConfigured: false, downpipeCount: 1, ready: true,
  };

  // ALL THREE SURFACES THAT JUDGE STALENESS, one call each, exactly as the screens make them: the map, the
  // downpipes table, and the Overview fleet roll-up. THE THIRD IS THE SIBLING THE FIX MUST NOT MISS: fleet-data
  // did not even coerce the cadence, it passed the raw wire value into the freshness rule, where a non-number
  // simply failed `> 0` and disabled the staleness test.
  //
  // The payload arrives as JSON off the wire (JSON.parse of the engine's bytes, which is what the transport hands
  // the screens), so a version-skewed or corrupt engine can put any shape in cadenceSeconds.
  // The cadence is injected as RAW JSON TEXT and the config is JSON.parse-d, because that is the only way the
  // non-finite shape can be tested honestly: JSON.stringify(Infinity) is `null`, so a test that builds the object
  // in JS and serialises it can never produce the state a real engine puts on the wire (JSON.parse("1e999") is
  // Infinity). "" omits the field entirely, which is the older-engine state.
  const drive = (lastGoodAt: string, cadenceJson: string): { map: string; table: string; fleet: string; anomalies: string[] } => {
    resetRing();
    const cadenceField = cadenceJson === "" ? "" : `"cadenceSeconds":${cadenceJson},`;
    const dp = JSON.parse(
      `{"config":{"id":"dp","name":"dp","enabled":true,${cadenceField}"source":{"type":"kv","binding":"KV","include":[],"exclude":[]}},"nextRunAt":${NOW + 3600_000},"lastRunId":"r1","inFlight":false}`,
    );
    const ring = JSON.parse(`[{"runId":"r1","status":"ok","startedAt":${JSON.stringify(lastGoodAt)},"finishedAt":${JSON.stringify(lastGoodAt)}}]`);
    const flows = mapDownpipesToFlows({
      downpipes: { ok: true, value: [dp] },
      history: { ok: true, value: { dp: ring } },
      status: { ok: true, value: STATUS },
      destination: { ok: false, error: new Error("not loaded") },
    } as never, NOW);
    const fresh = freshnessFor(dp as never, { latest: ring[0], lastGood: ring.find((e: { status: string }) => e.status === "ok") }, NOW);
    const fleet = summariseFleet({
      health: { ok: true, value: { ok: true } },
      status: { ok: true, value: STATUS },
      licence: { ok: false, error: new Error("not loaded") },
      updates: { ok: false, error: new Error("not loaded") },
      history: { ok: true, value: { dp: ring } },
      downpipes: { ok: true, value: [dp] },
      drillEvidence: { ok: false, error: new Error("not loaded") },
      audit: { ok: false, error: new Error("not loaded") },
    } as never, NOW);
    const anomalies = [...new Set(rowsOf("wire-anomaly").map((r) => `${r.fieldClass}/${r.anomaly}`))].sort();
    return { map: String(flows[0]?.status), table: fresh.label, fleet: String(fleet.rows[0]?.freshness), anomalies };
  };

  // THE CONTROL. A readable stamp, a readable cadence, an hour old: green on every surface, empty ring.
  const a = drive(GOOD, "86400");
  eq("a fresh run reads healthy on the map", a.map, "healthy");
  eq("...and Ok in the table", a.table, "Ok");
  eq("...and healthy on the Overview fleet", a.fleet, "healthy");
  eq("(NOISE): ...and records NOTHING", a.anomalies.length, 0);

  // THE CONTROL FOR STALENESS. An old stamp with a usable cadence is loud on every surface, and still silent in
  // the ring: staleness is a product state, not a wire anomaly.
  const b = drive(OLD, "86400");
  eq("a 73-day-old run reads stale on the map", b.map, "stale");
  eq("...and Stale in the table", b.table, "Stale");
  eq("...and stale on the Overview fleet", b.fleet, "stale");
  eq("(NOISE): ...and records NOTHING", b.anomalies.length, 0);

  // THE CORRUPT STAMP, ACROSS EVERY CADENCE SHAPE. A stamp check sitting INSIDE `cadenceSeconds > 0` would let an
  // unreadable stamp arriving with an unusable cadence skip the test, fall through to "healthy", and render green
  // with an EMPTY PACK: byte-identical to the control. The stamp must be tested first, on every one of them.
  for (const [name, cadence] of [["usable cadence", "86400"], ["cadence is a string", "\"daily\""], ["cadence is null", "null"], ["cadence is 0", "0"]] as Array<[string, string]>) {
    const r = drive(CORRUPT, cadence);
    ok(`${name}: a stamp this build cannot read makes NO green claim on the map (got ${r.map})`, r.map !== "healthy");
    ok(`${name}: ...nor in the table (got ${r.table})`, r.table !== "Ok");
    ok(`${name}: ...nor on the Overview fleet (got ${r.fleet})`, r.fleet !== "healthy");
    ok(`${name}: ...and the pack says the stamp was unreadable (got ${JSON.stringify(r.anomalies)})`, r.anomalies.includes("timestamp/unparseable"));
  }

  // THE CADENCE ITSELF NEEDS ITS OWN RECORDER. A cadence that arrives in a shape this build cannot read must not
  // be silently nulled, because a null cadence DISABLES THE STALENESS TEST: a downpipe whose last good run was 73
  // days ago would read healthy on the map, "Ok" in the table and healthy on the Overview, with an EMPTY PACK,
  // because a version-skewed engine sent the wrong shape.
  const g = drive(OLD, "\"daily\"");
  ok("an unreadable CADENCE is recorded, not silently nulled", g.anomalies.includes("cadence/non-finite"));
  // The OVERFLOW shape, and it must come off the wire to count: JSON.parse("1e999") is Infinity, which is exactly
  // how a non-finite number reaches a browser from an engine (NaN cannot be serialised at all, so it is not a wire
  // state and is not tested as one).
  const inf = drive(OLD, "1e999");
  ok("a cadence that overflows to Infinity on the wire is recorded as non-finite", inf.anomalies.includes("cadence/non-finite"));
  const missing = drive(OLD, "");
  ok("a MISSING cadence is its own anomaly (an engine that does not send the field)", missing.anomalies.includes("cadence/missing"));
  ok("a missing cadence and an unreadable one are DIFFERENT rows", !missing.anomalies.includes("cadence/non-finite") && !g.anomalies.includes("cadence/missing"));

  // The three surfaces all go through the ONE seam, so the row is written wherever the customer is looking. With
  // no usable cadence there IS no staleness verdict to reach, and the pack must say so instead of the surfaces
  // quietly implying everything is fine.
  ok("the cadence row rides from the map/table/fleet drive, not from a hand-posted record", g.anomalies.length > 0);

  // REDACTION: two closed enums, and the corrupt values are nowhere in the pack.
  resetRing();
  drive(CORRUPT, "\"daily;drop-table\"");
  const serialised = JSON.stringify(snapshot());
  ok("REDACTION: the corrupt stamp never rides", !serialised.includes(CORRUPT));
  ok("REDACTION: the corrupt cadence never rides", !serialised.includes("drop-table"));
}

async function main(): Promise<void> {
  await g243();
  await g250();
  g289();
  g298();
  console.log(failures === 0 ? "\nCONSOLE SUPPORT-POSTURE CHECKS: ALL PASS" : `\nCONSOLE SUPPORT-POSTURE CHECKS: ${failures} FAILED`);
  verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  process.exit(failures === 0 ? 0 : 1);
}

void main();
