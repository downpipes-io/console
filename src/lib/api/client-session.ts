// Session management + enrolled-passkey credential management domain functions for the EngineClient (split
// from client.ts per findings console-src-010-01 / console-sys-arch-01 / console-sys-struct-03). Free
// functions over the shared Transport; request URL/method/body/headers and parse/throw logic moved VERBATIM.
//
// Session management (ASVS V7.4.5; V7.5.2 PARTIAL): the engine exposes three session-termination levers
// under /admin/sessions/* (engine/src/admin/router.ts). All ride the session cookie / bearer (t.headers() +
// credentials:"include"); the console mirrors the gate as UX only (canCap("roles.write") for the admin
// actions, owner-only for terminate-all). No value or key transits: the body is an email at most, and every
// response is { ok } (or a 4xx { error } the caller surfaces honestly). V7.5.2 is still PARTIAL: these three
// functions now call gatedFetch (matching every other STEPUP_SUBS route). The ML-02 server-side CSRF
// double-submit gate HAS shipped engine-side: the three routes refuse a cookie-borne caller whose
// x-downpipes-csrf header does not match the readable __Host-downpipes_csrf cookie, so each call here
// spreads csrfEcho() into its headers (a no-op for bearer/Access callers, which the engine exempts).
// V7.5.2 note: the engine's STEPUP_SUBS still does not include the three /sessions/* sub-paths, so the
// 401 { stepUpRequired } path gatedFetch is ready for remains a future engine change.
//
// Passkey credential management (ASVS V6.5.6): the enrolled-passkey inventory under /admin/passkey/
// credentials* (engine/src/admin/router.ts). listPasskeyCredentials reads the caller's OWN keys (any
// authenticated role) or, with an email, another member's (gated to roles.write SERVER-SIDE).
// deletePasskeyCredential revokes one by its credentialId, with the engine's last-Owner-passkey guard
// refusing the sole Owner's last key (a 4xx { error } the console surfaces verbatim and honestly).
// No-custody: the listed view carries a credential id, a timestamp, the authenticator AAGUID, advisory
// transports and the COSE alg id only; never key material. Revoking a credential also terminates sessions
// that predate it (the engine bumps the member's session epoch), which is the V7.4.3 behaviour.

import { engineFetch } from "./engine-fetch.ts";
import { caller } from "../nav.ts";
import { holdsFirstPartySession } from "../identity.ts";
import type { Transport } from "./client-transport.ts";
import type { PasskeyCredentialSummary } from "./types.ts";

// csrfEcho reads the engine-issued double-submit token (the READABLE __Host-downpipes_csrf cookie the
// engine sets alongside whoami; deliberately not HttpOnly so the SPA can echo it) and returns it as the
// x-downpipes-csrf header entry the session-termination routes require for a COOKIE-BORNE session
// (engine ML-02: csrfBlock refuses a passkey/OIDC/SAML caller whose header + cookie pair does not
// match). A bearer/Access caller has no such cookie, sends no header, and the engine exempts it, so
// spreading this into headers is correct on every auth method. Exported for the sessions validator.
export function csrfEcho(cookieHeader?: string): Record<string, string> {
  const source = cookieHeader ?? (typeof document !== "undefined" ? document.cookie : "");
  if (!source) return {};
  for (const part of source.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== "__Host-downpipes_csrf") continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? { "x-downpipes-csrf": value } : {};
  }
  return {};
}

// terminateOtherSessions is the self-service "sign out my OTHER sessions": the engine bumps the
// caller's session epoch (killing every other session for their email) and RE-ISSUES this session's
// cookie via Set-Cookie, so the current tab stays signed in. The browser applies the Set-Cookie
// automatically (credentials:"include"); the console does not read or hold the token. Any authenticated
// caller WITH a first-party session may call it; a bare-token caller is refused by the engine (a 400
// { error: "no first-party session to manage on this auth method" }) which surfaces honestly.
// V7.5.2 PARTIAL: routed through gatedFetch so that, ONCE the engine adds this route to STEPUP_SUBS
// (router-core.ts) -- not done as of this writing (ASVS ML-02) -- a stale-but-owned session will be made
// to complete the WebAuthn re-auth ceremony before evicting the operator's own other devices. Until then
// this is functionally a plain fetch: a stale ambient session can still call it unchallenged.
export async function terminateOtherSessions(t: Transport): Promise<{ ok: boolean }> {
  // THE adminOp IS ATTACHED ONLY FOR A CALLER WHO CAN ACTUALLY HOLD A FIRST-PARTY SESSION.
  //
  // A bare-token or Access caller has no first-party session by construction, and the engine's 400 refusing this
  // route is the CORRECT, EXPECTED answer for them: the screen says so in as many words. Recording it as an
  // admin-write refusal wrote a GUARANTEED PHANTOM ROW into every token-auth console's pack -- and it wrote it
  // into {terminate-other-sessions, refused-validation}, the very row a genuine refusal coalesces into, so the
  // one signal was both fabricated and diluted. A signal that cries wolf devalues every true one.
  //
  // For a cookie-borne caller (passkey / OIDC / SAML) the same 400 IS a fault -- they demonstrably have a session,
  // and the engine found none to manage -- so the op rides, the row is real, and the engine records the matching
  // `first-party-session-required` guard on its side. The request itself is unchanged either way; only whether the
  // attempt is claimed as a privileged write changes.
  const r = await t.gatedFetch(
    "/admin/sessions/terminate-others",
    { method: "POST", headers: { ...t.headers(), ...csrfEcho() }, credentials: "include" },
    holdsFirstPartySession(caller()?.method) ? { adminOp: "terminate-other-sessions" } : {},
  );
  return t.parseJson<{ ok: boolean }>(r, "terminate other sessions");
}

// terminateUserSessions is the admin "sign out all of THIS member's sessions" (V7.4.5): the engine
// bumps the target email's session epoch so all their sessions die on their next request. Gated on
// roles.write SERVER-SIDE (an Owner's sessions may be ended only by an Owner; the engine's
// owner-escalation guard), with the console mirroring canCap("roles.write"). A bad/empty email or a
// role denial is a 4xx the caller surfaces; success is { ok: true }. V7.5.2 PARTIAL: routed through
// gatedFetch, but the engine has not yet added this route to STEPUP_SUBS (router-core.ts; ASVS ML-02), so
// a stale ambient session can still forcibly sign out a colleague today -- closing this needs that paired
// engine change, not just this client one.
export async function terminateUserSessions(t: Transport, email: string): Promise<{ ok: boolean }> {
  const r = await t.gatedFetch("/admin/sessions/terminate-user", { method: "POST", headers: { ...t.headers(), ...csrfEcho() }, credentials: "include", body: JSON.stringify({ email }) }, { adminOp: "terminate-user-sessions" });
  // Read through parseJsonOrPending so a 202 can NEVER be
  // coerced into a false { ok } success. This route is not change-control gated engine-side (router-account-
  // session.ts forwards straight to the session DO, which answers 200 { ok }), so a 202 is never a legitimate
  // answer here: a malformed 202 throws answer-unreadable inside the decoder, and a well-formed pending-shaped
  // 202 would name a change-request inbox this route never files to, so it takes the same honest throw rather
  // than a fabricated "queued". The 200 (-> value) and non-2xx (failResponse, no reason-fold) paths are
  // byte-identical to the parseJson read this replaces, so only an illegitimate 202 changes behaviour.
  const res = await t.parseJsonOrPending<{ ok: boolean }>(r, "terminate member sessions");
  if (res.status === "pending") throw new Error(`terminate member sessions: ${r.status}`);
  return res.value;
}

// terminateAllSessions is the OWNER-ONLY "sign out everyone" lever (V7.4.5, all-users): the engine
// ROTATES the session signing key, so every outstanding session token (including the caller's own)
// fails its next verify. It is the in-account global sign-out / break-glass after a suspected session
// compromise, so the console confirms it with the danger-confirm pattern. Gated owner-only SERVER-SIDE;
// success is { ok: true }. The caller's own session ends too, so the console treats it as a sign-out.
// V7.5.2 PARTIAL: routed through gatedFetch -- this is the single most consequential lever in the file --
// but the engine has not yet added this route to STEPUP_SUBS (router-core.ts; ASVS ML-02). Until it does,
// a stolen stale cookie can still trigger this tenant-wide sign-out with no fresh re-auth proof.
export async function terminateAllSessions(t: Transport): Promise<{ ok: boolean }> {
  const r = await t.gatedFetch("/admin/sessions/terminate-all", { method: "POST", headers: { ...t.headers(), ...csrfEcho() }, credentials: "include" }, { adminOp: "terminate-all-sessions" });
  return t.parseJson<{ ok: boolean }>(r, "terminate all sessions");
}

// listPasskeyCredentials lists enrolled passkeys: the caller's own when email is omitted, or another
// member's when an email is supplied (roles.write SERVER-SIDE). The response is { credentials: [...] }.
// exactOptionalPropertyTypes: the email query param is added only when a non-empty value is supplied.
export async function listPasskeyCredentials(t: Transport, email?: string): Promise<{ credentials: PasskeyCredentialSummary[] }> {
  const q = email !== undefined && email !== "" ? `?email=${encodeURIComponent(email)}` : "";
  const r = await engineFetch(`${t.base}/admin/passkey/credentials${q}`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<{ credentials: PasskeyCredentialSummary[] }>(r, "list passkey credentials");
}

// deletePasskeyCredential revokes a WebAuthn credential by its credentialId (POST-to-delete, consistent
// with the other deletes). Revoking an absent credential is an idempotent { deleted: false }. The
// engine's sole-Owner-last-passkey guard REFUSES the last key of the only Owner with a 4xx { error };
// because that is NOT a bare auth/transport fault, the error is folded into the thrown message (the same
// "<verb>: <reason>: <status>" form restore uses) so the control can surface the engine's own honest
// refusal rather than a generic failure. A role denial (revoking another's without roles.write) is the
// engine's 403 the classifier maps to "forbidden". No value or key transits.
// V7.5.1: the route is in STEPUP_SUBS (router-core.ts), so routed through gatedFetch: a stale ambient
// session's 401 { stepUpRequired } runs the WebAuthn re-auth ceremony and retries once, instead of
// surfacing a bare 401 that this function's own error-folding below would otherwise misread as the
// caller having been signed out.
export async function deletePasskeyCredential(t: Transport, credentialId: string): Promise<{ deleted: boolean }> {
  const r = await t.gatedFetch("/admin/passkey/credentials/delete", { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ credentialId }) }, { adminOp: "passkey-revoke" });
  if (!r.ok) {
    // The sole-Owner-last-passkey refusal is a 400 { error } that is NOT a bare auth/transport fault, so its
    // reason is folded into the thrown message and the control surfaces the engine's own explanation. It is
    // foldableReason, NOT readErrorReason: the line above used to claim a 403 "carries no usable `error`", and
    // it does (the capability gate sends { error: "forbidden" }), so the fold pre-empted failResponse's shape
    // gate and every 403 on this control read as a role denial. 401/403/429/5xx now keep their own markers.
    const reason = await t.foldableReason(r);
    if (reason !== null) throw new Error(`revoke passkey: ${reason}: ${r.status}`);
    return t.failResponse(r, "revoke passkey");
  }
  return t.parseJson<{ deleted: boolean }>(r, "revoke passkey");
}
