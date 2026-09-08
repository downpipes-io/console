// The 5-field cron grammar parser, extracted from schedule.ts.
// This is the console's CLIENT-SIDE mirror of the engine's cron.ts parseField/parseCron: the SAME
// 5-field grammar, the SAME Vixie dom/dow union rule, the SAME bounds + messages. It is a deliberate
// small re-implementation of the engine's PUBLIC SEMANTICS for a pre-flight + a preview; the engine
// remains the authority and re-validates on save. Behaviour is byte-identical to the original block.

// ---- cron grammar (mirror of engine/src/sched/cron.ts parseField/parseCron) -----------------------
// The standard 5-field crontab grammar, no extensions: minute hour day-of-month month day-of-week.
// Each field is *, N, A-B, A,B,C, */n, A-B/n, or A/n. Names (JAN/MON), @-macros (@daily), seconds,
// and L/W/#/? qualifiers are REJECTED (exactly as the engine rejects them), so a malformed expr can
// never silently mis-schedule.

interface FieldRange {
  min: number;
  max: number;
}

// The field order + ranges are the engine's RANGES table. day-of-week additionally accepts 7 as an
// alias for Sunday (0), the common crontab convenience, validated against an extended max of 7.
const CRON_FIELDS: Array<{ name: string; range: FieldRange; dow?: boolean }> = [
  { name: "minute", range: { min: 0, max: 59 } },
  { name: "hour", range: { min: 0, max: 23 } },
  { name: "day-of-month", range: { min: 1, max: 31 } },
  { name: "month", range: { min: 1, max: 12 } },
  { name: "day-of-week", range: { min: 0, max: 6 }, dow: true },
];

// A parsed field: the concrete set of allowed values, plus whether it was a bare "*" (the dom/dow
// union rule's "no constraint" marker). Mirrors the engine's FieldSpec.
export interface ParsedField {
  star: boolean;
  values: Set<number>;
}

// parseCronField parses ONE comma-separated field, throwing a field-named, human-readable Error on
// any malformed term, the SAME messages the engine's parseField throws (so the inline error the
// console shows is the engine's own reason). fieldName is the spelled-out field name for the message.
function parseCronField(raw: string, fieldName: string, range: FieldRange, isDow: boolean): ParsedField {
  const { min, max } = range;
  const rangeMax = isDow ? 7 : max;

  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`cron ${fieldName} field is empty`);
  }
  const term = raw.trim();
  const star = term === "*";
  const values = new Set<number>();

  const addValue = (n: number): void => {
    if (!Number.isInteger(n) || n < min || n > rangeMax) {
      throw new Error(`cron ${fieldName} value ${n} out of range ${min}-${max}`);
    }
    values.add(isDow && n === 7 ? 0 : n);
  };

  for (const partRaw of term.split(",")) {
    const part = partRaw.trim();
    if (part === "") throw new Error(`cron ${fieldName} field has an empty list item`);

    const { body, step } = parseStepModifier(part, fieldName);
    const span = parseBodyRange(body, step !== null, fieldName, range, rangeMax);
    if (span === "single") {
      addValue(Number(body));
      continue;
    }
    for (let v = span.lo; v <= span.hi; v += step ?? 1) addValue(v);
  }

  if (values.size === 0) throw new Error(`cron ${fieldName} field matched no values`);
  return { star, values };
}

// parseStepModifier splits an optional "/n" step off a cron list item, validating n as a positive
// integer with a non-empty base. step is null when no "/" was present (the implicit step of 1).
function parseStepModifier(part: string, fieldName: string): { body: string; step: number | null } {
  const slash = part.indexOf("/");
  if (slash === -1) return { body: part, step: null };
  const body = part.slice(0, slash).trim();
  const stepStr = part.slice(slash + 1).trim();
  if (!/^\d+$/.test(stepStr)) throw new Error(`cron ${fieldName} step "${stepStr}" must be a positive integer`);
  const step = Number(stepStr);
  if (step < 1) throw new Error(`cron ${fieldName} step must be at least 1`);
  if (body === "") throw new Error(`cron ${fieldName} step is missing its base (use */n, A/n, or A-B/n)`);
  return { body, step };
}

// parseBodyRange resolves a cron term body (after any step was stripped) to an inclusive lo/hi span,
// validating against the field range. A bare scalar with NO step returns the "single" sentinel so the
// caller adds it directly; a bare scalar WITH a step expands from the scalar up to the field max.
function parseBodyRange(
  body: string,
  hasStep: boolean,
  fieldName: string,
  range: FieldRange,
  rangeMax: number,
): { lo: number; hi: number } | "single" {
  const { min, max } = range;
  if (body === "*") return { lo: min, hi: max };
  if (body.includes("-")) {
    const dash = body.indexOf("-");
    const aStr = body.slice(0, dash).trim();
    const bStr = body.slice(dash + 1).trim();
    if (!/^\d+$/.test(aStr) || !/^\d+$/.test(bStr)) {
      throw new Error(`cron ${fieldName} range "${body}" must be two integers A-B`);
    }
    const lo = Number(aStr);
    const hi = Number(bStr);
    if (lo > hi) throw new Error(`cron ${fieldName} range "${body}" must have A <= B`);
    if (lo < min || hi > rangeMax) throw new Error(`cron ${fieldName} range "${body}" out of range ${min}-${max}`);
    return { lo, hi };
  }
  if (!/^\d+$/.test(body)) throw new Error(`cron ${fieldName} term "${body}" is not a valid number, range, or step`);
  const n = Number(body);
  if (n < min || n > rangeMax) throw new Error(`cron ${fieldName} value ${n} out of range ${min}-${max}`);
  return hasStep ? { lo: n, hi: max } : "single";
}

// A fully-parsed 5-field expression (the console's CronSpec). minute/hour/dom/month/dow each a
// ParsedField. Mirrors the engine's CronSpec.
export interface ConsoleCronSpec {
  minute: ParsedField;
  hour: ParsedField;
  dom: ParsedField;
  month: ParsedField;
  dow: ParsedField;
}

// parseCron parses a whole 5-field expression, throwing a clear Error (the engine's own messages) on
// a wrong field count, an @-macro, or any malformed field. Exactly five whitespace-separated fields.
export function parseCron(expr: string): ConsoleCronSpec {
  if (typeof expr !== "string") throw new Error("cron expression must be a string");
  const trimmed = expr.trim();
  if (trimmed === "") throw new Error("cron expression is empty");
  if (trimmed.startsWith("@")) {
    throw new Error(`cron @-macros (e.g. "${trimmed}") are not supported; use the 5-field form`);
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`);
  }
  const parsed = fields.map((f, i) => {
    const spec = CRON_FIELDS[i]!;
    return parseCronField(f!, spec.name, spec.range, spec.dow === true);
  });
  return { minute: parsed[0]!, hour: parsed[1]!, dom: parsed[2]!, month: parsed[3]!, dow: parsed[4]! };
}

// validateCronExpr is the console's pre-flight guard, the mirror of the engine's validateCron: it
// parses (throwing on malformed) and returns the field-named reason string, or null when the cron is
// a well-formed 5-field expression. The editor shows the returned string as an inline error; null
// means the engine's own validateConfig would accept the grammar too.
export function validateCronExpr(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
