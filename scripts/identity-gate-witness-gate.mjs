#!/usr/bin/env node
// Every fail-closed-on-a-null-caller gate in the console must WITNESS the blind gate.
//
// WHY THIS EXISTS
// ---------------
// A role-NAME gate can hide a restore the engine would actually allow. The screen-level panel guards
// against this (screens/restore-flow/confirm.ts, test/validate-api-flows-restore.ts), and so do the
// screen-owned palette commands one layer up (test/validate-screen-action-gates.ts). The residue is a
// layer BELOW both: the console's two primary gates, canDo and canCap in screens/common.ts, fail closed on
// a null caller in SILENCE, and so does the palette's requireCap in shell/registry.ts.
//
// The silence is not a documentation problem. It has two live consequences.
//
//   1. NO EVIDENCE. lib/client-diag/identity-gate.ts emits one identity-stale-gate row per screen whose gates
//      were computed before the identity report arrived, and noteGateComputedBlind() is its only writer. If a
//      primary gate stays silent, no row can name the affected screen -- the restore screen, overview,
//      sources, downpipes -- so a raced Owner and a genuine viewer can generate byte-identical support packs
//      on exactly the screens where the confusion costs most. That silence is what the identity-stale-gate
//      row exists to end.
//   2. NO RECOVERY. app.ts reads currentScreenGatedBlind() to set forceForBlindGate, which is what re-renders
//      the on-screen screen when the resolved caller's render key is unchanged (a same-identity re-resolve
//      during which a late async gate ran blind). A gate that does not witness cannot raise that flag, so a
//      late blind gate on that screen stays stuck rather than self-correcting.
//
// The witness mechanism can end up wired into screen-LOCAL predicate duplicates (security-centre,
// credentials, notifications, the role builder) while the originals they copy stay silent -- a mirror gets
// the fix and the thing it mirrors does not. This gate polices every derived call site so that pattern
// cannot recur unnoticed.
//
// WHAT IT ASSERTS, AND WHY IT NEEDS NO MAINTAINED LIST
// ---------------------------------------------------
// Both sides are DERIVED from source by AST, never transcribed. A hand-written list of witness sites is the
// defect this gate exists to prevent: a hand-written list can claim a site is covered when it is not, which
// is exactly the failure a derived population cannot have.
//
//   the population  every function whose body reads the caller (a `caller()` call, or a `.caller` property on
//                   a context object) AND has a null-or-falsy guard on that value whose taken branch returns.
//   the requirement each such function must call noteGateComputedBlind() in that branch.
//
// TWO EXEMPTIONS, both derived from the function itself rather than named:
//
//   COPY, not authority. A function whose declared return type is exactly `string` produces disabled-with-reason
//   copy (gateReason, capGateReason, retireGateReason). It describes a gate and decides nothing, so a blind read
//   there cannot hide an affordance. Note that these functions are still REQUIRED to have their null branch: it
//   is what makes the banner say "the engine has not yet reported your role" instead of naming a wrong role.
//
//   ALREADY OBSERVABLE. A function whose null branch returns the literal "identity-unresolved" has recorded the
//   fact by another route: that value is a member of the client-diag vocabulary and reaches the ring
//   (screens/owner-actions.ts refusalCode, recorded by recordOwnerActionRefusal). Witnessing twice would
//   double-count one fault, which is the reasoning identity-gate.ts already applies to a whoami that throws.
//
// FAILING HONESTLY. It fails when it cannot run (no src tree, no TypeScript, no files parsed) and when there is
// nothing to check (the derived population, or the required subset, below the floors measured on the source
// this landed against). A gate that quietly finds nothing and prints a pass is the failure mode the console
// keeps paying for.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SRC = join(ROOT, "src");

const failures = [];
const fail = (msg, ...detail) => {
  failures.push(msg);
  console.error(`  FAIL ${msg}`);
  for (const d of detail) if (d) console.error(`       ${d}`);
};

// ---- cannot-run cases, each a failure and never a skip -------------------------------------------------
if (!existsSync(SRC)) {
  console.error("IDENTITY-GATE WITNESS GATE: FAIL, there is no src/ tree to read, so nothing was checked.");
  process.exit(1);
}

let ts;
try {
  ts = (await import("typescript")).default;
} catch (err) {
  console.error("IDENTITY-GATE WITNESS GATE: FAIL, TypeScript could not be loaded, so the AST cannot be walked.");
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  console.error("  This FAILS rather than falling back to a regex. A text scan reads the WORD noteGateComputedBlind");
  console.error("  inside a comment as a call, and every gate helper here is documented in a comment that names it.");
  process.exit(1);
}

// ---- the floors ---------------------------------------------------------------------------------------
// Measured on the source this gate landed against: 484 source files, 15 functions in the population, 8 of them
// required to witness (canDo, canCap, requireCap, three callerCanCap copies, callerRole, creatorCapabilities)
// and 7 exempt (six copy helpers and refusalCode).
// An ADDITION on any axis raises the count and still passes. A DROP fails here, and correcting it has to be a
// deliberate edit to these lines, which is the point: it is how a refactor that dissolves the population gets
// noticed instead of reading as a clean pass.
const MIN_FILES = 400;
const MIN_POPULATION = 15;
const MIN_REQUIRED = 8;

// The two primary gates, pinned BY NAME on top of the floors. The floors alone cannot see a rename: canDo and
// canCap being replaced by two differently named predicates would keep the count at 7 and pass. These two
// decide nearly every gate in the console, so their presence in the DERIVED population is asserted, not
// assumed.
const PRIMARY_GATES = [
  ["src/screens/common.ts", "canDo"],
  ["src/screens/common.ts", "canCap"],
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = walk(SRC);
if (files.length === 0) {
  console.error("IDENTITY-GATE WITNESS GATE: FAIL, src/ holds no TypeScript files, so nothing was checked.");
  process.exit(1);
}

// ---- the derivation ----------------------------------------------------------------------------------
const population = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const rel = relative(ROOT, file);

  const examine = (fn, name) => {
    if (!fn.body) return;

    // Which local names hold the caller. A `const c = caller()` binding, plus any `<expr>.caller` property
    // read (the palette's gate closes over a CommandContext rather than calling caller() itself).
    const callerRefs = new Set();
    let witnesses = false;

    const collect = (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "noteGateComputedBlind") {
        witnesses = true;
      }
      if (
        ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
        ts.isCallExpression(n.initializer) && ts.isIdentifier(n.initializer.expression) &&
        n.initializer.expression.text === "caller" && n.initializer.arguments.length === 0
      ) {
        callerRefs.add(n.name.text);
      }
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name) && n.name.text === "caller") {
        callerRefs.add(n.getText(sf));
      }
      ts.forEachChild(n, collect);
    };
    collect(fn.body);
    if (callerRefs.size === 0) return;

    const isCallerRef = (e) => callerRefs.has(e.getText(sf));
    const NULLISH = new Set(["null", "undefined"]);
    const testsCallerNullish = (e) => {
      if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) return isCallerRef(e.operand);
      if (ts.isBinaryExpression(e)) {
        const k = e.operatorToken.kind;
        const isEquality =
          k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.EqualsEqualsToken ||
          k === ts.SyntaxKind.ExclamationEqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsToken;
        if (!isEquality) return false;
        if (isCallerRef(e.left) && NULLISH.has(e.right.getText(sf))) return true;
        if (isCallerRef(e.right) && NULLISH.has(e.left.getText(sf))) return true;
      }
      return false;
    };

    // The fail-closed branch, and what it returns. The returned text is read so the
    // already-observable exemption can be derived rather than named.
    let guard = null;
    let nullBranchReturns = "";
    const findGuard = (n) => {
      if (ts.isIfStatement(n) && testsCallerNullish(n.expression)) {
        const returns = [];
        const gather = (x) => {
          if (ts.isReturnStatement(x)) returns.push(x.expression ? x.expression.getText(sf) : "");
          ts.forEachChild(x, gather);
        };
        gather(n.thenStatement);
        if (returns.length > 0) {
          guard = guard ?? "if-return";
          if (nullBranchReturns === "") nullBranchReturns = returns.join(" ");
        }
      }
      if (
        ts.isBinaryExpression(n) &&
        (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
        testsCallerNullish(n.left)
      ) {
        guard = guard ?? "logical";
      }
      if (ts.isConditionalExpression(n) && testsCallerNullish(n.condition)) guard = guard ?? "ternary";
      ts.forEachChild(n, findGuard);
    };
    findGuard(fn.body);
    if (guard === null) return;

    const returnType = fn.type ? fn.type.getText(sf) : "(inferred)";
    const exemptCopy = returnType === "string";
    const exemptObservable = /"identity-unresolved"|'identity-unresolved'/.test(nullBranchReturns);

    population.push({
      rel,
      line: sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1,
      name,
      returnType,
      guard,
      witnesses,
      exempt: exemptCopy ? "copy" : exemptObservable ? "already-observable" : null,
    });
  };

  const top = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name) examine(n, n.name.text);
    else if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (d.initializer && ts.isIdentifier(d.name) && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          examine(d.initializer, d.name.text);
        }
      }
    }
    ts.forEachChild(n, top);
  };
  top(sf);
}

const required = population.filter((f) => f.exempt === null);
const exempt = population.filter((f) => f.exempt !== null);

console.log(`IDENTITY-GATE WITNESS GATE: ${files.length} source files, ${population.length} caller-gate(s) derived`);
console.log(`  ${required.length} must witness, ${exempt.length} exempt (${exempt.filter((f) => f.exempt === "copy").length} copy, ${exempt.filter((f) => f.exempt === "already-observable").length} already observable)`);

// ---- nothing-to-check cases --------------------------------------------------------------------------
if (files.length < MIN_FILES) {
  fail(`only ${files.length} source file(s) were read, below the ${MIN_FILES} this tree carries.`,
    "A partial walk would let the checks below pass by never reaching the gates.");
}
if (population.length < MIN_POPULATION) {
  fail(`the derived population is ${population.length} function(s), below the floor of ${MIN_POPULATION}.`,
    "Either the AST patterns stopped matching the source, or the gates were dissolved.",
    "Both make every check below vacuous, so this is a failure and not a pass.");
}
if (required.length < MIN_REQUIRED) {
  fail(`only ${required.length} gate(s) are required to witness, below the floor of ${MIN_REQUIRED}.`,
    "The exemptions may have widened to swallow real gates, which would pass while checking nothing.");
}
for (const [relPath, name] of PRIMARY_GATES) {
  if (!required.some((f) => f.rel === relPath && f.name === name)) {
    fail(`${relPath} ${name}() is not in the derived set of gates that must witness.`,
      "It is one of the two predicates nearly every gate in the console resolves through.",
      "If it was renamed, rename it here too; if it stopped guarding a null caller, that is the finding.");
  }
}

// ---- the invariant -----------------------------------------------------------------------------------
for (const f of required) {
  if (!f.witnesses) {
    fail(`${f.rel}:${f.line} ${f.name}() fails closed on a null caller and does NOT call noteGateComputedBlind().`,
      `returns ${f.returnType}, guard ${f.guard}`,
      "So a gate decided with no identity to decide it from leaves no identity-stale-gate row, and",
      "currentScreenGatedBlind() cannot raise app.ts's forceForBlindGate to re-render the screen.");
  }
}

if (failures.length > 0) {
  console.error(`\nIDENTITY-GATE WITNESS GATE: FAIL, ${failures.length} problem(s).`);
  process.exit(1);
}

for (const f of required) console.log(`  ok   ${f.rel}:${f.line} ${f.name}() witnesses its blind gate`);
for (const f of exempt) console.log(`  ok   ${f.rel}:${f.line} ${f.name}() exempt, ${f.exempt}`);
console.log("IDENTITY-GATE WITNESS GATE: PASS");
