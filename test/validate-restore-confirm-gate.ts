// TC-restore-confirm-gate: the dual-control approval gate on /restore's Confirm and apply step must always
// resolve to a visible state, whatever the approvals lookup does. Run with:
//   node test/validate-restore-confirm-gate.ts
//
// renderConfirm paints its approval host synchronously with a placeholder ("Checking whether this plan has
// an approval from a distinct approver") and replaces it asynchronously from startApprovalGate. Every error
// path in that gate must degrade to the honest unarmed state; none may leave the placeholder in place
// indefinitely.
//
// A rate limit is not a session loss. The engine's bare-token anti-brute-force throttle refuses
// authorisation before the token compare (engine/src/admin/auth.ts, the tokenRateLimited branch), so it says
// nothing about the caller's session, and answers 429 (engine/src/admin/router.ts, the verdict.throttled
// branch). This console must treat a 429 as a pace signal, never a sign-out.
//
// This renders the real renderConfirm over the shared DOM shim and never re-implements it.

import { flushAsync, installDomShim, markConnected } from "./dom-shim.ts";

installDomShim();

import type { Caller, EngineClient, RestorePlan, RestoreRequest } from "../src/api.ts";
import { installNav } from "../src/lib/nav.ts";
import { setCaller } from "../src/lib/store.ts";
import { renderConfirm } from "../src/screens/restore-flow/confirm.ts";

// The gate is reached only by a caller holding restore.apply, so install one: without it renderConfirm
// short-circuits at its capability gate and returns the role-gated panel, and every assertion below would
// fail for a reason that has nothing to do with what this file tests. An APPROVER is the ordinary maker on
// this screen. goSignedOut() routes through the nav bridge, so that is installed too and records the call
// rather than navigating.
let signedOut = 0;
installNav({ navigate: () => {}, onUnauthorised: () => { signedOut++; }, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
setCaller({ method: "access", email: "maker@test", role: "approver", groups: [], isOnlyOwner: false } as Caller);

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

/**
 * An error shaped the way the api client actually reports a 401.
 *
 * classifyError reads the status out of the message (`extractStatus` matches a trailing three-digit code),
 * not off a `.status` property.
 */
function unauthorisedError(): Error {
  return new Error("listApprovals: 401");
}

/**
 * An error shaped the way the api client actually reports the engine's throttle 429.
 *
 * client-transport.ts folds the engine's Retry-After in ahead of the trailing status
 * (`<verb>: retry-after=<n>: 429`) so classifyError can pace by it, and the trailing status stays the last
 * token. Built in that exact shape rather than as a bare `: 429`, so this exercises the same string the
 * transport really produces, including the Retry-After the poll backoff reads.
 */
function rateLimitedError(retryAfterSeconds: number): Error {
  return new Error(`listApprovals: retry-after=${retryAfterSeconds}: 429`);
}

/** A plan that genuinely writes, so renderConfirm does not short-circuit on "nothing to apply". */
function planThatWrites(): RestorePlan {
  return { plannedWrites: 3, configChanges: [], mediaPlanned: [] } as unknown as RestorePlan;
}

function request(): RestoreRequest {
  return { runId: "01TESTRUNTESTRUNTESTRUN", target: { kind: "redirect", binding: "RESTORE_KV" } } as unknown as RestoreRequest;
}

// isCrossZone arrives from the cf-surfaces branch, which added a cross-zone confirm step. It is false here
// for the same reason every flag but isRedirect is: this file gates the APPROVAL panel, and each extra
// confirm reason it does not name would change which step renders and move the assertions off their target.
const FLAGS = { highImpact: false, isLarge: false, isRedirect: true, isNonLatest: false, isCrossAccount: false, isCrossZone: false };

/** Renders the real confirm section with a listApprovals that behaves as the caller asks. */
async function renderWith(listApprovals: () => Promise<never[]>): Promise<HTMLElement> {
  const engine = {
    listApprovals,
    // caller() reads identity from the shared shell state; the gate only needs an email for the
    // maker-is-not-checker comparison, and a null one is the honest "not yet resolved" case.
  } as unknown as EngineClient;
  const section = await renderConfirm(engine, planThatWrites(), request(), "a".repeat(64), FLAGS, () => {}, () => {});
  await flushAsync();
  return section;
}

const has = (root: HTMLElement, sel: string): boolean => root.querySelector(sel) !== null;

console.log("TC-restore-confirm-gate: the approval gate always resolves to a visible state");

// ---- 1. The regression itself: an UNAUTHORISED lookup must still paint. -----------------------------------
{
  const section = await renderWith(() => Promise.reject(unauthorisedError()));
  const painted = has(section, ".restore-confirm__unarmed") || has(section, ".restore-confirm__armed");
  ok("an unauthorised approvals lookup still paints a gate state (never the bare placeholder)", painted);
  ok("and it is the honest UNARMED state, never a misleading armed Apply", has(section, ".restore-confirm__unarmed"));
  // The placeholder is the thing that used to survive. Its presence alongside no gate state is the exact bug.
  const stuck = !painted && /Checking whether this plan has an approval/.test(section.textContent ?? "");
  ok("the synchronous 'Checking...' placeholder does not survive the lookup", !stuck);
  // Painting must not have COST the sign-out: a genuine session loss still has to route the operator out.
  ok("an unauthorised lookup still signs the operator out (the fix adds a paint, it removes nothing)", signedOut === 1);
}

// ---- 2. A transport fault already degraded correctly; prove it still does. --------------------------------
{
  const section = await renderWith(() => Promise.reject(new Error("network down")));
  ok("a transport fault degrades to the unarmed request step", has(section, ".restore-confirm__unarmed"));
}

// ---- 3. The ordinary path: no usable approval yet. --------------------------------------------------------
{
  const section = await renderWith(() => Promise.resolve([]));
  ok("an empty approvals listing renders the unarmed request step", has(section, ".restore-confirm__unarmed"));
}

// ---- 4. A lookup that NEVER SETTLES. -----------------------------------------------------------------------
//
// The three cases above all REJECT or RESOLVE, so every one of them reaches a catch or a then and paints.
// A lookup that simply never settles reaches neither, and the synchronous placeholder then survives for the
// life of the screen with nothing to wait on.
//
// A lookup that never settles must still resolve to a visible state. A gate that can hang forever is a
// frozen screen with no error, which is the worst of both: the operator cannot act and has nothing to
// report.
{
  const section = await renderWith(() => new Promise<never[]>(() => {}));
  await new Promise((r) => setTimeout(r, 12_500)); // past the gate's own bound
  await flushAsync();
  const painted = has(section, ".restore-confirm__unarmed") || has(section, ".restore-confirm__armed");
  ok("an approvals lookup that never settles still resolves to a visible gate state (never a permanent placeholder)", painted);
}

// ---- 5. A RATE LIMIT IS NOT A SESSION LOSS. ---------------------------------------------------------------
//
// The console half of the cross-repo pair. The engine's bare-token throttle fires BEFORE the credential is
// compared, so it refuses a correct and an incorrect token identically and establishes nothing about the
// session. It answers 429 for exactly that reason (engine/src/admin/router.ts). What must never happen is the
// console reading it as a dead session and routing the operator to sign-in in the middle of a restore, which
// is the live defect this pair closes: the throttle answered 401, isUnauthorised() matched, and the operator
// was signed out by a rate limit.
//
// The sign-out count is the load-bearing assertion. Painting is asserted too, but a 429 already paints by
// falling through to the generic branch, so paint alone would pass with the bug fully present.
{
  const signedOutBefore = signedOut;
  const section = await renderWith(() => Promise.reject(rateLimitedError(60)));
  const painted = has(section, ".restore-confirm__unarmed") || has(section, ".restore-confirm__armed");
  ok("a rate-limited approvals lookup still paints a gate state (never the bare placeholder)", painted);
  ok("and it is the honest UNARMED state, never a misleading armed Apply", has(section, ".restore-confirm__unarmed"));
  ok("a RATE LIMIT DOES NOT SIGN THE OPERATOR OUT (429 is a pace signal, not a dead session)", signedOut === signedOutBefore);
}

// ---- 6. A THROTTLED GATE MUST NOT RE-TRIP THE THROTTLE IT IS WAITING OUT. ---------------------------------
//
// The gate polls every APPROVAL_POLL_MS (5s) while unarmed, so Apply lights up shortly after a distinct
// approver signs. The engine's bare-token throttle window is a MINUTE. An unpaced poll therefore spends that
// minute re-tripping the limiter it is waiting for: the throttle sustains itself, the gate never arms, and the
// engine takes twelve refused reads per window from a screen that is simply waiting.
//
// The section is markConnected'd deliberately: the poll's first act each tick is a section.isConnected check,
// so on an unmounted tree it stops after one tick and this case would pass with the pacing entirely absent.
{
  let lookups = 0;
  const section = await renderWith(() => {
    lookups++;
    return Promise.reject(rateLimitedError(30));
  });
  markConnected(section);
  ok("the throttled gate performed its initial approvals lookup", lookups === 1);
  // Two poll intervals of real time, well inside the 30s Retry-After the engine asked for.
  await new Promise((r) => setTimeout(r, 12_500));
  await flushAsync();
  ok("the 5s poll honours the engine's Retry-After instead of re-tripping the throttle every tick", lookups === 1);
  // And the screen is still the honest unarmed state throughout, not a frozen placeholder.
  ok("a throttled gate keeps showing the unarmed request step while it paces", has(section, ".restore-confirm__unarmed"));
}

// ---- 7. THE BLOCKED GATE NAMES ITS OWN CAUSE. -------------------------------------------------------------
//
// gateBlockClassFor classifies four distinct reasons the gate will not arm, and every one of them was
// routed to a screen that said the same thing about all four: raise a request and wait for a distinct
// approver. For two of them that advice cannot work. plan-hash-failed can never arm however many approvers
// sign, because the client has no key to match an approval against. plan-hash-mismatch sends the operator
// to fetch an approval they can already see in the inbox.
//
// These assert the CUSTOMER-VISIBLE sentence, not the recorded class: the class was already covered and was
// never the half that was missing.
{
  const approval = (over: Record<string, unknown>): unknown => ({ id: "ap1", runId: "01TESTRUNTESTRUNTESTRUN", planHash: "a".repeat(64), status: "approved", approvedBy: "checker@test", ...over });
  const renderWithHash = async (hash: string | null, records: unknown[]): Promise<HTMLElement> => {
    const engine = { listApprovals: () => Promise.resolve(records) } as unknown as EngineClient;
    const section = await renderConfirm(engine, planThatWrites(), request(), hash as unknown as string, FLAGS, () => {}, () => {});
    await flushAsync();
    return section;
  };

  const hashFailed = await renderWithHash(null, []);
  ok("a plan hash this browser could not compute says so, rather than asking for an approver", /could not compute the plan's fingerprint/.test(hashFailed.textContent ?? ""));
  ok("and it names the remedy (a secure address), not just the fault", /https/.test(hashFailed.textContent ?? ""));
  ok("and it does not tell the operator to go and get an approval that cannot help", !/Apply unlocks once a distinct approver signs it/.test(hashFailed.textContent ?? ""));

  const mismatch = await renderWithHash("a".repeat(64), [approval({ planHash: "b".repeat(64) })]);
  ok("an approval bound to a DIFFERENT plan is named as that, not as a missing approval", /bound to a different plan/.test(mismatch.textContent ?? ""));
  ok("and it points at the inbox the operator can already see the approval in", /approvals inbox/.test(mismatch.textContent ?? ""));

  const mine = await renderWithHash("a".repeat(64), [approval({ approvedBy: "maker@test" })]);
  ok("an approval that is the operator's own is named as that", /only approval for this plan is your own/.test(mine.textContent ?? ""));

  // NEGATIVE CONTROL. The fifth state, a plan genuinely awaiting its approver, is the ceremony working as
  // designed: gateBlockClassFor returns null for it and the standing copy must survive unchanged. Without
  // this, a change that simply printed a cause for every unarmed gate would pass every assertion above.
  const awaiting = await renderWithHash("a".repeat(64), []);
  ok("negative control: a plan simply awaiting its approver keeps the standing copy", /Apply unlocks once a distinct approver signs it/.test(awaiting.textContent ?? ""));
  ok("negative control: and claims no fault that has not happened", !/could not compute|bound to a different plan|your own/.test(awaiting.textContent ?? ""));

  // The fourth class, last because it mutates the shared caller: an attributable identity is what
  // maker-is-not-checker compares against, and the shared admin token carries none.
  setCaller({ method: "token", email: null, role: "approver", groups: [], isOnlyOwner: false } as unknown as Caller);
  const noIdentity = await renderWithHash("a".repeat(64), [approval({})]);
  ok("a caller the console cannot attribute is told that, not that nobody has signed", /no identity for you/.test(noIdentity.textContent ?? ""));
  ok("and it names the remedy (sign in as yourself)", /Sign in as yourself/.test(noIdentity.textContent ?? ""));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
process.exit(failures === 0 ? 0 : 1);
