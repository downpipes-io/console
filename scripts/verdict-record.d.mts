// Types for verdict-record.mjs, which is plain JavaScript. Same arrangement as ledger-verdicts.d.mts and
// workspace-root.d.mts beside it.
//
// House style: Australian English, no em dashes, no rule-of-three, precise claims, no AI attribution.

/** The record's shape identifier; a reader that does not recognise it refuses rather than guessing. */
export const RECORD_SCHEMA: string;

/** Where the record lives, relative to the console repo root. */
export const RECORD_REL_PATH: string;

/** The sha256 of some bytes, hex. The one hashing rule the writer and the reader share. */
export function contentDigest(bytes: Uint8Array | string): string;

/** One graded (control, console commit) pair, as the record stores it. */
export interface VerdictEntry {
  key: string;
  console_sha: string;
  ts: string | null;
  verdict: string;
  /** The index of the winning row among ledger rows naming a catalogue key. Ties on `ts` break to the lower one. */
  seq: number;
  /** The catalogue's `file` for this control, at the time the record was derived. */
  file: string;
  /** sha256 of that file's bytes AS THEY WERE at `console_sha`. The currency instrument. */
  file_sha256: string;
}

export interface VerdictRecord {
  schema: string;
  counts: {
    catalogue_rows: number;
    ledger_rows_naming_a_catalogue_key: number;
    ledger_rows_excluded_estate_build: number;
    keys_graded: number;
    entries: number;
  };
  verdicts: VerdictEntry[];
  /** Graded pairs whose blob the writer could not read. Never persisted: a writer that hits one refuses. */
  unresolvable: { key: string; console_sha: string; file: string }[];
}

export function buildRecord(args: {
  lines: Iterable<string>;
  catalogueRows: { key: string; file: string }[];
  blobDigest: (sha: string, file: string) => string | null;
}): VerdictRecord;

/** The record's canonical bytes. Carries nothing volatile, so an unchanged ledger reproduces them exactly. */
export function serialiseRecord(record: VerdictRecord): string;

/** One control in a score list. The expired lists carry `why`, which the standing ones cannot have. */
export interface ScoredControl {
  key: string;
  verdict: string;
  ts: string | null;
  console_sha: string;
}

/** An expired control, plus WHICH currency rule dropped it: its source moved, or the catalogue refiled it. */
export interface ExpiredControl extends ScoredControl {
  why: "code-moved" | "refiled";
}

export interface RecordScore {
  passing: ScoredControl[];
  failing: ScoredControl[];
  /**
   * Controls with NO standing verdict whose latest dropped one PASSED: coverage owed a re-drive, and it
   * says nothing about whether the control works. Split from expiredFailing deliberately, because merging
   * them lets an unanswered failure hide inside a re-drive owed.
   */
  expiredPassing: ExpiredControl[];
  /** The same, where the latest dropped verdict FAILED: a re-drive owed plus an unanswered failure. */
  expiredFailing: ExpiredControl[];
  /** passing.length, the DRIVEN count. */
  driven: number;
  /** Controls carrying any standing verdict, passing or not. */
  graded: number;
  /**
   * Entries dropped because the control's own source file has moved since the verdict was banked.
   * staleCode and movedFile count ENTRIES; the two expired lists count CONTROLS, and both are wanted.
   */
  staleCode: number;
  /** Entries dropped because the catalogue now files that control somewhere else. */
  movedFile: number;
  /** Entries naming a control the catalogue does not have. */
  orphanKey: number;
}

export function scoreRecord(args: {
  record: { schema: string; verdicts: VerdictEntry[] };
  catalogueRows: { key: string; file: string }[];
  treeDigest: (file: string) => string | null;
}): RecordScore;

/**
 * Which kind of red a DRIVEN fall is. `currency` is true only when nothing is failing AND the expired
 * passes account for every point of the fall, so a record that has merely lost entries cannot read as
 * currency loss. `unexplained` is the part no expiry accounts for.
 */
export function classifyDrivenFall(args: {
  driven: number;
  failing: unknown[];
  expiredPassing: unknown[];
  floor: number;
}): { fell: boolean; currency: boolean; recoverable: number; shortfall: number; unexplained: number };

/** What a freshly derived record and the committed one disagree about. Empty means they agree. */
export function describeDisagreement(committed: Partial<VerdictRecord>, fresh: VerdictRecord): string[];

/** Parses and shape-checks a record, refusing rather than defaulting. */
export function parseRecord(text: string): { ok: true; record: VerdictRecord; text: string } | { ok: false; why: string };
