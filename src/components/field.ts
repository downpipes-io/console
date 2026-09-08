// Inline field validation, channel one of the error model. A field-level error is rendered AT the field, never
// as a toast and never as a global error. The rules (from the design system):
// validate on blur then on submit (not angrily on every keystroke); re-validate on
// change once a field has errored; aria-invalid + aria-describedby wiring; focus
// the first invalid field on submit; never lose operator input.
//
// This builds a labelled control (input / textarea / select) wrapped in .field with
// a hint or an error slot, and returns handles so a form can read the value,
// validate, and show/clear an error. No framework; the same typed-element creation
// the whole console uses.

import { formFieldFor, recordFormRefused } from "../lib/client-diag/ring.ts";
import type { ClientDiagFormField } from "../lib/client-diag/vocab.ts";
import { h, svgIcon } from "../lib/dom.ts";
import { ICON_EXTERNAL } from "../lib/icons.ts";

export type FieldControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/**
 * The disabled-with-reason primitive, factored out of field's own setDisabled so a hand-built
 * control OUTSIDE the field() factory -- a checkbox, a radio, a role="switch" button -- can carry the
 * identical refusal contract rather than a separate reimplementation of it: aria-disabled (never the native
 * `disabled` attribute, which drops a control out of the tab order so a keyboard/screen-reader user never
 * lands on it and never hears why), the reason shown as a visible hint AND wired in via aria-describedby,
 * and keydown/mousedown/paste blocked so a mouse user cannot act on a refused control either, all while the
 * control stays focusable and in the tab order.
 *
 * Call once per control (it wires the event guards); the returned setter can then be called as often as the
 * caller's own state changes, with a reason to refuse the control or null to re-enable it.
 *
 * `reasonEl` is the element the reason text is written into: give it a stable `id` before calling this
 * (aria-describedby needs one to point at) and start it `hidden`; the setter manages both the text and the
 * hidden state, and preserves any OTHER ids already on the control's aria-describedby (a control this wraps
 * may already be described by its own label text or a standing hint).
 *
 * BLOCKS `click` AS WELL AS keydown/mousedown/paste, and that is load-bearing for a checkbox, a radio or a
 * role="switch" button, not belt-and-braces: a checkbox/radio's checked-toggle and a button's activation are
 * both the CLICK event's default action, not mousedown's. `mousedown.preventDefault()` stops a mouse press
 * from taking focus or opening a native picker (why the original three field()-only sites -- a text input, a
 * select, a date input -- needed only that), but it does not cancel the click that follows and would still
 * toggle a checkbox/radio or fire a switch button's own click handler. Blocking click as well costs nothing
 * on the original three: a click on a text/select control carries no default action of its own once mousedown
 * has already placed focus and (for a select) suppressed the picker.
 */
export function disabledWithReason(control: HTMLElement, reasonEl: HTMLElement): (reason: string | null) => void {
  const blockWhileDisabled = (ev: Event): void => {
    if (control.getAttribute("aria-disabled") === "true") ev.preventDefault();
  };
  control.addEventListener("keydown", blockWhileDisabled);
  control.addEventListener("mousedown", blockWhileDisabled);
  control.addEventListener("click", blockWhileDisabled);
  control.addEventListener("paste", blockWhileDisabled);

  return (reason: string | null): void => {
    if (reason !== null) {
      control.setAttribute("aria-disabled", "true");
      reasonEl.textContent = reason;
      reasonEl.hidden = false;
    } else {
      control.removeAttribute("aria-disabled");
      reasonEl.textContent = "";
      reasonEl.hidden = true;
    }
    const ids = (control.getAttribute("aria-describedby") ?? "").split(" ").filter((id) => id !== "" && id !== reasonEl.id);
    if (!reasonEl.hidden) ids.push(reasonEl.id);
    if (ids.length) control.setAttribute("aria-describedby", ids.join(" "));
    else control.removeAttribute("aria-describedby");
  };
}

export interface Field {
  // The wrapper element to append to the form.
  el: HTMLElement;
  // The control, for direct reads (.value) where needed.
  control: FieldControl;
  // The current trimmed value (for inputs/textareas) or the selected value.
  value(): string;
  // badInput (G240): did the CONTROL ITSELF fail to convert what the operator typed? On a type="number" input
  // the HTML value-sanitisation algorithm returns the EMPTY STRING from .value for any content that is not a
  // valid floating-point number, so a typed currency symbol, a thousands separator or a comma decimal arrives at
  // every reader as "" and is indistinguishable from an empty box. validity.badInput is the ONE surviving signal
  // that the browser ate the operator's text, and it is the whole difference between "the operator chose the
  // preset" and "the operator typed a contracted rate and silently got the preset instead". False on any control
  // that cannot report it (a select, a textarea, a DOM without ValidityState).
  badInput(): boolean;
  // Show an inline error (sets aria-invalid + the error text + aria-describedby). setError makes NO claim about
  // who refused: a form uses it to echo the ENGINE's refusal back onto the offending field too. It records
  // nothing, and it must not: a row saying the console's validator refused a value, when it was the engine that
  // refused it, asserts a fact the code never established.
  setError(message: string): void;
  // refuse() is setError for the case where the CONSOLE'S OWN RULE turned the operator away from A VALUE THEY
  // TYPED (G335). It shows the same inline error AND records the refusal, so a console rule that lives outside the
  // validate() funnel -- a cross-field rule that can only run at submit, or a check that needs the parsed value
  // rather than the raw one -- is not silently invisible to support. Use it wherever the console refused a value;
  // use setError wherever the ENGINE refused, and wherever the console's rule is that a box is EMPTY (nothing was
  // examined, so `rejected` would assert an inspection that never happened, and an operator part-way through a
  // form is the commonest event in the console). The empty case is guarded in refuse() as well, so a call site
  // cannot opt back into it.
  refuse(message: string): void;
  // Clear any inline error.
  clearError(): void;
  // setDisabled applies the console's disabled-with-reason rule (the same
  // aria-disabled + focusable + in-control reason pattern detail-drawer.ts and
  // wizard.ts already use for buttons and the stepper): pass a reason to refuse the
  // control (it stays in the tab order, is announced as disabled, and the reason is
  // both shown as a hint and tied in via aria-describedby; typing, selecting and the
  // native picker are blocked), or null to re-enable it. Never sets the native
  // `disabled` attribute, which would drop the control out of the tab order silently.
  setDisabled(reason: string | null): void;
  // Run the field's own validator (if any) and show/clear the error. Returns true
  // if valid. Called on blur and on submit.
  validate(): boolean;
  // Focus the control (used to focus the first invalid field on submit).
  focus(): void;
}

export interface FieldOptions {
  id: string;
  // The closed-vocabulary member to record a refusal against, when it is NOT the control's own id.
  //
  // Almost every field's id IS its vocabulary member, and passing this is wrong for those. It exists for
  // controls whose id carries a per-row index: the costs screen builds four contracted-rate fields per
  // pricing block as `cost-price-storage-0`, `-1` and so on, so the id can never equal the family member
  // the vocabulary holds. formFieldFor then returns null and the refusal is dropped, which is the right
  // behaviour for an unknown id and the wrong outcome here, because those four members exist precisely so
  // that "the cost screen will not take my rate" is answerable, and it was not.
  //
  // DECLARED rather than derived. Stripping a trailing index would silently re-map any future field whose
  // id happens to end in a number, and this funnel's discipline is that an id the vocabulary does not
  // know is dropped and never coerced. The type keeps it honest: only a real member can be passed.
  diagField?: ClientDiagFormField;
  label: string;
  // "input" (default), "textarea", or "select". For select, pass `options`.
  kind?: "input" | "textarea" | "select";
  type?: string; // for input (text, number, password, ...). Default "text".
  placeholder?: string;
  value?: string;
  // The standing hint below the control: a plain string, or a built node for hints
  // that carry inline structure (e.g. a mono span for a command name). Never raw
  // server HTML; a node is appended as-is by the typed h() builder.
  hint?: string | Node;
  required?: boolean;
  // The sentence shown when a `required` field is left empty, when `<label> is required.` is not the
  // right sentence for this control.
  //
  // The generic form is built from the LABEL, which is the field's short name and is usually all the
  // operator needs. It is wrong wherever a screen refuses the same empty state a second time with a
  // fuller description, because the operator then meets two sentences for one state: as-sec-name read
  // "Secret name is required." on blur and "The secret name (the store entry key) is required." when
  // Attach was pressed. Passing the screen's own sentence here makes the two moments agree without
  // widening the label above the box, and without moving the emptiness rule into the `validate` arm,
  // which runValidate's own note explains is the wrong place for it.
  requiredMessage?: string;
  // Select options [{ value, label }].
  options?: Array<{ value: string; label: string }>;
  // A validator returning an error message string, or null/"" if valid. Runs on
  // blur and submit; the field re-validates on change once it has errored.
  //
  // The second argument carries `badInput`, the ONE signal that survives the browser eating the
  // operator's text (see Field.badInput). It matters to any bounded number field: on a
  // type="number" input the HTML value-sanitisation algorithm returns "" from .value for anything
  // that is not a valid floating-point number, so a typed "abc" reaches a validator as the empty
  // string and is indistinguishable from an untouched box. A bounds validator that treats blank as
  // "no value given, nothing to refuse" would therefore accept "abc" in silence, which is exactly
  // the defect this argument closes. Existing one-argument validators keep working unchanged.
  validate?: (value: string, meta: { badInput: boolean }) => string | null;
  autocomplete?: string;
  // Called on every input event (for live cost projections, type-to-confirm gating).
  onInput?: (value: string) => void;
  // An optional documentation link rendered under the field (the field audit's G2): the page that
  // explains this field's accepted values, format and implications in full. href is the canonical
  // docs URL; anchor deep-links to the exact section; label overrides the default "Learn more".
  doc?: { href: string; anchor?: string; label?: string };
}

export function field(opts: FieldOptions): Field {
  const kind = opts.kind ?? "input";
  const errorId = `${opts.id}-error`;
  const hintId = `${opts.id}-hint`;

  let control: FieldControl;
  if (kind === "textarea") {
    control = h("textarea", { class: "textarea", id: opts.id }) as HTMLTextAreaElement;
    if (opts.placeholder) control.placeholder = opts.placeholder;
    if (opts.value) control.value = opts.value;
  } else if (kind === "select") {
    const select = h("select", { class: "select", id: opts.id }) as HTMLSelectElement;
    for (const o of opts.options ?? []) {
      select.appendChild(h("option", { value: o.value }, o.label));
    }
    if (opts.value !== undefined) select.value = opts.value;
    control = select;
  } else {
    const input = h("input", { class: "input", id: opts.id, type: opts.type ?? "text" }) as HTMLInputElement;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.value) input.value = opts.value;
    if (opts.autocomplete) input.setAttribute("autocomplete", opts.autocomplete);
    control = input;
  }
  if (opts.required) control.setAttribute("aria-required", "true");

  const label = h("label", { class: "field__label", for: opts.id }, opts.label);
  const hint = opts.hint ? h("p", { class: "field__hint", id: hintId }, opts.hint) : null;
  // The optional doc link (G2): a real external anchor to the canonical docs page for this field,
  // opened in a new tab so the operator does not lose the form. The external-link interstitial
  // (app-external-link.ts) still governs the cross-origin hop, exactly as the panel-level doc links do.
  const docLink = opts.doc
    ? h(
        "a",
        {
          class: "field__doc linklike",
          href: opts.doc.anchor ? `${opts.doc.href}#${opts.doc.anchor}` : opts.doc.href,
          target: "_blank",
          rel: "noreferrer noopener",
        },
        opts.doc.label ?? "Learn more",
        svgIcon(ICON_EXTERNAL, { size: 13 }),
      )
    : null;
  const errorSlot = h("p", { class: "field__error", id: errorId, role: "alert", hidden: true });

  // The disabled-with-reason slot: shown (and tied in via aria-describedby,
  // below) only while the control is refused. A plain hint, not an alert: being
  // refused is standing state, not a fresh problem to interrupt on.
  const disabledReasonId = `${opts.id}-disabled-reason`;
  const disabledSlot = h("p", { class: "field__hint", id: disabledReasonId, hidden: true });
  // Set again as a PROPERTY (not just the `hidden: true` attribute above): errorSlot's own construction
  // has carried this exact gap since before this file's own dom-shim test doubled as documentation of it
  // (test/cov/components-field.ts's SHIM NOTE) -- the lightweight test shim mirrors `.hidden` onto the
  // DOM only via the property setter, not from the attribute an element is built with, so a slot never
  // touched by a property assignment reads not-hidden under the shim even though the attribute is set. A
  // real browser reads this identically either way (the assignment is a same-value no-op); the shim does
  // not, and applyDescribedBy below depends on disabledSlot.hidden reading true before setDisabled is
  // ever called.
  disabledSlot.hidden = true;

  // describedby: hint first (when present), then the disabled reason, then the error when shown.
  const describedBy: string[] = [];
  if (hint) describedBy.push(hintId);
  const applyDescribedBy = () => {
    const ids = [...describedBy];
    if (!disabledSlot.hidden) ids.push(disabledReasonId);
    if (!errorSlot.hidden) ids.push(errorId);
    if (ids.length) control.setAttribute("aria-describedby", ids.join(" "));
    else control.removeAttribute("aria-describedby");
  };
  applyDescribedBy();

  const wrapper = h("div", { class: "field" }, label, control, hint ?? false, docLink ?? false, disabledSlot, errorSlot);

  let errored = false;

  function readValue(): string {
    return kind === "select" ? control.value : control.value.trim();
  }

  // readBadInput reports the control's OWN conversion failure (see Field.badInput). It reads a boolean off
  // ValidityState and nothing else: the text the operator typed is not readable here even in principle (the
  // control has already discarded it), which is exactly why the row that uses this can carry no value.
  function readBadInput(): boolean {
    const v = (control as { validity?: { badInput?: unknown } }).validity;
    return typeof v === "object" && v !== null && v.badInput === true;
  }

  // errorPaintSeq counts every error this field has painted. It exists for ONE reader, the deferred blur
  // revalidation below, and the reason is a defect that erased its own refusal: see the blur listener.
  let errorPaintSeq = 0;

  function setError(message: string): void {
    errored = true;
    errorPaintSeq += 1;
    errorSlot.textContent = message;
    errorSlot.hidden = false;
    control.setAttribute("aria-invalid", "true");
    applyDescribedBy();
  }

  function clearError(): void {
    errored = false;
    errorSlot.textContent = "";
    errorSlot.hidden = true;
    control.removeAttribute("aria-invalid");
    applyDescribedBy();
  }

  // setDisabled routes through the shared disabledWithReason primitive above (aria-disabled, never
  // the native `disabled` attribute; the reason shown as a standing hint AND wired in via aria-describedby;
  // keydown/mousedown/paste blocked). field()'s own describedBy list already tracks the hint/error ids, so
  // applyDescribedBy runs again after the primitive's own aria-describedby write to fold disabledSlot's id
  // in alongside them in the field's own fixed order (hint, then disabled reason, then error) rather than
  // whatever order the primitive alone would leave it in.
  const applyDisabled = disabledWithReason(control, disabledSlot);
  function setDisabled(reason: string | null): void {
    applyDisabled(reason);
    applyDescribedBy();
  }

  // runValidate is the validator, and `record` is whether a refusal it finds is EVIDENCE.
  //
  // THE COUNT WAS INVERTED, AND THE COUNT IS THE HALF OF THE TICKET THE PACK EXISTS TO ANSWER ("which fields
  // rejected, HOW OFTEN"). validate() is wired to blur AND, once a field has errored, to every `input` event.
  // Correcting a refused field is the WORKING PATH: an operator who pastes an SSO URL without its scheme, sees
  // the error, clears the box and types the correct "https://idp.example/app/sso/saml" one character at a time
  // passes through eight invalid prefixes on the way, and each keystroke wrote another refusal row. The
  // connection SAVED, and the pack showed nine refusals. The operator who is genuinely stuck, pasted three URLs
  // the console will not take and rang support showed three. The stuck operator read as a third of the noise of
  // the one who succeeded, and the two were byte-identical on every other field of the row.
  //
  // THE RULE WAS ALREADY WRITTEN, IN THE FILE NEXT DOOR. custody-step-panels.ts records the split-parameter
  // refusal on BLUR and not on input, and says why in as many words: on input, "12" passes through "1", which the
  // ceremony correctly refuses, so an operator typing a perfectly good pair would produce a refusal row every
  // time. That is this defect exactly, and field() carries roughly fifty of the vocabulary's members to the
  // custody panel's four.
  //
  // So the input path REVALIDATES SILENTLY (the operator still sees the error clear as soon as the value is
  // good), and blur and submit -- the two events where the operator LEFT the control, or ASKED the console to
  // take it, with a value it will not take -- record. That is the row's meaning, and now it is its producer.
  function runValidate(record: boolean): boolean {
    const v = readValue();
    if (opts.required && v === "") {
      // NOT recorded (G335). A required field that is still empty is an operator part-way through a form, and
      // on blur that is the single commonest event in the console. Recording it would bury every real refusal
      // under it and teach support to ignore the signal, which is what a wolf cry costs.
      setError(opts.requiredMessage ?? `${opts.label} is required.`);
      return false;
    }
    if (opts.validate) {
      // Read ONCE and hand the same answer to the validator and the recorder. The validator needs it to refuse
      // at all (the value is gone), and the recorder needs it to tell "the operator has not filled this in yet"
      // from "the control ate what they typed": see recordFormRefused. Reading it twice would let the two
      // disagree, which is the whole class of fault this funnel exists to close.
      const bad = readBadInput();
      const msg = opts.validate(v, { badInput: bad });
      if (msg) {
        // G335: the console's OWN validator refused a value the operator actually typed. No request is made, so
        // the engine has no view of this at all: "the form will not accept my bucket name / cron / endpoint" has
        // never had a shred of evidence anywhere. THIS is the one funnel every field() control validates through,
        // so one call here covers the console.
        //
        // THE EMPTY VALUE IS NEVER RECORDED, and that rule is enforced HERE rather than left to each caller.
        // The `required` branch above already exempts the empty state, with the reason spelled out: an operator
        // part-way through a form is the commonest blur in the console, and burying every real refusal under it
        // is what a wolf cry costs. But a caller can express the SAME emptiness rule through its VALIDATOR arm
        // instead (`validate: (v) => (v.length >= 1 ? null : "Paste the deploy token.")`), and six deploy-token
        // controls did exactly that, so the exempted state came straight back in through this branch. Worse, the
        // row it wrote asserted a fact the code never established: rejectOutcome "rejected" means the validator
        // turned the operator away from THE VALUE THEY TYPED, and on an empty field no value was examined. A
        // support engineer reading a token-field rejection on a 02:00 rollback pack would go and investigate
        // token validation on a rollback that was never attempted.
        //
        // So the funnel now records a refusal only when there was a value to refuse. A validator that can only
        // reject the empty string therefore has no producer at all, and its control id is not a member of the
        // vocabulary (the dead-vocab gate models this and will fail the build if one is added back).
        //
        // The catalogued control id is recorded and NOTHING ELSE. The typed value never leaves the browser, and
        // on these fields that is not a formality: they hold licence tokens, deploy tokens, recovery codes, SAML
        // certificates, endpoints and email addresses. The message is not recorded either (it is prose, and some
        // validators quote the value back). An id the closed vocabulary does not know is DROPPED, never coerced.
        //
        // The emptiness rule is now enforced INSIDE recordFormRefused (R5), which takes the raw value and cannot
        // write a row without one, so this funnel simply hands it over: the rule is the recorder's, not each
        // caller's, and the three DIRECT call sites that broke it cannot break it again.
        const ff = opts.diagField ?? formFieldFor(opts.id);
        if (ff !== null && record) recordFormRefused(ff, v, { badInput: bad });
        setError(msg);
        return false;
      }
    }
    clearError();
    return true;
  }

  // validate() is the RECORDING validation: blur, submit (validateForm), and every screen that calls
  // field.validate() by hand before a save. Each of those is the operator leaving or submitting a value the
  // console will not take, which is what a `rejected` row asserts.
  function validate(): boolean {
    return runValidate(true);
  }

  // Validate on blur (not on every keystroke); re-validate on change once errored.
  installPressGuard();
  control.addEventListener("blur", () => {
    // Only validate on blur if the field carries a rule (required/validate); a free
    // optional field should not error just for being touched and left empty.
    // Through the press guard, because a blur is very often the FIRST HALF of a press on the control
    // below this one, and painting an error there takes that control out from under the pointer before
    // the button comes back up. See paintAfterPress.
    //
    // AND IT MUST NOT RUN IF THE SUBMIT IT DEFERRED PAST HAS ALREADY REFUSED THIS FIELD. releasePress
    // runs the queued paints on a task boundary, deliberately AFTER the click, and the click is exactly
    // where a form's own submit handler calls refuse()/setError() on the field the operator just left to
    // press the button. The queued validate then re-ran the FIELD'S OWN rule, found nothing to say (the
    // refusal came from the form's rule, not this field's), and called clearError(): the reason appeared
    // for one task and was erased. From the operator's seat the Save button did nothing at all.
    // Driven against the built bundle: a real pointer press erased "Names cannot be workers.dev URLs"
    // and "A binding is required for this source type."; the identical submit via element.click(), which
    // queues nothing, kept both.
    //
    // The sequence read here is this field's own error count, so the guard is exact rather than
    // time-based: if nothing painted an error on this field between the blur and the deferred run, the
    // revalidation goes ahead unchanged, which is every ordinary blur.
    if (opts.required || opts.validate) {
      const seqAtBlur = errorPaintSeq;
      paintAfterPress(() => {
        if (errorPaintSeq !== seqAtBlur) return;
        validate();
      });
    }
  });
  control.addEventListener("input", () => {
    if (opts.onInput) opts.onInput(readValue());
    // SILENT (G335): the error clears the moment the value becomes good, and a still-invalid prefix of a value
    // the operator is halfway through typing records nothing. See runValidate above.
    if (errored) runValidate(false);
  });

  // refuse (G335): the console's own rule refused this control from OUTSIDE the validate() funnel. It records the
  // same row the funnel would, then shows the error. Only the catalogued control id rides; the message is prose
  // (several of these quote the value back) and the typed value never leaves the browser.
  //
  // THE EMPTY VALUE IS NOT RECORDED HERE EITHER, and it is guarded HERE rather than trusted to each caller (R4,
  // ). The funnel's rule (a `rejected` row asserts the console refused THE VALUE THE OPERATOR TYPED, so
  // there has to have been one) was made structural in validate() and left open on this arm, and two console rules
  // walked straight through it on an empty box: the IdP preset's confidential-client secret and the downpipe
  // editor's required binding. Both are the required-and-empty state under another name, both are shown to an
  // operator who is looking straight at the message, and the row they wrote said the validator had examined a
  // value it never saw. Those two call sites now use setError, which claims nothing; this guard is what stops the
  // next one. A rule that refuses a value the operator DID type (a workers.dev URL in a binding box, a PEM paste
  // with no complete block in it) records exactly as before.
  function refuse(message: string): void {
    const ff = formFieldFor(opts.id);
    if (ff !== null) recordFormRefused(ff, readValue());
    setError(message);
  }

  return {
    el: wrapper,
    control,
    value: readValue,
    badInput: readBadInput,
    setError,
    refuse,
    clearError,
    setDisabled,
    validate,
    focus: () => control.focus(),
  };
}

// --- The press guard ------------------------------------------------------------------------------
//
// A field's error slot is `hidden` until it has something to say, so showing it (or clearing it) CHANGES
// THAT FIELD'S HEIGHT and moves every control below it. That is harmless while nothing is being pressed.
// It is not harmless during a press, because pressing a control BELOW a field is exactly what blurs that
// field: the button goes down, blur validation paints the error, the pressed control slides away from the
// pointer, the button comes up somewhere else, and the browser raises the click on the nearest common
// ancestor of the two points instead of on the control. The control receives no click at all.
//
// On the live push configure form, a Splunk HEC token typed without its "Splunk " scheme can repaint an
// error beneath the Enabled checkbox: one press then puts mousedown on INPUT#push-enabled and mouseup on
// a div 45px lower, so the click lands on the FORM and the checkbox does not toggle. By contrast, the
// same press with an ACCEPTED secret (nothing to paint) toggles the checkbox, and
// the same press with the error ALREADY on screen (nothing to paint) toggled it too. The 45px is the
// secret field's error slot appearing. Nothing about the checkbox was wrong; the row it sits in moved.
//
// The reading that shape invites is worse than the defect. It looks exactly like a checkbox that will not
// take a click, which reads as "an operator cannot untick Enabled, or tick anything in the notify rule
// form", because those checklists are built by the same factory. They are fine.
//
// The checkbox is not the worst of it either. The SAVE button sits below every field on the form, so the
// FIRST press of Configure after typing a refused secret is swallowed the same way and by the same 45px:
// driven on the real components, mousedown landed on the button, mouseup landed on the error slot that had
// just appeared, and the button's own click handler ran zero times. The operator does see the refusal, so
// it is not silent, but the press they made on Save did nothing and nothing on screen attributes that.
//
// So a height-changing paint that would land mid-press waits for the release. The value is validated at
// the same moment against the same rule and produces the same message; only the paint moves, by one task,
// to after the click it would otherwise have stolen. Clearing is held back on the same terms as painting,
// because a field that shrinks moves the row below it exactly as a field that grows does.

// How long a deferred paint will wait for a release before painting anyway. A press whose release the
// document never sees (dragged into another frame, taken over by a scroll, the tab hidden mid-press) must
// not strand an error unpainted: a late error is a far smaller fault than a silent one.
const MAX_PRESS_DEFER_MS = 500;

let pressInFlight = false;
let pendingPaints: Array<() => void> = [];
let pressGuardInstalled = false;

function releasePress(): void {
  pressInFlight = false;
  if (pendingPaints.length === 0) return;
  const queued = pendingPaints;
  pendingPaints = [];
  // AFTER the release, not during it: pointerup, mouseup and click are dispatched in one turn, so a paint
  // run from the pointerup listener is still inside the gesture it must not disturb. A task boundary puts
  // it after the click.
  setTimeout(() => {
    for (const paint of queued) paint();
  }, 0);
}

// installPressGuard wires the one document-level set the guard needs, once for the whole console.
// Capture phase, so a press is known to be in flight before any handler on the way down can act on it.
//
// A document that cannot register a listener is left alone rather than crashed into (the same guard
// restore-flow/dryrun-sweep.ts makes, for the same reason): ten of the console's validators stand up a
// minimal document stub with create/query methods and no event target at all. With no guard installed
// nothing ever reports a press, so every paint runs immediately, which is exactly the behaviour those
// tests already assert. It is not marked installed on that path, so a later real document still gets it.
function installPressGuard(): void {
  if (pressGuardInstalled) return;
  if (typeof document.addEventListener !== "function") return;
  pressGuardInstalled = true;
  document.addEventListener("pointerdown", () => { pressInFlight = true; }, true);
  document.addEventListener("pointerup", releasePress, true);
  // pointercancel as well as pointerup: a press the browser takes over (a scroll, a gesture) ends with no
  // pointerup at all, and the queue has to drain on that path too.
  document.addEventListener("pointercancel", releasePress, true);
}

// paintAfterPress runs a paint that can change a field's height, holding it back until a press in flight
// is released. With no press in flight it runs straight away, which is the ordinary case: a blur from the
// keyboard, a blur from clicking into a control that is not below this one, and every submit (validateForm
// runs from a click handler, which is after the release).
function paintAfterPress(paint: () => void): void {
  if (!pressInFlight) {
    paint();
    return;
  }
  let painted = false;
  const once = (): void => {
    if (painted) return;
    painted = true;
    paint();
  };
  pendingPaints.push(once);
  setTimeout(once, MAX_PRESS_DEFER_MS);
}

// validateForm runs every field's validator, focuses the first invalid one, and
// returns true only if all are valid (focus the first invalid
// field on submit; never lose input).
export function validateForm(fields: Field[]): boolean {
  let firstInvalid: Field | null = null;
  for (const f of fields) {
    if (!f.validate() && firstInvalid === null) firstInvalid = f;
  }
  if (firstInvalid) {
    firstInvalid.focus();
    return false;
  }
  return true;
}
