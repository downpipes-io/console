// Structured logging helper for the console Worker (guardrails §11).
//
// ACCEPTED DEVIATION (guardrails §6 no-console rule): this file IS the structured logger
// that replaces ad-hoc console use elsewhere, so the console.error/console.log calls below
// are the single sanctioned emit point. No other module may call console directly.
//
// log() emits a SINGLE line of JSON to stdout (via console.error/console.log, which
// Workers Logs and the [observability] sink in wrangler.toml capture per request). The
// shape is fixed so a log pipeline can index it without per-call parsing:
//
//   ts          ISO8601 UTC timestamp (new Date().toISOString())
//   level       "error" | "warn" | "info" | "debug"
//   service     the Worker name ("console")
//   env         the deploy environment, sourced from env.ENVIRONMENT when bound, else "unknown"
//   event       a stable short event identifier (e.g. "request.unhandled")
//   method      the HTTP method, when a request is in scope
//   path        the URL pathname, when a request is in scope
//   status      the HTTP status returned, when known
//   duration_ms request duration in milliseconds, when measured
//   error_code  a coarse, non-sensitive error classifier, when applicable
//
// REDACTION: this helper carries forward the existing behaviour of the call sites it
// replaces, which deliberately log NO raw error message, stack, header, body or any
// caller-supplied value. Only the fixed, non-sensitive fields above are ever emitted, so
// the strict no-leak property of the original fixed log lines is preserved verbatim. Do
// not pass raw error objects, request bodies or header values through LogFields.

export type LogLevel = "error" | "warn" | "info" | "debug";

// LogFields are the optional per-call fields. None is required, and any left undefined is
// omitted from the JSON, so a sparse call stays a compact single line. Every field is a
// fixed, non-sensitive primitive by contract; never widen this to free-form data.
export interface LogFields {
  method?: string;
  path?: string;
  status?: number;
  duration_ms?: number;
  error_code?: string;
}

// SERVICE is the fixed Worker name for the service field. The console is a single Worker.
const SERVICE = "console";

// resolveEnv reads an optional ENVIRONMENT string off the Worker env binding without
// requiring it: when unbound (the current wrangler.toml carries no such var) the field is
// "unknown" rather than throwing, so adding the helper changes no runtime behaviour.
function resolveEnv(env?: { ENVIRONMENT?: string } | null): string {
  return env?.ENVIRONMENT ?? "unknown";
}

// log emits one structured JSON line. It never throws on serialisation: the field set is
// all primitives by contract. Errors route to console.error so they land on the error
// stream; everything else uses console.log. The control flow of callers is unchanged: this
// is a drop-in replacement for the fixed log strings it supersedes.
export function log(
  level: LogLevel,
  event: string,
  fields: LogFields = {},
  env?: { ENVIRONMENT?: string } | null,
): void {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    service: SERVICE,
    env: resolveEnv(env),
    event,
  };
  if (fields.method !== undefined) line.method = fields.method;
  if (fields.path !== undefined) line.path = fields.path;
  if (fields.status !== undefined) line.status = fields.status;
  if (fields.duration_ms !== undefined) line.duration_ms = fields.duration_ms;
  if (fields.error_code !== undefined) line.error_code = fields.error_code;

  const serialised = JSON.stringify(line);
  if (level === "error") {
    console.error(serialised);
  } else {
    console.log(serialised);
  }
}
