// The EngineClient: the typed transport to the in-account engine admin API, split out of api.ts.
// Re-exported verbatim from ./api.ts so the existing callers are unchanged.
//
// STRUCTURE: this file was a single ~2,070-line class with 142 methods (a god module). The behaviour is now
// factored into a leaf transport (client-transport.ts: the shared headers / gatedFetch / parseJson* /
// readErrorReason plumbing) plus one module per domain group (client-<domain>.ts) of FREE FUNCTIONS over that
// transport. EngineClient keeps the SAME public surface, every method name and signature is unchanged, and
// each method is now a thin delegator to its domain function. The move is behaviour-preserving: no request
// URL, method, body, header or parse/throw path changed. The leaf transport is imported by every domain
// module and the domain modules are imported here, so there is no import cycle (the transport never imports
// a domain module or the client).

import type { ChangeRef } from "../change-ref.ts";
import type { DestVerifyResult } from "../client-diag/ring.ts";
import type { ClientDiagnosticsPayload } from "../client-diag/vocab.ts";
import type { CustomRole, CustomRoleProposal, Role } from "../identity.ts";
import * as alerting from "./client-alerting.ts";
import * as attest from "./client-attest.ts";
import * as audit from "./client-audit.ts";
import * as configControl from "./client-config-control.ts";
import * as controlPlane from "./client-control-plane.ts";
import * as destinations from "./client-destinations.ts";
import * as downpipes from "./client-downpipes.ts";
import * as expiry from "./client-expiry.ts";
import * as idp from "./client-idp.ts";
import * as keys from "./client-keys.ts";
import * as misc from "./client-misc.ts";
import * as notifications from "./client-notifications.ts";
import * as otlpPush from "./client-otlp-push.ts";
import * as ownerAction from "./client-owner-action.ts";
import * as passkey from "./client-passkey.ts";
import * as posture from "./client-posture.ts";
import * as push from "./client-push.ts";
import * as rbac from "./client-rbac.ts";
import * as recovery from "./client-recovery.ts";
import * as reporting from "./client-reporting.ts";
import * as restoreMod from "./client-restore.ts";
import * as retentionPrune from "./client-retention-prune.ts";
import * as session from "./client-session.ts";
import * as signInFactors from "./client-signin-factors.ts";
import * as sources from "./client-sources.ts";
import * as support from "./client-support.ts";
import { Transport } from "./client-transport.ts";
import * as update from "./client-update.ts";
import { assertEngineOrigin } from "./helpers.ts";
import type {
  AttachSourceInput,
  AttestCapsulesResult,
  AttestSessionRecord,
  AttestVerifyResult,
  AuditEvent,
  AuditFilters,
  AuditPage,
  BlindRestoreTest,
  BulkDownpipeSend,
  CanaryConfigPatch,
  CanaryView,
  CapsuleResult,
  CfConfigDiscovery,
  ChainVerdict,
  ConfigApprovalPolicy,
  ConfigChange,
  ConfigDiffResult,
  ConfigHistory,
  ConfigSnapshotResult,
  ConfigVersionResult,
  ConfirmStagedRecoveryCodes,
  ControlPlaneAcknowledgeResult,
  ControlPlaneApplyStagedResult,
  ControlPlaneReconcileResult,
  ControlPlaneStatus,
  CoverageInventoryStored,
  CoverageReport,
  CreateAttestSessionResult,
  CustodyShareSendInput,
  CustodyShareSendResult,
  DestinationInput,
  DestinationList,
  DestinationStatus,
  DestReplState,
  DiscoveryStatus,
  Downpipe,
  DownpipeBase,
  DownpipeState,
  DrillEvidenceEntry,
  DrillEvidenceKind,
  DrillResult,
  EstateImportResult,
  EstateSizeReport,
  ExpiryItem,
  ExpiryItemInput,
  ExpiryStatus,
  GroupRole,
  GroupRoleEntry,
  IdpConnectionView,
  IdpCreateResult,
  IdpKind,
  IdpPreset,
  IdpPresetCreate,
  IdpProvider,
  IdpSamlProposal,
  IdpTestResult,
  IngestScope,
  KeyInstallInput,
  KeyInstallResult,
  KeylessAttestationResult,
  KeyVintageInventory,
  LicenceStatus,
  MintedSupportCredential,
  MutationResult,
  NotifyChannel,
  NotifyChannelInput,
  NotifyHistoryEntry,
  NotifyRule,
  NotifyRuleInput,
  OtlpPushDestinationInput,
  OtlpPushDestinationView,
  OwnerAction,
  OwnerActionResult,
  PasskeyAssertionCredential,
  PasskeyAttestationCredential,
  PasskeyCredentialSummary,
  PasskeyFinish,
  PasskeyLoginBegin,
  PasskeyRegisterBegin,
  PointInTimeRun,
  PostureOverrideKind,
  PostureReport,
  PreflightReport,
  PromoteResult,
  PruneApplyResult,
  PruneApproval,
  PruneCandidateResult,
  PruneRejectReason,
  PushDestinationInput,
  PushDestinationView,
  PushTestResult,
  RampResult,
  RampSettleResult,
  RecoveryCodesResult,
  RecoveryFinish,
  Report,
  ReportKind,
  RequireAccessPreflight,
  ResourceInventory,
  RestoreApproval,
  RestoreApprovalRequest,
  RestorePlan,
  RestoreRejectReason,
  RestoreRequest,
  RestoreResult,
  RoleEntry,
  RtoReport,
  RunHistoryEntry,
  SettleResult,
  SetupState,
  SignInFactorListing,
  SignInFactorRevokeResult,
  SourceDiscovery,
  StandaloneRollbackResult,
  StatusReport,
  SupportStatus,
  UpdateApplyResult,
  UpdateComponentId,
  UpdateStatus,
  UpdateStatusRecord,
  WhoAmI,
} from "./types.ts";

// EngineClient is the public typed client every screen goes through (callers do `client.listAudit(...)`).
// Its surface is unchanged from the pre-split god module: the constructor, the public onStepUpRequired hook,
// the two static start-path builders, and 142 methods, each now a one-line delegation to its domain module
// over a shared Transport.
export class EngineClient {
  // The shared transport (origin + bearer + step-up hook + the fetch/parse plumbing). Every method delegates
  // to a domain free function that takes this transport, so the public behaviour is unchanged.
  private t: Transport;

  constructor(base: string, token?: string) {
    // No-custody / transport hygiene: the engine origin MUST be https so the admin traffic (the
    // Access cookie, the bearer fallback, restore plans) is never sent in clear over a downgraded
    // scheme. Parse the URL and assert the protocol; allow http ONLY for a localhost dev engine
    // (127.0.0.1 / ::1 / *.localhost), where there is no network to downgrade. Anything else
    // throws here, before any request is built, so a non-https engine origin can never be used.
    this.t = new Transport(assertEngineOrigin(base).replace(/\/+$/, ""), token);
  }

  // onStepUpRequired is the injected step-up re-auth ceremony (set by the store onto each client). It is a
  // public mutable property exactly as before; it reads/writes through to the transport (which gatedFetch
  // consults at call time), so the store's `engine.onStepUpRequired = ...` keeps working unchanged.
  get onStepUpRequired(): (() => Promise<string | null>) | undefined { return this.t.onStepUpRequired; }
  set onStepUpRequired(fn: (() => Promise<string | null>) | undefined) {
    this.t.onStepUpRequired = fn;
  }

  // ---- Step-up re-auth ceremony --------------------------------------------------------------------
  stepUpBegin(): Promise<PasskeyLoginBegin> { return passkey.stepUpBegin(this.t); }
  stepUpFinish(challengeId: string, credential: PasskeyAssertionCredential): Promise<{ ok: true; stepUpToken: string } | { ok: false; reason: string }> { return passkey.stepUpFinish(this.t, challengeId, credential); }

  // ---- Downpipes, runs, licence, restore-apply -----------------------------------------------------
  health(): Promise<{ ok: boolean; service?: string }> { return downpipes.health(this.t); }
  listDownpipes(): Promise<DownpipeState[]> { return downpipes.listDownpipes(this.t); }
  // `base` is the revision the caller READ this downpipe at (DownpipeState.configRev), sent as the
  // engine's ifMatchRev precondition. Omitted = the caller states nothing and the write applies with no base
  // check, which is what every console write did before the precondition shipped; see client-downpipes.ts.
  addDownpipe(dp: Downpipe, base?: DownpipeBase): Promise<MutationResult<DownpipeState>> { return downpipes.addDownpipe(this.t, dp, base); }
  bulkAddDownpipes(dps: Downpipe[]): Promise<BulkDownpipeSend> { return downpipes.bulkAddDownpipes(this.t, dps); }
  trigger(id: string): Promise<{ runId: string; index: number; prevRunId?: string } | { skipped: string }> { return downpipes.trigger(this.t, id); }
  deleteDownpipe(id: string, base?: DownpipeBase): Promise<MutationResult<{ deleted: boolean; swept?: number; deletedRev?: number }>> { return downpipes.deleteDownpipe(this.t, id, base); }
  rosterHygiene(): Promise<downpipes.RosterHygiene> { return downpipes.rosterHygiene(this.t); }
  reconcileRoster(): Promise<{ removed: number; rehomed: number; ghostsRemaining: number }> { return downpipes.reconcileRoster(this.t); }
  drill(runId: string): Promise<DrillResult> { return downpipes.drill(this.t, runId); }
  restore(req: RestoreRequest, change?: ChangeRef, opts?: { restoreMasterB64?: string }): Promise<RestorePlan | RestoreResult> { return downpipes.restore(this.t, req, change, opts); }
  // Fetch a run's master capsule so the browser can decap its per-run master locally for an
  // in-console break-glass restore. The non-secret wraps + key commitment only; gated restore.verify.
  restoreCapsule(runId: string): Promise<CapsuleResult> { return downpipes.restoreCapsule(this.t, runId); }
  licence(): Promise<LicenceStatus> { return downpipes.licence(this.t); }
  setLicence(token: string | null): Promise<LicenceStatus> { return downpipes.setLicence(this.t, token); }
  listHistory(id: string): Promise<RunHistoryEntry[]> { return downpipes.listHistory(this.t, id); }
  runsAt(downpipe: string, at: string): Promise<PointInTimeRun> { return downpipes.runsAt(this.t, downpipe, at); }
  whoami(): Promise<WhoAmI> { return downpipes.whoami(this.t); }
  listAllHistory(): Promise<downpipes.AllHistory> { return downpipes.listAllHistory(this.t); }

  // ---- Safe-apply update (engine, and additively the console component) ----------------------------
  updateStatus(): Promise<UpdateStatusRecord> { return update.updateStatus(this.t); }
  applyUpdate(opts: { token?: string; dryRun: boolean; allowDowngrade?: boolean; components?: UpdateComponentId[] }): Promise<UpdateApplyResult<PromoteResult>> { return update.applyUpdate(this.t, opts); }
  rampUpdate(opts: { token: string; percentage: number; allowDowngrade?: boolean }): Promise<UpdateApplyResult<RampResult>> { return update.rampUpdate(this.t, opts); }
  rollbackUpdate(token: string, components?: UpdateComponentId[]): Promise<StandaloneRollbackResult> { return update.rollbackUpdate(this.t, token, components); }
  rollbackPlan(components?: UpdateComponentId[]): Promise<StandaloneRollbackResult> { return update.rollbackPlan(this.t, components); }
  settleUpdate(token: string, components?: UpdateComponentId[]): Promise<UpdateApplyResult<SettleResult>> { return update.settleUpdate(this.t, token, components); }
  // The RAMP's own settle: a pending carrying a `percentage` is a gradual ramp's pending and the engine's
  // plain settle refuses it, so the pending card routes it here instead. Engine-only by construction, so it
  // takes no `components` split.
  settleRampUpdate(token: string): Promise<RampSettleResult> { return update.settleRampUpdate(this.t, token); }
  updates(): Promise<UpdateStatus> { return update.updates(this.t); }

  // ---- Passkey (WebAuthn) sign-in ------------------------------------------------------------------
  passkeyRegisterBegin(email: string, displayName?: string, inviteToken?: string): Promise<PasskeyRegisterBegin> { return passkey.passkeyRegisterBegin(this.t, email, displayName, inviteToken); }
  passkeyRegisterFinish(email: string, credential: PasskeyAttestationCredential, displayName?: string, inviteToken?: string): Promise<PasskeyFinish> { return passkey.passkeyRegisterFinish(this.t, email, credential, displayName, inviteToken); }
  passkeyLoginBegin(email?: string): Promise<PasskeyLoginBegin> { return passkey.passkeyLoginBegin(this.t, email); }
  passkeyLoginFinish(challengeId: string, credential: PasskeyAssertionCredential): Promise<PasskeyFinish> { return passkey.passkeyLoginFinish(this.t, challengeId, credential); }
  passkeyLogout(): Promise<{ ok: boolean }> { return passkey.passkeyLogout(this.t); }
  bootstrapSendLink(): Promise<{ ok: boolean }> { return passkey.bootstrapSendLink(this.t); }

  // ---- Session management --------------------------------------------------------------------------
  terminateOtherSessions(): Promise<{ ok: boolean }> { return session.terminateOtherSessions(this.t); }
  terminateUserSessions(email: string): Promise<{ ok: boolean }> { return session.terminateUserSessions(this.t, email); }
  terminateAllSessions(): Promise<{ ok: boolean }> { return session.terminateAllSessions(this.t); }

  // ---- Passkey credential management ---------------------------------------------------------------
  listPasskeyCredentials(email?: string): Promise<{ credentials: PasskeyCredentialSummary[] }> { return session.listPasskeyCredentials(this.t, email); }
  deletePasskeyCredential(credentialId: string): Promise<{ deleted: boolean }> { return session.deletePasskeyCredential(this.t, credentialId); }

  // ---- Recovery codes ------------------------------------------------------------------------------
  recoverWithCode(email: string, code: string): Promise<RecoveryFinish> { return recovery.recoverWithCode(this.t, email, code); }
  regenerateRecoveryCodes(): Promise<RecoveryCodesResult> { return recovery.regenerateRecoveryCodes(this.t); }
  confirmRecoveryCodes(): Promise<ConfirmStagedRecoveryCodes> { return recovery.confirmRecoveryCodes(this.t); }

  // ---- Source discovery + cf-config + binding attach ----------------------------------------------
  discoverSources(): Promise<SourceDiscovery> { return sources.discoverSources(this.t); }
  getDiscoveryStatus(): Promise<DiscoveryStatus> { return sources.getDiscoveryStatus(this.t); }
  setDiscoveryToken(token: string | null, change?: ChangeRef): Promise<OwnerActionResult<DiscoveryStatus>> { return sources.setDiscoveryToken(this.t, token, change); }
  setDiscoveryAccounts(selected: string[], engineAccountId: string | null, change?: ChangeRef): Promise<OwnerActionResult<DiscoveryStatus>> { return sources.setDiscoveryAccounts(this.t, selected, engineAccountId, change); }
  setEnabledSources(enabled: string[]): Promise<DiscoveryStatus> { return sources.setEnabledSources(this.t, enabled); }
  rediscoverCfConfig(id: string): Promise<{ ok: boolean; error?: string; discovery?: CfConfigDiscovery }> { return sources.rediscoverCfConfig(this.t, id); }
  setCfConfigMode(id: string, mode: "auto" | "manual"): Promise<MutationResult<{ ok: boolean; error?: string }>> { return sources.setCfConfigMode(this.t, id, mode); }
  changeBindings(token: string, add: AttachSourceInput[], remove: string[]): Promise<OwnerActionResult<{ attached: string[]; detached: string[] }>> { return sources.changeBindings(this.t, token, add, remove); }
  reattachMissing(token: string): Promise<sources.ReattachResult> { return sources.reattachMissing(this.t, token); }
  attachSources(token: string, sources: AttachSourceInput[]): Promise<OwnerActionResult<{ attached: string[] }>> { return keys.attachSources(this.t, token, sources); }

  // ---- Archive destinations ------------------------------------------------------------------------
  getDestination(): Promise<DestinationStatus> { return destinations.getDestination(this.t); }
  setDestination(config: DestinationInput | null, change?: ChangeRef): Promise<OwnerActionResult<DestinationStatus>> { return destinations.setDestination(this.t, config, change); }
  // The engine's DISCRIMINATED UNION, not a flattened re-declaration. A flattened shape hid a real defect
  // from tsc: it made deleteProbe look reachable on the failure arm (it is not) and made ok:true look unable
  // to carry a denied delete (it can, and that IS the WORM case).
  verifyDestination(id?: string): Promise<DestVerifyResult> { return destinations.verifyDestination(this.t, id); }
  listDestinations(): Promise<DestinationList> { return destinations.listDestinations(this.t); }
  estateSize(): Promise<EstateSizeReport> { return destinations.estateSize(this.t); }
  addDestination(config: DestinationInput, label: string, id?: string, change?: ChangeRef): Promise<OwnerActionResult<DestinationList>> { return destinations.addDestination(this.t, config, label, id, change); }
  removeDestination(id: string, change?: ChangeRef, force?: boolean): Promise<OwnerActionResult<DestinationList>> { return destinations.removeDestination(this.t, id, change, force); }
  setDefaultDestination(id: string, change?: ChangeRef): Promise<OwnerActionResult<DestinationList>> { return destinations.setDefaultDestination(this.t, id, change); }

  // ---- Key install + posture tightening + guided setup --------------------------------------------
  installKeys(input: KeyInstallInput): Promise<KeyInstallResult> { return keys.installKeys(this.t, input); }
  getKeyVintages(): Promise<KeyVintageInventory> { return keys.getKeyVintages(this.t); }
  addOperationalKey(input: { token: string; operationalPublic: string; operationalPrivate: string }): Promise<{ ok: true }> { return keys.addOperationalKey(this.t, input); }
  acknowledgeSetup(): Promise<{ ok: boolean }> { return keys.acknowledgeSetup(this.t); }
  rotateBreakGlass(token: string, breakGlassPublic: string): Promise<{ ok: true }> { return keys.rotateBreakGlass(this.t, token, breakGlassPublic); }
  setBreakGlassOnly(token: string, confirmDiscardStranded = false): Promise<{ ok: true }> { return keys.setBreakGlassOnly(this.t, token, confirmDiscardStranded); }
  acknowledgePosture(input: { posture: "operational" | "break-glass-only"; statementVersion: string; acknowledgedText: string; channel: "onboarding" | "keys-rekey" }): Promise<{ ok: boolean; statementSha384?: string }> { return keys.acknowledgePosture(this.t, input); }
  retireBreakGlassToken(change?: ChangeRef): Promise<OwnerActionResult<{ retired: boolean }>> { return keys.retireBreakGlassToken(this.t, change); }
  sendCustodyShare(input: CustodyShareSendInput): Promise<CustodyShareSendResult> { return keys.sendCustodyShare(this.t, input); }

  // ---- Attended verification (offline-key-only in-platform proof; the client drives the loop) ------
  createAttestSession(input?: { scope?: string[]; sampleRate?: number }): Promise<CreateAttestSessionResult> { return attest.createAttestSession(this.t, input); }
  proveAttestSession(input: { sessionId: string; proofB64: string }): Promise<{ ok: true }> { return attest.proveAttestSession(this.t, input); }
  attestCapsules(input: { sessionId: string; runIds: string[] }): Promise<AttestCapsulesResult> { return attest.attestCapsules(this.t, input); }
  attestVerify(input: { sessionId: string; batch: Array<{ runId: string; masterB64: string }> }): Promise<AttestVerifyResult> { return attest.attestVerify(this.t, input); }
  attestStatus(sessionId: string): Promise<{ session: AttestSessionRecord }> { return attest.attestStatus(this.t, sessionId); }
  abortAttestSession(sessionId: string): Promise<{ ok: true }> { return attest.abortAttestSession(this.t, sessionId); }

  // ---- Retention prune (the break-glass-only posture's no-CLI replacement for `downpipe prune`) --------
  retentionPruneCandidate(downpipeId: string): Promise<PruneCandidateResult> { return retentionPrune.retentionPruneCandidate(this.t, downpipeId); }
  retentionPruneApply(input: { downpipeId: string; batch: Array<{ runId: string; masterB64: string }>; previewOnly?: boolean }): Promise<PruneApplyResult> { return retentionPrune.retentionPruneApply(this.t, input); }
  retentionPruneRequest(input: { downpipeId: string; reason: string }): Promise<PruneApproval> { return retentionPrune.retentionPruneRequest(this.t, input); }
  retentionPruneApprove(planHash: string): Promise<PruneApproval> { return retentionPrune.retentionPruneApprove(this.t, planHash); }
  retentionPruneReject(planHash: string, rejectReason: PruneRejectReason): Promise<PruneApproval> { return retentionPrune.retentionPruneReject(this.t, planHash, rejectReason); }
  retentionPruneApprovals(): Promise<PruneApproval[]> { return retentionPrune.retentionPruneApprovals(this.t); }

  // ---- Sign-in factors: the union read across all three sign-in stores, and the offboarding revoke ----
  // The revoke is NOT a role delete and is deliberately a separate method: deleting a role can be a
  // demotion for somebody who keeps authority through an identity-provider group, and this destroys their
  // authenticator and their recovery codes irreversibly. See client-signin-factors.ts.
  listSignInFactors(email?: string): Promise<SignInFactorListing> { return signInFactors.listSignInFactors(this.t, email); }
  revokeSignInFactors(email: string): Promise<SignInFactorRevokeResult> { return signInFactors.revokeSignInFactors(this.t, email); }

  // ---- Cross-cutting readers / utilities -----------------------------------------------------------
  getSetupState(): Promise<SetupState> { return misc.getSetupState(this.t); }
  testEmailDelivery(): Promise<{ ok: boolean; reason?: string; code?: string }> { return misc.testEmailDelivery(this.t); }
  listReplication(): Promise<{ byDownpipe: Record<string, Record<string, DestReplState>> }> { return misc.listReplication(this.t); }
  status(): Promise<StatusReport> { return misc.status(this.t); }
  preflight(): Promise<PreflightReport> { return misc.preflight(this.t); }
  resetDemoFresh(adminToken: string): Promise<{ ok: boolean; reset?: boolean; cleared?: number | null }> { return misc.resetDemoFresh(this.t, adminToken); }

  // ---- Control-plane recovery (signed export reconcile) ----------------------------------------------
  controlPlaneStatus(): Promise<ControlPlaneStatus> { return controlPlane.controlPlaneStatus(this.t); }
  controlPlaneExportDownload(): Promise<{ export: unknown; signature: string }> { return controlPlane.controlPlaneExportDownload(this.t); }
  controlPlaneImport(exportArtefact: unknown, signature: string, signerPublic: string): Promise<EstateImportResult> { return controlPlane.controlPlaneImport(this.t, exportArtefact, signature, signerPublic); }
  controlPlaneImportSealed(sealed: unknown, sealedSignature: string, signerPublic: string, exportArtefact: unknown): Promise<EstateImportResult> { return controlPlane.controlPlaneImportSealed(this.t, sealed, sealedSignature, signerPublic, exportArtefact); }
  controlPlaneRestore(adminToken: string, exportArtefact: unknown, signature: string): Promise<ControlPlaneReconcileResult> { return controlPlane.controlPlaneRestore(this.t, adminToken, exportArtefact, signature); }
  // The sealed sibling of controlPlaneRestore, for a bucket holding only a `.sealed.json` artefact on an
  // engine with no CONFIG_RECIPIENT_PRIVATE. The caller unseals locally first; the engine re-verifies everything.
  controlPlaneRestoreSealed(adminToken: string, sealed: unknown, sealedSignature: string, exportArtefact: unknown): Promise<ControlPlaneReconcileResult> { return controlPlane.controlPlaneRestoreSealed(this.t, adminToken, sealed, sealedSignature, exportArtefact); }
  controlPlaneApplyStaged(adminToken: string): Promise<ControlPlaneApplyStagedResult> { return controlPlane.controlPlaneApplyStaged(this.t, adminToken); }
  // The acknowledge-only latch clear, the one exit an ESTABLISHED account has. It takes no token
  // and no artefact because it restores nothing; it rides the operator's own session, which is available
  // precisely because the role table it needs is non-empty.
  controlPlaneAcknowledgeRecovery(): Promise<ControlPlaneAcknowledgeResult> { return controlPlane.controlPlaneAcknowledgeRecovery(this.t); }

  // ---- Secure support diagnostics ------------------------------------------------------------------
  getSupport(): Promise<SupportStatus> { return support.getSupport(this.t); }
  mintSupportCredential(scope: IngestScope, ttlSeconds?: number, change?: ChangeRef): Promise<OwnerActionResult<MintedSupportCredential>> { return support.mintSupportCredential(this.t, scope, ttlSeconds, change); }
  revokeSupportCredential(scope: IngestScope): Promise<{ ok: boolean; scope: IngestScope }> { return support.revokeSupportCredential(this.t, scope); }
  // clientDiagnostics (optional) rides the pack build as a REQUEST-SCOPED section (Wave C, I1): supplying it
  // turns the download into a POST and the engine folds the re-validated, clamped ring into THAT bundle only.
  getSupportBundle(clientDiagnostics?: ClientDiagnosticsPayload): Promise<string> { return support.getSupportBundle(this.t, clientDiagnostics); }
  metricsEndpointUrl(): string { return support.metricsEndpointUrl(this.t); }

  // ---- Outbound audit-log push (SIEM) ---------------------------------------------------------------
  getPush(): Promise<PushDestinationView> { return push.getPush(this.t); }
  setPush(input: PushDestinationInput, change?: ChangeRef): Promise<OwnerActionResult<PushDestinationView>> { return push.setPush(this.t, input, change); }
  clearPush(change?: ChangeRef): Promise<{ ok: boolean }> { return push.clearPush(this.t, change); }
  testPush(): Promise<PushTestResult> { return push.testPush(this.t); }

  // ---- Outbound OTLP/HTTP metrics push (zero-agent monitoring) ---------------------------------------
  getOtlpPush(): Promise<OtlpPushDestinationView> { return otlpPush.getOtlpPush(this.t); }
  setOtlpPush(input: OtlpPushDestinationInput, change?: ChangeRef): Promise<OwnerActionResult<OtlpPushDestinationView>> { return otlpPush.setOtlpPush(this.t, input, change); }
  clearOtlpPush(change?: ChangeRef): Promise<{ ok: boolean }> { return otlpPush.clearOtlpPush(this.t, change); }

  // ---- RBAC: roles, group-roles, custom roles ------------------------------------------------------
  requireAccessPreflight(): Promise<RequireAccessPreflight> { return rbac.requireAccessPreflight(this.t); }
  listRoles(): Promise<RoleEntry[]> { return rbac.listRoles(this.t); }
  setRole(email: string, role: Role, expiresAt?: string): Promise<MutationResult<RoleEntry>> { return rbac.setRole(this.t, email, role, expiresAt); }
  deleteRole(email: string): Promise<MutationResult<{ deleted: boolean }>> { return rbac.deleteRole(this.t, email); }
  listGroupRoles(): Promise<GroupRoleEntry[]> { return rbac.listGroupRoles(this.t); }
  setGroupRole(group: string, role: GroupRole): Promise<MutationResult<GroupRoleEntry>> { return rbac.setGroupRole(this.t, group, role); }
  deleteGroupRole(group: string): Promise<MutationResult<{ deleted: boolean }>> { return rbac.deleteGroupRole(this.t, group); }
  listCustomRoles(): Promise<CustomRole[]> { return rbac.listCustomRoles(this.t); }
  createCustomRole(proposal: CustomRoleProposal): Promise<MutationResult<CustomRole>> { return rbac.createCustomRole(this.t, proposal); }
  deleteCustomRole(name: string): Promise<MutationResult<{ deleted: boolean }>> { return rbac.deleteCustomRole(this.t, name); }
  assignCustomRole(email: string, customRole: string, expiresAt?: string): Promise<MutationResult<RoleEntry>> { return rbac.assignCustomRole(this.t, email, customRole, expiresAt); }
  assignGroupCustomRole(group: string, customRole: string): Promise<MutationResult<GroupRoleEntry>> { return rbac.assignGroupCustomRole(this.t, group, customRole); }

  // ---- Native external-IdP SSO ---------------------------------------------------------------------
  idpProviders(): Promise<{ ok: boolean; providers: IdpProvider[] }> { return idp.idpProviders(this.t); }
  idpPresets(): Promise<{ ok: boolean; presets: IdpPreset[] }> { return idp.idpPresets(this.t); }
  idpConnections(): Promise<{ ok: boolean; connections: IdpConnectionView[] }> { return idp.idpConnections(this.t); }
  createIdpConnection(input: IdpPresetCreate | IdpSamlProposal, change?: ChangeRef): Promise<OwnerActionResult<IdpCreateResult>> { return idp.createIdpConnection(this.t, input, change); }
  testIdpConnection(proposal: IdpPresetCreate | IdpSamlProposal): Promise<IdpTestResult> { return idp.testIdpConnection(this.t, proposal); }
  testSavedIdpConnection(connId: string): Promise<IdpTestResult> { return idp.testSavedIdpConnection(this.t, connId); }
  deleteIdpConnection(connId: string, change?: ChangeRef): Promise<OwnerActionResult<{ ok: boolean; reason?: string }>> { return idp.deleteIdpConnection(this.t, connId, change); }
  setIdpConnectionEnabled(connId: string, enabled: boolean, change?: ChangeRef): Promise<OwnerActionResult<{ ok: boolean; reason?: string }>> { return idp.setIdpConnectionEnabled(this.t, connId, enabled, change); }
  rolloverIdpSigningCerts(connId: string, mode: "append" | "replace", certs: string[], change?: ChangeRef): Promise<OwnerActionResult<{ ok: boolean; reason?: string }>> { return idp.rolloverIdpSigningCerts(this.t, connId, mode, certs, change); }
  samlMetadata(connId: string): Promise<string> { return idp.samlMetadata(this.t, connId); }
  // oidcStartPath / samlStartPath stay STATIC (callers use EngineClient.oidcStartPath(...)); they delegate to
  // the pure builders in the idp module so the exact URL form has one source.
  static oidcStartPath(connId: string, returnTo?: string): string { return idp.oidcStartPath(connId, returnTo); }
  static samlStartPath(connId: string, returnTo?: string): string { return idp.samlStartPath(connId, returnTo); }
  idpStartUrlFor(provider: { id: string; kind: IdpKind }, returnTo?: string): string { return idp.idpStartUrlFor(this.t, provider, returnTo); }
  samlMetadataUrl(connId: string): string { return idp.samlMetadataUrl(this.t, connId); }
  idpRedirectUri(connId: string): string { return idp.idpRedirectUri(this.t, connId); }
  samlAcsUrl(connId: string): string { return idp.samlAcsUrl(this.t, connId); }

  // ---- Restore dual-control + restorability assurance ---------------------------------------------
  requestRestore(req: RestoreApprovalRequest): Promise<RestoreApproval> { return restoreMod.requestRestore(this.t, req); }
  approveRestore(planHash: string): Promise<RestoreApproval> { return restoreMod.approveRestore(this.t, planHash); }
  rejectRestore(planHash: string, rejectReason: RestoreRejectReason): Promise<RestoreApproval> { return restoreMod.rejectRestore(this.t, planHash, rejectReason); }
  listApprovals(): Promise<RestoreApproval[]> { return restoreMod.listApprovals(this.t); }
  verifyRestore(req: { runId: string; include?: string[]; exclude?: string[]; maxRecords?: number }): Promise<BlindRestoreTest> { return restoreMod.verifyRestore(this.t, req); }
  attestRestore(runId: string): Promise<KeylessAttestationResult> { return restoreMod.attestRestore(this.t, runId); }

  // ---- Audit log + drill evidence ------------------------------------------------------------------
  listAudit(filters: AuditFilters = {}): Promise<AuditPage> { return audit.listAudit(this.t, filters); }
  verifyAuditChain(): Promise<ChainVerdict> { return audit.verifyAuditChain(this.t); }
  exportAudit(format: "json" | "csv" = "json"): Promise<string> { return audit.exportAudit(this.t, format); }
  recordAuditIntent(action: "key-ceremony-intent" | "access-policy-change-intent"): Promise<AuditEvent> { return audit.recordAuditIntent(this.t, action); }
  recordDrillEvidence(runId: string, kind: DrillEvidenceKind, note?: string): Promise<DrillEvidenceEntry> { return audit.recordDrillEvidence(this.t, runId, kind, note); }
  listDrillEvidence(): Promise<DrillEvidenceEntry[]> { return audit.listDrillEvidence(this.t); }

  // ---- Canary backup -------------------------------------------------------------------------------
  getCanary(): Promise<CanaryView> { return alerting.getCanary(this.t); }
  setCanaryConfig(patch: CanaryConfigPatch): Promise<MutationResult<CanaryView>> { return alerting.setCanaryConfig(this.t, patch); }
  runCanary(): Promise<{ ok: boolean; flying: boolean }> { return alerting.runCanary(this.t); }

  // ---- Notifications -------------------------------------------------------------------------------
  listNotifyChannels(): Promise<NotifyChannel[]> { return notifications.listNotifyChannels(this.t); }
  upsertNotifyChannel(channel: NotifyChannelInput): Promise<MutationResult<NotifyChannel>> { return notifications.upsertNotifyChannel(this.t, channel); }
  deleteNotifyChannel(id: string): Promise<MutationResult<{ deleted: boolean }>> { return notifications.deleteNotifyChannel(this.t, id); }
  listNotifyRules(): Promise<NotifyRule[]> { return notifications.listNotifyRules(this.t); }
  upsertNotifyRule(rule: NotifyRuleInput): Promise<MutationResult<NotifyRule>> { return notifications.upsertNotifyRule(this.t, rule); }
  deleteNotifyRule(id: string): Promise<MutationResult<{ deleted: boolean }>> { return notifications.deleteNotifyRule(this.t, id); }
  listNotifyHistory(): Promise<NotifyHistoryEntry[]> { return notifications.listNotifyHistory(this.t); }
  testNotifyChannel(channelId: string): Promise<{ ok: boolean }> { return notifications.testNotifyChannel(this.t, channelId); }

  // ---- Credential & key expiry tracker -------------------------------------------------------------
  listExpiry(): Promise<ExpiryStatus[]> { return expiry.listExpiry(this.t); }
  upsertExpiryItem(item: ExpiryItemInput): Promise<MutationResult<ExpiryItem>> { return expiry.upsertExpiryItem(this.t, item); }
  deleteExpiryItem(id: string): Promise<MutationResult<{ deleted: boolean }>> { return expiry.deleteExpiryItem(this.t, id); }
  cleanupAttestExpiry(id: string): Promise<{ ok: boolean; updated: boolean }> { return expiry.cleanupAttestExpiry(this.t, id); }

  // ---- Reporting -----------------------------------------------------------------------------------
  getReport(kind: ReportKind): Promise<Report> { return reporting.getReport(this.t, kind); }
  getReportPDF(kind: ReportKind): Promise<Uint8Array> { return reporting.getReportPDF(this.t, kind); }
  getEvidencePackPDF(framework: string): Promise<Uint8Array> { return reporting.getEvidencePackPDF(this.t, framework); }
  getEvidencePack(framework: string): Promise<Report> { return reporting.getEvidencePack(this.t, framework); }
  rto(id?: string): Promise<RtoReport> { return reporting.rto(this.t, id); }

  // ---- Security centre / posture + coverage --------------------------------------------------------
  getPosture(): Promise<PostureReport> { return posture.getPosture(this.t); }
  acceptPostureRisk(checkId: string, reason: string, kind: PostureOverrideKind = "risk-accepted"): Promise<MutationResult<{ ok: boolean }>> { return posture.acceptPostureRisk(this.t, checkId, reason, kind); }
  unacceptPostureRisk(checkId: string): Promise<MutationResult<{ ok: boolean }>> { return posture.unacceptPostureRisk(this.t, checkId); }
  getCoverage(): Promise<CoverageReport> { return posture.getCoverage(this.t); }
  setCoverageInventory(inventory: ResourceInventory): Promise<MutationResult<CoverageInventoryStored>> { return posture.setCoverageInventory(this.t, inventory); }

  // ---- Config change-control + read-only config version history -----------------------------------
  getConfigApprovalPolicy(): Promise<ConfigApprovalPolicy> { return configControl.getConfigApprovalPolicy(this.t); }
  setConfigApprovalPolicy(requireConfigApproval: boolean): Promise<OwnerActionResult<ConfigApprovalPolicy>> { return configControl.setConfigApprovalPolicy(this.t, requireConfigApproval); }
  setChangeNumberPolicy(requireChangeNumber: boolean): Promise<{ requireChangeNumber: boolean }> { return configControl.setChangeNumberPolicy(this.t, requireChangeNumber); }
  setRestoreApprovalPolicy(requireRestoreApproval: boolean): Promise<{ requireRestoreApproval: boolean }> { return configControl.setRestoreApprovalPolicy(this.t, requireRestoreApproval); }
  getAttendedCadence(): Promise<{ attendedCadenceDays: number }> { return configControl.getAttendedCadence(this.t); }
  setAttendedCadence(attendedCadenceDays: number): Promise<{ attendedCadenceDays: number }> { return configControl.setAttendedCadence(this.t, attendedCadenceDays); }
  setSignInContextPolicy(notifyNewSignInContext: boolean): Promise<{ notifyNewSignInContext: boolean }> { return configControl.setSignInContextPolicy(this.t, notifyNewSignInContext); }
  listConfigChanges(): Promise<ConfigChange[]> { return configControl.listConfigChanges(this.t); }
  approveConfigChange(id: string): Promise<ConfigChange> { return configControl.approveConfigChange(this.t, id); }
  rejectConfigChange(id: string): Promise<ConfigChange> { return configControl.rejectConfigChange(this.t, id); }
  getConfigHistory(): Promise<ConfigHistory> { return configControl.getConfigHistory(this.t); }
  getConfigVersion(id: number): Promise<ConfigVersionResult> { return configControl.getConfigVersion(this.t, id); }
  getConfigDiff(from: number, to: number): Promise<ConfigDiffResult> { return configControl.getConfigDiff(this.t, from, to); }
  snapshotConfig(): Promise<ConfigSnapshotResult> { return configControl.snapshotConfig(this.t); }

  // ---- High-blast-radius owner-action dual-control inbox ------------------------------------------
  listOwnerActions(): Promise<OwnerAction[]> { return ownerAction.listOwnerActions(this.t); }
  approveOwnerAction(id: string): Promise<OwnerAction> { return ownerAction.approveOwnerAction(this.t, id); }
  rejectOwnerAction(id: string): Promise<OwnerAction> { return ownerAction.rejectOwnerAction(this.t, id); }
}
