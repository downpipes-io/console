// Trust telemetry chips. These are unique to the product and they must be HONEST:
//
//  - The Access verifier chip reads the REAL verdict; it is NEVER a hardcoded green
//    (F7, the disqualifying-if-shipped finding). It distinguishes verified (green,
//    teal --trust), token-fallback (amber), unverified/401 (amber), and
//    unknown/unreachable (neutral), and never conflates them. It observes only
//    "passed Cloudflare Access policy" / "verified as <email>", NEVER "used a second
//    factor" (the JWT carries no factor detail).
//  - The trust accent (--trust teal) is the verified family, deliberately distinct
//    from the indigo action accent and the green ok-status in BOTH themes. Status is
//    hue + shape (shield-check glyph) + label.
//  - The no-custody chip is a TRUE statement (the break-glass private is generated
//    in this browser and never leaves it; the code enforces the absence of any
//    upload path), so it is a constant, not a verdict.

import { recordWireAnomaly } from "../lib/client-diag/ring.ts";
import { h, svgIcon } from "../lib/dom.ts";
import { ICON_SHIELD_CHECK, ICON_LOCK, ICON_INFO, ICON_ALERT } from "../lib/icons.ts";
import type { Caller } from "../api.ts";

// The verdict the chip can show. "verified" is the only green/teal state, and it is
// reached ONLY from a real whoami(method:"access"). Everything else is amber/neutral.
export type AccessVerdict =
  | { state: "verified"; email: string | null; identityProvider?: string } // whoami method "access"
  | { state: "passkey-verified"; email: string | null }                    // whoami method "passkey": a verified WebAuthn session, attributable to an email (NOT Cloudflare Access, NOT the shared token)
  | { state: "idp-verified"; email: string | null; protocol: "oidc" | "saml" } // whoami method "oidc"/"saml": the engine's OWN native IdP session, verified by the engine and attributable
  | { state: "recovery-verified"; email: string | null }                   // whoami method "recovery": a recovery-code sign-in, verified and attributable, but the break-glass-adjacent door
  | { state: "token-fallback" }                                            // whoami method "token"
  | { state: "session-present" }   // 200 but whoami absent (D1 pending): authenticated, method unknown
  | { state: "unverified" }        // a 401: Access session not valid
  | { state: "unknown" };          // could not reach the engine

// accessVerdictFromCaller derives the verdict from a resolved caller (whoami) when
// whoami is available; when it is not, the caller passes "session-present" or
// "unknown" explicitly (the shell knows whether the engine answered 200 or not).
export function accessVerdictFromCaller(caller: Caller | null, whoamiAvailable: boolean): AccessVerdict {
  if (whoamiAvailable && caller) {
    if (caller.method === "access") {
      return caller.identityProvider !== undefined
        ? { state: "verified", email: caller.email, identityProvider: caller.identityProvider }
        : { state: "verified", email: caller.email };
    }
    // A passkey session is a verified, attributable identity (the WebAuthn assertion proved the
    // credential's bound email), so it is an honest trust state with its OWN copy: it is NOT Cloudflare
    // Access (no edge policy ran) and NOT the shared token (it is attributable). Never folded into the
    // amber token fallback, which would slander an attributable, hardware-backed sign-in as the
    // anyone-with-the-URL break-glass.
    if (caller.method === "passkey") {
      return { state: "passkey-verified", email: caller.email };
    }
    // A NATIVE IdP session (the engine's own OIDC/SAML, merged and live). The engine verified the
    // assertion itself and the session is attributable to an email, so it is a verified trust state and gets
    // one. These two methods were not in the console's union at all: every OIDC and SAML customer fell through
    // to the amber break-glass claim below and was told their fleet ran on the shared token, on every render.
    // The fix for that is not to silence the chip, it is for the chip to say what is true.
    if (caller.method === "oidc" || caller.method === "saml") {
      return { state: "idp-verified", email: caller.email, protocol: caller.method };
    }
    // A recovery-code sign-in: verified and attributable, but it is the break-glass-adjacent door, so it is
    // neither slandered as the shared token nor presented as an ordinary day's sign-in. Its own state.
    if (caller.method === "recovery") {
      return { state: "recovery-verified", email: caller.email };
    }
    // THE FALL-THROUGH WAS A FALSE CLAIM ABOUT THE CUSTOMER'S SECURITY POSTURE. Every method that was not
    // `access` or `passkey` returned token-fallback, so an engine that adds ANY new sign-in method would have
    // this console tell its customer, in amber, that their fleet is running on the shared break-glass token: the
    // anyone-with-the-URL credential. It is the worst thing the chip can say and it would be untrue, and the
    // customer's remedy ("rotate the token, we are exposed") would be a scramble against nothing.
    //
    // The break-glass posture is now claimed ONLY for the method that IS the break-glass. Anything else is a
    // method this console build cannot interpret, and the honest verdict is `unknown`: we do not know what this
    // session is, so we make no claim about it in either direction. The unrecognised method string never rides
    // (it is engine-supplied and could be corrupt); the row says only that the class was not one we know.
    if (caller.method === "token") {
      return { state: "token-fallback" };
    }
    recordWireAnomaly("auth-method", "unknown-enum");
    return { state: "unknown" };
  }
  return { state: "unknown" };
}

// _testChipTone is exported for the validate-components test so the mirror
// contract between the chip and the verdict panel can be asserted without DOM rendering.
// Not part of the public API.
export function _testChipTone(verdict: AccessVerdict): "trust" | "warn" | "neutral" {
  return present(verdict).tone;
}

// accessChip renders the honest Access verdict. The verified state uses the teal
// trust family + the shield-check glyph + the email; the cautious states use amber;
// the unknown state is neutral. NEVER a bare permanent green (F7).
export function accessChip(verdict: AccessVerdict): HTMLElement {
  const { tone, glyph, label, email, title } = present(verdict);
  // The email rides in its OWN span so the top bar can hide it (and the chip never wraps to a second
  // line) on a narrow viewport, leaving just the verdict word with the full detail still in the title
  // tooltip. The combined textContent ("<verdict>: <email>") is unchanged, so the accessible name and the
  // chip's verdict vocabulary are preserved.
  return h(
    "span",
    { class: `trust-chip trust-chip--${tone}`, title },
    h("span", { class: "trust-chip__icon" }, svgIcon(glyph, { size: 14 })),
    h("span", { class: "trust-chip__label" }, label, email ? h("span", { class: "trust-chip__email" }, `: ${email}`) : null),
  );
}

function present(v: AccessVerdict): { tone: "trust" | "warn" | "neutral"; glyph: string; label: string; email?: string; title: string } {
  switch (v.state) {
    case "verified":
      return {
        tone: "trust",
        glyph: ICON_SHIELD_CHECK,
        label: "Access verified",
        ...(v.email ? { email: v.email } : {}),
        title: v.identityProvider
          ? `Protected by Cloudflare Access; passed Access policy via ${v.identityProvider}. The engine reports this request was Access-verified.`
          : "Protected by Cloudflare Access; passed Access policy. The engine reports this request was Access-verified.",
      };
    case "passkey-verified":
      return {
        tone: "trust",
        glyph: ICON_SHIELD_CHECK,
        label: "Passkey verified",
        ...(v.email ? { email: v.email } : {}),
        title: "Signed in with a passkey (WebAuthn) the engine verified. This is the engine's own sign-in, attributable to your email, independent of Cloudflare Access. No password or key was sent to the console.",
      };
    case "idp-verified":
      return {
        tone: "trust",
        glyph: ICON_SHIELD_CHECK,
        label: v.protocol === "saml" ? "SAML verified" : "OIDC verified",
        ...(v.email ? { email: v.email } : {}),
        title:
          v.protocol === "saml"
            ? "Signed in through your identity provider over SAML, verified by the engine itself. Attributable to your email and independent of Cloudflare Access."
            : "Signed in through your identity provider over OIDC, verified by the engine itself. Attributable to your email and independent of Cloudflare Access.",
      };
    case "recovery-verified":
      return {
        tone: "trust",
        glyph: ICON_SHIELD_CHECK,
        label: "Recovery code used",
        ...(v.email ? { email: v.email } : {}),
        title: "Signed in with a recovery code the engine verified. Attributable to your email. Recovery codes are single-use; enrol a passkey or an identity provider to return to your ordinary sign-in.",
      };
    case "token-fallback":
      return {
        tone: "warn",
        glyph: ICON_ALERT,
        label: "Token fallback in use",
        title: "Cloudflare Access is not enforced in front of the engine; anyone with this URL and the shared token can administer it. Harden with Access or a passkey.",
      };
    case "session-present":
      return {
        tone: "warn",
        glyph: ICON_INFO,
        label: "Session present (method unknown)",
        title: "An authenticated session is present, but the engine does not yet report whether it was Access or the token fallback (whoami pending).",
      };
    case "unverified":
      return {
        tone: "warn",
        glyph: ICON_ALERT,
        label: "Access session not valid",
        title: "The engine returned 401: your Cloudflare Access session is not valid. Re-authenticate via Access.",
      };
    case "unknown":
      return {
        tone: "neutral",
        glyph: ICON_INFO,
        label: "Access status unknown",
        title: "Could not determine the Access verdict (the engine could not be reached). This is honest unknown, never a stale green.",
      };
  }
}

// NO_CUSTODY_SCOPE is the SCOPING that makes the chip's short label true. The label alone
// ("your key is never sent to us") is the claim; this sentence is the qualification that bounds it
// (generated here, downloaded to you, never transmitted, no upload path, no engine binding).
//
// It is exported because the qualification must not live ONLY in the chip's title attribute. A
// title is revealed by hover alone: it is unreachable by keyboard (the chip is a non-focusable
// span), it does nothing on a touch device, and a generic span's title is not announced as a
// description by assistive tech. That left the unqualified label as the whole claim for every
// reader who does not use a mouse, which is a stronger claim than the product intends to make.
// The Overview pairs the chip with a focusable info-tip carrying THIS SAME STRING (see
// screens/overview/header.ts), so the scoping is reachable by keyboard, touch and screen reader.
// One constant, so the tooltip and the tip can never drift into two different qualifications.
//
// The wording is owner-blessed copy. Do not edit it here; it is quoted verbatim in both places.
export const NO_CUSTODY_SCOPE =
  "No-custody: your break-glass private key is generated in this browser and downloaded for you to keep. It is never transmitted to the engine or to us, the vendor: there is no upload path in this console, and the engine has no binding for it.";

// noCustodyChip is a CONSTANT true statement (not a verdict): the break-glass private key is
// generated in this browser and never sent to us. It is downloaded for the owner to keep (that is
// the whole point: they hold it for offline recovery), so it does leave the browser onto their own
// disk; what makes it no-custody is that it is never transmitted to the engine or the vendor. The
// old label ("key never left this browser") overstated that, since the key is downloaded. Trust
// family + the lock glyph; earned by construction (keygen.ts is local; there is no upload path).
//
// The title is KEPT: it costs a mouse user nothing and removing it would be a regression for them.
// It is simply no longer the only carrier of the qualification.
export function noCustodyChip(): HTMLElement {
  return h(
    "span",
    {
      class: "trust-chip trust-chip--trust",
      title: NO_CUSTODY_SCOPE,
    },
    h("span", { class: "trust-chip__icon" }, svgIcon(ICON_LOCK, { size: 14 })),
    h("span", { class: "trust-chip__label" }, "No-custody: your key is never sent to us"),
  );
}
