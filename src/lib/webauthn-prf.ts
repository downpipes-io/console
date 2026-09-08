// OPTIONAL security-key (YubiKey) second factor for the offline break-glass custody
// experience (ENTERPRISE-UX-BLUEPRINT section 7.2-7.3). A single YubiKey 5 CANNOT store
// the 96-byte break-glass private (x25519 scalar(32) || ML-KEM seed(64),
// src/keygen.ts:17) as a PIV/OpenPGP key object at all, because no shipping YubiKey
// supports ML-KEM on-device, so the honest hardware role is as a
// SECOND FACTOR that derives a wrapping key: the WebAuthn PRF extension (CTAP2
// hmac-secret) returns a 32-byte secret computed on-device from a fixed salt, and we use
// that (directly or via HKDF) as the AES-256-GCM wrapping key for the envelope
// (src/envelope.ts). The key file is then useless without both the ciphertext AND a
// registered security key.
//
// IMPORTANT, surfaced to the operator by the ceremony copy: the PRF output is
// device-specific and non-exportable. Enrol AT LEAST TWO security keys at setup, because
// if the single enrolled key is lost the wrapping key it derived can never be reproduced
// and the wrapped break-glass file becomes unrecoverable. See enrolmentGuidance().
//
// NO-CUSTODY: the PRF secret, the derived wrapping key and the credential id never leave
// the browser by network. They are produced on the security key and in this browser, and
// only ever used locally to wrap/unwrap the key file the operator keeps. There is no
// engine binding and no API for any of this material. The functions that touch the
// WebAuthn API are feature-detected and degrade cleanly (no throw on an unsupported
// browser); only the pure helpers (HKDF, feature-detect decision, salt construction) are
// exercised by the validator, since the WebAuthn API itself is not available headless.

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ab } from "../bytes.ts";
import { WRAPPING_KEY_BYTES } from "./envelope.ts";

// PRF_SALT is a fixed, product-specific salt fed to the security key's PRF. The same salt
// against the same enrolled credential always yields the same 32-byte secret, which is
// what lets the operator reproduce the wrapping key on a later unwrap. It is a domain
// label, not a secret; it just has to be stable. (A per-tenant salt would change the
// derived secret, so we keep it constant across the product.)
export const PRF_SALT = new TextEncoder().encode("downpipes:break-glass:wrapping-key:v1");

// HKDF_INFO binds the derived key to its purpose, so the same PRF secret could in
// principle derive other independent keys under different info labels without collision.
export const HKDF_INFO = new TextEncoder().encode("downpipes break-glass envelope wrapping key");

// WEBAUTHN_TIMEOUT_MS bounds each WebAuthn ceremony (create and get). Two minutes gives the
// operator time to locate and tap a roaming security key without leaving the prompt open
// indefinitely. Shared by both call sites so they stay in lockstep.
const WEBAUTHN_TIMEOUT_MS = 2 * 60 * 1000;

// PRFSupport is the feature-detection decision: whether the WebAuthn PRF path can even be
// attempted in this environment. We keep it a small explicit record so the console can
// render the right copy (offer the YubiKey step, or hide it and recommend Tier 1/2 only).
export interface PRFSupport {
  // platformAuthenticatorApi: navigator.credentials with PublicKeyCredential exists at all.
  webauthnApi: boolean;
  // securityKeySuitable: the API exists AND we are in a secure context (PRF needs HTTPS).
  // The actual per-authenticator PRF capability can only be confirmed by an enrolment
  // attempt that reports prf.enabled === true, so this is "worth attempting", not "works".
  worthAttempting: boolean;
}

// Minimal structural shape of the global pieces we feature-detect, so detectPRFSupport can
// be unit-tested by passing a mock instead of relying on a real browser global.
export interface WebAuthnGlobals {
  hasCredentials: boolean; // typeof navigator.credentials?.create === "function" && .get
  hasPublicKeyCredential: boolean; // typeof PublicKeyCredential !== "undefined"
  isSecureContext: boolean; // window.isSecureContext (HTTPS or localhost)
}

// detectPRFSupport is a PURE decision over the provided globals snapshot. Pass
// readWebAuthnGlobals() in the browser; pass a fixture in tests. It never touches a real
// global itself, so it is deterministic and testable.
export function detectPRFSupport(g: WebAuthnGlobals): PRFSupport {
  const webauthnApi = g.hasCredentials && g.hasPublicKeyCredential;
  // PRF (hmac-secret) requires a secure context. Without one, do not even offer the path.
  const worthAttempting = webauthnApi && g.isSecureContext;
  return { webauthnApi, worthAttempting };
}

// readWebAuthnGlobals snapshots the real browser globals into the testable shape. This is
// the only impure part of detection; it is trivially guarded so it never throws on a
// non-browser runtime (e.g. the validator under Node), returning the all-false snapshot.
export function readWebAuthnGlobals(): WebAuthnGlobals {
  const nav: Navigator | undefined = typeof navigator !== "undefined" ? navigator : undefined;
  const hasCredentials =
    !!nav &&
    typeof nav.credentials !== "undefined" &&
    typeof nav.credentials.create === "function" &&
    typeof nav.credentials.get === "function";
  const hasPublicKeyCredential = typeof PublicKeyCredential !== "undefined";
  const isSecureContext = typeof globalThis.isSecureContext === "boolean" ? globalThis.isSecureContext : false;
  return { hasCredentials, hasPublicKeyCredential, isSecureContext };
}

// deriveWrappingKey turns the 32-byte security-key PRF secret into the 32-byte AES-256
// wrapping key via HKDF-SHA-256 (extract-and-expand), binding it to PRF_SALT and
// HKDF_INFO. This is a PURE function and is the core of the validator: same PRF secret in,
// same wrapping key out; different secret, different key. HKDF here is belt-and-braces (the
// PRF output is already a uniformly random 32 bytes), but it gives clean domain separation
// and a fixed 32-byte length regardless of the authenticator's PRF output size.
export function deriveWrappingKey(prfSecret: Uint8Array): Uint8Array {
  if (prfSecret.length === 0) {
    throw new Error("deriveWrappingKey: PRF secret must be non-empty");
  }
  // hkdf(hash, ikm, salt, info, length)
  return hkdf(sha256, prfSecret, PRF_SALT, HKDF_INFO, WRAPPING_KEY_BYTES);
}

// prfInputs builds the WebAuthn extension input that requests the PRF evaluation at our
// fixed salt. Pure and testable: it returns the exact extension object passed to
// navigator.credentials. Both create-time and get-time use the same `eval.first` salt so
// the secret is reproducible.
export function prfInputs(): AuthenticationExtensionsClientInputs {
  return { prf: { eval: { first: ab(PRF_SALT) } } };
}

// extractPRFSecret pulls the 32-byte first result out of a WebAuthn clientExtensionResults
// object, or returns null if the authenticator did not produce one (PRF unsupported by
// that key, or not evaluated). Pure and testable with a fixture. We normalise the
// BufferSource (ArrayBuffer or a typed-array view) to a Uint8Array.
export function extractPRFSecret(ext: AuthenticationExtensionsClientOutputs | undefined): Uint8Array | null {
  const first = ext?.prf?.results?.first;
  if (!first) return null;
  if (first instanceof ArrayBuffer) return new Uint8Array(first);
  // Otherwise it is an ArrayBufferView (e.g. Uint8Array/DataView); copy out its bytes.
  const view = first as ArrayBufferView;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

// prfEnabledAtCreation reports whether a freshly-created credential's extension results say
// PRF is available on that authenticator (clientExtensionResults.prf.enabled). At creation
// time most authenticators report `enabled` rather than a usable result; the wrapping key
// is then obtained by a subsequent get() (deriveWrappingKeyFromAssertion). Pure helper.
export function prfEnabledAtCreation(ext: AuthenticationExtensionsClientOutputs | undefined): boolean {
  return ext?.prf?.enabled === true;
}

// PRFEnrolResult is what enrolSecurityKey returns: the new credential id (to store so the
// operator's later unwrap targets the right key) and whether PRF is reported available.
export interface PRFEnrolResult {
  credentialId: Uint8Array; // raw credential id; store it (it is not secret) to scope later get()s
  prfEnabled: boolean; // authenticator reported PRF support at creation
}

// enrolSecurityKey creates a discoverable credential on a security key with the PRF
// extension requested. It is BROWSER-API-GATED: it returns null (never throws) when the
// WebAuthn PRF path is not worth attempting, so the caller degrades cleanly to Tier 1/2.
// The relying-party id and user handle are supplied by the caller (the console knows its
// own origin and the operator's identity). No material is transmitted; the credential and
// any PRF state live on the key and in the browser.
export async function enrolSecurityKey(opts: {
  rpId: string;
  rpName: string;
  userId: Uint8Array;
  userName: string;
  userDisplayName: string;
  challenge: Uint8Array; // a fresh random challenge from the caller (replay hygiene)
}): Promise<PRFEnrolResult | null> {
  if (!detectPRFSupport(readWebAuthnGlobals()).worthAttempting) return null;

  const publicKey: PublicKeyCredentialCreationOptions = {
    rp: { id: opts.rpId, name: opts.rpName },
    user: { id: ab(opts.userId), name: opts.userName, displayName: opts.userDisplayName },
    challenge: ab(opts.challenge),
    // ES256 (-7) then RS256 (-257); both are widely supported by security keys.
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    authenticatorSelection: {
      // Cross-platform = a roaming security key (YubiKey), not the platform authenticator.
      authenticatorAttachment: "cross-platform",
      residentKey: "required",
      // Required (not preferred): this enrols a second factor for break-glass key wrapping, a
      // high-privilege path, so a key with no PIN/biometric user-verification is unsuitable and
      // should be rejected at enrolment rather than silently accepted without a UV step.
      userVerification: "required",
    },
    timeout: WEBAUTHN_TIMEOUT_MS,
    attestation: "none",
    extensions: prfInputs(),
  };

  // CONTRACT: this function is documented BROWSER-API-GATED -- it returns null and NEVER throws, and every
  // caller degrades to Tier 1/2 on a null. navigator.credentials.create() REJECTS on the ordinary endings (the
  // operator cancels the prompt, the key is not tapped inside the timeout, the authenticator refuses user
  // verification, the browser blocks the ceremony outside a secure context), so an uncaught rejection here
  // BROKE that contract: the caller never saw a null, its await threw instead, and the break-glass enrolment
  // died as an unhandled rejection with the ceremony half-finished on screen. The failure is turned back into
  // the null the contract promises. Nothing about the error is read: not its message, not its name.
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  } catch {
    return null;
  }
  if (!cred) return null;
  const ext = cred.getClientExtensionResults();
  return { credentialId: new Uint8Array(cred.rawId), prfEnabled: prfEnabledAtCreation(ext) };
}

// deriveWrappingKeyFromAssertion performs a WebAuthn get() against one or more enrolled
// credential ids, requesting the PRF evaluation at the fixed salt, and returns the derived
// 32-byte wrapping key. BROWSER-API-GATED: returns null (never throws) when the path is
// unavailable or when the authenticator produced no PRF result, so the caller can fall
// back. allowCredentialIds scopes the get() to the operator's enrolled keys.
export async function deriveWrappingKeyFromAssertion(opts: {
  rpId: string;
  challenge: Uint8Array;
  allowCredentialIds: Uint8Array[];
}): Promise<Uint8Array | null> {
  if (!detectPRFSupport(readWebAuthnGlobals()).worthAttempting) return null;

  const publicKey: PublicKeyCredentialRequestOptions = {
    rpId: opts.rpId,
    challenge: ab(opts.challenge),
    allowCredentials: opts.allowCredentialIds.map((id) => ({ type: "public-key" as const, id: ab(id) })),
    // Required to match enrolment: deriving the wrapping key from an assertion is the high-privilege
    // break-glass path, so a user-verification step (PIN/biometric) is enforced, not merely preferred.
    userVerification: "required",
    timeout: WEBAUTHN_TIMEOUT_MS,
    extensions: prfInputs(),
  };

  // The same contract, and the same break. A cancelled tap, a key that is
  // never presented, or a failed user-verification step all REJECT here, and this function promises a null.
  let assertion: PublicKeyCredential | null;
  try {
    assertion = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  } catch {
    return null;
  }
  if (!assertion) return null;
  const secret = extractPRFSecret(assertion.getClientExtensionResults());
  if (!secret) return null;
  return deriveWrappingKey(secret);
}

// enrolmentGuidance is the copy the ceremony surfaces next to the YubiKey option. It states
// the non-exportable, device-specific reality and the >=2-keys requirement plainly, in
// Australian English, without overstating what a security key can do.
export function enrolmentGuidance(): string {
  return (
    "A security key derives a wrapping key on the device; it does not store the break-glass key. " +
    "The derived secret is non-exportable and specific to the key, so enrol at least two security keys. " +
    "If the only enrolled key is lost, the wrapping key it derived cannot be reproduced and the wrapped " +
    "break-glass file cannot be recovered."
  );
}
