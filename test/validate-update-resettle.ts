// The stall poll settles again by itself, and only when a settle can now succeed.
//
// WHY THIS EXISTS
// ---------------
// The engine answers a settle "inconclusive" (reason "old-version-answering") while the old version still
// answers, for a bounded window after the promote. The first settle ladder spends about 40 seconds, so a
// slow handover ends it still inconclusive. The stall poll then only READ the record, so the customer had
// to press verify again. The poll now settles on its own, but only when the status read says the NEW
// version answered it (runningVersion equals the pending's recommendedVersion), at most
// MAX_STALL_RESETTLES times, and only with a token the screen holds.
//
// Each case drives pollUntilDefinitive over a fake engine with the clock zeroed (stallPollMs 0) and counts
// the settle calls it made. The cases that expect NO settle are the negative controls for the ones that
// expect one: the same engine with one input changed.
//
//   node test/validate-update-resettle.ts

import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts
import { flushAsync } from "./dom-shim.ts";
import type { EngineClient, SettleResult, UpdateApplyResult, UpdateStatusRecord } from "../src/api.ts";
import { MAX_STALL_POLL_ATTEMPTS, MAX_STALL_RESETTLES, RESETTLE_CLOCK_MARGIN_MS, SETTLE_VERSION_WAIT_MS, pollUntilDefinitive, settleWithBudget, SETTLE_INCONCLUSIVE_OUTCOME, SETTLE_INCONCLUSIVE_REASON } from "../src/screens/licence/update-retry.ts";
import { STALL_INCONCLUSIVE_LINE } from "../src/screens/licence/update-outcome-copy.ts";

let failures = 0;
let checks = 0;
function eq<T>(what: string, got: T, want: T): void {
  checks++;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  console.log(pass ? `  ok   ${what}` : `  FAIL ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  if (!pass) failures++;
}

const NEW = "0.3.8";
const OLD = "0.3.7";
// `ageMs` is how long ago the engine promoted (the engine writes promotedAt as epoch milliseconds); null
// leaves promotedAt off, as an older record would.
const pendingRec = (runningVersion: string | undefined, ageMs: number | null = 1_000): UpdateStatusRecord => {
  const pending = { fromVersion: "a", toVersion: "b", recommendedVersion: NEW, promotedBy: null } as NonNullable<UpdateStatusRecord["pending"]>;
  if (ageMs !== null) pending.promotedAt = Date.now() - ageMs;
  return { pending, last: null, ...(runningVersion === undefined ? {} : { runningVersion }) };
};
const appliedRec: UpdateStatusRecord = { pending: null, last: { outcome: "applied", toVersion: "b", recommendedVersion: NEW, at: "2026-10-15T00:00:01Z", by: "o@e.co" }, runningVersion: NEW };
const queuedResult: UpdateApplyResult<SettleResult> = { status: "queued", id: "oa-1" };
const settleResult = (outcome: SettleResult["outcome"]): UpdateApplyResult<SettleResult> => ({
  status: "result",
  value: { phase: "settle", outcome, recommendedVersion: NEW, fromVersion: "a", toVersion: "b", steps: [], ...(outcome === "inconclusive" ? { runningVersion: OLD, reason: "old-version-answering" } : {}) },
});

interface Run { settles: Array<{ token: string; components: string[] | undefined }>; reads: number; settled: number; exhausted: number }
async function drive(opts: {
  status: (read: number, settlesSoFar: number) => UpdateStatusRecord;
  isLive?: () => boolean;
  settle: (n: number) => UpdateApplyResult<SettleResult> | Error;
  resettle: boolean;
}): Promise<Run> {
  const run: Run = { settles: [], reads: 0, settled: 0, exhausted: 0 };
  const engine = {
    updateStatus: async () => { run.reads++; return opts.status(run.reads, run.settles.length); },
    settleUpdate: async (token: string, components?: string[]) => {
      run.settles.push({ token, components });
      const r = opts.settle(run.settles.length);
      if (r instanceof Error) throw r;
      return r;
    },
  } as unknown as EngineClient;
  pollUntilDefinitive(engine, opts.isLive ?? (() => true), () => { run.settled++; }, () => { run.exhausted++; }, { stallPollMs: 0 }, opts.resettle ? { token: "tok", components: ["engine"] } : undefined);
  await flushAsync(80);
  return run;
}

// 1. The versions match: one settle, with the held token and component list. Its definitive answer ends the
// poll (the poll renders the re-read record, so the status shows applied after the settle).
{
  const r = await drive({ status: (_n, s) => (s === 0 ? pendingRec(NEW) : appliedRec), settle: () => settleResult("applied"), resettle: true });
  eq("match: one settle sent", r.settles.length, 1);
  eq("match: the held token and components are sent", r.settles[0], { token: "tok", components: ["engine"] });
  eq("match: the poll ended on the definitive record", r.settled, 1);
  eq("match: it ended on the re-read right after the settle (two reads), not a poll interval later", r.reads, 2);
  eq("match: and did not run out", r.exhausted, 0);
}

// 2. The versions differ (the old version answered the read): no settle, the poll only reads, then runs out.
{
  const r = await drive({ status: () => pendingRec(OLD), settle: () => settleResult("applied"), resettle: true });
  eq("differ: no settle sent", r.settles.length, 0);
  eq("differ: the poll read its whole budget", r.reads, MAX_STALL_POLL_ATTEMPTS);
  eq("differ: and then ran out", r.exhausted, 1);
}

// 3. The versions keep matching but every settle is inconclusive: the cap holds at three.
{
  const r = await drive({ status: () => pendingRec(NEW), settle: () => settleResult("inconclusive"), resettle: true });
  eq("cap: exactly MAX_STALL_RESETTLES settles", r.settles.length, MAX_STALL_RESETTLES);
  eq("cap: MAX_STALL_RESETTLES is three", MAX_STALL_RESETTLES, 3);
  eq("cap: the poll kept reading to the end", r.reads, MAX_STALL_POLL_ATTEMPTS);
  eq("cap: and then ran out", r.exhausted, 1);
}

// 4. An engine before the field: no runningVersion, so today's behaviour (read only).
{
  const r = await drive({ status: () => pendingRec(undefined), settle: () => settleResult("applied"), resettle: true });
  eq("no field: no settle sent", r.settles.length, 0);
  eq("no field: the poll ran out as before", r.exhausted, 1);
}

// 5. A reloaded tab holds no token, so it passes no options: it never settles, even on a match.
{
  const r = await drive({ status: () => pendingRec(NEW), settle: () => settleResult("applied"), resettle: false });
  eq("no token: no settle sent", r.settles.length, 0);
  eq("no token: the poll ran out as before", r.exhausted, 1);
}

// 6. A record that is already concluded is never settled over.
{
  const r = await drive({ status: () => appliedRec, settle: () => settleResult("applied"), resettle: true });
  eq("concluded: no settle sent", r.settles.length, 0);
  eq("concluded: the poll ended", r.settled, 1);
}

// 8a. THE ENGINE'S CLOCK. The engine's wait runs from the promote, so a pending older than the wait less the
// margin is never re-settled, however the poll itself started. Just inside the cut-off still settles (the
// positive control for the other two).
{
  const cutoff = SETTLE_VERSION_WAIT_MS - RESETTLE_CLOCK_MARGIN_MS;
  eq("clock: the margin is 60 seconds", RESETTLE_CLOCK_MARGIN_MS, 60_000);
  const late = await drive({ status: () => pendingRec(NEW, cutoff + 1_000), settle: () => settleResult("applied"), resettle: true });
  eq("clock: past the cut-off, no settle sent", late.settles.length, 0);
  const inside = await drive({ status: (_n, s) => (s === 0 ? pendingRec(NEW, cutoff - 30_000) : appliedRec), settle: () => settleResult("applied"), resettle: true });
  eq("clock: just inside the cut-off, a settle is sent", inside.settles.length, 1);
  const missing = await drive({ status: () => pendingRec(NEW, null), settle: () => settleResult("applied"), resettle: true });
  eq("clock: no promotedAt, no settle sent", missing.settles.length, 0);
  const asString = await drive({ status: () => ({ ...pendingRec(NEW), pending: { ...pendingRec(NEW).pending!, promotedAt: "2026-10-15T00:00:00Z" } }), settle: () => settleResult("applied"), resettle: true });
  eq("clock: a promotedAt that is not epoch milliseconds, no settle sent", asString.settles.length, 0);
}

// 8b. ONLY "inconclusive" LEADS TO ANOTHER SETTLE. A queued 202 means the engine recorded an owner approval;
// another settle could record a duplicate the customer never pressed. A thrown error also ends it. The poll
// goes on reading in both.
{
  const queued = await drive({ status: () => pendingRec(NEW), settle: () => queuedResult, resettle: true });
  eq("queued: one settle only", queued.settles.length, 1);
  eq("queued: the poll kept reading to the end", queued.reads, MAX_STALL_POLL_ATTEMPTS);
  const thrown = await drive({ status: () => pendingRec(NEW), settle: () => new Error("settle update: transport dropped: 502"), resettle: true });
  eq("error: one settle only", thrown.settles.length, 1);
  eq("error: the poll kept reading to the end", thrown.reads, MAX_STALL_POLL_ATTEMPTS);
  const after = await drive({ status: () => pendingRec(NEW), settle: (n) => (n === 1 ? settleResult("inconclusive") : queuedResult), resettle: true });
  eq("inconclusive then queued: exactly two settles", after.settles.length, 2);
  const definitiveButOpen = await drive({ status: () => pendingRec(NEW), settle: () => settleResult("applied"), resettle: true });
  eq("a definitive answer that the record does not yet show: one settle only", definitiveButOpen.settles.length, 1);
}

// 8c. TEARDOWN. The screen can leave while a settle is in flight. Nothing is read or rendered afterwards.
{
  let live = true;
  const r = await drive({
    status: () => pendingRec(NEW),
    settle: () => { live = false; return settleResult("applied"); },
    isLive: () => live,
    resettle: true,
  });
  eq("teardown: no read after the screen left", r.reads, 1);
  eq("teardown: nothing settled or exhausted", [r.settled, r.exhausted], [0, 0]);
}

// 8d. THE INTERVAL HOLDS AFTER A RE-SETTLE. A tick that settled schedules the next one at the poll interval,
// not at once. The timer is a fake that records its delay and runs only when the test fires it.
{
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const g = globalThis as unknown as { window?: unknown };
  const before = g.window;
  g.window = { setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; } };
  let reads = 0;
  let settles = 0;
  const engine = {
    updateStatus: async () => { reads++; return pendingRec(NEW); },
    settleUpdate: async () => { settles++; return settleResult("inconclusive"); },
  } as unknown as EngineClient;
  pollUntilDefinitive(engine, () => true, () => {}, () => {}, { stallPollMs: 20_000 }, { token: "tok" });
  await flushAsync(20);
  eq("interval: nothing ran before the first timer", reads, 0);
  eq("interval: the first timer is the poll interval", timers[0]?.ms, 20_000);
  timers.shift()?.fn();
  await flushAsync(20);
  eq("interval: the first tick read and settled once", [reads, settles], [1, 1]);
  eq("interval: and no second tick ran before its timer fired", reads, 1);
  eq("interval: the next tick waits the poll interval", timers.map((t) => t.ms), [20_000]);
  g.window = before;
}

// 8. The ladder says so when every answer was inconclusive, which is what selects the screen line.
{
  const engine = { settleUpdate: async () => settleResult("inconclusive") } as unknown as EngineClient;
  const zero = { graceMs: 0, settleBackoffMs: [0, 0, 0] };
  const inconclusive = await settleWithBudget(engine, "tok", undefined, zero);
  eq("ladder: unresolved and marked inconclusive", inconclusive, { kind: "unresolved", inconclusive: true });
  const dropped = await settleWithBudget({ settleUpdate: async () => { throw new Error("502"); } } as unknown as EngineClient, "tok", undefined, zero);
  eq("ladder NEGATIVE CONTROL: a transport fault is not marked inconclusive", dropped, { kind: "unresolved" });
  const other = await settleWithBudget({ settleUpdate: async () => settleResult("future-outcome" as SettleResult["outcome"]) } as unknown as EngineClient, "tok", undefined, zero);
  eq("ladder NEGATIVE CONTROL: another non-definitive answer is not marked inconclusive", other, { kind: "unresolved" });
  eq("ladder: the outcome string is the engine's", SETTLE_INCONCLUSIVE_OUTCOME, "inconclusive");
  eq("ladder: the reason string is the engine's", SETTLE_INCONCLUSIVE_REASON, "old-version-answering");
  eq("screen line", STALL_INCONCLUSIVE_LINE, "The new version is not answering yet. The console checks every 20 seconds and verifies the update when it answers.");
}

console.log(`\nVERDICT: ${failures === 0 ? "PASS" : "FAIL"} failures=${failures} checks=${checks} entry=validate-update-resettle.ts`);
verdictReached(failures, checks);
process.exit(failures === 0 ? 0 : 1);
