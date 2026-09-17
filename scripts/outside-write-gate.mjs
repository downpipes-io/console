#!/usr/bin/env node
// A caller must be able to know, before running a script, what it will touch.
//
// FS-WRITES: none outside this repo
// FS-WRITES-ALSO: <workspace>/<sibling>/.outside-write-gate-canary-<pid> (--deep only, and conditional. The
//   canary file is written by an OBSERVED child, so in a working run it is redirected into the shadow and
//   this process touches nothing. It exists on disk only when the observer has already failed to intercept
//   it, and then this process removes it and says so. It is declared here rather than on a FS-WRITES line
//   because a path declaration would make --deep drive this file under itself.)
//
// THE RISK THIS GATE CLOSES. A script that writes into a sibling repository without saying so can silently
// corrupt shared state that something else depends on: running one script for an unrelated reason can
// rewrite lines of internal-docs another script owns, or leave derived artefacts sitting dirty after what
// looked like a read-only run, and nothing about running the script itself gives any warning of that. The
// only way to find out is by noticing the damage afterwards, or a caller declining to run the script at
// all rather than risk it and leaving a red main standing instead.
//
// WHAT THIS GRADES, and the measurement that shaped it. Every one of the 52 scripts and all 204 files
// under test/ were executed under scripts/fs-write-observer.mjs, which redirects any write landing outside
// this checkout. Four wrote outside, all into internal-docs, none in the test tree. Against that truth:
//   306 files scanned
//    14 call a filesystem write function at all
//    10 also mention something outside this repo (the obvious heuristic)
//     4 actually write outside
// So the heuristic is 60 per cent noise and would have been the wrong gate. What it is NOT is a large
// population: fourteen files is enumerable, so the honest mechanism is a per-file declaration rather than
// an inference, and the gate's job is the low-noise question "a file gained a write and said nothing".
//
// THE DECLARATION. Any file under scripts/ or test/ that calls a write entry point carries one or more
//   // FS-WRITES: <path>
// lines, or the single line
//   // FS-WRITES: none outside this repo
// Paths are written with a <workspace> prefix, because that is what they are: a location in a sibling
// repository, resolved at run time. In-repo writes are deliberately NOT enumerated. This gate is about
// writes that leave the checkout, and a declaration listing every temp file and every build artefact would
// go stale weekly and be deleted within a month.
//
// BOTH DIRECTIONS, in both halves. A file that writes and does not declare fails. A declaration on a file
// with no write call fails too, because a stale declaration is how a caller comes to trust a promise
// nothing keeps.
//
//   node scripts/outside-write-gate.mjs              static: every writer declares, every declaration lives
//   node scripts/outside-write-gate.mjs --deep       ALSO run each declared outside-writer under the
//                                                    observer and compare what it touches with what it
//                                                    declared. Writes are redirected into a temp shadow,
//                                                    so this is safe to run beside live siblings.
//   node scripts/outside-write-gate.mjs --self-test  drive the static analyser over synthetic sources
//
// WHAT IT CANNOT SEE, said plainly rather than left to be discovered. Three holes, all real rather than
// theoretical, and none of them closed by anything below.
//
//  1. A NON-NODE CHILD. The observer patches node:fs and node:fs/promises in the process it loads and in
//     any node child that inherits NODE_OPTIONS. A write performed by git, sh or a compiled binary is
//     invisible to it. Measured rather than assumed: across the whole sweep every cross-repo child was
//     `git -C <sibling> rev-list --count HEAD..origin/main`, which reads. The static half is what covers a
//     new script reaching for a sibling, and this note is what stops the deep half being read as proof it
//     is not needed.
//
//  2. A WRITE THROUGH A LOCAL HELPER. The static half reads one file at a time, and follows imports only
//     far enough to learn which local names are bound to fs. A script calling `writeReport(path, body)`
//     from a sibling module in this repo is not seen as a writer and would need no declaration. What
//     limits the damage is that the helper itself IS seen, so the declaration lands on the helper rather
//     than the caller. What it does not limit is a helper whose own literal paths stay in this repo while
//     a caller hands it one that escapes.
//
//  3. A FALSE "none outside this repo". The deep half drives only the files that declare a PATH, since
//     those are the ones with a path to compare. A file declaring the none posture is never run, so its
//     claim is graded by nobody. Not hypothetical: test/_carousel-probe.mjs declares none and mkdirSyncs
//     new URL("../../carousel-shots/", import.meta.url), which from console/test/ resolves to the
//     WORKSPACE ROOT, outside this checkout. That file is gitignored, so it is a local scratch probe
//     rather than something a clone carries, which is why this is a note and not a fix. Closing it means
//     driving all ten none-declaring files under the observer, and two of them run a full esbuild build.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { NONE_POSTURE as NONE, readDeclaration } from "./outside-write-decl.mjs";
import { findWorkspaceDir } from "./workspace-root.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCAN = ["scripts", "test"];
const TAG = "outside-write";

// HOW A FILE IS READ lives in outside-write-decl.mjs, pure and importable. It is separate because this
// file is an entry script that scans a tree and exits, so importing it to reach the parser would run the
// whole gate and exit the importing process, reporting a clean run having executed none of its own checks.

function files() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(mjs|mts|ts)$/.test(p) && !p.endsWith(".d.ts") && !p.endsWith(".d.mts")) out.push(relative(ROOT, p));
    }
  };
  for (const d of SCAN) walk(join(ROOT, d));
  return out.sort();
}

// ---- --self-test -------------------------------------------------------------------------------------
// Both directions over synthetic sources, testing the two shapes a naive gate gets wrong: a write named
// only in prose, and a declaration on a file whose write call has been removed.
if (process.argv.includes("--self-test")) {
  /** @type {[string, string, Partial<import("./outside-write-decl.mjs").WritePosture>][]} */
  const cases = [
    ["a writer that declares", '// FS-WRITES: <workspace>/x\nwriteFileSync(p, s);', { writes: true, hasDecl: true }],
    ["a writer that declares none", `// FS-WRITES: ${NONE}\nmkdirSync(p);`, { writes: true, hasDecl: true, none: true }],
    ["a writer that says nothing", "writeFileSync(p, s);", { writes: true, hasDecl: false }],
    ["a write named only in a comment", "// this used to call writeFileSync(p, s)\nconst x = 1;", { writes: false, hasDecl: false }],
    ["a write named only in prose about another script", "// field-census.mjs calls mkdirSync(dir)\nread();", { writes: false, hasDecl: false }],
    ["a none declaration on a file that no longer writes is not drift", `// FS-WRITES: ${NONE}\nconst x = 1;`, { writes: false, hasDecl: true, none: true }],
    ["a PATH declaration on a file that no longer writes is drift", "// FS-WRITES: <workspace>/x\nconst x = 1;", { writes: false, hasDecl: true, none: false }],
    ["promises.writeFile is not matched without a call", "const s = 'writeFile';", { writes: false, hasDecl: false }],
    ["a declaration inside a string is still read", '// FS-WRITES: <workspace>/y\ncpSync(a, b);', { writes: true, hasDecl: true }],
    // The promise API. Each of these is a real write that declares nothing, and a gate that recognised
    // only the *Sync names would read each one as clean.
    [
      "a named import from node:fs/promises is a write",
      'import { writeFile } from "node:fs/promises";\nawait writeFile(p, s);',
      { writes: true, hasDecl: false },
    ],
    [
      "and so is one renamed on the way in",
      'import { writeFile as wf } from "node:fs/promises";\nawait wf(p, s);',
      { writes: true, hasDecl: false },
    ],
    [
      "a namespace import reaching through .promises is a write",
      'import fs from "node:fs";\nawait fs.promises.writeFile(p, s);',
      { writes: true, hasDecl: false },
    ],
    [
      "a require of node:fs/promises is a write",
      'const { rm } = require("node:fs/promises");\nawait rm(p);',
      { writes: true, hasDecl: false },
    ],
    // The other direction for the same names. "open" and "rm" are ordinary identifiers, and a gate that
    // fired on them unbound would make every file in the repo a writer, which is the same as none.
    [
      "the same name bound to something that is not fs is not a write",
      'import { writeFile } from "./my-report-helper.mjs";\nawait writeFile(p, s);',
      { writes: false, hasDecl: false },
    ],
    ["a local function called open is not a write", "function open(name) { return name; }\nopen('drawer');", { writes: false, hasDecl: false }],
    ["a namespace import of something else is not a write", 'import ts from "typescript";\nts.createProgram(a);', { writes: false, hasDecl: false }],
    ["openSync is a write entry point even though it is often a read", "const fd = openSync(p, 'r');", { writes: true, hasDecl: false }],
  ];
  let bad = 0;
  for (const [name, src, want] of cases) {
    const got = readDeclaration(src);
    for (const [k, v] of Object.entries(want)) {
      if (got[k] !== v) {
        console.error(`FAIL ${TAG} self-test: ${name}: expected ${k}=${v}, got ${got[k]}`);
        bad++;
      }
    }
  }
  if (bad > 0) process.exit(1);
  console.log(`ok   ${TAG} self-test: ${cases.length} synthetic sources, both directions`);
  process.exit(0);
}

// ---- static half -------------------------------------------------------------------------------------
const scanned = files();
// A gate that scans nothing reads exactly like a passing gate.
if (scanned.length < 250) {
  console.error(`FAIL ${TAG}: expected this repo's scripts and checks, found only ${scanned.length} files. Has the layout moved?`);
  process.exit(1);
}

const undeclared = [];
const stale = [];
const outsideWriters = [];
for (const f of scanned) {
  const d = readDeclaration(readFileSync(join(ROOT, f), "utf8"));
  if (d.writes && !d.hasDecl) undeclared.push(f);
  // STALE IS ABOUT PATHS, NOT ABOUT THE POSTURE LINE. A declaration is not stale merely because the file
  // has no write call: a "none outside this repo" line on such a file is simply TRUE, and flagging it would
  // fire on exactly the file that has just been repaired to stop writing. A true statement is not drift. A
  // path claim nobody keeps is.
  if (!d.writes && d.declared.length > 0) stale.push(f);
  if (d.declared.length > 0) outsideWriters.push({ file: f, declared: d.declared, also: d.alsoDeclared, runArgs: d.runArgs });
}

let failed = false;
if (undeclared.length > 0) {
  failed = true;
  console.error(`FAIL ${TAG}: ${undeclared.length} file(s) call a filesystem write and declare nothing:\n`);
  for (const f of undeclared) console.error(`  ${f}`);
  console.error(
    `\nAdd one line near the top of each:\n` +
      `    // FS-WRITES: ${NONE}\n` +
      `  or, for a write that lands in a sibling repository, one line per path:\n` +
      `    // FS-WRITES: <workspace>/internal-docs/FIELD-CATALOGUE/field-census.jsonl\n` +
      `\nThis is not paperwork. Two passes lost work on 2026-08-04 to scripts that wrote another repo\n` +
      `without saying so, and both were caught by luck rather than by anything that would catch it again.`,
  );
}
if (stale.length > 0) {
  failed = true;
  console.error(`\nFAIL ${TAG}: ${stale.length} file(s) declare an out-of-repo path and no longer write anything:\n`);
  for (const f of stale) console.error(`  ${f}`);
  console.error(`\nReplace it with "// FS-WRITES: ${NONE}", or delete it. A path claim nothing keeps is worse than\nno claim at all, because a caller believes it.`);
}

if (!process.argv.includes("--deep")) {
  if (failed) process.exit(1);
  console.log(
    `ok   ${TAG}: ${scanned.length} files, every filesystem writer declares its posture; ` +
      `${outsideWriters.length} write outside this repo (--deep proves the paths)`,
  );
  process.exit(0);
}

// ---- deep half ---------------------------------------------------------------------------------------
// Run each declared outside-writer under the observer, with its writes redirected into a temp shadow, and
// compare the paths it touches with the paths it declared. This is the half that makes a declaration a
// claim about behaviour rather than a comment.
const WORKSPACE = findWorkspaceDir(ROOT, join("internal-docs", "FIELD-CATALOGUE", "catalogue.jsonl"));
if (WORKSPACE === null) {
  console.error(`\nFAIL ${TAG} --deep: could not resolve the workspace root from ${ROOT}.`);
  console.error("  The declared paths are <workspace>-relative, so without it this half would compare nothing");
  console.error("  and print a clean run. Check internal-docs out beside this repo, or set DOWNPIPES_WORKSPACE.");
  process.exit(2);
}

const bed = mkdtempSync(join(tmpdir(), "outside-write-gate-"));
const observer = join(ROOT, "scripts", "fs-write-observer.mjs");
const log = join(bed, "observed.jsonl");
writeFileSync(log, "");

/** The observer environment every child of this half runs under, canary and writer alike. */
const observedEnv = (label) => ({
  ...process.env,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${new URL(`file://${observer}`).href}`.trim(),
  FS_OBSERVER_REPO: ROOT,
  FS_OBSERVER_SHADOW: join(bed, "shadow"),
  FS_OBSERVER_LOG: log,
  FS_OBSERVER_LABEL: label,
});

// ---- the canary, which runs before anything is driven -------------------------------------------------
//
// WHY THIS EXISTS, and it is the only part of this file that is about the INSTRUMENT rather than about the
// scripts. Everything below trusts the observer to redirect, and says so in its own last line: "writes
// redirected, no sibling touched". That claim can be false without anything downstream noticing: the
// observer classifies a path under a temporary prefix as scratch, so in a bed built under a temp directory
// with internal-docs beside it, a write can be neither recorded nor redirected, landing for real in the
// sibling checkout while this gate reports "declares path(s) it did not write". A gate that can silently
// mutate a repository is worse than one that merely reports wrongly, and no amount of care in the
// classification rule proves the classification is working HERE, in this bed, on this platform, today.
//
// So the claim is measured instead of assumed. One probe per sibling directory the declarations name writes
// a file into it, and this half refuses to run unless the observer RECORDED the write, the file did NOT
// land, and the shadow copy DID. Recording alone is not enough: an observer that logs and lets the write
// through is exactly the escape. The probe is a dotfile carrying this gate's name and pid, and if it does
// land it is removed before the failure is printed, so a broken observer costs one stray file that this
// gate deletes and names rather than a mutated census nobody sees.
//
// It doubles as the vacuity check. An observer that resolves its inputs and classifies nothing reads
// exactly like a clean run, so zero records from the canary is a FAIL rather than a pass.
const canaryProbe = join(bed, "canary-probe.mjs");
writeFileSync(canaryProbe, 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.CANARY_TARGET, "outside-write-gate canary\\n");\n');

const siblings = [
  ...new Set(
    outsideWriters
      .flatMap((w) => w.declared)
      .map((p) => /^<workspace>\/([^/]+)\//.exec(p)?.[1])
      .filter((s) => s !== undefined),
  ),
];
if (siblings.length === 0) {
  console.error(`\nFAIL ${TAG} --deep: no declaration names a sibling directory, so the observer could not be proved.`);
  console.error("  Every declared path is written <workspace>/<sibling>/..., and without one there is nothing to canary.");
  process.exit(1);
}

const canaryFindings = [];
for (const s of siblings) {
  const label = `canary:${s}`;
  const target = join(WORKSPACE, s, `.outside-write-gate-canary-${process.pid}`);
  try {
    execFileSync(process.execPath, [canaryProbe], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...observedEnv(label), CANARY_TARGET: target },
      maxBuffer: 1 << 20,
    });
  } catch (err) {
    void err; // the probe's exit code is not the question; the three facts below are
  }
  const records = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.label === label);
  const landed = existsSync(target);
  if (landed) rmSync(target, { force: true });
  const inShadow = existsSync(join(bed, "shadow", target.replace(/^\/+/, "")));
  if (records.length === 0) canaryFindings.push(`the observer recorded nothing for a write to ${target}`);
  if (landed) canaryFindings.push(`a write to ${target} LANDED in the sibling instead of being redirected (removed just now)`);
  if (!landed && !inShadow) canaryFindings.push(`a write to ${target} reached neither the sibling nor the shadow, so the redirect cannot be read either way`);
}

if (canaryFindings.length > 0) {
  console.error(`\nFAIL ${TAG} --deep: the observer does not intercept writes to the sibling(s) this run is about to drive.\n`);
  for (const f of canaryFindings) console.error(`  ${f}`);
  console.error(
    `\nNOTHING WAS DRIVEN, which is the point: the deep half's whole safety claim is that a declared writer's\n` +
      `writes are redirected, and here they are not. The usual cause is a sibling that is not a checkout, in a\n` +
      `bed under a temporary directory, where the observer cannot tell a tracked file from a scratch file.\n` +
      `Make the sibling a real checkout, or set FS_OBSERVER_NEUTRAL= to make the temp prefix count as outside.`,
  );
  process.exit(1);
}

for (const w of outsideWriters) {
  const args = w.runArgs.length > 0 ? w.runArgs.split(/\s+/) : [];
  try {
    execFileSync(process.execPath, [join(ROOT, w.file), ...args], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "pipe"],
      env: observedEnv(w.file),
      maxBuffer: 1 << 26,
    });
  } catch (err) {
    // A non-zero exit is not the question here. The observed set is written as the run goes, so a script
    // that fails late still tells the truth about where it wrote before it failed.
    void err;
  }
}

const observed = new Map();
for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
  const r = JSON.parse(line);
  const rel = r.path.startsWith(`${WORKSPACE}/`) ? `<workspace>/${r.path.slice(WORKSPACE.length + 1)}` : r.path;
  // A directory create is not a path a caller cares about; the file inside it is.
  if (r.kind === "mkdirSync" || r.kind === "promises.mkdir") continue;
  const set = observed.get(r.label) ?? new Set();
  set.add(rel);
  observed.set(r.label, set);
}

for (const w of outsideWriters) {
  const got = observed.get(w.file) ?? new Set();
  const want = new Set(w.declared);
  const extra = [...got].filter((p) => !want.has(p));
  const missing = [...want].filter((p) => !got.has(p));
  if (extra.length > 0) {
    failed = true;
    console.error(`\nFAIL ${TAG} --deep: ${w.file} wrote outside this repo at path(s) it does not declare:\n`);
    for (const p of extra) console.error(`  ${p}`);
    console.error(`\nDeclare them with a // FS-WRITES: line, or stop writing them.`);
  }
  if (missing.length > 0) {
    failed = true;
    console.error(`\nFAIL ${TAG} --deep: ${w.file} declares path(s) it did not write:\n`);
    for (const p of missing) console.error(`  ${p}`);
    console.error(
      `\nEither the declaration is stale, or the run needs an argument to reach the write. Give it one with\n` +
        `    // FS-WRITES-RUN: --write-internal-docs`,
    );
  }
}

if (failed) process.exit(1);
const total = outsideWriters.reduce((n, w) => n + w.declared.length, 0);
console.log(
  `ok   ${TAG} --deep: ${scanned.length} files declare their write posture, and the ${outsideWriters.length} that ` +
    `write outside this repo touched exactly the ${total} path(s) they declare`,
);
if (existsSync(bed)) {
  console.log(`     (observed under ${bed}, writes redirected, no sibling touched;`);
  console.log(`      the redirect was proved before anything ran, by a canary into ${siblings.join(", ")})`);
}
