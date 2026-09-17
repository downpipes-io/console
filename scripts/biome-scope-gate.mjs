#!/usr/bin/env node

/**
 * Biome scope gate: the lint chain must cover everything biome.json declares, and the run must be
 * clean at EVERY severity.
 *
 * WHY THIS EXISTS. biome.json's files.includes and the chain that invokes biome can drift apart: the
 * config can declare a wider scope than `npm run lint` actually calls biome over, so part of the
 * declared scope is linted nowhere. That gap can sit unnoticed in exactly the directories that hold
 * this repo's gates and validators, with the config stating a rule that nothing enforces.
 *
 * Widening the chain fixes one instance. This file fixes the SHAPE: after this, the declared scope
 * and the linted scope cannot disagree without the gate saying so.
 *
 * SECOND THING IT FIXES. `biome lint --error-on-warnings` exits 0 on informational diagnostics, so a
 * CI step whose name promises "0 errors / 0 warnings / 0 infos" can still pass while carrying infos:
 * a file whose only finding is an info exits 0 with and without the flag. So the verdict here is taken
 * from the reported diagnostic count rather than from biome's exit code, and an info fails like
 * anything else.
 *
 * THIRD. biome.json is not inside its own files.includes, so nothing lints the config that decides
 * what gets linted, even though the config file itself can carry findings. It is linted here.
 *
 * WHAT IT CHECKS
 *   1. Every non-negated entry in biome.json files.includes names a directory that exists and holds
 *      at least one file biome would lint. A declared scope pointing at nothing is not a pass.
 *   2. The paths in package.json's `lint:fix` biome invocation are exactly that set, so the fix
 *      command and the config cannot drift apart either.
 *   3. Biome itself, run over that set plus biome.json, reports zero diagnostics at any severity.
 *   4. Floors: at least MIN_ROOTS declared roots and at least MIN_FILES files actually checked. A
 *      renamed directory or an includes list emptied by an edit reads exactly like a clean tree
 *      otherwise, which is the failure the gap above already demonstrated.
 *
 * Usage:  node scripts/biome-scope-gate.mjs
 * Exit:   0 clean; 1 a scope mismatch or a lint finding; 2 the gate could not check (unreadable
 *         config, a declared root that is not there, a floor tripped, biome failed to run).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// FLOORS. See the header: "0 findings" over an empty scan is the same sentence as "0 findings" over
// a clean tree. Both floors sit well under the real number of declared roots and checked files, so
// ordinary deletion does not trip them while a renamed root or a truncated includes list does.
const MIN_ROOTS = 2;
const MIN_FILES = 300;

// biome.json decides what biome lints, and it is not inside its own files.includes, so it is linted
// nowhere unless it is named. Named here rather than added to includes: putting the config inside
// its own scope is a loop other repos here do not have, and the compare in check 2 below is against
// the declared ROOTS, which this is not.
const EXTRA_LINT_PATHS = ["biome.json"];

// The extensions biome lints in this repo. Used only for the "this root holds something" check.
const LINTABLE = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".json", ".jsonc"];

/** @returns {never} fail always exits, which is what lets the callers below use a matched group unchecked. */
function fail(code, ...lines) {
  for (const l of lines) console.error(`biome-scope-gate: ${l}`);
  process.exit(code);
}

// biome.json is JSONC: biome accepts comments in it, and this repo uses them. Strip line comments
// that are not inside a string before parsing, rather than pulling in a dependency for it.
function parseJsonc(text, label) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  try {
    return JSON.parse(out);
  } catch (err) {
    fail(2, `cannot parse ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// An include entry such as "src/**" or "test/**" declares the root "src" or "test". Negated entries
// ("!**/.worktrees") exclude rather than declare, so they are not roots.
function rootOf(entry) {
  return entry.replace(/\/\*\*.*$/, "").replace(/\/$/, "");
}

function hasLintableFile(dir) {
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".worktrees") continue;
        stack.push(p);
      } else if (LINTABLE.some((ext) => e.name.endsWith(ext))) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. The declared scope.
// ---------------------------------------------------------------------------
const configPath = join(ROOT, "biome.json");
if (!existsSync(configPath)) fail(2, "biome.json is not there, so there is no declared scope to check against.");
const config = parseJsonc(readFileSync(configPath, "utf8"), "biome.json");

const includes = config?.files?.includes;
if (!Array.isArray(includes)) {
  fail(2, "biome.json declares no files.includes array. Without it this gate has nothing to compare the chain to.");
}
const declared = includes.filter((e) => typeof e === "string" && !e.startsWith("!")).map(rootOf);
const declaredSet = [...new Set(declared)].sort();

if (declaredSet.length < MIN_ROOTS) {
  fail(
    2,
    `biome.json declares ${declaredSet.length} scope root(s), expected at least ${MIN_ROOTS}.`,
    "An includes list this short means the scope has been narrowed rather than that the tree is clean.",
  );
}

for (const root of declaredSet) {
  const abs = join(ROOT, root);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    fail(2, `biome.json declares the scope root "${root}", which is not a directory here. Fix the includes list or restore the directory.`);
  }
  if (!hasLintableFile(abs)) {
    fail(2, `the declared scope root "${root}" holds no file biome would lint, so linting it proves nothing.`);
  }
}

// ---------------------------------------------------------------------------
// 2. The scope the fix command uses.
// ---------------------------------------------------------------------------
const pkg = parseJsonc(readFileSync(join(ROOT, "package.json"), "utf8"), "package.json");
const fixScript = pkg?.scripts?.["lint:fix"];
if (typeof fixScript !== "string") {
  fail(2, "package.json has no lint:fix script, so the second half of this cross-check cannot run.");
}
const fixMatch = /\bbiome\s+lint\s+([^&|]*)/.exec(fixScript);
if (fixMatch === null) {
  fail(2, `package.json lint:fix does not invoke "biome lint", so there is nothing to compare: ${fixScript}`);
}
const fixPaths = fixMatch[1]
  .split(/\s+/)
  .map((t) => t.trim())
  .filter((t) => t !== "" && !t.startsWith("-"))
  .sort();

if (fixPaths.length === 0) {
  fail(
    1,
    "package.json lint:fix runs `biome lint` with no explicit path.",
    "A bare invocation walks the repository root, where another session's worktree carrying its own biome.json makes biome exit on a nested-root CONFIGURATION error rather than lint. Name the roots.",
  );
}
if (fixPaths.join(",") !== declaredSet.join(",")) {
  fail(
    1,
    "the declared scope and the scope lint:fix repairs do not match.",
    `  biome.json files.includes: ${declaredSet.join(", ")}`,
    `  package.json lint:fix:     ${fixPaths.join(", ")}`,
    "This is the exact drift this gate exists for: a scope declared in one place and acted on in another.",
  );
}

// ---------------------------------------------------------------------------
// 3. The lint itself, over the declared scope plus the config, clean at every severity.
// ---------------------------------------------------------------------------
for (const extra of EXTRA_LINT_PATHS) {
  if (!existsSync(join(ROOT, extra))) {
    fail(2, `${extra} is named for linting here but is not on disk, so this run would silently check less than it says.`);
  }
}
const lintPaths = [...declaredSet, ...EXTRA_LINT_PATHS];
const args = ["biome", "lint", ...lintPaths, "--error-on-warnings", "--reporter=json", "--max-diagnostics=5000"];
const run = spawnSync("npx", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (run.error) fail(2, `could not run biome: ${run.error.message}`);

let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  fail(
    2,
    "biome did not return a JSON report, so this run checked nothing.",
    `exit status ${run.status}`,
    (run.stderr || run.stdout || "").trim().split("\n").slice(0, 20).join("\n"),
  );
}

const checked = (report.summary?.unchanged ?? 0) + (report.summary?.changed ?? 0);
if (checked < MIN_FILES) {
  fail(
    2,
    `biome checked ${checked} file(s) across ${lintPaths.join(", ")}, expected at least ${MIN_FILES}.`,
    "A clean verdict over a scan this small says nothing about the tree.",
  );
}

const diagnostics = report.diagnostics ?? [];
const { errors = 0, warnings = 0, infos = 0 } = report.summary ?? {};
if (diagnostics.length > 0 || errors > 0 || warnings > 0 || infos > 0) {
  console.error(
    `biome-scope-gate: ${errors} error(s), ${warnings} warning(s) and ${infos} info(s) across ${lintPaths.join(", ")}. All three must be zero.`,
  );
  // Re-run with the default reporter so the findings read the way biome normally prints them.
  const pretty = spawnSync("npx", ["biome", "lint", ...lintPaths, "--error-on-warnings"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  console.error(pretty.stdout ?? "");
  console.error(pretty.stderr ?? "");
  process.exit(1);
}

console.log(
  `biome-scope-gate: ${checked} file(s) checked across ${declaredSet.length} declared scope root(s) (${declaredSet.join(", ")}) plus ${EXTRA_LINT_PATHS.join(", ")}; 0 errors, 0 warnings, 0 infos.`,
);
process.exit(0);
