// Reporting + RTO mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

// ============================================================================
// Reporting, mirrored byte-for-byte. A report carries names, counts,
// timestamps and an optional signature only; never a secret. The copy says tamper-evident, signed,
// never tamper-proof.
// ============================================================================

// ReportKind is the set of available reports. evidence-pack is the framework-organised compliance pack
// (the signed posture report re-projected through a framework's control mapping); it is parameterised by
// a framework id (or "all") rather than served as a single card.
export type ReportKind = "restore-tests" | "sla-compliance" | "immutability" | "posture" | "evidence-pack" | "change-requests";

// EvidencePackFramework is one downloadable compliance framework offered in the console. id MUST match an
// engine framework id (engine src/admin/frameworks.ts); label is the human name.
export interface EvidencePackFramework {
  id: string;
  label: string;
}

// FRAMEWORK_PACKS is the closed list the console offers for the customer-specific signed evidence pack
// (GET /admin/reports/evidence-pack?framework=<id>). The ids are kept in lockstep with the engine's
// frameworks.ts; an "all frameworks" pack is offered alongside via framework=all.
export const FRAMEWORK_PACKS: ReadonlyArray<EvidencePackFramework> = [
  { id: "apra-cps-230-234", label: "APRA CPS 234 & CPS 230" },
  { id: "iso-27001", label: "ISO/IEC 27001" },
  { id: "essential-eight", label: "Essential Eight" },
  { id: "dora", label: "EU DORA" },
  { id: "nis2", label: "EU NIS2" },
  { id: "eu-gdpr", label: "EU GDPR" },
  { id: "nist-fedramp", label: "NIST 800-53 & FedRAMP" },
  { id: "sec-17a-4", label: "SEC 17a-4" },
  { id: "soci-cirmp", label: "SOCI Act & CIRMP" },
  { id: "ism", label: "ISM" },
  { id: "privacy-act", label: "Privacy Act & APP 11" },
  { id: "uk-gdpr-caf", label: "UK GDPR & NCSC CAF" },
  { id: "soc-2", label: "SOC 2" },
];

// RtoConfidence mirrors the engine's RtoConfidence (engine src/admin/rto.ts): a coarse, honest
// confidence in the estimate. "none" = no samples (the estimate is unknown); "low" = one sample or a
// sample that covered a tiny fraction of the archive (thin signal); "medium"/"high" = several consistent
// samples covering a representative fraction. A hint for the reader, never a precise probability.
export type RtoConfidence = "none" | "low" | "medium" | "high";

// RtoEstimate mirrors the engine's RtoEstimate (engine src/admin/rto.ts) byte-for-byte: the derived
// per-downpipe (or fleet) recovery-time estimate, the recovery-time companion to RPO/freshness. It is an
// HONEST projection from observed restore-test throughput, NEVER a fabricated number:
//   known === false  the estimate is UNKNOWN (no drill history). estimateSeconds/basedOnDrills/caveat are
//                     absent; only reason (e.g. "no restore-test history yet") and confidence:"none" are
//                     meaningful. The console renders "Unknown (no recovery drills yet)", never a 0.
//   known === true   estimateSeconds is the derived whole-archive recovery estimate; basedOnDrills is the
//                     sample count that fed it (the "based on N drills" caveat); confidence is the coarse
//                     confidence; observedThroughputBytesPerSec is the measured drill throughput it scaled
//                     from; caveat is the fixed, redaction-safe note that the estimate is approximate.
// id/name identify a per-downpipe estimate (absent on the fleet roll-up). No field can carry a value or a
// key; this shape is durations, counts, a coarse confidence and a fixed caveat only (no-custody).
export interface RtoEstimate {
  id?: string;
  name?: string;
  known: boolean;
  estimateSeconds?: number;
  basedOnDrills?: number;
  confidence: RtoConfidence;
  observedThroughputBytesPerSec?: number;
  reason?: string;
  caveat?: string;
}

// RtoReport is the GET /admin/rto body: the fleet roll-up plus the per-downpipe estimates. When the route
// was called with ?id=<downpipeId>, downpipes holds just that one estimate (still with the fleet roll-up,
// so a console can show "this pipe vs the fleet"); with no id it holds an estimate per downpipe. Mirrors
// the engine's rtoData return shape (engine src/sched/scheduler-do.ts) exactly.
export interface RtoReport {
  fleet: RtoEstimate;
  downpipes: RtoEstimate[];
}

// Report is the GET /admin/reports/:kind JSON body. period is the reporting window in epoch seconds
// (or null for an all-time report). data is the per-kind structured body (a closed shape per kind,
// kept as unknown here so the console renders defensively over the engine's per-kind structure).
// signature, when present, is an "edmldsa1:..." hybrid signature over
// canonicalJSON({kind,generatedAt,period,data}); an auditor can verify it (tamper-evident, signed).
// It is optional and present only when the engine signed the report (exactOptionalPropertyTypes).
export interface Report {
  kind: ReportKind;
  generatedAt: string;
  period: { fromSeconds: number; toSeconds: number } | null;
  data: unknown;
  signature?: string;
}
