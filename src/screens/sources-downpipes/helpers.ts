// Shared leaf helpers for the Sources + downpipes screen (IA screen 2). Pure source-type
// glyphs and labels, the freshness verdict, the scheduled-restore-test and retention reads,
// the destination clarity blocks, and the small string utilities every part of the screen
// reuses. Moved here verbatim from the screen module so the per-section render modules can
// share them without a cycle. Australian English, no em dashes, precise claims.

import { h, refuseWithReason, svgIcon } from "../../lib/dom.ts";
import { navigate } from "../../lib/nav.ts";
import { classifyFreshness, cadenceSecondsOf } from "../map.ts";
import { badge, type StatusTone } from "../../components/status.ts";
import { relativeTime, cadenceLabel, groupNumber, titleCase } from "../../lib/format.ts";
import { refusalText } from "../../components/error-view.ts";
import { ICON_INFO, ICON_ALERT, ICON_CHECK } from "../../lib/icons.ts";
import { DAYS_PER_MONTH } from "../../lib/cost-model.ts";
import {
  RETENTION_MAX_KEEP_RUNS,
  RETENTION_MAX_KEEP_DAYS,
  type DownpipeState,
  type RetentionPolicy,
  type RunHistoryEntry,
  type SourceSpec,
  type StatusReport,
} from "../../api.ts";

// ---- screen-local trusted SVG icons (the source-type + destination glyphs the
// shared icon set does not carry). Each is an in-repo constant, never server data,
// so svgIcon's innerHTML over it is safe (dom.ts) ------------------------------
export const ICON_KV = '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>';
export const ICON_R2 = '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>';
export const ICON_D1 = '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>';
export const ICON_SECRETS = '<circle cx="8" cy="8" r="4"/><path d="m11 11 8 8"/><path d="m16 16 3-3"/>';
// cf-config (Cloudflare configuration), a gear, distinct from the data-store glyphs.
export const ICON_CFCONFIG = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>';
// workers (Cloudflare Workers scripts), angle brackets (code), distinct from the gear and the stores.
export const ICON_WORKERS = '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>';
// stream (Cloudflare Stream video), a play triangle in a frame, distinct from the stores and code.
export const ICON_STREAM = '<rect x="2" y="5" width="20" height="14" rx="2"/><polygon points="10 9 15 13 10 17"/>';
// images (Cloudflare Images), a picture frame with a sun + peak, distinct from the video frame.
export const ICON_IMAGES = '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="1.6"/><path d="m21 15-5-5L5 21"/>';
// artifacts (Cloudflare Artifact Registry), a package/box glyph, distinct from the stores and media.
export const ICON_ARTIFACTS = '<path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>';

// WORKERS_RESTORE_NOTE is the honest, calm explanation shown behind the Workers source's info-tip
// (and reused in the wizard pick): WHAT it captures and that restore is reprovision, never a blind
// in-console write. It mirrors the engine's reprovision restore tier so the copy cannot overclaim.
export const WORKERS_RESTORE_NOTE =
  "Backs up your Worker code, its bindings metadata (which KV / R2 / D1 / queues / Durable Objects each script binds) and a version inventory, read with your read-only discovery token. Secret bindings are captured by NAME only as a reprovision checklist, never their values. Restore is reprovision and out-of-band: you re-deploy the script (and re-set any secrets) using the captured inventory; it is not a one-click in-console write.";

// STREAM_RESTORE_NOTE is the honest explanation behind the Stream source's info-tip. It captures the
// video INVENTORY + metadata always, and the video bytes + captions when file-content capture is enabled,
// and is reprovision on restore, mirroring the engine's reprovision tier so the copy cannot overclaim.
export const STREAM_RESTORE_NOTE =
  "Backs up your Cloudflare Stream video inventory and metadata (titles, durations, playback ids, signed-URL and allowed-origin settings, your custom meta), read with your read-only discovery token. Enable file-content capture to also back up the video files (size-gated) and caption tracks; left off, only the inventory is captured. Restore is reprovision and out-of-band: you re-upload from the captured inventory and files; it is not a one-click in-console write.";

// IMAGES_RESTORE_NOTE is the honest explanation behind the Images source's info-tip. It captures the
// image INVENTORY + metadata + variant config always, and the image bytes when file-content capture is
// enabled, and is reprovision on restore.
export const IMAGES_RESTORE_NOTE =
  "Backs up your Cloudflare Images inventory and metadata (filenames, variants, signed-URL settings, your custom meta) plus the account variant definitions, read with your read-only discovery token. Enable file-content capture to also back up the image files (size-gated); left off, only the inventory is captured. Restore is reprovision and out-of-band: you re-upload from the captured inventory and files; it is not a one-click in-console write.";
// ARTIFACTS_RESTORE_NOTE is the honest explanation behind the Artifact Registry source's info-tip. It
// captures the namespace/repo INVENTORY always, and the repo contents when file-content capture is
// enabled, and is reprovision on restore.
export const ARTIFACTS_RESTORE_NOTE =
  "Backs up your Cloudflare Artifact Registry inventory: the namespaces and repositories with their metadata, read with your read-only discovery token. Enable file-content capture to also back up the repository contents (the commit log, HEAD commit and reachable file blobs, size-gated); left off, only the inventory is captured. Restore is reprovision and out-of-band: you re-create the namespaces and repositories and re-push from the captured inventory and files; it is not a one-click in-console write.";

export type SourceType = SourceSpec["type"];

// The bill-shock threshold: a monthly KV-read count above which the projection
// flips to the warn steer. Tuned to genuine bill risk (a high-frequency full
// re-read of a large namespace), not routine cadence (flow.md E adversarial note:
// firing on routine cadences trains click-through, which is worse than no guard).
export const BILL_SHOCK_THRESHOLD = 300_000_000;

// The per-run ceiling: the monthly threshold divided by the days in an average month, so a
// single run's projected read count can be compared to a per-day budget. The month is the
// cost library's DAYS_PER_MONTH (30.44). This file used to declare and export its own
// DAYS_PER_MONTH = 30, a second constant of the same name and a different value inside the
// screen whose cost line reads the library's figure, so the screen held two months at once.
export const BILL_SHOCK_PER_RUN_THRESHOLD = BILL_SHOCK_THRESHOLD / DAYS_PER_MONTH;

// The cadence presets (flow.md E). Daily is the recommended default and matches
// the engine default; each maps to a cadenceSeconds value.
export const CADENCE_PRESETS: Array<{ seconds: number; title: string; sub: string }> = [
  { seconds: 3600, title: "Hourly", sub: "24/day" },
  { seconds: 21600, title: "Every 6h", sub: "4/day" },
  { seconds: 86400, title: "Daily", sub: "recommended" },
  { seconds: 604800, title: "Weekly", sub: "1/week" },
];

// sourceIcon returns the in-repo glyph for a source type.
export function sourceIcon(type: SourceType): string {
  return type === "kv" ? ICON_KV : type === "r2" ? ICON_R2 : type === "d1" ? ICON_D1 : type === "cf-config" ? ICON_CFCONFIG : type === "workers" ? ICON_WORKERS : type === "stream" ? ICON_STREAM : type === "images" ? ICON_IMAGES : type === "artifacts" ? ICON_ARTIFACTS : ICON_SECRETS;
}

// sourcePill renders the hue-coded source-type pill (KV / R2 / Secrets / D1 / Config / Workers / Stream / Images / Artifacts). The
// type word is always present (status by shape + label, not colour alone).
export function sourcePill(type: SourceType): HTMLElement {
  const label = type === "kv" ? "KV" : type === "r2" ? "R2" : type === "d1" ? "D1" : type === "cf-config" ? "Config" : type === "workers" ? "Workers" : type === "stream" ? "Stream" : type === "images" ? "Images" : type === "artifacts" ? "Artifacts" : "Secrets";
  return h("span", { class: `source-pill source-pill--${type}` }, svgIcon(sourceIcon(type), { size: 13 }), label);
}

// The freshness verdict for a downpipe: the run-status the table and drawer show,
// derived from the engine's in-flight flag plus the run history vs cadence. This never
// invents a green; an unknown/paused state reads honestly.
export type Freshness = { tone: StatusTone; label: string; reason?: string; stale: boolean };

// The per-downpipe run facts the freshness read needs: the newest run of any status (the
// display cue) PLUS the newest GOOD run (the staleness axis). The latest entry alone is
// not enough: staleness is measured from the last successful run, so a run hanging
// in flight over an old good run must still read stale (the shared rule).
export interface RunFacts {
  latest: RunHistoryEntry | undefined;
  lastGood: RunHistoryEntry | undefined;
}

export function freshnessFor(state: DownpipeState, facts: RunFacts | undefined, now: number = Date.now()): Freshness {
  const latest = facts?.latest;
  const lastGood = facts?.lastGood;

  // The STALENESS axis delegates to the shared classifyFreshness rule (map.ts), the same
  // rule the Overview banner counts with, so the /downpipes?status=stale deep link can
  // never land on a list whose stale facet disagrees with the count that sent the
  // operator here. In particular: an in-flight run does NOT reset staleness.
  const core = classifyFreshness({
    enabled: state.config.enabled,
    hasConfig: true,
    haveHistory: facts !== undefined,
    haveDownpipes: true,
    latestStatus: latest ? latest.status : "none",
    lastGoodAt: lastGood ? lastGood.startedAt : null,
    // The cadence goes through the ONE seam that records a cadence this build cannot read (map.ts
    // cadenceSecondsOf), never a local Number.isFinite coercion. A silently nulled cadence disables the whole
    // staleness test, and this table is where the customer looks to see that it did not.
    cadenceSeconds: cadenceSecondsOf(state.config),
    now,
  });
  const stale = core === "stale";
  const staleReason = stale && lastGood
    ? `Last good backup ${relativeTime(lastGood.startedAt)}, expected ${cadenceLabel(state.config.cadenceSeconds)}`
    : undefined;

  // The DISPLAY state. A run in progress reads "Running" (a cue, not a freshness claim);
  // the stale flag above still carries the shared staleness verdict for the facet.
  if (state.inFlight || latest?.status === "in-flight") {
    return { tone: "info", label: "Running", stale, ...(staleReason ? { reason: staleReason } : {}) };
  }
  if (!state.config.enabled) return { tone: "neutral", label: "Paused", stale: false };
  if (!latest) return { tone: "neutral", label: "Idle", stale: false };
  if (latest.status === "failed") {
    return { tone: "danger", label: "Failed", stale, ...(latest.error ? { reason: latest.error } : {}) };
  }
  if (stale) {
    return { tone: "warn", label: "Stale", stale: true, ...(staleReason ? { reason: staleReason } : {}) };
  }
  // G298: THE SHARED RULE REFUSED TO DATE THIS DOWNPIPE, and this table used to answer "Ok" anyway. classifyFreshness
  // returns "unknown" when it was handed run data this build cannot read (a lastGoodAt that will not parse, a run
  // status it does not know) or a history it could not read at all, and it returns it precisely so that NO GREEN
  // CLAIM is made on a backup nobody can date. The map honoured that and rendered "unknown"; freshnessFor read only
  // `core === "stale"` and fell through to a green "Ok", so the same downpipe read green in the list the customer
  // actually looks at while the map said nobody could date it. A run row exists (an Idle pipe has already returned
  // above), so this is not the never-run state: it is a run whose freshness cannot be judged.
  if (core === "unknown") {
    return { tone: "neutral", label: "Unknown", stale: false, reason: "This console build could not read the engine's run data for this downpipe, so its freshness cannot be judged." };
  }
  return { tone: "ok", label: "Ok", stale: false };
}

// ---- scheduled restore tests (build contract section 5) ----------------------
// The downpipe config carries restoreTestCadenceSeconds (0 / absent = off), and the
// state carries lastRestoreTestAt / lastRestoreTestOk recency. These pure helpers turn
// that into the honest cadence phrase and the recency read the drawer surfaces, and the
// posture/reports surfaces echo. They never invent a pass: an absent last-test reads as
// "never tested", a failed last-test reads danger, and an old pass past 1.5x the cadence
// reads as overdue (warn), so the recency is honest, never a stale green. Exported for
// the validator (the load-bearing tone/recency logic).

// RestoreTestRecency is the drawer/posture read of the last scheduled restore test: a
// tone, a short label, a longer detail line, and the closed KIND the restore screen groups by
// (tone alone cannot name the state precisely: a deferral and an overdue pass are both "warn").
// "attended-full" / "attended-partial" are the METHOD-FAITHFUL reads of an ATTENDED verification
// pass (the offline-key-only in-platform proof): a full (100% sample) attended pass reads as an
// attended proof (ok), a sub-100 sample reads amber (partial proof) and is NEVER the fully-green
// "recently tested", since only a subset of records was decrypted-and-verified.
export type RestoreTestRecencyKind = "failed" | "failed-unattributed" | "deferred-no-run" | "deferred-posture" | "never" | "off" | "overdue" | "ok" | "attended-full" | "attended-partial";
export interface RestoreTestRecency { tone: StatusTone; label: string; detail: string; kind: RestoreTestRecencyKind }

// clampSampleRate normalises a recorded attended sample rate to the engine's 1..100 integer domain, so a
// stray wire value cannot render an out-of-range percentage. Absent stays absent (the caller then reads the
// sample as unknown and refuses the fully-green pass, never assuming 100%).
function clampSampleRate(rate: number | undefined): number | undefined {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return undefined;
  return Math.max(1, Math.min(100, Math.trunc(rate)));
}

// restoreTestReasonPhrase turns the engine's CLOSED coarse failure code (lastRestoreTestReason)
// into the plain-words cause the recency detail names. Every member of the engine's
// RESTORE_TEST_REASON_CODES has a case here; validate-restore-reason-vocabulary.ts reads that
// list out of the engine and fails if this switch is missing one, so the parity is checked
// rather than asserted. An unknown code still reads as a generic phrase (defence in depth,
// never the raw code). Exported for the validator.
//
// format-unsupported deliberately does NOT accuse the archive. It is the one code here that
// means the bytes are fine: the engine read the format version, found it is not one this build
// implements, and stopped before checking anything. Telling a customer their backup failed a
// check, when a different build reads it unchanged, points them at a corruption that does not
// exist -- the exact conflation the engine's own format-unsupported reason was added to end.
export function restoreTestReasonPhrase(code: string | undefined): string {
  switch (code) {
    case "integrity": return "the archive failed its integrity verification (possible corruption or tampering)";
    case "freshness": return "the anti-rollback freshness check failed (the archive read is stale or rolled back)";
    case "format-unsupported": return "this engine build does not implement the archive's format version (the archived bytes are intact and a build that implements that version reads them unchanged)";
    case "object-missing": return "an archive object was missing from the destination";
    case "dest-access": return "the destination refused or failed the read (a credential or availability fault)";
    case "origin-removed": return "the run's only copy is on a destination that is no longer configured";
    case "not-configured": return "the engine is not fully configured for a read-back";
    case "recovery-check": return "the recovery check failed";
    case "other": return "the recovery check failed for a reason the engine did not classify";
    default: return "the recovery check failed";
  }
}

// restoreTestCadenceLabel turns the cadence seconds into a friendly phrase. 0 / absent is
// "Off (no scheduled test)"; otherwise it reuses cadenceLabel for the interval.
export function restoreTestCadenceLabel(cadenceSeconds: number | undefined): string {
  if (cadenceSeconds === undefined || cadenceSeconds <= 0) return "Off (no scheduled test)";
  return titleCase(cadenceLabel(cadenceSeconds));
}

// restoreTestRecency computes the recency read from the state. The order is: a failed
// last test is the loudest (danger) regardless of age; then never-tested when the cadence
// is on (warn, a scheduled test is configured but has not run); then never-tested when
// off (neutral, nothing is expected); then a pass, which is ok unless it is older than
// 1.5x the cadence, in which case it is overdue (warn). `nowMs` is injectable for the test.
export function restoreTestRecency(
  state: { config: { restoreTestCadenceSeconds?: number }; lastRestoreTestAt?: string; lastRestoreTestOk?: boolean; lastRestoreTestReason?: string; restoreTestConsecutiveFailures?: number; lastRestoreTestDeferred?: "no-run" | "posture"; lastRestoreTestKind?: "scheduled" | "attended"; lastRestoreTestSampleRate?: number },
  nowMs: number = Date.now(),
): RestoreTestRecency {
  const cadence = state.config.restoreTestCadenceSeconds;
  const on = cadence !== undefined && cadence > 0;
  const lastAt = state.lastRestoreTestAt;

  // A recorded not-passed completion. The engine distinguishes three cases and so must this read
  // (they used to collapse into one loud "Last test failed", so a freshly created or just-edited
  // downpipe with nothing to drill yet read as a recoverability failure, the owner-reported false
  // alarm): a DEFERRAL (could not test: no completed backup yet, or a break-glass-only posture), a
  // real FAILURE (the drill ran and the archive failed it; the persisted coarse cause is named), and
  // a legacy not-passed with no recorded cause (recorded before deferral tracking).
  if (lastAt !== undefined && state.lastRestoreTestOk === false) {
    if (state.lastRestoreTestDeferred === "no-run") {
      return { tone: "warn", label: "Not yet testable", kind: "deferred-no-run", detail: `The last scheduled restore test (${relativeTime(lastAt)}) could not run: this downpipe had no completed backup at the time. A test runs automatically after the next successful backup.` };
    }
    if (state.lastRestoreTestDeferred === "posture") {
      return { tone: "neutral", label: "Attended verification available", kind: "deferred-posture", detail: `The engine cannot self-test in a break-glass-only key posture; it holds no operational read-back key (last scheduled attempt ${relativeTime(lastAt)}). Prove recoverability here with attended verification: supply your break-glass key in your browser and the engine verifies a sample against the keys you recover.` };
    }
    const streak = state.restoreTestConsecutiveFailures;
    if (state.lastRestoreTestReason !== undefined) {
      const streakLine = streak !== undefined && streak >= 2 ? ` ${streak} consecutive tests have failed.` : "";
      return { tone: "danger", label: "Last test failed", kind: "failed", detail: `The last scheduled restore test failed ${relativeTime(lastAt)}: ${restoreTestReasonPhrase(state.lastRestoreTestReason)}.${streakLine} This is a real recoverability problem; investigate before relying on this downpipe.` };
    }
    // No recorded cause and no deferral mark: on an OLDER engine this is a real failure (it never
    // sends a cause), so it stays the loudest read rather than being softened; on a current engine
    // it is a legacy row from before deferral tracking, and the next successful backup retests it.
    return { tone: "danger", label: "Last test failed", kind: "failed-unattributed", detail: `The last scheduled restore test did not pass (${relativeTime(lastAt)}) and recorded no cause. If this downpipe had no completed backup at the time, the engine recorded a could-not-test deferral this way. A test runs automatically after the next successful backup; investigate if it fails again.` };
  }

  // No test has ever run.
  if (lastAt === undefined) {
    if (on) return { tone: "warn", label: "Never tested", kind: "never", detail: `A scheduled restore test is configured (${restoreTestCadenceLabel(cadence)}) and the first test runs automatically after the first successful backup, so recoverability is not yet evidenced.` };
    return { tone: "neutral", label: "Not tested", kind: "off", detail: "No scheduled restore test is configured for this downpipe, so recoverability has not been proven by a drill." };
  }

  // A passing ATTENDED verification is read on its METHOD and sample, not a scheduled cadence: the
  // offline-key-only posture has no in-account read-back key to run a scheduled drill, so the operator
  // drove an attended verification (supplying the per-run masters through their browser). This is the
  // method-faithful compliance branch, taken BEFORE the scheduled overdue/ok read: a sub-100 (or
  // unrecorded) sample proved only a SUBSET restorable, so it reads amber and is NEVER the fully-green
  // "recently tested"; a full 100% sample reads as a genuine attended proof.
  if (state.lastRestoreTestKind === "attended") {
    const rate = clampSampleRate(state.lastRestoreTestSampleRate);
    if (rate === undefined || rate < 100) {
      const sampleLabel = rate === undefined ? "partial sample" : `${rate}% sample`;
      const samplePhrase = rate === undefined ? "an unrecorded record sample" : `a ${rate}% record sample`;
      return {
        tone: "warn",
        label: `Attended, ${sampleLabel}`,
        kind: "attended-partial",
        detail: `The last proof was an attended verification ${relativeTime(lastAt)} at ${samplePhrase}, so only a subset of records was decrypted and verified. Recoverability is partially evidenced, not fully proven; run a 100% attended verification to record a full proof.`,
      };
    }
    return {
      tone: "ok",
      label: "Attended verification",
      kind: "attended-full",
      detail: `The last proof was a full (100% sample) attended verification ${relativeTime(lastAt)}: every record was decrypted and verified with your break-glass key supplied in your browser.`,
    };
  }

  // A passing SCHEDULED test: ok unless it is stale against the cadence.
  const lastMs = Date.parse(lastAt);
  if (on && Number.isFinite(lastMs)) {
    const ageSec = (nowMs - lastMs) / 1000;
    if (ageSec > cadence! * 1.5) {
      return { tone: "warn", label: "Test overdue", kind: "overdue", detail: `The last restore test passed ${relativeTime(lastAt)}, but that is older than the ${restoreTestCadenceLabel(cadence)} cadence. A fresh test is due.` };
    }
  }
  return { tone: "ok", label: "Recently tested", kind: "ok", detail: `The last scheduled restore test passed ${relativeTime(lastAt)}.` };
}

// ---- retention policy (ASVS V14.2.7) -----------------------------------------
// The downpipe config carries an optional retention policy { keepRuns?, keepDays?, enforce? } that the
// engine prunes by (engine/src/sched/scheduler-do.ts). These pure helpers VALIDATE a console-built
// policy (mirroring the engine's validateConfig so a bad value is rejected inline before a 400) and turn
// a stored policy into the honest PLAIN-WORDS summary the drawer shows. They never overstate: a
// report-only policy says "report-only" and an enforced one says deletion is enforced, since enforce is
// the real deletion gate. Exported for the validator (the load-bearing round-trip + copy logic).

// validateRetention checks a console-built retention policy against the engine's bounds and returns an
// error message, or null when valid (or when the policy is undefined, which is the keep-everything
// default the engine accepts). The rules mirror engine/src/sched/scheduler-do.ts validateConfig EXACTLY:
// at least one of keepRuns/keepDays must be set; each, when set, must be an integer within its backstop
// (keepRuns 1..RETENTION_MAX_KEEP_RUNS, keepDays 1..RETENTION_MAX_KEEP_DAYS); enforce is a boolean. The
// console rejects the same shapes the engine would, so the operator gets an inline reason, not a late 400.
export function validateRetention(r: RetentionPolicy | undefined): string | null {
  if (r === undefined) return null;
  if (r.keepRuns === undefined && r.keepDays === undefined) {
    return "Set a run count, a day count, or both. Retention needs at least one limit.";
  }
  if (r.keepRuns !== undefined && (!Number.isInteger(r.keepRuns) || r.keepRuns < 1 || r.keepRuns > RETENTION_MAX_KEEP_RUNS)) {
    return `Runs to keep must be a whole number from 1 to ${groupNumber(RETENTION_MAX_KEEP_RUNS)}.`;
  }
  if (r.keepDays !== undefined && (!Number.isInteger(r.keepDays) || r.keepDays < 1 || r.keepDays > RETENTION_MAX_KEEP_DAYS)) {
    return `Days to keep must be a whole number from 1 to ${groupNumber(RETENTION_MAX_KEEP_DAYS)}.`;
  }
  if (r.enforce !== undefined && typeof r.enforce !== "boolean") {
    return "Enforce deletion must be on or off.";
  }
  return null;
}

// retentionSummary turns a stored policy into the plain-words sentence the drawer shows. ABSENT reads
// "keeps every run (no automatic deletion)"; a present policy describes the window ("the 10 most recent
// runs", "runs from the last 30 days", or both joined by "or") and then the gate state HONESTLY: when
// enforce is true it says deletion is ENFORCED (the engine deletes superseded runs and their
// unreferenced segments on the schedule); otherwise it says REPORT-ONLY (the engine logs the plan but
// deletes nothing). enforce being the literal true is the only thing that reads as enforced, matching the
// engine's gate. Pure; returns a string the caller renders as a text node.
export function retentionSummary(r: RetentionPolicy | undefined): string {
  if (r === undefined || (r.keepRuns === undefined && r.keepDays === undefined)) {
    return "Keeps every run; no automatic deletion.";
  }
  const parts: string[] = [];
  if (r.keepRuns !== undefined) parts.push(`the ${groupNumber(r.keepRuns)} most recent ${r.keepRuns === 1 ? "run" : "runs"}`);
  if (r.keepDays !== undefined) parts.push(`runs from the last ${groupNumber(r.keepDays)} ${r.keepDays === 1 ? "day" : "days"}`);
  const window = parts.join(" or ");
  const gate = r.enforce === true
    ? "deletion enforced (superseded runs and their unreferenced segments are deleted on the schedule)"
    : "report-only (the engine logs the prune plan but deletes nothing)";
  return `Keeps ${window}; ${gate}.`;
}

// destinationClarity builds the destination block for the create/import forms
// (flow.md D step 5): informational presence + residency, never a credential form.
// It reads the REAL destKind from status; an S3 destination shows an out-of-region
// warning; a null destKind explains "set DEST_KIND" rather than "no destination";
// a null STATUS (the read failed) is an honest unknown, never "not yet selected".
export function destinationClarity(status: StatusReport | null): HTMLElement {
  if (status === null) return unknownDestBlock();
  const destKind = status.destKind ?? null;
  if (destKind === null) return notSetDestBlock();
  // EVERY non-R2 kind takes the out-of-account block. Written as "not R2" rather than as a list of the
  // out-of-account kinds because the fall-through here was the dangerous direction: while this read
  // `destKind === "s3"`, a Google Cloud destination fell past it to r2DestBlock() and the create form told
  // the operator their archive was in-account R2, which is a residency claim about somebody else's cloud.
  // The union has grown twice now and this ternary chain cannot make the compiler say so, so the residual
  // is the one that is safe to be wrong about.
  if (destKind !== "r2") return outOfAccountDestBlock(destKind);
  return r2DestBlock();
}

// The route to the surface that actually sets it (Destinations now sets it from
// the console; "set in the engine" was the pre-Destinations phrasing).
function manageLink(): HTMLElement {
  return h("button", { "data-dp": "sources-downpipes.button.navigate-destinations#3", class: "linklike", type: "button", on: { click: () => navigate("/destinations") } }, "Manage in Destinations");
}

// The status read failed: the destination state is unknown, which must not present
// as "not yet selected" (the same honest-unknown copy the detail drawer uses).
function unknownDestBlock(): HTMLElement {
  const block = h("div", { class: "dest-block" });
  block.appendChild(
    h(
      "div",
      { class: "dest-block__opt" },
      h("span", { class: "dest-block__ic" }, svgIcon(ICON_INFO, { size: 18 })),
      h(
        "div",
        h("div", { class: "dest-block__title" }, "Destination unknown"),
        h("div", { class: "dest-block__desc" }, "Could not reach the engine to read it. ", manageLink(), ". The console shows presence only, never a credential."),
      ),
    ),
  );
  return block;
}

// OUT_OF_ACCOUNT_DEST_NAME names the store in the block's title. The generic "S3 destination" was right
// while S3-compatible was the only out-of-account kind and is not right for a store the console can now
// name; "an S3 destination" over an Azure Blob container names the wrong protocol as well as the wrong
// company, because Azure is not reached over the S3 API at all.
// The article is carried with the name rather than derived, because "an S3" and "a Google" do not follow
// from the first letter: S is a vowel sound when the letter is read out and a consonant sound when the
// word is.
const OUT_OF_ACCOUNT_DEST_NAME: Readonly<Record<"s3" | "gcs" | "azure", { name: string; article: string }>> = {
  s3: { name: "S3 destination", article: "An" },
  gcs: { name: "Google Cloud Storage destination", article: "A" },
  azure: { name: "Azure Blob Storage destination", article: "An" },
};

function outOfAccountDestBlock(kind: "s3" | "gcs" | "azure"): HTMLElement {
  const block = h("div", { class: "dest-block dest-block--warn" });
  block.appendChild(
    h(
      "div",
      { class: "dest-block__opt" },
      h("span", { class: "dest-block__ic" }, svgIcon(ICON_R2, { size: 18 })),
      h(
        "div",
        h("div", { class: "dest-block__title" }, OUT_OF_ACCOUNT_DEST_NAME[kind].name, badge("warn", "Out of account")),
        h("div", { class: "dest-block__desc" }, manageLink(), ". The console shows presence only, never a credential."),
      ),
    ),
  );
  block.appendChild(
    h(
      "div",
      { class: "dest-block__note" },
      svgIcon(ICON_ALERT, { size: 14 }),
      `${OUT_OF_ACCOUNT_DEST_NAME[kind].article} ${OUT_OF_ACCOUNT_DEST_NAME[kind].name} can move data out of your Cloudflare account or region. Confirm this is intended.`,
    ),
  );
  return block;
}

function notSetDestBlock(): HTMLElement {
  const block = h("div", { class: "dest-block" });
  block.appendChild(
    h(
      "div",
      { class: "dest-block__opt" },
      h("span", { class: "dest-block__ic" }, svgIcon(ICON_INFO, { size: 18 })),
      h(
        "div",
        h("div", { class: "dest-block__title" }, "Destination not yet set"),
        h(
          "div",
          { class: "dest-block__desc" },
          "Backups have nowhere to land yet, so the first run would fail. ",
          h("button", { "data-dp": "sources-downpipes.button.navigate-destinations#4", class: "linklike", type: "button", on: { click: () => navigate("/destinations") } }, "Set the destination"),
          " (no terminal needed). Creating a downpipe does not itself set it.",
        ),
      ),
    ),
  );
  return block;
}

// The preferred in-account R2 destination.
function r2DestBlock(): HTMLElement {
  const block = h("div", { class: "dest-block" });
  block.appendChild(
    h(
      "div",
      { class: "dest-block__opt" },
      h("span", { class: "dest-block__ic" }, svgIcon(ICON_R2, { size: 18 })),
      h(
        "div",
        h("div", { class: "dest-block__title" }, "In-account R2", badge("trust", "Preferred")),
        h("div", { class: "dest-block__desc" }, manageLink(), ". The console shows presence and region, never a credential."),
      ),
    ),
  );
  block.appendChild(
    h(
      "div",
      { class: "dest-block__note" },
      svgIcon(ICON_CHECK, { size: 14 }),
      "Backups stay in your Cloudflare account.",
    ),
  );
  return block;
}

// destinationSummary is the one-line destination text for the detail drawer's
// config (reads the real destKind; honest "unknown" when status is unavailable).
export function destinationSummary(status: StatusReport | null): string {
  if (!status) return "Unknown (could not reach the engine)";
  if (status.destKind === "r2") return "In-account R2";
  if (status.destKind === "s3") return "S3 (out of account)";
  // Named, for the same reason the residency block above is: while these two fell to the residual, the
  // drawer read "Not set (set it in Destinations)" over a configured, working destination.
  if (status.destKind === "gcs") return "Google Cloud Storage (out of account)";
  if (status.destKind === "azure") return "Azure Blob Storage (out of account)";
  return "Not set (set it in Destinations)";
}

// ---- small helpers ----------------------------------------------------------

// friendlyName derives the suggested human name from a generated binding
// (SRC_KV_app_db -> "app db"), shared by the wizard, the import drawer and the
// Sources screen's bulk protect (exported for it), so every create path names
// downpipes the same way and a fleet never reads as code.
export function friendlyName(binding: string): string {
  return binding.replace(/^SRC_(KV|R2|D1|SEC)_/i, "").replace(/^(KV|R2|D1)_/i, "").replace(/_/g, " ").trim() || binding;
}

// actionChip is a small secondary button with the drawer footer's disabled-with-
// reason pattern (aria-disabled + a visually-hidden reason; focusable, never a
// hover-only title), for in-body action rows like the run-strip's restore pair.
export function actionChip(label: string, disabledReason: string | null, onClick: () => void): HTMLButtonElement {
  const btn = h(
    "button",
    { "data-dp": "sources-downpipes.button.action-chip", class: "btn btn--secondary btn--sm", type: "button", ...(disabledReason !== null ? { "aria-disabled": "true" } : {}) },
    label,
  ) as HTMLButtonElement;
  // Through the SHARED primitive rather than a local copy of it: the reason becomes the chip's
  // DESCRIPTION, so the name stays "Verify restore (drill)" instead of announcing
  // "Verify restore (drill) : No run to drill yet."
  if (disabledReason !== null) refuseWithReason(btn, disabledReason);
  else btn.addEventListener("click", onClick);
  return btn;
}

// isWorkersDevHost returns true if the value looks like a workers.dev hostname or URL
// (console-sources-2). The console only ever uses custom domains; a workers.dev value
// in a binding field is nearly always a misconfigured paste, and we reject it with a
// clear message rather than passing it to the engine and getting a cryptic 400.
export function isWorkersDevHost(value: string): boolean {
  const lower = value.toLowerCase();
  // ".workers.dev" is a strict suffix of "workers.dev", so the single substring test
  // catches both forms (finding console-src-055-10).
  return lower.includes("workers.dev");
}

// sourceSub is the binding summary under the name (or "N secrets" for the Secrets
// layer, and the account-scoped scope for cf-config / workers, where there is no single binding).
export function sourceSub(source: SourceSpec): string {
  if (source.type === "secrets") {
    const n = source.secrets?.length ?? 0;
    return `${n} secret${n === 1 ? "" : "s"}`;
  }
  if (source.type === "workers") {
    return "all scripts";
  }
  return source.binding ?? "-";
}

// relForCadence is a friendly first-run estimate for the schedule preview.
export function relForCadence(seconds: number): string {
  if (seconds <= 3600) return "an hour";
  if (seconds <= 21600) return "6 hours";
  if (seconds <= 86400) return "a day";
  return "a week";
}

export function splitPrefixes(s: string): string[] {
  return s
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

// errMsg is the refusal line for every action on the Downpipes screen: run now, drill, enable and
// disable, delete, change the capture mode, rediscover, the create wizard's save and its attach, and
// the per-binding failures of a bulk import.
//
// It used to return err.message untouched, so the transport's throw WAS the sentence: a wire verb on
// the front, the status glued past the full stop, and on a 403 the console's own classifier token
// ("forbidden-class=not-engine-body: 403") shown as though it explained something. It also had no
// reading at all for a cancelled step-up ceremony, whose throw is an internal marker and a 401.
//
// refusalText is the same reviewed rule the destination form, the source token and the licence verbs
// go through (components/error-view.ts): the engine's own sentence when the throw carries one, the
// reviewed sentence for the classified kind when it does not.
//
// The toasts that WRAP this say "<what failed>. <why>" rather than "<what failed> (<why>)", because
// the no-reason branch is a whole reviewed sentence with its own advice and nesting one inside a
// parenthesis gives the customer two instructions in one line.
export function errMsg(err: unknown): string {
  return refusalText(err);
}
