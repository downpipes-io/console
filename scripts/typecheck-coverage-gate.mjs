#!/usr/bin/env node
// Every TypeScript file in this repo must be type-checked by something a gating chain runs.
//
// THE FAILURE THIS GUARDS AGAINST. A tsconfig that includes only "src" leaves the test/ tree checked by
// nothing, so type errors there can accumulate without ever producing a red build. Excluding a directory on
// the reasoning that "those files are type-checked by their own runner" does not hold either: vitest does
// not type-check unless `typecheck` is enabled in its config, so `vitest run` can execute a file without
// ever checking it. A src-only include and a runner exclusion together can leave a whole tree covered by
// nothing, with nothing saying so.
//
// Both halves of that failure are silent by construction. A file no config includes produces no error,
// and an exclusion looks deliberate and self-justifying in the config that carries it. The only way to
// see it is to compare what EXISTS against what tsc actually reads.
//
// So this gate does exactly that: it asks tsc which files it loads, and compares that against the files
// on disk. It does not parse `include` and `exclude` itself, because reimplementing tsc's resolution is
// how a gate ends up agreeing with a config that is wrong.
//
// The engine has a richer version of this (scripts/crossrepo-typecheck-gate.mjs) which also enforces
// containment between its single-repo and workspace configs. The console has no workspace config, its one
// cross-repo test resolving the sibling at runtime instead, so the rule here is the simpler one.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
// The chain CI runs. If a config stops being applied by it, coverage is academic.
const GATING_SCRIPT = "typecheck";

const SKIP_DIRS = new Set(["node_modules", ".worktrees", "dist", "coverage", ".wrangler", "public"]);

// One UNIT per type environment, because a single config cannot see every directory. scripts/ holds
// hand-written .mjs gates, and neither tsconfig.json (src only) nor tsconfig.test.json (src and test, both
// scanning for .ts) reads them, so a .mjs gate under scripts/ can sit invisible to the compiler while every
// other config reports clean. A gate whose own scan is narrower than the repo reads exactly like a passing
// gate, which is this file's whole subject.
//
// The floor per unit is a count, not a list: a unit that suddenly scans nothing must FAIL rather than pass.
const UNITS = [
  { config: "tsconfig.test.json", dirs: ["src", "test"], exts: [".ts", ".tsx"], floor: 200 },
  { config: "tsconfig.scripts.json", dirs: ["scripts"], exts: [".mjs", ".mts", ".cjs", ".js"], floor: 25 },
];

/** Every source file the unit's directories actually hold. */
function filesOnDisk(unit) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      // Declaration files carry no implementation, so an uncovered .d.ts/.d.mts is not the hole this looks
      // for. Everything else is.
      else if (unit.exts.some((e) => p.endsWith(e)) && !/\.d\.(ts|mts|cts)$/.test(p)) out.push(relative(ROOT, p));
    }
  };
  for (const d of unit.dirs) walk(join(ROOT, d));
  return out.sort();
}

/** Every file tsc loads for the config, as tsc itself reports them. */
function filesCheckedBy(config) {
  // --listFiles prints the full load set, which includes lib.d.ts and node_modules typings. Narrow it to
  // this repo's own sources. `|| true` is deliberate: --listFiles still prints its list when the project
  // has type errors, and this gate is about COVERAGE, not about whether the code currently checks clean.
  let stdout = "";
  try {
    stdout = execFileSync("npx", ["tsc", "-p", config, "--noEmit", "--listFiles"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    stdout = String(/** @type {any} */ (err).stdout ?? "");
    if (stdout.trim() === "") {
      // EXIT 2, NOT 1. tsc produced no --listFiles output at all, so this gate has no load set
      // to compare against and did not establish that any source is outside a project. Exit 1 would report a
      // coverage gap that no run measured. The catch above already lets a project with type ERRORS through,
      // because the list still prints then; reaching here means the instrument itself did not run.
      console.error(`CANNOT CHECK typecheck-coverage: could not read the file list for ${config}, so no source was compared against any project's load set.\n  Fix the tsc invocation or the config and re-run: npx tsc -p ${config} --noEmit --listFiles\n${String(/** @type {any} */ (err).stderr ?? err)}`);
      process.exit(2);
    }
  }
  const checked = new Set();
  for (const line of stdout.split("\n")) {
    const p = line.trim();
    if (p === "" || p.includes("/node_modules/")) continue;
    if (!p.startsWith(ROOT)) continue;
    checked.add(relative(ROOT, p));
  }
  return checked;
}

// Coverage is worth nothing if no chain applies the configs, so that is checked once, up front, before any
// per-unit result can read as a pass.
const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts ?? {};
const gating = scripts[GATING_SCRIPT] ?? "";

let bad = 0;
for (const unit of UNITS) {
  const onDisk = filesOnDisk(unit);
  const checked = filesCheckedBy(unit.config);
  const uncovered = onDisk.filter((f) => !checked.has(f));

  // A gate that scans nothing reads exactly like a passing gate, which is this file's whole subject, so
  // prove the unit had a corpus and prove tsc gave back a real load set.
  // BOTH FLOORS EXIT 2. Each says, in its own words, that the run had no corpus or no load set,
  // and the finding this gate reports is "a file on disk that this config does not read". Neither floor has
  // established one of those: the first means the directory walk found almost nothing, the second means the
  // list was not produced. Exit 1 on either would put a coverage finding's exit code on a run that never
  // compared a single file against a config.
  if (onDisk.length < unit.floor) {
    console.error(`CANNOT CHECK typecheck-coverage: ${unit.config} covers ${unit.dirs.join(", ")}, where ${unit.exts.join("/")} files should number at least ${unit.floor}; found only ${onDisk.length}. Has the layout moved? No file was compared against the config, so nothing here is a verdict on coverage.`);
    process.exit(2);
  }
  if (checked.size < unit.floor) {
    console.error(`CANNOT CHECK typecheck-coverage: ${unit.config} reported only ${checked.size} files, so the load set was probably not produced and nothing was compared against it.\n  Re-run it directly to see why: npx tsc -p ${unit.config} --noEmit --listFiles`);
    process.exit(2);
  }

  // A config CI never applies is a config that checks nothing, which is the second half of the original
  // failure: tsconfig.test.json existed for a while before any chain ran it.
  if (!gating.includes(unit.config) && !/typecheck:(test|scripts)/.test(gating)) {
    console.error(
      `FAIL typecheck-coverage: npm run ${GATING_SCRIPT} does not apply ${unit.config}, so nothing CI runs type-checks ${unit.dirs.join(", ")}.\n` +
        `  ${GATING_SCRIPT} = ${gating}`,
    );
    process.exit(1);
  }

  if (uncovered.length > 0) {
    bad += uncovered.length;
    console.error(`FAIL typecheck-coverage: ${uncovered.length} file(s) under ${unit.dirs.join(", ")} that ${unit.config} does not read:\n`);
    for (const f of uncovered) console.error(`  ${f}`);
    console.error(
      `\nEach is invisible to the compiler: a type error in it can never fail a build, and being executed by\n` +
        `a runner is not the same as being checked. Add it to ${unit.config}'s include, or if it genuinely\n` +
        `belongs to another type environment, give that environment a config and a chain that runs it. An\n` +
        `exclusion with a reason in a comment is still an exclusion, and the reason is what wants checking.`,
    );
    continue;
  }
  console.log(`ok   typecheck-coverage: all ${onDisk.length} file(s) under ${unit.dirs.join(", ")} are read by ${unit.config}, which npm run ${GATING_SCRIPT} applies`);
}

if (bad > 0) process.exit(1);
