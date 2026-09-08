// Validate the command-palette fuzzy scorer (fuzzyScore runs on every keystroke over the whole
// registry, so its score, ranking order and null-for-non-subsequence behaviour are asserted directly).
// Run with:
//   node test/validate-palette-fuzzy.ts
//
// fuzzyScore is a pure (DOM-free) function, so this runs in Node without a shim.

import { fuzzyScore, isBoundary } from "../src/screens/command-palette/shared.ts";

let failures = 0;

function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function scoreOf(text: string, query: string): number {
  const r = fuzzyScore(text, query);
  if (r === null) throw new Error(`expected a match for "${query}" in "${text}"`);
  return r.score;
}

// ---------------------------------------------------------------------------
// 1. Subsequence membership: null for a non-subsequence, a result for a subsequence.
// ---------------------------------------------------------------------------
console.log("\n-- subsequence membership --");
ok("non-subsequence returns null", fuzzyScore("Go to Downpipes", "xyz") === null);
ok("query longer than text but subsequence-impossible returns null", fuzzyScore("ab", "abc") === null);
ok("a subsequence returns a non-null result", fuzzyScore("Go to Downpipes", "gd") !== null);
ok("empty query returns a zero-score empty-indices result (not null)",
  JSON.stringify(fuzzyScore("anything", "")) === JSON.stringify({ score: 0, indices: [] }));

// ---------------------------------------------------------------------------
// 2. Indices: the returned indices are the matched character positions, in order.
// ---------------------------------------------------------------------------
console.log("\n-- matched indices --");
{
  const r = fuzzyScore("Go to Downpipes", "gd");
  ok("indices for 'gd' in 'Go to Downpipes' are [0, 6]", r !== null && JSON.stringify(r.indices) === JSON.stringify([0, 6]));
}
{
  const r = fuzzyScore("restore", "rst");
  ok("indices are strictly increasing", (r?.indices.every((v, i) => i === 0 || v > r.indices[i - 1]!) ?? false));
}

// ---------------------------------------------------------------------------
// 3. Consecutive-run bonus: a tight (consecutive) match outscores a scattered one of the
//    same length, holding everything else equal.
// ---------------------------------------------------------------------------
console.log("\n-- consecutive run beats scattered --");
// "ab" consecutive in "abxxxx" vs "ab" scattered in "axbxxx": same boundary/earliness, but the
// run bonus makes the consecutive match win.
ok("consecutive 'ab' outscores scattered 'ab'", scoreOf("abxxxx", "ab") > scoreOf("axbxxx", "ab"));

// ---------------------------------------------------------------------------
// 4. Boundary bonus: a word-start match outscores a mid-word match.
// ---------------------------------------------------------------------------
console.log("\n-- boundary bonus --");
// "d" at a word start ("go down") vs "d" mid-word ("agdo"): the boundary match wins.
ok("word-start 'd' outscores mid-word 'd'", scoreOf("go down", "d") > scoreOf("agdo", "d"));
ok("isBoundary true at string start", isBoundary("down", 0) === true);
ok("isBoundary true after a space", isBoundary("go down", 3) === true);
ok("isBoundary true at a camel transition", isBoundary("goDown", 2) === true);
ok("isBoundary false mid-word", isBoundary("down", 2) === false);

// ---------------------------------------------------------------------------
// 5. Exact outranks prefix outranks scattered.
// ---------------------------------------------------------------------------
console.log("\n-- exact > prefix > scattered --");
const exact = scoreOf("go", "go");
const prefix = scoreOf("gone", "go");
const scattered = scoreOf("g-o-n-e", "go");
ok("exact match outranks a prefix match", exact > prefix);
ok("prefix match outranks a scattered match", prefix > scattered);

// ---------------------------------------------------------------------------
// 6. The motivating ranking: "gd" ranks "Go to Downpipes" above an incidental match.
// ---------------------------------------------------------------------------
console.log("\n-- motivating ranking --");
ok("'gd' scores 'Go to Downpipes' above 'a ragged scattering'",
  scoreOf("Go to Downpipes", "gd") > scoreOf("a ragged scattering", "gd"));

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nVALIDATE-PALETTE-FUZZY VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
