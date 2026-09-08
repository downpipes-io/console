// Coverage for src/components/field.ts: inline field validation, channel one of the error model.
// A field error is rendered AT the field (an aria-invalid control plus
// an aria-describedby error slot), never as a toast or a global error. The rules under test:
// validate on blur then on submit (not on every keystroke); re-validate on change once a field has
// errored; the aria wiring; focusing the first invalid field on submit; never losing operator input.
//
// This drives the REAL field() and validateForm() under the shared DOM shim (no jsdom, no network),
// across each control kind (input / textarea / select) and each rule path, asserting a meaningful
// outcome for every branch rather than merely touching a line.
//
// Run with: node test/cov/components-field.ts
//
// Surfaces driven (and the contract each asserts):
//   field (input)    the labelled .input control; the type default and an explicit type; the
//                    placeholder / value / autocomplete legs; aria-required when required.
//   field (textarea) the .textarea control with its placeholder and seeded value.
//   field (select)   the .select control built from options, the seeded selection, and that
//                    readValue does NOT trim a select value (the raw value is returned).
//   value/readValue  the trimmed read for an input vs the raw read for a select.
//   setError/clear   the aria-invalid + visible error slot + aria-describedby wiring, and that
//                    clearing removes all three again.
//   validate         the required-empty error; a custom validator that fails then passes; and a
//                    field with no rule returning valid and clearing.
//   describedBy      hint-only, hint+error, and error-only describedby strings, plus the no-id
//                    removeAttribute arm when neither hint nor error is present.
//   blur listener    a ruled field validates on blur; a free optional field does not.
//   input listener   onInput fires with the read value on every keystroke; an errored field
//                     re-validates on change (clearing once it becomes valid); a clean field does not.
//   focus            focus() moves the shim's activeElement to the control.
//   validateForm     all-valid returns true; a mix focuses the FIRST invalid field and returns false.

import { installDomShim, qs, textOf, activeElement, type ShimNode } from "../dom-shim.ts";

// Install the shim BEFORE importing the component (lib/dom.ts creates elements at load time).
installDomShim();

// SHIM NOTE: the error slot is created with the `hidden: true` ATTRIBUTE form (h(..., { hidden: true })),
// which the shared shim records as a "hidden" attribute but does NOT mirror onto the `.hidden`
// property getter (the shim only syncs `.hidden` via the property setter, the path setError/clearError
// use). In a real browser the slot reads hidden at construction; under the shim its `.hidden` reads
// false until the first setError/clearError runs the property setter. So where this file needs a
// browser-faithful hidden/describedby state for a clean field, it calls clearError() first (a real
// code path that establishes the property and re-runs applyDescribedBy) and asserts on that; for the
// "stays clean" checks it asserts on the slot's emptiness and the absence of aria-invalid (both of
// which the shim models exactly), not on the un-synced initial attribute.

const { field, validateForm } = await import("../../src/components/field.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// fireInput / fireBlur dispatch the events the field wires directly on its control, mirroring a
// real keystroke and a real focus-leave, so the "input" and "blur" listeners under test actually run.
function fireInput(control: ShimNode): void {
  control.dispatchEvent({
    type: "input",
    target: control,
    currentTarget: control,
    defaultPrevented: false,
    bubbles: true,
    preventDefault() {},
    stopPropagation() {},
  });
}
function fireBlur(control: ShimNode): void {
  control.dispatchEvent({
    type: "blur",
    target: control,
    currentTarget: control,
    defaultPrevented: false,
    bubbles: true,
    preventDefault() {},
    stopPropagation() {},
  });
}

// errorSlot reads the field's error element so a test can assert its text and hidden state.
function errorSlot(el: ShimNode): ShimNode {
  return qs(el, ".field__error")!;
}

// ---- 1. input kind: every optional leg, the default type, and aria-required --------------------

{
  const f = field({
    id: "name",
    label: "Display name",
    type: "text",
    placeholder: "e.g. Nightly D1",
    value: "  seed  ",
    hint: "Shown in the run log.",
    required: true,
    autocomplete: "off",
  });
  const el = f.el as unknown as ShimNode;
  const control = f.control as unknown as ShimNode;
  ok("input: the wrapper is a .field", el.classList.contains("field"));
  ok("input: the control is a labelled .input with the id", control.classList.contains("input") && control.id === "name");
  ok("input: an explicit placeholder was applied", control.placeholder === "e.g. Nightly D1");
  ok("input: the seeded value was applied verbatim (untrimmed on the control)", control.value === "  seed  ");
  ok("input: autocomplete was set as an attribute", control.getAttribute("autocomplete") === "off");
  ok("input: required marks the control aria-required", control.getAttribute("aria-required") === "true");
  ok("input: the label points at the control via for", qs(el, "label")?.getAttribute("for") === "name");
  // value() trims an input/textarea read (the seeded "  seed  " comes back "seed").
  ok("input: value() trims the read", f.value() === "seed");
  // hint present -> after a clear (the property-setter path), aria-describedby points at the hint id
  // alone (the error is hidden, so applyDescribedBy lists only the hint). See the SHIM NOTE above.
  f.clearError();
  ok("input: aria-describedby is the hint id while clean", control.getAttribute("aria-describedby") === "name-hint");
}

// The type default: when no type is given the input is type="text".
{
  const f = field({ id: "plain", label: "Plain" });
  const control = f.control as unknown as ShimNode;
  ok("input: the type defaults to text", control.getAttribute("type") === "text");
  // No hint and no error -> after a clear (the property-setter path), the describedby attribute is
  // absent entirely (the removeAttribute arm: no ids to set). See the SHIM NOTE above.
  f.clearError();
  ok("input: with no hint and no error there is no aria-describedby", control.getAttribute("aria-describedby") === null);
  // No placeholder / value / autocomplete were passed -> those legs were skipped.
  ok("input: no placeholder when none supplied", control.placeholder === "");
}

// An explicit non-text type is honoured (the `opts.type ?? "text"` truthy arm).
{
  const f = field({ id: "pw", label: "Passphrase", type: "password" });
  const control = f.control as unknown as ShimNode;
  ok("input: an explicit type is honoured", control.getAttribute("type") === "password");
}

// ---- 2. textarea kind: the .textarea control with placeholder and seeded value -----------------

{
  const f = field({ id: "notes", label: "Notes", kind: "textarea", placeholder: "Optional", value: " hi " });
  const control = f.control as unknown as ShimNode;
  ok("textarea: the control is a .textarea", control.classList.contains("textarea") && control.tagName === "TEXTAREA");
  ok("textarea: its placeholder was applied", control.placeholder === "Optional");
  ok("textarea: its seeded value was applied", control.value === " hi ");
  ok("textarea: value() trims a textarea read", f.value() === "hi");
}

// A textarea with neither placeholder nor value skips both optional legs.
{
  const f = field({ id: "bare", label: "Bare", kind: "textarea" });
  const control = f.control as unknown as ShimNode;
  ok("textarea: no placeholder when none supplied", control.placeholder === "");
  ok("textarea: empty when no value supplied", control.value === "");
}

// ---- 3. select kind: built from options, seeded selection, and the raw (untrimmed) read ---------

{
  const f = field({
    id: "region",
    label: "Region",
    kind: "select",
    options: [
      { value: "apac", label: "Asia Pacific" },
      { value: "emea", label: "Europe" },
    ],
    value: "emea",
  });
  const _el = f.el as unknown as ShimNode;
  const control = f.control as unknown as ShimNode;
  ok("select: the control is a .select", control.classList.contains("select") && control.tagName === "SELECT");
  const options = control.querySelectorAll("option");
  ok("select: an option was created per entry", options.length === 2);
  ok("select: option values and labels carried through", options[0]!.getAttribute("value") === "apac" && textOf(options[0]!) === "Asia Pacific");
  ok("select: the seeded value selected that option", control.value === "emea");
  // readValue must NOT trim a select value: a select option could legitimately have leading/trailing
  // spaces in its value, so the select branch returns control.value as-is.
  control.value = "  spaced  ";
  ok("select: value() returns the raw select value (no trim)", f.value() === "  spaced  ");
  // No hint here -> after a clear, describedby is absent on the select too. See the SHIM NOTE above.
  f.clearError();
  ok("select: no aria-describedby with no hint", control.getAttribute("aria-describedby") === null);
}

// A select with no options array (the `?? []` arm) and no seeded value (the value-undefined arm).
{
  const f = field({ id: "empty-sel", label: "Empty", kind: "select" });
  const control = f.control as unknown as ShimNode;
  ok("select: no options renders an empty select", control.querySelectorAll("option").length === 0);
  ok("select: an unset value leaves the select empty", control.value === "");
}

// ---- 4. setError / clearError: the full aria wiring on and off ---------------------------------

{
  const f = field({ id: "host", label: "Host", hint: "The endpoint host." });
  const control = f.control as unknown as ShimNode;
  const slot = errorSlot(f.el as unknown as ShimNode);
  // The slot is created with the hidden attribute and empty text (the shim records the attribute even
  // though it does not mirror it onto the `.hidden` getter until a setter runs; see the SHIM NOTE).
  ok("setError: the slot starts empty with the hidden attribute set", textOf(slot) === "" && slot.getAttribute("hidden") === "");

  f.setError("Host is unreachable.");
  ok("setError: the message is shown in the slot", textOf(slot) === "Host is unreachable." && slot.hidden === false);
  ok("setError: the control is marked aria-invalid", control.getAttribute("aria-invalid") === "true");
  // describedby now lists the hint THEN the error (hint first, error appended when shown).
  ok("setError: aria-describedby lists hint then error", control.getAttribute("aria-describedby") === "host-hint host-error");

  f.clearError();
  ok("clearError: the slot is hidden and emptied again", slot.hidden === true && textOf(slot) === "");
  ok("clearError: aria-invalid is removed", control.getAttribute("aria-invalid") === null);
  ok("clearError: aria-describedby falls back to just the hint", control.getAttribute("aria-describedby") === "host-hint");
}

// setError on a field with NO hint exercises the error-only describedby (ids = [errorId] only).
{
  const f = field({ id: "nohint", label: "No hint" });
  const control = f.control as unknown as ShimNode;
  f.setError("Bad value.");
  ok("setError (no hint): aria-describedby is the error id alone", control.getAttribute("aria-describedby") === "nohint-error");
  f.clearError();
  ok("clearError (no hint): aria-describedby is removed entirely", control.getAttribute("aria-describedby") === null);
}

// ---- 5. validate(): the required path, a custom validator, and the no-rule pass ----------------

// Required + empty -> a generated "<label> is required." error, validate() returns false.
{
  const f = field({ id: "req", label: "Bucket", required: true });
  const slot = errorSlot(f.el as unknown as ShimNode);
  ok("validate: required + empty returns false", f.validate() === false);
  ok("validate: the generated required message uses the label", textOf(slot) === "Bucket is required.");
  // Now give it a value and validate again -> it clears and passes.
  (f.control as unknown as ShimNode).value = "my-bucket";
  ok("validate: a filled required field passes", f.validate() === true);
  ok("validate: the error slot cleared on the passing run", slot.hidden === true && textOf(slot) === "");
}

// A custom validator that fails on a bad value then passes on a good one (both validator arms),
// and the required check is NOT triggered (not required), so control flows to opts.validate.
{
  const seen: string[] = [];
  const f = field({
    id: "email",
    label: "Email",
    value: "bad",
    validate: (v) => {
      seen.push(v);
      return v.includes("@") ? null : "Enter a valid email.";
    },
  });
  const slot = errorSlot(f.el as unknown as ShimNode);
  ok("validate: a failing custom validator returns false", f.validate() === false);
  ok("validate: the validator's message is shown", textOf(slot) === "Enter a valid email.");
  ok("validate: the validator was called with the trimmed value", seen[seen.length - 1] === "bad");
  // Fix the value -> the validator returns null, validate() clears and passes.
  (f.control as unknown as ShimNode).value = "  a@b.co  ";
  ok("validate: a passing custom validator returns true", f.validate() === true);
  ok("validate: the validator saw the trimmed value (spaces stripped)", seen[seen.length - 1] === "a@b.co");
  ok("validate: a passing run clears the error", slot.hidden === true);
}

// A field with NEITHER required NOR a validator: validate() always clears and returns true.
{
  const f = field({ id: "free", label: "Free text" });
  ok("validate: a rule-less field is always valid", f.validate() === true);
}

// ---- 6. the blur listener: a ruled field validates on blur, a free field does not ---------------

{
  const f = field({ id: "blur-req", label: "Region", required: true });
  const control = f.control as unknown as ShimNode;
  const slot = errorSlot(f.el as unknown as ShimNode);
  // Leaving a required field empty on blur surfaces the error (the `opts.required || opts.validate`
  // arm is true, so validate() runs).
  fireBlur(control);
  ok("blur: a required field errors when left empty on blur", slot.hidden === false && textOf(slot) === "Region is required.");
}

// A free optional field must NOT error just for being touched and left empty (the blur guard is
// false, so validate() never runs).
{
  const f = field({ id: "blur-free", label: "Label" });
  const control = f.control as unknown as ShimNode;
  const slot = errorSlot(f.el as unknown as ShimNode);
  fireBlur(control);
  // The blur guard is false, so validate() never ran: the error slot is empty and the control was
  // never marked aria-invalid (both shim-faithful signals that the field stayed clean).
  ok("blur: a free optional field stays clean on blur", textOf(slot) === "" && control.getAttribute("aria-invalid") === null);
}

// A field with a validator (but not required) also validates on blur (the second arm of the OR).
{
  const f = field({ id: "blur-val", label: "Port", validate: (v) => (v === "" ? null : "No ports allowed.") });
  const control = f.control as unknown as ShimNode;
  const slot = errorSlot(f.el as unknown as ShimNode);
  control.value = "8080";
  fireBlur(control);
  ok("blur: a validator-only field validates on blur", slot.hidden === false && textOf(slot) === "No ports allowed.");
}

// ---- 7. the input listener: onInput fires; an errored field re-validates, a clean one does not --

// onInput is called with the read value on every keystroke, regardless of error state.
{
  const heard: string[] = [];
  const f = field({ id: "live", label: "Live", onInput: (v) => heard.push(v) });
  const control = f.control as unknown as ShimNode;
  control.value = "  typed  ";
  fireInput(control);
  ok("input: onInput fired with the trimmed read value", heard.length === 1 && heard[0] === "typed");
  // Not errored and no rule -> validate() is NOT called on input (the field stays clean): the error
  // slot is empty and the control is not aria-invalid.
  const cleanSlot = errorSlot(f.el as unknown as ShimNode);
  ok("input: a clean rule-less field does not error on input", textOf(cleanSlot) === "" && control.getAttribute("aria-invalid") === null);
}

// Once a field has errored, a subsequent input re-validates live (clearing the error when the value
// becomes valid), which is the "re-validate on change once errored" rule.
{
  const f = field({ id: "rev", label: "Token", required: true });
  const control = f.control as unknown as ShimNode;
  const slot = errorSlot(f.el as unknown as ShimNode);
  // First, force the error state by validating while empty.
  f.validate();
  ok("input: precondition errored (the field is invalid)", slot.hidden === false);
  // Now type a value and fire input: errored===true, so validate() re-runs and clears the error.
  control.value = "abc";
  fireInput(control);
  ok("input: an errored field re-validates on input and clears once valid", slot.hidden === true && control.getAttribute("aria-invalid") === null);
}

// An errored field whose value is STILL invalid on input keeps the error (re-validate, still fails).
{
  const f = field({ id: "rev2", label: "Secret", required: true });
  const control = f.control as unknown as ShimNode;
  const slot = errorSlot(f.el as unknown as ShimNode);
  f.validate(); // errored on empty
  control.value = "   "; // whitespace trims to empty -> still required-empty
  fireInput(control);
  ok("input: an errored field that is still invalid keeps the error", slot.hidden === false && textOf(slot) === "Secret is required.");
}

// A field with NO onInput handler: the input event runs the listener but the onInput leg is skipped
// (the `if (opts.onInput)` false arm), and a clean field still does not validate.
{
  const f = field({ id: "no-oninput", label: "Quiet" });
  const control = f.control as unknown as ShimNode;
  control.value = "x";
  // Should not throw and should not surface an error (no onInput leg, not errored, so no validate).
  fireInput(control);
  const quietSlot = errorSlot(f.el as unknown as ShimNode);
  ok("input: a field with no onInput handler tolerates input events", textOf(quietSlot) === "" && control.getAttribute("aria-invalid") === null);
}

// ---- 8. focus(): moves the shim's activeElement to the control ---------------------------------

{
  const f = field({ id: "focusable", label: "Focus me" });
  const control = f.control as unknown as ShimNode;
  f.focus();
  ok("focus: focus() makes the control the active element", activeElement() === control);
}

// ---- 9. validateForm: all-valid passes; a mix focuses the FIRST invalid and returns false -------

// Every field valid -> validateForm returns true and focuses nothing in particular (no invalid).
{
  const a = field({ id: "vf-a", label: "A", required: true, value: "ok" });
  const b = field({ id: "vf-b", label: "B", required: true, value: "ok" });
  // Seed the trimmed values onto the controls so readValue sees them non-empty.
  (a.control as unknown as ShimNode).value = "ok";
  (b.control as unknown as ShimNode).value = "ok";
  ok("validateForm: all fields valid returns true", validateForm([a, b]) === true);
}

// A mix where the SECOND and THIRD fields are invalid: validateForm must focus the FIRST invalid
// (the second field) and return false, and the third field's invalidity must not move focus past it
// (the `firstInvalid === null` guard captures only the first).
{
  const first = field({ id: "vf-1", label: "First", required: true });
  (first.control as unknown as ShimNode).value = "filled"; // valid
  const second = field({ id: "vf-2", label: "Second", required: true }); // empty -> invalid
  const third = field({ id: "vf-3", label: "Third", required: true }); // empty -> invalid
  const result = validateForm([first, second, third]);
  ok("validateForm: a form with an invalid field returns false", result === false);
  ok("validateForm: focus landed on the FIRST invalid field (the second control)", activeElement() === (second.control as unknown as ShimNode));
  // Both invalid fields show their error (every field's validate ran, not just the first).
  ok("validateForm: every field validated (the third invalid field also shows its error)", errorSlot(third.el as unknown as ShimNode).hidden === false);
  ok("validateForm: the valid first field shows no error", errorSlot(first.el as unknown as ShimNode).hidden === true);
}

// ---- 10. doc link: the optional documentation affordance -----------------------------------------

// With a doc: the field renders a .field__doc external anchor whose href carries the anchor, opens
// in a new tab (noopener), and shows the custom label.
{
  const f = field({ id: "docd", label: "Docd", doc: { href: "https://docs.downpipes.io/x", anchor: "sec", label: "Read the docs" } });
  const link = qs(f.el as unknown as ShimNode, ".field__doc") as ShimNode;
  ok("doc: a .field__doc anchor is rendered when doc is given", !!link && link.tagName === "A");
  ok("doc: the href carries the anchor", link.getAttribute("href") === "https://docs.downpipes.io/x#sec");
  ok("doc: the link opens in a new tab with noopener", link.getAttribute("target") === "_blank" && link.getAttribute("rel") === "noreferrer noopener");
  ok("doc: the custom label is used", textOf(link).includes("Read the docs"));
}

// Without an anchor the href is the bare page, and the default label is "Learn more".
{
  const f = field({ id: "docd2", label: "Docd2", doc: { href: "https://docs.downpipes.io/y" } });
  const link = qs(f.el as unknown as ShimNode, ".field__doc") as ShimNode;
  ok("doc: without an anchor the href is the bare page", link.getAttribute("href") === "https://docs.downpipes.io/y");
  ok("doc: the default label is 'Learn more'", textOf(link).includes("Learn more"));
}

// No doc option -> no .field__doc anchor.
{
  const f = field({ id: "nodoc", label: "No doc" });
  ok("doc: no .field__doc when doc is absent", qs(f.el as unknown as ShimNode, ".field__doc") === null);
}

console.log(failures === 0 ? "\nFIELD VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
if (failures > 0) process.exit(1);
