// Archive-destination domain functions for the EngineClient. Free functions over the shared Transport.

import { destProbeOutcome, probeCallOutcome, recordProbeOutcome, type DestVerifyResult } from "../client-diag/ring.ts";
import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type { ChangeRef } from "../change-ref.ts";
import type {
  DestinationInput,
  DestinationList,
  DestinationStatus,
  EstateSizeReport,
  OwnerActionResult,
} from "./types.ts";

// getDestination reads the redaction-safe view of WHERE BACKUPS GO: the console-set record when
// present, else the deploy-time env presence. Never a credential. Any authenticated role.
export async function getDestination(t: Transport): Promise<DestinationStatus> {
  const r = await engineFetch(`${t.base}/admin/destination`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<DestinationStatus>(r, "destination");
}

// setDestination stores (config) or clears (null) the console-set archive destination. The engine
// verifies a submitted destination LIVE before anything is stored (reachability + read auth + a
// real write probe; an unreachable or unauthorised bucket is refused with the honest reason and
// never stored), stores it in the scheduler DO (runtime, no CLI, no redeploy), audits who changed
// where backups go, and returns the redaction-safe status. Owner-exclusive server-side. The engine
// refusal carries a plain { error } reason worth surfacing verbatim, so fold it into the throw. It is a
// high-blast-radius owner mutation (a destination repoint exfiltrates all future backups), so when the
// owner-action dual-control gate is ON the engine answers HTTP 202 and queues the action for a SECOND owner
// instead of applying it: this resolves to a discriminated OwnerActionResult ({ status:"result", value } on
// the normal/gate-off path; { status:"queued", queued } when queued) so the caller surfaces "queued for a
// second owner" rather than a false "saved". The gate-off path (the default) is byte-unchanged.
export async function setDestination(t: Transport, config: DestinationInput | null, change?: ChangeRef): Promise<OwnerActionResult<DestinationStatus>> {
  // A destination repoint is a SENSITIVE action (it changes where all future backups land), so it is
  // routed through gatedFetch: a stale ambient session that the engine answers with a 401
  // { stepUpRequired } triggers the step-up re-auth ceremony and a single retry. The 202 owner-action
  // (dual-control) and 200 applied paths are unchanged (gatedFetch only acts on a step-up 401). The
  // OPTIONAL change reference (change management) rides as the X-Downpipes-Change header when supplied.
  const r = await t.gatedFetch("/admin/destination", {
    method: "POST",
    headers: { ...t.headers(change) },
    credentials: "include",
    body: JSON.stringify({ config }),
  });
  return t.parseJsonOrOwnerAction<DestinationStatus>(r, "set destination");
}

// verifyDestination re-probes a SPECIFIC destination by id (each holds its own credentials), so a
// card verifies ITS bucket, not always the default. Absent id = the default (the legacy singular
// path). Returns the honest live result. Owner-exclusive server-side.
export async function verifyDestination(t: Transport, id?: string): Promise<DestVerifyResult> {
  const q = id ? `?id=${encodeURIComponent(id)}` : "";
  // The verify is recorded HERE, at the one seam every verify passes through, for the same reason the
  // engine-call kind is recorded in engineFetch: a per-screen emit is one a screen can forget, and a destination
  // verify fires from two of them. The result is the richest per-destination diagnostic the product computes and
  // it is rendered once and stored nowhere, so "verify fails every morning and works on retry" has never been
  // answerable. Neither the bucket, the endpoint nor the vendor's reason text rides: destProbeOutcome reads the
  // reason ONLY to select a closed member and returns the member.
  try {
    const r = await engineFetch(`${t.base}/admin/destination/verify${q}`, { method: "POST", headers: t.headers(), credentials: "include" });
    const res = await t.parseJson<DestVerifyResult>(r, "verify destination");
    recordProbeOutcome("dest-verify", destProbeOutcome(res));
    return res;
  } catch (e) {
    // The verify CALL failed, so the destination was never probed at all: a wholly different ticket from a probe
    // that ran and found the bucket unreachable, and until now both were one red toast.
    recordProbeOutcome("dest-verify", probeCallOutcome(e));
    throw e;
  }
}

// listDestinations reads every console-set destination plus which id is the default. Any
// authenticated role (same redaction-safe class as getDestination).
export async function listDestinations(t: Transport): Promise<DestinationList> {
  const r = await engineFetch(`${t.base}/admin/destinations`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<DestinationList>(r, "destinations");
}

// estateSize reads the ANALYTICS-FIRST onboarding size estimate: the engine sizes each configured
// source from Cloudflare storage analytics (no value reads) so the cost screen can show a real figure
// before the first backup runs. Read-only; best-effort server-side (available:false when it cannot size).
export async function estateSize(t: Transport): Promise<EstateSizeReport> {
  const r = await engineFetch(`${t.base}/admin/cost/estate-size`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<EstateSizeReport>(r, "estate size");
}

// addDestination ADDS a new destination (no id) or EDITS one (id given). Like setDestination the
// engine verifies the submitted credentials LIVE before storing, so an unwritable bucket is
// refused with the honest reason. Owner-exclusive server-side. Returns the updated list, OR the
// owner-action queued result when dual control is ON (a new/edited destination is high-blast: it
// repoints where backups land). The gate-off path returns { status:"result", value } unchanged.
export async function addDestination(t: Transport, config: DestinationInput, label: string, id?: string, change?: ChangeRef): Promise<OwnerActionResult<DestinationList>> {
  // Sensitive owner mutation (a new/edited destination repoints where backups land): routed through
  // gatedFetch so an engine 401 { stepUpRequired } runs the step-up ceremony and retries once. The
  // OPTIONAL change reference (change management) rides as the X-Downpipes-Change header when supplied.
  const r = await t.gatedFetch("/admin/destinations", {
    method: "POST",
    headers: { ...t.headers(change) },
    credentials: "include",
    body: JSON.stringify({ ...(id ? { id } : {}), label, config }),
  });
  return t.parseJsonOrOwnerAction<DestinationList>(r, "add destination");
}

// removeDestination deletes a destination by id; setDefaultDestination makes one the default.
// Both owner-exclusive server-side. Each returns the updated list, OR the owner-action queued result
// when dual control is ON. removeDestination is the MOST dangerous of the two under a false success:
// a removed destination may still be live and receiving backups until a second owner approves, so the
// queued result MUST be surfaced honestly (never a "removed" toast). The gate-off path is unchanged.
// `force` overrides the engine's orphan guard: by default the engine REFUSES to remove a
// destination that is the only proven copy of backed-up runs (their bytes would become unaddressable),
// returning that reason. force:true tells the engine to drop those copies deliberately, so a permanently
// stuck orphan guard is clearable from the console. It is OMITTED from the body unless true, so the
// non-force wire is byte-unchanged. It is the most destructive console action, so the UI gates it behind
// a type-to-confirm; the engine still enforces dual control on top.
export async function removeDestination(t: Transport, id: string, change?: ChangeRef, force?: boolean): Promise<OwnerActionResult<DestinationList>> {
  // Sensitive owner mutation: routed through gatedFetch so an engine 401 { stepUpRequired } runs the
  // step-up ceremony and retries once. The OPTIONAL change reference rides as X-Downpipes-Change.
  const r = await t.gatedFetch("/admin/destinations/remove", {
    method: "POST",
    headers: { ...t.headers(change) },
    credentials: "include",
    body: JSON.stringify({ id, ...(force === true ? { force: true } : {}) }),
  });
  return t.parseJsonOrOwnerAction<DestinationList>(r, "remove destination");
}

export async function setDefaultDestination(t: Transport, id: string, change?: ChangeRef): Promise<OwnerActionResult<DestinationList>> {
  // Sensitive owner mutation: routed through gatedFetch so an engine 401 { stepUpRequired } runs the
  // step-up ceremony and retries once. The OPTIONAL change reference rides as X-Downpipes-Change.
  const r = await t.gatedFetch("/admin/destinations/default", {
    method: "POST",
    headers: { ...t.headers(change) },
    credentials: "include",
    body: JSON.stringify({ id }),
  });
  return t.parseJsonOrOwnerAction<DestinationList>(r, "set default destination");
}
