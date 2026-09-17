// THE DERIVED STEP-UP SET, shared by every gate that has to answer "is this write one the engine will
// demand a fresh identity check for". It enumerates nothing.
//
// WHY IT IS A MODULE RATHER THAN A CONSTANT. A hand-maintained list drifts from the engine's own gated set:
// test/validate-stepup-dest-idp.ts drives a fixed list of client methods through a scripted 401, and a route
// the engine starts gating after that list is written has no call site checked against it. So the set is
// computed, in two steps:
//   1. every client function in src/lib/api/client-*.ts whose body calls t.gatedFetch (gatedFetch is the
//      only thing in this console that runs the ceremony);
//   2. every EngineClient method in src/lib/api/client.ts that delegates to one of those.
// The binding back to the ENGINE's own STEPUP_SUBS is scripts/stepup-call-site-gate.mjs's job: it reads
// the engine's Set and fails when a member's console call site is on plain engineFetch. Given that gate is
// green, "calls gatedFetch" and "the engine gates it" are the same set, and this module is the console-side
// half that the copy gates can read without a sibling engine checkout.
//
// IT REFUSES RATHER THAN PASSES. deriveGatedSet returns `problems`, non-empty whenever the parse stopped
// matching (zero gatedFetch functions, zero mapped methods, or a positive control missing). Callers must
// treat a non-empty problems array as a failure: a zero numerator reads exactly like a compliant console,
// and that is the failure these gates are most likely to have.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// The controls on the derivation itself. Each is a known gatedFetch caller from a different client file, so
// a parse that silently narrows to one file is caught rather than believed.
export const DERIVATION_CONTROLS = ["setRole", "rotateBreakGlass", "mintSupportCredential"];

// stripComments blanks line and block comments so a comment that NAMES the thing under test (a gate's own
// prose, or a screen's explanation of why it branches) can never satisfy or trip a source test. String
// literals are left alone: the copy is the thing under test. Every comment byte becomes a space and newlines
// are kept, so offsets and line numbers are identical to the file on disk.
//
// IT IS A SCANNER, NOT TWO REGEXES, and the difference is not cosmetic. A regex that strips only leading
// `^[ \t]*//.*$` line comments lets a TRAILING comment survive, and a trailing comment containing an
// apostrophe can open a string literal that runs for thousands of characters and swallows every brace in the
// rest of the file, leaving a brace-matching gate seeing zero functions and silently judging nothing.
// Blanking comments in one pass, with the string and regex-literal rules the language actually has, is what
// stops a gate going quiet on a file rather than red.
export function stripComments(src) {
  const out = src.split("");
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  // A `/` opens a regex literal (rather than dividing) when the last significant character cannot end an
  // expression. This is the standard disambiguation and it only has to be right for the sources in this repo.
  const REGEX_OK = /[(,=:[!&|?{};+\-*%~^<>]/;
  let prev = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const j = close < 0 ? src.length : close + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      prev = c;
      continue;
    }
    if (c === "/" && (prev === "" || REGEX_OK.test(prev) || /\breturn$|\btypeof$|\bcase$/.test(src.slice(Math.max(0, i - 7), i)))) {
      i++;
      let inClass = false;
      while (i < src.length && (inClass || src[i] !== "/")) {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "\n") break;
        i++;
      }
      i++;
      prev = "/";
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

// walk lists every .ts file under dir, recursively.
export function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

// matchBlock returns the source of the { ... } block that starts at or after `from`, by brace depth. Strings
// and template literals are skipped so a brace inside copy cannot unbalance the count.
export function matchBlock(src, from) {
  const start = src.indexOf("{", from);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
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
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { start, body: src.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

// deriveGatedSet computes the two sets from a console checkout root.
export function deriveGatedSet(root) {
  const api = path.join(root, "src/lib/api");
  const problems = [];

  const gatedFns = new Set();
  for (const f of readdirSync(api).filter((x) => x.endsWith(".ts"))) {
    const lines = stripComments(readFileSync(path.join(api, f), "utf8")).split("\n");
    let cur = null;
    for (const l of lines) {
      const m = /^export async function ([A-Za-z0-9_]+)/.exec(l);
      if (m) cur = m[1];
      if (cur && /\bt\.gatedFetch\(/.test(l)) gatedFns.add(cur);
    }
  }
  if (gatedFns.size === 0) {
    problems.push(
      "REFUSING TO PASS: parsed zero client functions calling t.gatedFetch. The parse has stopped matching src/lib/api/client-*.ts, which is not the same as a console with no gated writes.",
    );
  }
  for (const control of DERIVATION_CONTROLS) {
    if (gatedFns.size > 0 && !gatedFns.has(control)) {
      problems.push(`REFUSING TO PASS: positive control "${control}" is a known gatedFetch caller and the parse did not find it.`);
    }
  }

  const gatedMethods = new Set();
  {
    const lines = stripComments(readFileSync(path.join(api, "client.ts"), "utf8")).split("\n");
    let cur = null;
    for (const l of lines) {
      const m = /^\s{2}(?:async\s+)?([A-Za-z0-9_]+)\s*\(/.exec(l);
      if (m) cur = m[1];
      const r = /return\s+[A-Za-z0-9_]+\.([A-Za-z0-9_]+)\(/.exec(l);
      if (cur && r && gatedFns.has(r[1])) gatedMethods.add(cur);
    }
  }
  if (gatedMethods.size === 0 && gatedFns.size > 0) {
    problems.push(
      "REFUSING TO PASS: mapped zero EngineClient methods onto the gatedFetch functions. src/lib/api/client.ts's delegation shape has changed and this gate is reading nothing.",
    );
  }

  return { gatedFns, gatedMethods, problems };
}


// ---- the ENGINE's own answer, which is a DIFFERENT question ---------------------------------------------
//
// deriveGatedSet above answers "could this call site surface the step-up marker": gatedFetch is the only
// thing in this console that runs the ceremony, so only a catch behind one of those can ever print
// "<verb>: stepup-required: 401". That is the right authority for failure copy and the WRONG one for a
// PROMISE, because gatedFetch is a strict superset of what the engine gates. terminateOtherSessions is
// routed through it in readiness for a route the engine has deliberately kept exempt
// ("/sessions/terminate-others is SELF-scoped only"), so a modal telling that operator to expect a passkey
// prompt promises a sheet that will never appear. That is the same defect as the silent prompt, mirrored.
//
// SO THIS READS THE ENGINE, and it reads all three of the sets the engine itself maintains rather than the
// one that is easy to find:
//   STEPUP_SUBS         (router-core.ts)      gated by exact `sub` membership;
//   STEPUP_INLINE_GATED (test/validate-session.ts) gated, but on a parsed BODY action a Set cannot see;
//   STEPUP_DOMAIN_EXEMPT (same file)          reviewed and deliberately NOT gated, with the reason.
// Plus the two dual-control approvals, whose per-request ULID makes Set membership structurally impossible
// and which router.ts gates on the parsed action instead.
//
// AND IT REFUSES ON ANYTHING LEFT OVER. A console route that runs the ceremony and appears in none of those
// four is a route nobody has classified, and guessing either way writes a false sentence at a customer: call
// it gated and the modal promises a sheet that may never come, call it ungated and the sheet arrives
// unannounced. Two such routes exist, both under /admin/auth/*, which the engine dispatches before authorise()
// and therefore outside its own structural sweep, so they are resolved by reading the engine source ONE HOP:
// the dispatch literal, then the handler that branch calls, then whether that handler calls requireStepUp.
// A third such route would fail this rather than be assumed.
import { functionBodies, innermostContaining } from "./function-bodies.mjs";

const ENGINE_ROUTER = "src/admin/router-core.ts";
const ENGINE_SPOKE = "src/admin/router.ts";
const ENGINE_SESSION_TEST = "test/validate-session.ts";
const SUBS_POSITIVE_CONTROLS = ["/keys/rotate", "/roles/delete"];
const SUBS_NEGATIVE_CONTROL = "/sessions/terminate-others";

// stringLiterals yields every string / template literal with its offset, by scanning. A regex over `"..."`
// pairs quotes naively and mis-pairs the moment two literals sit on one line: the closing quote of the first
// binds to the opening quote of the second, every later offset shifts, and whole literals become invisible.
// A naive pairing regex would misread the engine's own `sub === "recovery-codes/regenerate"` dispatch this
// way.
export function stringLiterals(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c !== '"' && c !== "'" && c !== "`") continue;
    const start = i;
    i++;
    while (i < src.length && src[i] !== c) {
      if (src[i] === "\\") i++;
      i++;
    }
    out.push({ index: start, value: src.slice(start + 1, i) });
  }
  return out;
}

export function findEngineRoot(root) {
  const override = process.env.DOWNPIPES_ENGINE || process.env.ENGINE_WORKTREE;
  const candidates = override ? [override] : [path.resolve(root, "../engine"), path.resolve(root, "../../engine")];
  return candidates.find((c) => existsSync(path.resolve(c, ENGINE_ROUTER))) ?? null;
}

function parseSet(src, name) {
  const m = new RegExp(`${name}[^=]*=\\s*new Set(?:<[^>]*>)?\\(\\[([\\s\\S]*?)\\]\\)`).exec(src);
  return m === null ? null : new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

// inlineGatedByOneHop answers, from the engine's own source, whether the handler for `sub` calls
// requireStepUp. It finds the dispatch literal (a suffix of the console's path), then either the enclosing
// function already calls requireStepUp, or the branch calls a handler that does.
function inlineGatedByOneHop(adminFiles, sub) {
  for (const f of adminFiles) {
    for (const m of f.literals) {
      const lit = m.value;
      if (lit.length < 8) continue;
      if (!sub.endsWith(lit) && !sub.endsWith(`/${lit}`)) continue;
      const owner = innermostContaining(f.bodies, m.index);
      if (owner !== null && /requireStepUp\(/.test(owner.body)) return true;
      const branch = matchBlock(f.src, m.index);
      if (branch === null) continue;
      for (const c of branch.body.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
        for (const g of adminFiles) {
          const target = g.byName.get(c[1]);
          if (target && /requireStepUp\(/.test(target.body)) return true;
        }
      }
    }
  }
  return false;
}

// discriminatorIn answers, from a slice of engine source, which BODY FIELD decides whether the step-up check
// runs: the field of a `<something>.<field> === true` test whose branch contains the requireStepUp call. This
// is the engine's own idiom for a route that multiplexes a safe and a dangerous action on one static sub, and
// it is read here exactly the way the engine's own structural check reads it (validate-session.ts: find the
// condition, then assert requireStepUp sits inside the branch it opens).
//
// WHY A CALLER NEEDS IT. POST /restore carries both the read-only dry-run and the data-overwriting apply.
// Scoring every call site of the client's restore() as gated would make a copy gate demand a warning about a
// passkey prompt on three console call sites where no prompt ever opens, which is the same defect as the
// silent prompt with its sign flipped.
function discriminatorIn(text) {
  for (const m of text.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\.([A-Za-z0-9_$]+)\s*===\s*true\b/g)) {
    const blk = matchBlock(text, m.index);
    if (blk === null) continue;
    if (/requireStepUp\(/.test(blk.body)) return m[1];
  }
  return null;
}

// discriminatorForSub locates a sub's dispatch case in the engine's admin source and reads its discriminating
// body field. The literal is matched exactly, as the sub or as the router's `POST <sub>` case label; a near
// miss returns null, and the caller refuses rather than assuming the route is unconditionally gated.
function discriminatorForSub(adminFiles, sub) {
  for (const f of adminFiles) {
    for (const m of f.literals) {
      if (m.value !== sub && m.value !== `POST ${sub}`) continue;
      const blk = matchBlock(f.src, m.index);
      const text = blk === null ? (innermostContaining(f.bodies, m.index)?.body ?? "") : blk.body;
      const field = discriminatorIn(text);
      if (field !== null) return field;
    }
  }
  return null;
}

// deriveEngineGatedMethods returns the EngineClient methods whose route the ENGINE will demand a fresh
// identity check for. `skipped` is set when no engine checkout sits beside this one; callers decide whether
// that is a skip or a refusal, the convention scripts/stepup-call-site-gate.mjs already uses.
//
// `discriminators` maps a method whose route is gated on a parsed body field to that field's name. A caller
// that judges COPY must apply it (a dry-run leg warrants no warning); a caller that judges the transport, as
// scripts/stepup-call-site-gate.mjs does, must ignore it (the client function is the same one either way).
export function deriveEngineGatedMethods(root) {
  const problems = [];
  const discriminators = new Map();
  const engineRoot = findEngineRoot(root);
  if (engineRoot === null) return { methods: new Set(), subs: new Set(), discriminators, engineRoot: null, skipped: true, problems };

  const routerSrc = stripComments(readFileSync(path.resolve(engineRoot, ENGINE_ROUTER), "utf8"));
  const subs = parseSet(routerSrc, "STEPUP_SUBS");
  if (subs === null) {
    problems.push(`REFUSING TO PASS: STEPUP_SUBS could not be parsed out of the engine's ${ENGINE_ROUTER}. Scoring every route as ungated would read as a console with nothing to warn about.`);
    return { methods: new Set(), subs: new Set(), discriminators, engineRoot, skipped: false, problems };
  }
  const missing = SUBS_POSITIVE_CONTROLS.find((c) => !subs.has(c));
  if (subs.size < 20 || missing !== undefined || subs.has(SUBS_NEGATIVE_CONTROL)) {
    problems.push(
      `REFUSING TO PASS: the parsed set does not look like STEPUP_SUBS (${subs.size} members${missing === undefined ? "" : `, missing ${missing}`}${subs.has(SUBS_NEGATIVE_CONTROL) ? `, and ${SUBS_NEGATIVE_CONTROL} is exempt in the engine yet present` : ""}).`,
    );
    return { methods: new Set(), subs, discriminators, engineRoot, skipped: false, problems };
  }

  const sessionTestPath = path.resolve(engineRoot, ENGINE_SESSION_TEST);
  if (!existsSync(sessionTestPath)) {
    problems.push(`REFUSING TO PASS: the engine's ${ENGINE_SESSION_TEST} is not where it was, so its inline-gated and reviewed-exempt sets cannot be read and the leftover routes could not be classified.`);
    return { methods: new Set(), subs, discriminators, engineRoot, skipped: false, problems };
  }
  const sessionSrc = stripComments(readFileSync(sessionTestPath, "utf8"));
  const inlineGated = parseSet(sessionSrc, "STEPUP_INLINE_GATED");
  const domainExempt = parseSet(sessionSrc, "STEPUP_DOMAIN_EXEMPT");
  if (inlineGated === null || domainExempt === null || !domainExempt.has(SUBS_NEGATIVE_CONTROL)) {
    problems.push(`REFUSING TO PASS: the engine's STEPUP_INLINE_GATED / STEPUP_DOMAIN_EXEMPT sets could not be read from ${ENGINE_SESSION_TEST} (the exempt set must contain ${SUBS_NEGATIVE_CONTROL}).`);
    return { methods: new Set(), subs, discriminators, engineRoot, skipped: false, problems };
  }

  const spoke = path.resolve(engineRoot, ENGINE_SPOKE);
  const approveGates = existsSync(spoke)
    ? [...stripComments(readFileSync(spoke, "utf8")).matchAll(/\.action === "approve"\)\s*\{[\s\S]{0,200}?requireStepUp\(/g)].length
    : 0;
  if (approveGates < 2) {
    problems.push(`REFUSING TO PASS: the engine's router gates ${approveGates} approve action(s) with requireStepUp; two are expected, so the dynamic half of this set cannot be trusted.`);
    return { methods: new Set(), subs, discriminators, engineRoot, skipped: false, problems };
  }

  const adminDir = path.resolve(engineRoot, "src/admin");
  const adminFiles = walk(adminDir).map((p) => {
    const src = stripComments(readFileSync(p, "utf8"));
    const bodies = functionBodies(src);
    const byName = new Map();
    for (const b of bodies) if (b.name !== "" && !byName.has(b.name)) byName.set(b.name, b);
    return { src, bodies, byName, literals: stringLiterals(src) };
  });

  // The console's own gatedFetch POST call sites, each classified against the four engine answers. The
  // init-object window is a LOOKAHEAD, not part of the match: consuming it would swallow any call site
  // within 400 characters of the previous one. In client-restore.ts, /admin/restore/approve sits four lines
  // after /admin/restore/request, so a consuming window would score that file as having no approve call at
  // all.
  // The discriminating body field of every INLINE-gated route, read before the call sites are classified. A
  // member of STEPUP_INLINE_GATED is gated precisely BECAUSE a Set keyed on `sub` cannot see the body, so a
  // member whose field cannot be found is a parse that has stopped matching the engine, not a route with no
  // condition; refusing is the only safe answer, since assuming "gated everywhere" makes a copy gate demand a
  // warning on a read-only leg and assuming "gated nowhere" excuses the dangerous one.
  const subDiscriminator = new Map();
  for (const sub of inlineGated) {
    const field = discriminatorForSub(adminFiles, sub);
    if (field === null) {
      problems.push(
        `REFUSING TO PASS: ${sub} is in the engine's STEPUP_INLINE_GATED, which means it is gated on a parsed body field, and that field could not be read out of the engine's dispatch for it. Neither answer can be assumed: treating the route as gated everywhere demands a passkey warning on its read-only leg, and treating it as gated nowhere excuses its dangerous one.`,
      );
      continue;
    }
    subDiscriminator.set(sub, field);
  }

  const api = path.join(root, "src/lib/api");
  const CALL = /t\.gatedFetch\(\s*(`[^`]*`|"[^"]*")(?=([\s\S]{0,400}))/g;
  const BASE = ["$", "{t.base}"].join("");
  const fns = new Set();
  const fnDiscriminator = new Map();
  const unclassified = [];
  for (const name of readdirSync(api).filter((x) => x.endsWith(".ts"))) {
    const text = stripComments(readFileSync(path.join(api, name), "utf8"));
    const decls = [...text.matchAll(/export async function ([A-Za-z0-9_]+)/g)].map((m) => ({ at: m.index, name: m[1] }));
    for (const m of text.matchAll(CALL)) {
      if (!/method:\s*"POST"/.test(m[2].slice(0, 300))) continue;
      const raw = m[1].slice(1, -1).replaceAll(BASE, "");
      let owner = null;
      for (const d of decls) if (d.at < m.index) owner = d.name;
      if (owner === null) continue;
      const line = text.slice(0, m.index).split("\n").length;
      if (raw.includes("${")) {
        const shape = raw.replace(/\$\{[^}]*\}/g, "<id>");
        if (shape.endsWith("/approve")) fns.add(owner);
        else if (!shape.endsWith("/reject")) unclassified.push(`${name}:${line} ${shape}`);
        continue;
      }
      const sub = raw.startsWith("/admin") ? raw.slice("/admin".length) : raw;
      if (subs.has(sub) || inlineGated.has(sub)) {
        fns.add(owner);
        const field = subDiscriminator.get(sub);
        if (field !== undefined) fnDiscriminator.set(owner, field);
      } else if (domainExempt.has(sub)) continue;
      else if (inlineGatedByOneHop(adminFiles, sub)) fns.add(owner);
      else unclassified.push(`${name}:${line} POST ${sub}`);
    }
  }
  if (unclassified.length > 0) {
    problems.push(
      `REFUSING TO PASS: ${unclassified.length} console call site(s) run the ceremony on a route the engine classifies nowhere (${unclassified.join("; ")}). Neither answer can be assumed: promising a passkey prompt that never comes and staying silent about one that does are the same defect. Add the route to the engine's STEPUP_SUBS, STEPUP_INLINE_GATED or STEPUP_DOMAIN_EXEMPT.`,
    );
  }
  if (fns.size === 0) {
    problems.push("REFUSING TO PASS: no client function resolved to a step-up-gated engine route. That is a broken parse rather than a console with nothing gated.");
  }

  const methods = new Set();
  const lines = stripComments(readFileSync(path.join(api, "client.ts"), "utf8")).split("\n");
  let cur = null;
  for (const l of lines) {
    const m = /^\s{2}(?:async\s+)?([A-Za-z0-9_]+)\s*\(/.exec(l);
    if (m) cur = m[1];
    const r = /return\s+[A-Za-z0-9_]+\.([A-Za-z0-9_]+)\(/.exec(l);
    if (cur && r && fns.has(r[1])) {
      methods.add(cur);
      const field = fnDiscriminator.get(r[1]);
      if (field !== undefined) discriminators.set(cur, field);
    }
  }
  if (methods.size === 0 && fns.size > 0) {
    problems.push("REFUSING TO PASS: mapped zero EngineClient methods onto the engine-gated client functions. client.ts's delegation shape has changed.");
  }
  if (subDiscriminator.size > 0 && discriminators.size === 0) {
    problems.push("REFUSING TO PASS: the engine gates a route on a parsed body field and no EngineClient method was mapped onto it, so a caller that judges copy would treat that route's read-only and data-overwriting legs identically.");
  }
  return { methods, subs, discriminators, engineRoot, skipped: false, problems };
}
