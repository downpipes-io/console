#!/usr/bin/env node
// FS-WRITES: none outside this repo
// NO-RAW-NUL GATE. One claim: no tracked source file in this repository contains a raw NUL byte.
//
// ---------------------------------------------------------------------------------------------------
// WHY A RAW NUL IS DIFFERENT FROM EVERY OTHER ODD BYTE.
//
// It does not break the runtime. A string holding a literal NUL and one written with the escape are the
// SAME STRING, so a composite map key written with a raw separator works perfectly and a character class
// written with a raw 0x00 matches what its escaped form matches. Nothing fails.
//
// What it breaks is every text tool that reads the file. grep classifies a file containing a NUL as
// BINARY, and with -I it skips that file ENTIRELY: no count, no "Binary file matches" line, no error, and
// exit 1 rather than 2. It does not report that it could not check. It reports that there is nothing there.
//
// A CONCRETE EXAMPLE OF THE BLINDING. A composite key separator written as a raw NUL inside a dedupe Set,
// in a file the shell's grep (which execs ugrep with -I in this environment) reads as "Binary file ...
// matches" with no line and no count -- and any sweep that passed -I instead would omit the file in
// silence. The same byte hides every symbol declared only in that file from `git grep -I` scans such as
// docs/scripts/cited-symbol-gate.mjs: a citation of any of them reads zero occurrences of a symbol that is
// right there.
//
// THE OFFSET DECIDES IT, which is worth knowing before assuming a NUL anywhere in a file is equally
// blinding. git judges a file binary from its first 8000 bytes: a NUL inside that window makes a text tool
// misclassify the whole file as binary and skip it silently, while a NUL past that window leaves the file
// classified normally. The identical defect can be invisible in one file and perfectly visible in another,
// depending on nothing but where the byte happens to sit.
//
// WHY THIS MATTERS HERE SPECIFICALLY. A raw NUL inside scripts/fs-write-observer.mjs would hide
// TARGET_FIRST and TARGET_SECOND, the lists of filesystem entry points the write observer patches, from
// any `git grep -I` scan of this repository -- including from ANOTHER repository's gate, which this repo
// cannot fix from the other side. Those two lists decide what scripts/outside-write-gate.mjs --deep can
// see at all, so a hidden identifier that decides whether a check checks is exactly the shape this gate
// exists to make impossible.
//
// ---------------------------------------------------------------------------------------------------
// WHY THIS RULE FIRES ON NOTHING HONEST, which is the only reason it earns its place in `npm run lint`.
//
// The escape is free. Six visible characters produce a byte-for-byte identical string at runtime, so there
// is never a case where a raw NUL is the right way to write one. And scope keeps the rule off real
// binaries, so it can hold zero false positives while still catching every raw NUL in a tracked source
// file.
//
// ---------------------------------------------------------------------------------------------------
// WHAT IS GRADED, AND WHY IT IS THE TRACKED SET RATHER THAN A WALK.
//
// `git ls-files`, so the graded population is exactly what this repository committed. A directory walk
// from the project root would descend into `.worktrees/`, and this repository carries a dozen of those on
// unrelated branches: a gate whose verdict depends on what a colleague happens to have checked out beside
// you is a gate its reader learns to ignore. scripts/workspace-root.mjs records the same refusal for the
// same reason.
//
// ANTI-VACUITY. A gate that grades a file set must refuse when the set is implausibly small, or a bad glob
// turns it into a green that proves nothing. This one refuses below MIN_FILES and prints the count it
// inspected, so "0 files, all pass" cannot happen quietly.
//
// EXIT CODES. 0 clean. 1 an offender was found. 2 REFUSAL, meaning the check did not happen: the tracked
// set could not be read, or it was too small to be the real one. A 2 is a could-not-check and must never
// read as a pass.
//
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryModule } from "./entry-module.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Text-bearing extensions, the FIRST of two scope tests. A file matching one is in scope without being
// read; a file matching none is judged on its content by inScope below, so a suffix nobody listed is not a
// hole. Wider than the sibling repositories' copies because this repository tracks .mts, .toml and .sh as
// source too.
const EXTS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".js",
  ".json",
  ".jsonl",
  ".md",
  ".yml",
  ".yaml",
  ".html",
  ".css",
  ".svg",
  ".sh",
  ".toml",
  ".txt",
]);

// Well below the real count of tracked source files, so the floor catches a broken listing rather than
// tracking the repository's size and needing a bump on every addition.
const MIN_FILES = 400;

// The classification window, and the number is borrowed rather than picked. git decides whether a file is
// binary from its FIRST 8000 BYTES, which is not a detail: a NUL inside that window can make `git grep -I`
// drop the whole file silently, while an otherwise-identical file with its NUL past the window is read
// normally and never blind. Classifying over the same window means this gate's idea of "text" is the same
// one the tool it protects against uses.
const CLASSIFY_BYTES = 8000;

/**
 * Every tracked file under `root` carrying one of the extensions above, as paths relative to it.
 *
 * Exported so the self-test can drive the same listing over a fixture repository rather than take this
 * function's word for it.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function trackedSourceFiles(root = ROOT) {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z"], { maxBuffer: 1 << 28 });
  // The -z separator is itself a NUL, which is the reason this gate exists and also the reason the listing
  // must be split on bytes rather than lines: a path may legitimately contain a newline, and git says so
  // by offering -z at all.
  return out
    .toString("utf8")
    .split("\u0000")
    .filter(Boolean)
    .filter((rel) => !rel.includes("node_modules/") && inScope(root, rel));
}

/**
 * Is `rel` a text file this rule should read? DECIDED TWICE, and the second test is the point.
 *
 * An extension allowlist alone leaves a hole shaped exactly like the defect: a file saved under a suffix
 * nobody listed is out of scope, silently, and the gate reports a clean repository. This checkout tracks
 * nine such files today, all of them plain text and several of them executable (hooks/pre-commit,
 * hooks/pre-push, .gitignore, LICENSE), which is precisely where a stray byte would sit unnoticed. So a
 * file outside the list is read and judged by CONTENT instead, and there is no list to keep current. The
 * construct is docs/scripts/no-raw-nul-gate.mjs's, copied rather than re-invented.
 *
 * The content test is "text apart from the NUL", which is not circular: a NUL is the thing being looked
 * for, so it cannot be evidence of being binary, while any OTHER C0 control byte is something no source
 * file carries and a real binary carries constantly. One is enough to put a file out of scope, so the .dpe
 * and .seg archive fixtures this workspace tracks are excluded on their first stray byte rather than on
 * their name. The judgement is made over the first CLASSIFY_BYTES only; a file that passes is then read
 * WHOLE, so a NUL past the window is still found.
 *
 * @param {string} root
 * @param {string} rel
 * @returns {boolean}
 */
export function inScope(root, rel) {
  if (EXTS.has(extname(rel))) return true;
  let head;
  try {
    head = readFileSync(join(root, rel)).subarray(0, CLASSIFY_BYTES);
  } catch {
    return false; // a file git tracks but the disk cannot produce is the listing's problem, not this rule's
  }
  for (const b of head) {
    if (b === 0 || b === 9 || b === 10 || b === 13) continue; // the subject itself, tab, newline, return
    if (b < 0x20 || b === 0x7f) return false; // any other control byte: this is not a source file
  }
  return true;
}

/**
 * Reads `rel` under `root` as BYTES and reports every raw NUL in it. Bytes rather than a string,
 * deliberately: the whole subject of this gate is a reader that quietly declines to look.
 *
 * @param {string} root
 * @param {string} rel
 * @returns {{ rel: string, count: number, firstLine: number } | null}
 */
export function nulOffence(root, rel) {
  let buf;
  try {
    buf = readFileSync(join(root, rel));
  } catch {
    return null; // a file git tracks but the disk cannot produce is the listing's problem, not this rule's
  }
  const first = buf.indexOf(0);
  if (first === -1) return null;
  let count = 0;
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0) count += 1;
  let line = 1;
  for (let i = 0; i < first; i += 1) if (buf[i] === 0x0a) line += 1;
  return { rel, count, firstLine: line };
}

/**
 * Plants a NUL-bearing file and a clean twin in a throwaway git repository and drives the real listing and
 * the real detector over both. A gate that reports zero must be able to show that it can report one.
 *
 * @returns {number} process exit code
 */
function selfTest() {
  const bed = mkdtempSync(join(tmpdir(), "console-no-raw-nul-selftest-"));
  const failures = [];
  try {
    execFileSync("git", ["-C", bed, "init", "-q"]);
    // The offender. The NUL sits inside a string, which is where every real instance of this defect has
    // been found here: a composite map key separator or a control-character regex class.
    writeFileSync(
      join(bed, "offender.mjs"),
      Buffer.concat([Buffer.from('export const KEY = "a'), Buffer.from([0]), Buffer.from('b";\n')]),
    );
    // The clean twin. Byte-different, string-identical at runtime, and this is the fix the gate asks for.
    writeFileSync(join(bed, "clean.mjs"), 'export const KEY = "a\\u0000b";\n');
    // Outside the extension set, and it holds a NUL. It must NOT be reported, or the rule fires on the
    // archive fixtures this workspace legitimately tracks.
    writeFileSync(join(bed, "fixture.seg"), Buffer.from([0x01, 0x00, 0x02]));
    // Untracked, and it holds a NUL. It must NOT be reported, because the graded set is the tracked set.
    writeFileSync(
      join(bed, "stray.mjs"),
      Buffer.concat([Buffer.from('export const S = "x'), Buffer.from([0]), Buffer.from('y";\n')]),
    );
    // NO EXTENSION AT ALL, and a NUL in it. This is the hole an allowlist leaves and the reason scope is
    // decided twice: it must be found on its CONTENT, because there is no suffix to list.
    writeFileSync(
      join(bed, "pre-commit-hook"),
      Buffer.concat([Buffer.from("#!/bin/sh\nX=a"), Buffer.from([0]), Buffer.from("b\n")]),
    );
    // Also no extension, and genuinely binary. It must stay out of scope on its content, or the content
    // rule would drag every tracked binary in and the gate would fire on things that are not defects.
    writeFileSync(join(bed, "archive-blob"), Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x03, 0x02, 0x01]));
    execFileSync("git", ["-C", bed, "add", "offender.mjs", "clean.mjs", "fixture.seg", "pre-commit-hook", "archive-blob"]);

    const listed = trackedSourceFiles(bed);
    if (!listed.includes("offender.mjs")) failures.push("the listing did not include the planted offender");
    if (!listed.includes("clean.mjs")) failures.push("the listing did not include the planted clean twin");
    if (listed.includes("fixture.seg")) failures.push("the listing included a .seg fixture, so the extension allowlist is not holding");
    if (listed.includes("stray.mjs")) failures.push("the listing included an UNTRACKED file, so the graded set is not the tracked set");
    if (!listed.includes("pre-commit-hook")) failures.push("the listing missed an extensionless TEXT file, so scope is still decided by suffix alone and a file saved under a new one is invisible");
    if (listed.includes("archive-blob")) failures.push("the listing included an extensionless BINARY file, so the content rule admits real binaries and this gate would fire on things that are not defects");
    if (nulOffence(bed, "pre-commit-hook") === null) failures.push("the detector returned CLEAN on the extensionless text file carrying a raw NUL");

    const offender = nulOffence(bed, "offender.mjs");
    if (offender === null) failures.push("the detector returned CLEAN on a file carrying a raw NUL, so a zero from it means nothing");
    else if (offender.count !== 1 || offender.firstLine !== 1) failures.push(`the detector mis-located the planted NUL: ${JSON.stringify(offender)}`);

    if (nulOffence(bed, "clean.mjs") !== null) failures.push("the detector reported the ESCAPED form as an offence, so the fix it asks for would not pass");

    // The two strings really are the same at runtime. If they were not, the fix this gate demands would be
    // a behaviour change and the gate would not be free.
    const rawText = readFileSync(join(bed, "offender.mjs"), "utf8");
    const escText = readFileSync(join(bed, "clean.mjs"), "utf8");
    const rawValue = /"([\s\S]*?)"/.exec(rawText)?.[1] ?? "";
    const escValue = JSON.parse(`"${/"([\s\S]*?)"/.exec(escText)?.[1] ?? ""}"`);
    if (rawValue !== escValue) failures.push("the raw and escaped forms are NOT the same string, which would make this rule expensive rather than free");

    // THE FLOOR HAS TO BE ABLE TO FIRE. The bed holds three tracked files, far under MIN_FILES, so the
    // production path over it must REFUSE at 2 rather than report a clean repository. Without this the
    // anti-vacuity branch is prose.
    if (grade(bed) !== 2) failures.push("grading a three-file bed did not refuse, so the anti-vacuity floor is not load-bearing");
  } finally {
    rmSync(bed, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error("no-raw-nul-gate --self-test FAILED:");
    for (const f of failures) console.error(`  ${f}`);
    return 2;
  }
  console.log(
    "no-raw-nul-gate --self-test ok: a planted raw NUL is found, its escaped twin is not, a .seg fixture and an untracked file are both out of scope, an EXTENSIONLESS text file is in scope and its NUL is found while an extensionless binary stays out, the two forms are the same string at runtime, and a too-small tracked set refuses at 2.",
  );
  return 0;
}

/**
 * Grades one checkout. Separated from main so the self-test can drive the REAL production path over a
 * fixture rather than a paraphrase of it.
 *
 * @param {string} root
 * @returns {number} 0 clean, 1 offender found, 2 refusal
 */
function grade(root) {
  let files;
  try {
    files = trackedSourceFiles(root);
  } catch (err) {
    // The message is stringified rather than reached through .message: a throw is `unknown`, and this
    // repository's typecheck covers scripts/ as well as src/, so reading a property off it does not compile.
    console.error(`no-raw-nul-gate REFUSAL: could not list the tracked set (${String(err)}). Nothing was checked.`);
    return 2;
  }

  if (files.length < MIN_FILES) {
    console.error(
      `no-raw-nul-gate REFUSAL: only ${files.length} tracked source file(s) listed under ${root}, below the floor of ${MIN_FILES}. That is a broken listing, not a clean repository, and a pass here would prove nothing.`,
    );
    return 2;
  }

  const offenders = [];
  for (const rel of files) {
    const o = nulOffence(root, rel);
    if (o !== null) offenders.push(o);
  }

  if (offenders.length > 0) {
    console.error(`no-raw-nul-gate: ${offenders.length} tracked source file(s) contain a raw NUL byte, out of ${files.length} inspected.`);
    for (const o of offenders) {
      console.error(`  FAIL  ${o.rel} carries ${o.count} raw NUL byte(s), the first at line ${o.firstLine}.`);
    }
    console.error("");
    console.error("Write the escape instead. It is the identical string at runtime, so nothing that runs changes.");
    console.error("Until you do, grep reports NO MATCHES in these files rather than an error, so every sweep");
    console.error("that touches them is silently omitting them and its output cannot say so.");
    return 1;
  }

  console.log(`no-raw-nul-gate ok: ${files.length} tracked source file(s) inspected byte by byte, none carries a raw NUL, so grep and every other text tool can read all of them.`);
  return 0;
}

// GUARDED, and not as a formality. This file EXPORTS trackedSourceFiles and nulOffence so a test or another
// gate can drive them, and an unguarded top-level exit would run the whole gate and leave the process
// before the importer's first line, taking its assertions with it. scripts/entry-module.mjs holds the rule
// and its own gate keeps every argv-driven exit in this repository asking it.
if (isEntryModule(import.meta.url)) {
  process.exit(process.argv.includes("--self-test") ? selfTest() : grade(ROOT));
}
