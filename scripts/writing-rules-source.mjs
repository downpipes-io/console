#!/usr/bin/env node

/**
 * Writing-rules linter for SOURCE CODE (comments + dashes).
 *
 * Ported from the docs-site writing-rules-lint, adapted from Markdown prose to
 * source files. House style binds source comments too, per the GUARDRAILS comment
 * policy: "zero banned words".
 *
 * What is checked, and where:
 *   - Em dashes (U+2014) and en dashes (U+2013): the WHOLE file. They never
 *     appear in code syntax, only in comments or string literals, and house
 *     style bans them in both.
 *   - Banned words: COMMENTS ONLY, and only the unambiguous
 *     marketing terms. Words like `robust` ("robust to ordering"), `powerful`
 *     ("a role more powerful than itself") and American spellings like
 *     `authorization` (the HTTP header / OAuth field) and `color` (the CSS
 *     property) carry precise technical meaning in code, so they are NOT
 *     flagged here; the house spelling and full banned-word list stay enforced
 *     for Markdown prose and shipped UI copy by their own checks.
 *
 * Rule-of-three and the bold-term-colon list are Markdown-shaped and are not
 * applied to source.
 *
 * Usage:  node writing-rules-source.mjs [root ...]   (default root: "src")
 * Exit:   0 clean, 1 violations, 2 script failure, which includes a named root
 *         that is absent and a run that matched no file at all.
 */

import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
// Importing this ARMS the completion guard: see test/lib/verdict-guard.ts. The 29 gate scripts under
// scripts/ are exempt from that requirement, but the exemption is CONDITIONAL and this file broke the
// condition: it is exempt because those gates are straight-line synchronous scanners that reach their
// own bottom line, and this one reaches its bottom line inside an async main() whose promise the module
// FLOATS. The module body finishes the instant main() yields, so an await that never settles drains the
// loop and leaves at exit 0 with lint:prose green over nothing scanned. It is the only directly-invoked
// entry point outside test/ shaped that way, measured on this tree, and scripts/deps-installed-gate.mjs
// also imports the guard from here for the same reason. verdict-guard-gate.mjs derives this fact rather
// than relying on a sentence in a header.
import { verdictCannotCheck, verdictReached } from "../test/lib/verdict-guard.ts";

const ROOTS = process.argv.slice(2).length ? process.argv.slice(2) : ["src"];
const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".wrangler",
  ".astro",
  ".git",
  "worker-dist",
  "vendor",
  "build",
]);

const BANNED_AI_WORDS = [
  "delve",
  "utilize",
  "utilise",
  "leverage",
  "seamless",
  "comprehensive",
  "crucial",
  "pivotal",
  "transformative",
  "groundbreaking",
  "holistic",
  "nuanced",
  "paradigm",
  "testament",
  "cornerstone",
  "catalyst",
  "effortless",
  "cutting-edge",
];

/* Walk a directory tree yielding source files. */
async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(p);
    } else if (entry.isFile() && EXTS.some((e) => p.endsWith(e))) {
      yield p;
    }
  }
}

/**
 * Scan source into comment spans. A small state machine tracks code, string
 * and template literals (so a `//` inside a string is not a comment) and emits
 * each line and block comment with its starting line number.
 */
function extractComments(src) {
  const comments = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let state = "code";
  let quote = "";
  let buf = "";
  let bufLine = 0;
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : "";
    if (state === "code") {
      if (c === "/" && c2 === "/") {
        state = "line";
        buf = "";
        bufLine = line;
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        state = "block";
        buf = "";
        bufLine = line;
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        state = "str";
        quote = c;
        i += 1;
        continue;
      }
      if (c === "\n") line += 1;
      i += 1;
      continue;
    }
    if (state === "str") {
      if (c === "\\") {
        if (c2 === "\n") line += 1;
        i += 2;
        continue;
      }
      if (c === quote) {
        state = "code";
        i += 1;
        continue;
      }
      if (c === "\n") line += 1;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        comments.push({ line: bufLine, text: buf });
        state = "code";
        line += 1;
        i += 1;
        continue;
      }
      buf += c;
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") {
        comments.push({ line: bufLine, text: buf });
        state = "code";
        i += 2;
        continue;
      }
      if (c === "\n") line += 1;
      buf += c;
      i += 1;
    }
  }
  if (state === "line") comments.push({ line: bufLine, text: buf });
  return comments;
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") line += 1;
  return line;
}

async function lintFile(abs, _root, hits) {
  const rel = relative(process.cwd(), abs);
  const src = await fs.readFile(abs, "utf8");

  // Dashes: whole file.
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "—") hits.push({ file: rel, line: lineOf(src, i), rule: "em-dash" });
    else if (src[i] === "–") hits.push({ file: rel, line: lineOf(src, i), rule: "en-dash" });
  }

  // Claim rules: whole file. These catch a FALSE claim rather than a style slip, so they are not confined
  // to comments; a wrong sentence in a docs page under docs/ is exactly the case.
  //
  // recovery-offline-only. The break-glass-only posture does NOT move recovery offline: the console ships
  // a break-glass restore panel for that posture, taking the key in the browser and wiping it after, and
  // the engine refuses a restore only when it has NEITHER an operational key NOR a browser-supplied
  // master. The claim was found on seven separate surfaces during the operational-key workstream,
  // including this repo's own docs/OPERATIONS.md, which is why it is a rule rather than an eighth
  // correction. It also implies a terminal step, against the rule that the portal completes every
  // customer action.
  //
  // It matches the SHAPE OF THE CLAIM ("recovery is/becomes/stays offline-only"), not mere proximity of
  // the words. Proximity was tried first and was too noisy to ship: within a 90-character window it fired
  // on "the offline reader is offline-only", which is TRUE by construction, and on "an offline-only
  // rehearsal ... a restore is exercised then", which is fine. A gate that flags true sentences trains
  // people to ignore it. Requiring recovery or restore to be the SUBJECT keeps those clean while still
  // catching the claim, and an adjacent negator clears an honest contrast ("recovery is not offline-only").
  for (const m of src.matchAll(/\b(recovery|restores?|restoring)\b(?:\s+\w+){0,3}?\s+(?:is|are|was|were|becomes?|remains?|stays?)\s+(?:then\s+|therefore\s+|effectively\s+)?(?:not\s+|never\s+)?offline[-\s]?only\b/gi)) {
    if (/\b(not|never)\s+offline[-\s]?only\b/i.test(m[0])) continue;
    hits.push({ file: rel, line: lineOf(src, m.index), rule: "claim:recovery-offline-only" });
  }

  // Banned marketing words: comments only.
  const comments = extractComments(src);
  for (const { line, text } of comments) {
    for (const word of BANNED_AI_WORDS) {
      const re = new RegExp(`\\b${word.replace(/[-]/g, "\\$&")}\\b`, "gi");
      if (re.test(text)) hits.push({ file: rel, line, rule: `banned-word:${word}` });
    }
  }
}

// ANTI-VACUITY. The exit code alone cannot distinguish a clean scan from a scan of nothing: walk() swallows
// ENOENT, so a root that is renamed, moved or mistyped would scan NOTHING and report "0 violations" with exit
// 0. Two separate floors guard this, because they fail differently: a named root that is not there is a
// caller error and stops the run, and a run that reaches the end having read no file at all proved nothing
// whatever the roots said.
async function main() {
  const hits = [];
  let scanned = 0;
  for (const root of ROOTS) {
    let stat;
    try {
      stat = await fs.stat(root);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") throw err;
      console.error(`writing-rules-source: root '${root}' does not exist, so nothing under it was checked.`);
      verdictCannotCheck(); // declares the refusal and leaves at exit 2, unchanged
    }
    if (stat.isFile()) {
      if (EXTS.some((e) => root.endsWith(e))) {
        await lintFile(root, root, hits);
        scanned += 1;
      }
      continue;
    }
    for await (const abs of walk(root)) {
      await lintFile(abs, root, hits);
      scanned += 1;
    }
  }
  if (scanned === 0) {
    console.error(`writing-rules-source: 0 files matched under ${ROOTS.join(", ")}, so this check proved nothing.`);
    verdictCannotCheck(); // declares the refusal and leaves at exit 2, unchanged
  }
  if (hits.length === 0) {
    console.log(`writing-rules-source: 0 violations across ${scanned} file(s)`);
    // `scanned` is passed EXPLICITLY because this file is quiet on a pass: its one clean-run line is not
    // assertion-shaped, so the guard's output floor would read a full scan as having checked nothing.
    verdictReached(0, scanned);
    return;
  }
  const byRule = new Map();
  for (const h of hits) byRule.set(h.rule, (byRule.get(h.rule) ?? 0) + 1);
  console.error(`writing-rules-source: ${hits.length} violations`);
  console.error("");
  for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
    console.error(`[${rule}] ${count}`);
    for (const h of hits.filter((x) => x.rule === rule).slice(0, 8)) {
      console.error(`  ${h.file}:${h.line}`);
    }
  }
  verdictReached(hits.length, scanned);
  process.exit(1);
}

main().catch((err) => {
  console.error("writing-rules-source script failure:", err);
  // A throw is a run that did not answer its question, which is exit 2 rather than exit 1, and the
  // exit code is unchanged. What is new is that the refusal is DECLARED, so the guard does not print
  // its undeclared-verdict complaint on top of a failure that has just explained itself.
  verdictCannotCheck();
});
