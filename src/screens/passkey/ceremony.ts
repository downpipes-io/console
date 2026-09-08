// The PURE ceremony helpers for the passkey sign-in screen (browser-API-free, fully testable) plus the small
// local leaf the screen and its flows share: the feature-detect, the begin-options decoders and the
// credential encoders the WebAuthn create()/get() results pass through, the engine-reason and thrown-error to
// honest-copy mappers, the inline result banners, the module-level one-shot register-prefill + auth-known
// presentation state, and the local file-download idiom. The encoders/decoders read only the bytes the engine
// DO reads, so they are identical under a real PublicKeyCredential and the validator's fixture. Moved verbatim
// from the passkey coordinator for size; behaviour, copy and the wire shapes are unchanged. These are the
// building blocks both the screen and the flows reach for, so they live in this leaf and the flows import one
// way from here (no cycle).
//
// House style: Australian English, no em dashes.

import type {
  PasskeyAssertionCredential,
  PasskeyAttestationCredential,
  PasskeyCreationOptions,
  PasskeyRequestOptions,
} from "../../api.ts";
import { ab, b64urlDecode, b64urlEncode } from "../../bytes.ts";
import { engineAnswered, errorDetail } from "../../components/error-view.ts";
import { banner } from "../../components/feedback.ts";
import { recordWireAnomaly } from "../../lib/client-diag/ring.ts";
import { deliverFile } from "../../lib/file-delivery.ts";

// ---- PURE ceremony helpers (browser-API-free, fully testable) ----------------------------------

// webauthnSupported reports whether this browser exposes the WebAuthn credential API at all
// (navigator.credentials.create/get and the PublicKeyCredential global). It is a pure decision over the
// provided globals snapshot so it can be unit-tested with a fixture; readWebAuthnGlobals() snapshots the
// real globals in the browser. A passkey is impossible without these, so the screen shows an honest
// "this browser does not support passkeys" notice rather than a button that would throw.
export interface WebAuthnGlobals {
  hasCredentials: boolean; // navigator.credentials.create AND .get are functions
  hasPublicKeyCredential: boolean; // the PublicKeyCredential constructor exists
}
export function webauthnSupported(g: WebAuthnGlobals): boolean {
  return g.hasCredentials && g.hasPublicKeyCredential;
}

// readWebAuthnGlobals snapshots the real browser globals into the testable shape. It is the only impure
// part of detection; it is guarded so it never throws on a non-browser runtime (the validator under node),
// returning the all-false snapshot (so webauthnSupported is false there, never a thrown access).
export function readWebAuthnGlobals(): WebAuthnGlobals {
  const nav: Navigator | undefined = typeof navigator !== "undefined" ? navigator : undefined;
  const hasCredentials =
    !!nav &&
    typeof nav.credentials !== "undefined" &&
    typeof nav.credentials.create === "function" &&
    typeof nav.credentials.get === "function";
  const hasPublicKeyCredential = typeof PublicKeyCredential !== "undefined";
  return { hasCredentials, hasPublicKeyCredential };
}

// decodeDescriptors maps the engine's base64url allow/exclude credential descriptors to the
// PublicKeyCredentialDescriptor[] navigator.credentials wants: each id (base64url) becomes an ArrayBuffer,
// the "public-key" type passes through, and the advisory transports are forwarded when present (narrowed
// to the AuthenticatorTransport union the DOM type expects; an unknown token is dropped rather than
// rejected, so a forward-compatible transport hint never breaks the ceremony). A missing/empty list yields
// an empty array. A descriptor whose id is not valid base64url throws (the engine only ever emits valid
// base64url, so this is a corruption guard, surfaced as an honest error by the caller).
const KNOWN_TRANSPORTS: ReadonlyArray<AuthenticatorTransport> = ["usb", "nfc", "ble", "internal", "hybrid"];
// decodeWireB64Url is the ONE decode seam for every base64url byte field the engine's begin payload carries
// (the challenge, the user id, and each allow/exclude credential id). It is a pass-through of b64urlDecode with
// exactly one side effect.
//
// The fault it exists for: the engine only ever emits valid base64url, so a field that does not decode is a
// SERIALISATION REGRESSION in the begin payload. The throw escapes these pure builders, the sign-in screen's
// catch maps a throw with no HTTP status to its transport copy, and the operator is told THE ENGINE IS
// UNREACHABLE while the engine is perfectly healthy and answering. That message sends every subsequent step of
// the investigation in the wrong direction, and there was no evidence anywhere to contradict it. The row says
// a base64url id on the wire would not decode; the id itself is never read, never held and never recorded,
// because a corrupt id is exactly the value that cannot be trusted not to carry something.
function decodeWireB64Url(s: string): Uint8Array {
  try {
    return b64urlDecode(s);
  } catch (err) {
    recordWireAnomaly("b64url-id", "unparseable");
    throw err;
  }
}

function narrowTransports(raw: string[] | undefined): AuthenticatorTransport[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const out: AuthenticatorTransport[] = [];
  for (const t of raw) if ((KNOWN_TRANSPORTS as readonly string[]).includes(t)) out.push(t as AuthenticatorTransport);
  return out.length > 0 ? out : undefined;
}
function decodeDescriptors(
  list: ReadonlyArray<{ type: "public-key"; id: string; transports?: string[] }> | undefined,
): PublicKeyCredentialDescriptor[] {
  if (!list) return [];
  return list.map((d) => {
    const transports = narrowTransports(d.transports);
    const out: PublicKeyCredentialDescriptor = { type: "public-key", id: ab(decodeWireB64Url(d.id)) };
    return transports !== undefined ? { ...out, transports } : out;
  });
}

// creationOptionsFromBegin decodes the engine's register/begin publicKey (base64url byte fields) into the
// PublicKeyCredentialCreationOptions navigator.credentials.create wants. The challenge and the user.id are
// base64url -> ArrayBuffer; pubKeyCredParams / authenticatorSelection / timeout / attestation pass through;
// excludeCredentials is decoded by decodeDescriptors so an already-registered key cannot be enrolled twice.
// The authenticatorSelection string fields are narrowed to the DOM enums (only when present), and rp /
// user names pass through unchanged. PURE: no DOM, no navigator; the validator drives it directly.
export function creationOptionsFromBegin(o: PasskeyCreationOptions): PublicKeyCredentialCreationOptions {
  const sel = o.authenticatorSelection;
  const authenticatorSelection: AuthenticatorSelectionCriteria | undefined = sel
    ? {
        ...(sel.userVerification !== undefined ? { userVerification: sel.userVerification as UserVerificationRequirement } : {}),
        ...(sel.residentKey !== undefined ? { residentKey: sel.residentKey as ResidentKeyRequirement } : {}),
        ...(sel.authenticatorAttachment !== undefined ? { authenticatorAttachment: sel.authenticatorAttachment as AuthenticatorAttachment } : {}),
      }
    : undefined;
  return {
    rp: { id: o.rp.id, name: o.rp.name },
    user: { id: ab(decodeWireB64Url(o.user.id)), name: o.user.name, displayName: o.user.displayName },
    challenge: ab(decodeWireB64Url(o.challenge)),
    pubKeyCredParams: o.pubKeyCredParams.map((p) => ({ type: p.type, alg: p.alg })),
    ...(authenticatorSelection !== undefined ? { authenticatorSelection } : {}),
    ...(o.timeout !== undefined ? { timeout: o.timeout } : {}),
    ...(o.attestation !== undefined ? { attestation: o.attestation as AttestationConveyancePreference } : {}),
    excludeCredentials: decodeDescriptors(o.excludeCredentials),
  };
}

// requestOptionsFromBegin decodes the engine's login/begin publicKey (base64url byte fields) into the
// PublicKeyCredentialRequestOptions navigator.credentials.get wants. The challenge is base64url ->
// ArrayBuffer; rpId / userVerification / timeout pass through; allowCredentials is decoded by
// decodeDescriptors (empty for the usernameless resident-credential flow). PURE: no DOM, no navigator.
export function requestOptionsFromBegin(o: PasskeyRequestOptions): PublicKeyCredentialRequestOptions {
  return {
    challenge: ab(decodeWireB64Url(o.challenge)),
    rpId: o.rpId,
    ...(o.userVerification !== undefined ? { userVerification: o.userVerification as UserVerificationRequirement } : {}),
    ...(o.timeout !== undefined ? { timeout: o.timeout } : {}),
    allowCredentials: decodeDescriptors(o.allowCredentials),
  };
}

// The minimal structural shapes of the PublicKeyCredential a create()/get() resolves to, so the encoders
// below can be exercised by the validator with a plain fixture object (the real PublicKeyCredential is not
// constructable headless). They mirror exactly the bytes the engine's DO reads (rawId, and the
// response's clientDataJSON / attestationObject for register, clientDataJSON / authenticatorData /
// signature / userHandle for login).
export interface AttestationCredentialLike {
  rawId: ArrayBuffer;
  response: { clientDataJSON: ArrayBuffer; attestationObject: ArrayBuffer; getTransports?: () => string[] };
}
export interface AssertionCredentialLike {
  rawId: ArrayBuffer;
  response: { clientDataJSON: ArrayBuffer; authenticatorData: ArrayBuffer; signature: ArrayBuffer; userHandle: ArrayBuffer | null };
}

// attestationCredentialToWire encodes a create() result into the PasskeyAttestationCredential the
// register/finish POST carries: rawId -> base64url id (and rawId, for browser-JSON parity), the
// "public-key" type, and the attestation response with clientDataJSON + attestationObject as base64url and
// the advisory transports (when the browser reports getTransports()). PURE: it reads only the bytes, so it
// is identical under a real PublicKeyCredential and the validator's fixture.
export function attestationCredentialToWire(cred: AttestationCredentialLike): PasskeyAttestationCredential {
  const id = b64urlEncode(new Uint8Array(cred.rawId));
  const transports = typeof cred.response.getTransports === "function" ? cred.response.getTransports() : undefined;
  return {
    id,
    rawId: id,
    type: "public-key",
    response: {
      clientDataJSON: b64urlEncode(new Uint8Array(cred.response.clientDataJSON)),
      attestationObject: b64urlEncode(new Uint8Array(cred.response.attestationObject)),
      ...(transports !== undefined && transports.length > 0 ? { transports } : {}),
    },
  };
}

// assertionCredentialToWire encodes a get() result into the PasskeyAssertionCredential the login/finish
// POST carries: rawId -> base64url id (and rawId), the "public-key" type, and the assertion response with
// clientDataJSON + authenticatorData + signature as base64url and the userHandle when the authenticator
// returned one. PURE: bytes only, so it matches the real PublicKeyCredential and the validator's fixture.
export function assertionCredentialToWire(cred: AssertionCredentialLike): PasskeyAssertionCredential {
  const id = b64urlEncode(new Uint8Array(cred.rawId));
  const userHandle = cred.response.userHandle;
  return {
    id,
    rawId: id,
    type: "public-key",
    response: {
      clientDataJSON: b64urlEncode(new Uint8Array(cred.response.clientDataJSON)),
      authenticatorData: b64urlEncode(new Uint8Array(cred.response.authenticatorData)),
      signature: b64urlEncode(new Uint8Array(cred.response.signature)),
      ...(userHandle !== null && userHandle !== undefined ? { userHandle: b64urlEncode(new Uint8Array(userHandle)) } : {}),
    },
  };
}

// PasskeyReason mirrors the coarse engine finish/begin reasons (engine/src/admin/passkey.ts PasskeyReason)
// the console maps to copy. It is the closed set the engine returns in an { ok:false, reason } body.
export type PasskeyReason =
  | "bad_request"
  | "challenge"
  | "origin"
  | "rpid"
  | "user_present"
  | "signature"
  | "clone"
  | "unknown_credential"
  | "already_registered"
  | "forbidden"
  | string; // forward-compatible: an unrecognised reason maps to the generic copy

// reasonMessage maps an engine coarse finish/begin reason to honest, specific operator copy. Each line
// states what failed and the likely fix, without leaking which byte was malformed (the engine keeps the
// precise detail server-side behind an opaque error id). PURE and testable.
export function reasonMessage(reason: PasskeyReason, mode: "login" | "register"): string {
  switch (reason) {
    case "unknown_credential":
      return "That passkey is not registered with this engine. Use the passkey you set up here, or set up a new one.";
    case "already_registered":
      return "That passkey is already registered. Sign in with it instead of setting it up again.";
    case "challenge":
      return "The sign-in request expired before it completed. Please try again.";
    case "origin":
    case "rpid":
      return "This console's address does not match what the engine expects for passkeys. Check the engine's CONSOLE_ORIGIN setting matches the address in your browser.";
    case "signature":
      return "The passkey signature could not be verified. Please try again; if it persists, the passkey may need to be set up again.";
    case "clone":
      return "The engine rejected this passkey as a possible clone. Please try again with a different registered passkey.";
    case "user_present":
      return "The authenticator did not confirm your presence. Complete the prompt on your device (touch, biometric or PIN) and try again.";
    case "bad_request":
      return mode === "register"
        ? "The engine could not set up that passkey. Check the email and try again."
        : "The engine could not complete that sign-in. Please try again.";
    case "forbidden":
      // The engine refused an UNPROVEN enrolment (its registration gate): most commonly the first-Owner
      // bootstrap attempted without proof; also an invalid/expired invite, or an email that is not the
      // signed-in caller's own. Retrying cannot help, so ONE sentence names the real ways forward and
      // the banner itself carries the working "email the owner a set-up link" action (the most common
      // first-run mistake must not end in a text wall pointing at a disclosure).
      return mode === "register"
        ? "The engine refused to set up this passkey: a brand-new engine's first Owner is claimed with the emailed set-up link, and joining an existing engine needs an invite link from an Owner or an existing sign-in to add a passkey to your own email."
        : "The engine refused this sign-in. Sign in via Cloudflare Access or the admin token if your engine uses them, or use a recovery code.";
    default:
      return mode === "register"
        ? "Could not set up the passkey. Please try again."
        : "Could not sign in with the passkey. Please try again.";
  }
}

// passkeyErrorMessage maps a THROWN error from navigator.credentials (a DOMException) or the engine client
// to honest copy. The cases the operator most needs named: a user-cancelled or timed-out gesture
// (NotAllowedError), no usable authenticator (NotSupportedError / InvalidStateError), an insecure context
// (SecurityError), and the engine being unreachable (a fetch TypeError, no status). Anything else degrades
// to a calm generic line. Testable: it reads err.name to branch and logs err for diagnostics.
export function passkeyErrorMessage(err: unknown, mode: "login" | "register"): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError") {
    // The browser fires NotAllowedError for BOTH a deliberate cancel and a timeout; the copy covers both
    // without guessing which, and is not alarming (a cancel is a normal operator choice).
    return mode === "register"
      ? "Passkey setup was cancelled or timed out. You can try again when you are ready."
      : "Passkey sign-in was cancelled or timed out. You can try again when you are ready.";
  }
  if (name === "InvalidStateError") {
    return mode === "register"
      ? "A passkey for this account is already registered on this device. Sign in with it instead."
      : "This device could not use a registered passkey. Try another device or set one up.";
  }
  if (name === "NotSupportedError") {
    return "This device or browser cannot create the kind of passkey the engine requested.";
  }
  if (name === "SecurityError") {
    return "Passkeys require a secure (https) connection and a matching site address. Check you are on the console's https address.";
  }
  if (name === "AbortError") {
    return "The passkey request was interrupted. Please try again.";
  }
  // NO DOMException NAME, WHICH IS NOT THE SAME THING AS NOTHING ANSWERING. Everything that got here used
  // to take the reachability sentence below, and on this surface that is the sentence an operator quotes to
  // support: it sends them to the network, the tunnel and DNS. EIGHT of the nine states
  // this path can actually meet were already answered, and every one of them read as unreachable:
  //
  //   501  the engine's own passkey_not_configured, which is CONSOLE_ORIGIN unset and 501s EVERY ceremony
  //   429  the per-IP limiter on the unauthenticated sign-in routes (router-auth-flow.ts authRateLimited)
  //   404  an unknown /admin/auth sub-path, 500 the last-resort handler, and the console worker's own
  //        503 engine-binding-absent and 500 console-origin-fault, where the engine saw nothing at all
  //   a Cloudflare Access login page served where JSON was expected, and a 2xx whose body would not parse
  //
  // Not one of those is fixed by checking the network, and the console was holding the status that says so:
  // the engine client folds it into the throw, and classifyError already tells all nine apart. So ask
  // engineAnswered, and on an answer hand over errorDetail's REVIEWED sentence rather than write a tenth
  // account of the same failure here. That keeps this banner, a toast and a block error saying one thing
  // about one failure, and it is what makes the binding-absent and console-origin-fault cases honest: their
  // copy says the engine is not implicated, which no sentence written in this function could know.
  //
  // Same correction as errors.ts's malformed-2xx split and
  // onboarding/steps.ts's polling narration. Only `network`, a fetch that threw carrying no status, keeps
  // the line below, and it is still logged rather than rendered: a fetch TypeError's message can include
  // the engine's internal hostname.
  //
  // A DOMEXCEPTION IS THE BROWSER REFUSING THE CEREMONY, NOT THE ENGINE BEING UNREACHABLE, and the
  // engineAnswered split below cannot see the difference on its own. classifyError works on a thrown
  // message, and a browser's WebAuthn refusal carries no HTTP status because it never made a request.
  //
  // An account holding more than 64 credentials makes register/begin
  // emit an excludeCredentials list the browser will not accept, and Chromium throws
  // DOMException("...exceeds the maximum allowed size (64)") named `RangeError` before it consults an
  // authenticator. `RangeError` matches no branch above, engineAnswered says false, and the console told
  // the operator to go and check the engine was reachable. The engine had answered register/begin 200
  // moments earlier. That is the same error the named branches above already handle honestly; it simply
  // has a name nobody enumerated, and enumerating names one at a time is what produced this.
  //
  // So the test is the KIND of error, not its name: fetch rejects with a TypeError and never with a
  // DOMException, so a DOMException reaching here was thrown by the WebAuthn call itself. Naming it
  // "the browser" is honest about the one thing that IS known, and it does not pretend to a diagnosis
  // this function cannot make. The message is deliberately not rendered: a DOMException message can carry
  // the rp id and other deployment detail, so it is logged for the operator as every sibling here is.
  //
  // Only a non-DOMException error with no status keeps the reachability sentence, which is what that
  // sentence was written for. Same correction as the engineAnswered split itself, one layer in.
  //
  // AND IT IS ASKED BEFORE engineAnswered, WHICH IS A REPAIR OF WHERE IT SAT. This branch was added below
  // the engineAnswered split and was briefly correct there, because
  // classifyError's fall-through then returned `network` for any message carrying no status, so
  // engineAnswered answered false for a DOMException and execution reached here. A later fix
  // split that fall-through: only a message matching a browser's own fetch-failure wording stays `network`
  // and everything else becomes `console-fault`. A WebAuthn DOMException matches no such wording, so
  // engineAnswered flipped to TRUE for it and this branch became unreachable for every DOMException there
  // is. The defect came straight back, in a worse form: the operator now reads errorDetail's
  // console-fault sentence, which splices the DOMException's own message, and that message can carry the
  // rp id and other deployment detail these branches exist to keep off the screen.
  //
  // Asking it FIRST is not a workaround for that split, it is the right order on the split's own reasoning:
  // engineAnswered is a question about a THROWN MESSAGE, and a DOMException here was never a response at
  // all. Nothing that classifyError can recognise is lost, because a DOMException carries no HTTP status
  // and no console-worker token for it to recognise.
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    console.error("passkey ceremony refused by the browser", err);
    return mode === "register"
      ? "Your browser refused to set up the passkey. The engine was reached and answered; this failed in the browser. Try another browser or device, and quote this page to support if it repeats."
      : "Your browser refused the passkey sign-in. The engine was reached and answered; this failed in the browser. Try another browser or device, or use a recovery code.";
  }
  if (engineAnswered(err)) {
    console.error("passkey ceremony refused", err);
    return errorDetail(err);
  }
  console.error("passkey transport error", err);
  return `Could not reach the engine to ${mode === "register" ? "set up" : "sign in with"} a passkey. Check the engine is reachable, then try again.`;
}

// isBrowserCeremonyRefusal answers one question about a thrown error: did the BROWSER refuse the WebAuthn
// call itself, as opposed to the platform reporting that nothing answered, or a fetch failing?
//
// THE ORDERING IS THE WHOLE POINT, and it is the lesson passkeyErrorMessage above had to learn twice.
// Enumerating the refusal names one at a time is what let `RangeError` be reported as an unreachable
// engine, so this does the opposite: it names only the errors that mean THE PERSON OR PLATFORM DECLINED,
// and treats every OTHER DOMException as the browser refusing. A refusal nobody has met yet then lands on
// copy that is honest about what is known rather than on copy written for a different failure.
//
//   NotAllowedError -- a dismissed prompt, a timeout, or no matching credential. WebAuthn merges these
//                      deliberately so a site cannot enumerate whether a passkey exists, and splitting
//                      them here would be guessing.
//   AbortError      -- the request was interrupted, e.g. the page navigated or a signal aborted.
//
// A fetch rejects with a TypeError and never with a DOMException, so a DOMException reaching a ceremony's
// catch was thrown by the WebAuthn call. That is the one thing this can know, and it is what it claims.
export function isBrowserCeremonyRefusal(err: unknown): boolean {
  if (typeof DOMException === "undefined" || !(err instanceof DOMException)) return false;
  return err.name !== "NotAllowedError" && err.name !== "AbortError";
}

// recoveryTransportMessage maps a NON-401 thrown error from the recovery sign-in (a transport fault: the
// engine unreachable, an Access-redirect body) to honest, calm copy. A 401 is handled separately as the
// generic no-oracle line; this is the "could not reach the engine" case. The error is logged for
// the operator. Kept distinct from the 401 path so the no-oracle line is never diluted with a status.
export function recoveryTransportMessage(err: unknown): string {
  // THE SAME SPLIT AS passkeyErrorMessage, and it matters MORE here, not less. runRecovery gates on the 401
  // above and hands EVERYTHING else to this function, so the engine's hard per-IP-and-per-email recovery
  // limiter, its 501 with CONSOLE_ORIGIN unset, an Access page and the console worker's own binding-absent
  // 503 all arrived reading as an unreachable engine. This is the break-glass path: the operator is here
  // BECAUSE the ordinary way in stopped working, and telling them at that moment to go and check the engine
  // is reachable is the worst possible minute to send them somewhere there is nothing to find.
  //
  // The 401 stays where it is and is untouched: it is answered ABOVE this call, deliberately, so the
  // engine's no-oracle generic line is never diluted with a status.
  if (engineAnswered(err)) {
    console.error("recovery sign-in refused", err);
    return errorDetail(err);
  }
  // A fetch TypeError's message can include the engine's internal hostname; log it for the
  // operator rather than rendering it on screen.
  console.error("recovery transport error", err);
  return "Could not reach the engine to sign in with a recovery code. Check the engine is reachable, then try again.";
}

// ---- inline result banners --------------------------------------------------

// errorBanner / successBanner build the inline result node (the screen's one status surface). They are
// thin wrappers over the feedback banner so the flows return a node the screen mounts. Channel-one inline,
// never a toast (a sign-in failure is an expected, recoverable outcome).
export function errorBanner(message: string): HTMLElement {
  return banner({ tone: "warn", message });
}
export function successBanner(message: string): HTMLElement {
  return banner({ tone: "info", message });
}

// registerFailureBanner renders a register-ceremony refusal. Every reason gets the honest copy from
// reasonMessage; the "forbidden" refusal (an unproven enrolment, most commonly the first-Owner bootstrap
// attempted before the email link) additionally carries the one step that can actually resolve it as a
// REAL banner action, so the operator gets a working control instead of prose pointing at a disclosure.
export function registerFailureBanner(reason: PasskeyReason, onEmailOwner?: () => void): HTMLElement {
  const message = reasonMessage(reason, "register");
  if (reason !== "forbidden" || !onEmailOwner) return errorBanner(message);
  return banner({ tone: "warn", message, action: { label: "Email the owner a set-up link", onClick: onEmailOwner } });
}

// ---- small local helpers ------------------------------------------------------------------------

// isEmailish is a light client-side shape check (a single @, something either side, a dot in the domain).
// It is NOT the validator; the engine normalises + decides. It only catches an obvious typo before a round
// trip so the operator gets an instant inline hint.
export function isEmailish(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

// The one-shot email handoff from the recovery sign-in to the /register enrolment landing
// it routes to: module-level (the navigation re-renders the screen), consumed exactly once,
// never persisted (no email in the URL, no storage write).
let registerPrefillEmail: string | null = null;
export function setRegisterPrefillEmail(email: string): void {
  registerPrefillEmail = email !== "" ? email : null;
}
export function takeRegisterPrefillEmail(): string | null {
  const v = registerPrefillEmail;
  registerPrefillEmail = null;
  return v;
}

// authKnownHere is the presentation-only "this browser has signed in before" hint
// (localStorage): it warms the heading and quietens the help trigger. Never an
// authority signal; absence simply shows the fuller first-contact framing.
const AUTH_KNOWN_KEY = "dp-auth-known";
export function authKnownHere(): boolean {
  try {
    return localStorage.getItem(AUTH_KNOWN_KEY) === "1";
  } catch {
    return false;
  }
}
export function markAuthKnownHere(): void {
  try {
    localStorage.setItem(AUTH_KNOWN_KEY, "1");
  } catch {
    // Best-effort presentation hint only.
  }
}

// downloadText delivers the RECOVERY CODES to the operator's disk through the guarded primitive, and returns
// whether the browser accepted the delivery.
//
// WHAT IT USED TO DO, AND WHY THAT WAS THE WORST BUG ON THE LIST. It opened with a capability guard that
// RETURNED SILENTLY when URL/createObjectURL/Blob were missing, and then called createObjectURL and a.click()
// UNGUARDED, so a browser that HAD the APIs but refused the click threw straight out of the click handler.
// Either way the customer pressed "Download .txt" on the one-time recovery codes, nothing arrived, the panel
// said nothing, and no trace of it existed anywhere. If they then lost their passkey they were locked out of
// their engine permanently. A missing capability and a refused one are now the SAME answer, false, and both
// are recorded in the ring that rides inside the support pack.
export function downloadText(name: string, content: string): boolean {
  return deliverFile(name, content, "text/plain", "recovery-codes");
}

// DOMExceptionLike lets the flows synthesise a NotAllowedError-shaped value for the null-credential case
// without depending on the DOMException constructor (not always present headless). passkeyErrorMessage
// reads only .name / .message, so this is sufficient and keeps the null-result path on the same honest
// "cancelled or timed out" copy as a real cancel.
export class DOMExceptionLike extends Error {
  constructor(name: string) {
    super(name);
    this.name = name;
  }
}
