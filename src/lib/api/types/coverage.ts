// Coverage / gap-detection mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

// Coverage / gap detection (what is and is not backed up), mirrored byte-for-byte from the engine's
// src/admin/coverage.ts so the two sides cannot drift. A coverage row carries a resource type, native
// id, label, status and the covering downpipe id only; never a binding, value or key. No-custody +
// honest-unknown hold: with no inventory the report makes NO coverage claim.

// CoverageResourceType is the ID-KEYED subset of SourceSpec.type that the coverage inventory reconciles
// (kv/r2/secrets/d1). Account- and zone-scoped source types (cf-config, workers, stream, images,
// artifacts) are not tracked by the inventory.
export type CoverageResourceType = "kv" | "r2" | "secrets" | "d1";

// CoverageStatus is the per-resource verdict:
//   protected   - a configured downpipe backs this resource up AND has a verified run AND its
//                 recoverability has been proven. The only status that asserts the resource is safe.
//   untested    - backed up, but no successful run has landed OR recoverability has never been proven
//                 (the honest "backed up but never restore-proven" middle state; never shown as safe).
//   unprotected - no configured downpipe covers this resource at all. It exists and nothing backs it up.
export type CoverageStatus = "protected" | "unprotected" | "untested";

// CoverageResource is one row of the computed gap view: the resource's type, native id and display
// label, its computed status, and (when covered) the id of the covering downpipe so the console can
// link to it. downpipeId is honestly absent for an unprotected resource. Redaction-safe fields only.
export interface CoverageResource {
  type: CoverageResourceType;
  id: string;
  name: string; // the label if supplied, else the id (so a reader always has something to show)
  status: CoverageStatus;
  downpipeId?: string; // the covering downpipe's id, present only when covered (protected/untested)
}

// CoverageRollup is the headline count per status across every inventoried resource, plus the total.
// total === protected + unprotected + untested always (every resource lands in exactly one bucket).
export interface CoverageRollup {
  total: number;
  protected: number;
  unprotected: number;
  untested: number;
}

// CoverageReport is the GET /admin/coverage body. hasInventory is the HONEST-UNKNOWN discriminator:
//   false - no inventory is stored. resources is [], rollup is all-zero, and the report makes NO claim
//           about coverage (the console reads this as "unknown", never "fully covered").
//   true  - an inventory is stored (it may be empty). resources is the per-resource gap view and rollup
//           is the headline counts. generatedAt is the RFC-3339 millis-Z time the view was computed.
// The shape is identical in both cases; hasInventory is the flag that says whether the numbers MEAN
// anything.
export interface CoverageReport {
  hasInventory: boolean;
  generatedAt: string;
  rollup: CoverageRollup;
  resources: CoverageResource[];
}

// InventoryResource is one inventoried resource as it is SUBMITTED: a native id and an optional human
// label. Mirrored byte-for-byte from the engine's src/admin/coverage.ts. It carries no binding field, no
// credential and no value: there is no field that could hold any of them.
//   id    - the native resource identifier (a KV namespace id, an R2 bucket name, a D1 binding/database
//           id, or a Secrets Store secret name). 1 to 256 chars of [A-Za-z0-9._-] at the engine boundary.
//   name  - an OPTIONAL display label; honestly absent when only an id is supplied.
export interface InventoryResource {
  id: string;
  name?: string;
}

// ResourceInventory is the reference inventory submitted to POST /admin/coverage/inventory, grouped by
// resource type. Each group is a (possibly empty) list of InventoryResource; an omitted group is treated
// as empty by the engine. It is REFERENCE DATA ONLY: the engine stores it distinct from any binding and
// never consults it on a seal or restore path, so it can never grant data access.
export interface ResourceInventory {
  kv: InventoryResource[];
  r2: InventoryResource[];
  d1: InventoryResource[];
  secrets: InventoryResource[];
}

// CoverageInventoryStored is the POST /admin/coverage/inventory response: the per-type counts the engine
// stored, so the console can confirm what landed. No value is echoed back (an inventory carries only
// ids/labels; there is none to echo).
export interface CoverageInventoryStored {
  stored: true;
  counts: { kv: number; r2: number; d1: number; secrets: number };
}
