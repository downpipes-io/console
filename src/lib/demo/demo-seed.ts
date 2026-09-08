// The faked in-browser engine for the public, no-login product tour.
// It owns a seeded in-memory dataset, typed against the console's OWN wire types (src/lib/api/types/*),
// and a route(path, init) => Response table that answers the /admin/* calls the console issues. Reads
// return the seeded fixtures; writes mutate the module-scoped dataset and return the applied result shape
// the console models; nothing is persisted and a page reload re-seeds to the pristine world.
//
// Authoring the fixtures against the wire types is the maintenance guarantee: a response-shape change
// breaks the demo build rather than letting the demo silently drift from what the console parses. This is
// the family-C "real app on sample data" substrate (play.grafana.org), faked in the browser so the public
// tour has no engine to attack, no secret to leak and no per-visitor cost beyond static-asset serving.
//
// This is the complete finance-flavoured Northwind Trading Co seed covering all
// NINE Cloudflare source types the engine backs up (a D1 ledger, a KV payments store, an R2 statements
// bucket, an account cf-config surface, a Secrets Store gateway-secrets pipe, an account-scoped Workers
// pipe, a Stream videos pipe and an Images pipe both capturing bytes, and an Artifact Registry pipe; runs
// per pipe with one FAILED and one in-flight; a primary plus a replica S3 destination in ap-southeast-2 + us-east-1 with
// WORM; SAML / OIDC / OAuth2 IdP connections incl. an Okta SAML signing cert expiring in 21 days; an
// enterprise licence; an eight-to-ten-entry tamper-evident audit chain; drill evidence; one restore plan;
// a pending dual-control restore approval; the posture, coverage, expiry, RTO and signed-report reads). It
// answers every /admin/* read the proof-of-moat screens (Overview, Reports, Reports evidence packs,
// Security centre, Access + identity, Runs, Verify restorability, Destinations, Restore) issue. The
// ephemeral write handlers and the honesty banner land in phase 1c over this same shape.
//
// House rules: Australian English, precise claims (tamper-evident, post-quantum hybrid), no AI attribution.
//
// File layout: the faked engine spans four sibling modules along its natural seams. This file holds the
// fixture constants, the DemoWorld shape and the buildSeed() factory; demo-world.ts holds the module-scoped
// world singleton and the shared helpers; demo-routes-read.ts holds the GET route table; demo-routes-write.ts
// holds the write handlers. demo-fetch.ts installs the fetch interceptor over route().

import type {
  AttestSessionRun,
  AuditEvent,
  CanaryCheck,
  CanaryView,
  ConfigApprovalPolicy,
  ConfigChange,
  ConfigHistory,
  CoverageReport,
  DestinationList,
  DestinationStatus,
  DestReplState,
  DiscoveredAccount,
  DownpipeState,
  DrillEvidenceEntry,
  EstateSizeReport,
  ExpiryStatus,
  GroupRoleEntry,
  IdpConnectionView,
  IdpPreset,
  IdpProvider,
  LicenceStatus,
  NotifyChannel,
  NotifyHistoryEntry,
  NotifyRule,
  OwnerAction,
  PasskeyCredentialSummary,
  PostureReport,
  PreflightReport,
  PushDestinationView,
  Report,
  ReportKind,
  RestoreApproval,
  RestorePlan,
  KeyVintageInventory,
  RoleEntry,
  RtoReport,
  SetupState,
  SourceDiscovery,
  StatusReport,
  SupportStatus,
  UpdateStatus,
  UpdateStatusRecord,
  WhoAmI,
} from "../api/types.ts";
import type { CustomRole } from "../identity.ts";

// ---------------------------------------------------------------------------------------------------
// The seeded world. Held in module scope so the whole demo backend is one in-memory object and a reload
// (a fresh module evaluation) returns the pristine state. The shape mirrors the console wire types one for
// one; buildSeed() is the single constructor so a future "Back" replay (phase 2) can re-seed deterministically.
// ---------------------------------------------------------------------------------------------------

// The fictional org. Plainly fictional and finance-flavoured (the decided Northwind Trading Co), so a
// technical evaluator reads believable data without it being mistaken for a real account.
export const ORG_OWNER_EMAIL = "ops@northwind.example";
const ORG_OWNER_SUBJECT = "demo|northwind-owner";
// The engineer who RAISES a restore request (the maker). A named on-call engineer, DISTINCT from both the
// owner and the approver, so the engine's maker != checker rule (approver subject != requester subject) holds
// and the dual-control proof is concrete rather than theatre.
export const REQUESTER_EMAIL = "priya.nair@northwind.example";
// A second authorised person who APPROVES a restore request (the checker). It is DISTINCT from the maker (so
// approvedBy != requestedBy, the engine's real maker != checker invariant the route gate mirrors) AND DISTINCT
// from the signed-in owner (so the confirm-screen pre-flight, which arms Apply only when the approver differs
// from the LIVE caller, can light Apply for the owner who is driving the apply). This is the real-world shape:
// a second authorised person signs the maker's request, then a third authorised person (here the owner)
// applies the dual-signed plan. Seeding the owner as the approver left the apply permanently gated in
// free-explore (caller == approver), so the headline dual-control moment could be narrated but never driven.
export const APPROVER_EMAIL = "daniel.cho@northwind.example";

// DEMO_ACCT_ID + demoDiscoveredAccount: the ONE discovered Cloudflare account the demo's read-only token
// sees, extracted from buildSeed so the discovery-token WRITE (demo-routes-write.ts writeDiscoveryToken)
// hands the world the SAME account object the seed does, instead of duplicating the literal and drifting.
// A fresh object per call (never a shared reference), so a caller mutating its copy cannot reach back
// into another world's account list.
export const DEMO_ACCT_ID = "demo-acct-northwind";
export function demoDiscoveredAccount(): DiscoveredAccount {
  return {
    accountId: DEMO_ACCT_ID,
    accountName: "Northwind Trading Co",
    kv: [
      { id: "demo-kv-payments", name: "northwind-payments" },
      { id: "demo-kv-sessions", name: "northwind-sessions" },
    ],
    r2: [{ name: "northwind-statements" }, { name: "northwind-receipts" }],
    d1: [{ id: "ledger-db-0a1b2c", name: "northwind-ledger" }],
    secrets: [{ storeId: "gateway-secrets-store", name: "northwind-gateway-secrets" }],
    zones: [{ id: "demo-zone-northwind", name: "northwind.example" }],
    errors: [],
  };
}

// A fixed clock origin for the seed so the relative-time stamps the Overview renders ("4m ago", "in 2h")
// are stable and believable on every load, derived from "now" at seed time rather than hard-coded dates
// that would drift to "3 years ago". Offsets below are expressed against this origin.
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

// The stable entity ids the fixtures cross-reference (downpipe ids, destination ids, IdP connection ids).
// Named once so a run's destinationId, a replication key, an audit target and a coverage downpipeId all
// agree; a typo would be a dangling reference the screens render as a broken link.
const DP_LEDGER = "dp-ledger";
const DP_PAYMENTS = "dp-payments";
const DP_STATEMENTS = "dp-statements";
const DP_CFCONFIG = "dp-cf-config";
const DP_CFCONFIG_ZONE = "dp-cf-config-zone";
const DP_SECRETS = "dp-secrets";
const DP_WORKERS = "dp-workers";
const DP_STREAM = "dp-stream";
const DEST_PRIMARY = "primary-apse2";
const DEST_REPLICA = "replica-use1";
// The THIRD destination is Azure Blob, and its whole reason for existing is that it is NOT S3. See coldDest.
const DEST_COLD = "cold-azure-ae";
const IDP_SAML = "okta-saml";
const IDP_OIDC = "entra-oidc";
const IDP_OAUTH2 = "github-oauth2";

// DemoWorld is the whole faked dataset. Each field is the console wire shape the matching /admin/* read
// returns. Writes (phase 1c) mutate this object in place; reads serialise the relevant slice.
export interface DemoWorld {
  whoami: WhoAmI;
  status: StatusReport;
  setupState: SetupState;
  licence: LicenceStatus;
  updates: UpdateStatus;
  downpipes: DownpipeState[];
  // The run-history ring per downpipe id, newest-first, as the engine's GET /admin/history returns it.
  historyByDownpipe: Record<string, RunHistoryEntry[]>;
  // The archive destinations (the default primary plus the 3-2-1 replica), the singular default view, and
  // the per-downpipe per-destination replication state behind the topology map's reachability indicator.
  destinations: DestinationList;
  destinationDefault: DestinationStatus;
  replicationByDownpipe: Record<string, Record<string, DestReplState>>;
  // Native external-IdP SSO: the redacted connections (the owner's management list), the unauthenticated
  // sign-in DTOs, and the display-only add-connection preset catalogue.
  idpConnections: IdpConnectionView[];
  idpProviders: IdpProvider[];
  idpPresets: IdpPreset[];
  drillEvidence: DrillEvidenceEntry[];
  audit: AuditEvent[];
  // The dual-control restore approval inbox (the restore-flow + the owner needs-attention tile read it),
  // plus a seeded dry-run restore PLAN for a recent run (the phase-1c restore write returns it).
  approvals: RestoreApproval[];
  restorePlan: RestorePlan;
  // The assurance reads: the security-posture score, the coverage gap view, the credential-expiry tracker,
  // the recovery-time (RTO) estimate, the four signed reports keyed by kind, the per-framework evidence
  // packs keyed by framework id, and the four-eyes config-approval policy.
  posture: PostureReport;
  coverage: CoverageReport;
  expiry: ExpiryStatus[];
  rto: RtoReport;
  reports: Record<ReportKind, Report>;
  evidencePacks: Record<string, Report>;
  configApprovalPolicy: ConfigApprovalPolicy;
  // The estate-wide attended-verification interval in whole days (0 = none stated). It is estate state in
  // the engine, so the demo holds it in the world rather than in a browser preference, and a demo write
  // persists for the session like every other one.
  attendedCadenceDays: number;
  // The remaining proof-of-moat / governance screen reads, so EVERY nav item renders populated and nothing
  // hits the benign fallback in the common walk. Each is the console wire shape its screen's load read parses
  // (see the matching client-*.ts method): the canary liveness view, the config change-control inbox + the
  // signed config version history, the RBAC role tables (built-in roles, IdP group mappings, custom roles),
  // the notifications config (channels, rules, the delivery-history ring), the dual-control owner-action
  // inbox, the enrolled-passkey inventory, the SRE-alert webhook policy, the supportability status, the
  // safe-apply update lifecycle record, the source-discovery view + its presence-only status, and the
  // onboarding estate-size estimate. Honest texture: a healthy, well-run estate (some entries present, one
  // pending config change awaiting a second approver, an alive canary).
  canary: CanaryView;
  configChanges: ConfigChange[];
  configHistory: ConfigHistory;
  roles: RoleEntry[];
  groupRoles: GroupRoleEntry[];
  customRoles: CustomRole[];
  notifyChannels: NotifyChannel[];
  notifyRules: NotifyRule[];
  notifyHistory: NotifyHistoryEntry[];
  ownerActions: OwnerAction[];
  passkeyCredentials: PasskeyCredentialSummary[];
  // keyVintages is the keyless key-vintage inventory the Keys screen's Rotate tab reads. The demo org
  // has rotated once, so it carries TWO break-glass vintages and a stranded count: the tour then shows
  // the surface doing its job rather than an empty all-clear that teaches nothing.
  keyVintages: KeyVintageInventory;
  support: SupportStatus;
  // push is the SIEM audit-log push destination (design/siem-push/SIEM-PUSH-DESIGN.md), the
  // outbound sibling of the audit-feed PULL credential above (support.auditFeed). Seeded configured,
  // enabled and caught up, in deliberate contrast with support.accessPerimeter (true): the pull credential
  // above shows an Access warning, and this one shows a clean delivery trail, so the demo itself teaches the
  // dials-out advantage rather than just asserting it in copy.
  push: PushDestinationView;
  updateStatusRecord: UpdateStatusRecord;
  sourceDiscovery: SourceDiscovery;
  estateSize: EstateSizeReport;
  preflight: PreflightReport;
  // A monotonic counter the write handlers mint deterministic ids from (a queued config-change id, a new
  // destination id), so a created entity has a stable id within a session and a reload re-seeds it to 0.
  changeSeq: number;
  // attestSessions holds the pinned runs + effective sample rate for each attended-verification
  // session POST /admin/attest/session/create has minted, keyed by session id, so /prove, /capsules and
  // /verify can answer with the SAME runs the create response pinned rather than falling through to the
  // generic benignWrite fallback those routes used to have no case for at all. Session-scoped like every
  // other write-mutated field on this object: a reload re-seeds it empty.
  attestSessions: Record<string, { runs: AttestSessionRun[]; sampleRate: number }>;
  // settleQueue is the read-driven settlement of triggered runs: writeTrigger mints an in-flight run and
  // queues it here (keyed by runId, holding its downpipe and a fixed read countdown); each /admin/history
  // read that serves the ring decrements it, and at zero the run settles ok with honest counts. Read-count
  // driven, never wall-clock, so a replay (the training walk, the robot learner, validate-tour) sees the
  // identical Running-then-ok sequence every time. Session-scoped like every write-mutated field: a reload
  // re-seeds it empty.
  settleQueue: Record<string, { downpipeId: string; readsRemaining: number }>;
}

// RunHistoryEntry is imported through the barrel; aliasing it here keeps the field annotations terse.
type RunHistoryEntry = import("../api/types.ts").RunHistoryEntry;

// buildSeed constructs the pristine world. `now` is threaded in (not read inside) so a deterministic replay
// can pin the clock; the default is the real wall clock at first call. Every timestamp is derived from `now`
// so the demo always reads as "just now"-ish rather than dated.
export function buildSeed(now: number): DemoWorld {
  const iso = (offsetMs: number): string => new Date(now + offsetMs).toISOString();
  const epoch = (offsetMs: number): number => now + offsetMs;

  // One verified owner, signed in via Cloudflare Access (the green verdict the Access chip reads off whoami
  // as cryptographic truth, never hardcoded; the no-custody chip is a separate constant, true by
  // construction). roleSource "email" is the honest basis: an explicit owner grant, not the bare-token
  // break-glass.
  const whoami: WhoAmI = {
    method: "access",
    subject: ORG_OWNER_SUBJECT,
    email: ORG_OWNER_EMAIL,
    role: "owner",
    roleSource: "email",
    groups: ["finance-platform", "owners"],
    identityProvider: "Okta",
    sessionExpiresAt: Math.floor((now + 8 * HOUR) / 1000),
    isOnlyOwner: false,
  };

  // ---------------------------------------------------------------------------------------------
  // The Northwind fleet covering all NINE Cloudflare source types the engine backs up (the full backup
  // estate): the general ledger (D1), the payments store (KV), the customer statements bucket (R2), the
  // Cloudflare account configuration (cf-config, 313 zone + account surfaces), the payment-gateway secrets
  // (Secrets Store), the edge Workers (account-scoped), the training videos (Stream, bytes included), the
  // product imagery (Images, bytes included) and the container registry (Artifact Registry). The data pipes
  // and the account-scoped media pipes each fan out to the primary AND the replica (destinationIds index 0 =
  // primary the run seals to; the rest are replicas the finalised run is copied to), so the 3-2-1 story is
  // concrete on every pipe. The texture is kept honest and varied: one in-flight run (payments), one failed
  // run (payments), and two not-yet-restore-proven pipes (cf-config, account-config restore is a re-provision
  // and has never been drilled; artifacts, a freshly added pipe whose first restore test has not run yet).
  // The account-scoped sources (workers / stream / images / artifacts) carry an accountId and are read with
  // the read-only discovery token, not a per-downpipe binding; stream + images set includeContent so the
  // captured archive holds the media bytes, not just the inventory. Typed as DownpipeState (the console's
  // normalised, flat-ISO shape).
  // ---------------------------------------------------------------------------------------------
  const fanOut = [DEST_PRIMARY, DEST_REPLICA];
  const downpipes: DownpipeState[] = [
    {
      config: {
        id: DP_LEDGER,
        name: "General ledger (D1)",
        cadenceSeconds: (6 * HOUR) / 1000,
        enabled: true,
        source: { type: "d1", binding: "LEDGER_DB", include: [], exclude: [] },
        destinationIds: fanOut,
        restoreTestCadenceSeconds: (7 * DAY) / 1000,
        retention: { keepRuns: 90, keepDays: 365, enforce: true },
      },
      nextRunAt: epoch(2 * HOUR),
      lastRunId: "run-ledger-0009",
      inFlight: false,
      lastIntegrityVerifiedAt: iso(-3 * HOUR),
      lastIntegrityVerifiedOk: true,
      lastRestoreTestAt: iso(-2 * DAY),
      lastRestoreTestOk: true,
      lastRestoreProvenAt: iso(-2 * DAY),
      lastRestoreProvenBy: ORG_OWNER_EMAIL,
    },
    {
      config: {
        id: DP_PAYMENTS,
        name: "Payments store (KV)",
        cadenceSeconds: (1 * HOUR) / 1000,
        enabled: true,
        source: { type: "kv", binding: "PAYMENTS_KV", namespaceId: "demo-kv-payments", include: [], exclude: [] },
        destinationIds: fanOut,
        restoreTestCadenceSeconds: (7 * DAY) / 1000,
        retention: { keepRuns: 240, keepDays: 90, enforce: true },
      },
      nextRunAt: epoch(35 * MIN),
      lastRunId: "run-payments-0042",
      inFlight: true,
      lastIntegrityVerifiedAt: iso(-1 * HOUR),
      lastIntegrityVerifiedOk: true,
      lastRestoreTestAt: iso(-1 * DAY),
      lastRestoreTestOk: true,
      lastRestoreProvenAt: iso(-1 * DAY),
      lastRestoreProvenBy: ORG_OWNER_EMAIL,
    },
    {
      config: {
        id: DP_STATEMENTS,
        name: "Customer statements (R2)",
        cadenceSeconds: (12 * HOUR) / 1000,
        enabled: true,
        source: { type: "r2", binding: "STATEMENTS_R2", bucketName: "northwind-statements", include: [], exclude: [] },
        destinationIds: fanOut,
        restoreTestCadenceSeconds: (14 * DAY) / 1000,
        retention: { keepRuns: 60, keepDays: 2555, enforce: true },
      },
      nextRunAt: epoch(5 * HOUR),
      lastRunId: "run-statements-0021",
      inFlight: false,
      lastIntegrityVerifiedAt: iso(-7 * HOUR),
      lastIntegrityVerifiedOk: true,
      lastRestoreTestAt: iso(-5 * DAY),
      lastRestoreTestOk: true,
      lastRestoreProvenAt: iso(-5 * DAY),
      lastRestoreProvenBy: ORG_OWNER_EMAIL,
    },
    {
      config: {
        id: DP_CFCONFIG,
        name: "Cloudflare account config",
        cadenceSeconds: (24 * HOUR) / 1000,
        enabled: true,
        source: { type: "cf-config", accountId: "demo-acct-northwind", include: [], exclude: [] },
        destinationIds: fanOut,
        restoreTestCadenceSeconds: (30 * DAY) / 1000,
        retention: { keepRuns: 120, keepDays: 730, enforce: true },
      },
      nextRunAt: epoch(9 * HOUR),
      lastRunId: "run-cfconfig-0014",
      inFlight: false,
      lastIntegrityVerifiedAt: iso(-15 * HOUR),
      lastIntegrityVerifiedOk: true,
      // The cf-config pipe has never had a scheduled restore test run yet (account-config restore is a
      // re-provision), so its restore-proven fields are honestly absent: the protection statement reads
      // "never proven" rather than a fabricated pass. This is a deliberate, honest imperfection.
    },
    {
      config: {
        id: DP_CFCONFIG_ZONE,
        name: "Cloudflare zone config (northwind.example)",
        cadenceSeconds: (24 * HOUR) / 1000,
        enabled: true,
        // ZONE-SCOPED, which is the point of it existing alongside the account-scoped pipe above.
        //
        // The surface picker filters by scope, and two of its controls, the "This zone only" and
        // "Account + this zone" shortcuts, render ONLY when a zoneId is present. With one account-scoped
        // cf-config downpipe in the seed those controls could not be reached by any journey: the browser
        // test written for them found no such element and skipped in silence, which is a green that
        // proves nothing. The zone surfaces already in the catalogue fixture had the same problem, and
        // the comment beside them said so.
        //
        // It is a second downpipe rather than a zoneId added to the first, because the account-scoped
        // case is itself deliberate: it is what exercises the account-scope filter and the "0 of the 1
        // re-apply" wording. Converting it would trade one blind spot for another.
        source: { type: "cf-config", accountId: "demo-acct-northwind", zoneId: "demo-zone-northwind", include: [], exclude: [] },
        destinationIds: fanOut,
        restoreTestCadenceSeconds: (30 * DAY) / 1000,
        retention: { keepRuns: 120, keepDays: 730, enforce: true },
      },
      nextRunAt: epoch(11 * HOUR),
      lastRunId: "run-cfconfigzone-0007",
      inFlight: false,
      lastIntegrityVerifiedAt: iso(-16 * HOUR),
      lastIntegrityVerifiedOk: true,
    },
    {
      config: {
        id: DP_SECRETS,
        name: "Payment gateway secrets (Secrets Store)",
        cadenceSeconds: (12 * HOUR) / 1000,
        enabled: true,
        // A Secrets Store source captures the named secrets' sealed VALUES (recoverable on restore), bound
        // through a store binding; the secrets list is name + binding only here (no value transits the seed).
        source: {
          type: "secrets",
          binding: "GATEWAY_SECRETS",
          secrets: [
            { name: "stripe-live-key", binding: "GATEWAY_SECRETS" },
            { name: "adyen-webhook-hmac", binding: "GATEWAY_SECRETS" },
          ],
          include: [],
          exclude: [],
        },
        destinationIds: fanOut,
        restoreTestCadenceSeconds: (14 * DAY) / 1000,
        retention: { keepRuns: 120, keepDays: 365, enforce: true },
      },
      nextRunAt: epoch(6 * HOUR),
      lastRunId: "run-secrets-0031",
      inFlight: false,
      lastIntegrityVerifiedAt: iso(-6 * HOUR),
      lastIntegrityVerifiedOk: true,
      lastRestoreTestAt: iso(-3 * DAY),
      lastRestoreTestOk: true,
      lastRestoreProvenAt: iso(-3 * DAY),
      lastRestoreProvenBy: ORG_OWNER_EMAIL,
    },
    {
      config: {
        id: DP_WORKERS,
        name: "Edge Workers (account)",
        cadenceSeconds: (24 * HOUR) / 1000,
        enabled: true,
        // Workers is account-scoped and read with the read-only discovery token: it captures every Worker's
        // code, bindings metadata and a version inventory (secret bindings are name-only). No binding, no key.
        source: { type: "workers", accountId: "demo-acct-northwind", include: [], exclude: [] },
        destinationIds: fanOut,
        restoreTestCadenceSeconds: (30 * DAY) / 1000,
        retention: { keepRuns: 90, keepDays: 365, enforce: true },
      },
      nextRunAt: epoch(11 * HOUR),
      lastRunId: "run-workers-0018",
      inFlight: false,
      lastIntegrityVerifiedAt: iso(-13 * HOUR),
      lastIntegrityVerifiedOk: true,
      lastRestoreTestAt: iso(-6 * DAY),
      lastRestoreTestOk: true,
      lastRestoreProvenAt: iso(-6 * DAY),
      lastRestoreProvenBy: ORG_OWNER_EMAIL,
    },
    {
      config: {
        id: DP_STREAM,
        name: "Training videos (Stream)",
        cadenceSeconds: (24 * HOUR) / 1000,
        enabled: true,
        // Stream is account-scoped; includeContent captures the video BYTES (size-gated), not just the
        // metadata inventory, so the archive can re-upload the media on restore (a new uid is id-mapped).
        source: { type: "stream", accountId: "demo-acct-northwind", includeContent: true, include: [], exclude: [] },
        destinationIds: fanOut,
        restoreTestCadenceSeconds: (30 * DAY) / 1000,
        retention: { keepRuns: 30, keepDays: 365, enforce: true },
      },
      nextRunAt: epoch(13 * HOUR),
      lastRunId: "run-stream-0009",
      inFlight: false,
      lastIntegrityVerifiedAt: iso(-17 * HOUR),
      lastIntegrityVerifiedOk: true,
      lastRestoreTestAt: iso(-9 * DAY),
      lastRestoreTestOk: true,
      lastRestoreProvenAt: iso(-9 * DAY),
      lastRestoreProvenBy: ORG_OWNER_EMAIL,
    },
    // Images and Artifact Registry are intentionally NOT backed up here, so the Overview coverage hero shows
    // a realistic mix rather than an all-green wall (it mirrors the advert's "you have surfaces with no
    // backup" message): Artifact Registry is ADDED as a source but has no downpipe yet (amber, the
    // actionable gap), and Images is not added at all (slate). See sourceDiscovery.addedSources below.
  ];

  // ---------------------------------------------------------------------------------------------
  // Recent runs per downpipe, newest-first. Mostly clean, with one deliberate FAILED run and one
  // in-flight run (the failure UX is a feature: the evaluator's wow is "it catches problems", and all-green
  // reads as theatre). Every one of the nine pipes has a run ring so nothing dangles when a pipe is opened.
  // Typed as RunHistoryEntry; opCounts/bytes are counts only (no value, no key).
  // ---------------------------------------------------------------------------------------------
  const ledgerRuns: RunHistoryEntry[] = [
    { runId: "run-ledger-0009", index: 9, startedAt: iso(-3 * HOUR), status: "ok", recordCount: 184_220, bytes: 96_337_408, durationMs: 41_900, archiveBytesWritten: 50_102_272, segmentsWritten: 1, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "sampled-decrypt", sampled: 64, at: epoch(-3 * HOUR + 42_000) } },
    { runId: "run-ledger-0008", index: 8, startedAt: iso(-9 * HOUR), status: "ok", recordCount: 183_910, bytes: 96_111_104, durationMs: 40_700, archiveBytesWritten: 49_977_344, segmentsWritten: 1, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "tier-0", sampled: 0, at: epoch(-9 * HOUR + 41_000) } },
    { runId: "run-ledger-0007", index: 7, startedAt: iso(-15 * HOUR), status: "ok", recordCount: 183_640, bytes: 95_995_904, durationMs: 39_800, archiveBytesWritten: 49_917_952, segmentsWritten: 1, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "tier-0", sampled: 0, at: epoch(-15 * HOUR + 40_000) } },
  ];
  const paymentsRuns: RunHistoryEntry[] = [
    { runId: "run-payments-0042", index: 42, startedAt: iso(-4 * MIN), status: "in-flight" },
    // prevRunId/prevRunIdStatus (F3, COV.9 visual-baseline fixture): 0040 is genuinely 0041's
    // immediate predecessor and stays in this same ring, so "retained" is the honest verdict, not a
    // guess -- the run-detail drawer's Predecessor row renders the real chained id.
    { runId: "run-payments-0041", index: 41, startedAt: iso(-1 * HOUR), status: "ok", recordCount: 52_140, bytes: 18_220_032, durationMs: 12_400, archiveBytesWritten: 9_474_048, segmentsWritten: 1, destinationId: DEST_PRIMARY, prevRunId: "run-payments-0040", prevRunIdStatus: "retained", sealVerification: { status: "verified", tier: "sampled-decrypt", sampled: 48, at: epoch(-1 * HOUR + 13_000) } },
    {
      runId: "run-payments-0040",
      index: 40,
      startedAt: iso(-2 * HOUR),
      status: "failed",
      error: "destination probe failed: AccessDenied (the replica bucket policy denied a list during the WORM check); the primary copy sealed cleanly.",
    },
    { runId: "run-payments-0039", index: 39, startedAt: iso(-3 * HOUR), status: "ok", recordCount: 51_980, bytes: 18_153_472, durationMs: 12_100, archiveBytesWritten: 9_439_232, segmentsWritten: 1, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "tier-0", sampled: 0, at: epoch(-3 * HOUR + 12_000) } },
    // The rest of this ring is deliberately widened across several calendar days, with two multi-run
    // days, so the restore-flow point-in-time CALENDAR (restore-flow/date-picker.ts) renders a populated
    // grid on the tour and demo rather than a one-column strip. No behaviour change: same shape, same
    // fields, just more of the hourly cadence's own real history.
    { runId: "run-payments-0038", index: 38, startedAt: iso(-1 * DAY - 2 * HOUR), status: "ok", recordCount: 51_710, bytes: 18_070_016, durationMs: 11_900, archiveBytesWritten: 9_396_224, segmentsWritten: 1, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "tier-0", sampled: 0, at: epoch(-1 * DAY - 2 * HOUR + 12_000) } },
    { runId: "run-payments-0037", index: 37, startedAt: iso(-1 * DAY - 5 * HOUR), status: "ok", recordCount: 51_540, bytes: 18_012_672, durationMs: 12_200, archiveBytesWritten: 9_360_128, segmentsWritten: 1, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "sampled-decrypt", sampled: 40, at: epoch(-1 * DAY - 5 * HOUR + 13_000) } },
    {
      runId: "run-payments-0036",
      index: 36,
      startedAt: iso(-1 * DAY - 9 * HOUR),
      status: "failed",
      error: "source read failed: rate limited (the KV namespace's per-second read budget was exhausted mid-crawl); no partial archive was sealed.",
    },
    { runId: "run-payments-0035", index: 35, startedAt: iso(-1 * DAY - 14 * HOUR), status: "ok", recordCount: 51_290, bytes: 17_940_224, durationMs: 12_000, archiveBytesWritten: 9_310_720, segmentsWritten: 1, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "tier-0", sampled: 0, at: epoch(-1 * DAY - 14 * HOUR + 12_000) } },
    { runId: "run-payments-0034", index: 34, startedAt: iso(-2 * DAY - 1 * HOUR), status: "ok", recordCount: 51_050, bytes: 17_862_656, durationMs: 11_800, archiveBytesWritten: 9_267_968, segmentsWritten: 1, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "tier-0", sampled: 0, at: epoch(-2 * DAY - 1 * HOUR + 11_800) } },
    { runId: "run-payments-0033", index: 33, startedAt: iso(-2 * DAY - 6 * HOUR), status: "ok", recordCount: 50_820, bytes: 17_789_952, durationMs: 12_300, archiveBytesWritten: 9_224_192, segmentsWritten: 1, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "sampled-decrypt", sampled: 36, at: epoch(-2 * DAY - 6 * HOUR + 13_500) } },
    { runId: "run-payments-0032", index: 32, startedAt: iso(-2 * DAY - 11 * HOUR), status: "ok", recordCount: 50_610, bytes: 17_715_200, durationMs: 11_700, archiveBytesWritten: 9_183_232, segmentsWritten: 1, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "tier-0", sampled: 0, at: epoch(-2 * DAY - 11 * HOUR + 11_700) } },
    { runId: "run-payments-0031", index: 31, startedAt: iso(-3 * DAY - 3 * HOUR), status: "ok", recordCount: 50_400, bytes: 17_643_520, durationMs: 11_900, archiveBytesWritten: 9_142_272, segmentsWritten: 1, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "tier-0", sampled: 0, at: epoch(-3 * DAY - 3 * HOUR + 11_900) } },
    { runId: "run-payments-0030", index: 30, startedAt: iso(-4 * DAY - 2 * HOUR), status: "ok", recordCount: 50_180, bytes: 17_567_744, durationMs: 12_100, archiveBytesWritten: 9_101_312, segmentsWritten: 1, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "tier-0", sampled: 0, at: epoch(-4 * DAY - 2 * HOUR + 12_100) } },
  ];
  const statementsRuns: RunHistoryEntry[] = [
    { runId: "run-statements-0021", index: 21, startedAt: iso(-7 * HOUR), status: "ok", recordCount: 9_410, bytes: 5_812_183_040, durationMs: 184_000, archiveBytesWritten: 3_022_356_480, segmentsWritten: 6, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "sampled-decrypt", sampled: 32, at: epoch(-7 * HOUR + 185_000) } },
    { runId: "run-statements-0020", index: 20, startedAt: iso(-19 * HOUR), status: "ok", recordCount: 9_388, bytes: 5_801_697_280, durationMs: 182_500, archiveBytesWritten: 3_016_900_608, segmentsWritten: 6, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "tier-0", sampled: 0, at: epoch(-19 * HOUR + 183_000) } },
  ];
  const cfConfigRuns: RunHistoryEntry[] = [
    { runId: "run-cfconfig-0014", index: 14, startedAt: iso(-15 * HOUR), status: "ok", recordCount: 314, bytes: 1_318_912, durationMs: 6_700, archiveBytesWritten: 686_080, segmentsWritten: 1, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "tier-0", sampled: 0, at: epoch(-15 * HOUR + 7_000) } },
  ];
  const secretsRuns: RunHistoryEntry[] = [
    { runId: "run-secrets-0031", index: 31, startedAt: iso(-6 * HOUR), status: "ok", recordCount: 18, bytes: 24_576, durationMs: 3_100, archiveBytesWritten: 13_312, segmentsWritten: 1, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "full", sampled: 18, at: epoch(-6 * HOUR + 3_500) } },
    { runId: "run-secrets-0030", index: 30, startedAt: iso(-18 * HOUR), status: "ok", recordCount: 18, bytes: 24_576, durationMs: 3_000, archiveBytesWritten: 13_184, segmentsWritten: 1, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "tier-0", sampled: 0, at: epoch(-18 * HOUR + 3_200) } },
  ];
  const workersRuns: RunHistoryEntry[] = [
    { runId: "run-workers-0018", index: 18, startedAt: iso(-13 * HOUR), status: "ok", recordCount: 42, bytes: 31_457_280, durationMs: 18_900, archiveBytesWritten: 16_358_400, segmentsWritten: 1, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "sampled-decrypt", sampled: 12, at: epoch(-13 * HOUR + 19_500) } },
    { runId: "run-workers-0017", index: 17, startedAt: iso(-37 * HOUR), status: "ok", recordCount: 41, bytes: 30_932_992, durationMs: 18_400, archiveBytesWritten: 16_084_992, segmentsWritten: 1, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "tier-0", sampled: 0, at: epoch(-37 * HOUR + 18_900) } },
  ];
  const streamRuns: RunHistoryEntry[] = [
    { runId: "run-stream-0009", index: 9, startedAt: iso(-17 * HOUR), status: "ok", recordCount: 318, bytes: 41_104_179_200, durationMs: 612_000, archiveBytesWritten: 21_374_173_184, segmentsWritten: 20, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "sampled-decrypt", sampled: 16, at: epoch(-17 * HOUR + 613_000) } },
    { runId: "run-stream-0008", index: 8, startedAt: iso(-41 * HOUR), status: "ok", recordCount: 314, bytes: 40_802_189_312, durationMs: 605_000, archiveBytesWritten: 21_217_083_392, segmentsWritten: 20, destinationId: DEST_PRIMARY, sealVerification: { status: "verified", tier: "tier-0", sampled: 0, at: epoch(-41 * HOUR + 606_000) } },
  ];

  // ---------------------------------------------------------------------------------------------
  // The 3-2-1 destinations: the PRIMARY in ap-southeast-2 and the REPLICA in us-east-1, both with S3
  // Object-Lock in compliance mode and the live objectLock verdict "enforced", so the immutability +
  // ransomware-resilience story is concrete and HONEST (the screen keys "immutable" on objectLock ===
  // "enforced", not merely on the configured policy). deleteProbe "denied" on a WORM bucket is the
  // EXPECTED, deliberate posture (the verification write landed; its cleanup delete was refused because
  // the object is locked). Redaction-safe: bucket/region/endpoint are names the owner typed, never creds.
  // ---------------------------------------------------------------------------------------------
  const primaryDest: DestinationStatus = {
    present: true,
    id: DEST_PRIMARY,
    label: "Primary (ap-southeast-2)",
    isDefault: true,
    endpointHost: "s3.ap-southeast-2.amazonaws.com",
    bucket: "northwind-archive-apse2",
    region: "ap-southeast-2",
    setAt: epoch(-30 * DAY),
    setBy: ORG_OWNER_EMAIL,
    verifiedAt: epoch(-3 * HOUR),
    deleteProbe: "denied",
    worm: { mode: "compliance", retentionDays: 2555 },
    objectLock: "enforced",
    authMode: "keys",
    addressing: "vhost",
    storageClass: "STANDARD",
    source: "console",
    // The honest prune telemetry for a compliance-WORM bucket whose delete probe is refused (B61,
    // decided not discovered): the last pass ran and object lock refused its deletes (an error outcome
    // carrying wormBlocked, exactly as the engine records a WORM refusal), and there is deliberately NO
    // lastApplied. A fabricated reclaimed count here would claim deletions this bucket cannot have
    // performed and would break the W5 invariant (deleteProbe "denied" never renders a count). This
    // seed feeds the public tour and the offline test bed, so the fixture is the truthful posture, not
    // a prettier one.
    lastPrune: { lastOutcome: { at: epoch(-4 * HOUR), outcome: "error", wormBlocked: true } },
  };
  const replicaDest: DestinationStatus = {
    present: true,
    id: DEST_REPLICA,
    label: "Replica (us-east-1)",
    isDefault: false,
    endpointHost: "s3.us-east-1.amazonaws.com",
    bucket: "northwind-archive-use1",
    region: "us-east-1",
    setAt: epoch(-30 * DAY),
    setBy: ORG_OWNER_EMAIL,
    verifiedAt: epoch(-6 * HOUR),
    deleteProbe: "denied",
    worm: { mode: "compliance", retentionDays: 2555 },
    objectLock: "enforced",
    authMode: "sts",
    assumeRoleArn: "arn:aws:iam::000000000000:role/northwind-archive-writer",
    addressing: "vhost",
    storageClass: "STANDARD",
    source: "console",
    // Same honest posture as the primary (see the comment there): wormBlocked, no lastApplied, no count.
    lastPrune: { lastOutcome: { at: epoch(-9 * HOUR), outcome: "error", wormBlocked: true } },
  };
  // ---------------------------------------------------------------------------------------------
  // The THIRD destination, and the only reason it exists: IT IS NOT S3.
  //
  // Both destinations above are Amazon S3 hosts, so until the seeded world had no provider
  // badge but "S3", no provider-dependent copy, and no immutability prerequisite an operator of another
  // store would recognise. downpipes writes to four kinds of store, and the tour and the training course
  // rendered exactly one of them: a learner could finish the course without ever seeing that the product
  // reaches anything but Amazon.
  //
  // Azure Blob Storage is the one chosen because it is the store that is not S3 ON THE WIRE (its own
  // client and its own Shared Key signer in the engine), so it is the destination whose console surfaces
  // differ most: the Azure badge on the list, the residency and map phrasing, a credential pair that holds
  // a storage account name rather than an Access Key ID, and no storage class at all (Azure has access
  // tiers, which downpipes does not translate to, so the field is absent here as it is on the form).
  //
  // NOT pinned in any downpipe's fan-out and NOT the default, on purpose: the 3-2-1 story above is about
  // the primary and the replica, and pinning a third would change what every downpipe claims. A
  // destination that no downpipe writes to yet is an ordinary state, and it is the state an operator is in
  // the moment after they add one.
  //
  // Immutability is enforced on it, as it is on the other two, because an Azure container with
  // version-level immutability really does enforce a policy (compliance maps to a locked policy). The
  // delete probe is denied and the prune outcome carries wormBlocked, the same honest posture as the S3
  // pair rather than a prettier one.
  // ---------------------------------------------------------------------------------------------
  const coldDest: DestinationStatus = {
    present: true,
    id: DEST_COLD,
    label: "Cold copy (Azure, australiaeast)",
    isDefault: false,
    endpointHost: "northwindarchive.blob.core.windows.net",
    bucket: "northwind-archive-cold",
    region: "australiaeast",
    setAt: epoch(-11 * DAY),
    setBy: ORG_OWNER_EMAIL,
    verifiedAt: epoch(-5 * HOUR),
    deleteProbe: "denied",
    worm: { mode: "compliance", retentionDays: 2555 },
    objectLock: "enforced",
    authMode: "keys",
    addressing: "vhost",
    source: "console",
    lastPrune: { lastOutcome: { at: epoch(-7 * HOUR), outcome: "error", wormBlocked: true } },
  };
  const destinations: DestinationList = { destinations: [primaryDest, replicaDest, coldDest], defaultId: DEST_PRIMARY };

  // Per-downpipe per-destination replication state (the topology map's reachability heartbeat). Every pipe
  // PROVES the primary holds its latest run; the replica is one run behind on the payments pipe (the
  // failed run-0040 deferred a mirror), so the map shows an honest "catching up", not a fabricated green.
  const replOk = (runId: string, index: number, lastAttemptOffset: number): DestReplState => ({
    holdsRunId: runId,
    holdsIndex: index,
    lastOk: true,
    lastAttemptAt: epoch(lastAttemptOffset),
  });
  const replicationByDownpipe: Record<string, Record<string, DestReplState>> = {
    [DP_LEDGER]: {
      [DEST_PRIMARY]: replOk("run-ledger-0009", 9, -3 * HOUR),
      [DEST_REPLICA]: replOk("run-ledger-0009", 9, -3 * HOUR),
    },
    [DP_PAYMENTS]: {
      [DEST_PRIMARY]: replOk("run-payments-0041", 41, -1 * HOUR),
      // The replica is one run behind and the last mirror attempt was refused by the bucket policy during
      // the WORM check (the same cause as the FAILED run-0040), so lastOk is false with a coarse reason.
      [DEST_REPLICA]: { holdsRunId: "run-payments-0039", holdsIndex: 39, lastOk: false, lastAttemptAt: epoch(-2 * HOUR), reason: "AccessDenied during the replica WORM list check" },
    },
    [DP_STATEMENTS]: {
      [DEST_PRIMARY]: replOk("run-statements-0021", 21, -7 * HOUR),
      [DEST_REPLICA]: replOk("run-statements-0021", 21, -7 * HOUR),
    },
    [DP_CFCONFIG]: {
      [DEST_PRIMARY]: replOk("run-cfconfig-0014", 14, -15 * HOUR),
      [DEST_REPLICA]: replOk("run-cfconfig-0014", 14, -15 * HOUR),
    },
    [DP_CFCONFIG_ZONE]: {
      [DEST_PRIMARY]: replOk("run-cfconfigzone-0007", 7, -16 * HOUR),
      [DEST_REPLICA]: replOk("run-cfconfigzone-0007", 7, -16 * HOUR),
    },
    [DP_SECRETS]: {
      [DEST_PRIMARY]: replOk("run-secrets-0031", 31, -6 * HOUR),
      [DEST_REPLICA]: replOk("run-secrets-0031", 31, -6 * HOUR),
    },
    [DP_WORKERS]: {
      [DEST_PRIMARY]: replOk("run-workers-0018", 18, -13 * HOUR),
      [DEST_REPLICA]: replOk("run-workers-0018", 18, -13 * HOUR),
    },
    [DP_STREAM]: {
      [DEST_PRIMARY]: replOk("run-stream-0009", 9, -17 * HOUR),
      [DEST_REPLICA]: replOk("run-stream-0009", 9, -17 * HOUR),
    },
  };

  // ---------------------------------------------------------------------------------------------
  // Native external-IdP SSO. Three redacted connections: the Okta SAML one whose signing cert expires in
  // 21 days (so the expiry alert is LIVE), a Microsoft Entra OIDC one, and a GitHub OAuth2 one. A secret
  // is ALWAYS a { mode } descriptor with no value (the redaction guarantee); the SAML signing certs are
  // PUBLIC X.509 PEMs (safe to display). Passkey is the always-on local fallback (not an IdP connection),
  // which the sign-in screen offers alongside these; the tour copy names it.
  // ---------------------------------------------------------------------------------------------
  // A plainly-illustrative, well-formed-looking PEM placeholder (NOT a real certificate). It exists so the
  // SAML card and the cert-expiry maths have a cert to show; the bytes are filler, never a real key half.
  const DEMO_SAML_CERT = "-----BEGIN CERTIFICATE-----\nMIIDdemoNorthwindOktaSigningCertPlaceholderNotARealCertificateAAAA\nBBBBCCCCDDDDEEEEFFFF0000111122223333444455556666777788889999abcd\n-----END CERTIFICATE-----";
  const idpConnections: IdpConnectionView[] = [
    {
      id: IDP_SAML,
      label: "Okta (SAML)",
      kind: "saml",
      enabled: true,
      presetId: "generic-saml",
      createdBy: ORG_OWNER_EMAIL,
      createdAt: iso(-180 * DAY),
      idpEntityId: "http://www.okta.com/exkdemoNorthwind",
      idpSsoUrl: "https://northwind.okta.example/app/exkdemo/sso/saml",
      idpSigningCerts: [DEMO_SAML_CERT],
      spEntityId: "https://tour.downpipes.io/admin/saml/metadata/okta-saml",
      nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress",
      wantAssertionsSigned: true,
      allowIdpInitiated: false,
      clockSkewSec: 120,
      emailVerifiedPolicy: "trust-idp",
      emailAttr: "email",
      groupsAttr: "groups",
    },
    {
      id: IDP_OIDC,
      label: "Microsoft Entra ID (OIDC)",
      kind: "oidc",
      enabled: true,
      presetId: "entra-oidc",
      createdBy: ORG_OWNER_EMAIL,
      createdAt: iso(-150 * DAY),
      issuer: "https://login.microsoftonline.com/demo-tenant/v2.0",
      clientId: "demo-entra-client-id",
      secretRef: { mode: "do-plaintext" },
      scopes: ["openid", "email", "profile"],
      pkce: "required",
      clientAuth: "client_secret_post",
      groupsClaim: "groups",
      rolesClaim: "roles",
    },
    {
      id: IDP_OAUTH2,
      label: "GitHub (OAuth2)",
      kind: "oauth2",
      enabled: false,
      presetId: "github-oauth2",
      createdBy: ORG_OWNER_EMAIL,
      createdAt: iso(-60 * DAY),
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      clientId: "demo-github-client-id",
      secretRef: { mode: "do-plaintext" },
      scopes: ["read:user", "user:email"],
      subjectPrefix: "github",
      pkce: "none",
    },
  ];
  // The PRE-AUTH sign-in DTOs: only the ENABLED connections, with no internal config. The disabled GitHub
  // OAuth2 connection is deliberately absent (a disabled connection shows no sign-in button).
  const idpProviders: IdpProvider[] = [
    { id: IDP_SAML, label: "Okta (SAML)", kind: "saml", presetId: "generic-saml" },
    { id: IDP_OIDC, label: "Microsoft Entra ID (OIDC)", kind: "oidc", presetId: "entra-oidc" },
  ];
  // The display-only add-connection catalogue (no secrets). A small representative subset of the engine's
  // preset list, enough for the Access + identity screen's "add a connection" picker to render.
  // The full ten-preset catalogue, mirroring the engine's oidc-presets.ts (ids, labels, vendors, kinds and
  // required values) so the demo and tour render the same provider grid an owner sees in production. The
  // connections above seed three of them as configured (Entra + Okta-SAML enabled, GitHub off); the rest
  // render as "Add" tiles. The guide ids line up with these (idp-guides.ts is keyed by the engine preset id).
  const idpPresets: IdpPreset[] = [
    {
      id: "entra",
      label: "Microsoft Entra ID",
      vendor: "Microsoft",
      buttonLabel: "Sign in with Microsoft",
      kind: "oidc",
      requiredVars: [{ key: "tenantId", label: "Directory (tenant) ID", example: "00000000-0000-0000-0000-000000000000" }],
      notes: ["Uses the v2.0 endpoints. Map authorisation with App Roles (the roles claim)."],
    },
    {
      id: "okta",
      label: "Okta",
      vendor: "Okta",
      buttonLabel: "Sign in with Okta",
      kind: "oidc",
      requiredVars: [
        { key: "oktaDomain", label: "Okta domain", example: "your-org.okta.com" },
        { key: "authServerId", label: "Authorization server id", example: "default", default: "default" },
      ],
      notes: ["Uses a custom authorization server so the groups claim can be emitted."],
    },
    {
      id: "google",
      label: "Google Workspace",
      vendor: "Google",
      buttonLabel: "Sign in with Google",
      kind: "oidc",
      requiredVars: [{ key: "hdDomain", label: "Workspace domain", example: "yourcompany.com" }],
      notes: ["The hosted-domain (hd) gate limits sign-in to your Workspace. Google sends no groups."],
    },
    {
      id: "keycloak",
      label: "Keycloak",
      vendor: "Keycloak / Red Hat",
      buttonLabel: "Sign in",
      kind: "oidc",
      requiredVars: [
        { key: "host", label: "Keycloak host", example: "sso.yourcompany.com" },
        { key: "realm", label: "Realm", example: "employees" },
      ],
      notes: ["Turn on 'Add to ID token' for the roles and groups mappers, or no roles arrive."],
    },
    {
      id: "jumpcloud",
      label: "JumpCloud",
      vendor: "JumpCloud",
      buttonLabel: "Sign in with JumpCloud",
      kind: "oidc",
      requiredVars: [],
      notes: ["One shared issuer for all tenants; trust rests on the client id and subject prefix."],
    },
    {
      id: "auth0",
      label: "Auth0",
      vendor: "Auth0 (Okta)",
      buttonLabel: "Sign in with Auth0",
      kind: "oidc",
      requiredVars: [
        { key: "domain", label: "Auth0 domain", example: "your-tenant.us.auth0.com" },
        { key: "claimNamespace", label: "Roles claim namespace (optional, for role mapping)", example: "https://app.yourcompany.com/", default: "" },
      ],
      notes: ["The issuer needs a trailing slash; include the region in the domain."],
    },
    {
      id: "gitlab",
      label: "GitLab",
      vendor: "GitLab",
      buttonLabel: "Sign in with GitLab",
      kind: "oidc",
      requiredVars: [{ key: "host", label: "GitLab host", example: "gitlab.com", default: "gitlab.com" }],
      notes: ["Group mapping reads the groups_direct id_token claim (direct memberships)."],
    },
    {
      id: "generic-oidc",
      label: "Generic OIDC",
      vendor: "Any OIDC provider",
      buttonLabel: "Sign in",
      kind: "oidc",
      requiredVars: [
        { key: "issuer", label: "Issuer URL", example: "https://idp.yourcompany.com" },
        { key: "groupsClaim", label: "Groups/roles claim name (optional)", example: "groups", default: "" },
      ],
      notes: ["Point this at any spec-compliant .well-known/openid-configuration."],
    },
    {
      id: "github",
      label: "GitHub",
      vendor: "GitHub",
      buttonLabel: "Sign in with GitHub",
      kind: "oauth2",
      requiredVars: [],
      notes: ["GitHub is OAuth2, not OIDC: identity is read from the user + email APIs."],
    },
    {
      id: "generic-oauth2",
      label: "Generic OAuth2",
      vendor: "Any OAuth2 provider",
      buttonLabel: "Sign in",
      kind: "oauth2",
      requiredVars: [
        { key: "authorizeUrl", label: "Authorization URL", example: "https://provider.example/oauth/authorize" },
        { key: "tokenUrl", label: "Token URL", example: "https://provider.example/oauth/token" },
        { key: "apiBase", label: "API base URL", example: "https://api.provider.example" },
        { key: "profileUrl", label: "User-info URL", example: "https://api.provider.example/user" },
        { key: "subjectPath", label: "Immutable user-id field", example: "id", default: "id" },
      ],
      notes: ["The extensibility hatch for any OAuth2 provider with no id_token."],
    },
  ];

  // ---------------------------------------------------------------------------------------------
  // The config-presence status the onboarding poll reads. Every flag is "configured" (the demo org is past
  // first-run) so the dashboard, not the setup checklist, renders. demoMode stays false/absent: the public
  // faked tour is NOT the throwaway demo engine (no reset endpoint exists; reset is a page reload), so the
  // "Reset demo" affordance must not appear. The distinct tour-mode banner is the public-demo signal (phase 1c).
  // expiryWarnings is 1 (the Okta SAML signing cert is approaching expiry); cleanupPending is 0.
  // ---------------------------------------------------------------------------------------------
  const status: StatusReport = {
    service: "downpipes-engine",
    engineVersion: "1.0.0",
    signerConfigured: true,
    breakGlassConfigured: true,
    operationalConfigured: { public: true, private: true },
    destConfigured: true,
    destKind: "s3",
    updateChannelConfigured: true,
    licenceConfigured: true,
    downpipeCount: downpipes.length,
    ready: true,
    auditNearCap: false,
    recoveryCodesRemaining: 8,
    bootstrapConsumed: true,
    breakGlassTokenRetired: true,
    tokenFallbackDisabled: false,
    expiryWarnings: 1,
    cleanupPending: 0,
  };

  // The consolidated first-run facts. Every step reads done so the guided-setup gate dissolves and Overview
  // mounts the full dashboard (deriveSetup: keysReady + destination.configured + discoveryTokenPresent +
  // boundSourceCount>0 + downpipeCount>0).
  const setupState: SetupState = {
    ownerExists: true,
    keysReady: true,
    signerConfigured: true,
    breakGlassConfigured: true,
    emailConfigured: true,
    discoveryTokenPresent: true,
    accountsSelected: true,
    destination: { configured: true, verified: true, kind: "s3", source: "console", bucket: "northwind-archive-apse2", endpointHost: "s3.ap-southeast-2.amazonaws.com" },
    boundSourceCount: downpipes.length,
    downpipeCount: downpipes.length,
    anyRunCompleted: true,
    ready: true,
  };

  // Fail-open enterprise licence with a not-after several months out, so the Licence card reads correctly
  // without ever gating the data or recovery path.
  const licence: LicenceStatus = {
    tier: "enterprise",
    valid: true,
    notAfter: iso(210 * DAY),
    source: "console",
    setAt: epoch(-30 * DAY),
    setBy: ORG_OWNER_EMAIL,
  };

  // No update available: the signed channel is configured and verified, and the running version is current.
  const updates: UpdateStatus = {
    configured: true,
    verified: true,
    currentVersion: "1.0.0",
    recommendedVersion: "1.0.0",
    updateAvailable: false,
  };

  // Recent drill-evidence (the durable, dated "recoverability was proven" trail), each an in-account engine
  // drill outcome. Four entries across the fleet so the recovery card and the restore-tests report have
  // substance.
  const drillEvidence: DrillEvidenceEntry[] = [
    { runId: "run-ledger-0008", kind: "in-account", recordedBy: ORG_OWNER_EMAIL, recordedAt: iso(-2 * DAY), note: "Weekly blind restore test: all 183,910 ledger records decrypted-and-verified to the discard sink." },
    { runId: "run-secrets-0030", kind: "in-account", recordedBy: ORG_OWNER_EMAIL, recordedAt: iso(-3 * DAY), note: "Secrets Store blind restore test: every sealed secret value decrypted-and-verified, never exposed." },
    { runId: "run-payments-0041", kind: "in-account", recordedBy: ORG_OWNER_EMAIL, recordedAt: iso(-1 * DAY) },
    { runId: "run-statements-0020", kind: "in-account", recordedBy: ORG_OWNER_EMAIL, recordedAt: iso(-5 * DAY), note: "Statements bucket sample-verify (large objects, sampled decrypt)." },
    { runId: "run-workers-0017", kind: "in-account", recordedBy: ORG_OWNER_EMAIL, recordedAt: iso(-6 * DAY), note: "Workers blind restore test: every script's code + bindings metadata verified." },
    { runId: "run-ledger-0007", kind: "in-account", recordedBy: ORG_OWNER_EMAIL, recordedAt: iso(-8 * DAY) },
    { runId: "run-stream-0008", kind: "in-account", recordedBy: ORG_OWNER_EMAIL, recordedAt: iso(-9 * DAY), note: "Training-video sample-verify (large media archive, sampled decrypt)." },
  ];

  // ---------------------------------------------------------------------------------------------
  // A tamper-evident, hash-chained audit log: a short newest-first chain, each entry signing the prior hash
  // (prevHash of entry N === hash of entry N-1). The Overview reads only the newest (the "last audited"
  // stamp); the Security centre audit screen reads the page + verifies the chain. The hashes are plainly
  // illustrative fixtures (a "demo-chain-NNNN" sequence), not real digests; the chain LINKS correctly so
  // GET /admin/audit/verify reports it intact regardless of length. Targets are the SAME closed
  // redaction-safe union the engine writes (no value, no key). Entries are ordered newest-first by ts.
  // ---------------------------------------------------------------------------------------------
  const chainHash = (seq: number): string => `demo-chain-${String(seq).padStart(4, "0")}`;
  const auditDesc: Array<{ ts: string; action: AuditEvent["action"]; outcome: AuditEvent["outcome"]; target: AuditEvent["target"]; actorEmail?: string; actorMethod?: AuditEvent["actorMethod"]; sourceIp?: string }> = [
    { ts: iso(-1 * HOUR), action: "restore-request", outcome: "success", sourceIp: "203.0.113.40", actorEmail: REQUESTER_EMAIL, target: { kind: "restore", runId: "run-payments-0041", redirectBinding: null, planHash: "sha384:demo-payments-0041-planhash", isLatest: false, reason: "Quarterly recovery rehearsal: restore the payments store to a staging binding." } },
    // change-recorded events: the change-management ledger in the audit log itself (mirrors the Change records
    // report). Two normal CRs and one Emergency Change, so the audit log, the report and the emergency-change
    // posture all tell one story. These are records (change number / flagged emergency), not approvals.
    { ts: iso(-6 * HOUR), action: "change-recorded", outcome: "success", sourceIp: "198.51.100.7", actorEmail: "owner@northwind.example", actorMethod: "access", target: { kind: "change", actionKind: "dest-remove", emergency: true, changeNumber: null, reason: "Primary bucket compromised; repointing under incident INC-4821." } },
    { ts: iso(-1 * DAY), action: "change-recorded", outcome: "success", sourceIp: "192.0.2.24", actorEmail: "ops@northwind.example", actorMethod: "access", target: { kind: "change", actionKind: "idp-conn-enabled", emergency: false, changeNumber: "CHG0012044", reason: null } },
    { ts: iso(-2 * DAY), action: "change-recorded", outcome: "success", sourceIp: "198.51.100.7", actorEmail: "owner@northwind.example", actorMethod: "access", target: { kind: "change", actionKind: "dest-put", emergency: false, changeNumber: "CHG0012001", reason: null } },
    { ts: iso(-2 * DAY), action: "retention-prune", outcome: "success", actorMethod: "engine", target: { kind: "downpipe", id: DP_PAYMENTS, name: "Payments store (KV)" } },
    { ts: iso(-2 * DAY), action: "config-policy-change", outcome: "success", sourceIp: "198.51.100.7", target: { kind: "access-policy" } },
    // The Security-centre overrides seeded on the posture (the MFA attestation and the account-config risk
    // accept): their audit rows, so the posture, the reports and the audit log tell one story.
    { ts: iso(-9 * DAY), action: "posture-override-set", outcome: "success", sourceIp: "198.51.100.7", actorEmail: "ops@northwind.example", actorMethod: "access", target: { kind: "posture-check", checkId: "admin-strong-auth", overrideKind: "attested-pass" } },
    { ts: iso(-30 * DAY), action: "posture-override-set", outcome: "success", sourceIp: "198.51.100.7", actorEmail: "ops@northwind.example", actorMethod: "access", target: { kind: "posture-check", checkId: "cf-config-untested", overrideKind: "risk-accepted" } },
    // Artifact Registry was added as a source (the sources-attached event below) but has no downpipe yet.
    { ts: iso(-5 * DAY), action: "dest-config-set", outcome: "success", sourceIp: "198.51.100.7", target: { kind: "access-policy" } },
    { ts: iso(-7 * DAY), action: "downpipe-create", outcome: "success", sourceIp: "192.0.2.24", target: { kind: "downpipe", id: DP_CFCONFIG, name: "Cloudflare account config" } },
    { ts: iso(-9 * DAY), action: "downpipe-create", outcome: "success", sourceIp: "192.0.2.24", target: { kind: "downpipe", id: DP_SECRETS, name: "Payment gateway secrets (Secrets Store)" } },
    { ts: iso(-12 * DAY), action: "sources-attached", outcome: "success", sourceIp: "192.0.2.24", target: { kind: "access-policy" } },
    { ts: iso(-30 * DAY), action: "role-change", outcome: "success", sourceIp: "198.51.100.7", target: { kind: "role", email: "auditor@northwind.example", role: "viewer" } },
    { ts: iso(-30 * DAY), action: "bootstrap-consumed", outcome: "success", sourceIp: "198.51.100.7", target: { kind: "engine-state", field: "secret-present", detail: "bootstrap token consumed at first sign-in" } },
    { ts: iso(-180 * DAY), action: "downpipe-create", outcome: "success", target: { kind: "downpipe", id: DP_LEDGER, name: "General ledger (D1)" } },
  ];
  // Highest seq is the newest; assign descending seqs so entry 0 is the head and the chain links cleanly.
  const auditCount = auditDesc.length;
  const audit: AuditEvent[] = auditDesc.map((d, i) => {
    const seq = auditCount - i;
    return {
      seq,
      ts: d.ts,
      actorSubject: ORG_OWNER_SUBJECT,
      actorEmail: d.actorEmail ?? ORG_OWNER_EMAIL,
      actorMethod: d.actorMethod ?? "access",
      // RFC 5737 documentation addresses on the human events, engine actors render as
      // "system", and the oldest entry stays null so all three honest renderings appear.
      sourceIp: d.sourceIp ?? null,
      action: d.action,
      outcome: d.outcome,
      target: d.target,
      prevHash: chainHash(seq - 1),
      hash: chainHash(seq),
    };
  });

  // ---------------------------------------------------------------------------------------------
  // One dual-control restore approval, REQUESTED (pending), awaiting a SECOND authorised identity (maker
  // != checker).
  // It gives the restore-flow approvals inbox and the owner needs-attention tile real substance and
  // makes the dual-control proof concrete. The reason is redaction-safe free text; bytes/plannedWrites are
  // counts; redirectBinding null = restore to the original bindings. requestedBy is the engineer who raised
  // the restore, a DISTINCT identity from both the second approver who signs it (maker != checker, the engine
  // refuses a self-approval) and the owner who applies the dual-signed plan.
  // ---------------------------------------------------------------------------------------------
  const approvals: RestoreApproval[] = [
    {
      planHash: "sha384:demo-payments-0041-planhash",
      runId: "run-payments-0041",
      isLatest: false,
      plannedWrites: 52_140,
      bytes: 18_220_032,
      redirectBinding: null,
      requestedBy: REQUESTER_EMAIL,
      requestedAt: iso(-1 * HOUR),
      reason: "Quarterly recovery rehearsal: restore the payments store to a staging binding and verify a sample.",
      status: "requested",
      expiresAt: iso(23 * HOUR),
    },
  ];

  // A seeded dry-run restore PLAN for a recent run (the phase-1c restore write returns it; seeded now so
  // the assurance world is complete). It verifies a sample of the payments run's records WITHOUT exposing
  // a single byte of plaintext (the sample carries names + sizes only). planHash binds the dual-control.
  const restorePlan: RestorePlan = {
    ok: true,
    runId: "run-payments-0041",
    mode: "dry-run",
    recordsVerified: 52_140,
    isLatest: false,
    plannedWrites: 52_140,
    bytes: 18_220_032,
    sample: [
      { name: "payments/2026/06/INV-100482", sourceType: "kv", binding: "PAYMENTS_KV", namespace: "demo-kv-payments", plaintextSize: 412 },
      { name: "payments/2026/06/INV-100483", sourceType: "kv", binding: "PAYMENTS_KV", namespace: "demo-kv-payments", plaintextSize: 388 },
      { name: "payments/2026/06/INV-100484", sourceType: "kv", binding: "PAYMENTS_KV", namespace: "demo-kv-payments", plaintextSize: 401 },
    ],
    skipped: [],
    planHash: "sha384:demo-payments-0041-planhash",
  };

  // ---------------------------------------------------------------------------------------------
  // The security-posture report: a 0..100 score over severity-weighted control checks, each mapping to a
  // named standard, stating what was observed, HOW it is decided, and a remediation. ONE check fails
  // honestly (the replica mirror lag on the payments pipe, the same cause as the failed run-0040), ONE
  // awaits the owner's attestation (media diversity, the state the platform genuinely cannot verify), one
  // carries an ATTESTED PASS (MFA enforced at Okta, the owner's recorded determination) and one a
  // RISK ACCEPT, so every override state the console can render has a real demo item. The score is the
  // weighted pass fraction over the applicable checks (critical weighted highest; N/A excluded).
  // ---------------------------------------------------------------------------------------------
  const posture: PostureReport = {
    // 25 total weight; the replica fail (2), the artifacts fail (1) and the unattested media check (2)
    // are the only score-negative items -> 20/25 = 80 (an honest "fair", with the improvement path being
    // exactly the actions the demo teaches: attest, fix, accept).
    score: 80,
    generatedAt: iso(-20 * MIN),
    checks: [
      { id: "destination-immutability", title: "Archive destinations enforce Object-Lock", severity: "critical", status: "pass", autoStatus: "pass", control: "Essential Eight ML2 (backups) / APRA CPS 234", detail: "All three destinations report immutability enforced in compliance mode: the primary in ap-southeast-2, the replica in us-east-1, and the Azure cold copy in australiaeast. The delete probe is denied on each, confirming it.", remediation: "No action: immutability is enforced at every destination.", how: "A live probe of each destination's immutability configuration (GetObjectLockConfiguration on the two S3 buckets, the container's version-level immutability policy on the Azure one), so enforcement is observed, never inferred from delete behaviour." },
      { id: "three-two-one", title: "3-2-1 replication is configured", severity: "high", status: "pass", autoStatus: "pass", control: "ISO/IEC 27001 A.8.13", detail: "Every downpipe fans out to two destinations in two AWS regions, giving three copies including the live Cloudflare source.", remediation: "No action: fan-out is configured on every downpipe.", how: "Counts each downpipe's distinct pinned destinations; fails when any writes to fewer than two." },
      { id: "media-diversity", title: 'Media diversity attested (3-2-1 "two media")', severity: "medium", status: "unattested", autoStatus: "cannot-verify", control: "3-2-1", detail: "Your sources fan out to multiple cloud destinations. downpipes is cloud-only, so it cannot verify the \"two different media\" leg of 3-2-1 for you. If your destinations meet your media-diversity policy, attest it with the reason recorded.", remediation: "If your destinations satisfy your media-diversity requirement (for example distinct providers or accounts), attest this check as a pass with your reasoning.", how: "The platform cannot observe media class for cloud-only storage, so this check asks for YOUR attestation once a source fans out; it is never platform-verified and never a red failure." },
      { id: "admin-strong-auth", title: "Strong admin sign-in (MFA / passkeys / SSO)", severity: "high", status: "attested-pass", autoStatus: "cannot-verify", control: "Essential Eight MFA / NIST SP 800-63B", detail: "Sign-in happens through the Okta connection, where MFA enforcement is applied by the IdP and is not observable here.", remediation: "Enrol a passkey for every admin identity (platform-verified), or attest the MFA policy that covers admin sign-in.", how: "Verified automatically only when every admin identity has an enrolled passkey and no IdP bypass exists; otherwise it needs your attestation, because MFA enforced at your IdP is not observable from inside the engine.", override: { kind: "attested-pass", reason: "MFA is enforced for all staff by the Okta conditional-access policy (phishing-resistant factors only).", setBy: "ops@northwind.example", setAt: iso(-9 * DAY) } },
      { id: "replica-freshness", title: "Replica is one run behind on the payments store", severity: "medium", status: "fail", autoStatus: "fail", control: "APRA CPS 230 (backup currency)", detail: "The us-east-1 replica holds payments run 39; the primary holds run 41. The last mirror attempt was refused by the replica bucket policy during the WORM list check (the same cause as the failed payments run 40).", remediation: "Grant the replica writer role s3:ListBucket on the archive prefix so the WORM check can complete, then re-run the payments downpipe to catch the replica up.", how: "Compares each replica's latest mirrored run against the primary's on every read; fails when a replica trails." },
      { id: "restore-test-recency", title: "Restore tests are recent on the proven pipes", severity: "high", status: "pass", autoStatus: "pass", control: "CIS 11.5 / SEC 17a-4", detail: "The ledger, payments, statements, secrets, Workers, Stream and Images downpipes each have a passed restore test within their cadence; recoverability is proven, not assumed. The account-config and the freshly added artifact-registry pipes are tracked separately as not yet drilled.", remediation: "No action on the proven pipes: blind restore tests are passing within cadence.", how: "Reads each downpipe's last successful restore-test time; fails when any downpipe with archives has none within the window." },
      { id: "cf-config-untested", title: "Account-config restore has not been drilled", severity: "low", status: "risk-accepted", autoStatus: "fail", control: "ISO/IEC 27001 A.5.30 (ICT continuity)", detail: "The Cloudflare account-config downpipe has never had a restore test run. Account-config restore is a re-provision; an owner accepted this risk pending a documented runbook.", remediation: "Schedule a re-provision rehearsal for the account-config snapshot, or keep the documented manual runbook current.", how: "Reads the account-config downpipe's drill history on every read.", override: { kind: "risk-accepted", reason: "Accepted pending the documented re-provision runbook (target: next quarter's DR exercise).", setBy: "ops@northwind.example", setAt: iso(-30 * DAY) } },
      { id: "artifacts-untested", title: "The artifact-registry pipe is not yet restore-proven", severity: "low", status: "fail", autoStatus: "fail", control: "CIS 11.5 (recovery testing)", detail: "The container-registry downpipe was added recently and has sealed two clean runs, but no blind restore test has run yet, so its recoverability is backed up but not yet proven.", remediation: "Run a blind restore test against the latest artifact-registry run to prove recoverability, then let the scheduled cadence keep it proven.", how: "Reads the downpipe's drill history; a newly added pipe shows here until its first blind restore test passes." },
      { id: "signing-cert-expiry", title: "An SSO signing certificate is approaching expiry", severity: "medium", status: "pass", autoStatus: "pass", control: "ISO/IEC 27001 A.8.24 (key management)", detail: "The Okta SAML signing certificate expires in 21 days. It is tracked in the credential-expiry register, so it is surfaced well ahead of expiry.", remediation: "Rotate the Okta SAML signing certificate before it expires and update the connection's certificate.", how: "Reads the credential-expiry register's per-item state on every read." },
      { id: "break-glass-retired", title: "The static bootstrap token is retired", severity: "high", status: "pass", autoStatus: "pass", control: "ASVS V2 (authentication)", detail: "The static bootstrap break-glass token has been retired; sign-in is via SSO, passkeys and single-use recovery codes only.", remediation: "No action: the bootstrap token can no longer sign in.", how: "Observes the token's presence, the env-disable flag and the in-app retire latch; account-level and identical for every reader." },
    ],
  };

  // ---------------------------------------------------------------------------------------------
  // The coverage / gap view: an inventory IS stored (hasInventory true). One resource is deliberately
  // UNPROTECTED (an R2 bucket that exists but no downpipe covers) so the gap-detection wow is real (the
  // evaluator values "it finds what is NOT backed up"); the rest are protected or backed-up-but-not-yet-proven.
  // A coverage row carries a type, native id, label, status and the covering downpipe id only (no-custody).
  // The inventory reconciles only the ID-KEYED source types (kv / r2 / d1 / secrets); the account- and
  // zone-scoped types (cf-config / workers / stream / images / artifacts) are not tracked by this view by
  // design (CoverageResourceType), so the gap view stays focused on the per-resource estate.
  // ---------------------------------------------------------------------------------------------
  const coverage: CoverageReport = {
    hasInventory: true,
    generatedAt: iso(-25 * MIN),
    rollup: { total: 6, protected: 4, unprotected: 1, untested: 1 },
    resources: [
      { type: "d1", id: "ledger-db-0a1b2c", name: "northwind-ledger", status: "protected", downpipeId: DP_LEDGER },
      { type: "kv", id: "demo-kv-payments", name: "northwind-payments", status: "protected", downpipeId: DP_PAYMENTS },
      { type: "r2", id: "northwind-statements", name: "northwind-statements", status: "protected", downpipeId: DP_STATEMENTS },
      { type: "secrets", id: "gateway-secrets-store", name: "northwind-gateway-secrets", status: "protected", downpipeId: DP_SECRETS },
      // Backed up but recoverability not yet proven (no passed restore test): the honest middle state.
      { type: "kv", id: "demo-kv-sessions", name: "northwind-sessions", status: "untested", downpipeId: DP_PAYMENTS },
      // Exists but NOT backed up: the gap the feature exists to surface.
      { type: "r2", id: "northwind-receipts", name: "northwind-receipts", status: "unprotected" },
    ],
  };

  // ---------------------------------------------------------------------------------------------
  // The credential-expiry register: the Okta SAML signing cert approaching expiry (21 days, the LIVE
  // alert), plus the two destination access keys (one a long-lived key, one with a wider window). Each row
  // carries a redaction-safe label + a date + a state only; never the secret. The approaching threshold is
  // daysRemaining <= 30 per the wire contract, so a 21-day cert reads state "approaching" (the value the
  // real engine computes); the posture + status.expiryWarnings carry the narrative the tour highlights.
  // ---------------------------------------------------------------------------------------------
  const expiry: ExpiryStatus[] = [
    {
      id: "okta-saml-signing-cert",
      label: "Okta SAML signing certificate",
      kind: "certificate",
      expiresAt: iso(21 * DAY),
      daysRemaining: 21,
      state: "approaching",
      source: "observed",
      lifecycleClass: "functional",
      purpose: "Verifies signed SAML assertions from Okta at sign-in.",
      usageLink: { kind: "idpConnection", refId: IDP_SAML },
      observedAt: iso(-1 * DAY),
    },
    {
      id: "primary-dest-key",
      label: "Primary archive access key (ap-southeast-2)",
      kind: "credential",
      expiresAt: iso(160 * DAY),
      daysRemaining: 160,
      state: "ok",
      source: "manual",
      lifecycleClass: "functional",
      purpose: "Writes sealed archives to the primary S3 destination.",
      usageLink: { kind: "destination", refId: DEST_PRIMARY },
    },
    {
      id: "replica-assume-role-principal",
      label: "Replica assume-role principal (us-east-1)",
      kind: "credential",
      state: "no-expiry",
      source: "manual",
      lifecycleClass: "functional",
      purpose: "Long-lived principal scoped only to assume the replica archive-writer role; the engine mints short-lived credentials per run.",
      usageLink: { kind: "destination", refId: DEST_REPLICA },
    },
  ];

  // The RTO (recovery-time) estimate: an HONEST projection from observed restore-test throughput, NEVER a
  // fabricated number. The fleet and the data pipes have drill history so the estimate is known with a
  // medium confidence; the value is durations + counts only (no value, no key).
  const rto: RtoReport = {
    fleet: { known: true, estimateSeconds: 5_400, basedOnDrills: 6, confidence: "medium", observedThroughputBytesPerSec: 12_582_912, caveat: "An approximate whole-archive recovery estimate scaled from observed restore-test throughput; actual time varies with network and destination load." },
    downpipes: [
      { id: DP_LEDGER, name: "General ledger (D1)", known: true, estimateSeconds: 900, basedOnDrills: 3, confidence: "high", observedThroughputBytesPerSec: 13_631_488, caveat: "Approximate; based on recent restore-test throughput." },
      { id: DP_PAYMENTS, name: "Payments store (KV)", known: true, estimateSeconds: 300, basedOnDrills: 2, confidence: "medium", observedThroughputBytesPerSec: 12_058_624, caveat: "Approximate; based on recent restore-test throughput." },
      { id: DP_STATEMENTS, name: "Customer statements (R2)", known: true, estimateSeconds: 4_200, basedOnDrills: 1, confidence: "low", observedThroughputBytesPerSec: 11_534_336, caveat: "Approximate; thin signal (one drill over a large archive)." },
      { id: DP_CFCONFIG, name: "Cloudflare account config", known: false, confidence: "none", reason: "No restore-test history yet for the account-config downpipe." },
      { id: DP_SECRETS, name: "Payment gateway secrets (Secrets Store)", known: true, estimateSeconds: 120, basedOnDrills: 2, confidence: "high", observedThroughputBytesPerSec: 12_582_912, caveat: "Approximate; based on recent restore-test throughput." },
      { id: DP_WORKERS, name: "Edge Workers (account)", known: true, estimateSeconds: 480, basedOnDrills: 2, confidence: "medium", observedThroughputBytesPerSec: 12_058_624, caveat: "Approximate; based on recent restore-test throughput." },
      { id: DP_STREAM, name: "Training videos (Stream)", known: true, estimateSeconds: 9_600, basedOnDrills: 1, confidence: "low", observedThroughputBytesPerSec: 10_485_760, caveat: "Approximate; thin signal (one drill over a large media archive)." },
    ],
  };

  // ---------------------------------------------------------------------------------------------
  // The four signed, tamper-evident reports plus the per-framework evidence packs. Each carries a
  // post-quantum hybrid "edmldsa1:..." signature placeholder over the canonical body, so the reports
  // screen renders the signature-PRESENT state (it never claims client-side cryptographic verification;
  // the verifying key is not shipped to the browser). The data is the customer's own observable state:
  // names, counts and timestamps only, never a secret. The signature bytes are illustrative fixtures.
  // ---------------------------------------------------------------------------------------------
  const DEMO_SIG = "edmldsa1:ZGVtby1ub3J0aHdpbmQtcG9zdC1xdWFudHVtLWh5YnJpZC1zaWduYXR1cmUtcGxhY2Vob2xkZXItbm90LWEtcmVhbC1zaWduYXR1cmU";
  const reportBase = (kind: ReportKind, data: unknown): Report => ({
    kind,
    generatedAt: iso(-15 * MIN),
    period: { fromSeconds: Math.floor(epoch(-30 * DAY) / 1000), toSeconds: Math.floor(now / 1000) },
    data,
    signature: DEMO_SIG,
  });
  const reports: Record<ReportKind, Report> = {
    "restore-tests": reportBase("restore-tests", {
      drills: drillEvidence.map((d) => ({ runId: d.runId, recordedAt: d.recordedAt, kind: d.kind })),
      // The restore-proven pipes carry a last-test stamp; cf-config + artifacts are honestly absent (neither
      // has been restore-tested yet), matching their "never proven" protection statement.
      lastTestByDownpipe: { [DP_LEDGER]: iso(-2 * DAY), [DP_PAYMENTS]: iso(-1 * DAY), [DP_STATEMENTS]: iso(-5 * DAY), [DP_SECRETS]: iso(-3 * DAY), [DP_WORKERS]: iso(-6 * DAY), [DP_STREAM]: iso(-9 * DAY) },
    }),
    "sla-compliance": reportBase("sla-compliance", {
      downpipes: [
        { id: DP_LEDGER, expectedRuns: 4, successfulRuns: 4, freshnessSeconds: 3 * HOUR / 1000, strikes: 0 },
        { id: DP_PAYMENTS, expectedRuns: 24, successfulRuns: 23, freshnessSeconds: 1 * HOUR / 1000, strikes: 1 },
        { id: DP_STATEMENTS, expectedRuns: 2, successfulRuns: 2, freshnessSeconds: 7 * HOUR / 1000, strikes: 0 },
        { id: DP_CFCONFIG, expectedRuns: 1, successfulRuns: 1, freshnessSeconds: 15 * HOUR / 1000, strikes: 0 },
        { id: DP_SECRETS, expectedRuns: 2, successfulRuns: 2, freshnessSeconds: 6 * HOUR / 1000, strikes: 0 },
        { id: DP_WORKERS, expectedRuns: 1, successfulRuns: 1, freshnessSeconds: 13 * HOUR / 1000, strikes: 0 },
        { id: DP_STREAM, expectedRuns: 1, successfulRuns: 1, freshnessSeconds: 17 * HOUR / 1000, strikes: 0 },
      ],
    }),
    immutability: reportBase("immutability", {
      destinations: [
        { id: DEST_PRIMARY, region: "ap-southeast-2", objectLock: "enforced", mode: "compliance", retentionDays: 2555 },
        { id: DEST_REPLICA, region: "us-east-1", objectLock: "enforced", mode: "compliance", retentionDays: 2555 },
        { id: DEST_COLD, region: "australiaeast", objectLock: "enforced", mode: "compliance", retentionDays: 2555 },
      ],
      breakGlassConfigured: true,
      operationalConfigured: { public: true, private: true },
    }),
    posture: reportBase("posture", { score: posture.score, checks: posture.checks }),
    // evidence-pack is parameterised by a framework id rather than served as a single card; this entry is
    // the "all frameworks" projection used when no specific framework is asked for.
    "evidence-pack": reportBase("evidence-pack", { framework: "all", score: posture.score, checkCount: posture.checks.length }),
    // change-requests is the change-management CR ledger: change-controlled actions with their change number,
    // who made each, and an Emergency Change flagged for retrospective review (the demo org has the policy on).
    "change-requests": reportBase("change-requests", {
      entries: [
        { ts: iso(-2 * DAY), actorEmail: "owner@northwind.example", actorMethod: "access", actionKind: "dest-put", changeNumber: "CHG0012001", emergency: false, reason: null },
        { ts: iso(-1 * DAY), actorEmail: "ops@northwind.example", actorMethod: "access", actionKind: "idp-conn-enabled", changeNumber: "CHG0012044", emergency: false, reason: null },
        { ts: iso(-6 * HOUR), actorEmail: "owner@northwind.example", actorMethod: "access", actionKind: "dest-remove", changeNumber: null, emergency: true, reason: "Primary bucket compromised; repointing under incident INC-4821." },
      ],
      total: 3,
      emergencyTotal: 1,
    }),
  };
  // The per-framework evidence packs (the customer-specific signed pack re-projected through each
  // framework's control mapping). Keyed by framework id; "all" is the combined projection. Seeded for the
  // three frameworks the tour highlights (CPS 230, SEC 17a-4, DORA) plus the ISO/27001 and Essential Eight
  // packs the evidence-packs screen lists, and "all".
  const packFrameworks = ["apra-cps-230-234", "sec-17a-4", "dora", "iso-27001", "essential-eight", "all"];
  const evidencePacks: Record<string, Report> = {};
  for (const fw of packFrameworks) {
    evidencePacks[fw] = reportBase("evidence-pack", { framework: fw, score: posture.score, checkCount: posture.checks.length, controlsMapped: posture.checks.length });
  }

  // Four-eyes / dual control is ON for the demo org (a finance-grade posture): every config change is
  // queued for a second approver, and high-blast owner actions queue for a second owner.
  const configApprovalPolicy: ConfigApprovalPolicy = { requireConfigApproval: true, requireChangeNumber: true };
  // 91 days (Quarterly), one of the five the console offers, so the demo shows a stated rhythm rather than
  // the 'Not stated' branch. A demo estate with no cadence would render an empty compliance story.
  const attendedCadenceDays = 91;

  // ---------------------------------------------------------------------------------------------
  // The remaining governance / proof-of-moat screen reads, so EVERY nav item in the publicly explorable
  // tour renders POPULATED and never surfaces an engine error. Each is the exact console wire shape the
  // matching screen's load read parses, seeded against the SAME Northwind entities (the owner ops@, the
  // maker priya.nair@, the checker daniel.cho@, the nine downpipes, the two destinations, the IdP
  // connections) so the world stays coherent across screens. The texture reads as a healthy, well-run
  // estate: present-but-honest data, one config change queued for a second approver, an alive canary, no
  // fabricated alarms beyond the deliberate posture/coverage imperfections already seeded above.
  // ---------------------------------------------------------------------------------------------

  // The canary backup: a synthetic write-read-verify probe flown to both destinations on a cadence. It is
  // ALIVE at both NOW (the healthy estate), but the flight history carries ONE earlier DEAD flight (it caught a
  // problem then recovered), so the recent-flights ring reads with honest texture rather than all-green theatre,
  // matching the deliberate failed RUN elsewhere in the seed.
  const canaryAspects = (): CanaryView["dests"][number]["lastCheck"] => ({
    at: iso(-18 * MIN),
    ok: true,
    status: "alive",
    durationMs: 2_300,
    destinationId: DEST_PRIMARY,
    runSeq: 412,
    aspects: [
      { key: "write-probe", outcome: "pass", detail: "A canary object was written to the archive prefix." },
      { key: "seal", outcome: "pass", detail: "The probe object sealed and signed cleanly." },
      { key: "read-signature", outcome: "pass", detail: "The sealed object's signature verified on read-back." },
      { key: "decrypt-integrity", outcome: "pass", detail: "The probe decrypted-and-verified to a discard sink." },
      { key: "delete-probe", outcome: "note", detail: "Delete is denied on a WORM bucket; the probe object ages out under the lifecycle rule." },
    ],
    byteDelta: 4_096,
    deadReason: null,
  });
  // A single DEAD flight in the history: the replica read-back signature check failed once (a transient
  // destination fault), so the canary died for that flight before recovering on the next. The reason is the
  // coarse, redaction-safe string the engine records (no value, no key, no real hash); it is the honest
  // "the canary caught a real problem" texture the demo wants visible alongside the green hero.
  const deadFlightCheck = (): CanaryCheck => ({
    at: iso(-9 * HOUR - 18 * MIN),
    ok: false,
    status: "dead",
    durationMs: 3_100,
    destinationId: DEST_REPLICA,
    runSeq: 409,
    aspects: [
      { key: "write-probe", outcome: "pass", detail: "A canary object was written to the archive prefix." },
      { key: "seal", outcome: "pass", detail: "The probe object sealed and signed cleanly." },
      { key: "read-signature", outcome: "fail", detail: "The read-back signature did not verify on the replica: the object returned did not match what was sealed." },
      { key: "decrypt-integrity", outcome: "skip", detail: "Skipped: the signature check already failed, so the bytes were not trusted to decrypt." },
      { key: "delete-probe", outcome: "skip", detail: "Skipped after the failure." },
    ],
    byteDelta: null,
    deadReason: "the replica read-back signature did not verify (a byte strayed from the known data)",
  });
  const canary: CanaryView = {
    config: { enabled: true, destinationIds: null, intervalSeconds: 3 * HOUR / 1000 },
    status: "alive",
    lastRunAt: iso(-18 * MIN),
    nextRunAt: epoch(3 * HOUR - 18 * MIN),
    inFlight: false,
    runSeq: 412,
    dests: [
      { destinationId: DEST_PRIMARY, label: "Primary (ap-southeast-2)", isDefault: true, status: "alive", lastRunAt: iso(-18 * MIN), deadSince: null, lastCheck: canaryAspects() },
      { destinationId: DEST_REPLICA, label: "Replica (us-east-1)", isDefault: false, status: "alive", lastRunAt: iso(-18 * MIN), deadSince: null, lastCheck: { ...canaryAspects()!, destinationId: DEST_REPLICA } },
      // The canary flies to ALL destinations (config.destinationIds is null), so the Azure one is flown to
      // as well. Leaving it out would have made flyingToAll a claim the rest of this view contradicts.
      { destinationId: DEST_COLD, label: "Cold copy (Azure, australiaeast)", isDefault: false, status: "alive", lastRunAt: iso(-18 * MIN), deadSince: null, lastCheck: { ...canaryAspects()!, destinationId: DEST_COLD } },
    ],
    history: [
      { at: iso(-18 * MIN), runSeq: 412, status: "alive", results: [canaryAspects()!, { ...canaryAspects()!, destinationId: DEST_REPLICA }, { ...canaryAspects()!, destinationId: DEST_COLD }] },
      { at: iso(-3 * HOUR - 18 * MIN), runSeq: 411, status: "alive", results: [{ ...canaryAspects()!, at: iso(-3 * HOUR - 18 * MIN), runSeq: 411 }] },
      { at: iso(-6 * HOUR - 18 * MIN), runSeq: 410, status: "alive", results: [{ ...canaryAspects()!, at: iso(-6 * HOUR - 18 * MIN), runSeq: 410 }] },
      // The one DEAD flight (honest texture): the replica read-back signature failed for flight 409 before the
      // canary recovered. The aggregate is dead because a destination died.
      { at: iso(-9 * HOUR - 18 * MIN), runSeq: 409, status: "dead", results: [{ ...canaryAspects()!, at: iso(-9 * HOUR - 18 * MIN), runSeq: 409 }, deadFlightCheck()] },
    ],
    // The picker's whole collection, so it must list every destination the world holds, the Azure one
    // included: a destination missing from here renders no checkbox and cannot be pinned.
    allDestinations: [
      { id: DEST_PRIMARY, label: "Primary (ap-southeast-2)", isDefault: true },
      { id: DEST_REPLICA, label: "Replica (us-east-1)", isDefault: false },
      { id: DEST_COLD, label: "Cold copy (Azure, australiaeast)", isDefault: false },
    ],
    destinationCount: 3,
    flyingToAll: true,
  };

  // The config change-control inbox: ONE pending change queued for a second approver (a notify-rule edit
  // raised by the maker), so the change-requests screen has a real item to review (maker != checker). The
  // proposer is the maker priya.nair@, distinct from the owner who would approve, so Approve is live in
  // free-explore. The diff is the engine's pre-rendered plain-English line (no value, no key).
  const configChanges: ConfigChange[] = [
    {
      id: "chg-notify-rule-7f3a",
      kind: "notify-rule-set",
      proposedBy: REQUESTER_EMAIL,
      proposedAt: iso(-40 * MIN),
      diff: [
        { kind: "added", area: "notify-rule", text: "Add a per-downpipe notify rule on the payments store: deliver backup-failure and replication-degraded events to the on-call PagerDuty channel." },
      ],
      status: "pending",
    },
  ];

  // The signed, hash-chained config version history: a short newest-first timeline of governance-config
  // versions, each committing to the exact posture at that version. The chain links cleanly (each version's
  // parentHash is the prior version's contentHash), so the verify badge reads INTACT. The hashes are plainly
  // illustrative fixtures, not real digests; the console renders them as opaque labels only.
  const cfgHash = (n: number): string => `sha384:demo-config-${String(n).padStart(4, "0")}`;
  const configHistory: ConfigHistory = {
    versions: [
      { id: 14, at: iso(-40 * MIN), author: REQUESTER_EMAIL, parentHash: cfgHash(13), contentHash: cfgHash(14), summary: "Notify rule queued for approval on the payments store." },
      { id: 13, at: iso(-3 * DAY), author: ORG_OWNER_EMAIL, parentHash: cfgHash(12), contentHash: cfgHash(13), summary: "Downpipe added: container registry (Artifact Registry)." },
      { id: 12, at: iso(-9 * DAY), author: ORG_OWNER_EMAIL, parentHash: cfgHash(11), contentHash: cfgHash(12), summary: "Downpipe added: payment gateway secrets (Secrets Store)." },
      { id: 11, at: iso(-30 * DAY), author: ORG_OWNER_EMAIL, parentHash: cfgHash(10), contentHash: cfgHash(11), summary: "Role granted: auditor@northwind.example set to viewer." },
      { id: 10, at: iso(-180 * DAY), author: ORG_OWNER_EMAIL, parentHash: "sha384:genesis", contentHash: cfgHash(10), summary: "Initial posture captured at first sign-in." },
    ],
    headId: 14,
    headHash: cfgHash(14),
    verify: { intact: true, checkedThrough: 14, earliestId: 10 },
  };

  // The RBAC role tables. Built-in roles: the owner, a named security lead (approver), an operator and a
  // viewer auditor, each granted by the owner. A group->role mapping (the IdP "finance-platform" group to
  // operator). One custom role (a recovery-only role) for the role builder to list. Redaction-safe: emails,
  // roles, granters and timestamps only.
  const roles: RoleEntry[] = [
    { email: ORG_OWNER_EMAIL, role: "owner", grantedBy: ORG_OWNER_EMAIL, grantedAt: iso(-180 * DAY) },
    { email: APPROVER_EMAIL, role: "approver", grantedBy: ORG_OWNER_EMAIL, grantedAt: iso(-150 * DAY) },
    { email: REQUESTER_EMAIL, role: "operator", grantedBy: ORG_OWNER_EMAIL, grantedAt: iso(-120 * DAY) },
    { email: "auditor@northwind.example", role: "viewer", grantedBy: ORG_OWNER_EMAIL, grantedAt: iso(-30 * DAY) },
    { email: "recovery-oncall@northwind.example", role: "viewer", grantedBy: ORG_OWNER_EMAIL, grantedAt: iso(-20 * DAY), customRole: "recovery-only" },
  ];
  const groupRoles: GroupRoleEntry[] = [
    { group: "finance-platform", role: "operator", grantedBy: ORG_OWNER_EMAIL, grantedAt: iso(-100 * DAY) },
    { group: "security-reviewers", role: "approver", grantedBy: ORG_OWNER_EMAIL, grantedAt: iso(-90 * DAY) },
  ];
  const customRoles: CustomRole[] = [
    {
      name: "recovery-only",
      label: "Recovery only",
      capabilities: ["downpipe.read", "restore.dryrun", "restore.verify", "restore.request", "drill.run", "reports.read", "posture.read", "audit.read"],
      surface: { runs: "read", restore: "edit", reports: "read", security: "read", destinations: "read" },
      presentation: "technical",
      landing: "restore",
      createdBy: ORG_OWNER_EMAIL,
      createdAt: iso(-20 * DAY),
    },
  ];

  // The notifications config: two delivery channels (an email channel to the platform team + a PagerDuty
  // routing key for on-call), two routing rules (a global critical rule + a per-downpipe rule on payments),
  // and a short delivery-history ring with both an info success and a critical failure delivery (honest
  // texture). Redaction-safe: a routing key / address is the customer's own config, never a secret value.
  const notifyChannels: NotifyChannel[] = [
    { id: "01JCHANNELEMAILPLATFORM00", kind: "email", name: "Platform team (email)", toAddresses: ["platform-alerts@northwind.example"], enabled: true, createdAt: iso(-160 * DAY) },
    { id: "01JCHANNELPAGERDUTYONCALL0", kind: "pagerduty", name: "On-call (PagerDuty)", routingKey: "demo-pd-routing-key-not-a-secret", enabled: true, createdAt: iso(-140 * DAY) },
    { id: "01JCHANNELSLACKBACKUPS0000", kind: "slack", name: "#backups (Slack)", url: "https://hooks.slack.example/services/demo/northwind/backups", enabled: false, createdAt: iso(-70 * DAY) },
    // Monitoring integrations (PLAN.md): jsm and servicenow, showcasing the two new
    // incident channels. apiKeyPresent:true mirrors the engine's redacted read (the credential
    // itself is write-only and never returned); no secret value appears here or anywhere else.
    { id: "01JCHANNELJSMONCALL000000", kind: "jsm", name: "On-call (JSM/Opsgenie)", url: "https://api.opsgenie.com/v2/alerts", apiKeyPresent: true, enabled: true, createdAt: iso(-40 * DAY) },
    { id: "01JCHANNELSERVICENOWEVENT0", kind: "servicenow", name: "ServiceNow Event Management", url: "https://northwind.service-now.com/api/now/table/em_event", username: "downpipes-integration", apiKeyPresent: true, enabled: true, createdAt: iso(-25 * DAY) },
  ];
  const notifyRules: NotifyRule[] = [
    // Two paging tools run in parallel during the JSM migration (a realistic transitional state),
    // alongside the existing PagerDuty + email routing.
    { id: "01JRULEGLOBALCRITICAL00000", scope: { kind: "global" }, minSeverity: "critical", events: ["backup-failure", "restore-test-fail", "posture-regression"], channelIds: ["01JCHANNELPAGERDUTYONCALL0", "01JCHANNELEMAILPLATFORM00", "01JCHANNELJSMONCALL000000"], enabled: true },
    { id: "01JRULEGLOBALWARNDIGEST000", scope: { kind: "global" }, minSeverity: "warning", events: ["credential-expiry", "backup-stale", "replication-degraded"], channelIds: ["01JCHANNELEMAILPLATFORM00"], digest: "daily", enabled: true },
    { id: "01JRULEPAYMENTSCRITICAL000", scope: { kind: "downpipe", downpipeId: DP_PAYMENTS }, minSeverity: "warning", events: ["backup-failure", "replication-degraded"], channelIds: ["01JCHANNELPAGERDUTYONCALL0"], enabled: true },
  ];
  const notifyHistory: NotifyHistoryEntry[] = [
    // A recorded manual test-send (flagged test:true): the durable trace that a channel was verified.
    { seq: 319, ts: iso(-30 * MIN), event: "backup-success", severity: "info", downpipeId: null, channelId: "01JCHANNELPAGERDUTYONCALL0", channelKind: "pagerduty", delivered: true, detail: "downpipe test notification (no action required)", test: true },
    { seq: 318, ts: iso(-1 * HOUR), event: "backup-success", severity: "info", downpipeId: DP_LEDGER, channelId: "01JCHANNELEMAILPLATFORM00", channelKind: "email", delivered: true, detail: "General ledger (D1): run 9 sealed and verified." },
    { seq: 317, ts: iso(-2 * HOUR), event: "replication-degraded", severity: "warning", downpipeId: DP_PAYMENTS, channelId: "01JCHANNELPAGERDUTYONCALL0", channelKind: "pagerduty", delivered: true, detail: "Payments store (KV): the us-east-1 replica is one run behind." },
    { seq: 316, ts: iso(-2 * HOUR), event: "backup-failure", severity: "critical", downpipeId: DP_PAYMENTS, channelId: "01JCHANNELPAGERDUTYONCALL0", channelKind: "pagerduty", delivered: true, detail: "Payments store (KV): run 40 failed on the replica WORM list check." },
    { seq: 315, ts: iso(-3 * DAY), event: "restore-test-pass", severity: "info", downpipeId: DP_SECRETS, channelId: "01JCHANNELEMAILPLATFORM00", channelKind: "email", delivered: true, detail: "Payment gateway secrets: blind restore test passed." },
    { seq: 314, ts: iso(-21 * DAY), event: "credential-expiry", severity: "warning", downpipeId: null, channelId: "01JCHANNELEMAILPLATFORM00", channelKind: "email", delivered: true, detail: "Okta SAML signing certificate expires in 21 days." },
  ];

  // The dual-control owner-action inbox: ONE pending high-blast owner action (a new replica destination the
  // maker proposed) awaiting a SECOND owner. The summary is the engine's redaction-safe pre-rendered line
  // (host/bucket/region only, NEVER the secret). proposedBy is the maker, distinct from the owner-approver.
  const ownerActions: OwnerAction[] = [
    {
      id: "oa-dest-put-3c9d",
      kind: "dest-put",
      summary: "Add a third archive destination: an S3 cold tier in eu-west-1 (bucket northwind-archive-euw1), WORM compliance mode, 7-year retention.",
      proposedBy: REQUESTER_EMAIL,
      proposedBySubject: "demo|northwind-operator",
      proposedAt: iso(-55 * MIN),
      expiresAt: iso(23 * HOUR),
      status: "pending",
    },
  ];

  // The enrolled-passkey inventory: two registered passkeys for the signed-in owner (a platform
  // authenticator and a roaming security key). REDACTION-SAFE by construction: an opaque base64url
  // credential id, the device-family aaguid, advisory transports and the COSE algorithm id; never a key.
  const passkeyCredentials: PasskeyCredentialSummary[] = [
    { credentialId: "ZGVtby1jcmVkLXBsYXRmb3JtLW93bmVyLWF1dGhlbnRpY2F0b3I", createdAt: iso(-180 * DAY), aaguid: "ZGVtby1hYWd1aWQtcGxhdGZvcm0", transports: ["internal", "hybrid"], alg: -7 },
    { credentialId: "ZGVtby1jcmVkLXJvYW1pbmctc2VjdXJpdHkta2V5LW93bmVy", createdAt: iso(-60 * DAY), aaguid: "ZGVtby1hYWd1aWQtcm9hbWluZw", transports: ["usb", "nfc"], alg: -8 },
  ];

  // The key-vintage inventory: the demo org rotated its break-glass key once, so archives split into two
  // vintages. The old one is NOT held by the engine any more, which is exactly the state the surface exists
  // to make visible. Fingerprints are illustrative public dpr1:/edmldsa1: strings, never a key half.
  const keyVintages: KeyVintageInventory = {
    current: { breakGlass: "dpr1:9f2c4a71b6d8e035", operational: null, signer: "edmldsa1:5c81a7f0d3b94e26" },
    okRunCount: 214,
    readableRunCount: 214,
    truncated: false,
    historyReadOk: true,
    vintages: [
      { fingerprint: "dpr1:9f2c4a71b6d8e035", role: "break-glass", runCount: 181, isCurrent: true },
      { fingerprint: "dpr1:3ab7c05e91f4d872", role: "break-glass", runCount: 33, isCurrent: false },
    ],
    stranded: { runCount: 33, byVintage: [{ fingerprint: "dpr1:3ab7c05e91f4d872", role: "break-glass", runCount: 33 }], unknownCount: 0 },
    signer: { current: "edmldsa1:5c81a7f0d3b94e26", brokenRunCount: 0, currentRunCount: 214 },
    currentBreakGlassRunCount: 181,
    operationalSoleAccessRunCount: 0,
  };

  // The supportability status: the key ceremony has run (signed bundles) and the vendor seal is configured,
  // with NO active per-scope ingest credential (the healthy default; a grant is minted only during a ticket).
  const support: SupportStatus = {
    vendorSealConfigured: true,
    signerConfigured: true,
    accessPerimeter: true,
    diagnostics: null,
    auditFeed: {
      clientId: "demo-audit-feed-client-id",
      scope: "audit-feed",
      grantedAt: iso(-45 * DAY),
      grantedBy: ORG_OWNER_EMAIL,
      expiresAt: iso(320 * DAY),
      expired: false,
      pulls: [{ at: iso(-2 * DAY) }, { at: iso(-1 * DAY) }],
    },
    // The metrics scrape credential (monitoring integrations, PLAN.md): active and
    // recently pulled at a scrape-like cadence (minutes apart), in deliberate contrast with the
    // audit feed's daily cadence above, so the demo shows a Prometheus/Grafana agent actively polling.
    metrics: {
      clientId: "demo-metrics-client-id",
      scope: "metrics",
      grantedAt: iso(-60 * DAY),
      grantedBy: ORG_OWNER_EMAIL,
      expiresAt: iso(305 * DAY),
      expired: false,
      pulls: [{ at: iso(-3 * MIN) }, { at: iso(-2 * MIN) }, { at: iso(-1 * MIN) }],
    },
  };

  // The SIEM audit-log push destination: configured, enabled and fully caught up (lastPushedSeq == headSeq),
  // with a short, healthy delivery trail, over the http sink to a generic NDJSON intake (seq 4096-4220). It
  // leads with ndjson over http on purpose, so the demo reads generic-first (the split-friendly default the
  // coverage work made the default), not tied to any one vendor. This is a deliberate contrast with
  // support.accessPerimeter (true) above: the pull credential's mint UI warns that Cloudflare Access blocks
  // the collector, while this destination is quietly succeeding, because the engine dials OUT to it. Owner-set,
  // matching the dest-put pattern's owner-only posture.
  // Seeded as Splunk (splunk-hec over http), a recognisable, auto-parsing SIEM, so the Integrations tour shows a
  // clear "Splunk is active, every other SIEM tile reads Set up" story (the audit push is a single destination).
  const push: PushDestinationView = {
    present: true,
    sink: "http",
    endpoint: "https://http-inputs.northwind.splunkcloud.example/services/collector/event",
    format: "splunk-hec",
    authHeaderName: "Authorization",
    enabled: true,
    setBy: ORG_OWNER_EMAIL,
    setAt: iso(-18 * DAY),
    lastPushedSeq: 4220,
    headSeq: 4220,
    trail: [
      { at: iso(-8 * HOUR), ok: true, httpStatus: 202, count: 3, fromSeq: 4211, toSeq: 4213 },
      { at: iso(-6 * HOUR), ok: true, httpStatus: 202, count: 2, fromSeq: 4214, toSeq: 4215 },
      { at: iso(-4 * HOUR), ok: true, httpStatus: 202, count: 3, fromSeq: 4216, toSeq: 4218 },
      { at: iso(-2 * HOUR), ok: true, httpStatus: 202, count: 1, fromSeq: 4219, toSeq: 4219 },
      { at: iso(-1 * HOUR), ok: true, httpStatus: 202, count: 1, fromSeq: 4220, toSeq: 4220 },
    ],
  };

  // The safe-apply update lifecycle record: no apply is mid-flight (the engine is current), and the last
  // completed action is a clean apply, so the Updates screen reads calm. Redaction-safe: version ids, an
  // outcome enum, who/when only.
  const updateStatusRecord: UpdateStatusRecord = {
    pending: null,
    last: { outcome: "applied", recommendedVersion: "1.0.0", fromVersion: "0.9.6", toVersion: "1.0.0", canaryVerdict: "alive", at: iso(-45 * DAY), by: ORG_OWNER_EMAIL },
    rollbackNeeded: null,
  };

  // The source-discovery view (the add-source wizard's catalogue): the BOUND tier (the engine's own
  // bindings) plus the opt-in ACCOUNT tier with the customer's read-only token present, so the wizard shows
  // discoverable KV/R2/D1/Secrets and the account-wide source rows. engineAccountId marks the account
  // stanzas can bind in. No value, key or token transits (ids + names only); the token is never echoed.
  const ACCT_ID = DEMO_ACCT_ID;
  const sourceDiscovery: SourceDiscovery = {
    bound: { kv: ["PAYMENTS_KV"], r2: ["STATEMENTS_R2"], d1: ["LEDGER_DB"], secrets: ["GATEWAY_SECRETS"] },
    tokenPresent: true,
    engineAccountId: ACCT_ID,
    accounts: [demoDiscoveredAccount()],
    // A five-entry sample of the real registry's wire shape, not the whole catalogue. The ids,
    // labels and tiers are the engine's own, so the demo cannot teach a vocabulary the product
    // does not use: the tier is idempotent / ordered / reprovision, never "auto" or "manual".
    // The tier says how cleanly a surface replays, which is a different axis from whether
    // downpipes re-applies it in-band, so it must not be read as an auto-restore flag. inBand is that
    // second axis, and each value below matches the engine's PROVEN_WRITE_SURFACES for that id: the demo
    // must not show a surface restoring in console when the real product does not. Three of these five
    // are in band, which is roughly the real ratio and is the point of seeding a mixed set.
    cfConfigSurfaces: [
      { id: "dns", label: "DNS records", category: "DNS & core", scope: "zone", restoreTier: "idempotent", inBand: true },
      { id: "page-rules", label: "Page rules", category: "Security & WAF", scope: "zone", restoreTier: "idempotent", inBand: true },
      { id: "rulesets", label: "WAF & rulesets (zone)", category: "Security & WAF", scope: "zone", restoreTier: "idempotent", inBand: true },
      { id: "workers-routes", label: "Workers routes", category: "Traffic & delivery", scope: "zone", restoreTier: "ordered", inBand: false },
      { id: "account-members", label: "Account members", category: "Account access", scope: "account", restoreTier: "reprovision", inBand: false },
      // Two account-scoped surfaces that ARE in band. Before these, the seed had exactly one account
      // surface and it was not in band, so the account-scoped picker (which is what the seeded cf-config
      // downpipe renders, it has an accountId and no zone) showed a single row and truthfully reported
      // "0 of the 1 re-apply". Correct, but it exercised only one side of the split and could not have
      // caught a console that marked nothing at all. scope, tier and inBand here all match the engine.
      { id: "account-rulesets", label: "WAF & rulesets (account)", category: "Account settings & rules", scope: "account", restoreTier: "idempotent", inBand: true },
      { id: "access-tags", label: "Access tags", category: "Zero Trust", scope: "account", restoreTier: "idempotent", inBand: true },
      // Two AVAILABLE surfaces: a write path exists and has not been proven, so the engine leaves it off
      // by default. Seeded because the picker renders a distinct badge for this state and, without an
      // instance of it, that branch was unreachable in the demo and in every journey that drives the
      // demo. A seed that only contains the two easy states cannot catch a console that collapses three
      // states into two. Both values match the engine catalogue and the parity gate asserts it.
      { id: "waiting-rooms", label: "Waiting rooms", category: "Traffic & delivery", scope: "zone", restoreTier: "idempotent", inBand: false, available: true },
      { id: "dlp-profiles-custom", label: "DLP profiles (custom)", category: "Zero Trust", scope: "account", restoreTier: "idempotent", inBand: false, available: true },
    ],
    workersSupported: true,
    streamSupported: true,
    imagesSupported: true,
    artifactsSupported: true,
    // The token-authenticated source types the owner has ADDED on the Sources screen. cf-config / workers /
    // stream have seeded downpipes (covered, green). Artifact Registry is added but has NO downpipe yet, so
    // the coverage hero shows it amber (the actionable gap). Images is deliberately ABSENT here (not added),
    // so the hero shows it slate (not added). This gives the Overview a realistic green/amber/slate mix
    // instead of an all-green wall. The create wizard offers only added types.
    addedSources: ["cf-config", "workers", "stream", "artifacts"],
  };

  // The onboarding estate-size estimate: the engine sized the data sources from Cloudflare storage analytics
  // (no value reads), so the cost screen shows a real figure. Counts + bytes only; D1 sizes as unavailable
  // (analytics does not expose it), which is the honest provenance the screen renders.
  const estateSize: EstateSizeReport = {
    totalBytes: 53_687_091_200,
    totalCount: 9,
    sizedSources: 7,
    sourceCount: 9,
    available: true,
    perSource: [
      { bytes: 96_337_408, count: 184_220, basis: "unavailable" },
      { bytes: 18_220_032, count: 52_140, basis: "analytics" },
      { bytes: 5_812_183_040, count: 9_410, basis: "analytics" },
      { bytes: 1_318_912, count: 314, basis: "analytics" },
      { bytes: 24_576, count: 18, basis: "analytics" },
      { bytes: 31_457_280, count: 42, basis: "analytics" },
      { bytes: 41_104_179_200, count: 318, basis: "analytics" },
      { bytes: 6_442_450_944, count: 12_840, basis: "analytics" },
      { bytes: 2_684_354_560, count: 96, basis: "analytics" },
    ],
  };

  // The preflight entitlement / prerequisite report: a healthy estate where every probe-able prerequisite is
  // VERIFIED by observation and the one platform-gated item (the Workers paid plan) is honestly "configured"
  // (present, not re-probed). Redaction-safe evidence prose only; never a value or a key.
  const preflight: PreflightReport = {
    generatedAt: iso(-12 * MIN),
    engineVersion: "1.0.0",
    summary: { required: 7, requiredVerified: 7, failed: 0 },
    items: [
      { id: "durable-objects", name: "Durable Objects reachable", requires: "Cloudflare Workers (Durable Objects)", required: true, status: "verified", evidence: "The scheduler Durable Object responded to a liveness probe." },
      { id: "cron", name: "Scheduled cron is ticking", requires: "Cloudflare Workers (cron triggers)", required: true, status: "verified", evidence: "A cron tick was observed within the expected interval." },
      { id: "destination", name: "Archive destination reachable", requires: "An S3-compatible destination", required: true, status: "verified", evidence: "The primary (ap-southeast-2) and the replica (us-east-1) both verified within the hour." },
      { id: "keys", name: "Signing + sealing keys parse", requires: "The key ceremony", required: true, status: "verified", evidence: "The post-quantum hybrid key material parsed and the signer is configured." },
      { id: "zero-trust", name: "Zero Trust team domain set", requires: "Cloudflare Access", required: true, status: "verified", evidence: "The Access team domain resolved and the owner is a verified identity." },
      { id: "seal-do", name: "Seal Durable Object reachable", requires: "Cloudflare Workers (Durable Objects)", required: true, status: "verified", evidence: "The per-downpipe seal DO accepted a slice and reported progress." },
      { id: "licence", name: "Licence tier is enterprise", requires: "A licence token", required: true, status: "verified", evidence: "The enterprise licence is valid and fail-open." },
      { id: "workers-plan", name: "Workers paid plan", requires: "Cloudflare Workers (paid plan, deploy-time)", required: false, status: "configured", evidence: "The Workers paid plan is a deploy-time gate the engine cannot re-probe at runtime; it is configured.", remediation: "Confirm the account is on the Workers paid plan if a large-estate run is ever throttled." },
    ],
  };

  return {
    whoami,
    status,
    setupState,
    licence,
    updates,
    downpipes,
    historyByDownpipe: {
      [DP_LEDGER]: ledgerRuns,
      [DP_PAYMENTS]: paymentsRuns,
      [DP_STATEMENTS]: statementsRuns,
      [DP_CFCONFIG]: cfConfigRuns,
      [DP_SECRETS]: secretsRuns,
      [DP_WORKERS]: workersRuns,
      [DP_STREAM]: streamRuns,
    },
    destinations,
    destinationDefault: primaryDest,
    replicationByDownpipe,
    idpConnections,
    idpProviders,
    idpPresets,
    drillEvidence,
    audit,
    approvals,
    restorePlan,
    posture,
    coverage,
    expiry,
    rto,
    reports,
    evidencePacks,
    configApprovalPolicy,
    attendedCadenceDays,
    canary,
    configChanges,
    configHistory,
    roles,
    groupRoles,
    customRoles,
    notifyChannels,
    notifyRules,
    notifyHistory,
    ownerActions,
    passkeyCredentials,
    keyVintages,
    support,
    push,
    updateStatusRecord,
    sourceDiscovery,
    estateSize,
    preflight,
    changeSeq: 0,
    attestSessions: {},
    settleQueue: {},
  };
}
