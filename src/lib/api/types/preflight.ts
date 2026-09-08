// Preflight entitlement/prerequisite mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

// Preflight mirror types (engine/src/admin/preflight.ts), copied byte-for-byte.
// Preflight is the engine's AFFIRMATIVE entitlement and prerequisite verification: each item is
// probed live where the platform allows, and where it does not the item says so honestly and
// names the deploy-time gate. The console renders these verbatim (escaped via the h() text
// path); it never re-derives or upgrades a status, so a failed probe can never paint green.

// PreflightStatus is one item's honest state. "verified" is an observed pass; "configured" is
// present-but-unproven (presence is not validity); "unconfigured" is an honest to-do; "failed"
// is an observed failure the readiness surface must show prominently.
export type PreflightStatus = "verified" | "configured" | "unconfigured" | "failed";

// PreflightItem is one prerequisite: the stable id, the human name, the Cloudflare product or
// onboarding step it depends on (requires), whether it is required for core backup/restore,
// the probed status, the observed evidence line (redaction-safe; never a value, never a key)
// and the remediation when there is something to do.
export interface PreflightItem {
  id: string;
  name: string;
  requires: string;
  required: boolean;
  status: PreflightStatus;
  evidence: string;
  remediation?: string;
}

// PreflightReport is the GET /admin/preflight body: when it was generated, the engine version
// that generated it, the required/verified/failed summary and the items themselves.
export interface PreflightReport {
  generatedAt: string;
  engineVersion: string;
  summary: { required: number; requiredVerified: number; failed: number };
  items: PreflightItem[];
}
