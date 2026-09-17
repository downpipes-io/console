#!/usr/bin/env node
// FS-WRITES: none outside this repo
// SIBLING-SUPPLY GATE. Every check here that reads a sibling repository must either run somewhere that
// SUPPLIES that sibling, or say in writing why it does not.
//
// ---------------------------------------------------------------------------------------------------
// THE FAILURE, DRIVEN RATHER THAN INFERRED.
//
// A check that reads the engine and cannot find one prints a skip line and exits 0. A skip and a pass are
// the same exit code and, in a chain of a hundred and seventy validators, the same silence. So a check in
// that position is green today and would stay green if the engine changed underneath it, which is the one
// thing it was written to notice.
//
// scripts/validator-reachability-gate.mjs already asks whether a validator runs AT ALL. This asks the
// second question: does it run anywhere its sibling is actually there. Six files can fail it in a checkout
// with no sibling engine and no override: validate-audit-mirror, validate-cf-surface-contract,
// validate-notifications, validate-passkey-login, validate-add-source and validate-signin-factor-revoke,
// all exit 0 absent. Four of the six carry a REQUIRE_ENGINE arm that never fires unless REQUIRE_ENGINE is
// set, which only npm run validate:workspace does, and none of the six is in that chain for it to bite in.
// The other two have no arm at all.
//
// ---------------------------------------------------------------------------------------------------
// WHY THE RULE IS NOT "EVERY SIBLING READER MUST BE IN THE CHAIN".
//
// That version is satisfied by adding all of them, which buys nothing and lengthens the one job everybody
// waits on. Some readers genuinely should not be there: an on-demand census writer that no chain runs, a
// gate that already runs as its own CI step beside the sibling checkouts, a test whose engine block is an
// optional second opinion on a console-only claim. The honest rule is EITHER in a chain that supplies the
// sibling, OR carrying a written reason why not, which is the shape scripts/outside-write-gate.mjs already
// uses for writes that leave this repository. An exclusion with a reason is still an exclusion; the reason
// is the thing worth reading.
//
// ---------------------------------------------------------------------------------------------------
// HOW "SUPPLIES" IS DERIVED, and it is derived rather than listed.
//
// A context supplies a sibling when the sibling is checked out where it runs. In this repository that is
// exactly the CI jobs that check out another repository: .github/workflows is parsed for jobs carrying an
// actions/checkout step with a `repository:` other than this one, and every `run:` line of those jobs is
// taken as a supplying invocation. npm script names in those lines are expanded transitively through
// package.json, and relative imports are followed, so a helper pulled in by a supplied entry point counts.
//
// Listing the supplying scripts by hand would rot the moment CI moved, and this repository has already paid
// for that class twice: GATING_ENTRYPOINTS in the reachability gate is a claim about CI that went unchecked
// until it was checked, and the cross-repo job's own gates ran as bare sequential steps where the first red
// hid the rest. So the CI file is the source of truth here, and if it stops naming another repository this
// gate refuses rather than reporting that everything is supplied.
//
// ---------------------------------------------------------------------------------------------------
// WHAT COUNTS AS READING A SIBLING.
//
// Importing one of the four resolvers (test/engine-root.ts, test/engine-path.ts, test/downpipe-root.ts,
// scripts/workspace-root.mjs) or reading one of the override variables directly. Not a textual mention: the
// source is comment-blanked first, so prose naming DOWNPIPES_ENGINE buys nothing. STRING LITERALS ARE LEFT
// ALONE, which is scripts/source-text.mjs's rule and the reason it exists: the import specifiers and paths
// this gate reads live inside strings, and a sweep that blanked those too would be blind to its own subject.
//
// Resolver-based detection is close to complete here BECAUSE scripts/sibling-read-gate.mjs already forbids
// a hardcoded sibling path that does not go through a resolver or read an override. The two gates hold each
// other up: that one says every sibling read is resolvable, this one says every resolvable read is supplied
// or excused.
//
// EXIT CODES. 0 clean. 1 a reader is neither supplied nor declared. 2 REFUSAL, meaning the derivation
// itself did not happen: the workflows are unreadable, no supplying job was found, or a known-positive
// control failed. A 2 is a could-not-check and must never read as a pass.
//
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryModule } from "./entry-module.mjs";
import { blankComments } from "./source-text.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN = ["test", "scripts"];

/** The resolvers themselves. They ARE the mechanism, so asking them to be supplied is circular. */
const RESOLVERS = new Set([
  "test/engine-root.ts",
  "test/engine-path.ts",
  "test/downpipe-root.ts",
  "scripts/workspace-root.mjs",
  "scripts/workspace-root.d.mts",
]);

/** Importing any of these is a sibling read. Matched over comment-blanked source. */
const RESOLVER_IMPORT = /from\s*"[^"]*\/(engine-root\.ts|engine-path\.ts|downpipe-root\.ts|workspace-root\.mjs)"/;
/** Reading any of these is a sibling read too, for the .mjs gates that predate the resolvers. */
const OVERRIDE_READ = /process\.env\.(DOWNPIPES_ENGINE|ENGINE_WORKTREE|DOWNPIPES_DOWNPIPE|DOWNPIPES_WORKSPACE|DOWNPIPES_HARNESS)/;
/** The written exclusion. One line, near the top, with the reason on it. */
const DECLARATION = /^\s*\/\/\s*SIBLING-SUPPLY:\s*(\S.*)$/m;

// Floors. Each one is a number this repository is far above, so they catch a broken derivation rather than
// tracking the repository's size. A gate that scans nothing reads exactly like a passing gate.
const MIN_SCANNED = 250;
const MIN_READERS = 25;
const MIN_SUPPLIED = 15;
const MIN_REASON_CHARS = 20;

// ---- KNOWN-POSITIVE CONTROL ---------------------------------------------------------------------------
// If a file that is demonstrably inside a supplying chain stops being visible as supplied, this gate's
// parse has broken and every "not supplied" below it is an artefact rather than a finding. These four are
// reached by four DIFFERENT routes, on purpose: a literal node invocation in the chain body, a name reached
// only by expanding `npm run <sub>`, a name that only appears in a CI `run:` line rather than in
// package.json's chain, and a helper reached only by following a relative import. A control that exercises
// one route cannot tell a broken expander from a clean repository.
const CONTROL_SUPPLIED = [
  ["scripts/audit-mirror-drift-gate.mjs", "a literal node invocation inside validate:workspace:chain"],
  ["test/validate-visible-surface-counts.ts", "reached only by expanding npm run validate:visible-counts"],
  ["scripts/harness-pin-gate.mjs", "named only by a CI run: line in the cross-repo job, not by the chain"],
  ["test/validate-api-pure.ts", "reached only by following a relative import out of validate-api.ts"],
];
// And the other direction. A detector that cannot see a reader reports a clean repository just as loudly.
const CONTROL_READERS = [
  ["test/validate-identity.ts", "imports engine-path.ts, and its call site carries a generic argument"],
  ["scripts/mirror-drift-gate.mjs", "reads DOWNPIPES_ENGINE directly, with no resolver import"],
  ["test/validate-keygen.ts", "imports downpipe-root.ts, a sibling that is not the engine"],
  ["scripts/functional-census.mjs", "imports workspace-root.mjs, a third resolver again"],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mts|mjs|cjs|js)$/.test(p)) out.push(relative(ROOT, p));
  }
  return out;
}

function refuse(msg) {
  console.error(`sibling-supply REFUSAL: ${msg}`);
  console.error("  Nothing was graded, so this is a could-not-check and must not be read as a pass.");
  process.exit(2);
}

/** Every `test/...` or `scripts/...` path an invocation line names, whatever flags sit between. */
function invokedPaths(text) {
  const out = new Set();
  for (const m of text.matchAll(/\b(?:node|npx tsx|tsx)\s+(?:--[^\s]+\s+)*((?:test|scripts)\/[A-Za-z0-9_./-]+)/g)) out.add(m[1]);
  return out;
}

function main() {
  const scanned = [];
  for (const d of SCAN) {
    const abs = join(ROOT, d);
    if (!existsSync(abs)) refuse(`${d}/ does not exist, so there is nothing to check`);
    walk(abs, scanned);
  }
  scanned.sort();
  if (scanned.length < MIN_SCANNED) refuse(`only ${scanned.length} file(s) under ${SCAN.join("/ and ")}/, below the floor of ${MIN_SCANNED}. Has the layout moved?`);

  // TWO VIEWS OF EACH FILE, AND THE SPLIT IS LOAD-BEARING. The sibling READ is code, so it is matched over
  // the comment-blanked text and prose naming a resolver buys nothing. The DECLARATION is a comment by
  // definition, so it is matched over the raw text: blanking first made every declaration invisible to this
  // gate, which reported four files as undeclared with the declarations sitting in them. Found by writing
  // them and watching the gate not move.
  const body = new Map();
  const raw = new Map();
  for (const f of scanned) {
    const text = readFileSync(join(ROOT, f), "utf8");
    raw.set(f, text);
    body.set(f, blankComments(text));
  }

  // ---- who reads a sibling ----------------------------------------------------------------------------
  const readers = scanned.filter((f) => !RESOLVERS.has(f) && (RESOLVER_IMPORT.test(body.get(f)) || OVERRIDE_READ.test(body.get(f))));
  if (readers.length < MIN_READERS) refuse(`only ${readers.length} sibling reader(s) detected, below the floor of ${MIN_READERS}. The detector has broken, not the repository.`);

  // ---- which contexts supply a sibling ----------------------------------------------------------------
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const scripts = pkg.scripts ?? {};
  const expand = (name, seen = new Set()) => {
    if (seen.has(name) || scripts[name] === undefined) return "";
    seen.add(name);
    const src = String(scripts[name]);
    let out = src;
    for (const m of src.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) out += `\n${expand(m[1], seen)}`;
    // THE CHAIN RUNNER IS FOLLOWED TOO. `validate`, `lint` and `validate:workspace` do not hold their
    // members directly: each is a `node scripts/run-gate-chain.mjs <chain> <floor>` and the members live in
    // the named chain. Without this line the three known-positive controls below would all go dark at
    // once, and the gate would refuse correctly, because an absence it cannot distinguish from a derivation
    // fault is not a finding.
    for (const m of src.matchAll(/run-gate-chain\.mjs ([A-Za-z0-9:_-]+)/g)) out += `\n${expand(m[1], seen)}`;
    return out;
  };

  const wfDir = join(ROOT, ".github/workflows");
  if (!existsSync(wfDir)) refuse("no .github/workflows here, so which jobs supply a sibling cannot be derived");

  // A job supplies a sibling when it checks another repository out. Jobs are split on their key at the
  // workflow's job indentation, which is enough structure for a question this coarse and avoids taking a
  // YAML parser on for it.
  //
  // ONLY THE `run:` SCALARS COUNT, AND THAT IS THE WHOLE DIFFERENCE BETWEEN THIS GATE AND A GREEN ONE.
  // Taking a job's raw text instead would also read ci.yml's cross-repo job's own COMMENTS naming
  // `npm run lint` and `npm run validate` while explaining what those chains do and do not cover, and
  // expanding those pulls the entire validator suite in as "supplied", which makes every finding disappear:
  // removing validate-audit-mirror.ts from validate:workspace:chain would still leave the gate green,
  // because `validate` still names it and the prose promotes `validate` to a supplying chain. A path
  // mentioned in CI PROSE is not an invocation, which is the same rule
  // scripts/validator-reachability-gate.mjs states for its own derivation.
  const runScalars = (jobText) => {
    let out = "";
    let inRun = false;
    let runIndent = 0;
    for (const line of jobText.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) continue; // a YAML comment is not an invocation
      const m = /^(\s*)-?\s*run:\s*(.*)$/.exec(line);
      if (m !== null) {
        inRun = true;
        runIndent = m[1].length;
        out += `\n${m[2]}`;
        continue;
      }
      if (!inRun) continue;
      if (trimmed === "") continue;
      if (line.length - line.trimStart().length > runIndent) {
        out += `\n${trimmed}`;
        continue;
      }
      inRun = false;
    }
    return out;
  };

  let supplyingJobs = 0;
  let supplyText = "";
  for (const wf of readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))) {
    const src = readFileSync(join(wfDir, wf), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    const jobs = src.split(/\n(?= {2}[A-Za-z0-9_-]+:\n)/);
    for (const job of jobs) {
      if (!/^\s+repository:\s*\S+/m.test(job)) continue;
      supplyingJobs++;
      supplyText += `\n${runScalars(job)}`;
    }
  }
  if (supplyingJobs === 0) {
    refuse("no CI job checks out another repository, so nothing here supplies a sibling. Either the cross-repo job has gone, or this parse has.");
  }

  // Every npm script and every direct invocation named by a supplying job, expanded.
  const supplyingScripts = new Set([...supplyText.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((m) => m[1]));
  let supplyingInvocations = supplyText;
  for (const s of supplyingScripts) supplyingInvocations += `\n${expand(s)}`;

  const supplied = new Set(invokedPaths(supplyingInvocations));
  if (supplied.size === 0) refuse("the supplying jobs name no file under test/ or scripts/, so the invocation parse has broken");

  // Transitive closure over relative imports, so a helper pulled in by a supplied entry point counts. Same
  // rule scripts/validator-reachability-gate.mjs uses, for the same reason.
  const importsOf = (f) => {
    const src = body.get(f);
    if (src === undefined) return [];
    const dir = dirname(f);
    const out = [];
    for (const m of src.matchAll(/from\s+"(\.[A-Za-z0-9_./-]+\.(?:ts|mts|mjs|cjs|js))"/g)) out.push(relative(ROOT, resolve(join(ROOT, dir), m[1])));
    for (const m of src.matchAll(/import\(\s*"(\.[A-Za-z0-9_./-]+\.(?:ts|mts|mjs|cjs|js))"\s*\)/g)) out.push(relative(ROOT, resolve(join(ROOT, dir), m[1])));
    return out;
  };
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of [...supplied]) {
      for (const dep of importsOf(f)) {
        if (body.has(dep) && !supplied.has(dep)) {
          supplied.add(dep);
          grew = true;
        }
      }
    }
  }
  if (supplied.size < MIN_SUPPLIED) refuse(`only ${supplied.size} file(s) resolve as supplied, below the floor of ${MIN_SUPPLIED}. The expansion has broken.`);

  // ---- the controls ------------------------------------------------------------------------------------
  const controlFailures = [];
  for (const [f, why] of CONTROL_SUPPLIED) if (!supplied.has(f)) controlFailures.push(`${f} is no longer visible as supplied (${why})`);
  for (const [f, why] of CONTROL_READERS) if (!readers.includes(f)) controlFailures.push(`${f} is no longer visible as a sibling reader (${why})`);
  if (controlFailures.length > 0) {
    console.error("sibling-supply REFUSAL: a known-positive control failed, so no absence below can be believed:");
    for (const c of controlFailures) console.error(`  ${c}`);
    console.error("  Fix the derivation, or move the control if the file itself legitimately changed.");
    process.exit(2);
  }

  // ---- the finding -------------------------------------------------------------------------------------
  const unsupplied = [];
  const declared = [];
  for (const f of readers) {
    if (supplied.has(f)) continue;
    const m = DECLARATION.exec(raw.get(f));
    if (m === null) {
      unsupplied.push(f);
      continue;
    }
    const reason = m[1].trim();
    if (reason.length < MIN_REASON_CHARS) {
      unsupplied.push(`${f}  (its SIBLING-SUPPLY line says only "${reason}", which is not a reason)`);
      continue;
    }
    declared.push([f, reason]);
  }

  console.log(
    `sibling-supply: ${scanned.length} files scanned, ${readers.length} read a sibling, ` +
      `${readers.filter((f) => supplied.has(f)).length} run where one is supplied (${supplyingJobs} CI job(s) check a sibling out), ` +
      `${declared.length} excluded with a written reason, ${unsupplied.length} neither.`,
  );
  for (const [f, reason] of declared) console.log(`  excluded  ${f}: ${reason}`);

  if (unsupplied.length > 0) {
    console.error(`\nsibling-supply FAIL: ${unsupplied.length} file(s) read a sibling repository, run nowhere that supplies one, and say nothing about it:\n`);
    for (const f of unsupplied) console.error(`  ${f}`);
    console.error(
      "\nEither put it in a chain that supplies the sibling (npm run validate:workspace for the engine and\n" +
        "internal-docs, npm run validate:reader for the offline reader, or a step in the cross-repo CI job),\n" +
        "or add one line near the top saying why it is not there:\n" +
        "    // SIBLING-SUPPLY: <the reason>\n" +
        "\nThis is not paperwork. A check that reads a sibling it cannot find prints a skip and exits 0, and a\n" +
        "skip and a pass are the same exit code and the same silence. Six files here were in that position and\n" +
        "four of them carried a REQUIRE_ENGINE arm that had never fired, because they were in no chain that\n" +
        "sets it.",
    );
    return 1;
  }
  return 0;
}

if (isEntryModule(import.meta.url)) process.exit(main());
