// Sign-in factor domain functions for the EngineClient: the union read and the offboarding write. Free
// functions over the shared Transport, wired onto EngineClient in client.ts, mirroring client-retention-
// prune.ts's shape (a plain authenticated read beside a step-up gated destructive write).
//
// WHY THIS MODULE EXISTS. The engine's POST /admin/signin-factors/revoke closes all three sign-in stores for
// one email as ONE audited act, and it had no console caller at all, so the security-critical half of an
// offboarding was an administrator API call. Customers never run a terminal.
//
// GATING, and the one thing a reader must not assume from it. revoke goes through t.gatedFetch, which is the
// SENSITIVE-action path: on a 401 { stepUpRequired:true } it runs the injected re-auth ceremony and retries
// once. That is the correct transport for a destructive identity mutation and it is what the sibling
// destructive writes use. It is NOT, however, a claim that this route currently asks for a step-up. Checked
// against engine/src/admin/router-core.ts, "/signin-factors/revoke" is ABSENT from STEPUP_SUBS,
// and the gate is a Set membership test on the exact sub, run once before every spoke, with no requireStepUp
// call of its own inside router-account-session.ts. So the engine answers this POST without ever opening the
// ceremony. Routing it through gatedFetch anyway is deliberate on two counts: the plain transport CANNOT
// raise the prompt even if the engine starts asking, so the plain path would have to be found and changed
// later by somebody who did not know to look; and a console that told the operator to approve a prompt this
// path can never show would be describing a ceremony that does not happen. The panel therefore promises no
// prompt (see the revoke modal's copy), and the day the engine admits the route to STEPUP_SUBS this call
// starts satisfying it with no console change.
//
// Redaction: neither call carries a secret in either direction. The read returns counts, timestamps, closed
// enums and public credential ids; the write takes an email and returns per-store counts.

import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type { SignInFactorListing, SignInFactorRevokeResult } from "./types.ts";
import { isSignInFactorListing, isSignInFactorRevokeResult } from "./types.ts";

// listSignInFactors reads who can still sign in. With no email it reads the WHOLE ACCOUNT (roles.write);
// with an email it reads that one person (self needs only authentication).
//
// THE ABSENT FALLBACK IS THE POINT and this client must not reintroduce it. The engine deliberately does not
// fall back to the caller's own email when the parameter is omitted, because that fallback is what made the
// older credential route answer `200 []` to every bearer-token sweep, byte-identical to a clean account. So
// `email` is passed through only when the caller named one, and an empty string is treated as "not named"
// rather than sent as `?email=`, which the engine would refuse with a 400 for an address it cannot use.
export async function listSignInFactors(t: Transport, email?: string): Promise<SignInFactorListing> {
  const named = email !== undefined && email !== "";
  const path = `${t.base}/admin/signin-factors${named ? `?email=${encodeURIComponent(email)}` : ""}`;
  const r = await engineFetch(path, { headers: t.headers(), credentials: "include" });
  const result = await t.parseJson<SignInFactorListing>(r, "read sign-in factors");
  if (!isSignInFactorListing(result)) throw new Error("read sign-in factors: the response did not carry a sign-in factor listing");
  return result;
}

// revokeSignInFactors closes every way the named person signs in: their passkey credentials, their recovery
// record, and every registration invite bound to their address, as one audited engine act.
//
// IT IS NOT A ROLE DELETE and this function is deliberately not reachable from the role-delete path. Deleting
// a role row can be a legitimate DEMOTION for somebody who also holds authority through an identity-provider
// group claim, and the engine says so in its own words: for such a member deleteRole removes only the row and
// audits it as a role change. Revoking destroys their authenticator and their recovery codes, and recovery
// codes cannot be re-derived. The engine refused to fold the two together because deleteRole cannot tell which
// one it is being asked for; the console keeps that separation visible rather than quietly re-joining them.
//
// The result is returned WHOLE, including a revoke that closed nothing. `sessionsTerminated:false` with four
// expired invites swept is a real and unalarming outcome, and the caller renders it as what it was rather
// than as a success or a failure.
export async function revokeSignInFactors(t: Transport, email: string): Promise<SignInFactorRevokeResult> {
  const r = await t.gatedFetch("/admin/signin-factors/revoke", {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify({ email }),
  });
  const result = await t.parseJsonOrReason<SignInFactorRevokeResult>(r, "revoke sign-in factors");
  if (!isSignInFactorRevokeResult(result)) throw new Error("revoke sign-in factors: the response did not carry a revocation receipt");
  return result;
}
