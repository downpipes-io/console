#!/usr/bin/env node
// Destination-provenance gate: no console surface may decide "is there a destination" from
// listDestinations() alone.
//
// THE DRIFT THIS CLOSES, measured live on the harness warm estate. GET /admin/destinations answers
// {"destinations":[],"defaultId":null} while GET /admin/status answers destConfigured:true,
// destKind:"r2". Both are correct and they answer different questions: /admin/destinations lists only
// the CONSOLE-SET destinations (engine src/admin/router-destinations.ts, "GET /destinations lists every
// console-set destination"), whereas destConfigured means "the engine can resolve a destination at
// all", which a DEPLOY-TIME env binding satisfies. The engine already names the provenance itself:
// GET /admin/destination returns {present:false, source:"deploy", envConfigured:true, envKind:"r2"}
// and GET /admin/setup-state returns destination.source of "console", "deploy" or null.
//
// So the engine is not wrong. The failure mode is entirely on this side: a console surface that reads
// listDestinations(), sees an empty array and concludes there is no destination will tell a customer
// with a perfectly good deploy-time R2 bucket that their data has nowhere to go. That is the shape of
// bug this gate refuses to let back in silently.
//
// WHAT IT CHECKS. Every file under src/ that calls listDestinations( must be CLASSIFIED below, and each
// classification is itself checked rather than taken on trust where it can be:
//
//   1. UNCLASSIFIED CALLER: a file calls listDestinations( and has no row here. Fails. A new caller
//      cannot land without its author saying, in this file, how it handles the deploy-time case.
//   2. STALE ROW: a row names a file that no longer calls listDestinations(. Fails. An allowlist that
//      quietly outlives its subject is how these files become decorative.
//   3. UNPROVEN "reconciles" ROW: a row claiming the caller reconciles the deploy-time case must be
//      able to point at a reconciler in that same module (getDestination, envConfigured, destConfigured
//      or destinationSummary). Fails otherwise, so the claim is grounded in the code rather than in the
//      row's own prose.
//
// A row classified "no-existence-decision" carries a written reason and is taken at its word, because
// "this branch is a picker, not an existence test" is a judgement a regex cannot make. Rule 2 still
// stops it going stale, and the reason is visible to the next reader.
//
// COMMENTS ARE STRIPPED, and that is the right way round here. Every check is MUST-BE-PRESENT (a call
// must be classified, a claimed reconciler must exist), so reading a commented-out call as real would
// only ever demand a row for a caller that does not exist, and reading a commented-out reconciler as
// real would let an unproven claim pass. blankComments (scripts/source-text.mjs) is length-preserving
// and fails loud on an unterminated string, so line numbers still line up.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { blankComments } from "./source-text.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const CALL = "listDestinations(";

// The deploy-time reconcilers: a module that reads any of these has seen the env destination, which is
// the whole point. getDestination is the direct read (present / source / envConfigured / envKind);
// destConfigured and destinationSummary come off the status report, which folds env in the same way.
const RECONCILERS = ["getDestination", "envConfigured", "destConfigured", "destinationSummary"];

// The classification of every listDestinations( caller in src/.
//   kind "reconciles"            -> the module consults the deploy-time destination as well (checked).
//   kind "no-existence-decision" -> the module never treats an empty list as "no destination" (reasoned).
const CLASSIFIED = [
  {
    file: "src/screens/destinations.ts",
    kind: "reconciles",
    why: "The empty list falls through to getDestination() and renders the deploy-time posture card, so an env destination is shown rather than the first-time setup form.",
  },
  {
    file: "src/screens/sources-downpipes/editor-wizard.ts",
    kind: "reconciles",
    why: "destStep/destLine are decided by getDestination(): present, else envConfigured (named by kind), else unset. The empty collection only means there is no picker to show.",
  },
  {
    file: "src/screens/sources-downpipes/detail-config-section.ts",
    kind: "reconciles",
    why: "A downpipe that follows the default with no console-set destination in the list falls back to destinationSummary(status), which reads destKind/destConfigured.",
  },
  {
    file: "src/screens/map/data.ts",
    kind: "reconciles",
    why: "The map takes getDestination() and the collection side by side; the destination node is drawn from status destKind/destConfigured, and the collection only names extra fan-out edges.",
  },
  {
    file: "src/screens/sources-downpipes/editor-destination-section.ts",
    kind: "no-existence-decision",
    why: "Branches on length > 1 only, to decide whether a fan-out picker is worth showing. One destination or none renders no picker, which is right for a deploy-time destination the customer cannot pick between.",
  },
  {
    file: "src/screens/sources/tiers.ts",
    kind: "no-existence-decision",
    why: "Same length > 1 fan-out picker as the editor's destination section, on the bulk-protect tier.",
  },
  {
    file: "src/screens/costs/view.ts",
    kind: "no-existence-decision",
    why: "seedPricingFromDestinations only PREFILLS rates. An empty list returns early and leaves the single R2 preset in place, which is the correct estimate for a deploy-time R2 destination, so no existence claim is made to the customer.",
  },
  {
    file: "src/screens/command-palette/entity-append.ts",
    kind: "no-existence-decision",
    why: "Feeds the palette's searchable entity set. An empty list means nothing to search, never a claim that no destination exists.",
  },
];

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL ${msg}`);
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

// callersOf returns the src-relative files whose CODE (comments stripped) calls listDestinations(.
// src/lib/api is excluded: that is where the client method is DECLARED and called through, not a
// surface that decides anything for a customer.
function callersOf(files) {
  const found = new Set();
  for (const abs of files) {
    const rel = relative(ROOT, abs).split("\\").join("/");
    if (rel.startsWith("src/lib/api/")) continue;
    if (blankComments(readFileSync(abs, "utf8")).includes(CALL)) found.add(rel);
  }
  return found;
}

function check(callers, readCode) {
  const rows = new Map(CLASSIFIED.map((r) => [r.file, r]));
  for (const file of [...callers].sort()) {
    if (!rows.has(file)) {
      fail(
        `${file} calls listDestinations() and is not classified in dest-provenance-gate.mjs.\n` +
          "    An empty destinations list does NOT mean there is no destination: a deploy-time env destination\n" +
          "    never appears in that list (the engine reports it through GET /admin/destination as\n" +
          "    envConfigured/envKind, and through status as destConfigured/destKind). Add a row saying how this\n" +
          '    module handles that case: "reconciles" if it consults the deploy-time destination too, or\n' +
          '    "no-existence-decision" with the reason it never reads an empty list as "no destination".',
      );
    }
  }
  for (const row of CLASSIFIED) {
    if (!callers.has(row.file)) {
      fail(
        `${row.file} is classified in dest-provenance-gate.mjs but no longer calls listDestinations().\n` +
          "    Remove the stale row, so this list keeps describing the code rather than the code it used to describe.",
      );
      continue;
    }
    if (row.kind !== "reconciles") continue;
    const code = readCode(row.file);
    if (!RECONCILERS.some((r) => code.includes(r))) {
      fail(
        `${row.file} is classified "reconciles" but names none of the deploy-time reconcilers ` +
          `(${RECONCILERS.join(", ")}).\n` +
          "    Either it stopped consulting the deploy-time destination, in which case a customer with an env\n" +
          "    destination is about to be told they have none, or the row is wrong and should be reclassified.",
      );
    }
  }
}

// ---- self-test: prove each rule fires, and prove it does not fire on the passing shape.
//
// THE FLAG IS --self-test. source-text.mjs, which this file imports, checks isEntryModule(import.meta.url)
// from scripts/entry-module.mjs before running its own self-test, so importing it here with --self-test on
// the command line does not hijack this block or exit before it runs. A flag that silently did nothing
// would be the same class of quiet this self-test exists to prevent.
if (process.argv.includes("--self-test")) {
  let bad = 0;
  const expect = (name, got, want) => {
    if (got === want) console.log(`  ok   ${name}`);
    else {
      bad += 1;
      console.error(`  FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };
  const run = (callers, code) => {
    const before = failures;
    const errs = [];
    const realError = console.error;
    console.error = (m) => errs.push(String(m));
    check(new Set(callers), (f) => code[f] ?? "");
    console.error = realError;
    const n = failures - before;
    failures = before;
    return { n, errs };
  };
  const rows = CLASSIFIED.map((r) => r.file);
  const code = Object.fromEntries(CLASSIFIED.map((r) => [r.file, r.kind === "reconciles" ? "getDestination()" : ""]));

  expect("the classified set as written passes", run(rows, code).n, 0);
  expect("an unclassified caller fails", run([...rows, "src/screens/new-thing.ts"], code).n, 1);
  expect("a stale row fails", run(rows.slice(1), code).n, 1);
  expect(
    'a "reconciles" row with no reconciler in the module fails',
    run(rows, { ...code, "src/screens/destinations.ts": "listDestinations()" }).n,
    1,
  );
  expect(
    "a reconciler that is only mentioned in a COMMENT does not save the row",
    run(rows, { ...code, "src/screens/destinations.ts": blankComments("// getDestination() is called elsewhere\nlistDestinations();\n") }).n,
    1,
  );
  expect(
    "a caller that exists only in a COMMENT demands no row",
    callersOf([]).size === 0 && !blankComments("// engine.listDestinations();\n").includes(CALL),
    true,
  );
  if (bad > 0) {
    console.error(`\ndest-provenance: SELF-TEST FAILED, ${bad} case(s).`);
    process.exit(1);
  }
  console.log("ok   dest-provenance: self-test passed, every rule fires on its own break and the written set is clean.");
  process.exit(0);
}

const files = walk(SRC);
const callers = callersOf(files);
const cache = new Map();
const readCode = (rel) => {
  if (!cache.has(rel)) cache.set(rel, blankComments(readFileSync(join(ROOT, rel), "utf8")));
  return cache.get(rel);
};
check(callers, readCode);

if (failures > 0) {
  console.error(`\ndest-provenance: ${failures} finding(s).`);
  process.exit(1);
}
console.log(
  `ok   dest-provenance: all ${callers.size} listDestinations() caller(s) are classified, and every "reconciles" claim is grounded in its own module.`,
);
