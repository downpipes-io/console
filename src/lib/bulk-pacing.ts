// Shared pacing for the console's bulk loops: the bulk run/disable/delete path and the
// fleet-drill loop fire one engine request per item. When the engine's rate limiter answers 429 the
// old behaviour was a generic "engine returned an error (...: 429)" with no Retry-After, no backoff and
// no pacing, so a 429 storm read as N unexplained failures. These helpers let each loop (1) recognise a
// 429 distinctly, (2) back off by the engine's Retry-After (capped) before retrying, and (3) label a
// 429 failure honestly in the summary instead of as a bare "did not pass".
//
// They are deliberately PURE (no DOM, no network) except `sleep`, so the backoff maths and the
// labelling are unit-testable without a real timer. House rules: Australian English, no em dashes.

import { classifyError } from "./errors.ts";
import { refusalText } from "../components/error-view.ts";

// The default backoff when the engine sent a 429 with no honour-able numeric Retry-After: a short,
// fixed pause so the loop yields rather than hammering, without guessing a long wait.
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 2_000;

// The cap on a single backoff: an honoured Retry-After above this is clamped so a misconfigured or
// hostile header cannot wedge the UI for minutes. A genuinely long limit surfaces as a labelled failure
// the operator can retry deliberately, rather than a silent multi-minute hang.
export const MAX_RATE_LIMIT_BACKOFF_MS = 60_000;

// The number of automatic retries a single item gets on a 429 before it is recorded as a (labelled)
// failure. Bounded so a persistently throttled item cannot loop forever.
export const MAX_RATE_LIMIT_RETRIES = 3;

// isRateLimited reports whether a thrown error is the engine's 429 rate limit (classifyError owns the
// taxonomy; this is the hot-path predicate the loops branch on).
export function isRateLimited(err: unknown): boolean {
  return classifyError(err).kind === "rate-limited";
}

// rateLimitDelayMs converts a thrown 429's Retry-After into a capped backoff in milliseconds. A
// non-429 error (defensive) and a 429 with no numeric Retry-After both yield the default backoff.
export function rateLimitDelayMs(err: unknown): number {
  const k = classifyError(err);
  if (k.kind !== "rate-limited" || k.retryAfter === null || k.retryAfter <= 0) return DEFAULT_RATE_LIMIT_BACKOFF_MS;
  return Math.min(k.retryAfter * 1000, MAX_RATE_LIMIT_BACKOFF_MS);
}

// bulkFailureReason labels a per-item failure for the summary modal and for a restore batch row, which
// is the one place a customer reads a per-item refusal on its own with no sentence around it. A 429 is
// named distinctly (with the Retry-After when known) so the operator sees "rate limited" rather than an
// opaque "did not pass"; every other error goes through refusalText, the reviewed rule.
//
// IT USED TO RETURN errText, THE RAW THROW, and that is a defect rather than a shortcut. The transport's
// message is a log line, not a sentence: it carries a wire verb on the front, the HTTP status glued past
// the end, and on a 403 a `forbidden-class=` token this console defines for its OWN classifier. A
// customer restoring several downpipes at once read "restore: forbidden: 403" in a danger banner. The
// rule that a console-internal token must never surface, and that the engine's own words may, is
// refusalText, and it was already applied to the destination form, the downpipe editor and the source
// token field. A restore batch row is a harder case than any of those, not an easier one.
export function bulkFailureReason(err: unknown): string {
  const k = classifyError(err);
  if (k.kind === "rate-limited") {
    return k.retryAfter !== null
      ? `rate limited by the engine (retry after ${k.retryAfter}s); automatic retries were exhausted`
      : "rate limited by the engine; automatic retries were exhausted";
  }
  return refusalText(err);
}

// sleep is the one non-pure piece: a promise that resolves after ms. window.setTimeout is used so the
// DOM shim's timer drives it under the validators.
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
