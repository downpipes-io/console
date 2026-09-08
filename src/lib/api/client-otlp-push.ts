// Outbound OTLP/HTTP metrics push domain functions for the EngineClient (monitoring integrations).
// Free functions over the shared Transport, mirroring client-push.ts (the SIEM
// audit-log push sibling) exactly.
//
// setOtlpPush is the one HIGH-BLAST-RADIUS owner mutation in this family (it opens or replaces a
// vendor-readable egress carrying the backup-health metric snapshot): it follows setPush's pattern,
// NOT the support-credential-mint pattern, so it routes through t.gatedFetch (a stale ambient
// session's 401 { stepUpRequired } triggers the step-up ceremony and a single retry) and resolves
// through t.parseJsonOrOwnerAction so a 202 (the dual-control gate queuing the change for a second
// owner) is never read as a false "saved". getOtlpPush uses plain fetch + t.parseJson (a
// redaction-safe read any authenticated role may make). clearOtlpPush ALSO routes through
// t.gatedFetch (the engine holds /admin/otlp-push/delete behind step-up, the same fresh re-auth
// every destination-mutating route requires), but is NOT dual-control (closing an egress is the safe
// direction), so it resolves through the plain t.parseJson. There is no test-send route (unlike the
// SIEM push): the engine exposes only GET/POST /otlp-push and POST /otlp-push/delete.

import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type { ChangeRef } from "../change-ref.ts";
import type { OtlpPushDestinationInput, OtlpPushDestinationView, OwnerActionResult } from "./types.ts";

// getOtlpPush reads the redaction-safe OTLP push-destination view: presence, the endpoint/header
// NAME (never the secret), enabled, who set it and when, and the bounded delivery trail. Any
// authenticated role (same redaction-safe class as getPush/getDestination/getSupport).
export async function getOtlpPush(t: Transport): Promise<OtlpPushDestinationView> {
  const r = await engineFetch(`${t.base}/admin/otlp-push`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<OtlpPushDestinationView>(r, "OTLP push destination");
}

// setOtlpPush configures, replaces, or re-enables/disables the OTLP push destination. A
// high-blast-radius owner mutation (it opens a vendor-readable egress), so it is routed through
// gatedFetch (a step-up 401 runs the re-auth ceremony and retries once) and resolved through
// parseJsonOrOwnerAction so the owner-action dual-control gate's 202 (queued for a second owner) is
// surfaced honestly rather than as a false "saved". The OPTIONAL change reference rides as
// X-Downpipes-Change when change management requires one.
export async function setOtlpPush(t: Transport, input: OtlpPushDestinationInput, change?: ChangeRef): Promise<OwnerActionResult<OtlpPushDestinationView>> {
  const r = await t.gatedFetch("/admin/otlp-push", {
    method: "POST",
    headers: { ...t.headers(change) },
    credentials: "include",
    body: JSON.stringify(input),
  });
  return t.parseJsonOrOwnerAction<OtlpPushDestinationView>(r, "set OTLP push destination");
}

// clearOtlpPush removes the OTLP push destination entirely (config, sealed secret and trail). No
// dual control: closing an egress is the safe direction. Owner-exclusive server-side. The OPTIONAL change
// reference rides as X-Downpipes-Change when change management requires one, mirroring clearPush exactly:
// the Clear control collects one and used to discard it, and /otlp-push/delete does not yet reach the
// engine's enforceChangeControl chokepoint, so nothing records it there yet either.
export async function clearOtlpPush(t: Transport, change?: ChangeRef): Promise<{ ok: boolean }> {
  const r = await t.gatedFetch("/admin/otlp-push/delete", { method: "POST", headers: t.headers(change), credentials: "include" });
  return t.parseJson<{ ok: boolean }>(r, "clear OTLP push destination");
}
