// Validates two console availability gaps: a stuck readiness poll and a misclassified update-channel fault.
//
// Neither fault showed up on its own vocabulary, even though the discriminators exist, sit in the ring's
// coalescing tuple key, and are admitted by the engine and the bot. THE STATE MACHINES THAT FEED THEM WERE WRONG.
//
//   The readiness poll: startPollLoop's `everRead` and `lastRead` are closure variables that start() DOES NOT
//         RESET, and the exhaustion message tells the operator, in as many words, to press the button that
//         re-enters that same closure ("Install your keys above, then Check engine to resume"). So a second
//         run -- every tick of which throws, because installing the key secrets sets Worker secrets and that
//         is a redeploy -- sees everRead still TRUE from the first run, skips the never-read leg, and
//         re-emits the first run's rows off its STALE lastRead. Those rows coalesce by tuple key, so the pack
//         claims the engine answered eighty times and kept reporting both keys absent, when it answered forty
//         times and then died.
//
//         And there was no member for the ordinary shape of the fault at all: `everRead` is a whole-loop boolean,
//         so ONE successful early tick pins the loop into the poll-exhausted leg with a stale read. "The engine
//         answered and then went quiet" was byte-identical to "the install never took".
//
//   The update-channel gate: the emit is gated on the ENGINE'S `configured` VERDICT, which is FALSE for an
//         unparseable UPDATE_CHANNEL_URL, a non-https one, and an UPDATE_SIGNER_PUBLIC that will not parse --
//         three states in which BOTH env vars are set and the operator plainly meant to have updates. A
//         truncated paste of the pinned signer key therefore recorded NOTHING, and its pack was byte-identical
//         to a healthy channel's.
//
// SO THIS SUITE DRIVES THE REAL LOOP AND THE REAL EMIT, not the recorders: hand-feeding outcomes straight to
// recordOnboardingStep without ever calling startPollLoop is exactly how a state machine's bug can live
// undetected.
//
// Run with `node test/validate-availability-r3-discrimination.ts`.

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { packPayload, recordOnboardingStep, reset as resetRing, setActiveScreen } from "../src/lib/client-diag/ring.ts";
import { channelReasonClassFor, classifyChannelReason } from "../src/lib/client-diag/classify.ts";
import { renderReadinessPoll, engineFaultOutcome } from "../src/screens/onboarding/steps.ts";
import { updateChipView } from "../src/lib/app-refresh.ts";
import type { EngineClient } from "../src/lib/api/client.ts";
import type { ClientDiagnosticRecord } from "../src/lib/client-diag/vocab.ts";
import type { StatusReport } from "../src/lib/api/types/status.ts";
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

// The ring as the ENGINE would receive it: the payload the console actually POSTs, never the recorder's own head.
function rows(kind: string): ClientDiagnosticRecord[] {
  return (packPayload()?.records ?? []).filter((r) => r.kind === kind);
}
function tuple(r: ClientDiagnosticRecord): string {
  return `${r.kind}|${r.screen}|${r.obStep ?? ""}|${r.obOutcome ?? ""}|${r.obSecret ?? ""}|${r.channelReasonClass ?? ""}`;
}
function resetAll(): void {
  resetRing();
  setActiveScreen("/onboarding");
}
function allTuplesDiffer(label: string, rs: ClientDiagnosticRecord[]): void {
  ok(label, new Set(rs.map(tuple)).size === rs.length);
}

// ---------------------------------------------------------------------------------------------------------
// THE POLL HARNESS. startPollLoop schedules its next tick with window.setTimeout(POLL_INTERVAL_MS = 3000) and
// runs up to 40 attempts, so a REAL wait is two minutes. The delay is collapsed to zero for the duration of the
// test: the LOOP is real (the same ticks, the same budget, the same catch leg, the same exhaustion branch), only
// the clock is not. Restored afterwards.
// ---------------------------------------------------------------------------------------------------------
type TimeoutFn = typeof setTimeout;
const realSetTimeout: TimeoutFn = globalThis.setTimeout;
function collapseTimers(): void {
  (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, _ms?: number) => realSetTimeout(fn, 0)) as unknown as TimeoutFn;
}
function restoreTimers(): void {
  (globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout;
}
// settle drains the macrotask queue until the poll has run to its bound (40 ticks, each an await plus a timer).
async function settle(): Promise<void> {
  for (let i = 0; i < 600; i++) await new Promise<void>((r) => realSetTimeout(r, 0));
}

// A status the engine could really answer with. The operational pair is CLEANLY ABSENT (a legitimate
// configuration), so it never fabricates a third absent-secret row.
function status(signer: boolean, breakGlass: boolean): StatusReport {
  return { signerConfigured: signer, breakGlassConfigured: breakGlass, operationalConfigured: { public: false, private: false } } as unknown as StatusReport;
}

// engineThat builds the EngineClient the poll calls: a scripted sequence of status answers and throws. Anything
// past the end of the script repeats the last entry, so "answers k times then dies" is one line.
function engineThat(script: Array<StatusReport | "throw">): { engine: EngineClient; calls: () => number } {
  let n = 0;
  const engine = {
    status: async (): Promise<StatusReport> => {
      const step = script[Math.min(n, script.length - 1)];
      n++;
      if (step === "throw") throw new Error("the engine could not be reached");
      return step as StatusReport;
    },
  } as unknown as EngineClient;
  return { engine, calls: () => n };
}

// ==============================================================================================
section("the readiness poll's FOUR endings, driven through the real loop");
// ==============================================================================================
//
//   (1) the engine ANSWERED throughout: signer present, break-glass absent  -> poll-exhausted + obSecret break-glass
//   (2) the engine ANSWERED throughout: BOTH absent                         -> poll-exhausted + signer AND break-glass
//   (3) the engine was NEVER ONCE READ (every tick threw)                   -> readiness-unread, no obSecret
//   (4) the engine ANSWERED AND THEN WENT QUIET (final tick threw)          -> poll-went-quiet, NO obSecret
//   (5) the engine reported the keys present                                -> ok, and the loop stops
//
// (4) is the one that had no member. It is the ORDINARY shape of "the engine went away mid-wizard", and it used to
// take the poll-exhausted leg carrying a lastRead from minutes earlier, asserting on no evidence that the engine
// was still answering and still reporting the keys absent.
collapseTimers();

// (1) the HALF-KEYED engine.
resetAll();
{
  const { engine, calls } = engineThat([status(true, false)]);
  renderReadinessPoll(engine);
  await settle();
  const ob = rows("onboarding-step");
  ok("(1) half-keyed: the poll really ran to its bound (40 attempts)", calls() === 40);
  eq("(1) half-keyed: ONE row", ob.length, 1);
  ok("(1) half-keyed: poll-exhausted, naming the break-glass key and ONLY it", ob[0]?.obOutcome === "poll-exhausted" && ob[0]?.obSecret === "break-glass");
}

// (2) the install that never took.
const bothAbsent: ClientDiagnosticRecord[] = [];
resetAll();
{
  const { engine } = engineThat([status(false, false)]);
  renderReadinessPoll(engine);
  await settle();
  const ob = rows("onboarding-step");
  bothAbsent.push(...ob);
  eq("(2) unkeyed: TWO rows, one per absent key -- countably different from the half-keyed engine's one", ob.length, 2);
  ok("(2) unkeyed: the signer and the break-glass are both named", ob.some((r) => r.obSecret === "signer") && ob.some((r) => r.obSecret === "break-glass"));
  allTuplesDiffer("(2) unkeyed: and the two rows do not coalesce", ob);
}

// (3) the engine was dead before the card mounted.
resetAll();
{
  const { engine, calls } = engineThat(["throw"]);
  renderReadinessPoll(engine);
  await settle();
  const ob = rows("onboarding-step");
  ok("(3) never read: the poll really ran to its bound", calls() === 40);
  eq("(3) never read: ONE row", ob.length, 1);
  ok("(3) never read: readiness-unread, and it names NO secret (it never learned one)", ob[0]?.obOutcome === "readiness-unread" && ob[0]?.obSecret === undefined);
}

// (4) THE ENGINE ANSWERED AND THEN WENT QUIET. Three ticks answer with the keys absent, then it dies.
resetAll();
{
  const { engine } = engineThat([status(false, false), status(false, false), status(false, false), "throw"]);
  renderReadinessPoll(engine);
  await settle();
  const ob = rows("onboarding-step");
  eq("(4) went quiet: ONE row", ob.length, 1);
  ok("(4) went quiet: poll-went-quiet", ob[0]?.obOutcome === "poll-went-quiet");
  ok(
    "(4) went quiet: it names NO secret -- the last read is minutes stale and is not evidence of what the engine holds now",
    ob[0]?.obSecret === undefined,
  );
  // THE REFUTATION, ASSERTED. The old code took the poll-exhausted leg here off the stale read, so this state was
  // byte-identical to (2): an install that never took. Two opposite remedies, one row.
  ok(
    "(4) went quiet is NOT the same row as (2) the install that never took -- the pair the whole gap turns on",
    !ob.some((r) => bothAbsent.some((b) => tuple(b) === tuple(r))),
  );
}

// (5) the good ending, recorded, so its ABSENCE means something.
resetAll();
{
  const { engine, calls } = engineThat([status(false, false), status(true, true)]);
  renderReadinessPoll(engine);
  await settle();
  const ob = rows("onboarding-step");
  eq("(5) ready: ONE row", ob.length, 1);
  ok("(5) ready: readiness-poll ok", ob[0]?.obOutcome === "ok" && ob[0]?.obStep === "readiness-poll");
  ok("(5) ready: the loop STOPS on success (no 40-tick spin against a healthy engine)", calls() === 2);
}

// ==============================================================================================
section("THE DEFECT -- 'Check engine' re-enters the closure, and the run's evidence was sticky");
// ==============================================================================================
//
// The exact sequence the exhaustion message instructs the operator to perform:
//   run 1  the engine answers 40 times with BOTH keys absent            -> two poll-exhausted rows
//   the operator installs the keys. Setting Worker secrets is a REDEPLOY, and the engine goes away.
//   they press "Check engine", which is recheck.addEventListener("click", start) -- the SAME closure.
//   run 2  every tick throws                                            -> MUST be readiness-unread
//
// Before the fix, run 2 saw everRead still true from run 1, skipped the unread leg, read run 1's STALE lastRead,
// and re-emitted run 1's two rows. They coalesce by tuple key, so the pack showed two rows with count 2 and
// asserted the engine had answered EIGHTY times and kept reporting both keys absent. Support then sent the
// customer back through the key ceremony; the remedy was an unreachable engine.
resetAll();
{
  let dead = false;
  const engine = {
    status: async (): Promise<StatusReport> => {
      if (dead) throw new Error("the engine could not be reached");
      return status(false, false);
    },
  } as unknown as EngineClient;
  const { card } = renderReadinessPoll(engine);
  await settle();
  const afterRun1 = rows("onboarding-step");
  eq("run 1 exhausts with both keys absent: two rows", afterRun1.length, 2);
  const countsRun1 = afterRun1.map((r) => r.count).reduce((a, b) => a + b, 0);
  eq("with a count of one each", countsRun1, 2);

  // The operator installs, and the engine disappears. They press Check engine.
  dead = true;
  const recheck = card.querySelector("button") as HTMLButtonElement;
  ok("the exhaustion message's own button is present, and it re-enters the SAME closure", recheck !== null);
  recheck.click();
  await settle();

  const afterRun2 = rows("onboarding-step");
  ok("RUN 2 RECORDS readiness-unread: the engine was never read, which is the truth", afterRun2.some((r) => r.obOutcome === "readiness-unread"));
  const exhausted = afterRun2.filter((r) => r.obOutcome === "poll-exhausted");
  eq(
    "and run 1's poll-exhausted rows DO NOT gain a second count from a stale read -- the pack no longer claims the engine answered eighty times",
    exhausted.map((r) => r.count).reduce((a, b) => a + b, 0),
    2,
  );
  ok("so the run-2 evidence is its own, and the two runs are legible apart", afterRun2.length === 3);
}
restoreTimers();

// ==============================================================================================
section("the key PRE-CHECK is not an install, and it no longer claims to be one");
// ==============================================================================================
//
// The resumed configure card does a ONE-SHOT status read to ask "does this engine already hold its keys?". Its
// catch wrote recordOnboardingStep("install", "transport-error") UNCONDITIONALLY -- no status check of any kind --
// so an engine that ANSWERED 500 or 401 was filed under the outcome whose own vocabulary entry promises that the
// engine never saw the request and no engine-side evidence of it can exist. It then COALESCED with the genuine
// install-POST row, so {install, transport-error} could not be trusted to mean an install had been attempted.
resetAll();
{
  // The classifier that both sites now share. It reads a numeric status or a frozen error name; never a message.
  // The errors are shaped as the engine client REALLY throws them (client-transport.ts: `${verb}: ${status}`),
  // so the classifier is exercised on its actual input rather than on a convenient fiction.
  const netErr = Object.assign(new Error("failed to fetch"), { name: "TypeError" });
  eq("a call that never reached the engine classifies as transport-error", engineFaultOutcome(netErr), "transport-error");
  eq("an engine that ANSWERED 500 classifies as engine-not-ok, never transport-error", engineFaultOutcome(new Error("engine status: 500")), "engine-not-ok");
  eq("a clean 401 is the lapsed session, and is neither", engineFaultOutcome(new Error("engine status: 401")), "unauthorised");

  recordOnboardingStep("keys-precheck", "transport-error"); // the pre-check read never arrived
  recordOnboardingStep("keys-precheck", "engine-not-ok"); // the pre-check read was ANSWERED and failed
  recordOnboardingStep("install", "transport-error"); // the genuine install POST never arrived
  const ob = rows("onboarding-step");
  eq("three rows", ob.length, 3);
  allTuplesDiffer("the pre-check and the install POST do not coalesce, and the two pre-check outcomes differ", ob);
  ok(
    "an install the engine never saw is now legible as an INSTALL, not as a read that failed on the way to one",
    ob.some((r) => r.obStep === "install" && r.obOutcome === "transport-error"),
  );
}

// ==============================================================================================
section("a MISCONFIGURED channel is not an UNCONFIGURED one");
// ==============================================================================================
//
// upd.configured is the ENGINE'S VERDICT. It is FALSE for a mangled signer key, an unparseable URL and a non-https
// URL, all of which are states with BOTH env vars set. The emit is now keyed on channelIntended (env presence).
const upd = (o: Partial<UpdateStatus>): UpdateStatus => ({ configured: true, verified: true, channelIntended: true, currentVersion: "0.1.10", ...o }) as UpdateStatus;

resetAll();
{
  // (e) THE REFUTATION STATE: the operator pasted a truncated / whitespace-mangled UPDATE_SIGNER_PUBLIC. The engine
  // answers configured:FALSE, so the old guard dropped it: zero rows, chip hidden forever, pack identical to (d).
  updateChipView(upd({ configured: false, verified: false, channelFault: "key-config", reason: "invalid pinned update-signer key" }), "0.1.10");
  const ch = rows("update-channel-unverified");
  eq("a MANGLED PASTE of the pinned signer key now records ONE row", ch.length, 1);
  eq("and it names the key, not the signature (the remedy is a fresh copy of the key)", ch[0]?.channelReasonClass, "bad-signer-key");
}

resetAll();
{
  updateChipView(upd({ verified: false, channelFault: "sig-invalid", reason: "channel signature did not verify under the pinned signer" }), "0.1.10");
  updateChipView(upd({ verified: false, channelFault: "fetch-failed", reason: "could not fetch the update channel" }), "0.1.10");
  updateChipView(upd({ configured: false, verified: false, channelFault: "key-config", reason: "invalid pinned update-signer key" }), "0.1.10");
  updateChipView(upd({ configured: false, verified: false, channelFault: "url-config", reason: "UPDATE_CHANNEL_URL must use https" }), "0.1.10");
  updateChipView(upd({ verified: false, channelFault: "shape-invalid", reason: "not a channel document this engine understands" }), "0.1.10");
  const ch = rows("update-channel-unverified");
  eq("five ways for a channel to be broken are FIVE rows", ch.length, 5);
  allTuplesDiffer("and their tuples genuinely differ (channelReasonClass is in the coalescing key)", ch);
  eq(
    "the classes are the five the operator acts on",
    ch.map((r) => r.channelReasonClass).sort(),
    ["bad-signer-key", "bad-url", "malformed", "signature", "unreachable"],
  );
}

// NOISE. A row on a legitimate state devalues every true one.
resetAll();
updateChipView(upd({ verified: true, updateAvailable: false }), "0.1.10");
eq("a HEALTHY verified channel records NOTHING", rows("update-channel-unverified").length, 0);
updateChipView(upd({ configured: false, verified: false, channelIntended: false, reason: "updates not configured" }), "0.1.10");
eq("and a customer who wants NO updates records NOTHING: neither env var is set, and that is a choice", rows("update-channel-unverified").length, 0);
ok("so a silently frozen channel and a healthy one are, at last, different evidence", true);

// ==============================================================================================
section("the ENGINE'S CLOSED CAUSE is what travels; the prose is only the fallback");
// ==============================================================================================
//
// The engine held the closed cause and DROPPED it at the status projection, so the console re-derived the class by
// substring-matching a sentence written for a human. Reword the sentence and every row silently degrades to
// `none`, with no gate failing anywhere. The enum now wins.
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  eq(
    "a REWORDED engine sentence cannot degrade the class: the closed fault decides",
    channelReasonClassFor({ channelFault: "sig-invalid", reason: "the release descriptor could not be trusted" }),
    "signature",
  );
  eq(
    "and the prose classifier cannot OVERRIDE the enum either (this reason reads as `malformed` on its own)",
    channelReasonClassFor({ channelFault: "fetch-failed", reason: "the manifest could not be parsed" }),
    "unreachable",
  );
  eq("classifyChannelReason still reads that reason as malformed, so the enum genuinely changed the answer", classifyChannelReason("the manifest could not be parsed"), "malformed");
  eq("an engine that sends NO fault falls back to the prose classifier, which is total", channelReasonClassFor({ reason: "channel signature did not verify" }), "signature");
  eq("an out-of-vocabulary fault is not trusted: it falls back to the text rather than carrying a stranger", channelReasonClassFor({ channelFault: "made-up-member", reason: "could not fetch the update channel" }), "unreachable");
  eq("and with neither, the honest answer is `none`, never a guess", channelReasonClassFor({}), "none");
}

// ==============================================================================================
section("no-custody: the sentinel reaches nothing");
// ==============================================================================================
{
  const SENTINEL = "acct-9f3-secret-BUCKET-colin@maelstrom.au";
  resetAll();
  // The engine's `reason` is prose and CAN carry a URL, a key id and platform text. It is read to SELECT a member
  // and is never carried, so a poisoned reason must leave nothing behind.
  updateChipView(upd({ verified: false, reason: `could not fetch https://${SENTINEL}/channel.json` }), "0.1.10");
  updateChipView(upd({ verified: false, channelFault: SENTINEL as never, reason: `signature check failed for ${SENTINEL}` }), "0.1.10");
  const wire = JSON.stringify(packPayload());
  ok("no part of the poisoned reason or the poisoned fault reaches the payload", !wire.includes("acct-9f3") && !wire.includes("maelstrom"));
  ok("and the rows are still honest closed members", rows("update-channel-unverified").every((r) => r.channelReasonClass === "unreachable" || r.channelReasonClass === "signature"));
  ok("negative control: the sentinel IS detectable when actually present", JSON.stringify({ x: SENTINEL }).includes("maelstrom"));
}

console.log(failures === 0 ? "\nAVAILABILITY R3 DISCRIMINATION PASS" : `\n${failures} FAILURE(S)`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) process.exit(1);
