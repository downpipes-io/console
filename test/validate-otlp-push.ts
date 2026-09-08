// Validate the pure, honesty-critical presentation logic of the outbound OTLP/HTTP metrics push
// panel (src/screens/settings/otlp-push.ts, re-exported from src/screens/settings.ts). Mirrors
// validate-push.ts (the SIEM audit-log push sibling): a DOM-heavy screen with its load-bearing
// decisions extracted into pure functions over plain values; none of the imported modules execute
// DOM at import time, so importing the screen under plain node succeeds.
// Run with: node test/validate-otlp-push.ts
//
// Coverage:
//   buildOtlpPushInputFields / buildOtlpPushSubmission (the pure input-builders):
//     - buildOtlpPushInputFields trims the endpoint; a blank header name defaults to "Authorization"
//     - buildOtlpPushSubmission OMITS authHeaderValue when the operator typed nothing (the
//       enable/disable toggle path), includes it verbatim when typed
//   buildOtlpToggleSubmission (the lightweight enable/disable toggle):
//     - reconstructs a secret-free submission from the view, always (no sink whose credential the
//       view omits, unlike the SIEM push's s3 sink)
//   validateOtlpPushEndpoint (https-only, no client-side private-host block)
//   otlpPushStatePresentation (never fabricate green)
//   otlpPushDetailLine (the auth header name only, never the secret)
//   otlpAttemptLine / otlpTrailLines / otlpTrailSummary (the bounded delivery trail)
//   otlpPushDialsOutNote (names Cloudflare Access + dialling OUT)
//   Redaction (no secret ever surfaces), including a view fed adversarial credential-shaped fields

import {
  OTLP_TOGGLE_UNRECONSTRUCTABLE,
  validateOtlpPushEndpoint,
  otlpPushDialsOutNote,
  buildOtlpPushInputFields,
  buildOtlpPushSubmission,
  buildOtlpToggleSubmission,
  otlpPushStatePresentation,
  otlpPushDetailLine,
  otlpAttemptLine,
  otlpTrailLines,
  otlpTrailSummary,
} from "../src/screens/settings.ts";
import type { OtlpPushFormFields } from "../src/screens/settings/otlp-push-model.ts";
import type { OtlpPushDeliveryAttempt, OtlpPushDestinationView } from "../src/api.ts";

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

const formFields = (over: Partial<OtlpPushFormFields>): OtlpPushFormFields => ({
  endpoint: "",
  authHeaderName: "",
  authHeaderValue: "",
  ...over,
});

// ---------------------------------------------------------------------------
console.log("\n-- buildOtlpPushInputFields: normalises the auth trio --");
// ---------------------------------------------------------------------------

{
  const built = buildOtlpPushInputFields({ endpoint: "  https://otlp.datadoghq.com/v1/metrics  ", authHeaderName: "  DD-API-KEY  ", authHeaderValue: "shh" });
  eq("trims the endpoint", built.endpoint, "https://otlp.datadoghq.com/v1/metrics");
  eq("trims the header name", built.authHeaderName, "DD-API-KEY");
  eq("carries the typed secret through", built.authHeaderValue, "shh");
}
{
  const built = buildOtlpPushInputFields({ endpoint: "https://x.example.com", authHeaderName: "   ", authHeaderValue: "" });
  eq("a blank header name defaults to Authorization", built.authHeaderName, "Authorization");
  eq("an empty secret stays empty (never fabricated)", built.authHeaderValue, "");
}

// ---------------------------------------------------------------------------
console.log("\n-- buildOtlpPushSubmission: the secret rides ONLY when typed --");
// ---------------------------------------------------------------------------

{
  const withSecret = buildOtlpPushSubmission(formFields({ endpoint: "https://x.example.com", authHeaderName: "DD-API-KEY", authHeaderValue: "dd-secret-123" }), true);
  ok("a typed secret rides on the wire input", "authHeaderValue" in withSecret && withSecret.authHeaderValue === "dd-secret-123");
  eq("enabled carries through", withSecret.enabled, true);
  eq("endpoint carries through", withSecret.endpoint, "https://x.example.com");
  eq("authHeaderName carries through", withSecret.authHeaderName, "DD-API-KEY");

  const withoutSecret = buildOtlpPushSubmission(formFields({ endpoint: "https://x.example.com", authHeaderName: "DD-API-KEY", authHeaderValue: "" }), false);
  ok("a blank secret OMITS authHeaderValue (keeps the sealed secret unchanged)", !("authHeaderValue" in withoutSecret));
  eq("enabled still carries through on the secret-free path (the toggle)", withoutSecret.enabled, false);
  eq(
    "the wire input still carries endpoint/authHeaderName on the secret-free path",
    { endpoint: withoutSecret.endpoint, authHeaderName: withoutSecret.authHeaderName },
    { endpoint: "https://x.example.com", authHeaderName: "DD-API-KEY" },
  );
}
{
  // Never carries a sink/format field: OTLP push is always one shape (unlike the SIEM push).
  const sub = buildOtlpPushSubmission(formFields({ endpoint: "https://x.example.com", authHeaderValue: "tok" }), true);
  ok("no sink-shaped field anywhere on the submission", !("sink" in sub) && !("format" in sub) && !("s3Target" in sub) && !("syslog" in sub));
}

// ---------------------------------------------------------------------------
console.log("\n-- buildOtlpToggleSubmission: the lightweight enable/disable toggle --");
// ---------------------------------------------------------------------------

{
  const view: OtlpPushDestinationView = { present: true, endpoint: "https://x.example.com/e", authHeaderName: "Authorization", enabled: true, trail: [] };
  const sub = buildOtlpToggleSubmission(view, false);
  ok("toggle reconstructs a submission", sub !== null);
  ok("toggle omits every secret (keeps the sealed one)", sub !== null && !("authHeaderValue" in sub));
  eq("toggle flips enabled", sub?.enabled, false);
  eq("toggle preserves the endpoint", sub?.endpoint, "https://x.example.com/e");
  eq("toggle preserves the header name", sub?.authHeaderName, "Authorization");
}
{
  // A missing authHeaderName still degrades to the engine's own default (that IS the engine's value
  // for an unset header name, so nothing is fabricated by supplying it).
  const sub = buildOtlpToggleSubmission({ endpoint: "https://x.example.com" }, true);
  eq("a view missing authHeaderName defaults to Authorization", sub?.authHeaderName, "Authorization");
}
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  // A view with NO ENDPOINT is a BROKEN VIEW, not an empty endpoint.
  //
  // The bug this pins: the toggle used to default a missing endpoint to "" and SUBMIT it. That is a
  // set the operator never made. The engine either refuses it (so Enable reads as an unexplained
  // failure with nothing recorded anywhere) or accepts it and overwrites a working endpoint with an
  // empty one, at which point the metrics push silently stops going anywhere and the console still
  // renders the destination as configured. Refusing to reconstruct is the honest answer: the panel
  // says the view is incomplete and routes the operator to Replace.
  ok("a view missing endpoint REFUSES to reconstruct (never an empty endpoint)", buildOtlpToggleSubmission({}, true) === null);
  ok("a view with a blank endpoint REFUSES to reconstruct", buildOtlpToggleSubmission({ endpoint: "   " }, true) === null);
  ok("the refusal copy names Replace", OTLP_TOGGLE_UNRECONSTRUCTABLE.includes("Replace"));
  ok("the refusal copy states the view is incomplete", OTLP_TOGGLE_UNRECONSTRUCTABLE.toLowerCase().includes("incomplete"));
  // Negative control: a well-formed view still reconstructs, so the guard has not disabled the toggle.
  ok("negative control: a complete view still reconstructs", buildOtlpToggleSubmission({ endpoint: "https://x.example.com" }, true) !== null);
}

// ---------------------------------------------------------------------------
console.log("\n-- validateOtlpPushEndpoint: https-only, NEVER a client-side private-host block --");
// ---------------------------------------------------------------------------

ok("rejects a plain http URL", validateOtlpPushEndpoint("http://otlp.datadoghq.com/v1/metrics") !== null);
ok("rejects an unparseable string", validateOtlpPushEndpoint("not a url") !== null);
ok("rejects embedded userinfo", validateOtlpPushEndpoint("https://user:pass@otlp.datadoghq.com/v1/metrics") !== null);
ok("rejects a workers.dev host (the same rule the alert webhook uses)", validateOtlpPushEndpoint("https://evil.workers.dev/otlp") !== null);
ok("accepts a plain https URL", validateOtlpPushEndpoint("https://otlp.datadoghq.com/v1/metrics") === null);
ok("does NOT block a private RFC1918 host client-side (the server egress guard's job)", validateOtlpPushEndpoint("https://10.0.0.5/otlp") === null);
ok("does NOT block loopback client-side", validateOtlpPushEndpoint("https://127.0.0.1/otlp") === null);
ok("does NOT block a link-local/metadata-shaped host client-side", validateOtlpPushEndpoint("https://169.254.169.254/otlp") === null);

// ---------------------------------------------------------------------------
console.log("\n-- otlpPushStatePresentation: never fabricate green --");
// ---------------------------------------------------------------------------

const baseView = (over: Partial<OtlpPushDestinationView>): OtlpPushDestinationView => ({
  present: true,
  endpoint: "https://otlp.datadoghq.com/v1/metrics",
  authHeaderName: "DD-API-KEY",
  enabled: true,
  setBy: "owner@example.com",
  setAt: "2026-07-05T00:00:00.000Z",
  trail: [],
  ...over,
});

{
  const p = otlpPushStatePresentation({ present: false, trail: [] });
  eq("absent -> neutral", p.tone, "neutral");
  ok("absent label says no destination configured", p.label.includes("No OTLP push destination"));
}
{
  const p = otlpPushStatePresentation(baseView({ enabled: false }));
  eq("present + disabled -> info, NEVER ok", p.tone, "info");
  ok("disabled label says disabled", p.label.includes("disabled"));
  ok("disabled label names the endpoint", p.label.includes("otlp.datadoghq.com"));
}
{
  const p = otlpPushStatePresentation(baseView({ enabled: true }));
  eq("present + enabled -> ok", p.tone, "ok");
  ok("enabled label names the endpoint", p.label.includes("otlp.datadoghq.com"));
}

// ---------------------------------------------------------------------------
console.log("\n-- otlpPushDetailLine: the auth header name only, never the secret --");
// ---------------------------------------------------------------------------

{
  const line = otlpPushDetailLine(baseView({ authHeaderName: "DD-API-KEY" }));
  ok("names the header", line.includes("DD-API-KEY"));
}
{
  // The key is absent rather than explicitly undefined, which is the same fact to a reader doing
  // `?? "Authorization"`, and the one exactOptionalPropertyTypes accepts.
  const line = otlpPushDetailLine({});
  ok("defaults to Authorization when absent", line.includes("Authorization"));
}

// ---------------------------------------------------------------------------
console.log("\n-- otlpAttemptLine / otlpTrailLines / otlpTrailSummary: the bounded trail --");
// ---------------------------------------------------------------------------

const attempt = (over: Partial<OtlpPushDeliveryAttempt>): OtlpPushDeliveryAttempt => ({ at: "2026-07-05T00:00:00.000Z", ok: true, ...over });

{
  const line = otlpAttemptLine(attempt({ ok: true, httpStatus: 200, downpipeCount: 40 }));
  eq("a successful attempt reads ok", line.tone, "ok");
  ok("names the downpipe count", line.text.includes("40 downpipes"));
  ok("names the HTTP status", line.text.includes("HTTP 200"));
  ok("does not flag truncation when not truncated", !line.text.includes("truncated"));
}
{
  const line = otlpAttemptLine(attempt({ ok: true, downpipeCount: 1 }));
  ok("a downpipe count of one reads singular 'downpipe'", line.text.includes("1 downpipe") && !line.text.includes("1 downpipes"));
}
{
  const line = otlpAttemptLine(attempt({ ok: true, downpipeCount: 5000, truncated: true }));
  ok("a truncated push is flagged loudly, never a silent partial", line.text.includes("truncated"));
}
{
  const line = otlpAttemptLine(attempt({ ok: false, reason: "timeout" }));
  eq("a failed attempt reads danger, never ok", line.tone, "danger");
  ok("names the reason verbatim", line.text.includes("timeout"));
}
{
  const line = otlpAttemptLine(attempt({ ok: false, httpStatus: 401 }));
  ok("a failure with no engine reason falls back to the HTTP status", line.text.includes("HTTP 401"));
}
{
  const line = otlpAttemptLine(attempt({ ok: false }));
  ok("a failure with neither a reason nor a status still names something (never silent)", line.text.includes("no response"));
}
{
  const line = otlpAttemptLine(attempt({ ok: true }));
  ok("an attempt with no downpipe count reads as a snapshot, not a fabricated count", line.text.includes("a snapshot"));
}

{
  const trail = [attempt({ at: "t1", ok: true }), attempt({ at: "t2", ok: false, reason: "timeout" }), attempt({ at: "t3", ok: true })];
  const beforeJson = JSON.stringify(trail);
  const lines = otlpTrailLines(trail, 2);
  eq(
    "bounded to the requested max, newest first",
    lines.map((l) => l.text.slice(0, 2)),
    ["t3", "t2"],
  );
  ok("does not mutate the input trail", JSON.stringify(trail) === beforeJson);
}
eq("an empty trail yields no lines", otlpTrailLines([]).length, 0);

eq("empty trail summary", otlpTrailSummary([]), "No delivery attempts yet.");
{
  const s = otlpTrailSummary([attempt({ ok: true })]);
  ok("singular 'attempt' for one entry", s.startsWith("1 attempt "));
  ok("names the outcome word 'succeeded'", s.includes("succeeded"));
}
{
  const s = otlpTrailSummary([attempt({ ok: true }), attempt({ ok: false })]);
  ok("plural 'attempts' for more than one", s.startsWith("2 attempts"));
  ok("the LAST entry's outcome wins (failed)", s.includes("failed"));
}
{
  const fifty = Array.from({ length: 50 }, (_, i) => attempt({ at: `t${i}` }));
  const s = otlpTrailSummary(fifty);
  ok("at the cap, says 'most recent 50' rather than a total it cannot know past the cap", s.includes("Most recent 50"));
}

// ---------------------------------------------------------------------------
console.log("\n-- otlpPushDialsOutNote --");
// ---------------------------------------------------------------------------

{
  const note = otlpPushDialsOutNote();
  ok("names Cloudflare Access", note.includes("Cloudflare Access"));
  ok("names dialling OUT", /dial/i.test(note));
  ok("contrasts with a scrape target (the pull-based sibling on this screen)", note.toLowerCase().includes("scrape"));
}

// ---------------------------------------------------------------------------
console.log("\n-- redaction: no secret ever surfaces --");
// ---------------------------------------------------------------------------

{
  // An adversarial fixture: extra secret-shaped fields a buggy engine might leak. Every
  // presentation helper must NEVER echo them: they only ever read the fields their own type declares.
  const leaky = { ...baseView({}), authHeaderValue: "SHOULD-NEVER-APPEAR", secret: "SHOULD-NEVER-APPEAR-EITHER" } as unknown as OtlpPushDestinationView;
  const joined = [otlpPushStatePresentation(leaky).label, otlpPushDetailLine(leaky), otlpTrailSummary(leaky.trail)].join(" ");
  ok("presentation output never echoes a leaked secret-shaped field", !joined.includes("SHOULD-NEVER-APPEAR"));
}
{
  const leakyAttempt = { ...attempt({ ok: true }), authHeaderValue: "SHOULD-NEVER-APPEAR" } as unknown as OtlpPushDeliveryAttempt;
  const line = otlpAttemptLine(leakyAttempt);
  ok("a delivery-attempt line never echoes a leaked secret-shaped field", !line.text.includes("SHOULD-NEVER-APPEAR"));
}
{
  // The type itself: OtlpPushDestinationView has no secret-shaped field at all.
  const view: OtlpPushDestinationView = baseView({});
  ok("OtlpPushDestinationView carries no top-level key that looks like a secret", !Object.keys(view).some((k) => /secret|authheadervalue/i.test(k)));
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nALL OTLP PUSH VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
