// The LOCAL, IN-MEMORY, BOUNDED console-diagnostics ring.
// It accumulates COARSE, CLOSED-CLASS error records during a session so that a customer who generates a
// support pack carries their own console's error evidence INSIDE the sealed, signed pack. It is NOT
// telemetry: nothing here ever leaves the browser on its own. The one exit is the deliberate Generate
// action on the support screen, which POSTs the ring to the engine as part of building the pack the
// customer then chooses to share (I1: request-scoped, no persistence anywhere).
//
// THE NO-CUSTODY GUARANTEE IS STRUCTURAL, NOT A MATTER OF DISCIPLINE (I2). A record has ZERO free-string
// fields. Every string on it is a member of a frozen closed union (vocab.ts) admitted only by SET
// MEMBERSHIP; every numeric goes through a clamp. So there is no field a customer value COULD occupy: a
// URL, a downpipe id, an email, a label, a header, a body, a token or an error message cannot be a set
// member, and is dropped rather than coerced. The mappers below are the only writers, and they never read
// error.message / error.name / error.code / error.stack INTO a field: the one place a name is consulted at
// all (abortHttpClass) compares it for EQUALITY against two frozen product constants and copies nothing.
//
// Storage: in-memory only. There is deliberately NO sessionStorage in this first build (D6 is reserved for
// the C5 boot-fault phase), so a shared workstation cannot carry one operator's classes into another's pack.

// errorStatus returns a NUMBER or null and copies nothing: it is how bulkReasonForFailures reads an engine
// failure's status without the engine's prose having any path into a record.
import { classifyError, errorAnswered, errorStatus, forbiddenClass } from "../errors.ts";
// The pure half (classify.ts): clamps, the monotonic clock, the screen mapper and the fault mappers. The ring
// re-exports the ones its CALLERS use, so every emit site keeps importing from one module (ring.ts is the
// public face of the diagnostics ring; the split is an internal seam, not a new surface for 30 call sites to
// learn).
import { clampInt, clampNonNegInt, currentScreen, elapsedMs, faultClassForError, httpClassForThrown } from "./classify.ts";
import {
  ADMIN_OPS_RECORDING_SUCCESS,
  CLIENT_DIAG_ADMIN_OP_SET,
  CLIENT_DIAG_ANOMALY_SET,
  CLIENT_DIAG_APPLY_CLASS_SET,
  CLIENT_DIAG_BOOT_CLASS_SET,
  CLIENT_DIAG_BUILD_CHECK_CLASS_SET,
  CLIENT_DIAG_BULK_ACTION_SET,
  CLIENT_DIAG_CALL_CLASS_SET,
  CLIENT_DIAG_CAPABILITY_OUTCOME_SET,
  CLIENT_DIAG_CAPABILITY_SET,
  CLIENT_DIAG_CATALOGUE_CLASS_SET,
  CLIENT_DIAG_CEREMONY_FAULT_SET,
  CLIENT_DIAG_CEREMONY_OUTCOME_SET,
  CLIENT_DIAG_CEREMONY_STEP_SET,
  CLIENT_DIAG_CHANNEL_REASON_CLASS_SET,
  CLIENT_DIAG_CLAIM_RESULT_SET,
  CLIENT_DIAG_CONTRACT_CLASS_SET,
  CLIENT_DIAG_CSP_BLOCKED_SET,
  CLIENT_DIAG_CSP_DIRECTIVE_SET,
  CLIENT_DIAG_CSP_INLINE_ORIGIN_SET,
  CLIENT_DIAG_DEGRADE_CAUSE_SET,
  CLIENT_DIAG_DELETE_FATE_SET,
  CLIENT_DIAG_DISCOVERY_OUTCOME_SET,
  CLIENT_DIAG_DRIFT_CLASS_SET,
  CLIENT_DIAG_DRILL_ABORT_SET,
  CLIENT_DIAG_DRILL_FACT_SET,
  CLIENT_DIAG_DROP_FACT_SET,
  CLIENT_DIAG_DROP_SURFACE_SET,
  CLIENT_DIAG_ERROR_CLASS_SET,
  CLIENT_DIAG_FAULT_CLASS_SET,
  CLIENT_DIAG_FAULT_SOURCE_SET,
  CLIENT_DIAG_FEATURE_CLASS_SET,
  CLIENT_DIAG_FEATURE_OUTCOME_SET,
  CLIENT_DIAG_FIELD_CLASS_SET,
  CLIENT_DIAG_FIELD_FAMILY_SET,
  CLIENT_DIAG_FOCUS_OUTCOME_SET,
  CLIENT_DIAG_FORM_FIELD_SET,
  CLIENT_DIAG_GATE_BLOCK_CLASS_SET,
  CLIENT_DIAG_GLOBAL_ROW_CAP,
  CLIENT_DIAG_GOV_GATE_SET,
  CLIENT_DIAG_HANDOFF_CLASS_SET,
  CLIENT_DIAG_HTTP_CLASS_SET,
  CLIENT_DIAG_INTENT_CLASS_SET,
  CLIENT_DIAG_KIND_SET,
  CLIENT_DIAG_MATERIAL_CLASS_SET,
  CLIENT_DIAG_MAX_BODY_BYTES,
  CLIENT_DIAG_ONBOARDING_OUTCOME_SET,
  CLIENT_DIAG_ONBOARDING_SECRET_SET,
  CLIENT_DIAG_ONBOARDING_STEP_SET,
  CLIENT_DIAG_OWNER_ACTION_CODE_SET,
  CLIENT_DIAG_PER_KIND_ROW_CAP,
  CLIENT_DIAG_PROBE_OUTCOME_SET,
  CLIENT_DIAG_PROBE_SURFACE_SET,
  CLIENT_DIAG_REASON_CLASS_SET,
  CLIENT_DIAG_RECOVERY_CODE_SET,
  CLIENT_DIAG_RECOVERY_OP_SET,
  CLIENT_DIAG_REJECT_OUTCOME_SET,
  CLIENT_DIAG_RENDERER_MODE_SET,
  CLIENT_DIAG_ROLLBACK_CLASS_SET,
  CLIENT_DIAG_SCREEN_SET,
  CLIENT_DIAG_SKEW_CLASS_SET,
  CLIENT_DIAG_STORAGE_AREA_SET,
  CLIENT_DIAG_STORAGE_CLASS_SET,
  CLIENT_DIAG_STORAGE_OP_SET,
  CLIENT_DIAG_STORAGE_SURFACE_SET,
  CLIENT_DIAG_SURFACE_SET,
  CLIENT_DIAG_TRANSPORT_CLASS_SET,
  CLIENT_DIAG_WRITE_OUTCOME_SET,
  type ClientDiagAdminOp,
  type ClientDiagAnomaly,
  type ClientDiagApplyClass,
  type ClientDiagBootClass,
  type ClientDiagBuildCheckClass,
  type ClientDiagBulkAction,
  type ClientDiagCallClass,
  type ClientDiagCapability,
  type ClientDiagCapabilityOutcome,
  type ClientDiagCatalogueClass,
  type ClientDiagCeremonyFault,
  type ClientDiagCeremonyStep,
  type ClientDiagChannelReasonClass,
  type ClientDiagClaimResult,
  type ClientDiagContractClass,
  type ClientDiagCspBlocked,
  type ClientDiagCspDirective,
  type ClientDiagCspInlineOrigin,
  type ClientDiagDegradeCause,
  type ClientDiagDeleteFate,
  type ClientDiagDiscoveryOutcome,
  type ClientDiagDriftClass,
  type ClientDiagDrillAbort,
  type ClientDiagDrillFact,
  type ClientDiagDropSurface,
  type ClientDiagErrorClass,
  type ClientDiagFaultClass,
  type ClientDiagFaultSource,
  type ClientDiagFeatureClass,
  type ClientDiagFeatureOutcome,
  type ClientDiagFieldClass,
  type ClientDiagFieldFamily,
  type ClientDiagFocusOutcome,
  type ClientDiagFormField,
  type ClientDiagGateBlockClass,
  type ClientDiagGovGate,
  type ClientDiagHandoffClass,
  type ClientDiagHttpClass,
  type ClientDiagIntentClass,
  type ClientDiagKind,
  type ClientDiagMaterialClass,
  type ClientDiagnosticRecord,
  type ClientDiagnosticsPayload,
  type ClientDiagOnboardingOutcome,
  type ClientDiagOnboardingSecret,
  type ClientDiagOnboardingStep,
  type ClientDiagOwnerActionCode,
  type ClientDiagProbeOutcome,
  type ClientDiagProbeSurface,
  type ClientDiagReasonClass,
  type ClientDiagRecoveryCode,
  type ClientDiagRecoveryOp,
  type ClientDiagRendererMode,
  type ClientDiagRollbackClass,
  type ClientDiagScreen,
  type ClientDiagSkewClass,
  type ClientDiagStorageArea,
  type ClientDiagStorageClass,
  type ClientDiagStorageOp,
  type ClientDiagStorageSurface,
  type ClientDiagSurface,
  type ClientDiagTransportClass,
  type ClientDiagWriteOutcome,
  CONSOLE_BUILD_RE,
} from "./vocab.ts";

export {
  channelReasonClassFor,
  clampInt,
  clampNonNegInt,
  classifyChannelReason,
  currentScreen,
  errorClassForError,
  faultClassForError,
  faultClassForStatus,
  httpClassForRejection,
  httpClassForStatus,
  httpClassForThrown,
  isNavigationCancelled,
  screenFromPattern,
  setActiveScreen,
} from "./classify.ts";

// ---- the ring ----------------------------------------------------------------------------------------

// The coalescing key is the FULL closed tuple (D3), so a repeat of the same closed tuple increments a count
// rather than adding a row. Built only from frozen members, so the key itself is value-free.
//
// EVERY CLOSED FIELD MUST BE IN THIS KEY, and applyClass is here for a reason worth stating: a field that
// discriminates two outcomes but is left OUT of the key does not discriminate them at all. The two rows
// coalesce into one and the first one written wins the class, so the evidence silently reports the wrong
// ending. A row that looks specific and is not is the exact failure mode this campaign keeps finding.
function tupleKey(r: ClientDiagnosticRecord): string {
  return [
    r.kind,
    r.screen,
    r.httpClass ?? "",
    r.faultClass ?? "",
    r.driftClass ?? "",
    r.reasonClass ?? "",
    r.applyClass ?? "",
    // capability / surface / capabilityOutcome (G077). Left out of this key, they would discriminate NOTHING:
    // a refused recovery-codes download and a dead clipboard copy on the same screen would coalesce into one
    // row and the first one written would win the class. In the key, a refused identity.key download in the key
    // ceremony, a refused recovery-codes download and an absent clipboard are three rows that cannot be
    // mistaken for one another or for a console defect.
    r.capability ?? "",
    r.surface ?? "",
    r.capabilityOutcome ?? "",
    // Every one of these is a DISCRIMINATOR its gap was written for, so every one of them is in the key. Left
    // out, each would be silently destroyed by the coalescer: a build check that came back with the wrong
    // version and one that could not reach the origin at all would be one row wearing whichever class was
    // written first; a restore gate blocked because the client could not compute the plan hash would be the
    // same row as one blocked because the approver was the caller themselves; a run whose seal instant threw
    // mid-render would be the same row as a run whose record count arrived non-numeric. The whole point of
    // these fields is to tell those apart, and a field outside the key tells apart nothing.
    r.bootClass ?? "",
    r.buildCheckClass ?? "",
    r.rollbackClass ?? "",
    r.gateBlockClass ?? "",
    r.fieldClass ?? "",
    r.anomaly ?? "",
    r.errorClass ?? "",
    r.faultSource ?? "",
    // The G112/G122/G123/G125/G129 discriminators, in the key for the same reason as every field above it, and
    // each one would be destroyed by the coalescer if it were not: a CORS block and a genuine engine outage
    // would be one `transport-fault` row wearing whichever class was written first, which is the exact pair
    // the row exists to separate; the control-plane recovery read going quiet and the credentials-count read
    // going quiet would be one `read-degraded` row on whatever screen the operator happened to be on; a wizard
    // that could not reach the engine at the connect step and one whose readiness poll timed out would be one
    // `onboarding-step` row; an account that is empty and an account whose listings were refused for want of
    // scope would be one `discovery-connect` row, which is the confusion the whole gap is about; and a vendor
    // 5xx and the customer's own flaky wifi would be one `claim-exchange` row. A field outside this key tells
    // apart nothing.
    r.transportClass ?? "",
    r.callClass ?? "",
    r.obStep ?? "",
    r.obOutcome ?? "",
    // obSecret and channelReasonClass are in the key for the same reason as everything above, and each was
    // refuted for its absence. Outside the key, a poll that exhausted with the break-glass secret absent and one
    // that exhausted with the signer AND break-glass absent would be one `poll-exhausted` row wearing whichever
    // secret was written first, so a half-keyed engine and an install that never took would be the same evidence.
    // And an update channel whose signature has been failing for six weeks and one the engine simply could not
    // reach would be one `update-channel-unverified` row, which is the pair the kind exists to separate.
    r.obSecret ?? "",
    r.channelReasonClass ?? "",
    r.discoveryOutcome ?? "",
    r.claimResult ?? "",
    // The G171/G175/G177/G180 and G196/G214 discriminators. Same rule, same reason: outside this key they
    // discriminate nothing. A refused role-delete and a refused approval-policy save would be one `admin-write`
    // row wearing whichever op was written first; a rollback the engine turned down and a settle it never saw
    // would be one row; a "sign out everyone" that APPLIED and one that 500'd would be one row, which is the
    // exact question the compromise ticket asks. On the recovery side a pasted export that would not parse in
    // the browser and a break-glass token the engine rejected would be one row, and they are not even the same
    // half of the system.
    r.adminOp ?? "",
    r.writeOutcome ?? "",
    r.recoveryOp ?? "",
    r.recoveryCode ?? "",
    // The POSTURE-round discriminators (G229/G238/G240/G243/G250/G252/G254). The rule that governs every field
    // above governs these, and the coalescer would destroy each of them just as thoroughly if they were left
    // out: a restore whose Max records was discarded and one whose media token had no account beside it would
    // be ONE `intent-dropped` row wearing whichever class was written first; a destination verify that could
    // not reach the bucket and one whose delete probe was denied would be one `probe-outcome` row, and a
    // destination verify and an IdP test would be the SAME row without probeSurface, so the surface and the
    // outcome are BOTH in the key; a members table that 404s (the engine has not built it) and one that 500s
    // (the engine is broken and the console said "pending") would be one `feature-probe` row, which is the
    // exact conflation the kind exists to end; a greyed-out Delete and a skipped change-number prompt would be
    // one `gov-gate` row. And adminOp is already in this key ABOVE, which is what lets a gov-gate row say WHICH
    // control was greyed out without a second op field.
    r.intentClass ?? "",
    r.probeSurface ?? "",
    r.probeOutcome ?? "",
    r.formField ?? "",
    r.rejectOutcome ?? "",
    r.catalogueClass ?? "",
    r.featureClass ?? "",
    r.featureOutcome ?? "",
    r.govGate ?? "",
    r.skewClass ?? "",
    // The POSTURE-round discriminators (G256/G261/G284/G287/G289/G298). Same rule, same reason. Outside this key
    // a bulk DELETE that half-failed and a bulk RUN that half-failed are ONE row wearing whichever action was
    // written first, which is the exact pair G284 exists to separate; a pasted share refused for base64 PADDING
    // and one refused for a SMART QUOTE would be one `material-rejected` row, and they are different answers down
    // the phone; an unknown IdP preset and an unknown source-type id would be one `contract-skew` row, as would a
    // `connections` array that arrived MALFORMED and one that was simply ABSENT; and every count of a fleet-drill
    // session (targeted, passed, failed, skipped, retry-exhausted) would collapse into ONE number, with an
    // ABORTED session's counts summing silently into a clean session's. Every one of these fields is here.
    r.bulkAction ?? "",
    r.materialClass ?? "",
    r.contractClass ?? "",
    r.fieldFamily ?? "",
    r.drillAbort ?? "",
    r.drillFact ?? "",
    // The POSTURE-round discriminators (G300/G301/G304/G305/G308/G310/G328). Same rule, same reason, and each of
    // these would be destroyed by the coalescer exactly as thoroughly as the ones above it. Outside this key a
    // self-approval refusal and a not-owner refusal on the same inbox are ONE row wearing whichever code was
    // written first, and they are the maker-checker rule working versus a role that can never approve; the stale
    // hashed chunk the console's own policy blocked and a third-party injection attempt are one `csp-violation`
    // row, which is a broken pre-paint and a security incident told apart by nothing; a dropped SAML certificate
    // and a dropped coverage-inventory line are one row, as are the accepted count and the dropped count of the
    // same paste, so "one of two" and "one of nine" become the same evidence; a wizard that lost the ACCOUNT and
    // one that lost the BINDING are one row, and they fail on different source types; and a Shamir split that
    // died in WebCrypto and a recovery-codes copy the browser refused would be one `ceremony-step` row on the
    // keys screen, which is the exact conflation the kind exists to end. Every one of them is here.
    r.ownerActionCode ?? "",
    r.cspDirective ?? "",
    r.cspBlocked ?? "",
    // cspInlineOrigin + deleteFate (G304/G301). Outside this key the two states each was ADDED to separate would
    // coalesce straight back into the one row they came from: a stale pre-paint hash (a broken deploy) and an
    // injected inline script (an attack) are both {script-src, inline}, and a queued custom-role delete (nobody
    // floored) and an applied one (N people floored) are both role-delete-impact with the same count.
    r.cspInlineOrigin ?? "",
    r.deleteFate ?? "",
    r.dropSurface ?? "",
    r.dropFact ?? "",
    r.handoffClass ?? "",
    r.ceremonyStep ?? "",
    r.ceremonyOutcome ?? "",
    r.ceremonyFault ?? "",
    // The POSTURE-round discriminators (G336/G345). Same rule, same reason, and each of these would be destroyed
    // by the coalescer exactly as thoroughly as the ones above it. Outside this key a blocked localStorage and a
    // FULL sessionStorage are ONE `storage-blocked` row wearing whichever class was written first -- a browser
    // policy and a full disk, which are not even the same conversation -- and a lost wizard draft, a forgotten
    // engine URL and an auto-refresh that will not stay paused are one row, which is the exact three-symptom
    // conflation the gap is written about. On the map, a canvas the browser REFUSED and a static frame the
    // operator ASKED FOR would be one `renderer-degraded` row: one is a locked-down browser to unlock, the other
    // is an accessibility setting working as designed, and calling the second a fault is how a signal starts
    // crying wolf. Every one of them is here.
    r.storageArea ?? "",
    r.storageOp ?? "",
    r.storageClass ?? "",
    r.storageSurface ?? "",
    r.rendererMode ?? "",
    r.degradeCause ?? "",
    r.focusOutcome ?? "",
  ].join("|");
}

// rows is the ring: a keyed Map, so a push is an O(1) keyed increment and NOT a scan (D3: a 60fps redraw
// loop must not do O(ring) work in the hot path it is already thrashing). Map preserves insertion order,
// which gives the newest-wins eviction its "oldest first" order for free.
const rows = new Map<string, ClientDiagnosticRecord>();
// trueCountByKind is the per-kind UNCAPPED true count of coalesced events (D3), kept even for rows the caps
// evicted, so a kind that lost rows still registers as a number locally. The frozen wire shape carries only
// records[] and engineAttempts, so this rollup is not itself transmitted; the engine recomputes its own
// rollup over what it receives, and engineAttempts (uncapped, and ON the wire) is the denominator the bot
// actually reasons over (D4), so a cap loss degrades the detail, never the ratio.
const trueCountByKind = new Map<ClientDiagKind, number>();
// engineAttempts is the value-free denominator: every engine call attempted this session, success or
// failure (D4). A plain integer; it names nothing and identifies nothing.
let engineAttempts = 0;

// countRowsOfKind is the per-kind row count used by the caps. The ring is bounded at 128 rows, so this walk
// is bounded by a small constant and never grows with session length.
function countRowsOfKind(kind: ClientDiagKind): number {
  let n = 0;
  for (const r of rows.values()) if (r.kind === kind) n++;
  return n;
}

// evictOldestOfKind / evictOldestGlobal implement NEWEST-WINS: the oldest row (Map insertion order) is
// dropped to make room for a new tuple, so the ring keeps what happened most recently.
function evictOldestOfKind(kind: ClientDiagKind): void {
  for (const [key, r] of rows) {
    if (r.kind === kind) {
      rows.delete(key);
      return;
    }
  }
}

function evictOldestGlobal(): void {
  for (const key of rows.keys()) {
    rows.delete(key);
    return;
  }
}

// push admits ONE closed-class record. Every string on the candidate is checked by SET MEMBERSHIP against
// the frozen allowlist FIRST: a non-member fails the record CLOSED (it is dropped whole, never coerced to
// "other" and never clamped to the nearest member), which is what makes a smuggled value structurally
// impossible rather than merely unlikely. A repeat of the same tuple is an O(1) keyed increment.
export function push(candidate: ClientDiagnosticRecord, by = 1): void {
  if (!CLIENT_DIAG_KIND_SET.has(candidate.kind)) return;
  if (!CLIENT_DIAG_SCREEN_SET.has(candidate.screen)) return;
  if (candidate.httpClass !== undefined && !CLIENT_DIAG_HTTP_CLASS_SET.has(candidate.httpClass)) return;
  if (candidate.faultClass !== undefined && !CLIENT_DIAG_FAULT_CLASS_SET.has(candidate.faultClass)) return;
  if (candidate.driftClass !== undefined && !CLIENT_DIAG_DRIFT_CLASS_SET.has(candidate.driftClass)) return;
  if (candidate.reasonClass !== undefined && !CLIENT_DIAG_REASON_CLASS_SET.has(candidate.reasonClass)) return;
  if (candidate.applyClass !== undefined && !CLIENT_DIAG_APPLY_CLASS_SET.has(candidate.applyClass)) return;
  if (candidate.capability !== undefined && !CLIENT_DIAG_CAPABILITY_SET.has(candidate.capability)) return;
  if (candidate.surface !== undefined && !CLIENT_DIAG_SURFACE_SET.has(candidate.surface)) return;
  if (candidate.capabilityOutcome !== undefined && !CLIENT_DIAG_CAPABILITY_OUTCOME_SET.has(candidate.capabilityOutcome)) return;
  if (candidate.bootClass !== undefined && !CLIENT_DIAG_BOOT_CLASS_SET.has(candidate.bootClass)) return;
  if (candidate.buildCheckClass !== undefined && !CLIENT_DIAG_BUILD_CHECK_CLASS_SET.has(candidate.buildCheckClass)) return;
  if (candidate.rollbackClass !== undefined && !CLIENT_DIAG_ROLLBACK_CLASS_SET.has(candidate.rollbackClass)) return;
  if (candidate.gateBlockClass !== undefined && !CLIENT_DIAG_GATE_BLOCK_CLASS_SET.has(candidate.gateBlockClass)) return;
  if (candidate.fieldClass !== undefined && !CLIENT_DIAG_FIELD_CLASS_SET.has(candidate.fieldClass)) return;
  if (candidate.anomaly !== undefined && !CLIENT_DIAG_ANOMALY_SET.has(candidate.anomaly)) return;
  if (candidate.errorClass !== undefined && !CLIENT_DIAG_ERROR_CLASS_SET.has(candidate.errorClass)) return;
  if (candidate.faultSource !== undefined && !CLIENT_DIAG_FAULT_SOURCE_SET.has(candidate.faultSource)) return;
  if (candidate.transportClass !== undefined && !CLIENT_DIAG_TRANSPORT_CLASS_SET.has(candidate.transportClass)) return;
  if (candidate.callClass !== undefined && !CLIENT_DIAG_CALL_CLASS_SET.has(candidate.callClass)) return;
  if (candidate.obStep !== undefined && !CLIENT_DIAG_ONBOARDING_STEP_SET.has(candidate.obStep)) return;
  if (candidate.obOutcome !== undefined && !CLIENT_DIAG_ONBOARDING_OUTCOME_SET.has(candidate.obOutcome)) return;
  if (candidate.obSecret !== undefined && !CLIENT_DIAG_ONBOARDING_SECRET_SET.has(candidate.obSecret)) return;
  if (candidate.channelReasonClass !== undefined && !CLIENT_DIAG_CHANNEL_REASON_CLASS_SET.has(candidate.channelReasonClass)) return;
  if (candidate.discoveryOutcome !== undefined && !CLIENT_DIAG_DISCOVERY_OUTCOME_SET.has(candidate.discoveryOutcome)) return;
  if (candidate.claimResult !== undefined && !CLIENT_DIAG_CLAIM_RESULT_SET.has(candidate.claimResult)) return;
  if (candidate.adminOp !== undefined && !CLIENT_DIAG_ADMIN_OP_SET.has(candidate.adminOp)) return;
  if (candidate.writeOutcome !== undefined && !CLIENT_DIAG_WRITE_OUTCOME_SET.has(candidate.writeOutcome)) return;
  if (candidate.recoveryOp !== undefined && !CLIENT_DIAG_RECOVERY_OP_SET.has(candidate.recoveryOp)) return;
  if (candidate.recoveryCode !== undefined && !CLIENT_DIAG_RECOVERY_CODE_SET.has(candidate.recoveryCode)) return;
  if (candidate.intentClass !== undefined && !CLIENT_DIAG_INTENT_CLASS_SET.has(candidate.intentClass)) return;
  if (candidate.probeSurface !== undefined && !CLIENT_DIAG_PROBE_SURFACE_SET.has(candidate.probeSurface)) return;
  if (candidate.probeOutcome !== undefined && !CLIENT_DIAG_PROBE_OUTCOME_SET.has(candidate.probeOutcome)) return;
  if (candidate.formField !== undefined && !CLIENT_DIAG_FORM_FIELD_SET.has(candidate.formField)) return;
  if (candidate.rejectOutcome !== undefined && !CLIENT_DIAG_REJECT_OUTCOME_SET.has(candidate.rejectOutcome)) return;
  if (candidate.catalogueClass !== undefined && !CLIENT_DIAG_CATALOGUE_CLASS_SET.has(candidate.catalogueClass)) return;
  if (candidate.featureClass !== undefined && !CLIENT_DIAG_FEATURE_CLASS_SET.has(candidate.featureClass)) return;
  if (candidate.featureOutcome !== undefined && !CLIENT_DIAG_FEATURE_OUTCOME_SET.has(candidate.featureOutcome)) return;
  if (candidate.govGate !== undefined && !CLIENT_DIAG_GOV_GATE_SET.has(candidate.govGate)) return;
  if (candidate.skewClass !== undefined && !CLIENT_DIAG_SKEW_CLASS_SET.has(candidate.skewClass)) return;
  if (candidate.bulkAction !== undefined && !CLIENT_DIAG_BULK_ACTION_SET.has(candidate.bulkAction)) return;
  if (candidate.materialClass !== undefined && !CLIENT_DIAG_MATERIAL_CLASS_SET.has(candidate.materialClass)) return;
  if (candidate.contractClass !== undefined && !CLIENT_DIAG_CONTRACT_CLASS_SET.has(candidate.contractClass)) return;
  if (candidate.fieldFamily !== undefined && !CLIENT_DIAG_FIELD_FAMILY_SET.has(candidate.fieldFamily)) return;
  if (candidate.drillAbort !== undefined && !CLIENT_DIAG_DRILL_ABORT_SET.has(candidate.drillAbort)) return;
  if (candidate.drillFact !== undefined && !CLIENT_DIAG_DRILL_FACT_SET.has(candidate.drillFact)) return;
  if (candidate.ownerActionCode !== undefined && !CLIENT_DIAG_OWNER_ACTION_CODE_SET.has(candidate.ownerActionCode)) return;
  if (candidate.cspDirective !== undefined && !CLIENT_DIAG_CSP_DIRECTIVE_SET.has(candidate.cspDirective)) return;
  if (candidate.cspBlocked !== undefined && !CLIENT_DIAG_CSP_BLOCKED_SET.has(candidate.cspBlocked)) return;
  if (candidate.cspInlineOrigin !== undefined && !CLIENT_DIAG_CSP_INLINE_ORIGIN_SET.has(candidate.cspInlineOrigin)) return;
  if (candidate.deleteFate !== undefined && !CLIENT_DIAG_DELETE_FATE_SET.has(candidate.deleteFate)) return;
  if (candidate.dropSurface !== undefined && !CLIENT_DIAG_DROP_SURFACE_SET.has(candidate.dropSurface)) return;
  if (candidate.dropFact !== undefined && !CLIENT_DIAG_DROP_FACT_SET.has(candidate.dropFact)) return;
  if (candidate.handoffClass !== undefined && !CLIENT_DIAG_HANDOFF_CLASS_SET.has(candidate.handoffClass)) return;
  if (candidate.ceremonyStep !== undefined && !CLIENT_DIAG_CEREMONY_STEP_SET.has(candidate.ceremonyStep)) return;
  if (candidate.ceremonyOutcome !== undefined && !CLIENT_DIAG_CEREMONY_OUTCOME_SET.has(candidate.ceremonyOutcome)) return;
  if (candidate.ceremonyFault !== undefined && !CLIENT_DIAG_CEREMONY_FAULT_SET.has(candidate.ceremonyFault)) return;
  if (candidate.storageArea !== undefined && !CLIENT_DIAG_STORAGE_AREA_SET.has(candidate.storageArea)) return;
  if (candidate.storageOp !== undefined && !CLIENT_DIAG_STORAGE_OP_SET.has(candidate.storageOp)) return;
  if (candidate.storageClass !== undefined && !CLIENT_DIAG_STORAGE_CLASS_SET.has(candidate.storageClass)) return;
  if (candidate.storageSurface !== undefined && !CLIENT_DIAG_STORAGE_SURFACE_SET.has(candidate.storageSurface)) return;
  if (candidate.rendererMode !== undefined && !CLIENT_DIAG_RENDERER_MODE_SET.has(candidate.rendererMode)) return;
  if (candidate.degradeCause !== undefined && !CLIENT_DIAG_DEGRADE_CAUSE_SET.has(candidate.degradeCause)) return;
  if (candidate.focusOutcome !== undefined && !CLIENT_DIAG_FOCUS_OUTCOME_SET.has(candidate.focusOutcome)) return;

  // `by` is the increment (1 for a single fault; the number of items that did not complete for a bulk
  // outcome). It is clamped like every other numeric, so a nonsense increment cannot put an arbitrary value
  // on the wire, and an increment of 0 still records the ROW (the event happened; its magnitude was zero).
  const inc = clampNonNegInt(by);

  // The record is REBUILT from the checked members (an allowlist projection, never a spread of the
  // candidate), so an extra key the caller attached cannot ride along into the ring.
  const at = elapsedMs();
  const key = tupleKey(candidate);
  trueCountByKind.set(candidate.kind, clampNonNegInt((trueCountByKind.get(candidate.kind) ?? 0) + 1));

  const existing = rows.get(key);
  if (existing !== undefined) {
    existing.count = clampNonNegInt(existing.count + inc);
    existing.lastMs = at;
    return;
  }

  if (countRowsOfKind(candidate.kind) >= CLIENT_DIAG_PER_KIND_ROW_CAP) evictOldestOfKind(candidate.kind);
  if (rows.size >= CLIENT_DIAG_GLOBAL_ROW_CAP) evictOldestGlobal();

  const row: ClientDiagnosticRecord = {
    kind: candidate.kind,
    screen: candidate.screen,
    ...(candidate.httpClass !== undefined ? { httpClass: candidate.httpClass } : {}),
    ...(candidate.faultClass !== undefined ? { faultClass: candidate.faultClass } : {}),
    ...(candidate.driftClass !== undefined ? { driftClass: candidate.driftClass } : {}),
    ...(candidate.reasonClass !== undefined ? { reasonClass: candidate.reasonClass } : {}),
    ...(candidate.applyClass !== undefined ? { applyClass: candidate.applyClass } : {}),
    ...(candidate.capability !== undefined ? { capability: candidate.capability } : {}),
    ...(candidate.surface !== undefined ? { surface: candidate.surface } : {}),
    ...(candidate.capabilityOutcome !== undefined ? { capabilityOutcome: candidate.capabilityOutcome } : {}),
    ...(candidate.bootClass !== undefined ? { bootClass: candidate.bootClass } : {}),
    ...(candidate.buildCheckClass !== undefined ? { buildCheckClass: candidate.buildCheckClass } : {}),
    ...(candidate.rollbackClass !== undefined ? { rollbackClass: candidate.rollbackClass } : {}),
    ...(candidate.gateBlockClass !== undefined ? { gateBlockClass: candidate.gateBlockClass } : {}),
    ...(candidate.fieldClass !== undefined ? { fieldClass: candidate.fieldClass } : {}),
    ...(candidate.anomaly !== undefined ? { anomaly: candidate.anomaly } : {}),
    ...(candidate.errorClass !== undefined ? { errorClass: candidate.errorClass } : {}),
    ...(candidate.faultSource !== undefined ? { faultSource: candidate.faultSource } : {}),
    // THIS PROJECTION IS THE RING'S WRITE BOUNDARY, AND A FIELD MISSING FROM IT IS A FIELD THAT DOES NOT EXIST.
    // The row is rebuilt by allowlist (never a spread of the candidate), so a discriminator the recorder set and
    // this list omits is silently DROPPED here, and the pack then carries a row that looks specific and is not.
    // That is not hypothetical: transportClass, callClass, obStep, obOutcome, discoveryOutcome and claimResult
    // were all in the vocabulary, in the tuple key and in their recorders, and absent from this list and from
    // snapshot(), so an `origin-rejected` transport fault and an `engine-unreachable` one reached the pack as
    // two BYTE-IDENTICAL rows that did not even coalesce. Every closed field on the record must appear here, in
    // the tuple key, and in snapshot(). All three, or the evidence is dead.
    ...(candidate.transportClass !== undefined ? { transportClass: candidate.transportClass } : {}),
    ...(candidate.callClass !== undefined ? { callClass: candidate.callClass } : {}),
    ...(candidate.obStep !== undefined ? { obStep: candidate.obStep } : {}),
    ...(candidate.obOutcome !== undefined ? { obOutcome: candidate.obOutcome } : {}),
    ...(candidate.obSecret !== undefined ? { obSecret: candidate.obSecret } : {}),
    ...(candidate.channelReasonClass !== undefined ? { channelReasonClass: candidate.channelReasonClass } : {}),
    ...(candidate.discoveryOutcome !== undefined ? { discoveryOutcome: candidate.discoveryOutcome } : {}),
    ...(candidate.claimResult !== undefined ? { claimResult: candidate.claimResult } : {}),
    ...(candidate.adminOp !== undefined ? { adminOp: candidate.adminOp } : {}),
    ...(candidate.writeOutcome !== undefined ? { writeOutcome: candidate.writeOutcome } : {}),
    ...(candidate.recoveryOp !== undefined ? { recoveryOp: candidate.recoveryOp } : {}),
    ...(candidate.recoveryCode !== undefined ? { recoveryCode: candidate.recoveryCode } : {}),
    ...(candidate.intentClass !== undefined ? { intentClass: candidate.intentClass } : {}),
    ...(candidate.probeSurface !== undefined ? { probeSurface: candidate.probeSurface } : {}),
    ...(candidate.probeOutcome !== undefined ? { probeOutcome: candidate.probeOutcome } : {}),
    ...(candidate.formField !== undefined ? { formField: candidate.formField } : {}),
    ...(candidate.rejectOutcome !== undefined ? { rejectOutcome: candidate.rejectOutcome } : {}),
    ...(candidate.catalogueClass !== undefined ? { catalogueClass: candidate.catalogueClass } : {}),
    ...(candidate.featureClass !== undefined ? { featureClass: candidate.featureClass } : {}),
    ...(candidate.featureOutcome !== undefined ? { featureOutcome: candidate.featureOutcome } : {}),
    ...(candidate.govGate !== undefined ? { govGate: candidate.govGate } : {}),
    ...(candidate.skewClass !== undefined ? { skewClass: candidate.skewClass } : {}),
    ...(candidate.bulkAction !== undefined ? { bulkAction: candidate.bulkAction } : {}),
    ...(candidate.materialClass !== undefined ? { materialClass: candidate.materialClass } : {}),
    ...(candidate.contractClass !== undefined ? { contractClass: candidate.contractClass } : {}),
    ...(candidate.fieldFamily !== undefined ? { fieldFamily: candidate.fieldFamily } : {}),
    ...(candidate.drillAbort !== undefined ? { drillAbort: candidate.drillAbort } : {}),
    ...(candidate.drillFact !== undefined ? { drillFact: candidate.drillFact } : {}),
    ...(candidate.ownerActionCode !== undefined ? { ownerActionCode: candidate.ownerActionCode } : {}),
    ...(candidate.cspDirective !== undefined ? { cspDirective: candidate.cspDirective } : {}),
    ...(candidate.cspBlocked !== undefined ? { cspBlocked: candidate.cspBlocked } : {}),
    ...(candidate.cspInlineOrigin !== undefined ? { cspInlineOrigin: candidate.cspInlineOrigin } : {}),
    ...(candidate.deleteFate !== undefined ? { deleteFate: candidate.deleteFate } : {}),
    ...(candidate.dropSurface !== undefined ? { dropSurface: candidate.dropSurface } : {}),
    ...(candidate.dropFact !== undefined ? { dropFact: candidate.dropFact } : {}),
    ...(candidate.handoffClass !== undefined ? { handoffClass: candidate.handoffClass } : {}),
    ...(candidate.ceremonyStep !== undefined ? { ceremonyStep: candidate.ceremonyStep } : {}),
    ...(candidate.ceremonyOutcome !== undefined ? { ceremonyOutcome: candidate.ceremonyOutcome } : {}),
    ...(candidate.ceremonyFault !== undefined ? { ceremonyFault: candidate.ceremonyFault } : {}),
    ...(candidate.storageArea !== undefined ? { storageArea: candidate.storageArea } : {}),
    ...(candidate.storageOp !== undefined ? { storageOp: candidate.storageOp } : {}),
    ...(candidate.storageClass !== undefined ? { storageClass: candidate.storageClass } : {}),
    ...(candidate.storageSurface !== undefined ? { storageSurface: candidate.storageSurface } : {}),
    ...(candidate.rendererMode !== undefined ? { rendererMode: candidate.rendererMode } : {}),
    ...(candidate.degradeCause !== undefined ? { degradeCause: candidate.degradeCause } : {}),
    ...(candidate.focusOutcome !== undefined ? { focusOutcome: candidate.focusOutcome } : {}),
    count: inc,
    firstMs: at,
    lastMs: at,
  };
  rows.set(key, row);
}

// consoleBuild (G344) is the build this tab is running, seated ONCE at boot by app.ts from the build-time
// define. The ring does not import the version module itself, deliberately: the ring is a leaf that every
// screen imports, and pulling the version module into it moves the baked version literal out of the entry
// bundle and into a shared chunk (the bundle gate catches exactly that). The setter is the seam.
//
// It is re-validated HERE against the shape gate, not merely trusted from the caller: the ring's write
// boundary is the ring's own responsibility, exactly as it is for every closed member, and a value that is not
// version-shaped is DROPPED rather than truncated in.
let consoleBuild: string | null = null;
export function setConsoleBuild(build: string | null): void {
  consoleBuild = typeof build === "string" && CONSOLE_BUILD_RE.test(build) ? build : null;
}

// noteEngineAttempt increments the value-free denominator. Called once per engine call ATTEMPTED, before
// the outcome is known, so the ratio the bot computes has an honest denominator even when every call fails.
export function noteEngineAttempt(): void {
  engineAttempts = clampNonNegInt(engineAttempts + 1);
}

// recordEngineCall is the C1 emit: an engine call failed. The screen is the active compile-time literal;
// the classes come from the total pure mappers. Nothing else is passed, and nothing else could be.
export function recordEngineCall(httpClass: ClientDiagHttpClass, faultClass?: ClientDiagFaultClass): void {
  push({
    kind: "engine-call",
    screen: currentScreen(),
    httpClass,
    ...(faultClass !== undefined ? { faultClass } : {}),
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordContractDrift is the C2 emit: the console received a 2xx the engine's contract does not describe,
// and coerced it into something plausible (an unrecognised member of a closed field, a body that would not
// parse, an expected field absent, a route this console knows and this engine does not). ONLY THE CLASS
// TRAVELS (review B5): the offending value, the field name and any label are never read, so there is no
// field for them to occupy. Nothing here says WHICH field or WHICH value, deliberately.
export function recordContractDrift(driftClass: ClientDiagDriftClass): void {
  push({
    kind: "contract-drift",
    screen: currentScreen(),
    driftClass,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordBulkOutcome is the C3 emit: a bulk action finished with per-item failures that live ONLY in a
// dismissable dialog, so the evidence died with the dialog. COUNTS ONLY, never an item identity: the frozen
// record has a single numeric, so `count` carries the number of items that DID NOT COMPLETE (the magnitude
// support needs to size the fault), and `reasonClass` carries how the batch ended, which is what the
// attempted-versus-failed relation reduces to in a closed class: `all-failed` when every attempted item
// failed, `partial` when some succeeded, `auth` when a session expiry cut the batch short and the remainder
// was never attempted. The item names are the operator's own labels and never enter the ring.
// bulkReasonForCounts is the TOTAL, PURE classifier the bulk-failures dialog uses: a batch where nothing
// succeeded is `all-failed`, one where something did is `partial`. It reads only two integers, so there is
// nothing it could leak, and it is exported so the validator can drive the classification without a DOM.
export function bulkReasonForCounts(done: number, failed: number): ClientDiagReasonClass {
  return clampNonNegInt(done) > 0 && clampNonNegInt(failed) > 0 ? "partial" : "all-failed";
}

// bulkReasonForFailures is the producer `validation` and `server` never had, and the two states it separates
// have OPPOSITE remedies.
//
// Every bulk loop funnels its per-item failures through openBulkSummary, which classified the batch from the
// COUNTS ALONE: some succeeded (partial) or none did (all-failed). So a batch the engine REFUSED because the
// input was malformed, and a batch that died because the engine was DOWN, produced the identical row. One says
// "fix your input"; the other says "the engine is unavailable, retry". `validation` and `server` were declared
// for exactly this and no site could emit either: dead vocabulary, and the pack could not answer the ticket.
//
// It classifies by STATUS, not by counts, and the precedence is the point: a validation refusal is a FACT about
// the request the engine established and answered on, so it outranks a transient. It is a CLASSIFIER in the
// strict sense: it reads each failure's engine text ONLY through errorStatus, which returns a NUMBER or null and
// copies nothing, to SELECT a closed member and return that member. The reason text, the item names and the
// engine's prose never leave the browser.
//
// 401 is deliberately absent: a session expiry cuts the batch short and is already recorded as `auth` at the
// loop, with the items past that point never attempted, which is a different count as well as a different class.
export function bulkReasonForFailures(done: number, failures: ReadonlyArray<{ reason: string }>): ClientDiagReasonClass {
  const statuses = failures.map((f) => errorStatus(f.reason)).filter((s): s is number => s !== null);
  // The engine ANSWERED and refused the input. It saw the request and rejected it on its merits.
  if (statuses.some((s) => s >= 400 && s < 500 && s !== 401 && s !== 429)) return "validation";
  // The engine was unavailable, or the call never landed. Nothing about the input is established.
  if (statuses.some((s) => s >= 500)) return "server";
  return bulkReasonForCounts(done, failures.length);
}

// G284: bulkAction is REQUIRED, and it is the discriminator the kind was missing. Without it every bulk loop in
// the console produced the SAME tuple (bulk-outcome, downpipes, partial): a bulk delete that half-failed and a
// bulk run that half-failed coalesced into one row with a count of two, and "my bulk delete half-failed last
// Tuesday" was unanswerable from a pack that plainly contained a bulk-outcome row. It is passed by the CALL SITE
// (each loop knows which operation it is), never parsed out of the operator-facing verb the modal renders.
//
// It rides BESIDE the cause classification above, not instead of it: the action says WHICH loop, the reason class
// says WHY it failed, and a bulk delete refused for malformed input and a bulk delete that died on a 500 are two
// tickets with opposite remedies.
export function recordBulkOutcome(bulkAction: ClientDiagBulkAction, reasonClass: ClientDiagReasonClass, itemsNotCompleted: number): void {
  push(
    {
      kind: "bulk-outcome",
      screen: currentScreen(),
      bulkAction,
      reasonClass,
      count: 1,
      firstMs: 0,
      lastMs: 0,
    },
    clampNonNegInt(itemsNotCompleted),
  );
}

// recordSelectionDropped (G284) is the OTHER half of the bulk gap, and the half with no evidence anywhere at
// all. The data table drops the selection entries for rows that have VANISHED on a refresh, so an operator who
// ticked 20 downpipes and then watched a background poll land can click Delete and have 17 deleted. Every count
// the loop reports is then self-consistent (17 attempted, 17 done, 0 failed), the pack agrees with them, and the
// three that were never touched are nowhere.
//
// NOISE: this fires ONLY when a bulk action is CLICKED with rows already dropped from the live selection. The
// drop that follows a successful bulk delete is the rows correctly going away, and the selection is cleared in
// the same breath, which resets the counter before anything can read it. A legitimate state never records.
export function recordSelectionDropped(bulkAction: ClientDiagBulkAction, droppedCount: number): void {
  push(
    {
      kind: "bulk-outcome",
      screen: currentScreen(),
      bulkAction,
      reasonClass: "selection-dropped",
      count: 1,
      firstMs: 0,
      lastMs: 0,
    },
    clampNonNegInt(droppedCount),
  );
}

// applyClassForCounts is the TOTAL, PURE classifier for a live restore apply that the engine ANSWERED with an
// apply result. It reads two integers, the records the engine says it wrote and the records it says failed,
// and returns the frozen class that separates the four in-band endings. It reads nothing else, so there is
// nothing it could leak: a failure's `name` is a customer record name and its `reason` is engine text, and
// neither is touched.
//
// The pivot is `wrote-none`: written 0, failed 0. The engine answered an apply result, claimed no failure at
// all, and moved no data. Before this the console recorded NOTHING for it, and "nothing" was also what a
// clean full apply recorded and what an apply that never ran recorded, so the pack could not tell an
// operator's three retries against a restore that wrote nothing apart from a restore that worked first time.
export function applyClassForCounts(recordsRestored: number, failed: number): ClientDiagApplyClass {
  const wrote = clampNonNegInt(recordsRestored);
  const lost = clampNonNegInt(failed);
  if (lost === 0) return wrote > 0 ? "wrote-all" : "wrote-none";
  return wrote > 0 ? "wrote-some" : "wrote-none-all-failed";
}

// recordApplyOutcome is the G078 emit: ONE row per live-apply ending, on EVERY ending. `count` is how many
// applies ended this way (a plain repeat tally, D7: never a sequence number and never an attempt id), so an
// operator who pressed Apply three times against the same silent ending reads as a count of 3, and the client
// attempt count can be compared with the engine's own restore-apply audit events.
export function recordApplyOutcome(applyClass: ClientDiagApplyClass): void {
  push({
    kind: "apply-outcome",
    screen: "restore",
    applyClass,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordFanoutDegraded is the G025 emit: a bulk protect went ahead while the destination list was UNREADABLE,
// so every downpipe in the batch took the default destination and the operator's intended replicas were never
// created. The row's EXISTENCE carries both flags the gap asks for (the destination read failed, and the
// batch fell back to the default); an operator who deliberately chose the default produces no row, so the two
// states are no longer the same evidence. `count` is how many downpipes the batch created without their
// fan-out, which is the size of the redundancy the estate has silently lost. Never a destination id, a bucket
// or a name: there is no field for one.
export function recordFanoutDegraded(downpipesCreated: number): void {
  push(
    {
      kind: "fanout-degraded",
      screen: "sources",
      count: 1,
      firstMs: 0,
      lastMs: 0,
    },
    clampNonNegInt(downpipesCreated),
  );
}

// recordCapabilityFault records a browser capability the console asked for at a named point in the
// key or recovery ceremony, and did not get. The three closed classes ARE the record: WHAT the browser would
// not do, WHICH ceremony asked (so support knows what the customer has lost, which no route id can say), and
// WHETHER the capability was absent or present-and-refused.
//
// It is deliberately NOT `unhandled`. `unhandled` means a console defect nobody caught, its faultClass mapper
// answers "other" for a synthetic throw, and a row of {unhandled, keys, other} cannot be told apart from a
// null dereference. That row was the reason this gap was refuted twice. `count` is how many times the same
// refusal happened (a burst of ceremony files that were all refused reads as one row with a count), never a
// file name and never an index: the file NAME stays in the on-screen toast, which is where the operator needs
// it and where no pack can see it.
export function recordCapabilityFault(capability: ClientDiagCapability, surface: ClientDiagSurface, outcome: ClientDiagCapabilityOutcome): void {
  push({
    kind: "capability-fault",
    screen: currentScreen(),
    capability,
    surface,
    capabilityOutcome: outcome,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordBootFault is the C5 emit for the app-root boot path: the console failed to come up at all, which is
// the one fault the operator can least describe and support can least see (there is no screen to read an
// error off). The screen is the frozen `boot` sentinel, never a location read: the router has not resolved
// a route yet, so there is nothing to read even if we wanted to.
export function recordBootFault(faultClass: ClientDiagFaultClass): void {
  push({
    kind: "boot-fault",
    screen: "boot",
    faultClass,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordUnhandled is the C5 emit for a window unhandledrejection / onerror: a fault NOBODY caught, which is
// by definition a console defect rather than an expected outcome. The caller applies the noise filters
// first (window-faults.ts); this only records the frozen classes it is handed.
//
// faultSource and errorClass are the G217 discriminators. Without them every uncaught defect in the console
// reduced to {unhandled, <screen>, other}: an approvals screen frozen on skeleton rows because a render throw
// inside a .then had no .catch, and an unrelated synchronous fault on the same screen, were the same row and
// coalesced into it. faultSource says which of the two symptoms the customer is describing (a screen that never
// finishes loading, or a painted screen whose control died), and errorClass says what class of defect it was.
export function recordUnhandled(faultClass: ClientDiagFaultClass, faultSource: ClientDiagFaultSource, errorClass: ClientDiagErrorClass): void {
  push({
    kind: "unhandled",
    screen: currentScreen(),
    faultClass,
    faultSource,
    errorClass,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordBootClass is the G197 emit: a named BRING-UP step failed, rather than the app root throwing. The two
// members are the two silent ones: a lazy-chunk preload the update flow swallows by design, and a navigation
// bridge that was never installed (its defaults are no-ops, so every navigation is swallowed whole and nothing
// is thrown to catch). It carries bootClass and NO faultClass: the fault is the STEP, not an HTTP status, and a
// faultClass of "other" beside it would only invite the row to be read as a generic crash.
export function recordBootClass(bootClass: ClientDiagBootClass): void {
  push({
    kind: "boot-fault",
    screen: "boot",
    bootClass,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordDeepLinkLost is the producer the `deep-link-lost` kind never had. The kind was declared, the engine twin
// admitted it and the bot modelled it, and NO SITE COULD EMIT IT: dead vocabulary that reads like coverage, and
// the pack quietly told a support engineer this was looked for and not found.
//
// The fault is real and it is silent by design. router.notFound (app.ts) sends an unroutable path to Overview
// with a replace, so the customer who clicked a deep link in an alert e-mail lands on the dashboard and nothing
// anywhere says a link was lost. The state that matters is not the typo: it is a console version that RENAMED or
// REMOVED a route, after which every alert link already in flight dead-ends, silently, for everyone.
//
// REDACTION: the PATH IS NEVER RECORDED, and it is the whole reason this needs saying. An unroutable path is
// attacker- and customer-influenced and routinely carries a downpipe id or a customer label. The row carries the
// kind and the frozen `unknown-route` screen sentinel and nothing else, so the fact that a deep link was lost
// rides and the link itself never does. The count is the diagnosis: one is a mistyped URL, and a burst across a
// version change is a broken route.
export function recordDeepLinkLost(): void {
  push({
    kind: "deep-link-lost",
    screen: "unknown-route", // the frozen total-mapper sentinel: it never echoes the location
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordConsoleBuildCheck is the G153 emit: WHAT BUILD THE BROWSER IS BEING SERVED, which no engine-side field
// can answer (the engine cannot probe a console behind Access). Recorded on EVERY outcome including `confirmed`,
// so the absence of a row after an applied console update is itself a fact rather than an ambiguity. The screen
// is the frozen `updates` literal: the check runs from the licence screen, and it is the update the row is
// about. No version string travels: a version is not a member of any closed union, and the CLASS is what the
// ticket turns on ("the origin is serving a different build" / "the bundle carries no stamp at all").
export function recordConsoleBuildCheck(buildCheckClass: ClientDiagBuildCheckClass): void {
  push({
    kind: "console-build-check",
    screen: "updates",
    buildCheckClass,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordConsoleRollback is the G153 emit for the recovery half: the operator pressed the post-apply console
// rollback, and this is how it ended. The row's EXISTENCE is "a rollback was attempted"; `not-sent` is the
// member the engine can never record, because a rollback POST that never arrived leaves no engine-side rollback
// record to find.
export function recordConsoleRollback(rollbackClass: ClientDiagRollbackClass): void {
  push({
    kind: "console-rollback",
    screen: "updates",
    rollbackClass,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordIdentityUnresolved is the G155/G123 emit: the caller's identity report did not resolve, so every
// client-side capability gate fell back to `viewer` and an actual Owner is looking at a console where nothing is
// enabled. A 401 never reaches here (the caller filters it): a lapsed session is the ordinary state the
// signed-out route exists for, and recording it would fabricate a fault every time one expires.
//
// httpClass separates an engine that REFUSED the read (4xx/5xx) from one that could not be REACHED
// (network/timeout). faultClass IS THE SECOND HALF AND IT IS NOT OPTIONAL, which is why G123 was refuted:
// httpClassForStatus collapses 401, 403 and 404 alike to "4xx", so a whoami 404 -- an OLDER ENGINE THAT DOES NOT
// SERVE THE ROUTE AT ALL, which the console's own comment names as the cause of the "identity pending" chip in
// the ticket -- and a whoami 403 produced the byte-identical row {identity-unresolved, screen, 4xx} and coalesced
// into it. faultClassForStatus maps 404 to "not-found" and 401/403 to "auth", so route-absent (upgrade the engine)
// and refused (fix the caller's access) are two rows. Both fields are in the tuple key.
export function recordIdentityUnresolved(httpClass: ClientDiagHttpClass, err: unknown): void {
  push({
    kind: "identity-unresolved",
    screen: currentScreen(),
    httpClass,
    faultClass: faultClassForError(err),
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordIdentityStaleGate is the OTHER G155 emit, and it is the one that closes the gap. recordIdentityUnresolved
// only fires when whoami THROWS. The commoner state, and the one the ticket describes, is a RACE in which nothing
// throws at all: router.start() paints the first screen before the boot-time whoami round trip returns, every
// capability gate on that render reads caller()?.role ?? "viewer", and when the identity later lands nothing
// re-renders the screen. An actual Owner deep-linking to /security sees every control greyed "owner only", the
// whoami read SUCCEEDED, and the pack carried no row of any kind, which made it BYTE-IDENTICAL to the pack of a
// genuine viewer. That is exactly the confusion the gap exists to end, and no httpClass can express it because
// there is no HTTP failure to classify.
//
// The row records ONE fact: the gates on `screen` were computed BEFORE the identity report arrived. It records
// NOTHING about the role that eventually came back -- the caller's role is a customer value, and a row emitted
// only for a high role would leak a bit of it. A screen whose gates were computed AFTER the identity landed
// produces no row, so the genuine viewer and the raced Owner are no longer the same evidence.
//
// It is latched per screen by the caller (setup-state of the gate, not of the ring), so a screen the operator
// revisits after identity has resolved cannot inflate the count with rows about a race that did not happen.
export function recordIdentityStaleGate(screen: ClientDiagScreen): void {
  push({
    kind: "identity-stale-gate",
    screen,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordUpdateChannelUnverified is the G171 emit: the engine consulted the update channel and the verdict came
// back NOT VERIFIED. The console has always held this fact and always thrown it away -- app-refresh.ts reads
// `if (!upd.configured || !upd.verified) return null;` and silently hides the chip -- so a channel whose signature
// has been failing for six weeks and a healthy channel with nothing new to offer BOTH showed no chip, and the pack
// was identical: status.updateChannelConfigured is an env-var presence check that stays true throughout, so it is
// not a verdict. The operator is two releases behind and nothing anywhere says why.
//
// Only the UNVERIFIED verdict is recorded. A verified channel is the product working, and a row on every refresh
// of a healthy engine is how a signal stops being read. So the row's EXISTENCE is the fault and its
// channelReasonClass is the remedy; a healthy channel produces no row, and the two states are different evidence.
export function recordUpdateChannelUnverified(channelReasonClass: ClientDiagChannelReasonClass): void {
  push({
    kind: "update-channel-unverified",
    screen: "updates",
    channelReasonClass,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordRestoreGateBlocked is the G198 emit: the console kept Apply disabled, and WHY. The class is the whole
// row. The caller records only the four FAULT states; a plan that is simply still awaiting its second approver
// is the ceremony working, and is never recorded (the approval-poll would otherwise write a row every five
// seconds of a perfectly healthy dual-control wait).
export function recordRestoreGateBlocked(gateBlockClass: ClientDiagGateBlockClass): void {
  push({
    kind: "restore-gate-blocked",
    screen: "restore",
    gateBlockClass,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordWireAnomaly is the G216 emit: an engine-supplied value the console could not use. fieldClass says which
// CLASS of field, `anomaly` says how it was wrong, and the value itself has no field to travel in, which is the
// point: a malformed URL or a malformed id can embed customer data, and it is precisely the value we do not
// trust. `render-threw` is the one that costs the operator a screen (a malformed instant thrown out of a Date
// conversion takes the whole run drawer with it, so one row opens to nothing while every other row is fine).
export function recordWireAnomaly(fieldClass: ClientDiagFieldClass, anomaly: ClientDiagAnomaly): void {
  push({
    kind: "wire-anomaly",
    screen: currentScreen(),
    fieldClass,
    anomaly,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordTransportFault is the G122/G145/G147 emit: the console's OWN transport classification, which until now
// was computed, rendered to a card, and dropped. It is called from components/error-view.ts blockError, the ONE
// rendering seam every screen routes a channel-two (transport/auth) error through, so a screen cannot forget it
// the way 36 individual catch sites could.
//
// blockError is also the only place in the console that knows the CORS fingerprint. It resolves
// `origin-rejected` from a network throw PLUS a caller-confirmed reachable health probe, and nothing else in
// the console holds both halves of that fact at once. That is the whole reason this recorder lives at the
// render site and not at the fetch seam: at the fetch seam a CORS block and an outage are the same TypeError.
//
// It takes a CLASS, never an error: no message, name, code or stack is read here at all.
export function recordTransportFault(transportClass: ClientDiagTransportClass): void {
  push({
    kind: "transport-fault",
    screen: currentScreen(),
    transportClass,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordReadDegraded is the G122/G123 emit: a fire-and-forget engine read failed and was swallowed into a
// degraded chip or a fail-open gate. callClass names WHICH read went quiet (the screen cannot: these fire from
// wherever the operator happens to be), and httpClass/faultClass say how, so "the browser saw the control-plane
// status 404 twelve times" is distinguishable from an engine that logged no inbound request at all.
//
// An ABORTED call is not recorded: a navigation or an unmount cancelled it, which is not a Downpipes fault
// (the same exclusion recordEngineCall makes).
export function recordReadDegraded(callClass: ClientDiagCallClass, err: unknown): void {
  const httpClass = httpClassForThrown(err);
  if (httpClass === "aborted") return;
  push({
    kind: "read-degraded",
    screen: currentScreen(),
    callClass,
    httpClass,
    faultClass: faultClassForError(err),
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordOnboardingStep is the G125 emit: one row per step ENDING, including the good ones, so a wizard the
// operator never got through is legible by what is MISSING as well as by what is there. The screen is pinned to
// `boot`, not currentScreen(): the wizard runs before the router has settled on a product route on a fresh
// engine, and a step outcome that landed under whatever route happened to be active would not be findable.
//
// obSecret is the G125 discriminator on the readiness poll, and it is optional because it is meaningful on
// exactly one ending. At `poll-exhausted` the caller emits ONE ROW PER SECRET the engine kept reporting absent,
// so a HALF-KEYED engine (the ceremony wrote the signer and then failed) writes one row and an install that never
// took at all writes two or three. Without it both were {onboarding-step, boot, readiness-poll, poll-exhausted},
// one row, one count, and the operator's "it sat on Waiting for two minutes" was the same sentence for both.
export function recordOnboardingStep(obStep: ClientDiagOnboardingStep, obOutcome: ClientDiagOnboardingOutcome, obSecret?: ClientDiagOnboardingSecret): void {
  push({
    kind: "onboarding-step",
    screen: "boot",
    obStep,
    obOutcome,
    ...(obSecret !== undefined ? { obSecret } : {}),
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordDiscoveryConnect is the G129 (console half) emit: what the account-discovery token actually SAW. It
// takes a CLASS. The Cloudflare listing-error prose the screen renders is never read here, because it can name
// an account, a bucket or a namespace; only the fact that such errors EXIST rides, which is the discriminator
// the ticket needs (a scope gap and an empty account are otherwise the same silence).
export function recordDiscoveryConnect(discoveryOutcome: ClientDiagDiscoveryOutcome): void {
  push({
    kind: "discovery-connect",
    screen: "sources",
    discoveryOutcome,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordClaimExchange is the G112 emit: how the licence claim-code exchange with the vendor control plane ended.
// It is pinned to the `settings` screen, which is where the licence activation form lives; the class is the
// whole discriminator anyway. The claim code, the response body and the control-plane URL have no field to
// travel in.
export function recordClaimExchange(claimResult: ClientDiagClaimResult): void {
  push({
    kind: "claim-exchange",
    screen: "settings",
    claimResult,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// writeOutcomeForStatus is the TOTAL, PURE mapper from an HTTP status to the closed write outcome. It reads
// ONE integer and nothing else: not the body, not a header, not the engine's refusal sentence. Total by
// construction, so there is no status on which a privileged write ends in an unrecorded class.
//
// The 4xx split is deliberately coarse, and the reason is honesty rather than laziness: the engine answers 400
// for the last-Owner guard, the last-passkey guard and a plain shape refusal alike, and the only thing that
// separates them is its prose. Guessing a guard identity out of that prose would produce a row that names a
// specific guard and is wrong the moment the engine rewords itself, which is worse than a row that says plainly
// that the engine refused. The guard identity is the engine's own to record, next to the guard that fired.
export function writeOutcomeForStatus(status: number): ClientDiagWriteOutcome {
  if (status >= 200 && status < 300) return "applied";
  if (status === 401 || status === 403) return "denied-role";
  if (status === 404 || status === 409 || status === 412) return "conflict";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server-error";
  return "refused-validation";
}

// recordAdminWrite records a PRIVILEGED WRITE ending. adminOp comes from the CALL SITE
// (which knows exactly which write it is making) and writeOutcome from the numeric status, so no URL, no body
// and no refusal text is read on this path.
//
// An `applied` outcome is recorded ONLY for the ops in ADMIN_OPS_RECORDING_SUCCESS, where "did it actually
// take" IS the ticket. Everything else records only its failures, so a healthy console produces NO admin-write
// row at all: a row in the pack always means a privileged write did not go through, and the per-kind cap is
// never spent on good news that would evict the refusals underneath it.
export function recordAdminWrite(adminOp: ClientDiagAdminOp, writeOutcome: ClientDiagWriteOutcome): void {
  if (writeOutcome === "applied" && !ADMIN_OPS_RECORDING_SUCCESS.has(adminOp)) return;
  push({
    kind: "admin-write",
    screen: currentScreen(),
    adminOp,
    writeOutcome,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// recordAdminWriteThrown is the same emit for the leg the ENGINE CANNOT HAVE: the fetch threw, so the engine
// never saw the write and no engine-side record of it can ever exist. An ABORTED call is not recorded (a
// navigation or an unmount cancelled it, which is not a Downpipes fault, and is the same exclusion
// recordEngineCall and recordReadDegraded make).
export function recordAdminWriteThrown(adminOp: ClientDiagAdminOp, err: unknown): void {
  if (httpClassForThrown(err) === "aborted") return;
  recordAdminWrite(adminOp, "unreachable");
}

// recordRecoveryRefusal is the G196/G214 emit: a disaster-recovery flow was refused. The code is the frozen
// DP-R token the console has ALREADY stamped into the sentence the operator is reading, handed in as a typed
// member by the site that chose it; it is never parsed back out of the message (the message is prose, and on
// the engine branches it carries the engine's own reason, which can name a bucket or a key).
export function recordRecoveryRefusal(recoveryOp: ClientDiagRecoveryOp, recoveryCode: ClientDiagRecoveryCode): void {
  push({
    kind: "recovery-refusal",
    screen: currentScreen(),
    recoveryOp,
    recoveryCode,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// snapshot returns the ring as the POST payload, oldest to newest (ring order; the per-kind cap is
// newest-wins, so the ring already holds the most recent tuples). The records are COPIES, so a caller
// cannot mutate the live ring, and each is rebuilt by allowlist projection.
export function snapshot(): ClientDiagnosticsPayload {
  const records: ClientDiagnosticRecord[] = [];
  for (const r of rows.values()) {
    records.push({
      kind: r.kind,
      screen: r.screen,
      ...(r.httpClass !== undefined ? { httpClass: r.httpClass } : {}),
      ...(r.faultClass !== undefined ? { faultClass: r.faultClass } : {}),
      ...(r.driftClass !== undefined ? { driftClass: r.driftClass } : {}),
      ...(r.reasonClass !== undefined ? { reasonClass: r.reasonClass } : {}),
      ...(r.applyClass !== undefined ? { applyClass: r.applyClass } : {}),
      ...(r.capability !== undefined ? { capability: r.capability } : {}),
      ...(r.surface !== undefined ? { surface: r.surface } : {}),
      ...(r.capabilityOutcome !== undefined ? { capabilityOutcome: r.capabilityOutcome } : {}),
      ...(r.bootClass !== undefined ? { bootClass: r.bootClass } : {}),
      ...(r.buildCheckClass !== undefined ? { buildCheckClass: r.buildCheckClass } : {}),
      ...(r.rollbackClass !== undefined ? { rollbackClass: r.rollbackClass } : {}),
      ...(r.gateBlockClass !== undefined ? { gateBlockClass: r.gateBlockClass } : {}),
      ...(r.fieldClass !== undefined ? { fieldClass: r.fieldClass } : {}),
      ...(r.anomaly !== undefined ? { anomaly: r.anomaly } : {}),
      ...(r.errorClass !== undefined ? { errorClass: r.errorClass } : {}),
      ...(r.faultSource !== undefined ? { faultSource: r.faultSource } : {}),
      // The SECOND allowlist projection, and the second place a field can silently vanish (see the note in
      // push()). It must carry every closed field the record has, or a discriminator that survived the ring
      // still never reaches the pack.
      ...(r.transportClass !== undefined ? { transportClass: r.transportClass } : {}),
      ...(r.callClass !== undefined ? { callClass: r.callClass } : {}),
      ...(r.obStep !== undefined ? { obStep: r.obStep } : {}),
      ...(r.obOutcome !== undefined ? { obOutcome: r.obOutcome } : {}),
      ...(r.obSecret !== undefined ? { obSecret: r.obSecret } : {}),
      ...(r.channelReasonClass !== undefined ? { channelReasonClass: r.channelReasonClass } : {}),
      ...(r.discoveryOutcome !== undefined ? { discoveryOutcome: r.discoveryOutcome } : {}),
      ...(r.claimResult !== undefined ? { claimResult: r.claimResult } : {}),
      ...(r.adminOp !== undefined ? { adminOp: r.adminOp } : {}),
      ...(r.writeOutcome !== undefined ? { writeOutcome: r.writeOutcome } : {}),
      ...(r.recoveryOp !== undefined ? { recoveryOp: r.recoveryOp } : {}),
      ...(r.recoveryCode !== undefined ? { recoveryCode: r.recoveryCode } : {}),
      ...(r.intentClass !== undefined ? { intentClass: r.intentClass } : {}),
      ...(r.probeSurface !== undefined ? { probeSurface: r.probeSurface } : {}),
      ...(r.probeOutcome !== undefined ? { probeOutcome: r.probeOutcome } : {}),
      ...(r.formField !== undefined ? { formField: r.formField } : {}),
      ...(r.rejectOutcome !== undefined ? { rejectOutcome: r.rejectOutcome } : {}),
      ...(r.catalogueClass !== undefined ? { catalogueClass: r.catalogueClass } : {}),
      ...(r.featureClass !== undefined ? { featureClass: r.featureClass } : {}),
      ...(r.featureOutcome !== undefined ? { featureOutcome: r.featureOutcome } : {}),
      ...(r.govGate !== undefined ? { govGate: r.govGate } : {}),
      ...(r.skewClass !== undefined ? { skewClass: r.skewClass } : {}),
      ...(r.bulkAction !== undefined ? { bulkAction: r.bulkAction } : {}),
      ...(r.materialClass !== undefined ? { materialClass: r.materialClass } : {}),
      ...(r.contractClass !== undefined ? { contractClass: r.contractClass } : {}),
      ...(r.fieldFamily !== undefined ? { fieldFamily: r.fieldFamily } : {}),
      ...(r.drillAbort !== undefined ? { drillAbort: r.drillAbort } : {}),
      ...(r.drillFact !== undefined ? { drillFact: r.drillFact } : {}),
      ...(r.ownerActionCode !== undefined ? { ownerActionCode: r.ownerActionCode } : {}),
      ...(r.cspDirective !== undefined ? { cspDirective: r.cspDirective } : {}),
      ...(r.cspBlocked !== undefined ? { cspBlocked: r.cspBlocked } : {}),
      ...(r.cspInlineOrigin !== undefined ? { cspInlineOrigin: r.cspInlineOrigin } : {}),
      ...(r.deleteFate !== undefined ? { deleteFate: r.deleteFate } : {}),
      ...(r.dropSurface !== undefined ? { dropSurface: r.dropSurface } : {}),
      ...(r.dropFact !== undefined ? { dropFact: r.dropFact } : {}),
      ...(r.handoffClass !== undefined ? { handoffClass: r.handoffClass } : {}),
      ...(r.ceremonyStep !== undefined ? { ceremonyStep: r.ceremonyStep } : {}),
      ...(r.ceremonyOutcome !== undefined ? { ceremonyOutcome: r.ceremonyOutcome } : {}),
      ...(r.ceremonyFault !== undefined ? { ceremonyFault: r.ceremonyFault } : {}),
      ...(r.storageArea !== undefined ? { storageArea: r.storageArea } : {}),
      ...(r.storageOp !== undefined ? { storageOp: r.storageOp } : {}),
      ...(r.storageClass !== undefined ? { storageClass: r.storageClass } : {}),
      ...(r.storageSurface !== undefined ? { storageSurface: r.storageSurface } : {}),
      ...(r.rendererMode !== undefined ? { rendererMode: r.rendererMode } : {}),
      ...(r.degradeCause !== undefined ? { degradeCause: r.degradeCause } : {}),
      ...(r.focusOutcome !== undefined ? { focusOutcome: r.focusOutcome } : {}),
      count: clampNonNegInt(r.count),
      firstMs: clampInt(r.firstMs),
      lastMs: clampInt(r.lastMs),
    });
  }
  // consoleBuild (G344) rides on the ENVELOPE, not on a record: it is a property of the SESSION (which build
  // this tab is running), not of any one fault, and putting it on every row would be 128 copies of one fact. It
  // is admitted only when it satisfies CONSOLE_BUILD_RE; an unstamped build (a Node validator run) sends the
  // field ABSENT rather than a placeholder, because "we do not know which console this was" is the honest
  // answer and a fabricated one would be worse than none.
  const payload: ClientDiagnosticsPayload = { records, engineAttempts: clampNonNegInt(engineAttempts) };
  if (consoleBuild !== null) payload.consoleBuild = consoleBuild;
  return payload;
}

// packPayload is what the support screen hands to the engine at pack generation: the snapshot, bounded to
// the engine's pre-parse body cap (D1: the engine caps Content-Length BEFORE it parses and answers a larger
// body with a 400, so the console must never send one). The ring's own caps already hold the section to
// about 13 KB, so this bound is a backstop, not the working limit; when it does bite it drops the OLDEST
// rows first, keeping the most recent evidence. engineAttempts always survives, so the bot keeps its
// denominator (D4) even in the pathological case.
export function packPayload(): ClientDiagnosticsPayload {
  const payload = snapshot();
  while (payload.records.length > 0 && payloadBytes(payload) > CLIENT_DIAG_MAX_BODY_BYTES) payload.records.shift();
  return payload;
}

// payloadBytes is the exact wire size of the POST body the api layer will send, so the bound above is
// measured against what the engine actually receives, not an estimate of it.
function payloadBytes(payload: ClientDiagnosticsPayload): number {
  return new TextEncoder().encode(JSON.stringify({ clientDiagnostics: payload })).length;
}

// rollupByKind is the per-kind uncapped true count (D3). Exported for the validator, which proves a kind
// that lost rows to the cap still registers its true total.
export function rollupByKind(): Partial<Record<ClientDiagKind, number>> {
  const out: Partial<Record<ClientDiagKind, number>> = {};
  for (const [kind, n] of trueCountByKind) out[kind] = n;
  return out;
}

// reset clears the ring. Called after a support pack is generated (the ring's evidence has been handed to
// the pack, so holding it again would double-count it into the NEXT pack) and available to the validator.
export function reset(): void {
  rows.clear();
  trueCountByKind.clear();
  engineAttempts = 0;
}

// ---- posture-round recorders -------------------------------------

// recordIntentDropped (G229): the restore request builder DISCARDED something the operator typed. The engine
// never sees the dropped intent, so this row is the only possible witness. The class is chosen by the builder,
// which is the one place that knows what it dropped; the typed value (a Cloudflare edit token, an account id, a
// database name) has no field on the record and cannot ride.
export function recordIntentDropped(intentClass: ClientDiagIntentClass): void {
  push({ kind: "intent-dropped", screen: currentScreen(), intentClass, count: 0, firstMs: elapsedMs(), lastMs: elapsedMs() });
}

// recordProbeOutcome (G238): one operator-initiated test and how it ended. `ok` is recorded as well as the
// failures, and must be: the ticket is nearly always "it fails every morning and works on retry", which is a
// claim about a ratio, and a ring of failures alone cannot confirm or deny it.
export function recordProbeOutcome(probeSurface: ClientDiagProbeSurface, probeOutcome: ClientDiagProbeOutcome): void {
  push({ kind: "probe-outcome", screen: currentScreen(), probeSurface, probeOutcome, count: 0, firstMs: elapsedMs(), lastMs: elapsedMs() });
}

// DestVerifyResult is the engine's OWN DISCRIMINATED UNION for POST /admin/destination/verify, restated here so
// the compiler enforces the discrimination the classifier depends on. The console used to re-declare this
// response as a FLATTENED `{ ok: boolean; reason?: string; deleteProbe?: "ok"|"denied"; ... }`, and that flat
// shape is what hid the G238 defect from tsc: it made `deleteProbe` look reachable on the failure arm (it is
// not) and made `ok:true` look like it could not carry a denied delete (it can, and that is the WORM case).
// Keeping the union means a future re-ordering of destProbeOutcome's arms is a type error, not a silent
// unreachable branch.
export type DestVerifyResult =
  | { ok: true; deleteProbe?: "ok" | "denied"; objectLock?: "enforced" | "not-enforced" | "unknown"; ms?: number; source?: "console" | "deploy"; reason?: undefined }
  | { ok: false; reason?: string; deleteProbe?: undefined; ms?: number; source?: "console" | "deploy" };

// destProbeOutcome maps a destination verify RESULT to a closed member. The deleteProbe verdict and the ok flag
// are read from the SHAPE; `reason` is read ONLY to select a member and is never copied anywhere.
//
// THE DELETE PROBE IS TESTED BEFORE `ok`, AND THAT ORDER IS THE WHOLE POINT. A refused
// cleanup delete DOES NOT FAIL THE PROBE: the engine catches the delete throw, sets deleteProbe:"denied" and
// returns { ok: TRUE, deleteProbe: "denied", ... } (engine router-posture.ts probeDestination). `deleteProbe`
// exists ONLY on the ok:true arm of the engine's union; the ok:false arm carries a reason and no deleteProbe at
// all. So the previous order -- `if (res.ok) return "ok"` first -- made dest-delete-denied unreachable on every
// response the engine can produce, and it folded the WORM/retention bucket (writes accepted, deletes refused,
// so the customer's retention CANNOT BE MANAGED) into the same coalesced row as a perfectly healthy verify.
// A bucket whose lifecycle is stuck and a bucket that is fine are opposite tickets and must never share a row.
export function destProbeOutcome(res: DestVerifyResult): ClientDiagProbeOutcome {
  if (res.ok === true) return res.deleteProbe === "denied" ? "dest-delete-denied" : "ok";
  const r = typeof res.reason === "string" ? res.reason : "";
  if (/\b(?:unauthoris|unauthoriz|forbidden|denied|credential|signature|access ?key|401|403)/i.test(r)) return "dest-auth";
  // A mis-regioned bucket: S3 answers a request signed for the wrong region with a 301 PermanentRedirect, and
  // the engine turns that into its own "the destination redirected the request..." sentence. It matched none of
  // the other arms and landed in dest-other alongside every unclassified fault, yet it is one of the three most
  // common destination faults and its remedy (set the region) is unlike any of them.
  if (/\bredirect\b|\b301\b|\bregion\b/i.test(r)) return "dest-region-mismatch";
  if (/\b(?:network|fetch|timed? ?out|unreachable|ENOTFOUND|ECONNRE|dns|socket|tls)/i.test(r)) return "dest-unreachable";
  if (/\b(?:put|write|upload)/i.test(r)) return "dest-write-probe-failed";
  return "dest-other";
}

// idpProbeOutcome maps an IdP test RESULT to a closed member by reading the engine's own per-check NAMES (its
// frozen check vocabulary) and the pass/warn/fail status beside each. The check `detail` line, which carries the
// certificate subject and the discovery URL, is never read at all. A `warn` is not a failure and never produces
// a fault member: the probe passed, and recording it as a fault would report a healthy connection as a broken one.
export function idpProbeOutcome(res: { ok: boolean; checks?: { name: string; status: "pass" | "warn" | "fail" }[] }): ClientDiagProbeOutcome {
  if (res.ok) return "ok";
  const failed = (res.checks ?? []).filter((c) => c.status === "fail").map((c) => c.name);
  if (failed.some((n) => /discovery/i.test(n))) return "idp-discovery-failed";
  if (failed.some((n) => /jwks|key/i.test(n))) return "idp-jwks-failed";
  if (failed.some((n) => /cert/i.test(n))) return "idp-cert-failed";
  if (failed.some((n) => /metadata/i.test(n))) return "idp-metadata-failed";
  return "idp-other";
}

// pushProbeOutcome maps a SIEM/push test RESULT to a closed member. httpStatus is a NUMBER on the wire, so the
// 4xx/5xx split needs no text at all; `reason` is read only to separate the engine's own egress refusal (the
// endpoint was never called: an allowlist decision, not a vendor fault) from a timeout. The endpoint, the
// vendor's response body and its headers have no field here.
export function pushProbeOutcome(res: { ok: boolean; httpStatus?: number; reason?: string }): ClientDiagProbeOutcome {
  if (res.ok) return "ok";
  const st = typeof res.httpStatus === "number" && Number.isFinite(res.httpStatus) ? res.httpStatus : null;
  if (st !== null && st >= 400 && st <= 499) return "push-endpoint-4xx";
  if (st !== null && st >= 500 && st <= 599) return "push-endpoint-5xx";
  const r = typeof res.reason === "string" ? res.reason : "";
  if (/\begress\b|\bblocked\b|\ballowlist\b|\bprivate\b/i.test(r)) return "push-egress-blocked";
  if (/\btimed? ?out\b|\btimeout\b/i.test(r)) return "push-timeout";
  return "push-other";
}

// emailProbeOutcome maps an email test RESULT to a closed member. The platform's error CODE is read for its
// PRESENCE only (the engine's shape gate already guarantees it is a platform code, and the pack carries it
// separately under that gate): a refusal the sending platform NAMED is a configuration step the operator can
// go and complete, and one it did not is not. The code itself never enters this row.
export function emailProbeOutcome(res: { ok: boolean; code?: string }): ClientDiagProbeOutcome {
  if (res.ok) return "ok";
  return typeof res.code === "string" && res.code.trim() !== "" ? "email-platform-refused" : "email-other";
}

// probeCallOutcome maps a THROWN test call (the test never ran) to a closed member. It is deliberately separate
// from every surface-specific class above: a test the engine REFUSED (a role gate, a step-up, a rate limit) and
// a test that ran and failed teach completely different things, and until now both were one red toast.
export function probeCallOutcome(err: unknown): ClientDiagProbeOutcome {
  const st = errorStatus(err);
  if (st !== null && (st === 401 || st === 403 || st === 429)) return "probe-refused";
  return "probe-unreachable";
}

// recordFormRefused (G240/G335): the console's OWN validator REFUSED A VALUE THE OPERATOR TYPED. No request is
// made, so the engine has no view of it whatsoever. formField is the FIELD CATALOGUE control id (a closed product
// vocabulary); the typed value is never read into the row.
//
// IT TAKES THE RAW VALUE, AND THE EMPTINESS RULE IS ENFORCED HERE, WHICH IS THE ONLY PLACE IT CAN BE (R5,
// ). A `rejected` row asserts the console examined a value and turned it away, so there has to have
// been one: a required box the operator has not filled in yet is an operator part-way through a form, the
// commonest event in the console, and recording it buries every real refusal under it. That rule was made
// structural in the field() funnel and on the refuse() arm, and left to the honour system on the three DIRECT
// call sites -- where it was promptly broken. The setup screen recorded an untouched KV form as two rejections
// (validateHexId returns "The ... is required." for ""), and the destination form recorded an empty retention box
// as dest-worm-days/rejected (Number("") is 0, which fails `days <= 0`), BYTE-IDENTICAL to the real refusal each
// member exists for. So the rule now lives in the RECORDER: the value is a required argument, and a `rejected`
// row cannot be written without one. THE VALUE IS READ ONLY TO TEST WHETHER IT IS EMPTY and is never stored,
// never copied into the row and never leaves this function; the row carries the catalogue field id and nothing
// else. There is no way to call this with the outcome and not the value, which is the regression gate: the type
// checker is.
//
// AND THE EMPTINESS RULE NEEDED ONE MORE FACT, WHICH IS THE FACT THE RULE IS ABOUT. The rule
// exempts an operator PART-WAY THROUGH A FORM: nothing was examined, so there is no refusal to claim. An
// <input type="number"> whose content is not a valid floating-point number reads back as the empty string too --
// the HTML value-sanitisation algorithm throws the operator's text away -- and that is the OPPOSITE state. The
// operator typed a contracted rate, the control could not convert it, and the console refused them over it. On
// the value alone the two are indistinguishable, which is exactly why validity.badInput exists, and without it
// this rule silently drops the one refusal it was never meant to drop: the box reads empty, no row is written,
// and "I cannot enter my contracted rate" has no evidence anywhere.
//
// So the rule is now "empty AND the control did not report a conversion failure". It is strictly narrower than
// the old one on the state it exempts (an untouched required box has badInput false and still records nothing)
// and it stops being blind on the state it never meant to exempt. The typed value is gone by the time this runs,
// which is precisely why this row can carry a catalogue field id, a count, and no customer data whatsoever.
export function recordFormRefused(formField: ClientDiagFormField, rawValue: string, meta?: { badInput?: boolean }): void {
  if (rawValue.trim() === "" && meta?.badInput !== true) return; // no value was examined: there is no refusal to claim
  push({ kind: "form-rejected", screen: currentScreen(), formField, rejectOutcome: "rejected", count: 0, firstMs: elapsedMs(), lastMs: elapsedMs() });
}

// recordFormCoerced (G240): the console SILENTLY REPLACED a value the operator typed (a number input eating a
// rate). It is the other rejectOutcome, and it is split from recordFormRefused because it makes the OPPOSITE
// claim: nothing was refused, the operator was never told, and the value that got through is not the one they
// entered. It has no emptiness question to answer (there is no coercion of a value nobody typed), so it takes no
// value and can carry none.
export function recordFormCoerced(formField: ClientDiagFormField): void {
  push({ kind: "form-rejected", screen: currentScreen(), formField, rejectOutcome: "silently-coerced", count: 0, firstMs: elapsedMs(), lastMs: elapsedMs() });
}

// formFieldFor maps a console control id to a closed member by SET MEMBERSHIP, and returns null for anything
// else. A field id that is not a member is DROPPED rather than coerced to a nearest member: a bucket that lands
// in the wrong row is worse evidence than no row.
//
// The IdP preset's dynamic required-variable controls (`idp-var-${key}`) are deliberately NOT folded onto a
// stable member here (G335, R2). It would have been easy: a prefix check, one member, and the list would look
// more complete. But those controls are `required: true` with a validator that only rejects the empty string, so
// the only refusal they can ever produce is required-and-empty -- the one refusal the funnel does not record. The
// member would have had no producer, and a member with no producer is a section that can never be populated,
// which is worse evidence than an honest absence.
export function formFieldFor(field: unknown): ClientDiagFormField | null {
  return typeof field === "string" && CLIENT_DIAG_FORM_FIELD_SET.has(field) ? (field as ClientDiagFormField) : null;
}

// recordCatalogueDegraded (G243): the Cloudflare-configuration offer was withheld, or made against a catalogue
// the console could not trust. It records a WITHHELD AFFORDANCE, never a fault on a healthy path: the operator
// opened the screen and did not get the option, which is the ticket.
export function recordCatalogueDegraded(catalogueClass: ClientDiagCatalogueClass): void {
  push({ kind: "catalogue-degraded", screen: currentScreen(), catalogueClass, count: 0, firstMs: elapsedMs(), lastMs: elapsedMs() });
}

// cfRediscoverRefusalClass maps the engine's REFUSAL of POST /downpipes/cf-config/rediscover to a closed member.
// It is a CLASSIFIER in this codebase's strict sense: it reads the ENGINE'S OWN SENTENCE (a frozen string chosen
// by the route, never a customer value and never a Cloudflare message) to SELECT a member, and returns the
// member. The sentence itself is never copied, and an unrecognised one falls to the residual rather than riding.
//
// It exists because every refusal used to compose ONE row, cf-rediscover-failed, on the same screen, with the
// same class: they coalesced on the tuple key into a single count. "The discovery token was cleared" (paste a
// token), "the account fell out of the owner's discovery scope" (only the OWNER can fix it) and "Cloudflare
// rate-limited us" (do nothing, retry) are three different phone calls and were one row.
export function cfRediscoverRefusalClass(error: unknown): ClientDiagCatalogueClass {
  const e = typeof error === "string" ? error.toLowerCase() : "";
  if (e.includes("no discovery token")) return "cf-rediscover-no-token";
  if (e.includes("discovery scope")) return "cf-rediscover-out-of-scope";
  return "cf-rediscover-failed";
}

// cfRediscoverThrowClass maps a THROWN rediscover to a closed member, or to NULL for the one state that must not
// be recorded at all. It classifies by the throw's KIND FIRST and only then by its numeric status, and that order
// is the whole fix: keying on errorStatus() alone put THREE states in one row.
//
// The console transport has first-class throws that carry NO status, and they used to fall through together to
// cf-rediscover-transport, whose own vocabulary asserts "the call never got an answer: the engine or the network
// dropped it":
//
//   A LAPSED CLOUDFLARE ACCESS SESSION. This console is Access-fenced and Access does not answer a lapsed session
//   with a 401: it serves its LOGIN PAGE, which the transport folds into ACCESS_REDIRECT_MARKER. isUnauthorised()
//   is 401-only, so the caller's sign-out guard never caught it either. The engine is fine, the operator left a
//   tab open overnight, and the pack said the network dropped the call. It is the ordinary overnight state and it
//   records NOTHING: null, no row. There is deliberately no member for it, because no path would write one.
//
//   A WRONG OR UNDEPLOYED ENGINE ADDRESS. A proxy, a static host or an SPA shell answered HTML where engine JSON
//   was expected (HTML_BODY_MARKER). Something DID answer, so "no answer at all" is false, and the remedy is the
//   address rather than the network. Its own member: cf-rediscover-not-an-engine.
//
//   THE CONSOLE'S OWN WORKER, with no ENGINE service binding (G152). No request reached any engine, so a row
//   blaming the engine or the network would assert a fact nothing established. It is the residual, not transport.
export function cfRediscoverThrowClass(err: unknown): ClientDiagCatalogueClass | null {
  const kind = classifyError(err).kind;
  if (kind === "access-redirect") return null;
  if (kind === "html-body") return "cf-rediscover-not-an-engine";
  if (kind === "engine-binding-absent") return "cf-rediscover-failed";
  // G250: the console's own worker answered the rediscover with its own 500. Like the bindingless 503 above, no
  // request reached any engine, so this is the RESIDUAL and not `cf-rediscover-transport`, which claims nothing
  // answered at all: something did answer, and it was this console. It is emphatically not the 5xx fall-through
  // below, which reads as the engine refusing the probe. Which console-side fault it was is named by the
  // feature-probe and transport rows in the same ring, and the remedy is never the discovery token.
  if (kind === "console-origin-fault") return "cf-rediscover-failed";
  const st = errorStatus(err);
  // G250's kill, applied to its sibling: a 403 does not establish that the ENGINE refused anything.
  // The transport already folds the refusal body's SHAPE into the throw, and cf-rediscover-denied -- "the engine
  // refused this caller's role" -- was being written for a WAF block page and for a static host at the engine's
  // address, which are not role problems and may not have an engine behind them at all.
  if (st === 403) return forbiddenClass(err) === "not-engine-body" ? "cf-rediscover-refused-at-edge" : "cf-rediscover-denied";
  if (st === 429) return "cf-rediscover-rate-limited";
  if (st === null) return "cf-rediscover-transport";
  return "cf-rediscover-failed";
}

// cfSurfaceListThrowClass maps a THROWN CATALOGUE READ (GET /sources/discover: the wizard's source step, and the
// editor's re-read on every cf-config open) to a closed member, or to NULL for the states that must record no row
// at all. It is the twin of cfRediscoverThrowClass above, and it exists because the read had NO classifier: both
// call sites ended in a bare `.catch()` that wrote ONE member, cf-surface-list-unreadable, on every throw.
//
// SEVEN STATES WROTE THAT ONE ROW, and two of them are not faults:
//
//   A LAPSED CLOUDFLARE ACCESS SESSION. The commonest of the lot, and the reason this matters most here: the
//   operator opens the editor on a tab left open overnight, Access serves its LOGIN PAGE rather than a 401, and
//   the pack gained a fault row against a healthy engine and a healthy token, on the very screen whose remedy is
//   "go and look at your discovery token". It records NOTHING: null, no row.
//   A 401. The caller's own guard signs the operator out; a row would say the catalogue is broken when the
//   session simply ended. NULL, exactly as it is on every other read in this console.
//
// The rest are five different phone calls: a web page at the engine's address (fix the ADDRESS), the engine's own
// role refusal (fix the ROLE), an edge or foreign host refusing (fix an edge rule, or the address), a rate limit
// (do nothing, retry), and a dropped call. The console's own 500 and its missing ENGINE binding go to the
// RESIDUAL, because no request reached any engine and the console-side rows in the same ring name them.
export function cfSurfaceListThrowClass(err: unknown): ClientDiagCatalogueClass | null {
  const kind = classifyError(err).kind;
  if (kind === "access-redirect") return null;
  if (kind === "unauthorised") return null;
  if (kind === "html-body") return "cf-surface-list-not-an-engine";
  if (kind === "engine-binding-absent") return "cf-surface-list-unreadable";
  if (kind === "console-origin-fault") return "cf-surface-list-unreadable";
  const st = errorStatus(err);
  if (st === 403) return forbiddenClass(err) === "not-engine-body" ? "cf-surface-list-refused-at-edge" : "cf-surface-list-denied";
  if (st === 429) return "cf-surface-list-rate-limited";
  if (st === null) return "cf-surface-list-transport";
  return "cf-surface-list-unreadable";
}

// cfDiscoveryBlackout is the OK-BUT-BLIND verdict: a rediscover that SUCCEEDED and could read not one surface.
// probeCfConfig does not throw on a scope 403 -- it files that surface as `unavailable` -- so an expired or
// rescoped discovery token yields ok:true with everything unavailable, and the console cheerfully toasts
// "Discovered 0 surfaces in use". That is the headline state of the gap and it produced no row of any kind.
// A healthy token over an account that simply has nothing configured fills `empty`, not `unavailable`, so this
// cannot fire on a legitimate account: it needs zero present, zero empty, and at least one unavailable.
export function cfDiscoveryBlackout(d: { present?: unknown[]; empty?: unknown[]; unavailable?: unknown[] }): boolean {
  const n = (a: unknown[] | undefined): number => (Array.isArray(a) ? a.length : 0);
  return n(d.present) === 0 && n(d.empty) === 0 && n(d.unavailable) > 0;
}

// recordFeatureProbe (G250): WHICH DIAGNOSIS THE CONSOLE REACHED about a route it could not read. The whole
// point is the featureOutcome: a 404 means the pending-the-engine tile the console shows is CORRECT, and a 5xx
// means it is a lie the customer has been told for a fortnight.
export function recordFeatureProbe(featureClass: ClientDiagFeatureClass, featureOutcome: ClientDiagFeatureOutcome): void {
  push({ kind: "feature-probe", screen: currentScreen(), featureClass, featureOutcome, count: 0, firstMs: elapsedMs(), lastMs: elapsedMs() });
}

// featureOutcomeForError maps a THROWN engine read to a closed verdict. It classifies by the throw's KIND FIRST
// and only then by its numeric status, and that order is the fix G238's sibling gap needed.
//
// THE STATUS IS NOT ENOUGH, AND THE TWO STATUSLESS THROWS ARE NOT `network`. errorStatus() reads a TRAILING
// 3-digit status off the transport's Error("<verb>: <status>") message. The console transport has two
// first-class throws that carry NO status at all, and both used to fall through to `network` -- the row whose
// own vocabulary entry asserts "the engine is unreachable":
//
//   1. A LAPSED CLOUDFLARE ACCESS SESSION. This console is Access-fenced, and Access does NOT answer a lapsed
//      session with a 401: it intercepts the request and serves its LOGIN PAGE, which the transport folds into
//      ACCESS_REDIRECT_MARKER. So the 401 guard below never saw it, and every operator who left a tab open
//      overnight and reloaded the security screen wrote "the engine is unreachable" against the roles table, the
//      audit events, the group roles and whoami at once. It is the ordinary overnight state and it records
//      NOTHING, on exactly the reasoning the 401 rule is built on: a fault row for a legitimate state cries wolf.
//      There is deliberately no `access-session-lapsed` MEMBER: no path would ever write it, and a vocabulary
//      member with no producer is dead vocabulary that reads like coverage.
//   2. A WRONG OR UNDEPLOYED ENGINE URL. A proxy, a static host or an SPA shell answered HTML where engine JSON
//      was expected (HTML_BODY_MARKER). The engine is not unreachable: something else is answering for it, and
//      the remedy is the engine address, not the engine. That is `not-an-engine`, its own member.
//
// `origin-rejected` cannot be decided here, because it needs a SECOND observation (the unauthenticated health
// probe answering while the authenticated call throws). The one call site that makes that probe passes the
// verdict in itself; everything else that throws with no status is honestly `network`.
export function featureOutcomeForError(err: unknown): ClientDiagFeatureOutcome | null {
  const kind = classifyError(err).kind;
  if (kind === "access-redirect") return null;
  if (kind === "html-body") return "not-an-engine";
  // G152/G250: the console's OWN worker refused the call for want of an ENGINE service binding. It carries no
  // status, so it used to fall through to `network` -- the member that asserts the engine is unreachable, a fact
  // nothing here established, because no request was sent to any engine at all.
  if (kind === "engine-binding-absent") return "engine-binding-absent";
  // G250: the console's OWN worker manufactured the 500 (its dispatch threw, or the ENGINE binding's fetch
  // rejected because the engine worker is deleted, throwing or over its limits). It must be read BEFORE the status
  // rules below, and it is the whole point of the member: on the bare status this landed on `server-error`, whose
  // meaning is that the ENGINE saw the call and refused it, so support was sent to read refusals that cannot
  // exist. Nothing here establishes anything about the engine except that the console answered in its place.
  if (kind === "console-origin-fault") return "console-origin-fault";
  const st = errorStatus(err);
  if (st === 401) return null;
  if (st === 404) return "route-absent";
  if (st === 501) return "not-implemented";
  // G250: A BARE 403 DECIDES NOTHING ABOUT WHO REFUSED, and this row used to claim it did. `forbidden`
  // told support the remedy was "a permission or an edge rule, never the engine's address", and the state where
  // the address IS the fault -- a static host or a bucket at the engine's address answering 403 with a web page,
  // no engine deployed there at all -- wrote exactly that row. THE DISCRIMINATOR WAS ALREADY IN THE THROW AND WAS
  // THROWN AWAY: the transport classifies the refusal BODY BY SHAPE (classifyForbiddenBody) and folds the closed
  // member into the message, so forbiddenClass() reads back whether the refusal spoke the ENGINE'S own vocabulary
  // (engine-capability, engine-authz, engine-csrf: the engine answered, its deployment and address are fine, the
  // remedy is a role or an origin check) or did not (not-engine-body: an edge block page, a proxy, a foreign host,
  // and the address is established either way by nothing at all).
  if (st === 403) return forbiddenClass(err) === "not-engine-body" ? "refused-not-by-engine" : "forbidden";
  if (st === 429) return "rate-limited";
  if (st !== null && st >= 500 && st <= 599) return "server-error";
  if (st !== null) return "other";
  return "network";
}

// recordGovGate (G252): a governance gate the CONSOLE applied. Neither member can leave an engine-side trace by
// construction, and they fail in opposite directions (one blocks an action that should have run, the other lets
// through an action that should have been stopped for a change number).
export function recordGovGate(govGate: ClientDiagGovGate, adminOp: ClientDiagAdminOp): void {
  push({ kind: "gov-gate", screen: currentScreen(), govGate, adminOp, count: 0, firstMs: elapsedMs(), lastMs: elapsedMs() });
}

// recordConsoleSkew (G254): the RUNNING console bundle, as its relation to what the origin serves right now.
export function recordConsoleSkew(skewClass: ClientDiagSkewClass): void {
  push({ kind: "console-skew", screen: currentScreen(), skewClass, count: 0, firstMs: elapsedMs(), lastMs: elapsedMs() });
}

// skewClassFor compares the RUNNING console bundle (the baked __CONSOLE_VERSION__ define) against the version
// THE SAME ORIGIN IS SERVING THIS INSTANT (/__build.json, read no-store), and returns a closed member. Pure and
// value-free by construction: it takes two version strings plus the read's own closed class, and returns a
// member, so no version string can reach the ring through it.
//
// It does NOT compare the console against the ENGINE. That comparison is meaningless: the two are separately
// versioned repos, so it fabricated a skew on every healthy customer and inverted the direction on the one
// ticket it was written for. See the vocabulary note beside CLIENT_DIAG_SKEW_CLASSES. WHICH console build is
// running rides in the pack directly, as `consoleBuild` on the payload envelope, next to the engine's version:
// support compares those two themselves rather than being handed a verdict the browser could not honestly make.
export function skewClassFor(running: string | null, served: string | null, readClass: ServedReadClass): ClientDiagSkewClass {
  if (running === null || running.trim() === "") return "running-unstamped";
  if (readClass === "unreachable") return "origin-unreachable";
  if (readClass === "non-json") return "origin-not-json";
  if (readClass === "unstamped" || served === null || served.trim() === "") return "origin-unstamped";
  const norm = (v: string): string => v.trim().replace(/^v/, "");
  const a = norm(running);
  const b = norm(served);
  if (a === b) return "served-matches-running";
  // A NUMERIC compare where both sides are dotted integers, so the direction is a real direction and not a
  // lexical accident ("0.10.0" is AHEAD of "0.9.0", and a string compare says the opposite).
  const parts = (v: string): number[] => v.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) break;
    if (x !== y) return x < y ? "served-newer-than-running" : "served-older-than-running";
  }
  // Both stamped, unequal, and not comparable as dotted integers (a hash-stamped or pre-release build). They
  // DIFFER and the direction is NOT knowable, so the row says exactly that and no more. Guessing a direction
  // here is how a row starts asserting a fact the code never established.
  return "served-version-differs";
}

// ServedReadClass is console-version.ts's ServedVersionReadClass, restated so the ring imports no screen or
// service module. The two are pinned together by the validator.
export type ServedReadClass = "ok" | "unreachable" | "non-json" | "unstamped";

// ---- posture round, group 2 --------------------------------------------

// recordMaterialRejected (G256): the console REFUSED a piece of operator key or ceremony material. Every one of
// these refusals is decided in the browser, so no request is made and the engine cannot hold a record of it: the
// browser is the only witness there can ever be. The class is chosen at the REJECT BRANCH, which knows exactly
// why it refused, and NOTHING about the material rides with it. Not the text, not the offending character, not
// its index, and deliberately not a length: a length is a fingerprint of the secret, and the class already says
// the length was the problem.
export function recordMaterialRejected(materialClass: ClientDiagMaterialClass): void {
  push({ kind: "material-rejected", screen: currentScreen(), materialClass, count: 0, firstMs: elapsedMs(), lastMs: elapsedMs() });
}

// recordContractSkew (G261, G289): the console was handed data it could not interpret and rendered something
// plausible anyway. contractClass says HOW the contract broke and fieldFamily WHICH family broke it; both are in
// the coalescing tuple, so an unknown IdP preset and an unknown source-type id are two rows, not one, and an
// absent field and a malformed one are two rows, not one. The unrecognised VALUE never rides: a new enum member
// could be an operator-named preset id or the customer's own label for a source.
export function recordContractSkew(contractClass: ClientDiagContractClass, fieldFamily: ClientDiagFieldFamily): void {
  push({ kind: "contract-skew", screen: currentScreen(), contractClass, fieldFamily, count: 0, firstMs: elapsedMs(), lastMs: elapsedMs() });
}

// The counts of ONE fleet-drill session, as the console assembled them (G287).
export interface FleetDrillSession {
  targeted: number;
  passed: number;
  failed: number;
  // deferred: downpipes the engine honestly refused to drill because the estate is break-glass-only (no
  // in-account read-back key). Recorded distinct from failed, so a correctly-functioning break-glass-only
  // fleet is never miscategorised as a fleet with failing drills.
  deferred: number;
  skippedNoRunId: number;
  rateLimitExhausted: number;
}

// recordFleetDrill (G287): ONE fleet-drill session's SHAPE. The engine already records every drill it handled
// (§4.3, per downpipe), so this is deliberately not about which pipe failed: it is about the session the engine
// cannot see. Five rows, one per fact, each carrying its number in `count`, all sharing the session's abort
// cause so an aborted session's counts can never sum into a clean one's.
//
// Every fact is emitted, including the zeroes, and that is the point: `passed: 0` is the denominator that makes
// `failed: 12` mean something, and a `skipped-no-run-id: 0` is what tells support that a missing downpipe was
// NOT silently dropped from the target list. A row that only ever appears when it is bad cannot answer a ratio.
export function recordFleetDrill(drillAbort: ClientDiagDrillAbort, s: FleetDrillSession): void {
  const facts: Array<[ClientDiagDrillFact, number]> = [
    ["targeted", s.targeted],
    ["passed", s.passed],
    ["failed", s.failed],
    ["deferred", s.deferred],
    ["skipped-no-run-id", s.skippedNoRunId],
    ["rate-limit-exhausted", s.rateLimitExhausted],
  ];
  for (const [drillFact, n] of facts) {
    push(
      { kind: "fleet-drill", screen: currentScreen(), drillAbort, drillFact, count: 0, firstMs: elapsedMs(), lastMs: elapsedMs() },
      clampNonNegInt(n),
    );
  }
}

// ---- posture round, group 3 --------------------------------------------

// recordOwnerActionRefusal (G300): a dual-control approve or reject did not go through. adminOp names the route
// (owner-action-approve / owner-action-reject) and ownerActionCode why, and both are in the tuple. The three
// console-decided codes never reach the engine at all (the console refuses before it calls), so the browser is
// the only witness there can ever be; the proposal summary, the proposer's email and the action id have no field
// here and cannot ride.
export function recordOwnerActionRefusal(adminOp: ClientDiagAdminOp, ownerActionCode: ClientDiagOwnerActionCode): void {
  push({ kind: "owner-action-refusal", screen: currentScreen(), adminOp, ownerActionCode, count: 0, firstMs: elapsedMs(), lastMs: elapsedMs() });
}

// ownerActionCodeForError is the COARSE half of the owner-action refusal classifier: it says only whether the
// engine answered at all. The engine's refusal PROSE is never read (it answers the same status for a
// self-approval and for a non-owner alike, so a classifier over that text guesses, and guesses wrong the moment
// the engine rewords itself), and NOR IS ITS STATUS taken to mean more than it does.
//
// THE STATUS CANNOT SAY WHICH REFUSAL IT WAS, AND IT USED TO BE ASKED TO. This returned
// `terminal-state` on a 409/404/410, and the engine cannot produce any of those on these routes: every refusal
// canApproveOwnerAction makes (expired, terminal-state, consumed, self-approval, not-owner, bare-token) and the
// missing-record case are a plain `throw new Error(reason)`, which SchedulerDO.fetch maps to a 400 (only an
// AuthError becomes a 403). So the member had ZERO production producers, and the gap's own headline ticket -- the
// proposal that expired and "just vanished" -- arrived as a 400 and coalesced into the generic residual with the
// already-decided one and the honest remainder. The ONE 404 that can reach here is a route-not-found from an
// engine with no owner-action routes, which `terminal-state` would have labelled "already executed or expired": a
// fact nothing established. The discrimination is made from the CONSOLE'S OWN re-read of the inbox instead
// (ownerActionFateFromListing, screens/owner-actions.ts), never from a status the engine does not vary.
//
// It returns NULL for a lapsed Cloudflare Access session. This console is Access-fenced and Access answers a
// lapsed session with its LOGIN PAGE rather than a 401, so an overnight tab used to write a dual-control refusal
// into the pack: a governance fault fabricated out of the ordinary end of a working day.
//
// A 2xx THAT DID NOT PARSE IS NOT "UNREACHABLE". parseJson throws "<verb>: <status>" with the
// SUCCESS status still on it when a 2xx body is not the JSON the contract describes and is not an Access page or
// an HTML page either (a truncating proxy, a middlebox rewrite). errorStatus narrows to 400-599, so that throw
// carried no status and fell into `unreachable`, whose stated meaning is that no engine saw the call and no
// engine-side record of it can exist. On an approve that is the opposite of what happened: the engine took the
// approval and, for a DO-executed kind, ALREADY REPOINTED THE DESTINATION. It has its own member now.
// AND `engine-refused` HERE IS COARSE ON PURPOSE, INCLUDING ON THE 403. It is a status-only
// reading and it claims only "an engine-shaped answer came back with a refusal status": a 400, a 429, a 500 and a
// 403 all reach it. The 403 is then SPLIT BY THE BODY SHAPE in refusalCode (screens/owner-actions.ts), because
// four different things answer 403 to one call and only one of them is the caller's authority; a status-only
// classifier cannot tell them apart and must not pretend to.
export function ownerActionCodeForError(err: unknown): ClientDiagOwnerActionCode | null {
  if (classifyError(err).kind === "access-redirect") return null;
  if (errorAnswered(err)) return "answer-unreadable";
  const st = errorStatus(err);
  if (st === null) return "unreachable";
  return "engine-refused";
}

// recordRoleDeleteImpact (G301): a custom role was deleted, and `count` is how many grants still referenced it.
// Every one of those members falls to the viewer floor server-side, silently, and the pack's custom-role-change
// delete event says nothing at all about them. The ZERO case is recorded too, deliberately: a tidy-up that broke
// nobody and one that downgraded four people must not both be an absence, and push() writes the row even when the
// increment is zero. Counts only; the affected members' emails and subjects have no field on this record.
// deleteFate is REQUIRED, not optional, and that is the point. The console cannot see whether a delete landed by
// looking at the count: under change control the engine answers 202 { pending: true }, writes NOTHING, and the
// role still exists. A row that carried only the count would assert that N people were floored by a deletion the
// approver may go on to REJECT, which is a fact the code never established and a worse pack than no row at all.
// The caller has to have read the mutation result to call this, so it has to say which one it saw.
export function recordRoleDeleteImpact(affectedGrantCount: number, deleteFate: ClientDiagDeleteFate): void {
  push(
    { kind: "role-delete-impact", screen: currentScreen(), deleteFate, count: 0, firstMs: elapsedMs(), lastMs: elapsedMs() },
    clampNonNegInt(affectedGrantCount),
  );
}

// recordCspViolation (G304): the browser blocked a resource under the console's own Content-Security-Policy. Both
// classes come from the total, pure mappers below; the report body itself is read only by them, and they copy
// nothing out of it.
// cspInlineOrigin rides ONLY on an inline block, because it is the only class where it means anything: it is the
// answer to "was the blocked inline payload OURS?", and a blocked stylesheet or a blocked external script has no
// such question. Passing it on a non-inline row would put a field on the record that the code did not establish.
//
// WHY IT EXISTS. Under this console's policy (script-src 'self' '<sha256 of the one sanctioned pre-paint>';
// style-src 'self') a SAME-ORIGIN file can never be blocked, so the two states that actually occur are both
// INLINE, and both report blockedURI "inline":
//
// the stale pre-paint hash after a deploy  -> a BROKEN DEPLOY   (the documented incident)
//   an injected inline script                -> a SECURITY INCIDENT
//
// They coalesced into one row: a broken deploy and an attack, told apart by nothing.
//
// The caller supplies the origin because only the caller knows WHEN it is observing, and the timing IS the
// discriminator (see notePrepaintBlocked and the live listener in window-faults.ts). Nothing is ever read out of
// the violation report to decide it: on an injection the report's blocked URI is an attacker-chosen string.
export function recordCspViolation(cspDirective: ClientDiagCspDirective, cspBlocked: ClientDiagCspBlocked, cspInlineOrigin?: ClientDiagCspInlineOrigin): void {
  const inlineOrigin = cspBlocked === "inline" ? cspInlineOrigin : undefined;
  push({
    kind: "csp-violation",
    screen: currentScreen(),
    cspDirective,
    cspBlocked,
    ...(inlineOrigin !== undefined ? { cspInlineOrigin: inlineOrigin } : {}),
    count: 0,
    firstMs: elapsedMs(),
    lastMs: elapsedMs(),
  });
}

// prepaintRan reports whether the console's ONE sanctioned inline script actually EXECUTED, by reading the
// marker that script sets on the document element as its last act (public/index.html). It is a read of the
// PAGE'S OWN STATE, written by our own code before any other byte of the document is parsed: an injected script
// cannot forge it, and a violation report an attacker shapes cannot influence it.
export function prepaintRan(): boolean {
  if (typeof document === "undefined") return true; // no DOM (the validator): make no claim about a page that does not exist
  return document.documentElement.getAttribute("data-prepaint") === "ran";
}

// cspDirectiveFor maps the browser's effectiveDirective to a closed member by SET MEMBERSHIP. The reported string
// can carry a source expression on some engines ("script-src 'nonce-...'"), so the leading token is taken and then
// TESTED against the frozen set: a non-member is `other`, never the string.
export function cspDirectiveFor(directive: unknown): ClientDiagCspDirective {
  if (typeof directive !== "string") return "other";
  const head = directive.trim().split(/\s+/)[0] ?? "";
  return CLIENT_DIAG_CSP_DIRECTIVE_SET.has(head) ? (head as ClientDiagCspDirective) : "other";
}

// cspBlockedFor maps the report's blockedURI to a closed member. It compares the URI against two frozen browser
// keywords and against the page's OWN origin, and returns a member: NOTHING from the URI is copied, which is the
// whole discipline here. On the case this row matters most for (an injection attempt) the blocked URI is a string
// the ATTACKER chose, and it would otherwise be riding into a sealed bundle a support engineer opens.
//
// `self` is the one worth naming: it is the console's own origin, blocked by the console's own policy, which is
// the documented stale-hashed-chunk incident (an asset the page legitimately asked for and the hash allowlist no
// longer matched). It is a broken deploy, not an attack, and it must not read as one.
export function cspBlockedFor(blockedUri: unknown, pageOrigin: string): ClientDiagCspBlocked {
  if (typeof blockedUri !== "string") return "other";
  const uri = blockedUri.trim();
  if (uri === "inline") return "inline";
  if (uri === "eval" || uri === "wasm-eval") return "eval";
  if (uri === "self") return "self";
  if (uri === "") return "other";
  if (pageOrigin !== "" && (uri === pageOrigin || uri.startsWith(`${pageOrigin}/`))) return "self";
  return /^[a-z][a-z0-9+.-]*:/i.test(uri) ? "external" : "other";
}

// recordInputDropped (G308): the console silently discarded part of a paste before submitting it. TWO rows, one
// per fact, so the accepted count and the dropped count are both on the record and neither can be inferred from
// the other: "one of two certificates was dropped" and "one of nine" are the same droppedCount and different
// tickets.
//
// NOISE: it is called ONLY when something was actually dropped. A clean paste is the ordinary state on every
// save, and a row for it would drown the ring in good news and evict the real evidence underneath it.
export function recordInputDropped(dropSurface: ClientDiagDropSurface, acceptedCount: number, droppedCount: number): void {
  if (clampNonNegInt(droppedCount) === 0) return;
  push(
    { kind: "input-dropped", screen: currentScreen(), dropSurface, dropFact: "accepted", count: 0, firstMs: elapsedMs(), lastMs: elapsedMs() },
    clampNonNegInt(acceptedCount),
  );
  push(
    { kind: "input-dropped", screen: currentScreen(), dropSurface, dropFact: "dropped", count: 0, firstMs: elapsedMs(), lastMs: elapsedMs() },
    clampNonNegInt(droppedCount),
  );
}

// recordHandoffDropped (G310): a wizard or deep-link hand-off lost the operator's earlier pick. The class is the
// whole row and it is chosen at the site that DROPPED the value, which is the one place that knows what it lost.
// The query string, the zone id, the account id and the binding name are customer values and there is no field
// for any of them.
export function recordHandoffDropped(handoffClass: ClientDiagHandoffClass): void {
  push({ kind: "handoff-dropped", screen: currentScreen(), handoffClass, count: 0, firstMs: elapsedMs(), lastMs: elapsedMs() });
}

// recordCeremonyStep (G328): a browser-side key-ceremony or credential-enrolment step ended. `ok` is recorded as
// well as `failed`, so an artefact that was never produced is legible by the row that is MISSING as well as by the
// one that is there.
//
// The screen is pinned to `keys`: these panels are mounted from the key ceremony and the enrolment flow, and a
// step outcome filed under whatever route happened to be active would not be findable. NOTHING about the material
// rides: no key or share bytes, no ciphertext, no payload fragment, no decode offset, and not N or the threshold.
export function recordCeremonyStep(ceremonyStep: ClientDiagCeremonyStep, ok: boolean, ceremonyFault?: ClientDiagCeremonyFault): void {
  push({
    kind: "ceremony-step",
    screen: "keys",
    ceremonyStep,
    ceremonyOutcome: ok ? "ok" : "failed",
    ...(!ok && ceremonyFault !== undefined ? { ceremonyFault } : {}),
    count: 0,
    firstMs: elapsedMs(),
    lastMs: elapsedMs(),
  });
}

// ceremonyFaultFor maps a THROWN ceremony step to a coarse class from the thrown value's CONSTRUCTOR NAME, and
// from nothing else. The message is never read: a WebCrypto or decoder message can carry a byte offset or a
// length, and both are fingerprints of the key material the whole ceremony exists to keep in the browser.
//
// A DOMException out of SubtleCrypto is `webcrypto` (a locked-down browser, or a non-secure context, which is the
// commonest cause of "the encrypt button does nothing"); a RangeError is `oom` (a large allocation the tab could
// not make); anything the caller has already identified as a decode failure passes its own class in.
export function ceremonyFaultFor(err: unknown): ClientDiagCeremonyFault {
  const name = err instanceof Error ? err.name : "";
  if (name === "DOMException" || (typeof DOMException !== "undefined" && err instanceof DOMException)) return "webcrypto";
  if (name === "RangeError") return "oom";
  return "other";
}


// ---- The BLOCKED BROWSER STORE ---------------------------------------------------------------------

// storageClassFor is the classifier, and it is the no-custody boundary of this kind: it READS the exception
// only to SELECT a frozen member, and returns the MEMBER. The message, the name and the stack are discarded
// here and enter no field. It is TOTAL (an exception it cannot place is `other`, never a guess), and it names
// the two states that matter most: a store the host POLICY refused (SecurityError, or a throw on mere access)
// and a store that is simply FULL (QuotaExceededError, code 22 / 1014 on older engines). Those are a browser
// policy to change and a site-data clear, and folding them together sends support after the wrong one.
export function storageClassFor(err: unknown): ClientDiagStorageClass {
  const name = err instanceof Error ? err.name : "";
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return "quota-exceeded";
  if (name === "SecurityError") return "denied";
  if (name === "TypeError" || name === "ReferenceError") return "unavailable"; // the API is not there to call
  return "other";
}

// recordStorageBlocked (G336) is the emit for a browser store that refused. It is called from the storage
// leaves themselves (draft.ts, store.ts, the preference modules), which have always swallowed the throw by
// design: a preference that will not persist must never break a flow, and that design is exactly why a
// locked-down profile has been invisible to support. The row says WHICH store, WHICH operation, WHY, and WHAT
// the customer lost. The KEY is never recorded (a draft id can carry a run id) and the VALUE never leaves the
// browser at all.
export function recordStorageBlocked(
  storageArea: ClientDiagStorageArea,
  storageOp: ClientDiagStorageOp,
  storageSurface: ClientDiagStorageSurface,
  err: unknown,
): void {
  push({
    kind: "storage-blocked",
    screen: currentScreen(),
    storageArea,
    storageOp,
    storageSurface,
    storageClass: storageClassFor(err),
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// ---- The TOPOLOGY MAP's RENDERER -------------------------------------------------------------------

// recordRendererState (G345) is the emit for WHICH RENDERER WAS LIVE on the map, recorded on every map mount
// and not only on the bad ones. That is deliberate: `none` beside canvas2d is the row that lets the pack say
// the live view was HEALTHY, and without it a frozen map and a map the customer never opened are the same
// evidence (absence). It is a STATE row, so it is not a wolf cry: a reduced-motion static frame is recorded as
// reduced-motion, never as a browser fault, because the operator asked for it.
export function recordRendererState(rendererMode: ClientDiagRendererMode, degradeCause: ClientDiagDegradeCause): void {
  push({
    kind: "renderer-degraded",
    screen: currentScreen(),
    rendererMode,
    degradeCause,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}

// ---- WHERE KEYBOARD FOCUS LANDED ---------------------------------------------------------------------

// recordFocusLanding (G346) is the emit for the FIRST accessibility fact this vocabulary can carry, and it
// closes a blind spot: no member of any closed union here matched keyboard, a11y,
// tablist, roving or focus, so a keyboard user who could not arrow past the first tab produced a support pack
// byte-identical to a healthy one.
//
// It is called from ONE site, the shell's post-navigation focus move, and only for navigations where a screen
// DECLARED where focus belongs. That population is exactly the tablist-owns-a-route screens (the Keys
// sections, the Notifications areas), so an ordinary route change records nothing and the ring is not flooded
// by the healthy common path.
//
// `honoured` is recorded, not only the failures, for the same reason `none` is a member of degradeCause: it is
// what lets the pack say the mechanism WAS working. Without it a tablist that is broken and a tablist the
// customer never touched carry identical evidence, which is how this surface stayed invisible.
//
// Nothing about the element is recorded: not its id, its label, its accessible name, its selector, nor the key
// that was pressed. The row is the kind, the closed outcome and the screen's compile-time literal.
export function recordFocusLanding(focusOutcome: ClientDiagFocusOutcome): void {
  push({
    kind: "focus-landing",
    screen: currentScreen(),
    focusOutcome,
    count: 1,
    firstMs: 0,
    lastMs: 0,
  });
}
