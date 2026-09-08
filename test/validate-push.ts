// Validate the pure, honesty-critical presentation logic of the outbound audit-log push (SIEM) panel
// (src/screens/settings/push.ts, re-exported from src/screens/settings.ts). Mirrors validate-support.ts +
// validate-notifications.ts: a DOM-heavy screen with its load-bearing decisions extracted into pure
// functions over plain values; none of the imported modules execute DOM at import time, so importing the
// screen under plain node succeeds.
// Run with: node test/validate-push.ts
//
// Coverage:
//   buildPushInputFields / buildPushSubmission (the pure input-builders), sink-aware:
//     - buildPushInputFields normalises the http auth trio (endpoint, authHeaderName, authHeaderValue);
//       trims the endpoint; a blank header name defaults to "Authorization"
//     - buildPushSubmission (http) OMITS authHeaderValue when the operator typed nothing (the enable/disable
//       toggle path), includes it verbatim when typed, and carries the url-token posture (authInUrl)
//     - buildPushSubmission (s3) shapes s3Target (endpoint/bucket/region/accessKeyId + optional prefix), rides
//       the write-only secretAccessKey ONLY when typed, and never carries the http endpoint/header fields
//     - buildPushSubmission (syslog-tls) shapes syslog {host, port}, defaulting the port to 6514, no secret
//   parseSyslogPort / validateSyslogHost / validateSyslogPort (the syslog field rules)
//   buildToggleSubmission / canTogglePush (the lightweight enable/disable toggle, sink-aware):
//     - reconstructs a secret-free set for http + syslog-tls; returns null (and canTogglePush false) for s3,
//       whose access key the redacted view does not carry
//   validatePushEndpoint (https-only, no client-side private-host block)
//   pushStatePresentation / pushLagPresentation (never fabricate green), across sinks
//   pushDestinationTargetLabel / pushDestinationDetailLine (redaction-safe per-sink location + detail)
//   pushAttemptLine / pushTrailLines / pushTrailSummary (the bounded delivery trail)
//   pushTestOutcomeCopy (one honest sentence per reason)
//   pushFormatLabel / pushSinkLabel / pushDialsOutNote (a distinct, correct, honest label per member)
//   Redaction (no secret ever surfaces), including an s3 view fed adversarial credential-shaped fields

import {
  PUSH_TOGGLE_UNRECONSTRUCTABLE,
  pushFormatLabel,
  pushSinkLabel,
  pushDialsOutNote,
  validatePushEndpoint,
  validatePushFormatSink,
  validateSyslogHost,
  validateSyslogPort,
  parseSyslogPort,
  buildPushInputFields,
  buildPushSubmission,
  buildToggleSubmission,
  canTogglePush,
  pushDestinationTargetLabel,
  pushDestinationDetailLine,
  pushStatePresentation,
  pushLagPresentation,
  pushAttemptLine,
  pushFailReasonCopy,
  pushTrailLines,
  pushTrailSummary,
  pushTestOutcomeCopy,
} from "../src/screens/settings.ts";
import type { PushFormFields } from "../src/screens/settings/push-model.ts";
import type { PushDeliveryAttempt, PushDestinationView, PushFormat, PushSink, PushTestResult } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq<T>(label: string, got: T, want: T): void {
  const cond = JSON.stringify(got) === JSON.stringify(want);
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// A full form-state builder: the form always populates every field (inactive sinks carry empty strings), so
// buildPushSubmission reads the active sink's fields with no optionality.
const formFields = (over: Partial<PushFormFields>): PushFormFields => ({
  sink: "http",
  format: "ndjson",
  endpoint: "",
  authInUrl: false,
  authHeaderName: "",
  authHeaderValue: "",
  s3: { endpoint: "", bucket: "", region: "", prefix: "", accessKeyId: "", secretAccessKey: "" },
  syslog: { host: "", port: "" },
  ...over,
});

// ---------------------------------------------------------------------------
console.log("\n-- buildPushInputFields: normalises the http auth trio --");
// ---------------------------------------------------------------------------

{
  const built = buildPushInputFields({ endpoint: "  https://siem.example.com/hec  ", authHeaderName: "  Authorization  ", authHeaderValue: "shh" });
  eq("assembles exactly the three http auth keys", Object.keys(built).sort(), ["authHeaderName", "authHeaderValue", "endpoint"]);
  eq("trims the endpoint", built.endpoint, "https://siem.example.com/hec");
  eq("trims the header name", built.authHeaderName, "Authorization");
  eq("carries the typed secret through", built.authHeaderValue, "shh");
}
{
  const built = buildPushInputFields({ endpoint: "https://x.example.com", authHeaderName: "   ", authHeaderValue: "" });
  eq("a blank header name defaults to Authorization", built.authHeaderName, "Authorization");
  eq("an empty secret stays empty (never fabricated)", built.authHeaderValue, "");
}

// ---------------------------------------------------------------------------
console.log("\n-- buildPushSubmission (http): the secret rides ONLY when typed --");
// ---------------------------------------------------------------------------

{
  const withSecret = buildPushSubmission(formFields({ sink: "http", format: "datadog", endpoint: "https://x.example.com", authHeaderName: "DD-API-KEY", authHeaderValue: "dd-secret-123" }), true);
  ok("a typed secret rides on the wire input", "authHeaderValue" in withSecret && withSecret.authHeaderValue === "dd-secret-123");
  eq("sink is http", withSecret.sink, "http");
  eq("enabled carries through", withSecret.enabled, true);
  eq("format carries through", withSecret.format, "datadog");

  const withoutSecret = buildPushSubmission(formFields({ sink: "http", format: "datadog", endpoint: "https://x.example.com", authHeaderName: "DD-API-KEY", authHeaderValue: "" }), false);
  ok("a blank secret OMITS authHeaderValue (keeps the sealed secret unchanged)", !("authHeaderValue" in withoutSecret));
  eq("enabled still carries through on the secret-free path (the toggle)", withoutSecret.enabled, false);
  eq(
    "the wire input still carries endpoint/format/authHeaderName on the secret-free path",
    { endpoint: withoutSecret.endpoint, format: withoutSecret.format, authHeaderName: withoutSecret.authHeaderName },
    { endpoint: "https://x.example.com", format: "datadog", authHeaderName: "DD-API-KEY" },
  );
}
{
  const on = buildPushSubmission(formFields({ sink: "http", endpoint: "https://x.example.com/e", authInUrl: true, authHeaderValue: "tok" }), true);
  ok("authInUrl true is carried on the wire input", on.authInUrl === true);
  const off = buildPushSubmission(formFields({ sink: "http", endpoint: "https://x.example.com/e", authInUrl: false, authHeaderValue: "tok" }), true);
  ok("authInUrl false is OMITTED (never a false posture on the wire)", !("authInUrl" in off));
}

// ---------------------------------------------------------------------------
console.log("\n-- buildPushSubmission (s3): the S3-drop target + write-only key --");
// ---------------------------------------------------------------------------

{
  const sub = buildPushSubmission(
    formFields({ sink: "s3", format: "cef", s3: { endpoint: "  https://s3.ap-southeast-2.amazonaws.com  ", bucket: "  audit-bkt ", region: " ap-southeast-2 ", prefix: " audit-logs ", accessKeyId: " AKIA123 ", secretAccessKey: "s3-secret-xyz" } }),
    true,
  );
  eq("sink is s3", sub.sink, "s3");
  ok("carries an s3Target", sub.s3Target !== undefined);
  eq("trims the s3 endpoint", sub.s3Target?.endpoint, "https://s3.ap-southeast-2.amazonaws.com");
  eq("trims the bucket", sub.s3Target?.bucket, "audit-bkt");
  eq("trims the region", sub.s3Target?.region, "ap-southeast-2");
  eq("trims the access key id", sub.s3Target?.accessKeyId, "AKIA123");
  eq("trims + carries the prefix when non-empty", sub.s3Target?.prefix, "audit-logs");
  ok("rides the write-only secretAccessKey when typed", sub.s3Target?.secretAccessKey === "s3-secret-xyz");
  ok("an s3 submission NEVER carries a top-level http endpoint", !("endpoint" in sub));
  ok("an s3 submission NEVER carries a top-level authHeaderName", !("authHeaderName" in sub));
  ok("an s3 submission NEVER carries authInUrl", !("authInUrl" in sub));
}
{
  const sub = buildPushSubmission(formFields({ sink: "s3", s3: { endpoint: "https://s3.example.com", bucket: "b", region: "auto", prefix: "", accessKeyId: "AK", secretAccessKey: "" } }), true);
  ok("a blank s3 secret OMITS secretAccessKey (keeps the sealed s3 secret)", !("secretAccessKey" in (sub.s3Target ?? {})));
  ok("a blank prefix is OMITTED (the engine defaults it)", !("prefix" in (sub.s3Target ?? {})));
}

// ---------------------------------------------------------------------------
console.log("\n-- buildPushSubmission (syslog-tls): host + port, no secret --");
// ---------------------------------------------------------------------------

{
  const sub = buildPushSubmission(formFields({ sink: "syslog-tls", format: "leef", syslog: { host: "  siem.example.com ", port: "6514" } }), true);
  eq("sink is syslog-tls", sub.sink, "syslog-tls");
  eq("trims the host", sub.syslog?.host, "siem.example.com");
  eq("carries the parsed port", sub.syslog?.port, 6514);
  ok("no secret-shaped field anywhere on a syslog submission", !JSON.stringify(sub).toLowerCase().includes("secret"));
  ok("no s3Target on a syslog submission", !("s3Target" in sub));
}
{
  const sub = buildPushSubmission(formFields({ sink: "syslog-tls", syslog: { host: "h", port: "" } }), true);
  eq("a blank port defaults to 6514", sub.syslog?.port, 6514);
}

// ---------------------------------------------------------------------------
console.log("\n-- parseSyslogPort / validateSyslogHost / validateSyslogPort --");
// ---------------------------------------------------------------------------

eq("parseSyslogPort: a valid port is used", parseSyslogPort("514"), 514);
eq("parseSyslogPort: blank defaults to 6514", parseSyslogPort(""), 6514);
eq("parseSyslogPort: non-numeric defaults to 6514", parseSyslogPort("abc"), 6514);
eq("parseSyslogPort: out-of-range (0) defaults to 6514", parseSyslogPort("0"), 6514);
eq("parseSyslogPort: out-of-range (70000) defaults to 6514", parseSyslogPort("70000"), 6514);

ok("validateSyslogHost: a bare host is accepted", validateSyslogHost("siem.example.com") === null);
ok("validateSyslogHost: empty is left to the field's required rule", validateSyslogHost("") === null);
ok("validateSyslogHost: a scheme is rejected", validateSyslogHost("https://siem.example.com") !== null);
ok("validateSyslogHost: a path is rejected", validateSyslogHost("siem.example.com/ingest") !== null);
ok("validateSyslogHost: whitespace is rejected", validateSyslogHost("siem example com") !== null);

ok("validateSyslogPort: empty is accepted (defaults)", validateSyslogPort("") === null);
ok("validateSyslogPort: a valid port is accepted", validateSyslogPort("6514") === null);
ok("validateSyslogPort: a non-numeric value is rejected", validateSyslogPort("abc") !== null);
ok("validateSyslogPort: an out-of-range value is rejected", validateSyslogPort("70000") !== null);

// ---------------------------------------------------------------------------
console.log("\n-- validatePushFormatSink: cef/leef MUST pair with the syslog-tls sink --");
// ---------------------------------------------------------------------------

ok("cef + http is rejected (no SIEM auto-parses CEF over HTTP)", validatePushFormatSink("cef", "http") !== null);
// The stated reason used to be "the s3 drop always writes NDJSON, not CEF". That was the assertion's whole
// justification and it stopped being true: the drop now writes the chosen format. The pair is still refused,
// on the parser argument that no SIEM auto-parses CEF out of a bucket, so the assertion survives and only its
// reason changes. A test whose label carries a false reason is how a stale rule keeps looking justified.
ok("cef + s3 is rejected (no SIEM auto-parses CEF dropped into a bucket)", validatePushFormatSink("cef", "s3") !== null);
ok("cef + syslog-tls is accepted", validatePushFormatSink("cef", "syslog-tls") === null);
ok("leef + http is rejected", validatePushFormatSink("leef", "http") !== null);
ok("leef + s3 is rejected", validatePushFormatSink("leef", "s3") !== null);
ok("leef + syslog-tls is accepted", validatePushFormatSink("leef", "syslog-tls") === null);
ok("ndjson + http is accepted (the guard is scoped to cef/leef only)", validatePushFormatSink("ndjson", "http") === null);
ok("splunk-hec + http is accepted", validatePushFormatSink("splunk-hec", "http") === null);
{
  const msg = validatePushFormatSink("cef", "http");
  ok("the rejection names the fix (the syslog-tls sink)", (msg?.includes("syslog-tls") ?? false));
  // The message is shown for the s3 pair too, so naming only HTTP told an operator who had picked an S3
  // bucket about a delivery they had not chosen. It must name BOTH refused destinations, matching the
  // engine's own pushSinkFormatError wording ("delivered over http or dropped into a bucket").
  eq(
    "the refusal names both refused destinations, not just HTTP",
    validatePushFormatSink("cef", "s3"),
    "CEF and LEEF formats require the syslog-tls sink: no SIEM auto-parses CEF or LEEF delivered over HTTP or dropped into a bucket.",
  );
  ok("the same sentence is what the http pair gets, so neither sink is described by the other's rule", msg === validatePushFormatSink("cef", "s3"));
}

// ---------------------------------------------------------------------------
console.log("\n-- the syslog-tls sink carries CEF or LEEF ONLY (the silent-CEF substitution) --");
// ---------------------------------------------------------------------------
// THE DEFECT. `sink: "syslog-tls"` with `format: "splunk-hec"` used to pass this validator, pass the engine's
// router, pass the engine's DO, and then SILENTLY SHIP CEF: the engine's record builder read "LEEF if leef,
// else CEF", so every other format fell into the CEF arm and a Splunk HEC parser received ArcSight CEF. A
// combination that validates and then sends a different wire than the operator chose is worse than one that is
// refused, because nothing anywhere records the substitution.
//
// The engine now refuses the same pair at both boundaries and its sender takes a narrowed two-member type. This
// is the console half. The formats are enumerated against the closed union rather than spot-checked, so a ninth
// format cannot slip through untested.
{
  const everyFormat: PushFormat[] = ["raw-json", "ndjson", "json-array", "splunk-hec", "datadog", "cef", "leef", "gelf"];
  ok("the enumeration covers the whole PushFormat union (a shrunken list would test nothing)", everyFormat.length === 8);
  const admitted = everyFormat.filter((f) => validatePushFormatSink(f, "syslog-tls") === null);
  eq("only cef and leef are admitted on the syslog-tls sink", admitted.sort(), ["cef", "leef"]);
  const hecMsg = validatePushFormatSink("splunk-hec", "syslog-tls");
  ok("splunk-hec + syslog-tls is REFUSED", hecMsg !== null);
  ok("and the refusal names the format the operator chose, the rule, and what to do", (hecMsg ?? "").includes("Splunk HEC") && (hecMsg ?? "").includes("CEF or LEEF only") && (hecMsg ?? "").includes("Choose CEF or LEEF"));
}
{
  // The state line stops claiming a delivery. It used to read "(sent as CEF)", which described the old silent
  // substitution accurately and is now false: nothing is delivered at all for such a destination.
  const stale = pushDestinationDetailLine({ present: true, sink: "syslog-tls", format: "splunk-hec", syslog: { host: "siem.example.com", port: 6514 }, trail: [] });
  ok("a stored splunk-hec-over-syslog destination is reported as NOT delivering, not as sent-as-CEF", stale.includes("cannot carry") && stale.includes("nothing is being delivered") && !stale.includes("sent as CEF"));
  ok("and it names the control that fixes it", stale.includes("Replace") && stale.includes("CEF or LEEF"));
  const good = pushDestinationDetailLine({ present: true, sink: "syslog-tls", format: "cef", syslog: { host: "siem.example.com", port: 6514 }, trail: [] });
  ok("a CEF-over-syslog destination still reads as delivering (the warning discriminates)", good.includes("delivered to") && !good.includes("cannot carry"));
}

// ---------------------------------------------------------------------------
console.log("\n-- the destination-identity tag rides the submission and survives a toggle --");
// ---------------------------------------------------------------------------
// The push is a singleton keyed only by format crossed with sink, and that pair cannot separate Splunk from
// CrowdStrike Falcon Next-Gen SIEM (both splunk-hec over http). The console now records WHICH vendor it is.
{
  const httpSub = buildPushSubmission(formFields({ sink: "http", format: "splunk-hec", endpoint: "https://http-inputs.splunkcloud.example/services/collector/event", authHeaderValue: "Splunk tok", vendor: "splunk" }), true);
  eq("the http submission carries the vendor tag", httpSub.vendor, "splunk");
  const syslogSub = buildPushSubmission(formFields({ sink: "syslog-tls", format: "cef", syslog: { host: "siem.example.com", port: "6514" }, vendor: "qradar" }), true);
  eq("the syslog submission carries the vendor tag (identity is not per-sink)", syslogSub.vendor, "qradar");
  const s3Sub = buildPushSubmission(formFields({ sink: "s3", format: "ndjson", s3: { endpoint: "https://s3.example.com", bucket: "b", region: "auto", prefix: "", accessKeyId: "AK", secretAccessKey: "sk" }, vendor: "wazuh" }), true);
  eq("the s3 submission carries the vendor tag", s3Sub.vendor, "wazuh");
  const untagged = buildPushSubmission(formFields({ sink: "http", format: "ndjson", endpoint: "https://x.example.com", authHeaderValue: "t" }), true);
  ok("a submission with no vendor omits the key entirely (never an empty string the engine would have to screen)", !("vendor" in untagged));
  // THE TOGGLE. Dropping the tag on an enable/disable would silently untag a tagged destination and hand tile
  // identity back to the wire, so one click on Disable would re-light CrowdStrike's tile beside Splunk's.
  const taggedView: PushDestinationView = { present: true, sink: "http", endpoint: "https://x.example.com/e", format: "splunk-hec", authHeaderName: "Authorization", vendor: "splunk", enabled: true, trail: [] };
  eq("buildToggleSubmission carries the tag back", buildToggleSubmission(taggedView, false)?.vendor, "splunk");
  const taggedSyslog: PushDestinationView = { present: true, sink: "syslog-tls", format: "cef", syslog: { host: "h", port: 6514 }, vendor: "qradar", enabled: true, trail: [] };
  eq("buildToggleSubmission carries the tag back on the syslog sink too", buildToggleSubmission(taggedSyslog, false)?.vendor, "qradar");
  const untaggedView: PushDestinationView = { present: true, sink: "http", endpoint: "https://x.example.com/e", format: "ndjson", authHeaderName: "Authorization", enabled: true, trail: [] };
  ok("an untagged view toggles without inventing a tag", !("vendor" in (buildToggleSubmission(untaggedView, false) ?? {})));
}

// ---------------------------------------------------------------------------
console.log("\n-- buildToggleSubmission / canTogglePush: the sink-aware toggle --");
// ---------------------------------------------------------------------------

{
  const view: PushDestinationView = { present: true, sink: "http", endpoint: "https://x.example.com/e", format: "ndjson", authHeaderName: "Authorization", authInUrl: true, enabled: true, trail: [] };
  const sub = buildToggleSubmission(view, false);
  ok("http toggle reconstructs a submission", sub !== null);
  ok("http toggle omits every secret (keeps the sealed one)", sub !== null && !("authHeaderValue" in sub));
  eq("http toggle flips enabled", sub?.enabled, false);
  ok("http toggle preserves the url-token posture", sub?.authInUrl === true);
  ok("canTogglePush is true for http", canTogglePush(view));
}
{
  const view: PushDestinationView = { present: true, sink: "syslog-tls", format: "cef", syslog: { host: "siem.example.com", port: 6514 }, enabled: false, trail: [] };
  const sub = buildToggleSubmission(view, true);
  ok("syslog toggle reconstructs a submission", sub !== null && sub.sink === "syslog-tls");
  eq("syslog toggle carries host/port", { host: sub?.syslog?.host, port: sub?.syslog?.port }, { host: "siem.example.com", port: 6514 });
  ok("canTogglePush is true for syslog-tls", canTogglePush(view));
}
{
  const view: PushDestinationView = { present: true, sink: "s3", format: "ndjson", s3: { endpoint: "https://s3.example.com", bucket: "b", region: "auto" }, enabled: true, trail: [] };
  ok("s3 toggle returns null (the view carries no access key to reconstruct)", buildToggleSubmission(view, false) === null);
  ok("canTogglePush is false for s3", !canTogglePush(view));
}
ok("canTogglePush treats an absent sink as http (true)", canTogglePush({}));
{
  // An http view with NO ENDPOINT is a BROKEN VIEW, not an empty endpoint.
  //
  // The bug this pins: buildToggleSubmission used to default a missing endpoint to "" and submit it.
  // canTogglePush gates on the SINK only, so an http view whose redacted endpoint was absent sailed
  // straight through and the console POSTed an endpoint the operator never typed: the engine refuses it
  // (Enable reads as an unexplained failure, recorded nowhere) or stores it, silently ending the
  // audit-log drain while the panel still shows a configured destination. Refuse instead.
  const broken: PushDestinationView = { present: true, sink: "http", format: "ndjson", authHeaderName: "Authorization", enabled: true, trail: [] };
  ok("an http view with no endpoint REFUSES to reconstruct (never an empty endpoint)", buildToggleSubmission(broken, true) === null);
  ok("an http view with a blank endpoint REFUSES to reconstruct", buildToggleSubmission({ ...broken, endpoint: "  " }, true) === null);
  ok("the refusal copy names Replace", PUSH_TOGGLE_UNRECONSTRUCTABLE.includes("Replace"));
  ok("the refusal copy states the view is incomplete", PUSH_TOGGLE_UNRECONSTRUCTABLE.toLowerCase().includes("incomplete"));
  // Negative control: the complete http view above still reconstructs.
  ok("negative control: a complete http view still reconstructs", buildToggleSubmission({ ...broken, endpoint: "https://x.example.com/e" }, true) !== null);
}

// ---------------------------------------------------------------------------
console.log("\n-- validatePushEndpoint: https-only, NEVER a client-side private-host block --");
// ---------------------------------------------------------------------------

ok("rejects a plain http URL", validatePushEndpoint("http://siem.example.com/hec") !== null);
ok("rejects an unparseable string", validatePushEndpoint("not a url") !== null);
ok("rejects embedded userinfo", validatePushEndpoint("https://user:pass@siem.example.com/hec") !== null);
ok("rejects a workers.dev host (the same rule the alert webhook uses)", validatePushEndpoint("https://evil.workers.dev/hec") !== null);
ok("accepts a plain https URL", validatePushEndpoint("https://siem.example.com/services/collector/event") === null);
ok("does NOT block a private RFC1918 host client-side (the server egress guard's job)", validatePushEndpoint("https://10.0.0.5/hec") === null);
ok("does NOT block loopback client-side", validatePushEndpoint("https://127.0.0.1/hec") === null);
ok("does NOT block localhost client-side", validatePushEndpoint("https://localhost/hec") === null);
ok("does NOT block a link-local/metadata-shaped host client-side", validatePushEndpoint("https://169.254.169.254/hec") === null);

// ---------------------------------------------------------------------------
console.log("\n-- pushStatePresentation / pushLagPresentation: never fabricate green --");
// ---------------------------------------------------------------------------

// These fixtures build by spreading overrides over defaults, so passing `undefined` for a key is how a
// case REMOVES a default rather than a redundant way of omitting it. Partial<T> cannot express that under
// exactOptionalPropertyTypes, which reads an optional property as "absent or a value" and refuses an
// explicit undefined. Overrides<T> permits it on the keys that are ALREADY optional and only those:
// across the board it would also let a case blank a REQUIRED field and build an invalid fixture. strip
// drops the blanked keys on the way out, so what comes back is a genuine value rather than one carrying
// an explicit undefined on an optional key.
type Overrides<T> = { [K in keyof T]?: undefined extends T[K] ? T[K] | undefined : T[K] };
function strip<T extends object>(o: { [K in keyof T]?: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

const baseView = (over: Overrides<PushDestinationView>): PushDestinationView => strip({
  present: true,
  sink: "http",
  endpoint: "https://siem.example.com/hec",
  format: "ndjson",
  authHeaderName: "Authorization",
  enabled: true,
  setBy: "owner@example.com",
  setAt: "2026-07-01T00:00:00.000Z",
  lastPushedSeq: 100,
  headSeq: 100,
  trail: [],
  ...over,
});

{
  const p = pushStatePresentation({ present: false, trail: [] });
  eq("absent -> neutral", p.tone, "neutral");
  ok("absent label says no destination configured", p.label.includes("No push destination"));
}
{
  const p = pushStatePresentation(baseView({ enabled: false }));
  eq("present + disabled -> info, NEVER ok", p.tone, "info");
  ok("disabled label says disabled", p.label.includes("disabled"));
  ok("disabled label names the http endpoint", p.label.includes("siem.example.com"));
}
{
  const p = pushStatePresentation(baseView({ enabled: true }));
  eq("present + enabled -> ok", p.tone, "ok");
}
{
  const p = pushStatePresentation({ present: true, sink: "s3", format: "ndjson", s3: { endpoint: "https://s3.ap-southeast-2.amazonaws.com", bucket: "audit-bkt", region: "ap-southeast-2" }, enabled: true, trail: [] });
  eq("an enabled s3 destination -> ok", p.tone, "ok");
  ok("the s3 headline names the bucket", p.label.includes("audit-bkt"));
}
{
  const p = pushStatePresentation({ present: true, sink: "syslog-tls", format: "cef", syslog: { host: "siem.example.com", port: 6514 }, enabled: false, trail: [] });
  eq("a disabled syslog destination -> info", p.tone, "info");
  ok("the syslog headline names host:port", p.label.includes("siem.example.com:6514"));
}

{
  const lag = pushLagPresentation({ enabled: false, headSeq: 100, lastPushedSeq: 100 });
  eq("disabled reads paused, NEVER ok even at zero lag", lag.tone, "neutral");
  ok("paused label names re-enabling", lag.label.includes("re-enable"));
}
{
  // Both sequence keys absent rather than explicitly undefined: pushLagPresentation tests them with
  // `=== undefined`, so this is the same engine, one that has not reported a head sequence.
  const lag = pushLagPresentation({ enabled: true });
  eq("missing cursors read unknown (neutral), never a fabricated pass", lag.tone, "neutral");
}
{
  const lag = pushLagPresentation({ enabled: true, headSeq: 100, lastPushedSeq: 100 });
  eq("zero lag while enabled -> ok", lag.tone, "ok");
  ok("caught-up label says so", lag.label.includes("Caught up"));
}
{
  const lag = pushLagPresentation({ enabled: true, headSeq: 140, lastPushedSeq: 100 });
  eq("positive lag -> info (a fact, not yet a fault)", lag.tone, "info");
  ok("lag label names the exact count and the seq window", lag.label.includes("40 events") && lag.label.includes("seq 100 of 140"));
}
{
  const lag = pushLagPresentation({ enabled: true, headSeq: 101, lastPushedSeq: 100 });
  ok("a lag of exactly one reads singular 'event'", lag.label.includes("1 event ") && !lag.label.includes("1 events"));
}

// ---------------------------------------------------------------------------
console.log("\n-- pushDestinationTargetLabel / pushDestinationDetailLine: per-sink, redaction-safe --");
// ---------------------------------------------------------------------------

{
  eq("http target is the endpoint", pushDestinationTargetLabel({ sink: "http", endpoint: "https://siem.example.com/hec" }), "https://siem.example.com/hec");
  const s3Label = pushDestinationTargetLabel({ sink: "s3", s3: { endpoint: "https://s3.ap-southeast-2.amazonaws.com", bucket: "audit-bkt", region: "ap-southeast-2", prefix: "audit-logs" } });
  ok("s3 target names bucket + host + prefix", s3Label.includes("audit-bkt") && s3Label.includes("s3.ap-southeast-2.amazonaws.com") && s3Label.includes("audit-logs"));
  eq("syslog target is host:port over syslog (TLS)", pushDestinationTargetLabel({ sink: "syslog-tls", syslog: { host: "siem.example.com", port: 6514 } }), "siem.example.com:6514 over syslog (TLS)");
}
{
  const http = pushDestinationDetailLine(baseView({ sink: "http", format: "ndjson", authHeaderName: "DD-API-KEY" }));
  ok("http detail names the format and the header", http.includes("NDJSON") && http.includes("header DD-API-KEY"));
  const url = pushDestinationDetailLine(baseView({ sink: "http", authInUrl: true }));
  ok("http+authInUrl detail names the url-token posture, not a header", url.includes("token carried in the endpoint URL"));
  const s3 = pushDestinationDetailLine({ present: true, sink: "s3", format: "cef", s3: { endpoint: "https://s3.example.com", bucket: "audit-bkt", region: "auto" }, trail: [] });
  ok("s3 detail names NDJSON (the sink always writes NDJSON) and the bucket", s3.includes("NDJSON") && s3.includes("audit-bkt"));
  const sl = pushDestinationDetailLine({ present: true, sink: "syslog-tls", format: "leef", syslog: { host: "siem.example.com", port: 6514 }, trail: [] });
  ok("syslog detail names the host and the syslog transport", sl.includes("siem.example.com") && sl.includes("syslog"));
}

// ---------------------------------------------------------------------------
console.log("\n-- pushAttemptLine / pushTrailLines / pushTrailSummary: the bounded trail --");
// ---------------------------------------------------------------------------

const attempt = (over: Partial<PushDeliveryAttempt>): PushDeliveryAttempt => ({ at: "2026-07-01T00:00:00.000Z", ok: true, ...over });

{
  const line = pushAttemptLine(attempt({ ok: true, httpStatus: 202, count: 3, fromSeq: 10, toSeq: 12 }));
  eq("a successful attempt reads ok", line.tone, "ok");
  ok("names the batch size and seq range", line.text.includes("3 events") && line.text.includes("seq 10-12"));
  ok("names the HTTP status", line.text.includes("HTTP 202"));
}
{
  const line = pushAttemptLine(attempt({ ok: false, reason: "timeout" }));
  eq("a failed attempt reads danger, never ok", line.tone, "danger");
  ok("names the reason verbatim", line.text.includes("timeout"));
}
{
  const line = pushAttemptLine(attempt({ ok: false, httpStatus: 401 }));
  ok("a failure with no engine reason falls back to the HTTP status", line.text.includes("HTTP 401"));
}
{
  const line = pushAttemptLine(attempt({ ok: false }));
  ok("a failure with neither a reason nor a status still names something (never silent)", line.text.includes("no response"));
}
{
  const line = pushAttemptLine(attempt({ ok: true }));
  ok("a test-shaped success (no batch fields) reads as a test event, not a fabricated batch", line.text.includes("a test event"));
}
{
  // ACCEPTED, NOT DELIVERED. A success row states what the SINK said, which is that it took the batch. It is
  // not a claim that the events were stored or are searchable: a Splunk HEC "Success" means parsed and queued,
  // and a deleted index or a discarding transform then drops them with that answer unchanged. The word
  // "delivered" promised the half nobody outside the SIEM can see, and this pins that it is gone.
  const line = pushAttemptLine(attempt({ ok: true, httpStatus: 200, count: 1, fromSeq: 0, toSeq: 1 }));
  ok("a success row says the sink ACCEPTED the batch", line.text.includes("accepted"));
  ok('a success row never claims "delivered"', line.text.includes("delivered") === false);
}
{
  // A success that carries a reason is an engine HEC body class: the sink accepted, but its own answer could
  // not be read, so the acceptance itself is unconfirmed. That must not render as a clean row.
  const line = pushAttemptLine(attempt({ ok: true, httpStatus: 200, reason: "hec-body-unparseable", count: 1, fromSeq: 0, toSeq: 1 }));
  eq("an accepted-but-unreadable answer reads warn, never ok", line.tone, "warn");
  ok("it names the class so the row is not silently clean", line.text.includes("hec-body-unparseable"));
  ok("it still says the sink accepted, because it did", line.text.includes("accepted"));
}

{
  const trail = [attempt({ at: "t1", ok: true }), attempt({ at: "t2", ok: false, reason: "timeout" }), attempt({ at: "t3", ok: true })];
  const beforeJson = JSON.stringify(trail);
  const lines = pushTrailLines(trail, 2);
  eq(
    "bounded to the requested max, newest first",
    lines.map((l) => l.text.slice(0, 2)),
    ["t3", "t2"],
  );
  ok("does not mutate the input trail", JSON.stringify(trail) === beforeJson);
}
eq("an empty trail yields no lines", pushTrailLines([]).length, 0);

eq("empty trail summary", pushTrailSummary([]), "No delivery attempts yet.");
{
  const s = pushTrailSummary([attempt({ ok: true })]);
  ok("singular 'attempt' for one entry", s.startsWith("1 attempt "));
  ok("names the outcome word 'succeeded'", s.includes("succeeded"));
}
{
  const s = pushTrailSummary([attempt({ ok: true }), attempt({ ok: false })]);
  ok("plural 'attempts' for more than one", s.startsWith("2 attempts"));
  ok("the LAST entry's outcome wins (failed)", s.includes("failed"));
}
{
  const fifty = Array.from({ length: 50 }, (_, i) => attempt({ at: `t${i}` }));
  const s = pushTrailSummary(fifty);
  ok("at the cap, says 'most recent 50' rather than a total it cannot know past the cap", s.includes("Most recent 50"));
}

// ---------------------------------------------------------------------------
console.log("\n-- pushTestOutcomeCopy: one honest sentence per reason --");
// ---------------------------------------------------------------------------

const testResult = (over: Partial<PushTestResult>): PushTestResult => ({ ok: true, ...over });

ok("ok -> starts with 'Sent.'", pushTestOutcomeCopy(testResult({ ok: true })).startsWith("Sent."));
ok("ok names the HTTP status when present", pushTestOutcomeCopy(testResult({ ok: true, httpStatus: 200 })).includes("HTTP 200"));
ok("ok names the timing when present", pushTestOutcomeCopy(testResult({ ok: true, ms: 143 })).includes("143 ms"));
ok("a coarse reason is named verbatim", pushTestOutcomeCopy(testResult({ ok: false, reason: "timeout after 5000ms" })).includes("timeout after 5000ms"));
{
  const copy = pushTestOutcomeCopy(testResult({ ok: false, reason: "unauthorized", httpStatus: 401 }));
  ok("a failure names BOTH the reason and the HTTP status when present", copy.includes("unauthorized") && copy.includes("HTTP 401"));
}
ok("a failure with only an HTTP status (no engine reason) still names the status", pushTestOutcomeCopy(testResult({ ok: false, httpStatus: 503 })).includes("HTTP 503"));
ok("a failure with neither a reason nor a status still says so, never silent", pushTestOutcomeCopy(testResult({ ok: false })).toLowerCase().includes("no response"));
ok('never claims "guaranteed" delivery (at-least-once, not exactly-once)', !pushTestOutcomeCopy(testResult({ ok: true })).toLowerCase().includes("guarant"));

// ---------------------------------------------------------------------------
console.log("\n-- pushFailReasonCopy: the engine's code becomes a diagnosis, never a bare slug --");
// ---------------------------------------------------------------------------
// The engine records a CODE and never the error text (no host, no certificate subject, no response body), so
// the console is the only place that code can become something an operator can act on. It used to interpolate
// the slug straight in, so the trail read "failed sending a test event: network-error."
//
// The case that forced it: a Splunk Cloud stack serves its HEC ingest port with Splunk's stock self-signed
// certificate while 443 carries a proper one, so strict TLS refuses the ingest port before any HTTP happens.
// The engine now names that network-tls, and this is where it has to become readable.

ok("network-tls names the CERTIFICATE, not a generic network fault", (() => {
  const s = pushFailReasonCopy("network-tls").toLowerCase();
  return s.includes("certificate") && !s.includes("network-tls");
})());
ok("network-tls says nothing was sent, so the operator does not go looking for partial data", pushFailReasonCopy("network-tls").toLowerCase().includes("nothing was sent"));
ok("network-tls points at the host AND port, because a vendor's ingest port often serves a different certificate", (() => {
  const s = pushFailReasonCopy("network-tls").toLowerCase();
  return s.includes("port") && s.includes("443");
})());
ok("network-tls does NOT suggest disabling verification", !/skip|disable|ignore|insecure|unverified/i.test(pushFailReasonCopy("network-tls")));

// Every code the engine can put in this field must read as prose, not as a slug, and the four network
// sub-causes must read DIFFERENTLY from each other: that split is the whole point of naming them.
const FAIL_CODES = [
  "network-tls", "network-dns", "network-reset", "network-error", "timeout",
  "http-auth", "http-rate-limited", "http-bad-request", "http-gone", "http-redirect", "http-4xx", "http-5xx",
  "internal-sink-blocked", "url-invalid", "credential-undecryptable",
  "syslog-tls-untrusted", "syslog-connect-refused", "syslog-sockets-unsupported",
  // The Splunk HEC body vocabulary (engine src/notify/siem-push-sender.ts HEC_BODY_CLASSES). These reach the
  // trail on sends whose HTTP status was frequently a 200, so without a sentence each the operator reads a
  // bare slug at the exact moment the trail is telling them something the status did not.
  "hec-declined-index", "hec-declined-token", "hec-declined-format", "hec-declined-channel", "hec-declined-busy", "hec-declined-other",
  "hec-body-absent", "hec-body-oversized", "hec-body-unparseable",
];
// THE FLOOR: the loop below is the bulk of this block's assertions, so an empty or shortened list would check
// nothing and still print PASS. A gate with nothing to check reads exactly like a satisfied one.
ok(`the fail-code list is populated (got ${FAIL_CODES.length})`, FAIL_CODES.length >= 27);
ok("no code is listed twice, which would hold the count up while one went unchecked", new Set(FAIL_CODES).size === FAIL_CODES.length);
for (const code of FAIL_CODES) {
  const copy = pushFailReasonCopy(code);
  // Prose, and not the slug echoed back at the reader. `timeout` is a real English word, so the rule is that
  // the copy must not LEAD with the code, rather than never containing it.
  ok(`${code} expands to a sentence rather than the slug`, copy !== code && copy.length > 30 && copy.includes(" ") && !copy.startsWith(code));
}
ok("the four network sub-causes read differently from one another", new Set(["network-tls", "network-dns", "network-reset", "network-error"].map(pushFailReasonCopy)).size === 4);
ok("the two certificate cases (http and syslog sinks) both name the certificate",
  pushFailReasonCopy("network-tls").toLowerCase().includes("certificate") && pushFailReasonCopy("syslog-tls-untrusted").toLowerCase().includes("certificate"));
ok("http-auth says it is NOT a network fault, because that is the wrong place to look", pushFailReasonCopy("http-auth").toLowerCase().includes("not a network"));
ok("syslog-sockets-unsupported owns the fault as ours, not the customer's", pushFailReasonCopy("syslog-sockets-unsupported").toLowerCase().includes("our fault"));
// The fallback, in both directions: an unknown reason must survive, and a free-text reason must pass through.
ok("an UNKNOWN code is shown rather than swallowed", pushFailReasonCopy("some-future-code") === "some-future-code");
ok("a free-text engine reason passes through unchanged", pushFailReasonCopy("config-unreadable: bad wrap key") === "config-unreadable: bad wrap key");
ok("an empty reason does not become a sentence out of nowhere", pushFailReasonCopy("") === "");
// Both render paths must use it, or the expansion exists and nobody sees it.
ok("pushTestOutcomeCopy expands the code", pushTestOutcomeCopy(testResult({ ok: false, reason: "network-tls" })).toLowerCase().includes("certificate"));
ok("pushAttemptLine expands the code too, so the TRAIL is legible and not just the test button",
  pushAttemptLine(attempt({ ok: false, reason: "network-tls" })).text.toLowerCase().includes("certificate"));
ok("the trail line still names the batch alongside the expanded reason", (() => {
  const t = pushAttemptLine(attempt({ ok: false, reason: "network-tls", count: 3, fromSeq: 10, toSeq: 12 })).text;
  return t.includes("seq 10-12") && t.toLowerCase().includes("certificate");
})());
ok("a failure with no reason at all still falls back to the status, not to a sentence about certificates",
  pushAttemptLine(attempt({ ok: false, httpStatus: 500 })).text.includes("HTTP 500"));
ok("no expansion leaks a host, a URL or a token", !FAIL_CODES.some((c) => /https?:\/\/|splunkcloud|Splunk [A-Z]|token=/.test(pushFailReasonCopy(c))));

// ---------------------------------------------------------------------------
console.log("\n-- pushFormatLabel / pushSinkLabel / pushDialsOutNote --");
// ---------------------------------------------------------------------------

const ALL_FORMATS: readonly PushFormat[] = ["raw-json", "ndjson", "json-array", "splunk-hec", "datadog", "cef", "leef", "gelf"];
const ALL_SINKS: readonly PushSink[] = ["http", "s3", "syslog-tls"];

ok("ndjson label names NDJSON and one-per-line", pushFormatLabel("ndjson").includes("NDJSON") && pushFormatLabel("ndjson").toLowerCase().includes("one event per line"));
ok("json-array label names Elastic and Panther", pushFormatLabel("json-array").includes("Elastic") && pushFormatLabel("json-array").includes("Panther"));
ok("raw-json label names the Downpipes wrapper, not NDJSON (that is a separate format now)", pushFormatLabel("raw-json").includes("Downpipes") && !pushFormatLabel("raw-json").includes("NDJSON"));
ok("splunk-hec label names Splunk HEC, and makes no CrowdStrike claim (its HEC endpoint wants a different shape)", pushFormatLabel("splunk-hec").includes("Splunk") && !pushFormatLabel("splunk-hec").includes("CrowdStrike"));
ok("datadog label names Datadog", pushFormatLabel("datadog").includes("Datadog"));
ok("cef label names CEF and syslog", pushFormatLabel("cef").includes("CEF") && pushFormatLabel("cef").toLowerCase().includes("syslog"));
ok("leef label names LEEF", pushFormatLabel("leef").includes("LEEF"));
ok("gelf label names GELF and Graylog", pushFormatLabel("gelf").includes("GELF") && pushFormatLabel("gelf").includes("Graylog"));
eq("every format has a DISTINCT label", new Set(ALL_FORMATS.map((f) => pushFormatLabel(f))).size, ALL_FORMATS.length);

ok("http sink label names HTTP", pushSinkLabel("http").includes("HTTP"));
ok("s3 sink label names S3", pushSinkLabel("s3").includes("S3"));
ok("syslog sink label names Syslog and TLS", pushSinkLabel("syslog-tls").includes("Syslog") && pushSinkLabel("syslog-tls").includes("TLS"));
eq("every sink has a DISTINCT label", new Set(ALL_SINKS.map((s) => pushSinkLabel(s))).size, ALL_SINKS.length);

{
  const note = pushDialsOutNote();
  ok("dials-out note names Cloudflare Access", note.includes("Cloudflare Access"));
  ok("dials-out note names dialling OUT", /dial/i.test(note));
  ok("dials-out note contrasts with the pull credential", note.toLowerCase().includes("pull credential"));
}

// ---------------------------------------------------------------------------
console.log("\n-- redaction: no secret ever surfaces, across sinks --");
// ---------------------------------------------------------------------------

{
  // An adversarial http fixture: extra secret-shaped fields a buggy engine might leak. Every presentation
  // helper must NEVER echo them: they only ever read the fields their own type declares.
  const leaky = { ...baseView({}), authHeaderValue: "SHOULD-NEVER-APPEAR", secret: "SHOULD-NEVER-APPEAR-EITHER" } as unknown as PushDestinationView;
  const joined = [pushStatePresentation(leaky).label, pushLagPresentation(leaky).label, pushDestinationDetailLine(leaky), pushDestinationTargetLabel(leaky), pushTrailSummary(leaky.trail)].join(" ");
  ok("http presentation output never echoes a leaked secret-shaped field", !joined.includes("SHOULD-NEVER-APPEAR"));
}
{
  // An adversarial s3 fixture: a redacted view should carry no credential, but even fed credential-shaped
  // extras the presentation helpers must never echo them (defence in depth over the structural guarantee).
  const leakyS3 = {
    present: true,
    sink: "s3",
    format: "ndjson",
    s3: { endpoint: "https://s3.example.com", bucket: "audit-bkt", region: "auto", accessKeyId: "AKIA-SHOULD-NOT-APPEAR", secretAccessKey: "SECRET-SHOULD-NOT-APPEAR" },
    enabled: true,
    trail: [],
  } as unknown as PushDestinationView;
  const joined = [pushStatePresentation(leakyS3).label, pushDestinationDetailLine(leakyS3), pushDestinationTargetLabel(leakyS3)].join(" ");
  ok("s3 presentation never echoes an access key id fed as an adversarial extra", !joined.includes("AKIA-SHOULD-NOT-APPEAR"));
  ok("s3 presentation never echoes a secret access key fed as an adversarial extra", !joined.includes("SECRET-SHOULD-NOT-APPEAR"));
}
{
  const leakyAttempt = { ...attempt({ ok: true }), authHeaderValue: "SHOULD-NEVER-APPEAR" } as unknown as PushDeliveryAttempt;
  const line = pushAttemptLine(leakyAttempt);
  ok("a delivery-attempt line never echoes a leaked secret-shaped field", !line.text.includes("SHOULD-NEVER-APPEAR"));
}
{
  // The types themselves: PushDestinationView has no secret-shaped field at all, and its s3 view carries the
  // location only (no access key id, no secret access key). This is the structural guarantee behind the
  // behavioural checks above.
  const view: PushDestinationView = baseView({ sink: "s3", s3: { endpoint: "https://s3.example.com", bucket: "b", region: "auto" }, endpoint: undefined });
  ok("PushDestinationView carries no top-level key that looks like a secret", !Object.keys(view).some((k) => /secret|authheadervalue|accesskey/i.test(k)));
  ok("the s3 view carries no access-key or secret key", !Object.keys(view.s3 ?? {}).some((k) => /secret|accesskey/i.test(k)));
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nALL PUSH VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) process.exit(1);
