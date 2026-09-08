// Shared leaf helpers, the pure (DOM-free) decision logic and the screen-local types for the
// Licence and updates screen. These are the small building blocks more than one of the section
// modules reaches for: the summary-band tile tone/label helpers, the safe-apply state machine and
// the release-metadata helpers (all pure, exercised by validate-licence.ts in Node without a
// DOM), the detail-row builders, the heading ids the section modules anchor focus on, and the
// shared step-checklist renderer. They live in this leaf so no section module imports another
// section module (which would form a cycle); each section imports one way from here. Moved verbatim
// from the licence coordinator for size; behaviour, copy and markup are unchanged.
//
// House rules: Australian English, no em dashes, precise claims ("tamper-evident", "post-quantum
// hybrid").

import { h } from "../../lib/dom.ts";
import { statusWithLabel, type StatusTone } from "../../components/status.ts";
import { refusalTextFrom } from "../../components/error-view.ts";
import { dateOnly } from "../../lib/format.ts";
import { licenceExpired } from "../../lib/billing.ts";
// The ONE version-skew decision, shared with the Overview's Updates tile (lib/update-skew.ts). The
// uncomparable arms below used to test the raw field and spell their own copy, so the Overview's tile
// could (and did) go on rendering a green "Up to date" for the very same payload. Both surfaces now read
// one predicate and print one set of words.
import { skewUncomparable, SKEW_UNCOMPARABLE_VALUE, SKEW_UNCOMPARABLE_LABEL } from "../../lib/update-skew.ts";
import { EXPIRED_CLEARED_LINE } from "./update-outcome-copy.ts";
import type {
  LicenceStatus,
  UpdateStatus,
  StatusReport,
  UpdateStatusRecord,
  PromoteResult,
  SettleResult,
  StandaloneRollbackResult,
  UpdateStep,
  RiskClass,
  ComponentApplyResult,
  UpdateComponentId,
} from "../../api.ts";

// LicenceData is the settled payload the render assembles from the four engine reads (licence,
// updates, status and the safe-apply lifecycle record). updateState is honestly null when the
// engine predates the safe-apply route (a fail-open null), so an older engine simply shows no
// safe-apply control.
export interface LicenceData {
  licence: LicenceStatus;
  updates: UpdateStatus;
  status: StatusReport;
  // updateState is the safe-apply lifecycle (GET /admin/update/status): any pending (promoted-but-not-
  // settled) update + the last completed outcome. It loads alongside the rest so the Updates section can
  // surface a "verification pending" banner and the compact "last update" line. Honestly absent if the
  // engine predates the route (a fail-open null), so an older engine simply shows no safe-apply control.
  updateState: UpdateStatusRecord | null;
}

// ---------------------------------------------------------------------------
// Heading ids (focus anchors)
// ---------------------------------------------------------------------------

// The id of the Licence card heading. The activation section (folded into the Licence card) moves focus
// here after a successful Activate / Replace / Remove reload, so a keyboard/screen-reader operator lands on
// the card they just acted on rather than at <body> (the toast already announces via role=status; this is
// focus placement only). The heading carries tabindex=-1 so it is a programmatic focus target.
export const LICENCE_CARD_HEADING_ID = "licence-card-heading" as const;

// The id of the safe-apply update control's heading. After an apply/settle reload() replaces the async
// region (dropping focus to <body>), the update control moves focus back here so a keyboard/AT operator
// lands on the control they just acted on (the toast already announces the outcome via role=status; this is
// focus placement only). The heading carries tabindex=-1 so it is a programmatic focus target.
export const UPDATE_CARD_HEADING_ID = "update-card-heading" as const;

// The id of the standalone rollback control's heading (same focus-restore reason as UPDATE_CARD_HEADING_ID).
export const ROLLBACK_CARD_HEADING_ID = "rollback-card-heading" as const;

// The id of the Updates SECTION heading (the "Updates" h2 in view.ts). The shell's context-bar
// "Update available" chip deep-links to /licence?open=updates; the coordinator scrolls to + focuses
// this heading once the async region has rendered, so the operator lands on the update facts and
// the one apply control, not the top of the screen. tabindex=-1 makes it a programmatic focus target.
export const UPDATES_HEADING_ID = "updates-heading" as const;

// ---------------------------------------------------------------------------
// Summary band helpers
// ---------------------------------------------------------------------------

// licenceTileTone maps a licence to a tile status tone. Community is a fully
// working state, so it reads neutral rather than warn. Paid-valid reads ok.
// Invalid reads warn: the data path is unaffected, but the operator should check.
export function licenceTileTone(lic: LicenceStatus): StatusTone {
  if (lic.valid) return lic.tier === "community" ? "neutral" : "ok";
  return "warn";
}

export function licenceTileLabel(lic: LicenceStatus): string {
  if (lic.valid) return lic.tier === "community" ? "Community, fail-open" : "Paid, valid";
  // An EXPIRED licence is named as such rather than folded into the generic invalid label. The tile's value
  // beside it reads "Community", because that is the tier the engine fails open to, so "Licence not valid"
  // left the whole band saying nothing a customer could tell apart from never having bought one. Expiry has
  // a remedy the customer can act on and the other invalid causes do not share it.
  if (licenceExpired(lic)) return "Licence expired";
  return "Licence not valid";
}

// updateTileTone derives the update tile's tone from the UpdateStatus.
// "update available" is info (informational, not alarming); not-yet-verified is
// warn; unconfigured is neutral; up-to-date is ok. consoleUpdate (additive,
// default false so every existing caller is unchanged) is the SPA's own verdict
// that a CONSOLE update is offered (components.console vs the baked version), so
// a console-only release still reads "Available" here, not a false "up to date".
//
// unresolved (additive, default "none" so every existing caller and every old engine renders exactly as
// before) is updateUnresolved() below: the engine's last settle recorded a state it cannot prove it is out
// of. It is tested FIRST and it outranks everything, because in BOTH of those states updateAvailable is
// false (the engine is running the very version the channel recommends) and configured and verified are
// both true, so this tile read a green "Up to date" over an engine that was either serving a rejected build
// or unable to say which build it was serving.
export function updateTileTone(upd: UpdateStatus, consoleUpdate = false, unresolved: UpdateUnresolved = "none"): StatusTone {
  if (unresolved === "rollback-failed") return "danger";
  if (unresolved === "unconfirmed") return "warn";
  if (upd.updateAvailable || consoleUpdate) return "info";
  if (!upd.configured) return "neutral";
  if (!upd.verified) return "warn";
  // The engine could not read one of the two version strings, so it does not know which way the skew runs.
  // A could-not-check outranks a pass: this may NOT fall through to the healthy arm below.
  if (skewUncomparable(upd)) return "warn";
  return "ok";
}

export function updateTileValue(upd: UpdateStatus, consoleUpdate = false, unresolved: UpdateUnresolved = "none"): string {
  if (unresolved === "rollback-failed") return "Action needed";
  // NOT "Up to date". The engine deployed a version and could not confirm which one is live, so the tile
  // must not claim a state it has no proof of; and NOT "Action needed" either, because nothing is known to
  // be wrong. "Unconfirmed" is the only one of the three that is true.
  if (unresolved === "unconfirmed") return "Unconfirmed";
  if (upd.updateAvailable || consoleUpdate) return "Available";
  if (!upd.configured) return "Not set";
  if (!upd.verified) return "Unverified";
  if (skewUncomparable(upd)) return SKEW_UNCOMPARABLE_VALUE;
  return "Up to date";
}

export function updateTileLabel(upd: UpdateStatus, consoleUpdate = false, unresolved: UpdateUnresolved = "none"): string {
  if (unresolved === "rollback-failed") return "Rollback did not complete";
  // The label differs from the tile VALUE ("Unconfirmed"), on the same rule the healthy arm below follows:
  // a tile never reads the same phrase twice.
  if (unresolved === "unconfirmed") return "Live version not confirmed";
  if (upd.updateAvailable || consoleUpdate) return "Update available";
  // Named before the two channel-state arms below because it is a DIFFERENT fault: the channel verified
  // fine and it is the VERSIONS that cannot be read, so "Configured, not verified" would send an operator
  // to check the wrong thing. The arm sits after those two in the value and tone functions for the same
  // reason in reverse: an unverified channel is the more fundamental fault and outranks this.
  if (skewUncomparable(upd) && upd.configured && upd.verified) return SKEW_UNCOMPARABLE_LABEL;
  // "Channel not set" is the one phrase for the unconfigured state, shared with the
  // signing tile beside it (two phrasings for one state read as two states).
  if (!upd.configured) return "Channel not set";
  if (!upd.verified) return "Configured, not verified";
  // The healthy label differs from the tile VALUE ("Up to date"), so the tile never
  // reads the same phrase twice ("Up to date • Up to date").
  return "Nothing pending";
}

// signingTileTone: trust = channel configured and verified; warn = configured, not
// verified; neutral = not configured or no channel data.
export function signingTileTone(upd: UpdateStatus): StatusTone {
  if (upd.configured && upd.verified) return "trust";
  if (upd.configured) return "warn";
  return "neutral";
}

// signingTileValue: plain words at first contact ("posture" and the cipher-suite
// string stay out of the at-a-glance band; the scheme detail lives in Provenance).
export function signingTileValue(upd: UpdateStatus): string {
  if (upd.configured && upd.verified) return "Verified";
  if (upd.configured) return "Not yet verified";
  return "Not set";
}

export function signingTileLabel(upd: UpdateStatus): string {
  if (upd.configured && upd.verified) return "Signer verified";
  if (upd.configured) return "Configured, not verified";
  return "Channel not set";
}

// ---------------------------------------------------------------------------
// Safe-apply update, pure state logic (validated, DOM-free)
// ---------------------------------------------------------------------------

// The capability the engine gates POST /admin/update/apply and /settle on. keys.ceremony is OWNER-RESERVED
// (a group can confer access.policy, never keys.ceremony, the engine's identity model), so only the Owner
// can apply an engine update; the console mirrors EXACTLY this gate as disabled-with-reason UX (the engine
// ENFORCES it server-side regardless of what the console shows). It is the SAME capability the licence
// activation control gates on, so the two owner-only controls on this screen read consistently.
export const UPDATE_MANAGE_CAP = "keys.ceremony" as const;

// UpdateControlState is the discriminated decision for WHAT the safe-apply control renders, derived purely
// from the UpdateStatus (is an update offered?) and the UpdateStatusRecord (is one mid-flight?). Keeping it
// a pure function (not buried in the DOM builder) is what lets validate-licence.ts prove the state machine
// without a browser:
//   "none"      no update is available AND nothing is pending, the control does not render at all (the
//               read-only Updates facts stay as they are; §7a calm-density, no empty interactive box).
//   "pending"   a prior apply PROMOTED a new version but never settled it (page closed mid-update, etc.):
//               surface the calm "verification pending for <toVersion>" banner with verify-now / roll-back.
//               This OUTRANKS "available": an unsettled promote is the urgent thing to finish first.
//   "available" an update is available and nothing is pending, show the preview + update-now control.
//
// The "pending" arm carries `percentage` because the pending's SHAPE decides WHICH settle route can finish it,
// and the console used to be blind to that: the engine records a `percentage` on a pending ONLY when it came
// from the opt-in gradual ramp, POST /update/settle refuses that shape, and POST /update/ramp/settle refuses
// the shape without it. Absent means an ATOMIC pending (the plain settle); present means a RAMPED one (the
// ramp settle), and it is the live traffic percentage the ramped version is serving.
export type UpdateControlState =
  | { kind: "none" }
  // percentage is present ONLY for a gradual-ramp pending (the engine's own discriminator): it is the
  // live share the unverified version is serving, and it routes the finish action to the RAMP settle
  // endpoint (the atomic settle refuses a ramp pending, and vice versa).
  | { kind: "pending"; toVersion: string; recommendedVersion: string; percentage?: number }
  | { kind: "available" };

// UpdateBodyEnv groups the shared render context the two update-body builders (availableUpdateBody /
// pendingUpdateBody) both take: the single progress/error region they write into, the reload + focus-restore
// callbacks the control runs after a successful settle, and the resolved owner gate. Grouping them into one
// options object keeps each builder under the four-parameter limit (finding console-src-037-04 / -05).
export interface UpdateBodyEnv {
  // The shared calm progress/error region every handler writes into (role=status, one channel).
  out: HTMLElement;
  // Re-render the Updates section after a successful settle (the control's nodes are then replaced).
  reload: () => void;
  // Move focus back to the control's heading after a reload() so a keyboard/AT operator is not dropped to body.
  restoreFocus: () => void;
  // The resolved owner gate (canCap(UPDATE_MANAGE_CAP)); the engine still enforces keys.ceremony regardless.
  canManage: boolean;
  // destConfigured (design/updates/UPDATE-UX-015-DESIGN.md s4/s7): whether at least one destination is
  // configured, REUSED verbatim from the engine's existing StatusReport.destConfigured fact (discovered on
  // the licence screen's own status read, already loaded for the tile band; no new wire field needed for
  // this). A live apply can never confirm a canary flight with nowhere to fly it, so when this is false the
  // apply control is replaced by the destination-gate line + a link to /destinations (Preview stays
  // available, it deploys nothing). Defaults true in every existing/legacy call so the gate only ever
  // SUBTRACTS a control, never a silent behaviour change for a caller that predates this field.
  destConfigured: boolean;
}

// updateControlState is the single predicate the Updates section branches on. A pending promote takes
// precedence over an available update (finish the in-flight one first); otherwise an available update shows
// the apply control; otherwise nothing. A null updateState (older engine / transient) simply means "no
// pending known", so the available/none decision falls through to updates.updateAvailable. consoleUpdate
// (additive, default false so every existing caller and every old engine renders exactly as before) is the
// SPA's own console-component verdict (consoleUpdateAvailable): a console-only release must still surface
// the apply control even when the engine itself reports no engine update.
export function updateControlState(updates: UpdateStatus, updateState: UpdateStatusRecord | null, consoleUpdate = false): UpdateControlState {
  const pending = updateState?.pending;
  // The ramp shape is threaded through VERBATIM (only when the engine actually recorded one, so an atomic
  // pending and an old engine both stay exactly as they were): it is the discriminator the pending card routes
  // its settle call on.
  if (pending) {
    return {
      kind: "pending",
      toVersion: pending.toVersion,
      recommendedVersion: pending.recommendedVersion,
      ...(typeof pending.percentage === "number" ? { percentage: pending.percentage } : {}),
    };
  }
  if (updates.updateAvailable === true || consoleUpdate === true) return { kind: "available" };
  return { kind: "none" };
}

// lastUpdateSummary renders the compact "Last update: …" line from the lifecycle record's `last` outcome, or
// null when there is nothing to show. It is deliberately terse and reassuring: a rollback reads as a
// controlled, safe outcome ("rolled back to <fromVersion>"), never an alarm, because data and recovery were
// never at risk. dry-run / no-update are not worth a standing line (they changed nothing), so they yield null
//, the line is for outcomes an operator would want a memory of (a real apply, a rollback, a refusal). Pure
// + DOM-free so the validator pins the copy per outcome.
export function lastUpdateSummary(updateState: UpdateStatusRecord | null): string | null {
  const last = updateState?.last;
  if (!last) return null;
  switch (last.outcome) {
    case "applied":
      return last.toVersion ? `Last update: applied ${last.toVersion}.` : "Last update: applied.";
    case "rolled-back": {
      // Reassuring, not alarming: the rollback is the safety net working. Name where it landed when known,
      // and the engine's RECORDED reason when it persisted one (persistence-first settle), so the standing
      // line carries the why, not just the fact.
      const detail = last.reason ? `${last.reason}; nothing was lost` : "the canary did not confirm the new version; nothing was lost";
      return last.fromVersion ? `Last update: rolled back to ${last.fromVersion} (${detail}).` : `Last update: rolled back (${detail}).`;
    }
    case "rollback-failed": {
      // NOT the reassuring voice above. This standing line is the only thing a fresh page load (no live flow,
      // no pending, rollbackNeeded already cleared by the settle) had to tell the operator, and it used to
      // render nothing at all through the default arm below.
      const on = last.toVersion ? `still running ${last.toVersion}, the version that failed` : "still running the version that failed";
      const back = last.fromVersion ? ` Roll back to ${last.fromVersion}.` : " Roll back from here.";
      return `Last update: the rollback did NOT complete, your engine is ${on}.${back}`;
    }
    case "applied-unconfirmed":
      return last.toVersion
        ? `Last update: ${last.toVersion} was deployed, but the engine could not confirm which version is live.`
        : "Last update: deployed, but the engine could not confirm which version is live.";
    case "refused":
      return last.reason ? `Last update: not applied, ${last.reason}.` : "Last update: not applied (the engine was left unchanged).";
    case "expired-cleared":
      // The design's exact standing sentence (s2/s5), UNPREFIXED (it is not phrased as "Last update: ...",
      // it is its own first-class reassurance) -- a first load straight onto this outcome (no live flow ran)
      // must read identically to the flow's own terminal rendering of the same outcome.
      return EXPIRED_CLEARED_LINE;
    case "no-update":
    case "dry-run":
    case "promoted":
      // no-update / dry-run changed nothing worth a standing line; a bare "promoted" is a mid-flight state
      // the pending banner already owns, so it is not summarised here as a completed outcome.
      return null;
    default:
      return null;
  }
}

// standaloneRollbackOffered decides whether the FIRST-CLASS standalone "Roll back to the previous version"
// control renders, independent of an in-flight apply. The engine records a rollback target the first time an
// update is applied from here and clears it once back on a known-good version, so a target plausibly exists when
// there is EITHER a pending verification (its fromVersion is the target), OR a `last` outcome of applied /
// rolled-back / promoted (an apply happened, so a prior version was recorded). It is NOT offered before any
// update has ever been applied (no `last`, no pending), the engine would have no target and the control would
// always refuse (§7a: no dead affordance). The urgent rollbackNeeded case is handled separately by the caller;
// this predicate covers the calm standing offer. The engine remains the authority (it re-derives and may still
// return "no-target"); this only avoids rendering a button that is guaranteed to refuse. Pure + DOM-free.
export function standaloneRollbackOffered(updateState: UpdateStatusRecord | null): boolean {
  if (!updateState) return false;
  if (updateState.pending) return true;
  const outcome = updateState.last?.outcome;
  // rollback-failed and applied-unconfirmed BOTH recorded a prior version, so a target exists; withholding
  // the control on those two withheld it in the two states that need it most, which is the
  // remedy-exists-in-the-product-and-is-not-offered shape. rollback-failed is normally served by the URGENT
  // control (updateIncident below), and view.ts suppresses this standalone one when that renders, so this
  // arm is the fallback rather than a second affordance.
  return outcome === "applied" || outcome === "rolled-back" || outcome === "promoted" || outcome === "rollback-failed" || outcome === "applied-unconfirmed";
}

// updateIncident is the predicate that says an operator must act now, derived from the RECORDED settle
// outcome rather than from `rollbackNeeded` alone.
//
// WHY IT IS NOT rollbackNeeded. The engine sets rollbackNeeded when the HOURLY CANARY finds a promoted but
// UNSETTLED version unhealthy, and the engine's own settle path CLEARS it (setUpdateSettled writes
// pending:null and carries no rollbackNeeded forward on the engine branch). A settle that records
// rollback-failed therefore leaves rollbackNeeded absent, pending null and updateAvailable false, because
// the engine is now running exactly the version the channel recommends. Every signal the licence screen had
// said "nothing to see", and the one signal that said otherwise was a field nobody read.
//
// So: a recorded rollback-failed IS an incident, and it outranks an available update in the same way the
// hourly-canary case does (fix the live engine first). applied-unconfirmed is deliberately NOT an incident:
// nothing is known to be wrong, only unproven, and it gets a standing line and a rollback control rather
// than an alarm. Pure + DOM-free so the validator pins it.
export type UpdateUnresolved = "none" | "rollback-failed" | "unconfirmed";

// updateUnresolved is the TILE's own three-state view of the same records updateIncident reads, and the two
// are deliberately not one predicate. An incident demands an urgent control; an unconfirmed apply does not.
// But BOTH are states the engine cannot prove it is out of, and neither may render as "Up to date", which
// is a claim of proof. Pure + DOM-free so the validator pins it.
export function updateUnresolved(updateState: UpdateStatusRecord | null): UpdateUnresolved {
  const outcome = updateState?.last?.outcome;
  if (updateState?.pending) return "none"; // a pending has its own banner and its own controls.
  if (outcome === "rollback-failed") return "rollback-failed";
  if (outcome === "applied-unconfirmed") return "unconfirmed";
  return "none";
}

export function updateIncident(updateState: UpdateStatusRecord | null): { onVersion: string | null; target: string | null; reason: string | null } | null {
  const last = updateState?.last;
  if (last?.outcome !== "rollback-failed") return null;
  return { onVersion: last.toVersion ?? null, target: last.fromVersion ?? null, reason: last.reason ?? null };
}

// standaloneRollbackOutcomeLine is the plain-words result of a standalone rollback. "reverted" is reassuring
// (back on the known-good version, the canary sings); "reverted-unverified" notes the canary could not confirm
// (investigate, but data + recovery are still safe); "already" / "no-target" / "failed" each state honestly that
// nothing was changed (and why). Pure + DOM-free so the validator pins the copy per outcome.
export function standaloneRollbackOutcomeLine(r: StandaloneRollbackResult): string {
  switch (r.outcome) {
    case "reverted":
      return `Rolled back to ${r.toVersion}. The canary sings on it; your data and recovery were never affected.`;
    case "reverted-unverified":
      return r.reason
        ? `Rolled back to ${r.toVersion}, but the canary could not confirm it healthy (${r.reason}). Investigate from here, your data and recovery were never affected (archives are immutable, restore is out-of-band).`
        : `Rolled back to ${r.toVersion}, but the canary could not confirm it healthy. Investigate from here, your data and recovery were never affected.`;
    case "already":
      return `The engine is already running ${r.toVersion}; nothing was changed.`;
    case "no-target":
      return "There is no recorded prior version to roll back to, so nothing was changed. A rollback target is recorded the first time you apply an update from here.";
    case "failed":
      return r.reason
        ? `The rollback could not be completed: ${r.reason}. Nothing was half-applied, your data and recovery are unaffected.`
        : "The rollback could not be completed; nothing was half-applied. Your data and recovery are unaffected.";
    default:
      return "The rollback finished; nothing was changed.";
  }
}

// ---- Refusal text: the engine's own reason, and NOTHING else ------------------------------------
//
// THE DEFECT THESE TWO FUNCTIONS HAD. Both were blind string transforms with a `|| raw` fallback: strip a
// verb prefix, strip a trailing ": <status>", show whatever is left. That is correct for the one shape they
// were written for (a refusal the ENGINE composed and the client folded in as "<verb>: <reason>: <status>")
// and wrong for every other shape the same throw can take, because the transport folds INTERNAL PRODUCT
// TOKENS into the message by design and they survive the strip untouched. On the licence-activation field,
// at the moment a customer has just paid, the paste error could read `engine-binding-absent`,
// `console-origin-fault`, `access-redirect`, `html-body-not-json`, a bare `503`, or the browser's own
// `Failed to fetch`. Every one of those is a word this console defines for its own diagnostics; none names
// anything the operator can do, and `503` in a field that otherwise explains typos reads as a corrupt token.
//
// THE TRANSFORM ITSELF NOW LIVES IN components/error-view.ts (refusalTextFrom), beside errorDetail, because
// the shape it reads is the TRANSPORT'S and not this route's: every save in the console throws it, and the
// first three screens a new customer meets were still splicing the raw message. These two wrappers stay,
// and stay verb-specific: a pattern that names the verb it expects is strictly tighter than the generic
// one, so the licence and update fields keep the narrowest possible strip.
//
// No value, key or token is ever in the result either way (the engine's error payload is a coarse reason
// only, and the token is never echoed back; no-custody).

// updateRefusalText turns an applyUpdate()/settleUpdate() rejection into the plain reason to show inline,
// mirroring engineRefusalText for the update verbs. api.ts folds the engine { error } into the throw as
// "apply update: <reason>: <status>" / "settle update: <reason>: <status>" (the same custody as setLicence).
export function updateRefusalText(err: unknown): string {
  return refusalTextFrom(err, /^(?:apply|settle|ramp|roll back) update:\s*/);
}

// engineRefusalText turns a setLicence() rejection into the plain refusal sentence to show inline. On a
// verify-before-store refusal the engine answers HTTP 400 { error } and the client throws
// "set licence: <reason>: <status>" (see api.ts setLicence / readErrorReason), and the operator reads that
// reason verbatim ("licence signature did not verify under the pinned vendor key", "licence expired",
// "pinned vendor key not configured: contact the vendor").
export function engineRefusalText(err: unknown): string {
  return refusalTextFrom(err, /^set licence:\s*/);
}

// ---------------------------------------------------------------------------
// Rich release metadata, pure helpers (validated, DOM-free)
// ---------------------------------------------------------------------------

// riskClassLabel is the plain-words name for a release risk class, for a badge + the "this release is …" line.
// routine = a quiet patch; migration = a release that changes stored shape / needs care; breaking = a release
// that may need an action before/after. The engine always sends a normalised value when verified, so the
// default branch is only ever an older/garbled engine, treated as the cautious "needs care" wording.
export function riskClassLabel(rc: RiskClass | undefined): string {
  switch (rc) {
    case "routine":
      return "Routine update";
    case "migration":
      return "Migration, review before applying";
    case "breaking":
      return "Breaking, review before applying";
    default:
      return "Review before applying";
  }
}

// riskClassTone maps the risk class to a status tone (shape + colour, never colour alone). A routine release is
// calm/neutral info; a migration/breaking release is warn (the one that needs care, the brief's "visually
// distinct"). An absent class is treated as warn (cautious), matching the engine's safe-default normalisation.
export function riskClassTone(rc: RiskClass | undefined): StatusTone {
  return rc === "routine" ? "info" : "warn";
}

// riskClassNeedsCare is the single predicate the section uses to render a migration/breaking release with extra
// care (a warn banner, the steps forced into view). routine = false; anything else (migration/breaking/absent)
// = true (cautious default). This is the SAME class set the engine gates dual control on, so the console's
// "needs care" framing and the engine's second-owner rule agree.
export function riskClassNeedsCare(rc: RiskClass | undefined): boolean {
  return rc !== "routine";
}

// compatBlockedReason returns the plain-words reason an available update CANNOT be applied onto this engine, or
// null when it is compatible. The engine sends compatible:false when the release's minEngineVersion is NEWER
// than the running engine (planAndPromote would refuse before any deploy), so the console disables the apply
// honestly rather than letting the owner click into a guaranteed refusal. Only blocks when an update is
// genuinely available AND the verdict is explicitly false (an absent verdict, an older engine, does not
// block; the engine still enforces server-side). Pure; the apply control reads it.
export function compatBlockedReason(upd: UpdateStatus): string | null {
  if (upd.updateAvailable !== true) return null;
  if (upd.compatible !== false) return null;
  const floor = upd.minEngineVersion;
  return floor
    ? `This release needs engine version ${floor} or newer, but this engine is ${upd.currentVersion}. Update to an intervening version first; applying it now would be refused.`
    : `This release is not compatible with the running engine (${upd.currentVersion}); applying it now would be refused.`;
}

// changelogTypeLabel groups a changelog entry's type into a short, capitalised prefix for its row. The engine's
// type field is free (fix/feature/security/other, displayed as-is), so an unknown value is title-cased rather
// than dropped. Pure.
export function changelogTypeLabel(type: string): string {
  const t = type.trim().toLowerCase();
  if (t === "fix") return "Fix";
  if (t === "feature") return "Feature";
  if (t === "security") return "Security";
  if (t === "other" || t === "") return "Change";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

// artefactHashState returns the engine's self-stamped artefact SHA-384 to display, or null when genuinely
// absent (an unstamped build / older engine). It reads status.artefactSha384 (the real build-stamped digest
// that replaces the old hardcoded "not yet reported" placeholder), trims it, and accepts ONLY a well-formed
// 96-hex-char SHA-384 (the engine's own contract) so a malformed/garbage value is treated as honest absence
// rather than rendered as if it were a real hash. Pure; the provenance card branches on null vs the hash.
export function artefactHashState(status: StatusReport): string | null {
  const raw = status.artefactSha384;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return /^[0-9a-f]{96}$/.test(trimmed) ? trimmed : null;
}

// releasedAgoLine turns an RFC-3339 releasedAt into a calm "Released N days ago (date)" line, or null when the
// stamp is absent/unparseable (no fabricated date). `now` is injectable so the validator pins the arithmetic.
// Pure + DOM-free.
export function releasedAgoLine(releasedAt: string | undefined, now: number = Date.now()): string | null {
  if (typeof releasedAt !== "string" || releasedAt.trim() === "") return null;
  const t = Date.parse(releasedAt);
  if (Number.isNaN(t)) return null;
  const when = dateOnly(releasedAt) || releasedAt;
  const days = Math.floor((now - t) / (24 * 60 * 60 * 1000));
  if (days <= 0) return `Released ${when}.`;
  if (days === 1) return `Released 1 day ago (${when}).`;
  return `Released ${days} days ago (${when}).`;
}

// promoteSummaryLine is the calm "would deploy X, rollback target Y" sentence for a dry-run (and the live
// promote echo). It states the plan in plain words from the PromoteResult, so the operator sees exactly what
// a live apply WOULD do before committing a token. Pure + DOM-free so the validator can pin the copy.
export function promoteSummaryLine(r: PromoteResult): string {
  if (r.outcome === "no-update") return "You are already on the recommended version. Nothing to deploy.";
  const to = r.toVersion ?? r.recommendedVersion;
  const from = r.fromVersion;
  if (r.outcome === "dry-run") {
    return from
      ? `Verified. A live update would deploy ${to} and keep ${from} as the rollback target.`
      : `Verified. A live update would deploy ${to}, with the current version kept as the rollback target.`;
  }
  if (r.outcome === "refused") return r.reason ? `This update was refused: ${r.reason}.` : "This update was refused; the engine is unchanged.";
  // promoted: the new version is live and the console is about to settle (canary-gate) it.
  return from ? `Deployed ${to}. Verifying it now (rollback target ${from})…` : `Deployed ${to}. Verifying it now…`;
}

// settleOutcomeLine is the final plain-words result of a settle. "applied" is a quiet success; "rolled-back"
// is reassuring (the safety net worked, nothing was lost), naming the reason and where it landed. Pure +
// DOM-free for the validator.
export function settleOutcomeLine(r: SettleResult): string {
  if (r.outcome === "applied") return `Update applied. The new version ${r.toVersion} is live and the canary confirmed it.`;
  // rolled-back: emphasise nothing was lost; the engine is back on the prior version, serving as before.
  return r.reason
    ? `Rolled back to ${r.fromVersion}. The canary did not confirm ${r.toVersion} (${r.reason}). Nothing was lost, your data and recovery were never affected, and the engine is running the previous version exactly as before.`
    : `Rolled back to ${r.fromVersion}. The canary did not confirm the new version. Nothing was lost, your data and recovery were never affected, and the engine is running the previous version exactly as before.`;
}

// ---- Persistence-first settle recovery (the settle-response race) --------------------------------
// A settle's HTTP response can LOSE a race against the engine's own auto-rollback deploy (seen live on the
// first 0.1.0 -> 0.1.2 apply: the canary failed ~2s after promote, the engine rolled back, and the settle
// response died with the deploy). The engine now persists the settled outcome (applied / rolled-back +
// reason) to its DO BEFORE any rollback deploy, so the RECORDED status is the truth a broken response
// cannot carry. The console's rule: after a settle that throws or returns a non-definitive result, NEVER
// assert an outcome from the failure itself; re-read the update status and render what the engine recorded.

// SETTLE_UNCONFIRMED_LINE is the interim copy while the recorded outcome is re-read. It deliberately claims
// NOTHING about the update's fate (the old fallback asserted "the new version is live", which was false on
// the raced rollback).
export const SETTLE_UNCONFIRMED_LINE = "The result of the verification could not be confirmed in this response. Checking the outcome the engine recorded…" as const;

// RecordedSettleOutcome is the settle conclusion derived from the re-read UpdateStatusRecord (the persisted
// truth): the engine recorded the update kept ("applied", optionally still confirming in the background --
// design/updates/UPDATE-UX-015-DESIGN.md s3/s5), recorded it rolled back (with its reason), cleared a stale
// pending as expired (s2/s5, a first-class outcome, never "could not be read"), still has it pending
// verification, or the record could not be read at all ("unknown").
export type RecordedSettleOutcome =
  | { kind: "applied"; toVersion: string | null; confirmationPending: boolean }
  | { kind: "rolled-back"; fromVersion: string | null; toVersion: string | null; reason: string | null }
  // Two of the engine's outcomes, which used to fall through to "unknown" and therefore to the stall
  // line. They are DEFINITIVE conclusions, not a settle that has not finished: the engine settled, wrote
  // its record and cleared the pending. What differs is that one of them is an INCIDENT.
  | { kind: "rollback-failed"; onVersion: string | null; target: string | null; reason: string | null }
  | { kind: "applied-unconfirmed"; toVersion: string | null; reason: string | null }
  | { kind: "expired-cleared" }
  | { kind: "pending"; toVersion: string }
  | { kind: "unknown" };

// recordedSettleOutcome maps a re-read UpdateStatusRecord to the settle conclusion. A pending entry means
// the settle genuinely did not complete (the promote is still awaiting verification); a last outcome of
// applied / rolled-back / expired-cleared is the persisted conclusion; anything else (a null record, a read
// failure upstream, an unrelated last outcome) is honestly unknown. Pure + DOM-free for the validator.
//
// `component` (multi-component updates, ADDITIVE) selects WHICH slot to read: "engine" (the default,
// unchanged behaviour for every existing caller) reads `rec.pending`/`rec.last`; "console" reads
// `rec.lastConsole` instead and never consults `rec.pending` (a console apply is single-phase and never
// leaves an engine-shaped pending record awaiting settle -- see UpdateStatusRecord.lastConsole). Before this
// parameter existed, a re-read after a console-only apply (a page reload, or the live flow's own recovery
// path) had no way to find that apply's outcome at all: it is not in `last` (which stays the engine's
// exclusively) and this function never looked at `lastConsole`, so the settle read the WRONG slot (the
// engine's unrelated `last`, which a console-only apply never touches) and reported it honestly-but-wrongly
// as "unknown" whenever the engine had no last-outcome of its own yet.
export function recordedSettleOutcome(rec: UpdateStatusRecord | null, component: "engine" | "console" = "engine"): RecordedSettleOutcome {
  if (!rec) return { kind: "unknown" };
  if (component === "engine" && rec.pending) return { kind: "pending", toVersion: rec.pending.toVersion };
  const last = component === "console" ? rec.lastConsole : rec.last;
  if (last?.outcome === "applied") return { kind: "applied", toVersion: last.toVersion ?? null, confirmationPending: last.confirmationPending === true };
  if (last?.outcome === "rolled-back") {
    return { kind: "rolled-back", fromVersion: last.fromVersion ?? null, toVersion: last.toVersion ?? null, reason: last.reason ?? null };
  }
  // rollback-failed keeps the engine's fromVersion convention (the known-good PRIOR, which is the rollback
  // TARGET and is where the engine is not), so onVersion is toVersion: the build that is live and failing.
  if (last?.outcome === "rollback-failed") {
    return { kind: "rollback-failed", onVersion: last.toVersion ?? null, target: last.fromVersion ?? null, reason: last.reason ?? null };
  }
  if (last?.outcome === "applied-unconfirmed") {
    return { kind: "applied-unconfirmed", toVersion: last.toVersion ?? null, reason: last.reason ?? null };
  }
  // The engine's two BENIGN "a stale pending was tidied up, nothing changed" terminal outcomes, mapped to
  // the one leftover-cleared rendering. It writes "expired" (a pending older than an hour, live version
  // healthy) and "superseded" (the live version is no longer the one that pending promoted); it never
  // writes the literal "expired-cleared" (which is this console's render kind, not a wire value). Accepting
  // the ENGINE's actual strings is what stops both from falling through to the honest-but-wrong "still
  // verifying" stall line -- the exact "recorded outcome could not be read" failure this design set out to fix.
  if (last?.outcome === "expired" || last?.outcome === "superseded" || last?.outcome === "expired-cleared") return { kind: "expired-cleared" };
  return { kind: "unknown" };
}

// recordedSettleOutcomeLine renders the recorded conclusion in plain words (the VERBOSE, support-facing form
// used inside the Details disclosure -- design/updates/UPDATE-UX-015-DESIGN.md s2 moved the step-by-step log
// and this kind of explanatory prose behind Details; the terse happy-path terminal sentence the operator sees
// by default is update-outcome-copy.ts's appliedTerminalLine/rolledBackTerminalLine instead). Honesty rules:
// the applied line is a real success (the record says so), and says so HONESTLY when confirmation is still
// pending in the background (never claims the canary confirmed it before it has); the rolled-back line names
// the engine's recorded reason and is reassuring, not alarming (the safety net worked); expired-cleared is
// its own first-class line (never "could not be read"); the pending line is the ONLY one that invokes the
// hourly canary (it applies only while a verification is genuinely outstanding); unknown asserts nothing.
// Pure + DOM-free so the validator pins each.
export function recordedSettleOutcomeLine(o: RecordedSettleOutcome): string {
  switch (o.kind) {
    case "applied":
      if (o.confirmationPending) {
        return o.toVersion
          ? `Applied: the engine recorded this update as kept, ${o.toVersion} is live. The hourly canary has not yet confirmed it in the background; no action is needed.`
          : "Applied: the engine recorded this update as kept. The hourly canary has not yet confirmed it in the background; no action is needed.";
      }
      return o.toVersion
        ? `Applied and verified: the engine recorded this update as kept, ${o.toVersion} is live and the canary confirmed it.`
        : "Applied and verified: the engine recorded this update as kept and the canary confirmed it.";
    case "rolled-back": {
      const where = o.fromVersion ? ` The engine is running ${o.fromVersion} exactly as before;` : " The engine is running the previous version exactly as before;";
      return o.reason
        ? `The update was rolled back automatically: ${o.reason}.${where} nothing was lost and your data and recovery were never affected.`
        : `The update was rolled back automatically.${where} nothing was lost and your data and recovery were never affected.`;
    }
    case "rollback-failed": {
      // The one line in this family that is deliberately NOT reassuring. Everything else here can honestly
      // say the safety net held; this one cannot, and softening it would restore that lie one layer up.
      const on = o.onVersion ? `${o.onVersion}, the version that failed its check,` : "the version that failed its check";
      const back = o.target ? ` Roll back to ${o.target} from this screen to return to the last known-good version.` : " Roll back from this screen to return to the last known-good version.";
      const why = o.reason ? ` The engine recorded: ${o.reason}.` : "";
      return `The update did not pass and the automatic rollback did not complete, so ${on} is still live.${why}${back} Your data and recovery are unaffected either way: archives are immutable and restore is out-of-band.`;
    }
    case "applied-unconfirmed": {
      const which = o.toVersion ? `${o.toVersion} was deployed` : "the new version was deployed";
      const why = o.reason ? ` The engine recorded: ${o.reason}.` : "";
      return `${which} and the engine could not confirm which version is now live, so this is not the same as a verified apply.${why} Reload the console to see what it reports, and roll back from this screen if it misbehaves.`;
    }
    case "expired-cleared":
      return EXPIRED_CLEARED_LINE;
    case "pending":
      return `The verification has not finished: ${o.toVersion} is deployed and its outcome is not recorded yet. Finish it from this screen (verify now, or roll back); if you leave it, the hourly canary keeps checking it and will alert you if it is unhealthy.`;
    default:
      return "The recorded outcome could not be read. Reload this screen to check the update state; nothing further was changed from here.";
  }
}

// The ramp's two-phase outcome lines live in ./ramp-copy.ts (shared.ts reached its line budget); they are
// re-exported here so importers that reach for them through shared.ts (and the licence barrel) are unchanged.
export { rampOutcomeLine, rampSettleOutcomeLine } from "./ramp-copy.ts";

// queuedForSecondOwnerLine is the plain-words message for a CONSEQUENTIAL update (migration/breaking) that the
// engine deferred to a SECOND owner's approval (HTTP 202 owner-action, when dual control is ON). It mirrors the
// config-change "queued for approval" framing: the action is recorded and awaiting a second owner, NOT applied,
// nothing was deployed, and re-submitting after approval (with the deploy token) completes it. Pure + DOM-free.
export function queuedForSecondOwnerLine(verb: "apply" | "ramp"): string {
  const action = verb === "ramp" ? "gradual ramp" : "update";
  return `This ${action} is queued for a second owner's approval. Because it is a migration or breaking release and dual control is on, a second owner must approve it before it can go live, nothing was deployed and your engine is unchanged. Once another owner approves, come back and apply it again (with your one-shot deploy token) to complete it.`;
}

// settleQueuedForSecondOwnerLine is the SETTLE's own version of the message above, and it deliberately says
// something different, because the state it describes is different. An apply that is queued deployed NOTHING.
// A SETTLE that is queued happens after the promote: the new version is ALREADY LIVE, the canary sang, and
// what a second owner is being asked to approve is the decision to KEEP it (engine router-updates.ts gates
// the keep direction of a migration/breaking settle, never the rollback). Reusing the apply copy here would
// tell the operator their engine is unchanged while the new version serves their traffic. The one reassurance
// that IS true of both is stated plainly: rolling back never needs a second owner, so they are not stuck.
// Pure + DOM-free.
export function settleQueuedForSecondOwnerLine(): string {
  return "Keeping this update is queued for a second owner's approval. The new version is already live and the canary check passed, but because it is a migration or breaking release and dual control is on, a second owner must approve keeping it before the update is finished. Nothing was rolled back. Once another owner approves, come back and verify again (with your one-shot deploy token) to finish. Rolling back does not need anyone's approval, so you can revert at any time.";
}

// ---------------------------------------------------------------------------
// Multi-component updates, pure helpers (validated, DOM-free)
// ---------------------------------------------------------------------------
// A release can carry more than one component (channel schema v2: the engine, and this console). The engine
// relays the per-component map as UpdateStatus.components (additive); the console's own version comes from
// the baked build stamp (lib/console-version.ts). EVERY component-aware affordance derives from these pure
// helpers, and every one of them returns the do-nothing value when `components` is absent, so an old engine
// renders EXACTLY the single-engine experience (the hard degradation rule).

// parseSemverTriple parses "1.2.3" (an optional leading "v" tolerated) into a numeric triple, or null when
// the value is not a plain semver triple. Local to the comparisons below; never throws.
function parseSemverTriple(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// semverNewer is true ONLY when candidate is a strictly newer semver triple than running; equal, older or
// EITHER side unparseable is false (the safe default: never claim an update the versions cannot prove).
export function semverNewer(candidate: string, running: string): boolean {
  const a = parseSemverTriple(candidate);
  const b = parseSemverTriple(running);
  if (a === null || b === null) return false;
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] > b[2];
}

// sameVersion compares two version strings after normalising the optional leading "v" and whitespace, so
// "v0.2.0" and "0.2.0" read as the same version. Pure.
function sameVersion(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().replace(/^v/, "");
  return norm(a) === norm(b);
}

// ComponentRow is one per-component line for the update card: which component, what runs, what the release
// carries, and the honest verdict. state "unknown" is for the cases the versions cannot prove either way
// (this console build is unstamped, or a version does not parse); it renders as plain facts, never a claim.
export interface ComponentRow {
  id: string;
  label: string;
  running: string | null;
  recommended: string;
  state: "update" | "current" | "unknown";
}

// componentLabel is the display name for a component id. The two known components get their proper names;
// a future id is title-cased rather than dropped (additive honesty).
export function componentLabel(id: string): string {
  if (id === "engine") return "Engine";
  if (id === "console") return "Console";
  return id === "" ? "Component" : id.charAt(0).toUpperCase() + id.slice(1);
}

// componentRows derives the per-component rows from the engine's components map + this console's own baked
// version (null = unstamped). Returns [] when the engine sent no map (an old engine), which is the single
// gate every component-aware render checks. Rows are ordered engine first, console second, then any future
// ids alphabetically. The engine row compares the map's recommendedVersion against the engine's own
// reported currentVersion; the console row compares against ownConsoleVersion. Verdicts: strictly newer =
// "update"; the same version (or older, the running side is ahead) = "current"; anything the versions
// cannot prove (unstamped console, an unparseable pair that is not byte-equal) = "unknown".
export function componentRows(upd: UpdateStatus, ownConsoleVersion: string | null): ComponentRow[] {
  const comps = upd.components;
  if (!comps) return [];
  const rank = (id: string): number => (id === "engine" ? 0 : id === "console" ? 1 : 2);
  const ids = Object.keys(comps).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const rows: ComponentRow[] = [];
  for (const id of ids) {
    const info = comps[id];
    if (!info) continue;
    const running = id === "engine" ? upd.currentVersion : id === "console" ? ownConsoleVersion : null;
    let state: ComponentRow["state"];
    if (running === null) state = "unknown";
    else if (sameVersion(info.recommendedVersion, running)) state = "current";
    else if (semverNewer(info.recommendedVersion, running)) state = "update";
    else if (parseSemverTriple(info.recommendedVersion) !== null && parseSemverTriple(running) !== null) state = "current"; // running is ahead: honestly up to date
    else state = "unknown";
    rows.push({ id, label: componentLabel(id), running, recommended: info.recommendedVersion, state });
  }
  return rows;
}

// componentRowLine renders one row as its plain-words line ("Engine 0.1.2 -> 0.2.0", "Console -- up to
// date"), ASCII arrows and dashes only. The unknown states state facts without a verdict. Pure, so the
// validator pins the copy per state.
export function componentRowLine(row: ComponentRow): string {
  if (row.state === "update" && row.running !== null) return `${row.label} ${row.running} -> ${row.recommended}`;
  // "current" states the running version too (never a bare "up to date"): each component owns its own
  // version, so the number is only meaningful when it names its component.
  if (row.state === "current") return row.running !== null ? `${row.label} ${row.running} -- up to date` : `${row.label} -- up to date`;
  return row.running === null
    ? `${row.label} -- version not reported by this build (release carries ${row.recommended})`
    : `${row.label} ${row.running} (release carries ${row.recommended})`;
}

// componentVersionList renders the per-component version rows as a plain status list -- the ONE version
// surface the whole update UI shares (the read-only Updates section and the apply control both use it), so
// there is never a single "platform version" claim to be ambiguous about. Pure DOM over the rows.
export function componentVersionList(rows: ComponentRow[]): HTMLElement {
  const tone = (row: ComponentRow): StatusTone => (row.state === "update" ? "info" : row.state === "current" ? "ok" : "neutral");
  const list = h("ul", { class: "stack-sm", style: "list-style:none;padding-left:0;margin:var(--space-3) 0;display:flex;flex-direction:column;gap:var(--space-1)" });
  for (const row of rows) {
    list.appendChild(h("li", { style: "display:flex;align-items:flex-start;gap:var(--space-2)" }, statusWithLabel(tone(row), componentRowLine(row))));
  }
  return list;
}

// updateVersionRows is the per-component rows for the read-only Updates section: the engine's components map
// when present, else a SINGLE synthesised engine row (an old engine has no map, and one component makes one
// version unambiguous). Never returns a lone "platform version".
export function updateVersionRows(upd: UpdateStatus, ownConsoleVersion: string | null): ComponentRow[] {
  const rows = componentRows(upd, ownConsoleVersion);
  if (rows.length > 0) return rows;
  const running = upd.currentVersion ?? null;
  const recommended = upd.recommendedVersion ?? running ?? "";
  const state: ComponentRow["state"] = running === null ? "unknown" : upd.updateAvailable ? "update" : "current";
  return [{ id: "engine", label: "Engine", running, recommended, state }];
}

// consoleUpdateAvailable is THE console-component nudge decision: the engine advertised a console component
// AND its recommended version is strictly newer than the version baked into THIS running bundle. An
// unstamped build (null) never nudges (it cannot honestly compare), and an old engine (no components map)
// never nudges. Pure.
export function consoleUpdateAvailable(upd: UpdateStatus, ownConsoleVersion: string | null): boolean {
  const rec = upd.components?.console?.recommendedVersion;
  if (rec === undefined || ownConsoleVersion === null) return false;
  return semverNewer(rec, ownConsoleVersion);
}

// releaseComponentsToApply is the component set the ONE "Update now" (and Preview) addresses: every
// component of the release that is verifiably newer than what runs. Engine membership uses the same version
// compare the engine row shows (the engine still enforces its own guards server-side); console membership
// is consoleUpdateAvailable. Empty when the engine sent no map (legacy: the caller then OMITS the
// components field entirely) and when nothing needs updating.
export function releaseComponentsToApply(upd: UpdateStatus, ownConsoleVersion: string | null): UpdateComponentId[] {
  const comps = upd.components;
  if (!comps) return [];
  const out: UpdateComponentId[] = [];
  const engineRec = comps.engine?.recommendedVersion;
  if (engineRec !== undefined && semverNewer(engineRec, upd.currentVersion)) out.push("engine");
  if (consoleUpdateAvailable(upd, ownConsoleVersion)) out.push("console");
  return out;
}

// componentApplyResultLine is the plain-words line for one componentResults entry (a per-component plan row
// on a preview, or a per-component outcome on a live apply). Unknown outcomes render as honest text rather
// than being dropped. Pure + DOM-free so the validator pins the copy per outcome.
export function componentApplyResultLine(r: ComponentApplyResult): string {
  const label = componentLabel(r.component);
  const to = r.toVersion ?? r.recommendedVersion;
  switch (r.outcome) {
    case "no-update":
      return `${label}: already up to date, nothing to deploy.`;
    case "dry-run":
      if (to === undefined) return `${label}: verified.`;
      return r.fromVersion
        ? `${label}: verified. A live update would deploy ${to} and keep ${r.fromVersion} as the rollback target.`
        : `${label}: verified. A live update would deploy ${to}.`;
    case "refused":
      return r.reason ? `${label}: not applied, ${r.reason}.` : `${label}: not applied; this component is unchanged.`;
    case "promoted":
      return to ? `${label}: deployed ${to}.` : `${label}: deployed.`;
    case "applied":
      return to ? `${label}: ${to} is live.` : `${label}: applied.`;
    default:
      return r.reason ? `${label}: ${r.outcome} (${r.reason}).` : `${label}: ${r.outcome}.`;
  }
}

// consoleWasApplied decides whether a live apply actually LANDED the console component, which is what
// triggers the post-apply build check (and its reload prompt / rollback affordance). Evidence-driven, never
// assumed: the console must have been REQUESTED, and either result's componentResults must report the
// console component promoted/applied, or (a console-only apply, where the top-level PromoteResult describes
// the single requested component) the top level must carry one of the console's OWN terminal-success
// outcomes. A legacy apply (requested null) is engine only by definition, so it is always false. Pure.
//
// The console-only branch used to check `promote.outcome === "promoted"`, which a console-only apply's
// response never carries: a console component is atomic and self-verifying in one request, so the engine
// answers with ITS OWN outcome vocabulary ("applied"/"applied-unconfirmed"/"rolled-back"/"rollback-failed"),
// never "promoted" (that string is specific to the two-phase ENGINE flow this function's sibling,
// runLiveApplyFlow, settles separately). The old check was unreachable in practice: a console-only "applied"
// was caught by runLiveApplyFlow's own "unexpected outcome" branch before this function was ever called with
// it, so the mistake here was masked by the other one rather than causing a second, visibly different bug.
export function consoleWasApplied(promote: PromoteResult, settle: SettleResult | null, requested: UpdateComponentId[] | null): boolean {
  if (requested === null || !requested.includes("console")) return false;
  const landed = (rs?: ComponentApplyResult[]): boolean =>
    Array.isArray(rs) && rs.some((r) => r.component === "console" && (r.outcome === "promoted" || r.outcome === "applied"));
  if (landed(promote.componentResults) || (settle !== null && landed(settle.componentResults))) return true;
  return requested.length === 1 && requested[0] === "console" && (promote.outcome === "applied" || promote.outcome === "applied-unconfirmed");
}

// consoleOnlyApplyOutcome maps a console-only apply's own already-terminal PromoteResult (the console's
// ConsoleApplyResult, returned verbatim as the top-level body -- see PromoteResult's own outcome union) to
// the SAME RecordedSettleOutcome shape recordedSettleOutcome derives from a re-read record's `lastConsole`,
// so the live flow's immediate response and a later re-read after a reload can never render two different
// sentences for the one outcome. A console component is atomic and self-verifying in one request (upload,
// promote, confirm-live all in applyConsoleComponent), so this IS the final word, never a signal to settle.
// Only ever called from runLiveApplyFlow's own !includesEngine branch, after refused/no-update/dry-run have
// already been handled by the caller; any other value reaching it is mapped to "unknown" defensively, never
// asserted as a console success. Pure + DOM-free for the validator.
export function consoleOnlyApplyOutcome(promote: PromoteResult): RecordedSettleOutcome {
  switch (promote.outcome) {
    case "applied":
      return { kind: "applied", toVersion: promote.toVersion ?? null, confirmationPending: false };
    case "applied-unconfirmed":
      return { kind: "applied-unconfirmed", toVersion: promote.toVersion ?? null, reason: promote.reason ?? null };
    case "rolled-back":
      return { kind: "rolled-back", fromVersion: promote.fromVersion ?? null, toVersion: promote.toVersion ?? null, reason: promote.reason ?? null };
    // onVersion/target mirror recordedSettleOutcome's own rollback-failed convention: the console's fromVersion
    // is the recorded-good PRIOR (the rollback target), so onVersion is toVersion (the build still live and
    // failing) and target is fromVersion.
    case "rollback-failed":
      return { kind: "rollback-failed", onVersion: promote.toVersion ?? null, target: promote.fromVersion ?? null, reason: promote.reason ?? null };
    default:
      return { kind: "unknown" };
  }
}

// updateExplainerText is the honest explainer at the top of the apply card. The single-engine wording is
// EXACTLY the pre-multi-component copy (the degradation rule: an old engine renders today's card
// byte-for-byte); the component-aware wording adds the engine-first ordering and the console reload step,
// with the same brick-safe and data-never-at-risk reassurances. Pure so the validator pins both.
export function updateExplainerText(componentAware: boolean): string {
  if (!componentAware) {
    return "Updating deploys a newer vendor-signed engine version into your own Cloudflare account, no command line. It is brick-safe: the new version is signature- and hash-verified before anything is deployed, then the new version is promoted live and the canary flies on the new code; the engine keeps it only if the canary sings, and rolls back to the previous version if it does not. The verification runs right here as you update, so stay on this screen until it finishes; if it is interrupted, the hourly canary keeps watching the live version and alerts you to roll back in one click if it is unhealthy. Your archives are immutable and your recovery path is out-of-band, so your data and your ability to restore are never at risk, at most a bad release is a brief availability blip you can revert.";
  }
  return "Updating deploys the newer vendor-signed release into your own Cloudflare account, no command line. A release can carry more than one component, the engine and this console, and they apply in the safe order: the engine first (signature- and hash-verified before anything is deployed, promoted live, then canary-checked and kept or rolled back), then the console (verified the same way and swapped atomically; this page then confirms it is serving the new console and prompts a reload). Stay on this screen until it finishes; if it is interrupted, the hourly canary keeps watching the live engine and alerts you to roll back in one click if it is unhealthy, and the console can be rolled back from here too. Your archives are immutable and your recovery path is out-of-band, so your data and your ability to restore are never at risk, at most a bad release is a brief availability blip you can revert.";
}

// consoleCheckingLine / consoleReloadPromptLine / consoleCheckFailedLine are the post-apply build check's
// three copy states (multi-component P5): checking, confirmed (the reload prompt), and not-confirmed (the
// honest failure + the rollback offer). Pure so the validator pins each.
export function consoleCheckingLine(expected: string): string {
  return `Checking this console now serves the new version (${expected})…`;
}

export function consoleReloadPromptLine(expected: string): string {
  return `Console updated to ${expected}. Reloading this page to switch over -- or reload now. Nothing else is pending.`;
}

export function consoleCheckFailedLine(expected: string): string {
  return `This console is not yet serving version ${expected}: the new assets may still be propagating, or the console update did not land. You can roll the console back to its previous version in one click (using the deploy token this update flow is still holding in memory, it was never stored), or wait and reload to check again. Your data and recovery are unaffected either way, this only concerns the console code.`;
}

// consoleRollbackOutcomeLine is the plain-words result of a CONSOLE component rollback (the post-apply
// check's affordance and the advanced per-component control). It mirrors standaloneRollbackOutcomeLine but
// speaks about the console (no canary language, a reload note instead). Pure for the validator.
export function consoleRollbackOutcomeLine(r: StandaloneRollbackResult): string {
  switch (r.outcome) {
    case "reverted":
      return `Console rolled back to ${r.toVersion}. Reload this page to make sure you are on the served version; your data and recovery were never affected.`;
    case "reverted-unverified":
      return r.reason
        ? `Console rolled back to ${r.toVersion}, though the engine could not confirm it (${r.reason}). Reload this page to check; your data and recovery were never affected.`
        : `Console rolled back to ${r.toVersion}, though the engine could not confirm it. Reload this page to check; your data and recovery were never affected.`;
    case "already":
      return `The console is already serving ${r.toVersion}; nothing was changed.`;
    case "no-target":
      return "There is no recorded prior console version to roll back to, so nothing was changed. A rollback target is recorded the first time a console update is applied from here.";
    case "failed":
      return r.reason
        ? `The console rollback could not be completed: ${r.reason}. Nothing was half-applied; your data and recovery are unaffected.`
        : "The console rollback could not be completed; nothing was half-applied. Your data and recovery are unaffected.";
    default:
      return "The console rollback finished; nothing was changed.";
  }
}

// ---------------------------------------------------------------------------
// Shared step-checklist renderer
// ---------------------------------------------------------------------------

// renderUpdateSteps renders an engine StepLog as an accessible checklist: one row per step, a pass/fail
// shape + label (status by shape + text, never colour alone) and the optional plain-English detail. It is
// the SHARED renderer for the dry-run plan, the live apply progress and the settle progress, so the verify
// -> upload -> promote -> canary -> decision/rollback progression reads identically in every phase. Every
// string is set as text (h() is textContent-first), so an engine-supplied detail can never inject markup.
export function renderUpdateSteps(steps: UpdateStep[]): HTMLElement {
  const list = h("ul", { class: "stack-sm", style: "list-style:none;padding-left:0;margin:var(--space-2) 0 0;display:flex;flex-direction:column;gap:var(--space-1)" });
  for (const s of steps) {
    list.appendChild(
      h(
        "li",
        { style: "display:flex;align-items:flex-start;gap:var(--space-2)" },
        statusWithLabel(s.ok ? "ok" : "danger", s.step),
        s.detail ? h("span", { class: "field__hint" }, `${s.detail}`) : false,
      ),
    );
  }
  return list;
}

// Detail rows + small leaf builders (detailRow / detailRowNode / provenancePlaceholder / renewalSentence)
// moved to ./detail-rows.ts (size, the 0.1.5 update-UX work tipped this file over the max-lines guardrail).
