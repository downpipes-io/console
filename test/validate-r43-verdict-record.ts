// R-43, second half: the coverage number CI enforces must come from a RESULT, and the file it reads that
// result from must not be able to go stale in silence.
//
// WHY THIS FILE EXISTS. test/validate-r43-ledger-scoring.ts covers the scorer that replaced the text scan.
// It left one hole, stated in its own commit message: harness/.gitignore:28 ignores ledger/*.jsonl, so
// console CI's Cross-repo job checks the harness repo out fresh and gets no runs. The result-grade
// number was enforced on a workstation and nowhere else, and the number CI enforced was still the corpus
// text scan. scripts/verdict-record.mjs closes that by DERIVING a committed record from the ledger.
//
// A derived artefact that goes stale silently is this campaign's commonest defect, so the rules below are
// asserted rather than described, and every case is one that was measured while building it or that a
// mutation of the code would break:
//
//   ONE ENTRY PER (key, console_sha), NOT PER KEY. The reader has to be able to drop a verdict whose code
//   has moved and then let an OLDER verdict stand. Collapsing to one entry per key at write time banks a
//   decision the reader is supposed to make, and the record would then answer differently on every
//   checkout that has edited a different file.
//
//   A DIGEST MISMATCH DROPS, IT DOES NOT DOWNGRADE. An entry whose file has moved is not a failure, it is
//   an absence, and the difference is the whole reason "graded and failed" and "never graded" are separate
//   numbers in the gate's report.
//
//   THE BYTES ARE THE CONTRACT. serialiseRecord carries no write timestamp, no writer HEAD and no absolute
//   path, so an unchanged ledger reproduces the committed bytes exactly and the staleness gate's red means
//   something. A single volatile field would make that gate fire on every run and it would be suppressed
//   within a day.
//
//   THE RECORD PATH AND THE LEDGER PATH MUST AGREE. The last case runs the same synthetic ledger through
//   standingVerdicts and through buildRecord + scoreRecord and asserts the same answer, which is what stops
//   the two drifting apart the next time one of them is edited.
//
// Run with: node test/validate-r43-verdict-record.ts
//
// House style: Australian English, no em dashes, no rule-of-three, precise claims, no AI attribution.

import { laterWins, standingVerdicts } from "../scripts/ledger-verdicts.mjs";
import { buildRecord, contentDigest, describeDisagreement, parseRecord, RECORD_SCHEMA, scoreRecord, serialiseRecord } from "../scripts/verdict-record.mjs";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const CATALOGUE = [
  { key: "sources.button.reattach", file: "src/screens/sources/tiers.ts" },
  { key: "keys.button.refresh", file: "src/screens/keys/panel.ts" },
  { key: "restore-flow.button.drill", file: "src/screens/restore/flow.ts" },
];
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

/** The content each (sha, file) held, as a synthetic object store. */
const BLOBS: Record<string, string> = {
  [`${SHA_A}:src/screens/sources/tiers.ts`]: "tiers v1",
  [`${SHA_B}:src/screens/sources/tiers.ts`]: "tiers v1", // byte-identical across the two commits, on purpose
  [`${SHA_A}:src/screens/keys/panel.ts`]: "panel v1",
  [`${SHA_B}:src/screens/keys/panel.ts`]: "panel v2",
  [`${SHA_A}:src/screens/restore/flow.ts`]: "flow v1",
  [`${SHA_B}:src/screens/restore/flow.ts`]: "flow v1",
};
const blobDigest = (sha: string, file: string) => {
  const c = BLOBS[`${sha}:${file}`];
  return c === undefined ? null : contentDigest(c);
};
/** The working tree under test: tiers and flow are still v1, the keys panel has moved to v2. */
const TREE: Record<string, string> = {
  "src/screens/sources/tiers.ts": "tiers v1",
  "src/screens/keys/panel.ts": "panel v2",
  "src/screens/restore/flow.ts": "flow v1",
};
const treeDigest = (file: string) => (TREE[file] === undefined ? null : contentDigest(TREE[file]));

type Row = Record<string, unknown>;
const line = (key: string, verdict: string, ts: string, console_sha: string, extra: Row = {}) => JSON.stringify({ key, verdict, ts, console_sha, ...extra });

console.log("R-43 committed verdict record");

// 1. One entry per (key, console_sha), keeping the LATEST row for each pair.
{
  const rec = buildRecord({
    lines: [
      line("sources.button.reattach", "CLEAN", "2026-07-31T06:07:38.077Z", SHA_A),
      line("sources.button.reattach", "CLEAN", "2026-07-31T06:18:49.272Z", SHA_A),
      line("sources.button.reattach", "CLEAN", "2026-07-31T12:40:10.216Z", SHA_B),
      line("sources.button.reattach", "DETECT", "2026-07-31T12:45:17.957Z", SHA_B),
    ],
    catalogueRows: CATALOGUE,
    blobDigest,
  });
  ok("four rows over two commits collapse to two entries", rec.verdicts.length === 2);
  const atA = rec.verdicts.find((v) => v.console_sha === SHA_A);
  const atB = rec.verdicts.find((v) => v.console_sha === SHA_B);
  ok("each entry is the latest row at its own commit", atA?.ts === "2026-07-31T06:18:49.272Z" && atB?.verdict === "DETECT");
  ok("and the entry carries the control's file and the digest of that file at that commit", atB?.file === "src/screens/sources/tiers.ts" && atB?.file_sha256 === contentDigest("tiers v1"));
  ok("counts state what was read rather than what survived", rec.counts.ledger_rows_naming_a_catalogue_key === 4 && rec.counts.keys_graded === 1);
}

// 2. THE MEASURED CASE, which is why entries are per (key, sha) and why currency is content and not
//    ancestry. sources.button.reattach is graded at two commits against a byte-identical tiers.ts. The
//    later commit's verdict is a DETECT. A rule that dropped the later commit because it never landed
//    would let the earlier CLEAN stand and report the control as proven, which is R-43 one level down.
{
  const rec = buildRecord({
    lines: [
      line("sources.button.reattach", "CLEAN", "2026-07-31T06:18:49.272Z", SHA_A),
      line("sources.button.reattach", "DETECT", "2026-07-31T12:45:17.957Z", SHA_B),
    ],
    catalogueRows: CATALOGUE,
    blobDigest,
  });
  const s = scoreRecord({ record: rec, catalogueRows: CATALOGUE, treeDigest });
  ok("a later FAILING verdict over byte-identical code is the standing one", s.driven === 0 && s.failing.length === 1 && s.failing[0]?.verdict === "DETECT");
}

// 3. A digest that no longer matches the working tree DROPS the entry. It does not count as a failure, and
//    it does not keep counting as a pass.
{
  const rec = buildRecord({
    lines: [line("keys.button.refresh", "CLEAN", "2026-07-31T01:00:00.000Z", SHA_A)],
    catalogueRows: CATALOGUE,
    blobDigest,
  });
  const s = scoreRecord({ record: rec, catalogueRows: CATALOGUE, treeDigest });
  ok("a verdict graded against a file the tree no longer has is dropped", s.driven === 0 && s.failing.length === 0 && s.graded === 0);
  ok("and the drop is counted, so the exclusion is printable rather than silent", s.staleCode === 1);
}

// 4. And the drop lets an OLDER, still-matching verdict stand. This is the behaviour that one entry per key
//    would have made impossible.
{
  const rec = buildRecord({
    lines: [
      line("keys.button.refresh", "CLEAN", "2026-07-31T01:00:00.000Z", SHA_B), // panel v2, matches the tree
      line("keys.button.refresh", "DETECT", "2026-07-31T02:00:00.000Z", SHA_A), // panel v1, no longer here
    ],
    catalogueRows: CATALOGUE,
    blobDigest,
  });
  const s = scoreRecord({ record: rec, catalogueRows: CATALOGUE, treeDigest });
  ok("a stale later verdict does not suppress a current earlier one", s.driven === 1 && s.staleCode === 1);
}

// 5. An estate-graded row is excluded at derivation and counted. harness R-18: console_sha names the test
//    machine's checkout, not what the estate served, so nothing downstream can judge its currency.
{
  const rec = buildRecord({
    lines: [line("restore-flow.button.drill", "CLEAN", "2026-07-31T01:00:00.000Z", SHA_A, { served_console_build: { version: "0.1.10" } })],
    catalogueRows: CATALOGUE,
    blobDigest,
  });
  ok("an estate-graded row is not in the record", rec.verdicts.length === 0 && rec.counts.ledger_rows_excluded_estate_build === 1);
}

// 6. A blob the writer cannot read is a REFUSAL, not a null. Writing the entry with a null digest would
//    convert that verdict into a permanent stale one and the number would fall for a reason nobody could
//    name.
{
  const rec = buildRecord({
    lines: [line("restore-flow.button.drill", "CLEAN", "2026-07-31T01:00:00.000Z", "c".repeat(40))],
    catalogueRows: CATALOGUE,
    blobDigest,
  });
  ok("an unreadable blob is reported, not persisted as a null digest", rec.verdicts.length === 0 && rec.unresolvable.length === 1);
  ok("and the refusal names the pair it could not read", rec.unresolvable[0]?.key === "restore-flow.button.drill");
}

// 7. A key the catalogue does not have contributes nothing and is counted. The ledger is full of
//    field-smoke rows keyed "file::control" and none of them may reach the record or the score.
{
  const rec = buildRecord({
    lines: [line("src/screens/costs/inputs-section.ts::cost-source", "CLEAN", "2026-07-31T01:00:00.000Z", SHA_A)],
    catalogueRows: CATALOGUE,
    blobDigest,
  });
  ok("a non-catalogue key never enters the record", rec.verdicts.length === 0 && rec.counts.ledger_rows_naming_a_catalogue_key === 0);
  const orphan = { schema: RECORD_SCHEMA, verdicts: [{ key: "gone.button.away", console_sha: SHA_A, ts: "2026-07-31T01:00:00.000Z", verdict: "CLEAN", seq: 0, file: "src/gone.ts", file_sha256: contentDigest("x") }] };
  const s = scoreRecord({ record: orphan, catalogueRows: CATALOGUE, treeDigest });
  ok("a record entry the catalogue has since dropped scores nothing and is counted", s.driven === 0 && s.orphanKey === 1);
}

// 8. A control the catalogue now files elsewhere is a stale verdict, not a current one: the record's own
//    `file` cell must still be the catalogue's.
{
  const moved = { schema: RECORD_SCHEMA, verdicts: [{ key: "keys.button.refresh", console_sha: SHA_A, ts: "2026-07-31T01:00:00.000Z", verdict: "CLEAN", seq: 0, file: "src/screens/keys/old-panel.ts", file_sha256: contentDigest("panel v2") }] };
  const s = scoreRecord({ record: moved, catalogueRows: CATALOGUE, treeDigest });
  ok("a refiled control's old verdict scores nothing and is counted", s.driven === 0 && s.movedFile === 1);
}

// 9. The bytes are the contract, so nothing volatile may be in them.
{
  const build = () =>
    buildRecord({
      lines: [line("sources.button.reattach", "CLEAN", "2026-07-31T06:18:49.272Z", SHA_A)],
      catalogueRows: CATALOGUE,
      blobDigest,
    });
  const a = serialiseRecord(build());
  const b = serialiseRecord(build());
  ok("two derivations of the same ledger produce identical bytes", a === b);
  ok("and those bytes carry no timestamp of their own writing", !/stamped|written_at|generated_at/i.test(a));
  ok("and no absolute path", !a.includes("/Users/") && !a.includes("/home/"));
  ok("the record ends in a newline, so a diff is a diff and not a no-eol marker", a.endsWith("}\n"));
}

// 10. THE STALENESS GATE'S TEETH. Each mutation of a committed record must be REPORTED, because a record
//     that disagrees with its ledger is the exact failure mode this whole mechanism exists to prevent.
{
  const fresh = buildRecord({
    lines: [
      line("sources.button.reattach", "CLEAN", "2026-07-31T06:18:49.272Z", SHA_A),
      line("restore-flow.button.drill", "DETECT", "2026-07-31T07:00:00.000Z", SHA_A),
    ],
    catalogueRows: CATALOGUE,
    blobDigest,
  });
  const clone = () => JSON.parse(serialiseRecord(fresh));

  ok("an unmutated record disagrees about nothing", describeDisagreement(clone(), fresh).length === 0);

  const flipped = clone();
  flipped.verdicts[0].verdict = "CLEAN";
  flipped.verdicts[1].verdict = "CLEAN"; // the mutation that matters: a failure edited into a pass
  ok("a verdict edited from DETECT to CLEAN is caught", describeDisagreement(flipped, fresh).some((f: string) => f.includes("verdict")));

  const invented = clone();
  invented.verdicts.push({ key: "keys.button.refresh", console_sha: SHA_B, ts: "2026-07-31T09:00:00.000Z", verdict: "CLEAN", seq: 99, file: "src/screens/keys/panel.ts", file_sha256: contentDigest("panel v2") });
  ok("an invented entry is caught as one the ledger does not have", describeDisagreement(invented, fresh).some((f: string) => f.includes("the ledger does not")));

  const removed = clone();
  removed.verdicts = removed.verdicts.filter((v: { key: string }) => v.key !== "restore-flow.button.drill");
  ok("a deleted FAILING entry is caught as one the ledger has", describeDisagreement(removed, fresh).some((f: string) => f.includes("the ledger has a verdict the record does not")));

  const redigested = clone();
  redigested.verdicts[0].file_sha256 = contentDigest("something else entirely");
  ok("a hand-changed digest is caught", describeDisagreement(redigested, fresh).some((f: string) => f.includes("file_sha256")));

  const recounted = clone();
  recounted.counts.keys_graded = 400;
  ok("a hand-inflated count is caught", describeDisagreement(recounted, fresh).some((f: string) => f.includes("counts.keys_graded")));
}

// 11. parseRecord refuses rather than defaulting, and the ZERO case is the one that matters: a record with
//     no entries has no failures, so a gate reading it would report an empty measurement as a clean one.
{
  ok("unparseable text is refused", parseRecord("{not json").ok === false);
  ok("an unrecognised schema is refused", parseRecord(JSON.stringify({ schema: "something/else@9", verdicts: [{}] })).ok === false);
  ok("a missing verdicts array is refused", parseRecord(JSON.stringify({ schema: RECORD_SCHEMA })).ok === false);
  const empty = parseRecord(JSON.stringify({ schema: RECORD_SCHEMA, verdicts: [] }));
  ok("a record holding ZERO verdicts is refused rather than scored as clean", empty.ok === false && !empty.ok && empty.why.includes("ZERO"));
  const shapeless = parseRecord(JSON.stringify({ schema: RECORD_SCHEMA, verdicts: [{ key: "k", verdict: "CLEAN" }] }));
  ok("an entry missing the digest a reader scores on is refused", shapeless.ok === false);
  const good = buildRecord({ lines: [line("sources.button.reattach", "CLEAN", "2026-07-31T06:18:49.272Z", SHA_A)], catalogueRows: CATALOGUE, blobDigest });
  ok("a derived record parses", parseRecord(serialiseRecord(good)).ok === true);
}

// 12. The tie-break that makes the two iteration orders agree. The ledger is read in append order and the
//     record in sorted order, so "later ts wins, and on an equal ts the earlier ledger row wins" has to be
//     one shared rule rather than a `>` that happens to work in one of them.
const EARLY = "2026-07-31T01:00:00.000Z";
const LATE = "2026-07-31T02:00:00.000Z";
ok("a later ts wins", laterWins({ ts: LATE, seq: 9 }, { ts: EARLY, seq: 0 }));
ok("an equal ts breaks to the earlier ledger row", laterWins({ ts: EARLY, seq: 0 }, { ts: EARLY, seq: 9 }));
ok("and does not break to the later one", !laterWins({ ts: EARLY, seq: 9 }, { ts: EARLY, seq: 0 }));
ok("no incumbent means the candidate stands", laterWins({ ts: EARLY, seq: 3 }, undefined));

// 13. The record path and the ledger path answer the same question the same way. This is the case that
//     would catch the two drifting apart, which is what happens to a snapshot and its source over time.
{
  const lines = [
    line("sources.button.reattach", "CLEAN", "2026-07-31T06:18:49.272Z", SHA_A),
    line("sources.button.reattach", "DETECT", "2026-07-31T12:45:17.957Z", SHA_B),
    line("keys.button.refresh", "CLEAN", "2026-07-31T01:00:00.000Z", SHA_B),
    line("keys.button.refresh", "DETECT", "2026-07-31T02:00:00.000Z", SHA_A),
    line("restore-flow.button.drill", "HANDLED", "2026-07-31T03:00:00.000Z", SHA_A),
  ];
  const fileOf = new Map(CATALOGUE.map((r) => [r.key, r.file]));
  const direct = standingVerdicts({
    lines,
    isCatalogueKey: (k: string) => fileOf.has(k),
    isCurrent: (row: Record<string, unknown>) => {
      const file = fileOf.get(String(row.key));
      return file !== undefined && blobDigest(String(row.console_sha), file) === treeDigest(file);
    },
  });
  const viaRecord = scoreRecord({ record: buildRecord({ lines, catalogueRows: CATALOGUE, blobDigest }), catalogueRows: CATALOGUE, treeDigest });
  ok("both paths report the same DRIVEN count", direct.driven === viaRecord.driven);
  ok("both paths report the same passing keys", JSON.stringify(direct.passing.map((p) => p.key)) === JSON.stringify(viaRecord.passing.map((p) => p.key)));
  ok("both paths report the same failing keys", JSON.stringify(direct.failing.map((p) => p.key)) === JSON.stringify(viaRecord.failing.map((p) => p.key)));
  ok("and the answer is the one the fixtures were built for", viaRecord.driven === 2 && viaRecord.failing.length === 1 && viaRecord.failing[0]?.key === "sources.button.reattach");
}

console.log(failures === 0 ? "\nR-43 committed verdict record: OK\n" : `\nR-43 committed verdict record: ${failures} FAILURE(S)\n`);
verdictReached(failures);
process.exit(failures === 0 ? 0 : 1);
