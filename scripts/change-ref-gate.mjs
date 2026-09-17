#!/usr/bin/env node
// CHANGE-REFERENCE GATE. An estate that has turned "Require Change Number" on believes every CAB-worthy
// config mutation the console performs is recorded against a change. This gate is what makes that sentence
// checkable, and it derives its population rather than listing it.
//
// WHY IT EXISTS. A change-controlled write can be wired more than once in the same file: one lever runs
// requireChange and threads the reference, while a second, separate listener calls the same method with
// the id alone. Both can run the identical confirmation, so the two say the same thing to the operator
// while only one of them actually records anything. The type system cannot catch this on its own, since
// `change?: ChangeRef` is optional at every one of these methods and the bypass compiles clean, and no
// test drives a rendered card's click.
//
// THE TWO RULES, and they are different failures.
//
//   SUPPLIED   Every call site of an EngineClient method that DECLARES `change?: ChangeRef` must pass one.
//              The declaration is the console's own statement that this write is change-controlled, so a
//              call site that omits the argument is a second wiring of a change-controlled write that
//              records nothing. A bare `undefined` counts as omitted: writing the word does not collect a
//              reference, and one call site already passed it while three lines above it a sibling threaded
//              the real thing.
//
//   CARRIED    Every reference the console COLLECTS must be read. A function that calls requireChange has
//              already interrupted the operator, taken a change number and put it in a variable; if that
//              variable's `.change` is never read, the reference was collected and dropped. This is the
//              worse of the two shapes and it is the one eyeballing does not find, because the screen looks
//              MORE compliant than a screen that never asks: a push-clear control that prompts for a
//              change number but never threads it into the write reads to the operator as no different
//              from one that carries the reference correctly.
//
// EXEMPTIONS LIVE IN THE SOURCE, NEVER HERE. A `CHANGE UNRECORDED: <reason>` comment inside the enclosing
// function excuses one unsupplied site, and every exemption is printed on every run so it is read rather
// than forgotten. A marker in a function with no unsupplied site FAILS AS STALE, so a reason cannot outlive
// the call it excuses and quietly become a blanket over whatever is written there next. The read-only legs
// of POST /restore are the real members: that route multiplexes a dry-run and an apply, and demanding a
// change number for a read is the same defect mirrored.
//
// IT REFUSES RATHER THAN PASSES on every zero: no change-accepting methods, no call sites, no collecting
// functions, or the positive controls absent. A zero numerator reads exactly like a compliant console, and
// that is the failure this family of gates is most likely to have.
//
//   node scripts/change-ref-gate.mjs              the gate
//   node scripts/change-ref-gate.mjs --self-test  four attacks, in memory, before the gate runs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { functionBodies, innermostContaining } from "./function-bodies.mjs";
import { stripComments, walk } from "./stepup-gated-set.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The EngineClient facade is where a method DECLARES that its write can carry a change reference. It is read
// rather than listed because the declaration is the thing that drifts: a method gains the parameter when
// someone wires change control for it, and every existing call site keeps compiling.
const FACADE = "src/lib/api/client.ts";

// The declaration files are not call sites of themselves.
const NOT_CALL_SITES = /^src\/lib\/api\//;

// The exemption marker and the floor on its reason. The floor is what stops "CHANGE UNRECORDED: n/a".
const EXEMPT_MARKER = /CHANGE UNRECORDED:\s*(\S.*)/g;
const EXEMPT_REASON_MIN = 40;

// The controls.
//   SUPPLY_CONTROL    a method that must be in the change-accepting set. If the facade parse stops matching,
//                     every call site scores as unjudged and the gate reads as a compliant console.
//   COLLECT_CONTROL   a screen that must contribute a collecting function. Same failure, other rule.
//   EXEMPT_CONTROL    a call site that must resolve EXEMPT. It proves the exemption path is reachable, so a
//                     marker that has stopped being read cannot make the whole read-only class silently pass
//                     as SUPPLIED.
const SUPPLY_CONTROL = "setDefaultDestination";
const COLLECT_CONTROL = "src/screens/destination-cards-actions.ts";
const EXEMPT_CONTROL = { file: "src/screens/restore-flow/flow.ts", method: "restore" };

// changeAcceptingMethods reads the facade and returns method name -> the ZERO-BASED position of its change
// parameter. Signatures on the facade are one line each by construction (it is a delegation table), which is
// why the parameter list can be read off the declaration rather than parsed as a type.
export function changeAcceptingMethods(read) {
  const src = stripComments(read(path.join(ROOT, FACADE)));
  const out = new Map();
  for (const line of src.split("\n")) {
    const m = /^\s{2}(?:async\s+)?([A-Za-z0-9_]+)\s*\(([^)]*)\)/.exec(line);
    if (m === null) continue;
    const params = m[2].split(",").map((s) => s.trim()).filter((s) => s !== "");
    const idx = params.findIndex((p) => /^change\??\s*:\s*ChangeRef/.test(p));
    if (idx >= 0) out.set(m[1], idx);
  }
  return out;
}

// topLevelArgs splits the argument list of the call whose `(` is at `open`, by nesting depth, skipping
// strings and template literals so a comma inside copy cannot shift an argument's position. It returns the
// argument TEXTS in order, or null when the list does not close.
function topLevelArgs(src, open) {
  const args = [];
  let depth = 0;
  let cur = "";
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      let j = i + 1;
      while (j < src.length && src[j] !== q) {
        if (src[j] === "\\") j++;
        j++;
      }
      cur += src.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      if (depth === 1) {
        cur = "";
        continue;
      }
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        if (cur.trim() !== "") args.push(cur.trim());
        return args;
      }
    } else if (c === "," && depth === 1) {
      args.push(cur.trim());
      cur = "";
      continue;
    }
    if (depth >= 1) cur += c;
  }
  return null;
}

// suppliesChange decides whether the argument at `idx` collects a reference. A missing argument and a bare
// `undefined` are the same thing to the engine: no X-Downpipes-Change header rides either way.
function suppliesChange(args, idx) {
  const a = args[idx];
  if (a === undefined) return false;
  return a !== "undefined";
}

// collectingFunctions finds every function body that calls requireChange, and reports whether the reference
// it collected is ever read. The binding is read off the call rather than assumed to be `cr`, so renaming it
// cannot make the check go quiet; a requireChange whose result is not bound at all cannot thread anything
// anywhere and is reported the same way.
function collectingFunctions(src, bodies, rel) {
  const found = [];
  const re = /requireChange\s*\(/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const at = m.index;
    // requireChange's own declaration is not a call of it. Matched on the shape rather than the filename so
    // moving the component does not silently drop the check.
    if (/\bfunction\s+$/.test(src.slice(Math.max(0, at - 20), at))) continue;
    const inner = innermostContaining(bodies, at);
    const line = src.slice(0, at).split("\n").length;
    // A requireChange the body scan cannot place is NOT a pass. scripts/function-bodies.mjs can fail to
    // see a function whose return type is a function type, or one whose return type holds a string
    // literal, and in both cases everything built on it would answer "an anonymous handler" for a whole
    // body rather than going red. Skipping here would make this gate the next one that cannot fail.
    if (inner === null) {
      found.push({ rel, line, name: null, used: false, fn: "", unplaced: true });
      continue;
    }
    // Read back for `const <name> = await requireChange(`; the await is optional so a stored promise is
    // still bound and still checkable.
    const before = src.slice(Math.max(0, at - 60), at);
    const bind = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:await\s+)?$/.exec(before);
    if (bind === null) {
      found.push({ rel, line, name: null, used: false, fn: inner.name });
      continue;
    }
    const used = new RegExp(`\\b${bind[1]}\\.change\\b`).test(inner.body);
    found.push({ rel, line, name: bind[1], used, fn: inner.name });
  }
  return found;
}

// judge runs the whole gate against a reader, so the self-test can drive it over patched sources in memory.
export function judge(read) {
  const failures = [];
  const methods = changeAcceptingMethods(read);
  if (methods.size === 0) {
    failures.push(
      `REFUSING TO PASS: parsed zero change-accepting methods out of ${FACADE}. Scoring every write as not change-controlled reads exactly like a console with nothing to record.`,
    );
    return { failures, methods, sites: 0, supplied: 0, exempt: [], collecting: 0 };
  }
  if (!methods.has(SUPPLY_CONTROL)) {
    failures.push(`REFUSING TO PASS: positive control ${SUPPLY_CONTROL}() declares a change parameter and the facade parse did not find it.`);
  }

  const files = walk(path.join(ROOT, "src")).filter((f) => !NOT_CALL_SITES.test(path.relative(ROOT, f).split(path.sep).join("/")));

  let sites = 0;
  let supplied = 0;
  const exempt = [];
  const unsupplied = [];
  const collecting = [];
  let exemptControlSeen = false;
  let collectControlSeen = false;

  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const src = stripComments(read(file));
    const bodies = functionBodies(src);

    // The markers, with the function each one sits in. A marker outside every function body cannot be tied
    // to a call site and is reported as stale rather than believed.
    const markers = [];
    {
      const raw = read(file);
      EXEMPT_MARKER.lastIndex = 0;
      for (let m = EXEMPT_MARKER.exec(raw); m !== null; m = EXEMPT_MARKER.exec(raw)) {
        const inner = innermostContaining(bodies, m.index);
        markers.push({ at: m.index, reason: m[1].trim(), fn: inner, line: raw.slice(0, m.index).split("\n").length, claimed: false });
      }
    }

    for (const [method, idx] of methods) {
      const callRe = new RegExp(`\\.${method}\\s*\\(`, "g");
      for (let c = callRe.exec(src); c !== null; c = callRe.exec(src)) {
        const at = c.index + c[0].length - 1;
        const args = topLevelArgs(src, at);
        if (args === null) continue;
        const line = src.slice(0, c.index).split("\n").length;
        const inner = innermostContaining(bodies, c.index);
        const where = `${rel}:${line} (${method}(), in ${inner === null || inner.name === "" ? "an anonymous handler" : inner.name})`;
        sites++;
        if (suppliesChange(args, idx)) {
          supplied++;
          continue;
        }
        // Unsupplied. An exemption marker inside the SAME enclosing function excuses it.
        const marker = markers.find((k) => inner !== null && k.fn !== null && k.fn.start === inner.start && k.fn.end === inner.end);
        if (marker !== undefined) {
          marker.claimed = true;
          if (marker.reason.length < EXEMPT_REASON_MIN) {
            failures.push(`${where}: the CHANGE UNRECORDED marker gives a reason of ${marker.reason.length} characters, under the ${EXEMPT_REASON_MIN} this gate requires. Say why this write records no change.`);
          } else {
            exempt.push(`${where}: ${marker.reason}`);
            if (rel === EXEMPT_CONTROL.file && method === EXEMPT_CONTROL.method) exemptControlSeen = true;
          }
          continue;
        }
        unsupplied.push(where);
      }
    }

    for (const marker of markers) {
      if (marker.claimed) continue;
      failures.push(
        `${rel}:${marker.line}: STALE CHANGE UNRECORDED marker. It excuses no unsupplied change-controlled write in its enclosing function, so it is a reason with nothing left to explain and a blanket over whatever is written there next.`,
      );
    }

    const found = collectingFunctions(src, bodies, rel);
    collecting.push(...found);
    if (rel === COLLECT_CONTROL && found.length > 0) collectControlSeen = true;
  }

  for (const w of unsupplied) {
    failures.push(
      `${w}: this write's method declares a change parameter and this call site passes none, so under Require Change Number it carries no X-Downpipes-Change header. Thread the collected reference, or say why it records none with a CHANGE UNRECORDED: comment in the enclosing function.`,
    );
  }
  for (const c of collecting) {
    if (c.used) continue;
    const inFn = c.fn === "" ? "an anonymous handler" : c.fn;
    if (c.unplaced === true) {
      failures.push(
        `${c.rel}:${c.line}: this requireChange sits in no function body that scripts/function-bodies.mjs can see, so whether the reference it collects is ever threaded cannot be decided. Repair the body scan rather than reading past it.`,
      );
      continue;
    }
    failures.push(
      c.name === null
        ? `${c.rel}:${c.line} (in ${inFn}): requireChange's result is not bound to anything, so the operator is interrupted for a change number that cannot be threaded anywhere.`
        : `${c.rel}:${c.line} (in ${inFn}): requireChange collected a reference into '${c.name}' and '${c.name}.change' is never read in that function. The operator is asked for a change number and it is discarded, which reads to them as more compliant than never asking.`,
    );
  }

  if (sites === 0) failures.push("REFUSING TO PASS: found zero call sites of a change-accepting method. The call-site scan has stopped matching src/.");
  if (collecting.length === 0) failures.push("REFUSING TO PASS: found zero functions calling requireChange. The collect scan has stopped matching src/.");
  if (!collectControlSeen) failures.push(`REFUSING TO PASS: positive control ${COLLECT_CONTROL} collects a change reference and the collect scan did not find it there.`);
  if (!exemptControlSeen) {
    failures.push(
      `REFUSING TO PASS: positive control ${EXEMPT_CONTROL.file} calls ${EXEMPT_CONTROL.method}() on the read-only leg of a multiplexed route and did not resolve EXEMPT. Either the exemption path is unreachable or a read-only leg is now being scored as a recorded write.`,
    );
  }

  return { failures, methods, sites, supplied, exempt, collecting: collecting.length };
}

// ---- the self-test -------------------------------------------------------------------------------------
//
// Four attacks, each reintroducing a defect this gate exists to catch, run over patched sources in memory
// before the gate itself runs. A gate that cannot be made to fail has not been shown to check anything.
function selfTest() {
  const problems = [];
  const patch = (file, from, to) => (f) => {
    const s = readFileSync(f, "utf8");
    if (path.relative(ROOT, f).split(path.sep).join("/") !== file) return s;
    if (!s.includes(from)) throw new Error(`self-test could not patch ${file}: the anchor is gone`);
    return s.replace(from, to);
  };

  // ATTACK ONE: reintroduce the Make default bypass, a second wiring that calls the write with the id
  // alone.
  {
    const { failures } = judge(patch(COLLECT_CONTROL, "engine.setDefaultDestination(id, cr.change ?? undefined)", "engine.setDefaultDestination(id)"));
    if (!failures.some((f) => f.includes("setDefaultDestination") && f.includes("passes none"))) {
      problems.push("self-test attack one: a setDefaultDestination call site with no change argument did not fail the gate.");
    }
  }

  // ATTACK TWO: reintroduce the collect-and-drop, a Clear that prompts for a change number and then writes
  // without it.
  {
    const { failures } = judge(patch("src/screens/settings/push.ts", "engine.clearPush(cr.change ?? undefined)", "engine.clearPush()"));
    if (!failures.some((f) => f.includes("is never read in that function"))) {
      problems.push("self-test attack two: a collected change reference that is never read did not fail the gate.");
    }
  }

  // ATTACK THREE: leave an exemption marker behind after the write it excuses starts supplying a reference.
  // An exemption must not outlive the call it excuses, or it becomes a blanket over whatever is written in
  // that function next.
  {
    const { failures } = judge(patch(EXEMPT_CONTROL.file, "const res = await engine.restore(req);", "const res = await engine.restore(req, cr.change ?? undefined);"));
    if (!failures.some((f) => f.includes("STALE CHANGE UNRECORDED marker"))) {
      problems.push("self-test attack three: an exemption marker left behind with no unsupplied write did not fail the gate as stale.");
    }
  }

  // ATTACK FOUR: put a requireChange where the body scan cannot place it. scripts/function-bodies.mjs can
  // fail to place a function-type return, a string-literal return, or an object type read as a body, and
  // each such gap would let everything built on it answer for a body it cannot see instead of going red.
  // A collecting call this gate cannot place must REFUSE, not read past.
  {
    const { failures } = judge(patch(COLLECT_CONTROL, "export function errMsg(err: unknown): string {", 'void requireChange(null as never, "attack four", "destination-set-default");\n\nexport function errMsg(err: unknown): string {'));
    if (!failures.some((f) => f.includes("sits in no function body"))) {
      problems.push("self-test attack four: a requireChange the body scan cannot place did not fail the gate.");
    }
  }

  return problems;
}

function main() {
  if (process.argv.includes("--self-test")) {
    const problems = selfTest();
    if (problems.length > 0) {
      console.error("CHANGE-REFERENCE GATE SELF-TEST FAILED");
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log("change-ref gate self-test: 4 attacks, all caught");
  }

  const { failures, methods, sites, supplied, exempt, collecting } = judge((f) => readFileSync(f, "utf8"));
  console.log(`change-ref gate: ${methods.size} change-accepting methods, ${sites} call sites (${supplied} supplied, ${exempt.length} exempt), ${collecting} collecting functions`);
  for (const e of exempt) console.log(`  EXEMPT  ${e}`);
  if (failures.length > 0) {
    console.error(`\nCHANGE-REFERENCE GATE FAILED (${failures.length})`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("change-ref gate: PASS");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
