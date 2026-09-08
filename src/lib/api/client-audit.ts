// Audit-log + drill-evidence domain functions for the EngineClient. Free functions over the shared
// Transport.
//
// The audit log is the customer's own data in their own account; the vendor cannot read or alter it. Reads
// are allowed for any role (reviews care about read access to the trail). The ONLY write the console performs
// is recordAuditIntent (Owner-gated): an intent marker for an out-of-band step (the key ceremony, an
// Access-policy change), never a result or a value. verifyAuditChain demonstrates tamper-evidence (intact vs
// broken-at-N); exportAudit downloads the log WITH the chain head hash so an external verifier can confirm
// completeness.

import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type {
  AuditEvent,
  AuditFilters,
  AuditPage,
  ChainVerdict,
  DrillEvidenceEntry,
  DrillEvidenceKind,
} from "./types.ts";

export async function listAudit(t: Transport, filters: AuditFilters = {}): Promise<AuditPage> {
  const qs = new URLSearchParams();
  if (filters.actor) qs.set("actor", filters.actor);
  if (filters.action) qs.set("action", filters.action);
  if (filters.downpipe) qs.set("downpipe", filters.downpipe);
  if (filters.outcome) qs.set("outcome", filters.outcome);
  if (filters.from) qs.set("from", filters.from);
  if (filters.to) qs.set("to", filters.to);
  if (filters.before !== undefined) qs.set("before", String(filters.before));
  if (filters.limit !== undefined) qs.set("limit", String(filters.limit));
  const q = qs.toString();
  const suffix = q ? `?${q}` : "";
  const r = await engineFetch(`${t.base}/admin/audit${suffix}`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<AuditPage>(r, "audit");
}

export async function verifyAuditChain(t: Transport): Promise<ChainVerdict> {
  const r = await engineFetch(`${t.base}/admin/audit/verify`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<ChainVerdict>(r, "audit verify");
}

// exportAudit fetches the full (or filtered) log as a downloadable document, JSON by default or
// CSV, WITH the chain head hash included. Returns the raw text so the caller triggers a
// download; generated in-account, no custody concern (the customer's own data).
export async function exportAudit(t: Transport, format: "json" | "csv" = "json"): Promise<string> {
  const r = await engineFetch(`${t.base}/admin/audit/export?format=${format}`, { headers: t.headers(), credentials: "include" });
  // This route returns raw text (the downloadable log), not JSON, so it does not use parseJson; but
  // a non-2xx still routes through failResponse so an Access-redirect body is named honestly (C2-1).
  if (!r.ok) return t.failResponse(r, "audit export");
  return r.text();
}

// recordAuditIntent records that an out-of-band step happened (the key ceremony, an
// Access-policy change), as an INTENT event only, never a result or a value. Owner-gated
// server-side. This is the only audit WRITE the console makes.
export async function recordAuditIntent(t: Transport, action: "key-ceremony-intent" | "access-policy-change-intent"): Promise<AuditEvent> {
  const r = await engineFetch(`${t.base}/admin/audit/intent`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ action }) });
  return t.parseJson<AuditEvent>(r, "audit intent");
}

// A SEPARATE, non-hash-chained evidence log that records dated drill outcomes and
// operator-entered offline-rehearsal records (date, who, run id), so recoverability evidence exists even in
// the break-glass-only posture where the engine cannot self-test (IA screen 4, journey J5). It follows the
// same redaction discipline as the audit log but is NOT a tamper-evidence surface (it is evidence, not a
// chain).
export async function recordDrillEvidence(t: Transport, runId: string, kind: DrillEvidenceKind, note?: string): Promise<DrillEvidenceEntry> {
  const body: { runId: string; kind: DrillEvidenceKind; note?: string } = { runId, kind, ...(note !== undefined ? { note } : {}) };
  const r = await engineFetch(`${t.base}/admin/drill-evidence`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify(body) });
  return t.parseJson<DrillEvidenceEntry>(r, "drill evidence");
}

export async function listDrillEvidence(t: Transport): Promise<DrillEvidenceEntry[]> {
  const r = await engineFetch(`${t.base}/admin/drill-evidence`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<DrillEvidenceEntry[]>(r, "drill evidence");
}
