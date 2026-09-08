// AN ENGINE THAT ANSWERED MUST NEVER BE DESCRIBED AS AN ENGINE THAT COULD NOT BE REACHED.
//
// THE DEFECT THIS PINS. classifyError's
// final fall-through returned `network` for ANY throw carrying no HTTP status, and the comment above it stated
// a premise nothing tested: that no status means fetch itself threw. So a TypeError raised by the console's OWN
// render code, after a response that arrived and parsed, took the same branch. With every /admin read answering
// 200 with a well-formed body of the wrong shape, six routes (/credentials, /security/owner-actions,
// /access/roles, /access/roles/builder, /config/changes, /runs) rendered "Could not reach the engine" with a
// heading AND a remedy byte-identical to a genuinely aborted fetch.
//
// AND IT REACHED THE SUPPORT PACK, which is why the kind matters and a reworded sentence would not have been
// enough. components/error-view.ts fires recordNetworkBlock() for `network` and for nothing else; that probes
// GET /admin/health and banks classifyNetworkBlock's verdict. Health answers by construction on this path, so
// the banked class was `origin-rejected` and the pack prescribed setting CONSOLE_ORIGIN on an account whose
// CONSOLE_ORIGIN is correct.
//
// WHAT IS GRADED HERE, and it is the pair rather than either half. Every case declares the state it stands for
// and the answer it must not collide with:
//
//   REACHED     a throw that reads as a fetch failure. MUST stay `network`, MUST keep the "Could not reach the
//               engine" heading, and MUST keep its transport class, because a real outage is what that copy and
//               that pack row are for. THIS IS THE HALF A LAZY REPAIR BREAKS: the finding was "the two arms
//               agree", so anything that stops the outage arm saying it also makes them disagree and would read
//               as fixed. Every one of these cases exists to stop that reading.
//   ANSWERED    a throw that does not read as a fetch failure. MUST NOT be `network`, MUST NOT carry the
//               reachability heading or the address remedy, and MUST bank no transport class.
//
// THE COLLISION TEST IS EXPLICIT rather than implied by the case list: the two families' rendered headings are
// compared and an overlap fails, so a future edit that quietly merges the copy goes red here even if every
// individual case still passes.
//
// A READ IS NOT A GRADING, so the population is asserted: the run fails unless both families are non-empty and
// unless the case count matches the declared table. A file that graded nothing must not exit 0.
//
// Run with `node test/validate-answered-is-not-unreachable.ts`.

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { classifyError, looksLikeFetchFailure } from "../src/lib/errors.ts";
import { blockError, transportClassFor } from "../src/components/error-view.ts";

const NETWORK_HEADING = "Could not reach the engine";
const ADDRESS_REMEDY = "reachable on its custom domain";

interface Case {
  name: string;
  message: string;
  /** REACHED: the fetch got no response. ANSWERED: something came back, or nothing establishes that it did not. */
  family: "reached" | "answered";
}

// The reached wordings are the browsers' own (Chromium, WebKit, Firefox) plus the abort and timeout shapes,
// which got no answer either. The answered family is what the console's own code throws when it mishandles a
// response it already holds, which is the shape a version skew produces.
const CASES: readonly Case[] = [
  { name: "chromium fetch failure", message: "Failed to fetch", family: "reached" },
  { name: "webkit fetch failure", message: "Load failed", family: "reached" },
  { name: "firefox fetch failure", message: "NetworkError when attempting to fetch resource.", family: "reached" },
  { name: "webkit connection dropped", message: "The network connection was lost.", family: "reached" },
  { name: "webkit offline", message: "The Internet connection appears to be offline.", family: "reached" },
  { name: "aborted by a navigation", message: "The user aborted a request.", family: "reached" },
  { name: "timed out", message: "The operation timed out (TimeoutError)", family: "reached" },
  { name: "a verb-prefixed fetch failure", message: "get posture: Failed to fetch", family: "reached" },
  { name: "the render crash a wrong-shaped 200 produces", message: "Cannot read properties of undefined (reading 'filter')", family: "answered" },
  { name: "a null dereference on a renamed field", message: "Cannot read properties of null (reading 'checks')", family: "answered" },
  { name: "a mistyped field on a skewed build", message: "report.checks.filter is not a function", family: "answered" },
  { name: "a range error in the console's own maths", message: "Invalid array length", family: "answered" },
  { name: "a bare console throw with no wording at all", message: "boom", family: "answered" },
];

const DECLARED_CASES = 13;

let failures = 0;
let checks = 0;

function fail(why: string): void {
  failures += 1;
  console.error(`  FAIL ${why}`);
}

// must is the counting assertion, and the count is not decoration. This file is deliberately QUIET on a pass,
// so the console's verdict guard cannot infer from its output that it checked anything and requires a REAL
// check count rather than a guess. Every expectation below goes through here, so the number printed at the end
// is the number of comparisons actually made and a run that made none cannot print a reassuring zero.
function must(ok: boolean, why: string): void {
  checks += 1;
  if (!ok) fail(why);
}

// renderedOf paints the REAL component, so the grading is the sentence an operator reads rather than a tag.
//
// IT REFUSES AN EMPTY RENDER, and that clause is here because the first version of this file did not have it
// and PASSED WITH THIRTEEN CASES AND ZERO FAILURES WHILE COMPARING THE WRONG STRINGS. A validator that reads
// the wrong thing still reads something, so an empty heading or detail fails on the spot rather than quietly
// comparing unequal to every expectation.
function renderedOf(message: string): { heading: string; detail: string } {
  const card = blockError(new Error(message), () => {});
  const heading = card.querySelector(".block-error__title")?.textContent ?? "";
  const detail = card.querySelector(".block-error__detail")?.textContent ?? "";
  must(!(heading === "" || detail === ""), `the block error for "${message}" rendered an empty heading or detail, so nothing was graded`);
  return { heading, detail };
}

const reachedHeadings = new Set<string>();
const answeredHeadings = new Set<string>();
let reached = 0;
let answered = 0;

for (const c of CASES) {
  const kind = classifyError(new Error(c.message));
  const { heading, detail } = renderedOf(c.message);

  if (c.family === "reached") {
    reached += 1;
    reachedHeadings.add(heading);
    must(!(!looksLikeFetchFailure(c.message)), `${c.name}: looksLikeFetchFailure said no, so a real outage would be described as a console fault`);
    must(!(kind.kind !== "network"), `${c.name}: classified ${kind.kind}, and a fetch that got no response must stay network`);
    must(!(heading !== NETWORK_HEADING), `${c.name}: heading is "${heading}", and a real outage must keep the reachability heading`);
    must(!(transportClassFor(kind) !== "engine-unreachable"), `${c.name}: transport class is ${String(transportClassFor(kind))}, and a real outage must still reach the pack`);
  } else {
    answered += 1;
    answeredHeadings.add(heading);
    must(!(looksLikeFetchFailure(c.message)), `${c.name}: looksLikeFetchFailure said yes on a message no browser produces for a failed fetch`);
    must(!(kind.kind === "network"), `${c.name}: classified network, which is the defect this file pins`);
    must(!(kind.kind !== "console-fault"), `${c.name}: classified ${kind.kind}, expected console-fault`);
    must(!(heading === NETWORK_HEADING), `${c.name}: renders the reachability heading for an engine that answered`);
    must(!(detail.includes(ADDRESS_REMEDY)), `${c.name}: sends the operator to check the engine's address for a fault that is not reachability`);
    must(!(transportClassFor(kind) !== null), `${c.name}: banks transport class ${String(transportClassFor(kind))}, and nothing here established one`);
  }
}

// THE COLLISION TEST. Two families of genuinely different states must not share a rendered answer.
for (const h of answeredHeadings) {
  must(!(reachedHeadings.has(h)), `the two families share the rendered heading "${h}", which is the signature this file exists to catch`);
}

// POPULATION. A run that graded nothing, or that quietly lost a family, must fail rather than pass.
must(!(CASES.length !== DECLARED_CASES), `the case table holds ${CASES.length} cases and declares ${DECLARED_CASES}; update the declaration deliberately`);
if (reached === 0) fail("no REACHED case was graded, so nothing proves a real outage is still described as one");
if (answered === 0) fail("no ANSWERED case was graded, so nothing proves the repair does anything");

if (failures > 0) process.exitCode = 1;
console.log(
  `validate-answered-is-not-unreachable: ${CASES.length} cases graded (${reached} reached, ${answered} answered), ` +
    `${checks} checks, ${reachedHeadings.size} distinct reached heading, ${answeredHeadings.size} distinct answered heading, ${failures} failures`,
);
if (failures > 0) {
  console.error(`validate-answered-is-not-unreachable: ${failures} FAILURES`);
  process.exit(1);
}
