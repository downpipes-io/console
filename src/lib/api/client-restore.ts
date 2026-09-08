// Restore dual-control + restorability-assurance domain functions for the EngineClient (split from client.ts
// per findings console-src-010-01 / console-sys-arch-01 / console-sys-struct-03). Free functions over the
// shared Transport; request URL/method/body/headers and parse logic moved VERBATIM.
//
// A restore APPLY over live data requires a SECOND authorised identity's approval, bound to the plan hash,
// with maker != checker (F4) enforced server-side. requestRestore raises a request (Operator+);
// approveRestore/rejectRestore are Approver/Owner and the engine refuses a self-approval; listApprovals is
// the pending inbox.

import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type { BlindRestoreTest, KeylessAttestationResult, RestoreApproval, RestoreApprovalRequest, RestoreRejectReason } from "./types.ts";

// requestRestore raises a restore-approval request. The request shape (selectors + the maker-side
// blast-radius cues, never the Cloudflare token) is the named RestoreApprovalRequest in
// types/restore-types.ts, where its contract (the engine's ENG-H3 cross-check, the plan-hash
// binding of recordName / cfConfig, and the no-custody guarantee) is documented.
export async function requestRestore(t: Transport, req: RestoreApprovalRequest): Promise<RestoreApproval> {
  const r = await engineFetch(`${t.base}/admin/restore/request`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify(req) });
  return t.parseJson<RestoreApproval>(r, "restore request");
}

export async function approveRestore(t: Transport, planHash: string): Promise<RestoreApproval> {
  const r = await t.gatedFetch("/admin/restore/approve", { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ planHash }) });
  return t.parseJsonOrReason<RestoreApproval>(r, "restore approve");
}

// rejectReason is the checker's CLOSED verdict and it is REQUIRED. It is a closed member, never a
// typed sentence: the approver's prose would name the customer's own data and it rides into the sealed pack.
export async function rejectRestore(t: Transport, planHash: string, rejectReason: RestoreRejectReason): Promise<RestoreApproval> {
  const r = await engineFetch(`${t.base}/admin/restore/reject`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ planHash, rejectReason }) });
  return t.parseJsonOrReason<RestoreApproval>(r, "restore reject");
}

export async function listApprovals(t: Transport): Promise<RestoreApproval[]> {
  const r = await engineFetch(`${t.base}/admin/restore/approvals`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<RestoreApproval[]>(r, "approvals");
}

// restorability assurance: the BLIND restore test + the KEYLESS attestation. Both PROVE a sealed run can be
// recovered WITHOUT writing a byte back and WITHOUT surfacing any plaintext, so both are read-SAFE and gate
// on the restore.verify capability (viewer and up), never restore.apply. They are the dated recoverability
// proof a DR responder/auditor wants:
//   - verifyRestore (POST /admin/restore/verify) is the keyed BLIND test: the engine decrypts EVERY in-scope
//     record to a discard sink, checks each plaintext hash against the signed recordHash, and returns counts
//     + a restoreDigest, NEVER a single byte of plaintext. ok is true iff every in-scope record verified. The
//     restoreDigest folds each verified record's (recordId, plaintextSha384) so a repeat test proves the SAME
//     data restores.
//   - attestRestore (POST /admin/restore/attest) is the Tier 0 KEYLESS integrity attestation: signature +
//     completeness (no missing shard) + anti-rollback, with NO decryption key and NO data, so it runs even in
//     the break-glass-only posture where the engine holds no read-back key. It decrypts nothing at all.
// On a clean pass the engine stamps the per-downpipe "offline restorability last proven" record (who + when +
// method), which surfaces on the downpipe state's lastRestoreProven* fields. Both are mutating POSTs that
// drive real IO, so the engine rate-limits each per caller like the dry-run; a 429 is a transport/auth-class
// fault here. No-custody: a request carries the runId and selectors only, and a result carries counts, coarse
// per-record failure reasons (the source names, never a value) and a digest over hashes; never a key and
// never a record value.

// verifyRestore runs the BLIND restore test for a run. include/exclude scope it (the same
// selectors the dry-run uses); maxRecords caps a large run into a bounded window.
// exactOptionalPropertyTypes: each optional field is attached only when supplied.
export async function verifyRestore(t: Transport, req: { runId: string; include?: string[]; exclude?: string[]; maxRecords?: number }): Promise<BlindRestoreTest> {
  const r = await engineFetch(`${t.base}/admin/restore/verify`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify(req) });
  return t.parseJson<BlindRestoreTest>(r, "restore verify");
}

// attestRestore runs the KEYLESS Tier 0 integrity attestation for a run (signature + completeness
// + anti-rollback, no key and no data). The body carries only the runId.
export async function attestRestore(t: Transport, runId: string): Promise<KeylessAttestationResult> {
  const r = await engineFetch(`${t.base}/admin/restore/attest`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ runId }) });
  return t.parseJson<KeylessAttestationResult>(r, "restore attest");
}
