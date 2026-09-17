// The harness's run ledger, read as EVIDENCE OF A RESULT.
//
// A text scan for a control's own [data-dp="<key>"] inside the harness corpus can only prove a journey
// NAMES the control, never that it passed: a catalogued control whose cell demonstrably FAILED can still
// be counted as "PROVEN AT CONTROL GRAIN" by a scan alone. This module answers the better question, from
// harness/ledger/RUNS.jsonl: did a harness cell that drives this control BANK A PASSING VERDICT for it.
//
// It is a separate file, and PURE, so it can be unit-tested rather than living only inside a long script
// where a guard like this would go untested. That matters concretely here: a keyOf() regex that is too
// strict about whitespace (matching only `"key":"` with no space) would silently skip any ledger writer
// that spaces its JSON separators, and its failures would then count as passes.
// test/validate-r43-ledger-scoring.ts exists to catch exactly that shape of bug with a synthetic row,
// rather than relying on reading the code.
//
// FS-WRITES: none outside this repo
// It opens the harness ledger, which IS outside this repo, but openSync with an "r" flag only reads and
// nothing here writes. The declaration is required because outside-write-gate.mjs counts openSync as a
// write entry point: from the text alone a read open and a write open are the same call.

import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/**
 * The verdicts that PASS, which is harness/lib/ledger.ts's own rule and not a set invented here: "CLEAN
 * and HANDLED pass. Everything else fails." HANDLED is a pass because an EXPECTED error surfaced
 * helpfully is correct behaviour. UNHELPFUL, DETECT, RECTIFY, EXPLAIN, GAP, ENV-FAULT and VACUOUS are all
 * failures for this purpose, ENV-FAULT included: a cell the environment stopped from running proves
 * nothing about the control it was pointed at.
 */
export const PASSING_VERDICTS = new Set(["CLEAN", "HANDLED"]);

/** Mirrors harness/lib/ledger.ts's LEDGER_DIR_OVERRIDE_ENV, so a run banked into a scratch ledger can be
 *  scored by pointing this gate at the same directory rather than by hand. */
export const LEDGER_DIR_ENV = "DOWNPIPES_LEDGER_DIR";

/**
 * The `key` of a JSONL row, without parsing the row. A prefilter, because RUNS.jsonl is 78 MB and 170k
 * lines today of which about 700 name a catalogue key, and JSON.parsing all of them on every `npm run
 * lint` is a cost with no return. Whitespace-tolerant on purpose: see the header.
 */
const KEY_RE = /"key"\s*:\s*"((?:[^"\\]|\\.)*)"/;
export function keyOf(line) {
  const m = KEY_RE.exec(line);
  return m === null ? null : m[1];
}

/**
 * Yields the lines of a file without holding it all in memory. The decoder is what keeps a multi-byte
 * character split across a chunk boundary from being mangled into a line that will not parse, which would
 * drop a verdict silently.
 */
export function* jsonlLines(path) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    const decoder = new StringDecoder("utf8");
    let carry = "";
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      const parts = (carry + decoder.write(buf.subarray(0, n))).split("\n");
      carry = parts.pop() ?? "";
      yield* parts;
    }
    carry += decoder.end();
    if (carry.trim() !== "") yield carry;
  } finally {
    closeSync(fd);
  }
}

/**
 * Does `candidate` displace `incumbent` as a control's STANDING verdict.
 *
 * Exported and shared rather than written twice. It is applied in two places that MUST agree or the
 * committed verdict record stops meaning what the ledger means: once here, over ledger rows in append
 * order, and once in verdict-record.mjs, over the record's entries in sorted order. The tie-break makes
 * those two orders give the same answer: later `ts` wins, and on an equal `ts` the row that appeared
 * EARLIER in the ledger wins.
 *
 * @param {{ ts?: unknown, seq: number }} candidate
 * @param {{ ts?: unknown, seq: number } | undefined} incumbent
 */
export function laterWins(candidate, incumbent) {
  if (incumbent === undefined) return true;
  const a = String(candidate.ts ?? "");
  const b = String(incumbent.ts ?? "");
  return a === b ? candidate.seq < incumbent.seq : a > b;
}

/**
 * The STANDING verdict of every catalogued control the ledger has graded.
 *
 * LATEST WINS, per key. The ledger is append-only and never rewritten, so a key's standing verdict is its
 * most recent one and an old CLEAN does not survive a later DETECT. That rule is load-bearing rather than
 * tidy: idp-connections.button.test-control banks CLEAN "before its reveal" and DETECT on the reveal
 * assertion milliseconds later, so an "any pass counts" rule would report it as proven coverage.
 *
 * CURRENCY is the caller's to define, through isCurrent(row), because it is a question about the console
 * checkout and this module knows nothing about git. functional-catalogue-gate.mjs applies two tests: the
 * row's console_sha must be a commit this checkout contains and an ancestor of HEAD, and the control's own
 * source file must not have changed between that sha and the working tree.
 *
 * A row carrying a REAL served_console_build object graded a DEPLOYED estate, and neither this module nor
 * its caller can know whether that build is still deployed (console_sha names the test machine's
 * checkout, not what the estate served). Those rows are dropped and counted, so the exclusion is a
 * printed number rather than an assumption.
 *
 * @param {object} args
 * @param {Iterable<string>} args.lines           JSONL lines, in append order.
 * @param {(key: string) => boolean} args.isCatalogueKey
 * @param {(row: object) => boolean} args.isCurrent  does this verdict still describe the build we have.
 */
export function standingVerdicts({ lines, isCatalogueKey, isCurrent }) {
  const standing = new Map();
  let rowsNamingAKey = 0;
  let excludedStaleBuild = 0;
  let excludedEstateBuild = 0;
  for (const line of lines) {
    const key = keyOf(line);
    if (key === null || !isCatalogueKey(key)) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a torn line is not a verdict; the ledger's own writer is single-writer and locked
    }
    if (typeof row.key !== "string" || typeof row.verdict !== "string" || typeof row.console_sha !== "string") continue;
    rowsNamingAKey++;
    if (typeof row.served_console_build === "object" && row.served_console_build !== null) {
      excludedEstateBuild++;
      continue;
    }
    if (!isCurrent(row)) {
      excludedStaleBuild++;
      continue;
    }
    const prev = standing.get(row.key);
    if (laterWins({ ts: row.ts, seq: rowsNamingAKey }, prev)) standing.set(row.key, { ...row, seq: rowsNamingAKey });
  }
  const passing = [];
  const failing = [];
  for (const [key, row] of standing) (PASSING_VERDICTS.has(row.verdict) ? passing : failing).push({ key, verdict: row.verdict, ts: row.ts });
  const byKey = (a, b) => a.key.localeCompare(b.key);
  passing.sort(byKey);
  failing.sort(byKey);
  return { passing, failing, rowsNamingAKey, excludedStaleBuild, excludedEstateBuild, driven: passing.length };
}
