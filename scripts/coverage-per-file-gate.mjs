// Per-file coverage floor.
//
// An aggregate hides a zero. The console's gated region reports 96.69 per cent statements, and inside
// that number a file could sit at exactly zero and the aggregate would still say nothing about it,
// which is the whole reason this gate exists: the question "is the suite good" is not the same
// question as "is any file untested". A file that reaches full coverage carries no BASELINE entry
// below: the entry is deleted rather than left to rot once the gap closes.
//
// It is a RATCHET, not a cliff. BASELINE below names every file currently under the floor, with its
// figure at the time it was recorded. The gate fails when:
//   - a file NOT in the baseline falls under the floor (a new gap), or
//   - a baselined file gets WORSE than its recorded figure (backsliding), or
//   - a baselined file no longer exists or is now above the floor (the entry is stale; delete it).
// So the list can only shrink, and it cannot rot. That last case matters: a baseline nobody prunes
// stops describing anything and quietly re-opens the hole it was meant to hold.
//
// The floor is per REGION, not a flag: src/screens/** is held to 20 and everything else to 50, because
// the two regions are at genuinely different maturities and one number for both would either excuse the
// mature region or flood the list from the young one. The gate derives a file's floor from its own path,
// so the same invocation is correct over either region's summary.
//
// Usage:
//   node scripts/coverage-per-file-gate.mjs <summary.json> [--enforce]

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const ENFORCE = args.includes("--enforce");
const summaryPath = args.find((a) => !a.startsWith("--"));

if (summaryPath === undefined) {
  console.error("usage: node scripts/coverage-per-file-gate.mjs <coverage-summary.json> [--enforce]");
  process.exit(2);
}

const SCREEN_FLOOR = 20;
const REST_FLOOR = 50;
const floorFor = (file) => (file.startsWith("src/screens/") ? SCREEN_FLOOR : REST_FLOOR);

// Files currently under the floor, each with the statement percentage recorded when it was added. Add a
// SHORT reason only when a file is genuinely not worth covering; otherwise the entry is plain debt and
// the number is the target to beat.
//
const BASELINE = new Map([
  // A LOCAL coverage run can report this file above the floor when CI does not: only CI's figure is
  // authoritative for this baseline. Delete this entry only on evidence from a CI run, not a local one.
  ["src/screens/map/controller.ts", 15.57],
  // --- non-screen region, floor 50 -------------------------------------------------------------
  ["src/components/data-table-context.ts", 0],
  // --- screen region, floor 20 -----------------------------------------------------------------
  // Only ten of 257 screen files sit under 20 per cent, which is why 20 is the floor: low enough that
  // the list is a real burndown rather than a wall of noise, high enough that "barely touched" fails.
  ["src/screens/access-security/setup-wizard.ts", 12.5],
  ["src/screens/command-palette/landing.ts", 13.57],
  ["src/screens/settings/appearance.ts", 16.79],
  ["src/screens/command-palette/controller.ts", 19.39],
]);

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const rel = (k) => k.replace(/.*\/src\//, "src/");

const files = [];
for (const [k, v] of Object.entries(summary)) {
  if (k === "total") continue;
  files.push({ file: rel(k), pct: v.statements.pct, total: v.statements.total });
}

const newGaps = [];
const backslid = [];
const seen = new Set();

for (const f of files) {
  const based = BASELINE.get(f.file);
  if (based !== undefined) {
    seen.add(f.file);
    // A small tolerance so a one-statement drift in an unrelated refactor does not fail the build; a
    // real regression moves further than this.
    if (f.pct < based - 0.5) backslid.push({ ...f, was: based });
    continue;
  }
  if (f.pct < floorFor(f.file)) newGaps.push(f);
}

// Only entries whose region this summary actually covers can be judged stale. Running the gate over the
// screens summary must not report every non-screen baseline entry as missing, and the other way round.
const measured = new Set(files.map((f) => f.file));
const inThisRegion = (b) => measured.has(b);
const stale = [...BASELINE.keys()].filter((b) => inThisRegion(b) && !seen.has(b));
const staleAbove = files.filter((f) => BASELINE.has(f.file) && f.pct >= floorFor(f.file)).map((f) => f.file);

// A floor on how many files the summary actually held. `bad === 0` counts problems FOUND, so a summary
// with no per-file entries reports "no new gap, no backsliding, no stale baseline entry" and exits 0.
// That is not a far-fetched input: an aborted c8 run, a config whose include pattern stops matching, or
// a stale summary from a region that has moved all produce a JSON file this gate reads happily. The
// non-screen and screens summaries each hold well over a hundred files, and the gate is invoked over
// both, so the floor has to clear the smaller one; 100 sits well under either.
// This is exit 2, not 1: a floor over a near-empty summary MEASURES NOTHING. The three inputs named in
// the paragraph above are an aborted c8 run, an include pattern that stopped matching and a summary from
// a region that has moved, and not one of them is a file falling under its coverage floor. Exit 1 would
// report this as backsliding that was found, which no run happened to establish. It still FAILS, and
// under scripts/run-gate-chain.mjs a refusal outranks a finding, so a chain carrying this cannot report a
// clean sweep either way.
if (files.length < 100) {
  console.error(`\n[coverage-per-file] CANNOT CHECK: ${summaryPath} holds ${files.length} file entr${files.length === 1 ? "y" : "ies"}, expected at least 100. A per-file floor over a near-empty summary measures nothing, so no file here was graded against a floor.\n  Re-run the coverage that produces it (npm run coverage), then re-run this gate.\n`);
  process.exit(2);
}

const regions = files.some((f) => f.file.startsWith("src/screens/")) ? (files.every((f) => f.file.startsWith("src/screens/")) ? "screens" : "screens + rest") : "rest";
console.log(`[coverage-per-file] ${files.length} files (${regions}), floors: screens ${SCREEN_FLOOR}% / rest ${REST_FLOOR}% statements, ${BASELINE.size} baselined`);
if (newGaps.length > 0) {
  console.log(`\nNEW FILES UNDER THE FLOOR (${newGaps.length}):`);
  for (const f of newGaps.sort((a, b) => a.pct - b.pct)) console.log(`  ${String(f.pct).padStart(6)}%  ${f.file} (${f.total} statements)`);
  console.log("\nCover it, or add it to BASELINE in this file with its current figure and a reason.");
}
if (backslid.length > 0) {
  console.log(`\nBASELINED FILES THAT GOT WORSE (${backslid.length}):`);
  for (const f of backslid) console.log(`  ${f.file}: was ${f.was}%, now ${f.pct}%`);
}
if (stale.length > 0) {
  console.log(`\nSTALE BASELINE ENTRIES (file no longer measured; delete them): ${stale.join(", ")}`);
}
if (staleAbove.length > 0) {
  console.log(`\nBASELINE ENTRIES NOW ABOVE THE FLOOR (well done; delete them): ${staleAbove.join(", ")}`);
}

const bad = newGaps.length + backslid.length + stale.length + staleAbove.length;
if (bad === 0) console.log("[coverage-per-file] OK: no new gap, no backsliding, no stale baseline entry.");
if (ENFORCE && bad > 0) {
  console.error(`\n[coverage-per-file] FAIL (enforce): ${bad} problem(s).`);
  process.exit(1);
}
