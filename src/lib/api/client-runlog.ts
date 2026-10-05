// The attended RUNLOG actions for the EngineClient: free functions over the shared Transport, mirroring
// client-keys.ts and client-attest.ts, wired onto EngineClient in client.ts. Three Owner-only ways past a
// RUNLOG the writers refuse to modify on their own, each read-then-decide and never automatic:
//
//   GET  /admin/runlog/signature + POST /admin/runlog/resign   a signature that does not verify.
//   GET  /admin/runlog/floor     + POST /admin/runlog/floor/reset  an env destination's anti-rollback floor
//        confirmed under a bucket a redeploy has since repointed away from.
//   GET  /admin/runlog/chain     + POST /admin/runlog/relink   one downpipe's chain anomaly in a RUNLOG that
//        otherwise verifies.
//
// Each GET promotes and signs nothing. Each POST is a SENSITIVE action, so it rides the step-up gated path
// (t.gatedFetch), exactly as installKeys does, and refuses a digest (or expected floor) that no longer
// matches what the read showed, so a RUNLOG that changed between the read and the decision is never acted on
// blind.

import type { Transport } from "./client-transport.ts";
import { engineFetch } from "./engine-fetch.ts";
import type { RunlogChainView, RunlogFloorResetResult, RunlogFloorView, RunlogRelinkResult, RunlogResignResult, RunlogSignatureView } from "./types.ts";

// getRunlogSignature reads GET /admin/runlog/signature?destinationId=<id> for one destination ("" asks
// about the deploy-time destination). keys.ceremony (Owner) server-side; a non-Owner gets the engine's
// coarse 403, surfaced via parseJsonOrReason so the screen can show it rather than throw a bare transport
// error.
export async function getRunlogSignature(t: Transport, destinationId: string): Promise<RunlogSignatureView> {
  const q = destinationId ? `?destinationId=${encodeURIComponent(destinationId)}` : "";
  const r = await engineFetch(`${t.base}/admin/runlog/signature${q}`, { headers: t.headers(), credentials: "include" });
  return t.parseJsonOrReason<RunlogSignatureView>(r, "read the RUNLOG signature");
}

// resignRunlog calls POST /admin/runlog/resign {destinationId, digest}: the Owner confirms the exact SHA-384
// digest GET /admin/runlog/signature showed, so a RUNLOG that changed between the read and the decision is
// refused rather than re-signed blind. keys.ceremony (Owner) + step-up (STEPUP_SUBS), rate limited
// server-side. A refusal carries the engine's coarse, value-free reason.
export async function resignRunlog(t: Transport, input: { destinationId: string; digest: string }): Promise<RunlogResignResult> {
  const r = await t.gatedFetch("/admin/runlog/resign", {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify({ destinationId: input.destinationId, digest: input.digest }),
  });
  if (!r.ok) {
    const reason = await t.foldableReason(r);
    if (reason !== null) throw new Error(`re-sign the RUNLOG: ${reason}: ${r.status}`);
    return t.failResponse(r, "re-sign the RUNLOG");
  }
  return t.parseJson<RunlogResignResult>(r, "re-sign the RUNLOG");
}

// getRunlogFloor reads GET /admin/runlog/floor?destinationId=<id>: the destination's anti-rollback floor
// against the RUNLOG its bucket holds now, and whether a reset would help. keys.ceremony (Owner) server-side.
export async function getRunlogFloor(t: Transport, destinationId: string): Promise<RunlogFloorView> {
  const q = destinationId ? `?destinationId=${encodeURIComponent(destinationId)}` : "";
  const r = await engineFetch(`${t.base}/admin/runlog/floor${q}`, { headers: t.headers(), credentials: "include" });
  return t.parseJsonOrReason<RunlogFloorView>(r, "read the RUNLOG floor");
}

// resetRunlogFloor calls POST /admin/runlog/floor/reset {destinationId, expectFloor, digest}: the Owner
// confirms the exact floor and RUNLOG digest (or "absent") GET /admin/runlog/floor showed. It signs nothing;
// it only moves the floor down to the highest index the bucket's RUNLOG holds now.
export async function resetRunlogFloor(t: Transport, input: { destinationId: string; expectFloor: number | null; digest: string }): Promise<RunlogFloorResetResult> {
  const r = await t.gatedFetch("/admin/runlog/floor/reset", {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify({ destinationId: input.destinationId, expectFloor: input.expectFloor, digest: input.digest }),
  });
  if (!r.ok) {
    const reason = await t.foldableReason(r);
    if (reason !== null) throw new Error(`reset the RUNLOG floor: ${reason}: ${r.status}`);
    return t.failResponse(r, "reset the RUNLOG floor");
  }
  return t.parseJson<RunlogFloorResetResult>(r, "reset the RUNLOG floor");
}

// getRunlogChain reads GET /admin/runlog/chain?destinationId=<id>&downpipeId=<dp>: one downpipe's chain
// within a destination RUNLOG, and whether relinking it would clear a chain anomaly. keys.ceremony (Owner).
export async function getRunlogChain(t: Transport, input: { destinationId: string; downpipeId: string }): Promise<RunlogChainView> {
  const params = new URLSearchParams({ downpipeId: input.downpipeId });
  if (input.destinationId) params.set("destinationId", input.destinationId);
  const r = await engineFetch(`${t.base}/admin/runlog/chain?${params.toString()}`, { headers: t.headers(), credentials: "include" });
  return t.parseJsonOrReason<RunlogChainView>(r, "read the RUNLOG chain");
}

// relinkRunlog calls POST /admin/runlog/relink {destinationId, downpipeId, digest, anomalyKind}: the Owner
// confirms the exact RUNLOG digest and anomaly kind GET /admin/runlog/chain showed. It relinks that one
// chain, once, and never re-signs bytes that do not already verify.
export async function relinkRunlog(t: Transport, input: { destinationId: string; downpipeId: string; digest: string; anomalyKind: string }): Promise<RunlogRelinkResult> {
  const r = await t.gatedFetch("/admin/runlog/relink", {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify({ destinationId: input.destinationId, downpipeId: input.downpipeId, digest: input.digest, anomalyKind: input.anomalyKind }),
  });
  if (!r.ok) {
    const reason = await t.foldableReason(r);
    if (reason !== null) throw new Error(`relink the RUNLOG chain: ${reason}: ${r.status}`);
    return t.failResponse(r, "relink the RUNLOG chain");
  }
  return t.parseJson<RunlogRelinkResult>(r, "relink the RUNLOG chain");
}
