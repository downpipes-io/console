// Secure support diagnostics domain functions for the EngineClient. Free functions over the shared
// Transport.
//
// The vendor never holds a Cloudflare token and never gets dashboard access; support evidence moves through
// these routes instead. getSupport reads the customer-facing supportability view; mintSupportCredential /
// revokeSupportCredential manage the platform-issued ingest credentials (Owner-only SERVER-SIDE; the console
// mirrors the gate as UX only); getSupportBundle downloads the signed (and vendor-sealed when
// VENDOR_SUPPORT_PUBLIC is configured) support bundle the customer attaches to a ticket themselves.
// No-custody: the one secret in this family is the minted credential secret, which the ENGINE returns exactly
// once in the mint response and stores only as a SHA-384; the console displays it once and never persists it.

import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type { ChangeRef } from "../change-ref.ts";
import type { IngestScope, MintedSupportCredential, OwnerActionResult, SupportStatus } from "./types.ts";
import type { ClientDiagnosticsPayload } from "../client-diag/vocab.ts";

// getSupport returns the supportability view: whether a vendor sealing key is configured and
// the redacted grant state per scope (clientId, expiry, grantedBy, the recorded pulls; never a
// secret or its hash). Any authenticated role may read it.
export async function getSupport(t: Transport): Promise<SupportStatus> {
  const r = await engineFetch(`${t.base}/admin/support`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<SupportStatus>(r, "support");
}

// mintSupportCredential mints (or replaces; one active per scope) the ingest credential for a
// scope. OWNER-ONLY server-side. The response carries the SECRET EXACTLY ONCE (plus the single
// bearer form "<clientId>.<secret>" every collector form accepts); only its SHA-384 persists in
// the engine, so the caller must show it immediately and never again. ttlSeconds is optional;
// the engine clamps it to the per-scope cap (7 days for diagnostics, 365 for the audit feed).
// exactOptionalPropertyTypes: ttlSeconds is added to the body only when supplied.
//
// support-credential-mint is an OWNER-ACTION the dual-control gate defers (engine owner-action.ts): when the
// org dual-control toggle is ON the engine QUEUES the mint for a SECOND owner and answers HTTP 202 with the
// OwnerActionQueued body, GENERATING NO SECRET (it is router-executed on approval). Read through
// parseJsonOrOwnerAction (every high-blast-radius owner mutation's decoder, the destination/IdP sibling) so
// that 202 resolves to an OwnerActionResult { status: "queued" } the screen surfaces as "queued for a second
// owner", never a { status: "result" } whose value is an all-undefined credential the reveal would frame as
// minted.
export async function mintSupportCredential(t: Transport, scope: IngestScope, ttlSeconds?: number, change?: ChangeRef): Promise<OwnerActionResult<MintedSupportCredential>> {
  const body: { scope: IngestScope; ttlSeconds?: number } = { scope, ...(ttlSeconds !== undefined ? { ttlSeconds } : {}) };
  // The OPTIONAL change reference (change management) rides as the X-Downpipes-Change header when supplied
  // (minting a support credential opens a vendor-readable pull surface, a change-controlled action).
  const r = await t.gatedFetch("/admin/support/credentials", { method: "POST", headers: t.headers(change), credentials: "include", body: JSON.stringify(body) }, { adminOp: "credential-mint" });
  return t.parseJsonOrOwnerAction<MintedSupportCredential>(r, "mint support credential");
}

// revokeSupportCredential revokes the active credential for a scope (POST-to-delete, consistent
// with the other deletes). OWNER-ONLY server-side; revocation is immediate.
export async function revokeSupportCredential(t: Transport, scope: IngestScope): Promise<{ ok: boolean; scope: IngestScope }> {
  const r = await engineFetch(`${t.base}/admin/support/credentials/delete`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ scope }) }, { adminOp: "credential-delete" });
  return t.parseJson<{ ok: boolean; scope: IngestScope }>(r, "revoke support credential");
}

// metricsEndpointUrl is the absolute GET url for the Prometheus text-exposition scrape surface: the
// engine origin + /metrics (a NON-/admin route, like /support/*, reached by the minted
// "metrics"-scope bearer alone, no console session), mirroring client-idp.ts's samlMetadataUrl. Shown
// alongside the minted credential so an operator can paste both straight into a scrape config.
export function metricsEndpointUrl(t: Transport): string {
  return `${t.base}/metrics`;
}

// getSupportBundle fetches the support bundle as raw JSON TEXT so the caller can save it as a
// file verbatim (the blob-download idiom exportAudit uses): vendor-sealed when the vendor key is
// configured, signed otherwise. The bundle is generated in-account and redaction-safe by
// construction (presence booleans, the preflight report, coarse run outcomes, licence tier;
// never a key, a secret value or customer data). A non-2xx still routes through failResponse so
// an Access-redirect body (C2-1) is named honestly rather than read as a corrupt download.
//
// clientDiagnostics (optional) is the console's own bounded ring of COARSE, CLOSED-CLASS error records
// (lib/client-diag/), handed to the engine so it can fold them into the pack as a REQUEST-SCOPED section
// INSIDE the seal and the signature (Wave C, invariant I1). Passing it turns the download into a POST; the
// engine re-validates every field by set membership, drops anything else, and discards the payload once
// that one bundle is built (no persistence, no roster entry, no staging). Omitting it keeps the plain GET,
// which the engine answers with NO clientDiagnostics section, so the vendor bearer-pull and every scheduled
// build structurally cannot carry one. Nothing here fires in the background: the only caller is the
// customer's deliberate Generate action on the support screen.
export async function getSupportBundle(t: Transport, clientDiagnostics?: ClientDiagnosticsPayload): Promise<string> {
  const init: RequestInit =
    clientDiagnostics === undefined
      ? { headers: t.headers(), credentials: "include" }
      : { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ clientDiagnostics }) };
  const r = await engineFetch(`${t.base}/admin/support/bundle`, init);
  if (!r.ok) return t.failResponse(r, "support bundle");
  return r.text();
}
