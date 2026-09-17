#!/usr/bin/env node
// The installed tree must match the lockfile, so a stale install is named rather than mistaken for broken
// code.
//
// WHAT THIS IS FOR. Taking a lockfile change, by pulling main or by merging a branch, leaves node_modules
// behind the lock. The next gate run then fails with exit 127, which is the shell saying a binary is not
// there, and 127 looks exactly like a test failure in a chain of `npm run` steps: astro, biome or a docs
// build coming back 127 after a merge reads as a real failure for a moment, when it is one install away.
//
// The signal is npm's own record. node_modules/.package-lock.json is what npm wrote when it last
// installed, so comparing it against package-lock.json says whether the tree on disk is the tree the lock
// describes. No network, no install, no resolution: two JSON files.
//
// TWO EXCLUSIONS, and both are needed or this reports a fault on every machine:
//   - optional packages, which npm is entitled not to install
//   - packages gated on os/cpu, the platform-specific binaries every toolchain ships for other systems: a
//     large share of any lockfile's entries, so without this exclusion the check is pure noise.
//
// THE MESSAGE MATTERS AS MUCH AS THE COMPARISON. A true finding that every reader has to personally
// re-derive before trusting it costs more than it saves, and it is one step from becoming the red everyone
// learns to skip. So the remedy is stated FIRST, before the list of names, and the headline says which step
// of `npm run lint` failed and which of the remaining steps therefore did not run. Every failure and
// refusal path declares its own verdict rather than exiting silently.
//
// NAMING THEM ALL, up to a cap high enough never to bite in practice. A short cap that truncates the list
// while a headline count still states the true total prints a number the names underneath it contradict,
// so the cap here is set high and stated explicitly whenever it applies.
//
// EXIT CODES ARE THREE-VALUED HERE, deliberately. 0 is a checked pass. 1 is a definite negative finding
// with a remedy: the tree and the lock disagree, or nothing is installed at all. 2 is a REFUSAL, meaning
// the gate could not form an opinion, and it is used only where that is true: a lockfile that is absent or
// unreadable, an install record that will not parse, or two files that parse but describe nothing to
// compare. A stale tree is NOT a refusal. This gate verifies the environment, so an environment that is
// merely wrong is its finding rather than an obstacle to it.
//
// THE TWO JSON.parse CALLS ARE GUARDED, and that is the whole reason exit 2 exists here. Unguarded, a
// truncated install record left behind by an interrupted npm throws a stack trace and leaves exit 1
// standing, which is could-not-check wearing a failure's costume: the reader is told the tree is stale by
// a gate that never compared anything.
//
// WHY THIS COPY ARMS THE COMPLETION GUARD when the sibling copies in the engine and the harness cannot.
// Those repositories have no guard module, so a static import would crash the gate at load. Console has
// one, at test/lib/verdict-guard.ts, and it carries the verdictCannotCheck that exit 2 wants. Console's
// scripts/verdict-guard-gate.mjs does not REQUIRE gates under scripts/ to enrol, since they are
// straight-line and synchronous; enrolling is still worth it here, because it puts this gate's outcome on
// the same greppable VERDICT line as the other 188 entry points rather than leaving it to be inferred from
// an exit code. Arming carries an obligation, met below: every path that terminates declares first.
//
// Run: node scripts/deps-installed-gate.mjs
//      node scripts/deps-installed-gate.mjs --self-test
//
// It writes nothing, anywhere.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isEntryModule } from "./entry-module.mjs";
// Importing this ARMS the completion guard: see test/lib/verdict-guard.ts. Console already exports
// isEntryModule above rather than re-deriving the realpath rule, for the same reason: one copy of a rule.
import { verdictCannotCheck, verdictReached } from "../test/lib/verdict-guard.ts";

/** How many names to print before summarising the rest. See the header for why five was too few. */
const NAME_CAP = 20;

const ROOT = new URL("..", import.meta.url).pathname;
const LOCK = join(ROOT, "package-lock.json");
const INSTALLED = join(ROOT, "node_modules", ".package-lock.json");

/**
 * gradeTree is the whole comparison and it is PURE, so the failure path has a positive control that
 * exercises the failure path rather than only the pass. Every branch that decides an exit code below is
 * reachable from here with plain objects.
 *
 * The value type carries `name` because the ROOT entry of a real lockfile is keyed "" and holds the
 * project's own name rather than a dependency. That entry is skipped below, and the type has to admit it
 * or the fixtures cannot describe the file this function actually reads.
 *
 * @param {Record<string, {version?: string, optional?: boolean, os?: unknown, cpu?: unknown, name?: string}>} lockPackages
 *   the `packages` map from package-lock.json
 * @param {Record<string, {version?: string, name?: string}>} installedPackages the `packages` map from
 *   npm's install record
 */
// NOT exported. The self-test lives in this file, so nothing outside it imports this, and an export with
// no importer is what console's knip run flags.
function gradeTree(lockPackages, installedPackages) {
  const have = new Map();
  for (const [k, v] of Object.entries(installedPackages ?? {})) {
    if (k) have.set(k, v.version);
  }
  const want = new Map();
  for (const [k, v] of Object.entries(lockPackages ?? {})) {
    if (!k) continue;
    if (v.optional === true) continue;
    if (v.os !== undefined || v.cpu !== undefined) continue;
    want.set(k, v.version);
  }
  const missing = [...want.keys()].filter((k) => !have.has(k));
  const mismatched = [...want.entries()]
    .filter(([k, v]) => have.has(k) && have.get(k) !== v)
    .map(([k]) => ({ name: k, lock: want.get(k), installed: have.get(k) }));
  return { want, have, missing, mismatched, failures: missing.length + mismatched.length };
}

/**
 * The message off a thrown value, without assuming it is an Error. A catch binding is `unknown` under
 * console's tsconfig.scripts.json, which covers scripts/ where a bare `tsc --noEmit` does not, so
 * `err.message` does not compile here even though it does in the docs copy of this gate.
 *
 * @param {unknown} err
 */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/** mtime as a plain ISO string, or null where the file has gone. Used to show WHICH side is older. */
function mtimeOf(path) {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * refuse ends the run at exit 2: the gate could not form an opinion. verdictCannotCheck DECLARES the
 * refusal and performs the exit itself, so the completion guard cannot fire on top of it with a message
 * about work that was never done.
 *
 * @param {string} detail
 * @returns {never}
 */
function refuse(detail) {
  verdictCannotCheck(detail);
}

/**
 * fail ends the run at exit 1 with a definite finding, declaring the verdict so the completion guard does
 * not print its own contradicting one over the top.
 *
 * `checks` must be positive. The guard refuses a verdict declared after zero units of work, correctly, so
 * a path that genuinely compared no lock entries still has to say what it DID check. The nothing-installed
 * path checked exactly one thing, whether anything is installed at all, and answered no.
 *
 * @param {number} failures
 * @param {number} checks
 * @param {string} body
 * @returns {never}
 */
function fail(failures, checks, body) {
  console.error(body);
  verdictReached(failures, checks);
  process.exit(1);
}

/**
 * The one line that stops a reader blaming their own code. Every failure and refusal opens with it.
 *
 * The position is DERIVED from package.json rather than typed in: a hard-coded ordinal is a
 * precise-sounding claim that rots the first time the chain is reordered, and naming a step or command
 * this repository does not have is exactly what erodes trust in this gate's messages.
 */
function notYourCode() {
  const fallback =
    "  This is a DEPENDENCY FRESHNESS finding, not a code-style one. It runs early in `npm run lint`, so\n" +
    "  Biome has not run yet and nothing here says anything about your code.";
  try {
    const steps = String(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts?.lint ?? "")
      .split("&&")
      .map((s) => s.trim());
    const at = steps.indexOf("npm run lint:deps-installed");
    if (at < 0) return fallback;
    const left = steps.length - at - 1;
    return (
      "  This is a DEPENDENCY FRESHNESS finding, not a code-style one. It is step\n" +
      `  ${at + 1} of ${steps.length} in \`npm run lint\`, so Biome has not run yet and nothing here says anything\n` +
      `  about your code. The remaining ${left} step${left === 1 ? "" : "s"} of that command did not run at all.`
    );
  } catch {
    return fallback;
  }
}

function main() {
  const NOT_YOUR_CODE = notYourCode();

  if (!existsSync(LOCK)) {
    refuse(
      `REFUSED deps-installed: there is no package-lock.json at ${LOCK}, so there is nothing to check the\n` +
        "  tree against.\n" +
        `${NOT_YOUR_CODE}\n\n` +
        "  Exit 2 rather than 1: this is the gate refusing to answer, not answering no. The console commits\n" +
        "  its lockfile, so an absent one means the checkout is incomplete rather than the tree stale.",
    );
  }

  // A git WORKTREE usually has no node_modules of its own: node resolves upward, so the checkout it was
  // created from supplies the dependencies. That is how this workspace runs the engine and the website, so
  // treating it as an empty environment would fail the very layout the work happens in.
  //
  // The ancestor is used, and then held to THIS repo's lockfile. Resolving upward is only safe while the
  // two locks agree, and nothing otherwise says when they stop: a branch that changes a dependency would
  // quietly build against the parent's version instead of its own.
  function findInstallRecord(startDir) {
    let dir = startDir;
    for (let i = 0; i < 5; i++) {
      const candidate = join(dir, "node_modules", ".package-lock.json");
      if (existsSync(candidate)) return { path: candidate, dir };
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return null;
  }

  const record = existsSync(INSTALLED) ? { path: INSTALLED, dir: ROOT } : findInstallRecord(dirname(ROOT));
  if (record === null) {
    fail(
      1,
      1,
      "FAIL deps-installed: nothing is installed. There is no node_modules/.package-lock.json here or in\n" +
        "  any parent directory.\n" +
        `${NOT_YOUR_CODE}\n\n` +
        `  REMEDY: run \`npm ci\` in ${ROOT}\n\n` +
        "  Until you do, every gate that shells out to a binary fails with exit 127, and 127 in a chain of\n" +
        "  npm scripts reads like broken code rather than an empty node_modules.",
    );
  }
  const usingAncestor = record.dir !== ROOT;

  let lock;
  let installed;
  try {
    lock = JSON.parse(readFileSync(LOCK, "utf8"));
  } catch (err) {
    refuse(
      `REFUSED deps-installed: ${LOCK} exists but would not parse as JSON.\n  ${messageOf(err)}\n` +
        `${NOT_YOUR_CODE}\n\n` +
        "  Exit 2 rather than 1: the gate has no opinion on the tree, because it never got to compare it.",
    );
  }
  try {
    installed = JSON.parse(readFileSync(record.path, "utf8"));
  } catch (err) {
    refuse(
      `REFUSED deps-installed: ${record.path} exists but would not parse as JSON.\n  ${messageOf(err)}\n` +
        `${NOT_YOUR_CODE}\n\n` +
        `  REMEDY: run \`npm ci\` in ${record.dir}. npm writes that file itself, so a corrupt one means an\n` +
        "  install was interrupted.\n\n" +
        "  Exit 2 rather than 1: the gate has no opinion on the tree, because it never got to compare it.",
    );
  }

  const { want, missing, mismatched, failures, have } = gradeTree(lock.packages, installed.packages);

  // A gate that compares nothing reads exactly like a passing gate.
  // Only an EMPTY set proves nothing was compared. A fixed floor was wrong: the harness lockfile has 38
  // entries of which 29 are optional or platform-gated, so 8 required is its honest whole tree.
  if (want.size === 0) {
    refuse(
      "REFUSED deps-installed: package-lock.json parsed but lists no required packages, so nothing was\n" +
        "  compared and a pass here would have meant nothing.\n" +
        `${NOT_YOUR_CODE}`,
    );
  }
  if (have.size === 0) {
    refuse(
      "REFUSED deps-installed: npm's install record parsed but lists no packages, so nothing was compared.\n" +
        `${NOT_YOUR_CODE}\n\n` +
        `  REMEDY: run \`npm ci\` in ${record.dir}`,
    );
  }

  if (failures > 0) {
    const lines = [];
    lines.push("FAIL deps-installed: node_modules is out of date with package-lock.json.");
    lines.push(NOT_YOUR_CODE);
    lines.push("");
    lines.push(`  REMEDY: run \`npm ci\` in ${record.dir}`);
    lines.push("    npm ci installs exactly what the lockfile says and never rewrites it. `npm install` also");
    lines.push("    fixes this and is quicker when only a few packages moved, but it is allowed to change");
    lines.push("    package-lock.json, so check `git status package-lock.json` afterwards if you use it.");
    lines.push("");

    // The two mtimes answer the question a reader actually has, which is "is this mine?". A lockfile newer
    // than the install record means somebody else moved the lock and this checkout has not caught up, so
    // the finding predates whatever the reader was doing.
    const lockAt = mtimeOf(LOCK);
    const installAt = mtimeOf(record.path);
    if (lockAt !== null && installAt !== null) {
      lines.push(`  npm last installed here at ${installAt}`);
      lines.push(`  package-lock.json was last written at ${lockAt}`);
      if (Date.parse(lockAt) > Date.parse(installAt)) {
        lines.push("  The lock is NEWER than the install, so this is a tree that has not caught up rather");
        lines.push("  than anything you changed.");
      }
      lines.push("");
    }

    if (usingAncestor) {
      lines.push(`  Note: this checkout has no node_modules of its own and resolves up to ${record.dir},`);
      lines.push("  so the install being graded is the ancestor's. Install there, not here.");
      lines.push("");
    }

    if (missing.length > 0) {
      const shown = missing.slice(0, NAME_CAP);
      lines.push(`  ${missing.length} package(s) in the lock are not installed:`);
      for (const m of shown) lines.push(`    ${m}`);
      if (missing.length > shown.length) {
        lines.push(`    ... and ${missing.length - shown.length} more, capped at ${NAME_CAP} names.`);
      }
    }
    if (mismatched.length > 0) {
      const shown = mismatched.slice(0, NAME_CAP);
      lines.push(`  ${mismatched.length} package(s) installed at a different version:`);
      for (const m of shown) lines.push(`    ${m.name}: lock ${m.lock}, installed ${m.installed}`);
      if (mismatched.length > shown.length) {
        lines.push(`    ... and ${mismatched.length - shown.length} more, capped at ${NAME_CAP} names.`);
      }
    }
    lines.push("");
    lines.push("  Worth doing rather than ignoring: a lockfile in this repository moves when an npm advisory");
    lines.push("  is cleared, and package.json carries `overrides` written for exactly that reason, so a tree");
    lines.push("  behind the lock is running the versions the lock exists to escape.");
    fail(failures, want.size, lines.join("\n"));
  }

  const where = usingAncestor ? ` (installed in ${record.dir}, which this worktree resolves up to)` : "";
  console.log(`ok   deps-installed: all ${want.size} required packages match the lockfile${where}`);
  verdictReached(0, want.size);
}

// The positive control exercises the FAILURE shapes, not only the pass. A self-test that plants only a
// clean tree proves the gate can say yes and says nothing about the branch that actually fires.
function selfTest() {
  let failures = 0;
  let checks = 0;
  const expect = (what, actual, wanted) => {
    checks++;
    const ok = JSON.stringify(actual) === JSON.stringify(wanted);
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) {
      failures++;
      console.log(`     got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);
    }
  };

  const lock = {
    "": { name: "root" },
    "node_modules/kept": { version: "1.0.0" },
    "node_modules/moved": { version: "2.0.1" },
    "node_modules/absent": { version: "3.0.0" },
    "node_modules/opt": { version: "4.0.0", optional: true },
    "node_modules/mac-only": { version: "5.0.0", os: ["darwin"] },
    "node_modules/arm-only": { version: "6.0.0", cpu: ["arm64"] },
  };
  const installedStale = {
    "": { name: "root" },
    "node_modules/kept": { version: "1.0.0" },
    "node_modules/moved": { version: "2.0.0" },
  };

  // The exclusions must exclude, and the root entry must not be counted as a package.
  const stale = gradeTree(lock, installedStale);
  expect("required set drops optional, os and cpu entries and the root key", stale.want.size, 3);
  expect("a package absent from the install record is reported missing", stale.missing, ["node_modules/absent"]);
  expect("a package at the wrong version is reported mismatched", stale.mismatched, [
    { name: "node_modules/moved", lock: "2.0.1", installed: "2.0.0" },
  ]);
  expect("failures counts missing and mismatched together", stale.failures, 2);

  // A CAP MUST NEVER TRUNCATE SILENTLY: printing a count the names below it do not match is worse than no
  // cap at all. This case sizes the list well past any small cap, to prove the cap sits above what a real
  // run produces and that the "more, capped at" summary line appears only when it actually bites.
  const manyLock = /** @type {Record<string, {version?: string}>} */ ({});
  const manyInstalled = /** @type {Record<string, {version?: string}>} */ ({});
  for (let i = 0; i < 9; i++) {
    manyLock[`node_modules/p${i}`] = { version: "1.0.1" };
    manyInstalled[`node_modules/p${i}`] = { version: "1.0.0" };
  }
  const many = gradeTree(manyLock, manyInstalled);
  expect("nine drifted packages produce nine mismatches", many.mismatched.length, 9);
  expect("the name cap is above nine, so all nine would be printed", many.mismatched.slice(0, NAME_CAP).length, 9);
  expect("the old cap of five would have hidden four of them", many.mismatched.slice(0, 5).length, 5);

  // A tree that matches must grade clean, or the gate would fail on every correct checkout.
  const clean = gradeTree(lock, {
    "": { name: "root" },
    "node_modules/kept": { version: "1.0.0" },
    "node_modules/moved": { version: "2.0.1" },
    "node_modules/absent": { version: "3.0.0" },
  });
  expect("a tree that matches the lock grades clean", clean.failures, 0);

  // An install record carrying EXTRA packages is not a fault: optional and platform-gated entries are
  // installed on the machine they belong to, and the real console tree has 455 installed against 439
  // required.
  const extra = gradeTree(lock, {
    "node_modules/kept": { version: "1.0.0" },
    "node_modules/moved": { version: "2.0.1" },
    "node_modules/absent": { version: "3.0.0" },
    "node_modules/mac-only": { version: "5.0.0" },
  });
  expect("extra installed packages are not a fault", extra.failures, 0);

  // The empty arms that force a refusal rather than a vacuous pass.
  const noPackages = /** @type {Record<string, {version?: string}>} */ ({});
  expect("an empty lock compares nothing", gradeTree(noPackages, installedStale).want.size, 0);
  expect("an empty install record compares nothing", gradeTree(lock, noPackages).have.size, 0);

  // The position sentence is derived, not typed. It must name a real step number, and it must not claim a
  // command this repository does not have.
  const positioned = notYourCode();
  expect("the position sentence names a step of npm run lint", /step\n\s+\d+ of \d+ in `npm run lint`/.test(positioned), true);
  expect("the position sentence does not name lint:biome, which console has no such script for", positioned.includes("lint:biome"), false);

  console.log(failures === 0 ? `\ndeps-installed self-test PASS (${checks} checks)` : `\n${failures} FAILURE(S)`);
  verdictReached(failures, checks);
  return failures === 0 ? 0 : 1;
}

// Gated on being the entry module: a bare top-level dispatch runs the whole gate inside any importer and
// exits before the importer's first line. The rule, with the realpath that makes it survive a symlinked
// invocation, lives once in scripts/entry-module.mjs.
if (isEntryModule(import.meta.url)) {
  if (process.argv.includes("--self-test")) process.exit(selfTest());
  else main();
}
