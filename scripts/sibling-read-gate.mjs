#!/usr/bin/env node
// A check that reads a sibling repo must resolve it, not hardcode it.
//
// THE FAILURE. Seven files here read the engine's source to keep a mirror or a constant honest. Six took
// an override and one hardcoded `../../engine`, and the two that did take one used a DIFFERENT variable
// name from the other four. So there was no single thing to set: a caller who set DOWNPIPES_ENGINE moved
// four checks, ENGINE_WORKTREE moved two, and one could not be moved at all.
//
// A sibling engine checkout that has fallen behind its own origin/main can fail a check that reads it for
// looking stale rather than wrong, and a hardcoded path gives a caller no way to aim the check at a
// different, current checkout to tell the two apart. Both repos' gates then go red over a stale copy of
// code nobody has changed.
//
// So the rule is: any file under test/ or scripts/ that names a sibling engine path must be POINTABLE,
// which means it either imports the shared resolver or reads DOWNPIPES_ENGINE itself. The invariant is
// that a caller can aim it at a known checkout, not that it imports one particular file: several of these
// are .mjs scripts that predate the resolver and carry their own candidate list in the same order, and
// rewriting a working resolution to satisfy a gate about resolution would be circular.
//
// It is deliberately about the ENGINE. Other siblings are read too rarely here to be worth a resolver, and
// a gate that demands one for a single caller is ceremony rather than a guard.
//
// THE EXEMPTION IS READ OVER CODE, NOT PROSE. Both the hardcoded-path check and the resolver check run
// against comment-blanked text, so a file carrying `const p = "../../engine/src/index.ts";` cannot be
// exempted by a comment claiming it should use the resolver: the hardcoded path is still what the code
// does. STRINGS ARE NOT blanked: this gate reads paths and import specifiers that legitimately live inside
// string literals, and blanking those would blind it to the thing it polices. scripts/source-text.mjs
// carries that distinction and its own teeth.
//
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { blankComments } from "./source-text.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN = ["test", "scripts"];
const RESOLVER = "engine-root";

// The file that IS the resolver, and the gate that describes the rule, cannot be asked to import it.
const SELF = new Set(["test/engine-root.ts", "scripts/sibling-read-gate.mjs"]);

// A hardcoded sibling engine path, in the shapes this repo actually writes them: a path segment in a
// string, or the pieces handed to join().
const HARDCODED = /["'`][^"'`\n]*\.\.\/\.\.\/engine\b|["'`]\.\.["'`]\s*,\s*["'`]\.\.["'`]\s*,\s*["'`]engine["'`]/;

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

const scanned = files();
// A gate that scans nothing reads exactly like a passing gate.
//
// EXIT 2, NOT 1. The only ways to reach this floor are a moved layout, a walk that stopped
// matching, or a run from somewhere that is not this checkout. None of them is a file hardcoding a sibling
// engine path, which is the one finding this gate exists to report. Exit 1 would put that finding's exit
// code on a run that read almost none of the corpus, and under scripts/run-gate-chain.mjs that is the
// difference between "every member graded its subject" and "one member never saw its subject".
if (scanned.length < 100) {
  console.error(`CANNOT CHECK sibling-read: expected this repo's checks under ${SCAN.join(", ")}, found only ${scanned.length} file(s). Has the layout moved? No file was examined for a hardcoded sibling path, so nothing here is a verdict on the corpus.`);
  process.exit(2);
}

const offenders = [];
for (const f of scanned) {
  if (SELF.has(f)) continue;
  const body = blankComments(readFileSync(join(ROOT, f), "utf8"));
  if (!HARDCODED.test(body)) continue;
  // Either route counts: the shared resolver, or its own DOWNPIPES_ENGINE lookup. Read over the blanked
  // body, so naming either one in prose does not buy the exemption.
  if (body.includes(RESOLVER) || body.includes("DOWNPIPES_ENGINE")) continue;
  offenders.push(f);
}

if (offenders.length > 0) {
  console.error(`FAIL sibling-read: ${offenders.length} file(s) hardcode a sibling engine path without the resolver:\n`);
  for (const o of offenders) console.error(`  ${o}`);
  console.error(
    `\nImport { engineRoot } from the shared resolver (test/engine-root.ts), or read DOWNPIPES_ENGINE\n` +
      `directly. A path that can only ever be the sibling working tree is\n` +
      `only as true as whatever that working copy happens to hold, and it cannot be pointed at a known\n` +
      `checkout when it is stale. That is not hypothetical: it took this repo's validate and the harness\n` +
      `unit baseline red together over a sibling 44 commits behind its own origin/main.`,
  );
  process.exit(1);
}

console.log(`ok   sibling-read: every cross-repo engine read in ${scanned.length} files goes through the resolver`);
