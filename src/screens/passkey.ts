// The PASSKEY sign-in screen (IA route /passkey): the engine's OWN WebAuthn front door, so a team can
// administer downpipes WITHOUT Cloudflare Access (which is not free over 50 users) and WITHOUT the shared
// ADMIN_TOKEN break-glass. It drives the four engine endpoints (POST /admin/auth/register/begin,
// register/finish, login/begin, login/finish; plus logout) through the typed EngineClient methods in
// api.ts. The engine is the authority: every ceremony is bound to a server-issued, single-use, short-TTL
// challenge, the clientData origin is checked against CONSOLE_ORIGIN and the rpIdHash against the rp.id,
// and (login) the assertion signature is verified with the stored COSE key, all in the scheduler DO. A
// verified finish sets the hardened __Host- session cookie (credentials:"include"), and the app then boots
// to the role-appropriate view via the same whoami the Access path uses.
//
// NO-CUSTODY: nothing secret is generated or held here. The passkey private key never leaves the
// authenticator; the console only relays the WebAuthn options the engine issued and the public credential
// the authenticator returned. There is no upload of any key material.
//
// STRICT CSP: built entirely with the h() builder. There is NO inline <script>, NO inline <style>
// attribute (dynamic styling goes through the CSSOM via h()'s style handling), and NO inline event-handler
// attribute (the `on:` map wires real addEventListener listeners from this bundled code). navigator.
// credentials.create/get are ordinary Web API calls from the bundle, which CSP does not gate.
//
// This screen is FULL-BLEED (registered in app.ts FULL_BLEED): the shell chrome (rail, context bar) is
// hidden, so the screen owns its single h1, mirroring the signed-out screen. House style: Australian
// English, no em dashes.
//
// This file is the COORDINATOR: it owns the screen descriptor (route, title, measure, render, the full-bleed
// sign-in body) and re-exports the symbols external callers (the passkey-login / idp / recovery-ui validators
// and app.ts) depend on. The PURE ceremony helpers (decode the begin options; encode the returned credential;
// map an error to honest copy; the feature-detect; the inline banners; the one-shot prefill + auth-known
// state) live in the ./passkey/ceremony.ts leaf; the login / step-up / register / bootstrap / recovery flows,
// the recovery form and the external-IdP buttons in ./passkey/flows.ts. The render() BODY builders (parse the
// route intent; the card heading and email field; the buttons + busy machinery + click wiring; the
// register-lead and normal two-view layouts) live in ./passkey/sign-in-body.ts, so render() is left a short
// coordinator that wires the engine and shared status host into those pieces. The file was split for size
// while keeping the public surface byte-identical.

import { h } from "../lib/dom.ts";
import { brandMark } from "../shell/brand.ts";
import type { Field } from "../components/field.ts";
import { banner } from "../components/feedback.ts";
import { getEngine, restoreConnection } from "../lib/store.ts";
import { navigate } from "../lib/nav.ts";
import type { RouteMatch } from "../lib/router.ts";
import type { Screen } from "./common.ts";
import { webauthnSupported, readWebAuthnGlobals, authKnownHere } from "./passkey/ceremony.ts";
import {
  parseSignInIntent,
  buildCardHeader,
  buildEmailField,
  buildSignInControls,
  renderRegisterLeadLayout,
  renderNormalSignInLayout,
} from "./passkey/sign-in-body.ts";

// Re-exports: the passkey-login, idp and recovery-ui validators (and app.ts) import the pure ceremony
// helpers, their structural credential types, and the flows BY NAME from this module, so the split keeps
// every one of those imports working unchanged. The pure helpers live in ./passkey/ceremony.ts (browser-API
// free, so the validator drives them in Node); the flows live in ./passkey/flows.ts; re-exporting them here
// keeps the public import surface of screens/passkey.ts byte-identical.
export {
  webauthnSupported,
  readWebAuthnGlobals,
  creationOptionsFromBegin,
  requestOptionsFromBegin,
  attestationCredentialToWire,
  assertionCredentialToWire,
  reasonMessage,
  passkeyErrorMessage,
  recoveryTransportMessage,
  type WebAuthnGlobals,
  type AttestationCredentialLike,
  type AssertionCredentialLike,
  type PasskeyReason,
} from "./passkey/ceremony.ts";
export {
  runLogin,
  runStepUp,
  runStepUpOutcome,
  runRegister,
  runBootstrapSend,
  runRecovery,
  providerButtonLabel,
  mountProviderButtons,
} from "./passkey/flows.ts";

// ---- The screen ---------------------------------------------------------------------------------

// passkeyScreen is the full-bleed sign-in surface. It is reachable directly at /passkey and is where the
// auth UX routes an unauthenticated-but-reachable engine (app.ts), so a team without Cloudflare Access has
// a real sign-in rather than a dead 401. It offers two flows: sign in with an existing passkey, and set up
// a new passkey (the first registrant becomes Owner). It has no engine-gated palette actions (there is no
// authenticated role here yet), so actions is [] (console-passkey-1).
export const passkeyScreen: Screen = {
  // This screen owns BOTH the plain /passkey sign-in AND the /register enrolment route: an invite link
  // points at ${CONSOLE_ORIGIN}/#/register?invite=<token>. The /register ROUTE forces the set-up (register)
  // layout whether or not a token is present (the recovery flow's enrolNext lands here tokenless); ?invite=
  // additionally threads the token to the engine so the credential binds to the invited email. /register is
  // also in app.ts's FULL_BLEED set (it is the same pre-auth, no-chrome landing as /passkey).
  route: ["/passkey", "/register"],
  title: "Sign in",
  measure: "prose",
  actions: [],
  render(match: RouteMatch) {
    // The parsed route intent (where a successful sign-in returns, the opaque invite token, the
    // register-lead decision, and the one-shot prefill email). Factored into sign-in-body.ts for size.
    const intent = parseSignInIntent(match);
    const { registerLead } = intent;

    const page = h("main", { class: "ob-page", id: "main", tabindex: "-1" });
    const inner = h("div", {
      style: [
        "flex:1 1 auto",
        "display:flex",
        "flex-direction:column",
        "align-items:center",
        "justify-content:center",
        "padding:var(--space-8) var(--space-4)",
        "gap:var(--space-5)",
      ].join(";"),
    });
    inner.appendChild(
      h("div", { style: "display:flex;justify-content:center", "aria-hidden": "true" }, brandMark({ size: 32 })),
    );

    // The card widens with its content: the sparse sign-in view stays a calm narrow column, while
    // the denser "first time here" help view grows toward the carousel's width so it does not read
    // as a cramped narrow stack (owner: "far too narrow when I click first time here"). The width is
    // set per view below; the transition makes the change feel like the carousel rather than a jump.
    const card = h("div", { class: "card measure", style: "width:100%;max-width:460px;transition:max-width 0.35s var(--ease-out)" });
    // The heading and honest sub-line (set-up vs sign-in, invite vs self-add); factored into sign-in-body.ts.
    // A browser that has completed a passkey sign-in here before gets the warmer heading.
    const knownHere = authKnownHere();
    buildCardHeader(card, intent, knownHere);

    // A status host for the inline result/error (banner). It is an aria-live region so a screen-reader
    // hears the outcome; it starts empty.
    const statusHost = h("div", { style: "margin-bottom:var(--space-3)", role: "status", "aria-live": "polite" });
    const setStatus = (node: HTMLElement | null): void => {
      statusHost.replaceChildren();
      if (node) {
        statusHost.appendChild(node);
        // Keep the result visible next to the action that produced it (the help view can
        // be tall). Guarded: not every runtime (the validator shim) implements it.
        if (typeof statusHost.scrollIntoView === "function") statusHost.scrollIntoView({ block: "nearest" });
      }
    };

    // Feature detection: without the WebAuthn API there is nothing to offer. Show an honest notice and the
    // alternatives (Access / token), and render NO ceremony buttons (a button that would throw is worse
    // than an honest "not supported"). This is the no-WebAuthn-support branch the contract names.
    const supported = webauthnSupported(readWebAuthnGlobals());

    // The sign-in needs an engine to talk to. After a sign-out the in-memory client is cleared but the
    // engine URL is remembered, so rebuild a token-free client from it here (the same restore boot does);
    // this is what lets "sign out -> sign back in" work without re-entering the engine URL. It returns the
    // existing client when one is connected, so it is a safe no-op on the normal path.
    const engine = getEngine() ?? restoreConnection();
    if (!engine) {
      // Still no engine (no remembered URL at all): the sign-in needs an engine to talk to. Send the
      // operator to connect first; this mirrors requireEngine() without importing the shell.
      card.appendChild(
        banner({
          tone: "info",
          message: "Connect to your engine first, then sign in with a passkey.",
          action: { label: "Connect to an engine", onClick: () => navigate("/onboarding/connect", { replace: true }) },
        }),
      );
      inner.appendChild(card);
      page.appendChild(inner);
      return page;
    }

    if (!supported) {
      card.appendChild(
        banner({
          tone: "warn",
          message:
            "This browser does not support passkeys (WebAuthn). Use a current browser on a secure (https) connection, or sign in via Cloudflare Access or the admin token instead.",
        }),
      );
      inner.appendChild(card);
      page.appendChild(inner);
      return page;
    }

    // The email field (optional for sign-in, required for set-up); built in sign-in-body.ts.
    const emailField: Field = buildEmailField(intent);
    if (registerLead) card.appendChild(emailField.el);

    // The four buttons, the busy machinery (one in-flight at a time), the success + recovery-codes hooks,
    // the recovery-form slot, and every click wiring, built in sign-in-body.ts. The status host and setStatus
    // stay owned here (the aria-live region with the scrollIntoView guard); the layouts below share these
    // controls.
    const controls = buildSignInControls(engine, emailField, intent, statusHost, setStatus);
    if (registerLead) {
      renderRegisterLeadLayout(card, intent, controls);
    } else {
      renderNormalSignInLayout(card, engine, intent, knownHere, controls);
    }

    inner.appendChild(card);
    page.appendChild(inner);
    return page;
  },
};
