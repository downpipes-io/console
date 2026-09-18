#!/usr/bin/env node
// Every recovered per-run master in the browser must be zeroed in place once it has been used.
//
// WHY THIS EXISTS. The same defect recurs across independent components: a recovered master is acquired
// and left live because a wipe is missing on some exit path -- a throw path, a reader held open for a
// whole process, or here, restore-flow/attend.ts recovering a per-run master for every archive in an
// attended session and leaving each one live in the tab's memory until it is closed.
//
// What makes it worth a gate rather than a fix is that the sibling file already gets it right.
// restore-flow/break-glass.ts has an explicit wipeMaster() with a comment saying exactly why. Same
// directory, same author intent, and nothing but a gate would say so if one path missed it.
//
// WHAT THIS CHECKS. Every `openCapsule(` call that binds its result must have a `.fill(0)` on that binding
// somewhere in the same file. That is deliberately shallow: it cannot prove the wipe happens on every path,
// and it does not try to. It pins the thing that actually went wrong, which was no wipe at all.
//
// READ BY PARSE, NOT BY REGEX. A regex over the raw file text cannot tell a real `.fill(0)` call from the
// same text sitting inside a COMMENT: line-commenting the only wipe would still satisfy a presence regex
// while leaving the per-run master live in the tab for the whole attended session. A gate that a comment
// can satisfy is not a gate. Comments and string literals are not nodes in a TypeScript AST, so parsing
// answers that and the mirror-image question (a commented-out `openCapsule(` call inventing a phantom
// site) at once. typescript is already a console devDependency and scripts/field-census.mjs and
// scripts/hook-lib.mjs both take this route, so this is the house pattern rather than a new one.
//
// WHAT IT CANNOT COVER, stated rather than left implied. The base64 the engine is sent is a JavaScript
// string, and strings are immutable, so that copy cannot be wiped by anything. A gate that implied
// otherwise would be worse than none.
//
// Run `node scripts/key-material-wipe-gate.mjs --self-test` for the extractor's own teeth: the comment and
// string-literal shapes above are asserted NOT to count, and a genuine wipe is asserted to still count. The
// silent branches of a scanner never fire on healthy source, which is exactly the state a broken rule hides
// in.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { isEntryModule } from "./entry-module.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SRC = join(ROOT, "src");

let failures = 0;
const ok = (label, cond) => {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Every node of one source file, parents set, in no particular order. Pure. */
function nodesOf(rel, text) {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TS);
  const out = [];
  const visit = (n) => {
    out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { sf, nodes: out };
}

/**
 * The bindings a file assigns from openCapsule, with the 1-based line of each call.
 *
 * BOTH forms are matched, because a declaration-only check would miss an assignment to an existing
 * variable, `derived = await openCapsule(`, which is what break-glass.ts does. An openCapsule call that
 * binds nothing is not a site. Pure.
 */
export function recoveriesIn(rel, text) {
  const { sf, nodes } = nodesOf(rel, text);
  const out = [];
  for (const n of nodes) {
    if (!ts.isCallExpression(n)) continue;
    if (!ts.isIdentifier(n.expression) || n.expression.text !== "openCapsule") continue;
    const held = ts.isAwaitExpression(n.parent) ? n.parent : n;
    const p = held.parent;
    /** @type {string | null} */
    let name = null;
    if (p !== undefined && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) name = p.name.text;
    else if (
      p !== undefined &&
      ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(p.left)
    ) name = p.left.text;
    if (name === null) continue;
    out.push({ name, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
  }
  return out;
}

/**
 * The identifiers a file zeroes with a bare `<name>.fill(0)`.
 *
 * The receiver must be an IDENTIFIER, so a property-access receiver such as `other.master.fill(0)` is
 * correctly not read as a wipe of `master`. The argument must be the numeric literal 0. Pure.
 */
export function filledIdentifiersIn(rel, text) {
  const { nodes } = nodesOf(rel, text);
  const out = new Set();
  for (const n of nodes) {
    if (!ts.isCallExpression(n)) continue;
    const callee = n.expression;
    if (!ts.isPropertyAccessExpression(callee)) continue;
    if (callee.name.text !== "fill") continue;
    if (!ts.isIdentifier(callee.expression)) continue;
    const [arg] = n.arguments;
    if (arg === undefined || !ts.isNumericLiteral(arg) || arg.text !== "0") continue;
    out.add(callee.expression.text);
  }
  return out;
}

/** True when the file contains any `<expr>.fill(0)` call at all, whatever the receiver. Pure. */
export function hasAnyFillZero(rel, text) {
  const { nodes } = nodesOf(rel, text);
  for (const n of nodes) {
    if (!ts.isCallExpression(n)) continue;
    if (!ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== "fill") continue;
    const [arg] = n.arguments;
    if (arg !== undefined && ts.isNumericLiteral(arg) && arg.text === "0") return true;
  }
  return false;
}

/**
 * `to -> from` for every one-hop alias of a plain identifier: `x = y` and `const x = y`. break-glass.ts
 * recovers into `derived`, hands it to `master`, and its wipeMaster() fills `master`. Pure.
 */
export function aliasHopsIn(rel, text) {
  const { nodes } = nodesOf(rel, text);
  const out = [];
  for (const n of nodes) {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isIdentifier(n.left) && ts.isIdentifier(n.right)) out.push({ to: n.left.text, from: n.right.text });
      continue;
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined && ts.isIdentifier(n.initializer)) {
      out.push({ to: n.name.text, from: n.initializer.text });
    }
  }
  return out;
}

/**
 * The recovered bindings of one file that are never zeroed: wiped directly, or aliased into exactly one
 * other binding that is wiped directly. NO LENIENT FALLBACK: a looser rule that credits "the name appears
 * in an assignment somewhere later AND this file contains any .fill(0)" is satisfied trivially, and would
 * still pass with the real wipe deleted. Pure.
 */
export function unwipedIn(rel, text) {
  const filled = filledIdentifiersIn(rel, text);
  const hops = aliasHopsIn(rel, text);
  const out = [];
  for (const { name } of recoveriesIn(rel, text)) {
    let wiped = filled.has(name);
    if (!wiped) wiped = hops.some((h) => h.from === name && filled.has(h.to));
    if (!wiped) out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Self-test: the extractor fed the exact constructs that fooled the regex it replaced.
// ---------------------------------------------------------------------------------------------------------
function selfTest() {
  let held = 0;
  let broke = 0;
  const expect = (label, got, want) => {
    const pass = JSON.stringify(got) === JSON.stringify(want);
    if (pass) held++;
    else {
      broke++;
      console.log(`FAIL  ${label}  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`);
    }
    if (pass) console.log(`PASS  ${label}`);
  };

  const real = 'const master = await openCapsule(a, b, c);\nuse(master);\nmaster.fill(0);\n';
  expect("a genuine recovery is a site", recoveriesIn("t.ts", real).map((r) => r.name), ["master"]);
  expect("and its bare wipe counts", [...filledIdentifiersIn("t.ts", real)], ["master"]);
  expect("so a genuine wipe leaves nothing unwiped", unwipedIn("t.ts", real), []);

  // Line-commenting the only wipe must NOT satisfy this gate, because a regex over raw file text cannot
  // tell code from prose. Both comment forms are checked, since a block comment is a shape a text-based
  // check can be fooled by just as easily as a line comment.
  const lineCommented = 'const master = await openCapsule(a, b, c);\nuse(master);\n// master.fill(0);\n';
  expect("a line-commented wipe does not count", [...filledIdentifiersIn("t.ts", lineCommented)], []);
  expect("so the recovery is reported unwiped", unwipedIn("t.ts", lineCommented), ["master"]);
  const blockCommented = 'const master = await openCapsule(a, b, c);\n/* the fix is master.fill(0) here */\n';
  expect("a wipe named inside a block comment does not count", unwipedIn("t.ts", blockCommented), ["master"]);

  // And the string-literal half. Help text and error copy naming the remedy must not satisfy the gate.
  const inString = 'const master = await openCapsule(a, b, c);\nlog("call master.fill(0) when done");\n';
  expect("a wipe named inside a string literal does not count", unwipedIn("t.ts", inString), ["master"]);

  // The mirror-image question: prose must not INVENT a site either, or the gate cries wolf and gets muted.
  const prose = '// const master = await openCapsule(cap, id, kc);\nconst other = 1;\n';
  expect("a recovery named in a comment is not a site", recoveriesIn("t.ts", prose), []);
  const proseString = 'const help = "const master = await openCapsule(x)";\n';
  expect("a recovery named in a string is not a site", recoveriesIn("t.ts", proseString), []);

  // Kept from the regex it replaces: a qualified receiver is not a wipe of the bare name.
  const qualified = 'const master = await openCapsule(a, b, c);\nother.master.fill(0);\n';
  expect("a qualified receiver is not a wipe of the bare name", unwipedIn("t.ts", qualified), ["master"]);

  // Kept: the alias hop break-glass.ts uses, and the assignment form of the recovery.
  const hopped = 'let derived;\nderived = await openCapsule(a, b, c);\nmaster = derived;\nmaster.fill(0);\n';
  expect("an assignment-form recovery is a site", recoveriesIn("t.ts", hopped).map((r) => r.name), ["derived"]);
  expect("and a one-hop alias wipe counts", unwipedIn("t.ts", hopped), []);

  // hasAnyFillZero backs the two named-file assertions, so it needs the same teeth.
  expect("hasAnyFillZero ignores a commented wipe", hasAnyFillZero("t.ts", "// x.fill(0)\n"), false);
  expect("hasAnyFillZero sees a real one", hasAnyFillZero("t.ts", "x.fill(0);\n"), true);

  console.log(`\nself-test: ${held} of ${held + broke} assertions held.`);
  return broke === 0 ? 0 : 1;
}

// ENTRY-ONLY. A bare `process.argv.includes("--self-test")` check would also fire if another script ever
// imports this module and runs with that flag itself: the self-test would exit 0 on its own assertions at
// import time, and the importer's own checks would never run. isEntryModule guards against exactly that,
// shared from scripts/entry-module.mjs rather than reimplemented here, since a hand-rolled copy is easy to
// get wrong (a missing realpath check silently breaks through a symlink).
if (isEntryModule(import.meta.url) && process.argv.includes("--self-test")) process.exit(selfTest());

console.log("\n-- every recovered per-run master is zeroed in place --\n");

const files = walk(SRC).sort();
ok(`the console source is readable (${files.length} files)`, files.length > 50);

let sites = 0;
const unwiped = [];
for (const f of files) {
  const rel = relative(ROOT, f).replace(/\\/g, "/");
  const text = readFileSync(f, "utf8");
  sites += recoveriesIn(rel, text).length;
  for (const name of unwipedIn(rel, text)) unwiped.push(`${rel} (${name})`);
}

// A gate that matched nothing would report clean for ever.
ok(`the extractor found capsule-recovery sites (${sites} found)`, sites >= 2);
ok("every recovered per-run master is zeroed in place", unwiped.length === 0);
if (unwiped.length > 0) {
  for (const u of unwiped) console.log(`       not wiped: ${u}`);
  console.log("       Add `<name>.fill(0)` once the master has been used, as restore-flow/break-glass.ts does.");
}

// The two flows this was written for, pinned by name so a reader can tell WHICH gap it came from. The rule
// above would catch a regression in either, but naming them records why the gate exists at all.
for (const rel of ["src/screens/restore-flow/attend.ts", "src/screens/restore-flow/break-glass.ts"]) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  ok(`${rel.split("/").pop()} wipes the master it recovers`, hasAnyFillZero(rel, text));
}

console.log(`\n${failures === 0 ? "KEY-MATERIAL-WIPE PASS" : `KEY-MATERIAL-WIPE: ${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
