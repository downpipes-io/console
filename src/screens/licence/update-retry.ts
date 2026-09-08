// The injectable-timer retry/backoff engine for the orchestrated apply flow. Root cause of the 0.1.4
// "could not be read" errors: every deploy in the
// flow swaps a worker, so the very next read through it races the swap window and fails; the ENGINE already
// had a retry ladder (0.1.3), but the BROWSER made one attempt and told the operator to refresh. This module
// is the fix: a settle call gets a grace pause then a bounded retry ladder before the flow falls back to
// re-reading the engine's PERSISTED record (persistence-first, unchanged in spirit from the pre-existing
// recoverSettleConclusion in update-apply-flow.ts); that re-read is itself retried, never a single shot; and
// once the whole budget is spent without a definitive answer, a bounded background poll keeps checking
// silently so the operator never has to refresh or re-paste a token (the s2 stall invariant).
//
// Every delay is an injectable hook, defaulting to the real s2 numbers; the validators zero every one of them
// so a whole ladder run exhausts in the same tick (no real clock in a test). House rules: Australian English,
// no em dashes.

import { sleep } from "../../lib/bulk-pacing.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { recordedSettleOutcome, type RecordedSettleOutcome } from "./shared.ts";
import type { EngineClient, RampSettleResult, SettleResult, UpdateApplyResult, UpdateComponentId, UpdateStatusRecord } from "../../api.ts";

// The s2 numbers: ~5s grace before the first settle attempt, then retries at ~+5s/+10s/+20s on failure or a
// non-definitive outcome (three retries, four attempts total: the grace-delayed first try plus three more).
// Every status re-read gets its own bounded retry, 3 attempts, 3-5s apart (a mild ramp within the stated
// band). Worst case before the stall state is therefore approximately grace(5) + ladder(5+10+20=35) +
// status-retry(3+4=7, the gaps between 3 reads) ~= 47s, in the neighbourhood of the design's own "~60-90s"
// figure (itself an approximation, per its "~"; the design does not pin an exact total).
export const DEFAULT_GRACE_MS = 5_000;
export const DEFAULT_SETTLE_BACKOFF_MS: readonly number[] = [5_000, 10_000, 20_000];
export const DEFAULT_STATUS_RETRIES = 3;
export const DEFAULT_STATUS_BACKOFF_MS: readonly number[] = [3_000, 4_000, 5_000];
export const DEFAULT_STALL_POLL_MS = 20_000;
// A ceiling on the SILENT background poll once stalled (s2: "it DOES keep polling"), so a permanently
// unreachable engine cannot spin a tab's timer forever. Roughly the order of magnitude of a tab plausibly
// left open (20s * 30 ~= 10 minutes); reopening the screen always re-derives the pending state fresh
// regardless (design s2: the pending card is the resume surface, independent of this poll).
export const MAX_STALL_POLL_ATTEMPTS = 30;

// RetryHooks are the injectable seams for the validators ONLY (drive the whole ladder with a zeroed clock).
// Production callers pass {} and get the real s2 numbers.
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
// surfaces would drift on how hard they try, and the ramp settle exists because the two surfaces already
// drifted once. A throw (the worker-swap race root cause #1) and a non-definitive outcome both count as "not
// yet" and are retried with the SAME one-shot token; an authorisation failure is rethrown (the caller routes
// it to sign-out) rather than swallowed into a false "not yet".
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
      // Transport fault: the raced-swap-window failure root cause #1 names. Retry, do not conclude.
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
// QUEUED IS NOT "NOT YET". The KEEP direction of a settle on a migration/breaking release is dual-control
// gated (engine router-updates.ts), so the engine answers 202 { ownerActionQueued } and settles nothing until
// a second owner approves. Before this type the client decoded that 202 as an ordinary 2xx body, the ladder
// read its absent `outcome` as a non-definitive answer and RETRIED it to the end of the budget, and the flow
// then reported that the settle outcome could not be read. Retrying is exactly wrong here: the answer will
// not change until a human approves, so the run stops on the first queued answer and the flow says so.
export type SettleLadderOutcome = { kind: "settled"; settle: SettleResult } | { kind: "queued"; id: string } | { kind: "unresolved" };

// settleWithBudget runs the ladder over engine.settleUpdate, the ATOMIC (non-ramp) settle. Returns the
// definitive SettleResult, the owner-action queue, or "unresolved" when the whole ladder is spent without
// either (the caller then falls back to readRecordedStatusWithRetry). The definitiveness rule is the four
// outcomes the engine's settle can CONCLUDE with: applied, rolled-back, and two more members,
// rollback-failed and applied-unconfirmed. This comment used to say the first two were "the only outcomes
// it trusts, and anything else (a garbled or future outcome value) is retried". The other two are neither
// garbled nor future: they are current, documented and emitted by the engine this console ships beside, and
// calling them garbled is what kept them out of the rule for as long as they existed. A genuinely unknown
// value is still retried and still falls through to the persisted-record recovery.
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
      // "rollback-failed" and "applied-unconfirmed" ARE DEFINITIVE, for the reason the ramp twin below
      // already states for its own compound member: the engine finished settling and wrote its record, so
      // re-submitting cannot change the answer. Treating them as garbled sat on the two loudest facts in
      // the update surface for the whole ladder budget and then reported them as a settle that could not be
      // read, which is a fault report about an engine that answered honestly the first time.
      return kind === "applied" || kind === "rolled-back" || kind === "rollback-failed" || kind === "applied-unconfirmed";
    },
    hooks,
  );
  const d = run.definitive;
  if (d === null) return { kind: "unresolved" };
  return d.status === "queued" ? { kind: "queued", id: d.id } : { kind: "settled", settle: d.value };
}

// rampSettleWithBudget is the SAME ladder over engine.settleRampUpdate, the GRADUAL RAMP's settle, and it is
// the call a ramped pending had no way to make. Two things differ from the plain settle, and both come from
// what the engine's ramp settle actually returns:
//
//   1. "rollback-failed-still-split" IS DEFINITIVE. The ramped version failed AND the rollback to 100% prior
//      failed, so live customer traffic is still reaching the suspect version right now. Retrying that on the
//      ladder (the plain settle's rule would, since it is neither applied nor rolled-back) would sit on the
//      single loudest fact in the update surface for the length of the budget and then report it as a settle
//      that could not be read. It is returned immediately.
//
//   2. "inconclusive" IS NOT AN ERROR, and it is not lost either. It means THIS dispatch did not land on the
//      ramped slice, so nothing was changed and the pending stays armed. It is retried (each attempt is a
//      fresh dispatch with its own chance of landing, and each one bumps the engine's own
//      update-settle-inconclusive counter, which is what tells support the operator has been trying), and when
//      the whole budget is spent on inconclusives it is RETURNED as `lastSeen` rather than degraded to null.
//      The card can then say the true thing -- the ramp is unchanged, try again -- instead of the plain
//      settle's "the outcome could not be read", which would be a fault report about a healthy engine.
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

// readRecordedStatusWithRetry re-reads the engine's PERSISTED update-status record with its own bounded
// retry (the second half of root cause #1: "every status re-read retried 3x with 3-5s backoff"), rather than
// the single attempt this flow used to make. A throw on every attempt is honestly "unrecoverable" (null); the
// caller (recordedSettleOutcome) already treats a null record as the honest "unknown" conclusion.
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

// pollUntilDefinitive is the s2 stall invariant made real: once the whole retry budget above is spent
// without a definitive answer, THIS keeps checking silently in the background (no user action requested) up
// to MAX_STALL_POLL_ATTEMPTS, calling `onSettled` the moment the record becomes definitive (applied /
// rolled-back / rollback-failed / applied-unconfirmed / expired-cleared: an INCIDENT is a conclusion, and
// leaving one out meant the poll ran its whole budget over a settled record and left the stall sentence
// standing as the last thing the operator was told, via the SAME recordedSettleOutcome mapping, so
// "definitive" has exactly one implementation). It is fire-and-forget by construction (the caller does not
// await it; the orchestrated flow has already returned control to the operator and re-enabled its button);
// `isLive` lets it bail the moment its render target has left the document (the operator navigated away),
// mirroring the isConnected guard screens/common.ts's focusFirstField already uses for the identical reason.
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
