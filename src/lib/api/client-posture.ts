// Security-centre posture + coverage/gap-detection domain functions for the EngineClient (split from
// client.ts per findings console-src-010-01 / console-sys-arch-01 / console-sys-struct-03). Free functions
// over the shared Transport; request URL/method/body/headers and parse/throw logic moved VERBATIM.
//
// The posture report is a pure computation over the account's own observable state (no vendor read): a 0..100
// score and severity-ranked checks, each mapped to a named control with a remediation. GET is gated by
// posture.read (any authenticated role). The risk-accept / unaccept writes are gated by posture.riskaccept
// (Owner) SERVER-SIDE; the console mirrors the gate with can(role, "posture.riskaccept"). A risk-accept
// stores a reason (redaction-safe free text, never a secret); the console escapes it on render.

import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type {
  CoverageInventoryStored,
  CoverageReport,
  MutationResult,
  PostureOverrideKind,
  PostureReport,
  ResourceInventory,
} from "./types.ts";

// getPosture returns the computed PostureReport (score + checks). posture.read.
export async function getPosture(t: Transport): Promise<PostureReport> {
  const r = await engineFetch(`${t.base}/admin/posture`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<PostureReport>(r, "posture");
}

// acceptPostureRisk records an owner OVERRIDE for a check: a risk acceptance (the default, so older
// callers are unchanged), an attested pass, a compensating control, or a not-applicable determination.
// Every kind requires a reason (the engine records acceptedBy/acceptedAt from the verified caller). A
// customer-graded check counts as pass for the score (N/A is excluded entirely) but is listed
// distinctly and clearly attributed in the reports. posture.riskaccept (Owner).
export async function acceptPostureRisk(t: Transport, checkId: string, reason: string, kind: PostureOverrideKind = "risk-accepted"): Promise<MutationResult<{ ok: boolean }>> {
  const r = await t.gatedFetch("/admin/posture/accept", { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ checkId, reason, kind }) }, { adminOp: "posture-accept" });
  return t.parseJsonOrPending<{ ok: boolean }>(r, "accept posture risk");
}

// unacceptPostureRisk withdraws a previously recorded risk acceptance for a check, so it is graded
// on its observed state again. posture.riskaccept.
export async function unacceptPostureRisk(t: Transport, checkId: string): Promise<MutationResult<{ ok: boolean }>> {
  const r = await t.gatedFetch("/admin/posture/unaccept", { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ checkId }) }, { adminOp: "posture-unaccept" });
  return t.parseJsonOrPending<{ ok: boolean }>(r, "unaccept posture risk");
}

// The coverage view is a pure computation over the customer's own observable state: the reference resource
// inventory (the operator's redaction-safe checklist of what exists, supplied out of band or by a read-only
// discovery step) cross-referenced against the configured downpipes and their run/restorability state. GET is
// gated by posture.read (any authenticated role), like getPosture. The HONEST-UNKNOWN discriminator is
// hasInventory: with NO inventory stored the engine returns hasInventory:false with an empty resources list
// and a zeroed rollup, and the report makes NO coverage claim (the console reads this as "unknown", never
// "fully covered"). No-custody: a coverage row carries a resource type, native id, label, status and the
// covering downpipe id only; never a binding, value or key. The inventory is reference data the engine stores
// distinct from any binding and never consults on a seal/restore path, so it can never grant data access.

// getCoverage returns the computed CoverageReport (per-resource protected/unprotected/untested +
// rollup, or the honest-unknown shape when no inventory is stored). posture.read.
export async function getCoverage(t: Transport): Promise<CoverageReport> {
  const r = await engineFetch(`${t.base}/admin/coverage`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<CoverageReport>(r, "coverage");
}

// setCoverageInventory STORES the account's reference resource inventory ({kv,r2,d1,secrets} groups of
// { id, name? }) so the gap view has something to compare downpipes against. It is REFERENCE DATA ONLY:
// the engine keeps it distinct from every binding and never consults it on a seal or restore path, so it
// can never grant data access. Gated on access.policy SERVER-SIDE (the engine re-resolves the caller's
// authority); the console mirrors that gate as UX only. The engine validates + bounds the body and
// answers a malformed/oversized inventory with HTTP 400 { error: <reason> }, which is NOT a bare
// auth/transport fault, so the reason is folded into the thrown message (the "<verb>: <reason>: <status>"
// form the classifier parses) so the populate UI can surface the engine's own explanation. A success
// returns the per-type stored counts; no value or key transits (an inventory carries only ids/labels).
//
// 202-DECODE (this pass): storing the inventory is the GATED config mutation `coverage-inventory` (engine
// scheduler-do-routing-signals.ts, the POST /coverage/inventory case, which dispatches through
// gatedConfigMutation), so with the change-control gate armed the engine answers HTTP 202 +
// { queued:true, id, status, contentHash } and stores NOTHING. This used to read through plain parseJson,
// which throws only on a NON-2xx, so the queued body was cast to a CoverageInventoryStored: the security
// centre's populate action then destructured `result.counts`, which is absent on a queued body, and the
// save threw a raw TypeError instead of reporting that the inventory was queued for approval. Reading
// through parseJsonOrPending gives the caller a discriminated { status:"pending" } and, on the gate-off
// path, the same { status:"applied", value } counts as before.
//
// The hand-rolled reason fold above is REPLACED by parseJsonOrPending's own, which is the same fold SCOPED
// to the statuses that carry a plain { error } (a 400/422 validation refusal). The old fold ran on every
// non-2xx, so a 403 threw "<reason>: 403" with no FORBIDDEN_CLASS_MARKER and classifyError could not read
// the refusal class; the scoped fold leaves 401/403/429/5xx to failResponse's own markers, matching every
// sibling mutation in this client.
export async function setCoverageInventory(t: Transport, inventory: ResourceInventory): Promise<MutationResult<CoverageInventoryStored>> {
  const r = await engineFetch(`${t.base}/admin/coverage/inventory`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify(inventory) });
  return t.parseJsonOrPending<CoverageInventoryStored>(r, "set coverage inventory");
}
