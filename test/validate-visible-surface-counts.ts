// A surface count a CUSTOMER can read must be a live figure.
//
// WHY THIS EXISTS
// ---------------
// The tour told prospects "It covers nine source types plus 314 configuration surfaces" while the registry
// held 313. That is the only stale count in this campaign a customer could actually read; every other one
// found has been a comment.
//
// It survived because nothing looks here. The docs corpus has a claim lint, and it scans the docs plus two
// sibling roots, of which console source is not one. This repo's own split gate checks the demo seed's
// inBand/available flags against the engine catalogue, which is about DATA rather than COPY. And the
// counts a customer sees in the surface picker are computed from the catalogue at run time, so they cannot
// go stale, which is exactly why the two that were written down went unnoticed for so long.
//
// WHAT IT CHECKS
// --------------
// Inside STRING LITERALS only, with comments stripped: a number adjacent to the word "surface(s)" must be
// one of the engine's live figures. Comments are excluded on purpose. They rot too and that has been
// cleaned separately, but a stale comment costs a reader a minute while a stale string costs a customer
// their trust in the number, and mixing the two would make this gate noisy enough to be ignored.
//
// ADJACENCY, not mere co-occurrence. "The 32-character zone id, required for zone-scoped surfaces" holds a
// number and the word in one sentence and claims nothing about the registry. The number must sit within a
// short window of the noun, and a number glued to a unit by a hyphen (32-character, 64-byte) is never a
// count of anything.
//
// The live figures come from the ENGINE, so this cannot drift from the registry the way a hand-maintained
// list would. Without an engine checkout it SKIPS, unless REQUIRE_ENGINE=1, the same contract as the other
// cross-repo gates here.
//
//   node test/validate-visible-surface-counts.ts

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importFromEngine } from "./engine-path.ts";
import { verdictReached, verdictSkipped } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

const here = `${dirname(fileURLToPath(import.meta.url))}/`;

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const catalogueMod = await importFromEngine(here, "src/sources/cf-config-catalogue.ts");
if (catalogueMod === null) {
  // DECLARED, not silent: measured at exit 0 with no count checked, indistinguishable in the log from a
  // pass. The exit code stays 0 because a console-only clone has no engine; the skip is now greppable.
  verdictSkipped("VISIBLE SURFACE COUNTS: no engine checkout reachable");
  process.exit(0);
}
const catalogue = (catalogueMod as { cfConfigCatalogue: () => Array<{ scope: string; inBand: boolean; available: boolean }> }).cfConfigCatalogue();

// Every figure a sentence about the registry may legitimately state.
const live = new Set<number>([
  catalogue.length,
  catalogue.filter((s) => s.inBand).length,
  catalogue.filter((s) => s.available).length,
  catalogue.filter((s) => !s.inBand).length,
  catalogue.filter((s) => s.scope === "zone").length,
  catalogue.filter((s) => s.scope === "account").length,
]);

// RESOLVED, not concatenated. `${here}../src` contains "/test/" as a literal segment, so the SKIP pattern
// below matched the walk root itself and the gate scanned NOTHING while reporting a pass. A vacuous pass,
// in the gate written to catch a vacuous claim, which is why the non-vacuity assertions at the bottom are
// not optional.
const SRC = resolve(here, "../src");
const SKIP = /node_modules|\/public\/|\/test\/|test-results|\.d\.ts$/;
const files: string[] = [];
(function walk(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const p = `${dir}/${e}`;
    if (SKIP.test(p)) continue;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(p)) files.push(p);
  }
})(SRC);

// Comments rot too, and are cleaned separately; including them here would drown the signal.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

// A number, not glued to a unit by a hyphen, within a short window before "surface(s)".
const NEAR_SURFACE = /\b(\d{2,4})\b(?!-)(?:[^.\n]{0,40}?)surfaces?\b/gi;

const offenders: string[] = [];
let scanned = 0;
for (const f of files) {
  const code = stripComments(readFileSync(f, "utf8"));
  for (const lit of code.matchAll(/(["'`])((?:[^\\\n]|\\.)*?)\1/g)) {
    const text = lit[2] ?? "";
    if (!/surface/i.test(text)) continue;
    scanned++;
    for (const m of text.matchAll(NEAR_SURFACE)) {
      const n = Number(m[1]);
      if (live.has(n)) continue;
      offenders.push(`${f.replace(here, "")}: "${text.slice(0, 90)}"  states ${n}`);
    }
  }
}

console.log(`-- ${scanned} user-visible string(s) mentioning a surface, across ${files.length} files --`);
for (const o of offenders) console.log(`  ${o}`);
ok(
  offenders.length === 0
    ? `every surface count in customer-visible copy is a live figure (${[...live].sort((a, b) => a - b).join(", ")})`
    : `${offenders.length} customer-visible surface count(s) are not live figures`,
  offenders.length === 0,
);

// NON-VACUITY. This gate can only report a pass by having looked, and it scanned nothing on its first run
// because of a path bug. Both floors are asserted rather than assumed: it must have walked real files, and
// it must have found real copy mentioning a surface. Either at zero means the walk or the literal matcher
// broke, not that the copy is clean.
ok(`the walk found console source to scan (${files.length} files)`, files.length > 50);
ok(`customer-visible copy mentioning a surface was found to check (${scanned} strings)`, scanned > 0);

console.log(failures === 0 ? "\nVISIBLE SURFACE COUNTS PASS" : `\n${failures} FAILURE(S)`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
process.exit(failures === 0 ? 0 : 1);
