// The passkey sign-in flows and the external-IdP sign-in buttons: the login / step-up / register /
// bootstrap-send / recovery-code ceremonies (each composes the pure ceremony helpers + navigator.credentials
// + the engine api), the recovery-code form, and the "Sign in with <provider>" buttons for native OIDC /
// OAuth2 / SAML connections. The flows are exported so the validator can drive the REAL flow with a stubbed
// engine + navigator and assert the request bodies and the success/cancel/unknown handling. Moved verbatim
// from the passkey coordinator for size; they import the shared ceremony leaf (./ceremony.ts) one way, so they
// never form a cycle.
//
// NO-CUSTODY: nothing secret is generated or held here. The passkey private key never leaves the
// authenticator; the console only relays the WebAuthn options the engine issued and the public credential the
// authenticator returned. House style: Australian English, no em dashes.

import type { EngineClient, IdpProvider } from "../../api.ts";
import { banner } from "../../components/feedback.ts";
import { type Field, field } from "../../components/field.ts";
import { toast } from "../../components/toast.ts";
import { h } from "../../lib/dom.ts";
import { isUnauthorised, noteStepUpFailure, type StepUpFailure, stepUpFailureMessage } from "../../lib/errors.ts";
import { navigate } from "../../lib/nav.ts";
import { connect } from "../../lib/store.ts";
import {
  type AssertionCredentialLike,
  type AttestationCredentialLike,
  assertionCredentialToWire,
  attestationCredentialToWire,
  creationOptionsFromBegin,
  DOMExceptionLike,
  errorBanner,
  isBrowserCeremonyRefusal,
  isEmailish,
  markAuthKnownHere,
  passkeyErrorMessage,
  reasonMessage,
  recoveryTransportMessage,
  registerFailureBanner,
  requestOptionsFromBegin,
  setRegisterPrefillEmail,
  successBanner,
} from "./ceremony.ts";

// renderAdminTokenBlock builds the shared-bearer-token (ADMIN_TOKEN) sign-in block in the help view: the
// FIRST-TIME way in when no owner email was set at deployment (and the break-glass otherwise). It signs the
// client in directly (connect with the token, prove the authenticated surface answers), then sends the
// operator STRAIGHT to passkey set-up so they become a named Owner and can retire the shared token (owner
// direction: "once I use the admin token, let me create the first owner and set up my passkey").
export function renderAdminTokenBlock(): HTMLElement {
  const tokenInput = h("input", { "data-dp": "passkey.password.token",
    class: "input",
    type: "password",
    autocomplete: "off",
    "aria-label": "Admin token",
    placeholder: "the engine's ADMIN_TOKEN value",
    style: "flex:1;min-width:0",
  }) as HTMLInputElement;
  const tokenErr = h("p", { class: "field__error", role: "alert", hidden: true });
  const tokenBtn = h("button", { "data-busy-label": "Checking", "data-dp": "passkey.button.token", class: "btn btn--secondary btn--sm", type: "button" }, "Sign in with the admin token") as HTMLButtonElement;
  tokenBtn.addEventListener("click", () => {
    const value = tokenInput.value.trim();
    if (value === "") {
      tokenErr.textContent = "Paste the token first.";
      tokenErr.hidden = false;
      return;
    }
    tokenErr.hidden = true;
    tokenBtn.disabled = true;
    tokenBtn.textContent = "Checking";
    const client = connect(location.origin, value);
    void client
      .status()
      .then(() => {
        tokenInput.value = "";
        // Authenticated via the token. Send them to set up a passkey now: enrolling the first
        // passkey makes them the Owner, so they get a named account and can stop using the
        // shared token. They are free to navigate away if they only needed the token briefly.
        markAuthKnownHere();
        navigate("/register");
      })
      .catch(() => {
        tokenErr.textContent = "The engine refused that token. Check the value, or use a recovery code.";
        tokenErr.hidden = false;
        tokenBtn.disabled = false;
        tokenBtn.textContent = "Sign in with the admin token";
      });
  });
  return h(
    "div",
    { class: "stack-sm" },
    h("p", { class: "field__hint", style: "margin:0" }, "For an engine deployed with the ADMIN_TOKEN secret. It is shared and unattributable, so once you are in you will set up your own passkey and become a named Owner, then retire the token from the Security centre."),
    h("div", { style: "display:flex;gap:var(--space-2);align-items:center" }, tokenInput, tokenBtn),
    tokenErr,
  );
}

// ---- External-IdP "Sign in with X" buttons (native OIDC / OAuth2 / SAML) -------------------------

// providerButtonLabel is the button text for one enabled provider: "Sign in with <label>". The label is
// the operator-chosen connection display name (customer data); it is rendered as a text node by the
// caller, never as markup. A PURE function so the validator can pin it.
export function providerButtonLabel(provider: { label: string }): string {
  return `Sign in with ${provider.label}`;
}

// mountProviderButtons fetches the engine's ENABLED IdP connections (the pre-auth providers DTO) and, when
// there are any, renders one "Sign in with <label>" button each into `slot`, ABOVE the passkey button. A
// click navigates the TOP-LEVEL window to the engine's start URL for that connection (oidc/oauth2 ->
// /admin/oidc/start/<id>, saml -> /admin/saml/start/<id>), threading the relative-only `returnTo` so a
// successful sign-in lands back where the operator was headed; the code<->token exchange is server-side in
// the engine (no CSP change needed, this is a top-level navigation, not a connect-src/form-action call).
//
// It is FAIL-OPEN by construction (the no-lockout rule, and the contract's "empty or failed -> just
// passkey + token, no error noise"): the providers read NEVER blocks the passkey UI (the slot starts empty
// and is filled asynchronously), an empty list renders nothing, and any failure is swallowed so the
// sign-in screen simply shows passkey + token. The passkey + token affordances always remain visible
// below this slot, so an external IdP is purely additive, never the only way in.
export function mountProviderButtons(slot: HTMLElement, engine: EngineClient, returnTo: string): void {
  void engine
    .idpProviders()
    .then((res) => {
      const providers: IdpProvider[] = Array.isArray(res?.providers) ? res.providers : [];
      if (providers.length === 0) return; // nothing enabled: passkey + token only (fail-open, no noise)
      slot.replaceChildren(renderProviderButtons(engine, providers, returnTo));
    })
    .catch(() => {
      // A 404/501 (engine without the IdP routes), a transport fault, or anything else: show NOTHING here
      // and leave passkey + token as the way in. Never an error banner on the sign-in screen.
    });
}

// renderProviderButtons builds the providers block: a stacked "Sign in with X" button per provider, then a
// quiet "or" rule above the passkey button below it. Each button is a real <button type="button"> with an
// addEventListener (CSP-safe, no inline handler) that performs the top-level navigation.
function renderProviderButtons(engine: EngineClient, providers: IdpProvider[], returnTo: string): HTMLElement {
  const wrap = h("div", { class: "stack-sm", style: "display:grid;gap:var(--space-2)" });
  for (const provider of providers) {
    const btn = h("button", { "data-dp": "passkey.button.provider-buttons", class: "btn btn--secondary", type: "button", style: "width:100%" }, providerButtonLabel(provider)) as HTMLButtonElement;
    btn.addEventListener("click", () => {
      // A top-level window navigation to the engine's start URL. window.location is governed by neither
      // connect-src nor form-action, so no CSP exemption is needed; the engine sets the txn cookie and
      // 302s to the IdP. Guarded for the validator's non-browser runtime (no window.location.assign there).
      const url = engine.idpStartUrlFor(provider, returnTo);
      if (typeof window !== "undefined" && typeof window.location?.assign === "function") window.location.assign(url);
      else if (typeof window !== "undefined") window.location.href = url;
    });
    wrap.appendChild(btn);
  }
  // The quiet separator between the IdP buttons and the passkey button below them, so the two ways in read
  // as alternatives rather than a wall of buttons.
  wrap.appendChild(h("div", { class: "field__hint", style: "text-align:center;margin-top:var(--space-1)" }, "or"));
  return wrap;
}

// ---- The two flows (compose the pure helpers + navigator.credentials + the engine api) ----------

// FlowHandles is the small surface the flows use to talk back to the screen: set the inline status node,
// toggle the busy state, and run the post-success boot. Kept explicit so the flows are driven the same way
// in production and (with stubs) under the validator.
//
// showRecoveryCodes is the OPTIONAL one-time-codes hook: when an enrolment returns recoveryCodes, the flow
// hands them here and the screen mounts the unmissable one-time panel, THEN calls back to continue the
// post-success boot once the operator has confirmed they saved them. It is what gates onSuccess behind the
// save-confirm on enrolment. The screen wires it; the validator stubs it. When absent (or when no codes are
// issued) the flow falls back to running onSuccess directly, so a login (which never issues codes) and an
// older engine both behave exactly as before.
export interface FlowHandles {
  setStatus: (node: HTMLElement | null) => void;
  setBusy: (b: boolean, activeLabel?: string) => void;
  onSuccess: () => Promise<void>;
  showRecoveryCodes?: (codes: string[], proceed: () => void) => void;
}

// runLogin drives the login ceremony end to end: login/begin -> decode the request options -> navigator
// .credentials.get -> encode the assertion -> login/finish (with the challengeId begin issued). On a
// verified finish (the engine set the cookie) it runs onSuccess; on a coarse { ok:false } it shows the
// reason copy; a thrown error (cancel/timeout/transport) maps through passkeyErrorMessage. It is exported
// so the validator can drive the real flow with a stubbed engine + navigator and assert the request bodies
// and the success/cancel/unknown handling.
export async function runLogin(engine: EngineClient, email: string, handles: FlowHandles): Promise<void> {
  handles.setStatus(null);
  handles.setBusy(true, "login");
  try {
    const begin = await engine.passkeyLoginBegin(email !== "" ? email : undefined);
    if (!begin.ok) {
      handles.setStatus(errorBanner(reasonMessage(begin.reason, "login")));
      return;
    }
    const options = requestOptionsFromBegin(begin.publicKey);
    const assertion = (await navigator.credentials.get({ publicKey: options })) as PublicKeyCredential | null;
    if (!assertion) {
      // A null result (no credential chosen) is treated like a cancel: honest, not an error toast.
      handles.setStatus(errorBanner(passkeyErrorMessage(new DOMExceptionLike("NotAllowedError"), "login")));
      return;
    }
    const wire = assertionCredentialToWire(assertion as unknown as AssertionCredentialLike);
    const finish = await engine.passkeyLoginFinish(begin.challengeId, wire);
    if (!finish.ok) {
      handles.setStatus(errorBanner(reasonMessage(finish.reason, "login")));
      return;
    }
    // Verified: the cookie is set. Boot to the role-appropriate view.
    await handles.onSuccess();
  } catch (err) {
    // A 401 here would be unusual (the finish is unauthenticated). Either way, stay honest and
    // surface the cancel/transport copy rather than bouncing to the signed-out view.
    handles.setStatus(errorBanner(passkeyErrorMessage(err, "login")));
  } finally {
    handles.setBusy(false);
  }
}

// StepUpOutcome is what the step-up ceremony actually did. Its siblings above hand their outcome to a screen
// through FlowHandles; this one is invoked by the TRANSPORT, from inside whatever action the operator was
// taking, so there is no screen to hand it to and the outcome has to be carried instead of shown.
export type StepUpOutcome =
  | { ok: true; token: string }
  | { ok: false; reason: StepUpFailure };

// runStepUpOutcome drives the STEP-UP re-auth ceremony (ASVS V7.5.1 / V7.5.3): stepup/begin -> decode the
// request options -> navigator.credentials.get (a fresh assertion by one of the caller's OWN passkeys) ->
// encode -> stepup/finish -> a single-use step-up token. It reuses the EXACT decode/encode the login ceremony
// uses, so a step-up assertion is verified identically.
//
// IT ANNOUNCES ITSELF, which is the whole of the change here. Its two siblings set a status node and a busy
// label before they touch navigator.credentials; this one did neither, so the browser's passkey sheet arrived
// with nothing in front of it, in the middle of an action the operator had already confirmed. There is no
// FlowHandles to write into (the transport calls this, not a screen), so the announcement goes to the shared
// live region: an info toast that names the prompt before it opens, and is dismissed the moment the ceremony
// ends either way. `handles` is optional and lets a screen that HAS a status slot drive this exactly as it
// drives login and register.
//
// AND IT SAYS WHICH WAY IT ENDED. Returning a bare null made a refused begin, a dismissed prompt, a device
// with no passkey and a rejected finish into one indistinguishable answer, which is why the copy downstream
// had to cover all of them in one sentence. Three of the four are distinguishable here and are reported; the
// null credential and the thrown NotAllowedError are one state by the platform's design and are merged
// deliberately (see StepUpFailure in lib/errors.ts).
export async function runStepUpOutcome(engine: EngineClient, handles?: Partial<FlowHandles>): Promise<StepUpOutcome> {
  noteStepUpFailure(null);
  handles?.setStatus?.(null);
  handles?.setBusy?.(true, "step-up");
  const dismissAnnounce = toast({
    message: "Confirm with your passkey to continue.",
    tone: "info",
    durationMs: 0,
  });
  const end = (outcome: StepUpOutcome): StepUpOutcome => {
    dismissAnnounce();
    handles?.setBusy?.(false);
    if (!outcome.ok) {
      noteStepUpFailure(outcome.reason);
      handles?.setStatus?.(errorBanner(stepUpFailureMessage(outcome.reason)));
    }
    return outcome;
  };
  // ONE BARE CATCH USED TO COVER THREE DIFFERENT FAILURES, AND ANSWERED FOR ALL OF THEM WITH THE ONE
  // SENTENCE THAT TELLS THE OPERATOR TO ENROL ANOTHER PASSKEY. It caught a
  // browser refusal, a transport fault and a genuine cancel alike and reported `no-assertion`, whose copy
  // ends "this device has no passkey enrolled for you and you can enrol one from Security". For an account
  // whose credential list is over the browser's measured 64-entry ceiling, no prompt appears, that advice
  // is wrong, and following it adds a credential to an account that already cannot get back under. See
  // stepUpFailureMessage.
  //
  // So each await now says which failure it is. The cancel/timeout/no-credential merge is PRESERVED
  // exactly: WebAuthn answers a dismissed prompt and a device with no matching credential with the same
  // NotAllowedError on purpose, and splitting those would be guessing.
  let begin: Awaited<ReturnType<EngineClient["stepUpBegin"]>>;
  try {
    begin = await engine.stepUpBegin();
  } catch {
    return end({ ok: false, reason: "check-unavailable" });
  }
  if (!begin.ok) return end({ ok: false, reason: "begin-refused" });

  let assertion: PublicKeyCredential | null;
  try {
    const options = requestOptionsFromBegin(begin.publicKey);
    assertion = (await navigator.credentials.get({ publicKey: options })) as PublicKeyCredential | null;
  } catch (err) {
    if (isBrowserCeremonyRefusal(err)) {
      // The message is logged rather than rendered: a DOMException message can carry the rp id and other
      // deployment detail, exactly as the sibling branches in passkeyErrorMessage do.
      console.error("step-up ceremony refused by the browser", err);
      return end({ ok: false, reason: "browser-refused" });
    }
    return end({ ok: false, reason: "no-assertion" });
  }
  if (!assertion) return end({ ok: false, reason: "no-assertion" });

  try {
    const wire = assertionCredentialToWire(assertion as unknown as AssertionCredentialLike);
    const finish = await engine.stepUpFinish(begin.challengeId, wire);
    if (!finish.ok) return end({ ok: false, reason: "finish-refused" });
    return end({ ok: true, token: finish.stepUpToken });
  } catch {
    return end({ ok: false, reason: "check-unavailable" });
  }
}

// runStepUp is the shape the transport injects (store.ts setStepUpRunner): a token, or null when the
// ceremony did not complete. The reason rides in lib/errors.ts's single slot rather than in the return type,
// because gatedFetch surfaces the ORIGINAL 401 on a null and there is nowhere in that 401 to put it.
export async function runStepUp(engine: EngineClient): Promise<string | null> {
  const outcome = await runStepUpOutcome(engine);
  return outcome.ok ? outcome.token : null;
}

// runRegister drives the registration ceremony: register/begin -> decode the creation options -> navigator
// .credentials.create -> encode the attestation -> register/finish. On a verified finish the engine stored
// the credential, set the cookie, and (for the first registrant) bootstrapped Owner; it runs onSuccess. A
// coarse { ok:false } shows the reason copy (e.g. already_registered; a forbidden refusal also offers the
// connect-with-token step); a thrown error maps through passkeyErrorMessage. Exported for the validator to
// drive with stubs.
//
// inviteToken is the OPTIONAL single-use, email-bound passkeyInvite token from a role-grant invite link
// (the screen reads it from ?invite= and threads it here). When present it is passed to BOTH register/begin
// and register/finish so the engine's invite path binds the new credential to the email the invite was
// minted for, not the client-supplied email. It is omitted on the self-add / first-registrant bootstrap
// path (no invite), so those POSTs are byte-for-byte unchanged. The console never inspects the token; it is
// the engine's own opaque invite id (no-custody).
export async function runRegister(engine: EngineClient, email: string, handles: FlowHandles, inviteToken?: string): Promise<void> {
  handles.setStatus(null);
  handles.setBusy(true, "register");
  try {
    const begin = await engine.passkeyRegisterBegin(email, undefined, inviteToken);
    if (!begin.ok) {
      handles.setStatus(registerFailureBanner(begin.reason, () => void runBootstrapSend(engine, handles)));
      return;
    }
    const options = creationOptionsFromBegin(begin.publicKey);
    const cred = (await navigator.credentials.create({ publicKey: options })) as PublicKeyCredential | null;
    if (!cred) {
      handles.setStatus(errorBanner(passkeyErrorMessage(new DOMExceptionLike("NotAllowedError"), "register")));
      return;
    }
    const wire = attestationCredentialToWire(cred as unknown as AttestationCredentialLike);
    // STEP-UP UNANNOUNCED: the engine gates register/finish only on the SELF-ADD path, an already
    // authenticated cookie session enrolling a second credential (router-auth-flow.ts: the requireStepUp
    // call is inside `sub === "register/finish" && verdict.ok && isCookieBorneMethod(verdict.method)`).
    // This console reaches runRegister from ONE place, the sign-in screen's enrol form, on the bootstrap and
    // invite paths, and both are unauthenticated so neither is gated. A warning here would promise a prompt
    // that never opens. It would also be the wrong warning even where it did: the operator is two lines past
    // navigator.credentials.create, so the browser sheet they are looking at is the enrolment they asked for.
    const finish = await engine.passkeyRegisterFinish(email, wire, undefined, inviteToken);
    if (!finish.ok) {
      handles.setStatus(registerFailureBanner(finish.reason, () => void runBootstrapSend(engine, handles)));
      return;
    }
    // Verified + cookie set. The engine issues the one-time recovery codes ONCE here on a successful
    // enrolment; if present, show them in the unmissable one-time panel FIRST and defer the boot until the
    // operator confirms they saved them (the panel cannot be dismissed unacknowledged). This is the
    // break-glass; the boot must not race past it. When no codes were issued (a re-enrolment, or an older
    // engine) or the screen wired no panel, fall back to the brief success + boot exactly as before.
    const codes = finish.recoveryCodes;
    if (codes !== undefined && codes.length > 0 && handles.showRecoveryCodes) {
      // The busy state is cleared now: the ceremony is done and the operator must interact with the panel
      // (copy/download/confirm) before the boot continues, so the buttons should not stay frozen.
      handles.setBusy(false);
      // STAGED-RECOVERY-CODES-CONFIRM-GATE: recoveryCodesPending:true means these codes are
      // STAGED, not yet live (a self-add over an existing set -- the forced re-enrolment after a
      // recovery-code sign-in is the common case). The operator's OLD codes are still the working ones; they
      // only become dead once confirmRecoveryCodes tells the engine the fresh set shown here is saved. That
      // call is what "Continue" on the save-confirm panel must make BEFORE the boot proceeds, or the panel
      // would be showing codes that never actually took effect while the operator believes they have. A
      // failed or lost confirm is never treated as a failed enrolment (the credential is already stored and
      // the operator is already signed in): it is best-effort, and its only cost on failure is that the OLD
      // codes remain the working set, which is the safe outcome this whole mechanism exists to preserve.
      const proceed = (): void => void handles.onSuccess();
      handles.showRecoveryCodes(codes, () => {
        if (finish.recoveryCodesPending !== true) {
          proceed();
          return;
        }
        engine.confirmRecoveryCodes().then(proceed, proceed);
      });
      return;
    }
    // Surface a brief success (the bootstrap Owner note if applicable) then boot.
    if (finish.bootstrapped) {
      handles.setStatus(successBanner("Passkey set up. You are the Owner of this engine. Signing you in..."));
    } else {
      handles.setStatus(successBanner("Passkey set up. Signing you in..."));
    }
    await handles.onSuccess();
  } catch (err) {
    handles.setStatus(errorBanner(passkeyErrorMessage(err, "register")));
  } finally {
    handles.setBusy(false);
  }
}

// runBootstrapSend drives the FIRST-RUN "email the owner a set-up link" request: POST
// /admin/auth/bootstrap/send. The engine is a strict NO ORACLE on this route (the same generic
// { ok:true } whether it mailed the link, is already bootstrapped, or is not configured for the
// email-link first run), so the one success copy is honestly conditional and the flow learns nothing
// about the engine's state. Only a TRANSPORT fault maps through passkeyErrorMessage. Exported for the
// validator to drive with stubs.
export async function runBootstrapSend(engine: EngineClient, handles: FlowHandles): Promise<void> {
  handles.setStatus(null);
  handles.setBusy(true, "bootstrap");
  try {
    await engine.bootstrapSendLink();
    // The help section already states where the link goes and its one-use/24-hour terms;
    // this banner does not restate them (and names no env var). The Email Service
    // troubleshooting belongs here, AFTER the press, not as failure prose beside an
    // unpressed button.
    //
    // WHY THIS NAMES MORE THAN THE EMAIL SERVICE. The banner used to give exactly one cause, "the
    // account needs Cloudflare Email Service set up". On a stock deployment that is the LEAST likely
    // blocker. The engine checks the owner address FIRST (router-auth-flow.ts:627, skip
    // "owner-email-not-configured"), and that address is a per-deployment secret which is deliberately
    // never committed, so a fresh engine fails there before the Email Service is even reached. And past
    // that, the sender address ships as a committed default on a domain the customer does not own
    // (wrangler.toml EMAIL_FROM), which passes the engine's own validator and then fails at the
    // platform with a sender-domain error. So the single-cause banner sent an operator to the
    // Cloudflare dashboard to fix something that was probably not their problem, and gave them nothing
    // to check for the two that were.
    //
    // The console cannot narrow this down: the route is a strict no-oracle by design, and the engine's
    // emailConfigured flag does not settle it either (it reads neither the owner address nor the
    // invite sender, and is true out of the box). So the honest form is to name what has to be true,
    // say plainly that this screen cannot check any of it, and keep the route that needs none of it
    // immediately beside the uncertainty.
    handles.setStatus(
      banner({
        tone: "info",
        message:
          "If this engine has no Owner yet, the link is on its way to the deploy-time owner address; nothing is sent once an Owner exists. No email after a minute? A send needs the owner address pinned at deployment, a sender address on a domain your Cloudflare account is allowed to send from, and Cloudflare Email Service enabled for that domain (dashboard: Compute, then Email Service). A stock deployment ships the sender address as a default on a domain you do not own, so that one is worth checking even when Email Service is on. This screen cannot check any of it, so the send looks the same either way. You do not have to wait: the admin-token sign-in below needs no email and reaches the same passkey set-up.",
      }),
    );
  } catch (err) {
    handles.setStatus(errorBanner(passkeyErrorMessage(err, "register")));
  } finally {
    handles.setBusy(false);
  }
}

// runRecovery drives the RECOVERY-CODE sign-in: POST /admin/auth/recovery { email, code }. This IS the
// sign-in (dispatched before auth on the engine), so on success the engine has set the session cookie and
// returns { role, enrolPasskey }. On enrolPasskey:true the operator is routed STRAIGHT to enrol a fresh
// passkey (a recovery sign-in is a lost-authenticator path); otherwise the normal post-success boot runs.
// The engine answers a GENERIC 401 on ANY failure (wrong email, unknown/spent code, rate limit), so a
// failure surfaces as ONE generic line with NO oracle about the cause (mirroring the engine's no-oracle).
// Exported so the validator drives the real flow with a stubbed engine and asserts the request body, the
// enrol-passkey routing, and the generic-error handling. enrolNext is the screen's "route to a fresh passkey
// enrolment" callback (it navigates to /register / re-shows the set-up flow); on the normal path it is unused.
export async function runRecovery(
  engine: EngineClient,
  email: string,
  code: string,
  handles: FlowHandles,
  enrolNext: () => void,
): Promise<void> {
  handles.setStatus(null);
  handles.setBusy(true, "recovery");
  try {
    const finish = await engine.recoverWithCode(email, code);
    // Verified: the cookie is set. If the engine asks for a fresh passkey, route there immediately; else
    // boot to the role-appropriate view exactly as a passkey sign-in does.
    if (finish.enrolPasskey) {
      handles.setStatus(successBanner("Signed in with a recovery code. Set up a new passkey now so you do not need a code next time."));
      enrolNext();
      return;
    }
    handles.setStatus(successBanner("Signed in with a recovery code. Signing you in..."));
    await handles.onSuccess();
  } catch (err) {
    // The engine's generic 401 (and any transport fault) surfaces as ONE generic line: no oracle about
    // whether the email, the code or a rate limit was the cause. A thrown 401 is the expected failure here.
    if (isUnauthorised(err)) {
      handles.setStatus(errorBanner("Could not sign in with that recovery code. Check your email and the code, then try again."));
      return;
    }
    handles.setStatus(errorBanner(recoveryTransportMessage(err)));
  } finally {
    handles.setBusy(false);
  }
}

// mountRecoveryForm swaps the recovery-form slot to the "use a recovery code" form: an email field and a
// single recovery-code field, a Sign-in button that drives runRecovery, and a Cancel that clears the form.
// It is the offline break-glass entry on the sign-in screen. The email is prefilled from the main email
// field when one was typed (a small convenience; the operator can change it). Both fields are required
// before the round trip (a light client check; the engine is the authority and answers a generic 401 on any
// failure). On success runRecovery boots or routes to a fresh passkey enrolment per enrolPasskey.
export function mountRecoveryForm(
  slot: HTMLElement,
  engine: EngineClient,
  handles: FlowHandles,
  enrolNext: () => void,
  prefillEmail: string,
): void {
  const { emailField, codeField } = recoveryFields(prefillEmail);

  const signInBtn = h("button", { "data-dp": "passkey.button.sign-in", class: "btn btn--primary btn--sm", type: "submit", style: "width:100%" }, "Sign in with a recovery code") as HTMLButtonElement;
  const cancelBtn = h("button", { "data-dp": "passkey.button.cancel", class: "btn btn--ghost btn--sm", type: "button", style: "width:100%;margin-top:var(--space-2)" }, "Cancel") as HTMLButtonElement;
  cancelBtn.addEventListener("click", () => {
    slot.replaceChildren();
    handles.setStatus(null);
  });

  // The submit button joins the busy set (the screen's setBusy only knows its own four
  // buttons): localHandles.setBusy toggles inFlight + the button. inFlight is read by the
  // submit guard, so it is shared by reference through a one-field holder.
  const guard = { inFlight: false };
  const localHandles = recoveryBusyHandles(handles, signInBtn, guard);

  const form = h(
    "form",
    {
      class: "form-stack",
      style: "display:grid;gap:var(--space-3);margin-top:var(--space-4);border-top:1px solid var(--border);padding-top:var(--space-4)",
      "aria-label": "Sign in with a recovery code",
    },
    emailField.el,
    codeField.el,
    h("div", { style: "margin-top:var(--space-2)" }, signInBtn, cancelBtn),
  );
  form.addEventListener("submit", makeRecoverySubmit(engine, emailField, codeField, localHandles, enrolNext, guard));

  slot.replaceChildren(form);
  emailField.focus();
}

// recoveryFields builds the two recovery-form fields (email + single recovery code) with
// their client-side validators. The engine is the authority and answers a generic 401 on any
// failure; these checks only catch the empty/malformed cases before the round trip.
function recoveryFields(prefillEmail: string): { emailField: Field; codeField: Field } {
  const emailField: Field = field({
    id: "pk-recovery-email",
    label: "Email",
    type: "email",
    value: prefillEmail,
    placeholder: "you@example.com",
    autocomplete: "username",
    hint: "The email your engine knows you by.",
    doc: { href: "https://docs.downpipes.io/operations/identity-and-access", anchor: "keep-recovery-codes-and-the-break-glass-key-apart" },
    validate: (v) => (v === "" ? "Enter your email." : isEmailish(v) ? null : "Enter a valid email address."),
  });
  const codeField: Field = field({
    id: "pk-recovery-code",
    label: "Recovery code",
    type: "text",
    placeholder: "one of your saved codes",
    autocomplete: "one-time-code",
    hint: "One of the single-use codes you saved at set-up.",
    doc: { href: "https://docs.downpipes.io/operations/identity-and-access", anchor: "keep-recovery-codes-and-the-break-glass-key-apart" },
    validate: (v) => (v === "" ? "Enter a recovery code." : null),
  });
  return { emailField, codeField };
}

// recoveryBusyHandles wraps the screen's FlowHandles so the recovery submit button joins the
// busy set and the in-flight guard tracks the round trip: a double-Enter would otherwise POST
// the same SINGLE-USE code twice, and the second attempt's 401 can paint an error over the
// in-progress successful boot.
function recoveryBusyHandles(handles: FlowHandles, signInBtn: HTMLButtonElement, guard: { inFlight: boolean }): FlowHandles {
  return {
    ...handles,
    setBusy: (b: boolean, activeLabel?: string): void => {
      guard.inFlight = b;
      signInBtn.disabled = b;
      signInBtn.textContent = b ? "Signing in..." : "Sign in with a recovery code";
      handles.setBusy(b, activeLabel);
    },
  };
}

// makeRecoverySubmit builds the form-submit handler: validate both fields, then drive
// runRecovery (guarded on the in-flight state). On a fresh-passkey route it threads the typed
// email to the /register landing so the enrolment does not re-ask for what was just entered.
function makeRecoverySubmit(
  engine: EngineClient,
  emailField: Field,
  codeField: Field,
  localHandles: FlowHandles,
  enrolNext: () => void,
  guard: { inFlight: boolean },
): (ev: Event) => void {
  return (ev: Event): void => {
    ev.preventDefault();
    if (guard.inFlight) return;
    const okEmail = emailField.validate();
    const okCode = codeField.validate();
    if (!okEmail || !okCode) {
      (!okEmail ? emailField : codeField).focus();
      return;
    }
    void runRecovery(engine, emailField.value(), codeField.value(), localHandles, () => {
      setRegisterPrefillEmail(emailField.value());
      enrolNext();
    });
  };
}
