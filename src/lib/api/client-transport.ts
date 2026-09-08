// The shared transport plumbing for the EngineClient, extracted from client.ts: the single god class is
// split into a leaf transport plus per-domain modules of free functions, each delegated to by a thin
// EngineClient method. This module is the LEAF: it imports only the error helpers and the wire types, never
// a domain module or the client, so the domain modules can import it and the client can import them without
// forming a cycle. The behaviour is BYTE-FOR-BYTE the code that used to live as the private EngineClient
// helpers: same request URLs, methods, bodies, headers, parse and throw logic, moved verbatim.

import { engineFetch, noteEngineResponse } from "./engine-fetch.ts";
import { recordContractDrift } from "../client-diag/ring.ts";
import type { ClientDiagAdminOp } from "../client-diag/vocab.ts";
import { ACCESS_REDIRECT_MARKER, CONSOLE_ORIGIN_FAULT, ENGINE_BINDING_ABSENT, FORBIDDEN_CLASS_MARKER, HTML_BODY_MARKER, STEPUP_REQUIRED_MARKER, classifyForbiddenBody, detectAccessRedirectBody, detectHtmlBody, detectStepUpRequiredBody, isConsoleBindingAbsentResponse, isConsoleOriginFaultResponse, RESTORE_UNAPPROVED_REASON, RATE_LIMIT_MARKER } from "../errors.ts";
import { isEdgeHtmlFaultResponse } from "./topology.ts";
import { isOwnerActionQueued, isPendingChangeBody } from "./types.ts";
import type { MutationResult, OwnerActionQueued, OwnerActionResult } from "./types.ts";
import { encodeChangeHeader, type ChangeRef } from "../change-ref.ts";

// Transport carries the engine origin, the optional bearer, the injected step-up ceremony, and the shared
// fetch/parse helpers every domain module uses. It is constructed once by EngineClient and threaded to each
// free function. base/token/onStepUpRequired keep the SAME visibility and semantics they had as EngineClient
// fields: base is the normalised origin, token the optional bearer, onStepUpRequired the injected step-up
// re-auth hook the store wires LAZILY onto each client (read at call time inside gatedFetch).
export class Transport {
  readonly base: string;
  readonly token: string | undefined;
  // onStepUpRequired is the injected step-up re-auth ceremony (set by the store: a fresh passkey assertion ->
  // a single-use step-up token). gatedFetch invokes it when a SENSITIVE action returns 401 { stepUpRequired }
  // and retries once with the token. Unset (or a cancel) surfaces the original 401 to the screen. It is
  // declared as an explicit-undefined union (not an optional `?` field) so EngineClient's pass-through
  // setter can assign undefined under exactOptionalPropertyTypes.
  // Injection point: the store sets this once at init. gatedFetch snapshots it per request so a
  // later reset cannot strip the handler from a ceremony already in flight.
  onStepUpRequired: (() => Promise<string | null>) | undefined = undefined;

  constructor(base: string, token?: string) {
    this.base = base;
    this.token = token;
  }

  // headers builds the request headers. The OPTIONAL change reference (change management, owner opt-in) rides
  // as the X-Downpipes-Change header (base64url JSON) on a CHANGE-CONTROLLED action, so the engine can record
  // the change-recorded CR; it is non-authority operator metadata (the engine never derives authority from it).
  // Omitted for every non-change-controlled call (and when no reference was attached), so the wire is unchanged
  // for them. A null/absent change adds nothing.
  headers(change?: ChangeRef | null): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    if (change) h["x-downpipes-change"] = encodeChangeHeader(change);
    return h;
  }

  // gatedFetch wraps a SENSITIVE-action fetch (ASVS V7.5.1): on a 401 { stepUpRequired:true } it runs the
  // injected step-up re-auth ceremony (a fresh passkey assertion -> a single-use token) and retries ONCE with
  // the x-downpipes-stepup header. With no ceremony wired, or a cancel/failure (token null), the original 401
  // is returned so the screen surfaces it. A non-401, or a 401 that is NOT a step-up prompt, passes through.
  //
  // Console-diagnostics note (Wave C): the ceremony OPENS with a 401 { stepUpRequired: true }, which is a
  // normal protocol handshake, NOT a fault. So the diagnostics response record is DEFERRED here and taken
  // only on the paths where the non-2xx is genuinely surfaced to the operator (no handler wired, a body
  // that is not a step-up prompt, or a cancelled/failed ceremony). The successful-ceremony path records the
  // RETRY's own outcome instead, so a working step-up leaves no phantom `auth` fault in the ring and cannot
  // drive a false console-engine-calls-failing signal. The ATTEMPT is counted on both legs either way.
  // `adminOp` names the privileged write this gated call is making, and rides the same
  // deferral as the engine-call record: the ceremony's opening 401 must not be recorded as a `denied-role`
  // refusal of the write, or every SUCCESSFUL step-up would put a phantom permissions denial in the pack for
  // the very save it went on to let through. The write's outcome is taken on the paths where the non-2xx is
  // genuinely surfaced, and on the RETRY, which is where the real answer is.
  async gatedFetch(path: string, init: RequestInit, opts: { adminOp?: ClientDiagAdminOp } = {}): Promise<Response> {
    const adminOp = opts.adminOp;
    const r = await engineFetch(`${this.base}${path}`, init, { deferResponseRecord: true, ...(adminOp !== undefined ? { adminOp } : {}) });
    // Snapshot the handler once so a concurrent reset of onStepUpRequired (set undefined mid
    // request) cannot drop the in-flight ceremony and leave the retry without a token.
    const stepUpHandler = this.onStepUpRequired;
    if (r.status !== 401 || stepUpHandler === undefined) {
      noteEngineResponse(r, adminOp);
      return r;
    }
    let stepUpRequired = false;
    try {
      const body = (await r.clone().json()) as { stepUpRequired?: boolean };
      stepUpRequired = body.stepUpRequired === true;
    } catch {
      noteEngineResponse(r, adminOp);
      return r;
    }
    if (!stepUpRequired) {
      noteEngineResponse(r, adminOp);
      return r;
    }
    const stepUpToken = await stepUpHandler();
    // The operator cancelled, or the ceremony failed: the original 401 IS surfaced to the screen, so it is
    // a real fault the ring should carry, and the write really did not happen.
    if (stepUpToken === null) {
      noteEngineResponse(r, adminOp);
      return r;
    }
    const headers = new Headers(init.headers as HeadersInit);
    headers.set("x-downpipes-stepup", stepUpToken);
    return engineFetch(`${this.base}${path}`, { ...init, headers }, adminOp !== undefined ? { adminOp } : {});
  }

  // failResponse is the single throw path for a non-2xx on a JSON route. Before throwing the
  // engine client's usual "<verb>: <status>" message it reads the body ONCE and checks whether it
  // is a Cloudflare Access redirect page (HTML / an Access login page) returned where JSON was
  // expected: Access intercepts an authenticated request whose session has lapsed and serves its
  // own login HTML, often with a non-2xx, which would otherwise read as "engine down". When detected it throws a message carrying ACCESS_REDIRECT_MARKER
  // so classifyError maps it to { kind: "access-redirect" } ("your Cloudflare Access session needs
  // refreshing"), not a server/network fault. No-custody: the body text is inspected for the redirect
  // and then discarded; it is never logged, stored, or transmitted, and only the marker (no body
  // content) rides in the thrown message.
  async failResponse(r: Response, verb: string): Promise<never> {
    let body = "";
    try {
      body = await r.text();
    } catch {
      // A body that cannot be read is not a redirect we can recognise; fall through to the status throw.
    }
    // The console's OWN worker answering "I have no ENGINE service binding". Tested BEFORE everything else,
    // because this response did not come from the engine and must not be classified as if it had: a 503 read as a
    // server fault sends support to the engine's logs, where there is nothing to find (the engine never received
    // the request), and the SPA-shell fall-through it replaces was read as `html-not-engine`, which sends the
    // operator to correct an engine URL that is correct.
    //
    // The admission is a SHAPE GATE, not a search: the status must be exactly 503, the body must parse as JSON, it
    // must be an object, and its `error` field must be EQUAL to the frozen constant. A body that fails any of
    // those falls through to the ordinary status throw. Nothing from the body is copied: the throw carries the
    // constant, which is a product token this console defines and never a value some server sent it.
    //
    // TWO independent admissions of the SAME frozen token, and they are a pair on purpose: the header (which the
    // engine-call seam uses, because it may not consume the body) and the body shape gate. If the two seams could
    // disagree, a stripped header would give the pack an engine-call row saying `server` and a throw saying
    // engine-binding-absent, which is the fabricated engine fault all over again in one of the two rows. Either
    // admission is an equality test against a constant this console defines, so neither can carry a foreign value.
    if (isConsoleBindingAbsentResponse(r) || (r.status === 503 && isEngineBindingAbsentBody(body))) {
      throw new Error(`${verb}: ${ENGINE_BINDING_ABSENT}`);
    }
    // THE CONSOLE'S OWN 500, AND THE SAME RULE ONE STATUS CODE OVER. The console worker's last-resort handler
    // answers a 500 carrying the frozen CONSOLE_ORIGIN_FAULT header when its dispatch throws, and a bound ENGINE
    // service binding whose fetch REJECTS (the engine worker deleted, throwing on boot, or over its resource
    // limits) lands there too. THE ENGINE NEVER RECEIVED THE REQUEST.
    //
    // Until now this seam ignored the header, threw the bare "<verb>: 500", and every reader downstream classified
    // it on the status alone: the feature probe filed `server-error` (whose meaning is "the engine is BROKEN and it
    // saw the call, so read its refusals"), the wizard filed `engine-not-ok`, and the block error told the operator
    // the engine had returned an error. There are no refusals to read. Worse, the RESPONSE seam already read the
    // header and correctly recorded the engine-call row as {network, transport}, so one pack carried two rows that
    // contradicted each other and the throw-derived one is the row support reads for "is it broken or not built".
    //
    // The admission is the header gate this console defines (isConsoleOriginFaultResponse: exactly 500, exactly the
    // frozen token), an equality test against a product constant, so no value a server sent can travel with it, and
    // the throw carries the constant rather than anything from the body. A 500 the ENGINE really answered carries
    // no such header and is still `server-error`, which is correct: there, the engine did see the call.
    if (isConsoleOriginFaultResponse(r)) {
      throw new Error(`${verb}: ${CONSOLE_ORIGIN_FAULT}`);
    }
    if (detectAccessRedirectBody(body)) throw new Error(`${verb}: ${ACCESS_REDIRECT_MARKER}`);
    // THE SIBLING PRODUCER OF THE VERY 5xx THE HEADER GATE ABOVE CATCHES. That gate admits the console's own
    // 500 by a header THIS console stamps, so it can only catch a 500 the console worker LIVED to answer. When the
    // worker never runs -- over its CPU or memory limits, script gone, an edge fault -- CLOUDFLARE answers for it
    // with its own HTML error page (1101, 1102, 1027), which carries no header of ours and used to arrive as a
    // bare 5xx: `server-error`, the row whose meaning is that THE ENGINE saw the call and refused it.
    //
    // In the PROXIED topology it cannot have been the engine, and that is decidable rather than assumed: there
    // the engine is a SERVICE BINDING (env.ENGINE.fetch, never an HTTP hop), the console declares the fact at
    // /engine-topology.json and the store adopts it at boot, and an engine answer is jsonError JSON or the
    // router's plain-text "not found" -- never a web page. So a 5xx with an HTML body, in that topology, is a
    // fault at the CONSOLE origin and NO REQUEST REACHED ANY ENGINE. It takes the same throw as the header gate.
    //
    // In the SPLIT topology the identical page is most often Cloudflare's 1101 in front of a REAL, BROKEN engine,
    // which is what the HTML rule below has always said. The topology flag is false there, and false whenever the
    // topology was never declared, so the claim is only made where the code can carry it.
    //
    // The test is the SHARED one (isEdgeHtmlFaultResponse, on the content type) rather than detectHtmlBody over
    // the body: the RESPONSE seam cannot read a body, and two seams asking different questions would file two
    // contradicting rows in one pack.
    if (isEdgeHtmlFaultResponse(r)) {
      throw new Error(`${verb}: ${CONSOLE_ORIGIN_FAULT}`);
    }
    // HTML ON A NON-2xx IS NOT THE ENGINE, AND UNTIL NOW ONLY A 200 SAID SO. parseJson has always thrown
    // HTML_BODY_MARKER when a web page answered where engine JSON was expected, but ONLY on the success path,
    // so the ordinary wrong-address shape -- an engine URL pointing at a static host or a proxy, which 404s an
    // HTML page -- arrived here, took the plain status throw, and became a 404. That is byte-identical to a REAL
    // engine answering a route it genuinely does not serve, and the console's whole pending-the-engine tile
    // rests on telling those apart: in the first there is no engine at that address and the tile is a lie the
    // customer is told until someone checks the URL, in the second the tile is correct and a release will fix it.
    //
    // It cannot cry wolf on a real engine. The engine's unmatched-route answer is the PLAIN TEXT "not found"
    // (router.ts) and every other refusal it makes is jsonError, so detectHtmlBody is false on all of them.
    //
    // SCOPED AWAY FROM EVERY STATUS THE PERIMETER OWNS, and that scope is the whole honesty of the class.
    // detectHtmlBody is "an HTML page came back", nothing more: it cannot tell a static host's 404 page from a
    // block page served by the customer's own edge. So it may only decide the ADDRESS on statuses no perimeter
    // uses to refuse a request that reached the right address:
    //   5xx  most often Cloudflare's 1101 page in front of a Worker that threw: a real engine, BROKEN.
    //        `server-error` is the true reading and the remedy is the engine, not its address.
    //   429  Cloudflare's rate-limit block page (error 1015): `rate-limited` (wait), not a wrong address.
    //   403  Cloudflare's firewall block page (error 1020), and a rate-limit rule whose action is Block answers
    //        403 rather than 429. The engine is deployed at exactly that address and is healthy; the customer's
    //        own WAF rule stopped the browser. Reading that as "nothing is deployed here" sends support to
    //        correct an address that is correct, so a 403 stays `forbidden`: the call was refused, by the engine
    //        or by the edge in front of it, and neither reading claims the deployment is absent.
    //   401  a proxy or Access challenge (an Access login page whose first 600 bytes carry no Access marker is
    //        still HTML on a 401). A 401 has always recorded nothing, deliberately, and an HTML body must not be
    //        the thing that turns the ordinary lapsed-session state into "your engine address is wrong".
    // Claiming "nothing is deployed here" off any of the four would assert a fact this code never established.
    if (r.status !== 401 && r.status !== 403 && r.status !== 429 && r.status < 500 && detectHtmlBody(body)) {
      throw new Error(`${verb}: ${HTML_BODY_MARKER}`);
    }
    // A 429 carries the engine's Retry-After (whole seconds): fold it in BEFORE the trailing status so
    // classifyError can pace the bulk loops by it (CON-2). The trailing status stays the last token, so a
    // non-429 throw is byte-unchanged and extractStatus still reads the status. A missing/non-numeric
    // Retry-After degrades to the plain status throw (the loop then uses its default backoff).
    if (r.status === 429) {
      const ra = retryAfterSeconds(r);
      if (ra !== null) throw new Error(`${verb}: ${RATE_LIMIT_MARKER}=${ra}: ${r.status}`);
    }
    // A BARE 403 IS NOT AN AUTHORITY FACT. Four different refusals answer 403 to the same call (the
    // capability gate, the DO's anti-enumeration AuthError funnel, the CSRF-origin check that pre-empts the whole
    // route dispatch for every cookie-borne mutation, and a WAF block page the engine never saw), and this throw
    // used to be byte-identical for all four -- so the dual-control inbox filed "a deploy dropped CONSOLE_ORIGIN
    // on the engine and EVERY save in this console is 403ing" as a governance fault against an owner. The class
    // is decided by a SHAPE GATE over the body (classifyForbiddenBody: parse, equality against tokens this
    // console defines, a typeof test on `required`) and folded in as a closed member on the RATE_LIMIT_MARKER
    // pattern, so the trailing status stays the last token and extractStatus is unchanged. No byte of the body
    // rides: only the enum member.
    if (r.status === 403) {
      throw new Error(`${verb}: ${FORBIDDEN_CLASS_MARKER}=${classifyForbiddenBody(body)}: ${r.status}`);
    }
    // A 401 that still carries stepUpRequired reached this generic thrower only because a step-up
    // ceremony was needed and NOT satisfied (gatedFetch runs the ceremony on a stepUpRequired 401 and
    // surfaces the raw 401 only when it was refused, cancelled or unavailable). That is a
    // re-verify-your-identity state, not a dead session, so it is folded as its own marker (a SHAPE
    // gate over the body, like the 403 class) and must not classify as "unauthorised" and bounce the
    // operator to sign-in while the session is still valid. The trailing status stays the last token.
    if (r.status === 401 && detectStepUpRequiredBody(body)) {
      throw new Error(`${verb}: ${STEPUP_REQUIRED_MARKER}: ${r.status}`);
    }
    throw new Error(`${verb}: ${r.status}`);
  }

  // parseJson is the standard read for a JSON route: it throws on a non-2xx (via failResponse, so an
  // Access-redirect non-2xx is named honestly), and on a 2xx it parses the body, but if the 2xx body
  // is not the expected JSON (an Access login page can arrive as a 200 HTML) it likewise detects the
  // redirect and throws ACCESS_REDIRECT_MARKER rather than a parse error. Same no-custody discipline:
  // the body text is read once, inspected for the redirect shape on a parse failure, then discarded.
  async parseJson<T>(r: Response, verb: string): Promise<T> {
    if (!r.ok) return this.failResponse(r, verb);
    const text = await r.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      // An Access-marked page is a session matter; any OTHER web page (a wrong engine URL, an
      // undeployed engine, a proxy or SPA shell answering 200 HTML) is named as html-body so the
      // copy prescribes checking the URL/deployment, never a re-authentication (C2-1 refined).
      if (detectAccessRedirectBody(text)) throw new Error(`${verb}: ${ACCESS_REDIRECT_MARKER}`);
      // C2 contract-drift (Wave C): a 2xx whose body is not the JSON the contract describes. The
      // Access-redirect case above is deliberately NOT recorded: a lapsed Access session is a normal
      // condition of the perimeter, not engine drift, and recording it would flood the ring with the same
      // false positive the step-up 401 would have been. Only the CLASS is recorded; the body is never read
      // into a field (it is inspected locally for the two shapes and discarded).
      recordContractDrift("malformed-body");
      if (detectHtmlBody(text)) throw new Error(`${verb}: ${HTML_BODY_MARKER}`);
      throw new Error(`${verb}: ${r.status}`);
    }
  }

  // parseJsonOrReason is parseJson plus the B31 reason-fold, for a mutation that returns a plain record
  // (never a 202-pending) but whose refusals carry an ACTIONABLE reason the operator must read. A 400/422
  // whose body carries the engine's coarse `error` is thrown WITH that reason (superseded, decided-by-
  // another, maker-is-checker, self-approval, unknown-downpipe, which-artefact-is-wrong), while 401/403/429
  // and 5xx keep their own failResponse markers (stepup / forbidden-class / rate-limit / server) - the same
  // status gate parseJsonOrPending uses, so a role denial still reads "Not permitted", never a 400 sentence.
  // Used by the dual-control approve/reject family, the run-trigger and the DR break-glass reconcile
  // (B50/B51/B52), which previously showed only a bare "<verb>: <status>".
  async parseJsonOrReason<T>(r: Response, verb: string): Promise<T> {
    if (!r.ok && r.status !== 401 && r.status !== 403 && r.status !== 429 && r.status < 500) {
      const reason = await this.readErrorReason(r);
      if (reason !== null) throw new Error(`${verb}: ${reason}: ${r.status}`);
    }
    return this.parseJson<T>(r, verb);
  }

  // parseJsonOrPending is the read for a CONFIG-MUTATION route that the engine's change-control gate
  // (the opt-in four-eyes / dual-control policy) may DEFER instead of applying. When the gate is ON the
  // engine answers a config mutation with HTTP 202 and a body { pending: true, id, ... } INSTEAD of the
  // usual 200 + the applied record: the change is queued for a second approver, not applied. This helper
  // CENTRALISES that one branch so every mutation site handles it the same way: a 202 with a recognised
  // pending body resolves to a discriminated { status: "pending", changeId, kind?, raw } result the caller
  // surfaces as "queued for approval"; any OTHER 2xx resolves to the applied value (status:"applied"); a
  // 202 whose body does NOT carry the pending shape throws the honest "answer-unreadable" error rather than
  // being silently coerced into a false "applied" (B8, confirmed live by the write-fault
  // capability); a non-2xx still routes through failResponse so an Access-redirect body (C2-1) is named
  // honestly. The 202 is the ONLY status that means "pending"; a 200 always means applied, so a gate that
  // is OFF behaves exactly as before (the applied record flows straight through). No-custody: the pending
  // body carries an id, a kind and a plain-English diff only (no value, no key); we read its id and pass
  // the rest through untouched.
  async parseJsonOrPending<T>(r: Response, verb: string): Promise<MutationResult<T>> {
    if (!r.ok) {
      // B31: a plain validation refusal (a 400/422 that is NOT one of the special-marker statuses
      // failResponse folds a closed class for) carries the engine's coarse reason in body.error, so
      // fold it in (status trailing) exactly as parseJsonOrOwnerAction already does for owner mutations.
      // Without this the operator saw only a bare "<verb>: 400" and lost the reason (e.g. the SSRF
      // default-deny sentence on a notify channel save). 401/403/429/5xx keep their own failResponse
      // markers (stepup / forbidden-class / rate-limit / server), so the reason fold is gated out for them.
      if (r.status !== 401 && r.status !== 403 && r.status !== 429 && r.status < 500) {
        const reason = await this.readErrorReason(r);
        if (reason !== null) throw new Error(`${verb}: ${reason}: ${r.status}`);
      }
      return this.failResponse(r, verb);
    }
    const text = await r.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // Same split as parseJson: Access-marked HTML is a session matter, any other web page is
      // the honest html-body kind (check the engine URL / deployment), never a re-auth prompt.
      if (detectAccessRedirectBody(text)) throw new Error(`${verb}: ${ACCESS_REDIRECT_MARKER}`);
      recordContractDrift("malformed-body"); // C2, same discipline as parseJson: class only, Access excluded
      if (detectHtmlBody(text)) throw new Error(`${verb}: ${HTML_BODY_MARKER}`);
      throw new Error(`${verb}: ${r.status}`);
    }
    // The deferred branch: 202 + the engine's { queued: true, id, status, contentHash } body. The status code
    // is the authority (a 202 is the engine's deliberate "queued, not applied").
    if (r.status === 202) {
      if (isPendingChangeBody(body)) {
        return { status: "pending", changeId: body.id, raw: body };
      }
      // B8 (governance-lie class, confirmed LIVE by the write-fault capability's fulfilMalformed202
      // probe on addDownpipe): a 202 says "queued for a second approver", but this body does not carry the
      // pending shape the contract promises. The OLD fall-through here read a shape mismatch as APPLIED (a bare
      // `{}` body resolved to { status:"applied", value:{} }), so toggleEnabled and every other caller showed a
      // success toast and closed the drawer while the engine's own state never moved, proven by an independent
      // fleet read-back. A 202 whose body cannot be trusted must never resolve to a value: throw the SAME
      // honest "answer-unreadable" shape parseJson already throws for an illegible 2xx body. classifyError maps
      // "<verb>: 202" to { kind: "answer-unreadable", status: 202 }, "the engine answered, only the response
      // could not be understood", never a false success and never a bare reachability fault either. The class
      // alone is recorded (never the missing field's name, which could itself be engine- or customer-derived).
      recordContractDrift("missing-field");
      throw new Error(`${verb}: ${r.status}`);
    }
    return { status: "applied", value: body as T };
  }

  // readErrorReason reads a non-2xx JSON body and returns its `error` string, or null when the
  // body is not readable JSON or carries no usable `error`. It is used by restore() so the
  // dual-control 403 ("restore not approved") is distinguishable from a role denial downstream.
  // It deliberately reads ONLY the `error` field: the engine's error payload carries no value and
  // no key (no-custody), and the console surfaces only that coarse reason. To keep the classifier's
  // status extraction unambiguous it strips any trailing 3-digit run of digits and surrounding
  // punctuation from the reason, so a reason that happened to end in digits cannot be mistaken for
  // the HTTP status the message appends.
  //
  // A 401 that carries stepUpRequired:true must return null here, BEFORE the
  // generic `error`-string read below, never a plain reason string. The engine's step-up 401
  // (requireStepUp, engine/src/admin/router-core.ts) answers { error: "step-up required",
  // stepUpRequired: true }: a well-formed, non-empty `error`, so the read below used to return it
  // first. Every one of this method's callers shares the same shape -- read a reason; if present,
  // throw "<verb>: <reason>: <status>"; otherwise fall through to failResponse() -- and failResponse
  // ALREADY folds a stepUpRequired 401 into STEPUP_REQUIRED_MARKER via its own shape gate
  // (detectStepUpRequiredBody). Returning the reason here shadowed that gate: the thrown message read
  // "<verb>: step-up required: <status>", which does not contain the marker token ("stepup-required",
  // no hyphen after "step"), so classifyError never matched it, fell through to the bare 401 branch,
  // and isUnauthorised(err) read true. A step-up gap -- the operator IS authenticated and needs to
  // prove presence for a sensitive action -- was misread as a lapsed session and signed the operator
  // out, discarding a valid session at the exact moment they were doing something that mattered.
  // Proved live on createAttestSession (restore-flow/attend.ts's Start action) and reproduced offline
  // in test/validate-r31-stepup-reason-survives.ts; the shape is shared by every caller of this
  // method (client-attest.ts, client-keys.ts, client-session.ts, client-posture.ts, and
  // parseJsonOrOwnerAction's own inline read above), so the single fix here closes all of them at
  // once rather than patching each call site's throw.
  //
  // Scoped to 401 + stepUpRequired only: every other status (the 403 dual-control reason this
  // method exists for, a plain 400/422 validation reason) is untouched, and a hypothetical OTHER
  // 401 body that carries an `error` but not stepUpRequired:true still returns its reason as before.
  async readErrorReason(r: Response): Promise<string | null> {
    try {
      const body = (await r.clone().json()) as { error?: unknown; stepUpRequired?: unknown };
      if (r.status === 401 && body.stepUpRequired === true) return null;
      if (typeof body.error !== "string") return null;
      const trimmed = body.error.trim();
      if (trimmed === "") return null;
      // Compare against the known dual-control reason exactly; for any other reason, normalise away
      // a trailing status-like digit run so the appended HTTP status stays the only trailing number.
      if (trimmed.toLowerCase().includes(RESTORE_UNAPPROVED_REASON)) return RESTORE_UNAPPROVED_REASON;
      return trimmed.replace(/[:\s]*\d{3}\s*$/, "").trim() || null;
    } catch {
      return null;
    }
  }

  // foldableReason answers the question a raw readErrorReason call site never asks: is folding the engine's
  // coarse `error` into the message BETTER than the closed class failResponse would fold instead? For most
  // statuses it is, because failResponse has nothing to say about a 400. For a 401, a 403, a 429 or a 5xx it
  // is not, because failResponse folds a marker the classifier and the copy layer both read, and a bare
  // `error` string overwrites it with something they cannot read at all.
  //
  // THE FAILURE THIS EXISTS TO STOP, driven on the restore apply. The engine's capability gate answers
  // 403 { error: "forbidden", required: "restore.apply" }. A call site that folds the reason unconditionally
  // throws "restore: forbidden: 403", never reaches failResponse, so FORBIDDEN_CLASS_MARKER is never folded,
  // forbiddenClass() returns null, and error-view's forbiddenCopy falls to its default: "Your role does not
  // permit this action." That sentence asserts a role denial the console never established, and on the
  // restore path it is the most expensive wrong sentence in the product. The CSRF 403 was worse still: the
  // console holds a correct, reviewed sentence for it that says in as many words that it is "not anything
  // about your role or your permissions", and folding the reason made that sentence UNREACHABLE from a
  // restore. The shape gate in failResponse already tells these four 403s apart; this method's whole job is
  // to stop the reason fold pre-empting it.
  //
  // The ONE carve-out is the dual-control refusal. `restore not approved` is also a 403, and it is the one
  // 403 the shape gate CANNOT name: classifyForbiddenBody tests `error` for equality against the engine's
  // frozen tokens, and this reason is not among them, so the honest residual it returns is `not-engine-body`
  // and the operator would be told a firewall refused their restore when a colleague simply has not signed
  // it yet. So this reason is folded on any status, and it is the frozen constant this console owns, never a
  // byte copied out of the body. Everything else on 401/403/429/5xx yields null and falls to failResponse.
  //
  // The status set is the SAME one parseJsonOrReason and parseJsonOrPending already guard with. This method
  // exists so the guard is written once and the recovery path's hand-rolled call sites can share it.
  async foldableReason(r: Response): Promise<string | null> {
    const reason = await this.readErrorReason(r);
    if (reason === null) return null;
    if (reason === RESTORE_UNAPPROVED_REASON) return reason;
    if (r.status === 401 || r.status === 403 || r.status === 429 || r.status >= 500) return null;
    return reason;
  }

  // readOwnerActionQueued reads an HTTP 202 body and returns the OwnerActionQueued shape when the engine
  // deferred a consequential update to a SECOND owner's approval (a migration/breaking apply/ramp under dual
  // control), or null when the 202 body is not that shape (so the caller falls through to its structured 2xx
  // path). It reads a CLONE so the original body stays unread for parseJson/failResponse. The body carries
  // only { ownerActionQueued, id, status }, an owner-action record id, never a value, key or token.
  async readOwnerActionQueued(r: Response): Promise<OwnerActionQueued | null> {
    try {
      const body = (await r.clone().json()) as unknown;
      return isOwnerActionQueued(body) ? body : null;
    } catch {
      return null;
    }
  }

  // parseJsonOrOwnerAction is the read for a HIGH-BLAST-RADIUS OWNER MUTATION route the engine's owner-action
  // dual-control gate may DEFER instead of applying (the destination repoint/add/remove/default, the IdP
  // connection create/delete/enable, the discovery-token set). It CENTRALISES the one branch every such site
  // shares: when the gate is ON the engine answers HTTP 202 with the OwnerActionQueued body
  // { ownerActionQueued:true, id, status } WITHOUT applying anything, which resolves to a discriminated
  // { status:"queued", queued } the caller surfaces as "queued for a second owner" (NOT a false "saved /
  // removed / default set / connection created"); any other 2xx resolves to the applied value
  // ({ status:"result", value }); a non-2xx folds the engine's plain { error } reason into the throw in the
  // "<verb>: <reason>: <status>" form (as setDestination/setLicence do) and still routes through failResponse
  // so an Access-redirect body (C2-1) is named honestly. The 202 is the ONLY status that means "queued"; a
  // 200 always means applied, so the gate-OFF path (the default) behaves EXACTLY as before. The 202 body is
  // read defensively (isOwnerActionQueued): a 202 that is NOT the OwnerActionQueued shape throws the honest
  // "answer-unreadable" error rather than being silently coerced into a false "result" (B8, confirmed live
  // ) -- it never fabricates a queued id no inbox could resolve, and it never fabricates an applied
  // value the engine never sent. No-custody: the queued body carries an owner-action record id only (no
  // value, no key).
  async parseJsonOrOwnerAction<T>(r: Response, verb: string): Promise<OwnerActionResult<T>> {
    if (r.status === 202) {
      const queued = await this.readOwnerActionQueued(r);
      if (queued !== null) return { status: "queued", queued };
      // B8 (governance-lie class, the same fall-through parseJsonOrPending carried, confirmed LIVE
      // by the write-fault capability on addDownpipe's sibling decoder): the engine deferred to a second owner
      // (202) but this body is not the OwnerActionQueued shape, neither well-formed JSON matching the contract
      // nor parseable at all (readOwnerActionQueued returns null for both). The OLD fall-through continued past
      // this point to the ordinary 2xx path below, which would parse a malformed-but-valid body (even `{}`) and
      // resolve it as an APPLIED value, telling the operator a destination/connection/token change had landed
      // when the engine's own state never moved. A 202 whose body cannot be trusted must never resolve to a
      // value: throw the same honest "answer-unreadable" shape parseJson already throws for an illegible 2xx
      // body (classifyError maps "<verb>: 202" to { kind: "answer-unreadable", status: 202 }), never fall
      // through to a false "result". The class alone is recorded (never the missing field's name, never the
      // body).
      recordContractDrift("missing-field");
      throw new Error(`${verb}: ${r.status}`);
    }
    if (!r.ok) {
      const reason = await this.readErrorReason(r);
      if (reason !== null) throw new Error(`${verb}: ${reason}: ${r.status}`);
      return this.failResponse(r, verb);
    }
    return { status: "result", value: await this.parseJson<T>(r, verb) };
  }
}

// isEngineBindingAbsentBody (G152) is the SHAPE GATE on the console worker's own 503 body. It parses the text as
// JSON, requires a plain object, and requires its `error` field to be EQUAL to the frozen ENGINE_BINDING_ABSENT
// token. It returns a BOOLEAN and extracts nothing, so no part of the body can ride anywhere: the only thing the
// caller learns is whether the response was the one this console's worker produces for itself.
//
// It is deliberately not a substring search over the body. A body is untrusted input even when we believe we sent
// it, and a match on a fragment inside some other server's page would let an outside body decide how the console
// classifies its own transport. Equality on a parsed field cannot.
function isEngineBindingAbsentBody(text: string): boolean {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return false; // not JSON: not ours
  }
  return typeof body === "object" && body !== null && (body as { error?: unknown }).error === ENGINE_BINDING_ABSENT;
}

// retryAfterSeconds reads a Response's Retry-After header as whole seconds, or null when it is absent or
// not a non-negative integer. Only the integer-seconds form (what the engine's limiter sends) is honoured;
// an HTTP-date Retry-After returns null so the caller falls back to its default backoff. The header value
// is a wait hint, not customer data, so folding it into a thrown message keeps the no-custody invariant.
function retryAfterSeconds(r: Response): number | null {
  const raw = r.headers.get("retry-after");
  if (raw === null) return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}
