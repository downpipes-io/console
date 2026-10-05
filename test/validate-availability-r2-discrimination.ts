// Validates that the console's availability diagnostics DISCRIMINATE between states that a support engineer,
// holding only the pack, must be able to tell apart. A row that exists but is too generic, a field left out of
// the ring's coalescing tuple key, or a row annihilated by a reload the flow itself performs, all destroy that
// discrimination just as surely as recording nothing at all.
//
// SO THIS SUITE ASSERTS ONE THING AND IT IS NOT "A ROW WAS RECORDED". For each pair below it NAMES the states
// that must not be indistinguishable, DRIVES each of them through the real fault site, and asserts they produce
// DIFFERENT ROWS in the payload the console would actually POST. Two states that must be told apart producing
// one coalesced row is a FAILURE here.
//
// Coverage, by the pair each check must separate:
//   a RUNNING bundle with no version stamp  vs  an ORIGIN that served assets with no version stamp
//   a confirmed post-apply check that survives the reload  vs  a check that never ran
//   an Owner whose gates were computed before the identity landed  vs  a genuine viewer
//   a whoami 404 (the engine does not serve the route)  vs  a whoami 403 (the engine refused the caller)
//   the config-approvals inbox frozen on skeletons  vs  the owner-approvals inbox frozen on skeletons
//   one blocked run seen by two code paths  ->  ONE row, not two
//   a readiness poll that never once read the engine  vs  one told the break-glass key was absent
//     vs  one told BOTH keys were absent
//   an update channel whose signature is failing  vs  one that cannot be reached  vs  a healthy one
//   a CONSOLE_ORIGIN block  vs  a genuinely dead engine
//   the engine's 400 for a bad signature  vs  for a failed shape check  vs  for the no-custody gate
//
// Run with `node test/validate-availability-r2-discrimination.ts`.

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { packPayload, recordConsoleBuildCheck, recordIdentityUnresolved, recordOnboardingStep, recordRecoveryRefusal, reset as resetRing, setActiveScreen } from "../src/lib/client-diag/ring.ts";
import { screenFromPattern, classifyChannelReason } from "../src/lib/client-diag/classify.ts";
import { noteUnhandledRejection } from "../src/lib/client-diag/window-faults.ts";
import { currentScreenGatedBlind, noteGateComputedBlind, noteIdentityLanded, resetIdentityGateWitness } from "../src/lib/client-diag/identity-gate.ts";
import { classifyNetworkBlock, recordNetworkBlock, resetTransportProbe } from "../src/lib/client-diag/transport-probe.ts";
import { updateChipView } from "../src/lib/app-refresh.ts";
import { connect } from "../src/lib/store.ts";
import { reportPlanHashFailed, resetGateBlockLatches } from "../src/screens/restore-flow/shared.ts";
import { refusalClassToCode } from "../src/lib/recovery-refusal-codes.ts";
import { controlPlaneImport, controlPlaneRestore } from "../src/lib/api/client-control-plane.ts";
import { Transport } from "../src/lib/api/client-transport.ts";
import type { ClientDiagnosticRecord } from "../src/lib/client-diag/vocab.ts";
import type { UpdateStatus } from "../src/lib/api/types/updates.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}`);
    failures++;
  }
}
function eq(label: string, actual: unknown, expected: unknown): void {
  ok(`${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`, JSON.stringify(actual) === JSON.stringify(expected));
}
function section(title: string): void {
  console.log(`\n-- ${title} --`);
}

// rows returns the records the console would actually POST, filtered to one kind. Read from packPayload(), NOT
// from the ring's internals: a field that survives the ring and is dropped by the payload projection is exactly
// the failure mode that got half of this wave refuted, so the assertions must read what goes on the wire.
function rows(kind: string): ClientDiagnosticRecord[] {
  return packPayload().records.filter((r) => r.kind === kind);
}
// distinct asserts that a set of driven states produced DIFFERENT rows: n states in, n rows out, no coalescing.
function distinct(label: string, kind: string, n: number): ClientDiagnosticRecord[] {
  const rs = rows(kind);
  eq(label, rs.length, n);
  return rs;
}
// A stable key for a row's closed fields, so "these two rows are not the same row" is asserted, not eyeballed.
function tupleOf(r: ClientDiagnosticRecord): string {
  const { count: _c, firstMs: _f, lastMs: _l, ...closed } = r;
  return JSON.stringify(closed, Object.keys(closed).sort());
}
function allTuplesDiffer(label: string, rs: ClientDiagnosticRecord[]): void {
  ok(label, new Set(rs.map(tupleOf)).size === rs.length);
}

function resetAll(): void {
  resetRing();
  resetIdentityGateWitness();
  resetGateBlockLatches();
  resetTransportProbe();
}

// ==============================================================================================
section("the RUNNING bundle's missing stamp is not the ORIGIN's missing stamp");
// ==============================================================================================
//
// THE RISK. The licence screen fires recordConsoleBuildCheck("unstamped") when THIS RUNNING BUNDLE carries no
// baked version define. The post-apply check fires recordConsoleBuildCheck("unstamped") when THE ORIGIN's
// /__build.json answers valid JSON with no version. If both pushed {console-build-check, updates, unstamped},
// the tuple key built from exactly those fields would coalesce THE TWO INTO ONE ROW with a bumped count, and
// support could not tell "the update verdict was computed blind, no apply ever happened" from "an apply landed
// assets carrying no stamp". Different remedies need different rows.

resetAll();
recordConsoleBuildCheck("running-unstamped"); // the licence screen: this tab's bundle has no baked version
recordConsoleBuildCheck("unstamped"); // the post-apply check: the ORIGIN served assets with no version
const bc = distinct("the running-bundle fact and the origin fact are TWO rows, not one coalesced row", "console-build-check", 2);
allTuplesDiffer("and their tuples genuinely differ", bc);
eq("the running-bundle row carries running-unstamped", bc[0]!.buildCheckClass, "running-unstamped");
eq("the origin row carries unstamped", bc[1]!.buildCheckClass, "unstamped");

// The other four post-apply outcomes must remain mutually distinct: `confirmed` is not `wrong-version` is not
// `unreachable` is not `non-json`. (The gap's whole point is that "not confirmed" covered four remedies.)
resetAll();
recordConsoleBuildCheck("confirmed");
recordConsoleBuildCheck("wrong-version");
recordConsoleBuildCheck("unreachable");
recordConsoleBuildCheck("non-json");
allTuplesDiffer("all four post-apply outcomes stay distinct", distinct("four outcomes, four rows", "console-build-check", 4));

// ==============================================================================================
section("`confirmed` survives the reload the flow itself performs");
// ==============================================================================================
//
// THE RISK. The check records `confirmed` and then calls location.reload() ~1.5s later to finish the update. The
// ring is in-memory, so without a handoff the confirmed row would be written and ANNIHILATED on every
// successful console apply, always, on the happy path: "no console-build-check row after an applied console
// update" would be the GUARANTEED state, byte-identical to "the check never ran", and its absence would be
// treated as a fact when it is not one.
//
// The value must cross the one reload through a closed-class handoff. Simulated here: stash, wipe the ring (the
// reload), drain.

const { stashBuildCheck, drainBuildCheckHandoff } = await import("../src/lib/client-diag/reload-handoff.ts");

resetAll();
stashBuildCheck("confirmed");
resetRing(); // <- the reload: the in-memory ring is gone
eq("the ring is empty immediately after the reload, as it always was", rows("console-build-check").length, 0);
drainBuildCheckHandoff(); // <- boot
const confirmed = distinct("the confirmed row is BACK after the reload", "console-build-check", 1);
eq("and it is the confirmed class", confirmed[0]!.buildCheckClass, "confirmed");

// The negative: a tab that never ran a build check drains nothing, so absence still means absence.
resetAll();
drainBuildCheckHandoff();
eq("a tab that never ran a check produces NO row (absence is still absence)", rows("console-build-check").length, 0);

// And the handoff is drained exactly once: a second pack from the same tab must not double-count it.
resetAll();
stashBuildCheck("confirmed");
drainBuildCheckHandoff();
drainBuildCheckHandoff();
eq("the handoff is consumed on first drain, so it cannot double-count", rows("console-build-check").length, 1);

// A hostile/corrupt storage entry cannot put a value in the pack: it fails CLOSED, never coerced to a member.
resetAll();
sessionStorage.setItem("dp.buildcheck.handoff", "customer-secret-value");
drainBuildCheckHandoff();
eq("a non-member handoff value is DROPPED, never coerced to a class", rows("console-build-check").length, 0);

// ==============================================================================================
section("an Owner gated before the identity landed is not a genuine viewer");
// ==============================================================================================
//
// THE RISK. recordIdentityUnresolved fires ONLY when whoami THROWS. The ticket's state involves no throw:
// router.start() paints the screen before the boot identity round trip returns, the gates read
// caller()?.role ?? "viewer", and nothing re-renders when the identity lands. An actual Owner deep-linking to
// /security would then see every control greyed "owner only" while the whoami read SUCCEEDED, and the pack
// would carry NO ROW AT ALL -- BYTE-IDENTICAL to the pack of a genuine viewer. This check ends that confusion.

// STATE A: the race. A gated screen renders while identity is unresolved; the identity then lands.
resetAll();
setActiveScreen("/security");
noteGateComputedBlind(); // the security-centre callerRole() falling back to "viewer"
noteIdentityLanded(); // whoami returns, and nothing re-renders the screen
const raced = distinct("the raced gate produces a row", "identity-stale-gate", 1);
eq("naming the screen whose gates were computed blind", raced[0]!.screen, "security");

// STATE B: a genuine viewer. Identity resolved BEFORE the screen rendered, so the gate is correct.
resetAll();
noteIdentityLanded(); // whoami returned first
setActiveScreen("/security");
noteGateComputedBlind(); // a genuine viewer's gate: caller is known, this would not even fire
eq("a genuine viewer produces NO row (the gate was computed from a real report)", rows("identity-stale-gate").length, 0);
ok("STATE A and STATE B are DIFFERENT evidence", true);

// And the row says NOTHING about the role that came back: a role is a customer value.
resetAll();
setActiveScreen("/security");
noteGateComputedBlind();
noteIdentityLanded();
ok("the stale-gate row carries no role, email or subject", !/role|email|subject|owner/i.test(JSON.stringify(rows("identity-stale-gate"))));

// Two different gated screens raced = two rows, one per screen; one screen raced twice = one row.
// (/credentials is deliberately NOT the second screen: it maps into the same frozen `security` bucket, so it is
// the same screen for this purpose. /notifications is its own bucket and is a genuinely different gated screen.)
resetAll();
setActiveScreen("/security");
noteGateComputedBlind();
noteGateComputedBlind(); // the same screen re-renders: still ONE fact, not two
setActiveScreen("/notifications");
noteGateComputedBlind();
noteIdentityLanded();
const raced2 = rows("identity-stale-gate");
eq("two raced screens are two rows; one screen raced twice is still one", raced2.length, 2);
allTuplesDiffer("and they name their own screens", raced2);

// currentScreenGatedBlind is the seam app.ts reads at identity-land so reRenderCurrentScreenForResolvedIdentity
// can re-render a screen whose LATE gate ran blind even when the resolved caller's render key is UNCHANGED (a
// same-identity re-resolve). It must report the CURRENT screen's held-blind state, and only until identity lands.
resetAll();
setActiveScreen("/notifications");
ok("before any blind gate, currentScreenGatedBlind is false", currentScreenGatedBlind() === false);
noteGateComputedBlind(); // the notifications channels writeGate falling back to viewer inside its list-GET .then()
ok("after a blind gate on this screen, currentScreenGatedBlind is true (drives the additive re-render)", currentScreenGatedBlind() === true);
setActiveScreen("/security");
ok("it reports the CURRENT screen, so a different screen that did not race reads false", currentScreenGatedBlind() === false);
setActiveScreen("/notifications");
noteIdentityLanded(); // identity lands: the witness is consumed and cleared
ok("once identity has landed the witness is cleared, so it is one-shot and never re-fires the re-render", currentScreenGatedBlind() === false);

// ==============================================================================================
section("a whoami 404 (route absent) is not a whoami 403 (refused)");
// ==============================================================================================
//
// THE RISK. recordIdentityUnresolved carrying httpClass ONLY is not enough, because httpClassForStatus collapses
// 401, 403 and 404 alike to "4xx". A whoami 404 -- AN OLDER ENGINE THAT DOES NOT SERVE THE ROUTE, the cause of
// the "identity pending" chip the console's own comment names -- and a whoami 403 would then produce the
// byte-identical row {identity-unresolved, screen, 4xx} and COALESCE into it. Route-absent is exactly the state
// that must be told apart. faultClass separates them.

const httpErr = (status: number): Error => Object.assign(new Error(`engine error ${status}`), { status });

resetAll();
setActiveScreen("/security");
recordIdentityUnresolved("4xx", httpErr(404)); // an engine that does not serve /who at all
recordIdentityUnresolved("4xx", httpErr(403)); // an engine that refused this caller
const idu = distinct("a 404 and a 403 on whoami are TWO rows, not one coalesced 4xx row", "identity-unresolved", 2);
allTuplesDiffer("and their tuples genuinely differ", idu);
ok("the route-absent row says not-found (upgrade the engine)", idu.some((r) => r.faultClass === "not-found"));
ok("the refusal row says auth (fix the caller's access)", idu.some((r) => r.faultClass === "auth"));

// ==============================================================================================
section("the config-approvals inbox is not the owner-approvals inbox");
// ==============================================================================================
//
// THE RISK. A route table that maps BOTH "/config" and "/security" to the frozen `security` bucket, on a ticket
// reading "the config approvals / owner approvals / integrations page never finishes loading", risks exactly
// this: a render throw inside a .then with no .catch is nearly always a TypeError, so the two screens would emit
// the byte-identical tuple {unhandled, security, other, unhandled-rejection, TypeError} and COALESCE into ONE
// row with a bumped count, leaving two of the listed sites indistinguishable in the pack.

eq("/config/changes now maps to its own screen", screenFromPattern("/config/changes"), "config-changes");
eq("/security/owner-actions now maps to its own screen", screenFromPattern("/security/owner-actions"), "owner-actions");
eq("the /config family still falls to security", screenFromPattern("/config/history"), "security");
eq("the /security family still falls to security", screenFromPattern("/security"), "security");

resetAll();
setActiveScreen("/config/changes");
noteUnhandledRejection(new TypeError("Cannot read properties of undefined")); // the frozen skeleton, config approvals
setActiveScreen("/security/owner-actions");
noteUnhandledRejection(new TypeError("Cannot read properties of undefined")); // the frozen skeleton, owner approvals
const crashes = distinct("the two frozen approval inboxes are TWO rows, not one coalesced row", "unhandled", 2);
allTuplesDiffer("and their tuples genuinely differ", crashes);
eq("the config-approvals row names its screen", crashes[0]!.screen, "config-changes");
eq("the owner-approvals row names its screen", crashes[1]!.screen, "owner-actions");

// ==============================================================================================
section("one blocked run seen by two code paths is ONE row, not two");
// ==============================================================================================
//
// THE RISK. The plan step and the approval recheck BOTH observe the same null plan hash for the same run. If
// each called recordRestoreGateBlocked directly, one blocked run would increment plan-hash-failed twice.
// `count` is what a support engineer reads as severity, so it must mean "how many plans were blocked this way",
// not "how many code paths noticed".

resetAll();
reportPlanHashFailed("run-a"); // the plan step's swallowed restorePlanHash catch
reportPlanHashFailed("run-a"); // the first approval recheck, seeing the same null hash
const gb = distinct("one blocked run is one row", "restore-gate-blocked", 1);
eq("with a count of 1, not 2", gb[0]!.count, 1);
reportPlanHashFailed("run-b"); // a SECOND run blocked the same way still counts
eq("a second blocked run still increments the count", rows("restore-gate-blocked")[0]!.count, 2);

// ==============================================================================================
section("a poll that never read the engine is not a poll told the keys were absent");
// ==============================================================================================
//
// THE RISK. If the poll loop's catch leg swallows a thrown tick and FALLS THROUGH to the same exhaustion branch
// as a tick that succeeded and reported the keys absent, THREE states produce the byte-identical, coalescing
// row {onboarding-step, boot, readiness-poll, poll-exhausted}:
//   (1) the engine answered 40 times: signer present, break-glass ABSENT   (the HALF-KEYED engine)
//   (2) the engine answered 40 times: BOTH absent                          (the install never took)
//   (3) the engine was NEVER ONCE READ; every tick threw                   (it went away mid-wizard)
// State (3) is a different fault with a different remedy from (1) and (2), and (1) differs from (2). The
// operator's report ("it sat on Waiting for two minutes") is the same sentence for all three.

resetAll();
recordOnboardingStep("readiness-poll", "readiness-unread"); // state (3): never got an answer
recordOnboardingStep("readiness-poll", "poll-exhausted", "break-glass"); // state (1): half-keyed
recordOnboardingStep("readiness-poll", "poll-exhausted", "signer"); // state (2), first half
const ob = distinct("the three poll endings are THREE rows, not one", "onboarding-step", 3);
allTuplesDiffer("and their tuples genuinely differ", ob);
ok("state (3) is legible on its own: the engine was never read", ob.some((r) => r.obOutcome === "readiness-unread" && r.obSecret === undefined));
ok("state (1) names the break-glass key as the one still absent", ob.some((r) => r.obOutcome === "poll-exhausted" && r.obSecret === "break-glass"));
ok("state (2) names the signer too, so a half-keyed engine (1 row) differs from an unkeyed one (2 rows)", ob.some((r) => r.obSecret === "signer"));

// The install step now has a caller on the REAL install path, with the class that separates the fault the engine
// can never see (the POST never arrived) from the one it records itself (it answered and refused).
resetAll();
recordOnboardingStep("install", "transport-error"); // the POST never reached the engine: no engine-side record can exist
recordOnboardingStep("install", "engine-not-ok"); // the engine answered and refused: it recorded its own half
allTuplesDiffer("an install the engine never saw differs from one it refused", distinct("two install outcomes, two rows", "onboarding-step", 2));

// ==============================================================================================
section("a channel whose signature is failing is not a healthy channel");
// ==============================================================================================
//
// THE RISK. The engine RETURNS the channel verdict to the console ({configured, verified, reason}). If the
// console read it, hid the chip, and threw it away, then (a) a signature broken for six weeks with the operator
// two releases behind, and (b) a healthy verified channel with nothing new, would BOTH produce: no chip, zero
// admin-write rows (nobody attempted a write because nobody knew there was an update), and
// status.updateChannelConfigured = true, which is Boolean(env.UPDATE_CHANNEL_URL && env.UPDATE_SIGNER_PUBLIC) --
// an env-var presence check that stays true while the signature fails for a month. THAT IS NOT A VERDICT, and
// the two packs would be identical.

// channelIntended is TRUE on this helper because it is what the emit is now keyed on: it is the operator's
// INTENT (either channel env var set), not the engine's `configured` VERDICT, which goes false for a mangled
// signer key and a bad URL. See validate-availability-r3-discrimination.ts, which drives those states.
const upd = (o: Partial<UpdateStatus>): UpdateStatus => ({ configured: true, verified: true, channelIntended: true, ...o }) as UpdateStatus;

// The classifier: text SELECTS a member and never passes through.
eq("a signature failure classifies as signature", classifyChannelReason("manifest signature did not verify against the configured signer"), "signature");
eq("an unreachable host classifies as unreachable", classifyChannelReason("fetch to the channel host failed"), "unreachable");
eq("a malformed manifest classifies as malformed", classifyChannelReason("could not parse the channel manifest"), "malformed");
eq("an unrecognised reason is honestly `none`, never a guess", classifyChannelReason("something we have never seen"), "none");
eq("an absent reason is `none`", classifyChannelReason(undefined), "none");

// STATE A: the signature has been failing. STATE B: the channel is unreachable. STATE C: healthy, nothing new.
resetAll();
updateChipView(upd({ verified: false, reason: "signature verification failed for the release manifest" }), "0.1.10");
updateChipView(upd({ verified: false, reason: "fetch failed: could not reach the channel host" }), "0.1.10");
const ch = distinct("a broken signature and an unreachable channel are TWO rows", "update-channel-unverified", 2);
allTuplesDiffer("and their tuples genuinely differ", ch);
ok("the signature row says so", ch.some((r) => r.channelReasonClass === "signature"));
ok("the unreachable row says so", ch.some((r) => r.channelReasonClass === "unreachable"));

resetAll();
updateChipView(upd({ verified: true, updateAvailable: false }), "0.1.10"); // healthy, nothing new
eq("a HEALTHY verified channel produces NO row (no cry-wolf on the working path)", rows("update-channel-unverified").length, 0);
resetAll();
updateChipView(upd({ configured: false, verified: false, channelIntended: false }), "0.1.10"); // a customer who never configured one
eq("an UNCONFIGURED channel produces NO row (it is a legitimate choice, not a fault)", rows("update-channel-unverified").length, 0);
ok("'signature broken for six weeks' and 'healthy and up to date' are DIFFERENT evidence", true);

// ==============================================================================================
section("a CONSOLE_ORIGIN block is not a dead engine");
// ==============================================================================================
//
// THE RISK, TWICE OVER. `origin-rejected` is the CORS fingerprint, and it is unreachable in the very scenario
// it is meant to fingerprint unless two conditions hold:
//   1. Every blockError site must pass healthReachable, or a CORS block records as engine-unreachable BY
//      CONSTRUCTION -- the same row a dead engine writes, coalescing into it.
//   2. /admin/health must not sit behind the SAME origin-equality CORS gate as every data route, or when
//      CONSOLE_ORIGIN is wrong the browser blocks the health probe TOO and the fingerprint cannot fire.
// The engine serves /admin/health with a wildcard origin and no credentials, and the console probes it itself
// at the one render seam every screen's transport error passes through.

// The probe reads the connected engine base, exactly as it does in production: blockError only ever renders for a
// request that was actually made, so an engine URL is always set by the time it runs.
connect("https://engine.example.invalid");

eq("health ANSWERED while the data call was blocked -> origin-rejected (set CONSOLE_ORIGIN)", classifyNetworkBlock(true), "origin-rejected");
eq("health SILENT too -> engine-unreachable (the engine is down)", classifyNetworkBlock(false), "engine-unreachable");

// Driven through the real recorder, with the health probe as the only difference between the two worlds.
const healthUp: typeof fetch = () => Promise.resolve(new Response("{}", { status: 200 }));
const healthDown: typeof fetch = () => Promise.reject(new TypeError("Failed to fetch"));

resetAll();
setActiveScreen("/");
await recordNetworkBlock(healthUp, Date.now()); // CONSOLE_ORIGIN is wrong: engine is up, data calls blocked
const cors = distinct("a CORS block records one transport-fault row", "transport-fault", 1);
eq("and it says origin-rejected", cors[0]!.transportClass, "origin-rejected");

resetAll();
setActiveScreen("/");
await recordNetworkBlock(healthDown, Date.now()); // the engine is genuinely down
const outage = distinct("a dead engine records one transport-fault row", "transport-fault", 1);
eq("and it says engine-unreachable", outage[0]!.transportClass, "engine-unreachable");
ok("the two states do not produce the byte-identical row", cors[0]!.transportClass !== outage[0]!.transportClass);

// Both together in one session: two rows, not one coalesced row.
resetAll();
setActiveScreen("/");
await recordNetworkBlock(healthUp, Date.now());
resetTransportProbe();
await recordNetworkBlock(healthDown, Date.now() + 10_000);
allTuplesDiffer("a CORS block and an outage in one session are two rows", distinct("two states, two rows", "transport-fault", 2));

// ==============================================================================================
section("the engine's 400 must not be a single, undifferentiated refusal");
// ==============================================================================================
//
// THE RISK. If refusalCodeForStatus only mapped status to code, DP-R12 would be EVERY 400. The ticket demands
// "wrong token vs signature vs shape vs no-custody vs not-Owner", and signature, shape-check and no-custody
// would otherwise produce the byte-identical row {recovery-refusal, screen, cp-restore, DP-R12} and COALESCE
// into it. The console cannot subdivide a 400 by reading the engine's prose (it can name a bucket or a key, and
// a classifier over a sentence the console does not own mislabels the moment the engine rewords it), so the
// ENGINE returns a CLOSED refusalClass member in the 400 body and the console admits it BY SET MEMBERSHIP.

eq("the engine's signature refusal maps to its own code", refusalClassToCode("signature"), "DP-R15");
// THE REMEDIES ARE OPPOSITE, SO THE CODES MUST BE. The engine verifies BOTH halves of the hybrid signature over
// the SAME export bytes, so a failure that leaves either half verifying PROVES the export intact and puts the
// damage in the operator's own kit file. Reading that out as DP-R15 -- the tamper code -- would tell a customer
// their disaster-recovery artefact had been attacked when the answer is "take another copy of your kit", on the
// one path where the artefact in front of them may be the only one left. DP-R15 means tamper, and only tamper.
eq("a DAMAGED Ed25519 KEY HALF (the export is provably intact) is DP-R18, NOT the tamper code", refusalClassToCode("classical-half-damaged"), "DP-R18");
eq("a rotted PQ KEY HALF is DP-R21: the same proof (the export is intact), a different thing to go and check", refusalClassToCode("signature-pq"), "DP-R21");
eq("a damaged .sig FILE is DP-R19: the export was never checked at all, so nothing here accuses it", refusalClassToCode("verify-threw"), "DP-R19");
eq("an UNIMPORTABLE kit key is DP-R20", refusalClassToCode("verifier-invalid"), "DP-R20");
ok(
  "DISCRIMINATION: the FIVE verify verdicts are FIVE codes -- one branch, one code, nothing coalesces, and a damaged kit cannot reach the tamper one",
  new Set(["signature", "classical-half-damaged", "signature-pq", "verify-threw", "verifier-invalid"].map(refusalClassToCode)).size === 5 && refusalClassToCode("classical-half-damaged") !== refusalClassToCode("signature"),
);
eq("the engine's shape refusal maps to its own code", refusalClassToCode("shape"), "DP-R16");
eq("the engine's no-custody refusal maps to its own code", refusalClassToCode("no-custody"), "DP-R17");
eq("an UNRECOGNISED member falls back to DP-R12, so the mapper is total and an old engine still works", refusalClassToCode("something-new"), "DP-R12");
eq("an absent refusalClass falls back to DP-R12", refusalClassToCode(undefined), "DP-R12");
ok("a customer value in the refusalClass field is DROPPED, never carried", refusalClassToCode("bucket-acme-prod-secrets") === "DP-R12");

resetAll();
setActiveScreen("/settings");
recordRecoveryRefusal("cp-restore", refusalClassToCode("signature"));
recordRecoveryRefusal("cp-restore", refusalClassToCode("shape"));
recordRecoveryRefusal("cp-restore", refusalClassToCode("no-custody"));
const rr = distinct("signature, shape and no-custody are THREE rows, not one DP-R12", "recovery-refusal", 3);
allTuplesDiffer("and their tuples genuinely differ", rr);

// THE MAPPER IS NOT THE WIRE. Calling refusalClassToCode with a bare class string, as the assertions above do,
// leaves untested the whole path from the engine's RESPONSE BYTES to the code, and that path can break: if the
// client reads the body, CLAMPS IT TO 300 CHARACTERS FOR THE SCREEN, and hands the clamped string to the JSON
// parse, then because `refusalClass` is the LAST key the engine serialises, any refusal whose prose runs past
// the cut has its JSON severed mid-string, the parse throws, and the class silently degrades to DP-R12: the
// catch-all, byte-identical to a plane that is not empty. The partial-signer-rotation body is 504 characters, so
// it would land there every time. So this drives the REAL client against the ENGINE'S REAL BYTES.
//
// The four sentences below are the engine's own (admin/router-identity.ts recoveryVerifySentence + jsonRefusal),
// and the long one is kept long ON PURPOSE: it is the case that must not regress.
const ENGINE_400 = (error: string, refusalClass: string): string => JSON.stringify({ error, refusalClass });
const PQ_SENTENCE =
  "the export's classical signature half verified and its post-quantum half did not. The export itself is INTACT (a modified export fails the classical half first), so this is not tampering: what is wrong is confined to the post-quantum half of the key. Either this export was signed by a different or partially rotated signer, or the ML-DSA half of your recovery kit's signer.pub is damaged. Check which signer signed this export, and take a fresh copy of the key.";
const SIG_DECODE_SENTENCE =
  "the export's detached signature could not be READ (it is not a well-formed signature blob), so the export was never checked at all. This is a damaged signature FILE, not evidence of tampering: take a fresh copy of the export and its .sig and try again.";

ok("the partial-rotation body genuinely runs past the 300-char display clamp (so the clamp path is exercised for real)", ENGINE_400(PQ_SENTENCE, "signature-pq").length > 300);

// stubEngine answers every request with one canned engine response, so the client's OWN body handling runs.
const realFetch = globalThis.fetch;
const stubEngine = (status: number, body: string): void => {
  globalThis.fetch = (() => Promise.resolve(new Response(body, { status, headers: { "content-type": "application/json" } }))) as typeof fetch;
};
const restoreFetch = (): void => {
  globalThis.fetch = realFetch;
};

// driveRestore/driveImport run the REAL api client (Transport + the real free functions), swallowing the throw the
// screens already catch, and return the recovery-refusal rows the ring holds afterwards.
const t = new Transport("https://engine.example.invalid");
const driveRestore = async (status: number, body: string): Promise<void> => {
  stubEngine(status, body);
  await controlPlaneRestore(t, "break-glass-token", { v: 1 }, "sig").catch(() => undefined);
  restoreFetch();
};
const driveImport = async (status: number, body: string): Promise<void> => {
  stubEngine(status, body);
  await controlPlaneImport(t, { v: 1 }, "sig", "signer.pub").catch(() => undefined);
  restoreFetch();
};
const lastRecoveryCode = (): string | undefined => {
  const rows = packPayload().records.filter((r) => r.kind === "recovery-refusal");
  return rows[rows.length - 1]?.recoveryCode;
};

resetAll();
setActiveScreen("/settings");
await driveRestore(400, ENGINE_400("the export signature did not verify (the wrong key, or the export was modified).", "signature"));
eq("an ALTERED export, driven through the real client, is DP-R15", lastRecoveryCode(), "DP-R15");

resetAll();
await driveRestore(400, ENGINE_400(PQ_SENTENCE, "signature-pq"));
eq("a PARTIAL SIGNER ROTATION is DP-R21, not the DP-R12 a 300-char clamp would force and not the tamper code", lastRecoveryCode(), "DP-R21");

resetAll();
await driveImport(400, ENGINE_400("the export's post-quantum signature half verified and its classical half did not.", "classical-half-damaged"));
eq("a DAMAGED RECOVERY-KIT KEY, driven through the real client, is DP-R18 -- the ticket 'estate import says signature invalid but the kit is correct'", lastRecoveryCode(), "DP-R18");

resetAll();
await driveRestore(400, ENGINE_400(SIG_DECODE_SENTENCE, "verify-threw"));
eq("a DAMAGED .sig FILE is DP-R19", lastRecoveryCode(), "DP-R19");

resetAll();
await driveImport(400, ENGINE_400("export is not a control-plane export artefact", "shape"));
eq("a failed SHAPE CHECK, driven through the real client, is DP-R16", lastRecoveryCode(), "DP-R16");

resetAll();
await driveImport(400, ENGINE_400("refused: plaintext secret in export at destinations[0].secretAccessKey", "no-custody"));
eq("the NO-CUSTODY gate, driven through the real client, is DP-R17", lastRecoveryCode(), "DP-R17");

resetAll();
await driveImport(400, ENGINE_400("estate import refused: the control plane is not empty", "reconcile-refused"));
eq("a plane that was NOT EMPTY stays on the DP-R12 catch-all", lastRecoveryCode(), "DP-R12");

resetAll();
await driveRestore(401, "nope");
eq("a wrong break-glass token is DP-R10, and no 400 body is needed to say so", lastRecoveryCode(), "DP-R10");

resetAll();
await driveImport(403, "nope");
eq("a caller who is not an Owner is DP-R11", lastRecoveryCode(), "DP-R11");

// AND THE WHOLE TICKET AT ONCE: the five states the gap enumerates, driven end to end, must be five rows.
resetAll();
setActiveScreen("/settings");
await driveRestore(401, "nope"); // wrong token
await driveImport(403, "nope"); // not an Owner
await driveRestore(400, ENGINE_400(PQ_SENTENCE, "signature-pq")); // signature
await driveImport(400, ENGINE_400("export is not a control-plane export artefact", "shape")); // shape
await driveRestore(400, ENGINE_400("refused: plaintext secret", "no-custody")); // no-custody
allTuplesDiffer(
  "wrong token vs signature vs shape vs no-custody vs not-Owner are FIVE rows in the pack, not one",
  distinct("the ticket's five states are five recovery-refusal rows", "recovery-refusal", 5),
);

// ==============================================================================================
section("no-custody: a sentinel planted at every new fault site reaches nothing on the wire");
// ==============================================================================================
//
// A CLAMP IS NOT A REDACTION. Every new field above is a closed enum, a clamped int or a boolean, so there is no
// field a customer value COULD occupy. This drives the whole wave with a sentinel planted in every text a
// classifier is allowed to READ (an engine reason, an error message, an error NAME, a refusal class) and asserts
// none of it is anywhere in the JSON the console would POST.

const SENTINEL = "acme-prod-secret-bucket-9f3c";

resetAll();
setActiveScreen("/config/changes");
noteUnhandledRejection(Object.assign(new TypeError(SENTINEL), { name: `${SENTINEL}Error` }));
recordIdentityUnresolved("4xx", Object.assign(new Error(SENTINEL), { status: 404 }));
updateChipView(upd({ verified: false, reason: `signature check failed for https://${SENTINEL}.example.com/manifest.json` }), "0.1.10");
recordRecoveryRefusal("cp-restore", refusalClassToCode(SENTINEL));
recordOnboardingStep("readiness-poll", "poll-exhausted", "break-glass");
noteGateComputedBlind();
noteIdentityLanded();
stashBuildCheck("confirmed");
drainBuildCheckHandoff();
await recordNetworkBlock(healthUp, Date.now());

const payload = packPayload();
const serialised = JSON.stringify({ clientDiagnostics: payload });
ok("the drive did produce rows (the assertion below is not vacuous)", payload.records.length >= 6);
ok("the sentinel appears NOWHERE in the payload the console would POST", !serialised.includes(SENTINEL));
ok("negative control: the sentinel IS detectable when present", JSON.stringify({ leak: SENTINEL }).includes(SENTINEL));
ok("no record carries a message/url/stack/email/reason key", !/"(message|url|stack|email|name|reason|origin|host)"/.test(serialised));

console.log(`\n${failures === 0 ? "AVAILABILITY DISCRIMINATION PASS" : `${failures} FAILURE(S)`}`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
process.exit(failures === 0 ? 0 : 1);
