// Recovery-code domain functions for the EngineClient (split from client.ts per findings
// console-src-010-01 / console-sys-arch-01 / console-sys-struct-03). Free functions over the shared
// Transport; request URL/method/body/headers and parse logic moved VERBATIM.
//
// When a passkey is enrolled the engine ALSO issues 10 single-use recovery codes (returned ONCE on
// register/finish, see PasskeyFinish.recoveryCodes). They are the offline fallback for "I lost my
// authenticator": a code signs you in WITHOUT a passkey, after which you enrol a fresh one. The engine is
// the authority on every step; the console only relays.

import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type { ConfirmStagedRecoveryCodes, RecoveryCodesResult, RecoveryFinish } from "./types.ts";

// recoverWithCode IS the sign-in (it is dispatched BEFORE auth on the engine, exactly like the passkey
// login/finish), so it carries NO bearer and NO role; credentials:"include" is essential because a
// successful recovery SETS the __Host- session cookie. The engine answers a GENERIC 401 on ANY failure
// (wrong email, unknown/spent code, rate limit) so there is no oracle that distinguishes "no such email"
// from "wrong code"; on success it returns { role, enrolPasskey } and the console immediately routes the
// operator to enrol a new passkey when enrolPasskey is true. A non-2xx (the 401) routes through
// failResponse so an Access-redirect body is still named honestly; the 401 itself surfaces as the generic
// "could not sign in" copy (isUnauthorised). No secret transits: the code is a single-use string the
// engine minted, consumed server-side.
export async function recoverWithCode(t: Transport, email: string, code: string): Promise<RecoveryFinish> {
  const r = await engineFetch(`${t.base}/admin/auth/recovery`, { method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ email, code }) });
  return t.parseJson<RecoveryFinish>(r, "recovery sign-in");
}

// regenerateRecoveryCodes mints a FRESH set of single-use recovery codes for the CALLER'S OWN email
// (the engine reads the verified identity from the session; there is no email parameter, so a caller can
// never regenerate someone else's codes). It is AUTHENTICATED (rides the session cookie / bearer) and
// returns the new codes ONCE; generating a fresh set INVALIDATES every prior code, so the console shows
// the new set in the same one-time panel as enrolment and warns that the old codes have stopped working.
// No secret beyond the freshly-minted codes (shown once, never re-fetchable) transits.
export async function regenerateRecoveryCodes(t: Transport): Promise<RecoveryCodesResult> {
  const r = await t.gatedFetch("/admin/auth/recovery-codes/regenerate", { method: "POST", headers: t.headers(), credentials: "include" }, { adminOp: "recovery-codes-regenerate" });
  return t.parseJson<RecoveryCodesResult>(r, "regenerate recovery codes");
}

// confirmRecoveryCodes (STAGED-RECOVERY-CODES-CONFIRM-GATE) promotes a STAGED recovery-code set
// to live: it is what the save-confirm panel's "Continue" must call, for an enrolment whose finish answered
// recoveryCodesPending:true, before it hands control back to the caller. Until this call the OLD set the
// operator held before the enrolment keeps signing them in; a page that closes or a request that fails
// before this fires simply leaves the old set live, which is the safe outcome. A confirm for an email with
// nothing staged answers promoted:false and is not an error (the operator is already signed in and their
// live set is already correct either way).
//
// PLAIN engineFetch, not t.gatedFetch: the engine's own handleConfirmStaged never answers 401
// stepUpRequired for this route (router-auth-flow.ts's handleConfirmStaged doc comment states it plainly --
// confirm mints nothing new and only finalises a ceremony the operator already cleared to reach the
// save-confirm panel). Wrapping a call in the step-up ceremony when the server can never ask for one is
// dead code that also misclassifies the write for the console's own stepup-announce gate, which exists to
// make sure every route that COULD show a passkey prompt is announced as such; this route cannot.
export async function confirmRecoveryCodes(t: Transport): Promise<ConfirmStagedRecoveryCodes> {
  const r = await engineFetch(`${t.base}/admin/auth/recovery-codes/confirm`, { method: "POST", headers: t.headers(), credentials: "include" }, { adminOp: "recovery-codes-confirm" });
  return t.parseJson<ConfirmStagedRecoveryCodes>(r, "confirm recovery codes");
}
