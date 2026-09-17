// The injectable-timer retry/backoff engine for the orchestrated apply flow. Every deploy in the flow swaps a
// worker, so the very next read through it races the swap window and can fail; a settle call gets a grace
// pause then a bounded retry ladder before the flow falls back to re-reading the engine's persisted record
// (persistence-first, matching recoverSettleConclusion in update-apply-flow.ts); that re-read is itself
// retried, never a single shot; and once the whole budget is spent without a definitive answer, a bounded
// background poll keeps checking silently so the operator never has to refresh or re-paste a token.
//
// Every delay is an injectable hook, defaulting to the real production numbers; the validators zero every one
// of them so a whole ladder run exhausts in the same tick (no real clock in a test).

import { sleep } from "../../lib/bulk-pacing.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { recordedSettleOutcome, type RecordedSettleOutcome } from "./shared.ts";
import type { EngineClient, RampSettleResult, SettleResult, UpdateApplyResult, UpdateComponentId, UpdateStatusRecord } from "../../api.ts";

// The timing: ~5s grace before the first settle attempt, then retries at ~+5s/+10s/+20s on failure or a
// non-definitive outcome (three retries, four attempts total: the grace-delayed first try plus three more).
// Every status re-read gets its own bounded retry, 3 attempts, 3-5s apart (a mild ramp within the stated
// band). Worst case before the stall state is therefore approximately grace(5) + ladder(5+10+20=35) +
// status-retry(3+4=7, the gaps between 3 reads) ~= 47 seconds.
export const DEFAULT_GRACE_MS = 5_000;
export const DEFAULT_SETTLE_BACKOFF_MS: readonly number[] = [5_000, 10_000, 20_000];
export const DEFAULT_STATUS_RETRIES = 3;
export const DEFAULT_STATUS_BACKOFF_MS: readonly number[] = [3_000, 4_000, 5_000];
export const DEFAULT_STALL_POLL_MS = 20_000;
// A ceiling on the silent background poll once stalled, so a permanently unreachable engine cannot spin a
// tab's timer forever. Roughly the order of magnitude of a tab plausibly left open (20s * 30 ~= 10 minutes);
// reopening the screen always re-derives the pending state fresh regardless: the pending card is the resume
// surface, independent of this poll.
export const MAX_STALL_POLL_ATTEMPTS = 30;

// RetryHooks are the injectable seams for the validators ONLY (drive the whole ladder with a zeroed clock).
// Production callers pass {} and get the real production numbers.
export interface RetryHooks {
  graceMs?: number;
  settleBackoffMs?: readonly number[];
  statusRetries?: number;
  statusBackoffMs?: readonly number[];
  stallPollMs?: number;
}

// LadderRun is what one full grace-plus-retry run saw. `definitive` is the outcome the caller can act on;
// `lastSeen` is the last result the ENGINE actually returned when none of them was definitive, which is the
// difference between "the engine kept answering, and kept saying the same non-definitive thing" and "every
// attempt threw and we never heard from it at all". The plain settle has no use for that distinction (its
// non-definitive answers are garbled/future values it must not trust); the RAMP settle has exactly one, and
// it is the whole point of the ramp settle: `inconclusive` is a real, retry-meaningful, nothing-was-changed
// verdict, and reporting it as "could not be read" would be a lie about a healthy engine.
interface LadderRun<T> {
  definitive: T | null;
  lastSeen: T | null;
}

// runSettleLadder is the ONE grace-plus-retry ladder both settle paths use (the plain settle and the ramp
// settle). Keeping it single is deliberate: two copies of a retry budget is precisely how the two settle
// surfaces would drift on how hard they try. A throw (the worker-swap race) and a non-definitive outcome both
// count as "not yet" and are retried with the same one-shot token; an authorisation failure is rethrown (the
// caller routes it to sign-out) rather than swallowed into a false "not yet".
async function runSettleLadder<T>(attemptOnce: () => Promise<T>, isDefinitive: (v: T) => boolean, hooks: RetryHooks): Promise<LadderRun<T>> {
  const grace = hooks.graceMs ?? DEFAULT_GRACE_MS;
  const ladder = hooks.settleBackoffMs ?? DEFAULT_SETTLE_BACKOFF_MS;
  if (grace > 0) await sleep(grace);
  let lastSeen: T | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      const settle = await attemptOnce();
      if (isDefinitive(settle)) return { definitive: settle, lastSeen };
      lastSeen = settle;
    } catch (err) {
      if (isUnauthorised(err)) throw err;
      // Transport fault: the raced-swap-window failure. Retry, do not conclude.
    }
    if (attempt >= ladder.length) return { definitive: null, lastSeen };
    const wait = ladder[attempt] ?? 0;
    if (wait > 0) await sleep(wait);
  }
}

// SettleLadderOutcome is what a whole settle ladder run means to the caller. "settled" is the definitive
// SettleResult it can act on; "unresolved" is the budget spent without one (the caller falls back to
// readRecordedStatusWithRetry); "queued" is the engine's owner-action 202, which is NEITHER, and is the case
// this type exists for.
//
// QUEUED IS NOT "NOT YET". The keep direction of a settle on a migration/breaking release is dual-control
// gated (engine router-updates.ts), so the engine answers 202 { ownerActionQueued } and settles nothing until
// a second owner approves. Retrying that answer is wrong: it will not change until a human approves, so the
// run stops on the first queued answer and the flow says so.
export type SettleLadderOutcome = { kind: "settled"; settle: SettleResult } | { kind: "queued"; id: string } | { kind: "unresolved" };

// settleWithBudget runs the ladder over engine.settleUpdate, the ATOMIC (non-ramp) settle. Returns the
// definitive SettleResult, the owner-action queue, or "unresolved" when the whole ladder is spent without
// either (the caller then falls back to readRecordedStatusWithRetry). The definitiveness rule is the four
// outcomes the engine's settle can conclude with: applied, rolled-back, rollback-failed and
// applied-unconfirmed. The last two are neither garbled nor future values: they are current, documented
// outcomes emitted by the engine this console ships beside, so they must count as definitive rather than
// being retried as if they were noise. A genuinely unknown value is still retried and still falls through to
// the persisted-record recovery.
export async function settleWithBudget(
  engine: EngineClient,
  token: string,
  components: UpdateComponentId[] | undefined,
  hooks: RetryHooks = {},
): Promise<SettleLadderOutcome> {
  const run = await runSettleLadder<UpdateApplyResult<SettleResult>>(
    () => engine.settleUpdate(token, components),
    (res) => {
      // A queued 202 is DEFINITIVE for the ladder's purposes: re-submitting cannot change it, so stop.
      if (res.status === "queued") return true;
      const kind: string = res.value.outcome;
      // "rollback-failed" and "applied-unconfirmed" are definitive, for the same reason the ramp twin below
      // states for its own compound member: the engine finished settling and wrote its record, so
      // re-submitting cannot change the answer. Treating them as anything less than definitive would sit on
      // the two loudest facts in the update surface for the whole ladder budget, then report a settle that
      // could not be read -- a fault report about an engine that answered honestly.
      return kind === "applied" || kind === "rolled-back" || kind === "rollback-failed" || kind === "applied-unconfirmed";
    },
    hooks,
  );
  const d = run.definitive;
  if (d === null) return { kind: "unresolved" };
  return d.status === "queued" ? { kind: "queued", id: d.id } : { kind: "settled", settle: d.value };
}

// rampSettleWithBudget is the same ladder over engine.settleRampUpdate, the gradual ramp's settle: it is what
// lets a ramped pending resolve. Two things differ from the plain settle, both following from what the
// engine's ramp settle actually returns:
//
//   1. "rollback-failed-still-split" is definitive. The ramped version failed and the rollback to 100% prior
//      also failed, so live customer traffic is still reaching the suspect version right now. Retrying that
//      on the ladder (the plain settle's rule would, since it is neither applied nor rolled-back) would sit on
//      the single loudest fact in the update surface for the length of the budget and then report it as a
//      settle that could not be read. It is returned immediately.
//
//   2. "inconclusive" is not an error, and it is not lost either. It means this dispatch did not land on the
//      ramped slice, so nothing was changed and the pending stays armed. It is retried (each attempt is a
//      fresh dispatch with its own chance of landing, and each one bumps the engine's own
//      update-settle-inconclusive counter, which is what tells support the operator has been trying), and when
//      the whole budget is spent on inconclusives it is returned as `lastSeen` rather than degraded to null.
//      The card can then say the true thing -- the ramp is unchanged, try again -- instead of "the outcome
//      could not be read", which would be a fault report about a healthy engine.
//
// Returns the whole LadderRun: `definitive` set means act on it; `definitive` null with `lastSeen` set means
// every answer was inconclusive; both null means the engine never answered at all (a genuine transport fault,
// and the caller falls back to the persisted record exactly as the plain settle does).
export async function rampSettleWithBudget(engine: EngineClient, token: string, hooks: RetryHooks = {}): Promise<LadderRun<RampSettleResult>> {
  return runSettleLadder<RampSettleResult>(
    () => engine.settleRampUpdate(token),
    (settle) => {
      const kind: string = settle.outcome;
      return kind === "applied" || kind === "rolled-back" || kind === "rollback-failed-still-split";
    },
    hooks,
  );
}

// readRecordedStatusWithRetry re-reads the engine's persisted update-status record with its own bounded
// retry: every status re-read is retried up to 3 times with 3-5s backoff rather than made as a single
// attempt. A throw on every attempt is honestly "unrecoverable" (null); the caller (recordedSettleOutcome)
// already treats a null record as the honest "unknown" conclusion.
export async function readRecordedStatusWithRetry(engine: EngineClient, hooks: RetryHooks = {}): Promise<UpdateStatusRecord | null> {
  const retries = hooks.statusRetries ?? DEFAULT_STATUS_RETRIES;
  const backoff = hooks.statusBackoffMs ?? DEFAULT_STATUS_BACKOFF_MS;
  const attempts = Math.max(1, Math.floor(retries));
  for (let i = 0; i < attempts; i++) {
    try {
      return await engine.updateStatus();
    } catch {
      // A read fault is retried, never surfaced directly (the recorded truth is worth waiting for).
    }
    if (i < attempts - 1) {
      const wait = backoff[i] ?? backoff[backoff.length - 1] ?? 0;
      if (wait > 0) await sleep(wait);
    }
  }
  return null;
}

// pollUntilDefinitive keeps the stall behaviour honest: once the whole retry budget above is spent without a
// definitive answer, this keeps checking silently in the background (no user action requested) up to
// MAX_STALL_POLL_ATTEMPTS, calling `onSettled` the moment the record becomes definitive (applied /
// rolled-back / rollback-failed / applied-unconfirmed / expired-cleared: an incident is a conclusion; leaving
// one out would let the poll run its whole budget over a settled record and leave the stall sentence standing
// as the last thing the operator was told, via the same recordedSettleOutcome mapping, so "definitive" has
// exactly one implementation). It is fire-and-forget by construction (the caller does not await it; the
// orchestrated flow has already returned control to the operator and re-enabled its button); `isLive` lets it
// bail the moment its render target has left the document (the operator navigated away), mirroring the
// isConnected guard screens/common.ts's focusFirstField uses for the identical reason.
export function pollUntilDefinitive(
  engine: EngineClient,
  isLive: () => boolean,
  onSettled: (outcome: RecordedSettleOutcome, rec: UpdateStatusRecord) => void,
  hooks: RetryHooks = {},
): void {
  const intervalMs = hooks.stallPollMs ?? DEFAULT_STALL_POLL_MS;
  let attempt = 0;
  const reschedule = (): void => {
    if (!isLive()) return;
    if (intervalMs > 0) window.setTimeout(tick, intervalMs);
    else void Promise.resolve().then(tick);
  };
  const tick = (): void => {
    if (!isLive() || attempt >= MAX_STALL_POLL_ATTEMPTS) return;
    attempt++;
    void engine
      .updateStatus()
      .then((rec) => {
        if (!isLive()) return;
        const outcome = recordedSettleOutcome(rec);
        if (outcome.kind === "applied" || outcome.kind === "rolled-back" || outcome.kind === "rollback-failed" || outcome.kind === "applied-unconfirmed" || outcome.kind === "expired-cleared") {
          onSettled(outcome, rec);
          return;
        }
        reschedule();
      })
      .catch(() => reschedule());
  };
  reschedule();
}
