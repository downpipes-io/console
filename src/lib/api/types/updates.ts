// Engine self-update (status + safe-apply) mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

import type { CanaryLiveness } from "./canary.ts";

// RiskClass mirrors engine/src/admin/updates.ts: the closed, ordered release risk set. It drives the
// console tone (a migration/breaking release is rendered with more care) and the W5 dual-control rule
// (a migration/breaking apply takes a second owner when dual control is ON). The engine NORMALISES an
// absent/unknown channel value to the SAFEST interpretation ("migration"), so a verified status always
// carries a real riskClass and the console never guesses.
export type RiskClass = "routine" | "migration" | "breaking";

// ChangelogEntry / RequiredStep mirror the engine's signed, structured release metadata. They carry
// only non-secret, human-readable release description, never a url, hash or token, so they are safe to
// render to any reader. `type` groups a changelog line (fix/feature/security/other, displayed as-is, not
// an authority boundary); `blocking` on a RequiredStep marks an action the operator must acknowledge.
export interface ChangelogEntry {
  type: string;
  text: string;
}
export interface RequiredStep {
  text: string;
  blocking?: boolean;
}

// UpdateComponentId names the two release components a component-aware apply/settle/rollback can address.
// The channel's components map may carry other ids in future (additive); only these two have console
// affordances today (the engine deploys them; anything else renders as a read-only row at most).
export type UpdateComponentId = "engine" | "console";

// UpdateComponentInfo is one entry of UpdateStatus.components (multi-component updates, channel schema v2):
// the signed channel's per-component release description the engine relays after verifying the document.
// `kind` is the deploy shape ("worker-module" for the engine, "static-assets" for the console; displayed,
// never an authority boundary); `recommendedVersion` is what this release carries for the component (equal
// to the running version means "up to date"); the rest is the per-component slice of the W2 rich metadata.
// No url or hash rides here (the engine keeps those to itself; the console never fetches an artefact).
export interface UpdateComponentInfo {
  kind: string;
  recommendedVersion: string;
  riskClass: RiskClass;
  changelog?: ChangelogEntry[];
  impact?: string[];
  minEngineVersion?: string;
  compat?: string;
  notes?: string;
}

// UpdateStatus is GET /admin/updates: the signed-channel verdict the console reads to render the Updates
// section. configured/verified/updateAvailable drive the tiles; the W2 rich-metadata fields (changelog,
// impact, requiredSteps, minEngineVersion, compat, riskClass, releasedAt) describe what an available
// update contains; `compatible` is the engine's compat verdict (false when the release declares a
// minEngineVersion NEWER than the running engine, the apply would be refused, so the console disables it
// honestly rather than letting the owner click into a guaranteed refusal). The rich fields are present
// only when verified AND the channel set them, so an older engine / unset field is honestly absent (no
// fabrication). Mirrors engine/src/admin/updates.ts UpdateStatus byte-for-byte.
// UpdateChannelFault mirrors engine/src/admin/updates.ts UPDATE_CHANNEL_FAULTS: the CLOSED cause of an
// unverified channel consult. The engine already held this enum and used to DROP it at the status projection,
// leaving the console to re-derive the class by substring-matching the engine's prose -- so a reworded engine
// sentence would silently downgrade every recorded row to "unstated" and no gate would fail. It now travels.
export const UPDATE_CHANNEL_FAULTS = ["url-config", "key-config", "fetch-failed", "sig-invalid", "json-parse", "shape-invalid"] as const;
export type UpdateChannelFault = (typeof UPDATE_CHANNEL_FAULTS)[number];
export const UPDATE_CHANNEL_FAULT_SET: ReadonlySet<string> = new Set(UPDATE_CHANNEL_FAULTS);

export interface UpdateStatus {
  configured: boolean;
  verified: boolean;
  currentVersion: string;
  recommendedVersion?: string;
  updateAvailable?: boolean;
  // versionSkew (ADDITIVE, presence-safe: an older engine omits it and this console behaves exactly as
  // before) is the engine's three-way answer to where it sits relative to what the channel recommends.
  // updateAvailable is a boolean and could not carry it, which is how the engine came to advertise an
  // update its own apply path refuses. "uncomparable" is the member that matters here: the engine could not
  // read one of the two version strings, so this console must not render the healthy "Up to date", which
  // would be a pass reported where a could-not-check is the truth.
  versionSkew?: "behind" | "current" | "ahead" | "uncomparable";
  notes?: string;
  reason?: string;
  // ---- The channel verdict's own evidence -------------------------------------------------------
  // channelIntended is TRUE when the operator set EITHER channel env var. `configured` is the ENGINE'S VERDICT,
  // not the operator's intent: it goes FALSE for a mangled UPDATE_SIGNER_PUBLIC, a non-https URL and an
  // unparseable one, all states in which the operator plainly meant to have updates and the channel is simply
  // broken. A console that keys its fault row off `configured` therefore treats a silently frozen update channel
  // exactly like a customer who wants no updates: no chip, no row, a pack identical to a healthy engine's.
  channelIntended?: boolean;
  // channelFault is the engine's CLOSED cause for an unverified consult. Validated against the frozen set on
  // arrival (it is wire data), then mapped to the pack's channelReasonClass.
  channelFault?: UpdateChannelFault;
  // ---- W2 rich metadata for the recommended version (present only when verified + the field is set) ----
  changelog?: ChangelogEntry[];
  impact?: string[];
  requiredSteps?: RequiredStep[];
  minEngineVersion?: string;
  compat?: string;
  riskClass?: RiskClass; // always set when verified (engine defaults to the safest interpretation)
  releasedAt?: string; // RFC-3339 when the release shipped
  // compatible is false when the recommended release's minEngineVersion is newer than the running engine
  // (planAndPromote would REFUSE before any deploy). Present when verified; the apply control disables on it.
  compatible?: boolean;
  // components (multi-component updates, ADDITIVE): the per-component release map from channel schema v2,
  // present only when the engine understands components AND the verified channel carries the map. An older
  // engine simply never sends it, and the console renders EXACTLY the single-engine experience then; every
  // component-aware affordance gates on this field's presence. Keyed by component id ("engine", "console",
  // future ids additive). noUncheckedIndexedAccess makes every read honestly `| undefined`.
  components?: Record<string, UpdateComponentInfo>;
  // provenance (ADDITIVE): the recommended ENGINE artefact's build-provenance block from the SIGNED
  // channel -- which commit and tag it was built from, which CI run attested it, the Rekor transparency-log
  // index of its keyless signature, and channel-relative paths to the attestation files. Every value is a
  // public identifier covered by the channel signature; an ABSENT block is an unattested (pre-provenance)
  // release the console states honestly, never invents.
  provenance?: UpdateProvenance;
  // channelBase (ADDITIVE): the public channel directory (UPDATE_CHANNEL_URL minus its filename) for
  // resolving the provenance block's channel-relative attestation paths into openable links.
  channelBase?: string;
}

// UpdateProvenance mirrors the engine's ComponentProvenance (src/admin/updates.ts): the signed channel's
// per-component build-provenance block. Public identifiers and public paths only.
export interface UpdateProvenance {
  commit?: string;
  tag?: string;
  repo?: string;
  runId?: string;
  rekorLogIndex?: string;
  attestations?: {
    intoto?: string;
    cosignBundle?: string;
    sums?: string;
    releaseRecord?: string;
  };
}

// UpdateReadbackRecord mirrors the engine's persisted read-back verdict: whether Cloudflare's own
// API returned byte-exactly the signed bundle before promotion (verified | mismatch | unavailable), the
// gate mode it ran under, and the platform-returned digest when bytes were read. Redaction-safe.
export interface UpdateReadbackRecord {
  verdict: string;
  mode: string;
  deployedSha384?: string;
  detail?: string;
}

// ---- Safe-apply engine update (mirrors engine/src/admin/update-apply.ts) ------------------------
// The self-hosted engine can update ITSELF to a newer VENDOR-SIGNED version from the console with NO
// CLI. It is brick-safe: the artefact is signature + SHA-384 verified
// BEFORE any deploy; phase 1 (apply) promotes the new version; phase 2 (settle) flies the CANARY on
// the now-live new code and KEEPS it or AUTO-ROLLS-BACK. Data and recovery are never at risk (archives
// are immutable + append-only; restore is out-of-band, signed, engine-independent). The deploy token is
// ONE-SHOT, supplied per call, and NEVER stored, logged or audited (the `attach` precedent); it is held
// only in browser memory across apply -> settle and discarded. These shapes carry version ids, step
// outcomes, a coarse reason and a canary verdict only, no value, no key, never the token.

// UpdateStep is one line of the verify -> upload -> promote -> canary -> decision/rollback progression.
// `step` is a stable machine label the console renders as a checklist row; `ok` is its pass/fail; `detail`
// is an optional plain-English note (a version id, a canary verdict, a rollback reason). No-custody: a step
// is a coarse label + a boolean + an optional reason; it never carries the token, a value or a key.
export interface UpdateStep {
  step: string;
  ok: boolean;
  detail?: string;
}

// PromoteResult is the engine's structured POST /admin/update/apply outcome (the phase-1 result). It NEVER
// 500s: a fail-safe path records a structured outcome instead (verify-before-deploy excludes corrupt/
// tampered builds, so nothing is uploaded on a refusal). The outcomes:
//   "no-update"  the running version already matches the recommended version; nothing to do.
//   "dry-run"    a dryRun:true verify + plan; the artefact verified and a deploy WOULD happen (steps say
//                what), but nothing was uploaded or promoted.
//   "refused"    a live apply was refused BEFORE any change (a failed signature/hash, a required DO
//                migration, a missing token); the engine is unchanged; `reason` says why.
//   "promoted"   the new version is now live (an ENGINE promote); the console MUST immediately call settle
//                to canary-gate it.
//   "applied" / "applied-unconfirmed" / "rolled-back" / "rollback-failed"  a CONSOLE-ONLY component-aware
//                apply's own already-terminal outcome (router-updates-components.ts handleComponentApply
//                returns the console's ConsoleApplyResult verbatim as the top-level body when the request
//                names "console" alone): a console component is atomic and self-verifying in one request
//                (upload, promote, confirm-live), so there is no settle phase to wait for and this IS the
//                final word, never a signal to call settle. Live-confirmed missing from this union until a
//                console-only apply's "applied" fell through every reader's "unexpected outcome" branch
//                (see update-apply-flow.ts's own outcome switch and consoleWasApplied, shared.ts).
// recommendedVersion is always present; fromVersion/toVersion/canaryBaseline are present once known.
export interface PromoteResult {
  phase: "promote";
  outcome: "no-update" | "dry-run" | "refused" | "promoted" | "applied" | "applied-unconfirmed" | "rolled-back" | "rollback-failed";
  recommendedVersion: string;
  fromVersion?: string;
  toVersion?: string;
  canaryBaseline?: CanaryLiveness;
  steps: UpdateStep[];
  reason?: string;
  // componentResults (multi-component updates, ADDITIVE): one PromoteResult-like entry per component the
  // apply addressed, present only from a component-aware engine on a component-aware request. The top-level
  // fields above still describe the engine (or the single requested component), exactly as today, so a
  // reader that ignores this field keeps working; the console renders these as per-component plan/result
  // rows when present.
  componentResults?: ComponentApplyResult[];
}

// ComponentApplyResult is one component's slice of a multi-component apply: `component` names it, and the
// rest is the PromoteResult-like outcome for that component. `outcome` carries the promote outcomes plus
// "applied" (a static-assets component is atomic at promote, so a component-aware engine may report it
// applied outright); it is typed open (string) so a future outcome renders honestly as text instead of
// being dropped. steps/reason are optional per component. No token, value or key ever rides here.
export interface ComponentApplyResult {
  component: string;
  outcome: string; // "no-update" | "dry-run" | "refused" | "promoted" | "applied" | future values
  recommendedVersion?: string;
  fromVersion?: string;
  toVersion?: string;
  steps?: UpdateStep[];
  reason?: string;
}

// SettleResult is the engine's POST /admin/update/settle outcome (the phase-2 result the console requests
// right after a "promoted" apply, hitting the now-live new code with the SAME one-shot token). It also
// never 500s. The two outcomes:
//   "applied"     the canary sang on the new code; the new version is KEPT.
//   "rolled-back" the canary did not sing (or the gate could not confirm health); the engine re-deployed
//                 the recorded prior version. `reason` says why; nothing was lost (data + recovery were
//                 never at risk), so the console frames this calmly, not as a failure of the platform.
// canaryVerdict is the post-promote canary liveness; canaryBaseline is the pre-promote baseline the gate
// compared against (design/SAFE-APPLY-UPDATE.md "the gate rule").
export interface SettleResult {
  phase: "settle";
  outcome: "applied" | "rolled-back";
  recommendedVersion: string;
  fromVersion: string;
  toVersion: string;
  canaryBaseline?: CanaryLiveness;
  canaryVerdict?: CanaryLiveness;
  steps: UpdateStep[];
  reason?: string;
  // confirmationPending (ADDITIVE): present + true ONLY on an "applied" outcome where
  // the engine's relaxed judgment (selfCheck gates on CRITICAL classes only) kept the update before the
  // hourly canary had a chance to sing on the new version in the background. The console renders this as its
  // own calm first-class outcome (design s2/s5: "verified in the background, no action needed"), never as a
  // plain "applied" (which would overclaim) and never as "pending" (which would ask for a token that is not
  // needed, a keep needs none). Absent/false on every older engine and on a normal confirmed keep.
  confirmationPending?: boolean;
  // droppedSources (post-update source verification): present on a KEPT update when the engine's pre/post
  // binding diff found configured source bindings the update did not carry forward (it should not happen,
  // the self-deploy re-sends the live set, but this proves it). Each is a binding NAME the console prompts
  // the operator to re-attach (with a fresh deploy token, via the Sources screen / Re-attach all). Absent
  // on the normal path (nothing dropped) and on a rolled-back settle (back on the prior version's bindings).
  droppedSources?: string[];
  // componentResults (multi-component updates, ADDITIVE): a component-aware engine that sequences the
  // console component AFTER the engine settles (engine-first ordering) may report those per-component
  // outcomes on the settle result. Absent from every older engine; the console renders the rows only when
  // present and detects "the console was applied" from either result's entries.
  componentResults?: ComponentApplyResult[];
}

// StandaloneRollbackResult is POST /admin/update/rollback (W4): a first-class, always-available revert to the
// recorded known-good version, independent of an in-flight apply. It is the SAFE recovery direction, so the
// engine never gates it behind a second owner. Outcomes (mirrors engine/src/admin/update-apply.ts):
//   "reverted"            rolled back to the known-good version AND the canary sings on it.
//   "reverted-unverified" rolled back, but the canary could not confirm it healthy; investigate (data + recovery
//                         are still safe, archives immutable, restore out-of-band).
//   "no-target"           there is no recorded prior version to roll back to; nothing was changed.
//   "already"             the engine is already on the target version; nothing was changed.
//   "failed"              the rollback could not be performed; nothing was half-applied (deploys are atomic).
// It never 500s; every path is a structured result with a plain-words reason. No value, key or token here.
export interface StandaloneRollbackResult {
  // "dry-run" (ADDITIVE): a PLAN read (no token spent), mirroring how PromoteResult's
  // own "dry-run" already separates plan-reading from spending the token. It carries the same fields a live
  // rollback would (toVersion, paired, pairedConsole) so the console can show the s6 paired-rollback line
  // BEFORE the token is pasted, without a new parallel type. Never returned from a live (token-bearing) call.
  outcome: "reverted" | "no-target" | "already" | "failed" | "reverted-unverified" | "dry-run";
  fromVersion?: string; // the version that was live before the rollback
  toVersion: string; // the known-good version reverted to (or attempted)
  canaryVerdict?: CanaryLiveness;
  steps: UpdateStep[];
  reason?: string;
  // paired (ADDITIVE): true when this is/would-be an ENGINE rollback whose target
  // version is OLDER than the live console's persisted minEngineVersion floor, so the engine bundles (or, on
  // a dry-run plan read, WOULD bundle) a console rollback with it rather than stranding an incompatible pair.
  // Absent/false is the common case (console rollback alone; an engine rollback that satisfies the floor).
  paired?: true;
  // pairedConsole (ADDITIVE): the console's own rollback outcome (a live paired rollback) or planned target
  // (a dry-run plan read), present only when paired is true. Absent otherwise.
  pairedConsole?: { toVersion?: string };
}

// RampResult is POST /admin/update/ramp (W4, OPT-IN; TWO-PHASE, asvs-HI-13, exactly like apply's
// promote/settle split): phase 1 verifies + uploads + shifts `percentage`% of LIVE traffic to the new
// version and returns immediately. It NEVER flies the canary: the request that shifted traffic is still
// executing the pre-ramp code, so an inline flight would necessarily re-test the OLD version and falsely
// report the ramped one healthy. A genuinely separate POST /admin/update/ramp/settle call (RampSettleResult
// below) verifies the ramped slice and keeps or rolls back. Outcomes (mirrors engine update-ramp.ts
// RampOutcome, verified):
//   "ramp-pending" the new version is serving `percentage`% of live traffic, NOT YET VERIFIED; a pending
//                  verification is recorded (the pending card finishes it via the ramp settle).
//   "refused"      refused BEFORE any traffic shift (failed verify, a required migration, a too-old engine,
//                  dual control, a bad percentage, or a driver that cannot ramp); `reason` says why; the
//                  engine is unchanged.
//   "no-update"    already on the recommended version.
// Like apply, a migration/breaking ramp may return HTTP 202 (owner-action queued), handled by applyUpdate's
// sibling rampUpdate below. Never 500s; no value, key or token in the payload.
export interface RampResult {
  outcome: "refused" | "ramp-pending" | "no-update";
  recommendedVersion: string;
  fromVersion?: string;
  toVersion?: string;
  percentage?: number; // the live share the new version is serving (on "ramp-pending"; unverified)
  canaryVerdict?: CanaryLiveness;
  steps: UpdateStep[];
  reason?: string;
}

// RampSettleResult is POST /admin/update/ramp/settle (asvs-HI-13, the ramp's phase 2): a genuinely SEPARATE
// request from the ramp start (which never flies the canary, it cannot, it is still running the pre-ramp
// code). A ramp settle is only PROBABILISTICALLY routed onto the ramped slice (traffic is still split), so
// unlike the atomic settle an "alive" canary alone cannot prove the ramped code was observed: the engine
// consults self-identity and reports "inconclusive" when a keep decision cannot be trusted. Rollback is
// always the safe direction and never gated on self-identity. It is MUTUALLY EXCLUSIVE with the plain
// settle: the engine's POST /update/settle refuses a pending carrying a `percentage`, and this route refuses
// one without, so a pending record is always settled by exactly one of the two. Outcomes (mirror
// engine/src/admin/update-ramp.ts RampSettleOutcome):
//   "applied"      the ramped version passed on its OWN code (self-identity confirmed); it stays live at its
//                  configured percentage and the pending is consumed. Promote to 100% with the normal apply.
//   "rolled-back"  it did not pass; the engine reverted to 100% on the prior version. Nothing was lost.
//   "inconclusive" THIS request did not land on the ramped slice, so its healthy-looking result proves nothing
//                  about the ramped version. NOTHING was changed and THE PENDING STAYS ARMED: it is a
//                  retry-meaningful non-fault, not an error, and each retry is a fresh dispatch with its own
//                  chance of landing. It is also the ONLY producer of the engine's `update-settle-inconclusive`
//                  posture counter, which is what separates "the operator tried all night and the dispatch
//                  never landed" from "nobody has pressed the button".
//   "rollback-failed-still-split"  the ramped version did not pass AND the rollback to 100% prior FAILED. The
//                  deployment is STILL SPLIT: a share of live customer traffic is reaching the suspect version
//                  right now. The loudest outcome in the update surface, and it is never rendered as a settle
//                  that concluded safely.
// Never 500s; no value, key or token in the payload.
export interface RampSettleResult {
  phase: "ramp-settle";
  outcome: "applied" | "rolled-back" | "inconclusive" | "rollback-failed-still-split";
  recommendedVersion: string;
  fromVersion: string;
  toVersion: string;
  canaryBaseline?: CanaryLiveness;
  canaryVerdict?: CanaryLiveness;
  steps: UpdateStep[];
  reason?: string;
}

// OwnerActionQueued is the engine's HTTP 202 owner-action dual-control response for a CONSEQUENTIAL update
// (a migration/breaking apply or ramp when dual control is ON): the first call RECORDS a pending approval and
// returns { ownerActionQueued: true, id, status: "pending" } WITHOUT requiring the token. A SECOND owner
// approves the action, then the owner RE-SUBMITS with the token and the action proceeds. This is a DIFFERENT
// mechanism from the config-change 202 ({ pending: true, id }), it is the owner-action inbox the engine gates
// the apply/ramp/keep direction behind (engine ownerActionQueuedResponse). The console surfaces it as "queued
// for a second owner's approval" rather than a false success. id is the owner-action record id; no secret here.
export interface OwnerActionQueued {
  ownerActionQueued: true;
  id: string;
  status: "pending";
}

// UpdateApplyResult is the discriminated result of applyUpdate / rampUpdate: either the engine's structured
// outcome ("result"), or the 202 owner-action dual-control queue ("queued"). A live apply/ramp of a
// migration/breaking release with dual control ON returns the queue on the FIRST (tokenless) call; the
// console then tells the owner it is awaiting a second owner's approval rather than claiming it deployed.
export type UpdateApplyResult<T> =
  | { status: "result"; value: T }
  | { status: "queued"; id: string };

// isOwnerActionQueued recognises the engine's 202 owner-action body (ownerActionQueued === true + a non-empty
// string id). Anything else (a normal PromoteResult/RampResult on a 2xx) is the applied/structured path, so a
// malformed 202 degrades to the structured branch rather than fabricating a queued id. Pure runtime guard.
export function isOwnerActionQueued(v: unknown): v is OwnerActionQueued {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.ownerActionQueued === true && typeof o.id === "string" && o.id.length > 0;
}

// UpdateStatusRecord is GET /admin/update/status: the safe-apply lifecycle view. `pending` is non-null ONLY
// when a prior apply PROMOTED a new version but never settled it (e.g. the page was closed between phase 1
// and phase 2), the console surfaces a calm "verification pending for vX" banner with a "verify now / roll
// back" action (re-collecting the token), and the hourly canary will also verify it. `last` is the most
// recent completed update's compact outcome ("applied vX" / "rolled back"), or null before any update.
// Redaction-safe: version ids, an outcome enum, a canary verdict, who/when and a coarse reason only, never
// the token, a value or a key.
// UpdateSettledOutcome is the shape of one settled component's outcome (`last` and `lastConsole` share it
// byte-for-byte; the engine writes both from the SAME UpdateLast record shape, see engine
// scheduler-do-records.ts). Named so `lastConsole` does not have to repeat the union or its long comment.
export interface UpdateSettledOutcome {
  // The ENGINE's real persisted last-outcome vocabulary (verified against router-updates.ts's
  // /update-settled writes; the engine types the field loosely as `string`, so this closed union is the
  // console's own tightening and MUST track what the engine actually writes). "expired" (a pending older
  // than an hour, live version healthy) and "superseded" (the live version is no longer the one that
  // pending promoted) are the two benign stale-pending-clear outcomes; recordedSettleOutcome maps BOTH to
  // the reassuring "a leftover verification was cleared; nothing was changed" line instead of the dishonest
  // "could not be read". ("expired-cleared" is kept defensively -- it is this console's render kind, not a
  // wire value the engine emits, but accepting it costs nothing and the mapper handles all three.)
  //
  // "rollback-failed" and "applied-unconfirmed" are the engine's two members, and they were MISSING
  // here for as long as the engine has emitted them. They are the two worst states the update path can
  // reach: rollback-failed means the canary rejected the new version, the automatic rollback deploy ITSELF
  // failed, and the engine is STILL SERVING the rejected build; applied-unconfirmed means the promote was
  // accepted and the confirming read-back could not be performed, so the live version is not proven. The
  // engine writes both into this field and clears `pending` and `rollbackNeeded` in the same DO write, so
  // nothing else is left to tell the operator. With them absent from this union every reader fell through
  // its default arm and the licence screen rendered a green "Up to date" tile with no last-update line and
  // no rollback control. The parity is now CHECKED rather than asserted, by
  // test/validate-update-outcome-vocabulary.ts, which reads the engine's own enum.
  outcome: "no-update" | "dry-run" | "refused" | "promoted" | "applied" | "rolled-back" | "rollback-failed" | "applied-unconfirmed" | "expired" | "superseded" | "expired-cleared";
  recommendedVersion?: string;
  fromVersion?: string;
  toVersion?: string;
  canaryVerdict?: CanaryLiveness;
  at: string;
  by: string | null;
  reason?: string;
  // confirmationPending (ADDITIVE): mirrors SettleResult.confirmationPending, persisted onto the last
  // completed outcome so a fresh page load (not just the live flow that just applied it) still renders the
  // applied-confirmation-pending first-class outcome (design s5) rather than a plain "applied". Present only
  // when outcome is "applied" and the hourly canary has not yet confirmed the new version in the background.
  confirmationPending?: boolean;
  // artefactSha384 + readback (ADDITIVE): the signed channel digest of the artefact this
  // outcome concerns (copied from the pending at settle) and the promote's read-back verdict, so the
  // settled record is self-contained evidence of WHICH bytes went live and whether the platform held
  // them byte-exactly. Absent on older engines and pre-provenance records.
  artefactSha384?: string;
  readback?: UpdateReadbackRecord;
  // component (multi-component updates, ADDITIVE): names which component this outcome settled ("engine",
  // or absent on every legacy record; "console" on a record read off `lastConsole`). Not read by this
  // console today (the slot itself, `last` vs `lastConsole`, already says which component); carried in the
  // type because the engine writes it (scheduler-do-records.ts UpdateLast.component).
  component?: string;
}

export interface UpdateStatusRecord {
  pending: null | {
    fromVersion: string;
    toVersion: string;
    recommendedVersion: string;
    canaryBaseline?: CanaryLiveness;
    promotedAt: string;
    promotedBy: string | null;
    // percentage (asvs-HI-13) is THE DISCRIMINATOR BETWEEN THE TWO SETTLE ROUTES, and the console was blind
    // to it. The engine writes it onto a pending record ONLY from the opt-in gradual ramp (never from the
    // atomic apply, see engine scheduler-do-records.ts), and its presence is what makes POST /update/settle
    // and POST /update/ramp/settle mutually exclusive: each refuses the other's shape. Until this field
    // existed here, the pending card could not see the shape, so it sent EVERY pending to the plain settle,
    // and a ramped pending was met with the engine's "this pending verification is a gradual ramp; use the
    // ramp settle call instead" refusal, with no console control that could ever send the other call. It is
    // the live traffic percentage the ramped version is serving. Absent on every atomic pending.
    // The discriminator the engine itself uses (router-updates-ramp.ts handleRampSettle): a pending WITH a
    // percentage settles via POST /update/ramp/settle, one without via POST /update/settle.
    percentage?: number;
    // artefactSha384 + readback (ADDITIVE): the signed channel digest this promote verified,
    // and the post-upload read-back verdict, persisted at promote time. Absent on older engines.
    artefactSha384?: string;
    readback?: UpdateReadbackRecord;
  };
  last: null | UpdateSettledOutcome;
  // lastConsole (multi-component updates, ADDITIVE): the CONSOLE component's own last settled outcome, the
  // exact twin of `last` (identical shape -- see engine scheduler-do-records.ts, which writes both from the
  // same UpdateLast record) but for the console component alone. A console-only apply verifies, uploads,
  // promotes and confirms in ONE request (there is no console canary to settle later, so it never leaves a
  // `pending` record the way an engine promote can), and the engine records that single-request outcome
  // here, never into `last` (which stays the ENGINE's exclusively, so a later engine rollback can never
  // resolve a console version id as its target). Live-confirmed missing from this type entirely until the
  // gap it caused was found (a console-only apply's own outcome had nowhere to be read from, so both the
  // live apply flow and a re-read of this record after a reload had no way to recognise it as settled --
  // see recordedSettleOutcome's `component` parameter). Absent = no console component has ever settled here.
  lastConsole?: null | UpdateSettledOutcome;
  // rollbackNeeded (engine FOLD 1) is set when the HOURLY CANARY found a promoted-but-unsettled new version
  // UNHEALTHY: the engine cannot auto-roll-back unattended (it deliberately holds no deploy credential), so it
  // records that a ONE-CLICK rollback is needed. The console surfaces it as an URGENT rollback prompt. It is
  // CLEARED on any settle/rollback. Additive + presence-safe: an older engine / no detection reads as null.
  // Redaction-safe (version ids + a coarse canary verdict + a timestamp; never the token, a value or a key).
  rollbackNeeded?: null | {
    recommendedVersion: string;
    toVersion: string;
    canaryVerdict: string;
    at: number;
  };
}
