#!/usr/bin/env node
// STEP-UP ANNOUNCE GATE. Every write the engine will demand a fresh identity check for must have told the
// operator that a passkey prompt may appear, and that a dismissed prompt leaves nothing behind, BEFORE the
// prompt opens. The population is the WRITES, not the confirmations in front of them.
//
// WHY THE POPULATION IS THE WRITES, and it is the whole reason this file exists. Judging the copy of a
// CONFIRMATION, rather than the write itself, misses a gated write with NO confirmation at all: such a
// write sits in neither the numerator nor the denominator of a confirmation-shaped count, so it reads as
// invisible rather than failing. The onboarding wizard is exactly that shape when it slips through: two
// gated writes with no confirmation and nothing counting them.
//
// THREE SHAPES CAN MAKE A WRITE INVISIBLE to a check that judges confirmations, and only the first is
// "nobody wrote a confirmation":
//   1. no dialogue at all, a button that writes on click;
//   2. a real confirmation that a text-based parse can miss seeing, because it is typeToConfirm
//      (components/confirm.ts) rather than confirmModal / openModal. The restore and destination
//      force-remove sites, the highest-blast-radius confirmations in the console, are in this class;
//   3. a real confirmation whose write is HOISTED into a sibling function, so the write is not inside the
//      modal's enclosing function any more. It reaches the write either by the modal's action naming the
//      handler (notifications, security-centre) or by the handler awaiting a confirm helper (the two
//      restore applies). This class grows every time a large screen file is split into smaller ones.
//
// SO A SITE IS SATISFIED IN ONE OF THREE WAYS, and the failure message says which one it looked for:
//   CONFIRMED  a confirmation dialogue governs the write, and THAT DIALOGUE'S OWN copy carries both claims.
//              Three governing relations, all narrow, matching the three shapes above.
//   ANNOUNCED  no dialogue governs it, and the copy sits beside the control instead: the sentence appears in
//              the write's enclosing functions, or in a same-file function that names one of them (the render
//              that wires the button). This is the right answer for a control with no confirmation of its own.
//   EXEMPT     a STEP-UP UNANNOUNCED: comment inside the enclosing function gives the reason. Exemptions are
//              printed on every run, so they are read rather than forgotten, and a marker that governs no
//              gated write fails as stale.
//
// THE HOP DOWN IS DELIBERATELY NARROW. Scoping each write to a one-hop closure in both directions goes
// QUIET on a real defect: destination-cards-actions.ts wires Make default, Replace and Remove from one
// render function, only Remove confirms, and a two-way closure would hand Remove's sentence to Make
// default. So the hop down runs from the INNERMOST enclosing function only, and only to a same-file
// function that itself contains a dialogue and is named before the write.
//
// THE BODY DISCRIMINATION, without which this gate would demand a promise of a prompt that never comes.
// POST /restore is one static sub carrying two actions: a read-only dry-run and the data-overwriting apply.
// The engine gates it INSIDE the `body.confirm === true` branch (router-restore.ts), so three of the five
// console restore call sites open no prompt at all. Requiring the sentence on a dry-run would be the same
// defect as the silent prompt, mirrored. The discriminating field is read out of the engine the same way
// the engine's own structural check reads it
// (validate-session.ts: find the condition, then assert requireStepUp sits in the branch it opens), and a
// console site counts as gated only when its enclosing function carries that field set true. If the field is
// derived and NO console site carries it, that is a parse that has stopped matching and the gate refuses:
// silently excusing the single most consequential mutation this console performs is not an acceptable green.
//
// IT REFUSES RATHER THAN PASSES on every zero: no gated methods, no call sites, the positive control absent,
// the ungated control contributing sites, or a stale exemption. A zero numerator reads exactly like a
// compliant console, and that is the failure this family of gates is most likely to have.
//
//   node scripts/stepup-announce-gate.mjs              the gate
//   node scripts/stepup-announce-gate.mjs --self-test  three attacks, in memory, before the gate runs
//
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { functionBodies, innermostContaining } from "./function-bodies.mjs";
import { deriveEngineGatedMethods, matchBlock, stripComments, walk } from "./stepup-gated-set.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// NAMES_PROMPT: the copy tells the operator a passkey prompt may appear. The first alternative is the wording
// this console standardised on; the rest are the forms already in use when this predicate was written, kept
// so the gate tests the claim rather than one phrasing of it. "May be asked", never "will be": a session
// already carrying a fresh step-up token satisfies the engine without a second ceremony.
const NAMES_PROMPT = /asked to confirm with your own passkey|approve the (?:passkey )?prompt|step-up prompt will|you will be asked to re-?authenticate/i;

// SAYS_DISMISSAL: the copy says what a dismissed or failed ceremony leaves behind. requireStepUp runs before
// the engine's dispatch switch, so a refused prompt writes nothing at all, and an operator told only that a
// prompt may appear is left guessing whether dismissing it half-completed an irreversible action. The bound
// keeps the two claims inside one sentence, so a stray "nothing" elsewhere cannot stand in.
//
// THE SECOND ALTERNATIVE IS NOT COSMETIC. Accepting only the word "nothing" would push a correct sentence
// towards a vaguer one to satisfy a regex: the onboarding grant says "no role is granted" instead, which is
// the more precise claim of the two, naming what did not happen. So the negated-consequence form is
// accepted on its own terms.
const SAYS_DISMISSAL = /dismiss[^.]{0,200}(?:\bnothing\b|\bno\b[^.]{0,40}\b(?:is|are|was|were)\b)/i;

// The dialogue vocabulary. typeToConfirm is here because leaving it out is what hid the restore applies and
// the destination force-remove, which are the three highest-blast-radius confirmations in the console.
const DIALOGUE = /\b(confirmModal|openModal|typeToConfirm)\s*\(/g;

// The exemption marker. It lives in the source beside the write, not in a list here, so the reason is read by
// whoever next edits that screen rather than by whoever next edits this gate.
const EXEMPT_MARKER = /STEP-UP UNANNOUNCED:\s*(\S.*)/g;
const EXEMPT_REASON_MIN = 40;

// The controls.
//   POSITIVE_CONTROL   a gated write that must be in the population and must resolve CONFIRMED.
//   UNGATED_CONTROL    a screen full of confirmations for writes the engine does NOT gate. It must contribute
//                      ZERO sites: if it ever contributes one, this gate has started demanding a promise of a
//                      ceremony that never appears, which is the same defect mirrored.
//   DRY_RUN_CONTROL    a call site on the multiplexed /restore route that omits confirm. It must be EXCLUDED
//                      by the body discrimination, and its confirm:true siblings must be included.
const POSITIVE_CONTROL = { file: "src/screens/access-security/signin-factors.ts", method: "revokeSignInFactors" };
const UNGATED_CONTROL = "src/screens/sources-downpipes/detail-actions.ts";
const DRY_RUN_CONTROL = { file: "src/screens/restore-flow/flow.ts", method: "restore" };

// The files whose own declarations are not call sites.
const NOT_CALL_SITES = new Set(["src/components/modal.ts", "src/components/confirm.ts"]);

// copyScope resolves the copy a customer actually reads for one dialogue: the options object, plus the
// construction of whatever identifier is passed as `body` or `extra`. Four shapes are in use and all four are
// followed: an inline string, an inline node tree (already inside the options), a local node built by
// appendChild above the call, and a file-local builder function.
function copyScope(optsBlock, fnBody, fileFnByName) {
  const parts = [optsBlock.body];
  for (const key of ["body", "extra"]) {
    const expr = propertyValue(optsBlock.body, key);
    // Only a bare identifier or a builder call leads somewhere else. Pulling every identifier out of a
    // template literal or an h(...) tree would drag half the enclosing function in and the check goes quiet.
    const ident =
      expr === null ? null
      : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(expr) ? expr
      : /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(expr)?.[1] ?? null;
    if (ident === null || ident === "h") continue;
    const fn = fileFnByName.get(ident);
    if (fn) parts.push(fn.body);
    else for (const stmt of statementsMentioning(fnBody, ident)) parts.push(stmt);
  }
  return parts.join("\n");
}

// propertyValue reads the value expression of `key` from an object-literal source, by depth, so a comma
// inside a nested call or a ternary does not end it early. `body,` shorthand answers "body".
function propertyValue(obj, key) {
  const short = new RegExp(`[{,\\s]${key}\\s*(?:,|\\n\\s*\\})`).exec(obj);
  const kv = new RegExp(`[{,\\s]${key}\\s*:`).exec(obj);
  if (kv === null) return short === null ? null : key;
  let i = kv.index + kv[0].length;
  let depth = 0;
  const start = i;
  for (; i < obj.length; i++) {
    const c = obj[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < obj.length && obj[i] !== q) {
        if (obj[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
  }
  return obj.slice(start, i).trim();
}

// statementsMentioning returns each whole statement in `fnBody` that touches `ident`, so a node built by a
// multi-line appendChild is read with the copy inside it. A line-by-line scan misses exactly that: the
// identifier is on the first line and the sentence is four lines down.
function statementsMentioning(fnBody, ident) {
  const out = [];
  const re = new RegExp(`\\b${ident}\\b`, "g");
  for (let m = re.exec(fnBody); m !== null; m = re.exec(fnBody)) {
    let depth = 0;
    let i = m.index;
    for (; i < fnBody.length; i++) {
      const c = fnBody[i];
      if (c === '"' || c === "'" || c === "`") {
        const q = c;
        i++;
        while (i < fnBody.length && fnBody[i] !== q) {
          if (fnBody[i] === "\\") i++;
          i++;
        }
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === ";" && depth <= 0) break;
    }
    out.push(fnBody.slice(m.index, i));
    re.lastIndex = i;
  }
  return out;
}

// readFileModel parses one screen file once: the stripped source (for every structural question), the raw
// source (for the exemption markers, which are comments and would be blanked), and the function bodies.
function readFileModel(read, file) {
  const raw = read(file);
  const src = stripComments(raw);
  const bodies = functionBodies(src);
  const byName = new Map();
  for (const b of bodies) if (b.name !== "" && !byName.has(b.name)) byName.set(b.name, b);
  const dialogues = [];
  DIALOGUE.lastIndex = 0;
  for (let m = DIALOGUE.exec(src); m !== null; m = DIALOGUE.exec(src)) {
    const fn = innermostContaining(bodies, m.index);
    if (fn === null) continue;
    const opts = matchBlock(src, m.index + m[0].length - 1);
    dialogues.push({ at: m.index, kind: m[1], fn, opts });
  }
  // Exemption markers, read out of the RAW source and mapped to a stripped-source offset by line, because
  // stripComments blanks them before anything else can see them.
  const exemptions = [];
  EXEMPT_MARKER.lastIndex = 0;
  for (let m = EXEMPT_MARKER.exec(raw); m !== null; m = EXEMPT_MARKER.exec(raw)) {
    const line = raw.slice(0, m.index).split("\n").length;
    exemptions.push({ line, reason: m[1].trim(), at: offsetOfLine(src, line), used: false });
  }
  return { raw, src, bodies, byName, dialogues, exemptions, imports: importMap(file, src) };
}

function offsetOfLine(src, line) {
  let at = 0;
  for (let i = 1; i < line; i++) {
    const nl = src.indexOf("\n", at);
    if (nl < 0) return at;
    at = nl + 1;
  }
  return at;
}

// ---- the ONE customer action: which dialogue, if any, governs this write ---------------------------------
//
// Three relations, each narrow, each matching one of the three shapes the console actually uses.
// The groups are kept APART rather than merged, and the reason is a measured false positive. A form modal
// whose action calls the submit handler (relation b) and a confirmation NESTED inside that handler
// (relation a) both govern the same write: roles-members.ts opens the member form, and only the Grant Owner
// step inside it runs a ceremony. Merging them and demanding the sentence from every governor would force
// the FORM to warn about a prompt that only a further confirmation leads to. So a write is satisfied when
// any ONE relation is satisfied, and satisfied within a relation means EVERY dialogue in it carries the
// sentence: the two branches of a confirm helper (a large restore takes typeToConfirm, a small one
// confirmModal) are the same governor, and a customer only ever sees one of them.
function governingDialogues(model, at, inner, chain) {
  const sameFunction = [];
  const namedByModal = [];
  const confirmHelper = [];
  for (const d of model.dialogues) {
    // (a) THE SAME FUNCTION. A dialogue that opens AFTER the write is a result panel, not a confirmation
    // (security-centre/access.ts shows the one-time recovery codes once regenerateRecoveryCodes has already
    // returned), so a call at the dialogue's own level counts only when it follows the dialogue. A call
    // inside a NESTED function runs after the decision whatever its source position.
    if (d.fn.start <= at && at < d.fn.end) {
      if ((inner !== null && inner.start !== d.fn.start) || at > d.at) {
        sameFunction.push(d);
        continue;
      }
    }
    // (b) THE MODAL NAMES THE HANDLER. openModal({ actions: [{ onClick: () => submitChannelForm(...) }] })
    // with the write inside submitChannelForm. The write is in no enclosing function of the modal, and this
    // is the shape that appears whenever a form submit handler is hoisted into its own function.
    if (d.opts !== null && chain.some((f) => f.name !== "" && new RegExp(`\\b${f.name}\\b`).test(d.opts.body))) {
      namedByModal.push(d);
    }
  }
  // (c) THE HANDLER AWAITS A CONFIRM HELPER, whose whole job is to return the dialogue's answer:
  // `const confirmed = await confirmRowApply(row); if (!confirmed) return;` then the write. Three
  // constraints keep it narrow. The hop runs from the INNERMOST enclosing function only, because hopping
  // from the whole enclosing chain would hand Remove's confirmation to the Make default button wired beside
  // it in the same render. It follows only an AWAITED call before the write, because
  // destination-cards-actions.ts mentions offerForceRemove in an error branch it never took. And the helper
  // must RETURN a dialogue, which is what distinguishes a confirm helper from any other function that
  // happens to open one.
  if (inner !== null) {
    const before = inner.body.slice(0, at - inner.start);
    for (const m of before.matchAll(/await\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
      const helper = model.byName.get(m[1]);
      if (!helper || helper.start === inner.start) continue;
      if (!/return\s+(?:await\s+)?(?:confirmModal|openModal|typeToConfirm)\s*\(/.test(helper.body)) continue;
      for (const d of model.dialogues) {
        if (d.fn.start >= helper.start && d.fn.end <= helper.end && !confirmHelper.includes(d)) confirmHelper.push(d);
      }
    }
  }
  // Narrowest first: the confirmation in the handler itself, then the helper it awaited, then the form modal
  // that named it. The first non-empty group is the one a failure is reported against.
  return [sameFunction, confirmHelper, namedByModal].filter((g) => g.length > 0);
}

// crossFileDialogues is relation (b) reaching into ANOTHER module, and it is the last shape that could hide a
// write. notifications/rules.ts builds the rule form and opens the modal; the save handler it names lives in
// notifications/rule-form.ts, because the pair was split for size. The write is in the second file and every
// word the customer reads is in the first, so nothing in one file can answer for it. The match is exact in
// both directions: the modal's options must name the function, and the naming file's own import of that name
// must resolve to the file the write is in, so two unrelated same-named functions cannot be paired.
function crossFileDialogues(models, file, chain) {
  const out = [];
  const wanted = chain.map((b) => b.name).filter((n) => n !== "" && n !== "h");
  if (wanted.length === 0) return out;
  for (const [otherFile, other] of models) {
    if (otherFile === file) continue;
    for (const d of other.dialogues) {
      if (d.opts === null) continue;
      for (const name of wanted) {
        if (!new RegExp(`\\b${name}\\b`).test(d.opts.body)) continue;
        const target = other.imports.get(name);
        if (target === undefined) continue;
        if (target !== file && `${target}.ts` !== file && target !== file.replace(/\.ts$/, "")) continue;
        out.push({ ...d, model: other, file: otherFile });
        break;
      }
    }
  }
  return out;
}

// enclosingCalls lists, for one offset, the identifiers of every CALL whose argument list lexically contains
// it, innermost last. A write inside `renderTokenApply({ apply: (token) => engine.installKeys(...) })` is
// inside a call to renderTokenApply, and that is the control the operator is actually looking at.
function enclosingCalls(src, at) {
  const stack = [];
  const hits = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "(") {
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j--;
      const end = j + 1;
      while (j >= 0 && /[A-Za-z0-9_$]/.test(src[j])) j--;
      stack.push({ name: src.slice(j + 1, end), open: i });
    } else if (c === ")") {
      const s = stack.pop();
      if (s !== undefined && s.name !== "" && s.open < at && at < i) hits.push(s.name);
    }
  }
  return hits;
}

// importMap reads the file's relative named imports as name -> resolved absolute path. It is what lets both
// cross-file relations be answered without guessing: which control a write sits inside, and which screen's
// modal calls a handler that a different module holds.
function importMap(file, src) {
  const out = new Map();
  const re = /import\s*\{([^}]*)\}\s*from\s*"(\.[^"]*)"/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const target = path.resolve(path.dirname(file), m[2]);
    for (const raw of m[1].split(",")) {
      const parts = raw.trim().split(/\s+as\s+/);
      const name = (parts[parts.length - 1] ?? "").trim();
      if (name !== "") out.set(name, target);
    }
  }
  return out;
}

// importedFunction resolves `name` through the file's own relative imports and returns that function's body.
// It is ONE hop, to a path the file itself names, and it exists because a shared CONTROL owns the copy that
// belongs beside it: renderTokenApply prints the token box and the Apply button on four different key
// screens, and renderCustodyStep prints the Send button that emails a custodian their share on three. Copy
// duplicated into every host screen would drift; copy in the control is read once, beside the button.
function importedFunction(read, file, src, name) {
  const re = /import\s*\{([^}]*)\}\s*from\s*"(\.[^"]*)"/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    if (!m[1].split(",").some((x) => (x.trim().split(/\s+as\s+/)[0] ?? "").trim() === name)) continue;
    const target = path.resolve(path.dirname(file), m[2]);
    let body;
    try {
      body = stripComments(read(target));
    } catch {
      return null;
    }
    const fn = functionBodies(body).find((b) => b.name === name);
    return fn ? fn.body : null;
  }
  return null;
}

// announceScope is the copy a control with NO dialogue can carry. Three parts, each a bounded hop:
//   the write's own enclosing functions;
//   every same-file function that NAMES one of them, which is the render that wires the button and prints
//   the hint above it (where the onboarding wizard's two announcements live). It hops UP only, because
//   hopping DOWN would hand one button's confirmation to another wired beside it;
//   the imported control the write sits INSIDE the call to, which is the button the operator pressed.
function announceScope(read, file, model, chain, at) {
  const parts = chain.map((b) => b.body);
  const chainNames = chain.map((b) => b.name).filter((x) => x !== "" && x !== "h");
  if (chainNames.length > 0) {
    for (const b of model.bodies) {
      if (chain.some((cf) => cf.start === b.start)) continue;
      if (chainNames.some((nm) => new RegExp(`\\b${nm}\\b`).test(b.body))) parts.push(b.body);
    }
  }
  for (const name of enclosingCalls(model.src, at)) {
    const body = importedFunction(read, file, model.src, name);
    if (body !== null) parts.push(body);
  }
  return parts.join("\n");
}

// judge runs the whole gate against a reader, so the self-test can drive it over patched sources in memory.
export function judge(read) {
  const failures = [];
  const { methods: gatedMethods, discriminators, problems, engineRoot, skipped } = deriveEngineGatedMethods(ROOT);
  if (skipped) return { failures, gatedMethods, discriminators, sites: 0, confirmed: 0, announced: 0, exempt: [], files: 0, engineRoot, skipped: true };
  failures.push(...problems);

  const files = [...walk(path.join(ROOT, "src/screens")), ...walk(path.join(ROOT, "src/components"))];
  let sites = 0;
  let confirmed = 0;
  let announced = 0;
  const exempt = [];
  let positiveControlSeen = false;
  let ungatedControlSites = 0;
  let dryRunControlExcluded = false;
  const discriminated = new Map([...discriminators.keys()].map((m) => [m, 0]));

  // Every file is parsed ONCE, up front, because the cross-file relation has to ask what other screens say
  // about a handler this one holds.
  const models = new Map();
  for (const file of files) {
    if (NOT_CALL_SITES.has(path.relative(ROOT, file).split(path.sep).join("/"))) continue;
    models.set(file, readFileModel(read, file));
  }

  for (const [file, model] of models) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const { src, bodies } = model;

    for (const method of gatedMethods) {
      const callRe = new RegExp(`\\.${method}\\s*\\(`, "g");
      for (let c = callRe.exec(src); c !== null; c = callRe.exec(src)) {
        const at = c.index;
        const inner = innermostContaining(bodies, at);
        const chain = bodies.filter((b) => b.start <= at && at < b.end).sort((x, y) => x.end - x.start - (y.end - y.start));
        const line = src.slice(0, at).split("\n").length;

        // THE BODY DISCRIMINATION. A method whose engine route gates on a parsed body field is a gated write
        // only where that field is set. The field is read out of the enclosing function rather than the call
        // arguments because restore-flow/confirm.ts builds `applyReq` one statement above the call, and a
        // scan of the arguments alone would score the single most consequential write in the console as a
        // harmless dry-run.
        const field = discriminators.get(method);
        if (field !== undefined) {
          const armed = inner !== null && new RegExp(`\\b${field}\\s*:\\s*true\\b`).test(inner.body);
          if (!armed) {
            if (rel === DRY_RUN_CONTROL.file && method === DRY_RUN_CONTROL.method) dryRunControlExcluded = true;
            continue;
          }
          discriminated.set(method, (discriminated.get(method) ?? 0) + 1);
        }

        sites++;
        if (rel === UNGATED_CONTROL) ungatedControlSites++;
        if (rel === POSITIVE_CONTROL.file && method === POSITIVE_CONTROL.method) positiveControlSeen = true;
        const where = `${rel}:${line} (${method}(), in ${inner === null || inner.name === "" ? "an anonymous handler" : inner.name})`;

        // 1. CONFIRMED. The dialogue's OWN copy is what is read, not the whole function: a sentence in a
        // different modal beside this one cannot satisfy it. Where several dialogues govern one write (a
        // confirm helper that branches between typeToConfirm and confirmModal), EVERY branch must carry it.
        const groups = governingDialogues(model, at, inner, chain);
        const crossFile = crossFileDialogues(models, file, chain);
        if (crossFile.length > 0) groups.push(crossFile);
        if (groups.length > 0) {
          const verdicts = groups.map((group) => {
            const complaints = [];
            for (const d of group) {
              const home = d.model ?? model;
              const dwhere = d.file === undefined ? `line ${src.slice(0, d.at).split("\n").length}` : `${path.relative(ROOT, d.file).split(path.sep).join("/")}:${home.src.slice(0, d.at).split("\n").length}`;
              const dline = dwhere;
              if (d.opts === null) {
                complaints.push(`${where}: could not read the options object of the ${d.kind} at ${dline} that governs this write, so its copy was not checked.`);
                continue;
              }
              const scope = copyScope(d.opts, d.fn.body, home.byName);
              if (!NAMES_PROMPT.test(scope)) {
                complaints.push(
                  `${where}: the ${d.kind} at ${dline} confirms this step-up-gated write and never mentions the passkey prompt the engine will open. Say that one may appear before the action runs, in that dialogue's own copy. The wording this console standardised on is at ${POSITIVE_CONTROL.file}.`,
                );
              } else if (!SAYS_DISMISSAL.test(scope)) {
                complaints.push(
                  `${where}: the ${d.kind} at ${dline} names the passkey prompt but not what a dismissed prompt leaves behind. The engine's check runs before it dispatches, so a dismissed prompt writes nothing; say so in the same sentence, or the prompt reads as a fault mid-action.`,
                );
              }
            }
            return complaints;
          });
          if (verdicts.some((v) => v.length === 0)) {
            confirmed++;
            continue;
          }
          failures.push(...(verdicts[0] ?? []));
          continue;
        }

        // 2. ANNOUNCED. No dialogue governs this write, so the copy has to sit beside the control.
        const scope = announceScope(read, file, model, chain, at);
        if (NAMES_PROMPT.test(scope) && SAYS_DISMISSAL.test(scope)) {
          announced++;
          continue;
        }

        // 3. EXEMPT. A reason in the source, inside the enclosing function, read and reported every run.
        const marker = inner === null ? undefined : model.exemptions.find((e) => e.at >= inner.start && e.at < inner.end);
        if (marker !== undefined) {
          marker.used = true;
          if (marker.reason.length < EXEMPT_REASON_MIN) {
            failures.push(`${rel}:${marker.line}: this STEP-UP UNANNOUNCED marker gives no usable reason ("${marker.reason}"). Say why an operator meeting an unannounced passkey prompt here is the right outcome.`);
          } else {
            exempt.push(`${rel}:${line} ${method}() -- ${marker.reason}`);
          }
          continue;
        }

        failures.push(
          `${where}: this write is step-up gated and the operator is told nothing. No confirmation governs it, and no copy beside the control mentions the passkey prompt, so a browser credential sheet opens with no warning. Either say it beside the control (the wording is at ${POSITIVE_CONTROL.file}), give it a confirmation that says it, or write a "STEP-UP UNANNOUNCED: <reason>" comment inside ${inner === null || inner.name === "" ? "the handler" : inner.name}.`,
        );
      }
    }

    for (const e of model.exemptions) {
      if (!e.used) {
        failures.push(`${rel}:${e.line}: this STEP-UP UNANNOUNCED marker governs no step-up-gated write. Either the write moved out of this function or it is no longer gated; remove the marker rather than leaving a reason for something that is not there.`);
      }
    }
  }

  if (sites === 0) {
    failures.push("REFUSING TO PASS: found zero step-up-gated write call sites in src/screens and src/components. The parse has stopped matching, which is not the same as a console that never writes.");
  }
  if (!positiveControlSeen) {
    failures.push(`REFUSING TO PASS: positive control ${POSITIVE_CONTROL.file} ${POSITIVE_CONTROL.method}() is a step-up-gated write and was not in the population.`);
  }
  if (ungatedControlSites > 0) {
    failures.push(`REFUSING TO PASS: ungated control ${UNGATED_CONTROL} contributed ${ungatedControlSites} site(s). Its writes are not gated by the engine, so this gate would be demanding a promise of a ceremony that never appears.`);
  }
  for (const [method, field] of discriminators) {
    if (!dryRunControlExcluded && method === DRY_RUN_CONTROL.method) {
      failures.push(`REFUSING TO PASS: ${DRY_RUN_CONTROL.file} calls ${method}() without ${field}:true and the discrimination did not exclude it, so the gate is about to demand a warning about a prompt that never opens on a read-only leg.`);
    }
    if ((discriminated.get(method) ?? 0) === 0) {
      failures.push(`REFUSING TO PASS: the engine gates ${method}()'s route only on ${field}, and NO console call site was scored as carrying ${field}:true. That is a parse that has stopped matching, not a console that never applies; it would silently excuse the most consequential write on that route.`);
    }
  }

  return { failures, gatedMethods, sites, confirmed, announced, exempt, files: files.length, engineRoot, skipped: false, discriminators };
}

const readFile = (f) => readFileSync(f, "utf8");

// ---- the three attacks, run in memory so they cost nothing and cannot be skipped -------------------------
function selfTest() {
  const problems = [];
  const victim = path.join(ROOT, POSITIVE_CONTROL.file);
  const original = readFileSync(victim, "utf8");

  // ATTACK ONE, THE BLIND SPOT THIS GATE EXISTS TO CLOSE. Add a gated write with no confirmation and no
  // announcement, and require a red that NAMES it. A confirmation-only check leaves this invisible: it sits
  // in neither the numerator nor the denominator, and would print a confident pass.
  //
  // The injected handler is deliberately its own top-level function with nothing else in it, so the hop UP
  // finds no copy: a write bolted into an existing screen is exactly the shape that ships unannounced.
  const inject = path.join(ROOT, UNGATED_CONTROL);
  const injectSrc = readFileSync(inject, "utf8");
  const injected = `${injectSrc}\nasync function selfTestSilentGatedWrite(engine, id) {\n  await engine.rotateBreakGlass(id, "x");\n}\n`;
  {
    const { failures } = judge((f) => (f === inject ? injected : readFileSync(f, "utf8")));
    const named = failures.filter((x) => x.includes(UNGATED_CONTROL) && x.includes("told nothing"));
    if (named.length === 0) {
      problems.push("self-test attack one: a step-up-gated write with no confirmation and no announcement was added and the gate did not report it. The population is not the writes.");
    }
  }

  // ATTACK TWO, the copy half. Remove the standard sentence from the control's confirmation and require a red
  // that names it. A gate that cannot be made to fail on the exact defect it describes is decoration.
  {
    const stripped = original.replace(/"You may be asked to confirm with your own passkey[^"]*",?\n?/, "");
    if (stripped === original) {
      problems.push(`self-test attack two: could not remove the prompt sentence from ${POSITIVE_CONTROL.file}, so it proved nothing. The standard wording has moved; update the patch.`);
    } else {
      const { failures } = judge((f) => (f === victim ? stripped : readFileSync(f, "utf8")));
      const named = failures.filter((x) => x.includes(POSITIVE_CONTROL.file) && x.includes("never mentions the passkey prompt"));
      if (named.length === 0) {
        problems.push(`self-test attack two: with the prompt sentence removed from ${POSITIVE_CONTROL.file} the gate did not report it. It is not reading the copy it claims to read.`);
      }
    }
  }

  // ATTACK THREE, the converse, because a gate that demanded the sentence everywhere would be just as wrong.
  // The ungated control's writes are not gated by the engine and its confirmations say nothing about a
  // passkey prompt. It must contribute nothing, and the dry-run leg of the multiplexed restore route must
  // stay out of the population for the same reason.
  {
    const { failures, sites, discriminators } = judge(readFile);
    const falsePositives = failures.filter((x) => x.startsWith(UNGATED_CONTROL));
    if (falsePositives.length > 0) {
      problems.push(`self-test attack three: the gate flagged ${falsePositives.length} site(s) in ${UNGATED_CONTROL}, whose writes the engine does not gate. It is forcing a promise of a ceremony that will never be shown.`);
    }
    const ungatedSrc = stripComments(readFileSync(path.join(ROOT, UNGATED_CONTROL), "utf8"));
    if (NAMES_PROMPT.test(ungatedSrc)) {
      problems.push(`self-test attack three: ${UNGATED_CONTROL} now mentions a passkey prompt, so it can no longer show that an ungated screen passes while silent. Choose a different ungated control.`);
    }
    if (discriminators.size === 0) {
      problems.push("self-test attack three: no body-discriminated route was derived from the engine, so nothing proves the read-only leg of a multiplexed route is excluded.");
    }
    if (sites === 0) problems.push("self-test attack three: the population is empty, so a green here means nothing.");
  }

  if (problems.length > 0) {
    for (const p of problems) console.error(`  FAIL ${p}`);
    console.error(`\nstepup-announce-gate --self-test: ${problems.length} failure(s).`);
    process.exit(1);
  }
  console.log("stepup-announce-gate --self-test: PASS -- a gated write with no confirmation and no announcement turns this gate red and names it, removing the standard sentence from the control confirmation turns it red and names it, and the ungated screen plus the read-only restore leg stay out of the population.");
}

const verdict = judge(readFile);
if (verdict.skipped) {
  // A console-only checkout cannot read the engine's gated set, and guessing it from gatedFetch alone would
  // demand a promise on routes the engine deliberately exempts. REQUIRE_ENGINE=1, which validate:workspace
  // sets, turns the same absence into a refusal: where the engine is always present a skip reads as a pass.
  const why = "no engine checkout found beside this one, so the engine's gated set could not be read";
  if (process.env.REQUIRE_ENGINE === "1") {
    console.error(`stepup-announce-gate: FAIL, ${why}. Set DOWNPIPES_ENGINE, or check the engine out beside this repo.`);
    process.exit(2);
  }
  console.log(`stepup-announce-gate: skipped, ${why} (set REQUIRE_ENGINE=1 to refuse instead).`);
  process.exit(0);
}

// The attacks run BEFORE the verdict, and only once the engine has been found: a self-test over an empty
// gated set would prove nothing and print a confident pass.
if (process.argv.includes("--self-test")) selfTest();

const { failures, gatedMethods, sites, confirmed, announced, exempt, files, engineRoot } = verdict;
const summary = `stepup-announce-gate: engine at ${engineRoot}, ${gatedMethods.size} gated EngineClient method(s); ${sites} gated write(s) across ${files} file(s), ${confirmed} confirmed, ${announced} announced beside the control, ${exempt.length} exempt`;
if (exempt.length > 0) {
  console.log(`${summary}\n\nExempt, with the reason each was given:`);
  for (const e of exempt) console.log(`  - ${e}`);
  console.log("");
}
if (failures.length > 0) {
  if (exempt.length === 0) console.error(`${summary}\n`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  console.error(`\nstepup-announce-gate: ${failures.length} failure(s).`);
  process.exit(1);
}
if (exempt.length === 0) console.log(`${summary}; 0 failures.`);
console.log("stepup-announce-gate: PASS -- every step-up-gated write in the console either confirms, announces beside the control, or carries a written reason for staying silent.");
