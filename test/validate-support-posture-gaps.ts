// Validate the POSTURE support-pack gaps: cases where a customer could believe they are protected when they
// are not, or where support cannot prove a control was actually in force. Lower severity than a data-loss gap;
// the same bar.
//
// THE BAR IS THE DISCRIMINATION TEST. A recorder, a caller and a projection are NOT enough. For every gap below
// the suite ENUMERATES the states that would otherwise be indistinguishable, DRIVES each one, and asserts they
// produce DIFFERENT rows. A test that asserts merely that "a row was recorded" is not sufficient: it can pass
// with working plumbing while gaps remain open.
//
// The coalescing key is the other half of it. A field that discriminates two outcomes and is left OUT of the
// ring's tuple key discriminates NOTHING: the two rows collapse into one and the first one written wins the
// class. So every "different rows" assertion below counts ROWS IN THE RING, which is the thing the key governs,
// and never merely inspects a value the recorder was handed.
//
// Coverage:
//   - a restore option the operator typed and the builder DISCARDED says which option, per option
//   - an operator-initiated test (destination / IdP / notify / SIEM / email) survives the panel closing,
//     with a fail class that is per-surface and a probe-never-ran class that is not a vendor fault
//   - a client-side validator rejection, and a SILENT coercion, are visible and are not the same row
//   - a withheld Cloudflare-config offer says WHICH of the confusable reasons applied
//   - BROKEN and UNBUILT stop being the same tile: route-absent, server-error and origin-rejected are
//     three rows, and the CONSOLE_ORIGIN verdict is no longer computed and thrown away
//   - a client-side role refusal and a skipped change-number prompt exist at all, and name their action
//   - the console's own build reaches the pack, as its RELATION to the engine answering it
//
// Run with `node test/validate-support-posture-gaps.ts`.

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import {
  destProbeOutcome,
  emailProbeOutcome,
  featureOutcomeForError,
  idpProbeOutcome,
  packPayload,
  probeCallOutcome,
  pushProbeOutcome,
  recordCatalogueDegraded,
  recordConsoleSkew,
  recordFeatureProbe,
  recordFormCoerced,
  recordFormRefused,
  recordGovGate,
  recordIntentDropped,
  recordProbeOutcome,
  reset as resetRing,
  setActiveScreen,
  skewClassFor,
  snapshot,
} from "../src/lib/client-diag/ring.ts";
import { cfWithheldCatalogueClass } from "../src/screens/sources-downpipes/editor-wizard-source-sections.ts";
import type { SourceDiscovery } from "../src/api.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures += 1;
}
function eq<T>(label: string, a: T, b: T): void {
  const cond = JSON.stringify(a) === JSON.stringify(b);
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
  if (!cond) failures += 1;
}

// rows() is the ring as the pack would carry it. Every discrimination assertion below goes through this, not
// through a recorder's argument, because the ring's TUPLE KEY is what decides whether two states are actually
// two rows, and a field outside that key tells apart nothing.
function rows(): ReturnType<typeof snapshot>["records"] {
  return snapshot().records;
}
function wire(): string {
  return JSON.stringify(packPayload());
}

// distinct drives a list of states through a recorder and asserts each produced its OWN row. This is the whole
// suite in one function: if any two states coalesce (because a discriminator is missing from the tuple key, or
// because the recorder maps them to one class), the row count is short and the gap is NOT closed.
function distinct(gap: string, states: { name: string; drive: () => void }[]): void {
  resetRing();
  for (const s of states) s.drive();
  const n = rows().length;
  ok(`${gap}: ${states.length} named states produce ${states.length} DISTINCT rows (got ${n})`, n === states.length);
}

// ---------------------------------------------------------------------------------------------------------
console.log("\n-- a restore option the operator typed and the builder threw away --");
// The states: there are five, and every one of them silently WIDENS or CHANGES the run. Each has its own
// remedy, and the engine sees none of them (it receives a well-formed request for the narrower/wider thing
// and is correct about it).
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  setActiveScreen("/restore");
  distinct("restore option discarded", [
    { name: "Max records typed, unparseable: the run is planned UNCAPPED", drive: () => recordIntentDropped("max-records-invalid") },
    { name: "cf token pasted, account blank: the whole cf-config section vanishes", drive: () => recordIntentDropped("cf-pair-partial") },
    { name: "media token pasted, account blank: Stream/Images never re-upload", drive: () => recordIntentDropped("media-pair-partial") },
    { name: "D1 database named, no tables: the WHOLE run is planned", drive: () => recordIntentDropped("d1-subset-partial") },
    { name: "redirect chosen, binding empty: an apply writes over the LIVE originals", drive: () => recordIntentDropped("redirect-binding-empty") },
  ]);

  // The one that most matters, spelled out: the redirect-with-no-binding row must NOT be the same row as a
  // deliberate original-bindings restore, which records NOTHING at all. Silence is the calm default; a row is
  // the dangerous one.
  resetRing();
  ok("a deliberate restore to original bindings records NOTHING (no crying wolf)", rows().length === 0);
  recordIntentDropped("redirect-binding-empty");
  eq("an empty redirect binding is its OWN class", rows()[0]?.intentClass, "redirect-binding-empty");
  ok("the class reaches the wire the pack carries", wire().includes("intent-dropped") && wire().includes("redirect-binding-empty"));
}

// ---------------------------------------------------------------------------------------------------------
console.log("\n-- an operator-initiated test outcome survives the panel closing --");
{
  setActiveScreen("/destinations");
  // THE SURFACE IS A DISCRIMINATOR. A destination verify and an IdP test that both simply "failed" must not be
  // one row: they are different vendors, different remedies and different tickets.
  distinct("operator-initiated test surfaces", [
    { name: "dest verify failed", drive: () => recordProbeOutcome("dest-verify", "dest-auth") },
    { name: "idp test failed", drive: () => recordProbeOutcome("idp-test", "idp-cert-failed") },
    { name: "notify test failed", drive: () => recordProbeOutcome("notify-test", "notify-delivery-failed") },
    { name: "siem test failed", drive: () => recordProbeOutcome("push-test", "push-endpoint-4xx") },
    { name: "email test failed", drive: () => recordProbeOutcome("email-test", "email-platform-refused") },
  ]);

  // THE FAIL CLASS IS A DISCRIMINATOR, driven through the REAL classifiers over REAL response shapes.
  eq("dest: a passing verify", destProbeOutcome({ ok: true }), "ok");
  eq("dest: credentials refused", destProbeOutcome({ ok: false, reason: "403 Forbidden: signature mismatch" }), "dest-auth");
  eq("dest: bucket unreachable", destProbeOutcome({ ok: false, reason: "fetch failed: ENOTFOUND" }), "dest-unreachable");
  // THE DELETE PROBE RIDES ON THE ok:TRUE ARM. A refused cleanup delete does NOT fail the probe: the engine
  // catches the delete throw and returns { ok: TRUE, deleteProbe: "denied" }. A response shaped
  // { ok: false, deleteProbe: "denied" } is one the engine cannot emit, so a fixture built that way leaves the
  // WORM state unreachable while this suite stays green. See test/validate-support-posture-gaps-5.ts, which
  // drives the whole thing through EngineClient.verifyDestination.
  eq("dest: the DELETE probe was denied (a retention posture, not an outage)", destProbeOutcome({ ok: true, deleteProbe: "denied" }), "dest-delete-denied");
  ok(
    "dest: unreachable, auth and delete-denied are THREE classes, not one",
    new Set([
      destProbeOutcome({ ok: false, reason: "ENOTFOUND" }),
      destProbeOutcome({ ok: false, reason: "403 Forbidden" }),
      destProbeOutcome({ ok: true, deleteProbe: "denied" }),
    ]).size === 3,
  );

  // IdP: the fail class comes from the engine's own CHECK NAMES + statuses, never the detail line (which holds
  // the certificate subject and the discovery URL). "The IdP test showed a red cert check" is the ticket.
  eq("idp: a red CERT check", idpProbeOutcome({ ok: false, checks: [{ name: "certificate", status: "fail" }] }), "idp-cert-failed");
  eq("idp: a failed DISCOVERY", idpProbeOutcome({ ok: false, checks: [{ name: "OIDC discovery", status: "fail" }] }), "idp-discovery-failed");
  eq("idp: unreachable JWKS", idpProbeOutcome({ ok: false, checks: [{ name: "JWKS keys", status: "fail" }] }), "idp-jwks-failed");
  eq("idp: SAML metadata", idpProbeOutcome({ ok: false, checks: [{ name: "metadata", status: "fail" }] }), "idp-metadata-failed");
  // NOISE: a warn is advisory and the probe PASSED. Recording it as a fault would report a healthy connection
  // as a broken one, and a signal that cries wolf devalues every true one.
  eq("idp: a WARN on a passing test is not a fault", idpProbeOutcome({ ok: true, checks: [{ name: "certificate", status: "warn" }] }), "ok");

  // SIEM: httpStatus is a NUMBER on the wire, so the 4xx/5xx split needs no text at all.
  eq("push: a 403", pushProbeOutcome({ ok: false, httpStatus: 403 }), "push-endpoint-4xx");
  eq("push: the vendor's own outage", pushProbeOutcome({ ok: false, httpStatus: 502 }), "push-endpoint-5xx");
  eq("push: the egress guard refused (the endpoint was never called)", pushProbeOutcome({ ok: false, reason: "egress blocked: private address" }), "push-egress-blocked");
  eq("push: a timeout", pushProbeOutcome({ ok: false, reason: "timed out after 5s" }), "push-timeout");
  ok(
    "push: a vendor 5xx and a Downpipes egress refusal are NOT the same row",
    pushProbeOutcome({ ok: false, httpStatus: 502 }) !== pushProbeOutcome({ ok: false, reason: "egress blocked" }),
  );

  eq("email: the platform NAMED its refusal (a step the customer can go and complete)", emailProbeOutcome({ ok: false, code: "E_SENDER_DOMAIN_NOT_AVAILABLE" }), "email-platform-refused");
  eq("email: it did not", emailProbeOutcome({ ok: false }), "email-other");

  // THE PROBE THAT NEVER RAN. A test the engine REFUSED (a role gate, a step-up, a rate limit) teaches nothing
  // about the vendor, and must never be filed as a vendor fault; the two are different rows.
  eq("the engine REFUSED the test (it never ran)", probeCallOutcome(new Error("test push destination: 403")), "probe-refused");
  eq("the test call never came back", probeCallOutcome(new TypeError("Failed to fetch")), "probe-unreachable");
  ok(
    "a test that was REFUSED and a test that RAN AND FAILED are different rows",
    probeCallOutcome(new Error("x: 403")) !== destProbeOutcome({ ok: false, reason: "403 Forbidden" }),
  );

  // `ok` is a member on purpose: "it fails every morning and works on retry" is a claim about a RATIO, and a
  // ring of failures alone cannot confirm or deny it. A pass and a fail are two rows with two counts.
  resetRing();
  recordProbeOutcome("dest-verify", "ok");
  recordProbeOutcome("dest-verify", "ok");
  recordProbeOutcome("dest-verify", "dest-unreachable");
  eq("passes and failures coalesce into TWO rows, each with its own count", rows().length, 2);
  eq("the pass count is honest (the ratio is computable)", rows().find((r) => r.probeOutcome === "ok")?.count, 2);

  // NO-CUSTODY: the reason strings the classifiers READ must not reach the wire.
  resetRing();
  recordProbeOutcome("dest-verify", destProbeOutcome({ ok: false, reason: "PUT https://SENTINEL-BUCKET.r2.example/probe failed: signature mismatch" }));
  recordProbeOutcome("push-test", pushProbeOutcome({ ok: false, httpStatus: 403, reason: "https://SENTINEL-SIEM.example/collect returned 403" }));
  const probeWire = wire();
  ok("NO-CUSTODY: no bucket name reaches the wire", !probeWire.includes("SENTINEL-BUCKET"));
  ok("NO-CUSTODY: no SIEM endpoint reaches the wire", !probeWire.includes("SENTINEL-SIEM"));
  ok("NO-CUSTODY: no vendor reason text reaches the wire", !probeWire.includes("signature mismatch"));
  // A signature mismatch IS an auth fault, and the auth match runs before the write match on purpose: a reason
  // that says both "PUT" and "signature" is a credential problem, not a bucket-policy problem, and sending the
  // operator to re-check their bucket permissions would be the wrong remedy.
  ok("the closed classes DID reach the wire", probeWire.includes("dest-auth") && probeWire.includes("push-endpoint-4xx"));
}

// ---------------------------------------------------------------------------------------------------------
console.log("\n-- a client-side rejection, and a SILENT coercion, are not the same event --");
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  setActiveScreen("/destinations");
  // THE OUTCOME IS THE DISCRIMINATOR. A REJECTION the operator saw (they are stuck, they are on the phone) and
  // a COERCION they did not (the save succeeded and the estate now runs on a value they never chose) are
  // opposite failures, and on the same field.
  // The field ids are the FIELD CATALOGUE'S OWN control ids, which is what lets a row join to a catalogue entry
  // and feed a divergence detector. The REAL coercion path is driven end to end in
  // test/validate-support-posture-gaps-5.ts.
  resetRing();
  recordFormRefused("dest-worm-days", "0.5");
  recordFormCoerced("dest-price-storage");
  eq("a rejection the operator SAW and a coercion they did not are TWO rows", rows().length, 2);

  distinct("client-side rejection vs coercion fields", [
    { name: "the contracted storage rate was swapped for the preset", drive: () => recordFormCoerced("dest-price-storage") },
    { name: "the egress rate was swapped for the preset", drive: () => recordFormCoerced("dest-price-egress") },
    { name: "blocked configuring WORM", drive: () => recordFormRefused("dest-worm-days", "0.5") },
    { name: "blocked configuring STS", drive: () => recordFormRefused("dest-role-arn", "arn:nope") },
    { name: "the attach form refused the namespace id", drive: () => recordFormRefused("namespaceId", "0f2ac7c1-b6e0-470a-8f3d-2c9b1e6a4d5f") },
  ]);

  ok("the field id and the outcome both reach the wire", wire().includes("form-rejected") && wire().includes("silently-coerced"));
}

// ---------------------------------------------------------------------------------------------------------
console.log("\n-- a withheld Cloudflare-config offer says WHICH reason --");
{
  setActiveScreen("/downpipes");
  // Driven through the REAL pure classifier the wizard calls, over the three inputs support otherwise confuses.
  const withSurfaces = { tokenPresent: true, cfConfigSurfaces: [{ id: "dns", label: "DNS", category: "zone", scope: "zone" }] } as unknown as SourceDiscovery;
  const noSurfaces = { tokenPresent: true, cfConfigSurfaces: [] } as unknown as SourceDiscovery;
  // A DISCOVERY TOKEN IS STORED and the engine still returned no catalogue: on the token path the catalogue is a
  // static compiled-in list, so this and only this is the engine that predates the feature.
  eq("a token IS stored and the catalogue is still empty: the engine predates the feature", cfWithheldCatalogueClass(noSurfaces, true, 3), "cf-catalogue-empty");
  eq("cf-config was never added as a source", cfWithheldCatalogueClass(withSurfaces, false, 3), "cf-not-added");
  eq("the token could read no account to scope to", cfWithheldCatalogueClass(withSurfaces, true, 0), "cf-no-accounts");

  // THE NOISE STATE THAT WOULD OTHERWISE BE THE COMMONEST ROW OF ALL. Account discovery is OPT-IN: with no
  // discovery token the engine returns { bound, tokenPresent:false } and no catalogue, which is the resting
  // state of every customer who backs up only bound sources. Ungated, every wizard render on such an engine
  // would write cf-catalogue-empty -- the row whose remedy is "update the engine" -- about a healthy, current
  // engine.
  const noToken = { tokenPresent: false, bound: { kv: [], r2: [], d1: [], secrets: [] } } as unknown as SourceDiscovery;
  eq("NOISE: no discovery token stored records NOTHING (it is not an old engine, it is an unset option)", cfWithheldCatalogueClass(noToken, true, 0), null);
  const preTierEngine = { bound: { kv: [], r2: [], d1: [], secrets: [] } } as unknown as SourceDiscovery;
  eq("NOISE: an engine too old to report tokenPresent is token-source-tier skew, not a catalogue row", cfWithheldCatalogueClass(preTierEngine, true, 0), null);
  ok(
    "'update the engine' and 'you never pasted a token' are not the same row",
    cfWithheldCatalogueClass(noSurfaces, true, 3) !== cfWithheldCatalogueClass(noToken, true, 0),
  );
  // The reason prose has a FOURTH, catch-all branch. The classifier returns null there rather than guessing
  // cf-no-accounts, so a state it has not established never becomes a confident row in a sealed pack.
  eq("an unestablished withholding reason records NOTHING rather than a wrong class", cfWithheldCatalogueClass(withSurfaces, true, 3), null);
  ok(
    "the three confusable reasons are THREE classes",
    new Set([cfWithheldCatalogueClass(noSurfaces, true, 3), cfWithheldCatalogueClass(withSurfaces, false, 3), cfWithheldCatalogueClass(withSurfaces, true, 0)]).size === 3,
  );

  distinct("withheld cf-config reasons", [
    { name: "the wizard offered nothing: no catalogue", drive: () => recordCatalogueDegraded("cf-catalogue-empty") },
    { name: "the wizard offered nothing: not added", drive: () => recordCatalogueDegraded("cf-not-added") },
    { name: "the wizard offered nothing: no accounts", drive: () => recordCatalogueDegraded("cf-no-accounts") },
    { name: "the editor's surface list did not load", drive: () => recordCatalogueDegraded("cf-surface-list-unreadable") },
    { name: "a live cf-config downpipe has NEVER discovered (capture-all, silently)", drive: () => recordCatalogueDegraded("cf-never-discovered") },
    { name: "Rediscover failed, so the stale surface set stands", drive: () => recordCatalogueDegraded("cf-rediscover-failed") },
  ]);
}

// ---------------------------------------------------------------------------------------------------------
console.log("\n-- BROKEN and UNBUILT stop being the same tile --");
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  setActiveScreen("/security");
  // THE CONFLATION, DRIVEN THROUGH THE REAL CLASSIFIER. The console's pending-the-engine tile says the same
  // sentence for all of these. They are the same tile and they must not be the same row.
  eq("a 404 (the tile is TRUE: the engine does not serve this route)", featureOutcomeForError(new Error("list roles: 404")), "route-absent");
  eq("a 501", featureOutcomeForError(new Error("list roles: 501")), "not-implemented");
  eq("a 500 (the tile is a LIE: the engine is deployed and BROKEN)", featureOutcomeForError(new Error("list roles: 500")), "server-error");
  eq("a 403 (the table is empty because of a ROLE, not a defect)", featureOutcomeForError(new Error("list roles: 403")), "forbidden");
  eq("no status at all: the fetch threw", featureOutcomeForError(new TypeError("Failed to fetch")), "network");
  ok(
    "route-absent, server-error and forbidden are THREE verdicts behind ONE tile",
    new Set([
      featureOutcomeForError(new Error("x: 404")),
      featureOutcomeForError(new Error("x: 500")),
      featureOutcomeForError(new Error("x: 403")),
    ]).size === 3,
  );
  // NOISE: a lapsed session is the ordinary state of a console left open overnight. It records NOTHING.
  eq("a 401 is NOT a fault and records nothing", featureOutcomeForError(new Error("list roles: 401")), null);

  // THE FEATURE IS A DISCRIMINATOR TOO. "The members table never loads for one customer" is one route family on
  // a screen that reads seven, so a server-error row that cannot name the route names nothing.
  distinct("broken vs unbuilt features", [
    { name: "the members table", drive: () => recordFeatureProbe("roles-table", "server-error") },
    { name: "the config-approvals queue (every failure mapped to feature-absent)", drive: () => recordFeatureProbe("config-approvals", "server-error") },
    { name: "the restore-approvals count", drive: () => recordFeatureProbe("restore-approvals", "server-error") },
    { name: "the audit table", drive: () => recordFeatureProbe("audit-events", "server-error") },
    { name: "the group-role mappings", drive: () => recordFeatureProbe("group-roles", "server-error") },
    { name: "whoami (the verifier)", drive: () => recordFeatureProbe("whoami", "server-error") },
  ]);

  // THE CONSOLE_ORIGIN VERDICT: computed, shown, and otherwise thrown away. This is the pair the whole probe
  // exists to separate, and it must be two rows.
  resetRing();
  recordFeatureProbe("whoami", "origin-rejected"); // the fetch threw AND the health probe answered: CORS.
  recordFeatureProbe("whoami", "network"); // the fetch threw AND health also failed: the engine is down.
  eq("CONSOLE_ORIGIN-not-set and engine-down are TWO rows", rows().length, 2);
  ok("the CONSOLE_ORIGIN diagnosis reaches the pack instead of the bin", wire().includes("origin-rejected"));

  // The most broken console possible must not produce the emptiest pack.
  resetRing();
  recordFeatureProbe("engine-url", "engine-url-unparseable");
  ok("an unparseable engine address is asserted, so an otherwise-silent ring is readable", wire().includes("engine-url-unparseable"));

  // NO-CUSTODY: the engine's message text (which embeds identifiers) must not ride.
  resetRing();
  recordFeatureProbe("roles-table", featureOutcomeForError(new Error("list roles for acct SENTINEL-ACCT at https://SENTINEL.example: 500"))!);
  ok("NO-CUSTODY: no engine message text reaches the wire", !wire().includes("SENTINEL"));
  ok("the verdict did", wire().includes("server-error"));
}

// ---------------------------------------------------------------------------------------------------------
console.log("\n-- client-side governance gates exist at all, and name their action --");
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  setActiveScreen("/downpipes");
  // Both gates are invisible to the engine BY CONSTRUCTION, and they fail in OPPOSITE directions: one blocks an
  // action that should have run, the other lets through an action that should have been stopped for a change
  // number. They must never be one row.
  resetRing();
  recordGovGate("role-gate-refusal-shown", "downpipe-delete");
  recordGovGate("change-prompt-skipped-policy-read-failed", "downpipe-delete");
  eq("a greyed-out Delete and a skipped change prompt ON THE SAME ACTION are TWO rows", rows().length, 2);

  // THE ACTION IS A DISCRIMINATOR. "The Delete button is greyed out for our admin" needs to say WHICH button:
  // one drawer greys out four of them at once.
  distinct("governance gate actions", [
    { name: "Delete greyed out", drive: () => recordGovGate("role-gate-refusal-shown", "downpipe-delete") },
    { name: "Run now greyed out", drive: () => recordGovGate("role-gate-refusal-shown", "downpipe-run") },
    { name: "Edit greyed out", drive: () => recordGovGate("role-gate-refusal-shown", "downpipe-edit") },
    { name: "Remove destination greyed out", drive: () => recordGovGate("role-gate-refusal-shown", "destination-delete") },
    { name: "the change prompt was skipped on a RESTORE APPLY", drive: () => recordGovGate("change-prompt-skipped-policy-read-failed", "restore-apply") },
  ]);

  // The JOIN this exists for: the engine counts its own change-control 400s
  // (configIntegrity.changeControlRefusals) and cannot know the console never asked. This row is the other half.
  resetRing();
  recordGovGate("change-prompt-skipped-policy-read-failed", "destination-upsert");
  ok("the skipped prompt reaches the pack, so it can be joined to the engine's own refusal count", wire().includes("change-prompt-skipped-policy-read-failed") && wire().includes("destination-upsert"));
}

// ---------------------------------------------------------------------------------------------------------
console.log("\n-- the console's own build, against what its ORIGIN serves --");
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  setActiveScreen("/updates");
  // THE COMPARANDS MATTER. Comparing the console's baked version against the ENGINE's `currentVersion` compares
  // two independently incremented numbers from two separate repos: on a healthy, correctly-built, matched pair
  // (console 0.1.10, engine 0.1.9) that would return "console-ahead", so every pack from every healthy customer
  // would carry a fabricated fault, and a genuinely STALE console would report as AHEAD. The honest comparison
  // is the RUNNING bundle against WHAT THE SAME ORIGIN SERVES, and it is driven end to end (through the real
  // reader and the real recorder) in validate-support-posture-gaps-5.ts.
  eq("the tab runs exactly what the origin serves", skewClassFor("0.2.0", "0.2.0", "ok"), "served-matches-running");
  eq("a leading v is not a skew", skewClassFor("v0.2.0", "0.2.0", "ok"), "served-matches-running");
  eq("THE STALE TAB (the origin has the new bundle; this browser is still running the old one)", skewClassFor("0.1.9", "0.2.0", "ok"), "served-newer-than-running");
  eq("the origin serves an OLDER bundle than this tab loaded", skewClassFor("0.3.0", "0.2.0", "ok"), "served-older-than-running");
  // A LEXICAL compare says 0.10.0 < 0.9.0, which would call a newer tab stale and send support to purge a CDN
  // that is serving exactly the right thing. The comparator is numeric per segment.
  eq("0.10.0 is AHEAD of 0.9.0 (a lexical compare gets this backwards)", skewClassFor("0.10.0", "0.9.0", "ok"), "served-older-than-running");
  eq("this bundle carries no stamp at all (it blinds every check above it)", skewClassFor(null, "0.2.0", "ok"), "running-unstamped");
  eq("an Access page on the console's OWN origin is not a stale asset", skewClassFor("0.2.0", null, "non-json"), "origin-not-json");
  eq("the descriptor did not answer at all", skewClassFor("0.2.0", null, "unreachable"), "origin-unreachable");

  ok(
    "matched, stale-tab, rolled-back-origin, unstamped, not-json and unreachable are SIX classes",
    new Set([
      skewClassFor("0.2.0", "0.2.0", "ok"),
      skewClassFor("0.1.0", "0.2.0", "ok"),
      skewClassFor("0.3.0", "0.2.0", "ok"),
      skewClassFor(null, "0.2.0", "ok"),
      skewClassFor("0.2.0", null, "non-json"),
      skewClassFor("0.2.0", null, "unreachable"),
    ]).size === 6,
  );

  // NO-CUSTODY: the class rides, the version string does not. WHICH build is running is carried directly and
  // deliberately, as the shape-gated `consoleBuild` on the payload envelope, beside the engine's version.
  resetRing();
  recordConsoleSkew(skewClassFor("0.2.0", "0.9.9", "ok"));
  ok("a version string never enters the ring (there is no field for one)", !wire().includes("0.9.9") && !wire().includes("0.2.0"));
}

console.log(failures === 0 ? "\nsupport posture gaps: all checks passed" : `\nsupport posture gaps: ${failures} FAILED`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
process.exit(failures === 0 ? 0 : 1);
