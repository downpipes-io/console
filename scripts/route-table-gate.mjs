#!/usr/bin/env node
// Route-table drift gate.
//
// THE DEFECT THIS CATCHES. A hand-maintained route list can silently fall out of step with the routes the
// screens actually declare, because nothing compares the two. The router does not bind from a hand list at
// all: app.ts binds via screenRoutes(SCREENS, ...), reading each screen module's own `route:` field. The
// live route set is therefore derived FROM the screens' descriptors (src/lib/app-registry.ts, ROUTES), so
// it cannot independently drift the way a hand-typed copy can.
//
// WHY THIS GATE IS NOT VACUOUS. A gate that re-derives its own "expected" value the same way the thing
// under test derives its value proves nothing: both move together by construction. This gate instead
// re-derives the route set a SECOND way -- a static text scan of every src/screens/**/*.ts file's
// `route:` field, independent of module evaluation and of app-registry.ts's own flatMap -- and compares
// that against the live imported ROUTES. This catches the two failure modes a same-path check cannot:
// (a) a screen file exists on disk with a `route:` field but was never added to the SCREENS array in
//     app-registry.ts, so its route is never bound (present in the static scan, absent from the live set);
// (b) a stale or malformed entry in app-registry.ts's derivation that no longer matches what is on disk
//     (present in the live set, absent from the static scan).
// It additionally ratchets the total against EXPECTED_ROUTE_COUNT below (the same "raise the floor when
// it moves" pattern already used elsewhere in this repo, e.g. DRIVEN_FLOOR), which is what makes the
// mutation test in the header comment of this file's test companion meaningful: adding a route to an
// EXISTING, already-wired screen flows into both the static scan and the live import together (nothing
// to disagree on), but it also raises the true count past the frozen expected number, so the gate goes
// red until a human consciously bumps EXPECTED_ROUTE_COUNT -- the same discipline a hand-maintained table
// was supposed to provide, minus the possibility of forgetting to touch the SCREEN's own descriptor.
//
// FAILS LOUD, NEVER QUIET. This gate exits non-zero (not "skip", not a silent pass) when it cannot read
// the screens directory, when the static scan finds zero screens, when the live import throws or yields
// zero routes, or when it meets an expression shape in a `route:` field it does not know how to resolve.
// A route-table gate that quietly reports "0 checked, 0 problems" on a broken run is the exact shape of
// guard this file exists to replace.
//
// Run with: node scripts/route-table-gate.mjs (wired into `npm run lint`).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = resolve(HERE, "..");
const SCREENS_DIR = resolve(CONSOLE_ROOT, "src/screens");

// The tracked total. A change to this number must be a DELIBERATE edit reviewing what moved and why,
// exactly like this repo's DRIVEN_FLOOR ratchets: raise it when a route is legitimately added or removed,
// never to silence a failure you have not looked at.
const EXPECTED_ROUTE_COUNT = 53;

let failed = false;
function fail(msg) {
  console.error(`ROUTE TABLE GATE: FAIL -- ${msg}`);
  failed = true;
}
function hardFail(msg) {
  console.error(`ROUTE TABLE GATE: FAIL -- ${msg}`);
  console.error("  This gate exits non-zero rather than skipping: a route-table check that cannot run must");
  console.error("  never read as a pass.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Collect every *.ts file under src/screens, recursively.
// ---------------------------------------------------------------------------
function listTsFiles(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (/** @type {any} */ e) {
    hardFail(`could not read ${relative(CONSOLE_ROOT, dir)} (${e.message})`);
  }
  for (const entry of /** @type {import("node:fs").Dirent[]} */ (entries)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(listTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

if (!statSyncSafe(SCREENS_DIR)) {
  hardFail(`src/screens does not exist at ${SCREENS_DIR}`);
}
function statSyncSafe(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

const screenFiles = listTsFiles(SCREENS_DIR);
if (screenFiles.length === 0) {
  hardFail("found zero .ts files under src/screens -- nothing to check, which is itself a failure");
}

// ---------------------------------------------------------------------------
// 2. Build a global symbol table of UPPER_SNAKE string constants (route identifiers), scanning every
//    file's source text for `const NAME = "literal";` / `const NAME = 'literal';`, exported or not. This
//    resolves identifiers a `route:` field references (ROUTE_KEYS, MAP_ROUTE, ROUTE_AUDIT, ...) regardless
//    of which sibling file actually defines them.
// ---------------------------------------------------------------------------
const CONST_RE = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*(["'])((?:\\.|(?!\2).)*)\2\s*;/g;
const symbols = new Map(); // NAME -> { value, file }
const fileText = new Map();

for (const file of screenFiles) {
  const text = readFileSync(file, "utf8");
  fileText.set(file, text);
  for (const m of text.matchAll(CONST_RE)) {
    const [, name, , value] = m;
    if (symbols.has(name) && symbols.get(name).value !== value) {
      fail(
        `the identifier ${name} is defined twice with different values ` +
          `(${symbols.get(name).file} = ${JSON.stringify(symbols.get(name).value)}, ` +
          `${relative(CONSOLE_ROOT, file)} = ${JSON.stringify(value)}) -- a route: field referencing it is ambiguous`,
      );
    }
    symbols.set(name, { value, file: relative(CONSOLE_ROOT, file) });
  }
}

function resolveIdentifier(name, ctxFile) {
  const hit = symbols.get(name);
  if (!hit) {
    fail(`${relative(CONSOLE_ROOT, ctxFile)}: route: field references ${name}, which no screens file defines as a string constant`);
    return null;
  }
  return hit.value;
}

// resolveExpr resolves a single trimmed route: element (a string literal, a template literal built from
// identifiers + literal text, or a bare identifier) to its string value, or null with a recorded failure
// if the shape is not one of those (an unresolved shape must FAIL, never be silently dropped).
function resolveExpr(expr, ctxFile) {
  const e = expr.trim();
  const plain = e.match(/^(["'])((?:\\.|(?!\1).)*)\1$/);
  if (plain) return plain[2];
  const tmpl = e.match(/^`([^`]*)`$/);
  if (tmpl) {
    const body = tmpl[1];
    let out = "";
    let i = 0;
    while (i < body.length) {
      if (body[i] === "$" && body[i + 1] === "{") {
        const close = body.indexOf("}", i + 2);
        if (close === -1) {
          fail(`${relative(CONSOLE_ROOT, ctxFile)}: unterminated \${...} in template literal route: "${e}"`);
          return null;
        }
        const ident = body.slice(i + 2, close).trim();
        const val = resolveIdentifier(ident, ctxFile);
        if (val === null) return null;
        out += val;
        i = close + 1;
      } else {
        out += body[i];
        i++;
      }
    }
    return out;
  }
  const ident = e.match(/^[A-Z][A-Za-z0-9_]*$/);
  if (ident) return resolveIdentifier(e, ctxFile);
  fail(`${relative(CONSOLE_ROOT, ctxFile)}: route: field has an expression shape this gate cannot resolve: "${e}"`);
  return null;
}

// splitTopLevel splits `text` on commas that are not nested inside (), [], {}, or a string/template
// literal, so an array literal's elements are separated correctly regardless of formatting.
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let cur = "";
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === "\\") {
        cur += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      cur += c;
      i++;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim() !== "") parts.push(cur);
  return parts;
}

// extractBalanced walks forward from `start` (the index right after "route:"), tracking bracket depth and
// string state, and returns the substring up to (exclusive of) the top-level terminating "," or "}".
function extractBalanced(text, start) {
  let depth = 0;
  let quote = null;
  let i = start;
  const begin = start;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return text.slice(begin, i);
      depth--;
      i++;
      continue;
    }
    if (c === "," && depth === 0) {
      return text.slice(begin, i);
    }
    i++;
  }
  fail(`unterminated route: field starting at offset ${begin}`);
  return text.slice(begin);
}

// stripLineComments removes `// ...` comments so they cannot be mistaken for content when the captured
// route: text spans multiple lines with trailing inline comments.
function stripLineComments(text) {
  return text
    .split("\n")
    .map((line) => {
      // Naive but safe in this narrow context (a route: value never legitimately contains "//"): cut at
      // the first "//" not inside a quote. Route strings are plain paths/params, so this never misfires.
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === "\\") {
            i++;
            continue;
          }
          if (c === quote) quote = null;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") {
          quote = c;
          continue;
        }
        if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// 3. Statically find every Screen descriptor's route: field (independent of module evaluation): a
//    `defineScreen({ ... })` call or a `: Screen = { ... }` literal, each scanned only for a route: key at
//    the OUTER object's own depth, so a nested `route:` inside an unrelated shape (e.g. a per-tab { id,
//    label, route } array some screens carry for their own sub-nav) is never mistaken for the descriptor.
// ---------------------------------------------------------------------------

// blankComments replaces every comment's characters with spaces, keeping newlines and the total LENGTH
// so every offset below still points at the same place in the real file. Both the anchor match and the
// object walk run over the blanked copy, so a comment can neither create a descriptor nor break one.
//
// COMMENT-AS-CODE. Both `//` and `/* ... */` comments are blanked, because a block comment quoting
// `defineScreen({ route: "/x" })` would otherwise enter the derived route set: the descriptor walk cannot
// tell a comment from code once blanking has run, so blanking every comment style first is what stops a
// commented-out descriptor being read as a real one, whichever comment style hides it.
//
// Quote-aware, because screen files are full of "https://..." and of apostrophes inside prose strings,
// and a naive blanker would eat from the "//" of a URL to the end of the line. Template literals are
// tracked as quotes too; their ${...} holes cannot contain a comment that matters here.
//
// REGEX-LITERAL AWARE, and this is not decoration. An apostrophe inside a regex literal (`/it's/`) can
// open a quote state that never closes if regex literals are not recognised, so every comment for the
// rest of that file is left un-blanked and a commented-out descriptor further down reads as real code.
// Two lines of prelude are enough to defeat the blanking if this case is not handled.
//
// A `/` begins a regex literal rather than a division when the previous significant character cannot end
// an expression. That is the standard heuristic and it is deliberately CONSERVATIVE here: guessing regex
// where division was meant blanks nothing (a regex body is skipped, not blanked), while guessing division
// where a regex was meant is the failure above.
//
// AND, because no heuristic covers every shape, the walk asserts its own state at the end: if the file
// ends with a quote or regex still open, the source did not parse the way this function assumed, and the
// caller fails the gate LOUDLY rather than proceeding on a half-blanked copy. This gate's whole posture is
// that a route-table check which cannot run must never read as a pass; a blanker that silently gave up
// halfway is exactly that failure wearing a green tick.
function blankComments(text, file) {
  const out = text.split("");
  let quote = null;
  // The last non-whitespace character seen outside a string, comment or regex. It decides whether the
  // next "/" opens a regex literal (after "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";",
  // "\n" or nothing) or is a division sign (after an identifier character, ")", "]" or a digit).
  let prevSignificant = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; prevSignificant = c; continue; }
    if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < text.length && text[j] !== "\n") { out[j] = " "; j++; }
      i = j - 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      let j = i;
      while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) {
        if (text[j] !== "\n") out[j] = " ";
        j++;
      }
      // blank the closing */ as well, when the file is not truncated mid-comment
      if (j < text.length) { out[j] = " "; out[j + 1] = " "; j += 1; }
      i = j;
      prevSignificant = "/";
      continue;
    }
    if (c === "/" && !/[A-Za-z0-9_$)\]]/.test(prevSignificant)) {
      // A regex literal. Skip its body WITHOUT blanking it: it is real code, and a "/" inside a
      // character class does not end it. An unterminated regex leaves i at end of file, which the
      // end-of-walk assertion below then reports.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < text.length && text[j] !== "\n") {
        const d = text[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        i = j;
        prevSignificant = "/";
        continue;
      }
      // Not a regex after all (an unterminated one cannot be), so fall through and treat it as an
      // ordinary character rather than swallowing the rest of the line.
    }
    if (!/\s/.test(c)) prevSignificant = c;
  }
  if (quote !== null) {
    throw new Error(
      `route-table-gate cannot read ${file}: the comment blanker reached end of file with a ${quote === "`" ? "template literal" : "string"} still open, ` +
        "so comments after that point were not blanked and a commented-out descriptor could be read as real code. " +
        "Fix the source, or teach blankComments the shape it did not understand. This gate fails rather than guessing.",
    );
  }
  return out.join("");
}

const DESCRIPTOR_STARTS = [/defineScreen\(\s*\{/g, /:\s*Screen\s*=\s*\{/g];

const staticRoutes = new Set();
const staticByFile = new Map(); // file -> [routes]
let descriptorsFound = 0;

for (const file of screenFiles) {
  // The blanked copy is what both the anchor and the walk read: same length, same offsets, no comments.
  // Printed in this gate's own voice rather than as a bare stack trace, so the failure reads like every
  // other failure here. The exit is still non-zero, which is the part that matters.
  let text;
  try {
    text = blankComments(fileText.get(file), file);
  } catch (err) {
    console.error(`ROUTE TABLE GATE: FAIL -- ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const found = [];
  for (const re of DESCRIPTOR_STARTS) {
    for (const m of text.matchAll(re)) {
      const objStart = m.index + m[0].length; // index right after the opening "{"
      descriptorsFound++;
      // Walk the object body at depth 1 (relative to its own "{"), looking for a top-level "route:" key.
      let depth = 1;
      let quote = null;
      let i = objStart;
      while (i < text.length && depth > 0) {
        const c = text[i];
        if (quote) {
          if (c === "\\") {
            i += 2;
            continue;
          }
          if (c === quote) quote = null;
          i++;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") {
          quote = c;
          i++;
          continue;
        }
        if (c === "/" && text[i + 1] === "/") {
          const nl = text.indexOf("\n", i);
          i = nl === -1 ? text.length : nl + 1;
          continue;
        }
        if (c === "/" && text[i + 1] === "*") {
          const close = text.indexOf("*/", i + 2);
          i = close === -1 ? text.length : close + 2;
          continue;
        }
        if (depth === 1 && text.startsWith("route", i) && /\s/.test(text[i - 1] ?? "\n")) {
          const after = text.slice(i + 5).match(/^\s*:/);
          if (after) {
            const valueStart = i + 5 + after[0].length;
            const raw = stripLineComments(extractBalanced(text, valueStart)).trim();
            const values = raw.startsWith("[") ? splitTopLevel(raw.slice(1, raw.lastIndexOf("]"))) : [raw];
            for (const v of values) {
              const resolved = resolveExpr(v, file);
              if (resolved !== null) {
                staticRoutes.add(resolved);
                found.push(resolved);
              }
            }
            i += 5 + after[0].length;
            continue;
          }
        }
        if (c === "{" || c === "[" || c === "(") depth++;
        if (c === "}" || c === "]" || c === ")") depth--;
        i++;
      }
    }
  }
  if (found.length > 0) staticByFile.set(relative(CONSOLE_ROOT, file), found);
}

if (descriptorsFound === 0) {
  hardFail("found zero Screen descriptors (defineScreen(...) / `: Screen = {`) under src/screens -- the scan pattern itself may be broken");
}
if (staticRoutes.size === 0) {
  hardFail("found Screen descriptors but resolved zero route: values from them -- nothing to compare, which is itself a failure");
}

// ---------------------------------------------------------------------------
// 4. Import the LIVE, derived route list (app-registry.ts ROUTES), independently of the static scan.
// ---------------------------------------------------------------------------
let liveRoutes;
try {
  const mod = await import(pathToFileURL(resolve(CONSOLE_ROOT, "src/lib/app-registry.ts")).href);
  liveRoutes = mod.ROUTES;
} catch (/** @type {any} */ e) {
  hardFail(`could not import src/lib/app-registry.ts to read the live ROUTES export (${e.message})`);
}
if (!Array.isArray(liveRoutes)) {
  hardFail("src/lib/app-registry.ts does not export ROUTES as an array");
}
if (liveRoutes.length === 0) {
  hardFail("src/lib/app-registry.ts ROUTES is empty -- nothing to compare, which is itself a failure");
}
const liveSet = new Set(liveRoutes);
if (liveSet.size !== liveRoutes.length) {
  fail(`src/lib/app-registry.ts ROUTES contains a duplicate pattern (${liveRoutes.length} entries, ${liveSet.size} distinct)`);
}

// ---------------------------------------------------------------------------
// 5. Compare: the static scan (ground truth on disk) vs the live derived export (what actually binds).
// ---------------------------------------------------------------------------
const staticOnly = [...staticRoutes].filter((r) => !liveSet.has(r)).sort();
const liveOnly = [...liveSet].filter((r) => !staticRoutes.has(r)).sort();

if (staticOnly.length > 0) {
  fail(
    `${staticOnly.length} route(s) are declared on a screen's route: field but are NOT in the live ROUTES export ` +
      `(the screen is likely missing from SCREENS in app-registry.ts):\n    ${staticOnly.join("\n    ")}`,
  );
}
if (liveOnly.length > 0) {
  fail(
    `${liveOnly.length} route(s) are in the live ROUTES export but were NOT found on any screen's route: field on disk ` +
      `(a stale entry, or a route: shape this gate's static scan could not parse):\n    ${liveOnly.join("\n    ")}`,
  );
}

// ---------------------------------------------------------------------------
// 6. Ratchet the total. This is the check a same-path derivation cannot provide on its own: it forces a
//    human to notice and confirm every change in the true route count, in step with the code, exactly the
//    discipline the deleted hand-maintained table was supposed to give (see header comment).
// ---------------------------------------------------------------------------
if (staticOnly.length === 0 && liveOnly.length === 0 && staticRoutes.size !== EXPECTED_ROUTE_COUNT) {
  fail(
    `the route table and the live bound set agree with each other, but the true count is ${staticRoutes.size}, ` +
      `not the tracked EXPECTED_ROUTE_COUNT of ${EXPECTED_ROUTE_COUNT} in scripts/route-table-gate.mjs. ` +
      `If this is a genuine, reviewed route addition/removal, update EXPECTED_ROUTE_COUNT to ${staticRoutes.size}.`,
  );
}

console.log(`ROUTE TABLE GATE: ${descriptorsFound} screen descriptors scanned across ${screenFiles.length} files under src/screens.`);
console.log(`  static (on-disk) route patterns: ${staticRoutes.size}`);
console.log(`  live (app-registry.ts ROUTES) route patterns: ${liveSet.size}`);
console.log(`  tracked EXPECTED_ROUTE_COUNT: ${EXPECTED_ROUTE_COUNT}`);

if (failed) {
  console.error("\nROUTE TABLE GATE: FAIL");
  process.exit(1);
}
console.log("\nROUTE TABLE GATE: PASS -- the on-disk screens and the live bound route set agree, exactly.");
