// Validate src/lib/errors.ts: classifyError across ALL branches + detectAccessRedirectBody.
// Run with `node test/validate-errors.ts`.
//
// Coverage:
//   classifyError:
//     - 401 message    -> { kind: "unauthorised" }
//     - 403 generic    -> { kind: "forbidden", message }
//     - 403 with "restore not approved" in message -> { kind: "restore-unapproved", message }
//     - 5xx message    -> { kind: "server", status, message }
//     - a 2xx whose body could not be read -> { kind: "answer-unreadable", status, message }, NOT
// "network" (malformed-json on GET /admin/history)
//     - fetch TypeError (no status) -> { kind: "network", message } NOT auto-promoted to console-origin
//     - message containing ACCESS_REDIRECT_MARKER -> { kind: "access-redirect" }
//   detectAccessRedirectBody:
//     - HTML Access-login body   -> true
//     - plain JSON body          -> false
//     - <!doctype html variant   -> true
//     - cf-access substring      -> true
//     - cloudflare access phrase -> true
//     - body longer than 600 chars where marker is beyond byte 600 -> false (slice guard)
//   isUnauthorised:
//     - returns true on a 401 error, false otherwise
//   errText (the shared raw-message flattener):
//     - an Error yields its .message verbatim; anything else is stringified; never classifies
//
// Message shapes follow the exact format api.ts produces:
//   plain non-2xx:     "<verb>: <status>"   (extractStatus regex matches trailing 3-digit number)
//   restore dual-ctrl: "<verb>: <reason>: <status>"  (reason string + trailing status)
//   access-redirect:   "<verb>: access-redirect"     (ACCESS_REDIRECT_MARKER, no status)

import {
  classifyError,
  detectAccessRedirectBody,
  detectHtmlBody,
  isUnauthorised,
  isForbidden,
  isStepUpRequired,
  detectStepUpRequiredBody,
  errText,
  parseRetryAfter,
  ACCESS_REDIRECT_MARKER,
  STEPUP_REQUIRED_MARKER,
  HTML_BODY_MARKER,
  RATE_LIMIT_MARKER,
  RESTORE_UNAPPROVED_REASON,
  type ErrorKind,
} from "../src/lib/errors.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// kind returns just the discriminant so assertions stay terse.
function kind(err: unknown, opts?: { origin?: string }): string {
  return classifyError(err, opts).kind;
}

// ---- classifyError: 401 -> unauthorised ----------------------------------------
// api.ts produces "<verb>: <status>" where status is the final token.
const err401 = new Error("list downpipes: 401");
ok("401 -> unauthorised kind", kind(err401) === "unauthorised");
const result401 = classifyError(err401);
ok("401 result has no message field (kind only)", !("message" in result401));
ok("isUnauthorised is true on a 401 error", isUnauthorised(err401) === true);

// opts.origin is irrelevant for a 401 -- it always stays unauthorised.
ok("401: opts.origin does not change the kind", kind(err401, { origin: "https://console.example.com" }) === "unauthorised");

// ---- classifyError: 401 { stepUpRequired } -> stepup-required -------------
// The transport folds STEPUP_REQUIRED_MARKER when a 401 body carries stepUpRequired:true that a
// refused/cancelled/unavailable step-up ceremony surfaced: `<verb>: stepup-required: <status>`. It
// MUST classify as stepup-required (a re-verify state), never unauthorised (which bounces the
// operator to sign-in while the session is still valid).
const errStepUp = new Error(`revoke passkey: ${STEPUP_REQUIRED_MARKER}: 401`);
ok("stepUpRequired 401 -> stepup-required kind (NOT unauthorised)", kind(errStepUp) === "stepup-required");
ok("isStepUpRequired is true on a step-up-refused 401", isStepUpRequired(errStepUp) === true);
ok("isUnauthorised is FALSE on a step-up-refused 401 (no false sign-out)", isUnauthorised(errStepUp) === false);
ok("isStepUpRequired is false on an ordinary 401", isStepUpRequired(err401) === false);
// detectStepUpRequiredBody: a SHAPE gate over the raw 401 body text (nothing from the body rides).
ok("detectStepUpRequiredBody true on { stepUpRequired: true }", detectStepUpRequiredBody('{"stepUpRequired":true}') === true);
ok("detectStepUpRequiredBody false on a plain 401 body", detectStepUpRequiredBody('{"error":"unauthorised"}') === false);
ok("detectStepUpRequiredBody false on stepUpRequired:false", detectStepUpRequiredBody('{"stepUpRequired":false}') === false);
ok("detectStepUpRequiredBody false on non-JSON", detectStepUpRequiredBody("not json") === false);

// ---- classifyError: 403 generic -> forbidden ----------------------------------
// A plain role-denied 403 from any route: api.ts throws "restore: 403".
const err403 = new Error("restore downpipe: 403");
ok("403 generic -> forbidden kind", kind(err403) === "forbidden");
const result403 = classifyError(err403);
ok("403 forbidden result carries a message field", result403.kind === "forbidden" && typeof (result403 as { kind: "forbidden"; message: string }).message === "string");
// isForbidden mirrors isUnauthorised: the audit screen uses it to render "Not permitted" on a 403
// audit.read denial instead of the "pending the engine" note that reads as an unbuilt feature.
// It must NOT fire on a 401 (that is sign-out).
ok("isForbidden is true on a 403 error", isForbidden(err403) === true);
ok("isForbidden is false on a 401 error", isForbidden(err401) === false);
// opts.origin must NOT change the result for a 403.
ok("403: passing opts.origin does not change the kind", kind(err403, { origin: "https://console.example.com" }) === "forbidden");

// ---- classifyError: 403 with RESTORE_UNAPPROVED_REASON -> restore-unapproved --
// api.ts restore() does: throw new Error(`restore: ${RESTORE_UNAPPROVED_REASON}: ${r.status}`)
// -> "restore: restore not approved: 403" -- status is still the trailing 3-digit token.
const errRestoreUnapproved = new Error(`restore: ${RESTORE_UNAPPROVED_REASON}: 403`);
ok("403 with RESTORE_UNAPPROVED_REASON -> restore-unapproved kind", kind(errRestoreUnapproved) === "restore-unapproved");
const resultUnapproved = classifyError(errRestoreUnapproved);
ok("restore-unapproved result carries a message field", resultUnapproved.kind === "restore-unapproved" && typeof (resultUnapproved as { kind: "restore-unapproved"; message: string }).message === "string");

// The check is case-insensitive (message.toLowerCase().includes(RESTORE_UNAPPROVED_REASON)).
const errUnapprovedMixed = new Error("restore: Restore Not Approved: 403");
ok("403 restore-unapproved match is case-insensitive", kind(errUnapprovedMixed) === "restore-unapproved");

// A plain 403 (no unapproved reason) must NOT match restore-unapproved.
ok("plain 403 stays forbidden (not restore-unapproved)", kind(err403) === "forbidden");

// opts.origin is irrelevant for a restore-unapproved.
ok("restore-unapproved: opts.origin does not change the kind", kind(errRestoreUnapproved, { origin: "https://example.com" }) === "restore-unapproved");

// ---- classifyError: 5xx -> server --------------------------------------------
// api.ts throws "<verb>: <status>" for any non-2xx; 5xx routes to server.
const err500 = new Error("internal: 500");
ok("500 -> server kind", kind(err500) === "server");
const result500 = classifyError(err500) as ErrorKind & { kind: "server" };
ok("server result carries numeric status 500", result500.kind === "server" && result500.status === 500);
ok("server result carries a message", typeof result500.message === "string");

const err503 = new Error("backup run: 503");
ok("503 -> server kind", kind(err503) === "server");
const result503 = classifyError(err503) as ErrorKind & { kind: "server" };
ok("503 server result has status 503", result503.kind === "server" && result503.status === 503);

// A 3xx code is neither a valid HTTP error status (400-599) nor a recognised 2xx-answered shape
// (200-299), so both extractStatus and answeredStatus return null for it and classifyError falls all the
// way through. This is a synthetic edge case kept to prove the two ranges' boundary is exact
// (client-transport.ts never actually throws a message carrying a 3xx status; parseJson only reaches its
// throw path when r.ok is true, i.e. strictly 2xx).
//
// THE FALL-THROUGH IS `console-fault` AND NOT `network`. classifyError does not assert a reachability
// it never established: only a message
// reading as a browser's own fetch-failure wording keeps `network`, and "redirect: 302" is not one. The
// assertion this line has always been making is the NEGATIVE pair below it, that a 3xx is neither a server
// status nor an answered-but-unreadable 2xx, and both of those are unchanged.
const err302 = new Error("redirect: 302");
ok("a 3xx code (outside both ranges) -> console-fault kind, the status-less fall-through", kind(err302) === "console-fault");
ok("a 3xx code is NOT server and NOT answer-unreadable, which is the boundary this case exists for", kind(err302) !== "server" && kind(err302) !== "answer-unreadable");

// ---- classifyError: a 2xx whose body could not be read -> answer-unreadable ----------------------------------------------------------------------
// client-transport.ts parseJson throws "<verb>: <status>" with the SUCCESS status still attached when a
// 2xx body is not the JSON the contract describes (and is not an Access page or an HTML page either,
// which have their own markers and are recognised earlier). A naive fall-through would read this as
// the generic network default: the block-error card would say "Could not reach the engine" for a
// request that had plainly reached the engine and completed with a 200. answer-unreadable is the
// honest, distinct kind that replaces that misdiagnosis.
const err200Malformed = new Error("history: 200");
ok("a 2xx with an unparseable body -> answer-unreadable kind (NOT network)", kind(err200Malformed) === "answer-unreadable");
const resultAnswerUnreadable = classifyError(err200Malformed) as ErrorKind & { kind: "answer-unreadable" };
ok(
  "answer-unreadable result carries the real 2xx status (200)",
  resultAnswerUnreadable.kind === "answer-unreadable" && resultAnswerUnreadable.status === 200,
);
ok(
  "answer-unreadable result carries a message field",
  resultAnswerUnreadable.kind === "answer-unreadable" && typeof resultAnswerUnreadable.message === "string",
);

// A different 2xx (e.g. a 201 from a create-shaped read whose body came back malformed) classifies the
// same way, and carries the EXACT status seen, not a status fixed to 200.
const err201Malformed = new Error("get status: 201");
ok("a different 2xx (201) also -> answer-unreadable", kind(err201Malformed) === "answer-unreadable");
const result201 = classifyError(err201Malformed) as ErrorKind & { kind: "answer-unreadable" };
ok("answer-unreadable carries the exact status seen (201, not a fixed 200)", result201.kind === "answer-unreadable" && result201.status === 201);

// Boundary: 299 is still inside the 2xx range -> answer-unreadable; 300 is just outside it and takes the
// status-less fall-through (an HTTP status this classifier does not otherwise recognise, exactly like the
// existing 302 case). That fall-through is `console-fault`, not `network`; see the 302 case.
ok("the 2xx boundary is inclusive of 299 -> answer-unreadable", kind(new Error("x: 299")) === "answer-unreadable");
ok("300 (just outside the 2xx range) is NOT answer-unreadable, which is the boundary under test", kind(new Error("x: 300")) !== "answer-unreadable");
ok("300 takes the status-less fall-through, console-fault", kind(new Error("x: 300")) === "console-fault");

// opts.origin is irrelevant for answer-unreadable, exactly as for every other status-derived kind (and
// blockError's own console-origin promotion only ever applies to the "network" kind -- see error-view.ts).
ok("answer-unreadable is unaffected by opts.origin", kind(err200Malformed, { origin: "https://example.com" }) === "answer-unreadable");

// REFUTER: the new branch must fire ONLY for a 2xx trailing status, leaving every other status-derived
// kind byte-identical. Re-run one representative message from each sibling branch and confirm it still
// classifies exactly as documented above (a regression here would mean the new check fired somewhere,
// or swallowed something, it should not have).
ok("REFUTER: a 401 is still unauthorised (unchanged by the answer-unreadable branch)", kind(new Error("whoami: 401")) === "unauthorised");
ok("REFUTER: a 403 is still forbidden (unchanged)", kind(new Error("x: 403")) === "forbidden");
ok("REFUTER: a dual-control 403 is still restore-unapproved (unchanged)", kind(new Error(`restore: ${RESTORE_UNAPPROVED_REASON}: 403`)) === "restore-unapproved");
ok("REFUTER: a 429 is still rate-limited (unchanged)", kind(new Error("x: retry-after=5: 429")) === "rate-limited");
ok("REFUTER: a 500 is still server (unchanged)", kind(new Error("x: 500")) === "server");
ok("REFUTER: an access-redirect marker still wins over any trailing digits (unchanged)", kind(new Error(`x: ${ACCESS_REDIRECT_MARKER}`)) === "access-redirect");
ok("REFUTER: a genuine fetch TypeError with no status is still network (unchanged)", kind(new TypeError("Failed to fetch")) === "network");
ok("REFUTER: a genuine fetch TypeError is NOT reclassified as answer-unreadable", kind(new TypeError("Failed to fetch")) !== "answer-unreadable");
ok("REFUTER: a thrown string with no status is still network, not answer-unreadable", kind("something went wrong") !== "answer-unreadable");

// ---- classifyError: 429 -> rate-limited -------------------------------
// The transport folds the engine's whole-second Retry-After into the message as the RATE_LIMIT_MARKER
// token BEFORE the trailing status: "<verb>: retry-after=<n>: 429". 429 MUST classify as rate-limited
// (a recoverable limiter answer), NEVER as the generic { kind: "server" }, and MUST carry the parsed
// retryAfter so the bulk loops can pace by it.
const err429 = new Error("backup run: retry-after=59: 429");
ok("429 -> rate-limited kind (not server)", kind(err429) === "rate-limited");
const result429 = classifyError(err429) as ErrorKind & { kind: "rate-limited" };
ok("rate-limited result carries status 429", result429.kind === "rate-limited" && result429.status === 429);
ok("rate-limited result carries the parsed Retry-After (59)", result429.kind === "rate-limited" && result429.retryAfter === 59);
ok("rate-limited result carries a message field", result429.kind === "rate-limited" && typeof result429.message === "string");

// A 429 with NO honour-able Retry-After (the plain "<verb>: 429" form) still classifies rate-limited,
// with retryAfter === null so the loop falls back to its default backoff.
const err429NoRA = new Error("disable downpipe: 429");
const result429NoRA = classifyError(err429NoRA) as ErrorKind & { kind: "rate-limited" };
ok("429 with no Retry-After still rate-limited", result429NoRA.kind === "rate-limited");
ok("429 with no Retry-After has retryAfter null (loop uses default backoff)", result429NoRA.kind === "rate-limited" && result429NoRA.retryAfter === null);

// A negative control: a 503 must stay server, never rate-limited (only 429 is the limiter).
ok("503 is NOT rate-limited (stays server)", kind(new Error("x: 503")) === "server");

// ---- parseRetryAfter: recovers the folded whole-second value -------------------
ok("parseRetryAfter reads the folded seconds", parseRetryAfter("x: retry-after=59: 429") === 59);
ok("parseRetryAfter is null when the marker is absent", parseRetryAfter("x: 429") === null);
ok("parseRetryAfter accepts 0 seconds", parseRetryAfter("x: retry-after=0: 429") === 0);
ok("RATE_LIMIT_MARKER constant is 'retry-after'", RATE_LIMIT_MARKER === "retry-after");

// ---- classifyError: fetch TypeError, no status -> network, NOT console-origin --
// This is the spec's explicit requirement: a network TypeError must never be auto-promoted
// to console-origin, even when the caller passes opts.origin. The comment in errors.ts:
// "opts.origin is retained in the signature for call-site compatibility (callers still pass
// it), but no longer changes the result."
const errNetwork = new TypeError("Failed to fetch");
ok("fetch TypeError -> network kind", kind(errNetwork) === "network");
ok("fetch TypeError with opts.origin stays network (NOT console-origin)", kind(errNetwork, { origin: "https://console.example.com" }) === "network");
const resultNetwork = classifyError(errNetwork) as ErrorKind & { kind: "network" };
ok("network result carries a message field", typeof resultNetwork.message === "string");

// A non-Error thrown value (string) with no status takes the same status-less fall-through as the 3xx
// cases above: `console-fault`, because "something went wrong" establishes nothing about
// reachability and the old `network` answer sent an operator to check a network that was fine. The pair
// below is deliberately a POSITIVE and a NEGATIVE: the negative is what this line was really guarding, and
// it is the one that would catch the branch collapsing back into a single answer.
ok("thrown string with no status -> console-fault kind", kind("something went wrong") === "console-fault");
ok("thrown string with no status is NOT network, because nothing established that", kind("something went wrong") !== "network");
// And the control that stops the line above from passing by "nothing is network any more": a string
// carrying a browser's real fetch-failure wording IS still network, which is the state that copy is for.
ok("CONTROL: a thrown string carrying a browser's own fetch wording is still network", kind("Failed to fetch") === "network");

// opts.origin never promotes a TypeError to console-origin even when set.
ok("opts.origin never produces console-origin from a TypeError", kind(new TypeError("Load failed"), { origin: "https://x.example.com" }) !== "console-origin");

// ---- classifyError: access-redirect via ACCESS_REDIRECT_MARKER -----------------
// api.ts throws "<verb>: access-redirect" when detectAccessRedirectBody is true.
// The marker check runs BEFORE extractStatus in classifyError, so it wins regardless
// of any digits in the message.
const errAccessRedirect = new Error(`get key: ${ACCESS_REDIRECT_MARKER}`);
ok("message containing ACCESS_REDIRECT_MARKER -> access-redirect kind", kind(errAccessRedirect) === "access-redirect");

// Even if the message also contains a status-like number the marker wins (because the
// marker check is first in classifyError).
const errAccessRedirectWithTrailingNum = new Error(`list downpipes: ${ACCESS_REDIRECT_MARKER} 401`);
ok("ACCESS_REDIRECT_MARKER wins over trailing status digits", kind(errAccessRedirectWithTrailingNum) === "access-redirect");

// opts.origin is irrelevant for access-redirect.
ok("access-redirect is unaffected by opts.origin", kind(errAccessRedirect, { origin: "https://x.example.com" }) === "access-redirect");

// ---- detectAccessRedirectBody: STRICT ---------
// A plain HTML page is NOT an Access page: blaming the session for a wrong URL /
// undeployed engine sent operators on a futile re-auth loop. Access markers only.
ok(
  "HTML that carries the Access phrase -> true",
  detectAccessRedirectBody("<!DOCTYPE HTML><html><body>Cloudflare Access</body></html>"),
);
ok(
  "<html tag WITHOUT an Access marker -> false (html-body owns it)",
  detectAccessRedirectBody("<html lang='en'><head></head></html>") === false,
);
ok(
  "'cloudflare access' phrase -> true",
  detectAccessRedirectBody("Cloudflare Access Login"),
);
ok(
  "cf-access substring -> true",
  detectAccessRedirectBody("CF-Access-Domain: example.cloudflareaccess.com"),
);
// Case-insensitivity: the implementation lowercases the slice.
ok(
  "uppercase Access phrase is normalised and detected",
  detectAccessRedirectBody("<!DOCTYPE HTML>CLOUDFLARE ACCESS<head></head>"),
);

// ---- detectHtmlBody: generic web page where JSON was expected -------------------
ok(
  "detectHtmlBody: doctype -> true",
  detectHtmlBody("<!DOCTYPE HTML><head></head>"),
);
ok(
  "detectHtmlBody: <html tag -> true",
  detectHtmlBody("<html lang='en'><head></head></html>"),
);
ok(
  "detectHtmlBody: plain JSON -> false",
  detectHtmlBody('{"ok":false,"error":"engine unavailable"}') === false,
);
ok(
  "detectHtmlBody: plain text -> false",
  detectHtmlBody("Service Unavailable") === false,
);

// ---- classifyError: the html-body marker maps to its own kind -------------------
ok(
  "html-body marker -> { kind: 'html-body' }",
  kind(new Error(`get status: ${HTML_BODY_MARKER}`)) === "html-body",
);
ok(
  "HTML_BODY_MARKER is 'html-body-not-json'",
  HTML_BODY_MARKER === "html-body-not-json",
);

// ---- detectAccessRedirectBody: JSON body -> false ------------------------------
ok(
  "plain JSON body -> false",
  detectAccessRedirectBody('{"ok":false,"error":"engine unavailable"}') === false,
);
ok(
  "empty body -> false",
  detectAccessRedirectBody("") === false,
);
ok(
  "plain text error body -> false",
  detectAccessRedirectBody("Service Unavailable") === false,
);

// ---- 600-byte slice guard (both detectors inspect only the first 600 chars) ----
const longPrefix = "A".repeat(601);
ok(
  "Access marker beyond 600-byte window is NOT detected (slice guard)",
  detectAccessRedirectBody(`${longPrefix}cloudflare access`) === false,
);
ok(
  "HTML marker beyond 600-byte window is NOT detected (slice guard)",
  detectHtmlBody(`${longPrefix}<!doctype html>`) === false,
);
// A marker that falls exactly within the 600-byte window IS detected.
// "<!doctype html" is 14 chars, so starting at position 585 it ends at 599 -- within slice.
ok(
  "HTML marker within 600-byte window is detected",
  detectHtmlBody(`${"B".repeat(585)}<!doctype html>`) === true,
);

// ---- isUnauthorised: convenience wrapper --------------------------------------
ok("isUnauthorised returns true on a 401 error", isUnauthorised(new Error("admin: 401")) === true);
ok("isUnauthorised returns false on a 403 error", isUnauthorised(new Error("admin: 403")) === false);
ok("isUnauthorised returns false on a 500 error", isUnauthorised(new Error("admin: 500")) === false);
ok("isUnauthorised returns false on a network error", isUnauthorised(new TypeError("Failed to fetch")) === false);

// ---- errText: the shared raw-message flattener (the de-duplicated helper) ------
// errText is the one shared way a screen splices a thrown value into a sentence
// (a toast or field hint). It is RAW: an Error yields its .message, anything else
// is stringified. It never classifies or picks a channel (that is classifyError).
ok("errText returns an Error's message verbatim", errText(new Error("admin: 404")) === "admin: 404");
ok("errText stringifies a thrown string", errText("plain reason") === "plain reason");
ok("errText stringifies a non-Error object", errText({ toString: () => "obj-as-text" }) === "obj-as-text");
ok("errText does not classify (raw message, no kind)", errText(new Error("admin: 401")) === "admin: 401");

// ---- Exported constants carry exact values ------------------------------------
ok("RESTORE_UNAPPROVED_REASON is 'restore not approved'", RESTORE_UNAPPROVED_REASON === "restore not approved");
ok("ACCESS_REDIRECT_MARKER is 'access-redirect'", ACCESS_REDIRECT_MARKER === "access-redirect");

console.log(failures === 0 ? "\nERROR CLASSIFIER VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
