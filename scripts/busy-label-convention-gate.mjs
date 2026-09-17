#!/usr/bin/env node
/**
 * BUSY-LABEL CONVENTION GATE.
 *
 * WHAT IT ENFORCES, AND WHY IT IS THE NARROW CLAIM RATHER THAN THE WIDE ONE. The console says the same
 * thing three ways when a control goes busy: some labels end in the ellipsis CHARACTER, some in three full
 * stops, most in nothing. Picking one for all of them would be inventing user-visible copy, and nothing in
 * this repo declares a convention a rule could cite: writing-rules-source.mjs grades em dashes and en
 * dashes over 1,654 prose-bearing files and says nothing about ellipsis, and tokens.css declares contrast
 * and layout and says nothing either.
 *
 * So this gate enforces only the claim that stands WITHOUT a declared convention: THE SAME WORD MUST NOT
 * APPEAR TWO WAYS. "Verifying…" and "Verifying" for the same state is a defect on any convention, because
 * whichever is right the other is wrong.
 *
 * COUNTING BOTH MECHANISMS MATTERS. A census over only one of the two mechanisms (the disabled+textContent
 * controls alone) undercounts the true population of distinct labels and can read as having no majority
 * to normalise toward, when counting the busyLabel action descriptors too reveals one. A majority measured
 * over part of a population is not a majority; it is a clean number in the wrong units.
 *
 * BOTH MECHANISMS ARE READ, deliberately. A gate over one of them would have reported zero violations
 * while "Removing" carried THREE conventions across the two.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// A busy label is set one of two ways. Mechanism 1 assigns textContent directly on a control that has just
// been disabled; mechanism 2 declares busyLabel on an action descriptor the shared modal helper applies.
const BUSY_LABEL_DECL = /busyLabel:\s*"([^"]*)"/g;
const BUSY_TEXT_SET = /\.textContent\s*=\s*"([A-Z][^"]{0,40}?(?:ing|ing…|ing\.\.\.)[^"]{0,20})"/g;

export function conventionOf(label) {
  if (label.endsWith("…")) return "ellipsis character";
  if (label.endsWith("...")) return "three full stops";
  return "bare";
}
export function stemOf(label) {
  return label.replace(/(…|\.\.\.)$/, "").trim();
}

/** collect returns stem -> convention -> [labels], over whatever source text it is given. */
export function collect(sources) {
  const byStem = new Map();
  for (const { file, text } of sources) {
    for (const re of [BUSY_LABEL_DECL, BUSY_TEXT_SET]) {
      re.lastIndex = 0;
      // A for-loop rather than `while ((m = re.exec(text)) !== null)`: biome's noAssignInExpressions
      // refuses the assignment-in-condition, and hoisting the re-exec to the loop's end would be WRONG
      // here because the two `continue`s below would then skip it and spin forever. The update clause
      // runs on `continue`, so this is exactly equivalent.
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        const label = m[1].replace(/\\u2026/g, "…");
        if (label.trim() === "") continue;
        const stem = stemOf(label);
        if (stem === "") continue;
        if (!byStem.has(stem)) byStem.set(stem, new Map());
        const byConv = byStem.get(stem);
        const c = conventionOf(label);
        if (!byConv.has(c)) byConv.set(c, []);
        byConv.get(c).push({ label, file });
      }
    }
  }
  return byStem;
}

/** violations returns the stems carrying more than one convention. */
export function violations(byStem) {
  const out = [];
  for (const [stem, byConv] of byStem) if (byConv.size > 1) out.push({ stem, byConv });
  return out.sort((a, b) => (a.stem < b.stem ? -1 : 1));
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (e.endsWith(".ts")) acc.push({ file: p.slice(ROOT.length + 1), text: readFileSync(p, "utf8") });
  }
  return acc;
}

// ---- SELF-TEST: the gate must go RED on a planted violation before its green is worth anything -------
// A gate that has only ever seen a clean tree has not been shown to speak. Both arms use the SAME
// collector over the SAME shape of input, so the only difference between them is the defect.
function selfTest() {
  let failures = 0;
  const ok = (label, cond) => { if (!cond) failures++; console.log(`${cond ? "ok  " : "FAIL"}  ${label}`); };

  const clean = [{ file: "a.ts", text: 'busyLabel: "Saving"\nx.textContent = "Verifying";' }];
  ok("CONTROL: one convention per stem is silent", violations(collect(clean)).length === 0);

  const planted = [{ file: "a.ts", text: 'busyLabel: "Saving…"\nx.textContent = "Saving";' }];
  const v = violations(collect(planted));
  ok("PLANT: the same word two ways is named", v.length === 1 && v[0].stem === "Saving");
  ok("PLANT: and both conventions are reported, not just the count",
    v.length === 1 && v[0].byConv.has("bare") && v[0].byConv.has("ellipsis character"));

  const acrossMechanisms = [{ file: "a.ts", text: 'busyLabel: "Removing…"' }, { file: "b.ts", text: 'y.textContent = "Removing";' }];
  ok("PLANT: a clash SPLIT ACROSS THE TWO MECHANISMS is still caught (a one-mechanism gate reads zero here)",
    violations(collect(acrossMechanisms)).length === 1);

  ok("three full stops is its own convention, not folded into bare", conventionOf("Adding...") === "three full stops");
  ok("the ellipsis character is its own convention", conventionOf("Adding…") === "ellipsis character");
  ok("a bare label stems to itself", stemOf("Adding") === "Adding");

  console.log(`\n[busy-label-convention] self-test: ${failures === 0 ? "PASS" : `${failures} FAILED`} (6 checks)`);
  return failures;
}

if (process.argv.includes("--self-test")) process.exit(selfTest() === 0 ? 0 : 1);

const selfFailures = selfTest();
if (selfFailures > 0) {
  console.error("\n[busy-label-convention] REFUSING to grade: the gate's own self-test is red, so its verdict about src/ means nothing.");
  process.exit(2);
}

const sources = walk(join(ROOT, "src"));
const byStem = collect(sources);
const bad = violations(byStem);
const convTally = {};
for (const [, byConv] of byStem) for (const c of byConv.keys()) convTally[c] = (convTally[c] ?? 0) + 1;

console.log(`\n[busy-label-convention] ${byStem.size} busy-label stem(s) over ${sources.length} file(s); conventions in use: ${JSON.stringify(convTally)}`);
if (bad.length === 0) {
  console.log("[busy-label-convention] OK: no single word appears with two conventions.");
  process.exit(0);
}
console.log(`\n[busy-label-convention] ${bad.length} word(s) appear with more than one convention:`);
for (const { stem, byConv } of bad) {
  console.log(`  ${stem}`);
  for (const [c, hits] of byConv) for (const h of hits) console.log(`      ${c.padEnd(18)} ${JSON.stringify(h.label)}  ${h.file}`);
}
console.log("\nWhichever convention is right, the other is wrong for the same state. Pick one PER WORD.");
process.exit(1);
