// Bound validators for field() controls whose catalogue row states a real, citable bound.
//
// THE DEFECT THESE CLOSE. components/field.ts validates on blur only when the field carries a rule
// (`required` or `validate`). Thirteen controls whose catalogued accepted_values state a bound
// carried neither, so the console took a value it had just told the operator it would not take: the
// role builder accepted a 65-character name under a hint reading "1 to 64 chars", the retention
// boxes accepted 0 and -5 under a hint reading "Whole number, 1 to 10,000", and the WORM retention
// box accepted 0 under a hint reading "A whole number greater than zero". Six of the thirteen bound
// their own contradicting hint. The refusal, where one existed at all, came later and elsewhere: a
// form-level error at submit, or a live validity line beside the control, never at the field.
//
// WHY A SHARED MODULE RATHER THAN THIRTEEN INLINE ARROWS. The catalogue's standing invariant is that
// client and server validation must not diverge in the client-looser direction, and thirteen
// hand-written range checks are thirteen chances to drift from the bound the catalogue cites. Each
// factory here states the rule once, and each call site names its own bound, so a changed bound is a
// one-line change at the call site and the message follows it automatically.
//
// THE MESSAGE BAR, the checkable definition of "helpful": a human
// heading rather than a raw code or bare status, a named remedy, no internals leaked, contained to a
// region rather than replacing the screen, recoverable, and not carried by colour alone. Every
// message below is one sentence stating the rule in the operator's own vocabulary, then one sentence
// naming what to do about it, with a worked example wherever the field has one. None quotes a
// pattern, a constant name, a status code or a function name. The containment, the recoverability
// and the non-colour channel are field()'s, not each message's: the text lands in the control's own
// `<id>-error` slot with role="alert" and aria-invalid, the value is never cleared, and the error
// clears the moment the value becomes good.
//
// THE EMPTY BOX IS NOT THIS MODULE'S BUSINESS. Every factory returns null for a blank value: an
// operator part-way through a form is the commonest blur in the console, and field()'s own `required`
// arm already owns that case (and deliberately records no evidence for it). A field where blank is
// genuinely invalid passes `required: true` alongside its validator.

// BadInputMeta is field()'s second validator argument. On a type="number" control the browser
// discards anything that is not a valid floating-point number, so ".value" reads "" for a typed
// "abc" and no validator can tell it from an untouched box. validity.badInput is the one surviving
// signal, and a bounds check that ignores it accepts "abc" in silence.
export interface BadInputMeta {
  badInput: boolean;
}

export type FieldValidator = (value: string, meta?: BadInputMeta) => string | null;

// groupDigits renders a bound the way an operator reads it (10000 -> "10,000"). Kept local and tiny
// rather than importing lib/format, so this module stays a leaf with no screen dependencies.
function groupDigits(n: number): string {
  return n.toLocaleString("en-AU");
}

// parseWholeNumber reads the operator's text as a whole number, or returns null when it is not one.
// The trim matters: field()'s own value() already trims an input, but a validator is also called
// directly by a screen's submit path with a raw string.
function parseWholeNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // Number() accepts "1e3", " 12 ", "0x10" and "Infinity"; a whole-number field takes none of those,
  // so the digits are checked as digits before the conversion rather than after it.
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : null;
}

// wholeNumberBetween: a whole number from min to max inclusive, blank permitted.
//
// `noun` is the field's own subject in the operator's words ("Session duration"), NOT its id and not
// its full label: the label carries the bound and the units already ("Session duration (seconds,
// optional)"), and repeating those inside the message reads as machine output. `remedy` is the
// second sentence, the one that says what to do.
export function wholeNumberBetween(opts: {
  noun: string;
  min: number;
  max: number;
  unit?: string;
  remedy: string;
}): FieldValidator {
  const unit = opts.unit === undefined ? "" : ` of ${opts.unit}`;
  const rule = `${opts.noun} must be a whole number${unit} from ${groupDigits(opts.min)} to ${groupDigits(opts.max)}.`;
  return (value, meta) => {
    if (meta?.badInput === true) return `${rule} ${opts.remedy}`;
    const n = parseWholeNumber(value);
    if (n === null) return value.trim() === "" ? null : `${rule} ${opts.remedy}`;
    return n < opts.min || n > opts.max ? `${rule} ${opts.remedy}` : null;
  };
}

// wholeNumberAtLeast: a whole number of at least min, no upper bound stated, blank permitted.
export function wholeNumberAtLeast(opts: {
  noun: string;
  min: number;
  unit?: string;
  remedy: string;
}): FieldValidator {
  const unit = opts.unit === undefined ? "" : ` of ${opts.unit}`;
  const rule = `${opts.noun} must be a whole number${unit} of at least ${groupDigits(opts.min)}.`;
  return (value, meta) => {
    if (meta?.badInput === true) return `${rule} ${opts.remedy}`;
    const n = parseWholeNumber(value);
    if (n === null) return value.trim() === "" ? null : `${rule} ${opts.remedy}`;
    return n < opts.min ? `${rule} ${opts.remedy}` : null;
  };
}

// atMostChars: a display string bounded on its length only, blank permitted.
export function atMostChars(opts: { noun: string; max: number; remedy: string }): FieldValidator {
  const rule = `${opts.noun} must be ${groupDigits(opts.max)} characters or fewer.`;
  return (value) => (value.length > opts.max ? `${rule} ${opts.remedy}` : null);
}

// matchingPattern: a string bounded by a shape, described to the operator in words rather than as the
// pattern itself (the pattern is an internal, and a message that prints one fails the bar).
export function matchingPattern(opts: { pattern: RegExp; rule: string; remedy: string }): FieldValidator {
  return (value) => {
    if (value.trim() === "") return null;
    return opts.pattern.test(value.trim()) ? null : `${opts.rule} ${opts.remedy}`;
  };
}

// firstFailingLine applies a per-line rule to a multi-line paste and names the OFFENDING LINE by
// number. A list field that reports only "something in this list is wrong" makes the operator
// re-read their own paste, which is the opposite of a named remedy.
export function firstFailingLine(opts: {
  lineRule: (line: string) => boolean;
  describe: string;
  remedy: string;
}): FieldValidator {
  return (value) => {
    if (value.trim() === "") return null;
    const lines = value.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] ?? "").trim();
      if (line === "") continue; // a blank line is dropped, never refused
      if (!opts.lineRule(line)) {
        return `Line ${i + 1} is not ${opts.describe} ${opts.remedy}`;
      }
    }
    return null;
  };
}

// ---- shapes shared by more than one call site -------------------------------------------------

// HTTP_HEADER_NAME_PATTERN is the RFC 7230 token character set, 1 to 100 characters. It mirrors the
// engine's PUSH_HEADER_NAME_RE (engine/src/admin/router-push.ts:25) and OTLP_PUSH_HEADER_NAME_RE
// (engine/src/admin/router-otlp-push.ts:18) character for character, so the console cannot accept a
// header name the engine would refuse with a 400.
export const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,100}$/;

// ---- the push auth SECRET: the bound the engine enforces, plus the scheme the vendor requires ----------

// PUSH_SECRET_MAX_LEN and PUSH_SECRET_CONTROL_RE are the console's reading of the engine's screen on the
// push auth header VALUE (engine isValidPushHeaderValue: within the length cap, free of C0 controls and DEL).
// SPACE is deliberately legal, because a "Scheme <token>" credential is the normal shape.
//
// THESE TWO ARE NOT A HAND-TRANSCRIBED MIRROR, and that distinction is the point. The line above this one
// (HTTP_HEADER_NAME_PATTERN) IS a hand-transcribed mirror with a comment citing an engine line number, and that
// is exactly the failure mode a hand-transcribed mirror invites: nothing detects the day the engine's rule
// moves. scripts/push-secret-drift-gate.mjs closes that here by DIFFERENTIALLY FUZZING pushAuthSecret against
// the engine's own isValidPushHeaderValue over a corpus (every C0 character, DEL, SPACE, the length
// boundaries, a "Splunk <token>" credential, a JWT, multibyte text) and failing when the two disagree on any
// input. It also runs the ENGINE'S function over every scheme the vendor catalogue declares, so a future
// engine change that stopped admitting a space would turn the gate red rather than shipping a token the engine
// answers 400. The gate has no engine-missing branch: it fails when it cannot compare, and it fails when the
// catalogue declares no scheme for it to check.
export const PUSH_SECRET_MAX_LEN = 8192;
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing the C0 controls is the engine's own auth-header-value injection guard, mirrored here so a CR/LF paste is named at the field instead of returning an opaque 400.
const PUSH_SECRET_CONTROL_RE = /[\x00-\x1f\x7f]/;

// pushAuthSecret validates the WRITE-ONLY push auth secret at the field, on blur.
//
// THE DEFECT THIS CLOSES. The push secret field carried `required: true` and nothing else, while the hint
// directly beneath it told the operator, for a Splunk HEC destination, to "paste the token as Splunk <token>,
// including the literal word Splunk and a space. The bare token alone is not enough." So the console stated a
// hard requirement in the operator's own words and then accepted the value that breaks it. The field is
// write-only and never re-displayed, the engine seals the value on arrival, and Splunk answers a bare HEC
// token with a 401 that is indistinguishable from a revoked token: the one screen that knew the rule was the
// one screen that did not check it.
//
// `scheme` is supplied ONLY where the vendor genuinely requires one (catalogue.ts credScheme). It is
// deliberately NOT keyed off the wire format: CrowdStrike Falcon Next-Gen SIEM takes the same splunk-hec
// format over the same http sink and wants a plain bearer token, so a format-keyed rule would refuse the
// correct Falcon credential and demand the word Splunk in front of it.
export function pushAuthSecret(opts: { noun: string; scheme?: string; example?: string }): FieldValidator {
  const word = opts.scheme?.trimEnd() ?? "";
  const schemeRule = `The ${opts.noun} must carry its scheme: the word ${word}, then a space, then the token your destination issued.`;
  const schemeRemedy = opts.example !== undefined ? `Type ${word} and a space in front of the value you copied, for example ${opts.example}.` : `Type ${word} and a space in front of the value you copied.`;
  const lengthRule = `The ${opts.noun} must be ${groupDigits(PUSH_SECRET_MAX_LEN)} characters or fewer.`;
  const controlRule = `The ${opts.noun} must not contain a line break or other invisible control character.`;
  const controlRemedy = "Paste the token on its own, without the surrounding line, then check nothing was copied after it.";
  return (value) => {
    // Blank is field()'s own `required` arm, never this validator's (see the module header).
    if (value.trim() === "") return null;
    // The raw value, not the trimmed one, for the two structural checks: what the operator typed is what the
    // engine screens, and a value that is only within the cap after trimming is not within the cap.
    if (opts.scheme !== undefined && !value.startsWith(opts.scheme)) return `${schemeRule} ${schemeRemedy}`;
    if (value.length > PUSH_SECRET_MAX_LEN) return `${lengthRule} Check you pasted a token rather than a file or a whole response.`;
    if (PUSH_SECRET_CONTROL_RE.test(value)) return `${controlRule} ${controlRemedy}`;
    return null;
  };
}

// nonNegativeRate: a per-unit money rate. Not a whole number (0.015 $/GB-month is a real rate), so
// this is the one factory here that takes a decimal, and it refuses the shapes Number() would
// otherwise wave through on a text control ("1e3", "Infinity", "0x10").
//
// It deliberately does NOT reuse the costs screen's nonNegNumberError (screens/costs/helpers.ts:218):
// that one states the rule and stops ("Storage ($/GB-month) cannot be negative."), with no remedy,
// which is the leg of the verdict bar an inline field error most often drops.
export function nonNegativeRate(opts: { noun: string; remedy: string }): FieldValidator {
  const rule = `${opts.noun} must be a number that is not negative.`;
  return (value, meta) => {
    if (meta?.badInput === true) return `${rule} ${opts.remedy}`;
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (!/^\d*\.?\d+$/.test(trimmed)) return `${rule} ${opts.remedy}`;
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? null : `${rule} ${opts.remedy}`;
  };
}
