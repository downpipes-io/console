#!/usr/bin/env node
// harness-pin-gate: every literal data-dp hook the harness pins itself to must still resolve
// against this console's current source.
//
// WHY THIS EXISTS. Nothing forces a console change that moves a pinned selector, id, hook or copy string
// to update the harness fixture that pins it, so the landing that moves it silently reddens the instrument
// days later, and whoever runs it next spends their own judgement deciding whether the product broke or
// the fixture did. Every `[data-dp="..."]` CSS attribute selector is a plain string sitting in the
// harness's own source tree, so this needs no browser to catch, only someone to grep for it. This gate is
// that grep, running on every console push, at the moment the pin is moved rather than days later.
//
// WHERE THIS RUNS AND WHY NOT DOCS. This console's own `workspace` CI job (Cross-repo gates) already
// checks out engine, internal-docs, harness (as `harness`), docs and control-plane on every push,
// specifically so `functional-catalogue-gate.mjs` can read the harness corpus for the DRIVEN_FLOOR ratchet.
// The harness's own CI equally checks out console (`capture-selector-provenance-gate.mjs`, wired into
// `npm run validate` there) and runs on every harness push. Neither is uniquely privileged; each fires on
// the repo whose landing introduces the risk. This mechanism's risk is introduced by a CONSOLE change (a
// rename, a suffix shift), so it belongs in CONSOLE's cross-repo job, where it catches the pin the moment
// it moves rather than waiting for the next harness push, days later.
//
// WHAT THIS DOES NOT COVER, NAMED RATHER THAN LEFT IMPLICIT. `data-dp` hooks are one of several pin
// classes (route, selector, element id, hook, copy string). This gate is the hook class only, because it
// is the one class this codebase already has a proven, low-noise, purely mechanical pattern for
// (`capture-selector-provenance-gate.mjs`'s own battery-list method, generalised here from a curated list
// to the harness's full corpus). Two other classes are NOT safely gateable the same way, so they are left
// alone rather than force-fit:
//   - Raw CSS id selectors (`'#foo-bar'`). 185 distinct references exist across the harness corpus; a naive
//     census-based check flags 60 of them, but the true figure is far lower and the check is genuinely
//     noisy: it cannot see ids the console builds from a template literal, and it flags harness fixtures
//     that are not console selectors at all (`lib/test/sanitise.test.ts`'s "email"/"submit"/"password"
//     sanitiser-test payloads happen to also be quoted `#`-prefixed strings). The right treatment for this
//     whole class is to re-pin to a semantic relationship, such as a tab's own `aria-controls`, rather than
//     a guessed id -- a CONTRACT, not a policed value this gate would have to guess a noise floor for.
//   - User-visible copy strings and routes. The durable fix (deriving stub shapes, and by extension copy,
//     from a typed contract) is real engineering effort, for good reason: recognising which of a harness
//     file's many string literals is a COPY PIN versus incidental text needs real judgement a text scan
//     cannot supply without a much higher false-positive rate than this gate accepts for the hook class
//     below.
// Both remain open. This gate closes the class it can close cleanly; it does not claim the other two.
//
// THE METHOD. This reads bytes, the same discipline `capture-selector-provenance-gate.mjs` and
// `docs/scripts/source-pointer-lint.mjs` both use and both justify at length in their own headers: a
// structural parse can be defeated by hiding a pin inside a construct the parser does not model, and a
// harness corpus this large is not worth auditing for every such construct. It does NOT import a shared
// list to police (there is no curated list here, unlike screenshot-capture.ts's four batteries) -- it reads
// every `[data-dp(operator)?="value"]` attribute selector literally present in the harness's spec/ and
// lib/ trees, so a NEW pin needs no entry anywhere to be checked, exactly `field-census.mjs`'s reasoning
// for deriving rather than hand-maintaining.
//
// THE RESIDUE. This gate would be RED on arrival for a small number of confirmed pins that are missing
// the `#n` suffix a sibling control now requires, plus a lower-risk fallback pin (see KNOWN_RESIDUE
// below), because their fix lives on harness branches not yet landed here.
// The precedent this follows ("measure how red the gate would be on arrival before enforcing it, because
// landing a red gate is worse than landing none") is why those entries are named explicitly and excluded,
// with a hygiene check that fails the moment any of them either (a) stops being referenced by the harness
// corpus at all, or (b) starts resolving again -- both mean the entry is dead weight and must be deleted
// from this list, not left to quietly widen what the gate accepts. The residue can only shrink.
//
// WHICH HARNESS TREE WAS READ, and why this one SAYS SO rather than refusing.
//
// A harness checkout that is behind its own origin/main can still make this gate exit 0, having checked a
// smaller, stale population of pins and files, with nothing in the output distinguishing that run from one
// against a current tree. Same verdict, different population.
//
// It reports rather than refuses, and the argument is specific to what its red hands a reader. Every
// finding here is a NAMED PIN at a NAMED file:line in the sibling, so a reader opens that file at that line
// and sees exactly what the gate saw. There is something in the red to audit, and the lag line beside it
// says how old it is. A refusal would also be the wrong instrument in a second way: harness is the
// checkout this workspace leaves furthest behind, and work in this repo cannot advance it, so a gate that
// exits non-zero on harness lag alone would be switched off on its first run and stay off. That is the
// gate-everybody-learns-to-ignore failure, and it costs more than the frozen tree does.
//
// The population line is part of the repair rather than decoration: a file count that moves between two
// trees is the visible trace of the pins this run could not have seen.
//
// Usage:
//   node scripts/harness-pin-gate.mjs
//   DOWNPIPES_HARNESS=/path/to/harness node scripts/harness-pin-gate.mjs
//
// Exit codes: 0 every pin resolves or is named residue and the residue list is itself clean; 1 a pin that
// is not on the residue list fails to resolve (new drift), or a residue entry is stale (needs deleting); 2
// could not check (no harness sibling, or either corpus read too small to judge against).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { staleness, treeLine } from "./sibling-staleness.mjs";
import { findWorkspaceDir } from "./workspace-root.mjs";

const TAG = "[harness-pin-gate]";
const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = resolve(HERE, "..");
const CONSOLE_SRC = join(CONSOLE_ROOT, "src");

function resolveHarness() {
  const override = process.env.DOWNPIPES_HARNESS;
  if (override !== undefined && override.trim() !== "") return resolve(override.trim());
  // findWorkspaceDir already tries the direct parent first (the layout the Cross-repo CI job checkout
  // above produces: harness lands beside console), then the .worktrees-owning layouts, all behind the
  // same .worktrees refusal and marker check every other cross-repo gate in this file tree uses.
  // No further guess belongs here: a hand-rolled fallback cannot tell this checkout's sibling from a
  // stranger's, which is exactly what sibling-resolution-gate.mjs polices.
  const workspace = findWorkspaceDir(CONSOLE_ROOT, "harness/package.json");
  return workspace !== null ? join(workspace, "harness") : null;
}

const HARNESS = resolveHarness();
if (HARNESS === null || !existsSync(HARNESS)) {
  console.error(`::error::${TAG} no harness checkout found (looked beside ${CONSOLE_ROOT} and via DOWNPIPES_WORKSPACE/DOWNPIPES_HARNESS).`);
  console.error(`::error::${TAG} This gate FAILS rather than skips when it cannot check. Check out the harness repo as 'harness' beside this repo, or set DOWNPIPES_HARNESS.`);
  process.exit(2);
}

// Printed before anything is counted, so it is present on a pass, on new drift, and on a corpus-too-small
// refusal alike. Unknown is its own state and is never rendered as 0, because 0 is what a current checkout
// looks like.
console.log(treeLine(TAG, "harness", HARNESS, staleness(HARNESS)));

/** Every .ts/.tsx file under dir, walked once, .worktrees and node_modules excluded. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === ".worktrees") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

// --- Console's own data-dp census: every literal "data-dp": "value" in src/, mechanical text scan. ---
// A value containing "${" is a runtime-computed hook (rare, e.g. a loop-generated row) and is excluded:
// this gate checks literal pins against literal values, not against a template it cannot evaluate.
const consoleFiles = existsSync(CONSOLE_SRC) ? walk(CONSOLE_SRC) : [];
if (consoleFiles.length < 50) {
  console.error(`::error::${TAG} read ${consoleFiles.length} console source file(s) under ${CONSOLE_SRC}, too few to judge against.`);
  process.exit(2);
}
const CONSOLE_HOOKS = new Set();
const HOOK_DEF_RE = /"data-dp":\s*"([^"]*)"/g;
for (const f of consoleFiles) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(HOOK_DEF_RE)) {
    if (!m[1].includes("${")) CONSOLE_HOOKS.add(m[1]);
  }
}
if (CONSOLE_HOOKS.size < 200) {
  console.error(`::error::${TAG} derived only ${CONSOLE_HOOKS.size} literal data-dp value(s) from the console, too few to judge against (measured 475 on 2026-08-03).`);
  process.exit(2);
}

// --- Harness references: every [data-dp(op)?="value"] in spec/ and lib/, comments skipped. ---
const harnessRoots = ["spec", "lib"].map((d) => join(HARNESS, d)).filter(existsSync);
const harnessFiles = harnessRoots.flatMap((d) => walk(d));
if (harnessFiles.length < 50) {
  console.error(`::error::${TAG} read ${harnessFiles.length} harness file(s) under spec/ and lib/ of ${HARNESS}, too few to judge against.`);
  process.exit(2);
}
// THE `[` MUST BE UNESCAPED, AND THAT IS NOT A DETAIL. Without the lookbehind this pattern also matches
// the SOURCE OF A REGEX LITERAL that parses data-dp selectors, because a regex writes the same characters
// with the bracket escaped -- a line such as `const m = /\[data-dp="([^"]+)"\]/.exec(t.sel)` would
// otherwise be read as a pin and reported as one the console no longer carries. It is a phantom: there is
// nothing to re-pin, no harness change can fix it, and reporting it sends the reader looking for a console
// rename that never happened. A gate that fails on a construct it misreads teaches people to route around
// it, which is the one thing it cannot afford.
//
// A CSS attribute selector never escapes its opening bracket, so refusing the escaped form cannot hide a
// real pin, and the corpus floor below is the check on that: the live corpus sits well above the floor, so
// losing this one phantom class of match is nowhere near it.
const REF_RE = /(?<!\\)\[data-dp([\^$*]?)=["']([^"']+)["']\]/g;
// key: `${op}\u0000${value}` -> sites.
//
// THE SEPARATOR IS WRITTEN AS THE ESCAPE \u0000, NEVER AS A RAW NUL BYTE. A source file carrying a raw
// NUL byte is treated as BINARY by grep: `grep -c "const" scripts/harness-pin-gate.mjs` would print
// nothing and exit 1. Not an error, not a warning, a silent clean from the first tool any audit reaches
// for, on a gate that adjudicates whether other work lands -- and a real false negative for any sweep of
// this repo that greps for findWorkspaceDir, which this file calls three times.
const refs = new Map();
for (const f of harnessFiles) {
  const text = readFileSync(f, "utf8");
  const lines = text.split("\n");
  for (const m of text.matchAll(REF_RE)) {
    const lineNo = text.slice(0, m.index).split("\n").length;
    const lineText = lines[lineNo - 1].trim();
    // "//", "/*", "/**" (an opening block-comment line) and "*"/"* " (a block-comment continuation line)
    // are all comment prose, illustrating a pattern rather than pinning one. A pin that ONLY ever appears
    // in a comment cannot make a cell fail, so it is not this gate's business.
    if (lineText.startsWith("//") || lineText.startsWith("/*") || lineText.startsWith("*")) continue;
    const [, op, value] = m;
    if (value.includes("${")) continue; // built at runtime; not statically resolvable, and honestly out of scope
    const opName = op === "^" ? "prefix" : op === "$" ? "suffix" : op === "*" ? "substr" : "exact";
    const key = `${opName}\u0000${value}`;
    if (!refs.has(key)) refs.set(key, { op: opName, value, sites: [] });
    refs.get(key).sites.push(`${relative(HARNESS, f)}:${lineNo}`);
  }
}
const totalSites = [...refs.values()].reduce((a, r) => a + r.sites.length, 0);
if (refs.size < 300 || totalSites < 700) {
  console.error(`::error::${TAG} found ${refs.size} distinct data-dp reference(s) across ${totalSites} site(s), below the floor (measured 425 distinct / 860 sites on 2026-08-03, comments excluded).`);
  console.error(`::error::${TAG} A parse or extraction regression would look like this: fewer pins checked, not more, so a shrink here is refused rather than read as a quieter corpus.`);
  process.exit(2);
}

function matches(op, value, hookSet) {
  if (op === "exact") return hookSet.has(value);
  for (const cv of hookSet) {
    if (op === "prefix" && cv.startsWith(value)) return true;
    if (op === "suffix" && cv.endsWith(value)) return true;
    if (op === "substr" && cv.includes(value)) return true;
  }
  return false;
}
function resolves({ op, value }) {
  return matches(op, value, CONSOLE_HOOKS);
}

// Self-test: proves the resolution logic can both pass and fail, in both directions, before it grades
// anything real. Run first (`--self-test`), exits 2 on any failure, and drives every branch the residue
// and hygiene checks below also use: `capture-selector-provenance-gate.mjs`'s own header names the same
// discipline ("a gate that cannot go red is not a gate").
function selfTest() {
  const hooks = new Set(["restore-flow.button.cancel#1", "restore-flow.button.cancel#2", "sources.button.create"]);
  const cases = [
    ["exact", "sources.button.create", true],
    ["exact", "restore-flow.button.cancel", false], // real bug this gate exists to catch: no #n suffix
    ["prefix", "restore-flow.button.cancel", true],
    ["prefix", "restore-flow.button.retire", false],
    ["suffix", "cancel#1", true],
    ["suffix", "cancel#9", false],
    ["substr", "button", true],
    ["substr", "nonexistent", false],
  ];
  const failed = cases.filter(([op, value, want]) => matches(op, value, hooks) !== want);
  if (failed.length > 0) {
    console.error(`::error::${TAG} self-test FAILED: ${failed.map(([op, v, want]) => `${op} ${JSON.stringify(v)} expected ${want}`).join("; ")}`);
    process.exit(2);
  }
  // Residue hygiene, exercised directly rather than only via the real tree: an entry that now resolves
  // must be flagged, and one that has vanished from the corpus must be flagged too.
  const fakeResidue = [{ op: "exact", value: "sources.button.create" }, { op: "exact", value: "gone.button.nowhere" }];
  const fakeRefs = new Map([["exact sources.button.create", { op: "exact", value: "sources.button.create", sites: ["x:1"] }]]);
  const hyg = [];
  for (const entry of fakeResidue) {
    const found = fakeRefs.get(`${entry.op} ${entry.value}`);
    if (found === undefined) hyg.push("missing");
    else if (matches(found.op, found.value, hooks)) hyg.push("resolves");
  }
  if (hyg.length !== 2 || hyg[0] !== "resolves" || hyg[1] !== "missing") {
    console.error(`::error::${TAG} self-test FAILED: residue hygiene did not catch both a resolved-now entry and a vanished entry (got ${JSON.stringify(hyg)}).`);
    process.exit(2);
  }
  // THE EXTRACTOR is tested separately from the resolution logic above: everything above tests `matches`,
  // which grades a pin once something has decided it IS one, but REF_RE is what decides that, and a
  // misread there (a regex literal parsed as a pin) fails a build over a selector nobody wrote.
  const extract = (text) => [...text.matchAll(new RegExp(REF_RE.source, "g"))].map((m) => m[2]);
  const extractCases = [
    ['await page.click(\'[data-dp="sources.button.create"]\');', ["sources.button.create"], "a real selector is still read"],
    ["const t = `[data-dp=\"restore-flow.button.cancel#1\"]`;", ["restore-flow.button.cancel#1"], "and so is one in a template literal"],
    ["page.locator('[data-dp^=\"sources.button.apply-\"]')", ["sources.button.apply-"], "and a prefix form"],
    ['const m = /\\[data-dp="([^"]+)"\\]/.exec(t.sel);', [], "a REGEX that parses selectors is not itself a selector"],
    ['/\\[data-dp\\^="([^"]+)"\\]/', [], "nor is the prefix-form regex"],
  ];
  const exFailed = extractCases.filter(([text, want]) => JSON.stringify(extract(text)) !== JSON.stringify(want));
  if (exFailed.length > 0) {
    console.error(`::error::${TAG} self-test FAILED: the pin extractor misread ${exFailed.map(([, , why]) => JSON.stringify(why)).join("; ")}`);
    process.exit(2);
  }
  console.log(`${TAG} self-test OK: ${cases.length} resolution case(s), ${extractCases.length} extraction case(s) and both hygiene branches behave as designed.`);
}
if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}
selfTest();

// --- The residue. Named and sourced, per this gate's own "measure how red before enforcing" rule. ---
// Each entry is a pin this gate would otherwise fail on. The fix for each already exists on a harness
// branch not yet landed here. When it lands, its entries stop resolving as MISSING here (they start
// resolving as present) and this list must shrink.
const KNOWN_RESIDUE = [
  { op: "exact", value: "restore-flow.button.approve", why: "pinned without the #n suffix (approve#1/#2 both exist); fix staged on a harness branch" },
  { op: "exact", value: "restore-flow.button.request", why: "pinned without the #n suffix (request#1/#2/request-all all exist); fix staged on a harness branch" },
  { op: "exact", value: "restore-flow.button.reject", why: "pinned without the #n suffix (reject#1/#2 both exist); fix staged on a harness branch" },
  { op: "exact", value: "restore-flow.button.finish", why: "pinned without the #n suffix (finish#1/#2 both exist); fix staged on a harness branch" },
  // A residue entry is deleted once the harness corpus either stops referencing the pin at all, or the pin
  // resolves again -- both are caught by the hygiene check below, so an entry left here past its fix
  // landing is a bug in this list, not a harmless leftover.
  { op: "substr", value: "disclosure", why: "lib/sources-byid-fanout.ts's expandDisclosures(): a best-effort .catch(()=>{}) click on a hook the console does not carry; summary/aria-expanded cover the real disclosures" },
];
const residueKey = (r) => `${r.op}\u0000${r.value}`;
const residueSet = new Set(KNOWN_RESIDUE.map(residueKey));

const newDrift = [];
const residueHit = [];
for (const r of refs.values()) {
  if (resolves(r)) continue; // fine, whether or not it happens to also be on the residue list
  if (residueSet.has(residueKey(r))) residueHit.push(r);
  else newDrift.push(r);
}

// Hygiene: every residue entry must both (a) still be referenced by the harness corpus, and (b) still fail
// to resolve. Either becoming false means the entry is dead weight, not a harmless leftover, since this
// list can only shrink.
const hygieneFail = [];
for (const entry of KNOWN_RESIDUE) {
  const found = refs.get(residueKey(entry));
  if (found === undefined) {
    hygieneFail.push(`${entry.op} ${JSON.stringify(entry.value)}: no longer referenced anywhere in the harness corpus -- delete this entry from KNOWN_RESIDUE`);
  } else if (resolves(found)) {
    hygieneFail.push(`${entry.op} ${JSON.stringify(entry.value)}: now resolves against the console -- the fix landed, delete this entry from KNOWN_RESIDUE`);
  }
}

console.log(`${TAG} ${refs.size} distinct data-dp pin(s) checked across ${totalSites} reference site(s) in ${harnessFiles.length} harness file(s), against ${CONSOLE_HOOKS.size} live console hook(s).`);
console.log(`${TAG} resolved: ${refs.size - newDrift.length - residueHit.length}   known residue: ${residueHit.length}/${KNOWN_RESIDUE.length}   new drift: ${newDrift.length}`);

if (residueHit.length > 0) {
  console.log(`${TAG} known residue (not failing this gate; see KNOWN_RESIDUE for why):`);
  for (const r of residueHit) console.log(`    ${r.op.padEnd(6)} ${JSON.stringify(r.value)}  <- ${r.sites.join(", ")}`);
}

let failed = false;
if (newDrift.length > 0) {
  failed = true;
  console.log(`${TAG} NEW DRIFT: ${newDrift.length} pin(s) the harness references no longer resolve against this console and are not named residue:`);
  for (const r of newDrift) {
    console.log(`    ${r.op.padEnd(6)} ${JSON.stringify(r.value)}  <- ${r.sites.join(", ")}`);
    console.log(`           appears nowhere in the console's data-dp hooks; the harness selector built on it now matches nothing`);
  }
  console.log(`${TAG} Fix the console rename to preserve the hook, or land the harness fixture's own re-pin in the same change. Do not add this to KNOWN_RESIDUE to make the build pass; that list is for pins whose fix already exists elsewhere and cannot land here today.`);
}
if (hygieneFail.length > 0) {
  failed = true;
  console.log(`${TAG} RESIDUE HYGIENE: ${hygieneFail.length} entr(y/ies) in KNOWN_RESIDUE are stale:`);
  for (const h of hygieneFail) console.log(`    ${h}`);
}

if (!failed) {
  console.log(`${TAG} OK: every non-residue data-dp pin the harness references still resolves, and the residue list is itself clean.`);
  process.exit(0);
}
process.exit(1);
