#!/usr/bin/env node
/**
 * IN-FLIGHT DECLARATION GATE.
 *
 * WHY THIS EXISTS, AND IT IS NOT AN ACCESSIBILITY GATE. A visual sweep asks whether a control moving to
 * its BUSY state moves what is beside it, and that check cannot be driven at all on this console:
 * `inflight-shift-sweep.spec.ts` explains why in its own header -- a click here navigates, submits or
 * deletes, so a read-only walk cancels its own click for exactly that reason, and reaching the busy state
 * needs either a console that declares its in-flight controls or a walk permitted to act on the product.
 *
 * `data-busy` does not solve it. It appears only AFTER the press, so a reader that may not press cannot
 * use it. What a reader needs is a declaration present WHILE THE CONTROL IS AT REST, naming the label the
 * control will show, so the state can be applied and measured without acting on the product.
 *
 * WHAT IT MEASURES. Controls that go busy by either mechanism: the shared modal helper's `busyLabel`
 * action descriptors, and the hand-rolled sites that set `disabled` and replace `textContent`. Reading
 * only one mechanism reports a clean number over half the real population.
 *
 * A CEILING THAT CAN ONLY FALL, NOT A FLOOR THAT MUST BE MET. The undeclared sites are pre-existing debt,
 * and a gate that failed on all of them at once would be switched off rather than fixed. So the count is
 * banked and the gate fails when it RISES, which stops the class growing while the debt is paid down. It
 * also NAMES every undeclared site on every run, because a number nobody can act on is a number nobody
 * pays.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Banked at the measured value once every control this gate can judge declares its in-flight label at its
// construction site. Lower it whenever a site is paid off; never raise it. A raise means a new control
// shipped that this check cannot reach, which is the thing this gate is for.
//
// A nearby `aria-busy` does not count as a declaration for this purpose: it is set at press time, so it
// tells a reader that cannot press exactly nothing, and crediting it would bank sites as paid when they
// are not reachable at all.
//
// A handful of controls this gate cannot construct-check are reported as UNJUDGEABLE rather than counted
// against the ceiling (see the unjudgeable branch below), precisely so a correct control never drives a
// reader to "fix" what is already right or to weaken the rule until it goes quiet.
const UNDECLARED_CEILING = 0;

const BUSY_TEXT_SET = /(\w+)\.textContent\s*=\s*"([A-Z][^"]{0,40}?ing[^"]{0,25})"/;

/**
 * findUndeclared returns TWO lists, not one.
 *   undeclared  a control this file constructs and does not declare: a real defect.
 *   unjudgeable a control this file did not construct, so its declaration lives elsewhere and cannot be
 *               seen from here. Reported, never counted.
 */
export function findUndeclared(sources) {
  const out = [];
  const unjudgeable = [];
  for (const { file, text } of sources) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = BUSY_TEXT_SET.exec(lines[i] ?? "");
      if (!m) continue;
      const [, v, label] = m;
      const window = lines.slice(Math.max(0, i - 6), i + 7).join("\n");
      // THE DECLARATION IS LOOKED FOR IN THE WHOLE FILE, NOT IN A WINDOW. A rest-time declaration belongs
      // where the control is CONSTRUCTED, which is where a reader can see it before any press; the
      // busy-set is usually somewhere else entirely, often in a click handler dozens of lines away. A
      // window around the busy-set would miss exactly the placement this check exists to ask for.
      //
      // Scoped to the VARIABLE rather than to the file, so a declaration on one control does not excuse
      // an undeclared sibling in the same file.
      const declaresAnywhere =
        text.includes(`${v}.dataset.busyLabel`) ||
        new RegExp(`\\b${v}\\b[^;]{0,400}?"data-busy-label"`, "s").test(text) ||
        text.includes(`setBusy(${v}`);
      // A busy-set is only a busy-set when the control is also disabled: an ordinary label swap is not a
      // control going in-flight, and counting one would inflate the debt with things that are not it.
      if (!window.includes(`${v}.disabled`)) continue;
      const declares =
        declaresAnywhere || window.includes(`${v}.dataset.busyLabel`) || window.includes(`setBusy(${v}`);
      if (declares) continue;
      // A CONTROL THIS FILE DID NOT CREATE CANNOT BE JUDGED HERE, and counting it as undeclared would be a
      // FALSE POSITIVE that costs more than silence. `submitBtn` and `testBtn` arrive in form-actions.ts
      // from forms.ts and saml-form.ts, and BOTH constructors already declare them; `saveBtn` arrives in
      // destination-submit.ts the same way. Naming a correct control as a defect drives a reader either to
      // "fix" what is already right or to weaken the rule until it goes quiet.
      //
      // So a site whose control is not constructed in this file is UNJUDGEABLE rather than undeclared, and
      // is reported separately: say what could not be checked instead of guessing at it.
      const constructedHere = new RegExp(`\\b(?:const|let)\\s+${v}\\b|\\b${v}\\s*=\\s*h\\(`).test(text);
      if (!constructedHere) { unjudgeable.push({ file, line: i + 1, control: v, label }); continue; }
      out.push({ file, line: i + 1, control: v, label });
    }
  }
  // Returned as a PAIR rather than an array with a property bolted on: the two are different claims
  // (this is wrong / this could not be judged) and a caller should have to name which it wants.
  return { undeclared: out, unjudgeable };
}

/** countDeclared returns the sites that DO declare, so a zero can be read against a population. */
export function countDeclared(sources) {
  let n = 0;
  for (const { text } of sources) {
    n += (text.match(/dataset\.busyLabel|data-busy-label/g) ?? []).length;
    n += (text.match(/setBusy\(/g) ?? []).length;
  }
  return n;
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (e.endsWith(".ts")) acc.push({ file: p.slice(ROOT.length + 1), text: readFileSync(p, "utf8") });
  }
  return acc;
}

// ---- SELF-TEST: it must go RED on a planted undeclared control before its verdict is worth anything ---
function selfTest() {
  let failures = 0;
  const ok = (label, cond) => { if (!cond) failures++; console.log(`${cond ? "ok  " : "FAIL"}  ${label}`); };

  const declared = [{ file: "a.ts", text: 'btn.dataset.busyLabel = "Saving";\nbtn.disabled = true;\nbtn.textContent = "Saving";' }];
  ok("CONTROL: a control declaring its in-flight label at rest is silent", findUndeclared(declared).undeclared.length === 0);

  const planted = [{ file: "a.ts", text: 'const btn = h("button", {});\nbtn.disabled = true;\nbtn.textContent = "Saving";' }];
  const v = findUndeclared(planted).undeclared;
  ok("PLANT: a busy control with no rest-time declaration is named", v.length === 1 && v[0].control === "btn");
  ok("PLANT: and the report carries the label a reader would need to apply the state", v[0]?.label === "Saving");

  const notBusy = [{ file: "a.ts", text: 'el.textContent = "Restoring";' }];
  ok("a label swap WITHOUT a disable is not a busy control, so the debt is not inflated", findUndeclared(notBusy).undeclared.length === 0);

  // Detection searches the variable's whole FILE rather than a window around the busy-set, because a
  // rest-time declaration belongs at CONSTRUCTION, usually far from the press handler. Searching a whole
  // file risks crediting a SIBLING's declaration to an undeclared control, which this self-test guards
  // against.
  ok("a SIBLING's declaration does not excuse an undeclared control in the same file",
    findUndeclared([{ file: "a.ts", text: 'const declared = h("button", { "data-busy-label": "Saving" });\nconst bare = h("button", {});\nbare.disabled = true;\nbare.textContent = "Saving";' }]).undeclared.length === 1);

  // A control this file did not construct cannot be judged here, so it must be reported as UNJUDGEABLE
  // rather than counted as undeclared, and it must NOT quietly vanish.
  const foreignRes = findUndeclared([{ file: "a.ts", text: 'export function act(btn) {\n  btn.disabled = true;\n  btn.textContent = "Saving";\n}' }]);
  ok("a control the file did NOT construct is not counted as undeclared", foreignRes.undeclared.length === 0);
  ok("...but it is reported as unjudgeable rather than dropped in silence", foreignRes.unjudgeable.length === 1);

  ok("setBusy counts as a declaration (it sets data-busy and aria-busy together)",
    findUndeclared([{ file: "a.ts", text: 'const btn = h("button", {});\nsetBusy(btn, true, "Saving");\nbtn.disabled = true;\nbtn.textContent = "Saving";' }]).undeclared.length === 0);

  console.log(`\n[inflight-declaration] self-test: ${failures === 0 ? "PASS" : `${failures} FAILED`} (8 checks)`);
  return failures;
}

if (process.argv.includes("--self-test")) process.exit(selfTest() === 0 ? 0 : 1);

if (selfTest() > 0) {
  console.error("\n[inflight-declaration] REFUSING to grade: the gate's own self-test is red, so its verdict about src/ means nothing.");
  process.exit(2);
}

const sources = walk(join(ROOT, "src"));
const { undeclared, unjudgeable } = findUndeclared(sources);
const declared = countDeclared(sources);

console.log(`\n[inflight-declaration] ${declared} declaration site(s); ${undeclared.length} busy control(s) carry none (ceiling ${UNDECLARED_CEILING})`);
for (const u of undeclared) console.log(`  ${u.file}:${u.line}  ${u.control} -> ${JSON.stringify(u.label)}`);

if (unjudgeable.length > 0) {
  // PRINTED, NEVER COUNTED. These are controls the file did not construct, so this gate cannot see
  // whether their real constructor declares them. Saying so is the point: a number that silently omits
  // them would read as full coverage of a population it never had.
  console.log(`\n[inflight-declaration] ${unjudgeable.length} site(s) UNJUDGEABLE here, because the control arrives as a parameter and is constructed elsewhere:`);
  for (const u of unjudgeable) console.log(`  ${u.file}:${u.line}  ${u.control} -> ${JSON.stringify(u.label)}  (check its constructor)`);
}

if (undeclared.length > UNDECLARED_CEILING) {
  console.log(`\n[inflight-declaration] FAIL: ${undeclared.length} exceeds the banked ceiling of ${UNDECLARED_CEILING}.`);
  console.log("A control that goes busy without declaring its label at rest cannot be reached by VIS-20's");
  console.log("in-flight arm at all: a sweep may not press it, and data-busy appears only after a press.");
  process.exit(1);
}
if (undeclared.length < UNDECLARED_CEILING) {
  console.log(`\n[inflight-declaration] ${UNDECLARED_CEILING - undeclared.length} paid off. Lower UNDECLARED_CEILING to ${undeclared.length} to bank it.`);
  process.exit(1);
}
console.log("[inflight-declaration] OK: at the banked ceiling, none added.");
process.exit(0);
