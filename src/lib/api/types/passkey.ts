// Passkey (WebAuthn) sign-in wire mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

import type { Role } from "../../identity.ts";

// Passkey (WebAuthn) sign-in wire shapes.
// These mirror the engine's /admin/auth/* JSON (engine/src/admin/router.ts handlePasskey, which
// forwards to engine/src/sched/scheduler-do.ts passkeyRegisterBegin / passkeyLoginBegin / *Finish)
// byte-for-byte so the two sides cannot drift. The BYTE fields inside publicKey are base64url strings
// the engine emitted (the challenge, the user.id handle, every allowCredentials[].id /
// excludeCredentials[].id); the passkey screen decodes them to the ArrayBuffers navigator.credentials
// wants, and encodes the returned credential's bytes back to base64url for the finish. No secret is in
// any of these: a public key, an opaque challenge, an opaque user handle, and the verified email only.

// PasskeyPubKeyCredDescriptor is one allow/exclude credential descriptor as the engine emits it: the
// "public-key" type, the base64url credential id, and optional advisory transport hints. The screen maps
// id (base64url) -> ArrayBuffer for the navigator.credentials allow/exclude list.
export interface PasskeyPubKeyCredDescriptor {
  type: "public-key";
  id: string; // base64url(raw credential id)
  transports?: string[];
}

// PasskeyAuthenticatorSelection mirrors the WebAuthn AuthenticatorSelectionCriteria the engine forwards in
// the creation options. All three fields are advisory hints (userVerification, residentKey,
// authenticatorAttachment) passed through unchanged to navigator.credentials.create.
export interface PasskeyAuthenticatorSelection {
  userVerification?: string;
  residentKey?: string;
  authenticatorAttachment?: string;
}

// PasskeyCreationOptions is the engine's creation options (navigator.credentials.create) with the byte
// fields as base64url. challenge and user.id are base64url; pubKeyCredParams/authenticatorSelection/
// timeout/attestation pass through unchanged. excludeCredentials lists the email's already-registered ids.
export interface PasskeyCreationOptions {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string }; // user.id is base64url(opaque handle)
  challenge: string; // base64url(32 random bytes)
  pubKeyCredParams: ReadonlyArray<{ type: "public-key"; alg: number }>;
  authenticatorSelection?: PasskeyAuthenticatorSelection;
  timeout?: number;
  attestation?: string;
  excludeCredentials?: PasskeyPubKeyCredDescriptor[];
}

// PasskeyRequestOptions is the engine's request options (navigator.credentials.get) with the byte fields
// as base64url. challenge is base64url; allowCredentials scopes the get to the email's keys (empty for the
// usernameless resident-credential flow).
export interface PasskeyRequestOptions {
  challenge: string; // base64url(32 random bytes)
  rpId: string;
  userVerification?: string;
  timeout?: number;
  allowCredentials?: PasskeyPubKeyCredDescriptor[];
}

// PasskeyRegisterBegin / PasskeyLoginBegin are the begin responses. ok:true carries the options (plus, for
// login, the challengeId the finish must echo back); ok:false carries a coarse reason and an optional
// opaque error id. The screen narrows on ok before touching publicKey.
export type PasskeyRegisterBegin =
  | { ok: true; publicKey: PasskeyCreationOptions; challengeScope: string }
  | { ok: false; reason: string; errorId?: string };
export type PasskeyLoginBegin =
  | { ok: true; publicKey: PasskeyRequestOptions; challengeId: string }
  | { ok: false; reason: string; errorId?: string };

// PasskeyAttestationCredential is what the screen POSTs to register/finish: the credential id (base64url),
// the type, and the attestation response with clientDataJSON + attestationObject as base64url and the
// advisory transports. It mirrors the fields the DO reads (cred.id, cred.response.{clientDataJSON,
// attestationObject,transports}); rawId is included for parity with the browser PublicKeyCredential JSON.
// PasskeyAttestationResponse is the attestation response shape inside PasskeyAttestationCredential:
// clientDataJSON + attestationObject as base64url plus the advisory transport hints. Named so callers can
// reference the WebAuthn protocol shape independently.
export interface PasskeyAttestationResponse {
  clientDataJSON: string; // base64url
  attestationObject: string; // base64url
  transports?: string[];
}
export interface PasskeyAttestationCredential {
  id: string; // base64url(rawId)
  rawId: string; // base64url(rawId), same value (browser JSON parity)
  type: "public-key";
  response: PasskeyAttestationResponse;
}

// PasskeyAssertionCredential is what the screen POSTs to login/finish: the credential id (base64url), the
// type, and the assertion response with clientDataJSON + authenticatorData + signature as base64url and the
// optional userHandle. It mirrors the fields the DO reads (cred.id, cred.response.{clientDataJSON,
// authenticatorData,signature}); userHandle is carried for completeness though the DO resolves the email
// from the stored credential record.
// PasskeyAssertionResponse is the assertion response shape inside PasskeyAssertionCredential:
// clientDataJSON + authenticatorData + signature as base64url plus the optional userHandle. Named so callers
// can reference the WebAuthn protocol shape independently.
export interface PasskeyAssertionResponse {
  clientDataJSON: string; // base64url
  authenticatorData: string; // base64url
  signature: string; // base64url
  userHandle?: string; // base64url, present only when the authenticator returned one
}
export interface PasskeyAssertionCredential {
  id: string; // base64url(rawId)
  rawId: string; // base64url(rawId)
  type: "public-key";
  response: PasskeyAssertionResponse;
}

// PasskeyCredentialSummary is one row of the enrolled-passkey inventory (GET /admin/passkey/credentials),
// mirrored byte-for-byte from the engine's redacted view (engine/src/sched/scheduler-do.ts
// listPasskeyCredentials). It is REDACTION-SAFE by construction: credentialId is the base64url credential
// id (an opaque public handle, never key material); createdAt is RFC-3339; aaguid is the base64url
// authenticator model id (which device family minted the key, never a secret); transports are the advisory
// transport hints ("internal", "usb", "nfc", "ble", "hybrid"); alg is the COSE signature algorithm id (a
// negative integer, e.g. -7 for ES256, -8 for Ed25519). No private key, no public key, no secret. The
// console escapes every string on render (h() does this) and shows alg/aaguid as coarse labels.
export interface PasskeyCredentialSummary {
  credentialId: string;
  createdAt: string;
  aaguid: string;
  transports: string[];
  alg: number;
}

// PasskeyFinish is the shared finish-verdict shape for BOTH login/finish and register/finish. ok:true
// carries the verified email the WebAuthn ceremony proved (the engine has set the session cookie by now);
// register/finish additionally carries bootstrapped + role (the first registrant becomes Owner), AND
// recoveryCodes: the 10 single-use break-glass codes the engine issues on a SUCCESSFUL enrolment, returned
// ONCE here and never re-fetchable. The screen shows them in a one-time panel (save-offline framing + a
// save-confirm) on enrolment; they are absent on a login/finish (login never issues codes) and on a
// re-enrolment where the engine chose not to re-issue. ok:false carries a coarse reason (challenge /
// origin / signature / unknown_credential / already_registered / bad_request) and an optional opaque error
// id. The screen narrows on ok. No secret beyond those one-time codes transits.
//
// recoveryCodesPending (STAGED-RECOVERY-CODES-CONFIRM-GATE): true when recoveryCodes were minted
// as a STAGED set, not yet live -- an enrolment that ran while the email already held a working set (a
// self-add; the forced re-enrolment after a recovery-code sign-in is the common case). The OLD set keeps
// signing the operator in until the console calls confirmRecoveryCodes(): that is what the save-confirm
// panel's "Continue" must do before it hands control back, or an abandoned/crashed enrolment would show
// codes that never actually took effect while quietly leaving the old ones live (harmless) or -- the bug
// this exists to close -- an immediate mint would have killed the old ones on the spot, before the operator
// had a chance to save the new ones. Absent or false means the mint already went live (bootstrap, invite,
// or an older engine that predates this field): nothing further to confirm.
export type PasskeyFinish =
  | { ok: true; email: string; bootstrapped?: boolean; role?: Role; recoveryCodes?: string[]; recoveryCodesPending?: boolean }
  | { ok: false; reason: string; errorId?: string };

// RecoveryFinish is the POST /admin/auth/recovery verdict. The engine answers a GENERIC 401 on ANY failure
// (so this shape only ever models the SUCCESS body; a failure throws via parseJson and surfaces as the
// generic "could not sign in" copy, with NO oracle distinguishing the cause). On success the session cookie
// is set, role is the caller's resolved role, and enrolPasskey:true asks the console to immediately route
// the operator to enrol a fresh passkey (a recovery sign-in is a "lost authenticator" path, so a new
// passkey should be set up straight away). No secret transits.
export interface RecoveryFinish {
  role: Role;
  enrolPasskey: boolean;
}

// RecoveryCodesResult is the POST /admin/auth/recovery-codes/regenerate body: a fresh set of single-use
// recovery codes for the caller's own email, returned ONCE. Regenerating INVALIDATES every prior code. The
// console shows recoveryCodes in the same one-time panel as enrolment. The codes are the only payload and
// are never re-fetchable.
export interface RecoveryCodesResult {
  recoveryCodes: string[];
}

// ConfirmStagedRecoveryCodes is the POST /admin/auth/recovery-codes/confirm body (STAGED-RECOVERY-CODES-
// CONFIRM-GATE): promoted:true means a staged set just went live (the old one is now dead);
// promoted:false is a harmless no-op (nothing was staged for this email -- already confirmed, none was
// ever staged, or a later enrolment's staged set has superseded it). No codes ride here; they were already
// shown once by the enrolment that staged them.
export interface ConfirmStagedRecoveryCodes {
  promoted: boolean;
}
