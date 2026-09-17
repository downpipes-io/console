// Types for ledger-verdicts.mjs, which is plain JavaScript. Same arrangement as workspace-root.d.mts
// beside it.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

/** The verdict words that PASS, from harness/lib/ledger.ts: CLEAN and HANDLED, and nothing else. */
export const PASSING_VERDICTS: ReadonlySet<string>;

/** The environment variable naming a ledger directory, mirroring harness/lib/ledger.ts. */
export const LEDGER_DIR_ENV: string;

/** The `key` field of a JSONL row, read without parsing it, or null when the row carries none. */
export function keyOf(line: string): string | null;

/** The lines of a file, read in bounded chunks rather than held whole. */
export function jsonlLines(path: string): Generator<string, void, undefined>;

/**
 * Does a candidate row displace the incumbent as a control's standing verdict: later `ts` wins, and on an
 * equal `ts` the lower `seq` (the earlier ledger row) wins.
 */
export function laterWins(candidate: { ts?: unknown; seq: number }, incumbent: { ts?: unknown; seq: number } | undefined): boolean;

/** One control's standing verdict, as scored from the ledger. */
export interface StandingEntry {
  key: string;
  verdict: string;
  ts?: string;
}

export interface StandingVerdicts {
  /** Controls whose most recent current verdict passes, sorted by key. */
  passing: StandingEntry[];
  /** Controls whose most recent current verdict does not pass, sorted by key. */
  failing: StandingEntry[];
  /** Ledger rows naming a catalogued control, before any exclusion. */
  rowsNamingAKey: number;
  /** Rows dropped because isCurrent() rejected the build they graded. */
  excludedStaleBuild: number;
  /** Rows dropped because they graded a deployed estate build this checkout cannot confirm. */
  excludedEstateBuild: number;
  /** passing.length, the DRIVEN count. */
  driven: number;
}

export function standingVerdicts(args: {
  lines: Iterable<string>;
  isCatalogueKey: (key: string) => boolean;
  isCurrent: (row: Record<string, unknown>) => boolean;
}): StandingVerdicts;
