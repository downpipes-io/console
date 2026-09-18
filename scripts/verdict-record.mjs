// THE COMMITTED VERDICT RECORD: the harness run ledger, distilled into a file CI can read.
//
// WHAT PROBLEM THIS SOLVES. Scoring a catalogued control as covered because some harness file merely
// CONTAINS its [data-dp="<key>"] as text is not the same as the control's own cell passing: a control whose
// cell FAILS can still be printed as "PROVEN AT CONTROL GRAIN" under a text scan.
// scripts/ledger-verdicts.mjs replaces the text scan with a RESULT scan over harness/ledger/RUNS.jsonl,
// which is right, but harness/.gitignore ignores ledger/*.jsonl, so console CI's Cross-repo job checks the
// harness repo out fresh and gets a ledger directory with no runs in it. A result-grade number read
// straight from the ledger is therefore enforced only on a workstation that has one, leaving CI to enforce
// the number that overstates.
//
// This module closes that. It DERIVES a small record from the ledger, the record is committed, and the gate
// scores from the record everywhere. CI needs no ledger and no git history to apply it.
//
// THE RECORD IS DERIVED, NEVER HAND-EDITED, and both halves of that are mechanical:
//   - scripts/write-verdict-record.mjs is the only writer, and it is re-runnable: buildRecord() is a pure
//     function of (ledger rows, catalogue rows, the console blob at each graded sha), and serialiseRecord()
//     is canonical, so re-running it over an unchanged ledger reproduces the committed bytes exactly.
//   - a generated artefact that goes stale silently is a failure mode worth guarding against in this file as
//     much as anywhere else, so `--check` rebuilds the record and FAILS on any disagreement with the
//     committed bytes. It runs inside functional-catalogue-gate.mjs wherever a ledger is present, which is
//     every workstation that banks a run. It cannot run in CI, because CI has no ledger; what CI gets
//     instead is stated below.
//
// CURRENCY IS CONTENT, NOT HISTORY, which is a stricter rule than checking that a row's console_sha is an
// ancestor of HEAD with the control's own source file unchanged since. That ancestry rule needs deep git
// history, which the CI checkout does not have (actions/checkout defaults to fetch-depth 1), so it cannot be
// the rule a committed record is read under. The rule here is the content test alone: the record carries the
// sha256 of the control's own source file AS IT WAS at the graded sha, and a verdict is current when that
// digest still matches the working tree.
//
// The content rule is also the STRICTER one in a real case: a control graded several times against a
// byte-identical source file, where the most recent grades sit on a commit that never landed, has its most
// recent verdict dropped by an ancestry rule in favour of an older one, even when that most recent verdict
// is a DETECT and the code it graded is character for character the code in this checkout. Under the
// content rule the DETECT stands, because currency is decided by the code, not by which commit carried it.
// An ancestry rule can hide a standing failure that way.
//
// So the ancestry leg is dropped rather than kept as a second opinion: keeping it would make the number
// differ between a deep checkout and CI's shallow one, and a ratchet whose value depends on how the repo
// was cloned cannot be enforced in both places.
//
// WHAT THE CONTENT RULE DOES NOT ESTABLISH, said plainly rather than left for a reader to find. It is a
// PROXY for "this verdict still describes this control": a shared component, the capability map or a CSS
// change can alter a control's behaviour from a file this rule never looks at. It is exact in one direction
// only, that a control whose own source moved has no current verdict. The stronger rule, a byte-identical
// console/public, was tried and rejected: over a landed cut it leaves zero current verdicts, which is not a
// usable rule.
//
// WHAT CI GETS WITHOUT A LEDGER, and its one real limit. CI can apply the currency rule, score the record,
// and enforce the ratchet, none of which it could do reading the ledger directly. It cannot re-derive the
// record, so it cannot catch a record edited by hand to name controls the ledger never graded. Three things
// stand against that and none of them is "trust the file": every key in the record must be a catalogue key
// and carry the catalogue's own `file` for that key, so an invented key or a moved control is caught in CI;
// a fabricated digest cannot match the working tree, so a fabricated entry scores as stale rather than as a
// pass; and the rebuild-and-compare runs on every `npm run lint` where the ledger is. Staleness decays the
// number DOWNWARDS, which is the direction the ratchet catches.

import { createHash } from "node:crypto";
import { keyOf, laterWins, PASSING_VERDICTS } from "./ledger-verdicts.mjs";

/** The record's shape identifier. A reader that does not recognise it refuses rather than guessing. */
/**
 * One graded entry in the committed record: a control (`key`), scored against the file the catalogue
 * currently files it under, at the sha the working tree's copy of that file hashes to right now.
 * @typedef {{ key: string, verdict: string, ts: unknown, file: string, file_sha256: string, seq: number, console_sha: string }} VerdictEntry
 */

export const RECORD_SCHEMA = "downpipes/control-grain-verdicts@1";

/** Where the record lives, relative to the console repo root. */
export const RECORD_REL_PATH = "manifest/control-grain-verdicts.json";

/** The sha256 of a file's bytes, hex. The one hashing rule, so the writer and the reader cannot diverge. */
export function contentDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Builds the record from the ledger.
 *
 * PURE, and deliberately so: the git and filesystem work is the caller's, passed in as `blobDigest`. That
 * is what lets the whole thing be tested over synthetic ledgers with no repo behind them, which is where
 * every mutation proof in test/validate-r43-verdict-record.ts lives.
 *
 * ONE ENTRY PER (key, console_sha), not one per key. The reader has to be able to drop a verdict whose code
 * has since moved and then let an OLDER verdict stand, which is what the ledger scan does when it filters
 * for currency before it takes the latest. Currency is a function of (key, console_sha) alone, so keeping
 * the latest row per (key, console_sha) preserves that exactly while still collapsing many ledger rows down
 * to a much smaller set of entries. Collapsing to one entry per key would not: it would bank a decision the
 * reader is supposed to make.
 *
 * @param {object} args
 * @param {Iterable<string>} args.lines            ledger JSONL lines, in append order
 * @param {{ key: string, file: string }[]} args.catalogueRows
 * @param {(sha: string, file: string) => string | null} args.blobDigest  sha256 of `file` at `sha`, or null
 */
export function buildRecord({ lines, catalogueRows, blobDigest }) {
  const fileOf = new Map(catalogueRows.map((r) => [r.key, r.file]));
  /** @type {Map<string, { key: string, console_sha: string, ts: unknown, verdict: string, seq: number }>} */
  const latest = new Map();
  let rowsNamingAKey = 0;
  let excludedEstateBuild = 0;
  for (const line of lines) {
    const key = keyOf(line);
    if (key === null || !fileOf.has(key)) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a torn line is not a verdict; same posture as ledger-verdicts.mjs
    }
    if (typeof row.key !== "string" || typeof row.verdict !== "string" || typeof row.console_sha !== "string") continue;
    const seq = rowsNamingAKey++;
    // A row graded against a DEPLOYED estate is excluded here rather than at read time: neither this
    // module nor the gate can know whether that build is still deployed, since console_sha names the test
    // machine's checkout, not what the estate served. Counted, so the exclusion is a number in the record
    // rather than a silence.
    if (typeof row.served_console_build === "object" && row.served_console_build !== null) {
      excludedEstateBuild++;
      continue;
    }
    const id = `${row.key} ${row.console_sha}`;
    const prev = latest.get(id);
    if (laterWins({ ts: row.ts, seq }, prev)) latest.set(id, { key: row.key, console_sha: row.console_sha, ts: row.ts, verdict: row.verdict, seq });
  }

  const verdicts = [];
  const unresolvable = [];
  for (const e of [...latest.values()].sort((a, b) => a.key.localeCompare(b.key) || a.console_sha.localeCompare(b.console_sha))) {
    const file = fileOf.get(e.key);
    const digest = blobDigest(e.console_sha, /** @type {string} */ (file));
    if (digest === null) {
      // "Could not check" is not "checked and fine". A caller that cannot read the blob a verdict was
      // graded against cannot write a record that means anything, and writing the entry with a null digest
      // would quietly convert every such verdict into a permanent stale one.
      unresolvable.push({ key: e.key, console_sha: e.console_sha, file });
      continue;
    }
    verdicts.push({ key: e.key, console_sha: e.console_sha, ts: typeof e.ts === "string" ? e.ts : null, verdict: e.verdict, seq: e.seq, file, file_sha256: digest });
  }

  return {
    schema: RECORD_SCHEMA,
    counts: {
      catalogue_rows: catalogueRows.length,
      ledger_rows_naming_a_catalogue_key: rowsNamingAKey,
      ledger_rows_excluded_estate_build: excludedEstateBuild,
      keys_graded: new Set(verdicts.map((v) => v.key)).size,
      entries: verdicts.length,
    },
    verdicts,
    unresolvable,
  };
}

/**
 * The record's bytes, canonically.
 *
 * NOTHING VOLATILE GOES IN. No write timestamp, no writer's HEAD, no absolute path. Every one of those
 * would change the bytes on a re-run that found nothing new, and a staleness gate that compares bytes has
 * to be able to say "identical" when nothing moved or its red means nothing. When the record was written is
 * a question git already answers.
 */
export function serialiseRecord(record) {
  const { unresolvable: _unresolvable, ...persisted } = record;
  return `${JSON.stringify(persisted, null, 2)}\n`;
}

/**
 * Scores a record against a working tree: which controls carry a standing PASSING verdict for the code
 * that is actually here.
 *
 * IT ALSO SAYS WHY A CONTROL IS NOT PROVEN, per control, because the two reasons are different facts and
 * a caller that can only see the total has to guess between them. A control is unproven either because its
 * standing verdict FAILS against the code that is here, which is a regression, or because every verdict it
 * has stopped counting when its source file moved, which is currency loss and says nothing about whether
 * the control works. `expiredPassing` and `expiredFailing` carry the second case, split by what the verdict
 * said before it expired: a control whose last grade was a pass and whose proof has gone stale is coverage
 * owed a re-drive, and one whose last grade was a FAILURE is that plus an unanswered failure, and merging
 * them would let the second hide inside the first.
 *
 * `staleCode`/`movedFile` count ENTRIES and the expired lists count CONTROLS. Both are wanted: a control
 * graded at forty commits contributes forty entries and one control, so the entry counts describe the
 * record's churn and the control counts describe coverage.
 *
 * @param {object} args
 * @param {{ schema: string, verdicts: VerdictEntry[] }} args.record
 * @param {{ key: string, file: string }[]} args.catalogueRows
 * @param {(file: string) => string | null} args.treeDigest  sha256 of the working tree's `file`, or null
 */
export function scoreRecord({ record, catalogueRows, treeDigest }) {
  const fileOf = new Map(catalogueRows.map((r) => [r.key, r.file]));
  /** @type {Map<string, VerdictEntry>} */
  const standing = new Map();
  /** @type {Map<string, VerdictEntry & { why: string }>} */
  const dropped = new Map(); // key -> the latest entry that was dropped for currency, by the same laterWins rule
  let staleCode = 0; // the control's own source has moved since the verdict was banked
  let movedFile = 0; // the catalogue now files this control somewhere else entirely
  let orphanKey = 0; // the record names a control the catalogue does not
  const dropFor = (e, why) => {
    const prev = dropped.get(e.key);
    if (laterWins(e, prev)) dropped.set(e.key, { ...e, why });
  };
  for (const e of record.verdicts) {
    const catFile = fileOf.get(e.key);
    if (catFile === undefined) {
      orphanKey++;
      continue;
    }
    if (catFile !== e.file) {
      movedFile++;
      dropFor(e, "refiled");
      continue;
    }
    if (treeDigest(catFile) !== e.file_sha256) {
      staleCode++;
      dropFor(e, "code-moved");
      continue;
    }
    const prev = standing.get(e.key);
    if (laterWins(e, prev)) standing.set(e.key, e);
  }
  const passing = [];
  const failing = [];
  for (const [key, e] of standing) (PASSING_VERDICTS.has(e.verdict) ? passing : failing).push({ key, verdict: e.verdict, ts: e.ts, console_sha: e.console_sha });
  // A control with a STANDING verdict is not expired, whatever else the record holds for it: a fresh grade
  // against the code that is here supersedes every older entry, including the ones that stopped counting.
  const expiredPassing = [];
  const expiredFailing = [];
  for (const [key, e] of dropped) {
    if (standing.has(key)) continue;
    (PASSING_VERDICTS.has(e.verdict) ? expiredPassing : expiredFailing).push({ key, verdict: e.verdict, ts: e.ts, console_sha: e.console_sha, why: e.why });
  }
  const byKey = (a, b) => a.key.localeCompare(b.key);
  passing.sort(byKey);
  failing.sort(byKey);
  expiredPassing.sort(byKey);
  expiredFailing.sort(byKey);
  return { passing, failing, expiredPassing, expiredFailing, driven: passing.length, graded: standing.size, staleCode, movedFile, orphanKey };
}

/**
 * WHICH KIND OF RED a DRIVEN fall is: a regression, or coverage that has merely gone out of date.
 *
 * The reasoning lives in functional-catalogue-gate.mjs's WHICH KIND OF RED header. What is here is the
 * arithmetic, in one place and pure, so that it can be attacked directly rather than only through a
 * twenty-second gate run: test/validate-currency-vs-regression.ts drives it with a regression and a
 * currency loss at the same time, which is the case a naive split gets wrong.
 *
 * TWO CONDITIONS, and dropping either one opens a way to hide a real failure behind a re-drive owed:
 *   failing must be EMPTY. A control whose own drive fails is a regression however much else expired.
 *   driven + expiredPassing must still REACH the floor, so the expiries account for every point of the
 *   fall. Without this, a record that has simply lost entries reads as currency loss, which is how a
 *   hand-edited record could retire a failing control by deleting it rather than by fixing it.
 *
 * expiredFailing is deliberately not in the sum. A control whose last grade was a failure is not coverage
 * waiting to be re-banked, and counting it would let a failing control pay for its own disappearance.
 *
 * @param {{ driven: number, failing: unknown[], expiredPassing: unknown[], floor: number }} args
 * @returns {{ fell: boolean, currency: boolean, recoverable: number, shortfall: number, unexplained: number }}
 */
export function classifyDrivenFall({ driven, failing, expiredPassing, floor }) {
  const recoverable = driven + expiredPassing.length;
  const fell = driven < floor;
  return {
    fell,
    currency: fell && failing.length === 0 && recoverable >= floor,
    recoverable,
    shortfall: fell ? floor - driven : 0,
    unexplained: fell ? Math.max(0, floor - recoverable) : 0,
  };
}

/**
 * What a freshly derived record and the committed one disagree about, as a list of human-readable
 * findings. Empty means the committed file is exactly what the ledger produces today.
 *
 * The byte comparison is the gate; this only explains it. A bytes-equal check alone would be sound but
 * would print "they differ" and leave the reader to diff a 400-entry JSON file by eye, and a gate nobody
 * can act on gets suppressed.
 */
export function describeDisagreement(committed, fresh) {
  const findings = [];
  if (committed.schema !== fresh.schema) findings.push(`schema is ${JSON.stringify(committed.schema)} in the committed record and ${JSON.stringify(fresh.schema)} freshly derived`);
  // Keyed on the FULL sha, shown with a short one. Two commits sharing a 10-character prefix would
  // otherwise be one entry here, and the difference between them would go unreported.
  const idOf = (e) => `${e.key}@${e.console_sha}`;
  const show = (id) => id.replace(/@([0-9a-f]{10})[0-9a-f]*$/, "@$1");
  const c = new Map((committed.verdicts ?? []).map((e) => [idOf(e), e]));
  const f = new Map(fresh.verdicts.map((e) => [idOf(e), e]));
  for (const [id, e] of f) if (!c.has(id)) findings.push(`the ledger has a verdict the record does not: ${show(id)} ${e.verdict}`);
  for (const [id, e] of c) if (!f.has(id)) findings.push(`the record has a verdict the ledger does not: ${show(id)} ${e.verdict} (invented, or derived from a ledger this one is not)`);
  for (const [id, e] of f) {
    const was = c.get(id);
    if (was === undefined) continue;
    for (const field of ["verdict", "ts", "file", "file_sha256", "seq"]) {
      if (was[field] !== e[field]) findings.push(`${show(id)} ${field}: record says ${JSON.stringify(was[field])}, the ledger says ${JSON.stringify(e[field])}`);
    }
  }
  for (const k of Object.keys(fresh.counts)) {
    if (committed.counts?.[k] !== fresh.counts[k]) findings.push(`counts.${k}: record says ${JSON.stringify(committed.counts?.[k])}, the ledger says ${JSON.stringify(fresh.counts[k])}`);
  }
  return findings;
}

/**
 * Reads the record, refusing rather than defaulting.
 *
 * @returns {{ ok: true, record: object, text: string } | { ok: false, why: string }}
 */
export function parseRecord(text) {
  let record;
  try {
    record = JSON.parse(text);
  } catch (err) {
    return { ok: false, why: `it is not readable JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (record?.schema !== RECORD_SCHEMA) return { ok: false, why: `its schema is ${JSON.stringify(record?.schema)}, not ${JSON.stringify(RECORD_SCHEMA)}` };
  if (!Array.isArray(record.verdicts)) return { ok: false, why: "it carries no verdicts array" };
  // A record with no entries has no failing keys and no passing ones, so a gate reading it would report a
  // clean measurement of nothing. That is the regression this row closes, wearing a green tick.
  if (record.verdicts.length === 0) return { ok: false, why: "it holds ZERO verdicts, so it can neither prove nor disprove anything about a control" };
  for (const e of record.verdicts) {
    if (typeof e?.key !== "string" || typeof e?.verdict !== "string" || typeof e?.file !== "string" || typeof e?.file_sha256 !== "string" || typeof e?.seq !== "number") {
      return { ok: false, why: `an entry does not carry the shape a reader scores: ${JSON.stringify(e).slice(0, 120)}` };
    }
  }
  return { ok: true, record, text };
}
