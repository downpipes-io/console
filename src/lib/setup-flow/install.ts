// Installing the keys and waiting for the engine to report them: the one POST /admin/keys/install body, the
// total classifier for a failed engine call during setup, and the bounded readiness wait with the endings a
// support pack can tell apart. Moved here from the retired first-run deck (screens/onboarding/steps.ts); the
// wait was that deck's readiness card, now headless, with the same evidence rules.

import type { EngineClient, StatusReport } from "../../api.ts";
import type { CeremonyResult } from "../../keygen.ts";
import { toast } from "../../components/toast.ts";
import { isNavigationCancelled, recordOnboardingStep } from "../client-diag/ring.ts";
import { classifyError } from "../errors.ts";
import { navigate } from "../nav.ts";
import { getEngine } from "../store.ts";

// WizardFault is what a failed engine call in setup can honestly be said to be. Every member is a fact the
// code established, and no member asserts one it did not.
export type WizardFault = "transport-error" | "engine-not-ok" | "unauthorised" | "engine-binding-absent" | "console-origin-fault";

// engineFaultOutcome is the TOTAL, PURE classifier for ANY failed engine call in setup. Total matters because
// two states that look like "the call never reached the engine" are in fact cases where the engine is up and
// healthy:
//
//   Cloudflare ACCESS served its login page   the operator's session lapsed. Access answers an authenticated call
//                                             with HTML, not a 401, and that is what it actually does. failResponse
//                                             shape-gates the body, recognises the Access page and throws the
//                                             dedicated marker; classifyError names the kind `access-redirect`; and
//                                             the console's own FAULT_BY_ERROR_KIND maps that kind to the
//                                             faultClass `auth`, so support is pointed at sign-in rather than at
//                                             engine reachability.
//   the console has NO ENGINE binding         the console worker's own 503. The engine never received the request
//                                             and cannot be at fault for it; the remedy is the CONSOLE's wrangler
//                                             configuration and a CONSOLE redeploy.
//
// So it classifies through classifyError, the console's own closed error taxonomy, and the switch is EXHAUSTIVE by
// type: a new ErrorKind fails to compile until it is placed here, which is the only way a total function stays
// total. Nothing but the `.kind` discriminant is read: not the message, not the stack, not the engine's refusal
// prose, which stays on the screen where the operator needs it and where no pack can see it.
//
// null means DO NOT RECORD, and it is not a fourth fault: a route change or an unmount aborts every fetch in
// flight, which is the console working as designed, not a refusal by an engine that was never asked. The ring
// makes the same exclusion at every other emit.
//
// It is exported because the key install (actions-apply.ts) and the readiness wait below classify by the same
// rule, so every engine-call failure in setup agrees on what happened.
export function engineFaultOutcome(err: unknown): WizardFault | null {
  if (isNavigationCancelled(err)) return null;
  const kind = classifyError(err).kind;
  switch (kind) {
    // The lapsed session, in the two shapes it arrives in. One state, one remedy, one row (vocab.ts states the
    // collapse): a clean 401, and the Access login page that IS the 401 for a fenced engine.
    case "unauthorised":
    case "access-redirect":
      return "unauthorised";
    // The console's own worker, answering for an engine it has no binding to. Not the engine's fault, and not a
    // reachability question about the engine at all.
    case "engine-binding-absent":
      return "engine-binding-absent";
    // THE CONSOLE'S OWN WORKER MANUFACTURED THE 500, so no request reached the engine. It is not
    // `engine-not-ok`, which would say the engine answered and refused and send support to the engine's logs
    // for a fault the engine never saw. It is not `engine-binding-absent` either: the binding is there, and
    // the remedy is the engine's deployment (deleted, throwing on boot, over its limits) or the console's
    // dispatch.
    case "console-origin-fault":
      return "console-origin-fault";
    // THE ENGINE ANSWERED AND REFUSED. It is reachable, it saw the call, and it recorded the refusal on its own
    // side, so the two halves can be joined and the remedy is its logs. A role denial, a rate limit and a 5xx all
    // agree on the fact that decides the remedy, which is that the engine is up.
    //
    // stepup-required and access-reauth-required belong here too: onboarding performs two step-up-gated WRITES,
    // installKeys (POST /admin/keys/install, gatedFetch, and /keys/install is a STEPUP_SUBS member) below, and
    // the team step's role grant (team.ts, POST /admin/roles). On a cookie-borne session either can reach this
    // classifier, and the engine answered: the call needs a fresh identity check (a re-verify), an
    // engine-answered state, NEVER a lapsed session (so never "unauthorised").
    case "stepup-required":
    case "access-reauth-required":
    case "forbidden":
    case "restore-unapproved":
    case "rate-limited":
    case "server":
      return "engine-not-ok";
    // A 2xx whose body could not be read: the engine answered and the
    // request completed, so this joins the row above rather than the "nothing arrived" row below. It is not a
    // refusal, but the same fact decides the remedy -- the engine is up and reachable, and its own state or
    // logs are what can explain a malformed or unexpected body, not a reachability check.
    case "answer-unreadable":
      return "engine-not-ok";
    // NOTHING FROM THE ENGINE ARRIVED, and the console did not establish why. The fetch threw or timed out
    // (`network`), or some other server answered with a web page (`html-body`: a wrong engine URL, an undeployed
    // engine, a proxy). `console-origin` cannot be produced by classifyError at all (it is an explicit decision a
    // screen makes after probing health, never an inference), but it is a member of the taxonomy and the switch is
    // exhaustive: the engine's answer was made and then discarded by the browser, so the console received nothing.
    case "network":
    case "html-body":
    case "console-origin":
      return "transport-error";
    // `console-fault` (lib/errors.ts): a throw with no engine status that does not read as a fetch failure
    // either, which is usually the console's own code throwing on an answer it already had.
    //
    // IT SITS HERE UNDER PROTEST AND THE PROTEST IS THE POINT, because `transport-error` asserts that nothing
    // from the engine arrived and this kind does not establish that. No dedicated member is added for it,
    // because setup's outcomes are mirrored in a CLOSED vocabulary that the engine carries its own copy
    // of (lib/client-diag/vocab.ts CLIENT_DIAG_ONBOARDING_OUTCOMES and
    // engine/src/admin/client-diag-vocab.ts), so a new member is a cross-repo mirrored change. The gap is
    // written down here where the next reader of this switch will find it.
    case "console-fault":
      return "transport-error";
  }
}

// installCeremonyKeys is the ONE place the ceremony output becomes the POST /admin/keys/install body: the
// signer private, the break-glass PUBLIC (the break-glass private has no field here and is never sent), the
// operational pair only under the operational posture, and the configuration keys (the configuration wrap
// key among them: once it is installed the engine encrypts the credentials it stores, the ones saved before
// the keys existed included; README.md "Credentials saved before the keys"). applyWithDeployToken
// (actions-apply.ts) installs through it. The token is used for this one call and not kept.
export function installCeremonyKeys(engine: EngineClient, result: CeremonyResult, token: string): ReturnType<EngineClient["installKeys"]> {
  return engine.installKeys({
    token,
    signerPrivate: result.signer.privateB64,
    breakGlassPublic: result.breakGlass.recipientPublicB64,
    ...(result.operational ? { operationalPublic: result.operational.recipientPublicB64, operationalPrivate: result.operational.identityB64 } : {}),
    configRecipientPublic: result.configRecipient.recipientPublicB64,
    configRecipientPrivate: result.configRecipient.identityB64,
    configWrapKey: result.configWrapKeyB64,
  });
}


// ---- the readiness wait -----------------------------------------------------------------------------------

// The wait re-reads the engine status on this interval, up to this many reads (about two minutes).
export const KEYS_WAIT_INTERVAL_MS = 3000;
export const KEYS_WAIT_TRIES = 40;

// KeysWaitEnding is how one run of the wait ended. "ready": the engine reported the signer and the
// break-glass key. "unauthorised": the session lapsed (the caller sends the tab to sign-in). "cancelled": a
// navigation or an unmount aborted a read, which is the console working as designed. "exhausted": the reads
// ran out; the row recorded for it names which of the endings below it was.
export type KeysWaitEnding = "ready" | "unauthorised" | "cancelled" | "exhausted";

export interface KeysWaitResult {
  ending: KeysWaitEnding;
  // The last status the engine answered with in THIS run (null if it never answered).
  lastRead: StatusReport | null;
  // How the final read failed, classified (null when it read cleanly).
  lastFault: Exclude<WizardFault, "unauthorised"> | null;
}

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// waitForKeys reads GET /admin/status until the engine reports its signer and break-glass keys, or the reads
// run out. Each call is ONE RUN with its own evidence: a second call (the user presses the primary again)
// starts clean, so a fresh run's ending never reuses a status read minutes earlier from an engine that has
// since gone, and never re-emits the previous run's rows (they would coalesce by tuple key and assert the
// engine answered more times than it did).
//
// THE ENDING MUST NAME WHICH STATE HAPPENED. A thrown read and a read that reported the keys absent reach the
// same exhaustion, and they have different remedies. The ending is the product of two questions: did this
// run EVER read the engine, and how did its FINAL read end?
//
//   readiness-unread   never read, final read UNREACHABLE. The engine was already gone when the wait began;
//                      the keys may well be installed and nobody could see it. Fix reachability.
//   readiness-refused  never read, final read REFUSED. The engine is up and turning the read away, and every
//                      refusal is in its own logs. A row must not assert a reachability fault never tested.
//   poll-went-quiet    read at least once, final read UNREACHABLE. The engine went away DURING the wait, the
//                      ordinary shape of the fault (installing the key secrets is itself a redeploy).
//   poll-refused       read at least once, final read REFUSED.
//   poll-exhausted     the engine ANSWERED, including on the last read, and kept reporting a key absent. One
//                      row per STILL-ABSENT key says which: a lone break-glass row is a half-keyed engine (the
//                      install wrote the signer and then failed); signer AND break-glass is an install that
//                      never took.
//   engine-binding-absent  this console's deploy has no ENGINE service binding, so its own Worker answered
//                      every read with a 503 and the engine heard nothing. Tested first: it is a fault in the
//                      console, and the console is what gets redeployed.
//   console-origin-fault   the console answered for the engine and the engine never saw a read. Tested
//                      beside the bindingless leg, for the same reason.
//
// The ORDER is load-bearing. The failed-final-read legs are tried BEFORE the absent-key legs, because a stale
// lastRead is still there from before the engine died or started refusing, and the absent-key legs would read
// it and assert, on no evidence, that the engine was still reporting the keys absent. Neither failed-final-read
// leg carries an obSecret: the console does not know what the engine held at the end.
//
// A single failed read is not recorded (the wait is a retry loop by design, and forty rows for one wait is
// noise); the ending is. A lapsed session is recorded before the caller leaves for sign-in.
export async function waitForKeys(engine: EngineClient, opts: { intervalMs?: number; tries?: number } = {}): Promise<KeysWaitResult> {
  const intervalMs = opts.intervalMs ?? KEYS_WAIT_INTERVAL_MS;
  const tries = opts.tries ?? KEYS_WAIT_TRIES;
  let everRead = false;
  let lastRead: StatusReport | null = null;
  let lastFault: Exclude<WizardFault, "unauthorised"> | null = null;
  for (let i = 0; i < tries; i++) {
    try {
      const s = await engine.status();
      everRead = true;
      lastRead = s;
      lastFault = null;
      if (s.signerConfigured && s.breakGlassConfigured) {
        // The wait SUCCEEDED. Recorded once, so a pack whose wait has no ok and no exhaustion row says the
        // operator walked away mid-wait, which is its own answer.
        recordOnboardingStep("readiness-poll", "ok");
        return { ending: "ready", lastRead, lastFault };
      }
    } catch (err) {
      const fault = engineFaultOutcome(err);
      if (fault === "unauthorised") {
        recordOnboardingStep("readiness-poll", "unauthorised");
        return { ending: "unauthorised", lastRead, lastFault };
      }
      // A navigation or an unmount cancelled the read: not a fault, not recorded.
      if (fault === null) return { ending: "cancelled", lastRead, lastFault };
      lastFault = fault;
    }
    if (i + 1 < tries) await pause(intervalMs);
  }
  if (lastFault === "engine-binding-absent") recordOnboardingStep("readiness-poll", "engine-binding-absent");
  else if (lastFault === "console-origin-fault") recordOnboardingStep("readiness-poll", "console-origin-fault");
  else if (lastFault !== null) {
    const refused = lastFault === "engine-not-ok";
    if (!everRead) recordOnboardingStep("readiness-poll", refused ? "readiness-refused" : "readiness-unread");
    else recordOnboardingStep("readiness-poll", refused ? "poll-refused" : "poll-went-quiet");
  } else if (lastRead !== null) {
    if (!lastRead.signerConfigured) recordOnboardingStep("readiness-poll", "poll-exhausted", "signer");
    if (!lastRead.breakGlassConfigured) recordOnboardingStep("readiness-poll", "poll-exhausted", "break-glass");
    // The operational key is OPTIONAL, so it is recorded only when the engine holds a PARTIAL pair: a public
    // with no private, or a private with no public, is a half-written slot. A cleanly absent pair is a
    // legitimate configuration and records nothing.
    const op = lastRead.operationalConfigured;
    if (op !== undefined && op.public !== op.private) recordOnboardingStep("readiness-poll", "poll-exhausted", "operational");
  }
  return { ending: "exhausted", lastRead, lastFault };
}

// keysWaitMessage is the sentence for an exhausted wait, worded by its ending: an unreachable engine, one
// that refuses the read, a console with no engine binding, and an engine that answers without the keys are
// four different remedies.
export function keysWaitMessage(r: KeysWaitResult): string {
  if (r.lastFault === "engine-binding-absent") return "This console has no engine binding, so nothing reached the engine. Restore the ENGINE binding in the console's configuration and redeploy the console.";
  if (r.lastFault === "console-origin-fault") return "The call failed inside this console, so nothing reached the engine. Check that the engine Worker is deployed and healthy, then try again.";
  if (r.lastFault === "engine-not-ok") return "The keys were sent, and the engine answers with an error. Check the engine logs, then try again. Do not make new keys.";
  if (r.lastFault !== null) return "The keys were sent, and the engine stopped answering. Installing keys restarts it. Wait a minute, then try again. Do not make new keys.";
  return "The keys were sent, and the engine has not reported them yet. Wait a minute, then try again. Do not make new keys.";
}

// ---- finishing --------------------------------------------------------------------------------------------

// ACKNOWLEDGE_TIMEOUT_MS caps the acknowledge, so a slow request never traps the operator on Finish.
const ACKNOWLEDGE_TIMEOUT_MS = 3000;

// finishSetup lands the operator on Overview, the setup-to-console hand-over. It first acknowledges setup
// with the engine so Overview reads the installed keys (it clears the demo engine's first-run marker; the
// engine clears it only when it observes the keys present). CRITICAL: it AWAITS the acknowledge before it
// navigates, because a fire-and-forget call would race Overview's setup read. Bounded by a timeout;
// acknowledgeSetup never throws, and Overview's own self-heal (lib/setup-read.ts readSetupViewHealed) covers
// the timeout case. "complete" is canSayProtected: only a sealed and verified first run earns the toast.
export async function finishSetup(complete: boolean): Promise<void> {
  const engine = getEngine();
  if (engine) {
    // WAS THE COMPLETION EVER ACKNOWLEDGED? Finishing navigates either way (an operator must never be trapped
    // by a slow request), so the two endings look identical to the operator and in the engine's own state. The
    // race resolves to a discriminated value: the timeout leg answers null, so a slow ack is told apart from an
    // ack that answered ok:false. Both are ack-failed for the operator, and both leave a row.
    const acked = await Promise.race([
      engine.acknowledgeSetup(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ACKNOWLEDGE_TIMEOUT_MS)),
    ]);
    recordOnboardingStep("finish", acked?.ok ? "ok" : "ack-failed");
  }
  if (complete) toast({ message: "Setup complete. Welcome to your console." });
  navigate("/");
}
