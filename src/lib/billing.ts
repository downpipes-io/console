// Commercial-model constants and the pure renewal-awareness logic for the Licence
// screen (screens/licence.ts). This file is presentation/config only: it holds the
// external billing links and the Enterprise SERVICES offer, and computes a renewal
// note from a licence's notAfter. It NEVER changes the fail-open posture: a licence
// never gates the data or the recovery path, and nothing here consults a key, a value,
// or any backup data (no-custody holds; these are constants and a date subtraction).
//
// FRAMING (must stay true in every string): the product and ALL of its security (SSO,
// MFA, Cloudflare Access, RBAC, tamper-evident audit, no-custody post-quantum crypto)
// are FREE and included for everyone at the Community tier. Enterprise is a paid
// SERVICES subscription (audit assistance, ISO 27001 / SOC 2 evidence, security
// questionnaire support, compliance advisory, priority support, a dedicated account
// manager, provable recoverability and a periodic backup-assurance attestation), NOT a
// feature unlock. No string in this file may imply a product capability is locked behind
// Enterprise.

import { dateOnly, titleCase } from "./format.ts";
import type { LicenceStatus } from "../api.ts";

// ENTERPRISE_CONTACT is the call-to-action target for a Community operator who wants to
// talk to us about the Enterprise services subscription. It is the live sales mailto, with a
// pre-filled subject so the lead lands tagged; the operator's mail client supplies the
// organisation, contact and preferred term in the body. This mirrors the website's contact
// CTA (website/src/config/site.ts, sales@downpipes.io). A mailto and an https link are both
// accepted by the screen's link builder.
export const ENTERPRISE_CONTACT = "mailto:sales@downpipes.io?subject=downpipes%20Enterprise";

// RENEW_SOON_DAYS is the window (in days) before notAfter at which the screen surfaces the
// amber "Renews soon" cue. Every licence now renews the same way: as a FRESH MINT on invoice, with
// the vendor issuing a new token each term and emailing it. Until a self-serve tier
// (Starter, Growth, Business or an MSP / MSSP pack) instead renewed itself through a Stripe subscription,
// with the control-plane re-minting on each paid cycle; self-serve checkout was removed, so that
// second path is gone. The operator pastes the renewed token into Activate licence on
// this screen -- the console-set token lives in the scheduler DO, never a Worker secret or env var,
// so there is no redeploy and nothing to re-pin. There is NO grace window covering the lag between
// expiry and the operator pasting the renewed token in: checkExpiry in the engine lapses a licence on
// the instant (`expiry <= Date.now()`). What covers that lag is fail-open, which keeps backups and
// restores working at the Community tier until the new token is activated.
export const RENEW_SOON_DAYS = 30;

// MS_PER_DAY is one day in milliseconds (the unit of the renewal-day computation).
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// RenewalNotice is the pure, rendered-agnostic description of an Enterprise licence's
// renewal posture, derived from its notAfter. The screen turns this into copy + an amber
// badge/banner; keeping the decision here (not in the DOM) is what lets the validator test
// it without a browser. It is computed ONLY for a tier whose validity is time-boxed
// (enterprise/pro with a notAfter); Community has no expiry, so it returns null there.
//
//   - daysUntil:  whole days from `now` until notAfter (negative once past).
//   - expired:    notAfter is in the past (daysUntil < 0). Fail-open still holds: an
//                 expired licence never gates data or recovery; the engine answers
//                 community and backups/restores are unaffected.
//   - renewsSoon: within RENEW_SOON_DAYS and not yet expired, so the operator should be
//                 ready to re-pin the renewed LICENCE_TOKEN.
export interface RenewalNotice {
  notAfter: string;
  daysUntil: number;
  expired: boolean;
  renewsSoon: boolean;
}

// renewalNotice computes the RenewalNotice for a licence, or null when there is nothing to
// say (no notAfter, or an unparseable notAfter). `now` is injectable so the validator can
// pin a deterministic clock; it defaults to Date.now(). The day count is a CEIL of the
// remaining time so "0 days" is reserved for a licence that is genuinely at/over the line
// (a licence 1ms from now reads "1 day", never a premature "0 days"); once past, the floor
// of the elapsed time gives a negative count.
export function renewalNotice(lic: LicenceStatus, now: number = Date.now()): RenewalNotice | null {
  if (!lic.notAfter) return null;
  const at = Date.parse(lic.notAfter);
  if (!Number.isFinite(at)) return null;
  const deltaMs = at - now;
  const daysUntil = deltaMs >= 0 ? Math.ceil(deltaMs / MS_PER_DAY) : Math.floor(deltaMs / MS_PER_DAY);
  const expired = deltaMs < 0;
  const renewsSoon = !expired && daysUntil <= RENEW_SOON_DAYS;
  return { notAfter: lic.notAfter, daysUntil, expired, renewsSoon };
}

// licenceExpired answers the one question the Licence card could not previously ask: has this customer's
// licence passed its validity date?
//
// WHY TIER CANNOT ANSWER IT. The engine fails open, and its fail-open path funnels all twelve reason codes
// through one helper that returns tier "community" (engine src/admin/licence.ts community()). So the tier
// of an expired Enterprise licence is "community", exactly like a customer who never bought one, and the
// screen's `tier === "enterprise"` test was false for every genuinely expired engine response. The banner
// about expiry was therefore unreachable by the only customer it was written for.
//
// WHAT DOES ANSWER IT. reasonCode is the closed enum, and "expired" is its own member, distinct from
// "unparseable-expiry" (a malformed date, which fails closed and is a different fault with a different
// remedy). The notAfter clause beside it is a corroborating second route rather than a guess: the engine
// echoes notAfter on exactly two paths, a licence that VERIFIED and has not lapsed, and the expiry branch,
// so an invalid licence carrying a notAfter already in the past is expired whatever else is true of it. It
// is kept because a false NEGATIVE here is the defect being fixed, and one clause failing silently is how
// the first one got missed.
export function licenceExpired(lic: LicenceStatus, now: number = Date.now()): boolean {
  if (lic.valid) return false;
  if (lic.reasonCode === "expired") return true;
  return renewalNotice(lic, now)?.expired === true;
}

// licenceStampUnreadable is the honest counterpart to renewalNotice's null. renewalNotice returns null
// for BOTH "there is no notAfter" (Community, which never lapses, so there is nothing to say) and "the
// notAfter is there but does not parse", and those two are not the same thing: the second SILENTLY
// DISARMS the whole renewal machinery, so a mis-minted or corrupted token shows no renews-soon cue, no
// expired cue, and reads exactly like a licence with years left. This predicate separates them, so the
// screen can say the stamp cannot be read instead of showing the calm nothing that means "all is well".
// Pure; the malformed value itself is NEVER rendered, only the verdict that it could not be read.
export function licenceStampUnreadable(lic: LicenceStatus): boolean {
  const at = lic.notAfter;
  if (at === undefined || at === null || at === "") return false;
  if (typeof at !== "string") return true;
  return !Number.isFinite(Date.parse(at));
}

// LICENCE_STAMP_UNREADABLE_LINE is what the Licence card says when licenceStampUnreadable is true. It
// states the consequence (no renewal cue can be computed, so do not wait for one) and the one action
// that fixes it (re-activate with the token from the activation email).
export const LICENCE_STAMP_UNREADABLE_LINE =
  "This licence carries a validity date the console cannot read, so no renewal or expiry cue can be shown for it. Fail-open still holds (backups and restores are unaffected). Re-activate with the token from your activation email, and contact support if it keeps happening.";

// ---------------------------------------------------------------------------
// The account-claim verdict (a licence minted for someone else's account)
// ---------------------------------------------------------------------------

// licenceAccountMismatch is true ONLY when the engine positively said the signed licence names a
// DIFFERENT Cloudflare account from the one the engine runs in. The verdict is the engine's, computed
// against its own env.CF_ACCOUNT_ID and sent as a boolean with the claim's value withheld (engine
// src/admin/licence.ts checkExpiry), so the console never sees and never renders an account id.
//
// THE STRICT === false IS THE WHOLE PREDICATE. The field is absent whenever the comparison could not be
// made honestly: no account tag configured on the engine, an engine build that predates the field, or a
// licence that did not verify or has expired (the expiry branch returns before the comparison, so a
// mismatch and an expiry can never both be claimed on one licence). An absent verdict must read as
// "not established", never as a match and never as a mismatch, which a truthiness test would get wrong
// in one direction and a `!== true` test in the other.
//
// Fail-open is untouched: the engine stores the licence and reports its tier either way, so this drives
// what the screen SAYS, never what it permits. Pure.
export function licenceAccountMismatch(lic: LicenceStatus): boolean {
  return lic.accountClaimMatchesEngine === false;
}

// LICENCE_ACCOUNT_MISMATCH_LINE is the standing note the Licence card carries while the verdict is false.
//
// This changed WHEN this can fire. A self-serve licence now binds to
// Cloudflare accounts at claim, up to its band's estate count (control-plane's licence/claim.ts
// bindClaimAccount): the console reads this engine's own account id off GET /admin/status and sends it
// with every claim-code exchange, so activating with YOUR OWN claim code binds this account
// automatically and this note never appears for that path. The remaining cause is a token pasted from
// somewhere else: an email meant for a different estate, a token copied off another customer's screen,
// or a stale token from before this engine's account was bound. The line states the fact, keeps the
// fail-open reassurance the rest of the card makes, and names the one thing that actually fixes it
// (claim with THIS account's own code) before falling back to support. It never suggests the licence
// will stop working, because it will not.
export const LICENCE_ACCOUNT_MISMATCH_LINE =
  "This licence does not name this Cloudflare account. It is stored and the tier above is what the engine reports, and nothing is gated: backups and restores are unaffected. If you pasted a token, use the claim code from this account's own licence email instead (Activate licence above): claiming with your own code binds this account automatically. If you already did that and still see this, contact support@downpipes.io.";

// ---------------------------------------------------------------------------
// The engine has not yet identified its own account
// ---------------------------------------------------------------------------

// licenceAccountUnknown is true when GET /admin/status carries no cfAccountId at all: the engine has not
// yet set env.CF_ACCOUNT_ID by hand and has not yet completed the one attach or update-apply that would
// let it prove its own account id to itself (engine status.ts buildStatus). It is a DIFFERENT state from
// licenceAccountMismatch above and the two never both apply: a mismatch needs the engine's own
// accountClaimMatchesEngine verdict, which the engine computes only when it already knows its account
// (see engine/src/admin/licence.ts checkExpiry), the exact condition this function is checking the
// absence of. Pure; cfAccountId is read directly off the status the caller already holds.
export function licenceAccountUnknown(cfAccountId: string | undefined): boolean {
  return cfAccountId === undefined;
}

// LICENCE_ACCOUNT_UNKNOWN_LINE is the quiet, non-alarming hint the Licence card carries while
// licenceAccountUnknown is true. Before this line existed the card said nothing at all here, which read
// as though account binding either did not apply or had already happened; a customer with a fresh
// deployment had no way to tell the two apart. It states the plain cause and the plain remedy (nothing to
// do, it resolves itself), and it must never read as a fault: fail-open holds regardless, and claiming
// with the licence's own claim code still works today, it simply cannot bind THIS account until the
// engine has proven it.
export const LICENCE_ACCOUNT_UNKNOWN_LINE =
  "This engine has not identified its own Cloudflare account yet. That happens automatically the first time you attach a source or apply an update; a self-serve licence binds to this account on the claim after that.";

// ---------------------------------------------------------------------------
// A repeat activation that REPLACES a longer-lived licence with a shorter one
// ---------------------------------------------------------------------------

// licenceValidityShortened reports that an activation just moved the licence's validity date BACKWARDS:
// the token now stored runs out earlier than the one it replaced. The engine stores whatever verifies
// (scheduler-do-account-config.ts setLicenceToken puts the record unconditionally, with no comparison
// against what was there), so pasting last term's token over this term's is accepted, reported as the tier
// it names, and confirmed as an ordinary activation. Nothing anywhere says the expiry went backwards.
//
// THE CONSOLE CANNOT REFUSE THIS AND DOES NOT TRY. It never sees the pasted token's claims: the token is
// opaque here and the engine is the only party that verifies it, so a pre-submit check is not available at
// any price. What the console does hold is BOTH SIDES of the exchange, the status it rendered the card from
// and the status the engine just returned, and comparing those two is evidence rather than a guess.
//
// Both dates must parse for the comparison to mean anything: an absent or unreadable notAfter on either
// side yields false, never a fabricated claim that a licence was shortened. Equal dates are not a
// shortening (re-pasting the SAME token is idempotent and is the flow working). Pure; `now` is not
// consulted, because this is about the two tokens, not about expiry.
export function licenceValidityShortened(before: LicenceStatus, after: LicenceStatus): boolean {
  const from = before.notAfter === undefined ? Number.NaN : Date.parse(before.notAfter);
  const to = after.notAfter === undefined ? Number.NaN : Date.parse(after.notAfter);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  return to < from;
}

// licenceShortenedClause is the sentence appended when licenceValidityShortened holds. It states both
// dates, so the operator can see the size of the move, and names the one likely cause without asserting
// it (a token from an older email). It never says the activation failed, because it did not.
export function licenceShortenedClause(before: LicenceStatus, after: LicenceStatus): string {
  const from = before.notAfter ? dateOnly(before.notAfter) || before.notAfter : "";
  const to = after.notAfter ? dateOnly(after.notAfter) || after.notAfter : "";
  return `This token runs to ${to}, earlier than the ${from} of the one it replaced. If you meant to paste a renewed token, check your most recent licence email.`;
}

// licenceActivatedLine is what the activation toast says the moment a token is stored. On the ordinary
// path it is the unchanged confirmation. On a MISMATCH it must not read as a clean success: the licence
// really was stored and the tier really is reported, and both are said plainly, but the toast names the
// account fact in the same breath and points at the card's standing note rather than leaving the operator
// with a confirmation that hides it.
//
// `previous` is the status the screen was rendered from, before this activation. It is optional so a caller
// with nothing to compare against (and every existing call) behaves exactly as before, and when it is
// supplied the shortening clause is APPENDED rather than replacing anything: a shortened licence and a
// foreign-account licence are two independent facts and either can be true without the other. Pure, so the
// validator pins every path.
export function licenceActivatedLine(lic: LicenceStatus, previous?: LicenceStatus): string {
  const head = licenceAccountMismatch(lic)
    ? `Licence stored and the engine reports the ${tierDisplayName(lic.tier)} tier, but it names a different Cloudflare account from this engine's. See the note on the Licence card.`
    : lic.tier === "community"
      ? "Licence activated (Community)."
      : `Licence activated: ${tierDisplayName(lic.tier)} tier.`;
  return previous !== undefined && licenceValidityShortened(previous, lic) ? `${head} ${licenceShortenedClause(previous, lic)}` : head;
}

// ENTERPRISE_SERVICES is the list the Enterprise card renders: the SERVICES and assurance
// an Enterprise subscription adds. None of these is a product feature gate; they are
// people-and-paperwork services plus signed assurance over the recovery path the product
// already provides for free.
export const ENTERPRISE_SERVICES: readonly string[] = [
  "Audit assistance and evidence preparation",
  "ISO 27001 documentation support",
  "SOC 2 evidence support",
  "Security questionnaire support (UpGuard and similar)",
  "Compliance advisory",
  "Priority support",
  "A dedicated account manager",
  "Provable recoverability: signed disaster-recovery drill evidence",
  "Periodic backup-assurance attestation",
];

// ---------------------------------------------------------------------------
// Tier display metadata (volume-based licensing)
// ---------------------------------------------------------------------------
// TIER_DISPLAY_NAMES is the one place that maps a licence tier id to the name shown on screen. The
// current vocabulary (control-plane's src/licence/issue.ts) is
// estate-banded: business-1/business-3/business-10/business-25 name the four fixed Business
// checkout tiers, replacing the pre-9-August "starter"/"growth"/"business" ids outright (no-legacy:
// zero customers or tokens ever existed under the old ids, so this map carries no alias for them).
// The four business-N strings are copied VERBATIM from control-plane's own tierDisplayName() (the
// same function the self-serve activation email's tier_name reads), so a customer sees the exact
// same words in the email and in the console. "msp" does not read fine title-cased either ("Msp" is
// wrong), so every call site uses tierDisplayName() rather than titleCase() directly. "MSP / MSSP"
// (spaced slash) is the website pricing page's spelling, made canonical across surfaces on
// to end a three-way drift (control-plane's own tierDisplayName said "MSP/MSSP" with no
// spaces, the console said "MSP pack"); control-plane is outside this file's reach and still says
// "MSP/MSSP" as of this note. The two
// non-self-serve ids (Community, Enterprise) are included too so the whole tier badge/tile/toast
// family can share the one function instead of special-casing five ids and title-casing the rest.
// Display metadata ONLY: it never gates a feature (the same framing rule as ENTERPRISE_SERVICES
// above -- a tier name is not a capability list).
export const TIER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  community: "Community",
  "business-1": "Business (1 estate)",
  "business-3": "Business (up to 3 estates)",
  "business-10": "Business (up to 10 estates)",
  "business-25": "Business (up to 25 estates)",
  msp: "MSP / MSSP",
  enterprise: "Enterprise",
};

// tierDisplayName resolves ANY tier id to its display name, including one this console build does
// not yet recognise (an engine ahead of the console): it falls back to a title-cased rendering of
// the raw id rather than dropping it or throwing (the same honest-degrade shape as titleCase's own
// null-defensive contract). Every screen that prints a tier (the licence badge, the
// summary tile, the activation toasts) calls this instead of titleCase() directly.
export function tierDisplayName(tier: string): string {
  return TIER_DISPLAY_NAMES[tier] ?? titleCase(tier);
}
