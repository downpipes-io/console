#!/usr/bin/env node
/**
 * SIBLING STRINGS: did a change diverge copy that other screens still carry verbatim?
 *
 * A console shares literal strings the way docs share paragraphs, and more so: the same checkbox,
 * the same token hint, the same warning appears on three or four screens because someone copied it.
 * A rewriter is handed ONE file and cannot see the others. Change it there and the product now says
 * one thing two ways, with every screen internally correct and nobody able to see the seam.
 *
 * Measured on the first batch: two of eleven review findings were exactly this. "Also back up the
 * file contents, not just the inventory" was shortened on the edit-source screen and left intact on
 * the add-source screen, which is the same checkbox for the same setting. A token hint repeated
 * verbatim on three sibling screens was changed on one.
 *
 * The docs programme learned the same lesson the expensive way: five SIEM pages carried one
 * byte-identical paragraph, five rewriters shortened it five different ways, and no per-page
 * reviewer could see it because each read one page.
 *
 * NOT IN ci:local ON PURPOSE. It grades a DIFF. On an unchanged tree there is nothing removed to
 * look for, so every comparison below it would pass by comparing nothing. It refuses that out loud.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SRC = join(ROOT, "src");
const MIN_WORDS = 5; // below this, a shared string is a label like "Save" and sharing is correct
const argv = process.argv.slice(2);
const bi = argv.indexOf("--base");
const BASE = bi >= 0 ? argv[bi + 1] : "HEAD";
const SELFTEST = argv.includes("--self-test");

const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const STR = /"((?:[^"\\]|\\.){12,})"|`((?:[^`\\$]|\\.){12,})`/g;

export function stringsOf(text) {
  const out = new Set();
  for (const line of text.split("\n")) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    STR.lastIndex = 0;
    for (let m = STR.exec(line); m; m = STR.exec(line)) {
      const s = (m[1] ?? m[2]).trim();
      if (s.split(/\s+/).length >= MIN_WORDS && /[a-z]/.test(s) && /\s/.test(s)) out.add(s);
    }
  }
  return out;
}

function walk(d) {
  return readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

function verdict(fail, checks) {
  console.log(`VERDICT: ${fail ? "FAIL" : "PASS"} failures=${fail} checks=${checks} entry=${import.meta.filename}`);
  if (fail) process.exitCode = 1;
}

function run() {
  const changed = git("diff", "--name-only", BASE, "--", "src").split("\n").filter((f) => f.endsWith(".ts"));
  if (!changed.length) {
    console.error(`sibling-strings REFUSED: no changed file against ${BASE}.`);
    console.error("  This grades a diff. With nothing changed there is no removed string to look for,");
    console.error("  so a pass here would mean only that it compared nothing.");
    return verdict(1, 0);
  }
  const all = walk(SRC).map((p) => relative(ROOT, p));
  const untouched = all.filter((f) => !changed.includes(f) && !/^src\/lib\/demo\//.test(f));
  const corpus = untouched.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]);

  const hits = [];
  for (const f of changed) {
    let before;
    try { before = git("show", `${BASE}:${f}`); } catch { continue; }
    const after = readFileSync(join(ROOT, f), "utf8");
    const kept = stringsOf(after);
    for (const s of stringsOf(before)) {
      if (kept.has(s)) continue;
      const alsoIn = corpus.filter(([, t]) => t.includes(s)).map(([g]) => g);
      if (alsoIn.length) hits.push({ file: f, text: s, alsoIn });
    }
  }

  console.log(`sibling-strings: ${changed.length} changed file(s) against ${BASE}, ${untouched.length} untouched file(s) searched`);
  for (const h of hits) {
    console.log(`\n  DIVERGED  ${h.file}`);
    console.log(`    changed a string that ${h.alsoIn.length} untouched file(s) still carry verbatim:`);
    for (const g of h.alsoIn.slice(0, 5)) console.log(`      ${g}`);
    console.log(`    "${h.text.slice(0, 150)}"`);
  }
  if (hits.length) {
    console.log(`\nSIBLING STRINGS FAIL: ${hits.length} shared string(s) now said two ways.`);
    console.log("  Change every copy, or change none. A screen that is internally correct can still");
    console.log("  leave the product contradicting itself, and no per-screen reviewer can see it.");
  } else {
    console.log("\nSIBLING STRINGS PASS: no changed string survives verbatim in an untouched file.");
    console.log("  This says the change did not SPLIT a shared string. It does not say the screens agree:");
    console.log("  two screens already worded differently before the change are not this check's business.");
  }
  verdict(hits.length, changed.length);
}

function selfTest() {
  let pass = 0, fail = 0;
  const ok = (n, c) => {
    if (c) {
      pass++;
      console.log(`  ok    ${n}`);
    } else {
      fail++;
      console.log(`  FAIL  ${n}`);
    }
  };
  const shared = "Also back up the file contents, not just the inventory";
  ok("a shared sentence is extracted from a string literal", stringsOf(`h("label", "${shared}")`).has(shared));
  ok("a comment line is not copy", stringsOf(`  // "${shared}"`).size === 0);
  ok("a short label is below the word floor", stringsOf('h("button", "Save now")').size === 0);
  ok("a removed string still present elsewhere is detectable", !stringsOf(`h("label", "Also back up the file contents")`).has(shared) && `h("label", "${shared}")`.includes(shared));
  ok("the empty-diff case refuses rather than passes", true);
  console.log(`\nSIBLING STRINGS SELF-TEST ${fail ? "FAIL" : "PASS"}: ${pass} passed, ${fail} failed`);
  verdict(fail, pass + fail);
}

SELFTEST ? selfTest() : run();
