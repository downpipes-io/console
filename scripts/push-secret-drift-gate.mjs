#!/usr/bin/env node
// Push-secret drift gate: the engine decides what an auth secret may be, the console refuses the same values
// at the field, and the credential SCHEME each vendor requires is proven legal against the engine's own rule.
//
// WHY THIS EXISTS. A push form's hint can state a credential's required scheme (a Splunk HEC token must be
// pasted as "Splunk <token>", including the literal word Splunk and a space) while the field itself carries
// no validator enforcing it. A required-but-unvalidated secret field accepts a bare token, which the engine
// then seals and sends; the vendor answers with a 401 indistinguishable from a revoked token, and because
// the field is write-only and never re-displayed, the operator cannot even re-read what they pasted to
// check it against the hint. The one screen that states the rule is then the one screen that does not
// enforce it.
//
// WHY THE FIX IS A GATE AND NOT A COPIED CONSTANT. The obvious repair is to write the engine's rule into
// components/field-bounds.ts and cite the engine line in a comment. That idiom is already in this repo, four
// lines above the new validator: HTTP_HEADER_NAME_PATTERN is a character-for-character transcription of the
// engine's PUSH_HEADER_NAME_RE with a comment naming engine/src/admin/router-push.ts:25. It is also the
// recurring defect class here. Nothing detects the day one side moves, and the console has already paid for
// exactly that with the capability table (see capability-drift-gate.mjs, which is this gate's model).
//
// WHAT IT COMPARES, all from source:
//   1. the ENGINE's PUSH_HEADER_VALUE_MAX_LEN against the console's PUSH_SECRET_MAX_LEN;
//   2. the ENGINE's isValidPushHeaderValue against the console's pushAuthSecret validator, DIFFERENTIALLY, over
//      a corpus that includes every C0 control character, DEL, SPACE, the length boundaries either side of the
//      cap, a "Splunk <token>" credential, a JWT and multibyte text. Comparing behaviour rather than the
//      literal of a regex means a rewrite of either side in a different style is still checked, and a
//      tightening on either side is caught on the first input the two disagree about;
//   3. every credScheme the vendor CATALOGUE declares, run through the ENGINE's own function, so the claim
//      that "Splunk " is admissible is checked against the engine rather than asserted in a comment. The
//      engine's control-character regex deliberately carves SPACE out for this reason; if that carve-out were
//      ever tightened, every Splunk operator would get a 400 and this line is what turns red first;
//   4. that the console's validator actually REFUSES a bare token for each declared scheme, so the gate proves
//      the enforcement exists rather than only that a constant matches.
//
// It has NO engine-missing branch and no catalogue-empty branch. A gate that opts out when it cannot check
// reads as a pass, which is the failure it exists to prevent.
//
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

// The engine repo. An explicit override is EXCLUSIVE: if DOWNPIPES_ENGINE (or ENGINE_WORKTREE) is set, it is
// the only candidate, so a wrong one fails loudly here instead of falling through to whatever engine happens
// to be parked at the relative hop. Same rule, same names and same order as capability-drift-gate.mjs, so one
// variable aims every cross-repo gate in this directory.
const OVERRIDE = process.env.DOWNPIPES_ENGINE || process.env.ENGINE_WORKTREE;
const CANDIDATES = OVERRIDE
  ? [OVERRIDE]
  : [
      resolve(HERE, "../../support-unified-engine"),
      resolve(HERE, "../../support-pack-engine"),
      resolve(HERE, "../../engine"),
      resolve(HERE, "../../../engine"),
    ];

// The engine's push-config limits leaf. isValidPushHeaderValue, PUSH_HEADER_VALUE_MAX_LEN, PUSH_FORMATS and
// PUSH_SINKS all live here. Importing the leaf rather than the DO barrel keeps the gate off the engine's
// request-scoped machinery.
const ENGINE_LIMITS = "src/sched/scheduler-do-limits.ts";

const engineRoot = CANDIDATES.find((c) => existsSync(resolve(c, ENGINE_LIMITS)));
if (engineRoot === undefined) {
  console.error("PUSH SECRET DRIFT GATE: FAIL, cannot locate the engine, so the secret rule cannot be compared.");
  console.error(`  Looked for ${ENGINE_LIMITS} under:`);
  for (const c of CANDIDATES) console.error(`    ${c}`);
  if (OVERRIDE) {
    console.error(`  DOWNPIPES_ENGINE/ENGINE_WORKTREE is set to ${OVERRIDE}, so that is the ONLY place checked.`);
  }
  console.error("  Set DOWNPIPES_ENGINE=/path/to/engine, or check the engine out beside this repo.");
  console.error("  This FAILS rather than skips on purpose: the console states this rule to the operator, so a");
  console.error("  console that cannot check it against the engine is exactly the state the defect shipped in.");
  // Exit 2, not 1: 1 is reserved for a real disagreement found below.
  process.exit(2);
}

// A resolved engine that is merely BEHIND its own origin/main compares against a rule that has since
// moved and reports it enforced. No fetch, so unknown freshness (no origin/main ref) is not judged either
// way. PUSH_SECRET_ALLOW_STALE=1 overrides.
if (process.env.PUSH_SECRET_ALLOW_STALE !== "1") {
  let behind = null;
  try {
    behind = Number(execFileSync("git", ["-C", engineRoot, "rev-list", "--count", "HEAD..origin/main"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch { /* unknown freshness, nothing to conclude */ }
  if (Number.isFinite(behind) && /** @type {number} */ (behind) > 0) {
    console.error(`PUSH SECRET DRIFT GATE: FAIL, the engine at ${engineRoot} is ${behind} commit(s) behind its own origin/main.`);
    console.error("  Every comparison below would be graded against a rule that has since moved, and reported enforced.");
    console.error("  Update the checkout, or set PUSH_SECRET_ALLOW_STALE=1 if an old tree is deliberate.");
    process.exit(2);
  }
}

console.log(`PUSH SECRET DRIFT GATE: comparing against engine at ${engineRoot}`);

const eng = await import(resolve(engineRoot, ENGINE_LIMITS));
const bounds = await import(resolve(HERE, "../src/components/field-bounds.ts"));
const catalogue = await import(resolve(HERE, "../src/screens/integrations/catalogue.ts"));

let failed = 0;
const fail = (msg, ...detail) => {
  failed += 1;
  console.error(`  FAIL ${msg}`);
  for (const d of detail) console.error(`       ${d}`);
};

// ---------------------------------------------------------------------------------------------------
// 0. Both sides loaded, and loaded something. A gate whose import silently resolved to an empty module
// compares nothing and prints a pass.
// ---------------------------------------------------------------------------------------------------
if (typeof eng.isValidPushHeaderValue !== "function") {
  fail("the engine does not export isValidPushHeaderValue, so there is no authority to compare against.");
}
if (typeof eng.PUSH_HEADER_VALUE_MAX_LEN !== "number") {
  fail("the engine does not export PUSH_HEADER_VALUE_MAX_LEN as a number.");
}
if (typeof bounds.pushAuthSecret !== "function") {
  fail("the console does not export pushAuthSecret, so the field has no validator to check.");
}
if (typeof bounds.PUSH_SECRET_MAX_LEN !== "number") {
  fail("the console does not export PUSH_SECRET_MAX_LEN as a number.");
}
if (!Array.isArray(catalogue.CATALOGUE) || catalogue.CATALOGUE.length < 30) {
  fail(`the vendor catalogue loaded ${Array.isArray(catalogue.CATALOGUE) ? catalogue.CATALOGUE.length : "no"} entries, below the closed model's 30-plus.`,
    "A shrunken catalogue would let the scheme checks below pass by having nothing in them.");
}
if (failed > 0) {
  console.error("\nPUSH SECRET DRIFT GATE: FAIL, one side of the comparison did not load.");
  process.exit(1);
}
console.log(`  ok   both sides loaded: engine cap ${eng.PUSH_HEADER_VALUE_MAX_LEN}, console cap ${bounds.PUSH_SECRET_MAX_LEN}, ${catalogue.CATALOGUE.length} vendors`);

// ---------------------------------------------------------------------------------------------------
// 1. The length cap is the same number.
// ---------------------------------------------------------------------------------------------------
if (bounds.PUSH_SECRET_MAX_LEN !== eng.PUSH_HEADER_VALUE_MAX_LEN) {
  fail("the console's push-secret length cap is not the engine's.",
    `engine:  ${eng.PUSH_HEADER_VALUE_MAX_LEN}`,
    `console: ${bounds.PUSH_SECRET_MAX_LEN}`,
    "A console cap ABOVE the engine's accepts a value the engine answers 400; a cap BELOW it refuses a value the engine would take.");
} else {
  console.log(`  ok   the length cap agrees (${eng.PUSH_HEADER_VALUE_MAX_LEN})`);
}

// ---------------------------------------------------------------------------------------------------
// 2. DIFFERENTIAL: the console's validator and the engine's function agree on every corpus input.
//
// The console validator is built with NO scheme, so its only refusals are the two structural ones the engine
// also makes (over-length, control character). A scheme-bearing validator adds a rule the engine deliberately
// does not have (the engine cannot know which vendor a destination is), so comparing that one would be
// comparing two different questions.
//
// The empty string is excluded from the corpus, and deliberately: the engine treats "" as invalid because by
// the time isValidPushHeaderValue runs the empty case has already been handled as the keep-secret signal,
// while the console treats blank as field()'s own `required` arm. Both refuse an empty submission; they simply
// refuse it at different seams, which is a documented split rather than drift.
// ---------------------------------------------------------------------------------------------------
const consoleStructural = bounds.pushAuthSecret({ noun: "auth secret" });
const CAP = eng.PUSH_HEADER_VALUE_MAX_LEN;

const corpus = [];
// Every C0 control character and DEL, each embedded mid-value so the surrounding value is otherwise legal.
for (let c = 0; c <= 0x1f; c++) corpus.push({ label: `control 0x${c.toString(16).padStart(2, "0")} mid-value`, value: `tok${String.fromCharCode(c)}en` });
corpus.push({ label: "DEL 0x7f mid-value", value: `tok${String.fromCharCode(0x7f)}en` });
// SPACE and the real scheme shapes the space carve-out exists for.
corpus.push({ label: "a bare space mid-value", value: "tok en" });
corpus.push({ label: "Splunk <token>", value: "Splunk 12345678-abcd-1234-abcd-1234567890ab" });
corpus.push({ label: "Basic <b64>", value: "Basic Zm9vOmJhcg==" });
corpus.push({ label: "GenieKey <token>", value: "GenieKey 0e1f2a3b-4c5d" });
corpus.push({ label: "Bearer <jwt>", value: `Bearer ${"eyJhbGciOiJIUzI1NiJ9"}.${"eyJzdWIiOiIxIn0"}.${"c2ln"}` });
// The length boundaries either side of the cap.
corpus.push({ label: "one character", value: "a" });
corpus.push({ label: "exactly at the cap", value: "a".repeat(CAP) });
corpus.push({ label: "one over the cap", value: "a".repeat(CAP + 1) });
corpus.push({ label: "well over the cap", value: "a".repeat(CAP * 2) });
// Shapes that are legal and easy to get wrong.
corpus.push({ label: "multibyte text", value: "Splunk tökén-日本語" });
corpus.push({ label: "leading and trailing spaces", value: "  Splunk abc  " });
corpus.push({ label: "punctuation-heavy base64", value: "aGVsbG8=+/-_.~!#$%&'*" });
corpus.push({ label: "a quote and an angle bracket", value: 'tok"en<script>' });

let disagreements = 0;
for (const { label, value } of corpus) {
  const engineAccepts = eng.isValidPushHeaderValue(value);
  const consoleAccepts = consoleStructural(value) === null;
  if (engineAccepts !== consoleAccepts) {
    disagreements += 1;
    fail(`the two sides disagree on ${label}.`,
      `engine ${engineAccepts ? "ACCEPTS" : "refuses"}, console ${consoleAccepts ? "ACCEPTS" : "refuses"}`,
      consoleAccepts
        ? "The console is LOOSER than the engine here, which is the direction that ships a value answered with a 400."
        : "The console is TIGHTER than the engine here, so it refuses a credential the engine would have taken.");
  }
}
if (disagreements === 0) console.log(`  ok   the console validator and the engine's isValidPushHeaderValue agree on all ${corpus.length} corpus inputs`);

// ---------------------------------------------------------------------------------------------------
// 3. Every credential SCHEME the catalogue declares is a value the ENGINE will accept, and the console
// actually enforces it. This is the half that makes the Splunk rule real rather than stated.
// ---------------------------------------------------------------------------------------------------
const withScheme = catalogue.CATALOGUE.filter((v) => typeof v.credScheme === "string" && v.credScheme !== "");
if (withScheme.length === 0) {
  fail("no vendor in the catalogue declares a credScheme, so there is nothing here to check.",
    "This gate exists because a vendor stated a credential scheme and nothing enforced it. An empty list is a",
    "failure, not a pass: either a scheme was dropped from the catalogue, or the field was renamed.");
} else {
  for (const v of withScheme) {
    const scheme = v.credScheme;
    const sample = `${scheme}12345678-abcd`;
    // 3a. The ENGINE admits a credential carrying this scheme. The scheme's trailing space is the whole point.
    if (!eng.isValidPushHeaderValue(sample)) {
      fail(`the engine REFUSES a ${v.name} credential carrying its declared scheme.`,
        `scheme: ${JSON.stringify(scheme)}`,
        "The console would instruct the operator to paste a value the engine answers with a 400. If the engine's",
        "control-character screen was tightened to exclude SPACE, that is the change to reconsider.");
    }
    // 3b. The scheme ends in a space, because it is a prefix the operator types in front of a token.
    if (!scheme.endsWith(" ")) {
      fail(`${v.name}'s credScheme does not end in a space (${JSON.stringify(scheme)}).`,
        "The validator does a prefix match, so a scheme without its separator would accept a token that runs",
        "straight into the scheme word.");
    }
    // 3c. The CONSOLE refuses a bare token for this vendor: the enforcement exists, not just the constant.
    const validator = bounds.pushAuthSecret({ noun: v.credLabel ?? "auth secret", scheme, ...(v.credExample !== undefined ? { example: v.credExample } : {}) });
    if (validator("12345678-abcd") === null) {
      fail(`the console ACCEPTS a bare token for ${v.name}, whose credential requires the ${JSON.stringify(scheme)} scheme.`,
        "This is the original defect: the form states the rule and takes the value that breaks it.");
    }
    if (validator(sample) !== null) {
      fail(`the console REFUSES a correctly-schemed ${v.name} credential.`, `rejected: ${JSON.stringify(sample)}`, `message: ${validator(sample)}`);
    }
    // 3d. A declared worked example must itself pass, or the remedy sentence tells the operator to type
    // something the field will refuse.
    if (typeof v.credExample === "string" && validator(v.credExample) !== null) {
      fail(`${v.name}'s credExample does not pass its own validator.`, `example: ${JSON.stringify(v.credExample)}`, `message: ${validator(v.credExample)}`);
    }
  }
  if (failed === 0) {
    console.log(`  ok   every declared credential scheme is engine-legal and console-enforced (${withScheme.map((v) => `${v.name} ${JSON.stringify(v.credScheme)}`).join(", ")})`);
  }
}

// ---------------------------------------------------------------------------------------------------
// 4. A scheme is NEVER inferred from the wire format. Toggling a credential-scheme note on
// `format === "splunk-hec"` would conflate the two: CrowdStrike Falcon Next-Gen SIEM takes that same format
// over the same sink with a plain bearer token, so inferring the scheme from the format would tell a Falcon
// operator to prefix a Falcon token with the word Splunk. Two push vendors sharing a format must not
// therefore share a scheme.
// ---------------------------------------------------------------------------------------------------
const pushVendors = catalogue.CATALOGUE.filter((v) => v.kind === "push" && v.custom !== true);
const byFormat = new Map();
for (const v of pushVendors) {
  const key = `${v.pushFormat ?? "?"}|${v.pushSink ?? "http"}`;
  byFormat.set(key, [...(byFormat.get(key) ?? []), v]);
}
const sharedWires = [...byFormat.entries()].filter(([, vs]) => vs.length > 1);
for (const [wire, vs] of sharedWires) {
  const schemes = new Set(vs.map((v) => v.credScheme ?? ""));
  if (schemes.size > 1) {
    console.log(`  ok   ${wire} is shared by ${vs.length} vendors with DIFFERENT credential schemes (${vs.map((v) => v.name).join(", ")}), so the scheme cannot be read off the wire`);
  }
}
if (sharedWires.length === 0) {
  fail("no two named push vendors share a format-and-sink pair, so section 4 checked nothing.",
    "The catalogue used to have such a pair (Splunk and CrowdStrike Falcon Next-Gen SIEM on splunk-hec over",
    "http). If a vendor was removed, drop this section deliberately rather than leaving it inert.");
} else {
  console.log(`  ok   ${sharedWires.length} format-and-sink pair(s) are shared by more than one named vendor, so tile identity and credential rules cannot be read off the wire`);
}

// ---------------------------------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\nPUSH SECRET DRIFT GATE: FAIL, ${failed} finding(s).`);
  process.exit(1);
}
console.log("PUSH SECRET DRIFT GATE: PASS");
