// The two-channel error model. This module owns the CLASSIFICATION: it turns
// a thrown transport/auth error or a non-2xx response into a discriminated kind
// the screens render consistently. The rendering itself (inline block error with
// Retry, the signed-out route, the capability-gate copy) lives with the toast /
// field / banner components and the screens (task 2/2); this is the shared brain
// so no screen conflates the channels.
//
// The two channels:
//   1. in-flow ok:false  -> an EXPECTED outcome, rendered INLINE ("Restore not
//      possible: <reason>. Nothing was written."). NOT an error toast. These are
//      the 200-with-ok:false bodies from drill/restore/licence; the caller checks
//      `body.ok` itself, so this module's job is only channel two (transport/auth).
//   2. transport / auth   -> a thrown non-2xx, classified here.

// The classified transport/auth error kinds.
export type ErrorKind =
  | { kind: "unauthorised" }                 // 401: Access session invalid / not passed -> signed-out
  | { kind: "stepup-required" }              // 401 { stepUpRequired }: a step-up ceremony was needed and not satisfied -> re-verify, NOT signed-out (B29)
  | { kind: "forbidden"; message: string }   // 403: RBAC role denied -> capability-gate copy
  | { kind: "restore-unapproved"; message: string } // 403 { error: "restore not approved" }: dual control, not a role denial -> awaiting-approval, NOT capability-gate
  | { kind: "console-origin"; origin: string } // CORS / CONSOLE_ORIGIN misconfigured (C2)
  | { kind: "access-redirect" }              // an Access-marked HTML body, not "engine down"
  | { kind: "html-body" }                    // a generic web page where engine data was expected (wrong URL / undeployed / proxy)
  | { kind: "engine-binding-absent" }        // THIS console's deploy has no ENGINE service binding: a config fault in the console, not an engine outage (G152)
  | { kind: "console-origin-fault" }         // THIS console's own worker manufactured the 500: its dispatch threw, or the ENGINE binding's fetch REJECTED. No request reached any engine (G250)
  | { kind: "rate-limited"; status: number; retryAfter: number | null; message: string } // 429: the engine's rate limiter; pace + retry, never a generic server fault
  | { kind: "server"; status: number; message: string } // 5xx and other non-2xx -> block error + Retry
  | { kind: "answer-unreadable"; status: number; message: string } // a 2xx whose body could not be read: the engine answered and the request completed, only the response could not be understood -- NOT a reachability fault
  | { kind: "console-fault"; message: string } // a throw with NO status that is not a fetch failure either: the console's own code threw, most often after a perfectly successful response. NOT a reachability fault
  | { kind: "network"; message: string };    // fetch threw (no response) -> block error + Retry

// RESTORE_UNAPPROVED_REASON is the engine's exact 403 body `error` for an apply that lacks a usable
// dual-control approval (engine/src/admin/router.ts POST /restore: 403 { error: "restore not
// approved", planHash }). It is a SEPARATE reason from a role denial (which returns the gate's 403
// with a different body), so the console must tell the two apart: a role denial is a capability gate,
// but this means the plan is awaiting a distinct approver (maker != checker). api.ts restore()
// surfaces this string in the thrown message so classifyError can map it to "restore-unapproved".
export const RESTORE_UNAPPROVED_REASON = "restore not approved";

// The engine client throws Error("<verb>: <status>") on a non-2xx (api.ts), and a
// raw fetch failure throws a TypeError. classifyError maps either to a kind. The
// second argument is ignored (it never changes the result); it is accepted as an
// opaque value only so existing call sites that still pass { origin } keep compiling.
export function classifyError(err: unknown, _opts?: unknown): ErrorKind {
  const message = err instanceof Error ? err.message : String(err);

  // G152: THE CONSOLE'S OWN WORKER SAID IT HAS NO ENGINE SERVICE BINDING. Recognised FIRST, because it is the one
  // kind that is not about the engine at all: the request never got near it. On the proxied single-hostname
  // topology the console worker forwards /admin, /support and /metrics to the engine over a service binding, and a
  // redeploy that drops that binding used to make those paths fall through to the SPA, so the console parsed its
  // own index.html as engine data and every other classifier below reached the wrong conclusion (`html-body`, whose
  // remedy is "correct the engine URL", on a URL that is entirely correct). The worker now answers a 503 carrying
  // this exact frozen token, and the transport folds the token (never the body) into the throw.
  if (message.includes(ENGINE_BINDING_ABSENT)) return { kind: "engine-binding-absent" };

  // G250: THE CONSOLE'S OWN WORKER MANUFACTURED THE 500. Recognised beside the binding-absent token above and for
  // the same reason: the request never reached an engine, so every classifier below (all of which read the status)
  // would reach a conclusion about an engine that never saw it. A bare 500 became `server`, and `server` says in
  // as many words that the ENGINE ANSWERED AND REFUSED, so the pack sent support to read refusals in the logs of a
  // worker that is deleted, throwing, or over its resource limits. It is the same fabricated engine fault the 503
  // rule above exists to stop, one status code over, and the two reach the console by the SAME two seams: the
  // header gate at the response seam (engine-fetch noteEngineResponse) and the transport throw (client-transport
  // failResponse), which folds this frozen token, never the body, into the message.
  //
  // It is NOT `engine-binding-absent`: there, the binding is missing and the remedy is the console's wrangler
  // configuration. Here the console is wired correctly and the fault is the engine's EXISTENCE or health as a
  // worker (deleted, throwing on boot, over its limits) or the console's own dispatch. They must not share a row:
  // one remedy is a console redeploy with a binding, the other is the engine's deployment.
  if (message.includes(CONSOLE_ORIGIN_FAULT)) return { kind: "console-origin-fault" };

  // An Access-redirect body (HTML / a Cloudflare Access login page returned where JSON was
  // expected) is folded into the thrown message by api.ts as the ACCESS_REDIRECT_MARKER token
  // (the message itself never carries the body, only the marker). Recognise it first: it is a
  // session matter, not "engine down" or a status, so it must not fall through to the status or
  // network branches below. The ignored second argument is irrelevant here.
  if (message.includes(ACCESS_REDIRECT_MARKER)) return { kind: "access-redirect" };

  // A generic HTML body with NO Access marker (the transport folds HTML_BODY_MARKER): some web
  // page answered where engine data was expected. A wrong engine URL, an undeployed engine or a
  // proxy in front, NOT a session matter, so it must never render as "re-authenticate".
  if (message.includes(HTML_BODY_MARKER)) return { kind: "html-body" };

  const status = extractStatus(message);

  // B29: a 401 the transport tagged with STEPUP_REQUIRED_MARKER is a step-up-verification gap (the
  // ceremony was needed and not completed), NOT a dead session, so it must not route to sign-in.
  // Checked before the generic 401 -> unauthorised.
  if (message.includes(STEPUP_REQUIRED_MARKER)) return { kind: "stepup-required" };
  if (status === 401) return { kind: "unauthorised" };
  if (status === 403) {
    // Two distinct 403s from the engine restore route: a ROLE denial (the gate, a capability gate)
    // and a DUAL-CONTROL denial (`restore not approved`: the apply needs a distinct approver). They
    // must not be conflated, so when the surfaced message carries the dual-control reason this is
    // "restore-unapproved" (routed to awaiting-approval), otherwise a plain "forbidden".
    if (message.toLowerCase().includes(RESTORE_UNAPPROVED_REASON)) return { kind: "restore-unapproved", message };
    return { kind: "forbidden", message };
  }
  // 429 is the engine's rate limiter, NOT a server fault: it is recoverable by PACING. The console
  // surfaces it distinctly (so a bulk-op 429 storm never reads as N unexplained failures) and the bulk
  // loops back off by the Retry-After before retrying. The Retry-After (seconds) is folded into the
  // thrown message by the transport as the RATE_LIMIT_MARKER token; parseRetryAfter recovers it (null
  // when the engine sent no honour-able numeric Retry-After). It must be tested BEFORE the generic
  // server branch so a 429 never collapses into { kind: "server" }.
  if (status === 429) return { kind: "rate-limited", status, retryAfter: parseRetryAfter(message), message };
  if (status !== null) return { kind: "server", status, message };

  // A 2xx THAT DID NOT PARSE IS NOT "COULD NOT REACH THE ENGINE" (runs + malformed-json on GET
  // /admin/history). extractStatus deliberately narrows to 400-599 (a 2xx is
  // not an HTTP error status), so client-transport.ts parseJson's throw for a malformed 2xx body --
  // "<verb>: <status>" with the SUCCESS status still on the end -- fell through every branch above and
  // reached the network default below, whose copy ("Could not reach the engine", "Check the engine is
  // reachable on its custom domain") is written for a fetch that got no response at all. That reading is
  // backwards here: the request plainly completed and the engine plainly answered, only the body could
  // not be read (most often a version-skewed deploy, or a genuine bug on that one route), so sending the
  // operator to check reachability is misdirection, not merely imprecision. answeredStatus recognises the
  // same shape ownerActionCodeForError already named "answer-unreadable" (client-diag/ring.ts, G300/R4,
  // ) for the owner-action refusal classifier; the same name is reused here so the two
  // classifiers cannot drift apart on what "the engine answered" means.
  const answered = answeredStatus(message);
  if (answered !== null) return { kind: "answer-unreadable", status: answered, message };

  // No status in the message means fetch itself threw (a TypeError "Failed to fetch" / "Load
  // failed"). By DEFAULT this is a plain network failure (the engine could not be reached),
  // rendered as a block error with Retry. It is NOT auto-promoted to the CONSOLE_ORIGIN
  // diagnostic just because a caller passed its origin: a genuine outage on a screen that does
  // not probe health would otherwise be mis-diagnosed as "CONSOLE_ORIGIN is not set" (C2-2).
  //
  // The CONSOLE_ORIGIN/CORS footgun (the engine is reachable but does not allow this origin, so
  // the browser blocks the authenticated response) looks identical at this layer to an outage:
  // both surface as a fetch TypeError with no status. The two are only distinguishable by an
  // INDEPENDENT GET /admin/health probe (the one unauthenticated route). So console-origin is an
  // EXPLICIT decision a caller makes ONLY after confirming health is reachable, signalled via
  // blockError({ healthReachable: true }) (the pattern onboarding-connect / settings / the access
  // verifier use); classifyError never promotes it on its own. The ignored second argument is
  // retained in the signature for call-site compatibility (callers still pass it), but it does
  // not change the result.
  //
  // AND THE PREMISE OF THAT PARAGRAPH IS NOW TESTED RATHER THAN ASSUMED, which is the whole of this
  // repair. "No status in the message means fetch itself threw" was written as a statement of fact and
  // nothing checked it, so EVERY throw carrying no status landed here, including a TypeError raised by
  // the console's OWN render code long after a perfectly successful response. Measured in a browser on
  // the built bundle: with every /admin read answering 200 with a well-formed body of the WRONG SHAPE, six
  // routes (/credentials, /security/owner-actions, /access/roles, /access/roles/builder, /config/changes,
  // /runs) rendered "Could not reach the engine" with a heading AND a remedy byte-identical to a genuinely
  // aborted fetch, so an operator cannot tell an engine that is down from an engine that answered.
  //
  // It is not only copy, and that is why this is worth a kind rather than a reworded sentence.
  // components/error-view.ts fires recordNetworkBlock() for the `network` kind and for nothing else, which
  // probes GET /admin/health and banks classifyNetworkBlock's verdict in the ring the support pack carries.
  // On this path health necessarily answers, because the engine is up and serving 200s, so the row banked
  // was `origin-rejected`: the pack told support to set CONSOLE_ORIGIN on an account whose CONSOLE_ORIGIN
  // is correct. All six routes fired that probe.
  //
  // THE SHAPE TEST IS A BACKSTOP AND IT IS DELIBERATELY THE WEAKER HALF OF A DESIGN THAT HAS NO STRONGER
  // ONE HERE. The certain answer would be a marker folded in at the seam that KNOWS the fetch rejected
  // (lib/api/engine-fetch.ts), the way ENGINE_BINDING_ABSENT and ACCESS_REDIRECT_MARKER are folded in at
  // theirs. That seam is documented as "a BYTE-FOR-BYTE pass-through of global fetch: same arguments, same
  // return value, same rejection", and thirteen call sites in lib/api reach the engine through a RAW fetch
  // without passing it at all, so a marker there would be neither honest to that file's contract nor
  // complete. So the test is on the wording, and the wordings are the browsers' own.
  //
  // THE RESIDUAL RISK, STATED RATHER THAN BURIED: a browser whose fetch-failure wording is not in this list
  // sends a GENUINE outage down the console-fault branch. That is why the copy on that branch names what is
  // known and does not send anybody anywhere: it never asserts the engine is reachable, so the failure mode
  // is a weaker sentence rather than a second wrong direction. FETCH_FAILURE_WORDINGS is where a new
  // browser's wording is added, and it is one list rather than a condition spread over the branch.
  if (looksLikeFetchFailure(message)) return { kind: "network", message };
  return { kind: "console-fault", message };
}

// FETCH_FAILURE_WORDINGS: what the browsers themselves say when fetch() rejects with no response.
//
//   "Failed to fetch"                                    Chromium, every cause (DNS, refused, CORS, offline)
//   "Load failed"                                        WebKit / Safari, the same set
//   "NetworkError when attempting to fetch resource"     Firefox
//   "The network connection was lost"                    WebKit, a connection dropped mid-flight
//   "The Internet connection appears to be offline"      WebKit, no route to the network at all
//   "aborted"                                            an AbortError from a navigation or an unmount, which
//                                                        is not a Downpipes fault and is already excluded from
//                                                        the failing signal, but which certainly did not reach
//                                                        the engine and must not read as a console fault
//   "timeout"                                            a TimeoutError, likewise a request that got no answer
//
// Matched case-insensitively as SUBSTRINGS of the thrown message, because a browser wraps its own wording in
// its own punctuation and the console's transport prefixes some throws with a verb. Nothing from the message
// is copied anywhere by this function; it returns a boolean.
const FETCH_FAILURE_WORDINGS: readonly string[] = [
  "failed to fetch",
  "load failed",
  "networkerror",
  "network connection was lost",
  "connection appears to be offline",
  "aborted",
  "timeout",
];

/** Does this thrown message read as a fetch that got no response at all. */
export function looksLikeFetchFailure(message: string): boolean {
  const m = message.toLowerCase();
  return FETCH_FAILURE_WORDINGS.some((w) => m.includes(w));
}

// ACCESS_REDIRECT_MARKER is the recognisable token api.ts folds into a thrown message when a
// response body is an Access-redirect page rather than the expected JSON (see api.ts and
// detectAccessRedirectBody). classifyError maps a message carrying this marker to
// { kind: "access-redirect" }. It carries NO body content, only the marker (no-custody: the body
// text is inspected locally for the redirect shape and then discarded, never logged or transmitted).
export const ACCESS_REDIRECT_MARKER = "access-redirect";

// STEPUP_REQUIRED_MARKER (B29) is the token the transport folds into a thrown message when a 401
// carries a { stepUpRequired: true } body that survived the step-up ceremony (gatedFetch runs the
// ceremony on such a 401 and only surfaces the raw 401 when it was refused, cancelled or
// unavailable). classifyError maps a message carrying this marker to { kind: "stepup-required" }
// so a step-up gap is NOT read as an ordinary lapsed-session 401 that bounces the operator to
// sign-in while their session is still valid. Carries NO body content, only the marker.
export const STEPUP_REQUIRED_MARKER = "stepup-required";

// detectStepUpRequiredBody recognises a 401 body that carries stepUpRequired:true (a SHAPE gate:
// parse, object, the field equals true). Nothing from the body rides; only the boolean decision.
export function detectStepUpRequiredBody(bodyText: string): boolean {
  try {
    const b = JSON.parse(bodyText) as { stepUpRequired?: unknown } | null;
    return typeof b === "object" && b !== null && (b as { stepUpRequired?: unknown }).stepUpRequired === true;
  } catch {
    return false;
  }
}

// ENGINE_BINDING_ABSENT (G152) is ONE frozen product token doing two jobs, deliberately: it is the `error` code
// the console's OWN worker puts in the body of the 503 it answers when an engine-surface path arrives with no
// ENGINE service binding (src/worker.ts), and it is the marker the transport folds into the thrown message so
// classifyError can name the kind. One token, one definition, imported by both halves, so the wire code and the
// classifier cannot drift apart the way two mirrored string literals would.
//
// The transport admits it by EQUALITY against this constant on a 503 body's `error` field and copies nothing else
// (client-transport.ts failResponse). That is a set-membership test on a value the console itself produced, not a
// pattern match on a body some other server might have sent: a regex that trusts its input is not a redaction,
// and no part of the body ever rides in the throw.
export const ENGINE_BINDING_ABSENT = "engine-binding-absent";

// ENGINE_BINDING_ABSENT_HEADER (G152) is the SAME fact as the 503 body above, carried where a seam that must not
// consume the body can still see it. The response body can be read exactly once, and failResponse reads it; the
// engine-call recording seam (engine-fetch.ts noteEngineResponse) runs BEFORE that and is synchronous, so it had
// only the numeric status to go on and classified the console's OWN 503 as an engine 5xx: an engine fault, for a
// request the engine never received, feeding the bot's console-engine-calls-failing ratio with a fabrication and
// pointing the reader at engine logs that hold no trace of it. A header is readable without touching the body.
//
// It cannot be spoofed from outside this console, and that is a property of the browser rather than of trust: the
// engine-binding-absent 503 is only ever produced by the console's OWN worker on the console's OWN origin, so the
// response is same-origin and every header on it is readable. A cross-origin engine that sent this header would
// have it hidden by the browser (it is not named in any Access-Control-Expose-Headers), so the gate below simply
// does not fire and the ordinary status classification stands. No value is read from the header: it is compared
// for EQUALITY against the frozen constant.
export const ENGINE_BINDING_ABSENT_HEADER = "x-downpipes-engine-binding";

// CONSOLE_ORIGIN_FAULT_HEADER carries the SAME discipline one status code over, and it exists because the 503
// fix above was only half the rule.
//
// The console's own worker MANUFACTURES 500s: its last-resort handler answers `internal error` when the dispatch
// throws, and a bound ENGINE service binding whose fetch REJECTS (the engine worker deleted, throwing, or over
// its resource limits) lands there too. The engine never received the request. But the browser's recording seam
// sees only the numeric status, so it wrote {kind: engine-call, httpClass: "5xx", faultClass: "server"}, and the
// wizard's classifier mapped it to `engine-not-ok`, whose meaning is:
//
//   "THE ENGINE ANSWERED AND REFUSED. It is reachable, it saw the call, and it recorded the refusal on its own
//    side" -- rendered to the support engineer as "the evidence is in the engine's own logs, so go and read the
//    refusals there. Do NOT chase reachability (there is nothing wrong with it)."
//
// The engine is DOWN or ABSENT and the pack says it is UP AND REFUSING, sending a support engineer to logs that
// hold no trace of the request. That is the campaign's worst failure class: a row asserting a fact the code
// never established, which does not merely fail to save time but actively COSTS it.
//
// The header is the fact the response body cannot carry (the body is read once, and the recording seam runs
// first and synchronously). Its presence means: THIS RESPONSE IS THE CONSOLE'S OWN. The engine did not answer it.
export const CONSOLE_ORIGIN_FAULT_HEADER = "x-downpipes-console-fault";
export const CONSOLE_ORIGIN_FAULT = "console-origin-fault";

// isConsoleBindingAbsentResponse admits ONE response: this console's own worker answering "I have no ENGINE
// service binding". Exactly a 503, carrying exactly the frozen token in the header above. It reads no body, no
// URL and no other header, and it returns a boolean, so nothing a server sent can travel with the answer.
export function isConsoleBindingAbsentResponse(r: Response): boolean {
  return r.status === 503 && r.headers.get(ENGINE_BINDING_ABSENT_HEADER) === ENGINE_BINDING_ABSENT;
}

// isConsoleOriginFaultResponse is the same gate for the console's OWN 500 (the last-resort handler, and a
// bound ENGINE binding whose fetch rejected). Exactly a 500, carrying exactly the frozen token in the header.
// It reads no body, no URL and no other header, and it returns a boolean, so nothing a server sent can travel
// with the answer. A 500 the ENGINE genuinely answered carries no such header and is still recorded as an engine
// fault, which is correct: there, the engine really did see the call.
export function isConsoleOriginFaultResponse(r: Response): boolean {
  return r.status === 500 && r.headers.get(CONSOLE_ORIGIN_FAULT_HEADER) === CONSOLE_ORIGIN_FAULT;
}

// HTML_BODY_MARKER is the token the transport folds into a thrown message when a response body is
// a generic web page (HTML with no Access marker) where JSON was expected: a wrong engine URL, an
// undeployed engine, a static host or a proxy answering. classifyError maps it to
// { kind: "html-body" }. Like the Access marker it carries NO body content (no-custody).
export const HTML_BODY_MARKER = "html-body-not-json";

// RATE_LIMIT_MARKER is the token the transport folds into a 429 thrown message to carry the engine's
// Retry-After (in whole seconds) without disturbing the trailing-status convention extractStatus keys
// on: the message reads "<verb>: retry-after=<n>: 429", so the trailing 429 is still the status token
// and the retry-after is recoverable by parseRetryAfter. A 429 with no honour-able numeric Retry-After
// is thrown as the plain "<verb>: 429" and parseRetryAfter returns null. No body content is ever folded
// in (no-custody): only the numeric Retry-After header value, which carries no customer data.
export const RATE_LIMIT_MARKER = "retry-after";

// ---- the 403 SHAPE GATE (G300) ---------------------------------------------------------------------------
//
// A BARE 403 IS NOT AN AUTHORITY FACT, AND THE CONSOLE USED TO READ IT AS ONE. At least four different things
// answer 403 to the same console call, and the transport threw the identical "<verb>: 403" for all of them, so
// every screen and every diagnostics row that keyed on the status alone was asserting a fact nothing established:
//
//   the CAPABILITY GATE      engine src/admin/router-core.ts gate(): { error: "forbidden", required, have }.
//                            THIS caller lacks the capability the route needs. The honest "you may not".
//   the DO's AUTHZ FUNNEL    engine src/sched/scheduler-do.ts: an AuthError becomes a BARE { error: "forbidden" }
//                            with no capability named (anti-enumeration, deliberately). It is NOT always about
//                            the caller: on an owner-action approve the live producer is the PROPOSER having
//                            lost owner between propose and approve, which the DO re-checks when it replays the
//                            action, and the caller who is refused is a perfectly good second owner.
//   the CSRF CHECK           engine src/admin/router.ts / router-account-session.ts: { error: "csrf origin check
//                            failed" } (or the token twin). It PRE-EMPTS the route dispatch for EVERY
//                            cookie-borne (passkey/oidc/saml) non-GET request, so an engine deployed with
//                            CONSOLE_ORIGIN unset 403s every save in the whole console. The remedy is an engine
//                            variable, and it has nothing to do with who the operator is.
//   THE EDGE                 a Cloudflare WAF block page (error 1020, and a rate-limit rule whose action is
//                            Block answers 403 rather than 429), or any other body this engine does not produce.
//                            The engine may never have seen the request at all.
//
// So the transport classifies the 403 BODY BY SHAPE, folds the closed class into the throw, and forbiddenClass()
// reads it back. NOT A BYTE OF THE BODY TRAVELS: the gate parses the body, tests its `error` field for EQUALITY
// against tokens THIS CONSOLE defines, tests whether `required` is a string, and returns a member of a closed
// enum. It is the same discipline as isEngineBindingAbsentBody: an equality test against a constant we own, never
// a substring search over a body some server sent us, and never a value copied out of one.
export const FORBIDDEN_CLASS_MARKER = "forbidden-class";

// ForbiddenClass is the closed reading of a 403. `not-engine-body` is the honest residual: the body is not any
// refusal shape this engine emits, so something in front of the engine refused the call (a block page, a proxy)
// and no engine-side record of it need exist. It is never coerced into one of the engine's own classes.
export const FORBIDDEN_CLASSES = ["engine-capability", "engine-authz", "engine-csrf", "not-engine-body"] as const;
export type ForbiddenClass = (typeof FORBIDDEN_CLASSES)[number];

// The engine's OWN frozen 403 `error` tokens. Equality only.
const ENGINE_FORBIDDEN_ERROR = "forbidden";
const ENGINE_CSRF_ERRORS: ReadonlySet<string> = new Set(["csrf origin check failed", "csrf token check failed"]);

// classifyForbiddenBody is the shape gate itself: raw 403 body text in, a closed member out. Total, pure, and it
// extracts nothing. An unparseable body, an HTML block page and a JSON error this engine does not emit all reach
// the same honest residual, because in each of them the one thing established is that the engine's refusal
// vocabulary is not what came back.
export function classifyForbiddenBody(bodyText: string): ForbiddenClass {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return "not-engine-body"; // an HTML block page, a proxy's plain text: not a refusal this engine makes
  }
  if (typeof body !== "object" || body === null) return "not-engine-body";
  const err = (body as { error?: unknown }).error;
  if (typeof err !== "string") return "not-engine-body";
  if (ENGINE_CSRF_ERRORS.has(err)) return "engine-csrf";
  if (err === ENGINE_FORBIDDEN_ERROR) {
    // The capability gate names the capability it wanted; the DO's AuthError funnel deliberately names nothing.
    // That absence is the whole discrimination, and it is a SHAPE test (is `required` a string), never a read of
    // what the capability was.
    return typeof (body as { required?: unknown }).required === "string" ? "engine-capability" : "engine-authz";
  }
  return "not-engine-body";
}

// forbiddenClass recovers the class the transport folded into a 403 throw, or null when the throw is not a
// classified 403 (a fetch that never landed, a 400, an older message). It matches the closed enum by EQUALITY
// against the frozen list, so a message that carried anything else yields null rather than a coerced member.
export function forbiddenClass(err: unknown): ForbiddenClass | null {
  const m = errText(err).match(/forbidden-class=([a-z-]+)/);
  if (!m) return null;
  const found = (FORBIDDEN_CLASSES as readonly string[]).includes(m[1]!);
  return found ? (m[1] as ForbiddenClass) : null;
}

// parseRetryAfter recovers the whole-second Retry-After value the transport folded into a 429 message
// (RATE_LIMIT_MARKER), or null when none was present (or it was not a non-negative integer of seconds).
// It deliberately accepts ONLY the integer-seconds form the engine sends; an HTTP-date Retry-After is
// treated as absent (null) so the bulk loop falls back to its default backoff rather than mis-parsing.
export function parseRetryAfter(message: string): number | null {
  const m = message.match(/retry-after=(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// isUnauthorised is the hot path the shell uses to route a thrown 401 to the
// signed-out screen while preserving the intended URL.
export function isUnauthorised(err: unknown): boolean {
  return classifyError(err).kind === "unauthorised";
}

// isForbidden mirrors isUnauthorised for the 403 capability-gate denial: a screen whose read the
// role gate refuses must say "Not permitted", never fall through to a "pending the engine" note
// that reads as an unbuilt feature (the audit tile misled a legitimately audit.read-denied viewer
// this way). A dual-control 403 is classified "restore-unapproved", not "forbidden", so it is not
// swept in here.
export function isForbidden(err: unknown): boolean {
  return classifyError(err).kind === "forbidden";
}

// isStepUpRequired is true for a 401 { stepUpRequired } that a refused/cancelled/unavailable step-up
// ceremony surfaced (B29). A gated screen checks this BEFORE isUnauthorised so a step-up gap does not
// read as a dead session and bounce the operator to sign-in while their session is still valid.
export function isStepUpRequired(err: unknown): boolean {
  return classifyError(err).kind === "stepup-required";
}

// ---- what the step-up ceremony actually did (so the copy downstream does not have to guess) ----------
//
// A cancelled ceremony and a refused one arrive at the screen as the SAME thing: the original
// 401 { stepUpRequired }, because gatedFetch surfaces it unchanged when the ceremony hands back no token
// (client-transport.ts). Nothing in the error carries which of them happened, so every message built from it
// had to cover all of them at once, and the sentence that resulted told an operator whose device has no
// passkey enrolled to "approve the passkey prompt when it appears" when no prompt ever will.
//
// THREE STATES, NOT FOUR, and the merge is deliberate rather than a shortcut. runStepUp can end four ways:
// the begin was refused, navigator.credentials.get returned no credential, it threw, or the finish was
// refused. The middle two are the SAME state to a customer and the platform makes them indistinguishable on
// purpose: WebAuthn answers a dismissed prompt, a timed-out prompt and a device with no matching credential
// with one NotAllowedError, so that no site can enumerate whether a passkey exists. runLogin already treats a
// null credential "like a cancel" for the same reason. Inventing two messages there would be guessing in the
// other direction, so they are one state whose copy covers both honestly.
//
// The record is a single slot, cleared when a ceremony STARTS and consumed when it is read, so a stale
// reason can never be attached to a later failure. A step-up 401 with no reason recorded is a real state
// (a token or Access session never runs a ceremony at all) and keeps the general advice.
// browser-refused and check-unavailable were both folded into no-assertion by a bare catch, and that made
// the copy below say something untrue about each. See stepUpFailureMessage for what it said and why it
// mattered.
export type StepUpFailure = "begin-refused" | "no-assertion" | "finish-refused" | "browser-refused" | "check-unavailable";

let stepUpFailure: StepUpFailure | null = null;

// noteStepUpFailure records how the ceremony ended. Pass null at the START of one to clear the slot.
export function noteStepUpFailure(reason: StepUpFailure | null): void {
  stepUpFailure = reason;
}

// takeStepUpFailure reads and CLEARS the record. Consuming it is what keeps the reason bound to the failure
// it describes: the transport surfaces the 401 immediately after the ceremony ends, so the read that matters
// is the next one, and any later reader gets the general advice rather than a reason from a past attempt.
export function takeStepUpFailure(): StepUpFailure | null {
  const r = stepUpFailure;
  stepUpFailure = null;
  return r;
}

// stepUpFailureMessage is the one place each state gets its own sentence. Every one of them says the action
// was not performed, because the engine's check runs before it dispatches: whatever went wrong here,
// nothing was written.
//
// TWO STATES WERE MISSING, AND THE MERGED SENTENCE DID NOT MERELY MISDESCRIBE THEM, IT PRESCRIBED THE
// ACTION THAT DEEPENS THE HARM. runStepUpOutcome caught every throw bare and
// answered `no-assertion`, whose copy ends "if no prompt appears, this device has no passkey enrolled for
// you and you can enrol one from Security."
//
// Separately, Chromium refuses an assertion whose allowCredentials list exceeds 64, throwing
// DOMException named `RangeError` before it opens any prompt, and the engine emitted an account's entire
// credential list into that field. So for an account over the ceiling no prompt appears, the operator is
// told the device has no passkey and is sent to enrol another, and enrolling takes the account from 65
// credentials to 66. The count only rises, and the way back down is a credential delete that is itself
// step-up gated. The advice was the trap.
//
// The engine bound that list, which stops new accounts reaching the state. This is the
// other half: when a browser does refuse a ceremony, for this reason or one nobody has met yet, the console
// must not attribute it to a device with no passkey.
export function stepUpFailureMessage(reason: StepUpFailure): string {
  switch (reason) {
    case "begin-refused":
      return "The engine would not start the identity check, so nothing was changed. Your session is still active. Try again in a moment.";
    case "finish-refused":
      return "That passkey was not accepted for the identity check, so nothing was changed. Your session is still active. Try again with a passkey you enrolled for this account.";
    case "browser-refused":
      // Deliberately says what IS known and no more. The browser threw before opening a prompt, so no claim
      // is made about which passkeys this device holds, and no remedy is offered that would enrol another.
      return "Your browser refused the identity check, so nothing was changed. Your session is still active. The engine was reached and answered; this failed in the browser. Try another browser or device, and quote this page to support if it repeats.";
    case "check-unavailable":
      return "The identity check could not be completed because the engine could not be reached, so nothing was changed. Your session is still active. Try again in a moment.";
    default:
      // The merged state: dismissed, timed out, or no passkey enrolled on this device. The three are one
      // answer from the platform, so the copy covers them together instead of picking one and being wrong.
      return "The passkey check was not completed, so nothing was changed. Your session is still active. Try again and approve the prompt; if no prompt appears, this device has no passkey enrolled for you and you can enrol one from Security.";
  }
}

// errText pulls a human-readable string off an unknown thrown value for inline
// interpolation in a toast or field hint (e.g. `Could not delete (${errText(err)}).`).
// It is deliberately RAW: it does not classify the error or pick a channel (that is
// classifyError's job). It only flattens an Error to its `.message` and stringifies
// anything else, so the screens have one shared way to splice the engine's text into
// a sentence rather than each keeping a private copy.
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// extractStatus pulls a trailing HTTP error status off the engine client's
// Error("<verb>: <status>") messages (e.g. "list downpipes: 401" -> 401).
// Only codes in the 400-599 range are returned; any other trailing 3-digit token
// (e.g. a 2xx success code, a 3xx redirect, or an arbitrary number) returns null
// so it does not get misclassified as a server error.
function extractStatus(message: string): number | null {
  const m = message.match(/(?:^|[:\s])(\d{3})\b\s*$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (n < 400 || n > 599) return null;
  return n;
}

// answeredStatus pulls a trailing 2xx status off the engine client's Error("<verb>: <status>")
// messages: the shape client-transport.ts parseJson throws when the engine answered (200-299) but the
// body could not be read. It is the 2xx-scoped twin of extractStatus (400-599), kept as its OWN function
// rather than widening extractStatus's range: extractStatus returning null on a 2xx is relied on by
// callers of THIS function (classifyError falls through to it only after extractStatus has already said
// no 4xx/5xx status is present) and by errorStatus/ownerActionCodeForError's engine-refused/unreachable
// split, so widening it would be a behaviour change on an already-tested path, not a fix to one.
function answeredStatus(message: string): number | null {
  const m = message.match(/(?:^|[:\s])(\d{3})\b\s*$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (n < 200 || n > 299) return null;
  return n;
}

// errorStatus is extractStatus over an unknown thrown value: the trailing HTTP status the engine client
// folds into its Error("<verb>: <status>") message, or null when the throw carries none (a fetch TypeError,
// a marker-only throw). It returns a NUMBER or null and nothing else, so a caller can classify a rejection
// by status without touching the message text. The console-diagnostics ring uses it to map an unhandled
// rejection to a closed faultClass (Wave C): the message is read to find a 3-digit status and is never
// copied, so no customer or engine text can travel with the class.
export function errorStatus(err: unknown): number | null {
  return extractStatus(errText(err));
}

// errorAnswered reports whether a throw carries a trailing 2xx status, which is to say THE ENGINE ANSWERED AND
// THE CALL SUCCEEDED, and only the body could not be read (G300). The transport composes exactly that throw: on a
// 2xx whose body is not the JSON the contract describes, parseJson records the contract drift, and when the body
// is not an Access page and not HTML either it throws "<verb>: <status>" with the 2xx status still attached.
//
// It exists because extractStatus deliberately narrows to 400-599, so every one of those throws reads as "no
// status at all" -- the shape of a fetch that never reached anybody. On a MUTATION that reading is not merely
// coarse, it is backwards: a 202 on an approve means the engine took the approval and carried the action out, and
// filing it as "the call got no answer, no engine-side record of it can exist" sends support away from an
// action that HAS run. It returns a BOOLEAN, never the status and never a byte of the body.
export function errorAnswered(err: unknown): boolean {
  const m = errText(err).match(/(?:^|[:\s])(\d{3})\b\s*$/);
  if (!m) return false;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 200 && n <= 299;
}

// detectAccessRedirectBody recognises an Access login HTML body returned where
// JSON was expected, so a screen says "your Access session needs refreshing"
// rather than "engine down". Pass the raw text of a response body that failed to parse as JSON.
// STRICT on purpose: it fires only when the body carries a Cloudflare Access
// marker. A plain HTML page (a wrong engine URL, an undeployed engine, a static
// host or a proxy answering) is NOT an Access page, and blaming the operator's
// session for one sends them on a futile re-auth loop; detectHtmlBody below
// names that case honestly instead.
export function detectAccessRedirectBody(bodyText: string): boolean {
  const lower = bodyText.slice(0, 600).toLowerCase();
  return lower.includes("cloudflare access") || lower.includes("cf-access");
}

// detectHtmlBody recognises a generic HTML body returned where JSON was expected
// (checked AFTER detectAccessRedirectBody, which owns the Access-marked case):
// some web page answered instead of the engine. Its own kind, so the copy
// prescribes "check the engine URL and that the engine is deployed", never a
// re-authentication the operator does not need.
export function detectHtmlBody(bodyText: string): boolean {
  const lower = bodyText.slice(0, 600).toLowerCase();
  return lower.includes("<!doctype html") || lower.includes("<html");
}
