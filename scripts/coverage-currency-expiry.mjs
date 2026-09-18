// COVERAGE CURRENCY: which catalogued controls did THIS commit expire, said at the moment it expires them.
//
// WHY THIS EXISTS. A control-grain verdict is banked against the exact bytes of the control's own source
// file (scripts/verdict-record.mjs, CURRENCY IS CONTENT NOT HISTORY). That is what makes the coverage
// figure honest and it is also what makes it perishable: a console commit that moves a file carrying a
// catalogued control silently drops every verdict banked against it, with no test touched and no control
// carrying a standing failure before or after. That is currency loss wearing coverage loss's clothes, and
// it is easy to miss because nothing else about the commit looks wrong.
//
// THE GAP IS DELIVERY, NOT DETECTION. functional-catalogue-gate --enforce-currency already exits 1 on
// exactly this debt, wired to .github/workflows/coverage-currency.yml, and hooks/pre-push reads that
// workflow's conclusion. But the hook prints only on `failure`, and a workflow run that has not been
// re-triggered keeps reporting its last conclusion rather than "unknown", so a currency loss can pass
// straight through a check that never re-ran: the answer arrives, is stale, and is read as current anyway.
// This tool's own header warns that "could not check" must never print as "green"; the risk here is that
// same failure one level down.
//
// So what is added here is not another detector. It is an answer that needs no network, no `gh`, no Actions
// minutes and no workflow to have run, and that names the controls rather than counting them.
//
// WHAT IT DOES NOT DO: it does not block a push. That is a decision with a reason, not a default, and the
// reason is in hooks/pre-push beside the call. Briefly: a stale proof over an otherwise-clean control is
// not itself a defect, and refusing a landing over one would rank it above the real failures the
// currency/regression split exists to keep visible.
//
// HOW IT ANSWERS "WHICH CONTROLS", by content and never by path. It scores the committed verdict record
// against a tree twice, once at a commit and once at that commit's parent, and reports the controls that
// carried a standing verdict at the parent and do not at the child. Both scorings go through scoreRecord()
// from verdict-record.mjs, which is the same function functional-catalogue-gate.mjs scores with, so this
// cannot drift from the gate's own arithmetic. A path heuristic ("this commit touched a screen file, so
// assume the worst") was rejected: it cannot tell a formatting change that moves a file's bytes from one
// that does not, and both of those are exactly what the digest already knows.
//
// EXIT CODES. 0 clean, 1 finding, 2 could-not-check, and COULD-NOT-CHECK OUTRANKS A PASS. The population is
// asserted before any verdict is returned, because "no control is expired" is also true of a run that
// enumerated no controls, and a sweep that visits nothing must fail rather than pass. See assertPopulation.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contentDigest, parseRecord, RECORD_REL_PATH, scoreRecord } from "./verdict-record.mjs";

const CONSOLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Exit codes, named so a caller cannot transpose two of them. */
export const CLEAN = 0;
export const FINDING = 1;
export const COULD_NOT_CHECK = 2;

/**
 * The catalogue this scores against: one row per catalogued control, carrying the control's key and the
 * source file that control lives in. It is in a sibling repo, which is why it is looked up rather than
 * assumed, and why its absence is a refusal rather than an empty list.
 */
const CATALOGUE_REL = join("internal-docs", "FUNCTIONAL-CATALOGUE", "action-catalogue.jsonl");

/** Walks up from `start` looking for a workspace root that holds `marker`. */
function findWorkspace(start, marker) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, marker))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** A refusal carrying its own reason, so no caller has to invent one. */
class CouldNotCheck extends Error {}

// stderr is PIPED rather than inherited so that a git failure becomes part of the refusal this tool prints,
// instead of a raw `fatal:` line appearing above an otherwise tidy report and belonging to nothing.
function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: CONSOLE_ROOT, encoding: "buffer", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });
}

/** git's own words about a failure, which are the only useful part of an execFileSync error. */
function gitWhy(err) {
  const stderr = err?.stderr?.toString("utf8").trim();
  return stderr !== undefined && stderr !== "" ? stderr : err instanceof Error ? err.message.trim() : String(err);
}

/**
 * Reads the catalogue's (key, file) pairs.
 *
 * A torn or unparseable line is counted rather than skipped in silence: a catalogue that half-parses would
 * shrink the population, and a smaller population is the direction that manufactures a clean result.
 */
export function readCatalogue(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new CouldNotCheck(`the action catalogue at ${path} cannot be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rows = [];
  let torn = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line);
      if (typeof r?.key === "string" && typeof r?.file === "string") rows.push({ key: r.key, file: r.file });
      else torn++;
    } catch {
      torn++;
    }
  }
  if (torn > 0) throw new CouldNotCheck(`${torn} line(s) of ${path} do not carry a key and a file, so the catalogued population is not known`);
  return rows;
}

/**
 * A digest reader for the working tree: sha256 of the file's bytes, or null when the file is not there.
 *
 * null means ABSENT and nothing else. Any other failure to read is a refusal, because a read error that
 * returned null would silently convert a control into an expired one and this tool would then report it as
 * the commit's doing.
 */
export function workingTreeDigests(root) {
  const cache = new Map();
  return (file) => {
    if (cache.has(file)) return cache.get(file);
    const p = join(root, file);
    /** @type {string | null} */
    let d = null;
    if (existsSync(p)) {
      try {
        d = contentDigest(readFileSync(p));
      } catch (err) {
        throw new CouldNotCheck(`${file} is in the working tree but cannot be read: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    cache.set(file, d);
    return d;
  };
}

/**
 * A digest reader for a commit's tree.
 *
 * It lists the whole tree ONCE and then reads blobs by object id, rather than running `git show <rev>:<file>`
 * per file. That is not only faster: `git show` fails identically for "this path is not in that commit" and
 * for "that revision does not exist", and collapsing those two would let a typo in a revision report every
 * control as expired. Here a revision that cannot be listed is a refusal, and a path missing from a tree
 * that listed fine is an honest null.
 */
export function commitDigests(rev) {
  let listing;
  try {
    listing = git(["ls-tree", "-r", "-z", "--format=%(objectname) %(path)", rev]).toString("utf8");
  } catch (err) {
    throw new CouldNotCheck(`the tree of ${rev} cannot be listed, so nothing can be scored against it: ${gitWhy(err)}`);
  }
  const oidOf = new Map();
  for (const entry of listing.split("\0")) {
    if (entry === "") continue;
    const sp = entry.indexOf(" ");
    if (sp === -1) continue;
    oidOf.set(entry.slice(sp + 1), entry.slice(0, sp));
  }
  if (oidOf.size === 0) throw new CouldNotCheck(`the tree of ${rev} listed ZERO paths, so a clean result from it would be a statement about nothing`);
  const cache = new Map();
  return (file) => {
    if (cache.has(file)) return cache.get(file);
    const oid = oidOf.get(file);
    /** @type {string | null} */
    let d = null;
    if (oid !== undefined) {
      try {
        d = contentDigest(git(["cat-file", "blob", oid]));
      } catch (err) {
        throw new CouldNotCheck(`blob ${oid} for ${file} at ${rev} cannot be read: ${gitWhy(err)}`);
      }
    }
    cache.set(file, d);
    return d;
  };
}

/** The verdict record as it stands at a commit. The record moves too, so scoring a parent needs the parent's. */
export function recordAtCommit(rev) {
  let text;
  try {
    text = git(["show", `${rev}:${RECORD_REL_PATH}`]).toString("utf8");
  } catch (err) {
    throw new CouldNotCheck(`${RECORD_REL_PATH} cannot be read at ${rev}: ${gitWhy(err)}`);
  }
  return text;
}

/** The verdict record as it stands in the working tree. */
export function recordInTree(root) {
  const p = join(root, RECORD_REL_PATH);
  if (!existsSync(p)) throw new CouldNotCheck(`${RECORD_REL_PATH} is not in the working tree, so no verdict can be scored`);
  return readFileSync(p, "utf8");
}

/**
 * ASSERT THE POPULATION before any verdict is handed back.
 *
 * "No control is expired" is also true of a run that enumerated zero controls, and every silent-zero this
 * campaign has found looked exactly like a pass. Three separate populations can collapse independently, so
 * all three are checked: the catalogue can be missing or empty, the record can hold no verdicts, and the
 * two can name disjoint sets of keys, which is the one a size check on either alone would miss.
 *
 * @param {{ catalogueRows: {key:string,file:string}[], record: {verdicts: {key:string}[]}, scored: {passing:unknown[],failing:unknown[],expiredPassing:unknown[],expiredFailing:unknown[]} }} args
 */
export function assertPopulation({ catalogueRows, record, scored }) {
  if (catalogueRows.length === 0) throw new CouldNotCheck("the action catalogue holds ZERO rows, so there is no catalogued control to expire");
  if (record.verdicts.length === 0) throw new CouldNotCheck("the verdict record holds ZERO verdicts, so it can neither prove nor disprove anything about a control");
  const catKeys = new Set(catalogueRows.map((r) => r.key));
  let named = 0;
  for (const e of record.verdicts) if (catKeys.has(e.key)) named++;
  if (named === 0) {
    throw new CouldNotCheck(
      `the verdict record names ${record.verdicts.length} verdict(s) and NOT ONE of them is a key in the ${catalogueRows.length}-row catalogue, so the two describe different populations and a clean result would be a statement about nothing`,
    );
  }
  const reached = scored.passing.length + scored.failing.length + scored.expiredPassing.length + scored.expiredFailing.length;
  if (reached === 0) throw new CouldNotCheck(`scoring reached ZERO controls out of ${catalogueRows.length} catalogued, so nothing was checked`);
  return { catalogued: catalogueRows.length, recordNamesCatalogued: named, reached };
}

/**
 * Scores one tree: which catalogued controls carry a standing verdict, and which have expired.
 *
 * @param {{ recordText: string, catalogueRows: {key:string,file:string}[], digestOf: (f:string)=>string|null }} args
 */
export function scoreTree({ recordText, catalogueRows, digestOf }) {
  const parsed = parseRecord(recordText);
  if (!parsed.ok) throw new CouldNotCheck(`${RECORD_REL_PATH} cannot be scored because ${parsed.why}`);
  const scored = scoreRecord({ record: parsed.record, catalogueRows, treeDigest: digestOf });
  const population = assertPopulation({ catalogueRows, record: parsed.record, scored });
  const expired = new Map();
  for (const e of scored.expiredPassing) expired.set(e.key, { ...e, was: "passing" });
  for (const e of scored.expiredFailing) expired.set(e.key, { ...e, was: "failing" });
  const standing = new Set([...scored.passing, ...scored.failing].map((e) => e.key));
  return { scored, population, expired, standing, driven: scored.driven };
}

/**
 * WHAT A CHANGE EXPIRED, as a set difference over standing verdicts.
 *
 * `expired` is deliberately the controls that STOOD at `before` and do not at `after`, not the controls
 * that appear in after's expired list. Those differ, and the difference is the whole attribution question:
 * a control that was already expired before this change is somebody else's debt and naming it here would
 * charge this commit for it. `resolved` is the same difference the other way, so a commit that pays the
 * debt reads as paying it rather than as doing nothing.
 */
export function attribute(before, after) {
  const expired = [];
  for (const [key, e] of after.expired) if (before.standing.has(key)) expired.push(e);
  const resolved = [];
  for (const [key] of before.expired) if (after.standing.has(key)) resolved.push({ key });
  expired.sort((a, b) => a.key.localeCompare(b.key));
  resolved.sort((a, b) => a.key.localeCompare(b.key));
  return { expired, resolved };
}

/** Groups controls by the source file they live in, which is the file the person actually edited. */
function groupByFile(controls, fileOf) {
  const byFile = new Map();
  for (const c of controls) {
    const f = fileOf.get(c.key) ?? "(not in the catalogue)";
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(c.key);
  }
  return [...byFile.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

/**
 * THE REMEDY, in one command.
 *
 * `ledger/*.jsonl` is gitignored in the harness, so a run driven from a LINKED WORKTREE banks nothing a
 * later reader can find: the nine minutes run, and nothing is left to show for them. The primary checkout
 * is not a preference here, it is the only place the run counts.
 */
function printRemedy(out) {
  out("");
  out("  TO PAY IT, about nine minutes, no estate driven and no deploy:");
  out("    1. cd <workspace>/harness && npm run test:static-tier");
  out("       IN THE PRIMARY CHECKOUT, not a linked worktree: harness ledger/*.jsonl is gitignored, so a");
  out("       run driven from a worktree banks nothing and the nine minutes buy nothing.");
  out("    2. cd <workspace>/console && npm run verdicts:write");
  out("       then commit manifest/control-grain-verdicts.json.");
  out("  To see the figure either side: npm run census in harness.");
}

/** Renders a result and returns its exit code. */
function report({ subject, expired, resolved, fileOf, population, driven, out, gate }) {
  out("");
  if (expired.length === 0) {
    const paid = resolved.length > 0 ? `, and it RESOLVED ${resolved.length} that had expired` : "";
    out(`[coverage-currency] CLEAN: ${subject} expires no catalogued control${paid}.`);
    out(`  Checked ${population.reached} of ${population.catalogued} catalogued controls; ${driven} carry a standing passing verdict.`);
    out("");
    return CLEAN;
  }
  out(`[coverage-currency] FINDING: ${subject} expires ${expired.length} catalogued control(s).`);
  out(`  Checked ${population.reached} of ${population.catalogued} catalogued controls; ${driven} still carry a standing passing verdict.`);
  out("");
  out("  Nothing here says a control is BROKEN. Each of these had a verdict banked against the exact bytes");
  out("  of its own source file, and that file has moved, so the proof no longer describes the code.");
  out("");
  for (const [file, keys] of groupByFile(expired, fileOf)) {
    out(`  ${file}  (${keys.length})`);
    for (const k of keys) out(`      ${k}`);
  }
  const failingWas = expired.filter((e) => e.was === "failing");
  if (failingWas.length > 0) {
    out("");
    out(`  ${failingWas.length} of these last graded as a FAILURE rather than a pass, so they are an unanswered`);
    out("  failure as well as a re-drive owed, and re-driving them may not come back clean.");
  }
  if (resolved.length > 0) out(`\n  It also RESOLVED ${resolved.length} control(s) that had expired.`);
  printRemedy(out);
  if (!gate) {
    out("  This is a REPORT and it has not blocked anything. Why it does not block is argued in hooks/pre-push.");
  }
  out("");
  return FINDING;
}

// ---- self-test ---------------------------------------------------------------------------------------
//
// A PLANTED SYNTHETIC POSITIVE, because a detector that has never been seen to fire is indistinguishable
// from one that cannot: a grep over a directory that does not exist also returns nothing and reads exactly
// like a clean result. Every case below carries its own green control, so a plant that fires for the wrong
// reason is caught by the inert version of the same input failing to fire.

function synthetic() {
  const catalogueRows = [
    { key: "alpha.button.one#1", file: "src/a.ts" },
    { key: "alpha.button.two#1", file: "src/a.ts" },
    { key: "beta.button.one#1", file: "src/b.ts" },
  ];
  const digests = { "src/a.ts": "a".repeat(64), "src/b.ts": "b".repeat(64) };
  const record = {
    schema: "downpipes/control-grain-verdicts@1",
    counts: {},
    verdicts: catalogueRows.map((r, i) => ({ key: r.key, console_sha: "0".repeat(40), ts: `2026-08-12T00:0${i}:00.000Z`, verdict: "CLEAN", seq: i, file: r.file, file_sha256: digests[r.file] })),
  };
  return { catalogueRows, digests, record };
}

function selfTest(out) {
  const cases = [];
  const run = (name, fn) => {
    try {
      fn();
      cases.push({ name, ok: true });
    } catch (err) {
      cases.push({ name, ok: false, why: err instanceof Error ? err.message : String(err) });
    }
  };
  const must = (cond, why) => {
    if (!cond) throw new Error(why);
  };
  const { catalogueRows, digests, record } = synthetic();
  const text = JSON.stringify(record);
  const scoreWith = (d) => scoreTree({ recordText: text, catalogueRows, digestOf: (f) => d[f] ?? null });

  run("GREEN CONTROL: an unmoved tree expires nothing", () => {
    const s = scoreWith(digests);
    must(s.expired.size === 0, `expected no expiry, got ${[...s.expired.keys()].join(", ")}`);
    must(s.driven === 3, `expected 3 driven, got ${s.driven}`);
  });

  run("PLANT: moving one file expires exactly the controls in it", () => {
    const before = scoreWith(digests);
    const after = scoreWith({ ...digests, "src/a.ts": "c".repeat(64) });
    const { expired } = attribute(before, after);
    must(expired.length === 2, `expected 2 expired, got ${expired.length}`);
    must(expired.map((e) => e.key).join(",") === "alpha.button.one#1,alpha.button.two#1", `named the wrong controls: ${expired.map((e) => e.key).join(",")}`);
    // The inert half of the same plant: the file that did NOT move must not be named.
    must(!expired.some((e) => e.key.startsWith("beta.")), "a control whose file did not move was reported as expired");
  });

  run("PLANT: a DELETED file expires its controls too", () => {
    const before = scoreWith(digests);
    const after = scoreWith({ "src/b.ts": digests["src/b.ts"] });
    const { expired } = attribute(before, after);
    must(expired.length === 2, `expected 2 expired for a deleted file, got ${expired.length}`);
  });

  run("ATTRIBUTION: debt that was already expired is not charged to this change", () => {
    const moved = { ...digests, "src/a.ts": "c".repeat(64) };
    const before = scoreWith(moved);
    const after = scoreWith({ ...moved, "src/b.ts": "d".repeat(64) });
    const { expired } = attribute(before, after);
    must(expired.length === 1 && expired[0].key === "beta.button.one#1", `charged the wrong controls: ${expired.map((e) => e.key).join(",")}`);
  });

  run("ATTRIBUTION: a change that re-banks reads as RESOLVED, not as clean-and-silent", () => {
    const before = scoreWith({ ...digests, "src/a.ts": "c".repeat(64) });
    const { expired, resolved } = attribute(before, scoreWith(digests));
    must(expired.length === 0, "a re-bank was reported as an expiry");
    must(resolved.length === 2, `expected 2 resolved, got ${resolved.length}`);
  });

  run("POPULATION: an EMPTY catalogue refuses rather than passing", () => {
    /** @type {unknown} */
    let threw = null;
    try {
      scoreTree({ recordText: text, catalogueRows: [], digestOf: (f) => digests[f] ?? null });
    } catch (err) {
      threw = err;
    }
    must(threw instanceof CouldNotCheck, "an empty catalogue did not refuse, so a sweep over nothing would have passed");
  });

  run("POPULATION: a record naming NO catalogued key refuses rather than passing", () => {
    const disjoint = JSON.stringify({ ...record, verdicts: record.verdicts.map((v) => ({ ...v, key: `unrelated.${v.key}` })) });
    /** @type {unknown} */
    let threw = null;
    try {
      scoreTree({ recordText: disjoint, catalogueRows, digestOf: (f) => digests[f] ?? null });
    } catch (err) {
      threw = err;
    }
    must(threw instanceof CouldNotCheck, "a record disjoint from the catalogue did not refuse, and every control would have read as never graded");
  });

  run("POPULATION: a record with ZERO verdicts refuses rather than passing", () => {
    /** @type {unknown} */
    let threw = null;
    try {
      scoreTree({ recordText: JSON.stringify({ ...record, verdicts: [] }), catalogueRows, digestOf: (f) => digests[f] ?? null });
    } catch (err) {
      threw = err;
    }
    must(threw instanceof CouldNotCheck, "an empty record did not refuse");
  });

  run("REFUSAL OUTRANKS A PASS: an unreadable revision refuses rather than reporting every control expired", () => {
    /** @type {unknown} */
    let threw = null;
    try {
      commitDigests("coverage-currency-no-such-revision-0000000");
    } catch (err) {
      threw = err;
    }
    must(threw instanceof CouldNotCheck, "a revision that does not exist did not refuse");
  });

  run("GREEN CONTROL for the refusal: a revision that DOES exist lists a tree", () => {
    const d = commitDigests("HEAD");
    must(typeof d("package.json") === "string", "HEAD's package.json did not digest, so the refusal above proves nothing");
  });

  const failed = cases.filter((c) => !c.ok);
  out("");
  for (const c of cases) out(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : `\n         ${c.why}`}`);
  out("");
  if (failed.length > 0) {
    out(`[coverage-currency] SELF-TEST FAILED: ${failed.length} of ${cases.length}. The detector is not known to fire, so no result from it means anything.`);
    out("");
    return COULD_NOT_CHECK;
  }
  out(`[coverage-currency] SELF-TEST OK: ${cases.length} cases, every plant fired and every green control stayed quiet.`);
  out("");
  return CLEAN;
}

// ---- entry point -------------------------------------------------------------------------------------

function usage(out) {
  out(`
coverage-currency-expiry.mjs -- which catalogued controls a change expires.

  --self-test              plant a synthetic expiry and prove the detector fires. Run this first.
  --commit <rev>           what that single commit expired, against its own parent.
  --range <a>..<b>         what the commits in that range expired, net.
  --push <remote> <local>  the range form the pre-push hook uses.
  (no argument)            what the WORKING TREE has expired, against origin/main.
  --gate                   report the LEVEL of expiry in the working tree, not a delta.

Exit: 0 clean, 1 finding, 2 could-not-check. Could-not-check outranks a pass.
`);
}

function main(argv, out) {
  if (argv.includes("--help") || argv.includes("-h")) {
    usage(out);
    return CLEAN;
  }
  if (argv.includes("--self-test")) return selfTest(out);

  const ws = findWorkspace(CONSOLE_ROOT, CATALOGUE_REL);
  if (ws === null) {
    throw new CouldNotCheck(`no workspace holding ${CATALOGUE_REL} was found above ${CONSOLE_ROOT}, so the catalogued population is unknown. Check internal-docs out beside this repo.`);
  }
  const catalogueRows = readCatalogue(join(ws, CATALOGUE_REL));
  const fileOf = new Map(catalogueRows.map((r) => [r.key, r.file]));
  const gate = argv.includes("--gate");

  const at = (rev) => scoreTree({ recordText: recordAtCommit(rev), catalogueRows, digestOf: commitDigests(rev) });
  const tree = () => scoreTree({ recordText: recordInTree(CONSOLE_ROOT), catalogueRows, digestOf: workingTreeDigests(CONSOLE_ROOT) });

  const argAfter = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 || i + 1 >= argv.length ? null : argv[i + 1];
  };

  if (gate) {
    const now = tree();
    const expired = [...now.expired.values()].sort((a, b) => a.key.localeCompare(b.key));
    return report({ subject: "the working tree", expired, resolved: [], fileOf, population: now.population, driven: now.driven, out, gate: true });
  }

  const commit = argAfter("--commit");
  if (commit !== null) {
    let parent;
    try {
      parent = git(["rev-parse", "--verify", `${commit}^`]).toString("utf8").trim();
    } catch {
      throw new CouldNotCheck(`${commit} has no single parent to compare against, so what it expired cannot be attributed to it`);
    }
    const { expired, resolved } = attribute(at(parent), at(commit));
    const sha = git(["rev-parse", "--short", commit]).toString("utf8").trim();
    return report({ subject: `commit ${sha}`, expired, resolved, fileOf, population: at(commit).population, driven: at(commit).driven, out, gate });
  }

  const range = argAfter("--range");
  const push = argv.indexOf("--push");
  /** @type {string | null} */
  let a = null;
  /** @type {string | null} */
  let b = null;
  if (range !== null) {
    const parts = range.split("..");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") throw new CouldNotCheck(`${JSON.stringify(range)} is not a <a>..<b> range`);
    [a, b] = parts;
  } else if (push !== -1) {
    a = argv[push + 1] ?? "";
    b = argv[push + 2] ?? "";
    if (b === "") throw new CouldNotCheck("--push needs a remote sha and a local sha");
    // A brand new branch arrives with an all-zero remote sha. Its merge base with main is the honest
    // baseline; without one there is nothing to attribute against and the level is reported instead.
    // (a and b were both just assigned strings above; the null checks here are for the type checker,
    // which cannot see across the `a = null` reassignment inside the catch below to know they still hold.)
    if (a !== null && b !== null && /^0{40}$/.test(a)) {
      try {
        a = git(["merge-base", b, "origin/main"]).toString("utf8").trim();
      } catch {
        a = null;
      }
    }
  }

  if (a !== null && b !== null) {
    const after = at(b);
    const { expired, resolved } = attribute(at(a), after);
    return report({ subject: `${git(["rev-parse", "--short", a]).toString("utf8").trim()}..${git(["rev-parse", "--short", b]).toString("utf8").trim()}`, expired, resolved, fileOf, population: after.population, driven: after.driven, out, gate });
  }

  // Default: the working tree against origin/main, which is what a person is about to add to.
  const after = tree();
  /** @type {string | null} */
  let base = null;
  try {
    base = git(["rev-parse", "--verify", "origin/main"]).toString("utf8").trim();
  } catch {
    base = null;
  }
  if (base === null) {
    const expired = [...after.expired.values()].sort((x, y) => x.key.localeCompare(y.key));
    return report({ subject: "the working tree (no origin/main to compare against, so this is the LEVEL)", expired, resolved: [], fileOf, population: after.population, driven: after.driven, out, gate });
  }
  const { expired, resolved } = attribute(at(base), after);
  return report({ subject: "the working tree, against origin/main", expired, resolved, fileOf, population: after.population, driven: after.driven, out, gate });
}

// Run only when this file IS the command. Its scoring and attribution functions are exported so a test can
// drive them directly, and a module that ran a git-backed sweep merely because it was imported would make
// that impossible.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = (s) => console.log(s);
  try {
    process.exit(main(process.argv.slice(2), out));
  } catch (err) {
    if (err instanceof CouldNotCheck) {
      console.error(`\n[coverage-currency] COULD NOT CHECK: ${err.message}`);
      console.error("  This is exit 2 and NOT a pass. Nothing was established about any control.\n");
      process.exit(COULD_NOT_CHECK);
    }
    throw err;
  }
}
