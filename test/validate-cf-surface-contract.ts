// Guard test: the console
// computes a cf-config "zone-only" downpipe's surface list as
//   cfCatalogue.filter(s => s.scope === "zone").map(s => s.id)
// duplicated at each of its call sites (src/screens/sources-downpipes/editor-wizard-source-rows.ts:261,
// editor-cf-config-section.ts:84/67, editor-wizard.ts:567) off a HAND-TYPED wire type
// (SourceDiscovery.cfConfigSurfaces, src/lib/api/types/sources.ts) with NO shared contract, import, or
// codegen link to the engine's own registry (engine/src/sources/cf-config-registry*.ts, re-exported via
// cf-config-catalogue.ts's cfConfigCatalogue()). If a future engine change renames, adds, removes, or
// re-tags a surface's `scope`, the console keeps filtering by its old assumption, silently either leaking
// an account-scoped surface into a "this zone only" downpipe, or dropping a zone surface it should have
// captured.
//
// WHAT THIS FILE USED TO BE, because the shape is worth writing down. It carried a committed
// ENGINE_CF_CONFIG_SNAPSHOT of {total: 314, zone: 119, account: 195} and a buildFixtureCatalogue() that
// pushed filler entries INTO LOOPS BOUNDED BY THOSE NUMBERS, then asserted the fixture's counts back
// against them. Every assertion was a tautology by construction: the zone count could not disagree with the
// number the zone loop had counted up to, and the "a known ZONE surface is selected" pair tested two rows
// the fixture itself hardcoded. The header said the file could not detect engine drift and only pinned
// "today's truth in one place a human can diff against".
//
// It could not do even that. Measured the engine's own validator
// (engine/test/validate-cf-config-surface-count.ts) printed {"total":313,...,"zone":118,"account":195}: the
// snapshot was stale by one zone surface and every assertion here was green. A tripwire nobody can trip is
// not a weaker check than a real one, it is a green line in a test log standing where a check should be.
//
// SO THE CATALOGUE IS THE ENGINE'S OWN NOW. The fixture is gone. cfConfigCatalogue() is imported from the
// engine checkout and the console's real selector expression runs over it, which is the only arrangement in
// which "the console's zone-only selector agrees with the engine's scope tags" is a claim rather than a
// restatement. Absent an engine this SKIPS on one declared line, and REQUIRE_ENGINE=1 (the cross-repo
// chain) makes the absence a throw upstream in importFromEngine, as with every other cross-repo check here.
//
// House style: Australian English, no em dashes, no rule-of-three.
//
// Run with: node test/validate-cf-surface-contract.ts

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { engineRoots, importFromEngine } from "./engine-path.ts";
import { verdictCannotCheck, verdictReached, verdictSkipped } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

const here = `${dirname(fileURLToPath(import.meta.url))}/`;

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// The message every assertion carries, so a red CI run does not have to be reverse-engineered. It no longer
// says "refresh the fixture", because there is no fixture to refresh: a red line here means the engine's
// scope tags moved and the four console call sites need reading.
const DRIFT_MSG = "engine cf-config scope tags moved; re-check the console zone-only selector at its four call sites.";

// The console's own wire shape (mirrors SourceDiscovery.cfConfigSurfaces, src/lib/api/types/sources.ts:67,
// and WizardState.cfCatalogue, editor-wizard-source-rows.ts:47 -- kept in sync by hand, which is exactly the
// gap this test exists to make visible).
interface CatalogueEntry {
  id: string;
  label: string;
  category: string;
  scope: "zone" | "account";
  restoreTier: string;
}

// consoleZoneOnlySurfaceIds is the console's OWN zone-only selector, reproduced VERBATIM from its real call
// sites (editor-wizard-source-rows.ts:261 `state.cfCatalogue.filter((s) => s.scope === "zone").map((s) =>
// s.id)`; the same expression appears at editor-cf-config-section.ts:84/67 and editor-wizard.ts:567). If any
// of those diverges from this line, THIS TEST no longer proves what it claims to -- keep it byte-identical
// to the real filter/map expression, not just equivalent.
function consoleZoneOnlySurfaceIds(cfCatalogue: CatalogueEntry[]): string[] {
  return cfCatalogue.filter((s) => s.scope === "zone").map((s) => s.id);
}

const CATALOGUE_REL = "src/sources/cf-config-catalogue.ts";

// REACHABILITY IS SETTLED BEFORE THE IMPORT, and not for tidiness. importFromEngine THROWS under
// REQUIRE_ENGINE=1, which leaves an unhandled rejection, a stack trace and exit 1: three things that say
// "this repository is wrong" about a checkout that is merely missing a sibling. Asking first lets the
// refusal be a refusal, exit 2, with a sentence instead of a stack. Measured at console 7bf0734b in a
// checkout with no sibling engine: REQUIRE_ENGINE=1 exited 1 through the throw.
if (engineRoots(here).map((r) => resolve(r, CATALOGUE_REL)).find((f) => existsSync(f)) === undefined && process.env.REQUIRE_ENGINE === "1") {
  verdictCannotCheck(
    "validate-cf-surface-contract: REFUSED, REQUIRE_ENGINE=1 and no engine checkout is reachable.\n" +
      "  Every surface this file grades is read from the engine's own cf-config-catalogue.ts, so with no\n" +
      "  engine there is nothing here that compares anything and it will not report that it did.\n" +
      "  Point it at one with DOWNPIPES_ENGINE=/path/to/engine and re-run.",
  );
}

const catalogueMod = await importFromEngine(here, CATALOGUE_REL);
if (catalogueMod === null) {
  // DECLARED, not silent, and worded CANNOT CHECK because that is what it is: unlike its neighbours this
  // file has no console-only half, so with no engine every assertion in it is absent rather than reduced.
  // The exit code stays 0 on a console-only clone, which legitimately has no engine; the refusal above is
  // what makes the absence fatal in the one job built to compare the two repositories.
  verdictSkipped("CF SURFACE CONTRACT: CANNOT CHECK, no engine checkout reachable, so nothing here compared anything");
  process.exit(0);
}

const catalogue = (catalogueMod as { cfConfigCatalogue: () => CatalogueEntry[] }).cfConfigCatalogue();

console.log("\n-- the engine's registry, read live, not a snapshot of it --");
// A NON-VACUITY FLOOR, and it is the assertion the old file most needed. An import that resolved to an empty
// catalogue would make every comparison below trivially true, which is the failure this rewrite is about.
// The floor sits far under the real count on purpose: it catches an empty or broken read, it does not stand
// in for the comparisons.
ok(`the engine catalogue is non-empty (read ${catalogue.length} surfaces)`, catalogue.length >= 100);

const zone = catalogue.filter((s) => s.scope === "zone");
const account = catalogue.filter((s) => s.scope === "account");
ok(`every surface carries a scope the console knows about, zone ${zone.length} plus account ${account.length} of ${catalogue.length} (${DRIFT_MSG})`, zone.length + account.length === catalogue.length);

console.log("\n-- the console's zone-only selector agrees with the engine's own scope tags --");
const zoneIds = consoleZoneOnlySurfaceIds(catalogue);
const zoneSet = new Set(zoneIds);
// The claim this file has always made and never tested: the console's expression, run over the engine's
// rows, selects the zone-scoped set and nothing else. Both directions, because leaking an account surface
// into a zone-only downpipe and dropping a zone surface are different defects with different blast radii.
const leaked = account.filter((s) => zoneSet.has(s.id)).map((s) => s.id);
const dropped = zone.filter((s) => !zoneSet.has(s.id)).map((s) => s.id);
ok(`no ACCOUNT-scoped surface is selected into a zone-only downpipe (${DRIFT_MSG})${leaked.length > 0 ? `, leaked: ${leaked.join(", ")}` : ""}`, leaked.length === 0);
ok(`no ZONE-scoped surface is dropped from a zone-only downpipe (${DRIFT_MSG})${dropped.length > 0 ? `, dropped: ${dropped.join(", ")}` : ""}`, dropped.length === 0);
ok("the selector yields ids, which is what the wizard sends", zoneIds.every((id) => typeof id === "string" && id.length > 0));

console.log("\n-- two surfaces a reader can check by eye still carry the scope the engine assigns them --");
// Named rows rather than counts. Not a second opinion on the comparisons above, a readable anchor: if the
// engine ever re-tagged DNS as account-scoped, the diff a reviewer sees should say so in words. Both are
// read from the engine's catalogue, so neither line can be satisfied by anything the console holds.
for (const [id, expected] of [
  ["dns", "zone"],
  ["account-members", "account"],
] as const) {
  const entry = catalogue.find((s) => s.id === id);
  ok(`the engine still declares a surface "${id}"`, entry !== undefined);
  ok(`"${id}" carries scope:"${expected}" (${DRIFT_MSG})`, entry?.scope === expected);
}

console.log(failures === 0 ? "\nALL CF-SURFACE-CONTRACT VECTORS PASS" : `\n${failures} FAILURE(S)`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
process.exit(failures > 0 ? 1 : 0);
