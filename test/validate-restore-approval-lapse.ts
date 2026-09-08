// TC-restore-approval-lapse: the armed approval gate must retract when the approval it armed on reaches its
// own expiresAt, and it must leave no timer armed once the panel it belongs to is torn down. Run with:
//   node test/validate-restore-approval-lapse.ts
//
// This drives the real renderConfirm over the shared DOM shim and never re-implements the gate. The
// deadlines are milliseconds out rather than hours, so the timer this file is about actually fires inside a
// test run; the code path is the same one an hour-long deadline takes.

import { flushAsync, installDomShim, markConnected } from "./dom-shim.ts";

installDomShim();

// Timer accounting is installed before the module under test is imported, so every timer the gate arms
// passes through it. This is the only way to assert that the panel leaves nothing armed: that is a
// statement about handles, and no assertion over rendered DOM can reach it. The wrappers are
// pass-through, so the gate's behaviour is unchanged; they only count.
// The DELAY is recorded beside each handle, not just the count, because the two timers this file grades are
// told apart by their delay and nothing else: the read guard is 12,000 ms and the poll is APPROVAL_POLL_MS.
// A bare count cannot distinguish "the read guard is still armed" from "the poll is running, which is
// correct while the gate is unarmed", and grading the count alone would have made case 5 below fail for the
// right reason on the wrong evidence.
const liveTimers = new Map<unknown, number>();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
// Only timers armed for longer than this are counted. A test run is full of short microtask-drain timers
// from the shim itself (flushAsync, the crossfade, the FileReader stand-in) that legitimately come and go,
// and counting those would make the assertions below about the test shim rather than about the gate. The
// gate's own timers are the 12,000 ms read guard, the 5,000 ms poll and the lapse deadline, all far above
// this line; the deadlines this file uses are 600 ms, deliberately above it too.
const LONG_MS = 400;
const READ_GUARD_MS = 12_000;
globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
  const long = (ms ?? 0) >= LONG_MS;
  const wrapped = typeof fn === "function" && long ? ((...a: unknown[]) => { liveTimers.delete(handle); return fn(...a); }) : fn;
  const handle = realSetTimeout(wrapped as never, ms as never, ...(rest as never[]));
  if (long) liveTimers.set(handle, ms ?? 0);
  return handle;
}) as typeof globalThis.setTimeout;
globalThis.clearTimeout = ((h: never) => { liveTimers.delete(h); return realClearTimeout(h); }) as typeof globalThis.clearTimeout;
globalThis.setInterval = ((fn: never, ms?: number, ...rest: never[]) => {
  const handle = realSetInterval(fn, ms as never, ...rest);
  if ((ms ?? 0) >= LONG_MS) liveTimers.set(handle, ms ?? 0);
  return handle;
}) as typeof globalThis.setInterval;
globalThis.clearInterval = ((h: never) => { liveTimers.delete(h); return realClearInterval(h); }) as typeof globalThis.clearInterval;
const liveOfDelay = (ms: number): number => [...liveTimers.values()].filter((v) => v === ms).length;

import type { Caller, EngineClient, RestoreApproval, RestorePlan, RestoreRequest } from "../src/api.ts";
import { installNav } from "../src/lib/nav.ts";
import { setCaller } from "../src/lib/store.ts";
import { renderConfirm, stopConfirmGate } from "../src/screens/restore-flow/confirm.ts";

// The gate is reached only by a caller holding restore.apply, and an APPROVER is the ordinary maker on this
// screen. Without this renderConfirm short-circuits at its capability gate and every assertion below would
// fail for a reason that has nothing to do with lapsing.
installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
setCaller({ method: "access", email: "maker@test", role: "approver", groups: [], isOnlyOwner: false } as Caller);

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const sleep = (ms: number): Promise<void> => new Promise((res) => realSetTimeout(res, ms));

/** A plan that genuinely writes, so renderConfirm does not short-circuit on "nothing to apply". */
function planThatWrites(): RestorePlan {
  return { plannedWrites: 3, configChanges: [], mediaPlanned: [] } as unknown as RestorePlan;
}
function request(): RestoreRequest {
  return { runId: "01TESTRUNTESTRUNTESTRUN", target: { kind: "redirect", binding: "RESTORE_KV" } } as unknown as RestoreRequest;
}
const PLAN_HASH = "a".repeat(64);
const FLAGS = { highImpact: false, isLarge: false, isRedirect: true, isNonLatest: false, isCrossAccount: false, isCrossZone: false };

/**
 * A usable approval bound to THIS plan hash from a DISTINCT approver, expiring at the given instant.
 *
 * The approver is deliberately not maker@test: a self-approval is refused by findUsableApproval for the
 * maker-is-not-checker reason, and the gate would then never arm, so every assertion about retraction would
 * pass vacuously over a gate that was never armed in the first place.
 */
function approvalExpiringAt(expiresAt: string): RestoreApproval {
  return { id: "apr_1", planHash: PLAN_HASH, approvedBy: "checker@test", status: "approved", expiresAt, runId: request().runId } as unknown as RestoreApproval;
}

async function renderWith(approvals: RestoreApproval[]): Promise<HTMLElement> {
  const engine = { listApprovals: async () => approvals } as unknown as EngineClient;
  const section = await renderConfirm(engine, planThatWrites(), request(), PLAN_HASH, FLAGS, () => {}, () => {});
  // The gate's own guards ask section.isConnected, so a section that is never connected retracts nothing and
  // this file would grade a screen no operator is looking at.
  markConnected(section);
  await flushAsync();
  return section;
}

const armed = (root: HTMLElement): boolean => root.querySelector(".restore-confirm__armed") !== null;
const unarmed = (root: HTMLElement): boolean => root.querySelector(".restore-confirm__unarmed") !== null;

console.log("TC-restore-approval-lapse: an armed gate retracts at its deadline, and leaves no timer behind");

async function main(): Promise<void> {
  // ---- 1. THE CONTROL, first, so a suite that cannot arm the gate says so before it judges a retraction --
  {
    const section = await renderWith([approvalExpiringAt(new Date(Date.now() + 60 * 60 * 1000).toISOString())]);
    ok("CONTROL: an approval an hour out ARMS the gate", armed(section));
    ok("CONTROL: and the armed panel is not simultaneously the unarmed one", !unarmed(section));
    stopConfirmGate(section);
  }

  // ---- 2. the deadline passes while the tab is already armed ---------------------------------------------
  {
    const section = await renderWith([approvalExpiringAt(new Date(Date.now() + 600).toISOString())]);
    ok("a live approval arms the gate", armed(section));
    await sleep(900);
    await flushAsync();
    ok("THE FIX HOLDS: once its own expiresAt passes, the armed panel is RETRACTED", !armed(section));
    ok("and the gate falls back to the unarmed request state rather than to nothing at all", unarmed(section));
    ok(
      "and the operator is told the plan must be re-run, not to go and get an approval they already have",
      /window|expired|lapsed|run the plan again|no longer/i.test(section.textContent ?? ""),
    );
    stopConfirmGate(section);
  }

  // ---- 3. an unparseable expiresAt must arm NO timer and must not retract a healthy approval ------------
  // The invariant watchForLapse states in its own header, and the mirror of approvalHasLapsed: a corrupt
  // timestamp must not retract an approval any more than it may withhold one.
  {
    const section = await renderWith([approvalExpiringAt("not-a-timestamp")]);
    const armedAtFirst = armed(section);
    await sleep(700);
    await flushAsync();
    ok("an approval whose expiresAt cannot be read is not retracted by a timer that should never have armed", armedAtFirst === armed(section));
    stopConfirmGate(section);
  }

  // ---- 3b. a deadline beyond the 32-bit timer horizon must arm NOTHING ----------------------------------
  // setTimeout takes a 32-bit signed delay in node and in every browser, and a larger one is not rejected
  // and not clamped to the maximum: it is silently reset to 1 ms. So the timer fires at once and retracts
  // a live, valid, distinctly-approved plan, handing the operator the sentence that tells them to re-run a
  // plan needing no re-run. It is graded here rather than only in test/validate-api.ts (which caught it as
  // a missing Apply button) because that file grades the button and this one grades the cause.
  {
    const section = await renderWith([approvalExpiringAt(new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString())]);
    ok("an approval forty days out ARMS, and is not retracted a millisecond later by a clamped timer", armed(section));
    await sleep(120);
    await flushAsync();
    ok("and it is still armed after the moment a clamped timer would have fired", armed(section));
    ok("and no timer was armed for it at all, because a deadline that far out cannot be watched by one", liveOfDelay(40 * 24 * 60 * 60 * 1000) === 0);
    stopConfirmGate(section);
  }

  // ---- 4. THE SECOND HALF: the gate leaves nothing armed once it is stopped -----------------------------
  // This is the assertion the deploy hang needed and did not have. It is made over HANDLES rather than over
  // the DOM, because a timer that will never do anything visible still holds a node process open, and that
  // is precisely the shape that got past every existing test in this repo.
  {
    liveTimers.clear();
    const section = await renderWith([approvalExpiringAt(new Date(Date.now() + 60 * 60 * 1000).toISOString())]);
    ok("PRECONDITION: the gate armed, so there is something to leave behind", armed(section));
    ok("PRECONDITION: and it did arm at least one long-lived timer, so the count below is not vacuous", liveTimers.size > 0);
    const beforeStop = liveTimers.size;
    stopConfirmGate(section);
    ok(`stopping the gate clears every long-lived timer it armed (${beforeStop} before, ${liveTimers.size} after)`, liveTimers.size === 0);
  }

  // ---- 5. and the 12-second read guard is cleared by a read that WINS its race --------------------------
  // Separate from the lapse timer on purpose. It never hung anything on its own, so a repair aimed only at
  // the hang would leave it in place, and it is the one that accumulates: the poll re-enters recheck every
  // five seconds for the life of an unarmed screen.
  {
    liveTimers.clear();
    // No usable approval, so the gate stays unarmed and the read is the only long-lived timer in play.
    const section = await renderWith([]);
    ok("PRECONDITION: with no usable approval the gate is unarmed, which is the state the read guard runs in", unarmed(section));
    // The poll IS expected to be running here and is not a leak: it is the gate's on-screen lifecycle, it
    // stops itself the moment the gate arms or the section leaves, and stopping it is what case 5's last
    // assertion checks. Only the abandoned race arm is the defect, so only it is graded.
    ok("PRECONDITION: the poll is running, so a zero below is not a zero over an idle screen", liveOfDelay(5_000) > 0);
    ok("the approvals read that WON its race left no 12-second guard armed behind it", liveOfDelay(READ_GUARD_MS) === 0);
    stopConfirmGate(section);
    ok("and stopping the gate ends the poll at once rather than at its next tick", liveTimers.size === 0);
  }

  console.log(failures === 0 ? "\nRESTORE APPROVAL LAPSE PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
