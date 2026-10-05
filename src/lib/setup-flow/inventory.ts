// The first-run OPTION CATALOGUE as data. Every setup UI (the reference walk and concepts A, B and C)
// presents these options, in this order, with these one-line consequences, so the three designs differ in
// presentation only. Each block cites the file:line the values come from; when the source changes, change
// the citation with it.
//
// Nothing here renders and nothing here calls the engine. Consequence lines are plain text for a UI to set
// through textContent. The posture statements are quoted BY REFERENCE (POSTURE_ACK_STATEMENTS), never
// copied, because the engine hashes the exact bytes.

import type { Provider } from "../api/types/destinations.ts";
import type { Role } from "../identity.ts";
import { POSTURE_ACK_STATEMENTS, type PostureChoice } from "../posture-ack-statements.ts";
import { SCHEME_OPTIONS, MAX_SHARES, MIN_SHARES, MIN_THRESHOLD, type CustodyScheme } from "../custody.ts";
import { PRESETS } from "../cost-model-rates.ts";

// An option a context cannot support stays visible with its reason (CONTRACT "Every option must be
// presented"): `unavailable` is that reason as visible text, absent when the option is available.
export interface Choice<T extends string> {
  id: T;
  label: string;
  consequence: string;
  unavailable?: string;
}

// ---- Connect: the read-only discovery token -----------------------------------------------------------
// screens/sources/token-help.ts:18-60 (tokenHelp). The two scopes are PEERS: the dashboard template and the
// minimal custom token. Both are read-only.
export type TokenScope = "read-all" | "minimal";
export const TOKEN_SCOPES: readonly Choice<TokenScope>[] = [
  {
    id: "read-all",
    label: "Read all resources",
    consequence: "One dashboard template. Covers your data and your Cloudflare configuration, so configuration backup works too.",
  },
  {
    id: "minimal",
    label: "Minimal, data only",
    consequence: "Five read permissions. Configuration, Workers, Stream and Images backup stay unavailable until you widen it.",
  },
];
// The five permissions of the minimal token, each Account-type and Read (token-help.ts:20-30).
export const MINIMAL_TOKEN_PERMISSIONS: readonly string[] = [
  "Account Settings : Read",
  "Workers KV Storage : Read",
  "Workers R2 Storage : Read",
  "D1 : Read",
  "Secrets Store : Read",
];
// The demo engine's training sentinels (lib/demo/demo-routes-write-firstrun.ts:18-37): any other value verifies.
export const DEMO_TOKEN_SENTINELS = { refused: "training-bad-token", zeroAccounts: "training-empty-scopes" } as const;

// ---- Destination ------------------------------------------------------------------------------------
// Provider ids and labels: screens/destination-form-fields.ts:33-38 (PROVIDERS). Object Lock lines:
// WORM_PREREQ_COPY :634-639. Egress: lib/cost-model-rates.ts:86-90 (PRESETS; R2 egress 0). Off-account is
// the fact the engine's own posture check grades (engine src/admin/posture-checks.ts off-account checks):
// an R2 bucket in the engine's account shares the account's blast radius.
export interface ProviderInfo {
  id: Provider;
  label: string;
  offAccount: string;
  objectLock: string;
  objectLockSupported: boolean;
  egress: string;
  // The credential the form asks for (destination-form-fields.ts:675-705 applyFieldCopy).
  credentialLabels: { keyId: string; secret: string };
}
export const PROVIDERS_INFO: readonly ProviderInfo[] = [
  {
    id: "r2",
    label: "Cloudflare R2",
    offAccount: "Same Cloudflare account as the engine unless you name another account.",
    objectLock: "R2 cannot enforce S3 Object Lock, so immutability is refused for R2.",
    objectLockSupported: false,
    egress: "No egress fees.",
    credentialLabels: { keyId: "Access Key ID", secret: "Secret Access Key" },
  },
  {
    id: "s3",
    label: "S3-compatible",
    offAccount: "Off your Cloudflare account.",
    objectLock: "Object Lock works only on a bucket created with it.",
    objectLockSupported: true,
    egress: "Your provider may charge egress.",
    credentialLabels: { keyId: "Access Key ID", secret: "Secret Access Key" },
  },
  {
    id: "gcs",
    label: "Google Cloud",
    offAccount: "Off your Cloudflare account.",
    objectLock: "Needs a bucket created with per-object retention.",
    objectLockSupported: true,
    egress: "Google charges egress.",
    credentialLabels: { keyId: "Access Key ID (HMAC)", secret: "Secret (HMAC)" },
  },
  {
    id: "azure",
    label: "Azure Blob",
    offAccount: "Off your Cloudflare account.",
    objectLock: "Needs version-level immutability, which you can turn on at any time.",
    objectLockSupported: true,
    egress: "Azure charges egress.",
    credentialLabels: { keyId: "Storage account name", secret: "Access key, SAS or client secret" },
  },
];

// Immutability modes: destination-form-fields.ts:805-811 (buildWormBlock). Days: a whole number of at least 1
// (destination-submit.ts parseWormPolicy). R2 shows the non-off modes as unavailable (immutabilityChoices).
export type ImmutabilityMode = "off" | "governance" | "compliance";
export function immutabilityChoices(provider: Provider): Choice<ImmutabilityMode>[] {
  const r2 = provider === "r2" ? "R2 cannot enforce Object Lock." : undefined;
  return [
    { id: "off", label: "Off", consequence: "Archives can be deleted by anyone with bucket access." },
    { id: "governance", label: "Governance", consequence: "Locked for the window; a privileged principal can override.", ...(r2 ? { unavailable: r2 } : {}) },
    { id: "compliance", label: "Compliance", consequence: "Locked for the window by anyone. It cannot be undone.", ...(r2 ? { unavailable: r2 } : {}) },
  ];
}

// Storage-pricing defaults, used only by the cost estimate: lib/cost-model-rates.ts:86-90. R2 uses the R2
// list; every other provider borrows the Amazon S3 Standard list (destination-form-fields.ts:184 providerPricing).
export function pricingDefaults(provider: Provider): { storagePerGBMonth: number; classAPerMillion: number; classBPerMillion: number; egressPerGB: number; currency: "USD" } {
  const p = provider === "r2" ? PRESETS.r2 : PRESETS["s3-standard"];
  return { storagePerGBMonth: p.storagePerGBMonth, classAPerMillion: p.classAPerMillion, classBPerMillion: p.classBPerMillion, egressPerGB: p.egressPerGB, currency: "USD" };
}

// Addressing and storage class (S3-shaped providers): destination-form-fields.ts:489-519.
export const ADDRESSING_CHOICES: readonly Choice<"auto" | "path" | "vhost">[] = [
  { id: "auto", label: "Auto", consequence: "Virtual-hosted for AWS, path-style elsewhere. Recommended." },
  { id: "path", label: "Path-style", consequence: "host/bucket/key." },
  { id: "vhost", label: "Virtual-hosted", consequence: "bucket.host/key." },
];
export const STORAGE_CLASS_CHOICES: readonly Choice<"" | "STANDARD" | "STANDARD_IA" | "INTELLIGENT_TIERING" | "ONEZONE_IA">[] = [
  { id: "", label: "Bucket default", consequence: "The bucket's own default class." },
  { id: "STANDARD", label: "Standard", consequence: "Frequent access." },
  { id: "STANDARD_IA", label: "Standard-IA", consequence: "Cheaper to store, a retrieval fee applies." },
  { id: "INTELLIGENT_TIERING", label: "Intelligent-Tiering", consequence: "Moves objects between tiers. Restore-safe." },
  { id: "ONEZONE_IA", label: "One Zone-IA", consequence: "One availability zone only." },
];

// The optional authentication field sets. STS AssumeRole is AWS S3 only (destination-form-fields.ts:946-976);
// the Entra service principal is Azure only (:894-944). Both ids or neither.
export const STS_FIELDS = [
  { id: "roleArn", label: "Role ARN", hint: "arn:aws:iam::<12-digit account>:role/<name>. Blank uses the keys directly." },
  { id: "externalId", label: "External ID (optional)", hint: "Only if the role's trust policy demands one." },
  { id: "durationSeconds", label: "Session duration (seconds, optional)", hint: "900 to 43200. Default 3600." },
] as const;
export const ENTRA_FIELDS = [
  { id: "tenantId", label: "Directory (tenant) ID", hint: "A GUID or a verified domain. Not common, organizations or consumers." },
  { id: "clientId", label: "Application (client) ID", hint: "A GUID." },
] as const;

// ---- Keys: posture ----------------------------------------------------------------------------------
// Offline key only is listed FIRST and nothing is preselected: the choice is the user's to make. The
// consequence lines restate, in shorter words, clauses of the verbatim statement; they do not add a claim.
// A UI shows `statement` byte for byte after a choice (POSTURE_ACK_STATEMENTS, lib/posture-ack-statements.ts:25).
export interface PostureInfo {
  id: PostureChoice;
  label: string;
  consequences: { decrypt: string; restoreTests: string; pruning: string; compromise: string; reversibility: string };
  statement: { version: string; text: string };
}
export const POSTURES: readonly PostureInfo[] = [
  {
    id: "break-glass-only",
    label: "Offline key only",
    consequences: {
      decrypt: "Your engine holds no key that can decrypt your archives.",
      restoreTests: "Scheduled restore tests do not run in your engine. You prove past runs at an attended verification.",
      pruning: "Retention pruning does not run in your engine. You prune with the offline reader, so storage grows until you do.",
      compromise: "A compromised account or a malicious update cannot read your stored archives.",
      reversibility: "You can add an operational key later without a re-key. If you lose the offline key, your backups cannot be recovered.",
    },
    statement: POSTURE_ACK_STATEMENTS["break-glass-only"],
  },
  {
    id: "operational",
    label: "Operational key",
    consequences: {
      decrypt: "Your engine also holds a key that can decrypt your stored archives.",
      restoreTests: "Your engine can restore-test runs it sealed earlier with nobody present.",
      pruning: "Your engine can reopen past runs, so it can prune them on the schedule you set.",
      compromise: "A compromised account or a malicious update could read your stored archives.",
      reversibility: "Removing the key later does not protect archives sealed while it was present.",
    },
    statement: POSTURE_ACK_STATEMENTS.operational,
  },
];
export const POSTURE_TICK_LABEL = "I have read the implications and understand my choice.";

// ---- Keys: custody ------------------------------------------------------------------------------------
// The three schemes, in order, from lib/custody.ts:37-69 (SCHEME_OPTIONS). N and M bounds: :92-96.
export const CUSTODY_SCHEMES: readonly Choice<Exclude<CustodyScheme, "undecided">>[] = SCHEME_OPTIONS.map((o) => ({ id: o.id, label: o.label, consequence: o.summary }));
export const CUSTODY_SPLIT_BOUNDS = { minShares: MIN_SHARES, maxShares: MAX_SHARES, minThreshold: MIN_THRESHOLD, defaultShares: 5, defaultThreshold: 3 } as const;

// The files the ceremony saves (ceremony-files.ts downloadCeremonyFiles). operational.pub only under the
// operational posture. The signer private is never a file: it goes straight to the engine at Apply.
export function ceremonyFileNames(posture: PostureChoice | null): string[] {
  return ["identity.key", "recipient.pub", ...(posture === "operational" ? ["operational.pub"] : []), "signer.pub", "recovery-sheet.txt"];
}

// ---- Apply: the one deploy token ----------------------------------------------------------------------
// token-help.ts:80-99 (attachTokenHelp) and the capabilities the engine probes before an attach (engine
// src/admin/cf-api.ts:284 neededCapabilities on origin/main 76ba92e6). Key install needs Workers Scripts
// edit only (engine src/admin/attach.ts putSecret).
export const DEPLOY_TOKEN_TEMPLATE = "Edit Cloudflare Workers";
export function deployTokenPermissions(types: ReadonlySet<string>): string[] {
  const perms = ["Workers Scripts : Edit", "Workers KV Storage : Edit", "Workers R2 Storage : Edit"];
  if (types.has("d1")) perms.push("D1 : Edit (add it to the template)");
  if (types.has("secrets")) perms.push("Secrets Store : Edit (add it to the template)");
  return perms;
}
export type ApplyRoute = "token" | "self-deploy";
export const APPLY_ROUTES: readonly Choice<ApplyRoute>[] = [
  { id: "token", label: "Paste one deploy token", consequence: "The console installs your keys and attaches your sources. You revoke the token after." },
  { id: "self-deploy", label: "Use your own wrangler or CI", consequence: "No token. You set the secrets and deploy the bindings yourself." },
];

// ---- First backup: schedule, retention, restore test ---------------------------------------------------
// Schedules in ONE fixed order (CONTRACT): Daily first and recommended. Seconds from
// screens/sources-downpipes/helpers.ts:81-86 (CADENCE_PRESETS).
export type ScheduleId = "daily" | "6h" | "hourly" | "weekly";
export const SCHEDULES: readonly (Choice<ScheduleId> & { seconds: number })[] = [
  { id: "daily", label: "Daily", seconds: 86_400, consequence: "One run a day. Recommended." },
  { id: "6h", label: "Every 6 hours", seconds: 21_600, consequence: "Four runs a day." },
  { id: "hourly", label: "Hourly", seconds: 3_600, consequence: "24 runs a day. Higher read costs." },
  { id: "weekly", label: "Weekly", seconds: 604_800, consequence: "One run a week. Up to a week of changes at risk." },
];

// Retention (lib/api/types/downpipes.ts:81-94 RetentionPolicy): absent keeps everything; enforce:true is
// the only setting that deletes. Posture-aware: under offline key only, pruning does not run in the engine
// (POSTURE_ACK_STATEMENTS["break-glass-only"]), so the pruning options show the reason instead. The two
// dated presets also carry enforce:true, which the engine's addDownpipe re-checks against restore.apply
// (retentionWidensPrune, scheduler-do.ts): a caller without it cannot arm them, so restoreApplyReason
// (the caller's own capGateReason("restore.apply"), read by whoever calls this) shows the same reason on
// the tile instead of letting a create the engine will 403 look like a plain choice. This module reads no
// capability itself, so a caller with the permission passes undefined and nothing changes for them.
export type RetentionId = "keep-all" | "90-days" | "365-days";
export function retentionChoices(posture: PostureChoice | null, restoreApplyReason?: string): (Choice<RetentionId> & { policy?: { keepDays: number; enforce: true } })[] {
  const offline = posture !== "operational" ? "Offline key only: pruning does not run in your engine." : undefined;
  // Offline wins when both apply: it says the engine cannot prune at all, which is the more fundamental
  // reason and stays true whoever asks.
  const gated = offline ?? restoreApplyReason;
  return [
    { id: "keep-all", label: "Keep every run", consequence: "Nothing is deleted. Storage grows with every run." },
    { id: "90-days", label: "Keep 90 days", consequence: "Runs older than 90 days are deleted on the schedule.", policy: { keepDays: 90, enforce: true }, ...(gated ? { unavailable: gated } : {}) },
    { id: "365-days", label: "Keep 365 days", consequence: "Runs older than a year are deleted on the schedule.", policy: { keepDays: 365, enforce: true }, ...(gated ? { unavailable: gated } : {}) },
  ];
}

// The downpipe editor's own retention fields (editor-retention-section.ts:32,49,85; bounds from
// lib/api/types/downpipes.ts RETENTION_MAX_*): runs to keep, days to keep, and the enforce toggle. Without
// enforce the engine only reports what it would prune. Like the presets, it needs the operational posture.
export interface CustomRetention {
  keepRuns?: number;
  keepDays?: number;
  enforce: boolean;
}
export const CUSTOM_RETENTION_UNAVAILABLE = "Offline key only: pruning does not run in your engine.";
export function customRetentionLabel(c: CustomRetention): string {
  const parts = [c.keepRuns !== undefined ? `${c.keepRuns} runs` : null, c.keepDays !== undefined ? `${c.keepDays} days` : null].filter((x): x is string => x !== null);
  return `Keep ${parts.join(" or ")}${c.enforce ? ", deletion on" : ", report only"}`;
}

// Restore-test cadence (screens/sources-downpipes/editor-upsert.ts:230-234): weekly, daily or off; the engine
// defaults a new downpipe to weekly when omitted (lib/api/types/downpipes.ts:20-25), so off is sent as 0.
// Posture-aware: under offline key only the engine cannot reopen a past run, so the only honest value is
// off, and the attended verification is the proof.
export type RestoreTestId = "weekly" | "daily" | "off";
export function restoreTestChoices(posture: PostureChoice | null): (Choice<RestoreTestId> & { seconds: number })[] {
  const offline = posture !== "operational" ? "Offline key only: scheduled restore tests do not run in your engine." : undefined;
  return [
    { id: "weekly", label: "Weekly", seconds: 604_800, consequence: "The engine restore-tests the latest run each week. Recommended.", ...(offline ? { unavailable: offline } : {}) },
    { id: "daily", label: "Daily", seconds: 86_400, consequence: "A restore test every day.", ...(offline ? { unavailable: offline } : {}) },
    { id: "off", label: posture === "operational" ? "Off" : "Attended verification", seconds: 0, consequence: posture === "operational" ? "No scheduled proof. Backups still run." : "You prove past runs yourself, with your offline key in the browser." },
  ];
}
// The default the flow preselects for each posture.
export function defaultRestoreTest(posture: PostureChoice | null): RestoreTestId {
  return posture === "operational" ? "weekly" : "off";
}

// ---- Optional: team and restore approval ----------------------------------------------------------------
// Roles in ladder order, then the two narrow roles, each with its consequence in one line (the capabilities
// behind each role are lib/identity.ts).
export const ROLES: readonly Choice<Role>[] = [
  { id: "viewer", label: "Viewer", consequence: "Reads posture and runs. Changes nothing." },
  { id: "operator", label: "Operator", consequence: "Runs and edits downpipes, runs drills, dry-runs a restore." },
  { id: "approver", label: "Approver", consequence: "Approves another person's restore." },
  { id: "owner", label: "Owner", consequence: "Full control, including keys and roles." },
  { id: "restore-operator", label: "Restore operator", consequence: "Recovery only." },
  { id: "access-admin", label: "Access admin", consequence: "People and access policy only." },
];

// Restore approval (POST /admin/config/restore-approval-policy, actions-apply.ts setRestoreApproval). "second" needs a
// second Owner: the engine counts Owners for this floor, not Approvers, and refuses it while there is one Owner.
export type RestoreApprovalId = "solo" | "second" | "later";
export function restoreApprovalChoices(isOnlyOwner: boolean): Choice<RestoreApprovalId>[] {
  return [
    { id: "solo", label: "I restore on my own", consequence: "You apply a restore yourself. The dry run, passkey check and audit still apply." },
    { id: "second", label: "Require a second approver", consequence: "Another Owner or Approver must approve each restore plan.", ...(isOnlyOwner ? { unavailable: "You are the only Owner. Invite a second Owner first. Approvers do not count for this." } : {}) },
    { id: "later", label: "Decide later", consequence: "The engine default: off. Change it in Security Centre." },
  ];
}

// The post-setup screen the advanced downpipe editor options are deferred to (CONTRACT allows this one
// deferral only): prefixes, cron, timezone, maintenance windows, ID overrides, capture mode, fan-out.
export const ADVANCED_EDITOR_POINTER = "Prefixes, cron, timezone, maintenance windows, ID overrides, capture mode and extra destinations are in each downpipe's editor under Downpipes.";

// The one time estimate every surface quotes (CONTRACT step 0: the same figure everywhere, dashboard time
// included). Two tokens in the Cloudflare dashboard, an R2 API token for the destination, one bucket choice,
// and the key files.
export const SETUP_TIME_ESTIMATE = "About 15 minutes, including the Cloudflare dashboard.";
