#!/usr/bin/env node
// STEP-UP COPY GATE. The companion to scripts/stepup-call-site-gate.mjs, and it asserts the half that one
// cannot: that gate proves a sensitive write is WIRED to the ceremony, this one proves the operator is told
// something true when the ceremony does not complete.
//
// WHY THIS EXISTS. gatedFetch runs the re-auth on a 401 { stepUpRequired } and retries once. On a cancel,
// a dismissed prompt, no passkey on the device, or a ceremony that threw, runStepUp returns null and the
// transport surfaces the ORIGINAL 401 (client-transport.ts). failResponse folds that into
// "<verb>: stepup-required: 401" -- a marker token this console defines and a bare status. Any catch block
// that splices the raw message into customer copy therefore prints an internal constant, plus a 401 that
// reads as a lapsed session, at the exact moment describe()'s stepup-required case exists to say the session
// is still valid and the remedy is the passkey prompt.
//
// A HAND-MAINTAINED LIST DRIFTS, so nothing here is enumerated. The gated set is derived from
// the engine and the console's own client layer, in three steps:
//   1. every client function whose body calls t.gatedFetch (src/lib/api/client-*.ts);
//   2. every EngineClient method that delegates to one (src/lib/api/client.ts);
//   3. every try/catch in src/screens whose TRY body calls one of those methods.
// The catch bodies of exactly those try/catch pairs are the customer-visible surface of a failed ceremony,
// and they are the only thing this gate judges. A GET read, and an ungated sibling such as the reject leg
// beside a gated approve, are not gated writes and are not flagged: the gate answers the question it can
// decide rather than the one that is easy to grep.
//
// ONE HOP THROUGH A HELPER, because two of the leaks did not hold errText themselves. sessions-passkeys'
// refusedMessage and security-centre/access's retireRefuseText take the error and build the sentence, so a
// catch that calls one of them leaks exactly as if it had interpolated the message inline. A file-local
// function that takes an unknown/Error parameter and interpolates the raw message counts as a leak site for
// every catch that calls it.
//
// IT REFUSES RATHER THAN PASSES whenever it cannot check: no gatedFetch functions parsed, no EngineClient
// methods mapped, or no screen try/catch found against them. Each of those means the parse stopped matching,
// which is indistinguishable from a compliant console if a zero numerator is allowed to read as success.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveGatedSet, matchBlock, stripComments, walk } from "./stepup-gated-set.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCREENS = path.join(ROOT, "src/screens");

const failures = [];
const fail = (m) => failures.push(m);

// THE DERIVED SET, and the shared parsing, live in scripts/stepup-announce-gate.mjs's companion module
// scripts/stepup-gated-set.mjs so the two gates cannot drift apart on what "gated" means or on how a source
// file is read. This gate keeps the gatedFetch derivation deliberately: it asks whether a catch COULD print
// "<verb>: stepup-required: 401", and only a gatedFetch call site can, whatever the engine does with the
// route. Its sibling asks what the customer will SEE and therefore reads the engine instead.
//
// THE SHARED stripComments STRIPS A TRAILING LINE COMMENT AS WELL AS A LEADING ONE. Stripping only leading
// `//` comments lets a trailing comment survive, and a trailing comment containing an apostrophe can open a
// string literal that runs for thousands of characters and swallows every brace after it, which makes a
// brace-matching function scanner see zero functions in the file. Stripping comments once, in the shared
// module, closes that for every gate that reads source this way rather than in each gate separately.
const { gatedFns, gatedMethods, problems } = deriveGatedSet(ROOT);
for (const p of problems) fail(p);

// ---- the leak predicate ----------------------------------------------------------------------------------
// RAW_TEXT names the readers that hand back the engine client's thrown message verbatim. errText is the
// documented raw passthrough; err.message is the same thing written out longhand.
const RAW_TEXT = /\berrText\s*\(|\berr(?:or)?\s*\.\s*message\b/;
const GUARDED = /\bisStepUpRequired\s*\(|\bstepUpAwareText\s*\(/;

// leakyHelpers finds file-local functions that take an error and build a sentence out of its raw message.
// These are the one hop: a catch that calls one leaks exactly as if it had interpolated the message inline.
function leakyHelpers(src) {
  const names = new Set();
  const re = /(?:export\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    if (!/\b(?:unknown|Error)\b/.test(m[2])) continue;
    const block = matchBlock(src, re.lastIndex);
    if (block && RAW_TEXT.test(block.body) && !GUARDED.test(block.body)) names.add(m[1]);
  }
  return names;
}

let pairsChecked = 0;
const screenFiles = walk(SCREENS);
for (const file of screenFiles) {
  const src = stripComments(readFileSync(file, "utf8"));
  if (!/\btry\s*\{/.test(src)) continue;
  const helpers = leakyHelpers(src);
  const rel = path.relative(ROOT, file);

  const tryRe = /\btry\s*\{/g;
  for (let t = tryRe.exec(src); t !== null; t = tryRe.exec(src)) {
    const tryBlock = matchBlock(src, t.index);
    if (!tryBlock) continue;
    // The catch clause must follow the try block immediately (whitespace only).
    const after = src.slice(tryBlock.end);
    const c = /^\s*catch\s*\(([^)]*)\)\s*\{/.exec(after);
    if (!c) continue;
    const catchBlock = matchBlock(after, c.index);
    if (!catchBlock) continue;

    // Does this try perform a step-up-gated write?
    const gatedHere = [...gatedMethods].filter((m) => new RegExp(`\\.${m}\\s*\\(`).test(tryBlock.body));
    if (gatedHere.length === 0) continue;
    pairsChecked++;

    const body = catchBlock.body;
    const helperHit = [...helpers].filter((n) => new RegExp(`\\b${n}\\s*\\(`).test(body));
    const rawHere = RAW_TEXT.test(body);
    if (!rawHere && helperHit.length === 0) continue;
    if (GUARDED.test(body)) continue;

    const via = helperHit.length > 0 && !rawHere ? ` via ${helperHit.join(", ")}()` : "";
    fail(
      `${rel}: a catch on the step-up-gated write ${gatedHere.join(", ")}() renders the engine client's RAW message${via} with no isStepUpRequired branch. A cancelled ceremony prints "<verb>: stepup-required: 401" at the operator; use stepUpAwareText (src/components/error-view.ts) so that one state gets its own advice and every other keeps the engine's reason.`,
    );
  }
}

if (pairsChecked === 0) {
  fail("REFUSING TO PASS: found zero try/catch pairs in src/screens around a step-up-gated write. Either the screens stopped calling them or the brace matcher has stopped matching; a zero numerator is not compliance.");
}

const summary = `stepup-copy-gate: ${gatedFns.size} gatedFetch client fn(s) -> ${gatedMethods.size} EngineClient method(s) -> ${pairsChecked} guarded try/catch pair(s) across ${screenFiles.length} screen file(s)`;
if (failures.length > 0) {
  console.error(`${summary}\n`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  console.error(`\nstepup-copy-gate: ${failures.length} failure(s).`);
  process.exit(1);
}
console.log(`${summary}; 0 failures.`);
console.log("stepup-copy-gate: PASS -- no step-up-gated write surfaces the raw marker to the operator.");
