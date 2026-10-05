// The shared types of the headless setup model: engine FACTS (read from the engine, never stored) and the
// local DRAFT (the user's answers so far). Kept apart from model.ts and steps.ts so both import them
// without a cycle.

import type { DestinationStatus, DownpipeState, RunHistoryEntry, SetupState } from "../api/types.ts";
import type { Provider } from "../api/types/destinations.ts";
import type { PostureChoice } from "../posture-ack-statements.ts";
import type { CustodyScheme } from "../custody.ts";
import type { ApplyRoute, CustomRetention, ImmutabilityMode, RestoreApprovalId, RestoreTestId, RetentionId, ScheduleId, TokenScope } from "./inventory.ts";

// The eight main steps in CONTRACT order, then the two optional ones (reached from Finish).
export type SetupStepId = "welcome" | "connect" | "destination" | "protect" | "keys" | "apply" | "backup" | "finish" | "team" | "approval";

// Where a resource can come from. Binding kinds need an engine binding (attached at Apply with the deploy
// token); token kinds are read with the discovery token and need no binding.
export type BindingKind = "kv" | "r2" | "d1" | "secrets";
export type TokenKind = "cf-config" | "workers" | "stream" | "images";
export type PickKind = BindingKind | TokenKind;

// One resource the user can protect, with the user's own name first. `binding` is the SRC_* name the engine
// would bind it under (secondary text only). `key` is stable across reloads (kind:account:id).
export interface Resource {
  key: string;
  kind: PickKind;
  name: string;
  accountId: string;
  accountName: string;
  // kv: namespace id; d1: database id; secrets: store id; cf-config: zone id when zone scoped.
  id?: string;
  // Binding kinds only: the SRC_* binding the engine uses (account.ts bindingFor naming).
  binding?: string;
  // Secrets only: the secret's name in its store.
  secretName?: string;
  // True when this resource's binding is already live on the engine.
  bound: boolean;
  // A token kind the engine does not advertise (discovery *Supported flags) or the token cannot read.
  unavailable?: string;
}

// The resources grouped by type in one flat list (CONTRACT step 3), in this group order.
export interface ResourceGroup {
  kind: PickKind;
  label: string;
  resources: Resource[];
}

// A binding resource added by its id, for a resource discovery does not list (a token that cannot see it).
export interface ManualResource {
  kind: BindingKind;
  // KV: an optional display name (the namespace id otherwise); R2: the bucket; D1: the database; secrets: the secret.
  name: string;
  // KV: namespace id; D1: database id; secrets: store id.
  id?: string;
}

export interface DiscoveredAccountView {
  id: string;
  name: string;
  isEngineAccount: boolean;
}

// The engine reads behind the facts. A refresh records which of them failed, so the shell's gate can stay
// open when a verdict would rest on a read that did not land (lib/setup-state.ts setupViewOf).
export type FactRead = "setup-state" | "discovery" | "destination" | "downpipes" | "approval-policy" | "status";

// FACTS: everything the model read from the engine. `null` = not read yet or the read failed (fail-open:
// an unreadable fact never marks a step done or locked on its own).
export interface SetupFacts {
  setup: SetupState | null;
  tokenPresent: boolean | null;
  accounts: DiscoveredAccountView[];
  // When discovery last answered (0 = not yet in this tab). Until it has, the account list is unknown and the
  // Connect step trusts the engine's own token fact: a real engine refuses a token that sees no account
  // (engine src/admin/router-discovery.ts, POST /sources/discovery-token).
  discoveryReadAt: number;
  engineAccountId: string | null;
  // R2 buckets in the engine's own account, from discovery (the destination bucket list).
  engineR2Buckets: string[];
  groups: ResourceGroup[];
  destinations: DestinationStatus[];
  downpipes: DownpipeState[];
  // Run rings for the downpipes the setup created, keyed by downpipe id.
  runs: Record<string, RunHistoryEntry[]>;
  // Whether the engine holds keys (signer and break-glass), from setup-state.
  keysReady: boolean;
  // The posture keys already on the engine set (GET /admin/status operationalConfigured): "operational" when
  // it holds both halves of the operational pair, else "break-glass-only". null until status is read, and
  // while the engine holds no keys. deploy.sh makes keys before the console first loads, so a first run can
  // find them already in place (see effectivePosture in steps.ts).
  enginePosture: PostureChoice | null;
  // The engine's version, from the same status read (null until read).
  engineVersion: string | null;
  // GET /admin/config/approval-policy requireRestoreApproval (null when not reported).
  restoreApproval: boolean | null;
  // Last read time and the last read error, for a UI's "could not reach your engine" line.
  readAt: number;
  // When the last FULL read ran (0 = never in this tab). The shell's reads set readAt too, but they read no
  // resource list, so the setup page reads in full whenever this is 0.
  fullReadAt: number;
  readError: string | null;
  // When each read last answered (absent: not yet in this tab), and which reads failed on the last refresh.
  readsAt: Partial<Record<FactRead, number>>;
  failedReads: FactRead[];
}

// DRAFT: the user's answers. Non-secret only: no token, no credential, no key material ever lives here
// (model.ts persists it to sessionStorage).
export interface SetupDraft {
  started: boolean;
  tokenScope: TokenScope | null;
  // Destination (credentials are NOT here: saveDestination takes them as arguments and drops them).
  provider: Provider;
  bucket: string;
  bucketTyped: boolean;
  otherAccount: boolean;
  r2AccountId: string;
  endpoint: string;
  region: string;
  addressing: "auto" | "path" | "vhost";
  storageClass: string;
  label: string;
  immutability: ImmutabilityMode;
  immutabilityDays: string;
  roleArn: string;
  stsDuration: string;
  entraTenantId: string;
  entraClientId: string;
  // Storage prices for the cost estimate. null sends the provider preset (inventory.ts pricingDefaults);
  // a value sends these rates as the operator's own (DestinationPricing source "operator").
  pricing: { storagePerGBMonth: number; classAPerMillion: number; classBPerMillion: number; egressPerGB: number } | null;
  // Protect: the picked resource keys (Resource.key).
  picks: string[];
  // True once the engine's own bindings were adopted as the picks (model.ts seedBoundPicks), so they are
  // adopted once and an untick sticks.
  boundSeeded: boolean;
  // Binding resources the user added by id (non-secret identifiers), listed in Protect beside discovery's.
  manual: ManualResource[];
  // Stream and Images picks (Resource.key) whose downpipe also copies the media bytes, not only the list.
  mediaContent: string[];
  // Keys.
  posture: PostureChoice | null;
  postureAcknowledged: boolean;
  postureRecorded: boolean | null;
  // The engine's reason when it did not record the statement (its own refusal text and status), shown as written.
  postureRefusal: string | null;
  postureHashPrefix: string | null;
  custody: Exclude<CustodyScheme, "undecided"> | null;
  splitShares: number;
  splitThreshold: number;
  keysGenerated: boolean;
  refusedFiles: string[];
  keysSaved: boolean;
  // The engine accepted the key install in this setup (POST /admin/keys/install answered ok). The tab drops the
  // key material at that moment, so a wait that runs out before the engine reports the keys is retried by
  // waiting again, never by making new keys.
  keysSent: boolean;
  // A key install was sent and no answer came back (a lost response, or the version rollout the install itself
  // causes). Before the keys are sent again, Apply asks the engine whether it holds them.
  keysInstallUnconfirmed: boolean;
  // What the engine reported about encrypting the credentials it stored before the keys existed, from the key
  // install's answer (KeyInstallResult.rewrap). null: this setup did not install keys through the console, or the
  // engine did not report it. Finish reads it: "protected" needs every saved credential encrypted.
  rewrap: { ok: boolean; wrapped: number; leftPlaintext: number; failedClasses: string[] } | null;
  // The user's tick at Finish: they saved those credentials again after the keys existed (each save encrypts).
  credentialsResaved: boolean;
  possession: "match" | "mismatch" | null;
  // Apply.
  applyRoute: ApplyRoute;
  deployTokenUsed: boolean;
  // How many times a pasted deploy token reached the engine. Each "Paste another token" can be a new token, so
  // the revoke instruction asks for every one.
  deployTokenUses: number;
  deployTokenRevoked: boolean;
  // Backup.
  // The downpipe name the user typed for a pick (Resource.key to name). Absent keeps the resource's own name.
  names: Record<string, string>;
  schedule: ScheduleId;
  retention: RetentionId;
  // The operator's own retention (runs to keep, days to keep, enforce deletion), the downpipe editor's
  // fields. When set it replaces the preset in `retention`. Operational posture only (inventory.ts).
  retentionCustom: CustomRetention | null;
  restoreTest: RestoreTestId | null;
  createdDownpipeIds: string[];
  // The first run the first backup watches (the first of the runs the last Run now started); the receipt names it.
  firstRun: { downpipeId: string; runId: string } | null;
  // Every run the last Run now started, one per downpipe. The run view watches these, in this tab or a new one.
  startedRuns: Array<{ downpipeId: string; runId: string }>;
  // Each downpipe the last Run now did not start, with the reason: the engine's refusal, or a run it skipped.
  // The run view names them, and "Run it again" starts them again.
  notStarted: Array<{ downpipeId: string; reason: string }>;
  // Optional steps.
  teamSkipped: boolean;
  grants: Array<{ email: string; role: string; queued: boolean }>;
  restoreApproval: RestoreApprovalId | null;
}

// Runtime state that must NOT survive a reload: whether this tab holds unbanked key material.
export interface SetupRuntime {
  ceremonyHeld: boolean;
}

export type StepStatus = "done" | "current" | "available" | "locked";

export interface StepView {
  id: SetupStepId;
  label: string;
  route: string;
  optional: boolean;
  status: StepStatus;
  // Plain text: why a locked step is locked, or what an available step still lacks. Absent when done.
  reason?: string;
}

export interface SetupSnapshot {
  facts: SetupFacts;
  draft: SetupDraft;
  runtime: SetupRuntime;
  steps: StepView[];
  // The first unfinished main step (where "resume" lands).
  current: SetupStepId;
  // True once the first run is sealed and verified: only now may a UI say "protected".
  protectedNow: boolean;
  // True once, in this page's life, the shell counted setup complete (steps.ts shellComplete). The shell never
  // gates again after that, whatever a later read says.
  completeSeen: boolean;
  loading: boolean;
}
