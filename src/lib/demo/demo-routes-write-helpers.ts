// The write handlers' small shared helpers, split out of demo-routes-write.ts because that
// file reached 1002 lines against a 1000-line budget. The seam is the one the file already declared: these
// five are helpers the handlers call, not handlers themselves, and none of them touches a route.
//
// House rules: Australian English, precise claims (tamper-evident, post-quantum hybrid).

import type { DownpipeState, RunHistoryEntry } from "../api/types.ts";
import { ORG_OWNER_EMAIL } from "./demo-seed.ts";
import { world } from "./demo-world.ts";

// A stable, obviously-fake stand-in for a SHA-384, used only by the demo receipt. Deterministic so the same
// record shows the same digest across a session (a receipt whose hashes changed on every render would
// misrepresent what a receipt is), and prefixed so nobody mistakes it for a real digest: the demo has no
// bytes to hash and inventing a realistic-looking hex string would put a false attestation in front of
// customers on the tour.
export function demoDigest(of: string): string {
  let h = 0;
  for (let i = 0; i < of.length; i++) h = (Math.imul(h, 31) + of.charCodeAt(i)) | 0;
  return `sha384:demo-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

// selectorsOf extracts ONLY the plan-hash-relevant selector fields from a restore request, so the demo's
// plan hash matches the screen's byte-for-byte (restorePlanHash hashes the decision-relevant subset, never
// the blast-radius cues or a secret token). Each field is attached only when present (exactOptionalPropertyTypes).
// The param is the structural selector subset SHARED by RestoreRequest and RestoreApprovalRequest (the only
// difference between the two cfConfig shapes is a token, which is never hashed and is dropped here), so both
// call sites pass cleanly.
export interface RestoreSelectors {
  target?: { binding?: string; namespaceId?: string; bucketName?: string };
  include?: string[];
  exclude?: string[];
  maxRecords?: number;
  recordName?: string;
  cfConfig?: { accountId: string; zoneId?: string };
}
export function selectorsOf(req: { target?: RestoreSelectors["target"]; include?: string[]; exclude?: string[]; maxRecords?: number; recordName?: string; cfConfig?: { accountId: string; zoneId?: string } }): RestoreSelectors {
  return {
    ...(req.target ? { target: req.target } : {}),
    ...(req.include ? { include: req.include } : {}),
    ...(req.exclude ? { exclude: req.exclude } : {}),
    ...(req.maxRecords !== undefined ? { maxRecords: req.maxRecords } : {}),
    ...(req.recordName !== undefined ? { recordName: req.recordName } : {}),
    ...(req.cfConfig ? { cfConfig: { accountId: req.cfConfig.accountId, ...(req.cfConfig.zoneId !== undefined ? { zoneId: req.cfConfig.zoneId } : {}) } } : {}),
  };
}

// runById finds a run across every downpipe's ring by run id (the proof verbs key on a run id, not a
// downpipe id), so a drill/verify/restore can read the run's counts. Returns undefined for an unknown run.
export function runById(runId: string): RunHistoryEntry | undefined {
  for (const ring of Object.values(world.historyByDownpipe)) {
    const found = ring.find((r) => r.runId === runId);
    if (found) return found;
  }
  return undefined;
}

// downpipeForRun finds the downpipe that owns a run id, by matching the run within its ring. Returns
// undefined when no downpipe owns the run (an unknown run id), so a handler stamps nothing.
export function downpipeForRun(runId: string): DownpipeState | undefined {
  for (const dp of world.downpipes) {
    if ((world.historyByDownpipe[dp.config.id] ?? []).some((r) => r.runId === runId)) return dp;
  }
  return undefined;
}

// stampProven sets the downpipe's "offline restorability last proven" record to now + the owner (a passed
// drill / blind test / attestation / apply is the durable recoverability proof the proof screen refreshes),
// and marks integrity verified now. These are recency + who only (no value, no key); no-custody holds.
export function stampProven(dp: DownpipeState, runId: string): void {
  const nowIso = new Date(Date.now()).toISOString();
  dp.lastRestoreProvenAt = nowIso;
  dp.lastRestoreProvenBy = ORG_OWNER_EMAIL;
  dp.lastIntegrityVerifiedAt = nowIso;
  dp.lastIntegrityVerifiedOk = true;
  void runId; // the run the proof read; the proven record carries who + when, not the run id (no-custody)
}
