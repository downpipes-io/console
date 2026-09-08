// The TRUST / VERDICT surface. The expanded companion to the
// compact accessChip in trust-chips.ts: a panel the Access screen and the Overview use
// to state a verdict in full, and a generic verdict surface for any honest verdict
// (the audit chain-intact / break state, a connection probe result).
//
// The disqualifying-if-shipped rule lives here as hard as in the chip: the Access
// verdict panel NEVER shows a hardcoded green. It derives its tone from the SAME honest
// AccessVerdict union the chip uses (trust-chips.ts), which is reached only from a real
// whoami(method:"access") for the verified (teal) state; everything else degrades to
// amber (token fallback / unverified / session-present) or neutral (unknown /
// unreachable), and the copy observes only what the JWT proves ("passed Cloudflare
// Access policy"), never "used a second factor". The panel does not invent a verdict;
// the screen resolves the real AccessVerdict and hands it in.
//
// Status is hue + SHAPE (a glyph) + a text label in every state, never colour alone
// (WCAG 1.4.1). A11y: the panel is a role="status" region so a verdict update is
// announced; the glyph is decorative (the heading + body carry the meaning). Built from
// dom.ts + tokens.css; it reuses the trust-chip's verdict vocabulary rather than
// duplicating it.

import { h, svgIcon, type Child } from "../lib/dom.ts";
import {
  ICON_SHIELD_CHECK,
  ICON_LOCK,
  ICON_INFO,
  ICON_ALERT,
  ICON_CHECK,
  ICON_X_CIRCLE,
} from "../lib/icons.ts";
import { accessChip, type AccessVerdict } from "./trust-chips.ts";

// The three honest tones a verdict surface can carry. "trust" is the verified teal
// family (distinct from action and from ok-status); "warn" is the cautious amber;
// "neutral" is the honest unknown. There is deliberately no plain "ok/green" tone for
// the ACCESS verdict (a green Access badge that is not actually verified is the F7
// finding); a non-Access verdict surface (audit chain) may use "ok" via verdictSurface.
export type VerdictTone = "trust" | "warn" | "neutral";

// accessVerdictPanel renders the full Access verdict (the Access screen's hero). It
// reads the real AccessVerdict (the screen resolves it from whoami / 200-vs-401) and
// presents the matching honest state, with a "harden this" affordance on the cautious
// states (a path to enforce Access) when the caller supplies one. NEVER a stale green.
export function accessVerdictPanel(opts: {
  verdict: AccessVerdict;
  // An optional action on the cautious states (token-fallback / unverified): a path to
  // the Access wizard ("harden this"). Not shown on the verified state.
  hardenAction?: { label: string; onClick: () => void };
  // An optional re-authenticate action on the unverified/unknown states.
  reauthAction?: { label: string; onClick: () => void };
}): HTMLElement {
  const p = presentAccess(opts.verdict);

  const card = h("div", { class: `verdict verdict--${p.tone}`, role: "status" });

  const head = h(
    "div",
    { class: "verdict__head" },
    h("span", { class: "verdict__icon", "aria-hidden": "true" }, svgIcon(p.glyph, { size: 22 })),
    h("div", { class: "verdict__headtext" }, h("h2", { class: "verdict__title" }, p.title)),
  );
  card.appendChild(head);

  card.appendChild(h("p", { class: "verdict__body" }, p.body));

  // The honest caveat line: what this verdict does and does NOT prove. Always present,
  // so the surface never overclaims (it states "passed Access policy", not "2FA used").
  card.appendChild(h("p", { class: "verdict__caveat field__hint" }, p.caveat));

  // Actions: the cautious states offer "harden" / re-auth; the verified state offers
  // neither (there is nothing to fix). The unknown state offers re-auth/retry only.
  const actions = h("div", { class: "verdict__actions" });
  if ((opts.verdict.state === "token-fallback" || opts.verdict.state === "session-present") && opts.hardenAction) {
    actions.appendChild(
      h("button", { "data-dp": "components-verdict.button.click#1", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => opts.hardenAction!.onClick() } }, opts.hardenAction.label),
    );
  }
  if ((opts.verdict.state === "unverified" || opts.verdict.state === "unknown") && opts.reauthAction) {
    actions.appendChild(
      h("button", { "data-dp": "components-verdict.button.click#2", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => opts.reauthAction!.onClick() } }, opts.reauthAction.label),
    );
  }
  if (actions.childElementCount > 0) card.appendChild(actions);

  return card;
}

// presentAccess maps the honest AccessVerdict to the panel's tone + glyph + copy. It
// mirrors trust-chips.ts present() exactly so the chip and the panel never disagree;
// the verified state is the only teal/trust state and it is reached only from a real
// access verdict (the union guarantees this; the screen cannot fabricate it).
//
// _testPresentAccessTone is exported for the validate-components test so the
// mirror contract can be asserted without DOM rendering. Not part of the public API.
export function _testPresentAccessTone(v: AccessVerdict): VerdictTone {
  return presentAccess(v).tone;
}

// AccessPresentation is the resolved panel copy for one verdict state. The two
// identity-bearing states (verified, passkey-verified) read v.email / v.identityProvider,
// so those build their object inline; the remaining four are fixed copy, hoisted to named
// constants below so each case is a trivial dispatch and each copy is independently editable.
type AccessPresentation = { tone: VerdictTone; glyph: string; title: string; body: string; caveat: string };

const TOKEN_FALLBACK_PRESENTATION: AccessPresentation = {
  tone: "warn",
  glyph: ICON_ALERT,
  title: "Token fallback in use",
  body:
    "Cloudflare Access is not enforced in front of the engine. Anyone with this URL and the shared admin token can administer it, and actions cannot be attributed to a person. This is the documented lower-assurance break-glass path.",
  caveat: "Harden this by putting the engine behind Cloudflare Access or signing in with a passkey, then this surface reports the verified identity instead.",
};

const SESSION_PRESENT_PRESENTATION: AccessPresentation = {
  tone: "warn",
  glyph: ICON_INFO,
  title: "Session present, method not yet reported",
  body:
    "An authenticated session reached the engine, but the engine does not yet report whether it was Cloudflare Access or the token fallback (whoami is pending). The console will not claim a verified method it cannot back.",
  caveat: "Once the engine reports the method, this surface distinguishes Access-verified from the token fallback.",
};

const UNVERIFIED_PRESENTATION: AccessPresentation = {
  tone: "warn",
  glyph: ICON_ALERT,
  title: "Access session not valid",
  body:
    "The engine returned 401: your Cloudflare Access session is not valid for this request. Re-authenticate via Cloudflare Access to continue. Authentication happens at the edge, not in this console.",
  caveat: "If this persists after re-authenticating, your Access policy may not grant this identity.",
};

const UNKNOWN_PRESENTATION: AccessPresentation = {
  tone: "neutral",
  glyph: ICON_INFO,
  title: "Access status unknown",
  body:
    "The Access verdict could not be determined because the engine could not be reached. This is shown as an honest unknown, never a stale verified state.",
  caveat: "Check the engine is reachable on its custom domain, then re-check.",
};

function presentAccess(v: AccessVerdict): AccessPresentation {
  switch (v.state) {
    case "verified":
      return {
        tone: "trust",
        glyph: ICON_SHIELD_CHECK,
        title: v.email ? `Access verified as ${v.email}` : "Access verified",
        body: v.identityProvider
          ? `This request passed your Cloudflare Access policy via ${v.identityProvider}. The engine verified the Access assertion server-side; the console did not and cannot read the token itself.`
          : "This request passed your Cloudflare Access policy. The engine verified the Access assertion server-side; the console did not and cannot read the token itself.",
        caveat:
          "This proves the request passed your Access policy. It does not, on its own, report which factors that policy required; configure which factors your policy requires (MFA, IP allowlisting, SSO, and so on) in Cloudflare Access.",
      };
    case "passkey-verified":
      return {
        tone: "trust",
        glyph: ICON_SHIELD_CHECK,
        title: v.email ? `Passkey session as ${v.email}` : "Passkey session",
        body:
          "You signed in with a passkey; the engine verified that signature once, then issued this browser a session cookie. Every request since, including this one, is checked against the cookie's signature and expiry, not your authenticator, so your password manager can stay locked and this stays true. Sign out ends the session immediately; signing back in needs the passkey again.",
        caveat:
          "Want a stricter posture? Put Cloudflare Access in front of the engine (IP allowlisting, SSO factor policy); the two run together.",
      };
    case "idp-verified":
      return {
        tone: "trust",
        glyph: ICON_SHIELD_CHECK,
        title: v.email ? `${v.protocol === "saml" ? "SAML" : "OIDC"} session as ${v.email}` : `${v.protocol === "saml" ? "SAML" : "OIDC"} session`,
        body:
          v.protocol === "saml"
            ? "You signed in through your own identity provider over SAML. The engine verified the assertion against your provider's certificate server-side and issued this browser a session cookie; the console never saw your credentials. This is the engine's own sign-in, attributable to your email, and it runs independently of Cloudflare Access."
            : "You signed in through your own identity provider over OIDC. The engine verified the token against your provider's keys server-side and issued this browser a session cookie; the console never saw your credentials. This is the engine's own sign-in, attributable to your email, and it runs independently of Cloudflare Access.",
        caveat:
          "Want a stricter posture? Put Cloudflare Access in front of the engine as well (IP allowlisting, SSO factor policy); the two run together.",
      };
    case "recovery-verified":
      return {
        tone: "trust",
        glyph: ICON_SHIELD_CHECK,
        title: v.email ? `Recovery-code session as ${v.email}` : "Recovery-code session",
        body:
          "You signed in with a recovery code. The engine verified it and issued this browser a session cookie; the code is single-use and is now spent. This is an attributable sign-in, not the shared break-glass token.",
        caveat:
          "Recovery codes are the door you use when your ordinary one is unavailable. Re-enrol a passkey or your identity provider, and generate a fresh set of codes, so you are not down to your last one.",
      };
    case "token-fallback":
      return TOKEN_FALLBACK_PRESENTATION;
    case "session-present":
      return SESSION_PRESENT_PRESENTATION;
    case "unverified":
      return UNVERIFIED_PRESENTATION;
    case "unknown":
      return UNKNOWN_PRESENTATION;
  }
}

// noCustodyPanel is the expanded companion to the no-custody chip: a CONSTANT true
// statement (not a verdict), that the break-glass private is generated in this browser
// and never leaves it. It is the trust the product earns by construction (keygen.ts
// generates it locally; there is no upload path anywhere), so it is always shown in the
// trust (teal) family with the lock glyph. It NEVER reads a value or a private
// fingerprint (the recovery sheet carries only public fingerprints).
export function noCustodyPanel(): HTMLElement {
  const card = h("div", { class: "verdict verdict--trust", role: "note" });
  card.appendChild(
    h(
      "div",
      { class: "verdict__head" },
      h("span", { class: "verdict__icon", "aria-hidden": "true" }, svgIcon(ICON_LOCK, { size: 22 })),
      h("div", { class: "verdict__headtext" }, h("h2", { class: "verdict__title" }, "No-custody, by construction")),
    ),
  );
  card.appendChild(
    h(
      "p",
      { class: "verdict__body" },
      "Your break-glass private key is generated in this browser and is never transmitted to the engine or to the vendor. There is no path in this console that uploads it, and the engine has no binding for it.",
    ),
  );
  card.appendChild(
    h("p", { class: "verdict__caveat field__hint" }, "The recovery sheet carries only public fingerprints. Keep the downloaded key files safe; once downloaded, they are on this device's disk."),
  );
  return card;
}

// A generic, honest verdict tone for the non-Access verdict surface. Here "ok"/green is
// permitted because it is a real computed result (the audit chain recomputed cleanly),
// not an Access badge. "danger" carries a genuine negative result (a chain break).
export type GenericVerdictTone = "ok" | "warn" | "danger" | "info" | "neutral" | "trust";

function genericGlyph(tone: GenericVerdictTone): string {
  switch (tone) {
    case "ok": return ICON_CHECK;
    case "danger": return ICON_X_CIRCLE;
    case "warn": return ICON_ALERT;
    case "trust": return ICON_SHIELD_CHECK;
    case "info":
    case "neutral":
      return ICON_INFO;
  }
}

// verdictSurface is the generic honest-verdict panel for results that are NOT the
// Access verdict: the audit chain-verify result ("intact through entry N" /
// "break detected at entry N"), a connection probe, a readiness summary. Status is hue
// + shape (glyph) + label; a break is a RESULT, not an error, so a danger verdict here
// is rendered calmly as the detection the tamper-evident design exists to provide. The
// copy must remain precise (tamper-evident, never tamper-proof) at the call site.
export function verdictSurface(opts: {
  tone: GenericVerdictTone;
  title: string;
  body?: Child;
  // An optional glyph override; defaults to a per-tone glyph.
  glyph?: string;
  // An optional action (e.g. "Re-verify", "View export").
  action?: { label: string; onClick: () => void };
  // The ARIA role: "status" for a polite result (default), "alert" for a genuine
  // interrupt the caller wants announced assertively.
  assertive?: boolean;
}): HTMLElement {
  const glyph = opts.glyph ?? genericGlyph(opts.tone);
  const card = h("div", { class: `verdict verdict--${opts.tone}`, role: opts.assertive ? "alert" : "status" });
  card.appendChild(
    h(
      "div",
      { class: "verdict__head" },
      h("span", { class: "verdict__icon", "aria-hidden": "true" }, svgIcon(glyph, { size: 20 })),
      h("div", { class: "verdict__headtext" }, h("h3", { class: "verdict__title" }, opts.title)),
    ),
  );
  if (opts.body !== undefined && opts.body !== null && opts.body !== false) {
    const bodyEl = h("p", { class: "verdict__body" });
    if (typeof opts.body === "string" || typeof opts.body === "number") bodyEl.appendChild(document.createTextNode(String(opts.body)));
    else bodyEl.appendChild(opts.body as Node);
    card.appendChild(bodyEl);
  }
  if (opts.action) {
    card.appendChild(
      h(
        "div",
        { class: "verdict__actions" },
        h("button", { "data-dp": "components-verdict.button.click#3", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => opts.action!.onClick() } }, opts.action.label),
      ),
    );
  }
  return card;
}

// A small re-export so a screen that wants the compact chip and the panel imports both
// from one trust surface module, while the chip's honest verdict logic stays single-
// sourced in trust-chips.ts (no duplication of the F7-critical mapping).
export { accessChip };
export type { AccessVerdict };
