#!/usr/bin/env node
// FS-WRITES: none outside this repo
// (buildReader's mkdtempSync lands under the OS temp directory to hold the built binary, a build
// artefact rather than a sibling-repo write; nothing here ever writes into downpipe/ or any other repo.)
//
// The reader-command-truth gate: every `downpipe <subcommand> ...` invocation the console prints or
// embeds must be one the offline reader (the downpipe CLI, `downpipe/`) actually accepts.
//
// THE CLASS THIS CLOSES. A printed invocation in src/screens/keys/offline-recovery.ts or
// src/recovery-sheet.ts can drift from what the reader actually accepts in several ways at once: a --sink
// value that does not exist (the binary knows only file, env and discard), a wrong description of what a
// sink value emits, and a restore command missing a flag the sheet's own anti-rollback field depends on
// (--min-runlog-index). Nothing else in this repo compares the LITERAL TEXT the console prints against the
// reader's own accepted interface.
// test/validate-offline-recovery-panel.ts's section 8 comes close: it opens the reader's Go SOURCE with
// a regex to check flag names, which is a real check and stays. It does not build or run the binary, so
// it cannot catch a value a flag accepts syntactically but rejects semantically (a bad --sink value is a
// perfectly well-formed string flag argument to the Go source regex; only running the binary rejects it).
// This gate builds the reader from source and RUNS every extracted invocation against it, so a finding
// carries the binary's own stderr line, not this gate's opinion of what the interface should be.
//
// WHY A SEPARATE GATE RATHER THAN A SECTION IN THAT TEST, AND WHY validate:reader:chain RATHER THAN
// lint:chain. test/validate-offline-recovery-panel.ts and test/validate-keygen.ts are wired into
// `npm run validate:reader:chain`, which `npm run validate:reader` runs under REQUIRE_DOWNPIPE=1 in its own
// CI job (ci.yml: "The offline reader's labels and CLI surface"), precisely because they need the downpipe
// sibling checked out beside this one, which a plain console-only clone does not have. `lint:chain` (what a
// bare `npm run lint` runs) carries no such dependency anywhere in this repo: its own "sibling" gates
// (lint:sibling-read, lint:sibling-resolution, lint:sibling-supply) read the ENGINE or DOCS siblings and
// skip gracefully when absent, they do not spawn a Go toolchain. Building the reader from source and
// running it once per invocation is a materially heavier operation with a different failure mode again (a
// missing `go`, a vendor dir out of date) on top of needing the same sibling those two tests need, so this
// gate is wired as one more step in validate:reader:chain, right after them, rather than into lint:chain
// where it would either fail every console-only checkout's plain `npm run lint` or need its own
// skip-unless-required plumbing duplicating what that chain's REQUIRE_DOWNPIPE=1 already provides for free.
// It is exported under the name `lint:reader-command-truth` all the same, matching this repo's convention
// of a `lint:*` label for a standalone gate script regardless of which chain invokes it.
//
// SCOPE OF WHAT IS EXTRACTED. src/screens/keys/offline-recovery.ts prints every command through
// codeBlock(...); src/recovery-sheet.ts assembles its plaintext through lines.push(...) calls and its HTML
// through joined arrays of string/template literals, one of which builds a command via `const
// restoreCommand = "..." + "..."`. Those are the two files with a REAL invocation today (verified below by
// the population sweep). "Anywhere else" is not left to memory: srcFilesWithCandidateInvocations() below re-derives,
// on every run, which files in src/ contain a line shaped like a downpipe invocation (a `downpipe
// <subcommand>` token followed by a `--flag` on the same line, comments blanked first so a code COMMENT
// mentioning the CLI is not mistaken for a printed one). A file outside the two this gate knows how to
// parse is a FINDING telling the maintainer to extend it, not a silent miss.
//
// VALUE VALIDATION IS EXECUTION, NOT A DIFF. A flag's accepted VALUES (file/env/discard for --sink) are
// not visible from `--help`'s one-line type token, so every invocation is actually run against the built
// binary with placeholder values substituted for angle-bracket placeholders (an int-typed flag given a
// bracketed placeholder such as <pinned-index> gets a dummy "1" so Go's flag parser does not choke on it
// for a reason unrelated to the thing under test). The two rejection shapes the binary is known to print
// (cmd/downpipe/main.go's dispatch, cmd/downpipe/restore.go:547) are matched in the captured output; any
// other outcome, including a "no such file" from a placeholder path, means the flags and the sink value
// were accepted and something downstream (deliberately fed nonsense) failed instead, which is not this
// gate's question.
//
// EXIT CODES: 0 every extracted invocation is accepted by the binary; 1 at least one is not (a genuine
// finding); 2 could not check (no downpipe sibling, no `go`, the sibling would not build, or extraction
// found nothing to check, each printed with which it was).
//
// Usage:
//   node scripts/reader-command-truth-gate.mjs              gate: extract, build, validate
//   node scripts/reader-command-truth-gate.mjs --self-test   fixture-driven check of the gate itself
//   DOWNPIPES_DOWNPIPE=/path/to/downpipe overrides sibling resolution (same name docs/*.mjs already use)
//
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { isEntryModule } from "./entry-module.mjs";
import { blankComments } from "./source-text.mjs";
import { findWorkspaceDir } from "./workspace-root.mjs";

const CONSOLE_ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(CONSOLE_ROOT, "src");

// The two files this gate knows how to parse today, relative to CONSOLE_ROOT. Kept as a named constant
// (rather than inferred) so the completeness sweep below has something concrete to compare against.
const KNOWN_FILES = ["src/screens/keys/offline-recovery.ts", "src/recovery-sheet.ts"];

// ---------------------------------------------------------------------------------------------------------
// Small pure helpers: unescape a JS string-literal body, decode the HTML entities the sheet's HTML
// functions embed, strip the handful of tags those functions wrap a command in, and convert a byte offset
// into a 1-based line number.
// ---------------------------------------------------------------------------------------------------------

/** Decodes the JS escape sequences this codebase actually uses inside a "..."/'...' literal body. */
export function unescapeJsString(body) {
  return body.replace(/\\(.)/g, (_, ch) => ({ n: "\n", t: "\t", r: "\r" })[ch] ?? ch);
}

/** Decodes the small, fixed set of HTML entities the sheet's HTML builders emit. */
export function decodeHtmlEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Strips the handful of inline tags a command block is wrapped in (<pre>, </pre>, <code>, </code>). */
export function stripTags(text) {
  return text.replace(/<\/?(?:pre|code)>/gi, "");
}

/** 1-based line number of byte offset `at` in `text`. */
export function lineOf(text, at) {
  let line = 1;
  for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

// ---------------------------------------------------------------------------------------------------------
// Extraction. Each function returns ordered {text, line} entries: `text` is the DECODED content of one
// source construct (already HTML-entity-decoded and tag-stripped where relevant), `line` is the 1-based
// source line the construct starts on. A `text` may itself carry real "\n" characters (a codeBlock literal
// or a const built from several "+"-joined literals prints several lines from one source line); the
// flattening step below splits those out while keeping the same line number, since finer attribution is
// not available from static text and the block's start line is precise enough for a maintainer to find it.
// ---------------------------------------------------------------------------------------------------------

const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

function unquote(literal) {
  return unescapeJsString(literal.slice(1, -1));
}

/** Every codeBlock("...") call in `text`: src/screens/keys/offline-recovery.ts's idiom. */
export function extractCodeBlockLiterals(text) {
  const out = [];
  for (const m of text.matchAll(/codeBlock\(\s*("(?:[^"\\]|\\.)*")/g)) {
    out.push({ text: unquote(m[1]), line: lineOf(text, m.index), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Every lines.push("...") / lines.push('...') call in `text`, in source order: recovery-sheet.ts's plaintext idiom. */
export function extractLinesPushLiterals(text) {
  const out = [];
  const re = new RegExp(`lines\\.push\\(\\s*(${QUOTED.source})\\s*\\)`, "g");
  for (const m of text.matchAll(re)) {
    out.push({ text: unquote(m[1]), line: lineOf(text, m.index), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** `const <name> = "<lit>" + "<lit>" + ...;`, decoded and concatenated as one block. Null if not present. */
export function extractConstConcat(text, name) {
  // Each alternative of QUOTED.source must be wrapped in its OWN group before it is repeated: without the
  // inner (?:...), "A|B\s*\+\s*" parses as "A, or (B followed by \s*\+\s*)", which silently drops the
  // whole first literal of every "+"-chain (measured: this returned null against the real file).
  const one = `(?:${QUOTED.source})`;
  const re = new RegExp(`const\\s+${name}\\s*=\\s*((?:${one}\\s*\\+\\s*)+${one})\\s*;`, "g");
  const m = re.exec(text);
  if (m === null) return null;
  const pieces = [...m[1].matchAll(QUOTED)].map((p) => unquote(p[0]));
  return { text: pieces.join(""), line: lineOf(text, m.index), start: m.index, end: m.index + m[0].length };
}

/**
 * Every remaining quoted literal in `text` whose decoded, entity-decoded, tag-stripped content starts with
 * "downpipe ", excluding any literal whose span falls inside one of `excludeSpans` (already captured by a
 * more specific extractor above, so this is the catch-all for a one-shot literal like
 * "<pre>downpipe keys --which --archive &lt;dir&gt;</pre>" that is not part of a lines.push/codeBlock/const
 * run this gate already walks).
 */
export function extractBareDownpipeLiterals(text, excludeSpans) {
  const out = [];
  for (const m of text.matchAll(QUOTED)) {
    const insideExcluded = excludeSpans.some((s) => m.index >= s.start && m.index < s.end);
    if (insideExcluded) continue;
    const decoded = stripTags(decodeHtmlEntities(unquote(m[0])));
    if (!decoded.trimStart().startsWith("downpipe ")) continue;
    out.push({ text: decoded, line: lineOf(text, m.index), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Flattens {text,line} entries (each may carry real "\n") into single visual lines, then joins a line
 * ending in a bare trailing backslash with the next one (the console's own line-continuation convention,
 * used both inside one codeBlock literal and across consecutive lines.push calls in recovery-sheet.ts). The
 * joined line is attributed to the line its FIRST piece came from.
 */
export function flattenAndJoin(entries) {
  const flat = [];
  for (const e of entries) for (const sub of e.text.split("\n")) flat.push({ text: sub, line: e.line });

  const joined = [];
  let i = 0;
  while (i < flat.length) {
    let text = flat[i].text;
    const line = flat[i].line;
    while (/\\\s*$/.test(text) && i + 1 < flat.length) {
      i++;
      text = `${text.replace(/\\\s*$/, "")} ${flat[i].text.trim()}`;
    }
    joined.push({ text, line });
    i++;
  }
  return joined;
}

/**
 * True when `tokens` (everything after the subcommand) is SHAPED like a real invocation rather than an
 * English sentence that happens to start with "downpipe": every token is either a --flag, or is consumed
 * as the value immediately following one (a "<...>" placeholder may span several whitespace-separated
 * tokens, consumed as one value). A bare word that is not a flag and does not follow one is an orphan,
 * which only prose produces.
 *
 * WHY THIS EXISTS. src/recovery-sheet.ts's plaintext prints its own title as `lines.push("downpipe
 * recovery sheet")` and later a sentence, "downpipe verify and downpipe restore both refuse to start
 * without --signer,". Both start with the literal word "downpipe" followed by a lowercase word, which is
 * indistinguishable from a real subcommand by the outer regex alone; running either through the reader
 * as a fabricated invocation would produce a false finding (the sentence's "--signer," carries a trailing
 * comma from the prose, which the binary correctly rejects as a flag it does not have, for a reason that
 * has nothing to do with the console's real commands).
 */
function looksLikeInvocation(tokens) {
  if (tokens.length === 0) return false;
  let i = 0;
  while (i < tokens.length) {
    if (!/^--[a-zA-Z]/.test(tokens[i])) return false;
    i++;
    if (i >= tokens.length || /^--[a-zA-Z]/.test(tokens[i])) continue; // a boolean flag takes no value
    if (tokens[i].startsWith("<") && !tokens[i].endsWith(">")) {
      while (i < tokens.length && !tokens[i].endsWith(">")) i++;
    }
    i++;
  }
  return true;
}

/**
 * Pulls one invocation out of each joined line that starts (after trimming) with "downpipe <subcommand>"
 * AND whose remaining tokens look like a real invocation (see looksLikeInvocation). A prose line, a
 * comment ("# ..."), or a blank line yields nothing. `tokens` is everything after the subcommand,
 * whitespace-split; a bracket placeholder such as "<value from the field above, if you filled it in>" is
 * deliberately left as several tokens here and reassembled later, once the flag's declared type is known,
 * because whether it needs reassembling depends on that type.
 */
export function invocationsFromJoined(joined, file) {
  const out = [];
  for (const { text, line } of joined) {
    const trimmed = text.trim();
    const m = /^downpipe\s+([a-z][a-z-]*)\b(.*)$/.exec(trimmed);
    if (m === null) continue;
    const tokens = m[2].trim().split(/\s+/).filter((t) => t.length > 0);
    if (!looksLikeInvocation(tokens)) continue;
    out.push({ file, line, cmd: m[1], tokens });
  }
  return out;
}

/** All invocations from src/screens/keys/offline-recovery.ts: codeBlock(...) calls only. */
function extractOfflineRecoveryInvocations(file, text) {
  return invocationsFromJoined(flattenAndJoin(extractCodeBlockLiterals(text)), file);
}

/** All invocations from src/recovery-sheet.ts: lines.push (plaintext), the restoreCommand const (HTML), and any remaining bare literal. */
function extractRecoverySheetInvocations(file, text) {
  const pushLiterals = extractLinesPushLiterals(text);
  const restoreConst = extractConstConcat(text, "restoreCommand");
  const consumed = [...pushLiterals, ...(restoreConst ? [restoreConst] : [])];
  // extractBareDownpipeLiterals already entity-decodes and tag-strips each candidate (it has to, to test
  // "starts with downpipe " at all), so nothing further is done to its output here.
  const bare = extractBareDownpipeLiterals(text, consumed);
  const restoreConstDecoded = restoreConst ? { ...restoreConst, text: decodeHtmlEntities(restoreConst.text) } : null;

  return [
    ...invocationsFromJoined(flattenAndJoin(pushLiterals), file),
    ...(restoreConstDecoded ? invocationsFromJoined(flattenAndJoin([restoreConstDecoded]), file) : []),
    ...invocationsFromJoined(flattenAndJoin(bare), file),
  ];
}

function extractAll() {
  const out = [];
  for (const rel of KNOWN_FILES) {
    const p = join(CONSOLE_ROOT, rel);
    const text = readFileSync(p, "utf8");
    out.push(...(rel.endsWith("offline-recovery.ts") ? extractOfflineRecoveryInvocations(rel, text) : extractRecoverySheetInvocations(rel, text)));
  }
  return out;
}

/**
 * The completeness sweep: every .ts file under src/ (comments blanked first, so a comment naming the CLI is
 * not mistaken for a printed command) is checked for a line shaped like a real invocation. A hit outside
 * KNOWN_FILES means this gate has not been taught to parse a file that now prints a downpipe command, which
 * is a finding rather than a silent gap.
 */
export function srcFilesWithCandidateInvocations(srcDir) {
  const CANDIDATE = /downpipe\s+[a-z][a-z-]*\b[^\n]*--[a-z]/;
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!name.endsWith(".ts")) continue;
      const blanked = blankComments(readFileSync(p, "utf8"));
      if (CANDIDATE.test(blanked)) hits.push(relative(CONSOLE_ROOT, p));
    }
  };
  walk(srcDir);
  return hits.sort();
}

// ---------------------------------------------------------------------------------------------------------
// The reader: sibling resolution, build, and its self-reported interface (subcommands, per-subcommand
// flag types read from `--help`, which is the binary's own declaration rather than a parse of its source).
// ---------------------------------------------------------------------------------------------------------

/** DOWNPIPES_DOWNPIPE is an exclusive override (a bad override must be loud, not silently corrected, the
 * same rule test/downpipe-root.ts documents for the same env var one sibling over). Otherwise the
 * workspace root is derived the way scripts/verify-doc-links.mjs derives the docs sibling, which already
 * handles the nested console/.worktrees/<name> layout this gate is run from. */
export function resolveDownpipeRoot() {
  const override = process.env.DOWNPIPES_DOWNPIPE;
  if (override !== undefined && override !== "") {
    return existsSync(join(override, "cmd", "downpipe")) ? override : null;
  }
  const marker = join("downpipe", "cmd", "downpipe");
  const workspace = findWorkspaceDir(CONSOLE_ROOT, marker);
  return workspace === null ? null : join(workspace, "downpipe");
}

function haveGo() {
  try {
    execFileSync("go", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Builds the reader from source with the same flags the owner's own re-verification command uses. Throws with the compiler's own stderr on failure. */
function buildReader(root) {
  const dir = mkdtempSync(join(tmpdir(), "downpipe-truth-"));
  const bin = join(dir, "downpipe");
  execFileSync("go", ["build", "-o", bin, "./cmd/downpipe"], {
    cwd: root,
    env: { ...process.env, GOFLAGS: "-mod=vendor", GOPROXY: "off" },
    stdio: "pipe",
  });
  return bin;
}

/** Runs `bin` with `args`, never throwing: a non-zero exit is the normal case for a --help or a deliberately incomplete invocation. */
function runCapture(bin, args) {
  try {
    const stdout = execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, output: stdout };
  } catch (e) {
    const err = /** @type {{status?: number, stdout?: Buffer|string, stderr?: Buffer|string}} */ (e);
    const stdout = typeof err.stdout === "string" ? err.stdout : (err.stdout?.toString("utf8") ?? "");
    const stderr = typeof err.stderr === "string" ? err.stderr : (err.stderr?.toString("utf8") ?? "");
    return { status: typeof err.status === "number" ? err.status : 1, output: `${stdout}${stderr}` };
  }
}

/** The subcommand set, read from the "Commands:" section of the bare invocation's own usage text. */
export function readerSubcommands(bin) {
  const { output } = runCapture(bin, []);
  const start = output.indexOf("Commands:");
  if (start === -1) return new Set();
  const section = output.slice(start).split(/\n\n/)[0];
  return new Set([...section.matchAll(/^ {2}([a-z][a-z-]*)\s/gm)].map((m) => m[1]));
}

/**
 * The flag-name -> type map for one subcommand, read from `<bin> <cmd> --help`. Type is "bool" for a flag
 * printed with no type token (Go's flag package omits it only for flag.Bool) and the printed token
 * (string/int/int64/value) otherwise. This is the binary's own declaration of its interface, not a guess at
 * one, which is what makes it safe to use both for the flag-name check and for building a syntactically
 * valid dummy argument list.
 */
export function readerFlagTypes(bin, cmd) {
  const { output } = runCapture(bin, [cmd, "--help"]);
  const types = new Map();
  for (const m of output.matchAll(/^ {2}-([a-zA-Z][\w-]*)(?:[ \t]+(\S+))?$/gm)) types.set(m[1], m[2] ?? "bool");
  return types;
}

// ---------------------------------------------------------------------------------------------------------
// Turning one extracted invocation into a real argv and running it, then classifying the binary's own
// output. Only two rejection shapes are recognised as findings; everything else (including a "no such
// file" from a deliberately fake path) means the flags and values under test were accepted.
// ---------------------------------------------------------------------------------------------------------

const UNKNOWN_FLAG = /flag provided but not defined:\s*-(\S+)/;
const UNKNOWN_SINK = /unknown --sink "([^"]*)"[^\n]*/;
const UNKNOWN_COMMAND = /unknown command "([^"]*)"/;

/** Reassembles a bracketed placeholder ("<value from ... in>") into one token, and substitutes a syntactically valid dummy for an int-typed flag's placeholder so Go's flag parser fails on the thing under test and nothing else. */
function buildArgs(cmd, tokens, flagTypes) {
  const args = [cmd];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    const flagMatch = /^--([a-zA-Z][\w-]*)/.exec(tok);
    if (flagMatch === null) {
      args.push(tok);
      i++;
      continue;
    }
    args.push(tok);
    const type = flagTypes.get(flagMatch[1]);
    if (type === "bool" || type === undefined) {
      // Unknown or boolean: no value token to consume. An unrecognised flag is exactly what this gate
      // exists to catch, and the binary itself will say so once run; guessing a value for it here would
      // only feed it something extraneous.
      i++;
      continue;
    }
    i++;
    if (i >= tokens.length) continue;
    let value = tokens[i];
    if (value.startsWith("<") && !value.endsWith(">")) {
      i++;
      while (i < tokens.length && !tokens[i - 1].endsWith(">")) {
        value += ` ${tokens[i]}`;
        i++;
      }
    } else {
      i++;
    }
    if ((type === "int" || type === "int64") && value.startsWith("<")) value = "1";
    args.push(value);
  }
  return args;
}

/**
 * Drops "--receipt <path>" and "--receipt-signer <path>" (flag plus its one value token) from `tokens`.
 *
 * WHY. Both are validated EAGERLY, ahead of the --sink switch: restore opens the receipt-signer key file
 * before it ever looks at --sink, so a run carrying a placeholder --receipt-signer path fails on "open
 * signer.pub: no such file" and never reaches the sink check at all. Measured directly: the exact
 * argv this gate built for offline-recovery.ts's first restore block, with a deliberately reintroduced
 * `--sink stdout`, still exited on the receipt-signer file-open error and never printed "unknown --sink" -
 * a false PASS on the very defect this gate exists to catch. Neither flag affects what --sink accepts, so
 * dropping them for the sink probe only removes a mask; it never hides a real finding, because their own
 * flag NAMES are still checked in full on the un-dropped run validateInvocation makes first.
 */
function dropReceiptFlags(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--receipt" || tokens[i] === "--receipt-signer") {
      i++; // also skip its value token
      continue;
    }
    out.push(tokens[i]);
  }
  return out;
}

/** Validates one extracted invocation against the built binary. Returns null on a pass, or a finding string. */
export function validateInvocation(inv, bin, subcommands, flagTypeCache) {
  const where = `${inv.file}:${inv.line}`;
  if (!subcommands.has(inv.cmd)) {
    return `${where}  \`downpipe ${inv.cmd}\` is not a subcommand this binary has (known: ${[...subcommands].sort().join(", ")})`;
  }
  if (!flagTypeCache.has(inv.cmd)) flagTypeCache.set(inv.cmd, readerFlagTypes(bin, inv.cmd));
  const flagTypes = flagTypeCache.get(inv.cmd);

  // Pass 1: the full invocation exactly as printed. Go's flag.Parse rejects an unrecognised flag NAME at
  // parse time, atomically, before any business logic runs, so this run is authoritative for flag names
  // and for the subcommand name regardless of what runs after parsing.
  const { output } = runCapture(bin, buildArgs(inv.cmd, inv.tokens, flagTypes));

  const badFlag = UNKNOWN_FLAG.exec(output);
  if (badFlag !== null) {
    return `${where}  \`downpipe ${inv.cmd} --${badFlag[1]}\` is rejected by the binary: "${output.trim().split("\n").pop()}"`;
  }
  const badCmd = UNKNOWN_COMMAND.exec(output);
  if (badCmd !== null) {
    return `${where}  \`downpipe ${inv.cmd}\` is rejected by the binary: "${badCmd[0]}"`;
  }
  const badSinkOnFullRun = UNKNOWN_SINK.exec(output);
  if (badSinkOnFullRun !== null) {
    return `${where}  --sink "${badSinkOnFullRun[1]}" is rejected by the binary: "${badSinkOnFullRun[0]}"`;
  }

  // Pass 2, only when a sink value is under test: a minimal probe with the receipt flags dropped, so a
  // placeholder --receipt-signer path cannot mask the sink switch this gate needs to reach. Flag names were
  // already fully checked in Pass 1; this pass exists only to get far enough into the reader's own logic to
  // see what it thinks of the sink value.
  if (inv.tokens.includes("--sink")) {
    const probeArgs = buildArgs(inv.cmd, dropReceiptFlags(inv.tokens), flagTypes);
    const { output: probeOutput } = runCapture(bin, probeArgs);
    const badSink = UNKNOWN_SINK.exec(probeOutput);
    if (badSink !== null) {
      return `${where}  --sink "${badSink[1]}" is rejected by the binary: "${badSink[0]}"`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Self-test: fixture invocations run against the real built binary, so this exercises the same execution
// path the gate itself uses rather than a mock of it. Needs the reader sibling and `go`, the same as the
// gate proper; it refuses (exit 2) rather than passing vacuously when either is missing, which is the same
// posture the gate takes on its own subject.
// ---------------------------------------------------------------------------------------------------------

function selfTest() {
  let held = 0;
  let broke = 0;
  const expect = (label, cond) => {
    if (cond) {
      held++;
      console.log(`  PASS  ${label}`);
    } else {
      broke++;
      console.log(`  FAIL  ${label}`);
    }
  };

  // Pure-function fixtures: no binary needed, and the empty-extraction refusal is checked here as a
  // property of the extractor rather than by actually running the gate with no source files.
  expect("empty text yields no lines.push invocations", extractLinesPushLiterals("").length === 0);
  expect("empty text yields no codeBlock invocations", extractCodeBlockLiterals("").length === 0);
  expect("a source file with no downpipe line has no candidate invocations", (() => {
    const inv = invocationsFromJoined(flattenAndJoin(extractCodeBlockLiterals('codeBlock("plain prose, no CLI here")')), "fixture.ts");
    return inv.length === 0;
  })());
  // Fixture source text is built from an explicit, named single backslash rather than a hand-escaped
  // blob, because getting this count wrong by eye is easy to do and hard to notice: the console's own
  // continuation convention is "one raw backslash in the DECODED text", which a codeBlock literal spells
  // as three raw source bytes (\, \, \n, an escaped backslash then an escaped newline) and a lines.push
  // literal spells as two (\, \, an escaped backslash, with the real newline supplied later by
  // lines.join("\n")). BACKSLASH makes each count countable rather than guessed.
  const BACKSLASH = "\\";
  expect(
    "a line-continued codeBlock is joined into one invocation with every flag",
    (() => {
      const src = `codeBlock("downpipe restore --apply ${BACKSLASH}${BACKSLASH}${BACKSLASH}n  --sink file ${BACKSLASH}${BACKSLASH}${BACKSLASH}n  --archive <dir>")`;
      const inv = invocationsFromJoined(flattenAndJoin(extractCodeBlockLiterals(src)), "fixture.ts");
      return inv.length === 1 && inv[0].cmd === "restore" && inv[0].tokens.includes("--sink") && inv[0].tokens.includes("--archive");
    })(),
  );
  expect(
    "consecutive lines.push calls with a trailing backslash join across calls",
    (() => {
      const src = `lines.push("  downpipe restore --apply --run <runId> ${BACKSLASH}${BACKSLASH}");\nlines.push("      --identity identity.key --signer signer.pub");\n`;
      const inv = invocationsFromJoined(flattenAndJoin(extractLinesPushLiterals(src)), "fixture.ts");
      return inv.length === 1 && inv[0].tokens.includes("--identity");
    })(),
  );

  const root = resolveDownpipeRoot();
  if (root === null || !haveGo()) {
    console.log(
      `\n  SKIPPED the binary-execution fixtures: ${root === null ? "no downpipe sibling resolved" : "`go` is not on PATH"}.\n` +
        "  The pure-extraction fixtures above still ran. The gate itself refuses (exit 2) under the same\n" +
        "  condition rather than reporting a pass it could not check.",
    );
    console.log(`\nreader-command-truth self-test (partial): ${held} of ${held + broke} assertions held.`);
    return broke === 0 ? 0 : 1;
  }

  let bin;
  try {
    bin = buildReader(root);
  } catch (e) {
    console.log(`\n  SKIPPED the binary-execution fixtures: the reader would not build: ${/** @type {Error} */ (e).message}`);
    console.log(`\nreader-command-truth self-test (partial): ${held} of ${held + broke} assertions held.`);
    return broke === 0 ? 0 : 1;
  }
  const subcommands = readerSubcommands(bin);
  const flagTypeCache = new Map();

  const unknownFlag = validateInvocation(
    { file: "fixture.ts", line: 1, cmd: "restore", tokens: ["--apply", "--run", "<runId>", "--archive", "<dir>", "--identity", "identity.key", "--signer", "signer.pub", "--sink", "file", "--out", "<dir>", "--bogus-flag"] },
    bin,
    subcommands,
    flagTypeCache,
  );
  expect("an unknown flag is a finding naming the flag and the binary's own error", unknownFlag?.includes("--bogus-flag") && unknownFlag.includes("flag provided but not defined"));

  const unknownSink = validateInvocation(
    { file: "fixture.ts", line: 2, cmd: "restore", tokens: ["--apply", "--run", "<runId>", "--archive", "<dir>", "--identity", "identity.key", "--signer", "signer.pub", "--sink", "stdout"] },
    bin,
    subcommands,
    flagTypeCache,
  );
  expect("an unknown sink value is a finding naming the value and the binary's own error", unknownSink?.includes('"stdout"') && unknownSink.toLowerCase().includes("rejected"));

  const validCommand = validateInvocation(
    { file: "fixture.ts", line: 3, cmd: "keys", tokens: ["--which", "--archive", "<dir>"] },
    bin,
    subcommands,
    flagTypeCache,
  );
  expect("a valid command with real flags is a pass", validCommand === null);

  const validWithIntPlaceholder = validateInvocation(
    { file: "fixture.ts", line: 4, cmd: "restore", tokens: ["--apply", "--run", "<runId>", "--archive", "<dir>", "--identity", "identity.key", "--signer", "signer.pub", "--min-runlog-index", "<value", "from", "the", "field", "above,", "if", "you", "filled", "it", "in>"] },
    bin,
    subcommands,
    flagTypeCache,
  );
  expect("a bracketed placeholder for an int flag is substituted, not a false finding", validWithIntPlaceholder === null);

  console.log(`\nreader-command-truth self-test: ${held} of ${held + broke} assertions held.`);
  return broke === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------------------
// The gate proper.
// ---------------------------------------------------------------------------------------------------------

function gate() {
  const root = resolveDownpipeRoot();
  if (root === null) {
    console.error(
      "[reader-command-truth] REFUSED: no downpipe (offline reader) checkout resolved beside this console\n" +
        "  checkout. Point DOWNPIPES_DOWNPIPE at one, or check the reader out as a workspace sibling.",
    );
    process.exit(2);
  }
  if (!haveGo()) {
    console.error("[reader-command-truth] REFUSED: `go` is not on PATH, so the reader cannot be built to check against.");
    process.exit(2);
  }

  let bin;
  try {
    bin = buildReader(root);
  } catch (e) {
    console.error(`[reader-command-truth] REFUSED: the reader at ${root} would not build:\n${/** @type {Error} */ (e).message}`);
    process.exit(2);
  }

  const invocations = extractAll();

  console.log(`[reader-command-truth] population: ${invocations.length} invocation(s) extracted from ${KNOWN_FILES.join(", ")}:`);
  for (const inv of invocations) console.log(`  ${inv.file}:${inv.line}  downpipe ${inv.cmd} ${inv.tokens.join(" ")}`);

  if (invocations.length === 0) {
    console.error(
      "\n[reader-command-truth] REFUSED: extraction found zero invocations. Either every command block was\n" +
        "  removed from the files this gate parses (unlikely, and worth checking by hand), or the extractor\n" +
        "  itself broke on a source edit. Either way, nothing was checked, which is not the same as a pass.",
    );
    process.exit(2);
  }

  // Known-positive control: a specific expected member of the population, not merely a non-zero count, so
  // a change to codeBlock/lines.push that silently stopped matching (a rename, a reformat) is caught even
  // though `invocations.length` would still read as non-zero from an unrelated command.
  const control = invocations.find((inv) => inv.cmd === "restore" && inv.tokens.includes("--apply") && inv.tokens.includes("--archive"));
  if (control === undefined) {
    console.error(
      "\n[reader-command-truth] REFUSED: the known-positive control did not fire (no extracted `downpipe\n" +
        "  restore --apply ... --archive ...`), which this panel and this sheet have printed since the\n" +
        "  restore-writes-nothing-without---apply fix. The extractor is not finding real commands.",
    );
    process.exit(2);
  }
  console.log(`\n[reader-command-truth] known-positive control held: ${control.file}:${control.line} carries \`downpipe restore --apply\`.`);

  const coverage = srcFilesWithCandidateInvocations(SRC);
  const uncovered = coverage.filter((f) => !KNOWN_FILES.includes(f));
  const findings = [];
  if (uncovered.length > 0) {
    findings.push(
      `${uncovered.length} file(s) outside this gate's known set carry a candidate downpipe invocation and are\n` +
        `  not checked: ${uncovered.join(", ")}. Extend KNOWN_FILES and its extractor rather than ignoring them.`,
    );
  }

  const subcommands = readerSubcommands(bin);
  if (subcommands.size < 8) {
    console.error(`[reader-command-truth] REFUSED: the built binary's own usage listed only ${subcommands.size} subcommand(s), which is implausibly few. The build or the usage text has moved.`);
    process.exit(2);
  }
  const flagTypeCache = new Map();

  for (const inv of invocations) {
    const finding = validateInvocation(inv, bin, subcommands, flagTypeCache);
    if (finding !== null) findings.push(finding);
  }

  if (findings.length > 0) {
    console.error(`\n[reader-command-truth] FAIL: ${findings.length} finding(s):\n`);
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
  }

  console.log(`\n[reader-command-truth] OK: all ${invocations.length} extracted invocation(s) accepted by the reader at ${root}, ${coverage.length === KNOWN_FILES.length ? "and no other file carries an unchecked one" : "coverage sweep clean"}.`);
}

if (isEntryModule(import.meta.url)) {
  if (process.argv.includes("--self-test")) process.exit(selfTest());
  else gate();
}
