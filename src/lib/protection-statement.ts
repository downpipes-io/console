// Plain-English protection statements: render a TRUE one-sentence summary of what a downpipe (and
// the fleet) actually protects, from the downpipe config + state. This is the honest "what is
// protected, and how well is it proven" read the console leads with: the lead line on the overview
// and the subtitle on the downpipes screen.
//
// HONEST BY CONSTRUCTION (the same discipline as the freshness rule and the restore-test recency):
//   - The statement states ONLY what is TRUE. It reads the real config + state fields; it never
//     fabricates a date, an outcome, or a "verified".
//   - When a thing has NEVER happened it says so plainly ("never integrity-checked", "restorability
//     never proven"), rather than implying it has (a stale green is worse than an honest "unknown").
//   - A FAILED last check is never softened into a pass: a failed integrity check reads "integrity
//     check FAILED", not "integrity-checked".
//   - The blunt "not covered" line names, in plain words, what this statement does NOT assert (it is
//     not a guarantee of recoverability beyond what was actually proven, and it covers only the
//     configured sources), so the reader is never lulled into a false sense of cover.
//
// PURE + presentation-only: every function here is a pure string builder over the typed state and a
// caller-supplied `now` (injectable for tests). No value, no key, no secret ever enters a statement;
// it carries names, a cadence, dates and an actor label only. The strings are server-supplied
// (source/destination names, the prover identity) and reach the DOM via the h() textContent path at
// the call site, so there is no markup surface here. Australian English, no em dashes.

import type { DownpipeState, SourceSpec, StatusReport } from "../api.ts";
import { readDownpipe, downpipeFaultClause, DOWNPIPE_FAULT_REMEDY } from "./downpipe-readable.ts";
import { recordWireAnomaly } from "./client-diag/ring.ts";
import type { ClientDiagFieldClass } from "./client-diag/vocab.ts";
import { cadenceLabel, dateOnly, relativeTime } from "./format.ts";

// How many cadence intervals past a recency stamp before it reads "overdue" rather than current.
// Matches the freshness / restore-test rule (1.5x the cadence) so the surfaces cannot disagree.
const OVERDUE_CADENCE_MULTIPLE = 1.5;

// Cadence intervals named explicitly in cadencePhrase, in seconds.
const SECONDS_PER_WEEK = 7 * 24 * 60 * 60;
const SECONDS_PER_FORTNIGHT = 14 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Destination descriptor.
// ---------------------------------------------------------------------------

// DestinationDescriptor is the honest name of the single archive destination, derived from the
// engine's account-wide status (status.destKind / destConfigured) the SAME way the map and overview
// derive it, so the statement never names a destination the rest of the console disagrees with.
//   - configured true + a name: name the archive (e.g. "R2 dr-archive", "an S3 archive");
//   - configured true, no name: "your archive destination" (a real configured archive, unnamed);
//   - configured false: null name + configured false ("no archive destination is configured yet");
//   - unknown (status unreadable): configured null ("the destination could not be read").
export interface DestinationDescriptor {
  // The human destination phrase, or null when none is configured / it is unknown.
  name: string | null;
  // true configured, false not configured, null unknown (status could not be read). Tri-state so the
  // statement distinguishes "no destination" from "could not read the destination", never conflating
  // an unreachable engine with a missing destination.
  configured: boolean | null;
}

// destinationFromStatus builds the DestinationDescriptor from the engine status report (or its
// honest absence). It mirrors map.ts destinationFor / overview.ts destinationForOverview so the
// three surfaces agree on the destination name. The optional bucketName lets the statement name a
// specific R2 archive when the engine reports one (e.g. "R2 dr-archive"); absent, it reads the
// generic "your in-account R2 archive".
export function destinationFromStatus(status: StatusReport | null, bucketName?: string): DestinationDescriptor {
  if (status === null) return { name: null, configured: null };
  if (status.destKind === "r2") {
    return { name: bucketName ? `R2 ${bucketName}` : "your in-account R2 archive", configured: true };
  }
  if (status.destKind === "s3") {
    return { name: bucketName ? `S3 ${bucketName}` : "an S3 archive", configured: true };
  }
  // Google Cloud Storage is reached through its S3-interop API, so it is an S3-compatible store on the
  // wire, but it is named as Google here rather than folded into "an S3 archive": this sentence tells an
  // operator where their data actually is, and "S3" would name the wrong company.
  if (status.destKind === "gcs") {
    return { name: bucketName ? `Google Cloud Storage ${bucketName}` : "a Google Cloud Storage archive", configured: true };
  }
  // Azure Blob Storage is not S3-compatible on the wire at all (the engine reaches it with its own client
  // and its own Shared Key signer), so folding it into "an S3 archive" would be wrong twice over: the wrong
  // company and the wrong protocol.
  if (status.destKind === "azure") {
    return { name: bucketName ? `Azure Blob Storage ${bucketName}` : "an Azure Blob Storage archive", configured: true };
  }
  if (status.destConfigured) return { name: "your archive destination", configured: true };
  return { name: null, configured: false };
}

// ---------------------------------------------------------------------------
// Source naming (mirrors map.ts sourceName / overview.ts sourceEndpoint so the
// three surfaces name the same source the same way).
// ---------------------------------------------------------------------------

// sourceTypeLabel is the short, upper-case type word for the parenthetical (KV / R2 / D1 / Secrets).
//
// The DEFAULT arm is not defensive padding. The switch was exhaustive over the declared union and had no
// floor, so an engine that adds a source type this console build does not know returned `undefined` from a
// function typed `string`, and the subject rendered as "uploads (undefined)" on the Overview lead line, the
// downpipes table and the map. That is a readable row with an unfamiliar word, not a corrupt one, so the
// honest read is to name what arrived rather than to refuse the row: the type IS the label when we have no
// better one. The value is a closed engine enum (never operator text), so echoing it carries no customer
// data, and it reaches the DOM through the same h() textContent path as every other string here.
export function sourceTypeLabel(type: SourceSpec["type"]): string {
  switch (type) {
    case "kv": return "KV";
    case "r2": return "R2";
    case "d1": return "D1";
    case "secrets": return "Secrets";
    case "cf-config": return "Cloudflare config";
    case "workers": return "Workers";
    case "stream": return "Stream";
    case "images": return "Images";
    case "artifacts": return "Artifacts";
    default: return String(type);
  }
}

// sourceName is the human name of the source: the binding, then a namespace/bucket override, then a
// secret count for the Secrets layer, then the bare type word as the floor. Never invents a name.
export function sourceName(source: SourceSpec): string {
  if (source.type === "secrets") {
    const n = source.secrets?.length ?? 0;
    return `${n} secret${n === 1 ? "" : "s"}`;
  }
  if (source.binding) return source.binding;
  if (source.type === "kv" && source.namespaceId) return source.namespaceId;
  if (source.type === "r2" && source.bucketName) return source.bucketName;
  return source.type.toUpperCase();
}

// ---------------------------------------------------------------------------
// Recency fragments (the honest building blocks of the per-downpipe sentence).
// ---------------------------------------------------------------------------

// recencyPhrase turns an RFC-3339 / epoch stamp into "last <date>" using the date-only form, so the
// statement reads as a plain date ("last 7 Jun") rather than a full timestamp. dateOnly emits
// "YYYY-MM-DD UTC"; we keep the UTC-stable date but trim it to a friendly "7 Jun" style for the
// sentence while leaving the precise date to the title at the call site. Returns "" for an
// empty/invalid stamp (the caller treats that as never).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function shortDate(input: string | number | null | undefined): string {
  const iso = dateOnly(input); // "YYYY-MM-DD UTC" or ""
  if (iso === "") return "";
  // iso is "YYYY-MM-DD UTC". Reformat to "D Mon" (e.g. "7 Jun") for the sentence.
  const m = /^(\d{4})-(\d{2})-(\d{2}) UTC$/.exec(iso);
  if (!m) return iso;
  const month = Number(m[2]);
  const day = Number(m[3]);
  const name = MONTHS[month - 1];
  if (name === undefined) return iso;
  return `${day} ${name}`;
}

// isOverdue reports whether a recency stamp is older than OVERDUE_CADENCE_MULTIPLE x the cadence.
// A non-positive / absent cadence means there is no schedule to be overdue against, so it is never
// overdue. It is only ever called with a stamp that PARSED (stampMs returned a number): an
// unparseable stamp is handled by its clause as UNREADABLE, never routed through here (a bad parse
// used to fall out as "not overdue", which read as healthy; see stampMs).
function isOverdue(atMs: number, cadenceSeconds: number | undefined, nowMs: number): boolean {
  if (cadenceSeconds === undefined || cadenceSeconds <= 0) return false;
  if (!Number.isFinite(atMs)) return false;
  return (nowMs - atMs) / 1000 > cadenceSeconds * OVERDUE_CADENCE_MULTIPLE;
}

// stampMs parses a recency stamp the ENGINE supplied, or returns null when it cannot be read. The
// null case is the point: a stamp that is PRESENT but garbage (a truncated wire value, a corrupted
// DO field, a non-string the type promised was a string) used to sail through Date.parse to NaN,
// which isOverdue then judged NOT overdue, so the clause claimed the check had passed recently and
// the downpipe read "covered" off a value nobody can read. That is the worst kind of false state: it
// is indistinguishable from health. An unreadable stamp is now its OWN honest read (see
// unreadableClause), never a pass.
function stampMs(at: string): number | null {
  if (typeof at !== "string") return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

// unreadableClause is the honest read for a present-but-unparseable stamp: the event may well have
// happened, but the console cannot tell WHEN, so it can never be called satisfactory. everHappened
// stays TRUE (the engine did record something), which keeps the tone at "partial" rather than
// collapsing it to "unproven" and claiming the thing never happened at all. Neither the malformed
// value nor any part of it is ever rendered.
//
// It also RECORDS the corruption, and records WHICH stamp. The screen has been honest about this since
// stampMs was fixed; the PACK has not. §4.3 carries the raw stamps, so the corrupt value itself does ride in the
// bundle, and nothing flags it: a support engineer diffing the pack has to eyeball every stamp on every downpipe
// to find the one that reads as garbage, and the bot's sanitize clamp-drops it silently. `fieldClass` is the
// discriminator, and a generic `timestamp` row would not be one: these three stamps make three DIFFERENT
// assurances on the Overview (a restore has been tested, integrity has been checked, offline restorability is
// proven), and a corrupt one is the customer believing a specific thing that is not true. As one row they would
// coalesce and support could not say WHICH assurance was lost. The malformed value has no field here.
function unreadableClause(what: string, fieldClass: ClientDiagFieldClass): ClauseRead {
  recordWireAnomaly(fieldClass, "unparseable");
  return { text: `${what} but the engine's date for it cannot be read`, satisfactory: false, everHappened: true };
}

// ---------------------------------------------------------------------------
// The per-downpipe protection statement.
// ---------------------------------------------------------------------------

// ProtectionStatement is the rendered read: the one true sentence plus a coarse posture tone the
// caller can hue the lead line by (worst honest read across the clauses), and the blunt not-covered
// line. The sentence is plain text; the call site puts it into the DOM via textContent.
export interface ProtectionStatement {
  // The one true sentence (e.g. "uploads (KV) is backed up daily to R2 dr-archive, integrity-checked
  // daily, restore-tested weekly (last 7 Jun), offline restorability last proven 2 Jun by alice").
  sentence: string;
  // The coarse posture: "covered" (proven + checked + current), "partial" (backed up but some
  // assurance is missing or overdue), "unproven" (no proof of recoverability), "uncovered" (not
  // backed up at all: disabled, or no destination), "unreadable" (the console could not read the
  // downpipe's configuration, so it can make NO posture claim either way). Never "covered" unless
  // restorability is actually proven; this is the honesty floor.
  tone: ProtectionTone;
  // The blunt not-covered line: what this statement does NOT assert for THIS downpipe.
  notCovered: string;
}

// ProtectionTone. "unreadable" is a FIFTH member rather than a reuse of "uncovered", and the distinction
// is the whole of the repair. "uncovered" is a CLAIM: this downpipe is not being backed up. A row whose
// configuration the console could not read supports no such claim, and it may well be backing up perfectly;
// folding it into "uncovered" would take a could-not-check and file it as a finding, which is the mirror of
// filing a could-not-check as a pass and just as dishonest. It is hued neutral (this product's honest
// could-not-tell), it is counted on its own, and it never lets the fleet read "everything is covered".
export type ProtectionTone = "covered" | "partial" | "unproven" | "uncovered" | "unreadable";

// protectionStatement renders the TRUE one-sentence summary for a single downpipe, plus the coarse
// tone and the blunt not-covered line. It reads ONLY real fields; an absent recency reads "never",
// a failed check reads "FAILED", and the tone is never "covered" unless offline restorability has
// actually been proven. `nowMs` is injectable for the tests.
export function protectionStatement(
  state: DownpipeState,
  dest: DestinationDescriptor,
  nowMs: number = Date.now(),
): ProtectionStatement {
  // THE GUARD THAT EVERY SIBLING IN THIS FAMILY ALREADY CARRIED AND THIS ONE DID NOT (OBS-CONSOLE-1).
  //
  // Nine sites in the console carry an explicit OBS-CONSOLE-1 null defence, and four of their comments say
  // in terms that the defence exists so a partial engine response cannot throw and blank the whole overview.
  // Every one of them guards the CONTAINER: the downpipe LIST that settled ok:true carrying no array, the
  // history MAP that came back undefined, the licence OBJECT with no tier. Not one of them guards a ROW
  // INSIDE a container that arrived perfectly well-formed, and that is the shape of the hole: `cfg.source`
  // and `cfg.source.type` were read with no guard at all, one line below a list guard that had already
  // passed. The convention was followed; it just did not reach this far in.
  //
  // In a real browser, three healthy downpipes plus one malformed row can take the Overview from 2,632
  // characters and nine stat tiles to 559 and none, frozen on the first-load skeleton forever, because the
  // TypeError escapes an async load with no catch.
  //
  // An unreadable row gets its own honest read rather than a posture. It is NOT dropped (a downpipe that
  // vanishes from the count is the same defect wearing better clothes) and it is NOT called uncovered: the
  // console could not read the record, which is no evidence at all about the backup.
  const read = readDownpipe(state);
  if (!read.readable) {
    const clause = downpipeFaultClause(read.fault);
    return {
      sentence: `A downpipe on this account cannot be described: ${clause}, so this console cannot say what it protects.`,
      tone: "unreadable",
      notCovered: `This downpipe is covered by no statement on this screen, because ${clause}. ${DOWNPIPE_FAULT_REMEDY}`,
    };
  }
  const cfg = read.config;
  const name = sourceName(cfg.source);
  const typeWord = sourceTypeLabel(cfg.source.type);
  const subject = `${name} (${typeWord})`;

  // 1. Backup clause. A disabled downpipe is not backed up; a missing destination is not backed up.
  //    Both are honest "uncovered" reads, stated plainly rather than dressed as a backup.
  if (!cfg.enabled) {
    return {
      sentence: `${subject} is NOT being backed up: this downpipe is paused.`,
      tone: "uncovered",
      notCovered: `${subject} has no current backup while this downpipe is paused. Re-enable it to resume protection.`,
    };
  }
  if (dest.configured === false) {
    return {
      sentence: `${subject} is configured for backup ${cadencePhrase(cfg.cadenceSeconds)} but has NO archive destination set, so nothing is being written.`,
      tone: "uncovered",
      notCovered: `${subject} is not protected: no archive destination is configured. Select a destination before relying on this backup.`,
    };
  }

  // THE DESTINATION READ THAT DID NOT HAPPEN, which is a third state and not a quiet yes.
  // destinationFromStatus returns configured: null when the engine status could not be read at all, and
  // only `false` was being caught above. `null` fell through to the backup clause below and could reach
  // tone "covered", so an unreadable engine rendered the reassurance hue and, on the executive card, the
  // word "Yes" under "Are we protected?". The caveat existed but only inside `sentence`, which no screen
  // renders; every consumer reads `tone`, so the caveat could not reach anybody.
  //
  // The absent verdict is now neither a match nor a mismatch: the sentence still names what could not be
  // read, and the tone is capped below "covered" so nothing downstream can paint it green. It is capped
  // rather than forced to "uncovered" because a destination that could not be READ is not a destination
  // known to be ABSENT, and the assurance clauses still carry whatever the downpipe's own record says.
  const destUnread = dest.configured === null;
  const destPhrase = dest.name ?? "an archive destination (the engine could not be read to name it)";
  const backupClause = `${subject} is backed up ${cadencePhrase(cfg.cadenceSeconds)} to ${destPhrase}`;

  const assurance = buildAssuranceClauses(state, nowMs);
  const sentence = `${[backupClause, ...assurance.clauses].join(", ")}.`;
  const tone = assuranceTone(assurance);

  return {
    sentence,
    tone: destUnread && tone === "covered" ? "partial" : tone,
    notCovered: destUnread
      ? `${subject} cannot be confirmed as protected: the engine could not be read, so the console cannot say whether an archive destination is set. Reload, and check the engine is reachable if it persists.`
      : notCoveredLine(subject, assurance.proven, assurance.restoreTest, assurance.integrity),
  };
}

// AssuranceRead is the trio of honest assurance clauses (integrity / scheduled restore-test /
// offline-restorability-proven) plus the ordered clause fragments, computed once so the sentence and
// the tone roll-up read the same facts.
interface AssuranceRead {
  clauses: string[];
  integrity: ClauseRead;
  restoreTest: ClauseRead;
  proven: ClauseRead;
}

// buildAssuranceClauses builds the three assurance clauses, each honest. A clause is only added when
// it asserts a TRUE fact; an absent fact becomes a "never ..." clause, not a silent omission (a silent
// omission would read as reassurance the state does not earn). The proven clause is always stated last
// and always present so "never proven" is loud rather than implied by omission.
function buildAssuranceClauses(state: DownpipeState, nowMs: number): AssuranceRead {
  const integrity = integrityClause(state, nowMs);
  const restoreTest = restoreTestClause(state, nowMs);
  const proven = provenClause(state, nowMs);
  return { clauses: [integrity.text, restoreTest.text, proven.text], integrity, restoreTest, proven };
}

// assuranceTone is the honesty floor: "covered" requires restorability actually PROVEN AND both other
// clauses satisfactory. Otherwise "unproven" when there is no proof of recoverability at all, else
// "partial" when backed up but some assurance is missing or overdue.
function assuranceTone(a: AssuranceRead): ProtectionTone {
  if (a.proven.satisfactory && a.integrity.satisfactory && a.restoreTest.satisfactory) return "covered";
  if (!a.proven.everHappened && !a.restoreTest.everHappened) return "unproven";
  return "partial";
}

// ClauseRead is one assurance clause: its sentence fragment, whether it is currently SATISFACTORY
// (a recent pass), and whether the thing has EVER happened (so the tone roll-up distinguishes
// "never proven" from "proven but overdue").
interface ClauseRead {
  text: string;
  satisfactory: boolean;
  everHappened: boolean;
}

function integrityClause(state: DownpipeState, nowMs: number): ClauseRead {
  const at = state.lastIntegrityVerifiedAt;
  if (at === undefined) {
    return { text: "never integrity-checked", satisfactory: false, everHappened: false };
  }
  if (state.lastIntegrityVerifiedOk === false) {
    return { text: `last integrity check FAILED (${shortDate(at)})`, satisfactory: false, everHappened: true };
  }
  const atMs = stampMs(at);
  if (atMs === null) return unreadableClause("integrity-checked", "integrity-verified-at");
  const overdue = isOverdue(atMs, state.config.cadenceSeconds, nowMs);
  if (overdue) {
    return { text: `integrity-checked but overdue (last ${shortDate(at)})`, satisfactory: false, everHappened: true };
  }
  return { text: `integrity-checked ${cadencePhrase(state.config.cadenceSeconds)} (last ${shortDate(at)})`, satisfactory: true, everHappened: true };
}

function restoreTestClause(state: DownpipeState, nowMs: number): ClauseRead {
  const cadence = state.config.restoreTestCadenceSeconds;
  const on = cadence !== undefined && cadence > 0;
  const at = state.lastRestoreTestAt;

  if (at !== undefined && state.lastRestoreTestOk === false) {
    return { text: `last restore test FAILED (${shortDate(at)})`, satisfactory: false, everHappened: true };
  }
  if (at === undefined) {
    if (on) return { text: `restore-tested ${cadencePhrase(cadence)} but not yet run`, satisfactory: false, everHappened: false };
    return { text: "no scheduled restore test", satisfactory: false, everHappened: false };
  }
  const atMs = stampMs(at);
  if (atMs === null) return unreadableClause("restore-tested", "restore-test-at");
  const overdue = on && isOverdue(atMs, cadence, nowMs);
  if (overdue) {
    return { text: `restore test overdue (last passed ${shortDate(at)})`, satisfactory: false, everHappened: true };
  }
  const cadenceWord = on ? `${cadencePhrase(cadence)} ` : "";
  return { text: `restore-tested ${cadenceWord}(last ${shortDate(at)})`, satisfactory: true, everHappened: true };
}

// restoreProvenMethodPhrase names the assurance METHOD for the "restorability last proven" surfaces, but
// ONLY for an ATTENDED verification (the new offline-key-only in-platform proof), so the statement says
// "via attended verification (72% sample)" rather than a generic claim that could be mistaken for a keyed
// scheduled test. A blind restore test or keyless attestation returns "" (the statement reads exactly as it
// always did for those, which the protection-statement suite pins), and an absent/unknown method returns ""
// too (never a guessed mechanism). A sub-100 attended sample carries its recorded rate; a full or unrecorded
// sample names the method without a rate. Exported so the /restore proven line renders the identical phrase.
export function restoreProvenMethodPhrase(state: DownpipeState): string {
  if (state.restoreProvenMethod !== "attended-blind-test") return "";
  const raw = state.lastRestoreTestSampleRate;
  const rate = typeof raw === "number" && Number.isFinite(raw) ? Math.max(1, Math.min(100, Math.trunc(raw))) : undefined;
  return rate !== undefined && rate < 100 ? `attended verification (${rate}% sample)` : "attended verification";
}

function provenClause(state: DownpipeState, nowMs: number): ClauseRead {
  const at = state.lastRestoreProvenAt;
  if (at === undefined) {
    return { text: "offline restorability never proven", satisfactory: false, everHappened: false };
  }
  const by = state.lastRestoreProvenBy;
  const byPhrase = by && by.trim() !== "" ? ` by ${by}` : "";
  // Name the method ONLY for an attended verification (see restoreProvenMethodPhrase): a blind/keyless proof
  // adds nothing here, so the sentence reads exactly as before for them.
  const methodPhrase = restoreProvenMethodPhrase(state);
  const via = methodPhrase ? ` via ${methodPhrase}` : "";
  // A proof is judged against the scheduled-restore-test cadence when one is set (the cadence at
  // which recoverability should be re-demonstrated); absent that, any proof stands as satisfactory
  // (the engine has no schedule to call it overdue against).
  const cadence = state.config.restoreTestCadenceSeconds;
  const atMs = stampMs(at);
  if (atMs === null) return unreadableClause("offline restorability recorded as proven", "restore-proven-at");
  const overdue = isOverdue(atMs, cadence, nowMs);
  if (overdue) {
    return { text: `offline restorability last proven ${shortDate(at)}${byPhrase}${via} but that is overdue`, satisfactory: false, everHappened: true };
  }
  return { text: `offline restorability last proven ${shortDate(at)}${byPhrase}${via}`, satisfactory: true, everHappened: true };
}

// cadencePhrase turns the cadence seconds into a friendly word for the sentence ("daily", "weekly",
// "every 6h"); a non-positive / absent cadence reads "on no schedule" (an honest non-scheduled read).
// It names the common cadences (weekly, fortnightly) that the shared cadenceLabel renders as a bare
// "every Nd"; the named form reads better in a plain-English sentence (the spec example says
// "restore-tested weekly"). Anything else falls back to the shared cadenceLabel so the phrase and
// the rest of the console agree on the interval.
function cadencePhrase(cadenceSeconds: number | undefined): string {
  if (cadenceSeconds === undefined || cadenceSeconds <= 0) return "on no schedule";
  if (cadenceSeconds === SECONDS_PER_WEEK) return "weekly";
  if (cadenceSeconds === SECONDS_PER_FORTNIGHT) return "fortnightly";
  return cadenceLabel(cadenceSeconds);
}

// notCoveredLine builds the blunt, per-downpipe "what this does NOT assert" line. It names the
// strongest gap first (restorability never proven), then a failed/overdue check, then the honest
// floor (the statement covers only the configured source, and is evidence of what was proven, not a
// guarantee of future recoverability).
function notCoveredLine(subject: string, proven: ClauseRead, restoreTest: ClauseRead, integrity: ClauseRead): string {
  if (!proven.everHappened) {
    return `Not proven: ${subject} has a backup, but offline restorability has never been demonstrated. A successful backup is not the same as a proven restore.`;
  }
  if (!proven.satisfactory) {
    return `Overdue: ${subject} was proven restorable once, but that proof is older than its restore-test cadence. Re-prove it before relying on it.`;
  }
  if (integrity.everHappened && !integrity.satisfactory) {
    return `Caution: restorability is proven, but the most recent integrity check did not pass or is overdue for ${subject}. Investigate before relying on it.`;
  }
  if (restoreTest.everHappened && !restoreTest.satisfactory) {
    return `Caution: restorability is proven, but the scheduled restore test did not pass or is overdue for ${subject}.`;
  }
  return `Scope: this statement asserts only what has been proven for ${subject}; it is evidence of past recoverability, not a guarantee of future recovery.`;
}

// ---------------------------------------------------------------------------
// The fleet roll-up.
// ---------------------------------------------------------------------------

// FleetProtection is the fleet-wide protection roll-up: the one-line summary, the coarse worst tone,
// and the blunt fleet-level not-covered line. It is computed from the per-downpipe statements so the
// fleet read can never disagree with the per-downpipe reads.
export interface FleetProtection {
  // The fleet summary line (e.g. "5 downpipes: 3 covered, 1 backed up but not proven, 1 not covered").
  summary: string;
  // The worst per-downpipe tone across the fleet (the fleet is only "covered" when EVERY enabled
  // downpipe is covered), so the lead line hues to the weakest link, never the strongest.
  tone: ProtectionTone;
  // The blunt fleet not-covered line: a plain count of what is NOT protected/proven.
  notCovered: string;
  // The per-tone counts, for a caller that wants to render pills instead of (or beside) the line.
  counts: Record<ProtectionTone, number>;
}

// TONE_RANK ranks tones worst-first so the fleet tone is the worst across the fleet.
//
// "unreadable" ranks ABOVE "uncovered" and below everything else, and both halves of that are deliberate.
// Below partial/unproven/covered, because one row this console cannot read means the fleet read is not a
// clean bill of health and must never paint as one. Above uncovered, because a downpipe KNOWN to have no
// destination is a worse, and better-established, fact than a row we could not parse: a real finding must
// not be displaced from the headline by a could-not-check sitting beside it. The counts line names both, so
// neither is hidden by the other.
const TONE_RANK: Record<ProtectionTone, number> = { uncovered: 0, unreadable: 1, unproven: 2, partial: 3, covered: 4 };

// fleetProtection rolls the per-downpipe statements into the fleet read. An EMPTY fleet is an honest
// "no downpipes are configured, so nothing is protected" (uncovered), never a vacuous "all covered".
export function fleetProtection(
  states: DownpipeState[],
  dest: DestinationDescriptor,
  nowMs: number = Date.now(),
): FleetProtection {
  const counts: Record<ProtectionTone, number> = { covered: 0, partial: 0, unproven: 0, uncovered: 0, unreadable: 0 };

  if (states.length === 0) {
    return {
      summary: "No downpipes are configured, so nothing is being backed up yet.",
      tone: "uncovered",
      notCovered: "Not covered: there are no backup routes at all. Create a downpipe to start protecting a source.",
      counts,
    };
  }

  let worst: ProtectionTone = "covered";
  for (const s of states) {
    const t = protectionStatement(s, dest, nowMs).tone;
    counts[t]++;
    if (TONE_RANK[t] < TONE_RANK[worst]) worst = t;
  }

  const total = states.length;
  const parts: string[] = [];
  if (counts.covered > 0) parts.push(`${counts.covered} covered`);
  if (counts.partial > 0) parts.push(`${counts.partial} backed up with gaps`);
  if (counts.unproven > 0) parts.push(`${counts.unproven} backed up but not proven`);
  if (counts.uncovered > 0) parts.push(`${counts.uncovered} not covered`);
  // Named in the SUMMARY, not only in the not-covered line beneath it, because the summary is the sentence
  // the Overview leads with and a fleet of five that can only speak for four must say so in the same breath
  // as the four. A zero adds nothing, exactly like every other arm here, so a healthy fleet's summary is
  // byte-for-byte what it was before this member existed.
  if (counts.unreadable > 0) parts.push(`${counts.unreadable} could not be read`);
  const summary = `${total} downpipe${total === 1 ? "" : "s"}: ${parts.join(", ")}.`;

  return { summary, tone: worst, notCovered: fleetNotCovered(counts), counts };
}

// fleetNotCovered builds the blunt fleet not-covered line: the count of downpipes that are NOT
// covered and NOT proven, stated plainly. When everything is covered it says so honestly (the only
// case where "all covered" is true), and it still names the honest floor (proven, not guaranteed).
// When every downpipe IS being backed up and the only gap is proof, the line leads "Proof gap:"
// (not "Not covered:") and does not restate the backed-up count the summary heading already
// carries; the heading + this line then say one fact once each, not one fact three ways.
function fleetNotCovered(counts: Record<ProtectionTone, number>): string {
  const notProtected = counts.uncovered;
  const notProven = counts.unproven + counts.partial;
  // THE UNREADABLE CLAUSE COMES FIRST AND IT IS APPENDED, NOT SUBSTITUTED. It leads because a line that
  // opens "Every downpipe is backed up" over a fleet the console could only partly read is the strongest
  // false claim this screen can make; it is appended rather than replacing the rest because the readable
  // rows were still read and their finding is still true. The all-clear arm is the one that MUST NOT
  // survive an unreadable row, so it is guarded before it can be reached.
  const unread = counts.unreadable > 0
    ? ` ${counts.unreadable} downpipe${counts.unreadable === 1 ? "" : "s"} could not be read at all, so ${counts.unreadable === 1 ? "it is" : "they are"} covered by none of this. ${DOWNPIPE_FAULT_REMEDY}`
    : "";
  if (notProtected === 0 && notProven === 0 && counts.unreadable === 0) {
    return "Every downpipe is backed up and its restorability is proven and current. This is evidence of proven recovery, not a guarantee of future recovery.";
  }
  if (notProtected === 0 && notProven === 0) {
    return `Every downpipe this console could read is backed up and its restorability is proven and current.${unread}`;
  }
  if (notProtected === 0) {
    return `Proof gap: ${notProven} ${notProven === 1 ? "has" : "have"} a gap in proof or assurance. A successful backup is not a proven restore.${unread}`;
  }
  const bits: string[] = [];
  bits.push(`${notProtected} downpipe${notProtected === 1 ? "" : "s"} ${notProtected === 1 ? "is" : "are"} not being backed up`);
  if (notProven > 0) bits.push(`${notProven} ${notProven === 1 ? "is" : "are"} backed up but ${notProven === 1 ? "has" : "have"} a gap in proof or assurance`);
  return `Not covered: ${bits.join("; ")}. A successful backup is not a proven restore.${unread}`;
}

// ---------------------------------------------------------------------------
// Relative-time helper re-export for the call sites (so a title can carry the
// precise relative phrase beside the plain-date sentence).
// ---------------------------------------------------------------------------

// provenTitle builds the absolute/relative tooltip for the proven stamp, so the lead line can carry
// the precise instant as a title while the sentence stays a plain date. Returns "" when never proven.
// Wired into the restore-flow proof card's dated line (restore-flow/proof.ts, buildProvenHost): that
// line is lastProvenLine's plain-date sentence, and this is its title attribute.
export function provenTitle(state: DownpipeState): string {
  const at = state.lastRestoreProvenAt;
  if (at === undefined) return "";
  return `Offline restorability last proven ${relativeTime(at)}.`;
}
