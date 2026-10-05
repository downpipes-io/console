// Validate that no destination-probe string in the console claims the engine reads the test file back.
//
// Run: node test/validate-destination-probe-copy.ts
//
// THE DEFECT. The destination "Verify and save" busy text said the engine writes a test file to the
// bucket, "then reading it back". The engine's live probe (router-posture.ts probeDestination) never
// reads the probe object back: it checks reachability and read authorisation with exists() on the
// RUNLOG key, writes a real test object, then makes a best-effort delete of it. A delete refusal
// (an object-locked/immutable archive bucket, for example) does not fail the probe, so the console must
// not claim the removal always succeeds either.
//
// THE POPULATION IS DERIVED, NOT LISTED. This file walks src/ for every file that mentions a "test
// file" written to a bucket/destination. Any such file is a destination-probe string and must not also
// claim a read-back. The canary is a different feature that genuinely reads its own data back (it seals,
// reads back, restores and verifies every byte), so canary copy is excluded by file path, not by wording.
//
// FS-WRITES: none outside this repo

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
let checks = 0;
function ok(name: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

const root = join(fileURLToPath(new URL("..", import.meta.url)));
function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
}
const files: string[] = [];
walk(join(root, "src"), files);

// The canary flies known data to every destination on a schedule and genuinely reads it back as part of
// proving the archive path end to end. It never mentions a "test file", so it never enters the
// destination-probe population below; it is named here only so a reviewer can see it was considered.
const CANARY_FILES = new Set(["src/screens/canary-sections.ts", "src/lib/demo/tour/scripts/chapters.ts"]);

const READBACK_RE = /reading it back|reads it back|read it back/i;
const TEST_FILE_RE = /test file/i;

console.log("-- the population: files that mention a test file written to a bucket/destination --");
const destProbeFiles = files
  .map((f) => ({ f, rel: relative(root, f).split("\\").join("/"), src: readFileSync(f, "utf8") }))
  .filter(({ src }) => TEST_FILE_RE.test(src));
for (const { rel } of destProbeFiles) console.log(`     ${rel}`);
ok("at least the setup destination question was found (the walk read src)", destProbeFiles.some(({ rel }) => rel === "src/screens/setup/b/q-destination.ts"));

console.log("\n-- no destination-probe string claims a read-back --");
for (const { rel, src } of destProbeFiles) {
  ok(`${rel} is not a canary file (canary genuinely reads back; excluded from this population by design)`, !CANARY_FILES.has(rel));
  ok(`${rel} does not claim the engine reads the test file back`, !READBACK_RE.test(src));
}

console.log("\n-- the busy text names what the probe actually does --");
const qDestination = readFileSync(join(root, "src/screens/setup/b/q-destination.ts"), "utf8");
ok(
  "q-destination.ts's Verify and save busy text checks reach, writes a test file, then removes it",
  qDestination.includes("Your engine is checking it can reach your bucket, writing a test file, then removing it."),
);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} validate-destination-probe-copy: ${checks} checks, ${failures} failures`);
verdictReached(failures, checks); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) process.exit(1);
