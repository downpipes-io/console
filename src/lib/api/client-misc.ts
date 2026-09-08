// Cross-cutting reader/utility domain functions for the EngineClient that do not belong to a single named
// feature group: the consolidated setup state, the email-delivery test, the replication roll-up, the
// config-presence status, the preflight report, and the demo reset. Free functions over the shared
// Transport.

import { emailProbeOutcome, probeCallOutcome, recordProbeOutcome } from "../client-diag/ring.ts";
import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type {
  DestReplState,
  PreflightReport,
  SetupState,
  StatusReport,
} from "./types.ts";

// getSetupState reads the consolidated guided-first-run facts (presence and counts only). Any
// authenticated role; the shell derives the setup steps and nav gating from this one call.
export async function getSetupState(t: Transport): Promise<SetupState> {
  const r = await engineFetch(`${t.base}/admin/setup-state`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<SetupState>(r, "setup state");
}

// testEmailDelivery asks the engine to send a tiny test message to the CALLER's own verified email
// (the engine ignores any client-supplied address). The result is the engine's honest send outcome
// including the platform's error CODE when Email Service rejected it (E_SENDER_DOMAIN_NOT_AVAILABLE
// when the sending domain is not onboarded, E_SENDER_NOT_VERIFIED, ...), so Settings can name the
// exact dashboard step instead of leaving a silent no-op. Any authenticated role.
export async function testEmailDelivery(t: Transport): Promise<{ ok: boolean; reason?: string; code?: string }> {
  // The email probe's platform CODE is the one thing that names the dashboard step the customer must go
  // and complete, and it is already carried in the pack under the engine's own shape gate (4.2 preflight). This
  // row does NOT copy it: it records its PRESENCE as a class, so a refusal the platform NAMED (a sending domain
  // that was never onboarded, a sender that was never verified: a configuration the customer can fix) is told
  // apart from one it did not, and the operator-initiated tests gain the history the preflight probe cannot have
  // (the preflight runs once, at pack-build time, and says nothing about the fortnight before it).
  try {
    const r = await engineFetch(`${t.base}/admin/email/test`, { method: "POST", headers: t.headers(), credentials: "include" });
    const res = await t.parseJson<{ ok: boolean; reason?: string; code?: string }>(r, "email delivery test");
    recordProbeOutcome("email-test", emailProbeOutcome(res));
    return res;
  } catch (e) {
    recordProbeOutcome("email-test", probeCallOutcome(e));
    throw e;
  }
}

// listReplication reads the per-destination replication state for every fan-out downpipe: what each
// destination is PROVEN to hold and whether the last attempt to it succeeded. The honest source for
// "N of M copies" and the map's destination-down indicator (never an inference from staleness/canary).
export async function listReplication(t: Transport): Promise<{ byDownpipe: Record<string, Record<string, DestReplState>> }> {
  const r = await engineFetch(`${t.base}/admin/replication`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<{ byDownpipe: Record<string, Record<string, DestReplState>> }>(r, "replication");
}

// status reports config PRESENCE as booleans (is the secret set, is the binding bound),
// never a value and never a verdict. The onboarding configure step polls this to learn
// when the operator's out-of-band wrangler steps have taken effect. It sits behind the
// same auth gate as every non-health route, so a non-2xx here is an auth/transport fault.
export async function status(t: Transport): Promise<StatusReport> {
  const r = await engineFetch(`${t.base}/admin/status`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<StatusReport>(r, "status");
}

// preflight runs the engine's live, read-only entitlement and prerequisite verification
// (GET /admin/preflight; engine/src/admin/preflight.ts). Where the platform lets the engine
// probe (Durable Objects, the cron genuinely ticking, destination reachability, key parsing,
// the Zero Trust team domain, the seal DO, the licence tier) each item is VERIFIED or FAILED
// by observation; where it cannot probe (the Workers plan) the item says so honestly and
// names the deploy-time gate. Any authenticated role may read it. No-custody: every field is
// a name, a status enum, redaction-safe evidence prose or a remediation line; never a value
// and never a key. The readiness step renders it without re-deriving any verdict.
export async function preflight(t: Transport): Promise<PreflightReport> {
  const r = await engineFetch(`${t.base}/admin/preflight`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<PreflightReport>(r, "preflight");
}

// resetDemoFresh wipes a DEMO engine back to first-run (demo-only: the route 404s on a real engine).
// It authorises with the operator-entered ADMIN_TOKEN as a one-off Bearer header, the engine gates the
// reset on the ADMIN_TOKEN bearer DIRECTLY, so this works even though the browser's own session is a
// passkey/Access one; the token is sent once and never stored. credentials:"include" carries the
// Access/session cookie so the request passes the perimeter. Throws a clear message on 404 (not a demo
// engine) / 401 (wrong token).
export async function resetDemoFresh(t: Transport, adminToken: string): Promise<{ ok: boolean; reset?: boolean; cleared?: number | null }> {
  const r = await engineFetch(`${t.base}/admin/demo/reset`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    credentials: "include",
  });
  if (!r.ok) {
    const txt = (await r.text().catch(() => "")).slice(0, 200);
    if (r.status === 404) throw new Error("this engine is not in demo mode, so there is nothing to reset.");
    if (r.status === 401) throw new Error("that ADMIN_TOKEN was not accepted.");
    throw new Error(`reset failed (${r.status})${txt ? `: ${txt}` : ""}`);
  }
  // Route the 200 body through parseJson so a stale Access session serving its login HTML as a
  // 200 is named honestly (ACCESS_REDIRECT_MARKER) rather than surfacing an opaque SyntaxError.
  return t.parseJson<{ ok: boolean; reset?: boolean; cleared?: number | null }>(r, "reset");
}
