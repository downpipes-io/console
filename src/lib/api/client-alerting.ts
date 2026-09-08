// Canary-backup domain functions for the EngineClient. Free functions over the shared Transport.
//
// Alert delivery is via notify channels and rules (client-notifications.ts, rendered by
// screens/notifications/channels.ts); an operator sets a webhook destination on the Notifications screen.
//
// House style: Australian English, precise claims.

import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type { CanaryConfigPatch, CanaryView, MutationResult } from "./types.ts";

// getCanary reads the redaction-safe canary view: liveness, the last flight's per-aspect
// outcomes, the history ring, and the destination count (the console offers the destination
// picker only once more than one destination exists). Any authenticated role.
export async function getCanary(t: Transport): Promise<CanaryView> {
  const r = await engineFetch(`${t.base}/admin/canary`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<CanaryView>(r, "canary");
}

// setCanaryConfig toggles the canary, repoints its destination, or changes its cadence. Owner-
// gated server-side; a repoint to an unknown destination is refused. It resolves to a
// MutationResult so a future change-control deferral is handled the same as every other config.
export async function setCanaryConfig(t: Transport, patch: CanaryConfigPatch): Promise<MutationResult<CanaryView>> {
  const r = await engineFetch(`${t.base}/admin/canary/config`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify(patch) });
  return t.parseJsonOrPending<CanaryView>(r, "canary config");
}

// runCanary flies the canary now (operator+): the engine arms it due and seals, reads and
// restores it in the background, so a fresh result lands within moments. Poll getCanary to see it.
export async function runCanary(t: Transport): Promise<{ ok: boolean; flying: boolean }> {
  const r = await engineFetch(`${t.base}/admin/canary/run`, { method: "POST", headers: t.headers(), credentials: "include" });
  return t.parseJson<{ ok: boolean; flying: boolean }>(r, "canary run");
}
