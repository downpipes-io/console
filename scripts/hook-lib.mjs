// Hook census engine: the shared AST walk behind scripts/hook-census.mjs and
// test/validate-hooks.ts, so the report tool and the enforcing gate can never disagree about what
// counts as a target or a hook (one detector, two callers -- the same shape as field-census.mjs /
// field-catalogue-gate.mjs, folded into one module because there is no external catalogue file to
// reconcile against here: the target population and the hook population are both derived from the
// same source tree in the same pass).
//
// WHAT THIS FINDS. Two populations, both drawn from the same closed set of DOM-producing call shapes
// field-census.mjs already established (h() and field(), lib/dom.ts and components/field.ts -- see
// that file's header for why a regex cannot do this safely):
//
//   1. INPUT-LIKE CONTROLS WITH NO RELIABLE DOM ID: a field()/raw-input/raw-select/raw-textarea/
//      checkboxRow/aria-widget call site whose `id` is absent or computed at runtime. These already
//      exist in the field catalogue as the "no-id" rows (see catalogue.jsonl); a stable data-dp is
//      the ONLY drift-proof way the harness can target one, because a positional fallback (the
//      catalogue's own `#n` census-key suffix) is a RECONCILIATION key, not a selector, and shifts
//      the moment a sibling control is added, removed or reordered.
//   2. ACTION BUTTONS: every h("button", ...) call site that is not an ARIA widget (a radio/switch/
//      toggle already covered by population 1). This codebase's buttons carry no `id` at all by
//      convention (grep confirms it), so this population is, in practice, "every button".
//
// THE KEY SCHEME (documented once, here -- the only place it should ever need explaining):
//
//   data-dp="<screen>.<role>.<purpose>[#n]"
//
//   screen  -- mechanically derived from the file path (screenSlug below): the directory under
//              src/screens/ for a screened control, or "<top>-<file>" for a shared component/shell/
//              lib helper. Never hand-assigned, so it cannot drift the way the field catalogue's
//              hand-curated `screen` column can; it also means a component used by several screens
//              (a confirm dialog, a table row) gets ONE stable key at its definition site, which is
//              the right level for a harness driving a UI where at most one instance of that
//              component is live at a time -- exactly how the existing data-tour-id hooks already
//              work for loop-generated rows (one hook value, set on every rendered row).
//   role    -- the control kind: "button" for an action button, else the input type/control kind
//              field-census already computes (text, select, checkbox, toggle, ...).
//   purpose -- NEVER the visible label or aria-label text (that is the one thing this scheme is
//              built to survive a rewording of). In priority order:
//                1. the control's OWN local variable name, if it is built as `const xBtn = h(...)`
//                   (very common for dialog/wizard buttons wired up a few lines later) -- a
//                   deliberate identifier a developer chose, stripped of a generic Btn/Button/Input/
//                   Field/Select/Control/Element suffix;
//                2. else the function NAME its click/change/input handler calls (plus a slug of the
//                   handler's first literal argument, so sibling buttons sharing one handler with
//                   different arguments -- setAll(true)/setAll(false) -- still separate);
//                3. else the enclosing named function (the component/render function), which this
//                   codebase names descriptively enough that it carries real meaning;
//                4. else the mechanism/control kind alone.
//              Two call sites that land on the identical screen+role+purpose (a genuine ambiguity,
//              e.g. two "delete" buttons in two files that map to one screen slug) are NOT hand-
//              disambiguated: they get a document-order `#n` suffix, exactly the field census's own
//              precedent for exactly the same reason (CROSS-CHECK-PROTOCOL.md 2: hand-typed keys
//              drifted; a mechanical suffix does not).
//
// THE ONE CANONICAL FORM. A hook is always written as a literal `"data-dp": "<key>"` string property
// on the control's OWN attrs object (never `dataset: { dp: ... }`, never set imperatively after
// construction). One form only, so detection is exact and this file never has to guess whether an
// imperative `.setAttribute` two functions away belongs to the control it decorates.
//
// Usage:
//   import { computeHookCensus } from "./hook-lib.mjs";
//   const { targets, missing, redundant, duplicates, hooked } = computeHookCensus(SRC_DIR);
//
// Run with cwd = console/ so "typescript" resolves from console/node_modules (same convention as
// field-census.mjs).

import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Factory internals, not user control declarations (mirrors field-census.mjs FACTORY_FILES).
const FACTORY_FILES = new Set(["src/components/field.ts"]);

const VAR_SUFFIXES = ["Btn", "Button", "Input", "Field", "Select", "Control", "Element", "El"];

function kebab(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
}

// screenSlug: the "screen" component of the key. See the header comment for the rule.
function screenSlug(rel) {
  const parts = rel.split("/"); // e.g. ["src","screens","sources-downpipes","table.ts"]
  if (parts[1] === "screens") {
    const seg = parts[2];
    return seg.endsWith(".ts") ? seg.slice(0, -3) : seg;
  }
  const filename = parts[parts.length - 1].replace(/\.ts$/, "");
  const parentDir = parts.length > 3 ? parts[parts.length - 2] : null;
  const top = parts[1];
  return parentDir && parentDir !== top ? `${top}-${parentDir}-${filename}` : `${top}-${filename}`;
}

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function staticText(v) {
  if (!v) return null;
  if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) return v.text;
  return null;
}

// objProps: read an object literal's own (non-spread) properties into { key -> valueNode }. Handles
// BOTH `key: value` (PropertyAssignment) and the `{ id }` shorthand (ShorthandPropertyAssignment,
// common on this codebase's dynamically-id'd controls, e.g. `h("input", { type: "radio", id, ... })`)
// -- the shorthand's "value" is the identifier itself, so a plain PropertyAssignment-only read (the
// field-census.mjs original this was adapted from) silently drops it and would misreport a genuinely
// id'd control as id-less.
function objProps(objNode) {
  const map = Object.create(null);
  for (const p of objNode.properties) {
    if (ts.isShorthandPropertyAssignment(p)) {
      map[p.name.text] = p.name; // `{ id }` -- key and value are the same identifier reference
      continue;
    }
    if (!ts.isPropertyAssignment(p) || !p.name) continue;
    /** @type {string | null} */
    let key = null;
    if (ts.isIdentifier(p.name)) key = p.name.text;
    else if (ts.isStringLiteral(p.name) || ts.isNoSubstitutionTemplateLiteral(p.name)) key = p.name.text;
    if (key) map[key] = p.initializer;
  }
  return map;
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

// isEnclosingFnExported / labelParameterised: inLoop() cannot see a shared render function called
// from several DIFFERENT files, which produces the identical "one hook, unstable label" defect a lexical
// loop produces without ever being one -- keys.button.apply is a real case of this (loop_generated:false,
// rendered with 4 different labels from 4 call sites via renderTokenApply). A real
// fix needs a whole-program call graph, out of reach for a single-file AST pass; these two facts are the
// cheap, LOCAL half of a heuristic that flags the shape for a human rather than silently agreeing with a
// wrong `false` (see the SUSPECT loop_generated report in functional-catalogue-gate.mjs, which pairs this
// with a cross-file call-site count and prints, never enforces, because fixing a genuine miss needs a
// paired internal-docs catalogue change this gate cannot make on its own).
function isEnclosingFnExported(node) {
  let n = node.parent;
  while (n) {
    if (ts.isFunctionDeclaration(n) && n.name) {
      return !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
    }
    if (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
      const par = n.parent;
      if (par && ts.isVariableDeclaration(par) && ts.isIdentifier(par.name)) {
        const declList = par.parent; // VariableDeclarationList
        const vs = ts.isVariableDeclarationList(declList) ? declList.parent : null; // VariableStatement
        return !!(vs && ts.canHaveModifiers(vs) && ts.getModifiers(vs)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
      }
      if (par && ts.isPropertyAssignment(par)) return false; // an object-literal method, not a module export
    }
    n = n.parent;
  }
  return false;
}

// True when the control's own rendered content is NOT a static literal but reads a property off the
// function's own `opts`/`props` parameter (the exact shape used by `opts.action.label`,
// `opts.confirmLabel`, `props.*.label`) -- the thing a caller supplies, and therefore the thing that can
// differ between call sites even though this one function body contains no loop at all.
function labelParameterised(node, sf) {
  if (!ts.isCallExpression(node)) return false;
  for (const c of node.arguments.slice(2)) {
    if (/^(opts|props)\.\w/.test(c.getText(sf).trim())) return true;
  }
  return false;
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

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name.text;
  return null;
}

function literalSlug(argNode) {
  if (!argNode) return null;
  if (ts.isStringLiteral(argNode) || ts.isNoSubstitutionTemplateLiteral(argNode)) {
    const s = kebab(argNode.text.replace(/^\//, ""));
    return s || null;
  }
  if (argNode.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (argNode.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (ts.isNumericLiteral(argNode)) return argNode.text;
  return null;
}

// lastCallInHandler: the LAST top-level call (an ExpressionStatement or a return) inside a handler's
// body, which in this codebase's style is consistently the action the button is actually FOR (an
// earlier statement in a multi-statement handler is typically a side-effect callback, e.g.
// `onManageNavigate(); navigate("/destinations");`).
function lastCallInHandler(fnNode) {
  if (!fnNode || (!ts.isArrowFunction(fnNode) && !ts.isFunctionExpression(fnNode))) return null;
  const body = fnNode.body;
  if (ts.isCallExpression(body)) return body; // concise arrow body
  if (!ts.isBlock(body)) return null;
  /** @type {import("typescript").CallExpression | null} */
  let lastCall = null;
  for (const stmt of body.statements) {
    if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) lastCall = stmt.expression;
    if (ts.isReturnStatement(stmt) && stmt.expression && ts.isCallExpression(stmt.expression)) lastCall = stmt.expression;
  }
  return lastCall;
}

// purposeFromCallableValue: given a handler VALUE node (an identifier reference or an inline
// function), the shared extraction both the inline `on: { click: ... }` property and a sibling
// `.addEventListener("click", ...)` call use.
function purposeFromCallableValue(val) {
  if (!val) return null;
  if (ts.isIdentifier(val)) return kebab(val.text.replace(/^on(?=[A-Z])/, ""));
  if (ts.isArrowFunction(val) || ts.isFunctionExpression(val)) {
    const call = lastCallInHandler(val);
    if (call) {
      const name = calleeName(call.expression);
      if (name) {
        const base = kebab(name.replace(/^on(?=[A-Z])/, ""));
        const lit = literalSlug(call.arguments[0]);
        return lit ? `${base}-${lit}` : base;
      }
    }
  }
  return null;
}

function purposeFromHandler(attrs) {
  const onNode = attrs.on;
  if (!onNode || !ts.isObjectLiteralExpression(onNode)) return null;
  const handlers = objProps(onNode);
  for (const evt of ["click", "change", "input"]) {
    const p = purposeFromCallableValue(handlers[evt]);
    if (p) return p;
  }
  return null;
}

// findAddEventListenerHandler: this codebase's OTHER wiring idiom -- `const x = h("button", ...);
// x.addEventListener("click", handler);` a few lines later, common where the button is built inside a
// loop or needs to be referenced again (disabled toggling, a second listener). Scans the statement
// list of the nearest enclosing block (function body or module scope) for a call matching
// `<varName>.addEventListener("click"|"change"|"input", handler)` and hands the handler to the same
// extractor the inline `on:` property uses.
const HANDLER_EVENTS = new Set(["click", "change", "input"]);
function findAddEventListenerHandler(node, varName) {
  if (!varName) return null;
  let n = node.parent;
  while (n && !ts.isBlock(n) && !ts.isSourceFile(n)) n = n.parent;
  if (!n) return null;
  for (const stmt of n.statements) {
    const expr = ts.isExpressionStatement(stmt) ? stmt.expression : null;
    if (!expr || !ts.isCallExpression(expr)) continue;
    const callee = expr.expression;
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "addEventListener") continue;
    if (!ts.isIdentifier(callee.expression) || callee.expression.text !== varName) continue;
    const evtArg = expr.arguments[0];
    if (!evtArg || !ts.isStringLiteral(evtArg) || !HANDLER_EVENTS.has(evtArg.text)) continue;
    const p = purposeFromCallableValue(expr.arguments[1]);
    if (p) return p;
  }
  return null;
}

// A bare local-variable name that survives suffix-stripping to nothing distinctive (every button in
// the file called it exactly this, or it is a one/two-letter throwaway): not wrong, but not worth
// preferring over a handler's own verb or the enclosing function's name, so these fall through to the
// next signal instead.
const GENERIC_NAMES = new Set(["btn", "button", "el", "elem", "element", "node", "control", "input", "field", "toggle", "link", "action"]);

// nearestVarDeclName: the control's own `h(...)` call is not always the DIRECT initializer of its
// variable -- a disabled/owner-gated control is commonly built behind a ternary, e.g.
// `const removeBtn = ownerGate ? h("button", ...) : h("button", { disabled: true }, ...)`. Walk up
// through the "transparent" wrapper node kinds (parens, `as`, both arms of a ternary, && / || short-
// circuits) to find the real declaration; stop at anything else (a function boundary, a call
// argument, an array/object literal) so this never wanders into an unrelated enclosing declaration.
function nearestVarDeclName(node) {
  let n = node;
  while (n.parent) {
    const p = n.parent;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.initializer === n) return p.name.text;
    const transparent =
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      (ts.isConditionalExpression(p) && (p.whenTrue === n || p.whenFalse === n)) ||
      (ts.isBinaryExpression(p) && (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || p.operatorToken.kind === ts.SyntaxKind.BarBarToken || p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) && p.right === n);
    if (!transparent) return null;
    n = p;
  }
  return null;
}

// derivePurpose: see the header's numbered priority list. `role` (already computed by the caller) lets
// this reject a variable name that is merely a restatement of the control's own kind (`const radio =
// h("input", { type: "radio", ... })`, `const fileInput = h("input", { type: "file", ... })`) --
// role.role tells a reader nothing role alone did not, so that case falls through to the next signal.
function derivePurpose(node, attrs, role) {
  const rawVarName = nearestVarDeclName(node);
  /** @type {string | null} */
  let varName = null;
  if (rawVarName) {
    varName = rawVarName;
    let stripped = rawVarName;
    for (const suf of VAR_SUFFIXES) {
      if (stripped.length > suf.length && stripped.endsWith(suf)) {
        stripped = stripped.slice(0, -suf.length);
        break;
      }
    }
    const strippedKebab = stripped ? kebab(stripped) : "";
    if (stripped && stripped.length > 2 && !GENERIC_NAMES.has(stripped.toLowerCase()) && strippedKebab !== role) return kebab(stripped);
  }
  if (attrs) {
    const fromHandler = purposeFromHandler(attrs);
    if (fromHandler) return fromHandler;
  }
  const fromListener = findAddEventListenerHandler(node, varName);
  if (fromListener) return fromListener;
  const fn = enclosingFn(node);
  if (fn) return kebab(fn.replace(/^(render|build)/, ""));
  if (varName) return kebab(varName); // the generic name is still better than nothing
  return null;
}

const ARIA_WIDGET_ROLES = new Set(["radio", "switch"]);

export function computeHookCensus(srcDir) {
  const consoleRoot = join(srcDir, "..");
  const targets = []; // one row per call site that is (or could be) a data-dp anchor

  for (const abs of walk(srcDir, [])) {
    const rel = relative(consoleRoot, abs).split("\\").join("/");
    const text = readFileSync(abs, "utf8");
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TS);
    const at = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

    // record: push one target row for a call site. attrsObjNode is the literal object to splice a
    // hook into (null when the attrs are not a literal, e.g. a spread variable -- those cannot be
    // auto-stamped and are reported as such).
    const record = (node, { mechanism, role, attrsObjNode }) => {
      const attrs = attrsObjNode && ts.isObjectLiteralExpression(attrsObjNode) ? objProps(attrsObjNode) : null;
      const idNode = attrs?.id;
      // A control "has a reliable id" once its id PROPERTY exists at all, static or computed: a
      // computed id (e.g. `role-${role.id}`) is still a real, unique runtime DOM id the harness can
      // target directly once it knows the value it seeded -- which it always does, since it is the one
      // driving that exact scenario -- and it is a MORE precise selector than a shared data-dp would
      // be (a data-dp lives on the call site, so every runtime instance of a loop-generated control
      // would carry the identical value, which cannot tell "the row for role eng" apart from any
      // other row the same way `#role-eng-view` can). Only a wholly absent id property earns a hook.
      const hasStableId = !!idNode;
      const hookNode = attrs?.["data-dp"];
      const hookValue = hookNode ? staticText(hookNode) : null;
      const screen = screenSlug(rel);
      const purpose = derivePurpose(node, attrs, role) ?? mechanism;
      targets.push({
        _base: `${screen}.${role}.${purpose}`,
        file: rel,
        line: at(node),
        fn: enclosingFn(node),
        loopGenerated: inLoop(node),
        // Report-only facts, consumed solely by functional-catalogue-gate.mjs's SUSPECT
        // loop_generated heuristic. Not part of the committed hook census's own identity cells: adding
        // fields here does not create hook-census drift, since that check only iterates the COMMITTED
        // row's own keys (hook-lib.mjs is read live by the gate for this heuristic, never seeded).
        fnExported: mechanism === "button" || mechanism === "aria-widget" ? isEnclosingFnExported(node) : false,
        labelParameterised: mechanism === "button" || mechanism === "aria-widget" ? labelParameterised(node, sf) : false,
        mechanism,
        role,
        hasStableId,
        hookValue,
        canAutoStamp: !!attrsObjNode && ts.isObjectLiteralExpression(attrsObjNode),
        // Absolute source position of the attrs object's opening brace, for a --write INSERT (a control
        // with no hook yet).
        insertAt: attrsObjNode && ts.isObjectLiteralExpression(attrsObjNode) ? attrsObjNode.getStart(sf) + 1 : null,
        // The existing data-dp string literal's own span (quotes included), for a --write REPLACE (a
        // hook that is present but whose value has drifted from this file's current derivation -- e.g. a
        // newly added sibling control shifted a #n collision suffix). Null when there is no hook yet.
        hookValueStart: hookNode ? hookNode.getStart(sf) : null,
        hookValueEnd: hookNode ? hookNode.getEnd() : null,
        absFile: abs,
      });
    };

    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = node.expression.text;
        const args = node.arguments;
        const a0 = args[0];

        if (callee === "field" && a0 && ts.isObjectLiteralExpression(a0)) {
          const attrs = objProps(a0);
          const kind = attrs.kind ? staticText(attrs.kind) ?? "input" : "input";
          record(node, { mechanism: "field", role: kind, attrsObjNode: a0 });
        } else if (callee === "h" && a0 && ts.isStringLiteral(a0)) {
          const tag = a0.text;
          const a1 = args[1];
          if ((tag === "input" || tag === "select" || tag === "textarea") && !FACTORY_FILES.has(rel)) {
            const attrsMap = a1 && ts.isObjectLiteralExpression(a1) ? objProps(a1) : {};
            const type = tag === "input" ? (staticText(attrsMap.type) ?? "text") : tag;
            record(node, { mechanism: `raw-${tag}`, role: type, attrsObjNode: a1 });
          } else if (tag === "button" && a1 && ts.isObjectLiteralExpression(a1)) {
            const attrsMap = objProps(a1);
            const roleText = staticText(attrsMap.role);
            const isWidget = ARIA_WIDGET_ROLES.has(roleText ?? "") || "aria-pressed" in attrsMap || "aria-checked" in attrsMap;
            if (isWidget) {
              const role = roleText ?? ("aria-pressed" in attrsMap ? "toggle" : "switch");
              record(node, { mechanism: "aria-widget", role, attrsObjNode: a1 });
            } else {
              record(node, { mechanism: "button", role: "button", attrsObjNode: a1 });
            }
          }
        } else if (callee === "checkboxRow") {
          // checkboxRow(id, label, hint?) always takes a required positional id -- static or a
          // template literal such as `canary-d-${d.id}` -- so it never lacks a REAL id in practice; the
          // same "present, static or computed" rule as h()'s id applies (see the record() comment
          // above), represented here so a future call site built with NO id argument at all is still
          // caught, not silently invisible.
          const idArg = args[0];
          const hasStableId = !!idArg;
          const screen = screenSlug(rel);
          const purpose = derivePurpose(node, null, "checkbox") ?? "checkbox";
          targets.push({
            _base: `${screen}.checkbox.${purpose}`,
            file: rel,
            line: at(node),
            fn: enclosingFn(node),
            loopGenerated: inLoop(node),
            mechanism: "helper-checkboxRow",
            role: "checkbox",
            hasStableId,
            hookValue: null,
            canAutoStamp: false, // positional helper, not an attrs object; see report for manual follow-up
            insertAt: null,
            absFile: abs,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // Global, line-free key assignment (field-census.mjs's own precedent: group by the semantic base,
  // suffix #n in document order only when more than one call site lands on the identical base).
  const groups = new Map();
  for (const t of targets) {
    const g = groups.get(t._base);
    if (g) g.push(t);
    else groups.set(t._base, [t]);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
    if (group.length === 1) group[0].key = group[0]._base;
    else
      group.forEach((t, i) => {
        t.key = `${t._base}#${i + 1}`;
      });
  }
  for (const t of targets) delete t._base;

  const needsHook = (t) => !t.hasStableId; // the population the harness cannot otherwise reach
  const missing = targets.filter((t) => needsHook(t) && !t.hookValue);
  const hooked = targets.filter((t) => !!t.hookValue);
  // redundant: a hook sitting on a control that ALSO carries a stable static id -- dead weight left
  // behind by an id later added to a previously-hooked control (or a hook added where one was never
  // needed). Not wrong at runtime, but drift the gate should still catch and a person should remove.
  const redundant = hooked.filter((t) => t.hasStableId);
  // duplicates: two DIFFERENT call sites (distinct file:line) whose ACTUAL source hookValue collides.
  // This is read from the source itself, independent of this run's key computation, so it catches a
  // hand-edited or copy-pasted collision even if this file's derivation logic changes later.
  const byValue = new Map();
  for (const t of hooked) {
    const arr = byValue.get(t.hookValue) ?? [];
    arr.push(t);
    byValue.set(t.hookValue, arr);
  }
  const duplicates = [...byValue.values()].filter((arr) => arr.length > 1);

  return { targets, missing, hooked, redundant, duplicates, needsHook };
}
