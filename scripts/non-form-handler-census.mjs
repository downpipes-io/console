// Non-form-control handler census: makes durable and re-derivable the blind spot in the button/toggle/nav
// census (functional-census.mjs), which structurally cannot see handler-bearing elements that are not an
// h("button") call site. functional-census.mjs already names four action classes it cannot see (keydown
// chords, canvas hit-targets, scrim/Esc/click-outside dismissal, acting anchors); this script measures
// them.
//
// TWO SLICES, because one of them alone is a floor of a floor.
//
//   SLICE A -- INLINE. Every h(tag, { on: { event: handler, ... } }) call site in console/src where tag
//     is not one of button/input/select/textarea. This is the slice a tag-anchored AST pass can defend
//     absolutely: the tag is a string literal in the same call.
//
//   SLICE B -- LISTENER. Every `<receiver>.addEventListener("<event>", handler)` call site, minus the
//     ones whose receiver this pass can PROVE is a form control. Excluding this class would understate
//     the blind spot by more than a factor of two, which is why it is measured as its own slice.
//
// THE RULE SLICE B OBEYS: a listener is NEVER attributed to a tag this pass cannot prove. A receiver is
// either resolved to an h("<tag>") / field() / checkboxRow() call by its OWN declaration in the same
// file, or it is emitted in a named UNRESOLVED bucket describing the receiver's SHAPE. There is no
// name-matching across files and no nearest-enclosing-tag fallback: both misattribute badly, reporting
// several hits under a nearest-enclosing-tag guess where a tag-anchored pass finds only one. An
// unresolved row is a row a reader must resolve by hand; it is not a row this script guesses at.
//
// SCOPE, stated rather than left for a reader to infer:
//   - It counts call SITES, not runtime instances: a handler inside a loop body (one h() call producing
//     N live elements, e.g. the run-strip li) counts once, matching how functional-census.mjs counts
//     h("button") sites.
//   - It still does NOT see canvas hit-testing (screens/map: the hit target is a coordinate, not an
//     element, so there is nothing to anchor a row to). The SVG topology's hit targets DO appear, in
//     slice B, because they are real elements carrying real listeners.
//   - `suppressor: true` marks a handler whose entire body is `ev.preventDefault()`. Those are not
//     actions and never need a catalogue key: they exist so implicit Enter submission does not reload
//     the page. The headline count below separates them rather than reporting one number that mixes
//     controls with suppressors.
//   - `stable_selector` names the drift-resistant selector the element ALREADY carries (an id, an href,
//     a dataset hook, a data-dp, an aria-label), or "none". It is reported because "these controls have
//     no catalogue key" and "these controls cannot be targeted" are different claims, and most genuine
//     slice-A action controls are already addressable by href or id.
//   - `activatable` is a PROXY UNDER TEST, not a verdict, and it is the only column here that can be
//     wrong rather than merely incomplete. The key-scheme plan wants to catalogue the elements a person
//     ACTS on and leave out the keyboard, dismissal and hover behaviours of controls that already have
//     rows, and that boundary is drawn by hand. This column is the mechanical re-derivation of it: yes
//     when the element carries an href, an ARIA widget role, or a real tabindex, whether declared in the
//     h() attrs or written on later with setAttribute. Measured against the hand-drawn boundary, it
//     decides 52 of the 113 interactive non-suppressor rows and agrees on 51 of those 52, with no false
//     positives. The one disagreement is screens/passkey/flows.ts:401, a form/submit, because a form is
//     not itself the operable control and carries none of the three attributes. The 61 it cannot decide
//     are the cost of slice B's own refusal to resolve a receiver it cannot prove, so the limit on a
//     mechanical split is the RECEIVER RESOLVER above, not this rule.
//   - None of these controls has a row in internal-docs/FUNCTIONAL-CATALOGUE/action-catalogue.jsonl.
//     Extending the key scheme to cover them is a design decision (what key shape a bare div/li/a with a
//     handler gets), not a measurement, and is deliberately NOT made here.
//
// Modes:
//   node scripts/non-form-handler-census.mjs   report only, exit 0 always, writing NOTHING.
//   node scripts/non-form-handler-census.mjs --write-internal-docs
//                                              ALSO refresh the committed JSONL denominator, which lives
//                                              in internal-docs. A caller reading a report only must never
//                                              dirty a repository this script does not own.
//
// SIBLING-SUPPLY: an on-demand writer, deliberately in no chain, for the reason functional-census.mjs
// gives: it refreshes a committed artefact when asked and refuses when internal-docs is not resolvable.
// FS-WRITES: <workspace>/internal-docs/FUNCTIONAL-CATALOGUE/non-form-handler-census.jsonl
// FS-WRITES-RUN: --write-internal-docs

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { findWorkspaceDir } from "./workspace-root.mjs";
import { announceOutsideWrites, announceOutsideWritesHeld, outsideWriteRequested } from "./outside-write.mjs";

const CONSOLE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = join(CONSOLE_ROOT, "src");

// Same workspace resolution functional-census.mjs and functional-catalogue-gate.mjs use, and the same one
// copy of it (scripts/workspace-root.mjs). Bounded, and it refuses any candidate inside
// a .worktrees directory, so this script's write cannot land on a stale internal-docs beside a worktree or
// on an unrelated checkout found by chance several directories above wherever it was run.

// The refusal is conditional on the flag: a report run has no write to refuse, and stopping it over an
// unresolved sibling it will not touch is the same fault with the sign flipped.
const MARKER = join("internal-docs", "FUNCTIONAL-CATALOGUE", "action-census.jsonl");
const PUBLISH = outsideWriteRequested();
const WORKSPACE = findWorkspaceDir(CONSOLE_ROOT, MARKER);
if (PUBLISH && WORKSPACE === null) {
  console.error(`\n[non-form-handler-census] FATAL: could not resolve the workspace root from ${CONSOLE_ROOT}.`);
  console.error(`  Tried the direct parent and the owner of any .worktrees segment; none carries ${MARKER}`);
  console.error("  outside a .worktrees directory, which is refused however it is reached.");
  console.error("  Check internal-docs out beside this repo, or set DOWNPIPES_WORKSPACE=/path/to/workspace-root.\n");
  process.exit(2);
}
const OUT_JSONL =
  WORKSPACE === null
    ? "<workspace-root>/internal-docs/FUNCTIONAL-CATALOGUE/non-form-handler-census.jsonl  (workspace root unresolved from here)"
    : join(WORKSPACE, "internal-docs", "FUNCTIONAL-CATALOGUE", "non-form-handler-census.jsonl");

const FORM_CONTROL_TAGS = new Set(["button", "input", "select", "textarea"]);
// Factory calls whose product IS a form control, so a listener attached to one is inside the field
// catalogue's population rather than this one. field() returns { el, control } where control is the
// input/select/textarea itself (components/field.ts); checkboxRow() wraps an h("input", type checkbox).
const FORM_CONTROL_FACTORIES = new Set(["field", "checkboxRow"]);
const GLOBAL_RECEIVERS = new Set(["document", "window", "globalThis", "self"]);
// Events that a person performs on purpose. The rest (scroll, resize, visibilitychange, animationend,
// pageshow, popstate, error, ...) are lifecycle or ambient signals; they are still emitted, marked
// interactive:false, so the headline count is about controls rather than about listener volume.
const INTERACTIVE_EVENTS = new Set([
  "click", "dblclick", "keydown", "keyup", "keypress", "change", "input", "submit",
  "pointerdown", "pointerup", "mousedown", "mouseup", "contextmenu", "toggle",
  "mouseenter", "mouseleave", "focusin", "focusout", "focus", "blur",
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\./.test(entry)) out.push(full);
  }
  return out;
}

function eventNameOf(node) {
  if ((ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) && node.name) {
    if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  }
  if (ts.isShorthandPropertyAssignment(node)) return node.name.text;
  return "?";
}

function handlerValueOf(node) {
  if (ts.isPropertyAssignment(node)) return node.initializer;
  if (ts.isShorthandPropertyAssignment(node)) return node.name;
  return null;
}

// isSuppressor: the handler's ENTIRE body is a preventDefault (optionally with stopPropagation). Such a
// handler has no user-visible effect to catalogue -- it exists so the browser's own default (an implicit
// form submission reloading the page) does not fire.
function isSuppressor(fn) {
  if (!fn || (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))) return false;
  const isPreventCall = (expr) =>
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    (expr.expression.name.text === "preventDefault" || expr.expression.name.text === "stopPropagation");
  if (!ts.isBlock(fn.body)) return isPreventCall(fn.body);
  const stmts = fn.body.statements;
  if (stmts.length === 0 || stmts.length > 2) return false;
  return stmts.every((s) => ts.isExpressionStatement(s) && isPreventCall(s.expression));
}

// stableSelectorOf: which drift-resistant selector this element ALREADY carries, in the order a harness
// would prefer. "none" means a new hook would genuinely have to be added to target it.
function stableSelectorOf(attrsMap) {
  if (attrsMap["data-dp"]) return "data-dp";
  if (attrsMap.id) return "id";
  if (attrsMap.href) return "href";
  if (attrsMap.dataset) return "dataset";
  if (attrsMap["aria-label"]) return "aria-label";
  return "none";
}

// activatableOf: the MECHANICAL PROXY for "a person acts on this element", computed from the element's
// OWN attributes rather than from a reader's judgement about what it does.
//
// WHY IT EXISTS. The key-scheme plan splits this population into activatable controls (what an action
// catalogue is for) and behaviours OF controls that are already catalogued (roving keydown on a tablist,
// a dialog's Esc, hover). That split decides how many rows a new scheme would have to cover, and it was
// drawn BY HAND. A boundary a script cannot re-derive drifts, so the plan names a mechanical proxy as a
// prerequisite of adopting the split rather than as a nicety. This is that proxy, and the point of
// emitting it is that it can be DISAGREED with: the tally it prints beside the hand-drawn families is
// what says whether the proxy is fit to carry the boundary.
//
// THE RULE, and it is deliberately narrow. Yes when the element carries an href, an ARIA widget role, or
// a tabindex, because all three are things an author writes to make an element reachable and operable.
// No when the attributes are visible and carry none of them. UNKNOWN, never "no", when the attributes are
// not visible at all: slice B resolves most receivers to a variable rather than to an h() call, and a
// proxy that reported those as "not a control" would be manufacturing the very judgement it replaces.
const ACTIVATABLE_ROLES = new Set([
  "button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "checkbox", "radio", "switch", "treeitem", "combobox", "slider", "spinbutton",
]);
// TWO RULES THAT NEED STATING EXPLICITLY, because each cuts against the naive reading and each is a rule
// rather than a patch for one row.
//
//   tabindex="-1" IS NOT ACTIVATION. It means "focusable by script, not reachable by the user", which is
//   the opposite of what this proxy is asking: a programmatic focus target carrying role="region" and
//   tabindex="-1" (such as the tour nav bar) is not an activatable control on that basis. Note the one
//   subtlety: a ROVING tabindex writes "-1" onto every row but the active one, so "-1" is only decisive
//   when nothing else on the element says activation, which is why it is tested last.
//
//   ATTRIBUTES SET IMPERATIVELY COUNT. The console writes activation attributes with setAttribute about
//   as often as it declares them: 23 setAttribute("tabindex") and 12 setAttribute("role") call sites
//   against 41 declared tabindex and 333 declared role. Reading only the h() attrs literal would miss the
//   data table's activatable rows outright, which set role="button" and a roving tabindex on the tr after
//   building it. Those are the clearest family-1 controls in the whole population.
function activatableOf(attrsMap, tag) {
  if (attrsMap === null) return "unknown";
  if (tag === "a" && attrsMap.href !== undefined) return "yes";
  if (tag === "details" || tag === "summary") return "yes";
  const role = attrsMap.role;
  let roleUnknown = false;
  if (role !== undefined) {
    if (ts.isStringLiteral(role)) {
      if (ACTIVATABLE_ROLES.has(role.text)) return "yes";
    } else {
      roleUnknown = true;
    }
  }
  const ti = attrsMap.tabindex ?? attrsMap.tabIndex;
  if (ti !== undefined) {
    // A computed tabindex is the roving idiom and is treated as activation; a literal "-1" is not.
    if (!ts.isStringLiteral(ti) || ti.text !== "-1") return "yes";
  }
  // A role this pass could not read leaves the element undecided rather than cleared.
  return roleUnknown ? "unknown" : "no";
}

// imperativeAttrsFor: the role/tabindex/href this file writes onto `name` with setAttribute or a property
// assignment, merged into the declared attrs before the proxy runs. Same-file and same-identifier only,
// which is the rule the whole of slice B obeys: no cross-file name matching.
function imperativeAttrsFor(sf, name) {
  const out = Object.create(null);
  const want = new Set(["role", "tabindex", "tabIndex", "href"]);
  const visit = (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "setAttribute" &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === name &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0]) &&
      want.has(n.arguments[0].text)
    ) {
      out[n.arguments[0].text] = n.arguments[1] ?? n.arguments[0];
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) &&
      ts.isIdentifier(n.left.expression) &&
      n.left.expression.text === name &&
      want.has(n.left.name.text)
    ) {
      out[n.left.name.text] = n.right;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function objProps(objNode) {
  const map = Object.create(null);
  if (!objNode || !ts.isObjectLiteralExpression(objNode)) return map;
  for (const p of objNode.properties) {
    if (ts.isShorthandPropertyAssignment(p)) { map[p.name.text] = p.name; continue; }
    if (!ts.isPropertyAssignment(p) || !p.name) continue;
    if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) map[p.name.text] = p.initializer;
  }
  return map;
}

// unwrap: step through the node kinds that wrap an expression without changing what it evaluates to.
function unwrap(node) {
  let n = node;
  for (let i = 0; i < 8 && n; i++) {
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n)) {
      n = n.expression;
      continue;
    }
    break;
  }
  return n;
}

// producerOf: what an initializer expression CONSTRUCTS, or null when this pass cannot prove it. A
// ternary counts only when both arms agree, because "a disabled twin built in the other arm" is the one
// idiom where the arms differ and guessing either way would be a fabrication.
function producerOf(init) {
  const n = unwrap(init);
  if (!n) return null;
  if (ts.isConditionalExpression(n)) {
    const a = producerOf(n.whenTrue);
    const b = producerOf(n.whenFalse);
    return a && b && a.kind === b.kind && a.name === b.name ? a : null;
  }
  if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
    const callee = n.expression.text;
    if (callee === "h" && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      // The attrs literal travels with the tag so slice B can compute the activatable proxy from the
      // element's own attributes. Null when the h() call has no object-literal attrs argument at all,
      // which activatableOf reports as unknown rather than as "not a control".
      // Three states, not two. An h() with an object-literal attrs argument has its attrs READ; an h()
      // with no second argument at all (h("tr")) has NO attrs, which is knowledge and not ignorance; an
      // h() whose second argument is some other expression is genuinely unreadable. Collapsing the middle
      // case into the last would report a bare element as undecided when the source is perfectly clear.
      const a = n.arguments[1];
      const attrs = a === undefined ? "none" : ts.isObjectLiteralExpression(a) ? a : null;
      return { kind: "tag", name: n.arguments[0].text, attrs };
    }
    if (FORM_CONTROL_FACTORIES.has(callee)) return { kind: "form-factory", name: `${callee}()` };
    return { kind: "call", name: `${callee}()` };
  }
  return null;
}

// findDecl: the declaration of `name` visible from `node`, walking enclosing blocks, the source file and
// function parameter lists. A destructured binding is returned as its own kind rather than resolved: the
// value comes from somewhere else, often another file, and following it by NAME is the exact fault this
// script's header refuses.
function findDecl(node, name) {
  let n = node.parent;
  while (n) {
    if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseClause(n)) {
      for (const stmt of n.statements ?? []) {
        if (!ts.isVariableStatement(stmt)) continue;
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) return { kind: "var", decl: d };
          if (ts.isObjectBindingPattern(d.name) || ts.isArrayBindingPattern(d.name)) {
            for (const el of d.name.elements) {
              if (ts.isBindingElement(el) && ts.isIdentifier(el.name) && el.name.text === name) {
                return { kind: "destructured", from: d.initializer ? d.initializer.getText().slice(0, 40) : "?" };
              }
            }
          }
        }
      }
    }
    if (n.parameters) {
      for (const p of n.parameters) {
        if (ts.isIdentifier(p.name) && p.name.text === name) return { kind: "param" };
        if (ts.isObjectBindingPattern(p.name)) {
          for (const el of p.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name) && el.name.text === name) return { kind: "param" };
          }
        }
      }
    }
    n = n.parent;
  }
  return null;
}

// classifyReceiver: the whole of slice B's honesty. Returns { bucket, form_control, tag, detail }.
// form_control is true ONLY when this pass proved it; an unresolved receiver is never assumed to be one.
function classifyReceiver(recv, callNode, sf) {
  if (ts.isIdentifier(recv)) {
    const name = recv.text;
    // A global receiver is reported activatable:"no" as a FACT about the receiver rather than a judgement
    // about the handler: document and window are not elements, so no key scheme built to name a control
    // can name one of these, whatever the handler does.
    if (GLOBAL_RECEIVERS.has(name)) return { bucket: "global", form_control: false, tag: name, detail: name, activatable: "no" };
    const decl = findDecl(callNode, name);
    if (!decl) return { bucket: "unresolved-identifier", form_control: false, tag: null, detail: `${name} (no declaration found in this file)` };
    if (decl.kind === "param") return { bucket: "unresolved-param", form_control: false, tag: null, detail: `${name} (function parameter)` };
    if (decl.kind === "destructured") return { bucket: "unresolved-destructured", form_control: false, tag: null, detail: `${name} (destructured from ${decl.from})` };
    const prod = producerOf(/** @type {{ initializer?: unknown }} */ (decl.decl).initializer);
    if (!prod) return { bucket: "unresolved-initializer", form_control: false, tag: null, detail: `${name} (initializer this pass cannot prove)` };
    if (prod.kind === "tag") {
      const isForm = FORM_CONTROL_TAGS.has(prod.name);
      return {
        bucket: isForm ? "resolved-form-control" : "resolved-non-form-control",
        form_control: isForm,
        tag: prod.name,
        detail: `${name} = h("${prod.name}")`,
        activatable: activatableOf(
          prod.attrs === null
            ? null
            : { ...(prod.attrs === "none" ? {} : objProps(prod.attrs)), ...imperativeAttrsFor(sf, name) },
          prod.name,
        ),
      };
    }
    if (prod.kind === "form-factory") return { bucket: "resolved-form-control", form_control: true, tag: prod.name, detail: `${name} = ${prod.name}` };
    return { bucket: "unresolved-call", form_control: false, tag: null, detail: `${name} = ${prod.name}` };
  }
  if (ts.isPropertyAccessExpression(recv)) {
    const text = recv.getText(sf);
    let base = recv.expression;
    while (ts.isPropertyAccessExpression(base)) base = base.expression;
    if (ts.isIdentifier(base)) {
      // window.matchMedia(...) and the like: the base is global, but the receiver is a property path off
      // it, so what it ends up on is not proven. Unknown rather than "no", unlike the bare global above.
      if (GLOBAL_RECEIVERS.has(base.text)) return { bucket: "global", form_control: false, tag: text, detail: text, activatable: "unknown" };
      const decl = findDecl(callNode, base.text);
      // A property path whose BASE is destructured or a parameter is reported as such rather than as a
      // bare "unresolved-property": the two need different hand resolution (follow the destructuring's
      // source function, versus follow every call site of the enclosing function), and a reader who
      // cannot tell them apart has to redo the walk this pass already did.
      if (decl && (decl.kind === "destructured" || decl.kind === "param")) {
        const from = decl.kind === "destructured" ? `destructured from ${decl.from}` : "function parameter";
        return { bucket: `unresolved-${decl.kind}`, form_control: false, tag: null, detail: `${text} (${base.text} ${from})` };
      }
      if (decl && decl.kind === "var") {
        const prod = producerOf(/** @type {{ initializer?: unknown }} */ (decl.decl).initializer);
        // `someField.control` / `someField.input` where someField came from field() or checkboxRow():
        // the receiver IS the form control the field catalogue already carries a row for.
        if (prod && prod.kind === "form-factory") return { bucket: "resolved-form-control", form_control: true, tag: prod.name, detail: `${text} (${base.text} = ${prod.name})` };
        if (prod && prod.kind === "tag") {
          const isForm = FORM_CONTROL_TAGS.has(prod.name);
          return { bucket: isForm ? "resolved-form-control" : "unresolved-property", form_control: isForm, tag: isForm ? prod.name : null, detail: `${text} (${base.text} = h("${prod.name}"))` };
        }
      }
    }
    return { bucket: "unresolved-property", form_control: false, tag: null, detail: text };
  }
  if (recv.kind === ts.SyntaxKind.ThisKeyword) return { bucket: "unresolved-this", form_control: false, tag: null, detail: "this" };
  return { bucket: "unresolved-expression", form_control: false, tag: null, detail: recv.getText(sf).slice(0, 60) };
}

function scan(files) {
  const inline = [];
  const listener = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const rel = relative(CONSOLE_ROOT, file).split("\\").join("/");

    function visit(node) {
      // SLICE A: h(tag, { on: { ... } })
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "h" && node.arguments.length >= 2) {
        const tagArg = node.arguments[0];
        const attrsArg = node.arguments[1];
        if (ts.isStringLiteral(tagArg) && ts.isObjectLiteralExpression(attrsArg)) {
          const tag = tagArg.text;
          // The same imperative merge slice B does, reached the only way slice A can reach it: when this
          // h() call is the initializer of a named const, attributes written onto that name later in the
          // file are this element's attributes. The tour's early-exit anchor is built with a dataset hook
          // and gets its href from setAttribute forty lines on; without this it would read as a bare anchor.
          // Climb the wrappers, not just the direct parent: `const x = h("a", {...}) as HTMLAnchorElement`
          // puts an AsExpression between the call and its declaration, and stopping at the direct parent
          // would miss that anchor's declaration and report it as having no href.
          let up = node.parent;
          for (let i = 0; i < 8 && up; i++) {
            if (ts.isParenthesizedExpression(up) || ts.isAsExpression(up) || ts.isNonNullExpression(up) || ts.isTypeAssertionExpression(up)) {
              up = up.parent;
              continue;
            }
            break;
          }
          const declName =
            up && ts.isVariableDeclaration(up) && ts.isIdentifier(up.name) ? up.name.text : null;
          // TWO MAPS ON PURPOSE, because the two columns ask different questions of them.
          // stable_selector asks "what could a harness WRITE to reach this", so it reads DECLARED attrs
          // only: the tour's early-exit anchor gets its href from config at runtime, so a[href="..."] is
          // not a selector anyone can write for it, while its dataset hook is. activatable asks "is this
          // element operable", which a setAttribute answers just as well as a literal does.
          const declaredAttrs = objProps(attrsArg);
          const effectiveAttrs = declName === null
            ? declaredAttrs
            : { ...declaredAttrs, ...imperativeAttrsFor(sf, declName) };
          for (const prop of attrsArg.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === "on" &&
              ts.isObjectLiteralExpression(prop.initializer)
            ) {
              for (const evProp of prop.initializer.properties) {
                const event = eventNameOf(evProp);
                const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
                inline.push({
                  file: rel,
                  line: line + 1,
                  attach: "inline",
                  tag,
                  event,
                  form_control: FORM_CONTROL_TAGS.has(tag),
                  interactive: INTERACTIVE_EVENTS.has(event),
                  suppressor: isSuppressor(unwrap(handlerValueOf(evProp))),
                  stable_selector: stableSelectorOf(declaredAttrs),
                  activatable: activatableOf(effectiveAttrs, tag),
                  receiver: null,
                  resolution: "tag-literal",
                });
              }
            }
          }
        }
      }
      // SLICE B: <receiver>.addEventListener("<event>", handler)
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "addEventListener") {
        const evtArg = node.arguments[0];
        const event = evtArg && ts.isStringLiteral(evtArg) ? evtArg.text : "<non-literal>";
        const cls = classifyReceiver(node.expression.expression, node, sf);
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        listener.push({
          file: rel,
          line: line + 1,
          attach: "listener",
          tag: cls.tag,
          event,
          form_control: cls.form_control,
          interactive: INTERACTIVE_EVENTS.has(event),
          suppressor: isSuppressor(unwrap(node.arguments[1])),
          stable_selector: "unknown",
          activatable: cls.activatable ?? "unknown",
          receiver: cls.detail,
          resolution: cls.bucket,
        });
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }
  return { inline, listener };
}

const files = walk(SRC_ROOT);
const { inline, listener } = scan(files);
const all = [...inline, ...listener].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
const blind = all.filter((r) => !r.form_control);

if (PUBLISH) writeFileSync(OUT_JSONL, `${blind.map((r) => JSON.stringify(r)).join("\n")}\n`);

const inlineBlind = blind.filter((r) => r.attach === "inline");
const listenerBlind = blind.filter((r) => r.attach === "listener");
const suppressors = blind.filter((r) => r.suppressor);
const actionable = blind.filter((r) => r.interactive && !r.suppressor);

console.log(`\n[non-form-handler-census] ${files.length} source files scanned`);
console.log(`  SLICE A  h(tag, {on:{...}}) call sites: ${inline.length} total, ${inlineBlind.length} on non-form-control tags`);
console.log(`  SLICE B  addEventListener call sites:   ${listener.length} total, ${listenerBlind.length} not proven to be on a form control`);
console.log(`  BLIND SPOT (rows written): ${blind.length}`);
console.log(`    of which suppressors (handler body is only preventDefault): ${suppressors.length}`);
console.log(`    of which interactive and not a suppressor: ${actionable.length}`);

const tally = (rows, keyOf) => {
  const m = new Map();
  for (const r of rows) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
};

console.log(`\n  SLICE A by tag/event:`);
for (const [k, n] of tally(inlineBlind, (r) => `${r.tag}/${r.event}${r.suppressor ? " (suppressor)" : ""}`)) console.log(`    ${String(n).padStart(4)}  ${k}`);
console.log(`\n  SLICE A stable selector already present:`);
for (const [k, n] of tally(inlineBlind.filter((r) => !r.suppressor), (r) => r.stable_selector)) console.log(`    ${String(n).padStart(4)}  ${k}`);
console.log(`\n  SLICE B by receiver resolution (interactive events only):`);
for (const [k, n] of tally(listenerBlind.filter((r) => r.interactive), (r) => r.resolution)) console.log(`    ${String(n).padStart(4)}  ${k}`);

console.log(`\n  ACTIVATABLE PROXY over the ${actionable.length} interactive non-suppressor rows (href, ARIA widget role, or tabindex`);
console.log(`  on the element's own attributes). This is a PROXY under test, not a verdict: "unknown" is the`);
console.log(`  share of the population it cannot decide, and that share is the proxy's own score.`);
for (const [k, n] of tally(actionable, (r) => r.activatable)) console.log(`    ${String(n).padStart(4)}  ${k}`);
const decidable = actionable.filter((r) => r.activatable !== "unknown").length;
console.log(`    decides ${decidable} of ${actionable.length} rows (${Math.round((decidable / actionable.length) * 100)}%); the rest need a person.`);

console.log(`\n  READ THIS BEFORE QUOTING A NUMBER. An "unresolved-*" row is a receiver this pass refuses to`);
console.log(`  attribute to a tag it cannot prove, not a control it has classified. Slice B's unresolved`);
console.log(`  rows therefore MIX genuine non-form controls with form controls declared in another file`);
console.log(`  or destructured out of a panel object, so ${listenerBlind.filter((r) => r.interactive).length} is an UPPER bound on slice B and the`);
console.log(`  resolved-non-form-control count is its lower bound. Hand resolution of the unresolved rows`);
console.log(`  is recorded separately, outside this script.`);
console.log(`  Still out of scope entirely: canvas hit-testing in screens/map, where the hit target is a`);
console.log(`  coordinate rather than an element and there is nothing for a row to point at.`);
console.log(`  None of these controls has a row in the action catalogue; extending the key scheme to give`);
console.log(`  them one is a design decision, not a measurement, and this script does not make it.`);
console.log(`\nWrote ${OUT_JSONL}\n`);

if (PUBLISH) announceOutsideWrites("[non-form-handler-census]", WORKSPACE, [OUT_JSONL]);
else announceOutsideWritesHeld("[non-form-handler-census]", [OUT_JSONL]);
