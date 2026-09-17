// Both directions on scripts/field-catalogue-gate.mjs's frozen-tree guard.
//
// WHY IT EXISTS. this gate exited 0 at "census 287 controls / catalogued 287 (100.0%)"
// against an internal-docs checkout 11 commits behind its own origin/main, with zero occurrences of the
// word "behind" anywhere in its output, while scripts/functional-catalogue-gate.mjs read that same sibling
// and exited 2 naming the lag. The guard added that day closes the gap. A guard that cannot tell a stale
// sibling from a current one is decoration, so both directions are asserted here rather than one.
//
// THE ISOLATION IS THE POINT. Both runs below read a catalogue and a census that are BYTE-IDENTICAL, in a
// checkout whose working tree is byte-identical. The only thing that moves between them is where
// refs/remotes/origin/main points. So an exit code that moves can only be the guard.
//
// THE FIXTURE IS SYNTHETIC, AND IT HAS TO BE. The first draft copied the real catalogue out of the
// internal-docs sibling and SKIPPED when there was none. The Validators job checks console out ALONE, so
// that draft skipped in the one place it most needed to run, which is the CI-RUNS-THE-WEAKER-HALF-OF-A-GATE
// shape this workspace has seen before. It also hand-rolled a walk up the parents to find
// the sibling, which scripts/sibling-resolution-gate.mjs refused as an UNCONDITIONAL GUESS, correctly, and
// for the R-30 reason. Generating the rows removes both problems: no sibling is read, so there is no
// resolution to get wrong and nothing to skip on.
//
// WHY test/validate-field-catalogue-gate.ts cannot cover this. That suite drives the gate with BOTH
// --census and --catalogue overridden, which is the one caller shape that reads nothing out of
// internal-docs and is therefore deliberately exempt from the guard (see the gate's own note on f600036).
// The exemption is asserted here too, because a guard that fired for that caller would take console main
// red exactly as f600036 did.
//
// FS-WRITES: none outside this repo

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeChecks } from "./validate-checks.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

const CONSOLE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(CONSOLE_ROOT, "scripts", "field-catalogue-gate.mjs");
const c = makeChecks();

// MIN_ROWS in the gate is 150 on each side and it is checked AFTER the guard, so the stale direction would
// pass with an empty fixture. The current direction has to get past it to reach the reconciliation, which
// is the thing the guard is standing in front of, so the fixture clears the floor with margin. Every pair
// is clean on G1, G2 and G3, so no burndown count moves and the only thing under test here is the guard.
const FIXTURE_ROWS = 160;
const DOC_URL = "https://docs.downpipes.io/synthetic-fixture/probe";
const catalogueRows: string[] = [];
const censusRows: string[] = [];
for (let i = 0; i < FIXTURE_ROWS; i++) {
  const key = `synthetic::stale-guard-${String(i).padStart(3, "0")}`;
  catalogueRows.push(JSON.stringify({ key, placeholder_status: "done", doc_url: DOC_URL, doc_answers: "yes" }));
  censusRows.push(JSON.stringify({ key, control: "input", mechanism: "field", hasPlaceholder: true, hasDoc: true }));
}

const ws = mkdtempSync(join(tmpdir(), "field-catalogue-stale-"));
const repo = join(ws, "internal-docs");
const cat = join(repo, "FIELD-CATALOGUE");
mkdirSync(cat, { recursive: true });
writeFileSync(join(cat, "catalogue.jsonl"), `${catalogueRows.join("\n")}\n`, "utf8");
writeFileSync(join(cat, "field-census.jsonl"), `${censusRows.join("\n")}\n`, "utf8");

const g = (...args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
g("init", "-q", "-b", "main");
g("config", "user.email", "selftest@example.invalid");
g("config", "user.name", "self test");
g("add", "-A");
g("commit", "-q", "-m", "the catalogue and its census");
const older = g("rev-parse", "HEAD");
writeFileSync(join(repo, "LATER.md"), "a later commit that touches neither file\n");
g("add", "LATER.md");
g("commit", "-q", "-m", "a later commit");
const newer = g("rev-parse", "HEAD");
// Back to the earlier tree, with the working tree byte-identical to what the later commit also holds for
// the two graded files. Only the ref moves between the two runs below.
g("checkout", "-q", older);

const run = (env: Record<string, string> = {}): { code: number; out: string } => {
  const r = spawnSync(process.execPath, [GATE], {
    encoding: "utf8",
    env: { ...process.env, DOWNPIPES_WORKSPACE: ws, ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

console.log("\n-- field-catalogue frozen-tree guard, both directions --\n");

// ---- 1. STALE: origin/main one commit ahead of the checked-out tree. --------------------------------
g("update-ref", "refs/remotes/origin/main", newer);
const stale = run();
c.eq("a sibling behind its own origin/main is REFUSED, exit 2", stale.code, 2);
c.has("and the refusal names the lag as a number", stale.out, "1 commit(s) behind its own origin/main");
c.has("and the tree line names the checkout it read", stale.out, "[field-catalogue] tree graded: internal-docs at");
c.has("and the tree line carries that checkout's HEAD", stale.out, older.slice(0, 7));
c.lacks("and no percentage is printed against the old tree", stale.out, "100.0%");

// ---- 2. The named escape hatch, and only that name. -------------------------------------------------
const allowed = run({ FIELD_CATALOGUE_ALLOW_STALE: "1" });
c.eq("FIELD_CATALOGUE_ALLOW_STALE=1 grades the old tree anyway", allowed.code, 0);
c.has("and still says how old it is, so the hatch is not a silencer", allowed.out, "1 commit(s) behind its own origin/main");
const wrongHatch = run({ FUNCTIONAL_CATALOGUE_ALLOW_STALE: "1" });
c.eq("its pair's hatch does NOT open this gate", wrongHatch.code, 2);

// ---- 3. CURRENT: the same bytes, at the same commit, with origin/main pointing there. ----------------
g("update-ref", "refs/remotes/origin/main", older);
const current = run();
c.eq("the SAME content at a current sibling grades, exit 0", current.code, 0);
c.has("and says 0 behind rather than saying nothing", current.out, "0 commit(s) behind its own origin/main");
c.has("and reaches the reconciliation it exists for", current.out, "[field-catalogue] census");

// ---- 4. The both-override caller is exempt, because it reads nothing out of internal-docs. -----------
g("update-ref", "refs/remotes/origin/main", newer);
const overridden = spawnSync(
  process.execPath,
  [GATE, "--census", join(cat, "field-census.jsonl"), "--catalogue", join(cat, "catalogue.jsonl")],
  { encoding: "utf8", env: { ...process.env, DOWNPIPES_WORKSPACE: ws } },
);
const overriddenOut = `${overridden.stdout}${overridden.stderr}`;
c.eq("a caller overriding both inputs is not refused", overridden.status ?? -1, 0);
c.lacks("and gets no tree line, because it read no sibling", overriddenOut, "tree graded");

rmSync(ws, { recursive: true, force: true });

console.log(
  c.failures === 0 ? "\nFIELD-CATALOGUE STALE-GUARD PASS\n" : `\nFIELD-CATALOGUE STALE-GUARD: ${c.failures} FAILED\n`,
);
verdictReached(c.failures);
process.exit(c.failures === 0 ? 0 : 1);
