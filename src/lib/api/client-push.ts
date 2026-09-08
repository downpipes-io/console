// Outbound audit-log push (SIEM) domain functions for the EngineClient. Free functions over the shared
// Transport, the same split as every other client-<domain>.ts.
//
// setPush is the one HIGH-BLAST-RADIUS owner mutation in this family (it opens or replaces a
// vendor-readable egress carrying identity-bearing audit data): it follows the dest-put pattern
// (client-destinations.ts setDestination), NOT the support-credential-mint pattern, so it routes through
// t.gatedFetch (a stale ambient session's 401 { stepUpRequired } triggers the step-up ceremony and a single
// retry) and resolves through t.parseJsonOrOwnerAction so a 202 (the dual-control gate queuing the change
// for a second owner) is never read as a false "saved". getPush uses plain fetch + t.parseJson (a
// redaction-safe read any authenticated role may make). clearPush and testPush ALSO route through
// t.gatedFetch: the engine holds /admin/push/delete and /admin/push/test behind step-up (STEPUP_SUBS, the
// same fresh-re-auth every destination-mutating route requires, because clearing the egress cuts the audit
// feed to the SOC and a test send dials out carrying the stored secret), so a stale ambient session must get
// the step-up ceremony and a retry, not a raw 401. Neither is dual-control, so they resolve through the
// plain t.parseJson (closing an egress is the safe direction; a test send changes no configuration at all).

import { probeCallOutcome, pushProbeOutcome, recordProbeOutcome } from "../client-diag/ring.ts";
import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type { ChangeRef } from "../change-ref.ts";
import type { OwnerActionResult, PushDestinationInput, PushDestinationView, PushTestResult } from "./types.ts";

// getPush reads the redaction-safe push-destination view: presence, the endpoint/format/header NAME
// (never the secret), enabled, who set it and when, the cursor (lastPushedSeq/headSeq, so the console can
// show lag = headSeq - lastPushedSeq) and the bounded delivery trail. Any authenticated role (same
// redaction-safe class as getDestination/getSupport).
export async function getPush(t: Transport): Promise<PushDestinationView> {
  const r = await engineFetch(`${t.base}/admin/push`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<PushDestinationView>(r, "push destination");
}

// setPush configures, replaces, or re-enables/disables the push destination. A high-blast-radius owner
// mutation (it opens a vendor-readable egress carrying operator identity), so it is routed through
// gatedFetch (a step-up 401 runs the re-auth ceremony and retries once) and resolved through
// parseJsonOrOwnerAction so the owner-action dual-control gate's 202 (queued for a second owner) is
// surfaced honestly rather than as a false "saved". The OPTIONAL change reference rides as
// X-Downpipes-Change when change management requires one.
export async function setPush(t: Transport, input: PushDestinationInput, change?: ChangeRef): Promise<OwnerActionResult<PushDestinationView>> {
  const r = await t.gatedFetch("/admin/push", {
    method: "POST",
    headers: { ...t.headers(change) },
    credentials: "include",
    body: JSON.stringify(input),
  });
  return t.parseJsonOrOwnerAction<PushDestinationView>(r, "set push destination");
}

// clearPush removes the push destination entirely (config, sealed secret and cursor). No dual control:
// closing an egress is the safe direction. Owner-exclusive server-side. The OPTIONAL change reference rides
// as X-Downpipes-Change when change management requires one.
//
// WHY THE PARAMETER EXISTS, and what it does not yet buy. The Clear control has always run requireChange
// (screens/settings/push.ts), so under Require Change Number the operator is asked for a change number and
// answers it. The reference then went nowhere: this function took no change argument, so it called
// t.headers() with none and the write reached the engine carrying no reference at all. That is worse than
// never asking, because the prompt is what the operator remembers supplying. The console now carries it.
// THE ENGINE HALF IS OPEN: /push/delete is owner-exclusive but is not an owner action, so it never reaches
// gatedOwnerAction and therefore never reaches enforceChangeControl, which is the only thing that writes the
// change-recorded audit event. Until that route enforces, the reference arrives on the caller and nothing
// records it, so a cleared push destination still has no CR against it in the change-requests report.
export async function clearPush(t: Transport, change?: ChangeRef): Promise<{ ok: boolean }> {
  const r = await t.gatedFetch("/admin/push/delete", { method: "POST", headers: t.headers(change), credentials: "include" });
  return t.parseJson<{ ok: boolean }>(r, "clear push destination");
}

// testPush sends ONE synthetic audit-shaped event to the CONFIGURED endpoint through the engine's
// egress-secure sender and reports the honest outcome (a real SIEM HTTP status, a timeout, an
// egress-blocked reason). Does not advance the cursor and is not itself recorded in the delivery trail's
// cursor accounting.
export async function testPush(t: Transport): Promise<PushTestResult> {
  // The httpStatus is returned as a NUMBER, so the 4xx/5xx split needs no text at all, and the egress-guard
  // refusal (the endpoint was never called: an allowlist decision, not a vendor fault) is the one class an
  // operator most often misreads as their SIEM being down. The endpoint URL and the vendor's body never ride.
  try {
    const r = await t.gatedFetch("/admin/push/test", { method: "POST", headers: t.headers(), credentials: "include" });
    const res = await t.parseJson<PushTestResult>(r, "test push destination");
    recordProbeOutcome("push-test", pushProbeOutcome(res));
    return res;
  } catch (e) {
    recordProbeOutcome("push-test", probeCallOutcome(e));
    throw e;
  }
}
