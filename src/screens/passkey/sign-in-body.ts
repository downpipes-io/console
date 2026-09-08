// The passkey sign-in BODY builders: the named sub-functions the passkey coordinator's render() composes,
// factored out for size while keeping the runtime behaviour byte-identical. Nothing here changes control flow
// or values; each function is a verbatim slice of the former render() with its inputs passed explicitly.
//
// The pieces are: parse the route intent (next / invite token / register-lead / one-shot prefill); build the
// card header (heading + honest sub-line); build the optional email field; lay out the register-lead enrolment
// card; and lay out the normal two-view sign-in card (sign-in view + "first time here, or need another way
// in?" help view). The coordinator owns the early-return guards (no engine, no WebAuthn) and the shared
// closures (busy, setBusy, onSuccess, the buttons, the slots); it hands them in.
//
// STRICT CSP: every node is built with the h() builder; no inline script/style/handler. House style:
// Australian English, no em dashes.

import { h } from "../../lib/dom.ts";
import { field, type Field } from "../../components/field.ts";
import { recoveryCodesPanel } from "../../components/recovery-codes-panel.ts";
import type { RouteMatch } from "../../lib/router.ts";
import type { EngineClient } from "../../api.ts";
import {
  isEmailish,
  takeRegisterPrefillEmail,
  successBanner,
  downloadText,
  markAuthKnownHere,
} from "./ceremony.ts";
import {
  runLogin,
  runRegister,
  runBootstrapSend,
  mountProviderButtons,
  mountRecoveryForm,
  renderAdminTokenBlock,
} from "./flows.ts";
import { navigate, onAuthenticated, refreshIdentity } from "../../lib/nav.ts";

// The parsed route intent the body builders share: where a successful sign-in returns, the opaque invite
// token (when reached via an invite link), whether to LEAD with set-up, and the one-shot prefill email.
export interface SignInIntent {
  next: string;
  inviteToken: string | undefined;
  registerLead: boolean;
  prefillEmail: string | null;
}

// parseSignInIntent derives the route intent from the RouteMatch: the preserved same-origin next, the opaque
// invite token, the register-lead decision (an invite, or the /register route), and the one-shot prefill the
// recovery flow's enrolNext handed over. Moved verbatim from render().
export function parseSignInIntent(match: RouteMatch): SignInIntent {
  // The intended URL, preserved (app.ts sets ?next= when routing here on a 401) so a successful sign-in
  // returns the operator where they were going. Only same-origin in-app paths are honoured (NC-12):
  // must start with "/" and not start with "//".
  const rawNext = match.query.get("next");
  const next = rawNext?.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

  // The passkey INVITE token, when this screen was reached via a role-grant invite link
  // (${CONSOLE_ORIGIN}/#/register?invite=<token>, the /register route also lands here). When an invite is
  // present we FORCE the set-up (register) flow rather than offering login first: an invited teammate has
  // no passkey yet, so signing in is impossible; they need to enrol. The token is threaded to runRegister
  // -> both passkeyRegister* calls so the engine binds the new credential to the email the invite was
  // minted for. The console treats the value as opaque (no parsing); an empty/absent value is no invite.
  const rawInvite = match.query.get("invite");
  const inviteToken = rawInvite && rawInvite !== "" ? rawInvite : undefined;

  // /register leads with SET-UP even without a token: the recovery flow's enrolNext lands
  // here after promising "set up a new passkey now", and an operator who just lost their
  // passkey must not face a screen whose primary is "Sign in with a passkey" with enrolment
  // buried in a disclosure. The token only changes what is THREADED, never the layout.
  const registerLead = inviteToken !== undefined || match.path === "/register";
  // The email the recovery sign-in used, handed over by enrolNext (module-level, consumed
  // once) so the fresh-passkey enrolment does not re-ask for what was just typed.
  const prefillEmail = registerLead ? takeRegisterPrefillEmail() : null;

  return { next, inviteToken, registerLead, prefillEmail };
}

// buildCardHeader appends the heading and the honest sub-line to the card. Moved verbatim from render().
export function buildCardHeader(card: HTMLElement, intent: SignInIntent, knownHere: boolean): void {
  const { inviteToken, registerLead } = intent;
  // /register owns an enrolment heading (the arrival is setting up a passkey, not signing
  // in); otherwise it is the normal sign-in heading. A browser that has completed a
  // passkey sign-in here before gets the warmer heading; the affordances are identical
  // (the hint is presentation only, set in onSuccess below, never an authority signal).
  card.appendChild(
    h(
      "h1",
      { class: "card__title", style: "margin-bottom:var(--space-2);font-size:var(--text-lg)" },
      registerLead ? "Set up your passkey" : knownHere ? "Welcome back" : "Sign in to the console",
    ),
  );

  // The honest sub-line: this is the engine's own passkey sign-in, an alternative to Cloudflare Access,
  // never a claim that Access is in use. On an invite the line tells the teammate to enrol the passkey for
  // the email the invite was sent to (the engine already binds the credential to that email and the
  // granted role, so no owner-bootstrap framing belongs here); a tokenless /register arrival (the
  // recovery flow's "set up a new passkey now") enrols for their own account.
  card.appendChild(
    h(
      "p",
      { style: "color:var(--text-muted);margin-bottom:var(--space-4)" },
      inviteToken
        ? "This link sets up your passkey. Enter the email it was sent to; your device does the rest."
        : registerLead
          ? "Set up a new passkey for your account. Enter your email; your device does the rest."
          : "Your device signs you in. No password.",
    ),
  );
}

// buildEmailField builds the email Field for the sign-in / set-up card. Moved verbatim from render().
export function buildEmailField(intent: SignInIntent): Field {
  const { inviteToken, registerLead, prefillEmail } = intent;
  // The email field is OPTIONAL for sign-in (a resident passkey can be offered usernameless) and
  // REQUIRED for set-up (the engine keys the account on it). A light email-shape check keeps an obvious
  // typo from a round trip; the engine is the real validator.
  return field({
    id: "pk-email",
    label: "Email",
    type: "email",
    ...(prefillEmail ? { value: prefillEmail } : {}),
    placeholder: "you@example.com",
    autocomplete: "username webauthn",
    hint: inviteToken
      ? "The email your invite was sent to."
      : registerLead
        ? "The email your engine knows you by."
        : "Optional to sign in (your device offers its saved passkey); required to set up a new one.",
    doc: { href: "https://docs.downpipes.io/identity-access/overview", anchor: "four-independent-ways-in" },
    validate: (v) => (v === "" ? null : isEmailish(v) ? null : "Enter a valid email address."),
  });
}

// The shared body controls the layout builders wire: the buttons, the slots, and the status host, all owned
// by render() so its click handlers and busy state stay in one place.
export interface SignInControls {
  loginBtn: HTMLElement;
  registerBtn: HTMLElement;
  recoveryBtn: HTMLButtonElement;
  bootstrapBtn: HTMLButtonElement;
  recoveryFormSlot: HTMLElement;
  statusHost: HTMLElement;
  setStatus: (node: HTMLElement | null) => void;
}

// buildSignInControls builds the four buttons (sign in / set up / recovery / bootstrap), the busy machinery
// (one in-flight at a time, per-button progress label), the success + recovery-codes hooks, the recovery-form
// slot, and wires every click to its flow. Moved verbatim from render(); the status host + setStatus are
// owned by render (the aria-live region with the scrollIntoView guard) and handed in. Returns the controls the
// layout builders consume.
export function buildSignInControls(
  engine: EngineClient,
  emailField: Field,
  intent: SignInIntent,
  statusHost: HTMLElement,
  setStatus: (node: HTMLElement | null) => void,
): SignInControls {
  const { next, inviteToken } = intent;
  // ONE primary action per state (the owner's calm rule: a sign-in screen is not a menu of
  // scenarios). Signing in leads; everything first-time lives behind one "First time here?"
  // disclosure below. On a /register landing "Set up a passkey" is the primary affordance
  // instead (the arrival has no usable passkey yet). Each is a real <button type="button">
  // with an addEventListener click (CSP safe; no inline handler), disabled during an
  // in-flight ceremony so a double-press cannot start two prompts.
  const loginBtn = h("button", { "data-dp": "passkey.button.login", class: intent.registerLead ? "btn btn--secondary" : "btn btn--primary", type: "button", style: "width:100%" }, "Sign in with a passkey");
  const registerBtn = h("button", { "data-dp": "passkey.button.register", class: intent.registerLead ? "btn btn--primary" : "btn btn--secondary", type: "button", style: "width:100%" }, "Set up a passkey");

  // The "lost your passkey" affordance: a quiet link that swaps in the recovery-code form
  // (email + code -> recoverWithCode). Offline break-glass entry; always available, never loud.
  const recoveryBtn = h("button", { "data-dp": "passkey.button.recovery", class: "linklike", type: "button", style: "margin-top:var(--space-3)" }, "Lost your passkey? Use a recovery code") as HTMLButtonElement;

  // The FIRST-RUN affordance: ask the engine to email the set-up link to the owner address the
  // DEPLOYER set (the BOOTSTRAP_OWNER_EMAIL secret; the engine ignores any client-supplied
  // address). The engine is a strict no-oracle on this route, so the console cannot know
  // whether a first Owner exists, the affordance therefore lives inside the "First time
  // here?" disclosure with copy that reads honestly either way, instead of as a fourth
  // always-visible button.
  const bootstrapBtn = h("button", { "data-dp": "passkey.button.bootstrap", class: "btn btn--secondary btn--sm", type: "button" }, "Email the owner a set-up link") as HTMLButtonElement;

  let busy = false;
  const setBusy = (b: boolean, activeLabel?: string): void => {
    busy = b;
    loginBtn.disabled = b;
    registerBtn.disabled = b;
    recoveryBtn.disabled = b;
    bootstrapBtn.disabled = b;
    // Reflect progress on the pressed button's label without losing the others' text:
    // a press that merely greys four buttons gives no in-flight signal on the control
    // that was actually pressed.
    if (b && activeLabel === "login") loginBtn.textContent = "Signing in...";
    else loginBtn.textContent = "Sign in with a passkey";
    if (b && activeLabel === "register") registerBtn.textContent = "Setting up...";
    else registerBtn.textContent = "Set up a passkey";
    if (b && activeLabel === "bootstrap") bootstrapBtn.textContent = "Sending...";
    else bootstrapBtn.textContent = "Email the owner a set-up link";
  };

  // showRecoveryCodes mounts the one-time recovery-codes panel into the status host (replacing the card's
  // result area) and defers the post-success boot until the operator confirms they saved the codes. It is
  // passed to runRegister so an enrolment that returns codes shows them unmissably before signing in.
  const showRecoveryCodes = (codes: string[], proceed: () => void): void => {
    setStatus(
      recoveryCodesPanel({
        codes,
        context: "enrol",
        downloadText,
        onConfirm: () => {
          setStatus(successBanner("Recovery codes saved. Signing you in..."));
          proceed();
        },
      }),
    );
  };

  // onSuccess: a verified finish set the session cookie. Hand off to the app's onAuthenticated boot
  // (lib/nav.ts), which navigates to the preserved `next` (default "/", which Overview redirects per
  // role) and re-resolves the verified identity so the shell chip + role are real and the per-role
  // landing applies on this first successful resolve. onAuthenticated never throws (a transient whoami
  // failure leaves the next guarded navigation to re-resolve), so the flow's finally still clears busy.
  const onSuccess = async (): Promise<void> => {
    markAuthKnownHere();
    await onAuthenticated(next);
  };

  loginBtn.addEventListener("click", () => {
    if (busy) return;
    void runLogin(engine, emailField.value(), { setStatus, setBusy, onSuccess });
  });
  registerBtn.addEventListener("click", () => {
    if (busy) return;
    // Set-up requires a valid email (the account key). Validate the field and focus it on failure.
    if (!emailField.validate() || emailField.value() === "") {
      emailField.setError("Enter your email to set up a passkey.");
      emailField.focus();
      return;
    }
    // Thread the invite token (when this is an invite enrolment) so the engine binds the new credential to
    // the invited email; it is undefined on the normal self-add path, leaving that POST unchanged. The
    // showRecoveryCodes hook makes an enrolment's one-time codes appear unmissably before the boot.
    void runRegister(engine, emailField.value(), { setStatus, setBusy, onSuccess, showRecoveryCodes }, inviteToken);
  });

  // The recovery-form slot: empty until "Use a recovery code" is pressed, then it holds the email + code
  // form. Kept as its own host so swapping it in/out never disturbs the passkey buttons above.
  const recoveryFormSlot = h("div", { class: "passkey-recovery-slot" });

  // The "Use a recovery code" path swaps the card body to the recovery form (the email + a single code).
  // mountRecoverySwap owns the enrolNext "/register" navigation; it re-shows the set-up flow after a
  // recovery sign-in that asked for a fresh passkey, prefilled with the recovery email.
  recoveryBtn.addEventListener("click", () => {
    if (busy) return;
    mountRecoverySwap(recoveryFormSlot, engine, { setStatus, setBusy, onSuccess }, emailField.value());
  });

  bootstrapBtn.addEventListener("click", () => {
    if (busy) return;
    void runBootstrapSend(engine, { setStatus, setBusy, onSuccess });
  });

  return { loginBtn, registerBtn, recoveryBtn, bootstrapBtn, recoveryFormSlot, statusHost, setStatus };
}

// renderRegisterLeadLayout lays out the enrolment card (an invite link, the bootstrap email, or the recovery
// flow's "set up a new passkey now"): set-up leads; signing in is the quiet alternative. Moved verbatim from
// render(); appends to the card in place.
export function renderRegisterLeadLayout(card: HTMLElement, intent: SignInIntent, controls: SignInControls): void {
  const { loginBtn, registerBtn, recoveryFormSlot, statusHost } = controls;
  // The enrolment landing carries the email field, the set-up flow and (on success) the
  // recovery-codes panel, so it gets the wider carousel-style measure, not the narrow column.
  card.style.maxWidth = "600px";
  // Enrolment landing (an invite link, the bootstrap email, or the recovery flow's
  // "set up a new passkey now"): set-up leads; signing in is the quiet alternative for
  // someone who already enrolled. The recovery and first-run affordances are
  // irrelevant here, and so is owner-bootstrap framing: an invite already binds the
  // email and the granted role, and a bootstrap arrival learns "you are the Owner" at
  // the moment it becomes true (the success banner).
  loginBtn.classList.remove("btn--secondary");
  loginBtn.classList.add("btn--ghost", "btn--sm");
  loginBtn.style.setProperty("margin-top", "var(--space-2)");
  card.appendChild(h("div", { style: "margin-top:var(--space-4)" }, registerBtn, loginBtn));
  // A bare /register arrival (no invite token, no recovery hand-over) will hit the engine's
  // enrolment gate: say up front what enrolment actually needs, rather than letting the
  // attempt fail into a reason after the ceremony.
  if (!intent.inviteToken && !intent.prefillEmail) {
    card.appendChild(
      h(
        "p",
        { class: "field__hint", style: "margin-top:var(--space-3)" },
        "Enrolment needs the invite link from your Owner's email, the owner set-up email, or an admin-token sign-in first.",
      ),
    );
    // The admin-token sign-in lands exactly here with no attributable identity resolved yet
    // (the token block connects the client and navigates straight to /register without ever
    // calling whoami), and this screen offers no role-grant control of its own. Invite your
    // team, the onboarding carousel's team step, is the one place a token session can grant
    // the Owner role to a NEW email before that person registers, which is what lets the token
    // be retired afterwards (a second Owner is one of the two ways back in identity-and-access
    // requires before it allows the retire). The click resolves identity first (refreshIdentity)
    // so the token's Owner authority is recognised by the time the invite form's roles.write
    // gate reads it, rather than landing the operator on a screen that reads "no permission".
    card.appendChild(
      h(
        "p",
        { class: "field__hint", style: "margin-top:var(--space-2)" },
        "Signed in with the admin token? ",
        h(
          "button",
          {
            "data-dp": "passkey.button.navigate-onboarding-invite",
            class: "linklike",
            type: "button",
            on: {
              click: () => {
                void refreshIdentity();
                navigate("/onboarding/invite");
              },
            },
          },
          "Invite your team",
        ),
        " grants the Owner role to a new email, so a second Owner exists before you retire the token.",
      ),
    );
  }
  card.appendChild(recoveryFormSlot);
  card.appendChild(statusHost);
}

// renderNormalSignInLayout lays out the normal two-view sign-in card: view one is the bare passkey sign-in,
// view two ("first time here, or need another way in?") lays out the situations as separated single-action
// blocks. Moved verbatim from render(); appends to the card in place and renders the sign-in view.
export function renderNormalSignInLayout(
  card: HTMLElement,
  engine: EngineClient,
  intent: SignInIntent,
  knownHere: boolean,
  controls: SignInControls,
): void {
  const { loginBtn, registerBtn, recoveryBtn, bootstrapBtn, recoveryFormSlot, statusHost, setStatus } = controls;
  // Normal sign-in: TWO VIEWS, one decision each (the owner's rule: a sign-in
  // screen is never a menu of scenarios). View one is the sign-in: the primary
  // passkey button and nothing else to weigh up. View two ("first time here, or
  // need another way in?") lays out the situations as separated single-action
  // blocks: new engine (email the owner the set-up link), lost passkey (recovery
  // code), plus the quiet add-a-passkey path. The status host sits ABOVE the views
  // so a result lands adjacent to the button that produced it, not below the
  // stacked help sections and off-viewport.
  const viewHost = h("div");
  card.appendChild(statusHost);
  card.appendChild(viewHost);

  registerBtn.classList.add("btn--sm");
  registerBtn.style.setProperty("width", "auto");

  const renderSignInView = (): void => {
    // The calm, sparse sign-in width (returning here from the help view narrows it back).
    card.style.maxWidth = "460px";
    // No email-first / "older security keys" toggle and no inline "set up a passkey": signing in
    // is usernameless (the device offers its saved passkey), and a passkey is only ever SET UP by
    // accepting an invite link or right after an admin-token sign-in (owner direction: don't ask
    // someone with no account to configure a passkey, and don't offer old-style email logins).
    const helpTrigger = knownHere
      ? h("button", { "data-dp": "passkey.button.help-trigger#1", class: "linklike", type: "button", style: "margin-top:var(--space-3)" }, "First time here, or need another way in?")
      : h("button", { "data-dp": "passkey.button.help-trigger#2", class: "btn btn--ghost", type: "button", style: "width:100%;margin-top:var(--space-2)" }, "First time here, or need another way in?");
    helpTrigger.addEventListener("click", () => renderHelpView());
    // The external-IdP "Sign in with X" buttons (native OIDC / OAuth2 / SAML), when the engine has
    // any ENABLED connections. They mount ABOVE the passkey button (a top-level window.location nav
    // to the engine's start URL), but the passkey + token affordances ALWAYS stay visible below
    // (the no-lockout rule): an external IdP is additive, never the only way in. The slot starts
    // empty and is filled asynchronously; if the providers list is empty or the fetch fails, nothing
    // renders here at all (fail-open, no error noise).
    const providerSlot = h("div");
    mountProviderButtons(providerSlot, engine, intent.next);
    viewHost.replaceChildren(
      providerSlot,
      h("div", { style: "margin-top:var(--space-2)" }, loginBtn),
      h("div", { style: "display:grid" }, helpTrigger),
    );
  };

  const renderHelpView = (): void => {
    // The help view carries the dense first-time + recovery content, so widen the card toward
    // the carousel's measure rather than cramming it into the narrow sign-in column.
    card.style.maxWidth = "600px";
    const back = h("button", { "data-dp": "passkey.button.back", class: "linklike", type: "button" }, "Back to sign in");
    back.addEventListener("click", () => {
      setStatus(null);
      renderSignInView();
    });

    // The invited case is one unheaded hint, not a headed section: a block whose
    // whole content is "nothing to do here" only pushed the actionable sections down.
    const invited = h(
      "p",
      { class: "field__hint", style: "margin:0" },
      "Invited? The link in your email lands you straight in set-up.",
    );

    // The shared bearer token (ADMIN_TOKEN) sign-in block: the FIRST-TIME way in when no owner email
    // was set at deployment (and the break-glass otherwise). It signs the client in directly, then
    // routes to passkey set-up so the operator becomes a named Owner and can retire the shared token.
    const adminToken = renderAdminTokenBlock();

    const firstTime = h(
      "section",
      { class: "stack-sm", style: "display:grid;gap:var(--space-3)" },
      h("h2", { class: "field__label" }, "First time here"),
      // TWO preconditions, both named. The emailed link needs an owner address pinned at deploy
      // time AND email sending on the Cloudflare account, and a deployment can have the first
      // without the second (engine /admin/setup-state reports emailConfigured separately). The
      // engine answers this route as a strict NO ORACLE, so the console cannot check either one
      // before the press and must not imply that it has. Naming only the address, as this hint
      // once did, sent a customer whose account has no Email Service to a dead end and then told
      // them the admin-token block below was not for them.
      h(
        "p",
        { class: "field__hint", style: "margin:0" },
        "A one-time set-up link goes to the owner address pinned at deployment, never to an address typed here (one use, 24 hours). It needs two things the deployer set: that address, and email sending on the Cloudflare account. This screen cannot check either, so the send looks the same either way.",
      ),
      h("div", bootstrapBtn),
      h("p", { class: "field__hint", style: "margin:0;margin-top:var(--space-2)" }, "No link arrived, or no owner address was set at deployment? Sign in with the admin token instead. It needs no email, and it leads to the same passkey set-up:"),
      adminToken,
    );

    const lost = h(
      "section",
      { class: "stack-sm" },
      h("h2", { class: "field__label" }, "You lost your passkey"),
      h("p", { class: "field__hint", style: "margin:0" }, "Sign in once with one of the single-use recovery codes you saved at set-up, then enrol a fresh passkey."),
      h("div", recoveryBtn),
    );
    recoveryBtn.textContent = "Use a recovery code";

    // No "add a passkey to an existing account" here: a passkey is set up by accepting an invite
    // link or right after an admin-token sign-in, never offered to a visitor with no account.

    viewHost.replaceChildren(
      h(
        "div",
        { class: "stack-sm", style: "display:grid;gap:var(--space-5);margin-top:var(--space-2)" },
        invited,
        firstTime,
        lost,
        // The honest alternatives line lives HERE, with the other ways in, not as a
        // standing footer on every view.
        h(
          "p",
          { class: "field__hint", style: "margin:0" },
          "This is the engine's own sign-in; Cloudflare Access still works if your engine uses it. A passkey is only set up by accepting an invite link, or right after an admin-token sign-in.",
        ),
        h("div", back),
      ),
    );
  };

  renderSignInView();
  card.appendChild(recoveryFormSlot);
}

// The recovery-form swap handler: the "Use a recovery code" path mounts the email + code form into the slot.
// Built here so the layout module owns the navigate import; render() wires the click. Moved verbatim.
export function mountRecoverySwap(
  recoveryFormSlot: HTMLElement,
  engine: EngineClient,
  handles: Parameters<typeof mountRecoveryForm>[2],
  currentEmail: string,
): void {
  // enrolNext re-shows the set-up flow after a recovery sign-in that asked for a fresh passkey: it routes
  // to /register, which leads with set-up even without an invite token (registerLead) and prefills the
  // email the recovery sign-in used, so the operator immediately enrols a new passkey, which then issues a
  // fresh set of codes. The same-origin /register navigation is safe (a static route).
  const enrolNext = (): void => navigate("/register", { replace: true });
  mountRecoveryForm(recoveryFormSlot, engine, handles, enrolNext, currentEmail);
}
