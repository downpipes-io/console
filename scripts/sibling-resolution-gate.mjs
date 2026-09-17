#!/usr/bin/env node
// A check that resolves a SIBLING REPO must do it through the one resolver, not by guessing.
//
// WHAT THIS REFUSES, and why each shape is here rather than assumed harmless.
//
// 1. AN UNBOUNDED CLIMB. A loop that walks parent directories looking for a marker does not stop at the
//    edge of this checkout, because there is no such edge on the filesystem. Run from a scratch worktree
//    it keeps going until it finds *a* directory of the right name, however unrelated, and reports that
//    checkout's numbers as this one's, which can land on a stray symlink or an unrelated directory left
//    over in a shared scratch area and produce a plausible, wrong figure that nothing distinguishes from a
//    real one.
//
// 2. AN UNCONDITIONAL SIBLING GUESS. join(CONSOLE_ROOT, "..", "internal-docs") asserts that this
//    checkout's parent IS the workspace root. That is true of the primary checkout and false of every
//    worktree, and multiple console worktrees typically exist side by side. It is worst in a WRITER,
//    because mkdirSync({ recursive: true }) turns a wrong guess into a brand-new tree rather than an
//    error: a census script can exit 0 having written a full census into a decoy internal-docs beside a
//    worktree, or into a directory it created from nothing, while the committed artefact never moves. A
//    census that invents its own destination cannot report that it has none. This gate exists to stop
//    that happening a third time.
//
// THE RULE. Under scripts/ and test/, a path that leaves this repo and names a sibling repo must come
// from findWorkspaceDir (scripts/workspace-root.mjs) for workspace siblings, or from engineRoot /
// DOWNPIPES_ENGINE for the engine, which test/engine-root.ts already resolves by known locations. Those
// are the two answers to "where is it"; a third hand-rolled one is what makes it possible for the
// .worktrees guard to be lost from every copy in one edit, without anyone noticing.
//
// WHY IT IS NOT scripts/sibling-read-gate.mjs. That gate asks a different and weaker question: is a check
// POINTABLE, can a caller aim it at a known engine checkout. It is deliberately engine-only and it accepts
// a hand-rolled candidate list. This one asks whether the resolution can silently land on the WRONG tree,
// which a pointable-but-hand-rolled resolver still can. Both rules are wanted; neither implies the other.
//
// This gate reads only its own repo, so it can always run. The one way it could pass hollow is by scanning
// nothing, which the floor below refuses.
//
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN = ["scripts", "test"];

// The resolver itself, the test that holds it, and this gate. None can be asked to import the thing it is.
const SELF = new Set([
  "scripts/workspace-root.mjs",
  "scripts/sibling-resolution-gate.mjs",
  "scripts/sibling-read-gate.mjs",
  "test/validate-r30-workspace-resolution.ts",
  "test/engine-root.ts",
]);

// A path that leaves this repo and names a sibling repo, in the shapes this repo writes them:
//   join(X, "..", "internal-docs")            the pieces handed to join
//   "../../engine/src"                        a literal path segment
//
// JUDGED PER OCCURRENCE, NOT PER FILE, and that distinction is the gate. A file-level exemption that
// excuses any file importing a resolver anywhere in it stays green even when a hardcoded sibling path is
// reinstated elsewhere in the same file, such as `join(CONSOLE_ROOT, "..", "internal-docs",
// "FIELD-CATALOGUE")` in field-census.mjs, because the file still carries the resolver import. That is the
// same failure mode that can lose a guard from every copy of a repaired resolver in one edit while every
// import stays in place. A file-level exemption grades intent; only the occurrence can be graded.
//
// Note that the sanctioned shapes do not match: join(WORKSPACE, "internal-docs", "HOOK-CENSUS") has no
// "..", and join("internal-docs", "FIELD-CATALOGUE", "catalogue.jsonl") as a relative marker has none
// either. The pattern needs a ".." adjacent to a sibling repo name, which is the guess and nothing else.
// WORKSPACE SIBLINGS ONLY, and the engine deliberately excluded. This is not a convenience carve-out, it
// is the split scripts/workspace-root.mjs states in its own header: the engine is found by trying known
// LOCATIONS, while the workspace root is found by stepping OUT of whatever nesting this checkout sits in,
// and the two rule sets do not usefully merge. The engine's resolution already has a resolver family
// (test/engine-root.ts, test/engine-path.ts) and its own gate (scripts/sibling-read-gate.mjs) enforcing
// that every caller is POINTABLE at a known checkout. Those callers take DOWNPIPES_ENGINE first and
// exclusively, then a BOUNDED candidate list, which is not the defect here. Demanding findWorkspaceDir of
// them would break a working resolution to satisfy a gate about resolution.
//
// The UNBOUNDED CLIMB half below is NOT scoped this way and applies to every sibling including the engine,
// because an unbounded climb is wrong whatever it is looking for.
const SIBLING = "(internal-docs|harness|control-plane|docs|website)";
const GUESS = new RegExp(
  `["'\`]\\.\\.["'\`]\\s*,\\s*(["'\`]\\.\\.["'\`]\\s*,\\s*)*["'\`]${SIBLING}["'\`]` +
    `|["'\`][^"'\`\\n]*\\.\\.\\/(\\.\\.\\/)*${SIBLING}(\\/|["'\`])`,
);

// An ES import of sibling source is exempt, and only an import. The module loader resolves it, so a wrong
// path is a hard MODULE_NOT_FOUND at startup rather than a quiet wrong answer, which is the opposite of
// this defect: it fails loudly and cannot be mistaken for a clean run.
const IMPORT_LINE = /^\s*(import|export)\s[^\n]*from\s*["'`]|^\s*import\s*\(/;

// THE UNBOUNDED CLIMB, JUDGED PER OCCURRENCE.
//
// A fixed-width text window between the loop header and the reassignment cannot see a real climb whose
// body contains a marker probe and an early return before the same parent step, because that shape does
// not fit inside a short window, while a toy one-line loop (`while (dir !== "/") dir = dirname(dir);`)
// does. Widening the window to a bigger number is the same defect with a bigger number, so the loop body
// is delimited by BRACE MATCHING instead, and neither its length nor its contents decide anything.
//
// WHAT COUNTS AS A PARENT STEP. An assignment of a variable to its own parent: X = dirname(...),
// X = join(X, ".."), X = resolve(X, ".."), X = `${X}/..` and X += "/..". A DECLARATION is not a step: a
// fresh binding each iteration cannot accumulate parent steps, and refusing to count one is what keeps a
// work queue that calls dirname on the item it has just popped out of this rule.
//
// WHAT BOUNDS ONE, and nothing else does:
//   A STEP COUNTER. A variable the loop both moves (++, --, += or -=) and compares, which caps the walk
//   whether the limit is written as a literal or as a named constant.
//   A FINITE COLLECTION. A for..of or for..in header, where the collection's length is the cap.
//   A KNOWN-ROOT STOP. An equality or a startsWith against a named boundary the loop does not itself
//   reassign. `while (dir !== stopAt)` stops at a root the caller knows. `while (dir !== "/")` and
//   `while (dir !== parse(dir).root)` stop at the FILESYSTEM root, which is the defect rather than a bound,
//   so a string literal is refused and so is a call result. A comparand the loop reassigns is refused too,
//   because the `while (dir !== last)` fixpoint idiom walks out to the filesystem root just as surely.
// A marker probe is NOT a bound. existsSync of a marker under dir is precisely the hazard: it stops at the
// first such directory anywhere above, which from a scratch worktree is a stranger's checkout.
//
// The innermost enclosing loop is the one graded, because that is the loop whose iteration count multiplies
// the parent steps. A bounded inner walk re-seeded by an unbounded outer loop is still a bounded walk.

const KEYWORD_BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "do",
  "else",
  "yield",
  "await",
  "void",
  "delete",
  "instanceof",
  "new",
  "throw",
]);

// One pass that blanks comments and masks literal interiors, character for character, so every offset and
// line number stays true. Two texts come out. `code` keeps string contents, which the sibling-name check
// above needs to read. `shape` keeps only "." and "/" inside a literal, so a brace, a bracket, a quote or a
// semicolon written inside a string or a regex cannot be mistaken for program structure, while `".."`
// survives intact for the parent-step patterns. Scanning rather than regex-stripping also fixes a smaller
// hole in the old stripper: it read a "//" inside a string as the start of a comment unless a colon
// happened to precede it, and it collapsed block comments, which slid every later line number.
function scanSource(src) {
  const code = new Array(src.length);
  const shape = new Array(src.length);
  const blank = (i) => {
    code[i] = src[i] === "\n" ? "\n" : " ";
    shape[i] = code[i];
  };
  const keep = (i) => {
    code[i] = src[i];
    shape[i] = src[i];
  };
  const inside = (i) => {
    code[i] = src[i];
    shape[i] = src[i] === "\n" || src[i] === "." || src[i] === "/" ? src[i] : "#";
  };

  const n = src.length;
  const templates = []; // brace depth at which each open template resumes
  let braceDepth = 0;
  let word = "";
  let lastTok = "";
  let i = 0;

  const readQuoted = (start, quote) => {
    keep(start);
    let j = start + 1;
    while (j < n && src[j] !== quote && src[j] !== "\n") {
      if (src[j] === "\\" && j + 1 < n) {
        inside(j);
        inside(j + 1);
        j += 2;
        continue;
      }
      inside(j);
      j += 1;
    }
    if (j < n && src[j] === quote) {
      keep(j);
      j += 1;
    }
    return j;
  };

  // Reads template chunks from j. Returns the index after the closing backtick, or hands control back to
  // code at a "${", having recorded the depth the template resumes at.
  const readTemplate = (start) => {
    let j = start;
    while (j < n) {
      if (src[j] === "\\" && j + 1 < n) {
        inside(j);
        inside(j + 1);
        j += 2;
        continue;
      }
      if (src[j] === "`") {
        keep(j);
        return j + 1;
      }
      if (src[j] === "$" && src[j + 1] === "{") {
        keep(j);
        keep(j + 1);
        templates.push(braceDepth);
        braceDepth += 1;
        return j + 2;
      }
      inside(j);
      j += 1;
    }
    return j;
  };

  const readRegex = (start) => {
    keep(start);
    let j = start + 1;
    let inClass = false;
    while (j < n && src[j] !== "\n") {
      if (src[j] === "\\" && j + 1 < n) {
        inside(j);
        inside(j + 1);
        j += 2;
        continue;
      }
      if (src[j] === "[") inClass = true;
      else if (src[j] === "]") inClass = false;
      else if (src[j] === "/" && !inClass) {
        keep(j);
        j += 1;
        while (j < n && /[a-z]/.test(src[j])) {
          keep(j);
          j += 1;
        }
        return j;
      }
      inside(j);
      j += 1;
    }
    return j;
  };

  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") {
        blank(i);
        i += 1;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      while (i < stop) {
        blank(i);
        i += 1;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      i = readQuoted(i, c);
      lastTok = c;
      word = "";
      continue;
    }
    if (c === "`") {
      keep(i);
      i = readTemplate(i + 1);
      lastTok = "`";
      word = "";
      continue;
    }
    if (c === "}" && templates.length > 0 && braceDepth - 1 === templates[templates.length - 1]) {
      keep(i);
      braceDepth -= 1;
      templates.pop();
      i = readTemplate(i + 1);
      lastTok = "`";
      word = "";
      continue;
    }
    const effective = word || lastTok;
    if (c === "/" && (effective === "" || /^[-+*/%=<>!&|^~?:;,({[]$/.test(effective) || KEYWORD_BEFORE_REGEX.has(effective))) {
      i = readRegex(i);
      lastTok = "/";
      word = "";
      continue;
    }
    if (c === "{") braceDepth += 1;
    if (c === "}") braceDepth -= 1;
    keep(i);
    if (/[\w$]/.test(c)) {
      word += c;
    } else {
      if (word !== "") lastTok = word;
      word = "";
      if (!/\s/.test(c)) lastTok = c;
    }
    i += 1;
  }
  return { code: code.join(""), shape: shape.join("") };
}

// The index of the delimiter that closes the one at `open`, or -1. Safe on masked text, where no delimiter
// can be hiding in a string.
function matchDelimiter(src, open, closeChar) {
  const openChar = src[open];
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === openChar) depth += 1;
    else if (src[i] === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Every loop in the masked source, as { kind, header, body, start, end }. Offsets are into the masked text,
// which is the same length as the original, so a line number taken from one is true of the other.
function loops(src) {
  const found = [];
  const consumed = new Set(); // the `while` of a do..while, already accounted for by the `do`
  for (const m of src.matchAll(/\b(for|while|do)\b/g)) {
    const kw = m[1];
    const at = m.index;
    if (consumed.has(at)) continue;
    if (kw === "do") {
      const body = readBody(src, at + 2);
      if (body === null) continue;
      // The `while` that closes a do..while belongs to this loop, so it must not be read again as the head
      // of a fresh one whose body is whatever statement follows.
      const tail = /^(\s*)while\s*\(/.exec(src.slice(body.end));
      let header = "";
      let end = body.end;
      if (tail !== null) {
        consumed.add(body.end + tail[1].length);
        const paren = body.end + tail[0].length - 1;
        const close = matchDelimiter(src, paren, ")");
        if (close !== -1) {
          header = src.slice(paren + 1, close);
          end = close + 1;
        }
      }
      found.push({ kind: "do", header, body: src.slice(body.start, body.end), bodyStart: body.start, start: at, end });
      continue;
    }
    const paren = src.indexOf("(", at);
    if (paren === -1 || src.slice(at + kw.length, paren).trim() !== "") continue;
    const close = matchDelimiter(src, paren, ")");
    if (close === -1) continue;
    const body = readBody(src, close + 1);
    if (body === null) continue;
    found.push({
      kind: kw,
      header: src.slice(paren + 1, close),
      body: src.slice(body.start, body.end),
      bodyStart: body.start,
      start: at,
      end: body.end,
    });
  }
  return found;
}

// The loop body starting at or after `from`: a braced block, or the single statement up to the semicolon
// that ends it. Brace and paren matching, so the body's size is irrelevant.
function readBody(src, from) {
  let i = from;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  if (i >= src.length) return null;
  if (src[i] === "{") {
    const close = matchDelimiter(src, i, "}");
    if (close === -1) return null;
    return { start: i + 1, end: close };
  }
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    const c = src[j];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === ";" && depth === 0) return { start: i, end: j };
  }
  return { start: i, end: src.length };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DECLARED = /\b(?:const|let|var)\s+$/;
// A step in three writings. Each captures the variable it moves, and each is refused when the text just
// before it declares that variable rather than reassigning one.
const STEP_PATTERNS = [
  { why: "dirname()", re: /\b([A-Za-z_$][\w$]*)\s*=(?![=>])\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?dirname\s*\(/g },
  { why: "a parent segment", re: /\b([A-Za-z_$][\w$]*)\s*=(?![=>])\s*[^;\n]*?\b\1\b[^;\n]*?\.\.\s*(?:["'`]|\/)/g },
  { why: "a parent segment", re: /\b([A-Za-z_$][\w$]*)\s*\+=\s*[^;\n]*?\.\.\s*(?:["'`]|\/)/g },
];

// TWO WRITINGS THE PATTERNS ABOVE CANNOT SEE ON THEIR OWN:
//
//   THE CLIMB THROUGH A DECLARATION.  const parent = dirname(dir); if (parent === dir) return null; dir = parent;
//   THE CLIMB BEHIND A HELPER.        const up = (p) => dirname(p);  ...  dir = up(dir);
//
// Neither is exotic. The first is how anyone writes a walk that wants to test the parent before taking it,
// which is most of them, and the second is what happens the moment the step is factored out. A rule that
// misses them is not a weaker version of the rule, it is a rule that fires on the toy and passes the code.
//
// WHY THE DECLARATION EXCLUSION STAYS. `const parent = dirname(dir)` on its own is still not a step, and
// refusing to count it is what keeps a work queue that calls dirname on the item it popped out of this rule.
// What makes it a step is the ASSIGNMENT BACK: the same loop writes that fresh binding into the variable it
// was derived from, and now the variable does accumulate parent steps. So the pair is graded, not either half,
// and the occurrence reported is the assignment, which is where the accumulation happens.
//
// The parent-step expressions, shared by both: dirname(X), join(X, ".."), resolve(X, ".."), `${X}/..`.
const parentOfPattern = (v) => {
  const n = esc(v);
  return new RegExp(
    `^\\s*(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)?dirname\\s*\\(\\s*${n}\\s*\\)\\s*$` +
      `|^\\s*(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)?(?:join|resolve)\\s*\\(\\s*${n}\\s*,\\s*["'\`]\\.\\.["'\`]\\s*\\)\\s*$` +
      `|^\\s*\`[^\`]*\\$\\{\\s*${n}\\s*\\}[./#]*\\.\\.[^\`]*\`\\s*$` +
      `|^\\s*${n}\\s*\\+\\s*["'\`][./#]*\\.\\.["'\`]\\s*$`,
  );
};

// Every alias pair `const TMP = <parent of VAR>` ... `VAR = TMP` inside `body`, as offsets relative to it.
function aliasSteps(body) {
  const out = [];
  const aliases = new Map(); // TMP -> VAR
  for (const m of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?![=>])([^;\n]*)/g)) {
    const rhs = m[2];
    const varMatch = /\b([A-Za-z_$][\w$]*)\b/.exec(rhs.replace(/^\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?(?:dirname|join|resolve)\s*\(/, ""));
    if (varMatch === null) continue;
    if (parentOfPattern(varMatch[1]).test(rhs)) aliases.set(m[1], varMatch[1]);
  }
  if (aliases.size === 0) return out;
  for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*=(?![=>])\s*([A-Za-z_$][\w$]*)\s*(?:;|$|\n)/gm)) {
    if (DECLARED.test(body.slice(Math.max(0, m.index - 12), m.index))) continue;
    if (aliases.get(m[2]) === m[1]) {
      out.push({ at: m.index, why: `${m[1]} = a parent segment, taken through the declaration of ${m[2]},` });
    }
  }
  return out;
}

// The names in this file that ARE a parent step: a one-expression helper returning the parent of its own
// parameter. Only such a name is followed, so `dir = normalise(dir)` is not guessed at.
function parentHelpers(shape) {
  const names = new Set();
  for (const m of shape.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?![=>])\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*\)|([A-Za-z_$][\w$]*))\s*=>\s*([^;\n]*)/g)) {
    const param = m[2] ?? m[3];
    if (param !== undefined && parentOfPattern(param).test(m[4])) names.add(m[1]);
  }
  for (const m of shape.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{\s*return([^;}]*)/g)) {
    if (parentOfPattern(m[2]).test(m[3])) names.add(m[1]);
  }
  return names;
}

// True when the comparison at `idx` guards a statement that leaves the loop. The nearest enclosing `if`
// condition is found by paren matching backwards, so a comparison written inside a larger condition still
// resolves to the `if` it belongs to.
function stopsLoop(body, idx) {
  for (let i = idx; i >= 0; i -= 1) {
    if (body[i] !== "(") continue;
    const close = matchDelimiter(body, i, ")");
    if (close === -1 || close < idx) continue;
    if (!/\bif\s*$/.test(body.slice(Math.max(0, i - 12), i))) continue;
    const cons = readBody(body, close + 1);
    if (cons === null) return false;
    return /\b(?:break|return|throw)\b|process\s*\.\s*exit/.test(body.slice(cons.start, cons.end));
  }
  return false;
}

// The bound this loop puts on the number of parent steps, or null when it puts none on it.
function boundOn(loop) {
  const ctx = `${loop.header}\n${loop.body}`;
  if (loop.kind === "for" && !loop.header.includes(";") && /\s(?:of|in)\s/.test(loop.header)) {
    return "a finite collection";
  }
  const moved = new Set();
  for (const re of [/\b([A-Za-z_$][\w$]*)\s*(?:\+\+|--)/g, /(?:\+\+|--)\s*([A-Za-z_$][\w$]*)/g, /\b([A-Za-z_$][\w$]*)\s*[+-]=/g]) {
    for (const m of ctx.matchAll(re)) moved.add(m[1]);
  }
  // A COUNTER ONLY BOUNDS THE WALK IF THE COMPARISON CAN END IT. A counter that is moved and compared
  // ANYWHERE in the loop, whatever the comparison is for, does not bound a real climb: `while (true)` with
  // `probes += 1; if (probes > 3) console.log(...)` beside a plain `dir = dirname(dir)` is not bounded, and
  // a progress log is not a limit. So the comparison must sit in the loop HEADER, where it decides whether
  // the next iteration runs, or guard a break, a return or a throw.
  for (const name of moved) {
    const n = esc(name);
    const cmp = new RegExp(`\\b${n}\\b\\s*(?:\\+\\+|--)?\\s*[<>]=?[^=]|[<>]=?\\s*\\b${n}\\b`, "g");
    if (new RegExp(cmp.source).test(loop.header)) return "a step counter";
    for (const m of loop.body.matchAll(cmp)) {
      if (stopsLoop(loop.body, m.index)) return "a step counter";
    }
  }
  const reassigned = (name) => new RegExp(`\\b${esc(name)}\\b\\s*(?:=(?![=>])|\\+\\+|--|\\+=|-=)`).test(ctx);
  const rootish = (ref) => {
    const last = ref.split(".").pop();
    return last === "sep" || last === "delimiter";
  };
  const refs = [
    /(?:===|!==|==|!=)\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?![\w$.(])/g,
    /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?![\w$.(])\s*(?:===|!==|==|!=)/g,
    /\.startsWith\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)/g,
  ];
  for (const re of refs) {
    for (const m of ctx.matchAll(re)) {
      const ref = m[1].replace(/\s+/g, "");
      if (rootish(ref)) continue;
      if (reassigned(ref.split(".")[0])) continue;
      return `a stop at ${ref}`;
    }
  }
  return null;
}

const lineAt = (src, idx) => 1 + (src.slice(0, idx).match(/\n/g) || []).length;

// Every parent step in this file that sits inside a loop nothing bounds, as { line, why }.
function unboundedClimbs(shape) {
  const spans = loops(shape);
  // Every parent step in the file, as { at, why }, before anything is asked about where it sits.
  const steps = [];
  for (const { why, re } of STEP_PATTERNS) {
    for (const m of shape.matchAll(re)) {
      if (DECLARED.test(shape.slice(Math.max(0, m.index - 12), m.index))) continue;
      steps.push({ at: m.index, why: `${m[1]} = ${why}` });
    }
  }
  const helpers = parentHelpers(shape);
  if (helpers.size > 0) {
    const names = [...helpers].map(esc).join("|");
    const re = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*=(?![=>])\\s*(?:${names})\\s*\\(\\s*\\1\\s*\\)`, "g");
    for (const m of shape.matchAll(re)) {
      if (DECLARED.test(shape.slice(Math.max(0, m.index - 12), m.index))) continue;
      steps.push({ at: m.index, why: `${m[1]} = a parent segment, taken behind a helper,` });
    }
  }
  // Alias pairs are read per loop body, because the declaration and the assignment back have to share one.
  const seen = new Set(steps.map((s) => s.at));
  for (const l of spans) {
    for (const a of aliasSteps(l.body)) {
      const at = l.bodyStart + a.at;
      if (seen.has(at)) continue;
      seen.add(at);
      steps.push({ at, why: a.why });
    }
  }
  const out = [];
  for (const s of steps) {
    const enclosing = spans.filter((l) => s.at >= l.start && s.at < l.end).sort((a, b) => b.start - a.start)[0];
    if (enclosing === undefined) continue;
    if (boundOn(enclosing) !== null) continue;
    out.push({ line: lineAt(shape, s.at), why: `${s.why} inside a ${enclosing.kind} loop with no step limit and no known-root stop` });
  }
  return out.sort((a, b) => a.line - b.line);
}

function files() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") || p.endsWith(".mjs")) out.push(relative(ROOT, p));
    }
  };
  // A scan tree that is not there must be REFUSED by name, not left to readdir. An ENOENT stack also exits
  // non-zero, so a mutation test that reads only the exit code would score the crash as a kill and the
  // floor below would never be reached to say what was actually wrong.
  for (const d of SCAN) {
    const p = join(ROOT, d);
    if (!existsSync(p)) {
      console.error(`FAIL sibling-resolution: ${d}/ is missing from this checkout, so there is nothing to scan.`);
      process.exit(1);
    }
    walk(p);
  }
  return out.sort();
}

const scanned = files();
// A gate that scans nothing reads exactly like a passing gate.
if (scanned.length < 100) {
  console.error(`FAIL sibling-resolution: expected this repo's checks, found only ${scanned.length} files. Has the layout moved?`);
  process.exit(1);
}

const guesses = [];
const climbs = [];
for (const f of scanned) {
  if (SELF.has(f)) continue;
  // Comments describe this defect at length in several of these files. Reading prose as code would make the
  // documentation of the fix indistinguishable from the defect.
  const { code, shape } = scanSource(readFileSync(join(ROOT, f), "utf8"));
  for (const c of unboundedClimbs(shape)) climbs.push(`${f}:${c.line}  ${c.why}`);
  code.split("\n").forEach((line, i) => {
    if (!GUESS.test(line) || IMPORT_LINE.test(line)) return;
    guesses.push(`${f}:${i + 1}`);
  });
}

if (climbs.length > 0 || guesses.length > 0) {
  console.error(`FAIL sibling-resolution: ${climbs.length + guesses.length} site(s) resolve a sibling repo by guessing.\n`);
  for (const f of climbs) console.error(`  UNBOUNDED CLIMB     ${f}`);
  for (const f of guesses) console.error(`  UNCONDITIONAL GUESS ${f}`);
  console.error(
    `\nImport { findWorkspaceDir } from ./workspace-root.mjs for a workspace sibling (internal-docs, docs,\n` +
      `harness), or engineRoot / DOWNPIPES_ENGINE for the engine, and refuse at exit 2 when it returns null.\n` +
      `A hand-rolled walk cannot tell this checkout's siblings from a stranger's: it has no floor at the\n` +
      `checkout edge, and .worktrees is exactly where a stale copy of a sibling lingers. A gate that answers\n` +
      `confidently from the wrong tree is worse than one that fails, because its answer gets believed and\n` +
      `re-confirmed. See R-30 and scripts/workspace-root.mjs.`,
  );
  process.exit(1);
}

console.log(`OK sibling-resolution: ${scanned.length} file(s) scanned, every sibling-repo path routed through a resolver.`);
