// Every coarse restore-test reason the engine can emit must have a phrase in the console.
//
// WHY THIS EXISTS
// ---------------
// The engine added a ninth coarse code, format-unsupported, to end a conflation that had been telling a
// customer their backup failed an integrity check when the archive was refused only because the reader was
// a different build. The console labelled six of the nine, so the new code fell through the default arm
// and read as "the recovery check failed". The bytes were intact and nothing had failed a check.
//
// The comment above the switch said the vocabulary "mirrors the engine's restore-reasons.ts codes
// exactly". It did not, and it had not for as long as the ninth code existed. A comment asserting parity
// with another repository, with nothing checking it, is what let the drift sit: it tells the next reader
// not to look.
//
// So the parity is checked here rather than asserted there.
//
// WHAT IT CHECKS
// --------------
// It reads RESTORE_TEST_REASON_CODES out of the engine's restore-reasons.ts, and requires a literal case
// arm in restoreTestReasonPhrase for every member. It checks DECLARATION, not wording: what a phrase says
// is a judgement about a customer, and a missing arm is never a decision anyone made.
//
// It also refuses a phrase that is byte-identical to the default, because an arm that renders exactly what
// the fall-through renders is the same silence with more lines. The one deliberate exception is
// recovery-check, whose phrase IS the default sentence by definition.
//
// WHY IT REFUSES RATHER THAN SKIPS WHEN THE ENGINE IS ABSENT
// ----------------------------------------------------------
// Its sibling validators skip, and that is right for them: the console must build without the engine
// beside it. This one refuses, at a distinct exit code, and the reason is the defect it was written for.
// A skip here reports the same green as a pass, on the exact question the console has already been wrong
// about once. This workspace has ten recorded gates that passed because they could not check, and the
// standing rule from `make lint` in the reader repo is the one followed here: announce the mandatory skip
// and FAIL rather than pass silently. A caller that genuinely has no engine gets exit 2 and a sentence
// saying so, which is distinguishable from both a pass and a finding.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.
//
//   node test/validate-restore-reason-vocabulary.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verdictCannotCheck, verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts
import { engineRoot } from "./engine-root.ts";

const HERE = new URL(".", import.meta.url).pathname;

/** The console's own source, which is always present. */
const HELPERS = resolve(HERE, "../src/screens/sources-downpipes/helpers.ts");

let failures = 0;
let checks = 0;

function fail(msg: string): void {
  failures += 1;
  console.error(`  FAIL ${msg}`);
}

function ok(msg: string): void {
  checks += 1;
  console.log(`  ok   ${msg}`);
}

const root = engineRoot();
if (root === null) {
  // Not a skip. See the header: a skip here is indistinguishable from a pass on the question this file
  // exists to answer.
  console.error("validate-restore-reason-vocabulary: REFUSED, the engine is not beside this checkout.");
  console.error("  This check compares the console's reason phrases against the engine's own closed list,");
  console.error("  so with no engine it cannot answer its question and will not report that it did.");
  console.error("  Point it at one with DOWNPIPES_ENGINE=/path/to/engine and re-run.");
  verdictCannotCheck();
}

const enginePath = resolve(root, "src/restore-reasons.ts");
const engineSrc = readFileSync(enginePath, "utf8");

// The engine declares the closed list on one line as a const assertion. Read the members rather than
// re-typing them, which is the whole point: a copy checked against a copy proves nothing.
const listMatch = engineSrc.match(/RESTORE_TEST_REASON_CODES\s*=\s*\[([^\]]*)\]/);
if (listMatch === null) {
  console.error(`validate-restore-reason-vocabulary: REFUSED, could not find RESTORE_TEST_REASON_CODES in ${enginePath}.`);
  console.error("  The engine's declaration shape changed. Fix this reader rather than dropping the check.");
  verdictCannotCheck();
}

const inner = listMatch[1] ?? "";
const codes = [...inner.matchAll(/"([^"]+)"/g)]
  .map((m) => m[1])
  .filter((c): c is string => typeof c === "string" && c !== "");

// An empty or one-member list means the parse degraded, not that the engine shrank. A floor here is the
// difference between "checked nine codes" and "checked nothing and said nothing".
if (codes.length < 5) {
  console.error(`validate-restore-reason-vocabulary: REFUSED, parsed only ${codes.length} code(s) from the engine.`);
  verdictCannotCheck();
}

const consoleSrc = readFileSync(HELPERS, "utf8");

// The phrase function only. Bounding the search stops an unrelated `case "integrity":` elsewhere in the
// file from satisfying this check, which is the assertion-satisfied-by-the-wrong-text shape.
const fnStart = consoleSrc.indexOf("export function restoreTestReasonPhrase");
if (fnStart === -1) {
  fail("restoreTestReasonPhrase is not exported from helpers.ts, so nothing renders a reason");
} else {
  const fnEnd = consoleSrc.indexOf("\n}", fnStart);
  const fnSrc = consoleSrc.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

  const defaultMatch = fnSrc.match(/default:\s*return\s*"([^"]*)"/);
  const defaultPhrase = defaultMatch === null ? null : defaultMatch[1];
  if (defaultPhrase === null) fail("restoreTestReasonPhrase has no default arm, so an unknown code would render nothing");
  else ok("restoreTestReasonPhrase has a default arm for an unknown code");

  for (const code of codes) {
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const arm = fnSrc.match(new RegExp(`case\\s*"${escaped}"\\s*:\\s*return\\s*"([^"]*)"`));
    if (arm === null) {
      fail(`the engine can emit "${code}" and restoreTestReasonPhrase has no case for it, so it renders the default`);
      continue;
    }
    ok(`"${code}" has its own phrase`);

    // recovery-check IS the default sentence by definition, so it is the one member allowed to match.
    if (code !== "recovery-check" && defaultPhrase !== null && (arm[1] ?? "") === defaultPhrase) {
      fail(`"${code}" renders a phrase byte-identical to the default, which is the fall-through with more lines`);
    }
  }

  ok(`compared ${codes.length} engine code(s) against the console's switch`);
}

verdictReached(failures, checks);
console.log(`\nVERDICT: ${failures === 0 ? "PASS" : "FAIL"} failures=${failures} checks=${checks} entry=validate-restore-reason-vocabulary.ts`);
process.exit(failures === 0 ? 0 : 1);
