// The licence-email CLAIM CODE: a short, human-typeable code (DWNP-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX, Crockford
// base32, case-insensitive, hyphens optional) the vendor's control plane exchanges for the full signed
// licence token (a hybrid post-quantum signature, several kilobytes) the engine actually verifies and
// stores. Customers now receive the SHORT code in their licence email rather than the huge token; the
// code itself proves nothing and gates nothing, it is only a lookup key the control plane resolves back
// to the real token, which the engine then verifies live against the pinned vendor signer exactly as it
// always has (verify-before-store, unchanged). This module holds the pure shape/normalisation logic
// (validated directly by validate-licence.ts, no DOM) and the one network call; activation.ts stays the
// DOM-wiring layer over it. House rules: Australian English, no em dashes, precise claims.

import { recordClaimExchange } from "../../lib/client-diag/ring.ts";

// CLAIM_CODE_PREFIX is the fixed first group every claim code carries. Requiring it (rather than accepting
// a bare 30-character payload) is what lets the Activate button tell "this is a claim code" from "this is
// something else typed into that field" without guessing -- a wrong-shape value (missing prefix, wrong
// length, a stray character) is simply not treated as a claim code at all; it falls back to the token-
// paste path rather than erroring.
export const CLAIM_CODE_PREFIX = "DWNP";

// The Crockford base32 alphabet: 10 digits + 22 letters, excluding I, L, O and U (each easily confused
// with 1, 1, 0 and V when read off a printed email). CLAIM_CODE_PAYLOAD_LEN (30 = six groups of five,
// after the prefix) matches the DWNP-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX shape named in the licence email.
const CLAIM_CODE_PAYLOAD_LEN = 30;
const CLAIM_CODE_PAYLOAD_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/;

// normaliseClaimCode turns whatever the operator typed or pasted into the canonical comparison form:
// uppercased, with every hyphen and whitespace character removed (the code is case-insensitive and its
// hyphens are cosmetic grouping only, exactly like a software licence key). isClaimCodeShape and
// formatClaimCode both operate on this value; it is never sent anywhere on its own (formatClaimCode's
// re-hyphenated form is what goes on the wire). Pure; never throws.
export function normaliseClaimCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, "");
}

// isClaimCodeShape reports whether an ALREADY-NORMALISED string (see normaliseClaimCode) is a well-formed
// claim code: the DWNP prefix, required, followed by exactly CLAIM_CODE_PAYLOAD_LEN Crockford base32
// characters. Pure; never throws.
export function isClaimCodeShape(normalised: string): boolean {
  if (!normalised.startsWith(CLAIM_CODE_PREFIX)) return false;
  const payload = normalised.slice(CLAIM_CODE_PREFIX.length);
  return payload.length === CLAIM_CODE_PAYLOAD_LEN && CLAIM_CODE_PAYLOAD_RE.test(payload);
}

// formatClaimCode renders an already-shape-checked, normalised code back into the canonical hyphenated
// grouping (DWNP-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX), the same form the licence email prints. This is the value sent
// to the control plane, so a code typed without hyphens, in lower case, or with stray whitespace reaches
// the wire identically to one copied straight from the email. Pure; never throws (callers only pass a
// value isClaimCodeShape has already accepted).
export function formatClaimCode(normalised: string): string {
  const payload = normalised.slice(CLAIM_CODE_PREFIX.length);
  const groups = [
    payload.slice(0, 5),
    payload.slice(5, 10),
    payload.slice(10, 15),
    payload.slice(15, 20),
    payload.slice(20, 25),
    payload.slice(25, 30),
  ];
  return [CLAIM_CODE_PREFIX, ...groups].join("-");
}

// CONTROL_PLANE_BASE is the vendor's PUBLIC, unauthenticated machine host for the claim-code exchange (a
// plain custom domain, CORS-open on exactly this one route). It is deliberately NOT admin.downpipes.io:
// that host sits behind Cloudflare Access, so a browser POST with no Access session (every customer's
// console, the first time they ever activate) would be redirected into an Access login page instead of
// ever reaching the route.
// : SAME-ORIGIN, through the console Worker's narrow claim proxy (src/worker.ts,
// isControlPlaneSurface). It used to fetch https://control.downpipes.io directly from the browser,
// which buildCsp()'s connect-src 'self' blocks outright, so activation was dead in the shipped
// console and every attempt landed in the catch below reading as a network fault. The vendor host is
// unchanged; the Worker holds it now, and the browser never names a foreign origin.
const CONTROL_PLANE_BASE = "";
const CLAIM_PATH = "/control-plane/licence/claim";

// CLAIM_TIMEOUT_MS bounds the claim fetch with a hard AbortController timeout: a customer's own network or
// an outage at the vendor must never leave the Activate button hung indefinitely. Exported (and taken as
// an optional parameter below) purely so the validator can prove the abort path fires without a real
// 8-second wait; production always gets the real value.
export const CLAIM_TIMEOUT_MS = 8000;

// The failure copies: calm and specific about which one to fix (a typo, or the wrong email) versus which one
// to work around right now (paste the token instead). No path is retried automatically; a deliberate re-click
// tries again.
//
// UNREACHABLE and ERRORED are now two different sentences, because they were one, and the one they were
// was wrong. A claim service that ANSWERED with a 500 was reported to the operator as "could not be reached.
// Check your connection", which sends a customer whose network is perfectly fine to go and inspect it, while
// the actual fault is a vendor outage they can do nothing about. The copy now only says "could not be
// reached" when nothing answered.
export const CLAIM_UNREACHABLE_TEXT =
  "The claim service could not be reached. Check your connection and try again, or email support@downpipes.io.";
export const CLAIM_ERRORED_TEXT =
  "The claim service answered with an error, so your code could not be retrieved. This is at our end, not yours. Try again shortly, or email support@downpipes.io.";
export const CLAIM_NOT_RECOGNISED_TEXT = "That code was not recognised. Check it against your licence email and try again.";

// CLAIM_BAND_FULL_FALLBACK_TEXT is used ONLY if a 409 band-full refusal's body cannot be read (a
// malformed or missing `message` field): the ordinary case reads the control plane's own message
// verbatim (it already names the band and the two ways to add an estate), never this generic fallback.
export const CLAIM_BAND_FULL_FALLBACK_TEXT =
  "This licence's estate band is already fully bound to other Cloudflare accounts. To add another estate, buy a larger Business band or contact support@downpipes.io.";

// CLAIM_HINT_TEXT is the one line of standing guidance under the claim-code field (the screen otherwise
// adds no new copy: one input, one hint).
export const CLAIM_HINT_TEXT =
  "The code retrieves your signed licence from downpipes; your engine still verifies it against the pinned key before storing it.";

// The shape the control plane answers with on success: the full signed licence token (opaque to this
// screen -- the engine is the one party that verifies it) plus three redaction-safe facts (account, tier,
// notAfter) this module reads no further; the engine's own answer after verify-before-store is what the
// screen actually renders once activation completes.
export interface ClaimSuccess {
  token: string;
  account: string;
  tier: string;
  notAfter: string;
}

// ClaimFetchResult is the pure outcome fetchClaimToken resolves to: the token to hand straight to the
// existing activation submit, or the exact copy to show inline at the field. Never throws.
export type ClaimFetchResult = { ok: true; token: string } | { ok: false; message: string };

// fetchClaimToken exchanges a well-formed, already-formatted claim code (see formatClaimCode) for its
// signed licence token. It is a plain, direct fetch, no demo-mode branching -- the same convention this
// screen's own Provenance section already uses for its on-demand release-record cross-check
// (screens/licence/provenance.ts crossCheckReleaseRecord), which likewise calls an external, non-/admin/*
// host directly: it is a manual, operator-triggered exchange (never automatic, never on page load), and
// the request carries no session and no customer data either way (a code, and in return a licence token),
// so there is nothing here for a demo/tour mode to protect by faking it.
//
// Every fault degrades to one of the calm messages above, never a throw. The operator sees four sentences
// (not recognised / band full / could not be reached / answered with an error) because those are the four
// DIFFERENT next steps they have.
//
// THE PACK NOW SEES ALL TEN OUTCOMES, and it has never seen ANY of them. This exchange is a direct
// fetch to the vendor control plane, not an /admin/* call, so it does not pass the engineFetch seam and the
// diagnostics ring has never had a row from it. Five distinct faults arrived at support as one of two strings,
// and the operator's own report ("check your connection") actively misdirected the diagnosis. A vendor 5xx,
// a CORS regression after a control-plane deploy (which hits every customer at once), the 8-second timeout,
// and a 200 whose body no longer carries a token are four completely different incidents that read to a
// support engineer as one. A tenth outcome was added: "band-full", a legitimate business refusal (the
// licence's estate band is already fully bound) rather than a fault, carried through with its own
// operator-facing message rather than folded into the generic error text.
//
// No claim code, no response body, no status text and no host ever rides: `claimResult` is a closed enum and
// there is no field for anything else. `success` is recorded too, so its absence in a pack full of failures
// means something.
// cfAccountId is this engine's own Cloudflare account id
// (GET /admin/status's cfAccountId), threaded through so the control plane can bind a self-serve
// licence to the account claiming it. Optional and honestly omitted from the request body when absent
// (the common single-account deployment that never sets CF_ACCOUNT_ID, or an older engine build): the
// claim then behaves exactly as it did before this parameter existed.
export async function fetchClaimToken(code: string, timeoutMs: number = CLAIM_TIMEOUT_MS, cfAccountId?: string): Promise<ClaimFetchResult> {
  const controller = new AbortController();
  // timedOut distinguishes OUR abort from a genuine network/CORS throw. Both land in the same catch as a
  // rejection, and to a customer they are the same "it did not work", but they are opposite tickets: one is a
  // control plane too slow to answer inside the bound, the other is one that did not answer at all. The flag
  // is set in the SAME callback that aborts (not by a second timer of the same delay, which would race the
  // abort's own rejection microtask and lose), so it is true by the time the catch runs. Nothing is inferred
  // from the rejection's text.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(`${CONTROL_PLANE_BASE}${CLAIM_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, ...(cfAccountId !== undefined ? { cfAccountId } : {}) }),
      signal: controller.signal,
    });
    if (res.status === 404) {
      recordClaimExchange("not-recognised");
      return { ok: false, message: CLAIM_NOT_RECOGNISED_TEXT };
    }
    if (res.status === 409) {
      // A legitimate business refusal, not a fault. The code
      // itself verified; the control plane refused only because this licence's estate band is already
      // fully bound to OTHER Cloudflare accounts. Its own message already names the band and the two
      // ways to add an estate, so it is read verbatim rather than folded into the generic error text a
      // genuine 4xx/5xx gets below.
      recordClaimExchange("band-full");
      let message = CLAIM_BAND_FULL_FALLBACK_TEXT;
      try {
        const body = (await res.json()) as { message?: string } | null;
        if (body && typeof body.message === "string" && body.message.length > 0) message = body.message;
      } catch {
        // Malformed body: the fallback text above still names the fact and the remedy.
      }
      return { ok: false, message };
    }
    if (!res.ok) {
      // The control plane ANSWERED. Whatever else is true, the customer's connection is working, and the copy
      // must not tell them otherwise. A 5xx is the vendor outage; a non-404 4xx is a rejected request (a
      // moved route, a rejected origin), which is also ours.
      recordClaimExchange(res.status >= 500 ? "http-5xx" : "http-4xx");
      return { ok: false, message: CLAIM_ERRORED_TEXT };
    }
    let body: Partial<ClaimSuccess> | null;
    try {
      body = (await res.json()) as Partial<ClaimSuccess> | null;
    } catch {
      // A 200 whose body will not parse. The service is up and is answering with something that is not the
      // contract, which is what a control-plane deploy that changed the response shape looks like.
      recordClaimExchange("parse-failure");
      return { ok: false, message: CLAIM_ERRORED_TEXT };
    }
    const token = body && typeof body.token === "string" ? body.token : "";
    if (token === "") {
      // A 200 that parsed and carried NO token. Everything about this looks healthy from the outside and
      // nothing works, which is exactly why it needs its own class rather than a shrug.
      recordClaimExchange("empty-token-200");
      return { ok: false, message: CLAIM_ERRORED_TEXT };
    }
    recordClaimExchange("success");
    return { ok: true, token };
  } catch {
    // The fetch itself rejected: nothing answered. Our own timer says whether that was our 8-second bound
    // firing or a network/CORS refusal; the rejection's own text is never read.
    recordClaimExchange(timedOut ? "timeout" : "network-or-cors");
    return { ok: false, message: CLAIM_UNREACHABLE_TEXT };
  } finally {
    clearTimeout(timer);
  }
}
