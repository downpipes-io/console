// Attended-verification (attest) domain functions for the EngineClient. Attended verification is the
// offline-key-only posture's IN-PLATFORM proof path: the CLIENT drives the loop. The operator selects their
// break-glass identity.key (read in the browser, NEVER uploaded), the engine issues a live-possession
// challenge and pins the runs to verify, the browser proves it holds the recovery key, then for each run the
// browser recovers the per-run master locally (openCapsule) and hands only THAT single-run master to its own
// engine for a keyed sample verify to a discard sink. No break-glass private and no plaintext ever transits;
// the masters are used per request and never held server-side. These are FREE FUNCTIONS over the shared
// Transport, mirroring client-keys.ts, wired onto EngineClient in client.ts.
//
// Gating: every route is under /admin (operator-level, session bound to its creator). create is a SENSITIVE
// action so it goes through the step-up gated path (t.gatedFetch), exactly as installKeys does; the later
// per-session calls carry the same session and are plain authenticated POST/GET. A refusal carries the
// engine's coarse, value-free reason, surfaced via foldableReason so the operator learns WHY. foldableReason
// rather than readErrorReason because a 401/403/429/5xx carries a closed marker from failResponse that the
// classifier and the copy layer both read, and folding a bare `error` over it loses the reading: an attested
// verification refused by the capability gate used to render as a role denial the console never established.

import type { Transport } from "./client-transport.ts";
import { isAttestSessionRecord, isCreateAttestSessionResult } from "./types.ts";
import type {
  AttestCapsulesResult,
  AttestSessionRecord,
  AttestVerifyResult,
  CreateAttestSessionResult,
} from "./types.ts";

// createAttestSession opens an attended-verification session: the engine pins the in-scope runs (all
// downpipes with a completed run, or the caller's selection), issues the live-possession challenge, and
// returns the size estimate. scope is the optional list of downpipe ids to restrict to (absent = every
// downpipe with a completed run). sampleRate is the requested per-run record sample (1..100; the engine
// echoes the effective rate it pinned). It is a SENSITIVE action, so it rides the step-up gated path like
// installKeys; a refusal carries the engine's coarse reason.
export async function createAttestSession(t: Transport, input: { scope?: string[]; sampleRate?: number } = {}): Promise<CreateAttestSessionResult> {
  const body: { scope?: string[]; sampleRate?: number } = {
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.sampleRate !== undefined ? { sampleRate: input.sampleRate } : {}),
  };
  const r = await t.gatedFetch("/admin/attest/session/create", {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const reason = await t.foldableReason(r);
    if (reason !== null) throw new Error(`start attended verification: ${reason}: ${r.status}`);
    return t.failResponse(r, "start attended verification");
  }
  const result = await t.parseJson<CreateAttestSessionResult>(r, "start attended verification");
  // A 2xx from a route the engine (or a demo/stub standing in for it) has not modelled is
  // indistinguishable from a real success by status code alone -- the failure is in the SHAPE, not the
  // status. Caught here, at the one place every caller's response passes through, so a malformed 200
  // throws a plain, actionable Error (the existing catch in restore-flow/attend.ts already renders it via
  // blockError with a Retry) instead of returning a session an unguarded `session.runs.length` then
  // crashed on three lines later.
  if (!isCreateAttestSessionResult(result)) throw new Error("start attended verification: the response did not include the pinned runs");
  return result;
}

// proveAttestSession answers the live-possession challenge: the browser derived the proof by decapsulating
// the challenge ciphertext with identity.key (deriveAttestProof), and this submits it as base64url. A match
// proves the operator holds the break-glass private RIGHT NOW, which is what a session gates on before it
// serves any capsule. The proof carries no key material (it is an HKDF output over the challenge nonce).
export async function proveAttestSession(t: Transport, input: { sessionId: string; proofB64: string }): Promise<{ ok: true }> {
  const r = await fetch(`${t.base}/admin/attest/session/prove`, {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const reason = await t.foldableReason(r);
    if (reason !== null) throw new Error(`prove key possession: ${reason}: ${r.status}`);
    return t.failResponse(r, "prove key possession");
  }
  return t.parseJson<{ ok: true }>(r, "prove key possession");
}

// attestCapsules fetches the master-capsule bundles for a batch of run ids: for each run the browser opens
// the wrap addressed to the held identity to recover the 32-byte per-run master locally. The MASTER is never
// served; only the wraps + the key commitment (bound as AAD so a wrong master fails closed) transit, so a
// party without identity.key learns nothing from them.
export async function attestCapsules(t: Transport, input: { sessionId: string; runIds: string[] }): Promise<AttestCapsulesResult> {
  const r = await fetch(`${t.base}/admin/attest/session/capsules`, {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const reason = await t.foldableReason(r);
    if (reason !== null) throw new Error(`fetch run capsules: ${reason}: ${r.status}`);
    return t.failResponse(r, "fetch run capsules");
  }
  return t.parseJson<AttestCapsulesResult>(r, "fetch run capsules");
}

// attestVerify submits a batch of browser-recovered per-run masters (base64url) for the engine to open each
// run and verify a seeded sample of its records to a DISCARD sink (each decrypted plaintext is hash-checked,
// counted, and dropped; nothing is written and no value is returned). The master is used for THIS request
// only and forgotten; the engine records the per-run pass/fail + sample rate as the attended-verification
// compliance stamp. Returns the per-run results and the whole-session progress.
export async function attestVerify(t: Transport, input: { sessionId: string; batch: Array<{ runId: string; masterB64: string }> }): Promise<AttestVerifyResult> {
  const r = await fetch(`${t.base}/admin/attest/session/verify`, {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const reason = await t.foldableReason(r);
    if (reason !== null) throw new Error(`verify runs: ${reason}: ${r.status}`);
    return t.failResponse(r, "verify runs");
  }
  return t.parseJson<AttestVerifyResult>(r, "verify runs");
}

// attestStatus reads a session's current record (for a resume after a reopened tab or a failed batch): which
// runs remain pending, whether the challenge is already proven, and the whole-session progress. Read-only.
export async function attestStatus(t: Transport, sessionId: string): Promise<{ session: AttestSessionRecord }> {
  const r = await fetch(`${t.base}/admin/attest/session/status?id=${encodeURIComponent(sessionId)}`, {
    headers: t.headers(),
    credentials: "include",
  });
  const body = await t.parseJson<{ session: AttestSessionRecord }>(r, "attended verification status");
  // The same wire-boundary guard as createAttestSession above, for the resume read. A route the
  // engine has not modelled degrades to a 200 with no `session` field, which restore-flow/attend.ts's
  // resumeSession then read `.runs` off directly.
  if (!isAttestSessionRecord(body.session)) throw new Error("attended verification status: the response did not include the session");
  return body;
}

// abortAttestSession ends a session early (the operator's Abort control): the engine drops the session and
// its stored challenge hash. It is best-effort from the console's view but returns the engine's outcome so a
// refusal is surfaced honestly rather than silently assumed.
export async function abortAttestSession(t: Transport, sessionId: string): Promise<{ ok: true }> {
  const r = await fetch(`${t.base}/admin/attest/session/abort`, {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify({ sessionId }),
  });
  if (!r.ok) {
    const reason = await t.foldableReason(r);
    if (reason !== null) throw new Error(`abort attended verification: ${reason}: ${r.status}`);
    return t.failResponse(r, "abort attended verification");
  }
  return t.parseJson<{ ok: true }>(r, "abort attended verification");
}
