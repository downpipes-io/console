// Passkey (WebAuthn) sign-in + step-up re-auth domain functions for the EngineClient. Free functions over
// the shared Transport.
//
// The engine exposes /admin/auth/* (engine/src/admin/router.ts handlePasskey) as the free, self-contained
// multi-user sign-in that does NOT need Cloudflare Access (which is not free over 50 users). These methods
// are THIN transport: they POST the begin/finish bodies and return the engine's JSON verbatim; the WebAuthn
// ceremony itself (decode the options, call navigator.credentials, encode the credential) lives in the
// passkey screen, so api.ts stays a pure client and never touches navigator (the same discipline that keeps
// it DOM-free and testable under node).

import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type {
  PasskeyAssertionCredential,
  PasskeyAttestationCredential,
  PasskeyFinish,
  PasskeyLoginBegin,
  PasskeyRegisterBegin,
} from "./types.ts";

// stepUpBegin/stepUpFinish drive the step-up re-auth ceremony (a fresh passkey assertion by one of the
// caller's OWN credentials), mirroring the login ceremony. begin returns the WebAuthn request options;
// finish verifies the assertion and returns a single-use step-up token.
export async function stepUpBegin(t: Transport): Promise<PasskeyLoginBegin> {
  const r = await engineFetch(`${t.base}/admin/stepup/begin`, { method: "POST", headers: t.headers(), credentials: "include", body: "{}" });
  return t.parseJson<PasskeyLoginBegin>(r, "step-up begin");
}

export async function stepUpFinish(t: Transport, challengeId: string, credential: PasskeyAssertionCredential): Promise<{ ok: true; stepUpToken: string } | { ok: false; reason: string }> {
  const r = await engineFetch(`${t.base}/admin/stepup/finish`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ challengeId, credential }) });
  return t.parseJson<{ ok: true; stepUpToken: string } | { ok: false; reason: string }>(r, "step-up finish");
}

// passkeyRegisterBegin asks the engine for the navigator.credentials.create options for an email. The
// body is { email } plus an OPTIONAL displayName (the human label the operator chose for the passkey;
// the engine uses it for the WebAuthn user.displayName and stores it on the user record). The engine
// supplies the rp.id + origin itself (it never trusts a client one). exactOptionalPropertyTypes:
// displayName is added to the body only when a non-empty value is supplied.
//
// inviteToken is the OPTIONAL single-use, email-bound passkeyInvite token from a role-grant invite link
// (${CONSOLE_ORIGIN}/#/register?invite=<token>). When present it is carried as body.inviteToken so the
// engine's invite path takes the bound email FROM THE INVITE rather than trusting the client-supplied
// email (the engine is the authority on the binding; the console only relays the opaque token). It is
// added to the body ONLY when a non-empty value is supplied, so the self-add / first-registrant bootstrap
// paths POST exactly the same body they did before (no inviteToken field at all). No secret transits: the
// token is an opaque single-use invite id the engine minted, not a key or value.
export async function passkeyRegisterBegin(t: Transport, email: string, displayName?: string, inviteToken?: string): Promise<PasskeyRegisterBegin> {
  const body: { email: string; displayName?: string; inviteToken?: string } = {
    email,
    ...(displayName !== undefined && displayName !== "" ? { displayName } : {}),
    ...(inviteToken !== undefined && inviteToken !== "" ? { inviteToken } : {}),
  };
  const r = await engineFetch(`${t.base}/admin/auth/register/begin`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify(body) });
  return t.parseJson<PasskeyRegisterBegin>(r, "passkey register begin");
}

// passkeyRegisterFinish submits the attestation the authenticator produced for an email. On a verified
// ceremony the engine stores the credential, BOOTSTRAPS the first registrant to Owner, and sets the
// session cookie; the body reports the verified email, whether the caller was bootstrapped, and the role.
// displayName is carried again (the same operator-chosen label) so a first-credential user record stores
// it; exactOptionalPropertyTypes: it is added only when supplied.
//
// inviteToken is carried again (the SAME opaque invite token as begin) so the engine's invite path binds
// the stored credential to the email the invite was minted for, NOT the client-supplied email. It is added
// to the body ONLY when a non-empty value is supplied, so the self-add / bootstrap finish POSTs the same
// body it did before. No secret transits (the token is the engine's own single-use invite id).
export async function passkeyRegisterFinish(t: Transport, email: string, credential: PasskeyAttestationCredential, displayName?: string, inviteToken?: string): Promise<PasskeyFinish> {
  const body: { email: string; credential: PasskeyAttestationCredential; displayName?: string; inviteToken?: string } = {
    email,
    credential,
    ...(displayName !== undefined && displayName !== "" ? { displayName } : {}),
    ...(inviteToken !== undefined && inviteToken !== "" ? { inviteToken } : {}),
  };
  const r = await t.gatedFetch("/admin/auth/register/finish", { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify(body) });
  return t.parseJson<PasskeyFinish>(r, "passkey register finish");
}

// passkeyLoginBegin asks the engine for the navigator.credentials.get options. The email is OPTIONAL: when
// supplied the engine scopes allowCredentials to that person's keys; when omitted the browser offers any
// resident passkey for the rp.id (usernameless). The begin echoes a challengeId the finish must present back.
// exactOptionalPropertyTypes: email is included in the body only when a non-empty value is supplied.
export async function passkeyLoginBegin(t: Transport, email?: string): Promise<PasskeyLoginBegin> {
  const body: { email?: string } = email !== undefined && email !== "" ? { email } : {};
  const r = await engineFetch(`${t.base}/admin/auth/login/begin`, { method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body) });
  return t.parseJson<PasskeyLoginBegin>(r, "passkey login begin");
}

// passkeyLoginFinish submits the assertion plus the challengeId from begin (the engine consumes the
// single-use login challenge by that id). On a verified assertion the engine sets the session cookie and
// returns the verified email; the role is then resolved by the next whoami, exactly as the Access path.
export async function passkeyLoginFinish(t: Transport, challengeId: string, credential: PasskeyAssertionCredential): Promise<PasskeyFinish> {
  const r = await engineFetch(`${t.base}/admin/auth/login/finish`, { method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ challengeId, credential }) });
  return t.parseJson<PasskeyFinish>(r, "passkey login finish");
}

// passkeyLogout clears the engine session cookie (a no-DO, clear-only call the engine honours from any
// origin). It is a no-op when no passkey session exists, so it is always safe to call on sign-out before
// returning to the login. The browser drops the __Host- cookie; the next /admin call carries no session.
export async function passkeyLogout(t: Transport): Promise<{ ok: boolean }> {
  const r = await engineFetch(`${t.base}/admin/auth/logout`, { method: "POST", headers: { "content-type": "application/json" }, credentials: "include" });
  return t.parseJson<{ ok: boolean }>(r, "passkey logout");
}

// bootstrapSendLink asks the engine to email the FIRST-OWNER set-up link to the owner address pinned at
// deploy time (BOOTSTRAP_OWNER_EMAIL). The route is a strict NO ORACLE: the engine answers the same
// generic { ok:true } whether it sent the email, is already bootstrapped, or is not configured for the
// email-link first run at all, so this result carries no engine state and the screen shows the same
// honest "if the engine is waiting for its first Owner..." copy either way. Unauthenticated by design
// (it exists for the operator who cannot sign in yet); the body is empty (the engine binds the recipient
// from env, never from a client field), and no secret transits in either direction.
export async function bootstrapSendLink(t: Transport): Promise<{ ok: boolean }> {
  const r = await engineFetch(`${t.base}/admin/auth/bootstrap/send`, { method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: "{}" });
  return t.parseJson<{ ok: boolean }>(r, "bootstrap send link");
}
