// Mutation test for scripts/field-catalogue-gate.mjs's --enforce exit code.
//
// WHAT A "G1/G2/G3 GAP" IS, IN THE GATE'S OWN TERMS (field-catalogue-gate.mjs:124-138)
// -------------------------------------------------------------------------------------
// The gate reconciles a catalogue row against the matching census row for the same control and grades
// three guarantees, each read from the census (the SOURCE), not the catalogue's own self-report, so a row
// that merely claims a placeholder or a doc link cannot pass:
//
//   G1 placeholder gap  a typeable, non-exempt catalogue row whose census entry has hasPlaceholder=false
//                       (line 128: `!placeholderExempt(r) && !censusByKey.get(r.key)?.hasPlaceholder`).
//   G2 doc-link gap     a non-exempt row whose FIELD-mechanism census entry has hasDoc=false, or whose
//                       RAW/group-mechanism catalogue row has no doc_url (lines 129-137).
//   G3 doc-answers gap  a catalogue row that carries a doc_url but whose own doc_answers column is not the
//                       literal string "yes" (line 138: `r.doc_url && r.doc_answers !== "yes"`).
//
// `--enforce` sums missing + orphan + g1gaps + g2gaps + g3gaps into hardFail and exits 1 if it is nonzero
// (line 181-184). G1 and G2 are wired into the same formula as G3, with no test covering any of the three
// beforehand, so this file covers all three rather than only one.
//
// WHY A SYNTHETIC FIXTURE, NOT A COPY OF THE REAL CATALOGUE
// -----------------------------------------------------------
// The catalogue is a shared, hand-maintained artefact; a test that edits it (even a copy sharing its 278
// real rows and their EXEMPT-map entries) risks reproducing today's exact shape forever and silently
// drifting from the gate's actual rules as the catalogue and EXEMPT map evolve. A small synthetic
// catalogue+census pair, built fresh in this file, tests the gate's LOGIC directly, needs no sibling
// checkout, and runs the same way in `npm run validate` (a single-repo CI job) as every other file in that
// chain. See scripts/field-catalogue-gate.mjs's --census/--catalogue override comments for the mechanism
// that makes this possible: both inputs can be pointed at a private path instead of the committed
// artefacts.
//
// This test never opens the real catalogue file at all -- not "restores it after mutating", but never
// reads or writes it in the first place, which is the stronger guarantee.
//
// MIN_ROWS: the gate refuses to grade anything below 150 rows on either side (field-catalogue-gate.mjs:48-56)
// and exits 1 regardless of G1/G2/G3, so the fixture must clear that floor or a floor-triggered exit 1 would
// look identical to a genuine gap-triggered one from the outside. FIXTURE_SIZE below clears it with margin.
//
// FS-WRITES: none outside this repo

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeChecks } from "./validate-checks.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

const checks = makeChecks();
const { ok, eq } = checks;

const GATE = join("scripts", "field-catalogue-gate.mjs");
const DOC_URL = "https://docs.downpipes.io/synthetic-fixture/probe";

interface CatalogueRow {
  key: string;
  placeholder_status: string;
  doc_url: string | null;
  doc_answers: string;
}
interface CensusRow {
  key: string;
  control: string;
  mechanism: string;
  hasPlaceholder: boolean;
  hasDoc: boolean;
}

// A clean row that fails none of G1/G2/G3: typeable field-mechanism control, placeholder present, doc
// present and answering. Repeated to clear MIN_ROWS on both sides without affecting any gap count.
function cleanPair(key: string): { cat: CatalogueRow; census: CensusRow } {
  return {
    cat: { key, placeholder_status: "done", doc_url: DOC_URL, doc_answers: "yes" },
    census: { key, control: "input", mechanism: "field", hasPlaceholder: true, hasDoc: true },
  };
}

const FIXTURE_SIZE = 160;
const FILLERS = FIXTURE_SIZE - 4; // minus the 4 named probes below

function buildFixture(): { cat: CatalogueRow[]; census: CensusRow[] } {
  const cat: CatalogueRow[] = [];
  const census: CensusRow[] = [];
  for (let i = 0; i < FILLERS; i++) {
    const { cat: c, census: s } = cleanPair(`synthetic::filler-${String(i).padStart(3, "0")}`);
    cat.push(c);
    census.push(s);
  }
  // G1 probe: typeable field-mechanism control, clean by default (hasPlaceholder true).
  {
    const { cat: c, census: s } = cleanPair("synthetic::g1-probe");
    cat.push(c);
    census.push(s);
  }
  // G2 probe (field mechanism branch): clean by default (hasDoc true).
  {
    const { cat: c, census: s } = cleanPair("synthetic::g2-field-probe");
    cat.push(c);
    census.push(s);
  }
  // G2 probe (raw/group mechanism branch): mechanism raw-input, so G2 reads catalogue.doc_url instead of
  // census.hasDoc (field-catalogue-gate.mjs:136). Clean by default (doc_url set).
  {
    const key = "synthetic::g2-raw-probe";
    cat.push({ key, placeholder_status: "done", doc_url: DOC_URL, doc_answers: "yes" });
    census.push({ key, control: "text", mechanism: "raw-input", hasPlaceholder: true, hasDoc: false });
  }
  // G3 probe: clean by default (doc_answers "yes").
  {
    const { cat: c, census: s } = cleanPair("synthetic::g3-probe");
    cat.push(c);
    census.push(s);
  }
  return { cat, census };
}

function toJsonl(rows: unknown[]): string {
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

function runGate(catalogueRows: CatalogueRow[], censusRows: CensusRow[], dir: string): { status: number; stdout: string } {
  mkdirSync(dir, { recursive: true });
  const catPath = join(dir, "catalogue.jsonl");
  const censusPath = join(dir, "field-census.jsonl");
  writeFileSync(catPath, toJsonl(catalogueRows), "utf8");
  writeFileSync(censusPath, toJsonl(censusRows), "utf8");
  try {
    const stdout = execFileSync("node", [GATE, "--enforce", "--catalogue", catPath, "--census", censusPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (e) {
    // FAIL (enforce) is printed via console.error (scripts/field-catalogue-gate.mjs:183), so on a
    // non-zero exit the message this test looks for is on stderr, not stdout; concatenate both so the
    // burndown-line regexes (all on stdout) and the failure-message check (stderr) both work off one string.
    const err = e as { status: number | null; stdout: string; stderr: string };
    return { status: err.status ?? 1, stdout: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function burndown(stdout: string, label: string): number {
  const re = new RegExp(`${label}[^:]*:\\s+(\\d+)`);
  const m = stdout.match(re);
  return m ? Number(m[1]) : Number.NaN;
}

const tmp = mkdtempSync(join(tmpdir(), "field-catalogue-gate-mutation-"));
console.log(`-- Field-catalogue gate mutation test (private fixture at ${tmp}) --`);

try {
  const base = buildFixture();

  // BASELINE: the unmutated fixture must pass --enforce (exit 0), and every burndown count must be zero.
  const clean = runGate(base.cat, base.census, join(tmp, "clean"));
  ok("clean synthetic fixture: gate --enforce exits 0", clean.status === 0);
  eq("clean fixture: G1 gaps = 0", burndown(clean.stdout, "G1 placeholder gaps"), 0);
  eq("clean fixture: G2 gaps = 0", burndown(clean.stdout, "G2 doc-link gaps"), 0);
  eq("clean fixture: G3 gaps = 0", burndown(clean.stdout, "G3 doc-answers gaps"), 0);
  eq("clean fixture: uncatalogued (missing) = 0", burndown(clean.stdout, "uncatalogued controls"), 0);
  eq("clean fixture: orphan rows = 0", burndown(clean.stdout, "orphan catalogue rows"), 0);

  // G1: plant a placeholder gap by flipping the probe's CENSUS hasPlaceholder to false (the gate reads G1
  // from the census, never from the catalogue's own placeholder_status -- field-catalogue-gate.mjs:128).
  {
    const mutantCensus = base.census.map((r) => (r.key === "synthetic::g1-probe" ? { ...r, hasPlaceholder: false } : r));
    const mutant = runGate(base.cat, mutantCensus, join(tmp, "g1-mutant"));
    ok("G1 gap planted (census hasPlaceholder=false): gate --enforce exits 1", mutant.status === 1);
    eq("G1 gap planted: G1 count = 1", burndown(mutant.stdout, "G1 placeholder gaps"), 1);
    eq("G1 gap planted: G2 count stays 0", burndown(mutant.stdout, "G2 doc-link gaps"), 0);
    eq("G1 gap planted: G3 count stays 0", burndown(mutant.stdout, "G3 doc-answers gaps"), 0);
    ok("G1 gap planted: stdout names the enforce failure", mutant.stdout.includes("FAIL (enforce)"));

    const reverted = runGate(base.cat, base.census, join(tmp, "g1-reverted"));
    ok("G1 gap reverted (same probe, hasPlaceholder=true again): gate --enforce exits 0", reverted.status === 0);
  }

  // G2 (field-mechanism branch): plant a doc-link gap by flipping the probe's CENSUS hasDoc to false.
  {
    const mutantCensus = base.census.map((r) => (r.key === "synthetic::g2-field-probe" ? { ...r, hasDoc: false } : r));
    const mutant = runGate(base.cat, mutantCensus, join(tmp, "g2-field-mutant"));
    ok("G2 gap planted, field mechanism (census hasDoc=false): gate --enforce exits 1", mutant.status === 1);
    eq("G2 gap planted (field): G2 count = 1", burndown(mutant.stdout, "G2 doc-link gaps"), 1);
    eq("G2 gap planted (field): G1 count stays 0", burndown(mutant.stdout, "G1 placeholder gaps"), 0);
    eq("G2 gap planted (field): G3 count stays 0", burndown(mutant.stdout, "G3 doc-answers gaps"), 0);

    const reverted = runGate(base.cat, base.census, join(tmp, "g2-field-reverted"));
    ok("G2 gap reverted (same probe, hasDoc=true again): gate --enforce exits 0", reverted.status === 0);
  }

  // G2 (raw/group-mechanism branch): plant a doc-link gap by clearing the probe's CATALOGUE doc_url. This
  // exercises the OTHER half of the G2 ternary (field-catalogue-gate.mjs:136), which the field-mechanism
  // case above never reaches.
  {
    const mutantCat = base.cat.map((r) => (r.key === "synthetic::g2-raw-probe" ? { ...r, doc_url: null } : r));
    const mutant = runGate(mutantCat, base.census, join(tmp, "g2-raw-mutant"));
    ok("G2 gap planted, raw mechanism (catalogue doc_url=null): gate --enforce exits 1", mutant.status === 1);
    eq("G2 gap planted (raw): G2 count = 1", burndown(mutant.stdout, "G2 doc-link gaps"), 1);
    eq("G2 gap planted (raw): G1 count stays 0", burndown(mutant.stdout, "G1 placeholder gaps"), 0);
    eq("G2 gap planted (raw): G3 count stays 0", burndown(mutant.stdout, "G3 doc-answers gaps"), 0);

    const reverted = runGate(base.cat, base.census, join(tmp, "g2-raw-reverted"));
    ok("G2 gap reverted (same probe, doc_url restored): gate --enforce exits 0", reverted.status === 0);
  }

  // G3: plant a doc-answers gap by setting the probe's CATALOGUE doc_answers away from "yes", keeping its
  // doc_url set (field-catalogue-gate.mjs:138 requires doc_url truthy AND doc_answers !== "yes" -- a row
  // with no doc_url at all is a G2 gap, not G3, so this specifically proves the G3 branch, not G2's).
  {
    const mutantCat = base.cat.map((r) => (r.key === "synthetic::g3-probe" ? { ...r, doc_answers: "no" } : r));
    const mutant = runGate(mutantCat, base.census, join(tmp, "g3-mutant"));
    ok("G3 gap planted (catalogue doc_answers != 'yes', doc_url still set): gate --enforce exits 1", mutant.status === 1);
    eq("G3 gap planted: G3 count = 1", burndown(mutant.stdout, "G3 doc-answers gaps"), 1);
    eq("G3 gap planted: G1 count stays 0", burndown(mutant.stdout, "G1 placeholder gaps"), 0);
    eq("G3 gap planted: G2 count stays 0", burndown(mutant.stdout, "G2 doc-link gaps"), 0);

    const reverted = runGate(base.cat, base.census, join(tmp, "g3-reverted"));
    ok("G3 gap reverted (same probe, doc_answers='yes' again): gate --enforce exits 0", reverted.status === 0);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(checks.failures === 0 ? "\nFIELD-CATALOGUE GATE MUTATION TEST PASS" : `\n${checks.failures} FAILURE(S)`);
verdictReached(checks.failures);
if (checks.failures > 0) process.exit(1);
