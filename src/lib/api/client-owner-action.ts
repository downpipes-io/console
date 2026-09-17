// High-blast-radius owner-action dual-control inbox domain functions for the EngineClient. Free functions
// over the shared Transport.
//
// The owner-action gate is the PARALLEL approval queue to the config-change gate: it holds the
// high-blast-radius OWNER operations (a destination repoint/add/remove/default, an IdP connection
// create/delete/enable, the discovery-token set, ...) the deferred mutation methods answer with a 202 when
// dual control is ON. A SECOND owner approves (or rejects) them here. No-custody: an owner action carries an
// id, a coarse kind, a redaction-safe summary, the proposer and a timestamp only; the engine STRIPS any live
// secret from the listing server-side, so no value or key ever reaches the console.

import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type { OwnerAction } from "./types.ts";

// listOwnerActions returns the PENDING and ARMED (approved-but-not-yet-executed) high-blast-radius owner
// actions awaiting a second owner, each with its redaction-safe summary, who proposed it and when, and its
// status. Gated on downpipe.read server-side (any authenticated config-reader may hit it); the DO applies
// the visibility rule (owners see all; a non-owner proposer sees only their OWN proposals). The engine has
// already stripped any live secret from the listed params, so the console renders the summary, never raw
// params, and a credential is never surfaced.
export async function listOwnerActions(t: Transport): Promise<OwnerAction[]> {
  const r = await engineFetch(`${t.base}/admin/owner-actions`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<OwnerAction[]>(r, "list owner actions");
}

// approveOwnerAction approves a pending owner action by id. The approver MUST be an OWNER (every gated op is
// owner-class) AND differ from the proposer (maker != checker on the stable subject axis); the engine
// re-resolves both server-side and refuses a self-approval (a 400/403 the inbox surfaces inline). For a
// DO-executed kind the action runs as part of the approve; for a router-executed kind it is ARMED and the
// proposer re-submits the original route with the one-shot token. The engine returns the updated record.
export async function approveOwnerAction(t: Transport, id: string): Promise<OwnerAction> {
  const r = await t.gatedFetch(`/admin/owner-actions/${encodeURIComponent(id)}/approve`, { method: "POST", headers: t.headers(), credentials: "include" });
  return t.parseJsonOrReason<OwnerAction>(r, "approve owner action");
}

// rejectOwnerAction rejects a pending OR armed owner action by id (it is not carried out). It does NOT
// require maker != checker (the proposer may withdraw their own action, and any owner may veto an armed one
// before it executes), but the engine still gates it on OWNER and refuses to overwrite a terminal state. The
// engine returns the updated record.
export async function rejectOwnerAction(t: Transport, id: string): Promise<OwnerAction> {
  const r = await engineFetch(`${t.base}/admin/owner-actions/${encodeURIComponent(id)}/reject`, { method: "POST", headers: t.headers(), credentials: "include" });
  return t.parseJsonOrReason<OwnerAction>(r, "reject owner action");
}
