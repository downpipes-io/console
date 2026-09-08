// Control-plane recovery mirror types (engine dependency: src/admin/control-plane.ts +
// src/sched/scheduler-do-routing-control-plane.ts). The whole control plane (every downpipe, schedule,
// RBAC role, IdP/destination config, the discovery token, the audit chain) lives in ONE singleton
// SchedulerDO. A storage loss of that DO is total control-plane amnesia: backups silently STOP and the
// first caller would silently re-bootstrap to Owner. The engine kills that silence with a recovery-required
// latch (whoami resolves to viewer, not Owner) and a signed, no-custody config export written to the
// destination bucket that a break-glass operator reconciles back. The console surfaces the latch as a
// standing recovery banner and offers the break-glass-gated reconcile.
//
// No-custody: NONE of these types ever carries a plaintext secret. The status is three booleans + a
// redaction-safe reason; the reconcile result is counts + the bridged audit head. The export artefact the
// operator pastes into the reconcile form is the engine's signed, no-custody export (dest secrets ride only
// as CONFIG_WRAP_KEY-wrapped envelopes or reestablish markers), parsed but never re-serialised by the
// console.

// ControlPlaneStagedSummary is the AUTO-HEAL's staged-recovery record, carried on ControlPlaneStatus
// when the cron auto-heal (engine/src/cron/control-plane-pass.ts) has already verified a SEALED recovery
// export's detached signature, unsealed it with this engine's own still-present CONFIG_RECIPIENT_PRIVATE
// (unsealAndResignForAutoHeal), staged it and resumed backups from it -- all without any operator action.
// Its presence means the manual "paste a plaintext export + signature" reconcile below is NOT reachable for
// this recovery (a sealed estate never has a plaintext-signed pair to paste: buildControlPlaneArtefactToWrite
// writes the signed plaintext OR the sealed artefact for one generation, never both): the right action is the
// break-glass CONFIRM (POST /admin/control-plane/apply-staged), which needs only the ADMIN_TOKEN, never the
// export itself. Counts + a source key + timestamps only; no secret, no config value.
export interface ControlPlaneStagedSummary {
  sourceKey: string;
  version: number;
  stagedAt: string;
  downpipes: number;
  resumeApplied: boolean;
  resumeSkipped?: boolean;
  appliedVersion?: number;
  appliedAt?: string;
}

// ControlPlaneStatus is the engine's recovery-status read (GET /admin/control-plane/status). recoveryRequired
// is the latch (true after an amnesia is detected, until a reconcile clears it); reason is the redaction-safe
// one-line explanation surfaced in the banner; configEmpty reports whether the control plane currently holds
// no downpipes AND no destinations (the amnesia signal, distinct from a brand-new account whose bucket is
// also empty). Any authenticated role may read it (it carries no secret), so the banner surfaces even for a
// post-wipe recovery-required viewer before any Owner is restored. staged is present exactly when the
// auto-heal has already staged a recovery (see ControlPlaneStagedSummary); absent/null on an engine build
// that predates auto-heal, or when nothing has been staged yet.
//
// roleTableEmpty is the SECOND emptiness, and it is the one that decides which exit the estate
// has. Every break-glass rebuild route refuses a NON-EMPTY role table; the acknowledge-only latch clear
// refuses an EMPTY one. Until this field existed the console could not tell the two apart, so it offered the
// break-glass actions to every latched estate, and on an established account -- which is all of them, the
// last-Owner guard keeps the table non-empty -- every affordance the banner had was one the engine had to
// refuse. OPTIONAL, and absent means UNKNOWN rather than false: an engine that predates the field must not be
// read as an empty role table, so the banner degrades to the state it can prove instead of asserting one.
export interface ControlPlaneStatus {
  recoveryRequired: boolean;
  reason: string | null;
  configEmpty: boolean;
  roleTableEmpty?: boolean;
  staged?: ControlPlaneStagedSummary | null;
}

// ControlPlaneAcknowledgeResult is the acknowledge-only latch clear's outcome (POST
// /admin/control-plane/acknowledge-recovery). It carries no count and no audit head because the call restores
// nothing: it clears the two latch fields and writes its own distinct audit action. The shape is deliberately
// this thin, so no future reader can mistake it for a rebuild that returned zero of everything.
export interface ControlPlaneAcknowledgeResult {
  ok: true;
  acknowledged: true;
}

// ControlPlaneReconcileResult is the engine's reconcile outcome (POST /admin/control-plane/restore). It
// carries the rebuilt counts and the prior audit head the new (genesis) chain bridges from, so the operator
// sees exactly what was restored. No secret, no config value: counts + an audit head hash only.
export interface ControlPlaneReconcileResult {
  ok: true;
  downpipes: number;
  destinations: number;
  roles: number;
  bridgedFrom: { headSeq: number; headHash: string };
}

// ControlPlaneApplyStagedResult is the engine's break-glass CONFIRM outcome (POST
// /admin/control-plane/apply-staged): it restores ONLY the authority slice (RBAC) from an already-staged,
// already-applied-to-data recovery -- the auto-heal resumed backups when it staged, so this confirm carries no
// downpipe/destination count of its own, only the roles restored and the audit bridge. No secret, no config
// value.
export interface ControlPlaneApplyStagedResult {
  ok: true;
  roles: number;
  bridgedFrom: { headSeq: number; headHash: string };
}

// EstateImportResult is the engine's cross-environment estate-import outcome (POST /admin/control-plane/import):
// a bootstrapped Owner on a fresh engine re-imports a lost estate's DEFINITION from a signed export verified
// against their recovery-kit signer.pub. It grants NO authority: authorityImported is always false (RBAC / IdP
// / policy are re-established by hand). downpipesDisabled is true when the export came from a DIFFERENT
// Cloudflare account -- the imported downpipes are disabled until each source is re-pointed. Counts + an audit
// head only; no secret, no config value.
export interface EstateImportResult {
  ok: true;
  downpipes: number;
  destinations: number;
  downpipesDisabled: boolean;
  authorityImported: false;
  bridgedFrom: { headSeq: number; headHash: string };
}
