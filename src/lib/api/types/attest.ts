// Attended-verification (attest) session mirror types, split out of ../types.ts like the other domain
// type modules. Attended verification is the offline-key-only posture's IN-PLATFORM proof path: the
// CLIENT drives the loop, recovering each run's master in the browser from the operator's break-glass
// identity.key (which is NEVER uploaded) and handing only the per-run masters to its OWN engine for a
// keyed sample verify to a discard sink. These shapes are redaction-safe by construction: a session
// carries run ids, friendly names, counts and a per-run pass/fail only, never a value or a key. The
// engine is the authority; the console mirrors the wire shape so the runner can type its calls. Where a
// field can be absent at runtime the mirror marks it optional so the runner degrades honestly rather than
// assuming a field. House rules: Australian English, no em dashes, precise claims.

import type { CapsuleWrap } from "../../keydecap.ts";

// AttestChallenge is the live-possession challenge the engine issues at session create: a hybrid-KEM
// ciphertext + nonce (base64url) the browser answers by decapsulating with identity.key and deriving the
// proof (deriveAttestProof). Only a holder of the break-glass PRIVATE can reproduce the proof, so a
// passing prove step is positive evidence the operator holds the recovery key right now (not a replay of a
// once-seen master). The engine stores only sha384(expectedProof); the browser is given only these two.
export interface AttestChallenge {
  ciphertextB64: string;
  nonceB64: string;
}

// AttestSessionRun is one PINNED run the session will verify: the owning downpipe, the run id, the
// downpipe's friendly name (for a self-identifying row) and the run's record count (for the progress
// denominator). Names and counts only; no value, no key.
export interface AttestSessionRun {
  downpipeId: string;
  runId: string;
  name: string;
  recordCount: number;
}

// AttestEstimate is the honest up-front size of the session: how many runs are pinned and roughly how many
// records will be verified at the chosen sample rate. It is a count only; the console shows it plainly and
// never fabricates a wall-clock (the first run's timing is genuinely unknown).
export interface AttestEstimate {
  runs: number;
  records: number;
}

// CreateAttestSessionResult is POST /admin/attest/session/create's body: the session id, the live-possession
// challenge, the pinned runs, the effective sample rate (the engine echoes what it pinned, which may clamp
// the requested value) and the size estimate. The sampleRate is the RECORDED rate the compliance stamp will
// carry, so the console reads the engine's echoed value, never the requested one.
export interface CreateAttestSessionResult {
  sessionId: string;
  challenge: AttestChallenge;
  runs: AttestSessionRun[];
  sampleRate: number;
  estimate: AttestEstimate;
}

// isCreateAttestSessionResult narrows an unknown value to CreateAttestSessionResult. `runs` is the
// one field a caller cannot safely assume: a route the engine (or a demo/stub standing in for it) has not
// modelled degrades to a generic {ok:true,...} shape with no such field, and `session.runs.length` is
// exactly what threw before this guard existed. Checked at the wire boundary (client-attest.ts) AND at the
// screen that drives the loop (restore-flow/attend.ts), so EVERY current and future caller is protected,
// not only the one route that happened to crash on it first. Deliberately loose beyond `runs` (an array is
// enough to unblock the `.length` read that crashed; the per-run shape is not re-validated here) so a
// harmless engine-side field addition never trips it.
export function isCreateAttestSessionResult(v: unknown): v is CreateAttestSessionResult {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.sessionId === "string" && o.sessionId !== "" && Array.isArray(o.runs);
}

// AttestCapsule is one run's master-recovery bundle: the master-capsule wraps (the browser opens the wrap
// addressed to the held identity to recover the 32-byte per-run master), the run's key commitment (bound as
// AAD so a wrong master fails closed) and the record count. The master itself is NEVER served; the browser
// derives it and hands only THAT single-run key back for the verify. No break-glass private transits.
export interface AttestCapsule {
  runId: string;
  masterCapsule: CapsuleWrap[];
  keyCommitment: string;
  recordCount: number;
}

// AttestCapsulesResult is POST /admin/attest/session/capsules's body for a batch of run ids.
export interface AttestCapsulesResult {
  capsules: AttestCapsule[];
}

// AttestVerifyRunResult is one run's verify outcome: the run id, a clean-pass flag, how many of the sampled
// records verified out of the run's total, the failure count and whether this run is the downpipe's latest.
// recordsVerified is the sampled subset actually checked (at a sub-100 sample rate it is less than
// recordsTotal); the console shows both so the proof is honest about how much it exercised.
export interface AttestVerifyRunResult {
  runId: string;
  ok: boolean;
  recordsVerified: number;
  recordsTotal: number;
  failures: number;
  isLatest: boolean;
}

// AttestProgress is the running tally the engine returns after each verify batch: verified / failed /
// pending / total runs across the whole session, so the runner can drive its progress panel from the
// engine's own count rather than re-deriving it.
export interface AttestProgress {
  verified: number;
  failed: number;
  pending: number;
  total: number;
}

// AttestVerifyResult is POST /admin/attest/session/verify's body: the per-run results for the submitted
// batch and the whole-session progress after applying them.
export interface AttestVerifyResult {
  results: AttestVerifyRunResult[];
  progress: AttestProgress;
}

// AttestRunState is a pinned run's coarse state as the STATUS read reports it, for a resume: pending (not
// yet verified), verified (a clean pass), failed (some sampled record did not recover), skipped (the engine
// resolved the run without a pass/fail verdict). The console adds a transient "verifying" of its own while
// a batch is in flight; the engine only ever persists the other four.
//
// "skipped" was missing entirely: the engine's
// AttestSessionRunState.state (engine/src/sched/types.ts) has always accepted it (the DO's record-verify
// guard, scheduler-do-attest.ts:176, writes it verbatim), but a full sweep of every engine caller found NO
// current producer -- POST /attest/session/verify (router-attest.ts) only ever sends "verified" | "failed".
// So today "skipped" is reachable by the engine's own type and guard but not by any live code path; it is
// carried here for type completeness and so a future engine change (or a hand-edited/replayed session
// record) is not silently mishandled. Before this fix a skipped run was excluded from the "pending" count
// (correct) but had NO visible treatment anywhere else: resumeSession (restore-flow/attend.ts) drops it
// from the rebuilt run list entirely, so it would vanish from the resume panel rather than showing as
// resolved-without-a-verdict.
export type AttestRunState = "pending" | "verified" | "failed" | "skipped";

// AttestSessionRunStatus is one pinned run's row in the STATUS read: the run id (always) plus, when the
// engine carries them, the identity + progress fields the resume panel repaints from. Every field beyond
// runId is optional so a leaner status body still resumes (the runner falls back to the create response's
// run list for names/counts).
export interface AttestSessionRunStatus {
  runId: string;
  downpipeId?: string;
  name?: string;
  recordCount?: number;
  state: AttestRunState;
  recordsVerified?: number;
  recordsTotal?: number;
  failures?: number;
  isLatest?: boolean;
}

// AttestSessionRecord is GET /admin/attest/session/status?id='s `session` object: enough to resume a
// session after a reopened tab or a failed batch. proven marks the live-possession challenge already
// answered (so a resume does not re-prove); status marks the whole session active / complete / aborted.
// Every field but sessionId is optional: the runner reads them defensively and degrades to the create
// response (or an honest "cannot resume") rather than assuming a field the engine did not send.
export interface AttestSessionRecord {
  sessionId: string;
  scope?: string[];
  sampleRate?: number;
  proven?: boolean;
  status?: "active" | "complete" | "aborted";
  runs?: AttestSessionRunStatus[];
  progress?: AttestProgress;
  createdAt?: string;
}

// isAttestSessionRecord narrows an unknown `session` field to AttestSessionRecord (the same shape as
// isCreateAttestSessionResult above, for GET /admin/attest/session/status's response instead of create's).
// `session` is unmodelled the exact same way create was: a route the engine has not modelled degrades to a
// 200 with no `session` field at all, so `(await engine.attestStatus(id)).session` reads as `undefined`, and
// restore-flow/attend.ts's resumeSession then read `record.runs` on it unguarded. Only `sessionId` is
// required by the wire type, so that is all this checks.
export function isAttestSessionRecord(v: unknown): v is AttestSessionRecord {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.sessionId === "string" && o.sessionId !== "";
}
