#!/usr/bin/env node
// One answer to "am I the script the operator ran, or a module somebody imported", and the gate that keeps
// every argv-driven side effect in this repo asking it.
//
// WHY IT EXISTS. A module-scope `if (process.argv.includes("--self-test")) ...` fires whenever the flag
// appears in argv, including when the module is merely IMPORTED by a gate the operator ran with the same
// flag. Because it runs at import time and calls process.exit, the IMPORTING gate dies there: its own
// self-test block never executes, and the process exits 0 on the wrong module's assertions, so the log
// reads like a pass. Reading the output rather than the exit code is the only way to catch it.
//
// Renaming one caller's flag moves the collision rather than closing it, and leaves the trap armed for the
// next importer. Putting a guard inline in the imported module is the right shape, but duplicating that
// guard once per file that needs it is one copy of a rule too many. This file is that rule, once.
//
// REALPATH IS LOAD-BEARING. A guard written as
//   import.meta.url === pathToFileURL(process.argv[1]).href
// is not enough: Node resolves import.meta.url through symlinks (the default, --preserve-symlinks off)
// while process.argv[1] keeps whatever path the operator typed. Invoking a self-testing script through a
// symlink then makes the two differ, so the self-test does not run and the process exits 0 having printed
// NOTHING. A verification that silently does not verify is worse than one that is absent, because the
// absent one does not appear in a lint chain as a green line. realpathSync on argv[1] closes it, and a
// missing argv[1] (`node --eval`, a REPL) is correctly "not an entry script".
//
// THE GATE. Run this file directly and it also SCANS scripts/ and test/ for the shape it exists to prevent: a
// module-scope read of process.argv that triggers process.exit without an entry check. A file that legitimately
// is only ever an entry script (a gate, a census writer) is fine, because nothing imports it and it can say so
// by not being imported. So the scan reports a file only when it is BOTH unguarded AND imported by something
// else in this repo, which is the condition that makes the trap live rather than latent.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * True when metaUrl belongs to the module Node was asked to run, rather than to something it imported.
 *
 * Callers pass their own import.meta.url. Symlinks are resolved on the argv side because Node has already
 * resolved them on the import.meta side, and a realpathSync on a path that does not exist throws rather than
 * returning a wrong answer, so that is caught and read as "not the entry module".
 */
export function isEntryModule(metaUrl) {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Below here runs only when this file IS the entry script, which is the rule it exports, applied to itself.
// ---------------------------------------------------------------------------------------------------------

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN = ["scripts", "test"];

function files() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") || p.endsWith(".mjs")) out.push(relative(ROOT, p));
    }
  };
  for (const d of SCAN) walk(join(ROOT, d));
  return out.sort();
}

/**
 * The module-scope lines that read process.argv and exit, per file, ignoring anything indented (which is
 * inside a function or a block and therefore does not fire at import). Comments are not blanked here on
 * purpose: this looks for a statement that starts in column zero, and a comment cannot.
 */
function unguardedExits(body) {
  const hits = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s/.test(line) || line.trimStart().startsWith("//")) continue;
    if (!line.includes("process.argv")) continue;
    if (!line.includes("process.exit")) continue;
    hits.push({ line: i + 1, text: line.trim() });
  }
  return hits;
}

function guarded(body) {
  return body.includes("isEntryModule") || body.includes("realpathSync(process.argv[1])") || body.includes("require.main === module");
}

function scan() {
  const scanned = files();
  // A gate that scans nothing reads exactly like a passing gate.
  if (scanned.length < 100) {
    console.error(`FAIL entry-module: expected this repo's checks, found only ${scanned.length} files. Has the layout moved?`);
    return 1;
  }

  const bodies = new Map();
  for (const f of scanned) bodies.set(f, readFileSync(join(ROOT, f), "utf8"));

  // Imported by something else here? Read over import specifiers, so naming a file in prose does not count it.
  const importedBasenames = new Set();
  for (const [f, body] of bodies) {
    for (const m of body.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+\.(?:mjs|ts))["']/g)) {
      if (basename(m[1]) !== basename(f)) importedBasenames.add(basename(m[1]));
    }
  }

  const live = [];
  const latent = [];
  for (const [f, body] of bodies) {
    const hits = unguardedExits(body);
    if (hits.length === 0 || guarded(body)) continue;
    const where = hits.map((h) => `${f}:${h.line}  ${h.text}`);
    (importedBasenames.has(basename(f)) ? live : latent).push(...where);
  }

  if (live.length > 0) {
    console.error(`FAIL entry-module: ${live.length} module-scope argv exit(s) in a file this repo IMPORTS:\n`);
    for (const l of live) console.error(`  ${l}`);
    console.error(
      `\nGate the side effect on isEntryModule(import.meta.url) from scripts/entry-module.mjs. At module scope\n` +
        `this fires when an IMPORTER is run with the same flag, killing the importer's own checks and exiting 0\n` +
        `on this module's assertions, which reads in a lint chain as a green line for a check that never ran.`,
    );
    return 1;
  }

  console.log(`ok   entry-module: ${scanned.length} files scanned, 0 live module-scope argv exits${latent.length > 0 ? `, ${latent.length} in entry-only scripts (not imported)` : ""}`);
  return 0;
}

function selfTest() {
  let held = 0;
  let broke = 0;
  const expect = (label, got, want) => {
    if (got === want) {
      held++;
      console.log(`PASS  ${label}`);
      return;
    }
    broke++;
    console.log(`FAIL  ${label}  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`);
  };

  expect("this file, run directly, is the entry module", isEntryModule(import.meta.url), true);
  expect("a module that is not the entry script is not", isEntryModule("file:///nowhere/other.mjs"), false);
  expect("an argv[1] that does not exist is not the entry module", isEntryModule(pathToFileURL("/nowhere/gone.mjs").href), false);

  // TRUNCATE rather than assign undefined. `node --eval` and a REPL do not hold an argv whose second slot
  // is undefined, they hold an argv of LENGTH ONE, so truncating is the faithful reproduction of the state
  // under test as well as the one the type checker accepts (assigning undefined into a string[] is the
  // typecheck:scripts error this replaces). The whole tail is saved and restored, not just slot one, so a
  // later self-test cannot find the arguments it was invoked with quietly missing.
  const savedArgv = process.argv.slice(1);
  process.argv.length = 1;
  expect("no argv[1] at all (node --eval, a REPL) is not an entry script", isEntryModule(import.meta.url), false);
  process.argv.push(...savedArgv);

  expect("an indented argv exit is inside a function and does not fire at import", unguardedExits('function f() {\n  if (process.argv.includes("--x")) process.exit(1);\n}\n').length, 0);
  expect("a column-zero argv exit is module scope and does fire", unguardedExits('if (process.argv.includes("--x")) process.exit(1);\n').length, 1);
  expect("a commented-out one is not code", unguardedExits('// if (process.argv.includes("--x")) process.exit(1);\n').length, 0);
  expect("an argv read with no exit is not the shape", unguardedExits('const F = process.argv.includes("--enforce");\n').length, 0);
  expect("the guard is recognised", guarded('if (isEntryModule(import.meta.url)) process.exit(0);'), true);
  expect("and prose alone is not a guard", guarded("const x = 1;"), false);

  console.log(`\nentry-module self-test: ${held} of ${held + broke} assertions held.`);
  return broke === 0 ? 0 : 1;
}

if (isEntryModule(import.meta.url)) {
  const rc = process.argv.includes("--self-test") ? selfTest() : 0;
  process.exit(rc !== 0 ? rc : scan());
}
