// Coverage for the PRESS GUARD in src/components/field.ts: a field's blur validation must not repaint
// its error slot while a pointer press is in flight.
//
// WHY THIS EXISTS. A field's error slot is hidden until it has something to say, so painting it (or
// clearing it) changes that field's height and moves every control below it. Pressing a control BELOW a
// field is precisely what blurs that field, so without the guard the sequence is: button down on the
// control, blur, error painted, control slides away, button up somewhere else, and the browser raises the
// click on the nearest common ancestor of the two points. The control receives no click at all.
//
// This is a real failure mode: a field whose error slot appears or disappears mid-press moves every
// control below it, so a press that started on one control can end on another, and the browser then
// raises the click on their nearest common ancestor rather than either control. Neither control receives
// a click at all. The Enabled checkbox and the Save button are both examples of a control this can affect.
//
// A real browser is where that was measured, and layout is not what this file tests: this tests the RULE
// that removes it, which is testable exactly. Every assertion here fails against field.ts without the
// guard (the error paints during the press) or against a guard that never releases (the error never
// paints at all), so neither the defect nor an over-correction can pass.
//
// Run with: node test/cov/components-field-press-guard.ts

import { dispatchDocKey, flushAsync, installDomShim, qs, textOf, type ShimEvent, type ShimNode } from "../dom-shim.ts";

// Install the shim BEFORE importing the component (lib/dom.ts creates elements at load time).
installDomShim();

const { field } = await import("../../src/components/field.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// A document-level pointer event, which is the only thing the guard listens to. Built here rather than
// borrowed from the keyboard helper so the type on the wire is the type under test.
function pointerEvent(type: string): ShimEvent {
  return {
    type,
    target: null,
    currentTarget: null,
    defaultPrevented: false,
    bubbles: true,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as ShimEvent;
}
const pressDown = (): void => dispatchDocKey(pointerEvent("pointerdown"));
const pressUp = (): void => dispatchDocKey(pointerEvent("pointerup"));
const pressCancel = (): void => dispatchDocKey(pointerEvent("pointercancel"));

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

function errorSlot(el: ShimNode): ShimNode {
  return qs(el, ".field__error")!;
}

// The rule under test throughout: anything but "Splunk " up front is refused. It is the live rule this
// was measured against (components/field-bounds.ts's pushAuthSecret, fed the Splunk credScheme), reduced
// to the one clause the guard interacts with.
const REFUSAL = "The HEC token must carry its scheme.";
const schemeRule = (v: string): string | null => (v === "" || v.startsWith("Splunk ") ? null : REFUSAL);

function refusedField(id: string): { control: ShimNode; slot: ShimNode } {
  const f = field({ id, label: "Auth secret", validate: schemeRule });
  const control = f.control as unknown as ShimNode;
  control.value = "00000000-0000-4000-8000-000000000000";
  return { control, slot: errorSlot(f.el as unknown as ShimNode) };
}

// ---- 1. the other half of the rule, asserted FIRST: with no press, the blur paints straight away -----
// This runs before any pointer event is dispatched, so it grades the guard's RESTING state and not a
// state some earlier release happened to leave behind. Without it the guard could "pass" by treating
// every blur as mid-press and painting nothing on a form nobody is pressing, which is a worse defect
// than the one it removes.
{
  const { control, slot } = refusedField("press-absent");
  fireBlur(control);
  ok("a blur with no press in flight paints immediately, in the same turn", textOf(slot) === REFUSAL);
}

// ---- 2. the defect: a blur DURING a press must not paint --------------------------------------------
// The shim mirrors `hidden` onto the property only once setError/clearError has run, so "not painted
// yet" is asserted on the slot's emptiness, which the shim models exactly.
{
  const { control, slot } = refusedField("press-during");
  pressDown();
  fireBlur(control);
  ok("a blur while a press is in flight paints nothing yet", textOf(slot) === "");
  ok("...and the control is not marked invalid yet either", control.getAttribute("aria-invalid") === null);

  // ---- 3. and the release is what paints it ---------------------------------------------------------
  pressUp();
  await flushAsync();
  ok("releasing the press paints the refusal", textOf(slot) === REFUSAL && slot.hidden === false);
  ok("...and marks the control invalid", control.getAttribute("aria-invalid") === "true");
}

// ---- 4. a CLEAR is deferred too, because shrinking moves the row just as growing does ----------------
// The guard's subject is the HEIGHT CHANGE, not the error, so a blur that would clear an error waits on
// the same terms as one that would paint it. On the live form this arm is rarely reached, because the
// input listener already clears the error the moment the value becomes good, before any press begins; the
// rule is held here so that a caller who clears on blur alone cannot reintroduce the defect in reverse.
{
  const { control, slot } = refusedField("press-clear");
  fireBlur(control); // no press: paints the refusal
  ok("setup: the field is showing its refusal", textOf(slot) === REFUSAL);
  control.value = "Splunk 00000000-0000-4000-8000-000000000000";
  pressDown();
  fireBlur(control);
  ok("a corrected value blurred during a press does not clear the error yet", textOf(slot) === REFUSAL);
  pressUp();
  await flushAsync();
  ok("releasing the press clears it", textOf(slot) === "" && slot.hidden === true);
}

// ---- 5. pointercancel releases as well as pointerup -------------------------------------------------
// A press the browser takes over (a scroll, a gesture) ends with no pointerup at all.
{
  const { control, slot } = refusedField("press-cancel");
  pressDown();
  fireBlur(control);
  ok("setup: the cancelled press is holding the paint back", textOf(slot) === "");
  pressCancel();
  await flushAsync();
  ok("a cancelled press releases the paint", textOf(slot) === REFUSAL);
}

// ---- 6. a press whose release the document never sees still paints -----------------------------------
// The guard must not be able to strand an error. A late error is a far smaller fault than a silent one,
// so the deferred paint carries its own deadline and does not depend on the queue draining.
{
  const { control, slot } = refusedField("press-stranded");
  pressDown();
  fireBlur(control);
  ok("setup: the stranded press is holding the paint back", textOf(slot) === "");
  await new Promise<void>((r) => setTimeout(r, 700)); // past MAX_PRESS_DEFER_MS (500)
  ok("a press that never reports its release still paints, on the deadline", textOf(slot) === REFUSAL);
  // The deadline fired, so the queued copy must be a no-op rather than a second paint. Release it and
  // check nothing was double-applied or re-cleared.
  pressUp();
  await flushAsync();
  ok("...and the late release repaints nothing", textOf(slot) === REFUSAL);
}

// ---- 7. NEGATIVE CONTROL: the guard must not swallow a field that has nothing to say -----------------
// A valid value blurred during a press must still end up clean, not merely unpainted, so a passing
// reading in section 1 cannot be mistaken for "the guard silences everything".
{
  const f = field({ id: "press-valid", label: "Auth secret", validate: schemeRule });
  const control = f.control as unknown as ShimNode;
  const slot = errorSlot(f.el as unknown as ShimNode);
  control.value = "Splunk good-token";
  pressDown();
  fireBlur(control);
  pressUp();
  await flushAsync();
  ok("a value the rule accepts stays clean through a press", textOf(slot) === "" && control.getAttribute("aria-invalid") === null);
}

console.log(failures === 0 ? "\nfield press guard: all checks passed" : `\nfield press guard: ${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
process.exit(failures === 0 ? 0 : 1);
