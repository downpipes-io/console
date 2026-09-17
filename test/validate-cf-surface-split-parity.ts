// The demo seed's in-band and available flags must match the engine catalogue.
//
// WHY THIS EXISTS
// ---------------
// The seed carries a hand-written sample of the real cf-config catalogue, and the comment above it has
// always claimed "each value below matches the engine's PROVEN_WRITE_SURFACES for that id". Nothing
// checked that claim. No test file in this repo referenced `inBand` at all.
//
// The claim is not decorative. The demo is what the tour, the screenshots and every browser journey
// drive, so a seed that marks a surface as restoring in console when the product does not is a false
// restore promise shown to a prospect, and it is shown in the one place a customer forms their
// expectation of how much downpipes writes back.
//
// It is also the least stable claim in the file. `PROVEN_WRITE_SURFACES` changes every time a surface
// passes the live round trip, which is the active work on the engine branch, and each success moves a
// surface from available to in-band. A hand-written mirror of a set that is deliberately being changed
// will drift, and the only question is whether anything notices.
//
// WHAT IT CHECKS
// --------------
//   1. Every seeded id exists in the engine catalogue. A seeded id the engine has never heard of is a
//      vocabulary the demo teaches and the product does not use.
//   2. inBand matches the engine for that id.
//   3. available matches the engine for that id, treating a missing field as false, which is how the
//      console's own mapping reads it.
//   4. No seeded surface is BOTH. The engine derives them from one expression so they cannot overlap
//      there; this asserts the seed did not invent an overlap by hand.
//   5. The seed contains at least one of each state. A seed with no available surface leaves the badge
//      branch unreachable in every journey that drives the demo, which is how that state went unrendered
//      for as long as it did: the field was declared on the API type, sent by the engine, and dropped by
//      the console, and no fixture existed that would have shown the gap.
//
// The engine is resolved through the shared helper, so an override or a worktree layout is honoured the
// same way as every other cross-repo gate here. Absent an engine this SKIPS, unless REQUIRE_ENGINE=1.
//
//   node test/validate-cf-surface-split-parity.ts

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
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
  // DECLARED, not silent. Measured in a checkout with no sibling engine: this returned exit 0 having run
  // none of its parity checks, and nothing in the log distinguished that from a run that checked and passed.
  // The exit code stays 0 on purpose (a console-only clone legitimately has no engine); what changes is that
  // the skip is now one greppable line, and REQUIRE_ENGINE=1 in the cross-repo chain still makes it a throw
  // upstream in importFromEngine.
  verdictSkipped("CF SURFACE SPLIT PARITY: no engine checkout reachable");
  process.exit(0);
}

const catalogue = (catalogueMod as { cfConfigCatalogue: () => Array<{ id: string; inBand: boolean; available: boolean }> }).cfConfigCatalogue();
const byId = new Map(catalogue.map((s) => [s.id, s]));

// Read the seed as TEXT rather than importing it: the seed module builds a whole demo world and pulls in
// browser-shaped dependencies, and this gate is about the literal values a reviewer sees in the file.
const seedSrc = readFileSync(`${here}../src/lib/demo/demo-seed.ts`, "utf8");
const block = /cfConfigSurfaces:\s*\[([\s\S]*?)\n\s*\],/.exec(seedSrc);
if (block === null) {
  console.error("FAIL could not find the cfConfigSurfaces seed block. If it moved, update this gate.");
  // The verdict is DECLARED before the exit: without it the completion guard prints on top of this
  // deliberate finding, and the canonical VERDICT line a log reader greps for never appears at all.
  // The exit code is unchanged.
  verdictReached(1, 1);
  process.exit(1);
}

const seeded: Array<{ id: string; inBand: boolean; available: boolean }> = [];
for (const line of block[1]!.split("\n")) {
  const idm = /\{\s*id:\s*"([^"]+)"/.exec(line);
  if (idm === null) continue;
  seeded.push({
    id: idm[1]!,
    inBand: /inBand:\s*true/.test(line),
    available: /available:\s*true/.test(line),
  });
}

ok(`seed block parsed (${seeded.length} surfaces)`, seeded.length > 0);

for (const s of seeded) {
  const live = byId.get(s.id);
  if (live === undefined) {
    ok(`${s.id}: exists in the engine catalogue`, false);
    continue;
  }
  ok(`${s.id}: inBand ${s.inBand} matches engine ${live.inBand}`, s.inBand === live.inBand);
  ok(`${s.id}: available ${s.available} matches engine ${live.available}`, s.available === live.available);
  ok(`${s.id}: not both in-band and available`, !(s.inBand && s.available));
}

ok("seed contains at least one IN-BAND surface", seeded.some((s) => s.inBand));
ok("seed contains at least one AVAILABLE surface", seeded.some((s) => s.available));
ok("seed contains at least one surface that is neither", seeded.some((s) => !s.inBand && !s.available));

console.log(failures === 0 ? `\nCF SURFACE SPLIT PARITY PASS (${seeded.length} seeded surfaces vs the engine catalogue)` : `\n${failures} FAILURE(S)`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
process.exit(failures === 0 ? 0 : 1);
