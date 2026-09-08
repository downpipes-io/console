// The recovery-point tiles must report the fleet's WORST case, never its best.
//
// WHY THIS EXISTS
// ---------------
// Both recovery-point tiles read `fleet.newestGoodAt`, the freshest good backup
// anywhere in the fleet, under the label "Recovery point (RPO)". A fleet with one downpipe backed up five
// minutes ago and nine untouched for a month rendered "Recovery point (RPO): 5m ago, Fleet-wide".
//
// A recovery point answers how much you could lose right now. That is set by the STALEST protected system,
// never the freshest. So the highest-billing "is it working" tile on the page was reassuring in exactly the
// direction that hides risk, under a term of art an operator may already trust from other tooling.
//
// The arithmetic was never wrong about what it computed, and both tiles said so in their own comments and
// secondary text. That is precisely why nothing caught it: every part was locally honest and the headline
// was not. A comment saying what a number is does not stop a label saying it is something else.
//
// WHAT IT CHECKS
// --------------
// It drives the real derivation from `src/screens/overview/fleet-data.ts` over synthetic fleets whose right
// answer is known by construction, rather than asserting on the text of the tiles. A test that reads the
// label would pass the moment somebody restored the old value under the new words.
//
// The cases are chosen so that best-case and worst-case DIFFER. A fleet where every downpipe is equally
// fresh cannot tell the two implementations apart, and a suite made of those cases would have passed
// against the defect this file exists to catch.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.
//
//   node test/validate-recovery-point-is-worst-case.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { worstRecoveryPointFrom } from "../src/screens/overview/fleet-data.ts";
import type { FleetRow } from "../src/screens/overview/shared.ts";

const HERE = new URL(".", import.meta.url).pathname;
const FLEET_DATA = resolve(HERE, "../src/screens/overview/fleet-data.ts");
const TILES = resolve(HERE, "../src/screens/overview/tiles.ts");
const RECOVERY = resolve(HERE, "../src/screens/overview/recovery.ts");

let failures = 0;
let checks = 0;

function fail(msg: string): void {
  failures += 1;
  console.error(`  FAIL ${msg}`);
}

function ok(msg: string): void {
  checks += 1;
  console.log(`  ok   ${msg}`);
}

// ---- 1. the derivation, driven rather than read ------------------------------------------------------
//
// worstRecoveryPointFrom is imported and driven, not re-implemented here. A second copy written in this
// file would be a copy checked against a copy and would prove nothing about what renders. The guard below
// refuses if the export disappears, so unexporting it fails loudly rather than skipping this section.

const fleetSrc = readFileSync(FLEET_DATA, "utf8");
if (!fleetSrc.includes("export function worstRecoveryPointFrom")) {
  console.error("validate-recovery-point-is-worst-case: REFUSED, worstRecoveryPointFrom is not exported from fleet-data.ts.");
  console.error("  The derivation this file grades was renamed or unexported. Fix this reader rather than dropping the check.");
  process.exit(2);
}

type Row = { freshness: FleetRow["freshness"]; lastGoodAt: string | null };

const T = (iso: string) => iso;
const MONTH_AGO = T("2026-07-06T00:00:00.000Z");
const HOUR_AGO = T("2026-08-06T07:00:00.000Z");
const FIVE_MIN_AGO = T("2026-08-06T07:55:00.000Z");

// The load-bearing case: this is the exact scenario described above, and the old implementation returned
// FIVE_MIN_AGO for it.
{
  const rows: Row[] = [
    { freshness: "healthy", lastGoodAt: FIVE_MIN_AGO },
    ...Array.from({ length: 9 }, (): Row => ({ freshness: "stale", lastGoodAt: MONTH_AGO })),
  ];
  const r = worstRecoveryPointFrom(rows);
  if (r.worstGoodAt !== MONTH_AGO) fail(`one fresh downpipe among nine month-old ones must report the month, got ${String(r.worstGoodAt)}`);
  else ok("one fresh downpipe among nine stale ones reports the STALE age, not the fresh one");
  if (r.noGoodBackupCount !== 0) fail(`no downpipe here lacks a backup, yet noGoodBackupCount is ${r.noGoodBackupCount}`);
  else ok("a fleet where every downpipe has a good backup counts none as missing");
}

// A downpipe that never backed up must NOT be rendered as a duration. Its recovery point is undefined, and
// any duration printed for it is smaller than the truth, which is the same error class as the original bug.
{
  const rows: Row[] = [
    { freshness: "healthy", lastGoodAt: FIVE_MIN_AGO },
    { freshness: "failed", lastGoodAt: null },
  ];
  const r = worstRecoveryPointFrom(rows);
  if (r.noGoodBackupCount !== 1) fail(`a downpipe with no good backup must be counted, got ${r.noGoodBackupCount}`);
  else ok("a downpipe that has never backed up is counted rather than folded into a duration");
}

// A disabled downpipe is a decision, not an unmet obligation. Counting it would make the metric permanently
// alarming for a fleet behaving exactly as configured, which is how a risk metric gets ignored.
{
  const rows: Row[] = [
    { freshness: "healthy", lastGoodAt: HOUR_AGO },
    { freshness: "disabled", lastGoodAt: MONTH_AGO },
    { freshness: "disabled", lastGoodAt: null },
  ];
  const r = worstRecoveryPointFrom(rows);
  if (r.worstGoodAt !== HOUR_AGO) fail(`a disabled downpipe must not set the recovery point, got ${String(r.worstGoodAt)}`);
  else ok("a disabled downpipe sets neither the worst case nor the missing count");
  if (r.noGoodBackupCount !== 0) fail(`a disabled downpipe with no backup must not count as missing, got ${r.noGoodBackupCount}`);
  else ok("a disabled downpipe with no good backup is not counted as missing");
}

// An empty fleet must not invent a recovery point.
{
  const r = worstRecoveryPointFrom([]);
  if (r.worstGoodAt !== null || r.noGoodBackupCount !== 0) fail("an empty fleet must report no recovery point and no missing count");
  else ok("an empty fleet reports no recovery point rather than inventing one");
}

// ---- 2. neither tile may read the BEST case again ----------------------------------------------------
//
// This is the regression that would silently restore the defect: the derivation stays correct and a tile
// goes back to reading newestGoodAt. Checked at the two render sites only.

for (const [name, path] of [["tiles.ts", TILES], ["recovery.ts", RECOVERY]] as const) {
  const src = readFileSync(path, "utf8");
  const assigns = [...src.matchAll(/const\s+rpo\s*=\s*fleet\.(\w+)/g)].map((m) => m[1]);
  if (assigns.length === 0) {
    fail(`${name} no longer assigns an rpo value, so this check cannot see what the tile renders`);
    continue;
  }
  const best = assigns.filter((a) => a === "newestGoodAt");
  if (best.length > 0) fail(`${name} sets the recovery-point value from fleet.newestGoodAt, which is the fleet's BEST case`);
  else ok(`${name} takes its recovery-point value from the worst case, not newestGoodAt`);
}

// The two tiles must agree. They render the same fact on the same page, and a page that shows one number
// twice with two values is worse than either number alone.
{
  const a = [...readFileSync(TILES, "utf8").matchAll(/const\s+rpo\s*=\s*fleet\.(\w+)/g)].map((m) => m[1]);
  const b = [...readFileSync(RECOVERY, "utf8").matchAll(/const\s+rpo\s*=\s*fleet\.(\w+)/g)].map((m) => m[1]);
  if (a.length && b.length && a[0] !== b[0]) fail(`the two recovery-point tiles read different fields (${String(a[0])} vs ${String(b[0])}), so the same page can show two answers`);
  else ok("both recovery-point tiles read the same field, so they cannot disagree");
}

if (failures > 0) process.exitCode = 1;
console.log(`\nVERDICT: ${failures === 0 ? "PASS" : "FAIL"} failures=${failures} checks=${checks} entry=validate-recovery-point-is-worst-case.ts`);
process.exit(failures === 0 ? 0 : 1);
