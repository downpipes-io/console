// Max-lines guardrail (npm run lint:size, chained into npm run lint) -- keeps production
// modules decomposable. Splitting a god-module by hand (api client, screens, demo-engine.ts,
// destination-cards.ts) does not stop it regrowing on its own. This catches the next accretion
// at review time.
//
// A src file over DEFAULT_MAX must either be split along its module seams (the client-*.ts,
// screens/*/ and demo-*.ts families show the house idioms) or be added to EXEMPT below with a
// rationale and a per-file ceiling, so a deliberate big file cannot creep unbounded either.
// Stale exemptions (file back under the default) fail too: remove them.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const DEFAULT_MAX = 1000; // the console's feature modules outgrew the original 800-line budget as they matured

// path (POSIX, relative to repo root) -> [ceiling, rationale]
const EXEMPT = new Map([
  ["src/lib/demo/demo-seed.ts", [1690, "the pure demo-world data catalogue (buildSeed); flat labelled data domains, no logic to untangle"]],
  ["src/lib/demo/tour/director.ts", [1250, "one tight autoplay state machine over shared closure state; splitting means a real redesign. Raised 1100 to 1250 for the training walk's task gate (armTask/taskBlocksAdvance/worldTransform), which reads the same closure state (renderToken, idx, beatIdx, playing) as the autoplay machine and would need that state re-plumbed through an interface to live elsewhere"]],
  [
    "src/screens/restore-flow/confirm.ts",
    [
      1183,
      "the restore apply gate: the client mirror of the engine's dual-control control (D2/D3), plus the approval gate's whole lifecycle in one place. The restore-approval policy is owner-opt-in, so this screen asks the policy before the approvals read and arms Apply directly when no approver is required; without that branch the engine would accept a solo apply while this screen refuses to offer one, a half-landed shape the design avoids. The branch belongs HERE because arming is decided here; moving it out would split one decision across two files. Thirteen of those lines are a comment, kept deliberately: it records that a promise .catch cannot defend a call that fails BEFORE it returns a promise, the defect it replaced, which had collapsed four gate-block classes into one generic state. Deleting the record to fit a budget would trade the evidence for the number. Set EXACTLY at the file's size rather than with headroom, because a ceiling with room to grow is a ratchet that stops ratcheting."
    ],
  ],
  [
    "src/lib/client-diag/vocab.ts",
    [
      2601,
      "the frozen closed vocabulary, and the TWIN of the engine's single src/admin/client-diag-vocab.ts; the drift gate compares the two list for list, so splitting one side and not the other breaks the symmetry the gate exists to hold. Almost all of the length is the per-member rationale (why this class, why it discriminates, why the noisy neighbour is NOT a member), which is the artefact itself. A member removed for having NO PRODUCER keeps its comment explaining why, so a future author does not re-add it: dead vocabulary reads like coverage and is worse than an honest absence. The reason the file grows rather than splits is the whole point of the twin: a member on one side and not the other is a row the engine DROPS on arrival, silently. The ceiling is set at the file's exact length, with no headroom: headroom is what lets a file cross its ceiling in a commit that never has to say why, so zero headroom costs the next author one line in this table and forces the argument that any further growth needs to make.",
    ],
  ],
  [
    "src/lib/client-diag/ring.ts",
    [
      1987,
      "the ring's write boundary: tupleKey(), push() and snapshot() must each enumerate EVERY closed field, and must be readable side by side, because a field present in one list and not the others is silently dropped from the pack. The classifiers each carry the argument for their own ordering -- destProbeOutcome must test deleteProbe BEFORE ok (the engine reports a refused delete on the ok:TRUE arm, so the other order makes the WORM state unreachable), and featureOutcomeForError must classify by KIND before status (an Access-fenced console answers a lapsed session with a login page, not a 401). Both are one-line orderings whose reversal is invisible in a diff and fatal to the evidence. It also holds producers such as recordDeepLinkLost (the router.notFound producer) and bulkReasonForFailures, which splits a batch the engine REFUSED from a batch that died on an OUTAGE -- opposite remedies a counts-only classifier would fold into one row. Each field carries the reason it exists, which is the paragraph a future author needs and the first thing a split would scatter. recordBulkOutcome takes BOTH discriminators (the bulk ACTION, which says which loop, and the cause-classified reason, which says why) because neither is derivable from the other. cfSurfaceListThrowClass, the twin of cfRediscoverThrowClass, exists because the FAILING catalogue read had no classifier at all, so the wizard and the editor both wrote one member for seven states, two of which (a lapsed Access session and a 401) must write no row; the classifier lives beside its twin on purpose, with the argument for why a 403 must be read by the SHAPE of its refusal body rather than by its status. Pinned at the file's exact length, no headroom, for the same reason given on the twin exemption above. The prose above wraps to four more lines than it once did, and the ceiling now names that measured length rather than the wrap width it happened to have before.",
    ],
  ],
]);

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|js|mjs)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

// A floor on how many files were actually measured. Without it the OK line below is printed just as
// happily over an empty walk, and the only thing standing between that and a green build is the
// stale-exemption loop, which speaks for the 4 files in EXEMPT and for nothing else: change the
// extension test above, or move src/, and the other several hundred files go unmeasured while the gate
// still reports every src file within budget. The floor is 200, comfortably below the real file count, so
// a real round of deletions does not trip it and a collapse cannot pass. Read before the loop, so the
// count is the one the loop will use.
const walked = walk(SRC, []);
if (walked.length < 200) {
  console.error(`\n[max-lines] FAIL -- measured ${walked.length} file(s) under src, expected at least 200. The walk is not reading the console's source, so "within budget" would be a statement about nothing.\n`);
  process.exit(1);
}

const failures = [];
const seen = new Set();
/**
 * SLACK_TOLERANCE is how far an exemption's ceiling may sit ABOVE its file before that gap is itself a
 * finding. It closes a blind spot: the stale-exemption branch below fires only when a file drops back
 * under DEFAULT_MAX, so a ceiling that is merely GENEROUS is never compared against its file at all.
 * Mutation-proved here: a ceiling one under the size REDS, an exact ceiling passes, and a ceiling far
 * above an actual file size passes SILENTLY.
 *
 * demo-seed.ts is why it matters rather than a hypothetical: a ceiling pinned with room in it lets the
 * file grow inside that room, entirely unreported, for as long as the room lasts.
 *
 * NOT ZERO, deliberately: at zero a file shrinking by one line reds the tree. Chosen from the data, and
 * kept identical to engine's so the twin gates cannot drift apart on the number.
 */
const SLACK_TOLERANCE = 50;

/**
 * The whole per-file decision as a pure function, so --self-test can drive every branch with no
 * filesystem. Order is load-bearing: a file both under the default AND far under its ceiling reports as a
 * STALE exemption, the stronger statement, whose remedy subsumes the other.
 */
export function classifyExemption(lines, ceiling, defaultMax = DEFAULT_MAX, tolerance = SLACK_TOLERANCE) {
  if (ceiling === undefined) return lines > defaultMax ? "over-default" : null;
  if (lines > ceiling) return "over-ceiling";
  if (lines <= defaultMax) return "stale-exemption";
  if (ceiling - lines > tolerance) return "slack";
  return null;
}

if (process.argv.includes("--self-test")) {
  const cases = [
    ["a file over its ceiling is a finding", classifyExemption(1200, 1100), "over-ceiling"],
    ["a file exactly at its ceiling is fine", classifyExemption(1100, 1100), null],
    ["A GENEROUS CEILING IS A FINDING (the blind spot this closes)", classifyExemption(1100, 1400), "slack"],
    ["a ceiling within tolerance is ordinary drift", classifyExemption(1364, 1400), null],
    ["tolerance is exclusive: exactly at it passes", classifyExemption(1050, 1100), null],
    ["one line past tolerance does not", classifyExemption(1049, 1100), "slack"],
    ["a file back under the default is stale, even with slack", classifyExemption(900, 1400), "stale-exemption"],
    ["an unexempted file over the default is a finding", classifyExemption(1200, undefined), "over-default"],
    ["an unexempted file under the default is fine", classifyExemption(900, undefined), null],
  ];
  let bad = 0;
  for (const [name, got, want] of cases) {
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
  }
  console.log(`[max-lines] self-test: ${cases.length} case(s), ${bad} failure(s)`);
  process.exit(bad ? 1 : 0);
}

/** @type {Array<[string, number, number, number]>} */
const slackRows = [];
for (const abs of walked) {
  const rel = relative(ROOT, abs).split("\\").join("/");
  const lines = (readFileSync(abs, "utf8").match(/\n/g) ?? []).length;
  const exempt = EXEMPT.get(rel);
  if (exempt) {
    seen.add(rel);
    const [ceiling] = /** @type {[number, string]} */ (exempt);
    slackRows.push([rel, ceiling, lines, ceiling - lines]);
    const verdict = classifyExemption(lines, ceiling);
    if (verdict === "over-ceiling") failures.push(`${rel}: ${lines} lines exceeds its exemption ceiling of ${ceiling} -- split it, or consciously raise the ceiling with a rationale`);
    else if (verdict === "stale-exemption") failures.push(`${rel}: ${lines} lines is back under the default ${DEFAULT_MAX} -- remove its stale exemption`);
    else if (verdict === "slack") failures.push(`${rel}: ceiling ${ceiling} sits ${ceiling - lines} lines above the file's ${lines} -- room this gate cannot see the file grow into. Tighten it to ${lines}, or argue for the gap`);
  } else if (lines > DEFAULT_MAX) {
    failures.push(`${rel}: ${lines} lines exceeds the default ${DEFAULT_MAX} -- split along module seams, or add an exemption with a rationale`);
  }
}
for (const rel of EXEMPT.keys()) {
  if (!seen.has(rel)) failures.push(`${rel}: exempted but no longer exists -- remove its exemption`);
}

if (failures.length) {
  console.error(`\n[max-lines] ${failures.length} file(s) over budget:\n  ${failures.join("\n  ")}\n`);
  process.exit(1);
}
// THE SLACK TABLE PRINTS ON EVERY RUN, PASS OR FAIL, worst first. A number nobody sees is a number nobody
// tightens, and this gate's whole failure mode was a gap that never appeared in its output.
if (slackRows.length) {
  const worst = [...slackRows].sort((a, b) => b[3] - a[3]);
  const total = worst.reduce((n, r) => n + Math.max(r[3], 0), 0);
  console.log(`[max-lines] exemption slack, worst first (tolerance ${SLACK_TOLERANCE}, total ${total} line(s)):`);
  for (const [rel, ceiling, lines, slack] of worst) {
    console.log(`  ${slack === 0 ? "exact " : `${String(slack).padStart(5)} `} ${rel} (ceiling ${ceiling}, file ${lines})`);
  }
}
console.log(`[max-lines] OK -- all ${walked.length} src files within budget (default ${DEFAULT_MAX}, ${EXEMPT.size} pinned exemptions)`);
