// validate-engine-reason-reaches-operator.ts
//
// WHAT THIS MEASURES, AND WHY IT WAS WORTH MEASURING RATHER THAN ASSUMING.
//
// A refusal can name the count, the population, the bound, why splitting cannot work, and the step that
// lowers it (POST /keys/add-operational). The question this file settles is whether such a sentence
// REACHES THE OPERATOR at all on a JSON route, and the answer is NO, by design and on purpose.
//
// failResponse (lib/api/client-transport.ts) reads the body ONCE, tests it against a fixed set of SHAPE
// GATES (Access redirect, engine-binding-absent, console-origin fault, edge HTML, rate limit, forbidden
// class, step-up required), and then throws `${verb}: ${r.status}`. Every one of those gates is an
// equality test against a token THIS console defines, and the file says so repeatedly: "No byte of the
// body", "never a value some server sent it". A plain 400 matches none of them, so the engine's `error`
// string is read and DISCARDED. classifyError then sees only a status and answers { kind: "server" },
// whose reviewed copy is "The engine returned an error ... Retry, and if it persists check the engine
// logs" -- with a Retry control, on a refusal that is deterministic and will never succeed.
//
// THIS IS NOT A BUG BEING FILED. The no-custody rule that discards the body is a deliberate,
// well-argued anti-injection posture and this file does not propose changing it. What it pins is the
// CONSEQUENCE, so a later pass cannot spend its effort improving an engine sentence and believe an
// operator will read it:
//
//   A REFUSAL-HONESTY FIX ON THE ENGINE REACHES THE API AND THE SUPPORT PACK. IT REACHES THE SCREEN
//   ONLY IF THE CONSOLE MIRRORS THE GUARD CLIENT-SIDE IN ITS OWN WORDS.
//
// An earlier SAML cert fix reached the screen because the console had its own mirrored guard at the
// field. The retention-prune cap has no mirror, and cannot cheaply grow one: DownpipeState carries no
// run count, so the console cannot know the number the engine compares. That gap is NAMED here rather
// than papered over, and it is the console half this pass did not build.
//
// CONTROLS:
//   - DOSE-RESPONSE over statuses, not a point test: the reason survives for NO status on this path.
//   - NEGATIVE CONTROLS THAT MUST CLASSIFY DIFFERENTLY: the shape-gated classes (403 forbidden, 429
//     rate-limited, step-up) DO carry their own tokens through, so this is a measurement of which
//     information survives rather than a claim that nothing does. If those also came back bare, the
//     instrument would be broken rather than the finding real.
//   - A POSITIVE CONTROL on the sentence itself: the engine's reason text is present in the fixture
//     body, so a pass cannot come from an empty fixture.

import { readFileSync } from "node:fs";
import { errorDetail } from "../src/components/error-view.ts";
import { classifyError, errText } from "../src/lib/errors.ts";

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  if (!cond) failures++;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
}

console.log("validate-engine-reason-reaches-operator");

// A real engine refusal sentence, quoted so the fixture cannot drift from what the engine sends.
const ENGINE_REASON =
  '250 active runs, and one offline prune call carries at most 200. Every active run must be opened in the same call (a batch that does not cover them all is refused outright), so splitting this across requests cannot work. Add an operational key (Keys, "add operational key") so the scheduled retention pass, which has no such bound, prunes this downpipe instead';

// POSITIVE CONTROL on the fixture: the body really does carry the sentence, so a "reason absent" result
// downstream cannot come from an empty fixture.
const ENGINE_BODY = JSON.stringify({ error: ENGINE_REASON });
console.log(`\nfixture body carries ${ENGINE_BODY.length} bytes, including the remedy: ${/operational key/.test(ENGINE_BODY)}`);
ok("the fixture body really carries the engine's reason", ENGINE_BODY.includes("operational key") && ENGINE_BODY.includes("200"));

// failResponse's terminal throw shape, reproduced exactly (client-transport.ts: `${verb}: ${r.status}`).
// Reproduced rather than called because failResponse needs a Response and a Transport; the shape is a
// one-line literal in that file and is asserted against it by validate-errors.ts's own message shapes.
function thrownForPlainStatus(verb: string, status: number): Error {
  return new Error(`${verb}: ${status}`);
}

// AND THE REPRODUCTION IS VERIFIED RATHER THAN ASSUMED. failResponse needs a Response and a Transport
// instance, so the shape above is a copy; a copy that has drifted from its original would make every
// result below an artefact of this file. So assert the terminal throw AND the body-discard against the
// real source. If either changes, this check fails and the finding is re-opened rather than silently
// stale.
const transportSrc = readFileSync(new URL("../src/lib/api/client-transport.ts", import.meta.url), "utf8");
// A SEARCH NEEDLE for the literal source text of client-transport.ts's terminal throw, not a template
// that should interpolate. noTemplateCurlyInString is the right rule and it caught a real defect in this
// workspace this morning (a banked ledger key written as a placeholder inside a plain string, which never
// resolved); here the un-interpolated form IS the point, because interpolating it would search for this
// file's own values instead of the source's.
// biome-ignore lint/suspicious/noTemplateCurlyInString: deliberate search needle, see above
const TERMINAL_THROW = "throw new Error(`${verb}: ${r.status}`);";
console.log(`\nfailResponse's terminal throw found verbatim in the real source: ${transportSrc.includes(TERMINAL_THROW)}`);
ok("the reproduced throw shape is the one client-transport.ts actually uses", transportSrc.includes(TERMINAL_THROW));
// The body IS read (so a shape gate can run) and is never interpolated into the terminal throw. The
// absence of any `body` reference in that throw is the whole finding, stated as a check.
ok("the body is read once", /body = await r\.text\(\)/.test(transportSrc));
ok("and the terminal throw interpolates only the verb and the status, never the body", !/throw new Error\(`\$\{verb\}: \$\{[^}]*body/.test(transportSrc));

// ---- DOSE-RESPONSE: does ANY status carry the reason through on the plain path? -------------------
console.log("\nDOSE-RESPONSE (engine answers a status with a reason body; what the operator is told):");
const STATUSES = [400, 404, 409, 422, 500, 503];
const rows = STATUSES.map((status) => {
  const err = thrownForPlainStatus("prune candidates", status);
  const raw = errText(err);
  const kind = classifyError(err);
  const detail = errorDetail(err);
  return { status, raw, kind: kind.kind, detail, carriesReason: detail.includes("operational key") || raw.includes("operational key") };
});
for (const r of rows) console.log(`  ${r.status}\tthrown "${r.raw}"\tkind ${r.kind}\treason survives: ${r.carriesReason}`);
ok("the engine's reason survives for NO status on the plain JSON path", rows.every((r) => !r.carriesReason));
ok("and the classification itself is not broken (a status is still read)", rows.every((r) => r.kind === "server"));

// ---- WHAT THE OPERATOR IS ACTUALLY TOLD, on the deterministic 400 ---------------------------------
const four00 = rows.find((r) => r.status === 400)!;
console.log(`\nWHAT THE OPERATOR READS ON THE PERMANENT REFUSAL:\n  ${four00.detail}`);
ok("the copy tells the operator to RETRY a refusal that can never succeed", /retry/i.test(four00.detail));
ok("the copy sends the operator to the engine LOGS rather than to the remedy", /engine logs/i.test(four00.detail));
ok("the copy names neither the count nor the bound", !four00.detail.includes("250") && !four00.detail.includes("200"));
ok("the copy names neither the remedy nor the population", !/operational key/i.test(four00.detail) && !/active runs/i.test(four00.detail));
// The half that is CORRECT and must be recorded as such: it does not claim the engine was unreachable,
// and it does not claim anything was changed. The classification is honest about what it knows.
ok("but it is honest that nothing was changed", /nothing was changed/i.test(four00.detail));
ok("and it does not claim the engine was unreachable", !/could not reach/i.test(four00.detail));

// ---- NEGATIVE CONTROLS: the shape-gated classes DO carry information through ----------------------
// If these came back as bare as the 400 does, the instrument would be measuring itself. They do not:
// each is admitted by a frozen token this console defines, and each keeps its own classification.
console.log("\nNEGATIVE CONTROLS (classes that DO survive, so this is a measurement not a tautology):");
const SURVIVORS: Array<{ label: string; message: string; expect: string }> = [
  { label: "403 forbidden class", message: "prune apply: forbidden-class=capability: 403", expect: "forbidden" },
  { label: "429 rate limited", message: "prune candidates: rate-limited=30: 429", expect: "rate-limited" },
  { label: "401 step-up required", message: "prune apply: stepup-required: 401", expect: "stepup-required" },
  { label: "401 plain", message: "prune apply: 401", expect: "unauthorised" },
];
for (const s of SURVIVORS) {
  const k = classifyError(new Error(s.message));
  console.log(`  ${s.label}\t-> ${k.kind}`);
  ok(`${s.label} classifies as ${s.expect}, not a bare server error`, k.kind === s.expect);
}
ok("so the transport CAN carry a class through; what it will not carry is a server-authored STRING", SURVIVORS.every((s) => classifyError(new Error(s.message)).kind !== "server"));

// ---- THE GAP THIS PASS DID NOT CLOSE, PINNED SO IT IS NOT LOST ------------------------------------
// The console cannot mirror the retention-prune cap the way it mirrors the SAML cert cap, because it
// does not hold the number the engine compares. Asserted against the type rather than remembered: if a
// run count is ever added to DownpipeState, this check fails and the mirror becomes buildable.
const dpTypeSrc = readFileSync(new URL("../src/lib/api/types/downpipes.ts", import.meta.url), "utf8");
const stateBlock = /export interface DownpipeState \{([\s\S]*?)\n\}/.exec(dpTypeSrc)?.[1] ?? "";
const hasRunCount = /\brunCount\b|\bactiveRuns\b|\brunsTotal\b/.test(stateBlock.replace(/\/\/.*$/gm, ""));
console.log(`\nDownpipeState carries a run count: ${hasRunCount}`);
ok("DownpipeState carries NO run count, so the console cannot mirror this cap client-side today", !hasRunCount);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks`);
if (failures > 0) process.exitCode = 1;
if (failures > 0) process.exit(1);
