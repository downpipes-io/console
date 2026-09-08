// Sign-in factor mirror types: the union read (GET /admin/signin-factors) and the offboarding write
// (POST /admin/signin-factors/revoke). Mirrored field-for-field from engine/src/admin/signin-factors.ts,
// which is the authority on both the vocabulary and the polarity argument these shapes exist to carry.
//
// WHY THE CONSOLE NEEDS THIS AT ALL. The engine can now close every way a named person signs in as one
// audited act, and until this module landed the only caller was an administrator with a terminal. That
// breaks the rule that the portal completes every customer action, and it breaks it on the security-critical
// half of an offboarding.
//
// THE POLARITY, carried across the wire unchanged. An operator asking "can my removed colleague still sign
// in?" who is told NO when the truth is UNPROVABLE closes the offboarding and walks away with the door open.
// So this side must never collapse "indeterminate" into "no factor" for display convenience. The tri-state
// is the whole point and the render honours it.
//
// Redaction-safe by construction: counts, timestamps, closed enums, and base64url credential ids (public
// identifiers the credential route already returns). No recovery code, no code hash, no invite token, no key.

// RecoveryKeyContinuity mirrors the engine enum exactly. "none" (no record) is kept distinct from "unknown"
// (a record nobody can judge) because a person who never had codes must not be shown as a person whose codes
// cannot be judged.
export type RecoveryKeyContinuity = "live" | "orphaned" | "unknown" | "none";

// SignInPath names a way in that is PROVEN live. An indeterminate row carries NO path, deliberately: a path
// on such a row would read as established.
export type SignInPath = "passkey" | "recovery-code" | "registration-invite";

// SignInVerdict is the tri-state. See the polarity note above for why "indeterminate" cannot be folded.
export type SignInVerdict = "can-sign-in" | "indeterminate" | "no-factor";

// SignInFactorRow is the per-email view. unconsumedCodes is `number | null`, and the null is load-bearing:
// it means the record could not be parsed, so the count is UNKNOWABLE. Rendering a null as 0 would tell the
// operator this person has no codes left, which is the reassuring answer nobody is entitled to give about a
// record nobody could read.
export interface SignInFactorRow {
  email: string;
  hasRoleEntry: boolean;
  signIn: SignInVerdict;
  paths: SignInPath[];
  passkey: {
    credentials: number;
    credentialIds: string[];
    lastAssertedAt: string | null;
  };
  recovery: {
    present: boolean;
    parseable: boolean;
    unconsumedCodes: number | null;
    keyContinuity: RecoveryKeyContinuity;
    generatedAt: string | null;
  };
  invites: {
    live: number;
    expired: number;
    soonestExpiresAt: string | null;
  };
}

// SignInFactorListing is the read's body. scope says which question was answered: "account" is every email
// holding a way in, "email" is one named person (who ALWAYS comes back as a row, even with all three stores
// empty, so "no rows" never has to stand in for "this person has nothing").
//
// groupRoleMappings is the GROUP-CLAIM CAVEAT and it is a COUNT, not a per-row flag, because the engine holds
// the group-to-role mapping but not the group MEMBERSHIP: it cannot say whether this email is in that group.
// A non-zero count is what tells an operator that removing a role row may not have removed the authority. A
// zero is the strong answer, and the panel says so in those words.
export interface SignInFactorListing {
  scope: "account" | "email";
  factors: SignInFactorRow[];
  witnessSince: string | null;
  groupRoleMappings: number;
}

// SignInFactorRevocation is what a revoke REMOVED, counted per store. The live/expired invite split is
// reported separately and must stay separate on this side too: invitesLive is the number of ways in the call
// actually closed, which is the security fact, and invitesExpired is housekeeping swept at the same time.
// Summing them would let a revoke that closed NOTHING report a reassuring non-zero total.
export interface SignInFactorRevocation {
  passkeyCredentials: number;
  recovery: boolean;
  invitesLive: number;
  invitesExpired: number;
}

// SignInFactorRevokeResult is the write's body. sessionsTerminated is the engine's own answer to "was a way
// in really closed": it is the condition the engine hangs its session-epoch bump and its audit row on, so the
// console reports the outcome from THIS field rather than inferring it from the counts. Inferring it would be
// a second implementation of revocationClosedAWayIn, free to drift from the one that decided.
export interface SignInFactorRevokeResult {
  email: string;
  revoked: SignInFactorRevocation;
  sessionsTerminated: boolean;
}

// isSignInFactorListing narrows an unknown body (a route an engine build has not modelled is
// indistinguishable from a real success by status alone). Deliberately loose beyond the fields a caller
// indexes, so a harmless engine-side field addition never trips it.
export function isSignInFactorListing(v: unknown): v is SignInFactorListing {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (o.scope === "account" || o.scope === "email") && Array.isArray(o.factors) && typeof o.groupRoleMappings === "number";
}

// isSignInFactorRevokeResult narrows the write's body. sessionsTerminated is checked for its TYPE, not for a
// value, because both booleans are legitimate outcomes: false is a revoke that found only expired residue,
// and it must arrive as data rather than be mistaken for a malformed body.
export function isSignInFactorRevokeResult(v: unknown): v is SignInFactorRevokeResult {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.email !== "string" || typeof o.sessionsTerminated !== "boolean") return false;
  const r = o.revoked;
  if (typeof r !== "object" || r === null) return false;
  const rr = r as Record<string, unknown>;
  return typeof rr.passkeyCredentials === "number" && typeof rr.recovery === "boolean" && typeof rr.invitesLive === "number" && typeof rr.invitesExpired === "number";
}

// closedAWayIn is the CONSOLE-SIDE READ of the engine's own verdict, not a recomputation of it. It exists so
// the render has one named place to ask the question, and it deliberately takes the whole result rather than
// the counts: the engine already decided, on the same fact it audited and bumped the epoch on, and a second
// arithmetic here could disagree with the record. Expired invites can never make this true, on either side.
export function closedAWayIn(result: SignInFactorRevokeResult): boolean {
  return result.sessionsTerminated;
}
