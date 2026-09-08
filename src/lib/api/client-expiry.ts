// Credential & key expiry-tracker domain functions for the EngineClient. Free functions over the shared
// Transport.
//
// The expiry tracker is the customer's own list of dated items (a destination access key, a licence, a
// certificate) in their own account; the labels are redaction-safe (never the secret itself). GET returns
// the computed statuses (days-remaining + state); the writes (POST item, delete) are gated by the
// expiry.config capability SERVER-SIDE (mirrored with can(role, "expiry.config")). No value or key transits:
// an item carries a label, kind, expiry date and an optional note only.

import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type { ExpiryItem, ExpiryItemInput, ExpiryStatus, MutationResult } from "./types.ts";

// listExpiry returns the computed ExpiryStatus[] (label + days-remaining + state). Any
// authenticated role may read it.
export async function listExpiry(t: Transport): Promise<ExpiryStatus[]> {
  const r = await engineFetch(`${t.base}/admin/expiry`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<ExpiryStatus[]>(r, "list expiry");
}

// upsertExpiryItem creates or updates a tracked item. The CALLER supplies the id (submitItem mints a fresh
// UUID for a create and reuses the existing id for an edit); the engine VALIDATES it and keys the upsert by
// it, it never assigns one. It returns the stored ExpiryItem (NOT the computed status; the next listExpiry
// recomputes that). Gated by expiry.config; a malformed item is a 400 { error }.
export async function upsertExpiryItem(t: Transport, item: ExpiryItemInput): Promise<MutationResult<ExpiryItem>> {
  const r = await engineFetch(`${t.base}/admin/expiry`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify(item) }, { adminOp: "expiry-item-set" });
  return t.parseJsonOrPending<ExpiryItem>(r, "save expiry item");
}

// deleteExpiryItem removes a tracked item by id. Change-control gated server-side (expiry-item-delete), so a
// queued 202 removes nothing: read through parseJsonOrPending so the caller surfaces the pending state
// honestly rather than reading the 202 as a false "removed" (the deleteNotifyChannel/deleteNotifyRule sibling).
export async function deleteExpiryItem(t: Transport, id: string): Promise<MutationResult<{ deleted: boolean }>> {
  const r = await engineFetch(`${t.base}/admin/expiry/delete`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ id }) }, { adminOp: "expiry-item-delete" });
  return t.parseJsonOrPending<{ deleted: boolean }>(r, "delete expiry item");
}

// cleanupAttestExpiry records the operator's ATTESTATION that they deleted a spent ephemeral credential
// (e.g. a one-shot Cloudflare attach token) in Cloudflare; the engine flips the item's cleanupState to
// "attested-deleted". It is an attestation, NOT a verified deletion (the engine holds no Cloudflare API
// token and cannot check Cloudflare-side state). Gated by expiry.config.
export async function cleanupAttestExpiry(t: Transport, id: string): Promise<{ ok: boolean; updated: boolean }> {
  const r = await engineFetch(`${t.base}/admin/expiry/cleanup-attest`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ id }) });
  return t.parseJson<{ ok: boolean; updated: boolean }>(r, "attest credential cleanup");
}
