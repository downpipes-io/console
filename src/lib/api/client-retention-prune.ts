// Retention-prune domain functions for the EngineClient, mirroring client-attest.ts's shape: FREE
// functions over the shared Transport, wired onto EngineClient in client.ts. This is the break-glass-only
// posture's no-CLI replacement for `downpipe prune`: the browser recovers each candidate run's master
// locally (keydecap.ts openCapsule) from the operator's break-glass identity.key (or an M-of-N quorum),
// then hands back ONLY those per-run masters, batched, for the engine to plan (and, only when this
// downpipe's own stored retention.enforce is true, apply). No break-glass private and no plaintext ever
// transits; the masters are used per request and never held server-side.
//
// Gating: candidate (POST /admin/retention-prune/candidate) is a plain authenticated POST, mirroring
// attestCapsules and the break-glass restore panel's restoreCapsule -- it discloses only non-secret
// capsule wraps already sitting in the customer's own bucket. apply (POST /admin/retention-prune/apply) is
// a SENSITIVE, destructive action, so it goes through the step-up gated path (t.gatedFetch), exactly as
// createAttestSession does.

import type { Transport } from "./client-transport.ts";
import type { PruneApplyResult, PruneApproval, PruneCandidateResult, PruneRejectReason } from "./types.ts";
import { isPruneApplyResult, isPruneApproval, isPruneApprovalList, isPruneCandidateResult } from "./types.ts";

// retentionPruneCandidate fetches a downpipe's CURRENT retained/superseded split (recomputed fresh from
// its live RUNLOG on every call) plus the non-secret master capsules for every run in that split.
export async function retentionPruneCandidate(t: Transport, downpipeId: string): Promise<PruneCandidateResult> {
  const r = await fetch(`${t.base}/admin/retention-prune/candidate`, {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify({ downpipeId }),
  });
  if (!r.ok) {
    const reason = await t.foldableReason(r);
    if (reason !== null) throw new Error(`fetch prune candidates: ${reason}: ${r.status}`);
    return t.failResponse(r, "fetch prune candidates");
  }
  const result = await t.parseJson<PruneCandidateResult>(r, "fetch prune candidates");
  if (!isPruneCandidateResult(result)) throw new Error("fetch prune candidates: the response did not include the candidate split");
  return result;
}

// retentionPruneApply submits a batch of browser-recovered per-run masters for the engine to plan (and,
// only when this downpipe's own stored retention.enforce is true and previewOnly is not set, apply) a
// prune. previewOnly:true forces a dry-run plan even when enforce is configured true, for an explicit
// "show me what would happen" step before the operator commits. The masters are used for THIS request
// only and forgotten; the caller (the panel) zeroes its own copies after this call returns.
export async function retentionPruneApply(t: Transport, input: { downpipeId: string; batch: Array<{ runId: string; masterB64: string }>; previewOnly?: boolean }): Promise<PruneApplyResult> {
  const body: { downpipeId: string; batch: Array<{ runId: string; masterB64: string }>; previewOnly?: boolean } = {
    downpipeId: input.downpipeId,
    batch: input.batch,
    ...(input.previewOnly !== undefined ? { previewOnly: input.previewOnly } : {}),
  };
  const r = await t.gatedFetch("/admin/retention-prune/apply", {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify(body),
  });
  // "not-approved" (dual control refused: no usable approval armed for this exact plan) rides a 403
  // carrying a REAL PruneApplyResult body (mode, planHash, counts) -- an EXPECTED outcome this call must
  // hand back as data, not discard as a generic transport failure. Every OTHER 403 (the restore.apply
  // capability gate itself refusing the caller) carries the engine's plain {error} shape instead and falls
  // through to the ordinary failure handling below unchanged. Read from a CLONE so an unrecognised 403 body
  // is still available, unconsumed, to parseJsonOrReason's own reason-fold.
  if (r.status === 403) {
    try {
      const maybe: unknown = await r.clone().json();
      if (isPruneApplyResult(maybe) && maybe.mode === "not-approved") return maybe;
    } catch {
      // not JSON, or not the expected shape: fall through to the normal failure handling below.
    }
  }
  const result = await t.parseJsonOrReason<PruneApplyResult>(r, "run retention prune");
  if (!isPruneApplyResult(result)) throw new Error("run retention prune: the response did not include an outcome");
  return result;
}

// ---- Dual control: request -> approve (maker != checker) -> reject, mirroring client-restore.ts's
// requestRestore/approveRestore/rejectRestore/listApprovals shape exactly. request is a plain authenticated
// POST (raising a request writes no archive data); approve is a SENSITIVE action, so it goes through the
// step-up gated path, mirroring approveRestore. ----------------------------------------------------------

// retentionPruneRequest raises a dual-control request bound to the downpipe's CURRENT retained/superseded
// split; the engine recomputes the planHash server-side (keyless -- no master is ever needed to request or
// approve), so this call never needs one either.
export async function retentionPruneRequest(t: Transport, input: { downpipeId: string; reason: string }): Promise<PruneApproval> {
  const r = await fetch(`${t.base}/admin/retention-prune/request`, {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify(input),
  });
  const result = await t.parseJsonOrReason<PruneApproval>(r, "request prune approval");
  if (!isPruneApproval(result)) throw new Error("request prune approval: the response did not include an approval record");
  return result;
}

export async function retentionPruneApprove(t: Transport, planHash: string): Promise<PruneApproval> {
  const r = await t.gatedFetch("/admin/retention-prune/approve", { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ planHash }) });
  const result = await t.parseJsonOrReason<PruneApproval>(r, "approve prune request");
  if (!isPruneApproval(result)) throw new Error("approve prune request: the response did not include an approval record");
  return result;
}

export async function retentionPruneReject(t: Transport, planHash: string, rejectReason: PruneRejectReason): Promise<PruneApproval> {
  const r = await fetch(`${t.base}/admin/retention-prune/reject`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ planHash, rejectReason }) });
  const result = await t.parseJsonOrReason<PruneApproval>(r, "reject prune request");
  if (!isPruneApproval(result)) throw new Error("reject prune request: the response did not include an approval record");
  return result;
}

// retentionPruneApprovals reads the pending prune-approval inbox: Approver/Owner see every record; a
// requester also sees their own.
export async function retentionPruneApprovals(t: Transport): Promise<PruneApproval[]> {
  const r = await fetch(`${t.base}/admin/retention-prune/approvals`, { headers: t.headers(), credentials: "include" });
  const result = await t.parseJson<PruneApproval[]>(r, "prune approvals");
  if (!isPruneApprovalList(result)) throw new Error("prune approvals: the response was not a list of approval records");
  return result;
}
