// Validates support-pack gap coverage: the pack must discriminate the states support cannot otherwise tell
// apart, not merely record that something happened.
//
// THE BAR IS THE DISCRIMINATION TEST. A recorder, a caller and a projection are NOT enough. For every case
// below the suite ENUMERATES the states that are otherwise indistinguishable, DRIVES each one, and asserts they
// produce DIFFERENT ROWS. A test that asserts merely that "a row was recorded" lets working plumbing mask a gap
// behind it.
//
// The coalescing key is the other half. A field that discriminates two outcomes and is left OUT of the ring's
// tuple key discriminates NOTHING: the two rows collapse into one and the first written wins the class. So
// every assertion below counts ROWS IN THE RING (via snapshot(), which is what the pack carries), never a value
// a recorder was handed.
//
// Coverage:
//   key/ceremony material  a refused piece of key/ceremony material says WHY it was refused, and the five reasons are five rows
//   contract vocabulary    the console SAW unknown vocabulary or a missing field, per data family, and says which
//   bulk operations        a bulk loop says WHICH operation it was, and a selection that vanished under the operator is visible
//   fleet drills           a fleet-drill session's shape survives the modal: targeted/passed/failed/skipped/retry-exhausted,
//                          and an ABORTED session never coalesces with a clean one
//   contract drift         contract drift is told apart from genuinely empty state, per contract class and per field family
//   whoami / wire values   an unrecognised whoami method is not rendered as the break-glass TOKEN FALLBACK posture, and
//                          every coarsened wire value says which family and how it was wrong
//   replication            a never-reported replication destination stops being folded into "catching up"
//
// Run with `node test/validate-support-posture-gaps-2.ts`.

import { installDomShim } from "./dom-shim.ts";
installDomShim();

import {
  packPayload,
  recordContractSkew,
  setConsoleBuild,
  recordFleetDrill,
  recordBulkOutcome,
  recordSelectionDropped,
  recordWireAnomaly,
  reset as resetRing,
  setActiveScreen,
  snapshot,
} from "../src/lib/client-diag/ring.ts";
import { b64urlDecode } from "../src/bytes.ts";
import { isCeremonyResult } from "../src/keygen.ts";
import { accessVerdictFromCaller } from "../src/components/trust-chips.ts";
import { executiveAnswers } from "../src/screens/overview/executive.ts";
import { countOf } from "../src/screens/config-history.ts";
import { summariseFleet } from "../src/screens/overview/fleet-data.ts";
import { onboardingSignInItem } from "../src/screens/onboarding/carousel-cards-configure-ready.ts";
import type { OverviewData } from "../src/screens/overview/shared.ts";
import { classifyFreshness } from "../src/screens/map/data.ts";
import { summariseReplication } from "../src/components/replication.ts";
import { collectDrillTargets } from "../src/screens/overview/fleet-drill.ts";
import type { Caller } from "../src/lib/api/types/who.ts";
import type { DestReplState } from "../src/lib/api/types/recovery.ts";
import type { RunHistoryEntry } from "../src/api.ts";
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

// rows() is the ring AS THE PACK WOULD CARRY IT. Every discrimination assertion goes through this, because the
// TUPLE KEY is what decides whether two states are two rows, and a field outside that key tells apart nothing.
function rows(): ReturnType<typeof snapshot>["records"] {
  return snapshot().records;
}
function wire(): string {
  return JSON.stringify(packPayload());
}

// ---- A rejected piece of key / ceremony material says WHY --------------------------------------------------
{
  console.log("\n-- operator key/ceremony material rejections --");

  // THE STATES THAT ARE INDISTINGUISHABLE. Five ways a paste is refused, and today all five are one
  // "that does not look right" hint and NOTHING in the pack. They are not one ticket: a share pasted from a
  // standard-base64 tool ('=' padding) and one an email client smart-quoted are both perfectly fixable in
  // seconds IF support can see which; a truncated share is a different conversation entirely.
  resetRing();
  setActiveScreen("keys");
  const drive = (s: string): void => {
    try {
      b64urlDecode(s);
    } catch {
      /* the throw is the product behaviour; the ROW is what we are testing */
    }
  };
  drive("abcde"); // length 5 == 1 mod 4: a truncated / over-long paste
  drive("ab=="); // standard-base64 PADDING
  drive("ab+/"); // standard-base64 ALPHABET
  drive("ab—d"); // an em dash: what a word processor does to a share
  isCeremonyResult({ breakGlass: "not a key material object" }); // a stored ceremony result of the wrong shape

  const mat = rows().filter((r) => r.kind === "material-rejected");
  eq("five refusal causes produce FIVE distinct rows (not one)", mat.length, 5);
  eq(
    "and each names its own cause",
    [...new Set(mat.map((r) => r.materialClass))].sort(),
    ["bad-length", "ceremony-shape", "non-alphabet", "non-ascii", "padding-present"],
  );

  // THE COALESCING PROOF: repeat one cause and it must INCREMENT that row, never spawn a second, and never
  // merge with a different cause. A materialClass outside the tuple key would collapse all five into one.
  resetRing();
  drive("ab==");
  drive("ab==");
  drive("ab+/");
  const two = rows().filter((r) => r.kind === "material-rejected");
  eq("a repeat of one cause coalesces; a different cause does not", two.length, 2);
  eq("the repeated cause carries a count of 2", two.find((r) => r.materialClass === "padding-present")?.count, 2);

  // NOISE: a ceremony that has NEVER RUN is the legitimate opening state of a fresh console. It must not record.
  resetRing();
  isCeremonyResult(null);
  isCeremonyResult(undefined);
  eq("an ABSENT ceremony result (a fresh console) records nothing", rows().length, 0);

  // NO-CUSTODY: the material, the offending character, its index and the LENGTH are all absent from the wire. A
  // length is a fingerprint of the secret, and the class already says the length was what was wrong.
  resetRing();
  drive("SUPERSECRETSHARE+");
  const w = wire();
  ok("the pasted material never reaches the wire", !w.includes("SUPERSECRET"));
  ok("the offending character never reaches the wire", !w.includes('"+"'));
  ok("no length rides (it fingerprints the secret)", !/"len|"length/.test(w));
}

// ---- The console SAW unknown vocabulary or a missing field --------------------------------------------------
{
  console.log("\n-- console-engine contract drift --");

  // THE STATES THAT ARE INDISTINGUISHABLE. Post-update, every one of these renders as a defect or as
  // genuinely empty state, and the pack carried engine.version (which build is running) and nothing at all about
  // what the console could not read.
  resetRing();
  setActiveScreen("idp");
  recordContractSkew("unknown-enum-member", "idp-preset"); // a tile turned into a generic globe
  recordContractSkew("unknown-enum-member", "source-type"); // a cryptic row label in the cost table
  recordContractSkew("missing-field", "status-fields"); // "why did my recovery-code count vanish"
  recordContractSkew("missing-field", "policy-fields"); // "why did the R6 sign-in option vanish"
  recordContractSkew("empty-payload", "posture-checks"); // "security centre says no checks reported"
  recordContractSkew("wrong-shape", "role-grants"); // "the v9 snapshot says 0 role grants but we had 12"
  recordContractSkew("missing-field", "idp-connections"); // "every IdP tile reads Add but we run three"
  recordContractSkew("unknown-enum-member", "change-kind"); // "Approve renders but always fails"
  recordContractSkew("empty-payload", "change-description"); // "approve a change with no description"
  recordContractSkew("watch-timeout-drift", "flight-watch"); // "flights end abruptly"
  recordContractSkew("legacy-path-taken", "added-sources"); // a compat branch taken silently

  const skew = rows().filter((r) => r.kind === "contract-skew");
  eq("eleven drift states produce ELEVEN distinct rows", skew.length, 11);

  // BOTH fields must be in the tuple key, and this is the assertion that proves it. Same class, different
  // family: two rows. Same family, different class: two rows. Either field outside the key and these collapse.
  resetRing();
  recordContractSkew("unknown-enum-member", "idp-preset");
  recordContractSkew("unknown-enum-member", "source-type");
  eq("same contractClass, DIFFERENT fieldFamily -> two rows (fieldFamily is in the key)", rows().length, 2);

  resetRing();
  recordContractSkew("missing-field", "idp-connections");
  recordContractSkew("wrong-shape", "idp-connections");
  eq("same fieldFamily, DIFFERENT contractClass -> two rows (contractClass is in the key)", rows().length, 2);

  // The distinction that matters to support: a `connections` array that ARRIVED MALFORMED and one that was simply
  // ABSENT are different engine bugs, and both render three live connections as three empty "Add" tiles.
  resetRing();
  recordContractSkew("missing-field", "idp-connections");
  recordContractSkew("missing-field", "idp-connections");
  eq("a repeat of one drift state coalesces into one row", rows().length, 1);
  eq("and counts", rows()[0]?.count, 2);
}

// ---- Bulk operation outcomes -------------------------------------------------------------------------------
{
  console.log("\n-- bulk operation outcomes --");

  // THE FIRST STATE THAT MATTERS: "my bulk delete half-failed last Tuesday". Without bulkAction in the key, a
  // half-failed DELETE and a half-failed RUN are the SAME tuple (bulk-outcome / downpipes / partial) and coalesce
  // into one row with a count of two. The pack would then carry a bulk-outcome row that could not say what had
  // been bulk-ed.
  resetRing();
  setActiveScreen("downpipes");
  recordBulkOutcome("delete", "partial", 3);
  recordBulkOutcome("run", "partial", 3);
  const bulk = rows().filter((r) => r.kind === "bulk-outcome");
  eq("a half-failed DELETE and a half-failed RUN are TWO rows, not one", bulk.length, 2);
  eq("and each names its operation", [...new Set(bulk.map((r) => r.bulkAction))].sort(), ["delete", "run"]);

  // THE SECOND STATE, which had no evidence anywhere at all: "I selected 20 downpipes but only 17 were acted
  // on". The loop's own counts are self-consistent (17 attempted, 17 done, 0 failed) and the engine sees 17
  // perfectly good requests, so nothing on either side is wrong-looking. It must not coalesce with a failure.
  resetRing();
  recordBulkOutcome("delete", "partial", 3);
  recordSelectionDropped("delete", 3);
  const two = rows().filter((r) => r.kind === "bulk-outcome");
  eq("a dropped SELECTION and a partial FAILURE on the same action are two rows", two.length, 2);
  eq(
    "the dropped-selection row carries the number that vanished",
    two.find((r) => r.reasonClass === "selection-dropped")?.count,
    3,
  );

  // Every reasonClass x bulkAction pair is its own row: an auth halt on a delete and an auth halt on a run are
  // different tickets, and a drop of 3 on a delete is not a drop of 3 on a protect.
  resetRing();
  recordBulkOutcome("delete", "auth", 5);
  recordBulkOutcome("run", "auth", 5);
  recordSelectionDropped("delete", 2);
  recordSelectionDropped("protect", 2);
  eq("(action x reason) is the discriminator, and all four pairs are distinct rows", rows().length, 4);

  // NO-CUSTODY: the per-item names and reasons rendered in the modal never leave the browser.
  resetRing();
  recordBulkOutcome("delete", "partial", 2);
  ok("no item name rides", !wire().includes("name"));
}

// ---- Fleet-drill session outcomes --------------------------------------------------------------------------
{
  console.log("\n-- fleet-drill session outcomes --");

  // THE STATE THAT MATTERS HERE. Drill evidence shows 8 of 30 downpipes on one date. Was that a DELIBERATE
  // partial drill, or a fleet drill that hit a 401 at pipe 9 and aborted? The engine sees the same 8 either way,
  // and the console's own session shape lived in a toast the operator closed.
  resetRing();
  setActiveScreen("overview");
  recordFleetDrill("none", { targeted: 8, passed: 8, failed: 0, deferred: 0, skippedNoRunId: 0, rateLimitExhausted: 0 });
  const clean = rows().filter((r) => r.kind === "fleet-drill");

  resetRing();
  recordFleetDrill("signed-out", { targeted: 30, passed: 8, failed: 0, deferred: 0, skippedNoRunId: 0, rateLimitExhausted: 0 });
  const aborted = rows().filter((r) => r.kind === "fleet-drill");

  ok(
    "a deliberate 8-pipe drill and an ABORTED 30-pipe drill are different evidence",
    JSON.stringify(clean.map((r) => [r.drillAbort, r.drillFact, r.count]))
      !== JSON.stringify(aborted.map((r) => [r.drillAbort, r.drillFact, r.count])),
  );
  const abortedTarget = aborted.find((r) => r.drillFact === "targeted");
  eq(
    "the aborted session says so, and says how many it MEANT to drill",
    [abortedTarget?.drillAbort, abortedTarget?.drillFact, abortedTarget?.count],
    ["signed-out", "targeted", 30],
  );

  // THE COALESCING PROOF, and the one that matters most here: an ABORTED session's counts must never SUM into a
  // clean session's. drillAbort is in the tuple key, so they are separate rows; if it were not, a fleet that
  // aborts every Tuesday would quietly inflate the passed count of the drills that did complete.
  resetRing();
  recordFleetDrill("none", { targeted: 10, passed: 10, failed: 0, deferred: 0, skippedNoRunId: 0, rateLimitExhausted: 0 });
  recordFleetDrill("signed-out", { targeted: 10, passed: 2, failed: 0, deferred: 0, skippedNoRunId: 0, rateLimitExhausted: 0 });
  const passedRows = rows().filter((r) => r.kind === "fleet-drill" && r.drillFact === "passed");
  eq("a clean session's `passed` and an aborted one's are two rows", passedRows.length, 2);
  eq(
    "and the aborted one's 2 never sums into the clean one's 10",
    passedRows.map((r) => `${r.drillAbort}:${r.count}`).sort(),
    ["none:10", "signed-out:2"],
  );

  // "12 of 30 did not pass, but the customer closed the modal."
  resetRing();
  recordFleetDrill("none", { targeted: 30, passed: 18, failed: 12, deferred: 0, skippedNoRunId: 0, rateLimitExhausted: 0 });
  const f = rows().filter((r) => r.kind === "fleet-drill");
  eq("targeted/passed/failed all survive the modal", [
    f.find((r) => r.drillFact === "targeted")?.count,
    f.find((r) => r.drillFact === "passed")?.count,
    f.find((r) => r.drillFact === "failed")?.count,
  ], [30, 18, 12]);

  // "One downpipe NEVER appears in any drill." collectDrillTargets silently drops a downpipe whose latest
  // history row has no runId. It is not a failed drill: no drill was attempted, so its absence from the evidence
  // is byte-identical to the absence of a pipe nobody has drilled.
  const hist: Record<string, RunHistoryEntry[]> = {
    "dp-good": [{ runId: "01J0", status: "ok", startedAt: "2026-07-01T00:00:00.000Z" } as RunHistoryEntry],
    "dp-no-runid": [{ status: "ok", startedAt: "2026-07-01T00:00:00.000Z" } as RunHistoryEntry],
    "dp-empty": [],
  };
  const collected = collectDrillTargets(hist);
  eq("collectDrillTargets reports what it dropped", collected.skippedNoRunId, 2);
  eq("and still targets the one it can drill", collected.targets.length, 1);

  resetRing();
  recordFleetDrill("none", { targeted: 1, passed: 1, failed: 0, deferred: 0, skippedNoRunId: 2, rateLimitExhausted: 0 });
  eq(
    "the silently-skipped pipes are a NUMBER in the pack, not an absence",
    rows().find((r) => r.drillFact === "skipped-no-run-id")?.count,
    2,
  );

  // A 429 storm and N genuinely unrestorable pipes produce the same failure count and the same toast. Only this
  // tells them apart, and they are opposite remedies.
  resetRing();
  recordFleetDrill("none", { targeted: 30, passed: 0, failed: 30, deferred: 0, skippedNoRunId: 0, rateLimitExhausted: 30 });
  const storm = rows().filter((r) => r.kind === "fleet-drill");
  resetRing();
  recordFleetDrill("none", { targeted: 30, passed: 0, failed: 30, deferred: 0, skippedNoRunId: 0, rateLimitExhausted: 0 });
  const broken = rows().filter((r) => r.kind === "fleet-drill");
  ok(
    "a 429-exhaustion wipeout and a genuine 30-pipe wipeout are different evidence",
    JSON.stringify(storm.map((r) => [r.drillFact, r.count])) !== JSON.stringify(broken.map((r) => [r.drillFact, r.count])),
  );

  // The fleet READ failing means not one drill was attempted, which from the engine's side is identical to a
  // drill that was never started.
  resetRing();
  recordFleetDrill("fleet-read-failed", { targeted: 0, passed: 0, failed: 0, deferred: 0, skippedNoRunId: 0, rateLimitExhausted: 0 });
  eq(
    "a fleet read that failed says so (0 attempted is NOT the same as never started)",
    rows().find((r) => r.kind === "fleet-drill")?.drillAbort,
    "fleet-read-failed",
  );

  // NO-CUSTODY: no downpipe id rides, and failed ids are never capped or listed because there is no field for one.
  resetRing();
  recordFleetDrill("none", { targeted: 3, passed: 1, failed: 2, deferred: 0, skippedNoRunId: 0, rateLimitExhausted: 0 });
  ok("no downpipe id can ride (there is no field for one)", !wire().includes("dp-"));

  // A break-glass-only downpipe the engine honestly refused is NOT a failure. It gets its own fact, distinct
  // from both passed and failed, so a fleet that is entirely (or partly) break-glass-only is never
  // miscategorised as a fleet with failing drills.
  resetRing();
  recordFleetDrill("none", { targeted: 10, passed: 6, failed: 0, deferred: 4, skippedNoRunId: 0, rateLimitExhausted: 0 });
  const dOnly = rows().filter((r) => r.kind === "fleet-drill");
  eq(
    "deferred is its own fact, and failed reads zero when nothing genuinely failed",
    [dOnly.find((r) => r.drillFact === "passed")?.count, dOnly.find((r) => r.drillFact === "failed")?.count, dOnly.find((r) => r.drillFact === "deferred")?.count],
    [6, 0, 4],
  );

  // A session with BOTH real failures AND deferred posture-refusals: the two counts stay in separate rows,
  // never summed together. A genuine failure is never hidden inside deferred, and a deferred downpipe is
  // never counted as a failure.
  resetRing();
  recordFleetDrill("none", { targeted: 10, passed: 3, failed: 2, deferred: 5, skippedNoRunId: 0, rateLimitExhausted: 0 });
  const mixed = rows().filter((r) => r.kind === "fleet-drill");
  eq(
    "a mixed session keeps failed and deferred as separate, un-summed counts",
    [mixed.find((r) => r.drillFact === "failed")?.count, mixed.find((r) => r.drillFact === "deferred")?.count],
    [2, 5],
  );
}

// EXEC_DATA is the SHAPE the Overview really hands executiveAnswers: every read settled, nothing to see. The
// access answer does not depend on any of it, which is the point -- the card must be driven by the verdict alone.
const EXEC_DATA: OverviewData = {
  health: { ok: true, value: { ok: true, service: "downpipe engine" } },
  status: { ok: false, error: new Error("status: 500") },
  downpipes: { ok: true, value: [] },
  history: { ok: true, value: [] },
  drillEvidence: { ok: true, value: [] },
  audit: { ok: true, value: [] },
} as unknown as OverviewData;
const EXEC_FLEET = summariseFleet(EXEC_DATA);

// ---- Console/engine contract drift, masked as plausible data -------------------------------------------------
{
  console.log("\n-- a mixed-version deploy, and the console coerced the mismatch into a fact --");
  resetRing();
  setActiveScreen("security");

  // WHAT IS DRIVEN AND WHAT IS NOT, stated precisely: the COUNTING half is genuinely driven (countOf is the real
  // config-history function, over the payload a skewed engine really sends); the discrimination block below
  // exercises the RING'S TUPLE KEY, and the fact that each of those five families has a real, wire-fed producer is
  // established by its own call site, not here. An overstated test comment is how a producer that no client can
  // reach survives a green suite.
  //
  // Each customer-facing symptom below is driven in turn:
  //
  //   "the v9 snapshot says 0 role grants but we had 12"   config-history countOf, a non-array family
  //   "every IdP tile reads Add but we run three"          idp-connections, the connections array absent
  //   "Approve renders but always fails"                   config-changes, a change kind this build cannot map
  //   "we were asked to approve a change with no description"
  //   "flights end abruptly"                               the canary watch ceiling drifting from the engine's
  //
  // The COERCION is the right rendering in every one of them (an older console must not throw on a newer engine);
  // the SILENCE is the defect. Support could not tell contract drift from genuinely empty state, because the two
  // render identically and neither left a trace.
  eq("a snapshot family that arrived as a non-array is counted 0 AND recorded", countOf({ n: 906143 }, "role-grants"), 0);
  eq(
    "and the row says it was a SHAPE break, on the family that broke",
    rows().filter((r) => r.kind === "contract-skew").map((r) => [r.contractClass, r.fieldFamily]),
    [["wrong-shape", "role-grants"]],
  );
  // NOISE: an ABSENT family is an older snapshot that legitimately lacks it. A row there would fire on every
  // historical version the customer has ever taken.
  resetRing();
  countOf(undefined, "role-grants");
  countOf(null, "snapshot-counts");
  eq("NOISE: an absent snapshot family records NOTHING (it is not drift, it is history)", rows().length, 0);
  eq("a well-formed family is counted honestly and records nothing", countOf([1, 2, 3], "role-grants"), 3);

  // THE DISCRIMINATION TEST. The five states the gap enumerates are five ROWS in the ring, not one: each carries
  // its own contractClass and its own fieldFamily, and both are in the coalescing tuple key. If either were left
  // out of the key, the states would collapse into a single count and the pack would name none of them.
  resetRing();
  countOf({ n: 906143 }, "role-grants");                   // the miscounted snapshot
  recordContractSkew("missing-field", "idp-connections");  // every tile reads "Add"
  recordContractSkew("unknown-enum-member", "change-kind"); // Approve renders and always fails
  recordContractSkew("empty-payload", "change-description"); // approve a change with no description
  recordContractSkew("watch-timeout-drift", "flight-watch"); // flights end abruptly
  recordContractSkew("legacy-path-taken", "added-sources"); // the compatibility branch was taken
  const skew = rows().filter((r) => r.kind === "contract-skew");
  eq("six drift states are SIX rows, not one", skew.length, 6);
  eq(
    "each names the break AND the field family it broke on",
    skew.map((r) => `${String(r.contractClass)}/${String(r.fieldFamily)}`).sort(),
    [
      "empty-payload/change-description",
      "legacy-path-taken/added-sources",
      "missing-field/idp-connections",
      "unknown-enum-member/change-kind",
      "watch-timeout-drift/flight-watch",
      "wrong-shape/role-grants",
    ],
  );
  // The SAME class on two different families must not coalesce: "the IdP connections array is missing" and "the
  // security status payload is missing" are different tickets.
  recordContractSkew("missing-field", "status-fields");
  eq("one class on two families is two rows", rows().filter((r) => r.contractClass === "missing-field").length, 2);

  // AND THE JUXTAPOSITION THE GAP ASKS FOR. The pack has always carried engine.version and nothing that says
  // WHICH CONSOLE BUILD the browser was running, so "your console is three releases behind the engine" was not a
  // sentence support could say. consoleBuild rides on the payload envelope, shape-gated: it is the release's own
  // product constant, not a customer value, and a value that fails the gate is DROPPED whole rather than clamped.
  setConsoleBuild("0.1.10");
  eq("the pack says which console build produced these rows", packPayload().consoleBuild, "0.1.10");
  setConsoleBuild("https://acme.example/secret?token=abc");
  eq("and a value that is not a version is DROPPED whole, never truncated into the field", packPayload().consoleBuild, undefined);
  setConsoleBuild("0.1.10");

  // REDACTION, with needles that only a LEAK can match. The unrecognised wire value is a sentinel that no count,
  // offset or version can produce: the ring's own millisecond offsets can themselves contain digit pairs like
  // "12", so a needle drawn from ordinary data would misfire on the clock. A match here is a leak and nothing
  // else.
  ok(
    "REDACTION: no raw unrecognised value reaches the wire, only the closed class and family",
    !/acme\.example|quantum|906143/.test(JSON.stringify(packPayload())),
  );
}

// ---- The console coarsened a wire value it could not read ----------------------------------------------------
{
  console.log("\n-- silently coarsened data-shape anomalies --");

  // THE BUG THIS GUARDS AGAINST, AND IT IS A FALSE CLAIM ABOUT THE CUSTOMER'S SECURITY POSTURE. Treating any
  // whoami method other than `access` or `passkey` as `token-fallback` would mean an engine that adds any new
  // sign-in method makes the console tell its customer, in amber, that their fleet is running on the shared
  // break-glass token: the anyone-with-the-URL credential. The customer's remedy would be a scramble against
  // nothing. The console claims the break-glass posture ONLY for the method that IS the break-glass.
  const asCaller = (method: string): Caller => ({ method, email: "ops@example.com", role: "owner", groups: [] } as unknown as Caller);
  eq("a genuine token session still reads token-fallback", accessVerdictFromCaller(asCaller("token"), true).state, "token-fallback");
  eq("Access still reads verified", accessVerdictFromCaller(asCaller("access"), true).state, "verified");
  eq("passkey still reads passkey-verified", accessVerdictFromCaller(asCaller("passkey"), true).state, "passkey-verified");

  // THE FULL METHOD SET MATTERS TOO. Native IdP sign-in is live, so the console's AuthMethod union must mirror
  // the engine's six methods, not a subset. If OIDC and SAML were missing from that union, every native-IdP
  // customer would be handed a method the console does not recognise on every screen render, and the resulting
  // "unknown method, version skew" row would fire on a current, correctly matched pair -- implying a remedy
  // ("update the console") that would fix nothing, because nothing is broken. The union mirrors the engine, so
  // these are verified, attributable sign-ins that say so.
  resetRing();
  setActiveScreen("overview");
  eq("a LIVE native-IdP OIDC session is a verified identity, not an unknown", accessVerdictFromCaller(asCaller("oidc"), true).state, "idp-verified");
  eq("a LIVE native-IdP SAML session too", accessVerdictFromCaller(asCaller("saml"), true).state, "idp-verified");
  eq("a recovery-code sign-in is verified and attributable, and is NOT the shared token", accessVerdictFromCaller(asCaller("recovery"), true).state, "recovery-verified");
  eq("and not one of the engine's six live methods records a version-skew row", rows().filter((r) => r.fieldClass === "auth-method").length, 0);

  // The row means what its name says: a method outside the six this build knows, which really is skew.
  eq(
    "a method from a FUTURE engine does not slander the customer as running on break-glass",
    accessVerdictFromCaller(asCaller("quantum-attest"), true).state,
    "unknown",
  );
  const authRow = rows().find((r) => r.kind === "wire-anomaly");
  eq(
    "and it says the console was handed a method it does not know",
    [authRow?.fieldClass, authRow?.anomaly, authRow?.count],
    ["auth-method", "unknown-enum", 1],
  );

  // THE METHOD READ MUST BE SINGLE-SOURCED. If the executive overview card and the onboarding readiness
  // checklist each kept their own private copy of the method read ("access -> access; passkey -> passkey;
  // everything else -> token"), they could tell the same customer their fleet runs on the shared break-glass
  // credential while the chip says otherwise, and prescribe a remedy that fixes nothing. Both derive from
  // accessVerdictFromCaller, and this drives THE REAL executiveAnswers and THE REAL checklist row over every
  // method the engine can report, plus one it cannot.
  const execAccess = (method: string): { verdict: string; tone: string; headline: string } => {
    const a = executiveAnswers(EXEC_DATA, EXEC_FLEET, accessVerdictFromCaller(asCaller(method), true)).find((x) => x.key === "access");
    return { verdict: a?.verdict ?? "", tone: a?.tone ?? "", headline: a?.headline ?? "" };
  };
  for (const m of ["access", "passkey", "oidc", "saml"]) {
    const a = execAccess(m);
    eq(`the executive card calls a ${m} session attributable`, [a.verdict, a.tone], ["Named people", "good"]);
    ok(`and never says "Shared token" of a ${m} session`, !/[Ss]hared token/.test(a.headline));
  }
  eq("a recovery-code session is its own honest watch, not the shared token", execAccess("recovery").verdict, "Recovery sign-in");
  ok("and it is not slandered as the break-glass token either", !/[Ss]hared token/.test(execAccess("recovery").headline));
  eq("the genuine break-glass token still reads Shared token", execAccess("token").verdict, "Shared token");
  eq("and a method from a FUTURE engine reads Unknown, not the break-glass posture", execAccess("quantum-attest").verdict, "Unknown");

  // The onboarding readiness checklist, whose copy matches the customer-facing scenario verbatim.
  const signIn = (method: string): string => onboardingSignInItem(accessVerdictFromCaller(asCaller(method), true)).textContent ?? "";
  for (const m of ["access", "passkey", "oidc", "saml"]) {
    ok(`the readiness checklist calls a ${m} session verified`, /Sign-in: verified/.test(signIn(m)));
    ok(`and never tells a ${m} customer "Token fallback in use"`, !/[Tt]oken fallback/.test(signIn(m)));
  }
  ok("the genuine token session still reads token fallback there", /Token fallback in use/.test(signIn("token")));
  ok("and a future method reads 'not recognised', not the break-glass claim", /not recognised/.test(signIn("quantum-attest")) && !/[Tt]oken fallback/.test(signIn("quantum-attest")));

  // THE SKEW ROW IS WRITTEN FROM THOSE SURFACES TOO: an unrecognised method must not render the false
  // break-glass claim while recording nothing, leaving the support engineer holding the pack unable to explain
  // the screenshot that generated the ticket.
  resetRing();
  setActiveScreen("overview");
  execAccess("quantum-attest");
  eq("the executive surface records the unknown method it was handed", rows().filter((r) => r.fieldClass === "auth-method" && r.anomaly === "unknown-enum").length, 1);
  resetRing();
  signIn("quantum-attest");
  eq("the onboarding checklist records it too", rows().filter((r) => r.fieldClass === "auth-method" && r.anomaly === "unknown-enum").length, 1);
  resetRing();
  setActiveScreen("overview");
  for (const m of ["access", "passkey", "oidc", "saml", "recovery", "token"]) { execAccess(m); signIn(m); }
  eq("NOISE: and not one of the engine's six live methods writes a row from either surface", rows().filter((r) => r.fieldClass === "auth-method").length, 0);

  // THE SAME RISK ON THE RUN-STATUS ENUM. The engine has long minted "abandoned" and deliberately preserves it
  // for the console to display; if the console's union omitted it, an abandoned run would reach the
  // unknown-enum branch and stamp version skew on a legitimate, current engine.
  resetRing();
  setActiveScreen("overview");
  const fresh = (latestStatus: string, lastGoodAt: string | null): string =>
    classifyFreshness({
      enabled: true, hasConfig: true, haveHistory: true, haveDownpipes: true,
      latestStatus: latestStatus as never, lastGoodAt, cadenceSeconds: 3600,
      now: Date.parse("2026-07-10T00:00:00Z"), pendingWhenNoRuns: false,
    });
  fresh("abandoned", null);
  eq("an ABANDONED run is a KNOWN terminal state and records no skew", rows().filter((r) => r.fieldClass === "status-enum").length, 0);
  fresh("quantum-sealed", null);
  eq("a status from a FUTURE engine still does", rows().filter((r) => r.fieldClass === "status-enum").length, 1);

  // THE FALSE SAFETY CLAIM. An unparseable last-good stamp must not fall through to "healthy": that would let a
  // downpipe that has not run in a month read FRESH on the map. The stamp reads as an honest unknown: no green
  // claim is made on a backup nobody can date.
  resetRing();
  setActiveScreen("overview");
  eq("a good, current run still reads healthy", fresh("ok", "2026-07-09T23:00:00Z"), "healthy");
  eq("a good run older than its cadence still reads stale", fresh("ok", "2026-06-01T00:00:00Z"), "stale");
  eq("a CORRUPT last-good stamp does not read FRESH (no false safety claim is made)", fresh("ok", "not-a-date"), "unknown");
  const staleRow = rows().filter((r) => r.fieldClass === "timestamp");
  eq("and the corruption is a row, so the unknown is explicable", staleRow.length, 1);
  eq("as an unparseable stamp", staleRow[0]?.anomaly, "unparseable");

  // THE FIVE COARSENED FAMILIES: each renders a plausible-looking verdict from a value the console could not
  // read, and each must produce a row, not silence.
  resetRing();
  recordWireAnomaly("auth-method", "unknown-enum");
  recordWireAnomaly("status-enum", "unknown-enum");
  recordWireAnomaly("source-kind", "unknown-enum");
  recordWireAnomaly("timestamp", "unparseable");
  recordWireAnomaly("bytes", "non-finite");
  eq("five coarsened families produce FIVE distinct rows", rows().filter((r) => r.kind === "wire-anomaly").length, 5);

  // fieldClass AND anomaly are both in the tuple key. A timestamp that would not PARSE (corruption) and one that
  // arrived NON-FINITE are different faults on the same family; an unknown status ENUM and an unknown SOURCE
  // KIND are the same fault on different families. Either field outside the key and these collapse.
  resetRing();
  recordWireAnomaly("timestamp", "unparseable");
  recordWireAnomaly("timestamp", "non-finite");
  eq("same family, DIFFERENT anomaly -> two rows", rows().length, 2);
  resetRing();
  recordWireAnomaly("status-enum", "unknown-enum");
  recordWireAnomaly("source-kind", "unknown-enum");
  eq("same anomaly, DIFFERENT family -> two rows", rows().length, 2);

  // NO-CUSTODY: the unrecognised value may be attacker- or corruption-influenced, and on the topology it can be
  // a customer-named source kind. It never rides.
  resetRing();
  accessVerdictFromCaller(asCaller("evil-method-with-a-payload"), true);
  ok("the unrecognised value never reaches the wire", !wire().includes("evil-method"));
}

// ---- Never-reported is not "catching up" -----------------------------------------------------------------
{
  console.log("\n-- never-reported replication destination --");

  // A complete DestReplState. summariseReplication reads only holdsRunId and lastOk, but the fixture
  // has to satisfy the whole shape or it is not the thing the function is documented to take.
  // lastAttemptAt is epoch millis, not the ISO string this helper used to pass under a stale name.
  const st = (holdsRunId: string, lastOk: boolean): DestReplState =>
    ({ holdsRunId, holdsIndex: 0, lastOk, lastAttemptAt: Date.parse("2026-07-01T00:00:00.000Z") });

  // THE TWO STATES THE CONSOLE FOLDED TOGETHER, and they call for OPPOSITE actions. `dest-b` has REPORTED and is
  // behind: it is reachable, its last attempt succeeded, it does not yet hold the latest run, and it will catch
  // up. `dest-c` has never been reported on AT ALL: there is no replication row for it anywhere, no copy is
  // being attempted, and it will stay amber for as long as anyone looks at it. The console told the operator to
  // wait, for weeks, for a copy that was never being made.
  //
  // Row absence alone cannot carry that claim: asserting it on row absence alone cries wolf at every destination
  // an operator has just added. The ANCHOR carries it instead: sealedRuns (successful backups
  // for all time) minus the destination's anchor (that count when it joined the fan-out) = how many backups have
  // succeeded and still produced no copy. It is the SAME anchor the support pack projects and the bot gates on,
  // and the bar is the same too: two. DARK anchors dest-c at 0 against 9 successful runs.
  const DARK = { sealedRuns: 9, anchors: { "dest-a": 0, "dest-b": 0, "dest-c": 0 } };
  const s = summariseReplication(
    ["dest-a", "dest-b", "dest-c"],
    { "dest-a": st("r4", true), "dest-b": st("r3", true) },
    "r4",
    DARK,
  );
  eq("the REPORTED-but-behind destination is 'catching up'", s.pendingIds, ["dest-b"]);
  eq("the NEVER-REPORTED destination is called what it is", s.neverReportedIds, ["dest-c"]);
  ok("and it is not folded into 'catching up'", !s.pendingIds.includes("dest-c"));
  eq("an unreachable destination stays its own state (down, not never-reported)", s.downIds, []);

  // THE CRY-WOLF, THE OTHER WAY ROUND. Same fleet, same absent row, ONE difference: dest-c joined the fan-out at
  // the current count, so no backup has succeeded since the operator added it. It is owed no copy, and calling it
  // never-reported here is a false alarm on a configuration that is behaving perfectly. It is catching up.
  const fresh = summariseReplication(
    ["dest-a", "dest-b", "dest-c"],
    { "dest-a": st("r4", true), "dest-b": st("r3", true) },
    "r4",
    { sealedRuns: 9, anchors: { "dest-a": 0, "dest-b": 0, "dest-c": 9 } },
  );
  eq("CRY-WOLF: a destination added minutes ago is NOT never-reported", fresh.neverReportedIds, []);
  eq("CRY-WOLF: it is counted as catching up, which is exactly what it is doing", fresh.pendingIds, ["dest-b", "dest-c"]);

  // HONEST ABSENCE: with no anchor at all (a legacy record, or an engine that does not send one) the age of the
  // silence cannot be established, so NO claim is made about it. The bot is held to the same silence.
  const unanchored = summariseReplication(
    ["dest-a", "dest-b", "dest-c"],
    { "dest-a": st("r4", true), "dest-b": st("r3", true) },
    "r4",
  );
  eq("an UNANCHORED silent destination is never guessed into a fault", unanchored.neverReportedIds, []);

  // The distinguishing case in full: four fan-out destinations, one holding, one behind, one down, one dark.
  // Four states, four buckets, no overlap.
  const s2 = summariseReplication(
    ["a", "b", "c", "d"],
    { a: st("r4", true), b: st("r3", true), c: st("r3", false) },
    "r4",
    { sealedRuns: 9, anchors: { a: 0, b: 0, c: 0, d: 0 } },
  );
  eq("holds / behind / down / never-reported are four distinct buckets", [s2.copies, s2.pendingIds, s2.downIds, s2.neverReportedIds], [1, ["b"], ["c"], ["d"]]);

  // A healthy fan-out reports nothing anomalous: no cry-wolf.
  const healthy = summariseReplication(["a", "b"], { a: st("r4", true), b: st("r4", true) }, "r4", { sealedRuns: 9, anchors: { a: 0, b: 0 } });
  eq("a fully-replicated downpipe reports no never-reported destination", healthy.neverReportedIds, []);
  eq("and reads as full", healthy.redundancy, "full");
}

console.log(failures === 0 ? "\nsupport posture gaps (group 2): all checks passed" : `\nsupport posture gaps (group 2): ${failures} FAILED`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
process.exit(failures === 0 ? 0 : 1);
