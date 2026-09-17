#!/usr/bin/env node
// Dead-vocabulary gate.
//
// WHY. A closed-vocabulary member with NO PRODUCER is coverage-shaped nothing: the pack's vocabulary promises a
// support engineer that it will tell them when X happened, and nothing can ever put X there. That is WORSE than
// an honest absence, because an absence makes you look and a promised-but-empty class makes you conclude it did
// not happen.
//
// The failure mode is concrete: a `delete-denied` class for a destination whose DELETE is refused (you can
// write backups but never expire them, so retention silently does not work) can ship with a probe that
// returns ok:true for a denied delete, so nothing can ever emit it -- and the suite can stay green anyway,
// because a test posts a hand-written record straight into the recorder and asserts it comes back. A green
// suite like that proves the ring can CARRY the class. It never proves the product can PUT it there.
//
// A member counts as PRODUCED if the literal appears anywhere in src outside its own declaration: at a call
// site, or as a value in a lookup table (the INVALID_RUNID_COUNTERS[kind] idiom), which is why this reads the
// whole tree rather than grepping call sites.
//
// EXEMPT covers the vocabularies this repo RECEIVES rather than emits: the engine holds a twin of the console's
// client-diag vocabulary purely to re-validate an incoming ring, so its members correctly have no engine
// producer. Adding to EXEMPT needs a reason, not a shrug.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(path.join(ROOT, "package.json"))("typescript");

// A LITERAL-SPELLING SCAN IS NOT ENOUGH, and it is the same hole the engine's gate has to close. The question
// "does this spelling appear anywhere in src" cannot separate two vocabularies that SHARE a spelling, so a
// member with no producer at all passes as long as some OTHER vocabulary carries the same word (drop
// "form-rejected", a CLIENT_DIAG_KINDS member, into CLIENT_DIAG_SCREENS and a bare scan reports PASS). The
// generic path here compiles the console and asks the TYPE CHECKER which vocabulary each occurrence flows
// into; the two modelled paths (CLIENT_DIAG_FORM_FIELDS, which is decided by the VALIDATOR, and the CSP
// directives, which are decided by the console's own policy) are exceptions handled separately, below.

// A GUARD CAN ALSO BE DECIDED ENTIRELY BY THIS REPO'S OWN CONSTANTS, one level up from the other two: those
// ask WHICH vocabulary a literal flows into, and neither asks whether the branch it sits in CAN EVER BE TAKEN.
//
// The integrations vendor catalogue is the case in point. A contract-skew family such as
// CLIENT_DIAG_FIELD_FAMILIES exists to record when the ENGINE hands this console a value it does not
// recognise, but a producer that only fires when a vendor's mark key resolves to no brand mark and no
// monogram is guarded by `vendor.mark` off CATALOGUE -- a CONSOLE-SIDE CONSTANT in this repo, whose every key
// resolves. Such a guard is unsatisfiable for every engine version, every account and every render, however
// correctly typed and real the call site is. A member whose only producer reads a constant THIS REPO SHIPS is
// dead vocabulary with a live-looking call site: it promises support a signal about the engine that no engine
// can send.
//
// So a producer inside one of these modules DOES NOT COUNT. The list is short and each entry is a claim that the
// module's recorded inputs come from this repo's own constants and never off the wire, checked below to still
// exist. A recorder that genuinely reads engine data must not live in one of them.
const CONSOLE_CONSTANT_MODULES = new Set([
  // The integrations vendor catalogue and its mark renderer. The catalogue is a constant array in this repo, and
  // the renderer is only ever handed a mark key out of it. The engine does not name vendors.
  "src/screens/integrations/catalogue.ts",
  "src/screens/integrations/marks.ts",
]);

// Vocabularies this repo VALIDATES but does not EMIT. The producers live in the other repo.
// CLIENT_* vocabularies are all console-PRODUCED and engine-RECEIVED: the engine holds the twin only to
// re-validate an incoming ring, so a member with no engine producer is correct, not dead. Their producers are
// checked by the console's own dead-vocab gate.
const EXEMPT = new Set([]);
const isExempt = (name) => [...EXEMPT].some((p) => name.startsWith(p));

// SET-MEMBERSHIP PRODUCERS. A few vocabularies are emitted by a MAP, not by a call site: the recorder is handed a
// string the BROWSER chose, tests it against the frozen set, and returns the member it matched (or the residual).
// The member literal is therefore never written anywhere in src, so a literal scan is structurally blind to it
// and would report every live CSP directive as dead.
//
// Exempting the vocabulary outright would be the shrug this gate exists to refuse, so the claim is CHECKED
// instead, and checked against the thing that actually decides it:
//
//   cspDirective  a directive is reportable by the browser only if THIS CONSOLE'S OWN POLICY STATES IT. So each
//                 member is verified against buildCsp() in src/worker.ts. A member the policy does not state is
//                 one the browser can never name to us, and it is dead however many mapping functions exist: an
//                 injected frame still records, as `other`, precisely because buildCsp states no frame-src for
//                 this vocabulary to name.
//
// The mapper must also EXIST and be called, or nothing reaches the set at all.
// WIDE SINKS: the console's recorders are typed (recordClientDiag takes the closed row types), so there is
// nothing here yet. An entry names a CALL whose string parameter feeds a vocabulary, and the reason the receiver
// re-checks it. Adding one is a claim that must be checked, not a shrug.
const WIDE_SINKS = [];

// A renamed or deleted blind module must FAIL rather than quietly re-open the hole above.
for (const m of CONSOLE_CONSTANT_MODULES) {
  if (!fs.existsSync(path.join(ROOT, m))) {
    console.error(`DEAD-VOCAB GATE: FAIL -- CONSOLE_CONSTANT_MODULES names a file that is gone: ${m}`);
    process.exit(1);
  }
}

const CSP_POLICY = fs.readFileSync(path.join(ROOT, "src/worker.ts"), "utf8");
const cspFn = CSP_POLICY.slice(CSP_POLICY.indexOf("function buildCsp"));
const CSP_BODY = cspFn.slice(0, cspFn.indexOf("\n}"));

// CLIENT_DIAG_FORM_FIELDS needs its own model, and it needs one because the literal scan below gives it a FALSE
// PASS: every member is also the `id:` of a real control, so the literal is always there and a bare scan always
// finds it -- reporting members that can never be emitted (dest-secret, dest-access-key, dest-r2-bucket,
// dest-s3-bucket, dest-region, dest-account-id) as green.
//
// A form-rejected row means THE CONSOLE'S OWN VALIDATOR refused the operator in the browser. That has exactly
// these producers, and no others:
//
//   1. an explicit recordFormRefused("x", value) call site (the ONLY recorder that can write a `rejected` row:
//      it takes the raw value and refuses to write one for an empty box), or recordFormCoerced("x")
//   2. the literal passed as an argument to a helper that records (the `num(f, fallback, "dest-price-storage")`
//      idiom in destination-submit.ts)
//   3. a validator error `field: "x"`, which add-source funnels through formFieldFor
//   4. a `refusedField` union member, which its panel funnels through recordFormRefused
//   5. field({ id: "x", validate: ... }) -- the funnel in components/field.ts
//   6. field({ id: "x" }) that something calls .refuse() on
//   7. the id passed to a local helper that itself builds a VALIDATED field (the priceField idiom)
//
// A control with `required: true` and no validate is NOT a producer, deliberately: the required-and-empty branch
// records nothing, because an operator part-way through a form is the commonest event in the console and
// recording it would bury every real refusal under it.
//
// AND NEITHER IS A CONTROL WHOSE VALIDATOR CAN ONLY REJECT THE EMPTY STRING. "Has a validate:" is not enough
// to prove a producer, because a validator such as `(v) => (v.length >= 1 ? null : "Paste the deploy token.")`
// passes every non-empty string, so its only reachable refusal is the empty one -- and components/field.ts
// does not record the empty one, because an operator part-way through a form is not a fault. A member behind
// such a validator can never be emitted, and the row it promised would LIE about the one thing its outcome
// asserts: `rejected` means the validator turned the operator away from the value they typed, and no value
// was examined.
//
// A SPELLING MATCH ON THE EMPTINESS TEST IS NOT ENOUGH EITHER, and this is the part worth remembering. Regexes
// anchored on `v.length >= 1 ? null : "..."` and near-variants would let three other emptiness idioms sail
// through unrecognised -- `v === ""`, `v.trim() === ""`, and a CROSS-FIELD emptiness test
// (`other.value() === "downpipe" && v.length === 0`) -- so a validator written any of those other ways would be
// reported as a producer when it refuses nothing but blank input. A check that cannot see a class of dead
// member will let the next one through, so this decides by MEANING instead:
//
//   A validator is emptiness-only when EVERY use of its value parameter is an emptiness test. Such a function is
//   CONSTANT over the non-empty strings -- it cannot tell two of them apart -- so it can never refuse "the value
//   the operator typed", whatever else it reads (a sibling field, a helper, a flag). That is decidable from the
//   uses of the parameter alone, and it needs no assumption about the free variables around it.
//
// The static read is then CONFIRMED BY EXECUTION: the validator is compiled and run over a set of non-empty
// probes (a shape, a URL, a cron, a number, whitespace, a long string). If two probes disagree, the validator
// discriminates and it is a real producer, whatever the static read said. Execution can therefore only ever
// rescue a member, never condemn one, so a validator whose free variables will not compile (a helper, an import)
// is judged on the static read alone and is never called dead by an evaluation that could not run.
const maskStrings = (s) => s.replace(/"(?:[^"\\]|\\.)*"/g, (m) => `"${"_".repeat(Math.max(0, m.length - 2))}"`);
// The non-empty probes: the values the funnel can actually hand a validator. Any two of these that a validator
// tells apart make it a real inspection of the value. THEY ARE ALL TRIMMED, because field.ts's readValue() trims
// before it validates, so a spaces-only box arrives at the validator as "" and a `v.trim() === ""` test is an
// emptiness test and nothing more. A whitespace probe here would make every one of those look like a real
// validator, which is the false pass this gate exists to refuse.
const PROBES = ["a", "Z9", "0 0 * * *", "https://example.com/x", "KV_uploads", "-1", "999999999", "not@an@email", "x".repeat(300)];
// The emptiness USES of the value: "is there anything here at all", in every form the console writes. An
// occurrence of the parameter that is not one of these is a real inspection of what the operator typed. The
// patterns are anchored AT the occurrence (the parameter name is substituted in), so they read a USE, not a whole
// validator, which is what makes a cross-field emptiness test (`kind.value() === "x" && v.length === 0`) legible.
const emptinessUses = (p) => [
  new RegExp(`^${p}(?:\\.trim\\(\\))?\\.length\\s*(?:===|!==|==|!=|>=|<=|>|<)\\s*[01]\\b`),
  new RegExp(`^${p}(?:\\.trim\\(\\))?\\s*(?:===|!==|==|!=)\\s*""`),
];
// paramOf lifts the value parameter's name off the arrow (`(v) => ...`, `(v: string) => ...`, `v => ...`).
function paramOf(src) {
  const m = src.match(/^\(?\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)?\s*=>/);
  return m ? m[1] : null;
}
// staticEmptyOnly: every occurrence of the value parameter in the validator BODY is an emptiness test, so the
// validator is constant across the non-empty strings and cannot refuse a value.
function staticEmptyOnly(src) {
  const p = paramOf(src);
  if (p === null) return false;
  const body = src.slice(src.indexOf("=>") + 2);
  const uses = emptinessUses(p);
  const occ = [...body.matchAll(new RegExp(`\\b${p}\\b`, "g"))];
  if (occ.length === 0) return false; // it never reads the value at all: not a shape this gate models
  return occ.every((m) => uses.some((re) => re.test(body.slice(m.index))));
}
// probeDiscriminates: compile the validator and run it over the non-empty probes. Free identifiers resolve to an
// inert stub through a `with` scope, so a cross-field validator still runs; anything that throws is skipped. Two
// probes that disagree prove the validator inspects the value. Used ONLY to rescue a member.
function probeDiscriminates(src) {
  let fn;
  try {
    const stub = new Proxy(() => {}, { get: () => stub, apply: () => stub, has: () => true });
    const scope = new Proxy({}, { has: (_t, k) => typeof k === "string" && !(k in globalThis), get: () => stub });
    fn = new Function("__scope", "__v", `with (__scope) { return (${src})(__v); }`).bind(null, scope);
  } catch {
    return false;
  }
  const seen = new Set();
  for (const p of PROBES) {
    try {
      const r = fn(p);
      seen.add(typeof r === "string" ? `msg:${r}` : String(r));
    } catch {
      /* a probe that will not run proves nothing; the static read decides */
    }
  }
  return seen.size > 1;
}
// validateSrcOf lifts the `validate:` property value out of a field({...}) body. String literals are masked
// FIRST so a comma or a brace inside an error message cannot end the scan early.
function validateSrcOf(body) {
  const masked = maskStrings(body);
  const at = masked.indexOf("validate:");
  if (at === -1) return null;
  let depth = 0, out = "";
  for (let i = at + "validate:".length; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; }
    else if (c === "," && depth === 0) break;
    out += c;
  }
  return out.replace(/\s+/g, " ").trim();
}
// isEmptyOnly: the validator cannot refuse any value the operator could type. Decided by MEANING (every use of
// the value is an emptiness test) and confirmed by EXECUTION (no two non-empty probes are told apart).
const isEmptyOnly = (vs) => vs !== null && staticEmptyOnly(vs) && !probeDiscriminates(vs);
const FIELD_DEFS = new Map(); // id -> { hasValidate, varName, file }
const VALIDATED_HELPERS = new Set();
function indexFieldDefs(srcMap) {
  for (const [f, s] of srcMap) {
    const re = /field\w*\(\{/g;
    for (let mm = re.exec(s); mm !== null; mm = re.exec(s)) {
      let i = re.lastIndex - 1, depth = 0, end = i;
      for (; i < s.length; i++) { if (s[i] === "{") depth++; else if (s[i] === "}") { depth--; if (depth === 0) { end = i; break; } } }
      const body = s.slice(re.lastIndex, end);
      const idLine = body.match(/\bid:\s*([^\n,]+)/);
      if (!idLine) continue;
      // An emptiness-only validator is NOT a validator for this gate's purpose: field.ts does not record it.
      const hasValidate = /\bvalidate:/.test(body) && !isEmptyOnly(validateSrcOf(body));
      const before = s.slice(Math.max(0, re.lastIndex - 200), re.lastIndex);
      const vn = before.match(/(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*[\w.]*field\w*\(\{$/);
      // Both arms of the `id: cond ? "a" : "b"` form are ids of this same definition.
      for (const idm of idLine[1].matchAll(/"([A-Za-z0-9-]+)"/g)) FIELD_DEFS.set(idm[1], { hasValidate, varName: vn?.[1], file: f });
    }
    for (const hm of s.matchAll(/const (\w+)\s*=\s*\(\s*id\s*:\s*string[\s\S]{0,400}?field\w*\(\{[\s\S]{0,600}?\}\)/g)) {
      if (/\bvalidate:/.test(hm[0])) VALIDATED_HELPERS.add(hm[1]);
    }
  }
}
// refusesAValue: the field has a .refuse() call site that can fire on a value the operator TYPED. field.ts records
// nothing for an empty one (the same rule the funnel enforces), so a refuse() whose every call site is guarded by
// an emptiness test ON THAT SAME FIELD produces nothing: it is the required-and-empty state, which the console
// records nowhere. That is not a hypothetical either -- the IdP preset's client secret was refused on
// `!isPublic && secretField.value() === ""` and NOTHING else, so its member could never be emitted while the gate
// read the call site and reported it green.
function refusesAValue(varName, src) {
  const calls = [...src.matchAll(new RegExp(`\\b${varName}\\.refuse\\(`, "g"))];
  if (calls.length === 0) return false;
  const guard = new RegExp(`\\b${varName}\\.value\\(\\)(?:\\.trim\\(\\))?\\s*(?:===\\s*""|\\.length\\s*(?:===\\s*0|<\\s*1))`);
  return calls.some((m) => !guard.test(src.slice(Math.max(0, m.index - 400), m.index)));
}
function formFieldProducer(mem, all, srcMap) {
  // recordFormRefused is the ONLY recorder that can write a `rejected` row: it takes the raw value and drops
  // an empty one, so the emptiness rule is the type checker's rather than each caller's. recordFormCoerced is the
  // silently-coerced twin, and it is a producer too (dest-price-* ride it).
  if (new RegExp(`recordFormRefused\\(\\s*"${mem}"`).test(all)) return "an explicit recordFormRefused call";
  if (new RegExp(`recordFormCoerced\\(\\s*"${mem}"`).test(all)) return "an explicit recordFormCoerced call";
  if (new RegExp(`,\\s*"${mem}"\\s*\\)`).test(all)) return "a literal argument to a recording helper";
  if (new RegExp(`field:\\s*"${mem}"`).test(all)) return "a validator error field name";
  // A field() that DECLARES its vocabulary member because its own id carries a per-row index. The costs
  // screen's four contracted-rate controls are built as `cost-price-storage-${index}`, so the id can
  // never equal the member and formFieldFor would drop the refusal. `diagField:` is the call site saying
  // which member the funnel should record, and it is a producer exactly like an explicit call.
  if (new RegExp(`diagField:\\s*"${mem}"`).test(all)) return "a declared diagField on a field()";
  if (new RegExp(`priceField\\([^)]*"${mem}"`).test(all)) return "a declared member on a priceField() helper";
  if (new RegExp(`refusedField[^\\n]*"${mem}"`).test(all)) return "a refusedField union member";
  const d = FIELD_DEFS.get(mem);
  if (d?.hasValidate) return "the field() validate funnel";
  if (d?.varName !== undefined && refusesAValue(d.varName, srcMap.get(d.file))) return "field.refuse()";
  for (const h of VALIDATED_HELPERS) if (new RegExp(`\\b${h}\\(\\s*"${mem}"`).test(all)) return `the validated helper ${h}()`;
  return null;
}

const SET_MEMBERSHIP = {
  CLIENT_DIAG_CSP_DIRECTIVES: {
    mapper: "cspDirectiveFor",
    // `other` is the residual the mapper returns for a non-member, so it is produced by construction.
    produces: (mem) => mem === "other" || CSP_BODY.includes(`${mem} `),
    why: (mem) => `buildCsp() in src/worker.ts states no ${mem}, so the browser can never name it in a violation report`,
  },
};

const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!/node_modules|\.git/.test(p)) walk(p, out); }
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
};

// Comments are stripped: a member merely DESCRIBED in prose is not a producer.
//
// ORDER IS LOAD-BEARING. Line comments go FIRST. Stripping block comments first makes a `/*` written INSIDE a
// line comment (`// POST /config/changes/*`) open a block comment that runs to the next `*/` hundreds of lines
// away, swallowing the real producers in between and reporting live members as dead. That is exactly the
// failure this gate exists to prevent, in the gate itself: it would have had a maintainer DELETE seven live
// droppedWrites kinds whose recorders were sitting in the swallowed range.
const stripLine = (s) => s.split("\n").map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1")).join("\n");
const strip = (s) => stripLine(s).replace(/\/\*[\s\S]*?\*\//g, "");

const files = walk(path.join(ROOT, "src"));
const src = new Map(files.map((f) => [f, strip(fs.readFileSync(f, "utf8"))]));

const SRC = path.join(ROOT, "src");
const cfgPath = ts.findConfigFile(ROOT, ts.sys.fileExists, "tsconfig.json");
const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.dirname(cfgPath));
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const sources = program.getSourceFiles().filter((sf) => !sf.isDeclarationFile && sf.fileName.startsWith(SRC + path.sep));
const TYPED_SRC = sources.map((sf) => sf.getFullText()).join("\n");

const MEMBER = /^[a-z][A-Za-z0-9-]{2,}$/;

// The vocabularies: `export const NAME = [...] as const`, keyed by FILE + NAME, not by name. Three vocabulary
// names are declared in two files each (ADMIN_REFUSAL_REASONS and DROPPED_WRITE_KINDS in diag-records.ts and
// sched-fault-ledger.ts, UPDATE_COMPONENTS in diag-records.ts and update-orchestrate.ts), deliberately: they are
// different closed sets serving different records. Keying on the bare name made the second declaration overwrite
// the first, so one whole vocabulary per collision was never scanned.
const worlds = []; // every closed literal set the console declares (see related())
const vocabList = [];
const declArrays = new Map(); // array literal node -> its own member set (an `as const` list IS a closed slot)
for (const sf of sources) {
  const visit = (node) => {
    if (ts.isVariableStatement(node)) {
      // EXPORTED lists only. An unexported `const NAMES = [...] as const` is a local helper (cf-config-diff's
      // IDENTITY_KEYS is iterated to index a Cloudflare object), not a vocabulary the pack promises.
      const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
      for (const d of node.declarationList.declarations) {
        if (!exported || !ts.isIdentifier(d.name) || !/^[A-Z][A-Z0-9_]+$/.test(d.name.text)) continue;
        const init = d.initializer;
        if (init === undefined || !ts.isAsExpression(init) || !ts.isArrayLiteralExpression(init.expression)) continue;
        if (init.type.getText() !== "const") continue;
        const arr = init.expression;
        // `members` is the WHOLE declared set, read off the CHECKER rather than the source elements, because a
        // vocabulary can be assembled by SPREAD (AUTH_SIGNAL_NAMES spreads the three SAML lists into itself).
        // Reading the elements alone made the set incomplete, so a slot typed with the full union looked like
        // someone else's vocabulary and a LIVE member was reported dead. It is what the checker shows at a slot,
        // so the subset test has to be against all of it; `checked` is what this gate rules on: the lower-case
        // tokens that are pack vocabulary rather than, say, a list of header names.
        const tupleArgs = checker.getTypeArguments(checker.getTypeAtLocation(arr));
        const members = new Set(tupleArgs.filter((t) => (t.flags & ts.TypeFlags.StringLiteral) !== 0).map((t) => t.value));
        if (members.size === 0) continue;
        const checked = [...members].filter((m) => MEMBER.test(m));
        declArrays.set(arr, members);
        worlds.push(members);
        // spreads: is the list ASSEMBLED from other lists (`...SAML_ATTACK_SHAPES`)? That is what licenses a
        // narrower slot to count as a producer (see related()).
        const spreads = arr.elements.some((e) => ts.isSpreadElement(e));
        if (checked.length >= 2 && !isExempt(d.name.text)) vocabList.push({ name: d.name.text, members, checked, spreads, arr, file: sf.fileName });
      }
    }
    if (ts.isTypeAliasDeclaration(node)) {
      const t = node.type;
      const parts = ts.isUnionTypeNode(t) ? t.types : [t];
      const lits = parts.filter((x) => ts.isLiteralTypeNode(x) && ts.isStringLiteral(x.literal)).map((x) => x.literal.text);
      if (lits.length >= 2 && lits.length === parts.length) worlds.push(new Set(lits));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// A closed-set signature: the string-literal members of a type, undefined/null stripped. Anything wider (a bare
// `string`, a number, an object) is not usable evidence and returns null: a literal handed to a `(name: string)`
// parameter says nothing about which vocabulary it belongs to. A ONE-member set is treated the same way, because
// a slot spelled `status: "pending"` names one state and cannot say whose vocabulary that state is in.
function closedSet(type) {
  if (type === undefined) return null;
  const parts = type.isUnion() ? type.types : [type];
  const out = new Set();
  for (const t of parts) {
    if (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never)) continue;
    if (t.flags & ts.TypeFlags.StringLiteral) { out.add(t.value); continue; }
    // `return "pending"` inside `async baseline(): Promise<CanaryLiveness>` is contextually typed
    // `CanaryLiveness | PromiseLike<CanaryLiveness>`, and the PromiseLike arm would otherwise make the whole
    // slot unreadable -- which silently turned a typed producer into an unattributable one.
    if (t.symbol !== undefined && /^(?:Promise|PromiseLike)$/.test(t.symbol.name)) continue;
    return null;
  }
  return out.size < 2 ? null : out;
}
const subsetOf = (a, b) => [...a].every((x) => b.has(x));
// RELATED: the slot is this vocabulary's world. Either the slot is the vocabulary (or a narrower selection out
// of it: a classifier that returns three of its members), or the slot is a union that CONTAINS the vocabulary
// (the counter-name idiom). A slot that is neither -- CanaryLiveness against SETTLE_STEP_DETAIL_CLASSES, where
// each carries a member the other does not -- belongs to someone else.
// RELATED: can this slot hold THIS vocabulary?
//
//   the slot is the vocabulary's own union, or a WIDER one that contains it -- `bump(name: AdminCounterName)`
//   takes the union of several declared lists, and a literal handed to it is a producer of each;
//
//   or the slot is a NARROWER selection out of a vocabulary that is ASSEMBLED BY SPREAD. AUTH_SIGNAL_NAMES
//   spreads the three SAML lists into itself, and noteSamlSignal's parameter is the union of those lists, so a
//   literal written there really is an auth signal. A vocabulary that spreads nothing has no such sub-selections:
//   every producer of it writes into its own union somewhere.
//
// A NARROWER slot into a spread-free vocabulary is REFUSED. Two examples from this engine, both of which would
// otherwise read as producers:
//   canary/cycle.ts's override field is typed `"pending" | "ailing"` -- a subset of SETTLE_STEP_DETAIL_CLASSES'
//   members if "pending" is put back in it, and nothing whatever to do with the settle;
//   CanaryLiveness itself becomes a subset of SETTLE_STEP_DETAIL_CLASSES the moment BOTH "pending" and "disabled"
//   are put back, so a subset rule hands the settle every canary write in the engine.
// WORLDS are every closed literal set the engine DECLARES: each `as const` list and each `type X = "a" | "b"`.
// For a spread-free vocabulary, a NARROWER slot counts only if no OTHER declared world can hold it. That is the
// test that tells a real sub-selection (verifyModeOf returns three of VERIFY_MODES' four, and no other world
// holds those three) from a coincidence (CanaryLiveness is a subset of SETTLE_STEP_DETAIL_CLASSES the moment
// "pending" and "disabled" are put back into it, and every canary write in the engine would become a settle
// producer).
const _setEq = (a, b) => a.size === b.size && subsetOf(a, b);
const related = (slot, v) =>
  subsetOf(v.members, slot) || // the vocabulary's own union, or a wider one that contains it
  (subsetOf(slot, v.members) && !worlds.some((w) => subsetOf(slot, w) && !subsetOf(w, v.members)));

// THE LIMIT, stated rather than hidden. The narrow-slot test asks whether an OUTSIDE world can hold the slot. It
// therefore cannot separate two vocabularies where one is a strict SUPERSET of the other, member for member: put
// BOTH "pending" and "disabled" back into SETTLE_STEP_DETAIL_CLASSES and CanaryLiveness becomes a subset of it,
// at which point a canary write is indistinguishable from a settle write by type alone. Either member ALONE is
// caught (CanaryLiveness then carries a member the settle does not, so it is a foreign world), which is what the
// dead-vocabulary case actually looks like; a vocabulary deliberately grown to swallow another whole vocabulary
// is a different thing, and it is what the posture suites and review are for.

// inTypePosition: `type X = "pending" | "alive"` DECLARES a vocabulary; it does not produce a member.
function inTypePosition(node) {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (ts.isTypeNode(n)) return true;
    if (ts.isSourceFile(n)) return false;
  }
  return false;
}
// returnSets: the closed sets a function's declared return type can carry, one level into object properties, so
// the `{ ok: true, cleanupState: raw }` guard idiom is legible as well as the bare `return d`.
function returnSets(type) {
  const out = [];
  const direct = closedSet(type);
  if (direct !== null) out.push(direct);
  for (const t of type.isUnion() ? type.types : [type]) {
    if ((t.flags & ts.TypeFlags.Object) === 0) continue;
    for (const p of t.getProperties()) {
      const pt = checker.getTypeOfSymbol(p);
      const s = closedSet(pt);
      if (s !== null) out.push(s);
    }
  }
  return out;
}
function enclosingReturnSets(node) {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)) {
      const sig = checker.getSignatureFromDeclaration(n);
      return sig === undefined ? [] : returnSets(checker.getReturnTypeOfSignature(sig));
    }
    if (ts.isSourceFile(n)) return [];
  }
  return [];
}
const EQ = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

// TABLES: an `as const` object or array with no contextual type (`const T = { length: "invalid-runid-length" }
// as const`) types nothing at the literal, so the table's USES are followed instead: `bump(env, T[kind])` gives
// the value a contextual type at the use site, and that is the slot.
const tableSlots = new Map(); // VariableDeclaration node -> [closed sets]
const identUses = new Map(); // symbol -> [identifier nodes]
for (const sf of sources) {
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const sym = checker.getSymbolAtLocation(node);
      if (sym !== undefined) {
        const l = identUses.get(sym);
        if (l === undefined) identUses.set(sym, [node]);
        else l.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
function slotsOfTable(decl) {
  const cached = tableSlots.get(decl);
  if (cached !== undefined) return cached;
  const out = [];
  tableSlots.set(decl, out); // set first: a self-referential table must not recurse forever
  const sym = checker.getSymbolAtLocation(decl.name);
  for (const use of identUses.get(sym) ?? []) {
    if (use === decl.name) continue;
    let e = use;
    while ((ts.isElementAccessExpression(e.parent) || ts.isPropertyAccessExpression(e.parent) || ts.isNonNullExpression(e.parent)) && e.parent.expression === e) e = e.parent;
    const s = closedSet(checker.getContextualType(e));
    if (s !== null) out.push(s);
  }
  return out;
}
// enclosingTable: the `as const` variable declaration this literal is a value inside, if any.
function enclosingTable(node) {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (ts.isVariableDeclaration(n)) {
      const init = n.initializer;
      const isConstTable = init !== undefined && ts.isAsExpression(init) && init.type.getText() === "const";
      return isConstTable && ts.isIdentifier(n.name) ? n : null;
    }
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isSourceFile(n)) return null;
  }
  return null;
}
// wideSinkVocab: the literal is an argument to a modelled untyped sink, or a property of a modelled wire body.
function wideSinkVocab(node) {
  const p = node.parent;
  if (ts.isCallExpression(p) && p.arguments.includes(node)) {
    const callee = p.expression.getText().replace(/^this\./, "");
    const hit = WIDE_SINKS.find((s) => s.call === callee && s.route === undefined);
    if (hit !== undefined) return [hit.vocab];
  }
  const wire = wireCall(node);
  if (wire !== null) {
    const text = wire.getText();
    const hits = WIDE_SINKS.filter((s) => s.route !== undefined && text.includes(s.route)).map((s) => s.vocab);
    if (hits.length > 0) return hits;
  }
  return null;
}
// unattributable: the literal is a property value in an object literal the checker gives NO type to (the DO's
// `return { ownerActionQueued: true, id, status: "pending" }`, whose method has an inferred return type). TS
// widens it to `string`, so it names no vocabulary at all, and crediting it to one is a guess -- the guess that
// let "pending" pass as a SETTLE_STEP_DETAIL_CLASS while every typed occurrence of it in the engine was a
// CanaryLiveness. A table (`const T = {...} as const`) is NOT unattributable: its uses are followed above.
// exactLiteralSlot: the position is typed with the ONE literal being written (`status: "pending"` in the DO's
// owner-action record type, whose 202 the console reads). Such a slot names a single state exactly, and a slot
// that can hold one string cannot vouch for a VOCABULARY: crediting it is what kept "pending" alive as a
// SETTLE_STEP_DETAIL_CLASS after every other route to it was closed. Not a producer, of anything.
function exactLiteralSlot(node) {
  const ctx = checker.getContextualType(node);
  if (ctx === undefined || ctx.isUnion()) return false;
  return (ctx.flags & ts.TypeFlags.StringLiteral) !== 0;
}
// wireCall: the literal is a value inside an object literal handed to JSON.stringify -- a body on the wire, not
// a typed record. The checker knows nothing about it (JSON.stringify takes `any`), so a bare wire write is NOT a
// producer of a pack vocabulary: nothing says which recorder, if any, is on the other end. The wire writes that
// ARE producers are the ones whose ROUTE is known, and those are modelled in WIDE_SINKS with `route` (the DO's
// /auth-signal, whose handler drops any name outside the vocabulary). Returns the enclosing fetch/call statement
// so the route can be read off it.
function wireCall(node) {
  let n = node.parent;
  while (n !== undefined && (ts.isPropertyAssignment(n) || ts.isObjectLiteralExpression(n) || ts.isArrayLiteralExpression(n) || ts.isConditionalExpression(n) || ts.isAsExpression(n) || ts.isSpreadAssignment(n))) n = n.parent;
  if (n === undefined || !ts.isCallExpression(n) || n.expression.getText() !== "JSON.stringify") return null;
  for (let up = n.parent; up !== undefined && !ts.isSourceFile(up); up = up.parent) {
    if (ts.isCallExpression(up)) return up;
    if (ts.isFunctionDeclaration(up) || ts.isMethodDeclaration(up) || ts.isArrowFunction(up)) break;
  }
  return n;
}

// Every occurrence of every member: the closed slots it flows into, plus the wide sink it was handed to.
const flows = new Map();
for (const sf of sources) {
  const visit = (node) => {
    if (ts.isStringLiteral(node) && MEMBER.test(node.text) && !inTypePosition(node)) {
      const p = node.parent;
      const slots = [];
      const push = (s) => { if (s !== null && s !== undefined && s.size >= 2) slots.push(s); };
      push(closedSet(checker.getContextualType(node)));
      // an inline list is an inline vocabulary: `new Set(["alive","dead","ailing","pending","disabled"])` is a
      // CanaryLiveness guard, and a literal sitting in it belongs to the canary, not to whoever shares a spelling
      if (ts.isArrayLiteralExpression(p)) push(new Set(p.elements.filter(ts.isStringLiteral).map((e) => e.text)));
      if (ts.isBinaryExpression(p) && EQ.has(p.operatorToken.kind)) {
        push(closedSet(checker.getTypeAtLocation(p.left === node ? p.right : p.left)));
        for (const s of enclosingReturnSets(node)) push(s);
      }
      if (ts.isCaseClause(p)) for (const s of enclosingReturnSets(node)) push(s);
      if (ts.isPropertyAssignment(p) && p.name === node) {
        const objCtx = checker.getContextualType(p.parent);
        if (objCtx !== undefined) push(new Set(objCtx.getProperties().map((s) => s.name)));
      }
      const table = slots.length === 0 ? enclosingTable(node) : null;
      if (table !== null) for (const s of slotsOfTable(table)) push(s);
      const l = flows.get(node.text) ?? [];
      const rel = path.relative(ROOT, sf.fileName);
      l.push({ slots, node, sink: wideSinkVocab(node), decl: declArrays.has(p), blind: CONSOLE_CONSTANT_MODULES.has(rel), wire: wireCall(node) !== null || exactLiteralSlot(node), at: `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${ts.SyntaxKind[p.kind]}` });
      flows.set(node.text, l);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}


// The gate's own report needs the old shape (name -> {members, file}), so it is projected off the typed scan.
const vocab = new Map(vocabList.map((v) => [v.name, { members: v.checked, file: v.file, v }]));

// calledSomewhere: the mapper is INVOKED outside its own `export function` definition. A mapper nothing calls
// puts nothing in the ring, and its whole vocabulary is dead however well-formed the map is.
const calledSomewhere = (fn) => {
  for (const [, s] of src) {
    const body = s.replace(new RegExp(`export function ${fn}\\b`, "g"), "");
    if (new RegExp(`\\b${fn}\\(`).test(body)) return true;
  }
  return false;
};

indexFieldDefs(src);
const ALL_SRC = [...src.values()].join("\n");

// ITERATED: the vocabulary is walked to BUILD the surface that produces it -- `for (const reason of
// RESTORE_REJECT_REASONS)` builds the reject picker's radio list, so every member is a button the operator can
// press and no member literal is written anywhere. A `new Set(V)` is NOT this: that is a gate, and it produces
// nothing. The loop must exist, or the members are dead.
const _ITERATION = /(?:for\s*\(\s*const\s+\w+\s+of\s+|\.map\(|\.forEach\()/;
const iterated = (name) => new RegExp(`for\\s*\\(\\s*const\\s+\\w+\\s+of\\s+${name}\\b|\\b${name}\\.map\\(|\\b${name}\\.forEach\\(`).test(TYPED_SRC);

// FEEDERS: a closed world whose VALUE is handed to this vocabulary's recorder, so the member literal is written
// under the feeder's type and never under the vocabulary's own. update-console-check.ts passes the served-version
// read class straight through (`readClass === "ok" ? "wrong-version" : readClass`) into recordConsoleBuildCheck,
// so "non-json" and "unstamped" are written in console-version.ts as a ServedVersionReadClass and are real
// producers of the build-check class. The feeder's own literals are checked where they are declared.
const FEEDERS = { CLIENT_DIAG_BUILD_CHECK_CLASSES: ["ServedVersionReadClass"] };
const feederSets = (v) =>
  (FEEDERS[v.name] ?? []).map((alias) => {
    const m = TYPED_SRC.match(new RegExp(`type ${alias} = ([^;]+);`));
    if (m === null) { console.error(`DEAD-VOCAB GATE: FEEDERS[${v.name}] names a type that is gone: ${alias}`); process.exit(1); }
    return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  });

// ===========================================================================
// A PRODUCER COUNTS ONLY IF SOME CLIENT CAN REACH IT. Correct typing and a real call site are not enough: a
// bump guarded by `if (typeof body.component === "string")` -- SINGULAR -- is unreachable if every real client
// sends `components`, PLURAL, however correctly typed the call site is. The engine's own equivalent gate proves
// reachability the same way, against the request shapes its callers actually send.
//
// The console's version of the same defect runs the other way. The console does not receive requests: it
// receives the ENGINE'S ANSWERS and the OPERATOR'S KEYSTROKES, and those two are its only clients. A contract
// skew family such as CLIENT_DIAG_FIELD_FAMILIES asserts THE ENGINE HANDED THIS CONSOLE A VALUE IT DID NOT
// RECOGNISE, so a producer guarded by a CONSOLE-SIDE CONSTANT (see CONSOLE_CONSTANT_MODULES above) can never
// fire: no engine, of any version, on any account, can move a guard this repo's own constants decide.
//
// SO A GUARD DECIDED ENTIRELY BY CONSTANTS THIS REPO SHIPS IS ONE NO ENGINE AND NO OPERATOR CAN MOVE: whatever
// it evaluates to, it evaluates to that on every render, for every customer, for ever. When it evaluates to
// "branch not taken", the producer inside it is unreachable and the member it writes is dead vocabulary with a
// live-looking call site.
//
// CONSERVATIVE BY CONSTRUCTION, because the failure mode of this check is DELETING A LIVE MEMBER. A value is
// constant only if it is PROVED constant: a module-level `const` built from literals, never assigned into and
// never mutated, or a parameter every one of whose call-site arguments is itself proved constant, or a binding
// over a proved-constant array. Everything else -- a wire read, a DOM read, a call, an import, a `let`, a shape
// the evaluator does not model -- is UNKNOWN, and an UNKNOWN guard never prunes. The check only subtracts what
// it can prove.
//
// AND IT FAILS RATHER THAN SKIPS: CONSOLE_CONSTANT_MODULES above still fails loudly if a module named there is
// renamed away, and this check reports what it prunes rather than quietly dropping it.
// ===========================================================================

// mutated: is this symbol ever written into? `const CACHE = {}` followed by `CACHE[k] = v` is not a constant, and
// folding it would be the exact "delete a live member" failure. Checked over every use, not assumed from `const`.
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "set", "add", "delete", "clear", "fill", "copyWithin"]);
function mutated(sym) {
  for (const use of identUses.get(sym) ?? []) {
    const p = use.parent;
    if (p === undefined) continue;
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === use) {
      const g = p.parent;
      if (ts.isBinaryExpression(g) && g.left === p && g.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && g.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
      if (ts.isCallExpression(g) && g.expression === p && ts.isPropertyAccessExpression(p) && MUTATORS.has(p.name.text)) return true;
      if (ts.isDeleteExpression(g)) return true;
    }
    if (ts.isBinaryExpression(p) && p.left === use) return true;
  }
  return false;
}
// litValue: the JS value of an expression built ONLY from literals (and proved-constant references). null means
// "not provably constant".
const NOT_CONST = Symbol("not-const");
const constCache = new Map();
function litValue(node, depth = 0) {
  if (depth > 20 || node === undefined) return NOT_CONST;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return litValue(node.expression, depth + 1);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node) && node.text === "undefined") return undefined;
  if (ts.isArrayLiteralExpression(node)) {
    const out = [];
    for (const e of node.elements) {
      const v = litValue(e, depth + 1);
      if (v === NOT_CONST) return NOT_CONST;
      out.push(v);
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out = {};
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p) || (!ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name))) return NOT_CONST;
      const v = litValue(p.initializer, depth + 1);
      if (v === NOT_CONST) return NOT_CONST;
      out[p.name.text] = v;
    }
    return out;
  }
  if (ts.isIdentifier(node)) {
    const sym = checker.getSymbolAtLocation(node);
    if (sym === undefined) return NOT_CONST;
    const cached = constCache.get(sym);
    if (cached !== undefined) return cached;
    constCache.set(sym, NOT_CONST); // a self-referential const is not evidence
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (decl === undefined || !ts.isVariableDeclaration(decl) || decl.initializer === undefined) return NOT_CONST;
    if ((ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) === 0) return NOT_CONST; // a `let` is reassigned
    if (mutated(sym)) return NOT_CONST;
    const v = litValue(decl.initializer, depth + 1);
    constCache.set(sym, v);
    return v;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const o = litValue(node.expression, depth + 1);
    if (o === NOT_CONST || o === null || o === undefined) return NOT_CONST;
    return Object.hasOwn(o, node.name.text) ? o[node.name.text] : (node.name.text === "length" && Array.isArray(o) ? o.length : undefined);
  }
  if (ts.isElementAccessExpression(node)) {
    const o = litValue(node.expression, depth + 1);
    const k = litValue(node.argumentExpression, depth + 1);
    if (o === NOT_CONST || k === NOT_CONST || o === null || o === undefined) return NOT_CONST;
    return Object.hasOwn(o, String(k)) ? o[k] : undefined;
  }
  return NOT_CONST;
}
// paramDomain: the values a parameter can hold, when every call site of its function passes a proved constant. A
// function used as a VALUE (a callback, an export re-bound) has call sites this gate cannot see, so it is UNKNOWN.
const paramCache = new Map();
function paramDomain(sym) {
  const hit = paramCache.get(sym);
  if (hit !== undefined) return hit;
  paramCache.set(sym, null);
  const decl = sym.valueDeclaration;
  if (decl === undefined || !ts.isParameter(decl)) return null;
  const fn = decl.parent;
  if (!ts.isFunctionDeclaration(fn) && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null;
  const idx = fn.parameters.indexOf(decl);
  if (idx === -1 || decl.dotDotDotToken !== undefined) return null;
  let nameNode = null;
  if (ts.isFunctionDeclaration(fn) && fn.name !== undefined) nameNode = fn.name;
  else if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) nameNode = fn.parent.name;
  if (nameNode === null) return null;
  const fnSym = checker.getSymbolAtLocation(nameNode);
  if (fnSym === undefined) return null;
  const vals = [];
  for (const use of identUses.get(fnSym) ?? []) {
    if (use === nameNode) continue;
    const p = use.parent;
    if (p === undefined || !ts.isCallExpression(p) || p.expression !== use) return null; // used as a value: unseen call sites
    const arg = p.arguments[idx];
    const v = arg === undefined ? undefined : litValue(arg);
    if (v === NOT_CONST) return null;
    vals.push(v);
  }
  if (vals.length === 0) return null;
  paramCache.set(sym, vals);
  return vals;
}
// domainOf: the finite set of values an expression can take, or null (unknown). Constants have a one-value domain;
// a parameter fed only from constants has the domain of its call sites.
function domainOf(node) {
  const v = litValue(node);
  if (v !== NOT_CONST) return [v];
  if (ts.isIdentifier(node)) {
    const sym = checker.getSymbolAtLocation(node);
    return sym === undefined ? null : paramDomain(sym);
  }
  return null;
}
// evalConst: evaluate a guard over one assignment of its free variables. Returns NOT_CONST when it cannot fold.
function evalConst(node, bind, depth = 0) {
  if (depth > 24) return NOT_CONST;
  const rec = (n) => evalConst(n, bind, depth + 1);
  if (node === undefined) return NOT_CONST;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return rec(node.expression);
  if (ts.isIdentifier(node) && bind.has(node.text)) return bind.get(node.text);
  if (ts.isTypeOfExpression(node)) {
    const v = rec(node.expression);
    return v === NOT_CONST ? NOT_CONST : v === null ? "object" : typeof v;
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const v = rec(node.operand);
    return v === NOT_CONST ? NOT_CONST : !v;
  }
  if (ts.isConditionalExpression(node)) {
    const c = rec(node.condition);
    return c === NOT_CONST ? NOT_CONST : c ? rec(node.whenTrue) : rec(node.whenFalse);
  }
  // A lookup THROUGH a bound variable: `MARKS[key]` with key bound to one of its call-site values. This shape
  // is folded here rather than left to litValue (which cannot see the binding).
  if (ts.isPropertyAccessExpression(node)) {
    const o = rec(node.expression);
    if (o === NOT_CONST || o === null || o === undefined) return NOT_CONST;
    if (Object.hasOwn(o, node.name.text)) return o[node.name.text];
    return node.name.text === "length" && (Array.isArray(o) || typeof o === "string") ? o.length : undefined;
  }
  if (ts.isElementAccessExpression(node)) {
    const o = rec(node.expression), k = rec(node.argumentExpression);
    if (o === NOT_CONST || k === NOT_CONST || o === null || o === undefined) return NOT_CONST;
    return Object.hasOwn(o, String(k)) ? o[k] : undefined;
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (callee.getText() === "Array.isArray" && node.arguments.length === 1) {
      const v = rec(node.arguments[0]);
      return v === NOT_CONST ? NOT_CONST : Array.isArray(v);
    }
    if (ts.isPropertyAccessExpression(callee) && (callee.name.text === "includes" || callee.name.text === "indexOf") && node.arguments.length === 1) {
      const o = rec(callee.expression), a = rec(node.arguments[0]);
      if (o === NOT_CONST || a === NOT_CONST || (!Array.isArray(o) && typeof o !== "string")) return NOT_CONST;
      return callee.name.text === "includes" ? o.includes(a) : o.indexOf(a);
    }
    return NOT_CONST;
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      const l = rec(node.left);
      if (l === NOT_CONST) return NOT_CONST;
      return l ? rec(node.right) : l;
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      const l = rec(node.left);
      if (l === NOT_CONST) return NOT_CONST;
      return l ? l : rec(node.right);
    }
    if (op === ts.SyntaxKind.QuestionQuestionToken) {
      const l = rec(node.left);
      if (l === NOT_CONST) return NOT_CONST;
      return l === null || l === undefined ? rec(node.right) : l;
    }
    if (EQ.has(op)) {
      const a = rec(node.left), b = rec(node.right);
      if (a === NOT_CONST || b === NOT_CONST) return NOT_CONST;
      const strict = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      const eq = strict ? a === b : a === b; // eslint-disable-line eqeqeq
      return op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken ? !eq : eq;
    }
    return NOT_CONST;
  }
  const v = litValue(node);
  return v;
}
// freeConstVars: the identifiers a guard reads that have a PROVED finite domain. If any identifier in the guard is
// not one of them and not foldable on its own, the guard is unknown and nothing is pruned.
function guardVerdict(cond) {
  const vars = new Map(); // name -> domain
  let unknown = false;
  const scan = (n) => {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isMemberName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n);
      if (!isMemberName && !vars.has(n.text)) {
        if (litValue(n) === NOT_CONST) {
          const d = domainOf(n);
          if (d === null) unknown = true;
          else vars.set(n.text, d);
        }
      }
    }
    ts.forEachChild(n, scan);
  };
  scan(cond);
  if (unknown) return undefined;
  const names = [...vars.keys()];
  const outs = new Set();
  const walkCombos = (i, bind) => {
    if (outs.has(undefined)) return;
    if (i === names.length) {
      const v = evalConst(cond, bind);
      outs.add(v === NOT_CONST ? undefined : Boolean(v));
      return;
    }
    for (const val of vars.get(names[i])) walkCombos(i + 1, new Map(bind).set(names[i], val));
  };
  walkCombos(0, new Map());
  if (outs.has(undefined) || outs.size !== 1) return undefined;
  return [...outs][0];
}
const reachStats = { constGuarded: new Set(), pruned: new Set() };
const reachCache = new Map();
// unreachable: no engine answer and no operator keystroke takes the branch this occurrence sits in, because the
// branch is decided by constants this repo ships.
function unreachable(node) {
  const hit = reachCache.get(node);
  if (hit !== undefined) return hit;
  reachCache.set(node, false);
  let verdict = false;
  let sawConstGuard = false;
  for (let n = node; n.parent !== undefined && !ts.isSourceFile(n); n = n.parent) {
    const p = n.parent;
    let cond = null, want = null;
    if (ts.isIfStatement(p)) {
      if (p.thenStatement === n) { cond = p.expression; want = true; }
      else if (p.elseStatement === n) { cond = p.expression; want = false; }
    } else if (ts.isConditionalExpression(p)) {
      if (p.whenTrue === n) { cond = p.condition; want = true; }
      else if (p.whenFalse === n) { cond = p.condition; want = false; }
    } else if (ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      cond = p.left; want = true;
    }
    if (cond === null) continue;
    const v = guardVerdict(cond);
    if (v === undefined) continue;
    sawConstGuard = true;
    if (v !== want) verdict = true;
  }
  // ONE LEVEL OUT (the sibling-site discipline). The literal is often not written in the guarded branch but in a
  // helper the branch calls. A helper whose EVERY call site is unreachable is itself unreachable. Bails to
  // REACHABLE the moment it cannot see all the call sites: a function used as a value (a callback, a re-export, a
  // handler passed to h()) has callers this gate cannot enumerate, and that is most of a UI.
  if (!verdict) {
    const fn = enclosingNamedFunction(node);
    const sites = fn === null ? null : allCallSites(fn);
    if (sites !== null && sites.length > 0 && sites.every((s) => unreachable(s))) verdict = true;
  }
  const key = `${node.getSourceFile().fileName}:${node.getStart()}`;
  if (sawConstGuard) reachStats.constGuarded.add(key);
  if (verdict) reachStats.pruned.add(key);
  reachCache.set(node, verdict);
  return verdict;
}
function enclosingNamedFunction(node) {
  for (let n = node.parent; n !== undefined && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)) return n;
  }
  return null;
}
// allCallSites: every call of this function in src, or null when they cannot all be seen.
function allCallSites(fn) {
  let nameNode = null;
  if (ts.isFunctionDeclaration(fn) && fn.name !== undefined) nameNode = fn.name;
  else if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) nameNode = fn.parent.name;
  if (nameNode === null) return null;
  const sym = checker.getSymbolAtLocation(nameNode);
  if (sym === undefined) return null;
  const out = [];
  for (const use of identUses.get(sym) ?? []) {
    if (use === nameNode) continue;
    const p = use.parent;
    if (p === undefined || !ts.isCallExpression(p) || p.expression !== use) return null; // used as a value
    out.push(p);
  }
  return out;
}

const producedTyped = (v, mem) =>
  iterated(v.name) ||
  feederSets(v).some((f) => f.has(mem)) ||
  (flows.get(mem) ?? []).some((o) => {
    if (o.decl) return false; // a literal in ANY vocabulary's declaration is a declaration, not a producer
    if (o.blind) return false; // a producer whose input is a CONSOLE-SIDE CONSTANT can never be reached by wire data
    if (unreachable(o.node)) return false; // the branch is decided by a constant this repo ships, and it is not taken
    if (o.sink?.includes(v.name)) return true;
    if (o.slots.length > 0) return o.slots.some((s) => related(s, v));
    return !o.wire;
  });

const dead = [];
for (const [name, entry] of vocab) {
  const { members, file } = entry;
  if (name === "CLIENT_DIAG_FORM_FIELDS") {
    for (const mem of members) {
      if (formFieldProducer(mem, ALL_SRC, src) === null) {
        dead.push({ vocab: name, member: mem, file: path.relative(ROOT, file), why: FIELD_DEFS.has(mem) ? "its control has no validator that can refuse a value the operator TYPED (an absent validator, or one that only rejects the empty string), is never refused and is never named at a recordFormRefused call site -- and field.ts records nothing for an empty value, on purpose" : "no control in the console has this id" });
      }
    }
    continue;
  }
  const sm = SET_MEMBERSHIP[name];
  if (sm !== undefined) {
    if (!calledSomewhere(sm.mapper)) {
      for (const mem of members) dead.push({ vocab: name, member: mem, file: path.relative(ROOT, file), why: `its mapper ${sm.mapper} is never called` });
      continue;
    }
    for (const mem of members) {
      if (!sm.produces(mem)) dead.push({ vocab: name, member: mem, file: path.relative(ROOT, file), why: sm.why(mem) });
    }
    continue;
  }
  for (const mem of members) {
    // TYPED: the member must be written into a slot of ITS OWN vocabulary. A literal that only ever lands in
    // another vocabulary's slot is not a producer of this one.
    if (producedTyped(entry.v, mem)) continue;
    const occs = (flows.get(mem) ?? []).filter((o) => !o.decl);
    const why = occs.length > 0 && occs.every((o) => o.blind || unreachable(o.node))
      ? "every producer sits behind a guard DECIDED BY A CONSTANT THIS REPO SHIPS, so no engine answer and no operator keystroke can take that branch"
      : "no occurrence of the literal flows into a slot of THIS vocabulary (a literal that only appears as another enum's member is not a producer)";
    dead.push({ vocab: name, member: mem, file: path.relative(ROOT, file), why });
  }
}

// FLOORS ON THE DENOMINATOR. Everything above reasons about members the scan FOUND; the PASS below says
// every member has a producer, which over an empty scan is true and says nothing. The vocabularies are
// discovered by walking src and reading `export const NAME = [...] as const`, so emptiness is an
// ordinary accident rather than sabotage: src moves, the declaration idiom changes, or the walk's
// extension filter is edited. The floors sit well under what this console actually declares, so REMOVING
// a dead member (which is one of the two fixes this gate demands) never trips them, while a collapse
// cannot be reported as clean.
const MIN_VOCABULARIES = 30;
const MIN_CHECKED_MEMBERS = 250;
let checkedMembers = 0;
for (const entry of vocab.values()) checkedMembers += entry.members.length;
if (vocab.size < MIN_VOCABULARIES || checkedMembers < MIN_CHECKED_MEMBERS) {
  console.error(`\nDEAD-VOCAB GATE: FAIL -- scanned ${vocab.size} closed vocabularies holding ${checkedMembers} members, expected at least ${MIN_VOCABULARIES} and ${MIN_CHECKED_MEMBERS}.\n`);
  console.error("The scan is no longer reading this console's closed vocabularies, so it cannot say whether any member is");
  console.error("dead. Check that src/ is where the walk looks and that the vocabularies still declare themselves as an");
  console.error("exported `as const` list. A pass over nothing is the one answer this gate must never give.");
  process.exit(1);
}

console.log(`DEAD-VOCAB GATE: ${vocab.size} closed vocabularies scanned, holding ${checkedMembers} checked members (client-diag twins exempt: they are received, not emitted)`);
console.log(`DEAD-VOCAB GATE: reachability: ${reachStats.constGuarded.size} producer occurrence(s) sit behind a guard this repo's own constants decide; ${reachStats.pruned.size} unreachable by any engine or operator`);
if (dead.length === 0) {
  console.log("DEAD-VOCAB GATE: PASS -- every member has a producer");
  process.exit(0);
}
const byVocab = {};
for (const d of dead) {
  byVocab[d.vocab] ??= [];
  byVocab[d.vocab].push(d.member);
}
console.error(`\nDEAD-VOCAB GATE: FAIL -- ${dead.length} member(s) can NEVER be emitted.\n`);
console.error("Each one is a promise the pack cannot keep. Either WIRE the producer at the fault site, or REMOVE");
console.error("the member. Leaving it tells a support engineer the evidence was looked for and not found.\n");
for (const [v, ms] of Object.entries(byVocab)) {
  console.error(`  ${v} (${byVocab[v].length}) -- ${/** @type {{file: string}} */ (vocab.get(v)).file.replace(`${ROOT}/`, "")}`);
  for (const m of ms) { const d = dead.find((x) => x.vocab === v && x.member === m); console.error(`      ${m}${d?.why !== undefined ? ` -- ${d.why}` : ""}`); }
}
process.exit(1);
