// Capability-copy gate (npm run lint:capability-copy, chained into npm run lint).
//
// A capability-gated control must name the PERMISSION in customer language (capabilityPhrase(),
// screens/capability-copy.ts), never the raw internal dotted Capability id ("restore.apply",
// "downpipe.write", "roles.write", ...). The id is an engine-side symbol, not a phrase a customer
// would recognise. A validator that only asserts on rendered TEXT misses a leak sitting in a `title`
// ATTRIBUTE, since an attribute is never rendered text. The same class of leak also has a variant: the
// id with its dot flattened to a hyphen or space, sitting directly in front of the literal word
// "capability" ("restore-apply capability", "downpipe write capability").
//
// This gate checks SOURCE TEXT across every .ts file under src, rather than asserting on one rendered
// component at a time (the four dynamic validators' approach, which only covers what someone thought to
// drive through a screen). A new site in a screen no validator ever renders still fails the build here.
//
// WHY THIS READS THE SOURCE WITH A TOKENISER RATHER THAN LINE BY LINE. A scanner that strips comments
// with `line.indexOf("//")` and pulls literals out one line at a time with a same-line-quote regex
// silently passes three shapes, and all three are already common in this tree:
//
//   1. Any literal containing a URL. `"See https://docs.downpipes.io/x about the restore.apply
//      capability."` truncates at the `//` of `https://`, so the scan sees only the first half.
//      140 files under src have a `//` inside a string literal, so this is not a corner case.
//   2. Any MULTI-LINE template literal. A same-line-quote regex yields no literal at all for a template
//      spanning lines, so rules 1 and 3 never run on its text. 10 files under src have multi-line
//      templates.
//   3. Both together in a single-quoted string, same cause as (1).
//
// So the scanner below walks each file character by character with a real mode stack: line comments,
// block comments, single/double-quoted strings, template literals with correctly-nested `${...}`
// interpolations, and regex literals. Regex literals must be understood, not skipped over: this tree
// has regexes containing a single quote, a double quote and even a backtick
// (components/field-bounds.ts's HTTP_HEADER_NAME_PATTERN), any of which would desynchronise a scanner
// that treated `/.../` as ordinary code and leave the rest of the file mis-parsed.
//
// The rules below see the whole of every literal, regardless of line breaks or embedded slashes.
//
//   RULE 1 -- a literal, DOTTED capability id ("restore.apply") appearing in a string literal, outside
//   an interpolation body. A dot practically never occurs in ordinary prose, so this needs no further
//   qualifier: any dotted id in customer-visible text is either the bare id used as a value (excluded:
//   see the bare-token check) or a leak.
//
//   RULE 2 -- a template-literal interpolation `${...}` immediately followed by the bare word
//   "capability" or "permission". This catches a raw Capability-typed variable (or a lookup like
//   SCREEN_WRITE_CAPABILITY[x]) spliced straight into a sentence. Rule 1 cannot see this shape, because
//   the id never appears as literal source text and only exists at runtime, so this rule exists
//   specifically to close that hole. `${capabilityPhrase(x)}` and `${capGateReason(x)}` are never
//   followed by these words in legitimate copy (neither helper's return value contains the literal word
//   "capability"), so no special-casing is needed for them.
//
//   RULE 3 -- a capability id with its dot replaced by a hyphen or space ("restore-apply", "restore
//   apply") immediately followed by the word "capability". This is narrower than "the hyphen/space form
//   anywhere": several capability ids are built from ordinary English words (read, write, apply, request,
//   approve, policy), so "a restore request" or "an Access policy change" are ordinary, CORRECT customer
//   sentences that happen to collide with the space form -- they are not leaks and must not be flagged.
//   What makes a real site bad is the word "capability" stuck on the end, restating the id as a
//   compound noun ("the restore-apply capability") rather than translating it. Requiring that adjacency
//   is what keeps this rule precise.
//
//   RULE 4 -- a HYPHENATED built-in Role id ("restore-operator", "access-admin") inside a longer piece
//   of customer copy. This closes the same gap one level down: the role half of a sentence can be left
//   as the raw engine slug while the product everywhere else writes the display label ("Restore
//   operator", "Access admin"), including in a sentence whose CAPABILITY half is correctly translated,
//   reading "permission to run a recovery drill (an operator, restore-operator, approver or owner)".
//   Only the two hyphenated role ids are checked: "viewer", "operator", "approver" and "owner" are
//   ordinary English words that appear correctly in prose hundreds of times, and a rule over them would
//   be all false positives. The bare id on its own is excluded as a value, exactly as in rules 1 and 3.
//
// An interpolation body is never treated as prose: the scanner replaces each `${...}` with a single NUL
// sentinel in the literal's text, so RULE 1 cannot mistake the "restore.apply" inside a
// capabilityPhrase("restore.apply") call for something the customer reads, while RULE 2 can still see
// exactly where an interpolation sat. Strings written inside an interpolation body are scanned in their
// own right, as the literals they are.
//
// SELF-TEST. The gate runs its own fixtures through the same scanner and the same rules on every
// invocation, and fails if a shape it is supposed to catch stops being caught, or if a legitimate
// sentence starts being flagged. A check that reads as finished while a leaking site remains is the
// exact failure this gate exists to close, so a gate that quietly loses its teeth is the failure mode
// most worth refusing.
//
// Known limitation, stated rather than hidden: a Capability variable spliced into a sentence with
// NEITHER "capability"/"permission" nearby (Rule 2's trigger) NOR its literal dotted form (Rule 1) is not
// caught by any rule here -- there is no way to know a bare interpolated variable is Capability-typed
// without a type checker, and this is a text scan, not one. That shape exists deliberately in
// identity-custom-roles.ts's validateCustomRole (the byte-for-byte engine mirror; see ALLOWLIST) and is
// left untranslated on purpose: it must say exactly what the engine would say, for the Owner/access-admin
// composing a custom role. Extending this gate to a full data-flow check would need a type checker;
// noted for a future pass rather than pretended away.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const IDENTITY_MODEL = join(SRC, "lib", "identity-model.ts");

// Files that are the Capability id's own definitional home, or the deliberate admin-precision
// exception (see the file headers cited): the bare id, or the engine-mirrored validation reason, is the
// INTENDED content there, not a leak. Excluded from all four rules entirely.
const ALLOWLIST = new Set([
  "src/lib/identity-model.ts", // the Capability union itself
  "src/screens/capability-copy.ts", // CAPABILITY_PHRASE: the translation map: every id is a bare key
  "src/screens/roles-builder/shared.ts", // CAPABILITY_LABELS: id shown as a bare mono span BESIDE a label + desc (a documented teaching pattern, never a bare fallthrough)
  "src/lib/identity-custom-roles.ts", // SCREEN_WRITE_CAPABILITY + validateCustomRole: engine-mirrored, byte-for-byte; its reason strings must say exactly what the engine says for the caller composing a custom role
]);

// extractCapabilities reads the closed Capability union straight from identity-model.ts, so this gate
// tracks the union rather than hand-maintaining a second copy of it that could drift.
function extractCapabilities() {
  const text = readFileSync(IDENTITY_MODEL, "utf8");
  const start = text.indexOf("export type Capability =");
  if (start === -1) throw new Error("capability-copy gate: could not find 'export type Capability =' in identity-model.ts; the union may have moved.");
  const end = text.indexOf(";", start);
  const block = text.slice(start, end === -1 ? undefined : end);
  const ids = [...block.matchAll(/"([a-z][a-z]*\.[a-z][a-zA-Z]*)"/g)].map((m) => m[1]);
  if (ids.length < 15) throw new Error(`capability-copy gate: parsed only ${ids.length} capability ids from identity-model.ts, expected at least 15. The union is not being read correctly.`);
  return ids;
}

// extractHyphenatedRoles reads the built-in Role union from identity-model.ts and keeps only the
// hyphenated members. The single-word roles ("viewer", "operator", "approver", "owner") are ordinary
// English and are deliberately NOT tracked: see RULE 4 in the header.
function extractHyphenatedRoles() {
  const text = readFileSync(IDENTITY_MODEL, "utf8");
  const start = text.indexOf("export type Role =");
  if (start === -1) throw new Error("capability-copy gate: could not find 'export type Role =' in identity-model.ts; the union may have moved.");
  const end = text.indexOf(";", start);
  const block = text.slice(start, end === -1 ? undefined : end);
  const ids = [...block.matchAll(/"([a-z]+-[a-z]+)"/g)].map((m) => m[1]);
  if (ids.length < 2) throw new Error(`capability-copy gate: parsed only ${ids.length} hyphenated role id(s) from identity-model.ts, expected at least 2 (restore-operator, access-admin). The union is not being read correctly.`);
  return ids;
}

// INTERP is the sentinel a `${...}` interpolation leaves behind in a literal's text. NUL is not a word
// character, so RULE 1's and RULE 3's `\b` boundaries behave exactly as they would against whitespace,
// and it cannot occur in real source.
const INTERP = "\u0000";

// Characters after which a `/` begins a regex literal rather than a division. The keyword list covers
// the cases where the preceding token is a word (`return /re/`, `case /re/`, `typeof /re/`).
const REGEX_PRECEDING_PUNCT = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "^", "~", "<", ">", "\n"]);
const REGEX_PRECEDING_KEYWORDS = new Set(["return", "typeof", "instanceof", "case", "in", "of", "new", "delete", "void", "do", "else", "yield", "await"]);

// scanLiterals walks TS source and returns every string/template literal that is genuinely code (not
// inside a comment), with interpolation bodies reduced to the NUL sentinel. Nested literals inside an
// interpolation body are returned as their own entries.
//
// Modes: "code" | "line" | "block" | "sq" | "dq" | "tmpl" | "re" | "recls" ("recls" = inside a regex
// character class, where an unescaped `/` does not end the regex).
function scanLiterals(text) {
  const out = [];
  const tmplStack = []; // open template frames, innermost last
  const interpDepth = []; // brace depth inside each open `${...}`, innermost last
  let mode = "code";
  let line = 1;
  let simple = null; // the open sq/dq frame
  let prevSig = "\n"; // last significant (non-space, non-comment) character seen in code
  let word = ""; // the identifier currently being read in code, for the regex keyword test

  const append = (ch) => {
    if (mode === "tmpl") tmplStack[tmplStack.length - 1].text += ch;
    else if (simple) simple.text += ch;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "\n") line++;

    switch (mode) {
      case "line":
        if (ch === "\n") mode = "code";
        break;

      case "block":
        if (ch === "*" && next === "/") { i++; mode = "code"; }
        break;

      case "sq":
      case "dq": {
        if (ch === "\\") { append(ch); if (next !== undefined) { append(next); if (next === "\n") line++; i++; } break; }
        if ((mode === "sq" && ch === "'") || (mode === "dq" && ch === '"')) { out.push(simple); simple = null; mode = "code"; prevSig = ch; break; }
        append(ch);
        break;
      }

      case "tmpl": {
        const frame = tmplStack[tmplStack.length - 1];
        if (ch === "\\") { frame.text += ch; if (next !== undefined) { frame.text += next; if (next === "\n") line++; i++; } break; }
        if (ch === "`") { out.push(tmplStack.pop()); mode = "code"; prevSig = ch; break; }
        if (ch === "$" && next === "{") { frame.text += INTERP; i++; interpDepth.push(0); mode = "code"; prevSig = "{"; word = ""; break; }
        frame.text += ch;
        break;
      }

      case "re":
      case "recls": {
        if (ch === "\\") { if (next !== undefined) { if (next === "\n") line++; i++; } break; }
        if (mode === "re" && ch === "[") { mode = "recls"; break; }
        if (mode === "recls" && ch === "]") { mode = "re"; break; }
        if (mode === "re" && ch === "/") { mode = "code"; prevSig = "/"; word = ""; }
        break;
      }

      default: {
        // code
        if (ch === "/" && next === "/") { i++; mode = "line"; break; }
        if (ch === "/" && next === "*") { i++; mode = "block"; break; }
        if (ch === "/") {
          const isRegex = REGEX_PRECEDING_PUNCT.has(prevSig) || REGEX_PRECEDING_KEYWORDS.has(word);
          if (isRegex) { mode = "re"; word = ""; break; }
          prevSig = ch; word = ""; break;
        }
        if (ch === '"' || ch === "'") { simple = { kind: "string", line, text: "" }; mode = ch === '"' ? "dq" : "sq"; word = ""; break; }
        if (ch === "`") { tmplStack.push({ kind: "template", line, text: "" }); mode = "tmpl"; word = ""; break; }
        if (interpDepth.length > 0) {
          if (ch === "{") interpDepth[interpDepth.length - 1]++;
          else if (ch === "}") {
            if (interpDepth[interpDepth.length - 1] === 0) { interpDepth.pop(); mode = "tmpl"; word = ""; break; }
            interpDepth[interpDepth.length - 1]--;
          }
        }
        if (/[A-Za-z0-9_$]/.test(ch)) word += ch;
        else word = "";
        if (!/\s/.test(ch)) prevSig = ch;
        else if (ch === "\n") prevSig = "\n";
        break;
      }
    }
  }
  return out;
}

// checkLiterals applies the four rules to one file's literals and returns human-readable failures.
function checkLiterals(literals, rel, capabilities, roles = []) {
  const dotted = capabilities.map((id) => ({ id, re: new RegExp(`\\b${id.replace(".", "\\.")}\\b`) }));
  const hyphenSpace = capabilities.map((id) => ({ id, re: new RegExp(`\\b${id.replace(".", "[- ]")}\\s+capability\\b`, "i") }));
  const interpAdjacent = new RegExp(`${INTERP}\\s*(capability|permission)\\b`, "i");
  // RULE 4: the role id must stand as its own token in PROSE. The leading/trailing exclusions keep it
  // out of a longer hyphenated identifier ("role-access-admin") or a selector ([data-role="access-admin"]),
  // neither of which a customer reads; the whitespace test is the prose signal, since every real leak sat
  // in a sentence.
  const roleProse = roles.map((id) => ({ id, re: new RegExp(`(^|[^-_/."'\\w])${id}($|[^-_/=\\w])`) }));
  const failures = [];

  for (const lit of literals) {
    const trimmed = lit.text.trim();
    if (capabilities.includes(trimmed)) continue; // the bare id: a lookup key or a canCap/capGateReason/capabilityPhrase argument
    if (roles.includes(trimmed)) continue; // likewise: the bare role id is a value, not copy

    for (const { id, re } of dotted) {
      if (re.test(lit.text)) {
        failures.push(`${rel}:${lit.line}  RULE 1: the raw capability id "${id}" is embedded in customer-visible copy: ${JSON.stringify(lit.text)}. Route it through capabilityPhrase("${id}") (screens/capability-copy.ts).`);
      }
    }

    if (interpAdjacent.test(lit.text)) {
      failures.push(`${rel}:${lit.line}  RULE 2: a template-literal interpolation is immediately followed by "capability"/"permission" -- the sixth-site shape (a raw Capability value spliced into a sentence): ${JSON.stringify(lit.text)}. Wrap the interpolated value in capabilityPhrase() and drop the literal word.`);
    }

    for (const { id, re } of hyphenSpace) {
      if (re.test(lit.text)) {
        failures.push(`${rel}:${lit.line}  RULE 3: "${id}" spelled with a hyphen/space, immediately followed by "capability", in customer-visible copy: ${JSON.stringify(lit.text)}. Route it through capabilityPhrase("${id}") (screens/capability-copy.ts).`);
      }
    }

    if (/\s/.test(lit.text)) {
      for (const { id, re } of roleProse) {
        if (re.test(lit.text)) {
          const label = id.charAt(0).toUpperCase() + id.slice(1).replace("-", " ");
          failures.push(`${rel}:${lit.line}  RULE 4: the raw built-in role id "${id}" is embedded in customer-visible copy: ${JSON.stringify(lit.text)}. Write the display label "${label}", the form the rest of the console uses.`);
        }
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------------------------------
// SELF-TEST: prove the rules can still FIRE, and prove they stay quiet on legitimate copy.
//
// Every MUST_FAIL case below is a shape this gate must catch, including the three a naive line-by-line
// scanner would silently miss (see the header). Every MUST_PASS case is a sentence that legitimately
// exists (or plausibly would) and must never be flagged, so the gate cannot be "fixed" by making it
// flag more.
// ---------------------------------------------------------------------------------------------------
// interp() writes a `${...}` interpolation into a FIXTURE without this file's own source containing the
// literal two-character sequence. The fixtures below are JavaScript SOURCE TEXT quoted for the scanner to
// parse, not template literals of this file, and Biome's noTemplateCurlyInString would otherwise flag them
// (correctly, for normal code). Same situation as src/screens/idp-guides.ts, which quotes Auth0's own
// template syntax; assembling it here keeps the fixtures readable and needs no blanket suppression.
const DOLLAR = "$";
const interp = (expr) => `${DOLLAR}{${expr}}`;

const SELF_TEST_MUST_FAIL = [
  ["RULE 1", 'const a = "Requires the restore.apply capability.";', "dotted id in a plain string"],
  ["RULE 2", `const b = \`Requires the ${interp("writeCap")} capability.\`;`, "interpolated Capability followed by the word capability"],
  ["RULE 2", `const b2 = \`Needs the ${interp("SCREEN_WRITE_CAPABILITY[s.id]")} permission.\`;`, "the sixth site's shape, with a lookup and a nested bracket"],
  ["RULE 3", 'const c = "Requires the restore-apply capability.";', "hyphen form followed by the word capability"],
  ["RULE 1", 'const d = "See https://docs.downpipes.io/x for the restore.apply capability.";', "a literal that also contains a URL, whose // truncated the old line-based scan"],
  ["RULE 1", "const e = `Applying is refused.\nRequires the restore.apply capability.`;", "a MULTI-LINE template, invisible to the old same-line literal regex"],
  ["RULE 3", "const f = `Applying is refused.\nRequires the restore-apply capability.`;", "hyphen form inside a multi-line template"],
  ["RULE 1", "const g = 'docs at https://x/y explain downpipe.write here';", "single-quoted string containing a URL"],
  ["RULE 1", `const h = \`You need ${interp("role")} for the drill.run capability.\`;`, "dotted id in the literal half of a template that also interpolates"],
  ["RULE 2", `const i = \`Requires the ${interp("cap")} capability\`; // trailing comment`, "a real leak on a line that also carries a comment"],
  ["RULE 4", 'const j = "An owner or access-admin can grant it.";', "a raw hyphenated role id in prose"],
  ["RULE 4", 'const k = "it requires permission to run a recovery drill (an operator, restore-operator, approver or owner).";', "the role half left raw in a sentence whose capability half was already translated"],
];

const SELF_TEST_MUST_PASS = [
  ['const a = capGateReason("restore.apply");', "the bare id as an argument"],
  [`const b = \`Requires ${interp('capabilityPhrase("restore.apply")')}; ${interp("held")} does not hold it.\`;`, "the fixed shape: the id only inside an interpolation body"],
  ['const c = "Raise a restore request for approval.";', "ordinary English colliding with the space form of restore.request, without the word capability"],
  ['const d = "Editing an Access policy needs the Access admin role.";', "ordinary English colliding with access.policy"],
  ['// A comment may say "restore.apply capability" freely.', "a line comment is not customer copy"],
  ['/* A block comment may say "restore.apply capability" freely. */', "a block comment is not customer copy"],
  ["const e = s.replace(/[!#$%&'*+\\-.^_`|~0-9A-Za-z]/g, \"\"); const f = \"restore\";", "a regex literal containing a quote and a backtick must not desynchronise the scanner"],
  [`const g = \`${interp("state.capabilities.size")} capabilities\`;`, "a COUNT of capabilities is not an id leak"],
  ['const h = "permission to apply a restore";', "the customer-facing phrase itself"],
  ['const i = "An Owner or Access admin can grant it.";', "the fixed RULE 4 shape: the display label, not the slug"],
  ['const j = engine.setRole(email, "access-admin");', "the bare role id as a value"],
  ['const k = document.querySelector(\'[data-role="access-admin"], .roles-table\');', "a selector is not customer copy, even when it contains whitespace"],
  ['const l = h("div", { class: "role-access-admin badge" });', "a class name that merely contains the slug, alongside another class"],
];

function runSelfTest(capabilities, roles) {
  const problems = [];
  for (const [rule, source, why] of SELF_TEST_MUST_FAIL) {
    const failures = checkLiterals(scanLiterals(source), "selftest.ts", capabilities, roles);
    if (!failures.some((f) => f.includes(rule))) {
      problems.push(`self-test: expected ${rule} to fire on ${why} (${JSON.stringify(source)}) and it did not. The gate has lost the teeth this case exists to prove.`);
    }
  }
  for (const [source, why] of SELF_TEST_MUST_PASS) {
    const failures = checkLiterals(scanLiterals(source), "selftest.ts", capabilities, roles);
    if (failures.length > 0) {
      problems.push(`self-test: expected NO failure on ${why} (${JSON.stringify(source)}) but got: ${failures.join(" | ")}. The gate is now flagging legitimate copy.`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const walked = walk(SRC);
// A floor mirroring innerhtml-sink-gate.mjs's: an empty or truncated walk must fail loudly rather than
// pass by having nothing left to check. src holds hundreds of .ts files, so 200 is a safe floor.
if (walked.length < 200) {
  console.error(`Capability-copy gate FAILED:\n  walked ${walked.length} file(s) under src, expected at least 200. The gate is not reading the console's source, so it cannot say where a capability id leaks.`);
  process.exit(1);
}

const CAPABILITIES = extractCapabilities();
const HYPHENATED_ROLES = extractHyphenatedRoles();

const selfTestProblems = runSelfTest(CAPABILITIES, HYPHENATED_ROLES);
if (selfTestProblems.length > 0) {
  console.error(`Capability-copy gate FAILED its own self-test, so its verdict on the codebase means nothing:\n${selfTestProblems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}

const failures = [];
let literalCount = 0;
for (const file of walked) {
  const rel = relative(ROOT, file).split("\\").join("/");
  if (ALLOWLIST.has(rel)) continue;
  const literals = scanLiterals(readFileSync(file, "utf8"));
  literalCount += literals.length;
  failures.push(...checkLiterals(literals, rel, CAPABILITIES, HYPHENATED_ROLES));
}

if (failures.length > 0) {
  console.error(`Capability-copy gate FAILED (R-19: a raw capability id must never reach customer-visible copy):\n${failures.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`Capability-copy gate PASS (${walked.length} files read, ${literalCount} string/template literals scanned, ${CAPABILITIES.length} capabilities and ${HYPHENATED_ROLES.length} hyphenated role ids tracked, ${SELF_TEST_MUST_FAIL.length + SELF_TEST_MUST_PASS.length} self-test cases green, 0 leaks).`);
