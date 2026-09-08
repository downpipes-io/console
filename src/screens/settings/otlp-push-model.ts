// The pure, DOM-free model + presentation layer of the outbound OTLP/HTTP metrics push panel. Split
// out of settings/otlp-push.ts along the same seam push-model.ts follows (the max-lines guardrail),
// so the honesty-critical decisions live in one small, node-testable module. Every export here is a
// pure function or a plain type over plain values: no DOM, no engine call, no side effect.
// settings/otlp-push.ts (the DOM) and test/validate-otlp-push.ts both import from here; settings.ts
// re-exports the presentation helpers so the validator's import surface stays stable.
//
// Unlike the SIEM push (push-model.ts), OTLP push is always ONE shape and ONE transport (no sink or
// format selector) and carries NO cursor (every enabled tick sends the CURRENT snapshot fresh, never
// a drained log), so there is no lag presentation and no per-sink branching here.
//
// House style: Australian English, no em dashes, precise claims (this reports the engine's own
// delivery trail, never "guaranteed" delivery).

import { validateUrl as validateWebhookUrl } from "../notifications/shared.ts";
import type { StatusTone } from "../../components/status.ts";
import type { OtlpPushDeliveryAttempt, OtlpPushDestinationInput, OtlpPushDestinationView } from "../../api.ts";

// The engine retains the most recent 50 delivery attempts (older entries roll over); this must match
// the engine's OTLP_PUSH_TRAIL_CAP (scheduler-do-limits.ts). At the cap the console says "most recent
// N", never a total it cannot know (NC-4, the same discipline push-model.ts's PUSH_TRAIL_MAX follows).
const OTLP_PUSH_TRAIL_MAX = 50;

// The bounded handful of individual attempt lines shown at once (calm-density budget,
//: otlpTrailSummary carries the aggregate count; these are a look, never the
// full history.
const OTLP_PUSH_TRAIL_DISPLAY_MAX = 5;

// validateOtlpPushEndpoint reuses the alert-webhook / SIEM push endpoint's exact rule (https, no
// embedded userinfo, not a workers.dev host): the OTLP push destination inherits the SAME
// egress-secure sender + SSRF screen. It deliberately does NOT check for a private/loopback host:
// that default-deny is the server-side egress guard's job. Exported (pure) for the validator.
export function validateOtlpPushEndpoint(v: string): string | null {
  return validateWebhookUrl(v);
}

// otlpPushDialsOutNote is the one sentence naming that OTLP push, like the SIEM audit-log push, DIALS
// OUT, so a Cloudflare Access perimeter in front of this console does not block it (unlike a PULL
// scrape target, e.g. the metrics scrape scope above it on this screen, which the scraper must reach
// in). Exported (pure) for the validator.
export function otlpPushDialsOutNote(): string {
  return "This engine dials OUT to your OTLP collector on the scheduler tick, so a Cloudflare Access perimeter in front of this console does not block it (unlike a scrape target, which the collector must reach in).";
}

// OtlpPushFormFields is the operator-typed form state; buildOtlpPushSubmission's input.
export interface OtlpPushFormFields {
  endpoint: string;
  authHeaderName: string;
  authHeaderValue: string;
}

// buildOtlpPushInputFields normalises the auth trio: the endpoint is trimmed, a blank header name
// defaults to "Authorization" (the engine's own default), and the secret is carried through verbatim
// (an empty secret is a valid return meaning "no new secret typed"; buildOtlpPushSubmission decides
// whether that omits the wire field). Pure; exported for the validator.
export function buildOtlpPushInputFields(fields: OtlpPushFormFields): OtlpPushFormFields {
  const authHeaderName = fields.authHeaderName.trim();
  return {
    endpoint: fields.endpoint.trim(),
    authHeaderName: authHeaderName === "" ? "Authorization" : authHeaderName,
    authHeaderValue: fields.authHeaderValue,
  };
}

// buildOtlpPushSubmission assembles the wire OtlpPushDestinationInput. The WRITE-ONLY secret rides
// ONLY when the operator typed one (a fresh configure or a rotate); an omitted secret leaves the
// sealed one untouched (the engine's keep-secret semantics). Pure; exported for the validator.
export function buildOtlpPushSubmission(fields: OtlpPushFormFields, enabled: boolean): OtlpPushDestinationInput {
  const built = buildOtlpPushInputFields(fields);
  return {
    endpoint: built.endpoint,
    authHeaderName: built.authHeaderName,
    enabled,
    ...(built.authHeaderValue !== "" ? { authHeaderValue: built.authHeaderValue } : {}),
  };
}

// buildOtlpToggleSubmission reconstructs a secret-free set from the redacted view to flip `enabled`
// without resupplying the write-only secret (the engine keeps the sealed secret when the value is
// omitted). It returns NULL when the view is short of what a set needs: a present destination whose
// redacted view carries no endpoint is a BROKEN VIEW, not an empty endpoint, and defaulting it to ""
// fabricated a submission the operator never made (the engine refuses it, so the toggle reads as an
// unexplained failure, or it stores an empty endpoint over a working one and the metrics push silently
// stops going anywhere). The caller routes a null to Replace, which re-collects the endpoint honestly.
// Pure; exported for the validator.
export function buildOtlpToggleSubmission(
  view: Pick<OtlpPushDestinationView, "endpoint" | "authHeaderName">,
  enabled: boolean,
): OtlpPushDestinationInput | null {
  if (typeof view.endpoint !== "string" || view.endpoint.trim() === "") return null;
  return {
    endpoint: view.endpoint,
    authHeaderName: view.authHeaderName ?? "Authorization",
    enabled,
  };
}

// OTLP_TOGGLE_UNRECONSTRUCTABLE is what the panel says when buildOtlpToggleSubmission refuses: it names
// the state and the one control that fixes it, rather than clicking into silence.
export const OTLP_TOGGLE_UNRECONSTRUCTABLE =
  "The engine's view of this destination is incomplete, so it cannot be enabled or disabled from here without resupplying it. Use Replace to re-enter the endpoint.";

// otlpPushStatePresentation is the headline state line. Absent is a neutral to-do; present-but-
// disabled is info (paused is a fact, never a fault); enabled reads ok because "the engine is
// pushing on the scheduler tick" is itself the honest claim being made here, NOT a claim about
// delivery health (that is the trail's job, so a green headline can never paper over a red trail).
// Exported (pure) for the validator.
export function otlpPushStatePresentation(view: OtlpPushDestinationView): { tone: StatusTone; label: string } {
  if (!view.present) return { tone: "neutral", label: "No OTLP push destination configured." };
  const target = view.endpoint ?? "the configured endpoint";
  if (view.enabled !== true) return { tone: "info", label: `Configured for ${target}, disabled: the scheduler tick will not push to it.` };
  return { tone: "ok", label: `Enabled: pushing metrics to ${target} on the scheduler tick.` };
}

// otlpPushDetailLine is the second state line: the auth header name only, never the secret.
// Redaction-safe. Pure; exported for the validator.
export function otlpPushDetailLine(view: Pick<OtlpPushDestinationView, "authHeaderName">): string {
  return `header ${view.authHeaderName ?? "Authorization"}.`;
}

// otlpAttemptLine renders ONE delivery attempt as a single honest line: a push is named by its
// downpipe count when the engine reported one (a test-shaped attempt carries none), flagged
// truncated when the fleet exceeded the engine's per-push cap; a failure always names a reason
// (falling back to the HTTP status, then to "no response" rather than going silent). Pure; exported
// for the validator.
export function otlpAttemptLine(a: OtlpPushDeliveryAttempt): { tone: StatusTone; text: string } {
  const scope =
    a.downpipeCount !== undefined
      ? `${a.downpipeCount} ${a.downpipeCount === 1 ? "downpipe" : "downpipes"}${a.truncated === true ? " (truncated: the fleet exceeds the per-push cap)" : ""}`
      : "a snapshot";
  if (a.ok) {
    return { tone: "ok", text: `${a.at}: pushed ${scope}${a.httpStatus !== undefined ? `, HTTP ${a.httpStatus}` : ""}.` };
  }
  const reason = a.reason ?? (a.httpStatus !== undefined ? `HTTP ${a.httpStatus}` : "no response");
  return { tone: "danger", text: `${a.at}: failed pushing ${scope}: ${reason}.` };
}

// otlpTrailLines returns the most recent attempts (bounded to a calm handful, newest first): the
// trail arrives oldest-first capped at 50 (the contract), so this takes the tail and reverses it.
// This is deliberately NOT a full history table. Pure; exported for the validator.
export function otlpTrailLines(trail: OtlpPushDeliveryAttempt[], max = OTLP_PUSH_TRAIL_DISPLAY_MAX): Array<{ tone: StatusTone; text: string }> {
  return trail.slice(-max).reverse().map(otlpAttemptLine);
}

// otlpTrailSummary is the aggregate sentence (mirrors push-model.ts's pushTrailSummary): the count
// (capped honestly at OTLP_PUSH_TRAIL_MAX) plus the most recent attempt's outcome. Pure; exported for
// the validator.
export function otlpTrailSummary(trail: OtlpPushDeliveryAttempt[]): string {
  const n = trail.length;
  if (n === 0) return "No delivery attempts yet.";
  const last = trail[trail.length - 1]!;
  const lastWord = last.ok ? "succeeded" : "failed";
  return n >= OTLP_PUSH_TRAIL_MAX
    ? `Most recent ${OTLP_PUSH_TRAIL_MAX} attempts retained (older entries roll over); the last attempt ${lastWord} at ${last.at}.`
    : `${n} ${n === 1 ? "attempt" : "attempts"} recorded; the last attempt ${lastWord} at ${last.at}.`;
}
