// Archive-destination mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

// The destination providers the engine and console agree on. R2 is the default (the engine's home
// platform; the endpoint is derivable so the operator types less); S3-compatible is the fully explicit
// variant for any other provider; Google Cloud Storage is S3-compatible too, but it is offered as its own
// choice because it needs a FIXED endpoint and refuses three of the S3 fields, and a provider the console
// can name is a provider it can prefill, price and refuse precisely.
//
// GCS is reached through its S3-interoperable XML API, authenticated with HMAC keys under the identical
// SigV4 scheme, so it shares every wire path with the S3 variant and needs no client of its own. That is
// an S3-interop client wearing a GCS label and the form never implies it is more.
//
// AZURE IS THE ONE MEMBER THAT IS NOT S3 ON THE WIRE. Azure Blob Storage does not speak the S3 XML API at
// all, so the engine gives it its own client and its own Shared Key signer (engine/src/dest/azure-blob.ts,
// azure-sharedkey.ts). The form still uses the explicit block, because the operator answers the same four
// questions (endpoint, container, credential pair), but three of the S3 extras are refused for it by name
// and two of the four boxes carry a different thing entirely (see AZURE_CRED_COPY in destination-form-
// fields.ts).
//
// Lives in this leaf module, not in screens/destination-form-fields.ts where it first lived, so this
// module and its siblings (sources.ts, status.ts) can use it without a type import back to a screen: a
// screen pulls in the whole api.ts barrel (h, modal, field helpers and all), so that back-import closed a
// madge cycle through api.ts even though it was type-only (madge does not skip type-only imports).
// destination-form-fields.ts now imports Provider from here and re-exports it for its own importers.
export type Provider = "r2" | "s3" | "gcs" | "azure";

// StorageClass mirrors the engine's closed allow-list (engine/src/dest/factory.ts STORAGE_CLASSES). Using
// the union instead of a bare string catches a typo at compile time rather than as a 400 from the engine.
export type StorageClass = "STANDARD" | "STANDARD_IA" | "INTELLIGENT_TIERING" | "ONEZONE_IA";

// DestinationPricing is the OPTIONAL per-destination unit pricing the owner attaches (mirror of the
// engine's DestinationPricing) so the cost estimate can prefill rates without re-asking. Operator
// configuration, never a secret; absent means the cost screen falls back to a provider preset.
export interface DestinationPricing {
  storagePerGBMonth: number;
  classAPerMillion: number;
  classBPerMillion: number;
  egressPerGB: number;
  currency?: string;
  source?: "preset" | "operator";
}

// WormStatus is a per-destination immutability policy (S3 Object-Lock): the mode and the retain-until
// window in whole days. governance = a privileged principal can override; compliance = undeletable for
// the window by anyone, the strong ransomware-resilience property (irreversible, choose deliberately).
// Non-secret operator configuration. Mirrors the engine's WormPolicy.
export interface WormStatus {
  mode: "governance" | "compliance";
  retentionDays: number;
}

// RetentionOutcome mirrors the engine's closed RETENTION_OUTCOMES (engine/src/cron/retention-record.ts):
// what the most recent retention-prune pass concluded for a destination. dry-run means a plan existed but
// retention.enforce is not true, so nothing was deleted (the commonest real cause of "retention never
// deletes anything"); paused means the destination's retention downpipes are paused, so the pass
// deliberately left them alone.
export type RetentionOutcome = "applied" | "dry-run" | "no-op" | "deferred" | "error" | "paused";

// PruneDeferClass mirrors the engine's closed PRUNE_DEFER_CLASSES (engine/src/seal/seal-faults.ts): why a
// prune pass abstained. In practice only "retained-run-unreadable" and "other" arrive (the recording site
// coarsens everything else to "other"); "runlog-absent" is kept for wire fidelity with the engine's enum.
export type PruneDeferClass = "retained-run-unreadable" | "runlog-absent" | "other";

// DestPruneApplied is the RECLAIM half of the prune sidecar: the most recent pass that actually applied
// deletions against this destination. reclaimed counts OBJECTS (run-tree objects plus orphaned segments),
// never bytes: the planner reads no object bodies, so a byte total does not exist and any byte figure
// shown for it would be a false claim.
export interface DestPruneApplied {
  at: number;
  reclaimed: number;
  supersededRuns: number;
}

// DestPruneOutcome is the OUTCOME half: what the most recent pass over this destination concluded.
// deferClass rides only on a "deferred" outcome; wormBlocked marks a pass whose deletes were refused by
// WORM/Object-Lock (the same posture deleteProbe: "denied" reports from the other side).
export interface DestPruneOutcome {
  at: number;
  outcome: RetentionOutcome;
  deferClass?: PruneDeferClass;
  wormBlocked?: boolean;
}

// DestPruneState mirrors the engine's per-destination retention-prune sidecar. Two halves so a
// later deferral never erases the last reclaim: lastApplied is absent until a pass actually applied
// deletions here; lastOutcome is always present when the sidecar is.
export interface DestPruneState {
  lastApplied?: DestPruneApplied;
  lastOutcome: DestPruneOutcome;
}

// DestinationStatus is GET /admin/destination: the redaction-safe view of WHERE BACKUPS GO.
// present is the console-set record (DO-stored); when absent, envConfigured/envKind report the
// deploy-time configuration so the screen can show the "configured at deploy" posture. NEVER a
// credential, endpoint host, bucket and region are names the owner typed, not secrets.
export interface DestinationStatus {
  present: boolean;
  // id/label/isDefault identify this destination within the collection (multi-destination). The
  // singular GET /destination view omits them (it is the default's redaction-safe status); the
  // GET /destinations list carries them so the console can list, set-default and remove each one.
  id?: string;
  label?: string;
  isDefault?: boolean;
  endpointHost?: string;
  bucket?: string;
  region?: string;
  setAt?: number;
  setBy?: string | null;
  verifiedAt?: number;
  // deleteProbe "denied" = the verification write landed but its cleanup delete was refused: an
  // immutability/object-lock posture (often deliberate). Backups work; retention pruning will not.
  deleteProbe?: "ok" | "denied";
  // worm is the CONFIGURED immutability policy (mode + retention days), the operator's INTENT. objectLock
  // is the LIVE store verdict captured at verification: whether the bucket actually enforces Object-Lock.
  // The screen shows the policy but keys its "immutable" claim on objectLock === "enforced" only (honest:
  // a policy on a bucket without Object-Lock enabled is silently ignored, never real protection).
  worm?: WormStatus;
  objectLock?: "enforced" | "not-enforced" | "unknown";
  // authMode is the redaction-safe authentication posture: "keys" (a stored long-lived key), "sts"
  // (AssumeRole temporary credentials) or "entra" (a Microsoft Entra service principal on an Azure Blob
  // destination). assumeRoleArn carries the (non-secret) role ARN when STS and azureEntra the two
  // (non-secret) ids when Entra. The externalId and the principal secret are never surfaced.
  //
  // Honest on both of the non-default readings: STS still stores a long-lived principal key (scoped to
  // assume-role only), and an Entra destination still stores a long-lived client secret. Neither
  // eliminates a stored credential, and the UI must not say either does.
  authMode?: "keys" | "sts" | "entra";
  assumeRoleArn?: string;
  // azureEntra is the redaction-safe view of an Azure destination's Microsoft Entra service principal:
  // the directory it signs in to and the application it is. Neither is secret; the client secret rides in
  // the credential slot and is surfaced nowhere. Read so the EDIT FORM can be seeded with it, which is not
  // cosmetic: the engine rebuilds the stored config from the submitted body, so a destination re-saved
  // from a form that could not show its principal is stored WITHOUT one.
  azureEntra?: { tenantId: string; clientId: string };
  // addressing is the S3 request-addressing style ("auto" | "path" | "vhost"), operator config, non-secret.
  addressing?: "auto" | "path" | "vhost";
  // storageClass is the S3 storage class (an immediately-readable tier), operator config, non-secret.
  storageClass?: StorageClass;
  source?: "console" | "deploy" | null;
  envConfigured?: boolean;
  envKind?: Provider | null;
  // pricing is the redaction-safe per-destination unit pricing for the cost estimate (operator config,
  // never a secret). Absent means the cost screen falls back to a provider preset for this destination.
  pricing?: DestinationPricing;
  // lastPrune is the per-destination retention-prune sidecar, additive on the wire. Absent means "no prune
  // recorded", never "retention has never run": an engine older than
  // the sidecar and a pass that has not yet run are indistinguishable here, so the screen must claim
  // neither. It also rides the env-configured default view (present: false), so the render must not
  // assume a stored destination.
  lastPrune?: DestPruneState;
}

// DestinationList is GET /admin/destinations: every console-set destination plus which id is the
// default. A downpipe with no destinationId, and every legacy run, writes to the default.
export interface DestinationList {
  destinations: DestinationStatus[];
  defaultId: string | null;
}

// DestinationInput is the console-set destination submission: always S3-shaped (R2 is reached
// through its S3-compatible endpoint), verified LIVE by the engine before anything is stored.
export interface DestinationInput {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  // pricing is OPTIONAL: the per-destination rates the owner sets when creating or editing a destination
  // (prefilled by provider preset), so the cost estimate needs no separate pricing step. Never a secret.
  pricing?: DestinationPricing;
  // worm is the OPTIONAL immutability policy. When present the engine arms S3 Object-Lock on every write
  // to this destination. The bucket MUST have been created with Object-Lock enabled for it to take effect;
  // the engine verifies the live capability and reports it back as DestinationStatus.objectLock. Absent =
  // off (the default). Works on any S3-compatible endpoint, including R2 reached over its S3 API.
  worm?: WormStatus;
  // assumeRole is the OPTIONAL AWS STS AssumeRole policy. When present, the Access Key ID / Secret Access
  // Key above are the assume-role PRINCIPAL (a long-lived key scoped to only assume the role), and the
  // engine mints short-lived credentials per run. region must be a real AWS region. The externalId is the
  // cross-account confused-deputy guard. Absent = a stored long-lived key is used directly.
  assumeRole?: { roleArn: string; externalId?: string; durationSeconds?: number };
  // addressing forces the S3 request-addressing style. Absent/"auto" picks virtual-hosted for AWS S3 and
  // path-style elsewhere; set "path" or "vhost" for a store that requires one. Ignored for R2.
  addressing?: "auto" | "path" | "vhost";
  // storageClass sets the S3 storage class on writes (a cost lever for cold backups). Only the
  // immediately-readable tiers are accepted by the engine; absent = the bucket default.
  storageClass?: StorageClass;
  // azureEntra is the OPTIONAL Microsoft Entra service principal for an AZURE BLOB destination: the
  // directory it signs in to and the application it is, neither of them secret. When present the engine
  // signs nothing and every request carries a bearer token it exchanges the client secret for.
  //
  // THE CLIENT SECRET IS NOT IN HERE. It rides in secretAccessKey, the same slot that carries the storage
  // account key on a Shared Key destination and a SAS token on a SAS one, so there is still exactly one
  // secret per destination in the field every surface that handles a destination secret already knows
  // about (engine/src/dest/factory-validators.ts:215-225).
  //
  // DECLARED HERE RATHER THAN LEFT IMPLICIT. Until the submit path spread this field into the
  // request and the type did not carry it, which typechecked only because a spread skips excess-property
  // checks. The field was on the wire and absent from the contract, which is the shape that lets a
  // capability be silently dropped by the next person who reads the type and believes it.
  azureEntra?: { tenantId: string; clientId: string };
}
