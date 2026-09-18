// Field census (the denominator for the console field-audit catalogue).
//
// Walks console/src/**/*.ts through the TypeScript AST and emits one row per
// user-input control. This is the ground truth the catalogue reconciles against:
// a control that exists in the census but not the catalogue is an uncatalogued
// field, and the gate (npm run validate:field-catalogue) fails on it. That is the
// "impossible to miss a single element" mechanism -- the list of fields is DERIVED
// from source, never hand-maintained, so a new field added anywhere shows up here
// the moment it is written.
//
// Why the AST and not grep: the console builds 100% of its DOM through two typed
// factories, h() (lib/dom.ts) and field() (components/field.ts). There are zero raw
// HTML input strings and no innerHTML over inputs. So every control is one of a small,
// closed set of call shapes, and the compiler's own parser enumerates them without the
// false positives/negatives a regex would hit inside strings, comments or template
// literals.
//
// The closed set of control-producing call shapes (see FIELD-AUDIT 02-COMPLETENESS-METHOD):
//   1. field({ ... })                                     the labelled input/textarea/select factory
//   2. h("input"|"select"|"textarea", { ... })            raw controls field() does not cover
//   3. h("button", { role:"radio"|"switch" | aria-pressed })  ARIA-widget radios/toggles (NOT <input>)
//   4. checkboxRow(id, label, hint?)                      the one checkbox wrapper helper
// Any NEW control-wrapping helper must be added to HELPER_CALLS below AND its definition
// caught by the helper-definition scan, or the gate will not see the controls it emits.
//
// Usage:
//   node scripts/field-census.mjs                 # derive and print the summary, writing NOTHING
//   node scripts/field-census.mjs --json          # also print JSONL to stdout
//   node scripts/field-census.mjs --out <path>    # write the census where you say
//   node scripts/field-census.mjs --write-internal-docs   # refresh the committed census in internal-docs
// Run with cwd = console/ so "typescript" resolves from console/node_modules.
//
// FS-WRITES: <workspace>/internal-docs/FIELD-CATALOGUE/field-census.jsonl
// FS-WRITES-RUN: --write-internal-docs

import ts from "typescript";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findWorkspaceDir } from "./workspace-root.mjs";
import { announceOutsideWrites, announceOutsideWritesHeld, outsideWriteRequested } from "./outside-write.mjs";

const CONSOLE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(CONSOLE_ROOT, "src");

// WHERE THE CANONICAL CENSUS LIVES, resolved rather than assumed.
//
// join(CONSOLE_ROOT, "..", "internal-docs", "FIELD-CATALOGUE") would assert that the console checkout's
// parent IS the workspace root, which is true of the primary checkout and false of every worktree, and the
// failure would be silent in the worst possible way for a WRITER: mkdirSync runs with { recursive: true },
// so a wrong parent is not an error, it is a brand-new internal-docs tree manufactured wherever the guess
// lands. In a console worktree with a stale internal-docs beside it, that assumption lets the script exit 0
// having overwritten a decoy while the real committed census never moves, with the operator told "Wrote ..."
// and believing the artefact was refreshed. In a checkout with no sibling at all, it would exit 0 having
// created an internal-docs tree from nothing, so a census that invents its own destination can never report
// that it has none. The census is the denominator field-catalogue-gate.mjs and field-bounds-gate.mjs grade
// against, so a census written to the wrong tree is how a stale citation gets created rather than merely
// missed.
//
// Resolution is LAZY, deliberately: it happens at the write, not at import. `field:gate` passes
// --out node_modules/.cache/field-census.jsonl and wants a fresh census WITHOUT touching internal-docs,
// so demanding the sibling up front would break the one caller that correctly does not need it.
const MARKER = join("internal-docs", "FIELD-CATALOGUE", "catalogue.jsonl");
function canonicalOutPath() {
  const workspace = findWorkspaceDir(CONSOLE_ROOT, MARKER);
  if (workspace === null) {
    console.error(`\n[field-census] FATAL: could not resolve the workspace root from ${CONSOLE_ROOT}.`);
    console.error(`  Tried the direct parent and the owner of any .worktrees segment; none carries ${MARKER}`);
    console.error("  outside a .worktrees directory, which is refused however it is reached.");
    console.error("  Check internal-docs out beside this repo, or set DOWNPIPES_WORKSPACE=/path/to/workspace-root.");
    console.error("  Pass --out <path> to write a census somewhere that is not the shared catalogue.");
    console.error("  Refusing to write, because mkdirSync would otherwise CREATE an internal-docs tree at the");
    console.error("  guessed path and report success against an artefact nothing reads.\n");
    process.exit(2);
  }
  return join(workspace, MARKER, "..", "field-census.jsonl");
}

// The same destination, for a run that is only NAMING it. This one never exits: a read-only run in a
// console-only checkout has nothing to refuse, and telling that caller "FATAL" over a write it did not
// ask for would be the old bug with the sign flipped.
function canonicalOutPathForReport() {
  const workspace = findWorkspaceDir(CONSOLE_ROOT, MARKER);
  return workspace === null
    ? "<workspace-root>/internal-docs/FIELD-CATALOGUE/field-census.jsonl  (workspace root unresolved from here)"
    : join(workspace, MARKER, "..", "field-census.jsonl");
}

// Files whose control primitives are factory internals, not user field declarations.
const FACTORY_FILES = new Set(["src/components/field.ts"]);
// Positional control-wrapping helpers: identifier -> arg indices for (id, label, hint).
const HELPER_CALLS = { checkboxRow: { id: 0, label: 1, hint: 2 } };

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

// staticText pulls a compile-time-known string / boolean out of an initializer, or null
// if the value is computed at runtime (so the census can flag dynamic labels/ids for a
// human to name rather than silently recording an empty cell).
function staticText(v) {
  if (!v) return null;
  if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) return v.text;
  if (v.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (v.kind === ts.SyntaxKind.FalseKeyword) return "false";
  return null; // dynamic (identifier, template with substitutions, call, ternary, ...)
}

// objProps reads an object literal into { key -> { present, text } }, noting a spread
// (…rest) so a partially-dynamic attrs object is never mistaken for a fully-known one.
function objProps(objNode) {
  const map = Object.create(null);
  let hasSpread = false;
  for (const p of objNode.properties) {
    if (ts.isSpreadAssignment(p)) { hasSpread = true; continue; }
    const nameNode = p.name;
    /** @type {string | null} */
    let key = null;
    if (nameNode) {
      if (ts.isIdentifier(nameNode)) key = nameNode.text;
      else if (ts.isStringLiteral(nameNode) || ts.isNoSubstitutionTemplateLiteral(nameNode)) key = nameNode.text;
      else if (ts.isComputedPropertyName(nameNode)) key = "[computed]";
    }
    if (!key) continue;
    if (ts.isPropertyAssignment(p)) map[key] = { present: true, text: staticText(p.initializer) };
    else map[key] = { present: true, text: null }; // shorthand: dynamic value
  }
  return { map, hasSpread };
}

function enclosingFn(node) {
  let n = node.parent;
  while (n) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
      const par = n.parent;
      if (par && ts.isVariableDeclaration(par) && ts.isIdentifier(par.name)) return par.name.text;
      if (par && ts.isPropertyAssignment(par) && par.name && ts.isIdentifier(par.name)) return par.name.text;
    }
    n = n.parent;
  }
  return null;
}

function inLoop(node) {
  let n = node.parent;
  while (n) {
    if (ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n)) return true;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const m = n.expression.name.text;
      if (m === "map" || m === "forEach" || m === "flatMap") return true;
    }
    n = n.parent;
  }
  return false;
}

const rows = [];
const helperDefs = new Set(); // functions that internally build a control primitive

for (const abs of walk(SRC, [])) {
  const rel = relative(CONSOLE_ROOT, abs).split("\\").join("/");
  const text = readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TS);

  const at = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const push = (row, node) => {
    const line = at(node);
    // Stable discriminator: the static id, else a static label/name, else the control kind. The line
    // is deliberately NOT part of the key (assigned in the post-pass below), so a key survives edits
    // that only shift line numbers -- the catalogue joins on it across code changes.
    const disc = row.id && row.id !== "[dynamic]" ? row.id
      : row.label && row.label !== "[dynamic]" ? row.label
      : row.name || row.control;
    rows.push({
      _base: `${rel}::${disc}`,
      file: rel, line, fn: enclosingFn(node),
      loopGenerated: inLoop(node),
      ...row,
    });
  };

  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      const args = node.arguments;
      const a0 = args[0];

      if (callee === "field") {
        if (a0 && ts.isObjectLiteralExpression(a0)) {
          const { map, hasSpread } = objProps(a0);
          const kind = map.kind?.text ?? "input";
          const type = kind === "input" ? (map.type?.text ?? "text") : kind;
          // Pull the doc link's href/anchor out of the nested `doc: { href, anchor }` object so the
          // catalogue can record which page each field points at (objProps only flags doc's presence).
          let docHref = null, docAnchor = null;
          if (map.doc) {
            const dp = a0.properties.find((p) => ts.isPropertyAssignment(p) && p.name && ts.isIdentifier(p.name) && p.name.text === "doc");
            // The find() predicate narrows p, not its RESULT, so dp reads as ObjectLiteralElementLike here. The cast is
            // comment-only; the isPropertyAssignment test above is what makes .initializer real.
            if (dp && ts.isObjectLiteralExpression(/** @type {any} */ (dp).initializer)) {
              const dm = objProps(/** @type {any} */ (dp).initializer).map;
              docHref = dm.href?.text ?? null;
              docAnchor = dm.anchor?.text ?? null;
            }
          }
          push({
            mechanism: "field", control: kind, type,
            id: map.id?.text ?? (map.id ? "[dynamic]" : null),
            label: map.label?.text ?? (map.label ? "[dynamic]" : null),
            hasPlaceholder: !!map.placeholder, hasHint: !!map.hint,
            hasDoc: !!map.doc, hasValidate: !!map.validate,
            docHref, docAnchor,
            required: map.required?.text === "true",
            hasSpread, argDynamic: false,
          }, node);
        } else {
          push({ mechanism: "field", control: "?", type: "?", id: null, label: null,
            hasPlaceholder: false, hasHint: false, hasDoc: false, hasValidate: false,
            required: false, hasSpread: false, argDynamic: true }, node);
        }
      } else if (callee === "h" && a0 && ts.isStringLiteral(a0)) {
        const tag = a0.text;
        const a1 = args[1];
        const { map: attrs, hasSpread } = a1 && ts.isObjectLiteralExpression(a1) ? objProps(a1) : { map: {}, hasSpread: false };
        if ((tag === "input" || tag === "select" || tag === "textarea") && !FACTORY_FILES.has(rel)) {
          const type = tag === "input" ? (attrs.type?.text ?? "text") : tag;
          push({
            mechanism: `raw-${tag}`, control: type, type,
            id: attrs.id?.text ?? null,
            label: attrs["aria-label"]?.text ?? null,
            name: attrs.name?.text ?? null,
            hasPlaceholder: !!attrs.placeholder, hasHint: false, hasDoc: false,
            hasValidate: false, required: !!attrs.required, hasSpread, argDynamic: false,
          }, node);
        } else if (tag === "button" && a1 && ts.isObjectLiteralExpression(a1)) {
          const role = attrs.role?.text;
          const isWidget = role === "radio" || role === "switch" || "aria-pressed" in attrs || "aria-checked" in attrs;
          if (isWidget) {
            push({
              mechanism: "aria-widget",
              control: role ?? ("aria-pressed" in attrs ? "toggle" : "switch"),
              type: role ?? "toggle",
              id: attrs.id?.text ?? null,
              label: attrs["aria-label"]?.text ?? null,
              hasPlaceholder: false, hasHint: false, hasDoc: false,
              hasValidate: false, required: false, hasSpread, argDynamic: false,
            }, node);
          }
        }
      } else if (HELPER_CALLS[callee]) {
        const spec = HELPER_CALLS[callee];
        const idArg = args[spec.id], labelArg = args[spec.label];
        push({
          mechanism: `helper-${callee}`, control: "checkbox", type: "checkbox",
          id: idArg && ts.isStringLiteral(idArg) ? idArg.text : (idArg ? "[dynamic]" : null),
          label: labelArg && ts.isStringLiteral(labelArg) ? labelArg.text : (labelArg ? "[dynamic]" : null),
          hasPlaceholder: false, hasHint: args.length > spec.hint, hasDoc: false,
          hasValidate: false, required: false, hasSpread: false, argDynamic: false,
        }, node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Helper-definition scan: any exported function whose name looks like a control wrapper
  // (…Row / …Field / …Block / render… / build…) and whose body builds a control primitive.
  // Surfaced so a NEW wrapper cannot smuggle in uncatalogued controls unnoticed.
  const scanDefs = (node) => {
    /** @type {string | null} */
    let name = null;
    /** @type {import("typescript").Block | import("typescript").ConciseBody | null | undefined} */
    let body = null;
    if (ts.isFunctionDeclaration(node) && node.name) { name = node.name.text; body = node.body; }
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      name = node.name.text; body = node.initializer.body;
    }
    if (name && body && /(?:Row|Field|Block)$|^(?:render|build)/.test(name)) {
      const bodyText = body.getText(sf);
      if (/\bfield\(|\bh\("(?:input|select|textarea)"|\bh\("button"/.test(bodyText)) helperDefs.add(`${rel}::${name}`);
    }
    ts.forEachChild(node, scanDefs);
  };
  scanDefs(sf);
}

// Assign stable, line-free keys. A base shared by one control becomes the key as-is; a base shared by
// several controls in one file (two id-less radios, say) gets a #n suffix in document order. This is
// what lets the catalogue survive edits that only move lines, and it is why the key never carries @line.
const groups = new Map();
for (const r of rows) { const g = groups.get(r._base); if (g) g.push(r); else groups.set(r._base, [r]); }
for (const group of groups.values()) {
  if (group.length === 1) group[0].key = group[0]._base;
  else group.sort((a, b) => a.line - b.line).forEach((r, i) => { r.key = `${r._base}#${i + 1}`; });
}
for (const r of rows) delete r._base;

// ---- output -----------------------------------------------------------------
// --out redirects the census away from its canonical home in internal-docs. It exists because this script
// is run two different ways with two different intents. `field:census` regenerates the committed artefact
// deliberately, and must write there. `field:gate` only needs a FRESH census to grade against, and it is
// mandated before every console commit, so writing to the canonical location on every such run would dirty
// a SHARED repo on main with derived data describing whatever branch happened to be checked out.
//
// THE DEFAULT IS READ-ONLY, and --write-internal-docs is what asks for the canonical write. A bare run of
// this script that only wants to inspect the census output (to confirm a control appears in it, say) must
// not write into the shared internal-docs repo as a side effect: doing so risks overwriting another
// checkout's in-progress work with derived data from whatever branch happened to be checked out here.
//
// Nothing depends on the side effect firing by default. Console CI reaches this script only through
// `field:gate`, which passes --out; internal-docs CI grades the committed bytes and never runs this. So the
// canonical write has exactly one caller who wants it, and every other caller only pays for it if it
// defaults on.
const outArg = process.argv.indexOf("--out");
const explicitOut = outArg !== -1 && process.argv[outArg + 1] ? process.argv[outArg + 1] : null;
const wantsCanonical = explicitOut === null && outsideWriteRequested();
const outPath = explicitOut ?? (wantsCanonical ? canonicalOutPath() : null);
if (outPath !== null) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

const by = (fn) => {
  const m = {};
  for (const r of rows) m[fn(r)] = (m[fn(r)] ?? 0) + 1;
  return m;
};
const count = (pred) => rows.filter(pred).length;
const fieldRows = rows.filter((r) => r.mechanism === "field");
const typeable = (r) => // controls where a placeholder example is meaningful (not select/checkbox/radio/toggle/password/file)
  ["input", "text", "email", "url", "number", "search", "tel", "textarea"].includes(r.control);

if (process.argv.includes("--json")) console.log(rows.map((r) => JSON.stringify(r)).join("\n"));

console.log(`\n[field-census] ${rows.length} control call sites across ${new Set(rows.map((r) => r.file)).size} files\n`);
console.log("By mechanism:");
for (const [k, v] of Object.entries(by((r) => r.mechanism)).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log("\nBy control type:");
for (const [k, v] of Object.entries(by((r) => r.control)).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log("\nCoverage gaps (the burndown):");
console.log(`  field() controls:                 ${fieldRows.length}`);
console.log(`  field() typeable, NO placeholder:  ${count((r) => r.mechanism === "field" && typeable(r) && !r.hasPlaceholder)}`);
console.log(`  field() with NO hint:              ${count((r) => r.mechanism === "field" && !r.hasHint)}`);
console.log(`  ALL controls with NO doc link:     ${count((r) => !r.hasDoc)}   (doc: is not yet a field option -> every control, expected)`);
console.log(`  loop-generated (1 site -> N shown): ${count((r) => r.loopGenerated)}`);
console.log(`  DYNAMIC id/label (needs a human):  ${count((r) => r.id === "[dynamic]" || r.label === "[dynamic]" || r.argDynamic)}`);
console.log(`  attrs carry a spread (inspect):    ${count((r) => r.hasSpread)}`);
console.log(`\nControl-wrapping helper definitions found (${helperDefs.size}) -- each must be represented in the catalogue or its call sites enumerated:`);
for (const d of [...helperDefs].sort()) console.log(`  ${d}`);
if (outPath === null) {
  announceOutsideWritesHeld("[field-census]", [canonicalOutPathForReport()]);
} else if (wantsCanonical) {
  announceOutsideWrites("[field-census]", findWorkspaceDir(CONSOLE_ROOT, MARKER), [outPath]);
} else {
  console.log(`\nWrote ${outPath}`);
}
