// The pure, DOM-free model + presentation layer of the outbound audit-log push (SIEM) panel. Split out of
// settings/push.ts along its natural seam (the max-lines guardrail; the same idiom licence/detail-rows.ts
// follows), so the honesty-critical decisions live in one small, node-testable module. Every export here is a
// pure function or a plain type over plain values: no DOM, no engine call, no side effect. settings/push.ts
// (the DOM) and test/validate-push.ts both import from here; settings.ts re-exports the presentation helpers
// so the validator's import surface stays stable.
//
// House style: Australian English, no em dashes, precise claims (this is at-least-once delivery, never
// "guaranteed").

import { validateUrl as validateWebhookUrl } from "../notifications/shared.ts";
import type { StatusTone } from "../../components/status.ts";
import type { PushDeliveryAttempt, PushDestinationInput, PushDestinationView, PushFormat, PushS3TargetInput, PushSink, PushTestResult } from "../../api.ts";

// The engine retains the most recent 50 delivery attempts (older entries roll over); this must match the
// engine's retention cap. At the cap the console says "most recent N", never a total it cannot know (NC-4,
// the same discipline settings/support.ts PULL_TRAIL_MAX follows).
const PUSH_TRAIL_MAX = 50;

// The bounded handful of individual attempt lines shown at once (calm-density budget): pushTrailSummary carries the aggregate count; these are a look, never the full notifications-history
// data table.
const PUSH_TRAIL_DISPLAY_MAX = 5;

// DEFAULT_SYSLOG_PORT mirrors the engine's own default (RFC 5425 syslog-over-TLS). An absent/invalid syslog
// port on the form falls back to it, exactly as the engine's router + DO do.
const DEFAULT_SYSLOG_PORT = 6514;

// PUSH_FORMATS is the closed set of envelope shapers, mirroring the engine's PushFormat allow-list IN
// LOCKSTEP. ndjson leads and is the default for a new destination: not one SIEM
// preferred the raw-json wrapper, and NDJSON splits into N events on nearly every generic HTTP intake.
const PUSH_FORMATS: readonly PushFormat[] = ["ndjson", "json-array", "raw-json", "splunk-hec", "datadog", "cef", "leef", "gelf"];

// pushFormatLabel names each envelope shaper plainly and HONESTLY: it names the SIEMs each format actually
// lands on, so an operator picks by their target, never by guesswork. Exported (pure) for the validator and
// the format select's options. Exhaustive over PushFormat (a new member is a compile error until labelled).
export function pushFormatLabel(format: PushFormat): string {
  switch (format) {
    case "ndjson":
      return "NDJSON (generic, one event per line)";
    case "json-array":
      return "JSON array (Elastic, Panther)";
    case "raw-json":
      return "raw-json (Downpipes wrapper, one batch object)";
    case "splunk-hec":
      return "Splunk HEC";
    case "datadog":
      return "Datadog Logs intake";
    case "cef":
      return "CEF (ArcSight / QRadar / FortiSIEM, via syslog)";
    case "leef":
      return "LEEF (QRadar, via syslog)";
    case "gelf":
      return "GELF (Graylog)";
  }
}

export const PUSH_FORMAT_OPTIONS: Array<{ value: string; label: string }> = PUSH_FORMATS.map((value) => ({ value, label: pushFormatLabel(value) }));

// PUSH_SINKS is the closed delivery-mechanism set, mirroring the engine's PushSink allow-list IN LOCKSTEP.
const PUSH_SINKS: readonly PushSink[] = ["http", "s3", "syslog-tls"];

// pushSinkLabel names each delivery mechanism plainly. Exported (pure) for the validator and the sink select.
//
// THESE THREE STRINGS ARE THE ONLY VALUES A CUSTOMER CAN PICK, and documentation prose quotes them back.
// Ten docs pages once told customers to choose "HTTPS endpoint", which this function has never returned:
// the sink is "HTTP endpoint". docs/scripts/check-push-formats.mjs already guards the FORMAT side with its
// own FORMAT_TOKEN map mirroring pushFormatLabel(); the sink side had no equivalent, which is why the wrong
// value survived on ten pages. If a sink label changes here, the docs-side mirror has to change with it, and
// a new sink must be added to the engine's PushSink allow-list first (PUSH_SINKS above is in lockstep with it).
export function pushSinkLabel(sink: PushSink): string {
  switch (sink) {
    case "http":
      return "HTTP endpoint";
    case "s3":
      return "S3 bucket (drop)";
    case "syslog-tls":
      return "Syslog over TLS";
  }
}

export const PUSH_SINK_OPTIONS: Array<{ value: string; label: string }> = PUSH_SINKS.map((value) => ({ value, label: pushSinkLabel(value) }));

// SYSLOG_TLS_FORMATS is the closed set of formats the syslog-tls sink can carry, mirroring the engine's own
// SYSLOG_TLS_FORMATS (sched/scheduler-do-limits.ts). An RFC 5424 record's MSG is a CEF or a LEEF line; there is
// no HEC-over-syslog, no NDJSON-over-syslog and no GELF-over-syslog.
const SYSLOG_TLS_FORMATS: readonly PushFormat[] = ["cef", "leef"];

// validatePushFormatSink enforces the cross-field rules no SIEM's intake can route around, in BOTH directions.
//
// Direction one, long-standing: CEF and LEEF are syslog-envelope formats. No SIEM auto-parses raw CEF or LEEF
// bytes posted over HTTP, and the S3 drop always writes NDJSON regardless of the format field, so cef/leef only
// makes sense on the syslog-tls sink.
//
// Direction two, added, and the more serious of the pair: the syslog-tls sink carries ONLY those two
// formats. A destination configured splunk-hec over syslog-tls used to pass this validator, pass both of the
// engine's, and then SILENTLY SHIP CEF, because the engine's record builder read "LEEF if leef, else CEF" and
// every other format fell into the CEF arm. A combination that validates and then sends a different wire than
// the operator chose is worse than one that is refused: the receiver sees plausible bytes under the wrong
// parser, and nothing anywhere records the substitution. The engine now refuses the same combination at its
// router and its DO, and its sender takes a narrowed two-member type so the fallback cannot be written again.
//
// Checked at validation/submit time (not just a hint), so neither combination can ship. Exported (pure) for the
// validator and the form's submit-time check.
export function validatePushFormatSink(format: PushFormat, sink: PushSink): string | null {
  if ((format === "cef" || format === "leef") && sink !== "syslog-tls") {
    return "CEF and LEEF formats require the syslog-tls sink: no SIEM auto-parses CEF or LEEF delivered over HTTP or dropped into a bucket.";
  }
  if (sink === "syslog-tls" && !SYSLOG_TLS_FORMATS.includes(format)) {
    return `The syslog-tls sink carries CEF or LEEF only: a syslog record holds a CEF or LEEF line, so ${pushFormatLabel(format)} cannot be sent over it. Choose CEF or LEEF above, or pick a different delivery.`;
  }
  return null;
}

// pushDialsOutNote is the one sentence the design requires: push DIALS OUT, so a Cloudflare Access
// perimeter fronting this console does not block it, unlike the pull credential in the adjacent
// disclosure. Exported (pure) for the validator, so the claim cannot silently drift or disappear.
export function pushDialsOutNote(): string {
  return "Unlike the pull credential above, this engine dials OUT to your SIEM, so a Cloudflare Access perimeter in front of this console does not block it.";
}

// hostOf reads the host of an https URL for a redaction-safe, human-readable location line, returning "" on a
// malformed value (never throwing, never leaking a raw URL that could carry a token in some other context).
function hostOf(u: string | undefined): string {
  if (!u) return "";
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
}

// validatePushEndpoint reuses the alert-webhook field's exact rule (notifications/shared.ts validateUrl):
// https, no embedded userinfo, not a workers.dev host, mirroring the engine's isAllowedWebhookUrl (the push
// destination inherits the SAME egress-secure sender the alert webhook uses). It deliberately does NOT
// check for a private/loopback/link-local/metadata host: that SSRF default-deny is the server-side egress
// guard's job and must never be duplicated (and so able to drift) client-side. Used for the http endpoint
// AND the s3 endpoint (both are https URLs the engine SSRF-screens). Exported (pure) for the validator.
export function validatePushEndpoint(v: string): string | null {
  return validateWebhookUrl(v);
}

// validateSyslogHost checks the syslog target is a bare host, not a URL: a scheme, a path or whitespace is a
// paste mistake. It is deliberately NOT SSRF-screened (a private/on-prem SIEM address is the norm for syslog,
// and the engine does not egress-screen the syslog host either). An empty value is left to the field's own
// required rule. Exported (pure) for the validator.
export function validateSyslogHost(v: string): string | null {
  const s = v.trim();
  if (s === "") return null;
  if (/\s/.test(s)) return "The host must not contain spaces.";
  if (s.includes("://")) return "Enter a host name only, without a scheme (for example siem.example.com).";
  if (s.includes("/")) return "Enter a host name only, without a path.";
  return null;
}

// validateSyslogPort accepts an empty value (it defaults to 6514) or a whole number in 1..65535; anything
// else is a typo. Exported (pure) for the validator.
export function validateSyslogPort(v: string): string | null {
  const s = v.trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return "The port must be a whole number between 1 and 65535.";
  return null;
}

// parseSyslogPort turns the raw port field into the wire number, mirroring the engine: a valid 1..65535
// integer is used, anything else (blank, non-numeric, out of range) falls back to 6514. Exported (pure).
export function parseSyslogPort(raw: string): number {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : DEFAULT_SYSLOG_PORT;
}

// PushFormFields is the operator-typed form state across all three sinks, and buildPushSubmission's input.
// The form always populates every field (the inactive sinks carry empty strings), so buildPushSubmission can
// read the active sink's fields without optionality.
export interface PushFormFields {
  sink: PushSink;
  format: PushFormat;
  // vendor is the OPAQUE destination-identity tag of the tile the form was opened from (a catalogue slug), or
  // undefined for a caller that cannot say which vendor it is. Not an operator-typed field: it comes from the
  // panel, alongside the locked format and sink.
  vendor?: string | undefined;
  // http sink
  endpoint: string;
  authInUrl: boolean;
  authHeaderName: string;
  authHeaderValue: string;
  // s3 sink
  s3: { endpoint: string; bucket: string; region: string; prefix: string; accessKeyId: string; secretAccessKey: string };
  // syslog-tls sink
  syslog: { host: string; port: string };
}

// HttpAuthInput is the http sink's auth trio, normalised by buildPushInputFields.
export interface HttpAuthInput {
  endpoint: string;
  authHeaderName: string;
  authHeaderValue: string;
}

// buildPushInputFields normalises the http sink's auth trio: the endpoint is trimmed, a blank header name
// defaults to "Authorization" (the design's stated default), and the secret is carried through verbatim (an
// empty secret is a valid return meaning "no new secret typed"; buildPushSubmission decides whether that
// omits the wire field). Pure; exported for the validator.
export function buildPushInputFields(fields: HttpAuthInput): HttpAuthInput {
  const authHeaderName = fields.authHeaderName.trim();
  return {
    endpoint: fields.endpoint.trim(),
    authHeaderName: authHeaderName === "" ? "Authorization" : authHeaderName,
    authHeaderValue: fields.authHeaderValue,
  };
}

// buildPushSubmission assembles the wire PushDestinationInput for the selected sink. Each sink's WRITE-ONLY
// secret (the http authHeaderValue, or the s3 secretAccessKey) rides ONLY when the operator typed one (a
// fresh configure or a rotate); an omitted secret leaves the sealed one untouched (the engine's keep-secret
// semantics, reconciled in lib/api/types/push.ts). syslog-tls carries no secret. Pure; exported for the
// validator.
export function buildPushSubmission(fields: PushFormFields, enabled: boolean): PushDestinationInput {
  // The identity tag rides on every sink: which vendor this destination is has nothing to do with how it is
  // delivered, and a tag that rode on only some sinks would leave the console guessing on the others.
  const vendorField = fields.vendor !== undefined && fields.vendor !== "" ? { vendor: fields.vendor } : {};
  if (fields.sink === "s3") {
    const s3 = fields.s3;
    const prefix = s3.prefix.trim();
    const secret = s3.secretAccessKey.trim();
    const s3Target: PushS3TargetInput = {
      endpoint: s3.endpoint.trim(),
      bucket: s3.bucket.trim(),
      region: s3.region.trim(),
      accessKeyId: s3.accessKeyId.trim(),
      ...(prefix !== "" ? { prefix } : {}),
      ...(secret !== "" ? { secretAccessKey: secret } : {}),
    };
    return { format: fields.format, enabled, sink: "s3", s3Target, ...vendorField };
  }
  if (fields.sink === "syslog-tls") {
    return { format: fields.format, enabled, sink: "syslog-tls", syslog: { host: fields.syslog.host.trim(), port: parseSyslogPort(fields.syslog.port) }, ...vendorField };
  }
  const http = buildPushInputFields({ endpoint: fields.endpoint, authHeaderName: fields.authHeaderName, authHeaderValue: fields.authHeaderValue });
  const authInUrl = fields.authInUrl === true;
  return {
    format: fields.format,
    enabled,
    sink: "http",
    endpoint: http.endpoint,
    authHeaderName: http.authHeaderName,
    ...(authInUrl ? { authInUrl: true } : {}),
    ...(http.authHeaderValue !== "" ? { authHeaderValue: http.authHeaderValue } : {}),
    ...vendorField,
  };
}

// canTogglePush reports whether the lightweight enable/disable toggle can be offered for a destination. It
// can for http and syslog-tls (the redacted view carries everything needed to resubmit, secret aside). It
// CANNOT for s3: the view carries no access key id, and the engine requires one on every set, so an s3
// enable/disable is done through Replace instead (which re-collects the access key). Pure; exported for the
// validator. See lib/api/types/push.ts for the flagged contract gap behind this.
export function canTogglePush(view: Pick<PushDestinationView, "sink">): boolean {
  return (view.sink ?? "http") !== "s3";
}

// PUSH_TOGGLE_UNRECONSTRUCTABLE is what the panel says when buildToggleSubmission refuses. The toggle is
// offered per SINK (canTogglePush), but the redacted view can still be short of what a set needs (an http
// view with no endpoint), and the honest answer is to name the state and the control that fixes it rather
// than to click into silence or to fabricate an empty endpoint.
export const PUSH_TOGGLE_UNRECONSTRUCTABLE =
  "The engine's view of this destination is incomplete, so it cannot be enabled or disabled from here without resupplying it. Use Replace to re-enter the destination.";

// buildToggleSubmission reconstructs a secret-free set from the redacted view to flip `enabled` without
// resupplying the write-only secret (the engine keeps the sealed secret when the value is omitted). It
// returns null when the view cannot be safely reconstructed (the s3 sink, whose access key the view omits),
// in which case the caller keeps the toggle disabled and routes the operator to Replace. Pure; exported for
// the validator.
export function buildToggleSubmission(view: PushDestinationView, enabled: boolean): PushDestinationInput | null {
  const sink = view.sink ?? "http";
  const format = view.format ?? "ndjson";
  // The destination-identity tag rides back verbatim. Dropping it on an enable/disable would silently untag a
  // tagged destination and hand tile identity back to the format-crossed-sink guess, so one click on Disable
  // would re-light a second vendor's tile.
  const vendorField = view.vendor !== undefined ? { vendor: view.vendor } : {};
  if (sink === "s3") return null;
  if (sink === "syslog-tls") {
    if (!view.syslog) return null;
    return { format, enabled, sink: "syslog-tls", syslog: { host: view.syslog.host, port: view.syslog.port }, ...vendorField };
  }
  // An http sink with NO endpoint on the view is a BROKEN VIEW, not an empty endpoint. Defaulting it
  // to "" fabricated a submission the operator never made: the engine either refuses it (and the
  // toggle reads as an unexplained failure) or, worse, stores an empty endpoint over a working one, so
  // the audit-log drain silently stops going anywhere. Refuse to reconstruct instead: null routes the
  // caller to Replace, which re-collects the endpoint honestly.
  if (typeof view.endpoint !== "string" || view.endpoint.trim() === "") return null;
  return {
    format,
    enabled,
    sink: "http",
    endpoint: view.endpoint,
    authHeaderName: view.authHeaderName ?? "Authorization",
    ...(view.authInUrl === true ? { authInUrl: true } : {}),
    ...vendorField,
  };
}

// pushDestinationTargetLabel is the redaction-safe, human-readable target of the destination, per sink: the
// http endpoint, the s3 bucket + host + prefix, or the syslog host:port. NEVER any credential. Pure;
// exported for the validator.
export function pushDestinationTargetLabel(view: Pick<PushDestinationView, "sink" | "endpoint" | "s3" | "syslog">): string {
  const sink = view.sink ?? "http";
  if (sink === "s3" && view.s3) {
    const host = hostOf(view.s3.endpoint);
    const prefix = view.s3.prefix ? `, prefix ${view.s3.prefix}` : "";
    return `the s3 bucket ${view.s3.bucket}${host ? ` at ${host}` : ""}${prefix}`;
  }
  if (sink === "syslog-tls" && view.syslog) {
    return `${view.syslog.host}:${view.syslog.port} over syslog (TLS)`;
  }
  return view.endpoint ?? "the configured endpoint";
}

// pushDestinationDetailLine is the second state line: the format + how it is delivered (the auth header, the
// url-token posture, or the sink's own target). Redaction-safe. Pure; exported for the validator.
export function pushDestinationDetailLine(view: PushDestinationView): string {
  const sink = view.sink ?? "http";
  const fmt = pushFormatLabel(view.format ?? "ndjson");
  if (sink === "s3") return `${fmt} (written as NDJSON); dropped to ${pushDestinationTargetLabel(view)}.`;
  if (sink === "syslog-tls") {
    // The syslog-tls sink carries CEF or LEEF ONLY. This line used to read "(sent as CEF)" for any other
    // format, which described the engine's old silent substitution accurately and is no longer true: the engine
    // now refuses the combination outright and the sender reports a named non-delivery rather than shipping CEF
    // under the wrong label. A destination stored under the old behaviour is the only way to reach this arm, and
    // the honest thing to tell its owner is that it is not delivering and what to do about it.
    const undeliverable = !SYSLOG_TLS_FORMATS.includes(view.format ?? "ndjson");
    if (undeliverable) return `${fmt}, which this delivery cannot carry, so nothing is being delivered to ${pushDestinationTargetLabel(view)}. Use Replace and choose CEF or LEEF.`;
    return `${fmt}; delivered to ${pushDestinationTargetLabel(view)}.`;
  }
  const auth = view.authInUrl === true ? "the auth token carried in the endpoint URL" : `header ${view.authHeaderName ?? "Authorization"}`;
  return `${fmt}; ${auth}.`;
}

// pushStatePresentation is the headline state line. Absent is a neutral to-do; present-but-disabled is
// info (paused is a fact, never a fault); enabled reads ok because "the engine is draining on the
// configured schedule" is itself the honest claim being made here, NOT a claim about delivery health (that
// is pushLagPresentation's + the trail's job, so a green headline can never paper over a red trail).
export function pushStatePresentation(view: PushDestinationView): { tone: StatusTone; label: string } {
  if (!view.present) return { tone: "neutral", label: "No push destination configured." };
  const target = pushDestinationTargetLabel(view);
  if (view.enabled !== true) return { tone: "info", label: `Configured for ${target}, disabled: the scheduler tick will not drain to it.` };
  return { tone: "ok", label: `Enabled: draining to ${target} on the scheduler tick.` };
}

// pushLagPresentation reports how far the drain is behind the audit head. NEVER "ok" while disabled (a
// paused drain is not "caught up", it is paused) and NEVER a fabricated pass when the engine has not
// reported both cursors (an older/newer engine field gap reads as unknown, not a green tick).
export function pushLagPresentation(view: Pick<PushDestinationView, "enabled" | "headSeq" | "lastPushedSeq">): { tone: StatusTone; label: string } {
  if (view.enabled !== true) return { tone: "neutral", label: "Paused: the cursor will not advance until you re-enable it." };
  if (view.headSeq === undefined || view.lastPushedSeq === undefined) {
    return { tone: "neutral", label: "Cursor lag unknown (this engine has not reported a head sequence yet)." };
  }
  const lag = Math.max(0, view.headSeq - view.lastPushedSeq);
  if (lag === 0) return { tone: "ok", label: "Caught up with the audit log." };
  return { tone: "info", label: `${lag} ${lag === 1 ? "event" : "events"} behind head (seq ${view.lastPushedSeq} of ${view.headSeq}).` };
}

// PUSH_FAIL_REASON_COPY turns the engine's CLOSED delivery-failure code into the sentence that tells the
// operator what is broken and where to go. The engine deliberately records a code and never the error text
// (no host, no certificate subject, no response body, so nothing leaks into the trail or the pack), which
// means the console is the only place that code can become a diagnosis. Until now it did not: the raw slug
// was interpolated straight into the failure line, so the trail read "failed sending a test event:
// network-error." and the operator was told nothing they could act on.
//
// The case that forced this: a Splunk Cloud stack serves its HEC ingest port with Splunk's stock self-signed
// certificate while 443 carries a proper one, so strict TLS refuses the ingest port before any HTTP is
// exchanged. The engine now names that network-tls rather than network-error, and this is where the operator
// finally reads "the certificate chain ... was not trusted" instead of a generic failure.
//
// Only codes whose FIX differs are given their own sentence. An unknown reason falls through to itself
// (pushFailReasonCopy below), because the engine's vocabulary grows and a console that dropped a reason it
// did not recognise would be worse than one that shows the slug.
const PUSH_FAIL_REASON_COPY: Readonly<Record<string, string>> = {
  "network-tls": "the TLS handshake failed, so the certificate chain your endpoint serves was not trusted. Nothing was sent. Check the certificate on the exact host and port in the endpoint above: a self-signed or expired certificate, or a chain missing its intermediate, refuses the connection before any data is exchanged, and a vendor host often serves a different certificate on its ingest port than on 443",
  "network-dns": "the endpoint's hostname did not resolve. Check the spelling, and check that the ingest hostname exists at all: some vendors document a hostname their smaller plans do not publish",
  "network-reset": "the connection was refused or dropped. Check that the port in the endpoint above is open to outbound traffic from your Cloudflare account",
  "network-error": "the connection failed and the runtime did not say why. For an HTTPS endpoint the usual causes are the certificate chain and the hostname",
  timeout: "the endpoint accepted the connection but did not answer inside the send timeout",
  "http-auth": "the endpoint rejected the credential (401 or 403). The token or key is wrong, expired, or lacks permission. This is not a network fault",
  "http-rate-limited": "the endpoint is throttling this account or token (429). It will be retried; the credential is fine",
  "http-bad-request": "the endpoint rejected the request shape (400). The format selected above may not be the one this endpoint accepts",
  "http-gone": "the endpoint has been permanently removed (410). Recreate the integration at the vendor and repoint it, rather than re-checking the path",
  "http-redirect": "the endpoint answered with a redirect, which is never followed for a credentialled send. Use the final URL",
  "http-4xx": "the endpoint refused the request. Check the path in the endpoint above",
  "http-5xx": "the endpoint itself is erroring. This is at the vendor's end",
  "internal-sink-blocked": "the endpoint resolves to a private or internal address, which is refused by default",
  "url-invalid": "the stored endpoint did not parse when the send was attempted",
  "credential-undecryptable": "the stored credential could not be decrypted, so nothing was sent. Re-enter it",
  "syslog-tls-untrusted": "the receiver's TLS certificate was not trusted, so the handshake failed and nothing was written",
  "syslog-connect-refused": "nothing accepted the TCP connection. Check the host and port, and your egress rules",
  "syslog-sockets-unsupported": "this engine build could not open a TCP socket. That is our fault, not your network's: raise it with support",
  // SPLUNK HEC states its acceptance in the response BODY, not in the HTTP status, so these nine arrive on a
  // send whose status was often a plain 200. The first six are refusals HEC DECLARED: each holds the push
  // cursor, so the batch is re-sent rather than skipped, and the sentence says so where the operator might
  // otherwise fear the events are gone. The last three say only that HEC's answer could not be READ, which
  // is deliberately weaker: they ride beside whatever verdict the HTTP status already gave, and they must
  // never read as a refusal, because inventing one from silence is how a healthy sink gets retry-stormed.
  "hec-declined-index": "Splunk refused the index (HEC code 7). The token's default index is missing, or this token may not write to it. Fix it on the HEC token in Splunk: there is no index field here, because the engine does not send one. The batch is held and re-sent once the token is corrected",
  "hec-declined-token": "Splunk refused the credential or the way it was presented (HEC codes 1 to 4, or 16). The scheme is a literal, case-sensitive \"Splunk \" prefix, so a Bearer prefix or a bare token is refused even when the token itself is valid. The batch is held and re-sent",
  "hec-declined-format": "Splunk would not accept the body as data (HEC codes 5, 6, 12 or 13). That is our fault rather than your configuration: raise it with support. The batch is held and re-sent",
  "hec-declined-channel": "Splunk refused the request channel or the acknowledgement configuration on this token (HEC codes 10, 11 or 14). Check the token's indexer acknowledgement setting in Splunk. The batch is held and re-sent",
  "hec-declined-busy": "Splunk's indexer queue is full (HEC code 9). This is real backpressure at the Splunk end rather than a misconfiguration, and the retry is the correct answer. The batch is held and re-sent; no action is needed unless it persists",
  "hec-declined-other": "Splunk declared a refusal this engine does not recognise, which can happen where Splunk has added a code since this build. The batch is held and re-sent, so nothing is lost while it is investigated",
  "hec-body-absent": "the send succeeded and Splunk returned no body, so its own acceptance code could not be read. The batch was NOT held; confirm the events arrived by searching your index",
  "hec-body-oversized": "the send succeeded and Splunk's reply was larger than the 16 KiB the engine reads, so its acceptance code was never parsed. The batch was NOT held; confirm the events arrived by searching your index",
  "hec-body-unparseable": "the send succeeded and Splunk's reply was not the envelope it documents, so its acceptance code could not be read. An absent or non-numeric code is never assumed to mean accepted. The batch was NOT held; confirm the events arrived by searching your index",
};

// pushFailReasonCopy expands a known failure code into its sentence and returns anything else unchanged, so a
// reason the console has never seen is still shown rather than swallowed. Pure; exported for the validator.
export function pushFailReasonCopy(reason: string): string {
  return PUSH_FAIL_REASON_COPY[reason] ?? reason;
}

// pushAttemptLine renders ONE delivery attempt as a single honest line: a batch is named by its count +
// seq range when the engine reported one (a test send carries neither); a failure always names a reason
// (falling back to the HTTP status, then to "no response" rather than going silent), and a reason in the
// engine's closed vocabulary is expanded into the sentence that says what to fix. Pure; exported for the
// validator.
//
// ACCEPTED, NOT DELIVERED. A success row says the SINK ACCEPTED the batch, because that is the strongest thing
// the engine can know from the outside. It is not a statement that the events were stored or are searchable: a
// Splunk HEC answering {"text":"Success","code":0} has parsed and queued them, and a deleted index, a
// discarding routing transform or a blocked indexer queue then drops them with the answer unchanged. This line
// used to read "delivered", which promised the part nobody outside the SIEM can see. The engine's own drain
// comment and day-2/audit-log-push now both say acceptance, so this says acceptance too.
//
// A success row may ALSO carry a reason (the engine's HEC body classes): the sink accepted, but its own answer
// could not be read, so even the acceptance is unconfirmed. That must not read as a clean row.
export function pushAttemptLine(a: PushDeliveryAttempt): { tone: StatusTone; text: string } {
  // A ROW THAT CANNOT SAY HOW MUCH IT SENT MUST NOT SAY IT SENT ONE TEST EVENT. "a test event" is a
  // CLAIM about the size of the delivery, and it was the else arm for every row whose counts did not all
  // arrive: a real batch carrying fromSeq and toSeq but no count rendered "your sink accepted a test
  // event", BYTE-IDENTICAL to a genuine single test send. This trail is the only place an operator can
  // check whether their SIEM is receiving the audit log at all, so a row that turns an unknown quantity
  // into the smallest possible one is answering the exact question the screen exists for, wrongly.
  //
  // The three fields are jointly optional on the wire, so the honest split is: all three present is a
  // measured batch, none of the three present is the test send the console itself makes (it carries no
  // sequence range), and a PARTIAL set is a batch whose size could not be read.
  const hasBatchFields = a.count !== undefined || a.fromSeq !== undefined || a.toSeq !== undefined;
  const batch =
    a.count !== undefined && a.fromSeq !== undefined && a.toSeq !== undefined
      ? `${a.count} ${a.count === 1 ? "event" : "events"} (seq ${a.fromSeq}-${a.toSeq})`
      : hasBatchFields
        ? "a batch whose size this console could not read"
        : "a test event";
  if (a.ok) {
    const status = a.httpStatus !== undefined ? `, HTTP ${a.httpStatus}` : "";
    if (a.reason !== undefined) return { tone: "warn", text: `${a.at}: your sink accepted ${batch}${status}, but its answer could not be read: ${a.reason}.` };
    return { tone: "ok", text: `${a.at}: your sink accepted ${batch}${status}.` };
  }
  const reason = a.reason !== undefined ? pushFailReasonCopy(a.reason) : a.httpStatus !== undefined ? `HTTP ${a.httpStatus}` : "no response";
  return { tone: "danger", text: `${a.at}: failed sending ${batch}: ${reason}.` };
}

// pushTrailLines returns the most recent attempts (bounded to a calm handful, newest first): the trail
// arrives oldest-first capped 50 (the contract), so this takes the tail and reverses it. This is
// deliberately NOT the full notifications-history data table; pushTrailSummary carries the aggregate.
// Pure; exported for the validator.
export function pushTrailLines(trail: PushDeliveryAttempt[], max = PUSH_TRAIL_DISPLAY_MAX): Array<{ tone: StatusTone; text: string }> {
  return trail.slice(-max).reverse().map(pushAttemptLine);
}

// pushTrailSummary is the pull-line-style aggregate sentence (mirrors settings/support.ts
// supportGrantPresentation's pullLine): the count (capped honestly at PUSH_TRAIL_MAX) + the most recent
// attempt's outcome. Pure; exported for the validator.
export function pushTrailSummary(trail: PushDeliveryAttempt[]): string {
  const n = trail.length;
  if (n === 0) return "No delivery attempts yet.";
  const last = trail[trail.length - 1]!;
  const lastWord = last.ok ? "succeeded" : "failed";
  return n >= PUSH_TRAIL_MAX
    ? `Most recent ${PUSH_TRAIL_MAX} attempts retained (older entries roll over); the last attempt ${lastWord} at ${last.at}.`
    : `${n} ${n === 1 ? "attempt" : "attempts"} recorded; the last attempt ${lastWord} at ${last.at}.`;
}

// pushTestOutcomeCopy maps POST /admin/push/test's honest result to one sentence naming the reason: a real
// SIEM HTTP status, a coarse engine-reported reason (a timeout, an egress-blocked reason, ...), or (rarely)
// neither, in which case the copy still names the absence of a response rather than staying silent. Never
// claims "guaranteed" delivery; a pass here means only that this ONE synthetic event was accepted.
// Exported (pure) for the validator.
export function pushTestOutcomeCopy(res: PushTestResult): string {
  if (res.ok) {
    const status = res.httpStatus !== undefined ? ` (HTTP ${res.httpStatus})` : "";
    const timing = res.ms !== undefined ? `, ${res.ms} ms` : "";
    return `Sent. The endpoint accepted the synthetic event${status}${timing}.`;
  }
  if (res.reason) {
    const status = res.httpStatus !== undefined ? ` (HTTP ${res.httpStatus})` : "";
    return `Failed: ${pushFailReasonCopy(res.reason)}${status}.`;
  }
  if (res.httpStatus !== undefined) return `Failed: the endpoint answered HTTP ${res.httpStatus}.`;
  return "Failed: no response from the endpoint. Check the URL and try again.";
}
